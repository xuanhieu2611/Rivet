import type { CheckAttribution, CheckComparison, JobArtifact } from "@rivet/contracts";

import { ValidationOutcomeBadge } from "@/components/validation-outcome-badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Disclosure } from "@/components/ui/disclosure";
import { formatDateTime } from "@/lib/format";
import { CHECK_KIND_LABELS, CHECK_STATUS_LABELS, plural } from "@/lib/validation-presentation";
import { readValidationReport } from "@/lib/validation-report";

/** Server-rendered comparison of every deterministic validation check. */
export function ValidationPanel({ artifact }: { artifact: JobArtifact | null }) {
  const report = readValidationReport(artifact);

  return (
    <Card id="validation" className="scroll-mt-32">
      <CardHeader className="border-b pb-4">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div className="max-w-2xl space-y-1">
            <CardTitle>Validation</CardTitle>
            <CardDescription>
              Deterministic checks compared against the pre-change baseline.
            </CardDescription>
          </div>
          {report ? (
            <div className="flex items-center gap-2">
              <span className="text-muted-foreground text-xs">Overall validation outcome</span>
              <ValidationOutcomeBadge outcome={report.outcome} className="h-6 px-2.5" />
            </div>
          ) : null}
        </div>
      </CardHeader>
      <CardContent>
        {report && artifact ? (
          <div className="space-y-4">
            <ol className="divide-border/60 divide-y overflow-hidden rounded-lg border">
              {report.checks.map((check) => (
                <ValidationCheckRow key={check.kind} check={check} />
              ))}
            </ol>

            {report.targetedPaths ? <TargetedPaths paths={report.targetedPaths} /> : null}

            <p className="text-muted-foreground text-[11px]">
              Report #{String(artifact.id)} · {formatDateTime(artifact.createdAt)}
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
  const baseline = check.baseline ? CHECK_STATUS_LABELS[check.baseline].toLowerCase() : "unknown";
  const status = CHECK_STATUS_LABELS[check.status];

  return (
    <li className="bg-muted/10 px-3.5 py-3" data-check-kind={check.kind}>
      {/*
       * The count reflows below the name on a phone rather than disappearing.
       * It used to be `hidden sm:block`, which meant the most important number
       * in the panel - how many tests passed - was the one thing a phone never
       * showed. Explicit placement on all three cells, because the badge has to
       * stay on the first row while the count moves to the second.
       */}
      <div className="grid min-w-0 grid-cols-[minmax(0,1fr)_auto] items-center gap-x-3 gap-y-1.5 sm:grid-cols-[minmax(9rem,1fr)_minmax(11rem,1fr)_auto] sm:gap-y-0">
        <div className="col-start-1 row-start-1 min-w-0">
          <h3 className="text-sm font-medium">{CHECK_KIND_LABELS[check.kind]}</h3>
          <p className="text-muted-foreground mt-0.5 text-xs">
            Baseline {baseline} · after {check.status.toLowerCase()}
            {check.tests ? ` · ${plural(check.tests.total, "test")}` : ""}
          </p>
        </div>

        <div className="col-span-2 col-start-1 row-start-2 min-w-0 sm:col-span-1 sm:col-start-2 sm:row-start-1">
          {check.tests ? (
            <p className="font-mono text-sm font-medium tabular-nums">
              {check.tests.passed}/{check.tests.total} passed
              {check.tests.skipped > 0 ? (
                <span className="text-muted-foreground font-sans font-normal">
                  {` · ${plural(check.tests.skipped, "skip")}`}
                </span>
              ) : null}
            </p>
          ) : (
            <p className="text-sm font-medium">{status}</p>
          )}
          {check.reason ? (
            <p className="text-muted-foreground mt-0.5 truncate text-xs" title={check.reason}>
              {check.reason}
            </p>
          ) : null}
        </div>

        <div className="col-start-2 row-start-1 justify-self-end sm:col-start-3">
          <ValidationOutcomeBadge outcome={check.outcome} />
        </div>
      </div>

      {check.attribution ? (
        <div className="mt-3">
          <AttributionDetails attribution={check.attribution} />
        </div>
      ) : null}
    </li>
  );
}

function AttributionDetails({ attribution }: { attribution: CheckAttribution }) {
  const total =
    attribution.newFailures.length +
    attribution.preExistingFailures.length +
    attribution.fixedFailures.length;

  return (
    <Disclosure
      summaryClassName="text-xs font-medium"
      contentClassName="grid gap-4 md:grid-cols-3"
      summary={<span>Failure attribution ({plural(total, "result")})</span>}
    >
      <FailureList title="New failures" failures={attribution.newFailures} />
      <FailureList title="Pre-existing failures" failures={attribution.preExistingFailures} />
      <FailureList title="Fixed failures" failures={attribution.fixedFailures} />
    </Disclosure>
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
    <Disclosure
      summaryClassName="text-xs font-medium"
      summary={<span>Targeted selection ({plural(paths.length, "path")})</span>}
    >
      <ul className="space-y-1">
        {paths.map((path) => (
          <li key={path} className="break-all font-mono text-xs">
            {path}
          </li>
        ))}
      </ul>
    </Disclosure>
  );
}
