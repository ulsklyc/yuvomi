/**
 * Modul: Die Reichweite einer Aenderung an einem Serientermin (#1284)
 * Zweck: Wer einen Termin einer lokalen Serie bearbeitet - etwa eine Person
 *        zuweist -, gab die Aenderung bis hierhin in aller Regel genau diesem
 *        einen Termin: „Gilt für" stand als Auswahl unter den
 *        Wiederholungsfeldern, vorbelegt mit „Nur diesen Termin", und wer oben
 *        die Person anhakte und speicherte, sah es nicht. Alle uebrigen Termine
 *        blieben ohne Person (grauer Punkt, kein Avatar). Der Server tat, was er
 *        sollte; die Falle lag in der Oberflaeche.
 *
 *        Entscheidung (Variante A): die Reichweite fragt erst das SPEICHERN ab,
 *        als eigener Dialog mit drei Knoepfen ohne Vorauswahl - derselbe Dialog,
 *        den das Loeschen stellt. Abbrechen fuehrt zurueck ins Formular, ohne
 *        etwas zu senden. Keine Frage, wenn nichts geaendert ist, bei einem
 *        Einzeltermin und bei einer Serie aus einem anderen Kalender.
 *
 *        GEMESSEN WIRD AM AUFRUFER. Das Formular geht ueber `wireEventForm`,
 *        den echten Verdrahter, und gespeichert wird per Klick auf den echten
 *        Speichern-Knopf; der Dialog entsteht aus dem Markup, das der Kalender
 *        schreibt, und wird von dessen eigener Verdrahtung beantwortet
 *        (test/calendar-scope-question.js). Heraus kommt, was an den Server
 *        GEHT. Gestubt sind nur die Modal-Huelle und das Lesen der
 *        Personenauswahl - beides nicht Gegenstand dieser Suite.
 * Ausfuehren: npm run test:calendar-occurrence-scope
 */
import test from 'node:test';
import assert from 'node:assert/strict';

const toasts = [];
globalThis.window = globalThis.window ?? {};
globalThis.window.yuvomi = { showToast: (message, type) => toasts.push({ message, type }) };

const { __test: calendar } = await import('../public/pages/calendar.js');
const { scopeQuestion, settles } = await import('./calendar-scope-question.js');

// --------------------------------------------------------------------------
// Ein Formular-Doppel
//
// Kein jsdom (bewusst, siehe test/mini-dom.js). Das Doppel kann, was
// `wireEventForm` und `saveEvent` brauchen: Selektoren nach Tag, id, Klasse
// und Attribut, auch als Liste; Ereignisse, die nach oben laufen; und einen
// Klick, der die Rueckgabe seiner Listener abliefert, damit der Test auf das
// Speichern warten kann, das der Knopf ausloest.
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
    this.type = type ?? (tag === 'select' ? 'select-one' : tag === 'textarea' ? 'textarea' : tag === 'input' ? 'text' : undefined);
    this.value = value;
    this.textContent = '';
    this.style = {};
    this.options = [];
    const el = this;
    this.classList = {
      add: (c) => el.classes.add(c),
      remove: (c) => el.classes.delete(c),
      contains: (c) => el.classes.has(c),
      toggle: (c, on) => ((on ?? !el.classes.has(c)) ? el.classes.add(c) : el.classes.delete(c)),
    };
  }

  append(child) { child.parent = this; this.children.push(child); return child; }
  appendChild(child) { return this.append(child); }
  replaceChildren(...nodes) { this.children = []; for (const n of nodes) this.append(n); }
  get lastElementChild() { return this.children.at(-1) ?? null; }

  matches(selector) {
    if (selector.includes(',')) return selector.split(',').some((part) => this.matches(part.trim()));
    if (selector.startsWith('#')) return this.id === selector.slice(1);
    if (selector.startsWith('.')) return this.classes.has(selector.slice(1));
    const attr = /^\[([\w-]+)(?:="([^"]*)")?\]$/.exec(selector);
    if (attr) {
      if (!(attr[1] in this.attrs)) return false;
      return attr[2] === undefined || this.attrs[attr[1]] === attr[2];
    }
    if (/^[a-z]+$/.test(selector)) return this.tagName === selector.toUpperCase();
    const tagClass = /^([a-z]+)\.([\w-]+)$/.exec(selector);
    if (tagClass) return this.tagName === tagClass[1].toUpperCase() && this.classes.has(tagClass[2]);
    const classAttr = /^\.([\w-]+)\[([\w-]+)="([^"]*)"\]$/.exec(selector);
    if (classAttr) return this.classes.has(classAttr[1]) && this.attrs[classAttr[2]] === classAttr[3];
    return false;
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

  /** Ein Ereignis der Hand: am Ziel, dann aufwaerts. Liefert, was die Listener liefern. */
  dispatch(type) {
    const event = { type, target: this, preventDefault() {} };
    const results = [];
    for (let node = this; node; node = node.parent) {
      for (const fn of [...(node.listeners[type] ?? [])]) results.push(fn(event));
    }
    return results;
  }

  setAttribute(name, value) { this.attrs[name] = String(value); }
  getAttribute(name) { return name in this.attrs ? this.attrs[name] : null; }
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
// Termine
// --------------------------------------------------------------------------

