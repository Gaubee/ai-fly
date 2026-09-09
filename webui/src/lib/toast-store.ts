/**
 * jixoai toast store (registry/files/lib/toast-store.ts → @lib/toast-store.ts).
 * The state-and-lifecycle half of the toast pair — framework-free, DOM-free.
 * Pair with toast-viewport.svelte, which owns the presentation surface
 * (corner stack, max visible, live regions, dismiss buttons).
 *
 * Two seams, one reason (Codex batch-3 ruling): the STORE is created by
 * the application (createToastStore()) — never a module-level singleton,
 * so SSR requests never share state — and handed to the viewport mounted
 * once in the root layout. Anything in the app pushes through the api
 * handle it captured at creation.
 *
 * Intent list (2026-08-22, batch-3):
 *  1. push/dismiss/subscribe — the whole surface, ~100 lines
 *  2. per-toast expiry with hover/focus pause (arm/pause/resume)
 *  3. duration: 0 = sticky (only the dismiss button clears it)
 *  4. api.promise — the async two-step (enhance-picker-feedback,
 *     2026-08-30): the pending notice pushes at call time, settle
 *     REPLACES it; a rejection lands the error shape (tonal +
 *     jx-hue-error, assertive, sticky). Framework-free, no module
 *     side effects.
 *  5. setVisible — the viewport handshake (adjudicated D-2 fix,
 *     2026-09-02): expiry arms at FIRST VISIBILITY for viewport
 *     consumers; headless push stays arm-at-push. See the store
 *     interface doc below.
 *  6. pauseAll/resumeAll — the PAGE-VISIBILITY source (toast-v2,
 *     2026-09-02): a hidden tab freezes every clock (a toast must not
 *     burn out unseen); orthogonal to the per-id hold and the visible-
 *     set handshake — three independent freeze sources, one timer.
 *
 * Variant grammar (2026-08-26, variant-grammar change): the retired
 * tone law (default/primary/destructive) becomes the ladder —
 * variant 'outline' (default, the plain notice) | 'tonal' (tinted
 * emphasis) — and semantic hue rides the SAME class-utility injection
 * seam as markup: push({ variant: 'tonal', class:
 * 'jx-hue-error') for a failed status (error, never
 * the destructive action hue — design §3). The optional class lands
 * on the toast card through the viewport's cn() merge.
 */

/** the ladder prominence values — the SOLE declaration source of
 *  ToastVariant (slot-values-first r12 #6: the family Defaults slot
 *  imports this tuple — ui→lib is the legal direction — and const
 *  generic inference recovers the union from it, so no handwritten
 *  union may coexist) */
export const TOAST_VARIANT_VALUES = ['outline', 'tonal'] as const;

/** ladder prominence: outline (plain notice, default) | tonal (tinted
 *  emphasis) — typeof 反查 the values tuple above */
export type ToastVariant = (typeof TOAST_VARIANT_VALUES)[number];

/** the surface MATERIAL values — the sole declaration source of
 *  ToastMaterial (the twin of TOAST_VARIANT_VALUES above) */
export const TOAST_MATERIAL_VALUES = ['popover', 'glass'] as const;

/** the surface MATERIAL axis (float-button's model) — the ground the
 *  toast paints; variant stays the prominence ladder independently.
 *  typeof 反查 the values tuple above */
export type ToastMaterial = (typeof TOAST_MATERIAL_VALUES)[number];

/** the EFFECT loop axis — pulse (breathing ring) | sweep (traveling light) */
export type ToastEffect = 'none' | 'pulse' | 'sweep';

/** the swipe-away axes (toast-v2, 2026-09-02): physical directions a
 *  drag may carry to dismiss; the per-position default vocabulary
 *  lives in SWIPE_BY_POSITION (the viewport applies it when the push
 *  does not name its own) */
export type SwipeDirection = 'up' | 'down' | 'left' | 'right';

/** per-POSTURE swipe defaults (sonner's law, restated from source): a
 *  toast dismisses toward its NEAREST screen edges — the position
 *  tokens ARE the directions (top-right → up + right). The keys use
 *  the place-self grammar of the anchor corner: 'start end' =
 *  block-start + inline-end = top-right, 'end end' = bottom-right. */
