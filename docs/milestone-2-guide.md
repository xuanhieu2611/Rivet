# Milestone 2: a guided tour

This is a learning document. `docs/architecture.md` describes **what Rivet is today**. This guide
explains **what Milestone 2 added, how the pieces fit together, and why the implementation made its
tradeoffs**.

Read this if you want to answer questions such as:

- Why does core define a sandbox interface instead of importing Docker directly?
- Why is a command that exits with code 1 sometimes a failure and sometimes not?
- Why does a command timeout destroy the entire container?
- How are stdout and stderr captured without consuming unbounded worker memory?
- Who removes a container after cancellation, a timeout, or `kill -9`?
- What does Rivet record so that a run can later be reproduced?

Everything here is checked against the code as of commit `46a1397`. Where `plan.md` and the code
disagree, this guide follows the code and calls out the difference when it matters.

---

## Part 0. What changed

Milestone 1 built a reliable execution system around seven simulated phases. Milestone 2 kept that
execution system and replaced two sleeps with real work:

```text
provisioning  -> real: create container, clone, resolve commit, install dependencies
analyzing     -> simulated
planning      -> simulated
implementing  -> simulated
testing       -> real: discover and run the repository's baseline test script
reviewing     -> simulated
finalizing    -> simulated
```

The milestone's demo checkpoint from PRD section 31 now works:

```text
submit repository -> sandbox starts -> repository cloned -> dependencies installed -> tests run
```

No model or coding agent exists yet. Rivet can establish a real repository environment and record
its baseline, but it cannot inspect or modify the code intelligently. Those capabilities arrive in
later milestones.

The central idea is:

> **A job attempt owns one disposable container, and every observable command becomes durable
> evidence in Postgres.**

That extends Milestone 1's source-of-truth rule. Redis still only delivers job IDs. Docker holds
ephemeral execution state. Postgres holds the durable facts about what happened.

---

## Part 1. A reading path

Read these files in this order. The sequence moves from the abstraction to the adapter, then through
the two real phase bodies and finally into lifecycle ownership.

| #   | File                                               | What it teaches                                 |
| --- | -------------------------------------------------- | ----------------------------------------------- |
| 1   | `packages/core/src/sandbox/sandbox.ts`             | The sandbox port and its contracts              |
| 2   | `packages/sandbox/src/docker-sandbox.ts`           | How Docker implements that port                 |
| 3   | `packages/sandbox/src/stream.ts`                   | Docker stream framing and bounded output        |
| 4   | `packages/core/src/pipeline/phase-context.ts`      | How commands and events become database records |
| 5   | `packages/core/src/pipeline/provisioning-phase.ts` | Clone, install, and environment fingerprinting  |
| 6   | `packages/core/src/pipeline/baseline-phase.ts`     | Why a red baseline does not fail a job          |
| 7   | `apps/worker/src/processor.ts`                     | Who owns and destroys the container             |
| 8   | `apps/worker/src/sweeper.ts`                       | How leaked containers are reconciled            |
| 9   | `apps/worker/src/config.ts`                        | Runtime policy and resource limits              |
| 10  | `apps/worker/tests/sandbox/*.sbx.test.ts`          | The claims proved against a real daemon         |

Then run the sandbox suite:

```bash
pnpm test:sandbox
```

It requires local Postgres, Redis, and Docker. The ordinary unit suite remains deliberately free of
all three:

```bash
pnpm test
```

---

## Part 2. The architecture added by Milestone 2

### 2.1 Port and adapter: core knows about sandboxes, not Docker

The PRD requires isolated execution, but the domain does not need to know about Docker concepts such
as images, networks, stream multiplexing, or container inspection.

`packages/core` therefore declares a small port:

```ts
interface SandboxProvider {
  create(spec: SandboxSpec, signal: AbortSignal): Promise<Sandbox>;
  reap(jobIsLive: (jobId: string) => Promise<boolean>): Promise<string[]>;
}

interface Sandbox {
  readonly id: string;
  exec(request: ExecRequest): Promise<ExecResult>;
  destroy(): Promise<void>;
}
```

`packages/sandbox` supplies two adapters:

- `DockerSandboxProvider` for real execution
- `FakeSandboxProvider` for deterministic unit tests

This is the same shape as `JobQueue` in core and its BullMQ and in-memory adapters.

**Why this boundary matters:**

