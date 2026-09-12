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
import { readFileSync, readdirSync } from 'node:fs';

const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
const chain = pkg.scripts.test;
const suiteScripts = Object.keys(pkg.scripts).filter((k) => k.startsWith('test:'));

const suiteFile = (name) => pkg.scripts[name].match(/test\/[\w.-]+\.js/)?.[0];

/**
 * Eine Suite braucht einen Browser, wenn ihre Datei ihn importiert.
 *
 * DAS IST DAS KRITERIUM, NICHT DER NAME. `npm test` ist netzfrei und serverlos:
 * die Suiten importieren Route-Handler direkt gegen In-Memory-SQLite. Eine
 * Suite, die einen echten Browser gegen einen echten Serverprozess fährt,
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
