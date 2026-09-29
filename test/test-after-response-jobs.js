/**
 * Test-Suite: Arbeit, die nach der Antwort weiterlaeuft, laeuft als Job (#1532).
 *
 * Der Restore wartet auf zugelassene schreibende Anfragen bis zu ihrem
 * `res.end()` und auf Jobs in `runExternalJob()` (server/utils/restore-state.js).
 * Ein Promise, das eine Route nach der Antwort weiterlaufen laesst (Push nach
 * einer Erwaehnung, Reset-Mail, Kalender-Sofortversuch), sieht er nicht: es
 * kann nach einem `await` in die gesperrte, geschlossene oder schon
 * eingespielte Datenbank schreiben. Dasselbe gilt fuer einen Timer, der eine
 * async-Funktion anstoesst - ein Wurf von `db.get()` bei geschlossener
 * Verbindung wird dort zur Rejection ohne Handler und beendet den Prozess.
 *
 * Der Guard sucht deshalb nicht nach `res.json()`, sondern nach der Ursache:
 * jedem SCHWIMMENDEN Promise in `server/` - einer Kette mit `.catch/.then/
 * .finally` oder einem Aufruf einer in `server/` als `async` definierten
 * Funktion, deren Ergebnis weder `await`et, `return`t noch zugewiesen wird.
 * Jedes muss am Kopf `runExternalJob(` tragen oder eine Funktion rufen, die der
 * Guard selbst als Huelle nachweist (Rumpf beginnt mit `return runExternalJob(`
 * oder `return runSerialized(`; alle gleichnamigen Definitionen muessen
 * Huellen sein). Der Rest steht in AUSNAHMEN, je mit Grund, und jede Ausnahme
 * muss genau so oft treffen wie angegeben.
 *
 * Gelesen wird der Quelltext mit neutralisierten Kommentaren UND Literalen:
 * ein auskommentierter oder im String stehender Aufruf ist tot und zaehlt
 * nicht. Umgekehrt macht ein toter `runExternalJob(...)` neben einem
 * ungewickelten Aufruf nichts gruen - geurteilt wird ueber den schwimmenden
 * Aufruf selbst, nicht ueber die Anwesenheit des Wrappers.
 *
 * GRENZE: ein Promise, das als Argument an eine Funktion geht, die es
 * verwirft (`foo(x().catch(...))`), gilt als verbraucht. Das Verhalten der
 * gewickelten Stellen pruefen die Tests in test:restore-server.
 *
 * Lauf: npm run test:after-response-jobs
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { withoutCommentsKeepingLines } from './source-text.js';

const ROOT = join(import.meta.dirname, '..');
const SERVER = join(ROOT, 'server');

/**
 * Schwimmende Promises, die bewusst keine Jobs sind. Schluessel ist
 * `datei|aufgerufene Funktion` (die erste Funktion der Kette), Wert die
 * erwartete Trefferzahl und der Grund. Ein Eintrag, der nicht mehr genau so oft
 * trifft, ist selbst ein Befund.
 */
const AUSNAHMEN = new Map([
  ['server/utils/restore-state.js|tracked.catch', {
    anzahl: 1, grund: 'in runExternalJob selbst: der Job ist schon registriert, der Fehler gehoert dem Aufrufer',
  }],
  ['server/utils/restore-state.js|finished.then', {
    anzahl: 1, grund: 'raeumt nur den Timer einer festgehaltenen Anfrage weg, keine DB',
  }],
  ['server/utils/sync-lock.js|drain', {
    anzahl: 1, grund: 'die Schlange selbst: drain startet jeden Eintrag per runExternalJob (sync-lock.js, `await runExternalJob(entry.run)`)',
  }],
  ['server/auth.js|state.tail.then', {
    anzahl: 1, grund: 'Buchfuehrung der Reset-Mail-Kette (Map-Eintrag entfernen), keine DB; laeuft innerhalb des Jobs von /forgot-password',
  }],
  ['server/utils/http.js|assertLookupAcceptsLiteral', {
    anzahl: 1, grund: 'DNS-Pruefung im lookup-Callback, keine DB',
  }],
  ['server/services/document-storage.js|validatedHostAddresses', {
    anzahl: 1, grund: 'DNS-Pruefung im lookup-Callback, keine DB',
  }],
  ['server/index.js|checkLocalStorageMount', {
    anzahl: 1, grund: 'einmal beim Start, nur Dateisystem (stat/access), keine DB',
  }],
]);

