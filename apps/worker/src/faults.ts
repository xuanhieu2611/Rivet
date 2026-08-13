import {
  abortableSleep,
  type Phase,
  type PipelineDeps,
  RetryableJobError,
  TerminalJobError,
} from "@rivet/core";

import type { FaultConfig } from "./config";
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
 * Two of the four modes are simply an error the callback returns. The other two
 * are not expressible that way and are handled here instead:
 *
 * - `hang` needs a `sleep` that ignores the abort signal, so it replaces the
 *   runner's sleep rather than returning anything.
 * - `exit` needs the process to be gone before it could return anything at all.
 */

/** How long a hung phase sleeps for. Effectively forever, capped so it cannot leak. */
const HANG_MS = 10 * 60 * 1_000;

/** The two pipeline dependencies fault injection can replace. */
export interface FaultInjection {
  fault?: PipelineDeps["fault"];
  sleep: PipelineDeps["sleep"];
}

/**
 * Builds the `fault` and `sleep` a run should use, from an optional config.
 *
 * One injection per run rather than one per worker, because `hang` is
 * stateful: the runner calls `fault(phase)` immediately before `sleep(...)`, so
 * remembering whether the last phase matched is how a phase-scoped hang is
 * expressed through an interface that never passes the phase to `sleep`.
 */
export function createFaultInjection(config: FaultConfig | undefined, log: Logger): FaultInjection {
  if (!config) return { sleep: abortableSleep };

  // Matched on status rather than label: `RIVET_FAULT_PHASE=testing` reads
  // better than whichever label the phase happens to carry, and the status is
  // the stable half of a `Phase` - Milestone 2 rewrites the labels and keeps
  // the statuses.
  const matches = (phase: Phase): boolean => phase.status === config.phase;

  let hangHere = false;

  const fault: PipelineDeps["fault"] = (phase: Phase) => {
    hangHere = config.mode === "hang" && matches(phase);
    if (!matches(phase)) return undefined;

    switch (config.mode) {
      case "throw":
        log.warn({ phase: phase.status }, "injecting a retryable fault");
        return new RetryableJobError(`Injected retryable fault at ${phase.status}.`);

      case "fatal":
        log.warn({ phase: phase.status }, "injecting a terminal fault");
        return new TerminalJobError(
          `Injected terminal fault at ${phase.status}.`,
          "simulated_failure",
        );

      case "hang":
        // The phase starts normally and then never ends, which is what makes
        // this a test of the timeout rather than of the abort signal. Only this
        // phase hangs; every other one keeps honouring the signal, so the
        // timeline still shows the run reaching the phase that wedged it.
        log.warn({ phase: phase.status }, "injecting a hang; the abort signal will be ignored");
        return undefined;

      case "exit":
        // No flush, no shutdown handler, no lease release - which is the entire
        // point. What is left behind is a row in a leased status whose lease
        // will quietly expire, and the only thing in the system that can notice
        // is the sweeper.
        log.error({ phase: phase.status }, "injecting a hard exit; this process dies now");
        process.exit(1);
    }
  };

  return {
    fault,
    sleep: (ms, signal) => (hangHere ? hang() : abortableSleep(ms, signal)),
  };
}

/** A sleep with no way out. `unref` so it can never be the last thing holding the process up. */
function hang(): Promise<void> {
  return new Promise<void>((resolve) => {
    setTimeout(resolve, HANG_MS).unref();
  });
}
