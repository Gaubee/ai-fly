<!--
  jixoai ItemDivider — the explicit full-strength boundary between
  group rows (replaces ItemSeparator, openspec
  list-item-systemization). Childless + decorative in v1: an empty
  presentation <li>; the automatic adjacency divider (38% mix) is
  structurally exclusive with it — one source per edge. Group-only by
  contract: it IS a list child; rendering it outside an ItemGroup is
  a consumer error.
-->
<script lang="ts">
  import { cn } from '$lib/utils';

  let { class: className = '' }: { class?: string } = $props();
</script>

<li role="presentation" data-slot="item-divider" class={cn('list-none m-0 p-0', className)}></li>
