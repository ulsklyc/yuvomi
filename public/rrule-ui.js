/**
 * Modul: RRULE UI-Helfer
 * Zweck: Wiederholungs-Formular (HTML + Logik) für Aufgaben- und Kalender-Modals
 * Abhängigkeiten: /i18n.js
 */

import { t, formatDate, formatDateInput, parseDateInput, isDateInputValid } from '/i18n.js';

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

const WEEKDAY_CODES = ['SU', 'MO', 'TU', 'WE', 'TH', 'FR', 'SA'];

/**
 * Wochentag eines Kalendertags als RRULE-Kuerzel, '' ohne gueltiges Datum.
 *
 * Gerechnet wird am KEY, ueber UTC-Felder: ein Date aus einem Key waere
 * Mitternacht der Browser-Zone und koennte je nach Anzeigezone auf dem
 * Nachbartag landen. Die Bestandteile werden zurueckgelesen, damit ein
 * 31. Februar keinen Wochentag bekommt.
 */
function weekdayCodeOf(startDate) {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(parseDateInput(startDate) || '');
  if (!match) return '';
  const [year, month, day] = [Number(match[1]), Number(match[2]), Number(match[3])];
  const date = new Date(Date.UTC(year, month - 1, day));
  if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) return '';
  return WEEKDAY_CODES[date.getUTCDay()];
}

/**
 * Parsed einen RRULE-String in ein Objekt für die UI.
 *
 * Nimmt die Regel mit und ohne „RRULE:"-Präfix. Beide Schreibweisen stehen
 * nebeneinander in der Datenbank: lokal angelegte Serien speichern den nackten
 * Regelkörper, aus CalDAV/ICS eingelesene die vollständige ICS-Zeile
 * (`ics-parser.js`). Ohne das Abstreifen hieß das erste Segment `RRULE:FREQ`,
 * kein einziger Schlüssel traf, und eine synchronisierte Serie kam als
 * „keine Wiederholung" ins Formular - Speichern schrieb diese Leere fest und
 * der Sync trug den Verlust zurück in den Fremdkalender (#756). Der Server
 * macht dasselbe seit jeher (`server/services/recurrence.js`).
 *
 * @param {string|null} rule - z.B. "FREQ=WEEKLY;BYDAY=MO,TH;INTERVAL=2;COUNT=10"
 * @returns {{ freq: string, interval: number, byday: string[], until: string, count: number|null }}
 */
export function parseRRule(rule) {
  const result = { freq: '', interval: 1, byday: [], until: '', count: null, lastDay: false };
  if (!rule) return result;

  for (const segment of String(rule).replace(/^RRULE:/i, '').split(';')) {
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
    // NUR `-1`. Jeder andere BYMONTHDAY bleibt fuer dieses Formular eine fremde
    // Angabe: er wird nicht gelesen, also auch nicht neu gebaut, und faellt damit
    // unter die Wortlaut-Regel unten - "am 15." kommt aus einem Fremdkalender
    // unveraendert zurueck, statt hier zu einem Haken zu werden, den niemand
    // gesetzt hat.
    if (key === 'BYMONTHDAY' && val.trim() === '-1') result.lastDay = true;
  }
  return result;
}

/**
 * Baut einen RRULE-String aus den UI-Werten. UNTIL und COUNT schließen sich
 * gegenseitig aus (RFC 5545); COUNT hat Vorrang, falls beide gesetzt sind (#513).
 * @param {{ freq: string, interval: number, byday: string[], until: string, count?: number|null }} opts
 * @returns {string|null} - RRULE-String oder null (keine Wiederholung)
 */
