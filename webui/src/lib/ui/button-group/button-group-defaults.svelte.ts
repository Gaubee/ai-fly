/**
 * jixoai button-group family Defaults
 * (registry/files/ui/button-group/button-group-defaults.svelte.ts,
 * context-defaults-economy task 2.1, 2026-09-03).
 *
 * The button-group family's SINGLE declared ambient contract. The
 * group is a STRUCTURAL provider (the layout half + the seam policy +
 * the dual paint-zone write), so this contract's consumer face is
 * deliberately narrow:
 *   - variant: the paint axis slot over the ZONE value domain
 *     (ZonePaintVariant — link excluded; the group's variant prop
 *     itself was narrowed there in 1.2), own 'outline' = the family's
 *     effective silent rung (a group with no variant and no enclosing
 *     scope leaves its children on the ladder's frozen default —
 *     PressButton's 'outline'; the slot declares that rung as this
 *     family's own). SINGLE-KEY (Owner 2026-09-04): the component's
 *     own inherit-then-provide rides the paint zone lane
 *     (getPaintZone eager capture — no second key exists), and the
 *     variant slot stays declaration-first: ButtonGroup resolves its
 *     density through this contract, while the group's zone write
 *     carries the variant (one lane, audited from both sides).
 *   - density: the no-opinion axis slot — the group carries no own
 *     (explicit ?? inherited ?? undefined), resolving what it then
 *     PROVIDES to the subtree (the joined buttons adopt the tier);
 *     no opinion stamps nothing (fleet law).
 *
 * 惰性律: construction captures own/values only; context reads happen
 * at resolve time inside the consumer's $derived window. Member of the
 * registry:ui item (installs with the family, byte mirrored, zero
 * kernel imports).
 */
import { defineComponentDefaults } from '$lib/defaults.svelte';
import { densitySlot } from '$lib/density.svelte';
import { definePaintSlot } from '$lib/paint.svelte';

/**
 * The zone domain's literal spelling — the values tuple IS the
 * family union (slot-values-first D2; the canonical type is
 * lib/paint's ZonePaintVariant = Exclude<PaintVariant, 'link'>).
 * Four values: link is PressButton's interaction exception, never a
 * zone default — a group varianting to link is a compile error, not
 * a runtime clamp.
 */
export const buttonGroupVariantSlot = definePaintSlot(
  ['fill', 'tonal', 'outline', 'ghost'],
  'outline',
);
export type ButtonGroupVariant = ReturnType<typeof buttonGroupVariantSlot>;

export const ButtonGroupDefaults = defineComponentDefaults({
  variant: buttonGroupVariantSlot,
  density: densitySlot(),
});
