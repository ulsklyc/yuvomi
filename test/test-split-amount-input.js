/**
 * Test: Betragseingabe der geteilten Ausgaben (#1607)
 * Zweck: Drei Befunde aus einem Durchlauf unter ko-KR/KRW.
 *        (1) `10.000` bei KRW ging als Zahl 10 durch die Rasterpruefung und als
 *            TEXT "10.000" an den Server, der englisch ablehnte. Geprueft wird
 *            jetzt die Schreibweise, und der Grund steht am Feld.
 *        (2) 0, negative und gruppierte Eingaben sperrten nur den Speichern-Knopf.
 *            Der Grund steht jetzt unter dem Betrag.
 *        (3) Die laufende Summe stand als `total.toFixed(2)` da, ohne Region und
 *            ohne Waehrung.
 *
 *        Gefahren werden die ECHTEN Wege: `validateSplitForm` ist der Lauscher des
 *        Formulars, und die Speicherwege laufen ueber `onSave` der Dialoge samt
 *        ihrem `submit`-Lauscher. Das DOM ist ein Nachbau aus Selektor -> Knoten;
 *        was gesendet wird, sieht `globalThis.__apiStub`, was am Feld gemeldet
 *        wird, `globalThis.__reportFieldError`.
 * Ausfuehren: npm run test:split-amount-input
 */
import test from 'node:test';
import assert from 'node:assert/strict';

globalThis.HTMLElement = globalThis.HTMLElement ?? class {};
globalThis.customElements = globalThis.customElements ?? { define() {}, get() {} };
globalThis.localStorage = globalThis.localStorage ?? { getItem: () => null, setItem() {}, removeItem() {} };

const { setPermissions, clearPermissions } = await import('../public/permissions.js');
const { __test: split } = await import('../public/pages/split-expenses.js');

/** Ein Knoten: Wert, Attribute, Lauscher. Mehr braucht die Seite hier nicht. */
function knoten(extra = {}) {
  const lauscher = {};
  const attribute = {};
  return {
    value: '', hidden: false, disabled: false, textContent: '', placeholder: '', checked: true,
    addEventListener(typ, fn) { (lauscher[typ] ??= []).push(fn); },
    removeEventListener() {},
    setAttribute(name, wert) { attribute[name] = String(wert); },
    getAttribute(name) { return attribute[name] ?? null; },
    removeAttribute(name) { delete attribute[name]; },
    closest() { return null; },
    focus() {},
    async feuere(typ, ereignis = {}) {
      for (const fn of lauscher[typ] ?? []) await fn({ preventDefault() {}, target: this, ...ereignis });
    },
    ...extra,
  };
}

/**
 * Ein Ausgaben- oder Zahlungsformular als Selektor -> Knoten. `teilnehmer` sind
 * die angehakten Mitglieder mit ihrem Aufteilungswert.
 */
function formular({ amount = '', currency = 'EUR', method = 'equal', teilnehmer = { 1: '', 3: '' }, formId = '#split-expense-form' } = {}) {
  const felder = {
    '[name="amount"]': knoten({ value: amount }),
    '[name="currency"]': knoten({ value: currency }),
    '[name="split_method"]': knoten({ value: method }),
    '[name="payer_id"]': knoten({ value: '1' }),
    '[name="payee_id"]': knoten({ value: '3' }),
    '#split-method-hint': knoten(),
    '#split-amount-reason': knoten({ hidden: true }),
    '#split-save-expense': knoten(),
    '#split-settlement-same': knoten({ hidden: true }),
  };
  const haken = Object.keys(teilnehmer).map((id) => knoten({ value: id, closest: () => null }));
  const werte = Object.entries(teilnehmer).map(([id, wert]) => {
    const feld = knoten({ value: wert });
    felder[`[name="split_value_${id}"]`] = feld;
    return feld;
  });
  const panel = {
    querySelector(sel) {
      if (sel === formId) return panel;
      return felder[sel] ?? null;
    },
    querySelectorAll(sel) {
      if (sel === 'input[name="participants"]:checked' || sel === 'input[name="participants"]') return haken;
      if (sel === '.split-split-value') return werte;
      return [];
    },
    ...knoten(),
    // Was `new FormData(form)` liefern wuerde: die benannten Felder.
    formDaten: () => ({ amount: felder['[name="amount"]'].value, currency: felder['[name="currency"]'].value, title: 'Abendessen' }),
  };
  return { panel, felder };
}

