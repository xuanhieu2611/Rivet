import { describe, expect, it } from "vitest";

import { detectPackageManager, readScript } from "./project";

/**
 * Detection is pure, so this is where the awkward repositories live: the one
 * with three lockfiles, the one with none, the one that is not a Node project
 * at all. Both phases that ask this question have to get the same answer, and a
 * cheap table here is what makes that true without a container.
 */

describe("detectPackageManager", () => {
  const cases = [
    { entries: ["package.json", "pnpm-lock.yaml"], name: "pnpm", lockfile: "pnpm-lock.yaml" },
    { entries: ["package.json", "yarn.lock"], name: "yarn", lockfile: "yarn.lock" },
    { entries: ["package.json", "package-lock.json"], name: "npm", lockfile: "package-lock.json" },
    { entries: ["package.json", "bun.lock"], name: "bun", lockfile: "bun.lock" },
    { entries: ["package.json", "bun.lockb"], name: "bun", lockfile: "bun.lockb" },
    { entries: ["package.json"], name: "npm", lockfile: null },
  ] as const;

  for (const { entries, name, lockfile } of cases) {
    it(`reads ${lockfile ?? "no lockfile"} as ${name}`, () => {
      expect(detectPackageManager(entries)).toMatchObject({ name, lockfile });
    });
  }

  it("prefers pnpm when a repository carries more than one lockfile", () => {
    // Repositories that switched managers and did not clean up are common, and
    // guessing differently on two runs of the same commit would make the
    // fingerprint a fiction.
    const plan = detectPackageManager([
      "package.json",
      "package-lock.json",
      "yarn.lock",
      "pnpm-lock.yaml",
    ]);
    expect(plan?.name).toBe("pnpm");
  });

  it("installs from the manifest when there is no lockfile at all", () => {
    // `npm ci` refuses to run without one, so this is the single case that does
    // not get a reproducible install.
    expect(detectPackageManager(["package.json"])?.install).toEqual([
      "npm",
      "install",
      "--no-audit",
      "--no-fund",
    ]);
  });

  it("is null without a manifest, whatever else is there", () => {
    expect(detectPackageManager(["pnpm-lock.yaml", "src", "README.md"])).toBeNull();
    expect(detectPackageManager([])).toBeNull();
  });

  it("runs a script through the manager the lockfile named", () => {
    // The baseline has to be established with the manager the tree was
    // installed with: a pnpm workspace's `test` script routinely shells out to
    // `pnpm -r`, which npm cannot resolve.
    expect(detectPackageManager(["package.json", "pnpm-lock.yaml"])?.runScript("test")).toEqual([
      "corepack",
      "pnpm",
      "run",
      "test",
    ]);
    expect(detectPackageManager(["package.json", "yarn.lock"])?.runScript("test")).toEqual([
      "corepack",
      "yarn",
      "run",
      "test",
    ]);
    expect(detectPackageManager(["package.json", "package-lock.json"])?.runScript("test")).toEqual([
      "npm",
      "run",
      "test",
    ]);
    expect(detectPackageManager(["package.json", "bun.lock"])?.runScript("test")).toEqual([
      "bun",
      "run",
      "test",
    ]);
  });
});

describe("readScript", () => {
  it("returns the script when there is one", () => {
    expect(readScript({ scripts: { test: "vitest run" } }, "test")).toBe("vitest run");
  });

  it("is null for every shape that is not a script", () => {
    // A manifest is arbitrary JSON written by someone else. Everything
    // unexpected has to read as "no such script" rather than as an exception,
    // because none of these are worth failing a provisioned job over.
    expect(readScript({ scripts: {} }, "test")).toBeNull();
    expect(readScript({ scripts: { test: "" } }, "test")).toBeNull();
    expect(readScript({ scripts: { test: "   " } }, "test")).toBeNull();
    expect(readScript({ scripts: { test: 42 } }, "test")).toBeNull();
    expect(readScript({ scripts: null }, "test")).toBeNull();
    expect(readScript({ scripts: "nope" }, "test")).toBeNull();
    expect(readScript({}, "test")).toBeNull();
    expect(readScript(null, "test")).toBeNull();
    expect(readScript("not an object", "test")).toBeNull();
    expect(readScript([], "test")).toBeNull();
  });
});
