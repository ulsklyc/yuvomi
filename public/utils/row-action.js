/**
 * Modul: Zeilenaktion - der EINE Knopf fuer Bearbeiten/Loeschen/Mehr an einer Zeile.
 *
 * WARUM EIN HELFER UND NICHT NUR DIE KLASSE: `.row-action` (layout.css) gibt es
 * seit dem Audit F1, und trotzdem zaehlte die Critique vom 2026-09-26 allein im
 * Budget vier Stile (grau randlos, violett umrandet `btn--secondary btn--icon`,
 * eine eigene Stiftzelle, ein Trichter-Kreis) und app-weit 36 Eigenbauten. Die
 * Klasse sagt, wie der Knopf AUSSIEHT; was jedes Mal fehlte, waren die drei
 * Dinge, die man pro Aufruf vergisst:
 *   1. `type="button"` - in einem Formular ist ein Knopf ohne Typ ein Submit;
 *   2. der Screenreader-Name MIT Objekt - zwoelf Zeilen, die alle "Anrufen"
 *      heissen, sind fuer Sam eine Zeile ("Anna anrufen", "Kategorie Obst
 *      loeschen"); deshalb ist `label` Pflicht und soll das Objekt nennen
 *      (`t('common.deleteNamed', { name })`);
 *   3. das Icon mit `aria-hidden`, damit der Name nicht doppelt gelesen wird.
 *
 * Kanon und Ratchet: DESIGN.md "Komponenten-Kanon", test:control-dialect.
 * Nach dem Einfuegen wie ueberall `lucide.createIcons({ el })`.
 */

import { esc } from '/utils/html.js';
import { popoverMenuHtml } from '/utils/popover-menu.js';

const TONES = new Set(['danger', 'success']);

function attrsHtml(attrs) {
  return Object.entries(attrs)
    .filter(([, value]) => value !== false && value != null)
    .map(([name, value]) => (value === true ? ` ${name}` : ` ${name}="${esc(String(value))}"`))
    .join('');
}

function className(tone, extra) {
  return ['row-action', TONES.has(tone) ? `row-action--${tone}` : '', extra].filter(Boolean).join(' ');
}

/**
 * Zeilenaktion als HTML-String (fuer insertAdjacentHTML / Template-Literals).
 *
 * @param {object} opts
 * @param {string} opts.icon          Lucide-Name (pencil, trash-2, ellipsis, phone ...)
 * @param {string} opts.label         Name MIT Objekt, schon uebersetzt - wird escaped
 * @param {string} [opts.action]      data-action
 * @param {'danger'|'success'} [opts.tone]
 * @param {string} [opts.className]   zusaetzliche Klasse(n), z. B. `popover-menu__trigger`
 * @param {Record<string, string|number|boolean|null>} [opts.attrs] weitere Attribute (data-id, aria-haspopup ...), escaped
 * @param {string} [opts.href]        rendert ein `<a>` statt `<button>` (Anrufen, Mail)
 * @returns {string}
 */
export function rowActionHtml({ icon, label, action = '', tone = '', className: extra = '', attrs = {}, href = '' } = {}) {
  const cls = className(tone, extra);
  const common = attrsHtml({ class: cls, 'data-action': action || null, 'aria-label': label, ...attrs });
  const glyph = `<i data-lucide="${esc(icon)}" aria-hidden="true"></i>`;
  if (href) return `<a${common} href="${esc(href)}">${glyph}</a>`;
  return `<button type="button"${common}>${glyph}</button>`;
}

/**
 * Zeilenaktion als DOM-Element (fuer Seiten, die per DOM-API bauen).
 * Parameter wie `rowActionHtml`, dazu `onClick`.
 *
 * @returns {HTMLButtonElement|HTMLAnchorElement}
 */
export function rowActionEl({ icon, label, action = '', tone = '', className: extra = '', attrs = {}, href = '', onClick } = {}) {
  const el = document.createElement(href ? 'a' : 'button');
  if (href) el.href = href;
  else el.type = 'button';
  el.className = className(tone, extra);
  if (action) el.dataset.action = action;
  el.setAttribute('aria-label', label);
  for (const [name, value] of Object.entries(attrs)) {
    if (value === false || value == null) continue;
    el.setAttribute(name, value === true ? '' : String(value));
  }
  const glyph = document.createElement('i');
  glyph.dataset.lucide = icon;
  glyph.setAttribute('aria-hidden', 'true');
  el.appendChild(glyph);
  if (onClick) el.addEventListener('click', onClick);
  return el;
}

/**
 * DER MEHR-KNOPF EINER ZEILE (Entscheidung Ulas 2026-10-07, DESIGN.md
 * "Zeilenaktionen").
 *
 * Eine Zeile zeigt HOECHSTENS ZWEI Icon-Aktionen dauerhaft. Alles Weitere und
 * alles Destruktive steht hinter diesem einen, dauerhaft sichtbaren Knopf -
 * als Eintrag mit Icon UND Wort. Bis dahin stand in jeder Zeile ein
 * Papierkorb (Einkauf: Griff, Stift, Papierkorb; Schichtplan: zwei
 * Textkapseln, eine davon rot umrandet), und die lauteste Farbe jeder Liste
 * gehoerte der seltensten Handlung.
 *
 * Nichts wird versteckt: der Knopf steht immer da (kein Hover, keine Geste),
 * das Menue ist das geteilte `popover-menu` (Esc, Pfeiltasten, Fokusrueckgabe
 * an den Ausloeser). Die Eintraege tragen `data-action`/`data-id`/`attrs` wie
 * die Knoepfe, die sie ersetzen - der delegierte Handler der Seite bleibt.
 * Verdrahtung: `installPopoverMenus(root)` einmal an der Seitenwurzel.
 *
 * @param {object} opts
 * @param {string} opts.id      eindeutige Panel-ID je Zeile
 * @param {string} opts.label   Name MIT Objekt (`t('common.moreActionsNamed', { name })`)
 * @param {Array}  opts.items   Eintraege wie bei `popoverMenuHtml`; leere/falsche fallen heraus
 * @param {string} [opts.className] zusaetzliche Klasse(n) am Ausloeser
 * @returns {string} leer, wenn kein Eintrag bleibt
 */
export function rowMenuHtml({ id, label, items = [], className: extra = '' } = {}) {
  const entries = items.filter(Boolean);
  if (!entries.length) return '';
  return popoverMenuHtml({
    id,
    label,
    items: entries,
    triggerClass: ['row-action', 'row-action--more', extra].filter(Boolean).join(' '),
  });
}
