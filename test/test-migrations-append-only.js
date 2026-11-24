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
 *
 * ZWEI LAYOUTS SEIT ABSCHNITT F (24.11.2026). Die Migrationen ziehen aus dem
 * Array in server/db.js in eine Datei je Migration (server/migrations/NNNN.ts,
 * Reihenfolge in server/migrations/index.ts, Helfer in helpers.ts). Der Guard
 * liest beide Layouts ueber test/helpers/migration-layout.js zu derselben
 * Liste und vergleicht ueber die Grenze hinweg: der PR, der umzieht, hat eine
 * Basis im alten und eine Arbeitskopie im neuen Layout, und genau dort muss
 * jeder Eintrag byte-gleich ankommen. Verglichen wird je Migration der
 * Quelltext ihres Objekts (Einrueckung eingeschlossen, im SQL ist sie Inhalt),
 * nicht mehr der Block als Ganzes; die Laufreihenfolge ist im neuen Layout das
 * Array in index.ts, und ihre Basis muss ein Praefix der Arbeitskopie sein.
 * Neu ist Frage 4: ein HELFER, den eine bestehende Migration aufruft, ist so
 * eingefroren wie die Migration selbst - aendert er sich, tut die alte
 * Migration auf einer noch nicht migrierten Installation etwas anderes.
 * Gefunden werden Helfer ueber die Bezeichner im Code (AST), nicht ueber Text:
 * eine Textsuche las Namen aus Kommentaren und SQL.
 *
 * WARUM DIE FIXTURES UNTEN: das neue Layout gibt es auf main erst nach dem
 * Umzug. Damit der Guard es vorher schon rot gesehen hat, baut der Test das
 * neue Layout im Speicher aus dem echten server/db.js nach und faehrt jede
 * Frage einmal gruen und einmal rot gegen eine gezielte Abweichung.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync, existsSync, realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  readOldLayout, readNewLayout, migrationFile, helpersUsedBy,
  numberingFindings, prefixFindings, descriptionFindings, importFindings,
} from './helpers/migration-layout.js';

const repoRoot = fileURLToPath(new URL('..', import.meta.url));
const NEW_INDEX = 'server/migrations/index.ts';

/** Die Arbeitskopie, in dem Layout, in dem sie liegt. */
function currentMigrations() {
  if (existsSync(new URL(`../${NEW_INDEX}`, import.meta.url))) {
    return readNewLayout((name) => {
      const url = new URL(`../server/migrations/${name}`, import.meta.url);
      return existsSync(url) ? readFileSync(url, 'utf8') : null;
    });
  }
  return readOldLayout(readFileSync(new URL('../server/db.js', import.meta.url), 'utf8'));
}

/**
 * git in DIESEM Baum. Wirft nicht, sondern gibt den Fehlertext mit - ob daraus
 * ein Rot oder ein Skip wird, entscheidet der Aufrufer, und das haengt davon
 * ab, ob der Lauf in der CI steht.
 */
/** @param {...string} args */
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
    const failure = /** @type {{ stderr?: unknown, message?: string }} */ (error);
    return { ok: false, out: '', err: String(failure.stderr || failure.message).trim() };
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


/** Die Basis, in dem Layout, in dem sie liegt. */
function baseMigrations(/** @type {string} */ sha, /** @type {string} */ label) {
  const short = sha.slice(0, 8);
  const show = (/** @type {string} */ path) => {
    const shown = git('show', `${sha}:${path}`);
    return shown.ok ? shown.out : null;
  };
  if (show(NEW_INDEX) !== null) return readNewLayout((name) => show(`server/migrations/${name}`), `Basis ${label} (${short}): `);
  const db = show('server/db.js');
  assert.ok(db !== null, `server/db.js ist in der Basis ${label} (${short}) nicht lesbar.`);
  return readOldLayout(/** @type {string} */ (db), `server/db.js der Basis ${label} (${short})`);
}

/** Ein Guard, der nichts gemessen hat, darf nicht urteilen. */
function assertMeasured(/** @type {import('./helpers/migration-layout.js').Migrations} */ migrations, /** @type {string} */ where) {
  assert.deepEqual(migrations.findings, [], `${where} ist nicht lesbar:\n  ${migrations.findings.join('\n  ')}`);
  assert.ok(migrations.entries.length >= 100,
    `Nur ${migrations.entries.length} Migrationen in ${where} gefunden - entweder hat sich das Layout geaendert, `
    + 'dann gehoert test/helpers/migration-layout.js nachgezogen, oder die Liste ist kaputt.');
}

const RULE = 'Migrationen sind append-only (CLAUDE.md): neue werden ANGEHAENGT und bekommen die naechste freie Nummer; '
  + 'bestehende werden nie geaendert, umsortiert oder neu nummeriert - eine Bestandsinstallation hat die alte Fassung '
  + 'schon ausgefuehrt und bekommt die neue nie.';

test('die Migrationen sind lueckenlos aufsteigend nummeriert', () => {
  const current = currentMigrations();
  assertMeasured(current, 'der Arbeitskopie');
  const findings = numberingFindings(current);
  assert.deepEqual(findings, [], `${RULE}\n  ${findings.join('\n  ')}`);
});

