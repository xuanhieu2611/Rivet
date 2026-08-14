# Milestone 3: a guided tour of the live execution timeline

This is a learning document. `docs/architecture.md` is the reference description of the system as it
exists today. This guide explains what Milestone 3 added, how the pieces fit together, why the
implementation made its tradeoffs, and where to look when the live page behaves unexpectedly.

The original M3 plan has since been replaced by the Milestone 4 plan. This guide reconstructs M3
from the implementation and Git history. The relevant history is:

```text
d12cd5b  feat: add observable command lifecycle events
4f0e815  feat: stream job events over SSE
ff41e30  test: add real-Postgres streaming suite
816ee07  feat: make job timeline live
642c467  feat: make command log live and lazy
c202545  docs: complete Milestone 3 cleanup
50cf69d  docs: update milestone 3 app copy
8f2a6ff  fix: keep live command transcripts resolving
```

The last commit is a follow-up bug fix discovered while using the command log. It is included here
because it is part of the current M3 behavior.

---

## Part 0. The one idea

Milestone 3 did not give the worker new engineering abilities. It made the work that Milestones 1
and 2 already perform observable while it is happening:

```text
worker and API writers
        |
        | appendEvent(), often inside the same transaction as the fact
        v
Postgres job_events
        |
        | query rows after a durable cursor
        v
GET /api/jobs/:id/events
        |
        | JSON for ordinary callers
        | SSE for live viewers
        v
Browser EventSource
        |
        v
pure reducer keyed by event id
        |
        +--> live status badge
        +--> execution timeline
        +--> command lifecycle and transcript view
```

The most important rule is:

> **Postgres remains the event source of truth. SSE is a database tailer, not an event broker.**

Redis is still only the BullMQ delivery mechanism. The web process does not maintain a second event
history, and the browser does not treat its local state as authoritative. If the web process
restarts or a browser disconnects, the next request reads the durable rows again.

M3 provides **at-least-once delivery with exactly-once visible reduction**:

- The server may replay an event at a reconnect boundary.
- Every persisted event has a globally monotonic id.
- The browser stores events by id and ignores duplicates.
- The visible timeline therefore does not show duplicate rows.

That distinction is important. Exactly-once network delivery is not realistic across the boundary
where a connection can disappear after the server writes bytes but before the browser processes
them. Idempotent reduction is the practical solution.

---

## Part 1. What changed, and what did not

### Before M3

The job page rendered a server snapshot. A temporary `JobStatusPoller` refreshed the whole page on a
timer. That worked for a demo, but it had several problems:

- The browser repeatedly fetched all server-rendered page data.
- A command could not appear until a completed command row existed.
- The page had no durable reconnect cursor.
- A network interruption could lose the viewer's place in the timeline.
- Refreshing the page for every event mixed live transport with unrelated server-rendered fields.
- Every command transcript was loaded eagerly, even when its details were never opened.

### After M3

The detail page now has one client provider that owns one event stream and one cursor:

```text
server-rendered initial snapshot
        |
        v
JobLiveProvider
        |
        +--> EventSource for durable events
        +--> reducer for status and timeline
        +--> lazy command detail requests
```

Only the pieces that need live updates became client consumers:

- status badge
- connection indicator
- execution timeline
- command log

The description, budgets, target metadata, timestamps, environment fingerprint, and failure summary
remain server-rendered. One final `router.refresh()` runs after `stream.end` so those fields catch
up without causing a full refresh for every event.

### Deliberate non-goals

M3 does not include:

- Pi or any model call
- raw model output or hidden chain-of-thought
- byte-by-byte stdout and stderr streaming
- WebSockets
- Redis Pub/Sub
- Postgres `LISTEN/NOTIFY`
- authentication or per-user authorization
- event retention or archival
- checkpoints or resumable agent sessions
- a hardened production sandbox
- a dashboard-wide live stream

The five phases that do not need a coding agent remain simulated. Provisioning and baseline testing
are real Docker work from M2.

---

## Part 2. Reading path

Read these files in this order. The sequence starts with the durable contracts, then follows one
command through the server and finally through the browser.

