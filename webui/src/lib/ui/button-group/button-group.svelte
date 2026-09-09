<!--
  jixoai button group — the ROOT half (registry/files/ui/button-group/
  button-group.svelte, OpenSpec 2026-08-30-expand-form-family F2;
  r13 upgrade: context variant pass-down, on-demand separators, grid
  layout, overflow wrap/collapse).

  The shadcn Button Group counterpart, native to this registry's laws:
  an orientation/justify LAYOUT container that joins press-buttons
  (and icon-buttons) edge-to-edge over the hairline seam law. The
  container owns NOTHING but the layout and the seam — the buttons
  keep their own paint (variant ladder, density tier; physics is the
  one takeover, THE CLUSTER SHADOW below): the group paints no bezel
  of its own, so a joined row of outline buttons reads as ONE control
  with 1px seams instead of a 2px double border between neighbors
  (adjacent children collapse their borders via a -1px margin —
  button-group.css).

    <ButtonGroup label="export actions">
      <PressButton variant="outline">copy</PressButton>
      <ButtonGroupDivider />
      <PressButton variant="outline">move</PressButton>
      <PressButton variant="outline">delete</PressButton>
    </ButtonGroup>

  GROUP CONTEXT (r13, Owner acceptance; single-key law 2026-09-04):
  the group configures its children's paint through the PAINT ZONE —
  BUTTON_GROUP_KEY carries layout only — so one prop styles the whole
  joined row: `variant="ghost"` on the group is adopted by every
  child button that does not pass its own (PressButton resolves
  `explicit ?? ambient zone ?? 'outline'`: an EXPLICIT child prop
  always wins — the stamped-attribute law's consumer face). The
  ladder itself is never touched; context selects rungs, never mints
  one.

  THE CLUSTER SHADOW (Owner 2026-09-04): the joined row is ONE
  control, so it casts ONE shadow — the convex law moves from the
  buttons to the ROOT. The subtree rides FLAT by default (the group
  writes the press-texture key with raised=false: per-button convex
  shadows overlap at the -1px seams, the geometry defect this closes;
  an explicit raised on any child still wins, the zone resolution's
  explicit lane), and the root paints --shadow-xs — the press law's
  REST pose alone, hard offset, no hover growth, no active engrave:
  the root never presses ("不用做什么 actived 的效果，只需要去除阴影
  即可" — the Owner's wording). The `raised` prop resolves like the
  button's own: explicit ?? the enclosing texture zone (a card/dialog
  foot's flat scope carries through — a raised island inside a flat
  zone would be a defect) ?? the top-level convex default — with ONE
  carve: a NESTED group defaults OFF (it is one member of the OUTER
  cluster; one control, one shadow). raised={false} removes the root
  shadow and nothing else — the subtree's flat default is
  unconditional.

  THE SEPARATOR POLICY (ghost's seam): bordered rungs have the -1px
  seam law (their collapsed borders ARE the hairline), but ghost
  paints no border — the seam law has nothing to collapse. `separator`
  (explicit, or ON by default when the group's variant resolves to
  ghost) paints a 1px line in every seam slot, carrying the SEPARATOR
  INK LAW (separator/separator.css, 2026-09-01: a separator paints
  no color — the backdrop's own contrast ghost). THE REAL-DOM ERA
  (Owner, 2026-09-04: "我更希望上真正的 DOM 来做分割线"): the seams
  are REAL elements the GROUP owns as its own children — never a
  pseudo hanging inside a button (the r13/r14-13 ::before era is
  retired). The leading seam renders declaratively in the markup;
  the inter-button seams are injected between the VISIBLE direct
  children at runtime (the children snippet is opaque — neither
  Svelte nor CSS can interleave into it; the DOM can). Geometry is
  the divider's honest-1px-track law (a real track, flush junction
  edges — a -1px overlap would clamp to a zero-width grid track);
  paint is the unchanged ink engine (backdrop-filter, no color
  channel); the elements are aria-hidden decorative carriers. DIVIDER
  vs SEPARATOR ruling (composed era, Owner 2026-09-04): ButtonGroupDivider
  is the group's SEMANTIC boundary between consumer-authored clusters
  — a real, announced element COMPOSED over the Separator component
  (the ink is the same contrast ghost; the element form is
  Separator's W3C-first pair, the family adds only the junction
  geometry); the separator is the DECORATIVE seam between adjacent
  joined buttons (policy-driven, group-injected, invisible to AT).
  Both coexist: dividers between clusters, separators between buttons
  within a cluster (and never adjacent to a divider — that junction
  already has its line); the boundary's EXTRA weight is geometry, not
  ink — flush border·line·border against the intra-cluster collapsed
  1px seam.

  GRID, not flex (r13, Owner law — the 2D nature is accepted): the
  container is `inline-grid`. THE FLOW LAW (Codex B1 rework, pinned
  empirically on Chromium): without an explicit template, auto-flow
  ROW fills the ONE implicit column and grows ROWS (a vertical
  stack); auto-flow COLUMN fills the one implicit row and grows
  COLUMNS (the horizontal single line). So HORIZONTAL groups ride
  grid-auto-flow:column + auto columns (exactly the task's original
  wording — an earlier "row-major" reading was backwards and stacked
  every horizontal group vertically), VERTICAL groups ride the
  default row flow + auto rows. The wrap state swaps the horizontal
  flow to row + per-item stamped cells (below). The -1px seam
  margins carry into grid: an auto track sizes to its item's
  MARGIN-BOX contribution, so each -1px margin overlaps the neighbor
  by exactly 1px with flush group edges — the same law, the same
  selectors, no flex. The DIVIDER is the one geometry the flex era
  could afford and grid cannot: its old -1px/-1px pair made its
  margin-box NEGATIVE (a 1px element overlapping both neighbors),
  which auto tracks clamp to a ZERO-WIDTH track (the audit's
  `72.8px 0px` readout) — the grid-era divider owns a REAL 1px
  track with flush junction edges (button-group.css; the boundary
  reads border·line·border, heavier than the 1px intra-cluster seam
  — a boundary should). justify places the track cluster on the
  main axis (justify-content inline-axis for horizontal, the
  content-* utilities pack the row tracks' block axis for vertical
  — the same cluster-placement semantics flex had). Item-level
  justify-self is deliberately unused: tracks are content-sized and
  items fill them, so group-level packing is the whole alignment
  story. A nested ButtonGroup is ONE grid item for the outer seam
  (child-scoped selectors), so cluster joins never leak the inner
  seams outward.

  OVERFLOW (r13, horizontal only — a vertical stack overflows its
  block axis, which is the scroll container's business, not a
  button group's): when the joined row outgrows its available inline
  space (the container is max-w-full), the measured overflow state
  machine (ResizeObserver, hydration-time — the family-context DOM-
  derived AUTO exception) resolves one of two consumer modes:

    overflow="wrap" (default)  the row re-breaks into measured rows:
      each item is stamped with its greedy grid cell (gridRow/
      gridColumn inline placement — CSS cannot express per-row
      packing; the PLACEMENT is inline style, all PAINT rides the
      data-jx-* stamps) and data-jx-row-start (row leads drop the
      -1px seam + seam pseudo: they have no inline-start neighbor).
      Rows read row-major (DOM order = visual order — grid-auto-flow
      stays row; dense would backfill holes with LATER items and can
      visually reorder, which the DOM-order integrity law forbids).
    overflow="collapse"        overflow tail buttons fold into a
      DropdownMenu behind an icon-only IconButton trigger (⋯,
      popovertarget invoker — the platform path, zero component
      listeners). Hidden buttons keep their real DOM (display:none
      — out of the a11y tree and tab order, listeners intact); each
      menu entry is a DropdownMenuItem whose activation CLICKS the
      hidden button (the consumer's handler fires on the real
      element). The menu rides dropdown-menu's own keyboard contract
      (arrows/typeahead/Enter/Escape, focus returns to the trigger
      on selection or Escape; Tab light-dismisses — no focus trap).
    overflow="scroll" (2026-09-04, the third mode — the tabs
      contract): the ROOT becomes the scroll run (the group and the
      DOM scroller are one element — hidden scrollbar, smooth,
      proximity snap, scroll-padding clearing the veil lanes); the
      joined line never breaks and NO measurement ever runs. The
      scroll handler stamps the run's VERDICT (data-jx-scroll-state:
      none | start-closed | end-closed | open — the single truth the
      css keys the chevrons and the veil layer on; no verdict, no
      chrome), the host's --jx-btngroup-progress (RTL-normalized —
      the three scrollLeft engines funnel through one canonical
      space, the tabs law), and per-member edge factors
      (--jx-edge-start/end) for the scrollEffect ramps. The HOST is
      a one-cell grid wrapper rendered ONLY in this mode (children
      of a scroller scroll with its content — the veil layer z1 and
      the chevron buttons z2 are the run's non-scrolling siblings;
      non-scroll modes render no host, byte-identical DOM). A
      VERTICAL group declaring scroll gets the bare block-axis
      scroller only (the chrome is the horizontal contract).

  HYSTERESIS: overflow states and the collapse count are pure
  functions of the measured available width, but boundary resize
  jitter must not flap: entering overflow is strict (needs >
  available), LEAVING requires HYST margin (available - needs ≥
  HYST), and the collapse count grows only with the same margin.
  The measuring pass is atomic (reset stamps → read → restamp in
  one task, under the transient data-jx-measuring stamp that lays
  everything out — no intermediate paint). Static/no-JS path: no
  measurement ever runs, every button stays inline and visible —
  SSR renders the complete single row.

  ROLE LAW: the root is role=group — this is a grouping of RELATED
  ACTIONS, not a toolbar (toolbars are roving-tabindex collections of
  controls; every button here keeps its own tab stop, the platform's).
  Name it: `label` (aria-label) or aria-labelledby through the rest
  props — a nameless group is announced as nothing. The role is
  consumer-overridable through the rest props (an explicitly labeled
  toolbar is the consumer's explicit contract; this component never
  stamps toolbar by itself).

  THE toggle-group BOUNDARY (recorded law, see the docs page): the
  moment the children express SELECTION — a pressed state, an active
  value — this is the wrong component. Segmented selection is
  toggle-group's law (native radios/checkboxes, one form field). A
  button group is action-only: press, effect, navigate.

  Orientation: horizontal (default) or vertical; `justify` places the
  joined cluster on the main axis (start | center | end). Density is
  PROVIDED to the subtree, so the joined buttons adopt the group's
  tier without per-button props.
-->
<script module lang="ts">
  /** the group's context surface: the seam/divider geometry switch +
   *  the separator policy pass-down. LAYOUT ONLY since the single-key
   *  law (Owner 2026-09-04): paint rides PAINT_ZONE_KEY, this key
   *  carries no variant */
  export interface ButtonGroupApi {
    readonly orientation: 'horizontal' | 'vertical';
    /** the separator policy as resolved on the group (explicit prop,
     *  or on by default under a ghost group) */
    readonly separator: boolean;
  }

  /** context key — global symbol registry (independent registry items) */
  export const BUTTON_GROUP_KEY = Symbol.for('jx-button-group');

  // ── THE UNIFICATION (Owner 2026-09-04: "统一成一套 utils") — the
  // scroll machinery (the stamp machine, the RTL engine, the nudge
  // and the scrollEffect builders) is the SHARED scroll-run item now,
  // one set for every scrollable region in the registry. Re-exported
  // here for the family's own API surface (docs and specs import the
  // builders from this module; the alias keeps the public name).
  // ROUND 2 (breaking, Owner 2026-09-04): slide()/blur()/blurSlide()
  // merged into ramp({ opacity, blur, translate }) — the toggles
  // replace the trio
  import {
    progressBlur,
    ramp,
    shadow,
    type ScrollEffect,
  } from '../scroll-run/scroll-run.svelte';
  // import + re-export (a bare `export {x} from` binds nothing locally,
  // and the props' default `ramp()` needs the local binding)
  export { progressBlur, ramp, shadow };
  export type { ScrollEffect as ButtonGroupScrollEffect };
</script>

<script lang="ts">
  import type { Snippet } from 'svelte';
  import type { HTMLAttributes } from 'svelte/elements';
  import { getContext, setContext } from 'svelte';
  import {
    getDensityContext,
    provideDensity,
    resolveDensity,
    type Density,
  } from '$lib/density.svelte';
  import { getPaintZone, providePaintZone, type ZonePaintVariant } from '$lib/paint.svelte';
  import Icon from '$lib/ui/icon';
  import DropdownMenu from '$lib/ui/dropdown-menu/dropdown-menu.svelte';
  import DropdownMenuItem from '$lib/ui/dropdown-menu/dropdown-menu-item.svelte';
  import IconButton from '$lib/ui/icon-button/icon-button.svelte';
  import { cn } from '$lib/utils';
  import { PRESS_TEXTURE_KEY, type PressTextureApi } from '../press-button/press-button.svelte';
  import { createScrollStamp } from '../scroll-run/scroll-run.svelte';
  import ScrollChrome from '../scroll-run/scroll-chrome.svelte';
  import { ButtonGroupDefaults } from './button-group-defaults.svelte';
  import './button-group.css';

  interface Props extends HTMLAttributes<HTMLDivElement> {
    /** the join axis: horizontal (default) | vertical */
    orientation?: 'horizontal' | 'vertical';
    /** cluster placement on the main axis */
    justify?: 'start' | 'center' | 'end';
    /** accessible group name (aria-label). Pass aria-labelledby
        through the rest props instead when an external label owns
        the name — a nameless group is announced as nothing */
    label?: string;
    /** the GROUP variant: adopted by every child button that passes
        no variant of its own (explicit child prop always wins). No
        ladder is minted — context selects a press-button rung.
        NARROWED to ZonePaintVariant (context-defaults-economy 1.2):
        link is not a zone value — it stays reachable only through
        PressButton's own explicit prop, so `<ButtonGroup
        variant="link">` (legal before) is now a compile error, the
        change's one syntactic breaking edge */
    variant?: ZonePaintVariant;
    /** the CLUSTER shadow axis (Owner 2026-09-04): the joined row is
     *  one control, so the ROOT carries the one convex shadow
     *  (--shadow-xs, the press law's rest pose alone — no hover
     *  growth, no active engrave; the root never presses).
     *  Resolution mirrors the button's physics: explicit ?? the
     *  enclosing texture zone ?? the top-level convex default — a
     *  NESTED group defaults OFF (one member of the outer cluster;
     *  one control, one shadow). raised={false} removes the root
     *  shadow and NOTHING else; the subtree's flat default (the
     *  texture write below) is unconditional */
    raised?: boolean;
    /** the separator policy: a real 1px separator element in every
        seam slot (ghost's seam — bordered rungs already read through
        the -1px law). Explicit true/false; DEFAULT on when the group's
        EFFECTIVE variant (own prop, else the inherited scope) is
        ghost — the borderless row has no other seam */
    separator?: boolean;
    /** the LEADING SEAM (r14-13 → the real-DOM era, 2026-09-04): paint
        the seam in the cluster's opening slot too — a REAL element the
        group renders as its own first child, FLUSH by construction
        (inside the group, no parent gap can detach it — the failure
        that killed the old standalone Separator sibling). Composes
        with the seam policy: it only renders when separators are
        active (the dialog footer's actions region is the canonical
        consumer) */
    leadingSeam?: boolean;
    /** what happens when the joined row overflows its available
     *  inline space (horizontal groups only): wrap (default) breaks
     *  measured rows; collapse folds the overflow tail into a
     *  DropdownMenu behind the ⋯ trigger; scroll (2026-09-04, the
     *  third mode) rides a scroll run — the root becomes the
     *  scroller (hidden scrollbar, smooth, proximity snap) and the
     *  joined line never breaks; pair with scrollEffect for the edge
     *  treatments. A VERTICAL group declaring scroll rides the SAME
     *  contract on the block axis (round 2: the shared chrome is
     *  axis-aware — chips against the top/bottom edges, the veil
     *  pair re-aimed) */
    overflow?: 'wrap' | 'collapse' | 'scroll';
    /** edge treatment while overflow='scroll' scrolls — built by
     *  ramp() (the one member-ramp builder: opacity/blur/translate
     *  toggles, all default on; ramp({ blur: false }) is the cheapest
     *  posture) / shadow() / progressBlur() (the tabs scrollEffect
     *  convention). Inert outside scroll mode */
    scrollEffect?: ButtonGroupScrollEffect;
    /** accessible name of the collapse trigger (aria-label + tooltip) */
    moreLabel?: string;
    /** density policy: explicit, inherited, then default — provided
        to the subtree so the joined buttons adopt the tier */
    density?: Density;
    'data-density'?: string;
    /** the group role — the law. An explicit consumer override
        (labeled toolbar) is honored, never defaulted */
    role?: string;
    class?: string;
    children: Snippet;
  }

  // $props.id() must live in its own top-level initializer (compiler law)
  const menuId = $props.id();

  let {
    orientation = 'horizontal',
    justify = 'start',
    label,
    variant,
    raised,
    separator,
    leadingSeam = false,
    overflow: overflowMode = 'wrap',
    scrollEffect = ramp(),
    moreLabel = 'more actions',
    density,
    'data-density': _callerDensity,
    role = 'group',
    class: className = '',
    'aria-label': ariaLabel,
    children,
    ...rest
  }: Props = $props();

  // ---- the density lane: inherit-then-provide, boundary-legal ------
  // The CAPTURE is load-bearing and eager: getDensityContext() rides
  // the $derived.by ARGUMENT subtree, which evaluates at this
  // statement — BEFORE provideDensity writes the key — so it captures
  // the PARENT's context object. A lazily-evaluated read (a plain
  // $derived initializer body, or the getter itself) would resolve
  // the key to the group's OWN write and self-reference through the
  // very getter it feeds — derived_references_self, pinned in
  // defaults-buttons.spec. The returned getter reads ONLY the
  // captured object (reactive through its getters, never re-entering
  // the context machinery)
  const resolvedDensity = $derived.by(
    ((inherited) => () => resolveDensity(density, inherited))(getDensityContext()),
  );
  provideDensity(() => resolvedDensity);

  // INHERIT-THEN-PROVIDE (r14 tuning 2, the density maneuver): a group
  // with no variant of its own passes the enclosing zone's through —
  // a ghost-scoped dialog footer's button group stays ghost without
  // repeating itself; a group that sets one shadows the zone. ONE
  // lane since the single-key law (Owner 2026-09-04): the eager
  // capture reads the PARENT paint zone (getPaintZone, the
  // getDensityContext precedent) — the getContext runs at this
  // statement, before this group's own providePaintZone write below
  // shadows the parent on the key; the domain is ZonePaintVariant
  // end to end, 'link' never had a zone lane
  const effectiveVariant = $derived.by(
    ((enclosing) => () => variant ?? enclosing?.variant)(getPaintZone()),
  );

  // The family Defaults rides ON TOP of the provider lane as the
  // group's single read point (its own stamp — the audited ambient
  // face): the density slot's ambient read resolves the key to the
  // group's own write, whose getter is the captured-parent
  // resolution above, so the chain TERMINATES (it never re-enters
  // this derived) and lands the same values on every lane. The
  // VARIANT slot is declaration-first (button-group-defaults.svelte.
  // ts): the group's own inherit-then-provide keeps the legacy lane
  // by the frozen provider duties, so only density flows through the
  // contract today
  const d = $derived(ButtonGroupDefaults.resolve({ density }));

  // ── THE PHYSICS TAKEOVER (Owner 2026-09-04, the cluster-shadow
  // law) — the joined subtree rides FLAT by default: per-button
  // convex shadows overlap at the -1px seams, so the group scopes the
  // press texture through the PHYSICS key (the same zero-DOM boundary
  // the variant rides; an explicit raised on any child still wins).
  // BOTH context captures run HERE, eagerly — ABOVE this group's own
  // BUTTON_GROUP_KEY and PRESS_TEXTURE_KEY writes, or they would
  // resolve to the group's OWN contexts and every top-level group
  // would mistake itself for a nested one (the getPaintZone
  // precedent, extended to the layout key). The layout-key read
  // ride the $derived.by ARGUMENT subtree — the A3-blessed shape
  // (the getDensityContext precedent, same capture discipline): the
  // getContext evaluates at this statement, before the write; the
  // derived's value IS the captured object (the evaluator thunk
  // holds no reactive deps, so it never re-runs — a re-run would
  // re-enter the context machinery after the own write and
  // self-reference)
  const enclosingTexture = getContext<PressTextureApi | undefined>(PRESS_TEXTURE_KEY);
  const enclosingGroup = $derived.by(
    ((enclosing) => () => enclosing)(getContext<ButtonGroupApi | undefined>(BUTTON_GROUP_KEY)),
  );
  setContext<PressTextureApi>(PRESS_TEXTURE_KEY, {
    get raised() {
      return false;
    },
  });
  // the ROOT's own shadow: explicit ?? the enclosing texture zone (a
  // card/dialog foot's flat scope carries through) ?? the top-level
  // convex default — NESTED groups default OFF: the inner cluster is
  // one member of the OUTER one, and one control casts one shadow
  const clusterRaised = $derived(raised ?? enclosingTexture?.raised ?? !enclosingGroup);

  // the separator policy: explicit prop, else the ghost default —
  // the borderless row has no seam to collapse, so the separator IS
  // its seam. Keys off the EFFECTIVE variant (r14-10, Owner: the
  // inherited ghost counts — a DialogFooter group under the dialog
  // zone's ghost scope got no seams because this keyed the LOCAL prop
  // alone; per-child explicit variants may still override paint, the
  // seam policy stays uniform)
  const separatorOn = $derived(separator ?? effectiveVariant === 'ghost');
  setContext<ButtonGroupApi>(BUTTON_GROUP_KEY, {
    get orientation() {
      return orientation;
    },
    get separator() {
      return separatorOn;
    },
  });

  // the paint axis's one key: the zone value domain is link-EXCLUDED
  // at the type (the prop and the zone getter are both
  // ZonePaintVariant) — no runtime narrowing lane exists
  providePaintZone(() => effectiveVariant);

  const justifyClass = $derived(
    orientation === 'vertical'
      ? justify === 'center'
        ? 'content-center'
        : justify === 'end'
          ? 'content-end'
          : 'content-start'
      : justify === 'center'
        ? 'justify-center'
        : justify === 'end'
          ? 'justify-end'
          : 'justify-start',
  );

  // ── THE REAL-DOM SEAMS (Owner, 2026-09-04: "我更希望上真正的 DOM
  // 来做分割线") ─────────────────────────────────────────────────────
  // The separators are REAL elements the group owns — the leading seam
  // declaratively (markup), the inter-button seams injected here. The
  // children snippet is opaque: neither Svelte nor CSS can interleave
  // into it, the DOM can. IDEMPOTENT BY BOX: every pass reconciles
  // DIFFERENTIALLY (add the missing seams, remove the stale ones —
  // never nuke-and-rebuild), because the REAL-DOM seams have layout
  // footprint: a clear+reinsert cycle churns the group's box, re-fires
  // the ResizeObserver, and loops the measurement forever (the pseudo
  // era was box-idempotent for free; the DOM era must EARN it). It
  // rides the existing measurement contract: mount, ResizeObserver,
  // and the consumer's remeasure() for dynamic children — no new
  // observers.
  function syncSeps(): void {
    const el = groupEl;
    if (!el) return;
    const leading = el.querySelector(':scope > [data-jx-btngroup-sep]:not([data-jx-injected])');
    if (!separatorOn) {
      // policy off: nothing paints — the declarative leader is absent
      // by markup, the injected set is removed, any stray placement dies
      for (const s of el.querySelectorAll(':scope > [data-jx-btngroup-sep][data-jx-injected]')) {
        s.remove();
      }
      leading?.style.removeProperty('grid-row');
      leading?.style.removeProperty('grid-column');
      return;
    }
    // the seam audience: VISIBLE direct children (the measurement
    // filter's seam face — the collapse-hidden tails and the group's
    // own chrome never join; in the collapse state the ⋯ trigger is
    // a visible row member and carries the seam like any button)
    const moreVisible = el.getAttribute('data-jx-overflow') === 'collapse' && moreEl !== null;
    const kids = [...el.children].filter(
      (c): c is HTMLElement =>
        c instanceof HTMLElement &&
        !c.hasAttribute('popover') &&
        c !== moreEl &&
        !c.hasAttribute('data-jx-btngroup-sep') &&
        c.getAttribute('data-jx-overflow-hidden') !== 'true',
    );
    const seamRow = moreVisible && moreEl ? [...kids, moreEl] : kids;
    // the DESIRED set: a seam before each kid that HAS an inline-start
    // neighbor, is not a row LEAD (wrap state), and does not sit at a
    // DIVIDER junction (that junction already has its line)
    const wants = new Set<HTMLElement>();
    let prev: HTMLElement | null = null;
    for (const kid of seamRow) {
      const lead = kid.hasAttribute('data-jx-row-start');
      const dividerJunction =
        (prev?.hasAttribute('data-jx-btngroup-divider') ?? false) ||
        kid.hasAttribute('data-jx-btngroup-divider');
      if (prev && !lead && !dividerJunction) wants.add(kid);
      prev = kid;
    }
    // reconcile: remove the stale, add the missing — the untouched
    // majority keeps its nodes (and the box) exactly where they were
    for (const s of el.querySelectorAll(':scope > [data-jx-btngroup-sep][data-jx-injected]')) {
      const host = s.nextElementSibling;
      if (!(host instanceof HTMLElement) || !wants.has(host)) s.remove();
      else wants.delete(host);
    }
    for (const host of wants) {
      const sep = document.createElement('span');
      sep.setAttribute('data-jx-btngroup-sep', '');
      sep.setAttribute('data-jx-injected', '');
      sep.setAttribute('aria-hidden', 'true');
      el.insertBefore(sep, host);
    }
    // the wrap state places every row member in an EXPLICIT cell, so
    // the seps carry placement too: kids ride the EVEN tracks (2c+2,
    // measured in measure()), a seam rides the track one step after
    // its inline-start neighbor — the leading seam one step BEFORE
    // the first kid. Outside the wrap state (the single line, the
    // vertical stack) the DOM order is the layout: no stamps needed
    if (el.getAttribute('data-jx-overflow') !== 'wrap') return;
    const place = (node: Element, row: string, col: string): void => {
      (node as HTMLElement).style.gridRow = row;
      (node as HTMLElement).style.gridColumn = col;
    };
    for (const sep of el.querySelectorAll(':scope > [data-jx-btngroup-sep]')) {
      let prevEl: Element | null = sep.previousElementSibling;
      while (prevEl && (prevEl.hasAttribute('data-jx-btngroup-sep') || prevEl.getAttribute('data-jx-overflow-hidden') === 'true')) {
        prevEl = prevEl.previousElementSibling;
      }
      let nextEl: Element | null = sep.nextElementSibling;
      while (nextEl && (nextEl.hasAttribute('data-jx-btngroup-sep') || nextEl.getAttribute('data-jx-overflow-hidden') === 'true')) {
        nextEl = nextEl.nextElementSibling;
      }
      if (!nextEl) continue;
      const nextRow = nextEl.style.gridRow;
      const nextCol = parseInt(nextEl.style.gridColumn, 10);
      if (!nextRow || !Number.isFinite(nextCol)) continue;
      place(sep, nextRow, prevEl ? String(parseInt(prevEl.style.gridColumn, 10) + 1 || nextCol - 1) : String(nextCol - 1));
    }
  }

  // ── THE OVERFLOW STATE MACHINE (r13) ─────────────────────────────────
  // measured, horizontal-only, hydration-time (the DOM-derived AUTO
  // exception to the SSR-complete family law: the static row IS the
  // complete SSR output; measurement only ever RE-breaks it). States:
  //   none      single row, no stamps (the static default)
  //   wrap      measured greedy rows (per-item cell placement)
  //   collapse  tail hidden into the menu, k buttons stay inline
  // Hysteresis: enter strict (needs > avail), leave with margin.
  const HYST = 8;
  /** a folded menu entry — either a real hidden control (label +
   *  element; activation clicks the REAL button) or a carried
   *  divider (rendered as the menu's plain hr) */
  interface FoldedEntry {
    readonly divider: boolean;
    readonly label: string;
    readonly el: HTMLElement | undefined;
  }

  let groupEl = $state<HTMLDivElement | null>(null);
  let moreEl = $state<HTMLElement | null>(null);
  let folded = $state<FoldedEntry[]>([]);
  // persistent across measures: the state + the last inline count
  // (hysteresis) + the last measured width (the RO re-entry guard)
  let ovState: 'none' | 'wrap' | 'collapse' = 'none';
  let inlineCount = Number.MAX_SAFE_INTEGER;
  let lastAvail = -1;

  /** re-run the overflow measurement by hand — the dynamic-children
   *  seam: ResizeObserver sees box changes, not a consumer swapping
   *  children at a constant width. Exported through bind:this;
   *  inert under overflow='scroll' (that mode owns no measurement) */
  export function remeasure(): void {
    if (groupEl && overflowMode !== 'scroll') measure(groupEl);
  }

  function measure(el: HTMLElement): void {
    const kids = [...el.children].filter(
      (c): c is HTMLElement =>
        c instanceof HTMLElement &&
        !c.hasAttribute('popover') &&
        c !== moreEl &&
        !c.hasAttribute('data-jx-btngroup-sep'),
    );
    if (kids.length === 0) {
      el.removeAttribute('data-jx-overflow');
      folded = [];
      ovState = 'none';
      syncSeps();
      return;
    }
    // ── THE PRE-FLIGHT GUARD (the DOM-era requirement): read the
    // CURRENT resting widths (kids' margin-boxes + the seams already
    // in the DOM) and settle WITHOUT TOUCHING ANYTHING when nothing
    // changes — a no-op pass that runs the measuring pose would churn
    // the box (the pose transiently clears the very seams and stamps
    // it re-applies), re-fire the observer, and never settle. The
    // pseudo era could afford pose-first; real DOM cannot
    // MARGIN-BOX, measured (Codex nB2): the -1px seam margins are
    // the seam law's, the divider's flush junction edges are the
    // divider law's, the trigger's own -1px seam belongs to the
    // trigger — the arithmetic never re-derives any of them, it
    // READS them, so the formulas and the layout engine cannot drift
    // apart (jsdom computes 0 margins: the css sheet never loads
    // there, and the math degrades to plain width sums)
    const box = (elm: HTMLElement): number => {
      const w = elm.getBoundingClientRect().width;
      const cs = getComputedStyle(elm);
      return w + (parseFloat(cs.marginInlineStart) || 0) + (parseFloat(cs.marginInlineEnd) || 0);
    };
    const avail = el.getBoundingClientRect().width;
    const restingNatural =
      kids.reduce((a, k) => a + box(k), 0) +
      el.querySelectorAll(':scope > [data-jx-btngroup-sep]').length;
    if (lastAvail === avail && ovState === 'none' && restingNatural <= avail + 0.5) {
      return; // the RO re-entry guard: same box, same line — idempotent
    }
    // 1) the measuring pose: everything visible, single line, seams
    // resolved — the transient stamp suspends the display flips, the
    // cleared placement lets each item report its NATURAL line width
    el.setAttribute('data-jx-measuring', '');
    el.removeAttribute('data-jx-overflow');
    for (const kid of kids) {
      // longhands, not the shorthand: jsdom's CSSOM does not clear
      // grid-row/grid-column through grid-area=''
      kid.style.gridRow = '';
      kid.style.gridColumn = '';
      kid.removeAttribute('data-jx-row-start');
      kid.removeAttribute('data-jx-overflow-hidden');
    }
    for (const sep of el.querySelectorAll(':scope > [data-jx-btngroup-sep]')) {
      (sep as HTMLElement).style.gridRow = '';
      (sep as HTMLElement).style.gridColumn = '';
    }
    // the REAL-DOM seams reconcile inside the pose: the single line
    // counts every 1px track the row will actually paint
    syncSeps();
    const boxes = kids.map(box);
    const moreBox = moreEl ? box(moreEl) : 0;
    // the REAL-DOM seam tracks are honest 1px columns — count them
    // (margin-free by law, so 1px each; the collapse-hidden junctions
    // have no sep in the DOM after the pose sync)
    const sepPx = el.querySelectorAll(':scope > [data-jx-btngroup-sep]').length;
    // 2) resolve — pure functions of (boxes, avail) with the
    // hysteresis margins on the transitions (the no-op settle case
    // already returned at the PRE-FLIGHT guard, before the pose)
    const natural = boxes.reduce((a, b) => a + b, 0) + sepPx;
    lastAvail = avail;
    if (ovState === 'none') {
      if (natural > avail + 0.5) ovState = overflowMode === 'collapse' ? 'collapse' : 'wrap';
    } else if (avail - natural >= HYST) {
      ovState = 'none'; // leave only with margin — resize jitter cannot flap
    }
    // 3) apply
    if (ovState === 'wrap') {
      el.setAttribute('data-jx-overflow', 'wrap');
      // greedy rows over margin-boxes; row leads reset the seam.
      // A divider that would OPEN a row stays on the previous row's
      // tail instead — it separates clusters, and a cluster boundary
      // at a row edge is a dangling 1px tick, not a lead
      const rows: number[][] = [[]];
      let acc = 0;
      kids.forEach((kid, i) => {
        const row = rows[rows.length - 1];
        const divider = kid.hasAttribute('data-jx-btngroup-divider');
        if (row.length > 0 && acc + boxes[i] > avail + 0.5) {
          if (divider) {
            row.push(i); // the boundary closes the previous cluster
            return;
          }
          rows.push([]);
          acc = 0;
        }
        acc += boxes[i];
        rows[rows.length - 1].push(i);
      });
      rows.forEach((row, r) =>
        row.forEach((i, c) => {
          kids[i].style.gridRow = `${r + 1}`;
          // EVEN tracks for the row members: the odd tracks between
          // them are the seam slots (syncSeps stamps those) — the
          // leading seam rides track 1 of the first row
          kids[i].style.gridColumn = `${2 * c + 2}`;
          if (c === 0) kids[i].setAttribute('data-jx-row-start', '');
        }),
      );
      folded = [];
      syncSeps();
    } else if (ovState === 'collapse') {
      // the largest k with prefix margin-boxes + the trigger's own
      // margin-box ≤ avail; k ≥ 1 (a group reduced to only ⋯ loses
      // its identity — it overflows instead). Growth is gated by HYST.
      const needed = (k: number): number =>
        boxes.slice(0, k).reduce((a, b) => a + b, 0) + moreBox;
      let k = Math.min(inlineCount, kids.length);
      while (k < kids.length && needed(k + 1) + HYST <= avail) k++;
      while (k > 1 && needed(k) > avail) k--;
      inlineCount = k;
      if (k >= kids.length) {
        // everything fits inline after all — the trigger never shows
        ovState = 'none';
        folded = [];
      } else {
        el.setAttribute('data-jx-overflow', 'collapse');
        // divider-aware folding: a divider with a hidden inline-start
        // neighbor is a dangling seam — it folds with it
        let prevHidden = false;
        const entries: FoldedEntry[] = [];
        kids.forEach((kid, i) => {
          const isDivider = kid.hasAttribute('data-jx-btngroup-divider');
          const hide = isDivider ? prevHidden : i >= k;
          if (hide) kid.setAttribute('data-jx-overflow-hidden', 'true');
          if (!isDivider) prevHidden = i >= k;
          if (i >= k) {
            entries.push(
              isDivider
                ? { divider: true, label: '', el: undefined }
                : {
                    divider: false,
                    label:
                      kid.getAttribute('aria-label') ??
                      kid.textContent?.trim() ??
                      'action',
                    el: kid,
                  },
            );
          }
        });
        // a leading/trailing folded divider has nothing to separate
        while (entries.length > 0 && entries[0].divider) entries.shift();
        while (entries.length > 0 && entries[entries.length - 1].divider) entries.pop();
        folded = entries;
      }
      syncSeps();
    } else {
      el.removeAttribute('data-jx-overflow');
      folded = [];
      inlineCount = Number.MAX_SAFE_INTEGER;
      syncSeps();
    }
    el.removeAttribute('data-jx-measuring');
  }

  $effect(() => {
    // orientation/mode/policy are read here: flips re-run the whole
    // machine. scroll mode is EXEMPT: the run scrolls by css, no
    // measurement ever flips its state (the scroll effect owns it)
    separatorOn;
    if (!groupEl || orientation !== 'horizontal' || overflowMode === 'scroll') return;
    if (typeof ResizeObserver === 'undefined') {
      syncSeps(); // the static path: no measurement ever runs, but the seams are real DOM — they still join the visible line
      return;
    }
    const el = groupEl;
    const ro = new ResizeObserver(() => measure(el));
    ro.observe(el);
    measure(el);
    return () => ro.disconnect();
  });

  // the vertical stack never measures (wrap/collapse are horizontal
  // machines; a vertical group's block axis is the scroll container's
  // business — its own, under overflow='scroll'): its seams sync on
  // mount and on policy flips alone, DOM order being their layout
  $effect(() => {
    separatorOn;
    if (!groupEl || orientation !== 'vertical') return;
    syncSeps();
  });

  // ── THE SCROLL RUN (Owner 2026-09-04, the third overflow mode) —
  // the machine is the SHARED scroll-run item (one set for every
  // scrollable region): createScrollStamp owns the verdict
  // (data-jx-scroll-state), the host's --jx-scroll-progress and the
  // per-member --jx-edge-* factors — scroll/resize/font/wake listeners
  // inside. NO measurement machine here — css scrolls the joined line
  // naturally; wrap/collapse stay this family's own machines
  const isScroll = $derived(overflowMode === 'scroll');
  /** the full chrome (host overlays, effects, chips) rides BOTH axes —
   *  the shared system is axis-aware (round 2): a vertical scroll
   *  group gets its chips against the block edges, the veil pair
   *  re-aimed, the same verdict law */
  const scrollChrome = $derived(isScroll);
  let hostEl = $state<HTMLDivElement | null>(null);

  $effect(() => {
    separatorOn;
    scrollEffect.type;
    const run = groupEl;
    if (!run || !isScroll) return;
    syncSeps(); // the seams join the single scrolling line
    if (!scrollChrome) return;
    // the ramp audience: every VISIBLE painted member — the buttons
    // AND the separators (the ramp css keys `> *`; an un-stamped seam
    // would float at full opacity between its fading neighbors)
    const stamp = createScrollStamp({
      run,
      host: hostEl,
      members: () =>
        [...run.children].filter(
          (c): c is HTMLElement =>
            c instanceof HTMLElement &&
            !c.hasAttribute('popover') &&
            c !== moreEl &&
            c.getAttribute('data-jx-overflow-hidden') !== 'true',
        ),
      ramps:
        scrollEffect.type === 'ramp',
    });
    return () => stamp.destroy();
  });

  /** the effect knobs ride the HOST inline (the overlays are the run's
   *  siblings — a var on the run never reaches them); a width knob
   *  overrides the band default (the shared --jx-scroll-* names) */
  const hostStyle = $derived.by(() => {
    if (!scrollChrome) return undefined;
    const parts: string[] = [];
    switch (scrollEffect.type) {
      case 'ramp':
        // round 3: the ramp's magnitudes are CHROME-OWNED (ScrollChrome
        // stamps --jx-scroll-edge-slide/blur on the run from the
        // builder's distance/radius) — the host carries no edge vars
        break;
      case 'shadow':
      case 'progressBlur':
        if (scrollEffect.width) parts.push(`--jx-scroll-veil: ${scrollEffect.width}`);
        break;
    }
    return parts.join('; ') || undefined;
  });


  // the trigger names its panel for AT (aria-haspopup describes the
  // popovertarget's menu — the composer owns this glue; the menu root
  // adopts the button for aria-expanded + focus restoration itself)
  $effect(() => {
    moreEl?.querySelector('button[popovertarget]')?.setAttribute('aria-haspopup', 'menu');
  });

  /** selection clicks the hidden REAL button — one microtask later,
   *  so the menu's own close-and-restore (the selection contract:
   *  focus back to the trigger) settles first. The platform
   *  light-dismisses auto popovers on POINTERDOWN, never on a
   *  synthetic click, so ordering the proxied click after the close
   *  keeps the two paths disjoint in every engine */
  function activate(entry: FoldedEntry): void {
    const el = entry.el;
    if (el) queueMicrotask(() => el.click());
  }
</script>

{#snippet runRoot()}
  <div
    {...rest}
    {role}
    data-jx-btngroup={orientation}
    data-jx-scroll-run={isScroll ? '' : undefined}
    data-axis={isScroll ? orientation : undefined}
    data-jx-btngroup-flat={!clusterRaised ? '' : undefined}
    data-jx-separator={separatorOn ? '' : undefined}
    data-jx-leading-seam={leadingSeam ? '' : undefined}
    data-density={d.density}
    aria-label={ariaLabel ?? label}
    bind:this={groupEl}
    class={cn(
      'inline-grid max-w-full',
      // the flow law (see header): no-template flow COLUMN grows the
      // one implicit ROW with columns (the horizontal line); flow row
      // (the default) grows the one implicit COLUMN with rows (the
      // vertical stack) — pinned on Chromium, see the r13 rework probe
      orientation === 'vertical' ? 'grid-flow-row auto-rows-auto items-stretch' : 'grid-flow-col auto-cols-auto items-stretch',
      justifyClass,
      className,
    )}
  >
    {#if leadingSeam && separatorOn}
      <!-- THE LEADING SEAM, declarative: a REAL element the group owns,
           its own first child — flush by construction (inside the group
           no parent gap can detach it; the css paints the ink) -->
      <span data-jx-btngroup-sep aria-hidden="true"></span>
    {/if}
    {@render children()}
    {#if overflowMode === 'collapse'}
      <!-- the收纳 trigger: hidden until the collapse state stamps it
           visible (button-group.css); an icon-only IconButton carrying
           the native popovertarget invoker — the group context reaches
           it too, so a ghost group gets a ghost ⋯ -->
      <span bind:this={moreEl} data-jx-btngroup-more class="inline-flex">
        <DropdownMenu id={menuId} placement="bottom-end">
          {#snippet trigger()}
            <IconButton iconOnly text={moreLabel} popovertarget={menuId}>
              {#snippet icon()}<Icon name="ellipsis" />{/snippet}
            </IconButton>
          {/snippet}
          {#each folded as entry, i (i)}
            {#if entry.divider}
              <hr />
            {:else if entry.el}
              <DropdownMenuItem onclick={() => activate(entry)}>{entry.label}</DropdownMenuItem>
            {/if}
          {/each}
        </DropdownMenu>
      </span>
    {/if}
  </div>
{/snippet}

{#if scrollChrome}
  <!-- THE SCROLL HOST (the shared one-cell grid law): children of a
       scroller scroll with its content, so the overlays mount on this
       non-scrolling host — the run (base), the veil layer (z 1) and
       the chevron chips (z 2) stack in one grid cell; grid-area +
       z-index only, never position:*. The chrome (veils + chips) is
       the SHARED ScrollChrome component — scroll-chrome.svelte, the
       paint laws in scroll-run.css -->
  <div
    bind:this={hostEl}
    data-jx-btngroup-host=""
    class="jx-scroll-host inline-grid max-w-full [grid-template-columns:minmax(0,1fr)]"
    style={hostStyle}
  >
    {@render runRoot()}
    <ScrollChrome
      {scrollEffect}
      run={groupEl}
      backwardLabel="Scroll actions backward"
      forwardLabel="Scroll actions forward"
    />
  </div>
{:else}
  {@render runRoot()}
{/if}
