<!--
  jixoai accordion item (registry/files/ui/accordion/accordion-item.svelte).
  The leaf half of the accordion pair: a styled <details>/<summary> with
  nothing added semantically — the browser already exposes the toggle,
  the disclosure state, and the keyboard contract. Drop it inside
  accordion.svelte (the group frame) or use it bare for a one-off
  disclosure.

  bind:open is supported (Svelte binds <details> open natively) — the
  exclusive mode on the group still works through the DOM, so manual
  open changes participate in the same radio behavior.

  The summary is a snippet (icons, badges compose); the marker is a CSS
  chevron that rotates on [open] — the native ::marker is retired.
  CONSTRAINT: no interactive elements (buttons/links) inside the summary
  snippet — they fight the summary's own click/keyboard contract. Put
  per-row actions in the body, or use a menu outside the accordion.

  tw4 (2026-08-24): utility-authored — the summary line paint (incl.
  hover/focus-visible) and the body paint live in the markup; ONLY the
  marker retirement, the chevron pseudo build with its [open] rotation,
  the ::details-content height machinery, and the reduced-motion kill
  stay in accordion-item.css (D1-exempt residue).
-->
<script lang="ts">
  import type { Snippet } from 'svelte';
  import { cn } from '$lib/utils';
  import './accordion-item.css';

  interface Props {
    /** disclosure state; bindable (bind:open) for controlled use */
    open?: boolean;
    /** the summary line — plain text or a composed snippet */
    summary: Snippet;
    children: Snippet;
    class?: string;
  }

  let { open = $bindable(false), summary, children, class: className = '' }: Props = $props();
</script>

<details class={cn('jx-acc-item block', className)} bind:open>
  <summary class="jx-acc-summary flex items-center gap-2.5 box-border px-3.5 py-[0.6875rem] cursor-pointer list-none select-none font-nav text-[0.8125rem] tracking-[0.08em] uppercase text-foreground transition-colors duration-150 ease-out hover:text-primary focus-visible:outline-1 focus-visible:outline-ring focus-visible:outline-offset-[-1px]">{@render summary()}</summary>
  <div data-jx-acc-body="" class="pl-6 pr-3.5 pb-3.5 text-[0.8125rem] leading-[1.6] text-muted-foreground">
    {@render children()}
  </div>
</details>
