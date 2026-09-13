<!-- 密钥面板（M3 6.2 + M3-acceptance ①）：列表仅名称 + 每行 remove（二次
     确认，Dashboard forget 同款）；新增/编辑表单 name + value（password 型
     裸密钥，提交后清空不回显——值由设计不跨 RPC 亦不回显）+ "Bearer "
     前缀开关（编辑回填既有条目值）；空态引导。open 由选择器持有；
     onpick 在新增/覆写成功后回选通知。 -->
<script lang="ts">
  import Dialog from "$lib/ui/dialog";
  import { CardFooter } from "$lib/ui/card";
  import PressButton from "$lib/ui/press-button";
  import Input from "$lib/ui/input";
  import Separator from "$lib/ui/separator";
  import Skeleton from "$lib/ui/skeleton";
  import Toggle from "$lib/ui/toggle";
  import { secrets, refreshSecrets, setSecret, removeSecret } from "../stores/secrets.svelte.ts";
  import { t } from "$lib/i18n.svelte.ts";

  interface Props {
    /** bindable 开合（× / esc / done 关闭写回）。 */
    open?: boolean;
    /** 新增/覆写成功后回选通知（选择器就地选中该密钥）。 */
    onpick?: (name: string) => void;
  }
  let { open = $bindable(false), onpick }: Props = $props();

  // 名词法镜像契约 SECRET_NAME_SCHEMA（不引 zod 运行时，保持 bundle 干净）
  const NAME_RE = /^[a-z0-9][a-z0-9._-]*$/;

  let name = $state("");
  let value = $state("");
  /** Bearer 开关（M3-acceptance ①）：编辑既有条目时回填该条目值。 */
  let bearerPrefix = $state(true);
  /** 正在覆写的既有密钥名（编辑 = 同名 set 覆写；值不回显）。 */
  let editing = $state<string | null>(null);
  /** 每行 remove 二次确认（与 Dashboard forget 同款切换）。 */
  let confirmName = $state<string | null>(null);
  let removing = $state<string | null>(null);
  let busy = $state(false);

  const nameError = $derived(
    name.trim() === "" || NAME_RE.test(name.trim())
      ? undefined
      : "lowercase letters, digits, dot, dash, underscore",
  );
  const formValid = $derived(nameError === undefined && name.trim() !== "" && value !== "");

  // 打开时拉一份新名单（set/remove 各自也会刷新；此处覆盖外部变更）
  $effect(() => {
    if (open) void refreshSecrets();
  });

  function resetForm(): void {
    name = "";
    value = "";
    bearerPrefix = true;
    editing = null;
  }

  function startEdit(secretName: string): void {
    editing = secretName;
    name = secretName;
    value = "";
    bearerPrefix = secrets.entries.find((entry) => entry.name === secretName)?.bearerPrefix ?? true;
  }

  async function submit(): Promise<void> {
    const trimmed = name.trim();
    if (busy || !formValid) return;
    busy = true;
    const ok = await setSecret(trimmed, value, bearerPrefix);
    busy = false;
    if (!ok) return;
    onpick?.(trimmed);
    resetForm();
  }

  async function removeRow(secretName: string): Promise<void> {
    if (removing !== null) return;
    removing = secretName;
    const ok = await removeSecret(secretName);
    removing = null;
    if (ok) confirmName = null;
  }
</script>

<Dialog bind:open title={t("secretdlg.title")}>
  <div class="flex flex-col gap-3">
    <p class="text-[11px] leading-relaxed text-muted-foreground">
      values live in this machine's provider secret store and are never shown
      again after saving - consumers only ever see <code class="font-mono">&#9679;</code>.
    </p>

    {#if secrets.loading && !secrets.loaded}
      <div class="flex flex-col gap-2">
        <Skeleton class="h-9" />
        <Skeleton class="h-9" />
      </div>
    {:else if secrets.names.length === 0}
      <p class="border border-dashed border-border px-3 py-2.5 text-xs leading-relaxed text-muted-foreground">
        no secrets yet - add one below (e.g. the api key of the provider you are sharing).
      </p>
    {:else}
      <div class="flex flex-col gap-1.5">
        {#each secrets.names as secretName (secretName)}
          <div class="flex flex-wrap items-center gap-2 border border-border/70 px-2.5 py-1.5">
            <span class="min-w-0 truncate font-mono text-xs">{secretName}</span>
            <span class="ml-auto flex items-center gap-1.5">
              <PressButton variant="ghost" onclick={() => startEdit(secretName)}>{t("common.edit")}</PressButton>
              {#if confirmName === secretName}
                <PressButton
                  variant="tonal"
                  class="jx-pair-destructive"
                  loading={removing === secretName}
                  onclick={() => void removeRow(secretName)}
                >{t("common.confirmRemove")}</PressButton>
                <PressButton variant="ghost" onclick={() => (confirmName = null)}>{t("common.cancel")}</PressButton>
              {:else}
                <PressButton variant="ghost" onclick={() => (confirmName = secretName)}>{t("common.remove")}</PressButton>
              {/if}
            </span>
          </div>
        {/each}
      </div>
    {/if}

    <Separator />

    <div class="flex flex-col gap-3">
      <span class="font-nav text-[11px] uppercase tracking-[0.1em] text-muted-foreground">
        {editing !== null ? `overwrite "${editing}"` : "add a secret"}
      </span>
      <Input
        label={t("f.name")}
        placeholder={t("f.secrets.ph.name")}
        autocapitalize="none"
        autocorrect="off"
        spellcheck={false}
        error={nameError}
        bind:value={name}
      />
      <Input
        type="password"
        label={t("f.value")}
        placeholder={t("f.secrets.ph.value")}
        autocomplete="off"
        bind:value={value}
      />
      <div class="flex flex-col gap-1.5">
        <Toggle
          label='add "Bearer " prefix'
          checked={bearerPrefix}
          onchange={(event) => (bearerPrefix = event.currentTarget.checked)}
        />
        <p class="text-[11px] leading-relaxed text-muted-foreground">
          most OpenAI-compatible providers expect it; turn off for raw keys -
          the value is stored locally and cleared from this form after saving.
        </p>
      </div>
      <div class="flex items-center gap-2">
        <PressButton
          variant="fill"
          loading={busy}
          class={formValid ? undefined : "pointer-events-none opacity-50"}
          onclick={() => void submit()}
        >
          {editing !== null ? "overwrite" : "save"}
        </PressButton>
        {#if editing !== null}
          <PressButton variant="ghost" onclick={resetForm}>{t("common.cancel")}</PressButton>
        {/if}
      </div>
    </div>
  </div>

  {#snippet footer()}
    <CardFooter label="secrets dialog actions">
      <PressButton variant="fill" onclick={() => (open = false)}>{t("common.done")}</PressButton>
    </CardFooter>
  {/snippet}
</Dialog>
