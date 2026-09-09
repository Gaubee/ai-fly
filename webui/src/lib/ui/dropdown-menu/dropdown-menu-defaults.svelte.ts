/**
 * jixoai dropdown-menu family Defaults
 * (registry/files/ui/dropdown-menu/dropdown-menu-defaults.svelte.ts,
 * context-defaults-economy task 3.3, 2026-09-03).
 *
 * The dropdown-menu family's SINGLE declared ambient contract
 * (design.md Defaults 定位): one `DropdownMenuDefaults` object whose
 * slots cover every vocabulary-hit style prop —
 *   - density: the no-opinion axis slot. The menu root is a STRUCTURAL
 *     provider (the selection/close context for its items) whose
 *     density lane is inherit-then-provide by the frozen provider
 *     duties (the eager capture in dropdown-menu.svelte feeds
 *     provideDensity; the legacy read stays confined there). The
 *     contract carries NO own: no provider and no explicit prop
 *     resolve undefined, stamp nothing, and the ambient css scope
 *     channel keeps flowing (fleet law). Items resolve their own stamp
 *     through the same contract (an explicit item prop beats the
 *     provided tier).
 *   - variant: the LITERAL family (own 'auto') — the floating-surface
 *     paint, the same grammar as the dialog and sheet families
 *     (classification b: declared own, no axis yet; a surface axis
 *     would first have to freeze the union). The slot resolves
 *     `explicit ?? own` and never reads context.
 *
 * 惰性律: construction captures own only; context reads happen at
 * resolve time inside the consumer's $derived window. This file is
 * a member of the registry:ui item (installs with the family, byte
 * mirrored, zero kernel imports).
 */
import { defineComponentDefaults, defineLiteralSlot } from '$lib/defaults.svelte';
import { densitySlot } from '$lib/density.svelte';

/**
 * The floating-surface paint variant — the family grammar, single-sourced
 * here (the values tuple IS the union; dropdown-menu.svelte's Props and
 * this contract share the one union; the dialog and sheet families
 * declare their own same-shaped unions).
 */
export const dropdownMenuSurfaceVariantSlot = defineLiteralSlot(
  ['solid', 'acrylic', 'auto'],
  'auto',
);
export type DropdownMenuSurfaceVariant = ReturnType<typeof dropdownMenuSurfaceVariantSlot>;

export const DropdownMenuDefaults = defineComponentDefaults({
  density: densitySlot(),
  variant: dropdownMenuSurfaceVariantSlot,
});
