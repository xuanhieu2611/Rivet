# AGENTS.md

This file provides guidance to coding agents when working with code in this repository.

## What Rivet is

An autonomous software engineering platform: you point it at a repository, describe a task, and it
runs the whole workflow (read, plan, edit, test, review, open a PR). The interesting part is the
job-execution system around the coding agent, not the code generation.

`PRD.md` and `plan.md` are at the repo root and are **gitignored but present on disk**. Read them
for product intent and milestone scope. `docs/architecture.md` describes the system as it actually
exists today and is the best starting point for any structural question.

**Current state: Milestone 4 is complete.** Jobs execute. Creating one enqueues it, a worker claims
it under a Postgres lease, provisions a sandbox, records a baseline, runs a Pi coding session during
`implementing`, heartbeats while it runs, and lands it in a terminal status. Retries, cancellation,
timeouts, crash recovery, agent budgets, usage persistence, and provider failure classification all
work and are covered by the unit and integration suites. Analysis, planning, review, and
finalization remain simulated until later milestones.

`packages/sandbox` is real; `buildPipeline()` gives `provisioning` and `testing` real bodies -
create a container, clone the repository, resolve the commit, install dependencies, then run the
repository's own test suite and record the result - and `apps/worker` calls it, selected by
`RIVET_SANDBOX` (`docker` by default, `off` for the simulated pipeline). The processor owns the
container and destroys it on every exit; the sweeper reaps whatever a `kill -9` left behind.

M3 makes the append-only event log observable. The job detail route serves JSON to ordinary callers
and a Postgres-backed SSE stream to live viewers. The browser reducer reconnects from durable event
ids, deduplicates replayed rows, closes hidden tabs, and drains terminal cleanup before one final
refresh. Commands expose a start event immediately and fetch their bounded transcript lazily.

**A red baseline is not a failed job.** The `testing` phase records
`baseline: passed | failed | skipped` on a `baseline.recorded` event and lets the job continue
whatever the exit code was: PRD §11 C wants to know whether the repository was already broken
_before_ Rivet touched it, and failing the job would make Rivet unable to work on the repositories
it is most useful for. Only a command that was killed - `command_timed_out`, `oom_killed` - fails a
job from that phase, because those are facts about the sandbox rather than about the repository.

## Commands

All root scripts fan out through Turborepo.

```bash
pnpm dev                 # Next.js dev server on :3000 AND the worker, together
pnpm build               # production build; must work with NO database and NO Redis (CI relies on this)
pnpm lint                # eslint, type-aware
pnpm typecheck           # tsc --noEmit across every workspace
pnpm test                # vitest across every workspace; no database, no Redis
pnpm test:integration    # the *.int.test.ts suite; needs a LOCAL Postgres and Redis
pnpm test:sandbox        # the *.sbx.test.ts suite; needs LOCAL Postgres, Redis and Docker
pnpm test:streaming      # the web SSE suite; needs LOCAL Postgres, no Redis or Docker
pnpm demo:agent          # one real Pi session against a disposable Docker fixture
pnpm format              # prettier --write .
pnpm format:check        # what CI runs

pnpm db:generate         # drizzle-kit generate, after editing the schema
pnpm db:migrate          # apply migrations (uses DATABASE_URL_UNPOOLED)
pnpm db:studio           # drizzle studio
```

`pnpm dev` now starts two persistent processes, because `apps/worker` has a `dev` script and turbo's
`dev` task is `persistent`. That is the whole local demo in one command: create a job in the UI and
watch the worker move it.

Scope to one package with `--filter`, which is also how you run a single test:

```bash
pnpm --filter @rivet/web test lib/job-status.test.ts
pnpm --filter @rivet/contracts test -t "rejects a non-https repo url"
pnpm --filter @rivet/worker test:integration tests/integration/sweeper.int.test.ts
pnpm --filter @rivet/web typecheck
```

Turbo caches aggressively. Add `--force` when you need to prove something from cold.

### Running the integration suite locally

The integration suite in `apps/worker/tests/integration/*.int.test.ts` runs against real Postgres,
real Redis, and real BullMQ workers. It covers the lease and queue lifecycle plus scripted-agent
completion, cancellation, budgets, provider retries, terminal provider failures, and deadlines. The
cases need both services on localhost. On this machine that is Homebrew's `postgresql@17` and
`redis`:

```bash
brew services start postgresql@17
# Homebrew's redis service is broken by a bloom-module path, so start it directly:
redis-server --port 6379 --daemonize yes --save "" --appendonly no

pnpm test:integration
```

