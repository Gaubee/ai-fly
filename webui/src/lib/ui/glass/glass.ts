// The glass effect builders — blur() + liquid()/liquid.apple() on the
// press-button effect convention. Plain TS, zero runes, zero DOM access,
// SSR-safe.
//
// TWO API LAYERS (the Owner's 2026-09-09 ruling):
//   liquid({...})        the PHYSICAL layer — kube.io's objective facts
//                         (surface/bezel/thickness/scale/...), fully tunable
//   liquid.apple({...})  the SEMANTIC layer — SwiftUI glassEffect's standard
//                         (variant/tint/interactive/shape/isEnabled), compiled
//                         DOWN into the physical layer; no physics exposed
import type { GlassSurface } from './glass-map';

export interface BlurOptions {
  /** frost blur; default '14px' (the retired .jx-glass value) */
  radius?: string;
  /** default 1.35 */
  saturate?: number;
  /** default 'color-mix(in oklab, var(--background, Canvas) 68%, transparent)' */
  fill?: string;
  /** default 1 */
  brightness?: number;
}

export interface BlurEffect {
  readonly type: 'blur';
  radius: string;
  saturate: number;
  fill: string;
  brightness: number;
}

export interface LiquidGlassOptions {
  /** dome cross-section; default 'convex-squircle' (Apple's preferred profile) */
  surface?: GlassSurface;
  /** refraction band width in element px (border → inward); default 22 */
  bezel?: number;
  /** glass-slab thickness in the ray-traced profile; default 30 */
  thickness?: number;
  /** feDisplacementMap scale in element px — the displacement magnitude.
   *  kube's components pin it per element (56px searchbox → 55, 92px thumb → 22,
   *  150px circle → 134); there is no universal fraction, tune per surface. */
  scale?: number;
  /** in-chain frost (feGaussianBlur before displacement); default 0.2 */
  blur?: number;
  /** faded-ring opacity (feFuncA slope); default 0.2 */
  specular?: number;
  /** rim saturation boost (feColorMatrix saturate on the ring-clipped copy); default 4 */
  rimSaturate?: number;
  // — frost fallback + tuning (no-JS / engines without backdrop-filter: url()) —
  /** frost blur; default '2px' (tabs liquid today) */
  radius?: string;
  /** frost saturate; default 1.6 (tabs liquid today) */
  saturate?: number;
  fill?: string;
  brightness?: number;
}

export interface LiquidGlassEffect {
  readonly type: 'liquid-glass';
  surface: GlassSurface;
  bezel: number;
  thickness: number;
  scale: number;
  blur: number;
  specular: number;
  rimSaturate: number;
  radius: string;
  saturate: number;
  fill: string;
  brightness: number;
  /** semantic leftovers carried for the mount: 'capsule' | corner-radius px
   *  override, or null = read the element's border-radius */
  shape: 'capsule' | number | null;
  /** Apple .interactive() — press feedback flag (the law's motion css consumes it) */
  interactive: boolean;
}

/**
 * The SEMANTIC layer — SwiftUI glassEffect's parameter standard. Everything
 * compiles into the physical layer; no physics is exposed. Returns the frost
 * member (blur) for identity/!isEnabled — Apple's no-op maps to the law's own
 * degradation, zero lens cost.
 */
export interface AppleLiquidOptions {
  /** Glass.regular | .clear | .identity; default 'regular' */
  variant?: 'regular' | 'clear' | 'identity';
  /** Glass.tint(_:) — a color; compiles to a translucent glass fill */
  tint?: string;
  /** Glass.interactive() — press feedback (Apple's is iOS-only; ours rides the law's motion css) */
  interactive?: boolean;
  /** shape override: 'capsule' (full pill) | corner radius in px; default = the element's border-radius */
  shape?: 'capsule' | number;
  /** isEnabled: false → identity behavior */
  isEnabled?: boolean;
}

export type GlassEffect = BlurEffect | LiquidGlassEffect;

const DEFAULT_FILL = 'color-mix(in oklab, var(--background, Canvas) 68%, transparent)';

function clamp(key: string, v: number | undefined, dflt: number, lo: number, hi: number): number {
  if (v === undefined) return dflt;
  if (typeof v !== 'number' || !Number.isFinite(v)) {
    throw new TypeError(`glass: ${key} must be a finite number (got ${String(v)})`);
  }
  return Math.min(hi, Math.max(lo, v));
}

