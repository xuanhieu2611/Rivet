// @ts-check
import js from "@eslint/js";
import tseslint from "typescript-eslint";

/**
 * Shared ESLint 9 flat config for every Rivet workspace package.
 *
 * Consume it from a package-level `eslint.config.js`:
 *
 *   import { rivetConfig } from "@rivet/config/eslint.base.js";
 *   export default rivetConfig(import.meta.dirname);
 *
 * `tsconfigRootDir` must be the consuming package's directory so that
 * type-aware linting resolves that package's own tsconfig.
 */

/** Paths no package should ever lint. */
export const ignores = [
  "**/node_modules/**",
  "**/dist/**",
  "**/build/**",
  "**/.next/**",
  "**/.turbo/**",
  "**/coverage/**",
  "**/*.tsbuildinfo",
];

/**
 * Rules layered on top of typescript-eslint's type-checked recommendations.
 * @type {import("eslint").Linter.RulesRecord}
 */
export const rivetRules = {
  "@typescript-eslint/no-floating-promises": "error",
  "@typescript-eslint/no-misused-promises": "error",
  "@typescript-eslint/consistent-type-imports": [
    "error",
    { prefer: "type-imports", fixStyle: "inline-type-imports" },
  ],
  "@typescript-eslint/consistent-type-exports": "error",
  "@typescript-eslint/no-import-type-side-effects": "error",
  "@typescript-eslint/no-unused-vars": [
    "error",
    {
      argsIgnorePattern: "^_",
      varsIgnorePattern: "^_",
      caughtErrorsIgnorePattern: "^_",
    },
  ],
  "@typescript-eslint/require-await": "error",
  "no-console": ["warn", { allow: ["warn", "error"] }],
  eqeqeq: ["error", "always", { null: "ignore" }],
};

/**
 * Build the flat config array for a package.
 *
 * @param {string} tsconfigRootDir Absolute path to the consuming package root.
 * @returns {import("typescript-eslint").ConfigArray}
 */
export function rivetConfig(tsconfigRootDir) {
  return tseslint.config(
    { ignores },
    js.configs.recommended,
    ...tseslint.configs.recommendedTypeChecked,
    ...tseslint.configs.stylisticTypeChecked,
    {
      languageOptions: {
        parserOptions: {
          projectService: true,
          tsconfigRootDir,
        },
      },
      rules: rivetRules,
    },
    {
      // Config and build files are plain JS and are not part of any tsconfig.
      files: ["**/*.{js,cjs,mjs}"],
      extends: [tseslint.configs.disableTypeChecked],
    },
  );
}

export default rivetConfig;
