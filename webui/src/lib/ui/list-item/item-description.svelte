<!--
  jixoai ItemDescription — the muted secondary line of ItemContent.
  Rest attributes are forwarded (id first-class for describedby chains).
-->
<script lang="ts">
  import type { Snippet } from 'svelte';
  import type { HTMLAttributes } from 'svelte/elements';
  import { cn } from '$lib/utils';

  interface Props extends HTMLAttributes<HTMLElement> {
    as?: 'span' | 'p' | 'dd';
    class?: string;
    children: Snippet;
  }

  let { as = 'span', class: className = '', children, ...rest }: Props = $props();
</script>

<svelte:element this={as} {...rest} data-slot="item-description" class={cn(className)}>{@render children()}</svelte:element>
