/**
 * Geldbeträge im Budget-Modul: EINE Quelle für Format, Vorzeichen und Farbe.
 *
 * Vorher gab es drei Formatierer (budget.js, subscriptions.js, split-expenses.js)
 * und vier Vorzeichenkonventionen. Dieselbe Zahl konnte dadurch in zwei Untertabs
 * verschieden geschrieben sein - bei Geld ist das kein Stilproblem, sondern ein
 * Vertrauensproblem (Critique 2026-07-30, P0).
 *
 * Der Kern ist nicht der Formatierer, sondern das ROLLEN-Vokabular: jeder Betrag
 * im Modul gehört zu genau einer der vier Rollen, und die Rolle entscheidet
 * Vorzeichen und Farbe gemeinsam. Wer einen neuen Betrag rendert, wählt eine
 * Rolle - er erfindet keine fünfte Schreibweise.
 *
 * | Rolle       | Vorzeichen        | Farbe            | Wofür |
 * |-------------|-------------------|------------------|-------|
 * | `flow`      | immer (+ und -)   | nach Vorzeichen  | eine einzelne Kontobewegung: Buchung, Darlehensrate |
 * | `total`     | nie               | vom Aufrufer     | eine Summe, deren Richtung schon im Label steht („Ausgaben") |
 * | `balance`   | nur bei negativ   | nach Vorzeichen  | Saldo, Nettovermögen, „Du schuldest" |
 * | `plain`     | nie               | keine            | ein Rechnungsbetrag ohne Kontorichtung: Abo-Preis, Darlehenshöhe |
 *
 * Warum `plain` für geteilte Ausgaben und `flow` für Budget-Einträge: eine
 * geteilte Ausgabe ist ein Rechnungsposten der Gruppe, keine Bewegung auf dem
 * Konto des Betrachters - wer sie ausgelegt hat, hat eine Forderung, kein Minus.
 * Die Unterscheidung ist damit eine benannte Entscheidung statt eines Zufalls.
 */

import { getNumberFormat } from '/i18n.js';
import { REGION_CODES } from '/settings/region-presets.js';
import { asciiDigit, asciiSeparator } from '/utils/digits.js';

/** Erlaubte Rollen. Wird vom Guard in test-budget-ui.js gegen die Aufrufe geprüft. */
export const MONEY_ROLES = ['flow', 'total', 'balance', 'plain'];

/**
 * Reiner Betrag ohne Rollenlogik. Nur benutzen, wenn wirklich kein Vorzeichen
 * und keine Farbe im Spiel sind (Achsenbeschriftung, Tooltip, CSV).
 */
export function formatMoney(amount, currency) {
  return getNumberFormat({ style: 'currency', currency: usableCurrency(currency) }).format(Number(amount) || 0);
}

/*
 * EIN UNBRAUCHBARER CODE LEGT KEINE SEITE LAHM (#2302). `Intl.NumberFormat`
 * wirft bei einem Code, der kein ISO-Code sein kann ("XYZ1"); bis #2302
 * nahm ein Budget-Konto solche Codes als freien Text an, und eine einzige
 * Zeile im Bestand brachte die ganze Budget-Seite zum Stehen. Ein solcher
 * Code faellt hier auf die Haushaltswaehrung zurueck, die die Seite beim
 * Laden meldet (setFallbackCurrency).
 */
let fallbackCurrency = 'EUR';
const usable = new Map();

/** Die Haushaltswaehrung als Rueckfall fuer unbrauchbare Codes. */
export function setFallbackCurrency(currency) {
  if (currency && usableCurrency(currency) === currency) fallbackCurrency = currency;
}

/** `currency`, wenn Intl damit formatieren kann, sonst die Haushaltswaehrung. */
export function usableCurrency(currency) {
  const key = String(currency ?? '');
  if (!usable.has(key)) {
    try {
      getNumberFormat({ style: 'currency', currency: key });
      usable.set(key, true);
    } catch {
      usable.set(key, false);
    }
  }
  return usable.get(key) ? currency : fallbackCurrency;
}

/**
 * Das Waehrungszeichen, wie die Zahlformatierung es an einen Betrag setzt
 * ("€", "$", "CHF") - fuer die Einheit hinter einem Betragsfeld (R22, D9).
 * Ohne Zeichen (unbekannte Waehrung) steht der Code.
 * @param {string} currency  ISO-4217-Code
 * @returns {string}
 */
export function currencySymbol(currency) {
  try {
    const part = getNumberFormat({ style: 'currency', currency: usableCurrency(currency) }).formatToParts(0).find((p) => p.type === 'currency');
    return part?.value || String(currency ?? '');
  } catch {
    return String(currency ?? '');
  }
}

