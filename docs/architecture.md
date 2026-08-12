# Architecture

This document describes Rivet **as it exists today**, at the end of Milestone 0, and names the
places where the current shape is a deliberate shortcut rather than the intended end state. It is
updated as each milestone lands rather than describing a system that does not exist yet.

## The target, in one picture

The system Rivet is being built towards is a control plane that owns job lifecycle, with workers
that run a coding agent inside disposable sandboxes:

```text
   Web UI  ──HTTPS/SSE──▶  Control plane  ──▶  Postgres (state)
                                │
                                └──▶  Redis queue  ──▶  Workers
                                                          │
                                                          ▼
                                               Orchestrator + sandbox
                                                          │
                                          clone · edit · test · review · PR
```

Milestone 0 builds only the leftmost column: a UI, an API, and durable job state. Everything
downstream of the queue arrives in Milestones 1 through 5.

## What exists today

| Component     | Where                                  | Responsibility                                                    |
| ------------- | -------------------------------------- | ----------------------------------------------------------------- |
| Web UI        | `apps/web/app`                         | Dashboard, new-job form, job detail. Server components by default |
| HTTP API      | `apps/web/app/api/jobs`                | `GET`/`POST /api/jobs`, `GET`/`PATCH /api/jobs/:id`               |
| Service layer | `apps/web/lib/services/job-service.ts` | All job business logic, framework-agnostic                        |
| Contracts     | `packages/contracts`                   | Zod schemas, the status enum, `JobSummary` / `JobDetail`          |
| Data access   | `packages/database`                    | Drizzle schema, generated migrations, the `pg` pool               |
| Shared config | `packages/config`                      | The tsconfig and ESLint bases every workspace extends             |

There is exactly one table, `jobs`, holding the Milestone 0 subset of the domain model: the task the
user described, the repository and base branch, a `job_status` enum covering the full fourteen-state
lifecycle, budget ceilings, and the timestamp and result columns that later milestones fill in.
Columns that only have a value once execution is real are nullable now so the worker does not need a
migration to start writing them.

## How a request flows

Two entry points, one path underneath. A page renders on the server and calls the service layer
directly - there is no HTTP hop from a server component to the app's own route handler:

```text
browser
  │
  ├── page navigation ────▶ React server component  ┐
  │                          (apps/web/app/**)      │
  │                                                 ├──▶ job service ──▶ Drizzle ──▶ pg Pool ──▶ Neon
  └── fetch() from the ───▶ route handler           ┘   (business       (query
      new-job form           (app/api/jobs/**)          logic)          builder)
                             zod validate
```

The route handlers stay thin on purpose: parse the body, validate it with a schema from
`@rivet/contracts`, delegate to the service, map the result to a status code. Validation errors come
back as `400` with field-level detail; anything unexpected is logged server-side and returned as a
generic `500`, never as a database error string.

Every page and route handler that touches the database sets `dynamic = "force-dynamic"`. That is
what lets `pnpm build` - and therefore CI - run with no database at all: nothing is prerendered, so
nothing queries Postgres at build time.

## Why the API is in-process, and when it moves out

The intended topology is three services: the Next.js web app, a control-plane API, and a worker.
Today the API is a set of Next.js route handlers living inside `apps/web`, which is a shortcut taken
to reach a working product in one milestone instead of paying for a service boundary that nothing
yet needs. A second deployable with its own HTTP client, its own auth story and its own deploy
pipeline buys nothing while there is exactly one consumer, in the same process, one function call
away.

**The mitigation is that no business logic lives in a route handler.** All of it is in
`apps/web/lib/services/job-service.ts`, which has no Next.js import - not `next/server`, not
`next/cache`, not even `server-only`. It takes plain arguments and returns plain data, so it can be
moved into an `apps/api` package verbatim, with the route handlers becoming a thin proxy or
disappearing entirely. The `server-only` guards live in the pages and handlers that wrap the
service, which is the correct place for them.

**The extraction trigger is Milestone 1.** When the worker service appears, there are suddenly two
processes that need to read and write job state, and the internal endpoints the worker calls to
report progress create a real service boundary with a real contract. That is the point at which the
shortcut stops being free, and the service layer gets lifted out.

There is one interim rule that keeps this honest: if business logic starts accumulating inside
`route.ts` files - branching, orchestration, anything beyond parse/validate/delegate/respond -
extract `apps/api` immediately rather than waiting for Milestone 1.

## Database access

Rivet uses **`drizzle-orm/node-postgres` with a `pg` Pool**, not Neon's HTTP driver.

The HTTP driver is optimized for one-shot queries from edge runtimes and does not support
interactive transactions. Milestone 1 persists job state transitions that must be transactional, and
the worker is a long-running Node process where a connection pool is exactly the right shape.
Choosing `pg` now means the web app and the future worker share one driver and one `db` export, with
no rewrite when the worker lands.

Two connection strings, for two different jobs:

- **`DATABASE_URL`** is Neon's pooled endpoint, through PgBouncer. All application queries go
  through it, which is what keeps connection counts sane across serverless invocations.
- **`DATABASE_URL_UNPOOLED`** is the direct endpoint. Migrations use it, because DDL through
  PgBouncer in transaction pooling mode is unreliable. The migration script falls back to
  `DATABASE_URL` when it is unset, which is how CI points migrations at an ephemeral branch with a
  single variable.

The consequence of the `pg` choice is that anything touching the database must run on the Node.js
runtime. That is the App Router default, so the rule is simply that `runtime = "edge"` never appears
in this codebase.

The Drizzle client is constructed lazily on first use, so importing `@rivet/database` never opens a
connection or throws. Typecheck, lint and unit-test runs have no `DATABASE_URL` and must not need
one.

## Migrations

Migration SQL is generated by drizzle-kit from the schema and committed under
`packages/database/drizzle/`. It is applied by a small programmatic runner
(`packages/database/src/migrate.ts`) rather than by the drizzle-kit CLI, so that applying migrations
is one plain Node process with no dev-only tooling in its path - the same shape the Milestone 1
worker's deploy step will want.

Every pull request gets an ephemeral Neon branch and has the migrations applied to it before merge.
That catches the class of schema bug that only shows up on apply - a non-nullable column added to a
table with rows, an enum value used before it exists - against a real copy of the database rather
than a fresh empty container.

## What is deliberately absent

Named so their absence reads as a decision rather than an oversight: no authentication or `user_id`
(Milestone 9 brings GitHub identity), no `repository_id` foreign key (there is no Repository table
to point at, so the job stores a plain `repo_url`), no queue or worker (M1), no sandbox (M2), no
event stream or timeline (M3), no model call of any kind (M4), and no deployment.

The dev-only `PATCH /api/jobs/:id` that advances a job's status by hand is the one piece of
scaffolding in the codebase. It exists so the full status path - Postgres enum, contract, badge
component, refetch - is exercised while nothing can move a job on its own, it is disabled when
`NODE_ENV` is `production`, and it is deleted in Milestone 1.
