import { describe, expect, it } from "vitest";

import { repoValidationConfigSchema } from "./validation-config";

describe("repoValidationConfigSchema", () => {
  it("accepts strict argv-based validation configuration", () => {
    expect(
      repoValidationConfigSchema.parse({
        validation: {
          test: {
            argv: ["pnpm", "test"],
            timeoutMs: 600_000,
            reporter: { framework: "vitest", outputArg: "--outputFile" },
          },
          typecheck: { argv: ["pnpm", "typecheck"] },
          lint: { argv: ["pnpm", "lint"] },
          targeted: {
            argv: ["pnpm", "vitest", "run"],
            appendPaths: true,
            reporter: { framework: "vitest" },
          },
        },
      }),
    ).toEqual({
      validation: {
        test: {
          argv: ["pnpm", "test"],
          timeoutMs: 600_000,
          reporter: { framework: "vitest", outputArg: "--outputFile" },
        },
        typecheck: { argv: ["pnpm", "typecheck"] },
        lint: { argv: ["pnpm", "lint"] },
        targeted: {
          argv: ["pnpm", "vitest", "run"],
          appendPaths: true,
          reporter: { framework: "vitest" },
        },
      },
    });
  });

  it("accepts an empty validation section for inference", () => {
    expect(repoValidationConfigSchema.parse({ validation: {} })).toEqual({ validation: {} });
  });

  it("rejects shell strings with an actionable message", () => {
    const parsed = repoValidationConfigSchema.safeParse({
      validation: { test: "pnpm test" },
    });

    expect(parsed.success).toBe(false);
    if (!parsed.success) expect(parsed.error.message).toMatch(/argv arrays, not shell strings/i);
  });

  it.each([999, 3_600_001])("rejects timeoutMs=%s outside worker bounds", (timeoutMs) => {
    expect(
      repoValidationConfigSchema.safeParse({
        validation: { lint: { argv: ["pnpm", "lint"], timeoutMs } },
      }).success,
    ).toBe(false);
  });

  it("rejects empty argv arrays, unknown fields, and unknown reporters", () => {
    expect(
      repoValidationConfigSchema.safeParse({ validation: { test: { argv: [] } } }).success,
    ).toBe(false);
    expect(
      repoValidationConfigSchema.safeParse({ validation: { format: { argv: ["pnpm", "format"] } } })
        .success,
    ).toBe(false);
    expect(
      repoValidationConfigSchema.safeParse({
        validation: { test: { argv: ["pnpm", "test"], reporter: { framework: "tap" } } },
      }).success,
    ).toBe(false);
    expect(repoValidationConfigSchema.safeParse({ validation: {}, version: 1 }).success).toBe(
      false,
    );
  });
});
