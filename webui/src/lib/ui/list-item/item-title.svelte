<!--
  jixoai ItemTitle — the primary line of ItemContent. Heading level is
  the consumer's choice (default span; pass `as` for semantic nesting).
  Rest attributes are forwarded (id first-class: field labels point at
  this node via aria-labelledby/label[for]).
-->
<script lang="ts">
  import type { Snippet } from 'svelte';
  import type { HTMLAttributes } from 'svelte/elements';
  import { cn } from '$lib/utils';

  interface Props extends HTMLAttributes<HTMLElement> {
    as?: 'span' | 'h3' | 'h4' | 'dt';
    class?: string;
    children: Snippet;
  }

  let { as = 'span', class: className = '', children, ...rest }: Props = $props();
</script>

<svelte:element this={as} {...rest} data-slot="item-title" class={cn(className)}>{@render children()}</svelte:element>
