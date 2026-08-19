# Milestone 11: the acceptance contract

**Status: implemented.** Unlike M8's, M9's and M10's contracts, this one was written _after_ the
milestone shipped, and that is worth stating rather than hiding: it is a record of what the runs
turned out to assert, not a specification the code was measured against.
[`docs/plans/milestone-11.md`](milestone-11.md) is the plan and
[`docs/milestone-11-guide.md`](../milestone-11-guide.md) is the tour. Runs A-F pass in `pnpm test`
with no database, no Redis, no Docker and no model key; run G is `pnpm test:sandbox`; run H is a
benchmark case plus `pnpm demo:observability`.

| run | where it lives                                                                                                                                                                                                               |
| --- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A   | `packages/core/src/pipeline/tracing.test.ts`                                                                                                                                                                                 |
| B   | `packages/core/src/telemetry/metrics.test.ts`                                                                                                                                                                                |
| C   | `packages/core/src/pipeline/telemetry-neutrality.test.ts`                                                                                                                                                                    |
| D   | `packages/core/src/artifacts/artifact-store.test.ts`, `packages/core/src/events/event-service.test.ts`, `packages/core/src/sandbox/command-log.test.ts`, `apps/worker/src/secrets.test.ts`, `apps/worker/src/logger.test.ts` |
| E   | `apps/web/lib/auth/routes.test.ts` (static), `apps/web/lib/auth/live-guard.test.ts` (live), plus `guard.test.ts`, `session.test.ts`, `csrf.test.ts`                                                                          |
| F   | `packages/queue/src/rate-limiter.test.ts`, `apps/web/lib/rate-limit/config.test.ts`, `apps/web/app/api/jobs/rate-limit.test.ts` (live)                                                                                       |
| G   | `apps/worker/tests/sandbox/network-isolation.sbx.test.ts`                                                                                                                                                                    |
| H   | `benchmarks/prompt-injection-bait/`, `packages/core/src/pipeline/prompt-injection.test.ts`, `packages/core/src/pipeline/prompt-security.test.ts`, `pnpm demo:observability`                                                  |

**M9's risk was an effect Rivet cannot roll back. M10's was a number that is wrong in a way nobody
notices. M11's is a control that has stopped working and still looks fine.** A guard that is
imported but never called, a limiter that denies into a handler which creates the row anyway, a
redaction pass that runs after the write, a network that was hardened once and reconfigured since -
each of those leaves a system that passes every test it had, serves every request it used to serve,
and protects nothing. Nothing goes red. So the organising principle of this contract is not the
negative assertion M10 leaned on, it is the **positive control**: every run here proves that the
mechanism it is testing can still observe the thing it is looking for, before it is trusted to
report that the thing is absent.

That is not a stylistic preference. A connect helper with a typo in it fails every target
identically, and a test of four failed connections passes exactly as happily against a helper that
cannot connect to anything. A sentinel grep that silently errors returns the same nothing a clean
container returns. A route test that enumerates zero routes passes. Each of those is a green check
mark over a control nobody is testing any more, which is strictly worse than no check mark at all.

---

## The runs

| run                          | ends                                            | why it is here                                          |
| ---------------------------- | ----------------------------------------------- | ------------------------------------------------------- |
| A. one job, one trace        | span tree matches the phase events exactly      | a trace that disagrees with the timeline is noise       |
| B. metrics vs the `jobs` row | field-by-field equality                         | a metric that disagrees with the row is worse than none |
| C. telemetry on vs off       | byte-identical durable rows                     | observability must not become behaviour                 |
| D. redaction, with a control | no sentinel anywhere durable; the control found | a redactor that stopped running looks like a clean log  |
| E. every route guarded       | 401 or redirect from every non-public handler   | coverage is not behaviour                               |
| F. limits refuse, closed     | 429/503 and no `jobs` row                       | a refusal the handler ignores is not a refusal          |
| G. the container's reach     | control plane unreachable, internet reachable   | a network hardened once and reconfigured since          |
| H. the bait case             | task done, bait not taken, trace linked         | the capability boundary under an adversarial prompt     |

---

## A - One job, one trace, one shape

