<!-- 密钥选择器（M3 6.2）：向导 ② 的凭据字段（本地运行时/自定义亦可选可不选）。
     选项 = 密钥库名单 + none (no auth header) + manage secrets…（就地打开
     密钥面板，关闭后刷新名单并保持选择）。选中即 onchange(name)，未选
     onchange(undefined)。$env 语法不出现在本组件任何呈现中。 -->
<script lang="ts">
  import { onMount } from "svelte";
  import NativeSelect from "$lib/ui/native-select";
  import SecretsDialog from "./SecretsDialog.svelte";
  import { secrets, refreshSecrets } from "../stores/secrets.svelte.ts";
  import { t } from "$lib/i18n.svelte.ts";

  interface Props {
    /** 当前选中密钥名（undefined = 不注入 authorization）。 */
    value?: string;
    onchange?: (name: string | undefined) => void;
  }
  let { value = undefined, onchange }: Props = $props();

  const NONE = "";
  const MANAGE = "__manage__";

  let dialogOpen = $state(false);
  let selected = $state<string>(NONE);

  // 外部 value → 显示值（初始进入 ② / 向导重置 / 回退后再进）
  $effect(() => {
    selected = value ?? NONE;
  });

  // 选中项在面板里被删 → 清空选择（仅在名单已加载后判定，避免首轮空名单误清）
  $effect(() => {
    if (secrets.loaded && value !== undefined && !secrets.names.includes(value)) {
      onchange?.(undefined);
    }
  });

  // 面板关闭 → 刷新名单并保持选择（外部变更也对账一次）
  let wasOpen = false;
  $effect(() => {
    const nowOpen = dialogOpen;
    if (wasOpen && !nowOpen) void refreshSecrets();
    wasOpen = nowOpen;
  });

  onMount(() => {
    void refreshSecrets();
  });

  function handleChange(event: Event & { currentTarget: EventTarget & HTMLSelectElement }): void {
    const next = event.currentTarget.value;
    if (next === MANAGE) {
      dialogOpen = true;
      // manage 只是入口，选择停留回原值（bind 已写入哨兵，写回恢复显示）
      selected = value ?? NONE;
      return;
    }
    onchange?.(next === NONE ? undefined : next);
  }
</script>

<div class="flex flex-col gap-1.5">
  <!-- bind：用户选择先写 selected，onchange 再分流（manage 哨兵写回原值恢复显示） -->
  <NativeSelect label={t("f.secretpicker.label")} bind:value={selected} onchange={handleChange}>
    <option value={NONE}>{t("f.secretpicker.none")}</option>
    {#each secrets.names as secretName (secretName)}
      <option value={secretName}>{secretName}</option>
    {/each}
    <option value={MANAGE}>{t("f.secretpicker.manage")}</option>
  </NativeSelect>
  <p class="text-[11px] leading-relaxed text-muted-foreground">
    {t("f.secretpicker.note")}
    <code class="font-mono">&#9679;</code>
  </p>
</div>

<SecretsDialog bind:open={dialogOpen} onpick={(name) => onchange?.(name)} />