| #   | File                                                 | What it teaches                                       |
| --- | ---------------------------------------------------- | ----------------------------------------------------- |
| 1   | `packages/contracts/src/job-event.ts`                | Event vocabulary, payload fields, wire parsing        |
| 2   | `packages/contracts/src/job-command.ts`              | Summary versus transcript contracts                   |
| 3   | `packages/core/src/events/event-service.ts`          | Append-only event writes and cursor queries           |
| 4   | `packages/core/src/pipeline/phase-context.ts`        | Command lifecycle emission and transaction boundaries |
| 5   | `apps/web/lib/events/cursor.ts`                      | Query and `Last-Event-ID` resolution                  |
| 6   | `apps/web/lib/events/sse.ts`                         | Pure Server-Sent Events framing                       |
| 7   | `apps/web/lib/events/stream-job-events.ts`           | Polling, heartbeats, aborts, and terminal draining    |
| 8   | `apps/web/app/api/jobs/[id]/events/route.ts`         | Content negotiation and route ownership               |
| 9   | `apps/web/components/job-live/stream-state.ts`       | Pure browser reducer and command pairing              |
| 10  | `apps/web/components/job-live/job-live-provider.tsx` | EventSource lifecycle and lazy fetches                |
| 11  | `apps/web/components/job-live/live-command-log.tsx`  | The command UI and transcript states                  |
| 12  | `apps/web/tests/streaming/events.stream.test.ts`     | The actual route against Postgres                     |

Then run the focused unit tests:

```bash
pnpm --filter @rivet/web test
```

The real streaming suite is intentionally separate because it truncates shared Postgres tables:

```bash
pnpm test:streaming
```

---

## Part 3. Durable events were already the right foundation

M1 established `job_events` as an append-only table. M3 deliberately builds on it rather than
introducing a new stream table.

The important columns are:

```text
id          global bigserial cursor
job_id      owning job
type        text event vocabulary
message     short human-readable timeline line
data       JSONB structured event facts
created_at  database timestamp
```

There is an index on `(job_id, id)`, which is exactly the query pattern the stream needs:

```sql
SELECT *
  FROM job_events
 WHERE job_id = $1
   AND id > $2
 ORDER BY id ASC
 LIMIT 200;
```

### Why the event id is global

The id is global rather than a per-job counter. That means ids from other jobs create gaps in one
job's stream, but gaps do not matter. The browser only needs a cursor that is monotonically
increasing for the rows it receives.

A per-job counter would require extra coordination to allocate. A global Postgres sequence is cheap,
ordered, already indexed, and works naturally with SSE's `Last-Event-ID` field.

### `appendEvent()` is the only writer

`packages/core/src/events/event-service.ts` owns event insertion. It accepts an `Executor`:

```ts
appendEvent(input, databaseOrTransaction);
```

Passing a transaction is what makes a fact and its event atomic. For example, `transitionJob()`
does:

```text
lock job row
check expected status and lease
update jobs.status
insert corresponding job_events row
commit both together
```

If the transaction rolls back, neither the status change nor its event exists. The timeline cannot
claim that a transition happened when the job row says otherwise.

The same pattern is used for commands: the `job_commands` row and its `command.completed` event are
inserted in one transaction.

### Event types are text, not a Postgres enum

M3 adds these two values to `JOB_EVENT_TYPES`:

```text
command.started
command.failed
```

The event type column is validated by Zod in `@rivet/contracts`, not by a PostgreSQL enum. Event
vocabulary grows every milestone, and a database migration for every new descriptive event would
create churn without improving the state machine. Job statuses are different because they form a
closed, indexed state machine and therefore remain a PostgreSQL enum.

Adding an event type requires:

1. Add it to `JOB_EVENT_TYPES`.
2. Add a UI tone to `JOB_EVENT_TONE` in `apps/web/lib/job-status.ts`.
3. Add or update the producer.
4. Add producer and client tests.

The total `Record<JobEventType, ...>` for UI tones makes omission a typecheck failure.

---

## Part 4. Command lifecycle observability

M2 already recorded completed commands in `job_commands`, including bounded stdout and stderr. That
was not enough for a live interface because a command row did not exist until execution returned.

M3 adds an event-only lifecycle correlation id.

### Why there are two ids

A `job_commands.id` is allocated only after the command finishes. It points to a durable transcript
that contains final facts such as duration, exit code, and output. Updating an incomplete command
row later would turn the append-only command ledger into an update-in-place state table.

M3 therefore uses:

```text
commandExecutionId  UUID for one in-flight attempt, stored in event JSON
commandId           bigserial row id, allocated only after completion
```

The lifecycle looks like this:

```text
command.started
  commandExecutionId = A
  commandId          absent

command.completed
  commandExecutionId = A
  commandId          = 26
```

The UUID correlates lifecycle events. The command id addresses the durable transcript.

### The exact execution sequence

`PhaseContext.exec()` in `packages/core/src/pipeline/phase-context.ts` does this:

```text
1. Get the sandbox handle.
2. Generate commandExecutionId.
3. Append command.started.
4. Call sandbox.exec().
5. If sandbox.exec() returns:
   a. Begin a database transaction.
   b. Insert the job_commands row.
   c. Append command.completed with commandId.
   d. Commit.
6. If sandbox.exec() throws:
   a. Best-effort append command.failed.
   b. Log a secondary event-write failure if necessary.
   c. Rethrow the original sandbox error.
```

