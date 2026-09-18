/**
 * Modul: Test-Infrastruktur - Suite-Registry-Guard
 * Zweck: Jede Suite läuft wirklich. Beim Docs-Audit 2026-08-05 lagen fünf
 *        Suiten mit test:-Script vor, hingen aber nicht in der npm-test-Kette
 *        und liefen damit monatelang weder lokal (npm test) noch in CI - eine
 *        davon war still verrottet. Dieser Guard schließt genau dieses Loch:
 *        (1) jedes test:*-Script hängt in der test-Kette, (2) jede
 *        test/test-*.{js,mjs}-Datei wird von einem Script referenziert.
 *        Beide Richtungen vergleichen an der WORTGRENZE: ein Teilstring-
 *        Vergleich hielt `test:search` drei Monate lang für eingehängt,
 *        weil `npm run test:search-index-duplicates` in der Kette stand.
 * Ausführen: node --test test/test-suite-chain.js
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
const chain = pkg.scripts.test;
test('fasting slices execute each owned suite exactly once', () => {
  for (const [script, file] of [
    ['test:health-fasting', 'test-health-fasting.js'],
    ['test:health-fasting', 'test-health-fasting-nav.js'],
    ['test:health-fasting', 'test-health-fasting-migration.js'],
    ['test:health-fasting', 'test-health-fasting-service.js'],
    ['test:health-fasting', 'test-health-fasting-api.js'],
    ['test:health-fasting', 'test-health-fasting-dates.js'],
  ]) {
    assert.ok(pkg.scripts[script], `${script} has its own entry point`);
    assert.ok(pkg.scripts[script].includes(`test/${file}`), `${file} belongs to ${script}`);
    assert.equal([...chain.matchAll(new RegExp(`npm run ${script}(?![\\w:.-])`, 'g'))].length, 1);
    assert.equal(Object.entries(pkg.scripts).filter(([name, command]) => name.startsWith('test:') && command.includes(`test/${file}`)).length, 1);
  }
});
const suiteScripts = Object.keys(pkg.scripts).filter((k) => k.startsWith('test:'));

const suiteFile = (name) => pkg.scripts[name].match(/test\/[\w.-]+\.js/)?.[0];

/**
 * Eine Suite braucht einen Browser, wenn ihre Datei ihn importiert.
 *
 * DAS IST DAS KRITERIUM, NICHT DER NAME. `npm test` geht nicht über Loopback
 * hinaus und braucht weder einen eigenen Serverprozess noch einen Browser: die
 * Suiten laufen gegen echtes SQLite, und wo sie Routen über HTTP prüfen, lauscht
 * der Server im Testprozess selbst auf einem lokalen Port. Eine Suite, die
 * einen echten Browser gegen einen eigenen Serverprozess fährt,
 * gehört dort nicht hinein - und eine Namensausnahme („außer
 * test:document-guards") wäre wieder eine Allowlist, die beim zweiten Fall
 * fehlt. Geprüft wird deshalb die Bauart der Datei.
 */
/**
 * Der Einstieg der Browser-Kette - ein NAME, und trotzdem keine Namensausnahme.
 *
 * Der Docblock darüber verbietet, eine Suite nach ihrem Namen der einen oder
 * anderen Kette zuzuordnen; das entscheidet `needsBrowser()` über die Bauart.
 * Dieses Script ist aber keine Suite, sondern die KETTE selbst - es kann nicht
 * in sich hängen, so wie `pkg.scripts.test` nicht in sich hängt. Deshalb steht
 * es hier einmal benannt und nicht in einer Liste, die wachsen könnte.
 */
const BROWSER_CHAIN = 'test:document-guards';

function needsBrowser(name) {
  const file = suiteFile(name);
  if (!file) return false;
  const src = readFileSync(new URL(`../${file}`, import.meta.url), 'utf8');
  // Die IMPORT-KANTE, nicht ein Textvorkommen: eine Datei, die den Namen des
  // Browsertreibers nur in einem Kommentar oder einem Regex nennt, fährt
  // keinen Browser. Diese Datei hier ist der erste Beweis dafür - eine
  // Textsuche hielt sie für ihre eigene Ausnahme.
  const imports = [...src.matchAll(/^\s*import[^;]*from\s*'([^']+)'/gm)].map((m) => m[1]);
  return imports.some((spec) => spec === 'puppeteer' || spec.includes('document-guards-harness'));
}

