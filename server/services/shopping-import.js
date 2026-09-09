import { toAsciiDigits } from '../utils/digits.js';

/**
 * Zerlegt eine Mengenangabe in Zahl und Einheit. Liefert null, wenn vorne keine
 * Zahl steht („eine Prise") - dann wird die Zutat nicht zusammengezaehlt,
 * sondern bleibt als eigene Zeile stehen.
 *
 * Die Ziffern werden vorher umgeschrieben (utils/digits.js). Ohne das traf die
 * ASCII-Regex eine Menge wie „۲۵۰ g" oder „٢٥٠ g" ueberhaupt nicht: die Zutat
 * fiel wortlos aus der Summierung und stand danach zweimal untereinander auf der
 * Liste, statt einmal mit der Summe. Ein Haushalt, der seine eigenen Ziffern
 * benutzt, bekam damit stillschweigend eine schlechtere Einkaufsliste.
 *
 * Die EINHEIT wird bewusst aus dem ORIGINAL geschnitten, nicht aus der
 * umgeschriebenen Fassung: umgeschrieben wird nur, was gerechnet wird. „۲ x ۵۰۰
 * g" behaelt so seinen Rest, statt zu „2 x 500 g" zu werden. Der Offset stimmt,
 * weil toAsciiDigits positionstreu ist - die Zusicherung steht dort im Kopf und
 * haengt an einem Test.
 */
const ARABIC_THOUSANDS = '\u066C';

function parseQuantity(value) {
  const raw = String(value || '').trim();
  if (!raw) return null;
  const match = toAsciiDigits(raw).match(/^([+-]?\d+(?:[.,]\d+)?)\s*(.*)$/);
  if (!match) return null;

  // Ein Bruch ist keine Zahl mit Rest. „١/٢ kg" ergaebe sonst den Betrag 1 und
  // die Einheit „/٢ kg", und zwei halbe Kilo stuenden als „2 /٢ kg" auf der
  // Liste. Ohne die Umschrift traf die Regex solche Mengen gar nicht und sie
  // blieben auf dem Rohtext-Pfad - dorthin gehoeren sie weiter, bis jemand
  // Brueche wirklich rechnet. Gilt fuer „1/2 kg" genauso: dort stand derselbe
  // Fehler schon vorher, nur unbemerkt.
  if (match[2].startsWith('/')) return null;

  // In CODEPOINTS geschnitten, nicht in UTF-16-Einheiten: die Ziffern von 40 der
  // 77 Systeme liegen ausserhalb der BMP und belegen zwei Einheiten, ihr
  // ASCII-Ergebnis nur eine. Ein `.length`-Offset verruetschte damit genau bei
  // den Schreibweisen, fuer die diese Umschrift ueberhaupt da ist.
  const zeichen = [...raw];
  const rest = [...match[2]].length;
  const unit = zeichen.slice(zeichen.length - rest).join('').trim().replace(/\s+/g, ' ').toLowerCase();

  // U+066C ist per Unicode EINDEUTIG ein Tausenderzeichen - anders als das
  // ASCII-Komma, das je nach Region gruppiert oder trennt. „١٬٠٠٠ g" heisst
  // tausend Gramm, Punkt. Wer das auf ein Komma abbildet und dem bestehenden
  // Pfad ueberlaesst, uebersetzt eine eindeutige Angabe in eine mehrdeutige und
  // liest sie danach als 1 - der Faktor tausend daneben, mit Information, die man
  // selbst weggeworfen hat. Aufgeloest wird deshalb genau hier und NUR hier: das
  // ASCII-Komma bleibt unangetastet, weil ihm der Server dieselbe Eindeutigkeit
  // nicht ansieht.
  const zahl = zeichen.slice(0, [...match[1]].length).join('');
  const amount = zahl.includes(ARABIC_THOUSANDS)
    ? Number(toAsciiDigits(zahl).replaceAll(',', ''))
    : Number(match[1].replace(',', '.'));
  if (!Number.isFinite(amount)) return null;

  return { amount, unit };
}

function formatQuantity(amount, unit) {
  const rounded = Math.round(amount * 100) / 100;
  const number = Number.isInteger(rounded) ? String(rounded) : String(rounded).replace(/\.0+$/, '').replace(/(\.\d*?)0+$/, '$1');
  return unit ? `${number} ${unit}` : number;
}

function aggregateMealIngredients(ingredients = []) {
  const groups = new Map();

  for (const ingredient of ingredients) {
    const name = String(ingredient?.name || '').trim();
    if (!name) continue;
    const category = String(ingredient?.category || 'Sonstiges').trim() || 'Sonstiges';
    const parsed = parseQuantity(ingredient?.quantity);
    const quantity = String(ingredient?.quantity || '').trim();
    // Der Schluessel nutzt die UMGESCHRIEBENE Einheit, die Anzeige weiter die
    // originale: „۲ x ۵۰۰ g" und „2 x 500 g" sind dieselbe Menge und gehoeren in
    // eine Zeile, aber die Zeile soll so dastehen, wie jemand sie geschrieben hat.
    const key = parsed
      ? `${name.toLowerCase()}\u0000${category}\u0000parsed\u0000${toAsciiDigits(parsed.unit)}`
      : `${name.toLowerCase()}\u0000${category}\u0000raw\u0000${quantity.toLowerCase()}`;

    if (!groups.has(key)) {
      groups.set(key, {
        name,
        category,
        quantity: quantity || null,
        amount: 0,
        unit: parsed?.unit ?? '',
        mealIds: new Set(),
        ingredientIds: [],
        count: 0,
      });
    }

    const group = groups.get(key);
    group.count += 1;
    if (parsed) {
      group.amount = (group.amount ?? 0) + parsed.amount;
      group.quantity = formatQuantity(group.amount, group.unit);
    } else if (!quantity) {
      group.quantity = null;
    } else if (group.count > 1) {
      group.quantity = `${group.count} x ${quantity}`;
    }

    if (ingredient.meal_id != null) group.mealIds.add(ingredient.meal_id);
    if (ingredient.id != null) group.ingredientIds.push(ingredient.id);
  }

  return [...groups.values()].map((group) => ({
    name: group.name,
    category: group.category,
    quantity: group.quantity,
    added_from_meal: group.mealIds.size === 1 ? [...group.mealIds][0] : null,
    ingredientIds: group.ingredientIds,
  }));
}

export { aggregateMealIngredients, parseQuantity };
