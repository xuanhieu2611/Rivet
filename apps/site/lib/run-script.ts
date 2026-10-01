/**
 * The hero console's script: a curated subset of the real booking job's event
 * log (`demo/replays/booking/events.ndjson`, captured from job 9b3056ce on
 * 2026-08-20). Every line names the `type` and `at` (milliseconds from job
 * creation) of the recorded event it stands for, and `run-script.test.ts`
 * fails if any line stops matching the fixture. The wording is shortened for
 * the page; the facts and timing are not.
 */

export const PHASES = [
  { id: "provision", label: "Provision" },
  { id: "baseline", label: "Baseline" },
  { id: "plan", label: "Plan" },
  { id: "implement", label: "Implement" },
  { id: "validate", label: "Validate" },
  { id: "review", label: "Review" },
  { id: "publish", label: "Publish" },
] as const;

export type PhaseId = (typeof PHASES)[number]["id"];

export type LineKind = "phase" | "note" | "cmd" | "agent" | "tool" | "ok" | "fail" | "pr";

export interface RunLine {
  at: number;
  type: string;
  phase: PhaseId;
  kind: LineKind;
  text: string;
}

export const RUN = {
  repo: "xuanhieu2611/rivet-demo-booking",
  issue: 1,
  title: "Prevent concurrent room double-booking",
  pullRequestUrl: "https://github.com/xuanhieu2611/rivet-demo-booking/pull/3",
  pullRequestNumber: 3,
  issueUrl: "https://github.com/xuanhieu2611/rivet-demo-booking/issues/1",
  durationMs: 452351,
  filesChanged: 6,
  additions: 147,
  deletions: 19,
  modelCalls: 24,
  costUsd: "0.0141",
  model: "DeepSeek V4 Flash",
  recordedOn: "2026-08-20",
} as const;

