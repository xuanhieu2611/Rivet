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

**Milestone 0 - project foundation - is complete.** The repository, toolchain, database, contracts
and web app exist, and a user can create a job and watch its status in the UI.

Nothing executes those jobs yet. There is no queue, no worker, no sandbox and no model call, so a
new job sits at `queued` until something moves it - which is Milestone 1's job. So that the status
pipeline can be proved end to end today, the job detail page carries a development-only "advance
status" control that walks a job through the lifecycle by hand. It is hard-disabled when `NODE_ENV`
is `production` and gets deleted once the worker drives transitions for real.

See [docs/architecture.md](docs/architecture.md) for how the pieces fit together and what will have
to move as later milestones land.

## Prerequisites

| Requirement | Version             | Notes                                                               |
| ----------- | ------------------- | ------------------------------------------------------------------- |
| Node.js     | 24 (see `.nvmrc`)   | `nvm use` picks it up                                               |
| pnpm        | 10.32.0             | `corepack enable` uses the `packageManager` field in `package.json` |
| Neon        | free tier is plenty | A serverless Postgres project; branching is used by CI              |

There is no Docker requirement and no local Postgres. Development runs against a real Neon database.

## Setup

```bash
git clone https://github.com/xuanhieu2611/Rivet.git
cd Rivet
pnpm install

# Fill in the two Neon connection strings from your project dashboard.
cp .env.example .env.local

pnpm db:migrate
pnpm dev
```

The app is then at <http://localhost:3000>. Create a job from **New job**, land on its detail page,
advance its status, and it appears on the dashboard list.

## Environment variables

A single `.env.local` at the repository root serves every workspace: the web app loads it from
`next.config.ts`, and drizzle-kit and the migration script load it themselves. It is gitignored;
`.env.example` is the committed template.

| Variable                | Required           | Used by                             | Notes                                                                                                                    |
| ----------------------- | ------------------ | ----------------------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| `DATABASE_URL`          | yes                | the app, at runtime                 | Neon's **pooled** endpoint - the host contains `-pooler`                                                                 |
| `DATABASE_URL_UNPOOLED` | yes for migrations | `pnpm db:migrate`, `pnpm db:studio` | Neon's **direct** endpoint. Migrations fall back to `DATABASE_URL` when it is unset, which is how CI passes a single URL |

DDL through Neon's PgBouncer endpoint in transaction pooling mode is unreliable, so migrations
deliberately bypass the pooler while application queries go through it.

## Commands

Every command is run from the repository root. Turborepo fans them out across the workspaces.

| Command             | What it does                                                                    |
| ------------------- | ------------------------------------------------------------------------------- |
| `pnpm dev`          | Runs the Next.js dev server                                                     |
| `pnpm build`        | Production build of every workspace. Needs no database                          |
| `pnpm lint`         | ESLint across every workspace                                                   |
| `pnpm typecheck`    | `tsc --noEmit` across every workspace                                           |
| `pnpm test`         | Vitest unit tests (contracts and the service layer)                             |
| `pnpm format`       | Prettier, writing changes                                                       |
| `pnpm format:check` | Prettier in check mode - this is what CI runs                                   |
| `pnpm db:generate`  | Generates a migration from the Drizzle schema into `packages/database/drizzle/` |
| `pnpm db:migrate`   | Applies pending migrations                                                      |
| `pnpm db:studio`    | Opens Drizzle Studio against the database                                       |

## Repository layout

```text
apps/
  web/                 Next.js App Router UI + the /api/jobs route handlers
    lib/services/      framework-agnostic business logic, extracted in M1
packages/
  config/              shared tsconfig and ESLint bases
  contracts/           zod schemas and response types shared by client and server
  database/            Drizzle schema, migrations and the pg client
docs/
  architecture.md
.github/workflows/     CI, and the per-pull-request Neon database branch
```

## Continuous integration

Two workflows run on every pull request:

- **CI** (`.github/workflows/ci.yml`) - typecheck, lint, format check, tests, build. It needs no
  database.
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
- [ ] **M1 - Background job execution.** Redis, a queue, a worker service, persisted state
      transitions, retries, worker heartbeats.
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
