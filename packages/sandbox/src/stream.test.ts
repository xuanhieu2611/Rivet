import { describe, expect, it } from "vitest";

import { CappedOutput, DockerStreamDemuxer, encodeFrame } from "./stream";

/**
 * The frame parser is the easiest thing in this package to get subtly wrong and
 * the only part of it that can be tested without a daemon, so it is tested
 * hard: split frames, lone headers, one byte at a time, interleaved streams.
 */
function demux(chunks: Buffer[]): { stdout: string; stderr: string; dangling: number } {
  const stdout = new CappedOutput(1_000_000);
  const stderr = new CappedOutput(1_000_000);
  const demuxer = new DockerStreamDemuxer(stdout, stderr);
  for (const chunk of chunks) demuxer.push(chunk);
  return {
    stdout: stdout.text().text,
    stderr: stderr.text().text,
    dangling: demuxer.danglingBytes,
  };
}

describe("DockerStreamDemuxer", () => {
  it("separates stdout from stderr", () => {
    const result = demux([encodeFrame(1, "out"), encodeFrame(2, "err")]);

    expect(result.stdout).toBe("out");
    expect(result.stderr).toBe("err");
  });

  it("keeps interleaved frames in order within each stream", () => {
    const result = demux([
      encodeFrame(1, "one "),
      encodeFrame(2, "problem "),
      encodeFrame(1, "two "),
      encodeFrame(2, "trouble"),
      encodeFrame(1, "three"),
    ]);

    expect(result.stdout).toBe("one two three");
    expect(result.stderr).toBe("problem trouble");
  });

  it("reassembles a frame split across chunks", () => {
    const frame = encodeFrame(1, "hello world");
    const result = demux([frame.subarray(0, 10), frame.subarray(10)]);

    expect(result.stdout).toBe("hello world");
  });

  it("survives a header arriving on its own", () => {
    const frame = encodeFrame(1, "payload");
    const result = demux([frame.subarray(0, 8), frame.subarray(8)]);

    expect(result.stdout).toBe("payload");
  });

  it("survives a header arriving one byte at a time", () => {
    const stream = Buffer.concat([encodeFrame(1, "a"), encodeFrame(2, "b"), encodeFrame(1, "c")]);
    const result = demux([...stream].map((byte) => Buffer.from([byte])));

    expect(result.stdout).toBe("ac");
    expect(result.stderr).toBe("b");
  });

  it("handles several whole frames arriving in one chunk", () => {
    const result = demux([
      Buffer.concat([encodeFrame(1, "a"), encodeFrame(1, "b"), encodeFrame(2, "c")]),
    ]);

    expect(result.stdout).toBe("ab");
    expect(result.stderr).toBe("c");
  });

  it("drops stdin frames rather than mixing them into stdout", () => {
    const result = demux([encodeFrame(0, "typed"), encodeFrame(1, "printed")]);

    expect(result.stdout).toBe("printed");
    expect(result.stderr).toBe("");
  });

  it("ignores an empty frame", () => {
    const result = demux([encodeFrame(1, ""), encodeFrame(1, "after")]);

    expect(result.stdout).toBe("after");
  });

  it("reports the leftovers when the stream stops mid-frame", () => {
    // What a container killed under a running command actually produces.
    const frame = encodeFrame(1, "cut short here");
    const result = demux([frame.subarray(0, 12)]);

    expect(result.stdout).toBe("cut ");
    expect(result.dangling).toBe(0);
  });

  it("reports a truncated header as dangling bytes", () => {
    const result = demux([encodeFrame(1, "x").subarray(0, 5)]);

    expect(result.dangling).toBe(5);
    expect(result.stdout).toBe("");
  });

  it("carries a payload larger than any one chunk", () => {
    const payload = "y".repeat(100_000);
    const frame = encodeFrame(1, payload);
    const chunks: Buffer[] = [];
    for (let offset = 0; offset < frame.byteLength; offset += 4096) {
      chunks.push(frame.subarray(offset, offset + 4096));
    }

    expect(demux(chunks).stdout).toBe(payload);
  });
});

describe("CappedOutput", () => {
  it("returns everything it was given when it stays under the cap", () => {
    const output = new CappedOutput(100);
    output.push(Buffer.from("hello "));
    output.push(Buffer.from("world"));

    expect(output.text()).toEqual({ text: "hello world", truncated: false, elidedBytes: 0 });
    expect(output.byteLength).toBe(11);
  });

  it("keeps both ends and states what it dropped", () => {
    const output = new CappedOutput(20);
    output.push(Buffer.from("a".repeat(50)));
    output.push(Buffer.from("b".repeat(50)));

    const result = output.text();
    expect(result.truncated).toBe(true);
    expect(result.text.startsWith("a".repeat(10))).toBe(true);
    expect(result.text.endsWith("b".repeat(10))).toBe(true);
    expect(result.elidedBytes).toBe(80);
  });

  it("keeps the tail across many small chunks, which is the point of the ring", () => {
    const output = new CappedOutput(20);
    for (let index = 0; index < 1000; index += 1) output.push(Buffer.from("."));
    output.push(Buffer.from("THE END"));

    expect(output.text().text.endsWith("THE END")).toBe(true);
  });

  it("counts every byte it ever saw, not the ones it kept", () => {
    const output = new CappedOutput(10);
    output.push(Buffer.from("z".repeat(5000)));

    expect(output.byteLength).toBe(5000);
    expect(output.text().elidedBytes).toBe(4990);
  });

  it("does not cut a multi-byte character in half at a chunk boundary", () => {
    const output = new CappedOutput(1_000_000);
    const rocket = Buffer.from("🚀", "utf8");
    output.push(rocket.subarray(0, 2));
    output.push(rocket.subarray(2));

    expect(output.text().text).toBe("🚀");
  });
});
