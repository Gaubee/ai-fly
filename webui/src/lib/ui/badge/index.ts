// badge — pure barrel (tw4-css-modularization D3): default =
// the canonical main; sub-components as named defaults; export *
// carries module-level named exports/types. No logic lives here.
export { default } from './badge.svelte';
export * from './badge.svelte';
export { BadgeDefaults, type BadgeVariant, type BadgeShape } from './badge-defaults.svelte';
