import { AsyncLocalStorage } from "node:async_hooks";

import type {
  BashOperations,
  EditOperations,
  ReadOperations,
  WriteOperations,
} from "@earendil-works/pi-coding-agent";
import {
  type ImplementerAgentToolbox,
  type PlannerAgentToolbox,
  commandKilledError,
  type RecordedCommand,
  SandboxFileError,
} from "@rivet/core";

import { AgentPathError, resolveInside } from "./paths";

/**
 * Where the model's four tools actually do their work.
 *
 * The harness keeps its own tool schemas, descriptions, prompt snippets,
 * truncation and diff rendering; this file supplies nothing but the bytes. That
 * split is the entire integration. A tool description is part of the harness's
 * prompting, so rewriting one would be silently changing the thing being
 * integrated - and PRD §13 says not to rebuild `read`, `edit` or the shell in
 * the first place.
 *
 * Read this as the containment layer, because that is what it is. The harness
 * runs on the worker host, holding the model key, with no permission system of
 * its own and a documented refusal to have one. Every path below is resolved
 * against the repository inside the container and rejected if it escapes; every
 * command below leaves as an argument vector for `AgentToolbox.exec`; nothing
 * here imports `node:fs` or `node:child_process`, and nothing here should ever
 * be allowed to. No test can tell you that last part. Reading the imports can.
 */

export interface ToolLayerOptions {
  /** What the tools are allowed to do, supplied by the phase. */
  toolbox: ImplementerAgentToolbox;
  /** The repository, as an absolute path inside the sandbox. */
  repoDir: string;
  /** Cap on what one shell command may hand back to the model. */
  outputMaxBytes: number;
  /**
   * Ceiling on one shell command, whatever the model asks for.
   *
   * The harness's `bash` schema lets the model name a timeout in seconds. It is
   * honoured only downwards: a model may ask for less time than Rivet allows,
   * never more, because the ceiling is a property of the sandbox rather than a
   * preference of the caller.
   */
  commandTimeoutMs: number;
  /** Cancellation, the job's deadline, and the session's own, already composed. */
  signal: AbortSignal;
  /**
   * The first error that leaves the sandbox unusable.
   *
   * The distinction this callback exists for: a missing file is a tool result
   * the model reads and corrects, but a command that blew its timeout took the
   * whole container with it (the Docker adapter kills the container, because
   * the API offers no handle on a running exec). After that, every remaining
   * tool call in the session fails for a reason that has nothing to do with
   * what the model asked for. The adapter reacts by aborting the session and
   * failing the job with the original error, rather than letting the model
   * spend twenty more turns discovering that its repository has evaporated.
   */
  onFatal: (error: unknown) => void;
  /**
   * A shell command that produced a durable `job_commands` row.
   *
   * Carries the harness's tool-call id so the timeline can pair one
   * `agent.tool_started` with the `command.started` it caused. The id comes
   * from the async context below rather than from an argument, because the
   * harness's operations interface does not pass one.
   */
  onCommand: (toolCallId: string | undefined, command: RecordedCommand) => void;
}

export interface ToolOperations {
  read: ReadOperations;
  write: WriteOperations;
  edit: EditOperations;
  bash: BashOperations;
}

export interface PlannerReadLayerOptions {
  toolbox: PlannerAgentToolbox;
  repoDir: string;
  signal: AbortSignal;
  onFatal: (error: unknown) => void;
}

/**
 * The tool call currently executing, for the operations that cannot be told.
 *
 * `BashOperations.exec` receives a command, a directory and some options - and
 * no identifier for the tool call it belongs to. Correlating the resulting
 * `job_commands` row with the `agent.tool_started` event needs that identifier,
 * and the alternatives are worse: a "last started tool call" field is a race as
 * soon as two tool calls overlap, and threading an id through the harness's own
 * interface is not available. Async context is exactly the shape of this
 * problem - a value that belongs to one call tree - and it stays correct
 * however the harness decides to schedule its tools.
 */
const currentToolCall = new AsyncLocalStorage<string>();

/** Runs `body` such that the operations beneath it can see `toolCallId`. */
export function withToolCall<T>(toolCallId: string, body: () => Promise<T>): Promise<T> {
  return currentToolCall.run(toolCallId, body);
}

