// 窗口安全区纯计算（m3 Lane SHELL 2.1）：桌面壳以 windowControlsOverlay 创建
// 窗口时，opentray ext-webview 会向页面注入 navigator.opentrayWindow（仅
// nativeWindowApi；overlay 子对象仅当创建时声明了 windowControlsOverlay）。
// webui 不直接 import ext-webview 包——此文件用结构类型描述消费面子集，并
// 保持 DOM/框架无关：既被 ./overlay.svelte.ts（runes 反应式模块）复用，也被
// 仓库根 node 环境单测（test/unit/app/overlay.test.ts）直接测——根 tsc 无
// DOM lib，故一切写入目标（CSS 变量、状态）都以注入接口表达。

/** 标题带可用区域（CSS 像素；语义同 ext-webview 的 Rect：控件旁边的页面可用区）。 */
export interface OverlayRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** 避让内边距（px）：top = 标题带高度；left/right = 两侧控件占位（macOS 红绿灯
 *  在左 → left>0；Windows caption 在右 → right>0）。left/right 只描述标题带这一
 *  行的矩形区域，消费面是 header 的 padding-inline——不得摊到整列/整行（Owner
 *  裁决 2026-09-10：「--ot-inset-left 必须搭配 --ot-inset-top」）。 */
export interface OverlayInsets {
  top: number;
  left: number;
  right: number;
}

/** navigator.opentrayWindow.overlay 的结构子集（仅消费面成员）。 */
export interface WindowControlsOverlayBridge {
  readonly visible: boolean;
  getTitlebarAreaRect(): Promise<OverlayRect>;
  listen(
    event: "geometrychange",
    handler: (event: { titlebarAreaRect: OverlayRect }) => void,
  ): Promise<() => Promise<void>>;
}

/** navigator.opentrayWindow 的结构子集（overlay 可缺席：Windows 原生边框形态）。 */
export interface OpentrayWindowBridge {
  startAppRegionDrag(options?: {
    x?: number;
    y?: number;
    pointerId?: number;
  }): Promise<{ active: boolean }>;
  readonly overlay?: WindowControlsOverlayBridge;
}

/** navigator 的结构视图（探测注入 bridge 用；避免引用 DOM 类型）。 */
export type NavigatorLike = { opentrayWindow?: OpentrayWindowBridge };

/** 根元素 CSS 变量名：顶部避让（header 高度）。 */
export const INSET_TOP_VAR = "--ot-inset-top";
/** 根元素 CSS 变量名：标题带左端避让（header padding-inline-start）。 */
export const INSET_LEFT_VAR = "--ot-inset-left";
/** 根元素 CSS 变量名：标题带右端避让（header padding-inline-end；Windows caption）。 */
export const INSET_RIGHT_VAR = "--ot-inset-right";

/** insetTop 保守回退：overlay 可见但 rect.y 度量为 0 时仍保住标题带高度。 */
export const FALLBACK_INSET_TOP = 28;

/**
 * 标题带可用区 → 避让内边距（纯函数）。
 * 调用前提：overlay 可见（不可见路径直接归零，不走这里）。
 * - top：rect.y 即页面可开始的高度；round 后夹到 ≥0，为 0 时回退保守值 28
 *   （不可预估固定红绿灯宽度，一切以 getTitlebarAreaRect 实测为准）。
 * - left：rect.x 即左置控件（红绿灯）右侧可用区起点。
 * - right：视口宽 − rect 右缘，即右置 caption（Windows）宽度；macOS 全宽 rect 为 0。
 */
export function insetsFromRect(rect: OverlayRect, viewportWidth: number): OverlayInsets {
  const top = Math.max(0, Math.round(rect.y));
  return {
    top: top > 0 ? top : FALLBACK_INSET_TOP,
    left: Math.max(0, Math.round(rect.x)),
    right: Math.max(0, Math.round(viewportWidth - rect.x - rect.width)),
  };
}

/** CSS 变量写入目标（document.documentElement.style 的结构子集；测试替身同形）。 */
export interface CssVarSink {
  setProperty(name: string, value: string, priority?: string): void;
}

/** 把避让内边距写到根元素 CSS 变量（header 以 var() 消费）。 */
export function applyInsetVars(sink: CssVarSink, insets: OverlayInsets): void {
  sink.setProperty(INSET_TOP_VAR, `${insets.top}px`);
  sink.setProperty(INSET_LEFT_VAR, `${insets.left}px`);
  sink.setProperty(INSET_RIGHT_VAR, `${insets.right}px`);
}

/** 反应式状态汇（由 ./overlay.svelte.ts 实现，写入 $state 字段）。 */
export interface OverlayStateSink {
  update(insets: OverlayInsets, dragEnabled: boolean): void;
}

/** attachOverlay 的宿主依赖（状态 + CSS 变量写入目标 + 视口宽度源）。 */
export interface OverlayHost {
  state: OverlayStateSink;
  cssVars: CssVarSink;
  /** 视口宽度（innerWidth；geometrychange 时窗口宽度可能已变，每次现读）。 */
  viewportWidth(): number;
}

/** 归零写入（bridge 缺席 / overlay 不可见：不残留陈旧避让量）。 */
function applyZero(host: OverlayHost): void {
  host.state.update({ top: 0, left: 0, right: 0 }, false);
  applyInsetVars(host.cssVars, { top: 0, left: 0, right: 0 });
}

/**
 * 接管 overlay 探测与度量（依赖注入；返回 detach 用于解除 geometrychange 订阅）。
 * - bridge 缺席（纯浏览器 dev）或 overlay 不可见（Windows 原生边框）→ inset 全 0、
 *   dragEnabled=false；
 * - overlay 可见 → 先订阅 geometrychange 再取初值（避免度量与事件间的竞态），
 *   每次事件以 {titlebarAreaRect} 重算；
 * - 度量/订阅失败静默归零（浏览器 dev 不造安全区假象，也不抛错阻塞渲染）。
 */
export async function attachOverlay(
  win: OpentrayWindowBridge | undefined,
  host: OverlayHost,
): Promise<() => void> {
  const overlay = win?.overlay;
  if (overlay === undefined) {
    applyZero(host);
    return () => undefined;
  }

  const apply = (visible: boolean, rect: OverlayRect | undefined): void => {
    if (!visible || rect === undefined) {
      applyZero(host);
      return;
    }
    const insets = insetsFromRect(rect, host.viewportWidth());
    host.state.update(insets, true);
    applyInsetVars(host.cssVars, insets);
  };

  let unlisten: (() => void) | null = null;
  try {
    const release = await overlay.listen("geometrychange", (event) => {
      // 窗口 resize 等几何变化 → 以事件载荷即时重算（visible 顺带读当前值）
      apply(overlay.visible, event.titlebarAreaRect);
    });
    unlisten = () => {
      void release().catch(() => undefined);
    };
  } catch {
    // 订阅失败：退化为仅初值（后续 resize 度量陈旧，但不阻塞首帧）
  }

  try {
    apply(overlay.visible, await overlay.getTitlebarAreaRect());
  } catch {
    apply(false, undefined);
  }
  return () => {
    unlisten?.();
    unlisten = null;
  };
}
