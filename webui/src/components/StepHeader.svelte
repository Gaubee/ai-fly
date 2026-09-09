<!-- 向导三步头（两向导共用）：步骤号 + 标题 + 完成态打勾。 -->
<script lang="ts">
  import Icon from "$lib/ui/icon";

  let {
    step,
    titles,
    /** 已锁定（分享成功后不可回退）：全部步骤显示完成态。 */
    locked = false,
  }: { step: number; titles: readonly [string, string, string]; locked?: boolean } = $props();
</script>

<ol class="flex flex-wrap items-center gap-x-2 gap-y-1 font-nav text-[11px] uppercase tracking-[0.1em]">
  {#each titles as title, index (title)}
    {@const n = index + 1}
    {@const done = locked || n < step}
    {@const active = !locked && n === step}
    <li class="flex items-center gap-1.5">
      <span
        class="flex size-5 items-center justify-center border text-[10px]
          {active ? 'border-primary bg-primary/15 text-primary' : done ? 'border-transparent bg-primary text-primary-foreground' : 'border-border text-muted-foreground'}"
        aria-hidden="true"
      >
        {#if done}<Icon name="check" size={11} />{:else}{n}{/if}
      </span>
      <span class={active ? "text-foreground" : "text-muted-foreground"}>{title}</span>
      {#if n < 3}
        <span class="mx-1 h-px w-6 bg-border" aria-hidden="true"></span>
      {/if}
    </li>
  {/each}
</ol>
