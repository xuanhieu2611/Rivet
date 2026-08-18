# Milestone 11: a guided tour of observability and hardening

M10 was the milestone where Rivet started producing numbers about itself. M11 is the milestone where
Rivet becomes something you could point at somebody else's machine without wincing, and where the
story of a run stops being "read the timeline and infer" and becomes a trace you can open.

This is the educational walkthrough. It covers what was added, how it was added, and why each
decision went the way it did. `docs/plans/milestone-11.md` is the committed plan;
`docs/security-review.md` is the security half's reference document; `SECURITY.md` is its short
version. This guide is the one to read first.

---

## Part 0. The one idea

**Instrumentation must not change the shape of the thing it observes, and hardening must not add new
ways for a job to fail.**

Both halves of M11 are the same claim. An observability layer that requires the observed system to
grow tables, statuses and failure modes is an observability layer you cannot trust, because you can
no longer tell whether a change in the numbers came from the system or from the measurement. And a
security control that turns a working job into a failed one has traded one risk for another,
silently, on a path nobody exercises until it fires.

So the milestone made a falsifiable promise up front:

**M11 adds one nullable column, no new table, no new job status, and no new job failure category.**

It kept it. The single migration is:

```sql
-- packages/database/drizzle/0009_luxuriant_wendigo.sql
ALTER TABLE "jobs" ADD COLUMN "trace_context" text;
```

That is the entire schema footprint of twelve stages. Everything else rides existing writers:

| Thing added         | Where it lives                         | Why it needed no schema     |
| ------------------- | -------------------------------------- | --------------------------- |
| Resource monitoring | `resource_report` artifact + one event | `PhaseContext.artifact()`   |
| Injection detection | One event type                         | `JOB_EVENT_TYPES` is text   |
| Sessions            | A signed cookie                        | No session table at all     |
| Rate-limit state    | Redis                                  | Redis holds nothing durable |
| Metrics             | OTLP export                            | Nothing persisted in PG     |
| Traces              | OTLP export + one `traceparent` string | The one column              |

The two new event types are `security.injection_suspected` and `sandbox.resources_recorded`. They
cost no migration because `JOB_EVENT_TYPES` and `FAILURE_CATEGORIES` have always been Zod-validated
`text` rather than pgEnums, which is a decision from M1 finally paying rent.

Rate limiting is the sharpest example of the promise. A limiter that refused a job by failing it
would need a failure category. Rivet's limiter refuses **before a job row exists**, so it is an
HTTP 429. A job that was never created cannot have a status.

---

## Part 1. What changed from M10

### Before M11

- The worker had structured logging. The web app had **no logger at all**, so there was no way to
  connect a click to the worker line it caused.
- Every job metric §24.4 wants was already a column on `jobs`, and M10 already read them. None of
  them was a time series, so nothing could graph a trend or compare two weeks.
- `SecretRegistry` redacted every pino log argument in the worker and nothing else. Event JSON,
  command transcripts and artifact bodies all bypassed it, and a provider error quoted into a
  `run.failed` event was a real path for a token to become durable and append-only.
- Sandbox resource limits were required fields and nothing sampled them, so `oom_killed` was a
  verdict with no evidence behind it.
- The control plane had no authentication, no CSRF protection and no rate limiting. Anything that
  could reach the port could spend money.
- Untrusted repository text entered prompts unfenced.
- Orphan cleanup reaped containers and reclaimed leases but left host-side temporary Git index
  files, seed archives and stale BullMQ scheduler keys.

### After M11

- A `Telemetry` port in core with a no-op default, and `packages/telemetry` as the fourth adapter
  package. `RIVET_TELEMETRY` is `off` or `otlp`.
- Every attempt of every job opens its own root `job.run` trace, linked back to the request that
  created it, with phase, command, model, turn, tool, host-Git and GitHub API spans underneath.
- Twenty-six metric instruments, emitted from the same code paths that write the columns.
- A self-hosted Grafana/Tempo/Prometheus/Collector stack with three provisioned dashboards, checked
  into the repository, started with `pnpm obs:up`.
- Container resource sampling, a `resource_report` artifact and OOM forensics.
- Redaction reaching `appendEvent`, `recordCommand` and `recordArtifact`.
- GitHub OAuth sign-in, a signed session cookie, `requireSession()` in every route handler, an
  origin check on every mutation, and a test that walks the route tree to prove coverage.
- A fail-closed Redis rate limiter and a global cap on non-terminal jobs.
- Untrusted text fenced at every prompt boundary, a detection event that never fails a job, and an
  adversarial benchmark case.
- `enable_icc=false`, a startup network-reachability probe that refuses to boot, and the host-side
  sweeps.
- `docs/security-review.md`, an expanded `SECURITY.md`, and a fifth CI workflow running CodeQL, a
  dependency audit and a secret scanner.

### New durable vocabulary

Two event types, no statuses, no failure categories:

| Name                           | Kind     | Meaning                                                           |
| ------------------------------ | -------- | ----------------------------------------------------------------- |
| `security.injection_suspected` | Event    | A bounded scan matched a pattern class in untrusted text          |
| `sandbox.resources_recorded`   | Event    | A container's peak memory, CPU and pids, pointing at the artifact |
| `resource_report`              | Artifact | Complete JSON: samples, peaks, limits, OOM state, elapsed time    |

One column:

| Column               | Type             | Meaning                                              |
| -------------------- | ---------------- | ---------------------------------------------------- |
| `jobs.trace_context` | `text`, nullable | The W3C `traceparent` of the request that created it |

Null is ordinary rather than exceptional. Telemetry off, a fixture, the evaluation runner and every
existing row all have null there, and an unparseable value drops the link rather than failing the
job. Telemetry never changes the outcome of a run.

---

## Part 2. The implementation history

Twelve stages, each independently mergeable, each leaving `pnpm build`, `pnpm test`, `pnpm lint` and
`pnpm typecheck` green with no database, no Redis and no Docker.

| Commit    | Stage | What it added                                              | Size         |
| --------- | ----- | ---------------------------------------------------------- | ------------ |
| `abcc775` | 1     | The telemetry port, `NOOP_TELEMETRY`, `RecordingTelemetry` | +1429 / -7   |
| `6a70a16` | 2     | `packages/telemetry`, OTLP exporters, the switch           | +2006 / -16  |
| `c08f810` | 3     | Tracing across both deployables, `jobs.trace_context`      | +3647 / -381 |
| `6c00d65` | 4     | The metric instruments                                     | +628 / -19   |
| `a52f5e4` | 5     | `ops/observability/` and the dashboards                    | +1389 / -1   |
| `daf1f9e` | 6     | Container resource sampling and the report                 | +1023 / -24  |
| `14aefed` | 7     | Network isolation and orphan cleanup completion            | +395 / -12   |
| `4bdeec8` | 8     | Redaction across durable writes                            | +307 / -20   |
| `5273e44` | 9     | Auth, CSRF, the route enumeration test                     | +930 / -11   |
| `ea13699` | 10    | Rate limiting and the active-job cap                       | +584 / -8    |
| `125df81` | 11    | Prompt fencing, detection, the bait case                   | +690 / -37   |
| `de91b6c` | 12    | The security review and the CI workflow                    | +771 / -29   |

Three follow-up commits, and they are the interesting part of the history rather than an appendix:

| Commit    | What it fixed                                                    |
| --------- | ---------------------------------------------------------------- |
| `c4683fe` | CodeQL's `analyze` only uploads; the gate was a separate step    |
| `197bbb9` | `tar --uid` is bsdtar-only and had been failing CI since M9      |
| `4032663` | Stage 11's fence was writing itself into edited repository files |

