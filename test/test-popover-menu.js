/**
 * Tests: Tastaturbedienung des geteilten Ueberlaufmenues
 * Modul: /public/utils/popover-menu.js
 *
 * WARUM ALS VERHALTENSTEST UND NICHT ALS TEXTGUARD: Die Luecke, die diese
 * Suite schliesst, war nicht das Fehlen einer Zeile, sondern das Fehlen einer
 * BEDIENUNG. `role="menu"` sagt der assistiven Technik Pfeiltasten zu; die
 * Popover-API liefert nur Top-Layer, Light-Dismiss und Esc. Der
 * Personen-Umschalter der Gesundheit war bis 2026-08-31 ein `role="tablist"`
 * und bekam seine Pfeiltasten von `wireTablistKeys` - als Menue erbte er die
 * Rollen und verlor die Bedienung. Ein Guard, der nach `ArrowDown` im Quelltext
 * sucht, waere gruen geblieben, sobald der Handler nur noch daneben liegt.
 *
 * Deshalb faehrt die Suite die echten Handler: `installPopoverMenus` bekommt
 * eine Wurzel, die ihre Listener aufhebt, und die Sonden feuern `toggle` und
 * `keydown` wie der Browser. Das DOM darunter ist der kleinstmoegliche Stub -
 * `closest`, `querySelectorAll`, `focus`, `tabIndex`, mehr fasst der Code nicht
 * an. Ein echtes DOM haette eine Fremd-Dependency gekostet, und die Kette ist
 * netzfrei und kommt ohne Browser aus.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

// `panel instanceof HTMLElement` steht als Typwaechter in onToggle.
global.HTMLElement = class HTMLElement {};

const { installPopoverMenus, pageToolsMenuHtml, popoverMenuHtml } = await import('../public/utils/popover-menu.js');

/** Kleinstes Element, das die Selektorwege des Moduls bedient. */
function el(selector, attrs = {}) {
  const node = Object.assign(new global.HTMLElement(), {
    _sel: selector,
    _attrs: { ...attrs },
    parent: null,
    children: [],
    style: {},
    tabIndex: 0,
    focused: false,
    offsetWidth: 200,
    offsetHeight: 48,
    getAttribute(key) { return node._attrs[key] ?? null; },
    setAttribute(key, value) { node._attrs[key] = value; },
    matches(sel) { return node._sel === sel; },
    focus() { node.focused = true; },
    closest(sel) {
      for (let n = node; n; n = n.parent) if (n._sel === sel) return n;
      return null;
    },
    querySelectorAll(sel) {
      const wantsEnabled = sel.includes(':not([disabled])');
      return node.children.filter((c) => c._sel === '.popover-menu__item'
        && (!wantsEnabled || !c.disabled));
    },
    getBoundingClientRect() { return { top: 100, bottom: 140, right: 300, left: 200 }; },
  });
  return node;
}

/** Panel mit `count` Eintraegen; `checkedIndex` traegt aria-checked. */
function makeMenu({ count = 3, checkedIndex = -1, disabledIndex = -1 } = {}) {
  const panel = el('.popover-menu');
  panel.id = 'menu-1';
  for (let i = 0; i < count; i += 1) {
    const item = el('.popover-menu__item',
      i === checkedIndex ? { 'aria-checked': 'true' } : {});
    item.parent = panel;
    item.disabled = i === disabledIndex;
    panel.children.push(item);
  }
  return panel;
}

/** Wurzel, die ihre Listener aufhebt - so wie die Seite sie verdrahtet. */
function makeRoot() {
  const listeners = [];
  const root = {
    dataset: {},
    addEventListener(type, handler, opts) { listeners.push({ type, handler, opts }); },
    fire(type, event) {
      for (const l of listeners) if (l.type === type) l.handler(event);
    },
    has(type) { return listeners.some((l) => l.type === type); },
  };
  installPopoverMenus(root);
  return root;
}

