/**
 * Modul: Ablauf-Anzeige eines Dokuments (Document expiry display)
 * Zweck: WAS Zeile/Karte und Viewer zu einem Ablaufdatum sagen, als reine
 *        Funktion ueber dem Ergebnis von dateStatus() - ohne Importe, damit
 *        test:documents-ux sie als Programm prueft. Die Seite setzt Text,
 *        Datum und Escaping ein (documents.js, expiryChipHtml/expiryViewerHtml).
 * Abhängigkeiten: keine (der Status kommt aus public/utils/date-status.js)
 *
 * EIN TAG FUER ALLE DREI (#1036, #1705). Ab wann eine Frist "bald" ist, stand an
 * zwei Stellen: die Erinnerung folgte dem Vorlauf am Dokument, Chip und Filter
 * "Fristen" festen 30 Tagen. Mit 90 Tagen Vorlauf kam die Meldung zwei Monate,
 * bevor irgendetwas sichtbar markiert war, und keiner der beiden Tage erklaerte
 * den anderen. Jetzt folgen Erinnerung, Chip, Filter und die Kachel "Stichtage"
 * demselben Tag. Importfrei, damit auch der Server (services/countdowns.js)
 * diese Datei liest statt die Regel nachzubauen.
 */

/**
 * Ohne eigenen Vorlauf gilt die Schwelle aus date-status.js
 * (`DATE_STATUS_ALERT_DAYS`). Dort nicht importierbar, weil sie ueber den
 * Browser-Pfad /utils/date.js laedt; test:document-person haelt beide gleich.
 */
export const DEFAULT_EXPIRY_LEAD_DAYS = 30;

/**
 * Der Vorlauf eines Dokuments in Tagen. Ein explizites `0` bleibt `0`: "am Tag
 * selbst" ist eine Wahl, keine Luecke.
 * @param {{ expiry_reminder_days?: number|null }} doc
 * @returns {number}
 */
export function expiryLeadDays(doc) {
  return Number.isInteger(doc?.expiry_reminder_days) ? doc.expiry_reminder_days : DEFAULT_EXPIRY_LEAD_DAYS;
}

/**
 * Ist diese Frist "bald"? Auch vergangene Tage zaehlen: die Nachfrist und die
 * Anzeige "abgelaufen" entscheiden die Aufrufer.
 * @param {number} daysUntil
 * @param {{ expiry_reminder_days?: number|null }} doc
 * @returns {boolean}
 */
export function expiryDueSoon(daysUntil, doc) {
  return daysUntil <= expiryLeadDays(doc);
}

/**
 * dateStatus() mit dem Vorlauf dieses Dokuments statt der festen Schwelle.
 * @param {{ state: 'valid'|'expiring'|'expired', endDateKey: string, days: number } | null} status
 * @param {{ expiry_reminder_days?: number|null }} doc
 */
export function documentExpiryStatus(status, doc) {
  if (!status || status.state === 'expired') return status;
  return { ...status, state: expiryDueSoon(status.days, doc) ? 'expiring' : 'valid' };
}

/**
 * Chip auf Zeile und Karte: bewusst nur bei "bald ab" oder "abgelaufen" - ein
 * Chip auf jeder Zeile mit Ablaufdatum waere Ornament und entwertete genau die
 * Zeilen, die Aufmerksamkeit brauchen. "expired" teilt sich die Gefahr-Farbe
 * mit .doc-badge--unavailable (DESIGN.md, Colors: die Skalen-Regel).
 *
 * `shortKey` ist die Kurzform fuer schmale Zeilen und Karten ("Abgelaufen",
 * "Noch 5 Tage") - mit denselben Parametern, damit beide Fassungen dieselbe
 * Zahl nennen.
 *
 * @param {{ state: 'valid'|'expiring'|'expired', days: number } | null} status
 * @returns {{ tone: string, key: string, params: { count: number }, shortKey: string } | null}
 */
export function expiryChipSpec(status) {
  if (!status || status.state === 'valid') return null;
  return status.state === 'expired'
    ? { tone: 'unavailable', key: 'documents.expiredDays', params: { count: Math.abs(status.days) }, shortKey: 'documents.expiredShort' }
    : { tone: 'expiring', key: 'documents.expiringInDays', params: { count: status.days }, shortKey: 'documents.expiringShort' };
}

/**
 * Viewer-Meta: IMMER, sobald ein Datum gesetzt ist. Die Zeile schweigt bei
 * "gueltig", also ist der Viewer der Ort, an dem man nachsieht, bis wann ein
 * Ausweis gilt. Er nennt das Datum selbst; die relative Angabe ("in 5 Tagen")
 * traegt schon der Chip der Zeile.
 *
 * @param {{ state: 'valid'|'expiring'|'expired', endDateKey: string } | null} status
 * @returns {{ tone: string|null, key: string, dateKey: string } | null}
 */
export function expiryViewerSpec(status) {
  if (!status) return null;
  const dateKey = status.endDateKey;
  if (status.state === 'expired') return { tone: 'unavailable', key: 'documents.expiryEndedOn', dateKey };
  if (status.state === 'expiring') return { tone: 'expiring', key: 'documents.expiryEndsOn', dateKey };
  return { tone: null, key: 'documents.expiryValidUntil', dateKey };
}