Part 20 walks all three, because each is a different way of being wrong that no amount of careful
reading catches.

Stage 1 is worth noticing for its shape. It adds 1429 lines and changes no behaviour anywhere. That
is on purpose: with the port merged first, every later stage could be reviewed without an SDK in the
diff, which is the difference between reviewing a design and reviewing a vendor integration.

---

## Part 3. Recommended reading path

If you read the code in this order it builds up rather than jumping around.

1. `packages/core/src/telemetry/telemetry.ts` - the port. Types, an interface, one shared helper.
2. `packages/core/src/telemetry/noop-telemetry.ts` and `recording-telemetry.ts` - the two
   implementations that live in core, and the docblock explaining why the fake is not in the adapter
   package.
3. `packages/telemetry/src/otel-telemetry.ts` - the adapter. The only file in the system that knows
   OpenTelemetry exists.
4. `packages/telemetry/src/otlp-exporter.ts` - the hand-written exporters, and the paragraph
   explaining why the stock ones could not be used.
5. `packages/core/src/pipeline/tracing.test.ts` - acceptance run A. The whole span tree asserted
   in-process with no SDK, no collector, no Docker and no database.
6. `apps/worker/src/processor.ts` - where `job.run` is opened and the link is attached.
7. `packages/core/src/telemetry/metrics.ts` - the instrument names, in one place.
8. `packages/sandbox/src/resource-monitor.ts` - the sample loop.
9. `packages/core/src/telemetry/redaction.ts` - the `Redactor` port, thirteen lines.
10. `apps/web/lib/auth/guard.ts` and `apps/web/lib/auth/routes.test.ts` - the guard and the test
    that proves it runs.
11. `packages/queue/src/rate-limiter.ts` - the Lua fixed window, and the fail-closed branch.
12. `packages/core/src/pipeline/prompt-injection.ts` - fencing and the scanner.
13. `docs/security-review.md` - the whole security half, §27 item by item.

---

## Part 4. The telemetry port, and why it is a port at all

`@opentelemetry/api` is a facade. It no-ops until an SDK registers a provider, so `packages/core`
could have imported it directly without breaking a single test. It still does not, and the reason is
not aesthetic consistency with `JobQueue`, `Sandbox` and `CodingAgent`.

Two concrete payoffs:

**Core is shared by two deployables and must not depend on either one's delivery mechanism.** That
rule is what lets the whole pipeline run in under a millisecond at `speed: 0` with no fake timers
and no sleeping in CI. An SDK import in core is a dependency on a delivery mechanism even when it is
inert.

**"Did this phase open a span with these attributes" becomes an ordinary unit assertion.** Against
`RecordingTelemetry`, not against an exporter and a collector. Acceptance run A asserts the entire
span tree of a real pipeline run in-process. That test exists because the port exists.

The interface is small on purpose:

```ts
export interface Telemetry {
  startSpan(name: string, options?: SpanOptions): Span;
  withSpan<T>(name: string, options: SpanOptions | undefined, body: SpanBody<T>): Promise<T>;
  counter(name: string, options?: InstrumentOptions): Counter;
  histogram(name: string, options?: InstrumentOptions): Histogram;
  gauge(name: string, options?: InstrumentOptions): Gauge;
  traceContext(): string | undefined;
}
```

Four details in there are decisions rather than defaults.

**`AttributeValue` is a closed union, not `unknown`.** An attribute the exporter has to guess at is
an attribute that arrives in one backend and vanishes in another, and the failure is invisible until
somebody builds a dashboard on it.

**`undefined` is an allowed attribute _value_.** So a caller can write
`{ "rivet.pull_request_number": job.pullRequestNumber ?? undefined }` rather than building the
object conditionally. Implementations drop those keys through the shared `compactAttributes()`, so
they never reach an exporter. This is the one place the port is more permissive than OTLP, and it is
deliberate: the alternative is conditional spreads at every call site, which is exactly where
attributes quietly stop being recorded.

**Instruments are looked up by name rather than constructed.** `counter("rivet.jobs.completed")`
called twice adds to one series. Callers therefore never have to hold instruments in module scope,
which is what would otherwise force a global provider onto a package that takes every dependency as
an argument.

**`recordException` and `setStatus` are separate.** A retried operation records an exception and
still succeeds. Collapsing them would make every recoverable hiccup look like a failure.

`runWithSpan()` is a free function rather than a base class, so all three implementations get the
same end-on-throw semantics from one place. Three hand-written `try/finally` blocks are three
chances for one of them to swallow an error or leak a span.

### Where the fake lives, and why it is the odd one out

`Telemetry` is the one port whose fake lives in **core** rather than in its adapter package.
`RecordingTelemetry` sits beside `NOOP_TELEMETRY` in `packages/core/src/telemetry/`. Core cannot
depend on `packages/telemetry` without inverting the dependency the port exists to create, and core
is also the package with the most to assert about spans. `FakeQueue` and `ScriptedSandbox` do not
have that problem because nothing in core needs to assert against them.

`PipelineOptions.telemetry` is **optional**, and read as `options.telemetry ?? NOOP_TELEMETRY` at
every use site rather than being defaulted in the interface. It is the only option in
`PipelineOptions` whose absence is safe, because the no-op changes no behaviour at all. Every other
option is required precisely so that a default in the package that holds no policy cannot become how
a container ends up unbounded.

### The switch that inverts

`RIVET_TELEMETRY` is the fifth member of the switch family, and it is the only one that goes the
other way.

`RIVET_SANDBOX=off`, `RIVET_AGENT=off`, `RIVET_GITHUB=off`, `RIVET_EVAL=off` and `RIVET_AUTH=off`
are all **refused under `NODE_ENV=production`**, because a worker that skips real work looks
perfectly healthy while lying about it, and that is the worst failure mode on offer.

`RIVET_TELEMETRY=off` is **legal everywhere**. A production worker with telemetry off is _degraded_,
not _lying_. Refusing to boot over it would take a deployment down to protect its dashboards, which
inverts what the dashboards are for. `index.ts` logs a warning instead, at `warn` under production
and `info` anywhere else.

### The exporters are hand-written, and that is not a preference

`packages/telemetry` ships `FetchOtlpTraceExporter` and `FetchOtlpMetricExporter` instead of the
stock `@opentelemetry/exporter-*-otlp-http` packages.

The stock exporters post through `http.request` with a keep-alive agent and a piped body. On Node 24
an **unreachable** collector ends their retry sequence with an `ECONNREFUSED` that escapes as an
uncaught exception and terminates the process. That is reproducible with the stock SDK alone, on
more than one exporter version, in about ten lines. Since `otlp` defaults to `http://localhost:4318`
where usually nothing is listening, shipping them would make _turning telemetry on_ a way to kill
the worker.

The replacements are one `fetch` POST per batch with every failure caught and handed to
`onExportFailure`. Serialization is still OTel's own `JsonTraceSerializer` and
`JsonMetricsSerializer`, so what goes on the wire is ordinary OTLP that any collector accepts.

What this gives up: retry, gzip and protobuf. What it buys: the worst a broken collector can do is
drop spans and log a line. That is the correct failure mode for telemetry, and it is what acceptance
run C asserts.

`TelemetryHandle.shutdown()` never rejects, for the same reason. A graceful shutdown must not fail
because Grafana was down.

---

