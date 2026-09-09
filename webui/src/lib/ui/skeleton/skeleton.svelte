<!--
  jixoai skeleton (registry/files/ui/skeleton/skeleton.svelte).
  The loading placeholder block: muted surface with a terminal-style
  brightness pulse. aria-hidden is set here — the real accessibility
  contract for loading regions belongs to the consumer (aria-busy on the
  container, or a visually-hidden "loading…" live region), never to each
  placeholder block.

  Pure CSS, zero JS. Shape is the consumer's geometry: the element is a
  bare block; width/height/aspect come from the class prop or the parent
  layout. The pulse respects prefers-reduced-motion (static muted block).

  tw4 (2026-08-24): paint as token utilities; the keyframes + the
  reduced-motion kill live in skeleton.css (D1-exempt residue —
  keyframes are not utilities; the kill overrides the animate utility,
  so it rides the unlayered state-machine carve-out).
-->
<script lang="ts">
  import type { HTMLAttributes } from 'svelte/elements';
  import { cn } from '$lib/utils';
  import './skeleton.css';

  interface Props extends HTMLAttributes<HTMLDivElement> {}

  let { class: className = '', ...rest }: Props = $props();
</script>

<!-- aria-hidden lands after the spread: a placeholder block is scenery
     by contract — restProps (data-*, id…) pass through untouched -->
<div
  class={cn('jx-skeleton bg-muted shadow-[inset_0_0_0_1px_var(--border)] animate-[jx-skeleton-pulse_1.4s_ease-in-out_infinite]', className)}
  {...rest}
  aria-hidden="true"
></div>
