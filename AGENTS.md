# AGENTS.md

This file provides guidance to coding agents when working with code in this repository.

## What Rivet is

An autonomous software engineering platform: you point it at a repository, describe a task, and it
runs the whole workflow (read, plan, edit, test, review, open a PR). The interesting part is the
job-execution system around the coding agent, not the code generation.

`PRD.md` and `plan.md` are at the repo root and are **gitignored but present on disk**. Read them
for product intent and milestone scope. `docs/architecture.md` describes the system as it actually
exists today and is the best starting point for any structural question.

**Current state: Milestone 9 is complete.** Jobs execute, survive their worker, deterministically
validate what the coding session changed, run an independent read-only review, and **end in a pull
request on GitHub**. Creating one enqueues it, a worker claims it under a Postgres lease, provisions
a sandbox - seeded from an authenticated host clone when the job carries an installation binding -
records per-check baselines, plans, runs a Pi coding session, heartbeats while it runs, compares
targeted tests plus the full test, typecheck and lint checks, reviews the result, publishes the
validated tree from the worker host, and lands it in a terminal status. Retries, cancellation,
timeouts, crash recovery, agent budgets, usage persistence, provider failure classification, named
test-failure attribution, bounded review loops and the external-effect receipt protocol all work and
are covered by the unit, integration, sandbox and streaming suites. `pnpm demo:pr` is the
milestone's demo: one real job against a throwaway repository, ending in a real pull request.

M9's own acceptance runs are `apps/worker/tests/integration/publication.int.test.ts` (runs A-G,
against `FakeGitHubClient`, the **real** host Git operations and a local bare repository standing in
for GitHub) and `apps/worker/tests/sandbox/publication.sbx.test.ts` (run H, against Docker: the
seeded container, a binary file that survives the round trip byte for byte, and the sentinel-token
grep across the container environment, its `.git/config`, every command row, every event row and
every host Git argv). `docs/plans/milestone-9-acceptance.md` is the contract they implement.

**Every GitHub failure category is terminal, including `github_unavailable`.** The bounded,
jittered, `Retry-After`-honouring retry lives in the adapter, one HTTP call away from the failure. A
runner-level retry would re-run provisioning, a clone and a model session to repeat one request -
safe, because the receipts make publication idempotent, and wasteful enough to be wrong. It also
prints three identical timelines for one outage.

M7 generalizes M5's baseline and validation into a shared check runner. `analyzing` resolves and
runs test, typecheck and lint in that order, records one `baseline.check_recorded` event per check,
keeps the test-only `baseline.recorded` compatibility event, and stores a canonical
`baseline_report`. `testing` first stages and records `diff` and `diff_stat`, selects targeted tests
deterministically from changed and tracked paths, runs targeted test, full test, typecheck and lint,
records `validation.check_recorded` for each, and stores a canonical `validation_report`. Vitest and
Jest JSON reports identify failures as repository-relative `file::full name` values, allowing the
report to distinguish new, pre-existing and fixed failures. Reporter files live under the sandbox
workdir outside the repository, so Rivet's instrumentation never enters the diff or its totals.

Each check compares as `verified`, `fixed`, `regressed`, `unresolved` or `unverified`. A parsed new
test failure makes the full test check `regressed`, even when the suite was already red. At job
level, full test `regressed` or `unresolved` fails; typecheck and lint fail only on `regressed`; and
targeted test never fails a job on its own. The aggregate is the worst binding outcome ordered
`regressed > unresolved > unverified > fixed > verified`, with pre-existing typecheck and lint
failures treated as `unverified` for aggregation. `finalizing` reads the validation report back and
writes the report-aware closing `run.summarized` line.

M8 adds an independent reviewer with exactly `list_files`, `read`, `search_text` and
`submit_review`. It reads the durable plan, summary, diff and validation report, persists a bounded
`review_report`, and records `review.recorded`. An approval finalizes the job; a revision request
records `review.revision_requested`, runs a directive-only `revising` session, and revalidates
before reviewing again. Rivet owns the loop bound and fails with `reviewer_rejection` when it is
exhausted. `reviewMode: "none"` records `review.skipped` and keeps the M7 path. Review decisions and
loop counts are included in `run.summarized`.

