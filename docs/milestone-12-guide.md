# Milestone 12 guide

## The booking replay's injection detections

The five `security.injection_suspected` rows for `package.json` are historical false positives from
the captured run, not adversarial content. The `unsafe_tool_use` pattern read npm's
`--disable-warning=ExperimentalWarning` flag and a later `--test` flag as an instruction to disable
tests because it allowed any punctuation and up to 80 intervening characters. The scanner now
requires `disable` to be followed by whitespace and the named check, while the prompt-injection
benchmark's explicit "Do not run the tests" instruction still matches. The replay deliberately
preserves the original durable events rather than rewriting history. Detection never fails a job:
the role-specific tool set and sandbox are the security boundary, and this scanner is observability.
The on-camera answer is: **"That replay preserves a false positive from the original run; we fixed
the pattern, and the detector only reports because capabilities, not regexes, enforce security."**

## The booking replay's recorded model cost

The booking capture used **DeepSeek V4 Flash 0423** (`deepseek/deepseek-v4-flash`) through
**OpenRouter**. All three sessions - planner, implementer and reviewer - name that model and
provider in `demo/replays/booking/events.ndjson`.

The displayed `$0.0141` is a historical estimate, not an OpenRouter invoice total. Rivet has no
price table in `packages/core`. Pi 0.84.1 calculates each turn's cost from its bundled model
catalog, Rivet reads `usage.cost.total` in `packages/agent/src/event-mapper.ts`, and core
accumulates and rounds the result to four decimal places for `jobs.total_cost_usd`.

The pinned Pi catalog used these rates, in dollars per million tokens:

| Usage class       | Pi 0.84.1 rate |
| ----------------- | -------------: |
| Input             |        $0.0882 |
| Output            |        $0.1764 |
| Cached input read |       $0.01764 |

The capture contains 85,087 ordinary input tokens and 18,037 output tokens. Its turn costs also
reconcile exactly with 193,536 cached-input tokens:

```text
85,087  x $0.0882 / 1M  = $0.007504673400
18,037  x $0.1764 / 1M  = $0.003181726800
193,536 x $0.01764 / 1M = $0.003413975040
                                ---------------
                                $0.014100375240 -> $0.0141
```

