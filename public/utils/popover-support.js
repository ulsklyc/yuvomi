/**
 * Modul: Die Popover-API dort, wo der Browser sie nicht hat (Phase 1a E)
 * Zweck: Die Popover-API (`popover`, `showPopover()`, `popovertarget`) kam mit
 *        Chrome 114, Firefox 125 und Safari 17 - ueber der Untergrenze der App
 *        (Chrome 105 / Firefox 115 / Safari 15.4). Ohne sie waren jedes
 *        "Mehr"-Menue, das Kontomenue, die Filter und das Kalenderblatt des
 *        Datumsfelds unerreichbar: reset.css hielt sie nur geschlossen (#2107).
 *        Jetzt laedt der Router vor dem ersten Seitenaufbau
 *        `@oddbird/popover-polyfill` (Entscheidung Ulas, 09.11.2026) - NUR wo
 *        die API fehlt und per dynamischem Import: Vite schneidet daraus einen
 *        eigenen Chunk, und ein Browser mit der API laedt kein Byte davon.
 *
 * WAS DER POLYFILL NICHT KANN (seine README, "Caveats"):
 *   - `:popover-open` in CSS: er setzt stattdessen die Klasse `.\:popover-open`.
 *     Jede Regel der App, die ein offenes Popover erst sichtbar macht, hat
 *     deshalb einen Zwilling in reset.css (`@supports not
 *     selector(:popover-open)`); test:old-browser-fallbacks haelt die Liste
 *     vollstaendig. In JS sind `matches()`, `closest()` und `querySelector()`
 *     mit `:popover-open` gepatcht.
 *   - Top-Layer: er setzt nur einen hohen z-index (reset.css zieht ihn ueber
 *     den der Menues). Ein Popover in einem Vorfahren mit eigenem
 *     Stapelkontext oder `overflow` kann darin haengen bleiben.
 *   - `::backdrop` gibt es nicht.
 *
 * Abhaengigkeiten: @oddbird/popover-polyfill (npm, exakt gepinnt, eigener Chunk)
 */

/**
 * Fehlt dem Browser die Popover-API? Dieselbe Probe wie `isSupported()` des
 * Polyfills, ohne ihn dafuer zu laden.
 * @param {object | null | undefined} [proto] HTMLElement.prototype; Tests reichen ein eigenes
 * @returns {boolean}
 */
export function needsPopoverPolyfill(proto = globalThis.HTMLElement?.prototype) {
  if (!proto) return false;
  return !('popover' in proto && 'showPopover' in proto);
}

/**
 * Setzt den Polyfill, wenn die API fehlt; sonst geschieht nichts. Scheitert
 * das Laden, bleiben die Menues zu wie vorher (reset.css) - die App startet.
 * @param {() => Promise<{ apply: () => void }>} [load] nur fuer Tests
 * @returns {Promise<boolean>} ob der Polyfill jetzt gilt
 */
export async function ensurePopoverApi(load) {
  if (!needsPopoverPolyfill()) return false;
  try {
    const { apply } = await (load ? load() : import('@oddbird/popover-polyfill/fn'));
    apply();
    return true;
  } catch (err) {
    console.warn('[popover] Polyfill nicht geladen, die Menues bleiben zu:', err);
    return false;
  }
}
