/**
 * jixoai color utils (registry/files/lib/color-utils.ts).
 *
 * 2026-08-20 · Form wave 2 (original request: color-picker "格式转换：内部
 * 用 OKLCH 做中间表示（与我们的 token 系统一致），hex/hsl/oklch 互转
 * （零依赖手写转换函数）").
 *
 * 2026-09-06 · katex-mermaid track B: parseColor gains the rgb()/rgba()
 * LEGACY FAMILY — getComputedStyle serializes color probes that way on
 * engines whose origin space is srgb (the mermaid-engine token pipeline
 * feeds computed strings here; see lib/mermaid-engine.ts §token read).
 * Both serializations parse — comma (`rgb(255,0,0)`, `rgba(1,2,3,0.5)`)
 * and space/slash (`rgb(1 2 3)`, `rgb(1 2 3 / 0.25)`) — and alpha is
 * accepted then DISCARDED: the Oklch model is opaque, so
 * `rgba(255,0,0,0.5)` and `rgb(1 2 3 / 0.25)` funnel to #ff0000/#010203
 * (never premultiplied).
 *
 * Zero-dependency color conversions with OKLCH as the intermediate
 * representation — the same space the jixoai token sheet uses. Every parse
 * funnels into {@link Oklch}; every format funnels out of it, so any of
 * hex / hsl / oklch round-trips through one canonical model.
 *
 * Matrices are Björn Ottosson's OKLab ↔ linear sRGB (public domain).
 */

/** The canonical intermediate: L 0..1, C 0..~0.4, H 0..360. */
export interface Oklch {
  l: number;
  c: number;
  h: number;
}

/** Output/input string formats of the color family. */
export type ColorFormat = 'hex' | 'hsl' | 'oklch';

export const colorFormats: readonly ColorFormat[] = ['hex', 'hsl', 'oklch'];

interface Rgb {
  r: number;
  g: number;
  b: number;
} // 0..255

interface Hsv {
  h: number;
  s: number;
  v: number;
} // h 0..360, s/v 0..1

// ---- sRGB transfer functions -------------------------------------------

const linearize = (channel: number): number =>
  channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4;

const delinearize = (channel: number): number =>
  channel <= 0.0031308 ? 12.92 * channel : 1.055 * channel ** (1 / 2.4) - 0.055;

const clamp01 = (n: number): number => Math.min(1, Math.max(0, n));

const hueToRgb = (p: number, q: number, t: number): number => {
  let tt = t;
  if (tt < 0) tt += 1;
  if (tt > 1) tt -= 1;
  if (tt < 1 / 6) return p + (q - p) * 6 * tt;
  if (tt < 1 / 2) return q;
  if (tt < 2 / 3) return p + (q - p) * (2 / 3 - tt) * 6;
  return p;
};

// ---- OKLCH ↔ sRGB (Ottosson matrices) -----------------------------------

export function oklchToRgb(color: Oklch): Rgb {
  const rad = (color.h * Math.PI) / 180;
  const a = color.c * Math.cos(rad);
  const b = color.c * Math.sin(rad);

  const l_ = color.l + 0.3963377774 * a + 0.2158037573 * b;
  const m_ = color.l - 0.1055613458 * a - 0.0638541728 * b;
  const s_ = color.l - 0.0894841775 * a - 1.291485548 * b;

  const l = l_ ** 3;
  const m = m_ ** 3;
  const s = s_ ** 3;

  return {
    r: delinearize(clamp01(4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s)) * 255,
    g: delinearize(clamp01(-1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s)) * 255,
    b: delinearize(clamp01(-0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s)) * 255,
  };
}

export function rgbToOklch(rgb: Rgb): Oklch {
  const r = linearize(rgb.r / 255);
  const g = linearize(rgb.g / 255);
  const b = linearize(rgb.b / 255);

  const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b);
  const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b);
  const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);

  const L = 0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s;
  const a = 1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s;
  const b2 = 0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s;

  let h = (Math.atan2(b2, a) * 180) / Math.PI;
  if (h < 0) h += 360;
  return { l: L, c: Math.sqrt(a * a + b2 * b2), h };
}

// ---- HSV (the SV pad's native geometry) ----------------------------------

export function oklchToHsv(color: Oklch): Hsv {
  const { r, g, b } = oklchToRgb(color);
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const d = max - min;
  let h = 0;
  if (d > 1e-6) {
    if (max === r) h = 60 * (((g - b) / d) % 6);
    else if (max === g) h = 60 * ((b - r) / d + 2);
    else h = 60 * ((r - g) / d + 4);
    if (h < 0) h += 360;
  }
  return { h, s: max <= 1e-6 ? 0 : d / max, v: max / 255 };
}

export function hsvToOklch(h: number, s: number, v: number): Oklch {
  const f = (n: number): number => {
    const k = (n + h / 60) % 6;
    return v - v * s * Math.max(0, Math.min(k, 4 - k, 1));
  };
  return rgbToOklch({ r: f(5) * 255, g: f(3) * 255, b: f(1) * 255 });
}

// ---- string parsing (any of the three formats, prefix-routed) ------------

const clampChannel = (n: number): number => Math.min(255, Math.max(0, n));

/** Parses `#rgb`, `#rrggbb` (alpha hex tolerated, ignored), `rgb()/rgba()`
 *  (comma AND space/slash serializations; alpha accepted, discarded — the
 *  model is opaque, never premultiplied), `hsl(…)`, `oklch(…)`;
 *  returns the OKLCH intermediate or null when unparseable. */
