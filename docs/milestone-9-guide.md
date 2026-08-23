# Milestone 9: a guided tour of GitHub publication

This is the educational record for Milestone 9. The plan in
[`docs/plans/milestone-9.md`](plans/milestone-9.md) describes the intended design, the acceptance
contract in [`docs/plans/milestone-9-acceptance.md`](plans/milestone-9-acceptance.md) describes the
observable behavior, and [`docs/github-app-setup.md`](github-app-setup.md) is the one-time GitHub
App setup. This guide explains how the implementation fulfills that design, why the important
decisions were made, how to trace a job through the system, and where to look when something goes
wrong.

**Status: implementation complete.** The offline suite, the seven scripted integration acceptance
runs, the two Docker sandbox runs, the streaming suite, the production build and two real jobs
against `xuanhieu2611/rivet-demo-target` have all passed. The second real job ended in
[PR #4](https://github.com/xuanhieu2611/rivet-demo-target/pull/4), authored by the App's bot on a
derived branch, with a body composed entirely from records already in Postgres.

---

## Part 0. The one idea

Milestone 8 ended a job with an opinion. Milestone 9 ends it with an artifact somebody else can see.

Every milestone up to here was internally observable: a status, an event log, an artifact, a review
verdict. All of it lived inside Rivet's own database, which means all of it was safe to repeat. A
crashed worker could replay a phase and nothing outside the system noticed.

M9 breaks that symmetry. Pushing a branch and opening a pull request are **external effects**: they
happen on somebody else's server, they persist after the worker dies, and repeating them naively
produces duplicates that a human then has to clean up. The milestone is therefore not really about
GitHub. It is about the general problem:

> How does a crash-recoverable job perform an irreversible action exactly once?

The answer M9 implements is the **receipt protocol**, and it has three moving parts:

1. **A deterministic name.** The branch is derived from immutable job fields, so a replacement
   worker can ask GitHub "did I already do this?" without having stored anything.
2. **A durable receipt.** `job_external_effects` is unique on `(job_id, kind)`, so Postgres itself
   answers "have I acknowledged this effect?"
3. **Reconciliation before action.** The phase reads the receipt, asks the provider what actually
   exists, compares **trees** rather than commits, and only then decides to adopt, push, or force
   push.

The workflow is now:

```text
implementation
    |
    v
validation
    |
    v
independent review
    |
    v
finalization
    |
    +--> summarize the run           (M7 behaviour, unchanged)
    |
    +--> reconcile the branch effect
    |        |
    |        +--> adopt       (remote tree already matches)
    |        +--> push        (no remote branch)
    |        +--> force push  (remote branch has a stale tree)
    |
    +--> compose the PR body from durable records
    |
    +--> reconcile the pull request effect
             |
             +--> adopt   (a PR from this head already exists)
             +--> create  (it does not)
```

The second thing M9 is about is a **credential**. This is the first milestone where the worker holds
a token that can write to somebody else's repository, and the existing invariant - the container
never sees a credential - is under the most pressure it has ever been under. It does not break. The
cost of not breaking it is an entire new subsystem: host Git operations.

---

## Part 1. What changed from M8

### Before M9

```text
provisioning -> analyzing -> planning -> implementing -> testing -> reviewing -> finalizing
```

`provisioning` cloned the repository **inside the container** over anonymous HTTPS, which works for
public repositories and cannot work for private ones. `finalizing` wrote a summary artifact and a
`run.summarized` event, and the job ended. The validated, reviewed tree existed only as bytes in a
container that was about to be destroyed and as a `diff` artifact in Postgres.

### After M9

The phase list is identical. Two phases grew bodies:

- **`provisioning`** takes one of two paths. A job with an installation binding is seeded from an
  authenticated clone performed **on the worker host** and copied in as a tar archive. A job without
  one still clones anonymously in the container, exactly as before.
- **`finalizing`** additionally publishes: it captures the workspace, reconciles the branch, pushes
  from the host, composes a PR body, reconciles the pull request, and records two receipts.

`finalizing` also becomes the first and only phase to declare `recovery: "reconcile_external"`.

### New durable vocabulary

| Area               | Added in M9                                                                                                                                                                       |
| ------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Tables             | `github_installations`, `job_external_effects`                                                                                                                                    |
| Job columns        | `github_installation_id`, `repo_owner`, `repo_name`, `issue_number`, `issue_url`, `pull_request_number`                                                                           |
| Reused job columns | `final_branch`, `pull_request_url` (present since M0, written for the first time here)                                                                                            |
| Artifact           | `pull_request_body`                                                                                                                                                               |
| Events             | `github.repository_bound`, `branch.created`, `commit.created`, `push.completed`, `pull_request.opened`, `pull_request.adopted`, `publication.skipped`, `external_effect.recorded` |
| Failure categories | `github_unavailable`, `github_permission_denied`, `push_rejected`, `pull_request_failed`, `github_not_installed`                                                                  |
| Phase recovery     | `reconcile_external`, declared by `finalizing` and nothing else                                                                                                                   |
| Sandbox port       | `putArchive(path, tar, signal)`                                                                                                                                                   |
| Package            | `packages/github` (Octokit adapter plus `FakeGitHubClient`)                                                                                                                       |
| Worker subsystem   | `apps/worker/src/git/host-git.ts`, `apps/worker/src/secrets.ts`, `apps/worker/src/github.ts`                                                                                      |
| Web routes         | `/settings/github`, `/api/github/setup`, `/api/github/installations`, `/api/github/repositories`, `/api/github/issues`                                                            |
| Environment        | `RIVET_GITHUB`, `GITHUB_APP_ID`, `GITHUB_APP_PRIVATE_KEY`, `GITHUB_APP_SLUG`, `GITHUB_CLONE_TIMEOUT_MS`, `GITHUB_PUSH_TIMEOUT_MS`, `GITHUB_SEED_MAX_BYTES`, `RIVET_APP_URL`       |
| Demo               | `pnpm demo:pr`                                                                                                                                                                    |
| Documentation      | `SECURITY.md`, `docs/github-app-setup.md`                                                                                                                                         |

---

## Part 2. The implementation history

M9 was implemented as eleven commits, one per stage. Reading them in order is the fastest way to
understand the dependency graph, because each stage compiles and tests green on its own:

```text
11f3475  docs: complete milestone 9 stage 0 setup
1116265  feat: add milestone 9 GitHub contracts
8b159f5  feat: implement milestone 9 stage 2 database
d807891  feat: implement milestone 9 stage 3 GitHub port
e358d7b  feat: implement milestone 9 stage 4 GitHub adapter
8499930  feat: implement milestone 9 stage 5 host git operations
8d80e2e  feat: implement milestone 9 stage 6 sandbox seeding
5e017dc  feat: implement milestone 9 stage 7 publication
73936b0  feat: implement milestone 9 stage 8 web surface
e476e3b  feat: implement milestone 9 stage 9 configuration and wiring
14c281f  feat: implement milestone 9 stage 10 verification
```

The ordering is not arbitrary. It runs strictly inward-out:

- Stages 1 and 2 add **shapes** (Zod schemas, tables). Nothing calls them yet.
- Stage 3 adds the **port** - an interface in `packages/core` with no implementation.
- Stage 4 adds the **adapter** and the **fake**, in a new package that core never imports.
- Stage 5 adds **host Git**, which lives in `apps/worker` because it shells out and core may not.
- Stages 6 and 7 wire the port into the two **phases** that use it.
- Stage 8 adds the **web surface**, which needs the same port from the other deployable.
- Stage 9 adds the **switch** that assembles everything, and is the first commit where a real GitHub
  call can actually happen.
- Stage 10 is verification only: no product code except three fixes the acceptance runs uncovered.

The lesson worth taking from this shape: **the switch comes last.** For nine of eleven commits the
system could not reach GitHub at all, which meant every existing suite stayed green throughout and
no half-built code path was ever live.

---

## Part 3. Recommended reading path

If you are re-learning this subsystem, read in this order:

1. `packages/core/src/github/github.ts` - the port. Eight methods, no Octokit, no HTTP.
2. `packages/core/src/github/reconcile.ts` - 58 lines, and the heart of the milestone.
3. `packages/core/src/github/effect-store.ts` - the receipt ledger.
4. `packages/core/src/pipeline/finalizing-phase.ts`, `publishValidatedWorkspace()` - the protocol
   executed in order.
5. `apps/worker/src/git/host-git.ts` - `seedClone()` and `publish()`, the only code in Rivet that
   runs `git` outside a container.
6. `apps/worker/src/github.ts` - the assembly point, and the token-registration decorator.
7. `apps/worker/tests/integration/publication.int.test.ts` - runs A through G, which is the
   executable version of the acceptance contract.

---

## Part 4. Two paths, chosen by one field

Everything in M9 branches on a single question: **does this job carry an installation binding?**

```ts
// packages/core/src/pipeline/provisioning-phase.ts
function githubBinding(ctx: PhaseContext): GitHubBinding | null;
```

It returns non-null when `jobs.github_installation_id`, `jobs.repo_owner` and `jobs.repo_name` are
all present. Those columns are set by the create form's picker and by `demo:pr`, and are null for a
manually typed repository URL, every fixture, `demo:job` and `demo:recovery`.

|                   | Unbound job                                          | Bound job                                               |
| ----------------- | ---------------------------------------------------- | ------------------------------------------------------- |
| Provisioning      | anonymous `git clone` inside the container           | host clone with a read token, tarred, `putArchive`'d in |
| Private repos     | impossible                                           | supported                                               |
| Finalizing        | `publication.skipped`                                | branch, commit, push, PR                                |
| Needs credentials | no                                                   | yes                                                     |
| Used by           | CI, all existing suites, `demo:job`, `demo:recovery` | the create form's picker, `demo:pr`                     |

This is why M9 added a whole publication subsystem without touching a single existing test's
expectations. **The old path is not a legacy fallback; it is a first-class mode**, and it is the one
CI runs under.

A second switch sits above this one: `RIVET_GITHUB`. With it `off`, `PipelineOptions.github` is
`undefined`, and a _bound_ job silently takes the unbound path (still cloning anonymously, still
recording `publication.skipped`). That is deliberate and is why `parseWorkerConfig` refuses `off`
under `NODE_ENV=production` - a worker that completes jobs while quietly skipping publication looks
perfectly healthy, which is the worst failure mode on offer.

---

## Part 5. The port, the adapter, and the fake

### The port

`packages/core/src/github/github.ts` declares eight methods in the domain's own vocabulary:

```ts
interface GitHubClient {
  listInstallations(): Promise<Installation[]>;
  listRepositories(installationId: number): Promise<Repository[]>;
  listIssues(installationId: number, repo: RepoRef): Promise<Issue[]>;
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

Two design details on this interface are worth naming:

**The installation id is explicit on every method that needs a token.** It would have been tidier to
construct a client per installation and drop the parameter. It was not done, because an adapter that
holds an installation id in a field can accidentally use a token minted for one installation against
another repository, and that mistake is invisible until it is a security incident. Passing it per
call makes the mismatch impossible to express.

**`getRef` returns `{ commitSha, treeSha }`, not just a commit.** The tree is the entire reason the
method exists. See Part 8.

### The adapter

`packages/github/src/github-client.ts` (537 lines) is the only file that knows Octokit exists. It
uses `@octokit/app` for App JWT signing and installation-token minting, and `@octokit/rest` for the
calls. Every call goes through one wrapper:

```ts
// paraphrased from github-client.ts
let retryCount = 0;
for (;;) {
  try {
    return await operation();
  } catch (cause) {
    const classified = classifyGitHubResponse({ status, message, retryAfterMs }, op, { cause });
    if (!(classified instanceof GitHubUnavailableError) || retryCount >= this.maxRetries) {
      throw classified;
    }
    await this.sleep(this.retryDelay(classified.retryAfterMs, retryCount));
    retryCount += 1;
  }
}
```

The delay is exponential, jittered to half-to-full, capped, and floored by any `Retry-After` GitHub
supplied:

```ts
const exponential = Math.min(this.maxDelayMs, this.initialDelayMs * 2 ** retryCount);
const jittered = Math.floor(exponential * (0.5 + this.random() * 0.5));
return Math.min(this.maxDelayMs, Math.max(retryAfterMs ?? 0, jittered));
```

Jitter matters even when `Retry-After` is present, because several workers that hit the same rate
limit would otherwise all wake at the same instant and hit it again together.

`sleep` and `random` are injectable, which is what lets the retry tests run in microseconds with no
fake timers.

### The fake

`packages/github/src/fake-github.ts` (266 lines) implements the same interface over in-memory state,
records every call in `client.calls`, and can be scripted to fail a specific method with a specific
status. Runs A through G are built on it. It is in `packages/github` rather than in the test
directory for the same reason `FakeCodingAgent` and the scripted sandbox are in their packages: a
fake that lives next to the adapter gets updated when the interface changes, and one that lives in a
test file quietly rots.

---

## Part 6. The credential

This is the part to read twice.

### What the token is

A GitHub App installation access token: minted on demand, scoped to one installation, expiring in an
hour, requested at one of two permission levels.

```ts
export type TokenScope = "read" | "write";
```

Provisioning's seed clone mints `read`. Finalizing's push mints `write`. Two scopes rather than one
because the seeding step has no business holding a token that can push, and narrowing it costs a
single field. This is ordinary least-privilege, and it is worth doing precisely because the seeding
step is the one whose output goes near untrusted code.

### Where the token is allowed to be

Exactly two places: a variable in the worker process, and a file the worker writes to a temporary
directory it owns.

### Where it must never be

- **Never in an argv.** Argv is recorded in `job_commands`, which is served to the browser.
- **Never in a remote URL.** A URL-embedded credential lands in the clone's `.git/config`, which is
  inside the tar archive, which goes into a container running arbitrary cloned code.
- **Never in `SandboxSpec.env`.** Same reason, one layer up.
- **Never in a log line.** Provider error messages have a habit of quoting the request back at you.

### How that is enforced

**`GIT_ASKPASS`.** Git needs a credential and the only channels are the URL, an interactive prompt,
or an askpass helper. Rivet writes a three-line shell script to mode `0700` in a temp directory:

```sh
#!/bin/sh
case "$1" in
  *Username*|*username*) printf '%s\n' "$GIT_USERNAME" ;;
  *) printf '%s\n' "$RIVET_GIT_TOKEN" ;;
