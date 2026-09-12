<!-- 高级设置（B 3.5 + M3 6.x，#/advanced）：Tabs = 服务 / 分组 / 密钥 /
     密钥库 / 中继与限额 / 设置。net-fly 通用概念（match 全集、rewrite 规则、
     relay 配置）只出现在这里；默认一行一服务，展开 detail（$env:/$secret:
     注入值掩码），行内 test 连通测试（M3 6.3）。keys = 消费者侧 share 密钥
     （issue 一次性原文 dialog + revoke 两步确认）；secrets = provider 侧
     上游密钥库（列表/增删改内联卡，值不回显，M3 6.1/6.2）。relay & limits
     含中继服务器快速选择 Dialog（SDK 默认/自定义；自托管 opendweb server
     部署在独立机器，app 只消费其 relay URL——Owner 裁决 2026-09-12）。
     状态机在 stores/advanced。 -->
<script lang="ts">
  import { onMount, untrack } from "svelte";
  import Card, { CardFooter } from "$lib/ui/card";
  import Badge from "$lib/ui/badge";
  import PressButton from "$lib/ui/press-button";
  import Input from "$lib/ui/input";
  import Select from "$lib/ui/select";
  import Alert from "$lib/ui/alert";
  import Skeleton from "$lib/ui/skeleton";
  import Separator from "$lib/ui/separator";
  import Toggle from "$lib/ui/toggle";
  import ThemeToggle from "$lib/ui/theme-toggle";
  import Tabs, { TabsList, TabsTrigger, TabsContent } from "$lib/ui/tabs";
  import Dialog from "$lib/ui/dialog";
  import { toRpcError } from "$lib/rpc-client";
  import type { ServiceConfigView } from "$shared/rpc-contract.ts";
  import { slide } from "svelte/transition";
  import ErrorAlert from "../components/ErrorAlert.svelte";
  import CopyField from "../components/CopyField.svelte";
  import SecretPicker from "../components/SecretPicker.svelte";
  import ServiceTestCard from "../components/ServiceTestCard.svelte";
  import type { ServiceRouteView as ServiceTestCardRoutes, RouteTestOutput } from "../stores/connect-wizard.svelte.ts";
  import type { RouteForm } from "$shared/rpc-contract.ts";
  import RelayPickerDialog from "../components/RelayPickerDialog.svelte";
  import { t } from "$lib/i18n.svelte.ts";
  import TestConnection from "../components/TestConnection.svelte";
  import { app, refresh } from "../stores/app.svelte.ts";
  import { call } from "../stores/rpc.svelte.ts";
  import { toastRpcError } from "../stores/toast.svelte.ts";
  import { setSecret, removeSecret } from "../stores/secrets.svelte.ts";
  import {
    maskSecret,
    serviceForm,
    hooksPanel,
    loadHooks,
    hookAdd,
    submitHookAdd,
    removeHookScript,
    hookView,
    openHookView,
    serviceShare,
    openServiceShare,
    submitServiceShare,
    openServiceAdd,
    openServiceEdit,
    closeServiceForm,
    submitService,
    serviceRemove,
    removeService,
    groupForm,
    openGroupAdd,
    submitGroupAdd,
    groupEdit,
    openGroupEdit,
    submitGroupEdit,
    groupRemove,
    removeGroup,
    keyIssue,
    issueKey,
    keyRevoke,
    revokeKey,
    relayForm,
    initRelayForm,
    saveRelay,
    settingsEdit,
    setModelsDev,
  } from "../stores/advanced.svelte.ts";

  let tab = $state("services");
  /** 服务行展开集合（detail：upstream/match 全集/rewrite；$env 值显示 ●）。 */
  let expanded = $state(new Set<string>());
  /** 密钥 dialog 的 open（result 驱动开、× / esc 关闭写回并清 result）。 */
  let keyDialogOpen = $state(false);

  onMount(() => {
    refresh("services", "groups", "keys", "settings");
  });

  /** settings 到达后初始化 relay 编辑框（一次）。 */
  let relayInited = false;
  $effect(() => {
    if (!relayInited && app.settings !== null) {
      relayInited = true;
      initRelayForm();
    }
  });

  // 密钥 dialog 开合同步：result 出现 → open；dialog 自身关闭 → 清 result
  $effect(() => {
    keyDialogOpen = keyIssue.result !== null;
  });
  $effect(() => {
    if (!keyDialogOpen && keyIssue.result !== null) keyIssue.result = null;
  });

  // hooks 面板按需加载（Owner 视觉验收 2026-09-13 #5：模板里调
  // loadHooks() 会把 Promise 渲染成 "[object Promise]"——加载是副作用，
  // 归 $effect；untrack 隔离 loadHooks 内部读的 busy/loaded（否则
  // busy 翻转会把本效果卷进重跑）。增删后的强刷由 store 自身负责）
  $effect(() => {
    if (tab === "hooks") untrack(() => void loadHooks());
  });

  // ── 密钥库区（M3 6.1）：页面内联卡（非 dialog）──────────────────────
  // 共享 store 只持名称名单（SecretPicker 用）；本区另持带时间戳的行
  // （契约回 name/createdAt/updatedAt/bearerPrefix，值不跨 RPC 亦不回显）。
  interface SecretRow {
    name: string;
    createdAt: number;
    updatedAt: number;
    bearerPrefix: boolean;
  }
  let secretRows = $state<SecretRow[]>([]);
  let secretsLoading = $state(false);
  let secretsLoaded = $state(false);
  // 名词法镜像契约 SECRET_NAME_SCHEMA（同 SecretsDialog，不引 zod 保 bundle 干净）
  const SECRET_NAME_RE = /^[a-z0-9][a-z0-9._-]*$/;
  let secretNameDraft = $state("");
  /** password 型输入，提交后即清空，永不回显。 */
  let secretValueDraft = $state("");
  /** Bearer 开关（M3-acceptance ①）：编辑既有条目时回填该条目值。 */
  let secretBearerPrefix = $state(true);
  /** 正在覆写的既有密钥名（编辑 = 同名 set 覆写；值不回显）。 */
  let secretEditing = $state<string | null>(null);
  /** 行内 remove 二次确认（与 services/keys 行同款切换）。 */
  let secretConfirm = $state<string | null>(null);
  let secretRemoving = $state<string | null>(null);
  let secretBusy = $state(false);

  // 进入 secrets 区拉一份名单（set/remove 成功后各自再刷）
  $effect(() => {
    if (tab === "secrets") void loadSecretRows();
  });

  // ── relay 选择 Dialog（Owner 裁决 2026-09-11/12：快速配置 SDK 默认/自定义；
  //     自托管 server 部署在独立机器，app 只消费其 relay URL）────────────
  let relayDialogOpen = $state(false);

  async function loadSecretRows(): Promise<void> {
    if (secretsLoading) return;
    secretsLoading = true;
    try {
      const result = await call((c) => c.provider.secrets.list({}));
      secretRows = result.secrets;
      secretsLoaded = true;
    } catch (error) {
      toastRpcError(toRpcError(error));
    } finally {
      secretsLoading = false;
    }
  }

  const secretNameError = $derived(
    secretNameDraft.trim() === "" || SECRET_NAME_RE.test(secretNameDraft.trim())
      ? undefined
      : "lowercase letters, digits, dot, dash, underscore",
  );
  const secretFormValid = $derived(
    secretNameError === undefined && secretNameDraft.trim() !== "" && secretValueDraft !== "",
  );

  function resetSecretForm(): void {
    secretNameDraft = "";
    secretValueDraft = "";
    secretBearerPrefix = true;
    secretEditing = null;
  }

  function editSecretRow(row: SecretRow): void {
    secretEditing = row.name;
    secretNameDraft = row.name;
    secretValueDraft = "";
    secretBearerPrefix = row.bearerPrefix;
  }

  async function submitSecret(): Promise<void> {
    const name = secretNameDraft.trim();
    if (secretBusy || !secretFormValid) return;
    secretBusy = true;
    const ok = await setSecret(name, secretValueDraft, secretBearerPrefix);
    secretBusy = false;
    if (!ok) return; // 失败已由 store toast
    await loadSecretRows();
    resetSecretForm();
  }

  async function removeSecretRow(name: string): Promise<void> {
    if (secretRemoving !== null) return;
    secretRemoving = name;
    const ok = await removeSecret(name);
    secretRemoving = null;
    if (!ok) return;
    secretConfirm = null;
    void loadSecretRows();
  }

  // ── 服务行内联 test（Owner 裁决 2026-09-11：与 connect ③ 同形）────────────
  /** 内联 test 展开中的服务 id（null = 全收起；互斥从简）。 */
  let serviceTestOpen = $state<string | null>(null);
  /** testRoute 在途的服务 id（单飞防重入）。 */
  let serviceTestBusy = $state("");
  /** serviceId → testRoute 结果（RPC 层失败合成为 ok=false 就地展示）。 */
  let serviceTestResults = $state<Record<string, RouteTestOutput | undefined>>({});

  async function runServiceTest(
    name: string,
    payload: { form: RouteForm; content: string; localPrefix?: string | undefined },
  ): Promise<void> {
    const serviceId = app.services.find((service) => service.name === name)?.serviceId ?? name;
    if (serviceTestBusy !== "") return;
    serviceTestBusy = serviceId;
    serviceTestResults[serviceId] = undefined;
    try {
      serviceTestResults[serviceId] = await call((c) =>
        c.provider.services.testRoute({
          name,
          form: payload.form,
          content: payload.content,
          ...(payload.localPrefix !== undefined ? { localPrefix: payload.localPrefix } : {}),
        }),
      );
    } catch (error) {
      serviceTestResults[serviceId] = {
        ok: false,
        latencyMs: 0,
        request: { method: "POST", url: "" },
        error: toRpcError(error).message,
      };
    } finally {
      serviceTestBusy = "";
    }
  }

  /** 行头 key injected 徽章：hook 协议（对象）注入即亮。 */
  function hasInjectedAuth(service: ServiceConfigView): boolean {
    const authorization = service.rewrite?.headerSet?.["authorization"];
    return authorization !== undefined && typeof authorization === "object";
  }

  /** 头值 humanize：字面量原样；钩子调用 `hook <fn>(k=v)[ bearer]`。 */
  function humanizeValue(value: string | { hook: string; args?: Record<string, string>; bearer?: boolean }): string {
    if (typeof value === "string") return value;
    const args = Object.entries(value.args ?? {})
      .map(([k, v]) => `${k}=${k === "name" || k === "var" ? v : "***"}`)
      .join(", ");
    return `hook ${value.hook}${args !== "" ? ` (${args})` : ""}${value.bearer === true ? " [bearer]" : ""}`;
  }

  function toggleExpanded(serviceId: string): void {
    const next = new Set(expanded);
    if (next.has(serviceId)) next.delete(serviceId);
    else next.add(serviceId);
    expanded = next;
  }

  /** 分组名 → 该组包含的服务名集合（serviceIds ↔ names 映射）。 */
  const serviceNamesById = $derived(
    new Map(app.services.map((service) => [service.serviceId, service.name])),
  );
  const groupsOfService = $derived.by(() => {
    const map = new Map<string, string[]>();
    for (const group of app.groups) {
      for (const serviceId of group.serviceIds) {
        const name = serviceNamesById.get(serviceId) ?? serviceId;
        map.set(name, [...(map.get(name) ?? []), group.name]);
      }
    }
    return map;
  });

  const keyGroupOptions = $derived(app.groups.map((group) => ({ value: group.name, label: group.name })));

  /** 分组 → 未撤销密钥数（行卡片摘要，M3-acceptance ②）。 */
  const activeKeysByGroup = $derived.by(() => {
    const map = new Map<string, number>();
    for (const key of app.keys) {
      if (key.revokedAt !== undefined) continue;
      map.set(key.group, (map.get(key.group) ?? 0) + 1);
    }
    return map;
  });

  /** 主题偏好同步：Advanced 里的切换同时落引擎设置（点击后读 localStorage）。 */
  function syncThemeToSettings(): void {
    setTimeout(() => {
      const theme = window.localStorage.getItem("theme");
      if (theme === "light" || theme === "dark" || theme === "system") {
        void call((c) => c.system.settings.set({ theme })).catch(() => undefined);
      }
    }, 50);
  }

  /** 点击捕获走 action（模板 handler 会触发静态元素 a11y 告警）。 */
  function captureClicks(node: HTMLElement): { destroy(): void } {
    node.addEventListener("click", syncThemeToSettings);
    return {
      destroy() {
        node.removeEventListener("click", syncThemeToSettings);
      },
    };
  }

  function formatDate(ms: number): string {
    return new Date(ms).toLocaleString();
  }
