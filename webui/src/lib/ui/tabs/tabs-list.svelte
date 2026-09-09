<!--
  jixoai tabs list (registry/files/ui/tabs/tabs-list.svelte).
  The tablist half of the tabs family: role=tablist strip carrying the
  APG keyboard contract — Arrow keys walk the triggers of the list's
  orientation axis (horizontal: ←/→, vertical: ↑/↓, RTL-aware), Home/End
  jump the ends, the walk WRAPS, and disabled triggers are skipped.
  Focus is NOT trapped: Tab leaves the tablist entirely (roving
  tabindex — only the selected trigger is tabbable).

  Activation follows the root's `activation` prop: 'automatic' selects
  on every focus move (terminal immediacy); 'manual' moves focus only —
  Enter/Space commit through the trigger's native click. The tablist
  itself sits at tabindex="-1" — deliberately OUT of the Tab order (the
  roving stop belongs to a trigger; stating it in the DOM is the focus
  contract the a11y checker reads, no suppression). Triggers are
  whatever the consumer nests (tabs-trigger.svelte pairs
  here, but any [role=tab] joins the walk) — keyboard handling is DOM
  delegation over :scope [role=tab]:not([disabled]), no registration.

  Indicator engine (2026-09-01, tabs variant system): the list owns a
  shared sliding indicator span (LAST child) measured against its OWN
  selected trigger — offsetLeft/offsetTop layout coords (scroll-proof,
  RTL-safe). `indicator` picks a built-in material ('none' renders
  nothing) OR passes a Snippet: the snippet replaces the paint while
  this engine still owns the geometry (a snippet rides the pill-family
  hug box; data-material reports 'custom'). Only the `line` material
  keeps the structural border; `layout` adds grow/scroll/wrap strip
  shapes.

  STRUCTURE (Owner, 2026-09-01 R4): the TABLIST is the scrollable
  region — the a11y scroll region and the DOM scroller are one element
  (data-jx-tabs-list, the .jx-tabs-run). Children of a scroller scroll
  with its content, so the OVERLAYS mount on the component root
  instead: the root is a ONE-CELL GRID HOST (grid positioning, z-index
  layering — never position:*) stacking three kinds of grid items in
  the same cell: the tablist scroller (base), the merged veil layer
  (z 1, shared by BOTH veil effects — progressBlur's ladder and
  shadow's contrast bands) and the two chevron BUTTONS (z 2) —
  real DOM, not ::scroll-button() pseudos (UA boxes: no timeline, no
  mask control, flaky generation — DOM buttons are standard,
  styleable, keyboard-scrollable and live OUTSIDE the tablist, keeping
  the a11y tree clean of non-tab controls). The veil layer is one
  overflow:clip grid item holding both edge veils; each veil ENTERS by
  scroll-driven translate (start: -100% → 0 as travel opens the start
  edge; end: 0 → +100% as travel closes the end edge) — the strip's
  own --jx-tabs-progress drives it, clipped by the layer (the css
  contract lives in tabs-trigger.css).

  Scroll-contract hardening (2026-09-02 fix wave): RTL runs normalize
  the spec's negative scrollLeft (state, progress and the physical
  edge-factor window all read inline-true, A-1/A-2/A-3); direction
  resolution is ONE law everywhere — computed direction first, [dir]
  attribute fallback (P2: the walk and the scroll math can no longer
  disagree under pure-css rtl) — and all three RTL scrollLeft engines
  (negative / positive-ascending / positive-descending) funnel through
  one canonical [−max, 0] inline space; the stamp
  caches the trigger list (MutationObserver invalidation, A-11/B-4)
  and splits its read pass from its write pass; document.fonts.ready
  and the first/last trigger boxes restamp the verdict quietly
  (A-4/B-2); the indicator inherits the ACTIVE trigger's edge factors
  so an exiting selected tab takes its bar with it (V1-2); disabled
  flips re-trim the roving tabindex, handing a dead stop to the first
  enabled trigger through the context (A-9, P1).
