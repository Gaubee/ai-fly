// 窗口安全区单测（m3 Lane SHELL 2.3）：测 webui/src/lib/overlay-geometry.ts 的
// 纯计算与依赖注入编排（反应式薄壳 overlay.svelte.ts 仅做 $state 接线，由
// svelte-check/build 把关，node 侧不 import runes 文件）：
// - bridge 缺席（纯浏览器 dev）/ overlay 不可见（Windows 原生边框）→ inset 全
//   0、dragEnabled=false、CSS 变量写 0px（不造安全区假象）；
// - overlay 可见 → getTitlebarAreaRect 度量（不可预估控件宽度，一切以实测为准）
//   写 --ot-inset-top / --ot-inset-left；
// - geometrychange（窗口 resize）回调以事件载荷即时重算；
// - detach 解除订阅（窗口卸载/unlisten）。
// CSS 变量写入用与 document.documentElement.style 同形的替身断言（vitest 为
// node 环境，无 DOM）。

import { describe, expect, it } from "vitest";
import {
  FALLBACK_INSET_TOP,
  INSET_LEFT_VAR,
  INSET_TOP_VAR,
  attachOverlay,
  insetsFromRect,
  type OpentrayWindowBridge,
  type OverlayHost,
  type OverlayInsets,
  type OverlayRect,
} from "../../../webui/src/lib/overlay-geometry.ts";

/** 宿主替身：记录状态写入 + 以 Map 模拟 CSSStyleDeclaration.setProperty。 */
function makeHost(): {
  host: OverlayHost;
  vars: Map<string, string>;
  updates: Array<{ insets: OverlayInsets; dragEnabled: boolean }>;
  last(): { insets: OverlayInsets; dragEnabled: boolean } | undefined;
} {
  const vars = new Map<string, string>();
  const updates: Array<{ insets: OverlayInsets; dragEnabled: boolean }> = [];
  return {
    host: {
      state: {
        update: (insets, dragEnabled): void => {
          updates.push({ insets, dragEnabled });
        },
      },
      cssVars: {
        setProperty: (name, value): void => {
          vars.set(name, value);
        },
      },
    },
    vars,
    updates,
    last: () => updates.at(-1),
  };
}

/** 假 opentrayWindow bridge：记录 geometrychange 订阅与 unlisten 调用。 */
function makeFakeWindow(options: {
  visible?: boolean;
  rect?: OverlayRect;
  rectError?: boolean;
} = {}): {
  win: OpentrayWindowBridge;
  fire(rect: OverlayRect): void;
  released(): number;
} {
  const handlers: Array<(event: { titlebarAreaRect: OverlayRect }) => void> = [];
  let released = 0;
  const rect = options.rect ?? { x: 78, y: 28, width: 900, height: 24 };
  const win: OpentrayWindowBridge = {
    overlay: {
      visible: options.visible ?? true,
      getTitlebarAreaRect: () =>
        options.rectError === true
          ? Promise.reject(new Error("measure failed"))
          : Promise.resolve({ ...rect }),
      listen: (_event, handler) => {
        handlers.push(handler);
        return Promise.resolve(async () => {
          released += 1;
          const at = handlers.indexOf(handler);
          if (at >= 0) handlers.splice(at, 1);
        });
      },
    },
    startAppRegionDrag: () => Promise.resolve({ active: true }),
  };
  return {
    win,
    fire: (next) => {
      for (const handler of [...handlers]) handler({ titlebarAreaRect: next });
    },
    released: () => released,
  };
}

describe("insetsFromRect（度量纯函数）", () => {
  it("标准 macOS 形态：y 即标题带高度、x 即红绿灯右缘，四舍五入取整", () => {
    expect(insetsFromRect({ x: 77.6, y: 28.4, width: 900, height: 24 })).toEqual({
      top: 28,
      left: 78,
    });
  });

  it("Linux 右置控件形态：x=0 → 左避让 0", () => {
    expect(insetsFromRect({ x: 0, y: 28, width: 900, height: 24 })).toEqual({
      top: 28,
      left: 0,
    });
  });

  it("y 度量为 0 时回退保守标题带高度；负值钳 0", () => {
    expect(insetsFromRect({ x: 78, y: 0, width: 900, height: 0 }).top).toBe(FALLBACK_INSET_TOP);
    expect(insetsFromRect({ x: -5, y: -3, width: 900, height: 0 })).toEqual({
      top: FALLBACK_INSET_TOP,
      left: 0,
    });
  });
});

