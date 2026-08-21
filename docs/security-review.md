# Security review

This is the written half of Milestone 11's last stage. It walks PRD §27's minimum list item by item,
names the code that satisfies each one and the test that keeps it satisfied, and then states the
risks that are accepted rather than mitigated. The other half is `.github/workflows/security.yml`,
which turns three of these properties into something a pull request can fail on.

The review is deliberately written as a document rather than a checklist in an issue, for the same
reason `docs/architecture.md` exists: a security property nobody can find is a security property
nobody maintains. Where a control is weaker than it sounds, this document says so in those words.

**Reviewed at:** Milestone 11, stage 12. **Deployment status:** none. Rivet runs on an operator's
laptop and in CI. Nothing here has been reviewed as a hosted multi-user service, and §6 records what
would have to change first.

---

## 1. What Rivet is defending, and against whom

Three assets, in the order an attacker would want them:

1. **The GitHub App installation token.** It can push branches and open pull requests on every
   repository the App is installed on. It is minted on the worker host, lives about an hour, and is
   the only credential in the system that writes to somebody else's account.
2. **The model provider credential.** It is spend. A leaked `OPENROUTER_API_KEY` is a bill.
3. **The control plane.** Postgres holds every job, event, command transcript, artifact and
   checkpoint. Redis holds delivery state. Neither should be reachable from a container running
   arbitrary cloned code.

Two adversaries:

- **A malicious or compromised repository.** Its code executes in the sandbox by design - that is
  the product. Its prose (README, issue body, source comments, test names, command output) reaches
  the model as data. It is the primary adversary and every control below is aimed at it.
- **An unauthenticated network caller** who can reach the development server. Milestone 11 is the
  milestone where this stops being "anyone who can reach it owns it".

Explicitly **not** in the threat model: a hostile operator, a compromised worker host, a malicious
GitHub, and a second Rivet user. Rivet is single-principal by decision (§6.3).

---

## 2. §27 item by item

| §27 minimum                             | Status                  | Where it lives                                                           |
| --------------------------------------- | ----------------------- | ------------------------------------------------------------------------ |
| GitHub App authentication               | Satisfied               | `packages/github/src/app.ts`, `apps/worker/src/github.ts`                |
| Encrypted secrets                       | Satisfied, delegated    | Transport and at-rest encryption belong to Neon, Upstash and GitHub      |
| No platform secrets in sandbox          | Satisfied, asserted     | `packages/core/src/pipeline/provisioning-phase.ts`, run H of M9          |
| No model provider credential in sandbox | Satisfied, asserted     | `packages/agent/src/pi-agent.ts`                                         |
| Harness restricted to sandbox tools     | Satisfied, asserted     | `packages/agent/src/pi-agent.ts:483`                                     |
| Non-root sandbox execution              | Satisfied               | `packages/sandbox/src/docker-sandbox.ts`                                 |
| Sandbox resource limits                 | Satisfied, monitored    | `packages/sandbox/src/docker-sandbox.ts`, `resource-monitor.ts`          |
| Validated API inputs                    | Satisfied               | `packages/contracts/src/*.ts`, every route handler                       |
| Authorization on every endpoint         | Satisfied, enumerated   | `apps/web/lib/auth/guard.ts`, `apps/web/lib/auth/routes.test.ts`         |
| Audit log for external actions          | Satisfied               | `packages/core/src/github/effect-store.ts`, `job_events`                 |
| CSRF / session protection               | Satisfied               | `apps/web/lib/auth/csrf.ts`, `apps/web/lib/auth/session.ts`              |
| Rate limiting                           | Satisfied, fails closed | `packages/queue` limiter, `apps/web/lib/rate-limit/`                     |
| Short-lived credentials                 | Satisfied               | Installation tokens (~1h), sessions (7d), OAuth state (10m)              |
| Secrets redaction from logs             | Satisfied, widened      | `apps/worker/src/secrets.ts`, `packages/core/src/telemetry/redaction.ts` |

