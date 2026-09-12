/**
 * Modul: Migrationen sind append-only
 * Zweck: Den letzten Hard Constraint absichern, der keinen Guard hatte.
 *        CLAUDE.md sagt „Migrationen nur ans `migrations`-Array anhaengen,
 *        bestehende Eintraege nie aendern oder umsortieren"; bis heute hielt
 *        ihn allein die Disziplin (Guard-Abdeckung 2026-08-08, Befund H).
 * Ausfuehren: npm run test:migrations-append-only
 *
 * WARUM DAS TEUER WAERE, WENN ES BRICHT: `applied` ist eine Menge von
 * Versionsnummern in der Datenbank des NUTZERS (db.js: `MIGRATIONS.filter((m)
 * => !applied.has(m.version))`). Eine umsortierte oder neu vergebene Nummer
 * laesst eine Bestandsinstallation eine Migration ueberspringen oder eine
 * fremde fuer erledigt halten - stumm, beim Update, auf einem selbstgehosteten
 * Server ohne Betreuung.
 *
 * GELESEN WIRD DIE QUELLE, NICHT DAS IMPORTIERTE ARRAY. Das ist die
 * unbequemere Wahl und die richtige, und beide Gruende wurden beim Bau
 * gemessen:
 *
 *   (a) Die Dublette kommt gar nicht bis zur Zusicherung. `import
 *       '../server/db.js'` ruft `init()` auf, `migrate()` laeuft, und das
 *       zweite `INSERT` in `schema_migrations` bricht mit
 *       SQLITE_CONSTRAINT_PRIMARYKEY ab - der Entwickler sieht einen
 *       Stacktrace in db.js:4990 statt „version 133 kommt zweimal vor".
 *   (b) Die UMSORTIERUNG faellt beim Import ueberhaupt nicht auf. Eine frische
 *       Datenbank hat kein `applied`, also laeuft jede Reihenfolge glatt
 *       durch. Genau der Fall, der eine Bestandsinstallation zerlegt, waere
 *       ueber das importierte Array gruen geblieben.
 *
 * Der Preis ist eine Textform, an die der Guard gebunden ist - `version: N,`
 * am Anfang einer Zeile im MIGRATIONS-Array. Deshalb prueft er unten auch, dass
 * er ueberhaupt etwas gefunden hat: eine geaenderte Schreibweise faellt als
 * Guard-Fehler auf, nicht als stille Null.
 *
 * DREI FRAGEN:
 *   (1) aufsteigend und lueckenlos - faengt Umsortierung und Merge-Verlust.
 *   (2) jede Nummer einmalig - faengt die zweite Migration unter derselben Nummer.
 *   (3) wurde ein BESTEHENDER Eintrag geaendert? Der MIGRATIONS-Block der BASIS
 *       aus git muss ein Praefix des Blocks in der Arbeitskopie sein. Anhaengen
 *       bleibt gruen; Aendern, Einfuegen und Umsortieren werden rot - auch dann,
 *       wenn nur ein Leerzeichen oder ein Zeilenumbruch fehlt.
 *
 * FRAGE 3 WAR BIS ZUM 10.09.2026 BEWUSST NICHT GESTELLT. An dem Tag entfernte ein
 * Rebase-Merge im Fremd-PR #1055 den Zeilenumbruch vor dem schliessenden
 * Backtick von Migration 193, und der Guard blieb gruen, weil (1) und (2) nur
 * `version: N,` lesen. Eine solche Aenderung sieht keine Nummernpruefung, und im
 * Review eines grossen Rebase-Diffs sieht sie auch niemand zuverlaessig.
 *
 * DIE ALTE BEGRUENDUNG GILT FUER DIESE ANTWORT NICHT MEHR. Sie lautete: Frage 3
 * braeuchte eine Pruefsumme je Eintrag im Repo, die beim ersten legitimen
 * Refactor im Weg stuende und dann „nachgezogen" wuerde - ein Guard, der zum
 * Nachziehen erzieht. Der Vergleich gegen die Basis braucht KEIN MANIFEST: die
 * Basis ist die zuletzt gemergte Fassung von db.js selbst, nachgefuehrt vom
 * Merge und nicht von Hand. Es gibt keine Datei, die jemand pflegen oder
 * nachziehen koennte. Eine gewollte Aenderung an einem alten Eintrag wird genau
 * in dem Lauf rot, der sie einfuehrt, und ist danach Teil der naechsten Basis.
 *
 * WARUM NICHT DAS LETZTE RELEASE-TAG ALS BASIS: Migration 193 war am 10.09. in
 * keinem Release. v2.65.1 ist vom 08.09., 14:00; 193 kam am selben Tag um 23:07.
 * Gegen das Tag waere 193 ein neuer Eintrag gewesen und die Aenderung als Teil
 * des Anhaengens gruen durchgegangen. Geschuetzt waere nur, was schon
 * ausgeliefert ist - nicht der gemergte Eintrag, den der naechste Zweig
 * ueberschreibt.
 *
 * WELCHE BASIS:
 *   - In der CI (`GITHUB_ACTIONS=true`) `HEAD^1`. Bei `pull_request` checkt
 *     actions/checkout den Merge-Ref aus, und dessen ERSTER Elternteil ist der
 *     main-Stand; bei einem Push auf main ist `HEAD^1` der vorige main-Stand.
 *     Den Elternteil gibt es nur mit `fetch-depth: 2` im Checkout (ci.yml).
 *     Fehlt er, ist der Test ROT, nicht uebersprungen: ein Guard, der in der CI
 *     still skippt, ist gruen ueber nichts - so wie der Tag-Test in
 *     test-changelog.js, der im shallow clone der CI ueberspringt.
 *   - Lokal `git merge-base HEAD origin/main`. Ohne git, ohne eigenes Repository
 *     oder ohne origin/main wird SICHTBAR uebersprungen: dort gibt es keinen
 *     Stand, gegen den ein Rot richtig waere.
 *   Verglichen wird mit der ARBEITSKOPIE, nicht mit HEAD - lokal faellt so auch
 *   eine noch nicht committete Aenderung auf.
 *
 * GRENZE: `HEAD^1` ist genau ein Commit zurueck. Kommen bei einem Push auf main
 * mehrere Commits OHNE Merge-Commit an (Rebase-Merge, direkter Push) oder laeuft
 * `workflow_dispatch` auf einem Zweig, vergleicht die CI nur gegen den
 * vorletzten Commit. Eine Aenderung in einem frueheren Commit derselben Serie
 * sieht dann nur der pull_request-Lauf davor.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync, realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

// Zeilenenden vereinheitlicht: `git show` liefert den Blob mit LF, ein Checkout mit
// `core.autocrlf` (Git fuer Windows) liest `server/db.js` mit CRLF - ohne das waere der
// Basis-Vergleich unten schon bei Version 1 rot, obwohl nichts geaendert ist.
const source = readFileSync(new URL('../server/db.js', import.meta.url), 'utf8').replace(/\r\n/g, '\n');
const repoRoot = fileURLToPath(new URL('..', import.meta.url));

/**
 * `^\s*version:\s*(\d+),` und nicht irgendein `version:` - im `up`-SQL stehen
 * Spaltennamen und Kommentare, und eine Suche ohne Zeilenanfang liest sie mit.
 */
