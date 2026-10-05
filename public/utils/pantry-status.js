/**
 * Modul: Vorrats-Status (Pantry status)
 * Zweck: Ablauf- und Bestandsstatus eines Vorratsartikels ableiten und filtern.
 * Abhängigkeiten: public/utils/date.js
 *
 * Bewusst im Client statt im Router: "abgelaufen" hängt am lokalen Kalendertag
 * des Nutzers. Der Server rechnet in UTC und läge westlich von UTC bis zu einen
 * Tag daneben - genau die Klasse Fehler, gegen die toLocalDateKey() existiert.
 */

// `todayKey` heisst hier schon ein Parameter (bzw. eine lokale Bindung), der den
// Bezugstag traegt - der Import kommt deshalb unter eigenem Namen herein.
import { addLocalDays, parseLocalDateKey, todayKey as householdToday } from '/utils/date.js';

/** Vorlauf in Tagen, ab dem ein Artikel als "läuft bald ab" gilt. */
export const EXPIRY_SOON_DAYS = 7;

/** Die drei Zustände, die eine eigene Filter-Chip bekommen. */
export const PANTRY_FILTERS = Object.freeze(['expired', 'soon', 'low']);

/**
 * @param {object} item - Vorratsartikel aus der API
 * @param {string} [todayKey] - lokaler Tagesschlüssel (YYYY-MM-DD)
 * @returns {{ out: boolean, low: boolean, expiry: 'expired'|'soon'|null }}
 */
export function pantryItemStatus(item, todayKey = householdToday()) {
  const quantity = Number(item?.quantity ?? 0);
  const min = item?.min_quantity == null ? null : Number(item.min_quantity);

  const out = quantity <= 0;
  // "Fast leer" schließt "leer" aus: ein leerer Artikel ist kein Grenzfall mehr,
  // er hat eine eigene, deutlichere Darstellung.
  const low = !out && min !== null && Number.isFinite(min) && quantity <= min;

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
 */
export function matchesPantryFilter(item, filter, todayKey = householdToday()) {
  if (!filter || filter === 'all') return true;
  const status = pantryItemStatus(item, todayKey);
  if (filter === 'expired') return status.expiry === 'expired';
  if (filter === 'soon') return status.expiry === 'soon';
  if (filter === 'low') return status.low || status.out;
  return true;
}

/** Zählt je Filter, wie viele Artikel ihn treffen. */
export function pantryFilterCounts(items, todayKey = householdToday()) {
  const counts = { expired: 0, soon: 0, low: 0 };
  for (const item of items) {
    const status = pantryItemStatus(item, todayKey);
    if (status.expiry === 'expired') counts.expired += 1;
    if (status.expiry === 'soon') counts.soon += 1;
    if (status.low || status.out) counts.low += 1;
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
