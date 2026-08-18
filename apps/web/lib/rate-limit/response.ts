import { NextResponse } from "next/server";

import type { RateLimitResult } from "@rivet/queue";

export function rateLimitExceeded(
  name: string,
  limit: number,
  result: RateLimitResult,
): NextResponse {
  const retryAfterSeconds = Math.max(1, Math.ceil((result.resetAt - Date.now()) / 1_000));
  return NextResponse.json(
    {
      error: `Rate limit exceeded: ${name}.`,
      limit: name,
      limitValue: limit,
      resetAt: new Date(result.resetAt).toISOString(),
      retryAfterSeconds,
    },
    {
      status: 429,
      headers: { "Retry-After": String(retryAfterSeconds) },
    },
  );
}

export function activeJobCapExceeded(limit: number, activeCount: number): NextResponse {
  return NextResponse.json(
    {
      error: "Rate limit exceeded: active non-terminal jobs.",
      limit: "active_jobs",
      limitValue: limit,
      activeCount,
      resetAt: null,
      resetHint: "Retry when a non-terminal job reaches a terminal status.",
    },
    { status: 429 },
  );
}

export function rateLimitUnavailable(): NextResponse {
  return NextResponse.json(
    {
      error: "Rate limiting is temporarily unavailable; request refused closed.",
      limit: "rate_limiter",
      retryHint: "Retry after Redis is available.",
    },
    { status: 503 },
  );
}
