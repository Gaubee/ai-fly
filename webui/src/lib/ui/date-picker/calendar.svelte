<!--
  jixoai calendar — the embeddable month-grid fragment of the date-picker
  family (registry/files/ui/date-picker/calendar.svelte).

  Original request (2026-08-28): “从 date-picker 抽取可嵌入日历片段，供
  Input 组件的 picker 桥消费” — a popover-free, trigger-free, label-free
  calendar: month navigation + Monday-first grid + keyboard cursor + today
  ring + anchor/range marks. date-picker.svelte embeds it inside its
  popover panel; the Input picker bridge embeds it in its own shell.
  Orthogonal intents:

  1. view state — the month on stage (viewYear/viewMonth, initialized
     from initialView or today) and the aria-activedescendant cursor
     activeIso.
  2. grid derivation — weeks padded with prev/next-month cells (out),
     inclusive min/max disabling, the today ring.
  3. keyboard — the grid is one focus stop (tabindex=-1 + focusGrid()
     for hosts): ↑↓←→ walk by day/week across month boundaries (the view
     follows the cursor), Enter/Space pick; Escape belongs to the host.
  4. marks — anchors (fill) and rangeStart/rangeEnd (strictly-inside
     tint); all ISO props arrive as trust-but-verify strings.

  isDisabled (enhance-picker-feedback, 2026-08-30): a consumer day
  predicate joins min/max in the SAME disabled law — outside-day paint
  (visible, not-allowed), pick() refusal, and the arrow walk skips
  landable disabled days (a capped sweep; Enter always refuses).

  Selection semantics (single commit, range anchor/swap) and popover
  orchestration stay in the HOST — this fragment only fires onpick(iso)
  for guaranteed non-disabled, non-out days. The math lives in
  calendar-math.ts. Static paint is markup token utilities; the grid/nav
  state machines (hover poses, focus-visible kill, nav svg sizing) come
  from date-picker.css, imported below so a standalone embed is fully
  styled. Class names are the date-picker's own (jx-date-*) — the shared
  sheet styles both hosts unchanged.

  tw4 (2026-08-24, ported from date-picker.svelte): nav/grid/cell static
  paint is token utilities in the markup; cell states — today ring,
  anchor fill, in-range tint, off/out dim — ride conditional utilities
  (D1-exempt residue law).
