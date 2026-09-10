<!-- 使用方接入向导（B 3.3，#/connect 三步）：
     ①粘贴链接（离线预览：提供者别名/分组/服务表：名称+默认端口+match 数）
     → ②端口确认（apply 即导入+网关启动；实际端口表 + 冲突自动错开显著
     标注 + 可改）→ ③test（M3-r8 Owner 裁决：无 agent setup——选协议、
     选端点（中性表达：本地前缀 → upstream 目标）、单输入框（默认 hi）发
     真实 AI 请求走完整 wire 链路；结果面板展示状态/时延/回复正文）。
     状态机在 stores/connect-wizard。 -->
<script lang="ts">
  import { onMount } from "svelte";
  import Card, { CardFooter } from "$lib/ui/card";
  import Badge from "$lib/ui/badge";
  import PressButton from "$lib/ui/press-button";
  import Input from "$lib/ui/input";
  import NativeSelect from "$lib/ui/native-select";
  import Alert from "$lib/ui/alert";
  import Skeleton from "$lib/ui/skeleton";
  import { slide } from "svelte/transition";
  import StepHeader from "../components/StepHeader.svelte";
  import ErrorAlert from "../components/ErrorAlert.svelte";
  import CopyField from "../components/CopyField.svelte";
  import { connection } from "../stores/rpc.svelte.ts";
  import {
    connectW,
    resetConnect,
    previewLink,
    previewNext,
    connectBack,
    applyImport,
    portsNext,
    setServicePort,
    refreshWizardPorts,
    finishConnect,
    sendTest,
    setTestService,
    setTestProtocol,
    PROTOCOL_OPTIONS,
    dialGuidance,
    type RouteTestOutput,
  } from "../stores/connect-wizard.svelte.ts";

  onMount(() =>
    // 网关启动后引擎可能自动错开端口：consumer-* 通知到达即对账向导端口表
    connection.subscribeNotify((event) => {
      if (
        connectW.applied !== null &&
        (event.type === "consumer-ports" ||
          event.type === "consumer-state" ||
          event.type === "consumer-gateway" ||
          event.type === "consumer-catalog")
      ) {
        void refreshWizardPorts();
      }
    }),
  );

  const applyGuidance = $derived(
    connectW.applyError !== null ? dialGuidance(connectW.applyError) : null,
  );

  /** ③ 换服务：端点重置 + 结果清空 + 端口对账。 */
  function onServiceChange(value: string): void {
    setTestService(value);
    void refreshWizardPorts(); // auto-assign 端口快照可能滞后，切换即对账
  }

  // NativeSelect bind:value + onchange 透传（GroupPicker 模式）：
  // 本地显示值 + 单向 store→显示同步；用户变更经 onchange 回写 store
  let serviceSel = $state(connectW.testServiceId);
  $effect(() => {
    serviceSel = connectW.testServiceId;
  });
  let protocolSel = $state<string>(connectW.testProtocol);
  $effect(() => {
    protocolSel = connectW.testProtocol;
  });
  let endpointSel = $state(connectW.testEndpoint);
  $effect(() => {
    endpointSel = connectW.testEndpoint;
  });

  function handleServiceChange(event: Event & { currentTarget: EventTarget & HTMLSelectElement }): void {
    onServiceChange(event.currentTarget.value);
  }
  function handleProtocolChange(event: Event & { currentTarget: EventTarget & HTMLSelectElement }): void {
    const found = PROTOCOL_OPTIONS.find((option) => option.value === event.currentTarget.value);
    if (found !== undefined) setTestProtocol(found.value);
  }
  function handleEndpointChange(event: Event & { currentTarget: EventTarget & HTMLSelectElement }): void {
    connectW.testEndpoint = event.currentTarget.value;
    connectW.testResult = null; // 换端点即换目标：旧结果失效
  }
  function handlePromptChange(event: Event & { currentTarget: EventTarget & HTMLInputElement }): void {
    connectW.testPrompt = event.currentTarget.value;
  }
  function handlePromptKeydown(event: KeyboardEvent & { currentTarget: EventTarget & HTMLInputElement }): void {
    if (event.key === "Enter") {
      event.preventDefault();
      void sendTest();
    }
  }

  const serviceOptions = $derived(
    connectW.applied !== null
      ? connectW.applied.services.map((service) => {
          const port = connectW.ports.find((row) => row.serviceId === service.serviceId)?.port;
          return {
            value: service.serviceId,
            label: port === undefined ? `${service.name} (port from local gateway)` : `${service.name} (port ${port})`,
          };
        })
      : [],
  );

  // ---------------------------------------------------------------------------
  // ③ 端点选项（M3-r8：中性表达——本地前缀 + 「→ upstream 目标」注记，
  // 不出现 API 标准名；仅 prefix 模式规则有稳定端点面，legacy 服务退根透传）
  // ---------------------------------------------------------------------------

  /** 选中服务的 detail.upstream（端点标签的转发目标注记）。 */
  const selectedUpstream = $derived(connectW.serviceUpstream[connectW.testServiceId] ?? null);
  const endpointOptions = $derived.by(() => {
    const routes = connectW.serviceRoutes[connectW.testServiceId] ?? [];
    const prefixRoutes = routes.filter((r) => r.mode !== "pattern" && (r.localPrefix ?? "") !== "");
    const options = prefixRoutes.map((route) => {
      const local = route.localPrefix!;
      const target =
        selectedUpstream === null
          ? ""
          : ` → ${selectedUpstream.replace(/\/+$/, "")}${route.upstreamPrefix ?? ""}/*`;
      return { value: local, label: `${local}${target}` };
    });
    if (options.length === 0) {
      options.push({ value: "", label: "root (passthrough)" });
    }
    return options;
  });

  /** 长 URL 展示：≤64 原样；超长保留首尾、中间省略（结果区块风格对齐 TestConnection）。 */
  function shortenUrl(url: string, max = 64): string {
    if (url.length <= max) return url;
    const head = url.slice(0, Math.ceil((max - 1) / 2));
    const tail = url.slice(-Math.floor((max - 1) / 2));
    return `${head}...${tail}`;
  }

  /** 失败摘要：error 与 bodyExcerpt 择短展示（全宽 11px）。 */
  function failureExcerpt(result: RouteTestOutput): string | null {
    const candidates = [result.error, result.bodyExcerpt].filter(
      (value): value is string => value !== undefined && value !== "",
    );
    if (candidates.length === 0) return null;
    return candidates.reduce((shortest, current) =>
      current.length < shortest.length ? current : shortest,
    );
  }
