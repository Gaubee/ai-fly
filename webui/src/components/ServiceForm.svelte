<!--
  服务表单统一组件（Owner 裁决 2026-09-13 #5）：分享向导②内联渲染与
  高级设置"添加/编辑服务" Dialog 共用同一组件、同一 store
  （stores/service-form.svelte.ts）——两处编辑体验同源。

  字段序（Owner 2026-09-13 各轮裁决 + hooks-lifecycle 7.2）：分组+服务名
  （分组在前，未选组服务名 disabled）→ 上游 URL → PATH ROUTES（bind =
  隐藏第二个输入；↑↓ 纵向）→ Request lifecycle 四阶段管线（①auth/②headers
  默认展开——二八高频；③request/④response 折叠收纳；编号 + 左侧连接线；
  旧「hooks 脚本」一级下拉已吸收进各阶段行）→ 连通测试（CardBody）→
  高级选项（接收方建议端口 + match 域名，沉底）。
-->
<script lang="ts">
  import { onMount } from "svelte";
  import Input from "$lib/ui/input";
  import NativeSelect from "$lib/ui/native-select";
  import PressButton from "$lib/ui/press-button";
  import Toggle from "$lib/ui/toggle";
  import Accordion, { AccordionItem } from "$lib/ui/accordion";
  import GroupPicker from "./GroupPicker.svelte";
  import AuthSourcePicker from "./AuthSourcePicker.svelte";
  import HeaderKVEditor from "./HeaderKVEditor.svelte";
  import TestConnection from "./TestConnection.svelte";
  import ErrorAlert from "./ErrorAlert.svelte";
  import {
    serviceForm,
    updateRouteFrom,
    toggleRouteBound,
    addRouteRow,
    removeRouteRow,
    moveRouteRow,
    setRouteMode,
    normalizeRoutePrefix,
    toPrefixFromInput,
    toInputFromPrefix,
    setStageScript,
    setAuthSel,
    setLifecycleMode,
    setPresetScript,
    authDraft,
    headersSummary,
  } from "../stores/service-form.svelte.ts";
  import { hooksPanel, loadHooks } from "../stores/advanced.svelte.ts";
  import {
    authSelSummary,
    coveredStagesOf,
    presetEligibleScripts,
    scriptsForStage,
    STAGE_FN_NAMES,
    STAGE_LABELS,
  } from "$lib/lifecycle.ts";
  /** 未覆盖阶段的缺省语义（UI delta「未覆盖阶段显示缺省语义」——复核 R1-P3）。 */
  const STAGE_DEFAULTS: Record<string, string> = {
    onRequestBearerAuthentication: "f.lifecycle.default.none",
    onRequestHeaders: "f.lifecycle.default.none",
    onRequest: "f.lifecycle.default.jsBackend",
    onResponse: "f.lifecycle.default.none",
  };
  import { t } from "$lib/i18n.svelte.ts";

  /** ③ request / ④ response 阶段可用脚本（stages 矩阵过滤）。 */
  const requestScripts = $derived(scriptsForStage(hooksPanel.scripts, "onRequest"));
  const responseScripts = $derived(scriptsForStage(hooksPanel.scripts, "onResponse"));
  /** 预设模式候选（≥1 阶段导出）与当前覆盖阶段徽章。 */
  const presetCandidates = $derived(presetEligibleScripts(hooksPanel.scripts));
  const coveredStages = $derived(
    serviceForm.presetScript === "" ? [] : coveredStagesOf(hooksPanel.scripts, serviceForm.presetScript),
  );

  // 挂载即拉取 hooks 清单（复核 R4-P1）：预设模式不渲染 AuthSourcePicker——
  // 其 onMount 的 loadHooks() 是唯一装载点，干净会话（分享向导直达 codex 预设）
  // 会拿到空候选与全未覆盖徽章。幂等（loaded 守卫），多入口重复调用无副作用。
  onMount(() => {
    void loadHooks();
  });

  /** 连通测试的 auth 槽草稿（契约 services.test 输入——不再接受 secretName 单字段）。 */
  const testAuthDraft = $derived(authDraft());
  /** models.dev 探测（custom 路径）仍以 secretName 引用密钥库。 */
  const testSecretName = $derived(serviceForm.auth.kind === "secret" ? serviceForm.auth.name : undefined);

  function routeRowPreview(row: { mode: string; from: string; to: string; match: string; template: string }): string | null {
    if (row.mode === "pattern") {
      return row.match.trim() !== "" && row.template.trim() !== "" ? `${row.match.trim()} ⇒ ${row.template.trim()}` : null;
    }
    return row.to.trim() !== "" ? toInputFromPrefix(toPrefixFromInput(row.to)) : null;
  }
