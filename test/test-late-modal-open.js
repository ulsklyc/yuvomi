/**
 * Tests: ein Dialog, der erst nach einer Antwort aufgeht, verdraengt keinen
 * anderen (#1997, #2134)
 * Module: public/components/budget-transfer-dialog.js,
 *         public/components/quick-links-manager.js, public/pages/birthdays.js,
 *         calendar.js, contacts.js, documents.js, inventory.js, pantry.js,
 *         recipes.js, rewards.js, shopping.js, split-expenses.js, waste.js,
 *         public/settings/pages/admin-family.js, modules-health.js,
 *         modules-install.js, modules-rewards.js
 *
 * DAS MUSTER: Viele Dialoge laden erst etwas (den vollen Kontakt, die
 * Kandidaten, den Vorrat, eine Komponente) und oeffnen dann. `openModal()`
 * schliesst dabei, was im einzigen Modal-Slot liegt, mit force - hat der Nutzer
 * waehrend des Ladens einen anderen Dialog geoeffnet, sind dessen Eingaben weg;
 * hat er die Seite verlassen, geht der Dialog dort auf. Jeder dieser Wege haelt
 * deshalb den Kontext VOR der Anfrage fest (`captureModalContext()`) und
 * oeffnet nur, wenn er danach noch gilt (`isModalContextCurrent()`).
 *
 * WIE GEMESSEN WIRD: Der Loader-Stub von components/modal.js liest den Kontext
 * aus `__modalContextId`. Jeder Fall ruft den ECHTEN Oeffner, stellt den Kontext
 * um, solange dessen erstes `await` laeuft (das ist "der Nutzer hat inzwischen
 * etwas anderes geoeffnet"), und zaehlt die `openModal()`-Aufrufe. Die
 * Gegenprobe ohne Umstellen muss genau einmal oeffnen - sonst haette der Fall
 * den Weg gar nicht erreicht und waere gruen ueber nichts.
 *
 * Die Ratsche dazu (der Bestand im Quelltext) steht in test-frontend-audit.js,
 * der Scanner in test/late-modal-close.js.
 *
 * Ausfuehren: npm run test:late-modal-open
 */
import test from 'node:test';
import assert from 'node:assert/strict';

globalThis.HTMLElement = globalThis.HTMLElement ?? class {};
globalThis.customElements = globalThis.customElements ?? { define() {}, get() {} };
globalThis.localStorage = globalThis.localStorage ?? { getItem: () => null, setItem() {}, removeItem() {}, clear() {} };
const { installMiniDom } = await import('./mini-dom.js');
installMiniDom();
globalThis.window.yuvomi = { ...globalThis.window.yuvomi, showToast() {} };
globalThis.window.matchMedia = globalThis.window.matchMedia
  ?? (() => ({ matches: false, addEventListener() {}, removeEventListener() {} }));

const { openTransferDialog } = await import('../public/components/budget-transfer-dialog.js');
const { openQuickLinksManager } = await import('../public/components/quick-links-manager.js');
const { __test: birthdays } = await import('../public/pages/birthdays.js');
const { __test: calendar } = await import('../public/pages/calendar.js');
const { __test: contacts } = await import('../public/pages/contacts.js');
const { __test: inventory } = await import('../public/pages/inventory.js');
const { __test: pantry } = await import('../public/pages/pantry.js');
const { __test: recipes } = await import('../public/pages/recipes.js');
const { __test: rewards } = await import('../public/pages/rewards.js');
const { __test: shopping } = await import('../public/pages/shopping.js');
const { __test: split } = await import('../public/pages/split-expenses.js');
const { __test: waste } = await import('../public/pages/waste.js');
const { __test: family } = await import('../public/settings/pages/admin-family.js');
const { __test: health } = await import('../public/settings/pages/modules-health.js');
const { __test: documents } = await import('../public/pages/documents.js');
const { __test: install } = await import('../public/settings/pages/modules-install.js');
const { bindDefaultPoints } = await import('../public/settings/pages/modules-rewards.js');

