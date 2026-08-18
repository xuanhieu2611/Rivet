# Rivet

Rivet is an autonomous software engineering platform. You point it at a repository and describe an
engineering task the way you would write a GitHub issue - "users can double-book the same room when
two requests arrive at once; fix the race condition and add regression tests" - and Rivet runs the
whole workflow on its own: read the code, form a plan, edit files, run the tests, read the failures,
iterate, review the resulting diff, and open a pull request.

The interesting part is not the code generation. Rivet is a job-execution system, not a chat
application: the coding agent is a narrow dependency that owns the inner read/write/edit/bash loop,
and Rivet owns everything around it - job lifecycle, queueing, workers, sandbox provisioning,
persistent state, checkpoints and recovery, budgets and timeouts, event streaming, deterministic
validation, an independent review pass, GitHub side effects, evaluation and observability. That
boundary is the point of the project, and it is what the architecture is organized around.

## Status

**Milestone 10 - the evaluation harness - is complete.** Rivet now measures itself. A benchmark case
is git-tracked files that build into a lock-pinned local bare repository; an evaluation run **is**
an ordinary job, created through `createJob()` and executed by a real worker under a real lease; and
a second container grades the job's last checkpoint against hidden tests the job never saw. M10 adds
no job status, no job event type and no job failure category, which is the milestone's central
claim: a job under evaluation must be indistinguishable from one created in the web form.
`pnpm eval:build`, `pnpm eval:run`, `pnpm eval:grade` and `/evaluations/:id` are its surface, and
[docs/experiments/reviewer-value.md](docs/experiments/reviewer-value.md) is the first experiment run
over it.

Milestone 11 is in progress and all twelve of its stages have landed: the telemetry port, OTLP
export, traces, metrics, a local OpenTelemetry Collector, Prometheus, Tempo and Grafana stack,
container resource monitoring, sandbox network isolation, redaction across every durable write,
authentication, CSRF protection, rate limiting, prompt-injection fencing and detection, and a
written security review with its own CI workflow. M11 adds one nullable column, no new table, no new
job status and no new job failure category. Run `pnpm obs:up` and follow
[docs/milestone-11-guide.md](docs/milestone-11-guide.md) for the walkthrough, or
[docs/security-review.md](docs/security-review.md) for the security half.

Milestone 9 ends a job in a real pull request. A GitHub App, repository and issue pickers,
short-lived installation tokens that never enter a container, an authenticated host clone, and
branch, commit, push and pull-request creation guarded by an append-only receipt ledger that makes
publication idempotent.

Milestone 7 established deterministic validation. `analyzing` establishes separate test, typecheck
and lint baselines before the agent edits anything. `testing` deterministically selects a targeted
test run from the diff, re-runs every full check, and compares each one with its own baseline.
Vitest and Jest reports distinguish newly failing, pre-existing and fixed tests by name; the
resulting baseline and validation reports are durable artifacts rendered on the job page.

Milestone 8 adds an independent reviewer after validation. The reviewer has only `list_files`,
`read`, `search_text` and `submit_review`, and its bounded structured report is durable. An approval
finalizes the job; a revision request starts a bounded revising, revalidation and re-review cycle.
`reviewMode: "none"` records the intentional skip and preserves the M7 workflow.

Milestone 6's planning, persistence and recovery remain underneath it. A job killed mid-session is
provisioned into a new container at the original commit, restored from a checksum-verified binary
Git patch, and continued by a fresh session. Budgets and the wall-clock deadline remain cumulative
across attempts, so a crash grants nobody another hour.

The recovery delivery mechanism is a dispatch generation on every message id: a reclaim increments
it in the same transaction that clears the lease, so the replacement worker can claim immediately
instead of waiting for BullMQ to declare the dead worker's message stalled. A stale generation can
never claim the row.

The Docker-backed coding job provisions a repository, records its baseline before anything is
edited, and gives `implementing` to a Pi session running in the trusted worker. Pi has exactly four
tools - `read`, `write`, `edit`, `bash` - and every one is backed by the job's sandbox; the planner
has four different ones and no way to write anything. The OpenRouter credential stays on the worker
host and never enters the container that runs cloned repository code.

