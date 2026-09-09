<!--
  jixoai color-picker swatches (registry/files/ui/color-picker/swatches.svelte).

  2026-08-28 · Pure-register fusion (original request: an EMBEDDABLE
  swatch panel for the Input picker bridge — Input mounts a
  trigger-less, shell-less, label-less palette inside its own popover,
  so the palette must carry no popover, no trigger and no motion of
  its own). The color-picker keeps its full editor; this file is the
  discrete palette half it shares with the bridge.

  Orthogonal intents:
  1. palette — the default set is 8 hues × 5 value shades + an 8-step
     gray ramp (48 cells, 8 columns), authored through the same OKLCH
     pipeline as the editor (hsvToOklch → formatColor hex, color-utils
     law); `colors` swaps in a restricted set (same chunking).
  2. selection model — purely controlled: `value` (#rrggbb, matched
     case-insensitively) marks the chosen cell (aria-selected + the
     inset ring frame); `onpick` is a DISCRETE commit (click / Enter /
     Space) so popover hosts may close the panel on it.
  3. keyboard law — role=grid + roving tabindex (the component had no
     prior keyboard law): ↑↓←→ walk the flat cell order (wrap-around;
     rows are presentational chunking), Enter/Space submit. focusFirst()
     is the host's focus-in seam (popover open → first cell focused).
-->
<script lang="ts">
  import { cn } from '$lib/utils';
  import { formatColor, hsvToOklch } from '$lib/color-utils';

  interface Props {
    /** current color (#rrggbb), marks the selected cell */
    value?: string;
    /** fires on discrete pick (click / Enter / Space) */
    onpick?: (hex: string) => void;
    /** restricts the selectable set; default = the full preset palette */
    colors?: string[];
    class?: string;
  }

  let { value, onpick, colors, class: className = '' }: Props = $props();

  // ---- the default palette: full spectrum through the system pipeline --
  const COLUMNS = 8;
  const HUES = [0, 45, 90, 140, 180, 220, 265, 310];
  const SHADES = [1, 0.85, 0.7, 0.55, 0.4];
  const GRAYS = [1, 0.87, 0.72, 0.57, 0.42, 0.28, 0.15, 0.04];
  const defaultColors: string[] = [
    ...SHADES.flatMap((v) => HUES.map((h) => formatColor(hsvToOklch(h, 1, v), 'hex'))),
    ...GRAYS.map((v) => formatColor(hsvToOklch(0, 0, v), 'hex')),
  ];

  const cells = $derived((colors ?? defaultColors).map((hex) => hex.toLowerCase()));
  // role=row chunks keep the ARIA grid honest inside the fixed tracks
  const rows = $derived(
    Array.from({ length: Math.ceil(cells.length / COLUMNS) }, (_, r) =>
      cells.slice(r * COLUMNS, r * COLUMNS + COLUMNS),
    ),
  );

  const selected = $derived(value?.trim().toLowerCase());
  const selectedIndex = $derived(selected ? cells.indexOf(selected) : -1);

  // the roving seat follows the last focused cell; before any focus it
  // parks on the selected cell (or the head)
  let seat = $state(-1);
  const seatIndex = $derived(seat >= 0 ? seat : selectedIndex >= 0 ? selectedIndex : 0);

  let rootEl = $state<HTMLDivElement | null>(null);

  /** host focus-in seam: focus the first interactive element */
  export function focusFirst(): void {
    rootEl?.querySelector<HTMLElement>('[role="gridcell"]')?.focus();
  }

  function cellElements(): HTMLElement[] {
    return Array.from(rootEl?.querySelectorAll<HTMLElement>('[role="gridcell"]') ?? []);
  }

  function onCellFocusin(event: FocusEvent): void {
    const index = cellElements().indexOf(event.target as HTMLElement);
    if (index >= 0) seat = index;
  }

  function onCellKeydown(event: KeyboardEvent): void {
    const cellEls = cellElements();
    if (cellEls.length === 0) return;
    const from = cellEls.indexOf(event.currentTarget as HTMLElement);
    if (from < 0) return;
    // walk the FLAT order with wrap-around — rows are presentational
    const step = (delta: number): number => (from + delta + cellEls.length) % cellEls.length;
    switch (event.key) {
      case 'ArrowRight':
        event.preventDefault();
        cellEls[step(1)].focus();
        break;
      case 'ArrowLeft':
        event.preventDefault();
        cellEls[step(-1)].focus();
        break;
      case 'ArrowDown':
        event.preventDefault();
        cellEls[step(COLUMNS)].focus();
        break;
      case 'ArrowUp':
        event.preventDefault();
        cellEls[step(-COLUMNS)].focus();
        break;
      case 'Enter':
      case ' ':
        event.preventDefault();
        onpick?.(cells[from]);
        break;
    }
  }
</script>

<div
  bind:this={rootEl}
  role="grid"
  aria-label="color swatches"
  class={cn('jx-color-picker-swatches grid grid-cols-[repeat(8,22px)] gap-[3px]', className)}
>
  {#each rows as row, r}
    <div role="row" class="contents">
      {#each row as hex, c}
        {@const flat = r * COLUMNS + c}
        <div
          role="gridcell"
          tabindex={flat === seatIndex ? 0 : -1}
          aria-selected={hex === selected ? 'true' : undefined}
          aria-label={hex}
          class="jx-color-picker-swatch-cell w-[22px] h-[22px] border border-border cursor-pointer"
          style:background={hex}
          onfocusin={onCellFocusin}
          onkeydown={onCellKeydown}
          onclick={() => onpick?.(hex)}
        ></div>
      {/each}
    </div>
  {/each}
</div>