const trigger = el('.popover-menu__trigger');
global.document = { querySelector: () => trigger };
global.window = { innerWidth: 1024, innerHeight: 768 };

const open = (root, panel) => root.fire('toggle', { target: panel, newState: 'open' });

const keydown = (root, target, key) => {
  let prevented = false;
  root.fire('keydown', { target, key, preventDefault() { prevented = true; } });
  return prevented;
};

const focusedIndex = (panel) => panel.children.findIndex((i) => i.focused);
const clearFocus = (panel) => panel.children.forEach((i) => { i.focused = false; });

test('das Oeffnen zieht den Fokus auf den ersten Eintrag', () => {
  const root = makeRoot();
  const panel = makeMenu();
  open(root, panel);
  assert.equal(focusedIndex(panel), 0, 'der Fokus bleibt am Trigger stehen');
});

test('ein Radiomenue oeffnet auf der aktiven Wahl, nicht am Anfang', () => {
  // Wiedererkennen statt Erinnern: der Personen-Umschalter der Gesundheit
  // fuehrt sechs Personen, und die aktive ist der Ausgangspunkt.
  const root = makeRoot();
  const panel = makeMenu({ checkedIndex: 2 });
  open(root, panel);
  assert.equal(focusedIndex(panel), 2);
});

test('Tab fuehrt aus dem Menue hinaus, nicht durch alle Eintraege', () => {
  // Roving Tabindex: genau EIN Eintrag ist tabbable, und das ist der
  // fokussierte. Ohne das kostet ein Sechs-Personen-Menue sechs Tabs.
  const root = makeRoot();
  const panel = makeMenu({ count: 4, checkedIndex: 1 });
  open(root, panel);
  assert.deepEqual(panel.children.map((i) => i.tabIndex), [-1, 0, -1, -1]);
});

test('Pfeiltasten wandern und laufen an beiden Enden um', () => {
  const root = makeRoot();
  const panel = makeMenu({ count: 3 });
  open(root, panel);

  clearFocus(panel);
  assert.ok(keydown(root, panel.children[0], 'ArrowDown'), 'ArrowDown scrollt sonst die Seite');
  assert.equal(focusedIndex(panel), 1);

  clearFocus(panel);
  keydown(root, panel.children[2], 'ArrowDown');
  assert.equal(focusedIndex(panel), 0, 'das Ende laeuft auf den Anfang um');

  clearFocus(panel);
  keydown(root, panel.children[0], 'ArrowUp');
  assert.equal(focusedIndex(panel), 2, 'der Anfang laeuft auf das Ende um');
});

test('Home und End springen an die Raender', () => {
  const root = makeRoot();
  const panel = makeMenu({ count: 5 });
  open(root, panel);

  clearFocus(panel);
  keydown(root, panel.children[2], 'End');
  assert.equal(focusedIndex(panel), 4);

  clearFocus(panel);
  keydown(root, panel.children[2], 'Home');
  assert.equal(focusedIndex(panel), 0);
});

test('fremde Tasten bleiben unangetastet', () => {
  // Kein blindes preventDefault: Buchstaben gehoeren der Seite, und Esc sowie
  // Tab gehoeren dem Browser - Light-Dismiss und Fokusrueckgabe haengen daran.
  const root = makeRoot();
  const panel = makeMenu();
  open(root, panel);
  for (const key of ['Escape', 'Tab', 'a', 'Enter']) {
    assert.equal(keydown(root, panel.children[0], key), false, `${key} wurde abgefangen`);
  }
});

test('ein deaktivierter Eintrag ist kein Ziel der Pfeiltasten', () => {
  const root = makeRoot();
  const panel = makeMenu({ count: 3, disabledIndex: 1 });
  open(root, panel);
  clearFocus(panel);
  keydown(root, panel.children[0], 'ArrowDown');
  assert.equal(focusedIndex(panel), 2, 'der deaktivierte Eintrag wurde uebersprungen');
});

