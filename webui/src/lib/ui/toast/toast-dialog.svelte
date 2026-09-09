<!--
  jixoai toast dialog (registry/files/ui/toast/toast-dialog.svelte;
  toast-v2, 2026-09-02) — the expandable reading posture.
  An expandable:true toast opens its FULL content here through a view
  transition: the card and this panel share view-transition-name
  jx-toast-<id>, so the platform morphs one into the other (engines
  without VT get the WAAPI rect-rise the viewport drives — the
  navigation-menu indicator's two-motion-laws precedent). The panel is
  popover=auto: light dismiss collapses back into the stack; the toast
  itself is untouched (its clock stays PAUSED while expanded — the
  viewport pauses on open and resumes on collapse).

  The surface rides the dialog family's restrained ground (border +
  popover + tier shadow; NO scrim — expanding a toast is not a modal
  interruption, the page stays reachable). While open, the toast's
  countdown companion freezes with the clock (the drain bar carries
  the paused state).
-->
<script lang="ts">
  import type { ToastItem } from '$lib/toast-store';
  import { cn } from '$lib/utils';
  import ToastCountdown from './toast-countdown.svelte';

  interface Props {
    item: ToastItem;
    /** collapse (false) or dismiss-and-collapse (true) — the viewport
     *  owns the store calls; the dialog only reports intent */
    onclose: (dismiss: boolean) => void;
    /** the unified hold state — the drain bar freezes with the clock */
    paused?: boolean;
    class?: string;
  }

  let { item, onclose, paused = false, class: className = '' }: Props = $props();

  let panel = $state<HTMLElement | null>(null);

  // the shared-element name — must MATCH the card's (the viewport
  // stamps the card side when it opens the transition)
  const vtName = $derived(`jx-toast-${item.id}`);

  $effect(() => {
    // mount IS the open intent: the panel rides popover=auto, but the
    // attribute alone never opens it — show() arms light dismiss
    // (Escape / outside click → ontoggle 'closed' → collapse) and the
    // :popover-open state (a closed popover is display:none UA-side)
    panel?.showPopover?.();
    panel?.focus();
    // focus RETURN on close is the viewport's job — it owns cardEls
    // (the OPENER card, not this panel's guess at the DOM, R1 P2-5)
  });

  function requestClose(dismiss: boolean): void {
    onclose(dismiss);
  }
</script>

<div
  bind:this={panel}
  data-jx-toast-dialog={item.id}
  popover="auto"
  class={cn(
    // pointer-events-auto: the float area is pointer-transparent by law
    // (grid-not-position); the panel OPTS BACK IN like the cards do —
    // without it the whole subtree is invisible to hit tests
    'pointer-events-auto box-border m-0 fixed left-1/2 top-[10vh] -translate-x-1/2 w-[min(36rem,calc(100vw-2rem))] max-h-[80vh] overflow-y-auto p-5 border rounded bg-popover text-popover-foreground shadow-lg outline-none cursor-default',
    className,
  )}
    style={`view-transition-name: ${vtName}; view-transition-class: jx-toast-morph;`}
  role="dialog"
  aria-label={item.title}
  tabindex="-1"
  ontoggle={(e) => {
    // light dismiss (Escape / outside click): collapse, keep the toast
    if (e.newState === 'closed') requestClose(false);
  }}
>
  <div class="grid gap-3">
    <div class="flex items-start justify-between gap-4">
      <div class="grid gap-1.5 min-w-0">
        <p class="font-nav text-xs tracking-[0.1em] uppercase text-foreground">{item.title}</p>
        {#if item.description}
          <p class="text-sm leading-relaxed text-muted-foreground">{item.description}</p>
        {/if}
      </div>
      {#if item.leading}
        <div class="flex-none pt-0.5">{@render item.leading()}</div>
      {/if}
    </div>
    {#if item.trailing}
      <div data-jx-toast-dialog-trailing="" class="pt-1">{@render item.trailing()}</div>
    {/if}
    <div class="flex items-center justify-between gap-3 pt-2 border-t border-border">
      <div class="flex items-center gap-2.5">
        {#if item.countdown && (item.duration ?? 5000) > 0}
          <ToastCountdown duration={item.duration ?? 5000} {paused} />
        {/if}
      </div>
      <div class="flex items-center gap-2 pt-2">
        <button
          type="button"
          class="jx-press inline-flex items-center min-h-[var(--jx-hit)] px-[var(--jx-inset)] border border-border bg-transparent text-foreground text-[length:var(--jx-text)] cursor-pointer rounded"
          onclick={() => requestClose(false)}
        >
          collapse
        </button>
        <button
          type="button"
          data-jx-toast-dialog-dismiss=""
          class="jx-press inline-flex items-center min-h-[var(--jx-hit)] px-[var(--jx-inset)] border border-border bg-transparent text-foreground text-[length:var(--jx-text)] cursor-pointer rounded"
          onclick={() => requestClose(true)}
        >
          dismiss
        </button>
      </div>
    </div>
  </div>
</div>
