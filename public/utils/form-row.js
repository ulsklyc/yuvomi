/**
 * Modul: Formularzeile - der EINE Baustein fuer gruppierte Formularzeilen.
 *
 * ENTSCHEIDUNG (Ulas, 2026-10-07, DESIGN.md "Formularzeile"): Erfassungsdialoge
 * und Einstellungen sprechen die Form, die Apples Einstellungen und Formulare
 * fuehren - ein Traeger mit Haarlinien, darin Zeilen mit dem ETIKETT LINKS und
 * dem WERT RECHTS. Bis dahin stand in den Dialogen jedes Feld als vollbreiter
 * Kasten unter seinem Etikett: "Messwert erfassen" zeigte den Blutdruck als
 * drei gleich breite Kaesten ohne Einheit, und in den Einstellungen sass jede
 * Auswahl als 143 bis 360px breiter Kasten mit Kontur am Zeilenende.
 *
 * WAS DER BAUSTEIN IST:
 *   Traeger   `.form-rows`      Zeilen, getrennt durch Haarlinien (Zeile-in-
 *                               Karte nach dem Kasten-in-Kasten-Vokabular:
 *                               keine eigene Flaeche, keine eigene Kante).
 *   Zeile     `.form-row`       Etikett links, Bedienelement rechts; ein
 *                               Hinweis nur zu dieser Zeile laeuft darunter
 *                               ueber die volle Breite.
 *   Auswahl   ein `select.form-input` in der Zeile ist RANDLOS: der Wert in
 *                               Sekundaerfarbe, dahinter das Zeichen
 *                               (--field-chevron), das die 3:1 als
 *                               Erkennungsmerkmal traegt (WCAG 1.4.11).
 *   Datum     `yuvomi-datepicker` in der Zeile steht als Wert, rechtsbuendig.
 *   Paar      `formCompositeHtml()` - mehrere Teilfelder mit Trenner und
 *                               Einheit ("120 / 80 mmHg").
 *   Schalter  `toggleRowHtml({ control: 'switch' })` (settings/components.js)
 *                               IST schon eine Zeile dieses Traegers.
 *
 * WAS ER NICHT IST: ein Feld fuer Freitext. Titel, Notiz und Beschreibung
 * bleiben eigene Felder OHNE Zeilenraster (`.form-input`, Etikett darueber
 * oder als Platzhalter) - eine Notiz hat keinen "Wert rechts".
 *
 * ER BAUT AUF DER EINSTELLUNGSZEILE AUF, NICHT DANEBEN: `settingRowHtml()` und
 * `createSettingRow()` (settings/components.js) rufen `formRowHtml()` bzw.
 * tragen dieselben Klassen; `.settings-setting-row` ist seither eine
 * `.form-row` mit den Massen ihres Blatts. Die Regeln der randlosen Auswahl
 * stehen EINMAL (layout.css, Abschnitt "Formularzeile").
 *
 * ZUGAENGLICHKEIT:
 *   - Jedes Bedienelement behaelt ein programmatisch verknuepftes Etikett:
 *     `labelFor` macht das Etikett zum `<label for>`; ohne es traegt das
 *     Etikett `labelId` fuer das `aria-labelledby` einer Gruppe.
 *   - Ein Paar ist eine `role="group"` mit dem Zeilenetikett als Namen; jedes
 *     Teilfeld traegt seinen EIGENEN Namen (`aria-label`), die Einheit haengt
 *     als Beschreibung am letzten Teilfeld. Der Trenner ist Dekor.
 *   - Lange Etiketten (24 Sprachen) brechen um, der Wert bleibt einzeilig; ist
 *     der Traeger schmaler als 20rem, stapelt die Zeile (Container Query,
 *     layout.css). Ohne Container Queries bleibt sie zweispaltig.
 *
 * Texte (`label`, `description`, Einheit, Trenner, Namen) laufen durch
 * `esc()`; `control` und `extra` sind Markup des Aufrufers.
 */

import { esc } from '/utils/html.js';

function attrsHtml(attrs) {
  return Object.entries(attrs ?? {})
    .filter(([, value]) => value !== false && value != null)
    .map(([name, value]) => (value === true ? ` ${name}` : ` ${name}="${esc(String(value))}"`))
    .join('');
}

const classes = (...names) => names.filter(Boolean).join(' ');

/**
 * Der Traeger: Zeilen untereinander, Haarlinie dazwischen.
 *
 * @param {string|string[]} rows  Markup der Zeilen (`formRowHtml`, `toggleRowHtml`)
 * @param {object} [options]
 * @param {string} [options.className]
 * @param {Record<string, string|number|boolean|null>} [options.attrs]
 * @returns {string}
 */
export function formRowsHtml(rows, { className = '', attrs = {} } = {}) {
  const body = Array.isArray(rows) ? rows.filter(Boolean).join('') : String(rows ?? '');
  return `<div class="${classes('form-rows', className)}"${attrsHtml(attrs)}>${body}</div>`;
}

/**
 * Die Zeile: Etikett links, Bedienelement rechts.
 *
 * @param {object} options
 * @param {string} options.label
 * @param {string|null} [options.labelFor]  id des Bedienelements - dann ist das Etikett ein `<label for>`
 * @param {string|null} [options.labelId]   id am Etikett, fuer `aria-labelledby` einer Gruppe
 * @param {string} [options.labelExtra]     Markup hinter dem Etikett (Pflichtstern) - Markup des Aufrufers
 * @param {string} [options.description]    Sekundaerzeile, betrifft nur diese Zeile
 * @param {string|null} [options.descriptionId]
 * @param {string} [options.control]        Markup des Bedienelements
 * @param {string} [options.extra]          Markup unter dem Text (Fehlerzeile, Zusatzhinweis)
 * @param {boolean} [options.stacked]       Bedienelement UNTER dem Text (Segmente, Chip-Gruppen)
 * @param {boolean} [options.wide]          breites Bedienelement (Datum mit Uhrzeit): stapelt schon unter 26rem
 * @param {boolean} [options.field]         die Zeile ist die Fehlergruppe ihres Feldes (`.form-field`,
 *                                          components/modal.js `reportFieldError`) - Standard in Dialogen
 * @param {string} [options.variant]        zweite Klassenfamilie NEBEN `form-row`, z. B.
 *                                          `settings-setting-row` (settings/components.js)
 * @param {string} [options.className]
 * @param {Record<string, string|number|boolean|null>} [options.attrs]
 * @returns {string}
 */