</script>

<div class="mx-auto flex max-w-4xl flex-col gap-4 p-4 md:p-6">
  <header class="flex flex-wrap items-baseline justify-between gap-2">
    <h1 class="font-nav text-base uppercase tracking-[0.1em]">{t("adv.title")}</h1>
    <p class="text-xs text-muted-foreground">
      {t("adv.subtitle")}
    </p>
  </header>

  <Tabs bind:value={tab}>
    <TabsList>
      <TabsTrigger value="services">{t("adv.tab.services")}</TabsTrigger>
      <TabsTrigger value="groups">{t("adv.tab.groups")}</TabsTrigger>
      <TabsTrigger value="secrets">{t("adv.tab.secrets")}</TabsTrigger>
      <TabsTrigger value="hooks">{t("adv.tab.hooks")}</TabsTrigger>
      <TabsTrigger value="relay">{t("adv.tab.relay")}</TabsTrigger>
      <TabsTrigger value="settings">{t("adv.tab.settings")}</TabsTrigger>
    </TabsList>

    <!-- ── 服务 ─────────────────────────────────────────────── -->
    <TabsContent value="services">
      <div class="flex flex-col gap-3">
        <div class="flex items-center justify-between">
          <p class="text-xs text-muted-foreground">
            {t("adv.services.hint")}
          </p>
          <PressButton variant="outline" onclick={openServiceAdd}>{t("adv.services.add")}</PressButton>
        </div>

        {#if app.busy.services && app.services.length === 0}
          <div class="flex flex-col gap-2">
            <Skeleton class="h-10" />
            <Skeleton class="h-10" />
          </div>
        {:else if app.services.length === 0}
          <Card scroll={false}>
            <p class="p-4 text-xs text-muted-foreground">
              {t("adv.services.empty")}
            </p>
          </Card>
        {:else}
          <div class="flex flex-col gap-2">
            {#each app.services as service (service.serviceId)}
              {@const open = expanded.has(service.serviceId)}
              <div class="border border-border bg-card shadow-2xs" transition:slide={{ duration: 150 }}>
                <div class="flex flex-wrap items-center gap-2 px-3 py-2.5">
                  <button
                    type="button"
                    class="flex min-w-0 flex-1 items-center gap-2 text-left"
                    aria-expanded={open}
                    onclick={() => toggleExpanded(service.serviceId)}
                  >
                    <span
                      class="font-mono text-[10px] text-muted-foreground transition-transform {open ? 'rotate-90' : ''}"
                      aria-hidden="true"
                    >&#9656;</span>
                    <span class="truncate font-mono text-xs">{service.name}</span>
                    <Badge variant="outline">:{service.defaultPort}</Badge>
                    {#each groupsOfService.get(service.name) ?? [] as groupName (groupName)}
                      <Badge variant="tonal">{groupName}</Badge>
                    {/each}
                    {#if hasInjectedAuth(service)}
                      <Badge variant="tonal" class="jx-hue-info">{t("adv.services.keyInjected")}</Badge>
                    {/if}
                  </button>
                  <span class="flex items-center gap-1.5">
                    <PressButton
                      variant="ghost"
                      onclick={() => (serviceTestOpen = serviceTestOpen === service.serviceId ? null : service.serviceId)}
                    >{t("common.test")}</PressButton>
                    <PressButton variant="ghost" onclick={() => openServiceShare(service.name)}>{t("adv.services.share")}</PressButton>
                    <PressButton variant="ghost" onclick={() => openServiceEdit(service)}>{t("common.edit")}</PressButton>
                    {#if serviceRemove.confirm === service.name}
                      <PressButton
                        variant="tonal"
                        class="jx-pair-destructive"
                        loading={serviceRemove.busy === service.name}
                        onclick={() => void removeService(service.name)}
                      >{t("common.confirmRemove")}</PressButton>
                      <PressButton variant="ghost" onclick={() => (serviceRemove.confirm = "")}>{t("common.cancel")}</PressButton>
                    {:else}
                      <PressButton
                        variant="ghost"
                        onclick={() => (serviceRemove.confirm = service.name)}
                      >{t("common.remove")}</PressButton>
                    {/if}
                  </span>
                </div>
                {#if open}
                  <!-- detail 展开：upstream / match 全集 / rewrite（$env:/$secret: 注入值掩码） -->
                  <dl class="grid gap-x-6 gap-y-1.5 border-t border-border px-3 py-2.5 text-xs" transition:slide={{ duration: 150 }}>
                    <div class="flex gap-2">
                      <dt class="w-20 flex-none text-muted-foreground">{t("adv.services.upstream")}</dt>
                      <dd class="min-w-0 break-all font-mono">{service.upstream}</dd>
                    </div>
                    <div class="flex gap-2">
                      <dt class="w-20 flex-none text-muted-foreground">match ({service.match.length})</dt>
                      <dd class="flex min-w-0 flex-col gap-0.5 font-mono">
                        {#each service.match as rule, i (`${service.serviceId}:${i}`)}
                          <span class="break-all">{rule.type}: {rule.value}</span>
                        {/each}
                      </dd>
                    </div>
                    {#if service.rewrite}
                      <div class="flex gap-2">
                        <dt class="w-20 flex-none text-muted-foreground">{t("adv.services.rewrite")}</dt>
                        <dd class="flex min-w-0 flex-col gap-0.5 font-mono">
                          {#if service.rewrite.hostHeader}<span>host: {service.rewrite.hostHeader}</span>{/if}
                          {#if service.rewrite.pathPrefixStrip}<span>strip: {service.rewrite.pathPrefixStrip}</span>{/if}
                          {#if service.rewrite.pathPrefixAppend}<span>append: {service.rewrite.pathPrefixAppend}</span>{/if}
                          {#each Object.entries(service.rewrite.headerSet ?? {}) as [name, value] (`${service.serviceId}:${name}`)}
                            <span>header {name}: {typeof value === "string" ? maskSecret(value) : humanizeValue(value)}</span>
                          {/each}
                          {#each service.rewrite.headerRemove ?? [] as name (`${service.serviceId}:rm:${name}`)}
                            <span>remove header {name}</span>
                          {/each}
                          {#if !service.rewrite.hostHeader && !service.rewrite.pathPrefixStrip && !service.rewrite.pathPrefixAppend && Object.keys(service.rewrite.headerSet ?? {}).length === 0 && (service.rewrite.headerRemove ?? []).length === 0}
                            <span class="text-muted-foreground">{t("adv.services.noRewrite")}</span>
                          {/if}
                        </dd>
                      </div>
                    {:else}
                      <div class="flex gap-2">
                        <dt class="w-20 flex-none text-muted-foreground">{t("adv.services.rewrite")}</dt>
                        <dd class="font-mono text-muted-foreground">{t("adv.services.none")}</dd>
                      </div>
                    {/if}
                    <div class="flex gap-2">
                      <dt class="w-20 flex-none text-muted-foreground">id</dt>
                      <dd class="min-w-0 break-all font-mono text-muted-foreground">{service.serviceId}</dd>
                    </div>
                  </dl>
                {/if}
                {#if serviceTestOpen === service.serviceId}
                  <!-- 行内按标准路由测试（Owner 裁决 2026-09-11：与 connect ③ 同形；
                       provider 直打 upstream——路由命中 + rewrite 注入，request.url
                       = 改写后的上游 URL） -->
                  <div class="border-t border-border px-3 py-2.5" transition:slide={{ duration: 150 }}>
                    {#key service.serviceId}
                      <ServiceTestCard
                        routes={(service.routes ?? []) as ServiceTestCardRoutes[]}
                        upstream={service.upstream}
                        busy={serviceTestBusy === service.serviceId}
                        result={serviceTestResults[service.serviceId] ?? null}
                        onsend={(payload) => void runServiceTest(service.name, payload)}
                      />
                    {/key}
                  </div>
                {/if}
              </div>
            {/each}
          </div>
        {/if}
        <ErrorAlert error={serviceRemove.error} />

        <!-- 服务增/改表单 -->
        {#if serviceForm.open}
          <Card title={serviceForm.editingName !== "" ? `edit service - ${serviceForm.editingName}` : "add service"} scroll={false}>
            <div class="flex flex-col gap-3 p-3">
              <div class="grid gap-3 sm:grid-cols-2">
                <Input
                  label={t("f.name")}
                  autocapitalize="none"
                  autocorrect="off"
                  spellcheck={false}
                  bind:value={serviceForm.name}
                />
                <Input label={t("f.port")} placeholder="default 8080" bind:value={serviceForm.port} />
              </div>
              <Input label={t("f.upstreamUrl")} placeholder="https://api.example.com/v1" autocapitalize="none" autocorrect="off" spellcheck={false} bind:value={serviceForm.upstream} />
              <div class="flex flex-col gap-1.5">
                <span class="font-nav text-[11px] uppercase tracking-[0.1em] text-muted-foreground">{t("f.matchRules")}</span>
                {#each serviceForm.match as rule, i (i)}
                  <div class="flex items-center gap-2">
                    <div class="w-28">
                      <!-- Select 只有 bind:value（无 onchange prop）——直写表单状态 -->
                      <Select
                        options={[
                          { value: "suffix", label: "suffix" },
                          { value: "exact", label: "exact" },
                          { value: "regex", label: "regex" },
                        ]}
                        bind:value={rule.type}
                      />
                    </div>
                    <input
                      class="min-w-0 flex-1 border border-border bg-transparent px-2.5 py-1.5 font-mono text-xs focus:border-primary focus:outline-none"
                      placeholder="api.example.com"
                      autocapitalize="none"
                      autocorrect="off"
                      spellcheck={false}
                      bind:value={serviceForm.match[i]!.value}
                    />
                    <PressButton
                      variant="ghost"
                      ariaLabel="remove match rule"
                      class={serviceForm.match.length <= 1 ? "pointer-events-none opacity-50" : undefined}
                      onclick={() => (serviceForm.match = serviceForm.match.filter((_, index) => index !== i))}
                    >x</PressButton>
                  </div>
                {/each}
                <PressButton
                  variant="ghost"
                  class="self-start"
                  onclick={() => (serviceForm.match = [...serviceForm.match, { type: "suffix", value: "" }])}
                >+ add rule</PressButton>
              </div>
              <!-- 密钥选择器（M3 6.2）：$env 变量名 → 本机密钥库；提交写 $secret: -->
              <SecretPicker
                value={serviceForm.secretName}
                onchange={(name) => (serviceForm.secretName = name)}
              />
              <!-- hooks 脚本选择器（Owner 视觉验收 2026-09-12）：无密钥选择时生效 -->
              <div class="flex items-center gap-2">
                <span class="w-24 flex-none font-nav text-[10px] uppercase tracking-[0.1em] text-muted-foreground">hooks</span>
                <div class="w-72">
                  <Select
                    options={[
                      { value: "", label: "none" },
                      ...hooksPanel.scripts.map((h) => ({
                        value: h.name,
                        label: `${h.name} (${h.fns.join(", ")})`,
                      })),
                    ]}
                    bind:value={serviceForm.hooks}
                  />
                </div>
              </div>
              <!-- 连通测试（M3 6.3）：自定义服务不传 apiForm（服务端缺省）/
                   presetId（无模型下拉），密钥取表单当前选择 -->
              <TestConnection upstream={serviceForm.upstream} secretName={serviceForm.secretName} />
              {#if serviceForm.editingName !== ""}
                <p class="text-[11px] text-muted-foreground">
                  editing re-creates the service (remove + add) - group membership is preserved by name.
                </p>
              {/if}
            </div>
            {#snippet foot()}
              <CardFooter label="service form actions">
                <PressButton variant="ghost" onclick={closeServiceForm} class={serviceForm.busy ? "pointer-events-none opacity-50" : undefined}>{t("common.cancel")}</PressButton>
                <PressButton variant="fill" loading={serviceForm.busy} onclick={() => void submitService()}>
                  {serviceForm.editingName !== "" ? "save changes" : "add service"}
                </PressButton>
              </CardFooter>
            {/snippet}
          </Card>
          <ErrorAlert error={serviceForm.error} />
        {/if}
      </div>
    </TabsContent>

    <!-- ── 分组与限额（M3-acceptance ②：行卡片 = 名称 + 服务 chips + 限额
         摘要 + active keys；edit 内联改成员与限额；remove 二次确认）── -->
    <TabsContent value="groups">
      <div class="flex flex-col gap-3">
        <div class="flex items-center justify-between">
          <p class="text-xs text-muted-foreground">
            members and limits can be replaced any time; a group with active keys
            must have them revoked before removal.
          </p>
          <PressButton variant="outline" onclick={openGroupAdd}>{t("adv.groups.add")}</PressButton>
        </div>

        {#if app.groups.length === 0 && !app.busy.groups}
          <Card scroll={false}>
            <p class="p-4 text-xs text-muted-foreground">{t("adv.groups.empty")}</p>
          </Card>
        {:else}
          <div class="flex flex-col gap-2">
            {#each app.groups as group (group.name)}
              {@const groupServiceNames = group.serviceIds.map((id) => serviceNamesById.get(id) ?? id)}
              {@const activeKeys = activeKeysByGroup.get(group.name) ?? 0}
              <div class="border border-border bg-card px-3 py-2.5 shadow-2xs" transition:slide={{ duration: 150 }}>
                <div class="flex flex-wrap items-center gap-2">
                  <span class="font-mono text-xs">{group.name}</span>
                  {#if group.limits?.maxConcurrency}
                    <Badge variant="tonal" class="jx-hue-info">max {group.limits.maxConcurrency} concurrent</Badge>
                  {/if}
                  {#if group.limits?.dailyRequests}
                    <Badge variant="tonal" class="jx-hue-info">{group.limits.dailyRequests}/day</Badge>
                  {/if}
                  {#if !group.limits?.maxConcurrency && !group.limits?.dailyRequests}
                    <Badge variant="outline">{t("adv.groups.unlimited")}</Badge>
                  {/if}
                  <Badge variant="outline">{activeKeys} active {activeKeys === 1 ? "key" : "keys"}</Badge>
                  <span class="ml-auto flex items-center gap-1.5">
                    {#if groupEdit.open === group.name}
                      <PressButton variant="ghost" onclick={() => (groupEdit.open = "")} class={groupEdit.busy ? "pointer-events-none opacity-50" : undefined}>{t("f.close")}</PressButton>
                    {:else}
                      <PressButton
                        variant="ghost"
                        onclick={() => openGroupEdit(group.name, groupServiceNames, group.limits)}
                      >{t("common.edit")}</PressButton>
                    {/if}
                    {#if groupRemove.confirm === group.name}
                      <PressButton
                        variant="tonal"
                        class="jx-pair-destructive"
                        loading={groupRemove.busy === group.name}
                        onclick={() => void removeGroup(group.name)}
                      >{t("common.confirmRemove")}</PressButton>
                      <PressButton variant="ghost" onclick={() => (groupRemove.confirm = "")}>{t("common.cancel")}</PressButton>
                    {:else}
                      <PressButton variant="ghost" onclick={() => (groupRemove.confirm = group.name)}>{t("common.remove")}</PressButton>
                    {/if}
                  </span>
                </div>
                <div class="mt-1.5 flex flex-wrap gap-1.5">
                  {#each groupServiceNames as name (name)}
                    <Badge variant="outline">{name}</Badge>
                  {:else}
                    <span class="text-[11px] text-muted-foreground">{t("f.noServices")}</span>
                  {/each}
                </div>
                <!-- 组内 keys（Owner 视觉验收 2026-09-13 #3/#4：keys 归组管理；
                     revoked 不再显示；一行一 key 的 list-item 布局，非内联 chips） -->
                <div class="mt-1.5 flex flex-col gap-1 border-t border-border pt-1.5">
                  <span class="font-nav text-[10px] uppercase tracking-[0.1em] text-muted-foreground">keys</span>
                  {#each app.keys.filter((k) => k.group === group.name && k.revokedAt === undefined) as key (key.keyId)}
                    <div class="flex items-center gap-2 pl-1">
                      <code class="font-mono text-[11px]">{key.keyId.slice(0, 8)}</code>
                      {#if keyRevoke.confirm === key.keyId}
                        <PressButton
                          variant="tonal"
                          class="jx-pair-destructive"
                          loading={keyRevoke.busy === key.keyId}
                          onclick={() => void revokeKey(key.keyId)}
                        >{t("adv.keys.confirmRevoke")}</PressButton>
                        <PressButton variant="ghost" onclick={() => (keyRevoke.confirm = "")}>{t("common.cancel")}</PressButton>
                      {:else}
                        <PressButton variant="ghost" class="h-5 px-1.5 text-[10px]" onclick={() => (keyRevoke.confirm = key.keyId)}>{t("common.remove")}</PressButton>
                      {/if}
                    </div>
                  {:else}
                    <span class="pl-1 text-[11px] text-muted-foreground">no keys</span>
                  {/each}
                  <PressButton
                    variant="ghost"
                    class="h-5 self-start px-1.5 text-[10px]"
                    onclick={() => {
                      keyIssue.group = group.name;
                      void issueKey();
                    }}
                  >+ key</PressButton>
                </div>
                {#if groupEdit.open === group.name}
                  <!-- 行内编辑：名称只读（行头）；成员勾选 + 限额（保存走
                       setServices + setLimits，空限额 = 清除为无限） -->
                  <div class="mt-2 flex flex-col gap-2 border-t border-border pt-2.5" transition:slide={{ duration: 150 }}>
                    <span class="font-nav text-[11px] uppercase tracking-[0.1em] text-muted-foreground">{t("adv.groups.members")}</span>
                    <div class="flex flex-wrap gap-x-5 gap-y-1.5">
                      {#each app.services.map((service) => service.name) as name (name)}
                        <label class="flex items-center gap-1.5 text-xs">
                          <input
                            type="checkbox"
                            class="size-3.5 accent-[var(--primary)]"
                            checked={groupEdit.draft.includes(name)}
                            onchange={(event) => {
                              const target = event.currentTarget;
                              groupEdit.draft = target.checked
                                ? [...groupEdit.draft, name]
                                : groupEdit.draft.filter((item) => item !== name);
                            }}
                          />
                          {name}
                        </label>
                      {:else}
                        <span class="text-[11px] text-muted-foreground">
                          add services first (services tab or the share wizard).
                        </span>
                      {/each}
                    </div>
                    <div class="grid gap-3 sm:grid-cols-2">
                      <Input label={t("f.maxConcurrency")} placeholder="unlimited" bind:value={groupEdit.limitsConcurrency} />
                      <Input label={t("f.dailyRequests")} placeholder="unlimited" bind:value={groupEdit.limitsDaily} />
                    </div>
                    <div class="flex items-center gap-1.5">
                      <PressButton variant="fill" loading={groupEdit.busy} onclick={() => void submitGroupEdit()}>
                        save changes
                      </PressButton>
                    </div>
                    <ErrorAlert error={groupEdit.error} />
                  </div>
                {/if}
              </div>
            {/each}
          </div>
        {/if}
        <ErrorAlert error={groupRemove.error} />

        {#if groupForm.open}
          <Card title="add group" scroll={false}>
            <div class="flex flex-col gap-3 p-3">
              <Input
                label={t("f.groupName")}
                placeholder="friends"
                autocapitalize="none"
                autocorrect="off"
                spellcheck={false}
                bind:value={groupForm.name}
              />
              <div class="flex flex-wrap gap-x-5 gap-y-1.5">
                {#each app.services.map((service) => service.name) as name (name)}
                  <label class="flex items-center gap-1.5 text-xs">
                    <input
                      type="checkbox"
                      class="size-3.5 accent-[var(--primary)]"
                      checked={groupForm.serviceNames.includes(name)}
                      onchange={(event) => {
                        const target = event.currentTarget;
                        groupForm.serviceNames = target.checked
                          ? [...groupForm.serviceNames, name]
                          : groupForm.serviceNames.filter((item) => item !== name);
                      }}
                    />
                    {name}
                  </label>
                {:else}
                  <span class="text-[11px] text-muted-foreground">{t("adv.groups.noServices")}</span>
                {/each}
              </div>
              <div class="grid gap-3 sm:grid-cols-2">
                <Input label={t("f.maxConcurrency")} placeholder="unlimited" bind:value={groupForm.limitsConcurrency} />
                <Input label={t("f.dailyRequests")} placeholder="unlimited" bind:value={groupForm.limitsDaily} />
              </div>
            </div>
            {#snippet foot()}
              <CardFooter label="group form actions">
                <PressButton variant="ghost" onclick={() => (groupForm.open = false)} class={groupForm.busy ? "pointer-events-none opacity-50" : undefined}>{t("common.cancel")}</PressButton>
                <PressButton variant="fill" loading={groupForm.busy} onclick={() => void submitGroupAdd()}>{t("adv.groups.add")}</PressButton>
              </CardFooter>
            {/snippet}
          </Card>
          <ErrorAlert error={groupForm.error} />
        {/if}
      </div>
    </TabsContent>

    <!-- ── 密钥 ─────────────────────────────────────────────── -->
        <!-- ── 密钥库（provider 侧上游密钥，M3 6.1/6.2）─────────── -->
    <TabsContent value="secrets">
      <div class="flex flex-col gap-3">
        <Card title="secrets" scroll={false}>
          <div class="flex flex-col gap-3 p-3">
            <p class="text-xs leading-relaxed text-muted-foreground">
              {t("adv.secrets.hint")}
              <code class="font-mono">&#9679;</code>.
            </p>

            {#if secretsLoading && !secretsLoaded}
              <div class="flex flex-col gap-2">
                <Skeleton class="h-9" />
                <Skeleton class="h-9" />
              </div>
            {:else if secretRows.length === 0}
              <p class="border border-dashed border-border px-3 py-2.5 text-xs leading-relaxed text-muted-foreground">
                {t("f.secrets.empty")}
              </p>
            {:else}
              <div class="flex flex-col gap-1.5">
                {#each secretRows as row (row.name)}
                  <div class="flex flex-wrap items-center gap-2 border border-border/70 px-2.5 py-1.5">
                    <span class="min-w-0 truncate font-mono text-xs">{row.name}</span>
                    <span class="text-[11px] text-muted-foreground">updated {formatDate(row.updatedAt)}</span>
                    <span class="ml-auto flex items-center gap-1.5">
                      <PressButton variant="ghost" onclick={() => editSecretRow(row)}>{t("common.edit")}</PressButton>
                      {#if secretConfirm === row.name}
                        <PressButton
                          variant="tonal"
                          class="jx-pair-destructive"
                          loading={secretRemoving === row.name}
                          onclick={() => void removeSecretRow(row.name)}
                        >{t("common.confirmRemove")}</PressButton>
                        <PressButton variant="ghost" onclick={() => (secretConfirm = null)}>{t("common.cancel")}</PressButton>
                      {:else}
                        <PressButton variant="ghost" onclick={() => (secretConfirm = row.name)}>{t("common.remove")}</PressButton>
                      {/if}
                    </span>
                  </div>
                {/each}
              </div>
            {/if}

            <Separator />

            <div class="flex flex-col gap-3">
              <span class="font-nav text-[11px] uppercase tracking-[0.1em] text-muted-foreground">
                {secretEditing !== null ? `overwrite "${secretEditing}"` : "add a secret"}
              </span>
              <Input
                label={t("f.name")}
                placeholder="openai"
                autocapitalize="none"
                autocorrect="off"
                spellcheck={false}
                error={secretNameError}
                bind:value={secretNameDraft}
              />
              <Input
                type="password"
                label={t("f.value")}
                placeholder="sk-..."
                autocomplete="off"
                bind:value={secretValueDraft}
              />
              <div class="flex flex-col gap-1.5">
                <Toggle
                  label='add "Bearer " prefix'
                  checked={secretBearerPrefix}
                  onchange={(event) => (secretBearerPrefix = event.currentTarget.checked)}
                />
                <p class="text-[11px] leading-relaxed text-muted-foreground">
                  most OpenAI-compatible providers expect it; turn off for raw keys -
                  the value is stored locally and cleared from this form after saving.
                </p>
              </div>
              <div class="flex items-center gap-2">
                <PressButton
                  variant="fill"
                  loading={secretBusy}
                  class={secretFormValid ? undefined : "pointer-events-none opacity-50"}
                  onclick={() => void submitSecret()}
                >
                  {secretEditing !== null ? "overwrite" : "save"}
                </PressButton>
                {#if secretEditing !== null}
                  <PressButton variant="ghost" onclick={resetSecretForm}>{t("common.cancel")}</PressButton>
                {/if}
              </div>
            </div>
          </div>
        </Card>
      </div>
    </TabsContent>

    <!-- ── 中继与限额 ───────────────────────────────────────── -->
    <TabsContent value="hooks">
  <div class="flex flex-col gap-3">
    <div class="flex items-center justify-between">
      <p class="text-xs text-muted-foreground">
        hook scripts: builtin library + ~/.aifly/hooks (user overrides builtin);
        exported function names are the hook inventory (authHeader = HTTP auth header hook).
      </p>
      <PressButton
        variant="outline"
        onclick={() => {
          hookAdd.open = true;
          hookAdd.name = "";
          hookAdd.content = "";
          hookAdd.error = null;
        }}
      >{t("adv.hooks.add")}</PressButton>
    </div>

    {#if hooksPanel.busy && hooksPanel.scripts.length === 0}
      <Skeleton class="h-10" />
    {:else if hooksPanel.scripts.length === 0}
      <Card scroll={false}><p class="p-4 text-xs text-muted-foreground">no hook scripts</p></Card>
    {:else}
      <div class="flex flex-col gap-2">
        {#each hooksPanel.scripts as script (script.name)}
          <div class="flex flex-wrap items-center gap-2 border border-border bg-card px-3 py-2.5 shadow-2xs">
            <span class="font-mono text-xs">{script.name}</span>
            <Badge variant={script.source === "user" ? "tonal" : "outline"}>{script.source}</Badge>
            {#each script.fns as fn (fn)}
              <Badge variant="tonal" class="jx-hue-info">{fn}()</Badge>
            {/each}
            <span class="ml-auto flex items-center gap-1.5">
              <PressButton variant="ghost" onclick={() => void openHookView(script.name)}>{t("common.view")}</PressButton>
              {#if script.source === "user"}
                <PressButton variant="ghost" onclick={() => void removeHookScript(script.name)}>{t("common.remove")}</PressButton>
              {/if}
            </span>
          </div>
        {/each}
      </div>
    {/if}
    <ErrorAlert error={hooksPanel.error} />
  </div>
</TabsContent>

<TabsContent value="relay">
      <div class="flex flex-col gap-3">
        <Card title={t("adv.tab.relay")} scroll={false}>
          <div class="flex flex-col gap-3 p-3">
            <p class="text-xs leading-relaxed text-muted-foreground">
              {t("adv.relay.hint")}
            </p>
            <textarea
              class="min-h-24 border border-border bg-transparent p-2.5 font-mono text-xs focus:border-primary focus:outline-none"
              placeholder="https://relay.example.com"
              spellcheck="false"
              bind:value={relayForm.text}
              disabled={relayForm.busy}
            ></textarea>
            <p class="text-[11px] text-muted-foreground">{t("adv.relay.perLine")}</p>
            {#if relayForm.savedTick > 0}
              <p class="text-[11px] text-primary" transition:slide={{ duration: 150 }}>{t("common.saved")}</p>
            {/if}
          </div>
          {#snippet foot()}
            <CardFooter label="relay form actions">
              <PressButton variant="outline" onclick={() => (relayDialogOpen = true)}>
                {t("adv.relay.choose")}
              </PressButton>
              <PressButton variant="fill" loading={relayForm.busy} onclick={() => void saveRelay()}>
                {t("adv.relay.save")}
              </PressButton>
            </CardFooter>
          {/snippet}
        </Card>
        <ErrorAlert error={relayForm.error} />

        <Card title={t("adv.relay.limitsTitle")} scroll={false}>
          <div class="flex flex-wrap items-center justify-between gap-2 p-3">
            <p class="text-xs text-muted-foreground">
              {t("adv.groups.limitsHint")}
            </p>
            <PressButton variant="ghost" onclick={() => (tab = "groups")}>{t("adv.groups.goGroups")}</PressButton>
          </div>
        </Card>
      </div>
    </TabsContent>

    <!-- ── 设置 ─────────────────────────────────────────────── -->
    <TabsContent value="settings">
      <div class="flex flex-col gap-3">
        <Card title="settings" scroll={false}>
          <div class="flex flex-col gap-4 p-3">
            <div class="flex flex-wrap items-center justify-between gap-2">
              <div>
                <p class="font-nav text-[11px] uppercase tracking-[0.1em]">{t("adv.settings.theme")}</p>
                <p class="text-[11px] text-muted-foreground">
                  light / dark / system - also synced to app settings.
                </p>
              </div>
              <!-- 捕获点击后读 localStorage 同步引擎侧偏好 -->
              <div use:captureClicks>
                <ThemeToggle variant="full" />
              </div>
            </div>
            <Separator />
            <div class="flex flex-wrap items-center justify-between gap-2">
              <div>
                <p class="font-nav text-[11px] uppercase tracking-[0.1em]">{t("adv.settings.modelsDev")}</p>
                <p class="text-[11px] text-muted-foreground">
                  extend the preset list with models.dev providers (fetched once, cached a week).
                  off keeps the list curated-only and works offline.
                </p>
              </div>
              <Toggle
                label={t("f.modelsDevToggle")}
                checked={app.settings?.modelsDevEnabled ?? false}
                disabled={settingsEdit.modelsDevBusy}
                onchange={(event) => void setModelsDev(event.currentTarget.checked)}
              />
            </div>
          </div>
          <ErrorAlert error={settingsEdit.error} />
        </Card>
      </div>
    </TabsContent>
  </Tabs>
</div>

<!-- 密钥一次性原文 dialog（open 由 result 驱动；× / esc 关闭写回 open → 清 result） -->
<Dialog bind:open={keyDialogOpen} title={t("adv.keys.dialogTitle")}>
  {#if keyIssue.result !== null}
    <div class="flex flex-col gap-3 p-4">
      <Alert variant="tonal" class="jx-hue-warning" assertive title={t("adv.keys.dialogWarning")}>
        {t("adv.keys.dialogBody")}
        <code class="font-mono">aifly consumer key add</code>
        {t("adv.keys.dialogCode")}
      </Alert>
      <CopyField value={keyIssue.result.key} label="key" />
      <p class="text-[11px] text-muted-foreground">
        key id <code class="font-mono">{keyIssue.result.keyId}</code>
      </p>
    </div>
    {#snippet footer()}
      <CardFooter label={t("adv.keys.dialogTitle")}>
        <PressButton variant="fill" onclick={() => (keyIssue.result = null)}>{t("adv.keys.done")}</PressButton>
      </CardFooter>
    {/snippet}
  {/if}
</Dialog>

<RelayPickerDialog bind:open={relayDialogOpen} />


<!-- 服务分享（Owner 视觉验收 2026-09-12：服务卡可见分享链接） -->
<Dialog bind:open={serviceShare.open} title="{t('adv.services.share')}: {serviceShare.service}">
  <div class="flex flex-col gap-3 p-4">
    {#if serviceShare.link !== ""}
      <Alert variant="tonal" class="jx-hue-warning" assertive title={t("adv.share.secretWarning")}>
        {t("adv.share.secretBody")}
      </Alert>
      <CopyField value={serviceShare.link} label="aifly1. link" />
      <p class="text-[11px] text-muted-foreground">
        key id <code class="font-mono">{serviceShare.keyId}</code>
      </p>
    {:else}
      {#if serviceShare.groups.length > 1}
        <div class="flex flex-wrap items-center gap-2">
          <span class="font-nav text-[10px] uppercase tracking-[0.1em] text-muted-foreground">{t("f.group")}</span>
          <div class="w-56">
            <Select
              options={serviceShare.groups.map((g) => ({ value: g, label: g }))}
              bind:value={serviceShare.group}
            />
          </div>
        </div>
      {/if}
      <ErrorAlert error={serviceShare.error} />
    {/if}
  </div>
  {#snippet footer()}
    <CardFooter label="service share">
      {#if serviceShare.link !== ""}
        <PressButton variant="fill" onclick={() => (serviceShare.open = false)}>{t("adv.keys.done")}</PressButton>
      {:else}
        <PressButton variant="ghost" onclick={() => (serviceShare.open = false)}>{t("common.cancel")}</PressButton>
        <PressButton
          variant="fill"
          loading={serviceShare.busy}
          class={serviceShare.group === "" ? "pointer-events-none opacity-50" : undefined}
          onclick={() => void submitServiceShare()}
        >{t("adv.services.share")}</PressButton>
      {/if}
    </CardFooter>
  {/snippet}
</Dialog>

<!-- hooks 脚本安装 -->
<Dialog bind:open={hookAdd.open} title={t("adv.hooks.add")}>
  <div class="flex flex-col gap-3 p-4">
    <label class="flex flex-col gap-1">
      <span class="font-nav text-[10px] uppercase tracking-[0.1em] text-muted-foreground">name</span>
      <input
        class="border border-border bg-background px-2 py-1.5 font-mono text-xs"
        placeholder="my-hook"
        bind:value={hookAdd.name}
      />
    </label>
    <label class="flex flex-col gap-1">
      <span class="font-nav text-[10px] uppercase tracking-[0.1em] text-muted-foreground">script (CJS)</span>
      <textarea
        class="min-h-40 border border-border bg-background px-2 py-1.5 font-mono text-xs"
        placeholder={'module.exports.authHeader = ({ homedir, args, secrets }) => {\n  return "Bearer ...";\n};'}
        bind:value={hookAdd.content}
      ></textarea>
    </label>
    <p class="text-[11px] text-muted-foreground">
      installed to ~/.aifly/hooks/&lt;name&gt;.cjs - exported function names become the hook inventory.
    </p>
    <ErrorAlert error={hookAdd.error} />
  </div>
  {#snippet footer()}
    <CardFooter label="hook add">
      <PressButton variant="ghost" onclick={() => (hookAdd.open = false)}>{t("common.cancel")}</PressButton>
      <PressButton variant="fill" loading={hookAdd.busy} onclick={() => void submitHookAdd()}>install</PressButton>
    </CardFooter>
  {/snippet}
</Dialog>

<!-- hooks 脚本查看 -->
<Dialog bind:open={hookView.open} title="hooks: {hookView.name}">
  <div class="flex flex-col gap-2 p-4">
    <p class="text-[11px] text-muted-foreground">
      [{hookView.source}] <code class="font-mono">{hookView.path}</code>
    </p>
    {#if hookView.busy}
      <Skeleton class="h-24" />
    {:else}
      <pre class="max-h-80 overflow-auto border border-border bg-background p-2 font-mono text-[11px]">{hookView.content}</pre>
    {/if}
    <ErrorAlert error={hookView.error} />
  </div>
</Dialog>
