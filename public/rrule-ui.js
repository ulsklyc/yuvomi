/**
 * Modul: RRULE UI-Helfer
 * Zweck: Wiederholungs-Formular (HTML + Logik) für Aufgaben- und Kalender-Modals
 * Abhängigkeiten: /i18n.js
 */

import { t, formatDateInput, parseDateInput, isDateInputValid } from '/i18n.js';

const FREQ_OPTIONS = () => [
  { value: '',        label: t('rrule.freqNone') },
  { value: 'DAILY',   label: t('rrule.freqDaily') },
  { value: 'WEEKLY',  label: t('rrule.freqWeekly') },
  { value: 'MONTHLY', label: t('rrule.freqMonthly') },
  { value: 'YEARLY',  label: t('rrule.freqYearly') },
];

const WEEKDAYS = () => [
  { value: 'MO', label: t('rrule.dayMo') },
  { value: 'TU', label: t('rrule.dayTu') },
  { value: 'WE', label: t('rrule.dayWe') },
  { value: 'TH', label: t('rrule.dayTh') },
  { value: 'FR', label: t('rrule.dayFr') },
  { value: 'SA', label: t('rrule.daySa') },
  { value: 'SU', label: t('rrule.daySu') },
];

/**
 * Parsed einen RRULE-String in ein Objekt für die UI.
 * @param {string|null} rule - z.B. "FREQ=WEEKLY;BYDAY=MO,TH;INTERVAL=2;COUNT=10"
 * @returns {{ freq: string, interval: number, byday: string[], until: string, count: number|null }}
 */
export function parseRRule(rule) {
  const result = { freq: '', interval: 1, byday: [], until: '', count: null };
  if (!rule) return result;

  for (const segment of rule.split(';')) {
    const eq = segment.indexOf('=');
    if (eq === -1) continue;
    const key = segment.slice(0, eq).toUpperCase();
    const val = segment.slice(eq + 1);

    if (key === 'FREQ')     result.freq     = val;
    if (key === 'INTERVAL') result.interval  = parseInt(val, 10) || 1;
    if (key === 'BYDAY')    result.byday     = val.split(',').map(d => d.trim());
    if (key === 'UNTIL') {
      // YYYYMMDD → YYYY-MM-DD
      const c = val.replace(/[TZ]/g, '');
      result.until = `${c.slice(0, 4)}-${c.slice(4, 6)}-${c.slice(6, 8)}`;
    }
    if (key === 'COUNT') {
      const n = parseInt(val, 10);
      if (Number.isInteger(n) && n > 0) result.count = n;
    }
  }
  return result;
}

/**
 * Baut einen RRULE-String aus den UI-Werten. UNTIL und COUNT schließen sich
 * gegenseitig aus (RFC 5545); COUNT hat Vorrang, falls beide gesetzt sind (#513).
 * @param {{ freq: string, interval: number, byday: string[], until: string, count?: number|null }} opts
 * @returns {string|null} - RRULE-String oder null (keine Wiederholung)
 */
export function buildRRule({ freq, interval, byday, until, count = null }) {
  if (!freq) return null;

  const parts = [`FREQ=${freq}`];
  if (interval > 1) parts.push(`INTERVAL=${interval}`);
  if (freq === 'WEEKLY' && byday.length > 0) {
    parts.push(`BYDAY=${byday.join(',')}`);
  }
  if (count && count > 0) {
    parts.push(`COUNT=${count}`);
  } else if (until) {
    parts.push(`UNTIL=${until.replace(/-/g, '')}T235959Z`);
  }
  return parts.join(';');
}

/**
 * Rendert das HTML für die Wiederholungs-Felder.
 * @param {string} prefix - ID-Prefix (z.B. "task" oder "event")
 * @param {string|null} existingRule - bestehende RRULE oder null
 * @param {{ allowCount?: boolean }} [opts] - allowCount aktiviert die
 *        "Nach N Terminen"-Endebedingung (COUNT). Nur für Kontexte mit
 *        startverankerter Expansion (Kalender). Aufgaben sind
 *        abschluss-getrieben und kennen keine COUNT-Semantik (#513).
 * @returns {string} HTML-String
 */