The append-only Postgres event log records session starts, turns, completed assistant messages, tool
calls, usage, budget breaches, session endings, plans, checkpoints, reclaims, restores and resumed
runs. Shell calls also use the command ledger, so their bounded transcripts are visible through the
same live SSE timeline and lazy command log as Rivet's own commands. Validation records per-check
events, parsed failure attribution and canonical report artifacts before finalization persists the
session's own summary. Review adds durable decision, finding, report and loop events, and the
closing `run.summarized` event carries the review decision and loop count. Branch, commit, push and
pull-request creation record eight publication events of their own, the only rows in the log that
link outward.

The integration suite uses a scripted agent with real Postgres, Redis, BullMQ and the production
worker, including a worker killed with `SIGKILL` in a process of its own; it covers approval,
revision, rejection, skipped review, missing verdicts and review recovery. The sandbox suite proves
both the reviewer tool boundary and a byte-identical workspace diff before and after review, as well
as a patch captured in one container restoring byte for byte in another. `pnpm demo:agent` runs one
real Pi session against a tiny fixture, `pnpm demo:job` runs a complete job with a real session, and
`pnpm demo:recovery` kills a worker mid-job and checks every fact the recovery claim rests on.
`pnpm demo:pr` runs the Milestone 9 definition of done: a job created from a real GitHub issue that
ends in a real pull request on a throwaway repository. `pnpm demo:eval` runs Milestone 10's: two
benchmark cases across two review arms and two repetitions, graded in containers of their own.

See [docs/architecture.md](docs/architecture.md) for how the pieces fit together,
[docs/plans/milestone-10.md](docs/plans/milestone-10.md) for the committed M10 plan,
[docs/plans/milestone-10-acceptance.md](docs/plans/milestone-10-acceptance.md) for its acceptance
contract, [docs/milestone-10-guide.md](docs/milestone-10-guide.md) for an educational walkthrough of
the evaluation harness, [docs/plans/milestone-11.md](docs/plans/milestone-11.md) for the committed
M11 plan, [docs/milestone-11-guide.md](docs/milestone-11-guide.md) for an educational walkthrough of
observability and hardening, [docs/security-review.md](docs/security-review.md) for the §27 security
review, [docs/plans/milestone-9.md](docs/plans/milestone-9.md) for the M9 plan,
[docs/plans/milestone-9-acceptance.md](docs/plans/milestone-9-acceptance.md) for its acceptance
contract, [docs/milestone-9-guide.md](docs/milestone-9-guide.md) for an educational walkthrough of
GitHub publication, [docs/milestone-9-setup.md](docs/milestone-9-setup.md) for the one-time GitHub
App setup, and [docs/milestone-8-guide.md](docs/milestone-8-guide.md) for the preceding review
guide. The M10 reviewer-value experiment is documented in
[docs/experiments/reviewer-value.md](docs/experiments/reviewer-value.md), including its raw suite id
and per-case results.

## Prerequisites

| Requirement | Version             | Notes                                                               |
| ----------- | ------------------- | ------------------------------------------------------------------- |
| Node.js     | 24 (see `.nvmrc`)   | `nvm use` picks it up                                               |
| pnpm        | 10.32.0             | `corepack enable` uses the `packageManager` field in `package.json` |
| Neon        | free tier is plenty | A serverless Postgres project; branching is used by CI              |
| Upstash     | free tier is plenty | A serverless Redis database, for the BullMQ queue                   |
| Docker      | Desktop 4.86+       | Only for running jobs for real. See below                           |

No local Postgres for ordinary development - it runs against a real Neon database and a real Upstash
Redis. The integration suite is the exception and needs both services on localhost; the streaming
suite also needs local Postgres but no Redis or Docker. See the suite instructions below.