1. `packages/core` has no `dockerode` dependency.
2. Unit tests can exercise real phase orchestration with a scripted fake.
3. `pnpm build` and `pnpm test` still work without a Docker daemon.
4. A future sandbox implementation can replace Docker without rewriting provisioning or testing.
5. Docker-specific failures are translated into domain errors at one boundary.

Importing `@rivet/sandbox` also does not contact Docker. The dockerode client is constructed lazily,
and dockerode opens the socket only when a request is made. A missing daemon therefore fails a job
with `sandbox_unavailable`; it does not prevent the worker from starting and continuing to sweep or
report failures.

### 2.2 Required limits, not optional defaults

Every `SandboxSpec` requires:

- image
- work directory
- memory ceiling
- CPU quota
- PID ceiling
- environment allowlist
- labels

The limits are mandatory because an omitted limit would create the exact unbounded environment the
sandbox is meant to prevent. Defaults belong in `apps/worker/src/config.ts`, where deployment policy
is parsed. Core only receives already-decided values.

The worker converts human-facing configuration into Docker's units at startup:

```text
SANDBOX_MEMORY_MB -> bytes
SANDBOX_CPUS      -> NanoCpus, billionths of one CPU
```

This preserves another core invariant: `packages/core` reads no `process.env`.

### 2.3 One container per attempt

A real job attempt gets one long-lived container whose foreground command is:

```text
sleep infinity
```

Commands are then executed inside it with Docker exec.

This is necessary because phases share a filesystem. Provisioning clones and installs dependencies;
testing must see that same working tree and `node_modules`. A container per command would throw away
the state after every command.

A reclaimed or retried job gets a fresh attempt and therefore a fresh container. Milestone 2 has no
checkpoint capable of resuming into an old container. Starting over is deliberate and keeps crash
recovery simple and repeatable.

---

## Part 3. What the Docker sandbox actually enforces

### 3.1 Process and resource restrictions

The container is created with:

| Setting              | Implementation               | Reason                                     |
| -------------------- | ---------------------------- | ------------------------------------------ |
| Non-root             | `User: "node"`               | Repository code runs as uid 1000           |
| Memory               | `Memory`                     | Kernel-enforced cgroup ceiling             |
| No swap escape       | `MemorySwap` equals `Memory` | The memory ceiling remains a real ceiling  |
| CPU                  | `NanoCpus`                   | Limits available CPU time                  |
| Processes            | `PidsLimit`                  | Bounds process creation and fork bombs     |
| Capabilities         | `CapDrop: ["ALL"]`           | Removes ambient Linux capabilities         |
| Privilege escalation | `no-new-privileges`          | Prevents gaining privileges through exec   |
| Cleanup ownership    | `AutoRemove: false`          | Rivet can inspect OOM state before removal |

The sandbox suite proves uid 1000, inability to use `sudo`, inability to write under `/etc`, memory
kills, and PID exhaustion. The CPU quota is passed to Docker, but the current sandbox suite does not
contain a timing-based test that demonstrates throttling. This is a small gap between the plan's
"each limit has a test that trips it" wording and the current executable coverage.

### 3.2 Why the work directory is under `/home/node`

The default is:

```text
/home/node/workspace
```

It is not `/workspace` because Docker creates a missing `WorkingDir` as root and does not change its
owner to the configured container user. A uid-1000 process would then fail to clone into it.

The adapter instead starts without a Docker `WorkingDir` and runs:

```text
mkdir -p /home/node/workspace
```

as the container's own user. This makes the real requirement explicit: the parent directory must
already be writable by uid 1000.

### 3.3 Image choice and reproducibility

The image is pinned by digest:

```text
node@sha256:934240a162082fd8b8a2f90cd5114446443f1eba1c5378f6687167ca405e6584
```

The digest prevents an upstream tag change from silently changing Rivet's environment. It is a
multi-architecture OCI index, so the same pin resolves on Apple silicon and GitHub Actions' amd64
hosts.

The project originally considered `node:24-bookworm-slim`. The slim image has no `git`, so cloning
would fail and be misclassified as a repository problem. The full Bookworm image is larger, but it
contains the tool provisioning requires. A purpose-built `rivet-sandbox` image is deferred until the
coding agent itself needs to be installed.

### 3.4 Network isolation is limited

Containers use the user-defined `rivet-sandbox` bridge instead of Docker's default bridge. This is
useful organization, but it is not a hardened security boundary. The container can still access the
internet and may reach the host.

Milestone 2 does not include:

- egress allowlisting
- an egress proxy
- user namespace remapping
- a custom seccomp profile beyond Docker's default
- gVisor, Kata, or Firecracker isolation
- short-lived repository credentials

