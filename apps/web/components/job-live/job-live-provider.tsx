"use client";

import {
  parseSerializedJobCommandSummary,
  parseSerializedJobCommand,
  parseSerializedJobEvent,
  type JobEvent,
  type JobStatus,
  type SerializedJobCommandSummary,
  type SerializedJobEvent,
} from "@rivet/contracts";
import { useRouter } from "next/navigation";
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useReducer,
  useRef,
  type ReactNode,
} from "react";

import {
  createJobLiveState,
  jobEventsUrl,
  jobLiveReducer,
  parseStreamEnd,
  selectJobLiveCommands,
  selectJobLiveEvents,
  type LiveCommand,
  type StreamConnectionState,
} from "./stream-state";

const STREAM_PROTOCOL_RETRY_MS = 2_000;

interface JobLiveContextValue {
  status: JobStatus;
  connection: StreamConnectionState;
  events: readonly JobEvent[];
  commands: readonly LiveCommand[];
  lastEventId: number | null;
  requestCommandDetails: (commandId: number) => void;
  retryCommandDetails: (commandId: number) => void;
}

const JobLiveContext = createContext<JobLiveContextValue | null>(null);

interface JobLiveProviderProps {
  jobId: string;
  initialStatus: JobStatus;
  initialEvents: readonly SerializedJobEvent[];
  initialCommandSummaries: readonly SerializedJobCommandSummary[];
  children: ReactNode;
}

interface InitialStateInput {
  initialStatus: JobStatus;
  initialEvents: readonly SerializedJobEvent[];
  initialCommandSummaries: readonly SerializedJobCommandSummary[];
}