/**
 * Hängt `name` in `script`? An der WORTGRENZE, nicht als Teilstring.
 *
 * `script.includes('npm run test:search')` ist wahr, sobald irgendwo
 * `npm run test:search-diacritics` steht - der Präfix genügt. Genau so ist
 * `test:search` durch diesen Guard gerutscht: die Suite hing nirgends, lief
 * seit ihrer Entstehung weder lokal noch in CI, und der Guard meldete sie
 * grün, weil eine SCHWESTERSUITE mit längerem Namen in der Kette stand
 * (gemessen 2026-09-09, verdeckt durch `test:search-index-duplicates`).
 *
 * Das ist die teuerste Sorte Blindheit: nicht eine fehlende Regel, sondern
 * eine vorhandene, die die falsche Frage stellt. Ein Guard, der Namen
 * vergleicht, muss dort aufhoeren, wo der Name aufhoert - deshalb die
 * Lookaheads statt `includes()`.
 */
const nameEnd = '(?![\\w:.-])';
const fileEnd = '(?![\\w.-])';
const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

const runsIn = (script, name) => {
  if (new RegExp(`npm run ${escapeRe(name)}${nameEnd}`).test(script)) return true;
  const file = suiteFile(name);
  return Boolean(file && new RegExp(`${escapeRe(file)}${fileEnd}`).test(script));
};

test('jedes test:*-Script hängt in genau einer Kette', () => {
  // Die Kette ruft Suiten entweder als `npm run test:x` oder inlined sie als
  // direktes node-Kommando - dann genügt der Testdatei-Pfad als Nachweis.
  const wrong = [];
  for (const name of suiteScripts) {
    if (name === BROWSER_CHAIN) continue; // die Kette selbst, siehe oben
    const browser = needsBrowser(name);
    const inChain = runsIn(chain, name);
    if (browser && inChain) {
      wrong.push(`${name} fährt einen Browser und hängt trotzdem in npm test - dort ist kein Server`);
    }
    if (!browser && !inChain) {
      wrong.push(`${name} läuft nirgends - in die test-Kette einhängen (Schritt 3 in docs/test-suites.md)`);
    }
  }
  assert.deepEqual(wrong, [], wrong.join('\n  '));
});

test('die Browser-Suiten laufen unter test:document-guards', () => {
  const browserSuites = suiteScripts.filter((n) => n !== BROWSER_CHAIN && needsBrowser(n));
  const entry = pkg.scripts[BROWSER_CHAIN];
  assert.ok(entry, `${BROWSER_CHAIN} fehlt - die Browser-Kette braucht einen Einstieg.`);

  // REICHWEITE VOR DEM URTEIL. `browserSuites` ist heute LEER - es gibt genau
  // eine Suite mit Browserbedarf, und das ist die Kette selbst. Die Zusicherung
  // darunter laeuft damit ueber eine leere Liste und sagt fuer sich genommen
  // nichts. Was sie traegt, ist der Nachweis, dass das Kriterium ueberhaupt
  // greift: erkennt `needsBrowser()` den Einstieg nicht mehr, ist jede zweite
  // Browser-Suite unsichtbar geworden, und die leere Liste waere eine
  // Falschmeldung statt eines Befunds.
  assert.ok(needsBrowser(BROWSER_CHAIN),
    'needsBrowser() erkennt den Browserbedarf nicht mehr - ab hier prueft dieser Test nichts');
  const missing = browserSuites.filter((n) => !runsIn(entry, n));
  assert.deepEqual(
    missing,
    [],
    `Browser-Suiten ohne Einstieg - an test:document-guards anhängen: ${missing.join(', ')}`,
  );
});

