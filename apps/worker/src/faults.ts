import {
  abortableSleep,
  CommandTimedOutError,
  JobTimedOutError,
  OutOfMemoryError,
  RepoUnavailableError,
  RetryableJobError,
  SandboxUnavailableError,
  type PipelineDeps,
  type Phase,
} from "@rivet/core";
import type { ExecRequest, ExecResult, Sandbox, SandboxProvider, SandboxSpec } from "@rivet/core";

import type { FaultConfig, FaultMode } from "./config";
import type { Logger } from "./logger";

/**
 * Breaking a job on purpose.
 *
 * Fault configuration is read here and nowhere else - `packages/core` takes the
 * `fault` callback as an argument and has no idea an environment variable
 * exists. That is the same rule the pipeline runner follows for its clock and
 * its sleep, and it is what lets the integration suite inject a fault that
 * fires on the first attempt only, which no env var could express.
 *
 * The first four modes exercise the lifecycle machinery. The sandbox-aware
 * modes below them either wrap the provider for this attempt or fall
 * back to an equivalent named error when the selected phase has no sandbox
 * command. A provider wrapper is created per attempt, so concurrent jobs never
 * share the phase that a command fault belongs to.
 */

/** How long a hung phase sleeps for. Effectively forever, capped so it cannot leak. */
const HANG_MS = 10 * 60 * 1_000;

/** Commands used by sandbox-backed fault modes. They are argv arrays, never shell strings. */
const SLEEP_COMMAND = ["sleep", "infinity"];
const OOM_COMMAND = [
  "node",
  "-e",
  "const allocations = []; while (true) allocations.push(Buffer.alloc(1024 * 1024));",
];

type SandboxFaultMode = Extract<FaultMode, "no-daemon" | "hang" | "oom" | "slow-command">;

/** The pipeline dependencies fault injection can replace. */
export interface FaultInjection {
  fault?: PipelineDeps["fault"];
  sleep: PipelineDeps["sleep"];
  /** A per-attempt provider wrapper for sandbox-specific modes. */
  sandbox?: SandboxProvider;
}

/**
 * Builds the `fault` and `sleep` a run should use, from an optional config.
 *
 * One injection per run rather than one per worker, because `hang` is
 * stateful: the runner calls `fault(phase)` immediately before the phase work,
 * so remembering whether the current phase matched is how a phase-scoped hang
 * is expressed through an interface that never passes the phase to `sleep`.
 */
export function createFaultInjection(
  config: FaultConfig | undefined,
  log: Logger,
  sandbox?: SandboxProvider,
): FaultInjection {
  if (!config) return { sleep: abortableSleep };

  // Matched on status rather than label: `RIVET_FAULT_PHASE=testing` reads
  // better than whichever label the phase happens to carry, and the status is
  // the stable half of a `Phase` - Milestone 2 rewrites labels and keeps the
  // statuses.
  const matches = (phase: Phase): boolean => phase.status === config.phase;
  const sandboxFault = createSandboxFault(config.mode, sandbox);

  let hangHere = false;

  const fault: PipelineDeps["fault"] = (phase: Phase) => {
    const matched = matches(phase);
    hangHere = config.mode === "hang" && matched && !phase.run;

    if (sandboxFault) sandboxFault.setPhase(phase);
    if (!matched) return undefined;

    switch (config.mode) {
      case "throw":
        log.warn({ phase: phase.status }, "injecting a retryable fault");
        return new RetryableJobError(`Injected retryable fault at ${phase.status}.`);

      case "fatal":
        log.warn({ phase: phase.status }, "injecting a terminal fault");
        // `simulated_failure` is gone. Use a category a real provisioning run
        // can produce so the manual fault has the same shape as a real error.
        return new RepoUnavailableError(`Injected terminal fault at ${phase.status}.`);

      case "hang":
        if (phase.run && sandboxFault) {
          // The provider replaces the first command with a long-lived sleep.
          // The job deadline, rather than the command budget, is expected to
          // win, which keeps this distinct from `slow-command`.
          log.warn({ phase: phase.status }, "injecting a command that ignores the job deadline");
          return undefined;
        }
        if (phase.run) {
          // This only happens for a direct unit-test invocation without a
          // sandbox provider. The real worker always supplies one for a real
          // pipeline, but keeping the fallback named makes the mode useful in
          // the simulated worker too.
          return new JobTimedOutError(`Injected hang at ${phase.status}.`);
        }
        // The phase starts normally and then never ends, which is what makes
        // this a test of the timeout rather than of the abort signal. Only this
        // phase hangs; every other one keeps honouring the signal.
        log.warn({ phase: phase.status }, "injecting a hang; the abort signal will be ignored");
        return undefined;

      case "exit":
        // No flush, no shutdown handler, no lease release - which is the entire
        // point. What is left behind is a row in a leased status whose lease
        // will quietly expire, and the only thing in the system that can notice
        // is the sweeper.
        log.error({ phase: phase.status }, "injecting a hard exit; this process dies now");
        return process.exit(1);

      case "no-daemon":
        if (phase.status === "provisioning" && phase.run && sandboxFault && sandbox) {
          // `create()` raises SandboxUnavailableError before a container exists.
          return undefined;
        }
        return new SandboxUnavailableError(`Injected Docker daemon outage at ${phase.status}.`);

      case "oom":
        if (phase.run && sandboxFault) {
          log.warn({ phase: phase.status }, "injecting a command that exhausts sandbox memory");
          return undefined;
        }
        return new OutOfMemoryError(`Injected out-of-memory fault at ${phase.status}.`);

      case "slow-command":
        if (phase.run && sandboxFault) {
          log.warn({ phase: phase.status }, "injecting a command that exceeds its own timeout");
          return undefined;
        }
        return new CommandTimedOutError(`Injected slow command at ${phase.status}.`);
    }
  };

  return {
    fault,
    sleep: (ms, signal) => (hangHere ? hang() : abortableSleep(ms, signal)),
    ...(sandboxFault ? { sandbox: sandboxFault } : {}),
  };
}

