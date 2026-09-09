<!--
  jixoai tabs — the ROOT half (registry/files/ui/tabs/tabs.svelte,
  2026-09-01 tabs variant system; 2026-09-02 fix wave touched only
  comment/format hygiene here — the context contract is stable).
  WAI-ARIA APG tabs pattern, composition-first: this component owns ONLY
  the shared state (the selected value) and hands it to the family
  through context — the tablist, triggers and panels can be laid out
  anywhere in the subtree (sidebar + panel grid, inline docs switches…):

    <Tabs bind:value>
      <TabsList>                       ← keyboard + roving tabindex
        <TabsTrigger value="a">A</TabsTrigger>
      </TabsList>
      <TabsContent value="a">…</TabsContent>
    </Tabs>

  value is $bindable; '' means nothing selected (SSR-honest — like the
  wider ecosystem, the initial selection is an explicit decision, not a
  hydration-time guess). Automatic activation: focus moving across
  triggers selects them (terminal immediacy; the manual-activation
  variant can arrive later as a prop if a use case shows up).
-->
<script lang="ts" module>
  /** context surface the family shares (import type where needed) */
  export interface TabsApi {
    readonly uid: string;
    readonly selected: string;
    /** the tab stop: last-focused trigger, falling back to the selected
     *  one — manual activation keeps roving tabindex on the FOCUSED
     *  trigger, not the selected one (APG contract) */
    readonly tabStop: string;
    setTabStop(value: string): void;
    select(value: string): void;
    /** 'automatic': arrows select as they focus · 'manual': Enter/Space */
    readonly activation: 'automatic' | 'manual';
  }

  /** context key — registered on the global symbol registry so the
   *  family files stay independent registry items */
  export const TABS_KEY = Symbol.for('jx-tabs');
</script>

<script lang="ts">
  import type { Snippet } from 'svelte';
  import { setContext } from 'svelte';
  import { getDensityContext, provideDensity, resolveDensity, type Density } from '$lib/density.svelte';
  import { TabsDefaults } from './tabs-defaults.svelte';

  interface Props {
    density?: Density;
    /** the active tab value; bindable (bind:value) — '' = none selected.
     *  The bound value is the authority: pointing it at a disabled or
     *  absent tab keeps that value verbatim (caller's decision). */
    value?: string;
    /** fires on every selection change (bound or not) */
    onchange?: (value: string) => void;
    /** automatic: focus moves select (default, terminal immediacy).
     *  manual: arrows move focus only — Enter/Space commit. */
    activation?: 'automatic' | 'manual';
    children: Snippet;
  }

  // $props.id() must live in its own top-level initializer (compiler law)
  const autoId = $props.id();

  let {
    density,
    value = $bindable(''),
    onchange,
    activation = 'automatic',
    children,
  }: Props = $props();

  // '' = "nothing focused yet" → the selected trigger is the tab stop
  let focused = $state('');

  // ---- the density lane: inherit-then-provide, boundary-legal ------
  // The CAPTURE is load-bearing and EAGER (r11 first contract,
  // context-defaults-economy 3.3): getDensityContext() rides the
  // $derived.by ARGUMENT subtree, which evaluates at this statement —
  // BEFORE provideDensity writes the key — so it captures the PARENT's
  // context object. A lazily-evaluated read (a plain $derived
  // initializer body, or the getter itself) would resolve the key to
  // the tabs' OWN write and self-reference through the very getter it
  // feeds — derived_references_self, the pre-3.3 bare capture this
  // replaces (the packet-D lesson in its r11 form). The returned
  // getter reads ONLY the captured object (reactive through its
  // getters, never re-entering the context machinery)
  const resolvedDensity = $derived.by(
    ((inherited) => () => resolveDensity(density, inherited))(getDensityContext()),
  );
  provideDensity(() => resolvedDensity);

  // THE DEFAULTS READ POINT (context-defaults-economy 3.3), riding ON
  // TOP of the provider lane as the family's single audited read point:
  // the density slot's ambient read resolves the key to the tabs' own
  // write, whose getter is the captured-parent resolution above, so the
  // chain TERMINATES (it never re-enters this derived) and lands the
  // same value every lane stamps
  const d = $derived(TabsDefaults.resolve({ density }));

  setContext<TabsApi>(TABS_KEY, {
    uid: autoId,
    get activation() {
      return activation;
    },
    get selected() {
      return value;
    },
    get tabStop() {
      return focused || value;
    },
    setTabStop(next: string) {
      focused = next;
    },
    select(next: string) {
      if (next === value) return;
      value = next;
      onchange?.(next);
    },
  });
</script>

<div data-jx-tabs="" data-density={d.density} class="contents">{@render children()}</div>