// Ein Termin einer lokalen Serie, wie die Leseroute ihn liefert: Serie 41,
// woechentlich ab 18.09., geoeffnet ist das Vorkommen am 02.10. Ohne Person -
// genau der Ausgangsstand aus #1284.
const OCCURRENCE = {
  id: 99,
  title: 'Training',
  series_id: 41,
  recurrence_id: '2026-10-02',
  is_local_recurring_series: true,
  can_override_occurrence: true,
  recurrence_rule: 'FREQ=WEEKLY',
  is_recurring_instance: 1,
  is_series_start: 0,
  start_datetime: '2026-10-02T09:00',
  end_datetime: '2026-10-02T10:00',
  all_day: 0,
  created_by: 1,
  assigned_users: [],
  reminder_owner_id: 41,
  reminder_anchor_start: '2026-09-18T09:00',
};
const MASTER = {
  ...OCCURRENCE, id: 41, recurrence_id: null, is_recurring_instance: 0, is_series_start: 1,
  start_datetime: '2026-09-18T09:00', end_datetime: '2026-09-18T10:00',
};
const SINGLE = {
  id: 7, title: 'Zahnarzt', start_datetime: '2026-10-02T09:00', end_datetime: '2026-10-02T10:00',
  all_day: 0, created_by: 1, recurrence_rule: null, assigned_users: [],
};
// Eine Serie aus einem CalDAV-Kalender: Yuvomi kann sie nicht zerlegen, sie
// speichert wie bisher als Ganzes.
const EXTERNAL = {
  id: 55, title: 'Vereinstraining', series_id: 55, recurrence_id: '2026-10-02',
  recurrence_rule: 'FREQ=WEEKLY', is_local_recurring_series: false, external_source: 'caldav',
  calendar_ref_id: 3, start_datetime: '2026-10-02T18:00', end_datetime: '2026-10-02T19:30',
  all_day: 0, created_by: 1, assigned_users: [],
};
// Lokale Serie, an der dieser Nutzer keine Einzeltermine abspalten darf.
const RESTRICTED = { ...OCCURRENCE, can_override_occurrence: false, can_detach_occurrence: false };
// Lokale Serie mit Sync-Ziel: kein verknuepfter Einzeltermin, der alte Weg
// (Einzeltermin + Ausnahme) - die Frage gilt dort genauso.
const DETACH_ONLY = {
  ...OCCURRENCE, can_override_occurrence: false, can_detach_occurrence: true,
  target_caldav_account_id: 4, target_caldav_calendar_url: 'https://dav.test/family/',
};

const PEOPLE = [{ id: 2, name: 'Alex' }, { id: 3, name: 'Kim' }];

/**
 * Das Formular eines Termins, verdrahtet wie im Browser. `syncTargets`
 * beantwortet GET /calendar/sync-targets beim Verdrahten.
 */
