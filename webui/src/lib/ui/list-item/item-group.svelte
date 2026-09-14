<!--
  jixoai ItemGroup (registry/files/ui/list-item/item-group.svelte).
  The surface owner (design-language-kernel design §2–§3): a
  <section|div> frame around a native <ul>. THE FIRST DENSITY PROVIDER
  — provideDensity (getter-backed) + data-density stamps on frame and
  list; Items resolve their density from here. Owns the explicit RULER
  (content-end default — deliberately media-less; media-content-end
  opts into the shared media track) stamped on the ul, and the divider
  policy (data-dividers lives ONLY on the ul — the adjacency owner).
-->
<script module lang="ts">
  import type { Density, DensityContext } from '$lib/density.svelte';

  export const ITEM_GROUP_KEY = Symbol('jx-item-group');

  export type ItemGroupMode = 'default' | 'muted' | 'plain';
  export type ItemGroupLayout = 'standard' | 'media';
  export type ItemRuler = 'content-end' | 'media-content-end';

  export interface ItemGroupPolicy extends DensityContext {
    readonly layout: ItemGroupLayout;
    readonly ruler: ItemRuler;
  }
  // the integration ambient: only a mode that paints a frame may
  // declare its in-row controls bare (muted/plain never own one)</script>

<script lang="ts">
  import { setContext } from 'svelte';
  import type { Snippet } from 'svelte';
  import type { HTMLAttributes } from 'svelte/elements';
  import { cn } from '$lib/utils';
  import { provideDensity, resolveDensity, getDensityContext } from '$lib/density.svelte';
  import { ListItemDefaults } from './list-item-defaults.svelte';
    import { CONTROL_CHROME_KEY, type ControlChrome } from '$lib/control-chrome.svelte';
  import './item.css';

  interface Props extends HTMLAttributes<HTMLElement> {
    /** frame posture: default (border+dividers) · muted (slab) · plain (host surface) */
    mode?: ItemGroupMode;
    /** fixed 0.75rem inline margins — boolean only */
    inset?: boolean;
    /** DENSITY opinion: omitted = ambient css scope, then 'default' */
    density?: Density;
    layout?: ItemGroupLayout;
    /** the shared ruler: content-end (media-less, default) | media-content-end */
    ruler?: ItemRuler;
    /** OPTIONAL raw prop — omission stays distinguishable:
        default-mode ?? 'auto', plain ?? 'none', muted forced 'none' */
    dividers?: 'auto' | 'none';
    /** control integration (B5, 2026-09-05): 'integrated' declares the
        group frame as the SOLE surface owner — in-row control shells
        dissolve (background, border, well shadow; the state machine
        stays legible). Opt-in on default mode only: muted (slab) and
        plain (host-owned) never own the frame, the declaration is
        overridden to 'self' there */
    controlChrome?: 'integrated' | 'self';
    /** renders the frame as <section aria-labelledby> + visible label */
    label?: string;
    id?: string;
    class?: string;
    children: Snippet;
  }

  // $props.id() must live in its own top-level initializer (compiler law)
  const autoId = $props.id();

  let {
    mode = 'default',
    inset,
    density,
    layout = 'standard',
    ruler = 'content-end',
    dividers,
    controlChrome,
    label,
    id,
    class: className = '',
    children,
    // component-owned stamps: the caller cannot forge density or the
    // ul-only divider stamp on the frame
    'data-density': _callerDensity,
    'data-dividers': _callerDividers,
    ...rest
  }: Props = $props();

  // The CAPTURE is load-bearing and eager (r11 provider contract, the
  // button-group form): getDensityContext() rides the $derived.by
  // ARGUMENT subtree, which evaluates at this statement — BEFORE
  // provideDensity writes the key — so it captures the PARENT's
  // context (not the group's own). Reading it lazily (in the
  // $derived initializer body, or the getter itself) would resolve
  // the very getter it feeds — derived_references_self.
  const resolved = $derived.by(
    ((inherited) => () => resolveDensity(density, inherited))(getDensityContext()),
  );
  provideDensity(() => resolved);
  // the family Defaults is the single read point for the STAMPS
  // (context-defaults-economy 3.4): the slot's ambient read lands on
  // this group's own provided policy — exactly what the rows see,
  // one resolution for the whole list; inset rides a literal slot
  // (own false)
  const d = $derived(ListItemDefaults.resolve({ inset, density }));

  const labelId = $derived(`${id ?? autoId}-label`);
  const resolvedDividers = $derived(
    mode === 'muted' ? 'none' : (dividers ?? (mode === 'plain' ? 'none' : 'auto')),
  );

  setContext(ITEM_GROUP_KEY, {
    get density() {
      return resolved;
    },
    get layout() {
      return layout;
    },
    get ruler() {
      return ruler;
    },
  } satisfies ItemGroupPolicy);
  // the integration ambient: only a mode that paints a frame may
  // declare its in-row controls bare (muted/plain never own one)
  setContext(CONTROL_CHROME_KEY, {
    get chrome() {
      return mode === 'default' && (controlChrome ?? 'self') === 'integrated'
        ? ('bare' as ControlChrome)
        : undefined;
    },
  });
</script>

<svelte:element
  this={label ? 'section' : 'div'}
  {...rest}
  id={id}
  data-slot="item-group"
  data-density={d.density}
  data-mode={mode}
  data-control-chrome={mode === 'default' ? (controlChrome ?? 'self') : 'self'}
  data-inset={d.inset ? 'true' : undefined}
  data-layout={layout}
  class={cn('jx-item-group', className)}
  aria-labelledby={label ? labelId : undefined}
>
  {#if label}
    <div class="jx-item-group-label" id={labelId}>{label}</div>
  {/if}
  <ul
    data-slot="item-list"
    role="list"
    data-density={d.density}
    data-ruler={ruler}
    data-dividers={resolvedDividers}
  >
    {@render children()}
  </ul>
</svelte:element>
