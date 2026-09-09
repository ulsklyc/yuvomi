/**
 * Modul: Verhalten von public/utils/money.js
 * Zweck: Die Umschrift eingetippter Zahlen (`toDecimalString`) und die
 *        Cent-Umrechnung, gemessen unter WECHSELNDER Format-Locale.
 * Ausfuehren: node --loader ./test/test-browser-loader.mjs --test test/test-money-utils.js
 *
 * WARUM EINE EIGENE SUITE: money.js haengt an `/i18n.js`, laeuft in Node also nur
 * unter dem Browser-Loader - test-budget-ui.js kann die Datei deshalb nur als TEXT
 * pruefen. Solange die Zusicherungen dieser Datei nur ueber ihre Aufrufer gemessen
 * wurden, war das Ergebnis nicht eindeutig: der Einkauf hat gegen abgeschnittene
 * Zahlen eine ZWEITE Sperre, und die faengt denselben Fall. Gemessen (09.09.2026):
 * mit der Gruppierungspruefung an der falschen Stelle blieben alle Aufrufer-Suiten
 * gruen. Ein Test, der nicht sagen kann, WELCHE Zusicherung ihn gruen haelt, misst
 * die eine von beiden nicht.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { toDecimalString, amountInputToCents, centsToAmountInput, breaksOffAtSeparator, toStoredNumber } from '../public/utils/money.js';
import { parseQuantity } from '../server/services/shopping-import.js';

/**
 * Fuehrt `fn` unter einer anderen Format-Locale aus. Die Locale ist im Browser
 * eine Haushalts-Einstellung; der Browser-Loader liest sie aus
 * `globalThis.__formatLocale` (Standard 'de').
 */
function withFormatLocale(locale, fn) {
  const vorher = globalThis.__formatLocale;
  globalThis.__formatLocale = locale;
  try { fn(); } finally { globalThis.__formatLocale = vorher; }
}

/** Kurzform: eine Eingabe unter einer Locale gegen ihr erwartetes Ergebnis. */
function um(locale, eingabe, erwartet) {
  withFormatLocale(locale, () => {
    assert.equal(toDecimalString(eingabe), erwartet, `${locale}: "${eingabe}"`);
  });
}

test('toDecimalString: Ziffern und Trenner kommen aus der eingestellten Region', () => {
  um('de', '12,50', '12.50');
  um('en-US', '12.50', '12.50');
  um('de-CH', '12.50', '12.50');
  // Oestliche Ziffernsysteme: `\d` ist ASCII, eine Tabelle gaebe es hier nicht -
  // die Zuordnung wird aus Intl abgeleitet.
  um('fa', '۱۲٫۵۰', '12.50');
  um('ar-EG', '١٢٫٥٠', '12.50');
  // Ziffern eines ANDEREN Systems werden ebenfalls gelesen - seit v2.66 stehen
  // gespeicherte Mengen in den Ziffern IHRER Region, und wer die Region wechselt,
  // muss seine eigenen Altdaten weiter lesen koennen. Die Zuordnung dafuer kommt
  // aus utils/digits.js, derselben Datei, die der Server benutzt.
  um('fa', '١٢٫٥٠', '12.50');
  um('de', '١٢٫٥٠', '12.50');
  um('en-US', '۴٫۵', '4.5');
  // Unbekannte Zeichen bleiben stehen, statt still zu verschwinden - ein
  // Tippfehler soll als Tippfehler auffallen.
  um('de', '12,50 EUR', '12.50 EUR');
  um('de', '', '');
});

test('toDecimalString: das ASCII-Komma gilt nur, wo die Region es als Trenner fuehrt', () => {
  // Unter en-US gruppiert das Komma Tausender. Wuerde es pauschal zum Punkt,
  // machte "1,000" die Zahl 1 - um den Faktor tausend daneben, ohne Fehler.
  um('en-US', '1,5', '1,5');
  um('fa', '1,5', '1,5');
  um('de', '1,5', '1.5');
});

