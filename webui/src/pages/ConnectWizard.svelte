<!-- 使用方接入向导（B 3.3，#/connect 三步）：
     ①粘贴链接（离线预览：提供者别名/分组/服务表：名称+默认端口+match 数）
     → ②端口确认（apply 即导入+网关启动；实际端口表 + 冲突自动错开显著
     标注 + 可改）→ ③Agent 配置（服务+Agent 选择（NativeSelect，skip 永远
     可达——footer 在 preview 缺席时也放行 finish）+ API endpoints 按标准
     呈现与行内连通测试（M3-r4）→ writers.preview 渲染等宽 diff → 确认
     writers.apply）。状态机在 stores/connect-wizard。 -->
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
  import { ROUTE_LOCAL_PREFIX, WRITER_AGENT_FORM, type RouteForm } from "$shared/rpc-contract.ts";
  import {
    connectW,
    resetConnect,
    previewLink,
    previewNext,
    connectBack,
    applyImport,
    portsNext,
    setServicePort,
    refreshWriterPreview,
    refreshWizardPorts,
    applyWriter,
    finishConnect,
    testServiceRoute,
    AGENT_OPTIONS,
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

  /** ③ Agent/服务变化 → 重渲染 diff。 */
  function onAgentChange(value: string): void {
    const found = AGENT_OPTIONS.find((option) => option.value === value);
    if (found === undefined) return;
    connectW.agent = found.value;
    void refreshWriterPreview();
  }
  function onServiceChange(value: string): void {
    connectW.agentServiceId = value;
    connectW.testResults = {}; // 测试结果按服务归属：换服务即失效
    void refreshWizardPorts(); // auto-assign 端口快照可能滞后，切换即对账
    void refreshWriterPreview();
  }

  // NativeSelect 支持 bind:value + onchange 透传（照抄 GroupPicker 模式）：
  // 本地显示值 + 单向 store→显示同步；用户变更经 onchange 读 DOM 值回写 store
  let serviceSel = $state(connectW.agentServiceId);
  $effect(() => {
    serviceSel = connectW.agentServiceId;
  });
  let agentSel = $state(connectW.agent);
  $effect(() => {
    agentSel = connectW.agent;
  });

  function handleServiceChange(event: Event & { currentTarget: EventTarget & HTMLSelectElement }): void {
    onServiceChange(event.currentTarget.value);
  }
  function handleAgentChange(event: Event & { currentTarget: EventTarget & HTMLSelectElement }): void {
    onAgentChange(event.currentTarget.value);
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
  // ③ API endpoints（M3-r4）：按标准路由的本地 base 呈现 + agent 可用性 + 测试
  // ---------------------------------------------------------------------------

  /** form 人类可读标签（端点行与可用性提示共用）。 */
  const FORM_LABELS: Readonly<Record<RouteForm, string>> = {
    "openai-chat": "openai (chat completions)",
    "openai-responses": "openai (responses)",
    anthropic: "anthropic (messages)",
  };

  /** 当前选中服务（端点区与可用性判定）。 */
  const selectedService = $derived(
    connectW.applied?.services.find((service) => service.serviceId === connectW.agentServiceId) ??
      null,
  );
  /** 选中服务的解析端口（ports 表优先，回退 defaultPort 投影）。 */
  const selectedPort = $derived(
    connectW.ports.find((row) => row.serviceId === connectW.agentServiceId)?.port ??
      selectedService?.defaultPort ??
      null,
  );
  /** 选中服务声明的路径路由（空 = legacy 透传）。 */
  const selectedRoutes = $derived(
    connectW.agentServiceId === "" ? [] : connectW.serviceRoutes[connectW.agentServiceId] ?? [],
  );
  /** 该标准路由的本地前缀（M3-r6：规则自带 from；缺省派生规范前缀）。
      anthropic 家族剥尾部版本段——Claude Code 自带 /v1/messages。 */
  function localPrefixForForm(form: RouteForm): string | null {
    // 端点 base 仅 prefix 模式可给（pattern 模式无稳定前缀面）
    const route = selectedRoutes.find((r) => r.forms.includes(form) && r.mode !== "pattern");
    if (route === undefined) return null;
    const local = route.localPrefix ?? ROUTE_LOCAL_PREFIX[form];
    return form === "anthropic" ? local.replace(/\/v\d+$/, "") : local;
  }
  /** 端点行：按标准聚合路由（标签 + 本地 base + upstream 映射注记 + 测试）。 */
  const selectedUpstream = $derived(connectW.serviceUpstream[connectW.agentServiceId] ?? null);
  const routeRows = $derived(
    selectedPort === null
      ? []
      : (["openai-chat", "openai-responses", "anthropic"] as const)
          .map((form) => {
            const local = localPrefixForForm(form);
            if (local === null) return null;
            const route = selectedRoutes.find((r) => r.forms.includes(form) && r.mode !== "pattern")!;
            return {
              form,
              label: FORM_LABELS[form],
              base: `http://127.0.0.1:${selectedPort}${local}`,
              forwardsTo:
                selectedUpstream === null
                  ? null
                  : `${selectedUpstream.replace(/\/+$/, "")}${route.upstreamPrefix}/...`,
              result: connectW.testResults[form] ?? null,
            };
          })
          .filter((row): row is NonNullable<typeof row> => row !== null),
  );
  /** legacy 直通 base（服务无 routes）。 */
  const bareBase = $derived(selectedPort === null ? null : `http://127.0.0.1:${selectedPort}`);

  /** 当前 agent 使用的 API 标准（skip = null）。 */
  const agentForm = $derived(
    connectW.agent === "skip" ? null : WRITER_AGENT_FORM[connectW.agent],
  );
  const agentFormServed = $derived(
    agentForm !== null && selectedRoutes.some((route) => route.forms.includes(agentForm)),
  );
  const agentFormBase = $derived(
    agentForm !== null && selectedPort !== null && localPrefixForForm(agentForm) !== null
      ? `http://127.0.0.1:${selectedPort}${localPrefixForForm(agentForm)}`
      : null,
  );

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
    <StepHeader step={connectW.step} titles={["paste link", "ports", "agent setup"]} />
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

  <!-- ③ Agent 配置 -->
  {:else}
    <Card title="agent setup" scroll={false}>
      <div class="flex flex-col gap-3 p-3">
        <div class="grid gap-3 sm:grid-cols-2">
          <!-- NativeSelect（popover Select 只支持 bind:value 无 onchange，曾致
               ③ 步死锁；此处换原生 select + onchange 透传） -->
          <NativeSelect label="service" bind:value={serviceSel} onchange={handleServiceChange}>
            {#each serviceOptions as option (option.value)}
              <option value={option.value}>{option.label}</option>
            {/each}
          </NativeSelect>
          <NativeSelect label="agent" bind:value={agentSel} onchange={handleAgentChange}>
            {#each AGENT_OPTIONS as option (option.value)}
              <option value={option.value}>{option.label}</option>
            {/each}
          </NativeSelect>
        </div>

        <!-- agent 可用性标注：按 WRITER_AGENT_FORM 查服务 routes 是否覆盖该标准 -->
        {#if agentForm !== null && selectedService !== null}
          {#if agentFormServed && agentFormBase !== null}
            <p class="text-[11px] leading-relaxed text-[color:var(--success)]">
              this service serves {FORM_LABELS[agentForm]} at
              <code class="font-mono">{agentFormBase}</code>
            </p>
          {:else if selectedRoutes.length > 0}
            <p class="text-[11px] leading-relaxed text-[color:var(--warning)]">
              this service does not expose {FORM_LABELS[agentForm]} - pick another agent or service
            </p>
          {:else}
            <p class="text-[11px] leading-relaxed text-muted-foreground">
              legacy passthrough - this service has no per-standard routes; point the agent at the
              bare base below.
            </p>
          {/if}
        {/if}

        <!-- API endpoints（M3-r4）：按标准路由的本地 base + 行内连通测试 -->
        <div class="flex flex-col gap-2 border border-border/70 p-3">
          <span class="font-nav text-[11px] uppercase tracking-[0.1em] text-muted-foreground">
            api endpoints
          </span>
          {#if selectedService === null || selectedPort === null}
            <p class="text-[11px] text-muted-foreground">select a service to see its endpoints.</p>
          {:else if routeRows.length > 0}
            {#each routeRows as row (row.form)}
              <div class="flex flex-col gap-1">
                <div class="flex flex-wrap items-center gap-2">
                  <span class="w-full flex-none text-xs sm:w-44">{row.label}</span>
                  <div class="min-w-0 flex-1">
                    <CopyField value={row.base} />
                  </div>
                  <PressButton
                    variant="outline"
                    loading={connectW.testBusy === row.form}
                    onclick={() => void testServiceRoute(row.form)}
                  >test</PressButton>
                </div>
                {#if row.forwardsTo !== null}
                  <p class="break-all pl-1 font-mono text-[11px] text-muted-foreground">
                    → {row.forwardsTo}
                  </p>
                {/if}
                {#if row.result !== null}
                  {#if row.result.ok}
                    <p class="font-mono text-[11px] text-[color:var(--success)]">
                      ok {row.result.latencyMs}ms{row.result.httpStatus !== undefined ? ` (HTTP ${row.result.httpStatus})` : ""}
                    </p>
                  {:else}
                    <p class="text-[11px] leading-relaxed text-[color:var(--warning)]">
                      failed{row.result.httpStatus !== undefined ? ` (HTTP ${row.result.httpStatus})` : ""}{failureExcerpt(row.result) !== null ? `: ${failureExcerpt(row.result)}` : ""}
                    </p>
                  {/if}
                  {#if row.result.request.url !== ""}
                    <p class="break-all font-mono text-[11px] text-muted-foreground">
                      POST {shortenUrl(row.result.request.url)}
                    </p>
                  {/if}
                {/if}
              </div>
            {/each}
          {:else if bareBase !== null}
            <div class="flex flex-col gap-1.5">
              <CopyField value={bareBase} />
              <p class="text-[11px] text-muted-foreground">legacy passthrough - no per-standard routes</p>
            </div>
          {/if}
        </div>

        {#if connectW.agent === "skip"}
          <p class="text-xs leading-relaxed text-muted-foreground">
            no config will be written. your ports are ready - point any tool at
            <code class="font-mono">http://127.0.0.1:&lt;port&gt;</code> whenever you like.
          </p>
        {:else if connectW.writerBusy}
          <div class="flex flex-col gap-2">
            <Skeleton class="h-4 w-1/2" />
            <Skeleton class="h-36" />
          </div>
        {:else if connectW.writerPreview !== null}
          <div class="flex flex-col gap-1.5" transition:slide={{ duration: 150 }}>
            <p class="text-[11px] text-muted-foreground">
              writes <code class="font-mono">{connectW.writerPreview.path}</code>
              ({connectW.writerPreview.exists ? "existing file - other settings are preserved" : "new file"})
              - base url <code class="font-mono">{connectW.writerPreview.baseUrl}</code>
            </p>
            <pre class="diff-block border border-border bg-muted/40 p-3">{connectW.writerPreview.diff}</pre>
          </div>
        {:else if connectW.writerError !== null}
          <!-- preview 失败不堵路：错误在卡片下方就地展示，footer 的 finish 仍可达 -->
          <p class="text-xs leading-relaxed text-muted-foreground">
            preview failed - see the error below. adjust the service or agent, or finish without
            writing a config.
          </p>
        {:else}
          <p class="text-xs text-muted-foreground">pick a service and an agent to preview the diff.</p>
        {/if}
      </div>
      {#snippet foot()}
        <CardFooter label="connect wizard actions">
          <PressButton variant="ghost" onclick={connectBack} class={connectW.writerApplyBusy ? "pointer-events-none opacity-50" : undefined}>back</PressButton>
          <!-- 死锁解除（M3-r4 ⑥b）：skip/写完照旧放行 finish；preview 缺席
               （加载中/失败/未选）也放行——页脚始终有可点击的出路 -->
          {#if connectW.agent === "skip" || connectW.writerDone || connectW.writerPreview === null}
            <PressButton variant="fill" href="#/dashboard" external={false} onclick={() => finishConnect()}>
              finish - go to dashboard
            </PressButton>
          {:else}
            <PressButton
              variant="fill"
              loading={connectW.writerApplyBusy}
              class={connectW.writerPreview === null ? "pointer-events-none opacity-50" : undefined}
              onclick={() => void applyWriter()}
            >
              write agent config
            </PressButton>
          {/if}
        </CardFooter>
      {/snippet}
    </Card>
    <ErrorAlert error={connectW.writerError} />
    {#if connectW.writerDone}
      <Alert variant="tonal" class="jx-hue-success" title="agent config written">
        restart the agent if it is running, then point it at the local gateway.
      </Alert>
    {/if}
  {/if}
</div>
