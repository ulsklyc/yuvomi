/**
 * Test: Hand-written ZIP reader (server/services/zip-reader.js)
 * Zweck: Der Leser ist die erste Schranke vor fremdem Code, der per Einstellungen
 *        installiert wird. Jede Ablehnung hat einen stabilen `code`, und genau den
 *        prueft diese Suite - nicht "irgendein Fehler", denn ein Test, der nur auf
 *        einen Wurf prueft, bliebe gruen, wenn der Leser an der falschen Stelle
 *        (oder aus dem falschen Grund) abbricht.
 *
 *        Die Archive werden hier mit einem kleinen ZIP-SCHREIBER gebaut statt aus
 *        Fixture-Dateien: nur so lassen sich die boesartigen Faelle gezielt
 *        herstellen (falsche CRC, ueberlappende Offsets, ZIP64-Marker, Symlink-
 *        Modus), die kein normales Werkzeug schreibt.
 *
 *        Deckt ab: Rundreise byte-genau (stored, deflate, Data-Descriptor, leere
 *        Datei, Binaerdaten, UTF-8-Namen, Kommentar), Zip-Slip in allen Formen,
 *        Symlink und Sonderdateien, Verschluesselung, Methode 12, CRC, ZIP64,
 *        Mehrteiler, Duplikate (exakt, Gross/Klein, NFC) und Datei/Ordner-
 *        Konflikt, Eintragszahl, Bomben (Verhaeltnis, Summe, gelogene Groesse),
 *        ueberlappende Eintraege, Signaturfehler, kein ZIP, Pfadtiefe (Runde 3:
 *        das 4-MB-Archiv mit 2000 x 510 Segmenten, das die Praefixmenge auf
 *        eine Million Schluessel trieb, wird in Millisekunden abgewiesen).
 * Ausführen: node --test test/test-zip-reader.js
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import zlib from 'node:zlib';
import { randomBytes } from 'node:crypto';
import { readZip, readZipArchive, ZipError, ZIP_LIMITS, validateEntryName, isWindowsReservedName } from '../server/services/zip-reader.js';

// ── Minimaler ZIP-Schreiber ──────────────────────────────────────────────────
// Jedes Feld laesst sich ueberschreiben, damit ein Test genau EINE Eigenschaft
// verfaelschen kann und der Rest ein gueltiges Archiv bleibt.
function makeZip(entries, { comment = '', patchEocd } = {}) {
  const locals = [];
  const centrals = [];
  let offset = 0;
  for (const e of entries) {
    const nameBuf = e.rawName ?? Buffer.from(e.name, 'utf8');
    const data = Buffer.isBuffer(e.data) ? e.data : Buffer.from(e.data ?? '', 'utf8');
    const method = e.method ?? 8;
    const comp = e.compressed ?? (method === 8 ? zlib.deflateRawSync(data) : data);
    const crc = (e.crc ?? zlib.crc32(data)) >>> 0;
    // eslint-disable-next-line no-control-regex
    const flags = e.flags ?? (/[^\x00-\x7f]/.test(e.name ?? '') ? 0x0800 : 0);
    const usize = e.usize ?? data.length;
    const csize = e.csize ?? comp.length;
    const dd = Boolean(flags & 0x0008);

    const local = Buffer.alloc(30);
    local.writeUInt32LE(e.localSig ?? 0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(flags, 6);
    local.writeUInt16LE(method, 8);
    local.writeUInt16LE(0x21, 12);
    local.writeUInt32LE(dd ? 0 : crc, 14);
    local.writeUInt32LE(dd ? 0 : csize, 18);
    local.writeUInt32LE(dd ? 0 : usize, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    local.writeUInt16LE(0, 28);
    let desc = Buffer.alloc(0);
    if (dd) {
      desc = Buffer.alloc(16);
      desc.writeUInt32LE(0x08074b50, 0);
      desc.writeUInt32LE(crc, 4);
      desc.writeUInt32LE(csize, 8);
      desc.writeUInt32LE(usize, 12);
    }
    const chunk = Buffer.concat([local, nameBuf, comp, desc]);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(e.madeBy ?? 20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(flags, 8);
    central.writeUInt16LE(method, 10);
    central.writeUInt16LE(0x21, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(csize >>> 0, 20);
    central.writeUInt32LE(usize >>> 0, 24);
    central.writeUInt16LE(nameBuf.length, 28);
    central.writeUInt16LE(e.diskStart ?? 0, 34);
    central.writeUInt32LE((e.externalAttr ?? 0) >>> 0, 38);
    central.writeUInt32LE((e.localOffset ?? offset) >>> 0, 42);
    centrals.push(Buffer.concat([central, nameBuf]));
    locals.push(chunk);
    offset += chunk.length;
  }
  const cd = Buffer.concat(centrals);
  const commentBuf = Buffer.from(comment, 'latin1');
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(cd.length, 12);
  eocd.writeUInt32LE(offset, 16);
  eocd.writeUInt16LE(commentBuf.length, 20);
  patchEocd?.(eocd);
  return Buffer.concat([...locals, cd, eocd, commentBuf]);
}

function rejectsWith(code, buf, limits) {
  assert.throws(() => readZip(buf, limits), (err) => {
    assert.ok(err instanceof ZipError, `expected ZipError, got ${err?.name}: ${err?.message}`);
    assert.equal(err.code, code, `expected code ${code}, got ${err.code} (${err.message})`);
    return true;
  });
}

const UNIX_FILE = (mode) => ({ madeBy: (3 << 8) | 20, externalAttr: (mode << 16) >>> 0 });

// ── Rundreise ────────────────────────────────────────────────────────────────

test('gueltige Archive kommen byte-genau zurueck (stored, deflate, binaer, leer, UTF-8)', () => {
  const binary = randomBytes(100_000);
  const entries = [
    { name: 'module.json', data: '{"id":"demo-mod","entry":"index.js"}' },
    { name: 'index.js', data: 'export default {};\n'.repeat(50), method: 0 },
    { name: 'assets/', data: '', method: 0 },
    { name: 'assets/logo.png', data: binary },
    { name: 'assets/empty.txt', data: '' },
    { name: 'locales/fr-é.json', data: '{"a":"ç"}' },
    { name: 'unix.js', data: 'x', ...UNIX_FILE(0o100644) },
    { name: 'dir-unix/', data: '', method: 0, ...UNIX_FILE(0o040755) },
  ];
  const files = readZip(makeZip(entries));
  assert.deepEqual(files.map((f) => f.name),
    ['module.json', 'index.js', 'assets/logo.png', 'assets/empty.txt', 'locales/fr-é.json', 'unix.js'],
    'Ordnereintraege fallen weg, Reihenfolge bleibt');
  const byName = Object.fromEntries(files.map((f) => [f.name, f.data]));
  assert.ok(byName['assets/logo.png'].equals(binary), 'Binaerdaten byte-genau');
  assert.equal(byName['index.js'].toString(), 'export default {};\n'.repeat(50));
  assert.equal(byName['assets/empty.txt'].length, 0);
  assert.equal(byName['locales/fr-é.json'].toString(), '{"a":"ç"}');
});

test('Data-Descriptor (Bit 3) ist gueltig und wird gelesen', () => {
  const files = readZip(makeZip([
    { name: 'a.js', data: 'alpha', flags: 0x0008 },
    { name: 'b.js', data: 'beta'.repeat(100), flags: 0x0008 },
  ]));
  assert.deepEqual(files.map((f) => f.data.toString()), ['alpha', 'beta'.repeat(100)]);
});

test('EOCD mit Kommentar: Dateien gelesen, Kommentar geliefert', () => {
  const sha = 'a'.repeat(40);
  const { files, comment } = readZipArchive(makeZip([{ name: 'x.js', data: 'x' }], { comment: sha }));
  assert.equal(files.length, 1);
  assert.equal(comment, sha);
});

test('ein Kommentar, der selbst wie eine EOCD-Signatur aussieht, verwirrt die Suche nicht', () => {
  // PK\x05\x06 im Kommentar: der Leser muss die Signatur nehmen, deren
  // Kommentarlaenge exakt am Dateiende endet - die falsche hier behauptet einen
  // leeren Kommentar, hinter ihr steht aber noch Text.
  const fake = `PK\x05\x06${'\0'.repeat(18)}tail`;
  const { files } = readZipArchive(makeZip([{ name: 'x.js', data: 'x' }], { comment: fake }));
  assert.equal(files[0].data.toString(), 'x');
});

// ── Kein ZIP / kaputt ───────────────────────────────────────────────────────

test('kein ZIP: Zufallsbytes, zu kurz, abgeschnitten', () => {
  rejectsWith('not_zip', randomBytes(1000));
  rejectsWith('not_zip', Buffer.alloc(10));
  rejectsWith('not_zip', Buffer.from('not a zip at all, definitely not'));
  const good = makeZip([{ name: 'x.js', data: 'x' }], { comment: 'abc' });
  rejectsWith('not_zip', good.subarray(0, good.length - 1));
  assert.throws(() => readZip('nope'), (e) => e.code === 'not_zip');
});

test('Signatur-Fehler im lokalen Header → corrupt', () => {
  rejectsWith('corrupt', makeZip([{ name: 'x.js', data: 'x', localSig: 0x12345678 }]));
});

test('stored mit csize ≠ usize → corrupt', () => {
  rejectsWith('corrupt', makeZip([{ name: 'x.js', data: 'abc', method: 0, usize: 4 }]));
});

test('Mehrteiliges Archiv → corrupt', () => {
  rejectsWith('corrupt', makeZip([{ name: 'x.js', data: 'x' }], { patchEocd: (b) => b.writeUInt16LE(1, 4) }));
  rejectsWith('corrupt', makeZip([{ name: 'x.js', data: 'x', diskStart: 1 }]));
});

// ── Zip-Slip ────────────────────────────────────────────────────────────────

test('Zip-Slip in jeder Form → unsafe_path', () => {
  for (const name of [
    '../evil.js',
    'a/../../evil.js',
    '/etc/passwd',
    'a\\..\\..\\evil.js',
    '\\evil.js',
    'C:/Windows/evil.js',
    'c:evil.js',
    '//server/share/evil.js',
    'a/./b.js',
    'a//b.js',
    'CON',
    'con.js',
    'sub/LPT1.txt',
    'aux',
    'a/b.js.',
    'a/b.js ',
    'x\u0001.js',
    'file.js:stream',
    `${'a'.repeat(256)}.js`,
    // Runde 1 der Review: was Win32 als Namen ablehnt oder umdeutet.
    'a<b.js', 'a>b.js', 'a"b.js', 'a|b.js', 'a?.js', 'a*.js',
    'CONIN$.js', 'conout$', 'COM¹.js', 'sub/lpt³.txt',
    'LONGFI~1.JS', 'dir~2/x.js',
  ]) {
    rejectsWith('unsafe_path', makeZip([{ name, data: 'x' }]));
  }
});

test('validateEntryName normalisiert Backslashes und erkennt Ordner', () => {
  assert.deepEqual(validateEntryName('a\\b\\c.js'), { path: 'a/b/c.js', isDir: false });
  assert.deepEqual(validateEntryName('a/b/'), { path: 'a/b', isDir: true });
  assert.deepEqual(validateEntryName('CONSOLE.js'), { path: 'CONSOLE.js', isDir: false }, 'nur exakte Geraetenamen');
  assert.deepEqual(validateEntryName('a~b.js'), { path: 'a~b.js', isDir: false }, 'eine Tilde ohne Ziffer ist kein 8.3-Alias');
  assert.deepEqual(validateEntryName('COM10.js'), { path: 'COM10.js', isDir: false });
});

test('isWindowsReservedName: dieselbe Liste fuer Eintraege und fuer die Modul-id', () => {
  for (const name of ['con', 'CON', 'nul', 'aux', 'prn', 'com1', 'LPT9', 'con.js', 'conin$', 'COM¹']) {
    assert.equal(isWindowsReservedName(name), true, name);
  }
  for (const name of ['console', 'com10', 'con-mod', 'nul2', 'a', '']) {
    assert.equal(isWindowsReservedName(name), false, name);
  }
});

// ── Runde 3 der Review: Pfadtiefe ───────────────────────────────────────────
// Jede Grenze in ZIP_LIMITS zaehlte Bytes an Inhalt; die Praefixmenge der
// Duplikatpruefung waechst aber mit der Zahl der ORDNER je Name. Ein Name darf
// 1024 Zeichen lang sein, das sind rund 510 einbuchstabige Ordner; 2000 solche
// Eintraege (die Eintragsgrenze, etwa 4 MB Archiv) machten 1.020.000
// Schluessel, 570 MB Heap und 5 s blockierte Ereignisschleife - und das Archiv
// kam durch jede andere Grenze.

test('mehr als 16 Ordner je Name → unsafe_path, 16 sind erlaubt', () => {
  assert.equal(ZIP_LIMITS.maxDepth, 16);
  const seventeen = `${Array.from({ length: 17 }, (_, i) => `d${i}`).join('/')}/x.js`;
  rejectsWith('unsafe_path', makeZip([{ name: seventeen, data: 'x' }]));
  assert.throws(() => validateEntryName(seventeen), (e) => e.code === 'unsafe_path' && /16 folders deep/.test(e.message));
  const sixteen = `${Array.from({ length: 15 }, (_, i) => `d${i}`).join('/')}/x.js`;
  assert.equal(readZip(makeZip([{ name: sixteen, data: 'x' }])).length, 1, '16 Segmente (15 Ordner + Datei) gehen durch');
  // Ein Ordnereintrag zaehlt seine Segmente ohne den Schlussstrich.
  assert.deepEqual(validateEntryName(`${Array.from({ length: 16 }, (_, i) => `d${i}`).join('/')}/`).isDir, true);
  assert.throws(() => validateEntryName(`${Array.from({ length: 17 }, (_, i) => `d${i}`).join('/')}/`), (e) => e.code === 'unsafe_path');
});

test('das Archiv aus der Review (2000 Eintraege x 510 Segmente, 4 MB) wird in unter 100 ms abgewiesen, ohne Praefixmenge', () => {
  // Erstes Segment je Eintrag verschieden (sonst Duplikate), danach "a/" -
  // zwei Zeichen je Ordner, 1023 Zeichen je Name, unter der Laengengrenze.
  const entries = Array.from({ length: 2000 }, (_, i) => ({
    name: [i.toString(36).padStart(2, '0'), ...Array.from({ length: 508 }, () => 'a'), 'f.js'].join('/'),
    data: 'x',
    method: 0,
  }));
  const zip = makeZip(entries);
  assert.ok(zip.length > 3 * 1024 * 1024 && zip.length < ZIP_LIMITS.maxCompressed, `${zip.length} Bytes: das Archiv selbst ist unauffaellig`);
  const heapBefore = process.memoryUsage().heapUsed;
  const started = process.hrtime.bigint();
  rejectsWith('unsafe_path', zip);
  const ms = Number(process.hrtime.bigint() - started) / 1e6;
  const heapGrowth = (process.memoryUsage().heapUsed - heapBefore) / (1024 * 1024);
  // Vor der Grenze: 5400 ms und +569 MB. Die Grenzen hier sind weit, damit ein
  // langsamer CI-Laeufer nicht rot wird; die Praefixmenge allein laege um das
  // Hundertfache darueber.
  assert.ok(ms < 100, `abgewiesen nach ${ms.toFixed(1)} ms - der erste Eintrag muss reichen`);
  assert.ok(heapGrowth < 64, `Heap wuchs um ${heapGrowth.toFixed(1)} MB - die Praefixmenge wurde gebaut`);
});

test('Nicht-ASCII-Name ohne UTF-8-Flag → unsafe_path; mit Flag ok', () => {
  rejectsWith('unsafe_path', makeZip([{ name: 'x', rawName: Buffer.from([0xe9, 0x2e, 0x6a, 0x73]), flags: 0, data: 'x' }]));
  // Ungueltiges UTF-8 trotz Flag ist ebenso unsicher.
  rejectsWith('unsafe_path', makeZip([{ name: 'x', rawName: Buffer.from([0xff, 0x2e, 0x6a, 0x73]), flags: 0x0800, data: 'x' }]));
  const files = readZip(makeZip([{ name: 'é.js', data: 'x' }]));
  assert.equal(files[0].name, 'é.js');
});

// ── Dateitypen ──────────────────────────────────────────────────────────────

test('Symlink-Eintrag → symlink', () => {
  rejectsWith('symlink', makeZip([{ name: 'link.js', data: '/etc/passwd', method: 0, ...UNIX_FILE(0o120777) }]));
});

test('FIFO/Geraete/Socket → unsafe_path', () => {
  for (const mode of [0o010644, 0o020644, 0o060644, 0o140644]) {
    rejectsWith('unsafe_path', makeZip([{ name: 'odd', data: '', method: 0, ...UNIX_FILE(mode) }]));
  }
});

test('Verschluesselung (Bit 0 und Bit 6) → encrypted', () => {
  rejectsWith('encrypted', makeZip([{ name: 'x.js', data: 'x', flags: 0x0001 }]));
  rejectsWith('encrypted', makeZip([{ name: 'x.js', data: 'x', flags: 0x0041 }]));
  rejectsWith('encrypted', makeZip([{ name: 'x.js', data: 'x', flags: 0x0040 }]));
});

test('Methode 12 (bzip2) → method', () => {
  rejectsWith('method', makeZip([{ name: 'x.js', data: 'x', method: 12, compressed: Buffer.from('BZh9') }]));
});

test('CRC-Abweichung → crc', () => {
  rejectsWith('crc', makeZip([{ name: 'x.js', data: 'hello', crc: 12345 }]));
  rejectsWith('crc', makeZip([{ name: 'x.js', data: 'hello', method: 0, crc: 1 }]));
});

test('ZIP64-Marker in EOCD oder Eintrag → zip64', () => {
  rejectsWith('zip64', makeZip([{ name: 'x.js', data: 'x' }], { patchEocd: (b) => { b.writeUInt16LE(0xffff, 8); b.writeUInt16LE(0xffff, 10); } }));
  rejectsWith('zip64', makeZip([{ name: 'x.js', data: 'x' }], { patchEocd: (b) => b.writeUInt32LE(0xffffffff, 16) }));
  rejectsWith('zip64', makeZip([{ name: 'x.js', data: 'x', csize: 0xffffffff }]));
  rejectsWith('zip64', makeZip([{ name: 'x.js', data: 'x', localOffset: 0xffffffff }]));
});

// ── Duplikate ───────────────────────────────────────────────────────────────

test('Duplikat, Gross/Klein-Duplikat und NFC-Duplikat → duplicate', () => {
  rejectsWith('duplicate', makeZip([{ name: 'a.js', data: '1' }, { name: 'a.js', data: '2' }]));
  rejectsWith('duplicate', makeZip([{ name: 'Index.js', data: '1' }, { name: 'index.js', data: '2' }]));
  rejectsWith('duplicate', makeZip([{ name: 'e\u0301.js', data: '1' }, { name: '\u00e9.js', data: '2' }]));
  rejectsWith('duplicate', makeZip([{ name: 'a\\b.js', data: '1' }, { name: 'a/b.js', data: '2' }]));
});

test('Datei, die zugleich Ordner-Praefix einer anderen ist → duplicate', () => {
  rejectsWith('duplicate', makeZip([{ name: 'lib', data: 'x' }, { name: 'lib/a.js', data: 'y' }]));
  rejectsWith('duplicate', makeZip([{ name: 'lib/a.js', data: 'y' }, { name: 'LIB', data: 'x' }]));
  rejectsWith('duplicate', makeZip([{ name: 'lib/', data: '', method: 0 }, { name: 'lib', data: 'x' }]));
});

// ── Grenzen ─────────────────────────────────────────────────────────────────

test('zu viele Eintraege → too_many_entries (Grenze injizierbar und Vorgabe 2000)', () => {
  const four = makeZip([1, 2, 3, 4].map((i) => ({ name: `f${i}.js`, data: 'x', method: 0 })));
  rejectsWith('too_many_entries', four, { maxEntries: 3 });
  assert.equal(readZip(four, { maxEntries: 4 }).length, 4);
  const many = makeZip(Array.from({ length: 2001 }, (_, i) => ({ name: `f${i}.txt`, data: '', method: 0 })));
  rejectsWith('too_many_entries', many);
});

test('zu grosses Archiv und zu grosse Einzeldatei → too_large', () => {
  const zip = makeZip([{ name: 'x.js', data: 'x'.repeat(2000) }]);
  rejectsWith('too_large', zip, { maxCompressed: zip.length - 1 });
  rejectsWith('too_large', makeZip([{ name: 'x.js', data: 'x'.repeat(2000) }]), { maxFileSize: 1999 });
});

test('Bombe: Verhaeltnis > 200:1 ueber 1 MiB → bomb', () => {
  rejectsWith('bomb', makeZip([{ name: 'zeros.bin', data: Buffer.alloc(2 * 1024 * 1024) }]));
  // Unter der Schwelle zaehlt das Verhaeltnis nicht: kleine, gut komprimierbare
  // Dateien sind normal.
  assert.equal(readZip(makeZip([{ name: 'zeros.bin', data: Buffer.alloc(512 * 1024) }])).length, 1);
});

test('Bombe: Summe der entpackten Groessen → bomb', () => {
  rejectsWith('bomb', makeZip([{ name: 'a.txt', data: 'a'.repeat(60) }, { name: 'b.txt', data: 'b'.repeat(60) }]), { maxTotal: 100 });
});

test('Bombe: gelogene Groesse (mehr Daten als deklariert) → bomb', () => {
  const data = Buffer.from('y'.repeat(5000));
  rejectsWith('bomb', makeZip([{ name: 'liar.txt', data, usize: 10, crc: zlib.crc32(data.subarray(0, 10)) }]));
});

test('weniger Daten als deklariert → corrupt', () => {
  const data = Buffer.from('short');
  rejectsWith('corrupt', makeZip([{ name: 'x.txt', data, usize: 50 }]));
});

test('ueberlappende lokale Offsets → corrupt', () => {
  // Zwei Verzeichniseintraege zeigen auf dieselben Bytes - die Bauweise
  // nicht-rekursiver Zip-Bomben.
  rejectsWith('corrupt', makeZip([{ name: 'a.js', data: 'same' }, { name: 'b.js', data: 'same', localOffset: 0 }]));
});

// ── Runde 1 der Review: Endsatz, Gesamtverhaeltnis ──────────────────────────

test('zwei gueltige Endsaetze → corrupt (mehrdeutig), statt einen zu raten', () => {
  // Der echte Endsatz traegt als Kommentar einen zweiten, der ebenfalls am
  // Dateiende endet UND dessen Verzeichnis genau vor ihm aufhoert - zwei
  // Werkzeuge koennten zwei verschiedene Dateilisten sehen.
  const plain = makeZip([{ name: 'x.js', data: 'x' }]);
  const realPos = plain.length - 22;
  const cdOffset = plain.readUInt32LE(realPos + 16);
  const fake = Buffer.alloc(22);
  fake.writeUInt32LE(0x06054b50, 0);
  fake.writeUInt32LE(realPos + 22 - cdOffset, 12);
  fake.writeUInt32LE(cdOffset, 16);
  const zip = makeZip([{ name: 'x.js', data: 'x' }], { comment: fake.toString('latin1') });
  rejectsWith('corrupt', zip);
});

test('vorangestellte Daten ohne angepasste Offsets → corrupt: das Verzeichnis endet nicht am Endsatz', () => {
  rejectsWith('corrupt', Buffer.concat([Buffer.alloc(100, 0x41), makeZip([{ name: 'x.js', data: 'x' }])]));
});

test('Bombe: viele kleine Dateien unter der Einzelschwelle → bomb ueber das Gesamtverhaeltnis', () => {
  const files = Array.from({ length: 5 }, (_, i) => ({ name: `z${i}.bin`, data: Buffer.alloc(900) }));
  // Jede Datei bleibt unter ratioThreshold, zusammen liegen sie darueber.
  rejectsWith('bomb', makeZip(files), { ratioThreshold: 1000, maxRatio: 5 });
  // Schlecht komprimierbare Daten derselben Menge kommen durch.
  const noise = Array.from({ length: 5 }, (_, i) => ({ name: `r${i}.bin`, data: randomBytes(900) }));
  assert.equal(readZip(makeZip(noise), { ratioThreshold: 1000, maxRatio: 5 }).length, 5);
  // Die Vorgaben: 49 x 1 MiB Nullen (je genau an der Schwelle) sind eine Bombe.
  const mib = Array.from({ length: 49 }, (_, i) => ({ name: `m${i}.bin`, data: Buffer.alloc(1024 * 1024) }));
  rejectsWith('bomb', makeZip(mib));
});
