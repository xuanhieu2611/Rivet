/**
 * The tasks `pnpm demo:job` can ask a real coding session to do.
 *
 * Both of them run against the same external fixture repository,
 * `github.com/xuanhieu2611/rivet-fixture-node`, which is deliberately boring: a
 * bulk-discount module, a `node --test` suite, dependency-free `typecheck` and
 * `lint` scripts, and one seeded bug (`qualifiesForBulkDiscount` uses `>` where
 * the spec says "or more"). The fixture lives outside this repository and this
 * file is the only place a task for it is written down, so a second task is a
 * second entry here rather than a second demo command.
 *
 * The two tasks exist because they ask different questions.
 *
 * `bulk-discount-boundary` is Milestone 5's and Milestone 7's task, unchanged.
 * It is a single inverted comparison with a test that names it, so deterministic
 * validation answers the whole question: the suite was red, the suite is green,
 * the job is correct. It stays the default because it is the cheapest task that
 * proves the pipeline works end to end.
 *
 * `multi-line-order` is Milestone 8's, and it is built so that deterministic
 * validation cannot answer the question. It asks for the same one-line fix *and*
 * for a new function, and the new function's hard parts - rounding the discount
 * exactly once over the whole order, and an empty order totalling zero rather
 * than throwing - are named in the issue text and covered by no test in the
 * repository. The obvious implementation therefore lands with the test check
 * `fixed`, typecheck and lint `verified` and the job's aggregate outcome green,
 * while still being wrong in a way the issue text already told it about. That
 * is the fixture M8's review loop needs: a run where M7 has nothing left to say
 * and the correct verdict is still `revise`.
 *
 * Pairing the new function with the seeded bug is not padding. Without the fix
 * the suite is still red after the session, the test check compares as
 * `unresolved`, and `testing` fails the job before `reviewing` ever runs - so a
 * feature-only task could never reach the reviewer at all.
 */

export interface DemoTask {
  /** How `RIVET_DEMO_TASK` selects it. */
  readonly id: string;
  /** The job title, which is the first half of what the agent is told. */
  readonly title: string;
  /** The issue text. The named edge cases are the reviewer's evidence. */
  readonly description: string;
}

const BULK_DISCOUNT_BOUNDARY: DemoTask = {
  id: "bulk-discount-boundary",
  title: "Fix the bulk discount boundary",
  description:
    "The fixture says that 10 items or more qualify for the bulk discount, but the " +
    "implementation uses a strict greater-than comparison. Fix the bug without weakening " +
    "the tests, then run the repository test suite before you finish and summarize the " +
    "change in your final message.",
};

const MULTI_LINE_ORDER: DemoTask = {
  id: "multi-line-order",
  title: "Price a multi-line order",
  description:
    "Orders can now arrive as several lines, and `src/discount.js` can only price one. Add " +
    "and export `orderTotalCents(lines)`, where a line is `{ quantity, unitPriceCents }` and " +
    "an order is an array of them. Four rules, and all four are part of the task.\n\n" +
    "1. Qualification is decided by the total item count across every line, so an order of " +
    "4 items plus 6 items qualifies exactly as an order of 10 items on one line does.\n" +
    "2. `qualifiesForBulkDiscount` currently uses a strict greater-than where the spec says " +
    "10 items or more, so it disagrees with rule 1 at the boundary. Fix it, and do not " +
    "weaken the test that names it.\n" +
    "3. The discount applies once to the whole order subtotal, and the result is rounded to " +
    "the nearest cent exactly once at the end. Discounting and rounding each line separately " +
    "is wrong and is off by a cent on orders whose lines land on half cents.\n" +
    "4. An order with no lines totals 0 and must not throw. A negative quantity or a " +
    "fractional unit price is still a TypeError, exactly as the existing functions treat them.\n\n" +
    "Do not change the existing exports' signatures. Run the repository test suite before you " +
    "finish and summarize the change in your final message.",
};

export const DEMO_TASKS: readonly DemoTask[] = [BULK_DISCOUNT_BOUNDARY, MULTI_LINE_ORDER];

/** The task `pnpm demo:job` runs when `RIVET_DEMO_TASK` is unset. */
export const DEFAULT_DEMO_TASK_ID = BULK_DISCOUNT_BOUNDARY.id;

/**
 * Resolves a task id, or throws with the list of ids that exist.
 *
 * A typo silently running the wrong task would be worse than a demo that
 * refuses to start: both tasks look alike in the log for their first two
 * minutes, and the one thing they differ on is what the reviewer should say.
 */
export function selectDemoTask(id: string | undefined): DemoTask {
  const wanted = id ?? DEFAULT_DEMO_TASK_ID;
  const task = DEMO_TASKS.find((candidate) => candidate.id === wanted);
  if (!task) {
    throw new Error(
      `Unknown RIVET_DEMO_TASK "${wanted}". Known tasks: ` +
        `${DEMO_TASKS.map((candidate) => candidate.id).join(", ")}.`,
    );
  }
  return task;
}
