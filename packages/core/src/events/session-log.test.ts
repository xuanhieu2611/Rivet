import { describe, expect, it } from "vitest";

import { type MessageEventLike, summaryFrom } from "./session-log";

/**
 * The read side of the implementation summary, against a synthetic event list.
 *
 * No database on purpose, the same split `baseline-log.test.ts` makes: "which of
 * these rows is the summary" is the whole of the logic and `readSummary` is one
 * query around it.
 */

const said = (message: string): MessageEventLike => ({ type: "agent.message", message });

describe("summaryFrom", () => {
  it("reads back the last thing the model said", () => {
    expect(
      summaryFrom([said("Looking at the discount rule."), said("Fixed the comparison.")]),
    ).toBe("Fixed the comparison.");
  });

  it("returns null when the session never spoke, which is not an empty summary", () => {
    // The two cases that produce this: a session that ended on a tool call, and
    // a job that reached `finalizing` without ever running one. `finalizing`
    // records the absence rather than synthesizing a summary from the diff.
    expect(summaryFrom([])).toBeNull();
    expect(
      summaryFrom([{ type: "agent.session_ended", message: "Session ended: completed." }]),
    ).toBeNull();
  });

  it("ignores every other event type, including ones carrying prose", () => {
    expect(
      summaryFrom([
        said("Fixed the comparison."),
        { type: "agent.tool_completed", message: "bash finished." },
        { type: "phase.completed", message: "Implement change completed" },
      ]),
    ).toBe("Fixed the comparison.");
  });

  it("skips a trailing empty message rather than letting it replace a real one", () => {
    // A model that ends on whitespace has said nothing, and the alternative
    // would be a summary artifact containing a blank line while a perfectly good
    // sentence sat one row above it.
    expect(summaryFrom([said("Fixed the comparison."), said("   \n ")])).toBe(
      "Fixed the comparison.",
    );
    expect(summaryFrom([said(""), said("")])).toBeNull();
  });

  it("prefers the latest, because a reclaimed attempt runs its own session", () => {
    expect(summaryFrom([said("First attempt."), said("Second attempt.")])).toBe("Second attempt.");
  });
});
