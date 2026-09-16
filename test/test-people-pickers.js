/**
 * Modul: Personen-Auswahlen im Browser (#1207)
 * Zweck: Eine Auswahl zeigt Haushaltsmitglieder - und dazu, wer an DIESEM
 *        Datensatz schon steht (withChosenPeople()). Diese Suite rendert die
 *        echten Seitenbausteine ueber den Browser-Loader und prueft das Markup,
 *        nicht den Quelltext:
 *          - Budget: der Zustaendigen-Picker erscheint auch mit nur einem
 *            Mitglied, wenn eine Buchung schon Personal oder einen Gast nennt;
 *          - Aufgaben: der Solo-Haushalt versteckt den Zustaendigen-Picker nur,
 *            wenn wirklich nur eine Person in Frage kommt;
 *          - Dienstplan: ein neues Formular bietet als Besitzer nur Mitglieder
 *            und bestehende Plan-Besitzer an, nicht den Vorgabewert.
 *        Dazu Formulare, deren fehlendes Feld beim Speichern einen gespeicherten
 *        Wert aendern wuerde, und Anzeigen gespeicherter Verweise:
 *          - Kalender: die Sichtbarkeit bleibt im Formular, auch wenn hoechstens
 *            ein Mitglied gelistet ist;
 *          - Dokumente: eine bestehende Freigabe fuer Personal oder einen Gast
 *            bleibt als angehaktes Kaestchen stehen;
 *          - Budget: der Zustaendigen-Filterchip nennt auch so jemanden;
 *          - Dashboard: Dienstplan-Zeilen tragen die Namen aller Plan-Besitzer.
 * Ausfuehren: npm run test:people-pickers
 */
import test from 'node:test';
import assert from 'node:assert/strict';

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

// Der Loader stubt die Mehrfachauswahl fuer die Seiten weg; diese Suite prueft
// genau deren Markup und reicht deshalb die echte Komponente durch.
const { renderUserMultiSelect } = await import('../public/components/user-multi-select.js');
globalThis.__renderUserMultiSelect = renderUserMultiSelect;

const { setHouseholdSize } = await import('../public/utils/household.js');
const { __test: budget } = await import('../public/pages/budget.js');
const { __test: tasks } = await import('../public/pages/tasks.js');
const { __test: schedule } = await import('../public/pages/schedule.js');

// Anna ist das einzige Mitglied; Clara ist Hauspersonal und steht nur an
// einem gespeicherten Datensatz (die Datensaetze nennen die Farbe `color`).
const ANNA = { id: 1, display_name: 'Anna', avatar_color: '#111111', username: 'anna' };
const CLARA = { id: 3, display_name: 'Clara', color: '#333333', username: 'clara' };

const checkboxIds = (html) => [...html.matchAll(/class="user-ms__checkbox" value="(\d+)"/g)].map((m) => Number(m[1]));
const optionIds = (html) => [...html.matchAll(/<option value="(\d+)"/g)].map((m) => Number(m[1]));

// --------------------------------------------------------------------------
// Budget
// --------------------------------------------------------------------------

test('budget: one member and a stored staff responsible still show the picker and the handover', () => {
  const html = budget.responsiblePickerHtml({ members: [ANNA], entry: { responsible_users: [CLARA] }, isEdit: true });
  assert.deepEqual(checkboxIds(html), [ANNA.id, CLARA.id], 'the stored reference can be seen and removed');
  assert.match(html, /id="bm-to-split"/, 'the handover to split expenses is offered for the stored responsible');
});

test('budget: one member and a new entry still ask no question', () => {
  assert.equal(budget.responsiblePickerHtml({ members: [ANNA], entry: null, isEdit: false }), '');
  assert.equal(budget.responsiblePickerHtml({ members: [ANNA], entry: { responsible_users: [] }, isEdit: true }), '');
});

// --------------------------------------------------------------------------
// Aufgaben
// --------------------------------------------------------------------------

function assigneeGroup(html) {
  const at = html.indexOf('data-ms-input="task_assigned"');
  assert.ok(at > 0, 'the assignee picker is rendered');
  const groupStart = html.lastIndexOf('<div class="form-group"', at);
  const tag = html.slice(groupStart, html.indexOf('>', groupStart) + 1);
  return { hidden: /\shidden(\s|>)/.test(tag), ids: checkboxIds(html.slice(groupStart)) };
}

test('tasks: a solo household still shows the assignee picker when a stored staff assignee is on the task', () => {
  setHouseholdSize(1);
  const html = tasks.renderModalContent({
    task: { id: 9, title: 'Fenster', status: 'open', priority: 'none', visibility: 'all', assigned_to: CLARA.id, assigned_users: [CLARA] },
    users: [ANNA],
  });
  const group = assigneeGroup(html);
  assert.equal(group.hidden, false, 'the stored assignee can be seen and removed');
  assert.deepEqual(group.ids.slice(0, 2), [ANNA.id, CLARA.id]);
});