/**
 * Faehrt einen Oeffner zweimal: einmal ruhig (er muss genau einmal oeffnen),
 * einmal mit einem Kontextwechsel waehrend seines ersten `await` (er darf nicht
 * oeffnen).
 */
async function faehre(name, { api = {}, oeffne }) {
  for (const wechsel of [false, true]) {
    let kontext = 'vor-der-anfrage';
    const geoeffnet = [];
    globalThis.__modalContextId = () => kontext;
    globalThis.__openModal = (opts) => { geoeffnet.push(opts?.title); };
    globalThis.__apiStub = { get: async () => ({ data: [] }), ...api };
    try {
      const lauf = oeffne();
      // Der Oeffner steht jetzt an seinem ersten await - was jetzt passiert,
      // passiert "waehrend des Ladens".
      if (wechsel) kontext = 'ein-anderer-dialog';
      await lauf;
      if (wechsel) {
        assert.deepEqual(geoeffnet, [],
          `${name}: oeffnet nach dem Laden, obwohl inzwischen ein anderer Dialog offen ist - er wuerde ihn verdraengen`);
      } else {
        assert.equal(geoeffnet.length, 1, `${name}: ohne Wechsel muss der Dialog aufgehen (${JSON.stringify(geoeffnet)})`);
      }
    } finally {
      delete globalThis.__modalContextId;
      delete globalThis.__openModal;
      delete globalThis.__apiStub;
    }
  }
}

test('#1997: Umbuchung bearbeiten - laedt erst, oeffnet nur im Kontext von vorher', async () => {
  await faehre('Umbuchung', {
    api: { get: async () => ({ data: { id: 7, amount: -10, from_account_id: 1, to_account_id: 2, date: '2026-10-01' } }) },
    oeffne: () => openTransferDialog({
      entry: { id: 7 }, readOnly: () => false, onError: (err) => { throw err; },
      accounts: [{ id: 1, name: 'A' }, { id: 2, name: 'B' }], categories: [], month: '2026-10', currency: 'EUR', budgetMode: 'simple',
    }),
  });
});

test('#1997: Schnellzugriffe verwalten', async () => {
  await faehre('Schnellzugriffe', { oeffne: () => openQuickLinksManager({}) });
});

test('#1997: Geburtstage aus Kontakten importieren', async () => {
  await faehre('Geburtstags-Import', {
    api: { get: async () => ({ data: { withBirthday: [], withoutBirthday: [] } }) },
    oeffne: () => birthdays.openImportModal(),
  });
});

test('#1997: Kalender verwalten', async () => {
  await faehre('Kalender verwalten', { oeffne: () => calendar.openLocalCalendarsModal() });
});

test('#1997: Kontakt bearbeiten - der volle Kontakt kommt erst', async () => {
  await faehre('Kontakt bearbeiten', {
    api: { get: async () => ({ data: { id: 3, first_name: 'Ada', last_name: 'L' } }) },
    oeffne: () => contacts.openContactModal({ mode: 'edit', contact: { id: 3, first_name: 'Ada', last_name: 'L' } }),
  });
});

test('#1997: Orte im Inventar - die Komponente laedt erst', async () => {
  await faehre('Inventar: Orte', { oeffne: () => inventory.openLocationManager() });
});

test('#1997: Kategorien im Inventar - die Komponente laedt erst', async () => {
  await faehre('Inventar: Kategorien', { oeffne: () => inventory.openCategoryManager() });
});

test('#1997: Lagerorte im Vorrat - die Komponente laedt erst', async () => {
  await faehre('Vorrat: Lagerorte', { oeffne: () => pantry.openLocationManager() });
});

const REZEPT = { id: 5, ingredients: [{ name: 'Reis', quantity: '200 g' }] };

test('#1997: eine Zutat mit dem Vorrat verbinden', async () => {
  await faehre('Rezept: Zutat zuordnen', { oeffne: () => recipes.openPantryMatchModal(REZEPT, 'Reis') });
});

