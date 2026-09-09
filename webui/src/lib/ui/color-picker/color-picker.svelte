<!--
  jixoai color picker (registry/files/ui/color-picker/color-picker.svelte).

  2026-09-01 · NATIVE REBASE (the standing Owner law, restated by the
  range rebase the same day): jx-pure is the foundation — the registry
  component's job is richer slots + more semantic development, NEVER a
  re-drawn simulation of a native control. The 2026-08-20 build made
  the whole value surface div-built (a button trigger with painted
  spans, zero native inputs). That era is retired:

  - the FIELD is a REAL input[type=text] — it carries the value, is
    the label[for] target (labelable), submits under name= through its
    own FormData lane, and owns native focus, selection, autocomplete
    and disabled semantics. No jx-form-field bridge (the old
    simulation era's shadow system — range.svelte law).
  - the SWATCH is a REAL input[type=color] styled to the swatch chrome
    (appearance-none + the component hook). Clicking it opens the
    ENGINE picker in WebKit/Firefox — a feature: every input mode
    gets a picker even without the panel. The custom editor below
    remains the rich path.
  - the SV pad and the hue rail STAY custom (a 2D saturation/value
    plane and a hue rail are picker surfaces no native element
    provides — the same legitimacy class as date-picker's calendar
    grid). Their pointer math lives in editor.svelte; every value
    flows through the SAME state the native inputs bind (one truth).

  Orthogonal intents:
  1. trigger lane — the family shell paint (1px border shell, radius 0,
     inset focus law) wrapping the native swatch input, the native
     text field and the chevron button that flips while open. error →
     "! message" line + dashed border + aria wiring on the field.
  2. popover — native popover="auto" + popovertarget on the chevron
     (light dismiss, Escape, top layer for free), CSS Anchor
     Positioning under the lane with flip-block fallback; engines
     without anchors get the authored viewport-center fallback
     (select.svelte law). ontoggle syncs aria-expanded and restitutes
     focus to the field on every close.
  3. editor delegation (2026-08-28 pure-register fusion) — the panel
     body IS editor.svelte, the embeddable professional editor
     (SV pad + hue bar + format switch + value input + Eye Dropper +
     Swatches). The host seeds the editor's NOTATION by
     canonicalizing the initial color through `format`; picks forward
     VERBATIM to the bindable value; external value writes pass
     through RAW and the editor re-seats its pad.
  4. one truth — four entry surfaces (field typing, native swatch
     pick, editor drag, external bind write) all funnel through the
     bindable `value` string. Field and swatch commits canonicalize
     through the ACTIVE notation (inferred from the editor seed the
     host tracks); the editor's in-panel format switch changes that
     notation by re-emitting the same color in the new one.

  5. invalid-color policy (E-9, 2026-09-02 — the RULE the three
     surfaces follow): an unparseable color string is PRESERVED RAW.
     The $bindable keeps the raw string; the field displays it (the
     free-typing draft law: change commits parse-or-revert); the
     picker's own projection (the editor seat, the swatch's hex
     derivation) keeps the LAST VALID color — the one-truth split: the
     value lane goes raw, the seats never go invalid — until a
     parseable value replaces it. Consumers surface the error state
     themselves through the `error` prop (aria-invalid + describedby
     on the field); this component never silently canonicalizes a
     string it could not parse.

  6. form reset (E-4, the toggle-group law) — the platform restores
     the field's own value (the markup value at parse time) but fires
     no input/change events; the reset listener re-syncs the bindable,
     the field draft and the editor seed once the browser has applied
     the reset.

  The panel surface is the terminal bezel (var(--terminal) in both
  modes) — the same law as the Select panel. Reduced motion: nothing
  animates during drag (markers track the pointer directly); only the
  chevron flip is transitioned and neutralized.

  tw4: lane/swatch/chevron static paint is token/arbitrary utilities
  in the markup; the native-face builds (appearance-none swatch +
  color-swatch pseudos, the chromeless text lane) and the
  anchor-positioned panel live in color-picker.css keyed on the
  component hooks (D1-exempt residue under the layer law — the
  range.css precedent).

  Motion kernel (2026-08-25): the panel rides the shared surface
  motion kernel (lib/surface-motion.ts; popover.svelte wiring law) —
  WAAPI animates the single --jx-p progress number, jixoai.css
  formulas paint every visible property; the toggle seam plays 1/0
  with start/stopTracking, reading open state LIVE from
  :popover-open. The real shadow layer is a DOM child
  (data-jx-color-picker-shadow) because WAAPI cannot animate
  pseudo-elements. Drags never animate — the kernel only owns the
  panel's enter/exit.
