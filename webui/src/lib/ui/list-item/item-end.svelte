<!--
  jixoai ItemEnd — the ONE trailing lane (openspec
  list-item-systemization design §1): ItemAfter (metadata),
  ItemChevron (glyph) and raw controls all live INSIDE it, so the
  top-level presence matrix keeps four bits; ItemActions is the lane's
  semantic sibling for button clusters — it renders its OWN ItemEnd
  (wrap=never) around a joined ButtonGroup. Wraps to its own full row
  under the narrow @container jx-items law unless wrap="never".

  The size contract (list-item-size-contract, 2026-09-05 — Owner r3:
  width-driven folding DECLARED at composition time, the md:/lg: idiom,
  never runtime measurement): `fit` puts the lane on a responsive
  width ladder the sheet steps through container tiers — md
  10rem→7rem→stack+100% (number/time-class), lg 16rem→11rem→stack+100%
  (text/long-select-class), full 100% always (greedy). The LANE carries
  the ladder (the end track's max-content growth resolves it), platform
  controls fill the lane — no :first-child guessing, and a sized lane
  is by declaration foldable, so fit and wrap="never" (the fixed
  semantic: toggle/checkbox/badge class) are mutually exclusive.
-->
<script lang="ts">
  import type { Snippet } from 'svelte';
  import type { HTMLAttributes } from 'svelte/elements';
  import { cn } from '$lib/utils';

  /** the declared responsive width ladder rungs */
  export type ItemEndFit = 'md' | 'lg' | 'full';
export type ItemEndInset = 'auto' | number | boolean;

  interface Props extends HTMLAttributes<HTMLSpanElement> {
    /** lane's cross-axis posture against tall content */
    align?: 'center' | 'start';
    /** 'never' opts out of the narrow own-row wrap law */
    wrap?: 'auto' | 'never';
    /** the declared ladder — sizes THIS lane and joins the narrow fold */
    fit?: ItemEndFit;
    //* explicit tail inset（本地补声明：上游 Props 漏列，解构已用） */
    inset?: ItemEndInset;
    class?: string;
    children: Snippet;
  }

  let { align = 'center', wrap = 'auto', fit, inset = 'auto', class: className = '', children, ...rest }: Props = $props();

  // the inset contract's stamp + explicit-tail custom property
  const insetStamp =
    inset === true ? 'on' : inset === false ? 'off' : inset === 'auto' ? 'auto' : 'set';
  const insetStyle = typeof inset === 'number' ? `--jx-item-end-inset: ${inset}px` : undefined;
  if (typeof inset === 'number' && inset < 0) {
    throw new Error(
      '[jixoai list-item] ItemEnd: inset must be a non-negative px value — a negative tail is a margin wearing the wrong name (2026-09-05 inset contract)',
    );
  }

  // the family throw precedent (toggle-group's name guard): a fixed
  // lane never restacks, so a ladder on it is a contract contradiction
  if (wrap === 'never' && fit !== undefined) {
    throw new Error(
      '[jixoai list-item] ItemEnd: fit and wrap="never" are mutually exclusive — a never-fold lane is fixed-width by declaration (2026-09-05 size contract)',
    );
  }
</script>

<span
  {...rest}
  data-slot="item-end"
  data-align={align}
  data-wrap={wrap}
  data-fit={fit}
  data-inset={insetStamp}
  style={insetStyle}
  class={cn(className)}
>{@render children()}</span>
