import { describe, expect, it, vi } from "vitest";

import { EventBuffer } from "./event-buffer";

/**
 * What the bridge between a pushing harness and a pulling port has to survive.
 *
 * The bound is the part worth testing: it is the only thing standing between a
 * harness that cannot be slowed down and a worker process that grows until it
 * dies. The drop policy matters almost as much - a timeline that quietly loses
 * its most recent rows is worse than one that loses its oldest.
 */

async function drain<T>(buffer: EventBuffer<T>): Promise<T[]> {
  const seen: T[] = [];
  for await (const event of buffer) seen.push(event);
  return seen;
}

describe("EventBuffer", () => {
  it("delivers everything pushed before it is closed", async () => {
    const buffer = new EventBuffer<number>({ capacity: 10, onDrop: () => undefined });
    buffer.push(1);
    buffer.push(2);
    buffer.close();

    expect(await drain(buffer)).toEqual([1, 2]);
  });

  it("drains what is queued before ending, so the last events survive", async () => {
    const buffer = new EventBuffer<string>({ capacity: 10, onDrop: () => undefined });
    buffer.push("session_ended");
    buffer.close();

    expect(await drain(buffer)).toEqual(["session_ended"]);
  });

  it("hands an event straight to a waiting consumer", async () => {
    const buffer = new EventBuffer<number>({ capacity: 2, onDrop: () => undefined });
    const collected = drain(buffer);

    // The consumer is already parked on an empty queue at this point.
    await Promise.resolve();
    buffer.push(7);
    buffer.close();

    expect(await collected).toEqual([7]);
  });

  it("drops the oldest event once the bound is reached, and says how many", async () => {
    const onDrop = vi.fn();
    const buffer = new EventBuffer<number>({ capacity: 2, onDrop });

    buffer.push(1);
    buffer.push(2);
    buffer.push(3);
    buffer.push(4);
    buffer.close();

    // The two most recent survive: a viewer is looking at the end of a
    // timeline, not the beginning of a backlog.
    expect(await drain(buffer)).toEqual([3, 4]);
    expect(buffer.dropped).toBe(2);
    expect(onDrop).toHaveBeenLastCalledWith(2);
  });

  it("makes the consumer throw what the producer failed with", async () => {
    const buffer = new EventBuffer<number>({ capacity: 4, onDrop: () => undefined });
    const failure = new Error("the provider hung up");
    buffer.push(1);
    buffer.fail(failure);

    await expect(drain(buffer)).rejects.toThrow("the provider hung up");
  });

  it("ignores pushes after it has ended", async () => {
    const buffer = new EventBuffer<number>({ capacity: 4, onDrop: () => undefined });
    buffer.close();
    buffer.push(1);

    expect(await drain(buffer)).toEqual([]);
  });
});
