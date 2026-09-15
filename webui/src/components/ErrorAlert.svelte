<!-- 内联错误提示：六码 code + 引擎英文消息（表单错误就地渲染的统一面）。
     INVALID_STATE（legacy 门禁拒绝——hooks-lifecycle 7.4）渲染为 warning
     风格的失效引导（不崩表单；移除旧服务后恢复）。用户面文案英文 ASCII。 -->
<script lang="ts">
  import Alert from "$lib/ui/alert";
  import { t } from "$lib/i18n.svelte.ts";

  let { error }: { error: { code: string; message: string } | null } = $props();
</script>

{#if error !== null}
  {#if error.code === "INVALID_STATE"}
    <Alert variant="tonal" class="jx-hue-warning" title={t("legacy.errTitle")}>
      <p>{t("legacy.errBody")}</p>
      <p class="break-words font-mono text-[11px]">{error.message}</p>
    </Alert>
  {:else}
    <Alert variant="tonal" class="jx-hue-error" assertive title={`Error ${error.code}`}>
      {error.message}
    </Alert>
  {/if}
{/if}