test('ein per CSS verborgener Eintrag ist kein Ziel der Pfeiltasten (Review zu #1475)', () => {
  // Mahlzeiten blendet den Rezeptspalten-Schalter unter 1024px per
  // `display: none` aus (meals.css) - im DOM steht er weiter. Als Ziel von
  // End/ArrowUp bekam er den Fokus, den ein nicht gerendertes Element nicht
  // annimmt: der Fokus blieb stehen, und die Tastatur hing am Menueende.
  const root = makeRoot();
  const panel = makeMenu({ count: 3 });
  panel.children[2].checkVisibility = () => false;
  panel.children[0].checkVisibility = () => true;
  open(root, panel);

  clearFocus(panel);
  keydown(root, panel.children[0], 'End');
  assert.equal(focusedIndex(panel), 1, 'End landet auf dem letzten SICHTBAREN Eintrag');

  clearFocus(panel);
  keydown(root, panel.children[1], 'ArrowDown');
  assert.equal(focusedIndex(panel), 0, 'hinter dem letzten sichtbaren laeuft es auf den Anfang um');

  clearFocus(panel);
  keydown(root, panel.children[0], 'ArrowUp');
  assert.equal(focusedIndex(panel), 1, 'rueckwaerts ueber den Anfang auf den letzten sichtbaren');
});

test('ohne Rendering-Auskunft (kein checkVisibility, keine Rects) zaehlt ein Eintrag als sichtbar', () => {
  const root = makeRoot();
  const panel = makeMenu({ count: 2 });
  open(root, panel);
  clearFocus(panel);
  keydown(root, panel.children[0], 'End');
  assert.equal(focusedIndex(panel), 1);
});

test('aria-expanded am Trigger folgt dem Zustand des Panels', () => {
  // Die Popover-API kennt nur `popovertarget`, kein ARIA - ohne diese
  // Verdrahtung meldet der Screenreader ein Menue, das nie aufgeht.
  const root = makeRoot();
  const panel = makeMenu();
  open(root, panel);
  assert.equal(trigger.getAttribute('aria-expanded'), 'true');
  root.fire('toggle', { target: panel, newState: 'closed' });
  assert.equal(trigger.getAttribute('aria-expanded'), 'false');
});

test('ein keydown ausserhalb eines Panels laeuft ins Leere', () => {
  const root = makeRoot();
  const outside = el('.something-else');
  assert.equal(keydown(root, outside, 'ArrowDown'), false);
});

test('ein Schalter-Eintrag (menuitemcheckbox) zieht den Fokus beim Oeffnen NICHT an sich', () => {
  // Kopfregel mobil: Ansichts-Schalter wie „Verlauf zeigen" stehen als
  // menuitemcheckbox im Werkzeugmenue. Der erste angehakte waere eine
  // zufaellige Stelle mitten im Menue - der Fokus beginnt oben. Rot, solange
  // onToggle jedes aria-checked wie eine Einfachauswahl behandelt.
  const root = makeRoot();
  const panel = makeMenu({ checkedIndex: 2 });
  panel.children[2].setAttribute('role', 'menuitemcheckbox');
  open(root, panel);
  assert.equal(focusedIndex(panel), 0);
});

test('das Werkzeugmenue eines Modulkopfs: ein „..."-Knopf, Eintraege mit Text, Trenner, Schalter', () => {
  const html = pageToolsMenuHtml({
    id: 'tasks-tools-menu',
    label: 'Weitere Aktionen',
    items: [
      { action: 'toggle-history', label: 'Verlauf', icon: 'history', checked: false },
      { separator: true },
      { action: 'manage-tags', label: 'Tags <b>', icon: 'tag' },
    ],
  });
  assert.match(html, /class="btn btn--secondary btn--icon page-tools-btn popover-menu__trigger"/);
  assert.match(html, /data-lucide="ellipsis"/, 'der Trigger ist das Ueberlaufzeichen');
  assert.match(html, /popovertarget="tasks-tools-menu"/);
  assert.match(html, /role="menuitemcheckbox" aria-checked="false"[\s\S]*data-action="toggle-history"/);
  assert.match(html, /popover-menu__item-check--hidden/, 'ein aus-Schalter zeigt keinen Haken');
  assert.match(html, /<div class="popover-menu__separator" role="separator"><\/div>/);
  assert.match(html, /role="menuitem"\s[\s\S]*data-action="manage-tags"/);
  assert.match(html, /<span>Tags &lt;b&gt;<\/span>/, 'Labels laufen durch esc()');
});


