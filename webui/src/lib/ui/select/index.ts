// select — pure barrel (tw4-css-modularization D3): default =
// the canonical main; sub-components as named defaults; export *
// carries module-level named exports/types. No logic lives here.
export { default } from './select.svelte';
export * from './select.svelte';
export { SelectDefaults, type SelectSurfaceVariant } from './select-defaults.svelte';