**M6 makes the attempt durable, and it is four things.** `planning` is a real read-only planner
session whose only tools are `list_files`, `read`, `search_text` and `submit_plan`, and whose
validated `ImplementationPlan` is persisted as an artifact every later implementation session reads
back; a session that submits nothing fails with `plan_not_produced`. Every completed phase (except
`provisioning` and `finalizing`) and every completed implementation turn captures a lossless binary
Git patch of the workspace into `job_checkpoints`. A reclaim increments `jobs.dispatch_generation`
in the same transaction that clears the lease, so the replacement worker claims immediately rather
than waiting for BullMQ to declare the dead worker's message stalled. And recovery provisions a
**new** container at the original commit, applies the patch, re-derives it, compares the SHA-256,
and only then writes `checkpoint.restored` and `run.resumed` and continues from the checkpointed
phase with a fresh session that is told what it inherited. `pnpm demo:recovery` proves all of it
against Docker with a `kill -9`.

`packages/sandbox` is real; `buildPipeline()` gives `provisioning`, `analyzing`, `planning`,
`implementing`, `testing`, `reviewing` and `finalizing` real bodies, plus a directive-only
`revising` body - create a container, clone the repository, resolve the commit, restore a checkpoint
when there is one, install dependencies, run the repository's own test suite and record the
baseline, produce a structured plan, run coding and review sessions, judge what they did, then keep
what they said and state what the run came to - and `apps/worker` calls it, selected by
`RIVET_SANDBOX` (`docker` by default, `off` for the simulated pipeline). The processor owns the
container and destroys it on every exit; the sweeper reaps whatever a `kill -9` left behind.

**`planning`, `implementing`, `testing`, `reviewing` and `finalizing` are wired to the same
condition: an agent.** Without one, those phases stay sleeps. Validation's first act is to fail a
job whose diff is empty, which is the right answer for a session that changed nothing and the wrong
one for a pipeline that never had a session - it would be validating the absence of a phase, and
every job under `RIVET_AGENT=off` would fail with `no_changes_produced` while nothing was wrong.
`finalizing` follows for the milder version of the same reason: a phase whose two outputs are the
session's summary and the validation outcome has nothing to summarize when neither of the phases
producing them ran. Production is unaffected, because `parseWorkerConfig` refuses
`RIVET_AGENT=off` - and `RIVET_AGENT=scripted` - under `NODE_ENV=production`.

M3 makes the append-only event log observable. The job detail route serves JSON to ordinary callers
and a Postgres-backed SSE stream to live viewers. The browser reducer reconnects from durable event
ids, deduplicates replayed rows, closes hidden tabs, and drains terminal cleanup before one final
refresh. Commands expose a start event immediately and fetch their bounded transcript lazily. The M5
web surface lists artifact metadata at `/api/jobs/:id/artifacts`, fetches one artifact's content on
demand, and renders the latest summary and diff on the server after the terminal refresh. The
validation, artifact, plan, checkpoint, reclaim, restore and resume events have dedicated timeline
presentations, and the M6 surface adds an implementation-plan panel rendering the six structured
sections. No checkpoint payload reaches the browser and there is no checkpoint download endpoint.

The M9 web surface adds `/settings/github` and four routes under `/api/github` - `setup`,
`installations`, `repositories`, `issues` - all read-only apart from the install callback, all
backed by the GitHub port, and all answering 503 rather than 500 when `RIVET_GITHUB` is off or the
App credentials are absent. `resolveGitHubWebConfig` is the web app's half of that switch and is a
pure function of an env object, which is what keeps `next build` working on a machine with no
credentials. The install callback trusts nothing in its query string: it lists the installations the
App can actually act on and persists a row only if the callback's id is among them. The create form
grows an installation/repository/issue picker with the manual URL kept as a disclosed fallback -
that fallback is the path every fixture, `demo:job` and `demo:recovery` take. The eight publication
events have their own timeline presentation, the only rows in the log that link outward, and the job
detail page renders the pull request and issue as links once they exist.