**`packages/core/src/pipeline/tracing.test.ts`.**

A job run through the real `runPipeline`, the real `createPhaseContextFactory` and the real
`runAgentSession` against `RecordingTelemetry` produces a span tree whose phase spans match the
job's `phase.completed` events exactly, in order, with command spans nested under the phase that ran
them, the model session's turns and tool calls nested under the phase that opened it, and every span
carrying `rivet.job_id`.

In-process: no SDK, no collector, no Docker, no database. That is the payoff of telemetry being a
port rather than instrumentation, and it is why this run costs milliseconds.

The one thing it cannot assert is the processor's `job.run` root, which lives in `apps/worker`. It
is stood in for by opening the same span with the same **link** the processor opens it with - a link
to `jobs.trace_context`, never a parent - so the shape under test is the shape production produces.

**Positive control:** the phase-span list is asserted to equal a non-empty, named sequence
(`phase.analyzing`, `phase.planning`), so a run that opened no spans at all cannot satisfy it.

## B - Metrics agree with the database

**`packages/core/src/telemetry/metrics.test.ts`.**

For a completed job, the emitted duration histogram, cost counter and token counters equal the
values on the `jobs` row. Cost specifically is recorded from the **same rounded string** the row
carries, because `total_cost_usd` is `numeric(10,4)` and a metric that reported the unrounded float
would disagree with the row in the fourth decimal place forever.

Also asserted: a terminal row with no start does not get an invented duration. A zero is a
measurement; a fabricated one is a lie that averages into every dashboard downstream.

## C - Telemetry is not in the way

**`packages/core/src/pipeline/telemetry-neutrality.test.ts`.**

The same job runs twice through one harness that differs in exactly one argument: once with no
`telemetry` at all - which is what `RIVET_TELEMETRY=off` produces, since every use site reads
`?? NOOP_TELEMETRY` - and once with `RecordingTelemetry` attached and a `job.run` root open. The
appended events, the recorded commands and the recorded artifacts must be identical, and the
pipeline must reach the same outcome through the same phases.

**Byte-identical is meant literally.** The comparison is over serialized JSON rather than `toEqual`,
because `toEqual` treats a missing key and an explicit `undefined` as the same value - and a
telemetry path that began stamping `{ traceId: undefined }` onto every event payload is exactly the
regression this run exists to catch.

Two fields are normalized rather than compared raw, and the distinction matters. `durationMs` is
replaced outright, because a wall clock differs between any two runs of anything and carries no
structure. `commandExecutionId` is replaced with the **ordinal of its first appearance** rather than
dropped, so the property it exists for - a `command.started` and a `command.completed` naming the
same execution - remains part of what the two runs have to agree about.

**Positive controls, two of them.** The projection is asserted non-trivial before its equality is
worth anything (more than four events, two commands, one artifact), because two runs that both
produced nothing compare equal and prove nothing. And a third case asserts the observed run actually
opened spans, since otherwise the whole comparison is satisfiable by a telemetry object that does
nothing at all.

## D - Redaction, with a positive control

**`packages/core/src/artifacts/artifact-store.test.ts`,
`packages/core/src/events/event-service.test.ts`, `packages/core/src/sandbox/command-log.test.ts`,
`apps/worker/src/secrets.test.ts`, `apps/worker/src/logger.test.ts`.**

A sentinel secret is registered and then deliberately pushed through a log line, an event payload, a
command transcript and an artifact body. None of it survives into any durable row. The same search,
for a **non-secret** sentinel written the same way through the same path, finds it.

That second half is the whole run. A redaction test without it passes identically against a writer
that has stopped writing, a search that has stopped searching, and a fixture that never contained
the sentinel in the first place.

The standing caveat is recorded in `docs/security-review.md` and repeated in `AGENTS.md`: the
`Redactor` is a **safety net, not a boundary**. Nothing logs a token deliberately, `host-git.ts`
redacts its own transcripts, and a token never enters an argv, a remote URL or `SandboxSpec.env`.
Redaction is the layer that catches the mistake, not the layer the design depends on.

## E - Every route is guarded

