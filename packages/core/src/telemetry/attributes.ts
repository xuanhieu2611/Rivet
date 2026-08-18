/**
 * The names of everything Rivet puts on a span.
 *
 * Constants rather than string literals at the call sites, and the reason is
 * the same one `JOB_EVENT_TYPES` exists for: an attribute is a name two
 * unrelated places have to agree on, and the failure mode of disagreement is
 * invisible. A dashboard grouped by `rivet.job_id` silently loses every span a
 * phase spelled `rivet.jobId`, and nothing anywhere throws.
 *
 * Everything is under the `rivet.` namespace, because none of it has an OTel
 * semantic convention. Where a convention *does* exist - `service.name`,
 * `deployment.environment.name`, `http.request.method` - the stable OTel name
 * is used instead and lives in `packages/telemetry/src/resource.ts` or at the
 * call site, so an off-the-shelf dashboard works without a rename.
 */

/** On every span Rivet opens for a job, at every depth. */
export const ATTR_JOB_ID = "rivet.job_id";
/** The worker process that owns a lease or emits a worker-level sample. */
export const ATTR_WORKER_ID = "rivet.worker_id";

/**
 * Which claim of the job this span belongs to.
 *
 * `jobs.attempt_count`, not BullMQ's per-message retry count. Three attempts of
 * one job are three traces, and this attribute plus `rivet.job_id` is what
 * relates them - which is why "show me everything about job X" is a query
 * rather than a trace lookup.
 */
export const ATTR_ATTEMPT = "rivet.attempt";

/** The dispatch generation the message carried, for diagnosing stale delivery. */
export const ATTR_DISPATCH_GENERATION = "rivet.dispatch_generation";

/** The job status a phase span holds, e.g. `implementing`. */
export const ATTR_PHASE = "rivet.phase";

/** The terminal status a `job.run` span ended in. */
export const ATTR_STATUS = "rivet.status";

/** The failure category of a run that ended badly, from `FAILURE_CATEGORIES`. */
export const ATTR_FAILURE_CATEGORY = "rivet.failure_category";

/**
 * Milliseconds between the job being created and this attempt claiming it.
 *
 * Set only on the first attempt, and that restriction is the whole of its
 * honesty: on a reclaim the same subtraction measures time since creation,
 * which includes however long the previous attempt ran. Queue wait is an
 * attribute rather than a span because nothing was executing during it.
 */
export const ATTR_QUEUE_WAIT_MS = "rivet.queue_wait_ms";

/** Whether this attempt resumed from a durable checkpoint. */
export const ATTR_RESUMED = "rivet.resumed";

// --- sandbox commands -------------------------------------------------------

/** The executable, without its arguments. Arguments can carry a repository's data. */
export const ATTR_COMMAND = "rivet.command";
/** How many arguments followed it, which is enough to tell two call sites apart. */
export const ATTR_COMMAND_ARGC = "rivet.command.argc";
export const ATTR_COMMAND_CWD = "rivet.command.cwd";
export const ATTR_COMMAND_EXIT_CODE = "rivet.command.exit_code";
export const ATTR_COMMAND_TIMED_OUT = "rivet.command.timed_out";

// --- coding agent -----------------------------------------------------------

/** `planner`, `implementer` or `reviewer` - the role's exact tool set. */
export const ATTR_AGENT_ROLE = "rivet.agent.role";
export const ATTR_AGENT_MODEL = "rivet.agent.model";
export const ATTR_AGENT_PROVIDER = "rivet.agent.provider";
/** The turn number within this session, not the job's cumulative count. */
export const ATTR_AGENT_TURN = "rivet.agent.turn";
export const ATTR_AGENT_TOOL = "rivet.agent.tool";
/** Whether the tool reported a failure, which is not the same as the span failing. */
export const ATTR_AGENT_TOOL_ERROR = "rivet.agent.tool_error";
export const ATTR_AGENT_STOP_REASON = "rivet.agent.stop_reason";
export const ATTR_AGENT_INPUT_TOKENS = "rivet.agent.input_tokens";
export const ATTR_AGENT_OUTPUT_TOKENS = "rivet.agent.output_tokens";

// --- GitHub and host Git ----------------------------------------------------

/** The port method that was called, e.g. `createPullRequest`. */
export const ATTR_GITHUB_OPERATION = "rivet.github.operation";
export const ATTR_GITHUB_INSTALLATION_ID = "rivet.github.installation_id";
/** `owner/name`. Public information, and the only way two jobs are told apart here. */
export const ATTR_GITHUB_REPO = "rivet.github.repo";
/** `seed_clone` or `publish` - which host Git operation ran. */
export const ATTR_GIT_OPERATION = "rivet.git.operation";

// --- the web app ------------------------------------------------------------

/** The route pattern, e.g. `POST /api/jobs`. Never the resolved path with ids in it. */
export const ATTR_ROUTE = "rivet.route";
/** The per-request correlation id that also lands on every log line. */
export const ATTR_REQUEST_ID = "rivet.request_id";

// --- span names -------------------------------------------------------------

/**
 * The span names, in one place for the same reason the attributes are.
 *
 * Phase spans are built rather than listed - `phase.${status}` - so a status
 * added in a later milestone gets a span without anybody remembering to add one
 * here, which is the failure this file is otherwise designed to prevent.
 */
export const SPAN_JOB_RUN = "job.run";
export const SPAN_SANDBOX_COMMAND = "sandbox.command";
export const SPAN_AGENT_SESSION = "agent.session";
export const SPAN_AGENT_TURN = "agent.turn";
export const SPAN_AGENT_TOOL = "agent.tool";
export const SPAN_GITHUB_REQUEST = "github.request";
export const SPAN_HOST_GIT = "git.host";

/** The span a phase runs inside. One per `phase.started`/`phase.completed` pair. */
export function phaseSpanName(status: string): string {
  return `phase.${status}`;
}
