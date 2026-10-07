/**
 * Test: Kontakte in Liste + Detail (Breitenregel, DESIGN.md)
 * Zweck: Die Kontakte haengen den geteilten Baustein utils/master-detail.js ein.
 *        Der Baustein findet seine Zeilen NUR ueber `data-md-id` und fokussiert
 *        bei Pfeiltasten das Element mit `data-md-focus` - fehlt eines, steht
 *        die Detailspalte, aber keine Zeile ist waehlbar. Die Spalte zeigt
 *        ueber den Zeilen eine Karte mit Schnellaktionen (A5 P1-1), die nur
 *        anbietet, was der Kontakt hat, und Kontaktdaten nur als Text setzt;
 *        unter der Schwelle bleibt die Leseansicht, wie sie war. Die Suche im
 *        Kopf ist ab der Schwelle auf die Breite der Listenzeilen gedeckelt -
 *        ihre Container-Abfrage muss dieselbe Schwelle nennen wie layout.css.
 *        Geprueft wird das Verhalten der echten Funktionen, wo es eines gibt.
 * Ausfuehren: node --loader ./test/test-browser-loader.mjs --test test/test-contacts-list-detail.js
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { eachRule } from './css-rules.js';

// Die Seite zieht Web Components mit, die zur Ladezeit von HTMLElement
// ableiten (Muster aus test-module-readonly-ui.js).
globalThis.HTMLElement = globalThis.HTMLElement ?? class {};
globalThis.customElements = globalThis.customElements ?? { define() {}, get() {} };

const { installMiniDom } = await import('./mini-dom.js');
installMiniDom();

const { __test: contacts } = await import('../public/pages/contacts.js');

const read = (rel) => readFileSync(new URL(rel, import.meta.url), 'utf8');

const KONTAKT = {
  id: 42, name: 'Dr. Anna Weber', category: 'doctor', phone: '+49 231 4452210',
  email: 'praxis@example.org', address: 'Buergerstrasse 12, Dortmund',
  organization: 'Praxis am Markt', job_title: 'Allgemeinmedizin', family_user_id: null,
};

contacts.state.categories = [{ key: 'doctor', icon: 'stethoscope', name: 'Arzt' }];

test('jede Kontaktzeile ist fuer den Baustein waehlbar (data-md-id) und fokussierbar (data-md-focus)', () => {
  contacts.state.selectMode = false;
  const html = contacts.renderContactItem(KONTAKT);
  const row = html.match(/<div class="list-row[^"]*contact-item"[^>]*>/)?.[0];
  assert.ok(row, 'Zeile nicht gefunden - der Test liest das Markup nicht mehr');
  assert.match(row, /data-md-id="42"/, 'die Zeile traegt ihre ID fuer utils/master-detail.js');
  const main = html.match(/<button[^>]*class="contact-item__open[^>]*>/)?.[0];
  assert.ok(main, 'Hauptknopf nicht gefunden');
  assert.match(main, /\bdata-md-focus\b/, 'der Hauptknopf ist das Fokusziel der Pfeiltasten');
  assert.match(main, /data-open="42"/, 'der Klick-Weg der Zeile bleibt data-open');
});

test('im Auswahlmodus bleibt die Zeile bekannt, aber die Pfeiltasten gehoeren der Checkbox', () => {
  // Ohne `data-md-id` raeumte refresh() die Auswahl ab, sobald jemand den
  // Auswahlmodus betritt - der Kontakt rechts verschwaende ohne Grund.
  contacts.state.selectMode = true;
  try {
    const html = contacts.renderContactItem(KONTAKT);
    assert.match(html, /data-md-id="42"/);
    assert.doesNotMatch(html, /data-md-focus/, 'kein Fokusziel: die Pfeile bewegen hier keine Auswahl');
  } finally {
    contacts.state.selectMode = false;
  }
});

test('die Karte der Spalte bietet nur an, was der Kontakt hat, und setzt Daten als Text', () => {
  const card = contacts.contactCardEl(KONTAKT);
  const sub = card.childNodes.find((n) => n.className === 'contact-card__sub');
  assert.equal(sub?.textContent, 'Praxis am Markt · Allgemeinmedizin', 'Organisation und Position unter dem Bild');
  const bar = card.childNodes.find((n) => n.className === 'contact-card__actions');
  const hrefs = bar.childNodes.map((a) => a.href);
  assert.deepEqual(hrefs.map((h) => h.split(':')[0]), ['tel', 'mailto', 'https'],
    'Anrufen, E-Mail, Karte - in dieser Reihenfolge');
  assert.equal(bar.childNodes[0].dataset.phoneRaw, KONTAKT.phone,
    'der tel:-Link bekommt die E.164-Aufbereitung der Liste (enhancePhones)');
  // Organisation kommt ungeprueft aus CardDAV: als Text, nie als Markup.
  const boese = contacts.contactCardEl({ ...KONTAKT, organization: '<img src=x onerror=alert(1)>' });
  assert.match(boese.outerHTML, /&lt;img src=x/, 'die Organisation steht als Text in der Karte');
  assert.doesNotMatch(boese.outerHTML, /<img src=x/, 'kein Markup-Pfad fuer Kontaktdaten');

  const nackt = contacts.contactCardEl({ id: 7, name: 'Leer', category: 'doctor' });
  assert.equal(nackt.childNodes.find((n) => n.className === 'contact-card__actions'), undefined,
    'ohne Nummer, Mail und Adresse gibt es keine Aktionsreihe - keinen Knopf ins Leere');
  assert.equal(nackt.childNodes.find((n) => n.className === 'contact-card__sub'), undefined,
    'ohne Organisation keine Unterzeile (die Kategorie steht als Zeile darunter)');
});

test('die Organisation steht einmal - in der Karte, in Spalte und Blatt (R9 M12)', () => {
  // Bis R9 bekam nur die Spalte die Karte, das Blatt fuehrte die Organisation
  // deshalb als Zeile. Seit die Karte auch im mobilen Blatt steht, waere die
  // Zeile in beiden Wegen dieselbe Angabe ein zweites Mal.
  const org = (sections) => sections.find((s) => s.icon === 'building-2');
  assert.equal(org(contacts.renderContactDetail(KONTAKT)).hidden, true,
    'die Karte traegt sie - zweimal dieselbe Zeile waere Rauschen');
});

test('das mobile Blatt bekommt dieselbe Karte mit Schnellaktionen wie die Spalte (R9 M12)', () => {
  // Gemessen vorher im Blatt `hasTiles: false`: Anrufen hiess, die Nummer in
  // den Zeilen zu suchen - genau das, wofuer die Karte da ist.
  const vorn = [];
  const pane = { prepend: (node) => vorn.push(node) };
  const overlay = {
    querySelector: (sel) => (sel === '.modal-panel__body > .detail-view__pane' ? pane : null),
  };
  const root = { getElementById: (id) => (id === 'shared-modal-overlay' ? overlay : null) };
  const card = contacts.mountContactCard(KONTAKT, null, root);
  assert.ok(card, 'ohne Spalte haengt die Karte im Blatt');
  assert.equal(vorn[0], card, 'zuoberst in den Zeilen - dort blendet das Formular sie mit aus');
  assert.match(card.className, /\bcontact-card\b/);
  assert.match(card.className, /\bcontact-card--sheet\b/, 'mit der Blatt-Variante (kein eigener Luftraum ueber dem Kopf)');
  const bar = card.childNodes.find((n) => n.className === 'contact-card__actions');
  assert.equal(bar?.childNodes.length, 3, 'Anrufen, E-Mail und Karte auch im Blatt');

  assert.equal(contacts.mountContactCard(KONTAKT, null, { getElementById: () => null }), null,
    'ohne offenes Blatt haengt sie nirgends');
});

test('die Seite haengt Liste + Detail ein: Klick ueber den Baustein, Signal des Routers, Leerzustand', () => {
  const src = read('../public/pages/contacts.js');
  assert.match(src, /app-page--list-detail/, 'die Wurzel ist der Container der Schwelle');
  assert.match(src, /class="split-view contacts-split">\s*<div id="contacts-list" class="[^"]*\bsplit-view__list\b/,
    'der bisherige Scrollport ist die linke Spalte');
  assert.match(src, /splitViewDetailHtml\(\{[\s\S]*?label: t\('contacts\.detailPaneLabel'\)[\s\S]*?t\('contacts\.pickOne'\)/,
    'die Spalte hat einen Namen und einen Leerzustand');
  assert.match(src, /mountMasterDetail\(\{[\s\S]*?signal,/, 'der Baustein baut mit der Seite ab');
  assert.match(src, /if \(md\) md\.open\(open\.dataset\.open, open\)/,
    'der Zeilen-Klick geht ueber den Baustein: in der Spalte auswaehlen, darunter oeffnen');
  // Jeder Neuaufbau der Liste meldet sich beim Baustein - sonst stuende rechts
  // ein geloeschter oder weggefilterter Kontakt.
  // Gezeichnet wird in drawList(); renderList() entscheidet nur, ob mit
  // Listenbewegung (utils/list-motion.js) oder ohne.
  assert.match(src, /function renderList\([^)]*\) \{[\s\S]{0,500}?redrawList\(container, \(\) => drawList\(container, \{ animate \}\),[\s\S]{0,120}?else drawList\(container, \{ animate \}\);\n\}/,
    'renderList zeichnet auf beiden Wegen ueber drawList');
  const renderList = src.slice(src.indexOf('function drawList('));
  const body = renderList.slice(0, renderList.indexOf('\n}\n'));
  assert.equal((body.match(/md\?\.refresh\(\)/g) ?? []).length, 2,
    'beide Ausgaenge von renderList (leer und gefuellt) melden sich beim Baustein');
});

test('Deep-Link ?open= (globale Suche): EIN Leser, der Baustein, in beiden Regimen', () => {
  const src = read('../public/pages/contacts.js');
  const mount = src.slice(src.indexOf('mountMasterDetail({'));
  const opts = mount.slice(0, mount.indexOf('\n    });'));
  // Kein eigener Parameter: `open` ist der Standard des Bausteins und die
  // Adresse, die die globale Suche setzt. Ein `param: 'id'` hiesse zwei
  // Adressen fuer denselben Kontakt.
  assert.doesNotMatch(opts, /\bparam:/, 'Kontakte nutzen den Standard-Parameter des Bausteins (open)');
  // Unter der Schwelle oeffnet der Link die Leseansicht wie auf main.
  assert.match(opts, /deepLinkNarrow:\s*true/, 'unter der Schwelle loest der Baustein den Link ein (Leseansicht)');
  // Kein zweiter Leser neben dem Baustein, der `?open=` umschreibt oder ein
  // Modal zusaetzlich zur Spalte oeffnet.
  assert.doesNotMatch(src, /searchParams\)?\.get\('open'\)|search\)\.get\('open'\)/,
    'contacts.js liest ?open= nicht selbst');
});

test('Deep-Link gegen gemerkten Filter: ein benanntes Ziel schlaegt Suche und Kategorie, vor dem Suchfeld', () => {
  // `state` ueberlebt den Seitenwechsel. Kommt die globale Suche mit
  // `?open=42`, waehrend noch "Weber" gesucht oder eine andere Kategorie
  // gewaehlt ist, stuende links eine Liste ohne den Kontakt und rechts sein
  // Detail ohne Zeile - bis der naechste Listenaufbau beides abraeumt.
  const saved = globalThis.location;
  try {
    contacts.state.searchQuery = 'Weber';
    contacts.state.activeCategory = 'family';
    globalThis.location = { search: '?open=42' };
    contacts.dropFiltersForDeepLink();
    assert.equal(contacts.state.searchQuery, '', 'die alte Suche faellt weg');
    assert.equal(contacts.state.activeCategory, null, 'die alte Kategorie faellt weg');

    contacts.state.searchQuery = 'Weber';
    contacts.state.activeCategory = 'family';
    globalThis.location = { search: '' };
    contacts.dropFiltersForDeepLink();
    assert.equal(contacts.state.searchQuery, 'Weber', 'ohne Ziel bleibt der Filter, den man sich gemerkt hat');
    assert.equal(contacts.state.activeCategory, 'family');
  } finally {
    globalThis.location = saved;
    contacts.state.searchQuery = '';
    contacts.state.activeCategory = null;
  }
  // Der Aufrufer: vor dem Bau des Suchfelds, das `state.searchQuery` als Wert
  // uebernimmt - sonst zeigte das Feld einen Begriff, nach dem nicht gefiltert wird.
  const src = read('../public/pages/contacts.js');
  const render = src.slice(src.indexOf('export async function render('));
  const call = render.indexOf('dropFiltersForDeepLink();');
  assert.ok(call > 0, 'render() setzt den Filter bei einem Deep-Link zurueck');
  assert.ok(call < render.indexOf('renderPageSearch('), 'und zwar vor dem Suchfeld');
});

/*
 * DIE SUCHE LAEUFT NICHT QUER UEBER DAS DETAIL - seit der Re-Critique
 * 2026-09-27 (D4) haelt das die EINE Kopfbreite der Shell (page-search.css,
 * `--page-search-width`), nicht mehr eine Kappung der Kontakte. Geprueft wird
 * die Regel dahinter: die Kopfsuche ist hoechstens so breit wie die
 * schmalste Listenbahn (`--layout-list-min` minus zweimal das Seitenpolster
 * von 32px), und die Kontakte geben ihr keine eigene Breite mehr.
 */