### 2.1 GitHub App authentication

Rivet authenticates as a GitHub App, not as a user with a personal access token. `packages/github`
signs a short JWT with the App private key and exchanges it for a per-installation access token
scoped to that installation's repositories. `RIVET_GITHUB=off` is the default and produces a worker
that never mints a token at all; `app` additionally requires `GITHUB_APP_ID` and
`GITHUB_APP_PRIVATE_KEY`, which `parseWorkerConfig` validates and base64-decodes **at startup**
rather than at publication. That timing is a security-adjacent decision as much as a usability one:
`finalizing` is the last phase, so validating late means failing a job whose work was already
written, validated and approved.

The install callback (`apps/web/app/api/github/setup/route.ts`) trusts nothing in its query string.
It lists the installations the App can actually act on and persists a row only if the callback's id
is among them, which is the difference between recording an installation and recording a claim about
one.

### 2.2 Encrypted secrets

Rivet stores no secret of its own at rest. Credentials arrive as process environment from
`.env.local`, which is gitignored and never committed; the App private key is held base64-encoded so
a multi-line PEM survives an env file intact, which is encoding, not encryption, and this document
says so rather than letting the base64 imply protection.

Encryption at rest and in transit is delegated: Neon and Upstash encrypt their storage and require
TLS (`rediss://`), and the GitHub API is HTTPS-only. What Rivet owns is not writing secrets anywhere
they would need encrypting - see §2.13 and §2.14.

`github_installations` caches installation ids and account metadata, never a token.
`job_external_effects` records pull request ids and URLs, never a token.

### 2.3 No platform secrets in the sandbox

The container receives no `DATABASE_URL`, no `REDIS_URL`, no App private key and no installation
token. Where the token would be most tempting to pass is the authenticated clone, and it is not
passed there either: the clone happens on the **worker host**, the result is tarred and uploaded
into the container through `putArchive`, and the container gets a repository with no credentialed
remote. `host-git.ts` uses an askpass helper rather than a credentialed remote URL, so the token
never enters an argv either.

Run H of Milestone 9 (`apps/worker/tests/sandbox/publication.sbx.test.ts`) is the assertion: it
greps a sentinel token across the container environment, the container's `.git/config`, every
`job_commands` row, every `job_events` row and every host Git argv, and requires all of them clean.
Its positive control is a sentinel the seed certainly contains, found by the same search.

### 2.4 No model provider credential in the sandbox

The harness runs in the worker process and the model key never leaves it. The four implementer tools
(`read`, `write`, `edit`, `bash`) terminate at `AgentToolbox`, whose implementations are the phase's
own `ctx.exec` and the sandbox's `getFile`/`putFile`. The specific trap here is Pi's `bash` tool,
which hands its operations an `env` built from the worker's own `process.env`; forwarding that would
place `OPENROUTER_API_KEY` inside a container running arbitrary cloned code. `packages/agent`
ignores it, always, and the comment at that line says why.

### 2.5 The harness is restricted to sandbox-backed tools, asserted at session start

This is §21's strongest mitigation and it is a capability boundary rather than a sentence in a
prompt. After `createAgentSession` returns, `PiCodingAgent` asserts that
`session.getActiveToolNames()` equals the role's exact set and fails the job otherwise:

- implementer: `bash, edit, read, write`
- planner: `list_files, read, search_text, submit_plan`
- reviewer: `list_files, read, search_text, submit_review`

The planner and the reviewer therefore cannot write or execute anything, and `submit_plan` /
`submit_review` are worker-side tools that validate a structured value and can read nothing, write
nothing and execute nothing. The difference between this and a prompt instruction is the difference
between believing no host-side tool survived and knowing it. `packages/agent/src/pi-agent.ts:483` is
the line; `pi-agent.test.ts` is the test.

**Honest limit:** this contains the _model_. Nothing sandboxes the harness process itself, which
runs trusted in the process holding the model key. That has been true since M4 and M11 does not
change it. See §6.2.