export function renderRRuleFields(prefix, existingRule, opts = {}) {
  const allowCount = !!opts.allowCount;
  const parsed = parseRRule(existingRule);

  const freqOpts = FREQ_OPTIONS().map(o =>
    `<option value="${o.value}" ${parsed.freq === o.value ? 'selected' : ''}>${o.label}</option>`
  ).join('');

  const dayBtns = WEEKDAYS().map(d =>
    `<button type="button" class="rrule-day ${parsed.byday.includes(d.value) ? 'rrule-day--active' : ''}"
             data-day="${d.value}" aria-label="${d.label}" aria-pressed="${parsed.byday.includes(d.value)}">${d.label}</button>`
  ).join('');

  // Endebedingung: Nie / Am Datum (UNTIL) / Nach N Terminen (COUNT). COUNT und
  // UNTIL schließen sich aus (RFC 5545) – der Selektor blendet je Wahl ein Feld ein.
  // COUNT nur wenn allowCount (Kalender); sonst wird ein bestehendes COUNT wie
  // "kein Ende" behandelt (Aufgaben-Engine kennt COUNT ohnehin nicht).
  const endType = (allowCount && parsed.count) ? 'count' : (parsed.until ? 'until' : 'never');
  const endOpts = [
    { value: 'never', label: t('rrule.endNever') },
    { value: 'until', label: t('rrule.endOnDate') },
    ...(allowCount ? [{ value: 'count', label: t('rrule.endAfter') }] : []),
  ].map(o => `<option value="${o.value}" ${endType === o.value ? 'selected' : ''}>${o.label}</option>`).join('');

  return `
    <div class="rrule-fields" id="${prefix}-rrule-fields">
      <div class="form-group">
        <label class="label form-label" for="${prefix}-rrule-freq">${t('rrule.labelRepeat')}</label>
        <select class="input form-input" id="${prefix}-rrule-freq" style="min-height:44px">
          ${freqOpts}
        </select>
      </div>

      <div class="rrule-details" id="${prefix}-rrule-details" ${parsed.freq ? '' : 'hidden'}>
        <div class="rrule-row">
          <div class="form-group" style="margin-bottom:0">
            <label class="label form-label" for="${prefix}-rrule-interval">${t('rrule.labelEvery')}</label>
            <div class="rrule-interval-wrap">
              <input class="input form-input" type="number" id="${prefix}-rrule-interval"
                     min="1" max="99" value="${parsed.interval}" inputmode="numeric" style="width:64px;text-align:center">
              <span class="rrule-interval-unit" id="${prefix}-rrule-unit">${unitLabel(parsed.freq, parsed.interval)}</span>
            </div>
          </div>
          <div class="form-group" style="margin-bottom:0">
            <label class="label form-label" for="${prefix}-rrule-end">${t('rrule.labelEnds')}</label>
            <select class="input form-input" id="${prefix}-rrule-end" style="min-height:44px">
              ${endOpts}
            </select>
          </div>
        </div>

        <div class="rrule-row rrule-end-inputs">
          <div class="form-group rrule-until-field" id="${prefix}-rrule-until-wrap" ${endType === 'until' ? '' : 'hidden'} style="margin-bottom:0">
            <label class="label form-label" for="${prefix}-rrule-until">${t('rrule.labelUntil')}</label>
            <yuvomi-datepicker type="date" id="${prefix}-rrule-until"
                   value="${formatDateInput(parsed.until)}"></yuvomi-datepicker>
          </div>
          ${allowCount ? `<div class="form-group rrule-count-field" id="${prefix}-rrule-count-wrap" ${endType === 'count' ? '' : 'hidden'} style="margin-bottom:0">
            <label class="label form-label" for="${prefix}-rrule-count">${t('rrule.labelCount')}</label>
            <div class="rrule-interval-wrap">
              <input class="input form-input" type="number" id="${prefix}-rrule-count"
                     min="1" max="999" value="${parsed.count || 10}" inputmode="numeric" style="width:64px;text-align:center">
              <span class="rrule-interval-unit">${t('rrule.unitOccurrences')}</span>
            </div>
          </div>` : ''}
        </div>

        <div class="rrule-weekdays" id="${prefix}-rrule-weekdays" ${parsed.freq === 'WEEKLY' ? '' : 'hidden'}>
          <label class="label form-label">${t('rrule.labelOnDays')}</label>
          <div class="rrule-day-grid">${dayBtns}</div>
        </div>

      </div>
    </div>
  `;
}

