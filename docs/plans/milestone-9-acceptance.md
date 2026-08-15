# Milestone 9: the acceptance contract

**Status: not started.** This document is written before any M9 code, so the code is measured
against it rather than the other way around. [`docs/plans/milestone-9.md`](milestone-9.md) is the
plan; this document is the set of assertions the Stage 10 tests make.

M9 is the first milestone whose phase produces an effect Rivet cannot roll back, so this contract
spends most of its length on the runs where something goes wrong at exactly the worst moment. Eight
runs are specified:

| run                                       | ends                                 | why it is here                                |
| ----------------------------------------- | ------------------------------------ | --------------------------------------------- |
| A. no installation binding                | `completed`, `publication.skipped`   | M9 must not change the existing path          |
| B. bound repository, clean publish        | `completed`, PR opened               | the default M9 path, and the demo             |
| C. crash between the push and its receipt | `completed`, one branch, one PR      | the entire reason the receipt protocol exists |
| D. resume whose tree changed              | `completed`, branch force-updated    | adopt is not the same as accept               |
| E. a pull request already open            | `completed`, `pull_request.adopted`  | opening a second PR is the visible failure    |
| F. the App is uninstalled mid-job         | `failed`, `github_permission_denied` | losing the credential is a named failure      |
| G. the PR call fails after a good push    | `failed`, `pull_request_failed`      | the branch is real work and is kept           |
| H. private repository, seeded clone       | `completed`                          | the container stays credential-free           |

Everything below is derived from what the pipeline emits today -
`packages/contracts/src/job-event.ts`, the phase bodies under `packages/core/src/pipeline/`,
`apps/worker/src/processor.ts`, `ALLOWED_TRANSITIONS` in `packages/core/src/jobs/transitions.ts` and
`BOUNDARY_CHECKPOINT_PHASES` in `resume-plan.ts` - plus exactly the events the plan names. No event
is invented here that the plan does not list.

## How to read a sequence

The same two-part convention M8's contract established, and it carries over unchanged.

**Statuses** are read from the `jobs` row, and their order is read off the timeline: the `to` field
of `job.claimed` followed by the `to` of every transition. Every status is a real value in
`JOB_STATUSES` and every adjacent pair is already a legal edge in `ALLOWED_TRANSITIONS` - **M9 adds
no transition edge.** `provisioning -> finalizing` is already legal, which is what lets a crash
during publication resume straight back into it.

**Events** are the `type` column in `id` order, asserted as a projection: the ordered subsequence
drawn from a fixed set, everything else ignored. M9's projection set is M8's set plus M9's events:

```text
job.claimed, phase.started, phase.completed,
validation.recorded, review.recorded,
checkpoint.created, checkpoint.restored, run.resumed,
github.repository_bound, branch.created, commit.created, push.completed,
pull_request.opened, pull_request.adopted, publication.skipped,
external_effect.recorded,
run.summarized, job.completed, job.failed, job.reclaimed
```

Every run below abbreviates the `provisioning` through `reviewing` prefix as `<prefix>`, because M9
changes nothing about it except in run H. The prefix is exactly run A of the M8 contract, and any
test here that re-asserts it is asserting M8.

## The wiring the acceptance tests use

Postgres, Redis, BullMQ, the real processor and the real phase context. `FakeSandboxProvider` and
`FakeCodingAgent` as in M8, plus **`FakeGitHubClient`** - the scripted implementation of the port
from Stage 4, which is what makes runs C through G expressible at all. It must be able to:

- return a ref that does or does not exist, with a stated tree sha
- return an existing pull request, open, closed or merged
- fail one named call with a 403, a 404, a 5xx or a rate-limit response
- record every call it received, in order, so a test can assert that a push happened **once**

The host git operations from Stage 5 are real, run against a **local bare repository** on disk
serving as the remote. That is the one place this contract insists on real `git`: the entire claim
of decision 3 in the plan is that a patch captured in a container applies cleanly on a host and
produces the tree that was validated, and a faked `git` would assert that claim against itself.

No network, no GitHub credential, no Docker in the integration suite. Run B additionally exists as
`pnpm demo:pr`, which is not part of CI - see the last section.

## What `finalizing` contributes to a projection

M8's contract lists the phase as three rows. M9 replaces the tail of it. The order below is
normative and is the order the phase body writes in:

```text
finalizing     phase.started
               -> artifact.recorded (implementation_summary)
               -> run.summarized
               -- M9 begins here --
               -> branch.created                      (name persisted BEFORE the push)
               -> commit.created
               -> push.completed | (adopted: no push.completed, see run C)
               -> external_effect.recorded            { kind: "branch_pushed" }
               -> artifact.recorded (pull_request_body)
               -> pull_request.opened | pull_request.adopted
               -> external_effect.recorded            { kind: "pull_request_opened" }
               -> phase.completed
               still no boundary checkpoint
```

Three orderings in that list are load-bearing and each has its own assertion.

**`run.summarized` stays before the publication**, not after. It is the run's account of what the
work came to, and a reader of a `pull_request_failed` job needs it to have been written. Moving it
to the end to include the PR link would mean the jobs that most need a summary never get one.

**`branch.created` precedes `push.completed`**, and `jobs.final_branch` is written at
`branch.created` time. A crash in the window between them must leave the branch name recoverable
from Postgres, because that name is the only handle the replacement has for asking GitHub what
already happened. A test kills the run in exactly that window and asserts the column is set.

**The `pull_request_body` artifact precedes the PR call.** Run G is the assertion: a job that fails
to open its PR still shows the reader the body it was about to publish.

**`finalizing` still writes no boundary checkpoint**, and that is now a decision rather than an
inherited default. `resume-plan.test.ts:216` asserts the absence today because "the lease-fenced
transition to `completed` is already its durable acknowledgement". Under M9 the phase has effects
that outlive the transaction, and the thing that makes them safe to replay is the receipt table plus
the API, not a workspace snapshot. A checkpoint here would snapshot a tree nobody would ever
restore. Keep the existing test; add a comment in `resume-plan.ts` naming the receipts as the reason
it is still correct.

## The new events and the fields they carry

Field names are normative; Stage 1 adds them to `JobEventData`.

### `github.repository_bound`

Written by `provisioning`, once, when the job carries an installation binding. It is the audit-log
entry §27 asks for: the moment Rivet decided which external repository this run may touch.

```ts
{
  installationId: number,
  owner: string,
  repo: string,
  private: boolean,
  issueNumber?: number,
}
```

### `branch.created`

```ts
{
  branch: string,          // the derived name, see below
  baseBranch: string,
  baseCommitSha: string,
}
```

### `commit.created`

```ts
{
  branch: string,
  commitSha: string,
  treeSha: string,         // what reconciliation compares, never the commit sha
  filesChanged: number,
  insertions: number,
  deletions: number,
}
```

### `push.completed`

```ts
{
  branch: string,
  commitSha: string,
  treeSha: string,
  forced: boolean,         // true when force-with-lease replaced an adopted ref
}
```

Absent entirely when the remote ref already matched - see run C. "Pushed" and "was already there"
are different facts and the timeline keeps them different.

### `pull_request.opened` and `pull_request.adopted`

```ts
{
  number: number,
  url: string,
  branch: string,
  state: "open" | "closed" | "merged",
  bodyArtifactId: number,  // always resolvable, written moments earlier
  updated?: boolean,       // adopted only: whether the body was rewritten
}
```

### `publication.skipped`

```ts
{
  reason: "no_installation" | "github_off",
}
```

Two reasons and they are not interchangeable. `no_installation` is a statement about the **job** - a
manually entered URL with nothing bound to it. `github_off` is a statement about the **worker** -
`RIVET_GITHUB=off`, which production refuses. Exactly the distinction M8 drew between
`review.skipped` and the absence of any review event.

### `external_effect.recorded`

```ts
{
  kind: "branch_pushed" | "pull_request_opened",
  provider: "github",
  externalId: string,
  externalUrl: string,
  adopted: boolean,        // true when the effect was found rather than performed
}
```

Written in the **same transaction** as the receipt row. A test asserts that by killing the process
between the effect and the commit and finding neither the row nor the event, which is the only state
the reconciliation protocol is allowed to be surprised by.

## The branch name is normative

```text
rivet/job-<first 8 chars of job id>-<slug of title>
```

The slug is the title lowercased, non-alphanumerics collapsed to a single `-`, trimmed of leading
and trailing `-`, truncated to 40 characters at a `-` boundary where possible. The whole name is
capped at 100 characters. An empty slug yields `rivet/job-<id8>`.

Unit-tested as a pure function against a table that includes a title of only punctuation, a title in
a non-Latin script, a 300-character title, and two different jobs with identical titles - the last
of which must produce two different branch names, which is the entire reason the job id prefix comes
first rather than last.

## A. No installation binding

A job created the way every existing test creates one: a plain `repoUrl`, no owner, no repo, no
installation. This run exists to prove M9 changed nothing underneath M5 through M8, and it is the
run that keeps the existing integration suite honest.

**Statuses**

