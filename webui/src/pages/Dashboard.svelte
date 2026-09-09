<!-- Dashboard（B 3.4，#/dashboard）：
     - 空数据首屏：两条向导大入口卡（spec「首屏三步可达」）。
     - 双角色状态卡：提供方（daemon 运行态/服务数/分组与密钥/在线会话/relay）
       + 使用方（每提供者状态行：别名/六态/路径/端口摘要 + 网关开关）。
     - 端口表（服务名/端口/提供者）。
     - 数据全部来自 app store（通知驱动拉取；断线重连全量对账）。 -->
<script lang="ts">
  import Card from "$lib/ui/card";
  import Badge from "$lib/ui/badge";
  import PressButton from "$lib/ui/press-button";
  import Skeleton from "$lib/ui/skeleton";
  import Separator from "$lib/ui/separator";
  import { slide } from "svelte/transition";
  import StateBadge, { type ConsumerState } from "../components/StateBadge.svelte";
  import { app, refresh } from "../stores/app.svelte.ts";
  import { call } from "../stores/rpc.svelte.ts";

  /** daemon/gateway 开关在途标记（按钮 loading 锁）。 */
  let daemonBusy = $state(false);
  let gatewayBusy = $state(false);
  /** 两步确认（forget 整环删除）。 */
  let forgetConfirm = $state("");
  let forgetBusy = $state(false);

  const provider = $derived(app.provider);
  const consumer = $derived(app.consumer);

  /** 空数据首屏：两角色都无配置（~/.aifly 空）。 */
  const isEmpty = $derived(
    app.ready &&
      provider !== null &&
      consumer !== null &&
      provider.services === 0 &&
      provider.groups === 0 &&
      consumer.providers.length === 0,
  );

  async function toggleDaemon(): Promise<void> {
    if (daemonBusy || provider === null) return;
    daemonBusy = true;
    try {
      if (provider.running) await call((c) => c.provider.daemon.stop({}));
      else await call((c) => c.provider.daemon.start({}));
    } finally {
      daemonBusy = false;
      refresh("provider");
    }
  }

  async function toggleGateway(): Promise<void> {
    if (gatewayBusy || consumer === null) return;
    gatewayBusy = true;
    try {
      if (consumer.gatewayRunning) await call((c) => c.consumer.gateway.stop({}));
      else await call((c) => c.consumer.gateway.start({}));
    } finally {
      gatewayBusy = false;
      refresh("consumer", "ports");
    }
  }

  async function forgetProvider(ref: string): Promise<void> {
    if (forgetBusy) return;
    forgetBusy = true;
    try {
      await call((c) => c.consumer.forget({ ref }));
      refresh("consumer", "ports");
    } finally {
      forgetBusy = false;
      forgetConfirm = "";
    }
  }

  /** 端口表行（消费侧实际端口；网关停止时为存储投影）。 */
  const portRows = $derived.by(() => {
    if (consumer === null) return [];
    const rows: Array<{ alias: string; name: string; port: number; state: ConsumerState }> = [];
    for (const entry of consumer.providers) {
      const nameById = new Map(entry.services.map((service) => [service.serviceId, service.name]));
      for (const [serviceId, port] of Object.entries(entry.ports)) {
        rows.push({
          alias: entry.alias,
          name: nameById.get(serviceId) ?? serviceId,
          port,
          state: entry.state,
        });
      }
    }
    return rows;
  });
</script>

