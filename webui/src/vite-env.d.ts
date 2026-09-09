/// <reference types="svelte" />
/// <reference types="vite/client" />

// tsc 直检 .ts 的最小垫片：.svelte 模块类型由 svelte-check/B 车道负责
// （vendored 组件在 noUncheckedIndexedAccess 级别下存在上游类型债，A 车道
// 仅保证 vite build 通过 + 自有 .ts 类型干净）。
declare module "*.svelte" {
  import type { Component } from "svelte";
  const component: Component;
  export default component;
}
