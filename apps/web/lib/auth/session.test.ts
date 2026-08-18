import { describe, expect, it } from "vitest";

import { createSessionToken, readCookieValue, readSessionToken, SESSION_COOKIE } from "./session";

const SECRET = "a sufficiently long test session secret";

describe("signed sessions", () => {
  it("round trips a GitHub login", async () => {
    const token = await createSessionToken("owner", SECRET);
    await expect(readSessionToken(token, SECRET)).resolves.toEqual({ githubLogin: "owner" });
  });

  it("rejects a token signed with another secret", async () => {
    const token = await createSessionToken("owner", SECRET);
    await expect(readSessionToken(token, "a different secret")).resolves.toBeNull();
  });

  it("reads the session cookie without confusing neighboring cookies", () => {
    expect(
      readCookieValue(`other=x; ${SESSION_COOKIE}=hello%20world; last=y`, SESSION_COOKIE),
    ).toBe("hello world");
  });
});