export const RUN_LINES: readonly RunLine[] = [
  {
    at: 0,
    type: "job.created",
    phase: "provision",
    kind: "note",
    text: "Job created from issue #1",
  },
  { at: 1397, type: "phase.started", phase: "provision", kind: "phase", text: "Provision sandbox" },
  {
    at: 3250,
    type: "sandbox.created",
    phase: "provision",
    kind: "note",
    text: "Container e7d6c8790de0 is up",
  },
  {
    at: 3298,
    type: "repo.cloned",
    phase: "provision",
    kind: "note",
    text: "Seeded the repository at main (3e925b7)",
  },
  { at: 3508, type: "command.completed", phase: "provision", kind: "cmd", text: "npm ci" },
  {
    at: 3661,
    type: "phase.started",
    phase: "baseline",
    kind: "phase",
    text: "Record the baseline",
  },
  { at: 3826, type: "command.completed", phase: "baseline", kind: "cmd", text: "npm run test" },
  {
    at: 3961,
    type: "command.completed",
    phase: "baseline",
    kind: "cmd",
    text: "npm run typecheck",
  },
  { at: 4092, type: "command.completed", phase: "baseline", kind: "cmd", text: "npm run lint" },
  {
    at: 4103,
    type: "baseline.recorded",
    phase: "baseline",
    kind: "ok",
    text: "Baseline is green before any change",
  },
  { at: 4226, type: "phase.started", phase: "plan", kind: "phase", text: "Create plan" },
  {
    at: 5159,
    type: "agent.session_started",
    phase: "plan",
    kind: "agent",
    text: "Planner started with read-only tools",
  },
  {
    at: 115507,
    type: "agent.tool_completed",
    phase: "plan",
    kind: "fail",
    text: "submit_plan rejected: fields over 500 characters",
  },
  {
    at: 142023,
    type: "agent.message",
    phase: "plan",
    kind: "agent",
    text: "“Items need to be under 500 characters each. Let me shorten them.”",
  },
  {
    at: 142043,
    type: "plan.recorded",
    phase: "plan",
    kind: "ok",
    text: "Implementation plan recorded",
  },
  {
    at: 142160,
    type: "phase.started",
    phase: "implement",
    kind: "phase",
    text: "Implement change",
  },
  {
    at: 142284,
    type: "agent.session_started",
    phase: "implement",
    kind: "agent",
    text: "Implementer started inside the sandbox",
  },
  {
    at: 275813,
    type: "agent.message",
    phase: "implement",
    kind: "agent",
    text: "“errcode 2067 is SQLITE_CONSTRAINT_UNIQUE.”",
  },
  { at: 275911, type: "agent.tool_completed", phase: "implement", kind: "tool", text: "edit" },
  { at: 275924, type: "agent.tool_completed", phase: "implement", kind: "tool", text: "write" },
  {
    at: 308956,
    type: "agent.message",
    phase: "implement",
    kind: "agent",
    text: "“Now let me add the concurrent regression test.”",
  },
  { at: 332322, type: "agent.tool_completed", phase: "implement", kind: "tool", text: "edit" },
  {
    at: 351240,
    type: "agent.message",
    phase: "implement",
    kind: "agent",
    text: "“All 6 tests pass.”",
  },
  { at: 366041, type: "phase.started", phase: "validate", kind: "phase", text: "Validate change" },
  {
    at: 366101,
    type: "artifact.recorded",
    phase: "validate",
    kind: "note",
    text: "Diff recorded: 6 files, +147 −19",
  },
  { at: 366452, type: "command.completed", phase: "validate", kind: "cmd", text: "npm run test" },
  {
    at: 366585,
    type: "command.completed",
    phase: "validate",
    kind: "cmd",
    text: "npm run typecheck",
  },
  { at: 366720, type: "command.completed", phase: "validate", kind: "cmd", text: "npm run lint" },
  {
    at: 366740,
    type: "validation.recorded",
    phase: "validate",
    kind: "ok",
    text: "Verified against the baseline",
  },
  { at: 366832, type: "phase.started", phase: "review", kind: "phase", text: "Review patch" },
  {
    at: 366961,
    type: "agent.session_started",
    phase: "review",
    kind: "agent",
    text: "Reviewer started with read-only tools",
  },
  {
    at: 446455,
    type: "review.recorded",
    phase: "review",
    kind: "ok",
    text: "Approved with 0 blocking findings",
  },
  { at: 446574, type: "phase.started", phase: "publish", kind: "phase", text: "Publish" },
  {
    at: 450032,
    type: "commit.created",
    phase: "publish",
    kind: "note",
    text: "Committed rivet/job-9b3056ce-prevent-concurrent…",
  },
  {
    at: 450034,
    type: "push.completed",
    phase: "publish",
    kind: "note",
    text: "Pushed the branch to GitHub",
  },
  {
    at: 451853,
    type: "pull_request.opened",
    phase: "publish",
    kind: "pr",
    text: "Opened pull request #3",
  },
  { at: 452351, type: "job.completed", phase: "publish", kind: "ok", text: "Job completed" },
];

export function formatClock(ms: number): string {
  const total = Math.floor(ms / 1000);
  const minutes = Math.floor(total / 60);
  const seconds = total % 60;
  return `${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
}

/**
 * How long the console waits before revealing line `index`. Playback is
 * compressed, but a long real gap still reads as a longer pause, so the
 * minute the planner spent reading code does not look like the 100ms between
 * two npm commands.
 */
export function revealDelayMs(index: number): number {
  const line = RUN_LINES[index];
  const previous = RUN_LINES[index - 1];
  if (!line || !previous) return 500;
  const gapSeconds = (line.at - previous.at) / 1000;
  return Math.round(240 + Math.min(1100, 150 * Math.log2(1 + gapSeconds)));
}

/** Total playback time, from the first line to the last. */
export const PLAYBACK_MS = RUN_LINES.reduce((sum, _line, index) => sum + revealDelayMs(index), 0);

/** How much faster than real time the console plays, rounded for a caption. */
export const PLAYBACK_SPEEDUP = Math.round(RUN.durationMs / PLAYBACK_MS / 5) * 5;