-->
<script lang="ts" module>
  /** indicator paint materials — 'none' renders no indicator at all */
  export type TabsIndicatorMaterial = 'line' | 'pill' | 'outline' | 'glass' | 'liquid' | 'none';

  /** measured geometry the engine hands a custom indicator snippet */
  export type TabsIndicatorGeo = {
    x: number;
    y: number;
    w: number;
    h: number;
    orientation: 'horizontal' | 'vertical';
  };

  /** strip shape: inline (natural) · grow (triggers stretch) · scroll
   *  (declared overflow run) · wrap (multi-row flow) — every horizontal
   *  strip additionally degrades to a scroll run when content outgrows
   *  the container (css-owned, tabs-trigger.css) */
  export type TabsLayout = 'inline' | 'grow' | 'scroll' | 'wrap';

  /** edge treatment for a scrolling run (Owner, 2026-09-01; round 2
   *  2026-09-04 — the merged builder), built by the typed builders
   *  below (the press-button effect convention — builders keep
   *  options typed and discoverable):
   *  - ramp({ opacity, blur, translate }): the ONE member-ramp
   *    builder, every toggle default ON — each trigger ramps as it
   *    clips under a run edge — scroll-following per-trigger factors
   *    (--jx-edge-start/end, the clipped fraction of the trigger's
   *    own width) stamped by the scroll handler and calc'd in css,
   *    consumed squared; rest is factor 0 by arithmetic, on every
   *    engine (view() timelines were tried and rejected: Chromium 152
   *    resolves named ranges garbage at rest — the stuck-first-button
   *    bug). A toggle turned off never pays its property (ramp({
   *    blur: false }) is the old cheapest slide posture)
   *  - progressBlur() / shadow(): the merged veil layer veils both
   *    inline edges, gated by scrollability and ENTERING by
   *    scroll-driven translate — progressBlur is the multi-layer
   *    blur ladder; shadow is the single-layer contrast ghost (the
   *    separator's INK law: backdrop-filter contrast() subtracts
   *    color, never adds black — auto-adaptive in dark mode). width
   *    overrides the band width (--jx-tabs-veil) */
  // ── THE UNIFICATION (Owner 2026-09-04: "统一成一套 utils") — the
  // scroll machinery (stamp machine, RTL engine, nudge, effect
  // builders) is the SHARED scroll-run item. The family's public API
  // is preserved as re-exports (docs/specs import from here; import +
  // re-export so the local destructure default `ramp()` binds).
  // ROUND 2 (breaking, Owner 2026-09-04): slide()/blur()/blurSlide()
  // merged into ramp({ opacity, blur, translate }) — the toggles
  // replace the trio
  import {
    detectRtlScrollModel,
    isRtlDirection,
    progressBlur,
    ramp,
    rtlScrollFromCanonical,
    rtlScrollToCanonical,
    shadow,
    type RtlScrollModel,
    type ScrollEffect,
  } from '../scroll-run/scroll-run.svelte';
  export { detectRtlScrollModel, isRtlDirection, progressBlur, ramp, rtlScrollFromCanonical, rtlScrollToCanonical, shadow };
  export type { RtlScrollModel, ScrollEffect as TabsScrollEffect };
</script>

