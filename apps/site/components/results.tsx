import { EXPERIMENT_1 } from "@/lib/experiment-1";
import { formatDate } from "@/lib/format";
import { LINKS } from "@/lib/links";

type Arm = (typeof EXPERIMENT_1)["independent"] | (typeof EXPERIMENT_1)["none"];

export function Results() {
  return (
    <div className="grid grid-cols-1 gap-12 lg:grid-cols-[minmax(0,1fr)_minmax(0,22rem)] lg:gap-16">
      <div className="border-rule grid overflow-hidden rounded-xl border sm:grid-cols-2">
        <ArmColumn arm={EXPERIMENT_1.independent} featured />
        <ArmColumn arm={EXPERIMENT_1.none} />
      </div>
      <div className="space-y-5 text-[0.9875rem] leading-relaxed">
        <p>
          {EXPERIMENT_1.cases} benchmark tasks, each run {EXPERIMENT_1.repetitions} times with and
          without the reviewer, and graded against hidden tests. With review, every run passed. It
          cost {EXPERIMENT_1.delta.costIncrease} more across all fifteen runs and took about{" "}
          {EXPERIMENT_1.delta.meanRuntimeIncrease} longer per run.
        </p>
        <p className="text-muted">
          Fifteen runs per side is a small sample: one extra pass is a signal, not proof that the
          reviewer caught a bug. The write-up says so, which is the point of measuring.
        </p>
        <p className="text-faint text-sm">
          Run on {formatDate(EXPERIMENT_1.runDate)} with {EXPERIMENT_1.modelName}.{" "}
          <a href={LINKS.experiment} className="link text-muted" target="_blank" rel="noreferrer">
            Read the experiment
          </a>
        </p>
      </div>
    </div>
  );
}

function ArmColumn({ arm, featured = false }: { arm: Arm; featured?: boolean }) {
  return (
    <div
      className={[
        "space-y-6 p-6 sm:p-8",
        featured ? "bg-teal/[0.07]" : "bg-surface border-rule border-t sm:border-t-0 sm:border-l",
      ].join(" ")}
    >
      <p className={featured ? "text-teal text-sm font-medium" : "text-muted text-sm font-medium"}>
        {arm.label}
      </p>
      <p>
        <span className="type-display text-5xl tabular-nums sm:text-6xl">
          {arm.successFraction}
        </span>
        <span className="text-muted mt-2 block text-sm">tasks passed hidden tests</span>
      </p>
      <dl className="grid grid-cols-2 gap-x-4 gap-y-4 text-sm">
        <div>
          <dt className="text-faint">Model cost, all runs</dt>
          <dd className="mt-1 font-medium tabular-nums">{arm.totalCostUsd}</dd>
        </div>
        <div>
          <dt className="text-faint">Median runtime</dt>
          <dd className="mt-1 font-medium tabular-nums">{arm.medianRuntimeS}</dd>
        </div>
      </dl>
    </div>
  );
}
