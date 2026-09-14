/**
 * jixoai list-item family Defaults
 * (registry/files/ui/list-item/list-item-defaults.svelte.ts,
 * context-defaults-economy task 3.4 / W4, 2026-09-03).
 *
 * The list-item family's SINGLE declared ambient contract (design.md
 * Defaults 定位): one `ListItemDefaults` object whose slots cover
 * every vocabulary-hit style prop across the family's Item /
 * ItemGroup / ItemField / adapter files —
 *   - variant: the LITERAL family (own 'auto'), deliberately NOT a
 *     paint axis slot: the auto-chrome law is the family's own
 *     grammar (auto resolves chrome from the typed group policy —
 *     standalone rows carry their own surface, grouped rows yield
 *     it to the group), and default/outline/muted are chrome
 *     postures, not paint rungs. The list-item family is absent
 *     from the variant grammar's frozen availability table; a
 *     future table freeze promotes this slot the kbd convention.
 *     The union is the variant slot's values tuple (slot-values-first:
 *     values IS the type source, no separate union declaration);
 *     index.ts re-exports it so the public surface keeps its shape.
 *   - density: the no-opinion axis slot. ItemGroup is the family's
 *     density PROVIDER (the r11 eager-capture inherit-then-provide
 *     form); Items and adapters resolve through this slot — explicit
 *     ?? the group's (or any ancestor's) opinion, else unstamped so
 *     the ambient css scope channel keeps flowing (fleet law).
 *   - inset: the LITERAL family (own false) — ItemGroup's fixed
 *     0.75rem inline margins flag, boolean-only by contract; a
 *     boolean is a CLOSED two-value domain, so the slot takes the
 *     values form ([false, true], slot-values-first [B1]); no axis
 *     (class b per the design's coverage table).
 *   - tone: the LITERAL family (own 'muted') — ItemAfter's trailing
 *     metadata voice; no axis (class b).
 *
 * item-media's variant prop ('default' | 'icon' | 'image') is a
 * content-type discriminator, not a style rung — it rides the
 * no-style exemption, never this contract.
 *
 * 惰性律: construction captures own only; context reads happen at
 * resolve time inside the consumer's $derived window. This file is
 * a member of the registry:ui item (installs with the family, byte
 * mirrored, zero kernel imports).
 */
import { defineComponentDefaults, defineLiteralSlot } from '$lib/defaults.svelte';
import { densitySlot } from '$lib/density.svelte';

export const listItemVariantSlot = defineLiteralSlot(['auto', 'default', 'outline', 'muted'], 'auto');

/** the boolean closed domain (slot-values-first [B1]: booleans are a
 *  closed two-value domain and take the values form, not the open
 *  form) */
export const listItemInsetSlot = defineLiteralSlot([false, true], false);

export const listItemToneSlot = defineLiteralSlot(['muted', 'default'], 'muted');

/** the auto-chrome grammar — 'auto' resolves chrome from the group
 *  policy; ReturnType 反查 — the variant slot's values tuple is the
 *  union's source */
export type ItemVariant = ReturnType<typeof listItemVariantSlot>;

/** ItemAfter's trailing metadata voice; ReturnType 反查 the same way */
export type ItemTone = ReturnType<typeof listItemToneSlot>;

export const ListItemDefaults = defineComponentDefaults({
  variant: listItemVariantSlot,
  density: densitySlot(),
  inset: listItemInsetSlot,
  tone: listItemToneSlot,
});
