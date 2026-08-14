/**
 * The sandbox PORT: what the domain needs from an isolated execution
 * environment, and nothing more.
 *
 * Types and an interface, no implementation, for the same reason
 * `queue/job-queue.ts` is types and an interface: the moment `@rivet/core`
 * imports `dockerode`, the package stops being runnable by anything that does
 * not have a Docker daemon, and `pnpm test` stops being a thing CI can run on a
 * bare machine. `packages/sandbox` supplies two implementations - the dockerode
 * adapter for the real system, and a scripted fake for tests.
 *
 * The port is deliberately smaller than Docker. It knows about creating an
 * environment, running an argument vector inside it, moving one file in or out
 * of it, and destroying it. It does not know about image layers, networks,
 * volumes or execs, because none of those are things the domain has an opinion
 * about.
 */

/**
 * Everything needed to bring one job's environment into existence.
 *
 * Every resource limit is a required field rather than an optional one with a
 * default. A default here would be a policy decision made in the package that
 * is supposed to have no policy, and the failure mode of a forgotten limit is
 * an unbounded container, which is exactly the thing the sandbox exists to
 * prevent. `apps/worker` reads these from the environment and passes them in.
 */
export interface SandboxSpec {
  jobId: string;
  /** Pinned by digest, not just by tag, so an upstream retag cannot change what a job runs. */
  image: string;
  /**
   * Where the job's work happens. `/home/node/workspace` today.
   *
   * Not `/workspace`, and the reason is a property of containers rather than a
   * preference: a sandbox runs as an unprivileged user, so the workdir's parent
   * has to be one that user can already write. `/` is not, and a directory the
   * runtime creates on the way in belongs to root.
   */
  workdir: string;
  memoryBytes: number;
  /** CPU quota in billionths of a core, Docker's own unit. 2 CPUs is 2_000_000_000. */
  nanoCpus: number;
  pidsLimit: number;
  /**
   * The environment the container gets, as an allowlist.
   *
   * At Milestone 2 this is empty and that is the point: no credential of any
   * kind reaches a container, because there is no mechanism by which one could.
   * When Milestone 9 introduces GitHub tokens, this is the single place that
   * has to be argued about.
   */
  env: Record<string, string>;
  /**
   * Labels stamped on the environment, which is the reaper's only handle on it.
   *
   * A container that outlives its worker has nothing else identifying it: the
   * process that knew about it is gone. See `SandboxProvider.reap`.
   */
  labels: Record<string, string>;
}

export interface ExecRequest {
  /**
   * The command as an argument vector, never a shell string.
   *
   * There is no shell in the execution path, so there is no quoting layer that
   * could disagree with what actually ran. A repository whose name contains a
   * space is not a security incident.
   */
  argv: string[];
  cwd: string;
  /**
   * How long this one command gets, distinct from the job's
   * `max_duration_seconds`. A hung `pnpm install` and a job that is merely slow
   * are different failures and get different categories.
   */
  timeoutMs: number;
  /** Cancellation and job timeout both arrive here. Aborting kills the command. */
  signal: AbortSignal;
  /** Merged over the sandbox's own environment, for this command only. */
  env?: Record<string, string>;
  /**
   * Cap on each of stdout and stderr, in bytes.
   *
   * The implementation keeps counting past the cap so that `truncated` and the
   * elision marker can state how much was dropped.
   */
  maxOutputBytes?: number;
}

/**
 * What a command did. Never an exception.
 *
 * A non-zero exit is a result, not an error, because most of the interesting
 * commands in this system are allowed to fail: the baseline test run is
 * expected to fail on exactly the repositories Rivet is most useful for. The
 * caller decides which non-zero exits are job failures; the sandbox just
 * reports. What *does* throw is the sandbox itself being broken - see
 * `errors.ts`.
 */
