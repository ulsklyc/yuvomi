/**
 * Zutatenmengen umrechnen - ein Baustein fuer Mahlzeit-Dialog und Rezept (R24, E12).
 *
 * Lag in pages/meals.js; seit das Rezept selbst Portionen kennt und sein
 * Leseblatt umrechnet, braucht ihn eine zweite Seite. Ein geteiltes Util statt
 * eines Cross-Page-Imports (Begruendung wie utils/recipe-to-meal.js).
 */

import { toDecimalString, breaksOffAtSeparator, toStoredNumber } from '/utils/money.js';

/**
 * Eine skalierte Zutatenmenge, in der Schreibweise der eingestellten Region.
 *
 * Die Menge ist Freitext („250 g", „1 1/2 Tassen", „eine Prise"), also wird nur
 * die fuehrende Zahl angefasst und der Rest der Zeile unveraendert angehaengt.
 * Erkannt werden gemischte Brueche, einfache Brueche und Dezimalzahlen; alles
 * andere bleibt, wie es dasteht.
 *
 * LESEN UND SCHREIBEN haengen beide an der Region, und das ist der Kern. Vorher
 * las die Funktion mit einem eigenen `replace(',', '.')` und schrieb mit einem
 * `useComma`, das sie sich aus der Eingabe abgeschaut hatte. Beides war still
 * falsch: unter en-US gruppiert das Komma Tausender, „1,000 g" wurde also zur
 * Basis 1 und danach mit dem Faktor multipliziert - eine Zutat, die um den
 * Faktor tausend zu klein im Rezept stand. Unter fa oder ar-EG traf die Regex
 * gar nicht erst (`\d` ist ASCII), die Zeile blieb ungeskaliert zwischen
 * skalierten Geschwistern stehen. Und das abgeschaute `useComma` konnte den
 * Trenner nur wiederholen, den die gespeicherte Zutat zufaellig trug - eine aus
 * Mealie gespiegelte „1.5" blieb in einer deutschen Oberflaeche „1.5".
 *
 * Die Umschrift ist dieselbe wie bei Preis und Einkaufsmenge
 * (`toDecimalString`), die Ausgabe geht durch `toStoredNumber`. Damit
 * liest die Funktion ihre eigene Ausgabe wieder ein, was sie muss: der
 * gerenderte Wert landet in einer Zutatenzeile, wird gespeichert und beim
 * naechsten Anwenden des Rezepts erneut skaliert. Deshalb auch ohne
 * Gruppierung - ein gruppierter Wert kaeme nicht wieder herein.
 *
 * Eine gruppierte Eingabe wird abgewiesen und die Zeile bleibt UNVERAENDERT
 * stehen. Das ist bewusst ein anderer Ausgang als beim Einkauf, wo ein nicht
 * verstandener Wert auf „1 Stueck" faellt: dort ist die Menge ein Vorschlag in
 * einem korrigierbaren Feld, hier ist sie der Text der Zutat selbst, und der
 * Originaltext ist die einzige Antwort, die nichts erfindet.
 */
