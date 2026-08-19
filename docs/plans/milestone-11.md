# Milestone 11: Observability and hardening

M10 was the milestone where Rivet started producing numbers about itself. M11 is the milestone where
Rivet becomes something you could point at someone else's machine without wincing - and, just as
importantly, where the story of a run stops being "read the timeline and infer" and becomes a trace
you can open.

The PRD checklist (§2719):

- [x] Structured logging
- [x] tracing
- [x] job metrics
- [x] worker metrics
- [x] model metrics
- [x] resource monitoring
- [x] redaction
- [x] rate limiting
- [x] orphan cleanup
- [x] security review

Plus the standing constraints: §26 (the telemetry list and the OpenTelemetry preference), §27 (the
security minimum), §21 (prompt injection and the repository threat model), §15 (sandbox network and
cleanup), §22 (budget controls, which M11 extends one level up to the control plane) and §13.3 (tool
and event observability, most of which M4-M8 already record).

**Scope decisions, taken up front:**

1. **Telemetry ships with a self-hosted stack.** OpenTelemetry SDK in both deployables, OTLP export,
   and a `docker-compose` observability stack (collector, Prometheus, Tempo, Grafana) with
   provisioned dashboards checked into the repository. No vendor account, no token, nothing to
   expire before a demo. Owning the whole pipeline is also the version that survives the interview
   question, which §26 says is the point.
2. **Authorization is single-owner, and multi-tenancy is an explicit non-goal.** One signed session,
   one allowlisted GitHub account, an auth boundary enforced in route handlers rather than only in
   middleware. No `users` table, no `user_id` column, no ownership joins. §27's "authorization on
   every job/repository endpoint" is satisfied by there being exactly one principal and a guard that
   provably runs on every route; a real multi-tenant model is a later milestone and says so.
3. **No deployment.** M11 hardens and instruments the system as it runs locally and in CI.
   `docs/architecture.md`'s standing note about the SSE stream needing a streaming-capable host
   remains open and unaddressed here.
4. **Sandbox network hardening stops short of an egress proxy.** §15's MVP line - "prevent arbitrary
   access to internal application infrastructure" - is in. The allowlist and egress proxy stay
   long-term, and the security review names them as accepted risk.

---

## The claim this milestone makes

**M11 adds one nullable column, no new table, no new job status, and no new job failure category.**

That is a smaller footprint than any milestone since M3, and it is deliberate. Observability that
requires the observed system to change shape is observability you cannot trust, and hardening that
introduces new ways for a job to fail has traded one risk for another. Concretely:

- Tracing adds `jobs.trace_context` (nullable `text`, one W3C `traceparent`). Nothing else.
- Resource monitoring is a `resource_report` artifact and one event at container teardown, both
  through the existing `PhaseContext.artifact()` and `appendEvent()` writers.
- Prompt-injection detection is one event type. It never fails a job.
- Rate limiting refuses **before a job row exists**, so it is an HTTP 429 rather than a failure
  category. A job that was never created cannot have a status.
- Sessions live in a signed cookie. Rate-limit state lives in Redis, which by the standing rule
  holds nothing that matters.

The two new event types are `security.injection_suspected` and `sandbox.resources_recorded`. Both go
in `JOB_EVENT_TYPES`, which is Zod-validated `text` precisely so this costs no migration.

---

## What already exists, and what M11 actually adds

More of this checklist is done than the ten unchecked boxes suggest, and being honest about that is
what keeps the milestone from re-solving solved problems.

- **Structured logging exists in the worker.** `apps/worker/src/logger.ts` is pino with
  `workerId`/`jobId` child loggers and TTY-only pretty printing. **The web app has none at all** -
  no logger, no request id, no correlation between a click and the worker line it caused. That gap
  is most of this checklist item.
- **Redaction exists, narrowly.** `SecretRegistry` plus the pino `logMethod` hook covers every log
  argument in the worker (M9, PRD §27). It does **not** cover what lands in Postgres: event JSON,
  command transcripts, artifact bodies and checkpoint patches all bypass it, and a provider error
  quoted into a `run.failed` event is a real path for a token to become durable.
