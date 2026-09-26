/**
 * Modul: Komponenten-Kanon - EIN Dialekt fuer Bedienelemente (DESIGN.md
 *        "Komponenten-Kanon", Critique 2026-09-26 P1 "Bedienelemente sprechen
 *        mehrere Dialekte", Runde 5).
 * Zweck: Haelt fest, dass jede Bedienfrage genau EINE Antwort hat, und dass
 *        die heutigen Abweichler nur weniger werden:
 *          row-action          Zeilenaktion = `.row-action` / `.row-action--danger`
 *          row-action-name     ihr Screenreader-Name nennt das Objekt
 *          search-field        Suchfeld = `.page-search__input` (renderPageSearch)
 *          list-rows           Listentraeger = `.row-carrier`; `.list-rows` laeuft aus
 *          floating-fab        Primaeraktion = `page-fab` MIT Nomen (dockt am Desktop an)
 *          body-actions        Dialogknoepfe = `.modal-panel__footer`, nicht `.modal-actions`
 *          cancel-ghost        Abbrechen im Dialog = `btn--secondary`, nie `btn--ghost`
 *          footer-icon-delete  Loeschen im Dialog = Textknopf `btn--danger-outline`
 *          settings-checkbox   Boolean in den Einstellungen = Schalter
 *          dead-i-rule         keine CSS-Regel zielt nur auf `<i>` (Lucide ersetzt es)
 *
 * DAS IST EIN RATCHET, KEINE ALLOWLIST. `PENDING` ist der Bestand vom
 * 2026-09-26 (Datei -> Anzahl). Zwei Tests je Regel:
 *   1. "kein neuer Abweichler": eine Datei darf nicht MEHR Funde haben als ihr
 *      Eintrag (eine nicht gelistete Datei: null). Rot = jemand hat einen neuen
 *      Dialekt gebaut. Das ist der Test, der gruen bleiben muss.
 *   2. "die Ausnahmeliste ist aktuell": eine Datei mit WENIGER Funden als ihr
 *      Eintrag ist rot, bis der Eintrag auf die neue Zahl sinkt bzw. geloescht
 *      wird. Rot heisst hier "dein Fix wirkt" - die Umsetzungsagenten melden
 *      die Zeile an die Integration, statt sie selbst zu streichen.
 * Die Zaehlung ist absichtlich eine ZAHL je Datei, keine Zeilennummer: eine
 * Zeilenliste waere bei jedem Edit oberhalb rot und wuerde "nachgezogen", bis
 * niemand mehr hinsieht.
 *
 * Die Scanner lesen Quelltext (Template-Literals und die DOM-API-Bauart
 * `x.className = '...'`), keinen gerenderten Baum. Sie sind je Regel an einer
 * positiven und einer negativen Probe festgemacht (Abschnitt "Scanner"), damit
 * ein Scanner, der nichts mehr findet, nicht als "alles erledigt" durchgeht.
 * Ausfuehren: node --test test/test-control-dialect.js
 */

import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

import { eachRule } from './css-rules.js';

const REPO = fileURLToPath(new URL('..', import.meta.url));
const PUBLIC = join(REPO, 'public');

function walk(dir, out = []) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === 'vendor' || entry.name === 'locales' || entry.name === 'icons') continue;
      walk(path, out);
    } else {
      out.push(path);
    }
  }
  return out;
}

const ALL_FILES = walk(PUBLIC);
const JS = ALL_FILES
  .filter((f) => f.endsWith('.js') && !f.endsWith('.min.js'))
  .map((f) => ({ file: relative(REPO, f), src: readFileSync(f, 'utf8') }));
const CSS = ALL_FILES
  .filter((f) => f.endsWith('.css'))
  .map((f) => ({ file: relative(REPO, f), src: readFileSync(f, 'utf8') }));

const lineOf = (src, index) => src.slice(0, index).split('\n').length;