export const SWIPE_BY_POSITION: Readonly<Record<string, readonly SwipeDirection[]>> = Object.freeze(
  {
    'start start': ['left', 'up'],
    'start end': ['right', 'up'],
    'end start': ['left', 'down'],
    'end end': ['right', 'down'],
  },
);

/** the float plane's NINE slots (Owner R3, 2026-09-02): physical names
 *  over the float slot's grid cell. Corners resolve through
 *  SWIPE_BY_POSITION (toward the nearest edges); edge slots take the
 *  ONE outward axis (sonner's top-center precedent); the center takes
 *  none — an equidistant toast has no nearest edge, the × and expiry
 *  own its dismissal. Keys map 1:1 to data-float-pos. */
export const SWIPE_BY_FLOAT_POS: Readonly<Record<string, readonly SwipeDirection[]>> = Object.freeze(
  {
    'left-top': SWIPE_BY_POSITION['start start'],
    'center-top': ['up'],
    'right-top': SWIPE_BY_POSITION['start end'],
    'left-center': ['left'],
    'center-center': [],
    'right-center': ['right'],
    'left-bottom': SWIPE_BY_POSITION['end start'],
    'center-bottom': ['down'],
    'right-bottom': SWIPE_BY_POSITION['end end'],
  },
);

/** the nine slot names (the data-float-pos vocabulary) */
export type FloatPos =
  | 'left-top'
  | 'center-top'
  | 'right-top'
  | 'left-center'
  | 'center-center'
  | 'right-center'
  | 'left-bottom'
  | 'center-bottom'
  | 'right-bottom';

export interface ToastInit {
  title: string;
  description?: string;
  /** ladder prominence: outline (plain notice, default) | tonal (tinted emphasis) */
  variant?: ToastVariant;
  /** the surface material: popover (solid, default) | glass (backdrop-filter
   *  translucent — the entity law's restrained ground) */
  material?: ToastMaterial;
  /** the effect loop: none (default) | pulse (breathing ring) | sweep (a
   *  traveling light — the live/pending signal) */
  effect?: ToastEffect;
  /** render the countdown companion in the trailing lane (needs duration > 0;
   *  hover/focus pause freezes it) */
  countdown?: boolean;
  /** the toast grid's inline-start lane (an icon snippet) */
  leading?: import('svelte').Snippet;
  /** the toast grid's inline-end lane (actions, custom companions) */
  trailing?: import('svelte').Snippet;
  /** consumer classes — the hue-injection seam, e.g. 'jx-hue-error' */
  class?: string;
  /** ms until auto-dismiss; 0 = sticky. Default 5000 */
  duration?: number;
  /** true → the viewport announces this one assertively (role=alert) */
  assertive?: boolean;
  /** toast-v2 (2026-09-02): clicking the card expands it into a dialog
   *  through a view transition (shared element morph; WAAPI fallback in
   *  engines without VT) — the full-content reading posture */
  expandable?: boolean;
  /** toast-v2: the drag axes that dismiss this toast; default from
   *  SWIPE_BY_POSITION at the viewport's corner */
  swipeDirections?: readonly SwipeDirection[];
}

export interface ToastItem extends ToastInit {
  id: number;
}

export interface ToastApi {
  /** queue a toast; returns its id (for targeted dismiss) */
  push(init: ToastInit): number;
  dismiss(id: number): void;
  /** the current queue, oldest first — for tests and diagnostics */
  snapshot(): ToastItem[];
  /** the async two-step (enhance-picker-feedback, 2026-08-30): push the
   *  pending notice now, then ON SETTLE replace it — a resolve pushes
   *  the success message (polite, default expiry), a rejection pushes
   *  the error message (error variant: tonal + jx-hue-error, assertive,
   *  sticky — a failure must not auto-vanish). Framework-free, no
   *  module side effects; returns the pending toast's id. */
  promise<V>(task: Promise<V>, messages: ToastPromiseInit<V>): number;
}

/** a promise-toast message: a plain title string, a full ToastInit (minus
 *  id), or a function of the settled value / rejection reason returning
 *  either — the function is how "deployed build 4f2a" gets its sha */
export type ToastSettledMessage<V> =
  | string
  | Omit<ToastInit, 'id'>
  | ((value: V) => string | Omit<ToastInit, 'id'>);