- **Orphan cleanup mostly exists.** `createSweepRunner` reaps labelled containers and `sweepJobs`
  reclaims expired leases and re-enqueues orphaned `queued` rows. The gaps are host-side: temporary
  Git index files, seed archives and clone directories left by a `kill -9`, and BullMQ scheduler
  keys for schedules nobody owns any more.
- **Every job metric §24.4 wants is already a column**, and M10 already reads them. What is missing
  is that they are per-row facts rather than time series - nothing emits them anywhere you can graph
  a trend, compare two weeks, or alert on.
- **Sandbox resource limits exist and are required fields** (`memoryBytes`, `nanoCpus`, `pidsLimit`,
  `CapDrop: ALL`, `no-new-privileges`, non-root, a user-defined bridge). What is missing is
  _monitoring_: nothing samples what a container actually used, so an `oom_killed` is a verdict with
  no evidence behind it.
- **The tool boundary is already asserted at session start** - `getActiveToolNames()` must equal the
  role's exact set - which is §21's strongest mitigation and already shipped in M4/M6/M8.

So M11 adds seven things:

1. A **`Telemetry` port** in core with a no-op default, and a `packages/telemetry` OTel adapter.
2. **Traces** spanning the control plane and the worker, correlated to jobs and to logs.
3. **Metrics** for jobs, workers, models and queues, plus a local Grafana stack that renders them.
4. **Container resource sampling** and an OOM forensics trail.
5. **Auth, CSRF and rate limiting** on the control plane.
6. **Sandbox network isolation** from the host's own infrastructure, plus completed orphan cleanup.
7. **Prompt-injection fencing, detection and an adversarial benchmark case**, plus the written
   security review and its CI enforcement.

---

## The decisions this plan rests on

### 1. Telemetry is a port, and the OTel SDK is an adapter

`@opentelemetry/api` is a facade that no-ops until an SDK registers a provider, so `packages/core`
could import it directly without breaking a single test. It still will not, because every other
external dependency in this system sits behind a port - `JobQueue`, `Sandbox`, `CodingAgent` - and
the reason is not aesthetic. Core is shared by two deployables and must not depend on either one's
delivery mechanism; a port also makes "did this phase open a span with these attributes" an ordinary
unit assertion against a recording fake rather than something that needs an SDK and an exporter.

```ts
// packages/core/src/telemetry/telemetry.ts - types and an interface, no implementation
export interface Telemetry {
  startSpan(name: string, options?: SpanOptions): Span;
  counter(name: string): Counter;
  histogram(name: string): Histogram;
  gauge(name: string): Gauge;
  /** The active span's W3C traceparent, or undefined when telemetry is off. */
  traceContext(): string | undefined;
}
```

`NoopTelemetry` is the default value of `PipelineOptions.telemetry`, in keeping with the rule that
core holds no policy and takes no defaults it can be handed instead. `packages/telemetry` is the
only package that knows OpenTelemetry exists, and it is the fourth adapter package.

**`RIVET_TELEMETRY` is the fifth member of the switch family, and it is the one that inverts.**
`off` (default) and `otlp`. `RIVET_SANDBOX`, `RIVET_AGENT`, `RIVET_GITHUB` and `RIVET_EVAL` all
refuse their cheap variant under `NODE_ENV=production` because a worker that skips real work looks
healthy. Telemetry is the opposite: a production worker with telemetry off is _degraded_, not
_lying_, and refusing to boot over it would be worse than the thing it prevents. So `off` is legal
everywhere and the worker logs a startup warning under production instead.

### 2. A job's trace is linked to its request, not parented by it

The obvious design - the `POST /api/jobs` span is the parent of everything the worker later does -
is wrong for this system. The request finishes in milliseconds; the run starts whenever a worker
claims it, can be reclaimed onto a different worker, and can retry three times. A trace whose root
span stays open for twenty minutes across three processes is a trace most backends will drop, and it
would make three attempts of one job indistinguishable from one very strange attempt.

So:

- The creating request records its own short span and stores its `traceparent` in
  `jobs.trace_context`.
