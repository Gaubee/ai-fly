// card — pure barrel (tw4-css-modularization D3): default = the
// canonical main; sub-components as named defaults; export * carries
// module-level named exports/types. No logic lives here.
export { default } from './card.svelte';
export * from './card.svelte';
export { default as CardHeader } from './card-header.svelte';
export { default as CardFooter } from './card-footer.svelte';
