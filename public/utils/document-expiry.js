/**
 * Modul: Ablauf-Anzeige eines Dokuments (Document expiry display)
 * Zweck: WAS Zeile/Karte und Viewer zu einem Ablaufdatum sagen, als reine
 *        Funktion ueber dem Ergebnis von dateStatus() - ohne Importe, damit
 *        test:documents-ux sie als Programm prueft. Die Seite setzt Text,
 *        Datum und Escaping ein (documents.js, expiryChipHtml/expiryViewerHtml).
 * Abhängigkeiten: keine (der Status kommt aus public/utils/date-status.js)
 */

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
