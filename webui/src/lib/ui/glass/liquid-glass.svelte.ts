// The liquid-glass mount — framework-agnostic runtime that upgrades a stamped
// element to lens refraction (the ripple.svelte.ts precedent: effects may own
// runtime JS). Svelte consumes it through the `liquidGlass` attachment
// FACTORY below ({@attach liquidGlass(fx)}); framework-less consumers call
// `attachLiquidGlass` directly. First paint stays the law sheet's
// unconditional frost — the lens is an enhancement, never a dependency.
import type { Attachment } from 'svelte/attachments';
import { computeLensField, computeSpecularField } from './glass-map';
import { glassVars } from './glass';
import type { LiquidGlassEffect } from './glass';

export interface LiquidGlassHandle {
  update(fx: LiquidGlassEffect): void;
  destroy(): void;
}

const SVG_NS = 'http://www.w3.org/2000/svg';

let uidCounter = 0;

function el<K extends keyof SVGElementTagNameMap>(
  doc: Document,
  tag: K,
  attrs: Record<string, string | number>,
  parent?: SVGElement,
): SVGElementTagNameMap[K] {
  const n = doc.createElementNS(SVG_NS, tag);
  for (const [k, v] of Object.entries(attrs)) n.setAttribute(k, String(v));
  if (parent) parent.append(n);
  return n;
}

function fieldToDataURL(doc: Document, field: { width: number; height: number; data: Uint8ClampedArray }): string | null {
  const cv = doc.createElement('canvas');
  cv.width = field.width;
  cv.height = field.height;
  const ctx = cv.getContext('2d');
  if (!ctx) return null; // no canvas (jsdom / ancient engines) — frost stands
  const img = ctx.createImageData(field.width, field.height);
  img.data.set(field.data);
  ctx.putImageData(img, 0, 0);
  return cv.toDataURL('image/png');
}

/**
 * kube.io's chain, verbatim order: frost → displace → rim-saturate → the
 * specular pair (saturated displaced copy clipped by the ring's alpha, plus
 * the faded ring itself).
 */
export function buildFilter(
  doc: Document,
  id: string,
  fx: LiquidGlassEffect,
  lensURL: string,
  specURL: string,
  w: number,
  h: number,
): SVGElement {
  const filter = el(doc, 'filter', {
    id,
    'color-interpolation-filters': 'sRGB',
  });
  el(doc, 'feGaussianBlur', { in: 'SourceGraphic', stdDeviation: fx.blur, result: 'blurred_source' }, filter);
  el(doc, 'feImage', { href: lensURL, x: 0, y: 0, width: w, height: h, result: 'displacement_map' }, filter);
  el(doc, 'feDisplacementMap', {
    in: 'blurred_source',
    in2: 'displacement_map',
    xChannelSelector: 'R',
    yChannelSelector: 'G',
    result: 'displaced',
    scale: fx.scale,
  }, filter);
  el(doc, 'feColorMatrix', { in: 'displaced', type: 'saturate', values: fx.rimSaturate, result: 'displaced_saturated' }, filter);
  el(doc, 'feImage', { href: specURL, x: 0, y: 0, width: w, height: h, result: 'specular_layer' }, filter);
  el(doc, 'feComposite', { in: 'displaced_saturated', in2: 'specular_layer', operator: 'in', result: 'specular_saturated' }, filter);
  const ct = el(doc, 'feComponentTransfer', { in: 'specular_layer', result: 'specular_faded' }, filter);
  el(doc, 'feFuncA', { type: 'linear', slope: fx.specular }, ct);
  el(doc, 'feBlend', { in: 'specular_saturated', in2: 'displaced', mode: 'normal', result: 'withSaturation' }, filter);
  el(doc, 'feBlend', { in: 'specular_faded', in2: 'withSaturation', mode: 'normal' }, filter);
  return filter;
}

