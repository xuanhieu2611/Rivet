import { EXPERIMENT_1 } from "@/lib/landing/experiment-1";

export function ExperimentNumbers() {
  return (
    <div className="space-y-8">
      <div className="grid overflow-hidden rounded-[var(--radius)] sm:grid-cols-2">
        <Arm arm={EXPERIMENT_1.independent} featured />
        <Arm arm={EXPERIMENT_1.none} />
      </div>
      <dl className="grid gap-6 sm:grid-cols-3">
        <Delta label="Success" value={EXPERIMENT_1.delta.successRate} />
        <Delta label="Cost" value={EXPERIMENT_1.delta.cost} />
        <Delta label="Mean runtime" value={EXPERIMENT_1.delta.meanRuntime} />
      </dl>
      <p className="text-landing-muted max-w-2xl text-base leading-relaxed">
        {EXPERIMENT_1.caveat}
      </p>
      <p className="font-landing-mono text-landing-muted text-xs leading-relaxed">
        {EXPERIMENT_1.cases} cases × {EXPERIMENT_1.repetitions} repetitions × 2 arms
        <br />
        {EXPERIMENT_1.model}
        <br />
        {EXPERIMENT_1.runDate}, suite {EXPERIMENT_1.suiteId}
      </p>
    </div>
  );
}

function Arm({
  arm,
  featured = false,
}: {
  arm: (typeof EXPERIMENT_1)["independent"] | (typeof EXPERIMENT_1)["none"];
  featured?: boolean;
}) {
  return (
    <div
      className="space-y-4 p-6 sm:p-8"
      style={{
        background: featured
          ? "color-mix(in oklch, var(--landing-rivet) 12%, var(--landing-paper))"
          : "var(--landing-still)",
        border: "1px solid var(--landing-rule)",
      }}
    >
      <p className="text-landing-muted text-sm">{arm.label}</p>
      <p className="text-5xl font-semibold tracking-tight">{arm.successFraction}</p>
      <p className="text-landing-muted text-sm">{arm.successRate} graded success</p>
      <dl className="grid grid-cols-2 gap-x-4 gap-y-3 text-sm">
        <div>
          <dt className="text-landing-muted">Mean score</dt>
          <dd className="mt-0.5 font-medium">{arm.meanScore}</dd>
        </div>
        <div>
          <dt className="text-landing-muted">Model cost</dt>
          <dd className="mt-0.5 font-medium">{arm.totalCostUsd}</dd>
        </div>
        <div>
          <dt className="text-landing-muted">Median runtime</dt>
          <dd className="mt-0.5 font-medium">{arm.medianRuntimeS}</dd>
        </div>
        <div>
          <dt className="text-landing-muted">Review</dt>
          <dd className="mt-0.5 font-medium">{arm.reviewOutcomes}</dd>
        </div>
      </dl>
    </div>
  );
}

function Delta({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <dt className="text-landing-muted text-sm">{label}</dt>
      <dd className="mt-1 text-lg font-semibold tracking-tight">{value}</dd>
    </div>
  );
}