export function createToolOperations(options: ToolLayerOptions): ToolOperations {
  const { toolbox, repoDir, signal } = options;

  /**
   * Reads a file, or explains to the model why it could not.
   *
   * `allowTruncated` is the difference between the two callers and it is not a
   * detail. `read` may hand back a prefix of an enormous file, because a model
   * that asked for a 40MB log should get the top of one. `edit` may not: its
   * next move is to write the buffer back with one region changed, so a prefix
   * would silently delete everything past the cut. A file too large to edit is
   * a tool error the model can work around with the shell; a truncated edit is
   * data loss nobody notices until the tests fail for an unrelated reason.
   */
  async function readText(path: string, allowTruncated: boolean): Promise<Buffer> {
    const absolute = resolveInside(repoDir, path);
    const file = await guarded(() => toolbox.readFile(absolute, signal));

    if (file.truncated && !allowTruncated) {
      throw new SandboxFileError(
        `${path} is too large to edit in one call. Use the shell to change it, or read it in ` +
          `pieces and rewrite it with write.`,
        "not_a_file",
      );
    }

    // The notice goes in the content because there is nowhere else to put it:
    // the harness's read tool renders its own truncation banner from its own
    // line counting, which describes the prefix it was handed rather than the
    // file. Without this the model is told it saw the whole file.
    const content = file.truncated
      ? `${file.content}\n[rivet: this file was truncated; the rest was not read]`
      : file.content;
    return Buffer.from(content, "utf8");
  }

  /**
   * Turns an unexpected failure into a fatal one, and leaves the expected ones
   * alone.
   *
   * Two error types are answers rather than failures - a path outside the
   * repository and a file that is not there - and both belong to the model. An
   * aborted run is not the sandbox's fault either; the session is already
   * ending and reporting it as a broken container would put the wrong cause on
   * the timeline. Everything else means the sandbox stopped working, and the
   * session cannot usefully continue.
   */
  async function guarded<T>(body: () => Promise<T>): Promise<T> {
    try {
      return await body();
    } catch (error) {
      if (error instanceof SandboxFileError || error instanceof AgentPathError) throw error;
      if (!signal.aborted) options.onFatal(error);
      throw error;
    }
  }

  return {
    read: {
      readFile: (path) => readText(path, true),

      /**
       * Containment, and deliberately nothing else.
       *
       * The harness calls `access` immediately before `readFile` on both the
       * read and the edit path, and never on its own, so a permissive check
       * here costs nothing: a missing file raises from the read a line later,
       * with a better message than a bare access failure would carry. What this
       * must not skip is the path check, because this is the first place the
       * model's string is seen and rejecting it here is what makes the refusal
       * name the path the model actually wrote.
       */
      // Async so that a refusal is a rejection rather than a synchronous
      // throw. Every other method here rejects, and one that does not is the
      // kind of asymmetry a caller discovers by writing a `.catch` that never
      // fires.
      // eslint-disable-next-line @typescript-eslint/require-await
      access: async (path) => {
        resolveInside(repoDir, path);
      },
      // `detectImageMimeType` is deliberately absent. It is optional, and
      // leaving it out is what keeps every read on the text path: the port
      // moves text across the sandbox boundary and has no bytes to offer an
      // image decoder.
    },

    write: {
      writeFile: (path, content) =>
        guarded(() => toolbox.writeFile(resolveInside(repoDir, path), content, signal)),

      /**
       * A containment check standing in for a directory creation.
       *
       * `AgentToolbox.writeFile` creates the parents it needs, which is the
       * port's whole reason for not exposing a `mkdir`: growing a filesystem
       * API one method at a time is how a port stops being a port. The harness
       * still calls this first, so it still has to reject an escaping path -
       * otherwise the refusal would arrive from the write, after the model had
       * already been told the directory was fine.
       */
      // eslint-disable-next-line @typescript-eslint/require-await
      mkdir: async (dir) => {
        resolveInside(repoDir, dir);
      },
    },

    edit: {
      readFile: (path) => readText(path, false),
      writeFile: (path, content) =>
        guarded(() => toolbox.writeFile(resolveInside(repoDir, path), content, signal)),
      // eslint-disable-next-line @typescript-eslint/require-await
      access: async (path) => {
        resolveInside(repoDir, path);
      },
    },

    bash: {
      /**
       * Note what is destructured and, much more importantly, what is not.
       *
       * The harness passes an `env` built from the worker's own `process.env` -
       * it is trying to be a local shell, and a local shell inherits its
       * parent's environment. Forwarding that into the container would put
       * `OPENROUTER_API_KEY` inside a sandbox running arbitrary cloned code,
       * which is the exact thing the host-side topology exists to prevent. It
       * is never read, and the container keeps the empty environment
       * `SandboxSpec` gives it. The harness's `signal` is not read either: the
       * phase's composed signal is already the more authoritative of the two,
       * and it is what `AgentToolbox.exec` runs under.
       */
      exec: async (command, cwd, { onData, timeout }) => {
        const toolCallId = currentToolCall.getStore();
        const result = await guarded(() =>
          toolbox.exec({
            // The one place a shell string exists anywhere in Rivet, and it
            // exists as a single argv element rather than as interpolation: the
            // string is built by the model, passed through untouched, and
            // interpreted by the container's own shell as uid 1000 under
            // `no-new-privileges` and `CapDrop: ALL`. "Rivet never builds a
            // shell string" stays exactly as true as it was.
            argv: ["bash", "-lc", command],
            cwd: resolveInside(repoDir, cwd),
            timeoutMs: budget(timeout, options.commandTimeoutMs),
          }),
        );

        onCommandRecorded(toolCallId, result);

        // Streamed in one piece at the end rather than as it arrives. The
        // sandbox port returns a finished command, and the harness's only use
        // for the stream is a progress display Rivet does not have. The
        // transcript that matters is already in `job_commands`.
        //
        // The cap applied here is on **what the model sees**, which is a
        // different bound from what Rivet stores: the durable transcript keeps
        // the run's ordinary output limit, because a human debugging a job
        // later wants the whole thing, while a megabyte of build log in a
        // context window is a megabyte of budget spent on noise.
        const shown = capBytes(
          [result.stdout, result.stderr].filter(Boolean).join(""),
          options.outputMaxBytes,
        );
        if (shown) onData(Buffer.from(shown, "utf8"));

        const killed = commandKilledError(result);
        if (killed) {
          // Fatal rather than a tool error, and this is the case the callback
          // exists for. A command that hit its timeout was stopped by killing
          // the container it ran in; there is no sandbox left for the model to
          // recover into.
          options.onFatal(killed);
          throw killed;
        }

        return { exitCode: result.exitCode };
      },
    },
  };

  function onCommandRecorded(toolCallId: string | undefined, result: RecordedCommand): void {
    try {
      options.onCommand(toolCallId, result);
    } catch {
      // Correlating a tool call with its transcript is a nicety on the
      // timeline. It is not worth failing a tool call the model is waiting on.
    }
  }
}