Docker is what a job's sandbox is made of, so it is needed to run a job for real and to run
`pnpm test:sandbox`. It is deliberately **not** needed for `pnpm build`, `pnpm test`, `pnpm lint` or
`pnpm typecheck`, which run with no database, no Redis and no Docker daemon - that property is what
CI's `verify` job exists to keep honest. Without Docker, set `RIVET_SANDBOX=off` and the worker runs
the simulated pipeline Milestone 1 shipped.

```bash
brew install --cask docker-desktop   # or download Docker Desktop from docker.com
open -a Docker                       # once, to install the privileged helper
docker version                       # must print a Server section, not just a Client one
```

On Apple silicon the first launch asks to install Rosetta; accept it, or the Linux VM never boots
and every command hangs on a daemon that is permanently "starting". The socket lands at
`~/.docker/run/docker.sock`, which Docker Desktop symlinks to `/var/run/docker.sock`; `DOCKER_HOST`
overrides both if yours is somewhere else.

## Setup

```bash
git clone https://github.com/xuanhieu2611/Rivet.git
cd Rivet
pnpm install

# Fill in the two Neon connection strings and the Upstash URL.
cp .env.example .env.local

pnpm db:migrate
pnpm dev
```

`pnpm dev` starts two processes: the Next.js app on <http://localhost:3000> and the worker. For the
Milestone 9 GitHub App prerequisites, follow
[`docs/milestone-9-setup.md`](docs/milestone-9-setup.md). The current application is local-only and
single-operator; read [`SECURITY.md`](SECURITY.md) before installing an App, and
[`docs/security-review.md`](docs/security-review.md) for the control-by-control walk of PRD §27 and
the risks accepted rather than mitigated.

The demo is watching a job run. Create one from **New job** with a public Node repository and you
land on its detail page. With Docker and `RIVET_AGENT=pi` configured, the worker creates a sandbox,
clones and installs the repository, records the resolved commit and environment fingerprint, runs
its baseline tests, then starts Pi in the worker with sandbox-backed tools. The job detail page
shows the agent timeline, command ledger, and bounded transcripts live over SSE, with a connection
indicator and durable reconnect cursor. Cancel it partway through and the running command, session,
and container are stopped. To demo recovery, disable the browser network briefly, then restore it
and watch the missed events replay without duplicate timeline rows.

For the model-backed fixture demo without creating a database job, put `OPENROUTER_API_KEY` in
`.env.local` and run:

```bash
pnpm demo:agent
```

It creates a disposable Docker sandbox, asks Pi to fix a one-line `sum()` bug, runs the fixture
test, and prints the session events and final usage. The command is local-only and is not part of
CI.

To run the complete fixture job locally, put `OPENROUTER_API_KEY` in `.env.local` and run:

```bash
pnpm demo:job
```

The command starts a worker child, creates a job against `rivet-fixture-node`, watches its durable
event log, and prints the resulting diff and implementation summary. It needs the local database,
Redis, Docker, and a model provider, and is not part of CI.

Which task the job asks for is `RIVET_DEMO_TASK`, and the tasks are written down in
`apps/worker/src/demo-tasks.ts`. The default, `bulk-discount-boundary`, is the one-line bug M5 and
M7 document. `multi-line-order` is Milestone 8's: it asks for the same fix plus a new function whose
named edge cases no test in the fixture covers, so deterministic validation comes back green while
the correct review verdict is still `revise`. See
[`docs/plans/milestone-8-acceptance.md`](docs/plans/milestone-8-acceptance.md).

To watch a job survive its worker being killed, run the recovery demo:

```bash
pnpm demo:recovery
```

It starts a worker, waits until the first implementation turn is durable, sends that worker
`SIGKILL`, starts a second one, and then checks the facts the recovery claim rests on: a persisted
plan, a non-empty checkpoint, an incremented dispatch generation, a different container id, the same
base commit, a checksum-verified patch, analysis and planning not rerun, cumulative budgets, and a
job that reaches `completed`. Any missing fact exits non-zero. It needs Postgres, Redis and Docker
but **no model key**: the sessions are scripted, because a demo of recovery should not be able to
fail because a model sampled differently the second time. The replacement session makes no edit of
its own, so the run can only go green if the killed worker's work really was restored.

