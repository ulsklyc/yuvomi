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
 * Zweiter Teil weiter unten (#1551): GET-Routen, die nach einem `await`
 * schreiben, tragen `refuseWhileRestoring`.
 *
 * Lauf: npm run test:after-response-jobs
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative, posix } from 'node:path';
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

// ===========================================================================
// #1551: GET-Anfragen, die nach einem await schreiben
// ===========================================================================
//
// Der Restore wartet auf schreibende Anfragen, GET zaehlt nicht dazu
// (`trackAdmittedWrite` laesst lesende Methoden durch). Manche GET-Anfragen
// schreiben aber, nachdem sie auf etwas gewartet haben: der `tokens`-Listener
// des Google-Clients speichert ein erneuertes Token, sobald eine Anfrage Google
// erreicht; die Kalenderliste von Outlook und CalDAV wird nach dem Abruf neu
// geschrieben; der Wechselkurs-Cache nach dem Abruf bei Fixer. Faellt ein
// Restore in dieses Warten, landet die Schreibung in der gesperrten,
// geschlossenen oder schon eingespielten Datenbank. Solche Routen tragen
// `refuseWhileRestoring` (server/middleware/restore-gate.js): waehrend eines
// Restores 503, sonst festgehalten wie eine schreibende Anfrage.
//
// Der Guard baut einen Aufrufgraphen ueber server/, aufgeloest ueber die
// Importe (`import * as ns`, `import { a as b }`, `export { x } from`) und
// Aufrufe in derselben Datei - nicht ueber blosse Namen, die kollidieren
// (`get`, `set`, `send`). Schreiber: eine Funktion mit `.run(`/`db.exec(` oder
// einem Aufruf eines Schreibers. SPAET schreibt eine Funktion, wenn
//   - nach dem ersten `await` (hinter dessen Operand) ein Schreiber folgt,
//   - ein Rueckruf an `.on`/`.once`/`.then`/`.catch`/`.finally` oder an einen
//     Timer schreibt (der `tokens`-Listener),
//   - oder sie eine spaet schreibende Funktion ruft.
// Was in `runExternalJob(...)`/`runSerialized(...)` steht, zaehlt nicht: der
// Restore wartet den Job ab, und waehrend eines Restores beginnt er nicht.
//
// Jede GET-Route, deren Handler spaet schreibt, traegt `refuseWhileRestoring`
// oder steht begruendet in SPAET_OHNE_RIEGEL. Weil der Graph Aufrufe ueber
// Objekte aus Fabriken (DMS- und Rezept-Adapter, Clients) nicht aufloest, gilt
// zusaetzlich eine Allowlist: jede GET-Route mit `await` ohne Riegel und ohne
// gefundene Schreibung steht mit Grund in LESEN_NACH_AWAIT. Eine NEUE solche
// Route ist rot, bis jemand entschieden hat, ob sie schreibt.

/** GET-Routen, die spaet schreiben und bewusst keinen Riegel tragen. Schluessel `datei|pfad`. */
const SPAET_OHNE_RIEGEL = new Map([
  ['server/routes/backup.js|/database', 'Backup-Download: `backupToFile` zaehlt als laufendes Backup (`activeBackups` in server/db.js), '
    + 'der Restore wartet es ab; `VACUUM INTO` schreibt in eine neue Datei, nicht in die Datenbank'],
]);

