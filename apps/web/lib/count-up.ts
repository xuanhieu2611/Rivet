/**
 * The tween behind the live counters.
 *
 * Pure, and separate from the component, for the same reason `phase-progress.ts`
 * is separate from the stepper: the interesting part is the arithmetic, and
 * arithmetic is testable in a node environment where `requestAnimationFrame` is
 * not.
 */

export const COUNT_UP_MIN_MS = 220;
export const COUNT_UP_MAX_MS = 720;

/** Fast out of the gate, settling onto the value rather than stopping at it. */
export function easeOutCubic(progress: number): number {
  const clamped = Math.min(1, Math.max(0, progress));
  return 1 - (1 - clamped) ** 3;
}

/**
 * How long a step from `from` to `to` should take.
 *
 * Proportional to the *share* of the number that changed rather than to the
 * absolute delta. 40 tokens onto 20 is the whole counter moving and deserves
 * the full sweep; 40 tokens onto 400,000 is a rounding error, and animating it
 * for the same three quarters of a second would leave the header permanently
 * mid-tween on a long run.
 */
export function countUpDurationMs(from: number, to: number): number {
  if (!Number.isFinite(from) || !Number.isFinite(to)) return 0;
  const delta = Math.abs(to - from);
  if (delta === 0) return 0;

  const magnitude = Math.max(Math.abs(from), Math.abs(to));
  const share = magnitude === 0 ? 1 : Math.min(1, delta / magnitude);
  return Math.round(COUNT_UP_MIN_MS + (COUNT_UP_MAX_MS - COUNT_UP_MIN_MS) * share);
}

/**
 * The value to paint `elapsedMs` into a `durationMs` tween.
 *
 * Clamped at both ends, so a frame delivered late lands exactly on the target
 * instead of overshooting it. A counter that reads one token above the truth
 * for a frame is a counter nobody can trust.
 */
export function countUpValue(
  from: number,
  to: number,
  elapsedMs: number,
  durationMs: number,
): number {
  if (!Number.isFinite(from) || !Number.isFinite(to)) return to;
  if (durationMs <= 0 || elapsedMs >= durationMs) return to;
  if (elapsedMs <= 0) return from;
  return from + (to - from) * easeOutCubic(elapsedMs / durationMs);
}