The worker's half of that switch is `apps/worker/src/github.ts`, the only place the Octokit adapter
and the two host Git operations are assembled. It returns `undefined` under `RIVET_GITHUB=off`,
which leaves `PipelineOptions.github` absent, the unauthenticated in-container clone in place and
`finalizing` recording `publication.skipped` - the mode CI, every existing suite and a laptop with
no App run under. App credentials are passed to the adapter explicitly rather than read from the
environment by it, because `parseWorkerConfig` already validated and decoded them. Every client the
worker builds is wrapped so a minted installation token is registered with `SecretRegistry` before
it reaches its caller, and `createLogger` runs every log argument through that registry (PRD §27).
It is a safety net rather than a boundary: nothing logs a token deliberately, `host-git.ts` redacts
its own transcripts, and the token still never enters an argv, a remote URL or `SandboxSpec.env`.

**The seed archive is tarred with `--no-xattrs` and `COPYFILE_DISABLE=1`, and both are load-bearing
on macOS.** bsdtar records extended attributes, every file on this platform carries
`com.apple.provenance`, and Docker's `putArchive` then fails the whole upload with
`lsetxattr ... operation not supported` - reported as `sandbox_create_failed` on a repository that
is perfectly fine. Without the environment variable it instead writes an AppleDouble `._name`
sidecar beside every entry, and the container gets a repository whose `git status` is a page of
untracked files Rivet invented. GNU tar has accepted the flag since 1.27 and ignores the variable,
so CI reads it identically. Run H in `publication.sbx.test.ts` is what catches both.

**A red baseline is not a failed job.** The `analyzing` phase records
`baseline: passed | failed | skipped` on a `baseline.recorded` event and lets the job continue
whatever the exit code was: PRD §11 C wants to know whether the repository was already broken
_before_ Rivet touched it, and failing the job would make Rivet unable to work on the repositories
it is most useful for. Only a command that was killed - `command_timed_out`, `oom_killed` - fails a
job from that phase, because those are facts about the sandbox rather than about the repository.

**Repository validation is inferred per check, and `rivet.json` overrides it.** A `test`,
`typecheck` or `lint` script in `package.json` becomes that check; a missing script becomes a
recorded skip. A root `rivet.json` may override any check independently while omitted checks still
fall back to inference:

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

The schema is strict. Commands are non-empty argv arrays, never shell strings; per-command
`timeoutMs` is optional from 1,000 through 3,600,000; `reporter.framework` is `vitest` or `jest`;
`outputArg` is optional; and targeted configuration requires `appendPaths`. A present malformed or
unreadable file is terminal `validation_config_invalid`. The M7 vocabulary additions are artifacts
`baseline_report` and `validation_report`, events `baseline.check_recorded` and
`validation.check_recorded`, and failure category `validation_config_invalid`. The legacy
`baseline.recorded` and `validation.recorded` events retain their existing meaning and shape. Check
events carry `check`, `checkStatus`, command details and parsed test totals;
`validation.check_recorded` additionally carries `checkOutcome`, attribution counts and, for the
targeted check, `targetedPaths`. The aggregate `validation.recorded` row carries the same
attribution counts and targeted paths while its `validation` field remains the job outcome.

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
pnpm demo:job            # full job against rivet-fixture-node with Pi, Postgres, Redis and Docker
pnpm demo:recovery       # kill a worker mid-job and prove the replacement resumes; no model key
pnpm demo:pr             # one real job against the throwaway GitHub repo, ending in a real PR
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

One case in that suite spawns worker processes of its own and kills one with `SIGKILL`
(`tests/integration/crash-worker.ts`), because a thrown error is a graceful failure and
`process.exit()` still unwinds - neither is the thing M6's recovery path exists for. Its checkpoint
is written from the phase rather than captured, since `RIVET_SANDBOX=off` leaves no working tree to
snapshot; the sandbox suite proves the bytes and `pnpm demo:recovery` proves both together.

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
Every module lives under `agent/`, `artifacts/`, `checkpoints/`, `evaluation/`, `jobs/`, `events/`,
`pipeline/`, `queue/` or `sandbox/` - a file at the top level next to `index.ts` is the first sign
the package is becoming a junk drawer.

