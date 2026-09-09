/**
 * jixoai ambient-locale reactor (registry/files/lib/locale.svelte.ts,
 * Owner request 2026-08-30: “将 lang 属性去掉，还是英文——你这个是实时的
 * 还是一次性获取就不再更新?”).
 *
 * The LIVE channel of the picker vocabulary's locale resolution: a
 * module-level $state mirroring <html lang>, kept current by ONE
 * MutationObserver (attributeFilter 'lang') so every mounted panel
 * re-renders the moment a page retargets its language — no remount,
 * no prop plumbing. ambientLocale() reads the state (subscribing
 * Svelte consumers to the observer's writes) AND the DOM fresh, so
 * same-tick edits settle before the observer's async callback; with
 * no declared lang the chain falls to navigator.language, then 'en'
 * (SSR-safe: no document, no observer, no crash).
 *
 * Resolution order is the HTML-correct one — the PAGE's declared
 * language outranks the browser preference (an English page with
 * Chinese panels is wrong); an explicit `locale` prop on a component
 * outranks everything.
 */

let pageLang = $state<string>('');

if (typeof document !== 'undefined') {
  pageLang = document.documentElement.lang;
  new MutationObserver(() => {
    pageLang = document.documentElement.lang;
  }).observe(document.documentElement, {
    attributes: true,
    attributeFilter: ['lang'],
  });
}

/** the ambient locale: <html lang> → navigator.language → 'en'. LIVE —
    a lang retarget re-renders every mounted consumer */
export function ambientLocale(): string {
  // reading pageLang subscribes $derived consumers to the observer;
  // the fresh DOM read settles same-tick writes first
  void pageLang;
  if (typeof document !== 'undefined' && document.documentElement.lang) {
    return document.documentElement.lang;
  }
  if (typeof navigator !== 'undefined' && navigator.language) {
    return navigator.language;
  }
  return 'en';
}
