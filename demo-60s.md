# Rivet: 60-second demo — filming sheet

One video, ~70 seconds, for LinkedIn and X. Everything you need is on this page.

**Script:** 203 words, ~71s at a brisk pace. **Reference run:** job
`918021af-6638-4f77-9dd1-61a36ddc2804` on `rivet-demo-reservations` — completed in 3m11s, 246
events, 15 turns, PR #3, review approved.

---

## Part 1: before you press record

### Machine

- [ ] **macOS in dark mode.** Dark tokens already exist (`globals.css:87`) and follow the OS
      setting. Dark survives LinkedIn compression far better than light.
- [ ] Do Not Disturb on. Quit Slack, Mail, Calendar.
- [ ] Display at 1920x1080, not scaled 4K.
- [ ] Browser at **125% zoom**, bookmarks bar hidden, clean profile, no personal tabs. The wider job
      layout now carries the detail; use editor punch-ins for individual labels instead of making
      the whole browser oversized.
- [ ] Hide desktop icons and the dock.
- [ ] On mains power.

### Stack

```bash
# 1. Docker Desktop — wait for "Engine running"
open -a Docker
docker version                 # must print a Server section

# 2. Redis (a container, so it's a button in Docker Desktop next time)
docker start rivet-redis || docker run -d --name rivet-redis -p 6379:6379 \
  redis:8 redis-server --save "" --appendonly no
redis-cli -p 6379 ping         # PONG

# 3. Postgres
brew services start postgresql@17

# 4. The app
pnpm dev
```

Wait for these two lines in the worker output before doing anything else:

```
sandbox network isolation probe passed
worker started
```

If you see `refusing to start` instead, `.env.local` is pointing at Neon/Upstash again. It must
read:

```
DATABASE_URL="postgresql://postgres:postgres@localhost:5432/rivet_film"
DATABASE_URL_UNPOOLED="postgresql://postgres:postgres@localhost:5432/rivet_film"
REDIS_URL="redis://localhost:6379"
```

Your cloud values are backed up in `.env.local.cloud-backup`. Restore them when filming is done.

### Repo hygiene

- [ ] Close any open PR on `rivet-demo-reservations` and delete its branch, so your filmed run opens
      a clean one.
- [ ] Issue **#5** open and clean (no cross-references): "Scope reservation cancellation to the customer".
- [ ] Signed in at `localhost:3000` already. **Do not film the OAuth round trip.**

---

## Part 2: the one thing that changes how you film

The redesigned job page is a dashboard, not one long document. Keep the browser frame stable and use
its section strip to move between **Live run**, **Plan**, **Validation**, **Review** and
**Changes**. The timeline scrolls inside its own viewport, the important sidebar cards stay visible,
and successful sandbox commands fold into quiet phase summaries.

The job page still splits into two data-loading halves:

| Updates **live** over SSE | Renders only **on page load** |
| ------------------------- | ----------------------------- |
| Execution timeline        | Implementation plan panel     |
| Status badge              | Validation panel              |
| Agent usage counters      | Review panel                  |
| Sandbox commands log      | Diff / summary                |

The plan, validation, review and diff are fetched **server-side** in
`apps/web/app/(app)/jobs/[id]/page.tsx`. During a live run they stay empty; the live provider fires
one `router.refresh()` only when the job reaches a terminal status.

**So beats 4, 6 and 7 cannot be filmed live.** Film the run for beats 3 and 5, let it finish, then
film the panels as separate pickups.

---

## Part 3: the script, beat by beat

### Beat 1 — Webcam — 0:00-0:11

> "I barely write code by hand anymore. I explain the problem and review what comes back. But now
> I've got five sessions open, and I've become a manager of agents."

No screen. **Pause after "manager of agents."** That is your turn from problem into product.

---

### Beat 2 — The issue, then submit — 0:11-0:19

> "So I built Rivet. All I do is create a GitHub issue, which is what I already use as my ticket
> system."

**Show:**

1. `github.com/xuanhieu2611/rivet-demo-reservations/issues/5` — 2 seconds on title and body
2. `localhost:3000/jobs/new`

**Point at:** the installation → repository → issue pickers, in that order. Then click **Submit**.

---

### Beat 3 — Provisioning and baseline — 0:19-0:27 — **FILM LIVE**