globalThis.FormData = class {
  constructor(form) { this.daten = form.formDaten(); }
  [Symbol.iterator]() { return Object.entries(this.daten)[Symbol.iterator](); }
};

function unter(locale, fn) {
  const vorher = globalThis.__formatLocale;
  globalThis.__formatLocale = locale;
  const fertig = () => { if (vorher === undefined) delete globalThis.__formatLocale; else globalThis.__formatLocale = vorher; };
  let ergebnis;
  try { ergebnis = fn(); } catch (err) { fertig(); throw err; }
  if (ergebnis && typeof ergebnis.then === 'function') return ergebnis.finally(fertig);
  fertig();
  return ergebnis;
}

/**
 * Oeffnet einen Dialog, verdrahtet ihn mit `panel` und schickt das Formular ab.
 * Liefert, was gesendet und was am Feld gemeldet wurde.
 */
async function speichern(oeffnen, panel, { currency = 'EUR' } = {}) {
  const vorherState = { ...split.state };
  Object.assign(split.state, {
    activeGroupId: 2, groups: [{ id: 2, name: 'Reise', default_currency: currency }],
    groupMembers: [{ id: 1, display_name: 'Alex' }, { id: 3, display_name: 'Emma' }],
    balances: { simplified_debts: [] }, user: { id: 1 },
    meta: { currencies: ['EUR', 'KRW', 'JPY'], default_currency: currency },
  });
  const gesendet = [];
  const gemeldet = [];
  let optionen = null;
  globalThis.__openModal = (opts) => { optionen = opts; };
  globalThis.__reportFieldError = (input, text) => { gemeldet.push({ input, text }); };
  // Nur das Schreiben zaehlt; das Nachladen danach darf ins Leere laufen.
  globalThis.__apiStub = {
    post: async (pfad, daten) => { gesendet.push({ pfad, daten }); return { data: {} }; },
    put: async (pfad, daten) => { gesendet.push({ pfad, daten }); return { data: {} }; },
    get: async () => ({ data: [] }),
  };
  setPermissions({ admin: false, modules: { budget: 'write' }, widgets: {}, capabilities: {} });
  try {
    oeffnen();
    assert.ok(optionen, 'der Dialog geht auf');
    optionen.onSave(panel);
    try { await panel.feuere('submit'); } catch { /* Neuzeichnen ohne Seitencontainer */ }
  } finally {
    clearPermissions();
    delete globalThis.__openModal;
    delete globalThis.__reportFieldError;
    delete globalThis.__apiStub;
    Object.assign(split.state, vorherState);
  }
  return { gesendet, gemeldet, optionen };
}

const neueAusgabe = () => split.openExpenseModal(null);

test('Gegenprobe: ein gueltiger Betrag wird gesendet, in der Schreibweise des Servers', async () => {
  await unter('de', async () => {
    const { panel } = formular({ amount: '12,50' });
    const { gesendet, gemeldet } = await speichern(neueAusgabe, panel);
    assert.equal(gemeldet.length, 0);
    assert.equal(gesendet.length, 1, 'ohne diesen Positivfall misst der Nachbau nichts');
    assert.equal(gesendet[0].daten.amount, '12.50');
  });
  await unter('ko-KR', async () => {
    const { panel } = formular({ amount: '10000', currency: 'KRW' });
    const { gesendet } = await speichern(neueAusgabe, panel, { currency: 'KRW' });
    assert.equal(gesendet[0]?.daten.amount, '10000');
  });
});

