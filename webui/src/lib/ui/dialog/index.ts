// dialog — pure barrel (tw4-css-modularization D3): default =
// the canonical main; sub-components as named defaults; export *
// carries module-level named exports/types. No logic lives here.
export { default } from './dialog.svelte';
export * from './dialog.svelte';
export { default as DialogHeader } from './dialog-header.svelte';
export { default as DialogFooter } from './dialog-footer.svelte';
export { DialogDefaults, type DialogSurfaceVariant } from './dialog-defaults.svelte';
