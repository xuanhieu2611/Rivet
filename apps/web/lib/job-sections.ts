/**
 * The panels the job detail page's section nav jumps between.
 *
 * Kept out of the component so the ordering and the "which one am I looking
 * at" rule are testable without a DOM. The ids are the `id` attributes on the
 * cards themselves; a nav entry whose id no longer exists silently stops
 * highlighting, which is why `jobSections` is the single list both the nav and
 * the observer read.
 */
export interface JobSection {
  id: string;
  label: string;
}

/**
 * The last entry is named for what is actually there: a job that published has
 * a pull request to go to, and one that did not has a repository.
 */
export function jobSections(hasPullRequest: boolean): readonly JobSection[] {
  return [
    { id: "timeline", label: "Live run" },
    { id: "plan", label: "Plan" },
    { id: "validation", label: "Validation" },
    { id: "review", label: "Review" },
    { id: "artifacts", label: "Changes" },
    { id: "publication", label: hasPullRequest ? "Pull request" : "Repository" },
  ];
}

/**
 * The topmost section currently in the observation band.
 *
 * An `IntersectionObserver` reports entries in whatever order they changed, and
 * more than one section is usually in view at once - a short Plan panel and the
 * Validation panel under it both are. Document order breaks the tie, because
 * the section a reader considers themselves to be in is the one they have
 * scrolled to most recently, which is the earliest one still on screen.
 *
 * Returns null when nothing is in the band, which happens above the first
 * section and below the last. The nav then highlights nothing rather than
 * guessing, since a wrong highlight is worse than no highlight.
 */
export function activeSectionId(
  visible: ReadonlySet<string>,
  sections: readonly JobSection[],
): string | null {
  for (const section of sections) {
    if (visible.has(section.id)) return section.id;
  }
  return null;
}
