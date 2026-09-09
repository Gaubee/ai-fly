<!-- 消费侧提供者六态 + stopped 的徽标（Dashboard 状态行/高级视图共用）。
     六态语义：not-connected（未连）/connected-unauthed（已连未授权）/
     direct（直连）/relay（中继）/offline（离线）/key-all-invalid（钥全废）；
     stopped 为 UI 投影态（网关未运行）。 -->
<script module lang="ts">
  /** 消费侧提供者状态联合（契约 PROVIDER_STATE_SCHEMA 的镜像）。 */
  export type ConsumerState =
    | "stopped"
    | "not-connected"
    | "connected-unauthed"
    | "direct"
    | "relay"
    | "offline"
    | "key-all-invalid";
</script>

<script lang="ts">
  import Badge from "$lib/ui/badge";
  import type { ConsumerState } from "./StateBadge.svelte";

  let { state }: { state: ConsumerState } = $props();

  const FACE: Record<ConsumerState, { hue: string; label: string }> = {
    stopped: { hue: "jx-hue-neutral", label: "stopped" },
    "not-connected": { hue: "jx-hue-neutral", label: "not connected" },
    "connected-unauthed": { hue: "jx-hue-warning", label: "connected - awaiting auth" },
    direct: { hue: "jx-hue-success", label: "direct" },
    relay: { hue: "jx-hue-success", label: "relay" },
    offline: { hue: "jx-hue-error", label: "offline" },
    "key-all-invalid": { hue: "jx-hue-error", label: "key invalid" },
  };

  const face = $derived(FACE[state]);
</script>

<Badge variant="tonal" class={face.hue}>{face.label}</Badge>
