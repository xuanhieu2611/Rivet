import { posix } from "node:path";
import { Readable } from "node:stream";

import {
  type ExecRequest,
  type ExecResult,
  type FileRead,
  type FileReadOptions,
  type Sandbox,
  type SandboxProvider,
  type SandboxResourceReport,
  SandboxCreateFailedError,
  SandboxFileError,
  type SandboxSpec,
  type Telemetry,
  SandboxUnavailableError,
} from "@rivet/core";
import type Docker from "dockerode";
import type { Container } from "dockerode";

import { getDocker } from "./connection";
import { namesAFile } from "./paths";
import { CappedOutput, DockerStreamDemuxer } from "./stream";
import { packFile, TarFileReader } from "./tar";
import { SandboxResourceMonitor } from "./resource-monitor";

/**
 * The Docker implementation of the sandbox port.
 *
 * The shape of the thing: one container per job attempt, started as
 * `sleep infinity` and exec'd into repeatedly. It is a long-lived environment
 * rather than a command runner because the phases have to share a filesystem -
 * `provisioning` clones and installs, `testing` runs the suite in the tree that
 * left behind. A container per command would make each phase's work invisible
 * to the next one.
 *
 * Two decisions here are worth reading before changing anything:
 *
 * - **A stuck command is stopped by killing the container, not the exec.** The
 *   Docker API offers no handle to kill a running exec. The sandbox is
 *   disposable and single-purpose, so killing the whole container is both the
 *   only reliable stop and the correct one.
 * - **The reaper's labels are stamped by this class, not by its caller.** A
 *   container whose worker died has nothing else identifying it, so the one
 *   thing that must never be forgotten is not left to a caller to remember.
 */

export const LABEL_JOB_ID = "rivet.job-id";
export const LABEL_WORKER_ID = "rivet.worker-id";
export const LABEL_CREATED_AT = "rivet.created-at";

/**
 * A user-defined bridge rather than the default one, created on demand.
 *
 * Containers on the default bridge can reach each other by IP, which is one
 * more thing two unrelated jobs can do to each other. This is a small
 * improvement and not isolation - see the README's "how this sandbox differs
 * from a production one", which is explicit that a bridge network can still
 * reach the host.
 */
export const SANDBOX_NETWORK = "rivet-sandbox";

/** How long a container gets to be young enough that the reaper leaves it alone. */
const DEFAULT_REAP_GRACE_MS = 120_000;

/** Everything a `SandboxProvider` needs that is not part of one job's spec. */
export interface DockerSandboxOptions {
  /** Stamped into `rivet.worker-id`, so a leaked container names the process that made it. */
  workerId: string;
  docker?: Docker;
  log?: SandboxLogger;
  /** Containers younger than this are never reaped. Defaults to two minutes. */
  reapGraceMs?: number;
  /** Where resource samples and peaks are emitted, when telemetry is enabled. */
  telemetry?: Telemetry;
  /** Injectable adapter setting; production samples once per second. */
  resourceSampleIntervalMs?: number;
}

/** The slice of a pino logger this package uses. Structured first, message second. */
export interface SandboxLogger {
  info(details: Record<string, unknown>, message: string): void;
  warn(details: Record<string, unknown>, message: string): void;
}

/** The default when no logger is supplied, which is the case in every unit test. */
const SILENT_LOG: SandboxLogger = {
  info: () => {
    // Deliberately silent.
  },
  warn: () => {
    // Deliberately silent.
  },
};

export class DockerSandboxProvider implements SandboxProvider {
  private readonly docker: Docker;
  private readonly log: SandboxLogger;
  private readonly reapGraceMs: number;

  /** One pull per image per process, and one network check per provider. */
  private readonly images = new Map<string, Promise<void>>();
  private network: Promise<void> | undefined;

