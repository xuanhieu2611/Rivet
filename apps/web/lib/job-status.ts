import type { FailureCategory, JobEventType, JobStatus } from "@rivet/contracts";
import {
  ArrowRight,
  Ban,
  Bot,
  Camera,
  Check,
  CircleAlert,
  CircleCheck,
  CircleSlash,
  CircleX,
  ClipboardList,
  Clock,
  Code,
  Coins,
  Container,
  Cpu,
  Eye,
  EyeOff,
  FilePlus2,
  FileText,
  FlaskConical,
  Gauge,
  GitBranch,
  GitCommitHorizontal,
  GitFork,
  GitPullRequest,
  GitCompare,
  GitCompareArrows,
  GitPullRequestArrow,
  History,
  Inbox,
  Link2,
  ListChecks,
  MessageSquare,
  Microscope,
  OctagonAlert,
  Package,
  PenLine,
  Play,
  Receipt,
  Repeat,
  RotateCcw,
  ScrollText,
  ShieldAlert,
  SkipForward,
  SquareTerminal,
  Terminal,
  Trash2,
  TriangleAlert,
  Unplug,
  Upload,
  Wrench,
  type LucideIcon,
} from "lucide-react";

/**
 * Presentation metadata for the job lifecycle.
 *
 * Deliberately free of any database or Next.js import: server components, the
 * client-side dev control and the unit tests all read the same table, and it can
 * be bundled for the browser without dragging `pg` along.
 *
 * The `Record<JobStatus, ...>` type is the enforcement mechanism - adding a
 * fifteenth status to the contract breaks `pnpm typecheck` here until it has a
 * label, a tone and an icon.
 */

/**
 * What a badge is asking the reader to conclude.
 *
 * Three readings, plus the absence of one. The palette used to spread fourteen
 * statuses over teal, sky, emerald, red, amber and orange, and at the twenty
 * pixels a badge actually occupies the first three were the same colour - so
 * the hue carried a phase distinction nobody could see and no reader had a
 * model for. Phase is now carried by the label, by the icon and by the stepper,
 * all three of which say it in words or in shape rather than in a shade of
 * blue-green.
 */
export type StatusTone =
  /** Nothing is happening and nothing went wrong: queued, or cancelled. */
  | "idle"
  /** Working. The one accent, plus motion. */
  | "progress"
  /** It worked. */
  | "success"
  /** It did not work, whatever the reason. */
  | "attention";

/**
 * The surface for each tone.
 *
 * `progress` reads as the product's own accent rather than as a fourth hue,
 * because a running job is the thing the page is about. `attention` covers
 * `failed`, `budget_exceeded` and `timed_out` alike: they differ in cause, not
 * in what the reader should do about them, and the label already says which.
 */
export const STATUS_TONE_CLASSNAME: Record<StatusTone, string> = {
  idle: "border-border bg-muted text-muted-foreground",
  progress: "border-primary/30 bg-primary/10 text-primary",
  success: "border-emerald-500/25 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300",
  attention: "border-destructive/30 bg-destructive/10 text-destructive",
};

export interface StatusPresentation {
  /** Human-readable label shown in the badge. */
  label: string;
  /** Which of the three readings this status is. */
  tone: StatusTone;
  /** One glyph, always paired with the label and never the only affordance. */
  icon: LucideIcon;
  /** Tailwind classes for the badge surface, derived from the tone. */
  className: string;
}

function presentation(label: string, tone: StatusTone, icon: LucideIcon): StatusPresentation {
  return { label, tone, icon, className: STATUS_TONE_CLASSNAME[tone] };
}

export const JOB_STATUS_PRESENTATION: Record<JobStatus, StatusPresentation> = {
  queued: presentation("Queued", "idle", Clock),
  provisioning: presentation("Provisioning", "progress", Container),
  analyzing: presentation("Analyzing", "progress", Microscope),
  planning: presentation("Planning", "progress", ListChecks),
  implementing: presentation("Implementing", "progress", Code),
  testing: presentation("Testing", "progress", FlaskConical),
  // An eye, because the reviewer's read-only-ness is a capability boundary
  // rather than a convention: it holds `list_files`, `read`, `search_text` and
  // `submit_review`, and nothing that writes.
  reviewing: presentation("Reviewing", "progress", Eye),
  revising: presentation("Revising", "progress", RotateCcw),
  finalizing: presentation("Finalizing", "progress", GitPullRequest),
  completed: presentation("Completed", "success", CircleCheck),
  failed: presentation("Failed", "attention", CircleX),
  cancelled: presentation("Cancelled", "idle", Ban),
  budget_exceeded: presentation("Budget exceeded", "attention", CircleAlert),
  timed_out: presentation("Timed out", "attention", CircleAlert),
};

/** Whether a status should render with motion. */
export function isProgressStatus(status: JobStatus): boolean {
  return JOB_STATUS_PRESENTATION[status].tone === "progress";
}

export function statusLabel(status: JobStatus): string {
  return JOB_STATUS_PRESENTATION[status].label;
}

