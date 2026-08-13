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

**Milestone 1 - background job execution - is complete.** Jobs run. Creating one enqueues it on
Redis, a worker process claims it under a Postgres lease, walks it through a pipeline, heartbeats
while it works, and lands it in a terminal status. The execution timeline on the job page is the
database's own account of the run, written transactionally with each status change. Retries with
backoff, cooperative cancellation, per-job timeouts, and recovery from a `kill -9` mid-run all work,
and each of those claims is covered by an integration test against real Postgres and real Redis.

What is still simulated is the work itself: the seven phases are sleeps, about 21 seconds end to
end. There is no sandbox, no coding agent and no model call yet - Milestones 2 and 4 - and the
machinery around the phases is deliberately built so that replacing their bodies changes nothing
else.

See [docs/architecture.md](docs/architecture.md) for how the pieces fit together and what will have
to move as later milestones land.

## Prerequisites

| Requirement | Version             | Notes                                                               |
| ----------- | ------------------- | ------------------------------------------------------------------- |
| Node.js     | 24 (see `.nvmrc`)   | `nvm use` picks it up                                               |
| pnpm        | 10.32.0             | `corepack enable` uses the `packageManager` field in `package.json` |
| Neon        | free tier is plenty | A serverless Postgres project; branching is used by CI              |
| Upstash     | free tier is plenty | A serverless Redis database, for the BullMQ queue                   |

There is no Docker requirement and no local Postgres for ordinary development - it runs against a
real Neon database and a real Upstash Redis. The integration suite is the exception and needs both
services on localhost; see below.

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

`pnpm dev` starts two processes: the Next.js app on <http://localhost:3000> and the worker.

The demo is watching a job run. Create one from **New job** and you land on its detail page. Within
a second or so the worker claims it, and the status badge and the execution timeline update every
two seconds as it moves through provisioning, analysis, planning, implementation, testing, review
and finalization - about 21 seconds in total. Cancel it partway through and it stops between phases.
The dashboard shows the same transitions in the list.

To watch the recovery machinery instead, break a job on purpose. Set `RIVET_FAULT_PHASE=testing`
with one of four `RIVET_FAULT_MODE` values and restart the worker: `throw` retries the job with
backoff and completes it, `fatal` fails it once with a recorded category, `hang` runs it past its
budget into `timed_out`, and `exit` kills the worker mid-phase with no cleanup at all - the lease
expires, the sweeper reclaims the job, and the next worker finishes it. `.env.example` documents all
four.

## Running the integration suite

27 tests against real Postgres, real Redis and real BullMQ workers, in about 14 seconds. It needs
both services on localhost, because every case truncates `jobs` and `job_events` - which is also why
it refuses to run against any host that is not plainly local, and why it deliberately does not read
`.env.local`.

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
| `RIVET_*`               | no                 | the worker                          | Milestone 1 simulation knobs: pipeline speed and fault injection. Deleted when the sandbox lands                         |

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
| `pnpm build`            | Production build of every workspace. Needs no database and no Redis             |
| `pnpm lint`             | ESLint across every workspace                                                   |
| `pnpm typecheck`        | `tsc --noEmit` across every workspace                                           |
| `pnpm test`             | Vitest unit tests. No database, no Redis                                        |
| `pnpm test:integration` | The `*.int.test.ts` suite, against a local Postgres and Redis                   |
| `pnpm format`           | Prettier, writing changes                                                       |
| `pnpm format:check`     | Prettier in check mode - this is what CI runs                                   |
| `pnpm db:generate`      | Generates a migration from the Drizzle schema into `packages/database/drizzle/` |
| `pnpm db:migrate`       | Applies pending migrations                                                      |
| `pnpm db:studio`        | Opens Drizzle Studio against the database                                       |

## Repository layout

```text
apps/
  web/                 Next.js App Router UI + the /api/jobs route handlers
  worker/              the long-running job runner, and the integration suite
packages/
  config/              shared tsconfig and ESLint bases
  contracts/           zod schemas and response types shared by client and server
  core/                all domain logic: jobs, transitions, events, pipeline, the queue port
  database/            Drizzle schema, migrations and the pg client
  queue/               the BullMQ adapter, an in-memory fake, and the Redis connection
docs/
  architecture.md
.github/workflows/     CI, and the per-pull-request Neon database branch
```

`apps/web` and `apps/worker` are two deployables sharing one copy of the domain logic in
`packages/core`, which imports no framework and no queue library. Nothing in `packages/` has a build
step - they are consumed as raw TypeScript - and neither does the worker, which runs under `tsx`.

## Continuous integration

Two workflows run on every pull request:

- **CI** (`.github/workflows/ci.yml`) - two parallel jobs. **Verify** runs typecheck, lint, format
  check, unit tests and build with no database and no Redis, which is the property that keeps the
  lazy clients honest. **Integration** brings up `postgres:17` and `redis:8` service containers and
  runs the integration suite against them.
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
- [ ] **M2 - Sandbox execution.** A sandbox abstraction over Docker: clone a repository, run
      commands, capture output, enforce timeouts and resource limits, tear down cleanly.
- [ ] **M3 - Real-time execution timeline.** A job event stream, an SSE endpoint, and a live
      timeline and log view in the UI with reconnect support.
- [ ] **M4 - Coding-agent integration.** A `CodingAgentAdapter` over the Pi harness, started
      programmatically inside the sandbox against the cloned repository.
- [ ] **M5 - First autonomous coding job.** One implementation session solves a trivial fixture bug
      unattended, with budget tracking and the final diff persisted.
- [ ] **M6 - Planning, persistence and recovery.** Checkpoints, resumable jobs, and surviving a
      worker crash mid-run without duplicating external side effects.
- [ ] **M7 - Validation pipeline.** Baseline, targeted and full test runs plus lint and typecheck,
      with results parsed and pre-existing failures told apart from new ones.
- [ ] **M8 - Independent review session.** A separate read-only review pass over the diff, with
      structured findings and a bounded revision loop.
- [ ] **M9 - GitHub integration.** A GitHub App, repository and issue pickers, short-lived tokens,
      and branch/commit/push/pull-request creation.
- [ ] **M10 - Evaluation harness.** A benchmark schema, an evaluation runner, hidden tests, run
      metrics and a results dashboard.
- [ ] **M11 - Observability and hardening.** Structured logging, tracing, job and worker metrics,
      redaction, rate limiting, orphan cleanup, security review.
- [ ] **M12 - Public demo polish.** Landing page, timeline animation, diff viewer, evaluation
      dashboard, a seeded demo repository and issue.