export interface ToastPromiseInit<V> {
  /** the in-flight notice — pushed immediately, sticky by default (it is
   *  replaced on settle; a promise that never settles stays honest) */
  pending: string | Omit<ToastInit, 'id'>;
  /** on resolve; omitted → the pending toast is simply dismissed */
  success?: ToastSettledMessage<V>;
  /** on rejection; omitted → the pending toast is simply dismissed.
   *  Defaults to the error shape: tonal + jx-hue-error, assertive,
   *  sticky. A string is the title; an object OVERRIDES the defaults
   *  field-by-field (its `class` replaces jx-hue-error wholesale). */
  error?: ToastSettledMessage<unknown>;
}

interface ToastInternal {
  item: ToastItem;
  timer: ReturnType<typeof setTimeout> | undefined;
  /** remaining ms while paused; undefined while the timer runs */
  remaining: number | undefined;
  expiresAt: number;
  /** true while the VIEWPORT's hold (hover/focus) froze this toast —
   *  kept distinct from the visibility hold so the handshake below
   *  never stomps a user pause */
  held: boolean;
  /** true while the PAGE-VISIBILITY source froze this toast (toast-v2,
   *  2026-09-02): the tab is hidden; orthogonal to `held` and to the
   *  visible-set handshake — three freeze sources, one timer */
  visHeld: boolean;
  /** set when the visibility freeze captured a RUNNING timer (or the
   *  toast was pushed while hidden): resumeAll re-arms ONLY these —
   *  queued-never-seen toasts and hover-held toasts stay exactly as
   *  their own sources left them */
  visFrozenArmed: boolean;
}

export interface ToastStore {
  api: ToastApi;
  subscribe(fn: (items: ToastItem[]) => void): () => void;
  /** freeze one toast's countdown (viewport pointer/focus enter) */
  pause(id: number): void;
  /** unfreeze; restarts from the remaining time */
  resume(id: number): void;
  /** the visibility handshake (adjudicated D-2 fix, 2026-09-02): the
   *  viewport reports the id set it actually renders. Toasts OUTSIDE
   *  the set are held (expiry paused, remaining preserved — a queued
   *  toast never expires unseen); a held toast ARMS when it first
   *  enters the set, which is also when the countdown companion
   *  mounts — the two clocks start together. Headless consumers never
   *  call this: arm-at-push stays the default semantics. `null`
   *  detaches (everything resumes arm-at-push). */
  setVisible(ids: readonly number[] | null): void;
  /** toast-v2 (2026-09-02): the page-visibility source — freeze/resume
   *  EVERY clock at once (a hidden tab must not burn toasts out).
   *  Orthogonal to pause/resume (per-id hover hold) and setVisible
   *  (the visibility handshake): a toast frozen by this source stays
   *  frozen through the others' churn and re-arms only when it runs. */
  pauseAll(): void;
  resumeAll(): void;
}

const DEFAULT_DURATION = 5000;

