<!-- Dashboard（B 3.4，#/dashboard）：
     - 空数据首屏：两条向导大入口卡（spec「首屏三步可达」）。
     - 双角色状态卡：提供方（daemon 运行态/服务数/分组与密钥/在线会话/relay）
       + 使用方（每提供者状态行：别名/六态/路径/端口摘要 + 网关开关）。
     - 端口表（服务名/端口/提供者 + 生命周期：行内 启动/终止/移除——
       service-lifecycle，数据源 consumer.services.list 的 enabled/listening）。
     - 数据全部来自 app store（通知驱动拉取；断线重连全量对账）。 -->
<script lang="ts">
  import Card, { CardFooter } from "$lib/ui/card";
  import Badge from "$lib/ui/badge";
  import PressButton from "$lib/ui/press-button";
  import IconButton from "$lib/ui/icon-button";
  import Icon from "$lib/ui/icon";
  import Skeleton from "$lib/ui/skeleton";
  import { Item, ItemGroup, ItemContent, ItemTitle, ItemDescription, ItemActions } from "$lib/ui/list-item";
  import { t } from "$lib/i18n.svelte.ts";
  import Separator from "$lib/ui/separator";
  import { slide } from "svelte/transition";
  import { toRpcError } from "$lib/rpc-client";
  import StateBadge, { type ConsumerState } from "../components/StateBadge.svelte";
  import { app, refresh } from "../stores/app.svelte.ts";
  import { call } from "../stores/rpc.svelte.ts";
  import { toastRpcError, toastSuccess } from "../stores/toast.svelte.ts";

  /** daemon/gateway 开关在途标记（按钮 loading 锁）。 */
  let daemonBusy = $state(false);
  let gatewayBusy = $state(false);
  /** 两步确认（forget 整环删除）。 */
  let forgetConfirm = $state("");
  let forgetBusy = $state(false);
  /** 提供方级启停单飞锁（endpointId）。 */
  let providerBusy = $state("");
  /** 服务生命周期操作在途行（单飞锁：endpointId/serviceId）。 */
  let serviceBusy = $state("");
  /** 服务移除两步确认中的行（endpointId/serviceId；空 = 无）。 */
  let serviceRemoveConfirm = $state("");

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

  /** 端口表行（service-lifecycle：consumer.services.list 的 enabled/listening +
     consumer.status 的提供者连接态按 endpointId 合流；端口网关停止时为存储投影）。 */
  interface PortRow {
    key: string;
    endpointId: string;
    serviceId: string;
    alias: string;
    name: string;
    port: number;
    state: ConsumerState;
    enabled: boolean;
    listening: boolean;
  }

  const portRows = $derived.by(() => {
    const stateById = new Map(
      (consumer?.providers ?? []).map((entry) => [entry.endpointId, entry.state] as const),
    );
    const rows: PortRow[] = [];
    for (const entry of app.cservices) {
      const state = stateById.get(entry.endpointId) ?? "stopped";
      for (const service of entry.services) {
        rows.push({
          key: `${entry.endpointId}/${service.serviceId}`,
          endpointId: entry.endpointId,
          serviceId: service.serviceId,
          alias: entry.alias,
          name: service.name,
          port: service.port,
          state,
          enabled: service.enabled,
          listening: service.listening,
        });
      }
    }
    return rows;
  });

  /** 环级 enabled（提供方级停用）按 endpointId 查表。 */
  const ringEnabledById = $derived(new Map(app.cservices.map((e) => [e.endpointId, e.enabled] as const)));

  /** 提供方级 启动/终止（环开关：全部服务；恢复时单服务停用保持叠加）。 */
  async function toggleProviderRing(endpointId: string, alias: string, enabled: boolean): Promise<void> {
    if (providerBusy !== "") return;
    providerBusy = endpointId;
    try {
      await call((c) => c.consumer.services.setProviderRunning({ endpointId, running: !enabled }));
      toastSuccess(t(enabled ? "dash.prov.stoppedToast" : "dash.prov.startedToast"), alias);
      await refresh("cservices", "consumer", "ports");
    } catch (error) {
      toastRpcError(toRpcError(error));
    } finally {
      providerBusy = "";
    }
  }

  /** 启动/终止（enabled 翻转；内嵌引擎热生效，独立 daemon 经 keyring watch 传导）。 */
  async function toggleRowService(row: PortRow): Promise<void> {
    if (serviceBusy !== "") return;
    serviceBusy = row.key;
    try {
      await call((c) =>
        c.consumer.services.setRunning({
          endpointId: row.endpointId,
          serviceId: row.serviceId,
          running: !row.enabled,
        }),
      );
      toastSuccess(
        t(row.enabled ? "dash.ports.stoppedToast" : "dash.ports.startedToast"),
        `${row.alias} / ${row.name}`,
      );
      await refresh("cservices", "consumer", "ports");
    } catch (error) {
      toastRpcError(toRpcError(error));
    } finally {
      serviceBusy = "";
    }
  }

  /** 移除（= 停用语义：列表移除且不物化监听，目录同步不复活；组内可随时重启）。 */
  async function removeRowService(row: PortRow): Promise<void> {
    if (serviceBusy !== "") return;
    serviceBusy = row.key;
    try {
      await call((c) => c.consumer.services.remove({ endpointId: row.endpointId, serviceId: row.serviceId }));
      toastSuccess(t("dash.ports.removedToast"), `${row.alias} / ${row.name}`);
      await refresh("cservices", "consumer", "ports");
    } catch (error) {
      toastRpcError(toRpcError(error));
    } finally {
      serviceBusy = "";
      serviceRemoveConfirm = "";
    }
  }
