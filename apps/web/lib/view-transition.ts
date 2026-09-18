/**
 * The list-to-detail title morph, minus the DOM.
 *
 * Next 16 ships no router integration for view transitions - `experimental` has
 * no flag for it and the stable React build exports no `<ViewTransition>` - so
 * Rivet drives `document.startViewTransition` itself from one link component.
 * The parts worth testing are the decisions, and the decisions are here: what
 * counts as a navigation worth intercepting, and whether the browser can do it
 * at all. The component is then thin enough to read in one pass.
 */

/**
 * The shared name, and deliberately a constant rather than one per job id.
 *
 * A view transition requires each name to be unique within the old document and
 * within the new one, so only the clicked row wears it: a per-job name would
 * put fifty of them on the list page and make every one of them a separate
 * snapshot layer for a transition that morphs exactly one.
 */
export const JOB_TITLE_VIEW_TRANSITION_NAME = "job-title";

/**
 * How long the transition waits for the router before it gives up.
 *
 * The page is frozen on its old snapshot until the update callback settles, so
 * a navigation that stalls - a slow RSC payload, an offline hop - would freeze
 * the product rather than merely fail to animate. The ceiling turns that into a
 * plain navigation that arrives late.
 */
export const VIEW_TRANSITION_TIMEOUT_MS = 800;

/** The subset of a click event this decision needs, so a test can hand it a literal. */
export interface NavigationIntent {
  button: number;
  metaKey: boolean;
  ctrlKey: boolean;
  shiftKey: boolean;
  altKey: boolean;
  defaultPrevented: boolean;
}

/**
 * Whether this click is the one that means "go there, in this tab".
 *
 * Every other click already means something to the browser - a middle click or
 * ⌘-click opens a tab, shift opens a window, alt downloads - and intercepting
 * one to run an animation would break it.
 */
export function isPlainLeftClick(intent: NavigationIntent): boolean {
  return (
    intent.button === 0 &&
    !intent.metaKey &&
    !intent.ctrlKey &&
    !intent.shiftKey &&
    !intent.altKey &&
    !intent.defaultPrevented
  );
}

export interface ViewTransitionHandle {
  finished: Promise<unknown>;
}

export type StartViewTransition = (callback: () => void | Promise<void>) => ViewTransitionHandle;

/**
 * `document.startViewTransition`, bound, or null where there is no such thing.
 *
 * TypeScript's `lib.dom` declares the method unconditionally, which makes the
 * one check that matters invisible to the compiler: Firefox shipped it well
 * after Chrome and Safari, and a browser without it must navigate normally
 * rather than throw on the way to a nicety.
 */
export function viewTransitionStarter(doc: unknown): StartViewTransition | null {
  if (typeof doc !== "object" || doc === null) return null;
  const candidate = (doc as { startViewTransition?: unknown }).startViewTransition;
  if (typeof candidate !== "function") return null;
  return (candidate as StartViewTransition).bind(doc);
}