test('tasks: a solo household keeps hiding the assignee picker when only one person is in question', () => {
  setHouseholdSize(1);
  assert.equal(assigneeGroup(tasks.renderModalContent({ task: null, users: [ANNA] })).hidden, true);
});

// Die Auswahl "wer hat es getan" beim Abhaken (#1205). Sie hat keinen eigenen
// Dialog: sie ist ein zweites Ziel in der Zeile, und die ganze Entscheidung
// liegt darin, WANN es ueberhaupt dasteht.
const BEA = { id: 2, display_name: 'Bea', avatar_color: '#222222', username: 'bea' };
const OPEN_TASK = { id: 7, title: 'Spuelmaschine', status: 'open' };

test('tasks: the doer picker offers every member and carries the task in its panel id', () => {
  setHouseholdSize(2);
  tasks.state.users = [ANNA, BEA];
  const html = tasks.renderDoerPicker(OPEN_TASK, false, false);
  assert.match(html, /id="task-doer-7"/, 'das Panel traegt die Aufgabe, nicht der Eintrag');
  assert.deepEqual([...html.matchAll(/data-action="pick-doer" data-id="(\d+)"/g)].map((m) => Number(m[1])),
    [ANNA.id, BEA.id]);
});

test('tasks: a solo household never sees the doer picker', () => {
  setHouseholdSize(1);
  tasks.state.users = [ANNA];
  assert.equal(tasks.renderDoerPicker(OPEN_TASK, false, false), '');
});

test('tasks: a household of two with only one known member still sees no doer picker', () => {
  // Die Haushaltsgroesse sagt "zwei", die geladene Mitgliederliste kennt eine
  // Person - ein Menue mit genau einem Eintrag beantwortet keine Frage.
  setHouseholdSize(2);
  tasks.state.users = [ANNA];
  assert.equal(tasks.renderDoerPicker(OPEN_TASK, false, false), '');
});

test('tasks: a task that is already done or filed away offers no doer picker', () => {
  // Benannt wird am UEBERGANG nach erledigt, und der ist hier vorbei. Ein
  // Menue, das nichts mehr aendern kann, waere ein Versprechen ohne Deckung.
  setHouseholdSize(2);
  tasks.state.users = [ANNA, BEA];
  assert.equal(tasks.renderDoerPicker(OPEN_TASK, true, false), '');
  assert.equal(tasks.renderDoerPicker(OPEN_TASK, false, true), '');
});

// --------------------------------------------------------------------------
// Dienstplan
// --------------------------------------------------------------------------

test('schedule: a new form does not offer its default owner when that account may not own a plan', () => {
  // Das eigene Konto einer Hauskraft ohne Plan ist der Vorgabewert eines neuen
  // Formulars (selectedOwner()) - POST /schedule/patterns lehnt es ab.
  schedule.setOwnerContext({ users: [ANNA, CLARA], people: [ANNA], me: CLARA.id, mayManageOthers: false });
  assert.deepEqual(optionIds(schedule.userOptions(CLARA.id)), []);
});

test('schedule: members and existing plan owners stay on offer', () => {
  schedule.setOwnerContext({
    users: [ANNA, CLARA], people: [ANNA], patterns: [{ id: 5, user_id: CLARA.id }], me: ANNA.id, mayManageOthers: true,
  });
  assert.deepEqual(optionIds(schedule.userOptions(ANNA.id)), [ANNA.id, CLARA.id]);
});

// --------------------------------------------------------------------------
// Formulare, deren fehlendes Feld beim Speichern einen gespeicherten Wert
// aendert, und Anzeigen, die Namen gespeicherter Verweise aufloesen
// --------------------------------------------------------------------------

const { __test: calendar } = await import('../public/pages/calendar.js');
const { __test: documents } = await import('../public/pages/documents.js');
const { __test: dashboard } = await import('../public/pages/dashboard.js');

test('calendar: editing an event keeps its stored visibility in the form when at most one member is listed', () => {
  // state.users (aus /family/members) ist hier leer - wie in jedem Haushalt,
  // dessen Liste hoechstens ein Mitglied hat. Der Speicherpfad liest
  // "#modal-visibility?.value || 'all'": fehlt das Feld, wird jeder private
  // Termin beim Speichern fuer alle sichtbar.
  const html = calendar.buildEventModalContent({
    mode: 'edit',
    event: {
      id: 7, title: 'Arzt', start_datetime: '2030-05-01T10:00', end_datetime: '2030-05-01T11:00',
      visibility: 'private', assigned_users: [CLARA],
    },
  });
  const select = html.match(/<select[^>]*id="modal-visibility"[\s\S]*?<\/select>/);
  assert.ok(select, 'the visibility field is part of the form');
  assert.match(select[0], /<option value="private"\s+selected/, 'and it carries the stored value');
});