To watch the same machinery one failure at a time, break a job on purpose. Set
`RIVET_FAULT_PHASE=testing` with one of the `RIVET_FAULT_MODE` values and restart the worker:
`throw` retries the job with backoff, `fatal` fails it once with a recorded `repo_unavailable`
category, `hang` runs it past the job budget into `timed_out`, and `exit` kills the worker mid-phase
with no cleanup at all - the lease expires, the sweeper reclaims the job, and the next worker
finishes it. With the Docker sandbox, `no-daemon`, `oom`, and `slow-command` exercise daemon
outages, memory kills, and command-level timeouts. `.env.example` documents all seven.

## Running the integration suite

The integration suite runs against real Postgres, real Redis, and real BullMQ workers. It includes
scripted-agent completion, cancellation, budgets, provider retry classification, and job deadlines.
It needs both services on localhost, because every case truncates `jobs` and `job_events` - which is
also why it refuses to run against any host that is not plainly local, and why it deliberately does
not read `.env.local`.

```bash
# macOS, via Homebrew
brew services start postgresql@17
psql postgres -c "create role postgres login superuser password 'postgres'"
createdb -O postgres rivet_test

# Homebrew's redis service is broken by a bloom-module path; start it directly.
redis-server --port 6379 --daemonize yes --save "" --appendonly no

pnpm test:integration
```

It defaults to `postgresql://postgres:postgres@localhost:5432/rivet_test` and
`redis://localhost:6379`, matching CI's service containers, and reads a root `.env.test` if you want
different values. Migrations are applied by the suite's own setup, from the same folder and with the
same migrator as `pnpm db:migrate`.

## Running the streaming suite

The web streaming suite opens the actual SSE route against local Postgres and proves framing,
historical replay, live delivery, reconnect cursors, terminal draining, abort cleanup, and JSON
compatibility. It deliberately does not load `.env.local`, refuses remote databases by default, and
needs no Redis or Docker.

```bash
pnpm test:streaming
```

It defaults to `postgresql://postgres:postgres@localhost:5432/rivet_test`, reads `.env.test` when
present, and shares the integration suite's deliberate `RIVET_ALLOW_REMOTE_INTEGRATION=1` escape
hatch. Run it separately from the integration suite because both suites truncate the job tables.

## Running the sandbox suite

This suite needs the same local Postgres and Redis services plus a running Docker daemon. It
creates, kills and removes containers, exercises every resource limit, drives a temporary repository
through a real BullMQ worker, and runs the sandbox-backed coding-agent tool layer without a model.
Its git fixture is served from a temporary directory by `git daemon`, so clone, install and test are
hermetic and need no public network.

```bash
docker version # must include a Server section
pnpm test:sandbox
```

The suite refuses a non-local `DOCKER_HOST` unless `RIVET_ALLOW_REMOTE_SANDBOX=1` is set. That
escape hatch should only be used for a disposable daemon you intentionally chose. Database and Redis
URLs have the same local-only guard as the integration suite.

## How this sandbox differs from a production one

The Docker sandbox is a useful execution boundary, not a claim of hostile-code isolation. Containers
share the host kernel. The `rivet-sandbox` bridge can still reach the host and the public internet;
there is no egress domain allowlist. Rivet uses Docker's default seccomp profile rather than a
Rivet-specific one, and it does not enable user-namespace remapping. A kernel or daemon escape,
network access to an unprotected host service, or dependency code phoning home are outside the
protection this milestone provides.

A production worker should put untrusted jobs behind a stronger boundary such as gVisor, Firecracker
microVMs or Kata Containers; route network access through an egress proxy with an explicit domain
allowlist; isolate each job's network; and provide only per-job credentials with a minutes-long TTL.
Control-plane database, Redis and provider credentials should never enter that environment. Docker
remains appropriate for this local milestone because the limits, lifecycle and adapter boundary
carry forward when the isolation backend changes.