test('#1997: alle Zutaten mit dem Vorrat verbinden', async () => {
  await faehre('Rezept: alle zuordnen', { oeffne: () => recipes.openPantryBulkMatchModal(REZEPT) });
});

async function mitBelohnungen(fn) {
  rewards.state.overview = { me: 1, balances: [{ id: 1, display_name: 'Ada', balance: 4 }], catalog: [] };
  rewards.state.money = { accounts: [{ id: 1, display_name: 'Ada', balance_minor: 100, currency: 'EUR' }] };
  try {
    await fn();
  } finally {
    rewards.state.overview = null;
    rewards.state.money = null;
  }
}

test('#1997: Belohnungen - Teilnehmende verwalten', async () => {
  await mitBelohnungen(() => faehre('Teilnehmende', { oeffne: () => rewards.openParticipantsModal() }));
});

test('#1997: Belohnungen - Punkteverlauf eines Mitglieds', async () => {
  await mitBelohnungen(() => faehre('Punkteverlauf', { oeffne: () => rewards.openMemberDetail(1) }));
});

test('#1997: Belohnungen - Taschengeld-Verlauf', async () => {
  await mitBelohnungen(() => faehre('Taschengeld-Verlauf', { oeffne: () => rewards.openMoneyDetail(1) }));
});

async function mitEinkauf(items, fn) {
  const vorher = { activeListId: shopping.state.activeListId, items: shopping.state.items };
  Object.assign(shopping.state, { activeListId: 9, items });
  try {
    await fn();
  } finally {
    Object.assign(shopping.state, vorher);
  }
}

test('#1997: Einkauf - Liste verschicken', async () => {
  await mitEinkauf([{ id: 1, name: 'Milch', is_checked: 0 }], () => faehre('Liste verschicken', {
    api: { get: async () => ({ data: [{ id: 2, display_name: 'Bo' }] }) },
    oeffne: () => shopping.openSendListDialog(makeContainer()),
  }));
});

test('#1997: Einkauf - Abgehaktes in den Vorrat uebernehmen', async () => {
  await mitEinkauf([{ id: 1, name: 'Milch', quantity: '1 l', is_checked: 1 }], () => faehre('In den Vorrat', {
    oeffne: () => shopping.openPantryTransfer(makeContainer()),
  }));
});

test('#1997: Einkauf - der Kategorie-Manager wartet auf nichts und geht sofort auf', async () => {
  // Das Modul war schon geladen; das `await import()` davor war nur ein
  // Fenster, in dem ein anderer Dialog aufgehen konnte.
  const geoeffnet = [];
  globalThis.__openModal = (opts) => { geoeffnet.push(opts?.title); };
  try {
    const lauf = shopping.openCategoryManager(makeContainer());
    assert.equal(geoeffnet.length, 1, 'der Manager oeffnet erst nach einem await');
    await lauf;
  } finally {
    delete globalThis.__openModal;
  }
});

async function mitGruppe(fn) {
  const vorher = { activeGroupId: split.state.activeGroupId, groups: split.state.groups, meta: split.state.meta };
  Object.assign(split.state, {
    activeGroupId: 4,
    meta: { default_currency: 'EUR', group_types: ['household'], currencies: ['EUR'] },
    groups: [{ id: 4, name: 'WG', currency: 'EUR', members: [] }],
  });
  try {
    await fn();
  } finally {
    Object.assign(split.state, vorher);
  }
}

test('#1997: Geteilte Ausgaben - Gruppe bearbeiten', async () => {
  await mitGruppe(() => faehre('Gruppe bearbeiten', { oeffne: () => split.openGroupModal(split.state.groups[0]) }));
});

test('#1997: Geteilte Ausgaben - Mitglied einladen', async () => {
  await mitGruppe(() => faehre('Mitglied einladen', { oeffne: () => split.openMemberModal() }));
});

