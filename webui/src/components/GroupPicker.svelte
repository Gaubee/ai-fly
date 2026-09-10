<!-- 分组选择器（M3-r3 ①，对齐 SecretPicker 模式）：选项 = 分组名单 +
     manage groups…（就地打开分组管理弹窗，关闭后保持选择；弹窗内新建成功
     经 onpick 就地选中）。替换向导 ② 原先的「下拉 + NEW GROUP NAME 输入」
     临时体验——新建/编辑/删除全部收敛进管理弹窗。 -->
<script lang="ts">
  import { onMount } from "svelte";
  import NativeSelect from "$lib/ui/native-select";
  import GroupsDialog from "./GroupsDialog.svelte";
  import { app, refresh } from "../stores/app.svelte.ts";

  interface Props {
    /** 当前选中分组名（undefined = 未选）。 */
    value?: string;
    onchange?: (name: string | undefined) => void;
  }
  let { value = undefined, onchange }: Props = $props();

  const NONE = "";
  const MANAGE = "__manage__";

  let dialogOpen = $state(false);
  let selected = $state<string>(NONE);

  // 外部 value → 显示值（进入 ② / 向导重置）
  $effect(() => {
    selected = value ?? NONE;
  });

  // 选中组被删 → 清空选择。busy 守卫：groups 拉取在途时名单是旧的，
  // 此时“不在名单”≠“已删除”（新建组 onpick 早于名单落地的竞态曾误清空）。
  $effect(() => {
    if (
      app.ready &&
      !app.busy.groups &&
      value !== undefined &&
      !app.groups.some((g) => g.name === value)
    ) {
      onchange?.(undefined);
    }
  });

  // 弹窗关闭 → 对账一次（编辑限额等外部变更）
  let wasOpen = false;
  $effect(() => {
    const nowOpen = dialogOpen;
    if (wasOpen && !nowOpen) void refresh("groups");
    wasOpen = nowOpen;
  });

  onMount(() => {
    void refresh("groups", "services", "keys");
  });

  function handleChange(event: Event & { currentTarget: EventTarget & HTMLSelectElement }): void {
    const next = event.currentTarget.value;
    if (next === MANAGE) {
      dialogOpen = true;
      selected = value ?? NONE;
      return;
    }
    onchange?.(next === NONE ? undefined : next);
  }
</script>

<div class="flex flex-col gap-1.5">
  <NativeSelect label="group" bind:value={selected} onchange={handleChange}>
    <option value={NONE}>pick a group...</option>
    {#each app.groups as group (group.name)}
      <option value={group.name}>{group.name}</option>
    {/each}
    <option value={MANAGE}>manage groups...</option>
  </NativeSelect>
  <p class="text-[11px] leading-relaxed text-muted-foreground">
    groups scope what each shared key can reach - create or edit them in the manager.
  </p>
</div>

<GroupsDialog bind:open={dialogOpen} onpick={(name) => onchange?.(name)} />