/**
 * Builds the provider used by a sandbox-specific mode.
 *
 * `no-daemon` deliberately fails before it calls the real provider. The other
 * modes create a normal sandbox and replace one command in the selected phase
 * with a deterministic command that exercises the corresponding adapter path.
 */
function createSandboxFault(
  mode: FaultMode,
  inner: SandboxProvider | undefined,
): FaultSandboxProvider | undefined {
  if (mode !== "no-daemon" && mode !== "hang" && mode !== "oom" && mode !== "slow-command") {
    return undefined;
  }
  if (mode === "no-daemon" || inner) {
    return new FaultSandboxProvider(mode, inner);
  }
  return undefined;
}

class FaultSandboxProvider implements SandboxProvider {
  private activePhase: string | undefined;

  constructor(
    private readonly mode: SandboxFaultMode,
    private readonly inner: SandboxProvider | undefined,
  ) {}

  setPhase(phase: Phase): void {
    this.activePhase = phase.status;
  }

  get currentPhase(): string | undefined {
    return this.activePhase;
  }

  get faultMode(): SandboxFaultMode {
    return this.mode;
  }

  async create(spec: SandboxSpec, signal: AbortSignal): Promise<Sandbox> {
    if (this.mode === "no-daemon") {
      throw new SandboxUnavailableError("Injected Docker daemon outage.");
    }
    if (!this.inner) {
      throw new SandboxUnavailableError("No sandbox provider is available for this fault.");
    }

    const sandbox = await this.inner.create(spec, signal);
    return new FaultSandbox(sandbox, this);
  }

  async reap(jobIsLive: (jobId: string) => Promise<boolean>): Promise<string[]> {
    return this.inner?.reap(jobIsLive) ?? [];
  }

  commandFor(phase: string | undefined): string[] | undefined {
    if (phase !== this.activePhase) return undefined;
    switch (this.mode) {
      case "hang":
      case "slow-command":
        return [...SLEEP_COMMAND];
      case "oom":
        return [...OOM_COMMAND];
      case "no-daemon":
        return undefined;
    }
  }
}

class FaultSandbox implements Sandbox {
  private injected = false;

  constructor(
    private readonly inner: Sandbox,
    private readonly provider: FaultSandboxProvider,
  ) {}

  get id(): string {
    return this.inner.id;
  }

  async exec(request: ExecRequest): Promise<ExecResult> {
    const command = this.injected
      ? undefined
      : this.provider.commandFor(this.provider.currentPhase);
    if (!command) return this.inner.exec(request);
    this.injected = true;

    const result = await this.inner.exec({ ...request, argv: command });
    if (this.provider.faultMode === "oom") {
      return killed(result, command, { oomKilled: true, timedOut: false });
    }
    if (this.provider.faultMode === "slow-command") {
      return killed(result, command, { oomKilled: false, timedOut: true });
    }
    if (this.provider.faultMode === "hang") {
      // If a fake provider returns immediately, keep the fault honest by
      // waiting for the job's abort signal. A real adapter reaches this branch
      // only after the injected command has already been stopped.
      return waitForAbort(request.signal, result, command);
    }
    return result;
  }

  // Faults are injected into commands, which is where every M2 failure mode
  // lives. File reads and writes pass straight through: a fault mode that
  // corrupted them would be testing the tool layer rather than the worker's
  // failure handling, and the tool layer has its own suite.
  getFile(...args: Parameters<Sandbox["getFile"]>): ReturnType<Sandbox["getFile"]> {
    return this.inner.getFile(...args);
  }

  putFile(...args: Parameters<Sandbox["putFile"]>): ReturnType<Sandbox["putFile"]> {
    return this.inner.putFile(...args);
  }

  destroy(): Promise<void> {
    return this.inner.destroy();
  }
}

function killed(
  result: ExecResult,
  argv: string[],
  flags: { oomKilled: boolean; timedOut: boolean },
): ExecResult {
  return {
    ...result,
    argv,
    exitCode: null,
    oomKilled: flags.oomKilled,
    timedOut: flags.timedOut,
  };
}

function waitForAbort(
  signal: AbortSignal,
  result: ExecResult,
  argv: string[],
): Promise<ExecResult> {
  if (signal.aborted)
    return Promise.resolve(killed(result, argv, { oomKilled: false, timedOut: false }));

  return new Promise((resolve) => {
    const onAbort = () => {
      signal.removeEventListener("abort", onAbort);
      resolve(killed(result, argv, { oomKilled: false, timedOut: false }));
    };
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

/** A sleep with no way out. `unref` so it can never be the last thing holding the process up. */
function hang(): Promise<void> {
  return new Promise<void>((resolve) => {
    setTimeout(resolve, HANG_MS).unref();
  });
}
