/**
 * Modul: Hintergrund einer eigenen modalen Ebene inert schalten
 * Zweck: Fuer Ebenen, die `aria-modal="true"` tragen, aber kein natives
 *        `<dialog>` mit `showModal()` sind - das Mehr-Blatt, die Suche, der
 *        Rundgang und die Picker, die IN einem offenen Dialog aufgehen
 *        (Dokument, Buchung, Logo, Symbol, Name, DMS-Vorschau).
 * Abhaengigkeiten: keine
 *
 * WARUM. `aria-modal` ist nur eine Bitte an den Screenreader, und nicht jeder
 * haelt sich daran: mit dem virtuellen Cursor lief man aus der Ebene in die
 * Seite dahinter, und ein Klick oder Tab konnte dort landen, waehrend die
 * Ebene noch offen war (Modern-Web-Guidance-Audit, Befund 10). `inert` nimmt
 * den Hintergrund aus Fokus, Klick und Barrierebaum - das, was `showModal()`
 * fuer das geteilte Modal ohnehin tut.
 *
 * WAS INERT WIRD: im naechsten offenen `<dialog>` um die Ebene herum, sonst
 * in `document.body`, jeder Zweig, der weder die Ebene noch den Toast-Stapel
 * enthaelt. Zweige, in denen einer von beiden steckt, werden nicht selbst
 * inert (das erbte sich nach unten und liesse sich nicht zuruecknehmen),
 * sondern durchlaufen - ihre uebrigen Kinder werden es.
 *
 * DER TOAST-STAPEL BLEIBT BEDIENBAR, wie beim geteilten Modal
 * (components/modal.js, TOP_LAYER_GUESTS): ein "Rueckgaengig" hinter einer
 * Ebene waere sonst nur noch ein Bild.
 *
 * DIE FREIGABE nimmt nur zurueck, was dieser Aufruf gesetzt hat, und zaehlt:
 * zwei Ebenen, die denselben Zweig sperren, geben ihn erst gemeinsam frei. Ein
 * Zweig, der schon vorher inert war (ein geparkter Dialog), bleibt es.
 */

const KEEP_ALWAYS = '.shell-bottom-stack';
const SKIP_TAGS = new Set(['SCRIPT', 'STYLE', 'TEMPLATE', 'LINK', 'META']);

/** Wie oft dieser Helfer einen Zweig gerade sperrt. */
const holds = new Map();

/**
 * @param {Element} layer die modale Ebene (oder ihr Overlay)
 * @param {{ scope?: Element, keep?: Element[] }} [options]
 *   scope: Bereich, sonst der Dialog um die Ebene oder body;
 *   keep: was ausserdem bedienbar bleibt (die Abdunklung, deren Klick schliesst)
 * @returns {() => void} gibt den Hintergrund frei; ein zweiter Aufruf tut nichts
 */
export function inertOutside(layer, { scope, keep: alsoKeep = [] } = {}) {
  const root = scope ?? layer?.closest?.('dialog[open]') ?? globalThis.document?.body;
  if (!layer || !root || !root.contains?.(layer)) return () => {};
  const keep = [layer, ...alsoKeep.filter(Boolean), ...(root.querySelectorAll?.(KEEP_ALWAYS) ?? [])];
  const holdsAKeeper = (el) => keep.some((k) => el === k || el.contains(k));
  const insideAKeeper = (el) => keep.some((k) => k.contains(el));

  const taken = [];
  const visit = (node) => {
    for (const child of [...node.children]) {
      if (SKIP_TAGS.has(child.tagName)) continue;
      if (insideAKeeper(child)) continue;
      if (holdsAKeeper(child)) { visit(child); continue; }
      const count = holds.get(child) ?? 0;
      if (count === 0 && child.inert) continue; // schon vorher inert - nicht unseres
      holds.set(child, count + 1);
      child.inert = true;
      taken.push(child);
    }
  };
  visit(root);

  let released = false;
  return () => {
    if (released) return;
    released = true;
    for (const el of taken) {
      const count = (holds.get(el) ?? 1) - 1;
      if (count > 0) { holds.set(el, count); continue; }
      holds.delete(el);
      el.inert = false;
    }
  };
}
