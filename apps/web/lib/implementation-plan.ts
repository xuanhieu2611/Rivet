import {
  parseSerializedImplementationPlan,
  renderImplementationPlan,
  type JobArtifact,
  type RenderedImplementationPlanSection,
} from "@rivet/contracts";

/**
 * The stored plan artifact, read back for the detail page.
 *
 * The plan is persisted as canonical JSON with `requireComplete`, so a truncated
 * or unparseable body should be impossible. It is still handled rather than
 * thrown, because a page is a reader: a row written by an older Rivet, or by a
 * schema that has since gained a section, must not be able to take the whole job
 * detail page down with it.
 */
export function readImplementationPlanSections(
  artifact: JobArtifact | null,
): RenderedImplementationPlanSection[] | null {
  if (!artifact || artifact.truncated) return null;

  try {
    return renderImplementationPlan(parseSerializedImplementationPlan(artifact.content));
  } catch {
    return null;
  }
}

export { parseSerializedImplementationPlan, renderImplementationPlan };
export type { RenderedImplementationPlanSection };