/** Steht die Fundstelle in einem Kommentar (Zeile beginnt mit `//`, `*`, `/*` oder `//` davor)? */
function inComment(src, index) {
  const prefix = src.slice(src.lastIndexOf('\n', index - 1) + 1, index);
  return /^\s*(?:\/\/|\*|\/\*)/.test(prefix) || /(?:^|[^:'"`])\/\//.test(prefix);
}

// ---------------------------------------------------------------------------
// Scanner
// ---------------------------------------------------------------------------

/** Icons, die eine Zeilenaktion tragen: Bearbeiten, Loeschen, Mehr. */
const ROW_ICONS = /^(?:pencil|pen|pen-line|square-pen|edit|edit-2|trash|trash-2|ellipsis|more-horizontal|more-vertical|ellipsis-vertical)$/;
/** data-action-Namen einer Zeilenaktion (`delete`, `edit-task`, `remove-type-field`, `sub-rename`). */
const ROW_VERBS = /(?:^|[-_])(?:edit|delete|remove|rename)(?:[-_]|$)/i;

/**
 * Ein Knopf ohne sichtbaren Text: der Inhalt ist nach Abzug der Tags leer. Eine
 * Interpolation zaehlt als Text, sobald sie nach Text aussieht (`t(`, `esc(`,
 * `label`, `name`, `title`) - `${icon}` oder `${cls}` nicht.
 */
function visibleText(body) {
  return body
    .replace(/<[^>]*>/g, '')
    .replace(/\$\{([^{}]|\{[^{}]*\})*\}/g, (s) => (/\bt\(|esc\(|label|name|title|text/i.test(s) ? 'T' : ''))
    .replace(/&nbsp;/g, '')
    .trim();
}

/** Alle Template-Knoepfe (`<button>` und `<a>`) einer Quelle. */
function* templateControls(src) {
  const re = /<(button|a)\b((?:[^>`]|`[^`]*`)*)>([\s\S]*?)<\/\1>/g;
  let m;
  while ((m = re.exec(src))) {
    const [, tag, attrs, body] = m;
    if (body.length > 900 || inComment(src, m.index)) continue;
    const cls = (attrs.match(/\bclass="([^"]*)"/) || [])[1] ?? '';
    const icon = (body.match(/data-lucide="([^"]+)"/) || [])[1] ?? '';
    const action = (attrs.match(/\bdata-action="([^"]*)"/) || [])[1] ?? '';
    const label = (attrs.match(/\baria-label="((?:[^"$]|\$\{(?:[^{}]|\{[^{}]*\})*\})*)"/) || [])[1];
    yield { tag, attrs, body, cls, icon, action, label, index: m.index, iconOnly: !!icon && !visibleText(body) };
  }
}

/** DOM-API-Knoepfe: `x = document.createElement('button')` ... `x.className = '...'` ... Icon. */
function* domButtons(src) {
  const re = /(?:const|let|var)\s+(\w+)\s*=\s*document\.createElement\(\s*['"]button['"]\s*\)/g;
  let m;
  while ((m = re.exec(src))) {
    const name = m[1];
    if (inComment(src, m.index)) continue;
    const rest = src.slice(m.index + m[0].length);
    const next = rest.search(/document\.createElement\(\s*['"]button['"]\s*\)/);
    const scope = next === -1 ? rest.slice(0, 1500) : rest.slice(0, Math.min(next, 1500));
    const cls = (scope.match(new RegExp(`\\b${name}\\.className\\s*=\\s*['"\`]([^'"\`]*)['"\`]`)) || [])[1] ?? '';
    const icon = (scope.match(/(?:dataset\.lucide\s*=\s*|setAttribute\(\s*['"]data-lucide['"]\s*,\s*)['"]([\w-]+)['"]/) || [])[1] ?? '';
    const hasText = new RegExp(`\\b${name}\\.(?:textContent|append\\(\\s*t\\()`).test(scope);
    yield { name, cls, icon, index: m.index, iconOnly: !!icon && !hasText };
  }
}

const isHeadTools = (cls) => /\bpopover-menu__trigger\b/.test(cls) && /-tools\b|tools-btn\b/.test(cls);
const isPhotoOverlay = (cls) => /photo-action|avatar-action/.test(cls);
const isFooterDelete = (cls) => /\bbtn--danger(?![\w-])/.test(cls) && /\bbtn--icon\b/.test(cls);

/**
 * Punkt 1: ein Bedienelement, das Bearbeiten/Loeschen/Mehr an einer ZEILE
 * anbietet und nicht `.row-action` traegt.
 * Nicht gemeint (eigene Regeln oder eigene Grammatik, je mit Grund):
 *  - `popover-menu__item`: Eintrag IM Menue, nicht an der Zeile;
 *  - Kopf-Werkzeugmenue (`*-tools popover-menu__trigger`, Vorbild
 *    `documents-tools-btn`): eine Kopfaktion, keine Zeilenaktion;
 *  - Foto-/Avatar-Overlay (`*-photo-action`, `settings-avatar-action`): die
 *    Aktion liegt auf einem Bild, nicht in einer Zeile;
 *  - Loeschen im Dialogfuss (`btn--danger btn--icon`): Regel footer-icon-delete;
 *  - der FAB und das Schliessen-X des Dialogs.
 */
export function scanRowAction(src) {
  const found = [];
  const judge = ({ cls, icon, action, index, iconOnly }) => {
    if (!iconOnly) return;
    if (!ROW_ICONS.test(icon) && !ROW_VERBS.test(action)) return;
    if (/\brow-action\b/.test(cls) || /\bpopover-menu__item\b/.test(cls)) return;
    if (/\bpage-fab\b|\bmodal-panel__close\b/.test(cls)) return;
    // Benannte Ausnahme (meals.css ueber `.meal-card__action-btn`): bis zu drei
    // Aktionen in einem 148px-Slot, 48px-Knoepfe passen dort nicht; die
    // Trefferflaeche spannt ein ::before auf 40px.
    if (/\bmeal-card__action-btn\b/.test(cls)) return;
    if (isHeadTools(cls) || isPhotoOverlay(cls) || isFooterDelete(cls)) return;
    found.push({ line: lineOf(src, index), what: `${cls || '(ohne Klasse)'} [${icon}${action ? ` ${action}` : ''}]` });
  };
  for (const c of templateControls(src)) judge(c);
  for (const c of domButtons(src)) judge({ ...c, action: '' });
  return found;
}

/**
 * Punkt 1b: eine `.row-action`, deren Name das Objekt nicht nennt - `aria-label`
 * ist genau EIN `t('key')` ohne Parameter und sonst nichts. Zwoelf Zeilen, die
 * alle "Anrufen" heissen, sind fuer einen Screenreader eine Zeile (Persona Sam).
 */
export function scanRowActionName(src) {
  const found = [];
  const BARE = /^\s*\$\{\s*(?:esc\(\s*)?t\(\s*(['"])[\w.]+\1\s*\)\s*\)?\s*\}\s*$/;
  for (const c of templateControls(src)) {
    if (!/\brow-action\b/.test(c.cls)) continue;
    if (c.label === undefined) {
      found.push({ line: lineOf(src, c.index), what: `${c.cls} ohne aria-label` });
    } else if (BARE.test(c.label)) {
      found.push({ line: lineOf(src, c.index), what: `${c.cls} aria-label=${c.label.trim()}` });
    }
  }
  return found;
}

/**
 * Punkt 2: ein Suchfeld, das nicht die geteilte Komponente ist. Die globale
 * Suche (`search-overlay__input`, router.js) zaehlt als Kanon: sie teilt die
 * Regel in page-search.css per Selektorliste, nur ohne Lupe. Template:
 * `<input ... type="search">` ohne `page-search__input`; DOM-API:
 * `x.type = 'search'` ohne `x.className = '...page-search__input...'`.
 */
const CANON_SEARCH = /\b(?:page-search__input|search-overlay__input)\b/;
export function scanSearchField(src) {
  const found = [];
  const re = /<input\b[^>]*\btype="search"[^>]*>/g;
  let m;
  while ((m = re.exec(src))) {
    if (inComment(src, m.index)) continue;
    if (!CANON_SEARCH.test(m[0])) {
      found.push({ line: lineOf(src, m.index), what: (m[0].match(/\b(?:id|class)="[^"]*"/) || ['<input type=search>'])[0] });
    }
  }
  const dom = /\b(\w+)\.type\s*=\s*['"]search['"]/g;
  while ((m = dom.exec(src))) {
    if (inComment(src, m.index)) continue;
    const name = m[1];
    const cls = src.match(new RegExp(`\\b${name}\\.className\\s*=\\s*['"\`]([^'"\`]*)['"\`]`));
    if (!cls || !CANON_SEARCH.test(cls[1])) {
      found.push({ line: lineOf(src, m.index), what: `${name}.type = 'search'${cls ? ` (${cls[1]})` : ''}` });
    }
  }
  return found;
}

/**
 * Punkt 3: `.list-rows` im Markup oder als Selektor im JS (Kommentarzeilen
 * zaehlen nicht). Der Container-NAME `list-rows` (`@container list-rows`)
 * bleibt - `.row-carrier` oeffnet denselben.
 */
export function scanListRowsJs(src) {
  const found = [];
  const lines = src.split('\n');
  lines.forEach((text, i) => {
    if (/^\s*(?:\/\/|\*|\/\*)/.test(text)) return;
    const hits = text.match(/(?:["'`\s.])list-rows(?![\w-])/g);
    if (hits) for (let k = 0; k < hits.length; k += 1) found.push({ line: i + 1, what: text.trim().slice(0, 90) });
  });
  return found;
}

export function scanListRowsCss(src) {
  const found = [];
  for (const rule of eachRule(src)) {
    if (/\.list-rows(?![\w-])/.test(rule.selector)) found.push({ line: 0, what: rule.selector });
  }
  return found;
}

/** Den Argumenttext eines Aufrufs `name(` bis zur passenden Klammer. */
function callArgs(src, openIndex) {
  let depth = 0;
  for (let i = openIndex; i < src.length; i += 1) {
    if (src[i] === '(') depth += 1;
    else if (src[i] === ')') {
      depth -= 1;
      if (depth === 0) return src.slice(openIndex + 1, i);
    }
  }
  return src.slice(openIndex + 1);
}

/**
 * Punkt 4: eine Primaeraktion ohne Nomen. Ohne `dockLabel` dockt der FAB am
 * Desktop nicht an und schwebt unten rechts - bei Kontext-FABs mit einer
 * Bedeutung, die mit dem Tab wechselt, ohne dass der Knopf es sagt.
 *  - `setPageFabAction(fab, {...})` ohne `dockLabel` (ausser reinem `hidden: true`);
 *  - `createPageFab({...})`/`pageFabHtml({...})` ohne `dockLabel`, wenn die Datei
 *    ihn nicht per `setPageFabAction(..., { dockLabel })` nachreicht;
 *  - `class="page-fab"` ohne `data-dock-label`, DOM `x.className = 'page-fab'`
 *    ohne `x.dataset.dockLabel`.
 * Ausnahme mit Grund: die Schnellaktionen des Dashboards (`page-fab-group`,
 * `fab-main`) sind ein Aufklapp-Menue ueber alle Module, keine Primaeraktion
 * EINES Moduls - es gibt kein Nomen, das sie benennt.
 */
export function scanFloatingFab(src) {
  const found = [];
  let m;
  const setters = [];
  const setRe = /\bsetPageFabAction\s*\(/g;
  while ((m = setRe.exec(src))) {
    if (inComment(src, m.index)) continue;
    const args = callArgs(src, m.index + m[0].length - 1);
    if (/export\s+function\s*$/.test(src.slice(src.lastIndexOf('\n', m.index) + 1, m.index))) continue;
    setters.push(args);
    const onlyHidden = /\bhidden\s*:\s*true\b/.test(args) && !/\bonClick\b/.test(args);
    if (!/\bdockLabel\b/.test(args) && !onlyHidden) {
      found.push({ line: lineOf(src, m.index), what: `setPageFabAction ohne dockLabel` });
    }
  }
  const namedLater = setters.some((a) => /\bdockLabel\s*:/.test(a));
  const makeRe = /\b(createPageFab|pageFabHtml)\s*\(/g;
  while ((m = makeRe.exec(src))) {
    const before = src.slice(src.lastIndexOf('\n', m.index) + 1, m.index);
    if (/export\s+function\s*$/.test(before) || inComment(src, m.index)) continue;
    const args = callArgs(src, m.index + m[0].length - 1);
    if (!/\bdockLabel\b/.test(args) && !namedLater) {
      found.push({ line: lineOf(src, m.index), what: `${m[1]} ohne dockLabel` });
    }
  }
  const markupRe = /<button\b[^>]*\bclass="page-fab"[^>]*>/g;
  while ((m = markupRe.exec(src))) {
    if (/\bid="fab-main"/.test(m[0]) || inComment(src, m.index)) continue;
    if (!/\bdata-dock-label=/.test(m[0])) found.push({ line: lineOf(src, m.index), what: 'class="page-fab" ohne data-dock-label' });
  }
  const domRe = /\b(\w+)\.className\s*=\s*['"]page-fab['"]/g;
  while ((m = domRe.exec(src))) {
    if (inComment(src, m.index)) continue;
    if (!new RegExp(`\\b${m[1]}\\.dataset\\.dockLabel\\s*=`).test(src)) {
      found.push({ line: lineOf(src, m.index), what: `${m[1]}.className = 'page-fab' ohne dataset.dockLabel` });
    }
  }
  return found;
}

/**
 * Punkt 5a: Dialogknoepfe in `.modal-actions` im scrollenden Koerper. Nur
 * `.modal-panel__footer` hebt `mountFooter()` (modal.js) an den Rand des
 * Blatts - sonst liegt "Speichern" mobil unter der Falz (Schichtplan y=871).
 * `modal-actions--stack` ist eine Auswahlliste (Serien-Umfang, Ordner-Loeschen),
 * kein Fuss, und zaehlt nicht.
 */
export function scanBodyActions(src) {
  const found = [];
  const re = /class="modal-actions(?:\s[^"]*)?"/g;
  let m;
  while ((m = re.exec(src))) {
    if (/modal-actions--stack/.test(m[0]) || inComment(src, m.index)) continue;
    found.push({ line: lineOf(src, m.index), what: m[0] });
  }
  return found;
}

/**
 * Punkt 5b: "Abbrechen" (`common.cancel`) als `btn--ghost`.
 * ENTSCHIEDEN (2026-09-26, Runde 5): Abbrechen ist `btn--secondary`. Der Brief
 * der Runde nannte ghost; test:frontend-audit haelt seit der Critique
 * 2026-07-30 fuer die drei geteilten Dialoge in modal.js das Gegenteil ("kein
 * Abbrechen darf als Ghost zurueckkommen" - im Loeschen-Confirm am
 * wichtigsten: ein Ghost-Abbrechen neben dem roten Loeschen liest sich wie
 * Text, nicht wie der sichere Ausweg). Der Code schlug den Brief; Abweichler
 * ist deshalb der ghost-Abbrechen.
 */
export function scanCancelGhost(src) {
  const found = [];
  for (const c of templateControls(src)) {
    if (c.tag !== 'button' || !/common\.cancel/.test(c.body)) continue;
    if (/\bbtn--ghost\b/.test(c.cls)) found.push({ line: lineOf(src, c.index), what: c.cls });
  }
  return found;
}

/** Punkt 5c: Loeschen im Dialog als reines Icon (`btn--danger btn--icon`). */
export function scanFooterIconDelete(src) {
  const found = [];
  for (const c of templateControls(src)) {
    if (c.iconOnly && isFooterDelete(c.cls)) found.push({ line: lineOf(src, c.index), what: `${c.cls} [${c.icon}]` });
  }
  for (const c of domButtons(src)) {
    if (c.iconOnly && isFooterDelete(c.cls)) found.push({ line: lineOf(src, c.index), what: `${c.cls} [${c.icon}]` });
  }
  return found;
}

/**
 * Punkt 6: eine Boolean-Einstellung als native Checkbox. In `public/settings/`
 * rendert jede Schalterzeile `toggleRowHtml({ ..., control: 'switch' })`; eine
 * rohe `type="checkbox"` ausserhalb von `.toggle` zaehlt ebenso. Nur fuer die
 * Einstellungen - Filterblaetter (Kalender, Aufgaben) behalten die Haken-Zeile.
 * Benannte Ausnahmen (AUSWAHL aus einer Menge, keine Einstellung - dieselbe
 * Grenze wie bei den Filterblaettern, Entscheidung 2026-09-26):
 *  - `api-token-scopes__cell`: Lesen/Schreiben je Modul in der Scope-Matrix
 *    eines API-Tokens (admin-api.js);
 *  - `reminder-preset`: Standard-Erinnerungen als Mehrfachauswahl-Chips
 *    (personal-calendar.js);
 *  - `backfill-moved__`: Auswahl der verschobenen Termine im Nachtrag-Dialog
 *    samt "alle" (sync-calendar.js).
 */
const SETTINGS_SELECTION = /class="(?:[^"]*\s)?(?:api-token-scopes__cell|reminder-preset|backfill-moved__[\w-]+)(?:\s[^"]*)?"[^<]*$/;
export function scanSettingsCheckbox(src, file) {
  const found = [];
  if (!file.startsWith('public/settings/') || file === 'public/settings/components.js') return found;
  let m;
  const callRe = /\btoggleRowHtml\s*\(/g;
  while ((m = callRe.exec(src))) {
    const before = src.slice(src.lastIndexOf('\n', m.index) + 1, m.index);
    if (inComment(src, m.index) || /import\s*\{/.test(before)) continue;
    const args = callArgs(src, m.index + m[0].length - 1);
    if (!/\bcontrol\s*:\s*['"]switch['"]/.test(args)) found.push({ line: lineOf(src, m.index), what: 'toggleRowHtml ohne control: \'switch\'' });
  }
  const rawRe = /<input\b[^>]*\btype="checkbox"[^>]*>/g;
  while ((m = rawRe.exec(src))) {
    if (inComment(src, m.index)) continue;
    const before = src.slice(Math.max(0, m.index - 160), m.index);
    if (/class="toggle"|class="toggle /.test(before) || /role="switch"/.test(m[0])) continue;
    if (SETTINGS_SELECTION.test(before)) continue;
    found.push({ line: lineOf(src, m.index), what: (m[0].match(/\b(?:id|name|class)="[^"]*"/) || ['<input type=checkbox>'])[0] });
  }
  return found;
}

/**
 * Beifang (Punkt 7): eine CSS-Regel, deren JEDER Selektor auf ein `<i>` zielt.
 * Lucide ersetzt `<i data-lucide>` durch `<svg>` (lucide-scope.js
 * `node.replaceWith(svg)`), die Regel trifft also nie. Regeln mit einem
 * `svg`-Zweig daneben (`.x i, .x svg`) sind keine toten Regeln - der `i`-Zweig
 * deckt den Frame vor `createIcons()` ab.
 * Lebendig und deshalb ausgenommen: `<i>` OHNE data-lucide, das die App selbst
 * als Balken bzw. Farbscheibe rendert (subscriptions.js).
 */
const LIVE_I_RULES = new Map([
  ['.subscriptions-chart-row__track i', 'Balken: <i style="width:..."> in subscriptions.js (Diagrammzeile)'],
  ['.subscriptions-metadata-row__view > i', 'Farbscheibe: <i style="background:..."> in subscriptions.js (Kategorie)'],
]);
const TYPE_I = /(?:^|[\s>+~(])i(?=$|[.:[\s>+~,)])/;
export function scanDeadIRules(css) {
  const found = [];
  for (const rule of eachRule(css)) {
    const parts = rule.selector.split(',').map((s) => s.trim());
    if (!parts.every((p) => TYPE_I.test(p))) continue;
    if (LIVE_I_RULES.has(rule.selector)) continue;
    found.push({ line: 0, what: rule.selector });
  }
  return found;
}

// ---------------------------------------------------------------------------
// Scanner-Proben: jede Regel faengt ihr Beispiel und laesst die Kanonform durch
// ---------------------------------------------------------------------------

test('Scanner: row-action faengt Eigenbau-Zeilenaktionen (Template und DOM) und laesst Kanon, Menue, Kopfwerkzeug und Foto durch', () => {
  const bad = `
    <button class="btn btn--secondary btn--icon" data-action="loan-edit" aria-label="\${t('x')}"><i data-lucide="pencil"></i></button>
    <button class="btn btn--icon btn--danger-outline" data-action="delete" aria-label="\${t('y')}">
      <i data-lucide="trash-2" class="icon-sm" aria-hidden="true"></i>
    </button>
    <button class="budget-account__edit"><i data-lucide="pencil"></i></button>
    <button class="btn btn--secondary btn--icon" data-action="remove-type-field"><i data-lucide="x"></i></button>`;
  const dom = `
    const del = document.createElement('button');
    del.className = 'task-comment__action task-comment__action--danger';
    const i = document.createElement('i');
    i.dataset.lucide = 'trash-2';`;
  assert.equal(scanRowAction(bad).length, 4);
  assert.equal(scanRowAction(dom).length, 1);
  const good = `
    <button type="button" class="row-action row-action--danger" data-action="delete" aria-label="\${t('a', { name })}"><i data-lucide="trash-2"></i></button>
    <button role="menuitem" class="popover-menu__item" data-action="edit-pickup"><i data-lucide="pencil"></i>\${t('common.edit')}</button>
    <button role="menuitem" class="popover-menu__item popover-menu__item--danger" data-action="delete"><i data-lucide="trash-2"></i></button>
    <button class="btn btn--secondary btn--icon documents-tools-btn popover-menu__trigger"><i data-lucide="ellipsis"></i></button>
    <button class="settings-avatar-action settings-avatar-action--danger"><i data-lucide="trash-2"></i></button>
    <button class="btn btn--danger-outline" id="modal-delete"><i data-lucide="trash-2"></i>\${t('common.delete')}</button>
    <button class="page-fab"><i data-lucide="plus"></i></button>`;
  assert.deepEqual(scanRowAction(good), []);
});

test('Scanner: row-action-name faengt den nackten Namen und laesst den Namen mit Objekt durch', () => {
  const bad = `
    <a class="row-action" href="tel:1" aria-label="\${t('contacts.call')}"><i data-lucide="phone"></i></a>
    <button class="row-action row-action--danger" aria-label="\${esc(t('common.delete'))}"><i data-lucide="trash-2"></i></button>
    <button class="row-action"><i data-lucide="pencil"></i></button>`;
  assert.equal(scanRowActionName(bad).length, 3);
  const good = `
    <button class="row-action" aria-label="\${esc(t('common.editNamed', { name: row.name }))}"><i data-lucide="pencil"></i></button>
    <button class="row-action" aria-label="\${esc(u.display_name)} \${t('settings.editMemberLabel')}"><i data-lucide="pencil"></i></button>`;
  assert.deepEqual(scanRowActionName(good), []);
});

test('Scanner: search-field faengt eigene Suchfelder und laesst renderPageSearch durch', () => {
  const bad = `
    <input id="subscriptions-search" type="search" placeholder="x">
    const input = document.createElement('input');
    input.type = 'search';
    input.className = 'settings-nav__search';`;
  assert.equal(scanSearchField(bad).length, 2);
  const good = `
    <input type="search" id="\${esc(id)}" class="page-search__input" placeholder="x">
    const q = document.createElement('input');
    q.type = 'search';
    q.className = 'page-search__input';`;
  assert.deepEqual(scanSearchField(good), []);
});

test('Scanner: list-rows zaehlt Markup und Selektor, nicht Kommentar und nicht den Container-Namen', () => {
  const bad = `
    rows.className = 'list-rows pantry-rows';
    const el = group.querySelector('.list-rows');
    return \`<div class="list-rows">\${x}</div>\`;`;
  assert.equal(scanListRowsJs(bad).length, 3);
  assert.deepEqual(scanListRowsJs(`  // .list-rows traegt die Flaeche\n  <div class="row-carrier">`), []);
  assert.equal(scanListRowsCss('.list-rows > * + * { border-top: 0; } @container list-rows (min-width: 1px) { .x { color: red; } }').length, 1);
});

test('Scanner: floating-fab faengt die Primaeraktion ohne Nomen und laesst den Kontext-FAB mit Nomen durch', () => {
  const bad = `
    _fab = createPageFab({ id: 'health-fab' });
    setPageFabAction(_fab, { label: t('a'), onClick: () => open() });
    <button class="page-fab" id="fab-x" aria-label="y">`;
  assert.equal(scanFloatingFab(bad).length, 3);
  const good = `
    fab = createPageFab({ id: 'x-fab' });
    setPageFabAction(fab, { label: t('a'), dockLabel: t('newLabel.a'), onClick: () => open() });
    setPageFabAction(fab, { hidden: true });
    <button class="page-fab" id="fab-y" aria-label="y" data-dock-label="\${t('newLabel.y')}">
    <button type="button" class="page-fab" id="fab-main" aria-label="q">`;
  assert.deepEqual(scanFloatingFab(good), []);
});

test('Scanner: Dialogregeln faengen Koerper-Knopfzeile, Abbrechen als ghost und Icon-Loeschen', () => {
  const src = `
    <div class="modal-actions"><button type="submit" class="btn btn--primary">\${t('common.save')}</button></div>
    <div class="modal-actions modal-actions--stack"></div>
    <button type="button" class="btn btn--secondary" data-action="close-modal">\${t('common.cancel')}</button>
    <button type="button" class="btn btn--ghost" data-action="close-modal">\${t('common.cancel')}</button>
    <button class="btn btn--danger btn--icon" id="wtm-delete" aria-label="\${t('x')}"><i data-lucide="trash-2"></i></button>
    <button class="btn btn--danger-outline" id="modal-delete"><i data-lucide="trash-2"></i>\${t('common.delete')}</button>`;
  assert.equal(scanBodyActions(src).length, 1);
  assert.deepEqual(scanCancelGhost(src).map((f) => f.what), ['btn btn--ghost']);
  assert.equal(scanFooterIconDelete(src).length, 1);
});

test('Scanner: settings-checkbox gilt nur in den Einstellungen und laesst den Schalter durch', () => {
  const src = `
    \${toggleRowHtml({ label: t('a'), checked: true })}
    \${toggleRowHtml({ label: t('b'), control: 'switch' })}
    <input type="checkbox" id="raw">
    <label class="toggle"><input type="checkbox" id="ok"><span class="toggle__track"></span></label>
    <label class="api-token-scopes__cell"><input type="checkbox" data-scope="x:read" /></label>
    <label class="reminder-preset">
      <input type="checkbox" class="js-default-reminder" value="10">
    </label>
    <label class="form-check backfill-moved__all">
      <input type="checkbox" id="backfill-moved-all" checked>
    </label>
    <label class="backfill-moved__item"><span>x</span></label>
    <input type="checkbox" id="raw-after-selection">`;
  // Die Auswahl-Ausnahme gilt nur fuer die Checkbox IN ihrem Label - die rohe
  // Checkbox danach zaehlt wieder.
  assert.deepEqual(scanSettingsCheckbox(src, 'public/settings/pages/x.js').map((f) => f.what),
    ["toggleRowHtml ohne control: 'switch'", 'id="raw"', 'id="raw-after-selection"']);
  assert.deepEqual(scanSettingsCheckbox(src, 'public/pages/calendar.js'), []);
});

test('Scanner: dead-i-rule faengt die reine i-Regel und laesst den svg-Zweig und die lebendigen Balken durch', () => {
  const css = `
    .a i { color: red; }
    .b > i { width: 1px; }
    .c i, .c svg { width: 2px; }
    .subscriptions-chart-row__track i { height: 100%; }
    .d .icon { color: blue; }
    @media (min-width: 1px) { .e i[data-lucide] { margin: 0; } }`;
  assert.deepEqual(scanDeadIRules(css).map((f) => f.what), ['.a i', '.b > i', '.e i[data-lucide]']);
});

// ---------------------------------------------------------------------------
// Der Helfer der Zeilenaktion (utils/row-action.js)
// ---------------------------------------------------------------------------

const { rowActionHtml } = await import('../public/utils/row-action.js');

test('rowActionHtml: type=button, Name mit Objekt escaped, Ton als Modifier, Icon stumm', () => {
  const html = rowActionHtml({ icon: 'trash-2', label: 'Kategorie "Obst" <loeschen>', action: 'delete', tone: 'danger', attrs: { 'data-id': 7 } });
  assert.match(html, /^<button type="button" class="row-action row-action--danger"/);
  assert.match(html, /data-action="delete"/);
  assert.match(html, /aria-label="Kategorie &quot;Obst&quot; &lt;loeschen&gt;"/);
  assert.match(html, /data-id="7"/);
  assert.match(html, /<i data-lucide="trash-2" aria-hidden="true"><\/i><\/button>$/);
  // Der Helfer faellt nicht selbst unter die Regeln, die er erfuellt.
  assert.deepEqual(scanRowAction(html), []);
  assert.deepEqual(scanRowActionName(html), []);
});

test('rowActionHtml: Anrufen als Link, ohne data-action, unbekannter Ton faellt weg', () => {
  const html = rowActionHtml({ icon: 'phone', label: 'Anna anrufen', href: 'tel:+49 1', tone: 'loud' });
  assert.match(html, /^<a class="row-action" aria-label="Anna anrufen" href="tel:\+49 1">/);
  assert.doesNotMatch(html, /data-action|type=/);
});

const { toggleRowHtml } = await import('../public/settings/components.js');

test('toggleRowHtml({ control: \'switch\' }): Label links, geteilte .toggle-Bahn rechts, role=switch; ohne Option bleibt die Haken-Zeile', () => {
  const sw = toggleRowHtml({ label: 'Push <an>', checked: true, control: 'switch', attrs: { id: 'push-on' } });
  assert.match(sw, /^<label class="toggle-row toggle-row--switch">/);
  assert.match(sw, /<span class="toggle-row__label">Push &lt;an&gt;<\/span><span class="toggle"><input type="checkbox" role="switch" id="push-on" checked><span class="toggle__track" aria-hidden="true"><\/span><\/span><\/label>$/);
  const hidden = toggleRowHtml({ label: 'Modul', control: 'switch', labelVisible: false });
  assert.match(hidden, /<span class="toggle-row__label sr-only">Modul<\/span>/);
  const check = toggleRowHtml({ label: 'Filter' });
  assert.match(check, /^<label class="toggle-row"><input type="checkbox">/);
  assert.doesNotMatch(check, /role="switch"|toggle__track/);
  // Die Bahn traegt ihre Regeln global (layout.css), sonst kaeme sie in den
  // Einstellungen ungestylt an.
  const layout = readFileSync(join(PUBLIC, 'styles/layout.css'), 'utf8');
  const selectors = [...eachRule(layout)].map((r) => r.selector);
  for (const sel of ['.toggle__track', '.toggle input:checked + .toggle__track', '.toggle-row--switch .toggle-row__label']) {
    assert.ok(selectors.includes(sel), `${sel} fehlt in layout.css`);
  }
});

test('Beifang: das Offline-Banner (fixed, top 0) haelt die Statusleiste frei', () => {
  // viewport-fit=cover (index.html): ohne Inset stand der Text der installierten
  // App hinter Uhr und Notch (Critique 2026-09-26, Minor Observations).
  const layout = readFileSync(join(PUBLIC, 'styles/layout.css'), 'utf8');
  const rule = [...eachRule(layout)].find((r) => r.selector === '.offline-banner' && !r.at.length);
  assert.ok(rule, '.offline-banner fehlt in layout.css');
  assert.match(rule.body, /position\s*:\s*fixed/);
  assert.match(rule.body, /padding(?:-top|-block-start)?\s*:[^;]*var\(--safe-area-inset-top\)/,
    'die Oberkante braucht var(--safe-area-inset-top)');
});

test('Zeilenaktionen sind dauerhaft sichtbar: keine Regel blendet einen Aktions-Traeger per opacity: 0 aus', () => {
  // ignore.md (2026-08-17, bestaetigt): Ruhe durch Kontrast, nicht durch
  // Unsichtbarkeit - hover-Enthuellung hat hier zweimal dieselbe Defektklasse
  // gebaut, und Tablet/Trackpad haben kein verlaessliches hover. Die
  // Kommentar-Aktionen der Aufgabe (seit Runde 5 `.row-action`) standen bis
  // 2026-09-26 trotzdem auf opacity 0 und erschienen erst beim Ueberfahren
  // (Sichtpruefung der Integration).
  // Benannte Ausnahmen mit Grund:
  const NOT_ROW_ACTIONS = new Map([
    ['.fab-actions', 'Aufklapp-Menue der Schnellaktionen (dashboard.css), keine Zeilenaktion'],
    ['.meal-card__actions', 'Essenskarte im 148px-Slot des Wochenrasters, eigene Grammatik (meals.css, benannt in scanRowAction)'],
  ]);
  const hidden = [];
  for (const { file, src } of CSS) {
    for (const rule of eachRule(src)) {
      if (!/(?:^|;|\s)opacity\s*:\s*0(?![.\d])/.test(rule.body)) continue;
      for (const part of rule.selector.split(',').map((x) => x.trim().replace(/\s+/g, ' '))) {
        if (!/(?:__actions|row-actions|row-action)(?![\w-])/.test(part)) continue;
        if (NOT_ROW_ACTIONS.has(part)) continue;
        hidden.push(`${file}: ${part}${rule.at.length ? `  [${rule.at.join(' ')}]` : ''}`);
      }
    }
  }
  assert.deepEqual(hidden, [], 'Aktions-Traeger, die per opacity: 0 verschwinden - Zeilenaktionen bleiben sichtbar (ignore.md):');
});

// ---------------------------------------------------------------------------
// Ratchet
// ---------------------------------------------------------------------------

/**
 * Bestand vom 2026-09-26 (Runde 5, Schritt 1), nachgezogen nach Schritt 2
 * (Integration i5): die Module sind umgestellt, jede Regel steht auf null.
 * Nur nach UNTEN aendern; waechst eine Zahl, ist das ein neuer Dialekt und
 * kein Grund, sie zu erhoehen.
 */
const PENDING = {
  'row-action': {},
  'row-action-name': {},
  'search-field': {},
  'list-rows': {
    // Die drei Selektoren von `.list-rows` selbst. Kein Markup rendert die
    // Klasse mehr (JS-Zaehler null); die Regeln bleiben, bis
    // test:frontend-audit seine Zusagen (Flaeche, Lesemass, Container,
    // align-self) vom alten Traeger auf `.row-carrier` umgezogen hat.
    'public/styles/list-row.css': 3,
  },
  'floating-fab': {},
  'body-actions': {},
  'cancel-ghost': {},
  'footer-icon-delete': {},
  'settings-checkbox': {},
  // Leer seit Runde 5, Schritt 1: die 38 Regeln sind entfernt (je belegt,
  // dass dort kein <i> gerendert wird). Ab hier ist jede neue rot.
  'dead-i-rule': {},
};

const RULES = {
  'row-action': { files: JS, scan: (s) => scanRowAction(s), canon: '`.row-action` / `.row-action--danger` (utils/row-action.js `rowActionHtml`)' },
  'row-action-name': { files: JS, scan: (s) => scanRowActionName(s), canon: 'aria-label mit Objekt, z. B. `t(\'common.deleteNamed\', { name })`' },
  'search-field': { files: JS, scan: (s) => scanSearchField(s), canon: '`renderPageSearch()` aus utils/page-search.js (gefuellte Kapsel)' },
  'list-rows': { files: [...JS, ...CSS], scan: (s, f) => (f.endsWith('.css') ? scanListRowsCss(s) : scanListRowsJs(s)), canon: '`.row-carrier` (list-row.css)' },
  'floating-fab': { files: JS, scan: (s) => scanFloatingFab(s), canon: '`page-fab` mit `dockLabel` (utils/fab.js)' },
  'body-actions': { files: JS, scan: (s) => scanBodyActions(s), canon: '`.modal-panel__footer` (mountFooter hebt sie an den Blattrand)' },
  'cancel-ghost': { files: JS, scan: (s) => scanCancelGhost(s), canon: 'Abbrechen = `btn btn--secondary` (nie ghost)' },
  'footer-icon-delete': { files: JS, scan: (s) => scanFooterIconDelete(s), canon: 'Loeschen im Dialogfuss = `btn btn--danger-outline` mit Text, links' },
  'settings-checkbox': { files: JS, scan: (s, f) => scanSettingsCheckbox(s, f), canon: '`toggleRowHtml({ ..., control: \'switch\' })`' },
  'dead-i-rule': { files: CSS, scan: (s) => scanDeadIRules(s), canon: 'keine Regel auf `<i>` - Lucide rendert `<svg>`; auf `svg` zielen' },
};

function census(rule) {
  const { files, scan } = RULES[rule];
  const out = {};
  for (const { file, src } of files) {
    const hits = scan(src, file);
    if (hits.length) out[file] = hits;
  }
  return out;
}

if (process.env.CONTROL_DIALECT_DUMP) {
  const dump = {};
  for (const rule of Object.keys(RULES)) {
    dump[rule] = Object.fromEntries(Object.entries(census(rule)).map(([f, h]) => [f, h.length]));
  }
  const detail = {};
  for (const rule of Object.keys(RULES)) detail[rule] = census(rule);
  process.stdout.write(`${JSON.stringify(process.env.CONTROL_DIALECT_DUMP === 'detail' ? detail : dump, null, 2)}\n`);
}

test('Reichweite: die Scanner laufen ueber die ganze App (JS und CSS)', () => {
  assert.ok(JS.length >= 150, `nur ${JS.length} JS-Dateien gelesen - der Walker ist kaputt`);
  assert.ok(CSS.length >= 40, `nur ${CSS.length} CSS-Dateien gelesen`);
  assert.ok(JS.some((f) => f.file === 'public/pages/budget.js'));
  assert.ok(JS.some((f) => f.file.startsWith('public/settings/pages/')));
  assert.deepEqual(Object.keys(PENDING).sort(), Object.keys(RULES).sort());
});

for (const rule of Object.keys(RULES)) {
  test(`${rule}: kein neuer Abweichler (Kanon: ${RULES[rule].canon})`, () => {
    const pending = PENDING[rule];
    const problems = [];
    for (const [file, hits] of Object.entries(census(rule))) {
      const allowed = pending[file] ?? 0;
      if (hits.length > allowed) {
        problems.push(`${file}: ${hits.length} Funde, erlaubt ${allowed}\n    `
          + hits.map((h) => `${h.line ? `:${h.line} ` : ''}${h.what}`).join('\n    '));
      }
    }
    assert.deepEqual(problems, [], `Neuer Dialekt - Kanon ist ${RULES[rule].canon} (DESIGN.md "Komponenten-Kanon"):\n  ${problems.join('\n  ')}`);
  });

  test(`${rule}: die Ausnahmeliste ist aktuell (sinkt nur; rot = ein Fix wirkt, Integration streicht)`, () => {
    const now = census(rule);
    const stale = [];
    for (const [file, allowed] of Object.entries(PENDING[rule])) {
      const count = now[file]?.length ?? 0;
      if (count < allowed) stale.push(`${file}: ${allowed} -> ${count}${count === 0 ? ' (Zeile loeschen)' : ''}`);
    }
    assert.deepEqual(stale, [], `PENDING['${rule}'] nachziehen:\n  ${stale.join('\n  ')}`);
  });
}