test('#1997: Abfall - Erinnerungen einstellen', async () => {
  await faehre('Abfall-Erinnerungen', { oeffne: () => waste.openReminderSettingsModal() });
});

test('#1997: Abfall - Vorschau eines Zuordnungsprofils', async () => {
  // Die Vorschau haengt an einer Dateiauswahl: der change-Handler ist der Ablauf.
  const echtesCreate = document.createElement;
  let input = null;
  document.createElement = (tag) => {
    if (tag !== 'input') return echtesCreate(tag);
    input = { files: [{ text: async () => '{}' }], addEventListener(typ, fn) { this[typ] = fn; }, click() {} };
    return input;
  };
  try {
    await faehre('Zuordnungsprofil-Vorschau', {
      api: { post: async () => ({ data: { applicable_count: 0, entries: [] } }) },
      oeffne: () => { waste.openMappingProfileImportModal({ id: 1 }); return input.change(); },
    });
  } finally {
    document.createElement = echtesCreate;
  }
});

test('#1997: Mitglied bearbeiten - die Betreuenden laden erst', async () => {
  await faehre('Mitglied bearbeiten', {
    api: { get: async () => ({ data: {} }) },
    oeffne: () => family.openEditMemberModal({ id: 2, display_name: 'Bo', role: 'member' }, { id: 1, role: 'admin' }, [], makeContainer()),
  });
});

// Codex an #2132: tippt der Nutzer A und dann B, bevor eine der Anfragen
// zurueck ist, gilt B - in welcher Reihenfolge die Antworten auch kommen. Beide
// Oeffner fingen sonst dieselbe Generation, die zuerst angekommene Antwort
// oeffnete und loeste die Generation weiter, und B wurde verworfen.
async function wettlauf(name, { oeffneA, oeffneB, antwortA, antwortB, istB }) {
  for (const zuerst of ['A', 'B']) {
    const offen = [];
    const geoeffnet = [];
    // Wie das Original: jedes Oeffnen ist eine neue Generation.
    let kontext = 'seite';
    globalThis.__modalContextId = () => kontext;
    globalThis.__openModal = (opts) => { geoeffnet.push(opts); kontext = `dialog-${geoeffnet.length}`; };
    globalThis.__apiStub = { get: () => new Promise((resolve) => { offen.push(resolve); }) };
    try {
      const a = oeffneA();
      const b = oeffneB();
      assert.equal(offen.length, 2, `${name}: beide Anfragen laufen`);
      if (zuerst === 'A') { offen[0](antwortA); await a; offen[1](antwortB); await b; }
      else { offen[1](antwortB); await b; offen[0](antwortA); await a; }
      assert.equal(geoeffnet.length, 1, `${name}, ${zuerst} antwortet zuerst: ${geoeffnet.length} Dialoge geoeffnet`);
      assert.ok(istB(geoeffnet[0]), `${name}, ${zuerst} antwortet zuerst: offen ist nicht der zuletzt gewaehlte (B)`);
    } finally {
      delete globalThis.__modalContextId;
      delete globalThis.__openModal;
      delete globalThis.__apiStub;
    }
  }
}

test('#1997: Kontakt A, dann B gewaehlt - offen ist B, wer auch zuerst antwortet (Codex an #2132)', async () => {
  const ada = { id: 1, first_name: 'Ada', last_name: 'Lovelace' };
  const bo = { id: 2, first_name: 'Bo', last_name: 'Zweitname' };
  await wettlauf('Kontakt', {
    oeffneA: () => contacts.openContactModal({ mode: 'edit', contact: ada }),
    oeffneB: () => contacts.openContactModal({ mode: 'edit', contact: bo }),
    antwortA: { data: ada },
    antwortB: { data: bo },
    istB: (opts) => String(opts.content).includes('Zweitname') && !String(opts.content).includes('Lovelace'),
  });
});

