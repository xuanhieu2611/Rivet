import { isTerminal, type JobStatus } from "@rivet/contracts";
import type { listEvents } from "@rivet/core";

import { encodeSseComment, encodeSseFrame, encodeSseRetry } from "./sse";

export const SSE_RETRY_MS = 2_000;
export const SSE_POLL_INTERVAL_MS = 1_000;
export const SSE_HEARTBEAT_INTERVAL_MS = 15_000;
export const SSE_TERMINAL_GRACE_MS = 2_000;
export const SSE_EVENT_LIMIT = 200;

export interface StreamJobEventsOptions {
  jobId: string;
  after: number | null;
  initialStatus: JobStatus;
  signal: AbortSignal;
  pollIntervalMs: number;
  heartbeatIntervalMs: number;
  terminalGraceMs: number;
  list: typeof listEvents;
  sleep: (milliseconds: number, signal: AbortSignal) => Promise<void>;
  /** Injectable for deterministic terminal and heartbeat tests. */
  now?: () => number;
}

/**
 * Creates a database-backed SSE body for one job.
 *
 * The stream is a tailer, not an event broker. It reads the append-only log in
 * bounded pages, advances the durable event id only after framing a row, and
 * lets EventSource reconnect from that id if the response breaks.
 */
export function createJobEventStream(options: StreamJobEventsOptions): ReadableStream<Uint8Array> {
  const abortController = new AbortController();
  let streamClosed = false;
  let removeRequestAbortListener: (() => void) | undefined;

  const abort = (reason?: unknown) => {
    if (!abortController.signal.aborted) abortController.abort(reason);
  };

  const onRequestAbort = () => abort(options.signal.reason);
  if (options.signal.aborted) {
    onRequestAbort();
  } else {
    options.signal.addEventListener("abort", onRequestAbort, { once: true });
    removeRequestAbortListener = () => options.signal.removeEventListener("abort", onRequestAbort);
  }

  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      void runStream(controller);
    },
    cancel(reason) {
      streamClosed = true;
      abort(reason);
    },
  });

  return stream;

  async function runStream(controller: ReadableStreamDefaultController<Uint8Array>) {
    const signal = abortController.signal;
    const now = options.now ?? Date.now;
    let cursor = options.after;
    let status = options.initialStatus;
    let terminalSeen = isTerminal(status);
    let terminalDeadline = terminalSeen ? now() + options.terminalGraceMs : null;
    let lastHeartbeatAt = now();

    try {
      if (signal.aborted) return;

      enqueue(encodeSseRetry(SSE_RETRY_MS), controller);
      enqueue(encodeSseComment("connected"), controller);

      for (;;) {
        if (signal.aborted) return;

        const events = await options.list(
          options.jobId,
          cursor === null ? { limit: SSE_EVENT_LIMIT } : { after: cursor, limit: SSE_EVENT_LIMIT },
        );
        if (signal.aborted) return;

        let emitted = 0;
        for (const event of events) {
          if (signal.aborted) return;
          if (cursor !== null && event.id <= cursor) continue;

          enqueue(encodeSseFrame({ id: event.id, event: "job.event", data: event }), controller);
          cursor = event.id;
          emitted += 1;

          const nextStatus = event.data?.to;
          if (typeof nextStatus === "string") {
            status = nextStatus;
            if (isTerminal(status)) terminalSeen = true;
          }
        }

        if (emitted > 0 && terminalSeen) {
          // Any event after terminal state is potentially cleanup, so the
          // quiescence window starts over at the end of this delivered batch.
          terminalDeadline = now() + options.terminalGraceMs;
        }

        const currentTime = now();
        if (
          options.heartbeatIntervalMs > 0 &&
          currentTime - lastHeartbeatAt >= options.heartbeatIntervalMs
        ) {
          enqueue(encodeSseComment("keepalive"), controller);
          lastHeartbeatAt = currentTime;
        }

        // A full page means there may be more historical work immediately
        // available. Drain it without imposing the live poll interval.
        if (events.length >= SSE_EVENT_LIMIT && emitted > 0) continue;

        if (terminalDeadline !== null && currentTime >= terminalDeadline) {
          enqueue(
            encodeSseFrame({
              event: "stream.end",
              data: { cursor, status },
            }),
            controller,
          );
          close(controller);
          return;
        }

        const waitMs =
          terminalDeadline === null
            ? options.pollIntervalMs
            : Math.min(options.pollIntervalMs, Math.max(0, terminalDeadline - currentTime));
        await options.sleep(waitMs, signal);
      }
    } catch (error) {
      if (!signal.aborted && !streamClosed) fail(controller, error);
    } finally {
      removeRequestAbortListener?.();
      if (signal.aborted && !streamClosed) close(controller);
    }
  }

  function enqueue(frame: string, controller: ReadableStreamDefaultController<Uint8Array>) {
    if (streamClosed) return;
    controller.enqueue(new TextEncoder().encode(frame));
  }

  function close(controller: ReadableStreamDefaultController<Uint8Array>) {
    if (streamClosed) return;
    streamClosed = true;
    try {
      controller.close();
    } catch {
      // The consumer may have cancelled between the guard and close(). The
      // cancellation already released the stream's resources.
    }
  }

  function fail(controller: ReadableStreamDefaultController<Uint8Array>, error: unknown) {
    if (streamClosed) return;
    streamClosed = true;
    try {
      controller.error(error);
    } catch {
      // A cancelled response has no reader left to notify.
    }
  }
}

/** Abort-aware wait used by the production route. */
export function sleepWithAbort(milliseconds: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.reject(abortError(signal));
  if (milliseconds <= 0) return Promise.resolve();

  return new Promise<void>((resolve, reject) => {
    const onAbort = () => {
      clearTimeout(timer);
      signal.removeEventListener("abort", onAbort);
      reject(abortError(signal));
    };

    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, milliseconds);
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

function abortError(signal: AbortSignal): Error {
  const reason = signal.reason as unknown;
  if (reason instanceof Error) return reason;
  return new Error(typeof reason === "string" ? reason : "Stream aborted.");
}