export function formRowHtml({
  label,
  labelFor = null,
  labelId = null,
  labelExtra = '',
  description = '',
  descriptionId = null,
  control = '',
  extra = '',
  stacked = false,
  wide = false,
  field = false,
  variant = '',
  className = '',
  attrs = {},
} = {}) {
  // Die Variante steht VORN: ihre Klasse ist der Name, unter dem das Blatt die
  // Zeile schon kennt (`.settings-setting-row`); `form-row` kommt dazu.
  const part = (name) => classes(variant && `${variant}${name}`, `form-row${name}`);
  const rowClass = classes(
    variant,
    variant && stacked && `${variant}--stacked`,
    'form-row',
    stacked && 'form-row--stacked',
    wide && 'form-row--wide',
    field && 'form-field',
    className,
  );
  const text = `${esc(String(label ?? ''))}${labelExtra}`;
  const labelHtml = labelFor
    ? `<label class="${part('__label')}"${attrsHtml({ id: labelId, for: labelFor })}>${text}</label>`
    : `<span class="${part('__label')}"${attrsHtml({ id: labelId })}>${text}</span>`;
  const descriptionHtml = description
    ? `<p class="${part('__description')}"${attrsHtml({ id: descriptionId })}>${esc(String(description))}</p>`
    : '';
  return `<div class="${rowClass}"${attrsHtml(attrs)}>`
    + `<div class="${part('__copy')}">${labelHtml}${descriptionHtml}${extra}</div>`
    + `<div class="${part('__control')}">${control}</div>`
    + '</div>';
}

/**
 * Ein ZUSAMMENGESETZTES FELD: Teilfelder mit Trenner und Einheit als Suffix,
 * als EIN Bedienelement der Zeile ("120 / 80 mmHg", "7 Stunden 30 Minuten").
 *
 * Jedes Teilfeld ist ein eigenes `<input>` mit eigener `id` und eigenem Namen -
 * was die Seite liest (`#vital-sys`, `#vital-dia`), aendert sich nicht. Die
 * Gruppe heisst wie die Zeile (`labelledBy`).
 *
 * @param {object} options
 * @param {string} [options.labelledBy]  id des Zeilenetiketts - macht aus dem Paar eine benannte Gruppe
 * @param {Array<
 *   { id: string, label: string, value?: string|number|null, placeholder?: string|number|null,
 *     suffix?: string, suffixIsLabel?: boolean, attrs?: Record<string, string|number|boolean|null> }
 *   | { separator: string }
 * >} options.parts
 *        `label` ist der zugaengliche Name des Teilfelds; ohne `label` traegt
 *        das Zeilenetikett ihn (`labelFor` der Zeile). `suffix` steht als
 *        Einheit dahinter und beschreibt das Feld (`aria-describedby`); mit
 *        `suffixIsLabel` IST der Suffix das sichtbare Etikett (`<label for>`,
 *        "Stunden") und `label` entfaellt als `aria-label`.
 * @param {string} [options.unit]      Einheit hinter dem ganzen Paar ("mmHg")
 * @param {string} [options.className]
 * @returns {string}
 */
export function formCompositeHtml({ labelledBy, parts = [], unit = '', className = '' } = {}) {
  const inputs = parts.filter((part) => part && !part.separator);
  const unitId = unit && inputs.length ? `${inputs[inputs.length - 1].id}-unit` : null;
  const body = parts.filter(Boolean).map((part) => {
    if (part.separator != null) {
      return `<span class="form-composite__sep" aria-hidden="true">${esc(String(part.separator))}</span>`;
    }
    const suffixId = part.suffix ? `${part.id}-suffix` : null;
    const isLast = part === inputs[inputs.length - 1];
    const describedBy = [part.attrs?.['aria-describedby'], !part.suffixIsLabel && suffixId, isLast && unitId]
      .filter(Boolean).join(' ') || null;
    const input = `<input class="form-input form-composite__part"${attrsHtml({
      type: 'text',
      ...part.attrs,
      id: part.id,
      'aria-label': part.suffixIsLabel ? null : (part.label ?? null),
      'aria-describedby': describedBy,
      placeholder: part.placeholder ?? null,
      value: part.value ?? null,
    })}>`;
    if (!part.suffix) return input;
    return part.suffixIsLabel
      ? `${input}<label class="form-composite__unit" for="${esc(part.id)}">${esc(String(part.suffix))}</label>`
      : `${input}<span class="form-composite__unit" id="${esc(suffixId)}">${esc(String(part.suffix))}</span>`;
  }).join('');
  const unitHtml = unit ? `<span class="form-composite__unit" id="${esc(unitId)}">${esc(String(unit))}</span>` : '';
  // Eine Gruppe nur, wo es etwas zu gruppieren gibt: ein einzelnes Teilfeld
  // mit Einheit (Puls) traegt seinen Namen selbst.
  const group = labelledBy ? attrsHtml({ role: 'group', 'aria-labelledby': labelledBy }) : '';
  return `<span class="${classes('form-composite', className)}"${group}>${body}${unitHtml}</span>`;
}
