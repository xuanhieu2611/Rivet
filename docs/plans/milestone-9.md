# Milestone 9: GitHub integration

M9 is the milestone where Rivet stops being a system that changes a working tree and starts being a
system that produces a pull request. Everything before it happens inside a container that is
destroyed when the job ends; everything M9 adds happens **outside** Rivet, on a server Rivet does
not own, and cannot be undone by a database transaction.

That single difference drives the whole plan. Every other phase is `replay`: run it twice and the
worst outcome is wasted time. A branch pushed twice, or a pull request opened twice, is a fact the
world now contains. `PhaseRecovery` has carried the word `reconcile_external` since M6 with nothing
declaring it, and a test asserts that nothing does. M9 is the milestone that removes that test.

The PRD checklist (§2684):

- [ ] GitHub App
- [ ] Repository installation
- [ ] Repository picker
- [ ] Issue picker
- [ ] Short-lived token
- [ ] Create branch
- [ ] Commit changes
- [ ] Push
- [ ] Create PR
- [ ] Link PR to AgentForge run

Plus the standing constraints it has to satisfy: §20 (GitHub App rather than PATs, narrow
permissions, short-lived installation tokens, and **Pi never owns the publication step**), §21
(short-lived credential, no control-plane secret reachable from a sandbox), §27 (no platform secret
in the sandbox, audit log for external actions), and §6.9 (what the PR body must contain).

---

## What already exists, and what M9 actually adds

More of this is built than it looks.

- `jobs.final_branch` and `jobs.pull_request_url` are columns today, written by nothing and read by
  `apps/web/app/jobs/[id]/page.tsx:207`, which already renders "not yet".
- `finalizingPhase()` is a deliberate stub. Its docblock names branch, commit, push and pull request
  as M9's, and it already takes no `PipelineOptions` argument specifically so that adding one is the
  only change to its export shape.
- The sandbox is still alive when `finalizing` runs - the processor's `finally` destroys it after
  the pipeline returns - which is what lets M9 fill this body rather than add an eighth phase.
- `PhaseContext.captureWorkspace()` already produces a lossless binary patch of the workspace
  against the job's immutable `base_commit_sha`, with a SHA-256 over the bytes. That is exactly the
  payload the publication step needs, and it needs no new sandbox capability to get it.
- `PhaseRecovery` already has the vocabulary. `SandboxSpec.env` already carries the comment saying
  M9 is the milestone that has to argue about it.

So M9 adds four things and no new pipeline phase:

1. **A GitHub port and adapter** (`packages/github`), mirroring queue/sandbox/agent exactly.
2. **An installation and repository surface** in the web app: install the App, pick a repository,
   pick an issue.
3. **A real `finalizing` body** that branches, commits, pushes and opens a PR - from the worker
   host, never from the sandbox.
4. **An external-effect receipt table** and the reconciliation protocol M6 deferred to "M9's first
   real GitHub effect".

---

## The eight decisions this plan rests on

### 1. Single owner, no login

There is no users table and no session, and M9 does not add one. Installations are stored globally;
whoever can reach the app can use them. This is a deliberate deferral, not an oversight: §27's
authorization, CSRF and rate-limiting requirements are M11 hardening, and pulling a full auth stack
into M9 would double the milestone while adding nothing to the deliverable, which is a pull request.

