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

test('Kontaktfilter: die Gruppe heisst nach ihrer Frage, und die Reihe bleibt EINE Reihe - auch am Zeigergeraet (R22 D20)', () => {
  const js = read('../public/pages/contacts.js');
  assert.match(js, /id="contacts-filters" role="group" aria-label="\$\{t\('contacts\.categoryLabel'\)\}"/,
    'die Gruppe hiess „Alle" - der Name des ersten Chips, nicht der Frage');
  const css = read('../public/styles/contacts.css');
  const wrap = [...eachRule(css)].filter((r) => /\.contacts-filters\b/.test(r.selector)
    && (/flex-wrap:\s*wrap/.test(r.body) || /overflow-x:\s*visible/.test(r.body)));
  assert.deepEqual(wrap.map((r) => r.selector), [],
    'am Desktop brach die Reihe in zwei um (1280: rund 48px mehr Kopf) - sie scrollt jetzt mit Fade wie mobil');
  assert.match(js, /wireScrollFade\(_container\.querySelector\('#contacts-filters'\)\);\s*wireWheelToRow\(_container\.querySelector\('#contacts-filters'\)\)/,
    'Fade an der Kante und das Mausrad bewegt die Reihe');
});

test('R22 D20: das Mausrad bewegt die Chipreihe waagerecht, bis sie am Ende ist - dann scrollt die Seite', () => {
  let handler = null;
  const row = {
    scrollLeft: 0, scrollWidth: 900, clientWidth: 400,
    addEventListener(type, fn, opts) { if (type === 'wheel') { handler = fn; assert.equal(opts?.passive, false, 'sonst greift preventDefault nicht'); } },
  };
  Object.defineProperty(row, 'scrollLeft', {
    get() { return this._x ?? 0; },
    set(v) { this._x = Math.max(0, Math.min(v, this.scrollWidth - this.clientWidth)); },
  });
  contacts.wireWheelToRow(row);
  assert.ok(handler, 'die Reihe hoert auf das Rad');
  const rad = (over) => {
    const e = { deltaX: 0, deltaY: 100, ctrlKey: false, prevented: false, preventDefault() { this.prevented = true; }, ...over };
    handler(e);
    return e.prevented;
  };
  assert.equal(rad({}), true, 'senkrechtes Rad bewegt die Reihe');
  assert.equal(row.scrollLeft, 100);
  row.scrollLeft = 500;
  assert.equal(rad({}), false, 'am Ende geht das Rad an die Seite weiter - nie fest');
  assert.equal(rad({ deltaX: 30 }), false, 'eine echte Waagerecht-Geste bleibt beim Browser');
  assert.equal(rad({ ctrlKey: true }), false, 'Strg+Rad zoomt');
  row.scrollWidth = 300;
  row.scrollLeft = 0;
  assert.equal(rad({}), false, 'ohne Ueberlauf nichts zu bewegen');
});

