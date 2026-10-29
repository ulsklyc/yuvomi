/**
 * Modul: Demo-Seed schreibt echte PDFs (#1511)
 * Zweck: Die Demo-"PDFs" waren Klartext mit MIME-Typ application/pdf - jede
 *        Vorschau und jeder Screenshot im Dokumente-Modul zeigte einen Fehler.
 *        Diese Suite lässt den ECHTEN Seed gegen eine migrierte Wegwerf-DB
 *        laufen, liest jedes Dokument über den Leser des Servers
 *        (`readDocumentContent`) und prüft die Datei strukturell: Kopf,
 *        `startxref` zeigt auf `xref`, jeder xref-Offset zeigt auf sein
 *        `n 0 obj`, `/Length` trifft `endstream`, genau eine Seite. Dazu lädt
 *        sie jede Datei mit dem mitgelieferten PDF.js (`public/vendor/pdfjs`),
 *        demselben Parser, den die Vorschau der App benutzt, und liest den Text
 *        der Seite zurück - Umlaute, Klammern und Backslash eingeschlossen.
 *        Dazu der Seed gegen eine VERSCHLÜSSELTE Datenbank (#2114): der
 *        Schlüssel kommt aus der Umgebung oder aus `.env` im
 *        Arbeitsverzeichnis, wie beim Server.
 * Ausführen: npm run test:seed-demo-pdfs
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { openSync, readSync, closeSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';

import Database from 'better-sqlite3-multiple-ciphers';

import { buildDemoPdf, toWinAnsi } from '../scripts/seed-demo-pdf.js';
import { matchChecklistLine } from '../public/utils/markdown-checklist.js';
import { CHILD_START_PERMISSIONS, CHILD_START_PREFERENCES } from '../server/permissions.js';
import { freshTestDbPath } from './tmp-db.js';
import { tempDir } from './tmp-dir.js';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const VENDOR = resolve(ROOT, 'public/vendor/pdfjs');

// ── Migrierte Wegwerf-DB: der Seed verlangt das aktuelle Schema ───────────────
const dbPath = freshTestDbPath('seed-demo-pdfs');
const dbModule = await import('../server/db.js');
dbModule.init();
dbModule.get().close();
const { readDocumentContent } = await import('../server/services/document-storage.js');

// `freshTestDbPath` räumt VOR dem Lauf; das hier hält nur den Temp-Ordner sauber.
test.after(() => {
  for (const suffix of ['', '-wal', '-shm', '-journal', '.lock']) rmSync(dbPath + suffix, { force: true });
});

// PDF.js meldet in Node fehlende Canvas-Polyfills (DOMMatrix, Path2D) auf der
// Konsole. Gezeichnet wird hier nichts: geladen und Text gelesen, mehr nicht.
const quiet = console.warn;
console.warn = () => {};
const pdfjs = await import(pathToFileURL(resolve(VENDOR, 'pdf.min.mjs')).href);
console.warn = quiet;
pdfjs.GlobalWorkerOptions.workerSrc = pathToFileURL(resolve(VENDOR, 'pdf.worker.min.mjs')).href;

async function loadWithPdfJs(buffer) {
  // Eigene Kopie: PDF.js übernimmt den Puffer, und Buffer aus dem Pool teilen
  // sich ihren Speicher mit fremden Daten.
  const pdf = await pdfjs.getDocument({
    data: new Uint8Array(buffer),
    isEvalSupported: false,
    standardFontDataUrl: `${resolve(VENDOR, 'standard_fonts')}/`,
    verbosity: 0,
  }).promise;
  try {
    const page = await pdf.getPage(1);
    const content = await page.getTextContent();
    const info = (await pdf.getMetadata()).info;
    return {
      numPages: pdf.numPages,
      view: page.view,
      text: content.items.map((item) => item.str).join('\n'),
      title: info?.Title,
    };
  } finally {
    await pdf.destroy();
  }
}

/**
 * Liest die Datei so, wie ein PDF-Leser es tut: vom Ende her. Nichts hier
 * kennt den Erzeuger - jede Zahl kommt aus den Bytes der Datei.
 */
