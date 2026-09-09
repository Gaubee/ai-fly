<!--
  jixoai native-select (registry/files/ui/native-select/native-select.svelte).
  The SIMPLE-SCENARIO recommendation of the form family: form submission
  (a real name/value pair rides into FormData) and mobile (the platform's
  overlay picker beats any custom panel on touch). The native <select>
  stays fully native — the popup list, keyboard navigation, and type-ahead
  belong to the platform. The only paint is on the closed control:
  appearance-none strips the UA chrome and an absolutely-positioned inline
  SVG chevron (the same chevron path as language-switcher) stands in; the
  option popup keeps its native rendering (color-scheme follows the site
  theme). For a description-rich, fully styled listbox see select.svelte
  (the Popover-based sibling); reach for that one only when the native
  popup can't say what you need.

  Same semantics law as input.svelte: label[for] block (auto id via
  $props.id()), error string → aria-invalid + aria-describedby +
  "! message" line + dashed border, inset 1px focus-visible outline on
  the ring token, hover lifts one pixel. `value` is $bindable (bound ⇒
  controlled two-way, absent ⇒ uncontrolled native select). Options
  arrive as the children snippet (<option>/<optgroup>); everything
  else (name, disabled, required, multiple…) flows through restProps.

  multiple: a native multiple select is a LIST BOX, not a button — the
  chevron and its right gutter disappear (:has(select[multiple])) and the
  control takes listbox geometry: taller default (about three visible
  rows — the rows attribute still sizes it through restProps), tighter
  block padding around the option stack, and a default cursor. Set
  <NativeSelect multiple size={n}> to control exactly how many rows the
  platform shows.

  tw4 (2026-08-24; mirror law 2026-08-27): static paint (closed-control
  shell, chevron) mirrors jx-pure.css Part B B4's select law from
  native-select.css (@layer components :where() mirror rules); the
  .jx-field/.jx-label/.jx-error scaffolding is CONSUMED from the
  jx-pure sheet's Part A. The state machine (hover lift, focus ring,
  disabled, invalid dash, the :has(select[multiple]) listbox posture,
  reduced-motion kill) stays unlayered :where() bare CSS. Markup keeps
  only the css hooks, the dark-strategy-dependent color-scheme pair
  (scheme-light dark:scheme-dark — a variant-bearing paint whose dark
  discriminator belongs to the consumer's context, not this sheet) and
  the consumer class merge point.
-->
<script lang="ts">
  import type { HTMLSelectAttributes } from 'svelte/elements';
  import { cn } from '$lib/utils';
  import { getContext } from 'svelte';
  import { CONTROL_CHROME_KEY, type ControlChrome } from '$lib/control-chrome.svelte';
  import type { Snippet } from 'svelte';
  import type { Density } from '$lib/density.svelte';
  import { NativeSelectDefaults } from './native-select-defaults.svelte';

  interface Props extends HTMLSelectAttributes {
    /** field label; renders label[for] above the control */
    label?: string;
    /** density policy: explicit, inherited, then default */
    density?: Density;
    /** wired into label[for] / error[id]; auto-generated when omitted */
    id?: string;
    /** error text → aria-invalid + aria-describedby + dashed border */
    error?: string;
    /** $bindable; bound ⇒ controlled two-way, absent ⇒ uncontrolled */
    value?: HTMLSelectAttributes['value'];
    /** the <option> / <optgroup> list, authored by the caller */
    children: Snippet;
  }

  // $props.id() must live in its own top-level initializer (compiler law)
  const autoId = $props.id();

  let {
    label,
    density,
    'data-density': _callerDensity,
    id = autoId,
    error,
    value = $bindable(),
    children,
    class: className = '',
    chrome: chromeProp = undefined,
    ...rest
  }: Props = $props();

  // the chrome axis ambient (inline read — see lib/control-chrome.svelte.ts)
  const ambientChrome = getContext<{ chrome?: ControlChrome }>(CONTROL_CHROME_KEY)?.chrome;

  const errorId = $derived(`${id}-error`);
  // the family Defaults is the single read point (context-defaults-
  // economy 3.1): explicit ?? ambient scope per slot, one line, no
  // legacy helper channels
  const d = $derived(NativeSelectDefaults.resolve({ density }));
  const invalid = $derived(error != null && error !== '');
  const describedBy = $derived(invalid ? errorId : undefined);
  const invalidAttr = $derived(invalid ? 'true' : undefined);
</script>

<div class="jx-field" data-density={d.density} data-self-inset="">
  {#if label}<label class="jx-label" for={id}>{label}</label>{/if}
  <span class="jx-select-wrap relative block w-full max-w-full">
    <select
      {id}
      bind:value
      class={cn(
        'jx-html-select scheme-light dark:scheme-dark',
        className,
      )}
      aria-invalid={invalidAttr}
      aria-describedby={describedBy}
      data-chrome={chromeProp ?? ambientChrome ?? 'frame'}
      {...rest}
    >
      {@render children()}
    </select>
    
  </span>
  {#if invalid}<p id={errorId} class="jx-error"><span class="jx-error-mark" aria-hidden="true">!</span>{error}</p>{/if}
</div>