  constructor(private readonly options: DockerSandboxOptions) {
    this.docker = options.docker ?? getDocker();
    this.log = options.log ?? SILENT_LOG;
    this.reapGraceMs = options.reapGraceMs ?? DEFAULT_REAP_GRACE_MS;
  }

  async create(spec: SandboxSpec, signal: AbortSignal): Promise<Sandbox> {
    await this.ping();
    await this.ensureImage(spec.image);
    await this.ensureNetwork();
    signal.throwIfAborted();

    let container: Container;
    try {
      container = await this.docker.createContainer({
        Image: spec.image,
        // The container is a place to exec into, not a command runner. Without
        // a foreground process it would exit immediately and take the
        // filesystem the next phase needs with it.
        Cmd: ["sleep", "infinity"],
        // Deliberately no `WorkingDir`. Docker creates a missing working
        // directory as root:root and does not chown it to `User`, so asking it
        // for `/workspace` produces a directory uid 1000 cannot write - which
        // shows up much later as a `git clone` failing for no visible reason.
        // `ensureWorkdir` makes it as the container's own user instead.
        //
        // `node` is uid 1000, which the node images ship. PRD §15: nothing in here runs
        // as root, including the code Rivet clones and the code it writes.
        User: "node",
        Env: Object.entries(spec.env).map(([key, value]) => `${key}=${value}`),
        Labels: {
          ...spec.labels,
          // Stamped last so a caller cannot accidentally shadow the reaper's
          // only handle on this container.
          [LABEL_JOB_ID]: spec.jobId,
          [LABEL_WORKER_ID]: this.options.workerId,
          [LABEL_CREATED_AT]: new Date().toISOString(),
        },
        HostConfig: {
          Memory: spec.memoryBytes,
          // Equal to `Memory`, which is how you disable swap. Leave them
          // different and the limit stops being a limit: the container swaps
          // instead of dying, and `oom_killed` never fires.
          MemorySwap: spec.memoryBytes,
          NanoCpus: spec.nanoCpus,
          PidsLimit: spec.pidsLimit,
          CapDrop: ["ALL"],
          SecurityOpt: ["no-new-privileges"],
          NetworkMode: SANDBOX_NETWORK,
          // Removal is Rivet's job. `AutoRemove` would delete the container the
          // instant it stopped, including the moment after an OOM kill, and
          // `State.OOMKilled` is only readable while the container still
          // exists - which is the one fact that distinguishes a memory kill
          // from every other exit code 137.
          AutoRemove: false,
        },
      });
    } catch (cause) {
      throw asSandboxError(cause, `Could not create a container from ${spec.image}.`);
    }

    // From here on the container exists, so every failure path must destroy it.
    const sandbox = new DockerSandbox(container, spec, this.options, this.log);
    try {
      await container.start();
      sandbox.startResourceMonitoring();
      signal.throwIfAborted();
      await ensureWorkdir(sandbox, spec.workdir, signal);
    } catch (cause) {
      await sandbox.destroy();
      throw cause instanceof SandboxCreateFailedError
        ? cause
        : asSandboxError(cause, "Could not start the sandbox container.");
    }
    return sandbox;
  }

  async reap(jobIsLive: (jobId: string) => Promise<boolean>): Promise<string[]> {
    const containers = await this.docker.listContainers({
      all: true,
      filters: { label: [LABEL_JOB_ID] },
    });

    const removed: string[] = [];
    for (const summary of containers) {
      const jobId = summary.Labels[LABEL_JOB_ID];
      if (!jobId) continue;

      // A container that is still being created belongs to a worker that has
      // not had the chance to record it anywhere yet. Removing it would be the
      // reaper causing exactly the failure it exists to clean up after.
      const createdAt = Date.parse(summary.Labels[LABEL_CREATED_AT] ?? "");
      const age = Number.isNaN(createdAt) ? Number.POSITIVE_INFINITY : Date.now() - createdAt;
      if (age < this.reapGraceMs) continue;

      // Postgres is the authority on whether a job is running. This class knows
      // only what Docker will tell it, which is not enough to make the call.
      if (await jobIsLive(jobId)) continue;

      try {
        await this.docker.getContainer(summary.Id).remove({ force: true, v: true });
        removed.push(summary.Id);
        this.log.warn(
          { jobId, containerId: summary.Id, category: "sandbox_leaked" },
          "reaped a sandbox whose job is no longer running",
        );
      } catch (cause) {
        if (isNotFound(cause)) continue;
        this.log.warn({ jobId, containerId: summary.Id, err: cause }, "could not reap a sandbox");
      }
    }
    return removed;
  }

