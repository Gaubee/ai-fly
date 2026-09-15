<!--
  ② headers 阶段编辑器（hooks-lifecycle 7.2，通用 K-V 编辑器）：set 行
  编辑（名称 + 字面量值——值允许 $env:/\$secret: 引用语法，placeholder
  提示；模板取自 PATH ROUTES 行编辑器）+ remove 名单（逗号/空白分隔）+
  整段脚本绑定（stages 矩阵过滤 onRequestHeaders）。行操作零校验——
  形状归一在组装期（stores/service-form 的 headersSlotFromForm）。
  状态直接读写 serviceForm store（表单域组件，ServiceForm 内嵌渲染）。
-->
<script lang="ts">
  import Input from "$lib/ui/input";
  import NativeSelect from "$lib/ui/native-select";
  import PressButton from "$lib/ui/press-button";
  import {
    serviceForm,
    addHeaderRow,
    removeHeaderRow,
    setStageScript,
  } from "../stores/service-form.svelte.ts";
  import { hooksPanel } from "../stores/advanced.svelte.ts";
  import { scriptsForStage } from "$lib/lifecycle.ts";
  import { t } from "$lib/i18n.svelte.ts";

  /** ② headers 阶段可用脚本（stages 矩阵过滤）。 */
  const headersScripts = $derived(scriptsForStage(hooksPanel.scripts, "onRequestHeaders"));
</script>

<div class="flex flex-col gap-3">
  <!-- set 行（名称 + 值；引用语法随值键入） -->
  <div class="flex flex-col gap-1.5">
    <span class="text-[11px] text-muted-foreground">{t("f.headers.set")}</span>
    {#each serviceForm.headerSetRows as row (row.id)}
      <div class="flex flex-wrap items-center gap-2">
        <div class="min-w-32 flex-1">
          <Input
            placeholder={t("f.headers.namePh")}
            value={row.name}
            onchange={(event) => (row.name = event.currentTarget.value)}
            autocapitalize="none"
            autocorrect="off"
            spellcheck={false}
          />
        </div>
        <div class="min-w-32 flex-[2]">
          <Input
            placeholder={t("f.headers.valuePh")}
            value={row.value}
            onchange={(event) => (row.value = event.currentTarget.value)}
            autocapitalize="none"
            autocorrect="off"
            spellcheck={false}
          />
        </div>
        {#if serviceForm.headerSetRows.length > 1}
          <PressButton
            variant="ghost"
            ariaLabel={t("f.headers.removeRow")}
            class="shrink-0 px-2"
            onclick={() => removeHeaderRow(row.id)}
          >x</PressButton>
        {/if}
      </div>
    {/each}
    <PressButton
      variant="ghost"
      class={serviceForm.headerSetRows.length >= 32 ? "pointer-events-none opacity-50" : undefined}
      onclick={() => addHeaderRow()}
    >{t("f.headers.setAdd")}</PressButton>
  </div>

  <!-- remove 名单（逗号/空白分隔） -->
  <Input
    label={t("f.headers.remove")}
    placeholder={t("f.headers.removePh")}
    autocapitalize="none"
    autocorrect="off"
    spellcheck={false}
    value={serviceForm.headerRemove}
    onchange={(event) => (serviceForm.headerRemove = event.currentTarget.value)}
  />

  <!-- 整段脚本绑定（低频；与 set/remove 并存——脚本增量胜出） -->
  <NativeSelect
    label={t("f.headers.script")}
    value={serviceForm.headersScript}
    onchange={(event) => setStageScript("headers", event.currentTarget.value)}
  >
    <option value="">{t("f.lifecycle.script.none")}</option>
    {#each headersScripts as scriptName (scriptName)}
      <option value={scriptName}>{scriptName}</option>
    {/each}
  </NativeSelect>
</div>
