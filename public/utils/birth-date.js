/**
 * Modul: Geburtsdatum mit oder ohne Jahr (public/utils/birth-date.js, #2095)
 * Zweck: Ein Geburtstag kann nur Tag und Monat tragen. Gespeichert bleibt ein
 *        volles Datum mit dem Platzhalterjahr 2000 (birthdays.year_unknown,
 *        contacts.birthday_year_unknown); hier stehen die zwei Stellen, die das
 *        Jahr dann nie zeigen duerfen: die Anzeige und das Eingabefeld im
 *        Editor. Geteilt von Geburtstagen und Kontakten, damit dasselbe Datum
 *        in beiden gleich aussieht und gleich eingegeben wird.
 * Abhaengigkeiten: /i18n.js, /utils/html.js
 */
import { t, formatDate, formatDayMonth, getLocale } from '/i18n.js';
import { esc } from '/utils/html.js';

/** Spiegel von YEAR_UNKNOWN_PLACEHOLDER in server/services/birthdays.js. */
export const YEAR_UNKNOWN_PLACEHOLDER = 2000;

function isYearUnknown(flag) {
  return flag === true || flag === 1;
}

/** Tage eines Monats im Schaltjahr: der 29.02. bleibt waehlbar. */
export function daysInMonthOfLeapYear(month) {
  const numeric = Number(month);
  if (!Number.isInteger(numeric) || numeric < 1 || numeric > 12) return 0;
  return new Date(Date.UTC(YEAR_UNKNOWN_PLACEHOLDER, numeric, 0)).getUTCDate();
}

/** Tag und Monat ausgeschrieben, ohne Jahr: "15. März", "March 15". */
export function monthDayText(month, day) {
  const m = Number(month);
  const d = Number(day);
  if (!m || !d) return '';
  return new Intl.DateTimeFormat(getLocale(), { day: 'numeric', month: 'long', timeZone: 'UTC' })
    .format(new Date(Date.UTC(YEAR_UNKNOWN_PLACEHOLDER, m - 1, d)));
}

/**
 * Das Geburtsdatum zum Lesen. Ohne Jahr ausgeschrieben ("15. März"): eine
 * Ziffernfolge "15.03." saehe nach abgeschnittenem Datum aus.
 * @param {string|null} date  YYYY-MM-DD
 * @param {boolean|number} yearUnknown
 */
export function birthDateText(date, yearUnknown) {
  if (!date) return '';
  if (!isYearUnknown(yearUnknown)) return formatDate(date);
  const [, month, day] = String(date).split('-');
  return monthDayText(month, day);
}

/** Das Geburtsdatum knapp, fuer Spalten mit Ziffern-Daten: "15.03." ohne Jahr. */
export function birthDateShort(date, yearUnknown) {
  if (!date) return '';
  return isYearUnknown(yearUnknown) ? formatDayMonth(date) : formatDate(date);
}

function monthOptions(selected) {
  const formatter = new Intl.DateTimeFormat(getLocale(), { month: 'long', timeZone: 'UTC' });
  return Array.from({ length: 12 }, (_, index) => {
    const value = String(index + 1).padStart(2, '0');
    const label = formatter.format(new Date(Date.UTC(YEAR_UNKNOWN_PLACEHOLDER, index, 1)));
    return `<option value="${value}"${value === selected ? ' selected' : ''}>${esc(label)}</option>`;
  }).join('');
}

function dayOptionNodes(month, selected) {
  const option = (value, label) => {
    const node = document.createElement('option');
    node.value = value;
    node.textContent = label;
    node.selected = value === selected;
    return node;
  };
  const nodes = [option('', t('birthdays.yearlessDayPlaceholder'))];
  for (let day = 1; day <= daysInMonthOfLeapYear(month); day++) {
    const value = String(day).padStart(2, '0');
    nodes.push(option(value, String(day)));
  }
  return nodes;
}

function dayOptionsHtml(month, selected) {
  const options = [`<option value="">${esc(t('birthdays.yearlessDayPlaceholder'))}</option>`];
  for (let day = 1; day <= daysInMonthOfLeapYear(month); day++) {
    const value = String(day).padStart(2, '0');
    options.push(`<option value="${value}"${value === selected ? ' selected' : ''}>${day}</option>`);
  }
  return options.join('');
}

/**
 * DAS EINGABEFELD: Datum mit Jahr, darunter "Jahr unbekannt". Angehakt weicht
 * der Datumswaehler zwei Auswahlen fuer Monat und Tag - dieselbe Bauart wie der
 * Namenstag im selben Dialog. Ein Datumswaehler mit ausgeblendetem Jahr
 * verlangte trotzdem eines, und ein erfundenes Jahr ist genau der Fehler, um
 * den es geht.
 * @param {{ id: string, label: string, value?: string|null, yearUnknown?: boolean|number, max?: string, hint?: string }} opts
 */