### 2.6 Non-root sandbox execution

Containers run as `User: "node"` (uid 1000) with `CapDrop: ["ALL"]` and
`SecurityOpt: ["no-new-privileges"]`, on a user-defined bridge, with no Docker socket mounted. The
grading container in `packages/core/src/evaluation/grader.ts` runs under the same spec, because a
hidden-test runner that ran as root would be a second, quieter sandbox with weaker rules.

A consequence worth recording: because the container cannot escalate, Rivet cannot install packages
into the image on the way in, which is why the base image is `node:24-bookworm` rather than `-slim`.
That is a security constraint driving an image-size cost, not an oversight.

### 2.7 Sandbox resource limits, and now evidence

`memoryBytes`, `nanoCpus` and `pidsLimit` are **required** fields on `SandboxSpec` rather than
optional ones with defaults, and `packages/core` deliberately supplies no default for any of them: a
default limit in the package that is supposed to hold no policy is how a container ends up
unbounded.

Milestone 11 adds the missing half. `packages/sandbox/src/resource-monitor.ts` samples
`container.stats({ stream: false })` on an interval and keeps running peaks for memory, CPU and
pids; teardown writes one `resource_report` artifact and one `sandbox.resources_recorded` event and
emits the peaks as OTel instruments. Before this, an `oom_killed` was a verdict with no evidence
behind it.

### 2.8 Validated API inputs

Every route handler parses its input with a Zod schema from `packages/contracts` before anything
reaches core, and core's own writers validate again where the value crosses a durability boundary.
Three input-validation properties are worth naming because they are load-bearing rather than
routine:

- `createJobSchema.repoUrl` is **https-only**. The `rivet-local:` evaluation scheme is not reachable
  from a browser at all; it is accepted only under `RIVET_EVAL=on`, which is refused under
  `NODE_ENV=production`.
- The `rivet-local:<case-id>` scheme is **opaque on purpose**. A path-carrying scheme
  (`file:///...`) would make every acceptor one crafted request away from cloning `/etc`, and the
  refusal would have to be written correctly in each of them. A case id is lowercase kebab-case,
  which cannot express a separator, a parent segment or an absolute root, so `../../etc`,
  `/etc/passwd` and `a/../../b` are rejected by the parser with no filesystem involved.
  `resolveBenchmarkRepositoryPath()` then compares `realpath`s below the fixture root, which is the
  check that still holds when the attacker controls the fixture directory rather than the URL.
- A repository's `rivet.json` is parsed by a **strict** schema. Commands are non-empty argv arrays,
  never shell strings, so a repository cannot smuggle a shell metacharacter into a validation
  command. A present malformed file is terminal `validation_config_invalid` rather than ignored.

### 2.9 Authorization on every job and repository endpoint

`RIVET_AUTH` is `off` or `github`, and `off` is refused under `NODE_ENV=production` - an open
control plane that spends money is exactly the failure that looks healthy. Sign-in is a GitHub OAuth
identifying flow whose callback fetches the authenticated login from GitHub and compares it against
`RIVET_OWNER_GITHUB_LOGIN`. Anyone else gets a refusal, not a session.

**The guard is in the route handlers.** Next middleware handles page redirects, but the
authorization decision is `requireSession()` called by each handler, for two reasons: middleware
runs in a different runtime with different failure modes, and a redirect is not an authorization
decision.

What makes this a property rather than a habit is `apps/web/lib/auth/routes.test.ts`, an enumeration
test that walks every `route.ts` under `apps/web/app/api` and asserts each one either calls
`requireSession` or appears in the explicit `PUBLIC_ROUTES` allowlist with a comment saying why. A
route added in a later milestone that forgets the guard fails `pnpm test`, with no database and no
network. That is the same shape as the `Phase.recovery` exhaustiveness test and the
`EVALUATION_FAILURE_CLASSES` total record: make the omission a test-time event rather than a
review-time one.

