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
import { eachRule } from './css-rules.js';

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
  // Die Vorwahl (opts.preselect, Standard an) ist hier AUS: diese Tests
  // pruefen, was ein Klick und eine Taste von einem leeren Anfang aus tun.
  // Die Vorwahl selbst pruefen die Tests unter „Vorwahl" mit `preselect: true`.
  page.mount = (opts = {}) => md.mountMasterDetail({
    root,
    preselect: false,
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

test('der erste Pfeil ohne Auswahl waehlt die fokussierte Zeile, nicht erst die naechste', () => {
  // Wie in Mail: wer per Tab in die Liste kommt, steht auf der ersten Zeile,
  // ohne dass etwas gewaehlt ist. Der erste Pfeil waehlte bis 2026-09-26 die
  // NAECHSTE Zeile - die fokussierte war nur ueber den Umweg Pfeil hoch zu
  // erreichen, und rechts stand nie, worauf der Fokus gerade lag (R4, #1477).
  const p = makePage();
  const handle = p.mount();
  historyLog.length = 0;
  p.focusOf(0).focus();
  assert.equal(key(p.focusOf(0), 'ArrowDown'), true);
  assert.equal(handle.selectedId(), '1', 'der erste Pfeil ist an der fokussierten Zeile vorbeigesprungen');
  assert.equal(document.activeElement, p.focusOf(0));
  assert.deepEqual(historyLog.map(([mode]) => mode), ['push'], 'die erste Auswahl ist ein Schritt fuer die Zurueck-Taste');
  assert.equal(key(p.focusOf(0), 'ArrowDown'), true);
  assert.equal(handle.selectedId(), '2', 'ab jetzt bewegt der Pfeil die Auswahl');
  handle.clear();
  assert.equal(key(p.focusOf(3), 'ArrowUp'), true);
  assert.equal(handle.selectedId(), '4', 'auch Pfeil hoch nimmt zuerst die fokussierte Zeile');
  handle.clear();
  assert.equal(key(p.focusOf(1), 'End'), true);
  assert.equal(handle.selectedId(), '5', 'Pos1/Ende springen weiter an die Enden');
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

// ── Vorwahl: der Einstieg zeigt rechts gleich einen Eintrag (L2) ──────────

test('Vorwahl: in der Spalte ohne Adress-Auswahl steht die erste sichtbare Zeile, per replaceState', async () => {
  const p = makePage();
  const handle = md.mountMasterDetail({
    root: p.root,
    renderDetail: (id, into) => { p.calls.render.push(id); into.content = [`detail:${id}`]; },
    openNarrow: (id) => p.calls.narrow.push(id),
  });
  await tick();
  assert.equal(handle.selectedId(), '1', 'Standard: die erste Zeile ist gewaehlt');
  assert.deepEqual(p.calls.render, ['1']);
  assert.equal(p.empty.hidden, true, 'kein „Waehle ..." beim Einstieg');
  assert.deepEqual(historyLog, [['replace', '/contacts?open=1']], 'kein Schritt fuer die Zurueck-Taste');
  assert.equal(document.activeElement, null, 'die Vorwahl nimmt niemandem den Fokus');
  handle.destroy();
});

test('Vorwahl: nie unter der Schwelle, nie gegen ?open=, nie mit preselect:false', () => {
  let p = makePage({ split: false });
  let handle = p.mount({ preselect: true });
  assert.equal(handle.selectedId(), null, 'mobil oeffnet der Einstieg nichts');
  assert.deepEqual(historyLog, []);
  handle.destroy();

  p = makePage({ path: '/contacts?open=4' });
  handle = p.mount({ preselect: true });
  assert.equal(handle.selectedId(), '4', 'der Deep-Link hat Vorrang');
  assert.deepEqual(p.calls.render, ['4']);
  handle.destroy();

  // Die Seite loest den Link selbst ein (Aufgaben, claimInitial:false): die
  // Adresse nennt trotzdem eine Auswahl, also keine Vorwahl daneben.
  p = makePage({ path: '/tasks?open=99' });
  handle = p.mount({ preselect: true, claimInitial: false });
  assert.equal(handle.selectedId(), null);
  assert.equal(location.search, '?open=99', 'der Link bleibt stehen');
  handle.destroy();

  p = makePage();
  handle = p.mount({ preselect: false });
  assert.equal(handle.selectedId(), null);
  handle.destroy();
});

test('Vorwahl: eigene Wahl per Funktion, spaete Liste per refresh(), Esc bleibt leer', () => {
  let p = makePage();
  let seen = null;
  let handle = p.mount({ preselect: (ids) => { seen = ids; return ids.at(-1); } });
  assert.deepEqual(seen, ['1', '2', '4', '5'], 'nur sichtbare Zeilen (die dritte ist weggefiltert)');
  assert.equal(handle.selectedId(), '5');
  handle.destroy();

  // Die Liste kommt erst nach dem Aufbau (Rezepte): refresh() holt es nach.
  p = makePage();
  const kept = p.list.children.splice(0);
  handle = p.mount({ preselect: true });
  assert.equal(handle.selectedId(), null, 'ohne Zeilen nichts');
  p.list.append(...kept);
  handle.refresh();
  assert.equal(handle.selectedId(), '1');
  // Wer abwaehlt, bekommt den Leerzustand - kein Zurueckspringen beim naechsten refresh().
  key(p.focusOf(0), 'Escape');
  assert.equal(handle.selectedId(), null);
  handle.refresh();
  assert.equal(handle.selectedId(), null, 'eine Vorwahl je Aufbau, danach entscheidet der Nutzer');
  handle.destroy();

  // Verschwindet die gewaehlte Zeile (Kategorie gewechselt, weggefiltert), ist
  // das ein neuer Zusammenhang - wie Mail beim Ordnerwechsel: der erste steht.
  p = makePage();
  handle = p.mount({ preselect: true });
  handle.open('4');
  p.list.children.splice(0, 1);
  p.list.children.splice(2, 1);
  handle.refresh();
  assert.equal(handle.selectedId(), '2', 'nach dem Wegfall steht die erste verbliebene Zeile');
  assert.deepEqual(historyLog.at(-1), ['replace', '/contacts?open=2']);
  handle.destroy();

  // Ein Deep-Link auf etwas, das nie eine Zeile hatte, ist ein „gibt es
  // nicht" (Rueckgabe-Vertrag): Leerzustand, keine Vorwahl daneben.
  p = makePage({ path: '/contacts?open=99' });
  handle = p.mount({ preselect: true });
  handle.refresh();
  assert.equal(handle.selectedId(), null);
  assert.equal(p.empty.hidden, false);
  assert.equal(location.search, '');
  handle.destroy();
});

test('Vorwahl: beim Wechsel schmal -> Spalte, ohne gemerkte Auswahl', () => {
  const observers = [];
  global.ResizeObserver = class { constructor(cb) { this.cb = cb; observers.push(this); } observe() {} disconnect() {} };
  try {
    const p = makePage({ split: false });
    const handle = p.mount({ preselect: true });
    assert.equal(handle.selectedId(), null);
    p.setSplit(true);
    for (const o of observers) o.cb();
    assert.equal(handle.selectedId(), '1');
    assert.deepEqual(p.calls.narrow, [], 'und oeffnet dabei kein Blatt');
    handle.destroy();
  } finally {
    delete global.ResizeObserver;
  }
});

// ── Pfad-Adressen (Einstellungen, Gesundheit) ─────────────────────────────

test('address: Auswahl als Pfad - Klick pusht, Vorwahl ersetzt, Zurueck/Vor loest der Baustein', () => {
  const p = makePage({ path: '/health' });
  const address = {
    read: (loc) => {
      const m = loc.pathname.match(/^\/health\/([^/]+)$/);
      if (m) return m[1];
      return loc.pathname === '/health' ? null : undefined;
    },
    href: (id) => (id ? `/health/${id}` : '/health'),
  };
  const handle = p.mount({ address, preselect: true, param: 'ignored' });
  assert.equal(handle.selectedId(), '1');
  assert.deepEqual(historyLog, [['replace', '/health/1']]);
  handle.open('4');
  assert.deepEqual(historyLog.at(-1), ['push', '/health/4']);
  setUrl('/health/1');
  assert.equal(md.handleMasterDetailPopstate(), true, 'ein anderer Pfad derselben Seite: kein Neuzeichnen');
  assert.equal(handle.selectedId(), '1');
  setUrl('/health');
  assert.equal(md.handleMasterDetailPopstate(), true);
  assert.equal(handle.selectedId(), null);
  setUrl('/tasks');
  assert.equal(md.handleMasterDetailPopstate(), false, 'eine fremde Adresse gehoert dem Router');
  handle.destroy();

  const deep = makePage({ path: '/health/5' });
  const h2 = deep.mount({ address, preselect: true });
  assert.equal(h2.selectedId(), '5', 'der Pfad ist der Deep-Link');
  assert.deepEqual(historyLog, [], 'und schreibt beim Aufbau nichts');
  h2.destroy();
});

// ── Schwelle: wer bekommt Liste + Detail (L1) ────────────────────────────

test('Schwelle: ein 1280er-Laptop bekommt Liste + Detail, auch mit klassischer Bildlaufleiste', () => {
  // Die Abfrage misst die Modulflaeche = Fenster minus Seitenleiste. Bei 1280
  // sind das 1060px; eine klassische Bildlaufleiste an #main-content (Windows,
  // Inventar scrollt dort) nimmt bis 17px. Bis R10 stand die Schwelle bei
  // 75rem (1200px) - 1280 fiel auf den Einspalter mit Modal zurueck, obwohl
  // Liste (420) + Luecke (24) + Detail (>= 560) hineinpassen (A3 P2-2).
  const tokens = readFileSync(new URL('../public/styles/tokens.css', import.meta.url), 'utf8');
  const px = (name, unit) => {
    const m = tokens.match(new RegExp(`${name}:\\s*([0-9.]+)${unit}`));
    assert.ok(m, `tokens.css: ${name} fehlt`);
    return Number(m[1]) * (unit === 'rem' ? 16 : 1);
  };
  const threshold = px('--layout-split-threshold', 'rem');
  const sidebar = px('--sidebar-width-expanded', 'px');
  const surface1280 = 1280 - sidebar - 17;
  assert.ok(threshold <= surface1280,
    `Schwelle ${threshold}px > Modulflaeche ${surface1280}px bei 1280 - der Laptop bekommt kein Liste + Detail`);
  // Und nach unten begrenzt: Liste + Luecke + ein lesbares Detail muessen passen.
  const listMin = px('--layout-list-min', 'rem');
  assert.ok(threshold - listMin - 24 - 2 * 32 >= 480,
    `Schwelle ${threshold}px laesst dem Detail unter 480px - zu schmal zum Lesen`);
});

test('Detailfuss: klebt unten in der Spalte, einreihig, und steht bei kurzem Inhalt an der Unterkante (L6)', () => {
  // A3 P2-1: bei 1440x900 stand „Erledigen" einer einfachen Aufgabe unter der
  // Falz, weil der Fuss mit dem Inhalt scrollte. Regel wie am Blattrand: Kopf
  // oben, Fuss unten, dazwischen scrollt das Detail.
  const layout = readFileSync(new URL('../public/styles/layout.css', import.meta.url), 'utf8');
  const dv = readFileSync(new URL('../public/styles/detail-view.css', import.meta.url), 'utf8');
  const body = (css, sel) => [...eachRule(css)].filter((r) => !r.at.length && r.selector.trim() === sel).map((r) => r.body).join(';');
  const foot = body(layout, '.split-view__detail-footer');
  assert.match(foot, /position:\s*sticky/, 'der Fuss klebt');
  assert.match(foot, /bottom:\s*var\(--nav-tail\)/, 'unten (ueber einer Kapsel, falls je eine steht)');
  assert.match(foot, /flex-wrap:\s*nowrap/, 'einreihig');
  assert.match(foot, /margin-block-start:\s*auto/, 'kurzer Inhalt: Fuss an der Unterkante');
  assert.match(foot, /background-color:\s*var\(--color-surface\)/, 'deckt den Inhalt, der darunter scrollt');
  assert.match(body(layout, '.split-view__detail-body'), /flex:\s*1 0 auto/, 'der Koerper fuellt die Spalte');
  assert.match(body(dv, '.detail-view--in-pane'), /flex:\s*1 0 auto/, 'die Ansicht fuellt den Koerper');
  // Und die Leseansicht haengt genau diese Klasse an ihren Fuss in der Spalte.
  const js = readFileSync(new URL('../public/components/detail-view.js', import.meta.url), 'utf8');
  assert.match(js, /footer\.className = 'detail-view__footer split-view__detail-footer'/);

  // EINE Reihe auch in der schmalen Spalte (1280: 552px, Aufgaben mit fuenf
  // Aktionen - gemessen 622px Inhalt): leise Knoepfe mit Icon zeigen dort nur
  // das Icon. Lucide ersetzt das <i> durch ein <svg> - der Selektor muss beide
  // kennen, sonst greift er im Browser nie (erste Fassung: nur `> i`).
  assert.match(body(layout, '.split-view__detail'), /container:\s*detail-pane\s*\/\s*inline-size/);
  const narrow = [...eachRule(layout)].filter((r) => /@container\s+detail-pane\s*\(max-width:/.test(r.at.join(' ')));
  const hide = narrow.find((r) => /\.btn--ghost:has\(> svg, > i\) > \.btn__label/.test(r.selector));
  assert.ok(hide && /clip:\s*rect\(0, 0, 0, 0\)/.test(hide.body), 'die Beschriftung tritt geclippt zurueck (bleibt zugaenglich)');
  assert.match(js, /label\.className = 'btn__label'/, 'die Beschriftung steht in einem eigenen Knoten');
  assert.match(js, /if \(action\.icon\) btn\.title = action\.label;/, 'als Tooltip bleibt sie lesbar');
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

test('A6 P1-1: kein Inhalt mit z-index malt ueber den klebenden Detailkopf - in jeder Split-Spalte', () => {
  // Gemessen in der Gesundheit bei 1440x900: `elementFromPoint` im Kopfband
  // lieferte `.metric-card__value` bzw. `.cycle-cal__num` - beide
  // `position: relative; z-index: 1` wie der Kopf, und spaeter im DOM.
  const layout = readFileSync(new URL('../public/styles/layout.css', import.meta.url), 'utf8');
  const rules = [...eachRule(layout)].filter((r) => !r.at.length);
  const head = rules.filter((r) => r.selector.trim() === '.split-view__detail-head').map((r) => r.body).join(';');
  assert.match(head, /position:\s*sticky/, 'der Kopf klebt');
  const z = Number(head.match(/z-index:\s*(-?\d+)/)?.[1]);
  assert.ok(z > 0, 'der Kopf steht ueber Ebene 0');
  // JEDES Geschwister nach dem Kopf, nicht eine Modulklasse: die Gesundheit
  // setzt ihre Panels, die Rezepte ihr Detail, die Leseansicht Koerper und
  // Fuss dahinter - eine Aufzaehlung vergaesse die naechste Spalte.
  const iso = rules.filter((r) => r.selector.split(',').some((s) => /^\.split-view__detail-head\s*~\s*\*$/.test(s.trim())));
  assert.ok(iso.some((r) => /isolation:\s*isolate/.test(r.body)),
    'der Inhalt hinter dem Kopf ist keine eigene Stapelung - ein z-index darin schlaegt den Kopf');
  // Und niemand nimmt sie einem Geschwister wieder weg.
  const undo = [...eachRule(layout)].filter((r) => /isolation:\s*auto/.test(r.body));
  assert.deepEqual(undo.map((r) => r.selector), [], 'isolation: auto hebt die Ebene wieder auf');
});
