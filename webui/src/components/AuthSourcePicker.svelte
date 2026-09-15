<!--
  ① auth 阶段编辑器（hooks-lifecycle 7.2，AuthSourcePicker 演进）：
  四族单选 none / secret（密钥库 + manage secrets… 入口，「选择器 + 管理弹窗」
  模式沿用，SecretsDialog 联动）/ script（hooks.list 阶段矩阵过滤
  onRequestBearerAuthentication 的脚本）/ literal（手填值）+ Bearer 前缀
  开关（auth 槽唯一 bearer 来源——密钥面板不再携带前缀语义）。
  keep 透传哨兵退役：四族覆盖全部可产生形态。互斥由单选结构保证；
  状态模型见 $lib/lifecycle.ts。
-->
<script lang="ts">
  import { onMount } from "svelte";
  import NativeSelect from "$lib/ui/native-select";
  import Input from "$lib/ui/input";
  import Toggle from "$lib/ui/toggle";
  import SecretsDialog from "./SecretsDialog.svelte";
  import { secrets, refreshSecrets } from "../stores/secrets.svelte.ts";
  import { hooksPanel, loadHooks } from "../stores/advanced.svelte.ts";
  import { scriptsForStage, type AuthStageSel } from "$lib/lifecycle.ts";
  import { t } from "$lib/i18n.svelte.ts";

  interface Props {
    /** 当前 auth 阶段选择（none/secret/script/literal，见 lifecycle.ts）。 */
    value: AuthStageSel;
    onchange?: (sel: AuthStageSel) => void;
  }
  let { value, onchange }: Props = $props();

  const NONE = "";
  const LITERAL = "__literal__";
  const MANAGE = "__manage__";

  let dialogOpen = $state(false);
  let selected = $state<string>(NONE);
  let missingScript = $state<string | null>(null);

  /** ① auth 阶段可用脚本（stages 矩阵过滤——旧导出名不在矩阵内自然排除）。 */
  const authScripts = $derived(scriptsForStage(hooksPanel.scripts, "onRequestBearerAuthentication"));

  function encode(sel: AuthStageSel): string {
    switch (sel.kind) {
      case "none":
        return NONE;
      case "secret":
        return `secret:${sel.name}`;
      case "script":
        return `script:${sel.script}`;
      case "literal":
        return LITERAL;
    }
  }

  // 外部 value → 显示值（表单打开/向导预选/重置联动）
  $effect(() => {
    selected = encode(value);
    if (value.kind !== "none") missingScript = null;
  });

  // 守卫：选中物被删 → 回落无（名单加载后判定）；脚本被禁用/删除或不再
  // 导出 auth 阶段 → 同样回落（缺失提示由 missingScript 承载）。
  $effect(() => {
    if (secrets.loaded && value.kind === "secret" && !secrets.names.includes(value.name)) {
      missingScript = null;
      onchange?.({ kind: "none" });
    }
    if (hooksPanel.loaded && value.kind === "script" && !authScripts.includes(value.script)) {
      missingScript = value.script;
      onchange?.({ kind: "none" });
    }
  });

  // 密钥面板关闭 → 刷新名单并保持选择（外部变更也对账一次）
  let wasOpen = false;
  $effect(() => {
    const nowOpen = dialogOpen;
    if (wasOpen && !nowOpen) void refreshSecrets();
    wasOpen = nowOpen;
  });

  onMount(() => {
    void refreshSecrets();
    void loadHooks();
  });

  function handleChange(event: Event & { currentTarget: EventTarget & HTMLSelectElement }): void {
    const next = event.currentTarget.value;
    if (next === MANAGE) {
      dialogOpen = true;
      selected = encode(value); // manage 只是入口，选择停留回原值
      return;
    }
    if (next === NONE) {
      onchange?.({ kind: "none" });
      return;
    }
    if (next === LITERAL) {
      onchange?.({ kind: "literal", value: "", bearer: true });
      return;
    }
    if (next.startsWith("secret:")) {
      onchange?.({ kind: "secret", name: next.slice("secret:".length), bearer: value.kind !== "none" ? value.bearer : true });
      return;
    }
    if (next.startsWith("script:")) {
      onchange?.({ kind: "script", script: next.slice("script:".length), bearer: value.kind !== "none" ? value.bearer : true });
    }
  }
</script>

<div class="flex flex-col gap-1.5">
  <NativeSelect label={t("f.authpicker.label")} bind:value={selected} onchange={handleChange}>
    <option value={NONE}>{t("f.authpicker.none")}</option>
    {#if secrets.names.length > 0}
      <optgroup label={t("f.authpicker.group.secrets")}>
        {#each secrets.names as secretName (secretName)}
          <option value={`secret:${secretName}`}>{secretName}</option>
        {/each}
      </optgroup>
    {/if}
    {#if authScripts.length > 0}
      <optgroup label={t("f.authpicker.group.scripts")}>
        {#each authScripts as scriptName (scriptName)}
          <option value={`script:${scriptName}`}>{scriptName} ({t("f.lifecycle.auth")})</option>
        {/each}
      </optgroup>
    {/if}
    <option value={LITERAL}>{t("f.authpicker.literal")}</option>
    <option value={MANAGE}>{t("f.authpicker.manage")}</option>
  </NativeSelect>

  {#if value.kind === "literal"}
    <Input
      label={t("f.authpicker.literalValue")}
      placeholder="sk-..."
      autocapitalize="none"
      autocorrect="off"
      spellcheck={false}
      value={value.value}
      onchange={(event) => {
        if (value.kind !== "literal") return;
        onchange?.({ ...value, value: event.currentTarget.value });
      }}
    />
  {/if}
  {#if value.kind !== "none"}
    <!-- Bearer 前缀开关（auth 槽唯一来源；Owner 2026-09-13 #7/#8 Toggle 惯例） -->
    <label class="flex items-center gap-2 text-[11px] text-muted-foreground">
      <Toggle
        checked={value.bearer}
        onchange={(event) => {
          if (value.kind === "none") return;
          onchange?.({ ...value, bearer: event.currentTarget.checked });
        }}
      />
      {t("f.authpicker.bearer")}
    </label>
  {/if}
  {#if value.kind === "secret"}
    <p class="text-[11px] leading-relaxed text-muted-foreground">
      {t("f.secretpicker.note")}
      <code class="font-mono">&#9679;</code>
    </p>
  {/if}
  {#if missingScript !== null}
    <p class="text-[11px] leading-relaxed text-primary">
      {t("f.authpicker.missing", { script: missingScript })}
    </p>
  {/if}
</div>

<SecretsDialog bind:open={dialogOpen} onpick={(name) => onchange?.({ kind: "secret", name, bearer: value.kind !== "none" ? value.bearer : true })} />
