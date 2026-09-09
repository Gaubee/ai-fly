<!--
  jixoai select (registry/files/ui/select/select.svelte).
  The RICH sibling of native-select.svelte: a custom listbox for when the
  native popup can't say what you need — per-option descriptions, a fully
  painted panel, presentation that must match the site, not the UA. For
  plain form submission or mobile reach for NativeSelect instead (a real
  name/value pair in FormData, the platform's overlay picker on touch).

  NativeHTML orchestration on the Popover base (popover.svelte law): the
  panel carries popover="auto" and the trigger is wired with
  popovertarget, so light dismiss (outside click), Escape, one-auto-
  popover-at-a-time, and top-layer rendering are ALL browser-native; the
  anchor is CSS Anchor Positioning (anchor-name on the wrapper,
  position-anchor + position-area + position-try-fallbacks on the panel;
  engines without it fall back to authored viewport-center). The JS on
  top is orchestration only: aria-expanded sync + focus restitution via
  the native toggle event, focus into the list, and roving highlight
  (aria-activedescendant) for ↑/↓/Home/End/Enter — exactly the parts the
  platform doesn't give a listbox.

  Panel surface law (language-switcher menu + tree-view row precedent):
  the panel is a terminal bezel — background var(--terminal), foreground
  var(--terminal-foreground) in BOTH modes — so the selected row
  (var(--terminal-hover) fill + 2px var(--primary) edge line) stays
  readable in light and dark alike. The edge line uses LOGICAL
  border-inline-start, so under dir="rtl" it flips to the inline-start
  (right) edge automatically; every other offset in this file is logical
  too.

  Trigger: visually the closed native select (1px var(--border) shell,
  radius 0, chevron that flips while open, inset focus law) but a real
  <button> — label[for] binds to it, aria-haspopup="listbox" +
  aria-expanded ride along, and ↑/↓ open it like the native control.

  NativeHTML base audit (2026-08-20, updated by the form-field bridge the
  same day): NO native <select> hides inside — a <button> trigger carries
  no name/value pair of its own (NativeSelect keeps the plain-native
  route). Form association rides the FACELESS jx-form-field bridge
  (registry/files/lib/form-field.ts): a display:contents form-associated
  custom element fed name/value/disabled attributes; the committed VALUE
  (never the label) reaches FormData through ElementInternals, form reset
  bubbles back as jx-reset, form/fieldset disable as jx-disabled. Style,
  structure and ARIA stay in this file — the bridge owns no paint.

  tw4 (2026-08-24): trigger/rows/scroll static paint is token utilities
  in the markup (markup-known states — selected/active/disabled rows, the
  open chevron flip — ride conditional utilities); the .jx-field scaffold
  is consumed from jx-pure Part A. Only the anchor-positioned panel
  (static residue with its @supports fallback + ::backdrop), the
  hover/focus/disabled state machines and the reduced-motion kill remain
  in select.css (D1-exempt residue under the layer law).

  Surface motion kernel (2026-08-25): popover.svelte law adopted — the
  toggle seam drives the shared WAAPI kernel (lib/surface-motion.ts)
  against the live wrap anchor; the panel carries jx-waapi behind
  motion.supported plus the REAL .jx-surface-shadow child; jixoai.css
  owns every visible formula.
-->
<script module lang="ts">
  /** One row of the Select listbox. */
  export interface SelectOption {
    /** the committed value ($bindable value on the field) */
    value: string;
    /** the row's (and the trigger's) display text */
    label: string;
    /** optional muted second line rendered inside the panel only */
    description?: string;
    /** unselectable row — skipped by keyboard navigation and click */
    disabled?: boolean;
  }
</script>

<script lang="ts">
  // side-effect import: registers the faceless <jx-form-field> element
  // (client-only, idempotent) that carries this field's form association
  import '$lib/form-field';
  import { onDestroy } from 'svelte';
  import type { HTMLButtonAttributes } from 'svelte/elements';
  import { createSurfaceMotion } from '$lib/surface-motion';
  import { cn } from '$lib/utils';
  import type { Density } from '$lib/density.svelte';
  import { SelectDefaults } from './select-defaults.svelte';
  import './select.css';

  interface Props extends HTMLButtonAttributes {
    /** the full option list (order = panel order) */
    options: SelectOption[];
    /** density policy: explicit, inherited, then default */
    density?: Density;
    /** committed value; bind:value — undefined shows the placeholder */
    value?: string;
    /** trigger text when nothing is selected */
    placeholder?: string;
    /** field label; renders label[for] above the control */
    label?: string;
    /** form field name — the bridge submits the committed VALUE under it */
    name?: string;
    /** wired into label[for] / error[id]; auto-generated when omitted */
    id?: string;
    /** error text → aria-invalid + aria-describedby + dashed border */
    error?: string;
    /** NOT implemented in v1 — reserved extension direction (multi-
        select listbox); accepted for API stability, ignored with a
        console warning */
    multiple?: boolean;
    /** floating-surface variant: solid | acrylic | auto (acrylic unless
        the environment asks for reduced transparency; the bezel fill
        follows the variant through the jx-surface fill props) */
    variant?: 'solid' | 'acrylic' | 'auto';
  }

  // $props.id() must live in its own top-level initializer (compiler law)
  const autoId = $props.id();

  let {
    options,
    density,
    'data-density': _callerDensity,
    value = $bindable(),
    placeholder = 'Select...',
    label,
    name,
    id = autoId,
    error,
    disabled = false,
    multiple = false,
    variant = 'auto',
    class: className = '',
    ...rest
  }: Props = $props();

  // form lifecycle: what jx-reset restores, and the form-disable mirror
  const initialValue = value;
  // the family Defaults is the single read point (context-defaults-
  // economy 3.1): explicit ?? ambient/own per slot, one line, no legacy
  // helper channels. variant keeps its inline default + inline union:
  // this Props interface feeds the GENERATED meta chain (drift-locked),
  // whose ambient annotation is the doc batch's 先破再立 — the
  // contract's own 'auto' is the same value (select-defaults.svelte.ts)
  const d = $derived(SelectDefaults.resolve({ variant, density }));
  let formDisabled = $state(false);
  const isDisabled = $derived(disabled || formDisabled);

  const panelId = $derived(`${id}-panel`);
  const listboxId = $derived(`${id}-listbox`);
  // Anchor names are CSS custom-ident-ish: sanitize the id into a stable
  // dashed token so any consumer id yields a valid --jx-sel-* name.
  const anchorName = $derived(`--jx-sel-${id.toLowerCase().replace(/[^a-z0-9]+/g, '-')}`);
  const optionId = (index: number): string => `${id}-opt-${index}`;

  const errorId = $derived(`${id}-error`);
  const invalid = $derived(error != null && error !== '');
  const describedBy = $derived(invalid ? errorId : undefined);
  const invalidAttr = $derived(invalid ? 'true' : undefined);

  const selected = $derived(options.find((option) => option.value === value));

  let open = $state(false);
  /** roving highlight index (-1 = none) — the keyboard/aria cursor */
  let active = $state(-1);
  let triggerEl = $state<HTMLButtonElement | null>(null);
  let panelEl = $state<HTMLDivElement | null>(null);
  let listEl = $state<HTMLUListElement | null>(null);
  // the wrap span carrying anchor-name — the motion kernel measures the
  // slide axis panel↔anchor against it, live
  let anchorEl = $state<HTMLElement | null>(null);

  // v1: `multiple` is a reserved extension direction — say so loudly
  // instead of silently ignoring a prop the caller believes in.
  $effect(() => {
    if (multiple) {
      console.warn(
        'jixoai Select: the multiple prop is not implemented in v1 (reserved extension direction) and is ignored.'
      );
    }
  });

  function firstEnabled(): number {
    return options.findIndex((option) => !option.disabled);
  }
  function lastEnabled(): number {
    for (let i = options.length - 1; i >= 0; i--) if (!options[i].disabled) return i;
    return -1;
  }

  /** step the highlight by delta, skipping disabled rows, clamped at the
      ends (APG listbox: no wrap — Home/End cover the jumps) */
  function moveActive(delta: 1 | -1): void {
    let i = active;
    for (let steps = 0; steps < options.length; steps++) {
      i += delta;
      if (i < 0 || i >= options.length) return;
      if (!options[i].disabled) {
        active = i;
        return;
      }
    }
  }

  function choose(option: SelectOption): void {
    if (option.disabled) return; // a disabled row neither selects nor closes
    value = option.value;
    panelEl?.hidePopover(); // the toggle handler restitutes focus
  }

  // THE orchestration seam: one native event covers every open/close path
  // (popovertarget click, light dismiss, Escape, our own hide/show calls).
  // Open is read LIVE from :popover-open (popover.svelte law — ToggleEvent
  // state fields are never trusted); the motion calls bracket the
  // unchanged orchestration inside each branch.
  function onPanelToggle(): void {
    open = panelEl?.matches(':popover-open') ?? false;
    if (open) {
      motion.play(1);
      motion.startTracking();
      // continue from context, like the native select: highlight the
      // selected row, else the first enabled one
      const selectedIndex = options.findIndex((option) => option.value === value);
      active = selectedIndex >= 0 ? selectedIndex : firstEnabled();
      // APG listbox-in-popover: focus moves into the list; the panel is
      // already in the top layer when toggle fires
      listEl?.focus();
    } else {
      panelEl?.classList.remove('jx-rest');
      motion.play(0);
      motion.stopTracking();
      // focus restitution on EVERY close path — light dismiss and Escape
      // are free from popover="auto"; this line covers the focus part
      triggerEl?.focus();
    }
  }

  // ── MOTION KERNEL — the shared declarative half (popover.svelte law,
  // lib/surface-motion.ts): WAAPI animates ONE @property number (--jx-p);
  // every visible property is a CSS formula of it (jixoai.css). Here it
  // wires only this panel's toggle seam and live wrap anchor
  const motion = createSurfaceMotion(() => panelEl, { anchor: () => anchorEl });
  onDestroy(() => motion.destroy());

  function onListKeydown(event: KeyboardEvent): void {
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      moveActive(event.key === 'ArrowDown' ? 1 : -1);
    } else if (event.key === 'Home') {
      event.preventDefault();
      const first = firstEnabled();
      if (first >= 0) active = first;
    } else if (event.key === 'End') {
      event.preventDefault();
      const last = lastEnabled();
      if (last >= 0) active = last;
    } else if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      const option = options[active];
      if (option && !option.disabled) choose(option);
    }
    // Escape needs no handler: popover="auto" closes on it natively
  }

  // native-select muscle memory: ↑/↓ on the closed trigger opens it
  function onTriggerKeydown(event: KeyboardEvent): void {
    if (!open && (event.key === 'ArrowDown' || event.key === 'ArrowUp')) {
      event.preventDefault();
      panelEl?.showPopover();
    }
  }

  // keep the highlight row visible when it moves off-panel
  $effect(() => {
    if (open && active >= 0) {
      document.getElementById(optionId(active))?.scrollIntoView({ block: 'nearest' });
    }
  });