function openForm(event, { syncTargets = null, attachment = false } = {}) {
  const panel = new FakeEl('div');
  const add = (tag, id, props = {}, parent = panel) => parent.append(new FakeEl(tag, { id, ...props }));
  add('input', 'modal-title', { value: event.title });
  add('input', 'modal-allday', { type: 'checkbox', checked: !!event.all_day });
  add('div', 'time-fields');
  add('div', 'allday-fields');
  add('input', 'modal-start-date', { value: event.start_datetime.slice(0, 10) });
  add('input', 'modal-start-time', { value: event.start_datetime.slice(11, 16) });
  add('input', 'modal-end-date', { value: event.end_datetime.slice(0, 10) });
  add('input', 'modal-end-time', { value: event.end_datetime.slice(11, 16) });
  add('input', 'modal-allday-start', { value: event.start_datetime.slice(0, 10) });
  add('input', 'modal-allday-end', { value: event.end_datetime.slice(0, 10) });
  add('input', 'modal-location', { value: event.location ?? '' });
  add('textarea', 'modal-description', { value: event.description ?? '' });
  add('input', 'modal-icon', { type: 'hidden', value: 'calendar' });
  add('select', 'modal-visibility', { value: 'all' });
  add('input', 'modal-countdown', { type: 'checkbox' });

  // Farbwahl: der Erben-Swatch und eine eigene Farbe, als role="radio" mit
  // aria-checked wie im Dialog.
  const picker = add('div', 'event-color-picker');
  for (const color of ['', '#FF9500']) {
    const swatch = add('button', null, { classes: ['color-swatch'], attrs: { role: 'radio', 'aria-checked': 'false' } }, picker);
    swatch.dataset.color = color;
  }

  // Personenauswahl: je Person ein Kaestchen, wie components/user-multi-select.js.
  const ms = add('div', null, { classes: ['user-ms'], attrs: { 'data-ms-name': 'cal_assigned' } });
  const assigned = new Set((event.assigned_users ?? []).map((u) => u.id));
  for (const person of PEOPLE) {
    add('input', null, {
      type: 'checkbox', value: String(person.id), checked: assigned.has(person.id),
      classes: ['user-ms__checkbox'], attrs: { 'data-ms-input': 'cal_assigned' },
    }, ms);
  }

  if (syncTargets) add('select', 'event-sync-target');
  if (attachment) {
    add('div', 'modal-selected-attachment');
    add('button', 'modal-remove-attachment');
  }

  // Erinnerungen: aus, keine Zeilen - der Termin hat keine.
  add('input', 'modal-reminder-toggle', { type: 'checkbox' });
  const fields = add('div', 'modal-reminder-fields');
  add('div', 'modal-reminder-rows', {}, fields);

  add('button', 'modal-cancel');
  add('button', 'modal-save');

  globalThis.__apiStub = syncTargets
    ? { get: async (path) => (path === '/calendar/sync-targets' ? { data: syncTargets } : { data: [] }) }
    : undefined;
  calendar.wireEventForm(panel, { mode: 'edit', event: { ...event, attachment_name: attachment ? 'plan.pdf' : null }, reminder: [] });
  delete globalThis.__apiStub;
  return panel;
}

const personBox = (panel, id) => panel
  .querySelectorAll('[data-ms-input="cal_assigned"]')
  .find((box) => box.value === String(id));

/** Die Hand an einem Kaestchen oder Feld. */
function userChecks(box, checked = true) {
  box.checked = checked;
  box.dispatch('change');
}
function userTypes(el, value) {
  el.value = value;
  el.dispatch('input');
}

/**
 * Klickt „Speichern" und gibt zurueck, was geschah: die Anfragen an den
 * Server, die Dialoge, die dabei aufgingen, und ein Protokoll aus Frage,
 * Antwort und Schliessen - in der Reihenfolge, in der es passierte.
 *
 * Nach den Anfragen rendert `saveEvent` die Ansicht neu, und die gibt es in
 * dieser Suite nicht - das endet in einem Fehler-Toast. Er ist ein Artefakt der
 * Umgebung; gemessen werden die Anfragen, und die liegen alle davor.
 */
async function clickSave(panel, event, { answer, whileOpen = null } = {}) {
  const calls = [];
  const log = [];
  globalThis.__apiStub = {
    get: async (path) => {
      calls.push({ method: 'get', path });
      if (path === `/calendar/${MASTER.id}`) return { data: MASTER };
      return { data: [] };
    },
    post: async (path, body) => { calls.push({ method: 'post', path, body }); return { data: { id: 500 } }; },
    put: async (path, body) => {
      calls.push({ method: 'put', path, body });
      const id = /^\/calendar\/(\d+)/.exec(path)?.[1];
      return { data: id ? { ...event, id: Number(id) } : [] };
    },
    patch: async (path, body) => { calls.push({ method: 'patch', path, body }); return { data: null }; },
    delete: async (path) => { calls.push({ method: 'delete', path }); return { data: null }; },
  };
  globalThis.__rruleValues = { recurrence_rule: event.recurrence_rule ?? null, valid_until: true };
  globalThis.__closeModal = (options) => log.push(['close', options ?? {}]);
  globalThis.__askOverModal = async (ask) => {
    log.push(['ask']);
    const choice = await ask();
    log.push(['answer', choice]);
    return choice;
  };
  globalThis.__confirmOverModal = async (title) => { log.push(['confirm', title]); return true; };
  const question = scopeQuestion(answer);
  try {
    const running = Promise.all(panel.querySelector('#modal-save').dispatch('click'));
    if (whileOpen) {
      // Einen Umlauf warten: alles, was vor der Antwort geschehen kann, ist dann geschehen.
      await new Promise((resolve) => setImmediate(resolve));
      await whileOpen({ calls, log, dialogs: question.dialogs });
    }
    await settles(running, 'Speichern');
  } finally {
    question.uninstall();
    for (const hook of ['__apiStub', '__rruleValues', '__closeModal', '__askOverModal', '__confirmOverModal']) {
      delete globalThis[hook];
    }
  }
  return { calls, log, dialogs: question.dialogs, writes: calls.filter((c) => c.method !== 'get') };
}

