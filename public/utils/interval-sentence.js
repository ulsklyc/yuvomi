/**
 * EIN INTERVALL IST EIN SATZ (Critique R24 G1-Schichtplan-P2-3 / Bausteine (4)).
 *
 * Drei Module fragten denselben Abstand auf drei Arten ab: die Entsorgung mit
 * dem Etikett "Alle N Wochen" ueber einem Stepper (das N stand als Buchstabe
 * im Etikett), die Abos mit "Abrechnungszyklus" als Suchfeld und darunter
 * einem Etikett "Alle" ueber einer nackten 1, die Haushaltshilfe mit
 * "Rhythmus" ueber einem Zahlfeld, dessen Einheit nirgends stand. Jetzt steht
 * das Feld IM Satz: "Alle [2] Wochen", "Alle [1] [Monat]", "Alle [7] Tage".
 *
 * Die Wortstellung kommt aus der Sprache, nicht aus dem Code: der Satz ist ein
 * Locale-Text mit `{{count}}` (ja "{{count}}週間ごと", hu "Minden {{count}}.
 * héten"), an dessen Stelle das Feld tritt.
 *
 * DER SATZ FOLGT DER ZAHL (R24 S4, Frage F1, Ulas 28.10.). Bei 1 las er "Alle 1
 * Wochen" - und 1 ist der haeufigste Wert (Abo monatlich, Tonne woechentlich).
 * Die Saetze tragen jetzt Pluralvarianten (`_one`, dazu `_few`/`_many`/`_two`,
 * wo die Sprache sie braucht), die Wahl trifft Intl.PluralRules wie in t(),
 * und der Satz wird beim Tippen neu gesetzt: ein Listener am Dokument, damit
 * kein Aufrufer ihn verdrahten muss. Das Feld bleibt auch bei 1 stehen (kein
 * "Jede Woche" ohne Feld - das Feld verschwaende beim Tippen, das Layout
 * spraenge).
 *
 * MIT EINHEITEN-WAHL (Abos): die Einheit ist Teil des Satzes, keine eigene
 * Vokabel. Die Optionen lesen ihr Wort aus DEMSELBEN Satz der Einheit
 * (`common.everyNDays|Weeks|Months|Years`, der Teil hinter der Zahl), und der
 * Teil vor der Zahl kommt aus dem Satz der gewaehlten Einheit - so stimmt auch
 * das Geschlecht ("Tous les [2] jours", "Toutes les [2] semaines").
 */
import { t, getLocale } from '/i18n.js';
import { esc } from '/utils/html.js';

const PLACEHOLDER = '{{count}}';

/** Satz je Einheit eines Abo-Zyklus (server: billing_cycle). */
export const UNIT_SENTENCE_KEYS = Object.freeze({
  daily: 'common.everyNDays',
  weekly: 'common.everyNWeeks',
  monthly: 'common.everyNMonths',
  yearly: 'common.everyNYears',
});

function pluralCategory(count) {
  try {
    return new Intl.PluralRules(getLocale()).select(count);
  } catch {
    return 'other';
  }
}

/**
 * Der Satz fuer diese Anzahl, mit `{{count}}` noch darin. Dieselbe Reihenfolge
 * wie t(): Variante der Kategorie, dann `_other`, dann der Basisschluessel.
 * Ohne gueltige Anzahl (leeres Feld) bleibt es beim Basisschluessel.
 */
function sentenceTemplate(key, count) {
  const n = Number(count);
  if (Number.isInteger(n) && n > 0) {
    for (const candidate of [`${key}_${pluralCategory(n)}`, `${key}_other`]) {
      const text = t(candidate);
      if (text !== candidate) return text;
    }
  }
  return t(key);
}

/**
 * Vor der Zahl, ein Anhaengsel AN der Zahl ("2." im Ungarischen und
 * Norwegischen, "2:e" im Schwedischen) und der Rest dahinter.
 */
export function sentenceParts(key, count) {
  const text = sentenceTemplate(key, count);
  const at = text.indexOf(PLACEHOLDER);
  if (at < 0) return { before: text.trim(), suffix: '', after: '' };
  const rest = text.slice(at + PLACEHOLDER.length);
  const [, suffix = '', after = rest] = /^([.:][^\s]*)?\s*([\s\S]*)$/.exec(rest) ?? [];
  return { before: text.slice(0, at).trim(), suffix, after: after.trim() };
}

const wordHtml = (text, role = '') => (text
  ? `<span class="interval-sentence__word"${role ? ` data-interval-part="${role}"` : ''}>${esc(text)}</span>`
  : '');

