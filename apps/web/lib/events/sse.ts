/** One frame in the Server-Sent Events wire format. */
export interface SseFrame {
  /** The durable event id used by EventSource as its reconnect cursor. */
  id?: number | string;
  event?: string;
  /** Strings are written as raw SSE data; all other values are JSON encoded. */
  data?: unknown;
}

/** Encodes one data frame and terminates it with the required blank line. */
export function encodeSseFrame(frame: SseFrame): string {
  const lines: string[] = [];

  if (frame.id !== undefined) {
    lines.push(`id: ${singleLineValue(frame.id, "id")}`);
  }
  if (frame.event !== undefined) {
    lines.push(`event: ${singleLineValue(frame.event, "event")}`);
  }
  if (frame.data !== undefined) {
    const serialized = typeof frame.data === "string" ? frame.data : JSON.stringify(frame.data);
    if (serialized === undefined) {
      throw new TypeError("SSE data must be serializable.");
    }
    for (const line of normalizeLineEndings(serialized).split("\n")) {
      lines.push(`data: ${line}`);
    }
  }

  return `${lines.join("\n")}\n\n`;
}

/** Encodes an SSE comment, used for connection and keepalive frames. */
export function encodeSseComment(comment = ""): string {
  return `${normalizeLineEndings(comment)
    .split("\n")
    .map((line) => `: ${line}`)
    .join("\n")}\n\n`;
}

/** Encodes the reconnection delay advertised to EventSource. */
export function encodeSseRetry(milliseconds: number): string {
  if (!Number.isSafeInteger(milliseconds) || milliseconds < 0) {
    throw new RangeError("SSE retry must be a non-negative safe integer.");
  }
  return `retry: ${String(milliseconds)}\n\n`;
}

function normalizeLineEndings(value: string): string {
  return value.replace(/\r\n?/g, "\n");
}

function singleLineValue(value: number | string, field: string): string {
  const stringValue = String(value);
  if (/[\r\n]/.test(stringValue)) {
    throw new Error(`SSE ${field} cannot contain a newline.`);
  }
  return stringValue;
}
