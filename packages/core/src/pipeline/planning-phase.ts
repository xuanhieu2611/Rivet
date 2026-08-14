import type { PhaseContext } from "./phase-context";

/**
 * Phase three: say plainly that no plan was made.
 *
 * The status stays in the walk because Milestone 6 fills this body with a real
 * plan artifact, and adding a status back later is a migration where filling a
 * body is an edit. What does not stay is the two-second sleep it used to be: a
 * phase that sleeps looks exactly like a phase that works to whoever is watching
 * the timeline, and that is a lie the demo tells for free.
 *
 * So the body is one event and a return, with `durationMs: 0` behind it. The
 * phase still transitions, still appears in the timeline, and now says which of
 * the two it is.
 *
 * A closure returning the body, like every other phase here, even though there
 * is nothing to close over yet. Milestone 6 needs `PipelineOptions` for the plan
 * session's bounds, and the alternative is changing this file's export shape and
 * its call site at the moment that work starts.
 */
export function planningPhase(): (ctx: PhaseContext) => Promise<void> {
  return async function planning(ctx: PhaseContext): Promise<void> {
    ctx.signal.throwIfAborted();

    await ctx.event({
      type: "plan.deferred",
      message:
        "No plan was produced. The coding session does its own planning at Milestone 5; " +
        "a persisted plan artifact is Milestone 6.",
    });

    ctx.log.info({ phase: ctx.phase.status }, "planning deferred to the coding session");
  };
}
