<!-- 使用方接入向导（B 3.3，#/connect 三步）：
     ①粘贴链接（离线预览：提供者别名/分组/服务表：名称+默认端口+match 数）
     → ②端口确认（apply 即导入+网关启动；实际端口表 + 冲突自动错开显著
     标注 + 可改）→ ③Agent 配置（服务+Agent 选择 → writers.preview 渲染
     等宽 diff → 确认 writers.apply）。状态机在 stores/connect-wizard。 -->
<script lang="ts">
  import { onMount } from "svelte";
  import Card, { CardFooter } from "$lib/ui/card";
  import Badge from "$lib/ui/badge";
  import PressButton from "$lib/ui/press-button";
  import Input from "$lib/ui/input";
  import Select from "$lib/ui/select";
  import Alert from "$lib/ui/alert";
  import Skeleton from "$lib/ui/skeleton";
  import { slide } from "svelte/transition";
  import StepHeader from "../components/StepHeader.svelte";
  import ErrorAlert from "../components/ErrorAlert.svelte";
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
    refreshWriterPreview,
    refreshWizardPorts,
    applyWriter,
    finishConnect,
    AGENT_OPTIONS,
    dialGuidance,
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
    void refreshWriterPreview();
  }

  const serviceOptions = $derived(
    connectW.applied !== null
      ? connectW.applied.services.map((service) => ({
          value: service.serviceId,
          label: `${service.name} (port from local gateway)`,
        }))
      : [],
  );
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
          <Select
            label="service"
            options={serviceOptions}
            value={connectW.agentServiceId}
            onchange={onServiceChange}
          />
          <Select
            label="agent"
            options={AGENT_OPTIONS.map((option) => ({ value: option.value, label: option.label }))}
            value={connectW.agent}
            onchange={onAgentChange}
          />
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
        {:else}
          <p class="text-xs text-muted-foreground">pick a service and an agent to preview the diff.</p>
        {/if}
      </div>
      {#snippet foot()}
        <CardFooter label="connect wizard actions">
          <PressButton variant="ghost" onclick={connectBack} class={connectW.writerApplyBusy ? "pointer-events-none opacity-50" : undefined}>back</PressButton>
          {#if connectW.agent === "skip" || connectW.writerDone}
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
