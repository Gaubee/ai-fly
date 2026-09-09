/**
 * jixoai toast swipe math (registry/files/ui/toast/toast-swipe.ts;
 * toast-v2, 2026-09-02) — the release judge as a PURE function.
 * sonner's criteria, restated: a drag dismisses when its displacement
 * crosses the threshold OR its momentum crosses the velocity line,
 * along a direction the toast allows; anything else springs back.
 * Kept DOM-free so the spec can exercise every branch.
 */
import type { SwipeDirection } from '$lib/toast-store';

export const SWIPE_THRESHOLD_PX = 48;
export const SWIPE_VELOCITY = 0.11; // px/ms
export const SWIPE_FRICTION = 0.2; // cross-axis carry

export interface SwipeVerdict {
  dismiss: boolean;
  /** the dominant axis the release rode */
  axis: 'x' | 'y';
}

export function judgeSwipe(
  dx: number,
  dy: number,
  dt: number,
  dirs: readonly SwipeDirection[],
): SwipeVerdict {
  const vx = dt > 0 ? Math.abs(dx) / dt : 0;
  const vy = dt > 0 ? Math.abs(dy) / dt : 0;
  if (Math.abs(dx) >= Math.abs(dy)) {
    const allowed = dirs.includes(dx < 0 ? 'left' : 'right');
    return {
      dismiss: allowed && (Math.abs(dx) >= SWIPE_THRESHOLD_PX || vx > SWIPE_VELOCITY),
      axis: 'x',
    };
  }
  const allowed = dirs.includes(dy < 0 ? 'up' : 'down');
  return {
    dismiss: allowed && (Math.abs(dy) >= SWIPE_THRESHOLD_PX || vy > SWIPE_VELOCITY),
    axis: 'y',
  };
}

/** the drag's visual displacement with cross-axis friction applied —
 *  the allowed axis rides free, the other carries at SWIPE_FRICTION.
 *  NEITHER allowed → both carry damped (a fully disallowed drag still
 *  tracks the hand, at friction — never 1:1, R1 P3-2) */
export function frictionShift(
  dx: number,
  dy: number,
  dirs: readonly SwipeDirection[],
): { x: number; y: number } {
  const xAllowed = dirs.includes(dx < 0 ? 'left' : 'right');
  const yAllowed = dirs.includes(dy < 0 ? 'up' : 'down');
  if (xAllowed && !yAllowed) return { x: dx, y: dy * SWIPE_FRICTION };
  if (yAllowed && !xAllowed) return { x: dx * SWIPE_FRICTION, y: dy };
  if (!xAllowed && !yAllowed) return { x: dx * SWIPE_FRICTION, y: dy * SWIPE_FRICTION };
  return { x: dx, y: dy };
}
