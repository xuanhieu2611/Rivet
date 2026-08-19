import {
  isTerminal,
  jobStatusSchema,
  type JobCommand,
  type JobCommandSummary,
  type JobEvent,
  type JobStatus,
} from "@rivet/contracts";

export type StreamConnectionState = "connecting" | "live" | "reconnecting" | "finished";

export type CommandRunStatus = "running" | "completed" | "failed";

/** A command attempt before it necessarily has an append-only command row. */
export interface CommandRun {
  executionId: string;
  commandId: number | null;
  argv: string[];
  cwd: string;
  /** The human-readable phase label carried by command lifecycle events. */
  phase: string;
  status: CommandRunStatus;
  exitCode: number | null;
  durationMs: number | null;
  error: string | null;
  createdAt: Date;
}

export type CommandDetailStatus = "idle" | "loading" | "loaded" | "error";

export interface CommandDetailState {
  status: CommandDetailStatus;
  error: string | null;
}

/** One row the live command log can render, with transcript state included. */
export interface LiveCommand {
  key: string;
  commandId: number | null;
  executionId: string | null;
  argv: string[];
  cwd: string;
  phase: string;
  status: CommandRunStatus;
  exitCode: number | null;
  durationMs: number | null;
  error: string | null;
  createdAt: Date;
  summary: JobCommandSummary | null;
  detail: JobCommand | null;
  detailState: CommandDetailState;
}

export interface JobLiveState {
  status: JobStatus;
  connection: StreamConnectionState;
  eventsById: ReadonlyMap<number, JobEvent>;
  lastEventId: number | null;
  /**
   * The newest durable id present when this state was created from the server
   * snapshot. Live appends above it may enter-animate; everything at or below
   * it is history, including a reconnect that redelivers those ids.
   */
  mountCursor: number | null;
  /** Status after applying the server snapshot. The first paint is not a change. */
  mountStatus: JobStatus;
  commandsById: ReadonlyMap<number, JobCommandSummary | JobCommand>;
  commandRunsByExecutionId: ReadonlyMap<string, CommandRun>;
  commandDetailsById: ReadonlyMap<number, CommandDetailState>;
}

export interface TimelineMotion {
  /** Event ids that may play an enter animation. Empty under reduced motion. */
  animateEventIds: ReadonlySet<number>;
  /** Whether the current in-progress timeline marker may pulse. */
  pulseActive: boolean;
  /** Whether the live status badge may transition after a post-mount change. */
  animateStatus: boolean;
  reduceMotion: boolean;
}

export type JobLiveAction =
  | { type: "event.received"; event: JobEvent }
  | { type: "connection.changed"; connection: StreamConnectionState }
  | { type: "stream.finished"; cursor: number | null; status: JobStatus }
  | { type: "command.detail.requested"; commandId: number }
  | { type: "command.detail.received"; command: JobCommand }
  | { type: "command.detail.failed"; commandId: number; error: string };

export interface StreamEndPayload {
  cursor: number | null;
  status: JobStatus;
}

const IDLE_COMMAND_DETAIL: CommandDetailState = { status: "idle", error: null };

const NO_ANIMATE_EVENT_IDS: ReadonlySet<number> = new Set();

const REDUCED_TIMELINE_MOTION: TimelineMotion = {
  animateEventIds: NO_ANIMATE_EVENT_IDS,
  pulseActive: false,
  animateStatus: false,
  reduceMotion: true,
};

/**
 * Builds the initial reducer state from server-rendered events and summaries.
 *
 * Initial command events never schedule transcript requests. Existing command
 * output is lazy: the user opening a row requests it, while a completion that
 * arrives over SSE requests its one transcript automatically.
 */
export function createJobLiveState(
  initialStatus: JobStatus,
  initialEvents: readonly JobEvent[],
  initialCommandSummaries: readonly JobCommandSummary[] = [],
): JobLiveState {
  const commandsById = new Map<number, JobCommandSummary | JobCommand>();
  for (const command of initialCommandSummaries) {
    if (!commandsById.has(command.id)) commandsById.set(command.id, command);
  }

  let state: JobLiveState = {
    status: initialStatus,
    connection: "connecting",
    eventsById: new Map(),
    lastEventId: null,
    mountCursor: null,
    mountStatus: initialStatus,
    commandsById,
    commandRunsByExecutionId: new Map(),
    commandDetailsById: new Map(),
  };

  for (const event of [...initialEvents].sort((left, right) => left.id - right.id)) {
    if (state.eventsById.has(event.id)) continue;
    state = applyEvent(state, event, false);
  }

  return {
    ...state,
    mountCursor: state.lastEventId,
    mountStatus: state.status,
  };
}