/**
 * @param {object} opts
 * @param {string} [opts.key]       Locale-Schluessel des Satzes mit `{{count}}`
 *                                  (`common.everyNDays|Weeks|Months|Years`)
 * @param {object} [opts.units]     statt `key`: die Einheit ist eine Wahl am Satzende
 *                                  (Abos) - `{ id, options: ['daily', ...], selected, labelledBy }`
 * @param {string} opts.countHtml   das Zahlfeld (oder der Stepper), fertiges Markup
 * @param {number|string} [opts.count]  Startwert des Felds - waehlt die Form des Satzes
 * @param {string} opts.labelledBy  id der sichtbaren Beschriftung der Gruppe
 * @param {string} [opts.className]
 * @returns {string}
 */
export function intervalSentenceHtml({ key = '', units = null, countHtml, count, labelledBy, className = '' }) {
  const unitKey = units ? (UNIT_SENTENCE_KEYS[units.selected] ?? UNIT_SENTENCE_KEYS[units.options?.[0]]) : key;
  const { before, suffix, after } = sentenceParts(unitKey, count);
  const tail = units
    ? `<select class="form-input" id="${esc(units.id)}" aria-labelledby="${esc(units.labelledBy ?? labelledBy)}">${
      (units.options ?? []).filter((unit) => UNIT_SENTENCE_KEYS[unit]).map((unit) => `<option value="${esc(unit)}"${unit === units.selected ? ' selected' : ''}>${esc(sentenceParts(UNIT_SENTENCE_KEYS[unit], count).after)}</option>`).join('')
    }</select>`
    : wordHtml(after, 'after');
  const data = units ? ' data-interval-units' : ` data-interval-key="${esc(key)}"`;
  return `<div class="interval-sentence${className ? ` ${esc(className)}` : ''}" role="group" aria-labelledby="${esc(labelledBy)}"${data}>`
    + wordHtml(before, 'before') + countHtml + wordHtml(suffix, 'suffix') + tail
    + '</div>';
}

/** Das Zahlfeld der Gruppe - direkt oder im Stepper. */
function countInput(group) {
  return group.querySelector('input[type="number"], input[inputmode="numeric"]');
}

function setWord(group, role, text, anchor, where) {
  let el = group.querySelector(`:scope > [data-interval-part="${role}"]`);
  if (!text) { el?.remove(); return; }
  if (!el) {
    el = document.createElement('span');
    el.className = 'interval-sentence__word';
    el.dataset.intervalPart = role;
    anchor?.[where]?.(el);
  }
  if (el.textContent !== text) el.textContent = text;
}

/**
 * Setzt die Woerter um das bestehende Feld neu - fuer die aktuelle Zahl und,
 * mit Einheiten-Wahl, fuer die gewaehlte Einheit. Das Feld und die Wahl
 * bleiben dieselben Elemente (Fokus, Cursor und Wert bleiben stehen).
 *
 * @param {Element} group  das `.interval-sentence`
 */
export function refreshIntervalSentence(group) {
  if (!group) return;
  const input = countInput(group);
  const field = input ? [...group.children].find((el) => el === input || el.contains(input)) : null;
  if (!field) return;
  const count = input.value;
  const select = group.matches('[data-interval-units]') ? group.querySelector(':scope > select') : null;
  const key = select ? UNIT_SENTENCE_KEYS[select.value] : group.dataset.intervalKey;
  if (!key) return;
  const { before, suffix, after } = sentenceParts(key, count);
  setWord(group, 'before', before, field, 'before');
  setWord(group, 'suffix', suffix, field, 'after');
  if (select) {
    for (const option of select.options) {
      const unitKey = UNIT_SENTENCE_KEYS[option.value];
      if (!unitKey) continue;
      const label = sentenceParts(unitKey, count).after;
      if (option.textContent !== label) option.textContent = label;
    }
  } else {
    const suffixEl = group.querySelector(':scope > [data-interval-part="suffix"]');
    setWord(group, 'after', after, suffixEl ?? field, 'after');
  }
}

/**
 * Tauscht den Satz um ein bestehendes Feld (die Entsorgung wechselt zwischen
 * Wochen und Monaten, waehrend das Feld seinen Wert behaelt).
 *
 * @param {Element} group  das `.interval-sentence`
 * @param {string} key
 */
export function setIntervalSentenceKey(group, key) {
  if (!group) return;
  group.dataset.intervalKey = key;
  refreshIntervalSentence(group);
}

// Beim Tippen (und beim Stepper, der `input` ausloest) und beim Wechsel der
// Einheit: EIN Listener fuer jeden Satz der App, auch fuer Dialoge, die erst
// spaeter gebaut werden.
if (typeof document !== 'undefined' && document.addEventListener) {
  const onChange = (event) => {
    const group = event.target?.closest?.('.interval-sentence');
    if (group) refreshIntervalSentence(group);
  };
  document.addEventListener('input', onChange);
  document.addEventListener('change', onChange);
}