  /** A cheap "is the daemon there" so an outage is a clear error, not a create failure. */
  private async ping(): Promise<void> {
    try {
      await this.docker.ping();
    } catch (cause) {
      throw new SandboxUnavailableError("The Docker daemon is not reachable.", { cause });
    }
  }

  /**
   * Pulls the image if it is not already local. Once per image per process.
   *
   * Memoized on the promise rather than on a boolean so that concurrent jobs
   * starting at the same moment share one pull instead of racing several.
   */
  private ensureImage(image: string): Promise<void> {
    const existing = this.images.get(image);
    if (existing) return existing;

    const pulling = this.pullImage(image).catch((cause: unknown) => {
      // A failed pull must not be remembered as done, or every later job in
      // this process inherits the failure without retrying.
      this.images.delete(image);
      throw cause;
    });
    this.images.set(image, pulling);
    return pulling;
  }

  private async pullImage(image: string): Promise<void> {
    try {
      await this.docker.getImage(image).inspect();
      return;
    } catch (cause) {
      if (!isNotFound(cause)) throw asSandboxError(cause, `Could not inspect the image ${image}.`);
    }

    this.log.info({ image }, "pulling the sandbox image");
    try {
      const stream = await this.docker.pull(image);
      await new Promise<void>((resolve, reject) => {
        this.docker.modem.followProgress(stream, (error: Error | null) =>
          error ? reject(error) : resolve(),
        );
      });
    } catch (cause) {
      throw asSandboxError(cause, `Could not pull the image ${image}.`);
    }
  }

  /** Creates the shared bridge network unless it is already there. */
  private ensureNetwork(): Promise<void> {
    this.network ??= this.createNetwork().catch((cause: unknown) => {
      this.network = undefined;
      throw cause;
    });
    return this.network;
  }

  private async createNetwork(): Promise<void> {
    try {
      await this.docker.getNetwork(SANDBOX_NETWORK).inspect();
      return;
    } catch (cause) {
      if (!isNotFound(cause)) throw asSandboxError(cause, "Could not inspect the sandbox network.");
    }

    try {
      await this.docker.createNetwork({ Name: SANDBOX_NETWORK, Driver: "bridge" });
    } catch (cause) {
      // 409 means another worker created it between the inspect and the create,
      // which is the expected outcome of two workers starting together, not a
      // failure.
      if (statusCodeOf(cause) === 409) return;
      throw asSandboxError(cause, "Could not create the sandbox network.");
    }
  }
}

class DockerSandbox implements Sandbox {
  private destroyed = false;
  private readonly resources: SandboxResourceMonitor;

  constructor(
    private readonly container: Container,
    private readonly spec: SandboxSpec,
    options: DockerSandboxOptions,
    private readonly log: SandboxLogger,
  ) {
    this.resources = new SandboxResourceMonitor({
      container,
      spec,
      workerId: options.workerId,
      ...(options.telemetry ? { telemetry: options.telemetry } : {}),
      ...(options.resourceSampleIntervalMs === undefined
        ? {}
        : { sampleIntervalMs: options.resourceSampleIntervalMs }),
      onSampleError: (error) => {
        this.log.warn({ err: error, containerId: container.id }, "sandbox resource sample failed");
      },
    });
  }

