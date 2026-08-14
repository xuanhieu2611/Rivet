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

**Milestone 3 - real-time execution timeline - is complete.** Creating a job now gives a worker a
real Docker container, clones the requested repository and branch, resolves the commit, installs
dependencies, and runs the repository's baseline test script. Every command records its argv,
duration, exit code, separate stdout and stderr, and bounded transcript. A red baseline is recorded
without blaming the job. CPU, memory, PID and command-time limits are enforced.

The job detail page replays the append-only Postgres event log over SSE, updates its status,
timeline, and command log in place, and reconnects from the last durable event id after a network
interruption. Hidden tabs close their stream, terminal jobs drain cleanup events briefly, and the
final refresh synchronizes server-rendered metadata. Command rows appear when execution starts;
bounded transcripts are fetched lazily at completion or when opened. Output is not streamed byte by
byte.

The processor destroys the container after success, failure, cancellation, timeout, lease loss and
shutdown. A reaper removes what a `kill -9` leaves behind. The sandbox suite proves those claims
against Docker, Postgres, Redis and a hermetic git fixture; the streaming suite proves the live
route against local Postgres. Analysis, planning, implementation, review and finalization are still
simulated until the coding agent arrives in Milestones 4 and 5; there is no model call yet.

See [docs/architecture.md](docs/architecture.md) for how the pieces fit together and what will have
to move as later milestones land.

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

`pnpm dev` starts two processes: the Next.js app on <http://localhost:3000> and the worker.

The demo is watching a job run. Create one from **New job** with a public Node repository and you
land on its detail page. The worker creates a sandbox, clones and installs the repository, records
the resolved commit and environment fingerprint, runs its baseline tests, and then moves through the
five still-simulated phases. The job detail page shows the command ledger and bounded transcripts
live over SSE, with a connection indicator and durable reconnect cursor. Commands become visible
when they start, and their separate stdout/stderr transcripts load when they complete or when you
open a row. The stream does not send output bytes as they are produced. Cancel it partway through
and the running command and container are stopped. To demo recovery, disable the browser network
briefly, then restore it and watch the missed events replay without duplicate timeline rows.

To watch the recovery machinery instead, break a job on purpose. Set `RIVET_FAULT_PHASE=testing`
with one of the `RIVET_FAULT_MODE` values and restart the worker: `throw` retries the job with
backoff, `fatal` fails it once with a recorded `repo_unavailable` category, `hang` runs it past the
job budget into `timed_out`, and `exit` kills the worker mid-phase with no cleanup at all - the
lease expires, the sweeper reclaims the job, and the next worker finishes it. With the Docker
sandbox, `no-daemon`, `oom`, and `slow-command` exercise daemon outages, memory kills, and
command-level timeouts. `.env.example` documents all seven.

## Running the integration suite

34 tests against real Postgres, real Redis and real BullMQ workers, in about 15 seconds. It needs
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
creates, kills and removes containers, exercises every resource limit, and drives a temporary
repository through a real BullMQ worker. Its git fixture is served from a temporary directory by
`git daemon`, so clone, install and test are hermetic and need no public network.

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
| `RIVET_*`               | no                 | the worker                          | Sandbox mode, pipeline speed for five simulated phases, and fault injection                                              |
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
  core/                all domain logic: jobs, transitions, events, pipeline, the queue port
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
- [ ] **M4 - Coding-agent integration.** A `CodingAgentAdapter` over the Pi harness, started
      programmatically in the worker, with `read`/`write`/`edit`/`bash` backed by the job's sandbox
      so the model credential never enters a container running cloned code.
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
