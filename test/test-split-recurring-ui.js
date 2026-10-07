/**
 * Test: Wiederkehrende geteilte Ausgaben in der App (#1647)
 * Zweck: Bis hierher zeigte die App die Serien einer Gruppe nirgends. Eine vom
 *        Buchungslauf pausierte Serie stand nur im Verlauf; fortsetzen, aendern
 *        oder loeschen liess sie sich allein ueber die API.
 *
 *        Gemessen wird:
 *        (1) die Liste samt Nur-lesen-Regel - Zustand bleibt (Titel, Betrag,
 *            Rhythmus, "Pausiert", der Grund), Handlung geht (Bearbeiten,
 *            Pausieren/Fortsetzen, Anlegen) bei `budget: read`, im Archiv und an
 *            einer Serie ohne `can_edit`;
 *        (2) der Klickweg `onRecurringClick` - der Lauscher, den `renderMain`
 *            an `#split-recurring-list` haengt - mit Klicks aus dem ECHTEN
 *            Markup, und der Riegel dahinter mit einem Klick, den das Markup
 *            gar nicht hergibt;
 *        (3) Pausieren/Fortsetzen: die EINE Frage nach versaeumten Terminen,
 *            ihre Vorgabe und was danach gesendet wird;
 *        (4) der Dialog: Vorbelegung aus der gespeicherten Eingabe, was Speichern
 *            und Loeschen senden;
 *        (5) der Verlaufseintrag "automatisch pausiert" fuehrt zur Serie.
 *
 *        Das DOM ist ein Nachbau aus Selektor -> Knoten (wie
 *        test-split-amount-input.js); gesendet wird ueber `globalThis.__apiStub`.
 * Ausfuehren: npm run test:split-recurring-ui
 */
import test from 'node:test';
import assert from 'node:assert/strict';

globalThis.HTMLElement = globalThis.HTMLElement ?? class {};
globalThis.customElements = globalThis.customElements ?? { define() {}, get() {} };
globalThis.localStorage = globalThis.localStorage ?? { getItem: () => null, setItem() {}, removeItem() {} };

const { installMiniDom } = await import('./mini-dom.js');
const miniDomAbraeumen = installMiniDom();

const { setPermissions, clearPermissions } = await import('../public/permissions.js');
const { __test: split } = await import('../public/pages/split-expenses.js');

test.after(() => miniDomAbraeumen());

const serie = (id, extra = {}) => ({
  id, group_id: 2, title: `Serie ${id}`, description: '', amount_minor: 90000, amount: '900.00', currency: 'EUR',
  payer_id: 1, payer_name: 'Alex', category: 'rent', split_method: 'equal', frequency: 'monthly',
  next_run_date: '2026-11-01', anchor_day: 1, paused_at: null, created_by: 1,
  participants: [1, 3], splits: [], blocked_reason: null, can_edit: true, missed_count: 0, resume_date: null,
  ...extra,
});

const MIETE = serie(11, { title: 'Miete' });
const STROM = serie(12, {
  title: 'Strom', paused_at: '2026-08-01T00:00:00Z', next_run_date: '2026-09-10', blocked_reason: 'not_a_member',
  missed_count: 2, resume_date: '2026-11-10', frequency: 'weekly',
});
const FREMD = serie(13, { title: 'Fremd', can_edit: false, created_by: 3 });

let _stumm = null;
const leer = {
  hidden: false, removeAttribute() {}, replaceChildren() {}, insertAdjacentHTML() {},
  querySelector: () => null, querySelectorAll: () => [], addEventListener() {},
};

/**
 * Stellt Gruppe, Serien und Recht her und raeumt danach alles ab. `fn` bekommt,
 * was gesendet, gefragt und geoeffnet wurde.
 */
async function buehne({ recurring = [MIETE, STROM, FREMD], modus = 'write', archiviert = false, activity = [], auswahl, bestaetigt = true, container = null } = {}, fn) {
  const vorher = { ...split.state };
  Object.assign(split.state, {
    activeGroupId: 2, groupStatus: archiviert ? 'archived' : 'active', user: { id: 1 },
    groups: [{ id: 2, name: 'WG', type: 'household', description: '', default_currency: 'EUR', default_split_method: 'equal' }],
    groupMembers: [{ id: 1, display_name: 'Alex' }, { id: 3, display_name: 'Emma' }],
    expenses: [], balances: { balances: [], simplified_debts: [] },
    meta: { currencies: ['EUR', 'JPY'], default_currency: 'EUR' },
    activity, activityCursor: null, activityGroupId: 2, activityLoadingMore: false,
    recurring,
  });
  const spur = { gesendet: [], gets: [], auswahldialoge: [], fragen: [], dialoge: [], leseansichten: [], rueckfragen: [], gemeldet: [], geschlossen: 0 };
  // Der Seitencontainer, in den das Neuzeichnen nach einem Schreibweg laeuft.
  _stumm = container ?? { querySelector: () => leer };
  split.renderMainForTest(_stumm);
  globalThis.__apiStub = {
    get: async (pfad) => { spur.gets.push(pfad); return pfad.endsWith('/recurring') ? { data: spur.server ?? split.state.recurring } : { data: [] }; },
    post: async (pfad, daten) => { spur.gesendet.push(['POST', pfad, daten]); return { data: {} }; },
    put: async (pfad, daten) => { spur.gesendet.push(['PUT', pfad, daten]); return { data: {} }; },
    delete: async (pfad) => { spur.gesendet.push(['DELETE', pfad]); return { data: { ok: true } }; },
  };
  // Der geteilte Auswahldialog ist hier nicht mehr im Spiel - meldet er sich
  // doch, soll der Fall rot werden statt still "abgebrochen" zu lesen.
  globalThis.__selectModal = async (titel) => { spur.auswahldialoge.push(titel); return null; };
  globalThis.__openModal = (opts) => {
    // Die Frage beim Fortsetzen ist ein eigener Dialog: seine Knoepfe kommen aus
    // dem gezeichneten Markup, und `auswahl` sagt, welcher Ausgang genommen wird
    // ('skip' | 'book' = dieser Knopf, 'abbrechen' = der Abbrechen-Knopf,
    // 'schliessen' = X/Escape/Overlay ueber onClose). Ohne `auswahl` bleibt sie offen.
    if (opts.title !== 'splitExpenses.recurring.missedQuestion') { spur.dialoge.push(opts); return; }
    const entschaerft = (text) => text.replace(/&quot;/g, '"');
    const knoepfe = [...opts.content.matchAll(/<button type="button" class="([^"]*)" data-resume="(\w+)">([^<]*)<\/button>/g)]
      .map(([, klasse, wert, text]) => ({ klasse, wert, text: entschaerft(text) }));
    const frage = {
      titel: opts.title, knoepfe, pointerDeadTime: opts.pointerDeadTime,
      satz: entschaerft(opts.content.match(/<p class="modal-confirm__detail" id="split-resume-detail">([^<]*)<\/p>/)?.[1] ?? ''),
      abbrechen: /<button type="button" class="btn btn--secondary" id="split-resume-cancel">common\.cancel<\/button>/.test(opts.content),
      markup: opts.content,
    };
    spur.fragen.push(frage);
    const klick = {};
    const knoten = (dataset = {}) => ({ dataset, addEventListener(typ, fn) { klick[dataset.resume ?? 'abbrechen'] = fn; } });
    const tasten = knoepfe.map((k) => knoten({ resume: k.wert }));
    const abbrechen = knoten();
    opts.onSave({ querySelectorAll: (sel) => (sel === '[data-resume]' ? tasten : []), querySelector: (sel) => (sel === '#split-resume-cancel' ? abbrechen : null) });
    frage.antworte = (wie) => (wie === 'schliessen' ? opts.onClose() : klick[wie]());
    if (auswahl) frage.antworte(auswahl);
  };
  globalThis.__closeModal = () => { spur.geschlossen += 1; };
  globalThis.__reportFieldError = (input, text) => { spur.gemeldet.push({ input, text }); };
  globalThis.__openDetailView = (opts) => { spur.leseansichten.push(opts); };
  globalThis.__confirmOverModal = async (frage, opts) => { spur.rueckfragen.push({ frage, opts }); return bestaetigt; };
  setPermissions({ admin: false, modules: { budget: modus }, widgets: {}, capabilities: {} });
  try {
    return await fn(spur);
  } finally {
    clearPermissions();
    for (const name of ['__apiStub', '__selectModal', '__openModal', '__openDetailView', '__confirmOverModal', '__closeModal', '__reportFieldError']) delete globalThis[name];
    Object.assign(split.state, vorher);
  }
}