esac
```

and runs every git command with:

```ts
{
  GIT_ASKPASS: askPassPath,
  GIT_TERMINAL_PROMPT: "0",   // fail rather than hang if askpass is bypassed
  GIT_USERNAME: "x-access-token",
  RIVET_GIT_TOKEN: token,
  GIT_CONFIG_NOSYSTEM: "1",   // ignore /etc/gitconfig
  HOME: home,                 // ignore the operator's ~/.gitconfig
  XDG_CONFIG_HOME: configHome,
}
```

The last three lines exist because the host is a developer laptop or a CI runner with its own git
configuration. A `credential.helper` in the operator's `~/.gitconfig`, or a `url.insteadOf` rewrite,
would otherwise change what Rivet's commands do. Isolating `HOME` makes the operation depend only on
what Rivet passed it.

The helper file is removed in a `finally` on every exit path, including the failing ones.

**Assertions.** Before any command runs:

```ts
assertRemoteHasNoCredential(remoteUrl, token); // the URL must not already contain it
assertNoSecret(argv, token); // no argv element may contain it
```

**Transcript redaction.** `runHostCommand` passes every captured stdout and stderr through
`redactText(value, secret)` before the observer sees it, so a git error that echoes a URL cannot
land in an event.

**The `SecretRegistry` safety net.** `apps/worker/src/secrets.ts` holds live tokens, and
`createLogger` runs every log argument through it. This is explicitly a net, not a boundary - the
file's own comment says so. Its value is what happens when _future_ code is careless.

Two details in it are deliberate:

```ts
const MIN_SECRET_LENGTH = 12;
```

Below that length, a "secret" is more likely to be a substring of ordinary text, and redacting it
would corrupt logs rather than protect anything.

```ts
const RETENTION_GRACE_MS = 60_000;
```

Tokens are short-lived, so the registry is bounded by expiry rather than growing for the life of the
process. An expired token is not a secret, and keeping it would make every log line scan a growing
list.

**Registration happens at the outermost layer.** `apps/worker/src/github.ts` wraps the adapter in a
decorator whose only real method is:

```ts
async mintInstallationToken(installationId, repo, scope) {
  const token = await this.inner.mintInstallationToken(installationId, repo, scope);
  this.secrets.add(token.value, token.expiresAt);
  return token;
}
```

A decorator rather than a hook inside the adapter, because the adapter has no business knowing what
a logger is. Outermost rather than innermost, because a token must be registered _before_ it is
returned to any caller: there must be no window in which a live credential exists and the redaction
pass does not know about it.

**And the sandbox test proves it.** `publication.sbx.test.ts` greps for a sentinel token across the
container's environment, its `.git/config`, every `job_commands` row, every `job_events` row and
every host Git argv. That test is the difference between believing the token stayed put and knowing
it.

---

## Part 7. Host Git operations

`apps/worker/src/git/host-git.ts` is 883 lines and exports two functions. It lives in `apps/worker`
rather than `packages/core` because it spawns processes and reads the filesystem, and core does
neither.

### `seedClone()`

Used by `provisioning` for a bound job.

```text
1. mkdtemp                                 a temp directory the worker owns
2. write askpass.sh (0700)
3. git clone --depth 1 --branch <base> <url> repo
4. checkout the exact base commit          (fetch it if the shallow clone lacks it)
5. git rev-parse HEAD^{tree}
6. git remote remove origin                <-- the important one
7. tar --uid 1000 --gid 1000 --numeric-owner --no-xattrs -C root -cf - repo
8. rm askpass.sh                           (finally, always)
=> { archive, commitSha, treeSha }
```

Step 6 is the whole reason this is safe. The archive contains a complete Git repository - history,
index, the works - with **no remote**, so nothing inside the container can discover where it came
from or attempt to authenticate against it.

The host clone completes **before a container exists**. That ordering is deliberate: a private
repository that the App cannot reach fails as a GitHub error rather than creating a container that
can never be populated and then failing inside it.

#### The two tar flags, and why they are load-bearing

```ts
"--no-xattrs",
// ...
env: { ...command.env, COPYFILE_DISABLE: "1" },
```

Both exist because of macOS, and both cost time to rediscover:

- **`--no-xattrs`.** bsdtar records extended attributes. On macOS every file carries
  `com.apple.provenance`. Docker's `putArchive` then fails the _entire upload_ with
  `lsetxattr ... operation not supported`, which surfaces as `sandbox_create_failed` on a repository
  that is perfectly fine. The seed needs contents, modes and ownership, never a host's extended
  attributes. GNU tar has accepted the flag since 1.27, so CI reads it identically.
- **`COPYFILE_DISABLE=1`.** Without it, bsdtar writes an AppleDouble `._name` sidecar next to every
  entry, and the container gets a repository whose `git status` is a page of untracked files Rivet
  invented - which would then appear in the diff, the validation totals and the pull request. GNU
  tar ignores the variable.

Run H in `publication.sbx.test.ts` is what catches both, and it is the reason that test asserts
`git status --porcelain` is empty immediately after the seed lands.

#### The size bound

`GITHUB_SEED_MAX_BYTES` (256MiB) is applied to the tar's stdout as it streams. Exceeding it raises
`SeedArchiveTooLargeError`, which extends `RepoUnavailableError` - so an oversized repository is
reported as `repo_unavailable`, a category that already means "Rivet could not obtain this
repository", rather than as an unclassified worker heap failure.

### `publish()`

Used by `finalizing`.

```text
1. mkdtemp; write askpass.sh
2. git clone --depth 1 --branch <base> <url> repo
3. checkout the exact base commit
4. git checkout -B <branch> HEAD
5. write rivet.patch (0600)
6. git apply --binary rivet.patch
7. git add -A
8. git diff --cached --numstat --no-renames --no-ext-diff --no-textconv
9. git commit --no-verify --message "Rivet: <title>"   (bot identity via GIT_AUTHOR_*/GIT_COMMITTER_*)
10. git rev-parse HEAD and HEAD^{tree}
11. git push --force-with-lease[=ref:expected] --porcelain origin HEAD:refs/heads/<branch>
12. rm askpass.sh                                       (finally, always)
=> { commitSha, treeSha, filesChanged, insertions, deletions, forced }
```

Four things here are decisions rather than mechanics:

**The patch is applied to the immutable base commit, never to the remote branch's current tree.** A
resumed publication therefore replaces the previous attempt's commit rather than stacking an
unreviewed commit on top of it. The branch always holds exactly one commit representing exactly the
tree that was validated and reviewed.

**`--no-verify`.** The cloned repository may install commit hooks. Running somebody else's hook on
the worker host, as part of Rivet's own commit, is arbitrary host-side code execution outside the
sandbox. The sandbox exists so that repository code runs in a container; a hook that fires here
would walk straight around it.

**`--force-with-lease`, with an explicit expected value when one is known.** A bare
`--force-with-lease` compares against the local remote-tracking ref, which in a fresh shallow clone
is not a meaningful lease. When reconciliation already fetched the remote ref, the exact commit is
passed:

```ts
const lease =
  expectedRemoteCommitSha === undefined
    ? "--force-with-lease"
    : `--force-with-lease=refs/heads/${input.branch}:${expectedRemoteCommitSha ?? ""}`;
