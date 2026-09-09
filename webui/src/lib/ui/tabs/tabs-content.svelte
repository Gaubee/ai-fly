<!--
  jixoai tabs content (registry/files/ui/tabs/tabs-content.svelte,
  2026-09-01 tabs variant system — contract stable since; the panel
  half carries no scroll/indicator machinery, so the 2026-09-02 fix
  wave left it untouched).
  The panel half of the tabs family: role=tabpanel labelled by its
  trigger (deterministic ids — no registration handshake), tabindex=0
  per APG so the panel body is keyboard-reachable even when it holds no
  focusable elements. Hidden (attribute, not CSS) unless its value is
  selected — inert content, no interactions leak from background panels.
-->
<script lang="ts">
  import type { Snippet } from 'svelte';
  import { getContext } from 'svelte';
  import { TABS_KEY, type TabsApi } from './tabs.svelte';
  import type { Density } from '$lib/density.svelte';
  import { TabsDefaults } from './tabs-defaults.svelte';

  interface Props {
    density?: Density;
    /** pairs with the same value on a TabsTrigger */
    value: string;
    children: Snippet;
    class?: string;
  }

  let { density, value, children, class: className = '' }: Props = $props();

  const tabs = getContext<TabsApi>(TABS_KEY);

  const active = $derived(tabs.selected === value);

  // THE DEFAULTS READ POINT (context-defaults-economy 3.3): one line —
  // density resolves through the family contract (the no-opinion axis
  // slot; the panel inherits the tabs root's provided tier, an
  // explicit prop beats it, no opinion stamps nothing)
  const d = $derived(TabsDefaults.resolve({ density }));
</script>

<div
  id="{tabs.uid}-panel-{value}"
  role="tabpanel"
  aria-labelledby="{tabs.uid}-tab-{value}"
  tabindex="0"
  data-jx-tab-panel=""
  data-density={d.density}
  class={className}
  hidden={!active}
>
  {#if active}
    {@render children()}
  {/if}
</div>
