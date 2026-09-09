/**
 * jixoai form-field bridge (registry/files/lib/form-field.ts).
 *
 * 2026-08-20 · Form wave 3 (Codex architecture review pick): the faceless
 * form-associated custom element that restores FormData submission to the
 * family's custom-painted controls (select, combobox, range, tags-input —
 * the ones with no native name/value leg of their own).
 *
 * Law of the seam — STYLE STAYS IN THE COMPONENT:
 *  - the element renders NO box (display: contents), NO content, NO aria
 *    surface (aria-hidden); the Svelte component keeps every style,
 *    structure and ARIA decision exactly where it was.
 *  - the component feeds it three attributes only: name, value, disabled.
 *    Any change re-syncs setFormValue(); a missing name, an empty value
 *    or a disabled field contributes NOTHING (native control semantics).
 *  - MULTIVALUE seam (2026-08-30, expand-form-family design.md): a
 *    `values: string[]` property — equivalently `setValues(values)` —
 *    hands the element an ordered array that bypasses the string `value`
 *    attribute entirely and commits as `internals.setFormValue(FormData)`
 *    with REPEATED same-name entries, so `formData.getAll(name)` returns
 *    the values IN ORDER, each byte-for-byte the committed string
 *    (newline/quote/Unicode values survive losslessly — no joined-string
 *    channel exists). While armed, the `value` attribute is never read
 *    for submission; `setValues(null)` disarms back to the attribute.
 *    The initial array is captured on first handoff: form.reset()
 *    restores it (and jx-reset tells the component). No coercion: a
 *    non-string entry is a programmer error and throws.
 *  - form lifecycle flows back as two bubbling CustomEvents the component
 *    may listen to on the element itself: jx-reset (restore the mount
 *    value) and jx-disabled (detail: boolean — form/fieldset disable).
 *  - registration is lazy and client-only: the guard keeps module
 *    evaluation safe under SSR/prerender (no window, no customElements).
 *
 * Usage in a Svelte component:
 *
 *   <jx-form-field
 *     aria-hidden="true"
 *     {name}
 *     value={value ?? ''}
 *     disabled={isDisabled}
 *     onjx-reset={() => (value = initialValue)}
 *     onjx-disabled={(event: CustomEvent<boolean>) => (formDisabled = event.detail)}
 *   ></jx-form-field>
 */
/**
 * ... (docs unchanged)
 */
// SSR-safe base: the class declaration itself evaluates `extends
// HTMLElement` at module scope — under prerender (Node) there is no such
// global, so the base resolves to a placeholder that is never used
// (nothing is ever instantiated past the registration guard below).
const BaseElement: typeof HTMLElement =
  typeof HTMLElement === 'undefined'
    ? (class {} as unknown as typeof HTMLElement)
    : HTMLElement;

export class FormField extends BaseElement {
  static formAssociated = true;
  static observedAttributes = ['name', 'value', 'disabled', 'multivalue'];

  readonly #internals = this.attachInternals();

  /** the MULTIVALUE handoff — null = the seam is disarmed (attribute mode) */
  #values: string[] | null = null;
  /** the first array ever handed in; form.reset() restores it */
  #initialValues: string[] | null = null;

  connectedCallback(): void {
    this.style.display = 'contents';
    this.#sync();
  }

  attributeChangedCallback(_name: string, _old: string | null, _new: string | null): void {
    this.#sync();
  }

  /** MULTIVALUE read: the live array while the seam is armed, else null */
  get values(): string[] | null {
    return this.#values;
  }
  set values(values: string[] | null | undefined) {
    this.setValues(values);
  }

  /** MULTIVALUE handoff (property form — the array never crosses element
      boundaries as a string): arm with a string[] (copied), disarm with
      null. Entries are stored in ORDER; submission preserves it. */
  setValues(values: string[] | null | undefined): void {
    if (values == null) {
      this.#values = null;
    } else {
      const list: string[] = [];
      for (const entry of values) {
        if (typeof entry !== 'string') {
          // no coercion — a foreign value is a programmer error (design.md)
          throw new TypeError(
            `jx-form-field: setValues expects string[], got ${typeof entry} entry`,
          );
        }
        list.push(entry);
      }
      this.#values = list;
      // lifecycle stays native: the first handoff is the reset target
      if (this.#initialValues === null) this.#initialValues = [...list];
    }
    this.#sync();
  }

  formResetCallback(): void {
    if (this.#values !== null || this.#initialValues !== null) {
      // MULTIVALUE: restore the initial array (an empty one contributes
      // nothing — the honest empty), then let the component follow
      this.#values = this.#initialValues ? [...this.#initialValues] : [];
    } else {
      this.setAttribute('value', '');
    }
    this.dispatchEvent(new CustomEvent('jx-reset', { bubbles: true }));
  }

  formDisabledCallback(disabled: boolean): void {
    this.dispatchEvent(new CustomEvent('jx-disabled', { detail: disabled, bubbles: true }));
  }

  #sync(): void {
    const name = this.getAttribute('name');
    const disabled = this.hasAttribute('disabled');
    if (!name || disabled) {
      this.#internals.setFormValue(null);
      return;
    }
    // MULTIVALUE seam (2026-08-30, expand-form-family design.md): the
    // FormData PAYLOAD form of setFormValue — the union member the DOM
    // typings accept — carries the ordered array as REPEATED same-name
    // entries. Each entry submits byte-for-byte the committed string
    // (newline/quote/Unicode safe); an empty array contributes nothing.
    // The legacy newline-split `multivalue` attribute keeps serving the
    // transfer component below this seam.
    if (this.#values !== null) {
      const data = new FormData();
      for (const entry of this.#values) data.append(name, entry);
      this.#internals.setFormValue(data);
      return;
    }
    const value = this.getAttribute('value') ?? '';
    if (value === '') {
      this.#internals.setFormValue(null);
      return;
    }
    // legacy multivalue: checkbox-set semantics — newline-separated
    // entries submit as SEPARATE FormData entries under the same name.
    // ElementInternals.setFormValue is NOT variadic; the multi-entry
    // contract is expressed by handing it a FormData (the only way the
    // platform accepts multiple values for one control)
    if (this.hasAttribute('multivalue')) {
      const data = new FormData();
      for (const part of value.split('\n')) {
        if (part !== '') data.append(name, part);
      }
      this.#internals.setFormValue(data);
    } else {
      this.#internals.setFormValue(value);
    }
  }
}

// Lazy registration: safe for SSR (no window/document during prerender) and
// idempotent across multiple component imports of the same app.
if (typeof window !== 'undefined' && 'attachInternals' in HTMLElement.prototype) {
  if (!customElements.get('jx-form-field')) {
    customElements.define('jx-form-field', FormField);
  }
}
