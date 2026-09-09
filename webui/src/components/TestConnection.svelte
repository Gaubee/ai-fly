<!-- 连通测试（M3 6.3）：test 按钮 + 模型下拉（models.dev 清单，价格升序、
     下拉项带 $/Mtok）+ 内联结果（ok · 耗时 · 模型 / 失败原因）。loading
     防重入；失败仅引导检查密钥与网络，不中断向导。provider-local、不落盘。 -->
<script lang="ts">
  import { onMount } from "svelte";
  import PressButton from "$lib/ui/press-button";
  import Select from "$lib/ui/select";
  import Skeleton from "$lib/ui/skeleton";
  import { toRpcError } from "$lib/rpc-client";
  import { call } from "../stores/rpc.svelte.ts";
  import type { ApiForm } from "$shared/rpc-contract.ts";

  interface Props {
    upstream: string;
    apiForm?: ApiForm;
    secretName?: string;
    presetId?: string;
  }
  let { upstream, apiForm, secretName, presetId }: Props = $props();

  /** 契约 models 行（presets.models 输出元素的本地形状）。 */
  interface ModelRow {
    id: string;
    name?: string;
    pricePerMTok?: number;
    priced: boolean;
    chat: boolean;
  }

  let models: ModelRow[] = $state([]);
  let modelsError = $state<string | null>(null);
  let modelsLoading = $state(false);
  /** 默认取首个 chat && priced（清单已按价格升序 chat 优先排序）。 */
  let model = $state<string | undefined>(undefined);
  let busy = $state(false);
  let result = $state<
    { ok: boolean; latencyMs: number; model: string; error?: string } | null
  >(null);

  onMount(() => {
    if (presetId === undefined) return;
    modelsLoading = true;
    const target = presetId;
    call((c) => c.presets.models({ presetId: target }))
      .then((response) => {
        modelsError = response.error ?? null;
        models = response.models;
        if (response.error === undefined && response.models.length > 0) {
          const first =
            response.models.find((candidate) => candidate.chat && candidate.priced) ??
            response.models.find((candidate) => candidate.chat) ??
            response.models[0];
          model = first?.id;
        }
      })
      .catch((error: unknown) => {
        modelsError = toRpcError(error).message;
      })
      .finally(() => {
        modelsLoading = false;
      });
  });

  /** 价格展示：截断浮点尾差（0.07000000001 → 0.07），去尾零。 */
  function formatPrice(price: number): string {
    return String(Number(price.toFixed(4)));
  }

  const modelOptions = $derived(
    models.map((row) => ({
      value: row.id,
      label:
        row.priced && row.pricePerMTok !== undefined
          ? `${row.id} ($${formatPrice(row.pricePerMTok)}/Mtok)`
          : row.id,
    })),
  );

  async function runTest(): Promise<void> {
    if (busy || upstream.trim() === "") return;
    busy = true;
    result = null;
    try {
      result = await call((c) =>
        c.provider.services.test({
          upstream: upstream.trim(),
          ...(apiForm !== undefined ? { apiForm } : {}),
          ...(secretName !== undefined ? { secretName } : {}),
          ...(model !== undefined ? { model } : {}),
        }),
      );
    } catch (error) {
      result = { ok: false, latencyMs: 0, model: model ?? "", error: toRpcError(error).message };
    } finally {
      busy = false;
    }
  }
</script>

<div class="flex flex-col gap-1.5">
  <span class="font-nav text-[11px] uppercase tracking-[0.1em] text-muted-foreground">
    connectivity
  </span>
  <div class="flex flex-wrap items-center gap-2">
    <PressButton
      variant="outline"
      loading={busy}
      class={upstream.trim() === "" ? "pointer-events-none opacity-50" : undefined}
      onclick={() => void runTest()}
    >test</PressButton>
    {#if presetId !== undefined && modelsLoading}
      <Skeleton class="h-8 w-44" />
    {:else if presetId !== undefined && modelsError === null && modelOptions.length > 0}
      <div class="w-64">
        <Select options={modelOptions} placeholder="model" bind:value={model} />
      </div>
    {/if}
  </div>
  {#if result !== null}
    {#if result.ok}
      <p class="font-mono text-[11px] text-[color:var(--success)]">
        ok · {result.latencyMs}ms · {result.model}
      </p>
    {:else}
      <p class="text-[11px] leading-relaxed text-[color:var(--warning)]">
        failed{result.error !== undefined ? `: ${result.error}` : ""} - check the
        api key and network, then retry.
      </p>
    {/if}
  {/if}
</div>
