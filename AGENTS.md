# AGENTS.md

This file provides guidance to coding agents when working with code in this repository.

## What Rivet is

An autonomous software engineering platform: you point it at a repository, describe a task, and it
runs the whole workflow (read, plan, edit, test, review, open a PR). The interesting part is the
job-execution system around the coding agent, not the code generation.

`PRD.md` and `plan.md` are at the repo root and are **gitignored but present on disk**. Read them
for product intent and milestone scope. `docs/architecture.md` describes the system as it actually
exists today and is the best starting point for any structural question.

**Current state: Milestone 0 is complete.** Jobs are persisted and rendered, but nothing executes
them. There is no queue, worker, sandbox, or model call. A new job sits at `queued` forever.

## Commands

All root scripts fan out through Turborepo.

```bash
pnpm dev                 # Next.js dev server on :3000
pnpm build               # production build; must work with NO database (CI relies on this)
pnpm lint                # eslint, type-aware
pnpm typecheck           # tsc --noEmit across every workspace
pnpm test                # vitest across every workspace
pnpm format              # prettier --write .
pnpm format:check        # what CI runs

pnpm db:generate         # drizzle-kit generate, after editing the schema
pnpm db:migrate          # apply migrations (uses DATABASE_URL_UNPOOLED)
pnpm db:studio           # drizzle studio
```

Scope to one package with `--filter`, which is also how you run a single test:

```bash
pnpm --filter @rivet/web test lib/job-status.test.ts
pnpm --filter @rivet/contracts test -t "rejects a non-https repo url"
pnpm --filter @rivet/web typecheck
```

Turbo caches aggressively. Add `--force` when you need to prove something from cold.

## Architecture

```
apps/web            Next.js 16 App Router. Pages, route handlers, and the service layer.
packages/contracts  Zod schemas, the job status enum, JobSummary / JobDetail. No runtime deps on db.
packages/database   Drizzle schema, generated migrations, the pg Pool. Neon Postgres.
packages/config     tsconfig + ESLint bases that every workspace extends.
```

Workspace packages are consumed as **raw TypeScript** (`main` points at `src/index.ts`). There is no
build step for `packages/*`, and `transpilePackages` is deliberately absent from `next.config.ts`.

A request has two entry points and one path underneath. Server components call the service layer
directly; there is no HTTP hop from a page to the app's own route handler.

```
browser ──page nav──▶ server component ─┐
        ──fetch()───▶ route handler ────┴──▶ job-service ──▶ Drizzle ──▶ pg Pool ──▶ Neon
                      (zod validate)          (all logic)
```

### Invariants that are easy to break

**`apps/web/lib/services/job-service.ts` must have zero Next.js imports** - not `next/server`, not
`next/cache`, not even `server-only`. It exists to be lifted into `apps/api` verbatim in
Milestone 1. `server-only` guards belong in the pages and handlers that wrap it. Route handlers stay
parse/validate/delegate/respond; if branching or orchestration starts accumulating in a `route.ts`,
that is the signal to extract `apps/api` early.

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

### Database

Two connection strings, one root `.env.local` (copy from `.env.example`) that every workspace
shares. `next.config.ts` walks up to `pnpm-workspace.yaml` to load it, since Next only reads env
from its own project directory.

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
- Client components are the exception, not the rule: currently only the new-job form and the dev
  status control.

### Scaffolding to delete

`PATCH /api/jobs/:id`, `nextStatus()` in `apps/web/lib/job-status.ts`, and the "Advance status"
control exist only to exercise the status pipeline while nothing can move a job. They are guarded by
`NODE_ENV !== "production"` and carry `TODO(M1)` markers. Delete them when the worker lands.

## CI

`.github/workflows/ci.yml` runs typecheck, lint, format:check, test, build on every PR and on pushes
to `main`, with no database. `.github/workflows/neon-branch.yml` creates a `preview/pr-<n>` Neon
branch per PR and applies migrations to it. It skips cleanly when the `NEON_API_KEY` secret is
missing (it is not yet set), so a skipped Neon run is expected rather than a failure. Never print a
Neon connection string in a workflow; it embeds credentials.