<div class="mx-auto flex max-w-4xl flex-col gap-4 p-4 md:p-6">
  <header class="flex flex-wrap items-baseline justify-between gap-2">
    <h1 class="font-nav text-base uppercase tracking-[0.1em]">Dashboard</h1>
    <p class="text-xs text-muted-foreground">live status, updated by engine notifications</p>
  </header>

  <!-- 首屏三步可达：空数据时只有两条向导大入口，无高级设置干扰 -->
  {#if isEmpty}
    <div class="grid gap-4 sm:grid-cols-2" transition:slide={{ duration: 180 }}>
      <a
        href="#/share"
        class="group flex min-h-44 flex-col gap-3 border border-border bg-card p-5 shadow-2xs transition-colors hover:border-primary/50"
      >
        <span class="font-nav text-sm uppercase tracking-[0.1em] text-primary">share my services</span>
        <p class="text-sm leading-relaxed text-muted-foreground">
          Pick a source, name it, send one link. Your friend's agents reach your local models or
          subscriptions in three steps.
        </p>
        <span class="mt-auto font-nav text-xs uppercase tracking-[0.1em] text-foreground">
          start sharing ->
        </span>
      </a>
      <a
        href="#/connect"
        class="group flex min-h-44 flex-col gap-3 border border-border bg-card p-5 shadow-2xs transition-colors hover:border-primary/50"
      >
        <span class="font-nav text-sm uppercase tracking-[0.1em] text-primary">use a friend's link</span>
        <p class="text-sm leading-relaxed text-muted-foreground">
          Paste an aifly1. link, confirm local ports, pick your agent. Ready to request in three
          steps.
        </p>
        <span class="mt-auto font-nav text-xs uppercase tracking-[0.1em] text-foreground">
          start connecting ->
        </span>
      </a>
    </div>
  {/if}

  <div class="grid gap-4 md:grid-cols-2">
    <!-- 提供方状态卡 -->
    <Card title="provider" scroll={false}>
      {#snippet actions()}
        {#if provider?.running}
          <Badge variant="tonal" class="jx-hue-success">running</Badge>
        {:else if provider !== null}
          <Badge variant="tonal" class="jx-hue-neutral">stopped</Badge>
        {/if}
      {/snippet}
      {#if provider === null}
        <div class="flex flex-col gap-2 p-3">
          <Skeleton class="h-4 w-2/3" />
          <Skeleton class="h-4 w-1/2" />
          <Skeleton class="h-4 w-3/4" />
        </div>
      {:else}
        <div class="flex flex-col gap-3 p-3">
          <dl class="grid grid-cols-2 gap-x-4 gap-y-1.5 text-xs">
            <div class="flex justify-between gap-2 border-b border-border/60 pb-1">
              <dt class="text-muted-foreground">services</dt>
              <dd class="font-mono">{provider.services}</dd>
            </div>
            <div class="flex justify-between gap-2 border-b border-border/60 pb-1">
              <dt class="text-muted-foreground">groups</dt>
              <dd class="font-mono">{provider.groups}</dd>
            </div>
            <div class="flex justify-between gap-2 border-b border-border/60 pb-1">
              <dt class="text-muted-foreground">active keys</dt>
              <dd class="font-mono">{provider.activeKeys}</dd>
            </div>
            <div class="flex justify-between gap-2 border-b border-border/60 pb-1">
              <dt class="text-muted-foreground">revoked keys</dt>
              <dd class="font-mono">{provider.revokedKeys}</dd>
            </div>
            <div class="flex justify-between gap-2 border-b border-border/60 pb-1">
              <dt class="text-muted-foreground">online sessions</dt>
              <dd class="font-mono">{provider.sessionCount}</dd>
            </div>
            <div class="flex justify-between gap-2 border-b border-border/60 pb-1">
              <dt class="text-muted-foreground">relay</dt>
              <dd class="font-mono">{provider.running ? provider.relayMode ?? "-" : "-"}</dd>
            </div>
          </dl>
          <p class="text-[11px] leading-relaxed text-muted-foreground">
            {#if provider.alias}
              alias <code class="font-mono">{provider.alias}</code>
              {#if provider.endpointId}
                - <code class="font-mono">{provider.endpointId.slice(0, 10)}</code>
              {/if}
            {:else}
              no services shared yet
            {/if}
          </p>
        </div>
        {#snippet foot()}
          <PressButton
            variant="outline"
            loading={daemonBusy}
            onclick={() => void toggleDaemon()}
          >
            {provider.running ? "stop daemon" : "start daemon"}
          </PressButton>
          <PressButton variant="ghost" href="#/share" external={false}>share a service</PressButton>
        {/snippet}
      {/if}
    </Card>

    <!-- 使用方状态卡 -->
    <Card title="consumer" scroll={false}>
      {#snippet actions()}
        {#if consumer?.gatewayRunning}
          <Badge variant="tonal" class="jx-hue-success">gateway running</Badge>
        {:else if consumer !== null}
          <Badge variant="tonal" class="jx-hue-neutral">gateway stopped</Badge>
        {/if}
      {/snippet}
      {#if consumer === null}
        <div class="flex flex-col gap-2 p-3">
          <Skeleton class="h-4 w-2/3" />
          <Skeleton class="h-4 w-1/2" />
        </div>
      {:else}
        <div class="flex flex-col gap-2 p-3">
          {#if consumer.providers.length === 0}
            <p class="text-xs text-muted-foreground">no providers imported yet</p>
            <a class="text-xs text-primary underline-offset-2 hover:underline" href="#/connect">
              import a share link ->
            </a>
          {:else}
            {#each consumer.providers as entry (entry.endpointId)}
              <div class="flex flex-col gap-1 border border-border/70 px-2.5 py-2" transition:slide={{ duration: 150 }}>
                <div class="flex flex-wrap items-center gap-2">
                  <span class="font-mono text-xs">{entry.alias}</span>
                  <StateBadge state={entry.state} />
                  <span class="ml-auto font-mono text-[11px] text-muted-foreground">
                    {Object.keys(entry.ports).length} port(s) - {entry.servedCount} served
                  </span>
                </div>
                {#if entry.lastError}
                  <p class="truncate font-mono text-[11px] text-muted-foreground" title={entry.lastError}>
                    last error: {entry.lastError}
                  </p>
                {/if}
                {#if forgetConfirm === entry.endpointId}
                  <div class="flex items-center gap-2">
                    <span class="text-[11px] text-muted-foreground">forget this provider (removes keys)?</span>
                    <PressButton variant="tonal" class="jx-pair-destructive" loading={forgetBusy} onclick={() => void forgetProvider(entry.endpointId)}>
                      confirm forget
                    </PressButton>
                    <PressButton variant="ghost" onclick={() => (forgetConfirm = "")}>cancel</PressButton>
                  </div>
                {:else}
                  <button
                    type="button"
                    class="self-start text-[11px] text-muted-foreground underline-offset-2 hover:text-foreground hover:underline"
                    onclick={() => (forgetConfirm = entry.endpointId)}
                  >
                    forget
                  </button>
                {/if}
              </div>
            {/each}
          {/if}
        </div>
        {#snippet foot()}
          <PressButton variant="outline" loading={gatewayBusy} onclick={() => void toggleGateway()}>
            {consumer.gatewayRunning ? "stop gateway" : "start gateway"}
          </PressButton>
          <PressButton variant="ghost" href="#/connect" external={false}>import a link</PressButton>
        {/snippet}
      {/if}
    </Card>
  </div>

  <!-- 端口表 -->
  <Card title="local ports" scroll={false}>
    {#if portRows.length === 0}
      <p class="p-3 text-xs text-muted-foreground">
        no ports yet - they appear after sharing or importing services.
      </p>
    {:else}
      <table class="w-full text-xs">
        <thead>
          <tr class="border-b border-border text-left font-nav text-[10px] uppercase tracking-[0.1em] text-muted-foreground">
            <th class="px-3 py-2 font-normal">service</th>
            <th class="px-3 py-2 font-normal">port</th>
            <th class="px-3 py-2 font-normal">provider</th>
            <th class="px-3 py-2 font-normal">state</th>
          </tr>
        </thead>
        <tbody>
          {#each portRows as row (`${row.alias}:${row.name}:${row.port}`)}
            <tr class="border-b border-border/50 transition-colors hover:bg-muted/40" transition:slide={{ duration: 150 }}>
              <td class="px-3 py-1.5 font-mono">{row.name}</td>
              <td class="px-3 py-1.5 font-mono">{row.port}</td>
              <td class="px-3 py-1.5 font-mono text-muted-foreground">{row.alias}</td>
              <td class="px-3 py-1.5"><StateBadge state={row.state} /></td>
            </tr>
          {/each}
        </tbody>
      </table>
    {/if}
  </Card>

  <Separator />
  <p class="text-[11px] text-muted-foreground">
    engine internals (match sets, rewrite rules, keys) live in
    <a class="text-primary underline-offset-2 hover:underline" href="#/advanced">Advanced</a>.
  </p>
</div>
