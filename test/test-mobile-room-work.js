/**
 * Test: Mobil gehoert der Platz dem Inhalt - Aufgaben, Kalender, Notizen (R9)
 *
 * Zweck: Die Re-Critique 2026-09-27 (P1 #3) mass auf 390x844, dass die
 *        Arbeitsmodule ihren Platz an Bedienung statt an Inhalt gaben. Diese
 *        Suite haelt die Umbauten fest, die das zurueckgeben:
 *          - M1 Aufgabenzeile: der Titel spannt mobil ueber beide Spalten, die
 *            Personenwahl verlaesst die Zeile, die Metazeile endet mit Ellipse;
 *          - M2 Kanban: mobil eine Spalte je Seite mit Scroll-Snap, Punkte
 *            zeigen die Spalte und fuehren per Tipp dorthin;
 *          - M5 Kalender: die Ansichtswahl steht mobil im Werkzeugmenue
 *            (`menuitemradio`), Termintitel der Woche brechen nach Blockhoehe um;
 *          - M13 Notizen: die Karte oeffnet selbst, der Titel ist nicht
 *            kleiner als der Text, mobil passt mehr als eine Notiz auf den
 *            Schirm.
 *        CSS wird ueber `eachRule()` gelesen (der Regelscanner kennt den
 *        @media-Kontext), Markup an den echten Renderern gemessen.
 *
 * Ausfuehren: node --loader ./test/test-browser-loader.mjs --test test/test-mobile-room-work.js
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { eachRule } from './css-rules.js';

globalThis.HTMLElement = globalThis.HTMLElement ?? class {};
globalThis.customElements = globalThis.customElements ?? { define() {}, get() {} };
const store = new Map();
globalThis.localStorage = {
  getItem: (k) => (store.has(k) ? store.get(k) : null),
  setItem: (k, v) => { store.set(k, String(v)); },
  removeItem: (k) => { store.delete(k); },
  clear: () => store.clear(),
};
globalThis.document = globalThis.document ?? {
  documentElement: { classList: { toggle() {}, add() {}, remove() {}, contains() { return false; } } },
};

const { __test: tasks } = await import('../public/pages/tasks.js');

const css = (file) => readFileSync(new URL(`../public/styles/${file}`, import.meta.url), 'utf8');
const tasksCss = css('tasks.css');

/** Alle Deklarationen eines Selektors, getrennt nach Kontext. */
function declarations(source, selector, { media = null } = {}) {
  const out = {};
  for (const rule of eachRule(source)) {
    const parts = rule.selector.split(',').map((p) => p.trim().replace(/\s+/g, ' '));
    if (!parts.includes(selector)) continue;
    const inMedia = rule.at.some((a) => a.startsWith('@media'));
    if (media === null ? inMedia : !rule.at.some((a) => a.includes(media))) continue;
    for (const m of rule.body.matchAll(/([\w-]+)\s*:\s*([^;]+)/g)) out[m[1]] = m[2].trim();
  }
  return out;
}

const MOBILE = 'max-width: 639px';

// --------------------------------------------------------------------------
// M1 Aufgabenzeile
// --------------------------------------------------------------------------

test('M1: mobil spannt der Aufgabentitel ueber Text- und Personenspalte', () => {
  const row = declarations(tasksCss, '.task-card__main', { media: MOBILE });
  assert.equal(row.display, 'grid', 'die Zeile wird mobil ein Raster, damit der Titel ueber den Stapel reicht');
  assert.equal(declarations(tasksCss, '.task-card__main > .task-card__body', { media: MOBILE }).display, 'contents',
    'Titel und Metazeile werden selbst Rasterzellen');
  assert.equal(declarations(tasksCss, '.task-card__main .task-card__title', { media: MOBILE })['grid-column'], '2 / -1',
    'der Titel reicht bis ans Zeilenende - Ziel >= 280 von 358px (gemessen 282)');
  assert.equal(declarations(tasksCss, '.task-card__main > .avatar-stack', { media: MOBILE })['grid-row'], '2',
    'der Personenstapel steht in der Metazeile, nicht neben dem Titel');
});

test('M1: mobil nimmt die Personenwahl der Zeile keine Breite, bleibt aber Anker ihres Menues', () => {
  const doer = declarations(tasksCss, '.task-card__main > .task-doer-btn', { media: MOBILE });
  assert.equal(doer.position, 'absolute', 'aus dem Fluss - der Titel bekommt ihre 44px');
  assert.equal(doer.visibility, 'hidden', 'unsichtbar und aus der Tab-Folge; der Tastaturweg ist das Detail');
  assert.notEqual(doer.display, 'none',
    'nicht display:none - das Menue richtet sich am Ausloeser aus und ginge sonst an der Fensterecke auf');
});

test('M1: der Statuskreis wird mobil schmaler, trifft aber weiter voll', () => {
  const btn = declarations(tasksCss, '.task-card__main > .task-status-btn', { media: MOBILE });
  assert.match(btn.width ?? '', /var\(--space-5\)/, 'die Box schrumpft auf Ring plus Luft');
  const hit = declarations(tasksCss, '.task-card__main > .task-status-btn::before', { media: MOBILE });
  assert.match(hit['inset-inline-start'] ?? '', /var\(--target-base\)/,
    'die Trefflaeche bleibt --target-base und steht zentriert ueber dem Ring');
});