describe("attachOverlay（探测 + 订阅编排）", () => {
  it("bridge 缺席（纯浏览器 dev）→ inset 全 0、dragEnabled=false、CSS 变量归零", async () => {
    const { host, vars, last } = makeHost();
    const detach = await attachOverlay(undefined, host);
    expect(last()).toEqual({ insets: { top: 0, left: 0 }, dragEnabled: false });
    expect(vars.get(INSET_TOP_VAR)).toBe("0px");
    expect(vars.get(INSET_LEFT_VAR)).toBe("0px");
    detach();
  });

  it("bridge 存在但无 overlay（Windows 原生边框）→ 同样归零，不订阅", async () => {
    const { host, last } = makeHost();
    const win: OpentrayWindowBridge = {
      startAppRegionDrag: () => Promise.resolve({ active: false }),
    };
    await attachOverlay(win, host);
    expect(last()).toEqual({ insets: { top: 0, left: 0 }, dragEnabled: false });
  });

  it("overlay 可见：rect {x:78,y:28} → insetTop 28 / insetLeft 78，CSS 变量写入根元素", async () => {
    const { host, vars, last } = makeHost();
    const fake = makeFakeWindow({ visible: true, rect: { x: 78, y: 28, width: 900, height: 24 } });
    await attachOverlay(fake.win, host);
    expect(last()).toEqual({ insets: { top: 28, left: 78 }, dragEnabled: true });
    expect(vars.get(INSET_TOP_VAR)).toBe("28px");
    expect(vars.get(INSET_LEFT_VAR)).toBe("78px");
  });

  it("overlay 不可见（visible=false）→ 归零且 dragEnabled=false", async () => {
    const { host, last } = makeHost();
    const fake = makeFakeWindow({ visible: false, rect: { x: 78, y: 28, width: 900, height: 24 } });
    await attachOverlay(fake.win, host);
    expect(last()).toEqual({ insets: { top: 0, left: 0 }, dragEnabled: false });
  });

  it("geometrychange（窗口 resize）→ 以事件载荷即时重算", async () => {
    const { host, vars, last } = makeHost();
    const fake = makeFakeWindow({ rect: { x: 78, y: 28, width: 900, height: 24 } });
    await attachOverlay(fake.win, host);
    fake.fire({ x: 0, y: 32.4, width: 400, height: 24 });
    expect(last()).toEqual({ insets: { top: 32, left: 0 }, dragEnabled: true });
    expect(vars.get(INSET_TOP_VAR)).toBe("32px");
    expect(vars.get(INSET_LEFT_VAR)).toBe("0px");
  });

  it("初值度量失败 → 静默归零（不抛错、不造安全区假象）", async () => {
    const { host, last } = makeHost();
    const fake = makeFakeWindow({ rectError: true });
    await attachOverlay(fake.win, host);
    expect(last()).toEqual({ insets: { top: 0, left: 0 }, dragEnabled: false });
  });

  it("detach → 解除 geometrychange 订阅（窗口卸载/unlisten）", async () => {
    const { host } = makeHost();
    const fake = makeFakeWindow();
    const detach = await attachOverlay(fake.win, host);
    detach();
    expect(fake.released()).toBe(1);
    // detach 后事件不再驱动状态
    const before = host.state.update;
    let calls = 0;
    host.state.update = (...args: Parameters<typeof before>) => {
      calls += 1;
      return before(...args);
    };
    fake.fire({ x: 10, y: 40, width: 400, height: 24 });
    expect(calls).toBe(0);
  });
});
