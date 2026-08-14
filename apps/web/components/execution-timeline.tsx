import type { JobEvent } from "@rivet/contracts";

import { JOB_EVENT_TONE, statusLabel } from "@/lib/job-status";
import { formatTimeOfDay } from "@/lib/format";
import { cn } from "@/lib/utils";

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

  return (
    <ol className="relative space-y-4">
      {/* The rail behind the markers. Inset top and bottom so it starts and ends
          at the first and last dot rather than floating past them. */}
      <span aria-hidden className="bg-border absolute top-2 bottom-2 left-[3.5px] w-px" />

      {events.map((event) => {
        const detail = describeEventData(event);
        return (
          <li key={event.id} className="relative grid grid-cols-[auto_1fr_auto] items-start gap-3">
            <span
              aria-hidden
              className={cn("mt-1.5 size-2 shrink-0 rounded-full", JOB_EVENT_TONE[event.type])}
            />
            <div className="min-w-0 space-y-1">
              <p className="text-sm leading-snug">{event.message}</p>
              {detail ? <p className="text-muted-foreground text-xs">{detail}</p> : null}
            </div>
            <time
              dateTime={event.createdAt.toISOString()}
              className="text-muted-foreground shrink-0 font-mono text-xs"
            >
              {formatTimeOfDay(event.createdAt)}
            </time>
          </li>
        );
      })}
    </ol>
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
  if (!data) return null;

  const parts: string[] = [];

  if (data.from && data.to) {
    parts.push(`${statusLabel(data.from)} -> ${statusLabel(data.to)}`);
  }
  if (data.durationMs !== undefined) {
    parts.push(`${(data.durationMs / 1_000).toFixed(1)}s`);
  }
  if (data.attempt !== undefined) {
    parts.push(`attempt ${String(data.attempt)}`);
  }
  if (data.leaseOwner) {
    parts.push(data.leaseOwner);
  }
  // The error text last, and never truncated: when a run went wrong this is the
  // line the reader came for.
  if (data.error) {
    parts.push(data.error);
  }

  return parts.length > 0 ? parts.join(" · ") : null;
}
