// calendar-math — the shared zero-dependency date vocabulary of the
// date-picker family (registry/files/ui/date-picker/calendar-math.ts).
//
// Original request (2026-08-28): “从 date-picker 抽取可嵌入日历片段，供
// Input 组件的 picker 桥消费” — the math moved out of date-picker.svelte so
// the embeddable calendar.svelte (grid fragment) and the popover host share
// one source. Original request (2026-08-29): “为 Input 重写补齐
// date-picker 家族片段” — the ISO week vocabulary joined for the week
// picker fragment. Orthogonal intents:
//
// 1. English month/weekday vocabulary — month labels, locale-style
//    display, Monday-first grid headers.
// 2. strict ISO "YYYY-MM-DD" math — hand-rolled leap years, month lengths
//    and day arithmetic over UTC Date (zero date libraries); zero-padded
//    ISO strings compare correctly as plain strings, which is why every
//    bound/range edge in the family is a plain < / > comparison.
// 3. strict ISO 8601 week math ("YYYY-Www") — Monday-first weeks where
//    week 1 holds the year's first Thursday (Jan 4 is always in W01);
//    edge days can belong to a NEIGHBOR ISO year. Pure Date.UTC
//    arithmetic only — no locale tricks, no Date globals.
// 4. strict datetime math ("YYYY-MM-DDTHH:mm") — the showTime value
//    domain (enhance-picker-feedback, 2026-08-30): a local wall-clock
//    split/compose/format vocabulary with NO zone conversion; the
//    localized display formats the wall-clock fields AS UTC.
//
// Everything here is pure. todayIso() reads the clock on every call —
// never a module-level snapshot (a long-lived host must not freeze
// "today" at bundle time).

// ---- locale vocabulary (Intl; Owner request 2026-08-30) ----------------
// Month/weekday words render through Intl.DateTimeFormat — the
// platform's own CLDR tables, zero dependencies, every locale the
// engine knows. Formatters are cached per (locale, shape); the week
// vocabulary reads a Monday-first anchor week (2024-01-01 IS a
// Monday) and every date formats in UTC, so output is deterministic
// in any runtime timezone. The legacy English constants retired here
// were this section's 'en' row, hand-rolled.

const fmtCache = new Map<string, Intl.DateTimeFormat>();
function cachedFmt(locale: string, opts: Intl.DateTimeFormatOptions): Intl.DateTimeFormat {
  const key = `${locale}|${JSON.stringify(opts)}`;
  let f = fmtCache.get(key);
  if (!f) {
    f = new Intl.DateTimeFormat(locale, { timeZone: 'UTC', ...opts });
    fmtCache.set(key, f);
  }
  return f;
}

/** the ambient locale lives in lib/locale.svelte.ts — a LIVE $state
    + MutationObserver channel (2026-08-30), not this pure module */

/** Monday-first weekday names ("short" heads the grid, "long" rides
    the columnheader aria-labels) */
export function weekdayNames(locale: string, style: 'short' | 'long' = 'short'): string[] {
  const f = cachedFmt(locale, { weekday: style });
  return Array.from({ length: 7 }, (_, i) => f.format(new Date(Date.UTC(2024, 0, 1 + i))));
}

/** month names in 0-based index order */
export function monthNames(locale: string, style: 'long' | 'short' = 'long'): string[] {
  const f = cachedFmt(locale, { month: style });
  return Array.from({ length: 12 }, (_, i) => f.format(new Date(Date.UTC(2024, i, 1))));
}

/** the nav label — ONE formatter so the LOCALE owns the field order
    and spacing ("August 2026" / "2026年8月"), never concatenation */
export function monthYearLabel(locale: string, year: number, month: number): string {
  return cachedFmt(locale, { year: 'numeric', month: 'long' }).format(
    new Date(Date.UTC(year, month, 1)),
  );
}

/** a locale-formatted day for trigger lanes ("Aug 30, 2026" /
    "2026年8月30日"); the VALUE stays ISO always */