/**
 * The failure taxonomy, in words rather than in column values.
 *
 * `failure_category` is a `text` column read back through
 * `parseFailureCategory`, so anything unrecognised has already degraded to
 * `unknown` before it reaches here and this record is total by construction.
 */
export const FAILURE_CATEGORY_LABELS: Record<FailureCategory, string> = {
  worker_crash: "Worker crash",
  lease_expired: "Lease expired",
  timed_out: "Timed out",
  budget_exceeded: "Budget exceeded",
  cancelled: "Cancelled",
  sandbox_unavailable: "Sandbox unavailable",
  sandbox_create_failed: "Sandbox could not start",
  repo_unavailable: "Repository unavailable",
  unsupported_project: "Unsupported project",
  dependency_install_failed: "Dependency install failed",
  command_timed_out: "Command timed out",
  oom_killed: "Out of memory",
  sandbox_leaked: "Sandbox leaked",
  agent_unavailable: "Agent provider unavailable",
  agent_failed: "Agent failed",
  no_changes_produced: "No changes produced",
  validation_failed: "Validation failed",
  validation_config_invalid: "Validation configuration invalid",
  plan_not_produced: "Plan not produced",
  checkpoint_corrupt: "Checkpoint corrupt",
  checkpoint_restore_failed: "Checkpoint restore failed",
  checkpoint_too_large: "Checkpoint too large",
  review_not_produced: "Review not produced",
  reviewer_rejection: "Rejected by review",
  github_unavailable: "GitHub unavailable",
  github_permission_denied: "GitHub permission denied",
  push_rejected: "Push rejected",
  pull_request_failed: "Pull request failed",
  github_not_installed: "GitHub App not installed",
  unknown: "Unknown",
};

/**
 * Marker colour and glyph for each kind of timeline entry.
 *
 * Same enforcement mechanism as the status table above, for the same reason:
 * `JOB_EVENT_TYPES` grows every milestone, and a total `Record` means a new
 * event type breaks `pnpm typecheck` here until someone has decided how it
 * should read. The grouping is by what the reader needs to notice - an ending,
 * something going wrong, something being retried, or ordinary progress - not by
 * which subsystem emitted it.
 *
 * The glyph is what makes a two-hundred-row log scannable: colour says whether
 * to stop, and the icon says what happened, which is a distinction eight
 * shades of blue-green were never going to carry. Teal and sky collapsed into
 * the one accent here for the same reason they collapsed in the status badge -
 * at marker size they were the same colour, so the difference between them was
 * information nobody could read.
 */
export interface EventMarker {
  /** One glyph, in the marker column. Never the only signal - the row says it in words too. */
  icon: LucideIcon;
  /** The dot surface, for the collapsed command-group rows that still use one. */
  dot: string;
  /** The glyph colour. A literal, because Tailwind scans source rather than runtime strings. */
  text: string;
}

function marker(icon: LucideIcon, dot: string, text: string): EventMarker {
  return { icon, dot, text };
}

