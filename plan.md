# Milestone 0 - Project Foundation

Implementation plan for [PRD.md](./PRD.md) §31, Milestone 0.

**Definition of done:** a user can create a fake job and see its status in the UI.

"Fake" means the job is persisted and rendered, but nothing executes it. No queue, no
worker, no sandbox, no LLM. Those arrive in Milestones 1-2.

---

## Confirmed technology decisions

| Area | Choice | Rationale |
|---|---|---|
| Monorepo | pnpm workspaces + Turborepo | Strict dependency isolation, cached task graph, standard for TS monorepos |
| Language | TypeScript, strict mode | PRD §8 |
| Frontend | Next.js (App Router), React, Tailwind, shadcn/ui | PRD §8 Frontend |
| API | Next.js route handlers under `apps/web/app/api` | PRD §8 permits this for early MVP |
| Database | Neon serverless Postgres | Chosen over local Docker Postgres |
| ORM | Drizzle ORM + drizzle-kit | SQL-first, thin runtime, embeds cleanly in the M1 worker |
| Lint/format | ESLint 9 flat config + Prettier | |
| CI | GitHub Actions | PRD §31 "Configure CI" |
| Package manager | pnpm | |

### Deferred to later milestones

`apps/api` and `apps/worker` are **not** created in this milestone. The PRD's long-term
target (§8) is a three-service split - Next.js web, TypeScript control-plane API, worker -
and the repo structure in §30 reflects that. Milestone 0 ships route handlers to reach the
definition of done fastest; the extraction happens in Milestone 1 when the worker and the
`/internal/*` endpoints (§19) create the actual need for a shared service boundary.

The mitigation is that no business logic lives in the route handler itself. All of it goes
in `packages/database` and a `services/` layer that a future `apps/api` can import
unchanged. Route handlers stay thin: parse, validate, delegate, respond.

### Neon driver choice

Use **`drizzle-orm/node-postgres` with the `pg` Pool** against Neon's **pooled** connection
string - not the `neon-http` driver.

Reasoning: `neon-http` is optimized for one-shot edge queries and does not support
interactive transactions. Milestone 1 persists job state transitions and needs them
transactional, and the worker is a long-running Node process where a standard pool is the
right shape. Using `pg` now means web and worker share one driver and one `db` export,
with no rewrite at M1. Neon's pooler (PgBouncer) endpoint handles connection limits.

Consequence: Next.js route handlers touching the DB must run on the Node.js runtime, not
edge. That is the default for App Router route handlers, so no action needed - just do not
add `export const runtime = 'edge'`.

### Neon branching

Neon's branching is a genuine advantage over local Docker here: CI gets an ephemeral
database branch per pull request instead of a fresh container, and migrations are verified
against a real copy of the schema. Set up in Phase 6.

---

## Phase 1 - Repository and workspace scaffold

The working directory currently contains only `PRD.md` and is not a git repository.

- [ ] `git init`, set default branch to `main`
- [ ] Write `.gitignore` (node_modules, .next, .turbo, dist, .env*, !.env.example)
- [ ] `package.json` at root: `private: true`, `packageManager: pnpm@<version>`, engines
      pinning Node 22 LTS
- [ ] `pnpm-workspace.yaml` declaring `apps/*` and `packages/*`
- [ ] `turbo.json` with `build`, `dev`, `lint`, `typecheck`, `test` tasks and correct
      `dependsOn` / `outputs` wiring
- [ ] `.nvmrc` pinning the Node version
- [ ] Initial commit

**Directory layout created this milestone** (a subset of PRD §30, unused dirs omitted
rather than left empty):

```text
Rivet/
├── apps/
│   └── web/
├── packages/
│   ├── database/
│   ├── contracts/
│   └── config/          # shared tsconfig + eslint bases
├── .github/workflows/
├── docs/
└── README.md
```

**Verify:** `pnpm install` succeeds; `pnpm turbo run build` runs with no tasks.

---

## Phase 2 - Shared configuration

- [ ] `packages/config/tsconfig.base.json` - `strict: true`, `noUncheckedIndexedAccess`,
      `moduleResolution: "bundler"`, `isolatedModules`, `target: ES2022`
- [ ] `packages/config/eslint.base.js` - ESLint 9 flat config, typescript-eslint,
      `no-floating-promises`, consistent type imports
- [ ] Root `prettier.config.mjs` + `.prettierignore`
- [ ] Each package/app extends the shared base rather than redefining rules
- [ ] Root scripts: `lint`, `format`, `format:check`, `typecheck`, `test`, `build`, `dev`

**Verify:** `pnpm lint` and `pnpm typecheck` pass on the empty scaffold.

---

## Phase 3 - Neon setup and the Job table

### 3a. Provision Neon

