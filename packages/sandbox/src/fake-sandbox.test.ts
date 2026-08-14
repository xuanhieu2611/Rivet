import { SandboxFileError, type ExecRequest, type SandboxSpec } from "@rivet/core";
import { describe, expect, it } from "vitest";

import { FakeSandboxProvider } from "./fake-sandbox";

const SPEC: SandboxSpec = {
  jobId: "11111111-1111-4111-8111-111111111111",
  image: "node:24-bookworm-slim",
  workdir: "/workspace",
  memoryBytes: 2 * 1024 * 1024 * 1024,
  nanoCpus: 2_000_000_000,
  pidsLimit: 512,
  env: {},
  labels: {},
};

function request(argv: string[], overrides: Partial<ExecRequest> = {}): ExecRequest {
  return {
    argv,
    cwd: "/workspace",
    timeoutMs: 50,
    signal: new AbortController().signal,
    ...overrides,
  };
}

describe("FakeSandboxProvider", () => {
  it("hands out a sandbox and records the spec it was asked for", async () => {
    const provider = new FakeSandboxProvider();
    const sandbox = await provider.create(SPEC, new AbortController().signal);

    expect(sandbox.id).toBe("fake-sandbox-1");
    expect(provider.created).toEqual([SPEC]);
  });

  it("fails to create when told to, which is the no-daemon fault mode", async () => {
    const boom = new Error("no daemon");
    const provider = new FakeSandboxProvider({ createFails: boom });

    await expect(provider.create(SPEC, new AbortController().signal)).rejects.toBe(boom);
    expect(provider.created).toEqual([]);
  });

  it("refuses to create against an already-aborted signal", async () => {
    const provider = new FakeSandboxProvider();
    await expect(provider.create(SPEC, AbortSignal.abort())).rejects.toThrow();
  });

  it("succeeds with exit code zero for an unscripted command", async () => {
    const provider = new FakeSandboxProvider();
    const sandbox = await provider.create(SPEC, new AbortController().signal);
    const result = await sandbox.exec(request(["git", "--version"]));

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("");
    expect(result.timedOut).toBe(false);
  });

  it("reports a non-zero exit rather than throwing, like the real one", async () => {
    const provider = new FakeSandboxProvider({
      script: [{ match: "pnpm", exitCode: 1, stderr: "2 tests failed" }],
    });
    const sandbox = await provider.create(SPEC, new AbortController().signal);
    const result = await sandbox.exec(request(["pnpm", "test"]));

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toBe("2 tests failed");
  });

  it("matches on the whole command line when given a regexp", async () => {
    const provider = new FakeSandboxProvider({
      script: [{ match: /clone .*nonexistent/, exitCode: 128, stderr: "repository not found" }],
    });
    const sandbox = await provider.create(SPEC, new AbortController().signal);

    const missing = await sandbox.exec(request(["git", "clone", "https://x/nonexistent.git"]));
    const present = await sandbox.exec(request(["git", "clone", "https://x/real.git"]));

    expect(missing.exitCode).toBe(128);
    expect(present.exitCode).toBe(0);
  });

  it("records every command in order", async () => {
    const provider = new FakeSandboxProvider();
    const sandbox = await provider.create(SPEC, new AbortController().signal);
    await sandbox.exec(request(["git", "clone", "url"]));
    await sandbox.exec(request(["npm", "ci"]));

    expect(provider.calls.map((call) => call.argv[0])).toEqual(["git", "npm"]);
  });

  it("truncates scripted output at the cap it was given", async () => {
    const provider = new FakeSandboxProvider({
      script: [{ match: "npm", stdout: "x".repeat(5000) }],
    });
    const sandbox = await provider.create(SPEC, new AbortController().signal);
    const result = await sandbox.exec(request(["npm", "ci"], { maxOutputBytes: 100 }));

    expect(result.truncated).toBe(true);
    expect(result.stdout).toContain("... 4900 bytes elided ...");
  });

  describe("a command that hangs", () => {
    it("is killed by its own timeout, and says so", async () => {
      const provider = new FakeSandboxProvider({ script: [{ match: "sleep", hang: true }] });
      const sandbox = await provider.create(SPEC, new AbortController().signal);
      const result = await sandbox.exec(request(["sleep", "infinity"], { timeoutMs: 10 }));

      expect(result.timedOut).toBe(true);
      // Null rather than 137: it never got to exit.
      expect(result.exitCode).toBeNull();
    });

    it("is killed by an abort, which is not a timeout", async () => {
      const provider = new FakeSandboxProvider({ script: [{ match: "sleep", hang: true }] });
      const sandbox = await provider.create(SPEC, new AbortController().signal);
      const controller = new AbortController();

      const running = sandbox.exec(
        request(["sleep", "infinity"], { timeoutMs: 60_000, signal: controller.signal }),
      );
      controller.abort();
      const result = await running;

      expect(result.timedOut).toBe(false);
      expect(result.exitCode).toBeNull();
    });

    it("reports an OOM kill as an OOM kill rather than a timeout", async () => {
      const provider = new FakeSandboxProvider({
        script: [{ match: "node", hang: true, oomKilled: true }],
      });
      const sandbox = await provider.create(SPEC, new AbortController().signal);
      const result = await sandbox.exec(request(["node", "-e", "eat()"], { timeoutMs: 10 }));

      expect(result.oomKilled).toBe(true);
      expect(result.timedOut).toBe(false);
    });
  });

  it("destroys idempotently and never throws", async () => {
    const provider = new FakeSandboxProvider();
    const sandbox = await provider.create(SPEC, new AbortController().signal);

    await sandbox.destroy();
    await sandbox.destroy();

    expect(provider.sandboxes[0]?.destroyCount).toBe(2);
    expect(provider.sandboxes[0]?.destroyed).toBe(true);
  });

  it("reaps the sandboxes whose job is not live and spares the ones that are", async () => {
    const provider = new FakeSandboxProvider();
    const live = await provider.create({ ...SPEC, jobId: "live" }, new AbortController().signal);
    const dead = await provider.create({ ...SPEC, jobId: "dead" }, new AbortController().signal);

    const removed = await provider.reap((jobId) => Promise.resolve(jobId === "live"));

    expect(removed).toEqual([dead.id]);
    expect(provider.sandboxes.find((s) => s.id === live.id)?.destroyed).toBe(false);
  });

  it("does not reap a sandbox twice", async () => {
    const provider = new FakeSandboxProvider();
    await provider.create({ ...SPEC, jobId: "dead" }, new AbortController().signal);

    const first = await provider.reap(() => Promise.resolve(false));
    const second = await provider.reap(() => Promise.resolve(false));

    expect(first).toHaveLength(1);
    expect(second).toEqual([]);
  });
});

