<!--
  jixoai month grid (registry/files/ui/date-picker/month-grid.svelte).

  Original request (2026-08-29): “为 Input 重写补齐 date-picker 家族片段”
  — the popover-internal "YYYY-MM" picker for the picker family's month
  panels. It is calendar.svelte's exact law, coarsened from days to
  months. Orthogonal intents:

  1. view state — the year on stage (viewYear, initialized from anchor or
     the current year) and the aria-activedescendant cursor activeYm.
  2. grid derivation — a 4×3 grid of MONTHS_SHORT cells; inclusive
     min/max disabling (plain string comparison on "YYYY-MM"); the anchor
     month painted with the calendar's anchor fill.
  3. keyboard — the calendar's exact roving law: the grid is one focus
     stop (tabindex=-1 + focusGrid() for hosts); arrows walk by cell
     (±1) / by row (±3) with the 12-cell year wrapping across year
     boundaries, the view year follows the cursor, Enter/Space pick;
     Escape belongs to the host popover. Cross-year moves stop at the
     [min,max] year reach; within a reachable year the cursor may land
     on disabled months (Enter refuses them — calendar parity).

  Bounds tolerate "YYYY-MM-DD" by slicing the first 7 characters. All
  month props arrive as trust-but-verify strings. Styles mirror
  calendar.svelte exactly: markup token utilities + the shared
  date-picker.css sheet (imported below — .jx-date-nav-btn for the year
  chevrons, .jx-date-day + the jx-date-fill/off/active state language
  for the cells); no month-specific css file exists because none is
  needed. Selection semantics and popover orchestration stay in the
  HOST — this fragment only fires onpick("YYYY-MM").
-->
<script lang="ts">
  import Icon from '$lib/ui/icon';
  import { cn } from '$lib/utils';
  import { monthNames, pad2 } from './calendar-math';
  import { ambientLocale } from '$lib/locale.svelte';
  import './date-picker.css';

  interface Props {
    /** "YYYY-MM" — the anchor month (painted) + initial view year; default = current month */
    anchor?: string;
    /** "YYYY-MM" inclusive bounds (tolerate "YYYY-MM-DD" by slicing the first 7) */
    min?: string;
    /** "YYYY-MM" inclusive upper bound (same tolerance) */
    max?: string;
    /** picked a non-disabled month */
    onpick?: (v: string) => void;
    /** BCP 47 locale for the month-cell vocabulary (Intl short
        months); default = the page's <html lang> (2026-08-30) */
    locale?: string;
    /** aria id prefix (cursor cell id = `${idPrefix}-m-YYYY-MM`, the grid is `${idPrefix}-grid`); default 'jx-month' */
    idPrefix?: string;
  }

  let {
    anchor,
    min,
    max,
    onpick,
    locale,
    idPrefix = 'jx-month',
  }: Props = $props();

  // ---- validated inputs (props arrive as trust-but-verify strings) --------
  const MONTH_RE = /^(\d{4})-(\d{2})$/;

  /** strict "YYYY-MM" ("YYYY-MM-DD" tolerated by slicing the first 7) */
  function validMonth(v: string | undefined): string | undefined {
    const head = (v ?? '').slice(0, 7);
    const m = MONTH_RE.exec(head);
    if (!m) return undefined;
    return Number(m[2]) >= 1 && Number(m[2]) <= 12 ? head : undefined;
  }

  const minMonth = $derived(validMonth(min));
  const maxMonth = $derived(validMonth(max));
  const anchorMonth = $derived(validMonth(anchor));
  const minYear = $derived(minMonth != null ? Number(minMonth.slice(0, 4)) : undefined);
  const maxYear = $derived(maxMonth != null ? Number(maxMonth.slice(0, 4)) : undefined);

  // ---- view state: the year on stage + the keyboard cursor ----------------
  // initial year/cursor: anchor when valid, else the current month (a
  // fresh clock read per mount — the calendar.svelte initial-only law:
  // hosts reset the view by remounting, a reactive re-read would fight
  // the host's view state)
  // svelte-ignore state_referenced_locally
  const initialYm = anchorMonth ?? `${new Date().getFullYear()}-${pad2(new Date().getMonth() + 1)}`;
  let viewYear = $state(Number(initialYm.slice(0, 4)));
  let activeYm = $state(initialYm);
  let gridEl = $state<HTMLDivElement | null>(null);

  interface MonthCell {
    ym: string;
    label: string;
    disabled: boolean;
    anchor: boolean;
  }

  const rows = $derived.by(() => {
    // the cell vocabulary renders through Intl (the page's <html lang>
    // unless the host passes a locale — calendar.svelte's law)
    const names = monthNames(locale ?? ambientLocale(), 'short');
    const cells: MonthCell[] = names.map((label, index) => {
      const ym = `${viewYear}-${pad2(index + 1)}`;
      return {
        ym,
        label,
        disabled: (minMonth != null && ym < minMonth) || (maxMonth != null && ym > maxMonth),
        anchor: ym === anchorMonth,
      };
    });
    return [
      cells.slice(0, 3),
      cells.slice(3, 6),
      cells.slice(6, 9),
      cells.slice(9, 12),
    ];
  });

  // nav clamps: disable when no month of the neighbor year is in bounds
  const prevDisabled = $derived(minYear != null && viewYear - 1 < minYear);
  const nextDisabled = $derived(maxYear != null && viewYear + 1 > maxYear);

  const activeCellId = $derived(`${idPrefix}-m-${activeYm}`);

  // ---- picking: the cursor lands, the host decides -------------------------
  function pick(ym: string): void {
    if ((minMonth != null && ym < minMonth) || (maxMonth != null && ym > maxMonth)) return;
    activeYm = ym;
    onpick?.(ym);
  }

  /** arrows walk the 12-cell year linearly (±1 cell, ±3 = one row) with
      wrap across year boundaries; the view year follows the cursor.
      Cross-year moves stop when the target year is out of [min,max]
      reach; within a reachable year the cursor may land on disabled
      months (Enter refuses them — calendar parity) */
  function moveCursor(delta: number): void {
    let year = Number(activeYm.slice(0, 4));
    let index = Number(activeYm.slice(5, 7)) - 1 + delta; // 0-based, may leave [0,11]
    if (index < 0 || index > 11) {
      year += index < 0 ? -1 : 1;
      index = ((index % 12) + 12) % 12;
      if ((minYear != null && year < minYear) || (maxYear != null && year > maxYear)) return;
    }
    activeYm = `${year}-${pad2(index + 1)}`;
    viewYear = year;
  }

  function onGridKeydown(event: KeyboardEvent): void {
    let delta = 0;
    if (event.key === 'ArrowLeft') delta = -1;
    else if (event.key === 'ArrowRight') delta = 1;
    else if (event.key === 'ArrowUp') delta = -3;
    else if (event.key === 'ArrowDown') delta = 3;
    if (delta !== 0) {
      event.preventDefault();
      moveCursor(delta);
      return;
    }
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      pick(activeYm);
    }
    // Escape belongs to the host (e.g. popover="auto" closes on it natively)
  }

  /** focus the grid — hosts call this when their popover opens */
  export function focusGrid(): void {
    gridEl?.focus();
  }