test('#1997: Punkteverlauf von A, dann B - offen ist B (Codex an #2132)', async () => {
  await mitBelohnungen(async () => {
    rewards.state.overview.balances.push({ id: 2, display_name: 'Zweitname', balance: 1 });
    await wettlauf('Punkteverlauf', {
      oeffneA: () => rewards.openMemberDetail(1),
      oeffneB: () => rewards.openMemberDetail(2),
      antwortA: { data: [] },
      antwortB: { data: [] },
      istB: (opts) => String(opts.title).includes('Zweitname') || String(opts.content).includes('Zweitname'),
    });
  });
});

// Kein Oeffnen, sondern das Schliessen in einem Helfer: reportError() der
// Vorsorge-Arten schloss bei "gibt es nicht mehr" den Dialog, der gerade offen
// war - ohne zu fragen, ob es noch der ist, aus dem gespeichert wurde.
test('#1997: Vorsorge-Art speichern, die es nicht mehr gibt - geschlossen wird nur der eigene Dialog', async () => {
  let kontext = 'eigener-dialog';
  const geschlossen = [];
  const klicks = {};
  const felder = {};
  let optionen = null;
  globalThis.__modalContextId = () => kontext;
  globalThis.__openModal = (opts) => { optionen = opts; };
  globalThis.__closeModal = (opts) => { geschlossen.push(opts ?? {}); return true; };
  const weg = Object.assign(new Error('gone'), { status: 404, data: { reason: 'health_prevention_type_not_found' } });
  globalThis.__apiStub = {
    get: async () => ({ data: [] }),
    patch: async () => { kontext = 'ein-anderer-dialog'; throw weg; },
  };
  try {
    health.openTypeModal({ id: 8, name: 'Impfung', kind: 'vaccination', icon: 'syringe' });
    const panel = {
      querySelector: (sel) => {
        felder[sel] ??= { value: '', disabled: false, addEventListener(typ, fn) { klicks[`${sel}:${typ}`] = fn; } };
        return felder[sel];
      },
      querySelectorAll: () => [],
    };
    optionen.onSave(panel);
    panel.querySelector('#hpt-name').value = 'Impfung';
    panel.querySelector('#hpt-kind').value = 'vaccination';
    await klicks['#health-prevention-type-form:submit']({ preventDefault() {} });
    await new Promise((r) => setTimeout(r, 0));
    assert.equal(geschlossen.length, 1, `genau ein Schliessen (${JSON.stringify(geschlossen)})`);
    assert.equal(geschlossen[0].context, 'eigener-dialog',
      'geschlossen wird ohne den Kontext von vor der Anfrage - die spaete Antwort traefe den Dialog, der jetzt offen ist');
  } finally {
    delete globalThis.__modalContextId;
    delete globalThis.__openModal;
    delete globalThis.__closeModal;
    delete globalThis.__apiStub;
  }
});

// #2134: confirmModal() geht durch openModal() und verdraengt genauso, was im
// Slot liegt. Gefahren wird jede Stelle zweimal: ruhig (die Meldung oder Frage
// muss kommen, sonst haette der Fall den Weg nicht erreicht) und mit einem
// Kontextwechsel, WAEHREND die Anfrage laeuft (`lauf.spaet()` im Stub). Dann
// geht eine Fehlermeldung als Toast hinaus, und eine Frage entfaellt samt der
// Anfrage, die an ihrer Antwort haengt.
async function zweimal(fall) {
  for (const wechsel of [false, true]) {
    let kontext = 'vor-der-anfrage';
    const lauf = {
      wechsel, fragen: [], toasts: [], anfragen: [], geoeffnet: [], antwort: false,
      spaet() { if (wechsel) kontext = 'ein-anderer-dialog'; },
    };
    globalThis.__modalContextId = () => kontext;
    globalThis.__confirmModal = async (message, opts = {}) => { lauf.fragen.push(opts.confirmLabel ?? message); return lauf.antwort; };
    globalThis.__openModal = (opts) => { lauf.geoeffnet.push(opts?.title); opts?.onClose?.(); };
    const toastVorher = window.yuvomi.showToast;
    window.yuvomi.showToast = (message, type) => { lauf.toasts.push(type); };
    try {
      await fall(lauf);
    } finally {
      delete globalThis.__modalContextId;
      delete globalThis.__confirmModal;
      delete globalThis.__openModal;
      delete globalThis.__apiStub;
      window.yuvomi.showToast = toastVorher;
    }
  }
}