const VERSION_LINE = /^[ \t]*version:\s*(\d+)\s*,/gm;

/**
 * Anfang und Ende des MIGRATIONS-Rumpfs in `text`, ueber die Klammern begrenzt
 * statt per Regex. `where` nennt in der Meldung, WELCHE Fassung kaputt ist -
 * seit Frage 3 liest der Guard zwei.
 */
function migrationsRange(text, where) {
  const start = text.indexOf('const MIGRATIONS = [');
  assert.notEqual(start, -1, `const MIGRATIONS = [ nicht in ${where} gefunden.`);
  let depth = 0;
  let index = text.indexOf('[', start);
  const from = index;
  while (index < text.length) {
    if (text[index] === '[') depth += 1;
    else if (text[index] === ']') {
      depth -= 1;
      if (depth === 0) return { from, to: index };
    }
    index += 1;
  }
  throw new Error(`Das MIGRATIONS-Array in ${where} ist nicht geschlossen.`);
}

/** Der Rumpf des MIGRATIONS-Arrays in der Arbeitskopie. */
function migrationsBlock() {
  const { from, to } = migrationsRange(source, 'server/db.js');
  return source.slice(from, to);
}

/** Die Versionsnummern in ihrer QUELLREIHENFOLGE. */
function declaredVersions(block = migrationsBlock()) {
  return [...block.matchAll(VERSION_LINE)].map((m) => Number(m[1]));
}

/**
 * git in DIESEM Baum. Wirft nicht, sondern gibt den Fehlertext mit - ob daraus
 * ein Rot oder ein Skip wird, entscheidet der Aufrufer, und das haengt davon
 * ab, ob der Lauf in der CI steht.
 */
function git(...args) {
  try {
    const out = execFileSync('git', args, {
      cwd: repoRoot,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      maxBuffer: 64 * 1024 * 1024,
    });
    return { ok: true, out };
  } catch (error) {
    return { ok: false, out: '', err: String(error.stderr || error.message).trim() };
  }
}