The environment allowlist is empty in this milestone, so no platform credential is intentionally
passed into the container. Private repository access arrives with GitHub integration later.

---

## Part 4. Command execution and durable evidence

### 4.1 Commands are argv arrays

Every command is represented as `string[]`, never as one shell string:

```ts
["git", "clone", "--depth", "1", "--branch", branch, repoUrl, repoDir];
```

This avoids adding a shell quoting layer. Arguments containing spaces remain arguments instead of
becoming syntax. It also means the stored `argv` is an exact structured description of what Docker
executed.

A repository test script still works because Rivet invokes the package manager, such as
`["npm", "run", "test"]`, and the package manager handles its own script.

### 4.2 A non-zero exit is a result, not an exception

`Sandbox.exec()` returns `ExecResult` for normal process completion, including non-zero exits:

```ts
interface ExecResult {
  exitCode: number | null;
  stdout: string;
  stderr: string;
  truncated: boolean;
  timedOut: boolean;
  oomKilled: boolean;
  durationMs: number;
}
```

This is one of the most important decisions in the milestone. The sandbox cannot know what an exit
code means:

```text
git clone exits 1     -> provisioning failed
npm install exits 1   -> provisioning failed
baseline test exits 1 -> repository was already red; job continues
```

Meaning belongs to the phase that chose the command. The adapter reports mechanics; domain
orchestration assigns semantics.

`exitCode` is `null` when Rivet killed the command before it exited, such as on timeout, abort, or
OOM. The additional flags explain why.

### 4.3 Why a command timeout kills the container

Docker exposes an API to create and inspect an exec, but not a reliable API to kill only that exec.
When a command times out or the job's abort signal fires, the adapter sends `SIGKILL` to the entire
container.

That sounds broad, but it matches the ownership model:

- the container belongs to one job attempt
- a timed-out command may have left child processes behind
- the attempt is already going to fail or stop
- no later phase should trust the environment after a forced interruption

Killing the disposable container is therefore both the reliable mechanism and the safer semantic
choice.

### 4.4 Separating stdout and stderr

Docker exec without a TTY returns multiplexed frames:

```text
byte 0     stream identifier
bytes 1-3  padding
bytes 4-7  payload length, big-endian
bytes 8..  payload
```

`DockerStreamDemuxer` reconstructs stdout and stderr even when network chunks split a frame header
or payload at arbitrary boundaries. TTY mode is deliberately disabled because a pseudo-terminal
merges both streams irreversibly.

The parser is pure and has unit tests for interleaving, split headers, and split payloads. This is a
good example of isolating protocol parsing from I/O so subtle edge cases can be tested without a
Docker daemon.

### 4.5 Bounded output with useful truncation

A command can print gigabytes. Keeping everything and truncating after completion would still
consume gigabytes of worker memory.

`CappedOutput` bounds memory while the stream arrives. It keeps:

- the beginning, where command context usually appears
- the end, where failure summaries usually appear
- the count of all bytes seen

The middle is replaced with an explicit marker:

```text
... 360 bytes elided ...
```

Cuts are adjusted to UTF-8 boundaries, so Rivet does not invent replacement characters by slicing a
multi-byte character in half.

### 4.6 Why commands have their own table

Milestone 2 adds append-only `job_commands`:

```text
id, job_id, phase, argv, cwd, exit_code, duration_ms,
stdout, stderr, truncated, timed_out, oom_killed, created_at
```

The timeline receives only a compact `command.completed` event containing metadata and the command
ID. The transcript stays in `job_commands`.

This split exists because `job_events` is read in full for the timeline. An install transcript is
large and should only be fetched when someone asks to inspect it.

`recordCommand()` is the only writer of `job_commands`. In `PhaseContext.exec()`, the command row
and the event pointing at it are inserted in the same database transaction. The system cannot commit
a `command.completed` event whose `commandId` resolves to nothing.

---

## Part 5. How a simulated pipeline gained real phase bodies

Milestone 1's runner already accepted its dependencies as arguments. Milestone 2 extends each phase
with an optional body:

```ts
interface Phase {
  status: JobStatus;
  label: string;
  durationMs: number;
  run?: (ctx: PhaseContext) => Promise<void>;
}
```

The runner's decision is intentionally small:

```text
phase has run -> execute real body
otherwise     -> sleep for simulated duration
```

`simulatedPipeline()` returns seven sleeps. `buildPipeline(options)` returns the same statuses in
the same order, but gives `provisioning` and `testing` real bodies.

