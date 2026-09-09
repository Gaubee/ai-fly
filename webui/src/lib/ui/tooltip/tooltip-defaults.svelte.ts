/**
 * jixoai tooltip family Defaults
 * (registry/files/ui/tooltip/tooltip-defaults.svelte.ts,
 * context-defaults-economy task 3.2, 2026-09-03).
 *
 * The tooltip family's SINGLE declared ambient contract (design.md
 * Defaults 定位): one `TooltipDefaults` object whose slots cover every
 * vocabulary-hit style prop —
 *   - variant: class b, the dialog/sheet exemplar's twin — the
 *     floating-surface paint has a declared own ('auto': acrylic unless
 *     the environment asks for reduced transparency) and NO axis yet,
 *     so the slot is a defineLiteralSlot whose values tuple declares
 *     the union: auditable today, promotable to an axis slot when an
 *     axis opens. (kbd mode, r11: tooltip is absent from the variant
 *     grammar's frozen availability table — a paint family must be
 *     frozen before it ships a paint slot; the table gaining a Tooltip
 *     row promotes this slot the badge/chip convention, values
 *     carried over.)
 *   - density: class a, the open axis with NO family own — no
 *     opinion: the panel never stamped data-density and still does
 *     not; the slot declares the family density-manageable without
 *     manufacturing an opinion (the ambient css scope channel keeps
 *     flowing through the top-layered popover panel).
 *
 * 惰性律: construction captures own only; context reads happen at
 * resolve time inside the consumer's $derived window. This file is a
 * member of the registry:ui item (installs with the family, byte
 * mirrored, zero kernel imports).
 */
import { defineComponentDefaults, defineLiteralSlot } from '$lib/defaults.svelte';
import { densitySlot } from '$lib/density.svelte';

export const tooltipSurfaceVariantSlot = defineLiteralSlot(['solid', 'acrylic', 'auto'], 'auto');

/**
 * The floating-surface paint variant — the family grammar, single-sourced
 * here (tooltip.svelte's Props and this contract share the one union; the
 * dialog/sheet families declare their own same-shaped unions). ReturnType
 * 反查 — the slot's values tuple is the union's source.
 */
export type TooltipSurfaceVariant = ReturnType<typeof tooltipSurfaceVariantSlot>;

export const TooltipDefaults = defineComponentDefaults({
  variant: tooltipSurfaceVariantSlot,
  density: densitySlot(),
});
