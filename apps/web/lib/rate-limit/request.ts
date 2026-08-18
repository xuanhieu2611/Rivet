/**
 * Returns the address used for unauthenticated rate limits. The first
 * X-Forwarded-For value is the client address when Rivet is behind a trusted
 * reverse proxy; direct requests fall back to the platform's remote address.
 */
export function requestAddress(request: Request): string {
  const forwarded = request.headers.get("x-forwarded-for");
  const firstForwarded = forwarded?.split(",", 1)[0]?.trim();
  const address = firstForwarded ?? request.headers.get("x-real-ip")?.trim();
  return address === undefined || address === "" ? "unknown" : address;
}

/** Stable namespace prevents unrelated Redis keys from sharing a bucket. */
export function rateLimitKey(scope: string, identity: string): string {
  return `rivet:rate-limit:${scope}:${identity}`;
}
