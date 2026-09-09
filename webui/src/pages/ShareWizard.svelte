<!-- 提供方分享向导（B 3.2 + M3 3.2/3.3/6.2/6.3，#/share 三步）：
     ①服务来源（预设卡片网格：图标（models.dev logos，失败回退首字母
     tile）+ 搜索框（label/id/baseUrl 过滤精选与长尾）/ 本地运行时排前 /
     featured 徽标 / models.dev 长尾折叠区 + 断网提示 + 自定义 URL 卡）→
     ②命名与分组（服务名/分组（可新建，提示已有组）/default consumer
     port/密钥选择器 + manage secrets 面板/连通测试；限额收进默认折叠的
     advanced options）→ ③生成分享（链接 + 一键复制 + 链接即凭证警示 +
     TTL + 密钥已存本机密钥面板提示）。状态机在 stores/share-wizard。 -->
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
  import { slide } from "svelte/transition";
  import StepHeader from "../components/StepHeader.svelte";
  import ErrorAlert from "../components/ErrorAlert.svelte";
  import CopyField from "../components/CopyField.svelte";
  import SecretPicker from "../components/SecretPicker.svelte";
  import TestConnection from "../components/TestConnection.svelte";
  import {
    app,
    loadPresets,
    presets,
    isLocalPreset,
    refresh,
  } from "../stores/app.svelte.ts";
  import {
    share,
    resetShare,
    choosePreset,
    chooseCustom,
    shareBack,
    customSourceValid,
    namingNext,
    generateShare,
    hostFromUrl,
    TTL_OPTIONS,
  } from "../stores/share-wizard.svelte.ts";
  import { presetLogoUrl, type Preset } from "$shared/rpc-contract.ts";

  onMount(() => {
    // 首次进入拉预设；重新进入（reset 后）复用已拉取的清单
    if (presets.curated.length === 0 && !presets.loading) void loadPresets();
    refresh("groups"); // ② 的分组提示需要既有组
  });

  /** 预设卡片排序：本地运行时（ollama/LM Studio）排前，其余按 label。 */
  const orderedCurated = $derived(
    [...presets.curated].sort((a, b) => {
      const localDiff = Number(isLocalPreset(b)) - Number(isLocalPreset(a));
      return localDiff !== 0 ? localDiff : a.label.localeCompare(b.label);
    }),
  );
  /** 长尾展开（默认收起——20/80 法则：精选直达，长尾按需）。 */
  let showLongTail = $state(false);

  /** ① 搜索（label/id/baseUrl 不区分大小写过滤精选+长尾；空串 = 全部）。 */
  let search = $state("");

  function matchesQuery(preset: Preset): boolean {
    const query = search.trim().toLowerCase();
    if (query === "") return true;
    return (
      preset.label.toLowerCase().includes(query) ||
      preset.id.toLowerCase().includes(query) ||
      preset.baseUrl.toLowerCase().includes(query)
    );
  }

  const visibleCurated = $derived(orderedCurated.filter(matchesQuery));
  const visibleLongTail = $derived(presets.modelsDev.filter(matchesQuery));
  /** 搜索时长尾自动展开（命中不应藏在折叠区后面）。 */
  const longTailOpen = $derived(showLongTail || search.trim() !== "");

  /** 预设图标加载失败集合（onerror 回退首字母 tile）。 */
  let failedLogos = $state(new Set<string>());

  function markLogoFailed(presetId: string): void {
    failedLogos = new Set([...failedLogos, presetId]);
  }

  /** ② 限额默认折叠（advanced options）。 */
  let showAdvanced = $state(false);

  const groupOptions = $derived([
    { value: "__new__", label: "new group..." },
    ...app.groups.map((group) => ({ value: group.name, label: group.name })),
  ]);

  // Select 只支持 bind:value（无 onchange prop）：本地 $state + 受保护双向 effect 桥接
  let groupSel = $state(share.groupNew ? "__new__" : share.groupName);
  $effect(() => {
    const v = share.groupNew ? "__new__" : share.groupName;
    if (v !== groupSel) groupSel = v;
  });
  $effect(() => {
    if (groupSel === "__new__") {
      if (!share.groupNew) share.groupNew = true;
    } else if (share.groupNew || share.groupName !== groupSel) {
      share.groupNew = false;
      share.groupName = groupSel;
    }
  });

  let ttlSel = $state(String(share.ttlMs));
  $effect(() => {
    if (String(share.ttlMs) !== ttlSel) ttlSel = String(share.ttlMs);
  });
  $effect(() => {
    const found = TTL_OPTIONS.find((option) => String(option.ttlMs) === ttlSel);
    if (found !== undefined && found.ttlMs !== share.ttlMs) share.ttlMs = found.ttlMs;
  });

  /** 当前选中预设对象（②/③ 的提示用；含 models.dev 长尾——连通测试需要 baseUrl/apiForm）。 */
  const selectedPreset = $derived(
    share.mode === "preset"
      ? presets.curated.find((p) => p.id === share.presetId) ??
          presets.modelsDev.find((p) => p.id === share.presetId) ??
          null
      : null,
  );

  function presetCard(preset: Preset): void {
    choosePreset(preset);
  }