test('bestehende Migrationen und ihre Helfer sind gegenueber der Basis unveraendert, neue nur angehaengt', (t) => {
  const base = resolveBase();
  if (base.skip) return t.skip(base.skip);
  if (base.fail) assert.fail(base.fail);
  const sha = /** @type {string} */ (base.sha);
  const before = baseMigrations(sha, /** @type {string} */ (base.label));
  assertMeasured(before, `der Basis ${base.label}`);
  const current = currentMigrations();
  assertMeasured(current, 'der Arbeitskopie');
  const findings = prefixFindings(before, current, `${base.label} ${sha.slice(0, 8)}`);
  assert.deepEqual(findings, [], `${RULE}\n  ${findings.join('\n  ')}\n  Der ganze Unterschied: git diff ${sha.slice(0, 8)}`);
});

test('jede Migration nennt neben ihrer Version auch eine Beschreibung', () => {
  // Ein Eintrag ohne `description` ist beim naechsten Konflikt nicht
  // identifizierbar - `[DB] Migration 128 applied:` waere dann leer, und genau
  // diese Zeile ist beim Update eines Bestandsservers die einzige Spur.
  const findings = descriptionFindings(currentMigrations());
  assert.deepEqual(findings, [], findings.join('\n  '));
});

test('keine Migration ruft Laufzeit-Code aus services/, routes/ oder server/authorize/', () => {
  // EINE MIGRATION TUT FUER IMMER DASSELBE. Ruft ein Eintrag eine geteilte
  // Laufzeitregel auf, aendert jede spaetere Aenderung an ihr rueckwirkend,
  // was die Migration auf einer noch nicht migrierten Installation tut - und
  // liest die Regel eine Spalte, die erst eine juengere Migration anlegt,
  // bricht das Durchmigrieren alter Installationen mittendrin ab. R20 hatte
  // genau das: Migration 250 rief `normalizeOpenPaymentTasks()` aus
  // services/payment-task-audience.js auf; seitdem traegt sie eine
  // eingefrorene Kopie.
  //
  // Erlaubt sind Plattform-Module, reine Hilfen aus server/utils/, der Logger
  // und die eingefrorenen Helfer der Migrationen.
  const current = currentMigrations();
  if (current.layout === 'new') {
    const findings = importFindings(current);
    assert.deepEqual(findings, [], findings.join('\n  '));
    return;
  }
  // Altes Layout: was server/db.js importiert und nicht rein ist, darf im
  // Code keiner Migration vorkommen.
  const pure = (/** @type {string} */ spec) => spec.startsWith('node:') || ['path', 'os', 'fs', 'crypto'].includes(spec)
    || spec.startsWith('./utils/') || spec === './logger.js';
  const forbidden = new Map(current.imports.filter(({ spec }) => !pure(spec))
    .flatMap(({ spec, names }) => names.map((name) => [name, spec])));
  const findings = current.entries.flatMap((entry) => [...entry.refs].filter((name) => forbidden.has(name))
    .map((name) => `version ${entry.version}: ${name} (aus ${forbidden.get(name)}) - die Regel als eingefrorene Kopie in den Eintrag schreiben.`));
  assert.deepEqual(findings, [], findings.join('\n  '));
});

// ---------------------------------------------------------------------------
// Das neue Layout, bevor es auf main liegt: im Speicher aus dem echten db.js.
// ---------------------------------------------------------------------------

/**
 * server/db.js im neuen Layout, so wie der Umzug es schreiben soll: jede
 * Migration ihr Objekt wie im Array, die Helfer in helpers.ts.
 * @param {import('./helpers/migration-layout.js').Migrations} old
 * @param {{ entries?: (files: Map<string, string>) => void }} [edit]
 */
function asNewLayout(old, edit = {}) {
  /** @type {Map<string, string>} */
  const files = new Map();
  const names = [];
  for (const entry of old.entries) {
    const file = migrationFile(/** @type {number} */ (entry.version));
    const name = `m${file.slice(0, 4)}`;
    names.push([name, file]);
    const helpers = [...helpersUsedBy([entry], old.helpers)];
    const imports = helpers.length ? `import { ${helpers.join(', ')} } from './helpers.ts';\n\n` : '';
    files.set(file, `${imports}export default ${entry.text};\n`);
  }
  files.set('helpers.ts', [...old.helpers].filter(([name]) => helpersUsedBy(old.entries, old.helpers).has(name))
    .map(([, helper]) => `export ${helper.text}\n`).join('\n'));
  files.set('index.ts', names.map(([name, file]) => `import ${name} from './${file}';`).join('\n')
    + `\n\nexport const MIGRATIONS = [\n${names.map(([name]) => `  ${name},`).join('\n')}\n];\n`);
  edit.entries?.(files);
  return files;
}

const oldLayout = readOldLayout(readFileSync(new URL('../server/db.js', import.meta.url), 'utf8'));
const reader = (/** @type {Map<string, string>} */ files) => readNewLayout((name) => files.get(name) ?? null);