export function scaleQuantityText(quantity, factor) {
  if (!quantity || factor === 1) return quantity;

  // Erst umschreiben, dann lesen: sonst sieht die ASCII-Regex unter fa/ar-EG
  // ueberhaupt keine Ziffer, und zwar auch nicht in einem Bruch wie „1 1/2".
  // `freeText`, weil nur die fuehrende Zahl gerechnet wird: eine Gruppierung im
  // Rest („2 Dosen à 1.000 ml") darf die Zeile nicht ungeskaliert stehen lassen.
  const original = String(quantity).trim();
  const text = toDecimalString(original, { freeText: true });
  if (!text) return quantity;

  // Der Rest der Zeile kommt aus dem ORIGINAL, nicht aus der umgeschriebenen
  // Fassung: umgeschrieben wird nur, was auch gerechnet wird. Sonst verloere ein
  // zweiter Zahlenteil im Text seine Ziffern - unter fa wurde „۲ x ۵۰۰ g" zu
  // „۴ x 500 g", also zu einer Zeile in zwei Schriften. Der Offset stimmt, weil
  // toDecimalString positionstreu ist (ein Zeichen hinein, ein Zeichen hinaus);
  // die Zusicherung steht dort im Kopf und haengt an einem Guard.
  // In CODEPOINTS, nicht in UTF-16-Einheiten: die Ziffern von 40 der 77 Systeme
  // liegen ausserhalb der BMP und belegen zwei Einheiten, ihr ASCII-Ergebnis nur
  // eine. Mit `.length` verrutschte der Schnitt genau dort und schnitt mitten in
  // ein Zeichen - gemessen ergab „𞥒 x 500 g" ein „4\uDD52 x 500 g" mit einer
  // halben Ersatzzeichen-Paarung, und dieser kaputte Text wurde in die
  // Zutatenzeile geschrieben.
  const zeichen = [...original];
  const restOf = (match, tailGroup) => zeichen.slice([...match[0]].length - [...match[tailGroup]].length).join('');

  // Der Abbruch-im-Trenner gilt fuer ALLE drei Formen, nicht nur fuer die
  // Dezimalzahl unten. Bricht ein Nenner in einem Trenner ab, ist der Bruch nicht
  // gelesen, sondern abgeschnitten: aus „1/2,5 cup" wurde 1/2, mal Faktor, und der
  // Rest „,5 cup" dahinter - also „1,5 cup", eine plausible und falsche Menge.
  // Dann lieber gar nichts anfassen, wie bei „eine Prise".
  const mixed = text.match(/^(\d+)\s+(\d+)\/(\d+)(.*)$/);
  if (mixed) {
    if (breaksOffAtSeparator(mixed[4])) return quantity;
    const whole = Number(mixed[1]);
    const num = Number(mixed[2]);
    const den = Number(mixed[3]);
    if (den > 0) return `${formatScaledQuantity((whole + (num / den)) * factor)}${restOf(mixed, 4)}`;
  }

  const frac = text.match(/^(\d+)\/(\d+)(.*)$/);
  if (frac) {
    if (breaksOffAtSeparator(frac[3])) return quantity;
    const num = Number(frac[1]);
    const den = Number(frac[2]);
    if (den > 0) return `${formatScaledQuantity((num / den) * factor)}${restOf(frac, 3)}`;
  }

  const dec = text.match(/^(\d+(?:\.\d+)?)(.*)$/);
  if (dec) {
    // Bricht die Zahl mitten in einem Trennzeichen ab, ist sie nicht gelesen,
    // sondern abgeschnitten. Unter fa ist das ASCII-Komma kein Dezimaltrenner:
    // aus „1,5 kg" waere sonst die Basis 1 geworden und die Ausgabe „۲,5 kg",
    // also eine halbierte Zutat in einer Schreibweise, die es nicht gibt.
    // Ueber dieselbe geteilte Pruefung wie im Einkauf: sie kennt die Trennzeichen
    // der waehlbaren Regionen. „Irgendein Zeichen zwischen zwei Ziffern" war zu
    // breit und liess „2x500 g" ungeskaliert stehen - ein `x` trennt nichts.
    const abgeschnitten = breaksOffAtSeparator(dec[2]);
    const base = Number(dec[1]);
    if (!abgeschnitten && Number.isFinite(base)) {
      return `${formatScaledQuantity(base * factor)}${restOf(dec, 2)}`;
    }
  }

  // „eine Prise", „nach Geschmack": nichts zu rechnen, also nichts anfassen.
  return quantity;
}

/**
 * Die skalierte Zahl als Text: hoechstens zwei Nachkommastellen, Ziffern in
 * ASCII, Trenner aus der Region soweit serverlesbar, ohne Gruppierung.
 *
 * Warum die Ziffern NICHT der Region folgen, obwohl der Trenner es tut: dieser
 * Text wird in die Zutatenzeile geschrieben und gespeichert, und beim Uebertrag
 * in die Einkaufsliste liest ihn `parseQuantity` in
 * server/services/shopping-import.js mit einer ASCII-Regex wieder ein. Eine in
 * nativen Ziffern geschriebene Menge („۲۰۰۰ g") kaeme dort nicht an - die Zutat
 * liesse sich nicht mehr mit anderen zusammenzaehlen. Begruendung und der Weg zu
 * einem saubereren Endzustand stehen bei `toStoredNumber` in utils/money.js.
 */
function formatScaledQuantity(value) {
  return toStoredNumber(value);
}

/**
 * Der Faktor einer Portionenwahl: gewaehlte durch gespeicherte Portionen. Ohne
 * gespeicherte Zahl IST die Wahl der Faktor (Vielfache des Rezepts), damit ein
 * Bestandsrezept ohne Portionen weiter umrechnet - derselbe Stepper, anderes Wort.
 *
 * @param {number|null} base   recipe.servings oder null
 * @param {number} chosen      Wert des Steppers
 */
export function servingsFactor(base, chosen) {
  const value = Number(chosen);
  if (!Number.isFinite(value) || value <= 0) return 1;
  return base ? value / base : value;
}

/** Die Zutaten eines Rezepts mit umgerechneter Menge (neue Objekte). */
export function scaledIngredients(ingredients, factor) {
  return (ingredients || []).map((ing) => ({ ...ing, quantity: scaleQuantityText(ing.quantity ?? '', factor) || null }));
}