export function dayLabel(locale: string, iso: string): string {
  const p = parseIso(iso);
  if (!p) return iso;
  return cachedFmt(locale, { year: 'numeric', month: 'short', day: 'numeric' }).format(
    new Date(Date.UTC(p.year, p.month, p.day)),
  );
}

/** a locale-formatted day+time for the showTime trigger lane ("Aug 30,
    2026, 2:05 PM" / "2026年8月30日 14:05") — the wall-clock fields are
    formatted AS UTC so no zone conversion ever touches them; the VALUE
    stays the canonical "YYYY-MM-DDTHH:mm" always */
export function dayTimeLabel(locale: string, dateTime: string): string {
  const p = parseDateTime(dateTime);
  if (!p) return dateTime;
  const y = Number(p.date.slice(0, 4));
  const mo = Number(p.date.slice(5, 7)) - 1;
  const d = Number(p.date.slice(8, 10));
  const h = Number(p.time.slice(0, 2));
  const mi = Number(p.time.slice(3, 5));
  return cachedFmt(locale, {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  }).format(new Date(Date.UTC(y, mo, d, h, mi)));
}

// ---- datetime ("YYYY-MM-DDTHH:mm" — the showTime value domain) ----------
// The datetime contract (enhance-picker-feedback, 2026-08-30): the
// CANONICAL stored value is a local wall-clock "YYYY-MM-DDTHH:mm" — no
// zone conversion anywhere; the calendar grid consumes the DATE part and
// the TimeStepper mutates only the TIME part. These helpers are the strict
// parse/format half of that contract (the compose/preserve logic lives in
// date-picker.svelte, the same split as the ISO vocabulary).

const DATETIME_RE = /^(\d{4}-\d{2}-\d{2})T(\d{2}):(\d{2})$/;

/** strict split of a canonical datetime into its date and normalized
 *  "HH:MM" parts — null unless BOTH halves validate (a real calendar day,
 *  hour ≤ 23, minute ≤ 59). Unpadded or malformed input is rejected, not
 *  repaired: values arrive as trust-but-verify strings. */
export function parseDateTime(
  v: string | undefined
): { date: string; time: string } | null {
  if (!v) return null;
  const m = DATETIME_RE.exec(v);
  if (!m) return null;
  const date = validIso(m[1]);
  const h = Number(m[2]);
  const mi = Number(m[3]);
  if (date == null || h > 23 || mi > 59) return null;
  return { date, time: `${pad2(h)}:${pad2(mi)}` };
}

/** validated-or-undefined canonical "YYYY-MM-DDTHH:mm" (normalized) */
export function validDateTime(v: string | undefined): string | undefined {
  const p = parseDateTime(v);
  return p ? `${p.date}T${p.time}` : undefined;
}

/** compose a canonical datetime from a date half and an "HH:MM" half —
 *  an absent time half is the wall-clock midnight default */
export function composeDateTime(date: string, time?: string): string {
  return `${date}T${time ?? '00:00'}`;
}

const ISO_RE = /^(\d{4})-(\d{2})-(\d{2})$/;
const MONTH_LENGTHS = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];

/** 2-digit zero pad ("07"). */
export function pad2(n: number): string {
  return String(n).padStart(2, '0');
}