  get id(): string {
    return this.container.id;
  }

  async exec(request: ExecRequest): Promise<ExecResult> {
    const startedAt = Date.now();
    const stdout = new CappedOutput(request.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES);
    const stderr = new CappedOutput(request.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES);
    const demuxer = new DockerStreamDemuxer(stdout, stderr);

    let timedOut = false;
    let killed = false;

    // Killing the container is the only stop available: the Docker API has no
    // way to signal a running exec. It is also the right one - the sandbox is
    // for one attempt at one job, and there is nothing left in it worth saving
    // once a command has to be stopped.
    const kill = (reason: "timeout" | "abort") => {
      if (killed) return;
      killed = true;
      timedOut = reason === "timeout";
      this.container.kill({ signal: "SIGKILL" }).catch((cause: unknown) => {
        if (isNotFound(cause) || isNotRunning(cause)) return;
        this.log.warn({ err: cause, containerId: this.id }, "could not kill a stuck sandbox");
      });
    };

    const timer = setTimeout(() => {
      kill("timeout");
    }, request.timeoutMs);
    const onAbort = () => {
      kill("abort");
    };
    request.signal.addEventListener("abort", onAbort, { once: true });

    try {
      const exec = await this.container.exec({
        Cmd: request.argv,
        WorkingDir: request.cwd,
        // Without a TTY, and that is not a preference. A TTY merges stdout and
        // stderr into one pty stream, and nothing downstream can separate them
        // again. See `stream.ts`.
        Tty: false,
        AttachStdout: true,
        AttachStderr: true,
        AttachStdin: false,
        Env: Object.entries({ ...this.spec.env, ...request.env }).map(
          ([key, value]) => `${key}=${value}`,
        ),
      });

      const stream = await exec.start({ hijack: true, stdin: false });
      await new Promise<void>((resolve, reject) => {
        stream.on("data", (chunk: Buffer) => {
          demuxer.push(chunk);
        });
        stream.on("end", resolve);
        stream.on("close", resolve);
        // A killed container tears the socket down mid-frame. That is the
        // expected end of a command Rivet itself stopped, not an error to
        // report on top of the one already being handled.
        stream.on("error", (error: Error) => (killed ? resolve() : reject(error)));
      });

      const exitCode = killed ? null : await exitCodeOf(exec);
      // 137 is SIGKILL, which is what an OOM kill looks like from the outside
      // and also what every other kill looks like. The container's own state is
      // the only thing that can tell them apart, so it is consulted exactly
      // when the exit code leaves the question open.
      // Polling only where it pays: a process that exited 137 on its own may
      // have OOM'd a moment ago and the daemon has not caught up. A container
      // this class SIGKILLed produces no new OOM event, so one read of the
      // sticky flag answers that case and a timeout stays fast.
      const oomKilled =
        exitCode === null
          ? await this.wasOomKilled({ poll: false })
          : exitCode === 137 && (await this.wasOomKilled({ poll: true }));

      const out = stdout.text();
      const err = stderr.text();
      return {
        argv: request.argv,
        cwd: request.cwd,
        exitCode,
        stdout: out.text,
        stderr: err.text,
        truncated: out.truncated || err.truncated,
        // An OOM kill noticed by the timeout is still an OOM kill, and that is
        // the more useful of the two answers, so it wins the label.
        timedOut: timedOut && !oomKilled,
        oomKilled,
        durationMs: Date.now() - startedAt,
      };
    } catch (cause) {
      throw asSandboxError(cause, `Could not run \`${request.argv.join(" ")}\` in the sandbox.`);
    } finally {
      clearTimeout(timer);
      request.signal.removeEventListener("abort", onAbort);
    }
  }