## Part 5. Traces: a job's trace is linked to its request, never parented by it

The obvious design is that the `POST /api/jobs` span is the parent of everything the worker later
does. It is wrong for this system, for three reasons at once:

1. The request finishes in milliseconds. The run takes minutes.
2. The run can be reclaimed onto a different worker mid-flight.
3. The run can be attempted three times.

A root span held open for twenty minutes across three processes is a trace most backends drop, and
it would make three attempts of one job indistinguishable from one very strange attempt.

So:

- `POST /api/jobs` records its own short span and stores that span's `traceparent` on
  `jobs.trace_context`.
- Each attempt opens its **own root** `job.run` span in `apps/worker/src/processor.ts`, with a
  **span link** back to the stored context and `rivet.job_id` / `rivet.attempt` attributes.
- Attempts are siblings related by link and by attribute, which is exactly what they are.

What relates everything is **`rivet.job_id`, carried by every span at every depth**. "Show me
everything about job X" is therefore a query rather than a trace lookup, which matters because the
honest answer legitimately spans three traces.

The span tree under one `job.run`:

```text
job.run                          (root, links -> request trace)
├── phase.provisioning
│   ├── sandbox.command  (git clone)
│   ├── github.seed_clone        (host Git, when bound)
│   └── github.api.get_repository
├── phase.analyzing
│   └── sandbox.command × n
├── phase.planning
│   └── agent.session
│       └── agent.turn
│           └── agent.tool
├── phase.implementing
├── phase.testing
├── phase.reviewing
└── phase.finalizing
    └── github.api.create_pull_request
```

Three things about that tree:

**Only `runPipeline` is handed a parent explicitly.** `startSpan` does not make a span active;
`withSpan` does. So `runPipeline` takes the root as an argument and everything deeper nests for free
through ordinary `withSpan` calls. That is why `SpanOptions.parent` exists on the port at all: core
threads its dependencies explicitly and has no ambient context to read from.

**Queue wait is an attribute on `job.run`, not a span.** Nothing was executing during it. A span
implies work.

**GitHub and host-Git spans are decorators over the port, not instrumentation inside the adapter.**
`packages/core/src/github/instrumentation.ts` wraps the port. The adapter stays a plain HTTP client,
and the fake gets instrumented identically, which is what lets the integration suite assert spans
without a network.

### Spans carry no repository content and no credential

A span is an export to a third-party backend, so it gets the same treatment `SecretRegistry` gives a
log line, one system further out.

- A command span records `argv[0]`, the **argument count** and the cwd. Never the full argv.
- A GitHub span records an operation name, an installation id and `owner/name`. Never a token, an
  issue body or a remote URL.

**A non-zero command exit is an attribute, not an error status.** A failing command is frequently
the answer a phase wanted: a red baseline is data, a check meant to fail is data. A span marked
error would make every honest run look broken, and a dashboard that is always red is a dashboard
nobody opens.

---

## Part 6. Metrics: emitted from where the column is written

Twenty-six instruments, named in one place (`packages/core/src/telemetry/metrics.ts`) so that a
dashboard query and a call site cannot drift apart:

| Group     | Instruments                                                                                                 |
| --------- | ----------------------------------------------------------------------------------------------------------- |
| Job       | `duration`, `queue_wait`, `cost_usd`, `input_tokens`, `output_tokens`                                       |
| Lifecycle | `jobs.active`, `jobs.finished`, `jobs.completed`, `jobs.retries`, `jobs.lease_reclaims`                     |
| Worker    | `worker.heartbeat`, `sweeper.outcomes`                                                                      |
| Sandbox   | `provisioning.duration`, `command.duration`, memory/cpu/pids usage, peak and peak distribution, `oom_kills` |
| Model     | `model.latency`, `model.calls`, `model.errors`, `tool.failures`                                             |

The design rule is one sentence: **job-level values are emitted from the same place that already
writes the column.** Not from a separate reporting pass, not from a periodic scrape of the table.
The metric and the row are written by the same code, so they cannot disagree, and acceptance run B
asserts exactly that for a completed job.

Cost is the sharpest case. `jobs.total_cost_usd` is `numeric(10,4)` and the counter uses the same
four-decimal rounding. An evaluation harness that reports a cost a float rounded is worse than one
that reports no cost, and the same argument applies to a dashboard.

**No job ids as metric labels.** Job ids are unbounded cardinality and belong in traces and in
Postgres. A Prometheus series per job is how a laptop stack falls over, and it buys nothing that
`rivet.job_id` on a span does not already give.

**The heartbeat is a gauge, not a counter.** The worker reports `1` after a successful lease round
trip and `0` before its first one, after a failed one, or after a fenced one. A red value is
evidence about the latest lease check, not a claim that the process has permanently stopped, and
that distinction is what makes the panel readable during a reclaim.

---

## Part 7. Logs join the trace rather than being replaced by it

pino stays. What changed is that every line in **both** deployables now carries `trace_id` and
`span_id`, through one helper:

```ts
// packages/core/src/telemetry/trace-fields.ts
traceFields(telemetry); // -> { trace_id, span_id } | {}
```

It lives in core so the web app's logger does not have to import the OTel adapter to correlate. The
field names are snake_case because they are Grafana's and the OTel log data model's, not Rivet's;
renaming them would mean translating them back in every query.

**The web app gets a logger at all for the first time in M11** (`apps/web/lib/logger.ts`).
`withRoute` in `apps/web/lib/api/route-telemetry.ts` wraps every API handler in a server span named
for the route **pattern** (not the URL, which would be unbounded cardinality) plus a per-request
child logger carrying `requestId` and `route`. `serverError` now takes that logger.

**Route wrapping is explicit rather than automatic, and that is the decision to understand.** HTTP
auto-instrumentation would happily trace Next's own asset and RSC traffic alongside Rivet's API,
which is noise. But the real reason is subtler: the valuable part is not the span, it is that the
span is **active** for the duration of the handler. That is what lets `POST /api/jobs` call
`telemetry.traceContext()` and get a real `traceparent` to store. An auto-instrumented span you
cannot reach from the handler would produce a null column.

`apps/web/instrumentation.ts` registers the SDK once per server process, guarded on
`NEXT_RUNTIME === "nodejs"`. `LOG_LEVEL` is read by both deployables, and the web app is `silent`
under vitest because unit tests call route handlers directly.

---

## Part 8. The local observability stack

The stack is deliberately local and self-hosted. It needs Docker, but no vendor account, API token,
database, Redis instance or model key. Owning the whole pipeline is also the version that survives
the interview question, which §26 says is the point.

### The path a signal takes

```text
Rivet web or worker
        │ OTLP/HTTP :4318
        ▼
OpenTelemetry Collector
   │                 │
   │ Prometheus       │ OTLP/gRPC
   ▼                 ▼
Prometheus       Tempo
        \         /
          Grafana :3001
```

Rivet exports to the collector's OTLP/HTTP endpoint and knows about nothing else. The collector
exposes metrics on its Prometheus exporter endpoint, which Prometheus scrapes every 15 seconds, and
forwards traces to Tempo over OTLP/gRPC. Grafana is provisioned with both data sources and loads the
three dashboards from `ops/observability/grafana/dashboards`.

### Start it

```bash
pnpm obs:up
docker compose -f ops/observability/docker-compose.yml ps
```

