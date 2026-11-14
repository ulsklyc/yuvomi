/**
 * Modul: Dateisignatur-Test
 * Zweck: Prüft, dass `server/utils/file-signature.js` einen falsch deklarierten
 *        Upload erkennt, einen echten durchlässt und einen Typ ohne Signatur
 *        nicht aus Versehen ablehnt (#937).
 *
 *        Die dritte Zusicherung ist die, die am leichtesten kippt: Wenn
 *        contentMatchesMime für `text/plain` je `false` liefern würde, könnte
 *        niemand mehr eine Notiz oder eine CSV hochladen - ein Ausfall, den ein
 *        Test über Binärformate allein nicht bemerkt.
 * Ausführen: node --test test/test-file-signature.js
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { contentMatchesMime, hasSignature, dataUrlContentMatches } from '../server/utils/file-signature.js';

// Echte Dateiköpfe, so kurz wie möglich - der Rest der Datei spielt keine Rolle.
const HEADS = {
  'application/pdf': Buffer.from('%PDF-1.7\n%\xE2\xE3\xCF\xD3\n1 0 obj', 'binary'),
  'image/png': Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x0d]),
  'image/jpeg': Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46]),
  'image/webp': Buffer.concat([Buffer.from('RIFF'), Buffer.from([0x24, 0x10, 0, 0]), Buffer.from('WEBPVP8 ')]),
  'image/gif': Buffer.from('GIF89a\x10\x00\x10\x00', 'binary'),
  'application/msword': Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]),
  'application/vnd.ms-excel': Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]),
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document':
    Buffer.from([0x50, 0x4b, 0x03, 0x04, 0x14, 0x00, 0x06, 0x00]),
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet':
    Buffer.from([0x50, 0x4b, 0x03, 0x04, 0x14, 0x00, 0x06, 0x00]),
};

test('echte Köpfe werden als ihr eigener Typ erkannt', () => {
  for (const [mime, head] of Object.entries(HEADS)) {
    assert.equal(contentMatchesMime(head, mime), true, `${mime} wurde abgelehnt`);
  }
});

test('ein Kopf gilt nicht für einen anderen Typ', () => {
  // Paarweise: jeder Kopf gegen jeden fremden Typ. OLE- und ZIP-Formate teilen
  // sich ihre Hülle - Word und Excel sind von außen dasselbe -, deshalb zählt
  // hier nur, ob die SIGNATUR abweicht, nicht der MIME-String.
  const sameShell = [
    new Set(['application/msword', 'application/vnd.ms-excel']),
    new Set([
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    ]),
  ];
  const shared = (a, b) => sameShell.some((set) => set.has(a) && set.has(b));

  for (const [mimeA, head] of Object.entries(HEADS)) {
    for (const mimeB of Object.keys(HEADS)) {
      if (mimeA === mimeB || shared(mimeA, mimeB)) continue;
      assert.equal(contentMatchesMime(head, mimeB), false,
        `${mimeA}-Kopf wurde als ${mimeB} akzeptiert`);
    }
  }
});

test('der Angriff aus dem Bericht: HTML, das sich als Bild ausgibt', () => {
  const html = Buffer.from('<html><script>alert(1)</script></html>');
  assert.equal(contentMatchesMime(html, 'image/png'), false);
  assert.equal(contentMatchesMime(html, 'application/pdf'), false);
  assert.equal(contentMatchesMime(html, 'image/webp'), false);
});

test('Typen ohne Signatur passieren - Text hat keinen Kopf', () => {
  // Ginge das je auf false, wäre jede Notiz und jede CSV unhochladbar.
  assert.equal(hasSignature('text/plain'), false);
  assert.equal(hasSignature('text/csv'), false);
  for (const mime of ['text/plain', 'text/csv']) {
    assert.equal(contentMatchesMime(Buffer.from('a;b;c\n1;2;3'), mime), true);
    // Auch Inhalt, der wie HTML aussieht: eine CSV darf spitze Klammern führen.
    assert.equal(contentMatchesMime(Buffer.from('<nicht wirklich html>'), mime), true);
  }
});

test('PDF mit Vorlauf wird erkannt, PDF ohne Kennung nicht', () => {
  // Mailer und Scanner hängen Bytes vor den Header; Adobe selbst erlaubt das.
  const padded = Buffer.concat([Buffer.alloc(600, 0x20), Buffer.from('%PDF-1.4')]);
  assert.equal(contentMatchesMime(padded, 'application/pdf'), true);
  // Jenseits von 1024 Bytes ist es keine gültige Datei mehr - und nicht erkannt.
  const tooFar = Buffer.concat([Buffer.alloc(1200, 0x20), Buffer.from('%PDF-1.4')]);
  assert.equal(contentMatchesMime(tooFar, 'application/pdf'), false);
});

test('PDF: der Marker darf am Rand des Fensters stehen', () => {
  // Die erste Fassung schnitt bei genau 1024 und zerteilte damit einen Marker,
  // der bei Byte 1020 beginnt - also ausgerechnet die Dateien, fuer die die
  // Toleranz da ist. Der Rand wird deshalb einzeln geprueft.
  const at = (n) => Buffer.concat([Buffer.alloc(n, 0x20), Buffer.from('%PDF-1.4')]);
  for (const n of [0, 600, 1019, 1020, 1023, 1024]) {
    assert.equal(contentMatchesMime(at(n), 'application/pdf'), true, `Versatz ${n} abgelehnt`);
  }
  for (const n of [1025, 1200]) {
    assert.equal(contentMatchesMime(at(n), 'application/pdf'), false, `Versatz ${n} akzeptiert`);
  }
});

test('SVG wird auf seine Form geprueft, nicht durchgewunken', () => {
  // SVG ist Text und hat keine Magic Bytes, steht aber im `accept` des
  // Abo-Logos. Ohne eigene Pruefung fiele es unter "unbekannter Typ" und damit
  // unter das absichtliche `true` - HTML als SVG deklariert waere gespeichert
  // worden.
  const ok = [
    '<svg xmlns="http://www.w3.org/2000/svg"/>',
    '<?xml version="1.0"?>\n<svg viewBox="0 0 1 1"></svg>',
    '\uFEFF  \n<svg />',
    '<!-- (c) 2026 -->\n<svg></svg>',
    '<!DOCTYPE svg PUBLIC "x"><svg></svg>',
  ];
  for (const src of ok) {
    assert.equal(contentMatchesMime(Buffer.from(src), 'image/svg+xml'), true, src.slice(0, 30));
  }
  const nope = [
    '<html><script>alert(1)</script></html>',
    '<!DOCTYPE html><html><body></body></html>',
    'nur text, kein markup',
    '<?xml version="1.0"?><rss></rss>',
  ];
  for (const src of nope) {
    assert.equal(contentMatchesMime(Buffer.from(src), 'image/svg+xml'), false, src.slice(0, 30));
  }
});

test('dataUrlContentMatches liest den base64-Flag case-insensitiv', () => {
  // Ein data-URL-Leser dekodiert `;BASE64,` genauso. Ein exakter Test haette
  // sich mit einer Grossschreibung umgehen lassen - von genau dem, der etwas
  // zu verbergen hat.
  const png = 'iVBORw0KGgo=';
  assert.equal(dataUrlContentMatches(`data:image/png;BASE64,${png}`), true);
  assert.equal(dataUrlContentMatches(`data:image/png;Base64,${png}`), true);
  const html = Buffer.from('<html>').toString('base64');
  assert.equal(dataUrlContentMatches(`data:image/png;BASE64,${html}`), false,
    'Grossschreibung darf die Pruefung nicht umgehen');
});

test('leerer Inhalt erfüllt keine Signatur', () => {
  assert.equal(contentMatchesMime(Buffer.alloc(0), 'image/png'), false);
  assert.equal(contentMatchesMime(null, 'image/png'), false);
  // ...aber ein Typ ohne Signatur wird auch leer nicht von HIER abgelehnt;
  // die Längenprüfung ist Sache des Aufrufers.
  assert.equal(contentMatchesMime(Buffer.alloc(0), 'text/plain'), true);
});

test('image/jpg gilt wie image/jpeg', () => {
  // Nicht registriert, kommt aber aus älteren Clients und steht in PHOTO_RE.
  assert.equal(contentMatchesMime(HEADS['image/jpeg'], 'image/jpg'), true);
  assert.equal(contentMatchesMime(HEADS['image/png'], 'image/jpg'), false);
});

test('Groß-/Kleinschreibung des Typs spielt keine Rolle', () => {
  assert.equal(contentMatchesMime(HEADS['image/png'], 'IMAGE/PNG'), true);
});

// --------------------------------------------------------
// data-URL-Pfad (Bild-Uploads, die den String behalten)
// --------------------------------------------------------

const dataUrl = (mime, buf) => `data:${mime};base64,${buf.toString('base64')}`;

test('dataUrlContentMatches: echtes Bild ja, vertauschter Typ nein', () => {
  assert.equal(dataUrlContentMatches(dataUrl('image/png', HEADS['image/png'])), true);
  assert.equal(dataUrlContentMatches(dataUrl('image/png', HEADS['image/jpeg'])), false);
  assert.equal(dataUrlContentMatches(dataUrl('image/webp', Buffer.from('<svg onload=alert(1)>'))), false);
});

test('dataUrlContentMatches: nur der Kopf wird dekodiert, nicht die ganze Datei', () => {
  // 4 MB Bild: die Prüfung darf nicht an der Größe hängen.
  const big = Buffer.concat([HEADS['image/png'], Buffer.alloc(4 * 1024 * 1024, 7)]);
  assert.equal(dataUrlContentMatches(dataUrl('image/png', big)), true);
});

test('dataUrlContentMatches: was keine base64-data-URL ist, ist kein Bild', () => {
  for (const bad of ['', null, undefined, 'https://example.com/x.png', 'data:image/png,roh']) {
    assert.equal(dataUrlContentMatches(bad), false, `${bad} wurde akzeptiert`);
  }
});

test('dataUrlContentMatches: Zeilenumbrüche im base64 stören nicht', () => {
  // Manche Clients falten lange data-URLs.
  const folded = dataUrl('image/png', HEADS['image/png']).replace(/,/, ',\n  ');
  assert.equal(dataUrlContentMatches(folded), true);
});

// --------------------------------------------------------
// Verdrahtung: greift die Regel ueberall, wo hochgeladen wird?
// --------------------------------------------------------
// Die Unit-Tests oben pruefen die Regel. Sie bleiben gruen, wenn jemand den
// Aufruf aus einer Route entfernt oder eine SECHSTE Upload-Route baut, die ihn
// nie hatte - und genau so ist die Luecke aus #937 entstanden: fuenf Stellen,
// fuenf eigene Regexe, jede glaubte dem Praefix. Deshalb hier eine Regel ueber
// alle Routen statt einer Allowlist, die beim naechsten Modul veraltet.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROUTES_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'server', 'routes');

/** Alle .js unter server/routes/, auch in Unterordnern. */
function routeFiles(dir = ROUTES_DIR) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return routeFiles(full);
    // .ts too: a route file written in TypeScript (phase 2 onward) is a route file.
    return /\.(js|ts)$/.test(entry.name) ? [path.relative(ROUTES_DIR, full)] : [];
  });
}