```

so a concurrent writer between the read and the push loses the race loudly rather than being
silently overwritten.

**A push failure becomes `PushRejectedError` specifically**, not the generic host-git error, so the
job's terminal category names the thing that actually happened.

### The host clone is not reused

Provisioning's clone and finalizing's clone are separate, short-lived, and independent. Do not try
to keep one alive across the job: a reclaimed job may finalize on a **different machine** than the
one that provisioned it, so a design that depends on host state surviving the attempt is a design
that fails exactly when recovery matters.

---

## Part 8. The receipt protocol

This is the intellectual core of the milestone.

### The problem

A worker can die at any instruction. Consider the window between these two lines:

```text
git push origin HEAD:refs/heads/rivet/job-abc12345-fix-thing     <-- external, irreversible
INSERT INTO job_external_effects ...                             <-- durable acknowledgement
```

A crash in between leaves GitHub holding a branch that Rivet has no record of creating. A
replacement worker that simply replays the phase would push again. For a branch, that is merely
wasteful; for a pull request, it is a duplicate somebody has to close.

### The three ingredients

**1. A deterministic name.**

```ts
// packages/core/src/github/branch-name.ts
deriveBranchName(jobId, title) === `rivet/job-${jobId.slice(0, 8)}-${slugify(title)}`;
```

The job id comes **first** so that two jobs with identical titles produce different branches. The
slug is bounded at 40 characters, truncated at a word boundary, with non-alphanumerics collapsed to
single hyphens and Unicode letters and numbers preserved. The whole name is capped at 100
characters.

A _random_ name would make the protocol impossible, because a resumed attempt would have no way to
ask GitHub what it already did. Determinism is what makes step 2 exist at all.

The name is also persisted to `jobs.final_branch` **before** the push, so a crash mid-push leaves it
recoverable from Postgres as well as from the derivation.

**2. A receipt ledger.**

```sql
CREATE TABLE job_external_effects (
  id           bigserial PRIMARY KEY,
  job_id       uuid NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
  kind         text NOT NULL,
  provider     text NOT NULL,
  external_id  text NOT NULL,
  external_url text NOT NULL,
  payload      jsonb,
  created_at   timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT job_external_effects_job_id_kind_unique UNIQUE (job_id, kind)
);
```

The unique constraint is the idempotency key. `recordExternalEffectWithResult` inserts with
`onConflictDoNothing` and, on conflict, **reads the existing row and returns it** rather than
throwing:

```ts
if (inserted) return { effect: toExternalEffect(inserted), inserted: true };
const existing = await getExternalEffect(input.jobId, input.kind, executor);
```

`DO NOTHING` rather than an upsert, because this is a ledger: the row records that an effect was
acknowledged at a moment, and updating it would erase that. The insert is fenced on `lease_owner`
inside the same transaction as the lease check, so a stale worker cannot commit a receipt after
being reclaimed.

**3. Reconciliation.**

```ts
// packages/core/src/github/reconcile.ts, in full
if (input.remoteRef === null) return "push";
if (input.remoteRef.treeSha === input.desiredTreeSha) return "adopt";
return "force_push";
```

Three lines. The entire subtlety is in the comment above them:

> Commits are intentionally not compared here. Their metadata includes a timestamp and therefore
> changes when a replacement worker reconstructs the same tree. A matching remote tree is the
> durable fact that makes adoption safe.

**Compare trees, not commits.** A commit sha hashes the author and committer timestamps. Re-running
`publish()` on identical inputs one second later produces a _different commit sha_ for an _identical
tree_. Comparing commits would report "different" on every single resume and force-push forever.

Note also what the function does **not** consult in its decision: the receipt. It takes one, and the
type documents the two interesting states -

- a receipt with no remote ref means the row is stale (somebody deleted the branch),
- a remote ref with no receipt is exactly the crash window the protocol exists for -

but the _action_ is decided purely by comparing the remote tree to the desired tree. That is the
right call: the receipt records what Rivet believes, and the remote ref records what is true.

### The pull-request half

The PR reconciliation is not symmetric, and deliberately so:

```ts
const existing = await github.client.findPullRequest(installationId, repo, branch);
if (!existing && pullRequestReceipt) {
  throw new PullRequestFailedError(`GitHub no longer returns pull request ... for branch ...`);
}
if (existing) {
  adopted = true;
  if (existing.state === "open") {
    pullRequest = await updatePullRequest({ ..., title, body });  // refresh the body
  } else {
    pullRequest = existing;   // closed or merged: adopt and report, never reopen
  }
} else {
  pullRequest = await createPullRequest({ ... });
}
```

Two judgments here:

- **A receipt whose PR has vanished is a failure, not a reason to open a new one.** If Rivet
  acknowledged a PR and GitHub no longer returns it, something happened that Rivet does not
  understand, and quietly creating a second one would compound it.
- **A closed or merged PR is adopted and reported, never reopened.** The PR is still the external
  result of the job. A human closed or merged it, and a worker that resumed for unrelated reasons
  must not reverse that decision.

### `reconcile_external`

```ts
{ status: "finalizing", label: "Finalize", durationMs: 2_000, recovery: "reconcile_external" }
```

M6 introduced `Phase.recovery` as a required field with three legal words, and M6 deliberately
shipped with nothing declaring the third. The comment at the time said why: the field being required
meant M9's first GitHub call could not be added to a phase without somebody explicitly choosing the
word, because `replay` would be a _claim_ that pushing a branch twice is harmless.

M9 replaces the test asserting nothing declares it with a test asserting `finalizing` declares it
and is still the only one. That is a small thing that paid for itself three milestones later, and it
is worth copying: **make the dangerous option require a deliberate keystroke, then assert nobody has
pressed it.**

---

## Part 9. `finalizing`, step by step

`publishValidatedWorkspace()` in `packages/core/src/pipeline/finalizing-phase.ts`, in execution
order:

```text
 1. read the branch receipt                      readExternalEffect("branch_pushed")
 2. ask GitHub for refs/heads/<branch>           client.getRef(...)
 3. capture the workspace                        ctx.captureWorkspace()  -> patch + treeSha
 4. persist the branch name                      recordPublication({ finalBranch })
 5. emit branch.created
 6. decide                                       decideReconciliation(receipt, ref, treeSha)
 7a. adopt: take commitSha/treeSha from the remote ref
 7b. otherwise: mint a WRITE token, github.publish(...)
 8. assert published treeSha === desired treeSha
 9. emit commit.created