/**
 * Die Basis fuer Frage 3: `{ sha, label }`, lokal ersatzweise `{ skip }`, in
 * der CI ersatzweise `{ fail }` - dort gibt es keinen Skip.
 */
function resolveBase() {
  const inCi = process.env.GITHUB_ACTIONS === 'true';

  // Gehoert das Repository, das git findet, zu DIESEM Baum? Ein Export ohne
  // .git, der unter einem anderen Checkout liegt, bekaeme sonst dessen HEAD als
  // Basis - und der Guard vergliche gegen eine db.js, die mit diesem Baum
  // nichts zu tun hat.
  const top = git('rev-parse', '--show-toplevel');
  let noRepo = null;
  if (!top.ok) noRepo = `kein git-Repository (${top.err})`;
  else if (realpathSync(top.out.trim()) !== realpathSync(repoRoot)) {
    noRepo = `git findet ${top.out.trim()} als Wurzel, nicht diesen Baum`;
  }

  if (inCi) {
    const parent = noRepo ? null : git('rev-parse', '--verify', '--quiet', 'HEAD^1^{commit}');
    if (parent?.ok) return { sha: parent.out.trim(), label: 'HEAD^1' };
    return {
      fail: `In der CI fehlt die Basis fuer den Vergleich bestehender Migrationen: ${noRepo ?? 'HEAD^1 liegt nicht im Klon'}. `
        + 'Der Checkout in .github/workflows/ci.yml braucht `with: fetch-depth: 2` - mit depth 1 hat HEAD '
        + 'keinen Elternteil. Rot statt Skip, weil ein in der CI still uebersprungener Guard gruen ueber nichts waere.',
    };
  }

  if (noRepo) return { skip: `${noRepo} - ohne git keine Basis fuer den Vergleich bestehender Migrationen` };
  if (!git('rev-parse', '--verify', '--quiet', 'origin/main^{commit}').ok) {
    return { skip: 'origin/main fehlt in diesem Klon - ohne sie keine Basis fuer den Vergleich bestehender Migrationen' };
  }
  const mergeBase = git('merge-base', 'HEAD', 'origin/main');
  if (!mergeBase.ok) return { skip: `keine gemeinsame Basis von HEAD und origin/main (${mergeBase.err})` };
  return { sha: mergeBase.out.trim(), label: 'merge-base HEAD origin/main' };
}

/** Die Zeile, in der `offset` liegt, und ihr Anfang im Text. */
function lineAround(text, offset) {
  const start = text.lastIndexOf('\n', offset - 1) + 1;
  const end = text.indexOf('\n', offset);
  return { start, text: text.slice(start, end === -1 ? text.length : end) };
}

test('die Migrationen sind lueckenlos aufsteigend nummeriert', () => {
  const versions = declaredVersions();

  // Ein Guard, der nichts gemessen hat, darf nicht urteilen: eine geaenderte
  // Schreibweise im Array wuerde sonst als „alles in Ordnung" durchgehen.
  assert.ok(versions.length >= 100,
    `Nur ${versions.length} Versionsnummern im MIGRATIONS-Array gefunden. Entweder ist die `
    + 'Schreibweise `version: N,` entfallen - dann gehoert dieser Guard nachgezogen - oder '
    + 'das Array ist kaputt.');

  const findings = [];
  versions.forEach((version, index) => {
    if (index === 0) {
      if (version !== 1) findings.push(`Der erste Eintrag traegt version ${version}, erwartet 1.`);
      return;
    }
    const previous = versions[index - 1];
    if (version === previous) {
      findings.push(`version ${version} kommt zweimal vor (Eintrag ${index - 1} und ${index}) - `
        + 'eine Bestandsinstallation haelt die zweite fuer erledigt und ueberspringt sie.');
    } else if (version < previous) {
      findings.push(`Eintrag ${index} traegt version ${version} nach ${previous} - das Array ist umsortiert.`);
    } else if (version !== previous + 1) {
      findings.push(`Zwischen ${previous} und ${version} fehlt mindestens eine Nummer (Eintrag ${index}) - `
        + 'meist zwei Zweige, die parallel angehaengt haben.');
    }
  });

  assert.deepEqual(findings, [],
    'Das MIGRATIONS-Array in server/db.js ist append-only (CLAUDE.md). Neue Migrationen werden '
    + 'ANGEHAENGT und bekommen die naechste freie Nummer; bestehende Eintraege werden nie '
    + 'umsortiert und nie neu nummeriert.\n  ' + findings.join('\n  '));
});