function assertPdfStructure(buffer, label) {
  const latin = buffer.toString('latin1');
  assert.ok(latin.startsWith('%PDF-1.4\n'), `${label}: Kopf %PDF-1.4`);
  assert.ok(latin.endsWith('%%EOF\n'), `${label}: endet auf %%EOF`);

  const tail = latin.match(/startxref\n(\d+)\n%%EOF\n$/);
  assert.ok(tail, `${label}: startxref vor %%EOF`);
  const xrefAt = Number(tail[1]);
  assert.equal(buffer.subarray(xrefAt, xrefAt + 5).toString('latin1'), 'xref\n', `${label}: startxref zeigt auf xref`);

  const header = latin.slice(xrefAt + 5).match(/^0 (\d+)\n/);
  assert.ok(header, `${label}: xref-Abschnitt beginnt bei Objekt 0`);
  const count = Number(header[1]);
  const tableAt = xrefAt + 5 + header[0].length;

  assert.equal(
    buffer.subarray(tableAt, tableAt + 20).toString('latin1'), '0000000000 65535 f \n',
    `${label}: Eintrag 0 ist der freie Kopf`
  );
  for (let number = 1; number < count; number += 1) {
    const entry = buffer.subarray(tableAt + number * 20, tableAt + (number + 1) * 20).toString('latin1');
    const parsed = entry.match(/^(\d{10}) 00000 n \n$/);
    assert.ok(parsed, `${label}: xref-Eintrag ${number} ist 20 Bytes im festen Format, war ${JSON.stringify(entry)}`);
    const at = Number(parsed[1]);
    const expected = `${number} 0 obj\n`;
    assert.equal(
      buffer.subarray(at, at + expected.length).toString('latin1'), expected,
      `${label}: xref-Offset ${at} zeigt auf "${number} 0 obj"`
    );
  }

  const trailer = latin.slice(tableAt + count * 20);
  assert.ok(trailer.startsWith('trailer\n'), `${label}: trailer folgt direkt auf die Tabelle`);
  assert.match(trailer, new RegExp(`/Size ${count}\\b`), `${label}: /Size nennt die Objektzahl`);
  assert.match(trailer, /\/Root 1 0 R/, `${label}: /Root`);

  assert.match(latin, /\/Type \/Pages \/Kids \[3 0 R\] \/Count 1\b/, `${label}: genau eine Seite`);
  assert.match(latin, /\/MediaBox \[0 0 595 842\]/, `${label}: A4`);
  assert.match(latin, /\/BaseFont \/Helvetica \/Encoding \/WinAnsiEncoding/, `${label}: Helvetica, WinAnsi`);

  const stream = latin.match(/<< \/Length (\d+) >>\nstream\n/);
  assert.ok(stream, `${label}: Inhaltsstrom mit /Length`);
  const streamAt = stream.index + stream[0].length;
  const streamEnd = streamAt + Number(stream[1]);
  assert.equal(
    buffer.subarray(streamEnd, streamEnd + 9).toString('latin1'), 'endstream',
    `${label}: /Length endet genau vor endstream`
  );
}

function seed(locale) {
  // Der Seed liest `.env` wie der Server (#2114). Diese Wegwerf-DB ist
  // unverschlüsselt, also darf ein Schlüssel aus einer lokalen `.env` sie
  // nicht treffen: ein gesetzter, leerer Wert gewinnt gegen die Datei.
  const run = spawnSync(
    process.execPath,
    [resolve(ROOT, 'scripts/seed-demo.js'), '--db', dbPath, '--locale', locale],
    { cwd: ROOT, encoding: 'utf8', env: { ...process.env, DB_ENCRYPTION_KEY: '' } }
  );
  assert.equal(run.status, 0, `seed-demo.js --locale ${locale} lief nicht durch:\n${run.stderr}`);
  const db = new Database(dbPath, { readonly: true });
  try {
    return db.prepare('SELECT * FROM family_documents ORDER BY id').all();
  } finally {
    db.close();
  }
}

