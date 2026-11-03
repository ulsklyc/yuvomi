/**
 * Modul: Vorrats-Status (Pantry status)
 * Zweck: Ablauf- und Bestandsstatus eines Vorratsartikels ableiten und filtern.
 * Abhängigkeiten: public/utils/date.js
 *
 * Bewusst im Client statt im Router: "abgelaufen" hängt am lokalen Kalendertag
 * des Nutzers. Der Server rechnet in UTC und läge westlich von UTC bis zu einen
 * Tag daneben - genau die Klasse Fehler, gegen die toLocalDateKey() existiert.
 *
 * EXPIRY BELONGS TO A BATCH, LOW AND OUT TO A PRODUCT (#1448, step 3). A
 * product is out when the sum of its batches is 0 and running low when that
 * sum is at or below the product's minimum (pantryStockStatus,
 * pantryProductStock). A product without batches is out only when it has a
 * minimum (hasPantryMinimum): without one it tells nobody that something is
 * missing (#2118). The kitchen count in server/routes/kitchen.js reads the
 * same rule in SQL.
 */

// `todayKey` heisst hier schon ein Parameter (bzw. eine lokale Bindung), der den
// Bezugstag traegt - der Import kommt deshalb unter eigenem Namen herein.
import { addLocalDays, parseLocalDateKey, todayKey as householdToday } from '/utils/date.js';
import { normalizePantryQuantity } from '/utils/pantry-units.js';

/** Vorlauf in Tagen, ab dem ein Artikel als "läuft bald ab" gilt. */
export const EXPIRY_SOON_DAYS = 7;

/** Die drei Zustände, die eine eigene Filter-Chip bekommen. */
export const PANTRY_FILTERS = Object.freeze(['expired', 'soon', 'low']);

/**
 * Out and low for a stock quantity against a minimum: a product's total
 * against the product's minimum (#1448, step 3).
 * @param {number|string|null} total
 * @param {number|string|null} minQuantity - null: no minimum, never low
 * @returns {{ out: boolean, low: boolean }}
 */
export function pantryStockStatus(total, minQuantity) {
  const quantity = Number(total ?? 0);
  const min = minQuantity == null ? null : Number(minQuantity);

  const out = quantity <= 0;
  // "Fast leer" schließt "leer" aus: ein leerer Artikel ist kein Grenzfall mehr,
  // er hat eine eigene, deutlichere Darstellung.
  const low = !out && min !== null && Number.isFinite(min) && quantity <= min;
  return { out, low };
}

/**
 * Does a product have a minimum, as far as a product without batches is
 * concerned? Not null and above 0. A minimum of 0 never makes a product with
 * batches low or out (out at 0 does not need a minimum), so it says "no
 * warning" and counts as none here too.
 * @param {number|string|null} minQuantity
 */
export function hasPantryMinimum(minQuantity) {
  if (minQuantity == null || minQuantity === '') return false;
  const min = Number(minQuantity);
  return Number.isFinite(min) && min > 0;
}

/** The key of a batch's product in pantryProductStock(): `p<id>`, or `b<batch id>` without one. */
export function pantryStockKey(item) {
  return item?.product_id != null ? `p${item.product_id}` : `b${item?.id}`;
}

/**
 * The stock of every product, from the batches and the product list of
 * `GET /pantry` (#1448, step 3): key -> { key, id, product, batches, total,
 * min, out, low }. A batch without a product stands for itself, with its own
 * minimum. A product without batches is in it with total 0; it is out only
 * when it has a minimum (hasPantryMinimum), and never low. The total is
 * rounded like a quantity (two decimals), as the kitchen count rounds its sum.
 *
 * @param {object[]} items - batches (as the rows show them)
 * @param {object[]} [products] - `products` of GET /pantry
 * @returns {Map<string, object>}
 */
export function pantryProductStock(items, products = []) {
  const stock = new Map();
  for (const product of products) {
    const key = `p${product.id}`;
    stock.set(key, { key, id: product.id, product, batches: [], min: product.min_quantity ?? null });
  }
  for (const item of items) {
    const key = pantryStockKey(item);
    if (!stock.has(key)) {
      stock.set(key, { key, id: item.product_id ?? null, product: null, batches: [], min: item.min_quantity ?? null });
    }
    stock.get(key).batches.push(item);
  }
  for (const entry of stock.values()) {
    const sum = entry.batches.reduce((acc, b) => acc + Number(b.quantity || 0), 0);
    entry.total = normalizePantryQuantity(sum, { fallback: 0 });
    Object.assign(entry, entry.batches.length
      ? pantryStockStatus(entry.total, entry.min)
      : { out: hasPantryMinimum(entry.min), low: false });
  }
  return stock;
}

/**
 * @param {object} item - Vorratsartikel aus der API
 * @param {string} [todayKey] - lokaler Tagesschlüssel (YYYY-MM-DD)
 * @returns {{ out: boolean, low: boolean, expiry: 'expired'|'soon'|null }}
 *
 * `out` and `low` read the batch alone, against the minimum the API returns
 * on it (its product's). That is the product's state only when the batch is
 * its product's only one; the stock list reads pantryProductStock().
 */