10. emit push.completed                          (skipped when adopting)
11. record the branch_pushed receipt
12. read plan, review report, diff stat
13. compose the PR body
14. persist it as a pull_request_body artifact   requireComplete: true
15. read the PR receipt; findPullRequest(...)
16. create, update, or adopt
17. emit pull_request.opened | pull_request.adopted
18. record the pull_request_opened receipt
19. recordPublication({ pullRequestNumber, pullRequestUrl })
```

Several orderings in that list are load-bearing:

**Capture (3) happens before the branch name is persisted (4).** A failed capture must not leave a
job claiming a branch that Rivet never tried to create.

**The tree assertion (8) is not paranoia.** It compares what the host clone actually produced
against what the sandbox capture said it would produce. If they disagree, something about the patch
or the base commit is wrong, and the run stops rather than opening a PR whose contents nobody
verified. It is the same class of check as M6's checkpoint checksum, applied at the other end of the
pipeline.

**The body artifact is written before the PR call (14 before 16), with `requireComplete: true`.** So
a `pull_request_failed` job still shows a reader exactly what Rivet was about to publish.
`requireComplete` means a body that would be truncated by the artifact cap fails instead of being
silently clipped.

**The write token is minted only in the non-adopt branch (7b).** An adopted publication never mints
a write-scoped credential at all.

**`recordPublication` is fenced on the lease.** It is one of the seven `.update(jobs)` sites in
`packages/`, it cannot write `status` (the type forbids it), and it returns `false` when the worker
has been fenced out - at which point the phase must stop rather than writing a stale branch identity
into a replacement run.

---

## Part 10. The pull request body

`packages/core/src/github/pull-request-body.ts` is 131 lines, pure, and has no I/O. It is a function
from records to a string, and every input already existed in Postgres before M9:

| PRD §6.9 requirement   | Source                                             |
| ---------------------- | -------------------------------------------------- |
| Issue summary          | `jobs.title`, `jobs.description`, `jobs.issue_url` |
| Root cause             | `implementation_plan` artifact (M6)                |
| Implementation summary | `implementation_summary` artifact (M7)             |
| Files changed          | `diff_stat` artifact (M7)                          |
| Tests executed         | `validation_report` artifact (M7)                  |
| Known limitations      | `implementation_plan` artifact (M6)                |
| Execution ID           | `jobs.id`                                          |

That table is the argument for the whole "durable artifacts" discipline of milestones 5 through 8.
By the time M9 needed to write a pull request, there was nothing left to invent: the body is a
**rendering** of records, not a new model call. It is unit-testable with no network, no database and
no model, and it cannot drift from what the job actually did, because it has no independent source
of truth to drift toward.

The footer carries the job id and a link back to the run:

```ts
function runUrlFor(options: PipelineOptions, jobId: string): string;
```

built from `RIVET_APP_URL`. Absent that variable it falls back to a relative `/jobs/<id>`, which is
correct inside Rivet and **resolves against github.com** in a pull request - which is precisely why
a publishing deployment must set it. On a local machine the link reads
`http://localhost:3000/jobs/...` and is dead for anyone but the operator; that is expected, not a
bug.

