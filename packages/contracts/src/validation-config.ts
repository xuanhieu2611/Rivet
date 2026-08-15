import { z } from "zod";

import { testFrameworkSchema } from "./validation-check";

export const REPO_VALIDATION_TIMEOUT_MS = {
  min: 1_000,
  max: 3_600_000,
} as const;

export const validationReporterSchema = z
  .object({
    framework: testFrameworkSchema,
    outputArg: z.string().min(1).optional(),
  })
  .strict();

const commandShape = {
  argv: z.array(z.string()).min(1),
  timeoutMs: z
    .number()
    .int()
    .min(REPO_VALIDATION_TIMEOUT_MS.min)
    .max(REPO_VALIDATION_TIMEOUT_MS.max)
    .optional(),
} as const;

function argvCommand<T extends z.ZodType>(schema: T) {
  return z.preprocess((value, ctx) => {
    if (typeof value === "string") {
      ctx.addIssue({
        code: "custom",
        message: "Validation commands must use argv arrays, not shell strings.",
      });
    }
    return value;
  }, schema);
}

export const repoValidationConfigSchema = z
  .object({
    validation: z
      .object({
        test: argvCommand(
          z.object({ ...commandShape, reporter: validationReporterSchema.optional() }).strict(),
        ).optional(),
        typecheck: argvCommand(z.object(commandShape).strict()).optional(),
        lint: argvCommand(z.object(commandShape).strict()).optional(),
        targeted: argvCommand(
          z
            .object({
              ...commandShape,
              appendPaths: z.boolean(),
              reporter: validationReporterSchema.optional(),
            })
            .strict(),
        ).optional(),
      })
      .strict(),
  })
  .strict();

export type RepoValidationConfig = z.infer<typeof repoValidationConfigSchema>;