/** Die Seite laedt Mitglieder und Kontenverzeichnis ueber die echte loadMembers(). */
async function loadDocumentPeople() {
  globalThis.__apiStub = {
    get: async (path) => {
      if (path === '/family/members') return { data: [ANNA] };
      if (path === '/auth/users') return { data: [ANNA, CLARA] };
      return { data: null };
    },
  };
  try {
    await documents.loadMembers();
  } finally {
    delete globalThis.__apiStub;
  }
}

test('documents: a stored grant for a non-member stays on offer and checked', async () => {
  // Der Speicherpfad baut allowed_member_ids aus den angehakten Kaestchen:
  // ein Kaestchen, das fehlt, entzieht beim Speichern den Zugriff.
  await loadDocumentPeople();
  const html = documents.memberOptions([CLARA.id]);
  const boxes = [...html.matchAll(/<input type="checkbox" value="(\d+)"\s*(checked)?/g)].map((m) => [Number(m[1]), Boolean(m[2])]);
  assert.deepEqual(boxes, [[ANNA.id, false], [CLARA.id, true]]);
  assert.match(html, /<span>Clara<\/span>/, 'the grant is shown by name');
});

test('budget: the responsible filter chip names a stored non-member responsible', () => {
  // Der Filter kommt aus dem Avatar-Stapel einer Buchung, die Clara nennt.
  const entries = [{ id: 1, responsible_users: [CLARA] }];
  assert.equal(budget.responsibleFilterName(CLARA.id, { members: [ANNA], entries }), 'Clara');
  assert.equal(budget.responsibleFilterName(ANNA.id, { members: [ANNA], entries }), 'Anna');
});

test('documents: without stored grants only members are offered', async () => {
  await loadDocumentPeople();
  const html = documents.memberOptions([]);
  assert.deepEqual([...html.matchAll(/value="(\d+)"/g)].map((m) => Number(m[1])), [ANNA.id]);
});

test('dashboard: the schedule slice brings the names of every plan owner, and the tile shows them', async () => {
  // Clara (Hauspersonal) hat einen bestehenden Plan; data.users der Kachel
  // kommt aus der strengen Mitgliederliste und kennt sie nicht.
  globalThis.__apiStub = {
    get: async (path) => {
      if (path.startsWith('/schedule/entries')) {
        return { data: { entries: [{ user_id: CLARA.id, date_key: '2030-05-01', source: 'pattern', shift_type: { id: 1, name: 'Frueh', short_code: 'F', color: '#123456' } }] } };
      }
      if (path === '/schedule/shift-types') return { data: [{ id: 1 }] };
      if (path === '/auth/users') return { data: [ANNA, CLARA] };
      return { data: null };
    },
  };
  try {
    const slice = await dashboard.loadScheduleSlice('2030-05-01');
    const html = dashboard.renderScheduleWidget(slice, [ANNA], '1x2');
    assert.match(html, /class="schedule-widget-row__name">Clara</, 'the row of a stored plan owner carries a name');
  } finally {
    delete globalThis.__apiStub;
  }
});

test('budget: the responsible filter chip keeps its name after a month change', () => {
  // Der Filter wird am Avatar einer Buchung gesetzt, die Clara nennt. Im
  // naechsten Monat nennt keine Buchung sie mehr, und die Mitgliederliste kennt
  // sie nicht - der Filter bleibt aktiv, der Chip darf nicht leer werden.
  const view = { members: [ANNA], entries: [{ id: 1, responsible_users: [CLARA] }], responsibleFilterId: null };
  budget.toggleResponsibleFilter(view, CLARA.id);
  view.entries = [{ id: 2, responsible_users: [ANNA] }];
  assert.equal(view.responsibleFilterId, CLARA.id, 'the filter stays active');
  assert.equal(budget.responsibleFilterLabel(view), 'Clara');
  budget.toggleResponsibleFilter(view, CLARA.id);
  assert.equal(view.responsibleFilterId, null, 'the same person again clears the filter');
});

const { __test: health } = await import('../public/pages/health.js');
const BEN = { id: 2, display_name: 'Ben', avatar_color: '#222222', username: 'ben' };

