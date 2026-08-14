import { describe, expect, it } from "vitest";

import type { Sandbox } from "./sandbox";
import { SandboxHolder } from "./sandbox-holder";

function fake(id = "container-1", destroy: () => Promise<void> = () => Promise.resolve()) {
  let destroyCount = 0;
  const sandbox: Sandbox = {
    id,
    exec: () => Promise.reject(new Error("not used")),
    getFile: () => Promise.reject(new Error("not used")),
    putFile: () => Promise.reject(new Error("not used")),
    destroy: () => {
      destroyCount += 1;
      return destroy();
    },
  };
  return { sandbox, count: () => destroyCount };
}

describe("SandboxHolder", () => {
  it("is empty until something is put in it", () => {
    const holder = new SandboxHolder();
    expect(holder.current).toBeUndefined();
    expect(() => holder.require()).toThrow(/No sandbox/);
  });

  it("hands back what was set", () => {
    const holder = new SandboxHolder();
    const { sandbox } = fake();
    holder.set(sandbox);

    expect(holder.current).toBe(sandbox);
    expect(holder.require()).toBe(sandbox);
  });

  it("destroys once and forgets, however many times it is asked", async () => {
    const holder = new SandboxHolder();
    const { sandbox, count } = fake();
    holder.set(sandbox);

    await expect(holder.destroy()).resolves.toBe("container-1");
    // The processor's `finally` runs on every exit path, and several of those
    // can overlap - a cancelled job whose worker is also shutting down.
    await expect(holder.destroy()).resolves.toBeUndefined();
    expect(count()).toBe(1);
    expect(holder.current).toBeUndefined();
  });

  it("swallows a destroy that fails, because it runs while an error is in flight", async () => {
    const holder = new SandboxHolder();
    const { sandbox } = fake("container-2", () => Promise.reject(new Error("daemon gone")));
    holder.set(sandbox);

    // The reaper is the backstop for whatever this leaves behind. Rethrowing
    // here would replace the failure the job actually had with a cleanup error.
    await expect(holder.destroy()).resolves.toBe("container-2");
  });
});