- [ ] Create Neon project (region closest to you; note it for later worker colocation)
- [ ] Record `NEON_PROJECT_ID` and create an API key for CI
- [ ] Capture both connection strings - direct and **pooled**
- [ ] `.env.example` documenting `DATABASE_URL` (pooled) and `DATABASE_URL_UNPOOLED`
      (direct, used by drizzle-kit for migrations)
- [ ] Local `.env.local`, gitignored

Migrations run against the **unpooled** URL. DDL through PgBouncer in transaction mode is
unreliable; application queries use the pooled URL.

### 3b. `packages/database`

- [ ] Deps: `drizzle-orm`, `pg`, `@types/pg`; dev: `drizzle-kit`
- [ ] `src/schema/job.ts` - the Job table
- [ ] `src/client.ts` - exports a lazily-constructed `db` from a `pg.Pool`, reading
      `DATABASE_URL`, with a clear error if unset
- [ ] `drizzle.config.ts` pointing at the schema and the unpooled URL
- [ ] `src/index.ts` re-exporting `db`, schema, and inferred types
- [ ] Scripts: `db:generate`, `db:migrate`, `db:studio`

### 3c. Job schema

Model the subset of PRD §10.3 that Milestone 0 can populate honestly. Columns whose values
only exist once execution is real - `base_commit_sha`, `started_at`, `completed_at`,
`final_branch`, `pull_request_url`, `failure_reason` - are created now as nullable, so the
table is shaped correctly and M1 fills them in without a migration.

Omitted until their owning milestone: `user_id` (no auth yet, M0 has no users) and
`repository_id` (no Repository table until GitHub integration, M9). Adding them now would
mean a foreign key to a table that does not exist. Instead `repo_url` is a plain text
column the user types in, which is enough for a fake job.

- [ ] `id` - uuid, primary key, `defaultRandom()`
- [ ] `title` - text, not null
- [ ] `description` - text, not null
- [ ] `repo_url` - text, not null
- [ ] `base_branch` - text, not null, default `'main'`
- [ ] `base_commit_sha` - text, nullable
- [ ] `status` - Postgres enum `job_status`, not null, default `'queued'`
- [ ] `priority` - integer, not null, default `0`
- [ ] Budget columns per §10.3 with sane defaults: `max_duration_seconds` (3600),
      `max_cost_usd` (numeric, 5.00), `max_model_calls` (200), `max_tool_calls` (500)
- [ ] `started_at`, `completed_at` - timestamptz, nullable
- [ ] `created_at`, `updated_at` - timestamptz, not null, default `now()`
- [ ] `final_branch`, `pull_request_url`, `failure_reason` - text, nullable
- [ ] Index on `(status, created_at desc)` for the dashboard list query

The `job_status` enum uses the full set from PRD §10.3 - `queued`, `provisioning`,
`analyzing`, `planning`, `implementing`, `testing`, `reviewing`, `revising`, `finalizing`,
`completed`, `failed`, `cancelled`, `budget_exceeded`, `timed_out` - defined completely
now. Postgres enum values are cheap to add but awkward to reorder, and later milestones
transition through all of them.

- [ ] Generate and apply the initial migration
- [ ] Commit the generated SQL to `packages/database/drizzle/`

**Verify:** `pnpm db:migrate` succeeds; `pnpm db:studio` shows an empty `jobs` table with
the expected columns.

---

## Phase 4 - Contracts package

- [ ] `packages/contracts` with `zod`
- [ ] `createJobSchema` - title (1-200 chars), description (1-10000), repo_url (valid URL,
      https), base_branch (optional, defaults `main`)
- [ ] `jobStatusSchema` - enum mirroring the DB enum, plus a `TERMINAL_STATUSES` set and an
      `isTerminal()` helper the UI uses to stop polling
- [ ] Exported response types: `JobSummary` (list rows), `JobDetail`
- [ ] A type-level assertion that the Zod status enum and the Drizzle enum stay in sync, so
      a drift breaks `typecheck` rather than production

Shared validation between client and server, and the future `apps/api` imports it unchanged.

---

## Phase 5 - Web app

### 5a. Scaffold

- [ ] `apps/web` - Next.js App Router, TypeScript, Tailwind
- [ ] shadcn/ui init; add `button`, `input`, `textarea`, `card`, `table`, `badge`,
      `sonner`, `skeleton`
- [ ] Root layout, dark-mode-aware theme tokens
- [ ] Workspace deps on `@rivet/database` and `@rivet/contracts`

### 5b. Service layer

- [ ] `apps/web/lib/services/job-service.ts` - `createJob()`, `listJobs()`, `getJob(id)`
- [ ] No Next.js imports in this file. It takes plain arguments and returns plain data, so
      the M1 `apps/api` can lift it out verbatim.

### 5c. `POST /api/jobs`

- [ ] `apps/web/app/api/jobs/route.ts`
- [ ] `POST` - parse body, validate with `createJobSchema`, delegate to `createJob()`,
      return `201` with the created job
