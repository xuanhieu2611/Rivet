import { describe, expect, it } from "vitest";

import { remapEventData, replayLeaseOwner } from "./replay";

describe("replayLeaseOwner", () => {
  it("is a synthetic owner that names the fixture", () => {
    expect(replayLeaseOwner("booking")).toBe("rivet-replay:booking");
  });
});

describe("remapEventData", () => {
  it("rewrites artifact and command ids onto the rows this replay wrote", () => {
    expect(
      remapEventData(
        { artifactId: 7, bodyArtifactId: 8, commandId: 3, phase: "Validate change" },
        new Map([
          [7, 101],
          [8, 102],
        ]),
        new Map([[3, 201]]),
      ),
    ).toEqual({
      artifactId: 101,
      bodyArtifactId: 102,
      commandId: 201,
      phase: "Validate change",
    });
  });

  it("returns undefined for a null payload so callers can omit data", () => {
    expect(remapEventData(null, new Map(), new Map())).toBeUndefined();
  });

  it("fails when an event points at a body the fixture did not record", () => {
    expect(() => remapEventData({ artifactId: 9 }, new Map(), new Map())).toThrow(
      /referenced artifact 9/,
    );
  });
});
