import type { JobStatus } from "@rivet/contracts";

import { ATTR_FAILURE_CATEGORY } from "./attributes";
import type { Telemetry } from "./telemetry";

/**
 * The metric catalog owned by Rivet.
 *
 * Names live beside the telemetry port rather than at call sites so a worker
 * and a phase cannot silently publish two series for the same fact. Units are
 * supplied when an instrument is created; the names stay stable if a backend
 * later changes how it displays them.
 */
export const METRIC_JOB_DURATION = "rivet.job.duration";
export const METRIC_QUEUE_WAIT = "rivet.job.queue_wait";
export const METRIC_SANDBOX_PROVISIONING_DURATION = "rivet.sandbox.provisioning.duration";
export const METRIC_SANDBOX_MEMORY_USAGE = "rivet.sandbox.memory.usage";
export const METRIC_SANDBOX_CPU_USAGE = "rivet.sandbox.cpu.usage";
export const METRIC_SANDBOX_PIDS_USAGE = "rivet.sandbox.pids.usage";
export const METRIC_SANDBOX_MEMORY_PEAK = "rivet.sandbox.memory.peak";
export const METRIC_SANDBOX_CPU_PEAK = "rivet.sandbox.cpu.peak";
export const METRIC_SANDBOX_PIDS_PEAK = "rivet.sandbox.pids.peak";
export const METRIC_SANDBOX_MEMORY_PEAK_DISTRIBUTION = "rivet.sandbox.memory.peak.distribution";
export const METRIC_SANDBOX_CPU_PEAK_DISTRIBUTION = "rivet.sandbox.cpu.peak.distribution";
export const METRIC_SANDBOX_PIDS_PEAK_DISTRIBUTION = "rivet.sandbox.pids.peak.distribution";
export const METRIC_SANDBOX_OOM_KILLS = "rivet.sandbox.oom_kills";
export const METRIC_COMMAND_DURATION = "rivet.command.duration";
export const METRIC_MODEL_LATENCY = "rivet.model.latency";
export const METRIC_MODEL_CALLS = "rivet.model.calls";
export const METRIC_MODEL_ERRORS = "rivet.model.errors";
export const METRIC_TOOL_FAILURES = "rivet.tool.failures";
export const METRIC_JOB_COST_USD = "rivet.job.cost_usd";
export const METRIC_JOB_INPUT_TOKENS = "rivet.job.input_tokens";
export const METRIC_JOB_OUTPUT_TOKENS = "rivet.job.output_tokens";
export const METRIC_ACTIVE_JOBS = "rivet.jobs.active";
export const METRIC_WORKER_HEARTBEAT = "rivet.worker.heartbeat";
export const METRIC_LEASE_RECLAIMS = "rivet.jobs.lease_reclaims";
export const METRIC_SWEEPER_OUTCOMES = "rivet.sweeper.outcomes";
export const METRIC_RETRIES = "rivet.jobs.retries";
export const METRIC_JOBS_FINISHED = "rivet.jobs.finished";
export const METRIC_JOBS_COMPLETED = "rivet.jobs.completed";

export interface TerminalJobMetricInput {
  status: JobStatus;
  startedAt: Date | null;
  completedAt: Date | null;
  failureCategory?: string | null;
}

/**
 * Records terminal job facts from the row returned by the committed status
 * transition.
 *
 * The timestamps are deliberately taken from the database row, not from the
 * worker clock. `started_at` is coalesced across reclaims and `completed_at`
 * is written in the same transition that ends the job, so this histogram is
 * the same duration the durable job says it had. If the transition did not
 * return both values, no partial observation is emitted.
 */
export function recordTerminalJobMetrics(
  telemetry: Telemetry,
  input: TerminalJobMetricInput,
): void {
  const attributes = {
    status: input.status,
    [ATTR_FAILURE_CATEGORY]: input.failureCategory ?? undefined,
  };

  telemetry
    .counter(METRIC_JOBS_FINISHED, {
      unit: "1",
      description: "Jobs that reached a terminal status.",
    })
    .add(1, attributes);

  if (input.status === "completed") {
    telemetry
      .counter(METRIC_JOBS_COMPLETED, {
        unit: "1",
        description: "Jobs that completed successfully.",
      })
      .add(1);
  }

  if (input.startedAt === null || input.completedAt === null) return;

  telemetry
    .histogram(METRIC_JOB_DURATION, {
      unit: "ms",
      description: "Elapsed time from a job's first claim to its terminal transition.",
    })
    .record(Math.max(0, input.completedAt.getTime() - input.startedAt.getTime()), attributes);
}

/** Records one measured duration in milliseconds. */
export function recordDuration(
  telemetry: Telemetry,
  name: string,
  valueMs: number,
  attributes?: Record<string, string | number | boolean | undefined>,
  description?: string,
): void {
  telemetry
    .histogram(name, { unit: "ms", ...(description === undefined ? {} : { description }) })
    .record(Math.max(0, valueMs), attributes);
}

/** Records one monotonic count with an optional low-cardinality label set. */
export function recordCount(
  telemetry: Telemetry,
  name: string,
  value = 1,
  attributes?: Record<string, string | number | boolean | undefined>,
  description?: string,
  unit = "1",
): void {
  telemetry
    .counter(name, { unit, ...(description === undefined ? {} : { description }) })
    .add(value, attributes);
}

/** Records one last-value worker health sample. */
export function recordLevel(
  telemetry: Telemetry,
  name: string,
  value: number,
  attributes?: Record<string, string | number | boolean | undefined>,
  description?: string,
): void {
  telemetry
    .gauge(name, { unit: "1", ...(description === undefined ? {} : { description }) })
    .record(value, attributes);
}
