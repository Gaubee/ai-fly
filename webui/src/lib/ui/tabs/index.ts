// tabs — pure barrel (tw4-css-modularization D3): default =
// the canonical main; sub-components as named defaults; export *
// carries module-level named exports/types. No logic lives here.
export { default } from './tabs.svelte';
export * from './tabs.svelte';
export { default as TabsContent } from './tabs-content.svelte';
export * from './tabs-content.svelte';
export { default as TabsList } from './tabs-list.svelte';
export * from './tabs-list.svelte';
export { default as TabsTrigger } from './tabs-trigger.svelte';
export * from './tabs-trigger.svelte';
export { TabsDefaults } from './tabs-defaults.svelte';