const SERVERFEHLER = () => Object.assign(new Error('boom'), { status: 500, data: {} });

/** Ruhig: genau `ruhig` gefragt; spaet: nur `spaet` gefragt und `toasts` gezeigt. */
function erwarte(lauf, name, { ruhig, spaet, toasts = ['danger'] }) {
  if (!lauf.wechsel) {
    assert.deepEqual(lauf.fragen, ruhig, `${name}: ohne Wechsel kommt der Dialog nicht (${JSON.stringify(lauf.fragen)})`);
    return;
  }
  assert.deepEqual(lauf.fragen, spaet,
    `${name}: der Dialog geht nach der Antwort auf, obwohl inzwischen ein anderer Dialog offen ist - er wuerde ihn verdraengen`);
  assert.deepEqual(lauf.toasts, toasts, `${name}: die Meldung muss als Toast hinaus (${JSON.stringify(lauf.toasts)})`);
}

test('#2134: Belohnungen - eine Anfrage entscheiden scheitert spaet', async () => {
  await zweimal(async (lauf) => {
    globalThis.__apiStub = { get: async () => ({ data: [] }), patch: async () => { lauf.spaet(); throw SERVERFEHLER(); } };
    await rewards.decideRedemption(9, 'fulfill', null);
    erwarte(lauf, 'Anfrage entscheiden', { ruhig: ['rewards.gotIt'], spaet: [] });
  });
});

test('#2134: Belohnungen - Teilnehmende laden scheitert spaet', async () => {
  await mitBelohnungen(() => zweimal(async (lauf) => {
    globalThis.__apiStub = { get: async () => { lauf.spaet(); throw SERVERFEHLER(); } };
    await rewards.openParticipantsModal();
    // Der Dialog, zu dem die Meldung gehoert, geht dann ohnehin nicht mehr
    // auf: der Nutzer ist weiter, die Meldung entfaellt.
    erwarte(lauf, 'Teilnehmende', { ruhig: ['rewards.gotIt'], spaet: [], toasts: [] });
  }));
});

test('#2134: Taschengeld - Konto schliessen scheitert spaet', async () => {
  const user = rewards.state.user;
  rewards.state.user = { id: 1, role: 'admin' };
  try {
    await mitBelohnungen(() => zweimal(async (lauf) => {
      lauf.antwort = true;
      globalThis.__apiStub = { get: async () => ({ data: [] }), delete: async () => { lauf.spaet(); throw SERVERFEHLER(); } };
      await rewards.closeMoneyAccount({ id: 1, display_name: 'Ada' });
      erwarte(lauf, 'Konto schliessen', {
        ruhig: ['rewards.money.closeAccount', 'rewards.gotIt'],
        spaet: ['rewards.money.closeAccount'],
      });
    }));
  } finally {
    rewards.state.user = user;
  }
});

test('#2134: Taschengeld - Plan beenden scheitert spaet', async () => {
  await mitBelohnungen(() => zweimal(async (lauf) => {
    globalThis.__apiStub = { get: async () => ({ data: [] }), delete: async () => { lauf.spaet(); throw SERVERFEHLER(); } };
    await rewards.removeMoneyPlan({ id: 1 });
    erwarte(lauf, 'Plan beenden', { ruhig: ['rewards.gotIt'], spaet: [] });
  }));
});