---

## Part 11. Failure categories, and why every one is terminal

```ts
export const GITHUB_FAILURE_CATEGORIES = [
  "github_unavailable",
  "github_permission_denied",
  "push_rejected",
  "pull_request_failed",
  "github_not_installed",
] as const;
```

`classifyGitHubResponse(response, operation)` maps a provider response to one of these:

| Condition                                             | Category                   |
| ----------------------------------------------------- | -------------------------- |
| no status (transport), 429, 5xx, or any `Retry-After` | `github_unavailable`       |
| 403 or 404 during an `installation` operation         | `github_not_installed`     |
| 403 or 404 otherwise                                  | `github_permission_denied` |
| other non-2xx during a `pull_request` operation       | `pull_request_failed`      |
| other non-2xx otherwise                               | `github_permission_denied` |
| git refused the ref update                            | `push_rejected`            |

**All five extend `TerminalJobError`.** The interesting one is `github_unavailable`, because it is
the one failure a repeat could plausibly get past, and during Stage 10 it was briefly implemented as
retryable. It was made terminal deliberately. The reasoning, which is preserved verbatim in the
class's own doc comment:

> The repeat that is worth making is the adapter's: bounded, jittered, and honouring `Retry-After`,
> close enough to the request to be one call rather than one attempt. A runner-level retry re-runs
> the entire job from provisioning to reach the same publication - safe by construction, because the
> receipt protocol makes the external effect idempotent, but it spends a container, a clone and a
> model session to repeat one HTTP call, and turns a GitHub outage into three identical timelines.
> The adapter has already given up by the time this reaches a phase.

