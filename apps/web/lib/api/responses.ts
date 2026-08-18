import { NextResponse } from "next/server";
import type { z } from "zod";

/** The slice of a pino logger this module uses. Structured first, message second. */
export interface ErrorLogger {
  error(details: Record<string, unknown>, message: string): void;
}

/**
 * The one error envelope every Rivet route handler returns.
 *
 * `fieldErrors` is only present on validation failures and is keyed by the field
 * names in `@rivet/contracts`, so the client form can drop them straight onto
 * the matching inputs.
 */
export interface ApiErrorBody {
  error: string;
  fieldErrors?: Record<string, string[]>;
}

export function badRequest(error: string, fieldErrors?: Record<string, string[]>) {
  const body: ApiErrorBody = fieldErrors ? { error, fieldErrors } : { error };
  return NextResponse.json(body, { status: 400 });
}

export function notFound(error = "Not found.") {
  return NextResponse.json({ error } satisfies ApiErrorBody, { status: 404 });
}

/**
 * The request was well formed but the resource is in the wrong state for it.
 *
 * `details` is merged into the body so the client can act on the state it lost
 * the race to - cancelling a job that just completed comes back with the status
 * that made the request moot, which is more useful than the sentence explaining
 * it.
 */
export function conflict(error: string, details?: Record<string, unknown>) {
  const body: ApiErrorBody & Record<string, unknown> = { error, ...details };
  return NextResponse.json(body, { status: 409 });
}

/**
 * Turns a Zod failure into a 400 with per-field messages.
 *
 * Walks `issues` rather than using `z.flattenError`, because the flattened type
 * collapses to `{}` once the schema's input type is erased at the call site, and
 * the field keys are exactly what the client form needs.
 */
export function validationFailed(error: z.ZodError, message = "Validation failed.") {
  const fieldErrors: Record<string, string[]> = {};
  const formErrors: string[] = [];

  for (const issue of error.issues) {
    const [key] = issue.path;
    if (typeof key === "string") {
      (fieldErrors[key] ??= []).push(issue.message);
    } else {
      formErrors.push(issue.message);
    }
  }

  const hasFieldErrors = Object.keys(fieldErrors).length > 0;
  return badRequest(formErrors[0] ?? message, hasFieldErrors ? fieldErrors : undefined);
}

/**
 * Logs the real cause server-side and returns a generic 500.
 *
 * Database errors carry table names, column names and sometimes connection
 * details; none of that goes over the wire.
 *
 * `log` is Milestone 11's addition and is the request's own child logger, so a
 * 500 arrives already carrying the request id, the route and the trace and span
 * ids of the request that caused it. It stays optional because a handler that
 * has not been given one is better served by `console.error` than by no record
 * at all - but every route in this app passes it.
 */
export function serverError(context: string, cause: unknown, log?: ErrorLogger) {
  if (log) log.error({ err: cause }, `${context} failed`);
  else console.error(`[${context}]`, cause);
  return NextResponse.json(
    { error: "Something went wrong. Please try again." } satisfies ApiErrorBody,
    { status: 500 },
  );
}

/**
 * Reads and JSON-parses a request body.
 *
 * Wrapped in an object so a body that is legitimately `null` is distinguishable
 * from a body that failed to parse.
 */
export async function readJsonBody(request: Request): Promise<{ value: unknown } | null> {
  try {
    return { value: await request.json() };
  } catch {
    return null;
  }
}