function str(key: string, v: string | undefined, dflt: string): string {
  if (v === undefined) return dflt;
  if (typeof v !== 'string' || v.length === 0) {
    throw new TypeError(`glass: ${key} must be a non-empty string`);
  }
  return v;
}

const SURFACES: readonly GlassSurface[] = ['convex-circle', 'convex-squircle', 'concave', 'lip'];

export function blur(o: BlurOptions = {}): BlurEffect {
  return {
    type: 'blur',
    radius: str('radius', o.radius, '14px'),
    saturate: clamp('saturate', o.saturate, 1.35, 0, 3),
    fill: str('fill', o.fill, DEFAULT_FILL),
    brightness: clamp('brightness', o.brightness, 1, 0, 3),
  };
}

// — the physical layer —

function buildLiquid(o: LiquidGlassOptions): LiquidGlassEffect {
  if (o.surface !== undefined && !SURFACES.includes(o.surface)) {
    throw new TypeError(`glass: surface must be one of ${SURFACES.join(' | ')}`);
  }
  return {
    type: 'liquid-glass',
    surface: o.surface ?? 'convex-squircle',
    bezel: clamp('bezel', o.bezel, 22, 4, 80),
    thickness: clamp('thickness', o.thickness, 30, 2, 160),
    scale: clamp('scale', o.scale, 55, 0, 160),
    blur: clamp('blur', o.blur, 0.2, 0, 4),
    specular: clamp('specular', o.specular, 0.2, 0, 1),
    rimSaturate: clamp('rimSaturate', o.rimSaturate, 4, 1, 12),
    radius: str('radius', o.radius, '2px'),
    saturate: clamp('saturate', o.saturate, 1.6, 0, 3),
    fill: str('fill', o.fill, DEFAULT_FILL),
    brightness: clamp('brightness', o.brightness, 1, 0, 3),
    shape: null,
    interactive: false,
  };
}

export interface LiquidFactory {
  /** the PHYSICAL layer — the objective facts, every knob exposed */
  (o?: LiquidGlassOptions): LiquidGlassEffect;
  /** the SEMANTIC layer — SwiftUI's glassEffect standard, compiled down */
  apple(o?: AppleLiquidOptions): GlassEffect;
}

/** The clear variant: less frosting, more transparency, quieter rim — our
 *  standard mapping of Glass.clear onto the physical layer. */
const CLEAR_DELTAS = { blur: 0, fill: 'color-mix(in oklab, var(--background, Canvas) 22%, transparent)', rimSaturate: 2.5, specular: 0.12 };
/** Glass.tint(_:) compiles to a translucent tinted fill at our standard mix. */
const TINT_MIX = 30;

export const liquid: LiquidFactory = Object.assign(
  (o: LiquidGlassOptions = {}) => buildLiquid(o),
  {
    apple(o: AppleLiquidOptions = {}): GlassEffect {
      if (o.isEnabled === false) o = { ...o, variant: 'identity' };
      const variant = o.variant ?? 'regular';
      if (variant === 'identity') {
        // Apple's no-op → the law's own frost degradation (zero lens cost)
        return blur({ radius: '2px', saturate: 1.6, fill: o.tint ? `color-mix(in oklab, ${o.tint} ${TINT_MIX}%, transparent)` : undefined });
      }
      const base: LiquidGlassOptions = variant === 'clear'
        ? { ...CLEAR_DELTAS }
        : {};
      if (o.tint !== undefined) base.fill = `color-mix(in oklab, ${str('tint', o.tint, '')} ${TINT_MIX}%, transparent)`;
      const fx = buildLiquid(base);
      fx.shape = o.shape ?? null;
      fx.interactive = o.interactive ?? false;
      return fx;
    },
  },
);

export function glassVars(fx: GlassEffect): string {
  const base = [
    `--jx-glass-radius:${fx.radius}`,
    `--jx-glass-saturate:${fx.saturate}`,
    `--jx-glass-fill:${fx.fill}`,
    `--jx-glass-brightness:${fx.brightness}`,
  ];
  if (fx.type === 'liquid-glass' && fx.interactive) base.push('--jx-glass-interactive:1');
  return base.join(';');
}

/**
 * Spread helper: stamps data-jx-effect + the vars style. For liquid it stamps
 * the channel + tuning vars ONLY — the --jx-glass-filter pointer belongs to
 * the mount action exclusively (attachLiquidGlass), never to markup.
 */
export function glassAttrs(fx: GlassEffect): Record<string, string> {
  return {
    'data-jx-effect': fx.type,
    style: glassVars(fx),
  };
}
