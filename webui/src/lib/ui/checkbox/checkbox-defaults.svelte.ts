/**
 * jixoai checkbox family Defaults
 * (registry/files/ui/checkbox/checkbox-defaults.svelte.ts,
 * context-defaults-economy task 3.1, 2026-09-03).
 *
 * The checkbox family's SINGLE declared ambient contract (design.md
 * Defaults 定位): one `CheckboxDefaults` object whose slots cover every
 * vocabulary-hit style prop —
 *   - density: the no-opinion axis slot. The pure-CSS redraw carries NO
 *     density own: no provider and no explicit prop resolve undefined,
 *     stamp nothing, and the ambient css scope channel keeps flowing
 *     (fleet law).
 *
 * 惰性律: construction captures own only; context reads happen at
 * resolve time inside the consumer's $derived window. This file is a
 * member of the registry:ui item (installs with the family, byte
 * mirrored, zero kernel imports).
 */
import { defineComponentDefaults } from '$lib/defaults.svelte';
import { densitySlot } from '$lib/density.svelte';

export const CheckboxDefaults = defineComponentDefaults({
  density: densitySlot(),
});
