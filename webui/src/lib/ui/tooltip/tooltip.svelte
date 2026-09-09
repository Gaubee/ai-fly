<!--
  jixoai tooltip (registry/files/ui/tooltip/tooltip.svelte).
  The hover-intent hint, built the same way as popover.svelte: a native
  Popover API panel (popover="manual" — no light dismiss; the tooltip
  owns its own exit) anchored to the trigger through CSS Anchor
  Positioning, zero JS geometry.

  Intent model (the part CSS alone cannot do — the reason this is a
  component and not a utility class):
    pointerenter → open NOW (Owner ruling 2026-08-23: tips show
                     immediately; a hover-intent delay is opt-in through
                     openDelay for sweep-heavy surfaces)
    pointerleave → close after closeDelay (100ms)   lets the pointer
                     cross the gap onto the tooltip itself
    focusin     → open NOW                           keyboard/screen
                     readers never wait for hover timers
    focusout    → close NOW
    Escape      → close NOW (manual popovers skip the native Esc path)
    toggle      → the notch mask + the slide vector are authored once, at
                  open, and the WAAPI motion kernel plays (Arrow law)

  Close seam, dual-surface + geometric verdict (2026-08-25 r1→r3, Owner
  report "the tip dies the moment you hover"): the tip occupies TWO hit
  surfaces — the anchor wrapper and the panel — and the close is legal
  only when the pointer holds NEITHER. r1 assumed a UI-Events
  enter(new)-before-leave(old) order race; Codex r2 disproved that —
  Chromium/WebKit switch siblings as out(old)→leave(old)→over(new)→
  enter(new). The CAPTURED killer (r3, lifecycle logs on the docs page)
  is colder: on the FIRST open, Chromium briefly lays the freshly
  promoted popover out at a stale, pre-anchor-resolution position —
  under the cursor — flipping the hit target wrapper→panel and back
  when the slide settles; whenever the compensating enter is late or
  suppressed (an ANIMATED element sliding away from a resting cursor
  does not reliably get boundary events), the leave's close timer fires
  with the cursor still parked on the trigger complex. Three locks, one
  per failure mode:
    lock 1  open() sets pointer-events:none BEFORE showPopover — the
            stale box can never steal the hit; aimPin restores it once
            the anchor has settled (rects read = layout resolved)
    lock 2  presence FLAGS on both surfaces + a re-check at timer fire
            (covers engines/interleavings where coords never arrive)
    lock 3  the fire-time verdict is GEOMETRIC when pointer coords are
            known: keep open while the point sits inside either
            surface's live rect inflated by a halo that covers the 6px
            rest gap; a kept tip re-arms, so walking away still closes

  a11y: the wrapper carries aria-describedby → the panel id permanently;
  hidden popover content is display:none, so assistive tech only reads
  the tip while it is actually shown. Non-interactive by contract — put
  actionable content in a popover, not a tooltip.

  Arrow law (2026-08-23, mask-cut revision, Owner-directed — XboxYan's
  seamless-bubble recipe, mask form): `arrow` opts into a notch that is
  CUT FROM THE BUBBLE ITSELF, never appended. The body reserves a
  --jx-tip-notch strip of padding on BOTH block sides (layout-stable
  across flips), and its mask digs away everything in that strip EXCEPT
  the tab pointing at the anchor — one SVG path outlines bubble+tab, so
  fill, acrylic blur and silhouette are the SAME paint by construction.
  The path is authored per open by aimPin() (all px, any side, any aim
  x): the tab points at the anchor point the placement names ('top' →
  the anchor's top-center, 'top-end' → its top-end corner; clamped
  inward at the bubble's corners). The 1px border can't ride `border`
  on a masked silhouette: the platform element opts into the
  jx-surface border-ring layer ([data-border-ring] — the ring is the
  silhouette minus its 1px-inset copy, mask-composite: subtract; see
  jixoai.css). Side/aim cover all 6 placements (and generalize to any
  side), matching the 8-direction space the recipe allows.

  Chromium constraint (151, empirically pinned 2026-08-22): anchor()
  inside a popover is not shippable — declarations carried by the style
  attribute or a stylesheet never resolve for an element first computed
  while the popover is closed, and even CSSOM-armed declarations
  mis-resolve to the spec's 50% unresolvable fallback. aimPin() reads
  rects in the popover's toggle handler instead, which is exactly as
  dynamic as the panel's own flip law (popover.svelte: position-try
  settles ONCE, at open, never re-evaluated) — a once-at-open aim is
  correct by the system's contract. The panel itself uses no anchor()
  function (position-anchor + inset-area inline) and stays zero-JS.

  Motion kernel (2026-08-23 r2, popover.svelte's WAAPI kernel, VERBATIM
  choreography — three layers: the platform panel, the surface body and
  a REAL .jx-tip-shadow child masked to the notch silhouette; a static
  ::after veil cannot join the choreography because pseudo-elements are
  unreachable from WAAPI). The one structural simplification: no
  direction predict/verify/replay — aimPin's rect read at open already
  knows the post-flip geometry (both axes), so the slide and shadow
  vectors are measured, not predicted. Same two laws as popover.svelte:
  (1) opacity is animated ONLY while the kernel pins the materials
  OPAQUE (an animated opacity activates the compositor's opacity
  channel and breaks backdrop-filter blur); (2) no lingering fills —
  every phase is canceled the moment its successor owns the values, the
  exceptions being the exit tail's forwards fill (holds opacity 0 until
  display:none) and the exit's body/shadow opaque holds through B'
  (popover parity — they die with the panel's display:none).

  CHANNEL OWNERSHIP (2026-08-25 r5, the Owner's 10× slow-mo catch):
  this kernel animates opacity/filter/translate DIRECTLY — it never
  drives --jx-p like the popover-family kernel does — yet the panel
  carries .jx-waapi, whose cascade formulas compute blur(100px) and
  opacity 0 at --jx-p=0. Every channel the kernel touches must
  therefore be pinned INLINE at each rest point (A→B seam, rest pose,
  reduced-motion rest): opacity and translate always were; filter was
  NOT, so the frame phase A's fill dropped, the formula snapped the
  tip to an invisible blur(100px) smear for its whole resting life —
  the tip "showed, then vanished the instant the entry finished".
  Where the blur is zero the pin is filter:none (the r30 law — a
  residual blur(0px) keeps a filter layer alive and disturbs the
  backdrop compositing).

  Anchoring, flip fallbacks and anchors-visible scroll hiding follow the
  popover.svelte laws; engines without anchor positioning fall back to
  viewport-center (never worse).

  tw4 (2026-08-24): anchor/body paint as token utilities in the markup;
  tooltip.css keeps the D1-exempt machinery — panel anchor geometry +
  the @supports viewport-center fallback, ::backdrop, the notch-mask
  builds, and the overrides of the unlayered jx-surface ::after/::before
  law (unlayered themselves, with natural specificity: a layered copy
  could never beat the law).
-->
<script lang="ts">
  import type { Snippet } from 'svelte';
  import { onDestroy } from 'svelte';
  import { cn } from '$lib/utils';
  import { TooltipDefaults, type TooltipSurfaceVariant } from './tooltip-defaults.svelte';
  import './tooltip.css';

  interface Props {
    /** panel id (aria-describedby pairs the trigger wrapper to the tip);
        auto-generated when omitted */
    id?: string;
    /** the tip itself — plain text; composed content belongs in a popover */
    text: string;
    /** anchored side; 'top' (default) is the tooltip convention */
    placement?: 'top' | 'bottom' | 'top-start' | 'bottom-start' | 'top-end' | 'bottom-end';
    /** opt-in pointer notch: a tab CUT FROM the bubble through its mask,
        aimed at the anchor point the placement names ('top' →
        top-center, 'top-end' → the top-end corner); re-authored at every
        open, mirroring the once-at-open flip law */
    arrow?: boolean;
    /** delay before hover opens (ms); 0 (default) shows the tip
        immediately — opt in for sweep-heavy surfaces; focus opens
        immediately regardless */
    openDelay?: number;
    /** grace before closing, so the pointer can cross onto the tip */
    closeDelay?: number;
    /** floating-surface variant: solid | acrylic | auto (acrylic unless
        the environment asks for reduced transparency). The shadow rides
        the law's static ::after veil, masked to the notch silhouette
        and offset to the panel's outward side (aimPin sets
        --jx-surface-ox/oy at open). Omitted → the contract own 'auto'
        (TooltipDefaults — a declared own, not ambient). */
    variant?: TooltipSurfaceVariant;
    class?: string;
    /** the trigger content; the wrapper span carries the anchoring */
    children: Snippet;
  }

  const autoId = $props.id();

  let {
    id = autoId,
    text,
    placement = 'top',
    arrow = false,
    openDelay = 0,
    closeDelay = 100,
    variant,
    class: className = '',
    children,
  }: Props = $props();

  // THE DEFAULTS READ POINT (context-defaults-economy 3.2): one line —
  // the family contract resolves the panel's style props (variant's
  // own 'auto' lives in TooltipDefaults, auditable in one place;
  // density is the no-opinion axis slot — nothing stamps, the ambient
  // css scope channel keeps flowing)
  const d = $derived(TooltipDefaults.resolve({ variant }));

  // id is mount-stable by contract; $derived keeps the name truthful
  const anchorName = $derived(`--jx-tip-${id.toLowerCase().replace(/[^a-z0-9]+/g, '-')}`);
  const area = $derived(
    placement === 'top' ? 'top'
    : placement === 'top-start' ? 'top span-left'
    : placement === 'top-end' ? 'top span-right'
    : placement === 'bottom' ? 'bottom'
    : placement === 'bottom-start' ? 'bottom span-left'
    : 'bottom span-right'
  );
  // the anchor point the tab aims at: center placements → the side
  // midpoint, -start/-end → the matching corner (physical left/right,
  // mirroring the physical span-left/span-right choice in `area`)
  const aimSide = $derived(
    placement.endsWith('-start') ? 'left'
    : placement.endsWith('-end') ? 'right'
    : 'center'
  );

  let panel = $state<HTMLElement | null>(null);
  let anchorEl = $state<HTMLElement | null>(null);
  let body = $state<HTMLElement | null>(null);
  let openTimer: ReturnType<typeof setTimeout> | undefined;
  let closeTimer: ReturnType<typeof setTimeout> | undefined;

  // notch geometry (px) — keep NOTCH in sync with --jx-tip-notch in the
  // styles. BASE is the tab's width at the bubble edge; the x clamp
  // keeps the tab clear of the bubble's corners.
  const BASE = 12;
  const NOTCH = 8;
  const EDGE = BASE / 2 + 2;

  const n = (v: number): number => Math.round(v * 100) / 100;

  /** outline of bubble + tab, comma path syntax (no spaces — the URI
      stays unencoded-safe). side = which bubble edge carries the tab;
      x = the tab apex's aim point in body-box px */
  const shapePath = (w: number, h: number, x: number, side: 'top' | 'bottom'): string => {
    const b = BASE / 2;
    return side === 'bottom'
      ? `M0,${n(NOTCH)}H${n(w)}V${n(h - NOTCH)}H${n(x + b)}L${n(x)},${n(h)}L${n(x - b)},${n(h - NOTCH)}H0Z`
      : `M0,${n(h - NOTCH)}H${n(w)}V${n(NOTCH)}H${n(x + b)}L${n(x)},0L${n(x - b)},${n(NOTCH)}H0Z`;
  };
  /** the same silhouette inset by 1px (the ring's inner edge) */
  const ringInnerPath = (w: number, h: number, x: number, side: 'top' | 'bottom'): string => {
    const b = BASE / 2 - 1;
    return side === 'bottom'
      ? `M1,${n(NOTCH + 1)}H${n(w - 1)}V${n(h - NOTCH - 1)}H${n(x + b)}L${n(x)},${n(h - 1)}L${n(x - b)},${n(h - NOTCH - 1)}H1Z`
      : `M1,${n(h - NOTCH - 1)}H${n(w - 1)}V${n(NOTCH + 1)}H${n(x + b)}L${n(x)},1L${n(x - b)},${n(NOTCH + 1)}H1Z`;
  };
  const svgUrl = (w: number, h: number, d: string): string =>
    `url("data:image/svg+xml,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 ${n(w)} ${n(h)}' preserveAspectRatio='none'><path d='${d}' fill='black'/></svg>")`.replaceAll(' ', '%20');

  // Author the notch mask and the slide vector once, at open — the same
  // moment position-try settles the panel's own flip (see Chromium
  // constraint in the header). Everything is plain px/data-URIs on
  // custom properties; no anchor() anywhere. Sets, on the panel:
  // --jx-tip-shape (the body's silhouette mask), the --jx-surface-ring
  // pair (the border ring's subtract layers), and the --jx-surface-in-*
  // slide vector (measured from the post-flip geometry — the kernel
  // reads it through var() at animation time).
  // anchor-positioning capability (Codex r2): without it the panel sits
  // at viewport-center — a notch aimed at nothing is noise, and the
  // arrow CSS is @supports-gated to match
  const anchored = (): boolean =>
    typeof CSS !== 'undefined' &&
    typeof CSS.supports === 'function' &&
    CSS.supports('anchor-name: --jx-tip-fallback');

  function aimPin(): void {
    // lock 1's exit: hit testing returns the moment the anchor has
    // settled — aimPin READS the panel's rect, which forces the
    // anchored layout, so the stale-box window (open → here, ~10ms) is
    // closed by construction. Runs before every early return.
    if (panel) panel.style.pointerEvents = '';
    if (!panel || !body || !anchorEl || !anchored()) return;
    const r = body.getBoundingClientRect();
    const a = anchorEl.getBoundingClientRect();
    const w = r.width;
    const side: 'top' | 'bottom' = r.top + r.bottom < a.top + a.bottom ? 'bottom' : 'top';
    // the notch trio is arrow-only (Codex r1): a plain tip's shadow must
    // stay rectangular — writing the ring vars unconditionally cut it
    if (arrow) {
      const target =
        aimSide === 'left' ? a.left : aimSide === 'right' ? a.right : (a.left + a.right) / 2;
      const x = Math.min(Math.max(target - r.left, EDGE), Math.max(w - EDGE, EDGE));
      panel.style.setProperty('--jx-tip-shape', svgUrl(w, r.height, shapePath(w, r.height, x, side)));
      panel.style.setProperty('--jx-surface-ring', svgUrl(w, r.height, shapePath(w, r.height, x, side)));
      panel.style.setProperty(
        '--jx-surface-ring-inner',
        svgUrl(w, r.height, ringInnerPath(w, r.height, x, side)),
      );
    }
    panel.dataset.side = side;
    // slide + shadow vectors from the MEASURED geometry (Codex r1: the
    // requested aim ignores flip-inline — the panel can end up on the
    // other side, and the slide/shadow must follow the REAL position):
    // both signs read from the rects like popover's verifyDirection
    // (4px dead zone on x), so the panel arrives from — and the shadow
    // falls to — its actual outward side, never onto the anchor.
    const sign = (d: number): -1 | 0 | 1 => (Math.abs(d) < 4 ? 0 : (Math.sign(d) as -1 | 0 | 1));
    const sx = sign(r.left + r.width / 2 - (a.left + a.width / 2));
    const sy: -1 | 1 = side === 'bottom' ? -1 : 1;
    panel.style.setProperty('--jx-surface-in-x', sx === 0 ? '0px' : `${sx * 12}px`);
    panel.style.setProperty('--jx-surface-in-y', `${sy * 12}px`);
    panel.style.setProperty('--jx-surface-ox', sx === 0 ? '0px' : `${sx * 6}px`);
    panel.style.setProperty('--jx-surface-oy', `${sy * 6}px`);
  }

  // ── MOTION KERNEL (2026-08-23 r2: popover.svelte's choreography,
  // VERBATIM — three layers: the platform panel, the surface body and a
  // REAL shadow child (pseudo-elements are unreachable from WAAPI, so a
  // static ::after veil cannot join the choreography; the earlier
  // two-layer port collapsed phase A's slide into the rest position and
  // dropped phase B's layer separation entirely — Owner report). The
  // only structural simplification: no direction predict/verify/replay —
  // aimPin's rect read at open already knows the post-flip side, so the
  // slide/shadow vectors are measured, not predicted. Same two laws as
  // popover.svelte: (1) opacity is animated ONLY while the kernel pins
  // the materials OPAQUE (an animated opacity activates the compositor's
  // opacity channel and breaks backdrop-filter blur); (2) no lingering
  // fills — every phase is canceled the moment its successor owns the
  // values, the one exception being the exit tail's forwards fill
  // (holds opacity 0 until display:none). ──
  const PHASE_MS = 230; // must match the law's allow-discrete window (460/230)
  const EASE = 'linear';
  const DEFOCUS = 'blur(100px)';
  let solidBg = ''; // opaque fill, re-resolved per open (theme-safe)
  let glassBg = ''; // translucent acrylic fill, read per open
  let veilBg = ''; // the shadow layer's translucent veil, read per open
  let veilSolid = ''; // the veil's opaque form (pure shadow color)

  interface CSSElementAnimationLike extends Animation {
    __jxKernel?: boolean;
  }

  const prefersReducedMotion = (): boolean =>
    typeof window.matchMedia === 'function' &&
    window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  /** resolve a custom property through ONE level of var() nesting */
  function resolveVar(el: HTMLElement, name: string, fallbackName: string): string {
    const cs = getComputedStyle(el);
    const raw = cs.getPropertyValue(name).trim();
    const target = raw || `var(${fallbackName})`;
    const varRef = /^var\(\s*(--[\w-]+)\s*\)$/.exec(target);
    return (varRef ? cs.getPropertyValue(varRef[1]).trim() : target) || cs.getPropertyValue(fallbackName).trim();
  }

  const surface = (): { p: HTMLElement; b: HTMLElement; sh: HTMLElement } | null => {
    const p = panel;
    const b = p?.querySelector<HTMLElement>('.jx-tip-body');
    const sh = p?.querySelector<HTMLElement>('.jx-tip-shadow');
    return p && b && sh ? { p, b, sh } : null;
  };

  function kernelAnims(): Animation[] {
    const out: Animation[] = [];
    for (const el of [panel, panel?.querySelector('.jx-tip-body'), panel?.querySelector('.jx-tip-shadow')]) {
      if (!el || typeof (el as HTMLElement).getAnimations !== 'function') continue;
      for (const a of (el as HTMLElement).getAnimations()) {
        if ((a as CSSElementAnimationLike).__jxKernel) out.push(a);
      }
    }
    return out;
  }

  function anim(el: HTMLElement, frames: Keyframe[], fill: FillMode = 'both'): Animation {
    const a = el.animate(frames, { duration: PHASE_MS, easing: EASE, fill });
    (a as CSSElementAnimationLike).__jxKernel = true;
    return a;
  }

  const IN = () => `var(--jx-surface-in-x, 0px) var(--jx-surface-in-y, 6px)`;
  const SHADOW = () => `var(--jx-surface-ox, 6px) var(--jx-surface-oy, 6px)`;

  function playEntry(): void {
    const s = surface();
    if (!s || typeof s.p.animate !== 'function') return; // jsdom etc.
    const { p, b, sh } = s;
    const token = runToken;
    const alive = () => token === runToken && p.isConnected;
    const liveOp = getComputedStyle(p).opacity;
    for (const a of kernelAnims()) a.cancel();
    // release the previous run's inline pins — the entry owns every channel
    p.style.opacity = '';
    p.style.filter = '';
    p.style.translate = '';
    p.style.pointerEvents = ''; // a prior run's transparency must not leak
    p.style.removeProperty('--jx-p'); // the previous run's timeline pin
    sh.style.translate = '';
    b.style.backgroundColor = '';
    sh.style.backgroundColor = '';
    // CHANNEL OWNERSHIP, materials half (Codex r5 blocker + r6): park
    // --jx-p at 1 INLINE from the entry's start — the WAAPI fills own
    // every VISIBLE frame of the arc, and the cascade formulas own
    // every gap (seams, rest, reduced motion), computing the p=1 REST
    // materials: body alpha .72 glass, shadow alpha .32 veil. Reading
    // the computed colors at p=0 (the pre-r6 way, both the phase-B
    // targets and the reduced pins) captured the OPAQUE p=0 pose and
    // pinned the resting tip as a solid block — formula-driven beats
    // read-and-pin because the formulas ARE the rest pose definition
    p.style.setProperty('--jx-p', '1');
    // reduced motion rests HERE on the same formulas: pin only what the
    // formulas cannot say — filter MUST be none (they compute
    // blur(0px), and a residual blur(0px) keeps a filter layer alive,
    // r30) and the shadow's separation rides the aimPin vector
    if (prefersReducedMotion()) {
      p.style.opacity = '1';
      p.style.translate = '0px 0px';
      p.style.filter = 'none';
      sh.style.translate = SHADOW();
      return;
    }
    glassBg = getComputedStyle(b).backgroundColor;
    veilBg = getComputedStyle(sh).backgroundColor;
    // re-resolve the theme-dependent opaque values EVERY open — a cached
    // value would go stale across a light/dark switch
    solidBg = resolveVar(p, '--jx-surface-solid-fill', '--popover') || glassBg;
    veilSolid = resolveVar(p, '--shadow-color', '--shadow-color');

    // PHASE A — the kernel-pinned OPAQUE window (ALL layers opaque, the
    // shadow merged flush under the panel): fade + defocus + slide to
    // the shadow's spot
    const bodyA = anim(b, [{ backgroundColor: solidBg }, { backgroundColor: solidBg }]);
    const shadowA = anim(sh, [
      { translate: '0 0', backgroundColor: veilSolid },
      { translate: '0 0', backgroundColor: veilSolid },
    ]);
    const panelA = anim(p, [
      { opacity: Number.parseFloat(liveOp) || 0, translate: IN(), filter: DEFOCUS },
      { opacity: 1, offset: 0.5, filter: 'blur(50px)' },
      { opacity: 1, translate: SHADOW(), filter: 'blur(0px)' },
    ]);
    panelA.finished
      .then(() => {
        if (!alive() || !p.matches(':popover-open')) return;
        // PIN THE FILTER CHANNEL (the 2026-08-25 r5 fix, Owner's 10×
        // slow-mo catch): phase A's cancel drops its fill, and the
        // jx-waapi formula computes blur from --jx-p — only the r30
        // exception needs saying here, because the formula's rest is
        // blur(0px) and a residual blur(0px) keeps a filter layer
        // alive and disturbs the backdrop compositing. Opacity and
        // translate need NO pins: --jx-p is parked at 1, so the
        // formulas compute the exact seam values (1 / SHADOW())
        p.style.filter = 'none';
        bodyA.cancel();
        shadowA.cancel();
        panelA.cancel(); // phase B starts exactly where A ended
        // PHASE B — separation (no opacity anywhere): the panel rises to
        // rest while the shadow's ABSOLUTE position stays put — its
        // relative offset grows to the shadow offset as the veil develops
        const bodyB = anim(b, [{ backgroundColor: solidBg }, { backgroundColor: glassBg }]);
        const shadowB = anim(sh, [
          { translate: '0 0', backgroundColor: veilSolid },
          { translate: SHADOW(), backgroundColor: veilBg },
        ]);
        const panelB = anim(p, [{ translate: SHADOW() }, { translate: '0px 0px' }]);
        panelB.finished
          .then(() => {
            if (!alive() || !p.matches(':popover-open')) return;
            // REST, formula-owned (r6+r7): release every fill and every
            // material pin — --jx-p parked at 1 makes the cascade
            // formulas compute the rest pose themselves (opacity 1,
            // translate 0, body glass, shadow veil), so a theme/variant/
            // token change while the tip rests flows straight through.
            // The ONLY pins are the two the formulas cannot say:
            // filter:none (they compute blur(0px) — the r30 residue law)
            // and the shadow's separation vector (the formula's axis is
            // the generic --jx-dx/--jx-m2, not aimPin's measured vector)
            p.style.opacity = '';
            p.style.translate = '';
            p.style.filter = 'none';
            b.style.backgroundColor = '';
            sh.style.backgroundColor = '';
            sh.style.translate = SHADOW();
            bodyB.cancel();
            shadowB.cancel();
            panelB.cancel();
          })
          .catch(() => {}); // mid-entry close aborts — nothing to do
      })
      .catch(() => {});
  }

  function playExit(): void {
    const s = surface();
    if (!s || typeof s.p.animate !== 'function') return;
    const { p, b, sh } = s;
    const token = runToken;
    const alive = () => token === runToken; // exit B' must run even detached-ish; only destroy blocks
    // snapshot the CURRENT live values BEFORE canceling: closing
    // mid-entry must stay continuous
    const curBg = getComputedStyle(b).backgroundColor;
    const curT = getComputedStyle(p).translate === 'none' ? '0px 0px' : getComputedStyle(p).translate;
    const curShBg = getComputedStyle(sh).backgroundColor;
    const curShT = getComputedStyle(sh).translate === 'none' ? '0px 0px' : getComputedStyle(sh).translate;
    const curOp = getComputedStyle(p).opacity;
    const curFilter = getComputedStyle(p).filter;
    // freeze EVERY animated channel INLINE before canceling — after the
    // cancel each cascade resolves to its CLOSED state
    p.style.opacity = curOp;
    p.style.filter = curFilter;
    p.style.translate = curT;
    p.style.pointerEvents = 'none'; // the dying panel must not hold hits
    sh.style.translate = curShT;
    b.style.backgroundColor = curBg;
    sh.style.backgroundColor = curShBg;
    for (const a of kernelAnims()) a.cancel();
    if (prefersReducedMotion()) return;
    const solid = solidBg || curBg;
    if (!veilSolid) veilSolid = resolveVar(p, '--shadow-color', '--shadow-color');

    // PHASE A' — solidify + merge (translate + fills only; the frozen
    // inline opacity/filter hold the panel's live look)
    const bodyA = anim(b, [{ backgroundColor: curBg }, { backgroundColor: solid }]);
    const shadowA = anim(sh, [
      { translate: curShT, backgroundColor: curShBg },
      { translate: '0 0', backgroundColor: veilSolid },
    ]);
    const panelA = anim(p, [{ translate: curT }, { translate: SHADOW() }]);
    panelA.finished
      .then(() => {
        if (!alive() || p.matches(':popover-open')) return; // reopened mid-flight
        panelA.cancel(); // B' owns the panel now (its fill would fight)
        // PHASE B' — merged opaque composite: defocus + slide + fade,
        // FROM THE FROZEN LIVE opacity/filter
        anim(
          p,
          [
            { translate: SHADOW(), opacity: curOp, filter: curFilter },
            { translate: IN(), opacity: 0, filter: DEFOCUS },
          ],
          'forwards', // holds opacity 0 until display:none — no cancel (Law 2 exception)
        );
      })
      .catch(() => {});
  }

  const popoverApi = (
    el: HTMLElement | null,
  ): el is HTMLElement & { showPopover(): void; hidePopover(): void } =>
    !!el && typeof el.showPopover === 'function';

  function clearTimers(): void {
    clearTimeout(openTimer);
    clearTimeout(closeTimer);
  }

  // pointer presence, per surface — the close seam's truth (see header)
  let onAnchor = false;
  let onPanel = false;
  // last pointer position (viewport px); NaN until the first move — the
  // geometric verdict falls back to the flags until coords exist
  let px = NaN;
  let py = NaN;
  // halo around each surface's live rect: covers the 6px rest gap and
  // edge jitter — "on the trigger complex" reads as on
  const HALO = 8;

  function open(): void {
    clearTimers();
    if (!popoverApi(panel) || panel!.matches(':popover-open')) return;
    // lock 1: transparent BEFORE promotion — the stale, pre-anchor box
    // can never steal the hit. aimPin restores hit testing once the
    // anchor has settled (rect read = layout resolved). An already-open
    // panel is left to the entry that owns it.
    panel!.style.pointerEvents = 'none';
    panel!.showPopover();
  }
  /** lock 3: the geometric verdict — the point against both surfaces'
      live rects (+halo). Events may be lost or reordered on an
      animated top-layer element; rects cannot lie. A zero-area rect
      (unrendered: position-visibility, pre-layout) reads as NOT near —
      an empty box plus the halo would fake a presence pocket at the
      viewport origin */
  function pointerOnComplex(): boolean {
    if (Number.isNaN(px) || Number.isNaN(py)) return onAnchor || onPanel;
    const near = (el: HTMLElement | null): boolean => {
      if (!el) return false;
      const r = el.getBoundingClientRect();
      if (r.width <= 0 || r.height <= 0) return false;
      return px >= r.left - HALO && px <= r.right + HALO && py >= r.top - HALO && py <= r.bottom + HALO;
    };
    return near(anchorEl) || near(panel);
  }
  /** close after the grace window — the verdict runs at FIRE time and
      re-arms while the pointer still holds the complex (lock 2+3) */
  function scheduleClose(): void {
    clearTimeout(openTimer);
    clearTimeout(closeTimer);
    closeTimer = setTimeout(() => {
      if (pointerOnComplex()) {
        scheduleClose(); // re-arm: walking away still closes on a later fire
        return;
      }
      close();
    }, closeDelay);
  }
  function close(): void {
    clearTimers();
    if (popoverApi(panel) && panel!.matches(':popover-open')) panel!.hidePopover();
  }

  function onEnter(): void {
    onAnchor = true;
    clearTimeout(closeTimer);
    // 0 (the default) opens synchronously — a setTimeout(…, 0) would
    // still defer to the next macrotask and read as a lag
    if (openDelay <= 0) {
      open();
      return;
    }
    openTimer = setTimeout(open, openDelay);
  }

  // run/destroy token (Codex r2): a phase continuation queued as a
  // microtask can still fire AFTER onDestroy canceled the live
  // animations — every .then() re-validates before creating successors
  let runToken = 0;

  // pending intent timers AND kernel animations must never outlive the
  // component (Codex r1: un-canceled WAAPI keeps animating detached DOM)
  onDestroy(() => {
    runToken++;
    clearTimers();
    for (const a of kernelAnims()) a.cancel();
  });

  // THE toggle seam (popover.svelte's): open state read LIVE from
  // :popover-open at fire time — ToggleEvent state fields are never
  // trusted. Open authors the notch + slide vector (pre-recalc) and
  // plays the entry; close plays the exit (the jx-waapi law holds
  // display+overlay through the run). A closed panel is display:none —
  // the pointer CANNOT hold it, so the panel flag resets here (an
  // engine that skips the removal-boundary events would leave it
  // stuck true and the next close would never fire).
  function onTipToggle(): void {
    if (!panel) return;
    if (panel.matches(':popover-open')) {
      aimPin();
      playEntry();
    } else {
      onPanel = false;
      playExit();
    }
  }
</script>

<svelte:window
  onkeydown={(e) => e.key === 'Escape' && close()}
  onpointermove={(e) => {
    // HOVER-state pointers only (Codex r3+r4): a touch contact also
    // fires pointermove, and its LAST coordinate would sit in the
    // anchor halo forever after liftoff — the re-arm loop would keep
    // the tip open with no hover to anchor it. Mouse counts outright;
    // a pen counts only while actually hovering (buttons 0 — a pen
    // contact is a touch-equivalent, not every pen hardware hovers)
    if (e.pointerType !== 'mouse' && !(e.pointerType === 'pen' && e.buttons === 0)) return;
    px = e.clientX;
    py = e.clientY;
  }}
/>

<!-- svelte-ignore a11y_no_static_element_interactions -- the wrapper is
     not an interactive control; hover/focus intent is decoration riding
     over whatever focusable trigger the consumer composed inside -->
<span
  data-jx-tip-anchor=""
  class={cn('inline-flex', className)}
  style="anchor-name: {anchorName}"
  aria-describedby={id}
  bind:this={anchorEl}
  onpointerenter={onEnter}
  onpointerleave={() => {
    onAnchor = false;
    scheduleClose();
  }}
  onfocusin={open}
  onfocusout={(e) => {
    // focus moving BETWEEN the wrapper's own children must not flicker
    // the tip (only a real exit closes)
    if (!e.currentTarget.contains(e.relatedTarget)) close();
  }}
>
  {@render children()}
</span>

<div
  {id}
  popover="manual"
  role="tooltip"
  class="jx-tip jx-surface jx-waapi fixed w-fit max-w-[min(80vw,18rem)] text-xs leading-[1.5] text-center text-popover-foreground"
  data-variant={d.variant}
  data-arrow={arrow ? '' : undefined}
  data-border-ring={arrow ? '' : undefined}
  bind:this={panel}
  style="position-anchor: {anchorName}; inset-area: {area}; position-area: {area};"
  ontoggle={onTipToggle}
  onpointerenter={() => {
    onPanel = true;
    clearTimeout(openTimer);
    clearTimeout(closeTimer);
  }}
  onpointerleave={() => {
    onPanel = false;
    scheduleClose();
  }}
>
  <!-- the REAL shadow layer: a DOM child because pseudo-elements are
       unreachable from WAAPI — the kernel animates it in lockstep
       (popover r18 law), masked to the notch silhouette -->
  <div class="jx-tip-shadow jx-surface-shadow" aria-hidden="true"></div>
  <!-- surface body (fill + acrylic blur + silhouette mask); the popover
       element paints nothing (floating-surface law arch r3) and carries
       the border-ring ::before for the masked outline -->
  <span class="jx-tip-body jx-surface-body block px-[9px] py-[5px]" bind:this={body}>{text}</span>
</div>
