// --------------------------------------------------------
// Zahlen aus fremden Ziffernsystemen lesbar machen.
//
// Der Server hat keine Locale. Er bekommt einen Text, den irgendein Haushalt in
// der Schreibweise SEINER Region eingetippt hat, und muss die Zahl darin finden.
// `\d` ist in JavaScript ASCII: eine Menge wie „۲۵۰ g" oder „٢٥٠ g" traf jede
// Regex im Server ins Leere und fiel wortlos aus der Verarbeitung - beim
// Uebertrag Mahlzeit -> Einkaufsliste zum Beispiel aus der Summierung, sodass
// dieselbe Zutat zweimal untereinander stand statt einmal zusammengezaehlt.
//
// GETEILT zwischen Client und Server, wie utils/date.js und utils/folder-tree.js:
// beide Seiten lesen dieselben Mengentexte, und eine zweite Fassung daneben ist
// genau die Dopplung, gegen die dieses Umfeld schon zweimal angetreten ist.
//
// `toDecimalString` in utils/money.js liest mit der EINGESTELLTEN Region, weil
// eine Eingabe im Zweifel deren Schreibweise folgt. Diese Datei kennt gar keine
// Region und akzeptiert jedes bekannte System - das ist die richtige Haltung fuer
// eine Leseoperation: was ein Mensch als Zahl geschrieben hat, soll als Zahl
// ankommen, egal welches System, und egal ob die Region seither gewechselt hat.
//
// Die Zuordnung wird aus Intl ABGELEITET, nicht als Tabelle gepflegt. 770
// Ziffernzeichen aus 77 Ziffernsystemen (gemessen 09.09.2026) haette niemand
// von Hand aktuell gehalten, und eine neue ICU-Fassung braechte sie lautlos
// auseinander.
// --------------------------------------------------------

/**
 * Dezimaltrenner und Gruppierungszeichen, die es NICHT schon in ASCII gibt.
 *
 * Bewusst auf ihre ASCII-Entsprechung abgebildet statt auf eine eigene Bedeutung:
 * danach laeuft eine oestlich geschriebene Zahl durch exakt denselben Code wie
 * eine westliche, mit demselben Ergebnis und denselben Schwaechen. Wer die
 * Deutung von „1,000" spaeter praezisiert, praezisiert „١٬٠٠٠" automatisch mit -
 * eine zweite Fassung daneben waere genau die Dopplung, die im Frontend schon
 * einmal zwei verschiedene Fehler ueberlebt hat.
 */
const SEPARATORS = new Map([
  ['٫', '.'], // ARABIC DECIMAL SEPARATOR
  ['٬', ','], // ARABIC THOUSANDS SEPARATOR
]);

/** Ziffernzeichen -> ASCII-Ziffer. Einmal gebaut, danach nur gelesen. */
let digitMap = null;