> "A worker claims it, spins up a Docker container, clones the repo, installs the dependencies, and
> records the test baseline before touching anything."

**Show:** `localhost:3000/jobs/<id>` → **Live run** in the section strip. Frame the timeline with
the sticky **Execution** sidebar card still visible. Scroll only inside the timeline viewport - do
not move the page.

Leave successful sandbox-command groups collapsed. They now read as a single quiet line such as
`analyzing · 4 sandbox commands`, so the baseline and phase events remain the visual hierarchy.

**Point at, in order:**

| Row                        | Dot colour |
| -------------------------- | ---------- |
| `sandbox.created`          | teal       |
| `repo.cloned`              | sky        |
| `deps.installed`           | sky        |
| `baseline.check_recorded`  | pale sky   |
| ×3 — test, typecheck, lint | all passed |

Punch in on the three baseline rows. **This phase is only ~3 seconds of real time, so you are
holding the frame, not speeding it up.**

Optional b-roll here: Docker Desktop → Containers, showing the sandbox appear.

---

### Beat 4 — The planner — 0:27-0:38 — **PICKUP (needs reload)**

> "Then a planning agent takes over, in its own session with its own tools. It can read and search,
> but it can't write or execute. It writes out a detailed plan."

**Show:** click **Plan** in the section strip, then hold on the **Implementation plan** panel.

**Point at:** the six uppercase section headers. If they do not fit in one frame, make one slow,
short panel scroll. Do not record the travel from the timeline to the panel - the section link is
the transition.

Optional cut-in: the timeline's `plan.recorded` row (teal).

---

### Beat 5 — Implementation and checkpoints — 0:38-0:53 — **FILM LIVE**

> "Then the coding agent implements it, writing into the sandbox over the Docker API, so cloned code
> never touches my credentials. And every turn is checkpointed to Postgres, so if the worker dies, a
> new one just resumes from where it left off."

**Show:** the **Live run** timeline, scrolling through `agent.turn_started`, paired tool activity
and `checkpoint.created` rows. Keep successful sandbox-command groups collapsed; their compact
summaries prove work is happening without turning the shot into terminal output.

**Point at:** the `checkpoint.created` rows (teal). You have **14** of them - the repetition is the
whole point, so let them scroll rather than stopping on one.

**Secondary, if you have room:** the agent usage counters in the sticky **Execution** card ticking
up (turns, tokens, cost). Do not open a command group or **Sandbox commands**. Command transcripts
are an audit/debug surface, not part of this story. A failed or non-zero command will remain
expanded as its own timeline item automatically, so you will not accidentally conceal a problem.

**Ramp: ~6x.** 77 seconds of real time into 13 seconds of screen time.

---

### Beat 6 — Validation and review — 0:53-1:03 — **PICKUP**

> "Then Rivet validates it. Rivet, not the model reporting on itself. Tests, typecheck, lint,
> against the baseline. And an independent reviewer reads the diff. It can't write."

Say **"Rivet"** with a beat before it. That word is the whole point of the sentence.

**Show:** click **Validation** in the section strip and hold the frame. The compact panel keeps the
overall verdict and all four checks visible at once, so do not scroll while delivering the
validation sentence:

| Check           | Outcome      |
| --------------- | ------------ |
| `targeted_test` | unverified   |
| `test`          | **verified** |
| `typecheck`     | **verified** |
| `lint`          | **verified** |

Cut, then click **Review** in the section strip - decision **approve**, 0 revision loops. Treat
Validation and Review as two composed static shots rather than recording a long page scroll between
them.

---

### Beat 7 — The pull request — 1:03-1:09 — **PICKUP**

> "Then a pull request, with a full report for me to review and merge. Three minutes."

**Show:**

1. Sticky sidebar **Target** card with the PR link - it should already be visible without searching
   the page
2. Click through to `github.com/xuanhieu2611/rivet-demo-reservations/pull/<n>`
3. The PR body — ~5.7KB of structured report, scroll it
4. The "Files changed" tab — 3 files, +99 / −1

⚠️ **"Three minutes" is true for this run.** If you film a different repo or a longer task, change
the number.

---

### Beat 8 — Webcam — 1:09-1:13

> "It's open source, link below. Tell me how you'd break it."

---

## Part 4: speed ramps