## Repository prompt-injection threat model

Repository files, README text, package manifests, command output, diffs, and GitHub issue titles and
bodies are untrusted input. They can contain text such as "ignore previous instructions", requests
to reveal credentials, or commands intended to make the agent change files outside its workspace.
Rivet therefore treats all of these values as data rather than as system instructions:

- Planner, implementer, and reviewer prompts place repository-derived text and issue text in
  labelled untrusted blocks with an explicit trust preamble.
- Tool results for file reads, repository searches, tracked-file listings, and shell output use the
  same labelled fencing before they reach the model.
- A bounded heuristic scanner checks each source independently at its prompt or tool boundary. It
  records at most one `security.injection_suspected` event per source boundary, including only the
  source, location, and matched pattern classes. It never stores the matched text and never fails,
  blocks, or changes a job. Its documented pattern classes are `instruction_override`,
  `secret_exfiltration`, `unsafe_tool_use`, `external_exfiltration`, and `filesystem_escape`.
- The scanner is observability, not a security boundary. The actual defenses are the exact
  role-specific tool allowlists, read-only planner and reviewer capabilities, unprivileged sandbox,
  absent provider credential, and restricted host-facing sandbox configuration.

The scanner can miss new wording and can produce false positives, including in documentation that
legitimately discusses prompt injection. A future egress allowlist or proxy is still required to
stop a malicious repository from sending its own contents to the public internet; that accepted risk
is not disguised as a prompt-scanning success.

## Repository validation configuration

Rivet infers `test`, `typecheck` and `lint` checks from `package.json` scripts. A repository can
override any check independently with a strict `rivet.json` at its root; omitted checks still use
inference. Commands must be argv arrays, never shell strings. A present malformed file fails the job
terminally as `validation_config_invalid` rather than being ignored.

```json
{
  "validation": {
    "test": {
      "argv": ["pnpm", "test"],
      "timeoutMs": 600000,
      "reporter": { "framework": "vitest", "outputArg": "--outputFile" }
    },
    "typecheck": { "argv": ["pnpm", "typecheck"] },
    "lint": { "argv": ["pnpm", "lint"] },
    "targeted": { "argv": ["pnpm", "vitest", "run"], "appendPaths": true }
  }
}
```

`reporter` is optional and supports `vitest` or `jest`; Rivet otherwise detects those runners from
the manifest and test script. `timeoutMs` is optional per command, from 1,000 to 3,600,000 ms. The
targeted check is advisory and never fails a job on its own.

## Environment variables

A single `.env.local` at the repository root serves every workspace: the web app loads it from
`next.config.ts`, the worker walks up to the workspace root and loads it itself, and drizzle-kit and
the migration script do the same. It is gitignored; `.env.example` is the committed template, and it
documents every worker tuning variable with the reasoning behind its default.

| Variable                | Required           | Used by                             | Notes                                                                                                                    |
| ----------------------- | ------------------ | ----------------------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| `DATABASE_URL`          | yes                | the app and the worker, at runtime  | Neon's **pooled** endpoint - the host contains `-pooler`                                                                 |
| `DATABASE_URL_UNPOOLED` | yes for migrations | `pnpm db:migrate`, `pnpm db:studio` | Neon's **direct** endpoint. Migrations fall back to `DATABASE_URL` when it is unset, which is how CI passes a single URL |
| `REDIS_URL`             | yes                | the app and the worker, at runtime  | Upstash, for BullMQ. `rediss://` (two s) is TLS, which Upstash requires                                                  |
| `WORKER_*`              | no                 | the worker                          | Concurrency, lease, heartbeat, sweep interval, attempt ceiling, shutdown grace. Defaults are in `.env.example`           |
| `RIVET_SANDBOX`         | no                 | the worker                          | `docker` or `off`; `off` selects the simulated sandbox pipeline                                                          |
| `RIVET_AGENT`           | no                 | the worker                          | `pi` or `off`; `off` keeps `implementing` simulated and is refused in production                                         |
| `RIVET_MODEL`           | no                 | the worker                          | Model id; defaults to `deepseek/deepseek-v4-flash`                                                                       |
| `RIVET_MODEL_PROVIDER`  | no                 | the worker                          | Provider id; defaults to `openrouter`                                                                                    |
| `OPENROUTER_API_KEY`    | when agent is `pi` | the worker host                     | Provider credential; never passed into a sandbox                                                                         |
| `AGENT_*`               | no                 | the worker                          | Session timeout, turns, tool/file output caps, and the isolated Pi home directory                                        |
| `SANDBOX_*`             | no                 | the worker                          | Image, workdir, resource ceilings, command budgets and output cap                                                        |
| `DOCKER_HOST`           | no                 | the worker and sandbox tests        | Overrides the local Docker socket                                                                                        |

