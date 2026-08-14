import {
  type ExecRequest,
  type ExecResult,
  type FileRead,
  type FileReadOptions,
  type Sandbox,
  SandboxFileError,
  type SandboxProvider,
  type SandboxSpec,
} from "@rivet/core";

import { namesAFile } from "./paths";
import { CappedOutput } from "./stream";

/**
 * A `SandboxProvider` that is a list of canned answers.
 *
 * The equivalent of `InMemoryJobQueue`, and it exists for the same reason: this
 * is what keeps `pnpm test` runnable with no Docker daemon. That is not a
 * convenience. It is the property CI's `verify` job exists to protect, and the
 * moment the unit suite needs a container, the check that `next build` can run
 * on a machine with no daemon goes with it.
 *
 * Where the fake and the real adapter disagree, this one is the liar. The
 * `*.sbx.test.ts` suite is what proves the dockerode adapter, and nothing
 * asserted here is evidence about Docker.
 */

/** How a scripted response decides whether it is the answer for a command. */
export type ArgvMatcher = string | RegExp | ((argv: string[]) => boolean);

export interface ScriptedCommand {
  /** A string matches the first argument; a regexp matches the joined argv. */
  match: ArgvMatcher;
  exitCode?: number | null;
  stdout?: string;
  stderr?: string;
  durationMs?: number;
  oomKilled?: boolean;
  /**
   * Never returns on its own.
   *
   * Waits for the request's timeout or its abort signal, whichever comes first,
   * and then reports the kill the way the real adapter does. This is how the
   * cancellation and command-timeout paths are tested without a container that
   * genuinely hangs.
   */
  hang?: boolean;
  /** Thrown instead of returning, for the sandbox-is-broken paths. */
  throws?: Error;
}

export interface FakeSandboxOptions {
  /** Every `create()` fails with this. Used for the `no-daemon` fault mode. */
  createFails?: Error;
  script?: ScriptedCommand[];
  /** Files every sandbox starts with, keyed by absolute path. */
  files?: Record<string, string>;
}

export class FakeSandboxProvider implements SandboxProvider {
  /** Every spec passed to `create`, in order. */
  readonly created: SandboxSpec[] = [];

  /** Every sandbox handed out, including the destroyed ones. */
  readonly sandboxes: FakeSandbox[] = [];

  private readonly script: ScriptedCommand[];
  private nextId = 1;

  constructor(private readonly options: FakeSandboxOptions = {}) {
    this.script = options.script ?? [];
  }

  /** Every command run in every sandbox, flattened, in order. */
  get calls(): ExecRequest[] {
    return this.sandboxes.flatMap((sandbox) => sandbox.calls);
  }

  create(spec: SandboxSpec, signal: AbortSignal): Promise<Sandbox> {
    // Rejecting rather than throwing synchronously: a caller writing
    // `provider.create(...).catch(...)` should not have to also wrap the call
    // in a try, and the real adapter is async so it never throws either.
    if (signal.aborted) return Promise.reject(signal.reason as Error);
    if (this.options.createFails) return Promise.reject(this.options.createFails);

    this.created.push(spec);
    const sandbox = new FakeSandbox(`fake-sandbox-${this.nextId++}`, spec, this.script, {
      ...this.options.files,
    });
    this.sandboxes.push(sandbox);
    return Promise.resolve(sandbox);
  }

  /** Mirrors the real reaper's rule: ask about the job, remove what is not live. */
  async reap(jobIsLive: (jobId: string) => Promise<boolean>): Promise<string[]> {
    const removed: string[] = [];
    for (const sandbox of this.sandboxes) {
      if (sandbox.destroyed) continue;
      if (await jobIsLive(sandbox.jobId)) continue;
      await sandbox.destroy();
      removed.push(sandbox.id);
    }
    return removed;
  }

  /** Adds a response after construction, for tests that script mid-run. */
  respondTo(command: ScriptedCommand): void {
    this.script.push(command);
  }
}

export class FakeSandbox implements Sandbox {
  readonly calls: ExecRequest[] = [];
  destroyed = false;

  /** How many times `destroy()` was called, to prove it is idempotent. */
  destroyCount = 0;

  constructor(
    readonly id: string,
    private readonly spec: SandboxSpec,
    private readonly script: ScriptedCommand[],
    /**
     * The whole filesystem, as far as this fake is concerned: absolute paths to
     * contents, with no directories in it at all.
     *
     * Directories are implied by the paths that use them, which is a lie the
     * real adapter does not tell - a container has a real filesystem, and
     * `putFile` there has to make the parents. What that buys is a tool layer
     * that can be unit-tested with no Docker, which is the same trade every
     * other part of this class makes. The `*.sbx.test.ts` suite is the evidence
     * about Docker; nothing asserted against this map is.
     */
    private readonly files: Record<string, string> = {},
  ) {}