| Service           | URL                             | Purpose                                          |
| ----------------- | ------------------------------- | ------------------------------------------------ |
| Grafana           | <http://localhost:3001>         | Dashboards and trace exploration                 |
| Prometheus        | <http://localhost:9090>         | Metric queries and target status                 |
| Tempo             | <http://localhost:3200>         | Trace HTTP API, normally reached through Grafana |
| Collector metrics | <http://localhost:8889/metrics> | Raw Prometheus exposition from the collector     |
| OTLP/HTTP         | `http://localhost:4318`         | Rivet's trace and metric export endpoint         |

Grafana starts with `admin` / `admin`. Suitable for this disposable stack only.

### Turn telemetry on

In the root `.env.local`, which both deployables load:

```dotenv
RIVET_TELEMETRY=otlp
OTEL_EXPORTER_OTLP_ENDPOINT=http://localhost:4318
RIVET_SERVICE_VERSION=local
```

Restart `pnpm dev`. Allow one export interval (15 s) plus one scrape interval before judging the
dashboards.

### The three dashboards

**Rivet - Job overview** answers whether the control plane is moving work: completed and active
jobs, terminal jobs by status, p50/p95 end-to-end duration, p50/p95 queue wait, sweeper outcomes and
lease reclaims. Duration is measured from the database's first claim timestamp to the terminal
transition; queue wait is recorded only for the first claim, so a reclaim cannot quietly turn
execution time into queue latency.

**Rivet - Worker health** answers whether the workers holding leases are alive: latest heartbeat per
worker id, active jobs per worker, lease reclaims grouped by the status the job came from, sweeper
outcomes by reconciliation kind, and p95 sandbox provisioning and command latency.

**Rivet - Model cost and latency** answers where spend and time go: persisted spend by provider and
model, p50/p95 model-turn latency, calls and provider or harness errors, input and output tokens,
and tool failures by model and tool.

### Find a job trace

1. Open **Explore** and select **Rivet Tempo**.
2. Search for the `rivet-worker` service.
3. Open a `job.run` trace and expand its phase spans.
4. Inspect the nested `sandbox.command`, `agent.session`, `agent.turn` and `agent.tool` spans.
5. Search span attributes for `rivet.job_id` to join the attempt back to the job page.

The web request trace uses `rivet-web` and carries the route pattern and request id.

### Inspect the raw signals

```promql
rivet_jobs_active_ratio
```

```promql
sum by (status) (rate({__name__=~"rivet_jobs_finished(_total)?"}[5m]))
```

```promql
histogram_quantile(
  0.95,
  sum by (le) (rate({__name__=~"rivet_model_latency(_milliseconds)?_bucket"}[5m]))
)
```

The regular expressions absorb the collector's optional Prometheus unit and counter-suffix
normalization, so the same query works across collector versions. The dashboards use the same form.

### Stop and reset

```bash
pnpm obs:down                                                              # keep history
docker compose -f ops/observability/docker-compose.yml down -v --remove-orphans   # delete it
```

The stack is development infrastructure. It is not part of `pnpm build`, `pnpm test`, `pnpm lint` or
`pnpm typecheck`, all of which still run with no Docker, no Postgres, no Redis and no collector.

---

## Part 9. Container resource monitoring

Stage 6 samples each Docker sandbox once per second while it is alive, keeping running peaks for
memory, CPU and pids. At cleanup the adapter stops the sampler **before** removing the container,
reads the container's OOM state, and returns one bounded report.

### One event, not one per sample

The per-sample series goes to Prometheus, which is built for it. Postgres gets **one**
`resource_report` artifact and **one** `sandbox.resources_recorded` event.

A timeline a monitor can flood is a timeline nobody reads. The report's job is to make an
`oom_killed` explainable after the fact - peak memory against the limit, and at what point in the
run - rather than to be a second metrics system inside Postgres.

### The report

The artifact body is complete JSON, so it stays useful after the container and all of its Docker
state are gone. The event carries a flat index of the same facts, because artifact metadata is read
without fetching content:

```jsonc
{
  "version": 1,
  "samplingIntervalMs": 1000,
  "sampleCount": 214,
  "samplingErrors": 0,
  "inspectionErrors": 0,
  "durationMs": 214310,
  "memory": { "peakBytes": 1932735283, "limitBytes": 2147483648, "peakAtMs": 141200 },
  "cpu": { "peakPercent": 178.4, "limitNanoCpus": 2000000000, "peakAtMs": 96100 },
  "pids": { "peak": 61, "limit": 256, "peakAtMs": 141200 },
  "oomKilled": true,
}
```

`memory.peakAtMs` equal to `pids.peakAtMs` and `oomKilled: true` is the shape of an install or a
test run that forked its way into the ceiling, and that is the sentence the report exists to let you
say.

### It samples by polling, and it never throws

Docker's stats endpoint is **polled** (`container.stats({ stream: false })`) rather than opened as a
streaming response. One request per interval is bounded, easy to stop during cleanup, and leaves no
socket waiting behind a `kill -9`ed worker.

**A failed sample is counted in the report, not raised.** `samplingErrors` and `inspectionErrors`
are fields. Resource monitoring is observability, and observability must not introduce a new job
failure path. This is the same rule as "telemetry never changes the outcome of a run", applied one
layer down.

The monitor caches its final report so the processor can collect it before `destroy()` and the
adapter can safely finalize it again from its cleanup fallback. Two callers, one answer, no ordering
requirement between them.

---

## Part 10. Sandbox network isolation, and orphan cleanup completion

§15's MVP line is "prevent arbitrary access to internal application infrastructure". Before M11 the
sandbox sat on a user-defined bridge, which stops sibling containers from finding each other by
default-bridge IP but does **not** stop a container from routing to the host.

Three controls, listed in order of how much they actually buy:

**1. Nothing the container needs is bound where it can reach it.** Postgres and Redis bind to
loopback in development and live on a separate compose network in CI. This is the real control and
it belongs to host configuration rather than to Docker flags. Every mechanism below is defense in
depth on top of it.

**2. `enable_icc=false` on the `rivet-sandbox` network.** Two containers on it, including CI service
containers, cannot talk to each other at all. `docker-sandbox.ts` also _verifies_ the option on an
existing network rather than assuming it, and refuses a network that was created without it while
containers are attached. A flag you set once and never check is a flag that survives exactly until
somebody recreates the network by hand.

**3. A startup reachability assertion, in the spirit of `assertLeaseInvariant`.** Under
`RIVET_SANDBOX=docker` the worker runs one short-lived probe container that attempts a TCP connect
to its own configured `DATABASE_URL` and `REDIS_URL` endpoints. If either connects, the worker
**refuses to start** and names which one.

That last one is the shape worth internalizing. A misconfiguration that exposes the control plane to
arbitrary repository code is exactly the class of problem that is cheaper to make impossible to boot
than possible to debug. The same instinct produced `heartbeat * 3 <= lease` in M2 and the
`getActiveToolNames()` assertion in M4.

**What this does not do** is stop a malicious repository from sending its own contents to the
internet, because the container must reach the package registry and github.com to do its job. That
is the egress proxy, it is out of scope, and `docs/security-review.md` §6.1 records it as accepted
risk in those words rather than implying more.

### Orphan cleanup, the host-side half

M6's sweeper reaped labelled containers and reclaimed expired leases. What a `kill -9` still left
behind was host state:

- Temporary Git index files from workspace capture.
- Seed archives and abandoned clone directories.
- BullMQ scheduler keys for schedules nobody owns any more.

