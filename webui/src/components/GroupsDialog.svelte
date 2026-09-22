<!-- 分组管理弹窗（M3-r3 ①，对齐 keys/secrets 管理体验）：列表（服务 chips +
     限额摘要 + active keys 数）+ 每行 edit（内联：成员勾选 + 限额输入；名称只读）
     与 remove（二次确认；仍有未撤销密钥时引擎报 CONFLICT "revoke them first"）；
     新建表单（name + 成员勾选 + 限额）。open 由选择器持有；onpick 在新建/选中
     后回选通知。数据面走 app store（groups/services/keys）与 RPC groups.*。 -->
<script lang="ts">
  import Dialog from "$lib/ui/dialog";
  import PressButton from "$lib/ui/press-button";
  import Input from "$lib/ui/input";
  import Checkbox from "$lib/ui/checkbox";
  import Badge from "$lib/ui/badge";
  import { call } from "../stores/rpc.svelte.ts";
  import { app, refresh } from "../stores/app.svelte.ts";
  import { toast } from "../stores/toast.svelte.ts";
  import { toRpcError } from "$lib/rpc-client";
  import { t } from "$lib/i18n.svelte.ts";

  interface Props {
    /** bindable 开合。 */
    open?: boolean;
    /** 新建成功或行选中后回选通知（选择器就地选中该组）。 */
    onpick?: (name: string) => void;
  }
  let { open = $bindable(false), onpick }: Props = $props();

  // ── 展示投影 ─────────────────────────────────────────────────────────
  const serviceNames = $derived(app.services.map((s) => ({ id: s.serviceId, name: s.name })));
  const nameById = $derived(new Map(serviceNames.map((s) => [s.id, s.name])));
  const activeKeysByGroup = $derived.by(() => {
    const map = new Map<string, number>();
    for (const key of app.keys) {
      if (key.revokedAt === undefined) map.set(key.group, (map.get(key.group) ?? 0) + 1);
    }
    return map;
  });

  // ── 行内编辑状态 ─────────────────────────────────────────────────────
  let editing = $state<string | null>(null);
  let memberIds = $state<Set<string>>(new Set());
  let limitsConcurrency = $state("");
  let limitsDaily = $state("");
  let busy = $state(false);
  /** 每行 remove 二次确认（Dashboard forget 同款）。 */
  let confirmName = $state<string | null>(null);

  // ── 新建表单 ─────────────────────────────────────────────────────────
  let newName = $state("");
  let newMembers = $state<Set<string>>(new Set());
  let newConcurrency = $state("");
  let newDaily = $state("");
  let creating = $state(false);

  const newNameError = $derived(
    newName.trim() === "" || app.groups.some((g) => g.name === newName.trim())
      ? app.groups.some((g) => g.name === newName.trim())
        ? "name already exists"
        : undefined
      : undefined,
  );

  $effect(() => {
    if (open) void refresh("groups", "keys", "services");
  });

  function startEdit(groupName: string): void {
    const group = app.groups.find((g) => g.name === groupName);
    if (group === undefined) return;
    editing = groupName;
    memberIds = new Set(group.serviceIds);
    limitsConcurrency = group.limits?.maxConcurrency?.toString() ?? "";
    limitsDaily = group.limits?.dailyRequests?.toString() ?? "";
  }

  function resetEdit(): void {
    editing = null;
    confirmName = null;
  }

  async function saveEdit(groupName: string): Promise<void> {
    if (busy) return;
    busy = true;
    try {
      await call((c) =>
        c.provider.groups.setServices({ name: groupName, serviceNames: [...memberIds].map((id) => nameById.get(id) ?? id) }),
      );
      await call((c) =>
        c.provider.groups.setLimits({
          name: groupName,
          limits:
            limitsConcurrency.trim() === "" && limitsDaily.trim() === ""
              ? undefined
              : {
                  ...(limitsConcurrency.trim() !== "" ? { maxConcurrency: Number(limitsConcurrency) } : {}),
                  ...(limitsDaily.trim() !== "" ? { dailyRequests: Number(limitsDaily) } : {}),
                },
        }),
      );
      await refresh("groups");
      resetEdit();
    } catch (error) {
      toast.api.push({ title: "Update failed", description: toRpcError(error).message, variant: "tonal", class: "jx-hue-warning" });
    } finally {
      busy = false;
    }
  }

  async function removeGroup(groupName: string): Promise<void> {
    if (busy) return;
    busy = true;
    try {
      await call((c) => c.provider.groups.remove({ name: groupName }));
      await refresh("groups", "keys");
      confirmName = null;
    } catch (error) {
      // CONFLICT: "revoke them first" —— 引擎文案直接透出
      toast.api.push({ title: "Remove failed", description: toRpcError(error).message, variant: "tonal", class: "jx-hue-warning" });
    } finally {
      busy = false;
    }
  }

  async function createGroup(): Promise<void> {
    const name = newName.trim();
    if (creating || name === "" || app.groups.some((g) => g.name === name)) return;
    creating = true;
    try {
      await call((c) =>
        c.provider.groups.add({
          name,
          serviceNames: [...newMembers].map((id) => nameById.get(id) ?? id),
          limits:
            newConcurrency.trim() === "" && newDaily.trim() === ""
              ? undefined
              : {
                  ...(newConcurrency.trim() !== "" ? { maxConcurrency: Number(newConcurrency) } : {}),
                  ...(newDaily.trim() !== "" ? { dailyRequests: Number(newDaily) } : {}),
                },
        }),
      );
      await refresh("groups", "keys");
      newName = "";
      newMembers = new Set();
      newConcurrency = "";
      newDaily = "";
      onpick?.(name);
    } catch (error) {
      toast.api.push({ title: "Create failed", description: toRpcError(error).message, variant: "tonal", class: "jx-hue-warning" });
    } finally {
      creating = false;
    }
  }

  function toggleMember(set: Set<string>, id: string): Set<string> {
    const next = new Set(set);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    return next;
  }

  function limitsLabel(limits: { maxConcurrency?: number; dailyRequests?: number } | undefined): string {
    if (limits === undefined) return t("adv.groups.unlimited");
    const parts: string[] = [];
    if (limits.maxConcurrency !== undefined) parts.push(`c=${limits.maxConcurrency}`);
    if (limits.dailyRequests !== undefined) parts.push(`d=${limits.dailyRequests}/day`);
    return parts.length > 0 ? parts.join(" ") : t("adv.groups.unlimited");
  }