test('die Suche bleibt in der Listenbahn: Shell-Breite <= schmalste Bahn, keine Modulbreite', () => {
  const tokens = read('../public/styles/tokens.css');
  const threshold = Number(tokens.match(/--layout-split-threshold:\s*([0-9.]+)rem/)?.[1]);
  assert.ok(threshold > 0, 'tokens.css: --layout-split-threshold fehlt');
  const listMinRem = Number(tokens.match(/--layout-list-min:\s*([0-9.]+)rem/)?.[1]);
  assert.ok(listMinRem > 0, 'tokens.css: --layout-list-min fehlt');
  const search = Number(read('../public/styles/page-search.css').match(/--page-search-width:\s*([0-9.]+)px/)?.[1]);
  assert.ok(search > 0, 'page-search.css: --page-search-width fehlt');
  assert.ok(search <= listMinRem * 16 - 2 * 32,
    `Kopfsuche ${search}px ist breiter als die schmalste Listenbahn (${listMinRem * 16 - 64}px) - sie liefe ueber das Detail`);

  for (const { selector, body, at } of eachRule(read('../public/styles/contacts.css'))) {
    const chain = at.join(' ');
    if (/@container\s+module-surface/.test(chain)) {
      const width = Number(chain.match(/min-width:\s*([0-9.]+)rem/)?.[1]);
      assert.equal(width, threshold,
        `contacts.css: @container module-surface ${width}rem, tokens.css ${threshold}rem - @container kann keine Variable lesen`);
    }
    if (/\.contacts-toolbar__search(?![\w-])/.test(selector)) {
      assert.doesNotMatch(body, /(?:^|[;\s])(?:max-)?(?:width|inline-size|flex(?:-basis)?)\s*:/,
        `contacts.css: ${selector.trim()} gibt der Kopfsuche wieder eine eigene Breite`);
    }
  }
});

