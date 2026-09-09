// scroll-run — the ONE scrollable-region contract (Owner 2026-09-04,
// the unification): the stamp machine + RTL engine + nudge + effect
// builders (scroll-run.svelte.ts), the law sheet (scroll-run.css) and
// the overlay half (scroll-chrome.svelte). Pure barrel: no logic here.
export {
  createScrollStamp,
  detectRtlScrollModel,
  isRtlDirection,
  isRtlElement,
  nudgeRun,
  progressBlur,
  ramp,
  rtlScrollFromCanonical,
  rtlScrollToCanonical,
  shadow,
  type ProgressBlurEffect,
  type ProgressBlurOptions,
  type RampEffect,
  type RampOptions,
  type RtlScrollModel,
  type ScrollEffect,
  type ScrollStamp,
  type ScrollStampOptions,
  type ShadowEffect,
  type ShadowOptions,
} from './scroll-run.svelte';
export { default as ScrollChrome } from './scroll-chrome.svelte';
