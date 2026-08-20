import { describe, expect, it } from "vitest";

import { parseReplayArgs } from "./demo-replay";

describe("parseReplayArgs", () => {
  it("defaults speed to 1 and dir to unset", () => {
    expect(parseReplayArgs(["booking"])).toEqual({
      help: false,
      name: "booking",
      speed: 1,
      dir: null,
    });
  });

  it("accepts --speed 0 and a parent --dir", () => {
    expect(parseReplayArgs(["booking", "--speed", "0", "--dir", "/tmp/replays"])).toEqual({
      help: false,
      name: "booking",
      speed: 0,
      dir: "/tmp/replays",
    });
  });

  it("rejects a speed outside 0..100", () => {
    expect(() => parseReplayArgs(["booking", "--speed", "-1"])).toThrow(/--speed/);
    expect(() => parseReplayArgs(["booking", "--speed", "fast"])).toThrow(/--speed/);
  });
});