<script lang="ts">
  import type { Snippet } from 'svelte';
  import type { HTMLAttributes } from 'svelte/elements';
  import { getContext } from 'svelte';
  import { cn } from '$lib/utils';
  import { TABS_KEY, type TabsApi } from './tabs.svelte';
  import ScrollChrome from '../scroll-run/scroll-chrome.svelte';
  import { createScrollStamp, nudgeRun, isRtlElement, type ScrollStamp } from '../scroll-run/scroll-run.svelte';

  interface Props extends HTMLAttributes<HTMLDivElement> {
    /** axis of travel: horizontal ←/→ · vertical ↑/↓ (layout is yours) */
    orientation?: 'horizontal' | 'vertical';
    /** selection indicator: a built-in material, or a Snippet that owns
     *  the paint while the engine keeps owning the measured geometry */
    indicator?: TabsIndicatorMaterial | Snippet<[TabsIndicatorGeo]>;
    /** inline: natural sizes · grow: triggers share the strip · scroll: a
     *  declared overflow run · wrap: rows flow instead of scrolling */
    layout?: TabsLayout;
    /** edge treatment while the run scrolls — built by ramp() (the
     *  one member-ramp builder: opacity/blur/translate toggles, all
     *  default on; ramp({ blur: false }) is the cheapest posture) /
     *  progressBlur() / shadow() */
    scrollEffect?: TabsScrollEffect;
    children: Snippet;
  }

  let {
    orientation = 'horizontal',
    indicator = 'line',
    layout = 'inline',
    scrollEffect = ramp(),
    class: className = '',
    style: consumerStyle,
    children,
    ...rest
  }: Props = $props();

  /** name-collision law: a function IS the override snippet (Svelte's
   *  own runtime check for snippets); a string selects a built-in */
  function isIndicatorSnippet(value: Props['indicator']): value is Snippet<[TabsIndicatorGeo]> {
    return typeof value === 'function';
  }

  const indicatorSnippet = $derived(isIndicatorSnippet(indicator) ? indicator : undefined);
  /** the material actually reported/painted — a custom snippet has no
   *  built-in paint, so it never keeps the structural border either */
  const material = $derived(isIndicatorSnippet(indicator) ? 'custom' : indicator);

  const tabs = getContext<TabsApi>(TABS_KEY);

  /** the component root — the one-cell grid HOST carrying the overlays
   *  (the tablist scroller scrolls its own children; overlays must not
   *  scroll, so they mount here, in the same grid cell) */
  let hostEl = $state<HTMLDivElement>();
  /** the tablist — role=tablist AND (horizontal strips) the .jx-tabs-run
   *  scroller: the a11y scroll region and the DOM scroller are one */
  let listEl = $state<HTMLDivElement>();
  /** the horizontal scroll run (the tablist itself; null on vertical) */
  const runEl = $derived(orientation === 'horizontal' ? listEl : null);
  let indEl = $state<HTMLSpanElement>();
  /** measured geometry of the selected trigger; null = nothing selected */
  let geo = $state<TabsIndicatorGeo | null>(null);
  /** the FIRST placement after mount must not animate (no 0,0 slide-in);
   *  selection moves afterwards slide */
  let quietNext = true;

  /** cached own-trigger list (2026-09-02, A-11/B-4): the scroll stamp
   *  walks this on every scroll event — the DOM query was the recurring
   *  O(N) cost. Invalidated by the list's MutationObserver below */
  let triggerCache: HTMLElement[] | null = null;

  /** the ACTIVE trigger (2026-09-02, V1-2): measure() refreshes it; the
   *  scroll stamp copies its edge factors onto the indicator span so a
   *  selected trigger clipping under an edge never leaves a
   *  full-opacity orphan slice its fading label no longer explains */
  let activeTab: HTMLElement | null = null;

  /** the scroll stamp, reachable from measure() (a selection move must
   *  re-fade the indicator against the NEW active trigger without
   *  waiting for the next scroll) — assigned by the scroll-state effect */
  let restamp: (() => void) | undefined;

  /** this list's OWN triggers — nested tablists (a panel hosting its own
   *  Tabs) keep their own walker, so closest() must resolve HERE */
  function ownTabs(): HTMLElement[] {
    return [...(listEl?.querySelectorAll<HTMLElement>('[role=tab]') ?? [])].filter(
      (tab) => tab.closest('[role=tablist]') === listEl,
    );
  }

  /** the cached variant — builds on first use, rebuilds after MO
   *  invalidation (late-mounted triggers join the stamp and the walk) */
  function cachedTabs(): HTMLElement[] {
    return (triggerCache ??= ownTabs());
  }

  /** the family-wide rtl verdict (P2, 2026-09-02): the walk, the scroll
   *  state and the nudges all ask HERE — the old split (computed for
   *  scroll, [dir] for the walk) made a pure-css rtl run walk
   *  backwards while its scroll math ran forwards */
  const isRtl = isRtlElement;

  /** geometry law (px numbers, layout coords): pill-family hugs the
   *  trigger inset by half the inline inset token; line is a 2px bar
   *  riding the strip's content edge on the orientation axis. All
   *  offsets resolve against the trigger's offsetParent — the RUN on
   *  horizontal lists (the tablist scroller, position: relative, so the
   *  indicator scrolls WITH the content instead of stranding at the
   *  viewport edge) and the list itself on flat vertical ones (jsdom's
   *  null offsetParent falls back to the list) */
  function geometryFor(t: HTMLElement, list: HTMLElement): TabsIndicatorGeo {
    const box = (t.offsetParent as HTMLElement | null) ?? list;
    if (material !== 'line') {
      // the pill family breathes by the label's OWN inset rhythm — the
      // trigger's resolved padding-inline (the used value, so density
      // tiers and calc() tokens arrive as real px; jsdom's zero layout
      // resolves to 0, where geometry numbers are unasserted anyway).
      // Derived, never a guessed constant.
      const inset = parseFloat(getComputedStyle(t).paddingInlineStart || '0') / 2 || 0;
      return {
        x: t.offsetLeft + inset,
        y: t.offsetTop + inset,
        w: t.offsetWidth - inset * 2,
        h: t.offsetHeight - inset * 2,
        orientation,
      };
    }
    // line material: the 2px bar rides the STRIP edge — but a wrapped
    // strip has no single travel edge, so the bar rides the trigger's
    // own edge on the far side (the Material fixed-tabs wrap reads this
    // way: each row underlines its own active tab)
    if (orientation === 'horizontal') {
      return {
        x: t.offsetLeft,
        y: layout === 'wrap' ? t.offsetTop + t.offsetHeight - 2 : box.clientHeight - 2,
        w: t.offsetWidth,
        h: 2,
        orientation,
      };
    }
    return {
      x: layout === 'wrap' ? t.offsetLeft + t.offsetWidth - 2 : box.clientWidth - 2,
      y: t.offsetTop,
      w: 2,
      h: t.offsetHeight,
      orientation,
    };
  }

  /** measure the list's OWN selected trigger and place the indicator;
   *  quiet placements set data-quiet BEFORE the style write and clear
   *  it a frame later, so the css transition never picks them up.
   *  A selection-driven measure ALWAYS strips a leftover quiet flag —
   *  a throttled/stalled clear frame (backgrounded tab) must never
   *  leave the bar transition-less for good */
  function measure(quiet: boolean) {
    const list = listEl;
    if (!list) return;
    const active = [...list.querySelectorAll<HTMLElement>('[role=tab][aria-selected="true"]')].find(
      (tab) => tab.closest('[role=tablist]') === list,
    );
    if (!active) {
      geo = null;
      activeTab = null;
      restamp?.();
      return;
    }
    if (quiet && indEl) {
      indEl.setAttribute('data-quiet', '');
      const el = indEl;
      requestAnimationFrame(() => el.removeAttribute('data-quiet'));
      setTimeout(() => el.removeAttribute('data-quiet'), 64);
    } else {
      indEl?.removeAttribute('data-quiet');
    }
    geo = geometryFor(active, list);
    activeTab = active;
    // the indicator's edge factors follow the NEW active trigger now
    restamp?.();
  }

  // selection-driven placement: re-measure when the selection moves and
  // when the geometry law itself flips (material family / axis / layout)
  $effect(() => {
    if (material === 'none') {
      geo = null;
      return;
    }
    void tabs.selected;
    void material;
    void orientation;
    void layout;
    measure(quietNext);
    quietNext = false;
  });

  // size-driven remeasure (density/font/layout shifts resize the strip)
  // — always QUIET: a resize is not a selection move, the bar must not
  // slide. jsdom has no ResizeObserver; the guard keeps tests honest
  $effect(() => {
    const list = listEl;
    if (!list || typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(() => measure(true));
    ro.observe(list);
    return () => ro.disconnect();
  });

  /** the run's scrollability verdict + edge factors (Owner
   *  2026-09-01, hardened 2026-09-02, UNIFIED 2026-09-04): the SHARED
   *  createScrollStamp machine owns the pass — the verdict
   *  (data-jx-scroll-state, the single truth the shared css keys the
   *  chips and the veil layer on), the host's --jx-scroll-progress
   *  (RTL-normalized), and the per-trigger --jx-edge-* factors. The
   *  family's OWN additions: the MO-invalidated trigger cache as the
   *  ramp audience, and the indicator span as a MIRROR member (V1-2 —
   *  the bar rides its ACTIVE trigger's factors, so an exiting
   *  selected tab takes its bar with it); a trigger box change also
   *  moves the indicator's geometry, so the RO pass re-measures
   *  quietly */
  let stampMachine: ScrollStamp | undefined;
  $effect(() => {
    void scrollEffect.type; // flips re-arm the machine (ramps audience)
    const run = runEl;
    if (!run) return;
    // the ramps are the per-trigger edge treatments ONLY — explicit
    // enumeration (2026-09-02, A-6): the veil effects never pay the
    // per-trigger stamp loop (their css consumes none of it)
    stampMachine = createScrollStamp({
      run,
      host: hostEl,
      members: cachedTabs,
      ramps: scrollEffect.type === 'ramp',
      mirrors: () => {
        const a = activeTab;
        const ind = indEl;
        return a && ind ? [{ target: ind, source: a }] : [];
      },
    });
    restamp = () => stampMachine?.update();
    return () => {
      restamp = undefined;
      stampMachine?.destroy();
      stampMachine = undefined;
    };
  });

  /** the chevron's scroll step — the SHARED nudgeRun (one page minus
   *  the two lanes, the lane derived from the run's own
   *  scroll-padding; RTL writes through absolute canonical targets) */
  function nudge(direction: -1 | 1) {
    if (runEl) nudgeRun(runEl, direction);
  }

  /** liquid needs its displacement filter referenced from the list (the
   *  indicator span inherits the custom property); the effect knobs land
   *  beside it on the HOST (the overlays are the run's siblings — a var
   *  on the run never reaches them); a consumer style APPENDS (merge
   *  law, alert-dialog dialect — never clobber) */
  const hostStyle = $derived.by(() => {
    const parts = [
      material === 'liquid' ? `--jx-tabs-liquid-bf: url('#${tabs.uid}-liquid') blur(2px) saturate(1.6)` : '',
      '',
    ];
    switch (scrollEffect.type) {
      case 'ramp':
        // round 3: the ramp's magnitudes are CHROME-OWNED (ScrollChrome
        // stamps --jx-scroll-edge-slide/blur on the run from the
        // builder's distance/radius) — the host carries no edge vars
        parts[1] = '';
        break;
      case 'progressBlur':
      case 'shadow':
        // the builder's width overrides the band-width default (inline
        // beats the stylesheet)
        parts[1] = scrollEffect.width ? `--jx-scroll-veil: ${scrollEffect.width}` : '';
        break;
      default:
        break;
    }
    return [...parts, consumerStyle ?? ''].filter(Boolean).join('; ') || undefined;
  });

  // the empty state (no focus, no selection) renders every trigger
  // tabbable for SSR/JS-off entry; trim to the FIRST enabled tab only —
  // exactly one tab stop, per the APG roving law (disabled triggers
  // explicitly -1: browsers skip them, the DOM should say so too)
  function trimTabStops() {
    if (!listEl) return;
    const triggers = cachedTabs();
    // a NON-empty stop must be validated before the bail (2026-09-02,
    // P1): the stop trigger going disabled at runtime strands a dead
    // tabindex=0 while every sibling sits at -1 — the strip's only
    // keyboard entry gone. The hand-over goes through the CONTEXT (the
    // trigger's isTabStop derived is tabindex's single writer; a raw
    // attribute write here would be reverted by the next render), and
    // only to a trigger carrying the family id — a foreign [role=tab]
    // has no context value to receive the stop
    if (tabs.tabStop !== '') {
      const dead = triggers.find((tab) => tab.tabIndex === 0 && tab.hasAttribute('disabled'));
      if (dead) {
        const prefix = `${tabs.uid}-tab-`;
        const next = triggers.find((tab) => !tab.hasAttribute('disabled') && tab.id.startsWith(prefix));
        if (next) tabs.setTabStop(next.id.slice(prefix.length));
      }
      return;
    }
    const firstEnabled = triggers.find((tab) => !tab.hasAttribute('disabled'));
    for (const tab of triggers) {
      tab.setAttribute('tabindex', tab === firstEnabled ? '0' : '-1');
    }
  }
  $effect(trimTabStops);

  // one observer, three jobs (2026-09-02, A-9/A-11 + CR-1 P3-4):
  // childList flips invalidate the stamp's trigger cache (a
  // late-mounted trigger joins the walk AND gets its edge factors
  // stamped — no blank first frame on ramp materials), and disabled
  // flips re-trim the roving tabindex — a dynamically disabled tab
  // stop must hand the stop to the first enabled trigger, or the
  // strip loses its only keyboard entry
  $effect(() => {
    const list = listEl;
    if (!list || typeof MutationObserver === 'undefined') return;
    const mo = new MutationObserver(() => {
      triggerCache = null;
      trimTabStops();
      restamp?.();
    });
    // subtree is required to see attribute flips on the trigger
    // children; the attributeFilter keeps Svelte's own tabindex trims
    // (and every other attribute) out of the loop
    mo.observe(list, { childList: true, subtree: true, attributes: true, attributeFilter: ['disabled'] });
    return () => mo.disconnect();
  });

  /** APG keyboard walk — arrows along the axis (flipped under rtl — the
   *  ONE resolver: computed law, [dir] fallback, so the walk can never
   *  disagree with the scroll math under pure-css rtl), Home/End to the
   *  ends; wraps; skips disabled triggers */
  function handleKeydown(event: KeyboardEvent) {
    const rtl = orientation === 'horizontal' && isRtl(listEl);
    const forward = orientation === 'horizontal' ? (rtl ? 'ArrowLeft' : 'ArrowRight') : 'ArrowDown';
    const back = orientation === 'horizontal' ? (rtl ? 'ArrowRight' : 'ArrowLeft') : 'ArrowUp';
    if (event.key !== forward && event.key !== back && event.key !== 'Home' && event.key !== 'End') {
      return;
    }
    const triggers = ownTabs().filter((tab) => !tab.hasAttribute('disabled'));
    if (triggers.length === 0) return;
    const current = triggers.indexOf(document.activeElement as HTMLElement);
    event.preventDefault();
    const next =
      event.key === 'Home'
        ? triggers[0]
        : event.key === 'End'
          ? triggers.at(-1)
          : current === -1
            ? triggers[0]
            : triggers[(current + (event.key === forward ? 1 : -1) + triggers.length) % triggers.length];
    // focus rides the roving tabindex: the trigger's onfocus moves the
    // tab stop; automatic activation ALSO selects on the focus move,
    // manual waits for Enter/Space — the trigger's native click path
    if (!next) return;
    next.focus();
    if (tabs.activation === 'automatic') next.click();
  }
</script>

{#snippet runTail()}
  {#if material === 'liquid'}
    <!-- zero-size SVG carrying the displacement filter the liquid
         backdrop references by fragment id -->
    <svg aria-hidden="true" class="absolute h-0 w-0">
      <filter id="{tabs.uid}-liquid" x="-20%" y="-20%" width="140%" height="140%">
        <feTurbulence type="fractalNoise" baseFrequency="0.012 0.012" numOctaves="2" seed="7" />
        <feDisplacementMap in="SourceGraphic" scale="14" xChannelSelector="R" yChannelSelector="G" />
      </filter>
    </svg>
  {/if}
  {#if material !== 'none'}
    <!-- the engine-owned wrapper: geometry lands here, a custom
         snippet paints inside it -->
    <span
      bind:this={indEl}
      data-jx-tabs-ind=""
      data-material={material}
      aria-hidden="true"
      hidden={geo === null}
      style={geo === null
        ? undefined
        : `transform: translate(${geo.x}px, ${geo.y}px); width: ${geo.w}px; height: ${geo.h}px`}
    >
      {#if indicatorSnippet && geo}{@render indicatorSnippet(geo)}{/if}
    </span>
  {/if}
{/snippet}

<div
  bind:this={hostEl}
  data-jx-tabs-host=""
  data-indicator={material}
  data-layout={layout}
  class={cn(
    'relative box-border',
    // the ONE-CELL GRID HOST (Owner law): the tablist scroller, the
    // veil layer and the chevron buttons stack in the same cell —
    // grid positions them, z-index layers them, never position:*
    // (horizontal strips carry .jx-scroll-host TOO: the shared sheet's
    // var family + verdict gates key on it — caught live on the docs
    // page as always-visible ghost chips with no ink and no glyph)
    orientation === 'horizontal'
      ? 'jx-scroll-host jx-tabs-horizontal grid [grid-template-columns:minmax(0,1fr)]'
      : 'jx-tabs-vertical flex flex-col items-stretch [gap:var(--jx-gap)]',
    material === 'line' && (orientation === 'vertical' ? 'border-r border-border' : 'border-b border-border'),
    orientation === 'vertical' && layout === 'wrap' && 'flex-wrap',
    className,
  )}
  style={hostStyle}
  {...rest}
>
  <div
    bind:this={listEl}
    data-jx-tabs-list=""
    data-jx-tabs-run={orientation === 'horizontal' ? '' : undefined}
    data-jx-scroll-run={orientation === 'horizontal' ? '' : undefined}
    data-axis={orientation === 'horizontal' ? 'horizontal' : undefined}
    role="tablist"
    aria-orientation={orientation}
    tabindex="-1"
    class={cn(
      'box-border',
      // horizontal: THE run — role=tablist IS the scroller (the a11y
      // scroll region and the DOM scroller are one element); it is the
      // indicator's containing block (position: relative — offsets are
      // run-relative, the bar scrolls WITH the content). Vertical
      // strips keep the flat flex column
      orientation === 'horizontal'
        ? 'jx-tabs-run relative flex items-stretch overflow-x-auto [gap:var(--jx-gap)]' + (layout === 'wrap' ? ' flex-wrap' : '')
        : 'flex flex-col',
    )}
    data-layout={orientation === 'horizontal' ? layout : undefined}
    onkeydown={handleKeydown}
  >
    {@render children()}
    {@render runTail()}
  </div>
  {#if orientation === 'horizontal'}
    <!-- the chrome (veil layer + chevron chips) is the SHARED
         ScrollChrome — scroll-chrome.svelte; the paint laws in
         scroll-run.css -->
    <ScrollChrome {scrollEffect} run={runEl} backwardLabel="Scroll tabs backward" forwardLabel="Scroll tabs forward" />
  {/if}
</div>