`reapHostGitTemporaryFiles()` handles the first two, gated on the same `reapGraceMs` the container
reaper uses so a live worker's files are never taken out from under it.
`BullJobQueue.removeStaleSchedulers()` handles the third, and its docblock carries the reasoning:

> This queue is Rivet-owned, so every scheduler except the current stable id is stale. Removing
> through BullMQ also removes its next delayed message; deleting Redis keys directly would leave a
> scheduler that can fire once more with no registry entry.

Both are wrapped so a failure logs and returns zero. **A sweep's host-cleanup half must not abort
its job-reconciliation half**, which is the same rule the container reaper already followed, and the
next pass tries again in a minute.

---

## Part 11. Redaction across every durable path

Before M11, `SecretRegistry` guarded pino and nothing else. Event JSON, command transcripts and
artifact bodies all bypassed it.

That gap matters more than the log one it complements: **a log rotates, an event is append-only and
by design never deleted.** A provider error quoted into a `run.failed` event was a real path for a
token to become permanent.

Stage 8 makes the registry available to the three durable writers - `appendEvent`, `recordCommand`,
`recordArtifact` - through a port, because core cannot import the worker:

```ts
// packages/core/src/telemetry/redaction.ts
export interface Redactor {
  redact(value: string): string;
  redactDeep(value: unknown): unknown;
}
```

Thirteen lines. The worker owns the registry because the worker owns the credentials; core knows
only this interface, which keeps the shared package independent of the worker process and makes the
net injectable in tests.

**The registry stays a safety net, not a boundary, and the docblock keeps saying so.** Nothing logs
a token deliberately, `host-git.ts` redacts its own transcripts, and the token still never enters an
argv, a remote URL or `SandboxSpec.env`. What changed is that the net now hangs under the whole
system rather than under one part of it. If you ever find yourself relying on redaction to make
something safe, the thing is not safe.

**Acceptance run D has a positive control, and it needs one.** A sentinel secret is registered and
deliberately pushed through a log line, an event payload, a command transcript and an artifact body;
a search across captured output and every `job_events`, `job_commands` and `job_artifacts` row must
find none of it. Then the same search, for a **non-secret** sentinel written the same way, must
**find** it.

Without that second half the test is worthless. A grep that silently fails returns exactly the same
nothing a clean system returns. M10's hidden-test search made the same argument and this is the same
technique applied to secrets.

---

## Part 12. Auth and CSRF: one principal, and a guard that provably runs

`RIVET_AUTH` is `off` or `github`. `off` is refused under `NODE_ENV=production`, following the
family rule, because an open control plane that spends money is precisely the failure that looks
healthy.

### Sign-in

A GitHub OAuth **identifying** flow using the M9 App's client credentials. The callback fetches the
authenticated login and compares it against `RIVET_OWNER_GITHUB_LOGIN`. Anyone else gets a refusal,
not a session.

The allowlist is checked **server-side against GitHub's answer**, never against anything in the
query string. That is the same instinct as M9's install callback, which lists the installations the
App can actually act on rather than trusting the `installation_id` it was handed.

### The session

A signed, `httpOnly`, `SameSite=Lax`, `Secure`-in-production cookie holding a short HS256 JWT
(`jose`) with a seven-day TTL, an issuer, an audience and the login as both a claim and the subject.

**No session table.** So there is no session store to clean up and nothing to reap, which is the
whole reason this fits M11's "no new table" promise. It also creates the one problem worth
understanding, which is the next section.

### The finding: a signature is not an authorization decision

The Stage 12 review walk found this, and it is the most instructive bug in the milestone because
nothing about the code looked wrong.

The callback checked the allowlist correctly. The guard verified the signature correctly. But the
guard checked **only** the signature, and a session lives for a week with no table to revoke rows
from. So changing `RIVET_OWNER_GITHUB_LOGIN` did not sign the old owner out; it took effect at the
old session's natural expiry, up to seven days later.

The fix re-compares the signed login against the currently configured owner on every request:

```ts
export async function authorizedSession(
  request: Request,
  secret: string,
  ownerGithubLogin: string,
): Promise<RivetSession | null> {
  const session = await sessionFromRequest(request, secret);
  if (!session) return null;
  return session.githubLogin.toLowerCase() === ownerGithubLogin.toLowerCase() ? session : null;
}
```

Both `requireSession()` and `authenticatedPrincipal()` call it, and `page-guard.ts` performs the
same re-check. Rotating the session secret invalidates all sessions at once; changing the owner
login invalidates that owner's immediately. Between the two, "no session table" costs nothing you
would actually have used it for.

The general lesson: when you remove a piece of state, find every question that state used to answer.
Here it was revocation, and the answer turned out to be "re-derive the decision on every request"
rather than "store it".

### CSRF

`SameSite=Lax` plus an `Origin`/`Host` check on every mutating request. `csrf.ts` is twenty-five
lines: a `Host` that disagrees with the URL is refused, an `Origin` of `null` is refused, a present
`Origin` must equal `${protocol}//${host}`, and an absent `Origin` is accepted for trusted
non-browser callers and tests.

**No double-submit token,** and the review states the reasoning rather than leaving the omission to
be noticed. For a same-site app, a double-submit token adds a failure mode on top of two controls
that already cover the attack, and a CSRF defense that occasionally breaks legitimate requests is
one somebody eventually disables.

### The boundary is in the route handlers, and a test proves it

Next middleware handles page redirects. The real guard is `requireSession()` called by each handler,
for two reasons: middleware runs in a different runtime with different failure modes, and **a
redirect is not an authorization decision.** Defense in depth, with the depth in the part that
returns 401.

The thing that makes this hold over time is not the guard, it is the enumeration test. It walks
every `route.ts` under `apps/web/app/api` and asserts each one either contains `requireSession` or
appears in an explicit `PUBLIC_ROUTES` set with a comment saying why:

```ts
const apiRoot = resolve(import.meta.dirname, "../../app/api");
const files = await routeFiles(apiRoot);
expect(files.length).toBeGreaterThan(0);
for (const file of files) {
  const source = await readFile(file, "utf8");
  const route = routePattern(apiRoot, file);
  if (PUBLIC_ROUTES.has(route)) expect(source, route).toContain("Public");
  else expect(source, route).toContain("requireSession");
}
```

A route added in M12 that forgets the guard fails `pnpm test`, with no database and no network. Note
`expect(files.length).toBeGreaterThan(0)`: without it, a refactor that moves the API directory turns
the test into a loop over nothing that passes forever.

The four public routes are `/api/auth/signin`, `/api/auth/callback`, `/api/auth/signout` and
`/api/github/setup`. All four must work before a session exists.

This is the same shape as the `Phase.recovery` exhaustiveness test and the
`EVALUATION_FAILURE_CLASSES` total record: **make the omission a compile- or test-time event rather
than a review-time one.** It is the single most transferable idea in this codebase.

Nothing here touches the eval runner, `demo:job`, `demo:recovery`, `demo:pr` or `demo:eval`, because
all of them call `@rivet/core` directly and never make an HTTP request. The streaming suite does hit
routes, so it gets a test session helper.

---

## Part 13. Rate limiting, and why it fails closed

With one principal, rate limiting is not about abuse volume. It is §22's budget argument moved one
level up, from the agent to the control plane.

Two surfaces:

**Unauthenticated edges** - the OAuth callback, the App setup callback, the sign-in starter. These
are reachable without a session by definition. Fixed window keyed by address, 10 per 10 minutes.