What this **does** mean is that the app must not be deployed publicly as-is, and `SECURITY.md`
(§21's "document this threat model") says so in as many words. Write that file in this milestone,
because M9 is the first milestone where Rivet holds a credential that can write to somebody's
repository.

The schema still uses a `github_installations` table keyed by GitHub's installation id rather than
stuffing one installation into config, so M11 adds an `owner_user_id` column rather than a table.

### 2. The container still never sees a credential

This is the invariant AGENTS.md states, and M9 is the milestone with the strongest incentive to
break it. It does not break it.

Consequences, both of which are real work:

- **Private repositories cannot be cloned by the container**, because cloning a private repository
  requires a credential and the credential cannot go in. Instead the worker clones on the **host**
  with a short-lived installation token, checks out the exact base commit, removes the `origin`
  remote, tars the directory including `.git`, and copies the archive into the container. The
  container ends up with a real git repository at the right commit, with no remote and no
  credential - which is all the M5/M6/M7 machinery ever needed from it.
- **`Sandbox` grows one method**: `putArchive(path, tar, signal)`. `putFile` takes a `string` and is
  UTF-8 text, so a tarball cannot go through it without base64, and base64-ing a repository through
  a JavaScript string is a heap problem waiting for a large fixture. dockerode has `putArchive`
  natively; the scripted fake untars to a temp directory. One method, and it keeps the port at "move
  bytes in" rather than growing a filesystem API.

The unauthenticated in-container clone **stays** as the path for a job with no installation binding
(a manually entered public URL, every fixture, `demo:job`, `demo:recovery`). Two paths, chosen by
one field on the job, and the existing one is not touched - which is what keeps the sandbox and
integration suites green without a GitHub fake in them.

### 3. Publication happens on the worker host, from the patch

`finalizing` does not run `git push` in the sandbox. It calls `ctx.captureWorkspace()` to get the
binary patch it would have checkpointed anyway, then on the host: clone shallow with the token into
a temp directory, fetch and check out `base_commit_sha`, create the branch, `git apply --binary` the
patch, `git add -A`, commit as the App's bot identity, push, and open the PR through the API.

Three properties fall out of this that are worth more than the code costs:

- The token exists only in the worker process and in a `GIT_ASKPASS` helper it writes to a temp
  file. Never in argv, so it never reaches `job_commands`; never in a remote URL, so it never
  reaches a `.git/config`; never in `SandboxSpec.env`.
- The pushed tree is exactly the tree that was validated and reviewed, byte for byte, because it is
  the same patch bytes the checkpoint machinery already proves round-trip.
- Pi is nowhere near it, which is §20's "Pi should **not** own the final external publication step".

The host clone is short-lived and independent of the provisioning-time one. Do not try to keep one
host clone alive across the whole job: a reclaimed job may finalize on a different machine than the
one that provisioned it, so a design that depends on host state surviving the attempt is a design
that fails exactly when recovery matters.

This requires `git` on the worker host. That is a runtime dependency of `apps/worker` only -
`pnpm build`, `pnpm test`, `pnpm lint` and `pnpm typecheck` must still run on a bare machine, which
is CI's `verify` job and is not negotiable.

### 4. `finalizing` becomes the first `reconcile_external` phase

Delete the test asserting nothing declares it, and replace it with one asserting that `finalizing`
does and that it is still the only one.

The protocol, in the order the phase runs it:

1. **Read the receipt.** If `job_external_effects` has a row for `(job_id, 'branch_pushed')`, the
   push already happened and its commit sha is known.
2. **Ask GitHub.** Whether or not there is a receipt, resolve `refs/heads/<branch>` through the API.
   A receipt with no ref means the row is stale (branch deleted); a ref with no receipt means a
   previous attempt died between the push and the commit of its receipt, which is the exact window
   the protocol exists for.
3. **Adopt or replace.** If the remote ref's tree matches the tree the patch produces, adopt it and
   write the receipt. Otherwise force-with-lease over it, because the branch is Rivet's own and a
   resumed job has a newer validated tree.
4. **Same again for the PR**: receipt, then
   `GET /repos/{o}/{r}/pulls?head=<owner>:<branch>&state=all`. An existing open PR from this head
   branch is adopted and its body updated; a merged or closed one is adopted and reported, never
   reopened.

Compare **trees**, not commits. A commit sha includes an author and committer timestamp, so
recomputing it is not deterministic and comparing them would say "different" on every resume.

### 5. The branch name is derived, not generated

`rivet/job-<first 8 of job id>-<slug of title>`, truncated to a sane length, lowercased,
non-alphanumerics collapsed to `-`. Deterministic from immutable job fields, which makes step 2 of
the protocol above possible at all: a randomly generated name gives a resumed attempt no way to ask
GitHub what it already did. Persist it to `jobs.final_branch` **before** the push, not after, so a
crash mid-push leaves the name recoverable from Postgres as well as from the derivation.

### 6. Publication failure fails the job, with its own categories

A job whose work was validated and approved but whose PR could not be opened is not `completed`; the
deliverable is the pull request. New failure categories, all terminal, none retried at the phase
level:

- `github_unavailable` - transport, 5xx, or rate limit after the adapter's own bounded retry.
- `github_permission_denied` - 403/404 on a repository the installation should reach, which in
  practice means the App was uninstalled or its permissions were narrowed mid-job.
- `push_rejected` - the remote refused the ref update for a reason force-with-lease should not paper
  over.
- `pull_request_failed` - the branch is pushed but the PR call failed. The branch stays; it is real
  work and deleting it to make the failure tidy would destroy the thing the job produced.

`github_unavailable` is the only one worth a retry, and the retry belongs in the adapter (bounded,
jittered, respecting `Retry-After`), not in the pipeline runner - the runner's retry re-runs the
whole attempt, which for an external effect is precisely what the receipt protocol is designed to
make survivable but not something to invoke casually.

### 7. GitHub is a port, with a fake, selected by `RIVET_GITHUB`

`packages/core/src/github/github.ts` declares the port; `packages/github` supplies the Octokit
adapter (`@octokit/app` for App JWT signing and installation-token caching, `@octokit/rest` for the
calls) and a scripted fake. `RIVET_GITHUB=app|off`, defaulting to `off`, and `parseWorkerConfig`
refuses `off` under `NODE_ENV=production` for the same reason it refuses `RIVET_SANDBOX=off`: a
worker that completes jobs while quietly skipping publication looks perfectly healthy.

`off` records `publication.skipped` and leaves `finalizing` doing exactly what it does today. That
is what keeps every existing integration, sandbox and streaming case running without a GitHub
credential, and it is the mode CI uses.

The port surface is small and stated in terms the domain has opinions about, not in Octokit's terms:

```ts
interface GitHubClient {
  listInstallations(): Promise<Installation[]>;
  listRepositories(installationId: number): Promise<Repository[]>;
  listIssues(installationId: number, repo: RepoRef): Promise<Issue[]>;
  /** Short-lived, minted per use, never cached in Postgres. */
  mintInstallationToken(
    installationId: number,
    repo: RepoRef,
    scope: TokenScope,
  ): Promise<GitHubToken>;
  getRef(installationId: number, repo: RepoRef, ref: string): Promise<RefState | null>;
  findPullRequest(installationId: number, repo: RepoRef, head: string): Promise<PullRequest | null>;
  createPullRequest(input: CreatePullRequestInput): Promise<PullRequest>;
  updatePullRequest(input: UpdatePullRequestInput): Promise<PullRequest>;
}
```

`TokenScope` is `"read"` or `"write"`, and it maps to the `permissions` field of GitHub's
create-installation-access-token call. Provisioning's host clone mints a `contents: read` token;
finalizing mints `contents: write, pull_requests: write`. Two scopes because the seeding step has no
business holding a token that can push, and narrowing it costs one field.

A `GitHubToken` carries its `expiresAt` and a `redact()`-able value, and the worker's logger gets a
redaction pass keyed on the live token strings. §27 asks for "secrets redaction from logs" and this
is the first secret that ever reaches a log line's neighbourhood.

### 8. The PR body is composed from artifacts already in Postgres

§6.9 lists what the PR must contain: issue summary, root cause, implementation summary, files
changed, tests executed, known limitations, and the execution ID. Every one of those already exists
as a durable record by the time `finalizing` runs - the `implementation_plan` artifact has the
structured sections, `implementation_summary` has the session's account, `validation_report` has the
checks and their outcomes, `review_report` has the verdict and findings, and `diff_stat` has the
files changed.

So the body is a pure function of records, rendered by a `packages/core` module with unit tests and
no I/O, and persisted as a new `pull_request_body` artifact **before** the PR call. That ordering is
the point: a `pull_request_failed` job still shows the reader exactly what Rivet was about to
publish.

The body ends with a footer naming the Rivet job id and a link back to the run page, which is the
checklist's "link PR to AgentForge run" in the direction GitHub can see. The other direction is
`jobs.pull_request_url`, which the detail page already renders.

---

## Migration

One migration, generated with `pnpm db:generate` and committed under `packages/database/drizzle/`.

**New table `github_installations`** - installation id (GitHub's, primary key), account login,
account type, target type, permissions snapshot, suspended flag, `created_at`, `updated_at`. No
owner column yet; §1 above says why, and adding one later is additive.

**New table `job_external_effects`** - the receipt table M6 deferred.

- `id`, `job_id` (FK, cascade), `kind` (`branch_pushed` | `pull_request_opened`), `provider`
  (`github`), `external_id` (the ref sha, or the PR node id), `external_url`, `payload` jsonb,
  `created_at`.
- **Unique on `(job_id, kind)`.** The uniqueness constraint is the mechanism, not a hygiene nicety:
  it is what makes "did I already do this" a question Postgres answers rather than one application
  code guesses at under concurrency.
- Append-only, like every other ledger in this system. A receipt is never updated; a superseding
  effect writes a new `kind` or the row is left alone and the API is re-consulted.

**New columns on `jobs`** - `github_installation_id` (nullable int), `repo_owner`, `repo_name`,
`issue_number` (nullable int), `issue_url`, `pull_request_number` (nullable int). `final_branch` and
`pull_request_url` already exist and finally get a writer.

**One new `.update(jobs)` site**, `jobs/publication.ts`, fenced on `lease_owner` and status-free
like the other five, writing `final_branch`, `pull_request_number` and `pull_request_url`.
AGENTS.md's list of writers goes from six to seven and the reason is the same as the others: the
branch name becomes true when the push answers, not when the job later changes status.

---

## Vocabulary additions

**Event types**: `github.repository_bound`, `branch.created`, `commit.created`, `push.completed`,
`pull_request.opened`, `pull_request.adopted`, `publication.skipped`, `external_effect.recorded`.

**Failure categories**: `github_unavailable`, `github_permission_denied`, `push_rejected`,
`pull_request_failed`, `github_not_installed`.

**Artifact type**: `pull_request_body`.

All of them are Zod-validated `text`, so none of them needs a migration - that property is why
`JOB_EVENT_TYPES` and `FAILURE_CATEGORIES` are arrays in `packages/contracts` rather than pgEnums.

---

## Stage 0 - the App, and the acceptance contract

Register the GitHub App by hand and write down what it needs, because half of M9's failure modes are
configuration:

- Permissions: `contents: write`, `pull requests: write`, `issues: read`, `metadata: read`. Nothing
  else. §20's "as narrow as practical" is a list of four.
- No webhook subscriptions in M9. Webhooks are not on the checklist and every event they'd deliver
  is one Rivet can pull on demand.
- Setup URL pointing at `/api/github/setup`, so a fresh install lands back in the app.
- `GITHUB_APP_ID`, `GITHUB_APP_PRIVATE_KEY` (PEM, base64 in env to survive newlines),
  `GITHUB_APP_SLUG`, `GITHUB_APP_CLIENT_ID` in `.env.example`, all optional in the schema so a
  machine without them still builds.

Create the demo target as a **throwaway** repository - `rivet-demo-target`, public, under the same
account - and install the App on that repository only. Not `rivet-fixture-node`: that one is M10's
evaluation corpus and the target of `demo:job` and `demo:recovery`, and a corpus repository
collecting demo branches and stale pull requests stops being the deliberately boring constant those
milestones depend on.

[`docs/plans/milestone-9-acceptance.md`](milestone-9-acceptance.md) is **written**, ahead of any
code, the way M8's was. It specifies eight runs - including the crash between the push and its
receipt, the resume whose tree changed, the already-merged pull request, the uninstalled App, and
the private-repository seeding path with its four no-token-anywhere assertions - and it places four
obligations on the code that Stages 1 through 7 have to satisfy. Read it before starting Stage 1;
its "Obligations this contract places on the code" section is the one part of it that changes what
the earlier stages build.

## Stage 1 - contracts

Event types, failure categories, `pull_request_body` artifact type, and the GitHub value types
(`RepoRef`, `Installation`, `Repository`, `Issue`, `PullRequest`, `ExternalEffect`). Extend
`createJobSchema` with optional `githubInstallationId`, `repoOwner`, `repoName`, `issueNumber`,
`issueUrl`, and a cross-field refinement: owner and name are present together or absent together,
and an installation id requires both. Manual `repoUrl` entry keeps working unchanged.

## Stage 2 - database

Schema edits, `pnpm db:generate`, commit the SQL, `pnpm db:migrate`. Add
`packages/core/src/github/effect-store.ts` as the **only** writer of `job_external_effects`, same
shape as `recordArtifact` and `recordCheckpoint`: an input object, an optional `Executor`, and a
conflict-aware insert that returns the existing row rather than throwing on the unique constraint.

## Stage 3 - the port

`packages/core/src/github/github.ts`: the interface above, plus `errors.ts` classifying provider
responses into the new failure categories the way `sandbox/errors.ts` does. No implementation, no
Octokit import - the same rule that keeps `@rivet/core` runnable with no daemon.

## Stage 4 - the adapter

`packages/github`: the Octokit adapter with a lazily constructed, memoized `App` (importing the
package must not read env or throw, exactly like `@rivet/queue` and `@rivet/database`), the bounded
retry with `Retry-After` handling, the token minter with scope narrowing, and the scripted fake.
Unit tests run against the fake and against recorded response fixtures; no test in `pnpm test` may
touch the network.

## Stage 5 - host git operations

`apps/worker/src/git/` - the only place in the system that runs `git` on the host.

- `seedClone()`: clone with a read token, resolve the commit, strip the remote, tar the directory.
- `publish()`: clone with a write token, apply the patch, commit as the bot, push with
  `--force-with-lease`, return the pushed commit and tree sha.
- Both write a `GIT_ASKPASS` script to a mode-0700 temp file and remove it, and both remove their
  temp directories on every exit path including the failing ones - the same discipline
  `workspace-snapshot.ts` applies to its temporary index.
- The token never appears in an argv, a URL, or a log line. A unit test asserts that by running the
  real functions against a local bare repository with a fake credential and grepping every recorded
  command for it.

## Stage 6 - `putArchive` and the seeded provisioning path

Add `putArchive` to the `Sandbox` port, the dockerode adapter and the fake. Add the seeded branch to
`provisioning-phase.ts`, taken only when the job carries an installation binding; the existing clone
path is untouched. A seeded restore skips `resolveBaseCommit`'s fetch entirely, because the host
already checked out the right commit - which is a simplification, not a special case.

## Stage 7 - `finalizing` gets a body

`finalizingPhase(options)` keeps everything it does today, then: derive the branch, persist it,
capture the workspace, run the reconcile-then-act protocol from §4, compose and persist the PR body,
open or adopt the PR, write the receipts and their events in the same transactions, and record the
PR on the job. Under `RIVET_GITHUB=off`, or for a job with no installation binding, it records
`publication.skipped` and returns.

Change `finalizing`'s `recovery` to `reconcile_external` and update `phases.test.ts`. It still
writes no boundary checkpoint, and `resume-plan.ts` gains a comment saying the receipts are why that
is still correct.

The reconcile decision - receipt × remote ref × tree match, yielding `adopt`, `push` or
`force_push` - is a pure function in its own module with its own table-driven test, not a branch
inside the phase body. The acceptance contract's runs C, D and E are then one integration run each
over a decision that is already proven, rather than three integration runs carrying the whole
burden.

## Stage 8 - the web surface

- `/api/github/setup` - the install callback; upserts the installation and redirects.
- `/api/github/installations`, `/api/github/repositories`, `/api/github/issues` - read-only, backed
  by the port, no business logic in the route (the standing rule for `apps/web`).
- `/settings/github` - install prompt, installed accounts, a link to manage the App.
- The new-job form grows a repository picker and an issue picker, with the manual URL field kept as
  a disclosed fallback. Choosing an issue prefills title and description and records the issue
  number on the job.
- The job detail page renders the PR link as a link once it exists, and the timeline gets
  presentations for the new events - `push.completed` and `pull_request.opened` are the two rows a
  demo viewer will actually look for.

## Stage 9 - configuration and wiring

`RIVET_GITHUB`, the App credentials, `GITHUB_PUSH_TIMEOUT_MS`, `GITHUB_CLONE_TIMEOUT_MS`, and the
production guard. `PipelineOptions` grows `github` and the two timeouts, following the rule that
core reads no environment.

## Stage 10 - verification

The acceptance contract is the specification; this stage is where its eight runs become code.

- Unit: branch derivation, PR body composition, effect-store conflict behaviour, error
  classification, token redaction, and the reconcile decision table.
- Integration, runs A through G, against `FakeGitHubClient` and a **local bare repository** standing
  in for the remote. The bare repository is not optional: the claim that a patch captured in a
  container applies on the host and produces the validated tree cannot be asserted against a faked
  `git`. Every existing integration case still passes untouched, under `RIVET_GITHUB=off`.
- Sandbox suite, run H: `putArchive` round-trips a repository with binary files, the seeded
  container's `git status` is clean at the right commit with no remote, and the sentinel token
  appears in no container env, no `.git/config`, no `job_commands` row, no `job_events` row and no
  log line.
- `pnpm demo:pr` - run B against the throwaway repository from Stage 0, ending in a real pull
  request. Not part of CI, and the milestone's demo: PRD §6.9's "for the public demo, use a
  repository you control".

---

## Definition of done

A job created from a picked repository and a picked issue runs the full M5-M8 pipeline and ends with
a real pull request on GitHub whose body states the issue summary, root cause, implementation
summary, files changed, tests executed, known limitations and the Rivet execution id, linked from
the run page and linking back to it. Killing the worker between the push and the receipt commit and
letting a replacement finish the job produces **one** branch and **one** pull request. No credential
appears in any container, any command transcript, any `.git/config` or any log line.

---

## Risks and deliberate limits

- **`git apply` on a host with different git configuration than the sandbox.** The capture flags
  (`--binary --full-index --no-renames --no-ext-diff --no-textconv`) exist to make the patch format
  independent of the applying git, which is exactly this risk, and M6 already proves the round-trip.
  Apply with `--binary` and no 3-way fallback: a patch that does not apply cleanly to the commit it
  was cut against is a bug worth failing on, not one worth guessing through.
- **Large repositories through `putArchive`.** A repository whose seed tarball is very large is a
  real limit of this design. Bound it explicitly (`GITHUB_SEED_MAX_BYTES`) and fail with a stated
  reason rather than discovering it as a worker heap problem.
- **No webhooks** means Rivet learns an App was uninstalled by failing a call, not before. That is
  acceptable at this size and is exactly what `github_permission_denied` is for.
- **No authorization.** Stated once more because it is the largest deliberate hole in the milestone:
  M9 produces a system that can write to real repositories and has no login. It runs locally, and
  `SECURITY.md` says so.
- **Squash to one commit**, not a commit per turn. The turn-level history exists in
  `job_checkpoints`, and a PR reviewer wants the change, not the model's path to it.
