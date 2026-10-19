/**
 * Modul: Test-Infrastruktur - Nachladen im selben try wie das Speichern finden (#2069).
 * Zweck: die Stellen melden, an denen ein `try` erst schreibt (`await api.post/put/patch`)
 *   und danach im selben Block auf ein Nachladen wartet (`await load...()`,
 *   `reload...`, `refresh...`, `fetch...`), waehrend sein `catch` etwas meldet.
 * Ausfuehren: keine eigene Suite - Helfer fuer test-frontend-audit.js.
 *
 * DAS MUSTER: Scheitert das Nachladen, landet der Fehler im catch des
 * Speicherns. Der Dialog bleibt offen, der Toast sagt "nicht gespeichert", und
 * ein zweites Speichern legt den Eintrag doppelt an. Die Antwort ist
 * `reloadAfterSave()` aus public/utils/reload-after-save.js: es faengt den
 * Fehler des Nachladens selbst und meldet ihn als Aktualisierungsproblem.
 *
 * WIE GELESEN WIRD, OHNE PARSER: Kommentare und Literale werden zuerst
 * neutralisiert (source-text.js), dann sucht der Scanner jedes `try {`, seinen
 * Block und den `catch`-Block dahinter (try/finally ohne catch zaehlt nicht,
 * ein leerer catch meldet nichts). Im try-Block zaehlen nur Aufrufe, die in
 * DIESEM Ablauf laufen: nichts in einer verschachtelten Funktion. Ein
 * Nachladen in einem eigenen, verschachtelten try faengt sein catch selbst
 * und zaehlt ebenfalls nicht, eines in einem verschachtelten catch ist ein
 * Fehlerpfad (es lief nichts Gespeichertes voraus, das es bestaetigen muesste).
 * Schreiben und Nachladen in verschiedenen Zweigen eines if/else zaehlen wie
 * hintereinander - lieber eine Stelle zu viel als eine zu wenig.
 *
 * GRENZEN, bewusst: Schreiben ueber einen seiteneigenen Wrapper statt
 * `api.post/put/patch` und Nachladen unter einem anderen Namen fallen nicht auf.
 */
import { withoutCommentsKeepingLines } from './source-text.js';

const NOT_A_FUNCTION = new Set(['if', 'for', 'while', 'switch', 'catch', 'with']);
const WRITE = /\bawait\s+api\s*\.\s*(?:post|put|patch)\s*\(/y;
// `await load()`, `await state.reload()`, `if (await refreshX())`, und ein
// `await Promise.all([loadA(), ...])`, das ein Nachladen enthaelt.
const RELOAD_NAME = /^(?:[\w$]+\.)?(?:load|reload|refresh|fetch)[\w$]*$/i;
const HELPER = 'reloadAfterSave';

function matchingOpen(s, close, open, closeChar) {
  let depth = 0;
  for (let j = close; j >= 0; j -= 1) {
    if (s[j] === closeChar) depth += 1;
    else if (s[j] === open) { depth -= 1; if (depth === 0) return j; }
  }
  return -1;
}

function matchingClose(s, openAt, open = '{', close = '}') {
  let depth = 0;
  for (let j = openAt; j < s.length; j += 1) {
    if (s[j] === open) depth += 1;
    else if (s[j] === close) { depth -= 1; if (depth === 0) return j; }
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

/** Oeffnet die `{` an `brace` den Block eines `try`? */
function opensTry(s, brace) {
  return /(?<![\w$.])try\s*$/.test(s.slice(Math.max(0, brace - 12), brace));
}

/** Oeffnet die `{` an `brace` einen catch-Block? Der ist ein Fehlerpfad, kein Nachladen nach dem Speichern. */
function opensCatch(s, brace) {
  return /(?<![\w$.])catch\s*(?:\([^()]*\))?\s*$/.test(s.slice(Math.max(0, brace - 80), brace));
}

/** Name des Aufrufs, auf den das `await` an `at` wartet, oder null. */
function awaitedCall(s, at) {
  const m = /await\s+((?:[\w$]+\s*\.\s*)?[\w$]+)\s*\(/y;
  m.lastIndex = at;
  const hit = m.exec(s);
  if (!hit) return null;
  const name = hit[1].replace(/\s+/g, '');
  if (name === HELPER) return null;
  if (RELOAD_NAME.test(name)) return name;
  if (name === 'Promise.all' || name === 'Promise.allSettled') {
    if (name === 'Promise.allSettled') return null; // wirft nicht
    const open = at + hit[0].length - 1;
    const args = s.slice(open, matchingClose(s, open, '(', ')') + 1);
    for (const inner of args.matchAll(/(?<![\w$.])((?:[\w$]+\.)?[\w$]+)\s*\(/g)) {
      if (inner[1] !== HELPER && RELOAD_NAME.test(inner[1])) return `Promise.all(${inner[1]})`;
    }
  }
  return null;
}

/**
 * @param {string} src  Quelltext eines Frontend-Moduls
 * @returns {{ line: number, call: string, at: number }[]} jedes Nachladen hinter einem Schreiben im selben try
 */
export function reloadsAfterWrite(src) {
  const s = withoutCommentsKeepingLines(src, { blankLiterals: true });
  const found = [];
  for (const m of s.matchAll(/(?<![\w$.])try\s*\{/g)) {
    const open = m.index + m[0].length - 1;
    const close = matchingClose(s, open);
    if (close < 0) continue;
    const after = /^\s*catch\s*(\([^)]*\))?\s*\{/.exec(s.slice(close + 1));
    if (!after) continue;
    const hOpen = close + after[0].length;
    const hClose = matchingClose(s, hOpen);
    if (hClose < 0 || s.slice(hOpen + 1, hClose).trim() === '') continue;

    let wrote = false;
    // Je offener `{` im try-Block: verschachtelte Funktion, eigener try oder catch, sonst Block.
    const stack = [];
    for (let k = open + 1; k < close; k += 1) {
      const c = s[k];
      if (c === '{') { stack.push(opensFunction(s, k) ? 'fn' : (opensTry(s, k) || opensCatch(s, k) ? 'guarded' : 'block')); continue; }
      if (c === '}') { stack.pop(); continue; }
      if (c !== 'a' || !s.startsWith('await', k) || /[\w$]/.test(s[k - 1] ?? '') || /[\w$]/.test(s[k + 5] ?? '')) continue;
      if (stack.includes('fn')) continue;
      WRITE.lastIndex = k;
      if (WRITE.test(s)) { wrote = true; continue; }
      if (!wrote || stack.includes('guarded')) continue;
      const call = awaitedCall(s, k);
      if (call) found.push({ line: s.slice(0, k).split('\n').length, call, at: k });
    }
  }
  return found;
}
