<!-- 使用方接入向导（B 3.3，#/connect 三步）：
     ①粘贴链接（离线预览：提供者别名/分组/服务表：名称+默认端口+match 数）
     → ②端口确认（apply 即导入+网关启动；实际端口表 + 冲突自动错开显著
     标注 + 可改）→ ③test（M3-r8 Owner 裁决：无 agent setup——选协议、
     选端点（中性表达：本地前缀 → upstream 目标）、单输入框（默认 hi）发
     真实 AI 请求走完整 wire 链路；结果面板展示状态/时延/回复正文）。
     状态机在 stores/connect-wizard。 -->
<script lang="ts">
  import { onMount, untrack } from "svelte";
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
  import ServiceTestCard from "../components/ServiceTestCard.svelte";
  import { t } from "$lib/i18n.svelte.ts";
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
    dialGuidance,
  } from "../stores/connect-wizard.svelte.ts";

  /** Owner 2026-09-13：进②自动导入并启动（去掉"导入并启动"多余一步；
   *  出错不自动重试——修好链接后返回①再进才会重启导入）。 */
  let step2AutoStarted = $state(false);
  $effect(() => {
    if (connectW.step !== 2) {
      step2AutoStarted = false;
      return;
    }
    if (!step2AutoStarted && connectW.applied === null && !connectW.applyBusy && connectW.applyError === null) {
      step2AutoStarted = true;
      untrack(() => void applyImport());
    }
  });

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

  /** ③ 换服务：结果清空 + 端口对账。 */
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

  function handleServiceChange(event: Event & { currentTarget: EventTarget & HTMLSelectElement }): void {
    onServiceChange(event.currentTarget.value);
  }

  const serviceOptions = $derived(
    connectW.applied !== null
      ? connectW.applied.services.map((service) => {
          const port = connectW.ports.find((row) => row.serviceId === service.serviceId)?.port;
          return {
            value: service.serviceId,
            label: port === undefined ? `${service.name} ${t("connect.test.portFromGateway")}` : `${service.name} ${t("connect.test.portLabel", { port })}`,
          };
        })
      : [],
  );
</script>