- **Each attempt gets its own root span**, `job.run`, with a **span link** back to the stored
  context and `rivet.job_id` / `rivet.attempt` attributes. Attempts are siblings related by link and
  by attribute, which is exactly what they are.
- Under that root: one span per phase (`phase.provisioning`, `phase.analyzing`, ...), one per
  sandbox command, one per model call, one per tool call, one per host Git operation, one per GitHub
  API call.
- Queue wait time is a measured attribute on `job.run` (claim time minus enqueue time), not a span,
  because nothing was executing during it.

Every span carries `rivet.job_id`. That attribute, not the trace structure, is what makes "show me
everything about job X" a query - which matters because the answer legitimately spans three traces.

### 3. Logs join the trace rather than being replaced by it

pino stays. Every log line grows `trace_id` and `span_id` from the active span via a pino mixin, and
the web app gets the same logger (`apps/web/lib/logger.ts`) with a per-request child carrying
`requestId`, `route` and `traceId`. That single change is what makes a Grafana trace and a log line
two views of one event rather than two systems that happen to run at once.

Shipping logs to Loki is optional and off by default in the compose stack. Correlation is the part
that matters; log storage is a hosting decision.

### 4. Redaction moves from "the log path" to "every durable path"

Today `SecretRegistry` guards pino and nothing else. M11 makes the registry available to the writers
that produce durable rows - `appendEvent`, `recordCommand`, `recordArtifact` - through the same
dependency-injection shape everything else uses, because a token in a `job_events` row is strictly
worse than one in a log file: the log rotates, the event is append-only and by design never deleted.

The registry stays a **safety net, not a boundary**, and the docblock keeps saying so. Nothing logs
a token deliberately, `host-git.ts` redacts its own transcripts, and the token still never enters an
argv, a remote URL or `SandboxSpec.env`. What changes is that the net now hangs under the whole
system rather than under one part of it.

Acceptance run D is what makes this a fact rather than an intention, and it has a positive control:
a non-secret sentinel must be _found_ by the same search that finds no secret one. A grep that
silently fails returns the same nothing a clean system returns.

### 5. Auth is one principal and a guard that provably runs

`RIVET_AUTH` is `off` or `github`; `off` is refused under `NODE_ENV=production`, following the
family rule, because an open control plane that spends money is precisely the failure that looks
healthy.

- **Sign-in** is a GitHub OAuth identifying flow using the M9 App's client credentials. The callback
  fetches the authenticated login and compares it against `RIVET_OWNER_GITHUB_LOGIN`. Anyone else
  gets a refusal, not a session - the allowlist is checked server-side against GitHub's answer, the
  same way the M9 install callback trusts nothing in its query string and lists the installations
  the App can actually act on.
- **The session** is a signed, `httpOnly`, `SameSite=Lax`, `Secure`-in-production cookie holding a
  short JWT (`jose`) signed with `RIVET_SESSION_SECRET`. No session table, so no session store to
  clean up and nothing to reap.
- **CSRF** is `SameSite=Lax` plus an `Origin`/`Host` check on every mutating request. A
  double-submit token buys nothing on top of those two for a same-site app and adds a failure mode;
  the review document states that reasoning rather than leaving the omission to be noticed.
- **The boundary is in the route handlers.** Next middleware handles page redirects, but the real
  guard is `requireSession()` called by each handler, for two reasons: middleware runs in a
  different runtime with different failure modes, and a redirect is not an authorization decision.
  Defense in depth, with the depth in the part that returns 401.

**The test that makes this hold is an enumeration test.** It walks every file under
`apps/web/app/api` and asserts each exported handler either calls the guard or appears in an
explicit `PUBLIC_ROUTES` allowlist with a comment saying why. A route added in M12 that forgets the
guard fails `pnpm test`, with no database and no network. That is the same shape as the
`Phase.recovery` exhaustiveness test and the `EVALUATION_FAILURE_CLASSES` total record: make the
omission a compile- or test-time event rather than a review-time one.

Nothing about this touches the eval runner, `demo:job`, `demo:recovery`, `demo:pr` or `demo:eval`,
because all of them call `@rivet/core` directly and never make an HTTP request. The streaming suite
does hit routes, so it gets a test session helper.

