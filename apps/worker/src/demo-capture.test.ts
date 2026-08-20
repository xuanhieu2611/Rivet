import { describe, expect, it } from "vitest";

import { parseCaptureArgs } from "./demo-capture";

describe("parseCaptureArgs", () => {
  it("requires an explicit name and a job id", () => {
    expect(parseCaptureArgs(["11111111-2222-3333-4444-555555555555", "--name", "booking"])).toEqual(
      {
        help: false,
        jobId: "11111111-2222-3333-4444-555555555555",
        name: "booking",
        out: null,
      },
    );
  });

  it("accepts --name before the job id and an optional --out", () => {
    expect(parseCaptureArgs(["--name", "booking", "--out", "demo/replays/booking", "abc"])).toEqual(
      {
        help: false,
        jobId: "abc",
        name: "booking",
        out: "demo/replays/booking",
      },
    );
  });

  it("rejects unknown flags", () => {
    expect(() => parseCaptureArgs(["--title", "booking"])).toThrow(/Unknown demo:capture argument/);
  });
});
