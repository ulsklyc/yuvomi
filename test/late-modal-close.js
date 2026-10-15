/**
 * Modul: Test-Infrastruktur - spaete closeModal()-Aufrufe ohne Kontext finden (#1997).
 * Zweck: die Stellen zaehlen, an denen eine Seite NACH einem `await` den
 *   geteilten Dialog schliesst, ohne zu sagen, welchen sie meint.
 * Ausfuehren: keine eigene Suite - Helfer fuer test-frontend-audit.js.
 *
 * DAS MUSTER: Es gibt einen einzigen Modal-Slot. `closeModal({ force: true })`
 * schliesst, was gerade darin liegt. Steht der Aufruf hinter einem `await`
 * (Speichern kam an), kann das ein Dialog sein, den der Nutzer INZWISCHEN
 * geoeffnet hat - force fragt nicht nach, die Eingaben darin sind weg.
 * Geschuetzt ist ein Aufruf, der den vor der Anfrage gemerkten Kontext
 * mitgibt (`closeModal({ force: true, context })`, die Regel steht in
 * components/modal.js), oder einer, vor dem seit dem letzten `await` ein
 * `isModalContextCurrent(...)` steht.
 *
 * WIE GELESEN WIRD, OHNE PARSER: Kommentare und Literale werden zuerst
 * neutralisiert (source-text.js), dann sucht der Scanner zu jedem Aufruf die
 * innerste umschliessende FUNKTION (eine `{` hinter `=>` oder hinter einer
 * Parameterliste, die nicht zu if/for/while/switch/catch gehoert) und zaehlt
 * die `await` darin VOR dem Aufruf - ohne die in verschachtelten Funktionen,
 * die laufen nicht in diesem Ablauf. Ein `await` direkt vor dem Aufruf selbst
 * (`await closeModal(...)`) wartet auf das Schliessen, nicht davor.
 *
 * GRENZEN, bewusst: Ein Aufruf in einem `.then(() => closeModal())` ohne
 * `await` faellt nicht auf, ebenso ein seiteneigener Wrapper, der das
 * Schliessen fuer seine Aufrufer erledigt (recipes.js `closeModal`) - der
 * Scanner sieht nur die Namen `closeModal` und seine Import-Aliase. Gezaehlt
 * wird, nicht verboten: der Bestand ist eine Liste, die nur sinken darf.
 */
import { withoutCommentsKeepingLines } from './source-text.js';

const NOT_A_FUNCTION = new Set(['if', 'for', 'while', 'switch', 'catch', 'with']);

function matchingOpen(s, close, open, closeChar) {
  let depth = 0;
  for (let j = close; j >= 0; j -= 1) {
    if (s[j] === closeChar) depth += 1;
    else if (s[j] === open) { depth -= 1; if (depth === 0) return j; }
  }
  return -1;
}

/** Oeffnet die `{` an `brace` einen Funktionskoerper? */
function opensFunction(s, brace) {
  let j = brace - 1;
  while (j >= 0 && /\s/.test(s[j])) j -= 1;
  if (s[j] === '>' && s[j - 1] === '=') return true;
  if (s[j] !== ')') return false;
  let k = matchingOpen(s, j, '(', ')') - 1;
  while (k >= 0 && /\s/.test(s[k])) k -= 1;
  const end = k;
  while (k >= 0 && /[\w$]/.test(s[k])) k -= 1;
  return !NOT_A_FUNCTION.has(s.slice(k + 1, end + 1));
}

/**
 * @param {string} src  Quelltext eines Frontend-Moduls
 * @returns {{ line: number, guarded: boolean }[]} jeder closeModal-Aufruf hinter einem await
 */
export function lateModalCloses(src) {
  const s = withoutCommentsKeepingLines(src, { blankLiterals: true });
  const names = ['closeModal'];
  for (const m of s.matchAll(/\bcloseModal\s+as\s+([\w$]+)/g)) names.push(m[1]);
  const call = new RegExp(`(?<![\\w$.])(?:${names.join('|')})\\s*\\(`, 'g');
  const found = [];
  for (const m of s.matchAll(call)) {
    const at = m.index;
    if (/\bfunction\s*$/.test(s.slice(Math.max(0, at - 20), at))) continue;
    let j = at - 1;
    while (j >= 0 && /\s/.test(s[j])) j -= 1;
    if (s[j] === '>' && s[j - 1] === '=') continue; // `() => closeModal()`: eigener Koerper ohne await
    let depth = 0;
    let body = -1;
    for (let k = at - 1; k >= 0; k -= 1) {
      if (s[k] === '}') depth += 1;
      else if (s[k] === '{') {
        if (depth > 0) depth -= 1;
        else if (opensFunction(s, k)) { body = k; break; }
      }
    }
    if (body < 0) continue;
    let lastAwait = -1;
    const nested = [];
    for (let k = body + 1; k < at; k += 1) {
      if (s[k] === '{') nested.push(opensFunction(s, k));
      else if (s[k] === '}') nested.pop();
      else if (s.startsWith('await', k) && !/[\w$]/.test(s[k - 1]) && !/[\w$]/.test(s[k + 5] ?? '')
        && !nested.includes(true) && s.slice(k + 5, at).trim() !== '') lastAwait = k;
    }
    if (lastAwait < 0) continue;
    let end = at + m[0].length;
    for (let open = 1; end < s.length && open; end += 1) {
      if (s[end] === '(') open += 1;
      else if (s[end] === ')') open -= 1;
    }
    const args = s.slice(at + m[0].length, end - 1);
    const guarded = /\bcontext\b/.test(args) || /\bisModalContextCurrent\s*\(/.test(s.slice(lastAwait, at));
    found.push({ line: s.slice(0, at).split('\n').length, guarded });
  }
  return found;
}