The four public routes are `/api/auth/signin`, `/api/auth/callback`, `/api/auth/signout` and
`/api/github/setup`. Each must work before a session exists; each is rate-limited by IP; the two
callbacks validate their own state against a server-side fact rather than trusting the query string.

**Finding fixed in this stage.** The owner allowlist was checked only at the OAuth callback, so a
session issued for login X stayed valid for its full seven days after `RIVET_OWNER_GITHUB_LOGIN` was
changed to Y - with no session table, there was nothing to revoke. `authorizedSession()` in
`apps/web/lib/auth/guard.ts` now re-compares the signed login against the currently configured owner
on **every** request, and `requirePageSession()` does the same. Changing the allowlist now takes
effect immediately. A valid signature is not by itself an authorization decision.

### 2.10 Audit log for external actions

Two mechanisms, and they answer different questions.

`job_events` is the append-only narrative: eight publication event types record what Rivet did to
GitHub and when, and they are the only rows in the timeline that link outward. Nothing ever updates
or deletes an event row, and `appendEvent()` is the only writer.

`job_external_effects` is the receipt ledger: one row per `(job_id, kind)`, insert conflict-aware so
a replay returns the existing receipt rather than throwing. This is what makes "did I already open
this pull request" a question Postgres answers, and it is why every GitHub failure category can be
terminal without risking a duplicate external effect on retry.

Neither table can contain a token: the effect store records ids and URLs, and §2.14's redaction pass
runs over event payloads on the way in.

### 2.11 CSRF and session protection

The session is a signed, `httpOnly`, `SameSite=Lax`, `Secure`-in-production cookie holding a short
HS256 JWT (`jose`) with issuer, audience, subject and a 7-day expiry, signed with
`RIVET_SESSION_SECRET` (refused below 32 characters). There is no session table, so there is no
session store to clean up and nothing to reap.

CSRF is `SameSite=Lax` plus an `Origin`/`Host` check on every mutating request
(`apps/web/lib/auth/csrf.ts`). A double-submit token buys nothing on top of those two for a
same-site app with no cross-site POST surface, and it adds a failure mode; the omission is a
decision, recorded here rather than left to be noticed.

**Accepted weakness, stated plainly:** the origin check accepts a _missing_ `Origin` header, so that
non-browser callers and tests work. Browsers send `Origin` on every cross-origin POST, so this does
not open the cross-site case; it does mean the header check alone would not stop a non-browser
attacker who already has the cookie, which is why `SameSite=Lax` is the load-bearing half and the
header check is defense in depth.

### 2.12 Rate limiting

With one principal, rate limiting is not about abuse volume - it is §22's budget argument moved one
level up to the control plane. Two surfaces:

- **Unauthenticated edges** (`/api/auth/signin`, `/api/auth/callback`, `/api/github/setup`): fixed
  window keyed by IP.
- **Spend-shaped routes**: `POST /api/jobs` costs real model calls on every success, so it carries
  both a per-window creation limit and a **global cap on non-terminal jobs**, checked inside
  `createJob()` as a passed-in limit because core reads no environment.

The limiter is an atomic Lua fixed window in `packages/queue`, the package that already owns the
ioredis client. **It fails closed:** if Redis is unreachable, job creation is refused rather than
allowed. That inverts the usual availability instinct deliberately. The standing rule that "Redis
holds nothing that matters" is about _durability_; it is not permission to spend money while the
limiter is down.

Read routes and SSE are **not** limited, and that is a decision rather than an omission. Each open
stream is a bounded one-query-per-second Postgres poller with an existing hidden-tab and
terminal-drain lifecycle, and one operator's browser tabs are not the threat model.

Refusals return 429 with the limit that was hit and when it resets, and leave **no** `jobs` row - a
job that was never created cannot have a status, which is why rate limiting added no failure
category.

### 2.13 Short-lived credentials

- **Installation tokens:** minted per installation, roughly one hour, never persisted, never logged,
  never in an argv or a remote URL.