test('toDecimalString: eine gruppierte Zahl wird abgewiesen, auch in oestlichen Ziffern', () => {
  // Erkannt wird das MUSTER (drei Ziffern hinter dem Trenner), nicht das blosse
  // Zeichen: "12.50" hat zwei und bleibt eine Dezimalangabe.
  um('de', '1.000', '');
  um('en-US', '1,000', '');
  um('de-CH', "1'000", '');
  um('de', '12.50', '12.50');
  // Der Kern des am 09.09.2026 gemeldeten Befundes: die Pruefung lief auf dem
  // ROHTEXT, und `\d` sieht ٠٠٠ nicht. ar-EG "٢٬٠٠٠" kam unerkannt durch und
  // wurde zu "2٬000" - fuer einen Betrag folgenlos (die Vollpruefung des
  // Aufrufers scheitert am stehen gebliebenen Trenner), aber eine Mengenangabe
  // liest nur den ANFANG und machte daraus die 2.
  um('ar-EG', '٢٬٠٠٠', '');
  um('fa', '۲٬۰۰۰', '');
  // Gegenprobe: dieselben Ziffern OHNE Gruppierung gehen durch.
  um('ar-EG', '٢٠٠٠', '2000');
  um('fa', '۲۰۰۰', '2000');
});

test('toDecimalString: bei Freitext zaehlt nur der fuehrende Zahlenbereich', () => {
  // Ein Betragsfeld enthaelt NUR eine Zahl - dort ist es richtig, den ganzen Wert
  // abzuweisen. Ein Freitext enthaelt eine Zahl und dann noch etwas, und der
  // Aufrufer liest nur den Anfang. Ohne `freeText` wies eine Gruppierung
  // IRGENDWO die ganze Zeile ab: „6 × 1.000 ml" fiel auf die Menge 1 zurueck,
  // obwohl die 6 eindeutig ist und die 1.000 unveraendert stehen bleibt.
  withFormatLocale('de', () => {
    assert.equal(toDecimalString('6 × 1.000 ml'), '', 'ohne freeText weist die Gruppierung im Rest ab');
    assert.equal(toDecimalString('6 × 1.000 ml', { freeText: true }), '6 × 1.000 ml');
  });
  withFormatLocale('en-US', () => {
    assert.equal(toDecimalString('6 × 1,000 ml', { freeText: true }), '6 × 1,000 ml');
    assert.equal(toDecimalString('2 cans à 1,000 ml', { freeText: true }), '2 cans à 1,000 ml');
  });
  // Im FUEHRENDEN Token wird weiter abgewiesen - sonst waere die Option ein
  // Freibrief statt einer Eingrenzung.
  um('de', '1.000 g', '');
  withFormatLocale('de', () => {
    assert.equal(toDecimalString('1.000 g', { freeText: true }), '', 'der fuehrende Token zaehlt weiter');
  });
  withFormatLocale('en-US', () => {
    assert.equal(toDecimalString('1,000 g', { freeText: true }), '');
  });
  withFormatLocale('ar-EG', () => {
    assert.equal(toDecimalString('٢٬٠٠٠ g', { freeText: true }), '', 'auch in oestlichen Ziffern');
    // Der Trenner im REST wird ebenfalls umgeschrieben - die Zuordnung gilt je
    // Zeichen und regionsunabhaengig. Fuer die Aufrufer ist das folgenlos: sie
    // schneiden den Rest aus dem Original (siehe Positionstreue).
    assert.equal(toDecimalString('٦ × ١٬٠٠٠ ml', { freeText: true }), '6 × 1,000 ml');
  });
  // Der Dezimaltrenner im fuehrenden Token bleibt eine Dezimalangabe.
  withFormatLocale('de', () => {
    assert.equal(toDecimalString('1,5 kg', { freeText: true }), '1.5 kg');
  });
});

test('toDecimalString: der Dezimaltrenner wird erst NACH der Gruppierungspruefung ersetzt', () => {
  // Die andere Kante derselben Reihenfolge. Liefe die Pruefung nach dem
  // Ersetzen, waere "1,000" in de laengst ein "1.000" - und in de-DE IST der
  // Punkt das Gruppierungszeichen. Ein gueltiger Betrag von einem Euro floege
  // dann als vermeintlich gruppiert raus.
  um('de', '1,000', '1.000');
  um('en-US', '1.000', '1.000');
  um('fa', '۱٫۰۰۰', '1.000');
});

