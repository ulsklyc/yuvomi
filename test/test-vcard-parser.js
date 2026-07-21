/**
 * test-vcard-parser.js - Parser fuer vCard-Import (public/utils/vcard.js)
 * Zweck: Split in Einzelkarten + Feldextraktion (inkl. Geburtstag), insb.
 *        Multi-Kontakt-Dateien.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  splitVCards, parseVCard, parseVCards, parseBirthdayValue,
} from '../public/utils/vcard.js';

const CARD = (fn, tel) =>
  `BEGIN:VCARD\r\nVERSION:3.0\r\nFN:${fn}\r\nTEL:${tel}\r\nEND:VCARD`;

test('splitVCards trennt mehrere Karten', () => {
  const text = `${CARD('Ada Lovelace', '111')}\r\n${CARD('Alan Turing', '222')}`;
  const parts = splitVCards(text);
  assert.equal(parts.length, 2);
  assert.match(parts[0], /Ada Lovelace/);
  assert.match(parts[1], /Alan Turing/);
});

test('splitVCards ohne BEGIN/END behandelt Gesamttext als eine Karte', () => {
  assert.deepEqual(splitVCards('FN:Solo'), ['FN:Solo']);
  assert.deepEqual(splitVCards('   '), []);
});

test('parseVCards liefert einen Kontakt pro Karte mit distinkten Feldern', () => {
  const text = `${CARD('Ada Lovelace', '111')}\r\n${CARD('Alan Turing', '222')}`;
  const list = parseVCards(text);
  assert.equal(list.length, 2);
  assert.equal(list[0].name, 'Ada Lovelace');
  assert.equal(list[0].phone, '111');
  assert.equal(list[1].name, 'Alan Turing');
  assert.equal(list[1].phone, '222');
});

test('parseVCard extrahiert FN, TEL, EMAIL, ADR, NOTE', () => {
  const text = [
    'BEGIN:VCARD', 'VERSION:3.0', 'FN:Grace Hopper',
    'TEL;TYPE=CELL:555-9', 'EMAIL:grace@navy.mil',
    'ADR;TYPE=HOME:;;123 Cobol St;Arlington;VA;22201;USA',
    'NOTE:Erfinderin', 'END:VCARD',
  ].join('\r\n');
  const c = parseVCard(text);
  assert.equal(c.name, 'Grace Hopper');
  assert.equal(c.phone, '555-9');
  assert.equal(c.email, 'grace@navy.mil');
  assert.equal(c.address, '123 Cobol St, Arlington, VA, 22201, USA');
  assert.equal(c.notes, 'Erfinderin');
});

test('parseVCard leitet den Namen aus N ab, faellt sonst auf FN zurueck (#535)', () => {
  const withN = parseVCard('BEGIN:VCARD\r\nFN:Doe, Jane\r\nN:Doe;Jane;;;\r\nEND:VCARD');
  assert.equal(withN.firstName, 'Jane');
  assert.equal(withN.lastName, 'Doe');
  // N schlaegt FN: einheitlich "Vorname Nachname" statt der Quell-Formatierung.
  assert.equal(withN.name, 'Jane Doe');

  const onlyFn = parseVCard('BEGIN:VCARD\r\nFN:Jane Doe\r\nEND:VCARD');
  assert.equal(onlyFn.name, 'Jane Doe');
  assert.equal(onlyFn.lastName, null);

  const noName = 'BEGIN:VCARD\r\nTEL:1\r\nEND:VCARD';
  assert.equal(parseVCard(noName).name, null);
});

test('parseVCard traegt Titel/Zweitname/Suffix aus N, ohne sie anzuzeigen (#535)', () => {
  const c = parseVCard('BEGIN:VCARD\r\nN:Müller;Hans;Peter;Dr.;jr.\r\nEND:VCARD');
  assert.equal(c.namePrefix, 'Dr.');
  assert.equal(c.middleName, 'Peter');
  assert.equal(c.nameSuffix, 'jr.');
  assert.equal(c.name, 'Hans Peter Müller');
});

test('parseVCard entfaltet gefaltete Zeilen (RFC 6350)', () => {
  const folded = 'BEGIN:VCARD\r\nNOTE:Zeile eins\r\n  und zwei\r\nEND:VCARD';
  assert.equal(parseVCard(folded).notes, 'Zeile eins und zwei');
});

test('parseVCard nutzt resolveCategory, sonst fallbackCategory', () => {
  const text = 'BEGIN:VCARD\r\nFN:X\r\nCATEGORIES:Friends\r\nEND:VCARD';
  const resolved = parseVCard(text, {
    resolveCategory: (raw) => (raw.toLowerCase().includes('friends') ? 'friends' : null),
    fallbackCategory: 'misc',
  });
  assert.equal(resolved.category, 'friends');
  const fallback = parseVCard('BEGIN:VCARD\r\nFN:Y\r\nEND:VCARD', { fallbackCategory: 'misc' });
  assert.equal(fallback.category, 'misc');
});

test('parseBirthdayValue normalisiert diverse Formate auf ISO', () => {
  assert.equal(parseBirthdayValue('1990-07-18'), '1990-07-18');
  assert.equal(parseBirthdayValue('19900718'), '1990-07-18');
  assert.equal(parseBirthdayValue('1990'), '1990-01-01');
  // Zeitanteil wird nicht unterstuetzt (identisch zu CardDAV parseBirthday):
  // die Bereinigung laesst "1990-07-1800000000" -> kein Muster -> null.
  assert.equal(parseBirthdayValue('1990-07-18T00:00:00Z'), null);
  assert.equal(parseBirthdayValue('--0718'), null); // jahrlos: bewusst nicht unterstuetzt (wie CardDAV)
  assert.equal(parseBirthdayValue(''), null);
  assert.equal(parseBirthdayValue(null), null);
});

test('parseVCard extrahiert BDAY nach birthday (ISO)', () => {
  const iso = parseVCard('BEGIN:VCARD\r\nFN:B\r\nBDAY:1985-03-09\r\nEND:VCARD');
  assert.equal(iso.birthday, '1985-03-09');
  const compact = parseVCard('BEGIN:VCARD\r\nFN:B\r\nBDAY;VALUE=DATE:19850309\r\nEND:VCARD');
  assert.equal(compact.birthday, '1985-03-09');
  const none = parseVCard('BEGIN:VCARD\r\nFN:B\r\nEND:VCARD');
  assert.equal(none.birthday, null);
});

test('parseVCards traegt Geburtstag pro Karte separat', () => {
  const text = [
    'BEGIN:VCARD\r\nFN:Erste\r\nBDAY:2000-01-02\r\nEND:VCARD',
    'BEGIN:VCARD\r\nFN:Zweite\r\nEND:VCARD',
  ].join('\r\n');
  const list = parseVCards(text);
  assert.equal(list[0].birthday, '2000-01-02');
  assert.equal(list[1].birthday, null);
});

test('parseVCard dekodiert Quoted-Printable-Namen (vCard 2.1, tuerkische Zeichen)', () => {
  // "ı" = U+0131 = UTF-8 C4 B1 ; "ş" = U+015F = UTF-8 C5 9F. Ohne QP-Dekodierung
  // landete der ganze Name buchstaeblich als "Kalayc=C4=B1" im Kontakt.
  const text = [
    'BEGIN:VCARD', 'VERSION:2.1',
    'N;CHARSET=UTF-8;ENCODING=QUOTED-PRINTABLE:Kalayc=C4=B1;Ula=C5=9F;;;',
    'FN;CHARSET=UTF-8;ENCODING=QUOTED-PRINTABLE:Ula=C5=9F Kalayc=C4=B1',
    'END:VCARD',
  ].join('\r\n');
  const c = parseVCard(text);
  assert.equal(c.lastName, 'Kalaycı');
  assert.equal(c.firstName, 'Ulaş');
  assert.equal(c.name, 'Ulaş Kalaycı');
});

test('parseVCard zieht Quoted-Printable-Soft-Line-Breaks zusammen', () => {
  // Der QP-Wert laeuft ueber zwei physische Zeilen; die erste endet mit '='.
  const text = [
    'BEGIN:VCARD', 'VERSION:2.1',
    'N;ENCODING=QUOTED-PRINTABLE;CHARSET=UTF-8:Kalayc=C4=B1;Ula=C5=',
    '=9F;;;',
    'END:VCARD',
  ].join('\r\n');
  const c = parseVCard(text);
  assert.equal(c.lastName, 'Kalaycı');
  assert.equal(c.firstName, 'Ulaş');
});

test('parseVCard laesst literale "=" ohne QP-Deklaration unangetastet', () => {
  // Regression: nur bei ENCODING=QUOTED-PRINTABLE dekodieren, sonst wuerden
  // gewoehnliche Werte mit "=" (URLs, Notizen) zerstoert.
  const text = [
    'BEGIN:VCARD', 'VERSION:3.0', 'FN:Formula',
    'NOTE:a=C4=B1 bleibt roh', 'END:VCARD',
  ].join('\r\n');
  const c = parseVCard(text);
  assert.equal(c.notes, 'a=C4=B1 bleibt roh');
});
