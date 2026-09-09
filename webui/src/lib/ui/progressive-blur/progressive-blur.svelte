<!--
  jixoai progressive blur (registry/files/ui/progressive-blur/progressive-blur.svelte).
  The scroll-edge blur atom: content scrolling under its OWN container's
  edge diffuses progressively instead of slicing. Magic UI port
  (2026-08-25) with two deliberate upgrades, both probed on Chromium:

    THE PIN — the overlay root is sticky h-0, never abspos-in-scroller
    (abspos children of a scroll container scroll away with content;
    the sticky zero-height root stays pinned to the scrollport edge at
    zero layout cost). The band (height prop) hangs INTO the viewport
    from that edge; its layers carry the effect.

    THE GRID DIALECT (Owner, 2026-09-01) — pin='grid' swaps the sticky
    pin for position-free tech: the band is a grid item of the
    consumer's ONE-CELL host (grid-area 1/1 + justify-self per edge),
    the ladder layers stack as grid items of the band, and a no-op
    translateZ(0) buys each band compositor isolation — without it a
    band at the scroll-origin edge samples a dead backdrop (the
    left-veil-is-invisible bug, measured 2026-09-01).

    THE HOLD (2026-09-01, grid dialect) — hold (0–100, clamped to it)
    parks the ladder's peak across the outer share of the band and
    compresses the ramp into the inboard (100-hold)%: strips whose
    readable content parks inboard of the clip edge (the tabs'
    chevron lane) would see a pure edge-peaked ramp blanch over blank.

    THE LADDER — one gradient formula for every layer (Magic UI's
    first/last special cases are the clamped edges of the same form):
    step = 100/levels; layer i masks transparent→opaque→opaque→
    transparent at i·step…(i+3)·step while blurring levels[i]px. Each
    backdrop-filter layer blurs everything beneath it INCLUDING earlier
    layers, so the stack ramps from ~clear at the inner edge to the
    full blur at the scrollport edge. position='both' renders two
    pinned roots — Magic UI's single full-height element degenerates
    into uniform blur; the twin roots keep both edges progressive.

    THE REVEAL (jixoai extension) — reveal='scroll' fades the ladder in
    with the scroller (nothing blurs at rest; see progressive-blur.css
    for the opacity-on-layers law and the @supports scroll() gate).
    Zero JS in every mode: the component ships no script at all.

  Height takes a definite CSS length (default 6rem). Percentages are
  NOT supported — the band resolves % against the 0-height sticky root
  (documented deviation from Magic UI's '30%' default).
-->
<script lang="ts">
  import { cn } from '$lib/utils';
  import './progressive-blur.css';

  /** band law shared by both dialects — size, ladder and reveal are
   *  dialect-free */
  interface ProgressiveBlurBandProps {
    /** band size along its hang axis — any definite CSS length
        (px/rem); % unsupported */
    height?: string;
    /** per-layer blur px, inner-edge first; ≥2 levels */
    blurLevels?: number[];
    /** static = always painted (Magic UI parity); scroll = fades in
        with the nearest scroller (CSS scroll timeline, @supports-gated
        — block-axis edges only; the scroll() timeline has no inline
        aim, so inline edges keep the always-painted static law and are
        never hidden — B-5, 2026-09-02) */
    reveal?: 'static' | 'scroll';
    class?: string;
  }

  /** the sticky dialect: the zero-layout sticky root INSIDE a scroller
   *  (the original atom) — every edge vocabulary is placeable */
  interface ProgressiveBlurStickyProps extends ProgressiveBlurBandProps {
    pin?: 'sticky';
    /** which scrollport edge(s) the band hangs from */
    position?: 'top' | 'bottom' | 'both' | 'start' | 'end' | 'inline';
    /** hold is GRID-only: `undefined` here closes the destructuring
     *  hole the union would otherwise open (a sticky hold is a
     *  compile error, not a silently-ignored number) */
    hold?: undefined;
  }

  /** the grid dialect (Owner, 2026-09-01 — grid provides positioning,
   *  z-index the layering): the band is a sibling item in the
   *  consumer's grid host, and the ladder layers stack as grid items
   *  of the band itself — no position tech anywhere. INLINE edges aim
   *  by justify-self in the ONE-CELL host; BLOCK edges (2026-09-05,
   *  the dsn rail overlay) hang from the host's block extent —
   *  grid-row 1/-1 + align-self per edge, the size on HEIGHT — the
   *  vocabulary for the pinned-overlay architecture where the
   *  scroller is a SIBLING (the band pins by never entering the
   *  scroll flow). A PAIR position still has no single placement law
   *  in this dialect and stays sticky-dialect-only (Codex P2,
   *  2026-09-02) */
  interface ProgressiveBlurGridProps extends ProgressiveBlurBandProps {
    pin: 'grid';
    position: 'start' | 'end' | 'top' | 'bottom';
    /** the outer share of the band (0–100, clamped to it, %) that
     *  HOLDS the ladder's peak instead of ramping — for strips whose
     *  readable content parks inboard of the clip edge (a control
     *  lane: the tabs' chevron lane + snap padding park the first
     *  label ~1.5 lanes in, so a pure edge-peaked ramp blanches over
     *  blank — the measured left-veil-is-invisible bug, 2026-09-01).
     *  The ramp compresses into the inboard (100-hold)% and the top
     *  layers hold full strength through the lane to the edge */
    hold?: number;
  }

  export type ProgressiveBlurProps = ProgressiveBlurStickyProps | ProgressiveBlurGridProps;

  let {
    position = 'bottom',
    height = '6rem',
    blurLevels = [0.5, 1, 2, 4, 8, 16, 32, 64],
    reveal = 'static',
    pin = 'sticky',
    hold = 0,
    class: className = '',
  }: ProgressiveBlurProps = $props();

  /** which edges render: 'both' = the block pair, 'inline' = the
   *  inline pair (start+end) — the horizontal-overflow strip shape.
   *  The runtime twin of the discriminated union (Codex P2,
   *  2026-09-02): JS callers bypass the types, so a grid band outside
   *  its single-edge vocabulary (the PAIRS — every single edge has a
   *  placement law since the 2026-09-05 block-edge upgrade)
   *  normalizes to 'start' (documented fallback) instead of rendering
   *  broken geometry */
  const edges = $derived.by(() => {
    if (
      pin === 'grid' &&
      position !== 'start' &&
      position !== 'end' &&
      position !== 'top' &&
      position !== 'bottom'
    ) {
      return ['start'] as const;
    }
    return (
      position === 'both'
        ? (['top', 'bottom'] as const)
        : position === 'inline'
          ? (['start', 'end'] as const)
          : ([position] as const)
    ) as readonly ('top' | 'bottom' | 'start' | 'end')[];
  });

  // ladder normalization: fewer than 2 levels cannot express a ramp
  // (step = 100/0, or one full-band rung) — fall back to the default
  // ladder rather than render a degenerate band
  const levels = $derived(blurLevels.length >= 2 ? blurLevels : [0.5, 1, 2, 4, 8, 16, 32, 64]);

  // hold clamps to [0,100] (B-11, 2026-09-02): a runaway hold drives
  // the ramp (100-hold) negative — gradient stops below 0% silently
  // kill the mask. At the clamp the ramp collapses onto a full-strength
  // band; below 0 the plain ladder stands
  const holdPct = $derived(Math.min(100, Math.max(0, hold)));

  /** layer i's paint: the backdrop blur (per-layer data) plus the
   *  ladder's STOP DATA as custom properties (--jx-pblur-s0..s3, tail
   *  alpha). The gradient DIRECTION is css-owned — progressive-blur.css
   *  composes the masks keyed on data-position, with :dir(rtl) flipping
   *  the inline pair's physical aim (CR-1 P2-1, 2026-09-02: gradients
   *  have no logical 'to start', so the aim cannot live in this
   *  direction-blind string). With hold > 0 (grid dialect) the ramp
   *  compresses into the inboard (100-hold)% and every layer whose
   *  rung reaches the ramp's end stays OPAQUE through the outer lane
   *  to 100% (tail alpha 1) */
  const layerStyle = (edge: 'top' | 'bottom' | 'start' | 'end', i: number): string => {
    void edge;
    const pct = (v: number) => `${Math.round(v * 100) / 100}%`;
    let s0: number, s1: number, s2: number, s3: number, tailA: 0 | 1;
    if (holdPct > 0 && pin === 'grid') {
      const ramp = 100 - holdPct;
      const step = ramp / levels.length;
      const holdsPeak = (i + 3) * step >= ramp - 0.01;
      s0 = i * step;
      s1 = (i + 1) * step;
      if (holdsPeak) {
        s2 = 100;
        s3 = 100;
        tailA = 1;
      } else {
        s2 = (i + 2) * step;
        s3 = Math.min(100, (i + 3) * step);
        tailA = 0;
      }
    } else {
      const step = 100 / levels.length;
      s0 = i * step;
      s1 = (i + 1) * step;
      s2 = (i + 2) * step;
      s3 = Math.min(100, (i + 3) * step);
      tailA = 0;
    }
    const blur = `blur(${levels[i]}px)`;
    return [
      `-webkit-backdrop-filter: ${blur}`,
      `backdrop-filter: ${blur}`,
      `--jx-pblur-s0: ${pct(s0)}`,
      `--jx-pblur-s1: ${pct(s1)}`,
      `--jx-pblur-s2: ${pct(s2)}`,
      `--jx-pblur-s3: ${pct(s3)}`,
      `--jx-pblur-tail-a: ${tailA}`,
    ].join('; ');
  };
</script>

{#each edges as edge (edge)}
  {#if pin === 'grid'}
    <!-- the grid dialect (Owner, 2026-09-01): positioning by GRID and
         layering by z-index — the band is a grid item of the consumer's
         host and the ladder layers are grid items of the band — no
         position tech anywhere. INLINE edges ride [grid-area:1/1] +
         justify-self in the ONE-CELL host; BLOCK edges (2026-09-05)
         span the host's whole block extent ([grid-row:1/-1] +
         [grid-column:1/-1], the scaffold's line-placement law) hanging
         from the chosen edge by align-self — the size rides HEIGHT.
         PAINT LAW (empirical, Chromium 152): the band must paint AFTER
         the scrolled content and carry a no-op translateZ(0) —
         compositor isolation, never positioning — which gives EACH band
         its own layer; without it a band at the scroll-origin edge
         samples a dead backdrop and only the first band after the
         scroller paints (the left-veil-is-invisible bug, measured
         2026-09-01; with translateZ the grid-item layers paint
         full-strength — verified pixel-equal) -->
    <div
      class={cn(
        'jx-pblur pointer-events-none grid [transform:translateZ(0)]',
        edge === 'start' && '[grid-area:1/1] justify-self-start self-stretch',
        edge === 'end' && '[grid-area:1/1] justify-self-end self-stretch',
        edge === 'top' && 'self-start [grid-row:1/-1] [grid-column:1/-1]',
        edge === 'bottom' && 'self-end [grid-row:1/-1] [grid-column:1/-1]',
        className,
      )}
      style="{edge === 'top' || edge === 'bottom' ? 'height' : 'width'}: {height}"
      data-jx-pblur=""
      data-position={edge}
      data-variant={reveal}
      aria-hidden="true"
    >
      {#each levels as _, i (i)}
        <div class="jx-pblur-layer [grid-area:1/1]" style={layerStyle(edge, i)}></div>
      {/each}
    </div>
  {:else}
    <!-- scenery: the band is decoration over the scroller's content. The
         sticky offset (top-0/bottom-0/start-0/end-0) is LOAD-BEARING:
         position:sticky without an offset is inert. data-VARIANT (not
         data-reveal): the docs site's entrance system owns the bare
         [data-reveal] selector — the collision pinned the band ~10px off
         the edge through a view()-timeline transform (vision r2 finding) -->
    <div
      class={cn(
        'jx-pblur pointer-events-none sticky z-10',
        edge === 'top' || edge === 'bottom' ? 'h-0' : 'w-0',
        edge === 'top' && 'top-0',
        edge === 'bottom' && 'bottom-0',
        edge === 'start' && 'start-0',
        edge === 'end' && 'end-0',
        className,
      )}
      data-jx-pblur=""
      data-position={edge}
      data-variant={reveal}
      aria-hidden="true"
    >
      {#if edge === 'top' || edge === 'bottom'}
        <div class="absolute inset-x-0 {edge === 'top' ? 'top-0' : 'bottom-0'}" style="height: {height}">
          {#each levels as _, i (i)}
            <div class="jx-pblur-layer absolute inset-0" style={layerStyle(edge, i)}></div>
          {/each}
        </div>
      {:else}
        <div class="absolute inset-y-0 {edge === 'start' ? 'start-0' : 'end-0'}" style="width: {height}">
          {#each levels as _, i (i)}
            <div class="jx-pblur-layer absolute inset-0" style={layerStyle(edge, i)}></div>
          {/each}
        </div>
      {/if}
    </div>
  {/if}
{/each}
