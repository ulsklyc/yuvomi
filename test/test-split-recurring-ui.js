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
  const spur = { gesendet: [], fragen: [], dialoge: [], leseansichten: [], rueckfragen: [] };
  // Der Seitencontainer, in den das Neuzeichnen nach einem Schreibweg laeuft.
  _stumm = container ?? { querySelector: () => leer };
  split.renderMainForTest(_stumm);
  globalThis.__apiStub = {
    get: async (pfad) => (pfad.endsWith('/recurring') ? { data: split.state.recurring } : { data: [] }),
    post: async (pfad, daten) => { spur.gesendet.push(['POST', pfad, daten]); return { data: {} }; },
    put: async (pfad, daten) => { spur.gesendet.push(['PUT', pfad, daten]); return { data: {} }; },
    delete: async (pfad) => { spur.gesendet.push(['DELETE', pfad]); return { data: { ok: true } }; },
  };
  globalThis.__selectModal = async (titel, optionen) => {
    spur.fragen.push({ titel, optionen });
    return typeof auswahl === 'function' ? auswahl(optionen) : auswahl ?? null;
  };
  globalThis.__openModal = (opts) => { spur.dialoge.push(opts); };
  globalThis.__openDetailView = (opts) => { spur.leseansichten.push(opts); };
  globalThis.__confirmOverModal = async (frage, opts) => { spur.rueckfragen.push({ frage, opts }); return bestaetigt; };
  setPermissions({ admin: false, modules: { budget: modus }, widgets: {}, capabilities: {} });
  try {
    return await fn(spur);
  } finally {
    clearPermissions();
    for (const name of ['__apiStub', '__selectModal', '__openModal', '__openDetailView', '__confirmOverModal']) delete globalThis[name];
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
    assert.match(html, /data-recurring-toggle="11" aria-label="Miete - splitExpenses\.recurring\.pause"[^>]*>\s*<i data-lucide="pause"/);
    assert.match(html, /data-recurring-toggle="12" aria-label="Strom - splitExpenses\.recurring\.resume"[^>]*>\s*<i data-lucide="play"/);
    // Ohne `can_edit`: Leseansicht, kein Umschalter - die Regel kommt vom Server.
    assert.match(html, /<button type="button" class="split-expense" data-recurring-view="13">/);
    assert.doesNotMatch(html, /data-recurring-(id|toggle)="13"/);
    assert.match(html, /data-recurring-add/);
  });
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

test('Fortsetzen ohne versaeumte Termine fragt nichts und ueberspringt (Vorgabe)', async () => {
  await buehne({ recurring: [serie(12, { paused_at: '2026-08-01T00:00:00Z', missed_count: 0, resume_date: '2026-11-01' })] }, async (spur) => {
    await split.toggleRecurring(12);
    assert.deepEqual(spur.fragen, []);
    assert.deepEqual(spur.gesendet, [['POST', '/split-expenses/recurring/12/pause', { missed: 'skip' }]]);
  });
});

test('Fortsetzen mit versaeumten Terminen stellt EINE Frage: weiter ab dem naechsten Termin steht zuerst', async () => {
  await buehne({ auswahl: (optionen) => optionen[0].value }, async (spur) => {
    await split.onRecurringClick(klickAus(hauptteil(), 'data-recurring-toggle="12"'));
    assert.equal(spur.fragen.length, 1);
    assert.equal(spur.fragen[0].titel, 'splitExpenses.recurring.missedQuestion');
    assert.deepEqual(spur.fragen[0].optionen, [
      // Das Datum des Servers (`resume_date`), nicht ein hier nachgezaehltes.
      { value: 'skip', label: 'splitExpenses.recurring.missedSkip{"date":"2026-11-10"}' },
      { value: 'book', label: 'splitExpenses.recurring.missedBook{"date":"2026-09-10"}' },
    ]);
    assert.deepEqual(spur.gesendet, [['POST', '/split-expenses/recurring/12/pause', { missed: 'skip' }]]);
  });
});