-->
<script lang="ts">
  import type { HTMLInputAttributes } from 'svelte/elements';
  import { onDestroy, type Snippet } from 'svelte';
  import { createSurfaceMotion } from '$lib/surface-motion';
  import { cn } from '$lib/utils';
  import type { Density } from '$lib/density.svelte';
  import { ColorPickerDefaults, type ColorPickerSurfaceVariant } from './color-picker-defaults.svelte';
  import Editor from './editor.svelte';
  import './color-picker.css';
  import { formatColor, parseColor, type ColorFormat, type Oklch } from '$lib/color-utils';

  // native passthrough (the input.svelte law): the interface rides the
  // platform's own attribute surface; the rest spread lands on the
  // FIELD — the labeled, named, focusable value surface of the lane
  // (the swatch and the chevron keep their own chrome wiring)
  interface Props extends HTMLInputAttributes {
    /** committed color string; bind:value — notation follows `format` */
    value?: string;
    /** output/input notation (default 'hex') */
    format?: ColorFormat;
    /** form field name — the native text field submits its string under it */
    name?: string;
    /** field label; renders label[for] above the lane, binding the text field */
    label?: string;
    /** error text → "! message" line + dashed lane border + field aria wiring */
    error?: string;
    /** the platform's own disabled semantics (field, swatch, chevron) */
    disabled?: boolean;
    /** floating-surface variant: solid | acrylic | auto (acrylic unless
        the environment asks for reduced transparency; the bezel fill
        follows the variant through the jx-surface fill props);
        omitted → the contract's own 'auto' (ColorPickerDefaults) */
    variant?: ColorPickerSurfaceVariant;
    /** mount the native input[type=color] swatch (default true) — the
        engine picker path on the lane */
    showSwatch?: boolean;
    /** show the value text lane (default true) — false keeps the native
        text field mounted (value/name/ARIA contract intact) but
        visually collapsed to the sr-only lane */
    showValue?: boolean;
    /** the Owner's slot ask (2026-09-02 color rebase): a custom LANE
     *  rendered beside the law-face swatch — the input-color base plus
     *  a slot, richer customization. The DEFAULT lane (no snippet) is
     *  the input-text; with `lane`, YOUR content owns the visible spot
     *  and the native text field goes sr-only (label[for]/name/ARIA
     *  survive untouched — the showValue precedent). The snippet sees
     *  the live draft text and the open state. */
    lane?: Snippet<[lane: { text: string; open: boolean; disabled: boolean }]>;
    /** wired into label[for] / error[id]; auto-generated when omitted */
    id?: string;
    class?: string;
    density?: Density;
    'data-density'?: string;
    /** caller-supplied validation relations — used only when the
        control's own error wiring is absent (the input.svelte merge) */
    'aria-invalid'?: 'true' | 'false' | undefined;
    'aria-describedby'?: string | undefined;
  }

  // $props.id() must live in its own top-level initializer (compiler law)
  const autoId = $props.id();

  let {
    value = $bindable('#000000'),
    format = 'hex',
    name,
    label,
    error,
    disabled = false,
    showSwatch = true,
    showValue = true,
    lane = undefined,
    id = autoId,
    variant,
    class: className = '',
    density,
    'data-density': _callerDensity,
    'aria-invalid': ariaInvalid,
    'aria-describedby': ariaDescribedBy,
    ...rest
  }: Props = $props();

  // the family Defaults is the single read point (context-defaults-
  // economy 3.1): variant rides the literal slot (own 'auto', ambient
  // when a surface axis opens), density the no-opinion axis slot
  const d = $derived(ColorPickerDefaults.resolve({ variant, density }));

  const panelId = $derived(`${id}-panel`);
  // CSS custom-ident-safe anchor name (select.svelte law)
  const anchorName = $derived(`--jx-color-picker-${id.toLowerCase().replace(/[^a-z0-9]+/g, '-')}`);

  const errorId = $derived(`${id}-error`);
  const invalid = $derived(error != null && error !== '');
  // the error law outranks caller aria, but never DROPS it (input.svelte)
  const describedBy = $derived(invalid ? errorId : ariaDescribedBy);
  const invalidAttr = $derived(invalid ? 'true' : ariaInvalid);

  // ---- editor wiring: notation seed + verbatim pick forwarding ----------
  const initial = parseColor(value) ?? ({ l: 0, c: 0, h: 0 } satisfies Oklch);
  /** the editor seed: the initial color rendered in the `format` notation —
      the editor infers its format mode from this string, so the format
      prop keeps deciding the emitted notation across the extraction.
      Mount-time seed by contract: external writes ride the $effect below */
  // svelte-ignore state_referenced_locally
  let editorValue = $state(formatColor(initial, format));
  /** the last string WE forwarded — external changes never match it */
  let lastEmitted = value;
  /** live text in the native field — the bind draft (free typing);
      change events commit it (parsed → canonical, invalid → revert) */
  // svelte-ignore state_referenced_locally
  let fieldText = $state(value ?? '');

  /** the ACTIVE notation — inferred from the editor seed the host owns
      (seeded through `format`, carried by every verbatim pick), so field
      and swatch commits canonicalize into the notation the panel is
      currently emitting */
  const activeFormat = $derived(inferFormat(editorValue));

  function inferFormat(text: string | undefined): ColorFormat {
    const t = text?.trim().toLowerCase() ?? '';
    if (t.startsWith('hsl')) return 'hsl';
    if (t.startsWith('oklch')) return 'oklch';
    return 'hex';
  }

  /** the hex6 projection the native input[type=color] binds (the element
      only accepts #rrggbb — the notation lane stays the text field) */
  const swatchHex = $derived(formatColor(parseColor(editorValue) ?? initial, 'hex'));

  /** ONE commit path: every surface funnels here (the editor's continuous
      pick, the native swatch's input event, the field's parsed change) */
  function commit(color: string): void {
    lastEmitted = color;
    editorValue = color;
    fieldText = color;
    value = color;
  }

  /** the editor's continuous commit: forward verbatim to the bindable
      value (the raised string already carries the active notation) */
  function handlePick(color: string): void {
    commit(color);
  }

  /** the native swatch pick: the engine hands #rrggbb — canonicalize
      through the ACTIVE notation so a hex pick never rewrites an
      oklch/hsl picker's value surface */
  function onSwatchInput(event: Event): void {
    const parsed = parseColor((event.currentTarget as HTMLInputElement).value);
    if (parsed) commit(formatColor(parsed, activeFormat));
  }

  /** the field's change commit (Enter / blur): parse any notation,
      canonicalize into the active one; invalid drafts revert to the
      last committed string (the editor's commitText law) */
  function onFieldChange(event: Event): void {
    const parsed = parseColor((event.currentTarget as HTMLInputElement).value);
    if (parsed) commit(formatColor(parsed, activeFormat));
    else fieldText = lastEmitted ?? '';
  }

  // external value writes (bindings, resets) pass through RAW — the
  // editor re-parses and re-seats its own pad and text draft, and the
  // native field re-displays the raw string (the E-9 policy: an
  // unparseable write is preserved, not silently canonicalized). An
  // INVALID write still consumes the channel (lastEmitted tracks it,
  // so the write is never re-processed) and re-displays raw — only the
  // picker's own projection (editorValue, the swatch/pad seats derived
  // from it) keeps the LAST VALID color until a parseable write lands
  $effect(() => {
    if (value === lastEmitted) return;
    const raw = value ?? '';
    lastEmitted = raw;
    fieldText = raw;
    if (parseColor(raw)) editorValue = raw;
  });

  // ---- form reset sync (E-4, the toggle-group law) ----------------------
  // the platform restores the FIELD's own value (its markup value at
  // parse time) but fires no input/change events — the one-truth state
  // stays stale. Re-read once the browser has applied the reset; the
  // raw string is preserved (E-9), the editor re-seats only when it
  // parses (the pad's own fallback renders black otherwise).
  $effect(() => {
    if (!fieldEl) return;
    const form = fieldEl.closest('form');
    form?.addEventListener('reset', onFormReset);
    return () => form?.removeEventListener('reset', onFormReset);
  });
  function onFormReset(): void {
    queueMicrotask(() => {
      const raw = fieldEl?.value ?? '';
      if (raw === lastEmitted) return;
      lastEmitted = raw;
      fieldText = raw;
      value = raw;
      if (parseColor(raw)) editorValue = raw;
    });
  }

  // ---- popover orchestration (select.svelte toggle law) -----------------
  let open = $state(false);
  let fieldEl = $state<HTMLInputElement | null>(null);
  let panelEl = $state<HTMLDivElement | null>(null);
  // the anchor wrapper — the enter kernel measures the slide direction
  // against it at every open
  let anchorEl = $state<HTMLElement | null>(null);

  // THE orchestration seam: one native event covers every open/close path
  // (popovertarget click, light dismiss, Escape). Open state is read LIVE
  // from :popover-open at fire time — ToggleEvent state fields are never
  // trusted (popover.svelte law).
  function onPanelToggle(): void {
    open = panelEl?.matches(':popover-open') ?? false;
    if (open) {
      motion.play(1);
      motion.startTracking();
    } else {
      panelEl?.classList.remove('jx-rest');
      motion.play(0);
      motion.stopTracking();
      fieldEl?.focus(); // focus restitution on every close path
    }
  }

  // ── MOTION KERNEL — the shared declarative half (r29): see
  // lib/surface-motion.ts. WAAPI animates ONE @property number
  // (--jx-p); every visible property is a CSS formula of it (the
  // declarative motion law in jixoai.css). The kernel here only wires
  // the panel's toggle seam and live anchor
  const motion = createSurfaceMotion(() => panelEl, { anchor: () => anchorEl });

  onDestroy(() => motion.destroy());
