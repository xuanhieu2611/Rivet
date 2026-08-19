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
import { useReducedMotion } from "motion/react";
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

import { deriveLiveAgentUsage, type InitialAgentUsage, type LiveAgentUsage } from "./agent-usage";
import {
  createJobLiveState,
  jobEventsUrl,
  jobLiveReducer,
  parseStreamEnd,
  selectJobLiveCommands,
  selectJobLiveEvents,
  selectTimelineMotion,
  type LiveCommand,
  type StreamConnectionState,
  type TimelineMotion,
} from "./stream-state";

const STREAM_PROTOCOL_RETRY_MS = 2_000;

interface JobLiveContextValue {
  status: JobStatus;
  connection: StreamConnectionState;
  events: readonly JobEvent[];
  commands: readonly LiveCommand[];
  usage: LiveAgentUsage;
  lastEventId: number | null;
  timelineMotion: TimelineMotion;
  requestCommandDetails: (commandId: number) => void;
  retryCommandDetails: (commandId: number) => void;
}

const JobLiveContext = createContext<JobLiveContextValue | null>(null);

interface JobLiveProviderProps {
  jobId: string;
  initialStatus: JobStatus;
  initialEvents: readonly SerializedJobEvent[];
  initialCommandSummaries: readonly SerializedJobCommandSummary[];
  initialUsage: InitialAgentUsage;
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
  initialUsage,
  children,
}: JobLiveProviderProps) {
  const initialUsageEvents = useMemo(
    () => initialEvents.map(parseSerializedJobEvent),
    [initialEvents],
  );
  const initialUsageRef = useRef<InitialAgentUsage | null>(null);
  const initialUsageEventsRef = useRef<readonly JobEvent[] | null>(null);
  initialUsageRef.current ??= initialUsage;
  initialUsageEventsRef.current ??= initialUsageEvents;

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
  const mountedRef = useRef(false);
  const activeJobIdRef = useRef(jobId);
  const finishedRef = useRef(false);
  const refreshedRef = useRef(false);
  activeJobIdRef.current = jobId;

  useEffect(() => {
    if (state.lastEventId !== null && state.lastEventId > (cursorRef.current ?? -1)) {
      cursorRef.current = state.lastEventId;
    }
  }, [state.lastEventId]);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  // Keep in-flight transcript requests alive when another command changes the
  // detail map. Cancelling their callbacks here would leave them stuck loading.
  useEffect(() => {
    for (const [commandId, request] of state.commandDetailsById) {
      if (request.status !== "loading") continue;

      const requestJobId = jobId;
      const requestKey = `${requestJobId}:${String(commandId)}`;
      if (detailRequestsRef.current.has(requestKey)) continue;
      detailRequestsRef.current.add(requestKey);

      void fetch(`/api/jobs/${encodeURIComponent(requestJobId)}/commands/${String(commandId)}`)
        .then(async (response) => {
          if (!response.ok) {
            throw new Error(`Transcript request failed with status ${String(response.status)}.`);
          }
          const body: unknown = await response.json();
          return parseSerializedJobCommand(body);
        })
        .then((command) => {
          if (!mountedRef.current || activeJobIdRef.current !== requestJobId) return;
          dispatch({ type: "command.detail.received", command });
        })
        .catch((error: unknown) => {
          if (!mountedRef.current || activeJobIdRef.current !== requestJobId) return;
          const message = error instanceof Error ? error.message : "Could not load transcript.";
          dispatch({ type: "command.detail.failed", commandId, error: message });
        })
        .finally(() => {
          detailRequestsRef.current.delete(requestKey);
        });
    }
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
  const reduceMotion = useReducedMotion() === true;
  const timelineMotion = useMemo(
    () => selectTimelineMotion(state, { reduceMotion }),
    [reduceMotion, state],
  );
  const usage = useMemo(
    () =>
      deriveLiveAgentUsage(
        initialUsageRef.current ?? initialUsage,
        initialUsageEventsRef.current ?? [],
        events,
      ),
    [events, initialUsage],
  );
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
      usage,
      lastEventId: state.lastEventId,
      timelineMotion,
      requestCommandDetails,
      retryCommandDetails,
    }),
    [
      commands,
      events,
      requestCommandDetails,
      retryCommandDetails,
      state.connection,
      usage,
      state.lastEventId,
      state.status,
      timelineMotion,
    ],
  );

  return <JobLiveContext.Provider value={value}>{children}</JobLiveContext.Provider>;
}

export function useJobLive(): JobLiveContextValue {
  const context = useContext(JobLiveContext);
  if (!context) throw new Error("useJobLive must be used inside JobLiveProvider.");
  return context;
}
