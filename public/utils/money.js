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

/** Erlaubte Rollen. Wird vom Guard in test-budget-ui.js gegen die Aufrufe geprüft. */
export const MONEY_ROLES = ['flow', 'total', 'balance', 'plain'];

/**
 * Reiner Betrag ohne Rollenlogik. Nur benutzen, wenn wirklich kein Vorzeichen
 * und keine Farbe im Spiel sind (Achsenbeschriftung, Tooltip, CSV).
 */
export function formatMoney(amount, currency) {
  return getNumberFormat({ style: 'currency', currency }).format(Number(amount) || 0);
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
    style: 'currency', currency, maximumFractionDigits: 0, minimumFractionDigits: 0,
  }).format(Number(amount) || 0);
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
 * Passt ein Betrag ins Raster der Währung? 1300 JPY ja, 12,5 JPY nein.
 *
 * Das `step`-Attribut allein reicht dafür nicht: die Budget-Dialoge sind keine
 * `<form>`-Elemente, sie speichern über einen Button-Handler. Die native
 * Prüfung läuft also nie, und ein Feld mit step="1" nähme trotzdem 12,5
 * entgegen. Wer eine Schrittweite anzeigt, muss sie auch selbst durchsetzen.
 *
 * Über `toFixed` und nicht über `wert * 10**stellen` mit einer festen Toleranz:
 * `131072.02 * 100` ergibt `13107201.999999998`, liegt also knapp zwei
 * Milliardstel daneben. Jede feste Schranke ist damit entweder zu eng (dieser
 * gültige Betrag flöge raus) oder zu weit (bei kleinen Beträgen ginge echter
 * Bruch durch). Der Vergleich mit der gerundeten Dezimaldarstellung braucht
 * gar keine Schranke und stimmt über jede Größenordnung.
 */
export function fitsCurrencyGrid(amount, currency) {
  const value = Number(amount);
  if (!Number.isFinite(value)) return false;
  return Number(value.toFixed(currencyFractionDigits(currency))) === value;
}

/** Die kleinste erfassbare Einheit als Text fürs Feld: JPY "1", EUR "0.01". */
export function smallestUnitLabel(currency) {
  const digits = currencyFractionDigits(currency);
  return smallestUnit(digits).toFixed(digits);
}

/**
 * Darf dieser Betrag gespeichert werden? Wie `fitsCurrencyGrid`, lässt aber
 * einen unangetasteten Bestandswert durch.
 *
 * Nötig, weil `amountStep` bei einem Bestandswert neben dem Raster `"any"`
 * liefert - sonst markierte der Browser einen bereits gespeicherten Eintrag als
 * ungültig, und selbst eine Änderung am Titel liesse sich nicht mehr sichern.
 * Dieses `"any"` gilt aber fürs ganze Feld: ohne die Prüfung hier wäre aus
 * einem Alt-Betrag von 12,5 JPY anschliessend auch 12,555 JPY speicherbar,
 * also mehr Bruch als vorher. Der Bestandsschutz endet deshalb genau dort, wo
 * der Wert angefasst wird.
 *
 * Ein Währungswechsel hebt ihn ebenfalls auf: wer auf JPY umstellt, hat das
 * Raster bewusst gewechselt.
 */
export function amountIsSavable(value, currency, { original = null, originalCurrency = null } = {}) {
  if (fitsCurrencyGrid(value, currency)) return true;
  if (original == null) return false;
  if (originalCurrency != null && originalCurrency !== currency) return false;
  return Number(original) === Number(value);
}

/**
 * Schrittweite für ein Betragsfeld, passend zur Währung: "1" bei JPY, "0.01"
 * bei EUR, "0.001" bei KWD. Immer mit Punkt - `step` und `min` sind HTML-Syntax,
 * kein Anzeigeformat.
 *
 * `currentValue` ist der Bestandswert des Feldes. Passt er nicht ins Raster,
 * entfällt die Schrittprüfung ("any"): ein in EUR erfasster Betrag von 12,50
 * oder eine Split-Teilung (10/3) würde sonst vom Browser als ungültig markiert
 * und das Speichern stillschweigend blockieren.
 */
export function amountStep(currency, currentValue) {
  const digits = currencyFractionDigits(currency);
  if (currentValue !== '' && currentValue != null && Number.isFinite(Number(currentValue))) {
    if (!fitsCurrencyGrid(currentValue, currency)) return 'any';
  }
  return smallestUnit(digits).toFixed(digits);
}

/**
 * Untergrenze für ein Pflicht-Betragsfeld: eine Einheit, also der kleinste
 * erfassbare positive Betrag. Liegt der Bestandswert darunter (0,50 erfasst in
 * EUR, jetzt JPY mit Untergrenze 1), gilt er selbst - sonst liesse sich ein
 * vorhandener Eintrag nicht mehr speichern.
 */