for (const locale of ['en', 'de']) {
  test(`Seed (${locale}): jedes Dokument mit application/pdf ist eine PDF, die PDF.js öffnet`, async () => {
    const documents = seed(locale);
    const pdfs = documents.filter((doc) => doc.mime_type === 'application/pdf');
    // Reichweite: ein Seed ohne PDF-Dokumente liesse die Schleife leer grün.
    assert.ok(pdfs.length >= 5, `erwartet mehrere PDF-Dokumente im Seed, gefunden ${pdfs.length}`);

    for (const doc of pdfs) {
      const label = `${locale}/${doc.original_name}`;
      // Der Leser des Servers, nicht ein eigener: so kommt die Datei an, wie
      // /preview und /download sie ausliefern.
      const { buffer, mime } = await readDocumentContent(doc);
      assert.equal(mime, 'application/pdf', `${label}: MIME`);
      assertPdfStructure(buffer, label);

      const loaded = await loadWithPdfJs(buffer);
      assert.equal(loaded.numPages, 1, `${label}: eine Seite`);
      assert.deepEqual(Array.from(loaded.view), [0, 0, 595, 842], `${label}: A4`);
      assert.equal(loaded.title, doc.name, `${label}: Titel in den Metadaten`);
      // Titel und Beschreibung kommen aus den Seed-Daten und stehen lesbar auf
      // der Seite - mit Umlauten, ß und Klammern ("Reisepässe (Scans)").
      const flat = loaded.text.replace(/\s+/g, ' ');
      assert.ok(flat.includes(doc.name), `${label}: Titel "${doc.name}" steht auf der Seite, gelesen: ${flat}`);
      assert.ok(flat.includes(doc.description), `${label}: Beschreibung "${doc.description}" steht auf der Seite`);
      assert.ok(flat.includes('Yuvomi'), `${label}: Fusszeile nennt Yuvomi`);
    }
  });
}

/* Abmessungen aus dem ersten SOF-Segment einer JPEG-Datei - ohne Bildbibliothek,
 * nur die Segmentkette ab SOI. null, wenn die Datei kein JPEG ist. */
function jpegSize(buffer) {
  if (buffer.length < 4 || buffer[0] !== 0xFF || buffer[1] !== 0xD8) return null;
  let at = 2;
  while (at + 4 <= buffer.length) {
    if (buffer[at] !== 0xFF) return null;
    const marker = buffer[at + 1];
    const length = buffer.readUInt16BE(at + 2);
    // SOF0..SOF15 ohne DHT (C4), JPG (C8) und DAC (CC)
    if (marker >= 0xC0 && marker <= 0xCF && ![0xC4, 0xC8, 0xCC].includes(marker)) {
      return { height: buffer.readUInt16BE(at + 5), width: buffer.readUInt16BE(at + 7) };
    }
    at += 2 + length;
  }
  return null;
}

// R24, Critique G4 P2-1: die Bildbelege waren Klartext mit image/jpeg, und
// jede Demo-Vorschau zeigte ein kaputtes Bild.
test('Seed: jedes Dokument mit image/jpeg ist ein JPEG, das ein Bild traegt', async () => {
  const images = seed('de').filter((doc) => doc.mime_type === 'image/jpeg');
  assert.ok(images.length >= 3, `erwartet die drei Bildbelege, gefunden ${images.length}`);
  for (const doc of images) {
    const { buffer, mime } = await readDocumentContent(doc);
    assert.equal(mime, 'image/jpeg', `${doc.original_name}: MIME`);
    const size = jpegSize(buffer);
    assert.ok(size, `${doc.original_name}: kein JPEG (beginnt mit ${buffer.subarray(0, 8).toString('hex')})`);
    assert.ok(size.width >= 200 && size.height >= 200, `${doc.original_name}: ${size.width}x${size.height}`);
    assert.equal(buffer.readUInt16BE(buffer.length - 2), 0xFFD9, `${doc.original_name}: endet nicht mit EOI`);
  }
});

test('Seed (de): Umlaute, ß und Klammern sind im Seed wirklich vertreten', () => {
  // Hält den Fall oben ehrlich: verschwände der Titel mit Klammern aus dem
  // Seed, prüfte die Schleife das Escaping nicht mehr.
  const names = seed('de').filter((doc) => doc.mime_type === 'application/pdf').map((doc) => doc.name);
  assert.ok(names.some((name) => /[()]/.test(name)), `ein Titel mit Klammern: ${names.join(' | ')}`);
  assert.ok(names.some((name) => /[äöüß]/.test(name)), `ein Titel mit Umlaut: ${names.join(' | ')}`);
});