The start event is written before Docker execution. If the system cannot record that a command
started, it deliberately does not run the command. An un-auditable action is worse than a failed
attempt.

### A non-zero exit is still a completed command

The sandbox returns ordinary process exits as `ExecResult`, including non-zero exit codes. The phase
assigns meaning to the result:

```text
git clone exit 1       -> provisioning may classify repo_unavailable
npm install exit 1     -> provisioning may classify dependency_install_failed
baseline test exit 1   -> baseline.failed, but the job continues
```

Those commands still have a durable command row and a `command.completed` event. A sandbox call that
throws is different: it produces `command.failed` because there is no completed result to record.

This distinction preserves the M2 rule that a red repository baseline is evidence about the input,
not automatically a Rivet failure.

### Failure events must not mask the original failure

If Docker reports `container disappeared` and Postgres is also unavailable, the failed-event write
may fail. The worker must still classify the Docker error. `PhaseContext.exec()` catches the
secondary event-write error, logs it, and rethrows the original sandbox exception.

This is a general reliability pattern:

> Recording an observation is important, but an observation failure must not replace the fact it was
> trying to record.

---

## Part 5. Wire serialization across the server and browser

Server components and route handlers work with `Date` objects. Browser JSON contains strings. M3
makes this boundary explicit instead of relying on a cast.

The contracts define:

```ts
type SerializedJobEvent = Omit<JobEvent, "createdAt"> & { createdAt: string };
type SerializedJobCommandSummary = Omit<JobCommandSummary, "createdAt"> & {
  createdAt: string;
};
type SerializedJobCommand = Omit<JobCommand, "createdAt"> & { createdAt: string };
```

They also provide serializers and parsers:

```text
serializeJobEvent()              Date -> ISO string
parseSerializedJobEvent()        validate JSON and restore Date
serializeJobCommandSummary()
parseSerializedJobCommandSummary()
serializeJobCommand()
parseSerializedJobCommand()
```

The same event parser is used for:

- initial server-rendered events
- live SSE frames

The same command parsers are used for:

- initial command summaries
- lazy command detail responses

This prevents the initial page and live updates from silently developing different shapes.

The parsers validate ids, event types, status values, dates, command metadata, and known structured
fields. Event data remains extensible with passthrough fields so a future producer can add metadata
without making older readers unable to display the event.

---

## Part 6. The SSE route

M3 keeps one endpoint and adds content negotiation:

```text
GET /api/jobs/:id/events
```

| Request                     | Response                      |
| --------------------------- | ----------------------------- |
| `Accept: text/event-stream` | Long-lived SSE stream         |
| Any other `Accept` value    | Existing JSON cursor response |

The JSON form remains useful for scripts, tests, and non-live consumers:

```json
{
  "events": [],
  "cursor": 1849
}
```

### Why one endpoint

The JSON and SSE forms read the same durable rows and use the same cursor concept. A second endpoint
would create two contracts to maintain and would make it easier for the two paths to disagree.
Content negotiation changes transport, not the underlying event model.

### Validation before opening the stream

The route does this before it returns streaming headers:

1. Parse `after` and `Last-Event-ID`.
2. Reject invalid cursors with `400`.
3. Look up the job.
4. Return `404` for an unknown job.
5. Only then create the SSE response.

Once an SSE response has committed its headers, it cannot cleanly turn into a JSON `404`. Checking
first keeps invalid requests diagnosable.

The route is `dynamic = "force-dynamic"` and remains on the Node.js runtime. It must not be moved to
Edge because the database client uses the Node `pg` driver.

### Cursor resolution

A new connection can provide both:

```text
?after=<cursor>
Last-Event-ID: <cursor>
```

The route resolves the maximum valid value:

```ts
cursor = max(afterQuery, lastEventIdHeader);
```

Why both are needed:

- The page uses `?after=` when it creates a new `EventSource`.
- Native EventSource uses `Last-Event-ID` when it reconnects the same stream.
- A reconnect may reuse an old URL while carrying a newer header.
- Taking the maximum prevents replaying an unnecessarily old range.

Missing values mean no cursor. Negative, fractional, unsafe, or malformed values return `400`.

### SSE frames

Connection setup:

```text
retry: 2000

: connected

```

A persisted event:

```text
id: 1842
event: job.event
data: {"id":1842,"jobId":"...","type":"command.started",...}

```

The `id` is what EventSource remembers for reconnects. The event data is the serialized `JobEvent`;
M3 does not invent a second SSE-specific event vocabulary.

Idle heartbeat:

```text
: keepalive

```