- [ ] `GET` - list jobs, newest first, with a `limit` cap
- [ ] `400` with field-level errors on validation failure; `500` with a generic message and
      a server-side log on unexpected errors - never leak the DB error to the client
- [ ] `apps/web/app/api/jobs/[id]/route.ts` - `GET` one job, `404` when absent

Path shape matches PRD §19. `POST /api/jobs/:id/cancel` and `/events` are deliberately not
implemented - there is nothing to cancel and no events to stream until M1 and M3.

### 5d. UI

Three pages, matching PRD §18.2 and §18.3 at the fidelity M0 can support:

- [ ] `/` - dashboard. Table of jobs: title, repo, status badge, created time. Empty state
      pointing at the new-job page. "New job" button.
- [ ] `/jobs/new` - form over `createJobSchema` via react-hook-form + zodResolver.
      Client-side validation mirrors the server's. Submits, then redirects to the detail page.
- [ ] `/jobs/[id]` - detail. Title, description, repo, base branch, status badge, budget
      values, timestamps. A placeholder panel for the execution timeline, labelled as
      arriving in Milestone 3, so the page has an honest shape to grow into.
- [ ] `StatusBadge` component - one color mapping for all 14 statuses, used everywhere
- [ ] Server components read through the service layer directly; only the form is a client
      component

**Status display without a worker:** nothing changes a job's status in M0, so every job
reads `queued` forever. Rather than fake a transition, add a small dev-only "Advance
status" control on the detail page hitting a `PATCH /api/jobs/:id` guarded by
`NODE_ENV !== 'production'`. It proves the status pipeline end to end - DB enum, contract,
badge, refetch - and gets deleted in M1 when the worker drives transitions for real. This
is the "fake job" the definition of done asks for.

**Verify the definition of done:** `pnpm dev`, fill in the form, land on the detail page,
see the job at `queued`, advance it, see the badge change, return to the dashboard and see
it listed.

---

## Phase 6 - CI

- [ ] `.github/workflows/ci.yml` - on push to `main` and all PRs
- [ ] Steps: checkout, pnpm setup with cache, `pnpm install --frozen-lockfile`,
      `pnpm typecheck`, `pnpm lint`, `pnpm format:check`, `pnpm build`
- [ ] Turborepo remote cache left off for now; local cache is enough at this size
- [ ] `.github/workflows/neon-branch.yml` - on PR opened/reopened/synchronize, create a
      Neon branch named `preview/pr-<n>` via `neondatabase/create-branch-action@v6`; run
      `pnpm db:migrate` against its connection string to verify migrations apply cleanly;
      on PR closed, delete it via `neondatabase/delete-branch-action@v3`
- [ ] Repo secrets: `NEON_API_KEY`; repo variable: `NEON_PROJECT_ID`
- [ ] Never echo the branch connection string - it embeds credentials

Migrations are exercised against real Postgres on every PR, which catches the class of
schema bug that only appears on apply.

**Verify:** open a throwaway PR; all checks green; the Neon branch appears and is cleaned
up on close.

---

## Phase 7 - Documentation

- [ ] `README.md` - what Rivet is (two paragraphs from PRD §1), current milestone status,
      prerequisites, setup, env vars, common commands
- [ ] `docs/architecture.md` - the M0 slice of PRD §9, plus an explicit note that the
      API is currently in-process with the web app and why, with the extraction trigger
- [ ] `.env.example` complete and accurate
- [ ] A milestone checklist in the README so progress is visible to a reader landing on the
      repo cold - this is a portfolio project per PRD §2.2

`docs/security.md`, `evaluations.md`, and `demo.md` are listed in PRD §30 but have no
content to hold yet. They arrive with the systems they document.

---

## Out of scope for Milestone 0

Named explicitly so they do not creep in:

- Authentication and the User table - no `user_id` on Job yet
- Redis, BullMQ, the worker service (M1)
- Docker, sandboxing (M2)
- SSE, live timeline, JobStep / ToolCall / ModelCall tables (M3)
- Pi adapter, any LLM call (M4)
- GitHub API, OAuth, the Repository table (M9)
- S3 / object storage
- Deployment to Vercel or anywhere else
- Tests beyond what CI needs to be meaningful. A handful of unit tests on the contracts
  package and the service layer are worth writing here; the full strategy in PRD §28
  depends on systems that do not exist yet.

---

## Risks

**The route-handler API becomes load-bearing.** The mitigation is the service layer in 5b.
If business logic starts accumulating in `route.ts` files, extract `apps/api` immediately
rather than at M1.

**Neon cold starts.** The free tier suspends compute after inactivity, so the first request
after an idle period takes a second or two. Harmless in development; worth knowing before
you debug a "slow" query that is not slow. Configure the suspend timeout if it grates.

**Enum churn.** Defining all 14 statuses now is a bet that the PRD's list is right. If it
changes, adding values is a one-line migration; removing or reordering them is not. Prefer
adding.