// ── Demo-Inhalt (R21, Critique 2026-10-21, D14) ──────────────────────────────
// Der Seed ist die Grundlage der README-Screenshots. Er zeigte drei Dinge, die
// es in einem echten Haushalt nicht gibt: eine "Checkliste" aus der Glyphe □
// (Text, kein Kaestchen), englische Darreichungsformen in der deutschen Demo
// und Kinderkonten ohne die Startrechte, die die App jedem neuen Kind gibt -
// Emma sah Kontostaende, Loehne der Haushaltshilfe, Zyklus und Fasten.

function readSeeded(locale, query) {
  seed(locale);
  const db = new Database(dbPath, { readonly: true });
  try {
    return query(db);
  } finally {
    db.close();
  }
}

// R24, Critique G2 P3-2 / G2 P3-3 / G3 P3-3: der Seed provozierte Fehlbilder.
// Eltern lasen im Belohnungsverlauf sechsmal "Aufgabe erledigt" (earn ohne
// task_id, der Server maskiert den Grund dann), der Aufgaben-Verlauf war in
// jeder Demo leer, und nach der Rezept-Uebergabe standen "Zitronen" und
// "Zitrone" nebeneinander auf dem Einkaufszettel.
test('Seed (de): jede Punkte-Gutschrift nennt ihre erledigte Aufgabe, und der Verlauf hat Eintraege', () => {
  const { earns, completions } = readSeeded('de', (db) => ({
    earns: db.prepare(`SELECT l.reason, l.task_id, l.created_at, t.title, t.status, t.points, c.completed_at
      FROM reward_ledger l LEFT JOIN tasks t ON t.id = l.task_id LEFT JOIN task_completions c ON c.task_id = l.task_id
      WHERE l.type = 'earn'`).all(),
    completions: db.prepare(`SELECT t.title, t.status FROM task_completions c JOIN tasks t ON t.id = c.task_id`).all(),
  }));
  assert.ok(earns.length >= 5, `erwartet mehrere Gutschriften, gefunden ${earns.length}`);
  const orphans = earns.filter((e) => e.task_id == null).map((e) => e.reason);
  assert.deepEqual(orphans, [], `Gutschriften ohne Aufgabe: ${orphans.join(', ')}`);
  for (const e of earns) {
    assert.equal(e.status, 'done', `${e.reason}: die Aufgabe ist nicht erledigt`);
    assert.equal(e.reason, e.title, `${e.reason}: Grund und Aufgabentitel weichen ab`);
    assert.ok(e.points > 0, `${e.reason}: die Aufgabe traegt keine Punkte`);
    assert.equal(e.completed_at, e.created_at, `${e.reason}: Verlaufseintrag und Gutschrift zu verschiedenen Zeiten`);
  }
  assert.ok(completions.length >= 5, `der Aufgaben-Verlauf hat ${completions.length} Eintraege`);
  assert.deepEqual(completions.filter((c) => c.status !== 'done').map((c) => c.title), [], 'Verlauf an offenen Aufgaben');
});

test('Seed (de): die Rezept-Uebergabe stellt keine "Zitrone" neben die "Zitronen"', () => {
  const { items, ingredients } = readSeeded('de', (db) => ({
    items: db.prepare('SELECT name FROM shopping_items').all().map((r) => r.name),
    ingredients: db.prepare('SELECT name FROM recipe_ingredients').all().map((r) => r.name),
  }));
  const names = [...new Set([...items, ...ingredients])];
  const stem = (n) => n.toLowerCase().replace(/(en|n|e|s)$/u, '');
  const near = names.filter((a) => names.some((b) => a !== b && stem(a) === stem(b)));
  assert.deepEqual(near, [], `fast gleiche Namen zwischen Einkauf und Rezepten: ${near.join(', ')}`);
});

test('Seed (de): Listen in Notizen sind Markdown, die Gartenliste hakt man ab', () => {
  const notes = readSeeded('de', (db) => db.prepare('SELECT title, content FROM notes').all());
  const glyphs = notes.filter((n) => /^\s*[□☐☑✓✔•]/mu.test(n.content)).map((n) => n.title);
  assert.deepEqual(glyphs, [], `Notizen mit Glyphen statt Markdown-Liste: ${glyphs.join(', ')}`);
  const checklists = notes
    .map((n) => n.content.split('\n').map(matchChecklistLine).filter(Boolean))
    .filter((items) => items.length >= 3);
  assert.ok(checklists.length >= 1, 'keine Notiz mit einer echten Checkliste (- [ ])');
  const items = checklists.flat();
  assert.ok(items.some((i) => i.checked) && items.some((i) => !i.checked),
    'die Checkliste zeigt beide Zustaende, abgehakt und offen');
});

