// date-picker — pure barrel (tw4-css-modularization D3): default =
// the canonical main; sub-components as named defaults; export *
// carries module-level named exports/types. No logic lives here.
// Calendar extraction (2026-08-28): Calendar (the embeddable month
// grid) and the calendar-math vocabulary are first-class exports —
// the Input picker bridge consumes them without the popover host.
export { default } from './date-picker.svelte';
export * from './date-picker.svelte';
export { default as Calendar } from './calendar.svelte';
export * from './calendar-math.ts';
export { DatePickerDefaults, type DatePickerSurfaceVariant } from './date-picker-defaults.svelte';
