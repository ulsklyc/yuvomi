/**
 * Page Composition System helpers (PAGE-COMPOSITION.md).
 *
 * Modules provide content; core owns page geometry. Use these exports to build
 * Page → PageHeader + PageBody → Section markup without local width/padding hacks.
 *
 * Reference demo: public/pages/birthdays.js (mode reading, narrow header).
 *
 * JEDER ATTRIBUT-WERT GEHT DURCH esc(), AUCH id UND className. Diese Helfer
 * sind die zugesagte Oberflaeche fuer Erweiterungen (MODULES.md), und eine id
 * aus einem Datensatz (`sec-${item.name}`) ist der erwartete Gebrauch der
 * Option. Die erste Fassung ersetzte nur das Anfuehrungszeichen in
 * Attribut-WERTEN; id, Klassenname und Attribut-Schluessel gingen roh in den
 * String - ein `"` darin verliess das Attribut.
 *
 * EIN ATTRIBUT-SCHLUESSEL WIRD GEPRUEFT, NICHT ESCAPED. Er steht ausserhalb
 * der Anfuehrungszeichen, und dort beenden Leerzeichen und `=` den Namen -
 * Zeichen, die esc() gar nicht kennt. `esc('x onclick=f() y')` kommt
 * unveraendert zurueck und wird zu drei Attributen, eines davon lebendig
 * (Codex + claude-review, vierte Runde an #995 - die zweite Fassung hatte
 * den Schluessel durch esc() gezogen und einen Test mit einem `"`-Payload
 * daneben, der genau deshalb gruen blieb). Ein Schluessel, der kein
 * Attributname ist, ist ein Programmierfehler des Aufrufers und wirft, wie
 * ein unbekannter Modus. Slot-Inhalte (title, body, content) bleiben
 * bewusst roh: sie sind Markup, das der Aufrufer schon escaped hat.
 */

import { esc } from './html-escape.js';

const ATTR_NAME = /^[A-Za-z][A-Za-z0-9:_.-]*$/;

function attrName(key) {
  if (!ATTR_NAME.test(key)) {
    throw new Error(`Invalid attribute name: ${JSON.stringify(key)}`);
  }
  return key;
}

export const COMPOSITION_MODES = Object.freeze([
  'reading',
  'data',
  'dashboard',
  'form',
  'split',
  'full',
]);

/**
 * @param {string} mode
 * @param {{ legacyAlias?: boolean }} [opts]
 * @returns {string}
 */
export function compositionModeClass(mode, { legacyAlias = true } = {}) {
  if (!COMPOSITION_MODES.includes(mode)) {
    throw new Error(`Invalid composition mode: ${mode}`);
  }
  // Compat: keep .page-measure--narrow for one release so row-carrier :is() lists
  // and older CSS still resolve. Reference / new pages may pass legacyAlias:false.
  const legacy = legacyAlias && mode === 'reading' ? ' page-measure--narrow' : '';
  return `app-page app-page--${mode}${legacy}`;
}

/**
 * @param {object} opts
 * @param {string} [opts.mode='reading']
 * @param {string} [opts.className='']
 * @param {string} [opts.id='']
 * @param {Record<string, string>} [opts.attrs={}]
 * @param {boolean} [opts.legacyAlias=true]
 * @param {string} [opts.header='']
 * @param {string} [opts.body='']
 * @param {string} [opts.trailing='']
 * @returns {string}
 */
export function renderAppPage({
  mode = 'reading',
  className = '',
  id = '',
  attrs = {},
  legacyAlias = true,
  header = '',
  body = '',
  trailing = '',
} = {}) {
  const classes = [compositionModeClass(mode, { legacyAlias }), esc(className)].filter(Boolean).join(' ');
  const attrParts = [];
  if (id) attrParts.push(`id="${esc(id)}"`);
  for (const [key, value] of Object.entries(attrs)) {
    if (value == null || value === '') continue;
    attrParts.push(`${attrName(key)}="${esc(String(value))}"`);
  }
  const extra = attrParts.length ? ` ${attrParts.join(' ')}` : '';
  return `<div class="${classes}" data-composition="${mode}"${extra}>
${header}${body}${trailing}
</div>`;
}

/**
 * @param {object} opts
 * @param {string} [opts.className='']
 * @param {string} [opts.title='']
 * @param {string} [opts.center='']
 * @param {string} [opts.actions='']
 * @param {string} [opts.bar='']
 * @param {boolean} [opts.wrap=false]
 * @param {boolean} [opts.narrow=true] - ::after spacer pulls the row end to --page-measure;
 *   a no-op in `full`/`split` (their measure is 100%), so the default is safe there
 * @param {boolean} [opts.inGroup=false]
 * @param {boolean} [opts.capped=false]
 * @param {boolean} [opts.stacked=false]
 * @returns {string}
 */
