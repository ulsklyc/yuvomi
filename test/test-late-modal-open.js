/**
 * Tests: ein Dialog, der erst nach einer Antwort aufgeht, verdraengt keinen
 * anderen (#1997)
 * Module: public/components/budget-transfer-dialog.js,
 *         public/components/quick-links-manager.js, public/pages/birthdays.js,
 *         calendar.js, contacts.js, inventory.js, pantry.js, recipes.js,
 *         rewards.js, shopping.js, split-expenses.js, waste.js,
 *         public/settings/pages/admin-family.js, modules-health.js
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

function makeContainer() {
  return document.createElement('div');
}
