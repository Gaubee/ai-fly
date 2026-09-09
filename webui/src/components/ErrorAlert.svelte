<!-- 内联错误提示：六码 code + 引擎英文消息（表单错误就地渲染的统一面）。
     用户面文案英文 ASCII。 -->
<script lang="ts">
  import Alert from "$lib/ui/alert";

  let { error }: { error: { code: string; message: string } | null } = $props();
</script>

{#if error !== null}
  <Alert variant="tonal" class="jx-hue-error" assertive title={`Error ${error.code}`}>
    {error.message}
  </Alert>
{/if}