test('#2134: Modul installieren - die Ersetzen-Frage aus der 409 kommt nur im Kontext von vorher', async () => {
  await zweimal(async (lauf) => {
    lauf.antwort = true;
    const exists = Object.assign(new Error('exists'), {
      status: 409, data: { reason: 'exists', existing: { id: 'demo', version: '1.0.0' }, incoming: { id: 'demo', version: '1.1.0' } },
    });
    globalThis.__apiStub = {
      post: async (path, body) => {
        lauf.anfragen.push(body.overwrite === true ? 'ersetzen' : 'installieren');
        if (body.overwrite) return { data: { id: 'demo', version: '1.1.0' } };
        lauf.spaet();
        throw exists;
      },
    };
    const errorEl = { textContent: '', hidden: true };
    const card = {
      busy: false, button: null, errorEl,
      resultEl: { replaceChildren() {} },
      candidatesEl: { replaceChildren() {}, hidden: true, querySelector: () => null },
      form: { reset() {} },
      body: { dataset: { installCard: 'github' } },
    };
    await install.runInstall(card, { kind: 'github', url: 'https://github.com/a/b' });
    if (!lauf.wechsel) {
      assert.deepEqual(lauf.fragen, ['settings.installModuleReplaceButton'], 'ohne Wechsel wird gefragt');
      assert.deepEqual(lauf.anfragen, ['installieren', 'ersetzen']);
    } else {
      assert.deepEqual(lauf.fragen, [], 'die Frage geht ueber dem Dialog auf, der inzwischen offen ist');
      assert.deepEqual(lauf.anfragen, ['installieren'], 'ohne Frage auch kein Ersetzen');
      assert.equal(errorEl.hidden, false, 'der Konflikt steht stattdessen an der Karte');
    }
  });
});

test('#2134: Ordner loeschen - die Frage aus der Vorschau kommt nur im Kontext von vorher', async () => {
  for (const documentsInFolder of [0, 2]) {
    await zweimal(async (lauf) => {
      globalThis.__apiStub = {
        get: async () => {
          lauf.spaet();
          return { data: { id: 3, removed_folders: 1, documents: documentsInFolder, can_delete_documents: true, linked_records: {}, snapshot: 'a'.repeat(64) } };
        },
      };
      await documents.deleteFolder({ id: 3, name: 'Wohnung', parent_id: null });
      const gefragt = [...lauf.fragen, ...lauf.geoeffnet];
      const name = `Ordner loeschen (${documentsInFolder} Dokumente)`;
      if (!lauf.wechsel) assert.equal(gefragt.length, 1, `${name}: ohne Wechsel wird gefragt (${JSON.stringify(gefragt)})`);
      else assert.deepEqual(gefragt, [], `${name}: die Frage geht ueber dem Dialog auf, der inzwischen offen ist`);
    });
  }
});

test('#2134: Standard-Punkte - das Nachziehen wird nur im Kontext von vorher angeboten', async () => {
  await zweimal(async (lauf) => {
    globalThis.__apiStub = {
      put: async () => ({ data: {} }),
      get: async () => { lauf.spaet(); return { data: { count: 3 } }; },
      post: async () => { lauf.anfragen.push('nachziehen'); return { data: { updated: 3 } }; },
    };
    const handlers = {};
    const el = (extra = {}) => ({
      value: '', hidden: true, readOnly: false, isConnected: true, textContent: '',
      setAttribute() {}, removeAttribute() {}, addEventListener(type, fn) { handlers[type] = fn; }, ...extra,
    });
    const input = el({ value: '5' });
    const form = el();
    const errorEl = el();
    const container = {
      querySelector: (sel) => ({ '#rewards-default-points-form': form, '#rewards-default-points': input, '#rewards-default-points-error': errorEl })[sel] ?? null,
    };
    bindDefaultPoints(container, { tasks_default_points: 2 });
    input.value = '5';
    await handlers.submit({ preventDefault() {} });
    erwarte(lauf, 'Nachziehen', { ruhig: ['settings.rewardsDefaultPointsRebaseConfirm'], spaet: [], toasts: ['success'] });
  });
});

function makeContainer() {
  return document.createElement('div');
}