export function buildRRule({ freq, interval, byday, until, count = null, lastDay = false }) {
  if (!freq) return null;

  const parts = [`FREQ=${freq}`];
  if (interval > 1) parts.push(`INTERVAL=${interval}`);
  if (freq === 'WEEKLY' && byday.length > 0) {
    parts.push(`BYDAY=${byday.join(',')}`);
  }
  // Nur monatlich: "am letzten Tag des Jahres" waere jeder 31. Dezember und
  // damit ein fester Tag - die Angabe traegt dort nichts bei (#960).
  if (freq === 'MONTHLY' && lastDay) parts.push('BYMONTHDAY=-1');
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
 * @param {{ allowCount?: boolean, allowFromCompletion?: boolean, fromCompletion?: boolean,
 *           expandsFromStart?: boolean, startDate?: string }} [opts]
 *        allowCount aktiviert die "Nach N Terminen"-Endebedingung (COUNT). Nur
 *        für Kontexte mit startverankerter Expansion (Kalender). Aufgaben sind
 *        abschluss-getrieben und kennen keine COUNT-Semantik (#513).
 *        allowFromCompletion aktiviert den Ankerschalter "ab Erledigung" (#658) -
 *        umgekehrt nur dort, wo es ein Erledigen gibt: ein Termin wird nicht
 *        abgehakt, für ihn gäbe es keinen zweiten Anker.
 *        expandsFromStart sagt, ob das Modul die Regel vom Startdatum aus
 *        ausrechnet (Kalender) oder ein einzelnes Datum fortschreibt (Aufgaben).
 *        Nur davon haengt ab, welcher Monatsletzten-Hinweis stimmt.
 *        startDate ist ein explizit vom aufrufenden Modul gelieferter
 *        kanonischer Datums-Key für die konkrete Kalender-Vorschau.
 * @returns {string} HTML-String
 */
function canShowConcreteMonthEnd(rule, firstDate) {
  if (!rule) return true;

  // Eingelesene Regeln koennen mehr ausdruecken als dieses Formular. Ein
  // BYDAY-Filter macht aus "Monatsletzter" z.B. "Monatsletzter, falls Montag";
  // dann waere das rechnerische Monatsende nicht zwingend ein Vorkommen. Statt
  // im Browser eine zweite RRULE-Engine anzufangen, bleibt die Vorschau fuer
  // alles ausser dem vom Formular selbst schreibbaren Subset bewusst allgemein.
  const allowed = new Set(['FREQ', 'INTERVAL', 'BYMONTHDAY', 'UNTIL', 'COUNT']);
  let until = null;
  for (const segment of String(rule).replace(/^RRULE:/i, '').split(';')) {
    const eq = segment.indexOf('=');
    if (eq === -1) return false;
    const key = segment.slice(0, eq).toUpperCase();
    const value = segment.slice(eq + 1);
    if (!allowed.has(key)) return false;
    if (key === 'UNTIL') {
      const match = /^(\d{4})(\d{2})(\d{2})(?:T\d{6}Z?)?$/.exec(value);
      if (!match) return false;
      until = `${match[1]}-${match[2]}-${match[3]}`;
    }
  }
  return !until || until >= firstDate;
}

export function monthEndHintText(startDate, { expandsFromStart = false, rule = null } = {}) {
  if (!expandsFromStart) return t('rrule.lastDayOfMonthHintNext');

  // Der Aufrufer liefert einen kanonischen Datums-Key. parseDateInput erlaubt
  // zusätzlich die aktuelle Anzeigeform, aber die Kalendermathematik validiert
  // die Bestandteile noch einmal selbst: ein Date würde den 31. Februar sonst
  // still in den März normalisieren und eine überzeugende falsche Vorschau
  // anzeigen.
  const dateKey = parseDateInput(startDate);
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(dateKey);
  if (!match) return t('rrule.lastDayOfMonthHint');

  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const candidate = new Date(Date.UTC(year, month - 1, day));
  if (candidate.getUTCFullYear() !== year
      || candidate.getUTCMonth() !== month - 1
      || candidate.getUTCDate() !== day) {
    return t('rrule.lastDayOfMonthHint');
  }

  const monthEnd = new Date(Date.UTC(year, month, 0));
  const firstDate = [
    monthEnd.getUTCFullYear(),
    String(monthEnd.getUTCMonth() + 1).padStart(2, '0'),
    String(monthEnd.getUTCDate()).padStart(2, '0'),
  ].join('-');

  if (!canShowConcreteMonthEnd(rule, firstDate)) {
    return t('rrule.lastDayOfMonthHint');
  }

  if (dateKey === firstDate) {
    return t('rrule.lastDayOfMonthHintSame', { date: formatDate(dateKey) });
  }
  return t('rrule.lastDayOfMonthHintOverride', {
    startDate: formatDate(dateKey),
    firstDate: formatDate(firstDate),
  });
}

export function renderRRuleFields(prefix, existingRule, opts = {}) {
  const allowCount = !!opts.allowCount;
  // NICHT AN `allowCount` GEHAENGT, obwohl beide heute denselben Wert haben.
  // Sie beantworten verschiedene Fragen: `allowCount` fragt, ob "endet nach N
  // Malen" angeboten wird, diese hier, ob das Modul die Regel ueberhaupt vom
  // Startdatum aus ausrechnet. Der Kalender tut es, die Aufgabe nicht - sie ist
  // eine Zeile mit einem Faelligkeitsdatum, das die Liste direkt liest. Wer die
  // beiden koppelt, bekommt beim naechsten Modul den falschen Hinweis.
  const expandsFromStart = !!opts.expandsFromStart;
  const allowFromCompletion = !!opts.allowFromCompletion;
  const fromCompletion = !!opts.fromCompletion;
  const parsed = parseRRule(existingRule);

  // aria-describedby haengt am SELBEN Zustand wie der Hinweis, nicht nur dessen
  // hidden-Attribut: ein direkt referenzierter Knoten zaehlt zur Beschreibung,
  // AUCH wenn er verborgen ist (accname 1.2 §4.3.1, Schritt 2A nimmt genau die
  // direkt Referenzierten von der Verborgen-Regel aus). Bliebe die Referenz
  // stehen, hoerte ein Screenreader-Nutzer den Hinweis weiter, den Sehende
  // schon nicht mehr sehen - und zwar ausgerechnet den, der die Frage
  // beantwortet, die er mit seiner Auswahl gerade beantwortet hat.
  const hintRef = parsed.freq ? '' : ` aria-describedby="${prefix}-rrule-hint"`;

  const freqOpts = FREQ_OPTIONS().map(o =>
    `<option value="${o.value}" ${parsed.freq === o.value ? 'selected' : ''}>${o.label}</option>`
  ).join('');

  // OHNE BYDAY WIEDERHOLT SICH EINE WOCHENSERIE AM WOCHENTAG IHRES STARTS
  // (#1607). Das ist keine Leere, sondern eine Angabe - nur stand sie nirgends:
  // alle sieben Knoepfe wirkten "aus", waehrend die Serie donnerstags lief.
  // Der Starttag wird deshalb als aktiv GEZEIGT und traegt `data-implied`:
  // abgeleitet, nicht gewaehlt. getRRuleValues liest ihn nicht mit, die Regel
  // einer Bestandsserie bleibt also im Wortlaut, und die Serie zieht weiter mit
  // ihrem Start um, wenn jemand den Termin verschiebt.
  const impliedDay = parsed.byday.length ? '' : weekdayCodeOf(opts.startDate);
  const dayBtns = WEEKDAYS().map(d => {
    const implied = d.value === impliedDay;
    const active = implied || parsed.byday.includes(d.value);
    return `<button type="button" class="rrule-day ${active ? 'rrule-day--active' : ''}"
             data-day="${d.value}" aria-label="${d.label}" aria-pressed="${active}"${implied ? ' data-implied="true"' : ''}>${d.label}</button>`;
  }).join('');

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

  // Die Ausgangsregel im Wortlaut, für den Unverändert-Fall in getRRuleValues.
  // `esc` ist hier nicht nötig und wäre falsch: der Wert durchläuft den
  // Validator des Servers, und ein RRULE-Zeichenvorrat kennt keine Anführungs-
  // zeichen. Trotzdem attributsicher quoten - der Wert kommt aus einem
  // Fremdkalender, nicht aus dieser Oberfläche.
  const sourceRule = existingRule
    ? `<input type="hidden" id="${prefix}-rrule-source" value="${String(existingRule).replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`)}">`
    : '';

  return `
    <div class="rrule-fields" id="${prefix}-rrule-fields">
      ${sourceRule}
      <div class="form-group">
        <label class="label form-label" for="${prefix}-rrule-freq">${t('rrule.labelRepeat')}</label>
        <select class="input form-input" id="${prefix}-rrule-freq"${hintRef}>
          ${freqOpts}
        </select>
        <p class="rrule-hint" id="${prefix}-rrule-hint" ${parsed.freq ? 'hidden' : ''}>${t('rrule.intervalHint')}</p>
      </div>

      <div class="rrule-details" id="${prefix}-rrule-details" ${parsed.freq ? '' : 'hidden'}>
        <div class="rrule-row">
          <div class="form-group" style="margin-bottom:0">
            <label class="label form-label" for="${prefix}-rrule-interval">${t('rrule.labelEvery')}</label>
            <div class="rrule-interval-wrap">
              <input class="input form-input" type="number" id="${prefix}-rrule-interval"
                     min="1" max="99" value="${parsed.interval}" inputmode="numeric" style="width:64px;text-align:center">
              <span class="rrule-interval-unit" id="${prefix}-rrule-unit">${intervalUnitLabel(parsed.freq, parsed.interval)}</span>
            </div>
          </div>
          <div class="form-group" style="margin-bottom:0">
            <label class="label form-label" for="${prefix}-rrule-end">${t('rrule.labelEnds')}</label>
            <select class="input form-input" id="${prefix}-rrule-end">
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

        <!-- DIE EINE ANGABE, DIE SICH NICHT ALS DATUM SCHREIBEN LAESST (#960).
             "Am 15." braucht kein Feld - dafuer legt man die Serie am 15. an.
             "Am letzten Tag" dagegen meint in jedem Monat einen anderen und ist
             aus einem Startdatum allein nicht ableitbar: eine am 31. Januar
             begonnene Serie sah aus wie "letzter Tag" und verlor das im ersten
             kurzen Monat. Nur bei MONTHLY sichtbar, aus demselben Grund, aus
             dem buildRRule sie nur dort schreibt. -->
        <div class="rrule-monthday" id="${prefix}-rrule-monthday" ${parsed.freq === 'MONTHLY' ? '' : 'hidden'}>
          <label class="toggle" style="margin:0">
            <input type="checkbox" id="${prefix}-rrule-last-day" ${parsed.lastDay ? 'checked' : ''}${
              parsed.lastDay ? ` aria-describedby="${prefix}-rrule-monthday-hint"` : ''
            }>
            <span class="toggle__track"></span>
            <span>${t('rrule.lastDayOfMonth')}</span>
          </label>
          <!-- DAS EINGETRAGENE DATUM BLEIBT STEHEN (#960) - was daraus folgt,
               ist aber in den beiden Modulen VERSCHIEDEN, und ein Hinweis, der
               das Gegenteil verspricht, ist schlimmer als keiner.
               Der Kalender rechnet die Regel vom Startdatum aus aus: wer den
               15. eintraegt und ankreuzt, sieht als ersten Termin den 31.
               Die Aufgabe tut das nicht. Sie ist eine Zeile mit einem
               Faelligkeitsdatum, das Liste, Ueberfaelligkeit und Countdown
               direkt lesen - sie bleibt am 15. faellig, und erst der Durchlauf
               NACH dem Abhaken faellt auf den Monatsletzten.
               Der Kalender liefert sein aktives Startdatum deshalb über die
               Komponenten-Schnittstelle. Der Baustein greift nie selbst nach
               einem Startdatum-Feld: Kalender und Aufgaben benennen es anders,
               und im Kalender wechselt es zusätzlich mit „ganztägig". -->
          <p class="rrule-anchor__hint" id="${prefix}-rrule-monthday-hint"${parsed.lastDay ? '' : ' hidden'}>${
            monthEndHintText(opts.startDate, { expandsFromStart, rule: existingRule })
          }</p>
        </div>

        ${allowFromCompletion ? `
        <div class="rrule-anchor">
          <label class="toggle" style="margin:0">
            <input type="checkbox" id="${prefix}-rrule-from-completion" ${fromCompletion ? 'checked' : ''}>
            <span class="toggle__track"></span>
            <span>${t('rrule.fromCompletionLabel')}</span>
          </label>
          <p class="rrule-anchor__hint">${t('rrule.fromCompletionHint')}</p>
        </div>` : ''}

      </div>
    </div>
  `;
}

/**
 * Das Wort hinter „Alle N": Einheit in Ein- oder Mehrzahl.
 *
 * Versteht beide Schreibweisen - die RRULE-Frequenz (`WEEKLY`) und die
 * Budget-Einheit (`weekly`, #636). Die Zuordnung Einheit → Wort lag sonst ein
 * zweites Mal im Budget-Modal, sobald auch dort „alle N Monate" wählbar wurde.
 *
 * @param {string} unit   DAILY|WEEKLY|MONTHLY|YEARLY oder weekly|monthly|yearly
 * @param {number} count  Anzahl, entscheidet über Ein-/Mehrzahl
 */
export function intervalUnitLabel(unit, count = 1) {
  const n = count > 1;
  switch (String(unit || '').toUpperCase()) {
    case 'DAILY':   return n ? t('rrule.unitDays')   : t('rrule.unitDay');
    case 'WEEKLY':  return n ? t('rrule.unitWeeks')  : t('rrule.unitWeek');
    case 'MONTHLY': return n ? t('rrule.unitMonths') : t('rrule.unitMonth');
    case 'YEARLY':  return n ? t('rrule.unitYears')  : t('rrule.unitYear');
    default:        return '';
  }
}


/**
 * Beschreibt eine RRULE in einem Satz: „Alle 2 Wochen (Mo, Do) bis 31.12.2026".
 *
 * Für die Detailansicht: Ob ein Termin wöchentlich wiederkehrt, war bisher nur
 * im Bearbeitungsformular zu sehen - man musste den Termin öffnen, um eine
 * Leseinformation zu bekommen.
 *
 * @param {string|null} rule
 * @param {{ fromCompletion?: boolean }} [opts] Der Anker steht nicht in der
 *        RRULE (RFC 5545 kennt ihn nicht) und muss deshalb hier hereingereicht
 *        werden. Ohne ihn läse sich „Jede Woche" für zwei verschiedene Serien
 *        gleich, obwohl sie an verschiedenen Tagen wiederkommen (#658).
 * @returns {string} leerer String, wenn keine Wiederholung
 */
export function describeRRule(rule, opts = {}) {
  const p = parseRRule(rule);
  if (!p.freq) return '';

  // Die Beschriftungen kommen aus denselben Listen, die auch das Formular füllt.
  // Eine zweite Wert-zu-Label-Zuordnung daneben hiesse, jede künftige Frequenz
  // an zwei Stellen zu pflegen.
  const parts = [
    p.interval > 1
      ? `${t('rrule.labelEvery')} ${p.interval} ${intervalUnitLabel(p.freq, p.interval)}`
      : (FREQ_OPTIONS().find((o) => o.value === p.freq)?.label ?? t('rrule.freqDaily')),
  ];

  // Wochentage nur bei WEEKLY: bei jeder anderen Frequenz trägt BYDAY in dieser
  // Oberfläche keine Bedeutung (buildRRule schreibt es dort auch nicht).
  if (p.freq === 'WEEKLY' && p.byday.length) {
    const weekdays = WEEKDAYS();
    const days = p.byday.map((d) => weekdays.find((w) => w.value === d)?.label).filter(Boolean);
    if (days.length) parts.push(`(${days.join(', ')})`);
  }

  // Der letzte Tag gehört in die Zusammenfassung, sonst liest sich eine am 15.
  // begonnene Serie wie „monatlich" und sieht damit aus wie eine, die auch am
  // 15. wiederkommt - während ihr nächstes Vorkommen der 28. Februar ist. Die
  // Angabe steht in der Klammer, wo bei WEEKLY die Wochentage stehen: beide
  // beantworten dieselbe Frage.
  if (p.freq === 'MONTHLY' && p.lastDay) parts.push(`(${t('rrule.lastDayOfMonth')})`);

  // Die Endebedingung ist eine eigene Aussage und bekommt einen Trenner:
  // „Alle 2 Monate 5 Termine" las sich wie ein verunglückter Satz.
  let rhythm = parts.join(' ');
  if (opts.fromCompletion) rhythm += ` · ${t('rrule.summaryFromCompletion')}`;
  if (p.count) return `${rhythm} · ${t('rrule.summaryCount', { count: p.count })}`;
  if (p.until) return `${rhythm} · ${t('rrule.summaryUntil', { date: formatDate(p.until) })}`;
  return rhythm;
}

/**
 * Die Wiederholung als fertige Zeile für die Detailansicht.
 *
 * Wohnt hier statt in detail-view.js, weil dieses Modul das Konzept
 * „Wiederholungsregel" besitzt - Kalender und Aufgaben bauten die Zeile sonst
 * beide selbst, wortgleich bis auf die Entität.
 *
 * @param {string|null} rule
 * @param {{ fromCompletion?: boolean }} [opts] siehe describeRRule
 * @returns {{icon: string, label: string, value: string}}
 */
export function recurrenceRow(rule, opts = {}) {
  return { icon: 'repeat', label: t('rrule.labelRepeat'), value: describeRRule(rule, opts) };
}

/**
 * Bindet Events an die RRULE-Felder (Freq-Change, Day-Toggle, etc.)
 * @param {HTMLElement} root - Container-Element
 * @param {string} prefix - ID-Prefix
 * @param {{ expandsFromStart?: boolean, getStartDate?: () => string }} [opts]
 *        Das aufrufende Modul liefert bei Bedarf sein aktuelles Startdatum;
 *        der RRULE-Baustein kennt keine fremden Feldselektoren.
 * @returns {{ refreshMonthdayHint: () => void, refreshStartDate: () => void }}
 *          `refreshStartDate` ruft der Aufrufer bei JEDER Aenderung seines
 *          Startdatums: Monatsletzten-Vorschau und Wochentags-Vorauswahl
 *          haengen beide daran.
 */
export function bindRRuleEvents(root, prefix, opts = {}) {
  const freqSelect  = root.querySelector(`#${prefix}-rrule-freq`);
  const details     = root.querySelector(`#${prefix}-rrule-details`);
  const weekdays    = root.querySelector(`#${prefix}-rrule-weekdays`);
  const monthday    = root.querySelector(`#${prefix}-rrule-monthday`);
  const unitEl      = root.querySelector(`#${prefix}-rrule-unit`);
  const intervalEl  = root.querySelector(`#${prefix}-rrule-interval`);
  const endSelect   = root.querySelector(`#${prefix}-rrule-end`);
  const untilWrap   = root.querySelector(`#${prefix}-rrule-until-wrap`);
  const countWrap   = root.querySelector(`#${prefix}-rrule-count-wrap`);
  const untilInput  = root.querySelector(`#${prefix}-rrule-until`);
  const countInput  = root.querySelector(`#${prefix}-rrule-count`);
  const hint        = root.querySelector(`#${prefix}-rrule-hint`);
  const monthdayHint = root.querySelector(`#${prefix}-rrule-monthday-hint`);
  const lastDayInput = root.querySelector(`#${prefix}-rrule-last-day`);

  const refreshMonthdayHint = () => {
    if (!monthdayHint || typeof opts.getStartDate !== 'function') return;
    const current = getRRuleValues(root, prefix);
    monthdayHint.textContent = monthEndHintText(opts.getStartDate(), {
      expandsFromStart: !!opts.expandsFromStart,
      // Die eigenen Felder sind die Wahrheit fuer die Live-Vorschau. Bei einer
      // ungueltigen UNTIL-Eingabe ist kein konkreter Termin belegbar; der
      // Platzhalter erzwingt deshalb denselben sicheren generischen Rueckfall
      // wie ein nicht unterstuetztes importiertes Regelteil.
      rule: current.valid_until ? current.recurrence_rule : 'INVALID',
    });
  };

  const syncMonthdayHintVisibility = () => {
    if (!monthdayHint || !lastDayInput) return;
    monthdayHint.hidden = !lastDayInput.checked;
    if (lastDayInput.checked) {
      lastDayInput.setAttribute('aria-describedby', monthdayHint.id || `${prefix}-rrule-monthday-hint`);
    } else {
      lastDayInput.removeAttribute('aria-describedby');
    }
  };

  // Die Wochentags-Vorauswahl (#1607). `impliedDays` heisst: kein Knopf traegt
  // eine Wahl des Nutzers oder der gespeicherten Regel - dann zeigt genau der
  // Wochentag des Starts "aktiv", und er zieht mit dem Startdatum um.
  const dayButtons = [...root.querySelectorAll(`#${prefix}-rrule-weekdays .rrule-day`)];
  const chosenDays = () => dayButtons.filter(
    (btn) => btn.classList.contains('rrule-day--active') && !btn.hasAttribute('data-implied'),
  );
  let impliedDays = chosenDays().length === 0;

  const setDay = (btn, active, implied) => {
    btn.classList.toggle('rrule-day--active', active);
    btn.setAttribute('aria-pressed', String(active));
    if (implied) btn.setAttribute('data-implied', 'true');
    else         btn.removeAttribute('data-implied');
  };

  const refreshImpliedDay = () => {
    if (!impliedDays) return;
    const code = typeof opts.getStartDate === 'function' ? weekdayCodeOf(opts.getStartDate()) : '';
    for (const btn of dayButtons) setDay(btn, btn.dataset.day === code, btn.dataset.day === code);
  };

  const refreshStartDate = () => {
    refreshMonthdayHint();
    refreshImpliedDay();
  };

  if (!freqSelect) return { refreshMonthdayHint, refreshStartDate };

  freqSelect.addEventListener('change', () => {
    const freq = freqSelect.value;
    if (details)  details.hidden  = !freq;
    if (weekdays) weekdays.hidden = freq !== 'WEEKLY';
    if (monthday) monthday.hidden = freq !== 'MONTHLY';
    // Beim Wechsel weg von "monatlich" verliert die Wahl ihre Bedeutung. Der
    // Haken bleibt gesetzt, damit ein versehentlicher Wechsel und zurueck ihn
    // nicht verschluckt - buildRRule schreibt ihn ohnehin nur bei MONTHLY.
    // Der Hinweis ist die Umkehrung des Detailbereichs: er beantwortet die Frage
    // "sind das die einzigen vier Takte?", und sobald der Takt sichtbar danebensteht,
    // hat sie sich erledigt (#862). Die Beschreibung des Auswahlfelds geht mit -
    // ein verborgener, aber referenzierter Knoten wird trotzdem vorgelesen.
    if (hint) {
      hint.hidden = !!freq;
      if (freq) freqSelect.removeAttribute('aria-describedby');
      else      freqSelect.setAttribute('aria-describedby', hint.id || `${prefix}-rrule-hint`);
    }
    refreshStartDate();
    updateUnit();
  });

  endSelect?.addEventListener('change', () => {
    const mode = endSelect.value;
    if (untilWrap) untilWrap.hidden = mode !== 'until';
    if (countWrap) countWrap.hidden = mode !== 'count';
    refreshMonthdayHint();
  });

  intervalEl?.addEventListener('input', updateUnit);
  untilInput?.addEventListener('change', refreshMonthdayHint);
  countInput?.addEventListener('input', refreshMonthdayHint);
  lastDayInput?.addEventListener('change', () => {
    refreshMonthdayHint();
    syncMonthdayHintVisibility();
  });

  // Day-Toggle
  dayButtons.forEach(btn => {
    btn.addEventListener('click', () => {
      // Die erste Beruehrung macht aus dem gezeigten Starttag eine Wahl: wer
      // "Montag" dazunimmt, will Montag UND den Tag, der schon aktiv aussah.
      if (impliedDays) {
        impliedDays = false;
        for (const other of dayButtons) other.removeAttribute('data-implied');
      }
      setDay(btn, !btn.classList.contains('rrule-day--active'), false);
      // Kein Tag gewaehlt heisst wieder "am Wochentag des Starts" - die Anzeige
      // faellt auf ihn zurueck, statt sieben Knoepfe "aus" zu zeigen, waehrend
      // die Serie trotzdem laeuft.
      if (chosenDays().length === 0) {
        impliedDays = true;
        refreshImpliedDay();
      }
    });
  });

  function updateUnit() {
    if (!unitEl) return;
    const interval = parseInt(intervalEl?.value, 10) || 1;
    unitEl.textContent = intervalUnitLabel(freqSelect.value, interval);
  }

  refreshStartDate();
  syncMonthdayHintVisibility();
  return { refreshMonthdayHint, refreshStartDate };
}

/**
 * Liest die aktuellen RRULE-Werte aus dem Formular.
 * @param {HTMLElement} root - Container-Element
 * @param {string} prefix - ID-Prefix
 * @returns {{ is_recurring: boolean, recurrence_rule: string|null,
 *            recurrence_from_completion: boolean, valid_until: boolean }}
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
  // Der nur GEZEIGTE Starttag (`data-implied`, #1607) ist keine Wahl und
  // erzeugt kein BYDAY: sonst schriebe jedes Speichern eine Bestandsserie um.
  root.querySelectorAll(`#${prefix}-rrule-weekdays .rrule-day--active:not([data-implied])`).forEach(btn => {
    byday.push(btn.dataset.day);
  });

  const lastDay = !!root.querySelector(`#${prefix}-rrule-last-day`)?.checked;

  const built = buildRRule({ freq, interval, byday, until, count, lastDay });

  // WER NICHTS ÄNDERT, ÄNDERT NICHTS: Dieses Formular kennt nur einen Ausschnitt
  // von RFC 5545 (FREQ, INTERVAL, BYDAY, UNTIL, COUNT). Eine aus einem
  // Fremdkalender eingelesene Serie trägt oft mehr - WKST, BYMONTHDAY, BYSETPOS.
  // Aus den Feldern neu gebaut ginge dieser Rest beim Speichern verloren, obwohl
  // der Nutzer nur die Zuweisung geändert hat: aus „jeder dritte Donnerstag"
  // würde stillschweigend „jeden Monat" (#756). Deshalb der Vergleich gegen die
  // Ausgangsregel durch dieselbe Übersetzung: Stimmt der Formularstand mit dem
  // überein, was das Original in diese Oberfläche übersetzt, hat niemand an der
  // Wiederholung gedreht - dann geht die Regel im Wortlaut zurück.
  // Eine bewusst geleerte Wiederholung (built === null) fällt nicht darunter.
  const source = root.querySelector(`#${prefix}-rrule-source`)?.value || '';
  const rule = (built && source && buildRRule(parseRRule(source)) === built) ? source : built;

  // Ohne Regel ist der Anker bedeutungslos: sonst bliebe der Schalter an einer
  // Aufgabe hängen, die gar nicht mehr wiederkehrt, und käme beim nächsten
  // Einschalten der Wiederholung ungefragt zurück.
  const fromCompletion = !!rule
    && !!root.querySelector(`#${prefix}-rrule-from-completion`)?.checked;
  return {
    is_recurring:    !!rule,
    recurrence_rule: rule,
    recurrence_from_completion: fromCompletion,
    // UNTIL nur validieren, wenn "Am Datum" gewählt ist (sonst irrelevant).
    valid_until:     endMode !== 'until' || isDateInputValid(untilRaw),
  };
}
