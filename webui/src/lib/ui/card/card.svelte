<!--
  jixoai card (registry/files/ui/card/card.svelte).

  THE STRUCTURAL SURFACE (Owner, 2026-09-03): the dialog's row ruler
  cloned as a static surface — the zones, the stamped presence, the
  scroll law, and the content faces (<CardHeader> / <CardFooter>).
  What stayed with the modal: the <dialog> platform, the backdrop,
  the WAAPI motion, focus/top-layer, and the × close contract. The
  top-right inline-end-action-slot is an OPEN SNIPPET (`actions`)
  instead — the seat Dialog's × is designed to occupy when Dialog is
  refactored onto Card; here it is the consumer's own affordance.

  HONEST HEAD (the one deliberate divergence from dialog's structural
  head): dialog's head zone is unconditional because the × lives in
  it; a card with neither `title` nor a `head` snippet renders NO
  head zone and NO head separator — presence is resolved in the
  component and STAMPED (data-sep-head / data-sep-foot; css paints
  stamps only, never infers from descendants). The foot zone exists
  iff the `foot` snippet is passed — the r14-9 single-transport law:
  using it means owning everything the foot shows; the standard face
  is <CardFooter> (start slot / auto button group / raw end slot).

  ZONES vs CONTENT (the r14-9 clone): Card keeps the zones and the
  snippet transports; the content faces are composition. The ghost
  variant scopes over head and foot are zone defaults (Context, no
  DOM) — an explicit button variant always wins.

  THE INLINE RULER (Owner, 2026-09-03 r2: "jx-card-foot-start 这里
  如果要放文字，是要有 padding 的…buttons 在内部使用了 padding…
  升级成 grid+subgrid。请从设计师的角度出发"): the root owns FIVE
  named column tracks (card.css); the head/foot zones RENT them via
  subgrid — the same tenancy law the card obeys inside card-grid,
  applied to its own inline axis. Passive content ENTERS at the
  content lines (the 14px card inset arrives BY TRACK — the head
  title face and the foot text seats carry no inline utilities);
  interactive clusters (the actions slot, the footer ButtonGroup)
  SPAN the inset track to ride the card edge flush — dialog's
  footer buttons carry the rhythm internally (measured: 40px tall,
  padding 0 12px). The body zone stays full-bleed: its scroll ring
  owns the gutter-compensating inline formula verbatim (a dynamic
  scrollbar width is invisible to tracks). Block laws (Owner r3+r4):
  the head face py-2.5 (the title row's own band, ≈40px); the foot
  band belongs to its residents — text RIDES centered and never
  sizes the row (no padding-block on seats), while the cluster is
  a CARVED CELL that fills the band vertically (its buttons'
  min-h-[--jx-hit] economy is a floor, never a cap — a floating
  40px button in a taller band reads as a hole dug out, not a cell
  cut out). The head's action slot stays a CORNER (align-self:
  start, dialog's × verbatim) — only the foot carves.

  GRID TENANT (card-grid): the zones place by INTEGER cell lines
  (card.css), so the card qualifies as a card-grid child unchanged —
  default two-row mode equalizes head/body; `<CardGrid foot>` adds
  the third shared row for footed cards (feet align at band bottoms).
  In-grid cards should carry a head (a headless card leaves the
  shared head row to its siblings).
-->
<script lang="ts">
  import type { Snippet } from 'svelte';
  import Separator from '$lib/ui/separator/separator.svelte';
  import ButtonVariantScope from '$lib/ui/button-group/button-variant-scope.svelte';
  import CardHeader from './card-header.svelte';
  import './card.css';

  interface Props {
    /** Heading of the default head face; omit (with no head snippet)
        for a chrome-less body card — the head zone never renders. */
    title?: string;
    /** Replaces the visible head face, flush edge-to-edge — the
        snippet owns the row's geometry (typically wraps content in
        <CardHeader>). The actions slot still rides the head grid. */
    head?: Snippet;
    /** The inline-end action slot's content — the top-right seat
        (dialog's × position). Absent, the slot never renders; no
        close button ships with the card. */
    actions?: Snippet;
    /** The RAW full override of the foot zone (the r14-9 transport):
        using it means owning everything the foot shows — the standard
        face is <CardFooter>. */
    foot?: Snippet;
    /** The body zone's scroll authority (the card itself never
        scrolls). DEFAULT on: the zone is the ring with a stable
        both-edges gutter. Declare false to assert the body fits —
        the authority and the gutter reservation retire together. */
    scroll?: boolean;
    /** Root utilities appended AFTER the law's own. */
    class?: string;
    /** Card body. */
    children: Snippet;
  }

  let { title, head, actions, foot, scroll = true, class: className = '', children }: Props =
    $props();

  // Presence resolution (the stamped-attribute painting law)
  const hasHead = $derived(head !== undefined || title !== undefined);
  const hasFoot = $derived(foot !== undefined);
</script>

<section
  data-jx-card
  data-sep-head={hasHead ? '' : undefined}
  data-sep-foot={hasFoot ? '' : undefined}
  class="border border-border bg-card shadow-2xs {className}"
>
  {#if hasHead}
    <!-- the head zone RENTS the root's inline ruler (subgrid columns,
         card.css): the content face enters at the content lines, the
         actions slot spans the end inset to hug the top-right corner
         flush. The ghost scope is the zone's button default -->
    <div data-jx-card-head>
      <ButtonVariantScope variant="ghost">
        {#if head}
          {@render head()}
        {:else}
          <CardHeader {title} />
        {/if}
        {#if actions}
          <div class="jx-card-end-action-slot">
            {@render actions()}
          </div>
        {/if}
      </ButtonVariantScope>
    </div>
    <!-- the dividing lines are Separator INSTANCES edge-riding their
         zone rows (card.css), spanning edge-to-edge; decorative
         chrome, hidden from AT -->
    <Separator data-jx-card-sep="head" aria-hidden="true" />
  {/if}
  <div data-jx-card-body data-jx-scroll={scroll ? undefined : 'off'}>
    <!-- the CELL is the scroll ring (card.css — the zone stays a plain
         track occupant: a scroll-container subgrid tenant collapses
         its rented row to zero). Its inline padding is the dialog
         cell's VERBATIM gutter compensation: max(0.875rem − probed
         thin, 0) keeps the visual inset at the authored 14px;
         overlay-scrollbar systems probe 0 and keep it whole -->
    <div
      data-jx-card-cell
      class="min-w-0 py-3.5 px-[max(0.875rem-var(--jx-scrollbar-thin,0px),0px)] text-[13px] leading-[1.6] text-[color-mix(in_oklab,var(--card-foreground)_80%,transparent)]"
    >
      {@render children()}
    </div>
  </div>
  {#if hasFoot}
    <Separator data-jx-card-sep="foot" aria-hidden="true" />
    <!-- THE RAW FOOT ZONE: the foot snippet overrides everything —
         no grouping from Card. The standard face is <CardFooter>;
         the ghost scope stays the zone's default, and the foot rides
         the FLAT texture (Owner 2026-09-04): raised=false scopes the
         physics default — foot buttons press as engrave-tier insets,
         an explicit raised still wins. The zone RENTS the
         root's inline ruler (subgrid columns, card.css) — the seats
         inside place against the rented lines. The jx-card reversal
         container lives on the ROOT (card.css), never on the zone:
         a tenant never carries container-type (the measured law) -->
    <div data-jx-card-foot>
      <ButtonVariantScope variant="ghost" raised={false}>
        {@render foot()}
      </ButtonVariantScope>
    </div>
  {/if}
</section>
