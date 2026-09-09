// dropdown-menu — pure barrel (tw4-css-modularization D3): default =
// the canonical main; sub-components as named defaults; export *
// carries module-level named exports/types. No logic lives here.
export { default } from './dropdown-menu.svelte';
export * from './dropdown-menu.svelte';
export { default as DropdownMenuItem } from './dropdown-menu-item.svelte';
export * from './dropdown-menu-item.svelte';
export { DropdownMenuDefaults, type DropdownMenuSurfaceVariant } from './dropdown-menu-defaults.svelte';