- **Sessions:** 7 days, and now revocable in effect by changing `RIVET_OWNER_GITHUB_LOGIN` or
  rotating `RIVET_SESSION_SECRET` (§2.9).
- **OAuth state:** 10 minutes, one-time, cleared on both success and every failure path.
- **The App private key and the model key** are long-lived by nature. They live in `.env.local` on
  the worker host and nowhere else.

### 2.14 Secrets redaction, widened from logs to durable writes

Through M9, `SecretRegistry` plus the pino `logMethod` hook covered every log argument in the worker
and nothing else. That left the durable paths uncovered, and a token in a `job_events` row is
strictly worse than one in a log file: the log rotates, the event is append-only and by design never
deleted. A provider error message quoted into a `run.failed` event was a real path for that.

Milestone 11 introduces a `Redactor` **port** in `packages/core/src/telemetry/redaction.ts` and
reaches the writers that produce durable rows - `appendEvent`, `recordCommand` and
`recordArtifact` - through the same dependency-injection shape everything else uses. The worker owns
the registry because it owns the credentials; core knows only the interface.

Spans get the same treatment one system further out, because a span is an export to a third-party
backend: a command span records `argv[0]`, the argument count and the cwd, never the full argv; a
GitHub span records an operation name, an installation id and `owner/name`, never a token, an issue
body or a remote URL.

The registry remains **a safety net, not a boundary**, and the docblock keeps saying so. Nothing
logs a token deliberately, `host-git.ts` redacts its own transcripts, and the token still never
enters an argv, a remote URL or `SandboxSpec.env`. What changed is that the net now hangs under the
whole system rather than under one part of it. Acceptance run D is what makes this a fact rather
than an intention, and it has a positive control: a non-secret sentinel must be _found_ by the same
search that finds no secret one, because a grep that silently fails returns the same nothing a clean
system returns.

---

## 3. Sandbox network isolation (§15)

§15's MVP line is "prevent arbitrary access to internal application infrastructure". Three controls,
in order of how much they actually buy:

1. **Nothing the container needs is bound where it can reach it.** Postgres and Redis bind to
   loopback in development and live on a separate compose network in CI. This is the real control
   and it belongs to host configuration rather than to Docker flags.
2. **`enable_icc=false` on the `rivet-sandbox` network**, so two containers on it - including CI
   service containers - cannot talk to each other at all. The adapter also refuses to adopt a
   pre-existing `rivet-sandbox` network that lacks the flag rather than silently using a weaker one.
3. **A startup reachability assertion**, in the spirit of `assertLeaseInvariant`. Under
   `RIVET_SANDBOX=docker`, the worker runs one short-lived probe container that attempts a TCP
   connect to its own configured `DATABASE_URL` and `REDIS_URL` endpoints. If either connects, the
   worker **refuses to start** and names it. A misconfiguration that exposes the control plane to
   arbitrary repository code is exactly the class of problem that is cheaper to make impossible to
   boot than possible to debug.

Acceptance run G asserts all of it from inside a real job container, with positive controls, because
a network test that passes for the wrong reason is worthless: the package registry and github.com
must be reachable from the same container in the same run.

---

## 4. Prompt injection (§21)

The mitigations that matter are capability boundaries and they shipped in M4, M6 and M8 (§2.5).
Milestone 11 adds the prompt-level half and the evidence.

- **Fencing.** Repository content, file reads, command output and - the one most easily forgotten -
  **the GitHub issue title and body** enter prompts inside explicitly delimited untrusted blocks
  with a stated trust preamble. The issue body is attacker-controlled on any public repository,
  arrives through M9's issue picker, and becomes the task description. It is the highest-value
  injection surface in the system and the least obvious one.