/** Schloss das Speichern das Formular? Der Dialog schliesst sich selbst - das zaehlt nicht. */
const formClosed = (log) => {
  const afterQuestion = log.findLastIndex((entry) => entry[0] === 'answer');
  return log.slice(afterQuestion + 1).some((entry) => entry[0] === 'close');
};

// --------------------------------------------------------------------------
// Der Fall aus #1284
// --------------------------------------------------------------------------

test('#1284: Person an einem Serientermin geaendert - ohne Wahl geht NICHTS an den Server', async () => {
  const panel = openForm(OCCURRENCE);
  userChecks(personBox(panel, 2));
  const { dialogs, writes } = await clickSave(panel, OCCURRENCE, {
    whileOpen: async ({ calls, dialogs: open }) => {
      assert.deepEqual(calls, [], 'solange die Frage offen ist, geht keine Anfrage raus - auch kein Vorkommen');
      assert.equal(open.length, 1, 'das Speichern stellt die Frage');
      open[0].respond('series');
    },
  });
  assert.equal(dialogs.length, 1);
  assert.ok(writes.length > 0, 'nach der Wahl wird gespeichert');
});

test('Wahl „Ganze Serie": die Person geht an die Serie, nicht an einen Einzeltermin', async () => {
  const panel = openForm(OCCURRENCE);
  userChecks(personBox(panel, 2));
  const { writes, log } = await clickSave(panel, OCCURRENCE, { answer: 'series' });
  const put = writes.find((c) => c.method === 'put' && c.path === '/calendar/41');
  assert.ok(put, 'die Serie wurde gespeichert');
  assert.deepEqual(put.body.assigned_to, [2], 'mit der Person');
  assert.equal(put.body.start_datetime, '2026-09-18T09:00', 'am Serienbeginn, nicht am geoeffneten Termin');
  assert.equal(writes.some((c) => c.path.includes('/occurrences/')), false, 'kein Einzeltermin');
  assert.ok(formClosed(log), 'danach schliesst das Formular');
});

test('Wahl „Nur diesen Termin": genau dieser Termin, mit der Person', async () => {
  const panel = openForm(OCCURRENCE);
  userChecks(personBox(panel, 2));
  const { writes } = await clickSave(panel, OCCURRENCE, { answer: 'this' });
  const put = writes.find((c) => c.method === 'put');
  assert.equal(put?.path, '/calendar/41/occurrences/2026-10-02');
  assert.deepEqual(put.body.assigned_to, [2]);
  assert.equal(writes.some((c) => c.path === '/calendar/41'), false, 'die Serie bleibt unberuehrt');
});

test('Wahl „Diesen und folgende": der Schnitt ab diesem Termin', async () => {
  const panel = openForm(OCCURRENCE);
  userChecks(personBox(panel, 3));
  const { writes } = await clickSave(panel, OCCURRENCE, { answer: 'following' });
  const put = writes.find((c) => c.method === 'put');
  assert.equal(put?.path, '/calendar/41/occurrences/2026-10-02/following');
  assert.deepEqual(put.body.assigned_to, [3]);
});

test('Abbrechen: nichts gesendet, das Formular bleibt offen und bedienbar', async () => {
  const panel = openForm(OCCURRENCE);
  userChecks(personBox(panel, 2));
  const { calls, log } = await clickSave(panel, OCCURRENCE, { answer: 'cancel' });
  assert.deepEqual(calls, [], 'keine Anfrage');
  assert.deepEqual(log.map(([kind]) => kind), ['ask', 'close', 'answer'],
    'nur der Dialog schliesst sich - das Formular nicht');
  assert.equal(formClosed(log), false);
  assert.equal(panel.querySelector('#modal-save').disabled, false, 'Speichern ist wieder frei');
  assert.equal(personBox(panel, 2).checked, true, 'die Eingabe ist noch da');
});

