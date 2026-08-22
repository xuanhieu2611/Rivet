import type { JobArtifact } from "@rivet/contracts";

import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { formatDateTime } from "@/lib/format";
import { readImplementationPlanSections } from "@/lib/implementation-plan";

/**
 * The structured plan the planner submitted, in its six sections.
 *
 * Server-rendered from the latest `implementation_plan` artifact rather than
 * from the timeline: `plan.recorded` deliberately carries the artifact id and
 * nothing else, so the plan text travels once, after the run has settled, and
 * never through the live event stream.
 *
 * The card is rendered even when there is no plan yet, because "no plan has been
 * recorded" is a fact about a run that a reader of an `implementing` job wants,
 * and an absent card would read as an absent feature.
 */
export function ImplementationPlanPanel({ artifact }: { artifact: JobArtifact | null }) {
  const sections = readImplementationPlanSections(artifact);

  return (
    <Card id="plan" className="scroll-mt-24">
      <CardHeader>
        <CardTitle>Implementation plan</CardTitle>
        <CardDescription>
          Submitted by the read-only planning session before any file was edited. A recovered run
          reads this plan rather than making a new one.
        </CardDescription>
      </CardHeader>
      <CardContent>
        {sections ? (
          <div className="space-y-5">
            {sections.map((section) => (
              <section key={section.key} className="space-y-1.5">
                <h3 className="text-muted-foreground text-xs font-medium tracking-wide uppercase">
                  {section.title}
                </h3>
                {section.items.length === 1 && section.key === "problemInterpretation" ? (
                  <p className="text-sm leading-relaxed whitespace-pre-wrap break-words">
                    {section.items[0]}
                  </p>
                ) : (
                  <ul className="marker:text-muted-foreground list-disc space-y-1 pl-5 text-sm leading-relaxed">
                    {section.items.map((item, index) => (
                      <li key={index} className="break-words">
                        {item}
                      </li>
                    ))}
                  </ul>
                )}
              </section>
            ))}
            {artifact ? (
              <p className="text-muted-foreground text-xs">
                Artifact #{String(artifact.id)} · recorded {formatDateTime(artifact.createdAt)}
              </p>
            ) : null}
          </div>
        ) : artifact ? (
          <p className="text-muted-foreground text-sm">
            Artifact #{String(artifact.id)} is not a readable structured plan. The raw record is
            still listed under Artifacts.
          </p>
        ) : (
          <p className="text-muted-foreground text-sm">
            No plan has been recorded yet. It appears once the planning phase submits one.
          </p>
        )}
      </CardContent>
    </Card>
  );
}