test('Fortsetzen: "nachbuchen" sendet missed: book, Abbrechen sendet nichts', async () => {
  await buehne({ auswahl: 'book' }, async (spur) => {
    await split.toggleRecurring(12);
    assert.deepEqual(spur.gesendet, [['POST', '/split-expenses/recurring/12/pause', { missed: 'book' }]]);
  });
  await buehne({ auswahl: null }, async (spur) => {
    await split.toggleRecurring(12);
    assert.equal(spur.fragen.length, 1);
    assert.deepEqual(spur.gesendet, [], 'die Serie bleibt pausiert');
  });
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

/** Das Serienformular als Selektor -> Knoten; `werte` ist, was `new FormData(form)` liefern wuerde. */
function formular({ werte, method = 'equal', teilnehmer = { 1: '', 3: '' } }) {
  const felder = {
    '[name="amount"]': knoten({ value: werte.amount }),
    '[name="currency"]': knoten({ value: werte.currency }),
    '[name="split_method"]': knoten({ value: method }),
    '#split-method-hint': knoten(),
    '#split-amount-reason': knoten({ hidden: true }),
    '#split-save-recurring': knoten(),
    '#split-cancel-recurring': knoten(),
    '#split-delete-recurring': knoten(),
  };
  const haken = Object.keys(teilnehmer).map((id) => knoten({ value: id }));
  const felderJePerson = Object.entries(teilnehmer).map(([id, wert]) => {
    const feld = knoten({ value: wert });
    felder[`[name="split_value_${id}"]`] = feld;
    return feld;
  });
  const panel = {
    ...knoten(),
    querySelector: (sel) => (sel === '#split-recurring-form' ? panel : felder[sel] ?? null),
    querySelectorAll: (sel) => {
      if (sel === 'input[name="participants"]:checked' || sel === 'input[name="participants"]') return haken;
      if (sel === '.split-split-value') return felderJePerson;
      return [];
    },
    formDaten: () => ({ ...werte, split_method: method }),
  };
  return { panel, felder };
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

test('Speichern einer bestehenden Serie sendet PUT mit Beteiligten, Aufteilung und der unveraenderten Kategorie', async () => {
  await buehne({}, async (spur) => {
    split.openRecurringModal(MIETE);
    const { panel } = formular({
      werte: { title: 'Miete neu', amount: '950,00', currency: 'EUR', payer_id: '3', frequency: 'monthly', next_run_date: '2026-12-01', description: '' },
      method: 'shares', teilnehmer: { 1: '2', 3: '1' },
    });
    spur.dialoge[0].onSave(panel);
    await panel.feuere('submit');
    assert.equal(spur.gesendet.length, 1);
    const [methode, pfad, daten] = spur.gesendet[0];
    assert.deepEqual([methode, pfad], ['PUT', '/split-expenses/recurring/11']);
    assert.deepEqual(daten, {
      title: 'Miete neu', amount: '950.00', currency: 'EUR', payer_id: '3', frequency: 'monthly', next_run_date: '2026-12-01', description: '',
      split_method: 'shares', participants: [1, 3], splits: [{ user_id: 1, shares: 2 }, { user_id: 3, shares: 1 }], category: 'rent',
    });
  });
});

test('Speichern einer neuen Serie sendet POST an die Gruppe; ein unbrauchbarer Betrag sendet nichts', async () => {
  await buehne({}, async (spur) => {
    split.openRecurringModal();
    const { panel } = formular({ werte: { title: 'Strom', amount: '30', currency: 'EUR', payer_id: '1', frequency: 'weekly', next_run_date: '2026-11-05', description: '' } });
    spur.dialoge[0].onSave(panel);
    await panel.feuere('submit');
    assert.deepEqual(spur.gesendet.map(([m, p]) => [m, p]), [['POST', '/split-expenses/groups/2/recurring']]);
    assert.deepEqual(spur.gesendet[0][2].participants, [1, 3]);
    assert.equal('category' in spur.gesendet[0][2], false, 'eine neue Serie nennt keine Kategorie');
  });
  await buehne({}, async (spur) => {
    split.openRecurringModal();
    const { panel } = formular({ werte: { title: 'Strom', amount: '0', currency: 'EUR', payer_id: '1', frequency: 'weekly', next_run_date: '2026-11-05', description: '' } });
    spur.dialoge[0].onSave(panel);
    await panel.feuere('submit');
    assert.deepEqual(spur.gesendet, []);
  });
});

test('Loeschen fragt nach und sendet DELETE; "Abbrechen" sendet nichts', async () => {
  for (const bestaetigt of [true, false]) {
    await buehne({ bestaetigt }, async (spur) => {
      split.openRecurringModal(MIETE);
      const { panel, felder } = formular({ werte: { title: 'Miete', amount: '900,00', currency: 'EUR' } });
      spur.dialoge[0].onSave(panel);
      await felder['#split-delete-recurring'].feuere('click');
      assert.equal(spur.rueckfragen.length, 1);
      assert.equal(spur.rueckfragen[0].frage, 'splitExpenses.recurring.deleteConfirm');
      assert.equal(spur.rueckfragen[0].opts.danger, true);
      assert.equal(spur.rueckfragen[0].opts.detail, 'splitExpenses.recurring.deleteConfirmDetail');
      assert.deepEqual(spur.gesendet, bestaetigt ? [['DELETE', '/split-expenses/recurring/11']] : []);
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
