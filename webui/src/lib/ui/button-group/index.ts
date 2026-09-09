// button-group — pure barrel (tabs precedent): default = the canonical
// main; sub-parts as named defaults; export * carries module-level
// named exports/types. No logic lives here.
export { default } from './button-group.svelte';
export * from './button-group.svelte';
export { default as ButtonGroupDivider } from './button-group-divider.svelte';
export * from './button-group-divider.svelte';
export { default as ButtonVariantScope } from './button-variant-scope.svelte';
export * from './button-variant-scope.svelte';
export { ButtonGroupDefaults, type ButtonGroupVariant } from './button-group-defaults.svelte';