test('toDecimalString: positionstreu in CODEPOINTS, nicht in UTF-16-Einheiten', () => {
  // ZUGESICHERTE Eigenschaft, kein Zufall: pages/meals.js skaliert nur die
  // fuehrende Zahl eines Freitextes und schneidet den Rest per Offset aus dem
  // ORIGINAL, damit "۲ x ۵۰۰ g" nicht zu "۴ x 500 g" wird. Faellt die
  // Zusicherung, verrutscht dort still der Schnitt.
  //
  // In Codepoints, und ausdruecklich NICHT in `.length`: seit die Umschrift auf
  // fremde Systeme zurueckfaellt, kommen astrale Ziffern vor (40 der 77 Systeme),
  // die zwei UTF-16-Einheiten belegen, waehrend ihr ASCII-Ergebnis eine belegt.
  // Der Test hat hier vorher `.length` verglichen und die Luecke nicht gesehen.
  const proben = [
    '۲ x ۵۰۰ g', '٢٬٥٠ g', '1,5 kg', 'eine Prise', '🍎 2 kg', '1 1/2 Tassen',
    '12,50 EUR', '𞥒 x 500 g', '𑜲𑜵𑜰 g',
  ];
  for (const locale of ['de', 'en-US', 'fa', 'ar-EG', 'de-CH']) {
    withFormatLocale(locale, () => {
      for (const probe of proben) {
        const ergebnis = toDecimalString(probe);
        // Leer heisst abgewiesen - dann gibt es keinen Offset zu halten.
        if (ergebnis === '') continue;
        assert.equal([...ergebnis].length, [...probe.trim()].length,
          `${locale}: "${probe}" -> "${ergebnis}"`);
      }
    });
  }
  // Die Gegenprobe zur Formulierung: in UTF-16 stimmt es bei einer astralen
  // Ziffer eben NICHT, und das ist der Grund fuer die Codepoint-Zaehlung.
  withFormatLocale('de', () => {
    assert.notEqual(toDecimalString('𞥒 kg').length, '𞥒 kg'.length);
  });
});

test('amountInputToCents: Rundreise durch die Region, gruppierte Eingabe abgelehnt', () => {
  withFormatLocale('de', () => {
    assert.equal(amountInputToCents('2,50', 'EUR'), 250);
    assert.equal(amountInputToCents('1,000', 'EUR'), 100, '"1,000" ist in de EIN Euro');
    assert.equal(amountInputToCents('1.000', 'EUR'), null, '"1.000" ist in de gruppiert');
    assert.equal(amountInputToCents('1300', 'JPY'), 1300, 'JPY hat keine Nachkommastellen');
    assert.equal(centsToAmountInput(250, 'EUR'), '2,50');
  });
  withFormatLocale('en-US', () => {
    assert.equal(amountInputToCents('2.50', 'EUR'), 250);
    assert.equal(amountInputToCents('1,000', 'EUR'), null, '"1,000" ist in en-US gruppiert');
    assert.equal(amountInputToCents('1.000', 'EUR'), 100);
    assert.equal(centsToAmountInput(250, 'EUR'), '2.50');
  });
  withFormatLocale('ar-EG', () => {
    assert.equal(amountInputToCents('١٢٫٥٠', 'EUR'), 1250, 'oestliche Ziffern muessen ankommen');
    assert.equal(amountInputToCents('٢٬٠٠٠', 'EUR'), null, 'gruppiert, auch in oestlichen Ziffern');
  });
});

test('centsToAmountInput: der ausgegebene Wert kommt wieder herein', () => {
  // Ohne useGrouping:false schriebe das Feld "1.234,56" - und genau das weist
  // toDecimalString beim naechsten Speichern ab.
  for (const locale of ['de', 'en-US', 'fa', 'ar-EG', 'de-CH']) {
    withFormatLocale(locale, () => {
      for (const cents of [0, 1, 250, 123456, 100000]) {
        const feld = centsToAmountInput(cents, 'EUR');
        assert.equal(amountInputToCents(feld, 'EUR'), cents,
          `${locale}: ${cents} -> "${feld}" -> ${amountInputToCents(feld, 'EUR')}`);
      }
    });
  }
});