test('Seed (de): Darreichungsformen stehen auf Deutsch', () => {
  const forms = readSeeded('de', (db) => db.prepare('SELECT form FROM medications').all().map((r) => r.form));
  assert.ok(forms.length >= 3, `erwartet mehrere Medikamente, gefunden ${forms.length}`);
  const english = forms.filter((f) => /^(tablets?|capsules?|drops|syrup|spray)$/i.test(f));
  assert.deepEqual(english, [], `englische Formen in der deutschen Demo: ${english.join(', ')}`);
});

test('Seed: Kinder starten mit den Kinder-Startrechten der App', () => {
  const { children, rows, prefs } = readSeeded('en', (db) => ({
    children: db.prepare("SELECT id, username FROM users WHERE family_role = 'child'").all(),
    rows: db.prepare("SELECT subject_id, resource_type, resource_key, access FROM access_permissions WHERE subject_type = 'user'").all(),
    prefs: db.prepare('SELECT key, value FROM sync_config').all(),
  }));
  assert.ok(children.length >= 2, `erwartet zwei Kinderkonten, gefunden ${children.length}`);
  for (const child of children) {
    const mine = rows.filter((r) => r.subject_id === String(child.id));
    for (const [key, access] of Object.entries(CHILD_START_PERMISSIONS.modules)) {
      assert.ok(mine.some((r) => r.resource_type === 'module' && r.resource_key === key && r.access === access),
        `${child.username}: Modul ${key} startet nicht mit ${access}`);
    }
    for (const [key, access] of Object.entries(CHILD_START_PERMISSIONS.capabilities)) {
      assert.ok(mine.some((r) => r.resource_type === 'capability' && r.resource_key === key && r.access === access),
        `${child.username}: Faehigkeit ${key} startet nicht mit ${access}`);
    }
    for (const [key, value] of Object.entries(CHILD_START_PREFERENCES)) {
      const row = prefs.find((p) => p.key === `${key}:user:${child.id}`);
      assert.equal(row?.value, value, `${child.username}: Vorgabe ${key} fehlt`);
    }
  }
});

// "Fast leer" an 10 von 24 Vorratszeilen (Critique a2): fast jeder Bestand lag
// genau auf seinem Minimum, das Signal war Grundfarbe. Dieselbe Regel wie die
// Kuechen-Route (server/routes/kitchen.js): Menge > 0, Minimum gesetzt, Menge <= Minimum.
test('Seed: "Fast leer" ist ein Signal - hoechstens ein Viertel des Vorrats', () => {
  const { total, low } = readSeeded('de', (db) => db.prepare(`
    SELECT COUNT(*) AS total,
           SUM(CASE WHEN quantity > 0 AND min_quantity IS NOT NULL AND quantity <= min_quantity THEN 1 ELSE 0 END) AS low
    FROM pantry_items`).get());
  assert.ok(total >= 15, `erwartet einen vollen Vorrat, gefunden ${total}`);
  assert.ok(low >= 2, `die Demo zeigt den Zustand "Fast leer" (${low})`);
  assert.ok(low / total <= 0.25, `${low} von ${total} Artikeln sind "Fast leer" - mehr als ein Viertel`);
});

