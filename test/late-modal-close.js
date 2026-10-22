/**
 * Modul: Test-Infrastruktur - spaete Dialog-Aufrufe ohne Kontext finden (#1997).
 * Zweck: die Stellen zaehlen, an denen eine Seite NACH einer Antwort den
 *   geteilten Dialog schliesst oder einen neuen oeffnet, ohne zu pruefen, ob
 *   der Bildschirm noch der ist, auf dem die Anfrage losging.
 * Ausfuehren: keine eigene Suite - Helfer fuer test-frontend-audit.js.
 *
 * DAS MUSTER: Es gibt einen einzigen Modal-Slot. `closeModal({ force: true })`
 * schliesst, was gerade darin liegt, und `openModal()` schliesst es ebenso,
 * bevor es den eigenen Dialog hineinlegt - auch `confirmModal()`, das durch
 * `openModal()` geht (#2134: die Meldung nach einem Fehlschlag, die Frage aus
 * einer Antwort). Kommt der Aufruf erst mit der
 * Antwort, kann im Slot ein Dialog liegen, den der Nutzer INZWISCHEN geoeffnet
 * hat - force fragt nicht nach, die Eingaben darin sind weg -, oder der Nutzer
 * ist laengst auf einer anderen Seite, und der Dialog geht dort auf.
 *
 * GESCHUETZT ist ein Schliessen, das den vor der Anfrage gemerkten Kontext
 * mitgibt (`closeModal({ force: true, context })`, die Regel steht in
 * components/modal.js), und jeder Aufruf, vor dem seit der Antwort ein
 * `isModalContextCurrent(...)` steht (fuer das Oeffnen der einzige Schutz:
 * es nimmt keinen Kontext; den Kontext dafuer haelt `captureOpenContext()`
 * fest, damit von zwei schnell gewaehlten Dialogen der zuletzt gewaehlte gilt).
 *
 * SPAET ist ein Aufruf in zwei Formen:
 * - hinter einem `await` derselben Funktion (ohne die in verschachtelten
 *   Funktionen, die laufen nicht in diesem Ablauf). Ein `await` direkt vor dem
 *   Aufruf selbst (`await closeModal(...)`) wartet auf ihn, nicht davor. Ein
 *   `await` in einem Block, der mit `return`/`throw` endet, bevor der Aufruf
 *   kommt, fuehrt nie zu ihm (`catch { await confirmModal(...); return; }`),
 *   ebenso eines in einem frueheren Zweig derselben if/else-Kette oder in
 *   einem Geschwister-`if (X === 'a')`, wenn der Aufruf in `if (X === 'b')`
 *   steht. Ein `await` auf eine Rueckfrage (`confirmModal`, `confirmOverModal`,
 *   `promptModal`, `selectModal`) zaehlt nicht: deren Antwort gibt der Nutzer
 *   selbst im offenen Dialog.
 * - in einem Rueckruf von `.then()`, `.catch()` oder `.finally()`, auch als
 *   Ausdruck (`.then(() => closeModal())`) oder als blosser Name
 *   (`.then(closeModal)`): der laeuft immer erst mit der Antwort.
 *
 * WIE GELESEN WIRD, OHNE PARSER: Kommentare und Literale werden zuerst
 * neutralisiert (source-text.js), dann sucht der Scanner zu jedem Aufruf die
 * innerste umschliessende FUNKTION (eine `{` hinter `=>` oder hinter einer
 * Parameterliste, die nicht zu if/for/while/switch/catch gehoert).
 *
 * GRENZEN, bewusst: Gesehen werden nur die Namen `closeModal`/`openModal`/
 * `confirmModal` und ihre Import-Aliase (`confirmOverModal` nicht: es parkt
 * einen offenen Dialog, statt ihn zu verdraengen). Ein seiteneigener Wrapper, der fuer seine Aufrufer
 * schliesst oder oeffnet (recipes.js `reportError`, `openEventModal`), faellt
 * nicht auf, wenn ER nach einem `await` gerufen wird - das bleibt beim
 * Review. Ein Page-Owner-Check (`stillShown(owner)`, `signal.aborted`) zaehlt
 * nicht als Schutz: er sieht die Seite, nicht den Dialog. Gezaehlt wird,
 * nicht verboten: der Bestand ist eine Liste, die nur sinken darf.
 */
