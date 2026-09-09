<!-- 密钥面板（M3 6.2）：列表仅名称 + 每行 remove（二次确认，Dashboard
     forget 同款）；新增/编辑表单 name + value（password 型，提交后清空
     不回显——值由设计不跨 RPC 亦不回显）；空态引导。open 由选择器持有；
     onpick 在新增/覆写成功后回选通知。 -->
<script lang="ts">
  import Dialog, { DialogFooter } from "$lib/ui/dialog";
  import PressButton from "$lib/ui/press-button";
  import Input from "$lib/ui/input";
  import Separator from "$lib/ui/separator";
  import Skeleton from "$lib/ui/skeleton";
  import { secrets, refreshSecrets, setSecret, removeSecret } from "../stores/secrets.svelte.ts";

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
    editing = null;
  }

  function startEdit(secretName: string): void {
    editing = secretName;
    name = secretName;
    value = "";
  }

  async function submit(): Promise<void> {
    const trimmed = name.trim();
    if (busy || !formValid) return;
    busy = true;
    const ok = await setSecret(trimmed, value);
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

<Dialog bind:open title="secrets">
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
              <PressButton variant="ghost" onclick={() => startEdit(secretName)}>edit</PressButton>
              {#if confirmName === secretName}
                <PressButton
                  variant="tonal"
                  class="jx-pair-destructive"
                  loading={removing === secretName}
                  onclick={() => void removeRow(secretName)}
                >confirm remove</PressButton>
                <PressButton variant="ghost" onclick={() => (confirmName = null)}>cancel</PressButton>
              {:else}
                <PressButton variant="ghost" onclick={() => (confirmName = secretName)}>remove</PressButton>
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
      <Input label="name" placeholder="openai" error={nameError} bind:value={name} />
      <Input
        type="password"
        label="value"
        placeholder="Bearer sk-..."
        autocomplete="off"
        bind:value={value}
      />
      <p class="text-[11px] leading-relaxed text-muted-foreground">
        the full authorization header value, e.g.
        <code class="font-mono">Bearer sk-...</code> - it is stored locally and
        cleared from this form after saving.
      </p>
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
          <PressButton variant="ghost" onclick={resetForm}>cancel</PressButton>
        {/if}
      </div>
    </div>
  </div>

  {#snippet footer()}
    <DialogFooter label="secrets dialog actions">
      <PressButton variant="fill" onclick={() => (open = false)}>done</PressButton>
    </DialogFooter>
  {/snippet}
</Dialog>
