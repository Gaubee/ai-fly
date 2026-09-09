<!-- 提供方分享向导（B 3.2，#/share 三步）：
     ①服务来源（预设卡片网格：本地运行时排前 / featured 徽标 / models.dev
     长尾折叠区 + 断网提示 + 自定义 URL 卡）→ ②命名与分组（服务名/分组
     （可新建，提示已有组）/可选限额/$env 变量名）→ ③生成分享（链接 +
     一键复制 + 链接即凭证警示 + TTL）。状态机在 stores/share-wizard。 -->
<script lang="ts">
  import { onMount } from "svelte";
  import Card from "$lib/ui/card";
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
  import type { Preset } from "$shared/rpc-contract.ts";

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

  const groupOptions = $derived([
    { value: "__new__", label: "new group..." },
    ...app.groups.map((group) => ({ value: group.name, label: group.name })),
  ]);

  /** 当前选中预设对象（②/③ 的提示用）。 */
  const selectedPreset = $derived(
    share.mode === "preset" ? presets.curated.find((p) => p.id === share.presetId) ?? null : null,
  );

  function presetCard(preset: Preset): void {
    choosePreset(preset);
  }
</script>

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
        {#each orderedCurated as preset (preset.id)}
          <button
            type="button"
            class="flex min-h-24 flex-col gap-1.5 border border-border bg-card p-3.5 text-left shadow-2xs transition-colors hover:border-primary/50"
            onclick={() => presetCard(preset)}
          >
            <span class="flex flex-wrap items-center gap-1.5">
              <span class="font-nav text-xs uppercase tracking-[0.1em]">{preset.label}</span>
              {#if isLocalPreset(preset)}
                <Badge variant="tonal" class="jx-hue-success">local</Badge>
              {/if}
              <Badge variant="outline">featured</Badge>
            </span>
            <span class="font-mono text-[11px] text-muted-foreground">{preset.baseUrl}</span>
            <span class="mt-auto flex items-center gap-2 text-[11px] text-muted-foreground">
              port {preset.defaultPort}
              {#if preset.keyEnv}
                <span>- key env {preset.keyEnv}</span>
              {/if}
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

      <!-- models.dev 长尾区（断网/禁用：扩展不可用状态） -->
      <Separator />
      <div class="flex flex-col gap-2">
        <div class="flex items-center gap-2">
          <span class="font-nav text-[11px] uppercase tracking-[0.1em] text-muted-foreground">
            long tail ({presets.modelsDev.length})
          </span>
          {#if presets.modelsDevError}
            <Badge variant="tonal" class="jx-hue-warning">expansion unavailable</Badge>
          {/if}
          {#if presets.modelsDev.length > 0}
            <button
              type="button"
              class="text-[11px] text-primary underline-offset-2 hover:underline"
              onclick={() => (showLongTail = !showLongTail)}
            >
              {showLongTail ? "hide" : "show"}
            </button>
          {/if}
        </div>
        {#if presets.modelsDevError}
          <p class="text-[11px] text-muted-foreground">{presets.modelsDevError}</p>
        {/if}
        {#if showLongTail}
          <div class="grid gap-3 sm:grid-cols-2" transition:slide={{ duration: 150 }}>
            {#each presets.modelsDev as preset (preset.id)}
              <button
                type="button"
                class="flex flex-col gap-1 border border-border/70 bg-card p-3 text-left transition-colors hover:border-primary/50"
                onclick={() => presetCard(preset)}
              >
                <span class="flex flex-wrap items-center gap-1.5">
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
          <Select
            label="group"
            options={groupOptions}
            value={share.groupNew ? "__new__" : share.groupName}
            onchange={(value) => {
              if (value === "__new__") {
                share.groupNew = true;
              } else {
                share.groupNew = false;
                share.groupName = value;
              }
            }}
          />
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

        <div class="grid gap-3 sm:grid-cols-3">
          <Input label="port (default from preset)" bind:value={share.port} />
          <Input label="max concurrency (optional)" placeholder="unlimited" bind:value={share.limitsConcurrency} />
          <Input label="daily requests (optional)" placeholder="unlimited" bind:value={share.limitsDaily} />
        </div>
        <p class="text-[11px] text-muted-foreground">empty limits = unlimited.</p>

        {#if selectedPreset?.keyEnv || share.keyEnv.trim() !== ""}
          <div class="flex flex-col gap-1.5">
            <Input
              label="$env variable name (injected as the upstream authorization header)"
              placeholder="OPENAI_API_KEY"
              bind:value={share.keyEnv}
            />
            <p class="text-[11px] leading-relaxed text-muted-foreground">
              export it on this machine with the full header value, e.g.
              <code class="font-mono">{share.keyEnv || selectedPreset?.keyEnv || "MY_KEY"}='Bearer &lt;key&gt;'</code>.
              consumers only ever see <code class="font-mono">&#9679;</code> - never the value.
            </p>
          </div>
        {/if}
      </div>
      {#snippet foot()}
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
          <div class="max-w-56">
            <Select
              label="link TTL"
              options={TTL_OPTIONS.map((option) => ({ value: String(option.ttlMs), label: option.label }))}
              value={String(share.ttlMs)}
              onchange={(value) => {
                const found = TTL_OPTIONS.find((option) => String(option.ttlMs) === value);
                if (found !== undefined) share.ttlMs = found.ttlMs;
              }}
            />
          </div>
          <Alert variant="tonal" title="the link itself is the credential">
            anyone holding this link can use the service until it expires. share it over a
            channel you trust, and revoke keys in Advanced when done.
          </Alert>
        </div>
        {#snippet foot()}
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
        {/snippet}
      </Card>
    {/if}
  {/if}
</div>