/** Owns one durable event cursor for every live consumer on the job page. */
export function JobLiveProvider({
  jobId,
  initialStatus,
  initialEvents,
  initialCommandSummaries,
  children,
}: JobLiveProviderProps) {
  const [state, dispatch] = useReducer(
    jobLiveReducer,
    { initialStatus, initialEvents, initialCommandSummaries } satisfies InitialStateInput,
    ({
      initialStatus: status,
      initialEvents: events,
      initialCommandSummaries: summaries,
    }: InitialStateInput) =>
      createJobLiveState(
        status,
        events.map(parseSerializedJobEvent),
        summaries.map(parseSerializedJobCommandSummary),
      ),
  );
  const router = useRouter();
  const cursorRef = useRef<number | null>(state.lastEventId);
  const sourceRef = useRef<EventSource | null>(null);
  const detailRequestsRef = useRef(new Set<string>());
  const finishedRef = useRef(false);
  const refreshedRef = useRef(false);

  useEffect(() => {
    if (state.lastEventId !== null && state.lastEventId > (cursorRef.current ?? -1)) {
      cursorRef.current = state.lastEventId;
    }
  }, [state.lastEventId]);

  useEffect(() => {
    let disposed = false;

    for (const [commandId, request] of state.commandDetailsById) {
      if (request.status !== "loading") continue;

      const requestKey = `${jobId}:${String(commandId)}`;
      if (detailRequestsRef.current.has(requestKey)) continue;
      detailRequestsRef.current.add(requestKey);

      void fetch(`/api/jobs/${encodeURIComponent(jobId)}/commands/${String(commandId)}`)
        .then(async (response) => {
          if (!response.ok) {
            throw new Error(`Transcript request failed with status ${String(response.status)}.`);
          }
          const body: unknown = await response.json();
          return parseSerializedJobCommand(body);
        })
        .then((command) => {
          if (!disposed) dispatch({ type: "command.detail.received", command });
        })
        .catch((error: unknown) => {
          if (disposed) return;
          const message = error instanceof Error ? error.message : "Could not load transcript.";
          dispatch({ type: "command.detail.failed", commandId, error: message });
        })
        .finally(() => {
          detailRequestsRef.current.delete(requestKey);
        });
    }

    return () => {
      disposed = true;
    };
  }, [jobId, state.commandDetailsById]);

  useEffect(() => {
    let disposed = false;
    let protocolRetryTimer: number | undefined;

    const closeSource = () => {
      const source = sourceRef.current;
      sourceRef.current = null;
      source?.close();
    };

    const clearProtocolRetry = () => {
      if (protocolRetryTimer === undefined) return;
      window.clearTimeout(protocolRetryTimer);
      protocolRetryTimer = undefined;
    };

    const connect = () => {
      if (disposed || finishedRef.current || document.visibilityState === "hidden") return;

      clearProtocolRetry();
      closeSource();
      dispatch({ type: "connection.changed", connection: "connecting" });

      const source = new EventSource(jobEventsUrl(jobId, cursorRef.current));
      sourceRef.current = source;

      const isCurrent = () => !disposed && sourceRef.current === source;

      source.addEventListener("open", () => {
        if (!isCurrent()) return;
        dispatch({ type: "connection.changed", connection: "live" });
      });

      source.addEventListener("job.event", (event) => {
        if (!isCurrent()) return;

        try {
          const message = event as MessageEvent<string>;
          const parsed = parseSerializedJobEvent(JSON.parse(message.data) as unknown);
          if (cursorRef.current === null || parsed.id > cursorRef.current) {
            cursorRef.current = parsed.id;
          }
          dispatch({ type: "event.received", event: parsed });
        } catch (error) {
          // A malformed frame cannot advance the cursor. Close only this
          // connection and retry from the last valid durable id.
          console.error("Could not parse a job event stream frame.", error);
          closeSource();
          dispatch({ type: "connection.changed", connection: "reconnecting" });
          protocolRetryTimer = window.setTimeout(() => {
            protocolRetryTimer = undefined;
            connect();
          }, STREAM_PROTOCOL_RETRY_MS);
        }
      });

      source.addEventListener("stream.end", (event) => {
        if (!isCurrent()) return;

        try {
          const message = event as MessageEvent<string>;
          const end = parseStreamEnd(JSON.parse(message.data) as unknown);
          finishedRef.current = true;
          closeSource();
          dispatch({ type: "stream.finished", ...end });

          if (!refreshedRef.current) {
            refreshedRef.current = true;
            router.refresh();
          }
        } catch (error) {
          console.error("Could not parse the end of a job event stream.", error);
          closeSource();
          dispatch({ type: "connection.changed", connection: "reconnecting" });
          protocolRetryTimer = window.setTimeout(() => {
            protocolRetryTimer = undefined;
            connect();
          }, STREAM_PROTOCOL_RETRY_MS);
        }
      });

      source.addEventListener("error", () => {
        if (!isCurrent() || finishedRef.current) return;
        // EventSource owns the network retry timer. This state change is only
        // what lets the page tell the viewer that the current connection broke.
        dispatch({ type: "connection.changed", connection: "reconnecting" });
      });
    };

    const onVisibilityChange = () => {
      if (document.visibilityState === "hidden") {
        clearProtocolRetry();
        closeSource();
        if (!finishedRef.current) {
          dispatch({ type: "connection.changed", connection: "reconnecting" });
        }
        return;
      }

      connect();
    };

    document.addEventListener("visibilitychange", onVisibilityChange);
    connect();

    return () => {
      disposed = true;
      clearProtocolRetry();
      document.removeEventListener("visibilitychange", onVisibilityChange);
      closeSource();
    };
  }, [jobId, router]);

  const events = useMemo(() => selectJobLiveEvents(state), [state]);
  const commands = useMemo(() => selectJobLiveCommands(state), [state]);
  const requestCommandDetails = useCallback(
    (commandId: number) => dispatch({ type: "command.detail.requested", commandId }),
    [],
  );
  const retryCommandDetails = useCallback(
    (commandId: number) => dispatch({ type: "command.detail.requested", commandId }),
    [],
  );
  const value = useMemo<JobLiveContextValue>(
    () => ({
      status: state.status,
      connection: state.connection,
      events,
      commands,
      lastEventId: state.lastEventId,
      requestCommandDetails,
      retryCommandDetails,
    }),
    [
      commands,
      events,
      requestCommandDetails,
      retryCommandDetails,
      state.connection,
      state.lastEventId,
      state.status,
    ],
  );

  return <JobLiveContext.Provider value={value}>{children}</JobLiveContext.Provider>;
}

export function useJobLive(): JobLiveContextValue {
  const context = useContext(JobLiveContext);
  if (!context) throw new Error("useJobLive must be used inside JobLiveProvider.");
  return context;
}
