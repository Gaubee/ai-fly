<!--
  jixoai card body (registry/files/ui/card/card-body.svelte,
  card-surface-kernel 2026-09-09).

  The body band's structural face — extracted from Card's inline body
  (card.svelte) into the family part so every ruler carrier (the planar
  Card root, a Dialog's interior, any sticker-wearing host) composes
  the same body: ONE scroll law, ONE gutter-compensation formula.

  THE SCROLL LAW (card.css, the grid-tenant edition): the CARD (or any
  sticker host) never scrolls — the BAND is a plain track occupant (a
  scroll-container band would collapse its rented row to zero), and
  the CELL is the ring: max-height 100% + overflow-y auto + a stable
  both-edges gutter (no visual off-centering under classic scrollbars).

  THE INLINE FORMULA (single-sourced here, 2026-09-09): the cell's
  inline padding is the gutter compensation — max(0.875rem − probed
  thin, 0) keeps the visual inset at the authored 14px whatever the
  scrollbar width; overlay-scrollbar systems probe 0 and keep it
  whole. The dialog's former verbatim copy of this formula retired
  with its own body zone (card-surface-kernel T3).

    <CardBody scroll={false}> …fits-without-scrolling content… </CardBody>

  scroll=false is the declared assertion the body FITS: the scroll
  authority and the gutter reservation retire together (card.css
  keys both off data-jx-scroll='off' — an asserted overflow still
  paints honestly).
-->
<script lang="ts">
  import type { Snippet } from 'svelte';

  interface Props {
    /** The band's scroll authority (the host never scrolls). DEFAULT
        on: the cell is the ring with a stable both-edges gutter.
        Declare false to assert the body fits — the authority and the
        gutter reservation retire together. */
    scroll?: boolean;
    /** Appended to the cell (cn-less string concat, the family
        precedent) — the RHYTHM escape hatch: carriers with a tighter
        or looser beat than the kernel default (sheet's 18px drawer
        rhythm) override the cell padding utilities here. */
    class?: string;
    /** Body content — enters at the cell's content axis. */
    children: Snippet;
  }

  let { scroll = true, class: className = '', children }: Props = $props();
</script>

<div data-jx-card-body data-jx-scroll={scroll ? undefined : 'off'}>
  <div
    data-jx-card-cell
    class="min-w-0 py-3.5 px-[max(0.875rem-var(--jx-scrollbar-thin,0px),0px)] text-[13px] leading-[1.6] text-[color-mix(in_oklab,var(--card-foreground)_80%,transparent)]{className ? ` ${className}` : ''}"
  >
    {@render children()}
  </div>
</div>