export function createToastStore(): ToastStore {
  const subs = new Set<(items: ToastItem[]) => void>();
  const live = new Map<number, ToastInternal>();
  let queue: ToastItem[] = [];
  let nextId = 1;
  let now = () => Date.now();
  /** the page-visibility source's global state (toast-v2): while true,
   *  pushes do not arm — their full duration waits for the page */
  let pageHidden = false;
  /** the last visible set a viewport reported (toast-v2 R1, 2026-09-02):
   *  resumeAll re-arms ONLY ids the viewport actually renders — a
   *  pushed-while-hidden toast beyond maxVisible must NOT burn unseen
   *  the moment the page returns (D-2). `null` = no handshake owner. */
  let lastVisible: Set<number> | null = null;
  /** true once ANY viewport has reported a visible set (Codex Spec
   *  P1-1 fix, 2026-09-02): a push after that carries its duration in
   *  `remaining` and waits for the handshake's report — expiry arms at
   *  FIRST VISIBILITY, never a flush before the card mounts. Headless
   *  consumers never report: arm-at-push stays their default. */
  let visibleOwner = false;

  const emit = (): void => {
    const snapshot = [...queue];
    for (const fn of subs) fn(snapshot);
  };

  function clearTimer(internal: ToastInternal): void {
    if (internal.timer !== undefined) clearTimeout(internal.timer);
    internal.timer = undefined;
  }

  function arm(internal: ToastInternal): void {
    clearTimer(internal);
    const wait = internal.remaining ?? internal.expiresAt - now();
    if (wait <= 0) {
      dismiss(internal.item.id);
      return;
    }
    internal.timer = setTimeout(() => dismiss(internal.item.id), wait);
  }

  function dismiss(id: number): void {
    const internal = live.get(id);
    if (!internal) return;
    clearTimer(internal);
    live.delete(id);
    queue = queue.filter((item) => item.id !== id);
    emit();
  }

  function push(init: ToastInit): number {
    const id = nextId++;
    const item: ToastItem = { ...init, id };
    const duration = init.duration ?? DEFAULT_DURATION;
    const internal: ToastInternal = {
      item,
      timer: undefined,
      remaining: undefined,
      expiresAt: duration === 0 ? Infinity : now() + duration,
      held: false,
      visHeld: false,
      visFrozenArmed: false,
    };
    queue = [...queue, item];
    live.set(id, internal);
    // arm-at-push is the DEFAULT (headless) semantics; when a viewport
    // has reported a visible set, its effect follows with setVisible —
    // a pushed-but-queued toast is held there within the same flush.
    // A HIDDEN page (toast-v2) holds the full duration instead: the
    // clock never starts until the page can be seen. `remaining` (not
    // just expiresAt) carries the duration so resume RESTARTS it whole
    // — expiresAt-now() would go negative after a long hide and arm()
    // would dismiss the toast the instant the user returns, unseen
    // (adversarial R1 P1-2, 2026-09-02)
    if (duration !== 0) {
      if (pageHidden || visibleOwner) {
        // held until SEEN: a hidden page waits for the tab, a viewport
        // owner waits for its visible-set report (first-visibility
        // arming); `remaining` carries the whole duration for whoever
        // arms it next
        if (pageHidden) {
          internal.visHeld = true;
          internal.visFrozenArmed = true;
        }
        internal.remaining = duration;
      } else {
        arm(internal);
      }
    }
    emit();
    return id;
  }

  // ---- the async two-step ---------------------------------------------------
  // normalize a settled message: string → its title, function → applied to
  // the settled value then normalized, object → verbatim (minus id)
  function normalize<V>(
    message: ToastSettledMessage<V> | undefined,
    value: V,
  ): Omit<ToastInit, 'id'> | undefined {
    if (message == null) return undefined;
    const resolved = typeof message === 'function' ? message(value) : message;
    return typeof resolved === 'string' ? { title: resolved } : resolved;
  }

  function promise<V>(task: Promise<V>, messages: ToastPromiseInit<V>): number {
    const pendingInit =
      typeof messages.pending === 'string' ? { title: messages.pending } : messages.pending;
    // sticky while in flight — the settle swap is the exit, a promise
    // that never settles must keep saying so; an explicit duration wins
    const pendingId = push({ duration: 0, ...pendingInit });
    task.then(
      (value) => {
        dismiss(pendingId);
        const init = normalize(messages.success, value);
        if (init != null) push(init);
      },
      (reason: unknown) => {
        dismiss(pendingId);
        // the error shape IS the contract: tonal + jx-hue-error,
        // assertive, sticky — a consumer object overrides field-by-field
        const init = normalize(messages.error, reason) ?? { title: 'Something failed' };
        push({
          variant: 'tonal',
          class: 'jx-hue-error',
          assertive: true,
          duration: 0,
          ...init,
        });
      },
    );
    return pendingId;
  }

  return {
    api: {
      push,
      dismiss,
      snapshot: () => [...queue],
      promise,
    },
    subscribe(fn: (items: ToastItem[]) => void): () => void {
      subs.add(fn);
      fn([...queue]);
      return () => subs.delete(fn);
    },
    pause(id: number): void {
      const internal = live.get(id);
      if (!internal || internal.expiresAt === Infinity) return;
      if (internal.timer !== undefined) {
        internal.remaining = internal.expiresAt - now();
        clearTimer(internal);
      }
      // timer-less (already frozen by the hover hold or the handshake):
      // the pause still CLAIMS the hold — without this, a pause after a
      // pause is a no-op and the SECOND holder's release would re-arm
      // the clock mid-freeze (the expandable dialog's reading posture,
      // adversarial R1 P1-1, 2026-09-02)
      internal.held = true;
    },
    resume(id: number): void {
      const internal = live.get(id);
      if (!internal || !internal.held) return;
      internal.held = false;
      // a hidden page keeps the clock frozen — release the hold flag,
      // the page-visibility source re-arms on its own resume
      if (internal.visHeld) return;
      internal.expiresAt = now() + (internal.remaining ?? 0);
      internal.remaining = undefined;
      arm(internal);
    },
    pauseAll(): void {
      pageHidden = true;
      for (const internal of live.values()) {
        if (internal.expiresAt === Infinity) continue; // sticky: no clock
        if (internal.timer !== undefined) {
          internal.remaining = internal.expiresAt - now();
          clearTimer(internal);
          internal.visFrozenArmed = true;
        }
        internal.visHeld = true;
      }
    },
    resumeAll(): void {
      pageHidden = false;
      for (const internal of live.values()) {
        const hadRemaining = internal.remaining !== undefined;
        internal.visHeld = false;
        internal.visFrozenArmed = false;
        // re-arm toasts holding a FROZEN clock that the viewport
        // actually renders — hover-held (held) and queued-never-seen
        // (outside lastVisible) toasts keep their own state; the
        // handshake re-arms a promoted toast when it first renders.
        // The gate reads `remaining`, NOT the visFrozenArmed stamp: a
        // toast PROMOTED while hidden carries remaining from the
        // handshake but no stamp (pauseAll only stamps RUNNING timers)
        // — gating on the stamp left it frozen forever with a draining
        // countdown (re-attack R2 P2-1, 2026-09-02)
        if (
          hadRemaining &&
          !internal.held &&
          (lastVisible === null || lastVisible.has(internal.item.id))
        ) {
          arm(internal);
        }
      }
    },
    setVisible(ids: readonly number[] | null): void {
      const visible = ids === null ? null : new Set(ids);
      lastVisible = visible;
      if (visible !== null) visibleOwner = true;
      else {
        // the owner LEFT (outside the loop: an EMPTY store detaches
        // too): future pushes return to arm-at-push — a lingering
        // visibleOwner would pend them forever with nobody left to
        // report (re-attack matrix 5, 2026-09-02)
        visibleOwner = false;
      }
      for (const internal of live.values()) {
        if (internal.expiresAt === Infinity) continue; // sticky: no clock
        // detach (ids === null): no viewport owns the hold anymore —
        // a hover/focus pause must not outlive its viewport, or the
        // toast freezes forever with no one left to resume it
        // (CR-1 P3-2, 2026-09-02). The leaving viewport also owned the
        // page-visibility listener — retire that source too, or the
        // store stays pageHidden forever and every later push lands
        // un-armed (adversarial R1 P2-3, 2026-09-02). Everything
        // resumes arm-at-push.
        if (visible === null) {
          pageHidden = false;
          internal.visHeld = false;
          internal.visFrozenArmed = false;
          internal.held = false;
          if (internal.remaining !== undefined) {
            // includes never-reported pushes: the owner is gone, the
            // toast re-arms from its whole carried duration
            internal.expiresAt = now() + internal.remaining;
            internal.remaining = undefined;
            arm(internal);
          }
          continue;
        }
        const seen = visible.has(internal.item.id);
        // never stomp the viewport's hover/focus hold: `held` is the
        // user pause; the visibility hold only pauses/resumes toasts
        // the hold does not own — and a hidden page outranks both.
        // A toast OUTSIDE the visible set cannot be hovered — if a
        // queue eviction removed the card under the pointer, void the
        // stranded hold here: the handshake owns the freeze from now
        // on and re-entry re-arms it (adversarial R1 P2-1, 2026-09-02)
        if (!seen && !internal.visHeld) {
          internal.held = false;
          if (internal.timer !== undefined) {
            internal.remaining = internal.expiresAt - now();
            clearTimer(internal);
          }
        } else if (seen && !internal.held && !internal.visHeld && internal.remaining !== undefined) {
          // first visibility (or re-entry): the clock starts NOW —
          // aligned with the countdown companion mounting this frame
          internal.expiresAt = now() + internal.remaining;
          internal.remaining = undefined;
          arm(internal);
        }
      }
    },
  };
}
