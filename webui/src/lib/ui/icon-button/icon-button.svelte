<!--
  jixoai icon button (registry/files/ui/icon-button/icon-button.svelte).
  The icon+text button with an explicit two-part contract:

    icon  the glyph — ALWAYS decorative (the component wraps it
          aria-hidden; bring your own svg/glyph snippet)
    text  the ONE label — a single string, single-sourced

  Two postures:
    text      icon + text side by side — the default
    iconOnly  a square button; text does not disappear — it moves to
              the tooltip AND stays the accessible name (aria-label).
              An icon-only button must say itself.

  Inheritance by composition (2026-08-25, Owner ruling): the button
  IS a press-button — this component wraps it and owns only the
  two-part contract + the icon-only posture. Every press-button
  capability passes through verbatim: the paint variants (fill …
    link — the variant-grammar ladder, imported not re-declared), the
    component-tag effect attachments (the rest lane CHAINS — this
    component's spread forwards the symbol-keyed prop into the child's
    own rest, which lands on the button element: `<IconButton
    {@attach pressEffect(shimmer())}>`, r4 effect-attachments §3),
    href/external anchoring, type, class, the raised physics axis
    (the foot-flat zone reaches the square through the child's own
    ambient read — same tree, same window, Owner 2026-09-04), and the
    paint-zone context
  adoption (an absent variant adopts the zone/group's rung —
  explicit still wins). Since context-defaults-economy 2.1 the
  adoption resolves HERE, through IconButtonDefaults — the X2-11
  restate: the family contract restates press-button's slots (same
  ladder, same own) and the resolved values flow down as the child's
  explicit props (both components read the same ambient in the same
  window, so every path resolves identically). Press law and shadow
  tokens are therefore identical to a text button BY CONSTRUCTION
  (the square rides the same 42px band, not a smaller silhouette);
  the pre-composition copy had drifted its own markup and geometry.
-->
<script lang="ts">
  import type { Snippet } from 'svelte';
  import type { Density } from '$lib/density.svelte';
  import type { HTMLAttributes } from 'svelte/elements';
  import PressButton, {
    type PressButtonVariant,
  } from '$lib/ui/press-button/press-button.svelte';
  import Tooltip from '$lib/ui/tooltip/tooltip.svelte';
  import { IconButtonDefaults } from './icon-button-defaults.svelte';

  /* the REST LANE (floating-flesh-sweep, 2026-09-09): forwarded
   * VERBATIM into the wrapped press-button — arbitrary attributes land
   * on the control root; the family's typed props win by spread order.
   * The component-tag ATTACHMENT chains through it (r4): the
   * symbol-keyed prop from `<IconButton {@attach …}>` rides this
   * spread into press-button's OWN rest lane, which lands it on the
   * button element — one mechanism, two hops */
  interface Props extends Omit<
    HTMLAttributes<HTMLElement>,
    'onclick' | 'class' | 'style' | 'type' | 'aria-label'
  > {
    /** DENSITY override forwarded to the press-button control root */
    density?: Density;
    /** the glyph — always decorative; an svg or character snippet */
    icon: Snippet;
    /** the ONE label: visible text by default, tooltip + accessible name in iconOnly */
    text: string;
    /** paint — the press-button variant union, imported (not
     *  re-declared; the union itself belongs to the paint axis,
     *  lib/paint.svelte, reaching here through press-button's
     *  re-exported alias — context-defaults-economy 1.2).
     *  Ambient-manageable through IconButtonDefaults (the restate):
     *  an absent prop adopts the paint zone's rung (a ButtonGroup or
     *  variant scope), else the own 'ghost' (Owner 2026-09-05: the
     *  frameless default — the glyph IS the content) — explicit
     *  still wins */
    variant?: PressButtonVariant;
    /** THE PHYSICS AXIS, forwarded verbatim (Owner 2026-09-04): no
     *  restate is needed — the wrapped press-button reads the SAME
     *  ambient texture key in the SAME window, so a card/dialog foot
     *  zone's flat default reaches the square by construction; this
     *  prop is the EXPLICIT lane (explicit ?? zone ?? true) — the
     *  escape hatch for chrome that must stay convex inside a flat
     *  zone. Inert on the link rung (no jx-press there) */
    raised?: boolean;
    /** collapse to the square: text moves to the tooltip + aria-label */
    iconOnly?: boolean;
    /** iconOnly: which side the tooltip leans */
    placement?: 'top' | 'bottom' | 'top-start' | 'bottom-start' | 'top-end' | 'bottom-end';
    /** iconOnly: the tooltip carriage, DEFAULT ON — tip={false} keeps
     *  ONLY the accessible name (aria-label from `text`): the quiet
     *  square, for chrome that must not float hints (the dialog's
     *  close, r14-6) */
    tip?: boolean;
    /** iconOnly: the tip's pointer notch, aimed at the anchor point the
     *  placement names (on by default — a square trigger reads best with
     *  the pin; opt out for plain bubbles) */
    arrow?: boolean;
    href?: string;
    /** Opens non-internal hrefs (not starting with "/") in a new tab. */
    external?: boolean;
    onclick?: () => void;
    type?: 'button' | 'submit';
    /** the native popover invoker association, forwarded verbatim
     *  (button posture only) — ButtonGroup's overflow trigger rides it */
    popovertarget?: string;
    class?: string;
  }

  let {
    density,
    icon,
    text,
    variant = undefined,
    raised = undefined,
    iconOnly = false,
    tip = true,
    placement,
    arrow = true,
    href,
    external = undefined,
    onclick,
    type = 'button',
    popovertarget = undefined,
    class: className = '',
    ...rest
  }: Props = $props();

  // THE single read point (the restate lane, X2-11): the restated
  // contract resolves in THIS component's $derived window — the paint
  // slot's ambient lane (zone key → legacy ButtonGroup fallback)
  // lands here, and the RESOLVED values flow down as press-button's
  // explicit props (its own slots then short-circuit on the explicit
  // lane — same ambient, same window, identical values on every path)
  const d = $derived(IconButtonDefaults.resolve({ variant, density }));
</script>

{#snippet control()}
  <PressButton
    {...rest}
    density={d.density}
    variant={d.variant}
    {raised}
    square={iconOnly}
    {href}
    {external}
    {onclick}
    {type}
    {popovertarget}
    ariaLabel={iconOnly ? text : undefined}
    class={className}
  >
    <span class="shrink-0" aria-hidden="true">{@render icon()}</span>
    {#if !iconOnly}<span>{text}</span>{/if}
  </PressButton>
{/snippet}

<!-- one control, two shells — the tooltip wraps it only in icon-only -->
{#if iconOnly && tip}
  <Tooltip {text} placement={placement ?? 'top'} {arrow}>
    {@render control()}
  </Tooltip>
{:else}
  {@render control()}
{/if}
