/**
 * Modul: Test-Infrastruktur - der EINE Regelscanner fuer Stylesheets.
 * Zweck: `eachRule()` an genau einer Stelle halten. Er stand bis 2026-08-08 in
 *        test-frontend-audit.js und war damit fuer jede zweite Guard-Suite
 *        unerreichbar - die naechste Kopie waere die fuenfte gewesen.
 * Ausfuehren: keine eigene Suite - Helfer, importiert von test-frontend-audit.js
 *        und test-typography.js.
 *
 * Liefert `{ selector, body, at }` fuer jede Regel einer Stylesheet-Quelle -
 * Kommentare gestrippt, At-Bloecke aufgeloest, und `at` traegt die Kette der
 * At-Praeambeln, in denen die Regel steht (leer auf der Basisebene).
 *
 * DREI FALLEN STECKEN IN SEINER GESCHICHTE, alle drei in Runde 6 bezahlt, und
 * alle drei mit einem gruenen Guard darueber:
 *
 * 1. (Phase 0) `(?:^|[}])\s*([^{}]*)\{([^}]*)\}` verschluckt die ERSTE Regel
 *    jedes At-Blocks - `[^}]*` im Rumpf erlaubt `{`, also frisst der Match der
 *    `@media`-Praeambel die Regel dahinter mit. Jeder Guard auf diesem Muster
 *    war in Media-Queries blind, also genau dort, wo responsive Verstoesse
 *    leben.
 * 2. (Phase 3a) `(?:^|[}])` KONSUMIERT sein Trennzeichen: nach einem Treffer
 *    steht `lastIndex` hinter dem `}` der gefundenen Regel, und die naechste
 *    findet keines mehr vor sich - **jede zweite Regel blieb ungesehen**.
 *    Gegenprobe: `.a{} .b{} .c{} .d{}` liefert mit dem alten Muster `.a, .c`.
 * 3. (Phase 3b) Das Muster kannte den KONTEXT einer Regel nicht. Das Flachmachen
 *    der At-Bloecke war der Preis fuer Falle 1 - es macht die Regeln darin
 *    sichtbar und wirft dabei die Angabe weg, die eine responsive Regel
 *    braucht: in welchem Block sie steht.
 *
 * Deshalb laeuft er ueber die Klammern statt ueber ein Regex: er steigt in
 * `@media`, `@supports`, `@container` und `@layer` hinab und merkt sich die
 * Praeambel. `@keyframes` wird uebersprungen - seine Prozentmarken sind
 * Animationsstufen, keine Selektoren, und das alte Muster lieferte dort ohnehin
 * nur die Praeambel mit angebrochenem Rumpf.
 *
 * Wer CSS parst, nimmt IHN - vier Kopien des alten Musters waren vier
 * Gelegenheiten, dieselbe Falle wieder einzubauen.
 */

import { readFileSync } from 'node:fs';
const AT_RULES_WITH_RULES = /^@(?:media|supports|container|layer|scope)\b/;

export function* eachRule(css) {
  const src = css.replace(/\/\*[\s\S]*?\*\//g, '');
  const at = [];
  let index = 0;
  let start = 0;

  while (index < src.length) {
    const char = src[index];

    if (char === '}') {
      at.pop();
      index += 1;
      start = index;
      continue;
    }

    if (char !== '{') {
      index += 1;
      continue;
    }

    const preamble = src.slice(start, index).trim().replace(/\s+/g, ' ');

    if (AT_RULES_WITH_RULES.test(preamble)) {
      at.push(preamble);
      index += 1;
      start = index;
      continue;
    }

    // Alles andere ist ein Block mit Deklarationen (oder @keyframes). Bis zur
    // passenden schliessenden Klammer springen, damit verschachtelte
    // Keyframe-Stufen nicht als eigene Regeln durchgehen.
    let depth = 1;
    let end = index + 1;
    while (end < src.length && depth > 0) {
      if (src[end] === '{') depth += 1;
      else if (src[end] === '}') depth -= 1;
      end += 1;
    }
    if (preamble && !preamble.startsWith('@keyframes')) {
      yield { selector: preamble, body: src.slice(index + 1, end - 1), at: [...at] };
    }
    index = end;
    start = index;
  }
}

/**
 * DIE EINE [hidden]-REGEL (D13, Critique R21). reset.css blendet jedes Element
 * mit `hidden` aus (`display: none !important`, ausser `until-found`); seit R21
 * S9a gibt es keine Rettungsregel je Klasse mehr. Tests, die frueher
 * `.x[hidden] { display: none }` verlangten, fragen hier, ob die globale Regel
 * steht - gelesen ueber eachRule(), auf der Basisebene.
 * @returns {boolean}
 */
export function globalHiddenRule() {
  const reset = readFileSync(new URL('../public/styles/reset.css', import.meta.url), 'utf8');
  return [...eachRule(reset)].some((r) => r.selector.trim() === '[hidden]:not([hidden="until-found"])'
    && !r.at.length && /display:\s*none\s*!important/.test(r.body));
}