/** Eine Stelle in einer Datei ersetzen, genau einmal. */
function replaceOnce(/** @type {Map<string, string>} */ files, /** @type {string} */ file, /** @type {string} */ from, /** @type {string} */ to) {
  const text = /** @type {string} */ (files.get(file));
  assert.equal(text.split(from).length, 2, `Fixture: \`${from}\` steht nicht genau einmal in ${file}.`);
  files.set(file, text.replace(from, to));
}

test('Fixture: der Umzug ins neue Layout ist gruen, wenn jede Migration byte-gleich ankommt', () => {
  if (oldLayout.entries.length === 0) return; // schon umgezogen - dann prueft der Basis-Test oben den echten Umzug
  const moved = reader(asNewLayout(oldLayout));
  assert.deepEqual(moved.findings, []);
  assert.equal(moved.entries.length, oldLayout.entries.length);
  assert.deepEqual([...numberingFindings(moved), ...prefixFindings(oldLayout, moved, 'db.js'), ...descriptionFindings(moved), ...importFindings(moved)], []);
});

test('Fixture: ein geaenderter Eintrag ist rot, auch wenn sich nur die Einrueckung im SQL aendert', () => {
  if (oldLayout.entries.length === 0) return;
  const files = asNewLayout(oldLayout);
  replaceOnce(files, '0001.ts', '\n      -- Benutzer\n', '\n    -- Benutzer\n');
  const findings = prefixFindings(oldLayout, reader(files), 'db.js');
  assert.equal(findings.length, 1, findings.join('\n'));
  assert.match(findings[0], /^Migration 1 weicht von der Basis/);
});

test('Fixture: eine umsortierte Laufreihenfolge in index.ts ist rot', () => {
  if (oldLayout.entries.length === 0) return;
  const files = asNewLayout(oldLayout);
  replaceOnce(files, 'index.ts', '  m0002,\n  m0003,\n', '  m0003,\n  m0002,\n');
  const moved = reader(files);
  assert.ok(moved.findings.some((f) => /anderer Reihenfolge als die Importe/.test(f)), moved.findings.join('\n'));
  assert.ok(numberingFindings(moved).some((f) => /version 3 an Stelle 2/.test(f)));
  assert.ok(prefixFindings(oldLayout, moved, 'db.js').some((f) => /^Migration 2 weicht/.test(f)));
});

test('Fixture: eine Datei, deren Name nicht ihre Version ist, ist rot', () => {
  if (oldLayout.entries.length === 0) return;
  const files = asNewLayout(oldLayout);
  const last = oldLayout.entries.length;
  replaceOnce(files, migrationFile(last), `version: ${last},`, `version: ${last + 1},`);
  assert.ok(numberingFindings(reader(files)).some((f) => f.includes(`traegt version ${last + 1}`)));
});

test('Fixture: ein geaenderter Helfer einer bestehenden Migration ist rot', () => {
  if (oldLayout.entries.length === 0) return;
  const files = asNewLayout(oldLayout);
  const helper = [...helpersUsedBy(oldLayout.entries, oldLayout.helpers)][0];
  assert.ok(helper, 'Fixture: keine Migration nutzt einen Helfer - der Test misst nichts.');
  replaceOnce(files, 'helpers.ts', `function ${helper}(`, `function ${helper}(/* anders */ `);
  assert.ok(prefixFindings(oldLayout, reader(files), 'db.js').some((f) => f.includes(`Helfer ${helper}()`)));
});

test('Fixture: eine angehaengte Migration ist gruen, eine fehlende rot', () => {
  if (oldLayout.entries.length === 0) return;
  const files = asNewLayout(oldLayout);
  const next = oldLayout.entries.length + 1;
  const file = migrationFile(next);
  files.set(file, `export default {\n    version: ${next},\n    description: 'fixture',\n    up: \`SELECT 1;\`,\n  };\n`);
  replaceOnce(files, 'index.ts', '\n\nexport const MIGRATIONS = [\n', `\nimport m${file.slice(0, 4)} from './${file}';\n\nexport const MIGRATIONS = [\n`);
  replaceOnce(files, 'index.ts', '\n];\n', `\n  m${file.slice(0, 4)},\n];\n`);
  const grown = reader(files);
  assert.deepEqual([...grown.findings, ...numberingFindings(grown), ...prefixFindings(oldLayout, grown, 'db.js')], []);
  // Und umgekehrt: die Basis hat die neue Migration, die Arbeitskopie nicht mehr.
  assert.ok(prefixFindings(grown, oldLayout, 'Basis').some((f) => f.includes(`Migration ${next} der Basis`)));
});

test('Fixture: eine Migration, die Laufzeit-Code importiert, ist rot', () => {
  if (oldLayout.entries.length === 0) return;
  const files = asNewLayout(oldLayout);
  const text = /** @type {string} */ (files.get('0001.ts'));
  files.set('0001.ts', `import { visibleWhere } from '../services/visibility.js';\n${text}`);
  assert.ok(importFindings(reader(files)).some((f) => f.includes('../services/visibility.js')));
});