-->
<script lang="ts">
  import Icon from '$lib/ui/icon';
  import { cn } from '$lib/utils';
  import {
    addDays,
    daysInMonth,
    isoOf,
    monthYearLabel,
    parseIso,
    todayIso,
    validIso,
    weekdayNames,
  } from './calendar-math';
  import { ambientLocale } from '$lib/locale.svelte';
  import './date-picker.css';

  interface Props {
    /** ISO "YYYY-MM-DD" anchor day(s) (single: [value]; range: [start,
        end]) — painted with the anchor fill */
    anchors?: string[];
    /** range tint edge (range mode: days strictly inside get the tint) */
    rangeStart?: string;
    /** range tint edge */
    rangeEnd?: string;
    /** week mode: hovering any day highlights its whole Monday-first
        week — all 7 days, out-month cells included; the preview of the
        week a pick will commit (Owner request, 2026-08-29) */
    weekHover?: boolean;
    /** BCP 47 locale for the month label + weekday vocabulary
        (Intl.DateTimeFormat); default = the page's <html lang>, else
        the browser language (Owner request, 2026-08-30) */
    locale?: string;
    /** inclusive ISO bound — earlier days render disabled */
    min?: string;
    /** inclusive ISO bound — later days render disabled */
    max?: string;
    /** consumer day predicate (enhance-picker-feedback, 2026-08-30):
        true days wear the SAME outside-day law as min/max cells (visible,
        not-allowed, uncommittable) and are SKIPPED by the arrow walk */
    isDisabled?: (iso: string) => boolean;
    /** initial view month (any ISO day inside it); default = today's month */
    initialView?: string;
    /** fired when a day is picked — guaranteed non-disabled, non-out */
    onpick?: (iso: string) => void;
    /** aria id prefix (cursor cell id = `${idPrefix}-d-${iso}`, the grid
        is `${idPrefix}-grid`); auto-generated when omitted */
    idPrefix?: string;
    /** the grid's aria-label (host context, e.g. `${label} calendar`) */
    ariaLabel?: string;
    class?: string;
  }

  // $props.id() must live in its own top-level initializer (compiler law)
  const autoId = $props.id();

  let {
    anchors = [],
    rangeStart,
    rangeEnd,
    weekHover = false,
    locale,
    min,
    max,
    isDisabled,
    initialView,
    onpick,
    idPrefix = autoId,
    ariaLabel = 'calendar',
    class: className = '',
  }: Props = $props();

  // ---- validated inputs (props arrive as trust-but-verify strings) --------
  const minIso = $derived(validIso(min));
  const maxIso = $derived(validIso(max));
  const rStart = $derived(validIso(rangeStart));
  const rEnd = $derived(validIso(rangeEnd));
  const anchorSet = $derived.by(() => {
    const set = new Set<string>();
    for (const a of anchors) {
      const iso = validIso(a);
      if (iso != null) set.add(iso);
    }
    return set;
  });

  // ---- view state: the month on stage + the keyboard cursor ---------------
  // initial month/cursor: initialView when valid, else today (a fresh
  // clock read per mount — todayIso() never caches)
  // initial-only BY CONTRACT ("初始视图月"): hosts reset the view by
  // remounting (date-picker's {#if open}) or own it themselves — a
  // reactive re-read here would fight the host's view state
  // svelte-ignore state_referenced_locally
  const initialAnchor = validIso(initialView) ?? todayIso();
  const initialParsed = parseIso(initialAnchor)!; // todayIso is valid by construction
  let viewYear = $state(initialParsed.year);
  let viewMonth = $state(initialParsed.month);
  let activeIso = $state<string>(initialAnchor);
  let gridEl = $state<HTMLDivElement | null>(null);

  // today, snapshotted once per instantiation — the ring is cosmetic and a
  // per-midnight recompute isn't worth a timer (date-picker.svelte law)
  const today = todayIso();

  interface DayCell {
    iso: string;
    day: number;
    out: boolean;
    disabled: boolean;
    today: boolean;
  }

  const weeks = $derived.by(() => {
    const cells: DayCell[] = [];
    const make = (iso: string, day: number, out: boolean): DayCell => ({
      iso,
      day,
      out,
      disabled:
        (minIso != null && iso < minIso) ||
        (maxIso != null && iso > maxIso) ||
        (isDisabled?.(iso) ?? false),
      today: iso === today,
    });
    // Monday-first offset of the 1st
    const offset = (new Date(viewYear, viewMonth, 1).getDay() + 6) % 7;
    const dim = daysInMonth(viewYear, viewMonth);
    const prevYear = viewMonth === 0 ? viewYear - 1 : viewYear;
    const prevMonth = viewMonth === 0 ? 11 : viewMonth - 1;
    const prevDim = daysInMonth(prevYear, prevMonth);
    for (let i = offset; i > 0; i--) cells.push(make(isoOf(prevYear, prevMonth, prevDim - i + 1), prevDim - i + 1, true));
    for (let d = 1; d <= dim; d++) cells.push(make(isoOf(viewYear, viewMonth, d), d, false));
    // pad the tail so every week row is exactly 7 cells
    const nextYear = viewMonth === 11 ? viewYear + 1 : viewYear;
    const nextMonth = viewMonth === 11 ? 0 : viewMonth + 1;
    const tail = (7 - (cells.length % 7)) % 7;
    for (let d = 1; d <= tail; d++) cells.push(make(isoOf(nextYear, nextMonth, d), d, true));
    const rows: DayCell[][] = [];
    for (let i = 0; i < cells.length; i += 7) rows.push(cells.slice(i, i + 7));
    return rows;
  });

  // ---- locale: the vocabulary renders through Intl (month label,
  // weekday heads + their aria-labels); LIVE — the ambient channel
  // (lib/locale.svelte.ts) watches <html lang> with a MutationObserver
  // so a page retarget re-renders mounted panels, and an explicit
  // locale prop outranks it --------------------------------------------
  const loc = $derived(locale ?? ambientLocale());
  const monthLabel = $derived(monthYearLabel(loc, viewYear, viewMonth));
  const weekdayHeads = $derived(weekdayNames(loc, 'short'));
  const weekdayAria = $derived(weekdayNames(loc, 'long'));
  // nav clamps: disable when the entire neighbor month sits out of bounds
  const prevDisabled = $derived.by(() => {
    if (minIso == null) return false;
    const y = viewMonth === 0 ? viewYear - 1 : viewYear;
    const m = viewMonth === 0 ? 11 : viewMonth - 1;
    return isoOf(y, m, daysInMonth(y, m)) < minIso;
  });
  const nextDisabled = $derived.by(() => {
    if (maxIso == null) return false;
    const y = viewMonth === 11 ? viewYear + 1 : viewYear;
    const m = viewMonth === 11 ? 0 : viewMonth + 1;
    return isoOf(y, m, 1) > maxIso;
  });

  const activeCellId = $derived(`${idPrefix}-d-${activeIso}`);

  function inRange(iso: string): boolean {
    return rStart != null && rEnd != null && iso > rStart && iso < rEnd;
  }

  // ---- hover-to-week preview (weekHover): the hovered day's whole
  // Monday-first week takes the same tint law as the picked range,
  // INCLUSIVE of both ends and of out-month cells — the week is 7 days
  // whatever month the cells belong to. Pointer-tracked only: the
  // keyboard cursor (activeIso) is the a11y path and paints its own law.
  let hoverIso = $state<string | undefined>(undefined);
  const hoverWeek = $derived.by(() => {
    const iso = validIso(hoverIso);
    if (!weekHover || !iso) return undefined;
    const p = parseIso(iso)!;
    const dow = new Date(Date.UTC(p.year, p.month, p.day)).getUTCDay(); // 0=Sunday
    const monday = addDays(iso, -((dow + 6) % 7));
    return { start: monday, end: addDays(monday, 6) };
  });

  function inHoverWeek(iso: string): boolean {
    return hoverWeek != null && iso >= hoverWeek.start && iso <= hoverWeek.end;
  }

  function stepMonth(delta: 1 | -1): void {
    viewMonth += delta;
    if (viewMonth < 0) {
      viewMonth = 11;
      viewYear -= 1;
    } else if (viewMonth > 11) {
      viewMonth = 0;
      viewYear += 1;
    }
  }

  // ---- picking: the cursor lands, the host decides -------------------------
  function pick(iso: string): void {
    const cell = weeks.flat().find((c) => c.iso === iso);
    if (!cell || cell.disabled || cell.out) return;
    activeIso = iso;
    onpick?.(iso);
  }

  // the disabled law the walk honors: a day the cursor may not LAND on —
  // min/max bounds and isDisabled cells (out cells are stepped through as
  // today; they were never landable and pick() refuses them). Only STAGED
  // cells are known: beyond the mounted months the cursor may rest on an
  // unknown-disabled day and Enter refuses it there (the pre-existing
  // min/max walk contract, unchanged).
  function walkBlocked(iso: string): boolean {
    const cell = weeks.flat().find((c) => c.iso === iso);
    return cell != null && !cell.out && cell.disabled;
  }

  function onGridKeydown(event: KeyboardEvent): void {
    let delta = 0;
    if (event.key === 'ArrowLeft') delta = -1;
    else if (event.key === 'ArrowRight') delta = 1;
    else if (event.key === 'ArrowUp') delta = -7;
    else if (event.key === 'ArrowDown') delta = 7;
    if (delta !== 0) {
      event.preventDefault();
      // the arrow walk SKIPS disabled days (the isDisabled law): keep
      // stepping in the same direction until a landable day — the sweep
      // is capped at two leap years so a fully disabled calendar can
      // never trap the cursor in a loop
      let next = addDays(activeIso, delta);
      for (let i = 0; i < 732 && walkBlocked(next); i++) next = addDays(next, delta);
      activeIso = next;
      // the view follows the cursor across month boundaries
      const p = parseIso(activeIso)!;
      viewYear = p.year;
      viewMonth = p.month;
      return;
    }
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      pick(activeIso);
    }
    // Escape belongs to the host (e.g. popover="auto" closes on it natively)
  }

  /** focus the grid — hosts call this when their popover opens */
  export function focusGrid(): void {
    gridEl?.focus();
  }
