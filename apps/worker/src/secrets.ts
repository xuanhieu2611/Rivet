/**
 * The live secrets this process holds, and the redaction pass built on them.
 *
 * Milestone 9 is the first milestone where the worker holds a credential that
 * can write to somebody's repository, and PRD §27 asks for secrets redaction
 * from logs. The two halves of that are here: a registry that minted
 * installation tokens are added to as they are created, and a `redact` that the
 * logger applies to every line before it is written.
 *
 * This is a safety net rather than a boundary. Nothing in Rivet deliberately
 * logs a token - `host-git.ts` redacts its own transcripts, the token never
 * enters an argv, a remote URL or `SandboxSpec.env` - and the value of this file
 * is what happens when some future code path is careless, or when a provider
 * error message quotes back the request it was given.
 *
 * Tokens are short-lived, so the registry is bounded by expiry rather than
 * growing for the life of the process: an expired token is no longer a secret
 * and keeping it would make every log line scan a growing list.
 */

/**
 * Below this length a "secret" is more likely to be a substring of ordinary
 * text than a credential, and redacting it would corrupt logs rather than
 * protect anything. GitHub installation tokens are ~40 characters.
 */
const MIN_SECRET_LENGTH = 12;

export const REDACTED = "[REDACTED]";

interface RegisteredSecret {
  value: string;
  expiresAtMs: number;
}

/** How long a secret stays registered past its own expiry. */
const RETENTION_GRACE_MS = 60_000;

export class SecretRegistry {
  private secrets: RegisteredSecret[] = [];

  constructor(private readonly now: () => number = Date.now) {}

  /**
   * Registers a live secret. Values too short to be a credential are ignored,
   * as is a value already registered.
   */
  add(value: string, expiresAt?: Date): void {
    if (value.length < MIN_SECRET_LENGTH) return;

    const expiresAtMs = (expiresAt?.getTime() ?? this.now()) + RETENTION_GRACE_MS;
    const existing = this.secrets.find((secret) => secret.value === value);
    if (existing) {
      existing.expiresAtMs = Math.max(existing.expiresAtMs, expiresAtMs);
      return;
    }
    this.secrets.push({ value, expiresAtMs });
  }

  /** Live secrets, longest first, so an enclosing token wins over a prefix. */
  private live(): string[] {
    const now = this.now();
    this.secrets = this.secrets.filter((secret) => secret.expiresAtMs > now);
    return this.secrets.map((secret) => secret.value).sort((a, b) => b.length - a.length);
  }

  get size(): number {
    return this.live().length;
  }

  /** Replaces every registered secret occurring in `value`. */
  redact(value: string): string {
    let result = value;
    for (const secret of this.live()) {
      if (result.includes(secret)) result = result.split(secret).join(REDACTED);
    }
    return result;
  }

  /**
   * Redacts strings anywhere in a log argument.
   *
   * Depth-bounded because a log argument is occasionally something large or
   * cyclic, and a redaction pass that hangs the worker would be a much worse
   * bug than the one it exists to prevent. Beyond the bound the value is
   * returned untouched, which is the same risk profile as not having this at
   * all rather than a new one.
   */
  redactDeep(value: unknown, depth = 0): unknown {
    if (typeof value === "string") return this.redact(value);
    if (depth >= 6 || value === null || typeof value !== "object") return value;

    if (value instanceof Error) {
      // Errors are rebuilt rather than mutated: the same Error object may be
      // rethrown, and quietly editing a caller's exception is not this
      // function's business.
      const copy = new Error(this.redact(value.message));
      copy.name = value.name;
      if (value.stack) copy.stack = this.redact(value.stack);
      return Object.assign(copy, this.redactDeep({ ...value }, depth + 1));
    }

    if (Array.isArray(value)) {
      return value.map((entry) => this.redactDeep(entry, depth + 1));
    }

    const entries = Object.entries(value as Record<string, unknown>);
    if (entries.length === 0) return value;
    return Object.fromEntries(
      entries.map(([key, entry]) => [key, this.redactDeep(entry, depth + 1)]),
    );
  }
}