test('in die Spalte befoerdert: das offene Blatt DIESES Eintrags geht zu, ein fremdes bleibt', async () => {
  // Deep-Link unter der Schwelle oeffnet das Blatt; wird das Fenster breiter,
  // zeichnet der Baustein dieselbe Auswahl in die Spalte. Ohne Abgleich stand
  // das Detail doppelt da, und das Overlay blockierte die breite Ansicht.
  const dv = await import('../public/components/detail-view.js');
  let sheet = null;
  let closes = 0;
  globalThis.__openModal = (o) => { sheet = o; };
  globalThis.__closeModal = () => { closes += 1; const s = sheet; sheet = null; s?.onClose?.(); };
  const pane = () => globalThis.document.createElement('div');
  try {
    dv.openDetailView({ title: 'Anna', key: 'contact:42', sections: [] });
    assert.ok(sheet, 'unter der Schwelle: ein Blatt');
    dv.openDetailView({ title: 'Anna', key: 'contact:42', sections: [], pane: pane() });
    assert.equal(closes, 1, 'dieselbe Auswahl in der Spalte: das Blatt geht zu');

    dv.openDetailView({ title: 'Ben', key: 'contact:7', sections: [] });
    dv.openDetailView({ title: 'Anna', key: 'contact:42', sections: [], pane: pane() });
    assert.equal(closes, 1, 'ein Blatt eines ANDEREN Eintrags bleibt stehen');
    globalThis.__closeModal();

    dv.openDetailView({ title: 'Termin', sections: [] });
    dv.openDetailView({ title: 'Anna', key: 'contact:42', sections: [], pane: pane() });
    assert.equal(closes, 2, 'ein Blatt ohne Schluessel (fremdes Modul) bleibt stehen');
    globalThis.__closeModal();

    dv.openDetailView({ title: 'Anna', key: 'contact:42', sections: [] });
    sheet.onClose(); // X, Escape oder ein fremdes Modal hat es schon ersetzt
    sheet = { title: 'Fremd' };
    dv.openDetailView({ title: 'Anna', key: 'contact:42', sections: [], pane: pane() });
    assert.equal(closes, 3, 'ist das Blatt schon zu, schliesst die Spalte kein fremdes Modal');
  } finally {
    delete globalThis.__openModal;
    delete globalThis.__closeModal;
  }
  // Die drei Leseansichten mit Blatt UND Spalte nennen ihren Schluessel.
  for (const [file, pattern] of [
    ['../public/pages/contacts.js', /openDetailView\(\{[\s\S]{0,200}?key: `contact:\$\{contact\.id\}`/],
    ['../public/components/task-detail.js', /openDetailView\(\{[\s\S]{0,200}?key: `task:\$\{task\.id\}`/],
    ['../public/pages/inventory.js', /openDetailView\(\{[\s\S]{0,200}?key: `inventory:\$\{item\.id\}`/],
  ]) {
    assert.match(read(file), pattern, `${file}: die Leseansicht nennt ihren Eintrag (key)`);
  }
});

test('in die Spalte befoerdert, aber das Verwerfen abgelehnt: das Blatt bleibt verfolgt', async () => {
  // Ungespeicherte Aenderungen im Blatt: closeModal() fragt, und wer „nicht
  // verwerfen" sagt, behaelt das Blatt. Wurde es dabei schon vergessen, schloss
  // die naechste Befoerderung es nie mehr - es stand ungefuehrt ueber der Spalte.
  const dv = await import('../public/components/detail-view.js');
  let sheet = null;
  let answer = false;
  const asked = [];
  globalThis.__openModal = (o) => { sheet = o; };
  globalThis.__closeModal = (opts) => {
    asked.push(opts?.force ?? false);
    if (!answer) return false;
    const s = sheet; sheet = null; s?.onClose?.();
    return true;
  };
  const pane = () => globalThis.document.createElement('div');
  try {
    dv.openDetailView({ title: 'Anna', key: 'contact:42', sections: [] });
    dv.openDetailView({ title: 'Anna', key: 'contact:42', sections: [], pane: pane() });
    await new Promise((r) => setTimeout(r, 0));
    assert.deepEqual(asked, [false], 'gefragt wird, nicht erzwungen - ungespeicherte Aenderungen zaehlen');
    assert.ok(sheet, 'abgelehnt: das Blatt steht noch');
    answer = true;
    dv.openDetailView({ title: 'Anna', key: 'contact:42', sections: [], pane: pane() });
    await new Promise((r) => setTimeout(r, 0));
    assert.equal(asked.length, 2, 'die naechste Befoerderung fragt erneut - das Blatt ist noch verfolgt');
    assert.equal(sheet, null, 'diesmal geht es zu');
    dv.openDetailView({ title: 'Anna', key: 'contact:42', sections: [], pane: pane() });
    await new Promise((r) => setTimeout(r, 0));
    assert.equal(asked.length, 2, 'danach ist nichts mehr zu schliessen');
  } finally {
    delete globalThis.__openModal;
    delete globalThis.__closeModal;
  }
});


// ── R10 L8: Kontaktfilter am Desktop ──────────────────────────────────────

test('Kontaktfilter: nur belegte Kategorien, die aktive bleibt, und mit einer Kategorie gar keine Reihe (A5 P2-6)', () => {
  const saved = { categories: contacts.state.categories, contacts: contacts.state.contacts, active: contacts.state.activeCategory };
  try {
    contacts.state.categories = ['doctor', 'school', 'authority', 'insurance', 'craftsman', 'emergency', 'other']
      .map((key) => ({ key, icon: 'tag', name: key }));
    contacts.state.contacts = [{ id: 1, category: 'doctor' }, { id: 2, category: 'school' }, { id: 3, category: 'doctor' }];
    contacts.state.activeCategory = null;
    assert.deepEqual(contacts.filterCategoryKeys(), ['doctor', 'school'], 'leere Kategorien sind Sackgassen');
    contacts.state.activeCategory = 'insurance';
    assert.deepEqual(contacts.filterCategoryKeys(), ['doctor', 'school', 'insurance'], 'der aktive Filter bleibt, sonst kein Weg zurueck');
    contacts.state.activeCategory = null;
    contacts.state.contacts = [{ id: 1, category: 'doctor' }];
    assert.deepEqual(contacts.filterCategoryKeys(), [], 'eine Kategorie: nichts zu filtern');
  } finally {
    contacts.state.categories = saved.categories;
    contacts.state.contacts = saved.contacts;
    contacts.state.activeCategory = saved.active;
  }
});

test('Kontaktfilter: die Gruppe heisst nach ihrer Frage, und am Zeigergeraet bricht die Reihe um', () => {
  const js = read('../public/pages/contacts.js');
  assert.match(js, /id="contacts-filters" role="group" aria-label="\$\{t\('contacts\.categoryLabel'\)\}"/,
    'die Gruppe hiess „Alle" - der Name des ersten Chips, nicht der Frage');
  const css = read('../public/styles/contacts.css');
  const wrap = [...eachRule(css)].find((r) => r.selector.trim() === '.contacts-filters'
    && r.at.some((a) => /hover:\s*hover/.test(a) && /pointer:\s*fine/.test(a)));
  assert.ok(wrap && /flex-wrap:\s*wrap/.test(wrap.body), 'eine Maus hat keine waagerechte Geste');
});

test('Neuer Kontakt ist nicht als „Arzt" vorbelegt: aktive Filterkategorie, sonst misc (Re-Critique 2026-09-28 P2-5)', () => {
  // `state.categories[0]` war die Vorbelegung - das Formular oeffnete auch
  // unter „Alle" mit Arzt samt Stethoskop, und der Nachbar wurde zum Arzt.
  const saved = { categories: contacts.state.categories, active: contacts.state.activeCategory, user: contacts.state.user };
  const gewaehlt = (html) => {
    const select = html.match(/<select[^>]*id="cm-category"[^>]*>([\s\S]*?)<\/select>/)?.[1];
    assert.ok(select, 'Kategorie-Select nicht gefunden');
    return [...select.matchAll(/<option value="([^"]*)"([^>]*)>/g)].filter(([, , attrs]) => /\bselected\b/.test(attrs)).map(([, v]) => v);
  };
  try {
    contacts.state.user = { id: 1, role: 'admin' };
    contacts.state.categories = [
      { key: 'doctor', icon: 'stethoscope' }, { key: 'school', icon: 'school' }, { key: 'misc', icon: 'tag' },
    ];
    contacts.state.activeCategory = null;
    assert.deepEqual(gewaehlt(contacts.buildContactForm({ mode: 'create' }).content), ['misc'], 'unter „Alle": misc');
    contacts.state.activeCategory = 'school';
    assert.deepEqual(gewaehlt(contacts.buildContactForm({ mode: 'create' }).content), ['school'], 'unter einem Filter: dessen Kategorie');
    contacts.state.activeCategory = null;
    const edit = contacts.buildContactForm({ mode: 'edit', contact: { ...KONTAKT, emails: [], phones: [] } }).content;
    assert.deepEqual(gewaehlt(edit), ['doctor'], 'Bearbeiten behaelt die Ist-Kategorie');
  } finally {
    contacts.state.categories = saved.categories;
    contacts.state.activeCategory = saved.active;
    contacts.state.user = saved.user;
  }
});