export function parseColor(input: string): Oklch | null {
  const text = input.trim().toLowerCase();
  if (text === '') return null;

  if (text.startsWith('#')) {
    const body = text.slice(1);
    if (!/^[0-9a-f]+$/.test(body)) return null;
    if (body.length === 3) {
      return rgbToOklch({
        r: parseInt(body[0] + body[0], 16),
        g: parseInt(body[1] + body[1], 16),
        b: parseInt(body[2] + body[2], 16),
      });
    }
    if (body.length === 6 || body.length === 8) {
      return rgbToOklch({
        r: parseInt(body.slice(0, 2), 16),
        g: parseInt(body.slice(2, 4), 16),
        b: parseInt(body.slice(4, 6), 16),
      });
    }
    return null;
  }

  // rgb()/rgba() — the legacy family getComputedStyle emits for srgb-origin
  // probes. Two serializations share one funnel: comma (`255,0,0` with an
  // optional trailing `,0.5`) and space/slash (`1 2 3`, `1 2 3 / 0.25`).
  // The slash alpha drops before the split; the comma alpha simply falls
  // off the three-channel read. Per-channel percentages scale ×2.55.
  const rgbMatch = /^rgba?\(([^)]+)\)$/.exec(text);
  if (rgbMatch) {
    const [channelPart, alphaPart] = rgbMatch[1].split('/');
    // a slash-alpha separator only legalizes with a (discarded) value
    if (alphaPart !== undefined && alphaPart.trim() === '') return null;
    const body = channelPart.trim();
    const parts = body.split(/[\s,]+/).filter(Boolean);
    if (parts.length < 3) return null;
    const channel = (part: string): number => {
      const value = Number(part.replace(/%$/, ''));
      if (!Number.isFinite(value)) return Number.NaN;
      return part.endsWith('%') ? (value / 100) * 255 : value;
    };
    const r = channel(parts[0]);
    const g = channel(parts[1]);
    const b = channel(parts[2]);
    if (![r, g, b].every(Number.isFinite)) return null;
    return rgbToOklch({ r: clampChannel(r), g: clampChannel(g), b: clampChannel(b) });
  }

  const hslMatch = /^hsla?\(([^)]+)\)$/.exec(text);
  if (hslMatch) {
    const parts = hslMatch[1].split(/[\s,/]+/).filter(Boolean);
    if (parts.length < 3) return null;
    const h = Number(parts[0].replace(/deg$/, ''));
    const s = Number(parts[1].replace(/%$/, ''));
    const l = Number(parts[2].replace(/%$/, ''));
    if (![h, s, l].every(Number.isFinite)) return null;
    return rgbToOklch(hslToRgb(((h % 360) + 360) % 360, clamp01(s / 100), clamp01(l / 100)));
  }

  const oklchMatch = /^oklch\(([^)]+)\)$/.exec(text);
  if (oklchMatch) {
    // strip a trailing slash-alpha (` / 0.5` or ` / 50%`)
    const body = oklchMatch[1].split('/')[0].trim();
    const parts = body.split(/[\s,]+/).filter(Boolean);
    if (parts.length < 3) return null;
    let l = Number(parts[0].replace(/%$/, ''));
    if (parts[0].endsWith('%')) l = l / 100;
    const c = Number(parts[1]);
    const h = Number(parts[2].replace(/deg|none$/, '').trim()) || 0;
    if (![l, c].every(Number.isFinite)) return null;
    return { l: clamp01(l), c: Math.max(0, c), h: ((h % 360) + 360) % 360 };
  }

  return null;
}

function hslToRgb(h: number, s: number, l: number): Rgb {
  if (s === 0) {
    const gray = l * 255;
    return { r: gray, g: gray, b: gray };
  }
  const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
  const p = 2 * l - q;
  return {
    r: clampChannel(hueToRgb(p, q, h / 360 + 1 / 3) * 255),
    g: clampChannel(hueToRgb(p, q, h / 360) * 255),
    b: clampChannel(hueToRgb(p, q, h / 360 - 1 / 3) * 255),
  };
}

function rgbToHslString(rgb: Rgb): string {
  const r = rgb.r / 255;
  const g = rgb.g / 255;
  const b = rgb.b / 255;
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const l = (max + min) / 2;
  const d = max - min;
  let h = 0;
  let s = 0;
  if (d > 1e-6) {
    s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
    if (max === r) h = ((g - b) / d) % 6;
    else if (max === g) h = (b - r) / d + 2;
    else h = (r - g) / d + 4;
    h *= 60;
    if (h < 0) h += 360;
  }
  const num = (n: number): string => (Math.round(n * 10) / 10).toString();
  return `hsl(${num(h)} ${num(s * 100)}% ${num(l * 100)}%)`;
}

// ---- formatting -----------------------------------------------------------

/** Trims trailing zeros: 0.500 → "0.5", 200.0 → "200". */
function trim(n: number): string {
  return String(parseFloat(n.toFixed(3)));
}

export function formatColor(color: Oklch, format: ColorFormat): string {
  switch (format) {
    case 'hex': {
      const { r, g, b } = oklchToRgb(color);
      const hex = (n: number): string =>
        Math.round(clampChannel(n)).toString(16).padStart(2, '0');
      return `#${hex(r)}${hex(g)}${hex(b)}`;
    }
    case 'hsl':
      return rgbToHslString(oklchToRgb(color));
    case 'oklch':
      return `oklch(${trim(color.l)} ${trim(color.c)} ${trim(color.h)})`;
  }
}
