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
const ARABIC_THOUSANDS = '\u066C'; // eindeutig Gruppierung
const ARABIC_DECIMAL = '\u066B';   // eindeutig Dezimaltrenner

/**
 * Der Betrag einer Zahl, die FREMDE Zeichen enthaelt - fremde Ziffern, einen
 * fremden Trenner oder beides. Liefert null, wenn die Schreibweise nicht
 * eindeutig ist.
 *
 * Getrennt vom ASCII-Pfad, und das ist der Kern. Eine reine ASCII-Zahl deutet
 * dieser Server seit jeher naiv („1,000 g" ist ein Gramm); das zu aendern waere
 * eine eigene Entscheidung mit eigenen Folgen fuer bestehende Daten. Eine Zahl
 * mit fremden Zeichen hatte dagegen bisher GAR KEIN Verhalten - die ASCII-Regex
 * traf sie nicht. Fuer sie gilt deshalb von Anfang an die strengere Regel, statt
 * sie nachtraeglich einer Deutung zu unterwerfen, die fuer sie nie gedacht war.
 *
 * Was eindeutig ist, wird gelesen; was mehrdeutig ist, wird abgelehnt:
 *  - U+066C ist per Unicode ein Tausenderzeichen, U+066B ein Dezimaltrenner.
 *    Beide sagen, was sie sind.
 *  - Ein ASCII-Komma in einer Zahl aus bengalischen oder Devanagari-Ziffern
 *    („১,০০০ g") gruppiert dort zwar, aber das weiss der Server nicht sicher -
 *    und die naive Deutung machte daraus ein Gramm statt tausend. Abgelehnt.
 *  - Eine Gruppierung muss aussehen wie eine: „٢٬٥٠" hat zwei Stellen hinter dem
 *    Zeichen und ist keine, „٢٬٠٠٠٠" hat vier. Beide ergaben vorher wortlos 250
 *    und 20000.
 */
function foreignAmount(zahlOriginal) {
  const zahl = toAsciiDigits(zahlOriginal);
  const vorzeichen = /^[+-]/.test(zahl) ? zahl[0] : '';
  const rumpf = vorzeichen ? zahl.slice(1) : zahl;

  if (/^\d+$/.test(rumpf)) return Number(zahl);

  const hatGruppe = zahlOriginal.includes(ARABIC_THOUSANDS);
  const hatDezimal = zahlOriginal.includes(ARABIC_DECIMAL);
  // Ein Trenner, den nur die Region deuten koennte - der Server kann es nicht.
  const unklar = /[.,]/.test(zahlOriginal);

  if (hatGruppe) {
    // Gruppierung mit optionalem Dezimalteil, in voller Laenge geprueft: eine
    // Zahl, die nur zur HAELFTE einem Muster folgt, ist keine Zahl.
    const muster = hatDezimal ? /^\d{1,3}(?:,\d{3})+\.\d+$/ : /^\d{1,3}(?:,\d{3})+$/;
    if (unklar || !muster.test(rumpf)) return null;
    return Number(vorzeichen + rumpf.replaceAll(',', ''));
  }

  if (hatDezimal && !unklar) {
    return /^\d+\.\d+$/.test(rumpf) ? Number(zahl) : null;
  }

  // Bleibt: fremde Ziffern mit einem ASCII-Trenner. Sieht er aus wie eine
  // Gruppierung, ist die naive Deutung nachweislich falsch (Faktor 1000) und die
  // richtige nicht sicher - also gar nicht. Sonst gilt er als Dezimaltrenner,
  // was fuer bn, hi und th auch stimmt.
  if (/[.,]\d{3}(?!\d)/.test(rumpf)) return null;
  return /^\d+(?:[.,]\d+)?$/.test(rumpf) ? Number(vorzeichen + rumpf.replace(',', '.')) : null;
}

function parseQuantity(value) {
  const raw = String(value || '').trim();
  if (!raw) return null;
  const zeichen = [...raw];
  const norm = toAsciiDigits(raw);

  // Der fuehrende Zahlbereich in voller Laenge - Ziffern und Trenner, so weit sie
  // reichen. Er entscheidet nur, WELCHER Pfad zustaendig ist; wie weit die Zahl
  // wirklich geht, sagt dann der Pfad selbst.
  const bereich = norm.match(/^[+-]?[\d.,]*\d/)?.[0] ?? '';
  const bereichOriginal = zeichen.slice(0, [...bereich].length).join('');
  const fremd = bereich !== bereichOriginal;

  const match = fremd
    ? [null, bereich, norm.slice(bereich.length).replace(/^\s+/, '')]
    : norm.match(/^([+-]?\d+(?:[.,]\d+)?)\s*(.*)$/);
  if (!match) return null;

  // Ein Bruch ist keine Zahl mit Rest. „١/٢ kg" ergaebe sonst den Betrag 1 und
  // die Einheit „/٢ kg", und zwei halbe Kilo stuenden als „2 /٢ kg" auf der
  // Liste. Ohne die Umschrift traf die Regex solche Mengen gar nicht und sie
  // blieben auf dem Rohtext-Pfad - dorthin gehoeren sie weiter, bis jemand
  // Brueche wirklich rechnet. Gilt fuer „1/2 kg" genauso: dort stand derselbe
  // Fehler schon vorher, nur unbemerkt.
  if (match[2].startsWith('/')) return null;

  const amount = fremd
    ? foreignAmount(bereichOriginal)
    : Number(match[1].replace(',', '.'));
  if (amount === null || !Number.isFinite(amount)) return null;

  // In CODEPOINTS geschnitten, nicht in UTF-16-Einheiten: die Ziffern von 40 der
  // 77 Systeme liegen ausserhalb der BMP und belegen zwei Einheiten, ihr
  // ASCII-Ergebnis nur eine. Ein `.length`-Offset verruetschte damit genau bei
  // den Schreibweisen, fuer die diese Umschrift ueberhaupt da ist.
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
