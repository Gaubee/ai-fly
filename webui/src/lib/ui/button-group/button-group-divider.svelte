<!--
  jixoai button group — the DIVIDER part (registry/files/ui/
  button-group/button-group-divider.svelte, OpenSpec
  2026-08-30-expand-form-family F2; composed over Separator, Owner
  2026-09-04).

  The explicit boundary between joined clusters — a Separator in the
  group's own geometry. The COMPOSITION (Owner 2026-09-04, retiring
  the borrow-the-ink-law-only era): the ink is Separator's contrast
  ghost (backdrop contrast 0.5 — the 减色墨律, no color channel, theme-
  agnostic over any ground), the element form is Separator's
  W3C-first pair (a horizontal group's divider is a VERTICAL line →
  the div[role=separator] branch; a vertical group's → the native
  <hr>), and the family keeps ONLY what is its law (button-group.css):
  the junction exemption (flush border·line·border — the boundary
  reads heavier than the intra-cluster collapsed seam) and the line
  LENGTH (align-self: stretch; the cross-axis 1px is separator.css's,
  length has always been the consumer's job).

  ARIA: role=separator with the line's orientation — a boundary
  landmark BETWEEN the clusters, announced without stealing focus
  (it is not focusable; the separator role needs no interaction).
  The vertical branch stamps role/aria itself after its spread
  (Separator's non-overridable contract); the hr branch carries the
  orientation through the rest props onto the native separator.
-->
<script lang="ts">
  import type { HTMLAttributes } from 'svelte/elements';
  import { getContext } from 'svelte';
  import { cn } from '$lib/utils';
  import { BUTTON_GROUP_KEY, type ButtonGroupApi } from './button-group.svelte';
  import Separator from '../separator/separator.svelte';

  interface Props extends HTMLAttributes<HTMLDivElement> {
    class?: string;
  }

  let { class: className = '', ...rest }: Props = $props();

  // aria-orientation describes the LINE, not the flow: a horizontal
  // group's divider is a vertical hairline (and vice versa); outside
  // any group it defaults to the horizontal flow. The family-state
  // read (the family layout key — never an axis default) rides the
  // gate's provider-file boundary: kind:provider files confine
  // context reads to reactive declaration subtrees, so the
  // getContext lives inside the $derived initializer, whose api
  // getters keep it reactive under rerenders
  const lineOrientation = $derived.by(() => {
    const group = getContext<ButtonGroupApi | undefined>(BUTTON_GROUP_KEY);
    return (group?.orientation ?? 'horizontal') === 'horizontal' ? 'vertical' : 'horizontal';
  });
</script>

<Separator
  orientation={lineOrientation}
  data-jx-btngroup-divider
  aria-orientation={lineOrientation}
  class={cn(className)}
  {...(rest as HTMLAttributes<HTMLHRElement>)}
></Separator>