</script>

{#snippet presetIcon(preset: Preset)}
  <!-- models.dev logo（iconId 缺省取 id）；加载失败回退首字母 tile -->
  {#if failedLogos.has(preset.id)}
    <span
      class="flex size-5 flex-none items-center justify-center bg-muted font-mono text-[11px] text-muted-foreground"
      aria-hidden="true"
    >{preset.label[0]?.toUpperCase()}</span>
  {:else}
    <img
      src={presetLogoUrl(preset)}
      alt=""
      loading="lazy"
      class="size-5 flex-none"
      onerror={() => markLogoFailed(preset.id)}
    />
  {/if}
{/snippet}

<div class="mx-auto flex max-w-3xl flex-col gap-4 p-4 md:p-6">
  <header class="flex flex-col gap-2">
    <h1 class="font-nav text-base uppercase tracking-[0.1em]">Share a service</h1>
    <StepHeader
      step={share.step}
      locked={share.result !== null}
      titles={["source", "name & group", "share link"]}
    />
  </header>

  <!-- ① 服务来源 -->
  {#if share.step === 1}
    <!-- 步骤标题下的搜索框（label/id/baseUrl 过滤精选+长尾；空串 = 全部） -->
    <Input type="search" placeholder="search providers..." bind:value={search} />
    {#if presets.loading}
      <div class="grid gap-3 sm:grid-cols-2">
        {#each Array.from({ length: 4 }) as _, i (i)}
          <Skeleton class="h-28" />
        {/each}
      </div>
    {:else if presets.error !== null}
      <Alert variant="tonal" class="jx-hue-error" assertive title="Failed to load presets">
        {presets.error}
      </Alert>
    {:else}
      <div class="grid gap-3 sm:grid-cols-2" transition:slide={{ duration: 180 }}>
        {#each visibleCurated as preset (preset.id)}
          <button
            type="button"
            class="flex min-h-24 flex-col gap-1.5 border border-border bg-card p-3.5 text-left shadow-2xs transition-colors hover:border-primary/50"
            onclick={() => presetCard(preset)}
          >
            <span class="flex flex-wrap items-center gap-1.5">
              {@render presetIcon(preset)}
              <span class="font-nav text-xs uppercase tracking-[0.1em]">{preset.label}</span>
              {#if isLocalPreset(preset)}
                <Badge variant="tonal" class="jx-hue-success">local</Badge>
              {/if}
              <Badge variant="outline">featured</Badge>
            </span>
            <span class="font-mono text-[11px] text-muted-foreground">{preset.baseUrl}</span>
            <span class="mt-auto flex items-center gap-2 text-[11px] text-muted-foreground">
              port {preset.defaultPort}
            </span>
          </button>
        {/each}

        <!-- 自定义 URL 卡 -->
        <button
          type="button"
          class="flex min-h-24 flex-col gap-1.5 border border-dashed border-border bg-card/50 p-3.5 text-left transition-colors hover:border-primary/50"
          onclick={chooseCustom}
        >
          <span class="font-nav text-xs uppercase tracking-[0.1em]">custom URL</span>
          <span class="text-[11px] leading-relaxed text-muted-foreground">
            any HTTP endpoint you own - you fill in the upstream, match domain and port next.
          </span>
        </button>
      </div>
      {#if search.trim() !== "" && visibleCurated.length === 0 && visibleLongTail.length === 0}
        <p class="text-[11px] text-muted-foreground">
          no providers match "{search.trim()}" - the custom URL card still lets you share any endpoint.
        </p>
      {/if}

      <!-- models.dev 长尾区（断网/禁用：扩展不可用状态；搜索时自动展开） -->
      <Separator />
      <div class="flex flex-col gap-2">
        <div class="flex items-center gap-2">
          <span class="font-nav text-[11px] uppercase tracking-[0.1em] text-muted-foreground">
            long tail ({visibleLongTail.length})
          </span>
          {#if presets.modelsDevError}
            <Badge variant="tonal" class="jx-hue-warning">expansion unavailable</Badge>
          {/if}
          {#if presets.modelsDev.length > 0}
            <button
              type="button"
              class="text-[11px] text-primary underline-offset-2 hover:underline"
              onclick={() => (showLongTail = !longTailOpen)}
            >
              {longTailOpen ? "hide" : "show"}
            </button>
          {/if}
        </div>
        {#if presets.modelsDevError}
          <p class="text-[11px] text-muted-foreground">{presets.modelsDevError}</p>
        {/if}
        {#if longTailOpen}
          <div class="grid gap-3 sm:grid-cols-2" transition:slide={{ duration: 150 }}>
            {#each visibleLongTail as preset (preset.id)}
              <button
                type="button"
                class="flex flex-col gap-1 border border-border/70 bg-card p-3 text-left transition-colors hover:border-primary/50"
                onclick={() => presetCard(preset)}
              >
                <span class="flex flex-wrap items-center gap-1.5">
                  {@render presetIcon(preset)}
                  <span class="font-nav text-xs uppercase tracking-[0.1em]">{preset.label}</span>
                  <Badge variant="outline">models.dev</Badge>
                  {#if preset.unverified}
                    <Badge variant="tonal" class="jx-hue-warning">unverified</Badge>
                  {/if}
                </span>
                <span class="font-mono text-[11px] text-muted-foreground">{preset.baseUrl}</span>
              </button>
            {/each}
          </div>
        {/if}
      </div>
    {/if}

  <!-- ② 命名与分组（预设与自定义共用；自定义补 upstream/match） -->
  {:else if share.step === 2}
    <Card title="name & group" scroll={false}>
      <div class="flex flex-col gap-3 p-3">
        {#if share.mode === "custom"}
          <Input label="upstream URL" placeholder="https://api.example.com/v1" bind:value={share.customUpstream} />
          <Input
            label="match domain"
            placeholder="api.example.com"
            bind:value={share.customMatch}
            error={share.customMatch.trim() === "" ? "match domain is required" : undefined}
          />
          <p class="text-[11px] text-muted-foreground">
            requests whose host matches this domain are captured. defaults to the upstream host.
            <button
              type="button"
              class="ml-1 text-primary underline-offset-2 hover:underline"
              onclick={() => {
                const host = hostFromUrl(share.customUpstream);
                if (host !== "") share.customMatch = host;
              }}
            >use host</button>
          </p>
          <Separator />
        {/if}

        <Input
          label="service name"
          placeholder={share.mode === "preset" ? share.name : "my-service"}
          bind:value={share.name}
        />

        <div class="grid gap-3 sm:grid-cols-2">
          <!-- Select 只支持 bind:value（无 onchange prop）：groupSel/ttlSel 为 derived get/set 桥接 -->
          <Select label="group" options={groupOptions} bind:value={groupSel} />
          <Input
            label={share.groupNew ? "new group name" : "selected group"}
            placeholder="friends"
            disabled={!share.groupNew}
            bind:value={share.groupName}
          />
        </div>
        {#if !share.groupNew}
          <p class="text-[11px] text-muted-foreground">
            the service will be added to the existing group (limits stay as created -
            <a class="text-primary underline-offset-2 hover:underline" href="#/advanced">edit in Advanced</a>).
          </p>
        {/if}

        <div class="flex flex-col gap-1.5">
          <Input label="default consumer port" bind:value={share.port} />
          <p class="text-[11px] leading-relaxed text-muted-foreground">
            the local port friends will use on their machines - they can change it later.
          </p>
        </div>

        <!-- 限额收进默认折叠的 advanced options（20/80：核心字段直达） -->
        <PressButton
          variant="ghost"
          class="self-start"
          onclick={() => (showAdvanced = !showAdvanced)}
        >
          advanced options
          <span class="font-mono text-[10px] text-muted-foreground" aria-hidden="true">
            {#if showAdvanced}&#9662;{:else}&#9656;{/if}
          </span>
        </PressButton>
        {#if showAdvanced}
          <div class="flex flex-col gap-2" transition:slide={{ duration: 150 }}>
            <div class="grid gap-3 sm:grid-cols-2">
              <Input label="max concurrency (optional)" placeholder="unlimited" bind:value={share.limitsConcurrency} />
              <Input label="daily requests (optional)" placeholder="unlimited" bind:value={share.limitsDaily} />
            </div>
            <p class="text-[11px] text-muted-foreground">empty limits = unlimited.</p>
          </div>
        {/if}

        <!-- 密钥选择器（本地运行时/自定义也显示：可选不选）+ 连通测试 -->
        <SecretPicker value={share.secretName} onchange={(name) => (share.secretName = name)} />

        <TestConnection
          upstream={share.mode === "custom" ? share.customUpstream.trim() : selectedPreset?.baseUrl ?? ""}
          apiForm={selectedPreset?.apiForm}
          secretName={share.secretName}
          presetId={share.mode === "preset" ? share.presetId : undefined}
        />
      </div>
      {#snippet foot()}
        <CardFooter label="share wizard actions">
          <PressButton variant="ghost" onclick={shareBack} class={share.busy !== "" ? "pointer-events-none opacity-50" : undefined}>back</PressButton>
          <PressButton
            variant="fill"
            onclick={() => {
              if (share.mode === "custom" && !customSourceValid()) {
                share.error = { code: "INVALID_INPUT", message: "name, https upstream and match domain are required" };
                return;
              }
              namingNext();
            }}
          >
            continue
          </PressButton>
        </CardFooter>
      {/snippet}
    </Card>
    <ErrorAlert error={share.error} />

  <!-- ③ 生成分享 -->
  {:else}
    {#if share.result === null}
      <Card title="generate the share link" scroll={false}>
        <div class="flex flex-col gap-3 p-3">
          <dl class="grid grid-cols-2 gap-x-4 gap-y-1.5 text-xs">
            <div class="flex justify-between gap-2 border-b border-border/60 pb-1">
              <dt class="text-muted-foreground">service</dt>
              <dd class="font-mono">{share.name}</dd>
            </div>
            <div class="flex justify-between gap-2 border-b border-border/60 pb-1">
              <dt class="text-muted-foreground">group</dt>
              <dd class="font-mono">{share.groupName}</dd>
            </div>
            <div class="flex justify-between gap-2 border-b border-border/60 pb-1">
              <dt class="text-muted-foreground">source</dt>
              <dd class="font-mono">{share.mode === "preset" ? share.presetId : "custom"}</dd>
            </div>
            <div class="flex justify-between gap-2 border-b border-border/60 pb-1">
              <dt class="text-muted-foreground">port</dt>
              <dd class="font-mono">{share.port}</dd>
            </div>
          </dl>
          {#if share.secretName !== undefined}
            <p class="text-[11px] leading-relaxed text-muted-foreground">
              the api key is stored in this machine's secret panel
              (<code class="font-mono">{share.secretName}</code>) - consumers only ever see
              <code class="font-mono">&#9679;</code>.
            </p>
          {/if}
          <div class="max-w-56">
            <Select
              label="link TTL"
              options={TTL_OPTIONS.map((option) => ({ value: String(option.ttlMs), label: option.label }))}
              bind:value={ttlSel}
            />
          </div>
          <Alert variant="tonal" title="the link itself is the credential">
            anyone holding this link can use the service until it expires. share it over a
            channel you trust, and revoke keys in Advanced when done.
          </Alert>
        </div>
        {#snippet foot()}
          <CardFooter label="share wizard actions">
            <PressButton variant="ghost" onclick={shareBack} class={share.busy !== "" ? "pointer-events-none opacity-50" : undefined}>back</PressButton>
            <PressButton
              variant="fill"
              loading={share.busy !== ""}
              onclick={() => void generateShare()}
            >
              {share.busy === "service" || share.busy === "group"
                ? "creating service..."
                : share.busy === "daemon"
                  ? "starting daemon..."
                  : share.busy === "share"
                    ? "creating link..."
                    : "generate share link"}
            </PressButton>
          </CardFooter>
        {/snippet}
      </Card>
      <ErrorAlert error={share.error} />
    {:else}
      <Card title="share link created" scroll={false}>
        <div class="flex flex-col gap-3 p-3" transition:slide={{ duration: 180 }}>
          <CopyField value={share.result.link} label="aifly1." />
          <p class="text-[11px] text-muted-foreground">
            key id <code class="font-mono">{share.result.keyId}</code> - one key was issued for
            the <code class="font-mono">{share.groupName}</code> group and embedded in the link.
          </p>
          {#each share.result.warnings as warning (warning)}
            <Alert variant="tonal" class="jx-hue-warning" title="warning">{warning}</Alert>
          {/each}
          <Alert variant="tonal" title="the link itself is the credential">
            it expires after the chosen TTL. anyone holding it can use the service until then.
          </Alert>
        </div>
        {#snippet foot()}
          <CardFooter label="share wizard actions">
            <PressButton
              variant="ghost"
              onclick={() => {
                resetShare();
                void loadPresets();
              }}
            >
              share another
            </PressButton>
            <PressButton variant="fill" href="#/dashboard" external={false}>go to dashboard</PressButton>
          </CardFooter>
        {/snippet}
      </Card>
    {/if}
  {/if}
</div>