import { withoutCommentsKeepingLines } from './source-text.js';

const NOT_A_FUNCTION = new Set(['if', 'for', 'while', 'switch', 'catch', 'with']);
const PROMISE_CALLBACK = /\.\s*(?:then|catch|finally)\s*$/;

function matchingOpen(s, close, open, closeChar) {
  let depth = 0;
  for (let j = close; j >= 0; j -= 1) {
    if (s[j] === closeChar) depth += 1;
    else if (s[j] === open) { depth -= 1; if (depth === 0) return j; }
  }
  return -1;
}

function matchingClose(s, open) {
  let depth = 0;
  for (let j = open; j < s.length; j += 1) {
    if (s[j] === '{') depth += 1;
    else if (s[j] === '}') { depth -= 1; if (depth === 0) return j; }
  }
  return -1;
}

function skipSpaceBack(s, j) {
  while (j >= 0 && /\s/.test(s[j])) j -= 1;
  return j;
}

/** Oeffnet die `{` an `brace` einen Funktionskoerper? */
function opensFunction(s, brace) {
  const j = skipSpaceBack(s, brace - 1);
  if (s[j] === '>' && s[j - 1] === '=') return true;
  if (s[j] !== ')') return false;
  let k = skipSpaceBack(s, matchingOpen(s, j, '(', ')') - 1);
  const end = k;
  while (k >= 0 && /[\w$]/.test(s[k])) k -= 1;
  return !NOT_A_FUNCTION.has(s.slice(k + 1, end + 1));
}

/**
 * Steht die Funktion, deren Koerper (oder Pfeil `=>`) bei `at` beginnt, als
 * Argument in `.then(`/`.catch(`/`.finally(`?
 */
function isPromiseCallback(s, at) {
  let j = skipSpaceBack(s, at - 1);
  if (s[j] === '>' && s[j - 1] === '=') {
    j = skipSpaceBack(s, j - 2);
    if (s[j] === ')') j = matchingOpen(s, j, '(', ')') - 1;
    else while (j >= 0 && /[\w$]/.test(s[j])) j -= 1;
  } else if (s[j] === ')') {
    j = skipSpaceBack(s, matchingOpen(s, j, '(', ')') - 1);
    while (j >= 0 && /[\w$]/.test(s[j])) j -= 1; // Name einer function-Ausdrucks
    j = skipSpaceBack(s, j);
    if (s.slice(j - 7, j + 1) === 'function') j -= 8;
  } else return false;
  j = skipSpaceBack(s, j);
  if (s.slice(j - 4, j + 1) === 'async') j = skipSpaceBack(s, j - 5);
  // Das umschliessende Klammerpaar des Arguments finden (auch als zweites).
  let depth = 0;
  for (; j >= 0; j -= 1) {
    const c = s[j];
    if (c === ')' || c === ']' || c === '}') depth += 1;
    else if (c === '(' || c === '[' || c === '{') {
      if (depth === 0) break;
      depth -= 1;
    } else if (depth === 0 && c === ';') return false;
  }
  return j >= 0 && s[j] === '(' && PROMISE_CALLBACK.test(s.slice(Math.max(0, j - 30), j));
}

/** Endet der Block `{ ... }` von `open` bis `close` mit return/throw? */
function endsInExit(s, open, close) {
  const inner = s.slice(open + 1, close).replace(/[\s;]+$/, '');
  let depth = 0;
  let start = 0;
  for (let j = 0; j < inner.length; j += 1) {
    const c = inner[j];
    if (c === '(' || c === '[' || c === '{') depth += 1;
    else if (c === ')' || c === ']' || c === '}') {
      depth -= 1;
      if (depth === 0 && c === '}') start = j + 1;
    } else if (depth === 0 && c === ';') start = j + 1;
  }
  return /^\s*(?:return|throw)\b/.test(inner.slice(start));
}

