<!--
  jixoai dialog (registry/files/ui/dialog/dialog.svelte).

  NativeHTML base (2026-08-20): the native <dialog> element driven by
  showModal()/close(). The platform supplies the focus trap, the Escape
  key (cancel event), an inert page behind, top-layer rendering, and
  closed-by-default (no-JS page loads never paint dialog contents inline).
  The component adds exactly two things: bindable open state, and the
  shared WAAPI surface timeline (460ms, --jx-p — skipped under
  prefers-reduced-motion) whose layer choreography (surface sinks, shadow
  presses back, scrim rides the same progress) lives in the jx-surface law.

  Floating-surface law (2026-08-22): the panel carries jx-surface — the
  hard offset shadow is a REAL ::after layer, entry runs the
  @starting-style pull-apart, and variant='solid' | 'acrylic' | 'auto'
  picks the paint (auto: acrylic unless the environment asks for reduced
  transparency). The ::backdrop scrim is --scrim: semi-transparent black
  in light mode, white in dark mode — never a brand tint.

  tw4 (2026-08-24): utility-authored — the platform element keeps its
  geometry-only utilities (it still paints NOTHING; fill + border +
  blur stay the theme's jx-surface-body, the shadow the shadow layer),
  and the head/body/foot paint lives in the markup. ONLY the scrim
  pseudo and the x-glyph descendant scale stay in dialog.css
  (D1-exempt residue). The old reduced-motion block died with its
  targets: the WAAPI kernel owns the ::backdrop timeline now (the
  theme's kernel reduced-motion block kills it), and the x button's
  transition chain is the press law's own (jixoai.css).

  ROW RULER (r13 + the r14 tuning): the scroll ring (head/body/foot's
  common parent) is a single-column grid whose NAMED ROWS carry the
  dividing lines — Separator components sit in EXPLICIT 1px row tracks
  ([head] [sep-head] [body] [sep-foot] [foot]), edge-to-edge exactly
  where the retired borders sat. Zone presence is resolved here and
  STAMPED (data-sep-head / data-sep-foot on the host — the
  stamped-attribute painting law). THE r14 TUNING (Owner): the
  --jx-dialog-inset token and the [inset 1fr inset] column ruler
  RETIRED — the real content owns its geometry. The head zone is FLUSH
  by default — consumer head snippets span edge-to-edge.

  ZONES vs CONTENT (r14-9, Owner correction): the footer's slot
  architecture belongs to the footer REGION — carried by components,
  not by sibling snippets on Dialog. Dialog keeps the zones, the
  snippet transports, the ghost variant scopes (Context, written over
  head and foot), and the × close contract; the CONTENT faces are
  composition: <DialogHeader> (the title row / a custom flush head —
  rendered internally for the untitled default) and <DialogFooter> (the
  auto button-group at inline-end, the raw end slot). The footer
  snippet is the RAW full override of the foot zone — the actions/end
  sibling snippets are retired. No-subgrid environments fall back to
  the padding geometry (dialog.css, the law's mandatory fallback).
-->
<script lang="ts">
  import { onDestroy, untrack } from 'svelte';
  import type { Snippet } from 'svelte';
  import Icon from '$lib/ui/icon';
  import { createSurfaceMotion } from '$lib/surface-motion';
  import { provideEntity } from '$lib/entity.svelte';
  import Separator from '$lib/ui/separator/separator.svelte';
  import ButtonVariantScope from '$lib/ui/button-group/button-variant-scope.svelte';
  import IconButton from '$lib/ui/icon-button/icon-button.svelte';
  import DialogHeader from './dialog-header.svelte';
  import { DialogDefaults, type DialogSurfaceVariant } from './dialog-defaults.svelte';
  import './dialog.css';

  interface Props {
    /** Heading shown in the header bar; omit for a chrome-less body. */
    title?: string;
    /** Bindable open state: true -> showModal(), false -> animated close. */
    open?: boolean;
    /** floating-surface variant: solid | acrylic | auto (acrylic unless
        the environment asks for reduced transparency) */
    variant?: DialogSurfaceVariant;
    /**
     * Platform-element utilities appended AFTER the law's own — for
     * GEOMETRY overrides only (a consumer's anchor/width, e.g. the
     * search palette's 14vh top anchor). The platform still paints
     * nothing; anything visual belongs to a variant or the body.
     */
    class?: string;
    /**
     * Replaces the visible title row, flush edge-to-edge — the snippet
     * owns the row's geometry (typically a <DialogHeader> wrapping the
     * custom content). The × close still rides the head grid's end
     * slot, and title keeps naming the dialog (aria-label) with its
     * visual row gone.
     */
    head?: Snippet;
    /**
     * The RAW full override of the foot zone (r14-9, Owner): using it
     * means owning everything the foot shows. The standard face is
     * <DialogFooter> — its buttons auto-join one end-packed
     * ButtonGroup (ghost via this zone's scope); its end slot replaces
     * the grouped arrangement.
     */
    footer?: Snippet;
    /**
     * The body zone's scroll authority (the panel itself never scrolls
     * — r14-3). DEFAULT on: the zone is the scroll ring with a stable
     * BOTH-EDGES gutter reservation. Declare false to assert the body
     * fits: the scroll authority and the gutter reservation retire
     * together (the gutter exists only FOR the scrollbar — a declared
     * non-scroller keeps the full content width).
     */
    scroll?: boolean;
    /**
     * Predicate consulted on the native cancel request (Escape):
     * returning TRUE blocks the close (the palette holds the dialog
     * open through an IME composition). The default path is the
     * animated shutdown.
     */
    cancelGuard?: () => boolean;
    /** Dialog body. */
    children: Snippet;
  }

  let {
    title,
    open = $bindable(false),
    variant,
    class: platformClass = '',
    head,
    footer,
    scroll = true,
    cancelGuard,
    children,
  }: Props = $props();

  // THE DEFAULTS READ POINT (context-defaults-economy 2.2): one line —
  // the family contract resolves the panel's style props (variant's
  // own 'auto' lives in DialogDefaults, auditable in one place;
  // density is the no-opinion axis slot — nothing stamps, the ambient
  // css scope channel keeps flowing)
  const d = $derived(DialogDefaults.resolve({ variant }));

  // THE ENTITY LAW (2026-09-01): the dialog panel IS the solid object —
  // form shells inside dissolve (border + ground transparent; the well
  // inset carries the affordance). provideEntity() accumulates depth,
  // so a dialog nested in a dialog auto-reasserts hairlines at depth 2.
  const entityDepth = provideEntity();

  // Presence resolution (the stamped-attribute painting law): the
  // component resolves which zones exist and stamps; css paints stamps
  // only, never infers from descendant context. The head zone is
  // UNCONDITIONAL (the x-button contract keeps a close affordance on
  // every dialog), so its separator is structural — stamped anyway so
  // the css stays independent of that invariant and the chrome reads
  // off the DOM. The foot zone exists iff the footer snippet is passed
  // (the r14-9 correction: one transport, the raw override); absent
  // it, the zone AND its separator row simply never render.
  const hasFoot = $derived(footer !== undefined);

  let dialog = $state<HTMLDialogElement | null>(null);

  // the shared declarative motion kernel (r29): the dialog rides the
  // SAME timeline law as the popover — --jx-p drives every formula in
  // jixoai.css (blurIn/slide/materials/shadow + the ::backdrop scrim's
  // opacity). No anchor: a centered dialog's axis IS the project
  // default (bottom-right). dialog.close() fires IMMEDIATELY on the
  // falling edge — the allow-discrete display window holds the panel
  // rendered through the whole exit, exactly like hidePopover
  const motion = createSurfaceMotion(() => dialog);

  // state -> element. Rising edge opens; falling edge tears down
  // through the same animated path as the x button and Escape.
  $effect(() => {
    if (open) {
      if (dialog && !dialog.open) dialog.showModal();
      motion.play(1);
      motion.startTracking();
    } else {
      untrack(() => shut());
    }
  });

  onDestroy(() => motion.destroy());

  // Native close paths we did not initiate (form method="dialog", an
  // external .close()) land here — adopt the state so bind:open stays
  // truthful.
  const handleClose = (): void => {
    open = false;
  };

  const handleCancel = (event: Event): void => {
    event.preventDefault();
    if (cancelGuard?.() === true) return; // held open (e.g. IME flight)
    shut();
  };

  const shut = (): void => {
    if (!dialog || !dialog.open) return;
    motion.stopTracking();
    dialog.classList.remove('jx-rest');
    motion.play(0);
    dialog.close(); // the discrete window carries the exit
  };
</script>

{#snippet xGlyph()}
  <!-- glyph through the Icon component; dialog.css owns its 14px
       descendant scale, the strokier × rides the strokeWidth prop -->
  <Icon name="x" strokeWidth={2.5} />
{/snippet}

<dialog
  bind:this={dialog}
  class="jx-dialog jx-surface m-auto p-0 w-[min(92vw,26rem)] max-w-full text-popover-foreground @container/jx-dialog {motion.supported ? 'jx-waapi' : ''} {platformClass}"
  data-variant={d.variant}
  data-jx-entity={entityDepth}
  aria-label={title}
  onclose={handleClose}
  oncancel={handleCancel}
>
  <!-- the REAL shadow layer (a DOM child because pseudo-elements are
       unreachable from the motion timeline) -->
  <div data-jx-dialog-shadow="" class="jx-surface-shadow" aria-hidden="true"></div>
  <!-- the surface body (fill + acrylic blur) wraps the scroll ring; the
       <dialog> itself paints nothing (floating-surface law arch r3) -->
  <div data-jx-dialog-surface="" class="jx-surface-body">
  <!-- THE RULER HOST (r13): named separator rows; the stamps carry the
       resolved zone presence -->
  <div
    data-jx-dialog-scroll=""
    data-sep-head=""
    data-sep-foot={hasFoot ? '' : undefined}
    class="max-h-[calc(100dvh-2rem)]"
  >
    <!-- the head zone is FLUSH (the r14 tuning): a consumer head
         snippet (the palette's Input) spans edge-to-edge and owns its
         own geometry; the default title row pads itself -->
    <div data-jx-dialog-head="">
      <!-- THE HEAD GRID (r14 tuning 2, Owner): NO zone padding — the
           grid controls dimensions. [content] rides minmax(0,1fr) and
           pads ITSELF; [inline-end-action-slot] is a content-sized end
           track hugging the top-right corner (no reserved space — the
           button stretches the slot open). The ghost scope gives every
           button in the header the zone's default variant (Context,
           the inherit-then-provide chain) -->
      <ButtonVariantScope variant="ghost">
        <div class="jx-dialog-head-grid">
          <!-- the content column: a custom head snippet, else the
               DEFAULT FACE is the DialogHeader component itself (one
               source for the title row) -->
          {#if head}
            {@render head()}
          {:else}
            <DialogHeader {title} />
          {/if}
          <div class="jx-dialog-end-action-slot">
            <!-- the close is a CONTEXT consumer (r14-4, Owner): an
                 IconButton with NO variant — the default path inherits
                 the Dialog's ghost scope; nothing hand-painted -->
            <IconButton
              icon={xGlyph}
              text="Close"
              iconOnly
              tip={false}
              type="button"
              onclick={shut}
              class="jx-dialog-x"
            />
          </div>
        </div>
      </ButtonVariantScope>
    </div>
    <!-- the dividing lines are Separator INSTANCES in their own 1px
         tracks, spanning edge-to-edge (the retired border's extent);
         decorative chrome, hidden from AT -->
    <Separator data-jx-dialog-sep="head" aria-hidden="true" />
    <div data-jx-dialog-body="" data-jx-scroll={scroll ? undefined : 'off'}>
      <!-- the content cell's inline padding COMPENSATES the both-edges
           gutter (the scrollbar law, jixoai.css): the gutter reserves
           space between the zone's inner border edge and the cell's
           padding edge, so subtracting the probed thin width keeps the
           visual inset at the authored 0.875rem — overlay-scrollbar
           systems probe 0px and keep it whole -->
      <div
        class="min-w-0 py-3.5 px-[max(0.875rem-var(--jx-scrollbar-thin,0px),0px)] text-[13px] leading-[1.6] text-[color-mix(in_oklab,var(--popover-foreground)_80%,transparent)]"
      >
        {@render children()}
      </div>
    </div>
    {#if hasFoot}
      <Separator data-jx-dialog-sep="foot" aria-hidden="true" />
      <div data-jx-dialog-foot="">
        <!-- THE RAW FOOT ZONE (r14-9, Owner correction): the footer
             snippet overrides everything the foot shows — no grid, no
             grouping, no dividers from Dialog. The standard face is
             <DialogFooter> (auto button-group at inline-end, the raw
             end slot); the ghost scope stays the zone's default for
             every button (Context, written by Dialog), and the foot
             rides the FLAT texture (Owner 2026-09-04): raised=false
             scopes the physics default — foot buttons press as
             engrave-tier insets, an explicit raised still wins -->
        <ButtonVariantScope variant="ghost" raised={false}>
          {@render footer()}
        </ButtonVariantScope>
      </div>
    {/if}
  </div>
  </div>
</dialog>