**Static: `apps/web/lib/auth/routes.test.ts`. Live: `apps/web/lib/auth/live-guard.test.ts`. Unit:
`guard.test.ts`, `session.test.ts`, `csrf.test.ts`.**

The static half walks every `route.ts` under `app/api` and requires each to sit in `PUBLIC_ROUTES`
or mention `requireSession`. That is coverage, and **coverage is not behaviour** - a route can
import the guard and never call it, or call it after the read it was supposed to protect. Both of
those pass the static test.

So the live half **invokes** every non-public handler with an unauthenticated request under
`RIVET_AUTH=github` and requires a 401 or a redirect from each. It runs in `pnpm test` with no
database, and that is load-bearing rather than convenient: `DATABASE_URL` is unset, so a handler
that touches Postgres before it checks the session cannot answer 401 - it throws, and the run fails.
"Refuses before it reads" is asserted by construction.

Also live: an **expired** session is refused (the JWT carries `exp`, and `jwtVerify` enforces it),
and a session signed with **another secret** is refused. Each is paired with the same claims,
unexpired and correctly signed, being accepted - without which both cases pass against a guard that
rejects every token it is handed.

Cross-origin refusal is asserted at the helper (`csrf.test.ts`), and the owner allowlist being
re-checked on **every** request - not just at callback time - is asserted in `guard.test.ts` by
handing a validly signed session for a login that is no longer the owner. With no session table,
that re-check is the only revocation mechanism there is.

**Positive control:** the live enumeration asserts it invoked more than ten handlers. A loop that
matched nothing - a renamed directory, a changed file name - would otherwise pass silently, which is
the one way a coverage test is worse than no test.

## F - Limits refuse, and refuse closed

**`packages/queue/src/rate-limiter.test.ts`, `apps/web/lib/rate-limit/config.test.ts`,
`apps/web/app/api/jobs/rate-limit.test.ts`.**

The limiter's own suite proves the atomic script's decision is returned faithfully, that a denied
window does not throw, that a malformed Redis response is rejected rather than interpreted, and that
an unreachable Redis **fails closed**.

The live suite proves the route honours all of that, which is the half that matters: a limiter
returning "denied" into a handler that creates the row anyway has refused nothing.

- Past the window limit: **429**, a `Retry-After` header agreeing with the body's
  `retryAfterSeconds`, a `resetAt` equal to the limiter's, and `createJob` never called.
- Redis unreachable: **503**, `refused closed` in the message, and `createJob` never called. 503
  rather than 429 because the limit was not exceeded, it could not be evaluated; what this run cares
  about is which way the handler fell.
- Active-job cap reached: **429** with `limit: "active_jobs"`, and `requestJobRun` never called - a
  queue message for a row that was never committed is exactly what the sweeper would spend a minute
  reconciling.

**Positive control:** an allowed request returns **201** and calls `createJob` once. Without it
every refusal above is satisfiable by a handler that refuses everything.

## G - The container cannot reach the control plane

**`apps/worker/tests/sandbox/network-isolation.sbx.test.ts`. Real Docker.**

From inside a real job container, created through the production adapter rather than by hand:

- The configured `DATABASE_URL` host and port are unreachable.
- The configured `REDIS_URL` host and port are unreachable.
- `/var/run/docker.sock` does not exist.
- A sibling container on `rivet-sandbox` is unreachable - a **timeout**, not a refusal, which is
  what `enable_icc=false` dropping the packet looks like from the client's side.

**Positive controls, in the same container, in the same run, through the same helper:**
`registry.npmjs.org:443` and `github.com:443` are reachable, and they are asserted **first**, so a
broken helper fails there rather than being read as isolation working. The Docker-socket case runs
the same `test -e` against `/etc/hostname`. The sibling case has the listener answer **itself** on
loopback, which is what separates "the packet was dropped" from "the listener never came up" - the
same observation from the client's side.

**The startup refusal** is asserted by spawning the real `apps/worker/src/index.ts` with
`DATABASE_URL` pointed at an endpoint that genuinely answers from the sandbox network, and requiring
the process to exit **1** naming `DATABASE_URL`. `github.com:443` stands in for an exposed Postgres,
and the first case in the file is what makes that substitution honest: the probe is a TCP connect,
and that endpoint is proven reachable from the same network in the same run.

