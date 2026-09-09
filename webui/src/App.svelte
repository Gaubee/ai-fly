<!-- 应用骨架（B 3.1）：左侧导航（Dashboard / 分享向导 / 接入向导 / 高级设置）
     + theme-toggle + 连接横幅 + hash 路由出口 + ToastViewport。
     空数据首屏由 Dashboard 渲染（两条向导大入口卡，spec「首屏三步可达」）。
     桌面 overlay 安全区（m3 2.1/2.2）：整壳顶部下移避让原生控件（红绿灯带），
     左导航另避让左置控件；顶部透明拖拽带仅 overlay 可见时渲染（startOverlay
     把避让量写 --ot-inset-top / --ot-inset-left，浏览器 dev 归零无假象）。 -->
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

<!-- 顶部拖拽带：overlay 可见（dragEnabled）时渲染；高度取避让量与 28px 的较大值
     保底可抓；透明、无交互元素，pointerdown 交给原生窗口拖拽（beginWindowDrag）。
     原生控件由系统绘制在更上层，带不必挖洞；toast（z-[90]）仍在带之上。 -->
{#if overlay.dragEnabled}
  <div
    class="fixed inset-x-0 top-0 z-40 cursor-default"
    style="height: max(var(--ot-inset-top, 0px), 28px)"
    aria-hidden="true"
    onpointerdown={beginWindowDrag}
  ></div>
{/if}

<!-- 整壳顶部避让：标题带（红绿灯）高度内不放任何内容；横幅/导航/主区随之整体下移 -->
<div
  class="jx-pure flex h-dvh flex-col bg-background text-foreground"
  style="padding-top: var(--ot-inset-top, 0px)"
>
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
    <!-- 左侧导航：品牌区在左上角，需再避让左置控件（红绿灯右缘）；主区在导航
         右侧，控件只压左上角，故主区不需要左 inset -->
    <nav
      class="flex w-44 shrink-0 flex-col border-r border-border bg-muted/30"
      style="padding-left: var(--ot-inset-left, 0px)"
      aria-label="main"
    >
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