/** Aufrufer, die ein uebergebenes Callback spaeter ohne Blick auf sein Ergebnis starten. */
const TIMER = /(?<![\w$.])(?:setTimeout|setInterval|setImmediate|queueMicrotask|process\.nextTick|cron\.schedule|\.on|\.once)\s*\(/g;

/** Woerter, hinter denen ein Aufruf verbraucht ist (oder gar keiner, sondern eine Definition). */
const VERBRAUCHT_NACH_WORT = new Set([
  'await', 'return', 'yield', 'throw', 'new', 'typeof', 'delete', 'in', 'of', 'instanceof',
  'case', 'function', 'async', 'get', 'set', 'static',
]);
/** Woerter, hinter denen eine Anweisung beginnt. */
const ANWEISUNG_NACH_WORT = new Set(['else', 'do', 'void']);

function jsFiles(dir) {
  const out = [];
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) out.push(...jsFiles(full));
    else if (name.endsWith('.js')) out.push(full);
  }
  return out;
}

const IDENT = /[\w$#]/;

/** Index der zu `code[close]` passenden oeffnenden Klammer, rueckwaerts. */
function openerOf(code, close) {
  const pair = { ')': '(', ']': '[', '}': '{' };
  const want = pair[code[close]];
  let depth = 0;
  for (let i = close; i >= 0; i--) {
    const c = code[i];
    if (c === code[close]) depth++;
    else if (c === want && --depth === 0) return i;
  }
  return -1;
}

/** Index hinter der zu `code[open]` passenden schliessenden Klammer. */
function closerOf(code, open) {
  const pair = { '(': ')', '[': ']', '{': '}' };
  const want = pair[code[open]];
  let depth = 0;
  for (let i = open; i < code.length; i++) {
    const c = code[i];
    if (c === code[open]) depth++;
    else if (c === want && --depth === 0) return i + 1;
  }
  return code.length;
}

function skipSpaceBack(code, i) {
  while (i > 0 && /\s/.test(code[i - 1])) i--;
  return i;
}

/**
 * Anfang der Aufrufkette, die bei `pos` einen Bezeichner oder `.name` hat:
 * rueckwaerts ueber Bezeichner, Punkte (auch `?.`) und geklammerte Gruppen.
 */
function chainStart(code, pos, { atName = false } = {}) {
  let i = pos;
  // Steht `pos` auf einem Namen, kommt davor nur noch ein Punkt in Frage -
  // ein Wort davor (`await`, `return`, `else`) gehoert nicht zur Kette.
  let expectDot = atName;
  for (;;) {
    let j = skipSpaceBack(code, i);
    if (expectDot) {
      if (j > 0 && code[j - 1] === '.') {
        i = j - 1;
        if (i > 0 && code[i - 1] === '?') i--;
        expectDot = false;
        continue;
      }
      return i;
    }
    if (j > 0 && (code[j - 1] === ')' || code[j - 1] === ']')) {
      const open = openerOf(code, j - 1);
      if (open < 0) return i;
      i = open;
      continue;
    }
    if (j > 0 && IDENT.test(code[j - 1])) {
      while (j > 0 && IDENT.test(code[j - 1])) j--;
      i = j;
      expectDot = true;
      continue;
    }
    return i;
  }
}

/**
 * Was steht vor dem Kettenanfang? 'anweisung' (das Ergebnis faellt weg),
 * 'pfeil' (Rumpf eines Pfeils ohne Block), 'verbraucht' oder 'definition'.
 */
function position(code, start) {
  const j = skipSpaceBack(code, start);
  if (j === 0) return 'anweisung';
  const c = code[j - 1];
  if (c === '>' && code[j - 2] === '=') return 'pfeil';
  if (';{}'.includes(c)) return 'anweisung';
  if (c === ')') return 'anweisung'; // `if (x) foo()`, `for (...) foo()`
  if (IDENT.test(c)) {
    let k = j;
    while (k > 0 && IDENT.test(code[k - 1])) k--;
    const word = code.slice(k, j);
    if (ANWEISUNG_NACH_WORT.has(word)) return 'anweisung';
    if (VERBRAUCHT_NACH_WORT.has(word)) return 'verbraucht';
    return 'verbraucht';
  }
  return 'verbraucht';
}

/** Die erste aufgerufene Funktion der Kette ab `start`, z. B. `pushService.sendPushToUser`. */
function firstCallee(code, start) {
  const m = code.slice(start).match(/^[\w$#.?\s]*?(?=\s*\()/);
  return (m ? m[0] : '').replace(/\s+/g, '').replace(/\?\./g, '.');
}

/** Alle Definitionen je Name, und ob sie eine Huelle sind. */
function collectDefinitions(sources) {
  const asyncNames = new Set();
  const defs = new Map(); // name -> [{ file, wrapper }]
  const add = (name, file, wrapper) => {
    if (!defs.has(name)) defs.set(name, []);
    defs.get(name).push({ file, wrapper });
  };
  const huelle = (body) => /^\s*return\s+(?:runExternalJob|runSerialized)\s*\(/.test(body);
  for (const [file, code] of sources) {
    for (const m of code.matchAll(/(?<![\w$.])(async\s+)?function\s*\*?\s*([A-Za-z_$][\w$]*)\s*\(/g)) {
      const name = m[2];
      if (m[1]) asyncNames.add(name);
      const open = m.index + m[0].length - 1;
      const afterParams = closerOf(code, open);
      const brace = code.indexOf('{', afterParams);
      add(name, file, huelle(code.slice(brace + 1)));
    }
    for (const m of code.matchAll(/(?<![\w$.])(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(async\b)?\s*(?:\([^)]*\)|[A-Za-z_$][\w$]*)\s*=>\s*/g)) {
      const name = m[1];
      if (m[2]) asyncNames.add(name);
      const rest = code.slice(m.index + m[0].length);
      add(name, file, /^(?:runExternalJob|runSerialized)\s*\(/.test(rest) || (rest.startsWith('{') && huelle(rest.slice(1))));
    }
    for (const m of code.matchAll(/(?<![\w$.])async\s+(?!function\b)(#?[A-Za-z_$][\w$]*)\s*\(/g)) {
      const name = m[1].replace(/^#/, '');
      asyncNames.add(name);
      const open = m.index + m[0].length - 1;
      const brace = code.indexOf('{', closerOf(code, open));
      add(name, file, huelle(code.slice(brace + 1)));
    }
  }
  return { asyncNames, defs };
}

/**
 * Schwimmende Promises in `sources` (Map datei -> Quelltext, bereits ohne
 * Kommentare und Literale).
 * @returns {{ file: string, line: number, callee: string, ok: boolean, form: string }[]}
 */
export function floatingPromises(sources) {
  const { asyncNames, defs } = collectDefinitions(sources);
  const isHuelle = (callee) => {
    const last = callee.split('.').pop();
    if (last === 'runExternalJob') return true;
    const list = defs.get(last);
    return !!list && list.length > 0 && list.every((d) => d.wrapper);
  };
  const found = [];
  for (const [file, code] of sources) {
    const seen = new Set();
    const lineOf = (i) => code.slice(0, i).split('\n').length;
    const report = (start, form) => {
      if (seen.has(start)) return;
      seen.add(start);
      const callee = firstCallee(code, start);
      found.push({ file, line: lineOf(start), callee, ok: isHuelle(callee), form });
    };
    // 1) Ketten mit .catch/.then/.finally als Anweisung oder Pfeilrumpf.
    for (const m of code.matchAll(/\.\s*(?:catch|then|finally)\s*\(/g)) {
      const start = chainStart(code, m.index);
      const where = position(code, start);
      if (where === 'anweisung' || where === 'pfeil') report(start, `.${m[0].replace(/[.\s(]/g, '')}`);
    }
    // 2) Aufruf einer async-Funktion als Anweisung.
    for (const m of code.matchAll(/(?<![\w$#])(#?[A-Za-z_$][\w$]*)\s*\(/g)) {
      const name = m[1].replace(/^#/, '');
      if (!asyncNames.has(name)) continue;
      const open = m.index + m[0].length - 1;
      const after = code.slice(closerOf(code, open)).match(/^\s*(\S)/);
      if (after && after[1] === '{') continue; // Methodendefinition
      const start = chainStart(code, m.index, { atName: true });
      // Die Express-Objekte sind nie ein Promise: `res.send()` heisst nur so wie
      // die async-Methode `send()` der Benachrichtigungskanaele.
      if (/^(?:res|req|app|router)\./.test(firstCallee(code, start))) continue;
      if (position(code, start) === 'anweisung') report(start, 'async-Aufruf');
    }
    // 3) async-Funktion oder async-Pfeil als Callback eines Timers/Ereignisses.
    for (const m of code.matchAll(TIMER)) {
      const args = code.slice(m.index + m[0].length, closerOf(code, m.index + m[0].length - 1) - 1);
      for (const arg of args.split(',').map((a) => a.trim())) {
        if (/^async\b/.test(arg)) {
          found.push({ file, line: lineOf(m.index), callee: 'async-Callback', ok: false, form: 'timer' });
        } else if (/^[A-Za-z_$][\w$.]*$/.test(arg) && asyncNames.has(arg.split('.').pop())) {
          found.push({ file, line: lineOf(m.index), callee: arg, ok: isHuelle(arg), form: 'timer' });
        }
      }
    }
  }
  return found;
}

function serverSources() {
  const sources = new Map();
  for (const full of jsFiles(SERVER)) {
    const file = relative(ROOT, full).split('\\').join('/');
    sources.set(file, withoutCommentsKeepingLines(readFileSync(full, 'utf8'), { blankLiterals: true }));
  }
  return sources;
}

// ---------------------------------------------------------------------------
// Der Scanner erkennt die Formen aus dem Audit (Selbstprobe)
// ---------------------------------------------------------------------------

function probe(src, extra = '') {
  const sources = new Map([
    ['probe.js', withoutCommentsKeepingLines(src, { blankLiterals: true })],
    ['defs.js', withoutCommentsKeepingLines(`
      import { runExternalJob } from './restore-state.js';
      export async function sendPush() {}
      export async function tick() {}
      export function wrapped() { return runExternalJob(() => sendPush()); }
      ${extra}
    `, { blankLiterals: true })],
  ]);
  return floatingPromises(sources).filter((f) => f.file === 'probe.js');
}

test('Selbstprobe: der Scanner erkennt schwimmende Promises in allen Formen des Audits', () => {
  const faelle = [
    ['Kette als Anweisung nach res.json', 'res.json({}); sendPush(1).catch(() => {});', 1],
    ['Kette ueber mehrere Zeilen', 'if (x) {\n  sendPush()\n    .catch(() => {});\n}', 1],
    ['Methode an einem Objekt', 'res.json({}); service.sendPush(id, {\n a: 1 }).catch(log);', 1],
    ['Pfeilrumpf an setImmediate/defer', 'defer(() => sendPush(1).catch(log));', 1],
    ['async-Aufruf ohne await', 'setTimeout(() => {\n  tick();\n}, 10);', 1],
    ['async-Funktion als Timer-Callback', 'setInterval(tick, 1000);', 1],
    ['async-Pfeil als Timer-Callback', 'setInterval(async () => { await x(); }, 1000);', 1],
    ['then als Anweisung', 'res.end(); p.then(() => write());', 1],
    ['else-Zweig', 'if (a) b(); else sendPush().catch(log);', 1],
    ['Express-Antwort daneben zaehlt nicht mit', 'res.status(201).send(x); sendPush(1);', 1],
  ];
  for (const [name, src, n] of faelle) {
    const hits = probe(src).filter((f) => !f.ok);
    assert.equal(hits.length, n, `${name}: ${JSON.stringify(hits)}`);
  }
});

test('Selbstprobe: verbraucht, gewickelt, tot oder im Text zaehlt nicht', () => {
  const faelle = [
    ['await', 'await sendPush();'],
    ['return', 'return sendPush().catch(log);'],
    ['Zuweisung', 'const p = sendPush().catch(log);'],
    ['Argument', 'await Promise.all([sendPush().catch(() => [])]);'],
    ['runExternalJob als Kopf', 'res.json({}); runExternalJob(() => sendPush(1)).catch(log);'],
    ['runExternalJob im Pfeilrumpf', 'defer(() => runExternalJob(() => sendPush()).catch(log));'],
    ['nachgewiesene Huelle', 'res.json({}); wrapped().catch(log);'],
    ['Timer mit gewickeltem Tick', 'setInterval(() => runExternalJob(tick).catch(log), 1000);'],
    ['Definition', 'async function sendPush() {}\nclass A { async tick() { return 1; } }'],
    ['Kommentar', '// sendPush().catch(log);\n/* tick(); */'],
    ['String', "log.info('sendPush().catch(log)');"],
  ];
  for (const [name, src] of faelle) {
    const hits = probe(src).filter((f) => !f.ok);
    assert.deepEqual(hits, [], name);
  }
});

test('Selbstprobe: ein toter Wrapper macht den ungewickelten Aufruf daneben nicht gruen', () => {
  const src = 'res.json({});\nif (false) runExternalJob(() => sendPush());\nsendPush(1).catch(log);';
  const hits = probe(src).filter((f) => !f.ok);
  assert.equal(hits.length, 1);
  assert.equal(hits[0].callee, 'sendPush');
});

test('Selbstprobe: eine gleichnamige Definition ohne Huelle hebt die Huelle auf', () => {
  const hits = probe('res.json({}); wrapped().catch(log);', 'export async function wrapped() { await x(); }')
    .filter((f) => !f.ok);
  assert.equal(hits.length, 1, 'zwei Definitionen von `wrapped`, eine davon ohne Job - der Aufruf ist nicht belegt');
});

// ---------------------------------------------------------------------------
// Der Guard ueber server/
// ---------------------------------------------------------------------------

test('#1532 jedes schwimmende Promise in server/ laeuft als Job oder steht begruendet in AUSNAHMEN', () => {
  const found = floatingPromises(serverSources());
  // Mindestmenge: der Guard muss die bekannten Stellen ueberhaupt sehen
  // (Scheduler, Sync-Takt, Kalender-Sofortversuche, Reset-Mail, Push).
  assert.ok(found.length >= 20, `der Scanner sieht nur ${found.length} Stellen - Korpus oder Scanner kaputt`);
  assert.ok(found.some((f) => f.file === 'server/routes/tasks.js' && /flushOutbound$/.test(f.callee)),
    'Selbstprobe: der CalDAV-Sofortversuch in tasks.js muss gesehen werden');

  const treffer = new Map();
  const offen = [];
  for (const f of found) {
    if (f.ok) continue;
    const key = `${f.file}|${f.callee}`;
    if (AUSNAHMEN.has(key)) {
      treffer.set(key, (treffer.get(key) ?? 0) + 1);
      continue;
    }
    offen.push(`${f.file}:${f.line} ${f.callee} (${f.form})`);
  }
  assert.deepEqual(offen, [], 'schwimmende Promises ohne runExternalJob() - der Restore sieht sie nicht (#1532). '
    + 'In runExternalJob() wickeln oder begruendet in AUSNAHMEN eintragen');

  const verwaist = [];
  for (const [key, { anzahl }] of AUSNAHMEN) {
    if ((treffer.get(key) ?? 0) !== anzahl) verwaist.push(`${key}: erwartet ${anzahl}, gefunden ${treffer.get(key) ?? 0}`);
  }
  assert.deepEqual(verwaist, [], 'AUSNAHMEN treffen nicht mehr wie angegeben');
});
