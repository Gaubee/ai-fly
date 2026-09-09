/**
 * jixoai control-chrome axis (registry/files/lib/control-chrome.svelte.ts,
 * 2026-09-05 — the B5 pivot, Owner ruling: "组件不支持就去升级组件，
 * 而不是入侵样式").
 *
 * TYPES + KEY ONLY. The context operations live INLINE in the .svelte
 * files (providers: item-field/item-group; readers: the control
 * families) — under vite dev AND vitest, a .svelte.ts module's public
 * 'svelte' import binds a second runtime copy whose set/getContext
 * never see the component graph (empirically proven twice; the working
 * probe called them inline). PAINT_ZONE's exact shape otherwise:
 * global-symbol key, getter-endorsed payload, explicit ?? ambient ??
 * 'frame' resolution, each family's OWN sheet painting its bare state.
 */
export type ControlChrome = 'frame' | 'bare';

/** axis-level key — global symbol registry (the PAINT_ZONE_KEY shape) */
export const CONTROL_CHROME_KEY = Symbol.for('jx-control-chrome');
