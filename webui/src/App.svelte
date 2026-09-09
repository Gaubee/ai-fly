<!-- 占位 App（A 车道只保证可构建；B 车道替换为三视图布局 + rpc-client）。 -->
<script lang="ts">
  let ready = $state(true);
</script>

<main class="flex h-dvh items-center justify-center bg-background text-foreground">
  <p class="font-mono text-sm">
    {ready ? "ai-fly webui scaffold (lane A placeholder)" : "loading"}
  </p>
</main>
