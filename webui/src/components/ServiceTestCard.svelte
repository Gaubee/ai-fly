<!-- 按标准路由的 test 面板（Owner 裁决 2026-09-11：connect ③ 与 Advanced
     services 行内共用同形）：协议选择（openai/openai responses/anthropic，
     可变表达）+ 端点选择（中性路由表达 `/v1 → upstream/v1/*`，仅 prefix 模式
     规则有稳定端点面；legacy 服务退根透传）+ 单轮输入框（默认 hi）+ 结果面板
     （ok/failed + latency + HTTP + POST url + bodyExcerpt 滚动区）。
     协议→端点联动：切协议时当前端点不承载该标准则跳到首个承载端点（承载
     保留用户手选）。发送载荷经 onsend 上抛——调用方决定走哪条链路
     （connect = 本地网关完整 wire；Advanced = provider 直打 upstream）。 -->
<script lang="ts">
  import PressButton from "$lib/ui/press-button";
  import Input from "$lib/ui/input";
  import NativeSelect from "$lib/ui/native-select";
  import { slide } from "svelte/transition";
  import { untrack } from "svelte";
  import { PROTOCOL_OPTIONS, type ServiceRouteView, type RouteTestOutput } from "../stores/connect-wizard.svelte.ts";
  import type { RouteForm } from "$shared/rpc-contract.ts";

  interface Props {
    /** 服务的声明路由（空 = legacy 透传，端点退根）。 */
    routes: ServiceRouteView[];
    /** 服务 upstream（端点标签转发目标注记；null = 不显示注记）。 */
    upstream: string | null;
    busy: boolean;
    result: RouteTestOutput | null;
    /** 发送载荷上抛（调用方持有传输链路与结果状态）。 */
    onsend: (payload: { form: RouteForm; content: string; localPrefix: string | undefined }) => void;
    /** 禁发（如服务未选中）。 */
    disabled?: boolean;
  }
  let { routes, upstream, busy, result, onsend, disabled = false }: Props = $props();

  let protocol = $state<RouteForm>("openai-chat");
  let endpoint = $state<string | null>(null); // null = 尚未初始化（首帧派生）
  let prompt = $state("hi");

  /** prefix 模式规则（稳定端点面）。 */
  const prefixRoutes = $derived(
    routes.filter((r) => r.mode !== "pattern" && (r.localPrefix ?? "") !== ""),
  );
  $effect(() => {
    // 服务切换（routes 引用变化）→ 端点重置到当前协议首个承载端点
    routes;
    untrack(() => {
      endpoint = firstEndpointOf(protocol);
    });
  });

  function firstEndpointOf(form: RouteForm): string {
    const serving = prefixRoutes.filter((r) => r.forms.includes(form));
    return (serving[0] ?? prefixRoutes[0])?.localPrefix ?? "";
  }

  /** 切协议：当前端点不承载该标准时跳到首个承载端点（承载保留手选）。 */
  function setProtocol(form: RouteForm): void {
    protocol = form;
    const currentServes =
      prefixRoutes.find((r) => r.localPrefix === endpoint)?.forms.includes(form) ?? false;
    if (!currentServes) endpoint = firstEndpointOf(form);
  }

  const endpointOptions = $derived.by(() => {
    const options = prefixRoutes.map((route) => {
      const local = route.localPrefix!;
      const target =
        upstream === null
          ? ""
          : ` → ${upstream.replace(/\/+$/, "")}${route.upstreamPrefix ?? ""}/*`;
      return { value: local, label: `${local}${target}` };
    });
    if (options.length === 0) options.push({ value: "", label: "root (passthrough)" });
    return options;
  });

  function handleProtocolChange(event: Event & { currentTarget: EventTarget & HTMLSelectElement }): void {
    setProtocol(event.currentTarget.value as RouteForm);
  }
  function handleEndpointChange(event: Event & { currentTarget: EventTarget & HTMLSelectElement }): void {
    endpoint = event.currentTarget.value;
  }
  function handlePromptChange(event: Event & { currentTarget: EventTarget & HTMLInputElement }): void {
    prompt = event.currentTarget.value;
  }
  function handlePromptKeydown(event: KeyboardEvent): void {
    if (event.key === "Enter") {
      event.preventDefault();
      send();
    }
  }
  function send(): void {
    if (busy || disabled) return;
    const content = prompt.trim() !== "" ? prompt.trim() : "hi";
    onsend({
      form: protocol,
      content,
      localPrefix: endpoint !== null && endpoint !== "" ? endpoint : undefined,
    });
  }

  /** 长 URL 展示：≤96 原样；超长保留首尾、中间省略。 */
  function shortenUrl(url: string, max = 96): string {
    if (url.length <= max) return url;
    const head = url.slice(0, Math.ceil((max - 1) / 2));
    const tail = url.slice(-Math.floor((max - 1) / 2));
    return `${head}...${tail}`;
  }

  /** 失败摘要：error 与 bodyExcerpt 择短展示。 */
  function failureExcerpt(r: RouteTestOutput): string | null {
    const candidates = [r.error, r.bodyExcerpt].filter(
      (value): value is string => value !== undefined && value !== "",
    );
    if (candidates.length === 0) return null;
    return candidates.reduce((shortest, current) =>
      current.length < shortest.length ? current : shortest,
    );
  }