Terminal control frame:

```text
event: stream.end
data: {"cursor":1849,"status":"completed"}

```

`stream.end` is not persisted and intentionally has no durable event id. It tells the browser that
this connection has drained and can close.

`apps/web/lib/events/sse.ts` is a pure encoder. Keeping framing separate from the database loop
makes the protocol testable without a server or Postgres. The encoder handles blank-line
termination, repeated `data:` fields for multiline strings, comments, retry values, and protection
against newline injection in field values.

### Polling loop

The stream helper in `stream-job-events.ts` uses an async loop rather than `setInterval`:

```text
while connected:
  rows = listEvents(jobId, after=cursor, limit=200)
  emit rows in ascending id order
  move cursor to the last emitted id

  if the page was full:
    query again immediately
  else:
    sleep for one poll interval
```

Current production values are:

```text
retry delay:       2 seconds
poll interval:     1 second
heartbeat:        15 seconds
terminal grace:    2 seconds
page size:       200 events
```

A full page is drained immediately so a reconnecting viewer catches up quickly. An idle stream polls
once per second and borrows a pooled Postgres connection only for each query. It does not hold a
database connection open for the life of the browser response.

### Abort and cleanup

The stream listens to both forms of disconnection:

- `request.signal` aborts when the HTTP request is disconnected.
- `ReadableStream.cancel()` runs when the consumer cancels its reader.

Both paths abort the internal signal. The abort-aware sleep rejects, the loop stops before another
query, and the request listener is removed in `finally`.

A database error after headers are committed breaks the stream. It does not write a fake job
failure. The browser's EventSource error path reconnects from its last durable id.

### Terminal draining

A terminal status transition is not necessarily the last event. The processor destroys the sandbox
in its cleanup path, and `sandbox.destroyed` may be appended after `job.completed`, `job.failed`, or
another terminal transition.

The stream therefore does not close immediately when it sees a terminal status:

```text
1. Observe terminal status from event.data.to.
2. Start a two-second quiescence deadline.
3. Poll normally during the deadline.
4. Reset the deadline whenever another event arrives.
5. Emit stream.end after the quiet window.
6. Close the response.
```

If the job was already terminal when the page opened, the same rule applies after the backlog
drains. This prevents finished pages from staying open forever while still capturing normal cleanup
events.

The browser performs one `router.refresh()` after `stream.end` to synchronize fields that are not
reducer consumers, such as `completedAt`, failure details, environment metadata, and cancellation
controls.

---

## Part 7. The browser provider and reducer

The provider is `apps/web/components/job-live/job-live-provider.tsx`. Its job is lifecycle
ownership, not domain interpretation. The interpretation lives in the pure reducer at
`apps/web/components/job-live/stream-state.ts`.

### State shape

The reducer keeps:

```text
status
connection: connecting | live | reconnecting | finished
eventsById
lastEventId
commandsById
commandRunsByExecutionId
commandDetailsById
```

Maps are used for idempotency and direct lookup. Selectors produce sorted arrays for rendering.

### Reducer rules

For a durable event:

1. If its id is already present, return the existing state.
2. Otherwise store it by id.
3. Advance `lastEventId` only when the id is newer.
4. Update status when `event.data.to` exists.
5. Apply command-specific pairing for command lifecycle events.

This means a replayed event is harmless. It can be delivered twice, but the visible timeline has one
row.

For commands:

```text
command.started
  create a running row keyed by commandExecutionId

command.completed
  find the row by commandExecutionId
  attach commandId, exitCode, durationMs
  request the one bounded transcript

command.failed
  find the row by commandExecutionId
  mark it failed and show the error
```

Initial server-rendered command summaries are inserted without automatically loading transcripts. A
user opening an existing row requests its detail. A completion received over SSE requests its one
detail automatically.

### EventSource lifecycle

The provider creates:

```ts
new EventSource(`/api/jobs/${jobId}/events?after=${cursor}`);
```

It listens for:

| Event        | Browser action                                       |
| ------------ | ---------------------------------------------------- |
| `open`       | Mark connection `live`                               |
| `job.event`  | Parse and dispatch to the reducer                    |
| `stream.end` | Close, mark `finished`, refresh once                 |
| `error`      | Mark `reconnecting` and let native EventSource retry |

The implementation does not add a second network retry loop. The server's `retry: 2000` controls
native reconnect behavior. A manual reconnect is used only when a hidden tab becomes visible again.

### Hidden tabs

When `document.visibilityState` becomes `hidden`, the provider closes EventSource. This avoids
keeping a Postgres query loop active for a tab nobody is viewing.

When the tab becomes visible, it creates a new connection using the reducer's latest cursor. The
server replays anything committed while the tab was hidden. Since the reducer is idempotent, a
boundary replay remains safe.

