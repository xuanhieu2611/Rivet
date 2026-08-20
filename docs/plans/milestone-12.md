# Milestone 12: Public demo polish

M10 made Rivet measurable and M11 made it watchable. M12 is the milestone where somebody who did not
build it can look at it for sixty seconds and understand what it is - and where the demo does not
depend on a model behaving well while a stranger watches.

The PRD checklist (§2734):

- [ ] Landing page
- [ ] polished job UI
- [ ] timeline animation
- [ ] diff viewer
- [ ] test result cards
- [ ] evaluation dashboard
- [ ] architecture diagram
- [ ] README
- [ ] demo repository
- [ ] seeded demo issue
- [ ] backup prerecorded successful run

Plus the standing constraints: §32 (task difficulty progression), §33 (the public demo scenario),
§34 (the sixty-second script), §35 (the three-to-five minute interview version) and §36 (demo
reliability - "never rely on an unpredictable live AI run for the only version of your public demo",
which is the sentence this milestone is organized around).

---

## Scope decisions, taken up front

1. **No deployment. Local only, plus a recording.** M11 deferred hosting and M12 does not pick it
   up. The reason is structural rather than lazy: `RIVET_SANDBOX=docker` refuses to boot against a
   control plane a container can reach, so a hosted worker means a hosted **local** Postgres and
   Redis on the same box as Docker, which is a different milestone with a different risk profile.
   `docs/architecture.md`'s standing note about the SSE stream needing a streaming-capable host
   stays open and unaddressed. M12's deliverable is a repository, a UI and a video, not a URL.
2. **No public read surface. The frozen replay fixture is the public artifact.** Every API route
   keeps its guard and `PUBLIC_ROUTES` does not grow. A visitor sees a real run through the recorded
   video and the landing page's stills; an operator sees a real run by signing in and replaying a
   captured job through the actual UI. There is no share token, no per-job public route and no new
   redaction question about repository content becoming world-readable.
3. **The landing page is a portfolio page, not a product page.** Its job is §35's topic list - why
   jobs instead of chat, why sandboxing, why Postgres plus Redis, how checkpoints work, why the
   reviewer is separate, how evaluation works, what happens when a worker crashes - with the
   architecture diagram and the M10 evaluation numbers as evidence. It sells the system, and the
   only call to action is "sign in" for the person who owns the box.
4. **Two demo repositories, tiered.** The headline is §33's booking race condition at level 6,
   including the deliberate first-attempt failure §34 asks for. The one run live in front of people
   is a level-4 seeded issue that succeeds most of the time. Maintaining two is the price of a demo
   that is both impressive and repeatable, and the replay fixture is what makes the expensive one
   safe to show.
5. **Two new runtime dependencies, and no more.** `react-diff-view` for the diff and `motion` for
   the timeline. The evaluation dashboard gets no chart library: its charts stay hand-rolled SVG and
   CSS over data we already compute.

---

## The claim this milestone makes

**M12 adds no table, no column, no job status, no job event type and no failure category. It is the
first milestone since M0 whose schema footprint is exactly zero.**

That is not a coincidence, it is the design constraint that makes the replay honest. The temptation
in a demo-polish milestone is a `demo_runs` table, a `is_demo` flag or a public-visibility column -
each of which makes the thing on screen a special case of the system rather than the system. The
alternative, and what this plan specifies, is that **a replayed run is an ordinary job**: created
through `createJob()`, moved by `transitionJob()`, its events written by `appendEvent()`, streamed
to the browser by the same SSE route that serves a live worker. Nothing on the page can tell the
difference, because there is nothing to tell.

This is the same claim M10 made about evaluation runs, for the same reason, and it is enforced the
same way: acceptance run E replays a captured job and asserts the projected event list equals the
original's.

The one new configuration value is `RIVET_REPLAY` (`on` | `off`, `off` by default), the sixth member
of the switch family and **refused under `NODE_ENV=production`** alongside `RIVET_SANDBOX`,
`RIVET_AGENT`, `RIVET_GITHUB`, `RIVET_EVAL` and `RIVET_AUTH`. A process that can manufacture a
convincing job timeline out of a file is exactly the kind of thing that must not exist in
production, for the same reason a worker that completes jobs without touching a repository must not.

---

## What already exists, and what M12 actually adds

- **The job detail page is complete but unstyled for an audience.** 339 lines of server component, a
  657-line timeline, artifact, validation, review and plan panels, and a live provider that already
  handles replay, dedupe, hidden tabs and terminal draining. M12 does **not** rewrite this. It
  restyles it and adds two things it lacks: a real diff viewer and motion on append.
- **The diff is already durable and already fetched.** `job_artifacts` holds the `diff` artifact
  bounded by `RIVET_ARTIFACT_MAX_BYTES`, `byte_size` records the true pre-truncation size, and
  `/api/jobs/:id/artifacts/:artifactId` serves it. What is missing is rendering: today it is a
  `<pre>`. The viewer is a presentation change over data that already exists.