test('health: a signed-in account that is not a member sees its own name on the person switcher', async () => {
  // Gelesen und geschrieben wird unter personId = eigenes Konto; die Liste aus
  // /family/members kennt ein angemeldetes Konto, das kein Mitglied ist, nicht.
  globalThis.__apiStub = { get: async (path) => (path === '/family/members' ? { data: [ANNA, BEN] } : { data: null }) };
  try {
    const view = { members: [], personId: null, meId: CLARA.id };
    await health.loadHealthMembers(view, CLARA);
    assert.equal(view.personId, CLARA.id);
    const html = health.personSwitcherMarkup(view.members, view.personId, view.meId, { menuId: 'm', label: 'Person' });
    assert.match(html, /class="health-person-switcher__name">Clara · health\.vitals\.you</, 'the switcher names the person whose data is shown');

    const member = { members: [], personId: null, meId: ANNA.id };
    await health.loadHealthMembers(member, ANNA);
    assert.deepEqual(member.members.map((person) => person.id), [ANNA.id, BEN.id], 'a member is listed once, as before');
  } finally {
    delete globalThis.__apiStub;
  }
});

const { setOtherReaders } = await import('../public/utils/household.js');

/** Ist die form-group um das Feld mit diesem Merkmal verborgen? */
function fieldGroupHidden(html, marker) {
  const at = html.indexOf(marker);
  assert.ok(at > 0, `the field ${marker} is rendered`);
  const groupStart = html.lastIndexOf('<div class="form-group"', at);
  const tag = html.slice(groupStart, html.indexOf('>', groupStart) + 1);
  return /\shidden(\s|>)/.test(tag);
}

test('privacy: with one member, the protective fields stay while another account can read the module', () => {
  // Ein Haushalt aus einem Mitglied und Personal, das Aufgaben, Dokumente und
  // den Kalender lesen kann: ein neuer Eintrag ohne Sichtbarkeitsfeld bliebe
  // bei "alle" und waere fuer das Personal lesbar.
  setHouseholdSize(1);
  const event = { id: 8, title: 'Arzt', start_datetime: '2030-05-01T10:00', end_datetime: '2030-05-01T11:00', visibility: 'all', assigned_users: [] };
  const render = () => ({
    task: tasks.renderModalContent({ task: null, users: [ANNA] }),
    document: documents.documentVisibilityFieldHtml(null),
    event: calendar.buildEventModalContent({ mode: 'edit', event }),
  });
  try {
    setOtherReaders(['calendar', 'documents', 'tasks']);
    let html = render();
    assert.equal(fieldGroupHidden(html.task, 'id="task-visibility"'), false, 'task visibility');
    assert.equal(fieldGroupHidden(html.task, 'id="task-locked"'), false, 'task lock');
    assert.equal(fieldGroupHidden(html.document, 'id="document-visibility"'), false, 'document visibility');
    assert.equal(fieldGroupHidden(html.event, 'id="modal-visibility"'), false, 'event visibility');

    setOtherReaders([]);
    html = render();
    assert.equal(fieldGroupHidden(html.task, 'id="task-visibility"'), true, 'nobody else reads: task visibility hidden as before');
    assert.equal(fieldGroupHidden(html.task, 'id="task-locked"'), true, 'task lock hidden as before');
    assert.equal(fieldGroupHidden(html.document, 'id="document-visibility"'), true, 'document visibility hidden as before');
    assert.equal(fieldGroupHidden(html.event, 'id="modal-visibility"'), true, 'event visibility hidden as before');
  } finally {
    setOtherReaders([]);
  }
});

const { __test: icsSettings } = await import('../public/settings/pages/personal-calendar-subscriptions.js');

test('settings: saving a calendar subscription keeps a stored assignee that is not on offer', () => {
  // Die Optionen laden asynchron nach. Steht die gespeicherte Zuweisung nicht
  // darunter - die Liste laedt noch, oder das Laden ist fehlgeschlagen -, zeigt
  // die Auswahl "niemand", und Speichern von Name oder Farbe truege das ein.
  const select = (value, ...ids) => ({ value, options: [{ value: '' }, ...ids.map((id) => ({ value: String(id) }))] });
  assert.deepEqual(icsSettings.assigneePatch(select('', ANNA.id), CLARA.id), {},
    'the field stays out of the request, so the server keeps the stored assignee');
  assert.deepEqual(icsSettings.assigneePatch(select(String(CLARA.id), ANNA.id, CLARA.id), CLARA.id), { default_assignee_user_id: CLARA.id });
  assert.deepEqual(icsSettings.assigneePatch(select('', ANNA.id, CLARA.id), CLARA.id), { default_assignee_user_id: null },
    'removing an assignee who is on offer still works');
  assert.deepEqual(icsSettings.assigneePatch(select(String(ANNA.id), ANNA.id), null), { default_assignee_user_id: ANNA.id });
});