/** GET-Routen mit `await`, ohne Riegel, die nach dem Warten nichts in die Datenbank schreiben. */
const LESEN_NACH_AWAIT = new Map([
  ['server/routes/backup.js|/webdav/files', 'listet die Dateien auf dem WebDAV-Server, schreibt nichts'],
  ['server/routes/cardav.js|/accounts', 'liest die Konten, der Aufruf ist synchron'],
  ['server/routes/changelog.js|/', 'GitHub-Releases, Cache im Speicher'],
  ['server/routes/dms.js|/search', 'DMS-Adapter (Paperless, Papra) ohne Datenbank'],
  ['server/routes/dms.js|/thumbnail', 'DMS-Adapter ohne Datenbank'],
  ['server/routes/documents.js|/:id/thumbnail', 'Vorschaubild nur fuer DMS-Dokumente, DMS-Adapter ohne Datenbank'],
  ['server/routes/modules.js|/', 'Erweiterungen aus dem Dateisystem'],
  ['server/routes/modules.js|/assets/:id/{*assetPath}', 'Datei einer Erweiterung aus dem Dateisystem'],
  ['server/routes/permissions.js|/catalog', 'Erweiterungen aus dem Dateisystem'],
  ['server/routes/preferences.js|/holidays/countries', 'Feiertags-API, ohne Cache in der Datenbank'],
  ['server/routes/preferences.js|/holidays/subdivisions/:countryCode', 'Feiertags-API, ohne Cache in der Datenbank'],
  ['server/routes/preferences.js|/holidays/groups/:countryCode', 'Feiertags-API, ohne Cache in der Datenbank'],
  ['server/routes/preferences.js|/holidays/groups/:countryCode/:subdivisionCode', 'Feiertags-API, ohne Cache in der Datenbank'],
  ['server/routes/recipes.js|/:id/provider-thumbnail', 'Rezept-Adapter (Mealie, Tandoor) ohne Datenbank'],
  ['server/routes/screensaver.js|/photos', 'Immich-Abruf, Cache im Speicher'],
  ['server/routes/screensaver.js|/photos/:id', 'Immich-Abruf, Cache im Speicher'],
  ['server/routes/weather.js|/', 'Wetter-API, Cache im Speicher'],
  ['server/routes/weather.js|/icon/:code', 'Wetter-Icon, Cache im Speicher'],
]);

