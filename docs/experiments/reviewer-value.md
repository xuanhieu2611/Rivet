# Experiment 1: independent review versus no review

| Field       | Value                                   |
| ----------- | --------------------------------------- |
| Run date    | 2026-08-17                              |
| Full suite  | `e222928b-1de4-458d-a57a-7c93f0651421`  |
| Smoke suite | `7ae2e626-ed62-40ab-ab7f-7644df890f5f`  |
| Model       | `openrouter/deepseek/deepseek-v4-flash` |
| Concurrency | 1                                       |

## Method

The full suite ran the five checked-in benchmark cases three times under each of two arms:

- `independent`: `reviewMode: "independent"`
- `none`: `reviewMode: "none"`

Both arms used the same local, lock-pinned benchmark fixtures, Docker image, job budgets, worker,
validation and grader. GitHub publication was disabled. The runner created ordinary jobs through
Postgres, Redis and BullMQ, and graded each completed job in a separate container.

Before spending on the full suite:

1. `pnpm eval:run --dry-run` printed the expected 30-run matrix.
2. `pnpm eval:build` rebuilt all five fixtures and matched their checked-in lockfiles.
3. A two-run smoke suite used `bulk-discount-boundary`, one repetition per arm. Both runs passed,
   and the observed model cost was `$0.0047` total.

The full suite then completed all 30 runs. Before starting, the configured ceiling was calculated as
`3 repetitions x 2 arms x ($1.00 + $1.50 + $2.00 + $2.00 + $2.50) = $54.00`. The actual recorded
model cost was `$0.1144`, well below that ceiling.

## Results

The evaluation store reports success over graded runs (`passed + failed`), excluding errored and
ungraded runs from the denominator. There were no errored or ungraded runs.

| Measure          | Independent review |      No review | Delta, independent minus none |
| ---------------- | -----------------: | -------------: | ----------------------------: |
| Success rate     |    15/15 (100.00%) | 14/15 (93.33%) |       +6.67 percentage points |
| Mean score       |             1.0000 |         0.9778 |                       +0.0222 |
| Total model cost |            $0.0675 |        $0.0469 |             +$0.0206 (+43.9%) |
| Mean model cost  |            $0.0045 |        $0.0031 |                      +$0.0014 |
| Median runtime   |               143s |            95s |                          +48s |
| Mean runtime     |             158.1s |         106.3s |               +51.9s (+48.9%) |
| Model calls      |                190 |            151 |                  +39 (+25.8%) |
| Tool calls       |                294 |            213 |                  +81 (+38.0%) |
| Input tokens     |            428,512 |        270,526 |             +157,986 (+58.4%) |
| Output tokens    |             90,801 |         67,679 |              +23,122 (+34.2%) |
| Review outcomes  |        15 approved |     15 skipped |                             - |

The grader recorded 141 of 142 parsed assertions overall: 72/72 for the independent arm and 69/70
for the no-review arm. The one failed run was `extract-pricing-module`, no review, repetition 3: it
completed the job and validation, but the grading command passed 2 of 3 assertions, for a score of
`0.6667`. Its failure category was intentionally left unlabeled because the taxonomy does not make
that judgement automatically.

### Per-case results

The score column is the mean score across the three repetitions; the range in parentheses is the
repetition spread. Costs are the sum for that case and arm.

| Case                     | Category     |          Independent review |                   No review | Success delta | Cost, independent / none |
| ------------------------ | ------------ | --------------------------: | --------------------------: | ------------: | -----------------------: |
| `bulk-discount-boundary` | `bug_fix`    | 3/3, 1.0000 (1.0000-1.0000) | 3/3, 1.0000 (1.0000-1.0000) |       0.00 pp |        $0.0073 / $0.0052 |
| `stale-cache-key`        | `bug_fix`    | 3/3, 1.0000 (1.0000-1.0000) | 3/3, 1.0000 (1.0000-1.0000) |       0.00 pp |        $0.0101 / $0.0073 |
| `multi-line-order`       | `feature`    | 3/3, 1.0000 (1.0000-1.0000) | 3/3, 1.0000 (1.0000-1.0000) |       0.00 pp |        $0.0171 / $0.0106 |
| `extract-pricing-module` | `refactor`   | 3/3, 1.0000 (1.0000-1.0000) | 2/3, 0.8889 (0.6667-1.0000) |     +33.33 pp |        $0.0136 / $0.0114 |
| `paginate-list-endpoint` | `api_change` | 3/3, 1.0000 (1.0000-1.0000) | 3/3, 1.0000 (1.0000-1.0000) |       0.00 pp |        $0.0194 / $0.0124 |

The per-case success delta for `extract-pricing-module` is +33.33 percentage points because the
comparison is 3/3 versus 2/3. Its mean-score delta is +0.1111.

## Interpretation

In this run, the independent-review arm had one fewer failed task and a 6.67 percentage-point higher
success rate. It also cost 43.9% more per arm and took about 49% longer on average. The absolute
cost was still small because the fixtures are intentionally dependency-free and the model is
inexpensive.

This result does not establish that the reviewer caused the improvement. The only no-review failure
was in one repetition of one case, while every independent review was approved without a revision
loop. The data therefore shows a useful signal, not a demonstrated reviewer correction. The
independent arm could have benefited from ordinary model sampling variance, and the benchmark cases
are small synthetic fixtures authored alongside the harness.

There were only 15 observations per arm and three repetitions per case. That is enough to expose a
large difference in this particular run, but not enough to support a general claim about reviewer
value, models, repositories or production tasks. A 30-run total sample cannot reliably distinguish a
small effect from variance. More varied, pinned real-world tasks and substantially more repetitions
are needed before using this result to choose a default workflow.

The raw suite is available in the evaluation database under `e222928b-1de4-458d-a57a-7c93f0651421`;
the per-run job timelines remain available from the corresponding evaluation dashboard at
`/evaluations/e222928b-1de4-458d-a57a-7c93f0651421`.