test('Escape, X oder Overlay sind Abbrechen', async () => {
  const panel = openForm(OCCURRENCE);
  userChecks(personBox(panel, 2));
  const { calls, log } = await clickSave(panel, OCCURRENCE, { answer: 'dismiss' });
  assert.deepEqual(calls, []);
  assert.equal(formClosed(log), false);
});

test('nach dem Abbrechen fragt das naechste Speichern erneut - und speichert dann', async () => {
  const panel = openForm(OCCURRENCE);
  userChecks(personBox(panel, 2));
  await clickSave(panel, OCCURRENCE, { answer: 'cancel' });
  const { dialogs, writes } = await clickSave(panel, OCCURRENCE, { answer: 'series' });
  assert.equal(dialogs.length, 1, 'die Frage kommt wieder, sie ist nicht gemerkt');
  assert.deepEqual(writes.find((c) => c.path === '/calendar/41')?.body.assigned_to, [2]);
});

test('die Frage steht UEBER dem Formular, sie ersetzt es nicht', async () => {
  // openModal allein raeumt ein offenes Modal weg (kein Stapeln). Ohne
  // askOverModal verloere das Abbrechen die Eingaben, statt dorthin
  // zurueckzufuehren.
  const panel = openForm(OCCURRENCE);
  userChecks(personBox(panel, 2));
  const { log, dialogs } = await clickSave(panel, OCCURRENCE, { answer: 'this' });
  assert.equal(log[0][0], 'ask', 'der Dialog geht ueber askOverModal auf');
  assert.equal(dialogs.length, 1);
});

test('der Dialog: drei Knoepfe ohne Vorauswahl, eine Gruppe mit Namen, Abbrechen', async () => {
  const panel = openForm(OCCURRENCE);
  userChecks(personBox(panel, 2));
  const { dialogs } = await clickSave(panel, OCCURRENCE, { answer: 'cancel' });
  const { options, buttons } = dialogs[0];
  assert.equal(options.title, 'calendar.saveRecurringTitle');
  const choices = buttons.filter((b) => 'data-scope' in b.attrs);
  assert.deepEqual(choices.map((b) => [b.attrs['data-scope'], b.label]), [
    ['this', 'calendar.recurringScopeThis'],
    ['following', 'calendar.recurringScopeFollowing'],
    ['series', 'calendar.recurringScopeSeries'],
  ]);
  // Keine Antwort ist vorgegeben: kein Knopf traegt ein anderes Gewicht als
  // die anderen, keiner ist vorgewaehlt oder bekommt den Fokus.
  assert.equal(new Set(choices.map((b) => b.attrs.class)).size, 1, 'alle drei Knoepfe sehen gleich aus');
  assert.ok(choices.every((b) => b.attrs.type === 'button'));
  assert.doesNotMatch(options.content, /\b(selected|checked|autofocus|aria-pressed)\b|btn--primary/);
  assert.doesNotMatch(options.content, /<select\b/, 'kein Select - Knoepfe');
  const group = /role="group" aria-labelledby="([^"]+)"/.exec(options.content);
  assert.ok(group, 'die Knoepfe stehen in einer benannten Gruppe');
  assert.match(options.content, new RegExp(`id="${group[1]}">calendar\\.recurringScopeLabel<`));
  assert.equal(buttons.find((b) => b.id === 'recurring-scope-cancel')?.label, 'common.cancel');
});

// --------------------------------------------------------------------------
// Wo die Frage NICHT kommt
// --------------------------------------------------------------------------

test('nichts geaendert: keine Frage, keine Anfrage - das Speichern schliesst nur', async () => {
  const panel = openForm(OCCURRENCE);
  const { calls, log, dialogs } = await clickSave(panel, OCCURRENCE, { answer: 'this' });
  assert.equal(dialogs.length, 0, 'keine Frage');
  assert.deepEqual(calls, [], 'und kein Einzeltermin, der nur den Stand der Serie kopiert');
  assert.deepEqual(log, [['close', { force: true }]], 'das Formular geht zu');
});

test('geaendert und zurueckgestellt ist nicht geaendert', async () => {
  const panel = openForm(OCCURRENCE);
  userChecks(personBox(panel, 2));
  userChecks(personBox(panel, 2), false);
  userTypes(panel.querySelector('#modal-title'), 'Training!');
  userTypes(panel.querySelector('#modal-title'), 'Training');
  const { dialogs, calls } = await clickSave(panel, OCCURRENCE, { answer: 'this' });
  assert.equal(dialogs.length, 0);
  assert.deepEqual(calls, []);
});