/**
 * Derselbe Betrag fuer eine WERTEACHSE: ohne Nachkommastellen.
 *
 * Eine Achse beschriftet eine Skala, keinen Kontostand - die Cent sind dort
 * Pseudo-Praezision und kosten den Platz, an dem die Zahl steht. Gemessen:
 * „5.050,00 €" lief im Trend-Chart des Budgets links aus dem Bild und stand als
 * „050,00 €" da, also mit dem WICHTIGSTEN Teil abgeschnitten. Dieselbe
 * Entscheidung trifft health.js seit dem Audit A2-21 fuer seine Ticks
 * („125,9 mmHg" wurde „126").
 */
export function formatMoneyAxis(amount, currency) {
  return getNumberFormat({
    style: 'currency', currency: usableCurrency(currency), maximumFractionDigits: 0, minimumFractionDigits: 0,
  }).format(Number(amount) || 0);
}

/**
 * Anteil einer Zeile an der Gesamtsumme als Prozenttext in der Zahlenform der
 * Region. Unter einem halben Prozent steht "<1 %" statt "0 %": eine Zeile mit
 * Betrag hat einen Anteil. Der Text kann "<" enthalten und gehoert escaped.
 */
export function sharePercent(part, total) {
  const sum = Math.abs(Number(total)) || 0;
  const share = sum > 0 ? Math.abs(Number(part) || 0) / sum : 0;
  const fmt = getNumberFormat({ style: 'percent', maximumFractionDigits: 0 });
  return share > 0 && share < 0.005 ? `<${fmt.format(0.01)}` : fmt.format(share);
}

/**
 * Nachkommastellen einer Währung: EUR 2, JPY/HUF/VND 0, KWD/BHD 3.
 * Fällt bei fehlendem oder ungültigem ISO-Code auf zwei zurück.
 */
export function currencyFractionDigits(currency) {
  try {
    // Wirft bei fehlendem oder ungültigem ISO-Code; dann bleibt es bei zwei.
    return getNumberFormat({ style: 'currency', currency }).resolvedOptions().minimumFractionDigits;
  } catch {
    return 2;
  }
}

/**
 * Ein Betrag, gerundet auf die Nachkommastellen seiner Währung - fuer
 * VERGLEICHE, nicht zum Speichern (Critique R19, 2026-10-16).
 *
 * Eine Differenz zweier Summen ist ein Float: 1700,10 - 1700,00 ergibt
 * 0,0999999…, und 300,30 - 300,20 - 0,10 ergibt 2,8e-14 statt 0. Wer darauf
 * `delta === 0` fragt, bekommt "nein" und zeichnet einen steigenden roten
 * Pfeil neben "0,00 €". Vor dem Vergleich auf die Waehrung runden; aus -0
 * wird 0, damit kein Vorzeichen uebrig bleibt.
 *
 * @param {number} amount
 * @param {string} currency ISO-Code
 * @returns {number}
 */
export function roundToCurrency(amount, currency) {
  const factor = 10 ** currencyFractionDigits(currency);
  return (Math.round(Number(amount) * factor) / factor) || 0;
}

/**
 * Eingabe-Platzhalter für ein Betragsfeld: die Null im Zahlformat der
 * Format-Locale, mit den Nachkommastellen der Währung.
 * EUR/de -> "0,00", EUR/de-CH -> "0.00", JPY -> "0".
 *
 * Stand vorher als Locale-Key `budget.amountPlaceholder` in 23 JSON-Dateien und
 * war dort in cs, hu und vi schlicht falsch (Punkt statt Komma). Ein Locale-Key
 * kann das auch gar nicht leisten: das Dezimaltrennzeichen hängt an der Region
 * (getFormatLocale), nicht an der UI-Sprache, und die Nachkommastellen hängen an
 * der Währung - beides weiß eine Übersetzungsdatei nicht.
 */
export function amountPlaceholder(currency) {
  const digits = currencyFractionDigits(currency);
  return getNumberFormat({ minimumFractionDigits: digits, maximumFractionDigits: digits }).format(0);
}

/** Kleinster erfassbarer Betrag der Währung als Zahl: JPY 1, EUR 0.01, KWD 0.001. */
function smallestUnit(digits) {
  return digits === 0 ? 1 : 10 ** -digits;
}

/**
 * Die kleinste erfassbare Einheit als TEXT FUER MENSCHEN, in der Schreibweise
 * der Region: EUR/de "0,01", EUR/en "0.01", JPY "1", KWD/ar-EG "٠٫٠٠١".
 *
 * Stand bis R23 als `toFixed` da und damit unter jeder Region als "0.01" - eine
 * Fehlermeldung, die in de "Schritten von 0.01" verlangte, widersprach dem
 * Platzhalter "0,00" direkt daneben. Fuer HTML-Attribute ist diese Funktion
 * nicht gedacht - Geldfelder haben seit R23 ohnehin keine (utils/amount-field.js).
 */
