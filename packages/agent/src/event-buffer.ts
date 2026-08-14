/**
 * The bridge between a harness that pushes and a port that pulls.
 *
 * `AgentSession.subscribe` takes a listener returning `void`, so there is no
 * way to tell the harness to slow down: whatever the listener does, the next
 * event arrives when the next event arrives. `CodingAgentSession.run` is an
 * `AsyncIterable` for the opposite reason - each event the phase consumes may
 * become a row in Postgres, and a consumer that cannot apply backpressure is an
 * unbounded buffer with a schedule.
 *
 * Something has to absorb that difference, and this is it. Being explicit about
 * the bound is the point: an unbounded queue here would be the memory leak the
 * port's comments warn about, only hidden one layer deeper.
 *
 * **The bound is not the real defence.** Almost every event this carries is
 * produced while the harness is awaiting one of Rivet's own tool calls, so the
 * production rate is already tied to how fast the sandbox answers. The queue
 * exists for the case where that reasoning turns out to be wrong - a harness
 * version that batches, a provider that streams a hundred messages a second -
 * and its job then is to keep the session alive and say what it lost, rather
 * than to grow until the worker dies.
 */

export interface EventBufferOptions {
  /** How many events may wait for the consumer before the oldest is dropped. */
  capacity: number;
  /** Called once per dropped event, with the running total. */
  onDrop: (dropped: number) => void;
}

export class EventBuffer<T> {
  private readonly queue: T[] = [];
  private waiting: ((value: IteratorResult<T>) => void) | undefined;
  private closed = false;
  private failure: unknown;
  private droppedCount = 0;

  constructor(private readonly options: EventBufferOptions) {}

  /** How many events were discarded because the consumer fell behind. */
  get dropped(): number {
    return this.droppedCount;
  }

  /**
   * Offers one event, dropping the oldest queued one if there is no room.
   *
   * Oldest rather than newest, because the timeline is read forwards and the
   * most recent events are the ones a reader is looking at. Losing the front of
   * a backlog degrades the record; losing the back of it degrades what the
   * viewer is watching right now.
   */
  push(event: T): void {
    if (this.closed) return;

    const waiting = this.waiting;
    if (waiting) {
      this.waiting = undefined;
      waiting({ value: event, done: false });
      return;
    }

    if (this.queue.length >= this.options.capacity) {
      this.queue.shift();
      this.droppedCount += 1;
      this.options.onDrop(this.droppedCount);
    }
    this.queue.push(event);
  }

  /**
   * Ends the stream once everything already queued has been consumed.
   *
   * Draining rather than discarding: the events that describe how a session
   * finished are the last ones in, and closing over them would lose exactly the
   * part of the timeline that explains the outcome.
   */
  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.wake();
  }

  /** Ends the stream by making the consumer's next pull throw. */
  fail(error: unknown): void {
    if (this.closed) return;
    this.failure = error;
    this.closed = true;
    this.wake();
  }

  /**
   * One consumer, and only one.
   *
   * A second iterator would silently split the event stream between two
   * readers, which is the kind of bug that looks like "some events go missing
   * sometimes". There is no use for a second one here, so it is not offered.
   */
  async *[Symbol.asyncIterator](): AsyncIterator<T> {
    for (;;) {
      const queued = this.queue.shift();
      if (queued !== undefined) {
        yield queued;
        continue;
      }

      if (this.closed) {
        // A rethrow of whatever the producer failed with, not a new throw: the
        // consumer must see the original error, and wrapping it here would put
        // this file's name on a failure that belongs to the harness.
        // eslint-disable-next-line @typescript-eslint/only-throw-error
        if (this.failure !== undefined) throw this.failure;
        return;
      }

      const next = await new Promise<IteratorResult<T>>((resolve) => {
        this.waiting = resolve;
      });
      if (next.done) continue;
      yield next.value;
    }
  }

  /** Releases a consumer parked on an empty queue so it can re-read the state. */
  private wake(): void {
    const waiting = this.waiting;
    if (!waiting) return;
    this.waiting = undefined;
    waiting({ value: undefined as never, done: true });
  }
}