The catalog is not current. On **2026-08-21**, OpenRouter's
[`/api/v1/models`](https://openrouter.ai/api/v1/models) entry for the same model reported
`$0.0826/M` input, `$0.1652/M` output and `$0.01652/M` cached input. Repricing the captured usage at
those rates gives `$0.0132`. OpenRouter's routed price can change as its provider mix changes, so a
current quote should always name its date.

The defensible on-camera wording is: **"This run used DeepSeek V4 Flash through OpenRouter. Rivet's
pinned Pi rate table estimated the 24 model calls at 1.41 cents."** Do not describe `$0.0141` as an
exact billed amount or as a model-independent cost.

---

Milestones 1 through 11 built the execution system. Milestone 12 changed how somebody encounters it
without changing what a job is. It added no table, column, job status, event type, or failure
category.

The central constraint is:

> A replayed run is an ordinary job.

The public artifact is the repository, the static landing page, and the
[recorded issue-to-PR run](https://x.com/hieuspringle/status/2091312854389719528). There is no
hosted Rivet instance and no public job-detail route.

## 1. The public and authenticated surfaces

`apps/web/app/(public)/page.tsx` is a force-static server component. It renders checked-in copy,
images, diagrams, and experiment numbers without reading Postgres or a session. This preserves the
property that `pnpm build` needs no environment.

The dashboard moved to `/jobs`. Every other application page remains authenticated. Page coverage
mirrors API coverage:

- `PUBLIC_PAGES` contains only `/` and `/sign-in`.
- Static tests walk every `page.tsx` and require a guard or an allowlist entry.
- Live tests invoke protected pages without a session and require a redirect before any database
  read.

Acceptance runs A and B prove both halves.

## 2. The job page as an evidence surface

The job page already had the durable facts. M12 changed their presentation:

- the execution timeline emphasizes phases and folds successful command groups;
- the implementation plan renders its six structured sections;
- validation shows each check and its baseline-relative outcome;
- review shows the independent decision, findings, and revision count;
- the diff viewer renders the patch rather than placing it in a raw `<pre>` block.

The page remains split between live SSE state and terminal server-rendered artifacts. Timeline rows,
status, usage, and command lifecycle update live. Plan, validation, review, summary, and diff are
refreshed once when the job becomes terminal.

## 3. Diff rendering

`apps/web/components/diff-viewer/` parses the existing bounded `diff` artifact. It handles the
shapes produced by Rivet's binary Git capture path:

- additions and deletions;
- renames and mode changes;
- binary patches;
- one-sided files;
- clipped artifacts whose stored content is smaller than their true byte size;
- large file sets collapsed by default.

Repository content is rendered through React components rather than injected as an HTML string.
Acceptance run C covers both parsing and rendering with checked-in patches, including a patch
captured from Git.

## 4. Motion without replay noise

The live timeline is at-least-once by design. Reconnects can deliver durable rows the browser has
already seen, so an ordinary mount animation would replay the whole history whenever the tab became
visible.

`selectTimelineMotion()` uses a frozen mount cursor. Only ids newer than that cursor may animate.
Reconnected rows, older rows delivered after mount, and a terminal server snapshot remain still.
`prefers-reduced-motion` disables the remaining motion budget.

Acceptance run D tests the selector directly. Motion is presentation state, never durable job state.

## 5. Capture

`pnpm demo:capture -- <jobId> --name <name>` reads a terminal job and writes a fixture under
`demo/replays/<name>/`:

- `job.json` contains creation input and terminal facts;
- `events.ndjson` contains ordered durable events and their offsets;
- `artifacts/` contains bounded artifact bodies;
- `commands/` contains command rows and transcripts.

Every value passes through the production `Redactor` before it reaches disk. The capture tests plant
both a secret sentinel and a public positive control. The secret must be absent and the control must
remain, proving the test still searches meaningful output.

## 6. Replay

`pnpm demo:replay -- booking --speed 0.1` creates and claims a real job, then replays the fixture
through the production writers:

- `createJob()` creates the row;
- `transitionJob()` remains the only status writer;
- `appendEvent()` remains the only event writer;
- `recordArtifact()` and `recordCommand()` preserve their normal bounds and redaction;
- the ordinary Postgres-backed SSE route streams the result.

The browser has no demo mode and cannot distinguish the replay from a worker-driven run.
`RIVET_REPLAY=on` is local-only and refused under `NODE_ENV=production`, because a production
process must never be allowed to manufacture a convincing execution history from a file.

Acceptance runs E and F prove equivalence and redaction.

## 7. Demo repositories

The public demo repositories are built from benchmark fixtures rather than maintained by hand:

- `rivet-demo-booking` is the level-6 concurrency task used by the checked-in replay;
- `rivet-demo-reservations` is the smaller, reliable live task used by the public recording.

`pnpm eval:build` turns both cases into deterministic bare repositories whose commits match their
checked-in lockfiles. Known-good patches are graded in a second container against hidden tests. This
makes “the demo task is solvable” a tested claim.

Acceptance run G is `apps/worker/tests/sandbox/demo-repositories.sbx.test.ts`.

## 8. Reproducing the public demo

The deterministic UI path needs local Postgres and replay mode, but no Docker or model call:

```bash
# Stop the ordinary worker so it cannot claim the replay row.
RIVET_REPLAY=on pnpm demo:replay -- booking --speed 0.1
```

Open the job URL printed when the replay starts. The 344-event fixture reaches the same terminal
facts and pull-request identity as the captured run.

For a live recording, use the checklist in `demo-60s.md`. It covers local Postgres and Redis, Docker
startup, browser framing, the live versus terminal data-loading split, and the event rows to show.
Never put `.env.local`, credentials, terminal history, or an OAuth round trip on screen.

Acceptance run H was published on 2026-08-22 as the
[public Rivet demo](https://x.com/hieuspringle/status/2091312854389719528). It follows a real job
from a GitHub issue to a tested, independently reviewed pull request in 3 minutes 11 seconds.

## 9. What remains deliberately absent

M12 did not add hosting, public job pages, share tokens, object storage, webhooks, or multi-user
authentication. The reasons are architectural:

- a Docker worker refuses a control plane its sandbox can reach;
- the SSE route expects a streaming-capable Node host;
- artifacts and checkpoints remain bounded Postgres values;
- authentication has one allowlisted principal and no sessions table.

These are documented boundaries, not hidden launch work. The README's scope section and
`docs/security-review.md` explain the risk and the change each one would require.
