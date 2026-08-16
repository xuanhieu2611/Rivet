/** The maximum title-derived portion of a publication branch. */
export const PUBLICATION_BRANCH_SLUG_MAX_LENGTH = 40;
/** The maximum complete publication branch name accepted by Rivet. */
export const PUBLICATION_BRANCH_MAX_LENGTH = 100;

/**
 * Derives the deterministic branch used for one job's publication.
 *
 * The job id comes first so identical titles still produce different branches.
 * Unicode letters and numbers remain usable in the slug; everything else is
 * collapsed to one hyphen and an empty title-derived slug is omitted.
 */
export function deriveBranchName(jobId: string, title: string): string;
export function deriveBranchName(input: { jobId: string; title: string }): string;
export function deriveBranchName(
  jobIdOrInput: string | { jobId: string; title: string },
  titleArgument?: string,
): string {
  const jobId = typeof jobIdOrInput === "string" ? jobIdOrInput : jobIdOrInput.jobId;
  const title = typeof jobIdOrInput === "string" ? titleArgument : jobIdOrInput.title;
  if (title === undefined) throw new Error("A publication branch requires a title.");
  if (jobId.trim().length < 8)
    throw new Error("A publication branch requires an eight-character job id.");

  const id = jobId.slice(0, 8).toLowerCase();
  const slug = slugify(title);
  const prefix = `rivet/job-${id}`;
  const candidate = slug.length > 0 ? `${prefix}-${slug}` : prefix;
  return candidate.slice(0, PUBLICATION_BRANCH_MAX_LENGTH).replace(/-+$/u, "");
}

/** Alias named after the external operation that consumes the branch. */
export const derivePublicationBranch = deriveBranchName;
/** Alias useful at job call sites. */
export const branchNameForJob = deriveBranchName;

/** Turns a task title into a bounded, Git-ref-safe slug. */
export function slugifyPublicationTitle(title: string): string {
  return slugify(title);
}

function slugify(title: string): string {
  const normalized = title.normalize("NFKC").toLowerCase();
  const collapsed = normalized.replace(/[^\p{Letter}\p{Number}]+/gu, "-").replace(/^-+|-+$/gu, "");
  if (collapsed.length <= PUBLICATION_BRANCH_SLUG_MAX_LENGTH) return collapsed;

  const prefix = collapsed.slice(0, PUBLICATION_BRANCH_SLUG_MAX_LENGTH);
  const boundary = prefix.lastIndexOf("-");
  return (boundary > 0 ? prefix.slice(0, boundary) : prefix).replace(/-+$/u, "");
}
