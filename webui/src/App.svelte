<!-- 应用骨架（B 3.1）：左侧导航（Dashboard / 分享向导 / 接入向导 / 高级设置）
     + theme-toggle + 连接横幅 + hash 路由出口 + ToastViewport。
     空数据首屏由 Dashboard 渲染（两条向导大入口卡，spec「首屏三步可达」）。 -->
<script lang="ts">
  import { onMount } from "svelte";
  import ToastViewport from "$lib/ui/toast";
  import ThemeToggle from "$lib/ui/theme-toggle";
  import Separator from "$lib/ui/separator";
  import { router, type RouteId } from "$lib/router.svelte.ts";
  import { rpcState } from "./stores/rpc.svelte.ts";
  import { startApp } from "./stores/app.svelte.ts";
  import { toast } from "./stores/toast.svelte.ts";
  import Dashboard from "./pages/Dashboard.svelte";
  import ShareWizard from "./pages/ShareWizard.svelte";
  import ConnectWizard from "./pages/ConnectWizard.svelte";
  import Advanced from "./pages/Advanced.svelte";

  onMount(() => {
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
  <!-- 连接横幅：rpc 通道断开（connecting/reconnecting）时置顶提示 -->
  {#if disconnected}
    <div
      class="flex items-center gap-2 border-b border-border bg-muted/60 px-3 py-1.5 font-nav text-[11px] uppercase tracking-[0.1em] text-muted-foreground"
      role="status"
    >
      <span class="size-1.5 animate-pulse rounded-full bg-primary" aria-hidden="true"></span>
      {rpcState.status === "connecting"
        ? "connecting to the local ai-fly service..."
        : "connection lost - reconnecting..."}
    </div>
  {/if}

  <div class="flex min-h-0 flex-1">
    <!-- 左侧导航 -->
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

<ToastViewport {toast} />
