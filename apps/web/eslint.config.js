import { rivetConfig } from "@rivet/config/eslint.base.js";

export default [
  ...rivetConfig(import.meta.dirname),
  {
    ignores: ["next-env.d.ts", ".next/**"],
  },
];
