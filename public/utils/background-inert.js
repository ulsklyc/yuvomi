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
 * DIE TOASTS BLEIBEN BEDIENBAR, wie beim geteilten Modal (components/modal.js,
 * TOP_LAYER_GUESTS): ein "Rueckgaengig" hinter einer Ebene waere sonst nur noch
 * ein Bild. Nur die Toast-Container, nicht ihr ganzer Stapel: die
 * Sammelaktions-Pille darin aendert Daten und gehoert zum Hintergrund
 * (Codex-Review zu #2058).
 *
 * DIE FREIGABE nimmt nur zurueck, was dieser Aufruf gesetzt hat, und zaehlt:
 * zwei Ebenen, die denselben Zweig sperren, geben ihn erst gemeinsam frei. Ein
 * Zweig, der schon vorher inert war (ein geparkter Dialog), bleibt es.
 */

const KEEP_ALWAYS = '.toast-container';
const SKIP_TAGS = new Set(['SCRIPT', 'STYLE', 'TEMPLATE', 'LINK', 'META']);

/**
 * Wie oft dieser Helfer einen Zweig gerade sperrt. Schwach gehalten: schliesst
 * ein Dialog samt offenem Picker hart (closeModal force), laeuft dessen
 * Freigabe nie - die gesperrten Knoten gehen mit dem Dialog, und die Tabelle
 * haelt sie nicht fest (Codex-Review zu #2058).
 */
const holds = new WeakMap();

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
  const take = (child) => {
    if (SKIP_TAGS.has(child.tagName) || insideAKeeper(child)) return false;
    if (holdsAKeeper(child)) return true; // durchlaufen statt sperren
    const count = holds.get(child) ?? 0;
    if (count === 0 && child.inert) return false; // schon vorher inert - nicht unseres
    holds.set(child, count + 1);
    child.inert = true;
    taken.push(child);
    return false;
  };
  const passed = [];
  const visit = (node) => {
    passed.push(node);
    for (const child of [...node.children]) if (take(child)) visit(child);
  };
  visit(root);

  // SPAETER EINGEFUEGTES GEHOERT AUCH ZUM HINTERGRUND (Codex-Review zu #2058):
  // ein Zweig, der durchlaufen statt gesperrt wurde, kann neue Kinder bekommen
  // - die Navigation baut ihre Tabs neben dem Mehr-Knopf neu auf, waehrend das
  // Blatt offen ist. Wer in einen durchlaufenen Zweig kommt, wird mitgesperrt.
  const Observer = globalThis.MutationObserver;
  const observer = Observer ? new Observer((records) => {
    for (const record of records) {
      for (const node of record.addedNodes) if (node.nodeType === 1 && take(node)) visit(node);
    }
  }) : null;
  for (const node of passed) observer?.observe(node, { childList: true });

  let released = false;
  return () => {
    if (released) return;
    released = true;
    observer?.disconnect();
    for (const el of taken) {
      const count = (holds.get(el) ?? 1) - 1;
      if (count > 0) { holds.set(el, count); continue; }
      holds.delete(el);
      el.inert = false;
    }
  };
}
