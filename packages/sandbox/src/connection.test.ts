import { describe, expect, it } from "vitest";

import { dockerConnectionTarget } from "./connection";

/**
 * No daemon is involved here, which is the point: this is the one part of the
 * connection story that can be checked without one, and the part that decides
 * which socket a machine's jobs run against.
 */
describe("dockerConnectionTarget", () => {
  it("prefers DOCKER_HOST over any probing", () => {
    expect(dockerConnectionTarget({ DOCKER_HOST: "/tmp/custom.sock" })).toEqual({
      socketPath: "/tmp/custom.sock",
      source: "DOCKER_HOST",
    });
  });

  it("strips the unix:// scheme, which is how DOCKER_HOST is usually written", () => {
    expect(dockerConnectionTarget({ DOCKER_HOST: "unix:///tmp/custom.sock" }).socketPath).toBe(
      "/tmp/custom.sock",
    );
  });

  it("falls back to a socket path when nothing is set", () => {
    const target = dockerConnectionTarget({});

    expect(["desktop", "system"]).toContain(target.source);
    expect(target.socketPath.endsWith("docker.sock")).toBe(true);
  });

  it("ignores an empty DOCKER_HOST rather than connecting to nothing", () => {
    expect(dockerConnectionTarget({ DOCKER_HOST: "" }).source).not.toBe("DOCKER_HOST");
  });
});