function measure(target: HTMLElement, fx: LiquidGlassEffect): { w: number; h: number; radius: number } | null {
  const rect = target.getBoundingClientRect();
  const w = Math.round(rect.width);
  const h = Math.round(rect.height);
  if (w < 8 || h < 8) return null; // zero-size (display:none) — the RO catches it appearing
  const max = Math.min(w, h) / 2;
  let radius: number;
  if (fx.shape === 'capsule') radius = max; // the semantic shape override wins
  else if (typeof fx.shape === 'number') radius = Math.min(Math.max(0, fx.shape), max);
  else {
    const cs = getComputedStyle(target);
    const rr = parseFloat(cs.borderTopLeftRadius);
    radius = Number.isFinite(rr) && rr > 0 ? Math.min(rr, max) : max;
  }
  return { w, h, radius };
}

function stampVars(target: HTMLElement, fx: LiquidGlassEffect): void {
  target.setAttribute('data-jx-effect', 'liquid-glass');
  const style = target.getAttribute('style') ?? '';
  const kept = style.replace(/--jx-glass-[a-z-]+:[^;]*;?/g, '').trim();
  const vars = glassVars(fx) + ';';
  target.setAttribute('style', kept ? `${kept.replace(/;$/, '')};${vars}` : vars);
}

/**
 * Mount order is the render law: filter node appended to the document FIRST,
 * pointer var written AFTER — a SET pointer never precedes its fragment, so
 * the Chromium whole-chain-drop hazard is unrepresentable through the API.
 */
export function attachLiquidGlass(target: HTMLElement, fx: LiquidGlassEffect): LiquidGlassHandle {
  const doc = target.ownerDocument;
  const id = `jx-lg-${++uidCounter}`;
  const host = el(doc, 'svg', { class: 'jx-glass-host', 'aria-hidden': 'true' });
  host.style.position = 'absolute';
  host.style.width = '0';
  host.style.height = '0';
  let current = fx;
  let lastBox = '';
  let raf = 0;
  let ro: ResizeObserver | null = null;

  const applyVars = () => stampVars(target, current);

  const rebuild = () => {
    const m = measure(target, current);
    host.replaceChildren();
    target.style.removeProperty('--jx-glass-filter');
    if (!m) return;
    const geometry = { width: m.w, height: m.h, radius: m.radius, bezel: current.bezel, thickness: current.thickness, surface: current.surface };
    const lensURL = fieldToDataURL(doc, computeLensField(geometry));
    const specURL = fieldToDataURL(doc, computeSpecularField(geometry));
    if (!lensURL || !specURL) return; // canvas unavailable — frost stands, no crash
    host.append(buildFilter(doc, id, current, lensURL, specURL, m.w, m.h));
    if (!host.isConnected) doc.body.append(host);
    target.style.setProperty('--jx-glass-filter', `url('#${id}')`);
    lastBox = `${m.w}x${m.h}`;
  };

  const schedule = () => {
    cancelAnimationFrame(raf);
    raf = requestAnimationFrame(() => {
      const m = measure(target, current);
      if (m && `${m.w}x${m.h}` !== lastBox) rebuild();
    });
  };

  applyVars();
  rebuild();
  if (typeof ResizeObserver !== 'undefined') {
    ro = new ResizeObserver(schedule);
    ro.observe(target);
  }

  return {
    update(next: LiquidGlassEffect) {
      current = next;
      applyVars();
      rebuild();
    },
    destroy() {
      cancelAnimationFrame(raf);
      ro?.disconnect();
      ro = null;
      host.remove();
      target.style.removeProperty('--jx-glass-filter');
    },
  };
}

/**
 * The attachment FACTORY — `{@attach liquidGlass(fx)}` on the stamped
 * element (the effect-attachments migration): param in, attachment out.
 * Svelte invokes the returned function with (element) and honors its
 * FUNCTION return as the teardown — there is no update channel. A
 * REPLACED fx (the $derived path) is a fresh closure = identity
 * remount: old teardown, then a full rebuild (cheap — the maps
 * regenerate in single-digit ms). Deep mutation is not read by any
 * channel; the kernel's own property reads are the only fine-grained
 * reactivity — params flow, never mutate (the documented law). SSR:
 * attachments are inert server-side, frost-first stands.
 */
export function liquidGlass(fx: LiquidGlassEffect): Attachment<HTMLElement> {
  return (element) => {
    const handle = attachLiquidGlass(element, fx);
    return () => handle.destroy();
  };
}