DDL through Neon's PgBouncer endpoint in transaction pooling mode is unreliable, so migrations
deliberately bypass the pooler while application queries go through it.

Redis is a delivery mechanism only - Postgres is the source of truth for job state - so losing the
Redis database loses no jobs. It does cost money to leave running: BullMQ polls even when the queue
is idle and Upstash bills per command, so stop the worker when you are not developing.

None of these are needed to build. `pnpm build`, `pnpm typecheck`, `pnpm lint` and `pnpm test` all
run with no environment at all, which is what CI relies on.

## Commands

Every command is run from the repository root. Turborepo fans them out across the workspaces.

| Command                 | What it does                                                                    |
| ----------------------- | ------------------------------------------------------------------------------- |
| `pnpm dev`              | Runs the Next.js dev server **and** the worker                                  |
| `pnpm demo:agent`       | Runs one real Pi session against a disposable fixture in Docker                 |
| `pnpm demo:job`         | Runs a full job against `rivet-fixture-node` with a real Pi session             |
| `pnpm demo:recovery`    | Kills a worker mid-job and proves the replacement resumes from its checkpoint   |
| `pnpm demo:pr`          | Runs one bound job against the demo repository and opens a real pull request    |
| `pnpm obs:up`           | Starts the local Collector, Prometheus, Tempo and Grafana stack                 |
| `pnpm obs:down`         | Stops the local observability stack without deleting its volumes                |
| `pnpm build`            | Production build of every workspace. Needs no database and no Redis             |
| `pnpm lint`             | ESLint across every workspace                                                   |
| `pnpm typecheck`        | `tsc --noEmit` across every workspace                                           |
| `pnpm test`             | Vitest unit tests. No database, no Redis                                        |
| `pnpm test:integration` | The `*.int.test.ts` suite, against a local Postgres and Redis                   |
| `pnpm test:streaming`   | The web SSE suite, against local Postgres only                                  |
| `pnpm test:sandbox`     | The `*.sbx.test.ts` suite, against Docker, local Postgres and Redis             |
| `pnpm format`           | Prettier, writing changes                                                       |
| `pnpm format:check`     | Prettier in check mode - this is what CI runs                                   |
| `pnpm db:generate`      | Generates a migration from the Drizzle schema into `packages/database/drizzle/` |
| `pnpm db:migrate`       | Applies pending migrations                                                      |
| `pnpm db:studio`        | Opens Drizzle Studio against the database                                       |

## Repository layout

```text
apps/
  web/                 Next.js App Router UI + the /api/jobs route handlers
  worker/              the long-running job runner, integration suite and sandbox suite
packages/
  config/              shared tsconfig and ESLint bases
  contracts/           zod schemas and response types shared by client and server
  agent/               the Pi adapter, scripted fake, and sandbox-backed tool layer
  core/                all domain logic: jobs, transitions, events, pipeline, and ports
  database/            Drizzle schema, migrations and the pg client
  queue/               the BullMQ adapter, an in-memory fake, and the Redis connection
  sandbox/             the dockerode adapter, scripted fake, and lazy Docker client
docs/
  architecture.md
.github/workflows/     CI, and the per-pull-request Neon database branch
```

