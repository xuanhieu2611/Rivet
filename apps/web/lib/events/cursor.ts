/**
 * A parsed event cursor.
 *
 * `null` means that no cursor was supplied. `undefined` is reserved for a
 * supplied value that is not a safe, non-negative integer, so routes can return
 * a 400 instead of silently replaying the timeline from the beginning.
 */
export type ParsedEventCursor = number | null | undefined;

/** Parses either `?after=` or `Last-Event-ID`. */
export function parseEventCursor(raw: string | null | undefined): ParsedEventCursor {
  if (raw === null || raw === undefined) return null;

  const value = raw.trim();
  if (value === "") return null;

  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0) return undefined;
  return parsed;
}

/**
 * Resolves the first cursor for a request.
 *
 * A reconnect can carry an old `after` query parameter and a newer
 * `Last-Event-ID` header. Taking the maximum makes the request safe even when
 * the browser reuses the original URL.
 */
export function resolveEventCursor(
  after: string | null | undefined,
  lastEventId: string | null | undefined,
): number | null | undefined {
  const parsedAfter = parseEventCursor(after);
  const parsedLastEventId = parseEventCursor(lastEventId);

  if (parsedAfter === undefined || parsedLastEventId === undefined) return undefined;
  if (parsedAfter === null) return parsedLastEventId;
  if (parsedLastEventId === null) return parsedAfter;
  return Math.max(parsedAfter, parsedLastEventId);
}