</script>

<div class="mx-auto flex max-w-4xl flex-col gap-4 p-4 md:p-6">
  <header class="flex flex-wrap items-baseline justify-between gap-2">
    <h1 class="font-nav text-base uppercase tracking-[0.1em]">{t("dash.title")}</h1>
    <p class="text-xs text-muted-foreground">{t("dash.subtitle")}</p>
  </header>

  <!-- 首屏三步可达：空数据时只有两条向导大入口，无高级设置干扰。
       标准形态（Owner 裁决 2026-09-10）：Card 承载信息、CardFooter 承载动作——
       整卡不做 <a> 跳转。 -->
  {#if isEmpty}
    <div class="grid gap-4 sm:grid-cols-2" transition:slide={{ duration: 180 }}>
      <Card title={t("dash.entry.share.title")} scroll={false}>
        <div class="flex min-h-28 flex-col gap-2 p-3">
          <p class="text-sm leading-relaxed text-muted-foreground">
            {t("dash.entry.share.body")}
          </p>
        </div>
        {#snippet foot()}
          <CardFooter label="share entry actions">
            <PressButton variant="fill" href="#/share" external={false}>{t("dash.entry.share.go")}</PressButton>
          </CardFooter>
        {/snippet}
      </Card>
      <Card title={t("dash.entry.connect.title")} scroll={false}>
        <div class="flex min-h-28 flex-col gap-2 p-3">
          <p class="text-sm leading-relaxed text-muted-foreground">
            {t("dash.entry.connect.body")}
          </p>
        </div>
        {#snippet foot()}
          <CardFooter label="connect entry actions">
            <PressButton variant="fill" href="#/connect" external={false}>{t("dash.entry.connect.go")}</PressButton>
          </CardFooter>
        {/snippet}
      </Card>
    </div>
  {/if}

  <div class="grid gap-4 md:grid-cols-2">
    <!-- 提供方状态卡 -->
    <Card title={t("dash.provider")} scroll={false}>
      {#snippet actions()}
        {#if provider?.running}
          <Badge variant="tonal" class="jx-hue-success">{t("dash.running")}</Badge>
        {:else if provider !== null}
          <Badge variant="tonal" class="jx-hue-neutral">{t("dash.stopped")}</Badge>
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
              <dt class="text-muted-foreground">{t("dash.stat.services")}</dt>
              <dd class="font-mono">{provider.services}</dd>
            </div>
            <div class="flex justify-between gap-2 border-b border-border/60 pb-1">
              <dt class="text-muted-foreground">{t("dash.stat.groups")}</dt>
              <dd class="font-mono">{provider.groups}</dd>
            </div>
            <div class="flex justify-between gap-2 border-b border-border/60 pb-1">
              <dt class="text-muted-foreground">{t("dash.stat.activeKeys")}</dt>
              <dd class="font-mono">{provider.activeKeys}</dd>
            </div>
            <div class="flex justify-between gap-2 border-b border-border/60 pb-1">
              <dt class="text-muted-foreground">{t("dash.stat.revokedKeys")}</dt>
              <dd class="font-mono">{provider.revokedKeys}</dd>
            </div>
            <div class="flex justify-between gap-2 border-b border-border/60 pb-1">
              <dt class="text-muted-foreground">{t("dash.stat.sessions")}</dt>
              <dd class="font-mono">{provider.sessionCount}</dd>
            </div>
            <div class="flex justify-between gap-2 border-b border-border/60 pb-1">
              <dt class="text-muted-foreground">{t("dash.stat.relay")}</dt>
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
              {t("dash.noServices")}
            {/if}
          </p>
          {#if !provider.running && provider.services === 0}
            <p class="text-[11px] leading-relaxed text-muted-foreground">{t("dash.provider.emptyHint")}</p>
          {/if}
        </div>
        {#snippet foot()}
          <CardFooter label="provider actions">
            <PressButton
              variant="outline"
              loading={daemonBusy}
              onclick={() => void toggleDaemon()}
            >
              {provider.running ? t("dash.daemon.stop") : t("dash.daemon.start")}
            </PressButton>
            <PressButton variant="ghost" href="#/share" external={false}>{t("dash.shareService")}</PressButton>
          </CardFooter>
        {/snippet}
      {/if}
    </Card>

    <!-- 使用方状态卡 -->
    <Card title={t("dash.consumer")} scroll={false}>
      {#snippet actions()}
        {#if consumer?.gatewayRunning}
          <Badge variant="tonal" class="jx-hue-success">{t("dash.gateway.running")}</Badge>
        {:else if consumer !== null}
          <Badge variant="tonal" class="jx-hue-neutral">{t("dash.gateway.stopped")}</Badge>
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
            <p class="text-xs text-muted-foreground">{t("dash.noProviders")}</p>
            <a class="text-xs text-primary underline-offset-2 hover:underline" href="#/connect">
              {t("dash.importLink")} -&gt;
            </a>
          {:else}
            <ItemGroup class="m-3">
              {#each consumer.providers as entry (entry.endpointId)}
                {@const ringEnabled = ringEnabledById.get(entry.endpointId) ?? true}
                <Item>
                  <ItemContent>
                    <ItemTitle>
                      <span class="font-mono" class:opacity-60={!ringEnabled}>{entry.alias}</span>
                      <StateBadge state={entry.state} />
                      {#if !ringEnabled}
                        <span class="rounded-sm bg-muted px-1.5 py-0.5 text-[11px] text-muted-foreground">{t("dash.prov.stoppedBadge")}</span>
                      {/if}
                    </ItemTitle>
                    <ItemDescription class="truncate font-mono" title={forgetConfirm === entry.endpointId ? t("dash.forgetConfirm") : entry.lastError ?? undefined}>
                      {#if forgetConfirm === entry.endpointId}
                        {t("dash.forgetConfirm")}
                      {:else if entry.lastError}
                        {entry.endpointId.slice(0, 10)} · {Object.keys(entry.ports).length} port(s) · {entry.lastError}
                      {:else}
                        {entry.endpointId.slice(0, 10)} · {Object.keys(entry.ports).length} port(s) - {entry.servedCount} served
                      {/if}
                    </ItemDescription>
                  </ItemContent>
                  <ItemActions label={t("dash.prov.actionsLabel")}>
                    {#if forgetConfirm === entry.endpointId}
                      <PressButton variant="tonal" class="jx-pair-destructive" loading={forgetBusy} onclick={() => void forgetProvider(entry.endpointId)}>
                        {t("dash.prov.forgetConfirmBtn")}
                      </PressButton>
                      <PressButton variant="ghost" onclick={() => (forgetConfirm = "")}>{t("common.cancel")}</PressButton>
                    {:else}
                      <IconButton iconOnly variant="ghost" text={t("dash.prov.forgetIcon")} onclick={() => (forgetConfirm = entry.endpointId)}>
                        {#snippet icon()}<Icon name="trash2" size={14} />{/snippet}
                      </IconButton>
                      <IconButton
                        iconOnly
                        variant="ghost"
                        loading={providerBusy === entry.endpointId}
                        text={ringEnabled ? t("dash.prov.stop") : t("dash.prov.start")}
                        onclick={() => void toggleProviderRing(entry.endpointId, entry.alias, ringEnabled)}
                      >
                        {#snippet icon()}<Icon name="power" size={14} />{/snippet}
                      </IconButton>
                    {/if}
                  </ItemActions>
                </Item>
              {/each}
            </ItemGroup>
          {/if}
        </div>
        {#snippet foot()}
          <CardFooter label="consumer actions">
            <PressButton variant="outline" loading={gatewayBusy} onclick={() => void toggleGateway()}>
              {consumer.gatewayRunning ? "stop gateway" : "start gateway"}
            </PressButton>
            <PressButton variant="ghost" href="#/connect" external={false}>{t("dash.importLink")}</PressButton>
          </CardFooter>
        {/snippet}
      {/if}
    </Card>
  </div>

  <!-- 端口表（service-lifecycle：行内 启动/终止 + 移除两步确认——低频间接空间） -->
  <Card title={t("dash.ports.title")} scroll={false}>
    {#if app.busy.cservices && portRows.length === 0}
      <div class="flex flex-col gap-2 p-3">
        <Skeleton class="h-4 w-2/3" />
        <Skeleton class="h-4 w-1/2" />
      </div>
    {:else if portRows.length === 0}
      <p class="p-3 text-xs text-muted-foreground">{t("dash.ports.empty")}</p>
    {:else}
      <div class="overflow-x-auto">
        <table class="w-full text-xs">
        <thead>
          <tr class="border-b border-border text-left font-nav text-[10px] uppercase tracking-[0.1em] text-muted-foreground">
            <th class="px-3 py-2 font-normal">{t("dash.ports.service")}</th>
            <th class="px-3 py-2 font-normal">{t("dash.ports.port")}</th>
            <th class="px-3 py-2 font-normal">{t("dash.ports.provider")}</th>
            <th class="px-3 py-2 font-normal">{t("dash.ports.state")}</th>
            <th class="px-3 py-2 text-right font-normal">{t("dash.ports.actions")}</th>
          </tr>
        </thead>
        <tbody>
          {#each portRows as row (row.key)}
            <tr
              class="border-b border-border/50 transition-colors hover:bg-muted/40 {row.enabled ? '' : 'opacity-60'}"
              transition:slide={{ duration: 150 }}
            >
              <td class="px-3 py-1.5 font-mono">{row.name}</td>
              <td class="px-3 py-1.5 font-mono">{row.port}</td>
              <td class="px-3 py-1.5 font-mono text-muted-foreground">{row.alias}</td>
              <td class="px-3 py-1.5">
                <span class="flex flex-wrap items-center gap-1.5">
                  <StateBadge state={row.state} />
                  {#if !row.enabled}
                    <Badge variant="tonal" class="jx-hue-neutral">{t("dash.ports.disabled")}</Badge>
                  {:else if row.listening}
                    <Badge variant="tonal" class="jx-hue-success">{t("dash.ports.listening")}</Badge>
                  {:else}
                    <Badge variant="tonal" class="jx-hue-warning">{t("dash.ports.notListening")}</Badge>
                  {/if}
                </span>
              </td>
              <td class="px-3 py-1.5 text-right">
                <span class="flex items-center justify-end gap-1.5">
                  {#if serviceRemoveConfirm === row.key}
                    <span class="flex items-center gap-1.5">
                      <span class="text-[11px] text-muted-foreground">{t("dash.ports.removeConfirm")}</span>
                      <PressButton
                        variant="tonal"
                        class="jx-pair-destructive"
                        loading={serviceBusy === row.key}
                        onclick={() => void removeRowService(row)}
                      >{t("common.confirmRemove")}</PressButton>
                      <PressButton variant="ghost" onclick={() => (serviceRemoveConfirm = "")}>{t("common.cancel")}</PressButton>
                    </span>
                  {:else}
                    <PressButton
                      variant="ghost"
                      class="text-[11px]"
                      loading={serviceBusy === row.key}
                      onclick={() => void toggleRowService(row)}
                    >{row.enabled ? t("dash.ports.stop") : t("dash.ports.start")}</PressButton>
                    <PressButton
                      variant="ghost"
                      class="jx-pair-destructive text-[11px]"
                      onclick={() => (serviceRemoveConfirm = row.key)}
                    >{t("common.remove")}</PressButton>
                  {/if}
                </span>
              </td>
            </tr>
          {/each}
        </tbody>
        </table>
      </div>
    {/if}
  </Card>

  <Separator />
  <p class="text-[11px] text-muted-foreground">
    {t("dash.footer.pre")}
    <a class="text-primary underline-offset-2 hover:underline" href="#/advanced">{t("shell.nav.advanced")}</a>.
  </p>
</div>