// Nimmt diese Datei Dateiinhalt als data-URL entgegen? Erkannt am Merkmal, das
// alle fuenf teilen: sie pruefen ein `data:`-Praefix oder eine MIME-Allowlist.
const ACCEPTS_UPLOAD = /data:image\/|data:\(\[\^|ALLOWED_MIME|;base64,/;

// Der AUFRUF, nicht der Name. Die erste Fassung suchte den blossen Bezeichner
// und zaehlte damit die Import-Zeile als Beleg: die Gegenprobe - Aufruf raus,
// Import stehen lassen - blieb gruen, also genau im Fehlerzustand. Gesucht wird
// deshalb `name(` mit einem Argument, und Import-Zeilen fallen vorher weg.
const CHECKS_CONTENT = /\b(?:contentMatchesMime|dataUrlContentMatches)\s*\([^)]/;
const withoutImports = (src) => src.replace(/^\s*import\s[^;]*;/gm, '');

test('jede Route, die eine data-URL annimmt, prueft auch deren Inhalt', () => {
  const offenders = [];
  let checked = 0;
  for (const file of routeFiles()) {
    const src = fs.readFileSync(path.join(ROUTES_DIR, file), 'utf8');
    if (!ACCEPTS_UPLOAD.test(src)) continue;
    checked++;
    if (!CHECKS_CONTENT.test(withoutImports(src))) offenders.push(file);
  }
  // Die Zahl steht hier, weil eine leere Liste zweierlei heissen kann: alles
  // sauber, oder der Sucher findet nichts mehr. Sie darf steigen (neue
  // Upload-Route), aber nicht unter die sieben fallen, die es gibt.
  //
  // Sie stand auf fuenf, und das war die Zahl, die der Sucher SAH: er las nur
  // die unmittelbaren Kinder von server/routes/. Zwei Upload-Pfade liegen aber
  // eine Ebene tiefer - `inventory/items.js` (Inventarfoto) und
  // `calendar/helpers.js` (Termin-Anhang) -, und beide nahmen ihre data-URL
  // ungeprueft entgegen, waehrend dieser Test gruen behauptete, es gebe keine
  // solche Stelle mehr. Eine Zahl, die aus derselben blinden Quelle kommt wie
  // die Pruefung, bestaetigt nur deren blinden Fleck.
  assert.ok(checked >= 7, `nur ${checked} Upload-Routen gefunden - der Sucher greift nicht mehr`);
  assert.deepEqual(offenders, [], `Upload-Routen ohne Inhaltspruefung: ${offenders.join(', ')}`);
});
