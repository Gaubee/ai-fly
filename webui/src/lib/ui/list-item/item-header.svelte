<!--
  jixoai ItemHeader — an optional FULL-ROW slot above the main row
  (labels, meta strips). Presence rewrites the grid template.
-->
<script lang="ts">
  import type { Snippet } from 'svelte';
  import type { HTMLAttributes } from 'svelte/elements';
  import { cn } from '$lib/utils';

  interface Props extends HTMLAttributes<HTMLDivElement> {
    class?: string;
    children: Snippet;
  }

  let { class: className = '', children, ...rest }: Props = $props();
</script>

<div {...rest} data-slot="item-header" class={cn(className)}>{@render children()}</div>
