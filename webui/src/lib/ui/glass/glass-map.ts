// The liquid-glass field core — kube.io's generator, ported from their shipped
// blog bundle and verified against their decoded displacement/specular maps.
// Pure math, zero DOM: runs identically in the browser, Node, and vitest.

export type GlassSurface = 'convex-circle' | 'convex-squircle' | 'concave' | 'lip';

export type SurfaceFn = (s: number) => number;

// kube's four surface profiles over rim distance s ∈ [0, 1]
// (s = 0 at the border, 1 at the bezel's inner boundary; height rises 0 → 1).
export const SURFACES: Record<GlassSurface, SurfaceFn> = {
  'convex-circle': (s) => Math.sqrt(1 - (1 - s) ** 2),
  'convex-squircle': (s) => (1 - (1 - s) ** 4) ** (1 / 4),
  concave: (s) => 1 - Math.sqrt(1 - (1 - s) ** 2),
  lip: (s) => {
    const squircle = (1 - (1 - Math.min(1, s * 2)) ** 4) ** (1 / 4);
    const concave = 1 - Math.sqrt(1 - (1 - s) ** 2) + 0.1;
    const blend = 6 * s ** 5 - 15 * s ** 4 + 10 * s ** 3; // smoothstep
    return squircle * (1 - blend) + concave * blend;
  },
};

// kube's ray tracer: one column per sample across the bezel. The view ray
// refracts at the dome surface (Snell, η = 1/ior) and travels to the backdrop
// plane through `bezel + H(s)·thickness` of glass — the path-length term is
// what their look carries and thin-lens versions miss.
export function profile(
  bezel: number,
  thickness: number,
  fn: SurfaceFn,
  ior = 1.5,
  samples = 512,
): Float64Array {
  const eta = 1 / ior;
  const refract = (nx: number, ny: number): readonly [number, number] | null => {
    const cosI = ny; // incident direction is (0, 1); dot(I, N) = ny
    const root = 1 - eta * eta * (1 - cosI * cosI);
    if (root < 0) return null;
    const k = eta * cosI + Math.sqrt(root);
    return [-k * nx, eta - k * ny];
  };
  const out = new Float64Array(samples);
  for (let i = 0; i < samples; i++) {
    const s = i / samples;
    const h = fn(s);
    const eps = 1e-4; // s < 1 always here (i/samples), one-sided is enough
    const slope = (fn(s + eps) - h) / eps;
    const g = Math.sqrt(slope * slope + 1);
    const T = refract(-slope / g, -1 / g);
    out[i] = T ? (T[0] / T[1]) * (h * thickness + bezel) : 0;
  }
  return out;
}

// Rounded-rect signed distance: negative inside, |sd| = px distance to border.
function makeSd(hw: number, hh: number, r: number) {
  return (x: number, y: number): number => {
    const qx = Math.abs(x) - (hw - r);
    const qy = Math.abs(y) - (hh - r);
    return (
      Math.hypot(Math.max(qx, 0), Math.max(qy, 0)) + Math.min(Math.max(qx, qy), 0) - r
    );
  };
}

// Outward border normal: radial in the corner arcs, axis-aligned on straights —
// displacement rides its negation (inward), kube's "orthogonal to the border".
function outwardNormal(sd: (x: number, y: number) => number, x: number, y: number, eps = 0.75): [number, number] {
  const gx = (sd(x + eps, y) - sd(x - eps, y)) / (2 * eps);
  const gy = (sd(x, y + eps) - sd(x, y - eps)) / (2 * eps);
  const g = Math.hypot(gx, gy) || 1;
  return [gx / g, gy / g];
}

export interface FieldGeometry {
  /** element box width in px */
  width: number;
  /** element box height in px */
  height: number;
  /** corner radius in px, clamped into [0, min(w,h)/2] by the caller */
  radius: number;
  bezel: number;
  thickness: number;
  surface: GlassSurface;
  /** raster oversampling; defaults to 2 (kube's maps ship at 2×) */
  dpr?: number;
  /** raster area cap; the raster downsamples (field stays element-px) beyond it */
  maxArea?: number;
}

