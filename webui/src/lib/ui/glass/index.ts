// glass — the ONE glass-effect item (Owner 2026-09-08; r10 2026-09-09 the
// kube.io source-level lock): the typed builders + stamp helpers (glass.ts),
// the pure field core (glass-map.ts), the mount runtime + Svelte action
// (liquid-glass.svelte.ts) and the law sheet (glass.css). Pure barrel: no
// logic here, no default export (law items have none).
export { SURFACES, profile, computeLensField, computeSpecularField } from './glass-map';
export type { GlassSurface, SurfaceFn, FieldGeometry, RasterField } from './glass-map';
export { blur, liquid, glassAttrs, glassVars } from './glass';
export type {
  BlurOptions,
  BlurEffect,
  LiquidGlassOptions,
  LiquidGlassEffect,
  AppleLiquidOptions,
  GlassEffect,
  LiquidFactory,
} from './glass';
export { liquidGlass, attachLiquidGlass, buildFilter } from './liquid-glass.svelte';
export type { LiquidGlassHandle } from './liquid-glass.svelte';
