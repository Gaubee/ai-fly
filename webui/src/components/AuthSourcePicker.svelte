<!--
  认证头取值选择器（Owner 裁决 2026-09-13 #3 双控件模型 + PM 方案 B 骨架）：
  「认证头」select 承载 无 / 密钥族 / 管理密钥…/ keep 哨兵（回显透传 CLI/
  预配置）。hook 条目只在表单先激活了 hooks 脚本（hooksScript prop）且该
  脚本导出 authHeader 时出现——"先为 service 配置使用 hook 脚本，选中了
  codex，才能在 select 中看到对应选项"（Owner 原话）。选中 hook 条目 →
  详情行 authorization ← script.authHeader() + Bearer 前缀开关。互斥由
  单选结构保证。状态模型见 $lib/auth-source.ts。
-->
<script lang="ts">
  import { onMount } from "svelte";
  import NativeSelect from "$lib/ui/native-select";
  import Toggle from "$lib/ui/toggle";
  import SecretsDialog from "./SecretsDialog.svelte";
  import { secrets, refreshSecrets } from "../stores/secrets.svelte.ts";
  import { hooksPanel, loadHooks } from "../stores/advanced.svelte.ts";
  import type { AuthSel } from "$lib/auth-source.ts";
  import { t } from "$lib/i18n.svelte.ts";

  interface Props {
    /** 当前选中来源（none/secret/hook/keep，见 auth-source.ts）。 */
    value: AuthSel;
    onchange?: (sel: AuthSel) => void;
    /** 表单激活的 hooks 脚本名（"" = 未激活——认证头不出现 hook 条目）。 */
    hooksScript?: string;
  }
  let { value, onchange, hooksScript = "" }: Props = $props();

  const NONE = "";
  const KEEP = "__keep__";
  const MANAGE = "__manage__";

  let dialogOpen = $state(false);
  let selected = $state<string>(NONE);
  let missingScript = $state<string | null>(null);

  /** 激活脚本导出 authHeader 才有认证条目（Owner #3 联动）。 */
  const activeHookEntry = $derived(
    hooksScript !== "" && hooksPanel.scripts.some((s) => s.name === hooksScript && s.fns.includes("authHeader"))
      ? hooksScript
      : null,
  );

  function encode(sel: AuthSel): string {
    switch (sel.kind) {
      case "none":
        return NONE;
      case "secret":
        return `secret:${sel.name}`;
      case "hook":
        return `hook:${sel.script}`;
      case "keep":
        return KEEP;
    }
  }

  // 外部 value → 显示值（表单打开/向导预选/重置/hook 联动切换）
  $effect(() => {
    selected = encode(value);
    if (value.kind !== "none") missingScript = null;
  });

  // 守卫：选中物被删 → 回落无（名单加载后判定）；hook 脚本被禁用/删除 →
  // 激活联动消失时同样回落（缺失提示由 missingScript 承载）。
  $effect(() => {
    if (secrets.loaded && value.kind === "secret" && !secrets.names.includes(value.name)) {
      missingScript = null;
      onchange?.({ kind: "none" });
    }
    if (hooksPanel.loaded && value.kind === "hook" && activeHookEntry !== value.script) {
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
    if (next === KEEP) {
      onchange?.(value.kind === "keep" ? value : { kind: "none" });
      return;
    }
    if (next === NONE) {
      onchange?.({ kind: "none" });
      return;
    }
    if (next.startsWith("secret:")) {
      onchange?.({ kind: "secret", name: next.slice("secret:".length) });
      return;
    }
    if (next.startsWith("hook:")) {
      onchange?.({ kind: "hook", script: next.slice("hook:".length), bearer: true });
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
    {#if activeHookEntry !== null}
      <optgroup label={t("f.authpicker.group.hooks")}>
        <option value={`hook:${activeHookEntry}`}>{activeHookEntry} (authHeader)</option>
      </optgroup>
    {/if}
    {#if value.kind === "keep"}
      <option value={KEEP}>
        {value.label !== "" && value.label !== "custom" ? `${value.label} · ${t("f.authpicker.keep")}` : t("f.authpicker.keep")}
      </option>
    {/if}
    <option value={MANAGE}>{t("f.authpicker.manage")}</option>
  </NativeSelect>

  {#if value.kind === "secret"}
    <p class="text-[11px] leading-relaxed text-muted-foreground">
      {t("f.secretpicker.note")}
      <code class="font-mono">&#9679;</code>
    </p>
  {:else if value.kind === "hook"}
    <!-- Owner 2026-09-13 #7/#8：Bearer 前缀用 Toggle；绑定详情等解释文字删除 -->
    <label class="flex items-center gap-2 text-[11px] text-muted-foreground">
      <Toggle
        checked={value.bearer}
        onchange={(event) => {
          if (value.kind !== "hook") return;
          onchange?.({ ...value, bearer: event.currentTarget.checked });
        }}
      />
      {t("f.authpicker.bearer")}
    </label>
  {:else if value.kind === "keep"}
    <p class="text-[11px] leading-relaxed text-muted-foreground">{t("f.authpicker.keepNote")}</p>
  {/if}
  {#if missingScript !== null}
    <p class="text-[11px] leading-relaxed text-primary">
      {t("f.authpicker.missing", { script: missingScript })}
    </p>
  {/if}
</div>

<SecretsDialog bind:open={dialogOpen} onpick={(name) => onchange?.({ kind: "secret", name })} />