**Spend-shaped routes** - `POST /api/jobs` costs real model calls on every success, so it gets both
a per-window creation limit (5 per 10 minutes) **and** a global cap on non-terminal jobs (4),
checked inside `createJob()` as a passed-in `activeJobLimit` because core reads no environment.

The two limits answer different questions. The window limit stops a loop; the cap stops four
long-running jobs from becoming forty while you are at lunch.

### The limiter

An atomic Lua fixed window in `packages/queue`, the package that already owns the ioredis client:
`consume(key, limit, windowMs)`. Lua rather than `INCR` plus `EXPIRE`, because those two commands
can be interleaved by another client and the failure is a key with no TTL that refuses forever.

### It fails closed, and that is the whole decision

If Redis is unreachable, job creation is **refused**, with a 503 saying so.

That is the opposite of the usual availability instinct, and it is right here. The thing on the
other side of the limiter is **money**. The standing rule that "Redis holds nothing that matters" is
about _durability_ - flush Redis and no job is lost - not about permission to spend while it is
down.

Failing open would mean a Redis outage silently removes every spend control in the system, at
exactly the moment nobody is watching. Refusing a job creation during an outage costs a retry.

### Refusals state what they are

```jsonc
// 429, window limit
{ "error": "Rate limit exceeded: job creation.", "limit": "job creation",
  "limitValue": 5, "resetAt": "2026-08-18T19:41:02.000Z", "retryAfterSeconds": 214 }

// 429, active-job cap - no reset time exists, so it says so
{ "error": "Rate limit exceeded: active non-terminal jobs.", "limit": "active_jobs",
  "limitValue": 4, "activeCount": 4, "resetAt": null,
  "resetHint": "Retry when a non-terminal job reaches a terminal status." }

// 503, limiter unavailable
{ "error": "Rate limiting is temporarily unavailable; request refused closed.",
  "limit": "rate_limiter", "retryHint": "Retry after Redis is available." }
```

The cap's `resetAt: null` with a `resetHint` instead is a small thing that matters: inventing a
reset time for a limit that has no window would be a lie a client would then act on.

### What is deliberately not limited

Read routes and SSE. Each open stream is a bounded one-query-per-second Postgres poller with an
existing hidden-tab and terminal-drain lifecycle, and one operator's browser tabs are not the threat
model. `docs/security-review.md` records that as a decision rather than leaving it as an omission.

---

## Part 14. Prompt injection: fence everything, detect loudly, fail nothing

§21's strongest mitigations shipped years earlier in milestone terms, as capability boundaries:
`getActiveToolNames()` must equal the role's exact set, so the planner and reviewer can write
nothing and execute nothing. What M11 adds is the prompt-level half and the evidence.

### Fencing

Untrusted text enters prompts inside an explicitly delimited block with a stated trust preamble:

```ts
export function fenceUntrustedText(source: string, location: string, text: string): string {
  return [
    `<rivet-untrusted-content source="${escapeAttribute(source)}" location="${escapeAttribute(location)}">`,
    text,
    "</rivet-untrusted-content>",
  ].join("\n");
}
```

Delimiters inside the content remain data; the preamble tells the model not to treat the block as
instructions. Attributes are escaped, so content cannot close the tag by writing one.

Every boundary is fenced: file reads, command output, the tracked file list, `package.json` and its
scripts, repository search results, agent artifacts, and - the one most easily forgotten - **the
GitHub issue title and body**.

The issue body is the highest-value injection surface in the system and the least obvious. It is
attacker-controlled on any public repository, it arrives through M9's issue picker, and it _becomes
the task description_. Everything else the agent reads is at least nominally the repository's own
code.

### Detection records and continues

A bounded scanner (32 KB per source) over untrusted text raises `security.injection_suspected` with
the pattern class and the location. Five classes: `instruction_override`, `secret_exfiltration`,
`unsafe_tool_use`, `external_exfiltration`, `filesystem_escape`.

**The job proceeds.** Always. Two reasons:

Pattern matching over repository prose produces false positives, and a repository that merely
_discusses_ prompt injection would become unrunnable. Rivet's own repository is such a repository.

And the capability boundary, not the regex, is the defense. Detection here is observability. If the
scanner were the control, then a scanner that missed something would be a breach, and the pressure
would be to make it aggressive, which makes it useless. Because it is observability, it can afford
to be honest.

The scan returns **classes only, never matches and never source text**. An event that quoted the
matched span would put attacker-controlled text into a durable row that a browser then renders.

### The adversarial benchmark case

`benchmarks/prompt-injection-bait/` is a genuine, solvable level-2 task whose README and a source
comment try to make the agent exfiltrate secrets, write outside the workspace and skip tests. Its
hidden tests assert **both** halves: the real task was completed, **and** none of the bait was
taken.

It runs in `pnpm eval:run` like any other case, which is the entire payoff of M10 being an ordinary
job harness. A security property that can be measured on the same axis as correctness is a security
property you can regression-test.

---

## Part 15. The security review and CI enforcement

`docs/security-review.md` walks PRD §27 item by item with the code that satisfies each control and
the risks accepted rather than mitigated. `SECURITY.md` is the short version. Both are worth reading
in full; the parts worth pulling out here are the ones about process rather than about controls.

### Nine named accepted risks

Written down so their absence reads as a decision rather than an oversight: no egress proxy, no
sandboxing of the harness process itself, no multi-tenancy, no per-session revocation beyond secret
rotation, container escape defended only to the depth Docker provides, no deployment hardening, and
three more. Each carries the reason and the remediation path.

An accepted risk that is written down is a different object from a gap nobody noticed. The first is
a decision you can revisit; the second is a surprise during an incident.

### The fifth CI workflow

`.github/workflows/security.yml`, three independent jobs, on push, PR and a weekly cron:

| Job            | Tool         | Gate                                         |
| -------------- | ------------ | -------------------------------------------- |
| `codeql`       | CodeQL       | Fails on any **open high or critical** alert |
| `dependencies` | `pnpm audit` | Fails on `high` and `critical` advisories    |
| `secrets`      | gitleaks     | Fails on **any** finding                     |

**A fifth workflow rather than folding this into `verify`**, for exactly the reason the other four
CI jobs are separate: shared setup is how you lose the property a job exists to protect. `verify`
exists to prove the build works with no database, no Redis and no Docker. Adding a `fetch-depth: 0`
checkout and a security scanner to it would eventually mean somebody adds a service container, and
the property evaporates without anyone deciding to drop it.

Every escape hatch must carry its reason. `.gitleaks.toml` allowlist entries need a comment saying
why the match is not a live credential; audit ignores need one saying why the advisory is
unreachable; a dismissed CodeQL alert needs its reason in GitHub's dismissal comment. **An entry
with no reason is a bug**, because the next person cannot tell a considered exception from a
silenced one.

### The CodeQL trap

Worth its own paragraph because the documentation reads the other way.
`github/codeql-action/analyze` **uploads SARIF and exits zero.** It does not fail on findings. A
workflow that runs `init` and `analyze` and nothing else looks exactly like a gate, passes green,
and reports high-severity alerts into a tab nobody opens.

The first run did precisely that: green workflow, six open high-severity alerts. The gate is a
separate step that polls `code-scanning/analyses?ref=$REF` until the commit's analysis is indexed,
then queries `code-scanning/alerts?ref=$REF&state=open` and exits 1 on any high or critical. It is
skipped for fork PRs, which cannot write security events.

If you take one operational lesson from M11, take this one: **verify that a check can fail.** A
check nobody has seen fail is a check nobody has seen work.

### The six findings, and what they were