test('P2b: Nachkommastellen, die die Waehrung nicht kennt, bleiben am Feld und gehen nicht an den Server', async () => {
  // ko-KR liest den Punkt als Dezimaltrenner: "10.000" ist die Zahl 10 und passt
  // als ZAHL ins Raster von KRW. Gesendet wird aber der Text.
  await unter('ko-KR', async () => {
    const { panel, felder } = formular({ amount: '10.000', currency: 'KRW' });
    const { gesendet, gemeldet } = await speichern(neueAusgabe, panel, { currency: 'KRW' });
    assert.deepEqual(gesendet, [], 'nichts geht an den Server');
    assert.equal(gemeldet.length, 1);
    assert.equal(gemeldet[0].input, felder['[name="amount"]']);
    assert.equal(gemeldet[0].text, 'common.amountPrecisionRequired{"currency":"KRW","step":"1"}');
  });
  // Unter de-DE dasselbe mit dem Komma.
  await unter('de-DE', async () => {
    const { panel } = formular({ amount: '10,000', currency: 'KRW' });
    const { gesendet, gemeldet } = await speichern(neueAusgabe, panel, { currency: 'KRW' });
    assert.deepEqual(gesendet, []);
    assert.match(gemeldet[0]?.text ?? '', /^common\.amountPrecisionRequired/);
  });
  // Auch bei einer Waehrung MIT Nachkommastellen: 12,500 EUR ist als Zahl 12,5.
  await unter('de-DE', async () => {
    const { panel } = formular({ amount: '12,500', currency: 'EUR' });
    const { gesendet, gemeldet } = await speichern(neueAusgabe, panel);
    assert.deepEqual(gesendet, []);
    assert.match(gemeldet[0]?.text ?? '', /^common\.amountPrecisionRequired\{"currency":"EUR","step":"0\.01"\}/);
  });
});

test('P2b: die Genau-Betraege einer Aufteilung laufen durch dieselbe Pruefung', async () => {
  await unter('ko-KR', async () => {
    const { panel, felder } = formular({ amount: '20', currency: 'KRW', method: 'exact', teilnehmer: { 1: '10.000', 3: '10' } });
    const { gesendet, gemeldet } = await speichern(neueAusgabe, panel, { currency: 'KRW' });
    assert.deepEqual(gesendet, []);
    assert.equal(gemeldet[0]?.input, felder['[name="split_value_1"]']);
  });
});

test('P2b: eine Zahlung prueft den Betrag ebenfalls vor dem Senden', async () => {
  const zahlung = (amount) => formular({ amount, currency: 'KRW', formId: '#split-settlement-form' });
  await unter('ko-KR', async () => {
    const gut = await speichern(split.openSettlementModal, zahlung('10000').panel, { currency: 'KRW' });
    assert.equal(gut.gesendet[0]?.daten.amount, '10000', 'Positivfall');
    for (const [eingabe, grund] of [
      ['10.000', /^common\.amountPrecisionRequired/],
      ['10,000', /^common\.amountGrouped/],
      ['0', /^common\.amountNotPositive/],
      ['-5', /^common\.amountNotPositive/],
    ]) {
      const { gesendet, gemeldet } = await speichern(split.openSettlementModal, zahlung(eingabe).panel, { currency: 'KRW' });
      assert.deepEqual(gesendet, [], `"${eingabe}" geht nicht an den Server`);
      assert.match(gemeldet[0]?.text ?? '', grund, `"${eingabe}"`);
    }
  });
});

/** Der Grund unter dem Betrag, nachdem das Feld verlassen wurde. */
function grundNach(eingabe, currency = 'KRW') {
  const { panel, felder } = formular({ amount: eingabe, currency });
  const gueltig = split.validateSplitForm(panel, { reveal: true });
  const grund = felder['#split-amount-reason'];
  return { gueltig, gesperrt: felder['#split-save-expense'].disabled, text: grund.hidden ? '' : grund.textContent, felder, panel };
}

test('P2c: 0, negativ und gruppiert sperren das Speichern MIT Grund', () => {
  unter('ko-KR', () => {
    const ok = grundNach('10000');
    assert.equal(ok.gueltig, true);
    assert.equal(ok.gesperrt, false);
    assert.equal(ok.text, '', 'ein gueltiger Betrag traegt keinen Grund');

    for (const [eingabe, grund] of [
      ['0', /^common\.amountNotPositive$/],
      ['-5', /^common\.amountNotPositive$/],
      ['10,000', /^common\.amountGrouped\{"example":"1250"\}$/],
      ['abc', /^common\.amountInvalid\{"example":"1250"\}$/],
    ]) {
      const r = grundNach(eingabe);
      assert.equal(r.gesperrt, true, `"${eingabe}" sperrt`);
      assert.match(r.text, grund, `"${eingabe}" nennt den Grund`);
      assert.equal(r.felder['[name="amount"]'].getAttribute('aria-invalid'), 'true');
    }
  });
  // Die uebliche deutsche Schreibweise fuer zehntausend. Das Beispiel folgt
  // Region und Waehrung.
  unter('de-DE', () => {
    assert.match(grundNach('10.000', 'EUR').text, /^common\.amountGrouped\{"example":"1250,00"\}$/);
  });
});

