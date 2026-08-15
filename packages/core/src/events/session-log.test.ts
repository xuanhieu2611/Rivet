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
const started = (): MessageEventLike => ({
  type: "agent.session_started",
  message: "Started deepseek/deepseek-v4-flash on openrouter.",
});
type AgentRole = NonNullable<MessageEventLike["agentRole"]>;

const roleStarted = (agentRole: AgentRole): MessageEventLike => ({
  type: "agent.session_started",
  message: "Started a session.",
  agentRole,
});
const roleSaid = (message: string, agentRole: AgentRole): MessageEventLike => ({
  type: "agent.message",
  message,
  agentRole,
});

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

  it("stops at the newest session, so a silent one inherits nothing", () => {
    // The Milestone 6 case. Worker A's session said something and was killed;
    // worker B's replacement session ended on a tool call. Reporting A's closing
    // message as B's account of the run would be a summary of work by a process
    // that is no longer running, presented as if it were current.
    expect(
      summaryFrom([
        started(),
        said("Corrected the addition; the test still needs updating."),
        started(),
        { type: "agent.tool_completed", message: "bash finished." },
      ]),
    ).toBeNull();
  });

  it("reads the newest session's own summary when it has one", () => {
    expect(
      summaryFrom([started(), said("First attempt."), started(), said("Second attempt.")]),
    ).toBe("Second attempt.");
  });

  it("ignores the planner's messages, which precede every implementation session", () => {
    expect(summaryFrom([started(), said("Here is my plan."), started(), said("Fixed it.")])).toBe(
      "Fixed it.",
    );
  });

  it("keeps the implementation summary when a reviewer runs afterward", () => {
    expect(
      summaryFrom(
        [
          roleStarted("planner"),
          roleSaid("Here is my plan.", "planner"),
          roleStarted("implementer"),
          roleSaid("Fixed the order total.", "implementer"),
          roleStarted("reviewer"),
          roleSaid("The patch needs one boundary fix.", "reviewer"),
        ],
        "implementer",
      ),
    ).toBe("Fixed the order total.");
  });

  it("does not inherit an older implementation summary after a silent retry", () => {
    expect(
      summaryFrom(
        [
          roleStarted("implementer"),
          roleSaid("First attempt.", "implementer"),
          roleStarted("implementer"),
        ],
        "implementer",
      ),
    ).toBeNull();
  });
});