test('M1: die Metazeile endet mit Ellipse statt mit einem Schnitt', () => {
  const card = tasks.renderTaskCard({
    id: 3, title: 'Zahnarzt', status: 'open', priority: 'high', visibility: 'all',
    due_date: '2026-09-01', subtasks: [], assigned_users: [],
  });
  assert.match(card, /<span class="due-date__label">/, 'das Faelligkeitslabel hat einen eigenen Traeger');
  const label = declarations(tasksCss, '.due-date__label');
  assert.equal(label['text-overflow'], 'ellipsis');
  assert.equal(label['white-space'], 'nowrap');
  const due = declarations(tasksCss, '.task-card__meta > .due-date');
  assert.equal(due['min-width'], '0', 'ohne min-width 0 schrumpft der Flex-Chip nie und die Zeile klippt');
});

// --------------------------------------------------------------------------
// M2 Kanban mobil
// --------------------------------------------------------------------------

test('M2: mobil blaettert das Brett spaltenweise mit Scroll-Snap', () => {
  const board = declarations(tasksCss, '.kanban-board', { media: MOBILE });
  assert.equal(board['grid-auto-flow'], 'column', 'die Spalten stehen nebeneinander, nicht untereinander');
  assert.equal(board['grid-auto-columns'], '100%', 'eine Spalte je Seite');
  assert.equal(board['scroll-snap-type'], 'x mandatory');
  assert.equal(board['overflow-x'], 'auto');
  assert.equal(declarations(tasksCss, '.kanban-col', { media: MOBILE })['scroll-snap-align'], 'start');
  assert.equal(declarations(tasksCss, '.kanban-pager').display, 'none', 'ab 640px keine Punkte');
  assert.equal(declarations(tasksCss, '.kanban-pager', { media: MOBILE }).display, 'flex');
});

test('M2: die Karte ist mobil so flach wie eine Zeile - Avatar und Status in derselben Zeile', () => {
  assert.equal(declarations(tasksCss, '.kanban-card', { media: MOBILE }).display, 'grid');
  assert.equal(declarations(tasksCss, '.kanban-card__footer', { media: MOBILE }).display, 'contents',
    'die Fusszeile loest sich auf - Avatar und Knopf werden Rasterzellen neben dem Titel');
  assert.equal(declarations(tasksCss, '.kanban-card__status-btn', { media: MOBILE })['grid-row'], '1 / span 2');
});

test('M2: je Spalte ein Punkt, benannt nach der Spalte, der erste ist aktuell', () => {
  const cols = tasks.KANBAN_COLS();
  const html = tasks.kanbanPagerHtml(cols);
  const dots = [...html.matchAll(/data-kanban-page="([\w_]+)"\s+aria-label="([^"]*)"(\s+aria-current="true")?/g)];
  assert.deepEqual(dots.map((m) => m[1]), cols.map((c) => c.status), 'ein Punkt je Spalte, in Brettreihenfolge');
  assert.deepEqual(dots.map((m) => m[2]), cols.map((c) => c.label), 'jeder Punkt nennt seine Spalte');
  assert.deepEqual(dots.map((m) => Boolean(m[3])), cols.map((_, i) => i === 0), 'genau einer ist aktuell');
});

test('M2: ein Tipp auf einen Punkt blaettert zu dessen Spalte und markiert ihn', () => {
  const cols = tasks.KANBAN_COLS();
  const listeners = {};
  const left = { open: 16, in_progress: 386, done: 756, archived: 1126 };
  const scrolled = [];
  const dots = cols.map((c) => {
    const attrs = {};
    return {
      dataset: { kanbanPage: c.status },
      setAttribute(k, v) { attrs[k] = v; }, removeAttribute(k) { delete attrs[k]; }, attrs,
      closest() { return this; },
    };
  });
  const colEls = Object.fromEntries(cols.map((c) => [c.status, {
    dataset: { status: c.status }, getBoundingClientRect: () => ({ left: left[c.status] }),
  }]));
  const board = {
    scrollWidth: 1468, clientWidth: 358,
    getBoundingClientRect: () => ({ left: 16 }),
    querySelector: (sel) => colEls[/data-status="([\w_]+)"/.exec(sel)?.[1]] ?? null,
    querySelectorAll: () => Object.values(colEls),
    scrollBy: (opts) => scrolled.push(opts),
    addEventListener() {},
  };
  const pager = {
    addEventListener: (type, fn) => { listeners[type] = fn; },
    querySelectorAll: () => dots,
  };
  const container = { querySelector: (sel) => (sel === '.kanban-board' ? board : sel === '.kanban-pager' ? pager : null) };
  const vorher = globalThis.window;
  globalThis.window = { ...(vorher ?? {}), matchMedia: () => ({ matches: true }) };
  try {
    tasks.wireKanbanPager(container);
    const done = dots[cols.findIndex((c) => c.status === 'done')];
    listeners.click({ target: done });
    assert.deepEqual(scrolled.at(-1), { left: 740, behavior: 'auto' },
      'um genau den Abstand der Spalte zum Traeger - ohne Animation bei reduzierter Bewegung');
    assert.equal(done.attrs['aria-current'], 'true', 'der getippte Punkt ist jetzt der aktuelle');
    assert.equal(dots[0].attrs['aria-current'], undefined, 'und nur er');
  } finally {
    globalThis.window = vorher;
  }
});