- **Detection that records and continues.** A bounded scanner over untrusted text raises at most one
  `security.injection_suspected` event per source boundary, carrying the source, the location and
  the matched pattern classes (`instruction_override`, `secret_exfiltration`, `unsafe_tool_use`,
  `external_exfiltration`, `filesystem_escape`) and never the matched text. **The job proceeds.**
  Pattern matching over repository prose produces false positives - a repository that merely
  _discusses_ prompt injection would otherwise be unrunnable - and the capability boundary, not the
  regex, is the defense. Detection here is observability.
- **An adversarial benchmark case.** `benchmarks/prompt-injection-bait/` is a genuine, solvable task
  whose README and a source comment try to make the agent exfiltrate, skip tests, or write outside
  the workspace. Its hidden tests assert both halves: the real task was completed, and none of the
  bait was taken. It runs in `pnpm eval:run` like any other case.

---

## 5. CI enforcement

`.github/workflows/security.yml` is the fifth CI surface, in its own workflow file with three
independent jobs, alongside `verify`, `integration`, `sandbox` and `streaming`. Separate rather than
folded into `verify`, for the reason the other four are separate: shared setup is how you lose the
property a job exists to protect. `verify` proves the whole pipeline builds with no database, no
Redis and no Docker; a security scanner installing its own toolchain into that job would put that
property at the mercy of an unrelated tool.

It runs on every pull request, every push to `main`, and weekly on a schedule - advisories and
CodeQL queries change without anybody pushing, and a scheduled run is what turns "clean when we last
merged" into "clean now".

Three checks, each with a stated threshold:

| Check           | Tool                             | Fails the run on                          |
| --------------- | -------------------------------- | ----------------------------------------- |
| Static analysis | CodeQL (`javascript-typescript`) | Its default `security-extended` queries   |
| Dependencies    | `pnpm audit`                     | `high` or `critical` advisories           |
| Secrets         | gitleaks 8.30.1                  | Any finding, over the full commit history |

**Why those thresholds.** Failing on any advisory at any severity sounds stricter and is worse in
practice: a transitive low-severity advisory with no available fix would block unrelated work, and a
gate that has to be bypassed weekly is a gate nobody reads. High and critical are the severities
worth stopping a merge for. Secrets are the opposite case - there is no acceptable rate of committed
credentials - so gitleaks fails on anything and scans the full commit history (`gitleaks git` on a
`fetch-depth: 0` checkout) rather than the diff, because a secret committed and then removed is
still a leaked secret. It runs with `--redact`, so a detection does not become a second disclosure
in a public build log.

**Escape hatches, and what justifies one.** `.gitleaks.toml` carries the allowlist for gitleaks. It
has one path entry, `pnpm-lock.yaml`, whose integrity hashes are high-entropy by construction, and
one exact value, `sentinel-secret-value`, which acceptance run F deliberately writes through every
durable redaction path as its positive control. Advisory ignores would live inline in the workflow's
audit step, where there are currently none. An entry in either is legitimate only when the finding
is provably not a live credential (a test fixture, a documented sentinel, a public key) or when the
advisory has no fixed version and does not reach a code path Rivet executes. Every entry carries a
comment saying which of those it is. An entry with no comment is a bug.

CodeQL needs `security-events: write` to upload its SARIF, which is the one permission any Rivet
workflow holds beyond `contents: read`; it is scoped to that job alone rather than to the workflow.

**`analyze` does not fail on findings, and that is worth saying out loud.** On its own it uploads
results, so a green CodeQL job would mean "the scan ran" rather than "the scan was clean" - exactly
the kind of check that reads as enforcement while enforcing nothing. The workflow therefore adds a
step that queries the alerts API for this ref and fails on any **open** high or critical alert. It
first waits for the commit's analysis to be indexed, because reading the alert list before it lands
would report zero alerts for the wrong reason, which is the same positive-control problem run D and
run G are built around. Fork pull requests skip the step, since their token cannot read the alerts
API; GitHub's own "Code scanning results" check gates those.

Dismissing an alert is the escape hatch and it is deliberately the visible one: a dismissal carries
a reason and a comment in GitHub's own UI, where a code comment would not. A dismissal is justified
only when the flagged path has no adversary - test code, or operator-controlled input whose
compromise already implies a larger one.