test('eine Gruppe traegt ihre Ueberschrift als Namen, die Ueberschrift ist kein Eintrag (R16)', () => {
  const html = popoverMenuHtml({
    id: 'g-menu',
    label: 'Mehr',
    items: [
      { group: 'Abgehakt (3)', items: [
        { action: 'a', label: 'In den Vorrat', icon: 'archive' },
        { action: 'b', label: 'Abgehakt löschen (3)', icon: 'trash-2', danger: true },
      ] },
      { separator: true },
      { action: 'c', label: 'Umbenennen', icon: 'pencil' },
    ],
  });
  const group = html.match(/<div class="popover-menu__group" role="group" aria-labelledby="([^"]+)">/);
  assert.ok(group, 'die Gruppe ist role="group" und verweist auf ihre Ueberschrift');
  assert.match(html, new RegExp(`<div class="popover-menu__label" id="${group[1]}">Abgehakt \\(3\\)</div>`));
  // Die Ueberschrift traegt die Eintragsklasse nicht: sie faellt aus Pfeiltasten und Fokus.
  assert.equal((html.match(/class="popover-menu__item[ "]/g) ?? []).length, 3);
  assert.ok(html.indexOf('data-action="a"') < html.indexOf('popover-menu__separator'));
  assert.ok(html.indexOf('popover-menu__separator') < html.indexOf('data-action="c"'));
});

test('top-start: ein Menue am Fuss einer linken Leiste oeffnet ueber dem Ausloeser, an seiner linken Kante', () => {
  // Konto-Menue der Seitenleiste (Critique 2026-09-26, P1-2). Rechtsbuendig
  // am Ausloeser hinge es halb ueber dem Inhalt neben der Leiste, und nach
  // unten ist am Fuss nie Platz. Der Trigger-Stub steht bei left 200, top 100,
  // bottom 140; das Panel ist 200 x 48 gross.
  const root = makeRoot();
  const panel = makeMenu();
  panel.dataset = { placement: 'top-start' };
  open(root, panel);
  assert.equal(panel.style.left, '200px', 'linke Kante am Ausloeser, nicht rechte');
  assert.equal(panel.style.top, '48px', 'ueber dem Ausloeser: 100 - 48 - 4');

  // Ohne Angabe bleibt es beim bisherigen Verhalten: rechtsbuendig darunter.
  const plain = makeMenu();
  open(root, plain);
  assert.equal(plain.style.left, '100px');
  assert.equal(plain.style.top, '144px');
});

// R14 P11 (Re-Critique 2026-09-28, A1 P3-4): Menues erschienen nur als Blende.
// Sie wachsen jetzt vom Ausloeser aus - der Ursprung der Skalierung ist die
// Ecke am Ausloeser, und die kennt nur die Rechnung, die das Panel setzt.
test('R14: das Menue waechst von der Ecke am Ausloeser aus', () => {
  const root = makeRoot();
  const below = makeMenu();
  open(root, below);
  assert.equal(below.style.transformOrigin, 'top right', 'rechtsbuendig darunter: von oben rechts');
  assert.equal(below.style.transform, 'none', 'offen steht es in voller Groesse');

  const up = makeMenu();
  up.dataset = { placement: 'top-start' };
  open(root, up);
  assert.equal(up.style.transformOrigin, 'bottom left', 'ueber dem Ausloeser an seiner linken Kante: von unten links');

  const prevHeight = global.window.innerHeight;
  global.window.innerHeight = 150;
  try {
    const flipped = makeMenu();
    open(root, flipped);
    assert.equal(flipped.style.transformOrigin, 'bottom right', 'unten kein Platz, nach oben gekippt: von unten rechts');
  } finally {
    global.window.innerHeight = prevHeight;
  }

  root.fire('toggle', { target: below, newState: 'closed' });
  assert.equal(below.style.transform, '', 'geschlossen faellt es in die Startgroesse zurueck');
});