`apps/web` and `apps/worker` are two deployables sharing one copy of the domain logic in
`packages/core`, which imports no framework, queue library or Docker client. Nothing in `packages/`
has a build step - they are consumed as raw TypeScript - and neither does the worker, which runs
under `tsx`.

## Continuous integration

Two workflows run on every pull request:

- **CI** (`.github/workflows/ci.yml`) - four independent parallel jobs. **Verify** runs typecheck,
  lint, format check, unit tests and build with no database, Redis or Docker. **Integration** brings
  up `postgres:17` and `redis:8`. **Sandbox** adds the host Docker daemon, pre-pulls the pinned
  image, and runs the real adapter and end-to-end worker path. **Streaming** brings up only
  `postgres:17` and exercises the actual SSE route.
- **Neon preview branch** (`.github/workflows/neon-branch.yml`) - creates an ephemeral Neon branch
  named `preview/pr-<n>`, applies the migrations to it to prove they still apply cleanly against
  real Postgres, and deletes the branch when the pull request closes.

The Neon workflow needs a `NEON_API_KEY` repository secret and a `NEON_PROJECT_ID` repository
variable. When the secret is absent - on a fork, or before it has been configured - its jobs skip
with a notice instead of failing.

## Milestones

Progress against the build plan. Each milestone is demonstrable on its own; the execution system is
built before any agent behaviour.

- [x] **M0 - Project foundation.** Monorepo, TypeScript, lint/format, CI, Postgres, the Job table, a
      minimal dashboard, `POST /api/jobs`, job status in the UI.
- [x] **M1 - Background job execution.** Redis, a BullMQ queue, a worker service, a Postgres lease
      and heartbeat protocol, persisted state transitions with an append-only event log, retries,
      cancellation, timeouts, and a sweeper that recovers jobs from a crashed worker.
- [x] **M2 - Sandbox execution.** A sandbox abstraction over Docker: clone a repository, run
      commands, capture output, enforce timeouts and resource limits, tear down cleanly.
- [x] **M3 - Real-time execution timeline.** A Postgres-backed SSE event stream, reconnect cursor,
      live timeline, connection indicator, and lazy command log with bounded transcripts.
- [x] **M4 - Coding-agent integration.** A Pi session starts programmatically in the worker with
      exactly four sandbox-backed tools, durable agent events and usage, budget enforcement,
      cancellation and provider failure classification; `pnpm demo:agent` proves the live adapter.
- [x] **M5 - First autonomous coding job.** One implementation session solves a trivial fixture bug
      unattended, with budget tracking and the final diff persisted.
- [x] **M6 - Planning, persistence and recovery.** A real planner session and a structured plan,
      lossless workspace checkpoints, dispatch generations, deterministic sandbox rehydration, and a
      worker crash mid-run survived without rerunning acknowledged work; `pnpm demo:recovery` proves
      it end to end.
- [x] **M7 - Validation pipeline.** Baseline, targeted and full test runs plus lint and typecheck,
      with results parsed and pre-existing failures told apart from new ones.
- [x] **M8 - Independent review session.** A separate read-only review pass over the diff, with
      structured findings and a bounded revision loop.
- [x] **M9 - GitHub integration.** A GitHub App, repository and issue pickers, short-lived tokens,
      and branch/commit/push/pull-request creation.
- [x] **M10 - Evaluation harness.** A benchmark schema, an evaluation runner, hidden tests graded in
      a separate container, run metrics and a results dashboard. Five cases; the PRD's "expand to
      20" and "eventually 30-50" entries stay open as authoring work. The first experiment is
      written up in [docs/experiments/reviewer-value.md](docs/experiments/reviewer-value.md).
- [ ] **M11 - Observability and hardening.** Structured logging, tracing, job and worker metrics,
      redaction, rate limiting, orphan cleanup, security review.
- [ ] **M12 - Public demo polish.** Landing page, timeline animation, diff viewer, evaluation
      dashboard, a seeded demo repository and issue.