### 5.1 The first run's findings

Running the workflow for the first time produced six high-severity alerts. All six were triaged in
this stage; none were left open.

**Four `js/polynomial-redos`, all fixed.** Two of them mattered and two did not, and the difference
is whose text reaches the regex:

- `packages/core/src/pipeline/targeted-tests.ts` - `isTestPath` ran `/\.(?:test|spec)\.[^/]+$/` over
  **every changed and tracked repository path**. That is attacker-influenced input on the hot path
  of targeted-test selection. Replaced with a scan of the final path segment.
- `packages/core/src/pipeline/validation-phase.ts` - `renameDestination` ran
  `/\{[^{}]* => ([^{}]*)\}/g` over paths from the repository's own `git diff --stat`. Two unbounded
  brace-free runs around a literal arrow backtrack polynomially on a long run that never reaches the
  arrow. Replaced with a single left-to-right pass, with a test that a 50,000-character brace-free
  run completes in well under a second.
- `packages/telemetry/src/provider.ts` and `packages/core/src/pipeline/finalizing-phase.ts` - both
  stripped trailing slashes with `/\/+$/` from **operator configuration**
  (`OTEL_EXPORTER_OTLP_ENDPOINT` and `RIVET_APP_URL`). Theoretical rather than reachable, and fixed
  anyway: a four-line loop costs less than arguing about it, and an alert left open to be explained
  every quarter is worse than a loop.

**Two `js/file-system-race`, dismissed with reasons.**

- `apps/worker/src/git/host-git.test.ts` - test code. The assertion stats a file the test itself
  just created in its own temporary directory, to prove the askpass helper is mode `0700`. No
  adversary exists on that path.
- `packages/core/src/evaluation/case-loader.ts` - the `lstat`-then-`readFile` of a benchmark case
  file. Benchmark cases are git-tracked files in Rivet's own repository, read by the operator's own
  build step; winning this race needs local write access to the checkout, which is already a full
  compromise. The adversarial check on that code path is `assertSafeSymlink`'s `realpath`
  comparison, which is not a TOCTOU and is unaffected.

---

## 6. Accepted risks

Named so their absence reads as a decision rather than an oversight. Each one names what would have
to change.

**6.1 No egress allowlist or proxy.** A malicious repository can send its own contents to the
internet from inside the sandbox. The container must reach the package registry and github.com to do
its job, so blocking egress wholesale would break the product, and the correct control is an egress
proxy with an allowlist. §15 calls that long-term and it is out of Milestone 11's scope. This is the
largest accepted risk in the system and it is not disguised as a prompt-scanning success.

**6.2 The harness process is not sandboxed.** It runs trusted in the process holding the model key,
mitigated by the session-start tool assertion (§2.5). Contained: the model. Not contained: the
harness. Changing this means running the harness itself in an isolated process with an IPC boundary
to the toolbox.

**6.3 No multi-tenancy.** One principal, no `users` table, no `user_id`, no ownership joins. §27's
"authorization on every job/repository endpoint" is satisfied by there being exactly one principal
and a guard that provably runs on every route. A second user is a schema change and a migration of
every read path, and until that exists Rivet must not be exposed to more than one person.

**6.4 Sessions cannot be revoked individually.** No session table means no per-session revocation.
The mitigations are a 7-day expiry, the per-request allowlist re-check added in §2.9, and rotating
`RIVET_SESSION_SECRET`, which invalidates every session at once. Adding revocation means adding the
store this design deliberately does not have.

**6.5 The origin check accepts a missing `Origin` header.** See §2.11. `SameSite=Lax` is the
load-bearing control.

