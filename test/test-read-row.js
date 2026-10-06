/**
 * Modul: Die geteilte Lesezeile (#1682)
 * Zweck: `readRowHtml` stand dreimal da - Geburtstage, Einkauf, Vorrat -, mit
 *        zwei Signaturen: zwei Kopien nahmen `value` und escapten selbst, die
 *        dritte nahm `valueHtml` und verliess sich auf den Aufrufer. Und die
 *        Listenzeile sagte einem Screenreader bei Nur-lesen nicht, was ein
 *        Tipp tut: mit Schreibrecht steht „Bearbeiten" am Zeilenknopf, bei
 *        `read` fiel der Zusatz weg und nichts ersetzte ihn.
 *
 *        Jetzt ein Baustein (public/utils/read-row.js):
 *          - `readRowHtml({ value })` escaped selbst; fertiges Markup muss als
 *            `valueHtml` ausdruecklich benannt werden, beides zusammen wirft.
 *          - Ein Satz (`common.showDetails`) fuer alle drei Seiten: als
 *            sr-only-Zusatz am Zeilenknopf (Geburtstage, Vorrat) und als Name
 *            des eigenen Info-Knopfs (Einkauf).
 *
 *        Gemessen am erzeugten Markup der echten Renderer, je Seite mit dem
 *        Schreibrecht-Gegenfall - erschiene das Gesuchte dort nicht anders,
 *        waere der Aufbau des Tests kaputt, nicht die Regel erfuellt. Der
 *        i18n-Stub des Loaders gibt den KEY zurueck; dass der Key in allen
 *        Sprachen einen echten Satz hat, halten test:i18n und
 *        test:i18n-translated.
 *
 * Ausführen: npm run test:read-row
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { eachRule } from './css-rules.js';

globalThis.HTMLElement = globalThis.HTMLElement ?? class {};
globalThis.customElements = globalThis.customElements ?? { define() {}, get() {} };

const { installMiniDom } = await import('./mini-dom.js');
installMiniDom();
globalThis.window.yuvomi = { showToast() {}, ...globalThis.window.yuvomi };
globalThis.window.innerWidth = 1280;

const { setPermissions, clearPermissions } = await import('../public/permissions.js');
const { readRowHtml, readRowHintHtml, readRowHintEl, readDetailsLabel } = await import('../public/utils/read-row.js');
const { __test: birthdays } = await import('../public/pages/birthdays.js');
const { __test: shopping } = await import('../public/pages/shopping.js');
const { __test: pantry } = await import('../public/pages/pantry.js');

function withAccess(modules, fn) {
  setPermissions({ admin: false, modules, widgets: {}, capabilities: {} });
  try {
    return fn();
  } finally {
    clearPermissions();
  }
}

/** Die Optionen des Dialogs, den `fn` oeffnet. */
function dialog(fn) {
  const zuvor = globalThis.__openModal;
  let letzte = null;
  globalThis.__openModal = (opts) => { letzte = opts; };
  try {
    fn();
  } finally {
    globalThis.__openModal = zuvor;
  }
  return letzte;
}

const zeilen = (html) => (html.match(/class="detail-row[ "]/g) ?? []).length;

/** Der Inhalt des EINEN Knopfs, den `oeffner` (ein Regex auf sein Start-Tag) trifft. */
function knopfInhalt(html, oeffner) {
  const start = html.search(oeffner);
  assert.notEqual(start, -1, `der Knopf ${oeffner} steht nicht im Markup`);
  const ab = html.indexOf('>', start) + 1;
  return html.slice(ab, html.indexOf('</button>', ab));
}

const HINWEIS = /<span class="sr-only">common\.showDetails<\/span>/;

// --------------------------------------------------------
// Der Baustein
// --------------------------------------------------------