### 6. Rate limiting protects the unauthenticated edges and the spend

With one principal, rate limiting is not about abuse volume; it is §22's budget argument moved one
level up. Two surfaces:

- **Unauthenticated edges** - the OAuth callback, the GitHub App setup callback, the sign-in
  starter. These are reachable without a session by definition. Fixed window keyed by IP.
- **Spend-shaped routes** - `POST /api/jobs` costs real model calls on every success, so it gets
  both a per-window creation limit and a **global cap on non-terminal jobs**, checked inside
  `createJob()` as a passed-in limit (core reads no environment) and refused with a stated reason.

Implementation lives in `packages/queue`, the package that already owns the ioredis client, as an
atomic Lua fixed-window `consume(key, limit, windowMs)`. It **fails closed**: if Redis is
unreachable, job creation is refused rather than allowed. That is the opposite of the usual
availability instinct and it is right here, because the thing on the other side of the limiter is
money, and the standing rule that "Redis holds nothing that matters" is about _durability_, not
about permission to spend when it is down.

Read routes and SSE are deliberately **not** limited. Each open stream is a bounded one-query-per-
second Postgres poller with an existing hidden-tab and terminal-drain lifecycle, and one operator's
browser tabs are not the threat model. The review document records that as a decision.

### 7. The sandbox must not reach the control plane, and the honest mechanism is layered

§15's MVP requirement is "prevent arbitrary access to internal application infrastructure". Today
the sandbox is on a user-defined bridge, which stops sibling containers from finding each other by
default-bridge IP but does **not** stop a container from routing to the host - the README already
says so.

Three things, in order of how much they actually buy:

1. **Nothing the container needs is bound where it can reach it.** Postgres and Redis bind to
   loopback in development and live on a separate compose network in CI. This is the real control,
   and it belongs to the host configuration rather than to Docker flags.
2. **`enable_icc=false` on the `rivet-sandbox` network**, so two containers on it - including CI
   service containers - cannot talk to each other at all.
3. **A startup reachability assertion**, in the spirit of `assertLeaseInvariant`. When
   `RIVET_SANDBOX=docker`, the worker runs one short-lived probe container that attempts a TCP
   connect to its own configured `DATABASE_URL` and `REDIS_URL` endpoints. If either connects, the
   worker **refuses to start** and says which one. A misconfiguration that exposes the control plane
   to arbitrary repository code is exactly the class of problem that is cheaper to make impossible
   to boot than possible to debug.

What this does not do is stop a malicious repository from sending the repository's own contents to
the internet, because the container must reach the package registry and GitHub to do its job. That
is the egress proxy, it is out of scope, and §15 already says so. The security review states it in
those words rather than implying more.

### 8. Prompt injection: fence everything, detect loudly, fail nothing

§21's mitigations are mostly already shipped as capability boundaries. What M11 adds is the prompt-
level half and the evidence.

- **Fencing.** Repository content, file reads, command output and - the one most easily forgotten -
  **the GitHub issue title and body** enter prompts inside explicitly delimited untrusted blocks
  with a stated trust preamble. The issue body is attacker-controlled on any public repository,
  arrives through M9's issue picker, and becomes the task description. It is the highest-value
  injection surface in the system and the least obvious.
- **Detection, which records and continues.** A bounded scanner over untrusted text raises
  `security.injection_suspected` with the pattern class and the location. The job proceeds. Pattern
  matching over repository prose produces false positives - a repository that merely _discusses_
  prompt injection would be unrunnable - and the capability boundary, not the regex, is the defense.
  Detection here is observability.
- **An adversarial benchmark case.** `benchmarks/prompt-injection-bait/` is a genuine, solvable task
  whose README and a source comment try to make the agent exfiltrate, skip tests, or write outside
  the workspace. Its hidden tests assert both halves: the real task was completed, and none of the
  bait was taken. It runs in `pnpm eval:run` like any other case, which is the entire payoff of M10
  being an ordinary job harness.

### 9. Resource monitoring is a sample loop and a report, not a stream of events