The suite defaults to `postgresql://postgres:postgres@localhost:5432/rivet_test` and
`redis://localhost:6379`, matching CI's service containers, and reads `.env.test` if one exists. It
deliberately does **not** load `.env.local`, and it refuses to run against any host that is not
plainly local, because every case truncates `jobs` and `job_events` and `.env.local` on a dev
machine points at the real Neon database. `RIVET_ALLOW_REMOTE_INTEGRATION=1` is the escape hatch and
exists only so overriding the guard has to be deliberate.

### Running the streaming suite

`pnpm test:streaming` runs the real-Postgres web suite in `apps/web/tests/streaming`. It exercises
the actual SSE route, replay and reconnect cursors, live append delivery, terminal draining, abort
cleanup, two-viewer reads, and JSON compatibility. It needs local Postgres only, reads `.env.test`,
never `.env.local`, and refuses a non-local database unless `RIVET_ALLOW_REMOTE_INTEGRATION=1` is
set. It truncates `jobs` and `job_events`, so run it separately from the worker integration suite.

### Docker

Milestone 2 makes a job's sandbox a real container, so Docker Desktop is a prerequisite alongside
Postgres and Redis - but only for running jobs for real. `pnpm build`, `pnpm test`, `pnpm lint` and
`pnpm typecheck` still run with no database, no Redis **and no Docker daemon**, which is the
property CI's `verify` job exists to protect. `RIVET_SANDBOX=off` selects the simulated sandbox
pipeline and `RIVET_AGENT=off` selects the simulated implementing phase. Those are what the
integration suite runs under, so it still needs only Postgres and Redis. They are the configurations
`parseWorkerConfig` refuses under `NODE_ENV=production`: a worker that completes a job without
touching a repository looks perfectly healthy, and that is the worst failure mode on offer.

```bash
brew install --cask docker-desktop   # needs sudo, so run it from a terminal that can prompt
open -a Docker                       # once; installs the privileged helper
docker version                       # must print a Server section, not just a Client one
```

Two things that cost time on this machine and will cost it again on a fresh one:

- On Apple silicon the first launch prompts for Rosetta. Until it is installed the Linux VM never
  boots - the engine sits in `starting` forever and every `docker` command returns HTTP 500 from
  `_ping`. `~/Library/Containers/com.docker.docker/Data/log/host/com.docker.backend.log` is where
  that is visible; an empty `Data/vms/0` with no disk image is the same symptom.
- `brew install --cask docker-desktop` needs sudo to link `docker-credential-osxkeychain` into
  `/usr/local/bin`, and rolls the entire cask back if it cannot prompt. An agent shell cannot supply
  that password; ask the user to run it.

The socket is at `~/.docker/run/docker.sock`, symlinked to `/var/run/docker.sock`. `DOCKER_HOST`
overrides both and is read explicitly rather than relying on dockerode's default.

The sandbox base image is pinned by digest as well as tag, so an upstream retag cannot silently
change what a job runs:

```text
node:24-bookworm
node@sha256:934240a162082fd8b8a2f90cd5114446443f1eba1c5378f6687167ca405e6584
```

That digest is an OCI image index covering `arm64` and `amd64`, so the same pin resolves on Apple
silicon and on CI's amd64 runners. Node 24 rather than 22 because `.nvmrc` pins 24 and a sandbox
running a different major than the host is a confusing thing to explain.

**Not `-slim`, and it is not a preference.** The slim image has no `git`, so the first thing
`provisioning` does fails with `exec: "git": executable file not found in $PATH` - reported as
`repo_unavailable`, which blames the repository for something that is entirely Rivet's fault. The
container runs as uid 1000 with `no-new-privileges`, so installing git on the way in is not an
option either. The full image is 400MB against the slim image's 80MB, pulled once per host, and that
is the price until Milestone 4 builds a `rivet-sandbox` image and can pick exactly what goes in it.

`pnpm` and `yarn` are not in the image and are not meant to be: corepack ships with Node and fetches
the one the repository's lockfile asks for. It needs `COREPACK_ENABLE_DOWNLOAD_PROMPT=0`, which the
install command sets - without it corepack stops on an interactive confirmation inside a container
with no terminal, and the symptom is an install that hangs until its timeout rather than one that
says what it wanted.

## Architecture

