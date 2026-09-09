<!--
  jixoai ToastCountdown (registry/files/ui/toast/toast-countdown.svelte,
  2026-09-01).
  The countdown companion — a lane-sized expiry gauge for the toast
  grid's trailing slot. The bar drains over the toast's duration
  (linear, forwards); the viewport's held state (hover/focus pause)
  freezes it through the .paused class, the same pause that freezes
  the store's own timer — one hold, both clocks. Sticky toasts (no
  duration) render nothing: an expiry gauge on an immortal toast lies.

  It is a VISUAL PACE companion by design: the animation runs on the
  duration constant, not a per-frame sync with the store's remaining
  milliseconds (the store stays DOM-free); pause/resume keeps the two
  honest within a frame.
-->
<script lang="ts">
  import { cn } from '$lib/utils';

  interface Props {
    /** the toast's duration in ms (the drain pace) */
    duration: number;
    /** true while the owning toast is held (hover/focus) — freezes the drain */
    paused?: boolean;
    class?: string;
  }

  let { duration, paused = false, class: className = '' }: Props = $props();
</script>

<div
  data-jx-toast-countdown=""
  class={cn(paused && 'paused', className)}
  style="--jx-toast-countdown: {duration}ms"
  aria-hidden="true"
></div>
