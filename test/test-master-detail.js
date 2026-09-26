/**
 * Tests: Liste + Detail - der geteilte Baustein des Breitenregimes
 * Modul: /public/utils/master-detail.js (DESIGN.md, "Die Breitenregel")
 *
 * VERHALTENSTEST, KEIN TEXTGUARD. Der Baustein verspricht eine Bedienung -
 * Auswahl in der Adresse, Zurueck-Taste, Pfeiltasten, Enter/Esc, Leerzustand,
 * und unter der Schwelle den bisherigen Weg -, und ein Guard, der im Quelltext
 * nach `ArrowDown` oder `pushState` sucht, bliebe gruen, sobald der Handler
 * danebenliegt. Die Suite faehrt deshalb die echten Funktionen auf dem
 * kleinstmoeglichen DOM (Bauart test:popover-menu): Knoten mit Klassen und
 * Attributen, ein Selektorweg fuer genau die Formen, die das Modul benutzt,
 * und `getComputedStyle`, dessen `display` der Test umlegt - so wie die
 * Container Query in layout.css es im Browser tut.
 *
 * Die GEOMETRIE (Schwelle, Spalten, Listenbahn) haelt PAGE-019 in
 * test:frontend-audit; hier geht es um das, was ein Klick und eine Taste tun.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { installMiniDom } from './mini-dom.js';

// ── Kleinstes DOM ─────────────────────────────────────────────────────────

/** Ein Compound wie `[data-md-id].is-selected` oder `[aria-current="true"]`. */
function matchesCompound(node, compound) {
  if (!node?.classList) return false;
  const parts = compound.match(/\.[\w-]+|\[[\w-]+(?:="[^"]*")?\]/g) ?? [];
  if (!parts.length || parts.join('') !== compound) throw new Error(`Stub kennt den Selektor nicht: ${compound}`);
  return parts.every((part) => {
    if (part.startsWith('.')) return node.classList.contains(part.slice(1));
    const [, name, value] = part.match(/^\[([\w-]+)(?:="([^"]*)")?\]$/);
    const attr = node.getAttribute(name);
    return value === undefined ? attr !== null : attr === value;
  });
}

function matches(node, selector) {
  return selector.split(',').some((alt) => {
    const chain = alt.trim().split(/\s+/);
    if (!matchesCompound(node, chain.at(-1))) return false;
    let at = node.parent;
    for (let i = chain.length - 2; i >= 0; i -= 1) {
      while (at && !matchesCompound(at, chain[i])) at = at.parent;
      if (!at) return false;
      at = at.parent;
    }
    return true;
  });
}

class Node {
  constructor(classes = '', attrs = {}) {
    this.parent = null;
    this.children = [];
    this.attrs = new Map(Object.entries(attrs));
    this.hidden = false;
    this.focused = false;
    this.scrollTop = 0;
    this.listeners = [];
    this.isConnected = true;
    this.display = 'block';
    this.content = [];
    const set = new Set(String(classes).split(/\s+/).filter(Boolean));
    this.classList = {
      add: (c) => set.add(c),
      remove: (c) => set.delete(c),
      contains: (c) => set.has(c),
    };
    const node = this;
    this.dataset = new Proxy({}, {
      get(_, key) {
        const name = `data-${String(key).replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`)}`;
        return node.attrs.has(name) ? node.attrs.get(name) : undefined;
      },
      set(_, key, value) {
        node.attrs.set(`data-${String(key).replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`)}`, String(value));
        return true;
      },
    });
  }

  append(...kids) { for (const k of kids) { k.parent = this; this.children.push(k); } return this; }
  getAttribute(name) { return this.attrs.has(name) ? this.attrs.get(name) : null; }
  setAttribute(name, value) { this.attrs.set(name, String(value)); }
  removeAttribute(name) { this.attrs.delete(name); }
  focus() { document.activeElement = this; }
  scrollIntoView() {}
  getClientRects() { return this.hidden ? [] : [{}]; }
  contains(other) { for (let n = other; n; n = n.parent) if (n === this) return true; return false; }
  closest(sel) { for (let n = this; n; n = n.parent) if (n.classList && matches(n, sel)) return n; return null; }
  *walk() { for (const c of this.children) { yield c; yield* c.walk(); } }
  querySelectorAll(sel) { return [...this.walk()].filter((n) => matches(n, sel)); }
  querySelector(sel) { return this.querySelectorAll(sel)[0] ?? null; }
  replaceChildren(...kids) { this.children = []; this.content = []; this.append(...kids); }
  addEventListener(type, handler) { this.listeners.push({ type, handler }); }
  dispatch(type, event) {
    // Aufsteigen wie im Browser: das Modul haengt am Listen-Container und
    // an der Detailspalte, das Ereignis entsteht an der Zeile.
    for (let n = event.target; n; n = n.parent) {
      for (const l of n.listeners) if (l.type === type) l.handler(event);
    }
  }
}

function key(target, keyName, extra = {}) {
  let prevented = false;
  const event = {
    target, key: keyName, altKey: false, ctrlKey: false, metaKey: false,
    defaultPrevented: false,
    preventDefault() { prevented = true; this.defaultPrevented = true; },
    ...extra,
  };
  target.dispatch('keydown', event);
  return prevented;
}

// ── Globale Umgebung: Adresse, History, Rechnung ─────────────────────────

const historyLog = [];
function setUrl(path) {
  const url = new URL(path, 'http://yuvomi.test');
  global.location = { href: url.href, pathname: url.pathname, search: url.search, hash: url.hash };
}
global.history = {
  state: null,
  pushState(state, _t, path) { historyLog.push(['push', path]); this.state = state; setUrl(path); },
  replaceState(state, _t, path) { historyLog.push(['replace', path]); this.state = state; setUrl(path); },
};
global.document = { activeElement: null };
global.window = {};
global.CSS = { escape: (s) => String(s) };
global.getComputedStyle = (node) => ({ display: node.display });

const md = await import('../public/utils/master-detail.js');

/**
 * Eine Seite mit fuenf Zeilen, die dritte ausgeblendet (Filter). Jede Zeile
 * traegt ihren Fokus-Knopf `[data-md-focus]` und daneben ein Kaestchen -
 * das Ziel, auf dem Pfeiltasten NICHT die Auswahl bewegen duerfen.
 */
function makePage({ split = true, path = '/contacts' } = {}) {
  setUrl(path);
  historyLog.length = 0;
  document.activeElement = null;
  const root = new Node('split-view');
  const list = new Node('split-view__list');
  const detail = new Node('split-view__detail');
  detail.display = split ? 'flex' : 'none';
  const empty = new Node('split-view__empty', { 'data-md-empty': '' });
  const body = new Node('split-view__detail-body', { 'data-md-body': '' });
  body.hidden = true;
  detail.append(empty, body);
  const rows = [];
  for (const id of ['1', '2', '3', '4', '5']) {
    const row = new Node('list-row', { 'data-md-id': id });
    const main = new Node('list-row__main', { 'data-md-focus': '' });
    const check = new Node('list-row__check');
    row.append(main, check);
    rows.push(row);
    list.append(row);
  }
  rows[2].hidden = true;
  root.append(list, detail);
  const calls = { render: [], narrow: [], enter: [] };
  const page = {
    root, list, detail, empty, body, rows, calls,
    focusOf: (i) => rows[i].children[0],
    checkOf: (i) => rows[i].children[1],
    setSplit(on) { detail.display = on ? 'flex' : 'none'; },
  };
  page.mount = (opts = {}) => md.mountMasterDetail({
    root,
    renderDetail: (id, into) => { calls.render.push(id); into.content = [`detail:${id}`]; },
    openNarrow: (id) => calls.narrow.push(id),
    onEnter: (id) => calls.enter.push(id),
    ...opts,
  });
  return page;
}

const tick = () => new Promise((r) => setTimeout(r, 0));

// ── Klick: in der Spalte auswaehlen, darunter der bisherige Weg ───────────

test('in der Spalte waehlt ein Klick aus: Markierung, Adresse, Detail statt Leerzustand', async () => {
  const p = makePage();
  const handle = p.mount();
  assert.equal(p.empty.hidden, false, 'ohne Auswahl steht der Leerzustand');
  handle.open('2');
  await tick();
  assert.deepEqual(p.calls.render, ['2']);
  assert.deepEqual(p.calls.narrow, [], 'in der Spalte oeffnet kein Modal');
  assert.equal(p.rows[1].classList.contains('is-selected'), true);
  assert.equal(p.focusOf(1).getAttribute('aria-current'), 'true', 'der Screenreader hoert, welche Zeile rechts steht');
  assert.equal(location.search, '?open=2');
  assert.deepEqual(historyLog, [['push', '/contacts?open=2']], 'ein Klick ist ein Schritt fuer die Zurueck-Taste');
  assert.equal(p.empty.hidden, true);
  assert.equal(p.body.hidden, false);
  handle.open('4');
  await tick();
  assert.equal(p.rows[1].classList.contains('is-selected'), false, 'die alte Markierung geht');
  assert.equal(p.focusOf(1).getAttribute('aria-current'), null);
  handle.destroy();
});

test('unter der Schwelle oeffnet ein Klick den bisherigen Weg und laesst die Adresse stehen', () => {
  const p = makePage({ split: false });
  const handle = p.mount();
  handle.open('2', p.focusOf(1));
  assert.deepEqual(p.calls.narrow, ['2']);
  assert.deepEqual(p.calls.render, []);
  assert.deepEqual(historyLog, [], 'das Modal fuehrt seinen eigenen History-Marker (overlay-history)');
  assert.equal(p.rows[1].classList.contains('is-selected'), false);
  handle.destroy();
});

test('unter der Schwelle mit gemerkter Auswahl: ein anderer Eintrag uebernimmt Auswahl und Adresse', () => {
  // Auswahl A (Spalte oder Deep-Link), dann schmal, dann B antippen: das Blatt
  // zeigt B. Blieben Auswahl und `?open=` bei A, nennte die Adresse den
  // falschen Eintrag, und beim Verbreitern stuende A in der Spalte. Gilt fuer
  // Seiten, deren Adresse auch schmal ein Blatt oeffnet (`deepLinkNarrow`).
  const p = makePage({ path: '/contacts?open=2', split: false });
  const handle = p.mount({ deepLinkNarrow: true });
  assert.equal(handle.selectedId(), '2');
  historyLog.length = 0;
  handle.open('4', p.focusOf(3));
  assert.deepEqual(p.calls.narrow, ['2', '4'], 'der Deep-Link oeffnete schmal sein Blatt, dann der Klick das naechste');
  assert.equal(handle.selectedId(), '4', 'die Auswahl folgt dem geoeffneten Eintrag');
  assert.equal(location.search, '?open=4', 'die Adresse ebenso');
  assert.deepEqual(historyLog, [['replace', '/contacts?open=4']],
    'ersetzt, nicht gestapelt: das Blatt fuehrt seinen eigenen Zurueck-Schritt');
  handle.open('4', p.focusOf(3));
  assert.equal(historyLog.length, 1, 'derselbe Eintrag noch einmal schreibt nichts');
  handle.destroy();

  // Ohne gemerkte Auswahl bleibt es beim bisherigen Weg: die Adresse ruht.
  const q = makePage({ split: false });
  const h2 = q.mount({ deepLinkNarrow: true });
  h2.open('4', q.focusOf(3));
  assert.equal(h2.selectedId(), null);
  assert.deepEqual(historyLog, []);
  h2.destroy();

  // Inventar oeffnet schmal ebenfalls ein BLATT, loest den Deep-Link dort aber
  // nicht ein (`deepLinkNarrow` aus). Die Wanderung haengt am Blatt, nicht am
  // Deep-Link: sonst stuende nach dem Verbreitern A in der Spalte und B's
  // Blatt darueber.
  const inv = makePage({ path: '/inventory?open=2', split: false });
  const h4 = inv.mount();
  historyLog.length = 0;
  h4.open('4', inv.focusOf(3));
  assert.equal(h4.selectedId(), '4', 'Blatt ohne deepLinkNarrow: die Auswahl folgt');
  assert.deepEqual(historyLog, [['replace', '/inventory?open=4']]);
  h4.destroy();

  // Ein Akkordeon (Rezepte, `narrow: 'accordion'`) schreibt unter der Schwelle
  // nie eine Adresse - dort ist `?open=` nur der Einstieg, und mehrere Eintraege
  // stehen gleichzeitig offen (CI an #1477, test-recipes-fab-dock).
  const r = makePage({ path: '/recipes?open=2', split: false });
  const h3 = r.mount({ narrow: 'accordion' });
  historyLog.length = 0;
  h3.open('4', r.focusOf(3));
  assert.deepEqual(r.calls.narrow, ['4']);
  assert.equal(location.search, '?open=2', 'das Akkordeon schreibt keine Adresse');
  assert.deepEqual(historyLog, []);
  h3.destroy();
});

test('andere Adress-Parameter bleiben stehen', () => {
  const p = makePage({ path: '/tasks?view=list' });
  const handle = p.mount();
  handle.open('5');
  assert.equal(location.search, '?view=list&open=5');
  handle.clear();
  assert.equal(location.search, '?view=list');
  handle.destroy();
});

// ── Tastatur ─────────────────────────────────────────────────────────────

test('Pfeil runter/hoch bewegt Auswahl und Fokus, ueberspringt Ausgeblendetes, ersetzt statt zu stapeln', () => {
  const p = makePage();
  const handle = p.mount();
  handle.open('2');
  historyLog.length = 0;
  p.focusOf(1).focus();
  assert.equal(key(p.focusOf(1), 'ArrowDown'), true);
  assert.equal(handle.selectedId(), '4', 'Zeile 3 ist ausgeblendet und wird uebersprungen');
  assert.equal(document.activeElement, p.focusOf(3), 'der Fokus wandert mit');
  assert.equal(key(p.focusOf(3), 'ArrowUp'), true);
  assert.equal(handle.selectedId(), '2');
  assert.deepEqual(historyLog.map(([mode]) => mode), ['replace', 'replace'],
    'wer durch zwanzig Zeilen blaettert, will nicht zwanzigmal zurueck');
  key(p.focusOf(1), 'End');
  assert.equal(handle.selectedId(), '5');
  key(p.focusOf(4), 'Home');
  assert.equal(handle.selectedId(), '1');
  handle.destroy();
});

test('Pfeile aus einem Bedienelement IN der Zeile gehoeren dem Element, und unter der Schwelle gar nichts', () => {
  const p = makePage();
  const handle = p.mount();
  handle.open('2');
  assert.equal(key(p.checkOf(1), 'ArrowDown'), false);
  assert.equal(handle.selectedId(), '2');
  p.setSplit(false);
  assert.equal(key(p.focusOf(1), 'ArrowDown'), false, 'ohne Spalte bleibt die Taste beim Browser');
  assert.equal(handle.selectedId(), '2');
  handle.destroy();
});

test('Enter auf der gewaehlten Zeile oeffnet, Esc in der Liste hebt die Auswahl auf', () => {
  const p = makePage();
  const handle = p.mount();
  handle.open('4');
  assert.equal(key(p.focusOf(3), 'Enter'), true);
  assert.deepEqual(p.calls.enter, ['4']);
  // Enter auf einer ANDEREN Zeile ist deren Klick - das faengt der Baustein nicht ab.
  assert.equal(key(p.focusOf(0), 'Enter'), false);
  historyLog.length = 0;
  assert.equal(key(p.focusOf(3), 'Escape'), true);
  assert.equal(handle.selectedId(), null);
  assert.equal(p.empty.hidden, false, 'der Leerzustand kommt zurueck');
  assert.deepEqual(historyLog, [['replace', '/contacts']]);
  handle.destroy();
});

test('Esc im Detail fuehrt zur Zeile zurueck und behaelt die Auswahl', () => {
  const p = makePage();
  const handle = p.mount();
  handle.open('4');
  const inner = new Node('btn');
  p.body.append(inner);
  assert.equal(key(inner, 'Escape'), true);
  assert.equal(document.activeElement, p.focusOf(3));
  assert.equal(handle.selectedId(), '4');
  // Hat ein Menue im Detail Esc schon verbraucht, bleibt der Fokus dort.
  document.activeElement = inner;
  key(inner, 'Escape', { defaultPrevented: true });
  assert.equal(document.activeElement, inner);
  handle.destroy();
});

// ── Renderer, Deep-Link, Zurueck-Taste ───────────────────────────────────

test('meldet der Renderer eine unbekannte ID, faellt die Auswahl auf den Leerzustand', async () => {
  const p = makePage();
  const handle = p.mount({ renderDetail: () => false });
  handle.open('2');
  await tick();
  assert.equal(handle.selectedId(), null);
  assert.equal(p.empty.hidden, false);
  assert.equal(location.search, '', 'keine Adresse, die auf nichts zeigt');
  handle.destroy();
});

test('wirft der Renderer (Netz, 500), bleibt die Auswahl und die Spalte bietet Erneut versuchen', async () => {
  // Vertrag: `false` heisst „gibt es nicht (mehr)" - dann Leerzustand und die
  // Adresse geht. Ein Fehler ist voruebergehend: eine Zeitueberschreitung darf
  // weder die Auswahl noch den Link wegwerfen.
  const saved = global.document;
  const restore = installMiniDom();
  const handlers = [];
  const make = global.document.createElement;
  global.document.createElement = (tag) => {
    const el = make(tag);
    el.addEventListener = (type, h) => handlers.push({ type, h, el });
    return el;
  };
  global.document.activeElement = null;
  try {
    const p = makePage();
    let fail = true;
    const handle = p.mount({
      renderDetail: async (id, into) => {
        p.calls.render.push(id);
        if (fail) throw Object.assign(new Error('Server'), { status: 500 });
        into.replaceChildren();
        into.content = [`detail:${id}`];
        return undefined;
      },
    });
    handle.open('2');
    await tick();
    assert.equal(handle.selectedId(), '2', 'die Auswahl bleibt');
    assert.equal(location.search, '?open=2', 'der Link bleibt');
    assert.equal(p.rows[1].classList.contains('is-selected'), true);
    assert.equal(p.empty.hidden, true, 'kein Leerzustand - der behauptete, es gaebe nichts');
    assert.equal(p.body.hidden, false);
    assert.equal(p.body.inert, false, 'der Fehlerzustand ist bedienbar');
    const box = p.body.children[0];
    assert.match(box?.outerHTML ?? '', /empty-state--error|variant-error|error/, 'die Spalte zeigt einen Fehlerzustand');
    assert.match(box.outerHTML, /HTTP 500/, 'mit dem Statuscode als technische Zeile');
    const retry = handlers.find((x) => x.type === 'click');
    assert.ok(retry, 'mit einem Weg zurueck: Erneut versuchen');
    fail = false;
    retry.h();
    await tick();
    assert.deepEqual(p.calls.render, ['2', '2'], 'Erneut versuchen zeichnet dieselbe Auswahl noch einmal');
    assert.deepEqual(p.body.content, ['detail:2']);
    handle.destroy();
  } finally {
    restore();
    global.document = saved;
  }
});

test('eine ueberholte, langsame Antwort raeumt die neuere Auswahl nicht ab', async () => {
  const p = makePage();
  let release;
  const slow = new Promise((r) => { release = r; });
  const handle = p.mount({
    renderDetail: (id) => (id === '1' ? slow.then(() => false) : undefined),
  });
  handle.open('1');
  handle.open('2');
  release();
  await tick();
  await tick();
  assert.equal(handle.selectedId(), '2');
  assert.equal(p.empty.hidden, true);
  handle.destroy();
});

test('waehrend ein langsamer Renderer laedt, ist der alte Eintrag nicht mehr bedienbar', async () => {
  // Inventar laedt den Verlauf, bevor es zeichnet. Bis dahin stand der
  // vorige Gegenstand samt Bearbeiten/Loeschen klickbar neben der neuen
  // Markierung - ein Klick traf den falschen.
  const p = makePage();
  const pending = new Map();
  const handle = p.mount({
    renderDetail: (id, into) => new Promise((resolve) => {
      pending.set(id, () => { into.content = [`detail:${id}`]; resolve(); });
    }),
  });
  handle.open('1');
  pending.get('1')();
  await tick();
  assert.equal(p.body.inert, false, 'fertig gezeichnet: bedienbar');
  assert.equal(p.body.getAttribute('aria-busy'), null);
  handle.open('2');
  assert.deepEqual(p.body.content, ['detail:1'], 'der alte Inhalt steht noch (kein Flackern) ...');
  assert.equal(p.body.inert, true, '... aber er nimmt keine Klicks und keinen Fokus mehr');
  assert.equal(p.body.getAttribute('aria-busy'), 'true', 'und der Screenreader hoert, dass geladen wird');
  handle.open('4');
  pending.get('2')();
  await tick();
  assert.equal(p.body.inert, true, 'eine ueberholte Antwort gibt die Spalte nicht frei');
  pending.get('4')();
  await tick();
  assert.equal(p.body.inert, false);
  assert.equal(p.body.getAttribute('aria-busy'), null);
  handle.open('5');
  handle.clear();
  assert.equal(p.body.inert, false, 'der Leerzustand ist nie gesperrt');
  handle.destroy();
});

test('Deep-Link: ?open= waehlt in der Spalte ohne History-Eintrag; darunter nur auf Wunsch', () => {
  let p = makePage({ path: '/contacts?open=4' });
  let handle = p.mount();
  assert.equal(handle.selectedId(), '4');
  assert.deepEqual(p.calls.render, ['4']);
  assert.deepEqual(historyLog, [], 'der Aufbau schreibt keine Geschichte');
  handle.destroy();

  p = makePage({ path: '/contacts?open=4', split: false });
  handle = p.mount();
  assert.deepEqual(p.calls.narrow, [], 'ein Modal beim Seitenaufbau oeffnet nur, wer es verlangt');
  handle.destroy();

  p = makePage({ path: '/contacts?open=4', split: false });
  handle = p.mount({ deepLinkNarrow: true });
  assert.deepEqual(p.calls.narrow, ['4']);
  handle.destroy();
});

test('Zurueck/Vor innerhalb der Seite loest der Baustein, nicht der Router', () => {
  const p = makePage();
  const handle = p.mount();
  handle.open('2');
  setUrl('/contacts');
  assert.equal(md.handleMasterDetailPopstate(), true, 'dieselbe Seite: kein Neuzeichnen');
  assert.equal(handle.selectedId(), null);
  setUrl('/contacts?open=5');
  assert.equal(md.handleMasterDetailPopstate(), true);
  assert.equal(handle.selectedId(), '5');
  setUrl('/tasks');
  assert.equal(md.handleMasterDetailPopstate(), false, 'eine andere Seite gehoert dem Router');
  p.root.isConnected = false;
  setUrl('/contacts');
  assert.equal(md.handleMasterDetailPopstate(), false, 'eine abgeraeumte Seite haelt die Geste nicht fest');
  assert.equal(md.handleMasterDetailPopstate(), false, 'und sie ist danach abgemeldet');
});

test('Zurueck/Vor unter der Schwelle: mit deepLinkNarrow oeffnet die Adresse den bisherigen Weg', () => {
  // Deep-Link oeffnet das Blatt, Zurueck schliesst es und verlaesst den
  // Eintrag, Vor kehrt auf `?open=4` zurueck. Ohne Oeffnen zeigte die Adresse
  // einen Kontakt, und der Bildschirm zeigte die Liste.
  let p = makePage({ split: false });
  let handle = p.mount({ deepLinkNarrow: true });
  setUrl('/contacts?open=4');
  assert.equal(md.handleMasterDetailPopstate(), true);
  assert.deepEqual(p.calls.narrow, ['4'], 'Vor auf einen Eintrag oeffnet ihn wie der Deep-Link beim Laden');
  assert.deepEqual(historyLog, [], 'die Geste schreibt keine Geschichte');
  assert.equal(handle.selectedId(), '4');
  setUrl('/contacts');
  assert.equal(md.handleMasterDetailPopstate(), true);
  assert.deepEqual(p.calls.narrow, ['4'], 'ohne ?open= oeffnet nichts');
  handle.destroy();

  // Ohne den Wunsch bleibt es beim Merken - kein Modal aus einer Geste, die
  // niemand dafuer gemacht hat.
  p = makePage({ split: false });
  handle = p.mount();
  setUrl('/contacts?open=4');
  assert.equal(md.handleMasterDetailPopstate(), true);
  assert.deepEqual(p.calls.narrow, []);
  assert.equal(handle.selectedId(), '4');
  handle.destroy();
});

test('openNarrow bekommt ein Signal: es bricht ab, sobald die Auswahl, die Darstellung oder die Seite wechselt', () => {
  // Aufgaben laden das Blatt erst (zwei Anfragen). Geht der Nutzer in der
  // Zeit zurueck, wird das Fenster breit oder die Seite verlassen, darf die
  // Fortsetzung kein altes Blatt mehr ueber die neue Lage legen.
  const observers = [];
  global.ResizeObserver = class { constructor(cb) { this.cb = cb; observers.push(this); } observe() {} disconnect() {} };
  try {
    const p = makePage({ split: false });
    const signals = [];
    const handle = p.mount({ deepLinkNarrow: true, openNarrow: (id, _t, ctx) => { p.calls.narrow.push(id); signals.push(ctx?.signal); } });
    handle.open('1');
    assert.ok(signals[0] instanceof AbortSignal, 'ein Signal je Oeffnen');
    handle.open('2');
    assert.equal(signals[0].aborted, true, 'ein neues Oeffnen ueberholt das alte');
    assert.equal(signals[1].aborted, false);
    setUrl('/contacts?open=4');
    md.handleMasterDetailPopstate();
    assert.equal(signals[1].aborted, true, 'Vor/Zurueck ueberholt es');
    setUrl('/contacts');
    md.handleMasterDetailPopstate();
    assert.equal(signals[2].aborted, true, 'auch Zurueck ohne neuen Eintrag');
    handle.open('5');
    p.setSplit(true);
    for (const o of observers) o.cb();
    assert.equal(signals[3].aborted, true, 'breiter gezogen: die Spalte zeigt es, kein Blatt mehr');
    p.setSplit(false);
    for (const o of observers) o.cb();
    handle.open('1');
    handle.destroy();
    assert.equal(signals[4].aborted, true, 'die Seite ist weg');
  } finally {
    delete global.ResizeObserver;
  }
});

test('Deep-Link unter der Schwelle merkt die Auswahl: wird das Fenster breiter, steht das Detail', () => {
  const observers = [];
  global.ResizeObserver = class { constructor(cb) { this.cb = cb; observers.push(this); } observe() {} disconnect() {} };
  try {
    const p = makePage({ path: '/contacts?open=4', split: false });
    const handle = p.mount({ deepLinkNarrow: true });
    assert.deepEqual(p.calls.narrow, ['4']);
    assert.equal(handle.selectedId(), '4', 'die Adresse nennt eine Auswahl, also kennt der Baustein sie');
    p.setSplit(true);
    for (const o of observers) o.cb();
    assert.deepEqual(p.calls.render, ['4'], 'breiter gezogen: die Spalte zeichnet den Eintrag aus der Adresse');
    assert.equal(p.rows[3].classList.contains('is-selected'), true);
    assert.equal(p.empty.hidden, true, 'kein Leerzustand neben ?open=4');
    handle.destroy();
  } finally {
    delete global.ResizeObserver;
  }
});

test('onModeChange: beim Wechsel der Darstellung fragt der Baustein das Modul, BEVOR er zeichnet', () => {
  // Inventar: unter der Schwelle steht die Kategorien-Startseite, die Zeile
  // des Gegenstands aus `?open=` gibt es dort nicht. Beim Breiterwerden muss
  // das Modul sie erst zeigen koennen - sonst malt die Spalte ein Detail ohne
  // Zeile, und der naechste refresh() raeumt Auswahl und Adresse ab.
  const observers = [];
  global.ResizeObserver = class { constructor(cb) { this.cb = cb; observers.push(this); } observe() {} disconnect() {} };
  try {
    const p = makePage({ path: '/inventory?open=6', split: false });
    const seen = [];
    const handle = p.mount({
      onModeChange: ({ split, selectedId }) => {
        seen.push([split, selectedId, p.calls.render.length]);
        if (split) {
          const row = new Node('list-row', { 'data-md-id': '6' });
          row.append(new Node('list-row__main', { 'data-md-focus': '' }));
          p.list.append(row);
        }
      },
    });
    for (const o of observers) o.cb(); // der erste Aufruf nach observe(): kein Wechsel
    assert.deepEqual(seen, [], 'ohne Wechsel kein Aufruf');
    p.setSplit(true);
    for (const o of observers) o.cb();
    assert.deepEqual(seen, [[true, '6', 0]], 'das Modul hoert den Wechsel samt Auswahl, vor dem Zeichnen');
    assert.deepEqual(p.calls.render, ['6']);
    assert.equal(p.list.children.at(-1).classList.contains('is-selected'), true, 'die gezeigte Zeile ist markiert');
    p.setSplit(false);
    for (const o of observers) o.cb();
    assert.deepEqual(seen.at(-1), [false, '6', 1], 'auch schmaler wird gemeldet');
    handle.destroy();
  } finally {
    delete global.ResizeObserver;
  }
});

test('Zurueck/Vor mit einem anderen Parameter als der Auswahl gehoert dem Router', () => {
  // Aufgaben: `?view=list|kanban|history`. Aendert Zurueck die Ansicht, muss
  // die Seite neu zeichnen - sonst zeigt die Adresse die Liste und der
  // Bildschirm das Brett.
  const p = makePage({ path: '/tasks?view=list' });
  const handle = p.mount();
  handle.open('2');
  assert.equal(location.search, '?view=list&open=2');
  setUrl('/tasks?view=list');
  assert.equal(md.handleMasterDetailPopstate(), true, 'nur die Auswahl hat sich geaendert: der Baustein');
  assert.equal(handle.selectedId(), null);
  setUrl('/tasks?view=kanban&open=2');
  assert.equal(md.handleMasterDetailPopstate(), false, 'die Ansicht hat sich geaendert: der Router zeichnet neu');
  assert.equal(handle.selectedId(), null, 'und der Baustein greift der neuen Seite nicht vor');
  setUrl('/tasks?view=list#x');
  assert.equal(md.handleMasterDetailPopstate(), false, 'auch ein anderer Anker ist nicht die Auswahl');
  handle.destroy();
});

test('refresh(): verschwindet die gewaehlte Zeile (geloescht, weggefiltert), kommt der Leerzustand', () => {
  const p = makePage();
  const handle = p.mount();
  handle.open('4');
  p.list.children.splice(3, 1);
  handle.refresh();
  assert.equal(handle.selectedId(), null);
  assert.equal(p.empty.hidden, false);
  handle.destroy();
});

test('das Router-Signal baut ab: danach haelt keine Instanz mehr die Zurueck-Taste', () => {
  const p = makePage();
  const controller = new AbortController();
  p.mount({ signal: controller.signal });
  controller.abort();
  assert.equal(md.handleMasterDetailPopstate(), false);
});

test('abgehaengte Wurzel oder abgebrochenes Signal: kein Einhaengen, die lebende Instanz bleibt', () => {
  // Ein spaeter Neuaufbau (Wiederholen nach Ladefehler) gegen einen Baum, den
  // der Router schon weggeraeumt hat, ersetzte sonst die Instanz der Seite,
  // auf der der Nutzer jetzt steht - Zurueck und Fensterwechsel liefen ins Leere.
  const live = makePage();
  const liveHandle = live.mount();
  liveHandle.open('2');

  const stale = makePage({ path: '/contacts?open=2' });
  stale.root.isConnected = false;
  const dead = stale.mount();
  assert.deepEqual(stale.calls.render, [], 'ein abgehaengter Baum zeichnet nichts');
  assert.equal(dead.selectedId(), null);
  assert.equal(dead.isSplit(), false);
  dead.open('3');
  assert.deepEqual(stale.calls.narrow, [], 'und oeffnet nichts');
  setUrl('/contacts');
  assert.equal(md.handleMasterDetailPopstate(), true, 'die lebende Instanz haelt die Zurueck-Taste weiter');
  assert.equal(liveHandle.selectedId(), null);

  const aborted = new AbortController();
  aborted.abort();
  const late = makePage();
  late.mount({ signal: aborted.signal }).open('1');
  assert.deepEqual(late.calls.render, [], 'ein abgebrochenes Signal haengt ebenso nichts ein');
  setUrl('/contacts?open=4');
  assert.equal(md.handleMasterDetailPopstate(), true);
  assert.equal(liveHandle.selectedId(), '4', 'die Geste erreicht weiter die lebende Seite');
  liveHandle.destroy();
});

test('der Router fragt den Baustein, BEVOR er bei popstate neu zeichnet', () => {
  // Verdrahtung, die kein Einheitentest der Funktion sieht: ohne den Aufruf im
  // Router zeichnete jedes Zurueck die ganze Seite neu (Skelett, Uebergang,
  // Scrollstand) - fuer einen Wechsel der rechten Spalte.
  const router = readFileSync(new URL('../public/router.js', import.meta.url), 'utf8');
  const block = router.slice(router.indexOf("window.addEventListener('popstate'"));
  const handler = block.slice(0, block.indexOf('});') + 3);
  const consult = handler.indexOf('handleMasterDetailPopstate()');
  const nav = handler.indexOf('navigate(target, false)');
  assert.ok(consult > 0 && nav > consult, 'popstate: handleMasterDetailPopstate() muss vor navigate() stehen');
  assert.ok(handler.indexOf('handleBackNavigation()') < consult,
    'ein offener Dialog faengt die Geste zuerst (#871), erst dann die Auswahl');
});

test('splitViewDetailHtml: benannte Spalte mit Leerzustand und leerem Koerper, Nutzertext escaped', () => {
  const saved = global.document;
  installMiniDom();
  try {
    const html = md.splitViewDetailHtml({
      id: 'contacts',
      label: 'Kontakt <b>',
      empty: { icon: 'contact', title: 'Waehle einen Kontakt', hint: 'Das Detail steht hier.' },
    });
    assert.match(html, /<section class="split-view__detail" id="contacts-detail" aria-label="Kontakt &lt;b&gt;" tabindex="-1">/);
    assert.match(html, /data-md-empty>[\s\S]*Waehle einen Kontakt/, 'der Leerzustand nennt, was die Spalte tut');
    assert.match(html, /<div class="split-view__detail-body" data-md-body hidden><\/div>/);
  } finally {
    global.document = saved;
  }
});