test('Baustein: `value` ist Text und wird escaped, `valueHtml` muss benannt werden', () => {
  const text = readRowHtml({ icon: 'tag', label: 'A & B', value: '<img src=x onerror=1>' });
  assert.match(text, /class="detail-row"/);
  assert.match(text, /<span class="detail-row__label">A &amp; B<\/span>/);
  assert.match(text, /<span class="detail-row__value">&lt;img src=x onerror=1&gt;<\/span>/);
  assert.doesNotMatch(text, /<img/, 'der sichere Weg ist die Vorgabe');

  const fertig = readRowHtml({ icon: 'link', label: 'Link', valueHtml: '<a href="https://example.org">x</a>' });
  assert.match(fertig, /<span class="detail-row__value"><a href="https:\/\/example\.org">x<\/a><\/span>/,
    'Gegenfall: ausdruecklich benanntes Markup bleibt Markup');

  assert.throws(() => readRowHtml({ icon: 'x', label: 'x', value: 'a', valueHtml: '<b>a</b>' }), TypeError,
    'beides zusammen ist ein Fehler, keine stille Rangfolge');

  assert.match(readRowHtml({ icon: 'align-left', label: 'Notiz', value: 'a', multiline: true }), /detail-row detail-row--multiline/);
  for (const leer of [{ value: '' }, { value: null }, { value: '   ' }, { valueHtml: '' }, {}]) {
    assert.equal(readRowHtml({ icon: 'x', label: 'x', ...leer }), '', `ohne Wert keine Zeile: ${JSON.stringify(leer)}`);
  }
  assert.match(readRowHtml({ icon: 'hash', label: 'Menge', value: 0 }), /detail-row__value">0</, 'die Zahl 0 ist ein Wert');
});

test('Baustein: der Zusatz ist sr-only und traegt den EINEN Key, als Markup wie als Knoten', () => {
  assert.match(readRowHintHtml(), HINWEIS);
  assert.match(readRowHintEl().outerHTML, HINWEIS);
  assert.equal(readDetailsLabel('Milch'), 'common.showDetails: Milch');
});

// --------------------------------------------------------
// Geburtstage
// --------------------------------------------------------

const geburtstag = (over = {}) => ({
  id: 9, name: 'Oma Erna', birth_date: '1950-04-03', next_birthday: '2027-04-03',
  next_age: 77, days_until: 12, notes: 'Mag Kuchen', next_name_day: null,
  name_day_days_until: null, photo_data: null, family_user_id: null, ...over,
});

test('Geburtstage bei `calendar: read`: der Zeilenknopf sagt, dass er die Details zeigt', () => {
  const zeile = (modules) => withAccess(modules, () => birthdays.birthdayItemHtml(geburtstag()));
  const knopf = (modules) => knopfInhalt(zeile(modules), /<button[^>]*data-open="9"/);

  const lesend = knopf({ calendar: 'read' });
  assert.match(lesend, /Oma Erna/, 'der Inhalt bleibt der Name der Zeile');
  assert.match(lesend, HINWEIS, 'ohne Zusatz sagt die Zeile nur ihren Inhalt an');
  assert.ok(lesend.trimEnd().endsWith('</span>') && lesend.lastIndexOf('common.showDetails') > lesend.lastIndexOf('Mag Kuchen'),
    'der Zusatz steht am ENDE des Namens');
  assert.doesNotMatch(zeile({ calendar: 'read' }), /aria-label="[^"]*common\.showDetails/,
    'kein aria-label: es ueberschriebe den Namen aus dem Inhalt');

  assert.doesNotMatch(knopf({ calendar: 'write' }), /common\.showDetails/,
    'Gegenfall: mit Schreibrecht oeffnet der Tipp den Editor');
});

test('Geburtstage: die Leseansicht baut ihre Zeilen ueber den geteilten Baustein', () => {
  const ansicht = (eintrag) => withAccess({ calendar: 'read' }, () => dialog(
    () => birthdays.openBirthdayModal({ mode: 'edit', birthday: eintrag }),
  )).content;

  const voll = ansicht(geburtstag({ notes: '<b>Mag</b> Kuchen' }));
  assert.match(voll, /data-view="read"/);
  assert.match(voll, /&lt;b&gt;Mag&lt;\/b&gt; Kuchen/, 'Nutzerdaten laufen durch esc()');
  assert.ok(voll.includes(readRowHtml({ icon: 'align-left', label: 'birthdays.notesLabel', value: '<b>Mag</b> Kuchen', multiline: true })),
    'dieselben Zeichen wie der Baustein - keine eigene Kopie');
  // Eine Notiz aus Leerraum ist kein Wert: die Kopie pruefte `!value` und zeichnete die Zeile.
  assert.equal(zeilen(ansicht(geburtstag({ notes: '   ' }))), zeilen(voll) - 1);
});

// --------------------------------------------------------
// Einkauf
// --------------------------------------------------------