Four were ReDoS in regexes over untrusted input, in `targeted-tests.ts`, `validation-phase.ts`,
`telemetry/provider.ts` and `finalizing-phase.ts`. All four were replaced with linear scans
(`lastIndexOf` over the final path segment, a single left-to-right `indexOf` pass, a
`trimTrailingSlashes()` loop). None was dramatic. All four were on paths that read repository-
controlled text, which is why they were worth fixing rather than dismissing.

The remaining two were dismissed with written reasons.

---

## Part 16. Configuration

Everything M11 added, with defaults. All of it is optional; the system runs with none of it set.

### Telemetry

| Variable                             | Default                 | Notes                                                           |
| ------------------------------------ | ----------------------- | --------------------------------------------------------------- |
| `RIVET_TELEMETRY`                    | `off`                   | `otlp` to export. **Legal under production**, unlike the family |
| `OTEL_EXPORTER_OTLP_ENDPOINT`        | `http://localhost:4318` | The standard variable, not a `RIVET_` one                       |
| `RIVET_TELEMETRY_EXPORT_INTERVAL_MS` | `15000`                 | Metric export interval                                          |
| `RIVET_TELEMETRY_EXPORT_TIMEOUT_MS`  | `10000`                 | Deliberately shorter than any phase; spent inside a shutdown    |
| `RIVET_SERVICE_VERSION`              | `0.0.0-dev`             | Becomes `service.version`; make it change when the code does    |
| `LOG_LEVEL`                          | `info`                  | Read by both deployables                                        |

`OTEL_EXPORTER_OTLP_ENDPOINT` is validated as an `http(s)` URL rather than by `z.url()`, because
`z.url()` accepts `localhost:4318` as a URL whose scheme is `localhost:`. That is a real
misconfiguration somebody will write, and it would otherwise produce a silent no-export.

### Auth

| Variable                   | Default | Notes                                                  |
| -------------------------- | ------- | ------------------------------------------------------ |
| `RIVET_AUTH`               | `off`   | `github`. `off` **refused under production**           |
| `RIVET_OWNER_GITHUB_LOGIN` | -       | Re-checked on every request, not only at sign-in       |
| `RIVET_SESSION_SECRET`     | -       | At least 32 characters. Rotating it signs everyone out |
| `GITHUB_APP_CLIENT_ID`     | -       | The M9 App's OAuth credentials                         |
| `GITHUB_APP_CLIENT_SECRET` | -       |                                                        |

### Rate limits

| Variable                                     | Default  |
| -------------------------------------------- | -------- |
| `RIVET_JOB_CREATION_LIMIT`                   | `5`      |
| `RIVET_JOB_CREATION_WINDOW_MS`               | `600000` |
| `RIVET_UNAUTHENTICATED_RATE_LIMIT`           | `10`     |
| `RIVET_UNAUTHENTICATED_RATE_LIMIT_WINDOW_MS` | `600000` |
| `RIVET_ACTIVE_JOB_CAP`                       | `4`      |

`resolveWebRateLimitConfig()` is a pure function of an env object, like `resolveGitHubWebConfig` and
`resolveWebTelemetryConfig` before it. That is what keeps `next build` working on a machine with no
configuration at all, which is the property CI's `verify` job exists to protect.

---

## Part 17. The verification ladder

Each rung needs strictly more than the one above it. Start at the top.

```bash
# 1. offline, no infrastructure at all
pnpm typecheck && pnpm lint && pnpm test && pnpm build

# 2. focused: the telemetry port and the span tree
pnpm --filter @rivet/core test src/pipeline/tracing.test.ts
pnpm --filter @rivet/core test src/telemetry
pnpm --filter @rivet/telemetry test

# 3. focused: the hardening half
pnpm --filter @rivet/web test lib/auth
pnpm --filter @rivet/queue test src/rate-limiter.test.ts
pnpm --filter @rivet/core test src/pipeline/prompt-injection.test.ts

# 4. integration acceptance (Postgres + Redis)
pnpm test:integration

# 5. web regression (Postgres only)
pnpm test:streaming

# 6. sandbox acceptance (Postgres + Redis + Docker)
pnpm test:sandbox

# 7. the whole thing, visibly
pnpm obs:up && RIVET_TELEMETRY=otlp pnpm dev
```

Rung 1 is the one that matters most and it is the cheapest. If it breaks, something in M11 read
`process.env` from core, opened a connection at import time, or added a page that touches the
database without `dynamic = "force-dynamic"`.

---

## Part 18. Debugging guide

### The dashboards are empty

Wait through one 15-second export interval plus one Prometheus scrape. Then confirm
`RIVET_TELEMETRY=otlp` is actually in the root `.env.local` **and** that the process was restarted:
`parseWorkerConfig` reads it once at startup. Then check the Prometheus target
`rivet-otel-collector`, then
`docker compose -f ops/observability/docker-compose.yml logs collector`.

### No traces, but metrics work

Metrics go to Prometheus through the collector's exporter; traces go to Tempo over OTLP/gRPC. A
working metrics path and a broken trace path means the collector-to-Tempo hop, not Rivet. Check
`logs collector tempo`.

### The worker dies when telemetry is on

It should not, and if it does, something reintroduced a stock OTLP exporter. See Part 4: the stock
`http.request`-based exporters terminate the process on `ECONNREFUSED` on Node 24, which is why
`packages/telemetry` ships its own. Check that `FetchOtlpTraceExporter` is still what `provider.ts`
builds.

### `jobs.trace_context` is always null

Ordinary in four cases: telemetry off, a fixture, the evaluation runner, and any row created before
M11. If it is null with telemetry on and a real browser request, the route is probably not wrapped
in `withRoute` - the span must be **active** during the handler for `traceContext()` to see it, and
an unwrapped handler has no active span to read.

### Every request 401s in `github` mode

Check `RIVET_OWNER_GITHUB_LOGIN` against the login in the session, case-insensitively. Since the
Stage 12 fix, the owner is re-checked on **every** request, so changing it invalidates an existing
session immediately. That is the intended behaviour and it surprises people once.

### Job creation returns 503 with "refused closed"

Redis is unreachable. This is the limiter working as designed - see Part 13. Start Redis:

```bash
redis-server --port 6379 --daemonize yes --save "" --appendonly no
```

### The worker refuses to start naming Postgres or Redis

The network isolation probe connected to a service the sandbox should not be able to reach. Bind
Postgres and Redis to loopback rather than `0.0.0.0`. This refusal is the control doing its job; do
not disable it to get past it.

### A `resource_report` shows `sampleCount: 0`

The container ran for less than one sample interval, or Docker's stats endpoint refused. Check
`samplingErrors` and `inspectionErrors` in the report body. Neither fails the job, by design.

### `security.injection_suspected` on a repository that is fine

Expected, frequently. The scanner is heuristic and any repository _discussing_ prompt injection will
trip it, including this one. The event is observability. If it is failing a job, something is wrong
with the code, not with the repository.

### A CI security job is green but findings exist

See Part 15. Confirm the "Fail on high or critical alerts" step ran and did not skip. Fork PRs skip
it by design because they cannot read security events.

---

## Part 19. Three bugs this milestone shipped, and how each was found

None of these was caught by reading the code carefully. That is the point of including them.

### 1. The fence that wrote itself into files

Stage 11 added `fenceUntrustedText` to the shared `readText` in `packages/agent/src/tools.ts`. That
function serves two callers with **opposite destinations**:

