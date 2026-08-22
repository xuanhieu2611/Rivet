"use client";

import type { JobEvent } from "@rivet/contracts";
import { motion } from "motion/react";
import type { ReactNode } from "react";

import { commandAnchorId } from "@/components/job-live/command-anchor";
import { JOB_EVENT_TONE, statusLabel } from "@/lib/job-status";
import { formatAgentCost, formatBytes, formatTimeOfDay, formatTokenCount } from "@/lib/format";
import { describePublicationEvent, isPublicationEvent } from "@/lib/publication-events";
import { describeRecoveryEvent, isRecoveryEvent } from "@/lib/recovery-events";
import { describeReviewEvent, isReviewEvent } from "@/lib/review-events";
import { cn } from "@/lib/utils";
import {
  CHECK_KIND_LABELS,
  CHECK_STATUS_LABELS,
  VALIDATION_OUTCOME_PRESENTATION,
} from "@/lib/validation-presentation";

interface AgentToolTimelineItem {
  kind: "agent-tool";
  started: JobEvent;
  completed: JobEvent | null;
}

interface CommandTimelineItem {
  kind: "command";
  started: JobEvent;
  finished: JobEvent | null;
}

interface CommandClusterTimelineItem {
  kind: "command-cluster";
  phase: string;
  commands: CommandTimelineItem[];
}

type TimelineItem =
  | { kind: "event"; event: JobEvent }
  | AgentToolTimelineItem
  | CommandTimelineItem
  | CommandClusterTimelineItem;

const TIMELINE_ENTER_TRANSITION = {
  duration: 0.2,
  ease: [0.23, 1, 0.32, 1],
} as const;

/**
 * The job's own history, straight out of `job_events`.
 *
 * The event log is written transactionally with each status change, so this
 * list is the database's account of the run rather than a client-side
 * reconstruction of it. The same presentation renders the server snapshot and
 * the live reducer's incrementally appended events.
 *
 * Events arrive oldest-first and are rendered that way. A run reads downwards.
 * Live enter animations are gated by `animateEventIds` from the mount cursor;
 * omitted, nothing moves, which is what a static render and a reconnect want.
 */
export function ExecutionTimeline({
  events,
  animateEventIds,
  pulseActive = false,
}: {
  events: readonly JobEvent[];
  animateEventIds?: ReadonlySet<number>;
  pulseActive?: boolean;
}) {
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

      {items.map((item, index) => {
        const event = timelineItemEvent(item);

        const animateEnter = animateEventIds?.has(event.id) === true;
        const pulse = pulseActive && index === items.length - 1;

        switch (item.kind) {
          case "agent-tool":
            return (
              <AgentToolRow
                key={item.started.id}
                item={item}
                animateEnter={animateEnter}
                pulse={pulse}
              />
            );
          case "command":
            return (
              <CommandRow
                key={item.started.id}
                item={item}
                animateEnter={animateEnter}
                pulse={pulse}
              />
            );
          case "command-cluster":
            return (
              <CommandClusterRow
                key={item.commands[0]?.started.id}
                item={item}
                animateEnter={animateEnter}
                pulse={pulse}
              />
            );
          case "event":
            return (
              <TimelineEventRow
                key={item.event.id}
                event={item.event}
                animateEnter={animateEnter}
                pulse={pulse}
              />
            );
        }
      })}
    </ol>
  );
}

