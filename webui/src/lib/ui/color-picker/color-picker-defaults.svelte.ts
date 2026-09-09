/**
 * jixoai color-picker family Defaults
 * (registry/files/ui/color-picker/color-picker-defaults.svelte.ts,
 * context-defaults-economy task 3.1, 2026-09-03).
 *
 * The color-picker family's SINGLE declared ambient contract (design.md
 * Defaults 定位): one `ColorPickerDefaults` object whose slots cover
 * every vocabulary-hit style prop —
 *   - variant: the LITERAL family (own 'auto', kbd mode, r11 #6 — the
 *     dialog/sheet precedent): the popover's floating-surface paint has
 *     a declared own and NO axis yet, so the slot resolves
 *     `explicit ?? 'auto'` and never reads context; a surface axis
 *     opening promotes it (color-picker.svelte's Props shares this
 *     union).
 *   - density: the no-opinion axis slot. The lane carries NO density
 *     own: no provider and no explicit prop resolve undefined, stamp
 *     nothing, and the ambient css scope channel keeps flowing (fleet
 *     law).
 *
 * 惰性律: construction captures own only; context reads happen at
 * resolve time inside the consumer's $derived window. This file is
 * a member of the registry:ui item (installs with the family, byte
 * mirrored, zero kernel imports).
 */
import { defineComponentDefaults, defineLiteralSlot } from '$lib/defaults.svelte';
import { densitySlot } from '$lib/density.svelte';

/**
 * The popover's floating-surface paint — the family grammar,
 * single-sourced here (the values tuple IS the union;
 * color-picker.svelte's Props and this contract share it).
 */
export const colorPickerSurfaceVariantSlot = defineLiteralSlot(
  ['solid', 'acrylic', 'auto'],
  'auto',
);
export type ColorPickerSurfaceVariant = ReturnType<typeof colorPickerSurfaceVariantSlot>;

export const ColorPickerDefaults = defineComponentDefaults({
  variant: colorPickerSurfaceVariantSlot,
  density: densitySlot(),
});
