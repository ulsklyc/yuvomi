/**
 * Modul: Vorrat - was bald abläuft (Dashboard-Ausschnitt)
 * Zweck: Der schlanke Ausschnitt `pantryExpiring` für GET /dashboard: die
 *        Chargen, deren Mindesthaltbarkeit abgelaufen ist oder im Horizont
 *        liegt, dazu die Zahlen, die Kachel und Heute-Blatt brauchen.
 * Abhängigkeiten: server/services/pantry-reminders.js (Horizont),
 *                 server/utils/timezone.js (Tagesrechnung)
 *
 * EINE ZEILE IST EINE CHARGE. Das Haushalts-Produkt über der Charge (#1448)
 * steht noch aus; bis dahin gruppiert hier nichts nach Namen. Zwei Packungen
 * Milch mit verschiedenem MHD sind zwei Zeilen, wie auf der Vorratsseite.
 *
 * „HEUTE" KOMMT VOM AUFRUFER, und zwar als Tag der Haushaltszone
 * (`todayKey()` bzw. `todayLocalKey` der Dashboard-Route). Diese Datei liest
 * keine Uhr: sonst hätte die Route zwei Ablesungen, die an einer Tagesgrenze
 * auseinanderlaufen können.
 */

import { EXPIRY_REMINDER_OFFSET_DAYS } from './pantry-reminders.js';
import { daysBetweenDateKeys, shiftDateKey } from '../utils/timezone.js';

/**
 * Wie weit die Kachel schaut. DIESELBE ZAHL wie `EXPIRY_SOON_DAYS` der
 * Vorratsseite (public/utils/pantry-status.js), über die Erinnerung, die genau
 * diesen Zustandswechsel ankündigt - ein Guard in test/test-frontend-audit.js
 * hält beide zusammen. Die Kachel zeigt damit genau das, was die Vorratsseite
 * „läuft bald ab" nennt, und nicht eine dritte Vorstellung von „bald".
 */
export const PANTRY_EXPIRING_HORIZON_DAYS = EXPIRY_REMINDER_OFFSET_DAYS;

/**
 * Die größte Fassung der Kachel (`listRowCap('1x2')` bzw. 2x2 = 5 Zeilen). Der
 * Server liefert nicht mehr, als je sichtbar wird; was darüber hinausgeht,
 * steht in `total` und wird als „+N weitere" genannt.
 */
export const PANTRY_EXPIRING_ROW_CAP = 5;

/** Die leere Form - Sperre (Modulrecht, Token-Scope) und leerer Vorrat. */
export function emptyPantryExpiring() {
  return { items: [], todayItems: [], total: 0, expiredCount: 0, todayCount: 0 };
}

/**
 * @param {import('better-sqlite3').Database} database
 * @param {string} today - YYYY-MM-DD, Tag der Haushaltszone
 * @returns {{
 *   items: Array<{ id, name, quantity, unit, expires_on, days_left, location_name, location_icon }>,
 *   todayItems: Array<{ id, name, quantity, unit }>,
 *   total: number, expiredCount: number, todayCount: number,
 * }}
 *
 * - `items`: abgelaufen zuerst, dann nach Resttagen; gedeckelt bei
 *   PANTRY_EXPIRING_ROW_CAP. `days_left` ist negativ für Abgelaufenes.
 * - `todayItems`: alle heute ablaufenden (ebenfalls gedeckelt), EIGENS, weil sie
 *   in `items` hinter beliebig vielen abgelaufenen stehen und dort aus dem
 *   Deckel fallen können. Das ist die Zeile, die das Heute-Blatt andockt.
 * - Zahlen ungedeckelt über alles im Horizont.
 *
 * Leere Chargen (`quantity <= 0`) zählen nicht: was aufgebraucht ist, kann
 * nicht mehr ablaufen. Die Vorratsseite zeigt sie weiter - dort geht es um
 * Nachschub, hier um das, was gegessen werden will.
 */
export function pantryExpiringSlice(database, today) {
  const horizon = shiftDateKey(today, PANTRY_EXPIRING_HORIZON_DAYS);
  // EINE Bedingung fuer Zahlen und Liste: zwei Fassungen koennten
  // auseinanderlaufen, und die Badge zaehlte dann etwas anderes als die Zeilen
  // darunter.
  const inHorizon = 'pi.expires_on IS NOT NULL AND pi.expires_on <= @horizon AND pi.quantity > 0';
  const counts = database.prepare(`
    SELECT COUNT(*) AS total,
           COALESCE(SUM(CASE WHEN pi.expires_on < @today THEN 1 ELSE 0 END), 0) AS expired,
           COALESCE(SUM(CASE WHEN pi.expires_on = @today THEN 1 ELSE 0 END), 0) AS today
    FROM pantry_items pi
    WHERE ${inHorizon}
  `).get({ today, horizon });

  const rows = database.prepare(`
    SELECT pi.id, pi.name, pi.quantity, pi.unit, pi.expires_on,
           pl.name AS location_name, pl.icon AS location_icon
    FROM pantry_items pi
    LEFT JOIN pantry_locations pl ON pl.id = pi.location_id
    WHERE ${inHorizon}
    ORDER BY pi.expires_on ASC, pi.name COLLATE NOCASE ASC, pi.id ASC
    LIMIT @cap
  `).all({ horizon, cap: PANTRY_EXPIRING_ROW_CAP });

  const todayItems = database.prepare(`
    SELECT pi.id, pi.name, pi.quantity, pi.unit
    FROM pantry_items pi
    WHERE pi.expires_on = @today AND pi.quantity > 0
    ORDER BY pi.name COLLATE NOCASE ASC, pi.id ASC
    LIMIT @cap
  `).all({ today, cap: PANTRY_EXPIRING_ROW_CAP });

  return {
    items: rows.map((row) => ({
      id: row.id,
      name: row.name,
      quantity: row.quantity,
      unit: row.unit,
      expires_on: row.expires_on,
      days_left: daysBetweenDateKeys(today, row.expires_on),
      location_name: row.location_name ?? null,
      location_icon: row.location_icon ?? null,
    })),
    todayItems,
    total: counts?.total ?? 0,
    expiredCount: counts?.expired ?? 0,
    todayCount: counts?.today ?? 0,
  };
}