const SCHLUESSELWORT = new Set([
  'if', 'for', 'while', 'switch', 'catch', 'function', 'return', 'typeof', 'await', 'new', 'super', 'import',
  'export', 'do', 'else', 'try', 'with', 'yield', 'delete', 'void', 'in', 'of', 'instanceof', 'case', 'throw',
]);
const DB_SCHREIBT = /\.\s*run\s*\(|(?:\bdb|\bdatabase|\bconn|\))\s*\.\s*exec\s*\(/;
const RUECKRUF = /(?:\.\s*(?:on|once|then|catch|finally)\s*(?:\?\.\s*)?|(?<![\w$.])(?:setTimeout|setInterval|setImmediate|queueMicrotask|process\.nextTick)\s*)\(/g;

/** Ende eines Pfeilrumpfs ohne Block: bis `;` oder `,` auf Tiefe 0 oder die schliessende Klammer. */
function ausdrucksEnde(code, i) {
  let depth = 0;
  for (; i < code.length; i++) {
    const c = code[i];
    if ('([{'.includes(c)) depth++;
    else if (')]}'.includes(c)) { if (--depth < 0) return i; }
    else if ((c === ';' || c === ',') && depth === 0) return i;
  }
  return i;
}

/** Die Argumente von `runExternalJob(...)`/`runSerialized(...)` leeren: der Restore sieht diese Arbeit. */
function ohneJobs(text) {
  let out = text;
  for (const m of text.matchAll(/(?<![\w$.])(?:runExternalJob|runSerialized)\s*\(/g)) {
    const open = m.index + m[0].length - 1;
    const end = closerOf(text, open);
    out = out.slice(0, open + 1) + ' '.repeat(Math.max(0, end - open - 2)) + out.slice(end - 1);
  }
  return out;
}

/** Der Text hinter dem ersten `await` samt seinem Operanden - erst dort hat die Funktion nachgegeben. */
function nachDemErstenAwait(text) {
  const m = text.match(/(?<![\w$])await\b\s*/);
  if (!m) return null;
  let i = m.index + m[0].length;
  const start = i;
  for (;;) {
    const rest = text.slice(i);
    const name = rest.match(/^\s*(?:\?\.\s*|\.\s*)?#?[A-Za-z_$][\w$]*/);
    if (name && (i === start || /^\s*\??\./.test(rest))) { i += name[0].length; continue; }
    const group = rest.match(/^\s*(?:\?\.\s*)?[([]/);
    if (group) { i = closerOf(text, i + group[0].length - 1); continue; }
    return text.slice(i);
  }
}

/**
 * Spaet schreibende Funktionen und GET-Routen in `files` (Map datei ->
 * `{ code, raw }`: ohne Kommentare, `code` zusaetzlich ohne Literale).
 */
export function lateWrites(files) {
  const defs = new Map(); // datei|name -> [{ file, body }]
  const imports = new Map(); // datei -> { ns, named }
  const reexports = new Map(); // datei -> name -> [datei, name]
  const resolveSpec = (file, spec) => {
    if (!spec.startsWith('.')) return null;
    const target = posix.normalize(posix.join(posix.dirname(file), spec));
    return files.has(target) ? target : null;
  };
  const addDef = (file, name, start, end) => {
    const key = `${file}|${name}`;
    if (!defs.has(key)) defs.set(key, []);
    defs.get(key).push({ file, start, end });
  };
  for (const [file, { code, raw }] of files) {
    // Rumpf ab der Parameterliste: ein Standardwert (`client = loadAuthorizedClient()`) gehoert dazu.
    for (const m of code.matchAll(/(?<![\w$.])(?:async\s+)?function\s*\*?\s*([A-Za-z_$][\w$]*)\s*\(/g)) {
      const open = m.index + m[0].length - 1;
      addDef(file, m[1], open, closerOf(code, code.indexOf('{', closerOf(code, open))));
    }
    for (const m of code.matchAll(/(?<![\w$.])(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:async\b)?\s*(?:\([^)]*\)|[A-Za-z_$][\w$]*)\s*=>\s*/g)) {
      const s = m.index + m[0].length;
      addDef(file, m[1], m.index, code[s] === '{' ? closerOf(code, s) : ausdrucksEnde(code, s));
    }
    for (const m of code.matchAll(/^[ \t]*(?:static\s+)?(?:async\s+)?(#?[A-Za-z_$][\w$]*)\s*\(/gm)) {
      const name = m[1].replace(/^#/, '');
      if (SCHLUESSELWORT.has(name)) continue;
      const open = m.index + m[0].length - 1;
      const close = closerOf(code, open);
      const brace = code.slice(close).match(/^\s*\{/);
      if (brace) addDef(file, name, open, closerOf(code, close + brace[0].length - 1));
    }
    const ns = new Map();
    const named = new Map();
    for (const m of raw.matchAll(/(?<![\w$.])import\s+([^'";]*?)\s*from\s*['"]([^'"]+)['"]/g)) {
      const target = resolveSpec(file, m[2]);
      if (!target) continue;
      const star = m[1].match(/\*\s+as\s+([\w$]+)/);
      if (star) ns.set(star[1], target);
      const standard = m[1].match(/^([\w$]+)\s*(?:,|$)/);
      if (standard) ns.set(standard[1], target);
      const braces = m[1].match(/\{([^}]*)\}/);
      for (const part of braces ? braces[1].split(',') : []) {
        const [orig, local] = part.trim().split(/\s+as\s+/);
        if (orig) named.set((local || orig).trim(), [target, orig.trim()]);
      }
    }
    const rex = new Map();
    for (const m of raw.matchAll(/(?<![\w$.])export\s*\{([^}]*)\}\s*from\s*['"]([^'"]+)['"]/g)) {
      const target = resolveSpec(file, m[2]);
      for (const part of target ? m[1].split(',') : []) {
        const [orig, local] = part.trim().split(/\s+as\s+/);
        if (orig) rex.set((local || orig).trim(), [target, orig.trim()]);
      }
    }
    imports.set(file, { ns, named });
    reexports.set(file, rex);
  }
  const keyOf = (file, name, depth = 0) => {
    const key = `${file}|${name}`;
    if (defs.has(key)) return key;
    const via = reexports.get(file)?.get(name);
    return via && depth < 5 ? keyOf(via[0], via[1], depth + 1) : null;
  };
  const resolveName = (file, name) => {
    const local = keyOf(file, name);
    if (local) return local;
    const imported = imports.get(file).named.get(name);
    return imported ? keyOf(imported[0], imported[1]) : null;
  };
  // Aufrufe in `text`, aufgeloest: `f()`, `this.f()`, `ns.f()`. Andere Objekte bleiben offen.
  const callsIn = (file, text) => {
    const out = [];
    for (const m of text.matchAll(/(?<![\w$#.])(?:([A-Za-z_$][\w$]*)\s*\??\.\s*)?(#?[A-Za-z_$][\w$]*)\s*\(/g)) {
      const name = m[2].replace(/^#/, '');
      if (SCHLUESSELWORT.has(name)) continue;
      const obj = m[1];
      let key = null;
      if (!obj) key = resolveName(file, name);
      else if (obj === 'this') key = keyOf(file, name);
      else if (imports.get(file).ns.has(obj)) key = keyOf(imports.get(file).ns.get(obj), name);
      if (key) out.push(key);
    }
    return out;
  };
  for (const list of defs.values()) {
    for (const d of list) d.body = ohneJobs(files.get(d.file).code.slice(d.start, d.end));
  }

  const writers = new Set();
  const writesIn = (file, text) => {
    if (DB_SCHREIBT.test(text)) return 'direkt';
    return callsIn(file, text).find((key) => writers.has(key)) ?? null;
  };
  for (let changed = true; changed;) {
    changed = false;
    for (const [key, list] of defs) {
      if (!writers.has(key) && list.some((d) => writesIn(d.file, d.body))) { writers.add(key); changed = true; }
    }
  }

  const late = new Map();
  const lateIn = (file, text) => {
    const rest = nachDemErstenAwait(text);
    const afterAwait = rest === null ? null : writesIn(file, rest);
    if (afterAwait) return `schreibt nach await (${afterAwait})`;
    for (const m of text.matchAll(RUECKRUF)) {
      const open = m.index + m[0].length - 1;
      const inCallback = writesIn(file, text.slice(open, closerOf(text, open)));
      if (inCallback) return `Rueckruf ${m[0].replace(/\s/g, '')} schreibt (${inCallback})`;
    }
    const callee = callsIn(file, text).find((key) => late.has(key));
    return callee ? `ruft ${callee}` : null;
  };
  for (let changed = true; changed;) {
    changed = false;
    for (const [key, list] of defs) {
      if (late.has(key)) continue;
      for (const d of list) {
        const why = lateIn(d.file, d.body);
        if (why) { late.set(key, why); changed = true; break; }
      }
    }
  }

  const routes = [];
  for (const [file, { code, raw }] of files) {
    for (const m of code.matchAll(/(?<![\w$])[A-Za-z_$][\w$]*\s*\.\s*get\s*\(/g)) {
      const open = m.index + m[0].length - 1;
      const first = raw.slice(open + 1).trimStart();
      if (!/^['"`[]/.test(first)) continue;
      const args = code.slice(open + 1, closerOf(code, open) - 1);
      if (!args.includes(',')) continue; // `map.get('x')`, kein Handler
      const path = first.startsWith('[') ? first.slice(0, first.indexOf(']') + 1) : first.match(/^(['"`])(.*?)\1/)?.[2];
      const text = ohneJobs(args);
      // Handler, die als Name uebergeben werden, gehoeren mit zum Text.
      const handlers = [...text.matchAll(/(?<![\w$.])([A-Za-z_$][\w$]*)\s*(?=,|$)/g)]
        .map((h) => resolveName(file, h[1])).filter(Boolean);
      let why = lateIn(file, text);
      if (!why) {
        const handler = handlers.find((key) => late.has(key));
        if (handler) why = `Handler ${handler}`;
      }
      routes.push({
        file,
        line: code.slice(0, m.index).split('\n').length,
        path,
        guarded: /(?<![\w$.])refuseWhileRestoring(?![\w$])/.test(args),
        why,
        awaits: /(?<![\w$])await\b/.test(text)
          || handlers.some((key) => defs.get(key).some((d) => /(?<![\w$])await\b/.test(d.body))),
      });
    }
  }
  return { late, routes };
}

function serverFiles() {
  const files = new Map();
  for (const full of jsFiles(SERVER)) {
    const file = relative(ROOT, full).split('\\').join('/');
    const src = readFileSync(full, 'utf8');
    files.set(file, {
      code: withoutCommentsKeepingLines(src, { blankLiterals: true }),
      raw: withoutCommentsKeepingLines(src),
    });
  }
  return files;
}

function probeFiles(entries) {
  return new Map(Object.entries(entries).map(([file, src]) => [file, {
    code: withoutCommentsKeepingLines(src, { blankLiterals: true }),
    raw: withoutCommentsKeepingLines(src),
  }]));
}

const PROBE_DIENST = `
  import * as db from '../db.js';
  function cfgSet(k, v) { db.get().prepare('INSERT INTO t VALUES (?, ?)').run(k, v); }
  function loadClient() {
    const client = createClient();
    client.on('tokens', (tokens) => { cfgSet('token', tokens.access_token); });
    return client;
  }
  export async function listRemote() { return (await loadClient().list()).items; }
  export async function refreshList() { const items = await fetchItems(); cfgSet('items', items); return items; }
  export async function readOnly() { const items = await fetchItems(); return items.map((i) => i.id); }
  export async function writeFirst() { cfgSet('seen', 1); return fetchItems(); }
  export async function awaitWriter() { await cfgSet('x', 1); return 1; }
  export function asJob() { return runExternalJob(() => refreshList()); }
`;

function probeRoutes(route, dienst = PROBE_DIENST) {
  const files = probeFiles({
    'server/services/dienst.js': dienst,
    'server/routes/probe.js': `
      import * as dienst from '../services/dienst.js';
      import { refreshList as neu } from '../services/dienst.js';
      import { refuseWhileRestoring } from '../middleware/restore-gate.js';
      ${route}
    `,
  });
  return lateWrites(files).routes.filter((r) => r.file === 'server/routes/probe.js');
}

test('#1551 Selbstprobe: GET-Routen, die nach einem await schreiben, werden gesehen', () => {
  const faelle = [
    ['tokens-Listener ueber einen Namensraum-Import', "router.get('/a', async (req, res) => { res.json(await dienst.listRemote()); });"],
    ['Schreiben nach dem Abruf ueber einen umbenannten Import', "router.get('/b', async (req, res) => { res.json(await neu()); });"],
    ['Handler als Name', "async function handler(req, res) { res.json(await dienst.refreshList()); }\nrouter.get('/c', handler);"],
    ['ohne await, mit then', "router.get('/d', (req, res) => { dienst.refreshList().then((x) => res.json(x)); });"],
    ['ueber mehrere Zeilen', "router.get(\n  '/e',\n  requireAdmin,\n  async (req, res) => {\n    const x = await dienst.refreshList();\n    res.json(x);\n  },\n);"],
  ];
  for (const [name, src] of faelle) {
    const [route] = probeRoutes(src);
    assert.ok(route?.why, `${name}: ${JSON.stringify(route)}`);
    assert.equal(route.guarded, false, name);
  }
});

test('#1551 Selbstprobe: Lesen, Schreiben vor dem Warten, Jobs und Riegel zaehlen nicht als offen', () => {
  const ohneBefund = [
    ['nur lesen nach dem Warten', "router.get('/a', async (req, res) => { res.json(await dienst.readOnly()); });"],
    ['schreibt vor dem ersten await', "router.get('/b', async (req, res) => { res.json(await dienst.writeFirst()); });"],
    ['await auf einen synchronen Schreiber', "router.get('/c', async (req, res) => { res.json(await dienst.awaitWriter()); });"],
    ['als Job', "router.get('/d', async (req, res) => { res.json(await dienst.asJob()); });"],
    ['im Kommentar', "router.get('/e', async (req, res) => {\n  // await dienst.refreshList();\n  res.json(await dienst.readOnly());\n});"],
    ['im String', "router.get('/f', async (req, res) => { log.info('await dienst.refreshList()'); res.json(await dienst.readOnly()); });"],
  ];
  for (const [name, src] of ohneBefund) {
    const [route] = probeRoutes(src);
    assert.ok(route, `${name}: Route nicht gefunden`);
    assert.equal(route.why, null, `${name}: ${route.why}`);
  }
  const [mitRiegel] = probeRoutes("router.get('/g', requireAdmin, refuseWhileRestoring, async (req, res) => { res.json(await dienst.listRemote()); });");
  assert.ok(mitRiegel.why, 'Vorbedingung: die Route schreibt spaet');
  assert.equal(mitRiegel.guarded, true, 'refuseWhileRestoring wird erkannt');
  const [totgelegt] = probeRoutes("router.get('/h', /* refuseWhileRestoring, */ async (req, res) => { res.json(await dienst.listRemote()); });");
  assert.equal(totgelegt.guarded, false, 'ein auskommentierter Riegel zaehlt nicht');
});

test('#1551 Selbstprobe: ein Listener, der nicht schreibt, macht nichts spaet', () => {
  const dienst = PROBE_DIENST.replace("client.on('tokens', (tokens) => { cfgSet('token', tokens.access_token); });",
    "client.on('tokens', (tokens) => { log.info(tokens.expiry_date); });");
  const [route] = probeRoutes("router.get('/a', async (req, res) => { res.json(await dienst.listRemote()); });", dienst);
  assert.equal(route.why, null);
});

test('#1551 jede GET-Route, die nach einem await schreibt, traegt refuseWhileRestoring', () => {
  const { late, routes } = lateWrites(serverFiles());
  // Mindestmenge: die beiden tokens-Listener aus dem Issue muessen gesehen werden.
  assert.match(late.get('server/services/google-calendar.js|loadAuthorizedClient') ?? '', /Rueckruf \.on\(/,
    'Selbstprobe: der tokens-Listener des Kalenders');
  assert.match(late.get('server/services/google-drive-storage.js|attachTokenPersistence') ?? '', /Rueckruf \.on\?\.\(/,
    'Selbstprobe: der tokens-Listener von Google Drive');
  assert.ok(routes.length >= 200, `nur ${routes.length} GET-Routen gefunden - Scanner kaputt`);

  const offen = [];
  const gesehen = new Set();
  for (const r of routes) {
    const key = `${r.file}|${r.path}`;
    if (r.guarded) continue;
    if (r.why) {
      if (SPAET_OHNE_RIEGEL.has(key)) gesehen.add(key);
      else offen.push(`${r.file}:${r.line} GET ${r.path} - ${r.why}`);
    } else if (r.awaits) {
      if (LESEN_NACH_AWAIT.has(key)) gesehen.add(key);
      else offen.push(`${r.file}:${r.line} GET ${r.path} - wartet, ohne Riegel und ohne Eintrag in LESEN_NACH_AWAIT`);
    }
  }
  assert.deepEqual(offen, [], 'GET-Routen, die nach einem await schreiben (koennen): refuseWhileRestoring vor den Handler '
    + '(#1551) - oder, wenn sie nach dem Warten nichts schreiben, begruendet in LESEN_NACH_AWAIT');
  const verwaist = [...SPAET_OHNE_RIEGEL.keys(), ...LESEN_NACH_AWAIT.keys()].filter((key) => !gesehen.has(key));
  assert.deepEqual(verwaist, [], 'Eintraege, die keine offene Route mehr treffen');
});
