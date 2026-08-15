import {
  parseSerializedValidationReport,
  type JobArtifact,
  type ValidationReport,
} from "@rivet/contracts";

/** Reads a complete current report without allowing artifact corruption to break the page. */
export function readValidationReport(artifact: JobArtifact | null): ValidationReport | null {
  if (artifact?.type !== "validation_report" || artifact.truncated) return null;

  try {
    return parseSerializedValidationReport(artifact.content);
  } catch {
    return null;
  }
}