  /**
   * Reads a file out of the container as a tar stream.
   *
   * `getArchive` is the only endpoint that can do this: the exec path carries
   * everything through Docker's framed stream and would report a file read as a
   * command the job never ran. The stream is destroyed as soon as the reader
   * has what it was asked for, so reading 4KB of a 900MB file transfers 4KB and
   * a little padding rather than 900MB.
   */
  async getFile(path: string, options: FileReadOptions, signal: AbortSignal): Promise<FileRead> {
    signal.throwIfAborted();

    // dockerode types this as the bare `NodeJS.ReadableStream`, which has no
    // `destroy`. The object is a real `Readable`, and destroying it early is
    // the whole reason a bounded read is bounded.
    let archive: NodeJS.ReadableStream & { destroy?: () => void };
    try {
      archive = await this.container.getArchive({ path });
    } catch (cause) {
      if (isNotFound(cause)) {
        // 404 covers both "no such file" and "no such container". The second
        // one cannot happen here - this object holds a container it created -
        // so the useful reading is the first.
        throw new SandboxFileError(`${path} does not exist in the sandbox.`, "not_found", {
          cause,
        });
      }
      throw asSandboxError(cause, `Could not read ${path} from the sandbox.`);
    }

    const reader = new TarFileReader(options.maxBytes);
    try {
      await new Promise<void>((resolve, reject) => {
        const stop = () => {
          archive.removeListener("data", onData);
          signal.removeEventListener("abort", onAbort);
          archive.destroy?.();
        };
        const onData = (chunk: Buffer) => {
          try {
            reader.push(chunk);
          } catch (cause) {
            stop();
            reject(cause instanceof Error ? cause : new Error(String(cause)));
            return;
          }
          // Everything after the wanted file is padding and an end marker.
          if (reader.finished) {
            stop();
            resolve();
          }
        };
        const onAbort = () => {
          stop();
          reject(signal.reason as Error);
        };

        archive.on("data", onData);
        archive.on("end", resolve);
        archive.on("close", resolve);
        archive.on("error", reject);
        signal.addEventListener("abort", onAbort, { once: true });
      });
    } catch (cause) {
      if (cause instanceof SandboxFileError) throw cause;
      if (signal.aborted) throw cause;
      throw asSandboxError(cause, `Could not read ${path} from the sandbox.`);
    }

    const file = reader.content();
    if (!file) {
      throw new SandboxFileError(
        reader.isDirectory
          ? `${path} is a directory, not a file.`
          : `${path} is not a regular file.`,
        "not_a_file",
      );
    }
    return { content: file.content.toString("utf8"), truncated: file.truncated };
  }

  /**
   * Writes a file into the container, creating its parent directories first.
   *
   * Two steps rather than one, and the reason is the failure this avoids:
   * `putArchive` extracts as root and honours whatever the archive says, so an
   * archive carrying its own directory entries would happily re-own
   * `/home/node` on the way past. Making the parents with `mkdir -p` as the
   * container's own user cannot do that, and it costs one exec against a
   * container that is already running.
   */
  async putFile(path: string, content: string, signal: AbortSignal): Promise<void> {
    signal.throwIfAborted();
    if (!namesAFile(path)) {
      throw new SandboxFileError(`${path} does not name a file.`, "not_a_file");
    }
    const directory = posix.dirname(path);
    const name = posix.basename(path);

    const made = await this.exec({
      argv: ["mkdir", "-p", directory],
      cwd: "/",
      timeoutMs: WORKDIR_TIMEOUT_MS,
      signal,
    });
    if (made.exitCode !== 0) {
      throw new SandboxFileError(
        `Could not create ${directory} in the sandbox: ${made.stderr.trim() || "mkdir failed"}.`,
        "not_a_file",
      );
    }

    const archive = packFile(name, Buffer.from(content, "utf8"));
    try {
      await this.container.putArchive(Readable.from([archive]), { path: directory });
    } catch (cause) {
      if (isNotFound(cause)) {
        throw new SandboxFileError(`${directory} does not exist in the sandbox.`, "not_found", {
          cause,
        });
      }
      throw asSandboxError(cause, `Could not write ${path} into the sandbox.`);
    }
  }