Both pipelines are checked against the transition guard table. Real work therefore cannot introduce
a status sequence the simulated pipeline never proved legal.

### 5.1 Why `PhaseContext` carries effects

A phase needs to execute a command, append an event, and record provisioning facts. It could import
database services directly, but then a unit test of the phase would require Postgres.

Instead, `PhaseContext` supplies effects:

```text
exec(...)
event(...)
recordProvisioning(...)
```

The phase becomes orchestration only: choose a command, inspect its result, and decide what it
means. `createPhaseContextFactory()` is the one place that wires those effects to Docker and
Postgres.

This preserves the no-infrastructure unit suite while still testing the real provisioning and
baseline algorithms.

### 5.2 The sandbox holder

The provisioning phase creates the sandbox, but the processor owns its lifetime. A `SandboxHolder`
connects those responsibilities:

1. provisioning calls `provider.create()`
2. it puts the handle in the holder immediately
3. later commands require the sandbox from the holder
4. the processor's `finally` destroys whatever the holder contains

The handle is stored before even writing `sandbox.created`. From that line onward, any failure has a
cleanup owner.

This placement is essential because the processor can abandon a phase promise that ignores its abort
signal. Cleanup cannot live inside the promise that may never return.

---

## Part 6. Provisioning, step by step

A successful provisioning phase performs this sequence:

```text
1. create container
2. record sandbox.created and jobs.sandbox_id
3. git clone --depth 1 --branch <baseBranch> --single-branch
4. git rev-parse HEAD
5. record jobs.base_commit_sha and repo.cloned
6. list the repository root
7. detect package manager
8. install dependencies
9. collect environment fingerprint
10. record deps.installed
```

Every command is recorded even when a later check turns its result into an error.

### 6.1 Shallow clone and exact commit

The input branch is cloned at depth 1 because this milestone needs a working tree, not repository
history. `git rev-parse HEAD` records the actual resolved SHA in `base_commit_sha`.

The URL plus branch describes intent. The SHA describes the exact source Rivet executed. This is the
first half of reproducibility.

Private repositories are unsupported. There are no credentials in the sandbox, so a private URL,
missing repository, or missing branch becomes terminal `repo_unavailable`.

### 6.2 Package-manager detection

Detection is lockfile-driven:

| File                                   | Install command                           |
| -------------------------------------- | ----------------------------------------- |
| `pnpm-lock.yaml`                       | `corepack pnpm install --frozen-lockfile` |
| `yarn.lock`                            | `corepack yarn install --immutable`       |
| `package-lock.json`                    | `npm ci`                                  |
| `bun.lock` or `bun.lockb`              | `bun install --frozen-lockfile`           |
| no lockfile, but `package.json` exists | `npm install --no-audit --no-fund`        |

A repository without a root `package.json` is `unsupported_project`.

The manifest-only npm path is intentionally less reproducible because `npm ci` requires a lockfile.
The environment fingerprint records that the lockfile was absent rather than pretending otherwise.

`pnpm` and `yarn` are invoked through Corepack with:

```text
COREPACK_ENABLE_DOWNLOAD_PROMPT=0
```

Without it, Corepack can wait for interactive confirmation inside a container with no terminal until
the install timeout expires.

Bun detection exists, but the pinned Node image does not install Bun. A Bun repository will
therefore currently reach `dependency_install_failed`. A future purpose-built image should align the
advertised project-manager support with the tools actually installed.

### 6.3 Environment fingerprint

After installation, Rivet records:

- image digest
- Node version
- package manager and version
- lockfile name and SHA-256, when present
- resolved commit SHA
- repository URL and branch
- memory, CPU, and PID limits
- recording time

The fingerprint is best effort. Failure to read a tool version does not throw away a successfully
provisioned environment; that field becomes `null`.

This data supports the PRD's reproducibility goal. A future evaluation can explain not merely that a
test passed, but which source, image, package manager, dependency lock, and limits produced the
result.

---

## Part 7. Baseline testing, and the counterintuitive rule

The testing phase establishes repository health before Rivet changes anything:

```text
1. list repository root and detect package manager again
2. read package.json inside the sandbox
3. find scripts.test
4. run the package manager's test command
5. record baseline as passed, failed, or skipped
```

It reads inside the sandbox because the host never mounts or directly reads the cloned tree.

### 7.1 A red baseline is not a failed job

This is the most important product rule in Milestone 2:

> **A test process exiting non-zero records `baseline: failed` and the job continues.**