/**
 * Die Bedingung `X === 'wert'` des `if`, dessen Block bei `open` beginnt, als
 * { subject, value } - sonst null. `raw` ist derselbe Text mit Literalen.
 */
function ifEquals(s, raw, open) {
  const j = skipSpaceBack(s, open - 1);
  if (s[j] !== ')') return null;
  const p = matchingOpen(s, j, '(', ')');
  const k = skipSpaceBack(s, p - 1);
  if (s.slice(k - 1, k + 1) !== 'if' || /[\w$]/.test(s[k - 2] ?? '')) return null;
  const m = /^\s*([\w$.]+)\s*===\s*(['"])([^'"\\]*)\2\s*$/.exec(raw.slice(p + 1, j));
  return m ? { subject: m[1], value: m[3] } : null;
}

function skipSpace(s, j) {
  while (j < s.length && /\s/.test(s[j])) j += 1;
  return j;
}

/**
 * Steht `to` in einem spaeteren Zweig der if/else-Kette, deren Block bei
 * `close` endet? Dann erreicht ein `await` in diesem Block den Aufruf nie.
 */
function inLaterBranch(s, close, to) {
  const j = skipSpace(s, close + 1);
  if (!s.startsWith('else', j) || /[\w$]/.test(s[j + 4] ?? '')) return false;
  let k = skipSpace(s, j + 4);
  if (s.startsWith('if', k) && !/[\w$]/.test(s[k + 2] ?? '')) {
    k = skipSpace(s, k + 2);
    if (s[k] !== '(') return false;
    let depth = 0;
    for (; k < s.length; k += 1) {
      if (s[k] === '(') depth += 1;
      else if (s[k] === ')') { depth -= 1; if (depth === 0) break; }
    }
    k = skipSpace(s, k + 1);
  }
  if (s[k] !== '{') return false;
  const end = matchingClose(s, k);
  if (end < 0) return false;
  return (to > k && to < end) || (to > end && inLaterBranch(s, end, to));
}

/** Die `if (X === 'wert')`-Bloecke, in denen der Aufruf bei `at` steht. */
function openIfsAt(s, raw, from, at) {
  const open = [];
  for (let k = from; k < at; k += 1) {
    if (s[k] === '{') open.push(k);
    else if (s[k] === '}') open.pop();
  }
  return open.map((b) => ifEquals(s, raw, b)).filter(Boolean);
}

/**
 * Das letzte `await` in `s[from..to)`, das den Aufruf bei `to` erreicht.
 * `dialogAt(k)` sagt, ob das `await` vor k auf eine Rueckfrage wartet: deren
 * Antwort gibt der Nutzer selbst im offenen Dialog, das ist keine spaete
 * Antwort. `callIfs` sind die `if (X === 'wert')` um den Aufruf.
 */
function lastLiveAwait(s, raw, from, to, { dialogAt = () => false, callIfs = [] } = {}) {
  let last = -1;
  const blocks = []; // { open, fn }
  for (let k = from; k < to; k += 1) {
    if (s[k] === '{') blocks.push({ open: k, fn: opensFunction(s, k) });
    else if (s[k] === '}') blocks.pop();
    else if (s.startsWith('await', k) && !/[\w$]/.test(s[k - 1]) && !/[\w$]/.test(s[k + 5] ?? '')
      && !blocks.some((b) => b.fn) && s.slice(k + 5, to).trim() !== '' && !dialogAt(k + 5)) {
      const deadEnd = blocks.some((b) => {
        b.close ??= matchingClose(s, b.open);
        if (b.close < 0 || b.close >= to) return false;
        if (endsInExit(s, b.open, b.close)) return true;
        // Ein frueherer Zweig derselben Kette: `if (a) { await x(); } else { aufruf(); }`.
        if (inLaterBranch(s, b.close, to)) return true;
        // Ein anderer Zweig derselben Weiche: `if (action === 'a') { await ... }`
        // erreicht nie den Aufruf in `if (action === 'b') { ... }`.
        b.cond ??= ifEquals(s, raw, b.open) ?? false;
        return Boolean(b.cond) && callIfs.some((c) => c.subject === b.cond.subject && c.value !== b.cond.value);
      });
      if (!deadEnd) last = k;
    }
  }
  return last;
}

function namesFor(s, base) {
  const names = [base];
  for (const m of s.matchAll(new RegExp(`\\b${base}\\s+as\\s+([\\w$]+)`, 'g'))) names.push(m[1]);
  return names;
}

function lineOf(s, at) {
  return s.slice(0, at).split('\n').length;
}

/**
 * @param {string} src  Quelltext eines Frontend-Moduls
 * @returns {{ line: number, kind: 'close'|'open'|'confirm', via: 'await'|'then', guarded: boolean }[]}
 *   jeder closeModal-/openModal-/confirmModal-Aufruf, der erst mit einer Antwort laeuft
 */
export function lateModalCalls(src) {
  const s = withoutCommentsKeepingLines(src, { blankLiterals: true });
  const raw = withoutCommentsKeepingLines(src);
  const dialogs = ['confirmModal', 'confirmOverModal', 'promptModal', 'selectModal'].flatMap((base) => namesFor(s, base));
  const dialogCall = new RegExp(`^\\s*(?:${dialogs.join('|')})\\s*\\(`);
  const dialogAt = (k) => dialogCall.test(s.slice(k, k + 80));
  const found = [];
  for (const [kind, base] of [['close', 'closeModal'], ['open', 'openModal'], ['confirm', 'confirmModal']]) {
    const names = namesFor(s, base).join('|');
    // `.then(closeModal)`: der blosse Name als Rueckruf, ohne jeden Kontext.
    for (const m of s.matchAll(new RegExp(`\\.\\s*(?:then|catch|finally)\\s*\\(\\s*(?:${names})\\s*[,)]`, 'g'))) {
      found.push({ line: lineOf(s, m.index), kind, via: 'then', guarded: false });
    }
    for (const m of s.matchAll(new RegExp(`(?<![\\w$.])(?:${names})\\s*\\(`, 'g'))) {
      const at = m.index;
      if (/\bfunction\s*$/.test(s.slice(Math.max(0, at - 20), at))) continue;
      let end = at + m[0].length;
      for (let open = 1; end < s.length && open; end += 1) {
        if (s[end] === '(') open += 1;
        else if (s[end] === ')') open -= 1;
      }
      const args = s.slice(at + m[0].length, end - 1);
      const withContext = kind === 'close' && /\bcontext\b/.test(args);
      const checked = (from) => /\bisModalContextCurrent\s*\(/.test(s.slice(from, at));

      // `() => closeModal()`: ein eigener Koerper ohne await - spaet nur als
      // Rueckruf eines Versprechens.
      const before = skipSpaceBack(s, at - 1);
      if (s[before] === '>' && s[before - 1] === '=') {
        if (isPromiseCallback(s, before + 1)) found.push({ line: lineOf(s, at), kind, via: 'then', guarded: withContext });
        continue;
      }
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
      const lastAwait = lastLiveAwait(s, raw, body + 1, at, { dialogAt, callIfs: openIfsAt(s, raw, body + 1, at) });
      if (lastAwait >= 0) {
        found.push({ line: lineOf(s, at), kind, via: 'await', guarded: withContext || checked(lastAwait) });
      } else if (isPromiseCallback(s, body)) {
        found.push({ line: lineOf(s, at), kind, via: 'then', guarded: withContext || checked(body) });
      }
    }
  }
  return found.sort((a, b) => a.line - b.line);
}

/** Nur die Schliessen-Aufrufe (der Bestand vor der Erweiterung, #2123). */
export function lateModalCloses(src) {
  return lateModalCalls(src).filter((call) => call.kind === 'close');
}