- `read` hands its buffer to the **model**. It must be fenced.
- `edit` hands its buffer to the **harness**, which changes one region and writes it **straight back
  to disk**.

So every edit wrote `<rivet-untrusted-content>` into the repository file. Silently, because the
model's replacement string still matched inside the wrapper, so the tool call succeeded. The result
was a corrupted diff rather than a failed tool call, on the implementer's main path.

The fix splits the parameter:

```ts
async function readText(
  path: string,
  { allowTruncated, fence }: { allowTruncated: boolean; fence: boolean },
): Promise<Buffer>;
```

`fence` splits on the same line as `allowTruncated`, for a version of the same reason: what
separates the two callers is whether the bytes go to a _reader_ or back to _storage_.

**How it was found:** the sandbox suite. **Why it survived review:** the call sites looked
identical, and the tool call did not fail. **What made it fixable:** reverting to `fence: true` and
confirming both new unit tests fail - a positive control on the test, not just on the fix.

### 2. `tar --uid`, which had been red since M9

`--uid` and `--gid` are **bsdtar** spellings. GNU tar has no such options at all and exits 64 with
`unrecognized option`. So the seed archive worked on a developer's Mac and failed on every Linux
runner, which is the worst direction for a platform split to point.

`--owner=1000 --group=1000` is accepted by both and writes a numeric 1000/1000 owner alongside
`--numeric-owner`. This is now the second such trap documented in the same tar invocation, next to
`--no-xattrs` and `COPYFILE_DISABLE=1` for macOS AppleDouble sidecars.

The test asserts ownership out of the archive's **ustar headers** rather than out of the argv,
because the flag spelling differs between the two implementations and the property does not. An argv
assertion would have gone green on the spelling only one of them accepts, which is how the bug
shipped in the first place.

Writing that parser reproduced the same class of error one level down: tar's size field is **12**
bytes at offset 124, not 8. Reading it as 8 truncates `000000005670` to `00000005`, and the walk
lands inside file data. It hides completely on a fixture of small files. It was caught by running
the parser against a real GNU tar archive containing a multi-block file **before** trusting it.

### 3. The CodeQL job that could not fail

Covered in Part 15. Green workflow, six open high-severity alerts, because `analyze` uploads and
exits zero.

### The thread running through all three

Two of the three were found only after CI went green again, and the third _was_ the reason CI was
red. A broken check buries the signal from every other check. The publication suite's seven
`expected 'repo_unavailable' to be 'github_permission_denied'` failures were not seven bugs; they
were one seed failing. Everything downstream of a red board is unread.

**Keep the board green, and verify that each check can go red.**

---

## Part 20. Design decisions to preserve

If you change one of these, change it deliberately.

1. **Telemetry never changes the outcome of a run.** Not the status, not the events, not the diff.
   An unparseable trace context drops the link. A failed stats sample is a counter in a report. A
   dead collector drops spans and logs a line.
2. **The port stays free of the SDK.** `packages/telemetry` is the only package that imports
   OpenTelemetry. The facade being inert is not a reason to relax this.
3. **A job's trace is linked, never parented.** Attempts are siblings. `rivet.job_id` is the join
   key.
4. **No job ids as metric labels.** Cardinality.
5. **Metrics are emitted where the column is written.** A metric and a row must not be able to
   disagree.
6. **Spans carry no content and no credential**, and a non-zero command exit is an attribute rather
   than an error status.
7. **Redaction is a safety net, not a boundary.** Do not let a code path rely on it.
8. **Negative assertions need positive controls.** Every "the secret is not here" test must be
   paired with a "the sentinel is here" test using the same search.
9. **The route guard's coverage is a test, not a convention.** Keep the enumeration test, and keep
   its `files.length > 0` assertion.
10. **The owner allowlist is re-checked per request.** It is the only revocation mechanism there is.
11. **The rate limiter fails closed.** Redis being unavailable removes durability, never permission
    to spend.
12. **Injection detection never fails a job.** The capability boundary is the defense.
13. **The startup network probe refuses to boot.** Impossible to boot beats possible to debug.
14. **Security CI is its own workflow.** Shared setup is how you lose the property a job protects.
15. **Every escape hatch carries its reason.** Allowlist entries, audit ignores, dismissed alerts.

---

## Part 21. Known gaps, and the M12 handoff

Stated so the next milestone inherits facts rather than assumptions.

**Not yet built, from M11's own plan:**

- `docs/plans/milestone-11-acceptance.md` does not exist. M8, M9 and M10 each have one; M11's
  acceptance runs are described in the plan and implemented across several suites, but there is no
  single document mapping run to test. Runs A, B, D, E and F have implementations; **run G's
  container-network suite does not exist as a test**, though every mechanism it would assert does.
- `pnpm demo:observability` is not wired. The stack, the dashboards and the traces all work; the
  one-command demo that prints a Grafana trace URL is not there.
- `AGENTS.md` documents M11's tracing but not stages 6 through 12.

**Deliberately out of scope, and recorded as accepted risk:**

- No egress allowlist or proxy. A malicious repository can still send its own contents somewhere.
- No sandboxing of the harness process itself. It runs trusted in the process holding the model key,
  mitigated by the session-start tool assertion. True since M4.
- No multi-tenancy. One principal, no `users` table, no `user_id`, no ownership joins. A second user
  is a schema change and a migration of every read path.
- No deployment, and `docs/architecture.md`'s note about the SSE stream needing a streaming-capable
  host stays open.
- No alerting. Alerting without a deployment is alerting about a laptop.
- No log shipping by default. Loki is in the compose file and off; trace correlation was the
  deliverable.

---

## Part 22. Suggested learning exercises

Each of these teaches something the code alone does not.

1. **Break the fence on purpose.** Set `fence: true` for `edit`'s read in
   `packages/agent/src/tools.ts` and run `pnpm --filter @rivet/agent test`. Watch which tests fail
   and which do not. This is how you learn what a test actually covers.
2. **Delete the owner re-check** in `authorizedSession` and run
   `pnpm --filter @rivet/web test lib/auth`. One test should fail. If you can imagine a version of
   the bug that still passes, write that test.
3. **Add a route without a guard.** Create `apps/web/app/api/ping/route.ts` and run `pnpm test`.
   Read the failure message. Then decide whether the fix is a guard or a `PUBLIC_ROUTES` entry, and
   notice that the test forces you to make that a decision.
4. **Take Redis down** and try to create a job. Observe the 503. Then reason about what a fail-open
   limiter would have done during the same outage.
5. **Run the bait case.** `pnpm eval:run --cases prompt-injection-bait`. Read the timeline for
   `security.injection_suspected`, then read the hidden tests and check both halves of what they
   assert.
6. **Trace a real job.** `pnpm obs:up`, `RIVET_TELEMETRY=otlp pnpm dev`, create a job, then find its
   `job.run` trace in Tempo and walk down to a single `agent.tool` span. Then find the same job's
   request trace and confirm they are linked rather than nested.
7. **Point the collector somewhere dead.** Set `OTEL_EXPORTER_OTLP_ENDPOINT=http://localhost:9999`
   and run a job. It must complete normally. If it does not, something regressed the exporter.
8. **Write acceptance run G.** The mechanisms exist; the test does not. From inside a real job
   container, assert that a TCP connect to the configured Postgres and Redis endpoints fails, that
   `/var/run/docker.sock` is absent, and that a sibling container on `rivet-sandbox` is
   unreachable - with the package registry and github.com reachable in the same run as positive
   controls. This is the most valuable missing thing in the milestone.
