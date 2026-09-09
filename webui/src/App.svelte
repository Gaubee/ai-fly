<!-- 应用骨架（B 3.1）：左侧导航（Dashboard / 分享向导 / 接入向导 / 高级设置）
     + theme-toggle + 连接横幅 + hash 路由出口 + ToastViewport。
     空数据首屏由 Dashboard 渲染（两条向导大入口卡，spec「首屏三步可达」）。
     桌面 overlay 安全区（m3 2.1/2.2，Owner 裁决 2026-09-10 修订）：--ot-inset-left
     只描述左上角控件矩形，必须搭配 --ot-inset-top 消费在 header 上——header 高度
     ≥ inset-top，padding-inline-start/end = inset-left/right；整列/整行不再摊派。
     header 同时是拖拽带（pointerdown → startAppRegionDrag）；浏览器 dev 归零无假象。 -->
<script lang="ts">
  import { onMount } from "svelte";
  import ToastViewport from "$lib/ui/toast";
  import ThemeToggle from "$lib/ui/theme-toggle";
  import Separator from "$lib/ui/separator";
  import { router, type RouteId } from "$lib/router.svelte.ts";
  import { overlay, startOverlay, beginWindowDrag } from "$lib/overlay.svelte.ts";
  import { rpcState } from "./stores/rpc.svelte.ts";
  import { startApp } from "./stores/app.svelte.ts";
  import { toast } from "./stores/toast.svelte.ts";
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
    { id: "dashboard", label: "Dashboard", hint: "status of both roles" },
    { id: "share", label: "Share", hint: "share my services (3 steps)" },
    { id: "connect", label: "Connect", hint: "use a friend's link (3 steps)" },
    { id: "advanced", label: "Advanced", hint: "services, groups, keys, relay" },
  ];

  const disconnected = $derived(rpcState.status !== "open");
</script>

<div class="jx-pure flex h-dvh flex-col bg-background text-foreground">
  <!-- 标题带 header（仅 overlay 可见时渲染）：高度 ≥ --ot-inset-top（保底 28px 可抓），
       padding-inline 承接左/右控件矩形（红绿灯 / Windows caption）。整条即拖拽带，
       内不放交互元素；原生控件由系统绘制于更上层，不必挖洞。 -->
  {#if overlay.dragEnabled}
    <header
      class="flex shrink-0 cursor-default select-none"
      style="height: max(var(--ot-inset-top, 0px), 28px); padding-inline-start: var(--ot-inset-left, 0px); padding-inline-end: var(--ot-inset-right, 0px)"
      aria-hidden="true"
      onpointerdown={beginWindowDrag}
    ></header>
  {/if}

  <!-- 连接横幅：rpc 通道断开（connecting/reconnecting）时置顶提示。
       横幅内无交互元素，pointerdown 同样可作为拖拽带（桌面 overlay 形态）。 -->
  {#if disconnected}
    <div
      class="flex items-center gap-2 border-b border-border bg-muted/60 px-3 py-1.5 font-nav text-[11px] uppercase tracking-[0.1em] text-muted-foreground"
      role="status"
      onpointerdown={beginWindowDrag}
    >
      <span class="size-1.5 animate-pulse rounded-full bg-primary" aria-hidden="true"></span>
      {rpcState.status === "connecting"
        ? "connecting to the local ai-fly service..."
        : "connection lost - reconnecting..."}
    </div>
  {/if}

  <div class="flex min-h-0 flex-1">
    <!-- 左侧导航：控件避让全部由上方 header 承担，导航从 header 下缘开始 -->
    <nav class="flex w-44 shrink-0 flex-col border-r border-border bg-muted/30" aria-label="main">
      <div class="px-3 py-3">
        <span class="font-nav text-sm tracking-[0.08em]">ai-fly</span>
        <p class="mt-0.5 text-[10px] text-muted-foreground">share services, simply</p>
      </div>
      <Separator />
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
            <span class="font-nav text-xs uppercase tracking-[0.1em]">{item.label}</span>
            <span class="text-[10px] leading-tight">{item.hint}</span>
          </a>
        {/each}
      </div>
      <div class="mt-auto flex flex-col gap-2 p-3">
        <div class="flex items-center gap-2 font-nav text-[10px] uppercase tracking-[0.1em] text-muted-foreground">
          <span
            class="size-1.5 rounded-full {disconnected ? 'bg-muted-foreground/40' : 'bg-primary'}"
            aria-hidden="true"
          ></span>
          {disconnected ? "offline" : "online"}
        </div>
        <ThemeToggle variant="compact" />
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