  /**
   * Extracts a host-produced repository archive into the sandbox.
   *
   * The archive is already complete and bounded by the host Git operation, so
   * it crosses the Docker API as bytes rather than through an argv or a UTF-8
   * string. The abort listener destroys the upload stream; a cancelled seed
   * must not leave an in-flight Docker request holding the worker open.
   */
  getResourceReport(): Promise<SandboxResourceReport> {
    return this.resources.report();
  }

  startResourceMonitoring(): void {
    this.resources.start();
  }

  async putArchive(path: string, archive: Uint8Array, signal: AbortSignal): Promise<void> {
    signal.throwIfAborted();
    const stream = Readable.from([Buffer.from(archive)]);
    const onAbort = () => stream.destroy(abortError(signal));
    signal.addEventListener("abort", onAbort, { once: true });

    try {
      await this.container.putArchive(stream, { path });
      signal.throwIfAborted();
    } catch (cause) {
      if (signal.aborted) throw abortError(signal);
      throw asSandboxError(cause, `Could not extract an archive into ${path}.`);
    } finally {
      signal.removeEventListener("abort", onAbort);
    }
  }

  /**
   * Removes the container. Idempotent, and never throws - see the port.
   *
   * Every failure here is logged and swallowed, including the ones that leave a
   * container behind, because this runs in `finally` blocks that are already
   * carrying a more interesting error. The reaper is the backstop for whatever
   * this could not remove, which is the same argument the sweeper makes about
   * leases.
   */
  async destroy(): Promise<void> {
    if (this.destroyed) return;
    this.destroyed = true;
    // Finalize the monitor before removal. Docker's OOM state disappears with
    // the container, and a cleanup path that removes first cannot explain a
    // later `oom_killed` verdict. The monitor is deliberately non-throwing.
    await this.resources.report().catch((error: unknown) => {
      this.log.warn({ err: error, containerId: this.id }, "could not finalize sandbox resources");
    });
    try {
      await this.container.remove({ force: true, v: true });
    } catch (cause) {
      if (isNotFound(cause)) return;
      this.log.warn({ err: cause, containerId: this.id }, "could not destroy a sandbox");
    }
  }

  /**
   * Whether the kernel killed something in this container for memory.
   *
   * Read from the container's own state rather than inferred from exit code
   * 137, which every SIGKILL produces and which therefore says nothing about
   * why. This is also why `AutoRemove` is off: a removed container has no state
   * left to ask.
   *
   * Two things about this flag that the Docker docs do not spell out and that
   * cost an experiment each. It reports OOM kills of *exec'd* processes, not
   * just of PID 1 - the container stays up and running with the flag set, which
   * is exactly the case Rivet cares about, since every command here is an exec.
   * And it is sticky: once set it stays set for the life of the container. That
   * is why it is only consulted for an exit code that could be a kill. A job
   * whose container has already OOM'd is failed and on its way out, so the
   * second reading never gets to matter.
   *
   * It also lands *after* the exec's stream closes, by a few hundred
   * milliseconds - reading it once, immediately, reports `false` for a
   * container that very much did run out of memory. Hence the poll, which is
   * the difference between `oom_killed` and a bare exit code 137 that nobody
   * can explain.
   */
  private async wasOomKilled({ poll }: { poll: boolean }): Promise<boolean> {
    const attempts = poll ? OOM_POLL_ATTEMPTS : 1;
    for (let attempt = 0; attempt < attempts; attempt += 1) {
      try {
        const info = await this.container.inspect();
        if (info.State.OOMKilled === true) return true;
      } catch {
        return false;
      }
      await delay(OOM_POLL_INTERVAL_MS);
    }
    return false;
  }
}