The baseline asks whether the repository was healthy before an agent touched it. If Rivet failed the
job here, it could not work on repositories with pre-existing failures and later phases might
incorrectly attribute those failures to the agent.

The event distinguishes three facts:

| Baseline  | Meaning                                   |
| --------- | ----------------------------------------- |
| `passed`  | A test script ran and exited 0            |
| `failed`  | A test script ran and exited non-zero     |
| `skipped` | No runnable baseline could be established |

Skipped includes no `test` script, unreadable manifest, invalid JSON, or an unreadable repository
listing. The timeline records the reason.

### 7.2 What does fail testing

A command timeout or OOM does fail the job. Those are facts about the execution environment and its
limits, not evidence that the repository's tests are red.

This gives a useful semantic separation:

```text
exit 1       -> repository fact
command kill -> sandbox failure
```

The baseline has its own 300-second default timeout. A four-minute suite is slow, but not
necessarily hung. Clone, install, ordinary commands, and baseline each have separate budgets because
they have different expected runtimes.

Typecheck, lint, custom setup commands, and repository-specific validation are deliberately deferred
to Milestone 7.

---

## Part 8. Lifecycle and cleanup

### 8.1 The normal cleanup path

The processor destroys the sandbox in `finally`, before stopping the heartbeat:

```text
try
  run pipeline
catch
  classify and persist outcome
finally
  destroy sandbox
  optionally append sandbox.destroyed
  stop heartbeat
  release run registry entry
```

Keeping the heartbeat alive during removal prevents the lease from expiring while a loaded Docker
host takes time to delete the container.

The same `finally` covers:

- completion
- terminal failure
- cancellation
- whole-job timeout
- lease loss
- graceful worker shutdown

On lease loss, the old worker may not write an event because another worker owns the job. It still
must destroy its own container. Database write authority and local resource ownership are separate
obligations.

`destroy()` is idempotent and never throws. Cleanup commonly runs while another error is already
being handled, so a removal failure must not mask the original cause. It is logged, and the reaper
is the backstop.

### 8.2 Why `kill -9` needs a reaper

`kill -9`, process crashes, and host failures skip JavaScript `finally` blocks. The container can
outlive the process that knew its ID.

The Docker adapter stamps every container with:

```text
rivet.job-id
rivet.worker-id
rivet.created-at
```

During the existing sweep, the reaper lists containers with Rivet's job label and asks Postgres
whether each job still has a live, unexpired lease. After a grace period, it removes containers
whose jobs are no longer live.

This creates three reconciliation loops:

| Durable authority | Ephemeral system reconciled | Mechanism                      |
| ----------------- | --------------------------- | ------------------------------ |
| Postgres          | worker process              | lease expiry and reclaim       |
| Postgres          | Redis                       | orphaned queued-job re-enqueue |
| Postgres          | Docker                      | sandbox reaper                 |

The grace period protects a newly-created container whose worker has not yet recorded all of its
facts.

The reaper is conservative by job ID. If a live job has a leaked container from an earlier attempt,
the old container is spared until the job becomes terminal because Docker labels cannot prove which
attempt is current. Keeping one extra container temporarily is safer than deleting the current one.

---

## Part 9. Failure taxonomy

Sandbox errors extend the same `RetryableJobError` and `TerminalJobError` hierarchy introduced in
Milestone 1. The processor's existing `classify()` and one retry-policy switch remain authoritative.

| Category                    | Class                    | Reason                                              |
| --------------------------- | ------------------------ | --------------------------------------------------- |
| `sandbox_unavailable`       | Retryable                | Docker may be restarting or temporarily unreachable |
| `sandbox_create_failed`     | Retryable                | Pull/create failures are generally host problems    |
| `repo_unavailable`          | Terminal                 | Usually missing, private, or missing branch         |
| `unsupported_project`       | Terminal                 | Retrying does not add a root Node manifest          |
| `dependency_install_failed` | Terminal                 | Usually deterministic repository setup failure      |
| `command_timed_out`         | Terminal                 | Same command and limit will likely repeat           |
| `oom_killed`                | Terminal                 | Same command and memory ceiling will likely repeat  |
| `sandbox_leaked`            | Operational log category | Reaper observation, not a job outcome               |

Two decisions deserve emphasis.

First, unknown errors remain terminal. Retryability must be asserted deliberately, not guessed.

Second, `repo_unavailable` and `dependency_install_failed` are judgment calls. A network or package
registry failure can be transient. The current policy prefers avoiding three expensive identical
attempts for failures that are more commonly deterministic. Real operational data may justify
splitting these categories later.

