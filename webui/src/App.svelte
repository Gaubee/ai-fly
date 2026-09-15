<!-- 应用骨架（B 3.1）：顶部 appHeader（品牌 + 连接状态 + theme-toggle，
     全部 inline-end 挂状态件）+ 左侧导航（Dashboard / 分享向导 / 接入向导 /
     高级设置）+ hash 路由出口 + ToastViewport。
     空数据首屏由 Dashboard 渲染（两条向导大入口卡，spec「首屏三步可达」）。
     桌面 overlay 安全区（m3 2.1/2.2，Owner 裁决 2026-09-10 修订）：--ot-inset-left
     只描述左上角控件矩形，必须搭配 --ot-inset-top 消费在 header 上——header
     高度 ≥ inset-top，padding-inline-start/end = inset-left/right；整列/整行不再摊派。
     header 同时是拖拽带（pointerdown → startAppRegionDrag）；header 内有交互元素
     （theme-toggle），拖拽守卫跳过 button/a 等命中；浏览器 dev 归零无假象。 -->
<script lang="ts">
  import { onMount } from "svelte";
  import ToastViewport from "$lib/ui/toast";
  import ThemeToggle from "$lib/ui/theme-toggle";
  import Alert from "$lib/ui/alert";
  import Badge from "$lib/ui/badge";
  import PressButton from "$lib/ui/press-button";
  import { router, type RouteId } from "$lib/router.svelte.ts";
  import { startOverlay, beginWindowDrag } from "$lib/overlay.svelte.ts";
  import { rpcState } from "./stores/rpc.svelte.ts";
  import { locale, setLocale, t, type Locale } from "$lib/i18n.svelte.ts";
  import { startApp, app } from "./stores/app.svelte.ts";
  import { toast } from "./stores/toast.svelte.ts";
  import { serviceRemove, removeService } from "./stores/advanced.svelte.ts";
  // app 图标：直接引仓库 resources/icon.svg（app:icons 同一源，vite asset
  // import 走 fs.allow 工作区；build 期拷入 dist/assets，零手工同步）
  import iconUrl from "../../resources/icon.svg";
  import Dashboard from "./pages/Dashboard.svelte";
  import ShareWizard from "./pages/ShareWizard.svelte";
  import ConnectWizard from "./pages/ConnectWizard.svelte";
  import Advanced from "./pages/Advanced.svelte";

  onMount(() => {
    startOverlay();
    router.start();
    startApp();
  });

  const NAV: ReadonlyArray<{ id: RouteId; label: string; hint: string }> = [
    { id: "dashboard", label: "shell.nav.dashboard", hint: "shell.nav.dashboard.hint" },
    { id: "share", label: "shell.nav.share", hint: "shell.nav.share.hint" },
    { id: "connect", label: "shell.nav.connect", hint: "shell.nav.connect.hint" },
    { id: "advanced", label: "shell.nav.advanced", hint: "shell.nav.advanced.hint" },
  ];

  const disconnected = $derived(rpcState.status !== "open");

  /** legacy（pre-v2）存储态（hooks-lifecycle 7.4）：顶部失效横幅——
   *  「界面可用」语义冻结：页面正常加载、全部入口可见；服务/分组/分享
   *  密钥提交在表单侧渲染 INVALID_STATE 引导（ErrorAlert）；密钥面板
   *  读写独立文件照常可用。旧条目全部移除后横幅消失。 */
  const legacyNames = $derived(app.ready ? app.legacyServiceNames : []);
  // 横幅判据用 provider.status.legacy 本体（而非名册长度）：空名册的 legacy
  // 态（恶形条目）同样需要失效提示（复核 R2-P2）。
  const legacyActive = $derived(app.ready && app.provider?.legacy != null);

  /** header 拖拽守卫：命中交互元素（theme-toggle 等）不触发窗口拖拽。 */
  function onHeaderPointerDown(event: PointerEvent & { currentTarget: EventTarget & HTMLElement }): void {
    if ((event.target as HTMLElement).closest("button, a, input, select, textarea, [role='button']") !== null) return;
    beginWindowDrag();
  }
</script>

<!-- 不挂 .jx-pure（Owner 视觉验收 2026-09-13 #6）：裸元素面只该罩内容
     块（upstream 惯例——markdown 容器），罩在应用根会把 jixoai 组件里的
     裸 button（tabs/select/dropdown/popover）全部画成描边+硬阴影的 raised
     块，与组件库默认皮肤冲突。页面里需要 bare 面的元素自带 utility paint。 -->