```
apps/web            Next.js 16 App Router. Pages and route handlers. No business logic.
apps/worker         Long-running Node process. BullMQ Worker, heartbeat, sweeper, reaper, faults.
packages/core       All domain logic: agent/, jobs/, events/, pipeline/, queue/, sandbox/ (three ports).
packages/queue      BullMQ adapter for the port, an in-memory fake, the lazy ioredis connection.
packages/sandbox    dockerode adapter for the sandbox port, a scripted fake, the lazy Docker client.
packages/agent      Pi adapter for the coding-agent port, a scripted fake, the lazily-loaded SDK.
packages/contracts  Zod schemas, the job status enum, JobSummary / JobDetail / JobEvent.
packages/database   Drizzle schema, generated migrations, the pg Pool. Neon Postgres.
packages/config     tsconfig + ESLint bases that every workspace extends.
```

Workspace packages are consumed as **raw TypeScript** (`main` points at `src/index.ts`). There is no
build step for `packages/*` and none for `apps/worker` either - it runs under `tsx` - which is what
keeps `pnpm build` in CI meaning exactly what it meant in Milestone 0.

Two deployables, one copy of the domain logic. Both call `@rivet/core` directly; there is no HTTP
hop from a page to the app's own route handler, and none from the worker to the web app.

```
browser ──page nav──▶ server component ─┐
        ──fetch()───▶ route handler ────┤
                      (zod validate)    ├──▶ @rivet/core ──▶ Drizzle ──▶ pg Pool ──▶ Neon
apps/worker ─────────▶ processor ───────┘        │
   ▲                                             └──▶ JobQueue port ──▶ @rivet/queue ──▶ Redis
   └────────────── BullMQ message ("run this job id") ──────────────────────────┘
```

**Postgres holds job state; Redis holds nothing that matters.** A message is a job id and nothing
else. Flush Redis and no job is lost: the sweeper finds every row Postgres says should be moving and
re-enqueues it. Read `docs/architecture.md` before changing anything in that loop.

### Invariants that are easy to break

**`packages/core` imports no `next/*`, no `bullmq`, no `ioredis`, no `dockerode`, no
`@earendil-works/*`, and reads no `process.env`.** All six rules exist for one reason: core is
shared by two deployables and must not depend on either one's framework or on the delivery
mechanism. Configuration arrives as function arguments, which is what lets the whole pipeline run in
under a millisecond at `speed: 0` with no fake timers and no sleeping in CI - and it is why
`PipelineOptions` carries the image, the limits and all four timeouts rather than defaulting any of
them here. A default limit in the package that is supposed to hold no policy is how a container ends
up unbounded. Core declares the `JobQueue`, `Sandbox` and `CodingAgent` ports; `packages/queue`,
`packages/sandbox` and `packages/agent` are the only packages that know Redis, Docker and Pi exist.
Every module lives under `agent/`, `artifacts/`, `jobs/`, `events/`, `pipeline/`, `queue/` or
`sandbox/` - a file at the top level next to `index.ts` is the first sign the package is becoming a
junk drawer.

**The model key stays on the worker host, and the container never sees a credential.** The harness
runs in the worker process; its four tools - `read`, `write`, `edit`, `bash` - end at
`AgentToolbox`, whose implementations are the phase's own `ctx.exec` and the sandbox's
`getFile`/`putFile`. Two things keep that true and both are easy to undo by being helpful. Pi's
`bash` tool hands its operations an `env` built from the worker's own `process.env`; forwarding it
would put `OPENROUTER_API_KEY` inside a container running arbitrary cloned code, so it is ignored,
always. And after `createAgentSession` returns, `PiCodingAgent` asserts that
`session.getActiveToolNames()` is exactly those four and fails the job otherwise - which is the
difference between believing no host-side tool survived and knowing it. Be honest about what this
buys: it contains the _model_, not the harness. Nothing sandboxes the harness process itself.

**`transitionJob()` is the only writer of `jobs.status`**, and this is compile-enforced rather than
merely agreed: `TransitionInput["patch"]` is `Omit<Partial<NewJob>, "status">`, so a caller cannot
sneak a status through the patch. There are exactly five `.update(jobs)` sites in `packages/`, and
the other four touch only their own columns - `claims.ts` renews the lease, `cancel.ts` stamps
`cancel_requested_at`, `jobs/provisioning.ts` writes `sandbox_id`, `base_commit_sha` and
`env_fingerprint`, and `jobs/agent-usage.ts` writes cumulative model totals fenced on `lease_owner`.
The last two take the same patch type, so neither can touch `status`; they exist because those facts
become true when a command or model turn answers, not when the job later changes phase, and a fact
recorded at a moment that has nothing to do with the fact is how a timeline starts lying. Stamping a
cancel is deliberately not a status change; the job reaches `cancelled` through the worker's own
transition under its own lease. Every status change is a compare-and-swap on the expected `from`
status, optionally fenced on `lease_owner`, and writes its event row in the same transaction. Adding
another status writer breaks all of that at once.