export function smallestUnitLabel(currency) {
  const digits = currencyFractionDigits(currency);
  return getNumberFormat({ useGrouping: false, minimumFractionDigits: digits, maximumFractionDigits: digits })
    .format(smallestUnit(digits));
}

/**
 * Ein eingetippter Betrag in der Schreibweise, die der Server erwartet:
 * ASCII-Ziffern, Punkt als Dezimaltrenner, ohne Gruppierung.
 *
 * Die Eingabefelder folgen der Region, und zwar bis in die Ziffern: unter fa
 * oder ar-EG zeigt der Platzhalter `۰٫۰۰` beziehungsweise `٠٫٠٠`, und wer das
 * abtippt, schickt Zeichen, die weder `Number()` noch die ASCII-Regex des
 * Servers kennt. Das Anlegen scheiterte dann an einer Eingabe, die genau so
 * aussah wie das, was die Oberfläche vorgeschlagen hatte.
 *
 * Unbekannte Zeichen bleiben absichtlich stehen, statt still zu verschwinden -
 * ein Tippfehler soll als Tippfehler auffallen und nicht zu einer plausiblen
 * anderen Zahl werden.
 *
 * Tausendergruppierung wird nicht aufgelöst, sondern abgelehnt: der Rückgabewert
 * ist dann leer, und die Formularprüfung verlangt eine neue Eingabe. Auflösen
 * wäre in beide Richtungen gefährlich - in de-DE gruppiert der Punkt, "1.000"
 * hiesse also tausend, während dieselbe Schreibweise als Dezimalzahl eins
 * bedeutet. Beide Deutungen sind vertretbar, und bei Geld ist die falsche um
 * den Faktor tausend daneben. Erkannt wird die Gruppierung am Muster, nicht am
 * blossen Zeichen: drei Ziffern hinter dem Trenner sind mehrdeutig, zwei
 * ("12.50") sind es nicht und gelten weiter als Dezimalangabe.
 *
 * Bewusst NICHT geldspezifisch, obwohl die Funktion hier wohnt: sie kennt
 * Ziffern und Trenner, keine Währung. Der Einkauf liest damit auch die
 * Mengenangabe eines Artikels („1,5 kg"), die vor dem Vorrats-Übertrag zerlegt
 * wird - ein anderes Feld, aber dieselbe Region und damit dieselbe Falle, sobald
 * jemand daneben eine zweite Fassung schreibt. Wer eine dritte Stelle mit
 * eingetippten Zahlen baut, ruft diese hier auf, statt `replace(',', '.')` neu
 * zu erfinden.
 *
 * `freeText` ist fuer genau diese Aufrufer da. Ein Betragsfeld enthaelt NUR eine
 * Zahl, dort ist es richtig, den ganzen Wert abzuweisen. Ein Freitext enthaelt
 * eine Zahl und dann noch etwas, und der Aufrufer liest nur den Anfang - eine
 * Gruppierung weiter hinten geht ihn nichts an. Ohne die Option fiel „6 × 1.000
 * ml" auf die Menge 1 zurueck, obwohl die 6 eindeutig ist und die 1.000
 * unveraendert im Rest der Zeile stehen bleibt.
 *
 * ZUGESICHERT: die Umschrift ist positionstreu IN CODEPOINTS - ein Codepoint
 * hinein, ein Codepoint hinaus. Wer nur die fuehrende Zahl eines Freitextes
 * umrechnet, darf den Rest deshalb per Codepoint-Offset aus dem ORIGINAL
 * schneiden (`[...text]` zaehlen, nicht `.length`): pages/meals.js skaliert so
 * „۲ x ۵۰۰ g" zu „۴ x ۵۰۰ g" und nicht zu „۴ x 500 g".
 *
 * In UTF-16 gilt sie NICHT, seit die Umschrift auf fremde Ziffernsysteme
 * zurueckfaellt: 40 der 77 Systeme liegen ausserhalb der BMP, ihre Ziffern
 * belegen zwei Einheiten, das ASCII-Ergebnis eine. Ein `.length`-Offset schnitt
 * damit mitten in ein Zeichen - gemessen wurde aus „𞥒 x 500 g" ein
 * „4\uDD52 x 500 g" mit halber Ersatzzeichen-Paarung, geschrieben in die
 * gespeicherte Zutatenzeile. Verhaltenstests in test-money-utils.js und
 * test-meals.js halten beide Enden.
 */