</script>

<div data-density={d.density} class={'jx-field ' + className}>
  {#if label}<label class="jx-label" for={id}>{label}</label>{/if}

  <!-- the trigger lane: the shell owns the box law (input.svelte law);
       the native controls inside are chromeless. The anchor wrapper is
       the span itself so the panel centers on the whole lane -->
  <span
    data-jx-color-picker-wrap
    class="jx-color-picker-trigger relative flex items-center w-full border border-border rounded-none bg-background text-foreground transition-[box-shadow,border-color] duration-150 ease-out"
    style="anchor-name: {anchorName}"
    bind:this={anchorEl}
  >
    {#if showSwatch}
      <!-- the NATIVE picker path: a real input[type=color] in the swatch
           chrome — WebKit/Firefox open the engine picker on click. The
           swatch SHARES the field's error wiring (E-11): both native
           controls inside the lane answer the one "! message" line -->
      <input
        type="color"
        data-jx-color-picker-swatch
        value={swatchHex}
        aria-label="system color picker"
        aria-describedby={describedBy}
        {disabled}
        oninput={onSwatchInput}
      />
    {/if}
    <!-- the FIELD: a REAL input[type=text] carrying the value — the
         label[for] target, the name= FormData lane, native focus and
         selection. showValue=false keeps the value contract intact as
         the sr-only native field (the text is hidden, the value
         surface never becomes a div). The rest spread lands HERE (the
         field is the lane's semantic surface: aria-label without a
         label, title, data-testid, placeholder…) and sits BEFORE the
         component-owned wiring, so type/autocomplete/aria can never be
         hijacked through it (input.svelte law) -->
    <input
      bind:this={fieldEl}
      id={id}
      {...rest}
      type="text"
      data-jx-color-picker-field
      class={cn('font-mono', (!showValue || lane) && 'sr-only')}
      {name}
      {disabled}
      bind:value={fieldText}
      spellcheck="false"
      autocomplete="off"
      autocapitalize="none"
      aria-invalid={invalidAttr}
      aria-describedby={describedBy}
      onchange={onFieldChange}
    />
    {#if lane}
      <!-- the Owner's slot lane (2026-09-02 rebase): consumer content
           owns the visible spot; the native field above went sr-only —
           one truth (the bindable value), any face -->
      <div data-jx-color-picker-lane="" class="flex min-w-0 flex-1 items-center gap-2">
        {@render lane({ text: fieldText, open, disabled })}
      </div>
    {/if}
    <button
      type="button"
      class={cn(
        'jx-color-picker-chevron flex-none w-3 h-3 border-0 bg-transparent p-0 text-muted-foreground transition-transform duration-150 ease-out',
        open && 'rotate-180',
      )}
      popovertarget={panelId}
      aria-label="open color picker"
      aria-haspopup="true"
      aria-expanded={open}
      aria-controls={panelId}
      {disabled}
    ></button>
  </span>

  <div
    bind:this={panelEl}
    id={panelId}
    popover="auto"
    class={cn('jx-color-picker-panel jx-surface', motion.supported && 'jx-waapi')}
    data-variant={d.variant}
    role="group"
    aria-label="color picker"
    style="position-anchor: {anchorName}; inset-area: bottom span-all; position-area: bottom span-all;"
    ontoggle={onPanelToggle}
  >
    <!-- the REAL shadow layer: a DOM child because pseudo-elements are
         unreachable from WAAPI — the kernel animates it in lockstep
         (Owner ruling r18) -->
    <div data-jx-color-picker-shadow="" class="jx-surface-shadow" aria-hidden="true"></div>
    <!-- surface body (bezel paint + ::after shadow + the flex column);
         the popover element paints nothing (floating-surface law arch
         r3) — the column content is the embeddable Editor -->
    <div data-jx-color-picker-surface class="jx-surface-body flex flex-col gap-2.5 p-3">
    <Editor value={editorValue} onpick={handlePick} />
    </div>
  </div>

  {#if invalid}
    <p id={errorId} class="jx-error"><span class="jx-error-mark" aria-hidden="true">!</span>{error}</p>
  {/if}
</div>