test('R22 D7: ein ueber den Geburtstag verknuepfter Kontakt ohne eigenes Datum zeigt das verknuepfte - und den Weg', () => {
  const rows = contacts.renderContactDetail({ id: 9, name: 'Mike', birthday: null, birthday_id: 4, birthday_link_date: '1985-11-02', birthday_link_year_unknown: 0 });
  const row = rows.find((r) => r.icon === 'cake');
  assert.ok(row?.value, 'ohne Wert fiele die Zeile weg und mit ihr der Rueckweg');
  assert.equal(row.action?.label, 'contacts.showBirthday');
  const eigen = contacts.renderContactDetail({ id: 9, name: 'Mike', birthday: '1985-11-03', birthday_id: 4, birthday_link_date: '1985-11-02' });
  assert.match(eigen.find((r) => r.icon === 'cake').value, /03|3/, 'das eigene Datum des Kontakts geht vor');
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

// -------------------------------------------------------------------------
// Der Import-Toast nennt die Ursache in der Sprache des Nutzers (#1909)
//
// Schlaegt jede Anlage fehl, sagt der Toast "Import fehlgeschlagen: <Ursache>".
// Bis #1909 kam die Ursache ueber `window.yuvomi.friendlyError` und war der
// englische Text des Servers ("Telefon may be at most 100 characters long."),
// weil nur er das abgewiesene Feld nannte. Jetzt nennt der Server den Fall
// (`reason`, `params.limit`, server/routes/contacts.js), und der Satz der App
// nennt Feld und Grenze. Gemessen wird am echten Aufrufer mit der echten
// Zuordnung (utils/friendly-error.js).
// -------------------------------------------------------------------------
test('Import-Toast: schlaegt alles fehl, nennt er das Feld als Satz der App, nie den Servertext (#1909)', async () => {
  // Wie der Fehler aus api.js kommt: `message` und `data.error` tragen den Text des Servers.
  const answer = (status, error, extra = {}) => Object.assign(new Error(error), {
    name: 'ApiError', status, data: { error, code: status, ...extra },
  });
  const yuvomi = globalThis.window.yuvomi;
  const saved = { showToast: yuvomi.showToast };
  const savedNavigator = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
  Object.defineProperty(globalThis, 'navigator', { value: { onLine: true }, configurable: true, writable: true });
  const toasts = [];
  yuvomi.showToast = (message, type, duration, action) => toasts.push({ message, type, duration, action });
  const failed = (lastError) => {
    toasts.length = 0;
    contacts.showImportResult({ imported: 0, withBirthday: 0, failedList: [{ name: '' }], lastName: null, lastError });
    assert.equal(toasts.length, 1, 'genau ein Toast');
    return toasts[0];
  };
  const toast = (error) => 'contacts.importError' + JSON.stringify({ error });
  try {
    // POST /contacts lehnt mit 400 ab und nennt das Feld als Fall.
    const phone = failed(answer(400, 'Telefon may be at most 100 characters long.',
      { reason: 'contacts_phone_too_long', params: { limit: 100 } }));
    assert.equal(phone.type, 'danger');
    assert.equal(phone.message, toast('contacts.errorPhoneTooLong' + JSON.stringify({ limit: 100 })),
      'der Satz der App nennt Feld und Grenze');
    assert.equal(phone.action?.label, 'contacts.importRetry');
    assert.equal(failed(answer(400, 'Geburtstag must be a valid calendar date.', { reason: 'contacts_birthday_invalid' })).message,
      toast('contacts.errorBirthdayInvalid'));
    // Fehlt die Grenze, gibt es keinen Satz mit leerem Platzhalter, sondern den allgemeinen.
    assert.equal(failed(answer(400, 'Notizen may be at most 5000 characters long.', { reason: 'contacts_notes_too_long' })).message,
      toast('common.errorGeneric'));

    // Ein Befund ohne benannten Fall: der allgemeine Satz, nie der Servertext.
    const unnamed = failed(answer(400, 'Name is required.'));
    assert.equal(unnamed.message, toast('common.errorGeneric'));
    assert.ok(!unnamed.message.includes('required'), 'der englische Servertext steht nicht im Toast');

    // Was die App selbst sagen kann, sagt sie weiter in der Sprache des Nutzers.
    assert.equal(failed(answer(403, 'Not authorized.')).message, toast('common.errorNoPermission'));
    assert.equal(failed(answer(500, 'Internal error.')).message, toast('common.errorGeneric'));
  } finally {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete yuvomi[k];
      else yuvomi[k] = v;
    }
    if (savedNavigator) Object.defineProperty(globalThis, 'navigator', savedNavigator);
    else delete globalThis.navigator;
  }
});

/* D7 (Critique R21): KONTAKT UND GEBURTSTAG KENNEN EINANDER. Ein importierter
 * Geburtstag traegt seit Migration 90 seinen Kontakt (`contact_id`), die
 * Kontaktseite bekommt den Rueckweg (`birthday_id`, routes/contacts.js). Die
 * Geburtstagszeile der Leseansicht fuehrt dann "In Geburtstagen anzeigen" -
 * ein Schritt statt Modulwechsel, Suche und Antippen. Ohne Verknuepfung, oder
 * ohne Zugang zum Geburtstagsmodul, gibt es den Knopf nicht. */
test('R21 D7: die Geburtstagszeile eines verknuepften Kontakts fuehrt zum Geburtstag', async () => {
  const rows = contacts.renderContactDetail({ id: 7, name: 'Tante', birthday: '1970-05-04', birthday_year_unknown: 0, birthday_id: 42 });
  const row = rows.find((r) => r.icon === 'cake');
  assert.ok(row?.action, 'die Zeile traegt eine Folgeaktion');
  assert.equal(row.action.label, 'contacts.showBirthday');
  assert.equal(contacts.birthdayHref(42), '/birthdays?open=42');
  const lose = contacts.renderContactDetail({ id: 8, name: 'Onkel', birthday: '1968-02-01', birthday_year_unknown: 0, birthday_id: null });
  const { setPermissions, clearPermissions } = await import('../public/permissions.js');
  setPermissions({ admin: false, modules: { calendar: 'read' }, widgets: {}, capabilities: {} });
  try {
    const lose = contacts.renderContactDetail({ id: 8, name: 'Onkel', birthday: '1968-02-01', birthday_year_unknown: 0, birthday_id: null });
    assert.equal(lose.find((r) => r.icon === 'cake')?.action ?? null, null, 'ohne Verknuepfung und ohne Schreibrecht kein Weg');
  } finally {
    clearPermissions();
  }
});

/* #2149: EIN KONTAKT MIT GEBURTSDATUM, ABER OHNE EINTRAG IN GEBURTSTAGE.
 * Dieselbe Folgeaktion der Geburtstagszeile legt ihn an - den Eintrag, den
 * der Import anlegen wuerde (`POST /birthdays/import` mit genau dieser id).
 * Angeboten nur, wo der Server annimmt: `calendar: write` und das Modul
 * nicht abgeschaltet. Ohne Geburtsdatum gibt es nichts anzulegen. */
test('#2149: unverknuepft bietet die Geburtstagszeile "Zu Geburtstagen hinzufuegen" an - nur mit Schreibrecht', async () => {
  const { setPermissions, clearPermissions } = await import('../public/permissions.js');
  const LOSE = { id: 8, name: 'Onkel', birthday: '1968-02-01', birthday_year_unknown: 0, birthday_id: null };
  const actionOf = (c) => contacts.renderContactDetail(c).find((r) => r.icon === 'cake')?.action ?? null;
  const yuvomi = globalThis.window.yuvomi;
  const savedDisabled = yuvomi.isModuleDisabled;
  try {
    setPermissions({ admin: false, modules: { calendar: 'write', contacts: 'read' }, widgets: {}, capabilities: {} });
    const add = actionOf(LOSE);
    assert.equal(add?.label, 'contacts.addToBirthdays', 'mit Schreibrecht steht der Weg in Geburtstage an der Zeile');
    assert.equal(add.id, 'contact-detail-birthday-add');
    assert.equal(actionOf({ ...LOSE, birthday_id: 5 })?.label, 'contacts.showBirthday', 'verknuepft bleibt es beim Anzeigen');
    assert.equal(actionOf({ ...LOSE, birthday: null }), null, 'ohne Geburtsdatum nichts anzulegen');

    setPermissions({ admin: false, modules: { calendar: 'read' }, widgets: {}, capabilities: {} });
    assert.equal(actionOf(LOSE), null, 'calendar: read - der Import nimmt nicht an');
    setPermissions({ admin: false, modules: { calendar: 'none' }, widgets: {}, capabilities: {} });
    assert.equal(actionOf(LOSE), null, 'calendar: none');

    setPermissions({ admin: false, modules: { calendar: 'write' }, widgets: {}, capabilities: {} });
    yuvomi.isModuleDisabled = (key) => key === 'birthdays';
    assert.equal(actionOf(LOSE), null, 'haushaltweit abgeschaltet - der Router leitet um');
  } finally {
    clearPermissions();
    if (savedDisabled === undefined) delete yuvomi.isModuleDisabled;
    else yuvomi.isModuleDisabled = savedDisabled;
  }
});

/* R22 D7: DER HINWEIS "HEISST GENAUSO" AUCH IM KONTAKT. Der Geburtstag zeigte
 * ihn (birthdays.js, contactSuggestionRow), der Kontakt nicht. Jetzt traegt
 * der Kontakt `suggested_birthday_id` (routes/contacts.js), und die Ansicht
 * zeigt dieselbe ruhige Zeile mit "Verknuepfen" - nur mit Schreibrecht auf
 * Geburtstage, und dann ohne "Hinzufuegen" an der Datumszeile: das legte
 * einen zweiten Geburtstag fuer denselben Menschen an. */
test('R22 D7: gleichnamiger Geburtstag - der Kontakt zeigt den Hinweis mit "Verknuepfen"', async () => {
  const { setPermissions, clearPermissions } = await import('../public/permissions.js');
  const SAME = { id: 9, name: 'Tante', birthday: '1970-05-04', birthday_year_unknown: 0, birthday_id: null, suggested_birthday_id: 31 };
  const hintOf = (c) => contacts.renderContactDetail(c).find((r) => r?.action?.id === 'contact-detail-birthday-link') ?? null;
  const yuvomi = globalThis.window.yuvomi;
  const savedDisabled = yuvomi.isModuleDisabled;
  try {
    setPermissions({ admin: false, modules: { calendar: 'write', contacts: 'read' }, widgets: {}, capabilities: {} });
    const hint = hintOf(SAME);
    assert.ok(hint, 'die Zeile steht da');
    assert.equal(hint.value, 'contacts.birthdaySuggestValue');
    assert.equal(hint.action.label, 'birthdays.linkContact', 'dasselbe Wort wie auf der Geburtstagsseite');
    assert.equal(hint.action.icon, 'link');
    const dateRow = contacts.renderContactDetail(SAME).find((r) => r?.icon === 'cake' && r.label === 'contacts.birthdayLabel');
    assert.equal(dateRow?.action ?? null, null, 'kein "Hinzufuegen" neben dem Hinweis - es legte einen zweiten Geburtstag an');
    // R23 G5-P2: gleicher Tag, anderer Name - der Satz nennt den Geburtstag.
    const sameDay = hintOf({ ...SAME, suggested_birthday_name: 'Ingrid Mueller' });
    assert.equal(sameDay?.value, 'contacts.birthdaySuggestSameDate{"name":"Ingrid Mueller"}', 'gleicher Tag: "Mit X verknuepfen?"');
    assert.equal(sameDay.action.label, 'birthdays.linkContact');
    assert.ok(hintOf({ ...SAME, birthday: null }), 'auch ohne eigenes Datum');
    assert.equal(hintOf({ ...SAME, suggested_birthday_id: undefined }), null, 'ohne Vorschlag keine Zeile');
    assert.equal(hintOf({ ...SAME, birthday_id: 31 }), null, 'verknuepft keine Zeile');

    setPermissions({ admin: false, modules: { calendar: 'read' }, widgets: {}, capabilities: {} });
    assert.equal(hintOf(SAME), null, 'calendar: read - nichts zu tun, also keine Zeile');
    setPermissions({ admin: false, modules: { calendar: 'write' }, widgets: {}, capabilities: {} });
    yuvomi.isModuleDisabled = (key) => key === 'birthdays';
    assert.equal(hintOf(SAME), null, 'haushaltweit abgeschaltet');
  } finally {
    clearPermissions();
    if (savedDisabled === undefined) delete yuvomi.isModuleDisabled;
    else yuvomi.isModuleDisabled = savedDisabled;
  }
});

test('R22 D7: Verknuepfen schreibt den Geburtstag und liest den Kontakt neu', async () => {
  const { setPermissions, clearPermissions } = await import('../public/permissions.js');
  const yuvomi = globalThis.window.yuvomi;
  const savedToast = yuvomi.showToast;
  const calls = [];
  const toasts = [];
  yuvomi.showToast = (message, type) => toasts.push({ message, type });
  let linked = 31;
  globalThis.__apiStub = {
    put: (path, body) => { calls.push(['PUT', path, body]); return { data: { id: 31, contact_id: 9 } }; },
    get: (path) => { calls.push(['GET', path]); return { data: { id: 9, name: 'Tante', birthday_id: linked } }; },
  };
  contacts.state.contacts = [{ id: 9, name: 'Tante', birthday_id: null }];
  setPermissions({ admin: false, modules: { calendar: 'write', contacts: 'read' }, widgets: {}, capabilities: {} });
  try {
    const seen = [];
    const button = { disabled: false, isConnected: true };
    const loaded = await contacts.linkContactToBirthday({ id: 9, name: 'Tante' }, 31, { button, onLinked: (c) => seen.push(c) });
    assert.deepEqual(calls[0], ['PUT', '/birthdays/31', { contact_id: 9 }], 'der Geburtstag bekommt den Kontakt');
    assert.deepEqual(calls[1], ['GET', '/contacts/9']);
    assert.equal(loaded?.birthday_id, 31);
    assert.equal(seen[0]?.birthday_id, 31, 'die Ansicht zeichnet mit Verknuepfung neu');
    assert.equal(contacts.state.contacts[0].birthday_id, 31);
    assert.deepEqual(toasts.at(-1), { message: 'contacts.linkedToBirthday', type: 'success' });

    linked = null;
    const again = await contacts.linkContactToBirthday({ id: 9, name: 'Tante' }, 31, { button });
    assert.equal(again, null);
    assert.equal(toasts.at(-1)?.type, 'danger');
    assert.equal(button.disabled, false);
  } finally {
    clearPermissions();
    delete globalThis.__apiStub;
    contacts.state.contacts = [];
    if (savedToast === undefined) delete yuvomi.showToast;
    else yuvomi.showToast = savedToast;
  }
});

test('#2149: Hinzufuegen ruft den Import mit genau diesem Kontakt und liest die Verknuepfung neu', async () => {
  const yuvomi = globalThis.window.yuvomi;
  const savedToast = yuvomi.showToast;
  const calls = [];
  const toasts = [];
  yuvomi.showToast = (message, type) => toasts.push({ message, type });
  let linked = 77;
  globalThis.__apiStub = {
    post: (path, body) => { calls.push(['POST', path, body]); return { data: { imported: 1, skipped: 0 } }; },
    get: (path) => { calls.push(['GET', path]); return { data: { id: 8, name: 'Onkel', birthday: '1968-02-01', birthday_id: linked } }; },
  };
  contacts.state.contacts = [{ id: 8, name: 'Onkel', birthday: '1968-02-01', birthday_id: null }];
  try {
    const seen = [];
    const button = { disabled: false, isConnected: true };
    const loaded = await contacts.addContactToBirthdays({ id: 8, name: 'Onkel', birthday: '1968-02-01' }, { button, onLinked: (c) => seen.push(c) });
    assert.deepEqual(calls[0], ['POST', '/birthdays/import', { contact_ids: [8] }], 'der bestehende Import, eine id');
    assert.deepEqual(calls[1], ['GET', '/contacts/8'], 'danach der Kontakt selbst');
    assert.equal(loaded?.birthday_id, 77);
    assert.equal(seen[0]?.birthday_id, 77, 'die Ansicht bekommt den Kontakt mit Verknuepfung');
    assert.equal(contacts.state.contacts[0].birthday_id, 77, 'die Liste kennt die Verknuepfung');
    assert.equal(toasts.at(-1)?.type, 'success');

    // Kommt der Kontakt trotzdem ohne Eintrag zurueck, ist das kein Erfolg.
    linked = null;
    calls.length = 0;
    const again = await contacts.addContactToBirthdays({ id: 8, name: 'Onkel', birthday: '1968-02-01' }, { button });
    assert.equal(again, null);
    assert.equal(toasts.at(-1)?.type, 'danger');
    assert.equal(button.disabled, false, 'der Knopf ist wieder bedienbar');
  } finally {
    delete globalThis.__apiStub;
    contacts.state.contacts = [];
    if (savedToast === undefined) delete yuvomi.showToast;
    else yuvomi.showToast = savedToast;
  }
});

// R21 S7 (Critique a3): zwei Kanten im Kontakt. Im Leseblatt stand der erste
// antippbare Wert mit dem halben Ueberstand seines 44px-Ziels unter dem Label
// (Label -> Wert 15px, bei Kategorie 3px); im Formular endete der Platzhalter
// des Labelfelds mobil als "Label (z. B. A" (122 von 162px).
test('R21 S7: Label und Wert stehen dicht, das Labelfeld steht schmal unter dem Wert', () => {
  const css = readFileSync(new URL('../public/styles/contacts.css', import.meta.url), 'utf8');
  const rules = [...eachRule(css)];
  const pull = rules.find((r) => r.selector.trim() === '.contact-detail__value:first-child > .contact-detail__link');
  assert.match(pull?.body ?? '', /margin-block-start:\s*calc\(\(var\(--line-height-base\) \* 1em - var\(--target-base\)\) \/ 2\)/,
    'der erste Wert zieht den Ueberstand seines Ziels zurueck');
  const list = rules.find((r) => r.selector.trim() === '.contact-mv-list');
  assert.match(list?.body ?? '', /container:\s*contact-mv \/ inline-size/);
  const label = rules.find((r) => r.selector.trim() === '.contact-mv-row > .contact-mv-row__label' && r.at.some((a) => /@container contact-mv \(max-width:/.test(a)));
  assert.match(label?.body ?? '', /grid-row:\s*2/, 'schmal steht das Label in einer eigenen Zeile');
});

// R21 S9b (Critique a3): Liste und Detail zeigten dieselbe Nummer verschieden -
// die Zeile formatiert (enhancePhones), der Link der Detailansicht behielt den
// Rohwert, weil der A-Zweig nur das Ziel setzte. Jetzt bekommt ein Link, der die
// Nummer selbst traegt, dieselbe Anzeige; ein Aktionslink ("Anrufen") behaelt
// sein Wort.
test('Liste und Detail zeigen eine Telefonnummer in derselben Form', async () => {
  const { __primePhoneLib } = await import('../public/utils/phone.js');
  __primePhoneLib({
    parse: (value) => ({
      country: 'DE', number: '+492314452210',
      formatNational: () => '0231 4452210', formatInternational: () => '+49 231 4452210',
    }),
    AsYouType: class {}, isPossible: () => true, metadata: {},
  });
  try {
    contacts.state.defaultCountry = 'AT';
    const raw = '+49 231 445 2210';
    const el = (tag, text) => {
      const node = document.createElement(tag);
      // mini-dom fuehrt den Tag klein; der Browser (und enhancePhones) gross.
      node.tagName = tag.toUpperCase();
      node.dataset.phoneRaw = raw;
      node.textContent = text;
      if (tag === 'a') node.href = 'tel:x';
      return node;
    };
    const zeile = el('span', raw);
    const detail = el('a', raw);
    const aktion = el('a', 'Anrufen');
    const root = { querySelectorAll: () => [zeile, detail, aktion] };
    await contacts.enhancePhones(root);
    assert.equal(zeile.textContent, '+49 231 4452210', 'die Zeile formatiert');
    assert.equal(detail.textContent, zeile.textContent, 'der Link der Detailansicht zeigt dieselbe Form');
    assert.equal(detail.getAttribute('dir'), 'ltr');
    assert.match(detail.href, /^tel:\+492314452210$/, 'und waehlt E.164');
    assert.equal(aktion.textContent, 'Anrufen', 'ein Aktionslink behaelt sein Wort');
    assert.match(aktion.href, /^tel:\+492314452210$/);
  } finally {
    __primePhoneLib(null);
  }
});

// R23 (Critique G5 P2/P3): im Auswahlmodus kuerzte der Titel auf "Kont..."
// (390px: Suche, "Abbrechen" und "..." daneben), und "Name noetig" kam als
// Toast statt am Feld.
test('R23: im Auswahlmodus tritt das Menue ab, der Name meldet sich am Feld', () => {
  const css = read('../public/styles/contacts.css');
  const hide = [...eachRule(css)].find((r) => r.selector.trim() === '.contacts-page.is-selecting .contacts-toolbar .page-tools-btn');
  assert.ok(hide && /display:\s*none/.test(hide.body), 'das Menue weicht im Auswahlmodus');
  const js = read('../public/pages/contacts.js');
  const exit = js.slice(js.indexOf('function exitSelectMode()'), js.indexOf('function syncSelectChrome()'));
  assert.ok(exit.indexOf("classList.remove('is-selecting')") > -1
    && exit.indexOf("classList.remove('is-selecting')") < exit.indexOf(".page-tools-btn')?.focus()"),
    'erst die Klasse, dann der Fokus - ein ausgeblendeter Knopf nimmt keinen');
  assert.match(js, /if \(!name && reportFieldErrors\(\[\[panel\.querySelector\('#cm-first-name'\), t\('contacts\.nameRequiredHint'\)\]\]\)\) return;/);
  assert.doesNotMatch(js, /showToast\(t\('contacts\.nameRequiredHint'\)/, 'kein Toast mehr fuer ein Feld');
});

// R23: die Chipreihe erschien erst mit den Daten, und die Liste rutschte um
// ihre Hoehe nach unten (390x844 Layout-Shift 0,068 bei 4x CPU).
test('R23: die Chipreihe haelt ihren Platz, bis die Kontakte geladen sind', () => {
  const css = read('../public/styles/contacts.css');
  const rules = [...eachRule(css)];
  assert.ok(!rules.some((r) => r.selector.trim() === '.contacts-filters:empty' && /display:\s*none/.test(r.body)), 'leer heisst nicht weg, solange geladen wird');
  const hide = rules.find((r) => r.selector.trim() === '.contacts-filters:empty:not([data-pending])');
  assert.ok(hide && /display:\s*none/.test(hide.body), 'erst nach dem Laden faellt eine leere Reihe weg');
  const js = read('../public/pages/contacts.js');
  assert.match(js, /id="contacts-filters" role="group" aria-label="\$\{t\('contacts\.categoryLabel'\)\}" data-pending><\/div>/, 'die Marke steht im ersten Bild');
  const fn = js.slice(js.indexOf('function renderCategoryFilters()'), js.indexOf('function openContactCategoryManager()'));
  assert.match(fn, /bar\.removeAttribute\('data-pending'\);/, 'und faellt beim ersten Zeichnen mit Daten');
});

// R23 S11b (Critique G5 P3): "Kontakt bearbeiten" hatte mobil drei Ausgaenge
// (Zurueck, x, Abbrechen), und Abbrechen schloss das ganze Blatt. Die
// Detailansicht erkennt ein Abbrechen nur an `data-action="close-modal"` (R19,
// detail-view.js) - dann ist es der Weg zurueck in die Leseansicht, und das
// Kopf-"Zurueck" faellt weg, wie in Rezepten, Notizen und Inventar.
test('Kontakt bearbeiten: Abbrechen ist der eine Rueckweg in die Leseansicht', () => {
  const js = read('../public/pages/contacts.js');
  assert.match(js, /<button type="button" class="btn btn--secondary" id="cm-cancel" data-action="close-modal">/);
  const dv = read('../public/components/detail-view.js');
  assert.match(dv, /state\.formCancel = state\.formFooter\?\.querySelector\('\[data-action="close-modal"\]'\)/, 'daran erkennt die Detailansicht das Abbrechen');
});

// R24 (Critique G5 Kontakte-P3-2): die Kategorie-Chips liefen am Desktop in
// der 424px-Spalte aus dem Bild („Dienstleistungen" nur per Querscroll), am
// Telefon schon ab „Familie". Gemessen nachher: 1440 und 390 ein Filterknopf
// „Filter", Blatt/Popover mit 5 Chips, Wahl „Arzt" -> 2 Zeilen, „1 Filter
// aktiv"; 1024 (Lesemass, Reihe passt) bleiben die Chips.
test('R24 Kontakte-P3-2: passt die Kategoriereihe nicht oder sind es mehr als vier, steht ein Filterknopf', () => {
  const src = read('../public/pages/contacts.js');
  const fn = src.slice(src.indexOf('function renderCategoryFilters()'), src.indexOf('function openContactCategoryManager()'));
  assert.match(src, /const CONTACT_CHIP_MAX = 4;/);
  assert.match(fn, /const asButton = keys\.length > CONTACT_CHIP_MAX \|\| _chipOverflowWidth != null;/, 'Zahl ODER gemessene Enge');
  assert.match(fn, /filterButtonHtml\(\{ id: 'contacts-category-filter', count: active \? 1 : 0, showLabel: true \}\)/, 'der geteilte Filterknopf mit Zaehler');
  assert.match(fn, /if \(bar\.clientWidth > 0 && bar\.scrollWidth > bar\.clientWidth \+ 1\) \{\s*_chipOverflowWidth = bar\.clientWidth;/, 'schneidet die Reihe, wird sie zum Knopf');
  const sheet = src.slice(src.indexOf('function openContactCategoryFilter()'), src.indexOf('function renderCategoryFilters()'));
  assert.match(sheet, /openFilterSheet\(\{/, 'die Kategorien im geteilten Filterblatt');
  assert.match(sheet, /filterChipHtml\(\{ filter: 'contacts-category', value: '', label: t\('contacts\.filterAll'\)/);
  assert.match(src, /if \(e\.target\.closest\('#contacts-category-filter'\)\) \{ openContactCategoryFilter\(\); return; \}/);
});

// R24 D4: der vCard-Import sperrt seinen Primaerknopf nicht mehr; ohne Wahl
// sagt er am Dialog, was fehlt. Weitere Angaben nennt, was dahinter liegt.
test('R24 D4: Kontakte - Import nie gesperrt, Weitere Angaben benannt', () => {
  const src = read('../public/pages/contacts.js');
  const imp = src.slice(src.indexOf('<div class="vcard-import">'), src.indexOf('importParsedContacts(chosen)'));
  assert.doesNotMatch(imp, /submitBtn\.disabled = n === 0/);
  assert.match(imp, /reasonEl\.textContent = t\('birthdays\.importNothingSelected'\)/);
  assert.match(src, /advancedSection\(advancedFieldsHtml, \{\s*open: advancedOpen,[\s\S]{0,120}hint: \[t\('contacts\.addressLabel'\)/);
});
