# Milestone 4: Pi coding-agent integration

**Status: complete.**

Milestone 4 establishes the boundary between Rivet's deterministic job runner and a model-driven
coding harness. Pi runs in the trusted worker process. Its four tools are re-pointed at the job's
sandbox, so the model can inspect and edit the repository without the provider credential entering a
container that runs cloned code.

## Delivered stages

- **Stage 0:** pinned `@earendil-works/pi-coding-agent` to `0.84.1` and recorded the SDK findings in
  the private plan.
- **Stage 1:** added the `CodingAgent` port, event contracts, and agent failure categories.
- **Stage 2:** added sandbox file transfer through `getFile` and `putFile`, with Docker tar handling
  and a scripted fake.
- **Stage 3:** added `PiCodingAgent`, `FakeCodingAgent`, path containment, the four sandbox-backed
  tool operations, and the bounded event bridge.
- **Stage 4:** made `implementing` a real phase when an agent is supplied, including context,
  cancellation, session deadlines, usage accounting, budget enforcement, and worker wiring.
- **Stage 5:** persisted cumulative input tokens, output tokens, and priced cost under the worker
  lease, while keeping per-turn usage in the append-only event log.
- **Stage 6:** rendered agent activity, usage counters, and command links in the existing live job
  timeline.
- **Stage 7:** added worker integration coverage, Docker tool-layer coverage, the local Pi smoke
  command, and documentation updates.

## Runtime topology

```text
worker host
  Pi session + OPENROUTER_API_KEY
       │
       ├── read / write / edit ── getFile / putFile ──┐
       └── bash ── AgentToolbox.exec ────────────────┤
                                                     ▼
                                           job Docker sandbox
                                           repository + commands
```

The adapter supplies Pi's original tool schemas and descriptions, replacing only their operations.
After session construction it asserts that the active tool set is exactly:

```text
bash, edit, read, write
```

The worker deliberately ignores the environment Pi assembles for its local bash tool. Sandbox
commands receive only the sandbox environment, which is empty in M4. This keeps `OPENROUTER_API_KEY`
on the worker host. The boundary contains the model, not the harness: Pi still runs as the worker
user, and a production deployment needs a stronger isolation boundary around the worker process
itself.

## Durable execution

The phase maps Pi's stream to Rivet events rather than persisting Pi's raw event vocabulary:

- `agent.session_started`
- `agent.turn_started`
- `agent.message`
- `agent.tool_started`
- `agent.tool_completed`
- `agent.usage`
- `agent.budget_exceeded`
- `agent.session_ended`

Token deltas are not persisted. Shell tools go through `PhaseContext.exec`, so their
`command.started` and `command.completed` events and their `job_commands` transcripts are the same
kind of records as commands run by provisioning or baseline testing. Usage totals are updated after
each completed usage event through a lease-fenced writer, so a reclaimed attempt starts from the
totals already durable.

`RIVET_AGENT=off` keeps the implementing phase simulated for unit and lifecycle suites. Production
workers refuse that setting. `RIVET_AGENT=pi` requires `OPENROUTER_API_KEY` when the provider is
OpenRouter. The default model is `deepseek/deepseek-v4-flash`.

## Verification

The ordinary unit suite remains free of Postgres, Redis, Docker, and model credentials. The two
infrastructure suites add the boundary cases that cannot be proved with fakes alone:

```bash
pnpm test
pnpm test:integration
pnpm test:sandbox
pnpm typecheck
pnpm lint
pnpm format:check
```

The integration suite uses a scripted agent against real Postgres, Redis, BullMQ, and the production
processor. It covers completion and ordered events, shell transcript correlation, cancellation,
budget exhaustion, retryable provider errors, terminal provider errors, and whole-job deadlines.

The sandbox suite uses a real Docker container to cover read, write, edit, bash, file and output
bounds, and command timeout classification. It does not need a model key.

## Local smoke demo

With Docker running and `OPENROUTER_API_KEY` in `.env.local`:

```bash
pnpm demo:agent
```

The command creates a disposable container and fixture repository, starts one real Pi session,
prints its observable transcript and usage, runs the fixture test after the session, and removes the
container and temporary Pi directory. It is intentionally local-only and is not part of CI because
third-party provider availability is not a reliable build dependency.

## Deliberate limits

M4 does not claim that Pi detects completion, persists a diff, creates a plan artifact, performs a
review, or opens a pull request. Those belong to later milestones. It also does not claim
hostile-code isolation from Docker alone. The provider key is protected from repository processes by
the worker and sandbox split, while kernel, daemon, network egress, and worker-process hardening
remain explicit follow-up work.