</script>

<Dialog bind:open title={t("groupsdlg.manage")}>
  <div class="flex min-h-40 w-full flex-col gap-3">
      {#if app.groups.length === 0 && app.ready}
        <p class="text-xs leading-relaxed text-muted-foreground">
          {t("groupsdlg.emptyNote")}
        </p>
      {/if}
      {#each app.groups as group (group.name)}
        <div class="flex flex-col gap-1.5 border border-border/70 px-3 py-2">
          {#if editing === group.name}
            <!-- 行内编辑：成员勾选 + 限额（名称只读） -->
            <div class="flex items-center gap-2">
              <span class="font-mono text-xs">{group.name}</span>
              <Badge variant="tonal" class="jx-hue-neutral">{t("groupsdlg.editing")}</Badge>
            </div>
            {#if serviceNames.length > 0}
              <div class="flex flex-wrap gap-x-4 gap-y-1">
                {#each serviceNames as svc (svc.id)}
                  <label class="flex items-center gap-1.5 text-xs">
                    <Checkbox
                      checked={memberIds.has(svc.id)}
                      onchange={() => (memberIds = toggleMember(memberIds, svc.id))}
                    />
                    {svc.name}
                  </label>
                {/each}
              </div>
            {:else}
              <p class="text-[11px] text-muted-foreground">{t("groupsdlg.noServices")}</p>
            {/if}
            <div class="grid grid-cols-2 gap-2">
              <Input label={t("groupsdlg.maxConcurrency")} placeholder="unlimited" bind:value={limitsConcurrency} />
              <Input label={t("groupsdlg.dailyRequests")} placeholder="unlimited" bind:value={limitsDaily} />
            </div>
            <div class="flex items-center justify-end gap-2 pt-1">
              <PressButton variant="ghost" class={busy ? "pointer-events-none opacity-50" : undefined} onclick={resetEdit}>{t("common.cancel")}</PressButton>
              <PressButton variant="fill" loading={busy} onclick={() => void saveEdit(group.name)}>save</PressButton>
            </div>
          {:else}
            <div class="flex flex-wrap items-center gap-2">
              <span class="font-mono text-xs">{group.name}</span>
              <Badge variant="tonal" class="jx-hue-neutral">{limitsLabel(group.limits)}</Badge>
              <span class="font-mono text-[11px] text-muted-foreground">
                {activeKeysByGroup.get(group.name) ?? 0} active key(s)
              </span>
              <span class="ml-auto flex items-center gap-1.5">
                <button
                  type="button"
                  class="text-[11px] text-muted-foreground underline-offset-2 hover:text-foreground hover:underline"
                  onclick={() => startEdit(group.name)}
                >edit</button>
                {#if confirmName === group.name}
                  <PressButton variant="tonal" class="jx-pair-destructive" loading={busy} onclick={() => void removeGroup(group.name)}>
                    {t("groupsdlg.confirmRemove")}
                  </PressButton>
                  <PressButton variant="ghost" onclick={() => (confirmName = null)}>{t("common.cancel")}</PressButton>
                {:else}
                  <button
                    type="button"
                    class="text-[11px] text-muted-foreground underline-offset-2 hover:text-foreground hover:underline"
                    onclick={() => (confirmName = group.name)}
                  >{t("common.remove")}</button>
                {/if}
              </span>
            </div>
            <div class="flex flex-wrap gap-1">
              {#each group.serviceIds as id (id)}
                <Badge variant="outline">{nameById.get(id) ?? id}</Badge>
              {/each}
              {#if group.serviceIds.length === 0}
                <span class="text-[11px] text-muted-foreground">(no services)</span>
              {/if}
            </div>
          {/if}
        </div>
      {/each}

      <div class="mt-1 flex flex-col gap-2 border-t border-border pt-3">
        <p class="font-nav text-[11px] uppercase tracking-[0.1em] text-muted-foreground">{t("groupsdlg.new")}</p>
        <Input
          label="name"
          placeholder="friends"
          autocapitalize="none"
          autocorrect="off"
          spellcheck={false}
          bind:value={newName}
          error={newNameError}
        />
        {#if serviceNames.length > 0}
          <div class="flex flex-wrap gap-x-4 gap-y-1">
            {#each serviceNames as svc (svc.id)}
              <label class="flex items-center gap-1.5 text-xs">
                <Checkbox
                  checked={newMembers.has(svc.id)}
                  onchange={() => (newMembers = toggleMember(newMembers, svc.id))}
                />
                {svc.name}
              </label>
            {/each}
          </div>
        {/if}
        <div class="grid grid-cols-2 gap-2">
          <Input label={t("groupsdlg.maxConcurrency")} placeholder="unlimited" bind:value={newConcurrency} />
          <Input label={t("groupsdlg.dailyRequests")} placeholder="unlimited" bind:value={newDaily} />
        </div>
        <div class="flex items-center justify-end pt-1">
          <PressButton
            variant="fill"
            loading={creating}
            class={newName.trim() === "" || newNameError !== undefined ? "pointer-events-none opacity-50" : undefined}
            onclick={() => void createGroup()}
          >{t("groupsdlg.create")}</PressButton>
        </div>
      </div>
    </div>
  </Dialog>