export function amountMin(currency, currentValue) {
  const digits = currencyFractionDigits(currency);
  const smallest = smallestUnit(digits);
  const value = Math.abs(Number(currentValue));
  if (Number.isFinite(value) && value > 0 && value < smallest) return String(value);
  return smallest.toFixed(digits);
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
 * ZUGESICHERT: die Umschrift ist positionstreu - ein Zeichen hinein, dasselbe
 * eine Zeichen hinaus, `toDecimalString(x).length === x.trim().length`. Wer nur
 * die fuehrende Zahl eines Freitextes umrechnet, darf den Rest deshalb per
 * Offset aus dem ORIGINAL schneiden, statt die umgeschriebene Fassung
 * anzuhaengen: pages/meals.js skaliert so „۲ x ۵۰۰ g" zu „۴ x ۵۰۰ g" und nicht
 * zu „۴ x 500 g". Ein Verhaltenstest in test-meals.js haelt die Zusicherung.
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
  let normalized = '';
  for (const char of raw) normalized += digits.has(char) ? digits.get(char) : char;

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
  let out = '';
  for (const char of normalized) out += char === decimalSep ? '.' : char;
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
 * Die Zusicherung, genau: **die Ziffern sind IMMER ASCII, und der Trenner folgt
 * der Region, solange sie einen serverlesbaren fuehrt.** Das ist `.` und `,` -
 * mehr kennt `parseQuantity` in server/services/shopping-import.js nicht. de, fr,
 * cs, pl bekommen ihr Komma, en-US und de-CH ihren Punkt. Wo eine Region einen
 * DRITTEN Trenner fuehrt (fa, ar-EG und ar-SA schreiben `٫`), gewinnt die
 * Lesbarkeit und es wird der Punkt: `toStoredNumber(0.5)` ist dort „0.5", nicht
 * „0٫5". Das ist keine Unachtsamkeit, sondern die einzige Wahl, solange der
 * Server nur zwei Zeichen kennt - und `numberingSystem: 'latn'` trifft sie von
 * selbst, weil es Ziffern und Symbole gemeinsam umstellt.
 *
 * Warum die Ziffern nicht der Region folgen duerfen: pages/meals.js schreibt die
 * skalierte Zutatenmenge zurueck in die Zutatenzeile, und beim Uebertrag in die
 * Einkaufsliste liest der Server sie wieder ein. Eine Menge in nativen Ziffern
 * („۲۰۰۰ g") kaeme dort nicht an und liesse sich nicht mehr mit anderen
 * zusammenzaehlen - aus einer Anzeigefrage waere ein Funktionsverlust geworden.
 *
 * Ohne Gruppierung, damit `toDecimalString` den Wert wieder einliest.
 *
 * Der saubere Endzustand waere eine Ziffern- und Trenner-Umschrift auf dem
 * Server; dann duerfte hier auch `٫` stehen. Solange es sie nicht gibt, ist die
 * Schreibweise hier der Vertrag zwischen beiden Seiten.
 */
export function toStoredNumber(value, { maximumFractionDigits = 2 } = {}) {
  return getNumberFormat({
    useGrouping: false, maximumFractionDigits, numberingSystem: 'latn',
  }).format(value);
}

export function centsToAmountInput(cents, currency) {
  const digits = currencyFractionDigits(currency);
  return getNumberFormat({
    useGrouping: false, minimumFractionDigits: digits, maximumFractionDigits: digits,
  }).format(Number(cents) / 10 ** digits);
}

/**
 * Eingabe -> ganze Einheiten, oder null bei Unsinn.
 *
 * Über `toDecimalString`, nicht über ein eigenes `replace(',', '.')`: das nähme
 * unter en-US aus "1,000" die Zahl 1 und unter ar/fa die östlichen Ziffern
 * überhaupt nicht an. Beides fällt nicht auf - der Preis wäre nur falsch.
 */
export function amountInputToCents(text, currency) {
  const norm = toDecimalString(text);
  if (!/^\d+(\.\d+)?$/.test(norm)) return null;
  const digits = currencyFractionDigits(currency);
  const cents = Math.round(Number(norm) * 10 ** digits);
  return Number.isFinite(cents) ? cents : null;
}

/**
 * Ein bestehendes Betragsfeld auf eine Währung nachziehen: Platzhalter,
 * Schrittweite und - bei Pflichtfeldern - Untergrenze in einem Zug.
 *
 * Nötig überall dort, wo die Währung im selben Formular wählbar ist (Abo,
 * geteilte Ausgabe, Darlehen). Ohne das Nachziehen zeigt das Feld nach einem
 * Wechsel von EUR auf JPY weiter "0,00" und liesse Hundertstel Yen zu.
 *
 * Der Bestandswert-Schutz von amountStep/amountMin gilt hier bewusst NICHT: er
 * existiert, damit ein in EUR erfasster Betrag beim Öffnen des Dialogs nicht
 * als ungültig gilt. Wer die Währung gerade selbst auf JPY stellt, hat den
 * Wechsel dagegen bewusst ausgelöst - liesse man das Raster hier offen, wären
 * Hundertstel Yen weiter eingebbar und würden auch so gespeichert.
 *
 * @param {HTMLInputElement|null} input
 * @param {string} currency  ISO-Code
 * @param {{ required?: boolean }} [options]  required: das Feld verlangt einen
 *        Betrag > 0, bekommt also zusätzlich eine Untergrenze.
 */
export function applyAmountFormat(input, currency, { required = false } = {}) {
  if (!input) return;
  input.placeholder = amountPlaceholder(currency);
  input.step = amountStep(currency);
  if (required) input.min = amountMin(currency);
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
  const text = getNumberFormat({ style: 'currency', currency, signDisplay }).format(magnitude);

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
