<!--
  jixoai alert (registry/files/ui/alert/alert.svelte).
  The inline notice block: 1px border, hard offset shadow, and the
  variant ladder as its surface. Not the modal one (that is
  alert-dialog, a later registry item) — this is the in-flow banner
  for loaded/failed states.

  Live-region semantics are a prop, not a guess:
    assertive={false} (default) → role="status"  polite announcements
    assertive={true}            → role="alert"   immediate (errors —
                                  pair with the error-status injection)

  Variant grammar (2026-08-26, variant-grammar change): the old
  tone law (default/primary/destructive) is superseded; the
  one-brand-hue idea survives as the TOKEN defaults. Prominence is
  the ladder, hue is injection through the global tokens:
    outline (default)  transparent ground, [border-color:var(--jx-outline)],
                       title foreground — the plain notice
    tonal              12% tinted ground + 45% border + title
                       [color:var(--jx-tonal)] — emphasis; brand tint
                       by default, injected per intent through class
                       utilities: jx-hue-error for failed STATUSES, jx-hue-success
                       for passing (the arbitrary-property class remains
                       the escape hatch for unlisted hues).
  Action vs status is the caller's call (design §3): destructive is
  an ACTION hue (delete/cancel — PressButton's fill pair); Alert is
  a status surface, so failures inject --error, never --destructive.

  Surface ruling: the banner IS its variant surface — the old bg-card
  ground is gone, the ladder paint replaces it. The 1px border and
  the hard offset shadow-2xs STAY: every sibling static surface on
  the site (kbd, menubar, toggle-group, transfer panels, empty's art
  block) pairs border + shadow-2xs — the hard offset is the site's
  terminal material law, not a card-specific trait.

  Composition: optional `icon` snippet lands inline-start of the title
  (bring your own — lucide, svg, text glyph); children is the body copy.

  tw4 (2026-08-24): utility-authored — the banner paint composes from
  token utilities (layer law: consumer utilities always win); variant
  maps to ground/border/title color utilities per prop. ONLY the
  passed-through icon-glyph normalization (a descendant boundary)
  stays in alert.css; `jx-alert*` classes are semantic hooks, css
  defines them not.
-->
<script lang="ts">
  import type { Snippet } from 'svelte';
  import { cn } from '$lib/utils';
  import { AlertDefaults, type AlertVariant } from './alert-defaults.svelte';
  import './alert.css';

  interface Props {
    /** ladder prominence: outline (plain notice) | tonal (tinted
     *  emphasis); omitted → the ambient paint zone, else the frozen
     *  own 'outline' */
    variant?: AlertVariant;
    /** true → role=alert (assertive); false → role=status (polite) */
    assertive?: boolean;
    /** one-line heading; omitted renders a bare body block */
    title?: string;
    /** icon snippet, rendered inline-start of the title */
    icon?: Snippet;
    /** body copy; omit for a title-only notice */
    children?: Snippet;
    class?: string;
  }

  let { variant, assertive = false, title, icon, children, class: className = '' }: Props =
    $props();

  // the family Defaults is the single read point (context-defaults-
  // economy 3.2): variant rides the paint axis slot (zone ambient,
  // frozen own 'outline'); density is the no-opinion slot — nothing
  // stamps, the ambient css scope channel keeps flowing
  const d = $derived(AlertDefaults.resolve({ variant }));

  // variant grounds (design.md §1 recipes, verbatim) — the ladder
  // surface REPLACES the card ground; the border + hard offset shadow
  // are the terminal material law and stay. Each rung carries its
  // design §6 forced-colors degradation: the color-mix tints do NOT
  // drop on their own under forced colors (probed, r2) — Canvas +
  // CanvasText with the 1px border surviving is the lawful result.
  const surface = {
    outline:
      'bg-transparent [border-color:var(--jx-outline)] forced-colors:bg-[Canvas] forced-colors:border-[CanvasText]',
    tonal: 'bg-[color-mix(in_oklab,var(--jx-tonal)_12%,transparent)] border-[color-mix(in_oklab,var(--jx-tonal)_45%,transparent)] forced-colors:bg-[Canvas] forced-colors:border-[CanvasText]',
  } as const;
  // the title consumes the variant ink; the BODY consumes it too on
  // the tonal rung (r2 blocker fix: an error banner no longer paints
  // a red title over gray body copy) — outline keeps the muted body,
  // the neutral rung's own ink ramp for long copy
  const titleColor = {
    outline: 'text-foreground forced-colors:text-[CanvasText]',
    tonal: '[color:var(--jx-tonal)] forced-colors:text-[CanvasText]',
  } as const;
  const bodyColor = {
    outline: 'text-muted-foreground forced-colors:text-[CanvasText]',
    tonal: 'text-[color:var(--jx-tonal)] forced-colors:text-[CanvasText]',
  } as const;
</script>

<div
  class={cn(
    `flex flex-col gap-1.5 box-border border px-3.5 py-3 shadow-2xs rounded`,
    surface[d.variant],
    className,
  )}
  data-jx-alert={d.variant}
  role={assertive ? 'alert' : 'status'}
>
  {#if title}
    <p data-jx-alert-title="" class={cn('flex items-center gap-2 font-nav text-[0.8125rem] tracking-[0.08em] uppercase', titleColor[d.variant])}>
      {#if icon}<span class="jx-alert-icon inline-flex">{@render icon()}</span>{/if}{title}
    </p>
  {/if}
  {#if children}
    <div data-jx-alert-body="" class={cn('text-[0.8125rem] leading-[1.55]', bodyColor[d.variant])}>
      {@render children()}
    </div>
  {/if}
</div>
