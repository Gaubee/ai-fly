<!--
  jixoai toast viewport (registry/files/ui/toast/toast-viewport.svelte;
  material/effect rebuild, 2026-09-01; stacking dialect + swipe +
  visibility pause + expandable, 2026-09-02 toast-v2).
  The presentation half of the toast pair: mount ONCE in the root
  layout with the store your app created —

    const toast = createToastStore();
    <ToastViewport store={toast} />
    …anywhere: toast.api.push({ title: 'Deployed' })

  THE VIEWPORT DOES NOT FLOAT ITSELF (Owner ruling, 2026-09-01 — the
  float-button law): when a website-scaffold is present, the stack
  ADOPTS into its top layer's float plane through the SAME jx-top-layer
  context contract (via ScaffoldFloat — one adoption mechanism); the
  stack then flows inside the plane (end-corner alignment, zero fixed
  positioning). Without a scaffold (registry standalone), the legacy
  fixed corner remains the fallback. The adopted WRAPPER is pointer-
  transparent and content-sized (the overlay pointer law, D-1 2026-09-02
  — see website-scaffold.css): the STACK paints pointer-events:none and
  every CARD opts back in with pointer-events:auto, so the plane can
  never shield the page beneath it.

  THE STACKING DIALECT (toast-v2, 2026-09-02 — sonner's physics in the
  grid grammar): every card is [grid-area:1/1] of the stack's ONE cell
  and carries its geometry by TRANSFORM — collapsed (default) reads as
  one surface: the front (newest) card full size, cards behind it at
  translateY(-gap·i) + scale(1-0.05·i) depth (per-card vars stamped
  here from the rendered index; the transform math lives in toast.css
  so reduced-motion neutralizes it in one place). Collapsed rear slabs
  normalize their height to the front card (their descriptions paint
  transparent — geometry kept for the slab, ink withheld). Hover/touch
  the stack → EXPANDED: each card rides to its own measured offset
  (--jx-toast-ey from the card registry below); the ::after bridge in
  toast.css keeps the pointer from falling between cards mid-hover.
  `expand` forces the expanded posture. No position tech anywhere.

  THE SWIPE (toast-v2): a card drag writes --jx-toast-swipe-x/y on the
  VISUAL card (the wrapper's style attribute belongs to Svelte's
  stacking vars — JS-set props there would be wiped on re-render; the
  inner node has no Svelte style attr, so the drag owns it). The drag
  state rides the ELEMENT (a re-render mid-gesture recreates handlers;
  element state survives). Cross-axis carry is damped ×0.2. Release
  judges displacement ≥ 48px OR velocity > 0.11 px/ms along an ALLOWED
  direction (the push's swipeDirections, defaulting from
  SWIPE_BY_FLOAT_POS) → dismiss through the normal pipeline; anything
  else springs back (the vars are removed; the CSS transition returns
  the card). setPointerCapture keeps the drag when the pointer leaves.

  THE VISIBILITY PAUSE (toast-v2): document.visibilitychange wires the
  store's pauseAll/resumeAll — a hidden tab freezes every clock; the
  per-id hold and the visible-set handshake ride along untouched
  (three freeze sources, one timer — see toast-store.ts).

  THE EXPANDABLE DIALOG (toast-v2): a push with expandable:true gets a
  card that opens ToastDialog through a view transition (shared
  view-transition-name jx-toast-<id> on both ends → the platform
  morphs card into panel); engines without VT take the WAAPI fallback
  (the navigation-menu indicator's two-motion-laws precedent — the
  panel animates from the card's rect). While expanded, that toast's
  clock pauses; closing returns it to the stack, or finishes it when
  the push carried dismissOnClose.

  The viewport owns what the store deliberately does not: the max
  VISIBLE count (older toasts stay queued), live-region semantics per
  item (role=status polite, role=alert when assertive — never one live
  region announcing everything), the dismiss button, and the unified
  HOLD (pointer enter / focus freezes BOTH clocks — the store's expiry
  timer and the countdown companion's drain — leave/cross-out resumes).

  THE VISIBILITY HANDSHAKE (D-2, 2026-09-02): the viewport reports the
  id slice it renders to the store (store.setVisible); a toast's expiry
  ARMS at first visibility, so queued toasts beyond maxVisible never
  expire unseen — and the countdown companion, which mounts at
  visibility, starts with the store's clock instead of drifting from
  push time. Queued toasts are not in the accessibility tree until
  they render (the +N chip is aria-hidden decoration).

  Exit frames: a dismissed toast's SNAPSHOT survives in a leaving map
  for the exit window — swept by a timeout (there is no animationend
  listener; the sweeper is the only path, D-10 2026-09-02). Only
  toasts that were previously VISIBLE paint an exit frame (D-3), and
  leaving snapshots render in queue order (id order — D-8).
  prefers-reduced-motion skips the snapshot entirely: the toast is
  removed immediately, no opaque stall (D-9).
-->
<script lang="ts">
  import { getContext, onMount, tick } from 'svelte';
  import { fromAction } from 'svelte/attachments';
  import {
    SWIPE_BY_FLOAT_POS,
    type FloatPos,
    type SwipeDirection,
    type ToastItem,
    type ToastStore,
  } from '$lib/toast-store';
  import Icon from '$lib/ui/icon';
  import { cn } from '$lib/utils';
  import ScaffoldFloat from '$lib/ui/scaffold-float/scaffold-float.svelte';
  import type { TopLayerApi } from '$lib/ui/website-scaffold/website-scaffold.svelte';
  import ToastCountdown from './toast-countdown.svelte';
  import ToastDialog from './toast-dialog.svelte';
  import { ToastDefaults } from './toast-defaults.svelte';
  import { frictionShift, judgeSwipe } from './toast-swipe';
  import './toast.css';
  // the glass material rides the SHARED stamp channel (glass-effect
  // design §6): the law sheet paints the frost off data-jx-effect
  import '$lib/ui/glass/glass.css';

  interface Props {
    /** the app-created store (createToastStore()) */
    store: ToastStore;
    /** max toasts rendered at once; older ones stay queued (default 4) */
    maxVisible?: number;
    /** R3: the float slot's nine-grid position — physical names
     *  (left-top … right-bottom). Default right-bottom (sonner's
     *  corner); the stack grows AWAY from the slot's block edge and
     *  swipes toward its nearest screen edges */
    pos?: FloatPos;
    /** toast-v2: force the expanded posture (hover/touch still works) */
    expand?: boolean;
    /** toast-v2: the stack's visual gap in px (default 8) */
    gap?: number;
    /** toast-v2: default swipe directions when a push names none —
     *  resolved per POSTURE from the slot vocabulary (the growth law:
     *  a drag dismisses toward the stack's nearest screen edges) */
    swipeDirections?: readonly SwipeDirection[];
    /** extra classes on the stack */
    class?: string;
  }

  let {
    store,
    maxVisible = 4,
    pos = 'right-bottom',
    expand = false,
    gap = 8,
    swipeDirections,
    class: className = '',
  }: Props = $props();

  // the float plane contract — present inside a website-scaffold,
  // undefined in a standalone registry mount (the fixed fallback)
  const topLevel = getContext<TopLayerApi | undefined>('jx-top-layer');

  let items = $state<ToastItem[]>([]);
  /** the stack container (bind:this) — the touch lift's outside check */
  let stackEl = $state<HTMLElement | null>(null);
  /** dismissed snapshots still painting their exit frame, by id */
  let leavingItems = $state<ToastItem[]>([]);
  /** the unified hold: ids currently frozen (hover/focus can overlap —
   *  focus one card, pointer another; the store's per-toast `held`
   *  supports it, so the PAINT side must too, adversarial R1 P3-4) */
  let heldIds = $state<ReadonlySet<number>>(new Set());
  /** hover/touch wants the full list (transient — lifts while inside) */
  let hoverExpanded = $state(false);
  /** a TOUCH tap expands and STAYS expanded (Owner R3-6, 2026-09-02):
   *  a touch pointer fires pointerleave the instant it lifts, so the
   *  pre-R3 behavior expanded the stack and collapsed it in the same
   *  beat. The lift is sticky until a pointerdown lands OUTSIDE the
   *  stack — the touch idiom for "hover" */
  let touchExpanded = $state(false);
  /** the stacking posture: the prop PINS it expanded, hover lifts into
   *  it; leaving collapses only when the pin is off */
  const expanded = $derived(expand || hoverExpanded || touchExpanded);
  /** the id whose ToastDialog is open (expandable toasts) */
  let dialogId = $state<number | null>(null);
  /** exit-window timers — all cleared when the viewport unmounts */
  const exitTimers = new Set<ReturnType<typeof setTimeout>>();
  /** the card element registry — the expanded offsets are MEASURED
   *  heights of the cards above each one (the keyed each keeps the
   *  element identity across queue shifts, so heights stay honest) */
  const cardEls = new Map<number, HTMLElement>();
  /** remeasure nudge: content shifts (description wrap, countdown
   *  mount) change heights without touching the queue */
  let measureTick = $state(0);

  // reduced motion removes a dismissed toast IMMEDIATELY (D-9,
  // 2026-09-02): the exit animation is killed by toast.css anyway, so
  // a snapshot would sit fully opaque for the whole window — skip it.
  // The stacking transforms collapse to flat offsets (CSS side). LIVE,
  // not one-shot: toggling the OS setting mid-session must not recreate
  // the D-9 opaque stall (adversarial R1 P3-6)
  let reducedMotion = $state(
    typeof window !== 'undefined' &&
      !!window.matchMedia?.('(prefers-reduced-motion: reduce)').matches,
  );

  const EXIT_MS = 220; // 180ms animation + a frame of margin

  onMount(() => {
    // the reduced-motion LIVE source (see the state above)
    const mq = window.matchMedia?.('(prefers-reduced-motion: reduce)');
    const onMotion = (): void => {
      reducedMotion = !!mq?.matches;
    };
    mq?.addEventListener?.('change', onMotion);
    const unsubscribe = store.subscribe((next) => {
      // exit snapshots: ONLY toasts that were previously VISIBLE (D-3)
      // — a queued toast the user never saw paints no ghost exit frame
      const prevVisible = items.slice(-maxVisible);
      const gone = prevVisible.filter((prev) => !next.some((n) => n.id === prev.id));
      if (gone.length > 0 && !reducedMotion) {
        leavingItems = [...leavingItems.filter((l) => !gone.some((g) => g.id === l.id)), ...gone];
        const timer = setTimeout(() => {
          exitTimers.delete(timer);
          leavingItems = leavingItems.filter(
            (leaving) => !gone.some((g) => g.id === leaving.id),
          );
        }, EXIT_MS);
        exitTimers.add(timer);
      }
      items = next;
    });
    // toast-v2: the page-visibility source — a hidden tab freezes
    // every clock; visible resumes (three freeze sources, one timer)
    const onVisibility = (): void => {
      if (document.hidden) store.pauseAll();
      else store.resumeAll();
    };
    document.addEventListener('visibilitychange', onVisibility);
    // the touch lift's release: a tap anywhere outside the stack
    document.addEventListener('pointerdown', onOutsidePointerDown, true);
    if (document.hidden) store.pauseAll();
    return () => {
      unsubscribe();
      mq?.removeEventListener?.('change', onMotion);
      document.removeEventListener('visibilitychange', onVisibility);
      document.removeEventListener('pointerdown', onOutsidePointerDown, true);
      // detach the visibility handshake: the store resumes arm-at-push
      // semantics (and RETIRES the page-visibility source) for whoever
      // mounts next
      store.setVisible(null);
      for (const timer of exitTimers) clearTimeout(timer);
      exitTimers.clear();
    };
  });

  // maxVisible <= 0 renders NOTHING (Codex Spec P2: slice(-0) is the
  // WHOLE queue — the prop must never widen the render by lying about
  // its sign); everything rides behind the +N chip
  const visible = $derived(maxVisible > 0 ? items.slice(-maxVisible) : []);
  // queue order is id order (the store's ids are monotonic): leaving
  // snapshots merge back at their ORIGINAL position (D-8) — a toast
  // painting its exit never jumps below newer arrivals
  const renders = $derived(
    [...visible.filter((v) => !leavingItems.some((l) => l.id === v.id)), ...leavingItems].sort(
      (a, b) => a.id - b.id,
    ),
  );
  // queue honesty (site-polish F6): the store may hold more toasts than
  // the viewport renders — a tail chip says so instead of the stack
  // silently hiding them. Pure paint: no behavior, no timers.
  // clamp BOTH sides (re-attack P3): a negative maxVisible must not
  // print "+N" beyond the queue's own length
  const queuedCount = $derived(Math.max(0, items.length - Math.max(0, maxVisible)));

  // ── the stacking dialect geometry (toast-v2) ────────────────────────
  // renders are oldest→newest; the FRONT (index 0) is the newest card.
  // THE GROWTH LAW (sonner's, restated): the stack grows AWAY from its
  // slot's block edge — a TOP slot descends into the content, every
  // other slot climbs (R3 made the slot nine-way; the default
  // right-bottom climbs, matching the standalone fallback exactly).
  // Collapsed: uniform depth stairs per depth; expanded: each card
  // sits at the summed heights of the newer cards, plus gaps. Both
  // ride the single-cell grid item as transform-only offsets (the
  // grid-not-position law).
  const growsDown = $derived(pos.endsWith('-top'));
  const dir = $derived(growsDown ? 1 : -1);
  /** the page direction at mount (a live language switch mid-session is
   *  accepted as remount territory — same class as the posture itself) */
  const rtl = typeof document !== 'undefined' && document.documentElement.dir === 'rtl';
  /** the anchor's physical inline side: standalone pins physically;
   *  the adopted slot mirrors under RTL (logical place-self) */
  const physicalLeft = $derived(
    topLevel ? (rtl ? pos.startsWith('right-') : pos.startsWith('left-')) : pos.startsWith('left-'),
  );
  /** the nine-slot fixed-inset vocabulary for the standalone posture —
   *  physical names, physical insets (the mirror of the adopted CSS) */
  const STANDALONE_POS_CLASS: Record<string, string> = {
    'left-top': 'fixed left-4 top-4',
    'center-top': 'fixed left-1/2 top-4 -translate-x-1/2',
    'right-top': 'fixed right-4 top-4',
    'left-center': 'fixed left-4 top-1/2 -translate-y-1/2',
    'center-center': 'fixed left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2',
    'right-center': 'fixed right-4 top-1/2 -translate-y-1/2',
    'left-bottom': 'fixed left-4 bottom-4',
    'center-bottom': 'fixed left-1/2 bottom-4 -translate-x-1/2',
    'right-bottom': 'fixed right-4 bottom-4',
  };
  const rows = $derived.by(() => {
    void measureTick;
    const n = renders.length;
    return renders.map((item, idx) => {
      const i = n - 1 - idx; // front = 0
      const collapsedY = dir * gap * i;
      let expandedY = 0;
      for (let k = 0; k < i; k++) {
        const newer = renders[n - 1 - k];
        expandedY += dir * ((cardEls.get(newer.id)?.offsetHeight ?? 0) + gap);
      }
      return { item, i, collapsedY, expandedY };
    });
  });

  const wrapperStyle = (i: number, collapsedY: number, expandedY: number): string =>
    [
      `--jx-toast-i: ${i}`,
      `--jx-toast-y: ${expanded ? expandedY : collapsedY}px`,
      `--jx-toast-scale: ${expanded ? 1 : 1 - 0.05 * i}`,
      // the depth scale pivots on the edge NEAREST the front card, and
      // the enter keyframe arrives from beyond it (the growth law again)
      `transform-origin: ${growsDown ? 'top' : 'bottom'} center`,
      `--jx-toast-enter: ${growsDown ? -8 : 8}px`,
      // the exit frame rides physical x: toward the anchor's inline
      // edge (an RTL top-left pile exits LEFT, into its own edge)
      // the exit rides toward the anchor's PHYSICAL inline side: a
      // left-anchored pile (standalone left-*; adopted right-* under
      // RTL mirroring) exits LEFT, into its own edge
      `--jx-toast-exit-x: ${physicalLeft ? -12 : 12}px`,
    ].join('; ');

  // how far the VISUAL pile extends past its layout row (transforms
  // never change layout): the +N queued chip rides the second row, so
  // it must translate by this extent or the descending column walks
  // over its slot — covered by cards one frame, covering their × the
  // next (vision round 2, 2026-09-02)
  const stackExtend = $derived.by(() => {
    void measureTick;
    let visualBottom = 0;
    let tallest = 0;
    for (const r of rows) {
      const h = cardEls.get(r.item.id)?.offsetHeight ?? 0;
      tallest = Math.max(tallest, h);
      visualBottom = Math.max(visualBottom, (expanded ? r.expandedY : r.collapsedY) + h);
    }
    return Math.max(0, visualBottom - (tallest + gap));
  });

  // hover/touch the stack expands it; leaving collapses (unless pinned)
  // hover lifts the stack; a TOUCH tap lifts it stickily (the pointer
  // "leaves" the instant it lifts — that leave must not collapse); an
  // outside pointerdown releases the touch lift
  function stackPointerEnter(e: PointerEvent): void {
    if (e.pointerType === 'touch') touchExpanded = true;
    else hoverExpanded = true;
  }
  function stackPointerLeave(e: PointerEvent): void {
    if (e.pointerType === 'touch') return;
    hoverExpanded = false;
  }
  function onOutsidePointerDown(e: PointerEvent): void {
    if (!touchExpanded) return;
    if (stackEl && !stackEl.contains(e.target as Node)) touchExpanded = false;
  }

  // the card ref registry via a Svelte action (an each-keyed bind:this
  // would need one variable per element); every mount/remount nudges a
  // remeasure so the expanded offsets settle within a frame
  function bindCard(node: HTMLElement, id: number): { update(next: number): void; destroy(): void } {
    cardEls.set(id, node);
    tick().then(() => measureTick++);
    // late layout shifts (webfont swap, snippet images loading, a
    // description re-wrapping on resize) change heights without any
    // queue event — watch each card so the expanded ladder and the
    // chip's extent stay honest (R1 P3-3/P3-7)
    const ro =
      typeof ResizeObserver !== 'undefined'
        ? new ResizeObserver(() => {
            measureTick++;
          })
        : null;
    ro?.observe(node);
    return {
      update(next: number) {
        if (next !== id) {
          cardEls.delete(id);
          cardEls.set(next, node);
          measureTick++;
        }
      },
      destroy() {
        ro?.disconnect();
        cardEls.delete(id);
      },
    };
  }

  // ── the swipe (toast-v2) ────────────────────────────────────────────
  interface DragState {
    pid: number;
    /** false until movement passes the slop — capture is LAZY: taking
     *  it on pointerdown retargets the synthesized click to the wrapper
     *  and kills the expandable card's onclick (empirically confirmed
     *  in-headless, 2026-09-02); a stationary click never captures, so
     *  it lands on the card where it belongs */
    armed: boolean;
    /** resolved ONCE per gesture (re-attack R2 P3-4): per-move
     *  getComputedStyle forces recalc against the swipe vars the move
     *  itself just dirtied */
    dirs: readonly SwipeDirection[];
    startX: number;
    startY: number;
    startT: number;
  }
  /** drag intent slop in px — pointer jiggle below this is a click */
  const SWIPE_SLOP_PX = 3;

  function swipeHandlers(item: ToastItem) {
    // posture-aware default: adopted = top-right ('start end'), the
    // standalone fallback = bottom-right ('end end') — the keys are the
    // place-self grammar of the anchor. RTL flips the ADOPTED corner
    // logically (place-self is logical; the float area lands top-LEFT)
    // while the vocabulary stays physical — remap so a drag still
    // dismisses toward the stack's nearest screen edges (R1 P2-1)
    const resolveDirs = (): readonly SwipeDirection[] => {
      if (item.swipeDirections ?? swipeDirections) return item.swipeDirections ?? swipeDirections!;
      // the ADOPTED slot mirrors under RTL (place-self is logical) —
      // mirror the vocabulary's horizontal name so the drag still
      // dismisses toward the stack's nearest screen edges. The
      // standalone fallback is physically pinned and never mirrors.
      const key =
        rtl && topLevel
          ? pos.replace(/^left-/, '␦').replace(/^right-/, 'left-').replace(/^␦/, 'right-')
          : pos;
      return SWIPE_BY_FLOAT_POS[key] ?? SWIPE_BY_FLOAT_POS['right-bottom'];
    };
    const state = (el: HTMLElement): DragState =>
      ((el as HTMLElement & { _toastDrag?: DragState })._toastDrag ??= {
        pid: -1,
        armed: false,
        dirs: [],
        startX: 0,
        startY: 0,
        startT: 0,
      });
    return {
      onpointerdown(e: PointerEvent & { currentTarget: EventTarget & HTMLElement }) {
        // primary gestures only: a secondary-button drag must not carry
        // the card, and a second touch must not teleport the origin
        // (R1 P3-5); buttons and links own their own gestures
        if (e.button !== 0 || !e.isPrimary) return;
        if ((e.target as HTMLElement).closest('button, a, input')) return;
        const s = state(e.currentTarget);
        s.pid = e.pointerId;
        s.armed = false;
        s.dirs = resolveDirs();
        s.startX = e.clientX;
        s.startY = e.clientY;
        s.startT = performance.now();
      },
      onpointermove(e: PointerEvent & { currentTarget: EventTarget & HTMLElement }) {
        const s = state(e.currentTarget);
        if (s.pid !== e.pointerId) return;
        const dx = e.clientX - s.startX;
        const dy = e.clientY - s.startY;
        // capture only once the drag is REAL — see DragState.armed
        if (!s.armed) {
          if (Math.hypot(dx, dy) < SWIPE_SLOP_PX) return;
          s.armed = true;
          e.currentTarget.setPointerCapture?.(s.pid);
        }
        // the VISUAL card carries the swipe vars (its style attr is
        // JS-owned — the wrapper's belongs to Svelte's stacking vars)
        const card = e.currentTarget.querySelector(':scope > [data-jx-toast]') as HTMLElement | null;
        if (!card) return;
        const shift = frictionShift(dx, dy, s.dirs);
        card.style.setProperty('--jx-toast-swipe-x', `${shift.x}px`);
        card.style.setProperty('--jx-toast-swipe-y', `${shift.y}px`);
      },
      onpointerup(e: PointerEvent & { currentTarget: EventTarget & HTMLElement }) {
        const s = state(e.currentTarget);
        if (s.pid !== e.pointerId) return;
        s.pid = -1;
        const card = e.currentTarget.querySelector(':scope > [data-jx-toast]') as HTMLElement | null;
        const dx = e.clientX - s.startX;
        const dy = e.clientY - s.startY;
        const dt = performance.now() - s.startT;
        card?.style.removeProperty('--jx-toast-swipe-x');
        card?.style.removeProperty('--jx-toast-swipe-y');
        // judge the DAMPED vector — the same one the user saw. Judging
        // the raw drag lets a card visually cross the threshold on an
        // allowed axis and still spring home (R1 P2-2)
        const shift = frictionShift(dx, dy, s.dirs);
        if (judgeSwipe(shift.x, shift.y, dt, s.dirs).dismiss) store.api.dismiss(item.id);
        // else: vars removed → the CSS spring returns the card
      },
      onpointercancel(e: PointerEvent & { currentTarget: EventTarget & HTMLElement }) {
        const s = state(e.currentTarget);
        if (s.pid !== e.pointerId) return;
        s.pid = -1;
        const card = e.currentTarget.querySelector(':scope > [data-jx-toast]') as HTMLElement | null;
        card?.style.removeProperty('--jx-toast-swipe-x');
        card?.style.removeProperty('--jx-toast-swipe-y');
      },
    };
  }

  // the morph transition: the object form carries TYPES so the CSS
  // can key the bounce on ::view-transition-group(.jx-toast-morph)
  // without knowing per-toast names (Owner R3-2); the DOM lib's older
  // callback-only typing is widened locally
  function startMorphTransition(update: () => void): { finished: Promise<unknown> } | null {
    const d = document as Document & {
      startViewTransition?: (
        o: (() => void) | { update: () => void; types: readonly string[] },
      ) => { finished: Promise<unknown> };
    };
    if (typeof d.startViewTransition !== 'function') return null;
    return d.startViewTransition({ update, types: ['jx-toast-morph'] });
  }

  // ── the expandable dialog (toast-v2) ────────────────────────────────
  // shared-element contract: the name must be UNIQUE in each captured
  // state. OPEN: the card is named for the OLD capture, then releases
  // the name inside the callback so the NEW capture (dialog present)
  // sees exactly one owner. CLOSE: the mirror — re-stamp the card, run
  // the removal, clear after `finished`. A stale stamp on the card
  // while the dialog is open is a duplicate (Chromium warns and the
  // morph degrades) — found in-headless, 2026-09-02.
  function openDialog(item: ToastItem, cardEl: HTMLElement): void {
    if (!item.expandable) return;
    // one reading posture at a time: a light-dismiss ordering edge
    // could land a card click while a dialog is nominally open
    // (re-attack R2 P3-5)
    if (dialogId !== null) return;
    // the reading posture DURABLY claims the unified hold: the hover's
    // pointerenter already paused the clock, and once the popover takes
    // the pointer the card's pointerleave/focusout would otherwise
    // release straight through the dialog (adversarial R1 P1-1)
    heldIds = new Set(heldIds).add(item.id);
    store.pause(item.id);
    // reduced motion skips the morph entirely — the platform does not
    // auto-skip view transitions (adversarial R1 P2-6)
    // shared element: the card names itself for the OLD capture, the
    // dialog carries the same name — the platform morphs one into the
    // other with the R3 bounce (the jx-toast-morph type keys the CSS)
    const open = () => {
      dialogId = item.id;
      store.pause(item.id);
    };
    cardEl.style.viewTransitionName = `jx-toast-${item.id}`;
    cardEl.style.viewTransitionClass = 'jx-toast-morph';
    const vt =
      !reducedMotion &&
      startMorphTransition(() => {
        cardEl.style.viewTransitionName = '';
        cardEl.style.viewTransitionClass = '';
        // expiry can land inside the capture window (the clock had
        // near-zero remaining when the click raced it): mounting the
        // dialog for a dead id strands dialogId (adversarial R1 P3-1)
        if (!items.some((i) => i.id === item.id)) return;
        open();
      });
    if (!vt) {
      cardEl.style.viewTransitionName = '';
      cardEl.style.viewTransitionClass = ''; // no engine (or RM): no morph
      open();
      if (!reducedMotion) {
        // the WAAPI-law fallback (navmenu's two-motion precedent): the
        // panel rises from the card's rect where VT is absent, on the
        // same bounce the VT path carries
        requestAnimationFrame(() => {
          const panel = document.querySelector<HTMLElement>(`[data-jx-toast-dialog="${item.id}"]`);
          if (!panel) return;
          const r = cardEl.getBoundingClientRect();
          const pr = panel.getBoundingClientRect();
          panel.style.setProperty('--jx-toast-from-x', `${r.x}px`);
          panel.style.setProperty('--jx-toast-from-y', `${r.y}px`);
          panel.style.setProperty('--jx-toast-from-w', `${r.width}px`);
          panel.style.setProperty('--jx-toast-from-h', `${r.height}px`);
          panel.animate(
            [
              {
                transform: `translate(${r.x - pr.x}px, ${r.y - pr.y}px) scale(${r.width / Math.max(1, pr.width)})`,
                opacity: 0.6,
              },
              { transform: 'none', opacity: 1 },
            ],
            { duration: 340, easing: 'cubic-bezier(0.34, 1.56, 0.64, 1)' },
          );
        });
      }
    }
  }
  function closeDialog(dismissIt: boolean): void {
    const id = dialogId;
    if (id === null) return;
    const finish = () => {
      dialogId = null;
      const holds = new Set(heldIds);
      holds.delete(id);
      heldIds = holds;
      if (dismissIt) {
        store.api.dismiss(id);
      } else if (items.some((i) => i.id === id)) {
        store.resume(id);
        // re-assert the handshake: the toast may have been evicted to
        // the queue mid-dialog — a resumed, non-rendered toast must be
        // re-held by the store's own visible-set logic, never burn unseen
        store.setVisible(visible.map((i) => i.id));
      }
      // focus returns to the OPENER card (tabindex=-1 below) — not the
      // oldest card in the DOM (adversarial R1 P2-5). Deferred a tick:
      // the card was `invisible` while its dialog owned the screen and
      // focus() on a hidden element is a silent no-op
      tick().then(() => cardEls.get(id)?.focus?.());
    };
    const cardEl = cardEls.get(id);
    if (cardEl && !reducedMotion) {
      // mirror of the open: the card re-takes the name BEFORE the
      // capture starts so the dialog's removal morphs back into it.
      // A second transition SKIPS this one — finished then rejects,
      // so the catch must precede the cleanup (R1 P3-2)
      cardEl.style.viewTransitionName = `jx-toast-${id}`;
      cardEl.style.viewTransitionClass = 'jx-toast-morph';
      const vt = startMorphTransition(finish);
      if (vt) {
        vt.finished
          .catch(() => {})
          .finally(() => {
            // a rapid close→reopen RE-STAMPS the name before this
            // skipped transition settles — clearing blindly would strip
            // the new open's shared element (re-attack R2 P3-5b)
            if (dialogId !== id) {
              cardEl.style.viewTransitionName = '';
              cardEl.style.viewTransitionClass = '';
            }
          });
      } else {
        cardEl.style.viewTransitionName = ''; // no engine: undo + finish
        finish();
      }
    } else {
      finish();
    }
  }

  // the visibility handshake (D-2): report the rendered slice so the
  // store arms expiry at FIRST VISIBILITY — queued toasts never expire
  // unseen, and the countdown (mounted at visibility) starts with the
  // store's clock
  $effect(() => {
    store.setVisible(visible.map((item) => item.id));
  });

  // hold claims can OUTLIVE their card: an expiry inside the VT
  // capture window bails the dialog open, an unmounted hovered card
  // fires no pointerleave (Chromium), a leaving snapshot takes focus.
  // Prune dead ids whenever the rendered slice changes — also heals
  // the re-promoted countdown painting PAUSED while the clock runs
  // (re-attack R2 P3-1/P3-2); an OPEN dialog's claim survives eviction
  $effect(() => {
    const liveIds = new Set(visible.map((item) => item.id));
    if (dialogId !== null) liveIds.add(dialogId);
    const next = new Set<number>();
    for (const id of heldIds) if (liveIds.has(id)) next.add(id);
    if (next.size !== heldIds.size) heldIds = next;
  });

  // the unified hold — one freeze for both clocks. Concurrent holds
  // overlap (focus card A, pointer card B); an open dialog CLAIMS its
  // id and release() must not resume through it (R1 P1-1); a hold on a
  // card evicted from the visible slice stays for the store's
  // handshake to convert — resuming here would arm an unseen toast
  // (R1 P2-1)
  function hold(id: number): void {
    heldIds = new Set(heldIds).add(id);
    store.pause(id);
  }
  function release(id: number): void {
    if (dialogId === id) return;
    if (!heldIds.has(id)) return;
    const holds = new Set(heldIds);
    holds.delete(id);
    heldIds = holds;
    if (visible.some((v) => v.id === id)) store.resume(id);
  }

  // variant grammar: the ladder drives border + ink; MATERIAL picks the
  // ground independently (popover solid default; glass = the shared
  // stamp channel's frost — the entity law's restrained ground). Tonal
  // tints 12% OVER the ground; the §6 forced-colors degradations ride
  // every rung.
  const variantBorder = {
    outline: 'border-[color:var(--jx-outline)] forced-colors:border-[CanvasText]',
    tonal: 'border-[color-mix(in_oklab,var(--jx-tonal)_45%,transparent)] forced-colors:border-[CanvasText]',
  } as const;
  const materialGround = {
    popover: 'bg-popover forced-colors:bg-[Canvas]',
    // the glass member rides the SHARED stamp channel (glass-effect
    // design §6): the law sheet (glass.css) paints the frost off
    // data-jx-effect='blur'; the tuning vars ride the class string as
    // arbitrary properties — the card's style attribute is JS-OWNED by
    // the swipe (the wrapper's belongs to Svelte's stacking vars), so a
    // Svelte style attr here is forbidden. Values 12px / saturate 1 /
    // 55% fill = the retired backdrop-blur-md ground verbatim
    // (computed-equivalence); the forced-colors Canvas ground stays.
    glass:
      '[--jx-glass-radius:12px] [--jx-glass-saturate:1] [--jx-glass-fill:color-mix(in_oklab,var(--popover)_55%,transparent)] forced-colors:bg-[Canvas]',
  } as const;
  const tonalGround = 'bg-[color-mix(in_oklab,var(--jx-tonal)_12%,var(--popover))]';
  const titleInk = {
    outline: 'text-foreground forced-colors:text-[CanvasText]',
    tonal: 'text-[color:var(--jx-tonal)] forced-colors:text-[CanvasText]',
  } as const;
  const descInk = {
    outline: 'text-muted-foreground forced-colors:text-[CanvasText]',
    tonal: 'text-[color:var(--jx-tonal)] forced-colors:text-[CanvasText]',
  } as const;
  // the family Defaults is the single read point (context-defaults-
  // economy 3.2): a push IS the explicit lane — variant/material
  // resolve `explicit ?? own` through the family contract (pure
  // literal slots, zero context reads; the toast-v2 state machine is
  // untouched — only the style-class fallbacks moved)
  const itemVariant = (item: ToastItem) => ToastDefaults.resolve({ variant: item.variant }).variant;
  const itemMaterial = (item: ToastItem) => ToastDefaults.resolve({ material: item.material }).material;
</script>

<!-- THE STACK — one snippet, two homes: adopted into the scaffold's
     float plane (flow inside the overlay grid; the end-corner is the
     grid's own alignment), or the legacy fixed corner when standalone.
     Pointer law (D-1): the stack is pointer-events:none — only the
     CARDS opt in — so the adopted plane's transparent wrapper
     inherits nothing interactive. The stacking dialect: every card
     WRAPPER is [grid-area:1/1] of the stack's single cell carrying
     the transform vars; the +N chip rides the second auto-row. -->
{#snippet stack()}
  <div
    data-jx-toasts=""
    data-expanded={expanded ? '' : undefined}
    bind:this={stackEl}
    class={cn(
      'grid auto-rows-min pointer-events-none',
      // the growth law in alignment form: a TOP slot descends from the
      // cell top, every other slot climbs from its anchor; standalone
      // mirrors the adopted slot with physical fixed insets
      growsDown ? 'content-start' : 'content-end',
      topLevel
        ? 'h-full w-auto p-4'
        : `${STANDALONE_POS_CLASS[pos] ?? STANDALONE_POS_CLASS['right-bottom']} z-[90] w-[min(22rem,calc(100vw-2rem))]`,
      className,
    )}
    style={`gap: ${gap}px; --jx-toast-gap: ${gap}px; --jx-toast-extend: ${stackExtend}px`}
    role="group"
    aria-label="notifications"
    onpointerenter={stackPointerEnter}
    onpointerleave={stackPointerLeave}
  >
    {#each rows as { item, i, collapsedY, expandedY } (item.id)}
      {@const leaving = leavingItems.some((l) => l.id === item.id)}
      {@const variant = itemVariant(item)}
      {@const material = itemMaterial(item)}
      {@const collapsedSlab = !expanded && i > 0}
      <!-- the wrapper: the stack's grid item — transform vars only
           (Svelte owns this style attr; the swipe vars live on the
           visual card inside, which JS owns) -->
      <div
        {@attach fromAction(bindCard, () => item.id)}
        class={`pointer-events-auto [grid-area:1/1] justify-self-stretch ${growsDown ? 'self-start' : 'self-end'}`}
        style={wrapperStyle(i, collapsedY, expandedY)}
        {...swipeHandlers(item)}
      >
        <div
          data-jx-toast={variant}
          data-material={material}
          data-effect={item.effect && item.effect !== 'none' ? item.effect : undefined}
          data-jx-effect={material === 'glass' ? 'blur' : undefined}
          class={cn(
            // the float-button material (Owner R3-5): the press law at
            // float scale — rest on --shadow, hover grows, active
            // counter-shrinks; the card is a float-tier interactive
            // surface exactly like the fab
            'jx-toast jx-press grid items-start gap-x-2.5 gap-y-1.5 box-border px-3.5 py-3 border text-popover-foreground rounded overflow-hidden animate-[jx-toast-in_200ms_cubic-bezier(0.22,1,0.36,1)] [--jx-press-shadow:var(--shadow)] [--jx-press-shadow-hover:var(--shadow-md)] [--jx-press-shadow-active:var(--shadow-md-press)]',
            material === 'glass' ? materialGround.glass : variant === 'tonal' ? tonalGround : materialGround.popover,
            variantBorder[variant],
            leaving && 'jx-toast-leaving animate-[jx-toast-out_180ms_ease-in_forwards]',
            item.expandable && 'cursor-pointer',
            // the ORIGIN card hides while its dialog is open: the
            // shared element morphs out of it, and a card painted
            // underneath the flight doubles the content mid-morph and
            // strands a half-faded remnant at the origin (vision R3).
            // visibility (not display) keeps its box — the collapse
            // morph needs the rect to fly back into
            dialogId === item.id && 'invisible',
            item.class,
          )}
          role={item.assertive ? 'alert' : 'status'}
          tabindex="-1"
          onpointerenter={() => hold(item.id)}
          onpointerleave={() => release(item.id)}
          onfocusin={() => hold(item.id)}
          onfocusout={(e: FocusEvent & { currentTarget: EventTarget & HTMLElement; relatedTarget: EventTarget | null }) => {
            // focus crossing WITHIN the toast must not resume the countdown
            if (!e.currentTarget.contains(e.relatedTarget as Node | null)) release(item.id);
          }}
          onclick={(e) => {
            if (!item.expandable) return;
            if ((e.target as HTMLElement).closest('button, a, input')) return;
            openDialog(item, e.currentTarget);
          }}
        >
          {#if item.leading}
            <div data-jx-toast-leading="" class="flex-none self-start pt-0.5 [grid-area:leading]">{@render item.leading()}</div>
          {/if}
          <div data-jx-toast-body="" class="grid min-w-0 gap-1 [grid-area:body]">
            <p data-jx-toast-title="" class={cn('font-nav text-xs tracking-[0.1em] uppercase', titleInk[variant])}>{item.title}</p>
            {#if item.description}
              {#if collapsedSlab}
                <!-- rear slabs keep the description's GEOMETRY (even
                     slab heights for the depth illusion) but withhold
                     its ink; the text stays in the a11y tree as-is -->
                <p data-jx-toast-desc="" class="text-[0.8125rem] leading-[1.5] text-transparent">{item.description}</p>
              {:else}
                <p data-jx-toast-desc="" class={cn('text-[0.8125rem] leading-[1.5]', descInk[variant])}>{item.description}</p>
              {/if}
            {/if}
          </div>
          {#if item.trailing}
            <div data-jx-toast-trailing="" class="flex flex-none items-center gap-2.5 self-stretch [grid-area:trail]">{@render item.trailing()}</div>
          {/if}
          <button
            type="button"
            data-jx-toast-dismiss=""
            class="flex-none appearance-none inline-flex items-center justify-center size-5 mt-[3px] border-0 bg-transparent text-muted-foreground cursor-pointer hover:text-foreground focus-visible:outline-1 focus-visible:outline-ring focus-visible:outline-offset-[-1px] forced-colors:outline-2 forced-colors:outline-offset-2 forced-colors:[outline-color:Highlight] forced-colors:text-[ButtonText] [grid-area:close]"
            aria-label="dismiss notification"
            onclick={() => store.api.dismiss(item.id)}
          >
            <!-- the named icon library (Owner R3-3): the glyph is the
                 icon system's x, never a literal symbol -->
            <span class="inline-flex" aria-hidden="true"><Icon name="x" /></span>
          </button>
          {#if item.countdown && (item.duration ?? 5000) > 0}
            <!-- the countdown FLOOR (Owner R3-4): a full-width drain
                 across the card's bottom — the trailing lane is for
                 actions, the floor is time -->
            <ToastCountdown
              duration={item.duration ?? 5000}
              paused={heldIds.has(item.id) || dialogId === item.id}
            />
          {/if}
        </div>
      </div>
    {/each}
    {#if queuedCount > 0}
      <div
        data-jx-toast-queued={queuedCount}
        class="pointer-events-auto justify-self-end box-border px-2.5 py-1 border rounded bg-popover text-popover-foreground font-nav text-[0.6875rem] tracking-[0.1em] uppercase text-muted-foreground forced-colors:bg-[Canvas] forced-colors:border-[CanvasText] forced-colors:text-[CanvasText]"
        aria-hidden="true"
      >
        +{queuedCount} queued
      </div>
    {/if}
  </div>
{/snippet}

{#snippet dialogHost()}
  {#if dialogId !== null}
    {@const item = items.find((it) => it.id === dialogId)}
    {#if item}
      <ToastDialog {item} onclose={closeDialog} paused={heldIds.has(item.id) || dialogId === item.id} />
    {/if}
  {/if}
{/snippet}

{#if topLevel}
  <!-- the float plane owns the viewport — no fixed positioning anywhere -->
  <ScaffoldFloat area="float" {pos}>{@render stack()}{@render dialogHost()}</ScaffoldFloat>
{:else}
  {@render stack()}{@render dialogHost()}
{/if}