- **Test results already exist as structured reports.** `validation_report` and `baseline_report`
  carry per-check status, outcome, parsed totals and named failures, and `validation-panel.tsx`
  renders them as a table. "Test result cards" is a redesign of that panel, not new plumbing, and
  the interesting content - `verified` / `fixed` / `regressed` / `unresolved` / `unverified`, and
  new versus pre-existing failures - is already computed.
- **The evaluation dashboard exists.** `/evaluations` and `/evaluations/:id` with five components.
  M12 gives it a summary header a non-engineer can read (success rate, cost, duration, the arm
  comparison from `docs/experiments/reviewer-value.md`) and leaves the tables alone.
- **The README is 491 lines and is written for a contributor.** M12 splits the audience: a short top
  section for the visitor with the diagram, the video and the numbers, and everything else pushed
  down or into `docs/`.
- **There is no landing page.** `/` is the auth-gated dashboard.
- **There is no capture, no replay and no recording.** This is the genuinely new engineering.

---

## Work item 1: the landing page and the route split

`/` becomes a public server component with no database read at all - it renders checked-in copy, a
checked-in diagram, checked-in stills and the evaluation numbers as **static data written by the
build of the experiment**, not as a live query. That last part is what keeps `pnpm build` working
with no `DATABASE_URL`, which is the property CI's verify job exists to protect. The dashboard moves
to `/jobs` and keeps `requirePageSession()`.

Page guarding is a different mechanism from API guarding (`requirePageSession` versus
`requireSession` plus `PUBLIC_ROUTES`), and today it is a convention rather than a test.
`apps/web/lib/auth/routes.test.ts` walks every `route.ts` under `app/api`; M12 extends the same idea
to `app/**/page.tsx` with its own explicit allowlist containing exactly `/` and `/sign-in`. Adding a
page then means adding a guard, and you find out at unit-test time - the same bargain the API side
already makes.

Content, in order: what Rivet is in two sentences, the sixty-second video, the architecture diagram,
a run walkthrough with real screenshots, the evaluation numbers with the reviewer experiment, and
the tradeoff sections from §35. The design pass loads the `frontend-design` skill rather than
inventing a look here.

## Work item 2: the diff viewer

`react-diff-view` parses the unified diff and gives hunk and line primitives; Rivet owns the styling
in Tailwind so the viewer matches the rest of the app rather than importing a theme that fights it.
`diff2html` was the alternative and is rejected for one specific reason: it produces an HTML string,
which means rendering repository content the model just wrote through `dangerouslySetInnerHTML`. It
escapes correctly today, and a component renderer means never having to check that again.

What the viewer must handle, because the capture path already produces all of it:

- **Binary hunks.** `--binary --full-index` patches contain literal binary deltas. They render as a
  stated "binary file changed", never as garbage.
- **Truncated diffs.** An artifact above the cap is clipped head and tail with `byte_size` recording
  the truth. The viewer says so at the clip point rather than presenting a short diff as a whole
  one.
- **Additions, deletions and mode changes**, which have no counterpart side.
- **Collapse by default above a file count threshold**, with per-file expand. A 40-file diff must
  not be a scroll.

It is a client island on the job page, fetched on demand exactly as the artifact panel already
fetches, so the server-rendered page stays server-rendered.

## Work item 3: timeline animation

`motion` (the framer-motion successor), on the timeline and the status badge only. Two traps, both
worth stating before anyone writes the component:

- **Animate appends, not replays.** The live provider reconnects from durable event ids and
  deduplicates replayed rows. A naive enter animation replays the entire timeline every reconnect
  and every visibility change, which looks broken and is the opposite of what motion is for. The
  reducer already knows the mount cursor; only ids above it animate, and that is an assertion in
  `stream-state.test.ts` rather than a hope.
- **`prefers-reduced-motion` is respected**, and the terminal `router.refresh()` must not restart
  anything.

Motion budget: enter transitions on new timeline rows, a status transition on the badge, and the
progress of the active phase. Nothing else moves. The `animate` skill informs the curves and
durations at implementation time.

## Work item 4: capture and replay

The new engineering, and it is two commands.

**`pnpm demo:capture <jobId> --name <name>`** reads a completed job from the local database and
writes a git-tracked fixture directory under `demo/replays/<name>/`: `job.json` (the creation input
and the terminal facts), `events.ndjson` (every row in order, with its recorded offset from the
first event in milliseconds), `artifacts/` and `commands/`. Every byte goes through the `Redactor`
on the way out - the same port M11 put in front of the three durable writers - because a capture is
a file that gets committed to a public repository, which is a stronger requirement than a database
row, not a weaker one. Acceptance run F pairs the sentinel search with a non-secret sentinel written
the same way, for the reason run D already documents: a redaction test without a positive control
passes identically against a search that has stopped searching.

**`pnpm demo:replay <name>`** creates a real job through `createJob()`, claims it under a synthetic
lease owner, and walks the recorded stream: `transitionJob()` for each status change with the
recorded event payload, `appendEvent()` for every other row, `recordArtifact()` and
`recordCommand()` for the bodies, paced at the recorded offsets and compressible by a `--speed`
factor for a demo that must fit sixty seconds. The browser sees a genuine live SSE stream, because
it is one.