</script>

<div class="flex flex-col gap-3">
  <div class="grid gap-3 sm:grid-cols-2">
    <NativeSelect label="protocol" value={protocol} onchange={handleProtocolChange}>
      {#each PROTOCOL_OPTIONS as option (option.value)}
        <option value={option.value}>{option.label}</option>
      {/each}
    </NativeSelect>
    <NativeSelect label="endpoint" value={endpoint ?? ""} onchange={handleEndpointChange}>
      {#each endpointOptions as option (option.value)}
        <option value={option.value}>{option.label}</option>
      {/each}
    </NativeSelect>
  </div>

  <!-- 单轮聊天面板：一个输入框（默认 hi）+ 发送 -->
  <div class="flex flex-col gap-2 border border-border/70 p-3">
    <span class="font-nav text-[11px] uppercase tracking-[0.1em] text-muted-foreground">
      send a request
    </span>
    <div class="flex flex-wrap items-center gap-2">
      <div class="min-w-48 flex-1">
        <Input placeholder="hi" value={prompt} onchange={handlePromptChange} onkeydown={handlePromptKeydown} />
      </div>
      <PressButton
        variant="fill"
        loading={busy}
        class={disabled ? "pointer-events-none opacity-50" : undefined}
        onclick={send}
      >send</PressButton>
    </div>
    <p class="text-[11px] text-muted-foreground">
      single-turn only - one request, one response. the model is picked automatically.
    </p>
  </div>

  <!-- 结果面板 -->
  {#if result !== null}
    <div class="flex flex-col gap-1.5 border border-border/70 p-3" transition:slide={{ duration: 150 }}>
      <span class="font-nav text-[11px] uppercase tracking-[0.1em] text-muted-foreground">
        response
      </span>
      {#if result.ok}
        <p class="font-mono text-[11px] text-[color:var(--success)]">
          ok {result.latencyMs}ms{result.httpStatus !== undefined ? ` (HTTP ${result.httpStatus})` : ""}
        </p>
      {:else}
        <p class="text-[11px] leading-relaxed text-[color:var(--warning)]">
          failed{result.httpStatus !== undefined ? ` (HTTP ${result.httpStatus})` : ""}{failureExcerpt(result) !== null ? `: ${failureExcerpt(result)}` : ""}
        </p>
      {/if}
      {#if result.request.url !== ""}
        <p class="break-all font-mono text-[11px] text-muted-foreground">
          POST {shortenUrl(result.request.url)}
        </p>
      {/if}
      {#if result.bodyExcerpt !== undefined && result.bodyExcerpt !== ""}
        <pre class="max-h-64 overflow-auto whitespace-pre-wrap break-all border border-border bg-muted/40 p-3 text-xs">{result.bodyExcerpt}</pre>
      {/if}
    </div>
  {/if}
</div>