// Schichtplan (R22, D21): ohne ihn zeigte die Demo weder die Schichten im
// Kalender noch das Wochenraster des Schichtplans, und jede Critique legte sie
// erst per API an. Gemessen wird die AUFGELOESTE Woche, wie die App sie sieht
// (resolveEntries), nicht die Zeilen der Tabellen.
test('Seed (de): der Schichtplan steht in der laufenden Woche - zwei Personen, ein Tag mit vier Eintraegen', async () => {
  const { resolveEntries } = await import('../server/services/schedule.js');
  const { shortCodeAddsToName } = await import('../public/utils/shift-label.js');
  const data = readSeeded('de', (db) => ({
    types: db.prepare('SELECT * FROM schedule_shift_types').all(),
    patterns: db.prepare('SELECT * FROM schedule_patterns').all(),
    days: db.prepare('SELECT * FROM schedule_pattern_days').all(),
    overrides: db.prepare('SELECT * FROM schedule_overrides').all(),
    extras: db.prepare('SELECT * FROM schedule_extra_shifts').all(),
  }));
  assert.ok(data.types.length >= 4, `erwartet mehrere Schichtarten, gefunden ${data.types.length}`);
  for (const type of data.types) {
    assert.ok(type.short_code && shortCodeAddsToName(type.short_code, type.name), `${type.name}: ein Kuerzel, das etwas sagt`);
  }
  assert.ok(data.types.some((type) => !type.start_time), 'eine Schichtart ohne Uhrzeit (Ganztag)');
  const pad = (n) => String(n).padStart(2, '0');
  const key = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  const monday = new Date();
  monday.setHours(0, 0, 0, 0);
  monday.setDate(monday.getDate() - ((monday.getDay() + 6) % 7));
  const sunday = new Date(monday);
  sunday.setDate(sunday.getDate() + 6);
  const patternDays = new Map();
  for (const row of data.days) {
    const k = `${row.pattern_id}:${row.position}`;
    patternDays.set(k, [...(patternDays.get(k) ?? []), row]);
  }
  const perDay = new Map();
  const people = new Set();
  for (const userId of new Set(data.patterns.map((p) => p.user_id))) {
    const { entries } = resolveEntries({
      from: key(monday), to: key(sunday), userId,
      patterns: data.patterns.filter((p) => p.user_id === userId), patternDays,
      overrides: data.overrides.filter((o) => o.user_id === userId),
    });
    for (const entry of entries.filter((e) => e.shift_type_id)) {
      people.add(userId);
      perDay.set(entry.date_key, (perDay.get(entry.date_key) ?? 0) + 1);
    }
  }
  for (const extra of data.extras) perDay.set(extra.date_key, (perDay.get(extra.date_key) ?? 0) + 1);
  assert.ok(people.size >= 2, `zwei Personen mit Plan in dieser Woche, gefunden ${people.size}`);
  assert.ok(Math.max(0, ...perDay.values()) >= 4, `ein Tag mit vier Eintraegen (Monat: drei Marken und +1): ${JSON.stringify([...perDay])}`);
});

// ── Verschlüsselte Datenbank (#2114) ─────────────────────────────────────────
// Installer-Installationen sind standardmäßig verschlüsselt. Der Seed öffnete
// die Datei ohne Schlüssel und brach mit "file is not a database" ab - auch mit
// DB_ENCRYPTION_KEY in der Umgebung, und `.env` las er gar nicht.

const DB_MODULE_URL = pathToFileURL(resolve(ROOT, 'server/db.js')).href;
const SQLITE_HEADER = Buffer.from('SQLite format 3\0', 'binary');

/** Legt die Datenbank an wie ein erster Serverstart mit Schlüssel: über server/db.js, in einem eigenen Prozess (der Schlüssel wird beim Import gelesen). */
function createEncryptedDb(dir, key) {
  const file = join(dir, 'demo.db');
  const run = spawnSync(process.execPath, ['--input-type=module', '-e', 'await import(process.env.YUVOMI_TEST_DB_MODULE);'], {
    cwd: dir,
    encoding: 'utf8',
    env: { ...process.env, DB_PATH: file, DB_ENCRYPTION_KEY: key, YUVOMI_TEST_DB_MODULE: DB_MODULE_URL },
  });
  assert.equal(run.status, 0, `verschlüsselte DB anlegen:\n${run.stderr}`);
  assert.equal(isPlaintext(file), false, 'die Wegwerf-DB ist wirklich verschlüsselt');
  return file;
}

function isPlaintext(file) {
  const fd = openSync(file, 'r');
  try {
    const head = Buffer.alloc(SQLITE_HEADER.length);
    readSync(fd, head, 0, head.length, 0);
    return head.equals(SQLITE_HEADER);
  } finally {
    closeSync(fd);
  }
}

/** Liest mit Schlüssel, so wie server/db.js ihn setzt (`applyKeyBytes`). */
function usernames(file, key) {
  const db = new Database(file, { readonly: true });
  try {
    db.pragma("cipher = 'sqlcipher'");
    db.pragma(`key="x'${Buffer.from(key, 'utf8').toString('hex')}'"`);
    return db.prepare('SELECT username FROM users ORDER BY username').all().map((row) => row.username);
  } finally {
    db.close();
  }
}

