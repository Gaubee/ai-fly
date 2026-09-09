/**
 * jixoai tabs family Defaults
 * (registry/files/ui/tabs/tabs-defaults.svelte.ts,
 * context-defaults-economy task 3.3, 2026-09-03).
 *
 * The tabs family's SINGLE declared ambient contract (design.md
 * Defaults 定位): one `TabsDefaults` object whose slots cover every
 * vocabulary-hit style prop —
 *   - density: the no-opinion axis slot. The tabs root is a STRUCTURAL
 *     provider (the shared selection state) whose density lane is
 *     inherit-then-provide by the frozen provider duties (r11 first
 *     contract — the eager capture in tabs.svelte feeds provideDensity;
 *     the legacy read stays confined there). The contract itself
 *     carries NO own: no provider and no explicit prop resolve
 *     undefined, stamp nothing, and the ambient css scope channel keeps
 *     flowing (fleet law) — the tablist strip and panels ride the
 *     surrounding tier together.
 *
 * 惰性律: construction captures own only; context reads happen at
 * resolve time inside the consumer's $derived window. This file is a
 * member of the registry:ui item (installs with the family, byte
 * mirrored, zero kernel imports).
 */
import { defineComponentDefaults } from '$lib/defaults.svelte';
import { densitySlot } from '$lib/density.svelte';

export const TabsDefaults = defineComponentDefaults({
  density: densitySlot(),
});