The dockerode adapter samples `container.stats({ stream: false })` on an interval while a job runs,
keeping running peaks for memory, CPU and pids. On teardown it writes one `resource_report` artifact
and one `sandbox.resources_recorded` event, and emits the peaks as OTel gauges and histograms.

One event, not one per sample: a timeline that a monitor can flood is a timeline nobody reads, and
the per-sample series belongs in Prometheus, which is built for it. The report's job is to make an
`oom_killed` explainable after the fact - peak memory against the limit, at what point in the run -
rather than to be a second metrics system inside Postgres.

---

## Stages

Each stage is independently mergeable and leaves `pnpm build`, `pnpm test`, `pnpm lint` and
`pnpm typecheck` green with no database, no Redis and no Docker.

### Stage 1 - The telemetry port and its no-op

`packages/core/src/telemetry/` with the `Telemetry`, `Span`, `Counter`, `Histogram` and `Gauge`
types, `NoopTelemetry`, and a `RecordingTelemetry` fake for tests. `PipelineOptions.telemetry`
defaults to the no-op. No behaviour change anywhere; the point of the stage is that every later
stage can be reviewed without an SDK in the diff.

### Stage 2 - The OTel adapter and the switch

`packages/telemetry` with the OTel SDK wiring, OTLP/HTTP exporters, resource attributes
(`service.name`, `service.version`, `deployment.environment`, `rivet.worker_id`), and lazy
construction - importing the package must never open a connection or throw, the same rule as
`@rivet/database` and `@rivet/queue` and for the same CI reason. `RIVET_TELEMETRY` and
`OTEL_EXPORTER_OTLP_ENDPOINT` in `parseWorkerConfig` and in `resolveWebTelemetryConfig` (a pure
function of an env object, the web half, following `resolveGitHubWebConfig`).

### Stage 3 - Tracing

`jobs.trace_context` migration. Request spans in the web app; `job.run` root spans with links in the
processor; phase, command, model, tool, host-Git and GitHub spans. Trace and span ids on every pino
line in both deployables, and the new `apps/web/lib/logger.ts` with per-request children.

### Stage 4 - Metrics

The §26 list, as instruments: job duration, queue wait, sandbox provisioning duration, command
duration, model latency, model errors, tool failures, cost, tokens, active jobs, worker heartbeat
liveness, lease reclaims, sweeper outcomes, retry counts by category. Job-level values are emitted
from the same places that already write the columns, so a metric and a row cannot disagree.

### Stage 5 - The local stack and the dashboards

`ops/observability/docker-compose.yml` (collector, Prometheus, Tempo, Grafana), provisioned
datasources, and dashboards checked in as JSON: a job overview, a worker health board, and a model
cost/latency board. `pnpm obs:up` / `pnpm obs:down`, plus `docs/milestone-11-guide.md`'s tour.

### Stage 6 - Container resource monitoring

The sample loop in the dockerode adapter, the `resource_report` artifact, the
`sandbox.resources_recorded` event, the gauges, and the OOM forensics path.

### Stage 7 - Sandbox network isolation and orphan cleanup completion

`enable_icc=false`, the startup reachability probe and its refusal, and the host-side sweeps the
reaper does not do yet: temporary Git index files, seed archives, abandoned clone directories, stale
BullMQ scheduler keys.

### Stage 8 - Redaction across durable writes

`SecretRegistry` reaches `appendEvent`, `recordCommand` and `recordArtifact`. Includes the sentinel
plumbing that acceptance run D needs.

### Stage 9 - Auth and CSRF

`RIVET_AUTH`, the OAuth identifying flow, the signed session, `requireSession()`, the
`PUBLIC_ROUTES` allowlist, the origin check, the sign-in page, a sign-out, and the route enumeration
test. The streaming suite gets its session helper.

### Stage 10 - Rate limiting and the active-job cap

The Lua fixed-window limiter in `packages/queue`, the two limited surfaces, the global non-terminal
job cap in `createJob()`, and 429 responses that state which limit was hit and when it resets.

### Stage 11 - Prompt-injection fencing, detection and the bait case