/* `.mjs` ZAEHLT MIT - aber nur HIER, nicht in suiteFile().
 *
 * `.endsWith('.js')` ist auf `test-browser-loader.mjs` falsch: die letzten drei
 * Zeichen sind `mjs`. Eine kuenftige Suite als `.mjs` wäre damit unsichtbar,
 * und zwar lautlos - der Guard meldete sie nie an.
 *
 * Das Muster gehört trotzdem NICHT in `suiteFile()`. Einunddreißig Scripts
 * fahren ihre Suite über `--loader ./test/test-browser-loader.mjs`; ein
 * gemeinsames `\.m?js` träfe dort den LOADER statt der Testdatei und schickte
 * `needsBrowser()` in die falsche Datei. Deshalb ein eigenes Muster an genau
 * der Stelle, die es braucht. */
const TEST_FILE = /test\/[\w.-]+\.m?js/g;

test('jede test/test-*.{js,mjs}-Datei hat ein npm-Script', () => {
  const referenced = new Set(
    Object.values(pkg.scripts).flatMap((v) => [...v.matchAll(TEST_FILE)].map((m) => m[0])),
  );
  const orphans = readdirSync(new URL('../test', import.meta.url))
    .filter((f) => /^test-.*\.m?js$/.test(f))
    .filter((f) => !referenced.has(`test/${f}`));
  assert.deepEqual(
    orphans,
    [],
    `Testdateien ohne test:-Script - anlegen und in die Kette einhängen: ${orphans.join(', ')}`,
  );
});

/* EINE DATEI-DATENBANK IM TEMP-ORDNER IST EINE FALLE, WENN SIE LIEGEN BLEIBT.
 *
 * Neun Suiten legen ihre Datenbank als `<name>-${process.pid}.db` ab. Wer erst
 * am ENDE aufraeumt, raeumt genau dann nicht auf, wenn es zaehlt: bricht ein
 * Lauf ab, bleibt die Datei stehen. Betriebssysteme vergeben PIDs wieder, und
 * irgendwann oeffnet ein neuer Lauf die volle Datenbank eines alten - er
 * migriert sie, findet Bestandsdaten und scheitert an einem UNIQUE-Constraint,
 * den sein eigener Code nie verletzt haette.
 *
 * Gemessen am 2026-08-29: 182 verwaiste Dateien, aelteste vier Tage alt, und
 * ein roter Lauf, der isoliert nicht zu reproduzieren war. Das ist die teuerste
 * Sorte Fehlschlag - er zeigt auf die Aenderung, die gerade entsteht.
 *
 * Der Guard prueft die REIHENFOLGE-REGEL, nicht eine Liste von Dateinamen:
 * wer `DB_PATH` auf den Temp-Ordner setzt, tut das ueber `freshTestDbPath()`,
 * und die raeumt VOR dem Oeffnen weg. */
