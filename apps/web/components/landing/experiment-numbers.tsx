import { EXPERIMENT_1 } from "@/lib/landing/experiment-1";

export function ExperimentNumbers() {
  return (
    <div className="space-y-6">
      <div className="grid gap-px sm:grid-cols-2" style={{ background: "var(--landing-rule)" }}>
        <Arm arm={EXPERIMENT_1.independent} />
        <Arm arm={EXPERIMENT_1.none} />
      </div>
      <dl className="font-landing-mono grid gap-3 text-[12px] sm:grid-cols-3">
        <Delta label="Success" value={EXPERIMENT_1.delta.successRate} />
        <Delta label="Cost" value={EXPERIMENT_1.delta.cost} />
        <Delta label="Mean runtime" value={EXPERIMENT_1.delta.meanRuntime} />
      </dl>
      <p className="text-landing-muted max-w-2xl text-sm leading-relaxed">{EXPERIMENT_1.caveat}</p>
      <p className="font-landing-mono text-landing-muted text-[11px]">
        {EXPERIMENT_1.cases} cases × {EXPERIMENT_1.repetitions} repetitions × 2 arms ·{" "}
        {EXPERIMENT_1.model} · {EXPERIMENT_1.runDate} · suite {EXPERIMENT_1.suiteId}
      </p>
    </div>
  );
}

function Arm({
  arm,
}: {
  arm: (typeof EXPERIMENT_1)["independent"] | (typeof EXPERIMENT_1)["none"];
}) {
  return (
    <div className="space-y-4 p-5" style={{ background: "var(--landing-paper)" }}>
      <p className="font-landing-mono text-landing-muted text-[11px] tracking-[0.14em] uppercase">
        {arm.label}
      </p>
      <p className="font-landing-display text-4xl font-semibold tracking-tight">
        {arm.successFraction}
      </p>
      <p className="text-landing-muted text-sm">{arm.successRate} graded success</p>
      <dl className="font-landing-mono grid grid-cols-2 gap-x-4 gap-y-2 text-[12px]">
        <dt className="text-landing-muted">Mean score</dt>
        <dd>{arm.meanScore}</dd>
        <dt className="text-landing-muted">Model cost</dt>
        <dd>{arm.totalCostUsd}</dd>
        <dt className="text-landing-muted">Median runtime</dt>
        <dd>{arm.medianRuntimeS}</dd>
        <dt className="text-landing-muted">Review</dt>
        <dd>{arm.reviewOutcomes}</dd>
      </dl>
    </div>
  );
}

function Delta({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <dt className="text-landing-muted">{label}</dt>
      <dd className="mt-1">{value}</dd>
    </div>
  );
}