/**
 * Decides what may move on the live timeline and status badge.
 *
 * The mount cursor is the whole defense against reconnect and refresh
 * replay: only ids that arrived after the snapshot are eligible, and
 * `prefers-reduced-motion` clears the budget entirely.
 */
export function selectTimelineMotion(
  state: JobLiveState,
  options: { reduceMotion: boolean },
): TimelineMotion {
  if (options.reduceMotion) return REDUCED_TIMELINE_MOTION;

  const animateEventIds = new Set<number>();
  for (const id of state.eventsById.keys()) {
    if (state.mountCursor === null || id > state.mountCursor) {
      animateEventIds.add(id);
    }
  }

  return {
    animateEventIds,
    pulseActive: !isTerminal(state.status) && state.eventsById.size > 0,
    animateStatus: state.status !== state.mountStatus,
    reduceMotion: false,
  };
}

/** Reduces durable events and command lifecycle state idempotently. */
export function jobLiveReducer(state: JobLiveState, action: JobLiveAction): JobLiveState {
  switch (action.type) {
    case "event.received":
      return state.eventsById.has(action.event.id) ? state : applyEvent(state, action.event, true);

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

    case "command.detail.requested": {
      const current = state.commandDetailsById.get(action.commandId);
      if (current?.status === "loading" || current?.status === "loaded") return state;

      const commandDetailsById = new Map(state.commandDetailsById);
      commandDetailsById.set(action.commandId, { status: "loading", error: null });
      return { ...state, commandDetailsById };
    }

    case "command.detail.received": {
      const commandsById = new Map(state.commandsById);
      commandsById.set(action.command.id, action.command);

      const commandDetailsById = new Map(state.commandDetailsById);
      commandDetailsById.set(action.command.id, { status: "loaded", error: null });
      return { ...state, commandsById, commandDetailsById };
    }

    case "command.detail.failed": {
      const current = state.commandDetailsById.get(action.commandId);
      if (current?.status === "loaded") return state;

      const commandDetailsById = new Map(state.commandDetailsById);
      commandDetailsById.set(action.commandId, { status: "error", error: action.error });
      return { ...state, commandDetailsById };
    }
  }
}

/** Returns the complete event log in durable id order. */
export function selectJobLiveEvents(state: JobLiveState): JobEvent[] {
  return [...state.eventsById.values()].sort((left, right) => left.id - right.id);
}

/**
 * Merges append-only summaries with in-flight command attempts.
 *
 * A command id is intentionally not allocated until execution completes. The
 * execution id therefore owns the temporary running/failed row, and a completed
 * event links it to the durable command summary when that row exists.
 */