/** Month length with the leap-year correction (month is 0-based). */
export function daysInMonth(year: number, month: number): number {
  if (month === 1) {
    const leap = (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
    return leap ? 29 : 28;
  }
  return MONTH_LENGTHS[month];
}

/** ISO "YYYY-MM-DD" of a (year, 0-based month, day) triple. */
export function isoOf(year: number, month: number, day: number): string {
  return `${year}-${pad2(month + 1)}-${pad2(day)}`;
}

/** strict parse — null when malformed or not a real calendar day */
export function parseIso(
  iso: string | undefined
): { year: number; month: number; day: number } | null {
  if (!iso) return null;
  const m = ISO_RE.exec(iso);
  if (!m) return null;
  const year = Number(m[1]);
  const month = Number(m[2]) - 1;
  const day = Number(m[3]);
  if (month < 0 || month > 11 || day < 1 || day > daysInMonth(year, month)) return null;
  return { year, month, day };
}

/** validated-or-undefined ISO (props arrive as trust-but-verify strings) */
export function validIso(iso: string | undefined): string | undefined {
  const p = parseIso(iso);
  return p ? isoOf(p.year, p.month, p.day) : undefined;
}

/** day arithmetic across month/year boundaries (UTC Date, zero-dep);
    internal callers only ever pass validated ISO strings */
export function addDays(iso: string, delta: number): string {
  const p = parseIso(iso)!;
  const d = new Date(Date.UTC(p.year, p.month, p.day + delta));
  return isoOf(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
}

// ---- ISO 8601 weeks ("YYYY-Www") ------------------------------------------
// Rules (deterministic Date.UTC arithmetic, no locale): weeks run
// Monday→Sunday; week 1 is the week holding the year's first Thursday,
// which is why Jan 4 is ALWAYS inside W01; days at the year edges can
// belong to the previous or next ISO year ("2027-01-01" → "2026-W53").
const ISO_WEEK_RE = /^(\d{4})-W(\d{2})$/;
const MS_PER_DAY = 86_400_000;

/** Monday-first weekday index (Mon=0 … Sun=6) of a UTC y/m/d triple. */
function weekdayIndex(year: number, month: number, day: number): number {
  return (new Date(Date.UTC(year, month, day)).getUTCDay() + 6) % 7;
}

/** Monday of a year's week 1 — the Monday of the week holding Jan 4. */
function week1MondayUtc(isoYear: number): number {
  return Date.UTC(isoYear, 0, 4 - weekdayIndex(isoYear, 0, 4));
}

/** "2026-08-29" → "2026-W35" (the day's ISO week); undefined on invalid
    iso. The ISO YEAR is fixed by the week's Thursday, so a day can map
    into a neighbor year's numbering ("2027-01-01" → "2026-W53"). */
export function isoWeekOf(iso: string): string | undefined {
  const p = parseIso(iso);
  if (!p) return undefined;
  // Monday of iso's own week; the Thursday three days later pins the year
  const monday = Date.UTC(p.year, p.month, p.day - weekdayIndex(p.year, p.month, p.day));
  const isoYear = new Date(monday + 3 * MS_PER_DAY).getUTCFullYear();
  // both endpoints are UTC-Midnight Mondays → the division is exact
  const week = (monday - week1MondayUtc(isoYear)) / (7 * MS_PER_DAY) + 1;
  return `${isoYear}-W${pad2(week)}`;
}

/** "2026-W35" → "2026-08-24" (that week's Monday); undefined on invalid
    week strings. The Monday can land in the PREVIOUS calendar year
    ("2026-W01" → "2025-12-29"), and W53 only exists for long ISO years —
    a trust-but-verify round-trip rejects the years where it doesn't. */
export function mondayOfIsoWeek(week: string): string | undefined {
  const m = ISO_WEEK_RE.exec(week);
  if (!m) return undefined;
  const year = Number(m[1]);
  const w = Number(m[2]);
  if (w < 1 || w > 53) return undefined;
  const monday = new Date(week1MondayUtc(year) + (w - 1) * 7 * MS_PER_DAY);
  const iso = isoOf(monday.getUTCFullYear(), monday.getUTCMonth(), monday.getUTCDate());
  return isoWeekOf(iso) === `${year}-W${pad2(w)}` ? iso : undefined;
}

/** today as ISO "YYYY-MM-DD" — fresh clock read on every call (the local
    calendar day, never cached across midnights) */
export function todayIso(): string {
  const now = new Date();
  return isoOf(now.getFullYear(), now.getMonth(), now.getDate());
}
