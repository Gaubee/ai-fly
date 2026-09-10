<!--
  jixoai card-header (registry/files/ui/card/card-header.svelte).

  The head band's CONTENT face (the dialog-header r14-9 clone): the
  ruler carrier (the Card root, a Dialog's interior) owns the zones,
  the snippet transports, and the action slot; this component owns
  what the head SHOWS.

  Two faces over one content column:
    title     the default head face (h2, the block-rhythmed title row)
    children  custom head content at the content axis — the inline
              inset arrives from the ruler's TRACKS (the face carries
              no inline utilities either way); custom content owns
              its own block geometry. children present ⇒ title
              yields.

  THE INLINE RULER (Owner, 2026-09-03 r2): the face ENTERS at the
  content lines — its horizontal padding is the ruler's inset track,
  not a utility (dialog-header's px-3.5 painted the same 14px by
  hand; the track paints it by law). Only the block rhythm stays on
  the face: py-2.5, dialog-verbatim.

  STANDALONE (card-surface-kernel, 2026-09-09): outside a head band
  the wrapper (.jx-card-head-face, card.css) carries its OWN mirror
  of the ruler's five tracks — the card-footer precedent's "one
  geometry, two carriers" (the rental is the source of truth, the
  mirror serves the standalone context); inside a band the wrapper
  dissolves (display: contents) and the face places against the
  rented lines. Dialog's interior uses the rented path — its
  skeleton stamps data-jx-card-head (card-surface-kernel T3).

  The action slot does NOT live here: it and its edge-riding column
  are the carrier's head architecture (the actions snippet renders
  beside whatever face is showing).
-->
<script lang="ts">
  import type { Snippet } from 'svelte';

  interface Props {
    /** Heading of the default title row; yields to children when given. */
    title?: string;
    /** Custom head content — enters at the content axis, owns its
        own block geometry. */
    children?: Snippet;
    /** Appended to the face (cn-less string concat, the family
        precedent): the flush escape hatch for search-field heads —
        `class="col-start-1"` pins the face's column START to the
        grid's first line (flush past the inset track) while the ×
        seat keeps its own column on the same row; a col-span-full
        would push the auto-placed seat to a second row (probed —
        the review catch). */
    class?: string;
  }

  let { title, children, class: className = '' }: Props = $props();
</script>

<div class="jx-card-head-face">
  <div class="jx-card-head-content {children ? '' : 'py-2.5'}{className ? ` ${className}` : ''}">
    {#if children}
      {@render children()}
    {:else if title}
      <h2 data-jx-card-title class="font-nav text-[15px] leading-[1.3] tracking-[0.01em]">{title}</h2>
    {:else}
      <!-- untitled + contentless: keep the grid's content column honest
           (the action slot still renders beside it) -->
      <span data-jx-card-title aria-hidden="true"></span>
    {/if}
  </div>
</div>
