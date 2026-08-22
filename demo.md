# Rivet demo: shot list and script

Two videos come out of one filming session.

| output                  | length      | audience                   | where it goes                     |
| ----------------------- | ----------- | -------------------------- | --------------------------------- |
| `rivet-60s.mp4`         | 55-60s      | recruiters, feed scrollers | landing page, LinkedIn, X         |
| `rivet-walkthrough.mp4` | 4-5 minutes | engineers, hiring managers | README, YouTube, LinkedIn comment |

Film the long one first and cut the short one out of the same footage plus two extra pickups. Do not
film them separately; the sixty is a trailer for the four, and shared footage keeps them consistent.

**Format decided:** webcam plus voiceover, screen share for the body. Your face opens and closes
both videos. This is what PRD §34 asks for and it is what makes a stranger believe the thing is
real.

---

## Part 0: what you are actually demonstrating

Before writing anything on camera, be clear about the claim, because every shot serves it. The claim
is **not** "an AI wrote code." Everyone has seen that. The claim is:

> An AI coding session is an unreliable subprocess. I built the system that makes running one
> survivable: leases, checkpoints, sandboxing, deterministic validation, an independent reviewer,
> and measurement.

Every beat below exists to show one part of that sentence. If a shot does not, cut it.

---

## Part 1: pre-production checklist

Do all of this before pressing record. Half of a bad take is preventable here.

### The machine

- [ ] `Do Not Disturb` on. No Slack, no mail, no calendar popups. Quit everything not on screen.
- [ ] Screen resolution set to 1920x1080 for recording, not a scaled 4K desktop. Text must be
  ```
  legible after LinkedIn's compression, which is brutal.
  ```
- [ ] Browser at 125-150% zoom, bookmarks bar hidden, one clean profile with no personal tabs.
- [ ] Terminal font at 16-18pt, light or dark consistently with the browser, no rainbow prompt, no
  ```
  visible directory paths containing anything personal.
  ```
- [ ] Hide desktop icons and the dock if it will be in frame.
- [ ] Battery on mains. Docker plus Postgres plus a model session will not be gentle.

### The stack

- [ ] Local Postgres running: `brew services start postgresql@17`
- [ ] Local Redis running: `redis-server --port 6379 --daemonize yes --save "" --appendonly no`
- [ ] Docker Desktop up: `docker version` prints a Server section
- [ ] Base image already pulled so provisioning does not spend ninety seconds downloading 400MB:
  ```
  `docker pull node@sha256:934240a162082fd8b8a2f90cd5114446443f1eba1c5378f6687167ca405e6584`
  ```
- [ ] `.env.local` with `RIVET_SANDBOX=docker`, `RIVET_AGENT=pi`, `RIVET_GITHUB=app`,
  ```
  `RIVET_AUTH=github`, `RIVET_REPLAY=on`, a funded model key, and the App credentials
  ```
- [ ] `pnpm dev` running, web on :3000, worker attached
- [ ] Signed in already. Do not film the OAuth round trip; it adds nothing and shows your account.
- [ ] Both demo repositories public with issue #1 open: `xuanhieu2611/rivet-demo-booking`,
  ```
  `xuanhieu2611/rivet-demo-reservations`
  ```
- [ ] Any previous demo branches deleted from `rivet-demo-reservations` so the live run opens a
  ```
  clean PR
  ```

### Terminal panes to have ready

Lay these out before recording. You will switch between them, never type setup on camera.

- **Pane A**: the `pnpm dev` output, for the b-roll shot of worker logs moving.
- **Pane B**: empty, for the backup replay: `pnpm demo:replay booking --speed 0.1`
- **Pane C**: empty, for the crash-recovery beat: `pnpm demo:recovery`

### Rehearse once, unrecorded

Run the whole live job end to end without filming. You need to know today's actual timings before
you narrate them, and you need to know the run succeeds on this commit. Note the wall clock of each
phase; you will use it to plan cuts.

---

## Part 2: the reference run

The booking capture is your safety net and your source of truth for numbers. Everything here is
recorded fact from job `9b3056ce-4cc9-490f-8a0e-854310af0ddf`, replayable with
`pnpm demo:replay booking`:

