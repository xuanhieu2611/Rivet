import { describe, expect, it } from "vitest";

import { REDACTED, SecretRegistry } from "./secrets";

const TOKEN = "ghs_sentineltokenvalue0123456789";

describe("SecretRegistry", () => {
  it("replaces a registered secret wherever it appears", () => {
    const secrets = new SecretRegistry();
    secrets.add(TOKEN);

    expect(secrets.redact(`cloning with ${TOKEN} now`)).toBe(`cloning with ${REDACTED} now`);
    expect(secrets.redact(`${TOKEN}${TOKEN}`)).toBe(`${REDACTED}${REDACTED}`);
  });

  it("leaves text alone when nothing is registered", () => {
    // Every run with RIVET_GITHUB=off, which is CI and every existing suite.
    expect(new SecretRegistry().redact(`plain ${TOKEN}`)).toBe(`plain ${TOKEN}`);
  });

  it("ignores values too short to be a credential", () => {
    // Redacting a short string would corrupt ordinary log lines while
    // protecting nothing: a four-character "secret" is a substring of prose.
    const secrets = new SecretRegistry();
    secrets.add("abc");

    expect(secrets.size).toBe(0);
    expect(secrets.redact("abc def")).toBe("abc def");
  });

  it("forgets a secret once it has expired", () => {
    // Installation tokens live an hour. Keeping every one this process ever
    // minted would make each log line scan a list that only grows.
    let now = 1_000_000;
    const secrets = new SecretRegistry(() => now);
    secrets.add(TOKEN, new Date(now + 1_000));

    expect(secrets.redact(TOKEN)).toBe(REDACTED);
    now += 1_000 + 60_000 + 1;
    expect(secrets.redact(TOKEN)).toBe(TOKEN);
    expect(secrets.size).toBe(0);
  });

  it("redacts strings anywhere in a log argument", () => {
    const secrets = new SecretRegistry();
    secrets.add(TOKEN);

    expect(
      secrets.redactDeep({
        argv: ["git", "push", `https://x-access-token:${TOKEN}@github.com/acme/widgets`],
        nested: { deeper: { value: TOKEN } },
        untouched: 42,
      }),
    ).toEqual({
      argv: ["git", "push", `https://x-access-token:${REDACTED}@github.com/acme/widgets`],
      nested: { deeper: { value: REDACTED } },
      untouched: 42,
    });
  });

  it("redacts an error's message and stack without mutating it", () => {
    const secrets = new SecretRegistry();
    secrets.add(TOKEN);
    const error = new Error(`push failed for ${TOKEN}`);

    const redacted = secrets.redactDeep(error) as Error;

    expect(redacted.message).toBe(`push failed for ${REDACTED}`);
    expect(redacted.stack).not.toContain(TOKEN);
    // The caller's exception may be rethrown; editing it is not this
    // function's business.
    expect(error.message).toBe(`push failed for ${TOKEN}`);
  });

  it("stops at a bounded depth rather than walking forever", () => {
    const secrets = new SecretRegistry();
    secrets.add(TOKEN);
    const cyclic: Record<string, unknown> = { value: TOKEN };
    cyclic.self = cyclic;

    // The point of the bound: a redaction pass that hangs the worker would be a
    // worse bug than the one it exists to prevent.
    expect(() => secrets.redactDeep(cyclic)).not.toThrow();
  });
});