</script>

<div data-jx-month-grid>
  <!-- same seam law as calendar.svelte's date nav: a positive mb-1
       section gap, not the old -mb-2.5 band overlap -->
  <div data-jx-month-nav class="flex items-center justify-between gap-2 mb-1">
    <button
      type="button"
      class="jx-date-nav-btn inline-flex items-center justify-center w-7 h-7 p-0 border border-transparent bg-transparent text-terminal-foreground cursor-pointer transition-[background-color,transform] duration-100 ease-out disabled:cursor-not-allowed"
      aria-label="previous year"
      disabled={prevDisabled}
      onclick={() => (viewYear -= 1)}
    >
      <Icon name="chevronLeft" strokeWidth={2.5} />
    </button>
    <span data-jx-month-year class="font-nav text-[11px] tracking-[0.2em] uppercase">{viewYear}</span>
    <button
      type="button"
      class="jx-date-nav-btn inline-flex items-center justify-center w-7 h-7 p-0 border border-transparent bg-transparent text-terminal-foreground cursor-pointer transition-[background-color,transform] duration-100 ease-out disabled:cursor-not-allowed"
      aria-label="next year"
      disabled={nextDisabled}
      onclick={() => (viewYear += 1)}
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
    aria-label="months"
    aria-activedescendant={activeCellId}
    onkeydown={onGridKeydown}
  >
    {#each rows as row}
      <div role="row" data-jx-month-row class="grid grid-cols-[repeat(3,2rem)] gap-0.5">
        {#each row as cell (cell.ym)}
          <!-- cells are click-only BY PATTERN (calendar.svelte law): the
               keyboard path rides the focusable grid + the
               aria-activedescendant cursor, never the cell itself -->
          <!-- svelte-ignore a11y_click_events_have_key_events, a11y_interactive_supports_focus -->
          <div
            role="gridcell"
            id={`${idPrefix}-m-${cell.ym}`}
            data-jx-date-out={cell.disabled ? '' : undefined}
            class={cn(
              'jx-date-day inline-flex items-center justify-center w-8 h-8 border border-transparent bg-transparent text-[color-mix(in_oklab,var(--terminal-foreground)_72%,transparent)] font-nav text-[11px] leading-none cursor-pointer select-none transition-[background-color,color] duration-100 ease-out',
              cell.anchor && 'jx-date-fill bg-primary text-primary-foreground',
              cell.disabled && 'jx-date-off opacity-30 cursor-not-allowed',
              cell.ym === activeYm && 'jx-date-active',
            )}
            aria-selected={cell.anchor ? 'true' : 'false'}
            aria-disabled={cell.disabled ? 'true' : undefined}
            onclick={() => pick(cell.ym)}
          >{cell.label}</div>
        {/each}
      </div>
    {/each}
  </div>
</div>
