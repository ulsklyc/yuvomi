/**
 * Modul: Inventar-Garantiestatus (Inventory warranty status)
 * Zweck: warranty_end (Kaufdatum + Garantiemonate) rein clientseitig ableiten -
 *        analog public/utils/pantry-status.js. Kein Server-Roundtrip, keine
 *        neuen API-Felder.
 * Abhängigkeiten: public/utils/date.js
 */

// `todayKey` heisst hier schon ein Parameter (bzw. eine lokale Bindung), der den
// Bezugstag traegt - der Import kommt deshalb unter eigenem Namen herein.
import { parseLocalDateKey, todayKey as householdToday } from '/utils/date.js';
// dateStatus() und ihr Schwellenwert leben jetzt in einer neutralen Datei, weil
// Dokumente (und spaeter Health) denselben Chip brauchen. Re-exportiert, damit
// jeder bestehende Inventar-Import unveraendert bleibt - der alte Name
// WARRANTY_ALERT_DAYS bleibt hier als Alias, "Garantie" waere unter dem neuen,
// neutralen Namen in date-status.js selbst irrefuehrend.
import { DATE_STATUS_ALERT_DAYS, dateStatus } from './date-status.js';

const WARRANTY_ALERT_DAYS = DATE_STATUS_ALERT_DAYS;
export { WARRANTY_ALERT_DAYS, dateStatus };

function pad(n) { return String(n).padStart(2, '0'); }

/**
 * @param {object} item - Inventar-Gegenstand aus der API
 * @returns {string|null} YYYY-MM-DD, oder null wenn Kaufdatum/Garantiemonate fehlen
 */
export function warrantyEndDateKey(item) {
  const purchaseDate = item?.purchase_date;
  const months = item?.warranty_months;
  if (!purchaseDate || months == null) return null;
  const match = /^(\d{4})-(\d{2})-(\d{2})/.exec(purchaseDate);
  if (!match) return null;
  const day = Number(match[3]);
  const date = new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, 1));
  date.setUTCMonth(date.getUTCMonth() + Number(months));
  const lastDay = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 0)).getUTCDate();
  date.setUTCDate(Math.min(day, lastDay));
  return `${date.getUTCFullYear()}-${pad(date.getUTCMonth() + 1)}-${pad(date.getUTCDate())}`;
}

/**
 * @param {object} item
 * @param {string} [todayKey] - lokaler Tagesschlüssel (YYYY-MM-DD)
 * @returns {{ state: 'valid'|'expiring'|'expired', endDateKey: string, days: number } | null}
 */
export function warrantyStatus(item, todayKey = householdToday()) {
  const endDateKey = warrantyEndDateKey(item);
  if (!endDateKey) return null;
  const days = Math.round((parseLocalDateKey(endDateKey) - parseLocalDateKey(todayKey)) / 86_400_000);
  const state = days < 0 ? 'expired' : days <= DATE_STATUS_ALERT_DAYS ? 'expiring' : 'valid';
  return { state, endDateKey, days };
}

/** Trifft der Listen-Hinweis zu (läuft bald ab ODER bereits abgelaufen)? */
export function hasWarrantyAlert(item, todayKey = householdToday()) {
  const status = warrantyStatus(item, todayKey);
  return !!status && status.state !== 'valid';
}

/**
 * Wie lange eine ABGELAUFENE Garantie noch Aufmerksamkeit verlangt, in Tagen
 * nach ihrem Ende (Critique 2026-09-26). Gegen eine abgelaufene Garantie ist
 * nichts mehr zu tun - sie hielt "Braucht Aufmerksamkeit" und das Nav-Badge
 * trotzdem dauerhaft an ("Familienauto", 17 Monate nach Ablauf), und ein
 * Alarm, der nie ausgeht, wird ueberlesen. Der Nachlauf laesst den Hinweis
 * lange genug stehen, um einen gerade verpassten Ablauf noch zu bemerken.
 * Getrackte Fristen (TUeV, Service) haben KEINEN Nachlauf: sie sind handelbar
 * und bleiben faellig, bis sie als erledigt vermerkt sind.
 */
export const WARRANTY_EXPIRED_ATTENTION_DAYS = 30;

// Rangfolge, wenn ein Gegenstand mehrere faellige Fristen hat: was man tun
// kann und schon versaeumt hat, vor dem, was bald ansteht, vor der Garantie,
// die nur noch nachklingt.
const RANK_OVERDUE = 0;
const RANK_EXPIRING = 1;
const RANK_WARRANTY_ENDED = 2;

/**
 * Die EINE faellige Frist, die die Listenzeile als Chip zeigt - oder null.
 * Aus derselben Regel liest hasUpcomingDeadline() (Filter, Kennzahl,
 * Nav-Badge), damit Chip und Zaehler nie auseinanderlaufen.
 *
 * @param {object} item
 * @param {string} [todayKey]
 * @returns {{ kind: 'warranty'|'tracked', label: string|null, state: 'expiring'|'expired',
 *            endDateKey: string, days: number, tone: 'expiring'|'unavailable' } | null}
 */
export function deadlineChipSpec(item, todayKey = householdToday()) {
  const candidates = [];
  const warranty = warrantyStatus(item, todayKey);
  if (warranty && (warranty.state === 'expiring'
    || (warranty.state === 'expired' && -warranty.days <= WARRANTY_EXPIRED_ATTENTION_DAYS))) {
    candidates.push({ rank: warranty.state === 'expired' ? RANK_WARRANTY_ENDED : RANK_EXPIRING, kind: 'warranty', label: null, ...warranty });
  }
  for (const tracked of item?.tracked_dates || []) {
    const status = dateStatus(tracked.date, todayKey);
    if (!status || status.state === 'valid') continue;
    candidates.push({ rank: status.state === 'expired' ? RANK_OVERDUE : RANK_EXPIRING, kind: 'tracked', label: tracked.label ?? null, ...status });
  }
  if (!candidates.length) return null;
  candidates.sort((a, b) => a.rank - b.rank || a.days - b.days);
  const { kind, label, state, endDateKey, days } = candidates[0];
  return { kind, label, state, endDateKey, days, tone: state === 'expired' ? 'unavailable' : 'expiring' };
}

/** Trifft der Listen-Hinweis zu - eine Garantie oder getrackte Frist ist bald
 *  faellig, ueberfaellig oder (Garantie) gerade erst abgelaufen? */
export function hasUpcomingDeadline(item, todayKey = householdToday()) {
  return deadlineChipSpec(item, todayKey) !== null;
}

/** Wie viele Items haben eine bald ablaufende/abgelaufene Garantie oder
 *  getrackte Frist? Fuer die Kennzahl-Karte und das Nav-Badge (Design-Doc §4). */
export function countUpcomingDeadlines(items, todayKey = householdToday()) {
  return items.filter((item) => hasUpcomingDeadline(item, todayKey)).length;
}
