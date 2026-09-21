/**
 * Test: Der Termin-Dialog sagt, warum die Zuweisung kein Ziel waehlt (#1332)
 * Zweck: Ein neuer Termin bekommt den Kalender, der seine EINE zugewiesene
 *        Person als Standard nennt (#1060). Bei mehreren Zugewiesenen waehlt
 *        die Zuweisung bewusst nichts, und der Termin geht an den eigenen
 *        Standard des Autors - bis #1332 still. Der CHANGELOG zu 2.66.0 sagt
 *        seitdem: "Nothing is picked when two people are assigned, or when two
 *        calendars name the same person - the dialog says so instead of
 *        guessing." Gesagt hat der Dialog es nur im zweiten Fall.
 *
 *        GEMESSEN WIRD AM AUFRUFER. Verdrahtet wird ueber `wireEventForm`, die
 *        Ziele kommen als Antwort auf GET /calendar/sync-targets, die Hinweise
 *        aus dem Markup, das `buildEventModalContent` schreibt, und eine Person
 *        wird angehakt wie im Browser. Die Regel allein (`assigneeSyncTarget`,
 *        test:sync-target) bewiese nicht, dass der Dialog ihren Befund zeigt.
 *
 *        Abgedeckt: zwei Zugewiesene - der Hinweis steht da, nennt das Ziel, das
 *        wirklich gilt (den eigenen Standard, oder "Nur lokal", wenn der nicht
 *        angeboten wird), und klappt die Einstellungen auf, in denen er steht.
 *        Die Gegenrichtung, damit er kein Rauschen wird: eine Person mit
 *        Kalender, zwei Personen, die kein Kalender nennt, und ein Haushalt ohne
 *        Sync zeigen nichts; der bestehende Mehrdeutig-Fall behaelt seinen
 *        eigenen Wortlaut. Dazu der Wechsel hin und zurueck, die Wahl von Hand
 *        und das Bearbeiten eines bestehenden Termins.
 * Ausfuehren: npm run test:calendar-sync-target-hint
 */
import test from 'node:test';
import assert from 'node:assert/strict';

globalThis.window = globalThis.window ?? {};
globalThis.window.yuvomi = { showToast: () => {} };

const { __test: calendar } = await import('../public/pages/calendar.js');

// --------------------------------------------------------------------------
// Ein Formular-Doppel
//
// Kein jsdom (bewusst, siehe test/mini-dom.js). Das Doppel kann, was
// `wireEventForm` und `loadSyncTargets` brauchen: zusammengesetzte Selektoren
// aus Tag, id, Klasse und Attribut, auch als Liste; Ereignisse, die nach oben
// laufen; und ein <select>, das seine Eintraege als Nachfahren fuehrt (auch in
// einer <optgroup>) und wie im Browser nur einen Wert annimmt, den es fuehrt.
// --------------------------------------------------------------------------

class FakeEl {
  constructor(tag, { id = null, classes = [], attrs = {}, type, value = '', checked = false } = {}) {
    this.tagName = tag.toUpperCase();
    this.id = id;
    this.classes = new Set(classes);
    this.attrs = { ...attrs };
    this.dataset = {};
    this.children = [];
    this.parent = null;
    this.listeners = {};
    this.hidden = false;
    this.disabled = false;
    this.checked = checked;
    this.selected = false;
    this.type = type ?? (tag === 'select' ? 'select-one' : tag === 'input' ? 'text' : undefined);
    this.textContent = '';
    this.style = {};
    this._value = value;
    const el = this;
    this.classList = {
      add: (c) => el.classes.add(c),
      remove: (c) => el.classes.delete(c),
      contains: (c) => el.classes.has(c),
    };
  }

  get options() { return this.tagName === 'SELECT' ? this.querySelectorAll('option') : undefined; }

  get value() {
    if (this.tagName !== 'SELECT') return this._value;
    const options = this.options;
    return (options.find((o) => o.selected) ?? options[0])?.value ?? '';
  }

  set value(next) {
    if (this.tagName !== 'SELECT') { this._value = String(next); return; }
    const options = this.options;
    const target = options.find((o) => o.value === String(next));
    for (const option of options) option.selected = option === target;
  }

  append(child) { child.parent = this; this.children.push(child); return child; }
  appendChild(child) { return this.append(child); }
  replaceChildren(...nodes) { this.children = []; for (const n of nodes) this.append(n); }