test('keine Suite baut ihren Temp-DB-Pfad von Hand zusammen', () => {
  const offenders = readdirSync(new URL('../test', import.meta.url))
    .filter((f) => f.startsWith('test-') && f.endsWith('.js'))
    .filter((f) => {
      const src = readFileSync(new URL(`../test/${f}`, import.meta.url), 'utf8');
      return /process\.env\.DB_PATH\s*=\s*path\.join\(os\.tmpdir\(\)/.test(src);
    });
  assert.deepEqual(
    offenders,
    [],
    'DB_PATH im Temp-Ordner gehoert ueber freshTestDbPath() aus test/tmp-db.js - '
    + `sonst erbt ein Lauf die Datei eines abgebrochenen mit derselben PID: ${offenders.join(', ')}`,
  );
});

/* EIN TESTSERVER LAUSCHT AUF LOOPBACK, NICHT AUF ALLEN INTERFACES.
 *
 * `listen(0)` ohne Host bindet an `::` bzw. `0.0.0.0` - der Server ist dann fuer
 * die Dauer der Suite aus dem lokalen Netz erreichbar. Die Route-Harnesse setzen
 * `req.authUserId` und `req.authRole` per Stub-Middleware, haeufig als `admin`:
 * wer im selben WLAN sitzt, haette waehrend des Laufs eine Admin-Sitzung ohne
 * Anmeldung gegen die Testdatenbank. Gemessen am 2026-09-15: 91 von 153
 * `listen()`-Aufrufen in 75 Dateien ohne Host.
 *
 * Mit Host bindet `listen()` ASYNCHRON: `server.address()` ist direkt danach
 * `null`, erst nach `'listening'` steht der Port fest. Ohne Host war das
 * synchron, und vier Aufrufe in test-changelog.js lebten davon - der Umbau
 * braucht deshalb dort ein `await` auf das Ereignis, nicht nur das Argument.
 *
 * DER GUARD SCHLIESST, WAS ER NICHT BEWEISEN KANN. Die erste Fassung suchte
 * die Portschreibweise per Regex und liess jeden Aufruf durch, auf den das
 * Muster nicht passte: ein berechneter Port (`PORT + 1`, `getPort()`,
 * `ports[0]`) war unsichtbar, sogar mit ausdruecklichem `'0.0.0.0'` (Review
 * auf #1223). Ein Nicht-Treffer darf nicht "in Ordnung" heissen. Deshalb liest
 * der Guard jeden Aufruf von `listen` im Code, und der besteht nur, wenn er
 * Loopback BELEGT: `'127.0.0.1'` als zweites Argument oder als `host` auf
 * oberster Ebene der Objektform, ohne Spread daneben (der koennte `host`
 * ueberschreiben). Alles andere ist rot, auch ein Aufruf ohne Argument.
 *
 * Als Aufruf zaehlt `.listen` auch mit Leerraum, Kommentar oder `?.` vor der
 * Klammer. Kommentare, Strings, Template- und Regex-Literale ueberspringt der
 * Leser, damit Prosa und Fixtures nicht zaehlen. Gelesen wird der ganze
 * test/-Baum, nicht nur seine oberste Ebene.
 *
 * WAS ER NICHT IST: ein Beweis ueber das Programm. Er liest die geschriebene
 * Form eines Aufrufs. Ein Alias (`server.listen.bind(server)`), ein berechneter
 * Name (`server['listen']`) oder ein Aufruf in einer `${...}`-Einbettung
 * bleiben unsichtbar; das saehe erst eine Laufzeitprobe auf
 * `net.Server.prototype.listen`. Er ist eine Stolperleine gegen den
 * naheliegenden Rueckfall, und der Selbsttest darunter nagelt auch seine
 * Grenze fest, damit sie nicht still wandert. */
const IDENT = /[\w$]/;
const REGEX_AFTER_WORD = new Set(['return', 'typeof', 'case', 'in', 'of', 'void', 'delete', 'throw', 'yield', 'await']);
const LOOPBACK_VALUE = /^(['"`])127\.0\.0\.1\1$/;
const HOST_ENTRY = /^(?:host|'host'|"host")\s*:\s*([\s\S]*)$/;

/** Index hinter dem schliessenden Anfuehrungszeichen eines String-Literals ab `at`. */
function endOfString(src, at) {
  const quote = src[at];
  let j = at + 1;
  while (j < src.length && src[j] !== quote) j += src[j] === '\\' ? 2 : 1;
  return j + 1;
}

/** Jeder Aufruf von `.listen(` im Code, mit Position und rohem Argumenttext. */
function listenCalls(src) {
  const calls = [];
  let prev = '';
  let word = '';
  let i = 0;
  while (i < src.length) {
    const c = src[i];
    if (c === '/' && src[i + 1] === '/') {
      const eol = src.indexOf('\n', i);
      i = eol < 0 ? src.length : eol;
    } else if (c === '/' && src[i + 1] === '*') {
      const end = src.indexOf('*/', i + 2);
      i = end < 0 ? src.length : end + 2;
    } else if (c === '\'' || c === '"' || c === '`') {
      i = endOfString(src, i);
      prev = 'x';
      word = '';
    } else if (c === '/' && (prev === '' || '(,=:[!&|?{};'.includes(prev) || REGEX_AFTER_WORD.has(word))) {
      let inClass = false;
      let j = i + 1;
      for (; j < src.length; j += 1) {
        if (src[j] === '\\') j += 1;
        else if (src[j] === '[') inClass = true;
        else if (src[j] === ']') inClass = false;
        else if (src[j] === '/' && !inClass) break;
      }
      i = j + 1;
      prev = 'x';
      word = '';
    } else if (c === '.') {
      // `.listen` gefolgt von einer Klammer - Leerraum, Kommentare und `?.`
      // dazwischen sind gueltiges JavaScript und aendern nichts am Aufruf.
      const name = skipTrivia(src, i + 1);
      const afterName = name + 'listen'.length;
      let open = src.startsWith('listen', name) && !IDENT.test(src[afterName] ?? '')
        ? skipTrivia(src, afterName)
        : -1;
      if (open >= 0 && src.startsWith('?.', open)) open = skipTrivia(src, open + 2);
      if (open >= 0 && src[open] === '(') {
        const close = matchingParen(src, open);
        calls.push({ index: i, args: src.slice(open + 1, close) });
        i = open + 1;
        prev = '(';
      } else {
        i += 1;
        prev = '.';
      }
      word = '';
    } else {
      if (IDENT.test(c)) word = (IDENT.test(src[i - 1] ?? '') ? word : '') + c;
      else if (!/\s/.test(c)) word = '';
      if (!/\s/.test(c)) prev = IDENT.test(c) ? 'x' : c;
      i += 1;
    }
  }
  return calls;
}

/** Index des naechsten Zeichens ab `at`, das weder Leerraum noch Kommentar ist. */
function skipTrivia(src, at) {
  let j = at;
  for (;;) {
    while (j < src.length && /\s/.test(src[j])) j += 1;
    if (src.startsWith('//', j)) {
      const eol = src.indexOf('\n', j);
      j = eol < 0 ? src.length : eol;
    } else if (src.startsWith('/*', j)) {
      const end = src.indexOf('*/', j + 2);
      j = end < 0 ? src.length : end + 2;
    } else {
      return j;
    }
  }
}

/** Index der schliessenden Klammer zu `src[open]`, Strings und Kommentare uebersprungen. */
function matchingParen(src, open) {
  let depth = 0;
  let j = open;
  while (j < src.length) {
    const d = src[j];
    if (d === '\'' || d === '"' || d === '`') { j = endOfString(src, j); continue; }
    if (src.startsWith('//', j) || src.startsWith('/*', j)) { j = skipTrivia(src, j); continue; }
    if ('([{'.includes(d)) depth += 1;
    else if (')]}'.includes(d) && --depth === 0) return j;
    j += 1;
  }
  return src.length;
}

/** Die Argumente auf oberster Ebene, an Kommas ausserhalb von Klammern und Strings getrennt. */
function topLevelArgs(text) {
  const args = [];
  let depth = 0;
  let from = 0;
  for (let j = 0; j < text.length; j += 1) {
    const d = text[j];
    if (d === '\'' || d === '"' || d === '`') { j = endOfString(text, j) - 1; continue; }
    if ('([{'.includes(d)) depth += 1;
    else if (')]}'.includes(d)) depth -= 1;
    else if (d === ',' && depth === 0) { args.push(text.slice(from, j).trim()); from = j + 1; }
  }
  const last = text.slice(from).trim();
  if (last) args.push(last);
  return args;
}

/** Der Text ohne Kommentare; Strings bleiben unangetastet, auch wenn `//` darin steht. */
function withoutComments(text) {
  let out = '';
  let j = 0;
  while (j < text.length) {
    if (text[j] === '\'' || text[j] === '"' || text[j] === '`') {
      const end = endOfString(text, j);
      out += text.slice(j, end);
      j = end;
    } else if (text.startsWith('//', j) || text.startsWith('/*', j)) {
      j = skipTrivia(text, j);
      out += ' ';
    } else {
      out += text[j];
      j += 1;
    }
  }
  return out;
}

function bindsLoopback(argsText) {
  const [first = '', second = ''] = topLevelArgs(withoutComments(argsText));
  if (LOOPBACK_VALUE.test(second)) return true;
  if (!(first.startsWith('{') && first.endsWith('}'))) return false;
  const entries = topLevelArgs(first.slice(1, -1));
  // Ein Spread kann `host` ueberschreiben, egal wo er steht - dann belegt nichts Loopback.
  if (entries.some((entry) => entry.startsWith('...'))) return false;
  // Nur Eintraege DIESER Ebene zaehlen, ein verschachteltes `host` ist keiner.
  // Bei doppeltem Schluessel gewinnt der letzte, wie in JavaScript selbst.
  const hosts = entries.map((entry) => entry.match(HOST_ENTRY)).filter(Boolean);
  return hosts.length > 0 && LOOPBACK_VALUE.test(hosts.at(-1)[1].trim());
}

/** Jede .js/.mjs unter `dirUrl`, auch in Unterordnern (test/integration/ waere sonst unsichtbar). */
function jsFilesBelow(dirUrl) {
  return readdirSync(dirUrl, { withFileTypes: true }).flatMap((entry) => {
    if (entry.name === 'node_modules') return [];
    if (entry.isDirectory()) return jsFilesBelow(new URL(`${entry.name}/`, dirUrl));
    return /\.m?js$/.test(entry.name) ? [new URL(entry.name, dirUrl)] : [];
  });
}

test('kein Testserver lauscht auf allen Interfaces', () => {
  const root = new URL('../test/', import.meta.url);
  const offenders = jsFilesBelow(root).flatMap((url) => {
    const src = readFileSync(url, 'utf8');
    return listenCalls(src)
      .filter((call) => !bindsLoopback(call.args))
      .map((call) => `${url.href.slice(root.href.length)}:${src.slice(0, call.index).split('\n').length}`);
  });
  assert.deepEqual(
    offenders,
    [],
    `listen() ohne belegten Loopback-Host - '127.0.0.1' als zweites Argument: ${offenders.join(', ')}`,
  );
});

test('der Guard liest auch Unterordner von test/', () => {
  const dir = mkdtempSync(join(tmpdir(), 'yuvomi-listen-walk-'));
  try {
    mkdirSync(join(dir, 'integration'));
    writeFileSync(join(dir, 'integration', 'deep.js'), 'server.listen(0);\n');
    const found = jsFilesBelow(pathToFileURL(`${dir}/`)).map((url) => url.href);
    assert.ok(found.some((href) => href.endsWith('/integration/deep.js')), found.join(', '));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('der Loopback-Leser urteilt ueber den Aufruf, nicht ueber eine Schreibweise', () => {
  const verdicts = (src) => listenCalls(src).map((call) => bindsLoopback(call.args));
  // Rot: alles, was Loopback nicht belegt - auch berechnete Ports.
  for (const src of [
    'server.listen(0);',
    'server.listen(PORT + 1);',
    'server.listen(getPort());',
    'server.listen(ports[0]);',
    "server.listen(PORT + 1, '0.0.0.0');",
    'server.listen(0, cb);',
    'server.listen();',
    'server.listen({ port: 0 });',
    "server.listen({ port: 0, host: '0.0.0.0' });",
    // Objektform: nur ein `host` dieser Ebene zaehlt, und kein Spread darf ihn ueberschreiben.
    "server.listen({ port: 0, nested: { host: '127.0.0.1' } });",
    "server.listen({ host: '127.0.0.1', ...networkOptions });",
    "server.listen({ ...defaults, host: '127.0.0.1' });",
    'server.listen({ port, host });',
    // Gueltige Aufrufsyntax jenseits von `.listen(`.
    'server.listen /* reason */ (0);',
    'server.listen?.(0);',
    'server . listen\n  (0);',
    'server?.listen(0);',
  ]) assert.deepEqual(verdicts(src), [false], src);
  // Gruen: Loopback belegt, auch mehrzeilig und mit Klammern in Callback und String.
  for (const src of [
    "server.listen(0, '127.0.0.1');",
    'app.listen(getPort(), "127.0.0.1", () => resolve({ port: s.address().port }));',
    "server.listen(\n  0,\n  '127.0.0.1',\n  () => log(')'),\n);",
    "server.listen({ port: 0, host: '127.0.0.1' }, cb);",
    "server.listen?.(0, /* loopback */ '127.0.0.1');",
  ]) assert.deepEqual(verdicts(src), [true], src);
  // Unsichtbar: Prosa, Strings, Templates, Regex-Literale und blosse Eigenschaften zaehlen nicht.
  for (const src of [
    '// server.listen(0)',
    '/* server.listen(0) */',
    "const s = 'server.listen(0)';",
    'const t = `server.listen(0)`;',
    'const re = /server.listen(0)/;',
    'return /server.listen(0)/.test(x);',
    'if (!server.listening) await ready;',
  ]) assert.deepEqual(verdicts(src), [], src);
  // BEKANNTE GRENZE, festgenagelt statt verschwiegen: ein Alias ist fuer den
  // Leser kein Aufruf. Wird er klueger, wird dieser Fall rot und gehoert umgehaengt.
  assert.deepEqual(verdicts('const l = server.listen.bind(server); l(0);'), []);
});

/* EINE SUITE, DIE NIRGENDS BESCHRIEBEN IST, HAELT EINE INVARIANTE, DIE NIEMAND KENNT.
 *
 * `docs/test-suites.md` ist die eine Stelle, an der steht, welche Suite welche
 * Invariante deckt - CLAUDE.md verweist dafuer auf sie. Der Guard darueber haelt
 * fest, dass jede Suite LAEUFT; dass sie auch ERKLAERT ist, hielt bisher nichts.
 * Gemessen am 2026-09-18: zwei Suiten aus den zwei Tagen davor
 * (`test:reminder-orphans`, `test:task-reminder-after-due`) standen in der Kette,
 * aber in keiner Zeile der Doku. Der Ausfall ist still und einseitig: die Suite
 * ist gruen, nur ihr Grund fehlt, und der naechste, der ihren Fall aufraeumt,
 * findet keinen Satz, der ihm widerspricht.
 *
 * Geprueft wird der Aufruf, wie die Doku ihn schreibt (`npm run test:x`), an
 * DERSELBEN Wortgrenze wie in der Kette - ein Teilstring haelt `test:tasks`
 * fuer beschrieben, sobald `npm run test:tasks-routes` irgendwo steht. Die
 * Browser-Kette zaehlt mit: sie ist zwar keine Suite, hat aber ihren eigenen
 * Abschnitt und wird von Hand gefahren, also braucht gerade sie die Erklaerung. */
const SUITE_DOC = new URL('../docs/test-suites.md', import.meta.url);

test('jede Suite steht in docs/test-suites.md', () => {
  const doc = readFileSync(SUITE_DOC, 'utf8');
  const undocumented = suiteScripts.filter(
    (name) => !new RegExp(`npm run ${escapeRe(name)}${nameEnd}`).test(doc),
  );
  assert.deepEqual(
    undocumented,
    [],
    'Suiten ohne Zeile in docs/test-suites.md - eintragen, was sie deckt: '
    + `${undocumented.join(', ')}`,
  );
});

test('der Doku-Guard liest an der Wortgrenze, nicht als Teilstring', () => {
  // REICHWEITE VOR DEM URTEIL, wie beim Browser-Nachweis darueber: die Liste
  // oben ist LEER, sobald die Doku vollstaendig ist, und sagt dann fuer sich
  // genommen nichts. Was sie traegt, ist der Nachweis, dass das Kriterium
  // ueberhaupt unterscheidet - eine Schwestersuite mit laengerem Namen darf
  // eine kuerzere nicht mitdecken.
  const documented = (doc, name) => new RegExp(`npm run ${escapeRe(name)}${nameEnd}`).test(doc);
  assert.equal(documented('npm run test:tasks-routes  # ...', 'test:tasks'), false);
  assert.equal(documented('npm run test:tasks  # ...', 'test:tasks'), true);
  assert.equal(documented('npm run test:tasks\n', 'test:tasks'), true);
});