**`appendEvent()` is the only writer of `job_events`, and it takes an `Executor`.** Pass the
transaction and the event lands atomically with the status change it describes; pass nothing and it
runs on the pool. That is why interactive transactions are required, and therefore why the `pg`
driver was chosen over Neon's HTTP driver. Nothing ever updates or deletes an event row.

**`recordArtifact()` is the only writer of `job_artifacts`, and it bounds content itself.** Same
shape as `appendEvent` and `recordCommand`: an input object, an optional `Executor`, append-only
rows. Phases never call it directly - they go through `PhaseContext.artifact()`, which writes the
row and its `artifact.recorded` event in one transaction, because an event carrying an `artifactId`
that resolves to nothing is worse than no event. The cap is `RIVET_ARTIFACT_MAX_BYTES` (256KB by
default) and is applied inside the writer rather than by callers, so no phase can forget it;
`byte_size` always records the true size before truncation, which is the entire reason the column
exists separately from the content. Object storage (PRD §8) replaces the body of `recordArtifact`
and `getArtifact` behind those signatures rather than editing every phase.

**`job_events` remains the source of truth for live replay.** The SSE route tails Postgres directly;
it does not use Redis Pub/Sub or keep a second event history. A visible active job page issues at
most one bounded event query per second, hidden tabs close their stream, and terminal streams close
after a short cleanup grace period. Every durable frame carries its event id. Reconnects resolve the
maximum of `?after` and `Last-Event-ID`, and the browser reducer deduplicates by id, so
at-least-once delivery never creates duplicate visible rows. The ordinary JSON events response
remains available through content negotiation, and a streaming transport failure never changes the
job status.

**Command rows stay append-only.** A command start is visible immediately through a
`commandExecutionId` in event JSON; the durable `job_commands` row is created only after execution
returns, and its bounded transcript is fetched separately. Do not turn command lifecycle correlation
into an update-in-place command ledger.

**Importing `@rivet/queue` must never open a connection or throw**, the same rule as
`@rivet/database` and for the same reason: `pnpm build` runs in CI with no `DATABASE_URL` and no
`REDIS_URL`. The ioredis client and the `Queue` are both built inside functions and memoized, and
both are additionally cached on `globalThis` outside production, because Next.js re-evaluates server
modules on every hot reload and a fresh client per edit leaks connections until Upstash refuses
them.

**`heartbeat * 3 <= lease`, asserted at worker startup.** A worker must be able to miss two
heartbeats and still own its job. Violate it and the sweeper reclaims work from a perfectly healthy
process, and the resulting duplicate execution is miserable to diagnose because nothing looks
broken. `parseWorkerConfig` throws and the worker exits non-zero rather than booting.

**Event types and failure categories are Zod-validated `text`, not pgEnums.** `JOB_EVENT_TYPES` and
`FAILURE_CATEGORIES` in `packages/contracts/src/job-event.ts` are the validation. That vocabulary
grows every milestone, and a migration per new entry buys nothing. The status enum is the exception
and keeps its pgEnum plus drift assertion because it is a closed, indexed state machine.

**`JobEventData` is a type alias, not an interface.** TypeScript gives object type aliases an
implicit index signature, which is what makes it assignable to the loose `Record<string, unknown>`
the Drizzle `jsonb` column is typed as - an interface is not. It carries an eslint-disable saying
so. Do not "fix" it into an interface.

**BullMQ is v6 and most material online is v5.** Four things that matter here: a completed message
keeps its id reserved, and since the job's UUID _is_ the message id, `enqueueJobRun` looks the id up
and removes a finished message before re-adding - every retry and every sweeper reclaim depends on
that. `UnrecoverableError` replaced `job.discard()`. The legacy repeatable-jobs API is gone in
favour of job schedulers (`upsertJobScheduler`), which is how the sweep is scheduled. `Queue#client`
and `Worker#blockingClient` no longer exist. Pin the version and read the v6 docs, not blog posts.

**Never add `export const runtime = "edge"`.** The database client is a `pg` Pool and requires the
Node.js runtime. Every page and route handler that touches the database sets
`dynamic = "force-dynamic"`, which is what lets `pnpm build` run with no `DATABASE_URL` at all. CI
depends on that. If you add a DB-reading page, it needs the same.

**The job status enum lives in two places and a type-level assertion keeps them honest.**
`JOB_STATUSES` in `packages/contracts/src/job.ts` mirrors the `job_status` pgEnum in
`packages/database/src/schema/job.ts`. Changing one alone fails `pnpm typecheck` in both directions.
Adding a Postgres enum value is a cheap migration; reordering or removing one is not, so prefer
adding. `StatusBadge` maps statuses through a `Record<JobStatus, ...>`, so a new status also breaks
typecheck there until it is given a color.