<div class="mx-auto flex max-w-3xl flex-col gap-4 p-4 md:p-6">
  <header class="flex flex-col gap-2">
    <h1 class="font-nav text-base uppercase tracking-[0.1em]">{t("connect.title")}</h1>
    <StepHeader step={connectW.step} titles={[t("connect.step1"), t("connect.step2"), t("connect.step3")]} />
  </header>

  <!-- ① 粘贴链接 -->
  {#if connectW.step === 1}
    <Card title={t("connect.paste.title")} scroll={false}>
      <div class="flex flex-col gap-3 p-3">
        <Input
          label={t("connect.paste.label")}
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
              <Badge variant="tonal" class="jx-hue-success">{t("connect.paste.previewOk")}</Badge>
              <span class="text-muted-foreground">{t("connect.paste.group")}</span>
              <code class="font-mono">{connectW.preview.group}</code>
            </div>
            <table class="w-full text-xs">
              <thead>
                <tr class="border-b border-border text-left font-nav text-[10px] uppercase tracking-[0.1em] text-muted-foreground">
                  <th class="py-1.5 font-normal">{t("common.service")}</th>
                  <th class="py-1.5 font-normal">{t("connect.paste.table.defaultPort")}</th>
                  <th class="py-1.5 font-normal">{t("connect.paste.table.matchRules")}</th>
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
          <PressButton variant="ghost" onclick={() => resetConnect()}>{t("connect.paste.clear")}</PressButton>
          <PressButton
            variant="fill"
            loading={connectW.previewBusy}
            class={connectW.link.trim() === "" ? "pointer-events-none opacity-50" : undefined}
            onclick={() => void previewLink()}
          >
            {t("connect.paste.preview")}
          </PressButton>
          {#if connectW.preview !== null}
            <PressButton variant="outline" onclick={previewNext}>{t("common.continue")}</PressButton>
          {/if}
        </CardFooter>
      {/snippet}
    </Card>
    <ErrorAlert error={connectW.previewError} />

  <!-- ② 端口确认 -->
  {:else if connectW.step === 2}
    <Card title={t("connect.ports.title")} scroll={false}>
      <div class="flex flex-col gap-3 p-3">
        {#if connectW.applied === null}
          <!-- 合并状态（Owner 2026-09-13 #3）：导入即开始，无需按钮 -->
          <div class="flex flex-col gap-2">
            <p class="text-xs text-muted-foreground">
              {t("connect.ports.autoImporting", { provider: connectW.preview?.alias ?? "provider" })}
            </p>
            <Skeleton class="h-5 w-2/3" />
            <Skeleton class="h-24" />
          </div>
          {#if applyGuidance !== null}
            <Alert variant="tonal" class="jx-hue-info" title={t("connect.ports.cannotReach")}>
              {applyGuidance}
            </Alert>
          {/if}
        {:else}
          <div class="flex flex-wrap items-center gap-2 text-xs" transition:slide={{ duration: 180 }}>
            <span class="font-mono">{connectW.applied.alias}</span>
            <Badge variant="tonal" class="jx-hue-success">{t("connect.ports.imported")}</Badge>
            {#if connectW.applied.redeemed}
              <Badge variant="outline">{t("connect.ports.tokenRedeemed")}</Badge>
            {/if}
            {#if connectW.gatewayStarted}
              <Badge variant="tonal" class="jx-hue-success">{t("connect.ports.gatewayRunning")}</Badge>
            {:else}
              <Badge variant="tonal" class="jx-hue-warning">{t("connect.ports.gatewayNotRunning")}</Badge>
            {/if}
          </div>
          <table class="w-full text-xs">
            <thead>
              <tr class="border-b border-border text-left font-nav text-[10px] uppercase tracking-[0.1em] text-muted-foreground">
                <th class="py-1.5 font-normal">{t("common.service")}</th>
                <th class="py-1.5 font-normal">{t("connect.ports.table.defaultShort")}</th>
                <th class="py-1.5 font-normal">{t("connect.ports.table.actual")}</th>
                <th class="py-1.5 font-normal">{t("connect.ports.set")}</th>
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
                        <Badge variant="tonal" class="jx-hue-warning">{t("connect.ports.autoShifted")}</Badge>
                      {/if}
                      {#if row.pinned}
                        <Badge variant="outline">{t("connect.ports.pinned")}</Badge>
                      {/if}
                    </span>
                    {#if row.autoShifted}
                      <span class="block text-[10px] leading-tight text-muted-foreground">
                        {t("connect.ports.autoShiftedNote", { port: row.defaultPort, actual: row.port })}
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
                        {t("connect.ports.set")}
                      </PressButton>
                    </span>
                  </td>
                </tr>
              {/each}
            </tbody>
          </table>
          <p class="text-[11px] text-muted-foreground">
            {t("connect.ports.note")}
          </p>
        {/if}
      </div>
      {#snippet foot()}
        <CardFooter label="connect wizard actions">
          <PressButton variant="ghost" onclick={connectBack} class={connectW.applyBusy ? "pointer-events-none opacity-50" : undefined}>{t("common.back")}</PressButton>
          {#if connectW.applied !== null}
            <PressButton variant="fill" onclick={portsNext}>{t("common.continue")}</PressButton>
          {/if}
        </CardFooter>
      {/snippet}
    </Card>
    <ErrorAlert error={connectW.applyError ?? connectW.portError} />

  <!-- ③ test（M3-r8 Owner 裁决：agent setup 步不该存在——本步 = 选协议、
       选端点、单输入框发真实 AI 请求；不写任何 agent 配置。协议/端点/输入框
       在共享 ServiceTestCard（Advanced services 行内同形）） -->
  {:else}
    <Card title={t("connect.test.title")} scroll={false}>
      <div class="flex flex-col gap-3 p-3">
        {#if serviceOptions.length > 1}
          <NativeSelect label={t("common.service")} bind:value={serviceSel} onchange={handleServiceChange}>
            {#each serviceOptions as option (option.value)}
              <option value={option.value}>{option.label}</option>
            {/each}
          </NativeSelect>
        {/if}
        {#key connectW.testServiceId}
          <ServiceTestCard
            routes={connectW.serviceRoutes[connectW.testServiceId] ?? []}
            upstream={connectW.serviceUpstream[connectW.testServiceId] ?? null}
            busy={connectW.testBusy}
            result={connectW.testResult}
            disabled={connectW.testServiceId === ""}
            onsend={(payload) => void sendTest(payload)}
          />
        {/key}
      </div>
      {#snippet foot()}
        <CardFooter label="connect wizard actions">
          <PressButton variant="ghost" onclick={connectBack}>{t("common.back")}</PressButton>
          <PressButton variant="fill" href="#/dashboard" external={false} onclick={() => finishConnect()}>
            {t("connect.finish")}
          </PressButton>
        </CardFooter>
      {/snippet}
    </Card>
  {/if}
</div>