```text
queued -> provisioning -> analyzing -> planning -> implementing -> testing -> reviewing
       -> finalizing -> completed
```

**Projected events**

```text
<prefix>
phase.started              { phase: "Finalize" }
run.summarized
publication.skipped        { reason: "no_installation" }
phase.completed
job.completed
```

**Assertions**

```text
final_branch          null
pull_request_url      null
pull_request_number   null
job_external_effects  no rows for this job
FakeGitHubClient      received zero calls
```

The last line is the one worth writing: a job with nothing bound must not so much as ask GitHub a
question. The same sequence with `RIVET_GITHUB=off` and a _bound_ job yields
`{ reason: "github_off" }` and the same five assertions, which is the second half of this run.

## B. Bound repository, clean publish

The default M9 path. A job carrying `githubInstallationId`, `repoOwner`, `repoName` and an
`issueNumber`, against the local bare remote.

**Statuses** — identical to run A.

**Projected events**

```text
job.claimed
phase.started              { phase: "Provision sandbox" }
github.repository_bound    { installationId, owner, repo, private: false, issueNumber }
phase.completed
<the analyzing..reviewing prefix>
phase.started              { phase: "Finalize" }
run.summarized             { reviewDecision: "approve", reviewLoops: 0 }
branch.created             { branch: "rivet/job-<id8>-<slug>", baseCommitSha: <the job's> }
commit.created             { treeSha: <T> }
push.completed             { treeSha: <T>, forced: false }
external_effect.recorded   { kind: "branch_pushed", adopted: false }
pull_request.opened        { number: 1, state: "open" }
external_effect.recorded   { kind: "pull_request_opened", adopted: false }
phase.completed
job.completed
```

**Assertions**

```text
final_branch          equals branch.created's name
pull_request_url      equals pull_request.opened's url
pull_request_number   equals its number
job_external_effects  exactly 2 rows, one per kind
the bare remote       has exactly one ref under refs/heads/rivet/, at commit.created's sha
that commit's tree    identical to the tree produced by applying the captured patch to base
that commit's parent  exactly one, equal to base_commit_sha
that commit's author  the App's bot identity, not the machine's git config
```

**The PR body**, asserted by structure rather than wording, because §6.9 lists seven things it must
contain and every one of them is a record in Postgres:

```text
contains the issue summary            from the implementation_plan artifact
contains the root cause               from the implementation_plan artifact
contains the implementation summary   from the implementation_summary artifact
lists the files changed               from diff_stat, counts matching commit.created
states the checks that ran            from validation_report, one line per check with its outcome
states known limitations              from the plan, and from any non-blocking review findings
names the Rivet job id                exact string match on the uuid
links back to the run page            exact string match on the job detail URL
```

The body is produced by a pure function with its own unit tests over a table of records; this run
asserts only that the artifact persisted and the PR body posted are the **same string**.

## C. A crash between the push and its receipt

The run this milestone exists to survive. Run B's script, with the worker killed by `SIGKILL` after
the push returns and before the receipt transaction commits. The kill is delivered by the same
mechanism `tests/integration/crash-worker.ts` already uses, because a thrown error is a graceful
failure and `process.exit()` still unwinds; neither is the thing being tested.

**Statuses**

```text
queued -> provisioning -> ... -> reviewing -> finalizing
       -> queued -> provisioning -> finalizing -> completed
```

The reclaim edge and the `provisioning -> finalizing` resume edge are both already legal. The
replacement resumes from the `reviewing` boundary checkpoint, whose `resumePhase` is `finalizing`.

**Projected events on the second attempt**

```text
job.reclaimed              { leaseOwner: <the dead worker> }
job.claimed                { to: "provisioning", attempt: 2 }
phase.started              { phase: "Provision sandbox" }
github.repository_bound
checkpoint.restored        { resumePhase: "finalizing", patchSha256: <verified> }
run.resumed                { resumePhase: "finalizing", attempt: 2 }
phase.completed
phase.started              { phase: "Finalize" }
run.summarized
branch.created
commit.created             { treeSha: <T> }        // same T as the first attempt
external_effect.recorded   { kind: "branch_pushed", adopted: true }
pull_request.opened
external_effect.recorded   { kind: "pull_request_opened", adopted: false }
phase.completed
job.completed
```

**No `push.completed` on the second attempt.** The remote ref exists, its tree matches the tree the
restored patch produces, so the effect is adopted rather than repeated.

**The assertions that make this run worth having**

