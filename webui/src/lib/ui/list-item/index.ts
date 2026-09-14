// jixoai list-item 组件族（vendored 子集，2026-09-14 自 jixoai-labs/ui registry）：
// 仅布局核心（Item/Content/Title/Description/Actions/After/End/Group/Header/
// Footer/Divider/Chevron）；表单控件类子组件（checkbox/radio/input/select/
// stepper/toggle/segmented/media/field）依赖本仓库未引入的组件族，未随迁。
// 完整族见上游 registry/files/ui/list-item。

export type { ItemVariant, ItemTone } from './list-item-defaults.svelte';
/** the RESOLVED chrome stamped as data-item-chrome (never 'auto' in DOM) */
export type ItemChrome = 'surface' | 'none' | 'outline' | 'muted';
export type ItemLayout = 'auto' | 'standard' | 'media';
export type ItemGroupMode = 'default' | 'muted' | 'plain';
export type ItemDividers = 'auto' | 'none';
export type ItemEndFit = 'md' | 'lg' | 'full';
export type ItemEndInset = 'auto' | number | boolean;
export { default as Item } from './item.svelte';
export { default as ItemGroup } from './item-group.svelte';
export { default as ItemEnd } from './item-end.svelte';
export { default as ItemAfter } from './item-after.svelte';
export { default as ItemChevron } from './item-chevron.svelte';
export { default as ItemDivider } from './item-divider.svelte';
export { default as ItemContent } from './item-content.svelte';
export { default as ItemTitle } from './item-title.svelte';
export { default as ItemDescription } from './item-description.svelte';
export { default as ItemActions } from './item-actions.svelte';
export { default as ItemHeader } from './item-header.svelte';
export { default as ItemFooter } from './item-footer.svelte';