### 9.1 OOM is not inferred from exit code 137

Exit 137 only means SIGKILL. A timeout, manual kill, or OOM can all produce it.

The adapter reads Docker's `State.OOMKilled`. The flag can arrive shortly after the exec stream
closes, so the code polls it briefly on a possible OOM path. `AutoRemove` is disabled because
removing the container would destroy the state needed to classify the kill.

OOM takes precedence over timeout if both observations overlap because "the kernel killed this for
memory" is more specific and actionable.

---

## Part 10. Trace a successful job

This is the complete Milestone 2 happy path:

```text
1. API creates jobs row and enqueues its UUID

2. worker claims queued -> provisioning
   lease_owner, lease expiry, heartbeat, attempt_count are recorded

3. provisioning creates Docker container
   sandbox.created
   jobs.sandbox_id is fenced on lease_owner

4. commands execute and are recorded
   mkdir workdir
   git clone
   git rev-parse HEAD
   ls repository
   install dependencies
   version and lockfile fingerprint commands

5. jobs.base_commit_sha and jobs.env_fingerprint are recorded
   repo.cloned
   deps.installed

6. analyzing, planning, implementing remain simulated sleeps

7. testing reads package.json and runs the test script
   each command gets job_commands + command.completed
   baseline.recorded = passed | failed | skipped

8. reviewing and finalizing remain simulated sleeps

9. finalizing -> completed

10. processor finally removes the container
    sandbox.destroyed
```

The command row and compact event are separate but linked:

```text
job_events.command.completed.data.commandId -> job_commands.id
```

The job detail page shows the resolved commit, environment fingerprint, and expandable command
transcripts. Two APIs also expose command metadata and individual command output:

```text
GET /api/jobs/:id/commands?after=<id>
GET /api/jobs/:id/commands/:commandId
```

The list endpoint omits stdout and stderr so initial reads and event replay do not repeatedly move
large transcripts. M3 fetches one bounded transcript only when its command completes or is opened.

---

## Part 11. Configuration and operational modes

`RIVET_SANDBOX` selects:

| Value    | Behavior                                         |
| -------- | ------------------------------------------------ |
| `docker` | Build the real provisioning and testing pipeline |
| `off`    | Use the seven-phase simulated pipeline           |

`off` keeps the Milestone 1 integration suite independent of Docker. It is rejected when
`NODE_ENV=production`, because a worker that sleeps and reports success without doing work is more
dangerous than one that refuses to start.

Important defaults:

```text
SANDBOX_MEMORY_MB=2048
SANDBOX_CPUS=2
SANDBOX_PIDS_LIMIT=512
SANDBOX_COMMAND_TIMEOUT_MS=120000
SANDBOX_CLONE_TIMEOUT_MS=180000
SANDBOX_INSTALL_TIMEOUT_MS=300000
SANDBOX_BASELINE_TIMEOUT_MS=300000
SANDBOX_MAX_OUTPUT_BYTES=65536
SANDBOX_WORKDIR=/home/node/workspace
```

`DOCKER_HOST` can override the socket. Otherwise the adapter probes Docker Desktop's user socket and
then `/var/run/docker.sock`.

---

## Part 12. Testing strategy

Milestone 2 adds a third non-overlapping suite rather than making every test depend on Docker.

### 12.1 Unit suite: `pnpm test`

No database, Redis, or Docker.

It proves:

- fake sandbox scripting and lifecycle
- Docker stream parser behavior with pure byte buffers
- UTF-8-safe truncation
- package-manager detection
- provisioning orchestration and error mapping
- baseline passed, failed, and skipped semantics
- pipeline behavior with and without phase bodies
- worker config defaults and production guard

These tests prove domain decisions. They do not prove the Docker daemon behaves as the fake claims.

### 12.2 Integration suite: `pnpm test:integration`

Real Postgres, Redis, BullMQ, and workers, but `RIVET_SANDBOX=off`.

It continues to prove Milestone 1's leases, fencing, cancellation, retry, timeout, and recovery
machinery without adding Docker as a prerequisite.

### 12.3 Sandbox suite: `pnpm test:sandbox`

Real Docker, Postgres, Redis, and BullMQ.

It proves:

- container creation, exec, and idempotent destruction
- separate stdout and stderr
- non-zero exit reporting
- output truncation
- command timeout
- kernel OOM classification
- PID ceiling behavior
- uid 1000 and restricted filesystem access
- reaping terminal jobs while sparing live jobs
- end-to-end clone, install, and green baseline
- red baseline continuing to completion
- missing branch becoming terminal `repo_unavailable`