export interface ExecResult {
  argv: string[];
  cwd: string;
  /** Null when the command was killed before it could exit: timeout, abort, or OOM. */
  exitCode: number | null;
  stdout: string;
  stderr: string;
  /** True when output hit `maxOutputBytes` and the transcript has a stated gap. */
  truncated: boolean;
  /** The command outlived `timeoutMs`. */
  timedOut: boolean;
  /** Read from the container's own state, which is what tells a memory kill apart from any other 137. */
  oomKilled: boolean;
  durationMs: number;
}

/**
 * How much of a file the caller is willing to hold in memory.
 *
 * Required rather than defaulted, the same rule every other bound in this file
 * follows. A repository is allowed to contain a 900MB fixture, and the failure
 * mode of a forgotten cap is a worker heap that is now that size.
 */
export interface FileReadOptions {
  maxBytes: number;
}

export interface FileRead {
  /**
   * The file's bytes, decoded as UTF-8.
   *
   * Text rather than bytes because everything this exists to serve - a model
   * reading source, an exact-match edit, a written patch - is text, and the one
   * consumer that would want bytes (image reading) is deliberately not offered.
   * A cut at `maxBytes` can land mid-character, in which case the last character
   * is a replacement character; that is the correct amount of effort to spend on
   * the tail of a file that has already been truncated.
   */
  content: string;
  /** The file was longer than `maxBytes` and `content` is a prefix of it. */
  truncated: boolean;
}

/** One job's live environment. Created once per attempt, never shared. */
export interface Sandbox {
  /** The implementation's identifier for it. A container id, for the Docker adapter. */
  readonly id: string;

  exec(request: ExecRequest): Promise<ExecResult>;

  /**
   * Reads one file out of the environment.
   *
   * Not `exec(["cat", path])`, and the reasons are worth stating because that
   * is the obvious first implementation. A `cat` cannot say whether it was
   * truncated, cannot distinguish a missing file from an empty one without
   * parsing stderr, and carries every byte through the same framed stream the
   * command transcripts use - so a file read would show up in the command log
   * as a command the job never chose to run.
   *
   * Throws `SandboxFileError` when the path is missing or is not a regular
   * file. That error deliberately sits outside the job-failure hierarchy: a
   * model asking to read a file that does not exist is a tool result it reads
   * and corrects, not a dead job.
   */
  getFile(path: string, options: FileReadOptions, signal: AbortSignal): Promise<FileRead>;

  /**
   * Writes one file into the environment, creating parent directories as
   * needed, owned by the environment's own user.
   *
   * The counterpart to `getFile` and the harder half: the exec path has no
   * stdin, and encoding a file into an argument vector fails on exactly the
   * inputs that matter - a large file, a NUL byte, anything the caller has to
   * quote. Creating the parents here rather than exposing a `mkdir` keeps the
   * port at "move a file" instead of growing a filesystem API one method at a
   * time.
   */
  putFile(path: string, content: string, signal: AbortSignal): Promise<void>;

  /**
   * Tears the environment down. Idempotent, and **never throws**.
   *
   * This is a contract rather than a hope. `destroy()` is called from `finally`
   * blocks on paths that are already handling a failure, and a cleanup error
   * that masks the original error is how a two-minute diagnosis becomes an
   * hour. An implementation that cannot destroy its sandbox logs and returns;
   * the reaper is the backstop for whatever it left behind.
   */
  destroy(): Promise<void>;
}

export interface SandboxProvider {
  create(spec: SandboxSpec, signal: AbortSignal): Promise<Sandbox>;

  /**
   * Removes sandboxes this system created whose job is no longer running.
   *
   * The third reconciliation loop, alongside the lease sweep and the queue's
   * idempotent re-enqueue, and it exists for the same reason as those two:
   * `kill -9` leaves a container with nobody left to destroy it. Postgres is
   * the authority, so the provider does not decide what is dead - it lists its
   * own candidates and asks `jobIsLive` about each one.
   *
   * Returns the ids it removed, for logging.
   */
  reap(jobIsLive: (jobId: string) => Promise<boolean>): Promise<string[]>;
}