/** Der Hauptteil, wie `renderMain` ihn zeichnet - samt dem, was es fuer Archiv und Recht entscheidet. */
function hauptteil() {
  const main = { html: '', removeAttribute() {}, replaceChildren() { this.html = ''; }, insertAdjacentHTML(_p, m) { this.html += m; }, querySelector: () => null, querySelectorAll: () => [] };
  split.renderMainForTest({ querySelector: (sel) => (sel === '#split-main' ? main : null) });
  // Zurueck auf den stummen Container: das Neuzeichnen nach einem Schreibweg
  // (renderAll) fragt Kopf und Gruppenliste, die dieser Griff nicht kennt.
  split.renderMainForTest(_stumm);
  return main.html.slice(main.html.indexOf('id="split-recurring-list"'), main.html.indexOf('class="split-activity"'));
}

/** Klick auf ein Element aus dem ECHTEN Markup - Attribute kommen von dort. */
function klickAus(html, muster) {
  const knopf = html.match(new RegExp(`<button [^>]*${muster}[^>]*>`));
  assert.ok(knopf, `kein Knopf ${muster} im Markup`);
  return klick(Object.fromEntries([...knopf[0].matchAll(/data-([\w-]+)(?:="([^"]*)")?/g)].map(([, name, wert]) => [name, wert ?? ''])));
}

/** Ein Klick mit diesen data-Attributen, ob das Markup sie hergibt oder nicht. */
function klick(attribute) {
  const dataset = Object.fromEntries(Object.entries(attribute).map(([name, wert]) => [name.replace(/-([a-z])/g, (_, c) => c.toUpperCase()), wert]));
  return {
    target: {
      closest: (sel) => (sel.split(',').some((teil) => teil.trim().replace(/^\[data-([\w-]+)\]$/, '$1') in attribute) ? { dataset } : null),
    },
  };
}

// --------------------------------------------------------------------------
// (1) Liste und Nur-lesen-Regel
// --------------------------------------------------------------------------
test('Schreibrecht: die eigene Serie laesst sich oeffnen und umschalten, die fremde nur lesen; Anlegen steht darunter', async () => {
  await buehne({}, () => {
    const html = hauptteil();
    assert.match(html, /<button type="button" class="split-expense" data-recurring-id="11" aria-label="Miete - splitExpenses\.recurring\.edit">/);
    assert.match(html, /aria-label="Miete - splitExpenses\.recurring\.pause" data-recurring-toggle="11"[^>]*>\s*<i data-lucide="pause"/);
    assert.match(html, /aria-label="Strom - splitExpenses\.recurring\.resume" data-recurring-toggle="12"[^>]*>\s*<i data-lucide="play"/);
    // Ohne `can_edit`: Leseansicht, kein Umschalter - die Regel kommt vom Server.
    assert.match(html, /<button type="button" class="split-expense" data-recurring-view="13">/);
    assert.doesNotMatch(html, /data-recurring-(id|toggle)="13"/);
    assert.match(html, /data-recurring-add/);
  });
});

// Critique R17: in der 300px-Spalte des Gruppenrasters blieben der Textspalte
// 68px - Titel gekappt, "Naechster Termin" dreizeilig, die Zeile 134px hoch und
// pausiert 98px, der Anlegen-Knopf 306px breit. Die Zeile stapelt jetzt (Titel
// / Betrag + Rhythmus / Termin oder Zustand), und der Umschalter ist die
// geteilte Zeilenaktion statt eines umrandeten 44px-Knopfes.
test('Der Umschalter ist die geteilte Zeilenaktion, in beiden Zustaenden derselbe Knopf', async () => {
  await buehne({}, () => {
    const html = hauptteil();
    for (const id of [11, 12]) {
      const knopf = html.match(new RegExp(`<button [^>]*data-recurring-toggle="${id}"[^>]*>`));
      assert.ok(knopf, `Umschalter ${id}`);
      assert.match(knopf[0], /^<button type="button" class="row-action split-recurring-toggle"/, `Umschalter ${id} ist eine .row-action`);
      assert.doesNotMatch(knopf[0], /\bbtn\b|btn--/, `Umschalter ${id} traegt keine Knopf-Kapsel`);
      assert.match(knopf[0], / title="splitExpenses\.recurring\.(pause|resume)"/, `Umschalter ${id} nennt seine Handlung auch dem Zeiger`);
    }
  });
});

test('Die Serienzeile traegt in der schmalen Spalte: Titel ungekappt, beide Zustaende gleich hoch, Anlegen in der Spalte', async () => {
  const { readFileSync } = await import('node:fs');
  const { eachRule } = await import('./css-rules.js');
  const regeln = [...eachRule(readFileSync(new URL('../public/styles/split-expenses.css', import.meta.url), 'utf8'))];
  const wert = (selektor, eigenschaft) => {
    let gefunden = null;
    for (const { selector, body } of regeln) {
      if (!String(selector).split(',').map((s) => s.trim()).includes(selektor)) continue;
      const m = new RegExp(`(?:^|;)\\s*${eigenschaft}\\s*:\\s*([^;]+)`).exec(body);
      if (m) gefunden = m[1].trim();
    }
    return gefunden;
  };
  // Der Titel: an der Ausgabenzeile einzeilig mit Ellipse, hier bricht er um.
  assert.equal(wert('.split-expense__body strong', 'white-space'), 'nowrap', 'Vorbedingung: die Ausgabenzeile kappt ihren Titel');
  assert.equal(wert('.split-recurring-row .split-expense__body strong', 'white-space'), 'normal', 'der Serientitel bricht um');
  assert.equal(wert('.split-recurring-row .split-expense__body strong', 'overflow'), 'visible', 'und wird nicht beschnitten');
  // Der Textblock loest sich auf; das Raster des Knopfes setzt seine Kinder.
  assert.equal(wert('.split-recurring-row > button.split-expense', 'display'), 'grid');
  assert.equal(wert('.split-recurring-row .split-expense__body', 'display'), 'contents');
  // Termin (blanker span) und "Pausiert" (Marke) stehen in derselben Zeile mit
  // demselben Blockpolster - sonst springt die Zeile beim Umschalten.
  const zustand = '.split-recurring-row .split-expense__body strong + span + span';
  assert.equal(wert(zustand, 'grid-row'), '3');
  assert.equal(wert(zustand, 'padding-block'), 'var(--space-0h)');
  let marke = null;
  for (const { selector, body } of regeln) {
    if (/\.split-recurring__state/.test(selector)) marke = /padding\s*:\s*([^;]+)/.exec(body)?.[1].trim() ?? marke;
  }
  assert.equal(marke, 'var(--space-0h) var(--space-2)', 'die Marke traegt dasselbe Blockpolster wie der Termin');
  // Der Anlegen-Knopf endet an der Spaltenkante.
  assert.equal(wert('.split-recurring-add', 'max-width'), '100%');
  assert.equal(wert('.split-recurring-add', 'white-space'), 'normal');
});

test('Zustand steht bei jedem Recht und im Archiv: Rhythmus, Termin, "Pausiert", der Grund, der Betrag', async () => {
  for (const lage of [{ modus: 'write' }, { modus: 'read' }, { modus: 'write', archiviert: true }, { modus: 'read', archiviert: true }]) {
    await buehne(lage, () => {
      const html = hauptteil();
      const name = JSON.stringify(lage);
      assert.match(html, /<strong>Miete<\/strong>/, name);
      assert.match(html, /<span>budget\.intervalMonthly<\/span>\s*<span>splitExpenses\.recurring\.nextDate: 2026-11-01<\/span>/, name);
      assert.match(html, /900,00\s€/, name);
      assert.match(html, /class="split-recurring-row split-recurring-row--paused"/, name);
      assert.match(html, /<span>budget\.intervalWeekly<\/span>\s*<span class="split-recurring__state">splitExpenses\.recurring\.paused<\/span>/, name);
      assert.match(html, /<span class="split-recurring__reason">splitExpenses\.recurring\.reason\.not_a_member<\/span>/, name);
      // Eine pausierte Serie nennt keinen "naechsten Termin": der stuende in der Vergangenheit.
      assert.doesNotMatch(html, /2026-09-10/, name);
    });
  }
});

test('`budget: read` und Archiv: keine Handlung - kein Bearbeiten, kein Umschalter, kein Anlegen', async () => {
  for (const lage of [{ modus: 'read' }, { modus: 'write', archiviert: true }, { modus: 'read', archiviert: true }]) {
    await buehne(lage, () => {
      const html = hauptteil();
      const name = JSON.stringify(lage);
      assert.doesNotMatch(html, /data-recurring-id|data-recurring-toggle|data-recurring-add|splitExpenses\.recurring\.(edit|pause|resume|add)\b/, name);
      for (const id of [11, 12, 13]) assert.match(html, new RegExp(`<button type="button" class="split-expense" data-recurring-view="${id}">`), name);
    });
  }
});

test('Keine Serien: der leere Zustand steht bei jedem Recht, Anlegen nur mit Schreibrecht', async () => {
  await buehne({ recurring: [] }, () => {
    const html = hauptteil();
    assert.match(html, /<div class="split-muted">splitExpenses\.recurring\.empty<\/div>/);
    assert.match(html, /data-recurring-add/);
  });
  await buehne({ recurring: [], modus: 'read' }, () => {
    const html = hauptteil();
    assert.match(html, /splitExpenses\.recurring\.empty/);
    assert.doesNotMatch(html, /data-recurring-add/);
  });
});

test('Der Titel einer Serie ist Nutzereingabe und geht durch esc()', async () => {
  await buehne({ recurring: [serie(20, { title: '<img src=x onerror=1>"' })] }, () => {
    const html = hauptteil();
    assert.doesNotMatch(html, /<img/);
    assert.match(html, /&lt;img src=x onerror=1&gt;&quot;/);
    // Auch in den Namen der beiden Knoepfe: ein Anfuehrungszeichen im Titel
    // schloesse sonst das Attribut.
    assert.match(html, /data-recurring-id="20" aria-label="&lt;img src=x onerror=1&gt;&quot; - splitExpenses\.recurring\.edit"/);
    assert.match(html, /aria-label="&lt;img src=x onerror=1&gt;&quot; - splitExpenses\.recurring\.pause" data-recurring-toggle="20"/);
  });
  const boese = serie(21, { title: 'a"b<i>', paused_at: '2026-08-01T00:00:00Z' });
  await buehne({ recurring: [boese], activity: [{ id: 71, type: 'recurring_auto_paused', entity_type: 'recurring_expense', entity_id: 21, created_at: '2026-09-10T03:00:00Z', metadata: { title: 'a"b<i>' } }] }, () => {
    assert.match(split.renderActivity(), /data-recurring-jump="21" aria-label="a&quot;b&lt;i&gt; - splitExpenses\.recurring\.show"/);
  });
});

// --------------------------------------------------------------------------
// (2) Klickweg und Riegel
// --------------------------------------------------------------------------
test('Klick auf die Zeile: eigene Serie oeffnet den Dialog, fremde die Leseansicht', async () => {
  await buehne({}, async (spur) => {
    const html = hauptteil();
    await split.onRecurringClick(klickAus(html, 'data-recurring-id="11"'));
    assert.equal(spur.dialoge.length, 1);
    assert.equal(spur.dialoge[0].title, 'splitExpenses.recurring.edit');
    assert.equal(spur.leseansichten.length, 0);

    await split.onRecurringClick(klickAus(html, 'data-recurring-view="13"'));
    assert.equal(spur.dialoge.length, 1, 'kein zweiter Dialog');
    assert.equal(spur.leseansichten.length, 1);
    assert.equal(spur.leseansichten[0].title, 'Fremd');
    assert.equal(spur.leseansichten[0].edit, undefined);
    assert.equal(spur.leseansichten[0].actions, undefined);

    await split.onRecurringClick(klickAus(html, 'data-recurring-add'));
    assert.equal(spur.dialoge.length, 2);
    assert.equal(spur.dialoge[1].title, 'splitExpenses.recurring.add');
  });
});

test('Der Riegel haengt nicht am Markup: ein Bearbeiten-Klick ohne Recht oeffnet die Leseansicht, Anlegen und Umschalten tun nichts', async () => {
  const lagen = [
    { name: 'budget: read', lage: { modus: 'read' }, id: '11' },
    { name: 'Archiv', lage: { archiviert: true }, id: '11' },
    { name: 'ohne can_edit', lage: {}, id: '13' },
  ];
  for (const { name, lage, id } of lagen) {
    await buehne(lage, async (spur) => {
      await split.onRecurringClick(klick({ 'recurring-id': id }));
      assert.equal(spur.dialoge.length, 0, `${name}: kein Dialog`);
      assert.equal(spur.leseansichten.length, 1, `${name}: Leseansicht`);
      await split.onRecurringClick(klick({ 'recurring-toggle': id }));
      assert.deepEqual(spur.gesendet, [], `${name}: nichts gesendet`);
      if (id === '11') {
        await split.onRecurringClick(klick({ 'recurring-add': '' }));
        assert.equal(spur.dialoge.length, 0, `${name}: kein Anlegen`);
      }
    });
  }
});

test('Leseansicht: was der Dialog zeigt, ohne Felder - samt Zustand und Aufteilung als Eingabe', async () => {
  await buehne({}, () => {
    const zeilen = Object.fromEntries(split.recurringReadSections(serie(30, {
      paused_at: '2026-08-01T00:00:00Z', blocked_reason: 'split_invalid', split_method: 'shares',
      splits: [{ user_id: 1, shares: 2 }, { user_id: 3, shares: 1 }], description: 'Dauerauftrag',
    })).map((z) => [z.label, z.value]));
    assert.match(zeilen['splitExpenses.amount'], /900,00\s€/);
    assert.equal(zeilen['splitExpenses.paidBy'], 'Alex');
    assert.equal(zeilen['budget.recurringIntervalLabel'], 'budget.intervalMonthly');
    assert.equal(zeilen['splitExpenses.recurring.nextDate'], '', 'pausiert: kein naechster Termin');
    assert.equal(zeilen['splitExpenses.statusLabel'], 'splitExpenses.recurring.paused · splitExpenses.recurring.reason.split_invalid');
    assert.equal(zeilen['splitExpenses.participants'], 'Alex: 2\nEmma: 1');
    assert.equal(zeilen['splitExpenses.notes'], 'Dauerauftrag');

    const laufend = Object.fromEntries(split.recurringReadSections(MIETE).map((z) => [z.label, z.value]));
    assert.equal(laufend['splitExpenses.recurring.nextDate'], '2026-11-01');
    assert.equal(laufend['splitExpenses.statusLabel'], '', 'laeuft: die Zeile faellt weg');
    assert.equal(laufend['splitExpenses.participants'], 'Alex\nEmma');
  });
});

// --------------------------------------------------------------------------
// (3) Pausieren / Fortsetzen
// --------------------------------------------------------------------------
test('Pausieren fragt nichts und sendet den Umschalter', async () => {
  await buehne({}, async (spur) => {
    await split.onRecurringClick(klickAus(hauptteil(), 'data-recurring-toggle="11"'));
    assert.deepEqual(spur.fragen, []);
    assert.deepEqual(spur.gesendet, [['POST', '/split-expenses/recurring/11/pause', {}]]);
  });
});

test('Nach dem Umschalten wird die Liste neu geladen: die Zeile zeigt, was der Server jetzt sagt', async () => {
  await buehne({}, async (spur) => {
    // Der Server antwortet nach dem Pausieren mit der pausierten Serie.
    spur.server = [{ ...MIETE, paused_at: '2026-10-06T10:00:00Z' }];
    await split.toggleRecurring(11);
    assert.equal(spur.gesendet.length, 1);
    assert.ok(spur.gets.includes('/split-expenses/groups/2/recurring'), 'die Serien werden neu geholt');
    assert.equal(split.state.recurring.length, 1);
    assert.ok(split.state.recurring[0].paused_at, 'der Stand der Seite ist der des Servers');
    assert.match(split.renderRecurring(), /aria-label="Miete - splitExpenses\.recurring\.resume" data-recurring-toggle="11"/, 'ein zweiter Klick wuerde fortsetzen, nicht noch einmal pausieren');
  });
  // Auch wenn der Aufruf scheitert (jemand war schneller): der Schirm zeigt danach den wirklichen Stand.
  await buehne({}, async (spur) => {
    spur.server = [];
    globalThis.__apiStub.post = async () => { throw new Error('409'); };
    await assert.rejects(split.toggleRecurring(11));
    assert.deepEqual(split.state.recurring, []);
  });
});

test('Nach dem Umschalten liegt der Fokus auf dem neu gezeichneten Umschalter dieser Serie', async () => {
  const knopf = { fokus: 0, focus() { this.fokus += 1; } };
  const gesucht = [];
  const container = { querySelector: (sel) => { gesucht.push(sel); return sel === '[data-recurring-toggle="11"]' ? knopf : leer; } };
  await buehne({ container }, async () => {
    await split.toggleRecurring(11);
    assert.ok(gesucht.includes('[data-recurring-toggle="11"]'));
    assert.equal(knopf.fokus, 1);
  });
});

test('Fortsetzen ohne versaeumte Termine fragt nichts und ueberspringt (Vorgabe)', async () => {
  // `auswahl: 'book'`: kaeme die Frage hier doch, wuerde sie beantwortet und der
  // Fall rot - statt an einem offenen Dialog zu haengen.
  await buehne({ auswahl: 'book', recurring: [serie(12, { paused_at: '2026-08-01T00:00:00Z', missed_count: 0, resume_date: '2026-11-01' })] }, async (spur) => {
    await split.toggleRecurring(12);
    assert.deepEqual(spur.fragen, []);
    assert.deepEqual(spur.gesendet, [['POST', '/split-expenses/recurring/12/pause', { missed: 'skip' }]]);
  });
});

test('Fortsetzen mit versaeumten Terminen stellt EINE Frage: ein Satz, zwei beschriftete Knoepfe, weiter ab dem naechsten Termin zuerst und als Hauptknopf', async () => {
  await buehne({ auswahl: 'skip' }, async (spur) => {
    await split.onRecurringClick(klickAus(hauptteil(), 'data-recurring-toggle="12"'));
    assert.equal(spur.fragen.length, 1);
    const frage = spur.fragen[0];
    assert.equal(frage.titel, 'splitExpenses.recurring.missedQuestion');
    // Wie viele seit wann - die Zahl geht als ZAHL an t(), sonst greift der Plural nicht.
    assert.equal(frage.satz, 'splitExpenses.recurring.missedDetail{"count":2,"date":"2026-09-10"}');
    assert.deepEqual(frage.knoepfe, [
      // Das Datum des Servers (`resume_date`), nicht ein hier nachgezaehltes.
      { klasse: 'btn btn--primary', wert: 'skip', text: 'splitExpenses.recurring.missedSkip{"date":"2026-11-10"}' },
      { klasse: 'btn btn--secondary', wert: 'book', text: 'splitExpenses.recurring.missedBook{"date":"2026-09-10"}' },
    ]);
    assert.equal(frage.abbrechen, true, 'ein Ausgang ohne Wirkung');
    assert.equal(frage.pointerDeadTime, true, 'eine Rueckfrage: ein Doppeltipp auf den Umschalter beantwortet sie nicht gleich mit');
    assert.match(frage.markup, /class="modal-actions modal-actions--stack split-resume-choices" role="group" aria-labelledby="split-resume-detail"/);
    assert.deepEqual(spur.auswahldialoge, [], 'nicht der Auswahldialog mit "Speichern"');
    assert.deepEqual(spur.gesendet, [['POST', '/split-expenses/recurring/12/pause', { missed: 'skip' }]]);
  });
});

test('Fortsetzen: nachgebucht wird nur ueber den zweiten Knopf; Abbrechen und Schliessen senden nichts', async () => {
  await buehne({ auswahl: 'book' }, async (spur) => {
    await split.toggleRecurring(12);
    assert.deepEqual(spur.gesendet, [['POST', '/split-expenses/recurring/12/pause', { missed: 'book' }]]);
  });
  for (const ausgang of ['abbrechen', 'schliessen']) {
    await buehne({ auswahl: ausgang }, async (spur) => {
      await split.toggleRecurring(12);
      assert.equal(spur.fragen.length, 1, ausgang);
      assert.deepEqual(spur.gesendet, [], `${ausgang}: die Serie bleibt pausiert`);
      assert.deepEqual(spur.gets, [], `${ausgang}: es gibt nichts neu zu laden`);
    });
  }
});

test('Die Frage wartet auf eine Antwort: ohne sie geht nichts hinaus, und eine zweite Antwort zaehlt nicht', async () => {
  await buehne({}, async (spur) => {
    const laeuft = split.toggleRecurring(12);
    await new Promise((r) => { setImmediate(r); });
    assert.deepEqual(spur.gesendet, [], 'offen: noch nichts gesendet');
    spur.fragen[0].antworte('skip');
    spur.fragen[0].antworte('book');
    await laeuft;
    assert.deepEqual(spur.gesendet, [['POST', '/split-expenses/recurring/12/pause', { missed: 'skip' }]]);
  });
});

test('Der Satz der Frage nennt die Zahl in der Einzahl und der Mehrzahl', async () => {
  for (const anzahl of [1, 6]) {
    await buehne({ recurring: [{ ...STROM, missed_count: anzahl }], auswahl: 'abbrechen' }, async (spur) => {
      await split.toggleRecurring(12);
      assert.equal(spur.fragen[0].satz, `splitExpenses.recurring.missedDetail{"count":${anzahl},"date":"2026-09-10"}`);
    });
  }
});

test('Ein zweiter Klick, waehrend der Umschalter unterwegs ist, sendet nicht noch einmal', async () => {
  await buehne({}, async (spur) => {
    // Beide Klicks laufen los, bevor der erste beantwortet ist; aufgeloest wird
    // von Hand, und zwar ALLES, damit ein toter Riegel hier rot wird statt zu haengen.
    const offen = [];
    globalThis.__apiStub.post = (pfad, daten) => { spur.gesendet.push(['POST', pfad, daten]); return new Promise((r) => { offen.push(r); }); };
    const erster = split.toggleRecurring(11);
    const zweiter = split.toggleRecurring(11);
    await new Promise((r) => { setImmediate(r); });
    const waehrenddessen = spur.gesendet.length;
    for (const loese of offen) loese({ data: {} });
    await Promise.all([erster, zweiter]);
    assert.equal(waehrenddessen, 1, 'zwei Aufrufe hoeben sich am Umschalter auf');
    globalThis.__apiStub.post = async (pfad, daten) => { spur.gesendet.push(['POST', pfad, daten]); return { data: {} }; };
    await split.toggleRecurring(11);
    assert.equal(spur.gesendet.length, 2, 'danach geht es wieder');
  });
});

// --------------------------------------------------------------------------
// (4) Dialog
// --------------------------------------------------------------------------
function knoten(extra = {}) {
  const lauscher = {};
  const attribute = {};
  return {
    value: '', hidden: false, disabled: false, textContent: '', placeholder: '', checked: true,
    addEventListener(typ, fn) { (lauscher[typ] ??= []).push(fn); },
    setAttribute(name, wert) { attribute[name] = String(wert); },
    getAttribute(name) { return attribute[name] ?? null; },
    closest() { return null; },
    focus() {},
    async feuere(typ) { for (const fn of lauscher[typ] ?? []) await fn({ preventDefault() {}, target: this }); },
    ...extra,
  };
}

/**
 * Das Serienformular als Selektor -> Knoten, vorbelegt wie der Dialog eine Serie
 * zeigt (`gezeigt`) oder leer fuer eine neue. Die Felder sind veraenderlich:
 * `setze` schreibt wie eine Eingabe, `new FormData(form)` liest den Stand von
 * JETZT. `haken[id].checked = false` hakt eine Person ab.
 */
function formular(werte, { method = 'equal', teilnehmer = { 1: '', 3: '' }, abgehakt = [] } = {}) {
  const namen = ['title', 'amount', 'currency', 'payer_id', 'frequency', 'next_run_date', 'description'];
  const felder = {
    '[name="split_method"]': knoten({ value: method }),
    '#split-method-hint': knoten(),
    '#split-amount-reason': knoten({ hidden: true }),
    '#split-save-recurring': knoten(),
    '#split-cancel-recurring': knoten(),
    '#split-delete-recurring': knoten(),
  };
  for (const name of namen) felder[`[name="${name}"]`] = knoten({ value: werte[name] ?? '' });
  const haken = Object.fromEntries(Object.keys(teilnehmer).map((id) => [id, knoten({ value: id, checked: !abgehakt.includes(Number(id)) })]));
  const felderJePerson = Object.entries(teilnehmer).map(([id, wert]) => {
    const feld = knoten({ value: wert });
    felder[`[name="split_value_${id}"]`] = feld;
    return feld;
  });
  const panel = {
    ...knoten(),
    querySelector: (sel) => (sel === '#split-recurring-form' ? panel : felder[sel] ?? null),
    querySelectorAll: (sel) => {
      if (sel === 'input[name="participants"]:checked') return Object.values(haken).filter((h) => h.checked);
      if (sel === 'input[name="participants"]') return Object.values(haken);
      if (sel === '.split-split-value') return felderJePerson;
      return [];
    },
    formDaten: () => Object.fromEntries([...namen, 'split_method'].map((name) => [name, felder[`[name="${name}"]`].value])),
  };
  const setze = (name, wert) => { felder[`[name="${name}"]`].value = wert; };
  return { panel, felder, haken, setze };
}

/** Was der Dialog fuer diese Serie in seine Felder schreibt (Region de). */
const gezeigt = (r) => ({
  title: r.title, amount: String(r.amount).replace('.', ','), currency: r.currency, payer_id: String(r.payer_id),
  frequency: r.frequency, next_run_date: r.next_run_date, description: r.description || '',
});

/** Oeffnet den Dialog der Serie, verdrahtet ihn mit einem Formular in ihrem gezeigten Stand. */
function offenerDialog(spur, r, optionen) {
  split.openRecurringModal(r);
  const f = formular(r ? gezeigt(r) : { title: '', amount: '', currency: 'EUR', payer_id: '1', frequency: 'monthly', next_run_date: '2026-10-06', description: '' }, optionen);
  spur.dialoge.at(-1).onSave(f.panel);
  return f;
}

globalThis.FormData = class {
  constructor(form) { this.daten = form.formDaten(); }
  [Symbol.iterator]() { return Object.entries(this.daten)[Symbol.iterator](); }
};

test('Dialog einer bestehenden Serie: vorbelegt aus der gespeicherten Eingabe, in der Schreibweise der Region', async () => {
  const anteile = serie(40, {
    title: 'Internet "Glasfaser"', amount: '49.90', amount_minor: 4990, split_method: 'percentage', frequency: 'yearly', next_run_date: '2027-01-31',
    participants: [1, 3], splits: [{ user_id: 1, percentage: '62.5' }, { user_id: 3, percentage: '37.5' }], description: 'Vertrag <b>',
  });
  await buehne({ recurring: [anteile] }, async (spur) => {
    split.openRecurringModal(anteile);
    const html = spur.dialoge[0].content;
    assert.match(html, /name="title" required maxlength="200" value="Internet &quot;Glasfaser&quot;"/);
    assert.match(html, /name="amount"[^>]*value="49,90"/);
    assert.match(html, /<option value="yearly" selected>budget\.intervalYearly<\/option>/);
    assert.match(html, /<yuvomi-datepicker name="next_run_date" type="date" value="2027-01-31">/);
    assert.match(html, /<option value="percentage" selected>/);
    assert.match(html, /name="split_value_1"[^>]*value="62,5"/);
    assert.match(html, /name="split_value_3"[^>]*value="37,5"/);
    assert.match(html, /Vertrag &lt;b&gt;/);
    assert.match(html, /id="split-delete-recurring"/);
    assert.match(html, /splitExpenses\.recurring\.editHint/);
  });
  assert.deepEqual(split.recurringSplitValues(serie(41, { split_method: 'exact', splits: [{ user_id: 1, amount: '12.50' }, { user_id: 3, amount: '7.5' }] })), { 1: '12,50', 3: '7,50' });
  assert.deepEqual(split.recurringSplitValues(serie(42, { split_method: 'shares', splits: [{ user_id: 1, shares: 2 }] })), { 1: '2' });
  assert.deepEqual(split.recurringSplitValues(serie(43, { split_method: 'equal', splits: [] })), {});
});

test('Der Dialog nennt den Zustand einer pausierten Serie; ein neuer hat weder Zustand noch Loeschen', async () => {
  await buehne({}, (spur) => {
    split.openRecurringModal(STROM);
    assert.match(spur.dialoge[0].content, /splitExpenses\.recurring\.paused · splitExpenses\.recurring\.reason\.not_a_member/);
    split.openRecurringModal();
    const neu = spur.dialoge[1].content;
    assert.doesNotMatch(neu, /split-delete-recurring|splitExpenses\.recurring\.(paused|editHint)/);
    assert.match(neu, /<option value="monthly" selected>/);
  });
});

test('Bearbeiten sendet NUR, was geaendert wurde: wer den Titel aendert, schickt weder Termin noch Rhythmus', async () => {
  await buehne({}, async (spur) => {
    const { panel, setze } = offenerDialog(spur, MIETE);
    // Der Dialog steht offen; inzwischen bucht der Lauf und rueckt die Serie weiter.
    split.state.recurring = [{ ...MIETE, next_run_date: '2026-12-01' }];
    setze('title', 'Miete neu');
    await panel.feuere('submit');
    assert.deepEqual(spur.gesendet, [['PUT', '/split-expenses/recurring/11', { title: 'Miete neu' }]],
      'kein next_run_date: der gezeigte 01.11. ginge sonst als Verlegung zurueck');
    assert.equal(spur.geschlossen, 1);
  });
});

test('Bearbeiten: je Feld nur dieses Feld - und was zusammen gilt, reist zusammen', async () => {
  const anteile = serie(50, { split_method: 'shares', splits: [{ user_id: 1, shares: 2 }, { user_id: 3, shares: 1 }] });
  const faelle = [
    ['Termin', (f) => f.setze('next_run_date', '2026-12-15'), { next_run_date: '2026-12-15' }],
    ['Rhythmus', (f) => f.setze('frequency', 'yearly'), { frequency: 'yearly' }],
    ['Zahler', (f) => f.setze('payer_id', '3'), { payer_id: '3' }],
    ['Notiz', (f) => f.setze('description', 'neu'), { description: 'neu' }],
    ['Betrag reist mit Waehrung', (f) => f.setze('amount', '950,00'), { amount: '950.00', currency: 'EUR' }],
    ['Waehrung reist mit Betrag', (f) => f.setze('currency', 'JPY'), { amount: '900.00', currency: 'JPY' }],
    ['Anteil', (f) => { f.felder['[name="split_value_3"]'].value = '4'; },
      { split_method: 'shares', participants: [1, 3], splits: [{ user_id: 1, shares: 2 }, { user_id: 3, shares: 4 }] }],
    ['abgehakt', (f) => { f.haken[3].checked = false; }, { split_method: 'shares', participants: [1], splits: [{ user_id: 1, shares: 2 }] }],
    ['Aufteilungsart', (f) => f.setze('split_method', 'equal'), { split_method: 'equal', participants: [1, 3], splits: [] }],
  ];
  for (const [name, aendere, erwartet] of faelle) {
    await buehne({ recurring: [anteile] }, async (spur) => {
      const f = offenerDialog(spur, anteile, { method: 'shares', teilnehmer: { 1: '2', 3: '1' } });
      aendere(f);
      // JPY kennt keine Nachkommastellen: der Bestandsbetrag bleibt speicherbar, der Server urteilt.
      await f.panel.feuere('submit');
      if (name === 'Waehrung reist mit Betrag') { assert.equal(spur.gesendet.length, 0, 'der Betrag passt nicht ins Raster von JPY'); return; }
      assert.deepEqual(spur.gesendet, [['PUT', '/split-expenses/recurring/50', erwartet]], name);
    });
  }
});

test('Bearbeiten ohne Aenderung sendet nichts und schliesst', async () => {
  await buehne({}, async (spur) => {
    const { panel } = offenerDialog(spur, MIETE);
    await panel.feuere('submit');
    assert.deepEqual(spur.gesendet, []);
    assert.equal(spur.geschlossen, 1);
  });
});

test('Wer die Gruppe verlassen hat, hat kein Haekchen mehr: Speichern schreibt die Beteiligten, die der Dialog zeigt', async () => {
  const mitEhemaligem = serie(51, { participants: [1, 3, 99], blocked_reason: 'not_a_member' });
  await buehne({ recurring: [mitEhemaligem] }, async (spur) => {
    const { panel, setze } = offenerDialog(spur, mitEhemaligem);
    setze('title', 'Repariert');
    await panel.feuere('submit');
    assert.deepEqual(spur.gesendet[0][2], { title: 'Repariert', split_method: 'equal', participants: [1, 3], splits: [] });
  });
});

test('Ein ausgetretener Zahler bleibt vorbelegt und gekennzeichnet; gespeichert wird erst mit einem anderen', async () => {
  const zahlerWeg = serie(52, { payer_id: 9, payer_name: 'Zoe <b>', blocked_reason: 'not_a_member' });
  await buehne({ recurring: [zahlerWeg] }, async (spur) => {
    const { panel, felder, setze } = offenerDialog(spur, zahlerWeg);
    const auswahl = spur.dialoge[0].content.match(/<select class="form-input" name="payer_id">([\s\S]*?)<\/select>/)[1];
    assert.match(auswahl, /^<option value="9" selected>Zoe &lt;b&gt; \(settings\.memberFormerBadge\)<\/option>/, 'er steht zuerst und ist gewaehlt');
    assert.equal((auswahl.match(/ selected/g) ?? []).length, 1, 'kein Mitglied ist daneben vorgewaehlt');

    setze('title', 'Nur der Titel');
    await panel.feuere('submit');
    assert.deepEqual(spur.gesendet, [], 'kein stiller Zahlerwechsel, und kein Aufruf, den der Server englisch abwiese');
    assert.deepEqual(spur.gemeldet.map((m) => [m.input === felder['[name="payer_id"]'], m.text]), [[true, 'splitExpenses.recurring.reason.not_a_member']]);
    assert.equal(spur.geschlossen, 0);

    setze('payer_id', '3');
    await panel.feuere('submit');
    assert.deepEqual(spur.gesendet, [['PUT', '/split-expenses/recurring/52', { title: 'Nur der Titel', payer_id: '3' }]]);
  });
  // Ein Zahler, der Mitglied ist, bekommt keine zweite Option.
  await buehne({}, (spur) => {
    split.openRecurringModal(MIETE);
    assert.doesNotMatch(spur.dialoge[0].content, /memberFormerBadge/);
  });
});

test('Der Server weist einen schon gebuchten Termin ab: der Satz steht am Datumsfeld, der Dialog bleibt offen', async () => {
  await buehne({}, async (spur) => {
    const { panel, felder, setze } = offenerDialog(spur, MIETE);
    globalThis.__apiStub.put = async () => {
      throw Object.assign(new Error('next_run_date must be after the last booked date (2026-11-01).'),
        { status: 400, data: { reason: 'next_run_not_after_last_booking', last_booked: '2026-11-01' } });
    };
    setze('next_run_date', '2026-10-15');
    await panel.feuere('submit');
    assert.deepEqual(spur.gemeldet.map((m) => [m.input === felder['[name="next_run_date"]'], m.text]),
      [[true, 'splitExpenses.recurring.dateBooked{"date":"2026-11-01"}']]);
    assert.equal(spur.geschlossen, 0, 'der Dialog bleibt, die Eingabe auch');
    // Danach laesst sich wieder speichern (der Riegel gegen Doppelabsenden ist frei).
    globalThis.__apiStub.put = async (pfad, daten) => { spur.gesendet.push(['PUT', pfad, daten]); return { data: {} }; };
    setze('next_run_date', '2026-11-15');
    await panel.feuere('submit');
    assert.equal(spur.gesendet.length, 1);
  });
  // Jede andere Absage geht weiter an die globale Meldung.
  await buehne({}, async (spur) => {
    const { panel, setze } = offenerDialog(spur, MIETE);
    globalThis.__apiStub.put = async () => { throw Object.assign(new Error('All participants must be group members.'), { status: 400, data: {} }); };
    setze('title', 'x');
    await assert.rejects(panel.feuere('submit'), /group members/);
    assert.deepEqual(spur.gemeldet, []);
  });
});

test('Speichern einer neuen Serie sendet POST mit allen Feldern der Route; ein unbrauchbarer Betrag sendet nichts', async () => {
  await buehne({}, async (spur) => {
    const { panel, setze } = offenerDialog(spur, null);
    setze('title', 'Strom'); setze('amount', '30'); setze('frequency', 'weekly'); setze('next_run_date', '2026-11-05');
    await panel.feuere('submit');
    assert.deepEqual(spur.gesendet, [['POST', '/split-expenses/groups/2/recurring', {
      title: 'Strom', amount: '30', currency: 'EUR', payer_id: '1', frequency: 'weekly', next_run_date: '2026-11-05',
      split_method: 'equal', description: '', participants: [1, 3], splits: [],
    }]]);
  });
  await buehne({}, async (spur) => {
    const { panel, setze } = offenerDialog(spur, null);
    setze('title', 'Strom'); setze('amount', '0');
    await panel.feuere('submit');
    assert.deepEqual(spur.gesendet, []);
  });
});

test('Zweimal Enter legt EINE Serie an', async () => {
  await buehne({}, async (spur) => {
    const { panel, setze } = offenerDialog(spur, null);
    setze('title', 'Strom'); setze('amount', '30');
    const offen = [];
    globalThis.__apiStub.post = (pfad, daten) => { spur.gesendet.push(['POST', pfad, daten]); return new Promise((r) => { offen.push(r); }); };
    const erster = panel.feuere('submit');
    const zweiter = panel.feuere('submit');
    await new Promise((r) => { setImmediate(r); });
    const waehrenddessen = spur.gesendet.length;
    for (const loese of offen) loese({ data: {} });
    await Promise.all([erster, zweiter]);
    assert.equal(waehrenddessen, 1);
    assert.equal(spur.gesendet.length, 1);
  });
});

test('Loeschen fragt nach und sendet DELETE; "Abbrechen" sendet nichts', async () => {
  for (const bestaetigt of [true, false]) {
    await buehne({ bestaetigt }, async (spur) => {
      const { felder } = offenerDialog(spur, MIETE);
      await felder['#split-delete-recurring'].feuere('click');
      assert.equal(spur.rueckfragen.length, 1);
      assert.equal(spur.rueckfragen[0].frage, 'splitExpenses.recurring.deleteConfirm');
      assert.equal(spur.rueckfragen[0].opts.danger, true);
      assert.equal(spur.rueckfragen[0].opts.detail, 'splitExpenses.recurring.deleteConfirmDetail');
      assert.deepEqual(spur.gesendet, bestaetigt ? [['DELETE', '/split-expenses/recurring/11']] : []);
    });
  }
});

// Der Riegel am ANDEREN Ende: der Dialog steht offen, und was ihn erlaubt hat,
// faellt weg. Speichern und Loeschen fragen die Serie, wie sie JETZT in der
// Liste steht - nicht die von beim Oeffnen.
const wegfall = {
  'das Recht faellt auf read': () => setPermissions({ admin: false, modules: { budget: 'read' }, widgets: {}, capabilities: {} }),
  'die Gruppe wird archiviert': () => { split.state.groupStatus = 'archived'; },
  'can_edit faellt (die Liste wurde neu geladen)': () => { split.state.recurring = [{ ...MIETE, can_edit: false }]; },
  'die Serie ist inzwischen geloescht': () => { split.state.recurring = []; },
};

test('Offener Dialog, Recht faellt weg: Speichern sendet nichts', async () => {
  for (const [name, faelle] of Object.entries(wegfall)) {
    await buehne({}, async (spur) => {
      const { panel, setze } = offenerDialog(spur, MIETE);
      setze('title', 'Zu spaet');
      faelle();
      await panel.feuere('submit');
      assert.deepEqual(spur.gesendet, [], name);
      assert.equal(spur.geschlossen, 0, name);
    });
  }
  // Der Dialog einer NEUEN Serie: Recht und Archiv.
  for (const name of ['das Recht faellt auf read', 'die Gruppe wird archiviert']) {
    await buehne({}, async (spur) => {
      const { panel, setze } = offenerDialog(spur, null);
      setze('title', 'Strom'); setze('amount', '30');
      wegfall[name]();
      await panel.feuere('submit');
      assert.deepEqual(spur.gesendet, [], `neu: ${name}`);
    });
  }
});

test('Offener Dialog, Recht faellt weg: Loeschen fragt nicht einmal und sendet nichts - auch nicht, wenn es waehrend der Rueckfrage faellt', async () => {
  for (const [name, faelle] of Object.entries(wegfall)) {
    await buehne({}, async (spur) => {
      const { felder } = offenerDialog(spur, MIETE);
      faelle();
      await felder['#split-delete-recurring'].feuere('click');
      assert.deepEqual([spur.rueckfragen.length, spur.gesendet.length], [0, 0], name);
    });
    await buehne({}, async (spur) => {
      const { felder } = offenerDialog(spur, MIETE);
      globalThis.__confirmOverModal = async () => { faelle(); return true; };
      await felder['#split-delete-recurring'].feuere('click');
      assert.deepEqual(spur.gesendet, [], `waehrend der Rueckfrage: ${name}`);
    });
  }
});

// --------------------------------------------------------------------------
// (5) Der Verlauf fuehrt zur Serie
// --------------------------------------------------------------------------
const autoPause = (entityId) => ({
  id: 70, type: 'recurring_auto_paused', entity_type: 'recurring_expense', entity_id: entityId, actor_name: null,
  created_at: '2026-09-10T03:00:00Z', metadata: { title: 'Strom', reason: 'not_a_member' },
});

test('"Automatisch pausiert" fuehrt zur Serie - bei jedem Recht und im Archiv, solange es sie gibt', async () => {
  for (const lage of [{ modus: 'write' }, { modus: 'read' }, { modus: 'write', archiviert: true }]) {
    await buehne({ ...lage, activity: [autoPause(12)] }, () => {
      assert.match(split.renderActivity(), /<button type="button" class="btn btn--secondary split-reverse-payment" data-recurring-jump="12" aria-label="Strom - splitExpenses\.recurring\.show">splitExpenses\.recurring\.show<\/button>/, JSON.stringify(lage));
    });
  }
  // Die Serie ist inzwischen geloescht: der Eintrag bleibt, der Knopf faellt.
  await buehne({ activity: [autoPause(99)] }, () => {
    const html = split.renderActivity();
    assert.match(html, /splitExpenses\.activityType\.recurring_auto_paused/);
    assert.doesNotMatch(html, /data-recurring-jump/);
  });
});

test('Der Klick im Verlauf holt die Zeile der Serie in den Blick und gibt ihr den Fokus', async () => {
  const gesucht = [];
  const zeile = { geholt: 0, fokus: 0, scrollIntoView() { this.geholt += 1; }, focus() { this.fokus += 1; } };
  const container = { querySelector: (sel) => { gesucht.push(sel); return sel.includes('data-recurring-id="12"') ? zeile : leer; } };
  await buehne({ activity: [autoPause(12)], container }, async () => {
    await split.onActivityClick(klickAus(split.renderActivity(), 'data-recurring-jump="12"'));
    assert.ok(gesucht.includes('[data-recurring-id="12"], [data-recurring-view="12"]'), 'beide Formen der Zeile');
    assert.deepEqual([zeile.geholt, zeile.fokus], [1, 1]);
  });
});
