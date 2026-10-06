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
 * Ausführen: npm run test:seed-demo-pdfs
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { rmSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';

import Database from 'better-sqlite3-multiple-ciphers';

import { buildDemoPdf, toWinAnsi } from '../scripts/seed-demo-pdf.js';
import { freshTestDbPath } from './tmp-db.js';

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
  const run = spawnSync(
    process.execPath,
    [resolve(ROOT, 'scripts/seed-demo.js'), '--db', dbPath, '--locale', locale],
    { cwd: ROOT, encoding: 'utf8' }
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

test('Seed (de): Umlaute, ß und Klammern sind im Seed wirklich vertreten', () => {
  // Hält den Fall oben ehrlich: verschwände der Titel mit Klammern aus dem
  // Seed, prüfte die Schleife das Escaping nicht mehr.
  const names = seed('de').filter((doc) => doc.mime_type === 'application/pdf').map((doc) => doc.name);
  assert.ok(names.some((name) => /[()]/.test(name)), `ein Titel mit Klammern: ${names.join(' | ')}`);
  assert.ok(names.some((name) => /[äöüß]/.test(name)), `ein Titel mit Umlaut: ${names.join(' | ')}`);
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