The repository fixture is generated locally and served by a temporary `git daemon`. This permits a
real shallow clone without public network dependency, API rate limits, or a mutable external
repository.

The suite refuses non-local infrastructure unless an explicit escape hatch is set. That matters
because it creates containers and truncates test database tables.

CI runs `verify`, `integration`, and `sandbox` as separate parallel jobs. The verify job still has
no Docker daemon dependency, preserving the lazy-import guarantee.

---

## Part 13. Decision log

### 13.1 Dockerode instead of the Docker CLI

**Why:** dockerode exposes structured container creation, exec inspection, stream access, labels,
and container state without shelling out or parsing CLI text. It also gives precise control over
resource and security options.

**Cost:** Docker's stream framing and async state behavior must be handled directly.

### 13.2 Docker instead of a microVM

**Why:** Docker is available locally and in GitHub Actions, is fast enough for
one-container-per-job, and is appropriate for learning the orchestration and lifecycle problems
first.

**Cost:** containers share the host kernel and are not a sufficient boundary for hostile arbitrary
code in production.

**What would change it:** running untrusted third-party repositories with valuable credentials would
justify gVisor, Kata, Firecracker, or a managed sandbox service.

### 13.3 One container per attempt instead of per phase

**Why:** clone, dependencies, and later edits must share a filesystem.

**Cost:** an OOM flag is sticky for the container's lifetime, and one destructive command ends the
whole attempt. Both are acceptable because a killed command already makes the environment unsafe to
continue.

### 13.4 Command transcripts in Postgres instead of events or object storage

**Why:** transcripts are bounded to 64 KiB per stream by default, simple to query, and needed now.
Keeping them out of events prevents timeline bloat.

**Cost:** Postgres is not ideal for large logs. Object storage becomes appropriate if future agent
sessions produce much larger artifacts.

### 13.5 Processor-owned cleanup instead of phase-owned cleanup

**Why:** the processor can abandon a hung phase. A cleanup block inside that phase may never run.
The processor already owns the job deadline, lease, heartbeat, and terminal outcome, so it is the
correct owner of attempt-scoped resources.

### 13.6 Reaper instead of relying only on `finally`

**Why:** process death bypasses `finally`. Any resource-leak design that only handles cooperative
shutdown has not handled the failure case Milestone 1's leases were built for.

### 13.7 A failing baseline continues

**Why:** baseline is evidence about the input repository, not evidence about Rivet's work. Treating
it as failure would prevent later comparison and misattribute pre-existing defects.

---

## Part 14. Debugging playbook

| Symptom                                                     | Check first                                                   | Likely explanation                                     |
| ----------------------------------------------------------- | ------------------------------------------------------------- | ------------------------------------------------------ |
| Worker starts, first real job reports `sandbox_unavailable` | `docker version`, socket path in worker log                   | Daemon is not running or socket is inaccessible        |
| Clone says `git` is missing                                 | `SANDBOX_IMAGE`                                               | Image override uses a slim or incompatible image       |
| Clone cannot write the destination                          | `SANDBOX_WORKDIR` and uid of its parent                       | Parent is not writable by uid 1000                     |
| pnpm or yarn install hangs                                  | Command environment                                           | Corepack download prompt was not disabled              |
| Test exits 1 but job completes                              | `baseline.recorded` event                                     | Expected red-baseline behavior                         |
| Command has exit 137                                        | `oomKilled`, `timedOut`, Docker state                         | Exit 137 alone does not explain the kill               |
| stdout and stderr appear merged                             | Docker exec `Tty` setting                                     | A TTY was enabled and merged both streams              |
| Worker memory grows with command output                     | `CappedOutput` path and output cap                            | Output was buffered before truncation                  |
| Container remains after normal completion                   | `sandbox.destroyed`, worker logs                              | `destroy()` failed; next reaper pass should remove it  |
| Container remains after `kill -9`                           | Age and `rivet.*` labels                                      | Expected until grace period and reaper pass            |
| Job fails on a Bun repository                               | Command transcript                                            | Bun is detected but absent from the current Node image |
| `pnpm test` attempts to contact Docker                      | Top-level adapter construction or real provider in unit tests | Lazy/no-daemon invariant was broken                    |

Useful commands:

```bash
docker version
docker ps -a --filter label=rivet.job-id
docker inspect <container-id>
pnpm test:sandbox
```