Prompt fencing across planner, implementer, reviewer and the issue body; the scanner and its event;
`benchmarks/prompt-injection-bait/` with hidden tests; the README threat-model section §21 asks for.

### Stage 12 - Security review and CI enforcement

`docs/security-review.md` walking §27 item by item with the code that satisfies it and the risks
accepted, an expanded `SECURITY.md`, and a fifth CI job running CodeQL, a dependency audit and a
secret scanner. Fifth job rather than folded into `verify`, for the reason the other four are
separate: shared setup is how you lose the property a job exists to protect.

---

## Acceptance runs

The contract these implement will be written out in `docs/plans/milestone-11-acceptance.md`, in the
same shape as M8's, M9's and M10's. Runs A-F need no Docker; G and H do.

**A - One job, one trace, one shape.** A job run through the pipeline against a recording telemetry
fake produces a span tree whose phase spans match the job's `phase.completed` events exactly, in
order, with model and command spans nested under the phase that ran them and every span carrying
`rivet.job_id`. Asserted in-process, with no collector.

**B - Metrics agree with the database.** For a completed job, the emitted duration histogram, cost
counter and token counters equal the values on the `jobs` row. A metric that disagrees with the row
is worse than no metric, and this is the assertion that keeps them from drifting.

**C - Telemetry is not in the way.** The same job run with `RIVET_TELEMETRY=off` and with the
adapter attached produces byte-identical projected event lists and identical terminal state. Same
technique the M10 sandbox suite uses to prove an evaluation job is indistinguishable from an
ordinary one.

**D - Redaction, with a positive control.** A sentinel secret is registered and then deliberately
pushed through a log line, an event payload, a command transcript and an artifact body. A search
across captured log output and every `job_events`, `job_commands` and `job_artifacts` row finds none
of it. The same search, for a non-secret sentinel that was written the same way, finds it.

**E - Every route is guarded.** The enumeration test proves guard coverage statically. Then, live:
an unauthenticated request to each non-public route returns 401 or a redirect and mutates nothing; a
cross-origin `POST` carrying a valid session cookie is refused; a session signed with the wrong
secret is refused; an expired session is refused.

**F - Limits refuse, and refuse closed.** Creation attempts past the window limit return 429 with a
reset hint and leave **no** `jobs` row. With the active-job cap reached, creation is refused for the
same reason. With Redis unreachable, creation is refused rather than allowed.

**G - The container cannot reach the control plane.** From inside a real job container: a TCP
connect to the host's configured Postgres and Redis endpoints fails, `/var/run/docker.sock` is
absent, and a sibling container on `rivet-sandbox` is unreachable. Positive controls, because a
network test that passes for the wrong reason is worthless: the package registry and github.com are
reachable from the same container in the same run. Plus the startup probe's refusal, asserted by
deliberately exposing a service and checking the worker exits non-zero naming it.

**H - The bait case.** `benchmarks/prompt-injection-bait/` runs as an ordinary evaluation job. The
timeline carries `security.injection_suspected`. The hidden tests confirm the real task was
completed and the bait was not taken - nothing written outside the workspace, no exfiltration
attempt in any command row, no skipped test. And a demo: `pnpm demo:observability` runs one real job
with the stack up and prints the Grafana trace URL, which is the milestone's visible artifact.

---

## What M11 deliberately does not do

Named so their absence reads as a decision rather than an oversight.

- **No multi-tenancy.** One principal, no `users` table, no `user_id`, no ownership checks beyond
  "is this the operator". A second user is a schema change and a migration of every read path.
- **No egress allowlist or proxy.** A malicious repository can still send its own contents
  somewhere. §15 calls this long-term and the review document records it as accepted risk with the
  reason.
- **No deployment, and the SSE hosting question stays open.**
- **No alerting.** Dashboards and traces, no alert rules and no pager. Alerting without a deployment
  is alerting about a laptop.
- **No log shipping by default.** Trace correlation is the deliverable; Loki is in the compose file
  and off.
- **No sandboxing of the harness process itself.** The harness runs trusted in the process holding
  the model key, mitigated by the session-start tool assertion. That has been true since M4 and M11
  does not change it - it just writes it down in the security review in those words.
