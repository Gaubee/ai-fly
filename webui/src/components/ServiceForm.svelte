<!--
  服务表单统一组件（Owner 裁决 2026-09-13 #5）：分享向导②内联渲染与
  高级设置"添加/编辑服务" Dialog 共用同一组件、同一 store
  （stores/service-form.svelte.ts）——两处编辑体验同源。

  字段序（Owner 2026-09-13 各轮裁决）：分组+服务名（分组在前，未选组
  服务名 disabled）→ 上游 URL → PATH ROUTES（bind = 隐藏第二个输入；
  ↑↓ 纵向）→ hooks 脚本（双控件第一级）→ 认证头（第二级；hook 条目
  仅在激活导出 authHeader 的脚本后出现）→ 连通测试（CardBody）→
  高级选项（接收方建议端口 + match 域名，沉底）。
-->
<script lang="ts">
  import Input from "$lib/ui/input";
  import NativeSelect from "$lib/ui/native-select";
  import PressButton from "$lib/ui/press-button";
  import Toggle from "$lib/ui/toggle";
  import Accordion, { AccordionItem } from "$lib/ui/accordion";
  import GroupPicker from "./GroupPicker.svelte";
  import AuthSourcePicker from "./AuthSourcePicker.svelte";
  import TestConnection from "./TestConnection.svelte";
  import ErrorAlert from "./ErrorAlert.svelte";
  import { serviceForm, updateRouteFrom, toggleRouteBound, addRouteRow, removeRouteRow, moveRouteRow, setRouteMode, normalizeRoutePrefix, toPrefixFromInput } from "../stores/service-form.svelte.ts";
  import { hooksPanel } from "../stores/advanced.svelte.ts";
  import { toInputFromPrefix } from "../stores/service-form.svelte.ts";
  import { t } from "$lib/i18n.svelte.ts";

  /** hooks 脚本选择联动（双控件）：换脚本时 hook 型认证跟随或回落。 */
  let hookScriptSel = $state("");
  $effect(() => {
    hookScriptSel = serviceForm.hooksScript;
  });
  function selectHooksScript(script: string): void {
    serviceForm.hooksScript = script;
    if (serviceForm.auth.kind === "hook") {
      const exportsAuth = hooksPanel.scripts.some((s) => s.name === script && s.fns.includes("authHeader"));
      serviceForm.auth = exportsAuth ? { ...serviceForm.auth, script } : { kind: "none" };
    }
  }

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
      path routes
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
              bind
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

  <!-- hooks 脚本（双控件第一级） -->
  <NativeSelect
    label={t("f.hookscript.label")}
    bind:value={hookScriptSel}
    onchange={(event) => selectHooksScript(event.currentTarget.value)}
  >
    <option value="">{t("f.hookscript.none")}</option>
    {#each hooksPanel.scripts as script (script.name)}
      <option value={script.name}>{script.name} ({script.fns.join(", ")})</option>
    {/each}
  </NativeSelect>

  <!-- 认证头（双控件第二级） -->
  <AuthSourcePicker
    value={serviceForm.auth}
    onchange={(sel) => (serviceForm.auth = sel)}
    hooksScript={serviceForm.hooksScript}
  />

  <TestConnection
    upstream={serviceForm.upstream.trim()}
    secretName={serviceForm.auth.kind === "secret" ? serviceForm.auth.name : undefined}
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