function buildTimelineItems(events: readonly JobEvent[]): TimelineItem[] {
  const logicalItems: TimelineItem[] = [];
  const tools = new Map<string, AgentToolTimelineItem>();
  const commands = new Map<string, CommandTimelineItem>();

  for (const event of events) {
    if (event.type === "agent.tool_started") {
      const item: AgentToolTimelineItem = { kind: "agent-tool", started: event, completed: null };
      logicalItems.push(item);
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

    if (event.type === "command.started") {
      const item: CommandTimelineItem = { kind: "command", started: event, finished: null };
      logicalItems.push(item);
      commands.set(commandKey(event), item);
      continue;
    }

    if (event.type === "command.completed" || event.type === "command.failed") {
      const item = commands.get(commandKey(event));
      if (item) {
        item.finished = event;
        continue;
      }
    }

    logicalItems.push({ kind: "event", event });
  }

  return foldSuccessfulCommands(logicalItems);
}

function foldSuccessfulCommands(items: readonly TimelineItem[]): TimelineItem[] {
  const folded: TimelineItem[] = [];

  for (const item of items) {
    if (item.kind !== "command" || !isSuccessfulCommand(item)) {
      folded.push(item);
      continue;
    }

    const phase = commandPhase(item);
    const previous = folded.at(-1);
    if (previous?.kind === "command-cluster" && previous.phase === phase) {
      previous.commands.push(item);
      continue;
    }
    if (
      previous?.kind === "command" &&
      isSuccessfulCommand(previous) &&
      commandPhase(previous) === phase
    ) {
      folded[folded.length - 1] = {
        kind: "command-cluster",
        phase,
        commands: [previous, item],
      };
      continue;
    }

    folded.push(item);
  }

  return folded;
}

function CommandClusterRow({
  item,
  animateEnter,
  pulse,
}: {
  item: CommandClusterTimelineItem;
  animateEnter: boolean;
  pulse: boolean;
}) {
  const first = item.commands[0];
  if (!first) return null;

  const totalDuration = item.commands.reduce(
    (total, command) => total + (command.finished?.data?.durationMs ?? 0),
    0,
  );

  return (
    <TimelineRow
      event={first.started}
      tone={JOB_EVENT_TONE["command.completed"]}
      animateEnter={animateEnter}
      pulse={pulse}
    >
      <details
        className="group rounded-md border border-border/60 bg-muted/15"
        data-command-group-count={String(item.commands.length)}
      >
        <summary className="flex cursor-pointer list-none items-center gap-3 px-3 py-2 [&::-webkit-details-marker]:hidden">
          <div className="min-w-0 flex-1">
            <div className="flex min-w-0 flex-wrap items-baseline gap-x-2 gap-y-0.5">
              <span className="text-sm font-medium">{item.phase}</span>
              <span className="text-muted-foreground text-xs">
                {String(item.commands.length)} sandbox commands
              </span>
            </div>
            <p className="text-muted-foreground mt-0.5 text-xs">
              All succeeded · {formatDuration(totalDuration)}
            </p>
          </div>
          <span
            aria-hidden
            className="text-muted-foreground shrink-0 transition-transform group-open:rotate-180"
          >
            ▾
          </span>
        </summary>
        <ol className="divide-border/50 divide-y border-t px-3">
          {item.commands.map((command) => (
            <CommandDetail key={command.started.id} item={command} />
          ))}
        </ol>
      </details>
    </TimelineRow>
  );
}

function CommandRow({
  item,
  animateEnter,
  pulse,
}: {
  item: CommandTimelineItem;
  animateEnter: boolean;
  pulse: boolean;
}) {
  const failed = commandFailed(item);
  const running = item.finished === null;

  return (
    <TimelineRow
      event={item.started}
      tone={
        failed ? "bg-red-500" : JOB_EVENT_TONE[running ? "command.started" : "command.completed"]
      }
      animateEnter={animateEnter}
      pulse={pulse}
    >
      <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1 text-sm">
        <code className="min-w-0 break-all font-mono text-xs">{commandLabel(item)}</code>
        <span
          className={cn(
            "text-xs",
            failed
              ? "text-destructive"
              : running
                ? "text-sky-600 dark:text-sky-400"
                : "text-muted-foreground",
          )}
        >
          {commandOutcome(item)}
        </span>
        {item.finished?.data?.durationMs === undefined ? null : (
          <span className="text-muted-foreground text-xs">
            {formatDuration(item.finished.data.durationMs)}
          </span>
        )}
        <CommandTranscriptLink item={item} />
      </div>
      {failed ? (
        <p className="text-destructive text-xs break-words">
          {item.finished?.message ?? "Command execution failed."}
        </p>
      ) : null}
    </TimelineRow>
  );
}

function CommandDetail({ item }: { item: CommandTimelineItem }) {
  return (
    <li className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1 py-2 text-xs">
      <code className="min-w-0 flex-1 break-all font-mono">{commandLabel(item)}</code>
      <span className="text-muted-foreground">{commandOutcome(item)}</span>
      {item.finished?.data?.durationMs === undefined ? null : (
        <span className="text-muted-foreground font-mono tabular-nums">
          {formatDuration(item.finished.data.durationMs)}
        </span>
      )}
      <CommandTranscriptLink item={item} />
    </li>
  );
}

function CommandTranscriptLink({ item }: { item: CommandTimelineItem }) {
  const executionId = item.started.data?.commandExecutionId;
  if (!executionId || item.finished === null) return null;

  return (
    <a
      href={`#${commandAnchorId(executionId)}`}
      onClick={openCommandPanel}
      className="shrink-0 text-sky-700 underline-offset-2 hover:underline dark:text-sky-300"
    >
      Transcript
    </a>
  );
}

function TimelineEventRow({
  event,
  animateEnter,
  pulse,
}: {
  event: JobEvent;
  animateEnter: boolean;
  pulse: boolean;
}) {
  const detail = describeEventData(event);

  return (
    <TimelineRow event={event} tone={timelineTone(event)} animateEnter={animateEnter} pulse={pulse}>
      <EventContent event={event} />
      {detail ? <p className="text-muted-foreground text-xs">{detail}</p> : null}
    </TimelineRow>
  );
}

function AgentToolRow({
  item,
  animateEnter,
  pulse,
}: {
  item: AgentToolTimelineItem;
  animateEnter: boolean;
  pulse: boolean;
}) {
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
      animateEnter={animateEnter}
      pulse={pulse}
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
              onClick={openCommandPanel}
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
  animateEnter,
  pulse,
  children,
}: {
  event: JobEvent;
  tone: string;
  animateEnter: boolean;
  pulse: boolean;
  children: ReactNode;
}) {
  return (
    <motion.li
      className="relative grid grid-cols-[auto_1fr_auto] items-start gap-3"
      data-event-id={String(event.id)}
      data-event-type={event.type}
      data-animate-enter={animateEnter ? "true" : undefined}
      initial={animateEnter ? { opacity: 0, transform: "translateY(8px)" } : false}
      animate={{ opacity: 1, transform: "translateY(0px)" }}
      transition={TIMELINE_ENTER_TRANSITION}
    >
      <motion.span
        aria-hidden
        data-pulse-active={pulse ? "true" : undefined}
        className={cn("mt-1.5 size-2 shrink-0 rounded-full", tone)}
        animate={
          pulse
            ? { opacity: [1, 0.5, 1], transform: ["scale(1)", "scale(1.35)", "scale(1)"] }
            : { opacity: 1, transform: "scale(1)" }
        }
        transition={
          pulse ? { duration: 1.6, ease: "linear", repeat: Infinity } : TIMELINE_ENTER_TRANSITION
        }
      />
      <div className="min-w-0 space-y-1">{children}</div>
      <time
        dateTime={event.createdAt.toISOString()}
        className="text-muted-foreground shrink-0 font-mono text-xs"
      >
        {formatTimeOfDay(event.createdAt)}
      </time>
    </motion.li>
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

    case "sandbox.resources_recorded":
      return <ResourceEventContent event={event} />;

    case "security.injection_suspected":
      return <SecurityEventContent event={event} />;

    case "baseline.check_recorded":
    case "validation.check_recorded":
      return <CheckEventContent event={event} />;

    case "validation.recorded":
      return <ValidationEventContent event={event} />;

    case "plan.recorded":
    case "checkpoint.created":
    case "checkpoint.restored":
    case "checkpoint.rejected":
    case "run.resumed":
    case "job.reclaimed":
      return <RecoveryEventContent event={event} />;

    case "review.recorded":
    case "review.revision_requested":
    case "review.limit_reached":
    case "review.skipped":
      return <ReviewEventContent event={event} />;

    case "github.repository_bound":
    case "branch.created":
    case "commit.created":
    case "push.completed":
    case "pull_request.opened":
    case "pull_request.adopted":
    case "publication.skipped":
    case "external_effect.recorded":
      return <PublicationEventContent event={event} />;

    default:
      return <p className="text-sm leading-snug">{event.message}</p>;
  }
}