/** Read-only file operations used by the planner role. */
export function createPlannerReadOperations(options: PlannerReadLayerOptions): ReadOperations {
  const readFile = async (path: string): Promise<Buffer> => {
    const absolute = resolveInside(options.repoDir, path);
    try {
      const file = await options.toolbox.readFile(absolute, options.signal);
      const content = file.truncated
        ? `${file.content}\n[rivet: this file was truncated; the rest was not read]`
        : file.content;
      return Buffer.from(content, "utf8");
    } catch (error) {
      if (error instanceof SandboxFileError || error instanceof AgentPathError) throw error;
      if (!options.signal.aborted) options.onFatal(error);
      throw error;
    }
  };

  return {
    readFile,
    access: (path) => {
      resolveInside(options.repoDir, path);
      return Promise.resolve();
    },
  };
}

/**
 * How long one shell command gets.
 *
 * The harness's schema takes seconds and allows the model to omit it. Rivet's
 * ceiling applies either way and is never raised by a model asking for more:
 * the timeout is what stands between a `sleep infinity` and a container that
 * holds a worker slot until the job's own deadline.
 */
/**
 * Keeps the tail rather than the head, which is the opposite of what a file
 * read wants and the right answer for a command.
 *
 * The interesting part of a failed build is the error at the bottom, not the
 * first thousand lines of dependency resolution above it.
 */
function capBytes(text: string, maxBytes: number): string {
  const bytes = Buffer.from(text, "utf8");
  if (bytes.byteLength <= maxBytes) return text;
  const kept = bytes.subarray(bytes.byteLength - maxBytes).toString("utf8");
  return `[rivet: showing the last ${maxBytes} bytes of ${bytes.byteLength}]\n${kept}`;
}

function budget(requestedSeconds: number | undefined, ceilingMs: number): number {
  if (requestedSeconds === undefined || !Number.isFinite(requestedSeconds)) return ceilingMs;
  if (requestedSeconds <= 0) return ceilingMs;
  return Math.min(Math.round(requestedSeconds * 1_000), ceilingMs);
}