</script>

<div data-jx-calendar class={className} onpointerleave={() => (hoverIso = undefined)}>
  <!-- the nav→grid seam is a POSITIVE section gap (mb-1): the old
       -mb-2.5 pulled the weekday row 10px up INTO the nav band — the
       h-7 button boxes (28px) overlapped the h-6 header cells' tops,
       and a hovered nav button painted behind the weekday glyphs
       (Owner catch 2026-08-29: nav 与日期视图错位) -->
  <div data-jx-date-nav class="flex items-center justify-between gap-2 mb-1">
    <!-- nav glyphs through the Icon component; date-picker.css sizes
         any svg descendant to 13px, the strokier chevrons ride the
         strokeWidth prop -->
    <button
      type="button"
      class="jx-date-nav-btn inline-flex items-center justify-center w-7 h-7 p-0 border border-transparent bg-transparent text-terminal-foreground cursor-pointer transition-[background-color,transform] duration-100 ease-out disabled:cursor-not-allowed"
      aria-label="previous month"
      disabled={prevDisabled}
      onclick={() => stepMonth(-1)}
    >
      <Icon name="chevronLeft" strokeWidth={2.5} />
    </button>
    <span data-jx-date-month class="font-nav text-[11px] tracking-[0.2em] uppercase">{monthLabel}</span>
    <button
      type="button"
      class="jx-date-nav-btn inline-flex items-center justify-center w-7 h-7 p-0 border border-transparent bg-transparent text-terminal-foreground cursor-pointer transition-[background-color,transform] duration-100 ease-out disabled:cursor-not-allowed"
      aria-label="next month"
      disabled={nextDisabled}
      onclick={() => stepMonth(1)}
    >
      <Icon name="chevronRight" strokeWidth={2.5} />
    </button>
  </div>

  <div
    bind:this={gridEl}
    id={`${idPrefix}-grid`}
    class="jx-date-grid flex flex-col gap-0.5"
    role="grid"
    tabindex="-1"
    aria-label={ariaLabel}
    aria-activedescendant={activeCellId}
    onkeydown={onGridKeydown}
  >
    <div role="row" data-jx-date-headrow class="grid grid-cols-[repeat(7,2rem)] gap-0.5">
      {#each weekdayHeads as wd, index (wd)}
        <span role="columnheader" data-jx-date-weekday class="flex items-center justify-center h-6 font-nav text-[10px] tracking-[0.08em] uppercase text-[color-mix(in_oklab,var(--terminal-foreground)_55%,transparent)]" aria-label={weekdayAria[index]}>{wd}</span>
      {/each}
    </div>
    {#each weeks as week}
      <div role="row" data-jx-date-weekrow class="grid grid-cols-[repeat(7,2rem)] gap-0.5">
        {#each week as cell (cell.iso)}
          {#if cell.out}
            <!-- out cells join the hover-week preview (the week is 7
                 days whatever month the cells belong to); they never
                 take the picked-range tint — that law stays in-month -->
            <div
              role="gridcell"
              data-jx-date-out
              data-jx-date-week-hover={inHoverWeek(cell.iso) ? '' : undefined}
              class={cn(
                'jx-date-day inline-flex items-center justify-center w-8 h-8 border border-transparent bg-transparent text-[color-mix(in_oklab,var(--terminal-foreground)_72%,transparent)] tabular-nums leading-none cursor-default select-none opacity-35',
                inHoverWeek(cell.iso) && 'bg-[color-mix(in_oklab,var(--primary)_14%,transparent)]',
              )}
              aria-hidden="true"
              onpointerenter={weekHover ? () => (hoverIso = cell.iso) : undefined}
            >{cell.day}</div>
          {:else}
            <!-- cells are click-only BY PATTERN (select.svelte law): the
                 keyboard path rides the focusable grid + the
                 aria-activedescendant cursor, never the cell itself -->
            <!-- svelte-ignore a11y_click_events_have_key_events, a11y_interactive_supports_focus -->
            <div
              role="gridcell"
              id={`${idPrefix}-d-${cell.iso}`}
              data-jx-date-today={cell.today ? '' : undefined}
              data-jx-date-in={inRange(cell.iso) ? '' : undefined}
              data-jx-date-week-hover={inHoverWeek(cell.iso) ? '' : undefined}
              class={cn(
                'jx-date-day inline-flex items-center justify-center w-8 h-8 border border-transparent bg-transparent text-[color-mix(in_oklab,var(--terminal-foreground)_72%,transparent)] tabular-nums leading-none cursor-pointer select-none transition-[background-color,color] duration-100 ease-out',
                cell.today && 'border-primary',
                anchorSet.has(cell.iso) && 'jx-date-fill bg-primary text-primary-foreground',
                inRange(cell.iso) && !anchorSet.has(cell.iso) && 'bg-[color-mix(in_oklab,var(--primary)_14%,transparent)]',
                inHoverWeek(cell.iso) && !anchorSet.has(cell.iso) && 'bg-[color-mix(in_oklab,var(--primary)_14%,transparent)]',
                cell.disabled && 'jx-date-off opacity-30 cursor-not-allowed',
                cell.iso === activeIso && 'jx-date-active',
              )}
              aria-selected={anchorSet.has(cell.iso) ? 'true' : 'false'}
              aria-disabled={cell.disabled ? 'true' : undefined}
              onpointerenter={weekHover ? () => (hoverIso = cell.iso) : undefined}
              onclick={() => pick(cell.iso)}
            >{cell.day}</div>
          {/if}
        {/each}
      </div>
    {/each}
  </div>
</div>
