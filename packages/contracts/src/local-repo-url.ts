import { z } from "zod";

import { benchmarkIdSchema, type BenchmarkId } from "./benchmark-case";

/**
 * The repository scheme an evaluation job uses, and the reason it is opaque.
 *
 * A benchmark case runs against a bare repository the fixture builder wrote on
 * the worker host. That repository has no https URL, so the job needs some way
 * to name it - and the obvious answer, `file:///path/to/case.git`, is the wrong
 * one. A path-carrying scheme means every caller that accepts it is one crafted
 * request away from cloning `/etc`, and the refusal has to be written correctly
 * in every one of those places.
 *
 * `rivet-local:<case-id>` carries no path at all. It carries an identifier that
 * `benchmarkIdSchema` already constrains to lowercase kebab-case, which cannot
 * express a separator, a parent segment or an absolute root. Resolving it is
 * therefore a lookup below a configured root rather than a path the caller
 * chose, and the only remaining escape - a symlinked case directory - is
 * refused where the filesystem is (see `resolveBenchmarkRepositoryPath` in
 * `@rivet/core`).
 *
 * Nothing a browser can submit accepts this scheme: `createJobSchema.repoUrl`
 * is https-only and stays that way. The scheme is opened in exactly one place,
 * the worker, and only under `RIVET_EVAL=on`.
 */
export const LOCAL_REPO_URL_SCHEME = "rivet-local:";

/**
 * Reads a local benchmark repository URL, or returns null.
 *
 * Null rather than a throw, because the ordinary caller is asking "is this one
 * of mine" about a URL that is usually an https remote. A malformed value under
 * the scheme is still null: `rivet-local:../../etc` is not a valid local URL,
 * and reporting it as "not local" sends it to the https path, which refuses it
 * too. There is no reading of this string that reaches a filesystem.
 */
export function parseLocalRepoUrl(value: string): BenchmarkId | null {
  if (!value.startsWith(LOCAL_REPO_URL_SCHEME)) return null;
  const rest = value.slice(LOCAL_REPO_URL_SCHEME.length);
  // `rivet-local://x` is refused deliberately: an authority component is the
  // start of a path-carrying URL, and this scheme has neither.
  if (rest.startsWith("/")) return null;
  const parsed = benchmarkIdSchema.safeParse(rest);
  return parsed.success ? parsed.data : null;
}

/** Whether a repository URL names a local benchmark fixture. */
export function isLocalRepoUrl(value: string): boolean {
  return value.startsWith(LOCAL_REPO_URL_SCHEME);
}

/** The URL an evaluation run stores on the job row for a case. */
export function formatLocalRepoUrl(caseId: string): string {
  const id = benchmarkIdSchema.parse(caseId);
  return `${LOCAL_REPO_URL_SCHEME}${id}`;
}

/** A repository URL that names a benchmark case, validated as a whole. */
export const localRepoUrlSchema = z
  .string()
  .refine(
    (value) => parseLocalRepoUrl(value) !== null,
    `Must be a ${LOCAL_REPO_URL_SCHEME}<case-id> benchmark repository URL.`,
  );
