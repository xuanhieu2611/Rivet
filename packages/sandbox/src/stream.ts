import { renderTruncated, type TruncatedText, truncationSplit } from "@rivet/core";

/**
 * Docker's multiplexed stream format, and the bounded buffers it feeds.
 *
 * Everything in this file is pure: bytes in, bytes out, no daemon, no sockets.
 * That is deliberate, because the frame parser is the easiest thing in this
 * package to get subtly wrong - frames split across chunk boundaries, a header
 * arriving on its own, stdout and stderr interleaved - and a pure function is
 * one that can be tested exhaustively without a container.
 */

/**
 * When an exec is attached without a TTY, the daemon does not hand back raw
 * bytes. It hands back frames:
 *
 * ```text
 * byte 0     stream type: 0 stdin, 1 stdout, 2 stderr
 * bytes 1-3  zero padding
 * bytes 4-7  payload length, big-endian uint32
 * bytes 8..  the payload
 * ```
 *
 * This is the only reason stdout and stderr can be reported separately at all.
 * With a TTY the two are merged into one stream by the pty and no amount of
 * parsing gets them back, which is why every exec here sets `Tty: false`.
 */
const HEADER_BYTES = 8;
const STDOUT_STREAM = 1;
const STDERR_STREAM = 2;

const EMPTY = Buffer.alloc(0);

/**
 * A transcript buffer that holds a bounded amount of memory.
 *
 * The cap is the point. A build that prints a gigabyte must not cost a
 * gigabyte of worker heap, and "keep everything and truncate at the end" is the
 * implementation that quietly does exactly that. So this keeps the first
 * `maxBytes` and a rolling window of the last few, counts everything it sees,
 * and lets `@rivet/core` render the result so the elision marker is produced in
 * one place.
 */
export class CappedOutput {
  private readonly limit: number;
  private readonly tailTarget: number;

  /** The first `limit` bytes, which is enough for both branches of `text()`. */
  private head: Buffer = EMPTY;

  /** A rolling window holding at least the last `tailTarget` bytes. */
  private tailChunks: Buffer[] = [];
  private tailBytes = 0;

  private total = 0;

  constructor(maxBytes: number) {
    this.limit = Math.max(0, Math.floor(maxBytes));
    this.tailTarget = truncationSplit(this.limit).tailBytes;
  }

  /** Total bytes written, including the ones dropped. */
  get byteLength(): number {
    return this.total;
  }

  push(chunk: Buffer): void {
    if (chunk.byteLength === 0) return;
    this.total += chunk.byteLength;

    if (this.head.byteLength < this.limit) {
      const room = this.limit - this.head.byteLength;
      this.head = Buffer.concat([this.head, chunk.subarray(0, room)]);
    }

    if (this.tailTarget > 0) {
      this.tailChunks.push(chunk);
      this.tailBytes += chunk.byteLength;
      // Drop from the front only while the window would still be long enough
      // without it, so the last `tailTarget` bytes are always still in here.
      while (
        this.tailChunks.length > 1 &&
        this.tailBytes - this.tailChunks[0]!.byteLength >= this.tailTarget
      ) {
        this.tailBytes -= this.tailChunks.shift()!.byteLength;
      }
    }
  }

  text(): TruncatedText {
    if (this.total <= this.limit) {
      return { text: this.head.toString("utf8"), truncated: false, elidedBytes: 0 };
    }

    const { headBytes, tailBytes } = truncationSplit(this.limit);
    const window = Buffer.concat(this.tailChunks);
    const tail = tailBytes === 0 ? EMPTY : window.subarray(window.byteLength - tailBytes);
    return renderTruncated(
      this.head.subarray(0, headBytes),
      tail,
      this.total - headBytes - tailBytes,
    );
  }
}

/**
 * Splits Docker's framed stream back into stdout and stderr.
 *
 * Fed one chunk at a time as the socket delivers them, which means no chunk
 * boundary can be assumed to line up with a frame boundary: a header can arrive
 * three bytes at a time, and a single chunk can carry the end of one frame, two
 * whole frames and the start of a fourth. The parser therefore keeps its
 * leftover bytes and how much of the current payload it still owes, and never
 * looks at anything else.
 */
export class DockerStreamDemuxer {
  private buffered: Buffer = EMPTY;
  private remaining = 0;
  private stream = STDOUT_STREAM;

  constructor(
    private readonly stdout: CappedOutput,
    private readonly stderr: CappedOutput,
  ) {}

  push(chunk: Buffer): void {
    this.buffered = this.buffered.byteLength === 0 ? chunk : Buffer.concat([this.buffered, chunk]);

    for (;;) {
      if (this.remaining > 0) {
        if (this.buffered.byteLength === 0) return;
        const take = Math.min(this.remaining, this.buffered.byteLength);
        this.sinkFor(this.stream)?.push(this.buffered.subarray(0, take));
        this.buffered = this.buffered.subarray(take);
        this.remaining -= take;
        continue;
      }

      if (this.buffered.byteLength < HEADER_BYTES) return;
      this.stream = this.buffered[0]!;
      this.remaining = this.buffered.readUInt32BE(4);
      this.buffered = this.buffered.subarray(HEADER_BYTES);
    }
  }

  /**
   * Bytes received that were not part of any complete frame.
   *
   * Non-zero means the daemon stopped mid-frame, which is what happens when the
   * container is killed underneath a running command. It is not an error - the
   * caller already knows the command was killed - but it is worth being able to
   * assert on.
   */
  get danglingBytes(): number {
    return this.buffered.byteLength;
  }

  /** Stdin frames exist in the format and are dropped: nothing ever writes stdin. */
  private sinkFor(stream: number): CappedOutput | undefined {
    if (stream === STDOUT_STREAM) return this.stdout;
    if (stream === STDERR_STREAM) return this.stderr;
    return undefined;
  }
}

/** Builds one frame. Test-facing, and the only place the format is written rather than read. */
export function encodeFrame(stream: 0 | 1 | 2, payload: Buffer | string): Buffer {
  const body = typeof payload === "string" ? Buffer.from(payload, "utf8") : payload;
  const header = Buffer.alloc(HEADER_BYTES);
  header[0] = stream;
  header.writeUInt32BE(body.byteLength, 4);
  return Buffer.concat([header, body]);
}