const artikel = (over = {}) => ({
  id: 1, list_id: 5, name: 'Milch', quantity: '2 l', category: 'Sonstiges', is_checked: 0,
  price_cents: 199, store_id: null, url: null, notes: null, tags: [], sort_order: 0, ...over,
});

function einkaufZustand() {
  const LISTE = { id: 5, name: 'Wocheneinkauf', item_total: 1, item_checked: 0 };
  Object.assign(shopping.state, {
    lists: [LISTE], activeList: LISTE, activeListId: LISTE.id, items: [artikel()],
    categories: [{ id: 1, name: 'Sonstiges', icon: 'tag', sort_order: 0 }],
    stores: [], currency: 'EUR', listsError: null, itemsError: null, collapsedCategories: new Set(),
  });
}

test('Einkauf bei `shopping: read`: der Info-Knopf heisst „Details anzeigen" samt Artikel', () => {
  einkaufZustand();
  const zeile = (modules, over) => withAccess(modules, () => shopping.renderItem(artikel(over)));
  const name = (html) => html.match(/<button class="row-action" data-action="item-details"[^>]*aria-label="([^"]*)"/)?.[1];

  const lesend = zeile({ shopping: 'read' });
  assert.match(lesend, /data-lucide="info"/, 'der Knopf zur Leseansicht steht');
  assert.equal(name(lesend), 'common.showDetails: Milch', 'derselbe Satz wie an den anderen Lesezeilen, mit dem Objekt');
  assert.equal(name(zeile({ shopping: 'read' }, { name: 'A "B" <c>' })), 'common.showDetails: A &quot;B&quot; &lt;c&gt;',
    'der Name laeuft durch esc()');

  const schreibend = zeile({ shopping: 'write' });
  assert.match(schreibend, /data-lucide="pencil"/);
  assert.doesNotMatch(schreibend, /common\.showDetails/, 'Gegenfall: mit Schreibrecht fuehrt der Knopf in den Editor');
});

test('Einkauf: die Leseansicht escaped Text selbst, nur der Link ist benanntes Markup', () => {
  einkaufZustand();
  const ansicht = (over) => withAccess({ shopping: 'read' }, () => shopping.itemReadHtml(artikel(over)));

  const voll = ansicht({ notes: '<i>bio</i>', url: 'https://example.org/?a=1&b=2' });
  assert.match(voll, /&lt;i&gt;bio&lt;\/i&gt;/, 'Nutzerdaten laufen durch esc()');
  assert.doesNotMatch(voll, /&amp;lt;/, 'und nur EINMAL - der Aufrufer escaped nicht mehr vor');
  assert.match(voll, /<a class="item-details__link" href="https:\/\/example\.org\/\?a=1&amp;b=2"/, 'der Link bleibt ein Link');
  assert.ok(voll.includes(readRowHtml({ icon: 'align-left', label: 'shopping.notesLabel', value: '<i>bio</i>', multiline: true })),
    'dieselben Zeichen wie der Baustein - keine eigene Kopie');
  // Eine Notiz aus Leerraum ist kein Wert: die Kopie pruefte `!valueHtml` und zeichnete die Zeile.
  assert.equal(zeilen(ansicht({ notes: '   ', url: 'https://example.org/?a=1&b=2' })), zeilen(voll) - 1);
});

// --------------------------------------------------------
// Vorrat
// --------------------------------------------------------

const vorrat = (over = {}) => ({
  id: 7, name: 'Hafermilch', quantity: 3, min_quantity: 2, unit: 'pcs', category: 'Getraenke',
  location_id: 4, location_name: 'Kellerregal', expires_on: '2027-02-24', notes: 'Nur die ungesuesste', ...over,
});

/** Der Zeilenknopf der Vorratszeile, als Knoten des Mini-DOM. */
function zeilenKnopf(el) {
  if (el.dataset?.action === 'details' || el.dataset?.action === 'edit') return el;
  for (const kind of el.childNodes ?? []) {
    const treffer = kind.childNodes ? zeilenKnopf(kind) : null;
    if (treffer) return treffer;
  }
  return null;
}