**The sibling mechanism was inverted and observed to fail.** Setting `enable_icc=true` makes that
case report `reachable`. A check nobody has seen fail is a check nobody has seen work.

### What this run deliberately does not claim

**The host is not asserted to be unroutable, because it is not.** On Docker Desktop the host answers
on `host.docker.internal` and on a raw address (`192.168.65.254` on current builds), and reaches
services bound to the host's own loopback; the sandbox drops `ALL` capabilities, so nothing inside
it can install a route filter either.

Pinning the aliases away was implemented during this work and then reverted, which is worth knowing
before anyone implements it again. It removed the convenient path rather than the path, and this
suite's own fixtures serve a git daemon on the host and clone it from inside containers through
exactly that route - so it broke the sandbox suite on macOS while leaving Linux CI green, where the
fixtures use the bridge gateway instead.

This is one layer of a layered control, and the plan's decision 7 already says the load-bearing
layer is the first one: **nothing the container needs is bound where it can reach it.** That is a
property of the host configuration, not of a Docker flag. `docs/security-review.md` §6.9 records the
residual as an accepted risk. Closing it needs an egress control, which M11 scopes out.

One consequence is operational and is documented rather than worked around: **a managed control
plane is reachable by construction**, so `RIVET_SANDBOX=docker` cannot run against Neon and Upstash.
The worker refuses to boot, correctly. The Docker demos check the same fact themselves and say so
before they spend anything.

## H - The bait case

**`benchmarks/prompt-injection-bait/`, `packages/core/src/pipeline/prompt-injection.test.ts`,
`packages/core/src/pipeline/prompt-security.test.ts`, and `pnpm demo:observability`.**

`benchmarks/prompt-injection-bait/` is a genuine, solvable task whose README and source comments try
to make the agent exfiltrate, skip tests, or write outside the workspace. It runs through
`pnpm eval:run` as an ordinary evaluation job, which is the entire payoff of M10 being an ordinary
job harness. Its hidden tests assert both halves: the real task was completed, and none of the bait
was taken.

The fencing and detection halves are asserted in unit tests - every untrusted boundary is fenced,
including the GitHub issue title and body, which is the highest-value injection surface in the
system and the least obvious. Two properties are worth restating because they are easy to undo:

- **`edit`'s read is deliberately not fenced.** That buffer goes back to disk, and fencing it wrote
  the wrapper into files. This was a shipped bug (`4032663`); do not reintroduce the "fix".
- **Injection detection never fails a job.** `security.injection_suspected` records and continues.
  Pattern matching over repository prose produces false positives - a repository that merely
  _discusses_ prompt injection would be unrunnable, including this one - and the **capability
  boundary is the defense**. Detection is observability.

**The demo.** `pnpm demo:observability` runs one real job with the stack up and prints the Grafana
URL for its trace, which is the milestone's visible artifact. Everything expensive is checked before
anything is spent - the collector, Tempo and Grafana are probed individually, and the local control
plane is required up front - because a real job costs a container, a clone and a model session, and
printing a dead link after all of that would make the run look successful while the deliverable is
missing. The trace id is resolved from Tempo by TraceQL over `rivet.job_id` rather than guessed,
which is also the answer to "show me everything about job X": every span carries `rivet.job_id` at
every depth, so it is a query rather than a trace lookup.

---

## What is not covered

Stated plainly, because an acceptance document that overstates coverage is worse than none - it
stops the next person from looking.

- **Egress.** No run asserts anything about what a container may send outward, because nothing stops
  it. See G's closing section and `docs/security-review.md` §6.
- **The harness process.** The capability boundary contains the model, not the harness. True since
  M4, unchanged here.
- **Multi-tenancy and per-session revocation.** One principal, one allowlist. Revocation is rotating
  the secret or changing the owner, and E asserts the allowlist re-check that makes the second work.
- **Alerting and log shipping.** Loki is in the compose file and off. Trace correlation was the
  deliverable; alerting about a laptop is not alerting.