**`importing @rivet/database` must never open a connection or throw.** The Drizzle client is built
lazily behind a Proxy specifically so typecheck, lint, and unit-test runs work with no env. Do not
move construction to module scope, and keep unit tests database-free.

**TypeScript is pinned at 5.9.3.** typescript-eslint 8.x hard-throws on TS 7. Do not upgrade
TypeScript until typescript-eslint supports it.

### Database and Redis

Three connection strings, one root `.env.local` (copy from `.env.example`) that every workspace
shares. `next.config.ts` walks up to `pnpm-workspace.yaml` to load it, since Next only reads env
from its own project directory; `loadRootEnv()` in `apps/worker/src/config.ts` is the worker's half
of the same trick, called from `index.ts` rather than at import time so `parseWorkerConfig` stays a
pure function of an env object.

- `REDIS_URL` - Upstash, used by BullMQ. `rediss://` is TLS. Redis is delivery only, so losing this
  database loses no jobs. BullMQ polls even when idle and Upstash bills per command, so stop the
  worker when you are not developing.
- `DATABASE_URL` - Neon's **pooled** endpoint (PgBouncer). All application queries.
- `DATABASE_URL_UNPOOLED` - the **direct** endpoint. Migrations only; DDL through PgBouncer in
  transaction pooling mode is unreliable. The migrate script falls back to `DATABASE_URL` when
  unset, which is how CI points migrations at an ephemeral branch with one variable.

Schema changes go: edit `packages/database/src/schema/`, run `pnpm db:generate`, **commit the
generated SQL** under `packages/database/drizzle/`, then `pnpm db:migrate`. Migrations are applied
by `src/migrate.ts` (a plain Node process) rather than the drizzle-kit CLI.

The wire and TypeScript surface is camelCase (`repoUrl`, `baseBranch`); Postgres columns are
snake_case. Drizzle handles the mapping, so parsed `createJobSchema` output passes straight into an
insert with no remapping.

### Conventions

- Package-level `eslint.config.js` is one line: `export default rivetConfig(import.meta.dirname)`.
  Add rules to `packages/config/eslint.base.js`, not to individual packages.
- Every package extends `@rivet/config/tsconfig.base.json`. It is strict, with
  `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`, and `verbatimModuleSyntax`, so type-only
  imports must be written as `import type`.
- Prettier formats Markdown too. Run `pnpm format` after editing docs or CI will fail on
  `format:check`.
- Client components are the exception, not the rule: currently the new-job form, cancel button, and
  job-live provider plus its status, timeline, and command-log consumers.

### Retired scaffolding and live updates

Milestone 0's scaffolding (`PATCH /api/jobs/:id`, `nextStatus()`, `HAPPY_PATH_SEQUENCE`,
`AdvanceStatusControl`, `updateJobStatus()`) is gone, which is what makes "nothing outside
`transitions.ts` writes `jobs.status`" literally true. Do not reintroduce a status writer.

Milestone 3's live provider owns the detail page's EventSource lifecycle. It closes streams while a
tab is hidden, reconnects from the latest durable cursor when visible, deduplicates replayed event
ids, and performs one `router.refresh()` after the server sends `stream.end`. There is no interval
that refreshes the page per event, and no polling component remains.

## CI

`.github/workflows/ci.yml` has four independent jobs that run in parallel and share nothing.
**Verify** runs typecheck, lint, format:check, test, and build with no database, Redis, or Docker -
that is the property that keeps the lazy clients and `force-dynamic` honest, and merging the jobs
would cost it. **Integration** brings up `postgres:17` and `redis:8` service containers and runs
`pnpm test:integration`. **Sandbox** adds Docker and runs the real adapter suite. **Streaming**
brings up only `postgres:17` and runs `pnpm test:streaming`.

There is deliberately no separate migrate step in the infrastructure suites: each suite's own
`globalSetup` applies migrations from the same `drizzle/` folder with the same migrator as
`pnpm db:migrate`, because a schema built any other way is a schema no deployment has. Streaming is
kept in its own CI job because it truncates the same Postgres tables as the worker integration
suite.

`.github/workflows/neon-branch.yml` creates a `preview/pr-<n>` Neon branch per PR and applies
migrations to it. It skips cleanly when the `NEON_API_KEY` secret is missing (it is not yet set), so
a skipped Neon run is expected rather than a failure. Never print a Neon connection string in a
workflow; it embeds credentials.