describe("the fake's filesystem", () => {
  const signal = new AbortController().signal;

  async function sandboxWith(files: Record<string, string>) {
    const provider = new FakeSandboxProvider({ files });
    await provider.create(SPEC, signal);
    const sandbox = provider.sandboxes[0];
    if (!sandbox) throw new Error("the provider handed back no sandbox");
    return sandbox;
  }

  it("reads back what it was seeded with, and what was written into it", async () => {
    const sandbox = await sandboxWith({ "/repo/sum.ts": "export const sum = 1;\n" });

    await sandbox.putFile("/repo/src/nested/new.ts", "written\n", signal);

    expect(await sandbox.getFile("/repo/sum.ts", { maxBytes: 1_024 }, signal)).toEqual({
      content: "export const sum = 1;\n",
      truncated: false,
    });
    expect(await sandbox.getFile("/repo/src/nested/new.ts", { maxBytes: 1_024 }, signal)).toEqual({
      content: "written\n",
      truncated: false,
    });
  });

  it("overwrites rather than appending, which is what write means", async () => {
    const sandbox = await sandboxWith({ "/repo/a.ts": "first" });

    await sandbox.putFile("/repo/a.ts", "second", signal);

    expect(sandbox.filesystem["/repo/a.ts"]).toBe("second");
  });

  it("truncates on bytes and says so", async () => {
    // Bytes rather than characters, because that is what the real adapter caps
    // and a fake that disagreed would make the tool layer's tests fiction.
    const sandbox = await sandboxWith({ "/repo/big.txt": "0123456789" });

    expect(await sandbox.getFile("/repo/big.txt", { maxBytes: 4 }, signal)).toEqual({
      content: "0123",
      truncated: true,
    });
  });

  it("reports a missing file and a directory differently", async () => {
    const sandbox = await sandboxWith({ "/repo/src/a.ts": "x" });

    // Both are tool results a model reads and corrects, never job failures -
    // which is why neither extends the retryable or terminal hierarchy.
    await expect(sandbox.getFile("/repo/missing.ts", { maxBytes: 16 }, signal)).rejects.toThrow(
      SandboxFileError,
    );
    await expect(
      sandbox.getFile("/repo/missing.ts", { maxBytes: 16 }, signal),
    ).rejects.toMatchObject({ reason: "not_found" });
    await expect(sandbox.getFile("/repo/src", { maxBytes: 16 }, signal)).rejects.toMatchObject({
      reason: "not_a_file",
    });
  });

  it("refuses a path that does not name a file", async () => {
    const sandbox = await sandboxWith({});

    await expect(sandbox.putFile("/repo/src/", "x", signal)).rejects.toMatchObject({
      reason: "not_a_file",
    });
  });

  it("rejects both operations once the signal is aborted", async () => {
    const sandbox = await sandboxWith({ "/repo/a.ts": "x" });
    const controller = new AbortController();
    controller.abort();

    await expect(
      sandbox.getFile("/repo/a.ts", { maxBytes: 16 }, controller.signal),
    ).rejects.toThrow();
    await expect(sandbox.putFile("/repo/b.ts", "x", controller.signal)).rejects.toThrow();
    expect(sandbox.filesystem["/repo/b.ts"]).toBeUndefined();
  });

  it("gives each sandbox its own copy of the seeded files", async () => {
    // Two jobs' containers share nothing. A fake whose map is shared would hide
    // exactly the bug that property exists to prevent.
    const provider = new FakeSandboxProvider({ files: { "/repo/a.ts": "seed" } });
    const first = await provider.create(SPEC, signal);
    const second = await provider.create({ ...SPEC, jobId: "other" }, signal);

    await first.putFile("/repo/a.ts", "changed", signal);

    expect(await second.getFile("/repo/a.ts", { maxBytes: 64 }, signal)).toEqual({
      content: "seed",
      truncated: false,
    });
  });
});
