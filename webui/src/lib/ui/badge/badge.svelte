<!--
  jixoai badge (registry/files/ui/badge/badge.svelte).
  The inline status chip of the site grammar: Share Tech Mono uppercase
  micro-label, 1px border, radius 0 — the eyebrow's inline cousin.

  Variant grammar (variant-grammar change, 2026-08-26, supersedes the
  tone vocabulary law): variants are the prominence ladder
  fill | tonal | outline (default tonal, NO local hue override — a bare
  Badge is the primary tint); semantic color is hue injection through
  the four global tokens (--jx-fill / --jx-fill-ink / --jx-tonal /
  --jx-outline): neutral metadata class="jx-hue-neutral", error
  status class="jx-hue-error", success class="jx-hue-success"
  (see openspec/changes/variant-grammar; the arbitrary-property
  class remains the escape hatch for unlisted hues).
  Alert rides the same ladder (variant, outline-default) — the shared tone law is retired there too.

  Geometry is the kbd law: height from --jx-line-secondary, inline
  insets only, never block padding. slotStart/slotEnd render icon lanes
  (svg sized to the secondary text) with adaptive inline padding — an
  icon-only badge (no children) keeps the SYMMETRIC inset so the glyph
  centers (the tabs-trigger guard, F-6 2026-09-02); shape square |
  pill. Forced colors (§6): Canvas ground + CanvasText
  ink, the 1px border survives.

  A plain <span> so it composes anywhere (inside headings, table cells,
  terminal cards); restProps flow through — data-*, title, aria-* land
  verbatim.

  tw4 (2026-08-24): utility-authored — paint is arbitrary-value token
  utilities in the markup (variant rides a deterministic map, so no two
  variant utilities ever collide in the sheet); the variant rides the
  ONE valued hook attribute `data-jx-badge={variant}`.
-->
<script lang="ts">
  import type { HTMLAttributes } from 'svelte/elements';
  import type { Snippet } from 'svelte';
  import { cn } from '$lib/utils';
  import { type Density } from '$lib/density.svelte';
  import { BadgeDefaults, type BadgeShape, type BadgeVariant } from './badge-defaults.svelte';

  interface Props extends HTMLAttributes<HTMLSpanElement> {
    /** prominence ladder: fill | tonal | outline (hue: global tokens);
     *  omitted → the ambient paint zone, else the frozen own 'tonal' */
    variant?: BadgeVariant;
    /** square = --radius corners (default); pill = rounded-full */
    shape?: BadgeShape;
    /** icon lane before the label (svg sized to the secondary text) */
    slotStart?: Snippet;
    /** icon lane after the label */
    slotEnd?: Snippet;
    /** density policy: explicit ?? ambient scope, else unstamped */
    density?: Density;
  }

  let {
    density,
    variant,
    shape,
    slotStart,
    slotEnd,
    class: className = '',
    children,
    ...rest
  }: Props = $props();
  // the family Defaults is the single read point (context-defaults-
  // economy 2.3): variant rides the paint axis slot (zone ambient,
  // frozen own 'tonal'), shape/density their literal/no-opinion slots
  const d = $derived(BadgeDefaults.resolve({ variant, shape, density }));

  // deterministic per variant — each rung is the SOLE bg/border-color/color
  // source (typed arbitrary utilities; named utilities would sort after these
  // and silently win — the batch-D collision law), so no two variant
  // utilities ever collide in the sheet.
  const variantUtilities = {
    fill: 'bg-(--jx-fill) border-(color:--jx-fill) text-(color:--jx-fill-ink)',
    tonal: 'bg-[color-mix(in_oklab,var(--jx-tonal)_12%,transparent)] border-[color-mix(in_oklab,var(--jx-tonal)_45%,transparent)] text-(color:--jx-tonal)',
    outline: 'bg-[transparent] border-(color:--jx-outline) text-(color:--foreground)',
  } as const;
</script>

<span
  data-jx-badge={d.variant}
  data-density={d.density}
  class={cn(
    'inline-flex items-center gap-[calc(var(--jx-gap)/2)] box-border max-w-full [padding-inline:var(--jx-inset)] border font-nav [font-size:var(--jx-text-secondary)] [line-height:var(--jx-line-secondary)] tracking-[0.14em] uppercase whitespace-nowrap rounded-(--radius) forced-color-adjust-auto [@media(forced-colors:active)]:bg-[Canvas] [@media(forced-colors:active)]:border-[CanvasText] [@media(forced-colors:active)]:text-[CanvasText]',
    // slot-vs-padding law (tabs-trigger dialect, F-6 2026-09-02): an
    // icon lane replaces its side's label inset — ONLY beside a label.
    // An icon-only badge (no children) keeps the symmetric padding so
    // the glyph centers; the unconditional has() lanes would halve one
    // side's inset and shove the glyph off-center
    children
      ? 'has-[[data-icon=inline-start]]:pl-[calc(var(--jx-inset)/2)] has-[[data-icon=inline-end]]:pr-[calc(var(--jx-inset)/2)]'
      : '',
    d.shape === 'pill' && 'rounded-full',
    variantUtilities[d.variant],
    className,
  )}
  {...rest}
>
  {#if slotStart}<span data-icon="inline-start" class="inline-flex [&>svg]:size-[var(--jx-text-secondary)]">{@render slotStart()}</span>{/if}
  {@render children?.()}
  {#if slotEnd}<span data-icon="inline-end" class="inline-flex [&>svg]:size-[var(--jx-text-secondary)]">{@render slotEnd()}</span>{/if}
</span>
