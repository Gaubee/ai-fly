<!--
  jixoai input (registry/files/ui/input/input.svelte).
  NativeHTML base field: the native <input> IS the contract — every type
  passes through untouched, no per-type wrappers. Rendering lanes by type:

    text-like (text/password/email/number/search/url/tel/date/time/...)
      1px var(--border) shell, var(--background) fill, radius 0 — the
      elevation grammar's WELL tier: inset shadow at rest, hover
      deepens the intensity only, focus tints border + caret; the
      keyboard ring stays the site's inset 1px outline law
      (outline-offset: -1px on the ring token).
    checkbox / radio / toggle / file
      SPLIT OUT — checkbox/radio/toggle redraw in their own components
      (checkbox.svelte, radio.svelte, toggle.svelte); the professional
      file picker (previews, variants, sizes, maxFiles) lives in
      file-input.svelte (2026-08-20). Passing any of these types here
      renders the plain native passthrough in the text shell — route
      them to the dedicated components.
    range
      the Tier-1 pure-CSS slider (.jx-slider in the jx-pure sheet):
      bordered thin track, square primary thumb, hover lift / press.
    color
      the Tier-1 color field (.jx-color-shell wrapper + .jx-color-swatch
      swatch): locked square swatch + pipette glyph.
    hidden
      bare passthrough, no chrome, no slots.

  2026-08-23 · Tier rebase (original request: "native-input styling
  overhaul — a pure HTML+CSS Tier-1 form layer + Tier-2 components
  consuming it"). The box/lane laws moved to the shared jx-pure
  sheet (registry item `jx-pure`, imported once from app.css after
  jixoai.css); this component keeps ONLY what is component-owned: the
  snippet slots, the clear button, and the outer slot spacing. The
  native-control styling (range track/thumb, color swatch + pipette
  glyph, date/time picker indicator, number spinners, placeholder
  distinction) all lives in Tier-1 so bare markup gets the same paint
  with zero JS.

  2026-08-29 · native-controls (original request: "the Input owns every
  control type" — OpenSpec 2026-08-29-input-native-controls). The
  custom-control story reaches full coverage and ONE prop governs it:

    type=number        the jx-number-shell modifier (input.css) hides
                       the platform spinners and a −/+ stepper pair
                       rides the prefix/suffix slot positions —
                       number-input-grade semantics (clamp/snap step
                       precision, 300ms→100ms hold acceleration,
                       disabled lockstep) but WITHOUT number-input's
                       composite: the <input> stays the source of truth
                       (stepping writes valueAsNumber-clamped values
                       through the SAME plumbing as typing) and keeps
                       native ↑/↓ + direct typing; only the visual
                       spinners are replaced.
    date/datetime-local/
    week/month/time    embedded Popover-API panels (see below)
    color              the Swatches editor

  The bare `native-controls` boolean opts any covered type back into
  the PLATFORM control — number → the spinner, picker types → the UA
  popup (the disabled-attribute philosophy: presence = true, absence =
  the library default; no compat alias for the retired native-picker
  name).

  Semantics added on top: label[for] (auto id via $props.id() when not
  supplied), error string → aria-invalid + aria-describedby + "! message"
  line + dashed control border. Everything else (placeholder, disabled,
  name, required, checked, accept, min/max/step…) flows through
  restProps onto the native element.

  2026-08-20 · InputGroup slot system (original request: "实现 InputGroup
  槽位体系，升级 Input 和 TextArea 组件"). Four snippet slots around the
  lanes (the text-like shell takes all four; range/color take only
  the outer pair):

    outerBlockStart   outside, above — replaces the label row when given
    innerInlineStart  inside the shell, left (prefix icon / unit)
    innerInlineEnd    inside the shell, right (suffix / unit / action)
    outerBlockEnd     outside, below — the error line still renders above

  The shell — not the <input> — owns border/fill/hover/focus, so slots
  never repaint the box law. Inner slots land muted at 0.75rem; the
  wrapper is utility-authored now, so override it with a plain utility
  (text-foreground) or an inline style. Overflow law for narrow hosts:
  the field shrinks (min-width 0) and the shell clamps (max-width
  100%) — inner slots keep flex:none while the input lane gives way,
  so a 390px viewport compresses the text lane, never the container.
  `clearable` adds an × button in
  the inline-end area: it clears the DOM value, syncs the bound value and
  re-emits `input` + a bubbling `clear` event. `value` is $bindable:
  bound ⇒ controlled; absent ⇒ the field stays purely uncontrolled
  (Svelte skips undefined writes, so FormData and form.reset() keep
  native behavior).

  tw4 (2026-08-24; mirror law 2026-08-27): the component-owned paint
  (the clear button's hit-lane geometry, the stepper pair's icon-button
  law) mirrors from input.css (@layer components :where()); the slot
  rows stay inline (one-off wrappers). ONLY the clear glyph's svg
  descendant sizing, the search-cancel pseudo kill and the clear
  hover/focus states remain as the D1-exempt residue.

  2026-08-30 · expand-form-family (F1): three family capabilities —
    count        the "n / max" CODE-POINT readout in the hint lane below
                 the shell; the cap rides the native maxlength (the
                 platform owns clamping); aria-live sits at off and
                 flips to polite near the limit (from 90% of the cap).
    reveal       type="password" renders the eye toggle by DEFAULT
                 (reveal={false} opts out); it starts HIDDEN — the VALUE
                 is never revealed by default — and flips only the
                 input's type between password/text. End-lane order:
                 innerInlineEnd snippet > clearable × > eye, each keeping
                 the --jx-hit edge-lane geometry (END-INSET OWNERSHIP).
    labelMode    'floating' renders the terminal BRACKET — the label
                 rides the shell's top border like a fieldset legend (a
                 recorded divergence from the SaaS in-field morph); the
                 ink state machine is pure CSS: :placeholder-shown
                 (committed ink) / :focus-visible (live ink) / :has
                 (error ink wins). Additive: a modifier class, the
                 default stacked paint untouched.

  2026-09-05 · the semantic glyph lane (Owner: "url/phone 等，都应该
  默认支持，并且支持配置 default-icon-position: start|end|null";
  same day: "给 type-text 也加上默认图标"). EVERY text-like type
  carries its recognition glyph by DEFAULT — url→link, tel→phone,
  email→mail, search→magnifier, text→the Type T; `icon` is tri-state:
  undefined = the per-type default, null = explicitly OFF (embedded
  lanes that paint their own glyphs opt out — the search palette's
  head, the color editor's value input), a snippet = custom.
  `iconPosition` pins the side (absent = null = inherit context).
  The unpinned side is CSS-OWNED (input.css order ladder): base LEADS
  (the full-width industry norm), a list-item trailing end lane rides
  the TRAILING edge (the lane's trailing-affordance line,
  select-chevron kin), and the lane's 30rem fold suspends back to
  leading — the inset-contract suspension precedent. The fold is a
  container-query state JS cannot see; that is exactly why this axis
  is CSS-owned end to end. The glyph extends `slotted` (the shell
  carries the inset) and stamps data-self-inset while it may trail
  (the end-inset ownership law — the lane then yields its padding).
-->
<script lang="ts">
  import type { HTMLInputAttributes } from 'svelte/elements';
    import { cn } from '$lib/utils';
  import { getContext } from 'svelte';
  import { CONTROL_CHROME_KEY, type ControlChrome } from '$lib/control-chrome.svelte';
  import type { Density } from '$lib/density.svelte';
  import { InputDefaults } from './input-defaults.svelte';
  import type { Snippet } from 'svelte';
  import { onDestroy } from 'svelte';
  import Icon from '$lib/ui/icon';
  import type { IconName } from '$lib/icon-set.gen';
  import Calendar from '../date-picker/calendar.svelte';
  import MonthGrid from '../date-picker/month-grid.svelte';
  import TimeStepper from '../date-picker/time-stepper.svelte';
  import { addDays, isoWeekOf, mondayOfIsoWeek, todayIso } from '../date-picker/calendar-math';
  import Editor from '../color-picker/editor.svelte';
  import { parseColor, formatColor } from '$lib/color-utils';
  import { createSurfaceMotion } from '$lib/surface-motion';
  import './input.css';

  interface Props extends HTMLInputAttributes {
    /** any native input type (default 'text') */
    type?: string;
    /** density policy: explicit, inherited, then default */
    density?: Density;
    /** field label; renders label[for] above the control.
        skipped when outerBlockStart takes the slot over */
    label?: string;
    /** wired into label[for] / error[id]; auto-generated when omitted */
    id?: string;
    /** error text → aria-invalid + aria-describedby + dashed border */
    error?: string;
    /** text-like only: × button in the inner-inline-end area */
    clearable?: boolean;
    /** text-like only: the "n / max" code-point readout in the hint lane
        below the shell (plain n without a maxlength). aria-live is OFF
        by default and flips to polite near the limit (from 90% of the
        cap) — the readout never chatters per keystroke (2026-08-30) */
    count?: boolean;
    /** password reveal toggle — DEFAULT ON for type="password" (the
        VALUE starts hidden; the toggle only flips the input's type
        between password/text). reveal={false} opts out. End-lane order:
        innerInlineEnd snippet > clearable × > eye (2026-08-30) */
    reveal?: boolean;
    /** label posture: 'stacked' (default) renders label[for] above the
        shell; 'floating' renders the terminal BRACKET — the label rides
        the shell's top border like a fieldset legend (a recorded
        divergence from the SaaS in-field morph), with the state machine
        pure CSS (:placeholder-shown / :focus-visible / :has) */
    labelMode?: 'stacked' | 'floating';
    /** inside the shell, left of the input (prefix icon / unit) */
    innerInlineStart?: Snippet;
    /** inside the shell, right of the input (suffix / unit / action) */
    innerInlineEnd?: Snippet;
    /** the semantic glyph, tri-state: undefined = the per-type default
     *  (url→link, tel→phone, email→mail, search→magnifier, text→the
     *  Type T); null = explicitly OFF (embedded lanes that paint their
     *  own glyphs opt out); a snippet = the custom glyph */
    icon?: Snippet | null;
    /** pin the glyph's side; absent = null = inherit context — the
     *  shell's css leads by default, a list-item trailing lane rides
     *  the trailing edge, and the lane's 30rem fold suspends back to
     *  leading (the inset-contract suspension precedent: the fold is
     *  a container query, invisible to JS, so the axis is CSS-owned) */
    iconPosition?: 'start' | 'end';
    /** outside the shell, above — replaces the label prop when given */
    outerBlockStart?: Snippet;
    /** outside the shell, below — renders below the error line */
    outerBlockEnd?: Snippet;
    /** $bindable; bound ⇒ controlled, absent ⇒ purely uncontrolled */
    value?: string | number;
    /** caller-supplied validation relations — used only when the
        control's own error wiring is absent (the ItemField adapters
        own the error text; their computed chains must survive) */
    'aria-invalid'?: 'true' | 'false' | undefined;
    'aria-describedby'?: string | undefined;
    /** custom-control policy: the Input owns every covered control by
        default — number → the −/+ stepper pair, picker types
        (date/datetime-local/week/month/time → embedded panels,
        color → the Swatches editor). The bare boolean attribute opts
        back into the PLATFORM control — <Input type="number"
        native-controls /> keeps the spinner, <Input type="date"
        native-controls /> keeps the UA popup (presence = true,
        absence = the library default) */
    nativeControls?: boolean;
    /** BCP 47 locale for the picker panels' vocabulary (month label,
        weekday heads, month cells — Intl.DateTimeFormat); default =
        the page's <html lang>, else the browser language (2026-08-30) */
    locale?: string;
    /** fires when the custom picker commits a value */
    onselect?: (value: string) => void;
    /** fine-grained panel content — takes precedence over the embedded
        default panel. Renders inside the popover; ctx = value/commit/close */
    picker?: Snippet<[PickerCtx]>;
  }

  /** the picker snippet's bridge context */
  export interface PickerCtx {
    /** the input's current value */
    value: string;
    /** commit: writes the input (controlled/uncontrolled alike), fires onselect */
    commit: (v: string) => void;
    /** close the panel (light dismiss/Escape stay native) */
    close: () => void;
  }

  // $props.id() must live in its own top-level initializer (compiler law)
  const autoId = $props.id();

  let {
    type = 'text',
    density,
    'data-density': _callerDensity,
    label,
    id = autoId,
    error,
    clearable = false,
    count = false,
    reveal = true,
    labelMode = 'stacked',
    placeholder,
    innerInlineStart,
    innerInlineEnd,
    icon,
    iconPosition,
    outerBlockStart,
    outerBlockEnd,
    value = $bindable(),
    class: className = '',
    'aria-invalid': ariaInvalid,
    'aria-describedby': ariaDescribedBy,
    'data-assert-border': assertBorder = false,
    'data-dissolve-border': dissolveBorder = false,
    nativeControls = false,
    /** frame posture: explicit ?? the integration ambient ?? 'frame'
     *  (the control-chrome axis — a frame-owning row declares its
     *  controls bare; the family's OWN css paints the bare state) */
    chrome: chromeProp = undefined,
    locale,
    onselect,
    picker,
    ...rest
  }: Props = $props();

  // the chrome axis ambient (inline read — see lib/control-chrome.svelte.ts)
  const ambientChrome = getContext<{ chrome?: ControlChrome }>(CONTROL_CHROME_KEY)?.chrome;

  const errorId = $derived(`${id}-error`);
  // the family Defaults is the single read point (context-defaults-
  // economy 3.1): explicit ?? ambient scope per slot, one line, no
  // legacy helper channels
  const d = $derived(InputDefaults.resolve({ density }));
  const invalid = $derived(error != null && error !== '');
  const describedBy = $derived(invalid ? errorId : ariaDescribedBy);
  const invalidAttr = $derived(invalid ? 'true' : ariaInvalid);

  const isHidden = $derived(type === 'hidden');
  const isRange = $derived(type === 'range');
  const isColor = $derived(type === 'color');
  const isNumber = $derived(type === 'number');
  // declared before `slotted` reads it (runes are declarations, not hoists)
  const customStepper = $derived(isNumber && !nativeControls);
  // the text-like shell lane is the only one that takes the floating
  // bracket (range/color/hidden keep the stacked label law)
  const isTextLike = $derived(!isHidden && !isRange && !isColor);
  const floating = $derived(
    labelMode === 'floating' && label != null && outerBlockStart == null && isTextLike,
  );

  // ---- password reveal ----------------------------------------------------
  // default ON (reveal={false} opts out); the toggle starts HIDDEN — the
  // VALUE is never revealed by default (design.md). Flipping only swaps
  // the input's type between password/text: autocomplete and password-
  // manager behavior stay the platform's.
  let revealed = $state(false);
  const showReveal = $derived(type === 'password' && reveal);
  const inputType = $derived(type === 'password' && revealed ? 'text' : type);
  // floating brackets ride :placeholder-shown — the empty state must be
  // expressible even without a consumer placeholder (a single space)
  const shellPlaceholder = $derived(
    floating && (placeholder == null || placeholder === '') ? ' ' : placeholder,
  );

  // ---- controlled / clearable plumbing ---------------------------------
  // liveValue mirrors the DOM only after real user input — the one piece
  // of state an uncontrolled field ever touches, never written back out.
  const controlled = $derived(value != null);
  let liveValue = $state<string | null>(null);
  let inputEl: HTMLInputElement | undefined = $state();

  const shownValue = $derived(liveValue ?? (controlled ? String(value) : ''));
  // ---- the semantic glyph lane (Owner 2026-09-05) -----------------------
  // EVERY text-like type carries a glyph by default: url→link, tel→phone,
  // email→mail, search→magnifier, text→the Type T (the Owner's same-day
  // follow-up). `icon` is tri-state: undefined = the default, null =
  // explicitly off (embedded self-painting lanes opt out), a snippet =
  // custom; `iconPosition` pins the side; the unpinned side is resolved
  // by the shell's css (see input.css — the order ladder + lane ambient)
  const SEMANTIC_GLYPHS: Partial<Record<string, IconName>> = {
    text: 'type',
    url: 'link',
    tel: 'phone',
    email: 'mail',
    search: 'search',
  };
  const semanticGlyphName = $derived.by(() => {
    if (icon !== undefined || !isTextLike) return undefined;
    return SEMANTIC_GLYPHS[type];
  });
  const semanticGlyph = $derived(Boolean(icon || semanticGlyphName));
  const slotted = $derived(Boolean(innerInlineStart || innerInlineEnd || clearable || customStepper || semanticGlyph));
  const showClear = $derived(clearable && rest.disabled !== true && shownValue !== '');

  // ---- count plumbing (code points, never UTF-16 units) -----------------
  // "n / max" in the hint lane; the cap rides the native maxlength
  // attribute (the platform owns clamping — typing and paste truncate at
  // the element). Near the limit (from 90% of the cap) the readout's
  // aria-live flips from off to polite; elsewhere it never chatters.
  const codePointCount = (s: string): number => [...s].length;
  const shownCount = $derived(codePointCount(shownValue));
  const countMax = $derived.by(() => {
    const raw = (rest as { maxlength?: string | number }).maxlength;
    const n = typeof raw === 'number' ? raw : Number(raw);
    return raw != null && raw !== '' && Number.isFinite(n) && n > 0 ? n : null;
  });
  const countNear = $derived(countMax != null && shownCount >= Math.ceil(countMax * 0.9));
  const countLabel = $derived(countMax != null ? `${shownCount} / ${countMax}` : `${shownCount}`);

  function syncValue(event: Event) {
    const el = event.currentTarget as HTMLInputElement;
    liveValue = el.value;
    if (controlled) value = el.value;
    // forward a caller-supplied input handler from the rest props
    (rest as { oninput?: (event: Event) => void }).oninput?.(event);
  }

  /** push the DOM's current value through the typing plumbing —
      liveValue sync + controlled write + a real input event, so
      bindings and plain listeners both see it (shared by the clear
      button and the number stepper) */
  function commitDomValue() {
    if (!inputEl) return;
    liveValue = inputEl.value;
    if (controlled) value = inputEl.value;
    inputEl.dispatchEvent(new Event('input', { bubbles: true }));
  }

  function clearValue() {
    if (!inputEl) return;
    inputEl.value = '';
    commitDomValue();
    inputEl.dispatchEvent(new CustomEvent('clear', { bubbles: true }));
  }

  // ---- the number stepper (jx-number-shell, input.css) -----------------
  // type=number keeps its native semantics (typing, ↑/↓ stepping,
  // min/max/step on the element); the pair only REPLACES the visual
  // spinners. The <input> is the source of truth: stepping reads
  // valueAsNumber, clamps/snaps, writes the DOM value back and rides
  // the SAME plumbing as typing — this is not number-input's readonly
  // composite, the lane stays editable when disabled flows through rest.

  /** min/max/step ride the rest props (string|number tolerant — the
      platform accepts both spellings in markup) */
  const numAttr = (v: string | number | undefined): number | undefined => {
    const n = Number(v);
    return v != null && v !== '' && Number.isFinite(n) ? n : undefined;
  };
  const numMin = $derived(numAttr((rest as { min?: string | number }).min));
  const numMax = $derived(numAttr((rest as { max?: string | number }).max));
  const numStep = $derived(numAttr((rest as { step?: string | number }).step) ?? 1);
  // float-step safety: snap arithmetic to the step's decimal precision
  // (step 0.1 must land on 0.2, not 0.30000000000000004)
  const stepDecimals = $derived(Math.max(0, (String(numStep).split('.')[1] ?? '').length));

  function clampNum(n: number): number {
    let out = n;
    if (numMin != null && out < numMin) out = numMin;
    if (numMax != null && out > numMax) out = numMax;
    return out;
  }

  function snapNum(n: number): number {
    return Number(n.toFixed(stepDecimals));
  }

  /** one step in direction, clamped into range; an unset lane starts
      from min (else 0) so the first press is always meaningful.
      THE disabled gate: every step path (press, hold repeat) funnels
      through here, so one guard blocks them all */
  function stepBy(direction: 1 | -1): void {
    if (!inputEl || rest.disabled === true) return;
    const base = Number.isFinite(inputEl.valueAsNumber)
      ? inputEl.valueAsNumber
      : (numMin ?? 0);
    inputEl.value = String(clampNum(snapNum(base + direction * numStep)));
    commitDomValue();
  }

  // ---- press-and-hold: immediate step, 300ms delay, then 100ms/step ---
  const HOLD_DELAY_MS = 300;
  const HOLD_REPEAT_MS = 100;
  let holdDelay = 0;
  let holdInterval = 0;

  function beginHold(direction: 1 | -1): void {
    if (rest.disabled === true) return; // never arm timers for a disabled field
    stopHold();
    stepBy(direction);
    holdDelay = window.setTimeout(() => {
      holdInterval = window.setInterval(() => stepBy(direction), HOLD_REPEAT_MS);
    }, HOLD_DELAY_MS);
    // window-level so pointerup ANYWHERE ends the run — sliding off the
    // button can never strand a running interval
    window.addEventListener('pointerup', stopHold);
    window.addEventListener('pointercancel', stopHold);
  }

  function stopHold(): void {
    if (holdDelay) window.clearTimeout(holdDelay);
    if (holdInterval) window.clearInterval(holdInterval);
    holdDelay = 0;
    holdInterval = 0;
    window.removeEventListener('pointerup', stopHold);
    window.removeEventListener('pointercancel', stopHold);
  }

  // release timers + listeners if the component unmounts mid-hold
  $effect(() => () => stopHold());

  // ---- the picker bridge (input.css carries the intent ledger) ------
  // embedded default panels exist for every picker type the family
  // exports a fragment for; everything else needs the picker snippet
  const EMBEDDED_PICKER_TYPES = new Set(['date', 'datetime-local', 'color', 'week', 'month', 'time']);
  const customPicker = $derived(
    Boolean(picker) || (nativeControls === false && EMBEDDED_PICKER_TYPES.has(type)),
  );

  let pickerPanelEl = $state<HTMLDivElement | null>(null);
  let pickerAnchorEl = $state<HTMLElement | null>(null);
  let calendarRef = $state<{ focusGrid: () => void } | null>(null);
  let editorRef = $state<{ focusFirst: () => void } | null>(null);
  let monthGridRef = $state<{ focusGrid: () => void } | null>(null);
  let timeStepperRef = $state<{ focusFirst: () => void } | null>(null);
  // the shared surface motion kernel (popover.svelte wiring law):
  // WAAPI drives --jx-p; the axis tracks the control↔panel vector
  const motion = createSurfaceMotion(() => pickerPanelEl, { anchor: () => pickerAnchorEl });
  onDestroy(() => motion.destroy());
  const pickerAnchor = $derived(`--jx-input-${id.toLowerCase().replace(/[^a-z0-9]+/g, '-')}`);

  /** the date part of the current value ("YYYY-MM-DD" or undefined) */
  const datePart = $derived(/^\d{4}-\d{2}-\d{2}/.exec(String(shownValue ?? ''))?.[0]);
  /** the month anchor for the MonthGrid ("YYYY-MM" or undefined) */
  const monthAnchor = $derived(/^\d{4}-\d{2}/.exec(String(shownValue ?? ''))?.[0]);
  /** the picked week's Monday ("YYYY-MM-DD" or undefined) — the week
      value ("YYYY-Www") parsed back for anchoring + range painting */
  const weekAnchor = $derived(mondayOfIsoWeek(String(shownValue ?? '')));
  /** the EXCLUSIVE next Monday: the Calendar's range tint is
      strictly-inside, so ending at Sunday left the picked week's 7th
      day bare — one day past the week paints Tue–Sun, Monday keeps
      the anchor fill, all 7 days highlighted (Owner catch 2026-08-29) */
  const weekEndExclusive = $derived(weekAnchor ? addDays(weekAnchor, 7) : undefined);
  /** the time part ("HH:MM" or undefined): leading for time, the
      after-T part for datetime-local */
  const timeValue = $derived(
    type === 'datetime-local'
      ? /T(\d{2}:\d{2})/.exec(String(shownValue ?? ''))?.[1]
      : /^\d{2}:\d{2}/.exec(String(shownValue ?? ''))?.[0],
  );

  function openPicker(): void {
    pickerPanelEl?.showPopover();
  }
  function closePicker(): void {
    pickerPanelEl?.hidePopover();
  }
  function commitFromPanel(v: string): void {
    if (!inputEl) return;
    inputEl.value = v;
    liveValue = v;
    if (controlled) value = v;
    inputEl.dispatchEvent(new Event('input', { bubbles: true }));
    onselect?.(v);
  }
  /** the embedded Calendar's commit, routed by type: date/week commit
      and close; datetime-local commits the date part (typed time
      preserved) and STAYS OPEN — the time stepper adjusts next */
  function commitDay(iso: string): void {
    if (type === 'datetime-local') {
      commitFromPanel(`${iso}T${timeValue ?? '00:00'}`);
      return;
    }
    if (type === 'week') {
      commitFromPanel(isoWeekOf(iso) ?? iso);
      closePicker();
      return;
    }
    commitFromPanel(iso);
    closePicker();
  }
  /** one native event covers every open/close path (popovertarget,
      light dismiss, Escape, our own calls) — popover.svelte law */
  function onPickerToggle(e: ToggleEvent): void {
    if (e.newState === 'open') {
      motion.play(1);
      motion.startTracking();
      // type-routed focus: exactly one fragment is mounted per panel,
      // the others' refs stay null — the calls are inert no-ops
      calendarRef?.focusGrid();
      editorRef?.focusFirst();
      monthGridRef?.focusGrid();
      timeStepperRef?.focusFirst();
    } else {
      motion.play(0);
      motion.stopTracking();
      inputEl?.focus();
    }
  }
  /** the lane's indicator zone (≈ the last 2.5rem) opens OUR panel;
      the text zone keeps native focus/typing. color is the exception:
      its swatch activation cannot be cancelled — the overlay button
      is the trigger there */
  function onLaneClick(e: MouseEvent): void {
    // forward a caller-supplied click handler from the rest props
    (rest as { onclick?: (event: MouseEvent) => void }).onclick?.(e);
    if (!customPicker || type === 'color') return;
    const r = (e.currentTarget as HTMLInputElement).getBoundingClientRect();
    if (e.clientX > r.right - 40) {
      e.preventDefault();
      openPicker();
    }
  }
  /** Alt+↓/↑ — the native picker-open gesture, rerouted to ours */
  function onLaneKeyDown(e: KeyboardEvent): void {
    if (customPicker && e.altKey && (e.key === 'ArrowDown' || e.key === 'ArrowUp')) {
      e.preventDefault();
      openPicker();
    }
  }
  const pickerCtx = $derived<PickerCtx>({
    value: String(shownValue ?? ''),
    commit: commitFromPanel,
    close: closePicker,
  });
</script>

{#if isHidden}
  <!-- hidden: bare native passthrough (value rides as a plain attribute) -->
  <input {id} {type} {value} {placeholder} {...rest} data-density={d.density} />
{:else}
  <div
  class="jx-field"
  data-density={d.density}
    data-self-inset={showClear || customPicker || innerInlineEnd || (semanticGlyph && iconPosition !== 'start') ? '' : undefined}
>
    {#if outerBlockStart}
      <div data-jx-outer data-jx-outer-start class="text-muted-foreground text-xs -mb-1">{@render outerBlockStart()}</div>
    {:else if label && !floating}<label class="jx-label" for={id}>{label}</label>{/if}
    {#if isRange}
      <input
        {id}
        {type}
        {placeholder}
        {...rest}
        value={controlled ? value : undefined}
        oninput={syncValue}
        class={'jx-html-range ' + className}
        aria-invalid={invalidAttr}
        aria-describedby={describedBy}
      />
    {:else if isColor}
      <!-- Tier-1 color field: the label wrapper opens the picker from the
           glyph zone too; the input is the locked square swatch lane.
           className lands on the WRAPPER (the shell-law owner, same as
           the text lane's .jx-control-shell) — pass jx-color-expand for
           the full-row field (default is the compact 5rem swatch). -->
      <label
        bind:this={pickerAnchorEl}
        class={'jx-color-shell ' + className}
        style={customPicker ? `anchor-name: ${pickerAnchor}` : undefined}
      >
        <input
          {id}
          {type}
          {placeholder}
          {...rest}
          value={controlled ? value : undefined}
          oninput={syncValue}
          class="jx-color-swatch"
          aria-invalid={invalidAttr}
          aria-describedby={describedBy}
          data-jx-custom-picker={customPicker ? '' : undefined}
          data-jx-picker-color={customPicker ? '' : undefined}
          tabindex={customPicker ? -1 : undefined}
        />
        {#if customPicker}
          <!-- the swatch's UA activation cannot be cancelled — the overlay
               button is the trigger; the input keeps the value/ARIA role -->
          <button
            type="button"
            class="jx-picker-overlay"
            aria-label="choose color"
            onclick={openPicker}
            onkeydown={(e) => e.key === 'ArrowDown' && e.altKey && openPicker()}
          ></button>
        {/if}
      </label>
    {:else}
      <!-- the shell owns the box law; the input inside is chromeless.
           Outermost positions: [−][prefix] lane [suffix][+][clear?][eye?]
           — the stepper pair sits OUTSIDE the snippet slots so custom
           prefix/suffix content never displaces the stepping controls;
           the reveal eye is the OUTERMOST end child (the end-lane order
           innerInlineEnd > clearable × > eye, 2026-08-30) -->
      <div
        bind:this={pickerAnchorEl}
        class={'jx-html-control-shell ' + className}
        class:jx-slotted={slotted}
        class:jx-invalid={invalid}
        class:jx-clearable={clearable}
        class:jx-number-shell={customStepper}
        class:jx-floating={floating}
        data-chrome={chromeProp ?? ambientChrome ?? 'frame'}
        data-icon-position={semanticGlyph ? (iconPosition ?? 'auto') : undefined}
        data-jx-custom-picker={customPicker ? '' : undefined}
        data-assert-border={assertBorder ? '' : undefined}
        data-dissolve-border={dissolveBorder ? '' : undefined}
        style={customPicker ? `anchor-name: ${pickerAnchor}` : undefined}
      >
        {#if floating}
          <!-- the terminal BRACKET label (labelMode="floating"): rides the
               shell's top border like a fieldset legend — no in-field
               morph; the ink state machine is pure CSS (input.css) -->
          <label class="jx-floating-label" for={id}>{label}</label>
        {/if}
        {#if customStepper}
          <button
            type="button"
            class="jx-input-prefix-icon-button"
            data-jx-step-minus
            aria-label="decrease"
            disabled={rest.disabled}
            onpointerdown={beginHold.bind(null, -1)}
          ><Icon name="minus" /></button>
        {/if}
        {#if innerInlineStart}
          <span data-jx-slot data-jx-inline-start class="flex-none inline-flex items-center gap-1.5 text-muted-foreground text-xs leading-none">{@render innerInlineStart()}</span>
        {/if}
        <!-- the interception selector anchors on the INPUT: the
             picker indicator pseudo belongs to it, not the shell -->
        <input
          bind:this={inputEl}
          {id}
          type={inputType}
          placeholder={shellPlaceholder}
          {...rest}
          value={controlled ? value : undefined}
          oninput={syncValue}
          onclick={customPicker ? onLaneClick : undefined}
          onkeydown={customPicker ? onLaneKeyDown : undefined}
          class="jx-html-control-lane"
          aria-invalid={invalidAttr}
          aria-describedby={describedBy}
          data-jx-custom-picker={customPicker ? '' : undefined}
        />
        {#if semanticGlyph}
          <!-- the semantic glyph lane (Owner 2026-09-05): DOM stays
               input-adjacent (the stepper's adjacency margins and the
               first/last-child inset rules above read DOM order); the
               side is the css order ladder's call — 'auto' leads by
               default, trails inside a list-item end lane, suspends
               back to leading under the lane's 30rem fold -->
          <span
            data-jx-semantic-icon
            aria-hidden="true"
            class="flex-none inline-flex items-center text-muted-foreground text-xs leading-none"
          >
            {#if icon}{@render icon()}{:else if semanticGlyphName}<Icon name={semanticGlyphName} />{/if}
          </span>
        {/if}
        {#if innerInlineEnd}
          <span data-jx-slot data-jx-inline-end class="flex-none inline-flex items-center gap-1.5 text-muted-foreground text-xs leading-none">{@render innerInlineEnd()}</span>
        {/if}
        {#if customStepper}
          <button
            type="button"
            class="jx-input-suffix-icon-button"
            data-jx-step-plus
            aria-label="increase"
            disabled={rest.disabled}
            onpointerdown={beginHold.bind(null, 1)}
          ><Icon name="plus" /></button>
        {/if}
        {#if showClear}
          <button
            type="button"
            class="jx-html-clear"
            aria-label="clear value"
            onclick={clearValue}
          >
            <!-- the clear glyph = an ICON SLOT: the CSS mask reads
                 --jx-icon-clear (overridable via the plugin); the inline
                 lucide SVG fallback serves without the plugin -->
            <span class="jx-clear-glyph" aria-hidden="true"></span>
          </button>
        {/if}
        {#if showReveal}
          <!-- the reveal eye: the OUTERMOST end-lane child. aria-pressed
               mirrors the reveal state (starts false — the VALUE is never
               revealed by default); the glyph swaps eye → eyeOff while
               the password shows. Only the input's type flips —
               autocomplete / password-manager behavior untouched. -->
          <button
            type="button"
            class="jx-input-reveal"
            aria-pressed={revealed}
            aria-label={revealed ? 'hide password' : 'show password'}
            disabled={rest.disabled}
            onclick={() => (revealed = !revealed)}
          >
            <Icon name={revealed ? 'eyeOff' : 'eye'} />
          </button>
        {/if}
      </div>
    {/if}
    {#if customPicker}
      <!-- the bridge panel: Popover API (light dismiss, Escape, top
           layer are the browser's); anchor-positioned under the
           control; the date-panel law paints it -->
      <div
        bind:this={pickerPanelEl}
        id="{id}-picker-panel"
        popover="auto"
        class={cn('jx-picker-panel jx-surface', motion.supported && 'jx-waapi')}
        data-variant="auto"
        style="position-anchor: {pickerAnchor}; inset-area: bottom span-all; position-area: bottom span-all;"
        ontoggle={onPickerToggle}
      >
        <!-- the REAL shadow layer: a DOM child because pseudo-elements
             are unreachable from WAAPI — the kernel animates it in
             lockstep (Owner ruling r18) -->
        <div data-jx-picker-shadow="" class="jx-surface-shadow" aria-hidden="true"></div>
        <!-- the floating-surface law (arch r3): the popover element is
             the PLATFORM (paints nothing); the bezel fill + border live
             on the surface-body child -->
        <div class="jx-surface-body px-3.5 py-3">
          {#if picker}
            {@render picker(pickerCtx)}
          {:else if type === 'color'}
            <!-- the PROFESSIONAL editor (SV pad + hue bar + format
                 switch + value input + Eye Dropper + presets) — editor
                 semantics: continuous commits, the panel stays open.
                 input[type=color] only accepts #hex — normalize for the
                 element, forward the raw notation to onselect -->
            <Editor
              bind:this={editorRef}
              value={/^#[0-9a-fA-F]{6}$/.test(String(shownValue ?? '')) ? String(shownValue) : undefined}
              onpick={(color) => {
                const parsed = parseColor(color);
                if (parsed) commitFromPanel(formatColor(parsed, 'hex'));
                onselect?.(color);
              }}
            />
          {:else if type === 'month'}
            <!-- the month panel: year nav + 12 cells; a pick commits
                 "YYYY-MM" and closes (single-shot, unlike the color
                 editor's continuous commits) -->
            <MonthGrid
              bind:this={monthGridRef}
              anchor={monthAnchor}
              min={(rest as { min?: string }).min}
              max={(rest as { max?: string }).max}
              {locale}
              onpick={(v) => {
                commitFromPanel(v);
                closePicker();
              }}
              idPrefix="{id}-pmonth"
            />
          {:else if type === 'time'}
            <!-- the time panel: the TimeStepper alone; commits are
                 LIVE (stepping through hours/minutes is multi-step,
                 the panel stays open until light dismiss/Escape) -->
            <TimeStepper
              bind:this={timeStepperRef}
              value={timeValue}
              oncommit={(v) => commitFromPanel(v)}
              disabled={rest.disabled}
              idPrefix="{id}-ptime"
            />
          {:else}
            <!-- date / week / datetime-local: the Calendar. The week
                 flavor anchors the picked week's Monday, paints the
                 whole week (Tue–Sun tint via the exclusive next-Monday
                 end, Monday the anchor fill) and previews the hovered
                 week — all 7 days, out-month cells included -->
            <Calendar
              bind:this={calendarRef}
              anchors={type === 'week' ? (weekAnchor ? [weekAnchor] : []) : datePart ? [datePart] : []}
              rangeStart={type === 'week' ? weekAnchor : undefined}
              rangeEnd={type === 'week' ? weekEndExclusive : undefined}
              weekHover={type === 'week'}
              {locale}
              min={(rest as { min?: string }).min}
              max={(rest as { max?: string }).max}
              initialView={type === 'week' ? weekAnchor : datePart}
              idPrefix="{id}-pcal"
              onpick={commitDay}
            />
            {#if type === 'datetime-local'}
              <!-- the time part gets a REAL control (Owner catch
                   2026-08-29): the stepper commits the T part live; an
                   absent date part defaults to today -->
              <div class="-mx-3.5 my-3 border-t border-border" aria-hidden="true"></div>
              <TimeStepper
                bind:this={timeStepperRef}
                value={timeValue}
                oncommit={(v) => commitFromPanel(`${datePart ?? todayIso()}T${v}`)}
                disabled={rest.disabled}
                idPrefix="{id}-ptime"
              />
            {/if}
          {/if}
        </div>
      </div>
    {/if}
    {#if invalid}<p id={errorId} class="jx-error"><span class="jx-error-mark" aria-hidden="true">!</span>{error}</p>{/if}
    {#if count}
      <!-- the hint lane: the "n / max" code-point readout. aria-live sits
           at OFF and flips to polite near the limit (from 90% of the
           maxlength cap) — the readout never chatters per keystroke -->
      <div data-jx-hint class="flex items-center">
        <p
          data-jx-count
          class="ms-auto m-0 font-nav text-[11px] tracking-[0.08em] text-muted-foreground"
          aria-live={countNear ? 'polite' : 'off'}
          aria-atomic="true"
        >
          {countLabel}
        </p>
      </div>
    {/if}
    {#if outerBlockEnd}<div data-jx-outer data-jx-outer-end class="text-muted-foreground text-xs -mt-1">{@render outerBlockEnd()}</div>{/if}
  </div>
{/if}