export function selectJobLiveCommands(state: JobLiveState): LiveCommand[] {
  const runByCommandId = new Map<number, CommandRun>();
  for (const run of state.commandRunsByExecutionId.values()) {
    if (run.commandId !== null && !runByCommandId.has(run.commandId)) {
      runByCommandId.set(run.commandId, run);
    }
  }

  const commands: LiveCommand[] = [];
  const renderedCommandIds = new Set<number>();

  for (const [commandId, entry] of state.commandsById) {
    renderedCommandIds.add(commandId);
    commands.push(
      toLiveCommand(
        runByCommandId.get(commandId),
        entry,
        state.commandDetailsById.get(commandId) ?? IDLE_COMMAND_DETAIL,
      ),
    );
  }

  for (const run of state.commandRunsByExecutionId.values()) {
    if (run.commandId !== null && renderedCommandIds.has(run.commandId)) continue;
    commands.push(
      toLiveCommand(
        run,
        run.commandId === null ? null : (state.commandsById.get(run.commandId) ?? null),
        run.commandId === null
          ? IDLE_COMMAND_DETAIL
          : (state.commandDetailsById.get(run.commandId) ?? IDLE_COMMAND_DETAIL),
      ),
    );
  }

  return commands.sort((left, right) => {
    const timeDifference = left.createdAt.getTime() - right.createdAt.getTime();
    if (timeDifference !== 0) return timeDifference;

    const leftId = left.commandId ?? Number.MAX_SAFE_INTEGER;
    const rightId = right.commandId ?? Number.MAX_SAFE_INTEGER;
    if (leftId !== rightId) return leftId - rightId;
    return left.key.localeCompare(right.key);
  });
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

function applyEvent(
  state: JobLiveState,
  event: JobEvent,
  scheduleCommandDetail: boolean,
): JobLiveState {
  const eventsById = new Map(state.eventsById);
  eventsById.set(event.id, event);

  const isNewer = state.lastEventId === null || event.id > state.lastEventId;
  let next: JobLiveState = {
    ...state,
    eventsById,
    status: isNewer && event.data?.to !== undefined ? event.data.to : state.status,
    lastEventId: isNewer ? event.id : state.lastEventId,
  };

  if (
    event.type === "command.started" ||
    event.type === "command.completed" ||
    event.type === "command.failed"
  ) {
    next = applyCommandEvent(next, event, scheduleCommandDetail);
  }

  return next;
}

function applyCommandEvent(
  state: JobLiveState,
  event: JobEvent,
  scheduleCommandDetail: boolean,
): JobLiveState {
  const data = event.data;
  const executionId = data?.commandExecutionId ?? `event-${String(event.id)}`;
  const existing = state.commandRunsByExecutionId.get(executionId);

  if (event.type === "command.started") {
    if (existing) return state;

    const commandRunsByExecutionId = new Map(state.commandRunsByExecutionId);
    commandRunsByExecutionId.set(executionId, {
      executionId,
      commandId: null,
      argv: data?.argv ? [...data.argv] : [],
      cwd: data?.cwd ?? "",
      phase: data?.phase ?? "unknown",
      status: "running",
      exitCode: null,
      durationMs: null,
      error: null,
      createdAt: event.createdAt,
    });
    return { ...state, commandRunsByExecutionId };
  }

  if (event.type === "command.failed") {
    const commandRunsByExecutionId = new Map(state.commandRunsByExecutionId);
    commandRunsByExecutionId.set(executionId, {
      executionId,
      commandId: null,
      argv: data?.argv ? [...data.argv] : (existing?.argv ?? []),
      cwd: data?.cwd ?? existing?.cwd ?? "",
      phase: data?.phase ?? existing?.phase ?? "unknown",
      status: "failed",
      exitCode: null,
      durationMs: data?.durationMs ?? existing?.durationMs ?? null,
      error: data?.error ?? "Command execution failed.",
      createdAt: existing?.createdAt ?? event.createdAt,
    });
    return { ...state, commandRunsByExecutionId };
  }

  const commandId = data?.commandId ?? existing?.commandId ?? null;
  const commandRunsByExecutionId = new Map(state.commandRunsByExecutionId);
  commandRunsByExecutionId.set(executionId, {
    executionId,
    commandId,
    argv: data?.argv ? [...data.argv] : (existing?.argv ?? []),
    cwd: data?.cwd ?? existing?.cwd ?? "",
    phase: data?.phase ?? existing?.phase ?? "unknown",
    status: "completed",
    exitCode: data?.exitCode ?? null,
    durationMs: data?.durationMs ?? null,
    error: null,
    createdAt: existing?.createdAt ?? event.createdAt,
  });

  const commandDetailsById =
    scheduleCommandDetail && commandId !== null
      ? requestCommandDetail(state.commandDetailsById, commandId)
      : state.commandDetailsById;

  return { ...state, commandRunsByExecutionId, commandDetailsById };
}

function requestCommandDetail(
  details: ReadonlyMap<number, CommandDetailState>,
  commandId: number,
): ReadonlyMap<number, CommandDetailState> {
  const current = details.get(commandId);
  if (current?.status === "loading" || current?.status === "loaded") return details;

  const next = new Map(details);
  next.set(commandId, { status: "loading", error: null });
  return next;
}

function toLiveCommand(
  run: CommandRun | undefined,
  entry: JobCommandSummary | JobCommand | null,
  detailState: CommandDetailState,
): LiveCommand {
  const detail = entry !== null && isJobCommand(entry) ? entry : null;
  const summary = entry;
  const commandId = summary?.id ?? run?.commandId ?? null;

  return {
    key: summary === null ? `run:${run?.executionId ?? "unknown"}` : `command:${summary.id}`,
    commandId,
    executionId: run?.executionId ?? null,
    argv: run?.argv ?? summary?.argv ?? [],
    cwd: run?.cwd ?? summary?.cwd ?? "",
    phase: run?.phase ?? summary?.phase ?? "unknown",
    status: run?.status ?? "completed",
    exitCode: run?.exitCode ?? summary?.exitCode ?? null,
    durationMs: run?.durationMs ?? summary?.durationMs ?? null,
    error: run?.error ?? null,
    createdAt: run?.createdAt ?? summary?.createdAt ?? new Date(0),
    summary,
    detail,
    detailState,
  };
}

function isJobCommand(value: JobCommandSummary | JobCommand): value is JobCommand {
  return "stdout" in value && "stderr" in value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