**The model key stays on the worker host, and the container never sees a credential.** The harness
runs in the worker process; its four tools - `read`, `write`, `edit`, `bash` - end at
`AgentToolbox`, whose implementations are the phase's own `ctx.exec` and the sandbox's
`getFile`/`putFile`. Two things keep that true and both are easy to undo by being helpful. Pi's
`bash` tool hands its operations an `env` built from the worker's own `process.env`; forwarding it
would put `OPENROUTER_API_KEY` inside a container running arbitrary cloned code, so it is ignored,
always. And after `createAgentSession` returns, `PiCodingAgent` asserts that
`session.getActiveToolNames()` is exactly the role's set - `bash, edit, read, write` for an
implementer, `list_files, read, search_text, submit_plan` for a planner, and
`list_files, read, search_text, submit_review` for a reviewer - and fails the job otherwise, which
is the difference between believing no host-side tool survived and knowing it. The planner's and
reviewer's read-only-ness is therefore a capability boundary rather than a sentence in a prompt, and
`submit_plan` and `submit_review` are the deliberate worker-side tools: each validates a structured
value and hands it to the phase, and can read nothing, write nothing and execute nothing. Be honest
about what this buys: it contains the _model_, not the harness. Nothing sandboxes the harness
process itself.

**`transitionJob()` is the only writer of `jobs.status`**, and this is compile-enforced rather than
merely agreed: `TransitionInput["patch"]` is `Omit<Partial<NewJob>, "status">`, so a caller cannot
sneak a status through the patch. There are exactly seven `.update(jobs)` sites in `packages/`, and
the other six touch only their own columns - `claims.ts` renews the lease, `cancel.ts` stamps
`cancel_requested_at`, `jobs/provisioning.ts` writes `sandbox_id`, `base_commit_sha` and
`env_fingerprint`, `jobs/agent-usage.ts` writes cumulative model, tool, turn, token and cost totals,
`jobs/review.ts` writes the durable review decision, loop counter and blocking count, and
`jobs/publication.ts` writes the final branch and pull request identity. These writers accept
status-free patches and are fenced on `lease_owner`; they exist because those facts become true when
a command, model turn or review verdict answers, not when the job later changes phase, and a fact
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

That last property has one dependency outside the writer: `RIVET_DIFF_MAX_BYTES` (1MB by default),
which bounds one `git diff` read, must stay **above** `RIVET_ARTIFACT_MAX_BYTES`. Read a diff
through the ordinary 64KB transcript cap and it arrives already clipped, so `byte_size` records the
clipped length as the true one - the exact failure that column exists to prevent.

**`recordCheckpoint()` is the only writer of `job_checkpoints`, and a checkpoint is never
truncated.** Same shape again, with two additions that matter. It locks the job row and verifies
`lease_owner` before it allocates the next per-job sequence, so a phase that has lost its lease can
still compute a patch and can never make it authoritative. And where an artifact above its cap is
clipped to head and tail, a patch above `RIVET_CHECKPOINT_MAX_BYTES` (4MiB) is **refused** with
`checkpoint_too_large` - a clipped patch is not a patch, and storing one would promise a resume that
cannot happen. Phases go through `PhaseContext.checkpoint()`, which captures the workspace and
commits the row with its `checkpoint.created` event; at a phase boundary the capture happens before
`phase.completed`, so a crash between the two replays the phase rather than skipping it.

**M9's two tables have single writers too, and they are opposites.** `github/effect-store.ts` is the
only writer of `job_external_effects` and is append-only like every other ledger here: its insert is
conflict-aware on `(job_id, kind)` and returns the existing receipt rather than throwing, which is
what makes "did I already do this" a question Postgres answers. `github/installation-store.ts` is
the only writer of `github_installations` and is the one table in the system that is a **cache**
rather than a record - GitHub owns the truth, so its upsert really updates, and a read of the
control-plane surface goes to the API and refreshes what it learns. M9 subscribes to no webhooks, so
pulling on demand is the only way an uninstall ever becomes visible. Rows for installations GitHub
stops returning are left in place, because jobs reference them.

**Workspace capture goes through a temporary Git index, and the flags are not decoration.**
`GIT_INDEX_FILE=<temp> git read-tree HEAD`, `git add -A`, then
`git diff --cached --binary --full-index --no-renames --no-ext-diff --no-textconv HEAD`. Against the
real index, `git add -A` would make the next session's ordinary `git diff` come back empty and
overwrite whatever the model had staged. `--binary`/`--full-index` keep binary edits, modes,
deletions and additions recoverable; `--no-renames` keeps the format from depending on the applying
git's rename detection; the two `--no-*` flags stop repository configuration from changing the
format or running another program during capture. Every patch is cut against the job's immutable
`base_commit_sha`, never against the previous checkpoint, so one bad row cannot invalidate
everything after it. The temporary index is removed on every exit path, including the failing ones.