  get jobId(): string {
    return this.spec.jobId;
  }

  /** What the sandbox holds now, for asserting on what a phase wrote. */
  get filesystem(): Readonly<Record<string, string>> {
    return this.files;
  }

  async exec(request: ExecRequest): Promise<ExecResult> {
    this.calls.push(request);
    request.signal.throwIfAborted();

    const scripted = this.script.find((entry) => matches(entry.match, request.argv));
    if (scripted?.throws) throw scripted.throws;

    if (scripted?.hang) return this.hang(request, scripted);

    const cap = request.maxOutputBytes ?? Number.MAX_SAFE_INTEGER;
    return {
      argv: request.argv,
      cwd: request.cwd,
      exitCode: scripted?.exitCode ?? 0,
      ...capped(scripted?.stdout ?? "", scripted?.stderr ?? "", cap),
      timedOut: false,
      oomKilled: scripted?.oomKilled ?? false,
      durationMs: scripted?.durationMs ?? 1,
    };
  }

  getFile(path: string, options: FileReadOptions, signal: AbortSignal): Promise<FileRead> {
    if (signal.aborted) return Promise.reject(signal.reason as Error);

    const content = this.files[path];
    if (content === undefined) {
      // A path that is a prefix of a stored one is the closest this map gets to
      // having a directory, and reporting it as one keeps the tool layer's two
      // error branches both reachable without Docker.
      const isDirectory = Object.keys(this.files).some((key) =>
        key.startsWith(path.endsWith("/") ? path : `${path}/`),
      );
      return Promise.reject(
        isDirectory
          ? new SandboxFileError(`${path} is a directory, not a file.`, "not_a_file")
          : new SandboxFileError(`${path} does not exist in the sandbox.`, "not_found"),
      );
    }

    // Cut on bytes rather than characters, because that is what the real
    // adapter's cap counts and a test that disagrees about a multi-byte file
    // would be testing the fake.
    const bytes = Buffer.from(content, "utf8");
    const truncated = bytes.byteLength > options.maxBytes;
    return Promise.resolve({
      content: truncated ? bytes.subarray(0, options.maxBytes).toString("utf8") : content,
      truncated,
    });
  }

  putFile(path: string, content: string, signal: AbortSignal): Promise<void> {
    if (signal.aborted) return Promise.reject(signal.reason as Error);

    if (!namesAFile(path)) {
      return Promise.reject(new SandboxFileError(`${path} does not name a file.`, "not_a_file"));
    }
    this.files[path] = content;
    return Promise.resolve();
  }

  destroy(): Promise<void> {
    this.destroyCount += 1;
    this.destroyed = true;
    return Promise.resolve();
  }

  /** Waits to be stopped, then reports the stop the way a real kill would. */
  private hang(request: ExecRequest, scripted: ScriptedCommand): Promise<ExecResult> {
    const startedAt = Date.now();
    return new Promise((resolve) => {
      const finish = (timedOut: boolean) => {
        clearTimeout(timer);
        request.signal.removeEventListener("abort", onAbort);
        resolve({
          argv: request.argv,
          cwd: request.cwd,
          // Null, not 137: the command never got to exit.
          exitCode: null,
          stdout: scripted.stdout ?? "",
          stderr: scripted.stderr ?? "",
          truncated: false,
          timedOut: timedOut && !scripted.oomKilled,
          oomKilled: scripted.oomKilled ?? false,
          durationMs: Date.now() - startedAt,
        });
      };
      const onAbort = () => {
        finish(false);
      };
      const timer = setTimeout(() => {
        finish(true);
      }, request.timeoutMs);
      request.signal.addEventListener("abort", onAbort, { once: true });
    });
  }
}

function matches(matcher: ArgvMatcher, argv: string[]): boolean {
  if (typeof matcher === "function") return matcher(argv);
  if (matcher instanceof RegExp) return matcher.test(argv.join(" "));
  return argv[0] === matcher;
}

/** Runs scripted output through the same cap the real adapter applies. */
function capped(
  stdout: string,
  stderr: string,
  maxBytes: number,
): Pick<ExecResult, "stdout" | "stderr" | "truncated"> {
  const out = new CappedOutput(maxBytes);
  out.push(Buffer.from(stdout, "utf8"));
  const err = new CappedOutput(maxBytes);
  err.push(Buffer.from(stderr, "utf8"));

  const outText = out.text();
  const errText = err.text();
  return {
    stdout: outText.text,
    stderr: errText.text,
    truncated: outText.truncated || errText.truncated,
  };
}
