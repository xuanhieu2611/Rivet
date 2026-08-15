import { describe, expect, it } from "vitest";

import { ValidationConfigInvalidError } from "../jobs/failure";
import { detectPackageManager, type ProjectPlan } from "./project";
import { resolveValidationConfig } from "./validation-config";

function plan(entries: string[] = ["package.json", "pnpm-lock.yaml"]): ProjectPlan {
  const detected = detectPackageManager(entries);
  if (!detected) throw new Error("test fixture must describe a Node project");
  return detected;
}

describe("resolveValidationConfig", () => {
  it("applies rivet.json precedence independently for every check", () => {
    const resolved = resolveValidationConfig({
      plan: plan(),
      manifest: {
        scripts: { test: "vitest run", typecheck: "tsc --noEmit", lint: "eslint ." },
      },
      repoConfig: {
        validation: {
          test: {
            argv: ["node", "test.js"],
            timeoutMs: 600_000,
            reporter: { framework: "vitest", outputArg: "--outputFile" },
          },
          lint: { argv: ["node", "lint.js"] },
        },
      },
    });

    expect(resolved.test).toEqual({
      argv: ["node", "test.js"],
      source: "rivet_json",
      timeoutMs: 600_000,
      reporter: { framework: "vitest", outputArg: "--outputFile" },
    });
    expect(resolved.typecheck).toEqual({
      argv: ["corepack", "pnpm", "run", "typecheck"],
      source: "package_json",
    });
    expect(resolved.lint).toEqual({ argv: ["node", "lint.js"], source: "rivet_json" });
  });

  const managers = [
    {
      files: ["package.json", "pnpm-lock.yaml"],
      argv: ["corepack", "pnpm", "run", "test"],
    },
    { files: ["package.json", "yarn.lock"], argv: ["corepack", "yarn", "run", "test"] },
    { files: ["package.json", "package-lock.json"], argv: ["npm", "run", "test"] },
    { files: ["package.json", "bun.lock"], argv: ["bun", "run", "test"] },
  ];

  for (const manager of managers) {
    it(`infers scripts through ${manager.argv[0]} from its project plan`, () => {
      const resolved = resolveValidationConfig({
        plan: plan(manager.files),
        manifest: { scripts: { test: "runner" } },
        repoConfig: null,
      });

      expect(resolved.test).toEqual({ argv: manager.argv, source: "package_json" });
      expect(resolved.targeted).toEqual({
        argv: manager.argv,
        source: "package_json",
        appendPaths: true,
      });
    });
  }

  it("resolves a test-only manifest and records sentence-ready reasons for the rest", () => {
    const resolved = resolveValidationConfig({
      plan: plan(),
      manifest: { scripts: { test: "vitest run" } },
      repoConfig: null,
    });

    expect(resolved.test).toMatchObject({ source: "package_json" });
    expect(resolved.typecheck).toEqual({
      skipped: true,
      reason: "there is no `typecheck` script in package.json",
    });
    expect(resolved.lint).toEqual({
      skipped: true,
      reason: "there is no `lint` script in package.json",
    });
  });

  it("skips every check when the manifest has no scripts", () => {
    const resolved = resolveValidationConfig({ plan: plan(), manifest: {}, repoConfig: null });

    expect(resolved).toEqual({
      test: { skipped: true, reason: "there is no `test` script in package.json" },
      typecheck: { skipped: true, reason: "there is no `typecheck` script in package.json" },
      lint: { skipped: true, reason: "there is no `lint` script in package.json" },
      targeted: { skipped: true, reason: "there is no `test` script in package.json" },
    });
  });

  it("uses a rivet.json check even when the manifest does not name it", () => {
    const resolved = resolveValidationConfig({
      plan: plan(),
      manifest: { scripts: { test: "vitest run" } },
      repoConfig: { validation: { lint: { argv: ["biome", "check", "."] } } },
    });

    expect(resolved.lint).toEqual({
      argv: ["biome", "check", "."],
      source: "rivet_json",
    });
  });

  it("lets an explicit targeted template win and preserves appendPaths", () => {
    const resolved = resolveValidationConfig({
      plan: plan(),
      manifest: { scripts: { test: "vitest run" } },
      repoConfig: {
        validation: {
          targeted: {
            argv: ["node", "targeted.js"],
            appendPaths: false,
            timeoutMs: 45_000,
            reporter: { framework: "jest" },
          },
        },
      },
    });

    expect(resolved.targeted).toEqual({
      argv: ["node", "targeted.js"],
      source: "rivet_json",
      appendPaths: false,
      timeoutMs: 45_000,
      reporter: { framework: "jest" },
    });
  });

  it("derives targeted from the resolved test command, including a rivet.json test", () => {
    const resolved = resolveValidationConfig({
      plan: plan(),
      manifest: {},
      repoConfig: {
        validation: {
          test: {
            argv: ["node", "test.js"],
            reporter: { framework: "vitest" },
          },
        },
      },
    });

    expect(resolved.targeted).toEqual({
      argv: ["node", "test.js"],
      source: "rivet_json",
      appendPaths: true,
      reporter: { framework: "vitest" },
    });
  });

  it("throws a terminal classified error for invalid rivet.json", () => {
    expect(() =>
      resolveValidationConfig({
        plan: plan(),
        manifest: { scripts: { test: "vitest run" } },
        repoConfig: { validation: { test: "pnpm test" } },
      }),
    ).toThrowError(ValidationConfigInvalidError);

    try {
      resolveValidationConfig({
        plan: plan(),
        manifest: {},
        repoConfig: { validation: { test: { argv: [] } } },
      });
    } catch (error) {
      expect(error).toMatchObject({ category: "validation_config_invalid" });
      expect(String(error)).toContain("validation.test");
    }
  });
});