/**
 * Zeichen, die IRGENDEINE waehlbare Region als Dezimal- oder Gruppierungstrenner
 * fuehrt - gemessen ueber REGION_CODES, nicht geraten. Aktuell: , . ' ٫ ٬
 *
 * Whitespace-Trenner (fr gruppiert mit U+202F) fehlen bewusst: ein Leerzeichen
 * trennt im Freitext zwei Angaben („2 x 500 g") und ist deshalb kein Hinweis auf
 * eine abgeschnittene Zahl - die echte Gruppierung dahinter faengt ohnehin die
 * Musterpruefung oben.
 *
 * Wofuer: ein Freitext-Aufrufer liest nur die fuehrende Zahl und muss merken,
 * wenn sie mitten in einem Trenner ABBRICHT. Die Regel dafuer war erst
 * „irgendein Zeichen zwischen zwei Ziffern" - das traf auch „2x500 g", also die
 * Multiplikator-Schreibweise, die parseShoppingQuantity ausdruecklich lesen
 * koennen soll, und lieferte dort 1 statt 2. Ein `x` ist kein Trenner: nach ihm
 * ist die 2 vollstaendig gelesen.
 */
let _separators = null;
function numberSeparators() {
  if (_separators) return _separators;
  const found = new Set();
  for (const code of REGION_CODES) {
    try {
      const dec = new Intl.NumberFormat(code, { minimumFractionDigits: 1 })
        .formatToParts(1.5).find((part) => part.type === 'decimal')?.value;
      const grp = new Intl.NumberFormat(code, { useGrouping: true })
        .formatToParts(1234).find((part) => part.type === 'group')?.value;
      for (const sep of [dec, grp]) if (sep && !/\s/.test(sep)) found.add(sep);
    } catch { /* ungueltiger Regionscode: uebergehen, die Liste bleibt gueltig */ }
  }
  _separators = found;
  return _separators;
}

/**
 * Bricht der Rest hinter einer gelesenen Zahl mitten in einem Trenner ab?
 *
 * „2,5 kg" unter fa: das ASCII-Komma trennt dort nichts, die Zahl waere bei der 2
 * abgeschnitten und die ,5 verloren - dann lieber gar nicht lesen. „2x500 g"
 * dagegen ist vollstaendig gelesen, `x` ist kein Trenner.
 *
 * Geteilt zwischen pages/shopping.js und pages/meals.js: beide lesen eine
 * fuehrende Zahl aus einem Freitext und brauchen exakt dieselbe Antwort.
 */
export function breaksOffAtSeparator(rest) {
  // Codepunkt-weise und `\p{Nd}` statt `\d`: Letzteres ist in JavaScript ASCII,
  // und die Funktion darf ihre Antwort nicht davon abhaengig machen, ob der
  // Aufrufer schon umgeschrieben hat. „٫٥" ist ein Abbruch im Trenner, auch wenn
  // die 5 noch arabisch-indisch geschrieben ist. (Dieselbe Falle, gegen die die
  // ganze Datei angelegt ist - sie kam beim Schreiben dieser Zeile zurueck.)
  const [erstes, zweites] = [...String(rest ?? '')];
  if (!erstes || !zweites) return false;
  return numberSeparators().has(erstes) && /\p{Nd}/u.test(zweites);
}

