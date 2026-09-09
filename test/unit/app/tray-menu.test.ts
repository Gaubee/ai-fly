// 托盘菜单纯逻辑单测（C 车道 m2 §4.4）：菜单结构生成/勾选态/主项文案切换/
// 点击动作映射——全部纯函数，不触原生 API（opentray 类型仅 type import）。

import { describe, expect, it } from "vitest";
import {
  APP_NAME,
  MENU_CONSUMER_ID,
  MENU_OPEN_ID,
  MENU_PROVIDER_ID,
  MENU_QUIT_ID,
  buildTrayMenu,
  menuActionFor,
  type TrayMenuState,
} from "../../../src/app/tray-menu.ts";

const state = (patch: Partial<TrayMenuState>): TrayMenuState => ({
  providerRunning: false,
  gatewayRunning: false,
  windowVisible: false,
  ...patch,
});

describe("buildTrayMenu", () => {
  it("全关冷启：主项 Open、双角色 check 未勾选、分隔符与退出项就位", () => {
    const menu = buildTrayMenu(state({}));
    expect(menu.items).toEqual([
      { type: "item", id: MENU_OPEN_ID, title: `Open ${APP_NAME}`, primaryEvent: true },
      { type: "separator" },
      { type: "check", id: MENU_PROVIDER_ID, title: "Provider", checked: false },
      { type: "check", id: MENU_CONSUMER_ID, title: "Consumer gateway", checked: false },
      { type: "separator" },
      { type: "item", id: MENU_QUIT_ID, title: `Quit ${APP_NAME}` },
    ]);
  });

  it("提供方/使用方勾选态反映 host 运行态", () => {
    const menu = buildTrayMenu(state({ providerRunning: true, gatewayRunning: true }));
    const provider = menu.items[2];
    const consumer = menu.items[3];
    expect(provider).toMatchObject({ type: "check", checked: true });
    expect(consumer).toMatchObject({ type: "check", checked: true });
  });

  it("仅提供方运行时勾选态不对称", () => {
    const menu = buildTrayMenu(state({ providerRunning: true }));
    expect(menu.items[2]).toMatchObject({ checked: true });
    expect(menu.items[3]).toMatchObject({ checked: false });
  });

  it("主项文案随窗口可见性切换（Hide/Open），primaryEvent 恒定", () => {
    const shown = buildTrayMenu(state({ windowVisible: true }));
    const hidden = buildTrayMenu(state({ windowVisible: false }));
    expect(shown.items[0]).toMatchObject({ title: `Hide ${APP_NAME}`, primaryEvent: true });
    expect(hidden.items[0]).toMatchObject({ title: `Open ${APP_NAME}`, primaryEvent: true });
  });

  it("结构不变量：id 唯一且为稳定整数", () => {
    const ids = buildTrayMenu(state({}))
      .items.flatMap((item) => (item.type === "item" || item.type === "check" ? [item.id] : []))
      .map((id) => Number(id));
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids).toEqual([MENU_OPEN_ID, MENU_PROVIDER_ID, MENU_CONSUMER_ID, MENU_QUIT_ID]);
  });
});

describe("menuActionFor", () => {
  it("已知 id 映射到动作（集中路由 key）", () => {
    expect(menuActionFor(MENU_OPEN_ID)).toBe("open-toggle");
    expect(menuActionFor(MENU_PROVIDER_ID)).toBe("provider-toggle");
    expect(menuActionFor(MENU_CONSUMER_ID)).toBe("consumer-toggle");
    expect(menuActionFor(MENU_QUIT_ID)).toBe("quit");
  });

  it("未知 id 返回 null（调用方忽略）", () => {
    expect(menuActionFor(99)).toBeNull();
    expect(menuActionFor("not-a-known-item")).toBeNull();
  });
});