### Why the whole page is not a client component

Converting the entire page to a client data-fetching application would make every piece of metadata
participate in a browser state model. M3 only promotes the parts that need live updates. That keeps
server rendering useful and keeps the client boundary small enough to reason about.

---

## Part 8. The command log and lazy transcripts

The command UI is `live-command-log.tsx`. It combines three kinds of information:

```text
live lifecycle event       running / completed / failed state
command summary            argv, cwd, duration, exit flags
command detail             bounded stdout and stderr
```

The server page loads only summaries:

```text
listCommands(job.id)
```

The transcript route returns one complete command:

```text
GET /api/jobs/:id/commands/:commandId
```

The list route remains available for metadata pagination:

```text
GET /api/jobs/:id/commands?after=<command-id>
```

### Row behavior

A row displays:

- exact argv
- phase and cwd
- timestamp
- running, failed, exit code, timed out, OOM killed, or killed state
- duration when known
- transcript loading state
- stdout and stderr in separate sections
- output-truncated marker
- retry action if detail loading failed

The transcript is bounded before it reaches the database. M3 changes when it is fetched, not how it
is captured. Output is still not streamed byte by byte.

### The loading bug and its fix

The first M3 implementation used an effect-local `disposed` flag in the detail-fetch effect. The
effect depended on `state.commandDetailsById`, so every time another command completed, the map
changed and React cleaned up the previous effect.

That created this race:

```text
command A completion -> request A starts -> A is loading
command B completion -> detail map changes -> effect cleanup marks A disposed
new effect sees A request already in detailRequestsRef and skips it
request A resolves -> callback sees disposed and does not dispatch
A remains loading forever
```

The fix in `8f2a6ff` keeps in-flight requests alive across reducer map updates. Results are still
ignored when the component is unmounted or when the job id has changed. A real request failure now
transitions to an error state with a retry button instead of silently leaving a spinner.

This is a useful React lesson:

> An effect that owns a long-lived request should not treat every state dependency update as
> component disposal.

The dependency update may mean that more work was discovered, not that the existing work became
invalid.

---

## Part 9. Testing strategy

M3 adds a fourth test suite. The separation is intentional.

### 9.1 Ordinary unit suite

```bash
pnpm test
```

No database, Redis, or Docker. It covers:

- SSE frame encoding
- cursor parsing and max resolution
- wire serialization and date restoration
- stream loop behavior with injected list, sleep, and clock functions
- reducer ordering and deduplication
- command start/completion/failure pairing
- command detail state transitions
- existing core, sandbox, queue, and worker unit behavior

The stream helper takes `list`, `sleep`, and timing values as arguments. Tests can use short real
waits and injected clocks instead of fake timers hidden inside production code.

### 9.2 Real Postgres streaming suite

```bash
pnpm test:streaming
```

This suite calls the actual Next route handler with `Request` objects and reads the returned
`ReadableStream`. It requires local Postgres, but no Redis or Docker.

The suite proves:

1. Historical backlog after a cursor.
2. Live delivery after a row is appended.
3. Reconnect using `Last-Event-ID` without gaps.
4. A newer header beating an older URL cursor.
5. The same event reaching two independent viewers.
6. No further queries after a response is cancelled.
7. Cleanup events arriving after terminal transition.
8. Already-terminal streams closing after backlog and grace.
9. JSON compatibility for non-SSE callers.
10. Unknown jobs returning `404` before SSE headers.
11. Invalid cursors returning `400` before database reads.

The suite loads `.env.test`, never `.env.local`, and refuses remote databases by default because it
truncates `jobs` and `job_events`.

### 9.3 Existing worker integration suite

```bash
pnpm test:integration
```

This remains the real Postgres, Redis, and BullMQ suite. It runs with the simulated pipeline and
continues to prove leases, fencing, retries, cancellation, timeouts, crash recovery, and
Postgres/Redis reconciliation. M3 updates event expectations for command lifecycle events.

### 9.4 Existing sandbox suite

```bash
pnpm test:sandbox
```

This requires local Postgres, Redis, and Docker. It proves the real command producer emits start and
completion events, and that the M2 container behavior still works.

### 9.5 Run infrastructure suites separately

The integration, streaming, and sandbox suites truncate shared job tables. Run them one at a time on
a local database. CI gives each suite an independent service environment, so the four CI jobs can
run in parallel there:

```text
Verify       typecheck, lint, format, unit tests, build; no infrastructure
Integration  Postgres + Redis
Sandbox      Postgres + Redis + Docker
Streaming    Postgres only
```

### 9.6 Full local verification

From the repository root:

```bash
pnpm format:check
pnpm typecheck
pnpm lint
pnpm test
pnpm build
pnpm test:integration
pnpm test:streaming
pnpm test:sandbox
```

The last three need local services. The first five should work with no database, Redis, or Docker.

---

## Part 10. Manual demo and protocol inspection

Start the real demo with Docker enabled:

```bash
pnpm db:migrate
pnpm dev
```

Create a job using a public Node repository. On the detail page, watch for:

```text
Live
sandbox.created
command.started
command.completed
repo.cloned
deps.installed
baseline.recorded
sandbox.destroyed
Finished
```

The exact event list depends on the repository and whether its baseline is passed, failed, or
skipped. The five simulated phases still produce phase events but do not execute agent commands.

### Inspect the SSE response with curl

The endpoint is unauthenticated in M3 and should only be used locally during development:

```bash
curl -N \
  -H 'Accept: text/event-stream' \
  'http://localhost:3000/api/jobs/<job-id>/events?after=0'
```

You should see `retry`, connection comments, event ids, event names, JSON data, and eventually
`stream.end` for a terminal job.

Inspect the JSON compatibility path:

```bash
curl -s \
  'http://localhost:3000/api/jobs/<job-id>/events?after=0' \
  | jq
```

Inspect command metadata and one transcript:

```bash
curl -s 'http://localhost:3000/api/jobs/<job-id>/commands' | jq
curl -s 'http://localhost:3000/api/jobs/<job-id>/commands/<command-id>' | jq
```

### Inspect the durable log directly

```sql
SELECT id, type, message, data, created_at
  FROM job_events
 WHERE job_id = '<job-id>'
 ORDER BY id;

SELECT id, phase, argv, cwd, exit_code, duration_ms,
       truncated, timed_out, oom_killed, created_at
  FROM job_commands
 WHERE job_id = '<job-id>'
 ORDER BY id;
```

For a completed command, the sequence should be visible in the event log:

```text
command.started      commandExecutionId = A
command.completed    commandExecutionId = A, commandId = N
```

The command row should exist before the completion event can be committed.

---

## Part 11. Decision log

### 11.1 SSE instead of WebSockets

**Problem:** The browser mostly receives information. It does not need bidirectional messaging for
this milestone.

**Choice:** Server-Sent Events over the existing HTTP route.

**Why:** Native EventSource provides automatic reconnect behavior, the wire format is simple, and
server-to-browser traffic matches the product need. WebSockets would add connection management and a
new server abstraction without solving a current requirement.

**What would change it:** Interactive agent controls, bidirectional approvals, or very high event
rates could justify WebSockets. The durable Postgres replay model would still be needed underneath.

### 11.2 Postgres polling instead of Redis Pub/Sub

**Problem:** A stream needs to notice new rows after it has replayed its backlog.

**Choice:** Query `job_events` once per second per visible viewer.

**Why:** No new infrastructure, no second event history, simple reconnect semantics, and compatible
with the existing pooled `pg` client. Redis Pub/Sub is lossy and would still require Postgres replay
for reconnects. `LISTEN/NOTIFY` requires dedicated connection handling and is awkward behind
PgBouncer and a serverless web process.

**Cost:** A visible active viewer creates roughly one bounded Postgres query per second. Hidden and
terminal pages close their streams to keep the current portfolio-scale cost reasonable.

**What would change it:** Measured concurrent-viewer load. A later design could use a lossy wake-up
notification to reduce polling while keeping Postgres as the replay authority.

### 11.3 Content negotiation instead of a second SSE route

**Problem:** Existing JSON callers already use `/events?after=<id>`.

**Choice:** Keep the route and select SSE only when `Accept` contains `text/event-stream`.

**Why:** Scripts and tests keep their JSON contract, while EventSource gets a streaming response.
The cursor and event data stay identical across both forms.

### 11.4 At-least-once transport instead of exactly-once delivery

**Problem:** A connection may break between server write and browser processing.

**Choice:** Replay from the last known cursor and deduplicate in the reducer.

**Why:** Durable ids and idempotent reduction are simpler and more correct than inventing an
acknowledgement protocol that still cannot know exactly what the browser rendered.

### 11.5 Terminal grace instead of immediate close

**Problem:** The terminal status transition can be followed by sandbox cleanup events.

**Choice:** Wait two seconds after the last terminal-related event before sending `stream.end`.

**Why:** The normal processor ordering is preserved and cleanup remains visible. The stream still
closes for finished jobs rather than polling forever.

**Limit:** A very late operational event may appear on the next page load instead of the live
stream. All events remain durable and replayable.

### 11.6 Append-only commands instead of updating a running command row

**Problem:** A command needs a running state before it has a final transcript, but its durable row
needs final output and exit metadata.

