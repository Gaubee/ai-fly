<!--
  jixoai toggle (registry/files/ui/toggle/toggle.svelte).

  V2 DOM ISOMORPHISM (native-contract-fusion, 2026-08-27): the switch
  is ONE input[role=switch] on BOTH sides — the jx-pure face paints
  the bare element with the jx-html-switch utility (::before knob,
  transform travel, inset ring); the registry component applies the
  SAME utility class. No label wrapper, no track/knob spans. The
  visible label (when requested) renders OUTSIDE the input as a
  sibling <label for>.

  checked is $bindable; everything else flows through restProps onto
  the native input — a named toggle participates in FormData like any
  checkbox. The sr-hidden driver is gone: the input IS the control,
  visually painted by the standard layer.
-->
<script lang="ts">
  import type { HTMLInputAttributes } from 'svelte/elements';
  import type { Density } from '$lib/density.svelte';
  import { ToggleDefaults } from './toggle-defaults.svelte';
  import { cn } from '$lib/utils';

  interface Props extends HTMLInputAttributes {
    /** toggle state; bindable (bind:checked) for controlled use */
    checked?: boolean;
    /** reads INLINE-START of the control (external label[for]) */
    label?: string;
    /** lands on the input; auto-generated when omitted */
    id?: string;
    disabled?: boolean;
    /** density policy: explicit override, then inherited provider */
    density?: Density;
    'data-density'?: string;
    class?: string;
  }

  // $props.id() must live in its own top-level initializer (compiler law)
  const autoId = $props.id();

  let {
    checked = $bindable(false),
    label,
    id = autoId,
    disabled = false,
    density,
    'data-density': _callerDensity,
    class: className = '',
    ...rest
  }: Props = $props();

  // the family Defaults is the single read point (context-defaults-
  // economy 3.1): explicit ?? ambient scope per slot, one line, no
  // legacy helper channels
  const d = $derived(ToggleDefaults.resolve({ density }));
</script>

{#if label}
  <label for={id} data-jx-toggle-label class="jx-label" data-density={d.density}>
    {label}
  </label>
{/if}
<input
  {id}
  type="checkbox"
  role="switch"
  data-density={d.density}
  class={cn('jx-html-switch', disabled && 'opacity-50 cursor-not-allowed', className)}
  bind:checked
  {disabled}
  {...rest}
/>