// R16: der Ausgang (layout.css) beginnt mit dem Schliessen. Die Inline-Werte
// der offenen Lage muessen deshalb schon im `beforetoggle` fallen - das
// `toggle` kommt erst einen Task spaeter, und bis dahin stuende das Panel in
// voller Deckung, waehrend die Uhr des Ausgangs schon laeuft.
test('R16: beim Schliessen fallen Deckkraft und Groesse schon im beforetoggle', () => {
  const root = makeRoot();
  const menu = makeMenu();
  open(root, menu);
  assert.equal(menu.style.opacity, '1');
  assert.equal(menu.style.transform, 'none');
  root.fire('beforetoggle', { target: menu, newState: 'closed' });
  assert.equal(menu.style.opacity, '', 'die Deckkraft faellt auf das Stylesheet zurueck (0 ausserhalb von :popover-open)');
  assert.equal(menu.style.transform, '', 'die Groesse ebenso (scale 0.96)');
});

test('R14: Wachsen mit Token-Kurve, bei reduzierter Bewegung nur die Blende', async () => {
  const { readFile } = await import('node:fs/promises');
  const { eachRule } = await import('./css-rules.js');
  const css = await readFile(new URL('../public/styles/layout.css', import.meta.url), 'utf8');
  const rules = [...eachRule(css)];
  const reduce = (r) => r.at.some((a) => /prefers-reduced-motion:\s*reduce/.test(a));
  const body = (pred) => rules.filter((r) => pred(r) && r.selector.split(',').some((s) => s.trim() === '.popover-menu')).map((r) => r.body).join(';');
  const base = body((r) => !r.at.length);
  assert.match(base, /transform:\s*scale\(0?\.96\)/, 'die Startgroesse');
  // R16: die Grundregel traegt den AUSGANG (kuerzer), `:popover-open` die Einfahrt.
  const openBody = rules.filter((r) => !r.at.length && r.selector.trim() === '.popover-menu:popover-open').map((r) => r.body).join(';');
  assert.match(openBody, /transition:[^;]*transform var\(--duration-md\) var\(--ease-out\)/, 'Einfahrt: Dauer und Kurve aus den Tokens');
  assert.match(openBody, /transition:[^;]*opacity var\(--duration-md\) var\(--ease-out\)/);
  const transitions = [...base.matchAll(/(?:^|;)\s*transition\s*:\s*([^;]+)/g)].map((m) => m[1]);
  assert.equal(transitions.length, 2, 'zwei Deklarationen: Rueckfall ohne allow-discrete, dann die mit');
  assert.doesNotMatch(transitions[0], /allow-discrete/, 'die erste bleibt gueltig, wo allow-discrete fehlt');
  assert.match(transitions[1], /overlay var\(--duration-xs\) allow-discrete/, 'das Panel bleibt fuer den Ausgang im Top-Layer');
  assert.match(transitions[1], /display var\(--duration-xs\) allow-discrete/, 'und sichtbar, bis er durch ist');
  assert.match(transitions[1], /opacity var\(--duration-xs\) var\(--ease-out\)/, 'der Ausgang ist kuerzer als die Einfahrt und ohne Feder');
  const closed = rules.filter((r) => !r.at.length && r.selector.trim() === '.popover-menu:not(:popover-open)').map((r) => r.body).join(';');
  assert.match(closed, /opacity:\s*0/, 'Ziel des Ausgangs');
  assert.match(closed, /pointer-events:\s*none/, 'das ausblendende Menue nimmt keinen Zeiger');
  const still = body(reduce);
  assert.match(still, /transform:\s*none/, 'reduzierte Bewegung: kein Wachsen');
  assert.match(still, /transition:\s*opacity/, 'aber die Blende bleibt');
});