test('P2c: der Grund erscheint erst nach dem Verlassen des Feldes und geht beim Korrigieren', () => {
  unter('ko-KR', () => {
    const { panel, felder } = formular({ amount: '0', currency: 'KRW' });
    const grund = felder['#split-amount-reason'];
    // Beim Tippen: "0" ist der Anfang von "0.5" - gesperrt, aber noch still.
    split.validateSplitForm(panel);
    assert.equal(felder['#split-save-expense'].disabled, true);
    assert.equal(grund.hidden, true, 'waehrend des Tippens kein Fehlertext');
    split.validateSplitForm(panel, { reveal: true });
    assert.equal(grund.hidden, false);
    // Steht er einmal da, folgt er der Eingabe ...
    felder['[name="amount"]'].value = '10,000';
    split.validateSplitForm(panel);
    assert.match(grund.textContent, /^common\.amountGrouped/);
    // ... und verschwindet mit dem Fehler.
    felder['[name="amount"]'].value = '10000';
    split.validateSplitForm(panel);
    assert.equal(grund.hidden, true);
    assert.equal(felder['[name="amount"]'].getAttribute('aria-invalid'), 'false');
  });
});

test('P2c: der Dialog verdrahtet das Verlassen des Betragsfeldes', async () => {
  await unter('ko-KR', async () => {
    const { panel, felder } = formular({ amount: '10,000', currency: 'KRW' });
    await speichern(neueAusgabe, panel, { currency: 'KRW' });
    assert.equal(felder['#split-amount-reason'].hidden, true, 'beim Oeffnen still');
    await felder['[name="amount"]'].feuere('change');
    assert.equal(felder['#split-amount-reason'].hidden, false);
    assert.match(felder['#split-amount-reason'].textContent, /^common\.amountGrouped/);
  });
});

test('P2c: das Markup traegt den Platz fuer den Grund', async () => {
  const { optionen } = await speichern(neueAusgabe, formular().panel);
  assert.match(optionen.content, /<input[^>]*name="amount"[^>]*aria-describedby="split-amount-reason"/);
  assert.match(optionen.content, /<p class="form-hint form-hint--danger" id="split-amount-reason" role="status" hidden><\/p>/);
});

test('P2d: die laufende Summe folgt Region und Waehrung', () => {
  const summe = (locale, opts) => unter(locale, () => {
    const { panel, felder } = formular(opts);
    split.validateSplitForm(panel);
    return felder['#split-method-hint'].textContent;
  });
  const total = (text) => JSON.parse(text.slice(text.indexOf('splitExpenses.splitCurrentTotal') + 'splitExpenses.splitCurrentTotal'.length)).total;

  // Genau-Betraege sind Geld in der Waehrung der Ausgabe.
  assert.equal(total(summe('de-DE', { amount: '100', method: 'exact', teilnehmer: { 1: '33', 3: '0,5' } })), '33,50 €');
  assert.equal(total(summe('ko-KR', { amount: '10000', currency: 'KRW', method: 'exact', teilnehmer: { 1: '3300', 3: '' } })), '₩3,300');
  // Prozente sind Prozente.
  assert.equal(total(summe('de-DE', { amount: '100', method: 'percentage', teilnehmer: { 1: '33', 3: '0,5' } })), '33,5 %');
  assert.equal(total(summe('en-US', { amount: '100', method: 'percentage', teilnehmer: { 1: '33', 3: '' } })), '33%');
});

