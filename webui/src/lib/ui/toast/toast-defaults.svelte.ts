/**
 * jixoai toast family Defaults
 * (registry/files/ui/toast/toast-defaults.svelte.ts,
 * context-defaults-economy task 3.2, 2026-09-03).
 *
 * The toast family's SINGLE declared ambient contract (design.md
 * Defaults 定位): one `ToastDefaults` object whose slots cover the
 * family's style-class props. Toast's style props ride the STORE
 * ITEM (ToastInit — a push is the "explicit" lane), so the viewport
 * resolves each item's paint through this contract (the toast-v2
 * state machine is untouched by construction — the slots are pure
 * `explicit ?? own`, never reading context):
 *
 *   variant   the ladder prominence, own 'outline' — the plain
 *             notice (kbd mode, r11: toast is absent from the
 *             variant grammar's frozen availability table; a table
 *             row promotes this slot to a paint slot, values carried
 *             over). LIB SINGLE-SOURCE (slot-values-first r12 #6):
 *             the values tuple is $lib/toast-store's
 *             TOAST_VARIANT_VALUES (the store item's own domain —
 *             ui→lib is the legal direction; no handwritten union
 *             may coexist).
 *   material  the surface MATERIAL axis (float-button's model),
 *             own 'popover' — the solid ground; 'glass' is the
 *             backdrop-filter translucent (the entity law's
 *             restrained ground). Independent of variant by law.
 *             Lib-single-sourced the same way
 *             (TOAST_MATERIAL_VALUES).
 *   density   the no-opinion axis slot. The toast carries NO density
 *             own: the card geometry rides the density tokens via
 *             the ambient css scope channel (fleet law) — no
 *             provider and no explicit prop stamp anything.
 *
 * 惰性律: construction captures own only; context reads happen at
 * resolve time inside the consumer's $derived window. This file is a
 * member of the registry:ui item (installs with the family, byte
 * mirrored, zero kernel imports).
 */
import { defineComponentDefaults, defineLiteralSlot } from '$lib/defaults.svelte';
import { densitySlot } from '$lib/density.svelte';
import { TOAST_MATERIAL_VALUES, TOAST_VARIANT_VALUES } from '$lib/toast-store';

export const toastVariantSlot = defineLiteralSlot(TOAST_VARIANT_VALUES, 'outline');

export const toastMaterialSlot = defineLiteralSlot(TOAST_MATERIAL_VALUES, 'popover');

export const ToastDefaults = defineComponentDefaults({
  variant: toastVariantSlot,
  material: toastMaterialSlot,
  density: densitySlot(),
});
