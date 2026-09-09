<!-- 复制字段：等宽只读值 + 一键复制（链接/密钥展示共用）。 -->
<script lang="ts">
  import PressButton from "$lib/ui/press-button";
  import Icon from "$lib/ui/icon";

  let { value, label }: { value: string; label?: string } = $props();

  let copied = $state(false);
  let timer: ReturnType<typeof setTimeout> | undefined;

  async function copy(): Promise<void> {
    try {
      await navigator.clipboard.writeText(value);
      copied = true;
      if (timer !== undefined) clearTimeout(timer);
      timer = setTimeout(() => (copied = false), 1500);
    } catch {
      // 剪贴板被拒绝（非安全上下文等）：退化为全选辅助
    }
  }
</script>

<div class="flex items-center gap-2">
  <div class="flex min-w-0 flex-1 items-center gap-2 border border-border bg-muted/40 px-3 py-2">
    {#if label}
      <span class="flex-none font-nav text-[11px] uppercase tracking-[0.1em] text-muted-foreground">{label}</span>
    {/if}
    <code class="min-w-0 flex-1 truncate font-mono text-xs" title={value}>{value}</code>
  </div>
  <PressButton variant="outline" onclick={() => void copy()} ariaLabel="copy to clipboard">
    {#if copied}
      <span class="inline-flex items-center gap-1.5"><Icon name="check" size={13} /> copied</span>
    {:else}
      <span class="inline-flex items-center gap-1.5"><Icon name="copy" size={13} /> copy</span>
    {/if}
  </PressButton>
</div>