| fact           | value                                                               |
| -------------- | ------------------------------------------------------------------- |
| task           | Prevent concurrent room double-booking (PRD §33's level-6 scenario) |
| wall clock     | 7 minutes 32 seconds                                                |
| durable events | 344                                                                 |
| model turns    | 24, across a planner, an implementer and a reviewer                 |
| tool calls     | 46                                                                  |
| tokens         | 85,087 in, 18,037 out                                               |
| cost           | $0.0141                                                             |
| diff           | 6 files changed, +147 / -19                                         |
| validation     | test verified, typecheck verified, lint verified                    |
| review         | approved, 0 revision loops                                          |
| outcome        | `rivet-demo-booking` PR #3                                          |

**Phase timing, for planning cuts:**

```
0:00  provisioning starts
0:04  baseline recorded: test, typecheck, lint all green before Rivet touched anything
0:04  planning starts
1:56  plan submission REJECTED by Rivet's schema (field over 500 characters)
2:22  corrected plan accepted, plan recorded
2:22  implementation starts, 21 turns, a checkpoint after every one
6:06  validation starts
6:07  validation recorded: verified
6:07  independent review starts
7:26  review approved
7:27  run summarized
7:32  pull request #3 opened, job completed
```

**The honest failure beat is at 1:56 and you must use it.** PRD §34 asks the demo to show the system
failing and recovering, because a demo with no failure looks staged. Both real model attempts solved
this repository cleanly, so the manufactured "test goes red then green" beat does not exist in the
capture and **you must not fake it**. What you have instead is better in one specific way: it is
Rivet catching the model, not the model catching itself. The planner submitted a plan whose
`relevantComponents` field exceeded the schema's 500-character limit, Rivet rejected the tool call,
and the next turn submitted a corrected one. That is a structured-output contract doing its job,
live. Say exactly that.

---

## Part 3: the long walkthrough, take by take

Target 4:30 edited from roughly 12 minutes raw. Film in the order below. Each take is separate, so a
fluffed line costs one take, not the video.

### Take 1: hook, webcam, 20 seconds

Face to camera, no screen.

> "I'm Hieu. I spent the last few months building Rivet, an autonomous software engineering
> platform. You give it a GitHub issue, and it opens a pull request. But the interesting part isn't
> the code generation. Anyone can call a model. The interesting part is everything around it,
> because an AI coding session is an unreliable subprocess, and I had to build the system that makes
> running one survivable. Let me show you."

### Take 2: the issue, 25 seconds

Screen: the GitHub issue on `rivet-demo-reservations`, then the booking issue in a second tab.

> "Here's a real repository, and a real issue. Cancellation isn't scoped to the customer who made
> the reservation, so anyone can cancel anyone's booking. Rivet has never seen this repository.
> There's no hardcoded fix anywhere in my system, and hidden tests it never sees are what decide
> whether it got it right."

Then flick to the booking tab for two seconds:

> "I'll come back to the harder one, a concurrency race condition, later."

### Take 3: creating the job, 25 seconds

Screen: Rivet's new-job form. Pick installation, repository, issue from the pickers. Submit.

> "I pick the repository and the issue through a GitHub App installation, set a budget in dollars
> and a wall clock deadline, and submit. This writes a row to Postgres and puts a job id on a Redis
> queue. That's all the queue message is, an id. Every fact that matters lives in Postgres, so if I
> flush Redis right now, nothing is lost. A sweeper finds every job Postgres says should be moving
> and re-enqueues it."

### Take 4: provisioning and the boundary, 40 seconds

Screen: the job page timeline filling. Point at `sandbox.created`, `repo.cloned`, `deps.installed`.

> "A worker claims the job under a Postgres lease and provisions a Docker container. The repository
> is cloned in, dependencies install, and this is where the most important design decision in the
> project lives. The model's key never enters the container. The agent harness runs on the trusted
> worker host, and its four tools, read, write, edit and bash, all reach into the sandbox over the
> Docker API. So arbitrary cloned code executes with a hard boundary between it and my credentials,
> my database and my Redis. After the session starts, Rivet asserts the active tool list is exactly
> the four it granted, and fails the job if anything else survived. That's the difference between
> believing the boundary holds and knowing it."

Optional two-second aside if the injection event fires and you kept it:

> "That flag is Rivet's prompt-injection scanner reading repository text. It never fails a job, on
> purpose. Pattern matching over prose produces false positives, and the capability boundary is the
> real defense."

```
Take 5: baseline, 20 seconds
```

Screen: the three `baseline.check_recorded` rows.

> "Before touching anything, Rivet runs the repository's own test, typecheck and lint and records
> the result. A red baseline doesn't fail the job, and that's deliberate. It has to be able to work
> on repositories that are already broken. But it needs to know what was broken before it arrived,
> so that later it can tell the difference between a failure it caused and one it inherited."

### Take 6: planning and the rejection, 45 seconds

Screen: planning phase, the plan panel, and the rejected `submit_plan` call. If the live run does
not produce a rejection, cut to the booking replay for this beat and say so.

> "Planning is a separate session with different tools. It can list files, read, and search text,
> and then call one worker-side tool: submit plan. It cannot write and it cannot execute. That's a
> capability boundary, not a sentence in a prompt.
>
> And here's the part I like most. The planner submitted a plan, and Rivet rejected it, because one
> field was over the schema's length limit. The model read the validation error and submitted a
> corrected plan on the next turn. Nothing was staged. That's what a structured-output contract buys
> you: a malformed agent response is a caught error instead of corrupt state downstream."

### Take 7: implementation and checkpoints, 45 seconds

Screen: the timeline scrolling through turns, tool calls, and `checkpoint.created` rows.

> "Now the implementation session. Read, write, edit, bash, all executing inside the container.
> Watch the right hand side: after every single turn, Rivet captures a binary Git patch of the
> entire workspace, cut against the job's immutable base commit, and writes it to Postgres.
>
> That's what makes this survivable. If I kill this worker right now, the lease expires, a sweeper
> reclaims the job, a replacement worker provisions a brand new container at the original commit,
> applies the last patch, re-derives it, compares the SHA-256, and only then continues from where it
> stopped. If that checksum disagrees, the job fails. It never quietly starts over, because starting
> over looks like success and it is the worst thing a recovery path can do."

### Take 8: crash recovery, 30 seconds

Screen: Pane C, `pnpm demo:recovery`, with the terminal and the job page side by side.

> "That isn't theory. This command starts a real job, kills the worker with SIGKILL mid-run, and
> lets the replacement pick it up. Checkpoint restored, run resumed, same job, same budget. The
> budget matters: model spend and the deadline belong to the job, not to the attempt, so a crash can
> never hand a replacement worker a fresh wallet."

Speed this up 4x in the edit and leave the terminal readable.

### Take 9: the diff, 30 seconds

Screen: the job page diff viewer, scrolling the change.

> "Here's what it actually wrote. A unique constraint at the database boundary, the check and the
> insert moved into one transaction, a 409 for the request that loses the race, and regression tests
> that fire concurrent requests and prove only one booking survives. Six files, a hundred and
> forty-seven lines added. This is rendered from a durable artifact, not from a model's description
> of what it did."

### Take 10: validation, 30 seconds

Screen: the validation cards.

> "Then Rivet validates deterministically, and this is Rivet running the checks, not the model
> reporting on itself. Targeted tests selected from the changed paths, then the full suite,
> typecheck and lint. Each one compares against the baseline and comes out verified, fixed,
> regressed, unresolved or unverified. It parses the test reporter output, so it identifies failures
> by name and can tell a failure it introduced from one that was already there. A newly broken test
> fails the job even if the suite was already red."

### Take 11: the reviewer, 30 seconds

Screen: the review panel.

> "Then a third session reviews the patch. It's independent: it gets the plan, the summary, the diff
> and the validation report, and it can list files, read, search, and submit a review. It cannot
> write. If it requests changes, Rivet runs a directive-only revision session and revalidates, and
> Rivet owns the loop bound, not the model. Here it approved on the first pass.
>
> And I measured whether that reviewer is worth it, which I'll come back to."

### Take 12: the pull request, 25 seconds

Screen: GitHub, the opened PR, then the linked run on the job page.

> "Finalization pushes a branch and opens the pull request from the worker host. Every external
> effect writes a receipt row first, so a retry never opens a second PR. The pull request links back
> to the run, and the run links to the pull request. Seven and a half minutes, twenty-four model
> turns, and about one and a half cents."

### Take 13: the evaluation dashboard, 40 seconds

Screen: `/evaluations/:id`, then `docs/experiments/reviewer-value.md`.

> "Last piece, and it's the one I'd want to be asked about. Rivet measures itself. A benchmark case
> is a git-tracked repository pinned to a lockfile, and an evaluation run is an ordinary job. Same
> creation path, same worker, same lease. Then a second container grades the result against hidden
> tests the job never saw, so the tests can't leak into the diff or the pull request.
>
> I used it to answer one real question: is the independent reviewer worth its cost? Fifteen runs
> per arm. With review, fifteen out of fifteen passed. Without it, fourteen. Six and a half
> percentage points, for about forty percent more spend.
>
> And I'll be straight with you: n equals fifteen cannot separate a small effect from variance. That
> is written in the results document. The value here isn't the number, it's that the question is
> answerable at all."

### Take 14: close, webcam, 25 seconds

Face to camera.

> "So: Postgres holds every durable fact, Redis carries replaceable messages, work runs under leases
> with heartbeats and checkpoints, the sandbox never sees a credential, validation is deterministic,
> review is a separate capability-limited session, and the whole thing is traced end to end through
> OpenTelemetry.
>
> It's open source, the link is below, and the README explains what it doesn't do as clearly as what
> it does. I'd genuinely like to hear what you'd break."

---

## Part 4: the sixty-second cut

Assembled almost entirely from the takes above. Beat structure follows PRD §34. Timings are hard; if
you overrun, cut from implementation, never from the failure beat.

| time      | screen                                    | voiceover                                                                                                                                                        |
| --------- | ----------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 0:00-0:05 | webcam                                    | "I built an AI software engineer. I'm giving it a real bug, in a repository it has never seen."                                                                  |
| 0:05-0:10 | the GitHub issue, then Submit             | "Two people can book the same room at the same time. It's a race condition. Here's the issue, and here it goes."                                                 |
| 0:10-0:18 | timeline: sandbox, clone, baseline (4x)   | "It provisions a Docker container, clones the repo, and records the test baseline before touching anything."                                                     |
| 0:18-0:28 | plan panel, then the rejected submit_plan | "It plans. Then Rivet rejects the plan, because it broke the output schema. Nothing here is staged. The model reads the error and fixes it on the next turn."    |
| 0:28-0:40 | implementation turns, checkpoints, diff   | "It writes the fix inside the sandbox. Every turn is checkpointed to Postgres, so if the worker dies, a new one resumes from the last patch. Here's the diff."   |
| 0:40-0:50 | validation cards, then review approved    | "Rivet validates it. Not the model, Rivet. Tests, typecheck, lint, compared against the baseline. Then a second, independent AI reviews the patch and approves." |
| 0:50-0:57 | GitHub, PR #3 open                        | "Pull request. Seven and a half minutes. About one and a half cents."                                                                                            |
| 0:57-1:00 | webcam                                    | "Open source. Link below."                                                                                                                                       |

**On-screen text overlays**, large, bottom third, one per beat, since most feed viewers watch muted:

```
0:05  Real repo. Real issue. Never seen before.
0:12  Isolated Docker sandbox. No credentials inside.
0:20  Rivet rejects the model's own output
0:30  Every turn checkpointed. Survives a worker crash.
0:42  Deterministic validation, not self-reporting
0:47  Independent AI reviewer
0:52  Pull request opened
```

**Caption the whole thing.** Burned-in subtitles, not platform auto-captions. Most of the audience
watches muted at first and reads before deciding to unmute.

---

## Part 5: editing notes

- **Cut every wait.** Speed ramps of 4x to 20x over provisioning, dependency install and long model
  turns. Keep a visible timestamp or the timeline scrolling so the viewer knows time is passing
  rather than that you cut something out. Never speed up the failure beat or the diff.
- **Never fake ordering.** You can compress time and you can cut dead air. You cannot reorder events
  or splice a failure that did not happen into a run that did. Someone will replay the fixture.
- **Zoom on small text.** The timeline rows, the validation cards and the diff need a punch-in to
  survive compression. Aim for anything you want read to be at least 24 effective pixels tall.
- **Cursor discipline.** Move deliberately, point once, stop. Circling the cursor while talking is
  the single most common amateur tell.
- **Music**: quiet, no drums, or none at all. It competes with your voice for no benefit.
- **First frame matters.** The thumbnail should be the job timeline mid-run or the diff, not your
  face and not a title card.
- **Export**: 1080p H.264, under 200MB for LinkedIn, under 512MB and 140 seconds for X. Which means
  X gets only the sixty-second cut.
- **Landing page copy**: keep the video file small, or embed from YouTube. Do not commit a 200MB mp4
  into git.

---

## Part 6: contingencies

- **The live run fails on camera.** Do not delete the take. If it fails for an interesting reason,
  that is the honest recovery beat and it is worth more than a clean run. If it fails for a boring
  one, switch to Pane B and drive the booking replay instead. Say the words "this is a recorded run
  I'm replaying through the real system" out loud. The replay goes through `createJob`,
  `transitionJob` and `appendEvent`, so it genuinely is the production path, and being straight
  about it costs you nothing while getting caught costs everything.
- **Docker misbehaves.** Restart Docker Desktop, confirm `docker version` shows a Server section,
  and re-pull the pinned image. On Apple silicon, an engine stuck in `starting` usually means
  Rosetta.
- **The model burns budget and fails.** Budgets are per job, not per attempt, so a failed take costs
  what it costs. Have the replay ready and move on rather than re-running the live job three times.
- **You fluff a line.** Stop, pause two seconds, and say it again from the start of the sentence.
  The silence gives you a clean cut point.

---

## Part 7: ready-to-post social copy

These posts match the final ~70-second cancellation demo and reference run
`918021af-6638-4f77-9dd1-61a36ddc2804`: 3m11s, 246 durable events, 15 model turns, review approved,
and PR #3. Upload the video natively on both platforms.

### LinkedIn

> I built Rivet because opening more coding-agent sessions did not make me faster. It made me the
> manager of several unreliable processes.
>
> Rivet turns that process into a system: give it a GitHub issue, and it plans the work, changes the
> repository in an isolated sandbox, validates the patch, sends it through an independent review,
> and opens a pull request.
>
> The model call is not the interesting part. I built the infrastructure around it:
>
> - Postgres leases, heartbeats, and a Redis-backed queue for recoverable long-running jobs
> - A Docker sandbox that never receives the model credential
> - A binary Git checkpoint after every agent turn, so a replacement worker can restore and resume
>   after a crash
> - Deterministic test, typecheck, and lint validation against a recorded baseline, rather than
>   trusting the model's report
> - A separate read-only reviewer, bounded revision loops, and idempotent GitHub publication
> - Durable events, cost and token budgets, OpenTelemetry tracing, and an evaluation harness with
>   hidden tests
>
> The run in this video started from a real GitHub issue and ended with a review-approved patch and
> an open pull request in 3 minutes 11 seconds: 15 model turns and 246 durable events.
>
> I built Rivet end to end with TypeScript, Next.js, PostgreSQL, BullMQ, Docker, and OpenTelemetry.
> It is open source, and the README documents the architecture, tradeoffs, failure modes, and
> limitations.
>
> Source: https://github.com/xuanhieu2611/Rivet
>
> I am looking for software engineering roles in backend, platform, distributed systems, or AI
> infrastructure. If your team is working on hard systems problems, I would love to talk.
>
> Engineers: what would you try to break first?
>
> #SoftwareEngineering #DistributedSystems #AIEngineering

**Video alt text:**

> A screen recording of Rivet taking a real GitHub issue through Docker provisioning, planning,
> implementation checkpoints, deterministic validation, independent review, and an open pull
> request, with brief webcam narration from the builder.

### X / Twitter

Post the video with post 1, then add posts 2-4 as replies. Post 1 stays within X's 280-character
limit.

> 1/ I built Rivet: infrastructure for running coding agents reliably.
>
> Docker sandboxes. Postgres leases + checkpoints. Deterministic validation. Independent review.
>
> Real GitHub issue → pull request in 3m11s.
>
> Open source. Looking for backend/platform/AI infra SWE roles.
>
> 2/ Every agent turn becomes a binary Git patch in Postgres.
>
> If a worker dies, a replacement starts with a fresh container, restores the patch, re-derives it,
> verifies its SHA-256, and resumes. It never silently starts over with a new budget.
>
> 3/ The model credential never enters the Docker sandbox. Validation is also run by Rivet, not
> self-reported by the model: targeted tests, the full suite, typecheck, and lint, all compared with
> the pre-change baseline.
>
> Then a separate read-only agent reviews the patch.
>
> 4/ I built the web app, worker lifecycle, sandbox + recovery, validation/review pipeline, GitHub
> publication, observability, and hidden-test eval harness.
>
> Stack: TypeScript, Next.js, Postgres, BullMQ, Docker, OpenTelemetry.
>
> Source: https://github.com/xuanhieu2611/Rivet

---

## Part 8: shot checklist

Print this. Tick as you film.

- [ ] Take 1 hook (webcam)
- [ ] Take 2 the issue
- [ ] Take 3 creating the job
- [ ] Take 4 provisioning and the boundary
- [ ] Take 5 baseline
- [ ] Take 6 planning and the rejection
- [ ] Take 7 implementation and checkpoints
- [ ] Take 8 crash recovery
- [ ] Take 9 the diff
- [ ] Take 10 validation
- [ ] Take 11 the reviewer
- [ ] Take 12 the pull request
- [ ] Take 13 the evaluation dashboard
- [ ] Take 14 close (webcam)
- [ ] Pickup: sixty-second hook line (webcam, different energy, faster)
- [ ] Pickup: sixty-second closing line (webcam)
- [ ] B-roll: worker logs scrolling in Pane A
- [ ] B-roll: `pnpm test` running green across all workspaces
- [ ] B-roll: the architecture diagram on the landing page
- [ ] Stills: three or four screenshots for the LinkedIn post and the social preview image
