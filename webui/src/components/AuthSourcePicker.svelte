<!--
  认证头取值选择器（Owner 裁决 2026-09-13 + PM 方案 B）：一个 NativeSelect
  承载"这个服务的请求带什么认证头"——无 / 密钥族 / hook 脚本族（导出
  authHeader 的用户与 codex 型内置脚本）/ 管理密钥…；keep 哨兵仅在回显
  CLI/预配置时出现（透传不改写）。选中 hook 条目 → 附属区显示绑定详情
  `authorization ← script.authHeader()` + Bearer 前缀开关 + hooks 页签
  指路。互斥由单选结构保证（密钥与 hook 不可能同时生效）。状态模型与
  组装规则见 $lib/auth-source.ts（高级页与分享向导 ② 共用）。
-->
<script lang="ts">
  import { onMount } from "svelte";
  import NativeSelect from "$lib/ui/native-select";
  import SecretsDialog from "./SecretsDialog.svelte";
  import { secrets, refreshSecrets } from "../stores/secrets.svelte.ts";
  import { hooksPanel, loadHooks } from "../stores/advanced.svelte.ts";
  import { hookAuthOptions, type AuthSel } from "$lib/auth-source.ts";
  import { t } from "$lib/i18n.svelte.ts";

  interface Props {
    /** 当前选中来源（none/secret/hook/keep，见 auth-source.ts）。 */
    value: AuthSel;
    onchange?: (sel: AuthSel) => void;
  }
  let { value, onchange }: Props = $props();

  const NONE = "";
  const KEEP = "__keep__";
  const MANAGE = "__manage__";

  let dialogOpen = $state(false);
  let selected = $state<string>(NONE);
  /** keep 态选单被改后放弃 keep 的原文（改选即丢弃，不提供回滚）。 */
  let missingScript = $state<string | null>(null);

  const hookOptions = $derived(hookAuthOptions(hooksPanel.scripts));

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

  // 外部 value → 显示值（表单打开/向导预选/重置）
  $effect(() => {
    selected = encode(value);
    if (value.kind !== "none") missingScript = null;
  });

  // 守卫：选中物在名单里被删 → 回落无（名单加载后判定，避免首轮误清）。
  // hook 脚本丢失额外置 missingScript 显示说明（比密钥删除更隐蔽）。
  $effect(() => {
    if (secrets.loaded && value.kind === "secret" && !secrets.names.includes(value.name)) {
      missingScript = null;
      onchange?.({ kind: "none" });
    }
    if (hooksPanel.loaded && value.kind === "hook" && !hookOptions.some((o) => o.script === value.script)) {
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
      // 手选默认加 Bearer 前缀（密钥族/上游惯例；改选后可在详情行关闭）
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
    {#if hookOptions.length > 0}
      <optgroup label={t("f.authpicker.group.hooks")}>
        {#each hookOptions as { script } (script)}
          <option value={`hook:${script}`}>{script} (authHeader)</option>
        {/each}
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
    <div class="flex flex-col gap-1">
      <p class="text-[11px] font-mono text-muted-foreground">
        authorization ← {value.script}.authHeader()
      </p>
      <label class="flex items-center gap-1.5 text-[11px] text-muted-foreground">
        <input
          type="checkbox"
          class="size-3.5 accent-[var(--primary)]"
          checked={value.bearer}
          onchange={(event) => {
            if (value.kind !== "hook") return;
            onchange?.({ ...value, bearer: event.currentTarget.checked });
          }}
        />
        {t("f.authpicker.bearer")}
      </label>
      <p class="text-[11px] leading-relaxed text-muted-foreground">
        {t("f.authpicker.hookDetail", { script: value.script })}
      </p>
      <p class="text-[11px] leading-relaxed text-muted-foreground">{t("f.authpicker.hookManage")}</p>
    </div>
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
