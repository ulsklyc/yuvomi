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
