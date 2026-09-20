/**
 * Modul: Inventar-Garantiefristen — reine Datumsrechnung
 * Zweck: warranty_end = purchase_date + warranty_months, nie gespeichert,
 *        bei jedem Bedarf neu berechnet (Erinnerungs-Lebenszyklus, ICS-Feed).
 * Abhängigkeiten: server/utils/reminder-schedule.js.
 *
 * Monats-Addition mit Tages-Klemmung ist jetzt eine duenne Fassade ueber
 * server/utils/interval-date.js#addMonthsClamped - dieselbe Rechnung stand
 * zuvor hier UND in server/services/subscriptions.js#addBillingCycle
 * (monthly-Zweig); dort steht auch, warum sie extrahiert wurde.
 */

import { reminderDateBefore } from '../utils/reminder-schedule.js';
import { addMonthsClamped } from '../utils/interval-date.js';

/** Kaufdatum + Garantiemonate -> YYYY-MM-DD. */
function warrantyEndDate(purchaseDate, warrantyMonths) {
  return addMonthsClamped(purchaseDate, Number(warrantyMonths));
}

/** Erinnerungstermin: warrantyEnd minus offsetDays, fixe Uhrzeit 09:00.
 *  Sprechende Fassade ueber der geteilten Rechnung in
 *  server/utils/reminder-schedule.js - dort steht auch, warum sie geteilt ist. */
function reminderDateForWarranty(warrantyEnd, offsetDays = 30) {
  return reminderDateBefore(warrantyEnd, offsetDays);
}

export { warrantyEndDate, reminderDateForWarranty };
