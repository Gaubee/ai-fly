/**
 * jixoai dialog defaults (registry/files/ui/dialog/dialog-defaults.svelte.ts,
 * context-defaults-economy task 2.2, 2026-09-03).
 *
 * The dialog family's Defaults contract — the family's SINGLE declared
 * ambient contract (one `*Defaults` object per family, per the
 * component-authoring Defaults 契约). Classification per the design's
 * coverage table:
 *
 *   variant  class b, the pilot's exemplar — the floating-surface
 *            paint has a declared own ('auto': acrylic unless the
 *            environment asks for reduced transparency) and NO axis
 *            yet, so the slot is a defineLiteralSlot, values tuple
 *            first: auditable today, promotable to an axis slot
 *            when an axis opens (the spec's "a style prop with no
 *            axis yet" scenario — this file is its carrier).
 *   density  class a, the open axis with NO family own — no opinion:
 *            the panel never stamped data-density and still does not
 *            (the ambient css scope channel flows through the
 *            top-layered <dialog>, which stays a DOM descendant for
 *            cascade purposes); the slot declares the family
 *            density-manageable without manufacturing an opinion.
 *
 * zone/entity wiring stays OUT (the frozen pilot decision, X2-11):
 * Dialog's ghost ButtonVariantScope usage is untouched in place — the
 * zone side already dual-writes PAINT_ZONE_KEY through lib/paint.svelte
 * (task 1.2).
 */

import { defineComponentDefaults, defineLiteralSlot } from '$lib/defaults.svelte';
import { densitySlot } from '$lib/density.svelte';

/**
 * The floating-surface paint variant — the family grammar, single-sourced
 * here (the values tuple IS the union; dialog.svelte's Props and this
 * contract share it).
 */
export const dialogSurfaceVariantSlot = defineLiteralSlot(['solid', 'acrylic', 'auto'], 'auto');
export type DialogSurfaceVariant = ReturnType<typeof dialogSurfaceVariantSlot>;

export const DialogDefaults = defineComponentDefaults({
  variant: dialogSurfaceVariantSlot,
  density: densitySlot(),
});
