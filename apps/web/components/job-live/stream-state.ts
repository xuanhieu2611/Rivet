import { jobStatusSchema, type JobEvent, type JobStatus } from "@rivet/contracts";

export type StreamConnectionState = "connecting" | "live" | "reconnecting" | "finished";

export interface JobLiveState {
  status: JobStatus;
  connection: StreamConnectionState;
  eventsById: ReadonlyMap<number, JobEvent>;
  lastEventId: number | null;
}

export type JobLiveAction =
  | { type: "event.received"; event: JobEvent }
  | { type: "connection.changed"; connection: StreamConnectionState }
  | { type: "stream.finished"; cursor: number | null; status: JobStatus };

export interface StreamEndPayload {
  cursor: number | null;
  status: JobStatus;
}

/** Builds the initial reducer state from the server-rendered event backlog. */
export function createJobLiveState(
  initialStatus: JobStatus,
  initialEvents: readonly JobEvent[],
): JobLiveState {
  const eventsById = new Map<number, JobEvent>();
  let status = initialStatus;
  let lastEventId: number | null = null;

  for (const event of [...initialEvents].sort((left, right) => left.id - right.id)) {
    if (eventsById.has(event.id)) continue;

    eventsById.set(event.id, event);
    if (lastEventId === null || event.id > lastEventId) {
      lastEventId = event.id;
      if (event.data?.to !== undefined) status = event.data.to;
    }
  }

  return {
    status,
    connection: "connecting",
    eventsById,
    lastEventId,
  };
}

/** Reduces durable events idempotently across initial render and reconnects. */
export function jobLiveReducer(state: JobLiveState, action: JobLiveAction): JobLiveState {
  switch (action.type) {
    case "event.received": {
      if (state.eventsById.has(action.event.id)) return state;

      const eventsById = new Map(state.eventsById);
      eventsById.set(action.event.id, action.event);

      const isNewer = state.lastEventId === null || action.event.id > state.lastEventId;
      return {
        ...state,
        status:
          isNewer && action.event.data?.to !== undefined ? action.event.data.to : state.status,
        eventsById,
        lastEventId: isNewer ? action.event.id : state.lastEventId,
      };
    }

    case "connection.changed":
      return state.connection === action.connection
        ? state
        : { ...state, connection: action.connection };

    case "stream.finished": {
      const isNewer =
        state.lastEventId === null || (action.cursor !== null && action.cursor > state.lastEventId);
      return {
        ...state,
        connection: "finished",
        status: action.status,
        lastEventId: isNewer ? action.cursor : state.lastEventId,
      };
    }
  }
}

/** Returns the complete event log in durable id order. */
export function selectJobLiveEvents(state: JobLiveState): JobEvent[] {
  return [...state.eventsById.values()].sort((left, right) => left.id - right.id);
}

/** Builds the stream URL while keeping the cursor in the query for new connections. */
export function jobEventsUrl(jobId: string, cursor: number | null): string {
  const url = `/api/jobs/${encodeURIComponent(jobId)}/events`;
  return cursor === null ? url : `${url}?after=${String(cursor)}`;
}

/** Validates the non-persisted terminal frame sent by the SSE route. */
export function parseStreamEnd(value: unknown): StreamEndPayload {
  if (!isRecord(value)) throw new Error("Invalid stream.end payload.");

  const status = jobStatusSchema.safeParse(value.status);
  if (!status.success) throw new Error("Invalid stream.end status.");

  const cursor = value.cursor;
  if (
    cursor !== null &&
    (typeof cursor !== "number" || !Number.isSafeInteger(cursor) || cursor < 0)
  ) {
    throw new Error("Invalid stream.end cursor.");
  }

  return { cursor, status: status.data };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
