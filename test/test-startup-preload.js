/**
 * Modul: Die Startkette (Critique R19, optimize)
 * Zweck: Was index.html vor dem ersten Bild anfordert, ist gemessen und bleibt so.
 * Ausfuehren: node --test test/test-startup-preload.js
 *
 * 1. MODULEPRELOAD IST DER GRAPH, NICHT EINE SCHAETZUNG. Ohne die Liste fand der
 *    Browser die Module Ebene fuer Ebene (sieben Rundreisen bis zur Uebersicht,
 *    gemessen am Telefon mit 4x CPU und Fast 4G). Die Liste muss genau der
 *    statische Importgraph der Modulskripte aus index.html plus der der
 *    Startseite (/pages/dashboard.js) sein: fehlt ein Modul, kommt seine Ebene
 *    zurueck; steht eines zu viel da, laedt jeder Start etwas fuer nichts.
 *    Der Teil der Uebersicht hat niedrige Prioritaet, damit die ersten
 *    API-Abrufe nicht hinter ihm warten, und die Liste steht hinter den
 *    Blaettern und den Startskripten.
 * 2. KOMPONENTEN-BLAETTER STEHEN NICHT IM START. Datumsfeld, Kategorien,
 *    Symbolauswahl, Dokumentanhang und Bildschirmschoner laden ihr Blatt selbst
 *    (utils/component-style.js) und warten darauf; auth.css ist das
 *    Seitenblatt der Zugangsseiten. Geprueft wird, dass der AUFRUFER es tut,
 *    nicht nur, dass die Funktion es kann - und das Verhalten der Funktion an
 *    einem kleinen Dokument.
 * 3. DIE SPRACHE KOMMT MIT DEM START, nicht nach dem Modulgraphen.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { posix } from 'node:path';
import { moduleSpecifiers, withoutHtmlComments, withoutCommentsKeepingLines } from './source-text.js';
import { eachRule } from './css-rules.js';

const PUBLIC = new URL('../public/', import.meta.url);
const read = (rel) => readFileSync(new URL(rel.replace(/^\//, ''), PUBLIC), 'utf8');
const html = withoutHtmlComments(read('index.html'));
const head = html.slice(0, html.indexOf('</head>'));

/** Statischer Importgraph ab `entries`, in Breitensuche; ohne die schon bekannten. */
function closure(entries, known = new Set()) {
  const out = [];
  const queue = [];
  for (const entry of entries) {
    if (known.has(entry)) continue;
    known.add(entry);
    out.push(entry);
    queue.push(entry);
  }
  while (queue.length) {
    const current = queue.shift();
    assert.ok(existsSync(new URL(current.replace(/^\//, ''), PUBLIC)), `${current} existiert nicht`);
    for (const spec of moduleSpecifiers(read(current)).static) {
      const dep = spec.startsWith('/') ? spec : posix.resolve(posix.dirname(current), spec);
      if (known.has(dep)) continue;
      known.add(dep);
      out.push(dep);
      queue.push(dep);
    }
  }
  return out;
}

const moduleScripts = [...html.matchAll(/<script\b[^>]*\btype="module"[^>]*\bsrc="([^"]+)"/g)].map((m) => m[1]);
const preloads = [...head.matchAll(/<link rel="modulepreload"([^>]*)\bhref="([^"]+)"[^>]*>/g)]
  .map((m) => ({ href: m[2], low: /fetchpriority="low"/.test(m[0]), index: m.index }));

test('modulepreload nennt genau den Startgraphen: Modulskripte aus index.html und die Uebersicht', () => {
  assert.ok(moduleScripts.includes('/router.js') && moduleScripts.includes('/api.js'), 'index.html laedt router.js/api.js nicht mehr als Modul');
  const known = new Set();
  const shell = closure(moduleScripts, known);
  const dashboard = closure(['/pages/dashboard.js'], known);
  const expected = new Set([...shell, ...dashboard]);
  const listed = new Set(preloads.map((p) => p.href));
  const missing = [...expected].filter((href) => !listed.has(href));
  const extra = [...listed].filter((href) => !expected.has(href));
  assert.deepEqual(missing, [], 'diese Module laedt der Start, ohne dass index.html sie vorab nennt - der Browser findet sie erst eine Ebene spaeter');
  assert.deepEqual(extra, [], 'diese Vorab-Ladungen gehoeren nicht zum Start');
  assert.equal(preloads.length, listed.size, 'ein Modul steht doppelt in der Liste');
});

test('der Teil der Uebersicht laedt mit niedriger Prioritaet, hinter dem der Shell', () => {
  const known = new Set();
  const shell = new Set(closure(moduleScripts, known));
  const dashboard = new Set(closure(['/pages/dashboard.js'], known));
  const wrongPriority = preloads.filter((p) => (dashboard.has(p.href) ? !p.low : p.low)).map((p) => p.href);
  assert.deepEqual(wrongPriority, [], 'Shell hoch, Uebersicht niedrig - sonst warten /auth/me und /preferences hinter der Uebersicht');
  const lastShell = Math.max(...preloads.filter((p) => shell.has(p.href)).map((p) => p.index));
  const firstDashboard = Math.min(...preloads.filter((p) => dashboard.has(p.href)).map((p) => p.index));
  assert.ok(lastShell < firstDashboard, 'die Shell steht vor der Uebersicht');
});

test('die Vorab-Ladungen stehen hinter den Blaettern und den Startskripten', () => {
  const firstPreload = Math.min(...preloads.map((p) => p.index));
  const lastSheet = Math.max(...[...head.matchAll(/<link rel="stylesheet"/g)].map((m) => m.index));
  const lastScript = Math.max(...[...head.matchAll(/<script\b/g)].map((m) => m.index));
  assert.ok(firstPreload > lastSheet, 'eine modulepreload-Zeile steht vor einem Stylesheet und draengelt sich davor');
  assert.ok(firstPreload > lastScript, 'eine modulepreload-Zeile steht vor einem Startskript - theme-init/lang-init blockieren den Parser');
});

test('die defer-Skripte im Kopf laden mit hoher Prioritaet - die Modulskripte warten auf sie', () => {
  const deferred = [...head.matchAll(/<script\b[^>]*\bdefer\b[^>]*>/g)].map((m) => m[0]);
  assert.ok(deferred.length >= 2, 'lucide.min.js und lucide-scope.js nicht mehr als defer im Kopf');
  for (const tag of deferred) assert.match(tag, /fetchpriority="high"/, `${tag}: ohne hohe Prioritaet laedt es hinter allen modulepreloads`);
});

// --------------------------------------------------------
// 2. Komponenten-Blaetter
// --------------------------------------------------------

const LAZY = {
  datepicker: ['/components/datepicker.js'],
  'category-manager': ['/components/category-manager.js', '/components/tag-manager.js'],
  'icon-picker': ['/components/icon-picker.js'],
  'document-attach': ['/components/document-attach.js'],
  screensaver: ['/components/photo-screensaver.js'],
};

test('die Blaetter geteilter Komponenten stehen nicht im Start, ihr Platz schon', () => {
  const linked = [...head.matchAll(/<link rel="stylesheet" href="\/styles\/([\w-]+)\.css"/g)].map((m) => m[1]);
  for (const name of [...Object.keys(LAZY), 'auth']) assert.ok(!linked.includes(name), `${name}.css steht wieder in index.html`);
  const slot = head.match(/<meta name="component-styles" content="([^"]*)"/);
  assert.ok(slot, 'der Platzhalter <meta name="component-styles"> fehlt - nachgeladene Blaetter stuenden hinter Seitenblatt und typography.css');
  assert.deepEqual(slot[1].split(/\s+/).sort(), Object.keys(LAZY).sort());
  // Die Kaskade: der Platz liegt, wo die Links standen - vor detail-view und typography.
  assert.ok(slot.index < head.indexOf('/styles/typography.css') && slot.index < head.indexOf('/styles/detail-view.css'));
});

test('jede dieser Komponenten stellt ihr Blatt selbst sicher', () => {
  for (const [name, files] of Object.entries(LAZY)) {
    for (const file of files) {
      const src = withoutHtmlComments(read(file));
      const code = src.replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, '');
      assert.match(code, /from '\/utils\/component-style\.js'/, `${file} importiert component-style.js nicht`);
      assert.ok(code.includes(`/styles/${name}.css`), `${file} nennt /styles/${name}.css nicht`);
      assert.match(code, /\b(ensureStyle|holdUntilStyled)\(/, `${file} wartet nicht auf sein Blatt`);
    }
  }
});

/*
 * NICHT NUR DIE KOMPONENTE RENDERT IHRE KLASSEN. Kalender, Dokumente und
 * Hauswirtschaft bauen die Ablage `.document-dropzone` selbst, der
 * Notizen-Editor den Knopf `.category-scope-help` - die Regeln dafuer stehen im
 * Blatt der Komponente. Der Guard oben sah nur die Komponente; auf /documents
 * stand die Ablage danach ohne Rahmen und Polster da, solange kein
 * Anhangsfeld das Blatt zufaellig vorher geladen hatte (test:calendar fand es
 * am Termin-Dialog). Deshalb: jede Datei, die eine Klasse rendert, die NUR in
 * einem nachgeladenen Blatt eine Regel hat, ruft einen Halter dieses Blatts
 * auf - `ensureStyle`/`holdUntilStyled` mit seinem Pfad oder einen der
 * benannten Halter der Komponente, die ihrerseits `holdUntilStyled` rufen.
 */
const HOLDERS = {
  'document-attach': ['holdDocumentAttachStyle'],
  'category-manager': ['wireCategoryScopeHelp'],
};

test('wer Klassen eines nachgeladenen Blatts rendert, stellt das Blatt sicher', () => {
  // Eigen sind Klassen, die AUSSER im Blatt der Komponente nirgends eine Regel
  // haben - weder in einem Startblatt noch in einem Seitenblatt (`is-today`
  // gestaltet health.css auch fuer seinen eigenen Zykluskalender).
  const others = readdirSync(new URL('styles/', PUBLIC)).filter((f) => f.endsWith('.css') && !(f.slice(0, -4) in LAZY));
  const always = new Set();
  for (const file of others) {
    for (const { selector } of eachRule(read(`styles/${file}`))) {
      for (const m of selector.matchAll(/\.([\w-]+)/g)) always.add(m[1]);
    }
  }
  const sources = [];
  const walk = (dir) => {
    for (const entry of readdirSync(new URL(dir, PUBLIC), { withFileTypes: true })) {
      const rel = `${dir}${entry.name}`;
      if (entry.isDirectory()) { if (!['vendor/', 'locales/'].some((v) => `${rel}/`.endsWith(v))) walk(`${rel}/`); continue; }
      if (/\.js$/.test(entry.name) && !/\.min\.js$/.test(entry.name)) sources.push(`/${rel}`);
    }
  };
  walk('');
  const code = new Map(sources.map((f) => [f, withoutCommentsKeepingLines(read(f))]));

  // Die Halter selbst muessen halten - sonst ist der Name nur ein Versprechen.
  for (const [name, holders] of Object.entries(HOLDERS)) {
    for (const holder of holders) {
      const owner = LAZY[name].map((f) => code.get(f)).find((src) => new RegExp(`export function ${holder}\\b`).test(src));
      assert.ok(owner, `${holder} ist in ${LAZY[name].join('/')} nicht exportiert`);
      const body = owner.slice(owner.search(new RegExp(`export function ${holder}\\b`)));
      const fn = body.slice(0, body.indexOf('\n}') + 2);
      assert.match(fn, /holdUntilStyled\(/, `${holder} haelt sein Element nicht, bis ${name}.css da ist`);
    }
  }

  const missing = [];
  for (const [name, owners] of Object.entries(LAZY)) {
    const own = new Set();
    for (const { selector } of eachRule(read(`styles/${name}.css`))) {
      for (const m of selector.matchAll(/\.([\w-]+)/g)) if (!always.has(m[1])) own.add(m[1]);
    }
    for (const [file, src] of code) {
      if (owners.includes(file) || file === '/utils/component-style.js') continue;
      const used = [...own].filter((cls) => new RegExp(`['"\`\\s.]${cls}(?![\\w-])`).test(src));
      if (!used.length) continue;
      const ensures = src.includes(`/styles/${name}.css`) && /\b(ensureStyle|holdUntilStyled)\(/.test(src);
      const holds = (HOLDERS[name] ?? []).some((h) => new RegExp(`\\b${h}\\(`).test(src));
      if (!ensures && !holds) missing.push(`${file}: ${used.join(', ')} (${name}.css)`);
    }
  }
  assert.deepEqual(missing, [], 'diese Dateien rendern Klassen eines nachgeladenen Blatts, ohne es sicherzustellen - ohne das Blatt fallen sie auf Browser-Vorgaben zurueck');
});

test('auth.css ist das Seitenblatt jeder Zugangsseite', () => {
  const router = read('router.js');
  assert.match(router, /const AUTH_STYLE = '\/styles\/auth\.css';/);
  for (const path of ['/login', '/setup', '/forgot-password', '/reset-password', '/join', '/pair']) {
    const row = router.match(new RegExp(`\\{ path: '${path}',[^}]*\\}`))?.[0] ?? '';
    assert.match(row, /style: AUTH_STYLE/, `${path} laedt auth.css nicht mehr`);
  }
});

test('der Service Worker haelt jedes nachgeladene Blatt offline bereit', () => {
  const sw = read('sw.js');
  for (const name of [...Object.keys(LAZY), 'auth']) assert.ok(sw.includes(`'/styles/${name}.css'`), `${name}.css fehlt im Precache`);
  assert.ok(sw.includes("'/utils/component-style.js'"));
});

// Ein kleines Dokument: genau das, was component-style.js anfasst.
function fakeDocument() {
  const children = [];
  const make = (tag) => {
    const listeners = {};
    const el = {
      tagName: tag.toUpperCase(), rel: '', href: '', sheet: null, dataset: {}, attrs: {}, isConnected: false,
      getAttribute(name) { return name === 'href' ? this.href : this.attrs[name] ?? null; },
      setAttribute(name, value) { this.attrs[name] = value; },
      removeAttribute(name) { delete this.attrs[name]; },
      hasAttribute(name) { return name in this.attrs; },
      addEventListener(type, fn) { (listeners[type] ??= []).push(fn); },
      fire(type) { if (type === 'load') this.sheet = {}; for (const fn of listeners[type] ?? []) fn(); },
      before(node) { children.splice(children.indexOf(this), 0, node); node.isConnected = true; },
      remove() { const at = children.indexOf(this); if (at >= 0) children.splice(at, 1); this.isConnected = false; },
    };
    return el;
  };
  const slot = make('meta');
  slot.attrs.name = 'component-styles';
  slot.isConnected = true;
  const typography = make('link');
  typography.rel = 'stylesheet';
  typography.href = '/styles/typography.css';
  typography.sheet = {};
  children.push(slot, typography);
  const head = {
    querySelector: (sel) => (sel === 'meta[name="component-styles"]' ? slot : null),
    appendChild(node) { children.push(node); node.isConnected = true; },
  };
  return {
    children, head, createElement: make,
    querySelectorAll: (sel) => (sel === 'link[rel="stylesheet"]' ? children.filter((c) => c.tagName === 'LINK' && c.rel === 'stylesheet') : []),
  };
}

test('ensureStyle: einmal je Blatt, vor dem Platzhalter, aufgeloest bei load und bei error', async () => {
  const doc = fakeDocument();
  globalThis.document = doc;
  try {
    const { ensureStyle, holdUntilStyled, isStyleReady } = await import(`../public/utils/component-style.js?t=${Date.now()}`);
    const a = ensureStyle('/styles/datepicker.css');
    const b = ensureStyle('/styles/datepicker.css');
    assert.equal(a, b, 'derselbe Abruf zweimal');
    const links = doc.children.filter((c) => c.href === '/styles/datepicker.css');
    assert.equal(links.length, 1);
    assert.ok(doc.children.indexOf(links[0]) < doc.children.findIndex((c) => c.tagName === 'META'), 'nicht vor dem Platzhalter - die Kaskade kippt');
    assert.equal(isStyleReady('/styles/datepicker.css'), false);

    const field = doc.createElement('yuvomi-datepicker');
    const held = holdUntilStyled(field, '/styles/datepicker.css');
    assert.ok(field.hasAttribute('data-style-pending'), 'das Feld zeigt sich vor seinem Blatt');
    links[0].fire('load');
    await held;
    assert.equal(field.hasAttribute('data-style-pending'), false, 'das Feld bleibt nach dem Laden unsichtbar');
    assert.equal(isStyleReady('/styles/datepicker.css'), true);

    const later = doc.createElement('yuvomi-datepicker');
    holdUntilStyled(later, '/styles/datepicker.css');
    assert.equal(later.hasAttribute('data-style-pending'), false, 'ein Blatt, das schon da ist, haelt nichts auf');

    const broken = ensureStyle('/styles/icon-picker.css');
    doc.children.find((c) => c.href === '/styles/icon-picker.css').fire('error');
    await broken; // ein fehlendes Blatt laesst den Dialog trotzdem auf
  } finally {
    delete globalThis.document;
  }
});

/*
 * Review #2049, Runde 2: ein Ladefehler war endgueltig. `ready` loeste auf,
 * der kaputte Link blieb haengen, und jeder spaetere ensureStyle() bekam das
 * erledigte Versprechen - Datumsfelder, Symbolauswahl und Bildschirmschoner
 * blieben bis zum Neuladen ungestylt, auch nachdem das Netz wieder da war.
 */
test('ensureStyle: nach einem Ladefehler versucht der naechste Aufruf es neu', async () => {
  const doc = fakeDocument();
  globalThis.document = doc;
  try {
    const { ensureStyle, holdUntilStyled, isStyleReady } = await import(`../public/utils/component-style.js?t=${Date.now()}-retry`);
    const href = '/styles/icon-picker.css';
    const field = doc.createElement('yuvomi-icon-picker');
    const held = holdUntilStyled(field, href);
    const first = doc.children.find((c) => c.href === href);
    first.fire('error');
    await held;
    assert.equal(field.hasAttribute('data-style-pending'), false, 'der Halter bleibt nach dem Fehler nicht haengen');
    assert.equal(first.isConnected, false, 'der kaputte Link bleibt im Dokument');
    assert.equal(doc.children.filter((c) => c.href === href).length, 0);

    const again = ensureStyle(href);
    const links = doc.children.filter((c) => c.href === href);
    assert.equal(links.length, 1, 'der zweite Aufruf laedt das Blatt nicht neu');
    assert.notEqual(links[0], first);
    assert.ok(doc.children.indexOf(links[0]) < doc.children.findIndex((c) => c.tagName === 'META'), 'auch der neue Versuch steht vor dem Platzhalter');
    links[0].fire('load');
    await again;
    assert.equal(isStyleReady(href), true);
    assert.equal(ensureStyle(href) instanceof Promise, true);
    assert.equal(doc.children.filter((c) => c.href === href).length, 1, 'nach dem Erfolg bleibt es bei einem Link');
  } finally {
    delete globalThis.document;
  }
});

test('das Haltezeichen hat eine Regel im globalen Blatt', () => {
  const layout = read('styles/layout.css');
  assert.match(layout, /\[data-style-pending\]\s*\{\s*visibility:\s*hidden;\s*\}/);
  assert.ok(head.includes('href="/styles/layout.css"'));
});

// --------------------------------------------------------
// 3. Sprache
// --------------------------------------------------------

test('die Sprachdateien kommen mit dem Start und gleichzeitig', () => {
  assert.match(head, /<link rel="preload" href="\/locales\/de\.json" as="fetch" crossorigin \/>/, 'die Rueckfallsprache wird nicht vorab angefordert');
  const lang = read('lang-init.js');
  assert.match(lang, /hint\.rel = 'preload';[\s\S]*?hint\.as = 'fetch';[\s\S]*?hint\.crossOrigin = 'anonymous';[\s\S]*?'\/locales\/' \+ locale \+ '\.json'/);
  const i18n = read('i18n.js');
  const init = i18n.slice(i18n.indexOf('export async function initI18n'), i18n.indexOf('export function whenI18nReady'));
  assert.ok(init.indexOf('loadLocale(currentLocale)') < init.indexOf('await loadLocale(DEFAULT_LOCALE)'),
    'die eigene Sprache wird erst nach der Rueckfallsprache angefragt - eine Rundreise mehr fuer jede Sprache ausser Deutsch');
});

/*
 * U2 (DW p5b): "+ Neu" legt Termin und Notiz ueber der Uebersicht an. Ihre
 * Formulare tragen Regeln aus calendar.css bzw. notes.css, und der Router
 * laedt nur das Blatt der Seite, die steht. Geliehen wird das Blatt so lange,
 * wie die Uebersicht steht - am Ende von <head> wie im Modul, und mit ihrem
 * Signal wieder weg, sonst laege es fuer den Rest der Sitzung auf jeder Seite.
 */
test('lendPageStyle: am Ende von <head>, einmal je Blatt, geht mit dem Signal der Seite', async () => {
  const doc = fakeDocument();
  globalThis.document = doc;
  try {
    const { lendPageStyle } = await import(`../public/utils/component-style.js?t=${Date.now()}-lend`);
    const page = new AbortController();
    const a = lendPageStyle('/styles/calendar.css', page.signal);
    const b = lendPageStyle('/styles/calendar.css', page.signal);
    assert.equal(a, b, 'zweimal geoeffnet, einmal geladen');
    const links = doc.children.filter((c) => c.href === '/styles/calendar.css');
    assert.equal(links.length, 1);
    assert.equal(doc.children.at(-1), links[0], 'hinter typography.css und dem Seitenblatt - wie auf der Kalenderseite');
    links[0].fire('load');
    await a;
    page.abort();
    assert.equal(links[0].isConnected, false, 'die Uebersicht ist weg, ihr geliehenes Blatt auch');

    // Steht das Blatt schon (die Seite des Moduls selbst), wird nichts geliehen.
    const own = doc.createElement('link');
    own.rel = 'stylesheet';
    own.href = '/styles/notes.css';
    own.sheet = {};
    doc.children.push(own);
    await lendPageStyle('/styles/notes.css', new AbortController().signal);
    assert.equal(doc.children.filter((c) => c.href === '/styles/notes.css').length, 1);

    // Ein gescheitertes Blatt (Netz kurz weg) geht wieder raus, wie bei
    // ensureStyle: sonst haelt der tote Link jedes weitere Oeffnen auf dem
    // alten Versprechen fest, und das Formular bleibt bis zum Seitenwechsel
    // ohne seine Regeln (Codex-Review #2344).
    const stay = new AbortController();
    const failed = lendPageStyle('/styles/calendar.css', stay.signal);
    const broken = doc.children.find((c) => c.href === '/styles/calendar.css');
    broken.fire('error');
    await failed;
    assert.equal(broken.isConnected, false, 'der kaputte Link bleibt im Dokument');
    const retry = lendPageStyle('/styles/calendar.css', stay.signal);
    assert.notEqual(retry, failed, 'das naechste Oeffnen bekommt das alte, schon aufgeloeste Versprechen');
    const fresh = doc.children.filter((c) => c.href === '/styles/calendar.css');
    assert.equal(fresh.length, 1, 'genau ein neuer Versuch');
    assert.notEqual(fresh[0], broken);
    fresh[0].fire('load');
    await retry;
  } finally {
    delete globalThis.document;
  }
});

test('lendPageStyle: Termin und Notiz leihen ihr Seitenblatt, bevor ihr Formular ueber einer fremden Seite aufgeht', () => {
  for (const [file, fn, href] of [['pages/calendar.js', 'openNewEvent', '/styles/calendar.css'], ['pages/notes.js', 'openNewNote', '/styles/notes.css']]) {
    const src = read(file);
    const at = src.indexOf(`export async function ${fn}(`);
    assert.ok(at >= 0, `${file} exportiert ${fn} nicht`);
    const body = src.slice(at, src.indexOf('\n}\n', at));
    assert.ok(body.includes(`lendPageStyle('${href}', signal)`), `${fn} leiht ${href} nicht - das Formular stuende ueber der Uebersicht ohne seine Regeln`);
  }
});
