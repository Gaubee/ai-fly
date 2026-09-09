<!--
  jixoai dialog-header (registry/files/ui/dialog/dialog-header.svelte).

  The head zone's CONTENT face (r14-9, Owner correction): the footer's
  slot architecture belongs to the footer region itself, carried by a
  component — and the header gets the symmetric answer. Dialog owns the
  zones, the snippet transports, and the × close contract; this
  component owns what the head SHOWS.

  Two faces over one content column:
    title     the default title row (h2, the padded chrome bar)
    children  custom head content, FLUSH edge-to-edge — the snippet's
              content owns its own geometry (the search palette's Input
              is the canonical consumer: its shell is the row's height
              and padding). children present ⇒ title yields.

  The × button does NOT live here: it and its inline-end-action-slot
  are Dialog's head architecture (every head keeps a close affordance —
  a custom head gets it for free, no context plumbing, no circular
  imports). Dialog renders this component internally for the untitled
  default face, so the title row has exactly one source.
-->
<script lang="ts">
  import type { Snippet } from 'svelte';

  interface Props {
    /** Heading of the default title row; yields to children when given. */
    title?: string;
    /** Custom head content, flush — owns its own geometry. */
    children?: Snippet;
  }

  let { title, children }: Props = $props();
</script>

<div class="jx-dialog-head-content {children ? '' : 'px-3.5 py-2.5'}">
  {#if children}
    {@render children()}
  {:else if title}
    <h2 data-jx-dialog-title="" class="font-nav text-[15px] leading-[1.3] tracking-[0.01em]">{title}</h2>
  {:else}
    <!-- untitled + contentless: keep the grid's content column honest
         (the × slot still renders — the close contract) -->
    <span data-jx-dialog-title="" aria-hidden="true"></span>
  {/if}
</div>
