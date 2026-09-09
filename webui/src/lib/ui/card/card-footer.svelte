<!--
  jixoai card-footer (registry/files/ui/card/card-footer.svelte).

  The foot zone's content face (the dialog-footer r14-9 economy,
  WIDENED per Owner 2026-09-03: the foot is not end-only — the
  inline-start side is a first-class seat):

    start     the RAW inline-start TEXT seat — meta text, a status
              line, anything that hangs the row's leading edge at
              the CONTENT AXIS (the ruler's inset track paints its
              14px by law). The seat paints NOTHING block-wise:
              text RIDES the band vertically centered, never SIZES
              it — the cluster owns the band's height (dialog's
              footer law: the group IS the band).
    children  the action buttons — auto-joined ONE ButtonGroup in
              the CLUSTER seat, edge-riding flush at the inline end
              (leadingSeam brackets the cluster — the seam is the
              group's to draw, never a sibling Separator). THE
              CARVED-CELL LAW (Owner r4): the cluster is a carved
              REGION, not a floating widget — it FILLS the band
              vertically (separator = its top rim, seam = its left
              edge, block height = the band, whatever sizes the
              band). The buttons' min-h-[--jx-hit] economy is a
              FLOOR, never a cap: when a sibling grows the band the
              buttons grow with it — a floating 40px button in a
              taller band reads as a hole dug OUT, not a cell cut
              OUT (the 44px lesson).
    end       the RAW inline-end TEXT seat: present ⇒ it REPLACES
              the grouped arrangement — the opt-out for non-button
              content. It enters at the content axis like `start`;
              a fully custom edge-riding cluster spans the inset
              track itself.
    label     the ButtonGroup's accessible name.

  THE INLINE RULER (Owner, 2026-09-03 r2: "jx-card-foot-start 这里
  如果要放文字，是要有 padding 的。jx-card-foot-end 其实也要，但
  之所以 buttons 不用 padding，是因为它们在内部使用了 padding"):
  inside a Card foot zone this wrapper DISSOLVES (display: contents,
  card-footer.css) and the seats place directly against the ROOT's
  rented ruler — text seats ENTER at the content lines (structural
  14px inset), the cluster SPANS the end inset to ride the card edge
  flush. THE BAND LAWS (Owner r3 + r4): text carries NO
  padding-block — it centers against whatever sizes the row and
  never sizes it itself; the cluster FILLS the band (the carved
  cell — a taller sibling grows the buttons with the band, never
  floats them with whitespace). The head's action slot is a CORNER,
  not a slab — it keeps align-self: start (dialog's × verbatim).

  Standalone (outside a Card foot zone) the wrapper renders its OWN
  face of the same ruler — the mandatory fallback, like dialog's
  no-subgrid geometry. The narrow-screen reversal (cluster to the
  top row, full-bleed; text seats below at the content axis) lives
  in card-footer.css as a native @container query against the ROOT
  container (card.css) — Tailwind display utilities would replace
  the rented grid, so they retired.
-->
<script lang="ts">
  import type { Snippet } from 'svelte';
  import ButtonGroup from '$lib/ui/button-group/button-group.svelte';
  import './card-footer.css';

  interface Props {
    /** Raw inline-start text — the leading-edge content-axis seat. */
    start?: Snippet;
    /** Raw inline-end text — replaces the grouped arrangement. */
    end?: Snippet;
    /** The ButtonGroup's accessible name. */
    label?: string;
    /** The action buttons — auto-joined in one edge-riding group. */
    children?: Snippet;
  }

  let { start, end, label = 'Card footer', children }: Props = $props();
</script>

<div class="jx-card-foot-grid">
  {#if start}
    <div class="jx-card-foot-start">
      {@render start()}
    </div>
  {/if}
  {#if end}
    <div class="jx-card-foot-end">
      {@render end()}
    </div>
  {:else if children}
    <div class="jx-card-foot-cluster">
      <ButtonGroup {label} leadingSeam>
        {@render children()}
      </ButtonGroup>
    </div>
  {/if}
</div>
