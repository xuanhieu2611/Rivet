# Milestone 12: the acceptance contract

**Status: complete.** Written before the remaining M12 code, the way M8 through M10 were, so the
code was measured against it rather than the other way around. Acceptance run H was published on
2026-08-22 as the [public demo on X](https://x.com/hieuspringle/status/2091312854389719528).
[`docs/plans/milestone-12.md`](milestone-12.md) is the plan. Runs A-D and F need no Docker, no
database and no model and run in `pnpm test`. E is integration (real Postgres, no Docker, no model).
G needs Docker. H is the milestone's demo.

| run | where it lives                                                                                 |
| --- | ---------------------------------------------------------------------------------------------- |
| A   | `apps/web/app/(public)/page.test.ts`                                                           |
| B   | `apps/web/lib/auth/pages.test.ts` (static), `apps/web/lib/auth/live-page-guard.test.ts` (live) |
| C   | `apps/web/components/diff-viewer/diff-viewer.test.ts`                                          |
| D   | `apps/web/components/job-live/stream-state.test.ts`                                            |
| E   | `apps/worker/tests/integration/replay.int.test.ts`                                             |
| F   | `packages/core/src/replay/capture.test.ts`, `apps/worker/src/config.test.ts`                   |
| G   | `apps/worker/tests/sandbox/demo-repositories.sbx.test.ts`                                      |
| H   | `demo/replays/booking/`; UI replay verified, recording published 2026-08-22                    |

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

**`apps/web/components/job-live/stream-state.test.ts`.**

Work item 3. `selectTimelineMotion()` is the gate. `createJobLiveState()` freezes a mount cursor at
the newest server-snapshot id; only ids above that cursor are eligible to enter-animate. A replayed
reconnect of already-seen ids, an older event delivered after mount, and a terminal snapshot all
produce an empty animate set. A genuinely new id does not.

`prefers-reduced-motion` disables the whole budget: row enters, the live status-badge transition,
and the in-progress marker pulse. The live provider reads the media query and passes it into the
selector, so a reconnect or `router.refresh()` cannot restart motion that the snapshot already
contained.

---

## E - A replayed job is indistinguishable from the original

**`apps/worker/tests/integration/replay.int.test.ts`.**

Work item 4. Seeds a terminal job through the production writers only (`createJob`, `claimJob`,
`transitionJob`, `appendEvent`, `recordArtifact`, `recordCommand`, and the status-free job writers),
captures it with `captureJob()`, and replays it with `replayFixture({ speed: 0 })`. No worker, no
enqueue, no Docker, no model. Real Postgres.

The replayed job's projected event types, terminal status, artifact and command digests, and
detail-page facts (`baseCommitSha`, `envFingerprint`, pull request identity, review decision, usage
totals) must match the original. Serial ids are allowed to differ; that is why comparison is by
digest and by type list, not by row identity.

---

## F - Capture redacts, with a positive control

**`packages/core/src/replay/capture.test.ts`** (redaction) and **`apps/worker/src/config.test.ts`**
(production refusal).

Work item 4. `writeReplayFixture` is handed a redactor and a source whose events, command
transcripts and artifact bodies all contain `sentinel-secret-value` next to `public-sentinel`. The
written tree must not contain the secret, and must contain the control. Plus: `RIVET_REPLAY=on` is
refused under `NODE_ENV=production`, both by `parseWorkerConfig` and by `assertReplayAllowed`.

These run in `pnpm test` with no database.

---

## G - The demo repositories build and grade

**`apps/worker/tests/sandbox/demo-repositories.sbx.test.ts`.**

Work item 5. `rivet-demo-booking` and `rivet-demo-reservations` build through the fixture builder,
then checked-in known-good patches pass their hidden tests through the production M10 grader in real
containers. The public repositories are pushed from those built bare repositories, so their `main`
commits exactly match the benchmark lockfiles. "The demo task is solvable" is therefore a measured
claim and not a hope. No database and no model; Docker.

---

## H - `pnpm demo:replay booking` drives the real UI

Work item 4 and the recording. `demo/replays/booking/` is a redacted capture of real job
`9b3056ce-4cc9-490f-8a0e-854310af0ddf`, ending in
[rivet-demo-booking#3](https://github.com/xuanhieu2611/rivet-demo-booking/pull/3). On 2026-08-19,
`pnpm demo:replay booking --speed 0.1` replayed all 344 events through the production writers in 46
seconds while a real browser loaded the production job page. The replay ended `completed` with the
same pull-request identity.

Run H passed on 2026-08-22 when the
[public demo](https://x.com/hieuspringle/status/2091312854389719528) showed a real job moving from a
GitHub issue to a tested, independently reviewed pull request in 3 minutes 11 seconds. The
checked-in capture remains the deterministic fallback for replaying the production UI without
relying on a live model call.