export function renderPageHeader({
  className = '',
  title = '',
  center = '',
  actions = '',
  bar = '',
  wrap = false,
  narrow = true,
  inGroup = false,
  capped = false,
  stacked = false,
  titleTools = false,
} = {}) {
  const classes = [
    'page-toolbar',
    wrap && 'page-toolbar--wrap',
    // Werkzeuge in der Titelzeile (mobil): nur fuer einen Kopf, dessen
    // Werkzeugzeile hoechstens zwei Icon-Knoepfe traegt (DESIGN.md, Kopfregel
    // mobil 1a; layout.css `.page-toolbar--title-tools`).
    titleTools && 'page-toolbar--title-tools',
    narrow && 'page-toolbar--narrow',
    inGroup && 'page-toolbar--in-group',
    capped && 'page-toolbar--capped',
    stacked && 'page-toolbar--stacked',
    esc(className),
  ].filter(Boolean).join(' ');

  // KEIN WRAPPER UM DIE SLOTS, in keiner Kombination von Optionen. Titel,
  // Mitte und Aktionen sind DIREKTE Kinder der Leiste, weil alles, was den
  // Titel sucht, ihn genau dort erwartet: das Absender-Siegel und der
  // Dock-Titel (`:scope > .page-toolbar__title` in ux.js) und die Large-Title-
  // Regeln (`.page-toolbar > .page-toolbar__title` in typography.css). Die
  // erste Fassung legte fuer eine `measured`-Option ohne `narrow` einen
  // Rail-Wrapper um die Slots - eine echte Flex-Box, aber eine, die den Titel
  // zum Enkel macht und damit Siegel und Dock-Titel verschwinden laesst.
  // Runde eins an #995 nahm den Wrapper fuer `narrow` heraus, Runde sechs
  // (Codex) fuer den Rest: die Kombination stand in der Doku, keine Seite
  // nutzte sie, und `display: contents` haette nicht geholfen, Selektoren
  // sehen den DOM, nicht den Boxbaum. Die Kante haelt der ::after-Slot von
  // `narrow`; ohne `narrow` gibt es keine Kante zu halten (`full`/`split`).
  // Ein Guard wird rot, sobald der Klassenname des Wrappers oder seines
  // Modifiers irgendwo unter public/ wieder auftaucht.
  const inner = [title, center, actions, bar].filter(Boolean).join('\n');
  return `<div class="${classes}">\n${inner}\n</div>`;
}

/**
 * @param {string} text
 * @param {object} [opts]
 * @param {string} [opts.className='']
 * @returns {string}
 */
export function renderPageTitle(text, { className = '' } = {}) {
  const cls = ['page-toolbar__title', esc(className)].filter(Boolean).join(' ');
  return `<h1 class="${cls}">${text}</h1>`;
}

/**
 * @param {string} content - inner buttons/controls (already escaped by caller)
 * @param {object} [opts]
 * @param {string} [opts.className='']
 * @returns {string}
 */
export function renderPageActions(content, { className = '' } = {}) {
  const cls = ['page-toolbar__actions', esc(className)].filter(Boolean).join(' ');
  return `<div class="${cls}">\n${content}\n</div>`;
}

/**
 * @param {object} opts
 * @param {string} [opts.className='']
 * @param {string} [opts.content='']
 * @param {string} [opts.id='']
 * @returns {string}
 */
export function renderPageBody({ className = '', content = '', id = '' } = {}) {
  const cls = ['app-page__body', esc(className)].filter(Boolean).join(' ');
  const idAttr = id ? ` id="${esc(id)}"` : '';
  return `<div class="${cls}"${idAttr}>\n${content}\n</div>`;
}

/**
 * @param {object} opts
 * @param {string} [opts.className='']
 * @param {boolean} [opts.bleed=false]
 * @param {boolean} [opts.measure=true]
 * @param {string} [opts.content='']
 * @param {string} [opts.id='']
 * @returns {string}
 */
export function renderPageSection({
  className = '',
  bleed = false,
  measure = true,
  content = '',
  id = '',
} = {}) {
  const cls = [
    'page-section',
    bleed && 'page-section--bleed',
    measure && !bleed && 'page-measure',
    esc(className),
  ].filter(Boolean).join(' ');
  const idAttr = id ? ` id="${esc(id)}"` : '';
  return `<section class="${cls}"${idAttr}>\n${content}\n</section>`;
}

/**
 * @param {object} opts
 * @param {string} [opts.className='']
 * @param {string} [opts.content='']
 * @param {string} [opts.id='']
 * @returns {string}
 */
export function renderListSection({ className = '', content = '', id = '' } = {}) {
  return renderPageSection({
    className: ['page-section--list', className].filter(Boolean).join(' '),
    measure: true,
    content,
    id,
  });
}

/**
 * KPI / summary band capped to the page measure.
 * @param {object} opts
 * @param {string} opts.content
 * @param {string} [opts.className='']
 * @returns {string}
 */
export function renderMetricBand({ content, className = '' } = {}) {
  const cls = ['metric-grid', 'page-measure', esc(className)].filter(Boolean).join(' ');
  return `<div class="${cls}">\n${content}\n</div>`;
}

/**
 * Flaeche mit Spalten (`.page-columns`, layout.css): die Liste links auf dem
 * Lesemass, ab `--layout-split-threshold` eine Seitenspalte bis zur
 * Modulkante. Die Seitenwurzel traegt dazu `app-page--columns` (Container).
 * Ohne `rail` bleibt die Seitenspalte leer und die Liste steht auf derselben
 * Breite wie in den Reitern mit Seitenspalte. `railFirst`: die Seitenspalte
 * steht im DOM (und damit mobil) vor der Liste, am Desktop rechts daneben.
 */
export function renderPageColumns({ main = '', rail = '', railFirst = false, className = '' } = {}) {
  const cls = ['page-columns', railFirst && rail && 'page-columns--rail-first', esc(className)]
    .filter(Boolean).join(' ');
  const mainHtml = `<div class="page-columns__main">\n${main}\n</div>`;
  const railHtml = rail ? `<div class="page-columns__rail">\n${rail}\n</div>` : '';
  return `<div class="${cls}">\n${railFirst ? railHtml + mainHtml : mainHtml + railHtml}\n</div>`;
}
