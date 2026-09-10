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

  THE PURE MECHANISM + THE CARD DIALECT (card-surface-kernel,
  2026-09-09): a floating surface grows NO structural flesh — the
  interior (the head/body/foot bands, the separators, the inline
  ruler, the 15rem reversal) is the CARD STRUCTURAL KERNEL's, carried
  by the STICKER: the interior host stamps `data-jx-card` and
  card.css's whole rule set applies server-side (five named columns,
  three integer rows with the body row as sole absorber, the
  jx-card container — the footer's narrow reversal arrives with it).
  The content faces are the Card family parts: <CardHeader> (the
  default title row, or a custom flush head via its children) and
  <CardBody> (the scroll cell — ONE gutter-compensation formula,
  single-sourced in card-body.svelte); the footer snippet composes
  <CardFooter> (the foot band's standard face). DialogHeader and
  DialogFooter — the kernel's former clones — are RETIRED with this
  change; the × close rides .jx-card-end-action-slot, the seat the
  card sources reserved for it since 2026-09-03 ("the seat Dialog's ×
  is designed to occupy when Dialog is refactored onto Card" —
  card.css, the wish now kept).

  What dialog.css still owns (the mechanism's residue ONLY): the
  ::backdrop scrim, the × glyph's descendant scale, and the height
  continuity chain (the platform ceiling conducted through the flex
  layers to the grid host — see dialog.css).

  ZONES vs CONTENT (r14-9, Owner correction): Dialog keeps the
  snippet transports, the ghost variant scopes (Context, written over
  head and foot — the action-band zone law: head ghost, foot
  ghost+flat), and the × close contract; the interior faces are
  composition. The head band is UNCONDITIONAL (the × contract keeps a
  close affordance on every dialog); the foot band exists iff the
  footer snippet is passed (the r14-9 single-transport law: using it
  means owning everything the foot shows — the standard face is
  <CardFooter>).
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
  import CardBody from '$lib/ui/card/card-body.svelte';
  import CardHeader from '$lib/ui/card/card-header.svelte';
  // THE STICKER'S RULE SET (the load-bearing import, the review catch:
  // stamping data-jx-card without this sheet loads NOTHING — jsdom
  // can't see it, a real browser renders the fallback geometry)
  import '$lib/ui/card/card.css';
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
     * owns the row's geometry (typically a <CardHeader> wrapping the
     * custom content, its class="col-start-1" the flush escape). The
     * × close still rides the head band's end seat, and title keeps
     * naming the dialog (aria-label) with its visual row gone.
     */
    head?: Snippet;
    /**
     * The RAW full override of the foot band (r14-9, Owner): using it
     * means owning everything the foot shows. The standard face is
     * <CardFooter> — its buttons auto-join one edge-riding ButtonGroup
     * (ghost via this band's scope); its end slot replaces the grouped
     * arrangement.
     */
    footer?: Snippet;
    /**
     * The body band's scroll authority (the panel itself never scrolls
        — r14-3). DEFAULT on: the cell is the scroll ring with a stable
        BOTH-EDGES gutter reservation. Declare false to assert the body
        fits: the scroll authority and the gutter reservation retire
        together (the gutter exists only FOR the scrollbar — a declared
        non-scroller keeps the full content width).
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
  // component resolves which bands exist and stamps; css paints stamps
  // only, never infers from descendant context. The head band is
  // UNCONDITIONAL (the x-button contract keeps a close affordance on
  // every dialog), so its separator is structural — stamped anyway so
  // the css stays independent of that invariant and the chrome reads
  // off the DOM. The foot band exists iff the footer snippet is passed
  // (the r14-9 correction: one transport, the raw override); absent
  // it, the band AND its separator edge simply never render.
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
  class="jx-dialog jx-surface m-auto p-0 w-[min(92vw,26rem)] max-w-full text-popover-foreground {motion.supported ? 'jx-waapi' : ''} {platformClass}"
  data-variant={d.variant}
  data-jx-entity={entityDepth}
  aria-label={title}
  onclose={handleClose}
  oncancel={handleCancel}
>
  <!-- the REAL shadow layer (a DOM child because pseudo-elements are
       unreachable from the motion timeline) -->
  <div data-jx-dialog-shadow="" class="jx-surface-shadow" aria-hidden="true"></div>
  <!-- the surface body (fill + acrylic blur) wraps the interior; the
       <dialog> itself paints nothing (floating-surface law arch r3) -->
  <div data-jx-dialog-surface="" class="jx-surface-body">
  <!-- THE STRUCTURAL STICKER (card-surface-kernel): the interior host
       carries data-jx-card — card.css's whole rule set applies (the
       five-column inline ruler, the three integer bands, the jx-card
       container with the 15rem reversal). The stamps carry the
       resolved band presence; the max-h cap is the panel's own
       geometry (the platform ceiling the flex chain conducts) -->
  <div
    data-jx-card=""
    data-sep-head=""
    data-sep-foot={hasFoot ? '' : undefined}
    class="max-h-[calc(100dvh-2rem)]"
  >
    <!-- the head band is FLUSH (the r14 tuning): a consumer head
         snippet (the palette's search Input in a col-start-1
         CardHeader) rides flush and owns its own geometry; the
         default title row enters at the content lines by track -->
    <div data-jx-card-head="">
      <!-- THE ACTION-BAND ZONE (head: ghost): every button in the band
           inherits the scope's default variant (Context, the
           inherit-then-provide chain); the face and the × seat place
           against the rented ruler lines -->
      <ButtonVariantScope variant="ghost">
        <!-- the content seat: a custom head snippet, else the DEFAULT
             FACE is the Card family's own CardHeader (one source for
             the title row, shared with the planar Card) -->
        {#if head}
          {@render head()}
        {:else}
          <CardHeader {title} />
        {/if}
        <!-- the × seat — the corner the card sources reserved for it
             (card.css .jx-card-end-action-slot): spans the end inset,
             hugs the top-right flush. The close is a CONTEXT consumer
             (r14-4, Owner): an IconButton with NO variant — the
             default path inherits the band's ghost scope; nothing
             hand-painted -->
        <div class="jx-card-end-action-slot">
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
      </ButtonVariantScope>
    </div>
    <!-- the dividing lines are Separator INSTANCES edge-riding their
         band rows (card.css), spanning edge-to-edge (the retired
         border's extent); decorative chrome, hidden from AT -->
    <Separator data-jx-card-sep="head" aria-hidden="true" />
    <!-- the body band is the Card family part: one scroll law, one
         gutter-compensation cell (card-body.svelte) -->
    <CardBody {scroll}>
      {@render children()}
    </CardBody>
    {#if hasFoot}
      <Separator data-jx-card-sep="foot" aria-hidden="true" />
      <div data-jx-card-foot="">
        <!-- THE RAW FOOT BAND (r14-9, Owner correction): the footer
             snippet overrides everything the foot shows — no grouping
             from Dialog. The standard face is <CardFooter> (auto
             button-group edge-riding, the raw end slot); the ghost
             scope stays the band's default for every button (Context,
             written by Dialog), and the foot rides the FLAT texture
             (Owner 2026-09-04): raised=false scopes the physics
             default — foot buttons press as engrave-tier insets, an
             explicit raised still wins -->
        <ButtonVariantScope variant="ghost" raised={false}>
          {@render footer()}
        </ButtonVariantScope>
      </div>
    {/if}
  </div>
  </div>
</dialog>