export interface RasterField {
  width: number;
  height: number;
  /** RGBA, raster pixels */
  data: Uint8ClampedArray;
}

function rasterScale(w: number, h: number, dpr: number, maxArea: number): number {
  if (w * h * dpr * dpr <= maxArea) return dpr;
  return Math.sqrt(maxArea / (w * h)); // no floor — the cap is a hard cap
}

/**
 * Displacement map: R/G encode the inward displacement vector, normalized by
 * the profile's maximumDisplacement (kube's normalization) so `scale` on
 * feDisplacementMap carries the absolute magnitude in element px.
 */
export function computeLensField(o: FieldGeometry): RasterField {
  const scale = rasterScale(o.width, o.height, o.dpr ?? 2, o.maxArea ?? 262144);
  // floor keeps the cap a hard cap (round can overshoot by a row × column)
  const mw = Math.max(2, Math.floor(o.width * scale));
  const mh = Math.max(2, Math.floor(o.height * scale));
  const sd = makeSd(o.width / 2, o.height / 2, o.radius);
  const prof = profile(o.bezel, o.thickness, SURFACES[o.surface]);
  let maxD = 0;
  for (let i = 0; i < prof.length; i++) maxD = Math.max(maxD, Math.abs(prof[i]));
  const norm = maxD > 0 ? 1 / maxD : 0;
  const data = new Uint8ClampedArray(mw * mh * 4);
  for (let py = 0; py < mh; py++) {
    for (let px = 0; px < mw; px++) {
      const x = (px + 0.5) / scale - o.width / 2;
      const y = (py + 0.5) / scale - o.height / 2;
      const dist = -sd(x, y); // px inside from the border
      const i = (py * mw + px) * 4;
      data[i] = 128;
      data[i + 1] = 128;
      data[i + 3] = 255;
      if (dist < 0 || dist >= o.bezel) continue; // outside / flat interior stay neutral
      const [ox, oy] = outwardNormal(sd, x, y);
      const d = (prof[Math.min(prof.length - 1, Math.floor((dist / o.bezel) * prof.length))] ?? 0) * norm;
      data[i] = 128 - ox * d * 127;
      data[i + 1] = 128 - oy * d * 127;
    }
  }
  return { width: mw, height: mh, data };
}

/**
 * Specular map: kube's thin border ring — gaussian across the border
 * (~1.5 display px), direction-biased brightness (their decoded maps peak
 * 220 on top/bottom borders, 128 on left/right).
 */
export function computeSpecularField(o: FieldGeometry): RasterField {
  const scale = rasterScale(o.width, o.height, o.dpr ?? 2, o.maxArea ?? 262144);
  const mw = Math.max(2, Math.floor(o.width * scale));
  const mh = Math.max(2, Math.floor(o.height * scale));
  const sd = makeSd(o.width / 2, o.height / 2, o.radius);
  const sigma = 1.5; // display px
  // ring center sits ~0.75px INSIDE the border — kube's decoded peak row is
  // 1 display px in, and 0.75 lands exactly on a 2× pixel center
  const center = 0.75;
  const data = new Uint8ClampedArray(mw * mh * 4);
  for (let py = 0; py < mh; py++) {
    for (let px = 0; px < mw; px++) {
      const x = (px + 0.5) / scale - o.width / 2;
      const y = (py + 0.5) / scale - o.height / 2;
      const dist = -sd(x, y);
      const off = dist - center;
      if (off < -sigma * 3 || off > sigma * 3) continue;
      const g = Math.exp(-((off / sigma) ** 2));
      if (g <= 0.01) continue;
      const [, oy] = outwardNormal(sd, x, y);
      const vaxis = Math.abs(oy);
      const peak = 128 + (220 - 128) * vaxis;
      const i = (py * mw + px) * 4;
      data[i] = peak * g;
      data[i + 1] = peak * g;
      data[i + 2] = peak * g;
      // directional alpha — kube's decoded rings: 191 on vertical-facing
      // borders, 64 on horizontal ones (255·(0.25 + 0.5·|n̂y|) fits both)
      data[i + 3] = 255 * g * (0.25 + 0.5 * vaxis);
    }
  }
  return { width: mw, height: mh, data };
}
