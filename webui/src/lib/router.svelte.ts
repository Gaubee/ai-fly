// hash 路由（B 3.1）：#/dashboard、#/share、#/connect、#/advanced。
// 选 hash 而非 history：daemon 的 SPA 回退虽已支持深链，但 webview 一次性
// token URL 固定落在 /，hash 路由在刷新/直达时零服务端依赖且不与 token
// 兑换的 303 转址打架。
export type RouteId = "dashboard" | "share" | "connect" | "advanced";

export const ROUTES: readonly RouteId[] = ["dashboard", "share", "connect", "advanced"];

/** 解析 location.hash → 路由（未知/缺席归 dashboard）。 */
export function parseHash(hash: string): RouteId {
  const head = hash.replace(/^#\/?/, "").split(/[/?]/)[0] ?? "";
  return (ROUTES as readonly string[]).includes(head) ? (head as RouteId) : "dashboard";
}

class Router {
  /** 当前路由（$state：hashchange 与 navigate() 双向驱动）。 */
  current = $state<RouteId>("dashboard");

  /** 开始监听（App 挂载时调用一次）。 */
  start(): void {
    const apply = (): void => {
      this.current = parseHash(window.location.hash);
    };
    window.addEventListener("hashchange", apply);
    apply();
  }

  /** 编程式导航（与 <a href="#/..."> 等价；重复 hash 不产生历史项）。 */
  navigate(route: RouteId): void {
    const target = `#/${route}`;
    if (window.location.hash === target) {
      this.current = route;
    } else {
      window.location.hash = target;
    }
  }
}

/** 应用级单例路由。 */
export const router = new Router();
