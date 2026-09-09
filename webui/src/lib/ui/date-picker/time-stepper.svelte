<!--
  jixoai time stepper (registry/files/ui/date-picker/time-stepper.svelte).

  Original request (2026-08-29): “为 Input 重写补齐 date-picker 家族片段”
  — the popover-internal "HH:MM" editor for the picker family's time /
  datetime-local panels. Orthogonal intents:

  1. controlled time state — value is an "HH:MM" string (or undefined);
     every step/valid edit fires oncommit immediately and the component
     renders from the prop. NO shadow state survives a commit (the only
     local text is an in-flight typing draft, cleared on commit).
  2. wrap stepping — [- HH +] : [- MM +] groups; click/hold/↑/↓ all wrap
     (23→0, 59→0 — clock convention, NOT number-input's clamp law).
  3. press-and-hold — ported verbatim from number-input.svelte: immediate
     step on pointerdown, 300ms delay, then one step every 100ms, with
     window-level pointerup/pointercancel cleanup.
  4. direct typing — the cells are focusable text inputs (maxlength 2);
     1–2 digits validate (hour ≤ 23, minute ≤ 59) and commit on
     change/blur; invalid or empty input reverts to the committed value.
  5. the hour-format toggle (Owner request, 2026-08-29) — one text-icon
     button after the MM group cycles 24h → AM → PM (default 24h;
     the button's glyph IS the current mode). The mode is INPUT-SCALE
     state: committed values stay 24h "HH:MM" always; AM/PM narrows
     the hour cell's domain to 1–12 (wrap 12↔1) and rewrites the number on
     the boundary crossings per the Owner's literal rules — 24h → AM/PM
     drops hours > 12 by twelve (0 and 12 pass through untouched);
     PM → 24h climbs back + twelve ((h % 12) + 12 maps 1–11 → 13–23 and
     keeps 12 PM at noon's 12). AM → PM flips the meridiem only.
  6. pointer gestures (Owner request, 2026-08-30) — the numbers are
     slider-grade. The wheel over a group steps its number (scroll up
     = +1, down = −1); press-drag on a cell steps per DRAG_PX_PER_STEP
     of vertical travel (up increases — the slider convention),
     pointer-captured so a run sliding off the cell never strands;
     the cells wear cursor:ns-resize (the vertical-moveable cue).

  Conventions: an undefined value renders the 00:00 digits (display
  only — the committed value stays undefined until the first
  interaction), and the first step starts from 00:00 THEN steps —
  undefined + hour+ commits "01:00", undefined + minute− commits
  "00:59". disabled locks buttons + cells in lockstep and guards
  every commit path. The fragment renders NO shell of its own — the
  host panel bezel owns the chrome.

  Styles follow calendar.svelte exactly: markup token utilities + the
  shared date-picker.css sheet (imported below; the .jx-date-nav-btn
  state machine gives the compact 1.75rem icon buttons their hover/
  press/focus-visible/disabled law). value is $bindable — the frozen
  contract signature is unchanged; binding hosts get a synchronous echo
  so hold-repeats never race, oncommit-only hosts work identically.
-->
<script lang="ts">
  import Icon from '$lib/ui/icon';
  import { pad2 } from './calendar-math';
  import './date-picker.css';

  interface Props {
    /** "HH:MM" or undefined (empty) */
    value?: string;
    /** live commit on every step/valid edit */
    oncommit?: (v: string) => void;
    disabled?: boolean;
    /** aria id prefix (default 'jx-time') */
    idPrefix?: string;
  }

  let {
    value = $bindable(),
    oncommit,
    disabled = false,
    idPrefix = 'jx-time',
  }: Props = $props();

  function parseTime(v: string | undefined): { h: number; m: number } | undefined {
    const m = /^(\d{2}):(\d{2})$/.exec(v ?? '');
    if (!m) return undefined;
    const h = Number(m[1]);
    const mi = Number(m[2]);
    if (h > 23 || mi > 59) return undefined;
    return { h, m: mi };
  }

  const time = $derived(parseTime(value));
  // display-only defaults: an undefined value still shows digits (the
  // Owner's 2026-08-30 catch — empty cells read as broken); commits
  // stay undefined until the first interaction
  const hourText = $derived(pad2(time?.h ?? 0));
  const minuteText = $derived(pad2(time?.m ?? 0));

  // ---- the hour-format mode: 24h ↔ AM/PM (see header #5) ---------------
  let mode = $state<'24h' | 'AM' | 'PM'>('24h');
  const hourMax = $derived(mode === '24h' ? 23 : 12);
  const hourMin = $derived(mode === '24h' ? 0 : 1);

  function cycleMode(): void {
    if (disabled) return;
    if (time) {
      if (mode === '24h') {
        const h = time.h > 12 ? time.h - 12 : time.h; // the literal drop
        if (h !== time.h) commit({ h, m: time.m }); // no-op passes silently
      } else if (mode === 'PM') {
        const h = (time.h % 12) + 12; // +12 climb; 12 PM stays noon's 12
        if (h !== time.h) commit({ h, m: time.m });
      }
      // AM → PM: the same 1–12 scale — only the meridiem flips
    }
    mode = mode === '24h' ? 'AM' : mode === 'AM' ? 'PM' : '24h';
  }

  // ---- controlled commit: one exit for every mutation path ----------------
  function commit(next: { h: number; m: number }): void {
    hourDraft = null;
    minuteDraft = null;
    const v = `${pad2(next.h)}:${pad2(next.m)}`;
    value = v; // $bindable echo (local-only when unbound — the host's
    // oncommit/value round-trip is the canonical controlled loop)
    oncommit?.(v);
  }

  /** one WRAPPING step — THE disabled gate every step path funnels
      through (button press, hold repeat, cell ↑/↓). The hour wraps on
      the ACTIVE scale: mod 24, or the 1–12 meridiem ring (12→1, 1→12) */
  function stepBy(part: 'hour' | 'minute', direction: 1 | -1): void {
    if (disabled) return;
    const base = time ?? { h: 0, m: 0 }; // undefined starts from 00:00
    if (part === 'hour') {
      const h =
        mode === '24h'
          ? (base.h + direction + 24) % 24
          : wrap12(base.h + direction);
      commit({ h, m: base.m });
    } else commit({ h: base.h, m: (base.m + direction + 60) % 60 });
  }

  function wrap12(n: number): number {
    return n > 12 ? 1 : n < 1 ? 12 : n;
  }

  // ---- press-and-hold: immediate step, 300ms delay, then 100ms/step ---
  const HOLD_DELAY_MS = 300;
  const HOLD_REPEAT_MS = 100;
  let holdDelay = 0;
  let holdInterval = 0;

  function beginHold(part: 'hour' | 'minute', direction: 1 | -1): void {
    if (disabled) return; // never arm timers for a disabled field
    stopHold();
    stepBy(part, direction);
    holdDelay = window.setTimeout(() => {
      holdInterval = window.setInterval(() => stepBy(part, direction), HOLD_REPEAT_MS);
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

  // ---- wheel: scroll up = +1, down = −1 (one step per event) --------
  function onWheel(part: 'hour' | 'minute', event: WheelEvent): void {
    if (disabled) return;
    event.preventDefault(); // the number eats the scroll — the page must not pan
    stepBy(part, event.deltaY < 0 ? 1 : -1);
  }

  // ---- press-drag: vertical slider on the cell (up increases) --------
  const DRAG_PX_PER_STEP = 10;
  let dragPart: 'hour' | 'minute' | null = null;
  let dragStartY = 0;
  let dragApplied = 0;

  function onDragStart(part: 'hour' | 'minute', event: PointerEvent): void {
    if (disabled || !event.isPrimary || event.button !== 0) return;
    dragPart = part;
    dragStartY = event.clientY;
    dragApplied = 0;
    // capture keeps the move stream on the cell even off its bounds;
    // jsdom has no capture API — the guard keeps tests honest
    (event.currentTarget as HTMLElement).setPointerCapture?.(event.pointerId);
  }

  function onDragMove(event: PointerEvent): void {
    if (dragPart == null) return;
    // up = positive steps (slider convention): travel is start − current
    const steps = Math.trunc((dragStartY - event.clientY) / DRAG_PX_PER_STEP);
    const diff = steps - dragApplied;
    if (diff === 0) return;
    const direction: 1 | -1 = diff > 0 ? 1 : -1;
    for (let i = 0; i < Math.abs(diff); i++) stepBy(dragPart, direction);
    dragApplied = steps;
  }

  function onDragEnd(event: PointerEvent): void {
    if (dragPart == null) return;
    (event.currentTarget as HTMLElement).releasePointerCapture?.(event.pointerId);
    dragPart = null;
  }

  // ---- direct typing: drafts live only between input and change/blur --
  let hourDraft = $state<string | null>(null);
  let minuteDraft = $state<string | null>(null);
  let hourEl = $state<HTMLInputElement | null>(null);

  function onCellInput(part: 'hour' | 'minute', event: Event): void {
    const text = (event.currentTarget as HTMLInputElement).value;
    if (part === 'hour') hourDraft = text;
    else minuteDraft = text;
  }

  /** change/blur: valid 1–2 digit input commits; anything else reverts
      (draft cleared → the derived committed text repaints the cell) */
  function onCellCommit(part: 'hour' | 'minute', event: Event): void {
    const input = event.currentTarget as HTMLInputElement;
    const committed = part === 'hour' ? hourText : minuteText;
    hourDraft = null;
    minuteDraft = null;
    if (disabled || input.value === committed) return; // tab-through is not an edit
    // the hour validates on the ACTIVE scale (0–23 in 24h, 1–12 in AM/PM)
    const n = Number(input.value);
    const ok =
      /^\d{1,2}$/.test(input.value) &&
      n <= (part === 'hour' ? hourMax : 59) &&
      n >= (part === 'hour' ? hourMin : 0);
    if (!ok) return; // invalid or empty → revert to the committed value
    const base = time ?? { h: 0, m: 0 };
    if (part === 'hour') commit({ h: Number(input.value), m: base.m });
    else commit({ h: base.h, m: Number(input.value) });
  }

  /** ↑/↓ on a cell steps it — keyboard parity with the click path */
  function onCellKeydown(part: 'hour' | 'minute', event: KeyboardEvent): void {
    if (event.key === 'ArrowUp') {
      event.preventDefault();
      stepBy(part, 1);
    } else if (event.key === 'ArrowDown') {
      event.preventDefault();
      stepBy(part, -1);
    }
  }

  /** focus the hour cell — hosts call this when their popover opens
      (panel-open focus parity with Calendar.focusGrid / Editor.focusFirst) */
  export function focusFirst(): void {
    hourEl?.focus();
  }
</script>

<div data-jx-time class="inline-flex items-center gap-1">
  <div role="group" aria-label="hour" class="inline-flex items-center" onwheel={onWheel.bind(null, 'hour')}>
    <button
      type="button"
      data-jx-time-hour-minus
      class="jx-date-nav-btn inline-flex items-center justify-center w-7 h-7 p-0 border border-transparent bg-transparent text-[color-mix(in_oklab,var(--terminal-foreground)_72%,transparent)] hover:text-terminal-foreground cursor-pointer transition-[background-color,transform] duration-100 ease-out disabled:cursor-not-allowed"
      aria-label="decrease hour"
      {disabled}
      onpointerdown={beginHold.bind(null, 'hour', -1)}
    ><Icon name="minus" strokeWidth={2.5} /></button>
    <input
      bind:this={hourEl}
      id={`${idPrefix}-hour`}
      data-jx-time-hour
      type="text"
      inputmode="numeric"
      maxlength="2"
      class="w-8 h-7 box-border bg-transparent border border-transparent text-center tabular-nums leading-none outline-none cursor-ns-resize text-[color-mix(in_oklab,var(--terminal-foreground)_72%,transparent)] focus-visible:outline-1 focus-visible:outline-ring focus-visible:-outline-offset-1 disabled:cursor-not-allowed disabled:opacity-30"
      aria-label="hour"
      {disabled}
      value={hourDraft ?? hourText}
      onpointerdown={onDragStart.bind(null, 'hour')}
      onpointermove={onDragMove}
      onpointerup={onDragEnd}
      onpointercancel={onDragEnd}
      oninput={onCellInput.bind(null, 'hour')}
      onchange={onCellCommit.bind(null, 'hour')}
      onblur={onCellCommit.bind(null, 'hour')}
      onkeydown={onCellKeydown.bind(null, 'hour')}
    />
    <button
      type="button"
      data-jx-time-hour-plus
      class="jx-date-nav-btn inline-flex items-center justify-center w-7 h-7 p-0 border border-transparent bg-transparent text-[color-mix(in_oklab,var(--terminal-foreground)_72%,transparent)] hover:text-terminal-foreground cursor-pointer transition-[background-color,transform] duration-100 ease-out disabled:cursor-not-allowed"
      aria-label="increase hour"
      {disabled}
      onpointerdown={beginHold.bind(null, 'hour', 1)}
    ><Icon name="plus" strokeWidth={2.5} /></button>
  </div>
  <span aria-hidden="true" class="font-nav text-[color-mix(in_oklab,var(--terminal-foreground)_55%,transparent)]">:</span>
  <div role="group" aria-label="minute" class="inline-flex items-center" onwheel={onWheel.bind(null, 'minute')}>
    <button
      type="button"
      data-jx-time-minute-minus
      class="jx-date-nav-btn inline-flex items-center justify-center w-7 h-7 p-0 border border-transparent bg-transparent text-[color-mix(in_oklab,var(--terminal-foreground)_72%,transparent)] hover:text-terminal-foreground cursor-pointer transition-[background-color,transform] duration-100 ease-out disabled:cursor-not-allowed"
      aria-label="decrease minute"
      {disabled}
      onpointerdown={beginHold.bind(null, 'minute', -1)}
    ><Icon name="minus" strokeWidth={2.5} /></button>
    <input
      id={`${idPrefix}-minute`}
      data-jx-time-minute
      type="text"
      inputmode="numeric"
      maxlength="2"
      class="w-8 h-7 box-border bg-transparent border border-transparent text-center tabular-nums leading-none outline-none cursor-ns-resize text-[color-mix(in_oklab,var(--terminal-foreground)_72%,transparent)] focus-visible:outline-1 focus-visible:outline-ring focus-visible:-outline-offset-1 disabled:cursor-not-allowed disabled:opacity-30"
      aria-label="minute"
      {disabled}
      value={minuteDraft ?? minuteText}
      onpointerdown={onDragStart.bind(null, 'minute')}
      onpointermove={onDragMove}
      onpointerup={onDragEnd}
      onpointercancel={onDragEnd}
      oninput={onCellInput.bind(null, 'minute')}
      onchange={onCellCommit.bind(null, 'minute')}
      onblur={onCellCommit.bind(null, 'minute')}
      onkeydown={onCellKeydown.bind(null, 'minute')}
    />
    <button
      type="button"
      data-jx-time-minute-plus
      class="jx-date-nav-btn inline-flex items-center justify-center w-7 h-7 p-0 border border-transparent bg-transparent text-[color-mix(in_oklab,var(--terminal-foreground)_72%,transparent)] hover:text-terminal-foreground cursor-pointer transition-[background-color,transform] duration-100 ease-out disabled:cursor-not-allowed"
      aria-label="increase minute"
      {disabled}
      onpointerdown={beginHold.bind(null, 'minute', 1)}
    ><Icon name="plus" strokeWidth={2.5} /></button>
  </div>
  <!-- the hour-format toggle — one text-icon button, the glyph IS the
       current mode; rides the same jx-date-nav-btn state machine as the
       −/+ pair (no hold-repeat: it's a toggle, not a stepper) -->
  <button
    type="button"
    data-jx-time-mode
    class="jx-date-nav-btn inline-flex items-center justify-center h-7 min-w-7 px-1 border border-transparent bg-transparent font-nav text-[10px] font-bold tracking-wide tabular-nums text-[color-mix(in_oklab,var(--terminal-foreground)_72%,transparent)] hover:text-terminal-foreground cursor-pointer transition-[background-color,transform] duration-100 ease-out disabled:cursor-not-allowed"
    title="cycle hour format (24h → AM → PM)"
    aria-label="hour format"
    {disabled}
    onclick={cycleMode}
  >{mode}</button>
</div>
