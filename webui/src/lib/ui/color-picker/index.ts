// color-picker — pure barrel (tw4-css-modularization D3): default =
// the canonical main; sub-components as named defaults; export *
// carries module-level named exports/types. No logic lives here.
export { default } from './color-picker.svelte';
export { default as Editor } from './editor.svelte';
export { default as Swatches } from './swatches.svelte';
export * from './color-picker.svelte';
export { ColorPickerDefaults, type ColorPickerSurfaceVariant } from './color-picker-defaults.svelte';