export function birthDateFieldHtml({ id, label, value = '', yearUnknown = false, max = '', hint = '' }) {
  return `
    <div class="form-group">
      <label class="form-label" for="${esc(id)}" id="${esc(id)}-label">${esc(label)}</label>
      ${birthDateControlHtml({ id, value, yearUnknown, max })}
      ${hint ? `<p class="form-hint">${esc(hint)}</p>` : ''}
    </div>`;
}

/**
 * Nur das Bedienelement, ohne Gruppe und Beschriftung: fuer Zeilen, die ihre
 * Beschriftung selbst setzen (`formRowHtml` in den Einstellungen, Profil und
 * Mitglied). Die Beschriftung muss die id `${id}-label` tragen - die Auswahl
 * ohne Jahr nennt sie als ihren Namen.
 * @param {{ id: string, value?: string|null, yearUnknown?: boolean|number, max?: string, describedBy?: string }} opts
 */
export function birthDateControlHtml({ id, value = '', yearUnknown = false, max = '', describedBy = '' }) {
  const unknown = isYearUnknown(yearUnknown);
  const [, month = '', day = ''] = String(value || '').split('-');
  const described = describedBy ? ` aria-describedby="${esc(describedBy)}"` : '';
  return `
    <div class="birth-date-field" data-birth-date-field="${esc(id)}">
      <yuvomi-datepicker id="${esc(id)}" type="date"${max ? ` max="${esc(max)}"` : ''} value="${unknown ? '' : esc(value || '')}"${described}${unknown ? ' hidden' : ''}></yuvomi-datepicker>
      <div class="birth-date-field__yearless" id="${esc(id)}-yearless" role="group" aria-labelledby="${esc(id)}-label"${unknown ? '' : ' hidden'}>
        <select class="form-input birth-date-field__select" id="${esc(id)}-month" aria-label="${esc(t('birthdays.yearlessMonthLabel'))}">
          <option value="">${esc(t('birthdays.yearlessMonthPlaceholder'))}</option>
          ${monthOptions(unknown ? month : '')}
        </select>
        <select class="form-input birth-date-field__select" id="${esc(id)}-day" aria-label="${esc(t('birthdays.yearlessDayLabel'))}"${unknown && month ? '' : ' disabled'}>
          ${dayOptionsHtml(unknown ? month : '', unknown ? day : '')}
        </select>
      </div>
      <label class="form-check birth-date-field__toggle">
        <input type="checkbox" id="${esc(id)}-year-unknown"${unknown ? ' checked' : ''}>
        <span>${esc(t('birthdays.yearUnknown'))}</span>
      </label>
    </div>`;
}

/**
 * Verdrahtet das Feld und liefert den Leser. Beim Umschalten wandern Tag und
 * Monat mit, in beide Richtungen; das Jahr eines zuvor gewaehlten Datums kommt
 * zurueck, wenn man den Haken wieder wegnimmt.
 * @param {ParentNode} root
 * @param {string} id
 * @returns {{ read: () => ({ date: string|null, yearUnknown: boolean, complete: boolean, raw: string }) }}
 */
export function wireBirthDateField(root, id) {
  const picker = root.querySelector(`#${id}`);
  const yearless = root.querySelector(`#${id}-yearless`);
  const monthSel = root.querySelector(`#${id}-month`);
  const daySel = root.querySelector(`#${id}-day`);
  const toggle = root.querySelector(`#${id}-year-unknown`);
  let rememberedYear = '';

  const refreshDays = (preferred = '') => {
    daySel.replaceChildren(...dayOptionNodes(monthSel.value, preferred));
    daySel.disabled = !monthSel.value;
  };
  monthSel.addEventListener('change', () => refreshDays(daySel.value));

  toggle.addEventListener('change', () => {
    if (toggle.checked) {
      const [year = '', month = '', day = ''] = String(picker.value || '').split('-');
      rememberedYear = year;
      if (month) monthSel.value = month;
      refreshDays(day);
      picker.hidden = true;
      yearless.hidden = false;
      monthSel.focus();
    } else {
      if (rememberedYear && monthSel.value && daySel.value) {
        picker.value = `${rememberedYear}-${monthSel.value}-${daySel.value}`;
      }
      yearless.hidden = true;
      picker.hidden = false;
    }
  });

  return {
    read() {
      if (!toggle.checked) {
        const raw = picker.value || '';
        return { date: raw || null, yearUnknown: false, complete: true, raw };
      }
      const month = monthSel.value;
      const day = daySel.value;
      if (!month && !day) return { date: null, yearUnknown: true, complete: true, raw: '' };
      if (!month || !day) return { date: null, yearUnknown: true, complete: false, raw: '' };
      const date = `${YEAR_UNKNOWN_PLACEHOLDER}-${month}-${day}`;
      return { date, yearUnknown: true, complete: true, raw: date };
    },
  };
}