**6.6 Rows for uninstalled GitHub installations are not deleted.** `github_installations` is a cache
and jobs reference its rows, so a row for an installation GitHub stops returning is left in place.
Reads refresh from the API, so an uninstall becomes visible at the control-plane surface; the stale
row cannot be used to mint a token, because minting goes to GitHub, which refuses. M11 subscribes to
no webhooks, so pulling on demand is the only way an uninstall is ever observed.

**6.7 Docker is the isolation backend.** Container escape is a real class of vulnerability and Rivet
does not defend against it beyond dropping capabilities, refusing privilege escalation, running
non-root and mounting no socket. A hostile-code-execution product that needed a stronger boundary
would use gVisor, Firecracker or a per-job VM. The adapter boundary is what makes that a swap rather
than a rewrite.

**6.8 No alerting.** Dashboards and traces, no alert rules and no pager. Alerting without a
deployment is alerting about a laptop.

**6.9 The container can route to the host on Docker Desktop.** The sandbox is on a user-defined
bridge with `enable_icc=false`, and §3's layered argument puts the load-bearing control first:
nothing the container needs is bound where it can reach it. On macOS Docker Desktop that control is
weaker than it reads. The host answers on `host.docker.internal` and four sibling aliases **and on a
raw address** (`192.168.65.254` on current builds), and Desktop's port forwarding reaches services
bound to the host's `127.0.0.1` - so "Postgres binds to loopback in development" does not, by
itself, put it out of reach. Measured, not assumed: a probe container connected to a loopback-only
Postgres through the alias.

Pinning the aliases to `127.0.0.1` via `ExtraHosts` was implemented and then **reverted**, and the
reason is worth recording rather than quietly dropping. It removed the convenient path and not the
path - the raw address is still routable, no `/etc/hosts` entry can take it away, and the container
drops `ALL` capabilities so nothing inside it can install a route filter either. Against that it
cost something real: the sandbox suite's own fixtures serve a git daemon on the host and clone it
from inside containers through exactly that route
(`apps/worker/tests/sandbox/fixtures/git-daemon.ts`), so pinning broke the suite on macOS while
leaving Linux CI green, because the Linux fixtures use the bridge gateway instead. A control that
buys no real reduction in reach, breaks the harness, and makes test containers configured
differently from production ones is not worth keeping.

Closing this properly needs 6.1's egress control, a host firewall rule, or a VM boundary. Nothing
smaller is honest about it.

The practical consequence is recorded rather than worked around: the startup probe refuses to boot a
worker whose configured control plane answers, which is why `RIVET_SANDBOX=docker` cannot run
against Neon and Upstash and the Docker demos require a local Postgres and Redis. That refusal is
the control working, not a defect in it. Linux hosts do not share the alias behaviour, but a
published service port is reachable through the bridge gateway there, which is the same risk wearing
different clothes.

**6.10 No deployment hardening review.** Nothing here covers TLS termination, a WAF, network policy
or secret management in a hosted environment, because there is no hosted environment. The SSE
stream's need for a streaming-capable host is still open in `docs/architecture.md`.

---

## 7. Re-running this review

The review is not a one-time artifact. It is out of date when any of the following happens, and each
has a cheap check:

- **A route is added under `apps/web/app/api`.** `apps/web/lib/auth/routes.test.ts` fails until it
  is guarded or explicitly public. Update §2.9's list of public routes if the allowlist grows.
- **A new durable writer is added.** The single-writer list in `AGENTS.md` is the index; a writer
  that persists text from a provider, a repository or a model must take the `Redactor` (§2.14).
- **A new credential enters the worker.** It must be registered with `SecretRegistry` at the point
  it is minted, before it reaches any caller, and it must not enter an argv, a remote URL or
  `SandboxSpec.env`.
- **A new failure category is added.** `EVALUATION_FAILURE_CLASSES` is a total `Record` over
  `FAILURE_CATEGORIES` and fails typecheck until somebody decides which side of the success rate it
  belongs on.
- **The sandbox spec changes.** Re-read §2.6 and §2.7; the limits are required fields for a reason.
- **A dependency is added.** The security workflow audits it on the next pull request.