test('Vorrat bei `pantry: read`: der Zeilenknopf sagt, dass er die Details zeigt', () => {
  Object.assign(pantry.state, { items: [], locations: [], categories: [], filter: 'all', query: '' });
  const knopf = (modules) => withAccess(modules, () => zeilenKnopf(pantry.rowEl(vorrat())));

  for (const modules of [{ pantry: 'read', shopping: 'write' }, { pantry: 'read', shopping: 'read' }]) {
    const lesend = knopf(modules);
    assert.equal(lesend.dataset.action, 'details');
    const letzter = lesend.childNodes.at(-1);
    assert.match(letzter.outerHTML, HINWEIS, 'ohne Zusatz sagt die Zeile nur ihren Inhalt an');
    assert.match(lesend.outerHTML, /Hafermilch/, 'der Inhalt bleibt der Name der Zeile');
    assert.equal(lesend.attributes.get('aria-label'), undefined, 'kein aria-label: es ueberschriebe den Namen aus dem Inhalt');
    assert.doesNotMatch(lesend.outerHTML, /common\.edit/);
  }

  const schreibend = knopf({ pantry: 'write', shopping: 'write' });
  assert.equal(schreibend.dataset.action, 'edit');
  assert.match(schreibend.childNodes.at(-1).outerHTML, /<span class="sr-only">common\.edit<\/span>/,
    'Gegenfall: mit Schreibrecht steht „Bearbeiten"');
  assert.doesNotMatch(schreibend.outerHTML, /common\.showDetails/);
});

test('Vorrat: die Leseansicht baut ihre Zeilen ueber den geteilten Baustein', () => {
  const ansicht = (over) => withAccess({ pantry: 'read', shopping: 'read' }, () => pantry.itemReadHtml(vorrat(over)));

  const voll = ansicht({ notes: '<b>kalt</b> lagern' });
  assert.match(voll, /&lt;b&gt;kalt&lt;\/b&gt; lagern/, 'Nutzerdaten laufen durch esc()');
  assert.ok(voll.includes(readRowHtml({ icon: 'align-left', label: 'pantry.notesLabel', value: '<b>kalt</b> lagern', multiline: true })),
    'dieselben Zeichen wie der Baustein - keine eigene Kopie');
  // Eine Notiz aus Leerraum ist kein Wert: die Kopie pruefte `!value` und zeichnete die Zeile.
  assert.equal(zeilen(ansicht({ notes: '   ' })), zeilen(voll) - 1);
});

/* Schmales Telefon: pantry.css laesst das MHD in Zeilen mit Warenkorb weg, weil
 * dort Warenkorb UND Stepper die Textspalte auf 168px druecken. Die Lesezeile
 * hat keinen Stepper - die Regel traf sie trotzdem, und das Datum stand nur in
 * der Leseansicht. Gemessen an beiden Seiten: der Selektor verlangt den
 * Stepper, und der Renderer zeichnet ihn bei `read` nicht (das Datum aber
 * schon). Die Breiten selbst sieht nur ein Browser. */
test('Vorrat, schmale Zeile: das MHD faellt nur weg, wo auch ein Stepper steht', () => {
  const css = readFileSync(new URL('../public/styles/pantry.css', import.meta.url), 'utf8');
  const versteckt = [];
  for (const rule of eachRule(css)) {
    if (/\.pantry-row__expiry/.test(rule.selector) && /display:\s*none/.test(rule.body)) versteckt.push(rule.selector.trim());
  }
  assert.equal(versteckt.length, 1, `genau eine Regel blendet das MHD aus: ${versteckt.join(' | ')}`);
  assert.match(versteckt[0], /:has\(\.pantry-row__cart\)/, 'sie fragt nach dem Warenkorb');
  assert.match(versteckt[0], /:has\(\.pantry-stepper\)/, 'und nach dem Stepper - ohne ihn ist Platz');

  const knapp = vorrat({ quantity: 1, min_quantity: 5 });
  const zeile = (modules) => withAccess(modules, () => pantry.rowEl(knapp).outerHTML);
  const lesend = zeile({ pantry: 'read', shopping: 'write' });
  assert.match(lesend, /pantry-row__cart"/, 'die Lesezeile traegt den Warenkorb');
  assert.match(lesend, /pantry-row__expiry/, 'und das MHD');
  assert.doesNotMatch(lesend, /pantry-stepper/, 'aber keinen Stepper: die Regel trifft sie nicht');

  const schreibend = zeile({ pantry: 'write', shopping: 'write' });
  assert.match(schreibend, /pantry-row__cart"/);
  assert.match(schreibend, /class="pantry-stepper"/, 'Gegenfall: mit Schreibrecht stehen beide, die Regel greift weiter');
});