</script>

<div class="jx-field" data-density={d.density}>
  <!-- faceless form bridge (form-field.ts law): the committed value rides
       ElementInternals into FormData; jx-reset / jx-disabled bubble the
       form lifecycle back into this component. Owns no box, no content —
       the `contents` utility keeps the prerendered HTML from flashing an
       extra flex gap pre-upgrade.
       disabled passes `|| undefined`: Svelte has no boolean-attribute
       semantics for custom elements and would render disabled="false"
       as a PRESENT attribute (presence = true in HTML). -->
  <jx-form-field
    class="contents"
    aria-hidden="true"
    {name}
    value={value ?? ''}
    disabled={isDisabled || undefined}
    onjx-reset={() => (value = initialValue)}
    onjx-disabled={(event: CustomEvent<boolean>) => (formDisabled = event.detail)}
  ></jx-form-field>
  {#if label}<label class="jx-label" for={id}>{label}</label>{/if}
  <span data-jx-sel-wrap class="relative block w-full max-w-full" style="anchor-name: {anchorName}" bind:this={anchorEl}>
    <!-- aria-invalid rides the trigger although the checker's per-role
         list doesn't include it: it IS a WAI-ARIA global state, and the
         family law wires invalid state on the control itself -->
    <!-- svelte-ignore a11y_role_supports_aria_props_implicit -->
    <!-- jx-html-input (B1, ui-plugin-followup): the trigger's form-lane
         law is the standard layer's text-like control box — border, hit,
         inset, text/leading, hover/focus/disabled/invalid states all
         single-sourced there; markup keeps only layout (flex row) and
         the closed-control cursor. Core utilities sort AFTER the custom
         @utility in the built sheet, so `flex` reliably overrides the
         law's display:block (probe-verified). -->
    <button
      bind:this={triggerEl}
      type="button"
      id={id}
      class={cn(
        'jx-sel-trigger jx-html-input flex items-center pe-[var(--jx-inset)] text-start cursor-pointer',
        className,
      )}
      popovertarget={panelId}
      aria-haspopup="listbox"
      aria-expanded={open}
      aria-controls={listboxId}
      aria-invalid={invalidAttr}
      aria-describedby={describedBy}
      disabled={isDisabled}
      onkeydown={onTriggerKeydown}
      {...rest}
    >
      <span
        data-jx-sel-value
        data-jx-sel-placeholder={!selected ? '' : undefined}
        class={cn(
          'flex-1 min-w-0 overflow-hidden text-ellipsis whitespace-nowrap text-start',
          !selected && 'text-muted-foreground',
        )}
      >
        {selected?.label ?? placeholder}
      </span>
      <!-- the chevron = an ICON SLOT (B1): the span paints currentColor
           through the mask on --jx-icon-chevron (the same slot
           jx-html-select reads), so a face/plugin override re-skins the
           composite and the native control with one variable. The inline
           lucide SVG fallback default keeps the glyph without the sheet.
           Size = var(--jx-icon) — the density kernel's icon law
           (mediaIcon_d = line height), the same equation jx-html-select
           paints its background glyph at; the glyph's own box padding is
           the value→chevron optical gap (the native law's text reserve
           inset+icon, no extra flex gap). -->
      <span
        class={cn(
          'jx-sel-chevron flex-none w-[var(--jx-icon)] h-[var(--jx-icon)] pointer-events-none text-muted-foreground transition-transform duration-150 ease-out',
          open && 'rotate-180',
        )}
        aria-hidden="true"
      ></span>
    </button>
  </span>

  <div
    bind:this={panelEl}
    id={panelId}
    popover="auto"
    class={cn('jx-sel-panel jx-surface', motion.supported && 'jx-waapi')}
    data-variant={d.variant}
    data-density={d.density}
    style="position-anchor: {anchorName}; inset-area: bottom span-all; position-area: bottom span-all;"
    ontoggle={onPanelToggle}
  >
    <!-- surface body (bezel paint + ::after shadow) + scroll ring
         (floating-surface law arch r3: the platform element paints
         nothing; the bezel fill resolves through the panel's fill
         props cascading into the body) -->
    <div data-jx-sel-panel-shadow="" class="jx-surface-shadow" aria-hidden="true"></div>
    <!-- the REAL shadow layer: a DOM child because pseudo-elements are
         unreachable from WAAPI — the kernel animates it in lockstep
         (Owner ruling r18) -->
    <div data-jx-sel-panel-body class="jx-surface-body">
    <div data-jx-sel-scroll class="max-h-[60vh] overflow-auto overscroll-contain [scrollbar-gutter:stable_both-edges] py-1 px-[max(4px_-_var(--jx-scrollbar-thin,0px),0px)]">
    <ul
      bind:this={listEl}
      id={listboxId}
      class="jx-sel-list m-0 p-0 list-none"
      role="listbox"
      tabindex="-1"
      aria-label={label ?? placeholder}
      aria-activedescendant={active >= 0 ? optionId(active) : undefined}
      onkeydown={onListKeydown}
    >
      {#each options as option, index (option.value)}
        <!-- option rows are click-only BY PATTERN: the keyboard path rides
             the focusable list (jx-sel-list keydown + aria-activedescendant
             roving highlight), never the row itself -->
        <!-- svelte-ignore a11y_click_events_have_key_events -->
        <li
          id={optionId(index)}
          role="option"
          aria-selected={option.value === value ? 'true' : 'false'}
          aria-disabled={option.disabled ? 'true' : undefined}
          data-jx-sel-active={index === active ? '' : undefined}
          data-jx-sel-selected={option.value === value ? '' : undefined}
          data-jx-sel-disabled={option.disabled ? '' : undefined}
          class={cn(
            'jx-sel-option flex flex-col gap-[var(--jx-gap)] px-[var(--jx-inset)] py-[var(--jx-gap)] min-h-[var(--jx-hit)] text-[length:var(--jx-text)] leading-[var(--jx-leading)] text-[color-mix(in_oklab,var(--terminal-foreground)_72%,transparent)] cursor-pointer border-s-2 [border-inline-start-color:transparent] transition-[background-color,color] duration-100 ease-out',
            index === active && 'bg-terminal-hover text-terminal-foreground',
            option.value === value && 'bg-terminal-hover text-terminal-foreground [border-inline-start-color:var(--primary)]',
            option.disabled && 'opacity-50 pointer-events-none',
          )}
          onclick={() => choose(option)}
        >
          <span data-jx-sel-option-label class="min-w-0 overflow-hidden text-ellipsis whitespace-nowrap">{option.label}</span>
          {#if option.description}
            <span data-jx-sel-option-desc class="text-[11px] leading-[1.4] text-[color-mix(in_oklab,var(--terminal-foreground)_55%,transparent)]">{option.description}</span>
          {/if}
        </li>
      {/each}
    </ul>
    </div>
    </div>
  </div>

  {#if invalid}
    <p id={errorId} class="jx-error"><span class="jx-error-mark" aria-hidden="true">!</span>{error}</p>
  {/if}
</div>
