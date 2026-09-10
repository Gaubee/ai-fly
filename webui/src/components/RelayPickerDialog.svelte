<!-- 中继服务器选择器（Owner 裁决 2026-09-11/12）：relay & limits 的快速
     配置 Dialog——两选：SDK 默认（n0 公网）/ 自定义清单（http(s)://，≤8 行；
     自托管 opendweb server 部署在独立机器，把它的 relay URL 填这里即可）。
     保存即 system.settings.set relayUrls；fabric 侧生效需 app 重启（引擎
     启动时读 settings——footer 明示，不静默）。 -->
<script lang="ts">
  import Dialog from "$lib/ui/dialog";
  import { CardFooter } from "$lib/ui/card";
  import PressButton from "$lib/ui/press-button";
  import Separator from "$lib/ui/separator";
  import { untrack } from "svelte";
  import { toRpcError, type RpcError } from "$lib/rpc-client";
  import { app } from "../stores/app.svelte.ts";
  import { toastRpcError, toastSuccess } from "../stores/toast.svelte.ts";
  import { saveRelayChoice } from "../stores/advanced.svelte.ts";

  interface Props {
    /** bindable 开合（× / esc 关闭写回）。 */
    open?: boolean;
    /** 保存成功后通知（父级就地刷新摘要）。 */
    onsave?: () => void;
  }
  let { open = $bindable(false), onsave }: Props = $props();

  type Mode = "sdk" | "custom";

  let mode = $state<Mode>("sdk");
  let customText = $state("");
  let busy = $state(false);
  let error = $state<RpcError | null>(null);

  // 打开上升沿初始化一次：untrack 读初值——settings 异步到达不再重跑本段，
  // 避免把用户已选的 mode 打回推断值
  let wasOpen = false;
  $effect(() => {
    const nowOpen = open;
    if (nowOpen && !wasOpen) {
      error = null;
      untrack(() => {
        const urls = app.settings?.relayUrls ?? null;
        if (urls === null) {
          mode = "sdk";
        } else {
          mode = "custom";
          customText = urls.join("\n");
        }
      });
    }
    wasOpen = nowOpen;
  });

  const customLines = $derived(
    customText
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line !== ""),
  );
  const customProblem = $derived.by(() => {
    if (mode !== "custom") return null;
    if (customLines.length === 0) return "at least one relay URL";
    if (customLines.length > 8) return "at most 8 relay URLs";
    if (customLines.some((line) => !/^https?:\/\//.test(line))) {
      return "relay URLs must start with http:// or https://";
    }
    return null;
  });

  async function save(): Promise<void> {
    if (busy || customProblem !== null) return;
    busy = true;
    error = null;
    try {
      const urls = mode === "sdk" ? null : customLines;
      await saveRelayChoice(urls);
      toastSuccess(
        "Relay server saved",
        mode === "sdk" ? "using SDK defaults" : `${customLines.length} entr(y|ies)`,
      );
      onsave?.();
      open = false;
    } catch (e) {
      error = toRpcError(e);
      toastRpcError(error);
    } finally {
      busy = false;
    }
  }
</script>

<Dialog bind:open title="relay server">
  <div class="flex flex-col gap-3 p-3">
    <p class="text-xs leading-relaxed text-muted-foreground">
      where both sides meet when a direct connection is not possible. every share
      link embeds this choice. self-hosted? deploy the opendweb server on its own
      machine and paste its relay URL under custom.
    </p>

    <div class="flex flex-col gap-2">
      <label class="flex cursor-pointer items-start gap-2 border border-border p-2.5 {mode === 'sdk' ? 'bg-primary/10' : ''}">
        <input type="radio" name="relay-mode" value="sdk" bind:group={mode} class="mt-0.5" />
        <span class="flex flex-col gap-0.5">
          <span class="text-xs font-medium">SDK defaults</span>
          <span class="text-[11px] text-muted-foreground">n0 public relays (no setup, shared infra)</span>
        </span>
      </label>

      <label class="flex cursor-pointer items-start gap-2 border border-border p-2.5 {mode === 'custom' ? 'bg-primary/10' : ''}">
        <input type="radio" name="relay-mode" value="custom" bind:group={mode} class="mt-0.5" />
        <span class="flex flex-1 flex-col gap-1.5">
          <span class="text-xs font-medium">custom</span>
          {#if mode === "custom"}
            <textarea
              class="min-h-20 border border-border bg-transparent p-2 font-mono text-xs focus:border-primary focus:outline-none"
              placeholder="https://relay.example.com"
              spellcheck="false"
              bind:value={customText}
              disabled={busy}
            ></textarea>
            <span class="text-[11px] text-muted-foreground">one http(s):// URL per line, at most 8.</span>
          {:else}
            <span class="text-[11px] text-muted-foreground">self-managed relay entries</span>
          {/if}
        </span>
      </label>
    </div>

    {#if customProblem !== null}
      <p class="text-[11px] leading-relaxed text-[color:var(--warning)]">{customProblem}</p>
    {/if}
    {#if error !== null}
      <p class="text-[11px] leading-relaxed text-[color:var(--warning)]">{error.code}: {error.message}</p>
    {/if}

    <Separator />
    <p class="text-[11px] leading-relaxed text-muted-foreground">
      saved now; the running fabric picks it up on the next app launch.
    </p>
  </div>
  {#snippet footer()}
    <CardFooter label="relay server actions">
      <PressButton variant="ghost" onclick={() => (open = false)}>cancel</PressButton>
      <PressButton
        variant="fill"
        loading={busy}
        class={customProblem !== null ? "pointer-events-none opacity-50" : undefined}
        onclick={() => void save()}
      >save</PressButton>
    </CardFooter>
  {/snippet}
</Dialog>