```text
the bare remote       exactly one ref under refs/heads/rivet/, unchanged sha from attempt 1
FakeGitHubClient      exactly one createPullRequest call across both attempts
job_external_effects  exactly 2 rows; the branch_pushed row was written by attempt 2
attempt_count         2
base_commit_sha       identical to attempt 1's
```

The tree matching across attempts is not a coincidence to be waved at: it holds because the restored
checkpoint reproduces the workspace byte for byte and the capture is taken against the same
immutable `base_commit_sha`. If that ever stops being true, this assertion fails first, which is
where it should fail.

A second variant kills the worker in the _other_ window - after the branch-name write and before the
push - and asserts that `final_branch` is already set on the reclaimed row, and that the second
attempt pushes normally with `forced: false`.

## D. A resume whose tree changed

Adoption must not become acceptance. Same crash as run C, except the replacement's workspace differs
from what was pushed - scripted by having the first attempt push a tree that the restored patch does
not reproduce, which is how a job that was revised after a partial publication would look.

**Projected difference from run C**

```text
push.completed             { forced: true }
external_effect.recorded   { kind: "branch_pushed", adopted: false }
```

**Assertions**

```text
the bare remote   one ref, now at the SECOND attempt's commit
that commit       has exactly one parent, still base_commit_sha, not the abandoned commit
force            performed with --force-with-lease against the observed ref, never plain --force
```

The parent assertion is the point: the replacement rewrites the branch to be the validated tree on
top of the base, rather than stacking a second commit on top of an abandoned one. A branch whose
history contains a tree no reviewer approved is worse than a failed job.

## E. A pull request already open

The receipt table is missing its `pull_request_opened` row - deleted, or never committed - and the
API reports an open PR from this head branch. Run C's second attempt with the fake configured to
return it.

**Projected difference from run C**

```text
pull_request.adopted       { number: <the existing one>, state: "open", updated: true }
external_effect.recorded   { kind: "pull_request_opened", adopted: true }
```

**Assertions**

```text
FakeGitHubClient      zero createPullRequest calls, exactly one updatePullRequest call
pull_request_url      the existing PR's url
job_external_effects  2 rows
```

Two variants, and their difference is the whole of decision 4:

- **The existing PR is `closed`**: adopted, `updated: false`, and the job still completes. Rivet
  states what it found; it does not reopen someone else's decision.
- **The existing PR is `merged`**: adopted, `updated: false`, job completes, and `run.summarized`
  already sits above it so the timeline reads correctly. Reopening or force-pushing over a merged
  branch is the one thing this run exists to forbid.

## F. The App is uninstalled mid-job

The fake returns 404 on the ref lookup at the start of `finalizing`, which is what an uninstalled
App or a narrowed permission actually looks like from the client's side.

**Statuses**

```text
queued -> provisioning -> ... -> finalizing -> failed
```

**Projected events**

```text
phase.started              { phase: "Finalize" }
run.summarized
job.failed                 { failureCategory: "github_permission_denied" }
```

**Assertions**

```text
failure_category      "github_permission_denied"
failure_reason        names the repository and the installation, and contains no token
final_branch          null       // nothing was created, so nothing is claimed
job_external_effects  no rows
the bare remote       unchanged
```

A variant fails the _provisioning_ seed clone the same way for a private repository, ending `failed`
/ `github_permission_denied` before any container work - which is also the cheapest place to
discover it.

A second variant returns 5xx three times and then succeeds, and asserts the job **completes**: the
bounded retry lives in the adapter, and a transient GitHub is not a failed job. A third returns 5xx
past the bound and asserts `github_unavailable`.

## G. The PR call fails after a good push

The push succeeds and its receipt commits; `createPullRequest` then fails permanently.

**Projected events**

```text
branch.created
commit.created
push.completed             { forced: false }
external_effect.recorded   { kind: "branch_pushed", adopted: false }
job.failed                 { failureCategory: "pull_request_failed" }
```

Note what is present between the two: `artifact.recorded (pull_request_body)`, outside the
projection but asserted directly.

**Assertions**

```text
failure_category      "pull_request_failed"
final_branch          set, and the ref EXISTS on the remote
job_external_effects  exactly 1 row, kind branch_pushed
pull_request_url      null
the pull_request_body artifact  present and complete
```

The branch is deliberately not cleaned up. It is validated, reviewed work, and deleting it to make
the failure state tidy would destroy the only thing the job produced. Re-running the job adopts the
branch through run C's path and opens the PR.

## H. A private repository, seeded clone

The path decision 2 of the plan buys. The job is bound to a repository the fake reports as
`private: true`; the worker clones on the host, strips the remote, tars, and calls `putArchive`.

**Projected events** — run B's, with `github.repository_bound { private: true }`.

