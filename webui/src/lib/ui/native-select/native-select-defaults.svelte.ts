/**
 * jixoai native-select family Defaults
 * (registry/files/ui/native-select/native-select-defaults.svelte.ts,
 * context-defaults-economy task 3.1, 2026-09-03).
 *
 * The native-select family's SINGLE declared ambient contract
 * (design.md Defaults 定位): one `NativeSelectDefaults` object whose
 * slots cover every vocabulary-hit style prop —
 *   - density: the no-opinion axis slot. The native select carries NO
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

export const NativeSelectDefaults = defineComponentDefaults({
  density: densitySlot(),
});