test('P2d: die Summe der Standard-Aufteilung einer Gruppe ebenfalls', () => {
  unter('de-DE', () => {
    const hint = knoten();
    const zeilen = [knoten({ value: '33' }), knoten({ value: '0,5' })];
    const panel = {
      querySelector: (sel) => ({
        '[name="default_split_method"]': knoten({ value: 'percentage' }),
        '#split-default-hint': hint,
        '#split-save-group': knoten(),
      })[sel] ?? null,
      querySelectorAll: (sel) => (sel === '.split-default-value' ? zeilen : []),
    };
    split.updateGroupDefaults(panel);
    assert.equal(hint.textContent, 'splitExpenses.defaultSplitInvalid splitExpenses.splitCurrentTotal{"total":"33,5 %"}');
  });
});

test('Server-Fakten zu Genau-Anteilen: 0 und negativ lehnt er ab', async () => {
  // Daran haengt die Client-Regel darunter: sie darf nie nachsichtiger sein als
  // der Server. Ueber die Routen haelt das test:split-expenses-routes.
  const { buildSplits } = await import('../server/services/split-expenses.js');
  const genau = (a, b) => buildSplits({
    method: 'exact', amountMinor: 1000, currency: 'EUR', participants: [1, 3],
    splits: [{ user_id: 1, amount: a }, { user_id: 3, amount: b }],
  });
  assert.throws(() => genau('0', '10'), /split amount must be greater than zero/);
  assert.throws(() => genau('-5', '15'), /split amount must be greater than zero/);
  assert.deepEqual(genau('4', '6').map((r) => r.amount_minor), [400, 600]);
});

test('Genau-Anteile: negativ, 0 und leer bleiben am Feld, auch wenn die Summe stimmt', async () => {
  await unter('en-US', async () => {
    const gut = formular({ amount: '10', method: 'exact', teilnehmer: { 1: '4', 3: '6' } });
    const ok = await speichern(neueAusgabe, gut.panel);
    assert.equal(ok.gesendet.length, 1, 'Positivfall');
    assert.deepEqual(ok.gesendet[0].daten.splits, [{ user_id: 1, amount: '4' }, { user_id: 3, amount: '6' }]);

    for (const [a, b] of [['-5', '15'], ['0', '10'], ['', '10']]) {
      const { panel, felder } = formular({ amount: '10', method: 'exact', teilnehmer: { 1: a, 3: b } });
      const { gesendet, gemeldet } = await speichern(neueAusgabe, panel);
      assert.deepEqual(gesendet, [], `Anteil "${a}" geht nicht an den Server`);
      assert.equal(gemeldet[0]?.input, felder['[name="split_value_1"]'], `Anteil "${a}" am Feld`);
      assert.equal(gemeldet[0]?.text, 'common.amountNotPositive');
    }
  });
});