  matches(selector) {
    return selector.split(',').some((part) => {
      const m = /^([a-z]+)?((?:#[\w-]+|\.[\w-]+|\[[\w-]+(?:="[^"]*")?\])*)$/.exec(part.trim());
      if (!m) return false;
      if (m[1] && this.tagName !== m[1].toUpperCase()) return false;
      for (const [, id, cls, attr, val] of m[2].matchAll(/#([\w-]+)|\.([\w-]+)|\[([\w-]+)(?:="([^"]*)")?\]/g)) {
        if (id && this.id !== id) return false;
        if (cls && !this.classes.has(cls)) return false;
        if (attr && (!(attr in this.attrs) || (val !== undefined && this.attrs[attr] !== val))) return false;
      }
      return true;
    });
  }

  closest(selector) {
    for (let node = this; node; node = node.parent) if (node.matches(selector)) return node;
    return null;
  }

  querySelectorAll(selector) {
    const found = [];
    const walk = (node) => {
      for (const child of node.children) {
        if (child.matches(selector)) found.push(child);
        walk(child);
      }
    };
    walk(this);
    return found;
  }

  querySelector(selector) { return this.querySelectorAll(selector)[0] ?? null; }

  addEventListener(type, fn) { (this.listeners[type] ??= []).push(fn); }
  removeEventListener(type, fn) {
    this.listeners[type] = (this.listeners[type] ?? []).filter((f) => f !== fn);
  }

  /** Ein Ereignis der Hand: am Ziel, dann aufwaerts. */
  dispatch(type) {
    const event = { type, target: this, preventDefault() {} };
    for (let node = this; node; node = node.parent) {
      for (const fn of [...(node.listeners[type] ?? [])]) fn(event);
    }
  }

  setAttribute(name, value) { this.attrs[name] = String(value); }
  getAttribute(name) { return name in this.attrs ? this.attrs[name] : null; }
  hasAttribute(name) { return name in this.attrs; }
  removeAttribute(name) { delete this.attrs[name]; }
  focus() {}
}

// loadSyncTargets baut die Ziel-Optionen mit document.createElement.
globalThis.document = globalThis.document ?? { createElement: (tag) => new FakeEl(tag) };

// Die Personenauswahl liest im Original die angehakten Kaestchen ihres Widgets
// (components/user-multi-select.js); der Loader stubt die Komponente, also
// liest der Test sie hier genauso.
globalThis.__getSelectedUserIds = (root, name) => root
  .querySelectorAll(`[data-ms-input="${name}"]`)
  .filter((box) => box.checked)
  .map((box) => Number(box.value))
  .filter(Boolean);

// --------------------------------------------------------------------------
// Haushalt
// --------------------------------------------------------------------------

// Emma und Leo haben je einen Kalender, der sie als Standard-Zuweisung nennt;
// Papa und Mama haben keinen. "Familie" nennt niemanden - das ist der eigene
// Standard des Autors (#620).
const PEOPLE = [{ id: 1, name: 'Papa' }, { id: 2, name: 'Mama' }, { id: 3, name: 'Emma' }, { id: 4, name: 'Leo' }];
const EMMA = 'google:emma@group.calendar.google.com';
const LEO = 'caldav:4|https://dav.example.org/cal/leo/';
const FAMILIE = 'google:familie@group.calendar.google.com';
const TARGETS = {
  google: [
    { id: 'emma@group.calendar.google.com', summary: 'Emma', defaultAssigneeUserId: 3 },
    { id: 'familie@group.calendar.google.com', summary: 'Familie', defaultAssigneeUserId: null },
  ],
  caldav: [
    { accountId: 4, accountName: 'Nextcloud', calendarUrl: 'https://dav.example.org/cal/leo/', calendarName: 'Leo', defaultAssigneeUserId: 4 },
  ],
  outlook: [],
};

const SEVERAL = '#event-sync-target-several-hint';
const AMBIGUOUS = '#event-sync-target-assignee-hint';

// Der Loader-Stub von t() gibt den Schluessel zurueck, mit Werten dahinter.
const severalText = (target) => `calendar.syncTargetSeveralAssignees${JSON.stringify({ target })}`;

const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

/**
 * Das Terminformular, verdrahtet wie im Browser.
 *
 * Die Zielwahl samt ihrer Hinweise kommt aus dem Markup, das der Dialog
 * schreibt - ids, `hidden` und Text wie dort. Sie steht in einem <details>,
 * weil `advancedSection` sie im Dialog unter „Weitere Einstellungen" legt (der
 * Loader stubt modal.js, das Markup hier traegt es deshalb nicht selbst).
 */
async function openForm({ mode = 'create', event = null, targets = TARGETS, defaultTarget = FAMILIE, assigned = [] } = {}) {
  calendar.state.defaultSyncTarget = defaultTarget;
  const markup = calendar.buildEventModalContent({ mode, event, date: '2026-10-02', reminder: [] });
  const group = /<select class="form-input" id="event-sync-target">[\s\S]*?<\/div>/.exec(markup)?.[0];
  assert.ok(group, 'der Dialog hat eine Zielwahl');

  const panel = new FakeEl('div');
  const add = (tag, id, props = {}, parent = panel) => parent.append(new FakeEl(tag, { id, ...props }));
  add('input', 'modal-title', { value: event?.title ?? 'Elternabend' });
  add('input', 'modal-allday', { type: 'checkbox' });
  add('div', 'time-fields');
  add('div', 'allday-fields');

  const ms = add('div', null, { classes: ['user-ms'], attrs: { 'data-ms-name': 'cal_assigned' } });
  for (const person of PEOPLE) {
    add('input', null, {
      type: 'checkbox', value: String(person.id), checked: assigned.includes(person.id),
      classes: ['user-ms__checkbox'], attrs: { 'data-ms-input': 'cal_assigned' },
    }, ms);
  }

  const details = add('details', null, { classes: ['form-advanced'] });
  add('select', 'event-sync-target', { classes: ['form-input'] }, details);
  for (const [, attrs, text] of group.matchAll(/<small class="form-hint"([^>]*)>([\s\S]*?)<\/small>/g)) {
    const hint = add('small', /id="([\w-]+)"/.exec(attrs)?.[1] ?? null, { classes: ['form-hint'] }, details);
    hint.hidden = /\shidden\b/.test(attrs);
    hint.textContent = text.trim();
  }

  add('button', 'modal-cancel');
  add('button', 'modal-save');

  globalThis.__apiStub = {
    get: async (path) => (path === '/calendar/sync-targets' ? { data: targets } : { data: [] }),
  };
  calendar.wireEventForm(panel, { mode, event, reminder: [] });
  delete globalThis.__apiStub;
  await settle();
  return panel;
}

const personBox = (panel, id) => panel
  .querySelectorAll('[data-ms-input="cal_assigned"]')
  .find((box) => box.value === String(id));

/** Die Hand an einem Kaestchen der Personenauswahl. */
async function userAssigns(panel, id, checked = true) {
  const box = personBox(panel, id);
  box.checked = checked;
  box.dispatch('change');
  await settle();
}

const target = (panel) => panel.querySelector('#event-sync-target').value;
const hint = (panel, selector) => {
  const el = panel.querySelector(selector);
  assert.ok(el, `${selector} steht im Markup des Dialogs`);
  return el;
};
const advancedOpen = (panel) => panel.querySelector('details').hasAttribute('open');

// --------------------------------------------------------------------------
// Der Messfall
// --------------------------------------------------------------------------

test('#1332: zwei Zugewiesene - der Dialog sagt, dass die Zuweisung nichts waehlt, und nennt, was gilt', async () => {
  const panel = await openForm();
  await userAssigns(panel, 3);
  await userAssigns(panel, 4);

  assert.equal(target(panel), FAMILIE, 'die Regel bleibt: kein Ziel ueber die Zuweisung, es gilt der eigene Standard');
  assert.equal(hint(panel, SEVERAL).hidden, false, 'der Hinweis steht da');
  assert.equal(hint(panel, SEVERAL).textContent, severalText('Familie'), 'er nennt den Kalender, der stattdessen gilt');
  assert.equal(hint(panel, AMBIGUOUS).hidden, true, 'der Mehrdeutig-Hinweis ist ein anderer Fall');
  assert.equal(advancedOpen(panel), true, 'die Einstellungen, in denen er steht, sind aufgeklappt');
});

test('#1332: ohne angebotenen Standard nennt der Hinweis "Nur lokal" - das, was wirklich eingestellt ist', async () => {
  const panel = await openForm({ defaultTarget: 'google:weg@group.calendar.google.com' });
  await userAssigns(panel, 3);
  await userAssigns(panel, 4);

  assert.equal(target(panel), '');
  assert.equal(hint(panel, SEVERAL).hidden, false);
  assert.equal(hint(panel, SEVERAL).textContent, severalText('calendar.syncTargetLocal'));
});

test('#1332: eine Person mit Kalender und eine ohne - allein haette die eine ihr Ziel bekommen, also steht der Hinweis', async () => {
  const panel = await openForm();
  await userAssigns(panel, 3);
  assert.equal(target(panel), EMMA);
  await userAssigns(panel, 1);

  assert.equal(target(panel), FAMILIE);
  assert.equal(hint(panel, SEVERAL).hidden, false);
});

// --------------------------------------------------------------------------
// Die Gegenrichtung: kein Rauschen
// --------------------------------------------------------------------------

test('#1332: eine Person mit Kalender - ihr Kalender ist das Ziel, kein Hinweis', async () => {
  const panel = await openForm();
  await userAssigns(panel, 4);

  assert.equal(target(panel), LEO);
  assert.equal(hint(panel, SEVERAL).hidden, true);
  assert.equal(hint(panel, AMBIGUOUS).hidden, true);
  assert.equal(advancedOpen(panel), false, 'nichts zu sagen, also bleibt zu, was zu war');
});

test('#1332: zwei Personen, die kein Kalender nennt - still der eigene Standard, wie bei einer Person ohne Kalender', async () => {
  const panel = await openForm();
  await userAssigns(panel, 1);
  await userAssigns(panel, 2);

  assert.equal(target(panel), FAMILIE);
  assert.equal(hint(panel, SEVERAL).hidden, true);
  assert.equal(advancedOpen(panel), false);
});

test('#1332: ein Haushalt ohne Sync-Ziele bekommt an zwei Personen keinen Hinweis', async () => {
  const panel = await openForm({ targets: { google: [], caldav: [], outlook: [] }, defaultTarget: '' });
  await userAssigns(panel, 3);
  await userAssigns(panel, 4);

  assert.equal(target(panel), '');
  assert.equal(hint(panel, SEVERAL).hidden, true);
});

test('#1332: nennen zwei Kalender dieselbe Person, bleibt es beim eigenen Wortlaut dieses Falls', async () => {
  const doppelt = {
    ...TARGETS,
    caldav: [...TARGETS.caldav, {
      accountId: 5, accountName: 'Mailbox', calendarUrl: 'https://dav.example.org/cal/emma/',
      calendarName: 'Emma Sport', defaultAssigneeUserId: 3,
    }],
  };
  const panel = await openForm({ targets: doppelt });
  await userAssigns(panel, 3);

  assert.equal(target(panel), FAMILIE);
  assert.equal(hint(panel, AMBIGUOUS).hidden, false);
  assert.equal(hint(panel, AMBIGUOUS).textContent, 'calendar.syncTargetAssigneeAmbiguous');
  assert.equal(hint(panel, SEVERAL).hidden, true, 'keine zweite Erklaerung daneben');
});

// --------------------------------------------------------------------------
// Ablauf
// --------------------------------------------------------------------------

test('#1332: der Hinweis kommt mit der zweiten Person und geht mit ihr', async () => {
  const panel = await openForm();
  await userAssigns(panel, 3);
  assert.equal(hint(panel, SEVERAL).hidden, true);

  await userAssigns(panel, 4);
  assert.equal(hint(panel, SEVERAL).hidden, false);

  await userAssigns(panel, 4, false);
  assert.equal(target(panel), EMMA, 'wieder eine Person - wieder ihr Kalender');
  assert.equal(hint(panel, SEVERAL).hidden, true);
});

test('#1332: eine Wahl von Hand beendet die Automatik samt Hinweis', async () => {
  const panel = await openForm();
  await userAssigns(panel, 3);
  await userAssigns(panel, 4);
  assert.equal(hint(panel, SEVERAL).hidden, false);

  const select = panel.querySelector('#event-sync-target');
  select.value = LEO;
  select.dispatch('change');
  assert.equal(hint(panel, SEVERAL).hidden, true, 'der genannte Kalender gilt nicht mehr');

  await userAssigns(panel, 4, false);
  assert.equal(target(panel), LEO, 'die eigene Wahl bleibt stehen');
  assert.equal(hint(panel, SEVERAL).hidden, true);
});

test('#1332: ein bestehender Termin mit zwei Personen zieht nicht um und erklaert nichts', async () => {
  const event = {
    id: 12, title: 'Elternabend', start_datetime: '2026-10-02T19:00', end_datetime: '2026-10-02T20:30',
    all_day: 0, created_by: 1, recurrence_rule: null, assigned_users: [{ id: 3 }, { id: 4 }],
    target_caldav_account_id: 4, target_caldav_calendar_url: 'https://dav.example.org/cal/leo/',
  };
  const panel = await openForm({ mode: 'edit', event, assigned: [3, 4] });
  await userAssigns(panel, 1);

  assert.equal(target(panel), LEO, 'das gespeicherte Ziel bleibt');
  assert.equal(hint(panel, SEVERAL).hidden, true);
});