function seedIn(dir, file, env) {
  return spawnSync(process.execPath, [resolve(ROOT, 'scripts/seed-demo.js'), '--db', file, '--locale', 'de'], {
    cwd: dir,
    encoding: 'utf8',
    env,
  });
}

function envWithout(...names) {
  const env = { ...process.env };
  for (const name of names) delete env[name];
  return env;
}

const DEMO_USERS = ['alex', 'emma', 'leo', 'linda', 'maria'];

test('Seed: verschlüsselte DB, Schlüssel aus der Umgebung (#2114)', () => {
  const dir = tempDir('yuvomi-seed-encrypted-');
  const key = randomBytes(32).toString('hex');
  const file = createEncryptedDb(dir, key);

  const run = seedIn(dir, file, { ...envWithout('DB_PATH'), DB_ENCRYPTION_KEY: key });
  assert.equal(run.status, 0, `seed-demo.js lief nicht durch:\n${run.stderr}`);
  assert.equal(isPlaintext(file), false, 'die Datei bleibt verschlüsselt');
  assert.deepEqual(usernames(file, key), DEMO_USERS);
});

test('Seed: verschlüsselte DB, Schlüssel aus .env im Arbeitsverzeichnis wie beim Server (#2114)', () => {
  const dir = tempDir('yuvomi-seed-encrypted-');
  const key = randomBytes(32).toString('hex');
  const file = createEncryptedDb(dir, key);
  writeFileSync(join(dir, '.env'), `DB_ENCRYPTION_KEY=${key}\n`);

  const run = seedIn(dir, file, envWithout('DB_PATH', 'DB_ENCRYPTION_KEY'));
  assert.equal(run.status, 0, `seed-demo.js lief nicht durch:\n${run.stderr}`);
  assert.equal(isPlaintext(file), false, 'die Datei bleibt verschlüsselt');
  assert.deepEqual(usernames(file, key), DEMO_USERS);
});

test('Seed: falscher Schlüssel bricht mit der Meldung des Servers ab und lässt die Datei stehen (#2114)', () => {
  const dir = tempDir('yuvomi-seed-encrypted-');
  const key = randomBytes(32).toString('hex');
  const file = createEncryptedDb(dir, key);

  const run = seedIn(dir, file, { ...envWithout('DB_PATH'), DB_ENCRYPTION_KEY: randomBytes(32).toString('hex') });
  assert.equal(run.status, 1, `stdout: ${run.stdout}\nstderr: ${run.stderr}`);
  assert.match(run.stderr, /Wrong encryption key/, 'die Meldung aus server/db.js, nicht SQLITE_NOTADB');
  assert.doesNotMatch(run.stderr, /\n\s+at /, 'kein Stacktrace');
  assert.deepEqual(usernames(file, key), [], 'mit dem richtigen Schlüssel weiter lesbar, nichts geschrieben');
});

test('Erzeuger: Umlaute, Klammern und Backslash im Titel kommen unverändert zurück', async () => {
  const title = 'Prüfbericht (Größe 35) \\ Ölwechsel';
  const subtitle = 'Öffnende ( und schliessende ) Klammer, Preis 12 € - „zitiert“';
  const buffer = buildDemoPdf({ title, subtitle, lines: ['Zeile (1)', '', 'C:\\Pfad\\Datei'], footer: 'Fuß' });
  assertPdfStructure(buffer, 'umlaute');
  const loaded = await loadWithPdfJs(buffer);
  assert.equal(loaded.numPages, 1);
  assert.equal(loaded.title, title);
  const flat = loaded.text.replace(/\s+/g, ' ');
  for (const expected of [title, subtitle, 'Zeile (1)', 'C:\\Pfad\\Datei', 'Fuß']) {
    assert.ok(flat.includes(expected), `"${expected}" steht auf der Seite, gelesen: ${flat}`);
  }
});

test('Erzeuger: xref-Offsets zählen Bytes, nicht Zeichen', () => {
  // Ein Titel voller Umlaute ist in UTF-16 und in WinAnsi gleich lang, in
  // UTF-8 doppelt so lang. Die Offsets müssen zu den Bytes der Datei passen,
  // egal wie viele Nicht-ASCII-Zeichen davor liegen.
  const plain = buildDemoPdf({ title: 'aaaaaaaaaa', lines: ['oooooooooo'] });
  const umlauts = buildDemoPdf({ title: 'ääääääääää', lines: ['öööööööööö'] });
  assertPdfStructure(plain, 'ascii');
  assertPdfStructure(umlauts, 'umlaute');
  const streamLength = (buffer) => Number(buffer.toString('latin1').match(/\/Length (\d+)/)[1]);
  assert.equal(streamLength(umlauts), streamLength(plain), 'ein Umlaut ist im Inhaltsstrom genau ein Byte');
});