The job timeline gives the compact story. The command list gives exact argv, cwd, exit code,
duration, and bounded stdout/stderr. Read both before relying on worker logs.

---

## Part 15. How to extend this milestone safely

### Add a new sandbox implementation

1. Implement `SandboxProvider`, `Sandbox`, and `ExecResult` from core.
2. Keep `destroy()` idempotent and non-throwing.
3. Preserve argv execution without an implicit shell.
4. Preserve timeout, abort, output cap, and separate stream semantics.
5. Translate host failures into the existing domain error hierarchy.
6. Add adapter-specific tests instead of trusting `FakeSandboxProvider`.

### Add a real pipeline phase

1. Add a body in `buildPipeline()` without changing the phase's legal status order.
2. Close configuration into the phase factory through `PipelineOptions`.
3. Use `PhaseContext` effects rather than importing the database in the phase.
4. Treat non-zero command exits according to that command's domain meaning.
5. Make abort and kill checks happen before mapping an exit to a repository failure.
6. Add unit tests with a hand-made context and an end-to-end sandbox test when Docker behavior
   matters.

### Add a command failure category

1. Add the category to contracts.
2. Add a typed error extending `RetryableJobError` or `TerminalJobError`.
3. Decide retryability where the error is created.
4. Add classification and worker-level coverage.
5. Add a UI label because failure-category mappings are total records.

No database migration is needed for a new failure category because the column is validated `text`,
not a PostgreSQL enum.

### Change sandbox schema or persisted facts

1. Edit `packages/database/src/schema/`.
2. Run `pnpm db:generate`.
3. Review and commit the generated SQL.
4. Apply it to a scratch database before the real development database.
5. Preserve the single-writer rules for `jobs.status`, `job_events`, and `job_commands`.

`recordProvisioning()` is allowed to update `sandbox_id`, `base_commit_sha`, and `env_fingerprint`,
but it is fenced by `lease_owner` and its patch type cannot update status.

---

## Part 16. Known limits and next milestones

Milestone 2 is intentionally incomplete:

- Five of seven phases are still sleeps.
- There is no Pi session or model call.
- There is no code editing.
- Milestone 3 now provides a live Postgres-backed SSE stream; this M2 guide does not detail its
  transport or client reducer.
- There is no checkpoint or resume into an existing sandbox.
- There is no private repository authentication.
- There is no hardened network boundary.
- Validation only understands a root Node project and its `test` script.
- The current image does not contain Bun despite recognizing Bun lockfiles.
- The CPU quota is configured but not explicitly tripped by the sandbox suite.
- Command output is capped in Postgres rather than archived in object storage.

These are milestone boundaries, not hidden claims. Milestone 3 makes execution observable in real
time, while this guide remains focused on the M2 sandbox. Milestones 4 and 5 add Pi and the first
autonomous coding flow. Milestone 6 adds checkpoints and recovery. Milestone 7 expands deterministic
validation. Milestone 9 adds GitHub identity and short-lived credentials.

---

## Glossary

| Term                        | Meaning                                                            |
| --------------------------- | ------------------------------------------------------------------ |
| **Sandbox port**            | Core's implementation-independent contract for isolated execution  |
| **Adapter**                 | A real or fake implementation of that port                         |
| **Attempt**                 | One worker claim and its one disposable container                  |
| **Argv**                    | A structured command and argument array, not shell text            |
| **Baseline**                | Repository health measured before Rivet makes a change             |
| **Environment fingerprint** | Commit, image, tools, lockfile, and limits describing a run        |
| **Demultiplexing**          | Splitting Docker's framed output back into stdout and stderr       |
| **Output cap**              | Bounded retained bytes with head, tail, and explicit elision count |
| **OOM**                     | Kernel-enforced out-of-memory kill observed from Docker state      |
| **Reaper**                  | Sweep step that removes containers whose jobs are no longer live   |
| **Grace period**            | Minimum container age before the reaper may remove it              |
| **Fenced write**            | Database update allowed only while `lease_owner` still matches     |

---

## Where to go next

- `plan.md` - the implementation plan, including deviations discovered while building
- `PRD.md` sections 11, 15, 24.2, and 31 - product requirements behind the milestone
- `docs/architecture.md` - current-system reference documentation
- `docs/milestone-1-guide.md` - the reliability substrate this milestone reuses
- `packages/sandbox/src/docker-sandbox.ts` - the real adapter and its Docker-specific lessons
- `apps/worker/tests/sandbox/` - executable proof of the milestone's main claims
