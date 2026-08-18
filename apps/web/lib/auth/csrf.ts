import { NextResponse } from "next/server";

/**
 * Same-origin protection for browser mutations. Missing Origin is accepted for
 * trusted non-browser callers and tests; when a browser sends it, it must match
 * the request Host exactly. A cross-origin Origin or Host is never accepted.
 */
export function csrfFailure(request: Request): NextResponse | null {
  const url = new URL(request.url);
  const host = request.headers.get("host");
  if (host && host !== url.host) {
    return forbidden();
  }

  const origin = request.headers.get("origin");
  if (origin === "null") return forbidden();
  if (origin) {
    const expectedOrigin = `${url.protocol}//${host ?? url.host}`;
    if (origin !== expectedOrigin) return forbidden();
  }

  return null;
}

function forbidden(): NextResponse {
  return NextResponse.json(
    { error: "Cross-site requests are not allowed for this operation." },
    { status: 403 },
  );
}