Real durations from the reference run. This is what you are compressing.

| Phase                   | Real    | Screen | Ramp                                   |
| ----------------------- | ------- | ------ | -------------------------------------- |
| provisioning + baseline | **3s**  | 8s     | **1x — hold**, it's faster than the VO |
| planning                | **52s** | 11s    | ~5x                                    |
| implementing            | **77s** | 13s    | ~6x, keep checkpoint rows scrolling    |
| validating              | **1s**  | 4s     | **1x — hold** on the cards             |
| reviewing               | **52s** | 6s     | ~9x                                    |
| finalizing              | **5s**  | 6s     | 1x                                     |

During the live implementation ramp, keep only the timeline's inner viewport moving while the page
chrome and sticky sidebar stay fixed. The planning, validation and review pickups should be still or
use one short deliberate scroll - they are evidence shots, not time-lapse shots.

---

## Part 5: on-screen text

Large, bottom third, one per beat. Most feed viewers watch muted.

```
0:12   File a GitHub issue. That's the interface.
0:20   Isolated Docker sandbox
0:29   Separate planning agent. Read-only.
0:42   Every turn checkpointed. Survives a crash.
0:55   Rivet runs the tests, not the model
1:01   Independent AI reviewer
1:05   Pull request opened
```

**Burn in subtitles for the whole video.** Do not rely on platform auto-captions.

---

## Part 6: filming order

1. **Start the job and screen-record the whole run**, uninterrupted. That gives you beats 3 and 5
   with honest live timestamps.
2. **Let it finish.** Reload the page.
3. **Film the pickups** using the section strip - plan with at most one short scroll, validation as
   a still frame, review as a still frame, then the PR.
4. **Film the two webcam beats** last, once you know your timings.
5. **Record the voiceover over the assembled cut**, not live. Narrating while watching a real run
   makes you rush.

---

## Part 7: editing notes

- **Cursor discipline.** Move deliberately, point once, stop. Circling the cursor while talking is
  the most common amateur tell.
- **Zoom on small text in the edit, not in the browser.** Keep the browser at 125% for a composed
  dashboard frame, then punch in on timeline rows, validation badges and plan sections. Anything you
  want read should be at least 24 effective pixels tall.
- **Do not demonstrate every affordance.** Command-group chevrons and the Sandbox commands panel are
  intentionally available but remain closed in the 60-second cut. Their restraint is part of the
  visual story.
- **First frame is your thumbnail.** Make it the timeline mid-run or the validation panel — not your
  face, not a title card.
- **Music:** quiet or none. It competes with your voice for no benefit.
- **Never reorder events.** You can compress time and cut dead air. You cannot splice a moment that
  did not happen into a run that did.
- **Export:** 1080p H.264. Under 200MB for LinkedIn, under 512MB and 140s for X.

---

## Part 8: if it goes wrong

- **The live run fails on camera.** Don't delete the take. If it failed for an interesting reason,
  that's worth more than a clean run. If it's boring, fix it and re-run — a run costs about 3
  minutes and 8 cents.
- **Docker misbehaves.** Restart Docker Desktop, confirm `docker version` shows a Server section. On
  Apple silicon, an engine stuck in `starting` usually means Rosetta.
- **Worker won't boot.** Check `.env.local` is pointing at `rivet_film` and local Redis, not Neon
  and Upstash.
- **You fluff a line.** Stop, pause two seconds, say it again from the start of the sentence. The
  silence gives you a clean cut point.

---

## Part 9: shot checklist

- [ ] Beat 1 — webcam hook
- [ ] Beat 2 — issue + submit
- [ ] Beat 3 — provisioning + baseline (live)
- [ ] Beat 4 — plan panel (pickup)
- [ ] Beat 5 — implementation + checkpoints (live)
- [ ] Beat 6 — validation + review (pickup)
- [ ] Beat 7 — pull request (pickup)
- [ ] Beat 8 — webcam close
- [ ] B-roll: Docker Desktop containers appearing/vanishing
- [ ] Stills: 3-4 screenshots for the LinkedIn post

---

## Part 10: afterwards

```bash
cp .env.local.cloud-backup .env.local     # back to Neon + Upstash
docker stop rivet-redis
```

Close the demo PR and delete its branch if you plan to film again.