function unitLabel(freq, interval) {
  const n = interval > 1;
  if (freq === 'DAILY')   return n ? t('rrule.unitDays')   : t('rrule.unitDay');
  if (freq === 'WEEKLY')  return n ? t('rrule.unitWeeks')  : t('rrule.unitWeek');
  if (freq === 'MONTHLY') return n ? t('rrule.unitMonths') : t('rrule.unitMonth');
  if (freq === 'YEARLY')  return n ? t('rrule.unitYears')  : t('rrule.unitYear');
  return '';
}

/**
 * Bindet Events an die RRULE-Felder (Freq-Change, Day-Toggle, etc.)
 * @param {HTMLElement} root - Container-Element
 * @param {string} prefix - ID-Prefix
 */
export function bindRRuleEvents(root, prefix) {
  const freqSelect  = root.querySelector(`#${prefix}-rrule-freq`);
  const details     = root.querySelector(`#${prefix}-rrule-details`);
  const weekdays    = root.querySelector(`#${prefix}-rrule-weekdays`);
  const unitEl      = root.querySelector(`#${prefix}-rrule-unit`);
  const intervalEl  = root.querySelector(`#${prefix}-rrule-interval`);
  const endSelect   = root.querySelector(`#${prefix}-rrule-end`);
  const untilWrap   = root.querySelector(`#${prefix}-rrule-until-wrap`);
  const countWrap   = root.querySelector(`#${prefix}-rrule-count-wrap`);

  if (!freqSelect) return;

  freqSelect.addEventListener('change', () => {
    const freq = freqSelect.value;
    if (details)  details.hidden  = !freq;
    if (weekdays) weekdays.hidden = freq !== 'WEEKLY';
    updateUnit();
  });

  endSelect?.addEventListener('change', () => {
    const mode = endSelect.value;
    if (untilWrap) untilWrap.hidden = mode !== 'until';
    if (countWrap) countWrap.hidden = mode !== 'count';
  });

  intervalEl?.addEventListener('input', updateUnit);

  // Day-Toggle
  root.querySelectorAll(`#${prefix}-rrule-weekdays .rrule-day`).forEach(btn => {
    btn.addEventListener('click', () => {
      btn.classList.toggle('rrule-day--active');
      btn.setAttribute('aria-pressed', btn.classList.contains('rrule-day--active'));
    });
  });

  function updateUnit() {
    if (!unitEl) return;
    const interval = parseInt(intervalEl?.value, 10) || 1;
    unitEl.textContent = unitLabel(freqSelect.value, interval);
  }
}

/**
 * Liest die aktuellen RRULE-Werte aus dem Formular.
 * @param {HTMLElement} root - Container-Element
 * @param {string} prefix - ID-Prefix
 * @returns {{ is_recurring: boolean, recurrence_rule: string|null }}
 */
export function getRRuleValues(root, prefix) {
  const freq     = root.querySelector(`#${prefix}-rrule-freq`)?.value || '';
  const interval = parseInt(root.querySelector(`#${prefix}-rrule-interval`)?.value, 10) || 1;
  const endMode  = root.querySelector(`#${prefix}-rrule-end`)?.value || 'never';
  const untilInput = root.querySelector(`#${prefix}-rrule-until`);
  const untilRaw = endMode === 'until' ? (untilInput?.value || '') : '';
  const until = parseDateInput(untilRaw);
  const count = endMode === 'count'
    ? (parseInt(root.querySelector(`#${prefix}-rrule-count`)?.value, 10) || null)
    : null;

  const byday = [];
  root.querySelectorAll(`#${prefix}-rrule-weekdays .rrule-day--active`).forEach(btn => {
    byday.push(btn.dataset.day);
  });

  const rule = buildRRule({ freq, interval, byday, until, count });
  return {
    is_recurring:    !!rule,
    recurrence_rule: rule,
    // UNTIL nur validieren, wenn "Am Datum" gewählt ist (sonst irrelevant).
    valid_until:     endMode !== 'until' || isDateInputValid(untilRaw),
  };
}
