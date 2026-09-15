<!-- 连通测试（M3 6.3 + M3-acceptance ④）：test 按钮 + 模型下拉 + 内联结果。
     模型清单：preset 路径 c.presets.models({ presetId })（models.dev 缓存，
     价格升序 chat 优先）；custom 路径 upstream 成形后探测一次
     c.presets.models({ upstream, secretName })（{upstream}/models 实时探测）；
     探测失败 → model 手填 Input（默认空 = 不传 model，服务端自选）。
     认证注入走 auth 槽草稿（hooks-lifecycle 5.2：services.test 输入）。
     结果：成功 ok · 耗时 · 模型 · via {modelSource}；失败给出 error 全文
     （含上游正文摘录）+ 请求详情 POST {url}（长 URL 中间省略）。loading
     防重入；provider-local、不落盘。 -->
<script lang="ts">
  import PressButton from "$lib/ui/press-button";
  import Select from "$lib/ui/select";
  import Input from "$lib/ui/input";
  import Skeleton from "$lib/ui/skeleton";
  import { toRpcError, type RpcClient } from "$lib/rpc-client";
  import { call } from "../stores/rpc.svelte.ts";
import { t } from "$lib/i18n.svelte.ts";
  import type { AuthSlot } from "$lib/lifecycle.ts";
  import type { ApiForm } from "$shared/rpc-contract.ts";

  interface Props {
    upstream: string;
    apiForm?: ApiForm;
    /** auth 槽草稿（hooks-lifecycle 5.2：services.test 输入——{secret}|{script}|{literal} + bearer）。 */
    auth?: AuthSlot;
    /** 模型探测的密钥库引用（presets.models 输入仍为 secretName）。 */
    secretName?: string;
    presetId?: string;
  }
  let { upstream, apiForm, auth, secretName, presetId }: Props = $props();

  /** 契约 test 输出（request/modelSource 为 M3-acceptance ④ 新增，单源推导）。 */
  type TestOutput = Awaited<ReturnType<RpcClient["provider"]["services"]["test"]>>;

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
  /** 下拉选中（默认取首个 chat && priced——清单已按价格升序 chat 优先排序）。 */
  let model = $state<string | undefined>(undefined);
  /** 探测失败时的手填 model（默认空 = 不传，服务端探测自选）。 */
  let manualModel = $state("");
  let busy = $state(false);
  let result = $state<TestOutput | null>(null);

  // 模型清单拉取：preset 路径挂载即拉；custom 路径等 upstream 成形后探测
  // 一次（向导里 upstream 是 ② 现填的；后续变更不重复探测，避免按键级请求）。
  let modelsProbed = false;
  $effect(() => {
    if (presetId !== undefined) {
      if (!modelsProbed) {
        modelsProbed = true;
        void loadModels();
      }
      return;
    }
    const target = upstream.trim();
    if (modelsProbed || target === "" || !/^https?:\/\//.test(target)) return;
    modelsProbed = true;
    void loadModels();
  });

  async function loadModels(): Promise<void> {
    modelsLoading = true;
    try {
      const response = await call((c) =>
        presetId !== undefined
          ? c.presets.models({ presetId })
          : c.presets.models({
              upstream: upstream.trim(),
              ...(secretName !== undefined ? { secretName } : {}),
            }),
      );
      modelsError = response.error ?? null;
      models = response.models;
      if (response.error === undefined && response.models.length > 0) {
        const first =
          response.models.find((candidate) => candidate.chat && candidate.priced) ??
          response.models.find((candidate) => candidate.chat) ??
          response.models[0];
        model = first?.id;
      }
    } catch (error) {
      modelsError = toRpcError(error).message;
    } finally {
      modelsLoading = false;
    }
  }

  /** 价格展示：截断浮点尾差（0.07000000001 → 0.07），去尾零。 */
  function formatPrice(price: number): string {
    return String(Number(price.toFixed(4)));
  }

  /** 长 URL 展示：≤64 原样；超长保留首尾、中间省略。 */
  function shortenUrl(url: string, max = 64): string {
    if (url.length <= max) return url;
    const head = url.slice(0, Math.ceil((max - 1) / 2));
    const tail = url.slice(-Math.floor((max - 1) / 2));
    return `${head}...${tail}`;
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

  /** 下拉选中优先；无下拉（探测失败）时取手填（空 = 不传，服务端探测）。 */
  const chosenModel = $derived(
    model ?? (manualModel.trim() !== "" ? manualModel.trim() : undefined),
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
          ...(auth !== undefined ? { auth } : {}),
          ...(chosenModel !== undefined ? { model: chosenModel } : {}),
        }),
      );
    } catch (error) {
      result = { ok: false, latencyMs: 0, model: chosenModel ?? "", error: toRpcError(error).message };
    } finally {
      busy = false;
    }
  }
</script>

<div class="flex flex-col gap-1.5">
  <span class="font-nav text-[11px] uppercase tracking-[0.1em] text-muted-foreground">
    {t("tc.connectivity")}
  </span>
  <div class="flex flex-wrap items-center gap-2">
    <PressButton
      variant="outline"
      loading={busy}
      class={upstream.trim() === "" ? "pointer-events-none opacity-50" : undefined}
      onclick={() => void runTest()}
    >{t("common.test")}</PressButton>
    {#if modelsLoading}
      <Skeleton class="h-8 w-44" />
    {:else if modelsError === null && modelOptions.length > 0}
      <div class="w-64">
        <Select options={modelOptions} placeholder="model" bind:value={model} />
      </div>
    {:else if presetId === undefined}
      <!-- 探测失败（custom 路径）：model 手填，默认空 = 服务端探测自选 -->
      <div class="w-64">
        <Input placeholder="model id" bind:value={manualModel} />
      </div>
    {/if}
  </div>
  {#if result !== null}
    {#if result.ok}
      <p class="font-mono text-[11px] text-[color:var(--success)]">
        ok · {result.latencyMs}ms · {result.model}{result.modelSource !== undefined ? ` · via ${result.modelSource}` : ""}
      </p>
    {:else}
      <p class="break-words text-[11px] leading-relaxed text-[color:var(--warning)]">
        failed{result.error !== undefined ? `: ${result.error}` : ""} - check the
        api key and network, then retry.
      </p>
      {#if result.request !== undefined}
        <p class="break-all font-mono text-[11px] text-muted-foreground">
          POST {shortenUrl(result.request.url)}
        </p>
      {/if}
    {/if}
  {/if}
</div>
