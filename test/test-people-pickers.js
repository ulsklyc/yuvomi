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