Note the shape of that argument. The runner-level retry is **not unsafe** - the receipt protocol
makes it survivable, which is the whole point of Part 8. It is rejected on cost and on legibility.
That is a different and more honest reason than "it would break something", and it is worth
distinguishing when you revisit this.

**A `pull_request_failed` job keeps its branch.** Deleting the branch to make the failure tidy would
destroy the actual work the job produced. The branch is real, it is pushed, and a human can open the
PR by hand.

---

## Part 12. The database

### `job_external_effects`

Append-only, one row per `(job_id, kind)`, cascade-deleted with the job, indexed on `(job_id, id)`.
Written only by `packages/core/src/github/effect-store.ts`. It joins `job_events`, `job_artifacts`,
`job_commands` and `job_checkpoints` as a single-writer ledger.

### `github_installations`

```sql
CREATE TABLE github_installations (
  id            integer PRIMARY KEY,      -- GitHub's own installation id
  account_login text NOT NULL,
  account_type  text NOT NULL,
  target_type   text NOT NULL,
  permissions   jsonb NOT NULL,
  suspended     boolean NOT NULL DEFAULT false,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);
```

**This is the one table in Rivet that is a cache rather than a record**, and the distinction drives
its behaviour:

- Its writer (`installation-store.ts`) genuinely **upserts**, unlike every other single-writer here.
- Reads of the control-plane surface go to the GitHub API and refresh what they learn, rather than
  serving the table.
- Rows for installations GitHub stops returning are **left in place**, because jobs reference them
  and a job's history should not become unreadable when somebody uninstalls an App.

The reason it works this way: **M9 subscribes to no webhooks.** GitHub owns the truth about
installations, and without webhooks the only way an uninstall or a permissions change ever becomes
visible is to ask on demand. Keying on GitHub's installation id rather than a surrogate also means
M11's multi-user work adds an `owner_user_id` column rather than a new table.

### The six job columns

`github_installation_id`, `repo_owner`, `repo_name`, `issue_number`, `issue_url` are the binding,
set at creation and immutable. `pull_request_number` joins `final_branch` and `pull_request_url`,
which have existed unused since M0.

---

## Part 13. The web surface

### `/settings/github`

Lists the installations the App can act on, **read live from the API**, with a link to install and a
link to manage each one. It is not a view of the cache table, for the reason in Part 12.

### `/api/github/setup`

The App's post-install landing URL. GitHub redirects here with `installation_id` and `setup_action`.

**The handler trusts nothing in the query string.** It calls `listInstallations()` and persists a
row only if the callback's id is among the installations the App can actually act on, so a
hand-typed URL cannot fabricate an installation that Rivet then offers as a publication target.

`setup_action=request` (an org admin still has to approve) has no installation to record, and saying
so is the whole response. Every outcome ends at `/settings/github?setup=<status>` with a 303,
because a person's browser is what lands here, not a JSON client.

### The three read routes

`/api/github/installations`, `/api/github/repositories`, `/api/github/issues`. All read-only, all
backed by the port, all answering **503 rather than 500** when GitHub is off or unconfigured. A 503
with a sentence is a configuration state; a 500 is a bug, and conflating them wastes an afternoon.

### `resolveGitHubWebConfig`

```ts
export type GitHubWebConfig =
  | { enabled: true; appSlug: string | null }
  | { enabled: false; reason: "disabled" | "unconfigured" };
```

