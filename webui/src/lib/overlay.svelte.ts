// 窗口安全区反应式模块（m3 Lane SHELL 2.1/2.2）：App 挂载时 startOverlay()
// 探测 opentray ext-webview 注入的 navigator.opentrayWindow（webui 不 import
// 该包，用结构类型断言取消费面），度量标题带 → 根元素 CSS 变量 + $state。
// 探测/度量/订阅的纯逻辑在 ./overlay-geometry.ts（node 单测直接测那份）。
import {
  attachOverlay,
  type OpentrayWindowBridge,
  type NavigatorLike,
} from "./overlay-geometry.ts";

/** 安全区状态（$state：App 壳与拖拽带直接读取）。 */
export const overlay = $state({
  /** 顶部避让（标题带高度 px；overlay 不可见时 0——不造安全区假象）。 */
  insetTop: 0,
  /** 左侧避让（红绿灯右缘 px；仅 macOS 左置控件非 0）。 */
  insetLeft: 0,
  /** 拖拽带可用（= overlay 可见；Windows 原生边框 / 纯浏览器 dev 为 false）。 */
  dragEnabled: false,
});

let started = false;
let detach: (() => void) | null = null;

/** 读取注入的 opentrayWindow bridge（缺席 → undefined）。 */
function bridgeOf(): OpentrayWindowBridge | undefined {
  return (navigator as NavigatorLike).opentrayWindow;
}

/**
 * 启动安全区探测（App 挂载时调用一次；幂等，HMR 重挂不重入）。
 * 结果写 $state 与 documentElement CSS 变量（--ot-inset-top / --ot-inset-left）。
 */
export function startOverlay(): void {
  if (started) return;
  started = true;
  void attachOverlay(bridgeOf(), {
    state: {
      update: (insets, dragEnabled) => {
        overlay.insetTop = insets.top;
        overlay.insetLeft = insets.left;
        overlay.dragEnabled = dragEnabled;
      },
    },
    cssVars: document.documentElement.style,
  }).then((stop) => {
    detach = stop;
  });
  // 窗口卸载（webview 关闭 / 页面卸载）时解除 geometrychange 订阅
  window.addEventListener(
    "pagehide",
    () => {
      detach?.();
      detach = null;
    },
    { once: true },
  );
}

/**
 * 顶部拖拽带 / 断连横幅的 pointerdown 入口：overlay 可见时交给原生窗口拖拽。
 * 带（与横幅）内不放交互元素，被带盖住的区域点击一律转为移动窗口。
 */
export function beginWindowDrag(): void {
  if (!overlay.dragEnabled) return;
  const bridge = bridgeOf();
  if (bridge === undefined) return;
  // 拒绝（如指针序列不合法返回 active:false）静默即可，不打扰 UI
  void bridge.startAppRegionDrag().catch(() => undefined);
}
