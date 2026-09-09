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
function parseQuantity(value) {
  const raw = String(value || '').trim();
  if (!raw) return null;
  const match = toAsciiDigits(raw).match(/^([+-]?\d+(?:[.,]\d+)?)\s*(.*)$/);
  if (!match) return null;
  const amount = Number(match[1].replace(',', '.'));
  if (!Number.isFinite(amount)) return null;
  // In CODEPOINTS geschnitten, nicht in UTF-16-Einheiten: die Ziffern von 40 der
  // 77 Systeme liegen ausserhalb der BMP und belegen zwei Einheiten, ihr
  // ASCII-Ergebnis nur eine. Ein `.length`-Offset verruetschte damit genau bei
  // den Schreibweisen, fuer die diese Umschrift ueberhaupt da ist.
  const zeichen = [...raw];
  const rest = [...match[2]].length;
  const unit = zeichen.slice(zeichen.length - rest).join('').trim().replace(/\s+/g, ' ').toLowerCase();
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
    const key = parsed
      ? `${name.toLowerCase()}\u0000${category}\u0000parsed\u0000${parsed.unit}`
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