export const JOB_EVENT_MARKER: Record<JobEventType, EventMarker> = {
  "job.created": marker(FilePlus2, "bg-muted-foreground/40", "text-muted-foreground/60"),
  "job.enqueued": marker(Inbox, "bg-muted-foreground/40", "text-muted-foreground/60"),
  "job.enqueue_failed": marker(TriangleAlert, "bg-amber-500", "text-amber-600 dark:text-amber-400"),
  "job.claimed": marker(Cpu, "bg-progress", "text-progress"),
  "job.status_changed": marker(ArrowRight, "bg-progress", "text-progress"),
  "phase.started": marker(Play, "bg-progress", "text-progress"),
  "phase.completed": marker(Check, "bg-progress/40", "text-progress/70"),
  "job.cancel_requested": marker(Ban, "bg-amber-500", "text-amber-600 dark:text-amber-400"),
  "job.retry_scheduled": marker(RotateCcw, "bg-amber-500", "text-amber-600 dark:text-amber-400"),
  "job.reclaimed": marker(Repeat, "bg-amber-500", "text-amber-600 dark:text-amber-400"),
  "job.lease_lost": marker(Unplug, "bg-amber-500", "text-amber-600 dark:text-amber-400"),
  "job.failed": marker(CircleX, "bg-red-500", "text-destructive"),
  "job.completed": marker(CircleCheck, "bg-emerald-500", "text-emerald-600 dark:text-emerald-400"),
  "sandbox.created": marker(Container, "bg-progress", "text-progress"),
  "sandbox.destroyed": marker(Trash2, "bg-muted-foreground/40", "text-muted-foreground/60"),
  "sandbox.resources_recorded": marker(Gauge, "bg-progress", "text-progress"),
  "repo.cloned": marker(GitFork, "bg-progress", "text-progress"),
  "deps.installed": marker(Package, "bg-progress", "text-progress"),
  "command.started": marker(Terminal, "bg-progress", "text-progress"),
  "command.completed": marker(Terminal, "bg-progress/40", "text-progress/70"),
  "command.failed": marker(SquareTerminal, "bg-red-500", "text-destructive"),
  "baseline.check_recorded": marker(ClipboardList, "bg-progress/40", "text-progress/70"),
  "baseline.recorded": marker(ClipboardList, "bg-progress", "text-progress"),
  // The agent's own entries read as progress, because that is what they are.
  // Only the two that end something get a colour of their own, and a tool call
  // that errored is deliberately not one of them: the model reads the error and
  // tries something else, which is the loop working rather than failing.
  "agent.session_started": marker(Bot, "bg-progress", "text-progress"),
  "agent.turn_started": marker(MessageSquare, "bg-progress/40", "text-progress/70"),
  "agent.turn_completed": marker(MessageSquare, "bg-progress/40", "text-progress/70"),
  "agent.message": marker(MessageSquare, "bg-progress", "text-progress"),
  "agent.tool_started": marker(Wrench, "bg-progress", "text-progress"),
  "agent.tool_completed": marker(Wrench, "bg-progress/40", "text-progress/70"),
  "agent.usage": marker(Coins, "bg-muted-foreground/40", "text-muted-foreground/60"),
  "agent.session_ended": marker(Bot, "bg-muted-foreground/40", "text-muted-foreground/60"),
  "agent.budget_exceeded": marker(
    CircleAlert,
    "bg-amber-500",
    "text-amber-600 dark:text-amber-400",
  ),
  // A deferred plan is deliberately quiet: it says a phase decided to do
  // nothing, which is the opposite of something the reader needs to notice.
  "plan.deferred": marker(SkipForward, "bg-muted-foreground/40", "text-muted-foreground/60"),
  "artifact.recorded": marker(FileText, "bg-progress", "text-progress"),
  // A comparison glyph rather than a tick, for the same reason the colour is
  // neutral: `verified` and `regressed` are the same event type, and an icon
  // that said "passed" would be wrong half the time.
  "validation.check_recorded": marker(GitCompare, "bg-progress/40", "text-progress/70"),
  // Neutral rather than green or red, because the outcome is in the payload:
  // `regressed` and `fixed` are the same event type. Stage 7 colours the row
  // by `data.validation`; the marker only says the comparison happened.
  "validation.recorded": marker(GitCompareArrows, "bg-progress", "text-progress"),
  // The closing line, and the only entry a reader who scrolled to the bottom
  // needs. The accent rather than green, for the same reason
  // `validation.recorded` is not green: this row states an outcome, and
  // `job.completed` is the one that says the outcome was a good one.
  "run.summarized": marker(ScrollText, "bg-progress", "text-progress"),
  "plan.recorded": marker(ListChecks, "bg-progress", "text-progress"),
  "checkpoint.created": marker(Camera, "bg-progress", "text-progress"),
  "checkpoint.restored": marker(
    History,
    "bg-emerald-500",
    "text-emerald-600 dark:text-emerald-400",
  ),
  "checkpoint.rejected": marker(CircleX, "bg-red-500", "text-destructive"),
  "run.resumed": marker(Play, "bg-amber-500", "text-amber-600 dark:text-amber-400"),
  // Neutral for the same reason `validation.recorded` is neutral: `approve` and
  // `revise` are the same event type and the verdict is in the payload.
  "review.recorded": marker(Eye, "bg-progress", "text-progress"),
  // The row that makes a looping timeline readable. Amber because it is the
  // marker that explains why a second `testing` block follows a first one.
  "review.revision_requested": marker(
    PenLine,
    "bg-amber-500",
    "text-amber-600 dark:text-amber-400",
  ),
  "review.limit_reached": marker(OctagonAlert, "bg-red-500", "text-destructive"),
  // A run that asked for no review is not a run whose reviewer said nothing,
  // and the timeline should be quiet about the difference rather than loud.
  "review.skipped": marker(EyeOff, "bg-muted-foreground/40", "text-muted-foreground/60"),
  // Publication events are progress markers; their payload carries the
  // branch, receipt, or pull request details shown by the M9 timeline work.
  "github.repository_bound": marker(Link2, "bg-progress", "text-progress"),
  "branch.created": marker(GitBranch, "bg-progress", "text-progress"),
  "commit.created": marker(GitCommitHorizontal, "bg-progress", "text-progress"),
  "push.completed": marker(Upload, "bg-emerald-500", "text-emerald-600 dark:text-emerald-400"),
  "pull_request.opened": marker(
    GitPullRequest,
    "bg-emerald-500",
    "text-emerald-600 dark:text-emerald-400",
  ),
  "pull_request.adopted": marker(
    GitPullRequestArrow,
    "bg-emerald-500",
    "text-emerald-600 dark:text-emerald-400",
  ),
  "publication.skipped": marker(CircleSlash, "bg-muted-foreground/40", "text-muted-foreground/60"),
  "external_effect.recorded": marker(Receipt, "bg-progress", "text-progress"),
  "security.injection_suspected": marker(
    ShieldAlert,
    "bg-amber-500",
    "text-amber-600 dark:text-amber-400",
  ),
};

/**
 * The dot surface alone, which is what the command-group and tool rows pass
 * around when they override the marker for a failure.
 */
export const JOB_EVENT_TONE: Record<JobEventType, string> = Object.fromEntries(
  Object.entries(JOB_EVENT_MARKER).map(([type, { dot }]) => [type, dot]),
) as Record<JobEventType, string>;