A **pure function of an env object**, tested with literals. That is what keeps `next build` working
on a machine with no credentials, which is CI's `verify` job and is not negotiable. The two disabled
reasons are distinguished because "you turned it off" and "you turned it on but did not supply
credentials" need different sentences.

Note the asymmetry with the worker: the worker _refuses_ `off` in production because a silently
non-publishing worker looks healthy. The web app's stake is milder - with GitHub off, the pickers
cannot answer, so the create form falls back to the manual URL it has always had.

### The create form

Gains an installation → repository → issue picker, with the manual URL kept as a **disclosed
fallback**. That fallback is not vestigial: it is the path every fixture, `demo:job` and
`demo:recovery` take.

### The timeline

`apps/web/lib/publication-events.ts` gives the eight publication events dedicated presentations.
They are **the only rows in the entire event log that link outward**, and the job detail page
renders the pull request and the issue as links once they exist.

---

## Part 14. Configuration

```bash
RIVET_GITHUB=app|off             # default off; REFUSED under NODE_ENV=production
GITHUB_APP_ID=...
GITHUB_APP_PRIVATE_KEY=...       # base64-encoded PEM
GITHUB_APP_SLUG=...              # only used to build the install link
GITHUB_CLONE_TIMEOUT_MS=180000
GITHUB_PUSH_TIMEOUT_MS=180000
GITHUB_SEED_MAX_BYTES=268435456
RIVET_APP_URL=https://...        # absolute; used for the PR body's run link
```

Three decisions:

**Credentials are validated and base64-decoded at startup, not at publication.** `finalizing` is the
_last_ phase, so validating there fails a job whose work was already written, validated and approved

- the most expensive possible moment to discover a typo in an environment variable.

**They are passed to the adapter explicitly rather than read from the environment by it.** The
worker already validated and decoded them, and one place that knows how a PEM arrives is enough. It
is also what lets `packages/github` be imported in a test with no environment at all.

**The GitHub timeouts are separate from the `SANDBOX_*` ones.** These bound a host clone, archive,
apply, commit and push; the sandbox timeouts bound an unauthenticated clone inside a container.
Sharing them would couple two unrelated operations to one number.

---

## Part 15. The acceptance runs

`docs/plans/milestone-9-acceptance.md` is the contract. It is implemented by two files.

### Runs A-G: `apps/worker/tests/integration/publication.int.test.ts`

Ten cases against real Postgres, real Redis, real BullMQ, the **real** host Git operations, a
`FakeGitHubClient`, and a **local bare repository standing in for GitHub**.

| Run | Scenario                            | Proves                                                       |
| --- | ----------------------------------- | ------------------------------------------------------------ |
| A   | no installation binding             | `publication.skipped`, no GitHub call, job completes         |
| B   | bound repository, clean publish     | the eight events, both receipts, the real bare remote's refs |
| C   | crash between push and receipt      | the replacement adopts rather than duplicating               |
| D   | resume whose tree changed           | `forced: true`, new tree, parent is still the base commit    |
| E   | a PR already open                   | adopted and its body updated, never duplicated               |
| F   | App uninstalled mid-job             | `github_not_installed`, terminal, `attemptCount === 1`       |
| G   | the PR call fails after a good push | `pull_request_failed`, the branch survives                   |

The key technique is worth stealing: **the fake sandbox reports real capture bytes.** A real
repository is built on disk, the exact capture argv is run against it, and those genuine patch bytes
are what the scripted sandbox returns. The production `publish()` then applies a real patch to a
real bare remote. So runs A-G are honest about Git while needing neither Docker nor a network.

Run D additionally needs _two_ capture variants and a counter shared between the `git write-tree`
and capture-diff responses, so a resumed attempt can restore-and-verify against variant A and then
publish variant B without breaking M6's restore checksum.

Run F asserts `attemptCount === 1` and exactly one `getRef` call. That is the literal, executable
form of "every GitHub failure category is terminal".

### Run H: `apps/worker/tests/sandbox/publication.sbx.test.ts`

Two cases against Docker:

1. A seeded repository, inspected the instant the archive lands: `git status --porcelain` is empty,
   `HEAD` is the base commit, `git remote` is empty, `.git/config` has no token, a binary file
   survives byte for byte to the pushed branch, and the sentinel token appears in **no** container
   env, `.git/config`, command row, event row or host Git argv.
2. `seedMaxBytes: 4096` → the job fails `repo_unavailable` and **no container is created**.

### `pnpm demo:pr`

One real job against a throwaway GitHub repository, ending in a real pull request. It resolves the
installation that can reach the target, picks the first open issue (falling back to a built-in
task), creates the job, tails the timeline, and prints the branch and PR URL. It deletes nothing.

---

## Part 16. The verification ladder

Run these in order; each level is cheap relative to the one after it.

```bash
# 1. offline, no infrastructure at all
pnpm typecheck && pnpm lint && pnpm format:check && pnpm test && pnpm build

# 2. focused
pnpm --filter @rivet/core test src/github
pnpm --filter @rivet/github test
pnpm --filter @rivet/worker test src/git src/secrets src/github.test.ts

# 3. integration acceptance (Postgres + Redis)
pnpm --filter @rivet/worker test:integration tests/integration/publication.int.test.ts

# 4. sandbox acceptance (Postgres + Redis + Docker)
pnpm --filter @rivet/worker test:sandbox tests/sandbox/publication.sbx.test.ts

# 5. web regression (Postgres only)
pnpm test:streaming

# 6. the real thing
pnpm demo:pr
```

Level 1 is the one that protects the architecture: it must pass with **no database, no Redis and no
Docker**, which is what keeps the lazy clients, `force-dynamic` and `resolveGitHubWebConfig` honest.

---

## Part 17. Debugging guide

### The job completes but no pull request appears

Check for `publication.skipped` in the timeline and read its `reason`, which is one of exactly two
values: `github_off` or `no_installation`. The three causes, in order of likelihood:

- `RIVET_GITHUB` is not `app`, so `PipelineOptions.github` is `undefined`.
- The job has no installation binding, because it was created through the manual URL fallback rather
  than the picker. Check `jobs.github_installation_id`.
- App credentials are absent, so `parseWorkerConfig` resolved GitHub off.

