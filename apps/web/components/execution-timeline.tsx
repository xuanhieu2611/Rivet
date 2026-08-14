import type { JobEvent, ValidationOutcome } from "@rivet/contracts";
import type { ReactNode } from "react";

import { commandAnchorId } from "@/components/job-live/command-anchor";
import { JOB_EVENT_TONE, statusLabel } from "@/lib/job-status";
import { formatAgentCost, formatTimeOfDay, formatTokenCount } from "@/lib/format";
import { cn } from "@/lib/utils";

interface AgentToolTimelineItem {
  kind: "agent-tool";
  started: JobEvent;
  completed: JobEvent | null;
}

type TimelineItem = { kind: "event"; event: JobEvent } | AgentToolTimelineItem;

const VALIDATION_PRESENTATION: Record<
  ValidationOutcome,
  { label: string; className: string; tone: string }
> = {
  verified: {
    label: "Verified",
    className: "text-emerald-700 dark:text-emerald-300",
    tone: "bg-emerald-500",
  },
  fixed: {
    label: "Fixed",
    className: "text-emerald-700 dark:text-emerald-300",
    tone: "bg-emerald-500",
  },
  regressed: {
    label: "Regressed",
    className: "text-red-700 dark:text-red-300",
    tone: "bg-red-500",
  },
  unresolved: {
    label: "Unresolved",
    className: "text-red-700 dark:text-red-300",
    tone: "bg-red-500",
  },
  unverified: {
    label: "Unverified",
    className: "text-amber-700 dark:text-amber-300",
    tone: "bg-amber-500",
  },
};

/**
 * The job's own history, straight out of `job_events`.
 *
 * The event log is written transactionally with each status change, so this
 * list is the database's account of the run rather than a client-side
 * reconstruction of it. The same presentation renders the server snapshot and
 * the live reducer's incrementally appended events.
 *
 * Events arrive oldest-first and are rendered that way. A run reads downwards.
 */
export function ExecutionTimeline({ events }: { events: readonly JobEvent[] }) {
  if (events.length === 0) {
    return (
      <p className="text-muted-foreground text-sm">
        Nothing has happened yet. The first entry appears as soon as a worker claims the job.
      </p>
    );
  }

  const items = buildTimelineItems(events);

  return (
    <ol className="relative space-y-4">
      {/* The rail behind the markers. Inset top and bottom so it starts and ends
          at the first and last dot rather than floating past them. */}
      <span aria-hidden className="bg-border absolute top-2 bottom-2 left-[3.5px] w-px" />

      {items.map((item) =>
        item.kind === "agent-tool" ? (
          <AgentToolRow key={item.started.id} item={item} />
        ) : (
          <TimelineEventRow key={item.event.id} event={item.event} />
        ),
      )}
    </ol>
  );
}

function buildTimelineItems(events: readonly JobEvent[]): TimelineItem[] {
  const items: TimelineItem[] = [];
  const tools = new Map<string, AgentToolTimelineItem>();

  for (const event of events) {
    if (event.type === "agent.tool_started") {
      const item: AgentToolTimelineItem = { kind: "agent-tool", started: event, completed: null };
      items.push(item);
      tools.set(toolKey(event), item);
      continue;
    }

    if (event.type === "agent.tool_completed") {
      const item = tools.get(toolKey(event));
      if (item) {
        item.completed = event;
        continue;
      }
    }

    items.push({ kind: "event", event });
  }

  return items;
}

function TimelineEventRow({ event }: { event: JobEvent }) {
  const detail = describeEventData(event);

  return (
    <TimelineRow event={event} tone={timelineTone(event)}>
      <EventContent event={event} />
      {detail ? <p className="text-muted-foreground text-xs">{detail}</p> : null}
    </TimelineRow>
  );
}

function AgentToolRow({ item }: { item: AgentToolTimelineItem }) {
  const startedData = item.started.data;
  const completedData = item.completed?.data;
  const toolName = completedData?.toolName ?? startedData?.toolName ?? "tool";
  const commandExecutionId =
    completedData?.commandExecutionId ?? startedData?.commandExecutionId ?? null;
  const failed = completedData?.toolError === true;
  const status = item.completed === null ? "running" : failed ? "failed" : "done";
  const duration = completedData?.durationMs;

  return (
    <TimelineRow
      event={item.started}
      tone={failed ? "bg-red-500" : JOB_EVENT_TONE["agent.tool_started"]}
    >
      <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1 text-sm">
        <span className="text-foreground font-medium">{toolName}</span>
        <code className="text-muted-foreground min-w-0 break-all font-mono text-xs">
          {toolArguments(item.started.message, toolName)}
        </code>
        <span
          className={cn(
            "text-xs",
            status === "failed"
              ? "text-destructive"
              : status === "running"
                ? "text-sky-600 dark:text-sky-400"
                : "text-muted-foreground",
          )}
        >
          {status}
        </span>
      </div>
      {failed ? (
        <p className="text-destructive text-xs break-words">
          {item.completed?.message ?? "Tool execution failed."}
        </p>
      ) : null}
      {commandExecutionId || duration !== undefined ? (
        <div className="text-muted-foreground flex flex-wrap items-center gap-x-2 gap-y-1 text-xs">
          {duration !== undefined ? <span>{formatDuration(duration)}</span> : null}
          {commandExecutionId ? (
            <a
              href={`#${commandAnchorId(commandExecutionId)}`}
              className="text-sky-700 underline-offset-2 hover:underline dark:text-sky-300"
            >
              View command transcript
            </a>
          ) : null}
        </div>
      ) : null}
    </TimelineRow>
  );
}