test('bestehende Migrationen sind gegenueber der Basis unveraendert, neue nur angehaengt', (t) => {
  const base = resolveBase();
  if (base.skip) return t.skip(base.skip);
  if (base.fail) assert.fail(base.fail);

  const short = base.sha.slice(0, 8);
  const shown = git('show', `${base.sha}:server/db.js`);
  assert.ok(shown.ok, `server/db.js ist in der Basis ${base.label} (${short}) nicht lesbar: ${shown.err}`);
  const baseSource = shown.out;
  const baseRange = migrationsRange(baseSource, `server/db.js der Basis ${base.label} (${short})`);
  const currentRange = migrationsRange(source, 'server/db.js');
  const baseBlock = baseSource.slice(baseRange.from, baseRange.to);
  const currentBlock = source.slice(currentRange.from, currentRange.to);

  // Auch hier nicht urteilen, ohne gemessen zu haben: ein abgeschnittener
  // Basis-Block waere ein Praefix von fast allem.
  const baseCount = declaredVersions(baseBlock).length;
  assert.ok(baseCount >= 100,
    `Nur ${baseCount} Versionsnummern im MIGRATIONS-Array der Basis ${base.label} (${short}) - `
    + 'der Vergleich haette nichts gemessen.');

  // Das ENDE der Basis darf sich bewegen, sonst waere schon das Anhaengen rot:
  // vor der schliessenden Klammer aendert sich der Leerraum, und ein letzter
  // Eintrag ohne Komma bekommt beim Anhaengen eines.
  const prefix = baseBlock.trimEnd().replace(/,$/, '');
  if (currentBlock.startsWith(prefix)) return;

  let at = 0;
  while (at < prefix.length && at < currentBlock.length && prefix[at] === currentBlock[at]) at += 1;

  // Der erste betroffene Eintrag ist der, dessen `version:`-Zeile vor der
  // Abweichung BEGINNT - liegt sie in der Nummer selbst (Umsortierung), ist es
  // der Eintrag der Basis an dieser Stelle.
  const entry = [...baseBlock.matchAll(VERSION_LINE)].filter((m) => m.index <= at).pop();
  const column = at - lineAround(baseBlock, at).start + 1;
  // Die Zeile mit der ersten Differenz auf beiden Seiten, Leerraum per
  // JSON.stringify sichtbar - ein fehlender Zeilenumbruch sieht sonst aus wie
  // zwei gleiche Zeilen.
  const side = (text, range, block) => {
    if (at >= block.length) return '(hier endet das Array - Eintraege entfernt?)';
    const line = lineAround(block, at);
    const number = text.slice(0, range.from + line.start).split('\n').length;
    return `server/db.js:${number}  ${JSON.stringify(line.text)}`;
  };

  assert.fail([
    `Ein BESTEHENDER Eintrag im MIGRATIONS-Array weicht von der Basis ab - erster betroffener Eintrag: `
      + `${entry ? `version ${entry[1]}` : 'vor version 1'} (Spalte ${column}).`,
    'Bestehende Migrationen werden nie geaendert oder umsortiert, neue nur ANGEHAENGT (CLAUDE.md): '
      + 'eine Bestandsinstallation hat die alte Fassung schon ausgefuehrt und bekommt die neue nie.',
    `  Basis ${base.label} (${short}):  ${side(baseSource, baseRange, baseBlock)}`,
    `  Arbeitskopie:  ${side(source, currentRange, currentBlock)}`,
    `  Der ganze Unterschied: git diff ${short} -- server/db.js`,
  ].join('\n'));
});

test('jede Migration nennt neben ihrer Version auch eine Beschreibung', () => {
  // Ein Eintrag ohne `description` ist beim naechsten Konflikt nicht
  // identifizierbar - `[DB] Migration 128 applied:` waere dann leer, und genau
  // diese Zeile ist beim Update eines Bestandsservers die einzige Spur.
  const block = migrationsBlock();
  const entries = block.split(/^[ \t]*version:\s*\d+\s*,/gm).slice(1);
  const versions = declaredVersions();
  const findings = [];
  entries.forEach((entry, index) => {
    // Nur bis zum naechsten Eintrag schauen; `up` steht dazwischen.
    const head = entry.slice(0, entry.indexOf('up:') === -1 ? entry.length : entry.indexOf('up:'));
    if (!/description:\s*['"`]\s*\S/.test(head)) {
      findings.push(`version ${versions[index]}: keine description.`);
    }
  });
  assert.deepEqual(findings, [], findings.join('\n  '));
});
