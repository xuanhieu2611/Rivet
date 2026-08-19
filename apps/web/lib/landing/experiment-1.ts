/**
 * Snapshot of Experiment 1, written by the evaluation run, not read from
 * Postgres. The landing page imports this module. A live query here would
 * make `pnpm build` need `DATABASE_URL`, which is the property CI's verify
 * job exists to protect.
 *
 * Source: `docs/experiments/reviewer-value.md`, suite
 * `e222928b-1de4-458d-a57a-7c93f0651421`, 2026-08-17.
 */
export const EXPERIMENT_1 = {
  runDate: "2026-08-17",
  suiteId: "e222928b-1de4-458d-a57a-7c93f0651421",
  model: "openrouter/deepseek/deepseek-v4-flash",
  cases: 5,
  repetitions: 3,
  independent: {
    label: "Independent review",
    successFraction: "15/15",
    successRate: "100.00%",
    meanScore: "1.0000",
    totalCostUsd: "$0.0675",
    medianRuntimeS: "143s",
    meanRuntimeS: "158.1s",
    reviewOutcomes: "15 approved",
  },
  none: {
    label: "No review",
    successFraction: "14/15",
    successRate: "93.33%",
    meanScore: "0.9778",
    totalCostUsd: "$0.0469",
    medianRuntimeS: "95s",
    meanRuntimeS: "106.3s",
    reviewOutcomes: "15 skipped",
  },
  delta: {
    successRate: "+6.67 pp",
    cost: "+$0.0206 (+43.9%)",
    meanRuntime: "+51.9s (+48.9%)",
  },
  caveat:
    "Fifteen observations per arm. The independent arm had one fewer failed task in this run. That is a useful signal, not a demonstrated reviewer correction, and not a reason to pick a default workflow.",
} as const;