const RECOVERY_EMPHASIS_CLASS = {
  neutral: "text-foreground",
  positive: "text-emerald-700 dark:text-emerald-300",
  negative: "text-destructive",
} as const;

/**
 * A recovery entry: what happened, why it matters, and the facts behind it.
 *
 * The extra sentence is deliberate. A reader looking at a rerun job needs to
 * know that the container changed and the base commit did not, and neither of
 * those is legible from a message that says a checkpoint was restored.
 */
function RecoveryEventContent({ event }: { event: JobEvent }) {
  const presentation = describeRecoveryEvent(event);
  if (!presentation) return <p className="text-sm leading-snug">{event.message}</p>;

  return (
    <div className="space-y-1">
      <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
        <span className={cn("text-sm font-medium", RECOVERY_EMPHASIS_CLASS[presentation.emphasis])}>
          {presentation.label}
        </span>
        <p className="text-sm leading-snug">{event.message}</p>
      </div>
      <p className="text-muted-foreground text-xs leading-snug">{presentation.explanation}</p>
      {presentation.facts.length > 0 ? (
        <p className="text-muted-foreground text-xs break-words">
          {presentation.facts.join(" · ")}
        </p>
      ) : null}
      {event.data?.stderr ? (
        <pre className="text-destructive max-h-40 overflow-auto rounded-md bg-muted/40 p-2 font-mono text-xs whitespace-pre-wrap break-words">
          {event.data.stderr}
        </pre>
      ) : null}
    </div>
  );
}

