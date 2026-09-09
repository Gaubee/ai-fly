<!--
  jixoai card-header (registry/files/ui/card/card-header.svelte).

  The head zone's CONTENT face (the dialog-header r14-9 clone): Card
  owns the zones, the snippet transports, and the action slot; this
  component owns what the head SHOWS.

  Two faces over one content column:
    title     the default head face (h2, the block-rhythmed title row)
    children  custom head content at the content axis — the inline
              inset arrives from the root's ruler TRACKS (the face
              carries no inline utilities either way); custom content
              owns its own block geometry. children present ⇒ title
              yields.

  The INLINE RULER (Owner, 2026-09-03 r2): the face ENTERS at the
  card's content lines — its horizontal padding is the ruler's inset
  track, not a utility (dialog-header's px-3.5 painted the same 14px
  by hand; here the track paints it by law). Only the block rhythm
  stays on the face: py-2.5, dialog-verbatim.

  The action slot does NOT live here: it and its edge-riding column
  are Card's head architecture (the actions snippet renders beside
  whatever face is showing).
-->
<script lang="ts">
  import type { Snippet } from 'svelte';

  interface Props {
    /** Heading of the default title row; yields to children when given. */
    title?: string;
    /** Custom head content — enters at the content axis, owns its
        own block geometry. */
    children?: Snippet;
  }

  let { title, children }: Props = $props();
</script>

<div class="jx-card-head-content {children ? '' : 'py-2.5'}">
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