/** Ein Trennzeichen als Regex-Literal. */
function escapeForRegExp(text) {
  return String(text ?? '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export function toDecimalString(value, { freeText = false } = {}) {
  const raw = String(value ?? '').trim();
  if (!raw) return '';

  // Die Ziffern des aktuell eingestellten Zahlensystems - genau die, die der
  // Platzhalter zeigt. Aus Intl abgeleitet statt aus einer Tabelle, damit ein
  // Regionswechsel nichts nachzupflegen lässt.
  const plain = getNumberFormat({ useGrouping: false, maximumFractionDigits: 0 });
  const digits = new Map();
  for (let i = 0; i < 10; i += 1) digits.set(plain.format(i), String(i));

  const parts = getNumberFormat({ useGrouping: false, minimumFractionDigits: 1 }).formatToParts(1.5);
  const decimalSep = parts.find((part) => part.type === 'decimal')?.value ?? '.';
  const groupSep = getNumberFormat({ useGrouping: true, maximumFractionDigits: 0 })
    .formatToParts(1234).find((part) => part.type === 'group')?.value;

  // Schritt 1: nur die ZIFFERN nach ASCII, die Trenner bleiben, wie sie sind.
  //
  // Die Ziffern der eingestellten Region haben den Vortritt; erst danach greift
  // die regionslose Zuordnung aus utils/digits.js. Das ist kein Luxus, sondern
  // die Kehrseite davon, dass gespeicherte Mengen seit v2.66 in den Ziffern ihrer
  // Region stehen: wer die Region spaeter wechselt, haette sonst Werte in der
  // Datenbank, die seine eigene Oberflaeche nicht mehr lesen kann - eine Zutat
  // „۴٫۵ kg" bliebe unter de beim Skalieren einfach liegen. Der Server liest sie
  // laengst, mit derselben Datei.
  let normalized = '';
  //
  // `asciiDigit` erst, wenn das Zeichen ueberhaupt eine Ziffer IST: die Zuordnung
  // dahinter wird beim ersten Zugriff aus 77 Zahlensystemen gebaut (gemessen
  // 19,5 ms), und ohne diese Schranke stiesse schon der erste Buchstabe eines
  // Freitextes den Aufbau an. So zahlt ihn nur, wer wirklich fremde Ziffern
  // eintippt - in de oder en-US also niemand.
  for (const char of raw) {
    normalized += digits.get(char)
      ?? (/\p{Nd}/u.test(char) ? asciiDigit(char) ?? char : char);
  }

  // Schritt 2: Gruppierungsmuster - der Trenner, gefolgt von genau drei Ziffern,
  // auf die keine weitere folgt. "1.000" in de-DE trifft zu, "12.50" nicht.
  //
  // Die Reihenfolge ist der ganze Punkt, und sie hat auf beiden Seiten eine
  // Kante. Vor Schritt 1 sieht `\d` (ASCII) die östlichen Ziffern hinter dem
  // Trenner nicht: ar-EG „٢٬٠٠٠" kam unerkannt durch und wurde zu „2٬000" - für
  // einen Betrag folgenlos, weil die Vollprüfung des Aufrufers am stehen
  // gebliebenen Trenner scheitert, aber eine Mengenangabe liest nur den ANFANG
  // und machte daraus die 2. Nach Schritt 3 wäre es genau andersherum falsch:
  // dort ist der Dezimaltrenner schon ein Punkt, und in de-DE IST der Punkt das
  // Gruppierungszeichen - „1,000" (also eins) flöge als vermeintlich gruppiert
  // raus. Zwischen den beiden Schritten stimmt beides.
  if (groupSep && groupSep !== decimalSep) {
    const escaped = escapeForRegExp(groupSep);
    // Bei Freitext zaehlt nur der fuehrende Zahlenbereich, denn der Aufrufer
    // liest auch nur den. Sonst wies eine Gruppierung IRGENDWO im Text die ganze
    // Zeile ab: „6 × 1.000 ml" fiel auf die Menge 1 zurueck, obwohl die 6 am
    // Anfang voellig eindeutig ist und die 1.000 im Rest gar nicht gelesen wird.
    const bereich = freeText
      ? (normalized.match(new RegExp(`^\\d+(?:[${escaped}${escapeForRegExp(decimalSep)}]\\d+)*`))?.[0] ?? '')
      : normalized;
    if (new RegExp(`${escaped}\\d{3}(?!\\d)`).test(bereich)) return '';
  }

  // Schritt 3: nur der Trenner der eingestellten Region wird zum Punkt. Das
  // ASCII-Komma pauschal mitzunehmen wäre gefährlich: unter en-US gruppiert es
  // Tausender, aus "1,000" würde dann "1.000" und daraus die Zahl 1 - ein
  // Anteil, der um den Faktor tausend danebenliegt, ohne dass irgendwo ein
  // Fehler erscheint.
  //
  // Fremde TRENNER erst hier, nicht in Schritt 1: sonst waere ein U+066C schon ein
  // Komma, bevor die Pruefung oben nach dem Gruppierungszeichen der Region sucht -
  // gemessen fiel ar-EG „٢٬٠٠٠" damit durch, obwohl es eindeutig gruppiert ist.
  // Die ZIFFERN muessen dagegen vorher fallen, damit `\d{3}` sie zaehlen kann.
  let out = '';
  for (const char of normalized) {
    out += char === decimalSep ? '.' : (asciiSeparator(char) ?? char);
  }
  return out;
}

/**
 * Betrag in ganzen Einheiten (Cent, Yen, Fils) als Wert für ein Eingabefeld.
 *
 * Der Einkauf speichert Preise als ganze Zahl, weil die Kaufhistorie sie
 * addiert und Geld in einem Gleitkomma sich sichtbar falsch summiert. Zwischen
 * Feld und Datenbank liegt damit eine Umrechnung, und sie gehört hierher: der
 * Trenner kommt aus der eingestellten Region, sonst zeigte ein Feld "2.49"
 * unter einem Platzhalter, der "0,00" verspricht.
 *
 * Ohne Tausendergruppierung, denn `toDecimalString` weist gruppierte Eingaben
 * ab - ein Wert, der so nicht wieder hereinkäme, darf auch nicht hinaus.
 */
/**
 * Eine Zahl als TEXT, der gespeichert und spaeter wieder gelesen wird.
 *
 * Die Zusicherung, genau: **Ziffern UND Trenner folgen der eingestellten
 * Region.** Unter fa ist `toStoredNumber(0.5)` also „۰٫۵", nicht „0.5".
 *
 * Bis v2.65 stand hier ein `numberingSystem: 'latn'` und mit ihm die Ausnahme
 * fuer fa, ar-EG und ar-SA: der Server las Mengen mit einer ASCII-Regex, und eine
 * Menge in nativen Ziffern kam dort nicht an - die Zutat fiel beim Uebertrag in
 * die Einkaufsliste aus der Summierung, aus einer Anzeigefrage wurde ein
 * Funktionsverlust. Seit `parseQuantity` dieselbe Umschrift benutzt
 * (utils/digits.js, geteilt), ist der Grund entfallen, und eine skalierte
 * Zutatenzeile mischt nicht laenger zwei Schriften.
 *
 * Gelesen wird der Wert von zwei Stellen: hier ueber `toDecimalString` und auf
 * dem Server. Beide kommen auch mit einem Wert zurecht, der unter einer ANDEREN
 * Region geschrieben wurde - sonst haette diese Umstellung Altdaten erzeugt, die
 * die eigene Oberflaeche nach einem Regionswechsel nicht mehr liest.
 *
 * Ohne Gruppierung, damit `toDecimalString` den Wert wieder einliest.
 */
export function toStoredNumber(value, { maximumFractionDigits = 2 } = {}) {
  return getNumberFormat({ useGrouping: false, maximumFractionDigits }).format(value);
}

export function centsToAmountInput(cents, currency) {
  return amountToInput(Number(cents) / 10 ** currencyFractionDigits(currency), currency);
}

/**
 * Ein Dezimalbetrag (Zahl oder Punkt-Dezimaltext vom Server, "12.50") als Wert
 * für ein Eingabefeld - das Gegenstück zu `toDecimalString`.
 *
 * Trenner und Ziffern der Region, ohne Gruppierung, aufgefüllt auf die Stellen
 * der Währung: EUR/de "12,50", EUR/en-US "12.50", JPY "1300". Es ist dieselbe
 * Schreibweise, die `amountPlaceholder` und `amountExample` zeigen, und
 * `centsToAmountInput` rechnet nur vorher um.
 *
 * Nach oben NICHT gekappt: ein Bestandswert neben dem Raster (12,5 JPY, in EUR
 * erfasst) erscheint so, wie er gespeichert ist. Ihn hier zu runden hiesse, beim
 * blossen Öffnen des Dialogs einen anderen Betrag ins Feld zu schreiben.
 *
 * Gearbeitet wird auf dem TEXT, nicht auf der Zahl: Ganzzahl- und Bruchteil
 * werden getrennt übernommen und nur Ziffern und Trenner der Region eingesetzt.
 * Der Server rechnet Geld in ganzen Einheiten bis `Number.MAX_SAFE_INTEGER`, als
 * Dezimalbetrag passt das nicht mehr in ein Gleitkomma: `90071992547409.91`
 * stand über `Number()` als `90071992547409,90` im Feld, und wer den Dialog
 * öffnete und unverändert speicherte, zog einen Cent ab.
 *
 * Leer bleibt leer, und was keine Zahl ist, kommt unverändert zurück - ein
 * Feld soll nie "NaN" zeigen.
 */
export function amountToInput(amount, currency) {
  if (amount === '' || amount == null) return '';
  // Eine Zahl (die Übergabe aus dem Budget reicht 12.5) hat als Text ihre
  // kürzeste eindeutige Schreibweise; ein Dezimaltext des Servers bleibt, was
  // er ist. Exponentenschreibweise trifft das Muster nicht und läuft unten
  // über Intl.
  const text = String(amount).trim();
  const digits = currencyFractionDigits(currency);
  const match = /^(-?)(\d+)(?:\.(\d+))?$/.exec(text);
  if (!match) {
    const value = Number(text);
    if (text === '' || !Number.isFinite(value)) return String(amount);
    return getNumberFormat({
      useGrouping: false, minimumFractionDigits: digits, maximumFractionDigits: Math.max(digits, 20),
    }).format(value);
  }
  const [, sign, whole, fraction = ''] = match;
  // Ziffern und Trenner aus Intl abgeleitet, wie in toDecimalString - genau die
  // Zeichen, die jene Funktion beim Speichern wieder liest.
  const plain = getNumberFormat({ useGrouping: false, maximumFractionDigits: 0 });
  const regional = (run) => [...run].map((char) => plain.format(Number(char))).join('');
  const decimalSep = getNumberFormat({ useGrouping: false, minimumFractionDigits: 1 })
    .formatToParts(1.5).find((part) => part.type === 'decimal')?.value ?? '.';
  const padded = fraction.padEnd(digits, '0');
  return sign + regional(whole) + (padded ? decimalSep + regional(padded) : '');
}

/**
 * Eingabe -> ganze Einheiten, oder null bei Unsinn.
 *
 * Über `toAmountDecimalString`, nicht über ein eigenes `replace(',', '.')`: das nähme
 * unter en-US aus "1,000" die Zahl 1 und unter ar/fa die östlichen Ziffern
 * überhaupt nicht an. Beides fällt nicht auf - der Preis wäre nur falsch.
 */
export function amountInputToCents(text, currency) {
  const norm = toAmountDecimalString(text);
  if (!/^\d+(\.\d+)?$/.test(norm)) return null;
  const digits = currencyFractionDigits(currency);
  const cents = Math.round(Number(norm) * 10 ** digits);
  return Number.isFinite(cents) ? cents : null;
}

/**
 * Warum ein eingetippter Betrag nicht gespeichert werden kann - oder `null`.
 *
 * Die Antwort ist ein GRUND, kein Ja/Nein: ein Formular, das nur den
 * Speichern-Knopf sperrt, lässt die übliche Schreibweise für zehntausend Won
 * ("10,000") kommentarlos liegen (#1607). Den Text dazu wählt der Aufrufer.
 *
 * - `'grouped'`: Tausendergruppierung. `toDecimalString` löst sie bewusst nicht
 *   auf (siehe dort), hier bekommt die Ablehnung einen Namen.
 * - `'invalid'`: keine Dezimalzahl in der Schreibweise, die der Server liest.
 * - `'notPositive'`: null oder negativ.
 * - `'precision'`: mehr Nachkommastellen, als die Währung kennt.
 *
 * Die Stellen werden am TEXT gezählt, nicht an der Zahl: "10.000" ist unter
 * ko-KR die Zahl 10 und passt damit ins Raster von KRW, gesendet wird aber der
 * Text, und parseMoneyToMinor() auf dem Server zählt die Stellen hinter dem
 * Punkt. Ein Vergleich an der Zahl saehe diese Nullen nicht.
 *
 * Ein leeres Feld hat keinen Grund - das ist Sache der Pflichtfeld-Prüfung.
 *
 * `original` ist der Bestandswert des Feldes: ein
 * unangetasteter Betrag neben dem Raster bleibt speicherbar, solange er nicht
 * MEHR Stellen trägt als vorher. Ein Währungswechsel hebt den Schutz auf
 * (`originalCurrency`): 12.50 EUR, auf JPY umgestellt, ist ein neuer Betrag.
 */
export function amountInputProblem(text, currency, { original = null, originalCurrency = null, required = false, sign = 'positive', decimalComma = false } = {}) {
  const raw = withAsciiMinus(text);
  // Leer ist Sache des Pflichtfelds - ausser der Aufrufer sagt, dass ein Betrag
  // da sein muss: `required` des Browsers nimmt ein Feld aus Leerzeichen an,
  // und die Genau-Beträge einer Aufteilung haben gar kein Pflichtfeld.
  if (!raw) return required ? 'notPositive' : null;
  const decimal = decimalComma ? toAmountDecimalString(raw) : toDecimalString(raw);
  // Leer trotz Eingabe heisst: toDecimalString hat eine Gruppierung abgewiesen.
  // Ein Leerzeichen zwischen Ziffern ist dasselbe in der Schreibweise von fr
  // oder sv ("10 000").
  if (!decimal || /\d\s+\d/.test(decimal)) return 'grouped';
  if (!/^-?\d+(\.\d+)?$/.test(decimal)) return 'invalid';
  const value = Number(decimal);
  // `sign`: was ausser "groesser als null" noch zaehlt. Ein Kreditrahmen oder
  // ein Zuschlag darf 0 sein, ein Startsaldo auch negativ. Ein Minus, wo keines
  // hingehoert, ist kein Betrag in der erwarteten Schreibweise ('invalid').
  if (sign === 'any') { /* jedes Vorzeichen */ } else if (sign === 'nonNegative') {
    if (value < 0 || decimal.startsWith('-')) return 'invalid';
  } else if (!(value > 0)) return 'notPositive';
  const places = fractionLength(decimal);
  if (places <= currencyFractionDigits(currency)) return null;
  const untouched = original != null && Number(original) === value
    && (originalCurrency == null || originalCurrency === currency)
    && places <= fractionLength(String(original));
  return untouched ? null : 'precision';
}

/**
 * Der Text eines Betragsfeldes mit ASCII-Minus vorn. Intl schreibt negative
 * Zahlen in manchen Regionen mit U+2212 (sv, fi, nb) - wer die eigene Anzeige
 * abtippt, soll nicht an einem Zeichen scheitern, das er nicht sieht.
 */
function withAsciiMinus(text) {
  return String(text ?? '').trim().replace(/^[\u2212\u2012\u2013\uFE63\uFF0D]/, '-');
}

/**
 * Device and household decimal keys can differ (#2170). Keep grouping checks
 * and decimal digits intact for APIs that require strings, including large
 * amounts and trailing zeros. Validation still checks the entire result.
 */
export function toAmountDecimalString(text) {
  const decimal = toDecimalString(withAsciiMinus(text));
  if (/,\d{3}(?!\d)/.test(decimal)) return '';
  return decimal.replace(',', '.').replace(/^(-?)\./, (_, sign) => `${sign}0.`);
}

/**
 * Der Wert eines Betrags-TEXTFELDES als Zahl - `null` bei leerem Feld, `NaN`
 * bei allem, was `amountInputProblem` abweist. Gegenstueck zu `amountToInput`.
 *
 * Gelesen wird ueber `toDecimalString`, mit dem Trenner der Region oder dem
 * Komma einer abweichenden Geraetetastatur (#2170), weiterhin
 * ohne Gruppierung: "1.200" ist unter de nie still 1,2 (das war der Fehler der
 * `type="number"`-Felder, Critique R23 P1), sondern wird abgewiesen.
 */
export function parseAmountInput(text) {
  const raw = withAsciiMinus(text);
  if (!raw) return null;
  const decimal = toAmountDecimalString(raw);
  if (!/^-?\d+(\.\d+)?$/.test(decimal)) return NaN;
  const value = Number(decimal);
  return Number.isFinite(value) ? value : NaN;
}

/** Stellen hinter dem Punkt einer Dezimalangabe: "10.000" -> 3, "10" -> 0. */
function fractionLength(decimal) {
  return (String(decimal).split('.')[1] ?? '').length;
}

/**
 * Ein Beispiel für die erwartete Schreibweise eines Betrags: ohne Gruppierung,
 * mit Trenner und Ziffern der Region und den Stellen der Währung.
 * EUR/de -> "1250,00", KRW -> "1250".
 */
export function amountExample(currency) {
  const digits = currencyFractionDigits(currency);
  return getNumberFormat({
    useGrouping: false, minimumFractionDigits: digits, maximumFractionDigits: digits,
  }).format(1250);
}

/**
 * Betrag nach Rolle. Liefert Text, Ton und die passende Modifier-Klasse
 * gemeinsam, damit Vorzeichen und Farbe nie auseinanderlaufen können.
 *
 * @param {number} amount
 * @param {object} options
 * @param {string} options.currency  ISO-Code, z. B. 'EUR'
 * @param {'flow'|'total'|'balance'|'plain'} options.role
 * @param {'positive'|'negative'|'neutral'} [options.tone]  nur bei role 'total':
 *        die Richtung steht dort im Label, nicht im Vorzeichen.
 * @param {string} [options.block]  BEM-Block für die Modifier-Klasse,
 *        z. B. 'budget-entry__amount' -> 'budget-entry__amount--income'
 * @returns {{ text: string, tone: 'positive'|'negative'|'neutral', className: string }}
 */
export function formatSignedAmount(amount, { currency, role, tone, block } = {}) {
  const value = Number(amount) || 0;

  // `exceptZero` statt manuellem '+'-Prefix: das Vorzeichen gehört ins
  // Zahlformat, sonst steht es in RTL-Locales auf der falschen Seite.
  const signDisplay = role === 'flow'
    ? 'exceptZero'
    : 'auto';

  const magnitude = (role === 'total' || role === 'plain') ? Math.abs(value) : value;
  const text = getNumberFormat({ style: 'currency', currency: usableCurrency(currency), signDisplay }).format(magnitude);

  const resolvedTone = resolveTone(value, role, tone);
  return { text, tone: resolvedTone, className: block ? `${block}--${resolvedTone}` : '' };
}

function resolveTone(value, role, tone) {
  if (role === 'plain') return 'neutral';
  if (role === 'total') return tone || 'neutral';
  // flow und balance: die Zahl selbst trägt die Richtung.
  if (value > 0) return 'positive';
  if (value < 0) return 'negative';
  return 'neutral';
}