test('breaksOffAtSeparator: nur echte Trennzeichen zaehlen, kein Multiplikator', () => {
  // Die Regel war erst „irgendein Zeichen zwischen zwei Ziffern, das kein
  // Leerraum ist". Das traf auch „2x500 g" - und ein `x` ist kein Trenner: nach
  // ihm ist die 2 vollstaendig gelesen. Beide Freitext-Aufrufer fielen dadurch auf
  // ihren Standard zurueck, statt die Multiplikator-Schreibweise zu lesen.
  //
  // Die Zeichenmenge kommt aus REGION_CODES, ist also gemessen und nicht geraten:
  // sie waechst mit, wenn eine Region dazukommt.
  for (const rest of [',5 kg', '.5 kg', "'000 g", '٫٥ kg', '٬٠٠٠ g']) {
    assert.equal(breaksOffAtSeparator(rest), true, `"${rest}" bricht im Trenner ab`);
  }
  for (const rest of ['x500 g', '×500 ml', '*500 g', ' x 500 g', 'er-Pack', ' kg', '', 'x', ',', ' 5 g', '× 1 l']) {
    assert.equal(breaksOffAtSeparator(rest), false, `"${rest}" ist kein Abbruch im Trenner`);
  }
  // Ein Whitespace-Gruppierungstrenner (fr nutzt U+202F) zaehlt bewusst NICHT:
  // ein Leerzeichen trennt im Freitext zwei Angaben. Die echte Gruppierung dahinter
  // faengt die Musterpruefung in toDecimalString.
  assert.equal(breaksOffAtSeparator('\u202F000 g'), false);
});

test('toStoredNumber: Ziffern UND Trenner der Region, von beiden Seiten lesbar', () => {
  // Der geschriebene Wert wird gespeichert und spaeter von zwei Stellen wieder
  // gelesen: hier und von `parseQuantity` auf dem Server. Bis v2.65 stand er
  // deshalb in ASCII-Ziffern - der Server konnte nichts anderes. Seit der Server
  // dieselbe Umschrift benutzt (utils/digits.js), gibt es den Grund nicht mehr,
  // und eine skalierte Zutat mischt unter fa nicht laenger zwei Schriften.
  //
  // Gemessen wird gegen den ECHTEN parseQuantity, nicht gegen einen Nachbau
  // seiner Regex: der Nachbau, der hier stand, haette diese Aenderung fuer
  // unlesbar erklaert, obwohl der Server sie laengst liest.
  for (const locale of ['de', 'en-US', 'fa', 'ar-EG', 'fr', 'de-CH', 'bn']) {
    withFormatLocale(locale, () => {
      for (const wert of [2000, 4.5, 0.25, 1]) {
        const text = toStoredNumber(wert);
        assert.equal(parseQuantity(`${text} kg`)?.amount, wert,
          `${locale}: "${text}" ist fuer den Server unlesbar`);
        assert.equal(Number(toDecimalString(text)), wert, `${locale}: Rundreise im Client fuer ${wert}`);
      }
    });
  }

  // Und ueber einen REGIONSWECHSEL hinweg: ein unter fa gespeicherter Wert muss
  // unter de weiter lesbar sein, sonst haette diese Aenderung Altdaten erzeugt,
  // die die eigene Oberflaeche nicht mehr versteht.
  let unterFa;
  withFormatLocale('fa', () => { unterFa = toStoredNumber(4.5); });
  for (const locale of ['de', 'en-US', 'ar-EG']) {
    withFormatLocale(locale, () => {
      assert.equal(Number(toDecimalString(unterFa)), 4.5, `${locale} liest den fa-Wert "${unterFa}" nicht`);
    });
  }
  // Trenner UND Ziffern folgen jetzt der Region - die frueher noetige Ausnahme
  // fuer fa/ar-EG/ar-SA (dort stand `0.5` statt `0٫5`, weil ihr `٫` fuer den
  // Server unlesbar war) ist mit der geteilten Umschrift entfallen.
  withFormatLocale('de', () => { assert.equal(toStoredNumber(4.5), '4,5'); });
  withFormatLocale('fr', () => { assert.equal(toStoredNumber(4.5), '4,5'); });
  withFormatLocale('en-US', () => { assert.equal(toStoredNumber(4.5), '4.5'); });
  withFormatLocale('fa', () => { assert.equal(toStoredNumber(0.5), '۰٫۵'); });
  withFormatLocale('ar-EG', () => { assert.equal(toStoredNumber(0.5), '٠٫٥'); });
  withFormatLocale('fa', () => { assert.equal(toStoredNumber(2000), '۲۰۰۰'); });
  // Ohne Gruppierung, sonst laese toDecimalString den Wert nicht wieder ein.
  withFormatLocale('de', () => { assert.equal(toStoredNumber(2000), '2000'); });
});
