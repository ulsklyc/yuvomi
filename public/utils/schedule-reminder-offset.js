/**
 * Modul: Schichtplan - Erinnerungsvorlauf als Auswahl.
 * Zweck: EINE Fassung der Vorlauf-Auswahl fuer zwei Orte - das Zusatzschicht-
 *        Formular im Schichtplan (eigener Vorlauf je Extra) und das
 *        Einstellungsblatt des Moduls (eigener Vorlauf fuer alle Schichten).
 *        Bis R14 lebte die zweite Stelle als Karte "Meine Einstellungen" im
 *        Tab "Auswertung" (Re-Critique 2026-09-28, A2 P2-3); seit sie ins
 *        Modulblatt gewandert ist, braeuchte sie sonst eine Abschrift.
 * Abhaengigkeiten: /i18n.js, /utils/html.js, /components/modal.js
 */
import { t } from '/i18n.js';
import { esc } from '/utils/html.js';
import { promptModal } from '/components/modal.js';

// Feste Presets statt eines freien Zahlenfelds: der Server deckelt ohnehin auf
// 24h (server/routes/schedule-preferences.js), und eine Handvoll sprechender
// Werte ist schneller getroffen als eine Minutenzahl zu tippen.
export const REMINDER_OFFSET_PRESETS = [0, 5, 10, 15, 30, 60, 120];

const offsetLabel = (minutes) => (minutes === 0
  ? t('schedule.reminderAtStart')
  : t('schedule.reminderMinutesBefore', { minutes }));

// `selectedMinutes == null` heisst "noch nicht konfiguriert" (Umschalter aus /
// frisches Formular), nicht "0 Minuten Vorlauf" - `Number(null) === 0` waere
// sonst true und liesse den 0-Minuten-Eintrag ("zu Schichtbeginn") als
// vermeintliche Auswahl erscheinen, obwohl niemand ihn gewaehlt hat. Der
// Aendern-Handler liest beim Einschalten genau diesen (dann falschen) Wert aus
// dem <select> zurueck, sein eigener `?? 15`-Rueckfall greift also nie (er
// sieht nie `null`/`undefined`, sondern die Zeichenkette "0"). 15 Minuten ist
// deshalb hier, nicht erst dort, der tatsaechliche Vorgabewert.
export function reminderOffsetOptions(selectedMinutes) {
  const effective = selectedMinutes ?? 15;
  const presetsHtml = REMINDER_OFFSET_PRESETS.map((minutes) =>
    `<option value="${minutes}"${Number(effective) === minutes ? ' selected' : ''}>${esc(offsetLabel(minutes))}</option>`
  ).join('');
  // S-23 (UX-Audit): der Server erlaubt 0-1440 Minuten (MAX_OFFSET_MINUTES/
  // MAX_REMINDER_OFFSET_MINUTES), diese Liste deckelte die UI zuvor auf 120 -
  // ein bereits gespeicherter Wert ausserhalb der Presets (z.B. per API
  // gesetzt) braucht eine echte, ausgewaehlte Option, sonst zeigt das <select>
  // stillschweigend die falsche Zeile als aktiv an.
  const customValueHtml = Number.isInteger(effective) && !REMINDER_OFFSET_PRESETS.includes(effective)
    ? `<option value="${effective}" selected data-custom-value="1">${esc(offsetLabel(effective))}</option>`
    : '';
  return presetsHtml + customValueHtml + `<option value="custom">${esc(t('schedule.reminderCustomOffset'))}</option>`;
}

/**
 * S-23: "Custom..." selbst ist keine speicherbare Auswahl, sondern der
 * Einstiegspunkt zu promptModal() fuer eine freie Minutenzahl (0-1440, wie
 * der Server sie zulaesst). Erfolgreich bestaetigt, haengt sie sich als
 * echte, ausgewaehlte Option an (dieselbe Form wie ein bereits gespeicherter
 * Fremdwert oben) und meldet die Minuten an `onResolved` zurueck; abgebrochen
 * oder ungueltig, springt das <select> auf seinen letzten echten Wert zurueck -
 * "Custom..." bleibt selbst nie die aktive Auswahl.
 */
export async function pickCustomReminderOffset(select, onResolved) {
  const previous = select.dataset.previousValue ?? '15';
  const input = await promptModal(t('schedule.customReminderOffsetPrompt'), '');
  const minutes = input == null ? NaN : Math.round(Number(input));
  if (!Number.isFinite(minutes) || minutes < 0 || minutes > 1440) {
    select.value = previous;
    return;
  }
  let customOption = select.querySelector('option[data-custom-value]');
  if (!customOption) {
    customOption = document.createElement('option');
    customOption.dataset.customValue = '1';
    select.querySelector('option[value="custom"]')?.insertAdjacentElement('beforebegin', customOption);
  }
  customOption.value = String(minutes);
  customOption.textContent = offsetLabel(minutes);
  select.value = String(minutes);
  select.dataset.previousValue = String(minutes);
  onResolved(minutes);
}
