<!--
  分组 keys 管理面板（Owner 裁决 2026-09-13 #4：高级页组卡与分享向导③
  共用同一组件、同一数据源 app.keys——两处不再各写一份）。

  结构：key 清单（名 + 短 id + 分享（开 Dialog）+ 移除二次确认）+
  key-name 输入 + 新增。分享主体 = Group with key：Dialog 内选过期
  时间（TTL）→ 现铸 invite + 复用 key 原文 → 生成完整 aifly1. 链接，
  就地复制（CopyField）。旧 key（无原文）仅标注，不可分享。
-->
<script lang="ts">
  import Dialog from "$lib/ui/dialog";
  import Card, { CardFooter } from "$lib/ui/card";
  import Select from "$lib/ui/select";
  import PressButton from "$lib/ui/press-button";
  import Alert from "$lib/ui/alert";
  import CopyField from "./CopyField.svelte";
  import ErrorAlert from "./ErrorAlert.svelte";
  import { app } from "../stores/app.svelte.ts";
  import { keyIssue, issueKey, keyRevoke, revokeKey } from "../stores/advanced.svelte.ts";
  import { TTL_OPTIONS } from "../stores/share-wizard.svelte.ts";
  import { toRpcError, type RpcError } from "$lib/rpc-client";
  import { call } from "../stores/rpc.svelte.ts";
  import { t } from "$lib/i18n.svelte.ts";

  let { group }: { group: string } = $props();

  /** 组内活跃 key（数据源唯一：app.keys）。 */
  const keys = $derived(app.keys.filter((k) => k.group === group && k.revokedAt === undefined));

  /** 新增 key 的名字草稿（空 = "default"）。 */
  let keyName = $state("");
  /** 移除二次确认（本地）。 */
  let confirmRevoke = $state("");

  /** 分享 Dialog（#1：选 TTL → 生成 → 就地复制）。 */
  const DEFAULT_TTL_MS = 30 * 86_400_000;
  let shareOpen = $state(false);
  let shareKeyId = $state("");
  let shareKeyLabel = $state("");
  let ttlSel = $state(String(DEFAULT_TTL_MS));
  let link = $state("");
  let busy = $state(false);
  let error = $state<RpcError | null>(null);

  function openShare(keyId: string, name: string): void {
    shareKeyId = keyId;
    shareKeyLabel = name;
    link = "";
    error = null;
    ttlSel = String(DEFAULT_TTL_MS);
    shareOpen = true;
  }

  /** 现铸链接：invite 按 TTL 新铸，key 原文复用（服务端 share.create）。 */
  async function generateLink(): Promise<void> {
    if (busy || shareKeyId === "") return;
    busy = true;
    error = null;
    try {
      // share.create 依赖运行态 fabric（幂等启动）
      await call((c) => c.provider.daemon.start({}));
      const result = await call((c) =>
        c.provider.share.create({ group, ttlMs: Number.parseInt(ttlSel, 10), keyId: shareKeyId }),
      );
      link = result.link;
    } catch (err) {
      error = toRpcError(err);
    } finally {
      busy = false;
    }
  }
</script>

<div class="flex flex-col gap-1">
  <span class="font-nav text-[10px] uppercase tracking-[0.1em] text-muted-foreground">keys</span>
  {#each keys as key (key.keyId)}
    <div class="flex flex-wrap items-center gap-2 pl-1">
      <span class="font-mono text-[11px]">{key.name ?? "(unnamed)"}</span>
      <code class="font-mono text-[10px] text-muted-foreground">{key.keyId.slice(0, 8)}</code>
      {#if key.key !== undefined}
        <PressButton
          variant="ghost"
          class="h-5 px-1.5 text-[10px]"
          onclick={() => openShare(key.keyId, key.name ?? key.keyId.slice(0, 8))}
        >{t("gkp.share")}</PressButton>
      {:else}
        <span class="text-[10px] text-muted-foreground">{t("adv.keys.legacy")}</span>
      {/if}
      {#if confirmRevoke === key.keyId}
        <PressButton
          variant="tonal"
          class="jx-pair-destructive"
          loading={keyRevoke.busy === key.keyId}
          onclick={() => void revokeKey(key.keyId)}
        >{t("adv.keys.confirmRevoke")}</PressButton>
        <PressButton variant="ghost" class="h-5 px-1.5 text-[10px]" onclick={() => (confirmRevoke = "")}>{t("common.cancel")}</PressButton>
      {:else}
        <PressButton variant="ghost" class="h-5 px-1.5 text-[10px]" onclick={() => (confirmRevoke = key.keyId)}>{t("common.remove")}</PressButton>
      {/if}
    </div>
  {:else}
    <span class="pl-1 text-[11px] text-muted-foreground">no keys</span>
  {/each}
  <div class="flex items-center gap-1.5 pl-1">
    <input
      class="w-28 border border-border bg-transparent px-2 py-1 font-mono text-[11px] focus:border-primary focus:outline-none"
      placeholder="key-name"
      autocapitalize="none"
      autocorrect="off"
      spellcheck={false}
      bind:value={keyName}
    />
    <PressButton
      variant="ghost"
      class="h-5 px-1.5 text-[10px]"
      loading={keyIssue.busy && keyIssue.group === group}
      onclick={() => {
        keyIssue.group = group;
        keyIssue.name = keyName.trim() || "default";
        void issueKey();
        keyName = "";
      }}
    >+ key</PressButton>
  </div>
</div>

<Dialog bind:open={shareOpen} title="{t('gkp.shareDialog')}: {group} / {shareKeyLabel}">
  <div class="flex flex-col gap-3 p-4">
    {#if link === ""}
      <div class="flex flex-wrap items-center gap-2">
        <span class="font-nav text-[10px] uppercase tracking-[0.1em] text-muted-foreground">{t("gkp.ttl")}</span>
        <div class="w-44">
          <Select
            options={TTL_OPTIONS.map((o) => ({ value: String(o.ttlMs), label: o.label }))}
            bind:value={ttlSel}
          />
        </div>
      </div>
      <ErrorAlert {error} />
    {:else}
      <Alert variant="tonal" class="jx-hue-warning" assertive title={t("gkp.secretTitle")}>
        {t("gkp.secretBody")}
      </Alert>
      <CopyField value={link} label="aifly1." />
      <p class="text-[11px] text-muted-foreground">
        key <code class="font-mono">{shareKeyLabel}</code> · <code class="font-mono">{shareKeyId.slice(0, 8)}</code>
      </p>
    {/if}
  </div>
  {#snippet footer()}
    <CardFooter label="share link">
      <PressButton variant="ghost" onclick={() => (shareOpen = false)}>{t("f.close")}</PressButton>
      {#if link === ""}
        <PressButton variant="fill" loading={busy} onclick={() => void generateLink()}>{t("gkp.generate")}</PressButton>
      {/if}
    </CardFooter>
  {/snippet}
</Dialog>
