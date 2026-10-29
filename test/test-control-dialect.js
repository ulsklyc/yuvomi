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
 *        Runde 7 (Re-Critique 2026-09-27, P1 #2 "Kanon halb verteilt"):
 *          toolbar-new-btn     Anlegen = angedockter `page-fab`, kein eigener Kopfknopf
 *          hover-reveal        Aktionen stehen dauerhaft, kein Einblenden per :hover
 *          row-checkbox        Auswahl in Listenzeilen ohne native Checkbox
 *          segment-indicator   jede Segment-/Tab-Leiste gleitet mit dem geteilten Indikator
 *          search-width        Breite und Lage der Kopfsuche gehoeren page-search.css
 *          sheet-drag          ein Blatt zieht ueber utils/sheet-drag.js, nicht per Eigenbau
 *        Runde 14 (Re-Critique 2026-09-28, A6 P2-5):
 *          native-date         ein Datumsfeld ist `yuvomi-datepicker`, kein `<input type="date">`
 *        R21 (Critique 2026-10-21, D10 Zeilen-Endzone):
 *          row-endzone-order   [eine Handlung][Mehr-Knopf][Griff], der Griff zuletzt
 *          row-primary-count   hoechstens EINE sichtbare Handlung je Zeile
 *          row-chevron-with-menu  Chevron nur an reiner Navigation
 *          form-novalidate     ein Formular mit Feldregeln traegt novalidate
 *        #2119 (2026-10-25, Haken mit Gegenstueck):
 *          action-hook         ein `[data-action="x"]` im Listener hat ein `x` im Markup
 *          cta-hook            eine Leerzustand-Aktion ohne onClick traegt einen gebundenen Haken
 *
 * DAS IST EIN RATCHET, KEINE ALLOWLIST. `PENDING` ist der Bestand vom
 * 2026-09-26 (Datei -> Anzahl), fuer die sechs Regeln der Runde 7 der vom
 * 2026-09-27 - je Regel gegen einen eingefuegten Abweichler rot gesehen.
 * Zwei Tests je Regel:
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
import { join, relative, sep } from 'node:path';
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
  .map((f) => ({ file: relative(REPO, f).split(sep).join('/'), src: readFileSync(f, 'utf8') }));
const CSS = ALL_FILES
  .filter((f) => f.endsWith('.css'))
  .map((f) => ({ file: relative(REPO, f).split(sep).join('/'), src: readFileSync(f, 'utf8') }));

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
/** Bezeichner aus dem Quelltext, sicher fuer `new RegExp` (Punkte, `$` usw. zaehlen woertlich). */
function reEsc(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Alle Tags weg - wiederholt, bis nichts mehr faellt (`<<b>b>` hinterliesse sonst `<b>`). */
function stripTags(s) {
  let prev;
  do { prev = s; s = s.replace(/<[^>]*>/g, ''); } while (s !== prev);
  return s;
}

function visibleText(body) {
  return stripTags(body)
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
    const cls = (scope.match(new RegExp(`\\b${reEsc(name)}\\.className\\s*=\\s*['"\`]([^'"\`]*)['"\`]`)) || [])[1] ?? '';
    const icon = (scope.match(/(?:dataset\.lucide\s*=\s*|setAttribute\(\s*['"]data-lucide['"]\s*,\s*)['"]([\w-]+)['"]/) || [])[1] ?? '';
    const hasText = new RegExp(`\\b${reEsc(name)}\\.(?:textContent|append\\(\\s*t\\()`).test(scope);
    yield { name, cls, icon, index: m.index, iconOnly: !!icon && !hasText };
  }
}

const isHeadTools = (cls) => /\bpopover-menu__trigger\b/.test(cls) && /-tools\b|tools-btn\b/.test(cls);
const isPhotoOverlay = (cls) => /photo-action|avatar-action/.test(cls);
const isFooterDelete = (cls) => /\bbtn--danger(?![\w-])/.test(cls) && /\bbtn--icon\b/.test(cls);
// Das Mehr-Menue im Fuss eines Leseblatts (R24, detailFooterEl `more: true`):
// eine Blatt-Aktion wie das Kopf-Werkzeug, keine Zeilenaktion.
const isFooterMore = (cls) => /\bdetail-view__more-btn\b/.test(cls) && /\bpopover-menu__trigger\b/.test(cls);

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
    if (isHeadTools(cls) || isPhotoOverlay(cls) || isFooterDelete(cls) || isFooterMore(cls)) return;
    found.push({ line: lineOf(src, index), what: `${cls || '(ohne Klasse)'} [${icon}${action ? ` ${action}` : ''}]` });
  };
  for (const c of templateControls(src)) judge(c);
  for (const c of domButtons(src)) judge({ ...c, action: '' });
  return found;
}

/**
 * Zeilenaktionen: HOECHSTENS ZWEI sichtbar, der Rest im Mehr-Knopf
 * (Entscheidung Ulas 2026-10-07, DESIGN.md "Zeilenaktionen"; ersetzt die alte
 * ignore.md-Lesart "alles sichtbar").
 *
 * Gezaehlt wird je AKTIONSZONE: aufeinander folgende Zeilenaktionen im
 * Quelltext, zwischen denen kein Container endet (`</div>`, `</li>`,
 * `</article>`, `</tr>`, `</td>`, Ende eines Template-Literals). Eine Zone ist
 * damit genau das, was in einer Zeile nebeneinander steht.
 * NICHT gezaehlt, je mit Grund:
 *  - der Mehr-Knopf selbst (`rowMenuHtml`, `row-action--more`,
 *    `popover-menu__trigger`, `aria-haspopup`, Icon ellipsis/more-*): er ist
 *    der eine Ort fuer alles Weitere;
 *  - der Zieh-Griff (`list-row__drag`, `__handle`, Icon grip-*) und sein
 *    Tastaturpfad, das Auf/Ab-Paar der Verwalter (Icon chevron-up/-down,
 *    arrow-up/-down): Umsortieren ist eine Geste an der Zeile, keine Aktion
 *    ueber ihren Inhalt.
 */
const MORE_ICONS = /^(?:ellipsis|ellipsis-vertical|more-horizontal|more-vertical)$/;
const REORDER_ICONS = /^(?:grip-vertical|grip-horizontal|grip|chevron-up|chevron-down|arrow-up|arrow-down)$/;
const ZONE_END = /<\/(?:div|li|article|tr|td|header|section|ul)>|`\s*[;,)]/g;

/** Der Text eines Aufrufs `name({ ... })` ab `openIdx` (Index der Klammer), klammerbalanciert. */
function callText(src, openIdx) {
  let depth = 0;
  for (let i = openIdx; i < src.length && i < openIdx + 2500; i += 1) {
    if (src[i] === '(') depth += 1;
    else if (src[i] === ')') { depth -= 1; if (depth === 0) return src.slice(openIdx, i + 1); }
  }
  return src.slice(openIdx, openIdx + 400);
}

function rowActionsOf(src) {
  const out = [];
  for (const c of templateControls(src)) {
    if (!/\brow-action\b/.test(c.cls)) continue;
    const more = /\brow-action--more\b|\bpopover-menu__trigger\b/.test(c.cls) || /aria-haspopup/.test(c.attrs) || MORE_ICONS.test(c.icon);
    const reorder = /\blist-row__drag\b|__handle\b/.test(c.cls) || REORDER_ICONS.test(c.icon);
    out.push({ index: c.index, kind: more ? 'more' : reorder ? 'reorder' : 'action', what: c.icon || c.cls,
      danger: /\brow-action--danger\b/.test(c.cls) || /^trash/.test(c.icon) });
  }
  const call = /\b(rowActionHtml|rowActionEl|rowMenuHtml)\(/g;
  let m;
  while ((m = call.exec(src))) {
    if (inComment(src, m.index)) continue;
    if (/(?:function|import)\s+$/.test(src.slice(Math.max(0, m.index - 12), m.index))) continue;
    const text = callText(src, m.index + m[1].length);
    const icon = (text.match(/\bicon:\s*['"]([\w-]+)['"]/) || [])[1] ?? '';
    const more = m[1] === 'rowMenuHtml' || MORE_ICONS.test(icon) || /aria-haspopup|__menu\b|menu__trigger/.test(text);
    const reorder = REORDER_ICONS.test(icon) || /list-row__drag|__handle\b/.test(text);
    out.push({ index: m.index, kind: more ? 'more' : reorder ? 'reorder' : 'action', what: icon || m[1],
      danger: m[1] !== 'rowMenuHtml' && (/\btone:\s*['"]danger['"]/.test(text) || /^trash/.test(icon)) });
  }
  out.push(...domRowActions(src));
  return out.sort((a, b) => a.index - b.index);
}

/**
 * ZEILENAKTIONEN AUS DER DOM-API (R21, Critique 2026-10-21). Die Scanner oben
 * lesen Markup in Template-Strings und die Helfer-Aufrufe - ein Knopf, den
 * `document.createElement('button')` baut und dem erst eine Zuweisung die
 * Klasse gibt, sahen sie nicht. So stand die Rezeptzeile mit Stift,
 * Duplizieren und Papierkorb ab 30rem sichtbar da (recipes.js), waehrend
 * row-danger-visible gruen meldete: ein blinder Guard. Erfasst werden hier
 * `el.className = ...`, `el.classList.add(...)` und `setAttribute('class', ...)`
 * mit `row-action`; destruktiv ist die Zuweisung, sobald `row-action--danger`
 * in ihr steht - auch als Zweig einer Bedingung, denn welche Aktion den Zweig
 * nimmt, entscheidet erst die Laufzeit.
 */
function domRowActions(src) {
  const out = [];
  const assign = /\.className\s*=\s*(`[^`]*`|'[^']*'|"[^"]*")|\.classList\.add\(([^)]*)\)|\.setAttribute\(\s*['"]class['"]\s*,\s*(`[^`]*`|'[^']*'|"[^"]*")/g;
  let m;
  while ((m = assign.exec(src))) {
    if (inComment(src, m.index)) continue;
    const cls = m[1] ?? m[2] ?? m[3] ?? '';
    // `row-action` oder `row-action--x`, nicht der Traeger `row-actions`.
    if (!/\brow-action(?:--[\w-]+)?(?![\w-])/.test(cls)) continue;
    const more = /\brow-action--more\b|\bpopover-menu__trigger\b/.test(cls);
    const reorder = /\blist-row__drag\b|__handle\b/.test(cls);
    out.push({ index: m.index, kind: more ? 'more' : reorder ? 'reorder' : 'action', what: 'createElement',
      danger: /\brow-action--danger\b/.test(cls) });
  }
  return out;
}

export function scanRowActionCount(src) {
  const ends = [...src.matchAll(ZONE_END)].map((m) => m.index);
  const found = [];
  let zone = [];
  let e = 0;
  const flush = () => {
    const visible = zone.filter((a) => a.kind === 'action');
    if (visible.length > 2) {
      found.push({ line: lineOf(src, zone[0].index), what: `${visible.length} sichtbare Zeilenaktionen (${visible.map((a) => a.what).join(', ')})` });
    }
    zone = [];
  };
  for (const action of rowActionsOf(src)) {
    let crossed = false;
    while (e < ends.length && ends[e] < action.index) { e += 1; crossed = true; }
    if (crossed) flush();
    zone.push(action);
  }
  flush();
  return found;
}

/**
 * Der zweite Satz der Regel: ALLES DESTRUKTIVE steht im Mehr-Knopf. Ein
 * dauerhaft sichtbarer Papierkorb (`row-action--danger`, `tone: 'danger'`,
 * Icon trash*) ist ein Fund. Das ist ein RATCHET mit Bestand: die Kette vom
 * 2026-10-07 hat die im Auftrag genannten Listen umgestellt, die uebrigen
 * Zeilen mit Stift + Papierkorb stehen in PENDING und werden nur weniger.
 */
export function scanRowDangerVisible(src) {
  return rowActionsOf(src)
    .filter((a) => a.kind === 'action' && a.danger)
    .map((a) => ({ line: lineOf(src, a.index), what: `sichtbar destruktiv (${a.what})` }));
}

/**
 * D10 ZEILEN-ENDZONE (Critique R21, DESIGN.md "D10 Zeilen-Endzone"): EINE
 * Reihenfolge am Zeilenende fuer alle Module -
 * [hoechstens eine sichtbare Primaeraktion] [Mehr-Knopf] [Griff].
 * Gemessen vor R21: der Einkauf trug den Griff VOR dem Mehr-Knopf (die
 * Aufgaben dahinter), die Konten der Belohnungen Buchen + Plan + Schliessen,
 * die Dokumentzeile Auge + Herunterladen + Mehr.
 *
 * `row-endzone-order` liest je Aktionszone (wie row-action-count) die Folge:
 * hinter dem Griff steht nichts mehr, hinter dem Mehr-Knopf keine Aktion.
 * `row-primary-count` zaehlt die sichtbaren Aktionen ohne Mehr und Griff:
 * hoechstens EINE (vorher zwei, R18).
 */
/**
 * Zonen-Enden OHNE die, die in einem Helfer-Aufruf stehen: ein Name als
 * Template-Literal (`label: \`${t('x')}: ${name}\``) endet mit Backtick und
 * Komma - das las ZONE_END als Ende der Zone, und zwei Aufrufe nebeneinander
 * standen in zwei Zonen (so blieben Plan und Schliessen der Belohnungskonten
 * unsichtbar).
 */
function zoneEnds(src) {
  const calls = [];
  const call = /\b(rowActionHtml|rowActionEl|rowMenuHtml)\(/g;
  let m;
  while ((m = call.exec(src))) {
    const open = m.index + m[1].length;
    calls.push([open, open + callText(src, open).length]);
  }
  return [...src.matchAll(ZONE_END)].map((x) => x.index).filter((i) => !calls.some(([a, b]) => i > a && i < b));
}

/**
 * Ein Mehr-Knopf, der VOR dem Markup gebaut wird (`const menu = rowMenuHtml(...)`
 * ... `${menu}`), steht dort, wo er eingesetzt wird - nicht dort, wo der Aufruf
 * steht. Sonst laese sich [Speichern][Mehr] (Kalender verwalten) als
 * "Aktion hinter dem Mehr-Knopf".
 */
function placedRowActions(src) {
  const moved = new Map();
  const decl = /(?:const|let)\s+(\w+)\s*=\s*rowMenuHtml\(/g;
  let m;
  while ((m = decl.exec(src))) {
    const use = src.indexOf(`\${${m[1]}}`, m.index + m[0].length);
    if (use !== -1) moved.set(m.index + m[0].length - 'rowMenuHtml('.length, use);
  }
  return rowActionsOf(src)
    .map((a) => (moved.has(a.index) ? { ...a, index: moved.get(a.index) } : a))
    .sort((a, b) => a.index - b.index);
}

export function scanRowEndzoneOrder(src) {
  const ends = zoneEnds(src);
  const found = [];
  let zone = [];
  let e = 0;
  const flush = () => {
    const kinds = zone.map((a) => a.kind);
    const grip = kinds.indexOf('reorder');
    if (grip >= 0 && kinds.slice(grip + 1).some((k) => k !== 'reorder')) {
      found.push({ line: lineOf(src, zone[grip].index), what: `Griff vor ${zone.slice(grip + 1).map((a) => a.what).join(', ')} - der Griff steht zuletzt` });
    }
    const more = kinds.indexOf('more');
    if (more >= 0 && kinds.slice(more + 1).includes('action')) {
      found.push({ line: lineOf(src, zone[more].index), what: `Aktion hinter dem Mehr-Knopf (${zone.slice(more + 1).filter((a) => a.kind === 'action').map((a) => a.what).join(', ')})` });
    }
    zone = [];
  };
  for (const action of placedRowActions(src)) {
    let crossed = false;
    while (e < ends.length && ends[e] < action.index) { e += 1; crossed = true; }
    if (crossed) flush();
    zone.push(action);
  }
  flush();
  return found;
}

export function scanRowPrimaryCount(src) {
  const ends = zoneEnds(src);
  const found = [];
  let zone = [];
  let e = 0;
  const flush = () => {
    const visible = zone.filter((a) => a.kind === 'action');
    if (visible.length > 1) {
      found.push({ line: lineOf(src, zone[0].index), what: `${visible.length} sichtbare Handlungen (${visible.map((a) => a.what).join(', ')}) - eine, der Rest in rowMenuHtml()` });
    }
    zone = [];
  };
  for (const action of rowActionsOf(src)) {
    let crossed = false;
    while (e < ends.length && ends[e] < action.index) { e += 1; crossed = true; }
    if (crossed) flush();
    zone.push(action);
  }
  flush();
  return found;
}

/**
 * D10, zweiter Satz: "Chevron nur bei reiner Navigation". Ein Wegweiser
 * (chevron-right/-left) im OEFFNER einer Zeile (`.list-row__main--interactive`,
 * `.u-row-title`), deren Baustein auch einen Mehr-Knopf baut, ist ein Fund: die
 * Zeile oeffnet ein Objekt und traegt Handlungen, sie ist keine Navigation.
 * So stand die Rezeptzeile mobil [Name ... >][...] - der Chevron 12px versetzt
 * neben dem Mehr-Knopf. Der Baustein ist die umschliessende Funktion
 * (Spalte 0 bis zur schliessenden Klammer in Spalte 0).
 */
export function scanRowChevronWithMenu(src) {
  const found = [];
  const re = /data-lucide="(chevron-(?:right|left))"|dataset\.lucide\s*=\s*['"](chevron-(?:right|left))['"]/g;
  let m;
  while ((m = re.exec(src))) {
    if (inComment(src, m.index)) continue;
    const start = Math.max(src.lastIndexOf('\nfunction ', m.index), src.lastIndexOf('\nexport function ', m.index),
      src.lastIndexOf('\nasync function ', m.index), src.lastIndexOf('\nexport async function ', m.index));
    const endRel = src.slice(m.index).search(/\n\}\n/);
    const body = src.slice(start < 0 ? 0 : start, endRel === -1 ? src.length : m.index + endRel);
    if (!/list-row__main--interactive|u-row-title/.test(body)) continue;
    if (!/rowMenuHtml\(|popoverMenuHtml\(|row-action--more|popover-menu__trigger/.test(body)) continue;
    // Der Chevron haengt am Oeffner: dieselbe Funktion weist ihn dem Oeffner zu
    // (insertAdjacentHTML/appendChild am Element mit der Oeffner-Klasse) oder
    // er steht im Markup des Oeffners.
    const before = src.slice(Math.max(0, m.index - 400), m.index);
    const opener = /(\w+)\.className\s*=\s*['"`][^'"`]*list-row__main--interactive/.exec(body)?.[1];
    const onOpener = (opener && new RegExp(`\\b${reEsc(opener)}\\.insertAdjacentHTML\\([^)]*$`).test(before))
      || /class="[^"]*(?:list-row__main--interactive|u-row-title)[^"]*"[^<]*>(?:(?!<\/button>)[\s\S])*$/.test(before);
    if (!onOpener) continue;
    found.push({ line: lineOf(src, m.index), what: `${m[1] || m[2]} am Oeffner einer Zeile mit Mehr-Knopf` });
  }
  return found;
}

/**
 * KEINE BROWSER-BLASEN (DESIGN.md "Keine Browser-Blasen", Critique R21 a5 und
 * S9a): ein Formular, dessen Felder Regeln tragen (required, min, max, step,
 * minlength, pattern, Zahl-/Mail-/URL-Typ), traegt `novalidate` - sonst zeigt
 * der Browser seine Blase in seiner Sprache und Gestalt, statt dass die
 * Meldung am Feld steht (`constraintErrors()` + `reportFieldErrors()` aus
 * components/modal.js). Gemessen vor S9a: 28 von 59 solchen Formularen ohne,
 * in Schichtplan (5), Aufteilung (5), Haushaltshilfe (4), Abos, Dokumenten,
 * Fasten, den Einstellungen und der Tablet-Kopplung. `maxlength` zaehlt
 * nicht: es laesst sich nicht verletzen.
 * Template: `<form ...>` bis `</form>`; DOM: `createElement('form')` mit
 * Regel-Feldern in derselben Funktion verlangt `form.noValidate = true`.
 */
const FORM_CONSTRAINT = /\brequired\b|\bminlength=|\bmin=|\bmax=|\bstep=|type="(?:number|email|url|tel)"|\bpattern=|required:\s*true|type:\s*'number'/;
export function scanFormNovalidate(src) {
  const found = [];
  const re = /<form\b[^>]*>/g;
  let m;
  while ((m = re.exec(src))) {
    if (inComment(src, m.index)) continue;
    const end = src.indexOf('</form>', m.index);
    const body = src.slice(m.index, end < 0 ? m.index + 4000 : end);
    if (!FORM_CONSTRAINT.test(body) || /\bnovalidate\b/i.test(m[0])) continue;
    found.push({ line: lineOf(src, m.index), what: (m[0].match(/\b(?:id|class)="[^"]*"/) || [m[0].slice(0, 40)])[0] });
  }
  const dom = /(?:const|let)\s+(\w+)\s*=\s*document\.createElement\(\s*['"]form['"]\s*\)/g;
  while ((m = dom.exec(src))) {
    if (inComment(src, m.index)) continue;
    const endRel = src.slice(m.index).search(/\n\}\n/);
    const body = src.slice(m.index, endRel === -1 ? src.length : m.index + endRel);
    if (!FORM_CONSTRAINT.test(body)) continue;
    if (new RegExp(`\\b${reEsc(m[1])}\\.noValidate\\s*=\\s*true`).test(body)) continue;
    found.push({ line: lineOf(src, m.index), what: `${m[1]} = createElement('form') ohne noValidate` });
  }
  return found;
}

/**
 * Keine Textkapsel als Zeilenaktion: ein beschrifteter `.btn`, der in einer
 * LISTENZEILE Bearbeiten/Loeschen anbietet (der Schichtplan trug fuenf Listen
 * mit "Bearbeiten" und einem rot umrandeten "Loeschen" je Zeile). Die Zeile
 * erkennt der Scanner am Markup daneben: steht im selben Baustein (bis 300
 * Zeichen davor, 1500 danach und hoechstens bis zum Ende der Funktion - die
 * Aktionen werden vor der Zeile gebaut, in die sie eingesetzt werden) ein
 * Element mit der Klasse `list-row`, ist der Knopf eine Zeilenaktion. Ein
 * Knopf in einem Dialogfuss oder einer Formular-Aktionszeile bleibt, was er ist.
 */
export function scanRowTextCapsule(src) {
  const found = [];
  for (const c of templateControls(src)) {
    if (!/\bbtn\b/.test(c.cls) || c.iconOnly) continue;
    if (!ROW_VERBS.test(c.action)) continue;
    // Der Baustein endet am Ende seiner Funktion (schliessende Klammer in
    // Spalte 0) - eine Zeile der NAECHSTEN Funktion macht den Knopf nicht zur
    // Zeilenaktion.
    const before = src.slice(Math.max(0, c.index - 300), c.index);
    const fnEnd = src.slice(c.index, c.index + 1500).search(/\n\}\n/);
    const after = src.slice(c.index, c.index + (fnEnd === -1 ? 1500 : fnEnd));
    // Ein Knopf, dessen naechster Behaelter davor ein Dialogfuss oder eine
    // Formular-Aktionszeile ist, gehoert dem Dialog.
    const holder = [...before.matchAll(/<(?:div|span|footer)\b[^>]*class="([^"]*)"/g)].pop()?.[1] ?? '';
    if (/footer|form-actions/.test(holder)) continue;
    if (!/class="list-row(?:"|\s)/.test(before + after)) continue;
    found.push({ line: lineOf(src, c.index), what: `${c.cls} [${c.action}]` });
  }
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
    const cls = src.match(new RegExp(`\\b${reEsc(name)}\\.className\\s*=\\s*['"\`]([^'"\`]*)['"\`]`));
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
    if (!new RegExp(`\\b${reEsc(m[1])}\\.dataset\\.dockLabel\\s*=`).test(src)) {
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
 *  - (bis R17 auch `reminder-preset`: die Standard-Erinnerungen sind seit E9
 *    `.filter-chip` mit `aria-pressed` und brauchen keine Ausnahme mehr - eine
 *    16px-Checkbox in einer Pille faellt wieder auf;)
 *  - `backfill-moved__`: Auswahl der verschobenen Termine im Nachtrag-Dialog
 *    samt "alle" (sync-calendar.js).
 */
const SETTINGS_SELECTION = /class="(?:[^"]*\s)?(?:api-token-scopes__cell|backfill-moved__[\w-]+)(?:\s[^"]*)?"[^<]*$/;
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
// Der Abo-Balken (`.subscriptions-chart-row__track i`) stand hier bis R23; seit
// er die Fuellung der Kategoriezeile ist (`.budget-bar-row__fill`), gibt es
// die Regel nicht mehr.
const LIVE_I_RULES = new Map([
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
// Scanner der Runde 7 (Re-Critique 2026-09-27, P1 #2 "Kanon halb verteilt")
// ---------------------------------------------------------------------------

/** Zeilen ausserhalb von Kommentaren, mit Nummer. */
function codeLines(src) {
  const out = [];
  let inBlock = false;
  src.split('\n').forEach((text, i) => {
    let t = text;
    if (inBlock) {
      const end = t.indexOf('*/');
      if (end === -1) return;
      t = t.slice(end + 2);
      inBlock = false;
    }
    t = t.replace(/\/\*[\s\S]*?\*\//g, '');
    const open = t.indexOf('/*');
    if (open !== -1) { t = t.slice(0, open); inBlock = true; }
    if (/^\s*(?:\/\/|\*)/.test(t)) return;
    out.push({ line: i + 1, text: t.replace(/(?:^|[^:'"`])\/\/.*$/, '') });
  });
  return out;
}

/**
 * Punkt D3: der eigene Kopfknopf `.toolbar-new-btn` (Klasse im Markup, als
 * Selektor im JS oder im CSS). `toolbar-new-btn__label` ist die Beschriftung
 * des ANGEDOCKTEN FAB (router.js `dockFabIntoToolbar`) und zaehlt nicht.
 * Kanon: `createPageFab({ dockLabel })` - die Shell dockt ihn am Desktop an.
 */
export function scanToolbarNewBtn(src) {
  const found = [];
  for (const { line, text } of codeLines(src)) {
    const hits = text.match(/toolbar-new-btn(?![\w-])/g);
    if (hits) for (let k = 0; k < hits.length; k += 1) found.push({ line, what: text.trim().slice(0, 90) });
  }
  return found;
}

/**
 * Punkt D7: eine Aktion, die erst beim Ueberfahren erscheint - eine Regel,
 * die ein Aktions-Element unter `:hover`/`:focus-within` eines VORFAHREN auf
 * `opacity: 1` bzw. `visibility: visible` stellt. ignore.md (2026-08-17):
 * Zeilenaktionen sind dauerhaft sichtbar; Tablet und Trackpad haben kein
 * verlaessliches hover. Aktion heisst: das Ziel traegt eine Klasse mit
 * `action`, `-btn`, `__open`, `__delete`, `__pin` oder `add-more`.
 * Nicht gemeint: Beschriftungen (die ausklappende Seitenleiste zeigt ihre
 * Labels, keine Aktionen).
 */
const REVEALED_ACTION = /(?:action|-btn\b|__open\b|__delete\b|__pin\b|add-more)/;
export function scanHoverReveal(css) {
  const found = [];
  for (const rule of eachRule(css)) {
    if (!/(?:^|[;\s{])(?:opacity\s*:\s*1(?![.\d])|visibility\s*:\s*visible)/.test(rule.body)) continue;
    for (const part of rule.selector.split(',').map((x) => x.trim().replace(/\s+/g, ' '))) {
      const m = part.match(/:(?:hover|focus-within)\)?\s*(?:>\s*)?(.+)$/);
      if (!m) continue;
      const target = m[1].trim().split(/\s|>/).filter(Boolean).pop() ?? '';
      if (!target || !REVEALED_ACTION.test(target)) continue;
      found.push({ line: 0, what: part });
    }
  }
  return found;
}

/**
 * Punkt D5: eine native Checkbox als Auswahl in einer Listenzeile
 * (Mehrfachauswahl). Erkannt am Zweck, nicht an der Form: die Checkbox oder
 * ihr Label traegt `bulk`/`select` in der Klasse oder `data-select(-id)`.
 * Formularfelder ("Wiederkehrend", "Gesperrt") und Auswahllisten in Dialogen
 * sind keine Listenzeilen und zaehlen nicht; ein Schalter (`role="switch"`)
 * auch nicht. Kanon: Auswahlkreis statt Statuskreis + `utils/bulk-pill.js`.
 */
export function scanRowCheckbox(src) {
  const found = [];
  const re = /<input\b[^>]*\btype="checkbox"[^>]*>/g;
  let m;
  while ((m = re.exec(src))) {
    if (inComment(src, m.index) || /role="switch"/.test(m[0])) continue;
    const before = src.slice(Math.max(0, m.index - 200), m.index);
    const label = (before.match(/<label\b[^>]*class="([^"]*)"[^<]*$/) || [])[1] ?? '';
    const cls = (m[0].match(/\bclass="([^"]*)"/) || [])[1] ?? '';
    if (/bulk|select/i.test(cls) || /\bdata-select(?:-id)?=/.test(m[0]) || /bulk|select/i.test(label)) {
      found.push({ line: lineOf(src, m.index), what: (m[0].match(/\b(?:class|data-select(?:-id)?)="[^"]*"/) || ['<input type=checkbox>'])[0] });
    }
  }
  return found;
}

/**
 * Punkt D8: eine Segment- oder Tab-Leiste ohne den geteilten Indikator.
 * Gezaehlt wird je Datei: Leisten (oeffnende Tags mit `role="tablist"` oder
 * der Klasse `segmented`, `sub-tabs-bar`, `group-toggle`,
 * `documents-view-toggle`; dazu `renderSubTabs(`-Aufrufe) minus
 * Anschluesse (`attachSegmentIndicator(` und `renderSubTabs(` mit
 * `indicator`). Die Bausteine selbst (sub-tabs.js, tablist.js, der Indikator)
 * zaehlen nicht. Kanon: utils/segment-indicator.js.
 */
const SEGMENT_KIT = new Set(['public/utils/sub-tabs.js', 'public/utils/tablist.js', 'public/utils/segment-indicator.js']);
const SEGMENT_CLASS = /(?:^|\s)(?:segmented|sub-tabs-bar|group-toggle|documents-view-toggle)(?=\s|$)/;
export function scanSegmentIndicator(src, file = '') {
  if (SEGMENT_KIT.has(file)) return [];
  const bars = [];
  const tagRe = /<(?:div|nav|ul|section|span)\b([^>]*)>/g;
  let m;
  while ((m = tagRe.exec(src))) {
    if (inComment(src, m.index)) continue;
    const cls = (m[1].match(/\bclass="([^"]*)"/) || [])[1] ?? '';
    if (/\brole="tablist"/.test(m[1]) || SEGMENT_CLASS.test(cls)) {
      bars.push({ line: lineOf(src, m.index), what: cls ? `class="${cls.trim()}"` : 'role="tablist"' });
    }
  }
  let attached = 0;
  const subRe = /\brenderSubTabs\s*\(/g;
  while ((m = subRe.exec(src))) {
    if (inComment(src, m.index) || /import\s*\{/.test(src.slice(src.lastIndexOf('\n', m.index) + 1, m.index))) continue;
    const args = callArgs(src, m.index + m[0].length - 1);
    if (/\bindicator\s*:/.test(args)) attached += 1;
    else bars.push({ line: lineOf(src, m.index), what: 'renderSubTabs ohne indicator' });
  }
  const attRe = /\battachSegmentIndicator\s*\(/g;
  while ((m = attRe.exec(src))) {
    const before = src.slice(src.lastIndexOf('\n', m.index) + 1, m.index);
    if (inComment(src, m.index) || /import\s*\{|export\s+function\s*$/.test(before)) continue;
    attached += 1;
  }
  return bars.slice(0, Math.max(0, bars.length - attached));
}

/**
 * Punkt D4: eine Modulregel, die der Kopfsuche Breite oder Lage gibt. Die
 * Klassen stammen aus den `className`-Argumenten von `renderPageSearch()`;
 * Suchen, die NICHT im Modulkopf stehen, sind mit Grund ausgenommen (eine
 * neue, unbekannte Klasse zaehlt also - die sichere Richtung). Kanon:
 * `--page-search-width` und der Center-Slot in page-search.css.
 */
const NOT_HEAD_SEARCH = new Map([
  ['split-search', 'Gruppenkopf der Aufteilung (.section-toolbar), ab 976px Container eigene Zeile'],
  ['cal-search__field', 'Suchzeile unter dem Kalenderkopf (eigene Ergebnisansicht)'],
  ['event-icon-picker__search', 'Icon-Dialog im Kalender'],
  ['doc-attach-picker__search', 'Dokument-Auswahldialog'],
  ['settings-shell__navigation-search', 'Seitenleiste der Einstellungen'],
  ['page-toolbar__center', 'der Slot der Shell selbst'],
  ['page-search--field', 'Modifier der Shell (R19): die Kopfsuche bleibt mobil ein Feld; Geometrie EINMAL in layout.css'],
]);
export function headSearchClasses(jsFiles) {
  const out = new Set();
  for (const { src } of jsFiles) {
    for (const m of src.matchAll(/renderPageSearch\(\{([\s\S]*?)\}\)/g)) {
      const cls = (m[1].match(/\bclassName:\s*['"`]([^'"`]*)['"`]/) || [])[1];
      if (!cls) continue;
      for (const c of cls.split(/\s+/).filter(Boolean)) if (!NOT_HEAD_SEARCH.has(c)) out.add(c);
    }
  }
  return out;
}
const SEARCH_GEOMETRY = /(?:^|[;\s{])(?:width|max-width|min-width|inline-size|max-inline-size|min-inline-size|flex|flex-basis|flex-grow|flex-shrink|margin-inline-start|margin-left)\s*:/;
export function scanSearchWidth(css, classes) {
  const found = [];
  for (const rule of eachRule(css)) {
    if (!SEARCH_GEOMETRY.test(rule.body)) continue;
    for (const part of rule.selector.split(',').map((x) => x.trim())) {
      const last = part.split(/\s|>|\+|~/).filter(Boolean).pop() ?? '';
      const hit = [...classes].find((c) => new RegExp(`\\.${reEsc(c)}(?![\\w-])`).test(last));
      if (hit) found.push({ line: 0, what: `${part}${rule.at.length ? `  [${rule.at.join(' ')}]` : ''}` });
    }
  }
  return found;
}

/**
 * Punkt D2: ein Blatt mit eigener Zieh-Geste - Touch-Listener an einem
 * Element, das `sheet` oder `panel` heisst, ausserhalb des geteilten Helfers.
 * Vorher gab es zwei Grammatiken (Mehr-Blatt: erst bei touchend ab 60px;
 * Dialog: Faktor 0.6, ohne Tempo). Kanon: `wireSheetDrag()` aus
 * utils/sheet-drag.js.
 */
export function scanSheetDrag(src, file = '') {
  if (file === 'public/utils/sheet-drag.js') return [];
  const found = [];
  const re = /\b(\w*(?:[Ss]heet|[Pp]anel))\.addEventListener\(\s*['"](touch(?:start|move|end|cancel))['"]/g;
  let m;
  while ((m = re.exec(src))) {
    if (inComment(src, m.index)) continue;
    found.push({ line: lineOf(src, m.index), what: `${m[1]} ${m[2]}` });
  }
  return found;
}

/**
 * Punkt D9 (Runde 14, Re-Critique 2026-09-28, A6 P2-5): ein natives
 * Datumsfeld. Fuenf standen noch da (Dokumente-Ablauf, Vorsorge zweimal,
 * Fasten-Filter zweimal) - sie zeigten "tt.mm.jjjj" des Browsers, oeffneten
 * den System-Kalender statt des Kanon-Pickers und folgten weder Wochenstart
 * noch Datumsformat der Einstellungen. Gezaehlt wird das Template
 * (`<input ... type="date">`) und die DOM-API (`.type = 'date'`,
 * `setAttribute('type', 'date')`). Kanon: `<yuvomi-datepicker type="date">`
 * (components/datepicker.js), der das native Feld intern selbst verwaltet.
 */
export function scanNativeDate(src, file = '') {
  if (file === 'public/components/datepicker.js') return [];
  const found = [];
  const re = /<input\b[^>]*\btype=(["'])date\1[^>]*>|\.type\s*=\s*(["'])date\2|setAttribute\(\s*(["'])type\3\s*,\s*(["'])date\4\s*\)/g;
  let m;
  while ((m = re.exec(src))) {
    if (inComment(src, m.index)) continue;
    found.push({ line: lineOf(src, m.index), what: m[0].slice(0, 80) });
  }
  return found;
}

/**
 * EIN FARBWAEHLER (Critique R24, E6): ein natives Farbfeld gibt es nur noch
 * als "Eigene" im Baustein utils/color-picker.js - sonst stand es als
 * violetter Balken (Schichtplan, Haushaltshilfe, Abos) oder als runder Knopf
 * (Konto, Kalender-Import) neben fuenf Swatch-Reihen.
 */
export function scanNativeColor(src, file = '') {
  if (file === 'public/utils/color-picker.js') return [];
  const found = [];
  const re = /<input\b[^>]*\btype=(["'])color\1[^>]*>|\.type\s*=\s*(["'])color\2|setAttribute\(\s*(["'])type\3\s*,\s*(["'])color\4\s*\)/g;
  let m;
  while ((m = re.exec(src))) {
    if (inComment(src, m.index)) continue;
    found.push({ line: lineOf(src, m.index), what: m[0].slice(0, 80) });
  }
  return found;
}

/**
 * Eine Swatch-Reihe mit eigener Klasse (`.waste-color-swatch`,
 * `.note-color-swatch`, `.budget-color-swatch` ...) statt `.color-swatch` aus
 * colorPickerHtml(): jede Abschrift hatte eigene Geometrie, eigene Tasten und
 * eigenen Ring. Gezaehlt wird jede Klasse auf `-swatch`, die als Radio waehlt.
 */
export function scanSwatchDialect(src, file = '') {
  if (file === 'public/utils/color-picker.js') return [];
  const found = [];
  const re = /<(?:div|button|span)\b[^>]*>/g;
  let m;
  while ((m = re.exec(src))) {
    const tag = m[0];
    if (!/role=(["'])radio\1/.test(tag)) continue;
    const hit = /class="([^"]*)"|class='([^']*)'/.exec(tag);
    const cls = (hit?.[1] ?? hit?.[2] ?? '').replace(/\$\{[^}]*\}/g, ' ');
    const own = cls.split(/\s+/).find((c) => /-swatch$/.test(c) && c !== 'color-swatch');
    if (!own || inComment(src, m.index)) continue;
    found.push({ line: lineOf(src, m.index), what: own });
  }
  return found;
}

/**
 * DIALOGREGELN (Critique R24 S3; DESIGN.md D4 "Formulare"). Drei Regeln, die
 * in jedem Moduldialog gelten, die Anwendung je Modul in S7-S11 - die
 * Ausnahmelisten unten sinken mit jedem Modul:
 *
 * edit-autofocus: ein Dialog, der auch BEARBEITET (Titel nach isEdit/edit/
 * mode), oeffnet mit `initialFocus: 'edit'` - am Finger nimmt dann der Titel
 * den Fokus, keine Tastatur ueber dem halben Blatt (R23 D13, modal.js).
 */
export function scanEditAutofocus(src) {
  const found = [];
  const re = /\bopen(?:Shared)?Modal\(\{/g;
  let m;
  while ((m = re.exec(src))) {
    if (inComment(src, m.index)) continue;
    const args = callArgs(src, m.index + m[0].length - 2);
    const title = /\btitle:\s*([^,\n]+)/.exec(args)?.[1] ?? '';
    const editable = /\b(?:isEdit|edit|editing|existing)\s*\?|mode\s*===\s*'edit'\s*\?|\.id\s*\?/.test(title);
    if (!editable || /\binitialFocus\s*:/.test(args)) continue;
    found.push({ line: lineOf(src, m.index), what: title.trim().slice(0, 70) });
  }
  return found;
}

/**
 * advanced-hint: "Weitere Angaben" nennt, was dahinter liegt ("Weitere
 * Angaben - Kontakt, Notizen und Erinnerung", Inventar-Muster). Ohne Hinweis
 * findet ein Feld dort nur, wer schon weiss, dass es existiert.
 */
export function scanAdvancedHint(src, file = '') {
  if (file === 'public/components/modal.js') return [];
  const found = [];
  const re = /\badvancedSection\(/g;
  let m;
  while ((m = re.exec(src))) {
    if (inComment(src, m.index)) continue;
    const before = src.slice(Math.max(0, m.index - 30), m.index);
    if (/import\s*\{[^}]*$|,\s*$/.test(before) && !/\$\{\s*$/.test(before)) continue;
    const args = callArgs(src, m.index + m[0].length - 1);
    if (/\b(?:hint|label)\s*:/.test(args)) continue;
    found.push({ line: lineOf(src, m.index), what: 'advancedSection ohne hint' });
  }
  return found;
}

/**
 * primary-disabled: der Primaerknopf eines Dialogs ist immer bedienbar, die
 * Pruefung meldet sich beim Absenden am Feld (`reportFieldErrors`). Ein bis
 * zur Gueltigkeit gesperrter Knopf sagt nicht, WAS fehlt (Aufteilung bis R24).
 */
export function scanPrimaryDisabled(src) {
  const found = [];
  const re = /\b(?:save|submit|primary|confirm)\w*\.disabled\s*=(?!\s*(?:true|false)\b)\s*[^;\n]+/gi;
  let m;
  while ((m = re.exec(src))) {
    if (inComment(src, m.index)) continue;
    found.push({ line: lineOf(src, m.index), what: m[0].slice(0, 80) });
  }
  return found;
}

/**
 * people-checkbox: Personen waehlt man mit `renderUserMultiSelect` (Scheibe,
 * Name, eine Trefferflaeche je Person) - nicht mit nativen 13px-Kaestchen in
 * einem rohen `<fieldset>` (Aufteilung-Teilnehmende bis R24).
 */
export function scanPeopleCheckbox(src, file = '') {
  if (file === 'public/components/user-multi-select.js') return [];
  const found = [];
  const re = /<input\b[^>]*\btype="checkbox"[^>]*>/g;
  let m;
  while ((m = re.exec(src))) {
    const tag = m[0];
    if (/role="switch"|user-ms__checkbox/.test(tag) || inComment(src, m.index)) continue;
    if (!/(?:particip|member|person|people|assignee|user)/i.test(tag)) continue;
    found.push({ line: lineOf(src, m.index), what: tag.slice(0, 80) });
  }
  return found;
}

/** Ende des Elements, dessen Tag bei `openIdx` beginnt (balancierte div-Tiefe); ohne Schluss +800. */
function elementEnd(src, openIdx) {
  const re = /<div\b|<\/div>/g;
  re.lastIndex = openIdx;
  let depth = 0;
  let m;
  while ((m = re.exec(src))) {
    depth += m[0] === '</div>' ? -1 : 1;
    if (depth === 0) return m.index + m[0].length;
    if (m.index - openIdx > 6000) break;
  }
  return Math.min(src.length, openIdx + 800);
}

/**
 * Der Initialisierer von `const name = ...` bis zum `;` auf oberster Ebene
 * (Template-Literals und `${}` zaehlen nicht mit) - Start-Index und Text.
 */
function constInitializer(src, name) {
  const re = new RegExp(`\\b(?:const|let)\\s+${reEsc(name)}\\s*=`, 'g');
  const m = re.exec(src);
  if (!m) return null;
  const from = m.index + m[0].length;
  const stack = [];
  for (let i = from; i < src.length && i - from < 4000; i++) {
    const c = src[i];
    const top = stack[stack.length - 1];
    if (top === '`') {
      if (c === '\\') i++;
      else if (c === '`') stack.pop();
      else if (c === '$' && src[i + 1] === '{') { stack.push('{'); i++; }
    } else if (c === '`') stack.push('`');
    else if (c === '{' || c === '(' || c === '[') stack.push(c);
    else if (c === '}' || c === ')' || c === ']') stack.pop();
    else if (c === ';' && !stack.length) return { index: from, text: src.slice(from, i) };
  }
  return null;
}

/**
 * Die Knoepfe eines Kopf-Ausschnitts - inline UND hinter `${name}`: ein Kopf,
 * der seinen Knopf vorher als Konstante baut (`${setUp}`, `${adminBar}`,
 * `${balanceActions}`), traegt ihn genauso (#2119). Index absolut zur Quelle.
 */
function headControls(src, from, to) {
  const out = [];
  const segment = src.slice(from, to);
  for (const c of templateControls(segment)) out.push({ ...c, at: from + c.index });
  const seen = new Set();
  for (const ref of segment.matchAll(/\$\{\s*([A-Za-z_$][\w$]*)\s*\}/g)) {
    const name = ref[1];
    if (seen.has(name)) continue;
    seen.add(name);
    const init = constInitializer(src, name);
    if (!init) continue;
    for (const c of templateControls(init.text)) out.push({ ...c, at: init.index + c.index });
  }
  return out;
}

/**
 * D5 Abschnittsaktion: im Abschnittskopf (`<modul>-section-head`,
 * `<modul>-section__head`) und seinem Aktions-Container
 * (`split-section-actions`, `rw-section__actions`) darf nur `btn--secondary`
 * mit `btn--sm` stehen - kein `btn--secondary` ohne `btn--sm`, kein
 * `btn--ghost`. Genau EINE `btn--secondary btn--sm` (Icon + Wort), seltene
 * Nebenaktionen hinter `popover-menu__trigger` (`<modul>-section-tools`).
 * Der Kopf zaehlt mit, seit #2119: `split-recurring-add` stand direkt im
 * `split-section-head`, `rw-money-setup` hinter `${setUp}` im
 * `rw-section__head` - beide durften unbemerkt zurueck auf `btn--ghost`.
 * Guard: `test:control-dialect` `section-action`
 */
export function scanSectionAction(src) {
  const found = [];
  const reported = new Set();
  const counted = new Set();
  const re = /class="(?:[^"]*\s)?(?:split-section-actions|rw-section__actions|[a-z][a-z-]*-section-head|[a-z][a-z-]*-section__head)(?![\w-])[^"]*"/g;
  let m;
  while ((m = re.exec(src))) {
    if (inComment(src, m.index)) continue;
    // Ein Kopf, der zugleich `section-toolbar` ist (Suche + Filter in der
    // Hoehe des Suchfelds, Abo-Liste), ist eine Werkzeugleiste, kein
    // D5-Abschnittskopf - dort gilt `section-toolbar-create`.
    if (/\bsection-toolbar\b/.test(m[0])) continue;
    const open = src.lastIndexOf('<', m.index);
    const labelled = [];
    for (const c of headControls(src, m.index, elementEnd(src, open))) {
      const item = /\bpopover-menu__item\b/.test(c.cls);
      const line = lineOf(src, c.at);
      if (/\bbtn--ghost\b/.test(c.cls)) {
        if (!reported.has(c.at)) found.push({ line, what: `btn--ghost in Abschnittsaktion: ${c.cls}` });
        reported.add(c.at);
      } else if (/\bbtn--secondary\b/.test(c.cls) && !/\bbtn--sm\b/.test(c.cls) && !item) {
        if (!reported.has(c.at)) found.push({ line, what: `btn--secondary ohne --sm in Abschnittsaktion: ${c.cls}` });
        reported.add(c.at);
      } else if (/\bbtn--secondary\b/.test(c.cls) && /\bbtn--sm\b/.test(c.cls) && !/\bbtn--icon\b/.test(c.cls) && !item) {
        labelled.push(c.at);
      }
    }
    const key = [...new Set(labelled)].sort((a, b) => a - b).join(',');
    if (new Set(labelled).size > 1 && !counted.has(key)) {
      counted.add(key);
      found.push({ line: lineOf(src, m.index), what: `mehr als eine beschriftete btn--secondary btn--sm im Abschnittskopf (${new Set(labelled).size})` });
    }
  }
  return found;
}

export function scanSectionToolbarCreate(src) {
  const found = [];
  const seen = new Set();
  const re = /\b(?:section-toolbar|[a-z-]+-section-head|[a-z-]+-section__head|[a-z-]+-section-actions|[a-z-]+-section__actions)\b/g;
  let m;
  while ((m = re.exec(src))) {
    if (inComment(src, m.index)) continue;
    // Auch hinter `${name}` (#2119): ein vorher gebauter Knopf steht genauso im Kopf.
    for (const c of headControls(src, m.index, m.index + 800)) {
      if (/\bbtn--icon\b/.test(c.cls) && c.icon === 'plus' && !/\bpopover-menu__trigger\b/.test(c.cls) && !seen.has(c.at)) {
        seen.add(c.at);
        found.push({ line: lineOf(src, c.at), what: `nackter Erstell-Knopf (btn--icon plus) im Abschnittskopf: ${c.cls}` });
      }
    }
  }
  return found;
}

/**
 * Haken ohne Gegenstueck, Richtung Listener -> Markup (#2119, #2210): ein
 * `[data-action="x"]` im Selektor einer Datei braucht ein `x`, das dort (oder
 * in einem Modul, das sie importiert) als Markup oder String-Literal steht -
 * `data-action="x"`, `action: 'x'` (Menueeintrag), `'data-action': 'x'`,
 * `id: 'x'` (Leerzustand-Helfer der Gesundheit). Faellt das Gegenstueck weg
 * (`action: 'add-group'` umbenannt, `items: []`), bindet der Listener ins
 * Leere, und der Knopf ist weg oder tot. `close-modal` ist Kanon des Dialogs
 * (components/modal.js) und gilt in jeder Datei als gesendet.
 * Guard: `test:control-dialect` `action-hook`
 */
const SHARED_ACTIONS = new Set(['close-modal']);
const SELECTOR_ACTION = /\[data-action=(["'])([\w-]+)\1\]/g;

export function scanActionHook(src, imported = []) {
  const found = [];
  const strip = (s) => s.replace(SELECTOR_ACTION, '');
  const pool = [strip(src), ...imported.map(strip)].join('\n');
  const reported = new Set();
  let m;
  SELECTOR_ACTION.lastIndex = 0;
  while ((m = SELECTOR_ACTION.exec(src))) {
    const name = m[2];
    if (reported.has(name) || SHARED_ACTIONS.has(name) || inComment(src, m.index)) continue;
    const esc = reEsc(name);
    if (new RegExp(`(['"\`])${esc}\\1|data-action="${esc}"`).test(pool)) continue;
    reported.add(name);
    found.push({ line: lineOf(src, m.index), what: `[data-action="${name}"] bindet, aber nichts traegt "${name}"` });
  }
  return found;
}

/** Die Quellen der Module, die `src` per absolutem (`/utils/x.js`) oder relativem Pfad importiert. */
function importedSources(src, file, byFile) {
  const out = [];
  for (const m of src.matchAll(/\bfrom\s+['"]([^'"]+\.js)['"]/g)) {
    const spec = m[1];
    let target;
    if (spec.startsWith('/')) target = `public${spec}`;
    else if (spec.startsWith('.')) target = join(file, '..', spec).split(sep).join('/');
    if (target && byFile.has(target)) out.push(byFile.get(target));
  }
  return out;
}

/**
 * Haken ohne Gegenstueck, Richtung Markup -> Listener (#2210): die Aktion
 * eines Leerzustands (`action: {...}`, `actions: [...]`, `const action = ...`)
 * ohne `onClick` lebt nur ueber ihren Haken - eine Klasse, ein `data-action`,
 * eine `id` oder ein `data-*` aus `attrs`. Mindestens einer davon muss in der
 * Datei wieder vorkommen (Selektor, Delegation, Helfer). Der Knopf im
 * Rewards-Leerzustand trug nur `className: 'rw-manage-participants'`, die
 * niemand band: er sah aus wie der einzige Weg zur ersten Teilnehmenden und
 * tat nichts. Menueeintraege (`action: 'x'`), Menues (`items`), Links und
 * Werte, die erst zur Laufzeit feststehen, laufen durch.
 * Guard: `test:control-dialect` `cta-hook`
 */
export function scanCtaHook(src) {
  const found = [];
  const seen = new Set();
  const ctx = /\baction\s*:|\bactions\s*:\s*\[|\b(?:const|let)\s+\w*(?:[aA]ction|[cC]ta)\w*\s*=/g;
  let m;
  while ((m = ctx.exec(src))) {
    if (inComment(src, m.index)) continue;
    const from = m.index + m[0].length;
    let depth = 0;
    for (let i = from; i < src.length && i - from < 600; i++) {
      const c = src[i];
      if (c === ';' && depth === 0) break;
      if (c === '(' || c === '[') depth++;
      else if (c === ')' || c === ']' || c === '}') { depth--; if (depth < 0) break; }
      else if (c === '{') {
        let d = 0;
        let e = i;
        for (; e < src.length; e++) {
          if (src[e] === '{') d++;
          else if (src[e] === '}') { d--; if (!d) break; }
        }
        const obj = src.slice(i, e + 1);
        const at = i;
        i = e;
        if (seen.has(at) || !/(?:^|[?:,[=(])\s*$/.test(src.slice(from, at))) continue;
        seen.add(at);
        if (!/\blabel\s*:/.test(obj) || /\b(?:action|items|onClick|href|route|key)\s*:/.test(obj)) continue;
        const hooks = [];
        let dynamic = false;
        const cls = obj.match(/\bclassName\s*:\s*(?:(['"])([^'"]*)\1|(\S))/);
        if (cls?.[3]) dynamic = true;
        for (const tok of (cls?.[2] ?? '').split(/\s+/).filter((x) => x && !/^btn(?:--|$)/.test(x))) {
          hooks.push(src.includes(`.${tok}`));
        }
        const attrs = obj.match(/\battrs\s*:\s*\{([^{}]*)\}/)?.[1] ?? '';
        const own = obj.replace(/\battrs\s*:\s*\{[^{}]*\}/, '');
        const entries = [...attrs.matchAll(/(['"]?)([\w-]+)\1\s*:\s*([^,]+)/g)];
        const topId = own.match(/(?:^|[\s{,])id\s*:\s*([^,}]+)/);
        if (topId) entries.push([null, null, 'id', topId[1]]);
        for (const [, , name, rawValue] of entries) {
          const lit = rawValue.trim().match(/^(['"])([\w-]*)\1$/);
          if (!lit) { if (name === 'data-action' || name === 'id' || name.startsWith('data-')) dynamic = true; continue; }
          const value = lit[2];
          if (name === 'data-action' || name === 'id') hooks.push(src.split(value).length - 1 > 1);
          else if (name.startsWith('data-')) {
            const camel = name.slice(5).replace(/-(\w)/g, (_, x) => x.toUpperCase());
            hooks.push(src.split(name).length - 1 > 1 || src.includes(`dataset.${camel}`));
          }
        }
        if (dynamic || hooks.some(Boolean)) continue;
        found.push({
          line: lineOf(src, at),
          what: hooks.length
            ? `Aktion ohne Listener: kein Haken aus ${obj.replace(/\s+/g, ' ').slice(0, 90)} wird in der Datei gebunden`
            : `Aktion ohne Haken (weder onClick noch Klasse, data-action oder id): ${obj.replace(/\s+/g, ' ').slice(0, 90)}`,
        });
      }
    }
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

test('Scanner: row-action-count zaehlt je Zone und laesst Mehr-Knopf, Griff und Auf/Ab aus', () => {
  const bad = `
    <div class="list-row__actions">
      <button class="row-action list-row__drag" aria-label="\${a}"><i data-lucide="grip-vertical"></i></button>
      <button class="row-action" data-action="copy" aria-label="\${a}"><i data-lucide="copy"></i></button>
      <button class="row-action" data-action="item-details" aria-label="\${a}"><i data-lucide="pencil"></i></button>
      <button class="row-action row-action--danger" data-action="delete-item" aria-label="\${a}"><i data-lucide="trash-2"></i></button>
    </div>
    <div class="row-actions">
      \${rowActionHtml({ icon: 'eye', label: a })}
      \${rowActionHtml({ icon: 'download', label: a })}
      \${rowActionHtml({ icon: 'share-2', label: a })}
    </div>`;
  assert.equal(scanRowActionCount(bad).length, 2);
  const good = `
    <div class="list-row__actions">
      <button class="row-action list-row__drag" aria-label="\${a}"><i data-lucide="grip-vertical"></i></button>
      \${rowMenuHtml({ id, label, items: [{ action: 'edit' }, { action: 'delete' }] })}
    </div>
    <div class="row-actions">
      \${rowActionHtml({ icon: 'chevron-up', label: a })}
      \${rowActionHtml({ icon: 'chevron-down', label: a })}
      \${rowActionHtml({ icon: 'pencil', label: a })}
      \${rowActionHtml({ icon: 'trash-2', label: a })}
    </div>
    <div class="row-actions">
      \${rowActionHtml({ icon: 'eye', label: a })}
      \${rowActionHtml({ icon: 'download', label: a })}
      \${rowActionHtml({ icon: 'more-vertical', label: a, attrs: { 'aria-haspopup': 'menu' } })}
    </div>
    <div class="row-actions">\${rowActionHtml({ icon: 'pencil', label: a })}\${rowActionHtml({ icon: 'trash-2', label: a })}</div>
    <div class="row-actions">\${rowActionHtml({ icon: 'phone', label: a })}</div>`;
  assert.deepEqual(scanRowActionCount(good), []);
});

test('Scanner: row-danger-visible faengt den sichtbaren Papierkorb und laesst den Menue-Eintrag durch', () => {
  const bad = `
    <button class="row-action row-action--danger" data-action="delete-item" aria-label="\${a}"><i data-lucide="trash-2"></i></button>
    \${rowActionHtml({ icon: 'trash-2', tone: 'danger', label: a })}`;
  assert.equal(scanRowDangerVisible(bad).length, 2);
  const good = `
    \${rowActionHtml({ icon: 'pencil', label: a })}
    \${rowMenuHtml({ id, label, items: [{ action: 'delete', icon: 'trash-2', danger: true }] })}`;
  assert.deepEqual(scanRowDangerVisible(good), []);
});

// R21 (Critique 2026-10-21): die Rezeptzeile baute Stift, Duplizieren und
// Papierkorb per createElement - der Scanner las nur Markup und Helfer und
// meldete die Datei sauber.
test('Scanner: row-danger-visible sieht auch den per DOM-API gebauten Papierkorb', () => {
  const bad = `
    for (const a of ROW_ACTIONS) {
      const btn = document.createElement('button');
      btn.className = \`row-action\${a.danger ? ' row-action--danger' : ''}\`;
      inline.appendChild(btn);
    }
    del.classList.add('row-action', 'row-action--danger');
    other.setAttribute('class', 'row-action row-action--danger');`;
  assert.equal(scanRowDangerVisible(bad).length, 3);
  const good = `
    cart.className = 'row-action pantry-row__cart';
    actions.className = 'row-actions';
    more.className = 'row-action row-action--more';`;
  assert.deepEqual(scanRowDangerVisible(good), []);
});

test('Scanner: row-text-capsule faengt die beschriftete Kapsel in einer Listenzeile und laesst den Dialogfuss durch', () => {
  const bad = `
    const actions = '<span><button type="button" class="btn btn--secondary" data-action="edit-shift-type">' + esc(t('common.edit')) + '</button>'
      + '<button type="button" class="btn btn--danger-outline" data-action="delete-shift">' + esc(t('schedule.delete')) + '</button></span>';
    return '<div class="list-row schedule-type-row">' + actions + '</div>';`;
  assert.equal(scanRowTextCapsule(bad).length, 2);
  const good = `
    <div class="modal-panel__footer">
      <button type="button" class="btn btn--danger-outline" data-action="delete-entry"><i data-lucide="trash-2"></i>\${t('common.delete')}</button>
    </div>
    <div class="list-row x">\${rowMenuHtml({ id, label, items })}</div>
    <div class="list-row y"><button class="btn btn--secondary" data-action="quick-start">\${t('a')}</button></div>`;
  assert.deepEqual(scanRowTextCapsule(good), []);
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
    ["toggleRowHtml ohne control: 'switch'", 'id="raw"', 'class="js-default-reminder"', 'id="raw-after-selection"']);
  assert.deepEqual(scanSettingsCheckbox(src, 'public/pages/calendar.js'), []);
});

test('Scanner: dead-i-rule faengt die reine i-Regel und laesst den svg-Zweig und die lebendigen Balken durch', () => {
  const css = `
    .a i { color: red; }
    .b > i { width: 1px; }
    .c i, .c svg { width: 2px; }
    .subscriptions-metadata-row__view > i { background: red; }
    .d .icon { color: blue; }
    @media (min-width: 1px) { .e i[data-lucide] { margin: 0; } }`;
  assert.deepEqual(scanDeadIRules(css).map((f) => f.what), ['.a i', '.b > i', '.e i[data-lucide]']);
});

test('Scanner: toolbar-new-btn faengt Markup, Selektor und CSS, nicht Kommentar und nicht die Dock-Beschriftung', () => {
  const bad = `
    <button class="btn btn--primary toolbar-new-btn" id="x-add">\${t('newLabel.x')}</button>
    if (main?.querySelector('.toolbar-new-btn')) return false;`;
  assert.equal(scanToolbarNewBtn(bad).length, 2);
  assert.equal(scanToolbarNewBtn('.toolbar-new-btn { display: none; }\n/* .toolbar-new-btn stand hier */').length, 1);
  const good = `
    // .toolbar-new-btn gab es bis Runde 7
    label.className = 'toolbar-new-btn__label';
    fab = createPageFab({ id: 'x-fab', dockLabel: t('newLabel.x') });`;
  assert.deepEqual(scanToolbarNewBtn(good), []);
});

test('Scanner: hover-reveal faengt die Aktion, die ein Vorfahr per :hover einblendet, und laesst Labels und Eigen-Hover durch', () => {
  const bad = `
    .note-card__delete { opacity: 0; }
    .note-card:hover .note-card__delete, .note-card:focus-within .note-card__open { opacity: 1; }
    .meal-slot:hover .meal-card__actions { opacity: 1; pointer-events: auto; }
    .row:hover > .row__edit-btn { visibility: visible; }`;
  assert.deepEqual(scanHoverReveal(bad).map((f) => f.what), [
    '.note-card:hover .note-card__delete', '.note-card:focus-within .note-card__open',
    '.meal-slot:hover .meal-card__actions', '.row:hover > .row__edit-btn']);
  const good = `
    .nav-sidebar:hover .nav-item__label { opacity: 1; }
    .row-action:hover { color: red; }
    .note-card:hover .note-card__title { opacity: 1; }
    .meal-card__actions { opacity: 1; }`;
  assert.deepEqual(scanHoverReveal(good), []);
});

test('Scanner: row-checkbox faengt die Auswahl-Checkbox in Zeilen und laesst Formularfelder und Schalter durch', () => {
  const bad = `
    <input type="checkbox" class="task-bulk-checkbox" data-task-id="1">
    <label class="contact-item__select"><input type="checkbox" class="contact-item__checkbox"></label>
    <label class="document-select"><input type="checkbox" data-select-id="7"></label>`;
  assert.equal(scanRowCheckbox(bad).length, 3);
  const good = `
    <input type="checkbox" id="bm-recurring" checked>
    <label class="form-check"><input type="checkbox" id="task-locked"></label>
    <input type="checkbox" role="switch" class="select-all-switch">`;
  assert.deepEqual(scanRowCheckbox(good), []);
});

test('Scanner: segment-indicator zaehlt Leisten minus Anschluesse und laesst die Bausteine aus', () => {
  const bad = `
    <div class="segmented x-filter" role="radiogroup"></div>
    <div class="budget-tabs page-toolbar__bar" role="tablist"></div>
    <div class="group-toggle group-toggle--icons"></div>
    renderSubTabs(toolbar, { semantics: 'tabs', tabs });`;
  assert.equal(scanSegmentIndicator(bad, 'public/pages/x.js').length, 4);
  const partly = `${bad}
    attachSegmentIndicator(el.querySelector('.budget-tabs'));`;
  assert.equal(scanSegmentIndicator(partly, 'public/pages/x.js').length, 3, 'jeder Anschluss nimmt eine Leiste');
  const good = `
    <div class="segmented__item is-active"></div>
    <div class="fasting-dial fasting-dial--segmented"></div>
    renderSubTabs(container, { semantics: 'nav', tabs, indicator: { key: 'health' } });
    import { attachSegmentIndicator } from '/utils/segment-indicator.js';`;
  assert.deepEqual(scanSegmentIndicator(good, 'public/pages/x.js'), []);
  assert.deepEqual(scanSegmentIndicator(bad, 'public/utils/sub-tabs.js'), [], 'der Baustein selbst zaehlt nicht');
});

test('Scanner: search-width faengt Modulbreiten der Kopfsuche, nicht Aussehen und nicht Suchen ausserhalb des Kopfes', () => {
  const classes = headSearchClasses([{ src: `
    renderPageSearch({ id: 'a', className: 'x-toolbar__search page-toolbar__center' })
    renderPageSearch({ id: 'b', className: 'split-search' })` }]);
  assert.deepEqual([...classes], ['x-toolbar__search'], 'Center-Slot und die benannten Nicht-Kopf-Suchen fallen weg');
  const bad = `
    .x-toolbar__search { flex: 1 1 0; max-width: 280px; margin-inline-start: auto; }
    @media (min-width: 1024px) { .x-toolbar > .x-toolbar__search { flex-basis: 0; } }`;
  assert.equal(scanSearchWidth(bad, classes).length, 2);
  const good = `
    .x-toolbar__search .page-search__input { color: red; }
    .x-toolbar__search[hidden] { display: none; }
    .split-search { max-width: 28rem; }`;
  assert.deepEqual(scanSearchWidth(good, classes), []);
});

test('Scanner: native-date faengt das native Datumsfeld (Template und DOM) und laesst den Kanon-Picker durch', () => {
  const bad = `
    <input class="input" id="document-expires-at" type="date" value="\${esc(x)}">
    <label>\${t('a')}<input type='date' name="from"></label>
    field.type = 'date';
    input.setAttribute("type", "date");`;
  assert.equal(scanNativeDate(bad, 'public/pages/x.js').length, 4);
  const good = `
    <yuvomi-datepicker id="document-expires-at" type="date" label="\${esc(l)}"></yuvomi-datepicker>
    <input type="month" class="form-input" id="lm-start">
    <input type="time" class="form-input">
    // <input type="date"> stand hier bis R14
    el.dataset.type = 'dates';`;
  assert.deepEqual(scanNativeDate(good, 'public/pages/x.js'), []);
  assert.deepEqual(scanNativeDate(bad, 'public/components/datepicker.js'), [], 'der Baustein selbst zaehlt nicht');
});

test('Scanner: native-color faengt das native Farbfeld (Template und DOM) und laesst den Baustein durch', () => {
  const bad = `
    <input class="form-input form-input--color" name="color" type="color" value="\${esc(c)}">
    <input class="settings-color-button" type='color' id="x">
    field.type = 'color';
    input.setAttribute("type", "color");`;
  assert.equal(scanNativeColor(bad, 'public/pages/x.js').length, 4);
  const good = `
    \${colorPickerHtml({ name: 'color', value, labelledBy: 'l' })}
    // <input type="color"> stand hier bis R24
    <input type="text" class="form-input">`;
  assert.deepEqual(scanNativeColor(good, 'public/pages/x.js'), []);
  assert.deepEqual(scanNativeColor(bad, 'public/utils/color-picker.js'), [], 'der Baustein selbst zaehlt nicht');
});

test('Scanner: swatch-dialect faengt die eigene Swatch-Klasse als Radio und laesst .color-swatch und Schmuck durch', () => {
  const bad = `
    <div class="note-color-swatch \${on ? 'note-color-swatch--active' : ''}" data-color="x"
         role="radio" tabindex="0"></div>
    <button type="button" role="radio" class="budget-color-swatch is-active" style="--swatch:x"></button>`;
  assert.deepEqual(scanSwatchDialect(bad, 'public/pages/x.js').map((h) => h.what), ['note-color-swatch', 'budget-color-swatch']);
  const good = `
    <button type="button" class="color-swatch color-swatch--active" role="radio" aria-checked="true"></button>
    <span class="filter-chip__swatch" aria-hidden="true"></span>
    <span class="cal-calendar-row__swatch" style="background-color:x" aria-hidden="true"></span>`;
  assert.deepEqual(scanSwatchDialect(good, 'public/pages/x.js'), []);
});

test('Scanner: Dialogregeln - edit-autofocus, advanced-hint, primary-disabled, people-checkbox fangen ihr Muster und lassen den Kanon durch', () => {
  const edit = `openModal({ title: isEdit ? t('a.edit') : t('a.new'), content });
    openSharedModal({ title: t('a.only'), content });
    openModal({ title: isEdit ? t('b.edit') : t('b.new'), initialFocus: isEdit ? 'edit' : 'first-field', content });`;
  assert.deepEqual(scanEditAutofocus(edit).map((h) => h.line), [1], 'nur der bearbeitende Dialog ohne initialFocus');
  const adv = `import { advancedSection } from '/components/modal.js';
    \${advancedSection(fieldsHtml, { open })}
    \${advancedSection(fieldsHtml, { hint: t('x.topics'), open })}
    \${advancedSection(list, { label: t('x.fold') })}`;
  assert.deepEqual(scanAdvancedHint(adv, 'public/pages/x.js').map((h) => h.line), [2]);
  const prim = `saveBtn.disabled = true;
    saveBtn.disabled = false;
    save.disabled = !valid;
    submitBtn.disabled = n === 0;
    other.disabled = !ok;`;
  assert.deepEqual(scanPrimaryDisabled(prim).map((h) => h.line), [3, 4], 'Laden-Sperre ja, Gueltigkeits-Sperre nein');
  const ppl = `<input type="checkbox" name="participants" value="\${id}">
    <input type="checkbox" class="user-ms__checkbox" value="\${u.id}">
    <input type="checkbox" role="switch" id="member-active">
    <input type="checkbox" name="done">`;
  assert.deepEqual(scanPeopleCheckbox(ppl, 'public/pages/x.js').map((h) => h.line), [1]);
});

test('Scanner: section-action faengt btn--ghost und btn--secondary ohne --sm im Abschnittskopf und laesst Kanon durch', () => {
  const bad = `
    <div class="split-section-actions">
      <button class="btn btn--ghost btn--sm x-manage" type="button"><i data-lucide="users-round" aria-hidden="true"></i>\${t('a')}</button>
      <button class="btn btn--secondary x-create" type="button"><i data-lucide="plus" aria-hidden="true"></i>\${t('b')}</button>
    </div>`;
  assert.equal(scanSectionAction(bad).length, 2);
  const twoLabelled = `
    <div class="rw-section__actions">
      <button class="btn btn--secondary btn--sm rw-action-a" type="button"><i data-lucide="users-round" aria-hidden="true"></i>\${t('a')}</button>
      <button class="btn btn--secondary btn--sm rw-action-b" type="button"><i data-lucide="plus" aria-hidden="true"></i>\${t('b')}</button>
    </div>`;
  assert.equal(scanSectionAction(twoLabelled).length, 1, 'zwei beschriftete Aktionen werden als Fehler gemeldet');
  const good = `
    <div class="rw-section__actions">
      <button class="btn btn--secondary btn--icon btn--sm rw-section-tools popover-menu__trigger" type="button" aria-label="\${t('a')}"><i data-lucide="ellipsis" aria-hidden="true"></i></button>
      <button class="btn btn--secondary btn--sm rw-grant-bonus" type="button"><i data-lucide="plus" aria-hidden="true"></i>\${t('b')}</button>
    </div>`;
  assert.deepEqual(scanSectionAction(good), []);
});

test('Scanner: section-toolbar-create faengt nackten Erstell-Knopf im Abschnittskopf', () => {
  const bad = `
    <div class="split-panel-head section-toolbar">
      <h2>Gruppen</h2>
      <button class="btn btn--icon" id="split-add-group" aria-label="\${t('x')}">
        <i data-lucide="plus" aria-hidden="true"></i>
      </button>
    </div>`;
  assert.equal(scanSectionToolbarCreate(bad).length, 1);
  const badSectionHead = `
    <div class="split-section-head">
      <h3>Serien</h3>
      <button class="btn btn--icon x-recurring-add" aria-label="\${t('y')}">
        <i data-lucide="plus" aria-hidden="true"></i>
      </button>
    </div>`;
  assert.equal(scanSectionToolbarCreate(badSectionHead).length, 1, 'nackter Plus-Knopf in *-section-head wird gefangen');
  const good = `
    <div class="split-panel-head section-toolbar">
      <h2>Gruppen</h2>
      <button type="button" class="btn btn--secondary btn--icon btn--sm split-section-tools popover-menu__trigger"
              aria-label="\${t('common.moreActions')}">
        <i data-lucide="ellipsis" class="icon-md" aria-hidden="true"></i>
      </button>
    </div>`;
  assert.deepEqual(scanSectionToolbarCreate(good), []);
});

test('Scanner: section-action sieht den Abschnittskopf selbst und den Knopf hinter ${name} (#2119)', () => {
  const inline = `
    <div class="split-section-head">
      <h3 class="split-section-title">\${t('a')}</h3>
      \${canAct ? \`<button type="button" class="btn btn--ghost btn--sm split-recurring-add" data-recurring-add>
        <i data-lucide="plus" aria-hidden="true"></i>\${t('b')}
      </button>\` : ''}
    </div>`;
  assert.equal(scanSectionAction(inline).length, 1, 'btn--ghost direkt im *-section-head');
  const viaConst = `
  const setUp = canOpen ? \`
          <button class="btn btn--ghost btn--sm rw-money-setup" type="button">\${t('x')}</button>\` : '';
  return \`
      <section class="rw-section">
        <div class="rw-section__head">
          <h2 class="rw-section__title">\${t('y')}</h2>
          \${setUp}
        </div>
        <ul class="row-carrier"><li><button class="btn btn--ghost row-x">\${t('z')}</button></li></ul>
      </section>\`;`;
  const hits = scanSectionAction(viaConst);
  assert.equal(hits.length, 1, 'btn--ghost hinter ${setUp} im *__head - und nichts aus der Liste darunter');
  assert.match(hits[0].what, /rw-money-setup/);
  const nested = `
  const bar = \`
          <div class="split-section-actions">
            <button class="btn btn--secondary btn--sm" id="a">\${t('a')}</button>
            <button class="btn btn--secondary btn--sm" id="b">\${t('b')}</button>
          </div>\`;
  html(\`<div class="split-section-head"><div class="split-section-head__lead"><h3>\${t('c')}</h3></div>\${bar}</div>\`);`;
  assert.equal(scanSectionAction(nested).length, 1, 'zwei beschriftete Aktionen, einmal gemeldet, obwohl Kopf und Container sie beide sehen');
  const good = viaConst.replace('btn btn--ghost btn--sm rw-money-setup', 'btn btn--secondary btn--sm rw-money-setup');
  assert.deepEqual(scanSectionAction(good), []);
  const toolbar = `<div class="x-section-head section-toolbar"><button class="btn btn--secondary x-filter">\${t('f')}</button></div>`;
  assert.deepEqual(scanSectionAction(toolbar), [], 'ein Kopf, der section-toolbar ist, ist Werkzeugleiste (Suche + Filter)');
});

test('Scanner: action-hook faengt den Listener ohne Markup und laesst Menueeintrag, Helfer-id, Import und Dialog-Kanon durch (#2119)', () => {
  const bad = `
    const menu = popoverMenuHtml({ items: [{ icon: 'plus', label: t('a'), action: 'add-groupx' }] });
    root.querySelector('[data-action="add-group"]')?.addEventListener('click', open);`;
  assert.equal(scanActionHook(bad).length, 1);
  const empty = `const menu = popoverMenuHtml({ items: [] });\nroot.querySelector('[data-action="add-group"]')?.addEventListener('click', open);`;
  assert.equal(scanActionHook(empty).length, 1, 'ein leeres Menue traegt nichts');
  const good = bad.replace("'add-groupx'", "'add-group'");
  assert.deepEqual(scanActionHook(good), []);
  assert.deepEqual(scanActionHook(`x = \`<button data-action="go">\`;\ny.querySelector('[data-action="go"]');`), []);
  assert.deepEqual(scanActionHook(`areaEmptyHtml('/r', { action: { id: 'go-first', label } });\ny.querySelector('[data-action="go-first"]');`), []);
  assert.deepEqual(scanActionHook(`y.querySelector('[data-action="remove-x"]');`, [`({ action: 'remove-x' })`]), [], 'Gegenstueck im importierten Modul');
  assert.deepEqual(scanActionHook(`y.querySelector('[data-action="close-modal"]');`), []);
  assert.deepEqual(scanActionHook(`// '[data-action="old"]' war frueher hier`), [], 'Kommentar zaehlt nicht');
});

test('Scanner: cta-hook faengt die Leerzustand-Aktion mit ungebundenem Haken und laesst gebundene, onClick und Menues durch (#2210)', () => {
  const bad = `
    const action = isAdmin() ? { label: t('a'), icon: 'user-plus', className: 'rw-manage-participants' } : null;
    el.insertAdjacentHTML('beforeend', emptyState('trophy', t('b'), t('c'), action));
    el.querySelectorAll('[data-action="manage-participants"]').forEach(bind);`;
  assert.equal(scanCtaHook(bad).length, 1);
  const noHook = `mountEmptyState(el, { title: t('a'), action: { label: t('b'), icon: 'plus' } });`;
  assert.equal(scanCtaHook(noHook).length, 1, 'ohne onClick und ohne Haken');
  const good = bad.replace("className: 'rw-manage-participants'", "attrs: { 'data-action': 'manage-participants' }");
  assert.deepEqual(scanCtaHook(good), []);
  const byClass = `const action = { label: t('a'), className: 'rw-add-reward' };\nel.querySelector('.rw-add-reward')?.addEventListener('click', go);`;
  assert.deepEqual(scanCtaHook(byClass), []);
  const byData = `x({ action: { label: t('a'), attrs: { 'data-fasting-backfill': '' } } });\nel.querySelector('[data-fasting-backfill]');`;
  assert.deepEqual(scanCtaHook(byData), []);
  assert.deepEqual(scanCtaHook(`mountEmptyState(el, { action: { label: t('a'), onClick: go } });`), []);
  assert.deepEqual(scanCtaHook(`popoverMenuHtml({ items: [{ action: 'x', label: t('a'), icon: 'plus' }] });`), []);
  assert.deepEqual(scanCtaHook(`f({ action: { label: a.label, attrs: { 'data-action': a.id } } });`), [], 'Laufzeit-Wert: nicht beurteilbar');
});

test('Scanner: sheet-drag faengt Touch-Gesten an Blatt und Tafel ausserhalb des Helfers', () => {
  const bad = `
    panel.addEventListener('touchstart', (e) => {}, { passive: true });
    sheet.addEventListener("touchend", (e) => {});`;
  assert.equal(scanSheetDrag(bad, 'public/router.js').length, 2);
  assert.deepEqual(scanSheetDrag(bad, 'public/utils/sheet-drag.js'), [], 'der Helfer selbst zaehlt nicht');
  assert.deepEqual(scanSheetDrag(`rows.addEventListener('touchstart', f);\n// panel.addEventListener('touchmove', g)`, 'public/pages/x.js'), []);
});

// ---------------------------------------------------------------------------
// Der Helfer der Zeilenaktion (utils/row-action.js)
// ---------------------------------------------------------------------------

const { rowActionHtml } = await import('../public/utils/row-action.js');

test('Scanner: row-endzone-order faengt den Griff vor dem Mehr-Knopf und die Aktion dahinter, laesst [Aktion][Mehr][Griff] durch', () => {
  const griffZuerst = '<div class="list-row__actions"><button class="row-action list-row__drag" aria-label="x"><i data-lucide="grip-vertical"></i></button>${rowMenuHtml({ id: \'m\', label: l, items })}</div>';
  assert.equal(scanRowEndzoneOrder(griffZuerst).length, 1);
  const aktionDahinter = '<div>${rowMenuHtml({ id: \'m\', label: l, items })}${rowActionHtml({ icon: \'phone\', label: l })}</div>';
  assert.equal(scanRowEndzoneOrder(aktionDahinter).length, 1);
  const kanon = '<div>${rowActionHtml({ icon: \'phone\', label: l })}${rowMenuHtml({ id: \'m\', label: l, items })}<button class="row-action list-row__drag" aria-label="x"><i data-lucide="grip-vertical"></i></button></div>';
  assert.deepEqual(scanRowEndzoneOrder(kanon), []);
});

test('Scanner: row-primary-count faengt zwei sichtbare Handlungen und laesst eine plus Mehr-Knopf durch', () => {
  const zwei = '<div>${rowActionHtml({ icon: \'calendar-clock\', label: l })}${rowActionHtml({ icon: \'x\', label: l })}</div>';
  assert.equal(scanRowPrimaryCount(zwei).length, 1);
  const eine = '<div>${rowActionHtml({ icon: \'phone\', label: l })}${rowMenuHtml({ id: \'m\', label: l, items })}</div>';
  assert.deepEqual(scanRowPrimaryCount(eine), []);
});

test('Scanner: row-chevron-with-menu faengt den Wegweiser am Oeffner einer Zeile mit Mehr-Knopf, laesst reine Navigation durch', () => {
  const rezept = `
function rowEl(r) {
  const toggle = document.createElement('button');
  toggle.className = 'list-row__main--interactive recipe-row__toggle';
  toggle.insertAdjacentHTML('beforeend',
    '<i data-lucide="chevron-right" class="icon-sm" aria-hidden="true"></i>');
  more.className = 'row-action popover-menu__trigger';
}
`;
  assert.equal(scanRowChevronWithMenu(rezept).length, 1);
  const navigation = `
function areaRow(a) {
  return \`<a class="list-row" href="/x"><span class="list-row__main">\${a}</span><i data-lucide="chevron-right" aria-hidden="true"></i></a>\`;
}
`;
  assert.deepEqual(scanRowChevronWithMenu(navigation), []);
});

/* D10, DRITTER SATZ: DIE GANZE ZEILE OEFFNET (list-row.css). Gemessen vorher
 * (390px, Tipp auf Metazeile/Polster/Avatar, nicht auf ein Steuerelement):
 * in Aufgaben, Rezepten, Vorrat, Geburtstagen, Inventar, Kontakten und
 * Haushaltshilfe ging NICHTS auf - nur der Titel (Aufgaben 29 % der Flaeche)
 * bzw. der Hauptteil oeffnete. Gegen den Stand davor rot gesehen. */
test('D10: der Oeffner einer Zeile streckt sich ueber die ganze Zeile, Steuerelemente stehen darueber', () => {
  const css = readFileSync(join(PUBLIC, 'styles/list-row.css'), 'utf8');
  const rules = [...eachRule(css)];
  const row = rules.filter((r) => r.selector.trim() === '.list-row' && !r.at.length);
  assert.ok(row.some((r) => /position:\s*relative/.test(r.body) && /isolation:\s*isolate/.test(r.body)),
    '.list-row ist der Bezugsrahmen der Strecke und ihr eigener Stapelkontext');
  const stretch = rules.find((r) => /\.list-row :is\(\.u-row-title, \.list-row__main--interactive\)::after/.test(r.selector));
  assert.ok(stretch, 'das ::after des Oeffners (Zeilentitel oder antippbarer Hauptteil)');
  assert.match(stretch.body, /content:\s*""/);
  assert.match(stretch.body, /position:\s*absolute/);
  assert.match(stretch.body, /inset:\s*0/);
  const raise = rules.find((r) => /^:where\(\.list-row :is\(/.test(r.selector.trim()));
  assert.ok(raise, 'die Steuerelemente der Zeile stehen ueber der Strecke - mit Spezifitaet null (:where)');
  for (const el of ['a[href]', 'button', 'input', 'select', 'label', '[role="button"]', '[role="checkbox"]', '[role="switch"]']) {
    assert.ok(raise.selector.includes(el), `${el} steht ueber der Strecke`);
  }
  assert.match(raise.selector, /:not\(\.u-row-title, \.list-row__main--interactive\)/, 'der Oeffner selbst nicht');
  assert.match(raise.body, /position:\s*relative/);
  assert.match(raise.body, /z-index:\s*1/);
});

test('D10: kein Modul stellt den Oeffner einer Zeile selbst auf position - die Strecke endete sonst an ihm', () => {
  // Die Oeffner im Bestand: Zeilentitel und antippbarer Hauptteil, dazu die
  // Modulklassen, die diese Elemente tragen.
  const OPENERS = /\.(?:u-row-title|list-row__main--interactive|task-card__title|recipe-row__toggle|contact-item__open|pantry-row__main|documents-folder-item__select|subscription-card__main|housekeeping-task__body)(?![\w-])/;
  const found = [];
  for (const { file, src } of CSS) {
    for (const rule of eachRule(src)) {
      for (const part of rule.selector.split(/,(?![^(]*\))/).map((x) => x.trim())) {
        if (part.includes('::') || /:(?:before|after)\b/.test(part)) continue;
        // Das Subjekt ohne `:not(...)`: die Hebe-Regel nennt die Oeffner, um
        // sie AUSZUNEHMEN.
        const last = (part.split(/\s+(?![^(]*\))|>|\+|~/).filter(Boolean).pop() ?? '').replace(/:not\([^)]*\)/g, '');
        if (!OPENERS.test(last)) continue;
        const pos = rule.body.match(/(?:^|;|\s)position:\s*(relative|absolute|fixed|sticky)/);
        if (pos) found.push(`${file}: ${part} { position: ${pos[1]} }`);
      }
    }
  }
  assert.deepEqual(found, []);
});

test('Scanner: form-novalidate faengt das Formular mit Feldregeln ohne novalidate, laesst maxlength und novalidate durch', () => {
  assert.equal(scanFormNovalidate('<form id="a"><input required></form>').length, 1);
  assert.equal(scanFormNovalidate('<form id="a" novalidate><input required></form>').length, 0);
  assert.equal(scanFormNovalidate('<form id="a"><input maxlength="64"></form>').length, 0);
  const dom = "function f() {\n  const form = document.createElement('form');\n  form.insertAdjacentHTML('beforeend', '<input type=\"url\" required>');\n}\n";
  assert.equal(scanFormNovalidate(dom).length, 1);
  assert.equal(scanFormNovalidate(dom.replace("('form');", "('form');\n  form.noValidate = true;")).length, 0);
});

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

test('Beifang: das Offline-Banner laesst am Desktop die Seitenleiste frei (Re-Critique 2026-10-17)', () => {
  // Volle Breite verdeckte Logo, Suche und Einklappen der schwebenden Tafel.
  const layout = readFileSync(join(PUBLIC, 'styles/layout.css'), 'utf8');
  const desk = [...eachRule(layout)].find((r) => r.selector === '.offline-banner'
    && r.at.some((a) => /min-width:\s*1024px/.test(a)));
  assert.ok(desk, 'ab 1024px fehlt eine eigene Regel fuer .offline-banner');
  assert.match(desk.body, /left\s*:\s*calc\(var\(--sidebar-width\) \+ var\(--sidebar-float-gap\)\)/,
    'das Banner beginnt rechts der schwebenden Tafel (Spalte + Abstand zur Kante)');
  const content = [...eachRule(layout)].find((r) => r.selector === '.app-content'
    && r.at.some((a) => /min-width:\s*1024px/.test(a)) && /margin-left/.test(r.body));
  assert.match(content?.body ?? '', /margin-left\s*:\s*var\(--sidebar-width\)/, 'dieselbe Variable wie der Inhalt');
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
    // R21 S8: die Faltzeile der Kueche (layout.css, R17 K1) gleitet angedockt als
    // GANZE Werkzeugzeile hinter die Leiste; ihr Inhalt blendet mit. Bis R21 stand
    // dort `> *` - derselbe Knoten, nur ohne Namen (der Universalselektor hinter
    // :has() machte jede Einfuegung zur Stilrunde ueber das ganze Dokument).
    ['.page-toolbar--fold-row.is-collapsed:not(:focus-within):not(:has(input:not(:placeholder-shown))):not(:has(:popover-open)) > :is(.page-toolbar__center, .page-toolbar__actions, .page-toolbar__tools)',
      'Faltzeile: die ganze Werkzeugzeile gleitet hinter die Leiste, keine Zeilenaktion'],
  ]);
  const hidden = [];
  for (const { file, src } of CSS) {
    for (const rule of eachRule(src)) {
      if (!/(?:^|;|\s)opacity\s*:\s*0(?![.\d])/.test(rule.body)) continue;
      // Kommas in Klammern (`:is(a, b)`) trennen keine Selektoren.
      for (const part of rule.selector.split(/,(?![^(]*\))/).map((x) => x.trim().replace(/\s+/g, ' '))) {
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
  // R18 (2026-10-07): Einkauf, Geburtstage, Schichtplan (fuenf Listen),
  // Darlehenstilgungen und Aufgaben sind umgestellt; der Essensplan traegt
  // keinen Papierkorb mehr. Ab hier ist jede neue Zone mit mehr als zwei
  // sichtbaren Zeilenaktionen und jede Textkapsel in einer Zeile rot.
  // Leer seit R24 S10: die Leiste des Dokumentbetrachters traegt Knoepfe mit
  // Wort (G4-Dokumente-P3-3), keine geliehenen `.row-action` mehr.
  'row-action-count': {},
  'row-text-capsule': {},
  // --- R21 (Critique 2026-10-21), D10 Zeilen-Endzone, nur nach UNTEN. ---
  // Leer seit #2152: die Verwalter (Abo-Kategorien und Zahlungsarten, Familie)
  // stellen den Griff ans Ende. Kategorien- und Schnelllinks-Verwalter trugen
  // den Griff als Span VOR der Zeile - fuer diesen Scanner unsichtbar, seit
  // #2152 ist er dort ein `.row-action.list-row__drag` und damit gezaehlt.
  // Gegen den Stand vor R21 rot gesehen: Einkauf (Griff vor dem Mehr-Knopf).
  'row-endzone-order': {},
  // Bestand: dieselben Verwalter-, Formular- und Kommentarzeilen mit Stift und
  // Papierkorb wie row-danger-visible; dazu zwei benannte Ausnahmen in
  // documents.js - die Leiste der KARTE (renderActions: Auge, Herunterladen;
  // in der Zeile blendet documents.css das Auge aus) und die Werkzeugleiste
  // des Betrachters (wie row-action-count) - und housekeeping.js, wo zwei
  // Zweige einer Bedingung stehen (Profil ODER Bearbeiten, nie beide). Gegen
  // den Stand vor R21 rot gesehen: die Konten der Belohnungen (Plan + Schliessen).
  // #2152: Tag-Verwalter und Abo-Verwalter fuehren Umbenennen und Loeschen im
  // Mehr-Knopf.
  'row-primary-count': {
    'public/components/task-detail.js': 1,
    'public/pages/documents.js': 2,
    'public/pages/health-fasting.js': 1,
    'public/pages/housekeeping.js': 1,
    'public/settings/pages/personal-calendar-subscriptions.js': 1,
  },
  // Leer seit R21: gegen den Stand davor rot gesehen (Rezeptzeile).
  'row-chevron-with-menu': {},
  // Leer seit R21 S9a (28 Formulare umgestellt): gegen den Stand davor rot gesehen.
  'form-novalidate': {},
  // BESTAND 2026-10-07 (R18), nur nach UNTEN: Zeilen, die ihren Papierkorb
  // noch dauerhaft zeigen. Die Kette hat die im Auftrag genannten Listen
  // umgestellt (Einkauf, Geburtstage, Schichtplan, Darlehen, Aufgaben,
  // Essensplan); diese hier sind die uebrigen - Verwalter-Dialoge
  // (Kategorien, Etiketten, Abo-Kategorien), Formularzeilen (Zutat entfernen),
  // Kommentare, Einstellungslisten. Wer eine anfasst, zieht sie auf
  // `rowMenuHtml()` um und senkt die Zahl.
  // 2026-10-16 (Critique D6): Notizen und Haushaltshilfe-Besuche loeschen
  // ueber ihren Mehr-Knopf. R19 Schritt 4: der Kategorien-Verwalter auch.
  // #2152: Tag-Verwalter, Abo-Verwalter, Familie (Mitglied entfernen,
  // Einladung widerrufen) ebenso.
  'row-danger-visible': {
    'public/components/task-detail.js': 1,
    'public/pages/contacts.js': 1,
    'public/pages/health-fasting.js': 1,
    'public/pages/health.js': 2,
    'public/settings/pages/admin-api.js': 1,
    'public/settings/pages/personal-calendar-subscriptions.js': 1,
    'public/utils/ingredient-row.js': 1,
  },
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
  // --- Runde 7, Bestand 2026-09-27 (k7), nach der Integration (i7). Nur nach
  // UNTEN. ---
  // D3: leer - kein Modul baut den Kopfknopf selbst, die Weiche in
  // dockFabIntoToolbar (router.js) und die Regeln in layout.css sind weg.
  'toolbar-new-btn': {},
  // D7: leer seit Runde 8 (H14) - Notizen, Essensplan und der DMS-Treffer
  // "oeffnen" in Dokumenten zeigen ihre Aktionen dauerhaft.
  'hover-reveal': {},
  // D5: leer seit Runde 8 (H14) - Aufgaben, Kontakte und Dokumente waehlen
  // per Auswahlkreis und Pille.
  'row-checkbox': {},
  // D8: leer - jede Segment-/Tab-Leiste gleitet mit dem geteilten Indikator.
  'segment-indicator': {},
  // D4: leer - Breite und Lage der Kopfsuche traegt page-search.css allein.
  'search-width': {},
  // D2: leer seit Runde 7, Schritt 1 - Dialog-Sheet und Mehr-Blatt ziehen
  // ueber utils/sheet-drag.js.
  'sheet-drag': {},
  // --- Runde 14, Bestand 2026-09-28 (g14, z14), nach der Integration (i14). ---
  // D9: leer - die letzten fuenf (documents.js 1, health.js 2,
  // health-fasting.js 2) sind yuvomi-datepicker. Ab hier ist jedes neue rot.
  'native-date': {},
  // --- Issue #2042 (2026-10-17): D5 Abschnittsaktion - leer ab Beginn. ---
  // Genau EINE btn--secondary btn--sm im Abschnittskopf; kein btn--ghost.
  'section-action': {},
  // Kein nackter btn--icon mit Plus-Icon in einer section-toolbar (#2042).
  'section-toolbar-create': {},
  // --- Issue #2119 (2026-10-25): Haken mit Gegenstueck - leer ab Beginn. ---
  'action-hook': {},
  'cta-hook': {},
  // --- Critique R24 S3 (2026-10-28), E6: EIN Farbwaehler. ---
  // "Kalender verwalten" ist seit S7 eine Zeilenliste mit Bearbeiten-Blatt
  // (colorPickerHtml) - kein natives Farbfeld mehr ausserhalb des Bausteins.
  'native-color': {},
  // Kuratierte TOKEN-Toene (Kontofarben, Kategorietoene) gehen seit S10 durch
  // colorPickerHtml({ options, custom: false }) - der Baustein nimmt
  // Token-Ausdruecke als `paint`.
  'swatch-dialect': {},
  // --- Critique R24 S3: Dialogregeln (DESIGN.md D4). Gebaut sind Regel und
  // Helfer, angewendet wird je Modul in S7-S11; die Listen sinken dort.
  // S7 Zeit (Kalender, Schichtplan, Geburtstage), S8 (Aufgaben, Belohnungen,
  // Haushaltshilfe, Entsorgung), S9 Kueche, S10 Geld & Ablage, S11
  // Gesundheit/Kontakte/Familie; Schnellzugriffe und Einstellungen S6.
  // R24 S11: Gesundheit, Kontakte, Geburtstage, Schnellzugriffe und die
  // Einstellungsblaetter der Gesundheit und der Adressbuch-Synchronisation
  // sind umgestellt. R24 S12: Termin, Notiz und eigenes Schichtplan-Feld
  // ebenso - die Liste ist leer.
  'edit-autofocus': {},
  'advanced-hint': {},
  // Die Rechte-Matrix hat seit R24 S11 (E11) keinen Speichern-Knopf mehr; der
  // Schichtplan meldet "Extra ohne Schichttyp" seit R24 S12 beim Absenden.
  'primary-disabled': {},
  'people-checkbox': {},
};

const HEAD_SEARCH = headSearchClasses(JS);
const JS_BY_FILE = new Map(JS.map(({ file, src }) => [file, src]));

const RULES = {
  'row-action': { files: JS, scan: (s) => scanRowAction(s), canon: '`.row-action` / `.row-action--danger` (utils/row-action.js `rowActionHtml`)' },
  'row-action-name': { files: JS, scan: (s) => scanRowActionName(s), canon: 'aria-label mit Objekt, z. B. `t(\'common.deleteNamed\', { name })`' },
  'row-action-count': { files: JS, scan: (s) => scanRowActionCount(s), canon: 'hoechstens zwei sichtbare `.row-action` je Zeile, der Rest in `rowMenuHtml()` (utils/row-action.js)' },
  'row-endzone-order': { files: JS, scan: (s) => scanRowEndzoneOrder(s), canon: 'Endzone [eine Handlung][Mehr-Knopf][Griff] - der Griff zuletzt, keine Aktion hinter dem Mehr-Knopf (DESIGN.md D10)' },
  'row-primary-count': { files: JS, scan: (s) => scanRowPrimaryCount(s), canon: 'hoechstens EINE sichtbare Handlung je Zeile, der Rest in `rowMenuHtml()` (DESIGN.md D10)' },
  'form-novalidate': { files: JS, scan: (s) => scanFormNovalidate(s), canon: '`<form novalidate>` + `reportFieldErrors(constraintErrors(form))` (components/modal.js) - keine Browser-Blase' },
  'row-chevron-with-menu': { files: JS, scan: (s) => scanRowChevronWithMenu(s), canon: 'Chevron nur an reiner Navigation; eine Zeile mit Mehr-Knopf traegt keinen (DESIGN.md D10)' },
  'row-text-capsule': { files: JS, scan: (s) => scanRowTextCapsule(s), canon: 'Bearbeiten/Loeschen einer Listenzeile = `rowMenuHtml()`, keine beschriftete `.btn`-Kapsel' },
  'row-danger-visible': { files: JS, scan: (s) => scanRowDangerVisible(s), canon: 'Loeschen einer Zeile = Eintrag in `rowMenuHtml()` (`danger: true`), kein sichtbarer Papierkorb' },
  'search-field': { files: JS, scan: (s) => scanSearchField(s), canon: '`renderPageSearch()` aus utils/page-search.js (gefuellte Kapsel)' },
  'list-rows': { files: [...JS, ...CSS], scan: (s, f) => (f.endsWith('.css') ? scanListRowsCss(s) : scanListRowsJs(s)), canon: '`.row-carrier` (list-row.css)' },
  'floating-fab': { files: JS, scan: (s) => scanFloatingFab(s), canon: '`page-fab` mit `dockLabel` (utils/fab.js)' },
  'body-actions': { files: JS, scan: (s) => scanBodyActions(s), canon: '`.modal-panel__footer` (mountFooter hebt sie an den Blattrand)' },
  'cancel-ghost': { files: JS, scan: (s) => scanCancelGhost(s), canon: 'Abbrechen = `btn btn--secondary` (nie ghost)' },
  'footer-icon-delete': { files: JS, scan: (s) => scanFooterIconDelete(s), canon: 'Loeschen im Dialogfuss = `btn btn--danger-outline` mit Text, links' },
  'settings-checkbox': { files: JS, scan: (s, f) => scanSettingsCheckbox(s, f), canon: '`toggleRowHtml({ ..., control: \'switch\' })`' },
  'dead-i-rule': { files: CSS, scan: (s) => scanDeadIRules(s), canon: 'keine Regel auf `<i>` - Lucide rendert `<svg>`; auf `svg` zielen' },
  'toolbar-new-btn': { files: [...JS, ...CSS], scan: (s) => scanToolbarNewBtn(s), canon: '`createPageFab({ dockLabel })` (utils/fab.js) - die Shell dockt ihn an' },
  'hover-reveal': { files: CSS, scan: (s) => scanHoverReveal(s), canon: 'Aktionen dauerhaft sichtbar, ruhig per Tertiaerfarbe (ignore.md)' },
  'row-checkbox': { files: JS, scan: (s) => scanRowCheckbox(s), canon: 'Auswahlkreis ersetzt den Statuskreis, Leiste = `setBulkPill()` (utils/bulk-pill.js)' },
  'segment-indicator': { files: JS, scan: (s, f) => scanSegmentIndicator(s, f), canon: '`attachSegmentIndicator(bar)` bzw. `renderSubTabs({ indicator })` (utils/segment-indicator.js)' },
  'search-width': { files: CSS.filter((f) => f.file !== 'public/styles/page-search.css'), scan: (s) => scanSearchWidth(s, HEAD_SEARCH), canon: '`--page-search-width` + Center-Slot (page-search.css), keine Modulbreite' },
  'sheet-drag': { files: JS, scan: (s, f) => scanSheetDrag(s, f), canon: '`wireSheetDrag()` (utils/sheet-drag.js)' },
  'native-date': { files: JS, scan: (s, f) => scanNativeDate(s, f), canon: '`<yuvomi-datepicker type="date">` (components/datepicker.js)' },
  'section-action': { files: JS, scan: (s) => scanSectionAction(s), canon: 'genau EINE `btn--secondary btn--sm` (Icon + Wort) im Abschnittskopf; Nebenaktionen hinter `popover-menu__trigger` mit `<modul>-section-tools` (DESIGN.md D5)' },
  'section-toolbar-create': { files: JS, scan: (s) => scanSectionToolbarCreate(s), canon: 'Erstell-Aktion im Abschnittskopf hinter `popover-menu__trigger`, kein nackter `btn--icon` mit Plus-Icon (DESIGN.md D5)' },
  'action-hook': { files: JS, scan: (s, f) => scanActionHook(s, importedSources(s, f, JS_BY_FILE)), canon: 'jedes `[data-action="x"]` im Listener hat ein `x` im Markup derselben Datei oder eines importierten Moduls (#2119)' },
  'native-color': { files: JS, scan: (s, f) => scanNativeColor(s, f), canon: '`colorPickerHtml()` + `wireColorPicker()` (utils/color-picker.js) - Familientoene, "Eigene" dahinter (E6)' },
  'edit-autofocus': { files: JS, scan: (s) => scanEditAutofocus(s), canon: '`initialFocus: \'edit\'` an jedem Dialog, der auch bearbeitet (components/modal.js, R23 D13)' },
  'advanced-hint': { files: JS, scan: (s, f) => scanAdvancedHint(s, f), canon: '`advancedSection(html, { hint })` - "Weitere Angaben" nennt, was dahinter liegt (Inventar-Muster)' },
  'primary-disabled': { files: JS, scan: (s) => scanPrimaryDisabled(s), canon: 'Primaerknopf immer aktiv, Pruefung beim Absenden (`reportFieldErrors(constraintErrors(form))`)' },
  'people-checkbox': { files: JS, scan: (s, f) => scanPeopleCheckbox(s, f), canon: '`renderUserMultiSelect()` (components/user-multi-select.js) statt nativer Kaestchen je Person' },
  'swatch-dialect': { files: JS, scan: (s, f) => scanSwatchDialect(s, f), canon: '`.color-swatch` aus `colorPickerHtml()` (utils/color-picker.js), keine eigene Swatch-Klasse je Modul' },
  'cta-hook': { files: JS, scan: (s) => scanCtaHook(s), canon: 'eine Leerzustand-Aktion ohne `onClick` traegt einen Haken (`attrs: { \'data-action\' }`, `id`, Klasse), den die Datei bindet (#2210)' },
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

test('Kopfsuche: EINE Breite als Token und EINE Stelle, beides in page-search.css (Re-Critique 2026-09-27, A8 P3-2)', () => {
  const css = readFileSync(join(PUBLIC, 'styles/page-search.css'), 'utf8');
  assert.match(css, /--page-search-width:\s*320px/);
  const desk = [...eachRule(css)].find((r) => r.at.some((a) => /min-width:\s*1024px/.test(a)) && /\.page-toolbar > label\.page-search/.test(r.selector));
  assert.ok(desk, 'die Desktop-Regel der Kopfsuche fehlt');
  assert.match(desk.body, /max-width:\s*var\(--page-search-width\)/);
  assert.match(desk.body, /flex:\s*0 1 var\(--page-search-width\)/);
  assert.match(desk.body, /margin-inline-start:\s*0/, 'keine Suche am Zeilenende (Notizen, Einstellungen)');
  // Eigene Regel (F4.2): in einer Liste mit dem :has() fiel ohne :has() auch die Suche selbst.
  const slot = [...eachRule(css)].find((r) => r.at.some((a) => /min-width:\s*1024px/.test(a)) && /\.page-toolbar__center:has\(> label\.page-search:only-child\)/.test(r.selector));
  assert.ok(slot, 'ein Wrapper-Slot nur mit der Suche ist dieselbe Stelle');
  assert.equal(slot.body.replace(/\s+/g, ' '), desk.body.replace(/\s+/g, ' '), 'Slot und Suche teilen dieselbe Breite');
});

test('jedes Suchfeld aus renderPageSearch ist verdrahtet: wirePageSearch mit derselben id in derselben Datei', () => {
  // Die Kapsel bringt einen Loeschen-Knopf mit, der `hidden` startet; nur
  // wirePageSearch blendet ihn beim Tippen ein und leert damit die Suche.
  // page-search.css unterdrueckt das native Kreuz. Ein Feld mit eigenem
  // `input`-Listener hat also KEIN Loeschen (Kalender-Suche, Codex an #1478).
  const idOf = (m) => m[1].trim();
  const offenders = [];
  for (const { file, src } of JS) {
    if (file.endsWith('page-search.js')) continue;
    const rendered = [...src.matchAll(/renderPageSearch\(\{[\s\S]*?\bid:\s*([^,\n}]+)/g)].map(idOf);
    if (!rendered.length) continue;
    const wired = new Set([...src.matchAll(/wirePageSearch\([^,]+,\s*\{[\s\S]*?\bid:\s*([^,\n}]+)/g)].map(idOf));
    for (const id of rendered) if (!wired.has(id)) offenders.push(`${file}: ${id}`);
  }
  assert.ok(JS.some(({ src }) => src.includes('renderPageSearch(')), 'Vorbedingung: der Scanner findet Suchfelder');
  assert.deepEqual(offenders, []);
});

test('Dialog-Fussleisten schieben mit logischem Rand: kein Inline-Stil setzt margin-left/right: auto (RTL)', () => {
  // Der Loeschen-Knopf links in `.modal-panel__footer` rueckt per Auto-Rand von
  // Abbrechen/Speichern ab. `margin-right: auto` ist in ar/fa der Rand VOR dem
  // Knopf - er klebte dort neben der Primaeraktion (Codex an #1478). Budget und
  // Muell nutzten schon `margin-inline-end: auto`.
  const offenders = [];
  for (const { file, src } of JS) {
    src.split('\n').forEach((line, i) => {
      if (/style="[^"]*margin-(?:left|right)\s*:\s*auto/.test(line)) offenders.push(`${file}:${i + 1}`);
    });
  }
  // Seit R22 (S10) traegt kein Fuss mehr einen Inline-Rand (Guard weiter
  // unten); die Vorbedingung ist deshalb nur noch, dass der Scanner Inline-Stile
  // ueberhaupt sieht.
  assert.ok(JS.some(({ src }) => /style="[^"]*margin[\w-]*\s*:/.test(src)), 'Vorbedingung: der Scanner sieht Inline-Stile');
  assert.deepEqual(offenders, []);
});

test('R22 D20: die Formular-Fuesse von Notizen, Kontakten und Geburtstagen tragen keinen Inline-Stil', () => {
  // Den Anfangsrand des Loeschen-Knopfs haelt seit R16 EINE Regel an
  // `.modal-panel__delete` (layout.css, gesetzt von decorateFooterDelete) -
  // das `style="margin-inline-end:auto"` je Modul war ein Rest davon. Die
  // drei Module dieses Schritts sind frei; die uebrigen (Budget, Abos,
  // Gesundheit, Entsorgung, Schnelllinks) folgen in ihren Schritten.
  const offenders = [];
  for (const { file, src } of JS) {
    if (!/pages\/(notes|contacts|birthdays)\.js$/.test(file)) continue;
    src.split('\n').forEach((line, i) => {
      if (/<button[^>]*(?:modal-delete|cm-delete|bd-delete)[^>]*style="/.test(line)
        || /btn--danger-outline"[^>]*style="/.test(line)) offenders.push(`${file}:${i + 1}`);
    });
  }
  assert.equal(JS.filter(({ file }) => /pages\/(notes|contacts|birthdays)\.js$/.test(file)).length, 3, 'Vorbedingung: der Scanner sieht die drei Seiten');
  assert.deepEqual(offenders, []);
});

test('R22 D9: die Dialog-Fuesse von Budget, Plan und Abos tragen keinen Inline-Stil', () => {
  // Wie die drei Module aus D20: den Anfangsrand haelt `.modal-panel__delete`
  // (layout.css), die Gruppe Abbrechen/Speichern `.modal-panel__footer-group`.
  // Ein `<span>` um das Wort am Loeschen-Knopf blieb mobil sichtbar, weil
  // decorateFooterDelete nur loses Wort und `.btn__label` zur Wortspanne macht.
  const PAGES = /pages\/(budget|budget-plans|subscriptions)\.js$/;
  const offenders = [];
  for (const { file, src } of JS) {
    if (!PAGES.test(file)) continue;
    src.split('\n').forEach((line, i) => {
      if (/btn--danger-outline"[^>]*style="/.test(line)
        || /style="[^"]*margin-inline-end\s*:\s*auto/.test(line)
        || /style="display:flex;gap:var\(--space-\d\)/.test(line)) offenders.push(`${file}:${i + 1}`);
    });
    for (const m of src.matchAll(/btn--danger-outline"[^>]*>\s*<i data-lucide="trash-2"[^>]*><\/i><span>/g)) {
      offenders.push(`${file}: <span> am Loeschen-Wort (${m.index})`);
    }
  }
  assert.equal(JS.filter(({ file }) => PAGES.test(file)).length, 3, 'Vorbedingung: der Scanner sieht die drei Seiten');
  assert.deepEqual(offenders, []);
});

test('R22 S10: kein Dialogfuss der App schiebt oder gruppiert per Inline-Stil', () => {
  // Der Rest nach D9/D12/D20: Entsorgung, Schnelllinks, Aufteilung, Einkauf,
  // Aufgaben, Mahlzeit, Rezept und Kalender trugen noch je ein
  // `style="margin-inline-end:auto"` am Loeschen-Knopf oder ein
  // `style="display:flex;gap:..."` um Abbrechen und Speichern. Den Anfangsrand
  // geben `.modal-panel__delete` und `.modal-panel__footer-start`, die Gruppe
  // `.modal-panel__footer-group` (layout.css) - jetzt in JEDEM Skript der App.
  const offenders = [];
  for (const { file, src } of JS) {
    if (!/^public\/(pages|settings|components|utils)\//.test(file)) continue;
    src.split('\n').forEach((line, i) => {
      if (/style="[^"]*margin-inline-end\s*:\s*auto/.test(line)
        || /style="display:flex;gap:var\(--space-\d\)/.test(line)) offenders.push(`${file}:${i + 1}`);
    });
  }
  assert.ok(JS.filter(({ file }) => /^public\/pages\//.test(file)).length > 20, 'Vorbedingung: der Scanner sieht die Seiten');
  assert.deepEqual(offenders, []);
  const layout = CSS.find(({ file }) => file === 'public/styles/layout.css')?.src ?? '';
  const push = [...eachRule(layout)].find((r) => /\.modal-panel__footer > \.modal-panel__footer-start/.test(r.selector));
  assert.ok(push && /margin-inline-end:\s*auto/.test(push.body), '.modal-panel__footer-start schiebt den Rest ans Ende');
  // Ohne `:has()` (Chrome 87) verwirft der Browser eine Selektorliste ganz:
  // der Schub am Loeschen-Knopf steht deshalb in einer Regel ohne `:has()`.
  const del = [...eachRule(layout)].find((r) => /\.modal-panel__footer > \.modal-panel__delete(?![\w-])/.test(r.selector) && /margin-inline-end:\s*auto/.test(r.body));
  assert.ok(del && !/:has\(/.test(del.selector), `der Schub am Loeschen-Knopf haengt an keiner :has()-Liste: ${del?.selector}`);
});

test('R22 D12: die Dialog-Fuesse der Gesundheit und ihres Einstellungsblatts tragen keinen Inline-Stil', () => {
  // Dieselbe Regel wie D9/D20: den Anfangsrand des Loeschen-Knopfs haelt
  // `.modal-panel__delete` (layout.css, decorateFooterDelete). Neun Dialoge der
  // Gesundheit (Messung, Einnahme, Medikament, Befund, Training, Vorsorge,
  // Naehrwerte, Periode, Tag) und die Vorsorge-Art im Einstellungsblatt
  // schoben ihn noch je selbst weg.
  const PAGES = /(pages\/health(?:-fasting)?\.js|settings\/pages\/modules-health\.js)$/;
  const offenders = [];
  for (const { file, src } of JS) {
    if (!PAGES.test(file)) continue;
    src.split('\n').forEach((line, i) => {
      if (/btn--danger-outline"[^>]*style="/.test(line)
        || /style="[^"]*margin-inline-end\s*:\s*auto/.test(line)) offenders.push(`${file}:${i + 1}`);
    });
  }
  assert.equal(JS.filter(({ file }) => PAGES.test(file)).length, 3, 'Vorbedingung: der Scanner sieht die drei Dateien');
  assert.deepEqual(offenders, []);
});

test('R24 Loeschen: EINE Form app-weit - `btn--danger-outline` mit Wort, kein `danger-ghost` mehr (G0-Shell-P3-1)', () => {
  // Bis R24 stand Loeschen in Leseblatt, Detailspalte, Popover und
  // Notiz-Lesedialog als `danger-ghost` (roter Text ohne Kante), im
  // Dialogfuss als `danger-outline`: dieselbe Handlung in zwei Gewichten.
  const offenders = [];
  for (const { file, src } of JS) {
    src.split('\n').forEach((line, i) => {
      if (/danger-ghost/.test(line) && !/^\s*(?:\/\/|\*)/.test(line)) offenders.push(`${file}:${i + 1}`);
    });
  }
  assert.deepEqual(offenders, []);
  const css = readdirSync(new URL('../public/styles/', import.meta.url)).filter((f) => f.endsWith('.css'))
    .flatMap((f) => [...eachRule(readFileSync(new URL(`../public/styles/${f}`, import.meta.url), 'utf8'))].map((r) => r.selector));
  assert.ok(!css.some((sel) => /\.btn--danger-ghost\b/.test(sel)), 'keine Regel fuer `.btn--danger-ghost`');
  // Der Notiz-Lesedialog schaltet das Gewicht nicht mehr um.
  const notes = JS.find(({ file }) => file.endsWith('pages/notes.js')).src;
  const sync = notes.slice(notes.indexOf('function syncFooter(view)'), notes.indexOf('function animatePane('));
  assert.doesNotMatch(sync, /classList\.toggle\('btn--danger/);
  assert.match(notes, /<button type="button" class="btn btn--danger-outline" id="note-modal-delete">/);
});

test('Auswahlkreis: EIN Baustein in der Shell (layout.css), jede Mehrfachauswahl nutzt ihn (R8 H14)', () => {
  // Aufgaben (R7), Kontakte und Dokumente (R8) waehlen per `.select-circle`.
  // Modul-CSS laedt nur auf seiner Route - stuende der Kreis dort, braeuchte
  // jedes weitere Modul eine Kopie, und die Kopien laufen auseinander (so kam
  // er in Runde 8 zweimal gleichlautend in documents.css und contacts.css an).
  // Kontextregeln (`.contact-item__select .select-circle:disabled`) bleiben im
  // Modul; die Form selbst (Selektor BEGINNT mit dem Kreis) wohnt nur in der Shell.
  const homes = new Set();
  for (const { file, src } of CSS) {
    for (const { selector } of eachRule(src)) {
      if (selector.split(',').some((part) => /^\.select-circle\b/.test(part.trim()))) homes.add(file);
    }
  }
  assert.deepEqual([...homes], ['public/styles/layout.css']);
  for (const page of ['tasks', 'contacts', 'documents']) {
    const src = JS.find(({ file }) => file === `public/pages/${page}.js`)?.src ?? '';
    assert.match(src, /<button type="button" class="select-circle[^"]*"/, `${page}.js waehlt per Auswahlkreis`);
  }
});

// ---------------------------------------------------------------------------
// Die Rueckfrage der Sammelaktions-Pille (utils/bulk-pill.js) als Programm
//
// ANLASS (R11, 2026-09-27): die Dokumente-Auswahl zog in die Pille, und dabei
// ging der Satz verloren, der vor dem Sammel-Loeschen stand - einen Papierkorb
// gibt es nicht. Die Frage selbst kann ihn nicht tragen: gemessen bei 390px
// passte "12 Dokumente endgueltig loeschen? Kein Papierkorb." in 15 von 24
// Sprachen nicht in eine Zeile (die Frage bricht bewusst nicht innen um).
// Also traegt die Rueckfrage eine optionale Detailzeile - eigene Zeile unter
// Frage und Wahl, im Gruppennamen mitgelesen, und wer sie nicht setzt, bekommt
// die Pille wie bisher.
// ---------------------------------------------------------------------------

class PillEl {
  constructor(tag) {
    this.tagName = tag.toUpperCase();
    this.children = [];
    this.attrs = {};
    this.classes = new Set();
    this.listeners = {};
    this.textContent = '';
    this.disabled = false;
    this.id = '';
    this.classList = { add: (c) => this.classes.add(c), contains: (c) => this.classes.has(c) };
  }
  set className(v) { this.classes = new Set(String(v).split(/\s+/).filter(Boolean)); }
  get className() { return [...this.classes].join(' '); }
  setAttribute(k, v) { this.attrs[k] = String(v); }
  getAttribute(k) { return this.attrs[k] ?? null; }
  appendChild(c) { this.children.push(c); return c; }
  addEventListener(type, fn) { this.listeners[type] = fn; }
  all() { return this.children.flatMap((c) => [c, ...c.all()]); }
  querySelectorAll(sel) { return this.all().filter((c) => c.classes.has(sel.replace(/^\./, ''))); }
  querySelector(sel) { return this.querySelectorAll(sel)[0] ?? null; }
  contains() { return false; }
  focus() {}
}

async function withPillDom(run) {
  const layer = { bar: null, replaceChildren(...n) { this.bar = n[0] ?? null; }, querySelector() { return this.bar; } };
  const saved = globalThis.document;
  globalThis.document = {
    activeElement: null,
    getElementById: (id) => (id === 'bulk-pill-layer' ? layer : null),
    createElement: (tag) => new PillEl(tag),
  };
  try {
    const { setBulkPill } = await import('../public/utils/bulk-pill.js');
    await run({ setBulkPill, layer });
  } finally {
    globalThis.document = saved;
  }
}

/** Oeffnet die Rueckfrage der ersten Kapsel und liefert die Pille danach. */
function openConfirm(layer) {
  layer.bar.querySelector('.list-bulkbar__action').listeners.click();
  return layer.bar;
}

test('Pillen-Rueckfrage: confirm.detail steht als eigene Zeile unter Frage und Wahl und im Gruppennamen', async () => {
  await withPillDom(async ({ setBulkPill, layer }) => {
    setBulkPill({ label: '3 ausgewaehlt', actions: [
      { label: 'Loeschen', count: 3, danger: true, confirm: { question: '3 Dokumente loeschen?', detail: 'Kein Papierkorb.' }, onClick() {} },
    ] });
    // Im Ruhezustand steht die Detailzeile nicht - sie gehoert zur Frage.
    assert.equal(layer.bar.querySelector('.list-bulkbar__detail'), null);

    const bar = openConfirm(layer);
    assert.ok(bar.classes.has('list-bulkbar--confirming'));
    const detail = bar.querySelector('.list-bulkbar__detail');
    assert.ok(detail, 'die Rueckfrage zeigt ihre Detailzeile');
    assert.equal(detail.textContent, 'Kein Papierkorb.');
    // Direktes Kind der Pille NACH dem Paar: eine eigene Zeile unter Frage und
    // Wahl, nicht zwischen Abbrechen und Bestaetigen.
    const kinder = bar.children.map((c) => c.className);
    assert.deepEqual(kinder, ['list-bulkbar__subject', 'list-bulkbar__choices', 'list-bulkbar__detail']);
    // Der Fokuswechsel in die Gruppe liest ihren Namen - der Satz muss darin
    // stehen, sonst hoert ihn niemand (die Rueckfrage hat keine Live-Region).
    const ids = bar.getAttribute('aria-labelledby').split(/\s+/);
    assert.deepEqual(ids, [bar.children[0].id, detail.id]);
    assert.ok(detail.id && detail.id !== bar.children[0].id);
  });
});

test('Pillen-Rueckfrage: ohne confirm.detail bleibt die Pille, wie sie war', async () => {
  await withPillDom(async ({ setBulkPill, layer }) => {
    setBulkPill({ label: '2 ausgewaehlt', actions: [
      { label: 'Loeschen', danger: true, confirm: { question: '2 Aufgaben loeschen?' }, onClick() {} },
    ] });
    const bar = openConfirm(layer);
    assert.equal(bar.querySelector('.list-bulkbar__detail'), null);
    assert.deepEqual(bar.children.map((c) => c.className), ['list-bulkbar__subject', 'list-bulkbar__choices']);
    assert.equal(bar.getAttribute('aria-labelledby'), bar.children[0].id);
  });
});

test('Pillen-Rueckfrage: die Detailzeile nimmt eine ganze Zeile und bricht innen um', () => {
  // Die Frage bricht nicht innen um (sie schiebt die Wahl in die naechste
  // Zeile, test:frontend-audit) - die Detailzeile schon: sie ist in manchen
  // Sprachen laenger als die Pille breit ist. Ohne `white-space: normal` erbte
  // sie nichts Kappendes, aber auch nichts, das sie haelt; ohne die volle Basis
  // stuende sie neben der Wahl und quetschte das Paar.
  const layout = readFileSync(join(PUBLIC, 'styles/layout.css'), 'utf8');
  const rule = [...eachRule(layout)].find((r) => r.selector.trim() === '.list-bulkbar__detail' && !r.at.length);
  assert.ok(rule, '.list-bulkbar__detail braucht eine Basisregel in layout.css (Shell-Schicht)');
  assert.match(rule.body, /flex:\s*1\s+0\s+100%|flex-basis:\s*100%/, 'eine eigene Zeile');
  assert.match(rule.body, /white-space:\s*normal/, 'bricht innen um');
  assert.match(rule.body, /font-size:\s*var\(--text-/, 'Schriftgroesse aus den Tokens');
});

// R23 D8 (Critique 2026-10-24 Q2): EIN Schalter in den Moduldialogen. Bis R23
// standen drei Bauformen nebeneinander - die nackte `.toggle`-Bahn mit Text
// rechts (ohne role=switch), `.rw-switch`/`.form-check` als System-Checkbox und
// der Settings-Schalter. Jetzt: Moduldialoge bauen ihn mit formSwitchRowHtml
// (settings/components.js, Label links, role=switch). Eine freistehende
// `.toggle`-Bahn bleibt nur, wo eine Zeile ihren Namen schon traegt (Teilnehmer,
// Overlay-Feld, Jahr unbekannt) - dann aber mit role=switch.
test('D8: kein Moduldialog baut einen Schalter von Hand (role=switch, keine System-Checkbox als Schalter)', () => {
  const files = ALL_FILES.map((path) => ({ path, rel: relative(REPO, path).split(sep).join('/') }))
    .filter((f) => /^public\/(?:(?:pages|components|utils)\/.*|[^/]+)\.js$/.test(f.rel) && !f.rel.endsWith('.min.js'));
  assert.ok(files.length > 50, 'die Suche sieht die Module');
  const offenders = [];
  for (const { path, rel } of files) {
    const src = readFileSync(path, 'utf8');
    for (const m of src.matchAll(/<label class="toggle\b[^"]*"[^>]*>\s*(?:'\s*\+\s*')?<input\b([^>]*)>/g)) {
      if (!/role="switch"/.test(m[1])) offenders.push(`${rel}: .toggle ohne role=switch`);
    }
    for (const m of src.matchAll(/class="(form-check|rw-switch)\b/g)) offenders.push(`${rel}: ${m[1]}`);
  }
  assert.deepEqual(offenders, []);
});

// Critique R23 (N3): EIN Ziehbild. Der Platz an der Zielstelle war je Modul ein
// 40-%-Abbild der Zeile und das mitgefuehrte Abbild SortableJS' 80 % - die Zeile
// stand zweimal halb da, und die Nachbarn federten mit `--ease-glass`.
test('N3: der Ziehplatz ist ein leerer Schlitz, das Ziehbild deckend, die Kurve ohne Feder', () => {
  const cssFiles = ALL_FILES.filter((f) => f.endsWith('.css'));
  const ghostRules = [];
  for (const path of cssFiles) {
    for (const rule of eachRule(readFileSync(path, 'utf8'))) {
      if (/\.sortable-(?:ghost|drag)\b/.test(rule.selector) && /(?:^|;)\s*opacity\s*:/.test(rule.body)) {
        ghostRules.push(`${relative(REPO, path).split(sep).join('/')}: ${rule.selector.trim()}`);
      }
    }
  }
  assert.deepEqual(ghostRules.sort(), ['public/styles/layout.css: .sortable-ghost'],
    'die Deckung des Platzes steht EINMAL in layout.css, das Ziehbild traegt keine eigene');
  const layout = [...eachRule(readFileSync(join(PUBLIC, 'styles/layout.css'), 'utf8'))];
  const ghost = layout.find((r) => r.selector.trim() === '.sortable-ghost' && !r.at.length);
  assert.match(ghost.body, /opacity:\s*1\b/);
  assert.ok(layout.some((r) => r.selector.trim() === '.sortable-ghost > *' && /visibility:\s*hidden/.test(r.body)), 'der Inhalt des Platzes ist unsichtbar');
  const sortable = readFileSync(join(PUBLIC, 'utils/sortable.js'), 'utf8');
  assert.match(sortable, /onStart\(\) \{ liftDragImage\(\); \}/, 'die Inline-0.8 von SortableJS wird zurueckgenommen');
  assert.match(sortable, /clone\.style\.opacity = ''/);
  assert.match(sortable, /easing: easingToken\('--ease-out'/);
  assert.doesNotMatch(sortable, /--ease-glass'/);
});

// Critique R23 (D10, G3/G4): ein Gruppentitel IN einer Liste ist Wort plus
// Zaehlstand, ohne Zeichen. Einkauf, Vorrat und Inventar stellten das
// Kategorie- bzw. Ort-Icon davor - gegen den Kanon "Ueberschrift ueber Inhalt"
// (DESIGN.md, Icon vor dem Titel). Das Icon bleibt im Kategorie-Verwalter und in
// den Auswahlen. Gelesen wird je Fundstelle von `list-group__title` bis zum
// Zaehlstand; nur der Auf/Zu-Winkel darf darin stehen.
test('D10: kein Gruppentitel einer Liste traegt ein Zeichen (nur der Auf/Zu-Winkel)', () => {
  const files = ALL_FILES.filter((f) => /\/pages\/[^/]+\.js$/.test(f.split(sep).join('/')));
  const offenders = [];
  let sites = 0;
  for (const path of files) {
    const src = readFileSync(path, 'utf8');
    for (const m of src.matchAll(/list-group__title/g)) {
      const rest = src.slice(m.index, m.index + 700);
      const end = rest.indexOf('list-group__count');
      if (end < 0) continue;
      sites += 1;
      for (const icon of rest.slice(0, end).matchAll(/data-lucide="([^"]+)"/g)) {
        if (icon[1] !== 'chevron-down') offenders.push(`${relative(REPO, path).split(sep).join('/')}: ${icon[1]}`);
      }
    }
  }
  assert.ok(sites >= 5, `Vorbedingung: der Scanner sieht die Gruppentitel (${sites})`);
  assert.deepEqual(offenders, []);
});

// Critique R23 (G4 "Kategoriebalken drei Bauformen"): die Abo-Aufteilung baute
// ihren Balken selbst (8px-Literal, --color-surface-3, <i> mit width-Prozent im
// Modulton, Name abgeschnitten). Jetzt teilt sie Bahn und Fuellung mit der
// Kategoriezeile von Uebersicht und Statistik.
test('Kategoriebalken: die Abo-Aufteilung nimmt Bahn und Fuellung der Kategoriezeile (R23)', () => {
  const subsJs = readFileSync(join(PUBLIC, 'pages/subscriptions.js'), 'utf8');
  assert.match(subsJs, /class="subscriptions-chart-row__track" aria-hidden="true"><span class="budget-bar-row__fill budget-bar-row__fill--expenses" style="--bar-scale:/);
  assert.doesNotMatch(subsJs, /<i style="width:/, 'kein eigener Balken per width');
  const budget = [...eachRule(readFileSync(join(PUBLIC, 'styles/budget.css'), 'utf8'))];
  const track = budget.find((r) => !r.at.length && /\.budget-bar-row__track\b/.test(r.selector) && /\.subscriptions-chart-row__track\b/.test(r.selector));
  assert.ok(track, 'eine Regel fuer beide Bahnen');
  assert.match(track.body, /background-color:\s*var\(--color-fill-well\)/);
  const subs = [...eachRule(readFileSync(join(PUBLIC, 'styles/subscriptions.css'), 'utf8'))];
  const own = subs.filter((r) => /\.subscriptions-chart-row__track\b/.test(r.selector) && /(?:height|background)\s*:/.test(r.body));
  assert.deepEqual(own.map((r) => r.selector.trim()), [], 'keine zweite Bahn in subscriptions.css');
  const label = subs.find((r) => r.selector.trim() === '.subscriptions-chart-row__label');
  assert.doesNotMatch(label?.body ?? 'nowrap', /nowrap|ellipsis/, 'der Name bricht um, wie in der Kategoriezeile');
});

// --------------------------------------------------------------------------
// R23 S8 (D13, Layout): die Regeln, die eine Breite, eine Spalte oder ein
// Wechsel einhalten muss. Gemessen im Browser (handoff-8), hier als Form
// gepinnt, damit sie nicht still zurueckfallen.
// --------------------------------------------------------------------------
const readPub = (rel) => readFileSync(join(PUBLIC, rel), 'utf8');
const rulesOf = (rel) => [...eachRule(readPub(rel))];
const fnBody = (src, start, end) => src.slice(src.indexOf(start), src.indexOf(end, src.indexOf(start) + start.length));

test('R23 D13: Kanban-Wechsel ohne Zwischenbild - alte Ansicht bleibt, Kopf und Koerper tauschen zusammen', () => {
  const tasks = readPub('pages/tasks.js');
  const set = fnBody(tasks, 'function setViewMode(', '\n}\n');
  assert.doesNotMatch(set, /style\.opacity\s*=\s*'0\.4'/, 'kein Dimmen der alten Ansicht (blasses Zwischenbild, Critique G2)');
  assert.doesNotMatch(set, /requestAnimationFrame/, 'kein Aufbau ein Bild spaeter');
  const syncBeforeSwap = set.indexOf('syncViewChrome(container)');
  assert.ok(syncBeforeSwap > set.indexOf('const swap = '), 'syncViewChrome laeuft nur im Tausch, nicht vor dem Laden');
  assert.match(set, /syncViewToggle\(container\)/, 'das Segment antwortet sofort');
  assert.match(set, /loadHistory\(container, \{ beforeRender: swap \}\)/, 'der Verlauf tauscht im selben Task, in dem er zeichnet');
  assert.match(set, /if \(!swap\(\)\) return;\s*renderTaskList\(container\)/, 'Liste und Brett zeichnen direkt nach dem Tausch');
});

test('R23 D13 / R24: der Kopf der Aufgaben behaelt seine Form - der Filter haelt im Verlauf nur seinen Platz, angedockter FAB unsichtbar statt weg', () => {
  const chrome = fnBody(readPub('pages/tasks.js'), 'function syncViewChrome(', '\n}\n');
  assert.doesNotMatch(chrome, /filterBtn\.hidden\s*=\s*isHistory/, 'der Filterknopf verschwand im Verlauf und schob Segment und Menue');
  // R24 (G2-Aufgaben-P3-3): nicht mehr ausgegraut (ein totes Werkzeug ohne
  // Grund), sondern unsichtbar mit gehaltenem Platz.
  assert.doesNotMatch(chrome, /filterBtn\.disabled\s*=\s*isHistory/, 'ausgegraut stand ein Werkzeug da, das nichts tut');
  assert.match(chrome, /filterBtn\.classList\.toggle\('is-vacant',\s*isHistory\)/);
  const vacant = rulesOf('styles/tasks.css').find((r) => r.selector.trim() === '.tasks-toolbar .is-vacant');
  assert.ok(vacant, 'Regel fuer den gehaltenen Platz fehlt');
  assert.match(vacant.body, /visibility:\s*hidden/, 'visibility haelt den Platz und nimmt Zeiger, Tab-Folge und Baum');
  const docked = rulesOf('styles/layout.css').find((r) => r.selector.includes('.is-selecting) .page-fab.page-fab--docked'));
  assert.ok(docked, 'Regel fuer den angedockten FAB im Auswahlmodus fehlt');
  assert.ok(docked.at.some((a) => /min-width:\s*1024px/.test(a)), 'nur dort, wo er angedockt ist');
  assert.match(docked.body, /visibility:\s*hidden/);
  assert.match(docked.body, /display:\s*inline-flex/, 'er behaelt seinen Platz in der Zeile');
});

test('R23 D13: ab 1024px gibt die Suche nach, die Aktionen schrumpfen nicht (1024: "+ Aufgabe" ragte 24px hinaus)', () => {
  const r = rulesOf('styles/layout.css').find((x) => x.selector.trim() === '.page-toolbar__actions'
    && x.at.some((a) => /min-width:\s*1024px/.test(a)) && /flex-shrink/.test(x.body));
  assert.ok(r, '.page-toolbar__actions { flex-shrink: 0 } ab 1024px fehlt');
  assert.match(r.body, /flex-shrink:\s*0/);
});

test('R23 D13: der Kalender bleibt ab 1600px auf der Inhaltsspalte (Titelkante wie jedes Modul)', () => {
  const cal = rulesOf('styles/calendar.css').filter((r) => r.at.some((a) => /cal-page \(min-width: 86\.25rem\)/.test(a)));
  assert.ok(cal.length, 'die Seitenleisten-Abfrage fehlt - der Test liest calendar.css nicht mehr');
  assert.ok(!cal.some((r) => /--page-inline-pad:\s*var\(--page-gutter\)/.test(r.body)),
    'Kopf und Rahmen rueckten auf den Seitenrand: Titel bei 1920 auf x 252 statt 430');
});

test('R23 D13: Einkauf - die Spaltenzuordnung friert beim Laden ein und folgt beim Abhaken nicht dem Ausgleich', () => {
  const css = rulesOf('styles/shopping.css').find((r) => r.selector.includes('.items-lanes.is-frozen > .list-group[data-lane-break]'));
  assert.ok(css && /break-before:\s*column/.test(css.body), 'der eingefrorene Umbruch fehlt');
  assert.ok(css.at.some((a) => /shopping-surface \(min-width: 60rem\)/.test(a)), 'nur in den Spalten');
  const js = readPub('pages/shopping.js');
  const mount = fnBody(js, 'function mountItems(', '\n}\n');
  assert.match(mount, /applyLaneFreeze\(lanes\)/, 'jeder Neubau setzt den gemerkten Umbruch wieder');
  assert.match(mount, /afterNextPaint\(\)\.then\(\(\) => \{[\s\S]*freezeLanes\(lanes\)/, 'gemessen wird nach dem ersten Bild');
  assert.match(fnBody(js, 'function syncGroupChrome(', '\n}\n'), /applyLaneFreeze\(/, 'eine geleerte Kategorie gibt den Umbruch weiter');
  assert.match(fnBody(js, 'async function switchList(', '\n}\n'), /laneBreak = \{ listId: null, key: null \}/, 'Listenwechsel verteilt neu');
  assert.match(fnBody(js, 'export async function render(', '\n}\n'), /laneBreak = \{ listId: null, key: null \}/, 'Seitenaufbau verteilt neu');
});

test('R23 D13: am Finger steht der Griff nur im Sortiermodus (Aufgaben, Einkauf)', () => {
  const r = rulesOf('styles/list-row.css').find((x) => /:is\(\.tasks-page, \.shopping-page\):not\(\.is-sorting\) \.list-row__drag/.test(x.selector));
  assert.ok(r, 'die Sortiermodus-Regel fehlt');
  assert.ok(r.at.some((a) => /hover:\s*none/.test(a)), 'nur ohne schwebenden Zeiger');
  assert.match(r.body, /display:\s*none/);
  const item = rulesOf('styles/layout.css').find((x) => x.selector.includes('[data-action="sort-mode"]'));
  assert.ok(item && item.at.some((a) => /hover:\s*hover/.test(a)), 'am Zeiger hat der Menueeintrag keine Wirkung und fehlt');
  assert.match(readPub('pages/tasks.js'), /action: 'sort-mode'/);
  assert.match(readPub('pages/shopping.js'), /action: 'sort-mode'/);
  assert.match(readPub('pages/shopping.js'), /action === 'sort-mode'/);
  assert.match(readPub('pages/tasks.js'), /case 'sort-mode':/);
});

test('R23 D13: Wochenplan - Rezepte als Leiste unter dem Plan, unter 72rem der Typ als Zeilenkopf und sieben Tage ab 128px', () => {
  const rules = rulesOf('styles/meals.css');
  const layout = rules.find((r) => r.selector.trim() === '.meals-layout' && /container:\s*meals-board/.test(r.body));
  assert.ok(layout, '.meals-layout misst sich nicht als Flaeche');
  assert.match(layout.body, /grid-template-columns:\s*minmax\(0, 1fr\)/, 'keine Spalte rechts mehr');
  // R24 (Critique G3-Mahlzeiten-P2-1): die Leiste FOLGT dem Plan, statt mit
  // `1fr` an den Fensterboden gedrueckt zu werden (145px leeres Band bei 1440).
  assert.match(layout.body, /grid-template-rows:\s*minmax\(0, max-content\) auto/, 'die Leiste hat ihre eigene Zeile, direkt unter dem Plan');
  assert.match(layout.body, /align-content:\s*start/, 'beide Zeilen stehen oben zusammen');
  assert.doesNotMatch(layout.body, /minmax\(0, 1fr\) auto/, 'die Woche dehnt sich nicht auf die Resthoehe');
  const narrow = rules.filter((r) => r.at.some((a) => /meals-board \(width < 72rem\)/.test(a)));
  const grid = narrow.find((r) => r.selector.trim() === '.week-grid');
  assert.ok(grid && /repeat\(7, minmax\(128px, 1fr\)\)/.test(grid.body), 'sieben Tage mit mindestens 128px');
  assert.ok(narrow.some((r) => r.selector.trim() === '.week-gutter-label' && /grid-column:\s*1 \/ -1/.test(r.body)), 'der Typ steht ueber seiner Reihe');
  assert.ok(!rules.some((r) => r.selector.trim() === '.meals-layout' && /320px|272px/.test(r.body)), 'keine Rezeptspalte von 272/320px mehr');
  const meals = readPub('pages/meals.js');
  assert.doesNotMatch(fnBody(meals, 'function wireRailToggle(', '\n}\n'), /grid\.scrollWidth > grid\.clientWidth/,
    'die Leiste klappt nicht mehr von selbst ein - sie nimmt der Woche keine Breite');
});

test('R24 S13-F1: das Wochenraster ist so hoch wie sein Inhalt (1024x768 ohne Hochscrollen)', () => {
  // Gemessen vorher bei 1024x768: Woche 684px in 611px Port, die Snack-Reihe
  // unter der Falz. Hoehen, die nicht aus dem Inhalt kamen: 72px Slot,
  // Aktionsleiste ohne Knopf (Abstand + Polster), 20px Typzeile, 16er-Polster
  // in der 128px-Spalte, 32px Seitenpolster unter dem eigenen Scrollport.
  const rules = rulesOf('styles/meals.css');
  const board = rules.filter((r) => r.at.length === 1 && /min-width:\s*1024px/.test(r.at[0]));
  const narrow = rules.filter((r) => r.at.some((a) => /meals-board \(width < 72rem\)/.test(a)));
  const one = (list, sel) => list.filter((r) => r.selector.trim() === sel).map((r) => r.body).join('\n');
  assert.match(one(board, '.week-grid .meal-slot'), /min-height:\s*var\(--target-lg\)/, 'am Board traegt der Slot nur die Hoehe seines Plus');
  assert.match(one(board, '.week-grid .meal-card__open'), /padding:\s*var\(--space-3\) var\(--space-3\) 0/);
  assert.match(one(board, '.week-grid .meal-card__actions'), /padding:\s*0 var\(--space-3\) var\(--space-3\)/);
  assert.match(one(board, '.week-grid .meal-card__actions:not(:has(*))'), /margin-top:\s*0/, 'eine Leiste ohne Knopf haelt keinen Abstand');
  assert.match(one(board, '.meals-layout--rail-hidden'), /padding-block-end:\s*var\(--space-4\)/);
  assert.doesNotMatch(one(narrow, '.week-gutter-label'), /min-block-size/, 'die Typzeile ist so hoch wie ihr Wort');
  assert.match(one(narrow, '.week-grid .meal-slot'), /margin-block-start:\s*var\(--space-5\)/);
  assert.match(one(narrow, '.week-grid .day-header'), /padding-block-start:\s*var\(--space-2\)/);
});

test('R23 D13: Mahlzeit aus einem Rezept zeigt dessen Zutaten zum Lesen, "Anpassen" macht eigene Zeilen daraus', () => {
  const meals = readPub('pages/meals.js');
  const of = fnBody(meals, 'function recipeIngredientsOf(', '\n}\n');
  assert.match(of, /if \(!meal\?\.recipe_id \|\| meal\.ingredients\?\.length\) return \[\]/, 'nur ohne eigene Zutaten - die Regel des Servers');
  const build = fnBody(meals, 'function buildModalContent(', '\n}\n');
  assert.match(build, /recipeIngredientsOf\(isEdit \? meal : null\)/);
  assert.match(build, /meal-recipe-ingredients__list/);
  assert.match(build, /id="meal-own-ingredients" hidden/, 'die eigenen Zeilen stehen bereit, verborgen');
  assert.match(meals, /#meal-recipe-ingredients-edit'\)\?\.addEventListener\('click'/, '"Anpassen" ist verdrahtet');
  assert.match(fnBody(meals, 'function mealReadHtml(', '\n}\n'), /recipeIngredientsOf\(meal\)/, 'auch die Leseansicht nennt sie');
});

test('R23 D13: Aufteilung mobil - die offene Gruppensuche nimmt die zweite Zeile, der Mehr-Knopf bleibt beim Titel', () => {
  const rules = rulesOf('styles/split-expenses.css').filter((r) => r.at.length === 0
    && r.selector.includes('.split-panel-head.section-toolbar > label.split-search:'));
  assert.ok(rules.some((r) => r.selector.includes(':focus-within')), 'mit Fokus');
  assert.ok(rules.some((r) => r.selector.includes(':has(input:not(:placeholder-shown))')), 'mit Begriff');
  for (const r of rules) assert.match(r.body, /flex:\s*1 0 100%/);
});

test('R23 D13: Einkauf - Quick-Add meldet einen Artikel ausserhalb des Bilds, die Listenleiste traegt den Anriss', () => {
  const js = readPub('pages/shopping.js');
  assert.match(fnBody(js, 'function announceAddedOutOfSight(', '\n}\n'), /if \(inSight\) return;/, 'kein Toast je Artikel, wenn die Zeile im Bild steht');
  assert.match(js, /announceAddedOutOfSight\(container, data\.data\)/);
  assert.match(fnBody(js, 'function renderTabs(', '\n}\n'), /wireScrollFade\(bar\)/);
});

/*
 * R23 D14 (Kanon D5): "Ein Leerzustand neben dem FAB hat keine zweite
 * Primaeraktion." Der Kanon stand seit 2026-10-16 in DESIGN.md, ein Guard fehlte -
 * die Critique vom 24.10. fand den Primaerknopf trotzdem in Einkauf, Dokumente,
 * Aufgaben, Notizen, Kontakten, Budget, Rezepten. Gescannt wird jeder Aufruf von
 * emptyStateHTML/emptyStateEl/mountEmptyState in einer Seite mit FAB, dessen
 * Aktion als Objekt-Literal mit `label:` im Aufruf steht: die Aktion traegt
 * `tone: 'secondary'`. Ausgenommen sind Fehler/kein Treffer (eigener Ton) und
 * Stellen, deren Kommentar im Aufruf sagt, dass dort KEIN FAB steht.
 */
function emptyStateCallsWithPrimary(src) {
  const out = [];
  const re = /(?:emptyState(?:HTML|El)|mountEmptyState)\((?:[^,()]*,\s*)?\{/g;
  let m;
  while ((m = re.exec(src))) {
    let depth = 0;
    let j = m.index + m[0].length - 1;
    for (; j < src.length; j++) {
      if (src[j] === '{') depth++;
      else if (src[j] === '}' && --depth === 0) break;
    }
    const call = src.slice(m.index, j + 1);
    if (/variant:\s*'(?:error|no-results)'/.test(call)) continue;
    const action = /\baction:\s*[^{}]*?\{\s*label:/.exec(call);
    if (!action) continue;
    if (/kein FAB/.test(call)) continue;
    const body = call.slice(action.index, call.indexOf('}', action.index) + 1);
    if (!/tone:\s*'secondary'/.test(body)) out.push(src.slice(0, m.index).split('\n').length);
  }
  return out;
}

test('R23 D14: ein Leerzustand neben dem FAB hat keine zweite Primaeraktion', () => {
  // Proben: positiv und negativ, damit ein blinder Scanner nicht gruen ist.
  assert.deepEqual(emptyStateCallsWithPrimary("emptyStateHTML({ title: 'x', action: { label: 'y', icon: 'plus' } })"), [1]);
  assert.deepEqual(emptyStateCallsWithPrimary("emptyStateHTML({ title: 'x', action: { label: 'y', tone: 'secondary' } })"), []);
  assert.deepEqual(emptyStateCallsWithPrimary("mountEmptyState(el, { title: 'x', action: ro ? null : {\n label: 'y' } })"), [1]);
  assert.deepEqual(emptyStateCallsWithPrimary("emptyStateHTML({ variant: 'error', action: { label: 'y' } })"), []);
  const pagesDir = fileURLToPath(new URL('../public/pages/', import.meta.url));
  const offenders = [];
  for (const file of readdirSync(pagesDir).filter((f) => f.endsWith('.js'))) {
    const src = readFileSync(join(pagesDir, file), 'utf8');
    if (!/createPageFab|pageFabHtml|setPageFabAction|class="page-fab"/.test(src)) continue;
    for (const line of emptyStateCallsWithPrimary(src)) offenders.push(`${file}:${line}`);
  }
  assert.deepEqual(offenders, [], 'Leerzustand mit Primaeraktion neben einem FAB - tone: \'secondary\', oder im Aufruf begruenden, dass dort kein FAB steht');
  // Die Dokumente bauen ihre Aktionen als Liste mit `variant` (emptyStateFor).
  const docs = readFileSync(join(pagesDir, 'documents.js'), 'utf8');
  const empty = docs.slice(docs.indexOf('function emptyStateFor()'), docs.indexOf('function renderEmptyState('));
  assert.doesNotMatch(empty, /variant: 'primary'/, 'Dokumente: kein Primaerknopf im Leerzustand');
  assert.match(empty, /t\('documents\.emptyFolderTitle', \{ name: folder\.name \}\)/, 'ein leerer Ordner ist ein Ort, kein Filter ohne Treffer');
});

// ---------------------------------------------------------------------------
// R24 S6: Knoepfe, Zeilen, Auswahl (Critique 2026-10-26)
// ---------------------------------------------------------------------------
const cssOf = (name) => CSS.find(({ file }) => file === `public/styles/${name}`).src;
const jsOf = (name) => JS.find(({ file }) => file === name).src;
const ruleOf = (css, selector, at = null) => [...eachRule(css)]
  .filter((r) => r.selector.replace(/\/\*[\s\S]*?\*\//g, '').trim() === selector && (at === null || r.at.some((a) => at.test(a))));

test('R24 G0-Shell-P3-2: am Zeiger misst jedes Kopf- und Abschnittswerkzeug 40px, nicht 44 oder 48', () => {
  const pointer = /min-width:\s*1024px\)\s*and\s*\(hover:\s*hover/;
  // Der kleine Icon-Knopf (Abschnittskopf Punktestaende/Ausgleich) wie `.btn--sm`.
  const small = ruleOf(cssOf('layout.css'), '.btn--icon.btn--sm', pointer);
  assert.equal(small.length, 1, '`.btn--icon.btn--sm` hat am Zeiger eine eigene Hoehe');
  assert.match(small[0].body, /min-height:\s*var\(--target-md\)/);
  assert.match(small[0].body, /min-width:\s*var\(--target-md\)/);
  // Die Personenwahl im Gesundheitskopf.
  const person = ruleOf(cssOf('health.css'), '.health-toolbar__person .health-person-switcher__trigger', pointer);
  assert.equal(person.length, 1, 'Personenwahl im Kopf: eigene Zeiger-Hoehe');
  assert.match(person[0].body, /min-height:\s*var\(--target-md\)/);
  // "Auschecken" der Haushaltshilfe nimmt die Hoehe von `.btn`, keine eigene.
  const check = ruleOf(cssOf('housekeeping.css'), '.housekeeping-check-small');
  assert.ok(check.length && check.every((r) => !/min-height/.test(r.body)), 'kein fester --target-lg am Auschecken-Knopf');
  // Personen vergleichen im Schichtplan: kein Polster ueber der Untergrenze.
  const people = ruleOf(cssOf('schedule.css'), '.schedule-overview__people', /hover:\s*hover/);
  assert.match(people[0]?.body ?? '', /padding-block:\s*0/);
});

test('R24 G2-Aufgaben-P2-3 / G3-Einkauf-P3-2: die Kapseln der Sammel-Pille messen --target-md, die Pille bleibt', () => {
  const layout = cssOf('layout.css');
  const action = ruleOf(layout, '.list-bulkbar__action');
  assert.equal(action.length, 1);
  assert.match(action[0].body, /min-height:\s*var\(--target-md\)/);
  assert.match(action[0].body, /font-size:\s*var\(--text-sm\)/);
  const pill = ruleOf(layout, '.list-bulkbar')[0];
  assert.match(pill.body, /min-height:\s*var\(--bulk-pill-height\)/, 'die Pille haelt die Sicherheitszone');
  assert.match(pill.body, /padding:\s*calc\(\(var\(--bulk-pill-height\) - var\(--target-md\)\) \/ 2 - var\(--space-px\)\)/,
    'das senkrechte Polster ist der Rest bis zur Pillenhoehe (abzueglich der Glaskante)');
});

test('R24 G2-Belohnungen-P2-1: eine Anfrage traegt EINE sichtbare Handlung, nie gefuellt; Ablehnen steht im Mehr', () => {
  const src = jsOf('public/pages/rewards.js');
  const fn = src.slice(src.indexOf('const rows = state.redemptions.map('), src.indexOf('DER KOPF STEHT AUF DEM GRUND'));
  assert.match(fn, /<button class="btn btn--secondary btn--sm" type="button" data-decide="fulfill"/);
  assert.doesNotMatch(fn, /btn--primary/, 'kein Primaerknopf in der Zeile - der Primaer ist der FAB');
  assert.match(fn, /rowMenuHtml\(\{[\s\S]*?attrs: \{ 'data-decide': 'reject'/, 'Ablehnen ist ein Eintrag im Zeilenmenue');
  assert.doesNotMatch(fn, /<button class="btn btn--ghost btn--sm" type="button" data-decide="reject"/);
});

test('R24 G2-Entsorgung-P3-1: eine Vorlage ist ein kleiner Sekundaerknopf, ihre Farbe eine Variable', () => {
  const src = jsOf('public/pages/waste.js');
  const fn = src.slice(src.indexOf('function presetButtonHtml('), src.indexOf('function remainingPresetsHtml('));
  assert.match(fn, /class="btn btn--secondary btn--sm waste-onboarding__preset"/);
  assert.match(fn, /style="--waste-type-color:\$\{esc\(preset\.color\)\}"/);
  assert.doesNotMatch(src, /filter-chip waste-onboarding__preset/, 'keine Filter-Optik fuer eine Anlegen-Handlung');
  assert.doesNotMatch(fn, /style="color:/, 'keine Farbe als Inline-Stil am Zeichen');
  assert.match(ruleOf(cssOf('waste.css'), '.waste-onboarding__preset svg')[0]?.body ?? '', /color:\s*var\(--waste-type-color/);
});

test('R24 G5-Kontakte-P3-2 / G3-Rezepte-P3-3: Seltenes steht im Mehr-Menue des Fusses, mit Wort', () => {
  const view = jsOf('public/components/detail-view.js');
  assert.match(view, /function footerMoreMenuEl\(actions, close\)/);
  assert.match(view, /if \(action\.more && folds\)/, 'nur falten, wenn daneben noch etwas steht');
  assert.match(jsOf('public/pages/contacts.js'), /id: 'contact-detail-export',[\s\S]{0,200}more: true/);
  assert.match(jsOf('public/pages/recipes.js'), /id: 'recipe-detail-duplicate'[^}]*more: true/);
});

test('R24 G0-Inv-5 / G4-Notizen-P3-2: die Notizkarte hat den Kartenradius, ihr Checklisten-Ring 20px', () => {
  const notes = cssOf('notes.css');
  assert.match(ruleOf(notes, '.note-card')[0].body, /border-radius:\s*var\(--radius-lg\)/);
  const ring = [...eachRule(notes)].find((r) => /\.note-card \.note-md-box/.test(r.selector));
  assert.match(ring?.body ?? '', /font-size:\s*var\(--space-5\)/, 'der Ring misst 20px (Haken in em waechst mit)');
});

test('R24 G0-Shell-P3-3: EIN Etikett (`.tag`) fuer Aufgaben-Tags, Einkaufs-Etiketten, Notiz-Kategorien und Medikamenten-Abzeichen', () => {
  const tag = ruleOf(cssOf('list-row.css'), '.tag');
  assert.equal(tag.length, 1);
  assert.match(tag[0].body, /background:\s*var\(--color-fill-well\)/);
  assert.match(tag[0].body, /color:\s*var\(--color-text-secondary\)/);
  assert.match(tag[0].body, /border-radius:\s*var\(--radius-full\)/);
  const uses = [
    ['public/pages/tasks.js', /class="tag task-tag task-tag--filter"/],
    ['public/pages/shopping.js', /class="tag list-row__tag"/],
    ['public/pages/notes.js', /class="tag note-category-badge/],
    ['public/pages/dashboard.js', /class="tag note-item__category"/],
    ['public/pages/health.js', /<span class="tag">/],
  ];
  for (const [file, re] of uses) assert.match(jsOf(file), re, file);
  // Die Module tragen keine eigene Pillenform mehr.
  for (const [css, sel] of [['tasks.css', '.task-tag'], ['list-row.css', '.list-row__tag'], ['health.css', '.health-med-badge']]) {
    assert.deepEqual(ruleOf(cssOf(css), sel), [], `${sel}: keine eigene Pillenregel neben .tag`);
  }
});

// --------------------------------------------------------------------------
// R24 S9 Kueche (Critique 2026-10-26, G3): Plan, Karte, Rezepte, Einkauf
// --------------------------------------------------------------------------
test('R24 S9: die Rezeptkachel nennt ihre Zutaten, die Leiste beginnt in niedrigen Fenstern eingeklappt', () => {
  const meals = readPub('pages/meals.js');
  assert.match(meals, /title\.className = 'recipe-sidebar__title u-section-title'/, 'der Leistentitel ist ein Abschnittstitel (20/600)');
  assert.match(meals, /meta\.className = 'recipe-sidebar__card-meta';\s*meta\.textContent = t\('meals\.ingredientCount', \{ count \}\)/, 'die Kachel nennt die Zutatenzahl');
  assert.match(meals, /className: 'recipe-sidebar__thumb'/, 'und traegt ein Bild, wo es eins gibt');
  assert.match(meals, /let hidden = window\.matchMedia\?\.\('\(max-height: 799px\)'\)\?\.matches \?\? false;/, 'unter 800px Hoehe startet die Leiste eingeklappt');
});

test('R24 S9: Karte am Board - Titel bis drei Zeilen, beide Zeichen in einem Ton, Tageskopf "Mi 28.10." mit ruhigem Plus', () => {
  const rules = rulesOf('styles/meals.css');
  const board = rules.find((r) => r.selector.trim() === '.meal-card__title-text' && r.at.some((a) => /min-width: 1024px/.test(a)) && /line-clamp/.test(r.body));
  assert.match(board?.body ?? '', /-webkit-line-clamp:\s*3/, 'am Board drei Zeilen statt zwei');
  const ton = rules.find((r) => r.selector.includes('.meal-card__action-btn--shopping') && r.selector.includes('.meal-card__action-btn--recipe') && !r.at.length);
  assert.match(ton?.body ?? '', /color:\s*var\(--color-text-secondary\)/, 'Muetze und Wagen ruhen im selben Ton');
  assert.ok(!rules.some((r) => r.selector.trim() === '.meal-card__action-btn--shopping' && /color:\s*var\(--module-accent\)/.test(r.body)),
    'der Wagen traegt den Modulton nur unter dem Zeiger');
  const add = rules.find((r) => r.selector.trim() === '.day-header > .day-add');
  assert.match(add?.body ?? '', /margin-inline-start:\s*auto/, 'das Plus steht am Ende, Tag und Datum zusammen vorn');
  assert.match(add?.body ?? '', /color:\s*var\(--color-text-secondary\)/, 'und ruhig, nicht orange');
  assert.ok(!rules.some((r) => r.selector.trim() === '.day-header__date' && /margin-inline-start:\s*auto/.test(r.body)), 'das Datum rueckt nicht mehr an den Rand');
});

test('R24 S9: "Diese Woche geplant" steht nur, wenn nicht alle Rezepte geplant sind', () => {
  const recipes = readPub('pages/recipes.js');
  assert.match(recipes, /const allPlanned = listedRecipes\(\)\.every\(\(r\) => state\.plannedRecipeIds\.has\(r\.id\)\);/);
  assert.match(recipes, /if \(state\.plannedRecipeIds\.has\(recipe\.id\) && !allPlanned\)/);
});

test('R24 S9: der Artikel-Dialog des Einkaufs faltet Preis, Laden, Link, Notiz und holt keine Tastatur', () => {
  const shopping = readPub('pages/shopping.js');
  const start = shopping.indexOf('function openItemDetails(');
  const body = shopping.slice(start, shopping.indexOf('\nfunction ', start + 10));
  assert.match(body, /initialFocus: 'edit'/, 'Bearbeiten holt am Finger keine Tastatur');
  assert.match(body, /advancedSection\(itemMoreDetailsHtml\(item, linkPreview\), \{[\s\S]*?hint: t\('shopping\.moreDetailsHint'\)/, '"Weitere Angaben" nennt, was dahinter liegt');
  assert.match(body, /open: item\.price_cents != null \|\| item\.store_id != null \|\| !!item\.url \|\| !!item\.notes/, 'offen, sobald eines einen Wert traegt');
  assert.match(body, /class="form-pair form-pair--wide"/, 'die Kategorie steht am Telefon nicht in der halben Zeile');
  assert.match(shopping, /<option value="\$\{PICK_PLACE\}" disabled selected>\$\{esc\(t\('shopping\.toPantryAllToPlaceholder'\)\)\}<\/option>/,
    '"Alle nach" steht auf einem Platzhalter, bis jemand waehlt');
});
