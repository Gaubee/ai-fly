<!-- 提供方分享向导（B 3.2 + M3 3.2/3.3/6.2/6.3，#/share 三步）：
     ①服务来源（预设卡片网格：图标（models.dev logos，失败回退首字母
     tile）+ 搜索框（label/id/baseUrl 过滤精选与长尾）/ 本地运行时排前 /
     featured 徽标 / models.dev 长尾折叠区 + 断网提示 + 自定义 URL 卡）→
     ②命名与分组（服务名/分组（可新建，提示已有组）/密钥选择器 + manage
     secrets 面板/连通测试；限额/default consumer port/自定义 match domains/
     按标准 api routes（M3-r4 ⑦，custom 模式）收进默认折叠的 advanced
     options 手风琴——match 留空 = 提交时用 upstream host）→ ③生成分享
     （链接 + 一键复制 + 链接即凭证警示 +
     TTL + 密钥已存本机密钥面板提示）。状态机在 stores/share-wizard。 -->
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
  import { slide } from "svelte/transition";
  import StepHeader from "../components/StepHeader.svelte";
  import { t } from "$lib/i18n.svelte.ts";
  import { authSelSummary } from "$lib/auth-source.ts";
  import ErrorAlert from "../components/ErrorAlert.svelte";
  import CopyField from "../components/CopyField.svelte";
  import GroupKeysPanel from "../components/GroupKeysPanel.svelte";
  import ServiceForm from "../components/ServiceForm.svelte";
  import {
    app,
    loadPresets,
    presets,
    isLocalPreset,
    refresh,
  } from "../stores/app.svelte.ts";
  import { serviceForm } from "../stores/service-form.svelte.ts";
  import {
    share,
    resetShare,
    choosePreset,
    chooseCustom,
    shareBack,
    namingNext,
    enterGroupView,
  } from "../stores/share-wizard.svelte.ts";
  import { presetLogoUrl, type Preset } from "$shared/rpc-contract.ts";


  /** ③ group 视图：进入即落服务/分组/daemon/保底 key（幂等重进）。 */
  $effect(() => {
    if (share.step === 3) untrack(() => void enterGroupView());
  });

  /** key 原文/链接复制。 */

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
    <h1 class="font-nav text-base uppercase tracking-[0.1em]">{t("share.title")}</h1>
    <StepHeader
      step={share.step}
      locked={share.step === 3}
      titles={[t("share.step1"), t("share.step2"), t("share.step3")]}
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
      <Alert variant="tonal" class="jx-hue-error" assertive title={t("share.presetsFail")}>
        {presets.error}
      </Alert>
    {:else}
      <div class="grid gap-3 sm:grid-cols-2" transition:slide={{ duration: 180 }}>
        {#each visibleCurated as preset (preset.id)}
          <button
            type="button"
            class="flex min-h-24 flex-col gap-1.5 border border-border bg-card p-3.5 text-left shadow-2xs transition-colors hover:border-primary/50"
            onclick={() => choosePreset(preset)}
          >
            <span class="flex flex-wrap items-center gap-1.5">
              {@render presetIcon(preset)}
              <span class="font-nav text-xs uppercase tracking-[0.1em]">{preset.label}</span>
              {#if isLocalPreset(preset)}
                <Badge variant="tonal" class="jx-hue-success">local</Badge>
              {/if}
              <Badge variant="outline">{t("share.preset.featured")}</Badge>
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
          <span class="font-nav text-xs uppercase tracking-[0.1em]">{t("share.custom.title")}</span>
          <span class="text-[11px] leading-relaxed text-muted-foreground">
            {t("share.custom.body")}
          </span>
        </button>
      </div>
      {#if search.trim() !== "" && visibleCurated.length === 0 && visibleLongTail.length === 0}
        <p class="text-[11px] text-muted-foreground">
          {t("share.search.none", { query: search.trim() })}
        </p>
      {/if}

      <!-- models.dev 长尾区（断网/禁用：扩展不可用状态；搜索时自动展开） -->
      <Separator />
      <div class="flex flex-col gap-2">
        <div class="flex items-center gap-2">
          <span class="font-nav text-[11px] uppercase tracking-[0.1em] text-muted-foreground">
            {t("share.longtail", { count: visibleLongTail.length })}
          </span>
          {#if presets.modelsDevError}
            <Badge variant="tonal" class="jx-hue-warning">{t("share.longtail.unavailable")}</Badge>
          {/if}
          {#if presets.modelsDev.length > 0}
            <button
              type="button"
              class="text-[11px] text-primary underline-offset-2 hover:underline"
              onclick={() => (showLongTail = !longTailOpen)}
            >
              {t(longTailOpen ? "share.longtail.hide" : "share.longtail.show")}
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
                onclick={() => choosePreset(preset)}
              >
                <span class="flex flex-wrap items-center gap-1.5">
                  {@render presetIcon(preset)}
                  <span class="font-nav text-xs uppercase tracking-[0.1em]">{preset.label}</span>
                  <Badge variant="outline">models.dev</Badge>
                  {#if preset.unverified}
                    <Badge variant="tonal" class="jx-hue-warning">{t("share.unverified")}</Badge>
                  {/if}
                </span>
                <span class="font-mono text-[11px] text-muted-foreground">{preset.baseUrl}</span>
              </button>
            {/each}
          </div>
        {/if}
      </div>
    {/if}

  <!-- ② 命名与分组（M3-r5：预设 = 预填的 Custom——upstream/match/路由/端口
       全部展开可编辑，两模式同一条组装提交路径） -->
  {:else if share.step === 2}
    <Card title="name & group" scroll={false}>
      <div class="p-3">
        <!-- Owner 裁决 2026-09-13 #5：与高级设置编辑服务同一套组件/同一 store -->
        <ServiceForm />
      </div>
      {#snippet foot()}
        <CardFooter label="share wizard actions">
          <PressButton variant="ghost" onclick={shareBack} class={share.busy !== "" ? "pointer-events-none opacity-50" : undefined}>back</PressButton>
          <PressButton
            variant="fill"
            onclick={() => {
              namingNext();
            }}
          >
            continue
          </PressButton>
        </CardFooter>
      {/snippet}
    </Card>
    <ErrorAlert error={share.error} />

  <!-- ③ group 视图（Owner 裁决 2026-09-13 #6）：组内 key 清单——复制
       key 原文 / 为该 key 现铸分享链接 / 新增 key（组内无 key 自动
       "default"）；取代旧"生成分享链接"单结果面板 -->
  {:else}
    <Card title="{t('share.groupview.title')}: {serviceForm.groupName}" scroll={false}>
      <div class="flex flex-col gap-3 p-3">
        <dl class="grid grid-cols-2 gap-x-4 gap-y-1.5 text-xs">
          <div class="flex justify-between gap-2 border-b border-border/60 pb-1">
            <dt class="text-muted-foreground">{t("common.service")}</dt>
            <dd class="font-mono">{serviceForm.name}</dd>
          </div>
          <div class="flex justify-between gap-2 border-b border-border/60 pb-1">
            <dt class="text-muted-foreground">{t("share.step1")}</dt>
            <dd class="font-mono">{share.mode === "preset" ? share.presetId : "custom"}</dd>
          </div>
          <div class="flex justify-between gap-2 border-b border-border/60 pb-1">
            <dt class="text-muted-foreground">port</dt>
            <dd class="font-mono">{serviceForm.port}</dd>
          </div>
          <div class="flex justify-between gap-2 border-b border-border/60 pb-1">
            <dt class="text-muted-foreground">{t("share.generate.auth")}</dt>
            <dd class="font-mono">{authSelSummary(serviceForm.auth)}</dd>
          </div>
        </dl>

        <!-- 组内 keys（Owner #4：与高级页同一 GroupKeysPanel/同一数据源；
             分享（TTL→生成→复制）收敛进面板内 Dialog） -->
        <GroupKeysPanel group={serviceForm.groupName} />
        <Alert variant="tonal" title={t("share.credential.title")}>
          {t("share.credential.body")}
        </Alert>
      </div>
      {#snippet foot()}
        <CardFooter label="share wizard actions">
          <PressButton variant="ghost" onclick={shareBack} class={share.busy !== "" ? "pointer-events-none opacity-50" : undefined}>back</PressButton>
          <span class="flex items-center gap-1.5">
            <PressButton
              variant="ghost"
              onclick={() => {
                resetShare();
                void loadPresets();
              }}
            >
              share another
            </PressButton>
            <PressButton variant="fill" href="#/dashboard" external={false}>{t("share.goDashboard")}</PressButton>
          </span>
        </CardFooter>
      {/snippet}
    </Card>
    <ErrorAlert error={share.error} />
  {/if}
</div>
