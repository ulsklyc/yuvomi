/**
 * Modul: server/utils/digits.js - Ziffern fremder Systeme nach ASCII
 * Zweck: Die Umschrift selbst, ihre Vollstaendigkeit und ihre Positionstreue.
 * Ausfuehren: node --test test/test-server-digits.js
 *
 * WARUM EINE EIGENE SUITE: die Umschrift hat mit dem Einkauf nichts zu tun, sie
 * ist eine Zeichenoperation. Und die Lehre aus dem Frontend-Gegenstueck
 * (test-money-utils.js, 09.09.2026) gilt hier genauso: wird eine Zusicherung nur
 * ueber ihren Aufrufer gemessen, sagt ein gruener Test nicht, WELCHE Zusicherung
 * ihn gruen haelt. Die Positionstreue traegt hier den Einheiten-Schnitt in
 * parseQuantity - faellt sie, verrutscht der still.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { toAsciiDigits, digitMapSize } from '../server/utils/digits.js';

test('toAsciiDigits: ASCII bleibt, wie es ist', () => {
  assert.equal(toAsciiDigits('250 g'), '250 g');
  assert.equal(toAsciiDigits('1,5 kg'), '1,5 kg');
  assert.equal(toAsciiDigits('1.5 kg'), '1.5 kg');
  assert.equal(toAsciiDigits('eine Prise'), 'eine Prise');
  assert.equal(toAsciiDigits(''), '');
  assert.equal(toAsciiDigits(null), '');
  assert.equal(toAsciiDigits(undefined), '');
});

test('toAsciiDigits: die gaengigen Ziffernsysteme kommen an', () => {
  assert.equal(toAsciiDigits('۲۵۰'), '250', 'fa (extended arabic-indic)');
  assert.equal(toAsciiDigits('٢٥٠'), '250', 'ar (arabic-indic)');
  assert.equal(toAsciiDigits('२५०'), '250', 'hi (devanagari)');
  assert.equal(toAsciiDigits('๒๕๐'), '250', 'th (thai)');
  assert.equal(toAsciiDigits('২৫০'), '250', 'bn (bengali)');
  // Gemischt geschrieben - jedes Zeichen fuer sich.
  assert.equal(toAsciiDigits('۲5٠'), '250');
});

test('toAsciiDigits: die oestlichen Trennzeichen bekommen ihre ASCII-Entsprechung', () => {
  // Danach laeuft eine oestlich geschriebene Zahl durch exakt denselben Code wie
  // eine westliche - mit demselben Ergebnis UND denselben Schwaechen. Eine eigene
  // Deutung daneben waere die Dopplung, die im Frontend schon zwei verschiedene
  // Fehler ueberlebt hat.
  assert.equal(toAsciiDigits('۱٫۵'), '1.5', 'U+066B ist der Dezimaltrenner');
  assert.equal(toAsciiDigits('١٬٠٠٠'), '1,000', 'U+066C ist das Tausenderzeichen');
});

test('toAsciiDigits: alles, was keine Ziffer ist, bleibt unangetastet', () => {
  // Die Einheit ist nicht Sache dieser Funktion.
  assert.equal(toAsciiDigits('۲۵۰ گرم'), '250 گرم');
  assert.equal(toAsciiDigits('۲ x ۵۰۰ g'), '2 x 500 g');
  assert.equal(toAsciiDigits('🍎 ۲ kg'), '🍎 2 kg');
});

test('toAsciiDigits: positionstreu in CODEPOINTS, nicht in UTF-16-Einheiten', () => {
  // ZUGESICHERT, kein Zufall: parseQuantity schneidet die Einheit per Offset aus
  // dem ORIGINAL, damit „۲ x ۵۰۰ g" seinen Rest behaelt statt zu „2 x 500 g" zu
  // werden. Faellt die Zusicherung, verrutscht dieser Schnitt still.
  //
  // In Codepoints und ausdruecklich NICHT in `.length`: die Ziffern von 40 der 77
  // Systeme liegen ausserhalb der BMP, belegen also zwei UTF-16-Einheiten,
  // waehrend ihr ASCII-Ergebnis eine belegt. Beides zugleich ist nicht zu haben -
  // wer hier `.length` zusichert, muss genau die Systeme ausschliessen, fuer die
  // die Umschrift gebaut ist.
  const proben = [
    '۲ x ۵۰۰ g', '٢٬٠٠٠ g', '۱٫۵ kg', 'eine Prise', '🍎 ۲ kg',
    '250 g', '', '๒๕๐ ก.', '1 1/2 Tassen', '𞥒 kg', '𑜲𑜵𑜰 g',
  ];
  for (const probe of proben) {
    assert.equal([...toAsciiDigits(probe)].length, [...probe].length, `"${probe}"`);
  }
  // Die Gegenprobe zur Formulierung: in UTF-16 gemessen stimmt es bei einer
  // astralen Ziffer eben NICHT, und das ist kein Fehler, sondern der Grund fuer
  // die Codepoint-Zaehlung.
  assert.notEqual(toAsciiDigits('𞥒 kg').length, '𞥒 kg'.length);
});

test('toAsciiDigits: die Zuordnung wird aus Intl abgeleitet, nicht gepflegt', () => {
  // Gemessen am 09.09.2026: 77 Ziffernsysteme, 770 Ziffernzeichen. Die Schranke
  // ist bewusst grosszuegig - sie soll den KOLLAPS fangen (eine ICU-Fassung ohne
  // `supportedValuesOf`, ein Filter, der alles wegwirft), nicht jede Verschiebung
  // nach oben. Eine exakte Zahl waere ein Guard, der bei jedem Node-Update rot
  // wird, ohne dass etwas kaputt ist.
  assert.ok(digitMapSize() >= 500, `nur ${digitMapSize()} Ziffernzeichen abgeleitet`);
  // Und die 10 ASCII-Ziffern sind auf jeden Fall dabei.
  for (let i = 0; i <= 9; i += 1) assert.equal(toAsciiDigits(String(i)), String(i));
});

test('toAsciiDigits: Schriftzeichen, die nur AUSSEHEN wie Ziffern, bleiben stehen', () => {
  // Gemessen: von 77 Ziffernsystemen faellt genau EINES durch die Nd-Pruefung,
  // naemlich `hanidec` - dort ist die Fuenf ein „五", ein gewoehnliches
  // chinesisches Schriftzeichen. Naehme man es auf, laese der Server jedes „五"
  // in einer Zutat als Zahl. Das ist die Zusicherung des Filters, und sie wird
  // hier an genau diesem Zeichen gemessen: eine Probe auf „V" oder „X" waere
  // gruen geblieben, weil roman gar nicht erst in Frage kommt.
  assert.equal(toAsciiDigits('五'), '五');
  assert.equal(toAsciiDigits('一 kg'), '一 kg');
  assert.equal(toAsciiDigits('2x500 g'), '2x500 g', 'das x eines Multiplikators bleibt ein x');
});

test('toAsciiDigits: auch Ziffern ausserhalb der BMP kommen an', () => {
  // 40 der 77 Systeme liegen ausserhalb der Basic Multilingual Plane, ihre
  // Ziffern haben also `.length === 2`. Eine Laengenpruefung in UTF-16-Einheiten
  // warf sie stillschweigend weg, obwohl die Schleife sie einzeln liest.
  assert.equal(toAsciiDigits('𞥒𞥕𞥐'), '250', 'adlm (Adlam)');
  assert.equal(toAsciiDigits('𑜲𑜵𑜰'), '250', 'ahom (Ahom)');
  assert.equal(toAsciiDigits('𞥐𞥑'), '01');
});
