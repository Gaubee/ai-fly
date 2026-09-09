<!--
  jixoai tabs trigger (registry/files/ui/tabs/tabs-trigger.svelte).
  The tab half of the tabs family: a real <button role=tab> wired to
  the root's context — aria-selected, aria-controls and the roving
  tabindex (selected ⇒ tabbable, otherwise −1; the arrows in
  tabs-list.svelte do the walking). Deterministic ids pair it with the
  matching tabs-content for assistive tech, lazily rendered or not.

  Terminal styling: font-nav micro-label; the selected tab carries the
  jx-tab-selected semantic hook (the paint moved to the list's shared
  sliding indicator — 2026-09-01 tabs variant system), and the button
  sits at z-[1] so its ink paints above that indicator.

  Anatomy (toggle-group dialect): optional icon / iconEnd snippet lanes
  (aria-hidden, svg sized to the secondary text token) take their side's
  half-inset through the has() slot law; stack=true flips the button to
  a column for icon-over-label tabs. Spread contract: {...rest} lands
  FIRST, the part's own type/role/id/aria-*/tabindex follow and win
  (component-owned); onclick/onfocus are destructured out and MERGED —
  consumer handler first, then the family wiring (merge law).
-->
<script lang="ts">
  import type { Snippet } from 'svelte';
  import type { HTMLButtonAttributes } from 'svelte/elements';
  import { getContext } from 'svelte';
  import { cn } from '$lib/utils';
  import { TABS_KEY, type TabsApi } from './tabs.svelte';
  import './tabs-trigger.css';

  interface Props extends HTMLButtonAttributes {
    /** the tab's identity — pairs with the same value on a TabsContent */
    value: string;
    disabled?: boolean;
    /** leading icon lane — an inline-start snippet (svg sized to the secondary text token) */
    icon?: Snippet;
    /** trailing icon lane — an inline-end snippet */
    iconEnd?: Snippet;
    /** stack the icon lane OVER the label (column) instead of beside it */
    stack?: boolean;
    class?: string;
    /** OPTIONAL: an icon-only tab (icon + aria-label through ...rest)
        carries no label children — children renders guarded */
    children?: Snippet;
  }

  let {
    value,
    disabled = false,
    icon,
    iconEnd,
    stack = false,
    class: className = '',
    onclick,
    onfocus,
    children,
    ...rest
  }: Props = $props();

  const tabs = getContext<TabsApi>(TABS_KEY);

  const selected = $derived(tabs.selected === value);
  // the tab stop follows focus (roving law). The tabStop === '' arm is
  // the EMPTY state (nothing focused, nothing selected): every trigger
  // renders tabbable so keyboard/JS-off users can enter at all —
  // tabs-list trims this to "first enabled only" right after mount
  const isTabStop = $derived(tabs.tabStop === value || tabs.tabStop === '');
</script>

<button
  {...rest}
  type="button"
  role="tab"
  id="{tabs.uid}-tab-{value}"
  aria-selected={selected}
  aria-controls="{tabs.uid}-panel-{value}"
  tabindex={isTabStop ? 0 : -1}
  data-jx-tab=""
  class={cn(
    'relative z-[1] inline-flex appearance-none items-center [padding-inline:var(--jx-inset)] [min-block-size:var(--jx-hit)] font-nav [font-size:var(--jx-text)] [line-height:var(--jx-line)] uppercase tracking-[0.12em] cursor-pointer transition-colors duration-150 ease-out hover:[&:not(:disabled)]:text-foreground disabled:cursor-not-allowed disabled:opacity-45 focus-visible:outline-1 focus-visible:outline-ring focus-visible:-outline-offset-1',
    // stack flips the axis: a tighter column gap replaces the row gap
    // (min-block-size and the padding law stay untouched)
    stack ? 'flex-col justify-center [gap:calc(var(--jx-gap)*0.35)]' : '[gap:var(--jx-gap)]',
    // slot-vs-padding law (toggle-group dialect): an icon lane replaces
    // its side's label inset — ONLY beside a label. An icon-only tab
    // (no children) keeps the symmetric padding so the glyph centers
    children
      ? 'has-[[data-icon=inline-start]]:pl-[calc(var(--jx-inset)/2)] has-[[data-icon=inline-end]]:pr-[calc(var(--jx-inset)/2)]'
      : '',
    selected ? 'jx-tab-selected text-foreground' : 'text-muted-foreground',
    className,
  )}
  {disabled}
  onclick={(event: MouseEvent) => {
    onclick?.(event);
    tabs.select(value);
  }}
  onfocus={(event: FocusEvent) => {
    onfocus?.(event);
    tabs.setTabStop(value);
  }}
>
  {#if icon}<span data-icon="inline-start" aria-hidden="true" class="inline-flex shrink-0 [&>svg]:size-[var(--jx-text-secondary)]">{@render icon()}</span>{/if}
  {@render children?.()}
  {#if iconEnd}<span data-icon="inline-end" aria-hidden="true" class="inline-flex shrink-0 [&>svg]:size-[var(--jx-text-secondary)]">{@render iconEnd()}</span>{/if}
</button>
