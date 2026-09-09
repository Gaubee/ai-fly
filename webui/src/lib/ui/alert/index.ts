// alert — pure barrel (tw4-css-modularization D3): default =
// the canonical main; sub-components as named defaults; export *
// carries module-level named exports/types. No logic lives here.
export { default } from './alert.svelte';
export * from './alert.svelte';
export { AlertDefaults, type AlertVariant } from './alert-defaults.svelte';
