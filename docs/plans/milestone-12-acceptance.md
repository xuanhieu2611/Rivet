# Milestone 12: the acceptance contract

**Status: in progress.** Written before the remaining M12 code, the way M8 through M10 were, so the
code is measured against it rather than the other way around.
[`docs/plans/milestone-12.md`](milestone-12.md) is the plan. Runs A-F need no Docker, no database
and no model and run in `pnpm test`. G needs Docker. H is the milestone's demo.

| run | where it lives                                                                                 |
| --- | ---------------------------------------------------------------------------------------------- |
| A   | `apps/web/app/(public)/page.test.ts`                                                           |
| B   | `apps/web/lib/auth/pages.test.ts` (static), `apps/web/lib/auth/live-page-guard.test.ts` (live) |
| C   | `apps/web/components/diff-viewer/diff-viewer.test.ts`                                          |
| D   | not yet (work item 3)                                                                          |
| E   | not yet (work item 4)                                                                          |
| F   | not yet (work item 4)                                                                          |
| G   | not yet (work item 5)                                                                          |
| H   | not yet (work item 4 / recording)                                                              |

M12 adds no table, no column, no job status, no job event type and no failure category. A replayed
run is an ordinary job. The organising risk is a page that looks public while it is not, or a
landing page that looks static while it is reading Postgres.

---

## The runs

| run                                         | ends                                                     | why it is here                           |
| ------------------------------------------- | -------------------------------------------------------- | ---------------------------------------- |
| A. landing builds with no database          | RSC renders; no `@rivet/core` / `@rivet/database` import | the CI-verify property, restated for `/` |
| B. every page guarded                       | redirect from every non-public page, before any read     | coverage is not behaviour                |
| C. diff viewer renders every shape          | binary, rename, add, delete, mode, truncated             | work item 2                              |
| D. motion animates appends only             | reconnect is still; a new id animates                    | work item 3                              |
| E. replayed job matches the original        | projected events, statuses, artifact digests             | work item 4                              |
| F. capture redacts, with a positive control | sentinel absent; control present; `RIVET_REPLAY` refused | work item 4                              |
| G. demo repositories build and grade        | both cases through `eval:build` and the M10 harness      | work item 5                              |
| H. `pnpm demo:replay booking` drives the UI | recorded sixty-second cut matches the §34 beats          | the milestone's demo                     |

---

## A - The landing page builds and renders with no database and no session

**`apps/web/app/(public)/page.test.ts`.**

`/` is a public server component. It renders checked-in copy, a checked-in diagram, checked-in still
slots and the Experiment 1 numbers from a TypeScript module, not from a query. `DATABASE_URL` is
unset for the duration of the run. Importing and rendering the page must succeed, and the rendered
markup must contain the static success fractions (`15/15`, `14/15`) so a page that rendered an empty
shell cannot satisfy it.

The page module and every local module it imports (`@/components/landing/*`, `@/lib/landing/*`) must
not import `@rivet/core` or `@rivet/database`. A live query of `evaluation_suites` would make
`pnpm build` need a database, which is the property CI's verify job exists to protect.

**Positive control:** the rendered markup is asserted to contain a non-empty, named substring from
the Experiment 1 snapshot. A render that produced nothing would otherwise compare equal to a page
that forgot to read the snapshot.

The page is `dynamic = "force-static"`. That is the compile-time half of the same claim: a later
edit that calls `cookies()`, `headers()` or any other dynamic API fails the build rather than
silently becoming a request-time page.

---

## B - Page-guard coverage is exhaustive

**`apps/web/lib/auth/pages.test.ts`** (static) and **`apps/web/lib/auth/live-page-guard.test.ts`**
(live).

Page guarding is a different mechanism from API guarding (`requirePageSession` versus
`requireSession` plus `PUBLIC_ROUTES`), and until M12 it was a convention. These two files are the
page-side twin of `routes.test.ts` and `live-guard.test.ts`.

The allowlist is `PUBLIC_PAGES` in `apps/web/lib/auth/public-pages.ts`, and it contains exactly `/`
and `/sign-in`. Every `page.tsx` under `app/` either appears on that list or its source contains
`requirePageSession`. Public pages must not contain `requirePageSession`. Adding a page then means
adding a guard, and you find out at unit-test time.

The live half **invokes** every non-public page with GitHub auth on and no session cookie, and
insists on a redirect to `/sign-in`. It runs in `pnpm test` with no database. `DATABASE_URL` is
unset, so a page that touches Postgres before it checks the session cannot redirect - it throws, and
this file fails. "Refuses before it reads" is therefore asserted by construction.

`generateMetadata` is an entry point of its own. Where a page exports it, the live run invokes that
too.

The Next.js proxy (`apps/web/proxy.ts`) uses the same `PUBLIC_PAGES` set. Without that, GitHub auth
mode would bounce `/` to `/sign-in` before the landing page ran. `apps/web/lib/auth/proxy.test.ts`
asserts `/` and `/sign-in` pass through and `/jobs` still redirects.

**Positive control:** the live run asserts that it invoked more than one page. A loop that matched
nothing - a renamed directory, a changed file name - would pass silently, which is the one way a
coverage test can be worse than no test.

---

## C - The diff viewer renders every shape

**`apps/web/components/diff-viewer/diff-viewer.test.ts`** (render) and
**`apps/web/components/diff-viewer/parse-diff-artifact.test.ts`** (parse).

Work item 2. Pure unit tests over checked-in patches under
`apps/web/components/diff-viewer/fixtures/`: binary hunk (`binary-literal.patch`, a
`--binary --full-index` capture), `Binary files` marker, rename, pure addition, pure deletion, mode
change, and a truncated artifact that says it is truncated at the clip point. `captured.patch` is
one patch taken from a real git capture covering every shape together. A 40-file synthetic diff
starts collapsed.

---

## D - Motion animates appends only

Work item 3. A replayed reconnect produces no enter animations; a genuinely new event does;
`prefers-reduced-motion` disables both. Asserted in `stream-state.test.ts` rather than hoped.

---

## E - A replayed job is indistinguishable from the original

Work item 4. Capture a completed job, replay it, and assert the projected event list, statuses and
artifact digests match. Integration, real Postgres, no Docker and no model. The same comparison M10
uses to prove a locally seeded job is indistinguishable from a GitHub-seeded one.

---

## F - Capture redacts, with a positive control

Work item 4. A sentinel secret planted in a job's events, command transcripts and artifact bodies
does not appear anywhere under `demo/replays/`, while a non-secret sentinel written the same way
does. Plus: `RIVET_REPLAY=on` is refused under `NODE_ENV=production`.

---

## G - The demo repositories build and grade

Work item 5. Both cases build through `pnpm eval:build` and grade through the M10 harness, so "the
demo task is solvable" is a measured claim and not a hope. Docker.

---

## H - `pnpm demo:replay booking` drives the real UI

Work item 4 and the recording. End to end against the real UI, and the recorded sixty-second cut
exists and matches the §34 beats. This is the milestone's demo.
