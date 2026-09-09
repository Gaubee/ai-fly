/**
 * jixoai alert family Defaults
 * (registry/files/ui/alert/alert-defaults.svelte.ts,
 * context-defaults-economy task 3.2, 2026-09-03).
 *
 * The alert family's SINGLE declared ambient contract (design.md
 * Defaults 定位): one `AlertDefaults` object whose slots cover every
 * vocabulary-hit style prop —
 *   - variant: the paint axis slot, availability exactly per the
 *     frozen table (variant-grammar §4: alert carries the two-rung
 *     ladder outline/tonal, own outline — badge.svelte's header
 *     already recorded 'Alert rides the same ladder (variant,
 *     outline-default)'). `alertVariantSlot`'s values tuple IS the
 *     family union's source (slot-values-first D2: the gate asserts
 *     values ≡ the frozen row bidirectionally). The ambient domain
 *     is trusted (D3-A retired the runtime values guard — no clamp,
 *     no warn; ZonePaintVariant already excludes the out-of-union
 *     rungs at the provider).
 *   - density: the no-opinion axis slot. The alert carries NO density
 *     own: no provider and no explicit prop resolve undefined, stamp
 *     nothing, and the ambient css scope channel keeps flowing (fleet
 *     law).
 *
 * 惰性律: construction captures own/values only; context reads happen
 * at resolve time inside the consumer's $derived window. This file is
 * a member of the registry:ui item (installs with the family, byte
 * mirrored, zero kernel imports).
 */
import { defineComponentDefaults } from '$lib/defaults.svelte';
import { definePaintSlot } from '$lib/paint.svelte';
import { densitySlot } from '$lib/density.svelte';

/** the banner's prominence ladder — the frozen table's Alert row
 *  (the badge ladder minus fill: a banner never shouts from a fill);
 *  the values tuple is the union's one declaration */
export const alertVariantSlot = definePaintSlot(['outline', 'tonal'], 'outline');
export type AlertVariant = ReturnType<typeof alertVariantSlot>;

export const AlertDefaults = defineComponentDefaults({
  variant: alertVariantSlot,
  density: densitySlot(),
});