### The job fails `sandbox_create_failed` on a repository that is fine

Almost certainly the tar flags on macOS. Look for `lsetxattr ... operation not supported`. Confirm
`--no-xattrs` is still in the argv in `host-git.ts`.

### The container's `git status` shows files nobody wrote

`COPYFILE_DISABLE=1` has been dropped from the tar command's env, and bsdtar is writing AppleDouble
`._*` sidecars. Those files then enter the diff and the validation totals.

### The job fails `repo_unavailable` at provisioning on a bound job

Three shapes: the App cannot see the repository (`findRepository` throws
`GitHubPermissionDeniedError` first, so check the category), the clone timed out
(`GITHUB_CLONE_TIMEOUT_MS`), or the archive exceeded `GITHUB_SEED_MAX_BYTES`.

### Every resume force-pushes

Something is comparing commits instead of trees. Check that `getRef` still returns `treeSha` and
that `decideReconciliation` is being handed `workspace.treeSha` rather than a commit.

### `checkpoint_corrupt` with "invalid tree id (empty)"

Not a GitHub problem. A scripted-sandbox fixture is missing a `git write-tree` matcher. Stage 7
added that command to `captureWorkspacePatch`, and any fixture that scripts capture must answer it.
This broke `review-fixture.ts` and `agent.int.test.ts` and was fixed in Stage 10.

### A publication error blames the wrong thing

Read `classifyGitHubResponse`. The `operation` argument (`installation` / `repository` /
`pull_request`) is what separates `github_not_installed` from `github_permission_denied` from
`pull_request_failed` on the same status code. Passing the wrong operation produces a technically
true but useless category.

### A token appears somewhere it should not

Work outward: is it in an argv (`assertNoSecret` should have thrown), in a remote URL
(`assertRemoteHasNoCredential`), in a transcript (`redactText`), or in a log (`SecretRegistry`)? The
first three are boundaries and indicate a real bug; the last is the net and indicates the boundaries
were bypassed.

### The full test check is `unresolved` and the job fails despite good work

Not an M9 issue, but it is the first thing a real demo hits. `unresolved` means the suite is red and
Rivet **could not attribute** the failures, because attribution requires a vitest or jest JSON
report. A repository with a red baseline and a `node --test` runner can never pass validation, no
matter how good the change is. See Part 18.

---

## Part 18. Design decisions to preserve

**Keep the container credential-free.** This is the invariant M9 had the strongest incentive to
break. Every awkward thing in Part 7 exists to preserve it. If a future milestone wants the
container to push, the honest move is a fresh design discussion, not a quiet `SandboxSpec.env`
addition.

**Keep both provisioning paths.** The anonymous in-container clone is not legacy. It is what lets
CI, every existing suite and a laptop with no App run the whole pipeline.

**Compare trees, never commits.** Anything else force-pushes on every resume.

**Keep the receipt ledger append-only and conflict-aware.** `DO NOTHING` plus a read is what makes
"did I already do this?" a question Postgres answers rather than a question code guesses at.

**Keep publication failures terminal.** The adapter retries; the runner does not. Revisit this only
with a concrete cost argument, because the safety argument is already settled.

**Keep the PR body a pure function of records.** No model call, no I/O, no independent source of
truth. It cannot drift from what the job did because it has nowhere to drift to.

**Keep `recovery` required.** The value of the field is entirely in the fact that
`reconcile_external` had to be typed on purpose.

**Keep the web config a pure function.** It is the only thing standing between `next build` and a
machine with no credentials.

**Keep the ordering inside `finalizing`.** Capture before naming; body artifact before the PR call;
tree assertion before any event claims success.

---

## Part 19. Known limits, and the M10 handoff

Honest about what M9 does **not** do:

- **No authentication and no users.** Installations are global; whoever reaches the app can use
  them. This is a deliberate §27/M11 deferral, and `SECURITY.md` says in as many words that the app
  must not be deployed publicly as-is. M9 is the first milestone where Rivet holds a credential that
  can write to somebody's repository, which is why that file was written now rather than later.
- **No webhooks.** Uninstalls and permission changes become visible only when something asks. This
  is why the installations table is a cache.
- **No PR comments, reviews, or status checks.** The deliverable is a pull request, not a
  conversation on one.
- **One provider.** `provider` is a column and `ExternalEffectProvider` is a type, so a second one
  is additive, but nothing has been generalized speculatively.
- **Attribution still requires vitest or jest.** A red-baseline repository with any other runner
  cannot pass validation. This is an M7 limitation that M9 makes newly visible, because a real
  GitHub repository is far more likely to have a red baseline than a fixture is. It is conservative
  by design - `unresolved` means "I cannot prove I did not break this" - but it is the most likely
  thing to frustrate a real user, and it is the strongest candidate for the next piece of work.
- **`git` is now a runtime dependency of `apps/worker`.** Not of `pnpm build`, `test`, `lint` or
  `typecheck`, which still run on a bare machine.

---

## Part 20. Suggested learning exercises

1. **Break the tree comparison.** Change `decideReconciliation` to compare `commitSha` and run run
   C. Watch it force-push where it should adopt, and note that nothing else in the suite complains.
2. **Remove `git remote remove origin`** from `seedClone` and run run H. Find the token in
   `.git/config` and trace exactly which assertion should have caught it and why it did not.
3. **Make `github_unavailable` retryable again.** Run F, and count the timelines. That is the cost
   argument in Part 11, made concrete.
4. **Delete the branch on GitHub after a successful job, then resume it.** Predict the
   reconciliation action before you run it: the receipt exists, the ref does not.
5. **Add a third external effect** - say, a comment on the issue. Notice how much of the protocol
   you get for free from the `(job_id, kind)` key, and how much you must decide yourself (what is
   the deterministic identity of a comment?).
6. **Drop `--no-verify`** from the publish commit and add a `pre-commit` hook to the demo repository
   that writes a file. Observe host-side code execution outside the sandbox.
7. **Set `RIVET_APP_URL` to a real origin** and compare the resulting PR body's footer link to the
   relative fallback rendered on github.com.
