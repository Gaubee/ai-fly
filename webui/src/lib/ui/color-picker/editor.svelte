<!--
  jixoai color editor (registry/files/ui/color-picker/editor.svelte).

  2026-08-28 · Pure-register fusion, second half (original request: the
  48-cell discrete grid felt "潦草" as the Input picker bridge's default
  color panel — the professional CONTINUOUS picking experience must be
  the bridge's default). This file is the embeddable editor half of
  color-picker.svelte: SV pad + hue bar + format switch + value input +
  Eye Dropper + the Swatches preset row. No popover, no trigger, no
  motion — the host (the color-picker panel OR the Input bridge panel)
  provides the panel shell and its animation.

  Orthogonal intents:
  1. color geometry — SV pad 200×150 (pure-hue ground + white→transparent
     horizontal and black→transparent vertical overlays, the pseudos in
     color-picker.css) and a 12px full-spectrum hue bar, both driven by
     Pointer Events with capture; the pad keeps direction:ltr because it
     maps color space, not document flow. Pointer-only by design — the
     keyboard paths are the value input, the format select and the
     Swatches roving grid (shipped law, unchanged).
  2. value model — OKLCH is the intermediate representation (the token
     system's space, see lib/color-utils.ts): parse(value) → oklch → hsv
     for the pad, drag → hsv → oklch → format → value. The FULL format
     state lives here: the mode seeds from the incoming value's notation
     (hex/hsl/oklch prefix), the NativeSelect switches it and re-emits
     the same color in the new notation. The value Input commits parsed
     pastes and reverts invalid ones. Eye Dropper rides window.EyeDropper
     when present.
  3. commit semantics — CONTINUOUS/immediate: every SV/Hue drag tick,
     value-input commit, preset pick and Eye-Dropper sample raises
     `onpick` with the current format's string; identical strings are
     never re-raised (the formatted string is the quantizer — no further
     throttling). The editor never closes anything; closing is the
     host's decision.
  4. external sync — `value` writes that differ from the last raised
     string re-parse into the pad (applyOklch law: achromatic inputs
     keep the stored hue so S/V drags stay predictable) and refresh the
     text draft; the format mode stays untouched.
  5. focus-in seam — focusFirst() focuses the first interactive element
     in DOM order (the format select) for popover hosts.
-->
<script lang="ts">
  import { onMount } from 'svelte';
  import Icon from '$lib/ui/icon';
  import Input from '$lib/ui/input/input.svelte';
  import NativeSelect from '$lib/ui/native-select/native-select.svelte';
  import IconButton from '$lib/ui/icon-button/icon-button.svelte';
  import { cn } from '$lib/utils';
  import Swatches from './swatches.svelte';
  import './color-picker.css';
  import {
    colorFormats,
    formatColor,
    hsvToOklch,
    oklchToHsv,
    parseColor,
    type ColorFormat,
    type Oklch,
  } from '$lib/color-utils';

  interface Props {
    /** current color (any CSS color string parseColor accepts; the Input
        bridge passes #hex6) — external writes re-seat the pad */
    value?: string;
    /** CONTINUOUS commit: every drag tick / input commit / preset pick /
        Eye-Dropper sample raises the color in the active format; identical
        strings are never re-raised; the panel never closes */
    onpick?: (color: string) => void;
    class?: string;
  }

  let { value, onpick, class: className = '' }: Props = $props();

  // ---- color state: HSV working model, OKLCH intermediate ---------------
  // the seeds below DELIBERATELY capture the mount-time `value` (external
  // writes ride the $effect below, never these initializers) — the ignores
  // keep that contract explicit instead of looking like missed reactivity
  // svelte-ignore state_referenced_locally
  const initial = parseColor(value ?? '') ?? ({ l: 0, c: 0, h: 0 } satisfies Oklch);
  const initialHsv = oklchToHsv(initial);
  let hue = $state(initialHsv.h);
  let sat = $state(initialHsv.s);
  let val = $state(initialHsv.v);
  /** the last string WE raised — external changes never match it */
  // svelte-ignore state_referenced_locally
  let lastEmitted: string | undefined = value;
  /** live text in the value input */
  // svelte-ignore state_referenced_locally
  let textDraft = $state(value ?? '');
  /** notation mode: seeded from the incoming value's prefix, switched
      in-panel through the NativeSelect */
  // svelte-ignore state_referenced_locally
  let formatMode = $state(inferFormat(value));

  const swatch = $derived(formatColor(hsvToOklch(hue, sat, val), 'hex'));

  function inferFormat(text: string | undefined): ColorFormat {
    const t = text?.trim().toLowerCase() ?? '';
    if (t.startsWith('hsl')) return 'hsl';
    if (t.startsWith('oklch')) return 'oklch';
    return 'hex';
  }

  function applyOklch(color: Oklch): void {
    const hsv = oklchToHsv(color);
    // achromatic inputs keep the stored hue so S/V drags stay predictable
    if (hsv.s > 0.001) hue = hsv.h;
    sat = hsv.s;
    val = hsv.v;
  }

  function emit(): void {
    const text = formatColor(hsvToOklch(hue, sat, val), formatMode);
    const moved = text !== lastEmitted;
    lastEmitted = text;
    textDraft = text; // canonical display even when the value didn't move
    if (moved) onpick?.(text);
  }

  // external value writes (host bindings, lane typing) re-seat the pad
  $effect(() => {
    if (value === lastEmitted) return;
    const parsed = parseColor(value ?? '');
    if (!parsed) return;
    applyOklch(parsed);
    textDraft = value ?? '';
    lastEmitted = value;
  });

  // ---- SV pad + hue bar: pointer capture drags ---------------------------
  let svEl = $state<HTMLDivElement | null>(null);
  let hueEl = $state<HTMLDivElement | null>(null);
  let dragSV = $state(false);
  let dragHue = $state(false);

  const clamp01 = (n: number): number => Math.min(1, Math.max(0, n));

  function svFromPointer(event: PointerEvent): void {
    if (!svEl) return;
    const rect = svEl.getBoundingClientRect();
    if (rect.width === 0 || rect.height === 0) return;
    sat = clamp01((event.clientX - rect.left) / rect.width);
    val = 1 - clamp01((event.clientY - rect.top) / rect.height);
    emit();
  }

  function hueFromPointer(event: PointerEvent): void {
    if (!hueEl) return;
    const rect = hueEl.getBoundingClientRect();
    if (rect.width === 0) return;
    hue = 360 * clamp01((event.clientX - rect.left) / rect.width);
    emit();
  }

  function onSvDown(event: PointerEvent): void {
    if (event.button !== 0) return;
    dragSV = true;
    svEl?.setPointerCapture(event.pointerId);
    svFromPointer(event);
  }

  function onHueDown(event: PointerEvent): void {
    if (event.button !== 0) return;
    dragHue = true;
    hueEl?.setPointerCapture(event.pointerId);
    hueFromPointer(event);
  }

  function endDrag(el: HTMLElement | null, event: PointerEvent, wasDragging: boolean): boolean {
    if (!wasDragging) return false;
    if (el?.hasPointerCapture(event.pointerId)) el.releasePointerCapture(event.pointerId);
    return true;
  }

  // ---- value input + format switch + eye dropper -------------------------
  function commitText(event: Event): void {
    const text = (event.currentTarget as HTMLInputElement).value;
    const parsed = parseColor(text);
    if (parsed) {
      applyOklch(parsed);
      emit(); // canonicalizes into the active format
    } else {
      textDraft = lastEmitted ?? ''; // revert invalid pastes
    }
  }

  function setFormat(event: Event): void {
    const next = (event.currentTarget as HTMLSelectElement).value as ColorFormat;
    if (!colorFormats.includes(next) || next === formatMode) return;
    formatMode = next;
    emit();
  }

  type EyeDropperCtor = new () => { open(): Promise<{ sRGBHex: string }> };
  let canPick = $state(false);

  onMount(() => {
    canPick = 'EyeDropper' in window;
  });

  async function pickFromScreen(): Promise<void> {
    const Ctor = (window as Window & { EyeDropper?: EyeDropperCtor }).EyeDropper;
    if (!Ctor) return;
    try {
      const { sRGBHex } = await new Ctor().open();
      const parsed = parseColor(sRGBHex);
      if (parsed) {
        applyOklch(parsed);
        emit();
      }
    } catch {
      // user dismissed the system picker — keep the current color
    }
  }

  /** the embedded palette's discrete pick — the same commit path as the
      Eye Dropper (applyOklch → emit re-formats into the active notation) */
  function pickSwatch(hex: string): void {
    const parsed = parseColor(hex);
    if (parsed) {
      applyOklch(parsed);
      emit();
    }
  }

  let rootEl = $state<HTMLDivElement | null>(null);

  /** host focus-in seam: focus the first interactive element (the format
      select, DOM order — the pad is pointer-only by design) */
  export function focusFirst(): void {
    rootEl
      ?.querySelector<HTMLElement>('select, input, button, [tabindex]:not([tabindex="-1"])')
      ?.focus();
  }
</script>

<div
  bind:this={rootEl}
  data-jx-color-picker-editor
  class={cn('jx-color-picker-editor flex flex-col gap-2.5', className)}
>
  <!-- the SV pad and the hue rail are DECORATIVE input aids
       (aria-hidden, E-5 2026-09-02): they are pointer-only surfaces —
       the semantic paths are the value input, the format select and
       the Swatches grid (plus the host lane's native field/swatch).
       Their dots' #000 halo lives in color-picker.css (the
       color-space-constant exemption, E-6) -->
  <div
    bind:this={svEl}
    aria-hidden="true"
    class="jx-color-picker-sv relative [direction:ltr] w-full h-[150px] border border-border bg-[hsl(var(--jx-color-picker-hue)_100%_50%)] cursor-crosshair touch-none select-none"
    style="--jx-color-picker-hue: {hue}"
    onpointerdown={onSvDown}
    onpointermove={(event) => dragSV && svFromPointer(event)}
    onpointerup={(event) => (dragSV = endDrag(svEl, event, dragSV) ? false : dragSV)}
    onpointercancel={(event) => (dragSV = endDrag(svEl, event, dragSV) ? false : dragSV)}
  >
    <span
      data-jx-color-picker-dot
      class="absolute w-2.5 h-2.5 rounded-full bg-transparent border border-white pointer-events-none"
      style="inset-inline-start: calc({sat * 100}% - 5px); top: calc({(1 - val) * 100}% - 5px)"
    ></span>
  </div>

  <div
    bind:this={hueEl}
    data-jx-color-picker-hue
    aria-hidden="true"
    class="relative [direction:ltr] w-full h-3 border border-border cursor-crosshair touch-none select-none bg-[linear-gradient(to_right,hsl(0_100%_50%),hsl(60_100%_50%),hsl(120_100%_50%),hsl(180_100%_50%),hsl(240_100%_50%),hsl(300_100%_50%),hsl(360_100%_50%))]"
    onpointerdown={onHueDown}
    onpointermove={(event) => dragHue && hueFromPointer(event)}
    onpointerup={(event) => (dragHue = endDrag(hueEl, event, dragHue) ? false : dragHue)}
    onpointercancel={(event) => (dragHue = endDrag(hueEl, event, dragHue) ? false : dragHue)}
  >
    <span data-jx-color-picker-dot data-jx-color-picker-dot-hue class="absolute top-1/2 -translate-y-1/2 w-2.5 h-2.5 rounded-full bg-transparent border border-white pointer-events-none" style="inset-inline-start: calc({(hue / 360) * 100}% - 5px)"></span>
  </div>

  <!-- LAYOUT LAW (final-check report): the VALUE ROW is the column's
       width driver — the input lane is sized for the WORST-case
       notation (26 mono chars "oklch(0.999 0.412 359.999)" + the
       shell's own padding ⇒ min-w-[29ch]) and the Eye Dropper rides
       its end as an icon-button. The pad and the hue bar span the
       FULL column so every edge flushes — no ragged 200px/256px mix.
       The format select takes its own compact row below. -->
  <div class="flex items-center gap-1.5">
    <!-- icon={null}: the hex value lane is a notation field, not prose —
         the Type T would be noise beside the swatch column -->
    <Input
      data-jx-color-picker-input
      class="font-mono text-[13px] min-w-[29ch]"
      bind:value={textDraft}
      onchange={commitText}
      icon={null}
    />
    {#if canPick}
      <IconButton variant="outline" iconOnly text="Pick from screen" onclick={pickFromScreen}>
        {#snippet icon()}
          <!-- the pipette glyph through the Icon component (currentColor
               ink; sw 2 = the component default) -->
          <!-- IconButton sizes nothing itself (bring-your-own-glyph law)
               — the consuming wrapper flexes, the component owns the
               15px box -->
          <span class="inline-flex"><Icon name="pipette" size={15} /></span>
        {/snippet}
      </IconButton>
    {/if}
  </div>

  <NativeSelect
    data-jx-color-picker-format
    class="text-xs"
    value={formatMode}
    onchange={setFormat}
    aria-label="color format"
  >
    <option value="hex">hex</option>
    <option value="hsl">hsl</option>
    <option value="oklch">oklch</option>
  </NativeSelect>

  <!-- the shared preset palette (the embeddable half the Input picker
       bridge also mounts); picking stays in the workshop — no close.
       The grid is a fixed 8×22px track block — center it in the column -->
  <div class="flex justify-center">
    <Swatches value={swatch} onpick={pickSwatch} />
  </div>
</div>
