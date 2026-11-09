/**
 * Test: Beleg-Ordner der Gemeinsamen Ausgaben traegt den Modulnamen (Migration v146)
 * Zweck: EIN MODUL, EIN NAME - der Zielordner der Belege hiess in elf von
 *        vierundzwanzig Sprachen anders als das Modul selbst. Mit dem Rename
 *        des Locale-Werts allein bekaeme jeder Bestandshaushalt beim naechsten
 *        Beleg einen ZWEITEN Ordner, weil `ensureFolder`
 *        (server/routes/documents.js) den Ordner ueber seinen NAMEN sucht und
 *        sonst anlegt. Drei Faelle muessen stimmen:
 *        (1) Bestandsordner mit altem Namen wird umbenannt, seine Dokumente
 *            bleiben daran haengen (die Migration fasst `id` nicht an).
 *        (2) Existiert der Zielname bereits, wird NICHT umbenannt - zwei
 *            gleichnamige Ordner waeren schlimmer als ein alt benannter, weil
 *            `ensureFolder` den ersten Treffer nimmt und welcher das ist an der
 *            Zeilenreihenfolge haengt.
 *        (3) Der Fall, in dem sich alt und neu NUR in der Grossschreibung
 *            unterscheiden (id: "Pengeluaran bersama" -> "Pengeluaran
 *            Bersama"), wird trotzdem umbenannt. `COLLATE NOCASE` findet dort
 *            den Quellordner als seinen eigenen Konflikt.
 *        (4) DERSELBE Haushalt mit BEIDEN Schreibweisen nebeneinander bringt
 *            den Start nicht um. `family_document_folders.name` traegt ein
 *            case-sensitives `UNIQUE`, beide Ordner duerfen also existieren.
 *
 *            EHRLICHKEIT ZU DIESER ZUSICHERUNG: sie ist gegen die erste
 *            Fassung der Migration GRUEN, ist also keine Mutationsprobe.
 *            Nachgemessen: der Index-Scan liefert bei diesem Paar immer
 *            "Pengeluaran Bersama" zuerst (BINARY-Kollation, `B` < `b`), ein
 *            Konfliktcheck ueber den ersten NOCASE-Treffer sah dort also die
 *            ZIELzeile, und das folgende UPDATE war ein No-op auf denselben
 *            Wert - kein Abbruch, aber auch keine Umbenennung, und beides aus
 *            dem falschen Grund. Der Review zu PR #788 las daraus einen
 *            Startabbruch; der ist bei dieser Kollationsreihenfolge nicht
 *            erreichbar. Die Migration sucht die Quelle trotzdem EXAKT und
 *            den Konflikt mit `id <> ?`, damit das Ergebnis nicht an der
 *            Reihenfolge eines Query-Plans haengt. Diese Zusicherung haelt
 *            den Zustand fest, den beide Fassungen erzeugen sollen.
 * Ausführen: node --test test/test-split-folder-rename-migration.js
 */

process.env.SESSION_SECRET = process.env.SESSION_SECRET || 'test-secret';
process.env.DB_PATH = ':memory:';

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';

const dbmod = await import('../server/db.js');
const migration146 = dbmod.MIGRATIONS.find((m) => m.version === 146);

/**
 * Nur die eine Tabelle, die die Migration anfasst - aber MIT ihrem `UNIQUE`.
 *
 * Das Constraint ist kein Detail, sondern der Unterschied zwischen einem
 * falschen Ordnernamen und einem Server, der nicht mehr startet. Die erste
 * Fassung dieser Suite liess es weg und war deshalb gruen, waehrend die
 * Migration in einem echten Haushalt abgebrochen waere (PR #788).
 */
function folders(rows = []) {
  const conn = new DatabaseSync(':memory:');
  conn.exec(`
    CREATE TABLE family_document_folders (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      name       TEXT NOT NULL UNIQUE,
      created_by INTEGER
    );
  `);
  const insert = conn.prepare('INSERT INTO family_document_folders (name) VALUES (?)');
  for (const name of rows) insert.run(name);
  return conn;
}

const names = (conn) => conn.prepare('SELECT id, name FROM family_document_folders ORDER BY id').all();

test('ein Bestandsordner mit altem Namen wird umbenannt und behaelt seine id', () => {
  const conn = folders(['Belege', 'Geteilte Ausgaben', 'Inventar']);
  const before = names(conn).find((f) => f.name === 'Geteilte Ausgaben');

  migration146.up(conn);

  const after = names(conn);
  assert.deepEqual(after.map((f) => f.name), ['Belege', 'Gemeinsame Ausgaben', 'Inventar']);
  // Die id ist der Grund, warum ueberhaupt umbenannt und nicht neu angelegt
  // wird: `family_documents.folder_id` zeigt darauf. Ein neuer Ordner haette
  // die Belege zurueckgelassen.
  assert.equal(after.find((f) => f.name === 'Gemeinsame Ausgaben').id, before.id);
});