test('Erzeuger: Zeichen ausserhalb von WinAnsi werden zu "?", nie zu einem fremden Byte', async () => {
  assert.deepEqual([...toWinAnsi('aä€')], [0x61, 0xE4, 0x80]);
  assert.deepEqual([...toWinAnsi('Ł日😀')], [0x3F, 0x3F, 0x3F], 'je Zeichen EIN Fragezeichen, auch ausserhalb der BMP');
  assert.deepEqual([...toWinAnsi('a\tb\nc')], [0x61, 0x20, 0x62, 0x20, 0x63], 'Steuerzeichen werden zum Leerzeichen');
  // Zerlegte Form (a + Trema) wird vor dem Kodieren zusammengesetzt.
  assert.deepEqual([...toWinAnsi('a\u0308')], [0xE4]);

  const buffer = buildDemoPdf({ title: 'Łódź 日本 Zeugnis', lines: ['ok'] });
  assertPdfStructure(buffer, 'nicht-winansi');
  const loaded = await loadWithPdfJs(buffer);
  assert.ok(loaded.text.includes('?ód? ?? Zeugnis'), `gelesen: ${loaded.text}`);
  // Die Metadaten tragen den Titel in UTF-16 und verlieren nichts.
  assert.equal(loaded.title, 'Łódź 日本 Zeugnis');
});

test('Erzeuger: dieselbe Eingabe ergibt dieselben Bytes', () => {
  const input = { title: 'Mietvertrag', subtitle: 'Unterschrieben', lines: ['a', 'b'], footer: 'f' };
  assert.ok(buildDemoPdf(input).equals(buildDemoPdf(input)));
});

// Critique R22 (D21, a4 P3): das Inventar stand ohne Beleg, Frist und Wartung
// da - item_documents/_dates/_service_log 0 Zeilen, "Braucht Aufmerksamkeit 0".
test('Seed (de): das Inventar zeigt Beleg, Frist, Kilometerstand und Wartung - und braucht einmal Aufmerksamkeit', async () => {
  const data = readSeeded('de', (db) => ({
    items: db.prepare('SELECT * FROM inventory_items').all(),
    docs: db.prepare(`SELECT i.name AS item, d.name AS doc, d.mime_type FROM inventory_item_documents x
      JOIN inventory_items i ON i.id = x.item_id JOIN family_documents d ON d.id = x.document_id`).all(),
    dates: db.prepare('SELECT * FROM inventory_item_dates').all(),
    log: db.prepare('SELECT * FROM inventory_item_service_log').all(),
  }));
  assert.ok(data.docs.some((r) => r.item === 'Waschmaschine' && /Waschmaschine/.test(r.doc)), 'die Waschmaschine traegt ihren Beleg');
  const car = data.items.find((i) => i.name === 'Familienauto');
  assert.ok(car?.odometer > 0 && car.odometer_unit === 'km', 'das Auto hat einen Kilometerstand');
  assert.ok(data.dates.some((d) => d.item_id === car.id && d.interval_months), 'eine wiederkehrende Frist am Auto');
  assert.ok(data.log.some((l) => l.item_id === car.id && l.odometer > 0), 'ein Eintrag im Wartungsheft');
  const pad = (n) => String(n).padStart(2, '0');
  const now = new Date();
  const today = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
  const soon = new Date(now);
  soon.setDate(soon.getDate() + 30);
  const until = `${soon.getFullYear()}-${pad(soon.getMonth() + 1)}-${pad(soon.getDate())}`;
  // Die Regel der Kennzahl (utils/inventory-warranty.js) zaehlt eine Frist in
  // den naechsten 30 Tagen; genau ein Gegenstand traegt eine.
  const due = new Set(data.dates.filter((d) => d.date >= today && d.date <= until).map((d) => d.item_id));
  assert.deepEqual([...due], [car.id], '"Braucht Aufmerksamkeit" steht auf 1 - das Auto');
});