Three properties this design buys, each of which is why it is worth doing rather than shipping a
video alone:

1. **The single-writer invariants survive.** `transitionJob()` remains the only writer of
   `jobs.status` and `appendEvent()` the only writer of `job_events`. A fixture loader that inserted
   rows directly would break both in the one place where the breakage is invisible.
2. **The replay exercises the real UI.** If the timeline, the diff viewer or the SSE reducer is
   broken, the replay is broken, so the fallback cannot rot while the product changes.
3. **It is a regression test.** Run E replays a captured job and compares the projected event list
   to the original's, which is the same comparison M10 uses to prove a locally seeded job is
   indistinguishable from a GitHub-seeded one.

The recording itself is a separate deliverable: the §34 sixty-second cut, checked into `docs/` or
linked from it, plus the §35 three-to-five minute version. Both are recorded from real runs, and the
replay is what makes re-recording cheap when the UI changes.

## Work item 5: the demo repositories and the seeded issue

Two throwaway GitHub repositories under the demo account, each with a seeded issue, each mirrored as
a benchmark case so the evaluation harness can run it without GitHub:

- **`rivet-demo-booking`** - §33's concurrent double-booking bug at level 6. A booking endpoint with
  a check-then-insert race, a fix that needs a unique constraint, a transaction and a concurrency
  regression test, and a first attempt that plausibly fails on the unhandled conflict error, which
  is the §34 beat that makes the autonomy read as real. This is the headline and the recorded run.
- **`rivet-demo-<level-4>`** - a bug requiring test creation, small, dependency-light, high success
  rate. This is what gets run live.

Both seeded issues are written as an ordinary engineer would write them, because the issue body is
the task description and M11's fencing exists precisely because that text is untrusted. Neither
contains anything cute.

## Work item 6: the architecture diagram and the README

One diagram, two renderings: Mermaid in `docs/architecture.md` and the README (which GitHub
renders), and a hand-built SVG for the landing page that reads in both themes. It shows what is
actually interesting - browser and worker both calling core directly, Postgres holding state and
Redis holding nothing that matters, the four ports, and the container boundary with the model key
outside it.

The README's first screen becomes: what it is, the diagram, the video, the evaluation numbers, and
how to run it. Everything currently there survives further down or in `docs/`.

---

## Acceptance runs

A-D and F need no Docker, no database and no model and run in `pnpm test`. E is integration (real
Postgres, no Docker, no model). G and H are the expensive ones.

- **A. The landing page builds and renders with no database and no session.** An RSC test with
  `DATABASE_URL` unset. This is the CI-verify property, restated for the one page most likely to
  break it by reaching for a live number.
- **B. Page-guard coverage is exhaustive.** Every `page.tsx` either guards itself or appears in the
  page allowlist, and every guarded page redirects when unauthenticated - the page-side twin of
  `routes.test.ts` and `live-guard.test.ts`.
- **C. The diff viewer renders every shape.** Binary hunk, rename, pure addition, pure deletion,
  mode change, and a truncated artifact that says it is truncated. Pure unit tests over checked-in
  patches, including one taken from a real capture.
- **D. Motion animates appends only.** A replayed reconnect produces no enter animations; a
  genuinely new event does; `prefers-reduced-motion` disables both.
- **E. A replayed job is indistinguishable from the original.** Capture a completed job, replay it,
  and assert the projected event list, statuses and artifact digests match. Integration, real
  Postgres, no Docker and no model.
- **F. Capture redacts, with a positive control.** A sentinel secret planted in a job's events,
  command transcripts and artifact bodies does not appear anywhere under `demo/replays/`, while a
  non-secret sentinel written the same way does. Plus: `RIVET_REPLAY=on` is refused under
  `NODE_ENV=production`.
- **G. The demo repositories build and grade.** Both cases build through `pnpm eval:build` and grade
  through the M10 harness, so "the demo task is solvable" is a measured claim and not a hope.
  Docker.
- **H. `pnpm demo:replay booking` drives the real UI end to end**, and the recorded sixty-second cut
  exists and matches the §34 beats. This is the milestone's demo.

`docs/plans/milestone-12-acceptance.md` is written first, as in M8 through M11, and maps each run to
its implementation.

---

## Risks, and what they cost

- **The race-condition demo may not succeed often enough to record.** This is the accepted risk, and
  the tiering plus the replay is the mitigation. If it proves unrecordable after real attempts, the
  headline demo drops to level 5 and the plan says so rather than faking a run.
- **Replay drift.** A capture is a file, the schema is not frozen, and a future milestone that adds
  an event type can make an old fixture render oddly. Run E catches structural drift; the honest
  answer is that fixtures are re-captured when the pipeline changes, which the capture command makes
  a one-line job.
- **`react-diff-view` owns a visible part of the demo.** It is a small, parse-plus-primitives
  library rather than a widget, and the styling is ours, so replacing it is a rendering change
  rather than a redesign. That is the whole reason it was preferred over a batteries-included
  viewer.
- **A polish milestone attracts scope.** Dashboards, filters, search, a settings redesign and a
  dark-mode toggle are all out. The checklist is eleven items and the milestone ends when they are
  done.
