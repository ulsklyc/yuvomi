/**
 * Modul: Lesezeile - die EINE Zeile einer Leseansicht und der EINE Satz, der
 * sagt, dass ein Tipp sie oeffnet (#1682).
 *
 * WARUM EIN HELFER: `readRowHtml` stand dreimal da - Geburtstage, Einkauf,
 * Vorrat -, jede Kopie mit dem Hinweis auf die anderen. Zwei nahmen `value`
 * und escapten selbst, die dritte nahm `valueHtml` und verliess sich auf den
 * Aufrufer. Die naechste Seite mit Leseansicht (#1265) haette eine vierte
 * Kopie angelegt und sich eine der beiden Signaturen ausgesucht.
 *
 * Das Markup ist das von `detailRowEl()` aus components/detail-view.js - Icon,
 * Beschriftung, Wert -, als Zeichenkette, weil der geteilte Dialog seinen
 * Inhalt als Markup bekommt. Die Gestalt kommt damit aus detail-view.css (in
 * der Shell geladen), nicht aus einer eigenen Regel.
 *
 * DER SICHERE WEG IST DIE VORGABE: `value` ist Text und laeuft durch `esc()`.
 * Fertiges Markup (der Link im Einkauf) muss als `valueHtml` AUSDRUECKLICH
 * benannt werden, und wer beides uebergibt, bekommt einen Fehler statt einer
 * stillen Rangfolge.
 *
 * Nach dem Einfuegen wie ueberall `lucide.createIcons({ el })`.
 */

import { t } from '/i18n.js';
import { esc } from '/utils/html.js';

/**
 * Eine Zeile der Leseansicht als HTML-String (fuer insertAdjacentHTML /
 * Template-Literals). Ohne Wert keine Zeile: ein Strich waere ein Wert, den es
 * nicht gibt.
 *
 * @param {object}  opts
 * @param {string}  opts.icon         Lucide-Name
 * @param {string}  opts.label        Beschriftung, schon uebersetzt - wird escaped
 * @param {string}  [opts.value]      Wert als TEXT - wird escaped (die Vorgabe)
 * @param {string}  [opts.valueHtml]  Wert als FERTIGES Markup - wird NICHT
 *                                    escaped; der Aufrufer hat jede Nutzerangabe
 *                                    darin selbst durch `esc()` geschickt
 * @param {boolean} [opts.multiline]  mehrzeiliger Wert (Notiz)
 * @returns {string}
 */
export function readRowHtml({ icon, label, value, valueHtml, multiline = false } = {}) {
  if (value != null && valueHtml != null) {
    throw new TypeError('readRowHtml: entweder `value` (Text) oder `valueHtml` (fertiges Markup), nicht beides');
  }
  const inner = valueHtml != null ? String(valueHtml) : esc(value == null ? '' : String(value));
  if (!inner.trim()) return '';
  return `
        <div class="detail-row${multiline ? ' detail-row--multiline' : ''}">
          <i class="detail-row__icon" data-lucide="${esc(icon)}" aria-hidden="true"></i>
          <div class="detail-row__text">
            <span class="detail-row__label">${esc(label)}</span>
            <span class="detail-row__value">${inner}</span>
          </div>
        </div>`;
}

/**
 * Was der Tipp auf eine Listenzeile bei Nur-lesen tut - nur fuer
 * Screenreader, als Zusatz am ENDE des Zeilenknopfs. Mit Schreibrecht steht
 * dort „Bearbeiten"; bei `read` fiel der Zusatz weg und nichts ersetzte ihn,
 * die Zeile sagte also nur ihren Inhalt an.
 *
 * Bewusst ein Zusatz und kein `aria-label`: ein Label ueberschriebe den Namen
 * aus dem Inhalt (Status, Menge, Datum) - siehe rowEl() in pages/pantry.js.
 * Das fuehrende Leerzeichen trennt den Satz vom letzten Wort der Zeile, wenn
 * der Name aus lauter Inline-Knoten zusammengesetzt wird.
 *
 * @returns {string}
 */
export function readRowHintHtml() {
  return ` <span class="sr-only">${esc(t('common.showDetails'))}</span>`;
}

/** Derselbe Zusatz als DOM-Knoten (fuer Seiten, die per DOM-API bauen). */
export function readRowHintEl() {
  const hint = document.createElement('span');
  hint.className = 'sr-only';
  hint.textContent = t('common.showDetails');
  return hint;
}

/**
 * Der Name eines EIGENEN Knopfs zur Leseansicht (Icon-Knopf ohne sichtbaren
 * Text, wie im Einkauf): derselbe Satz, mit dem Objekt dahinter - zwoelf
 * Knoepfe, die alle „Details anzeigen" heissen, waeren eine Zeile (siehe
 * utils/row-action.js). Bauart wie der Warenkorb des Vorrats.
 *
 * @param {string} name  Name des Datensatzes, roh - der Aufrufer escaped
 * @returns {string}
 */
export function readDetailsLabel(name) {
  return `${t('common.showDetails')}: ${name}`;
}