**Choice:** Keep `job_commands` append-only and correlate lifecycle events with a UUID.

**Why:** The command table remains evidence, not a mutable status ledger. The event log can show the
attempt immediately without creating a half-filled command row.

### 11.7 Lazy transcripts instead of eager output or byte streaming

**Problem:** Loading every transcript makes the initial page expensive. Byte streaming requires
chunk persistence, reconnect semantics, redaction, and backpressure.

**Choice:** Initial summaries, one detail request per completed or opened command, bounded output.

**Why:** It solves the current UX problem without committing M3 to a second streaming data model.

**What would change it:** A real Pi demo where command output needs to be observed while a command
is still running. That should be designed as a separate chunked-output milestone.

### 11.8 Long-lived Node response instead of Edge

**Problem:** A database-backed stream needs a Node-compatible `pg` runtime and a host that permits a
long response.

**Choice:** Keep the route on the normal Node runtime and document the hosting constraint.

**Why:** `pg` cannot run in Edge, and pretending every serverless host supports indefinite SSE would
hide a deployment failure rather than solve it.

Before public deployment, use a long-lived Node host, a provider with explicit streaming support, or
a dedicated event gateway. Do not move event authority out of Postgres.

---

## Part 12. Debugging playbook

### The connection indicator never becomes Live

Check:

1. The browser Network panel for `/api/jobs/<id>/events`.
2. Response content type: it should be `text/event-stream; charset=utf-8`.
3. The route response for `404` or `400`.
4. The server log for a database connection error.
5. Whether the tab is hidden. Hidden tabs intentionally close the stream.

The route is not a normal finite request. Use the Network panel's EventStream view or `curl -N`.

### The timeline duplicates rows

Check event ids, not timestamps. The server may replay a boundary event by design, but the reducer
should keep one row per id.

If duplicates are visible:

1. Inspect `eventsById` behavior in `stream-state.ts`.
2. Check that the rendered list uses `event.id` as its React key.
3. Check that the cursor is not being moved backward.
4. Check whether a separate component is rendering server events alongside live events instead of
   using the provider's merged selector.

### The stream reconnects but misses events

Check:

1. The last durable id received before disconnect.
2. The new URL's `after` value.
3. The `Last-Event-ID` header on native reconnect.
4. The route's max-cursor resolution.
5. The database rows after that id.

The route should query `id > cursor`, not `id >= cursor`. The client should advance its cursor only
for valid parsed events.

### A terminal stream stays open

Check:

1. The job has a terminal status.
2. The transition event has `data.to` set to that terminal status.
3. The stream has received all current rows.
4. The two-second grace timer is not continuously reset by an active writer.
5. The client received `stream.end` and did not fail to parse it.

Remember that a cleanup event after terminal status intentionally resets the grace window.

### A command remains on `Loading transcript...`

A completed command should eventually do one of three things:

```text
loaded transcript
error message plus Retry transcript button
```

It should not spin indefinitely. The current implementation keeps in-flight requests alive while
other command events update the reducer. If the problem returns:

1. Refresh the page to reset client state.
2. Inspect the command detail request in Network.
3. Confirm the response is `200` and contains `stdout` and `stderr`.
4. Check the command belongs to the same job id.
5. Check the server route's `getCommand(jobId, commandId)` query.
6. Inspect `job_commands` directly.

A `command.completed` event with a command id but no command row would indicate a broken transaction
boundary or an old incompatible process. With the current code, the row and event commit together.

### No command rows appear

M3 only shows real sandbox commands. If the worker is running with:

```text
RIVET_SANDBOX=off
```

it uses the simulated pipeline and will not produce the provisioning and baseline command ledger.
For the live command demo, use the default Docker mode and ensure Docker is running.

The five simulated phases also do not invoke `PhaseContext.exec()`. Their observable output is phase
lifecycle events, not command lifecycle events.

### stdout and stderr look wrong

Check the persisted command detail rather than the timeline. M3 does not stream bytes; it loads the
bounded final transcript. Verify:

- stdout and stderr are rendered in separate sections
- the command was executed without a TTY
- `truncated` is shown when the output cap was reached
- `timedOut` and `oomKilled` explain killed commands

### JSON works but SSE does not

Compare the requests:

```text
JSON: Accept absent or application/json
SSE:  Accept: text/event-stream
```

The route decides based on the media type, not the URL. A proxy that buffers or caps long responses
can also make a correct SSE route look idle. Heartbeats and `X-Accel-Buffering: no` reduce
buffering, but they cannot make an unsuitable hosting platform support indefinite responses.

### The event query rate is too high

The current cost model is one query per second per visible active page. Check:

- hidden tabs actually close EventSource
- terminal streams receive `stream.end`
- the client is not creating multiple providers for one page
- a browser extension or duplicate component is not opening extra connections

Do not add Redis Pub/Sub just to hide an unmeasured issue. Measure concurrent viewers first.

---

## Part 13. Extending M3 safely

### Add a new event type

1. Add the string to `JOB_EVENT_TYPES`.
2. Add its tone to `JOB_EVENT_TONE`.
3. Define its data fields in `JobEventData` if they are shared and meaningful.
4. Emit it through `appendEvent()` rather than inserting `job_events` directly.
5. Add a timeline rendering detail if the reader needs one.
6. Add producer, route, and reducer tests where relevant.

No database migration is expected for a new event type.

### Add a field to event data

1. Add the optional TypeScript field.
2. Add validation to the serialized event parser.
3. Preserve unknown fields when compatibility requires it.
4. Decide whether the field belongs in the compact timeline event or in a separate detail endpoint.
5. Update the producer and tests.

Avoid putting large command output or model transcripts into event JSON. Events are read in full for
the timeline and replayed over SSE.

### Add a live UI consumer

1. Keep the server-rendered snapshot as initial state.
2. Add a pure reducer action for the durable event.
3. Deduplicate by event id.
4. Make the selector deterministic and sorted.
5. Subscribe through the existing `JobLiveProvider` rather than opening another EventSource.
6. Keep unrelated page fields server-rendered.

One job page should have one stream and one durable cursor.

### Add Pi events in M4

Pi tool activity should use the same observable event path rather than bypassing it with a second
browser transport. The coding-agent adapter can emit structured events, and core or the worker can
persist the durable facts. Keep raw model reasoning out of the event log and UI.

Potential future event categories include:

```text
tool.started
tool.completed
agent.summary
artifact.created
validation.started
validation.completed
```

The exact vocabulary should be driven by the agent integration design, not invented in the browser.

---

## Part 14. Known limits and next milestones

M3 is complete within its intended scope, but it is not a general-purpose event platform:

- One visible active page polls once per second.
- Event history is retained in Postgres without archival or windowing.
- The browser keeps the complete current timeline in memory.
- Output is delivered after command completion, not byte by byte.
- The stream assumes a long-lived Node-compatible host.
- The events route still has no authentication or per-user authorization.
- There is no model call, coding-agent session, checkpoint, or resumable workflow.
- The worker still simulates analysis, planning, implementation, review, and finalization.

M4 can now add the Pi adapter without inventing a new UI transport. The existing path already gives
it:

```text
agent-side durable events -> Postgres -> SSE -> reducer -> observable job page
```

M6 will need to decide how checkpoints interact with this event log. M7 will add broader
deterministic validation. M9 will add identity and authorization, including secure SSE
authentication through the same-origin session rather than a bearer token in the stream URL.

---

## Glossary

| Term                       | Meaning                                                                            |
| -------------------------- | ---------------------------------------------------------------------------------- |
| **SSE**                    | Server-Sent Events, a server-to-browser text stream over HTTP                      |
| **Event source of truth**  | Postgres `job_events`, the durable append-only history                             |
| **Cursor**                 | The last durable event id a viewer has received                                    |
| **Last-Event-ID**          | The SSE request header browsers send when reconnecting                             |
| **At-least-once delivery** | A durable event may be delivered more than once across reconnect boundaries        |
| **Idempotent reducer**     | Client reduction that produces the same visible state when an event repeats        |
| **Terminal grace**         | The short quiet period after terminal status before stream closure                 |
| **Command execution id**   | UUID correlating start, completion, and failure events                             |
| **Command id**             | Durable `job_commands` row id, available after execution returns                   |
| **Summary**                | Command metadata without stdout or stderr                                          |
| **Transcript**             | Bounded stdout and stderr stored in `job_commands`                                 |
| **Content negotiation**    | Selecting JSON or SSE based on the `Accept` header                                 |
| **Database tailer**        | A consumer that repeatedly queries durable rows instead of receiving broker pushes |

---

## Where to go next

- `docs/architecture.md` - current-system reference
- `docs/milestone-1-guide.md` - leases, workers, retries, and reconciliation
- `docs/milestone-2-guide.md` - Docker sandbox, command execution, and baseline testing
- `apps/web/lib/events/stream-job-events.ts` - server-side stream loop
- `apps/web/components/job-live/stream-state.ts` - pure browser state machine
- `apps/web/tests/streaming/events.stream.test.ts` - actual route and Postgres proof
- `packages/core/src/pipeline/phase-context.ts` - command lifecycle producer
- `apps/web/components/job-live/job-live-provider.tsx` - EventSource lifecycle and transcript
  fetches