function TimelineRow({
  event,
  tone,
  children,
}: {
  event: JobEvent;
  tone: string;
  children: ReactNode;
}) {
  return (
    <li
      className="relative grid grid-cols-[auto_1fr_auto] items-start gap-3"
      data-event-id={String(event.id)}
      data-event-type={event.type}
    >
      <span aria-hidden className={cn("mt-1.5 size-2 shrink-0 rounded-full", tone)} />
      <div className="min-w-0 space-y-1">{children}</div>
      <time
        dateTime={event.createdAt.toISOString()}
        className="text-muted-foreground shrink-0 font-mono text-xs"
      >
        {formatTimeOfDay(event.createdAt)}
      </time>
    </li>
  );
}

function EventContent({ event }: { event: JobEvent }): ReactNode {
  switch (event.type) {
    case "agent.message":
      return (
        <details className="group rounded-md border border-border/60 bg-muted/20">
          <summary className="flex cursor-pointer list-none items-center gap-2 px-2.5 py-2 text-sm [&::-webkit-details-marker]:hidden">
            <span className="text-foreground shrink-0 font-medium">Assistant</span>
            <span className="text-muted-foreground min-w-0 flex-1 truncate">
              {singleLinePreview(event.message)}
            </span>
            <span
              aria-hidden
              className="text-muted-foreground shrink-0 transition-transform group-open:rotate-180"
            >
              ▾
            </span>
          </summary>
          <div className="border-border/60 max-h-96 overflow-auto border-t px-2.5 py-2 text-sm leading-relaxed whitespace-pre-wrap break-words">
            {event.message}
          </div>
        </details>
      );

    case "agent.usage":
      return <UsageContent event={event} />;

    case "agent.turn_started":
      return (
        <p className="text-muted-foreground text-xs">
          <span className="text-foreground mr-2 font-medium">
            Turn {displayTurn(event.data?.turn)}
          </span>
          Model turn started.
        </p>
      );

    case "plan.deferred":
      return (
        <div className="space-y-1">
          <p className="text-sm leading-snug">{event.message}</p>
          <p className="text-muted-foreground text-xs">
            Planning is intentionally deferred until a later milestone.
          </p>
        </div>
      );

    case "artifact.recorded":
      return <ArtifactEventContent event={event} />;

    case "validation.recorded":
      return <ValidationEventContent event={event} />;

    default:
      return <p className="text-sm leading-snug">{event.message}</p>;
  }
}

function ArtifactEventContent({ event }: { event: JobEvent }) {
  const artifactType = event.data?.artifactType?.replace(/_/g, " ") ?? "artifact";
  const byteSize = event.data?.byteSize;
  const artifactId = event.data?.artifactId;

  return (
    <div className="space-y-1">
      <p className="text-sm leading-snug">{event.message}</p>
      <div className="text-muted-foreground flex flex-wrap items-center gap-x-2 gap-y-1 text-xs">
        <span className="capitalize">{artifactType}</span>
        {byteSize !== undefined ? <span>{formatBytes(byteSize)}</span> : null}
        {event.data?.truncated ? (
          <span className="text-amber-700 dark:text-amber-300">truncated</span>
        ) : null}
        {artifactId !== undefined ? (
          <a
            href="#artifacts"
            className="text-sky-700 underline-offset-2 hover:underline dark:text-sky-300"
          >
            View artifacts
          </a>
        ) : null}
      </div>
    </div>
  );
}

function ValidationEventContent({ event }: { event: JobEvent }) {
  const outcome = event.data?.validation;
  const presentation = outcome ? VALIDATION_PRESENTATION[outcome] : null;
  const filesChanged = event.data?.filesChanged;
  const insertions = event.data?.insertions;
  const deletions = event.data?.deletions;
  const hasStats =
    filesChanged !== undefined && insertions !== undefined && deletions !== undefined;

  return (
    <div className="space-y-1">
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
        {presentation ? (
          <span className={`text-sm font-medium ${presentation.className}`}>
            {presentation.label}
          </span>
        ) : null}
        <p className="text-sm leading-snug">{event.message}</p>
      </div>
      {hasStats ? (
        <p className="text-muted-foreground text-xs">
          {String(filesChanged)} {filesChanged === 1 ? "file" : "files"} changed, +
          {String(insertions)}/-{String(deletions)}
        </p>
      ) : null}
    </div>
  );
}