test('Bestandsschutz endet am Waehrungswechsel: 12.50 EUR, auf JPY umgestellt, bleibt am Feld', async () => {
  const bestand = (currency) => ({
    id: 5, title: 'Abendessen', amount: '12.50', currency, payer_id: 1, split_method: 'equal',
    splits: [{ user_id: 1, amount_minor: 625 }, { user_id: 3, amount_minor: 625 }], attachments: [],
  });
  await unter('en-US', async () => {
    // Unveraenderte Waehrung: der Altbetrag neben dem Raster bleibt speicherbar.
    const alt = await speichern(() => split.openExpenseModal(bestand('JPY')), formular({ amount: '12.50', currency: 'JPY' }).panel, { currency: 'JPY' });
    assert.equal(alt.gesendet[0]?.daten.amount, '12.50', 'Positivfall');

    const { panel, felder } = formular({ amount: '12.50', currency: 'JPY' });
    const { gesendet, gemeldet } = await speichern(() => split.openExpenseModal(bestand('EUR')), panel);
    assert.deepEqual(gesendet, []);
    assert.equal(gemeldet[0]?.input, felder['[name="amount"]']);
    assert.match(gemeldet[0]?.text ?? '', /^common\.amountPrecisionRequired\{"currency":"JPY"/);
  });
});

/**
 * Oeffnet einen Dialog und liefert sein Markup. `dabei` laeuft, solange der
 * Zustand der Seite steht - fuer Lauscher, die ihn beim Feuern lesen.
 */
async function geoeffnet(oeffnen, { currency = 'EUR', debts = [], panel = null, dabei = null } = {}) {
  const vorherState = { ...split.state };
  Object.assign(split.state, {
    activeGroupId: 2, groups: [{ id: 2, name: 'Reise', default_currency: currency }],
    groupMembers: [{ id: 1, display_name: 'Alex' }, { id: 3, display_name: 'Emma' }],
    balances: { simplified_debts: debts }, user: { id: 1 },
    meta: { currencies: ['EUR', 'KRW', 'JPY'], default_currency: currency },
  });
  let optionen = null;
  globalThis.__openModal = (opts) => { optionen = opts; };
  setPermissions({ admin: false, modules: { budget: 'write' }, widgets: {}, capabilities: {} });
  try {
    oeffnen();
    assert.ok(optionen, 'der Dialog geht auf');
    if (panel) optionen.onSave(panel);
    if (dabei) await dabei();
  } finally {
    clearPermissions();
    delete globalThis.__openModal;
    Object.assign(split.state, vorherState);
  }
  return optionen.content;
}

/** Der vorbelegte Wert eines Feldes im Markup. */
function vorbelegt(content, name) {
  const treffer = content.match(new RegExp(`<input[^>]*name="${name}"[^>]*\\svalue="([^"]*)"`));
  assert.ok(treffer, `Feld ${name} steht im Markup`);
  return treffer[1];
}

const bestandsAusgabe = (extra = {}) => ({
  id: 5, title: 'Abendessen', amount: '12.50', amount_minor: 1250, currency: 'EUR', payer_id: 1, split_method: 'equal',
  splits: [
    { user_id: 1, amount: '6.25', amount_minor: 625, currency: 'EUR' },
    { user_id: 3, amount: '6.25', amount_minor: 625, currency: 'EUR' },
  ],
  attachments: [], ...extra,
});

test('Bearbeiten belegt den Betrag in der Schreibweise der Region vor, nicht in der des Servers', async () => {
  // Der Server liefert "12.50". Das Feld daneben zeigt als Platzhalter "0,00" -
  // und stand trotzdem mit Punkt da.
  await unter('de', async () => {
    const content = await geoeffnet(() => split.openExpenseModal(bestandsAusgabe()));
    assert.match(content, /<input[^>]*name="amount"[^>]*placeholder="0,00"/, 'der Platzhalter macht die Schreibweise vor');
    assert.equal(vorbelegt(content, 'amount'), '12,50');
  });
  await unter('en-US', async () => {
    assert.equal(vorbelegt(await geoeffnet(() => split.openExpenseModal(bestandsAusgabe())), 'amount'), '12.50');
  });
  await unter('fa', async () => {
    assert.equal(vorbelegt(await geoeffnet(() => split.openExpenseModal(bestandsAusgabe())), 'amount'), '۱۲٫۵۰',
      'bis in die Ziffern, wie der Platzhalter');
  });
  await unter('de', async () => {
    const yen = bestandsAusgabe({ amount: '1300', amount_minor: 1300, currency: 'JPY' });
    assert.equal(vorbelegt(await geoeffnet(() => split.openExpenseModal(yen), { currency: 'JPY' }), 'amount'), '1300');
  });
});

test('Hin- und Rueckweg: der vorbelegte Betrag geht unveraendert wieder an den Server', async () => {
  for (const locale of ['de', 'en-US', 'fa', 'fr']) {
    await unter(locale, async () => {
      const ausgabe = bestandsAusgabe();
      const feld = vorbelegt(await geoeffnet(() => split.openExpenseModal(ausgabe)), 'amount');
      // Genau dieser Text steht im Feld, wenn nur der Titel geaendert wird.
      const { gesendet, gemeldet } = await speichern(() => split.openExpenseModal(ausgabe), formular({ amount: feld }).panel);
      assert.deepEqual(gemeldet, [], `${locale}: "${feld}" wird nicht abgewiesen`);
      assert.equal(gesendet[0]?.pfad, '/split-expenses/expenses/5');
      assert.equal(gesendet[0]?.daten.amount, '12.50', `${locale}: "${feld}"`);
    });
  }
});

test('Die Uebergabe aus dem Budget belegt den Betrag ebenfalls in der Schreibweise der Region vor', async () => {
  // budget.js reicht eine ZAHL herueber (12.5), keinen Text. Sie stand als "12.5"
  // im Feld - ohne die Stellen der Waehrung und mit dem falschen Trenner.
  await unter('de', async () => {
    const content = await geoeffnet(() => split.openExpenseModal(null, { title: 'Abendessen', amount: 12.5, currency: 'EUR' }));
    assert.equal(vorbelegt(content, 'amount'), '12,50');
  });
  // Ohne Vorbelegung bleibt das Feld leer und zeigt keine formatierte Null.
  await unter('de', async () => {
    assert.equal(vorbelegt(await geoeffnet(() => split.openExpenseModal(null)), 'amount'), '');
  });
});

test('Bearbeiten belegt auch die Genau-Betraege und Prozente in der Schreibweise der Region vor', async () => {
  await unter('de', async () => {
    const genau = await geoeffnet(() => split.openExpenseModal(bestandsAusgabe({ split_method: 'exact' })));
    assert.equal(vorbelegt(genau, 'split_value_1'), '6,25');
    assert.equal(vorbelegt(genau, 'split_value_3'), '6,25');

    const drittel = bestandsAusgabe({
      amount: '10.00', amount_minor: 1000, split_method: 'percentage',
      splits: [
        { user_id: 1, amount: '3.33', amount_minor: 333, currency: 'EUR' },
        { user_id: 3, amount: '6.67', amount_minor: 667, currency: 'EUR' },
      ],
    });
    const prozent = await geoeffnet(() => split.openExpenseModal(drittel));
    assert.equal(vorbelegt(prozent, 'split_value_1'), '33,3');
    assert.equal(vorbelegt(prozent, 'split_value_3'), '66,7');
    // Und die Formularpruefung liest sie wieder: die Summe ist 100.
    const { panel, felder } = formular({ amount: '10,00', method: 'percentage', teilnehmer: { 1: '33,3', 3: '66,7' } });
    assert.equal(split.validateSplitForm(panel), true);
    assert.equal(felder['#split-save-expense'].disabled, false);
  });
});

test('Eine Zahlung belegt die offene Schuld in der Schreibweise der Region vor und zieht sie beim Zahlerwechsel nach', async () => {
  const debts = [
    { from_user_id: 1, to_user_id: 3, amount: '12.50', amount_minor: 1250, currency: 'EUR' },
    { from_user_id: 3, to_user_id: 1, amount: '7.00', amount_minor: 700, currency: 'EUR' },
  ];
  await unter('de', async () => {
    const { panel, felder } = formular({ amount: '12,50', formId: '#split-settlement-form' });
    const content = await geoeffnet(split.openSettlementModal, {
      debts, panel,
      dabei: async () => {
        // Der Betrag ist noch der vorbelegte, also unberuehrt: der Zahlerwechsel
        // uebernimmt die Schuld des neuen Zahlers.
        felder['[name="payer_id"]'].value = '3';
        await felder['[name="payer_id"]'].feuere('change');
      },
    });
    assert.equal(vorbelegt(content, 'amount'), '12,50');
    assert.equal(felder['[name="amount"]'].value, '7,00');
    assert.equal(felder['[name="payee_id"]'].value, '1');
  });
});

test('Hin- und Rueckweg am Rand des Zahlenraums: unveraendert speichern zieht keinen Cent ab', async () => {
  // 90071992547409.91 EUR sind 9007199254740991 Cent, der groesste Betrag, den der
  // Server annimmt. Als Gleitkomma ist das 90071992547409.9.
  const gross = bestandsAusgabe({ amount: '90071992547409.91', amount_minor: 9007199254740991 });
  for (const locale of ['de', 'en-US', 'fa']) {
    await unter(locale, async () => {
      const feld = vorbelegt(await geoeffnet(() => split.openExpenseModal(gross)), 'amount');
      const { gesendet, gemeldet } = await speichern(() => split.openExpenseModal(gross), formular({ amount: feld }).panel);
      assert.deepEqual(gemeldet, [], `${locale}: "${feld}"`);
      assert.equal(gesendet[0]?.daten.amount, '90071992547409.91', `${locale}: "${feld}"`);
    });
  }
});