</script>

<div class="mx-auto flex max-w-3xl flex-col gap-4 p-4 md:p-6">
  <header class="flex flex-col gap-2">
    <h1 class="font-nav text-base uppercase tracking-[0.1em]">Connect to a friend</h1>
    <StepHeader step={connectW.step} titles={["paste link", "ports", "test"]} />
  </header>

  <!-- ① 粘贴链接 -->
  {#if connectW.step === 1}
    <Card title="paste the share link" scroll={false}>
      <div class="flex flex-col gap-3 p-3">
        <Input
          label="aifly1. link"
          placeholder="aifly1..."
          bind:value={connectW.link}
          onkeydown={(event) => {
            if (event.key === "Enter") void previewLink();
          }}
        />
        {#if connectW.previewBusy}
          <div class="flex flex-col gap-2">
            <Skeleton class="h-4 w-1/2" />
            <Skeleton class="h-24" />
          </div>
        {:else if connectW.preview !== null}
          <div class="flex flex-col gap-2 border border-border/70 p-3" transition:slide={{ duration: 150 }}>
            <div class="flex flex-wrap items-center gap-2 text-xs">
              <span class="font-mono">{connectW.preview.alias}</span>
              <Badge variant="tonal" class="jx-hue-success">preview ok</Badge>
              <span class="text-muted-foreground">group</span>
              <code class="font-mono">{connectW.preview.group}</code>
            </div>
            <table class="w-full text-xs">
              <thead>
                <tr class="border-b border-border text-left font-nav text-[10px] uppercase tracking-[0.1em] text-muted-foreground">
                  <th class="py-1.5 font-normal">service</th>
                  <th class="py-1.5 font-normal">default port</th>
                  <th class="py-1.5 font-normal">match rules</th>
                </tr>
              </thead>
              <tbody>
                {#each connectW.preview.services as service (service.serviceId)}
                  <tr class="border-b border-border/50">
                    <td class="py-1.5 font-mono">{service.name}</td>
                    <td class="py-1.5 font-mono">{service.defaultPort}</td>
                    <td class="py-1.5 font-mono text-muted-foreground">{service.matchCount}</td>
                  </tr>
                {/each}
              </tbody>
            </table>
            <p class="text-[11px] text-muted-foreground">
              parsed offline - no network request was made. continue to import and start the
              local gateway.
            </p>
          </div>
        {/if}
      </div>
      {#snippet foot()}
        <CardFooter label="connect wizard actions">
          <PressButton variant="ghost" onclick={() => resetConnect()}>clear</PressButton>
          <PressButton
            variant="fill"
            loading={connectW.previewBusy}
            class={connectW.link.trim() === "" ? "pointer-events-none opacity-50" : undefined}
            onclick={() => void previewLink()}
          >
            preview link
          </PressButton>
          {#if connectW.preview !== null}
            <PressButton variant="outline" onclick={previewNext}>continue</PressButton>
          {/if}
        </CardFooter>
      {/snippet}
    </Card>
    <ErrorAlert error={connectW.previewError} />

  <!-- ② 端口确认 -->
  {:else if connectW.step === 2}
    <Card title="confirm local ports" scroll={false}>
      <div class="flex flex-col gap-3 p-3">
        {#if connectW.applied === null}
          {#if connectW.applyBusy}
            <div class="flex flex-col gap-2">
              <p class="text-xs text-muted-foreground">
                redeeming the link and starting the gateway... this dials the provider and can
                take a moment.
              </p>
              <Skeleton class="h-5 w-2/3" />
              <Skeleton class="h-24" />
            </div>
          {:else}
            <p class="text-xs leading-relaxed text-muted-foreground">
              importing <code class="font-mono">{connectW.preview?.alias ?? "provider"}</code>
              adds its services to your keyring and starts the local gateway automatically -
              no extra run step.
            </p>
          {/if}
          {#if applyGuidance !== null}
            <Alert variant="tonal" class="jx-hue-info" title="cannot reach the provider">
              {applyGuidance}
            </Alert>
          {/if}
        {:else}
          <div class="flex flex-wrap items-center gap-2 text-xs" transition:slide={{ duration: 180 }}>
            <span class="font-mono">{connectW.applied.alias}</span>
            <Badge variant="tonal" class="jx-hue-success">imported</Badge>
            {#if connectW.applied.redeemed}
              <Badge variant="outline">token redeemed</Badge>
            {/if}
            {#if connectW.gatewayStarted}
              <Badge variant="tonal" class="jx-hue-success">gateway running</Badge>
            {:else}
              <Badge variant="tonal" class="jx-hue-warning">gateway not running</Badge>
            {/if}
          </div>
          <table class="w-full text-xs">
            <thead>
              <tr class="border-b border-border text-left font-nav text-[10px] uppercase tracking-[0.1em] text-muted-foreground">
                <th class="py-1.5 font-normal">service</th>
                <th class="py-1.5 font-normal">default</th>
                <th class="py-1.5 font-normal">actual port</th>
                <th class="py-1.5 font-normal">set</th>
              </tr>
            </thead>
            <tbody>
              {#each connectW.ports as row (row.serviceId)}
                <tr class="border-b border-border/50">
                  <td class="py-1.5 font-mono">{row.name}</td>
                  <td class="py-1.5 font-mono text-muted-foreground">{row.defaultPort}</td>
                  <td class="py-1.5">
                    <span class="flex flex-wrap items-center gap-1.5">
                      <span class="font-mono">{row.port}</span>
                      {#if row.autoShifted}
                        <Badge variant="tonal" class="jx-hue-warning">auto-shifted</Badge>
                      {/if}
                      {#if row.pinned}
                        <Badge variant="outline">pinned</Badge>
                      {/if}
                    </span>
                    {#if row.autoShifted}
                      <span class="block text-[10px] leading-tight text-muted-foreground">
                        default port {row.defaultPort} was taken - the engine moved it to {row.port}.
                      </span>
                    {/if}
                  </td>
                  <td class="py-1.5">
                    <span class="flex items-center gap-1.5">
                      <input
                        class="w-20 border border-border bg-transparent px-2 py-1 font-mono text-xs
                          focus:border-primary focus:outline-none"
                        inputmode="numeric"
                        bind:value={connectW.portDraft[row.serviceId]}
                      />
                      <PressButton
                        variant="ghost"
                        loading={connectW.portBusy === row.serviceId}
                        onclick={() => void setServicePort(row.serviceId)}
                      >
                        set
                      </PressButton>
                    </span>
                  </td>
                </tr>
              {/each}
            </tbody>
          </table>
          <p class="text-[11px] text-muted-foreground">
            port changes persist and apply on the next gateway start.
          </p>
        {/if}
      </div>
      {#snippet foot()}
        <CardFooter label="connect wizard actions">
          <PressButton variant="ghost" onclick={connectBack} class={connectW.applyBusy ? "pointer-events-none opacity-50" : undefined}>back</PressButton>
          {#if connectW.applied === null}
            <PressButton variant="fill" loading={connectW.applyBusy} onclick={() => void applyImport()}>
              import & start
            </PressButton>
          {:else}
            <PressButton variant="fill" onclick={portsNext}>continue</PressButton>
          {/if}
        </CardFooter>
      {/snippet}
    </Card>
    <ErrorAlert error={connectW.applyError ?? connectW.portError} />

  <!-- ③ test（M3-r8 Owner 裁决：agent setup 步不该存在——本步 = 选协议、
       选端点、单输入框发真实 AI 请求；不写任何 agent 配置） -->
  {:else}
    <Card title="test" scroll={false}>
      <div class="flex flex-col gap-3 p-3">
        <div class="grid gap-3 sm:grid-cols-3">
          {#if serviceOptions.length > 1}
            <NativeSelect label="service" bind:value={serviceSel} onchange={handleServiceChange}>
              {#each serviceOptions as option (option.value)}
                <option value={option.value}>{option.label}</option>
              {/each}
            </NativeSelect>
          {/if}
          <NativeSelect label="protocol" bind:value={protocolSel} onchange={handleProtocolChange}>
            {#each PROTOCOL_OPTIONS as option (option.value)}
              <option value={option.value}>{option.label}</option>
            {/each}
          </NativeSelect>
          <NativeSelect label="endpoint" bind:value={endpointSel} onchange={handleEndpointChange}>
            {#each endpointOptions as option (option.value)}
              <option value={option.value}>{option.label}</option>
            {/each}
          </NativeSelect>
        </div>

        <!-- 单轮聊天面板：一个输入框（默认 hi）+ 发送 -->
        <div class="flex flex-col gap-2 border border-border/70 p-3">
          <span class="font-nav text-[11px] uppercase tracking-[0.1em] text-muted-foreground">
            send a request
          </span>
          <div class="flex flex-wrap items-center gap-2">
            <div class="min-w-48 flex-1">
              <Input
                placeholder="hi"
                value={connectW.testPrompt}
                onchange={handlePromptChange}
                onkeydown={handlePromptKeydown}
              />
            </div>
            <PressButton
              variant="fill"
              loading={connectW.testBusy}
              class={connectW.testServiceId === "" ? "pointer-events-none opacity-50" : undefined}
              onclick={() => void sendTest()}
            >send</PressButton>
          </div>
          <p class="text-[11px] text-muted-foreground">
            single-turn only - one request, one response. the model is picked automatically.
          </p>
        </div>

        <!-- 结果面板 -->
        {#if connectW.testResult !== null}
          <div class="flex flex-col gap-1.5 border border-border/70 p-3" transition:slide={{ duration: 150 }}>
            <span class="font-nav text-[11px] uppercase tracking-[0.1em] text-muted-foreground">
              response
            </span>
            {#if connectW.testResult.ok}
              <p class="font-mono text-[11px] text-[color:var(--success)]">
                ok {connectW.testResult.latencyMs}ms{connectW.testResult.httpStatus !== undefined ? ` (HTTP ${connectW.testResult.httpStatus})` : ""}
              </p>
            {:else}
              <p class="text-[11px] leading-relaxed text-[color:var(--warning)]">
                failed{connectW.testResult.httpStatus !== undefined ? ` (HTTP ${connectW.testResult.httpStatus})` : ""}{failureExcerpt(connectW.testResult) !== null ? `: ${failureExcerpt(connectW.testResult)}` : ""}
              </p>
            {/if}
            {#if connectW.testResult.request.url !== ""}
              <p class="break-all font-mono text-[11px] text-muted-foreground">
                POST {shortenUrl(connectW.testResult.request.url, 96)}
              </p>
            {/if}
            {#if connectW.testResult.bodyExcerpt !== undefined && connectW.testResult.bodyExcerpt !== ""}
              <pre class="max-h-64 overflow-auto whitespace-pre-wrap break-all border border-border bg-muted/40 p-3 text-xs">{connectW.testResult.bodyExcerpt}</pre>
            {/if}
          </div>
        {/if}
      </div>
      {#snippet foot()}
        <CardFooter label="connect wizard actions">
          <PressButton variant="ghost" onclick={connectBack}>back</PressButton>
          <PressButton variant="fill" href="#/dashboard" external={false} onclick={() => finishConnect()}>
            finish - go to dashboard
          </PressButton>
        </CardFooter>
      {/snippet}
    </Card>
  {/if}
</div>