**Assertions**, and they are the security assertions of this milestone:

```text
the container's SandboxSpec.env          contains no GitHub token, no OPENROUTER_API_KEY, no
                                         credential of any kind
the container's repo/.git/config         has no remote, and contains no token substring
every job_commands row for this job      contains no token substring, in argv, stdout or stderr
every job_events row for this job         contains no token substring anywhere in its jsonb
the worker's captured log output         contains no token substring
git status in the container              clean, at base_commit_sha
git log -1 in the container              the real base commit, with its real message
a binary file in the fixture             byte-identical inside the container
```

The token used by the test is a distinctive sentinel string, so "contains no token substring" is a
single grep across four sources rather than an argument. This is the run that proves the invariant
AGENTS.md states, and it is the run to re-run first whenever provisioning changes.

A variant seeds a repository whose archive exceeds `GITHUB_SEED_MAX_BYTES` and asserts a stated
failure before the container is created, rather than a worker heap problem.

## What this contract deliberately does not pin down

- **GitHub's actual API responses.** The adapter's fidelity to the real API is proven by
  `pnpm demo:pr` against a real repository, not by CI. Recorded fixtures in the adapter's unit tests
  cover shape; they cannot cover truth.
- **PR body wording.** Assert structure and the presence of the seven §6.9 elements. Every `message`
  string remains prose for a human.
- **Rate-limit timing.** The retry is bounded and honours `Retry-After`; a test that asserts the
  sleep duration is asserting a clock.
- **Whether the App can be installed by a UI flow in CI.** Stage 8's routes are covered by unit
  tests over the port; the install itself is a human action, done once.
- **Merge behaviour.** Rivet opens pull requests. It does not merge them, and nothing in M9 should
  make merging look like a feature that was almost there.

## Obligations this contract places on the code

Writing the sequences down first surfaces four things the plan implies but does not state, and each
one is cheaper to decide now than to discover in Stage 7.

1. **`finalizing` needs the job's GitHub binding on `JobDetail`.** The phase reads it from
   `ctx.job`, which means Stage 1's contract additions and Stage 2's columns must both land before
   Stage 7, and `job-service.ts` must map them - the same six-line change every job column has
   needed.
2. **The reconcile decision is a pure function and must be written as one.** Its inputs are the
   receipt (or its absence), the remote ref state (or its absence), and the tree sha the local
   commit produces; its outputs are `adopt`, `push`, `force_push`. Runs C, D and E are then three
   rows of a unit-test table plus one integration run each, instead of three integration runs
   carrying the whole burden.
3. **The processor must not retry a `finalizing` failure the way it retries a phase failure.** All
   four new categories are terminal. A runner-level retry would re-enter `finalizing` through the
   receipt protocol, which is safe by construction but would turn a permission error into three
   identical permission errors on the timeline.
4. **`run.summarized` should gain the branch and PR when they exist.** It cannot, in the current
   ordering, because it is written before the publication. Either it stays as it is and the PR link
   lives only on `pull_request.opened` and the job row - which is this contract's choice - or a
   second closing event is added. Do not move `run.summarized` after the publication; run G is why.

## The Stage 0 demo repository

`pnpm demo:pr` runs run B against real GitHub, and it needs a repository that can be freely branched
and PR'd into. **It must not be `rivet-fixture-node`.** That repository is the first entry in M10's
evaluation corpus and the target of `demo:job` and `demo:recovery`; a corpus repository accumulating
demo branches and stale pull requests stops being the deliberately boring constant those milestones
depend on.

Create a throwaway instead - `rivet-demo-target`, public, under the same account - seeded as a copy
of the fixture's shape so the existing demo tasks apply unchanged. Install the App on that
repository **only**, which also makes run F's variant reproducible by hand: uninstall it and watch a
job fail with a category rather than a stack trace.

`demo:pr` follows `job-demo.ts`'s structure exactly - start the real worker as a child, create the
job through `createJob`, enqueue, tail the timeline - with three differences:

- it asserts `RIVET_GITHUB=app` and the App credentials up front, the way `job-demo.ts` already
  asserts `RIVET_SANDBOX`, `RIVET_AGENT` and `OPENROUTER_API_KEY`, and it names what is missing
- it creates the job with the installation binding rather than a bare `repoUrl`
- it prints the pull request URL as its final line, and deletes nothing

Deleting nothing is deliberate. The branch and the PR are the milestone's output, and a demo that
tidies up after itself leaves nothing to look at. Clean the repository by hand between runs, or let
the branches accumulate - it is a throwaway, which is the reason to have one.