export function pantryItemStatus(item, todayKey = householdToday()) {
  const { out, low } = pantryStockStatus(item?.quantity ?? 0, item?.min_quantity);

  let expiry = null;
  const expiresOn = item?.expires_on || null;
  if (expiresOn) {
    // Reiner Stringvergleich: YYYY-MM-DD ist lexikografisch = chronologisch.
    if (expiresOn < todayKey) expiry = 'expired';
    else if (expiresOn <= addLocalDays(todayKey, EXPIRY_SOON_DAYS)) expiry = 'soon';
  }

  return { out, low, expiry };
}

/** Ganze Kalendertage von todayKey bis dateKey (negativ = liegt zurück). */
export function daysUntil(dateKey, todayKey = householdToday()) {
  const from = parseLocalDateKey(todayKey);
  const to = parseLocalDateKey(dateKey);
  // Über Zeitumstellungen hinweg ist ein Tag nicht exakt 86400s lang; das Runden
  // fängt die ±1h ab, statt einen Tag zu verschlucken.
  return Math.round((to - from) / 86_400_000);
}

/**
 * Trifft der Artikel den aktiven Filter? `null`/'all' lässt alles durch.
 * "Fast leer" umfasst bewusst auch leere Artikel: wer die Liste nach Nachschub
 * durchsieht, will beides sehen.
 *
 * "Fast leer" is a product's state (#1448, step 3): with `stock` (from
 * pantryProductStock) a batch matches when its product is low or out. Without
 * it the batch is read alone.
 */
export function matchesPantryFilter(item, filter, todayKey = householdToday(), stock = null) {
  if (!filter || filter === 'all') return true;
  const status = pantryItemStatus(item, todayKey);
  if (filter === 'expired') return status.expiry === 'expired';
  if (filter === 'soon') return status.expiry === 'soon';
  if (filter === 'low') {
    const product = stock?.get(pantryStockKey(item)) ?? status;
    return product.low || product.out;
  }
  return true;
}

/**
 * Zählt je Filter, wie viele Einträge ihn treffen. Expired and soon count
 * BATCHES (expiry is a batch's); low counts PRODUCTS that are low or out over
 * their total, a product without batches with a minimum included (#1448,
 * step 3): the
 * "Running low" chip answers "what do I need to buy", and that is a product.
 */
export function pantryFilterCounts(items, todayKey = householdToday(), products = []) {
  const counts = { expired: 0, soon: 0, low: 0 };
  for (const item of items) {
    const status = pantryItemStatus(item, todayKey);
    if (status.expiry === 'expired') counts.expired += 1;
    if (status.expiry === 'soon') counts.soon += 1;
  }
  for (const entry of pantryProductStock(items, products).values()) {
    if (entry.low || entry.out) counts.low += 1;
  }
  return counts;
}

/**
 * Wie spricht ein Ablauf? `{ key, count? }` für `t()`, aus den Resttagen.
 *
 * EINE FORMULIERUNG FÜR ZWEI ORTE: die Vorratsseite (`expiryBadge`) und die
 * Dashboard-Kachel „Läuft bald ab" sagen dieselbe Sache über dieselbe Charge.
 * Stünde der Satz zweimal da, hiesse dieselbe Milch auf der Übersicht „in 1
 * Tag" und eine Seite weiter „Läuft morgen ab". Rein und ohne i18n-Import,
 * dasselbe Muster wie `countdownPhrase()` in utils/countdown.js.
 *
 * @param {number} days - Resttage (negativ = abgelaufen)
 * @returns {{ key: string, count?: number }}
 */
export function pantryExpiryPhrase(days) {
  const d = Math.trunc(Number(days) || 0);
  if (d === -1) return { key: 'pantry.badgeExpiredYesterday' };
  if (d < 0) return { key: 'pantry.badgeExpiredDays', count: -d };
  if (d === 0) return { key: 'pantry.badgeExpiresToday' };
  if (d === 1) return { key: 'pantry.badgeExpiresTomorrow' };
  return { key: 'pantry.badgeExpiresDays', count: d };
}

/**
 * Dringlichkeit einer Charge für den TON ihrer Anzeige - drei Stufen, nicht
 * die zwei des Filters: „heute/morgen" ist der Tag, an dem man noch handeln
 * kann, und liest sich deshalb anders als „in fünf Tagen".
 *
 * @param {number} days - Resttage (negativ = abgelaufen)
 * @returns {'expired'|'now'|'soon'}
 */
export function pantryExpiryTone(days) {
  const d = Math.trunc(Number(days) || 0);
  if (d < 0) return 'expired';
  if (d <= 1) return 'now';
  return 'soon';
}

/**
 * Der Filter aus einem Deep-Link (`/pantry?filter=soon`), oder `null`.
 *
 * Nur die drei Chips aus PANTRY_FILTERS - eine Allowlist, weil der Wert aus der
 * Adresszeile kommt und in `state.filter` landet. Die Zeilen der
 * Dashboard-Kachel führen hierher: eine abgelaufene Charge öffnet
 * „Abgelaufen", eine bald ablaufende „Läuft bald ab".
 *
 * @param {string} search - `location.search`
 * @returns {'expired'|'soon'|'low'|null}
 */
export function pantryFilterFromSearch(search) {
  const value = new URLSearchParams(String(search ?? '')).get('filter');
  return PANTRY_FILTERS.includes(value) ? value : null;
}
