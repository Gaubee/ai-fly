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
  import Accordion, { AccordionItem } from "$lib/ui/accordion";
  import Toggle from "$lib/ui/toggle";
  import NativeSelect from "$lib/ui/native-select";
  import { slide } from "svelte/transition";
  import StepHeader from "../components/StepHeader.svelte";
  import { t } from "$lib/i18n.svelte.ts";
  import { authSelSummary } from "$lib/auth-source.ts";
  import ErrorAlert from "../components/ErrorAlert.svelte";
  import CopyField from "../components/CopyField.svelte";
  import AuthSourcePicker from "../components/AuthSourcePicker.svelte";
  import GroupPicker from "../components/GroupPicker.svelte";
  import GroupKeysPanel from "../components/GroupKeysPanel.svelte";
  import TestConnection from "../components/TestConnection.svelte";
  import {
    app,
    loadPresets,
    presets,
    isLocalPreset,
    refresh,
  } from "../stores/app.svelte.ts";
  import { hooksPanel, loadHooks } from "../stores/advanced.svelte.ts";
  import {
    share,
    resetShare,
    choosePreset,
    chooseCustom,
    shareBack,
    namingNext,
    enterGroupView,
    TTL_OPTIONS,
    updateRouteFrom,
    toggleRouteBound,
    addRouteRow,
    removeRouteRow,
    moveRouteRow,
    setRouteMode,
    normalizeRoutePrefix,
    toPrefixFromInput,
  } from "../stores/share-wizard.svelte.ts";
  import { presetLogoUrl, type Preset } from "$shared/rpc-contract.ts";

  /** hooks 脚本选择联动（Owner #3 双控件；同高级页 selectHooksScript）。 */
  let hookScriptSel = $state("");
  $effect(() => {
    hookScriptSel = share.hooksScript;
  });
  function selectWizardHooksScript(script: string): void {
    share.hooksScript = script;
    if (share.auth.kind === "hook") {
      const exportsAuth = hooksPanel.scripts.some((s) => s.name === script && s.fns.includes("authHeader"));
      share.auth = exportsAuth ? { ...share.auth, script } : { kind: "none" };
    }
  }

  /** ③ group 视图：进入即落服务/分组/daemon/保底 key（幂等重进）。 */
  $effect(() => {
    if (share.step === 3) untrack(() => void enterGroupView());
  });

  /** key 原文/链接复制。 */

  onMount(() => {
    void loadHooks();
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
  /** 路由行映射预览（M3-r6）：from/* → upstream + to/*（from 有效才显示；
      to 根显示 upstream 本身 + /*）。 */
  function routeRowPreview(row: { from: string; to: string }): string | null {
    const from = normalizeRoutePrefix(row.from);
    if (from === "" || from === "/") return null;
    const to = toPrefixFromInput(row.to);
    const base = share.customUpstream.trim().replace(/\/+$/, "");
    return `${base}${to}/*`;
  }

  /** Input change 事件适配（行内受控值）。 */
  function onRowFrom(rowId: number, event: Event & { currentTarget: EventTarget & HTMLInputElement }): void {
    const row = share.routeRows.find((r) => r.id === rowId);
    if (row !== undefined) updateRouteFrom(row, event.currentTarget.value);
  }
  function onRowTo(rowId: number, event: Event & { currentTarget: EventTarget & HTMLInputElement }): void {
    const row = share.routeRows.find((r) => r.id === rowId);
    if (row !== undefined) row.to = event.currentTarget.value;
  }
  function onRowField(rowId: number, field: "match" | "template", event: Event & { currentTarget: EventTarget & HTMLInputElement }): void {
    const row = share.routeRows.find((r) => r.id === rowId);
    if (row !== undefined) row[field] = event.currentTarget.value;
  }
  function onRowMode(rowId: number, event: Event & { currentTarget: EventTarget & HTMLSelectElement }): void {
    const row = share.routeRows.find((r) => r.id === rowId);
    if (row !== undefined) setRouteMode(row, event.currentTarget.value === "pattern" ? "pattern" : "prefix");
  }

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

  // 分组选择/新建已收敛进 GroupPicker + GroupsDialog（M3-r3 ①）；此处仅留 TTL 桥接
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
            onclick={() => presetCard(preset)}
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
                onclick={() => presetCard(preset)}
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
      <div class="flex flex-col gap-3 p-3">
        <!-- Owner 2026-09-13 #1/#2：服务名与分组合一行；未选分组时服务名
             disabled（命名唯一性与端口冲突判定以分组为前提）；分组选择
             不再门控 route paths——两者独立 -->
        <div class="grid gap-3 sm:grid-cols-2">
          <!-- Owner 2026-09-13 #2：分组排服务名前（先定组；未选组时服务名 disabled） -->
          <GroupPicker value={share.groupName || undefined} onchange={(name) => (share.groupName = name ?? "")} />
          <Input
            label={t("share.name.label")}
            placeholder={share.mode === "preset" ? share.name : t("share.name.ph")}
            disabled={share.groupName === ""}
            autocapitalize="none"
            autocorrect="off"
            spellcheck={false}
            bind:value={share.name}
          />
        </div>
        {#if share.groupName !== ""}
          <p class="text-[11px] text-muted-foreground">
            {t("share.group.note")}
            <code class="font-mono">{share.groupName}</code>
            {t("share.group.note2")}
          </p>
        {/if}

        <Input
          label={t("f.upstreamUrl")}
          placeholder="https://api.example.com"
          autocapitalize="none"
          autocorrect="off"
          spellcheck={false}
          bind:value={share.customUpstream}
        />

        <!-- path routes（M3-r6 定形，Owner 裁决：客观提供路径路由功能，不做任何
             配置限制）：行 = from → to 通用转发规则，默认绑定（1:1，只编辑一个
             input），解绑自由编辑两侧；预设行预填官方镜像（如 /v1 → /v1）。
             路由表即白名单——未声明的路径本地 404，不透传。 -->
        <div class="flex flex-col gap-3">
          <span class="font-nav text-[11px] uppercase tracking-[0.1em] text-muted-foreground">
            path routes
          </span>
          {#each share.routeRows as row, index (row.id)}
            <div class="flex flex-col gap-1.5 border border-border/70 p-2.5">
              <div class="flex flex-wrap items-center gap-2">
                <span class="flex flex-col shrink-0 items-center gap-0.5">
                  <PressButton
                    variant="ghost"
                    ariaLabel={t("share.routes.moveUp")}
                    class={index === 0 ? "px-1.5 pointer-events-none opacity-40" : "px-1.5"}
                    onclick={() => moveRouteRow(row.id, -1)}
                  >↑</PressButton>
                  <PressButton
                    variant="ghost"
                    ariaLabel={t("share.routes.moveDown")}
                    class={index === share.routeRows.length - 1 ? "px-1.5 pointer-events-none opacity-40" : "px-1.5"}
                    onclick={() => moveRouteRow(row.id, 1)}
                  >↓</PressButton>
                </span>
                <div class="w-28 shrink-0">
                  <NativeSelect aria-label={t("share.routes.mode")} value={row.mode} onchange={(event) => onRowMode(row.id, event)}>
                    <option value="prefix">{t("share.routes.prefix")}</option>
                    <option value="pattern">{t("share.routes.pattern")}</option>
                  </NativeSelect>
                </div>
                {#if row.mode === "pattern"}
                  <div class="min-w-32 flex-1">
                    <Input
                      placeholder="/v1/:ver/chat/completions"
                      value={row.match}
                      onchange={(event) => onRowField(row.id, "match", event)}
                      autocapitalize="none"
                      autocorrect="off"
                      spellcheck={false}
                    />
                  </div>
                  <span class="shrink-0 text-[11px] text-muted-foreground">⇒</span>
                  <div class="min-w-32 flex-1">
                    <Input
                      placeholder={"/api/{ver}/completions"}
                      value={row.template}
                      onchange={(event) => onRowField(row.id, "template", event)}
                      autocapitalize="none"
                      autocorrect="off"
                      spellcheck={false}
                    />
                  </div>
                {:else}
                  <div class="min-w-32 flex-1">
                    <Input
                      placeholder="/v1"
                      value={row.from}
                      onchange={(event) => onRowFrom(row.id, event)}
                      autocapitalize="none"
                      autocorrect="off"
                      spellcheck={false}
                    />
                  </div>
                  <!-- Owner 2026-09-13 #3：bind 勾选 = 1:1，隐藏第二个
                       input（to 隐含等于 from），不再镜像填充 -->
                  <label class="flex shrink-0 cursor-pointer select-none items-center gap-1.5 text-[11px] text-muted-foreground">
                    <Toggle checked={row.bound} onchange={(event) => toggleRouteBound(row, event.currentTarget.checked)} />
                    bind
                  </label>
                  {#if !row.bound}
                    <div class="min-w-32 flex-1">
                      <Input
                        placeholder="/ (root)"
                        value={row.to}
                        onchange={(event) => onRowTo(row.id, event)}
                        autocapitalize="none"
                        autocorrect="off"
                        spellcheck={false}
                      />
                    </div>
                  {/if}
                {/if}
                {#if share.routeRows.length > 1}
                  <PressButton
                    variant="ghost"
                    ariaLabel={t("share.routes.remove")}
                    class="shrink-0 px-2"
                    onclick={() => removeRouteRow(row.id)}
                  >x</PressButton>
                {/if}
              </div>
              {#if row.mode === "pattern"}
                {#if row.match.trim() !== "" && row.template.trim() !== ""}
                  <p class="break-all pl-1 font-mono text-[11px] leading-relaxed text-muted-foreground">
                    match {row.match.trim()} ⇒ {row.template.trim()}
                  </p>
                {/if}
              {:else if routeRowPreview(row) !== null}
                <p class="break-all pl-1 font-mono text-[11px] leading-relaxed text-muted-foreground">
                  {normalizeRoutePrefix(row.from)}/* → {routeRowPreview(row)}
                </p>
              {/if}
            </div>
          {/each}
          <PressButton
            variant="ghost"
            class={share.routeRows.length >= 4 ? "pointer-events-none opacity-50" : undefined}
            onclick={() => addRouteRow()}
          >{t("share.routes.add")}</PressButton>
          <p class="text-[11px] leading-relaxed text-muted-foreground">
            {t("share.routes.note")}
          </p>
        </div>


        <!-- hooks 脚本选择（Owner #3 双控件）：先激活脚本，认证头 select 才出条目 -->
        <NativeSelect
          label={t("f.hookscript.label")}
          bind:value={hookScriptSel}
          onchange={(event) => selectWizardHooksScript(event.currentTarget.value)}
        >
          <option value="">{t("f.hookscript.none")}</option>
          {#each hooksPanel.scripts as script (script.name)}
            <option value={script.name}>{script.name} ({script.fns.join(", ")})</option>
          {/each}
        </NativeSelect>
        <!-- 认证头取值（#3）：预设携带 → 预选（codex 型 hook 条目 / env keep
             哨兵），② 显式改选即覆盖（含改"无"）+ 连通测试 -->
        <AuthSourcePicker
          value={share.auth}
          onchange={(sel) => (share.auth = sel)}
          hooksScript={share.hooksScript}
        />

        <TestConnection
          upstream={share.customUpstream.trim()}
          apiForm={selectedPreset?.apiForm}
          secretName={share.auth.kind === "secret" ? share.auth.name : undefined}
          presetId={share.mode === "preset" ? share.presetId : undefined}
        />

        <!-- {t('share.advanced')}（M3-acceptance ③：ghost accordion，默认折叠——
             default consumer port + match domains；路由已按 Owner 裁决
             提升主面板） -->
        <Accordion ghost>
          <AccordionItem>
            {#snippet summary()}{t('share.advanced')}{/snippet}
            <div class="flex flex-col gap-3">
              <!-- 分组限额已归口 GroupsDialog（M3-r3 ①）；此处端口/match -->
              <div class="flex flex-col gap-1.5">
                <Input label={t("share.port.label")} bind:value={share.port} />
                <p class="text-[11px] leading-relaxed text-muted-foreground">
                  {t("share.port.note")}
                </p>
              </div>
              <!-- match（M3-r5 两模式通用，预设预填官方域名）；留空 =
                   提交时用 upstream host -->
              <div class="flex flex-col gap-1.5">
                <Input
                  label={t("share.match.label")}
                  placeholder="auto: api.example.com"
                  autocapitalize="none"
                  autocorrect="off"
                  spellcheck={false}
                  bind:value={share.customMatch}
                />
                <p class="text-[11px] leading-relaxed text-muted-foreground">
                  {t("share.match.note")}
                </p>
              </div>
            </div>
          </AccordionItem>
        </Accordion>

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
    <Card title="{t('share.groupview.title')}: {share.groupName}" scroll={false}>
      <div class="flex flex-col gap-3 p-3">
        <dl class="grid grid-cols-2 gap-x-4 gap-y-1.5 text-xs">
          <div class="flex justify-between gap-2 border-b border-border/60 pb-1">
            <dt class="text-muted-foreground">{t("common.service")}</dt>
            <dd class="font-mono">{share.name}</dd>
          </div>
          <div class="flex justify-between gap-2 border-b border-border/60 pb-1">
            <dt class="text-muted-foreground">{t("share.step1")}</dt>
            <dd class="font-mono">{share.mode === "preset" ? share.presetId : "custom"}</dd>
          </div>
          <div class="flex justify-between gap-2 border-b border-border/60 pb-1">
            <dt class="text-muted-foreground">port</dt>
            <dd class="font-mono">{share.port}</dd>
          </div>
          <div class="flex justify-between gap-2 border-b border-border/60 pb-1">
            <dt class="text-muted-foreground">{t("share.generate.auth")}</dt>
            <dd class="font-mono">{authSelSummary(share.auth)}</dd>
          </div>
        </dl>

        <!-- 组内 keys（Owner #4：与高级页同一 GroupKeysPanel/同一数据源；
             分享（TTL→生成→复制）收敛进面板内 Dialog） -->
        <GroupKeysPanel group={share.groupName} />
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
/div>