function buildDigitMap() {
  const map = new Map();
  // `Intl.supportedValuesOf` ist ES2022. Auf dem Server ist es garantiert (Node
  // >= 22), im BROWSER nicht - und seit diese Datei auch dort laeuft, haette ein
  // ungeschuetzter Aufruf einen TypeError durch `toDecimalString` nach oben
  // gereicht und damit jedes Betrags- und Mengenfeld der App lahmgelegt, statt
  // nur diese eine Faehigkeit zu verlieren. Gemessen: „is not a function".
  //
  // Leere Liste als Rueckfall ist hier die richtige Degradation und nicht die
  // uebliche Luege („es gibt keine"): der Aufrufer im Client fragt diese Zuordnung
  // erst, wenn die Ziffern der eingestellten Region nicht greifen. Faellt sie aus,
  // bleibt genau das Verhalten von vor v2.66 - fremde Ziffern werden nicht
  // gelesen, alles andere laeuft.
  //
  // Dieselbe Absicherung wie bei `Intl.supportedValuesOf('timeZone')` in
  // settings/pages/personal-appearance.js.
  let systems = [];
  try {
    systems = Intl.supportedValuesOf('numberingSystem');
  } catch {
    return map;
  }
  for (const system of systems) {
    let digits;
    try {
      const format = new Intl.NumberFormat('en', { numberingSystem: system, useGrouping: false });
      digits = Array.from({ length: 10 }, (_, i) => format.format(i));
    } catch {
      continue; // System von dieser ICU-Fassung nicht unterstuetzt
    }
    // Nur echte ZIFFERN. `Intl` fuehrt auch `hanidec`, wo die Fuenf ein „五" ist:
    // ein gewoehnliches Schriftzeichen, das in chinesischem Text ueberall
    // vorkommt. Naehme man es auf, laese der Server jedes „五" in einer Zutat als
    // Zahl. Die Unicode-Kategorie Nd trennt das sauber - sie ist genau die Menge
    // der Zeichen, die fuer sich einen Stellenwert tragen.
    //
    // Gezaehlt werden CODEPOINTS, nicht UTF-16-Einheiten: 40 der 77 Systeme
    // (adlm, ahom, brah, ...) liegen ausserhalb der BMP, ihre Ziffern haben also
    // `.length === 2`. Ein `d.length === 1` warf sie stillschweigend weg, obwohl
    // `for...of` unten genau diese Codepoints liest und sie treffen wuerde.
    const positional = digits.every((d) => [...d].length === 1 && /^\p{Nd}$/u.test(d))
      && new Set(digits).size === 10;
    if (!positional) continue;
    digits.forEach((digit, value) => map.set(digit, String(value)));
  }
  return map;
}

/**
 * Schreibt Ziffern und Trennzeichen eines Textes nach ASCII um, Zeichen fuer
 * Zeichen. Alles andere bleibt unangetastet - „۲۵۰ گرم" wird „250 گرم", die
 * Einheit ist nicht Sache dieser Funktion.
 *
 * POSITIONSTREU IN CODEPOINTS: ein Codepoint hinein, ein Codepoint hinaus. Ein
 * Aufrufer, der nur einen Teil des Textes umrechnet, darf den Rest deshalb per
 * Codepoint-Offset aus dem Original schneiden - `[...text]` zaehlen, nicht
 * `.length`.
 *
 * Die Unterscheidung ist hier nicht akademisch: 40 der 77 Systeme (adlm, ahom,
 * brah, ...) liegen ausserhalb der BMP, ihre Ziffern belegen also ZWEI
 * UTF-16-Einheiten, das ASCII-Ergebnis nur eine. In UTF-16 gemessen ist die
 * Umschrift damit nicht laengentreu, und ein Schnitt per `.length` verrutscht
 * genau bei den Systemen, fuer die sie gebaut wurde. Das Frontend-Gegenstueck
 * `toDecimalString` kommt mit UTF-16 aus, weil die 69 waehlbaren Regionen alle
 * BMP-Ziffern fuehren; hier gilt die staerkere Zusicherung.
 *
 * @param {unknown} value
 * @returns {string}
 */
export function toAsciiDigits(value) {
  const text = String(value ?? '');
  if (!text) return '';
  if (!digitMap) digitMap = buildDigitMap();

  let out = '';
  for (const char of text) {
    out += digitMap.get(char) ?? SEPARATORS.get(char) ?? char;
  }
  return out;
}

/**
 * Ein einzelnes Zeichen als ASCII-Ziffer, oder null. Fuer Aufrufer, die je
 * Zeichen entscheiden - utils/money.js gibt den Ziffern der eingestellten Region
 * den Vortritt und faellt nur hier herein zurueck.
 */
export function asciiDigit(char) {
  if (!digitMap) digitMap = buildDigitMap();
  return digitMap.get(char) ?? null;
}

/** Die ASCII-Entsprechung eines fremden Trennzeichens, oder null. */
export function asciiSeparator(char) {
  return SEPARATORS.get(char) ?? null;
}

/** Nur fuer Tests: die Groesse der abgeleiteten Zuordnung. */
export function digitMapSize() {
  if (!digitMap) digitMap = buildDigitMap();
  return digitMap.size;
}
