/**
 * jixoai badge family Defaults
 * (registry/files/ui/badge/badge-defaults.svelte.ts,
 * context-defaults-economy task 2.3, 2026-09-03).
 *
 * The badge family's SINGLE declared ambient contract (design.md
 * Defaults 定位): one `BadgeDefaults` object whose slots cover every
 * vocabulary-hit style prop —
 *   - variant: the paint axis slot, availability exactly per the
 *     frozen table (variant-grammar §4: fill/tonal/outline, own
 *     tonal). `badgeVariantSlot`'s values tuple IS the family
 *     union's source (slot-values-first D2: the gate asserts values
 *     ≡ the frozen row bidirectionally). The ambient domain is
 *     trusted (D3-A retired the runtime values guard — no clamp, no
 *     warn; ZonePaintVariant already excludes the out-of-union
 *     rungs at the provider).
 *   - shape: the literal family (own 'square' declared, ambient
 *     capability pends a future shape axis — auditable today,
 *     promotable when that axis opens).
 *   - density: the no-opinion axis slot. The badge carries NO density
 *     own: no provider and no explicit prop resolve undefined, stamp
 *     nothing, and the ambient css scope channel keeps flowing (fleet
 *     law).
 *
 * 惰性律: construction captures own/values only; context reads happen
 * at resolve time inside the consumer's $derived window. This file is
 * a member of the registry:ui item (installs with the family, byte
 * mirrored, zero kernel imports).
 */
import { defineComponentDefaults, defineLiteralSlot } from '$lib/defaults.svelte';
import { definePaintSlot } from '$lib/paint.svelte';
import { densitySlot } from '$lib/density.svelte';

/** the badge's prominence ladder — the frozen table's Badge row
 *  (link never reaches Badge; hue injects through the global tokens);
 *  the values tuple is the union's one declaration */
export const badgeVariantSlot = definePaintSlot(['fill', 'tonal', 'outline'], 'tonal');
export type BadgeVariant = ReturnType<typeof badgeVariantSlot>;

/** the corner-law vocabulary: --radius (square) or rounded-full (pill) */
export const badgeShapeSlot = defineLiteralSlot(['square', 'pill'], 'square');
export type BadgeShape = ReturnType<typeof badgeShapeSlot>;

export const BadgeDefaults = defineComponentDefaults({
  variant: badgeVariantSlot,
  shape: badgeShapeSlot,
  density: densitySlot(),
});