test('jedes Bedienelement zaehlt: Text, Farbe (aria-checked), Anhang', async () => {
  const title = openForm(OCCURRENCE);
  userTypes(title.querySelector('#modal-title'), 'Training (Halle 2)');
  assert.equal((await clickSave(title, OCCURRENCE, { answer: 'cancel' })).dialogs.length, 1, 'Titel');

  const color = openForm(OCCURRENCE);
  color.querySelectorAll('.color-swatch')[1].dispatch('click');
  assert.equal((await clickSave(color, OCCURRENCE, { answer: 'cancel' })).dialogs.length, 1, 'Farbe');

  const file = openForm(OCCURRENCE, { attachment: true });
  file.querySelector('#modal-remove-attachment').dispatch('click');
  assert.equal((await clickSave(file, OCCURRENCE, { answer: 'cancel' })).dialogs.length, 1, 'Anhang entfernt');
});

test('ohne Ausgangsstand wird gefragt, nicht still geschlossen', async () => {
  // Ein Formular, das nie durch wireEventForm lief, hat keinen Vergleichswert.
  // „Nichts geaendert" laesst sich dann nicht belegen - also die Frage.
  const panel = openForm(OCCURRENCE);
  const unwired = new FakeEl('div');
  for (const child of [...panel.children]) unwired.append(child);
  const question = scopeQuestion('cancel');
  try {
    await settles(calendar.saveEvent(unwired, 'edit', OCCURRENCE, [], null), 'Speichern');
  } finally {
    question.uninstall();
  }
  assert.equal(question.dialogs.length, 1);
});

