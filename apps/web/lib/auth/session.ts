import { SignJWT, jwtVerify } from "jose";
import type { NextResponse } from "next/server";

export const SESSION_COOKIE = "rivet_session";
export const OAUTH_STATE_COOKIE = "rivet_oauth_state";
export const SESSION_TTL_SECONDS = 7 * 24 * 60 * 60;
export const OAUTH_STATE_TTL_SECONDS = 10 * 60;

const ISSUER = "rivet";
const AUDIENCE = "rivet-web";

export interface RivetSession {
  githubLogin: string;
}

export async function createSessionToken(login: string, secret: string): Promise<string> {
  return new SignJWT({ login })
    .setProtectedHeader({ alg: "HS256", typ: "JWT" })
    .setIssuedAt()
    .setIssuer(ISSUER)
    .setAudience(AUDIENCE)
    .setSubject(login)
    .setExpirationTime(`${SESSION_TTL_SECONDS}s`)
    .sign(secretKey(secret));
}

export async function readSessionToken(
  token: string | undefined,
  secret: string,
): Promise<RivetSession | null> {
  if (!token) return null;

  try {
    const { payload } = await jwtVerify(token, secretKey(secret), {
      issuer: ISSUER,
      audience: AUDIENCE,
    });
    const login = typeof payload.login === "string" ? payload.login : payload.sub;
    return login ? { githubLogin: login } : null;
  } catch {
    return null;
  }
}

export function readCookieValue(header: string | null, name: string): string | undefined {
  if (!header) return undefined;

  for (const part of header.split(";")) {
    const separator = part.indexOf("=");
    if (separator < 0) continue;
    const key = part.slice(0, separator).trim();
    if (key !== name) continue;
    const value = part.slice(separator + 1).trim();
    try {
      return decodeURIComponent(value);
    } catch {
      return value;
    }
  }
  return undefined;
}

export function setSessionCookie(response: NextResponse, token: string, secure: boolean): void {
  response.cookies.set({
    name: SESSION_COOKIE,
    value: token,
    httpOnly: true,
    sameSite: "lax",
    secure,
    path: "/",
    maxAge: SESSION_TTL_SECONDS,
  });
}

export function clearAuthCookies(response: NextResponse, secure: boolean): void {
  response.cookies.set({
    name: SESSION_COOKIE,
    value: "",
    httpOnly: true,
    sameSite: "lax",
    secure,
    path: "/",
    maxAge: 0,
  });
  clearOAuthStateCookie(response, secure);
}

export function clearOAuthStateCookie(response: NextResponse, secure: boolean): void {
  response.cookies.set({
    name: OAUTH_STATE_COOKIE,
    value: "",
    httpOnly: true,
    sameSite: "lax",
    secure,
    path: "/",
    maxAge: 0,
  });
}

export function setOAuthStateCookie(response: NextResponse, state: string, secure: boolean): void {
  response.cookies.set({
    name: OAUTH_STATE_COOKIE,
    value: state,
    httpOnly: true,
    sameSite: "lax",
    secure,
    path: "/",
    maxAge: OAUTH_STATE_TTL_SECONDS,
  });
}

function secretKey(secret: string): Uint8Array {
  return new TextEncoder().encode(secret);
}
