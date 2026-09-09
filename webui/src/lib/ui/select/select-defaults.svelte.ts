/**
 * jixoai select family Defaults
 * (registry/files/ui/select/select-defaults.svelte.ts,
 * context-defaults-economy task 3.1, 2026-09-03).
 *
 * The select family's SINGLE declared ambient contract (design.md
 * Defaults 定位): one `SelectDefaults` object whose slots cover every
 * vocabulary-hit style prop —
 *   - variant: the LITERAL family (own 'auto', kbd mode, r11 #6 — the
 *     dialog/sheet precedent): the floating-surface paint has a
 *     declared own and NO axis yet, so the slot resolves
 *     `explicit ?? 'auto'` and never reads context; a surface axis
 *     opening promotes it. The union rides the slot's values tuple
 *     here rather than being imported into the component's Props
 *     because select's props interface feeds the GENERATED meta chain
 *     (component-metadata-gen
 *     → props-table-meta-drift), whose ambient-column extension is the
 *     doc batch's 先破再立 (task 4.3) — both spellings are pinned
 *     identical by the family spec.
 *   - density: the no-opinion axis slot. The custom listbox carries NO
 *     density own: no provider and no explicit prop resolve undefined,
 *     stamp nothing, and the ambient css scope channel keeps flowing
 *     (fleet law).
 *
 * 惰性律: construction captures own only; context reads happen at
 * resolve time inside the consumer's $derived window. This file is a
 * member of the registry:ui item (installs with the family, byte
 * mirrored, zero kernel imports).
 */
import { defineComponentDefaults, defineLiteralSlot } from '$lib/defaults.svelte';
import { densitySlot } from '$lib/density.svelte';

export const selectSurfaceVariantSlot = defineLiteralSlot(['solid', 'acrylic', 'auto'], 'auto');

/**
 * The floating-surface paint variant — the family grammar, single-sourced
 * for the contract (select.svelte's inline Props union is pinned
 * identical; the meta-chain constraint note is above). ReturnType 反查 —
 * the slot's values tuple is the union's source.
 */
export type SelectSurfaceVariant = ReturnType<typeof selectSurfaceVariantSlot>;

export const SelectDefaults = defineComponentDefaults({
  variant: selectSurfaceVariantSlot,
  density: densitySlot(),
});