test('das nachgeladene Sync-Ziel ist Ausgangsstand, keine Aenderung', async () => {
  // loadSyncTargets stellt das bestehende Ziel erst nach dem Laden ein. Ohne
  // dass das in den Ausgangsstand eingeht, fragte jedes Speichern eines
  // unveraenderten Termins mit Sync-Ziel.
  const panel = openForm(DETACH_ONLY, {
    syncTargets: { caldav: [{ accountId: 4, accountName: 'Familie', calendarUrl: 'https://dav.test/family/', calendarName: 'Familie' }] },
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(panel.querySelector('#event-sync-target').value, 'caldav:4|https://dav.test/family/',
    'das Ziel ist geladen und eingestellt');
  const { dialogs, calls } = await clickSave(panel, DETACH_ONLY, { answer: 'this' });
  assert.equal(dialogs.length, 0);
  assert.deepEqual(calls, []);
});

test('Einzeltermin: keine Frage, gespeichert wie bisher (Regression)', async () => {
  const panel = openForm(SINGLE);
  userChecks(personBox(panel, 2));
  const { dialogs, writes } = await clickSave(panel, SINGLE, { answer: 'this' });
  assert.equal(dialogs.length, 0);
  assert.equal(writes.find((c) => c.method === 'put')?.path, '/calendar/7');
  assert.deepEqual(writes.find((c) => c.method === 'put').body.assigned_to, [2]);
});

test('Einzeltermin ohne Aenderung speichert weiter wie bisher (Regression)', async () => {
  const panel = openForm(SINGLE);
  const { dialogs, writes } = await clickSave(panel, SINGLE, { answer: 'this' });
  assert.equal(dialogs.length, 0);
  assert.equal(writes.find((c) => c.method === 'put')?.path, '/calendar/7');
});

test('Serie aus einem anderen Kalender: keine Frage, die ganze Serie wie bisher (Regression)', async () => {
  const panel = openForm(EXTERNAL);
  userChecks(personBox(panel, 2));
  const { dialogs, writes } = await clickSave(panel, EXTERNAL, { answer: 'this' });
  assert.equal(dialogs.length, 0);
  const put = writes.find((c) => c.method === 'put');
  assert.equal(put?.path, '/calendar/55');
  assert.deepEqual(put.body.assigned_to, [2]);
});

test('lokale Serie ohne Recht auf Einzeltermine: die Ganze-Serie-Bestaetigung, keine Reichweitenfrage (Regression)', async () => {
  const panel = openForm(RESTRICTED);
  userChecks(personBox(panel, 2));
  const { dialogs, writes, log } = await clickSave(panel, RESTRICTED, { answer: 'this' });
  assert.equal(dialogs.length, 0, 'keine Frage nach einer Reichweite, die es nicht gibt');
  assert.deepEqual(log[0], ['confirm', 'calendar.editWholeSeriesOnlyTitle']);
  assert.equal(writes.find((c) => c.method === 'put')?.path, '/calendar/41');
});

test('lokale Serie mit Sync-Ziel: dieselbe Frage, „Nur diesen" nimmt den alten Weg', async () => {
  const panel = openForm(DETACH_ONLY);
  userChecks(personBox(panel, 2));
  const { dialogs, writes } = await clickSave(panel, DETACH_ONLY, { answer: 'this' });
  assert.equal(dialogs.length, 1);
  assert.deepEqual(writes.map((c) => [c.method, c.path]).slice(0, 2), [
    ['post', '/calendar'],
    ['post', '/calendar/41/exceptions'],
  ]);
  assert.deepEqual(writes[0].body.assigned_to, [2]);
});

// --------------------------------------------------------------------------
// Das Formular stellt die Frage nicht mehr selbst
// --------------------------------------------------------------------------

test('das Bearbeiten-Formular traegt kein „Gilt für" mehr - zwei Wege zu derselben Frage waeren einer zu viel', () => {
  const markup = calendar.buildEventModalContent({ mode: 'edit', event: OCCURRENCE, reminder: [] });
  assert.doesNotMatch(markup, /-scope"/, 'keine Scope-Auswahl im Formular');
  assert.doesNotMatch(markup, /calendar\.recurringScope/, 'und keine ihrer Optionen');
});

// --------------------------------------------------------------------------
// Loeschen stellt DIESELBE Frage
// --------------------------------------------------------------------------

test('Loeschen eines Serientermins: derselbe Dialog, dieselben Knoepfe, nur Titel und Ton anders', async () => {
  const panel = openForm(OCCURRENCE);
  userChecks(personBox(panel, 2));
  const saved = (await clickSave(panel, OCCURRENCE, { answer: 'cancel' })).dialogs[0];

  const question = scopeQuestion('cancel');
  const calls = [];
  globalThis.__apiStub = { delete: async (path) => { calls.push(path); return { data: null }; } };
  try {
    await settles(calendar.requestDeleteEvent(OCCURRENCE), 'Loeschen');
  } finally {
    question.uninstall();
    delete globalThis.__apiStub;
  }
  const deleted = question.dialogs[0];
  assert.ok(deleted, 'das Loeschen fragt');
  assert.equal(deleted.options.title, 'calendar.deleteRecurringTitle');
  const scopes = (dialog) => dialog.buttons.map((b) => [b.attrs['data-scope'] ?? b.id, b.label]);
  assert.deepEqual(scopes(deleted), scopes(saved), 'dieselben Knoepfe mit denselben Texten');
  assert.match(deleted.buttons[0].attrs.class, /btn--danger-outline/, 'loeschen ist als zerstoerend ausgewiesen');
  assert.deepEqual(calls, [], 'Abbrechen loescht nichts');
});

// --------------------------------------------------------------------------
// DER DIALOG NENNT DAS VORKOMMEN (Review zu #1295)
//
// Mit dem Auswahlfeld verschwand auch der nachgefuehrte Hinweis, der das
// Datum nannte (`calendar.recurringScopeHint*`) - und mit ihm die Auskunft,
// WELCHEN Termin die drei Knoepfe meinen. Beim Loeschen wiegt das am
// schwersten: dort ist der Dialog das Einzige auf dem Schirm.
//
// Gemessen wird die Zeile, die der Kalender WIRKLICH schreibt, samt der Werte,
// die er in sie einsetzt - nicht das Vorkommen des Schluessels im Quelltext.
// --------------------------------------------------------------------------

const UNESCAPE = [['&quot;', '"'], ['&#039;', "'"], ['&lt;', '<'], ['&gt;', '>'], ['&amp;', '&']];
const unescape = (text) => UNESCAPE.reduce((acc, [from, to]) => acc.replaceAll(from, to), text);

/** Die Detailzeilen des Dialogs, in der Reihenfolge des Markups. */
function detailLines(content) {
  return [...String(content ?? '').matchAll(/<p class="modal-confirm__detail"[^>]*>([\s\S]*?)<\/p>/g)]
    .map(([, text]) => text.trim());
}

/**
 * Was der Dialog ueber das Vorkommen sagt: der Schluessel seiner ersten
 * Detailzeile und die Werte, die die Seite eingesetzt hat. Der Stub von `t`
 * haengt die Werte als JSON an den Schluessel; `esc` hat sie davor durch die
 * HTML-Maskierung geschickt, und genau das wird hier rueckgaengig gemacht -
 * dass es noetig ist, ist der Beleg fuer die Maskierung.
 */
function occurrenceLine(dialog) {
  const [line] = detailLines(dialog.options.content);
  assert.ok(line, 'der Dialog hat keine Detailzeile');
  const key = 'calendar.recurringScopeOccurrence';
  assert.ok(line.startsWith(key), `die erste Detailzeile nennt das Vorkommen nicht: ${line}`);
  return { raw: line, values: JSON.parse(unescape(line.slice(key.length))) };
}

/** Oeffnet den Loeschdialog und beantwortet ihn; liefert Dialog und Anfragen. */
async function clickDelete(event, { answer = 'cancel' } = {}) {
  const question = scopeQuestion(answer);
  const calls = [];
  globalThis.__apiStub = { delete: async (path) => { calls.push(path); return { data: null }; } };
  try {
    await settles(calendar.requestDeleteEvent(event), 'Loeschen');
  } finally {
    question.uninstall();
    delete globalThis.__apiStub;
  }
  return { dialog: question.dialogs[0], calls };
}

test('Speichern: der Dialog nennt Titel und Datum des angetippten Vorkommens', async () => {
  const panel = openForm(OCCURRENCE);
  userChecks(personBox(panel, 2));
  const { dialogs } = await clickSave(panel, OCCURRENCE, { answer: 'cancel' });
  const { values } = occurrenceLine(dialogs[0]);
  assert.equal(values.date, '2026-10-02', 'das Datum des geoeffneten Vorkommens');
  assert.equal(values.title, 'Training', 'und sein Titel');
});

test('Loeschen: derselbe Satz - hier ist der Dialog das Einzige auf dem Schirm', async () => {
  const { dialog } = await clickDelete(OCCURRENCE);
  const { values } = occurrenceLine(dialog);
  assert.equal(values.date, '2026-10-02');
  assert.equal(values.title, 'Training');
});

test('die Zeile steht UEBER der Frage und beschreibt die Gruppe, statt sie zu benennen', async () => {
  const { dialog } = await clickDelete(OCCURRENCE);
  const { content } = dialog.options;
  const lines = detailLines(content);
  assert.equal(lines.length, 2, 'Vorkommen, dann „Gilt für"');
  assert.ok(lines[0].startsWith('calendar.recurringScopeOccurrence'));
  assert.equal(lines[1], 'calendar.recurringScopeLabel');
  // Der Name der Knopfgruppe bleibt „Gilt für". Stuende das Vorkommen in
  // aria-labelledby, verlaengerte es den Namen jedes einzelnen Knopfes.
  const group = /role="group" aria-labelledby="([^"]+)" aria-describedby="([^"]+)"/.exec(content);
  assert.ok(group, 'die Gruppe nennt Name und Beschreibung');
  assert.equal(group[1], 'recurring-scope-label');
  assert.equal(group[2], 'recurring-scope-occurrence');
  assert.match(content, /id="recurring-scope-occurrence">calendar\.recurringScopeOccurrence/);
});

test('das Datum ist der Tag der Anzeigezone, nicht der UTC-Tag', async () => {
  // Ein Vorkommen kurz nach Mitternacht: in Europe/Berlin (die Suite nagelt
  // die Zone fest) liegt sein Zeitpunkt noch im Vortag nach UTC. Wer
  // `toISOString().slice(0, 10)` schriebe, benennte hier den 1. Oktober und
  // schnitte die Serie in der Auskunft einen Tag zu frueh ab.
  const afterMidnight = {
    ...OCCURRENCE,
    recurrence_id: '2026-10-02',
    start_datetime: '2026-10-02T00:30',
    end_datetime: '2026-10-02T01:30',
  };
  assert.equal(new Date(afterMidnight.start_datetime).toISOString().slice(0, 10), '2026-10-01',
    'die Gegenprobe selbst: der UTC-Tag IST hier der Nachbartag');
  const { dialog } = await clickDelete(afterMidnight);
  assert.equal(occurrenceLine(dialog).values.date, '2026-10-02');
});

test('ein Termintitel ist Userdaten und kommt maskiert im Markup an', async () => {
  const { dialog } = await clickDelete({ ...OCCURRENCE, title: '<img src=x onerror="alert(1)">' });
  const { raw, values } = occurrenceLine(dialog);
  assert.equal(values.title, '<img src=x onerror="alert(1)">', 'der Titel geht unveraendert in den Text');
  assert.doesNotMatch(raw, /<img/, 'aber nicht als Markup in den Dialog');
  assert.match(raw, /&lt;img/);
});