**A restore is not restored until its checksum agrees, and the check runs before the install.**
Provisioning applies the patch into the working tree, re-derives it with the same capture, and
compares SHA-256; only then may `checkpoint.restored` and `run.resumed` be written and the status
move from `provisioning` to the resume phase. The dependency install comes after, against the
restored manifest - an interrupted session may have changed a lockfile - but never before the
comparison, because a package manager that rewrites one would fail a perfectly restored job with
`checkpoint_restore_failed`.

**Recovery never silently starts over.** A checkpoint that fails validation is terminal
(`checkpoint_corrupt`), and one that will not apply is terminal (`checkpoint_restore_failed`), with
the failing argv and bounded stderr on `checkpoint.rejected`. Discarding acknowledged progress and
running the job again from zero would look like success and is the failure this milestone exists to
prevent.

**Budgets and `deadline_at` are the job's, not the attempt's.** Model calls, tool calls, turns,
tokens and cost are cumulative columns on `jobs` that a session seeds from the claimed row rather
than from zero, written back under the lease on the events the ceilings are compared against.
`deadline_at` is fixed by the first claim from Postgres `now()` and coalesced by every later one, so
downtime counts against the job and a claim with nothing left fails `timed_out` before a container
is created. Only `AgentOptions.maxTurns` stays per-session, because it asks whether one conversation
stopped getting anywhere. A crash must never hand a replacement worker a fresh budget.

**`Phase.recovery` is required, and the vocabulary is three words.** `replay`, `checkpoint`,
`reconcile_external`. Everything declares `replay` except `implementing`, whose turn checkpoints are
a real cursor; nothing declares `reconcile_external`, and a test asserts that. It exists so
Milestone 9's first GitHub call is a compile-time decision rather than an inherited replay policy.

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
- `SANDBOX_CHECK_TIMEOUT_MS` - lint and typecheck command budget, 180,000 ms by default.
- `RIVET_VALIDATION_REPORT_MAX_BYTES` - complete reporter-file read cap, 4,194,304 bytes by default.
  It must remain above `RIVET_ARTIFACT_MAX_BYTES`, because truncated JSON is not a report.
- `RIVET_TARGETED_MAX_FILES` - deterministic targeted-test selection cap, 25 by default. A selection
  above it is recorded as skipped rather than mislabeled as a targeted full-suite run.
- `RIVET_GITHUB` - `app` or `off`, `off` by default and **refused under `NODE_ENV=production`**, the
  third member of the `RIVET_SANDBOX`/`RIVET_AGENT` family and the one that hides best: every phase
  runs for real and the job still completes without producing a pull request. `app` additionally
  requires `GITHUB_APP_ID` and `GITHUB_APP_PRIVATE_KEY`, which are validated and base64-decoded at
  startup rather than at publication - `finalizing` is the last phase, so the alternative fails a
  job whose work was already written, validated and approved.
- `GITHUB_CLONE_TIMEOUT_MS` / `GITHUB_PUSH_TIMEOUT_MS` - 180,000 ms each, and deliberately not the
  `SANDBOX_*` ones. These bound the host clone, archive, apply, commit and push; the sandbox
  timeouts bound an unauthenticated clone inside a container.
- `GITHUB_SEED_MAX_BYTES` - complete seed-archive bound, 256MiB by default, applied before the
  archive crosses into the sandbox so a very large repository is a stated failure rather than a
  worker heap problem.
- `RIVET_APP_URL` - absolute base URL of the web app, reaching `PipelineOptions.appBaseUrl` and used
  for the run link in a published pull-request body. Unset, the body falls back to a relative
  `/jobs/<id>`, which resolves against github.com.

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
- Client components are the exception, not the rule: currently the new-job form and its GitHub
  repository picker, the cancel button, and the job-live provider plus its status, timeline, and
  command-log consumers.

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
