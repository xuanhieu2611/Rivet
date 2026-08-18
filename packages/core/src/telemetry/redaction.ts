/**
 * The redaction PORT: durable writers need to remove live credentials without
 * knowing where the credentials came from.
 *
 * The worker owns the registry because it owns the credentials. Core only
 * knows this small interface, which keeps the shared package independent of
 * the worker process and makes the safety net injectable in tests. Redaction is
 * deliberately a best-effort safety net rather than a boundary: callers must
 * still avoid putting secrets in argv, remote URLs or sandbox environments.
 */
export interface Redactor {
  /** Replaces registered secrets in one text value. */
  redact(value: string): string;
  /** Replaces registered secrets throughout a bounded structured value. */
  redactDeep(value: unknown): unknown;
}