</script>

<div class="flex flex-col gap-3">
  <!-- 分组 + 服务名（#2：分组在前；未选组服务名 disabled） -->
  <div class="grid gap-3 sm:grid-cols-2">
    <GroupPicker value={serviceForm.groupName || undefined} onchange={(name) => (serviceForm.groupName = name ?? "")} />
    <Input
      label={t("share.name.label")}
      placeholder={serviceForm.presetId !== "" ? serviceForm.name : t("share.name.ph")}
      disabled={serviceForm.groupName === ""}
      autocapitalize="none"
      autocorrect="off"
      spellcheck={false}
      bind:value={serviceForm.name}
    />
  </div>

  <Input
    label={t("f.upstreamUrl")}
    placeholder="https://api.example.com"
    autocapitalize="none"
    autocorrect="off"
    spellcheck={false}
    bind:value={serviceForm.upstream}
  />

  <!-- PATH ROUTES（#3：bind = 隐藏第二个输入；↑↓ 纵向排列） -->
  <div class="flex flex-col gap-3">
    <span class="font-nav text-[11px] uppercase tracking-[0.1em] text-muted-foreground">
      {t("f.routes.label")}
    </span>
    {#each serviceForm.routeRows as row, index (row.id)}
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
              class={index === serviceForm.routeRows.length - 1 ? "px-1.5 pointer-events-none opacity-40" : "px-1.5"}
              onclick={() => moveRouteRow(row.id, 1)}
            >↓</PressButton>
          </span>
          <div class="w-28 shrink-0">
            <NativeSelect aria-label={t("share.routes.mode")} value={row.mode} onchange={(event) => setRouteMode(row, event.currentTarget.value as "prefix" | "pattern")}>
              <option value="prefix">{t("share.routes.prefix")}</option>
              <option value="pattern">{t("share.routes.pattern")}</option>
            </NativeSelect>
          </div>
          {#if row.mode === "pattern"}
            <div class="min-w-32 flex-1">
              <Input
                placeholder="/v1/:ver/chat/completions"
                value={row.match}
                onchange={(event) => (row.match = event.currentTarget.value)}
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
                onchange={(event) => (row.template = event.currentTarget.value)}
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
                onchange={(event) => updateRouteFrom(row, event.currentTarget.value)}
                autocapitalize="none"
                autocorrect="off"
                spellcheck={false}
              />
            </div>
            <label class="flex shrink-0 cursor-pointer select-none items-center gap-1.5 text-[11px] text-muted-foreground">
              <Toggle checked={row.bound} onchange={(event) => toggleRouteBound(row, event.currentTarget.checked)} />
              {t("f.routes.bind")}
            </label>
            {#if !row.bound}
              <div class="min-w-32 flex-1">
                <Input
                  placeholder="/ (root)"
                  value={row.to}
                  onchange={(event) => (row.to = event.currentTarget.value)}
                  autocapitalize="none"
                  autocorrect="off"
                  spellcheck={false}
                />
              </div>
            {/if}
          {/if}
          {#if serviceForm.routeRows.length > 1}
            <PressButton
              variant="ghost"
              ariaLabel={t("share.routes.remove")}
              class="shrink-0 px-2"
              onclick={() => removeRouteRow(row.id)}
            >x</PressButton>
          {/if}
        </div>
        {#if routeRowPreview(row) !== null}
          <p class="break-all pl-1 font-mono text-[11px] leading-relaxed text-muted-foreground">
            {row.mode === "pattern" ? routeRowPreview(row) : `${normalizeRoutePrefix(row.from)}/* → ${routeRowPreview(row)}`}
          </p>
        {/if}
      </div>
    {/each}
    <PressButton
      variant="ghost"
      class={serviceForm.routeRows.length >= 4 ? "pointer-events-none opacity-50" : undefined}
      onclick={() => addRouteRow()}
    >{t("share.routes.add")}</PressButton>
  </div>

  <!-- Request lifecycle（双模式——Owner 2026-09-15）：custom = 四阶段纵向管线
       （编号 + 左侧连接线；①②默认展开，③④折叠收纳）；preset = 整段脚本绑定
       （选择器 + 覆盖阶段徽章）。两模式互斥，切换清空另一侧。 -->
  <div class="flex flex-col gap-3">
    <div class="flex items-center gap-2">
      <span class="font-nav text-[11px] uppercase tracking-[0.1em] text-muted-foreground">
        {t("f.lifecycle.label")}
      </span>
      <span class="ml-auto inline-flex overflow-hidden rounded-md border border-border">
        <PressButton
          variant="ghost"
          class={serviceForm.lifecycleMode === "custom" ? "bg-primary/10 px-2 py-0.5 text-[11px]" : "px-2 py-0.5 text-[11px]"}
          onclick={() => setLifecycleMode("custom")}
        >{t("f.lifecycle.mode.custom")}</PressButton>
        <PressButton
          variant="ghost"
          class={serviceForm.lifecycleMode === "preset" ? "bg-primary/10 px-2 py-0.5 text-[11px]" : "px-2 py-0.5 text-[11px]"}
          onclick={() => setLifecycleMode("preset")}
        >{t("f.lifecycle.mode.preset")}</PressButton>
      </span>
    </div>
    {#if serviceForm.lifecycleMode === "preset"}
      <!-- 预设模式：整段脚本 + 覆盖阶段徽章（未覆盖阶段走缺省语义——③ 缺省
           js-backend-fetch 直连） -->
      <div class="flex flex-col gap-1.5">
        <NativeSelect
          aria-label={t("f.lifecycle.mode.preset")}
          value={serviceForm.presetScript}
          onchange={(event) => setPresetScript(event.currentTarget.value)}
        >
          <option value="">{t("f.lifecycle.preset.none")}</option>
          {#each presetCandidates as cand (cand.name)}
            <option value={cand.name}>{cand.name}</option>
          {/each}
        </NativeSelect>
        {#if serviceForm.presetScript !== ""}
          <div class="flex flex-col gap-1">
            {#each STAGE_FN_NAMES as stage (stage)}
              {@const covered = coveredStages.includes(stage)}
              <div class="flex items-center gap-1.5">
                <span class="rounded-sm px-1.5 py-0.5 font-mono text-[11px] {covered ? 'bg-primary/15 text-foreground' : 'bg-muted text-muted-foreground'}">{STAGE_LABELS[stage]}</span>
                {#if covered}
                  <span class="text-[11px] text-muted-foreground">{t("f.lifecycle.preset.covered")}</span>
                {:else}
                  <span class="text-[11px] text-muted-foreground">{t(STAGE_DEFAULTS[stage])}</span>
                {/if}
              </div>
            {/each}
          </div>
        {/if}
        <p class="text-[11px] leading-relaxed text-muted-foreground">{t("f.lifecycle.preset.hint")}</p>
      </div>
    {:else}
    <div class="relative">
      <!-- 管线连接线（badge 列中垂线；badge 本身 z-10 压线） -->
      <span class="absolute bottom-3 left-3 top-3 w-px bg-border" aria-hidden="true"></span>
      <Accordion ghost>
        <!-- ① auth（默认展开） -->
        <div class="flex items-start gap-2.5">
          <span class="relative z-10 flex size-6 flex-none items-center justify-center rounded-full border border-border bg-card font-mono text-[11px] text-muted-foreground">1</span>
          <div class="min-w-0 flex-1 pb-1">
            <AccordionItem open={true}>
              {#snippet summary()}{t("f.lifecycle.auth")} · <span class="font-mono normal-case tracking-normal">{authSelSummary(serviceForm.auth)}</span>{/snippet}
              <div class="pt-1.5">
                <AuthSourcePicker value={serviceForm.auth} onchange={(sel) => setAuthSel(sel)} />
              </div>
            </AccordionItem>
          </div>
        </div>
        <!-- ② headers（默认展开） -->
        <div class="flex items-start gap-2.5">
          <span class="relative z-10 flex size-6 flex-none items-center justify-center rounded-full border border-border bg-card font-mono text-[11px] text-muted-foreground">2</span>
          <div class="min-w-0 flex-1 pb-1">
            <AccordionItem open={true}>
              {#snippet summary()}{t("f.lifecycle.headers")} · <span class="font-mono normal-case tracking-normal">{headersSummary()}</span>{/snippet}
              <div class="pt-1.5">
                <HeaderKVEditor />
              </div>
            </AccordionItem>
          </div>
        </div>
        <!-- ③ request（折叠收纳；未绑定时明示 js-backend-fetch 直连） -->
        <div class="flex items-start gap-2.5">
          <span class="relative z-10 flex size-6 flex-none items-center justify-center rounded-full border border-border bg-card font-mono text-[11px] text-muted-foreground">3</span>
          <div class="min-w-0 flex-1">
            <AccordionItem>
              {#snippet summary()}{t("f.lifecycle.request")} · <span class="font-mono normal-case tracking-normal">{serviceForm.requestScript.trim() !== "" ? serviceForm.requestScript.trim() : t("f.lifecycle.request.unbound")}</span>{/snippet}
              <div class="flex flex-col gap-1.5 pt-1.5">
                <NativeSelect
                  aria-label={t("f.lifecycle.request")}
                  value={serviceForm.requestScript}
                  onchange={(event) => setStageScript("request", event.currentTarget.value)}
                >
                  <option value="">{t("f.lifecycle.request.unbound")}</option>
                  {#each requestScripts as scriptName (scriptName)}
                    <option value={scriptName}>{scriptName}</option>
                  {/each}
                </NativeSelect>
                <p class="text-[11px] leading-relaxed text-muted-foreground">{t("f.lifecycle.request.hint")}</p>
              </div>
            </AccordionItem>
          </div>
        </div>
        <!-- ④ response（折叠收纳） -->
        <div class="flex items-start gap-2.5">
          <span class="relative z-10 flex size-6 flex-none items-center justify-center rounded-full border border-border bg-card font-mono text-[11px] text-muted-foreground">4</span>
          <div class="min-w-0 flex-1">
            <AccordionItem>
              {#snippet summary()}{t("f.lifecycle.response")} · <span class="font-mono normal-case tracking-normal">{serviceForm.responseScript.trim() !== "" ? serviceForm.responseScript.trim() : t("f.lifecycle.none")}</span>{/snippet}
              <div class="flex flex-col gap-1.5 pt-1.5">
                <NativeSelect
                  aria-label={t("f.lifecycle.response")}
                  value={serviceForm.responseScript}
                  onchange={(event) => setStageScript("response", event.currentTarget.value)}
                >
                  <option value="">{t("f.lifecycle.script.none")}</option>
                  {#each responseScripts as scriptName (scriptName)}
                    <option value={scriptName}>{scriptName}</option>
                  {/each}
                </NativeSelect>
                <p class="text-[11px] leading-relaxed text-muted-foreground">{t("f.lifecycle.response.hint")}</p>
              </div>
            </AccordionItem>
          </div>
        </div>
      </Accordion>
    </div>
    {/if}
  </div>

  <TestConnection
    upstream={serviceForm.upstream.trim()}
    apiForm={serviceForm.apiForm}
    auth={testAuthDraft}
    secretName={testSecretName}
    presetId={serviceForm.presetId !== "" ? serviceForm.presetId : undefined}
  />

  <!-- 高级选项（#4 沉底：接收方建议端口 + match 域名） -->
  <Accordion ghost>
    <AccordionItem>
      {#snippet summary()}{t('share.advanced')}{/snippet}
      <div class="flex flex-col gap-3">
        <Input label={t("share.port.label")} bind:value={serviceForm.port} />
        <Input
          label={t("share.match.label")}
          placeholder="auto: api.example.com"
          autocapitalize="none"
          autocorrect="off"
          spellcheck={false}
          bind:value={serviceForm.customMatch}
        />
      </div>
    </AccordionItem>
  </Accordion>

  <ErrorAlert error={serviceForm.error} />
</div>