test('existiert der Zielname schon, bleibt der alte Ordner unberuehrt', () => {
  const conn = folders(['Geteilte Ausgaben', 'Gemeinsame Ausgaben']);

  migration146.up(conn);

  assert.deepEqual(names(conn).map((f) => f.name), ['Geteilte Ausgaben', 'Gemeinsame Ausgaben'],
    'zwei gleichnamige Ordner waeren schlimmer als einer mit altem Namen');
});

test('der Fall, der sich nur in der Grossschreibung unterscheidet, wird trotzdem umbenannt', () => {
  const conn = folders(['Pengeluaran bersama']);

  migration146.up(conn);

  assert.deepEqual(names(conn).map((f) => f.name), ['Pengeluaran Bersama'],
    'COLLATE NOCASE findet hier den Quellordner als seinen eigenen Konflikt - '
    + 'die Migration muss die eigene id ausschliessen');
});

test('beide Schreibweisen nebeneinander bringen die Migration nicht um', () => {
  // Das case-sensitive UNIQUE erlaubt beide Zeilen, `ensureFolder` kann sie
  // ueber zwei App-Versionen hinweg angelegt haben. Ein Konfliktcheck, der
  // einen beliebigen NOCASE-Treffer gegen die eigene id haelt, bekommt hier
  // den QUELLordner zurueck, haelt das fuer konfliktfrei und laeuft ins
  // UNIQUE - die Migration wirft, die Transaktion rollt zurueck, der Server
  // startet nicht mehr.
  const conn = folders(['Pengeluaran bersama', 'Pengeluaran Bersama']);

  assert.doesNotThrow(() => migration146.up(conn),
    'Migration v146 darf an einem Haushalt mit beiden Schreibweisen nicht abbrechen');

  assert.deepEqual(names(conn).map((f) => f.name), ['Pengeluaran bersama', 'Pengeluaran Bersama'],
    'bei belegtem Zielnamen bleibt alles stehen - ensureFolder trifft dann den kanonischen');
});

test('eine Datenbank ohne passenden Ordner bleibt unveraendert', () => {
  const conn = folders(['Belege', 'Vertraege']);

  migration146.up(conn);

  assert.deepEqual(names(conn).map((f) => f.name), ['Belege', 'Vertraege']);
});

test('jede Sprache ist abgedeckt: die Migration kennt jeden Namen, den ein Ordner heute traegt', () => {
  // Reichweiten-Nachweis. Ohne ihn kann die Paarliste eine Sprache verlieren
  // (oder nie bekommen haben) und der Guard bliebe gruen, weil er nur die
  // Sprachen prueft, die er selbst aufzaehlt.
  const locales = readdirSync(new URL('../public/locales/', import.meta.url)).filter((f) => f.endsWith('.json'));
  assert.ok(locales.length >= 20, `nur ${locales.length} Locales gefunden - Pfad veraltet?`);

  const uncovered = [];
  for (const file of locales) {
    const data = JSON.parse(readFileSync(new URL(`../public/locales/${file}`, import.meta.url), 'utf8'));
    const title = data.splitExpenses?.title;
    assert.ok(title, `${file}: splitExpenses.title fehlt`);

    // Dass der Locale-Wert des Ordners dem Modulnamen GLEICHT, prueft
    // `test:i18n` ("der Beleg-Ordner der Gemeinsamen Ausgaben heisst wie das
    // Modul") - dort gehoert die Regel hin, weil sie fuer jede kuenftige
    // Uebersetzung gilt und nicht fuer diesen einen Migrationslauf.
    //
    // Hier zaehlt die andere Richtung: die Migration darf keinen Namen
    // anfassen, der heute schon kanonisch ist. Ein Paar, dessen linke Seite
    // versehentlich ein aktueller Titel waere, benaenne bei jedem Upgrade
    // fleissig etwas Richtiges in etwas Falsches um.
    const conn = folders([title]);
    migration146.up(conn);
    if (names(conn)[0].name !== title) uncovered.push(`${file}: ${title}`);
  }
  assert.deepEqual(uncovered, [], `Migration benennt einen bereits kanonischen Namen um:\n  ${uncovered.join('\n  ')}`);
});
