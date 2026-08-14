"use client";

import {
  parseSerializedJobEvent,
  type JobEvent,
  type JobStatus,
  type SerializedJobEvent,
} from "@rivet/contracts";
import { useRouter } from "next/navigation";
import {
  createContext,
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
  selectJobLiveEvents,
  type StreamConnectionState,
} from "./stream-state";

const STREAM_PROTOCOL_RETRY_MS = 2_000;

interface JobLiveContextValue {
  status: JobStatus;
  connection: StreamConnectionState;
  events: readonly JobEvent[];
  lastEventId: number | null;
}

const JobLiveContext = createContext<JobLiveContextValue | null>(null);

interface JobLiveProviderProps {
  jobId: string;
  initialStatus: JobStatus;
  initialEvents: readonly SerializedJobEvent[];
  children: ReactNode;
}

interface InitialStateInput {
  initialStatus: JobStatus;
  initialEvents: readonly SerializedJobEvent[];
}

/** Owns one durable event cursor for every live consumer on the job page. */
export function JobLiveProvider({
  jobId,
  initialStatus,
  initialEvents,
  children,
}: JobLiveProviderProps) {
  const [state, dispatch] = useReducer(
    jobLiveReducer,
    { initialStatus, initialEvents } satisfies InitialStateInput,
    ({ initialStatus: status, initialEvents: events }: InitialStateInput) =>
      createJobLiveState(status, events.map(parseSerializedJobEvent)),
  );
  const router = useRouter();
  const cursorRef = useRef<number | null>(state.lastEventId);
  const sourceRef = useRef<EventSource | null>(null);
  const finishedRef = useRef(false);
  const refreshedRef = useRef(false);

  useEffect(() => {
    if (state.lastEventId !== null && state.lastEventId > (cursorRef.current ?? -1)) {
      cursorRef.current = state.lastEventId;
    }
  }, [state.lastEventId]);

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
  const value = useMemo<JobLiveContextValue>(
    () => ({
      status: state.status,
      connection: state.connection,
      events,
      lastEventId: state.lastEventId,
    }),
    [events, state.connection, state.lastEventId, state.status],
  );

  return <JobLiveContext.Provider value={value}>{children}</JobLiveContext.Provider>;
}

export function useJobLive(): JobLiveContextValue {
  const context = useContext(JobLiveContext);
  if (!context) throw new Error("useJobLive must be used inside JobLiveProvider.");
  return context;
}