const REVIEW_EMPHASIS_CLASS = {
  neutral: "text-foreground",
  positive: "text-emerald-700 dark:text-emerald-300",
  negative: "text-destructive",
} as const;

function ReviewEventContent({ event }: { event: JobEvent }) {
  const presentation = describeReviewEvent(event);
  if (!presentation) return <p className="text-sm leading-snug">{event.message}</p>;

  return (
    <div className="space-y-1">
      <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
        <span className={cn("text-sm font-medium", REVIEW_EMPHASIS_CLASS[presentation.emphasis])}>
          {presentation.label}
        </span>
        <p className="text-sm leading-snug">{event.message}</p>
      </div>
      <p className="text-muted-foreground text-xs leading-snug">{presentation.explanation}</p>
      {presentation.facts.length > 0 ? (
        <p className="text-muted-foreground text-xs break-words">
          {presentation.facts.join(" · ")}
        </p>
      ) : null}
    </div>
  );
}

const PUBLICATION_EMPHASIS_CLASS = {
  neutral: "text-foreground",
  positive: "text-emerald-700 dark:text-emerald-300",
  negative: "text-destructive",
} as const;

/**
 * A publication entry, and the one kind of timeline row that links outward.
 *
 * Everything else in the log describes something that happened inside Rivet.
 * These describe something that happened on a server Rivet does not own, so the
 * row carries the link a reader would otherwise have to reconstruct from the
 * job's repository and branch.
 */