/* R16-Gesamtpruefung (2026-10-05): seit `pageToolsMenuHtml` EINEN Eintrag als
 * direkten Knopf baut, gibt es zwei Bauarten desselben Werkzeugs - den
 * Menue-Eintrag (`.popover-menu__item`) und den Knopf im Kopf
 * (`.page-tools-btn--direct`). Notizen und Geburtstage hoerten nur auf den
 * Eintrag: "Kategorien verwalten" und "Aus Kontakten importieren" standen als
 * Knopf im Kopf und taten nichts. Gefunden von Sonde 24 der Dokument-Guards,
 * die den Eintrag nicht mehr fand. Gegen den Stand davor rot gelaufen (Helfer
 * fehlte, fuenf Seiten fragten den Eintrag direkt). */
test('R16: ein Werkzeug des Kopfs antwortet als Menue-Eintrag UND als direkter Knopf', async () => {
  const { pageToolsActionEl } = await import('../public/utils/popover-menu.js');
  assert.equal(typeof pageToolsActionEl, 'function');
  const asked = [];
  const hit = { dataset: { action: 'manage-categories' } };
  const target = { closest: (selector) => { asked.push(selector); return hit; } };
  assert.equal(pageToolsActionEl(target, 'manage-categories'), hit);
  assert.equal(asked[0],
    '.popover-menu__item[data-action="manage-categories"], .page-tools-btn--direct[data-action="manage-categories"]');
  pageToolsActionEl(target);
  assert.equal(asked[1], '.popover-menu__item[data-action], .page-tools-btn--direct[data-action]',
    'ohne Namen: jedes Werkzeug, in beiden Bauarten');
  assert.equal(pageToolsActionEl({ closest: () => null }, 'x'), null);
  assert.equal(pageToolsActionEl({}, 'x'), null, 'ein Ziel ohne closest (Textknoten) ist kein Werkzeug');

  // Die Regel statt der fuenf Fundstellen: wer ein Werkzeugmenue baut, fragt den
  // Klick ueber den Helfer. Ein `closest('.popover-menu__item[data-action...')`
  // mit vollem Namen oder ganz ohne trifft den direkten Knopf nie; ein
  // Praefix-Selektor (`^=`) gehoert einem Zeilenmenue und bleibt erlaubt.
  const { readFileSync, readdirSync } = await import('node:fs');
  const dir = new URL('../public/pages/', import.meta.url);
  const offenders = [];
  let carriers = 0;
  for (const file of readdirSync(dir).filter((name) => name.endsWith('.js'))) {
    const src = readFileSync(new URL(file, dir), 'utf8');
    if (!/pageToolsMenuHtml\(/.test(src)) continue;
    carriers += 1;
    for (const match of src.matchAll(/closest\(\s*['"`]\.popover-menu__item\[data-action(?:="[^"]*")?\]['"`]\s*\)/g)) {
      offenders.push(`${file}: ${match[0]}`);
    }
  }
  assert.ok(carriers >= 8, `nur ${carriers} Seiten mit Werkzeugmenue gelesen - der Scan hat nichts gesehen`);
  assert.deepEqual(offenders, [],
    'Diese Klick-Handler treffen nur den Menue-Eintrag. Baut das Menue einen einzigen Eintrag '
    + '(von Haus aus oder weil Rechte es kuerzen), steht dort ein Knopf, der nichts tut - '
    + '`pageToolsActionEl(e.target, name)` aus utils/popover-menu.js nehmen.');
});
