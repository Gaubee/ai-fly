<!-- 高级设置（B 3.5，#/advanced）：Tabs = 服务 / 分组 / 密钥 / 中继与限额 /
     设置。net-fly 通用概念（match 全集、rewrite 规则、relay 配置）只出现在
     这里；默认一行一服务，展开 detail（$env 头值显示 ●）。密钥 issue 一次性
     原文 dialog + revoke 两步确认。状态机在 stores/advanced。 -->
<script lang="ts">
  import { onMount } from "svelte";
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
  import Dialog, { DialogFooter } from "$lib/ui/dialog";
  import { slide } from "svelte/transition";
  import ErrorAlert from "../components/ErrorAlert.svelte";
  import CopyField from "../components/CopyField.svelte";
  import { app, refresh } from "../stores/app.svelte.ts";
  import { call } from "../stores/rpc.svelte.ts";
  import {
    maskSecret,
    serviceForm,
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
    <h1 class="font-nav text-base uppercase tracking-[0.1em]">Advanced</h1>
    <p class="text-xs text-muted-foreground">
      net-fly internals - match sets, rewrite rules, keys, relay
    </p>
  </header>

  <Tabs bind:value={tab}>
    <TabsList>
      <TabsTrigger value="services">services</TabsTrigger>
      <TabsTrigger value="groups">groups</TabsTrigger>
      <TabsTrigger value="keys">keys</TabsTrigger>
      <TabsTrigger value="relay">relay & limits</TabsTrigger>
      <TabsTrigger value="settings">settings</TabsTrigger>
    </TabsList>

    <!-- ── 服务 ─────────────────────────────────────────────── -->
    <TabsContent value="services">
      <div class="flex flex-col gap-3">
        <div class="flex items-center justify-between">
          <p class="text-xs text-muted-foreground">
            default rows show name + port; expand for upstream, full match set and rewrite rules.
          </p>
          <PressButton variant="outline" onclick={openServiceAdd}>add service</PressButton>
        </div>

        {#if app.busy.services && app.services.length === 0}
          <div class="flex flex-col gap-2">
            <Skeleton class="h-10" />
            <Skeleton class="h-10" />
          </div>
        {:else if app.services.length === 0}
          <Card scroll={false}>
            <p class="p-4 text-xs text-muted-foreground">
              no services yet - add one here or use the share wizard.
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
                    {#if service.rewrite?.headerSet?.["authorization"]?.startsWith("$env:")}
                      <Badge variant="tonal" class="jx-hue-info">key injected</Badge>
                    {/if}
                  </button>
                  <span class="flex items-center gap-1.5">
                    <PressButton variant="ghost" onclick={() => openServiceEdit(service)}>edit</PressButton>
                    {#if serviceRemove.confirm === service.name}
                      <PressButton
                        variant="tonal"
                        class="jx-pair-destructive"
                        loading={serviceRemove.busy === service.name}
                        onclick={() => void removeService(service.name)}
                      >confirm remove</PressButton>
                      <PressButton variant="ghost" onclick={() => (serviceRemove.confirm = "")}>cancel</PressButton>
                    {:else}
                      <PressButton
                        variant="ghost"
                        onclick={() => (serviceRemove.confirm = service.name)}
                      >remove</PressButton>
                    {/if}
                  </span>
                </div>
                {#if open}
                  <!-- detail 展开：upstream / match 全集 / rewrite（$env 值显示 ●） -->
                  <dl class="grid gap-x-6 gap-y-1.5 border-t border-border px-3 py-2.5 text-xs" transition:slide={{ duration: 150 }}>
                    <div class="flex gap-2">
                      <dt class="w-20 flex-none text-muted-foreground">upstream</dt>
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
                        <dt class="w-20 flex-none text-muted-foreground">rewrite</dt>
                        <dd class="flex min-w-0 flex-col gap-0.5 font-mono">
                          {#if service.rewrite.hostHeader}<span>host: {service.rewrite.hostHeader}</span>{/if}
                          {#if service.rewrite.pathPrefixStrip}<span>strip: {service.rewrite.pathPrefixStrip}</span>{/if}
                          {#if service.rewrite.pathPrefixAppend}<span>append: {service.rewrite.pathPrefixAppend}</span>{/if}
                          {#each Object.entries(service.rewrite.headerSet ?? {}) as [name, value] (`${service.serviceId}:${name}`)}
                            <span>header {name}: {maskSecret(value)}</span>
                          {/each}
                          {#each service.rewrite.headerRemove ?? [] as name (`${service.serviceId}:rm:${name}`)}
                            <span>remove header {name}</span>
                          {/each}
                          {#if !service.rewrite.hostHeader && !service.rewrite.pathPrefixStrip && !service.rewrite.pathPrefixAppend && Object.keys(service.rewrite.headerSet ?? {}).length === 0 && (service.rewrite.headerRemove ?? []).length === 0}
                            <span class="text-muted-foreground">no rewrite rules</span>
                          {/if}
                        </dd>
                      </div>
                    {:else}
                      <div class="flex gap-2">
                        <dt class="w-20 flex-none text-muted-foreground">rewrite</dt>
                        <dd class="font-mono text-muted-foreground">none</dd>
                      </div>
                    {/if}
                    <div class="flex gap-2">
                      <dt class="w-20 flex-none text-muted-foreground">id</dt>
                      <dd class="min-w-0 break-all font-mono text-muted-foreground">{service.serviceId}</dd>
                    </div>
                  </dl>
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
                <Input label="name" bind:value={serviceForm.name} />
                <Input label="port" placeholder="default 8080" bind:value={serviceForm.port} />
              </div>
              <Input label="upstream URL" placeholder="https://api.example.com/v1" bind:value={serviceForm.upstream} />
              <div class="flex flex-col gap-1.5">
                <span class="font-nav text-[11px] uppercase tracking-[0.1em] text-muted-foreground">match rules</span>
                {#each serviceForm.match as rule, i (i)}
                  <div class="flex items-center gap-2">
                    <div class="w-28">
                      <Select
                        options={[
                          { value: "suffix", label: "suffix" },
                          { value: "exact", label: "exact" },
                          { value: "regex", label: "regex" },
                        ]}
                        value={rule.type}
                        onchange={(value) => (serviceForm.match[i]!.type = value)}
                      />
                    </div>
                    <input
                      class="min-w-0 flex-1 border border-border bg-transparent px-2.5 py-1.5 font-mono text-xs focus:border-primary focus:outline-none"
                      placeholder="api.example.com"
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
              <Input
                label="$env variable name (optional authorization injection)"
                placeholder="MY_API_KEY"
                bind:value={serviceForm.keyEnv}
              />
              {#if serviceForm.editingName !== ""}
                <p class="text-[11px] text-muted-foreground">
                  editing re-creates the service (remove + add) - group membership is preserved by name.
                </p>
              {/if}
            </div>
            {#snippet foot()}
              <CardFooter label="service form actions">
                <PressButton variant="ghost" onclick={closeServiceForm} class={serviceForm.busy ? "pointer-events-none opacity-50" : undefined}>cancel</PressButton>
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

    <!-- ── 分组与限额 ───────────────────────────────────────── -->
    <TabsContent value="groups">
      <div class="flex flex-col gap-3">
        <div class="flex items-center justify-between">
          <p class="text-xs text-muted-foreground">
            limits are set when the group is created; members can be replaced any time.
          </p>
          <PressButton variant="outline" onclick={openGroupAdd}>add group</PressButton>
        </div>

        {#if app.groups.length === 0 && !app.busy.groups}
          <Card scroll={false}>
            <p class="p-4 text-xs text-muted-foreground">no groups yet.</p>
          </Card>
        {:else}
          <div class="flex flex-col gap-2">
            {#each app.groups as group (group.name)}
              {@const groupServiceNames = group.serviceIds.map((id) => serviceNamesById.get(id) ?? id)}
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
                    <Badge variant="outline">unlimited</Badge>
                  {/if}
                  <span class="ml-auto flex items-center gap-1.5">
                    {#if groupEdit.open === group.name}
                      <PressButton variant="ghost" onclick={() => (groupEdit.open = "")} class={groupEdit.busy ? "pointer-events-none opacity-50" : undefined}>close</PressButton>
                    {:else}
                      <PressButton
                        variant="ghost"
                        onclick={() => openGroupEdit(group.name, groupServiceNames)}
                      >members</PressButton>
                    {/if}
                  </span>
                </div>
                <div class="mt-1.5 flex flex-wrap gap-1.5">
                  {#each groupServiceNames as name (name)}
                    <Badge variant="outline">{name}</Badge>
                  {:else}
                    <span class="text-[11px] text-muted-foreground">no services</span>
                  {/each}
                </div>
                {#if groupEdit.open === group.name}
                  <div class="mt-2 flex flex-col gap-2 border-t border-border pt-2.5" transition:slide={{ duration: 150 }}>
                    <span class="font-nav text-[11px] uppercase tracking-[0.1em] text-muted-foreground">members</span>
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
                    <div class="flex items-center gap-1.5">
                      <PressButton variant="fill" loading={groupEdit.busy} onclick={() => void submitGroupEdit()}>
                        save members
                      </PressButton>
                    </div>
                    <ErrorAlert error={groupEdit.error} />
                  </div>
                {/if}
              </div>
            {/each}
          </div>
        {/if}

        {#if groupForm.open}
          <Card title="add group" scroll={false}>
            <div class="flex flex-col gap-3 p-3">
              <Input label="group name" placeholder="friends" bind:value={groupForm.name} />
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
                  <span class="text-[11px] text-muted-foreground">no services to add yet.</span>
                {/each}
              </div>
              <div class="grid gap-3 sm:grid-cols-2">
                <Input label="max concurrency (optional)" placeholder="unlimited" bind:value={groupForm.limitsConcurrency} />
                <Input label="daily requests (optional)" placeholder="unlimited" bind:value={groupForm.limitsDaily} />
              </div>
            </div>
            {#snippet foot()}
              <CardFooter label="group form actions">
                <PressButton variant="ghost" onclick={() => (groupForm.open = false)} class={groupForm.busy ? "pointer-events-none opacity-50" : undefined}>cancel</PressButton>
                <PressButton variant="fill" loading={groupForm.busy} onclick={() => void submitGroupAdd()}>add group</PressButton>
              </CardFooter>
            {/snippet}
          </Card>
          <ErrorAlert error={groupForm.error} />
        {/if}
      </div>
    </TabsContent>

    <!-- ── 密钥 ─────────────────────────────────────────────── -->
    <TabsContent value="keys">
      <div class="flex flex-col gap-3">
        <Card title="issue a key" scroll={false}>
          <div class="flex flex-wrap items-end gap-3 p-3">
            <div class="w-56">
              <Select
                label="group"
                options={keyGroupOptions}
                placeholder="pick a group"
                bind:value={keyIssue.group}
              />
            </div>
            <PressButton
              variant="fill"
              loading={keyIssue.busy}
              class={keyIssue.group === "" ? "pointer-events-none opacity-50" : undefined}
              onclick={() => void issueKey()}
            >
              issue key
            </PressButton>
          </div>
          <ErrorAlert error={keyIssue.error} />
        </Card>

        {#if app.keys.length === 0 && !app.busy.keys}
          <Card scroll={false}>
            <p class="p-4 text-xs text-muted-foreground">no keys yet.</p>
          </Card>
        {:else}
          <table class="w-full border border-border bg-card text-xs shadow-2xs">
            <thead>
              <tr class="border-b border-border text-left font-nav text-[10px] uppercase tracking-[0.1em] text-muted-foreground">
                <th class="px-3 py-2 font-normal">key</th>
                <th class="px-3 py-2 font-normal">group</th>
                <th class="px-3 py-2 font-normal">created</th>
                <th class="px-3 py-2 font-normal">status</th>
                <th class="px-3 py-2 font-normal"></th>
              </tr>
            </thead>
            <tbody>
              {#each app.keys as key (key.keyId)}
                <tr class="border-b border-border/50" transition:slide={{ duration: 150 }}>
                  <td class="px-3 py-1.5 font-mono text-muted-foreground">{key.keyId.slice(0, 12)}</td>
                  <td class="px-3 py-1.5 font-mono">{key.group}</td>
                  <td class="px-3 py-1.5 text-muted-foreground">{formatDate(key.createdAt)}</td>
                  <td class="px-3 py-1.5">
                    {#if key.revokedAt !== undefined}
                      <Badge variant="tonal" class="jx-hue-error">revoked</Badge>
                    {:else}
                      <Badge variant="tonal" class="jx-hue-success">active</Badge>
                    {/if}
                  </td>
                  <td class="px-3 py-1.5 text-right">
                    {#if key.revokedAt === undefined}
                      {#if keyRevoke.confirm === key.keyId}
                        <span class="inline-flex items-center gap-1.5">
                          <PressButton
                            variant="tonal"
                            class="jx-pair-destructive"
                            loading={keyRevoke.busy === key.keyId}
                            onclick={() => void revokeKey(key.keyId)}
                          >confirm revoke</PressButton>
                          <PressButton variant="ghost" onclick={() => (keyRevoke.confirm = "")}>cancel</PressButton>
                        </span>
                      {:else}
                        <PressButton variant="ghost" onclick={() => (keyRevoke.confirm = key.keyId)}>revoke</PressButton>
                      {/if}
                    {/if}
                  </td>
                </tr>
              {/each}
            </tbody>
          </table>
        {/if}
        <ErrorAlert error={keyRevoke.error} />
      </div>
    </TabsContent>

    <!-- ── 中继与限额 ───────────────────────────────────────── -->
    <TabsContent value="relay">
      <div class="flex flex-col gap-3">
        <Card title="relay entries" scroll={false}>
          <div class="flex flex-col gap-3 p-3">
            <p class="text-xs leading-relaxed text-muted-foreground">
              relay entries are the stable meeting points both sides dial when a direct
              connection is not possible (different networks, NAT). keep at least one
              long-lived address here - every share link embeds it, and imported links may
              bring their own. leave empty to use the SDK default.
            </p>
            <textarea
              class="min-h-24 border border-border bg-transparent p-2.5 font-mono text-xs focus:border-primary focus:outline-none"
              placeholder="wss://relay.example.com"
              spellcheck="false"
              bind:value={relayForm.text}
              disabled={relayForm.busy}
            ></textarea>
            <p class="text-[11px] text-muted-foreground">one wss:// URL per line, at most 8.</p>
            {#if relayForm.savedTick > 0}
              <p class="text-[11px] text-primary" transition:slide={{ duration: 150 }}>saved.</p>
            {/if}
          </div>
          {#snippet foot()}
            <CardFooter label="relay form actions">
              <PressButton variant="fill" loading={relayForm.busy} onclick={() => void saveRelay()}>
                save relay entries
              </PressButton>
            </CardFooter>
          {/snippet}
        </Card>
        <ErrorAlert error={relayForm.error} />

        <Card title="limits" scroll={false}>
          <div class="flex flex-wrap items-center justify-between gap-2 p-3">
            <p class="text-xs text-muted-foreground">
              per-group limits (concurrency, daily requests) are managed with each group.
            </p>
            <PressButton variant="ghost" onclick={() => (tab = "groups")}>go to groups</PressButton>
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
                <p class="font-nav text-[11px] uppercase tracking-[0.1em]">theme</p>
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
                <p class="font-nav text-[11px] uppercase tracking-[0.1em]">models.dev expansion</p>
                <p class="text-[11px] text-muted-foreground">
                  extend the preset list with models.dev providers (fetched once, cached a week).
                  off keeps the list curated-only and works offline.
                </p>
              </div>
              <Toggle
                label="models.dev expansion"
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
<Dialog bind:open={keyDialogOpen} title="key issued">
  {#if keyIssue.result !== null}
    <div class="flex flex-col gap-3 p-4">
      <Alert variant="tonal" class="jx-hue-warning" assertive title="shown once - copy it now">
        the raw key is never shown again (only its hash is stored). paste it into
        <code class="font-mono">aifly consumer key add</code> on the friend's machine, or share
        the group link which carries it.
      </Alert>
      <CopyField value={keyIssue.result.key} label="key" />
      <p class="text-[11px] text-muted-foreground">
        key id <code class="font-mono">{keyIssue.result.keyId}</code>
      </p>
    </div>
    {#snippet footer()}
      <DialogFooter label="key issued">
        <PressButton variant="fill" onclick={() => (keyIssue.result = null)}>done - I saved it</PressButton>
      </DialogFooter>
    {/snippet}
  {/if}
</Dialog>