function PublicationEventContent({ event }: { event: JobEvent }) {
  const presentation = describePublicationEvent(event);
  if (!presentation) return <p className="text-sm leading-snug">{event.message}</p>;

  return (
    <div className="space-y-1">
      <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
        <span
          className={cn("text-sm font-medium", PUBLICATION_EMPHASIS_CLASS[presentation.emphasis])}
        >
          {presentation.label}
        </span>
        <p className="text-sm leading-snug">{event.message}</p>
      </div>
      <p className="text-muted-foreground text-xs leading-snug">{presentation.explanation}</p>
      {presentation.facts.length > 0 ? (
        <p className="text-muted-foreground font-mono text-xs break-words">
          {presentation.facts.join(" · ")}
        </p>
      ) : null}
      {presentation.link ? (
        <a
          href={presentation.link.href}
          target="_blank"
          rel="noreferrer noopener"
          className="inline-block text-xs text-sky-700 underline-offset-2 hover:underline dark:text-sky-300"
        >
          {presentation.link.text}
        </a>
      ) : null}
    </div>
  );
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

function ResourceEventContent({ event }: { event: JobEvent }) {
  const data = event.data;
  const memory = data?.memoryPeakBytes;
  const memoryLimit = data?.memoryLimitBytes;
  const cpu = data?.cpuPeakPercent;
  const pids = data?.pidsPeak;
  const pidsLimit = data?.pidsLimit;
  const facts = [
    memory === undefined || memory === null
      ? null
      : `memory ${formatBytes(memory)}${memoryLimit === undefined ? "" : ` / ${formatBytes(memoryLimit)}`}`,
    cpu === undefined || cpu === null ? null : `CPU ${cpu.toFixed(1)}%`,
    pids === undefined || pids === null
      ? null
      : `pids ${String(pids)}${pidsLimit === undefined ? "" : ` / ${String(pidsLimit)}`}`,
    data?.sampleCount === undefined ? null : `${String(data.sampleCount)} samples`,
    data?.oomKilled === true ? "OOM kill detected" : null,
  ].filter((fact): fact is string => fact !== null);

  return (
    <div className="space-y-1">
      <p className="text-sm leading-snug">{event.message}</p>
      {facts.length > 0 ? (
        <p className="text-muted-foreground text-xs break-words">{facts.join(" · ")}</p>
      ) : null}
    </div>
  );
}

function SecurityEventContent({ event }: { event: JobEvent }) {
  const data = event.data;
  const classes = data?.patternClasses?.join(", ") ?? "heuristic match";
  const source = data?.source ?? "untrusted input";
  const location = data?.location;

  return (
    <div className="space-y-1">
      <p className="text-sm leading-snug">{event.message}</p>
      <p className="text-muted-foreground text-xs break-words">
        {source}
        {location ? ` at ${location}` : ""} · {classes}
      </p>
    </div>
  );
}

function ValidationEventContent({ event }: { event: JobEvent }) {
  const outcome = event.data?.validation;
  const presentation = outcome ? VALIDATION_OUTCOME_PRESENTATION[outcome] : null;
  const filesChanged = event.data?.filesChanged;
  const insertions = event.data?.insertions;
  const deletions = event.data?.deletions;
  const hasStats =
    filesChanged !== undefined && insertions !== undefined && deletions !== undefined;

  return (
    <div className="space-y-1">
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
        {presentation ? (
          <span className={`text-sm font-medium ${presentation.textClassName}`}>
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

function CheckEventContent({ event }: { event: JobEvent }) {
  const check = event.data?.check;
  const checkLabel = check ? CHECK_KIND_LABELS[check] : "Validation check";
  const outcome = event.data?.checkOutcome;
  const status = event.data?.checkStatus;
  const presentation = outcome ? VALIDATION_OUTCOME_PRESENTATION[outcome] : null;
  const resultLabel = presentation?.label ?? (status ? CHECK_STATUS_LABELS[status] : "Recorded");

  return (
    <p className="flex flex-wrap items-baseline gap-x-2 gap-y-1 text-sm leading-snug">
      <span className="font-medium">{checkLabel}</span>
      <span className={presentation?.textClassName}>{resultLabel}</span>
    </p>
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
  // A recovery row states its own facts, and in its own order. Appending the
  // generic line under it would repeat the attempt and the lease owner.
  if (isRecoveryEvent(event)) return null;
  if (
    event.type === "agent.turn_started" ||
    event.type === "agent.tool_started" ||
    event.type === "plan.deferred" ||
    event.type === "artifact.recorded" ||
    event.type === "sandbox.resources_recorded" ||
    event.type === "security.injection_suspected" ||
    event.type === "baseline.check_recorded" ||
    event.type === "validation.check_recorded" ||
    event.type === "validation.recorded" ||
    isReviewEvent(event) ||
    isPublicationEvent(event)
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

function timelineItemEvent(item: TimelineItem): JobEvent {
  switch (item.kind) {
    case "event":
      return item.event;
    case "agent-tool":
    case "command":
      return item.started;
    case "command-cluster":
      // A cluster is only constructed from at least two commands.
      return item.commands[0]!.started;
  }
}

function toolKey(event: JobEvent): string {
  return event.data?.toolCallId ?? `event-${String(event.id)}`;
}

function commandKey(event: JobEvent): string {
  return event.data?.commandExecutionId ?? `event-${String(event.id)}`;
}

function commandPhase(item: CommandTimelineItem): string {
  return item.started.data?.phase ?? item.finished?.data?.phase ?? "Sandbox";
}

function isSuccessfulCommand(item: CommandTimelineItem): boolean {
  return item.finished?.type === "command.completed" && item.finished.data?.exitCode === 0;
}

function commandFailed(item: CommandTimelineItem): boolean {
  return item.finished?.type === "command.failed" || item.finished?.data?.oomKilled === true;
}

function commandOutcome(item: CommandTimelineItem): string {
  if (item.finished === null) return "Running";
  if (item.finished.type === "command.failed") return "Failed";
  if (item.finished.data?.oomKilled === true) return "OOM killed";
  if (item.finished.data?.exitCode === null) return "Killed";
  if (item.finished.data?.exitCode === undefined) return "Finished";
  return `Exit ${String(item.finished.data.exitCode)}`;
}

function commandLabel(item: CommandTimelineItem): string {
  const argv = item.started.data?.argv ?? item.finished?.data?.argv;
  if (argv && argv.length > 0) {
    return argv
      .map((argument) => (/\s/.test(argument) ? JSON.stringify(argument) : argument))
      .join(" ");
  }
  return item.started.message.replace(/ started$/, "");
}

function openCommandPanel(): void {
  const commandPanel = document.getElementById("commands");
  if (commandPanel instanceof HTMLDetailsElement) commandPanel.open = true;
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
  if (event.type === "review.recorded") {
    if (event.data?.reviewDecision === "approve") return "bg-emerald-500";
    if (event.data?.reviewDecision === "revise") return "bg-amber-500";
  }
  if (event.type === "validation.check_recorded") {
    const outcome = event.data?.checkOutcome;
    return outcome ? VALIDATION_OUTCOME_PRESENTATION[outcome].tone : JOB_EVENT_TONE[event.type];
  }
  if (event.type !== "validation.recorded") return JOB_EVENT_TONE[event.type];
  const outcome = event.data?.validation;
  return outcome ? VALIDATION_OUTCOME_PRESENTATION[outcome].tone : JOB_EVENT_TONE[event.type];
}