<div class="flex h-dvh flex-col bg-background text-foreground">
  <!-- appHeader：品牌 inline-start（单行——font-nav 纵向度量大，双行会溢出
       固定高度；min-height 而非 height，内容再高也撑开不裁切）；inline-end
       = 连接状态（合并原连接横幅与左下角 offline 指示）+ theme-toggle。
       高度 ≥ --ot-inset-top（保底 44px），padding-inline 承接左/右控件矩形
       （红绿灯 / Windows caption）；原生控件由系统绘制于更上层。 -->
  <header
    role="presentation"
    class="flex shrink-0 select-none items-center justify-between gap-2 border-b border-border bg-muted/30"
    style="min-height: max(var(--ot-inset-top, 0px), 44px); padding-inline-start: calc(var(--ot-inset-left, 0px) + 0.75rem); padding-inline-end: calc(var(--ot-inset-right, 0px) + 0.75rem)"
    onpointerdown={onHeaderPointerDown}
  >
    <div class="flex min-w-0 items-center gap-2">
      <img src={iconUrl} alt="" class="size-[22px] flex-none" />
      <span class="flex-none font-nav text-sm leading-none tracking-[0.08em]">ai-fly</span>
      <span class="truncate text-[10px] leading-none text-muted-foreground">{t("shell.tagline")}</span>
    </div>
    <div class="flex flex-none items-center gap-3">
      <label class="sr-only" for="app-locale">language</label>
      <select
        id="app-locale"
        class="cursor-pointer border-none bg-transparent font-nav text-[10px] uppercase tracking-[0.1em] text-muted-foreground focus:outline-none"
        value={locale()}
        onchange={(event) => setLocale((event.currentTarget as HTMLSelectElement).value as Locale)}
      >
        <option value="en">EN</option>
        <option value="zh">中文</option>
      </select>
      <span
        class="flex items-center gap-1.5 font-nav text-[10px] uppercase tracking-[0.1em] text-muted-foreground"
        role="status"
        aria-live="polite"
      >
        <span
          class="size-1.5 rounded-full {disconnected
            ? 'animate-pulse bg-muted-foreground/60'
            : 'bg-primary'}"
          aria-hidden="true"
        ></span>
        {t(disconnected ? (rpcState.status === "connecting" ? "shell.status.connecting" : "shell.status.reconnecting") : "shell.status.online")}
      </span>
      <ThemeToggle variant="compact" />
    </div>
  </header>

  <!-- legacy 失效横幅（hooks-lifecycle 7.4）：旧版配置已失效——只读名册 +
       移除（busy 锁 + 二次确认）；全部移除后 store 重建 v2，横幅消失。
       条件挂 provider.status.legacy（复核 R2-P2）：空名册（无法按名移除的
       恶形条目）也要给横幅与人工清理指引，不能静默锁死。 -->
  {#if legacyActive}
    <Alert variant="tonal" class="jx-hue-warning m-3" title={t("legacy.bannerTitle")}>
      <p class="text-xs leading-relaxed">{t("legacy.bannerBody")}</p>
      {#if legacyNames.length === 0}
        <p class="text-xs leading-relaxed text-muted-foreground">{t("legacy.noNames")}</p>
      {:else}
        <div class="mt-2 flex flex-col gap-1.5">
          {#each legacyNames as name (name)}
            <div class="flex flex-wrap items-center gap-2 border border-border/70 bg-card px-2.5 py-1.5">
              <span class="min-w-0 truncate font-mono text-xs">{name}</span>
              <Badge variant="tonal" class="jx-hue-warning">{t("legacy.badge")}</Badge>
              <span class="ml-auto flex items-center gap-1.5">
                {#if serviceRemove.confirm === name}
                  <PressButton
                    variant="tonal"
                    class="jx-pair-destructive"
                    loading={serviceRemove.busy === name}
                    onclick={() => void removeService(name)}
                  >{t("common.confirmRemove")}</PressButton>
                  <PressButton variant="ghost" onclick={() => (serviceRemove.confirm = "")}>{t("common.cancel")}</PressButton>
                {:else}
                  <PressButton
                    variant="ghost"
                    onclick={() => (serviceRemove.confirm = name)}
                  >{t("common.remove")}</PressButton>
                {/if}
              </span>
            </div>
          {/each}
        </div>
      {/if}
    </Alert>
  {/if}

  <div class="flex min-h-0 flex-1">
    <!-- 左侧导航：品牌与状态件已上移 appHeader，控件避让由 header 承担 -->
    <nav class="flex w-44 shrink-0 flex-col border-r border-border bg-muted/30" aria-label="main">
      <div class="flex flex-col gap-0.5 p-2">
        {#each NAV as item (item.id)}
          <a
            href={`#/${item.id}`}
            class="flex flex-col gap-0.5 border px-2.5 py-2 transition-colors
              {router.current === item.id
                ? 'border-primary/40 bg-primary/10 text-foreground'
                : 'border-transparent text-muted-foreground hover:bg-muted hover:text-foreground'}"
            aria-current={router.current === item.id ? "page" : undefined}
          >
            <span class="font-nav text-xs uppercase tracking-[0.1em]">{t(item.label)}</span>
            <span class="text-[10px] leading-tight">{t(item.hint)}</span>
          </a>
        {/each}
      </div>
    </nav>

    <!-- 路由出口 -->
    <main class="min-w-0 flex-1 overflow-y-auto">
      {#if router.current === "dashboard"}
        <Dashboard />
      {:else if router.current === "share"}
        <ShareWizard />
      {:else if router.current === "connect"}
        <ConnectWizard />
      {:else}
        <Advanced />
      {/if}
    </main>
  </div>
</div>

<ToastViewport store={toast} />
