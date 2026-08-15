import type { CheckAttribution, CheckComparison, JobArtifact } from "@rivet/contracts";

import { ValidationOutcomeBadge } from "@/components/validation-outcome-badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { formatDateTime } from "@/lib/format";
import { CHECK_KIND_LABELS, CHECK_STATUS_LABELS, plural } from "@/lib/validation-presentation";
import { readValidationReport } from "@/lib/validation-report";

/** Server-rendered comparison of every deterministic validation check. */
export function ValidationPanel({ artifact }: { artifact: JobArtifact | null }) {
  const report = readValidationReport(artifact);

  return (
    <Card id="validation">
      <CardHeader>
        <CardTitle>Validation</CardTitle>
        <CardDescription>
          Each check is compared with its own pre-implementation baseline. Existing failures stay
          distinct from regressions introduced by the run.
        </CardDescription>
      </CardHeader>
      <CardContent>
        {report && artifact ? (
          <div className="space-y-5">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <p className="text-muted-foreground text-xs">Overall validation outcome</p>
              <ValidationOutcomeBadge outcome={report.outcome} />
            </div>

            <ol className="divide-border/60 divide-y overflow-hidden rounded-lg border">
              {report.checks.map((check) => (
                <ValidationCheckRow key={check.kind} check={check} />
              ))}
            </ol>

            {report.targetedPaths ? <TargetedPaths paths={report.targetedPaths} /> : null}

            <p className="text-muted-foreground text-xs">
              Artifact #{String(artifact.id)} · recorded {formatDateTime(artifact.createdAt)}
            </p>
          </div>
        ) : artifact ? (
          <p className="text-muted-foreground text-sm">
            Artifact #{String(artifact.id)} is not a readable structured validation report. The raw
            record is still listed under Artifacts.
          </p>
        ) : (
          <p className="text-muted-foreground text-sm">
            No validation report has been recorded yet. It appears after validation. Older jobs
            continue to show their validation result in the execution timeline.
          </p>
        )}
      </CardContent>
    </Card>
  );
}

function ValidationCheckRow({ check }: { check: CheckComparison }) {
  return (
    <li className="space-y-3 px-3 py-3" data-check-kind={check.kind}>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="min-w-0">
          <h3 className="text-sm font-medium">{CHECK_KIND_LABELS[check.kind]}</h3>
          <p className="text-muted-foreground mt-0.5 text-xs">
            Baseline{" "}
            {check.baseline ? CHECK_STATUS_LABELS[check.baseline].toLowerCase() : "unknown"}
            {" · "}
            after {CHECK_STATUS_LABELS[check.status].toLowerCase()}
            {check.tests ? ` · ${plural(check.tests.total, "test")}` : ""}
          </p>
        </div>
        <ValidationOutcomeBadge outcome={check.outcome} />
      </div>

      {check.reason ? <p className="text-muted-foreground text-xs">{check.reason}</p> : null}
      {check.attribution ? <AttributionDetails attribution={check.attribution} /> : null}
    </li>
  );
}

function AttributionDetails({ attribution }: { attribution: CheckAttribution }) {
  const total =
    attribution.newFailures.length +
    attribution.preExistingFailures.length +
    attribution.fixedFailures.length;

  return (
    <details className="group rounded-md border border-border/60 bg-muted/20">
      <summary className="flex cursor-pointer list-none items-center justify-between gap-3 px-3 py-2 text-xs font-medium [&::-webkit-details-marker]:hidden">
        <span>Failure attribution ({plural(total, "result")})</span>
        <span
          aria-hidden
          className="text-muted-foreground shrink-0 transition-transform group-open:rotate-180"
        >
          ▾
        </span>
      </summary>
      <div className="border-border/60 grid gap-4 border-t px-3 py-3 md:grid-cols-3">
        <FailureList title="New failures" failures={attribution.newFailures} />
        <FailureList title="Pre-existing failures" failures={attribution.preExistingFailures} />
        <FailureList title="Fixed failures" failures={attribution.fixedFailures} />
      </div>
    </details>
  );
}

function FailureList({ title, failures }: { title: string; failures: readonly string[] }) {
  return (
    <section className="min-w-0 space-y-1.5">
      <h4 className="text-muted-foreground text-xs font-medium">
        {title} ({String(failures.length)})
      </h4>
      {failures.length > 0 ? (
        <ul className="space-y-1">
          {failures.map((failure) => (
            <li key={failure} className="break-words font-mono text-xs">
              {failure}
            </li>
          ))}
        </ul>
      ) : (
        <p className="text-muted-foreground text-xs">None</p>
      )}
    </section>
  );
}

function TargetedPaths({ paths }: { paths: readonly string[] }) {
  return (
    <details className="group rounded-md border border-border/60 bg-muted/20">
      <summary className="flex cursor-pointer list-none items-center justify-between gap-3 px-3 py-2 text-xs font-medium [&::-webkit-details-marker]:hidden">
        <span>Targeted selection ({plural(paths.length, "path")})</span>
        <span
          aria-hidden
          className="text-muted-foreground shrink-0 transition-transform group-open:rotate-180"
        >
          ▾
        </span>
      </summary>
      <ul className="border-border/60 space-y-1 border-t px-3 py-3">
        {paths.map((path) => (
          <li key={path} className="break-all font-mono text-xs">
            {path}
          </li>
        ))}
      </ul>
    </details>
  );
}