/** Matches the worker's `SANDBOX_MAX_OUTPUT_BYTES` default; a caller normally passes one. */
const DEFAULT_MAX_OUTPUT_BYTES = 65_536;

/** Half a second of waiting for an exec's exit code to be published. */
const EXIT_CODE_POLL_INTERVAL_MS = 25;

/** Two seconds of waiting for the daemon to admit an OOM kill it already made. */
const OOM_POLL_ATTEMPTS = 20;
const OOM_POLL_INTERVAL_MS = 100;

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Long enough for a `mkdir` on a machine under load, short enough to fail fast. */
const WORKDIR_TIMEOUT_MS = 30_000;

/**
 * Creates the working directory as the container's own user.
 *
 * The first command of every sandbox, and the reason it exists is a trap worth
 * writing down: Docker creates a missing `WorkingDir` itself, as root, and does
 * not chown it to the `User` the container runs as. A container that asks for
 * `/workspace` therefore starts with a `/workspace` that uid 1000 cannot write
 * to, and the symptom is a clone failing three phases later.
 *
 * Doing it with `mkdir` as the container user makes the requirement explicit
 * instead: the workdir's parent has to already be writable by uid 1000, which
 * `/home/node` is in the node images and `/` is not.
 */
async function ensureWorkdir(
  sandbox: Sandbox,
  workdir: string,
  signal: AbortSignal,
): Promise<void> {
  const result = await sandbox.exec({
    argv: ["mkdir", "-p", workdir],
    cwd: "/",
    timeoutMs: WORKDIR_TIMEOUT_MS,
    signal,
  });

  if (result.exitCode !== 0) {
    throw new SandboxCreateFailedError(
      `Could not create the sandbox working directory ${workdir}: ${result.stderr.trim() || "mkdir failed"}. ` +
        "Its parent must be writable by uid 1000.",
    );
  }
}

/**
 * Reads an exec's exit code, allowing for the daemon to catch up.
 *
 * The stream ending and the exec being marked finished are two different
 * events, and on a fast command they can arrive in either order. A short poll
 * is far less confusing than an exit code that is `null` a small percentage of
 * the time.
 */
async function exitCodeOf(exec: {
  inspect: () => Promise<{ ExitCode: number | null; Running: boolean }>;
}): Promise<number | null> {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const info = await exec.inspect();
    if (!info.Running && info.ExitCode !== null) return info.ExitCode;
    await delay(EXIT_CODE_POLL_INTERVAL_MS);
  }
  return null;
}

/**
 * Turns a dockerode failure into the right domain error.
 *
 * A socket that is not there means the daemon is not there, which is retryable
 * and says so. Everything else that goes wrong while building a sandbox is a
 * create failure, also retryable, because create failures are properties of the
 * host rather than of the job.
 */
function asSandboxError(cause: unknown, message: string): Error {
  if (isDaemonUnreachable(cause)) {
    return new SandboxUnavailableError(`${message} The Docker daemon is not reachable.`, { cause });
  }
  return new SandboxCreateFailedError(`${message} ${describe(cause)}`, { cause });
}

function isDaemonUnreachable(cause: unknown): boolean {
  const code = (cause as { code?: string } | null)?.code;
  return code === "ENOENT" || code === "ECONNREFUSED" || code === "EACCES" || code === "ECONNRESET";
}

function statusCodeOf(cause: unknown): number | undefined {
  return (cause as { statusCode?: number } | null)?.statusCode;
}

function isNotFound(cause: unknown): boolean {
  return statusCodeOf(cause) === 404;
}

/** 409 from a kill means the container already stopped, which is not a problem. */
function isNotRunning(cause: unknown): boolean {
  return statusCodeOf(cause) === 409;
}

function describe(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

function abortError(signal: AbortSignal): Error {
  const reason: unknown = signal.reason;
  if (reason instanceof Error) return reason;
  if (typeof reason === "string") return new Error(reason);
  return new Error("Sandbox archive upload aborted.");
}