function UsageContent({ event }: { event: JobEvent }) {
  const inputTokens = event.data?.inputTokens;
  const outputTokens = event.data?.outputTokens;
  const cost = event.data?.costUsd;

  if (inputTokens === undefined || outputTokens === undefined) {
    return <p className="text-muted-foreground text-xs">{event.message}</p>;
  }

  const costLabel =
    cost === null
      ? "unpriced"
      : typeof cost === "number" && Number.isFinite(cost)
        ? formatAgentCost(String(cost))
        : null;

  return (
    <p className="text-muted-foreground flex flex-wrap items-center gap-x-2 gap-y-1 text-xs">
      <span className="text-foreground font-medium">Usage</span>
      <span>{formatTokenCount(inputTokens)} in</span>
      <span aria-hidden>·</span>
      <span>{formatTokenCount(outputTokens)} out</span>
      {costLabel ? (
        <>
          <span aria-hidden>·</span>
          <span>{costLabel}</span>
        </>
      ) : null}
      {event.data?.turn !== undefined ? (
        <>
          <span aria-hidden>·</span>
          <span>turn {displayTurn(event.data.turn)}</span>
        </>
      ) : null}
    </p>
  );
}

/**
 * The structured half of an event, as one supporting line.
 *
 * Only the parts a reader cannot infer from the message. A phase event already
 * says which phase it was, so its `phase` field adds nothing; its duration and
 * the statuses either side of a transition do.
 */
function describeEventData(event: JobEvent): string | null {
  const data = event.data;
  if (!data || event.type === "agent.message" || event.type === "agent.usage") return null;
  if (
    event.type === "agent.turn_started" ||
    event.type === "agent.tool_started" ||
    event.type === "plan.deferred" ||
    event.type === "artifact.recorded" ||
    event.type === "validation.recorded"
  ) {
    return null;
  }

  const parts: string[] = [];

  if (data.from && data.to) {
    parts.push(`${statusLabel(data.from)} -> ${statusLabel(data.to)}`);
  }
  if (data.durationMs !== undefined && event.type !== "agent.tool_completed") {
    parts.push(formatDuration(data.durationMs));
  }
  if (data.attempt !== undefined) {
    parts.push(`attempt ${String(data.attempt)}`);
  }
  if (data.leaseOwner) {
    parts.push(data.leaseOwner);
  }
  if (event.type === "agent.session_started") {
    if (data.provider && data.model) parts.push(`${data.provider} / ${data.model}`);
    if (data.toolNames && data.toolNames.length > 0) {
      parts.push(`tools: ${data.toolNames.join(", ")}`);
    }
  }
  if (event.type === "agent.session_ended") {
    if (data.stopReason) parts.push(data.stopReason);
    if (data.turns !== undefined) parts.push(`${String(data.turns)} turns`);
    if (data.inputTokens !== undefined && data.outputTokens !== undefined) {
      parts.push(
        `${formatTokenCount(data.inputTokens)} in / ${formatTokenCount(data.outputTokens)} out`,
      );
    }
    if (data.costUsd === null) parts.push("unpriced");
    else if (typeof data.costUsd === "number" && Number.isFinite(data.costUsd)) {
      parts.push(formatAgentCost(String(data.costUsd)));
    }
  }
  if (event.type === "agent.budget_exceeded" && data.budget) {
    const value = data.budgetValue === undefined ? "?" : String(data.budgetValue);
    const limit = data.budgetLimit === undefined ? "?" : String(data.budgetLimit);
    parts.push(`${data.budget}: ${value} / ${limit}`);
  }
  if (data.error) {
    // The error text last, and never truncated: when a run went wrong this is
    // the line the reader came for.
    parts.push(data.error);
  }

  return parts.length > 0 ? parts.join(" · ") : null;
}

function toolKey(event: JobEvent): string {
  return event.data?.toolCallId ?? `event-${String(event.id)}`;
}

function toolArguments(message: string, toolName: string): string {
  const prefix = `${toolName} `;
  const raw = message.startsWith(prefix) ? message.slice(prefix.length) : message;
  return singleLinePreview(raw) || "(no arguments)";
}

function singleLinePreview(value: string): string {
  const flattened = value.replace(/\s+/g, " ").trim();
  return flattened.length > 240 ? `${flattened.slice(0, 237)}…` : flattened;
}

function displayTurn(turn: number | undefined): string {
  return turn === undefined ? "?" : String(turn + 1);
}

function formatDuration(milliseconds: number): string {
  if (milliseconds < 1_000) return `${String(Math.max(0, Math.round(milliseconds)))}ms`;
  return `${(milliseconds / 1_000).toFixed(milliseconds >= 10_000 ? 0 : 1)}s`;
}

function timelineTone(event: JobEvent): string {
  if (event.type !== "validation.recorded") return JOB_EVENT_TONE[event.type];
  const outcome = event.data?.validation;
  return outcome ? VALIDATION_PRESENTATION[outcome].tone : JOB_EVENT_TONE[event.type];
}

function formatBytes(bytes: number): string {
  if (bytes < 1_024) return `${String(bytes)} B`;
  if (bytes < 1_024 * 1_024) return `${(bytes / 1_024).toFixed(bytes < 10_240 ? 1 : 0)} KB`;
  return `${(bytes / (1_024 * 1_024)).toFixed(bytes < 10 * 1_024 * 1_024 ? 1 : 0)} MB`;
}
