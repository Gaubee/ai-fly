// 托盘菜单纯逻辑（C 车道 m2 §4.1，原始需求 2026-09-09）：菜单结构生成/状态
// 投影/点击动作映射全部为纯函数，不触任何原生 API——main.ts 的 opentray 壳只
// 做搬运（单测见 test/unit/app/tray-menu.test.ts）。
// 正交意图（本文件不实现）：托盘/窗口生命周期（main.ts）；引擎语义与事件
// （engine-host.ts）；HTTP/WS 面（web-server.ts）。
// App 身份常量在此导出：tsdown.config.ts（打包清单）与 main.ts（运行时）共用。

import type { CreateTrayMenu, MenuItemId } from "opentray";

/** 桌面应用身份（OpenTray app id 同时是打包产物寻址源，保持稳定）。 */
export const APP_ID = "dev.aifly.desktop";
export const APP_NAME = "ai-fly";

/** 托盘菜单项 id（稳定整数：集中路由 onMenuClick 的 key）。 */
export const MENU_OPEN_ID = 1;
export const MENU_PROVIDER_ID = 2;
export const MENU_CONSUMER_ID = 3;
export const MENU_QUIT_ID = 4;

/** 菜单状态快照：双角色运行态 + 主窗口可见性。 */
export interface TrayMenuState {
  providerRunning: boolean;
  gatewayRunning: boolean;
  windowVisible: boolean;
}

/** 菜单点击解析出的动作（main.ts 据此分发；保持穷尽）。 */
export type TrayAction = "open-toggle" | "provider-toggle" | "consumer-toggle" | "quit";

const ACTION_BY_ITEM_ID: ReadonlyMap<number, TrayAction> = new Map([
  [MENU_OPEN_ID, "open-toggle"],
  [MENU_PROVIDER_ID, "provider-toggle"],
  [MENU_CONSUMER_ID, "consumer-toggle"],
  [MENU_QUIT_ID, "quit"],
]);

/**
 * 状态 → opentray 菜单结构。
 * 提供方/使用方为 check 项（勾选态反映 host 运行态）；主项文案随主窗口
 * 可见性切换（app-mode.md：可见性真相来自 isVisible()/visibleChange）。
 * 文案英文 ASCII（与 CLI/RPC 面一致）。
 */
export function buildTrayMenu(state: TrayMenuState): CreateTrayMenu {
  return {
    items: [
      {
        type: "item",
        id: MENU_OPEN_ID,
        title: state.windowVisible ? `Hide ${APP_NAME}` : `Open ${APP_NAME}`,
        primaryEvent: true,
      },
      { type: "separator" },
      {
        type: "check",
        id: MENU_PROVIDER_ID,
        title: "Provider",
        checked: state.providerRunning,
      },
      {
        type: "check",
        id: MENU_CONSUMER_ID,
        title: "Consumer gateway",
        checked: state.gatewayRunning,
      },
      { type: "separator" },
      { type: "item", id: MENU_QUIT_ID, title: `Quit ${APP_NAME}` },
    ],
  };
}

/** itemId → 动作（未知 id 返回 null，调用方忽略）。 */
export function menuActionFor(itemId: MenuItemId): TrayAction | null {
  return ACTION_BY_ITEM_ID.get(itemId) ?? null;
}
