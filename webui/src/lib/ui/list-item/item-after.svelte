<!--
  jixoai ItemAfter — non-interactive trailing metadata inside ItemEnd
  (counts, timestamps, shortcuts). NEVER receives button/link
  semantics; interactive tails are ItemActions' job.
-->
<script lang="ts">
  import type { Snippet } from 'svelte';
  import type { HTMLAttributes } from 'svelte/elements';
  import { cn } from '$lib/utils';
  import { ListItemDefaults, type ItemTone } from './list-item-defaults.svelte';

  interface Props extends HTMLAttributes<HTMLSpanElement> {
    tone?: ItemTone;
    class?: string;
    children: Snippet;
  }

  let { tone, class: className = '', children, ...rest }: Props = $props();
  // the family Defaults is the single read point (context-defaults-
  // economy 3.4): tone rides a literal slot (own 'muted', never
  // reads context)
  const d = $derived(ListItemDefaults.resolve({ tone }));
</script>

<span {...rest} data-slot="item-after" data-tone={d.tone} class={cn(className)}>{@render children()}</span>
