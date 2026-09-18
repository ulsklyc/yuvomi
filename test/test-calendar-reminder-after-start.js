/**
 * Modul: Erinnerung nach dem Terminbeginn im Kalender-Dialog (#1260)
 * Zweck: `remind_at` ist ein absoluter Zeitpunkt, die Auswahl einer
 *        Erinnerungszeile kennt nur Vorlaeufe. Liegt eine Erinnerung NACH dem
 *        Beginn - der Termin wurde per Ziehen, Sync oder API hinter sie
 *        geschoben -, las der Dialog sie als „Benutzerdefiniert, 1 Minute",
 *        und das naechste Speichern schob sie dorthin: Termin 18.09. 09:00 mit
 *        Erinnerung am 25.09. landete nach einem Speichern ohne jeden Handgriff
 *        am 18.09. um 08:59. Der Aufgaben-Dialog hat dieselbe Fehlerklasse in
 *        #1261 verloren; der Kalender rechnet ueber eigene Helfer und hat
 *        MEHRERE Zeilen je Termin.
 *
 *        Entscheidung (a) + (c): die Zeile bekommt einen eigenen Zustand mit
 *        Warnton, der den tatsaechlichen Zeitpunkt nennt, und das Speichern
 *        reicht den gespeicherten Zeitpunkt dieser Zeile unveraendert durch,
 *        solange niemand die Zeile anfasst. (b), ein negativer Betrag, ist
 *        verworfen.
 *
 *        GEMESSEN WIRD AM AUFRUFER. Das Markup, das der Dialog schreibt, geht
 *        vorne hinein; verdrahtet wird ueber `wireEventForm`, den echten
 *        Verdrahter; und heraus kommt, was `saveEvent` WIRKLICH an den Server
 *        schickt. Ein Test gegen die Helfer dazwischen bewiese nur, dass sie
 *        tun, was sie tun - die Verdrahtung ist der haeufigste Ausfall.
 *
 *        Abgedeckt: der Messfall des Issues, eine normale Vorher-Erinnerung
 *        (Regression), die Mehrfachzeilen (neben normalen, zwei davon, die
 *        Obergrenze), die angefasste Zeile, ein verschobener Beginn in beide
 *        Richtungen, die Serienwege (ganze Serie, „nur dieser" unberuehrt und
 *        mit Aenderung daneben) und die Leseansicht, die denselben Zeitpunkt
 *        nennen muss.
 *
 *        Zone fest auf Europe/Berlin (das npm-Script setzt sie, die Zeile
 *        unten fuer den Direktaufruf): 09:00 Ortszeit ist 07:00 UTC, ein
 *        UTC-Rechenfehler faellt also auf.
 * Ausfuehren: npm run test:calendar-reminder-after-start
 */
import test from 'node:test';
import assert from 'node:assert/strict';

process.env.TZ = 'Europe/Berlin';

const toasts = [];
globalThis.window = globalThis.window ?? {};
globalThis.window.yuvomi = { showToast: (message, type) => toasts.push({ message, type }) };

const { __test: calendar } = await import('../public/pages/calendar.js');
const recurrenceScope = await import('../public/utils/recurrence-scope.js');
const { scopeQuestion, settles } = await import('./calendar-scope-question.js');

// Der Messfall aus dem Issue: Beginn 18.09. 09:00 Ortszeit (07:00 UTC), die
// Erinnerung sieben Tage spaeter, 25.09. 06:00 UTC = 08:00 Ortszeit.
const EVENT = {
  id: 7,
  title: 'Zahnarzt',
  start_datetime: '2026-09-18T09:00',
  end_datetime: '2026-09-18T10:00',
  all_day: 0,
  created_by: 1,
  recurrence_rule: null,
};
const AFTER = { remind_at: '2026-09-25T06:00:00' };
const AFTER_2 = { remind_at: '2026-09-20T10:00:00' };
const DAY_BEFORE = { remind_at: '2026-09-17T07:00:00' };     // 1440 Minuten vorher
const QUARTER_BEFORE = { remind_at: '2026-09-18T06:45:00' }; // 15 Minuten vorher
const HOUR_BEFORE = { remind_at: '2026-09-18T06:00:00' };    // 60 Minuten vorher

// --------------------------------------------------------------------------
// Ein Dialog-Doppel aus dem ECHTEN Markup
//
// Kein jsdom (bewusst, siehe test/mini-dom.js). Das Doppel kann genau, was der
// Dialog braucht: Selektoren nach id, Klasse und Attribut, `closest`, Ereignisse,
// die wie im Browser nach oben laufen (die Zeilen-Listener haengen per
// Delegation an #modal-reminder-rows), und ein <select>, dessen `value` nur
// annimmt, was es als Eintrag fuehrt. Die Erinnerungszeilen entstehen aus dem
// Markup, das `renderCalendarReminderSection` schreibt - nicht aus Werten, die
// diese Datei setzt.
// --------------------------------------------------------------------------

class FakeEl {
  constructor(tag, { id = null, classes = [], attrs = {} } = {}) {
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
    this.checked = false;
    this.style = {};
    this.textContent = '';
    this.options = null;
    this._value = '';
  }

  get value() {
    if (this.options) return this.options.find((o) => o.selected)?.value ?? '';
    return this._value;
  }

  // Wie im Browser: ein Wert, den die Auswahl nicht fuehrt, laesst sie leer.
  set value(next) {
    if (this.options) {
      const target = this.options.find((o) => o.value === String(next));
      for (const option of this.options) option.selected = option === target;
      return;
    }
    this._value = String(next);
  }

  append(child) { child.parent = this; this.children.push(child); return child; }
  remove() {
    if (this.parent) this.parent.children = this.parent.children.filter((c) => c !== this);
    this.parent = null;
  }
  get lastElementChild() { return this.children.at(-1) ?? null; }

  matches(selector) {
    // Listen und Tag-Namen: das Speichern eines Serientermins liest jedes
    // Bedienelement des Formulars (#1284, `input, select, textarea`).
    if (selector.includes(',')) return selector.split(',').some((part) => this.matches(part.trim()));
    if (selector.startsWith('#')) return this.id === selector.slice(1);
    if (selector.startsWith('.')) return this.classes.has(selector.slice(1));
    const attr = /^\[([\w-]+)\]$/.exec(selector);
    if (attr) return attr[1] in this.attrs;
    if (/^[a-z]+$/.test(selector)) return this.tagName === selector.toUpperCase();
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

  /** Ein Ereignis der Hand: am Ziel, dann aufwaerts. */
  dispatch(type) {
    const event = { type, target: this, preventDefault() {} };
    for (let node = this; node; node = node.parent) {
      for (const fn of [...(node.listeners[type] ?? [])]) fn(event);
    }
  }

  setAttribute(name, value) { this.attrs[name] = String(value); }
  getAttribute(name) { return this.attrs[name] ?? null; }

  insertAdjacentHTML(_position, html) {
    for (const row of rowsFromMarkup(html)) this.append(row);
  }
}

const unescape = (value) => String(value)
  .replaceAll('&quot;', '"').replaceAll('&#039;', "'")
  .replaceAll('&lt;', '<').replaceAll('&gt;', '>').replaceAll('&amp;', '&');

/**
 * Text eines Markup-Stuecks ohne Tags, fuer die Zusicherung am sichtbaren Wortlaut.
 * Bewusst eine Index-Schleife statt `replace(/<[^>]+>/g, '')`: CodeQL bewertet
 * jedes solche `replace` isoliert als unvollstaendige Bereinigung
 * (js/incomplete-multi-character-sanitization), auch in Testdateien, und ein
 * unterminiertes `<` liefe an der Regex vorbei. Hier endet es den Text.
 */
function withoutTags(markup) {
  let out = '';
  let i = 0;
  while (i < markup.length) {
    const open = markup.indexOf('<', i);
    if (open === -1) { out += markup.slice(i); break; }
    out += markup.slice(i, open);
    const close = markup.indexOf('>', open + 1);
    if (close === -1) break;
    i = close + 1;
  }
  return out;
}

function selectFromMarkup(markup, classes) {
  const select = new FakeEl('select', { classes });
  select.options = [...markup.matchAll(/<option value="([^"]*)"([^>]*)>([\s\S]*?)<\/option>/g)]
    .map(([, value, attrs, label]) => ({
      value: unescape(value),
      label: unescape(label.trim()),
      selected: /\bselected\b/.test(attrs),
      disabled: false,
      hidden: false,
    }));
  return select;
}

/** Die Erinnerungszeilen eines Markup-Stuecks als Doppel. */
function rowsFromMarkup(html) {
  const starts = [...html.matchAll(/<div class="reminder-row" data-reminder-row([^>]*)>/g)];
  return starts.map((match, i) => {
    const chunk = html.slice(match.index, starts[i + 1]?.index ?? html.length);
    const row = new FakeEl('div', { classes: ['reminder-row'], attrs: { 'data-reminder-row': '' } });
    for (const [, name, value] of match[1].matchAll(/data-([\w-]+)="([^"]*)"/g)) {
      const key = name.replace(/-(\w)/g, (_, c) => c.toUpperCase());
      row.dataset[key] = unescape(value);
    }

    const main = row.append(new FakeEl('div', { classes: ['reminder-row__main'] }));
    const offsetMarkup = /<select class="form-input js-reminder-offset"[^>]*>([\s\S]*?)<\/select>/.exec(chunk);
    assert.ok(offsetMarkup, 'jede Zeile hat eine Auswahl');
    main.append(selectFromMarkup(offsetMarkup[1], ['form-input', 'js-reminder-offset']));
    main.append(new FakeEl('button', { classes: ['js-reminder-remove'] }));

    const hintMarkup = /<p class="([^"]*js-reminder-after-start-hint[^"]*)"([^>]*)>([\s\S]*?)<\/p>/.exec(chunk);
    if (hintMarkup) {
      const hint = row.append(new FakeEl('p', { classes: hintMarkup[1].split(/\s+/) }));
      hint.hidden = /\shidden\b/.test(` ${hintMarkup[2]}`);
      hint.textContent = unescape(withoutTags(hintMarkup[3]).trim());
    }

    const customMarkup = /<div class="[^"]*js-reminder-custom"\s*([^>]*)>/.exec(chunk);
    const custom = row.append(new FakeEl('div', { classes: ['reminder-custom', 'js-reminder-custom'] }));
    custom.hidden = /\bhidden\b/.test(customMarkup?.[1] ?? '');
    const amount = custom.append(new FakeEl('input', { classes: ['js-reminder-custom-amount'] }));
    amount.value = /<input class="form-input js-reminder-custom-amount"[^>]*value="([^"]*)"/.exec(chunk)?.[1] ?? '';
    const unitMarkup = /<select class="form-input js-reminder-custom-unit">([\s\S]*?)<\/select>/.exec(chunk);
    custom.append(selectFromMarkup(unitMarkup[1], ['js-reminder-custom-unit']));
    return row;
  });
}

/**
 * Der ganze Dialog: der ECHTE Erinnerungs-Abschnitt plus die Felder, die
 * `saveEvent` und `wireEventForm` lesen. Verdrahtet wird wie im Browser.
 */
function openDialog({
  event = EVENT,
  reminders = [],
  start = event.start_datetime,
  end = event.end_datetime,
} = {}) {
  const section = calendar.renderCalendarReminderSection(reminders, event, []);
  const panel = new FakeEl('div');
  const field = (id, value = '', tag = 'input') => {
    const el = panel.append(new FakeEl(tag, { id }));
    el.value = value;
    return el;
  };
  field('modal-title', event.title);
  const allday = field('modal-allday');
  allday.type = 'checkbox';
  allday.checked = false;
  field('time-fields', '', 'div');
  field('allday-fields', '', 'div');
  field('modal-start-date', start.slice(0, 10));
  field('modal-start-time', start.slice(11, 16));
  field('modal-end-date', end.slice(0, 10));
  field('modal-end-time', end.slice(11, 16));
  field('modal-allday-start', start.slice(0, 10));
  field('modal-allday-end', end.slice(0, 10));
  field('modal-location');
  field('modal-description');
  field('modal-cancel', '', 'button');
  field('modal-save', '', 'button');

  const toggle = field('modal-reminder-toggle');
  toggle.type = 'checkbox';
  toggle.checked = /id="modal-reminder-toggle"\s+checked/.test(section);
  const fields = field('modal-reminder-fields', '', 'div');
  const rowsEl = fields.append(new FakeEl('div', { id: 'modal-reminder-rows' }));
  for (const row of rowsFromMarkup(section)) rowsEl.append(row);
  fields.append(new FakeEl('button', { id: 'modal-reminder-add' }));

  calendar.wireEventForm(panel, { mode: 'edit', event, reminder: reminders });
  return panel;
}

const rowsOf = (panel) => panel.querySelectorAll('[data-reminder-row]');
const offsetOf = (row) => row.querySelector('.js-reminder-offset');
const hintOf = (row) => row.querySelector('.js-reminder-after-start-hint');
const afterStartOption = (row) => offsetOf(row).options.find((o) => o.value === 'after_start');

/** Die Hand an einem Feld: Wert setzen, Ereignis ausloesen. */
function userSets(el, value, type = 'change') {
  el.value = value;
  el.dispatch(type);
}

/**
 * Faehrt `saveEvent` und gibt zurueck, was an den Server ging.
 *
 * Nach den Anfragen rendert `saveEvent` die Ansicht neu, und die gibt es in
 * dieser Suite nicht - das endet in einem Fehler-Toast. Er ist ein Artefakt der
 * Umgebung, nicht der Befund; gemessen werden die Anfragen, und die liegen
 * alle davor.
 *
 * `scope` beantwortet die Frage, fuer welche Termine einer Serie das Speichern
 * gilt (#1284) - sie kommt erst beim Speichern, als Dialog ueber dem Formular.
 * `closes` zaehlt, wie oft etwas geschlossen wurde: der Dialog schliesst sich
 * selbst, ein Speichern, das durchlaeuft, schliesst danach das Formular.
 */
async function save(panel, { event = EVENT, reminders = [], master = null, scope } = {}) {
  const calls = [];
  const fieldErrors = [];
  const closes = [];
  const question = scopeQuestion(scope);
  globalThis.__closeModal = (options) => closes.push(options ?? {});
  globalThis.__apiStub = {
    get: async (path) => {
      calls.push({ method: 'get', path });
      if (master && path === `/calendar/${master.id}`) return { data: master };
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
  globalThis.__reportFieldError = (input, message) => fieldErrors.push({ input, message });
  try {
    await settles(calendar.saveEvent(panel, 'edit', event, reminders, null), 'Speichern');
  } finally {
    question.uninstall();
    delete globalThis.__apiStub;
    delete globalThis.__rruleValues;
    delete globalThis.__reportFieldError;
    delete globalThis.__closeModal;
  }
  return { calls, fieldErrors, closes, dialogs: question.dialogs };
}

const reminderPut = (calls) => calls.find((c) => c.method === 'put' && c.path.startsWith('/reminders'));

// --------------------------------------------------------------------------
// Der Dialog nennt den Zustand
// --------------------------------------------------------------------------

test('der Messfall aus #1260: die Zeile nennt „nach dem Terminbeginn" statt „1 Minute vorher"', () => {
  const [row] = rowsOf(openDialog({ reminders: [AFTER] }));
  assert.equal(offsetOf(row).value, 'after_start', 'kein „Benutzerdefiniert" fuer einen Nachlauf');
  assert.equal(afterStartOption(row)?.label, 'reminders.offsetAfterStart', 'der Eintrag traegt einen eigenen Text');
  assert.equal(row.querySelector('.js-reminder-custom').hidden, true, 'keine Custom-Felder mit einer erfundenen Minute');
  // Wer doch auf „Benutzerdefiniert" umstellt, findet die Vorgabe einer neuen
  // Zeile, nicht die „1 Minute" aus dem weggeklemmten negativen Wert.
  assert.equal(row.querySelector('.js-reminder-custom-amount').value, '1');
  assert.equal(row.querySelector('.js-reminder-custom-unit').value, 'days');
});

test('der Warnton steht da und nennt den TATSAECHLICHEN Zeitpunkt, samt Uhrzeit', () => {
  const [row] = rowsOf(openDialog({ reminders: [AFTER] }));
  const hint = hintOf(row);
  assert.ok(hint, 'der Warnton ist angelegt');
  assert.equal(hint.hidden, false, 'und sichtbar');
  assert.ok(hint.classes.has('field-hint--warn'), 'im Warnton der Formularhinweise');
  assert.match(hint.textContent, /reminders\.afterStartHint/);
  // Der Loader-Stub formatiert ein Date als String(date) - darin steht die
  // Uhrzeit der ERINNERUNG (08:00 Ortszeit), nicht die des Beginns.
  assert.ok(hint.textContent.includes(String(new Date('2026-09-25T06:00:00Z'))),
    `der Zeitpunkt der Erinnerung steht im Hinweis: ${hint.textContent}`);
});

test('eine gewoehnliche Vorher-Erinnerung bleibt, wie sie war (Regression)', () => {
  const [row] = rowsOf(openDialog({ reminders: [DAY_BEFORE] }));
  assert.equal(offsetOf(row).value, '1440');
  assert.equal(afterStartOption(row), undefined, 'man waehlt diesen Zustand nicht, man ist darin');
  assert.equal(hintOf(row), null, 'kein Warnton');
  assert.equal(row.dataset.reminderStoredAt, undefined, 'eine Vorher-Zeile reicht nichts durch, sie rechnet');
});

test('unter einer Minute bleibt es beim Startzeitpunkt - in beide Richtungen', () => {
  for (const remind_at of ['2026-09-18T07:00:20', '2026-09-18T06:59:40']) {
    const [row] = rowsOf(openDialog({ reminders: [{ remind_at }] }));
    assert.equal(offsetOf(row).value, '0', `${remind_at}: ein paar Sekunden Rundung sind kein Warnton`);
    assert.equal(hintOf(row), null);
  }
});

test('die Leseansicht nennt denselben Zeitpunkt wie der Warnton - mit Uhrzeit', () => {
  // `formatDateTime` erkannte die Uhrzeit an der Laenge eines Strings, bekam
  // aber ein Date: die Leseansicht nannte nur den Tag. Jetzt laufen beide
  // Ansichten ueber denselben Helfer.
  const summary = calendar.reminderSummary(EVENT, [AFTER]);
  assert.ok(summary.includes(String(new Date('2026-09-25T06:00:00Z'))),
    `die Leseansicht nennt die Uhrzeit der Erinnerung: ${summary}`);
  assert.equal(calendar.reminderSummary(EVENT, [DAY_BEFORE]), 'reminders.offset1day',
    'ein Preset bleibt ein Label');
});

// --------------------------------------------------------------------------
// Speichern: was wirklich an den Server geht
// --------------------------------------------------------------------------

test('Speichern ohne Anfassen reicht remind_at UNVERAENDERT durch (Messfall)', async () => {
  const reminders = [AFTER];
  const { calls } = await save(openDialog({ reminders }), { reminders });
  assert.deepEqual(calls.find((c) => c.method === 'put')?.path, '/calendar/7', 'der Termin wurde gespeichert');
  assert.deepEqual(reminderPut(calls)?.body, { remind_ats: ['2026-09-25T06:00:00'] },
    'nicht 2026-09-18T06:59:00 - die Erinnerung bleibt, wo sie ist');
});

test('eine normale Vorher-Erinnerung rechnet weiter vom Beginn aus (Regression)', async () => {
  const reminders = [DAY_BEFORE];
  const { calls } = await save(openDialog({ reminders }), { reminders });
  assert.deepEqual(reminderPut(calls)?.body, { remind_ats: ['2026-09-17T07:00:00'] });
});

test('Zeile angefasst: ein gewaehlter Vorlauf rechnet wieder normal', async () => {
  const reminders = [AFTER];
  const panel = openDialog({ reminders });
  const [row] = rowsOf(panel);
  userSets(offsetOf(row), '1440');
  assert.equal(hintOf(row)?.hidden ?? true, true, 'der Warnton geht mit der Entscheidung');
  const { calls } = await save(panel, { reminders });
  assert.deepEqual(reminderPut(calls)?.body, { remind_ats: ['2026-09-17T07:00:00'] },
    'ein Tag vor dem Beginn, wie gewaehlt');
});

test('Zeile angefasst und zurueck auf „nach dem Terminbeginn": der Zeitpunkt ist wieder da', async () => {
  const reminders = [AFTER];
  const panel = openDialog({ reminders });
  const [row] = rowsOf(panel);
  userSets(offsetOf(row), 'custom');
  userSets(offsetOf(row), 'after_start');
  assert.equal(offsetOf(row).value, 'after_start', 'der Eintrag ist noch da - die Wahl ist umkehrbar');
  assert.equal(hintOf(row).hidden, false);
  const { calls } = await save(panel, { reminders });
  assert.deepEqual(reminderPut(calls)?.body, { remind_ats: ['2026-09-25T06:00:00'] });
});

test('ein neuer Betrag ist ebenfalls eine Hand an der Zeile', async () => {
  const reminders = [AFTER];
  const panel = openDialog({ reminders });
  const [row] = rowsOf(panel);
  userSets(offsetOf(row), 'custom');
  userSets(row.querySelector('.js-reminder-custom-amount'), '2', 'input');
  const { calls } = await save(panel, { reminders });
  assert.deepEqual(reminderPut(calls)?.body, { remind_ats: ['2026-09-16T07:00:00'] }, 'zwei Tage vorher');
});

// --------------------------------------------------------------------------
// Mehrere Zeilen: die Entscheidung faellt JE ZEILE
// --------------------------------------------------------------------------

test('eine Nach-Beginn-Zeile neben normalen: nur sie reicht durch, die anderen rechnen', async () => {
  const reminders = [DAY_BEFORE, AFTER, QUARTER_BEFORE];
  const panel = openDialog({ reminders });
  assert.deepEqual(rowsOf(panel).map((row) => offsetOf(row).value), ['1440', 'after_start', '15']);
  assert.deepEqual(rowsOf(panel).map((row) => hintOf(row)?.hidden ?? null), [null, false, null],
    'der Warnton steht nur an der Zeile, fuer die er gilt');
  const { calls } = await save(panel, { reminders });
  assert.deepEqual(reminderPut(calls)?.body, {
    remind_ats: ['2026-09-17T07:00:00', '2026-09-25T06:00:00', '2026-09-18T06:45:00'],
  });
});

test('zwei Nach-Beginn-Zeilen bleiben zwei - kein Zusammenfallen auf „1 Minute"', async () => {
  const reminders = [AFTER, AFTER_2];
  const { calls } = await save(openDialog({ reminders }), { reminders });
  assert.deepEqual(reminderPut(calls)?.body, { remind_ats: ['2026-09-25T06:00:00', '2026-09-20T10:00:00'] });
});

test('die Obergrenze von fuenf zaehlt durchgereichte und gerechnete Zeilen zusammen', async () => {
  const reminders = [AFTER, DAY_BEFORE, AFTER_2, QUARTER_BEFORE, HOUR_BEFORE];
  const panel = openDialog({ reminders });
  const { calls } = await save(panel, { reminders });
  assert.deepEqual(reminderPut(calls)?.body, {
    remind_ats: [
      '2026-09-25T06:00:00', '2026-09-17T07:00:00', '2026-09-20T10:00:00',
      '2026-09-18T06:45:00', '2026-09-18T06:00:00',
    ],
  });
  assert.equal(panel.querySelector('#modal-reminder-add').disabled, true, 'eine sechste Zeile gibt es nicht');
});

// --------------------------------------------------------------------------
// Der Beginn wird im Dialog verschoben
//
// „Nach dem Beginn" ist das VERHAELTNIS zweier Zeitpunkte. Der gespeicherte
// Zeitpunkt bleibt, der Beginn wandert - also wird die Zeile gegen den neuen
// Beginn neu bewertet, und das Speichern reicht den Zeitpunkt weiter durch.
// Normale Zeilen wandern mit dem Beginn wie bisher.
// --------------------------------------------------------------------------

test('Beginn nach vorn verschoben: die Zeile bleibt nach dem Beginn, die normale wandert mit', async () => {
  const reminders = [AFTER, DAY_BEFORE];
  const panel = openDialog({ reminders });
  userSets(panel.querySelector('#modal-start-date'), '2026-09-17');
  const [after] = rowsOf(panel);
  assert.equal(offsetOf(after).value, 'after_start');
  assert.equal(hintOf(after).hidden, false);
  const { calls } = await save(panel, { reminders });
  assert.deepEqual(reminderPut(calls)?.body, {
    remind_ats: ['2026-09-25T06:00:00', '2026-09-16T07:00:00'],
  });
});

test('Beginn hinter die Erinnerung geschoben: die Zeile zeigt den Vorlauf, der nun gilt', () => {
  const panel = openDialog({ reminders: [AFTER] });
  // `input`, nicht `change`: ein Tastendruck im Datumsfeld reicht.
  userSets(panel.querySelector('#modal-start-date'), '2026-09-26', 'input');
  const [row] = rowsOf(panel);
  // 26.09. 09:00 minus 25.09. 08:00 Ortszeit = 25 Stunden.
  assert.equal(offsetOf(row).value, 'custom');
  assert.equal(row.querySelector('.js-reminder-custom-amount').value, '25');
  assert.equal(row.querySelector('.js-reminder-custom-unit').value, 'hours');
  assert.equal(row.querySelector('.js-reminder-custom').hidden, false, 'und die Felder sind zu sehen');
  assert.equal(hintOf(row).hidden, true, 'kein Warnton fuer einen Zustand, der vorbei ist');
  assert.equal(afterStartOption(row).disabled, true, '„nach dem Beginn" ist jetzt nicht waehlbar - es stimmt nicht');
});

test('nach dem Verschieben reicht das Speichern den Zeitpunkt auf die Sekunde durch', async () => {
  const reminders = [AFTER];
  const panel = openDialog({ reminders });
  userSets(panel.querySelector('#modal-start-date'), '2026-09-26');
  const { calls } = await save(panel, { reminders });
  assert.deepEqual(calls.find((c) => c.path === '/calendar/7')?.body.start_datetime, '2026-09-26T09:00');
  assert.deepEqual(reminderPut(calls)?.body, { remind_ats: ['2026-09-25T06:00:00'] },
    'die Anzeige ist dem Beginn gefolgt, der Zeitpunkt nicht');
});

test('zurueck vor die Erinnerung: der Zustand kommt wieder, solange niemand die Zeile anfasst', () => {
  const panel = openDialog({ reminders: [AFTER] });
  const startDate = panel.querySelector('#modal-start-date');
  userSets(startDate, '2026-09-26');
  userSets(startDate, '2026-09-18');
  const [row] = rowsOf(panel);
  assert.equal(offsetOf(row).value, 'after_start');
  assert.equal(hintOf(row).hidden, false);
  assert.equal(afterStartOption(row).disabled, false);
});

test('auch die Uhrzeit und der Ganztags-Schalter bewerten neu', () => {
  const panel = openDialog({ reminders: [{ remind_at: '2026-09-18T07:30:00' }] }); // 09:30 Ortszeit
  const [row] = rowsOf(panel);
  assert.equal(offsetOf(row).value, 'after_start');
  userSets(panel.querySelector('#modal-start-time'), '10:30', 'input');
  assert.equal(offsetOf(row).value, '60', 'eine Stunde vor 10:30');
  userSets(panel.querySelector('#modal-start-time'), '09:00');
  assert.equal(offsetOf(row).value, 'after_start');
  // Ganztags gilt 09:00 als Anker - die Erinnerung um 09:30 bleibt danach.
  const allday = panel.querySelector('#modal-allday');
  allday.checked = true;
  panel.querySelector('#modal-allday-start').value = '2026-09-19';
  allday.dispatch('change');
  assert.equal(offsetOf(row).value, 'custom', 'am 19. um 09:00 liegt sie wieder davor');
});

test('nach der Neubewertung ist ein neuer Betrag eine Hand an der Zeile - ab da rechnet sie', async () => {
  // Die Neubewertung stellt die Zeile auf „Benutzerdefiniert, 25 Stunden",
  // OHNE dass jemand die Auswahl beruehrt hat - sie reicht also weiter durch.
  // Tippt jemand dann einen anderen Betrag, ist das seine Entscheidung, und
  // die Auswahl hat er dafuer nie angefasst.
  const reminders = [AFTER];
  const panel = openDialog({ reminders });
  userSets(panel.querySelector('#modal-start-date'), '2026-09-26');
  const [row] = rowsOf(panel);
  assert.equal(offsetOf(row).value, 'custom');
  userSets(row.querySelector('.js-reminder-custom-amount'), '24', 'input');
  const { calls } = await save(panel, { reminders });
  assert.deepEqual(reminderPut(calls)?.body, { remind_ats: ['2026-09-25T07:00:00'] },
    '24 Stunden vor dem 26.09. 09:00, nicht der gespeicherte Zeitpunkt');
});

test('eine selbst gewaehlte Zeile wird vom Verschieben nicht umgestellt', () => {
  const panel = openDialog({ reminders: [AFTER] });
  const [row] = rowsOf(panel);
  userSets(offsetOf(row), '60');
  userSets(panel.querySelector('#modal-start-date'), '2026-09-26');
  assert.equal(offsetOf(row).value, '60', 'wer selbst gewaehlt hat, hat entschieden');
});

test('ein halb getippter Beginn stellt nichts um', () => {
  const opts = { anchorStart: '2026-09-18T09:00', openedAt: '2026-09-18T09:00' };
  assert.equal(calendar.afterStartResolution(AFTER.remind_at, { ...opts, currentStart: '' }), null);
  assert.equal(calendar.afterStartResolution(AFTER.remind_at, { ...opts, currentStart: 'kein Datum' }), null);
  assert.deepEqual(calendar.afterStartResolution(AFTER.remind_at, { ...opts, currentStart: '2026-09-18T09:00' }),
    { offset: 'after_start', amount: 1, unit: 'days' });
});

// --------------------------------------------------------------------------
// Serientermine
//
// Die Erinnerungen einer Serie haengen am Serienbeginn (`reminder_anchor_start`),
// nicht an dem des Vorkommens, das gerade offen ist. „Ganze Serie" speichert
// ueber `PUT /reminders` absolute Zeitpunkte - dort reicht die Zeile durch wie
// beim Einzeltermin. „Nur dieser" / „dieser und folgende" sprechen mit dem
// Server nur in Vorlaeufen ab 0; eine Zeile nach dem Beginn hat keinen.
//
// Welcher Weg es wird, fragt seit #1284 das Speichern selbst, und nur, wenn
// sich etwas geaendert hat. Die Pruefung auf die Zeile nach dem Beginn greift
// deshalb NACH der Wahl: der Dialog ist beantwortet und zu, die Meldung steht
// an der Zeile im Formular, das offen bleibt.
// --------------------------------------------------------------------------

const SERIES_OCCURRENCE = {
  id: 99,
  title: 'Training',
  series_id: 41,
  recurrence_id: '2026-10-02',
  is_local_recurring_series: true,
  can_override_occurrence: true,
  recurrence_rule: 'FREQ=WEEKLY',
  start_datetime: '2026-10-02T09:00',
  end_datetime: '2026-10-02T10:00',
  all_day: 0,
  created_by: 1,
  reminder_owner_id: 41,
  reminder_anchor_start: '2026-09-18T09:00',
};
const MASTER = { ...SERIES_OCCURRENCE, id: 41, recurrence_id: null, start_datetime: '2026-09-18T09:00', end_datetime: '2026-09-18T10:00' };

test('Serie: die Zeile bewertet sich am Serienbeginn, nicht am offenen Vorkommen', () => {
  const [row] = rowsOf(openDialog({ event: SERIES_OCCURRENCE, reminders: [AFTER] }));
  assert.equal(offsetOf(row).value, 'after_start', 'der 25.09. liegt nach dem Serienbeginn am 18.09.');
});

test('ganze Serie: der gespeicherte Zeitpunkt geht unveraendert an den Serienkopf', async () => {
  const reminders = [AFTER, DAY_BEFORE];
  const panel = openDialog({ event: SERIES_OCCURRENCE, reminders });
  userSets(panel.querySelector('#modal-title'), 'Training (Halle 2)', 'input');
  const { calls } = await save(panel, { event: SERIES_OCCURRENCE, reminders, master: MASTER, scope: 'series' });
  assert.equal(calls.find((c) => c.method === 'put')?.path, '/calendar/41', 'die Serie wurde gespeichert');
  const put = reminderPut(calls);
  assert.equal(put?.path, '/reminders?entity_type=event&entity_id=41');
  assert.deepEqual(put?.body, { remind_ats: ['2026-09-25T06:00:00', '2026-09-17T07:00:00'] });
});

test('nur dieser, nichts an den Erinnerungen geaendert: das Speichern fasst sie nicht an', async () => {
  const reminders = [AFTER, DAY_BEFORE];
  const panel = openDialog({ event: SERIES_OCCURRENCE, reminders });
  userSets(panel.querySelector('#modal-title'), 'Training (Halle 2)', 'input');
  const { calls, fieldErrors } = await save(panel, { event: SERIES_OCCURRENCE, reminders, scope: 'this' });
  assert.deepEqual(fieldErrors, []);
  const put = calls.find((c) => c.method === 'put' && c.path === '/calendar/41/occurrences/2026-10-02');
  assert.ok(put, 'das Vorkommen wurde gespeichert');
  assert.equal('reminder_offsets' in put.body, false,
    'keine Vorlaeufe mitgeschickt - der Server laesst die Erinnerungen, wie sie sind');
  assert.equal(reminderPut(calls), undefined, 'und kein zweiter Weg an ihnen vorbei');
});

test('nur dieser, daneben eine Erinnerung geaendert: Meldung an der Zeile statt Verschieben', async () => {
  const reminders = [AFTER, DAY_BEFORE];
  const panel = openDialog({ event: SERIES_OCCURRENCE, reminders });
  const [after, dayBefore] = rowsOf(panel);
  userSets(offsetOf(dayBefore), '60');
  const { calls, fieldErrors, closes, dialogs } = await save(panel, { event: SERIES_OCCURRENCE, reminders, scope: 'this' });
  assert.deepEqual(calls.filter((c) => c.method !== 'get'), [], 'nichts gespeichert - weder verschoben noch verworfen');
  // #1284: erst die Wahl, dann die Pruefung - der Dialog ist beantwortet und
  // zu, das Formular bleibt offen, die Meldung steht dort an der Zeile.
  assert.equal(dialogs.length, 1, 'die Frage nach der Reichweite kam zuerst');
  assert.equal(dialogs[0].answered, 'this');
  assert.deepEqual(closes, [{ force: true }], 'geschlossen hat sich nur der Dialog, nicht das Formular');
  assert.equal(fieldErrors.length, 1);
  assert.equal(fieldErrors[0].input, offsetOf(after), 'die Meldung steht an der Zeile nach dem Beginn');
  assert.equal(fieldErrors[0].message, 'reminders.afterStartNeedsLeadTime');
  assert.equal(panel.querySelector('#modal-save').disabled, false, 'und der Knopf ist wieder frei');
});

test('dieser und folgende, daneben eine Erinnerung geaendert: dieselbe Meldung nach der Wahl', async () => {
  const reminders = [AFTER, DAY_BEFORE];
  const panel = openDialog({ event: SERIES_OCCURRENCE, reminders });
  const [after, dayBefore] = rowsOf(panel);
  userSets(offsetOf(dayBefore), '60');
  const { calls, fieldErrors, dialogs } = await save(panel, { event: SERIES_OCCURRENCE, reminders, scope: 'following' });
  assert.equal(dialogs[0]?.answered, 'following');
  assert.deepEqual(calls.filter((c) => c.method !== 'get'), []);
  assert.equal(fieldErrors[0]?.input, offsetOf(after));
});

test('daneben geaendert, aber „Ganze Serie" gewaehlt: keine Meldung, der Zeitpunkt geht durch', async () => {
  // Die Serie schreibt absolute Zeitpunkte - dort gibt es nichts abzulehnen.
  const reminders = [AFTER, DAY_BEFORE];
  const panel = openDialog({ event: SERIES_OCCURRENCE, reminders });
  userSets(offsetOf(rowsOf(panel)[1]), '60');
  const { calls, fieldErrors } = await save(panel, { event: SERIES_OCCURRENCE, reminders, master: MASTER, scope: 'series' });
  assert.deepEqual(fieldErrors, []);
  assert.deepEqual(reminderPut(calls)?.body, { remind_ats: ['2026-09-25T06:00:00', '2026-09-18T06:00:00'] });
});

test('Abbrechen der Frage: weder Meldung noch Anfrage - zurueck ins Formular', async () => {
  const reminders = [AFTER, DAY_BEFORE];
  const panel = openDialog({ event: SERIES_OCCURRENCE, reminders });
  userSets(offsetOf(rowsOf(panel)[1]), '60');
  const { calls, fieldErrors, closes } = await save(panel, { event: SERIES_OCCURRENCE, reminders, scope: 'cancel' });
  assert.deepEqual(calls, []);
  assert.deepEqual(fieldErrors, [], 'die Pruefung kommt erst nach einer Wahl');
  assert.deepEqual(closes, [{ force: true }], 'nur der Dialog ging zu');
});

test('eine entfernte Erinnerungszeile ist eine Aenderung - die Frage kommt (#1284)', async () => {
  // Nur die Zahl der Bedienelemente verraet sie: die uebrigen Felder stehen,
  // wie sie standen.
  const reminders = [DAY_BEFORE, HOUR_BEFORE];
  const panel = openDialog({ event: SERIES_OCCURRENCE, reminders });
  rowsOf(panel)[1].querySelector('.js-reminder-remove').dispatch('click');
  assert.equal(rowsOf(panel).length, 1);
  const { calls, dialogs } = await save(panel, { event: SERIES_OCCURRENCE, reminders, scope: 'this' });
  assert.equal(dialogs.length, 1, 'gefragt, nicht still geschlossen');
  const put = calls.find((c) => c.path === '/calendar/41/occurrences/2026-10-02');
  assert.deepEqual(put?.body.reminder_offsets, [1440]);
});

test('eine neue Erinnerungszeile ist ebenso eine Aenderung (#1284)', async () => {
  const reminders = [DAY_BEFORE];
  const panel = openDialog({ event: SERIES_OCCURRENCE, reminders });
  panel.querySelector('#modal-reminder-add').dispatch('click');
  assert.equal(rowsOf(panel).length, 2);
  const { dialogs } = await save(panel, { event: SERIES_OCCURRENCE, reminders, scope: 'cancel' });
  assert.equal(dialogs.length, 1);
});

test('nichts angefasst: keine Frage, nichts gesendet - auch nicht an den Erinnerungen (#1284)', async () => {
  const reminders = [AFTER, DAY_BEFORE];
  const panel = openDialog({ event: SERIES_OCCURRENCE, reminders });
  const { calls, dialogs, closes } = await save(panel, { event: SERIES_OCCURRENCE, reminders, scope: 'this' });
  assert.equal(dialogs.length, 0);
  assert.deepEqual(calls, []);
  assert.deepEqual(closes, [{ force: true }], 'das Formular geht einfach zu');
});

test('nur dieser, die Zeile nach dem Beginn selbst umgestellt: normale Vorlaeufe', async () => {
  const reminders = [AFTER, DAY_BEFORE];
  const panel = openDialog({ event: SERIES_OCCURRENCE, reminders });
  userSets(offsetOf(rowsOf(panel)[0]), '15');
  const { calls } = await save(panel, { event: SERIES_OCCURRENCE, reminders, scope: 'this' });
  const put = calls.find((c) => c.path === '/calendar/41/occurrences/2026-10-02');
  assert.deepEqual(put?.body.reminder_offsets, [15, 1440]);
});

// Verschoben wird hier das VORKOMMEN: die Neubewertung stellt die Zeile auf den
// Vorlauf, der nun gilt, und laesst sie dabei durchreichen. Fuer den Vorkommens-
// Weg zaehlt, dass sie durchreicht, nicht was sie anzeigt - sonst ginge der
// angezeigte Vorlauf als Zahl raus und der Server rechnete ihn gegen den NEUEN
// Beginn des Vorkommens.
test('nur dieser, Beginn hinter die Erinnerung geschoben: die Erinnerungen bleiben unangefasst', async () => {
  const reminders = [AFTER];
  const panel = openDialog({ event: SERIES_OCCURRENCE, reminders });
  userSets(panel.querySelector('#modal-start-date'), '2026-10-16');
  const [row] = rowsOf(panel);
  assert.equal(offsetOf(row).value, 'custom', 'Vorbedingung: die Zeile zeigt jetzt einen Vorlauf');
  const { calls, fieldErrors } = await save(panel, { event: SERIES_OCCURRENCE, reminders, scope: 'this' });
  assert.deepEqual(fieldErrors, []);
  const put = calls.find((c) => c.method === 'put' && c.path === '/calendar/41/occurrences/2026-10-02');
  assert.equal(put?.body.start_datetime, '2026-10-16T09:00', 'das Vorkommen wurde verschoben');
  assert.equal('reminder_offsets' in put.body, false,
    'kein Vorlauf aus der Anzeige - der gespeicherte Zeitpunkt bleibt beim Server, wie er ist');
});

test('nur dieser, Beginn verschoben und daneben eine Erinnerung geaendert: Meldung an der Zeile', async () => {
  const reminders = [AFTER, DAY_BEFORE];
  const panel = openDialog({ event: SERIES_OCCURRENCE, reminders });
  userSets(panel.querySelector('#modal-start-date'), '2026-10-16');
  const [after, dayBefore] = rowsOf(panel);
  userSets(offsetOf(dayBefore), '60');
  const { calls, fieldErrors } = await save(panel, { event: SERIES_OCCURRENCE, reminders, scope: 'this' });
  assert.deepEqual(calls.filter((c) => c.method !== 'get'), [], 'nichts gespeichert');
  assert.equal(fieldErrors.length, 1);
  assert.equal(fieldErrors[0].input, offsetOf(after), 'die Meldung steht an der Zeile, die noch durchreicht');
  assert.equal(fieldErrors[0].message, 'reminders.afterStartNeedsLeadTime');
});

test('nur dieser ohne Zeile nach dem Beginn: Vorlaeufe wie bisher (Regression)', async () => {
  const reminders = [DAY_BEFORE];
  const panel = openDialog({ event: SERIES_OCCURRENCE, reminders });
  userSets(panel.querySelector('#modal-title'), 'Training (Halle 2)', 'input');
  const { calls } = await save(panel, { event: SERIES_OCCURRENCE, reminders, scope: 'this' });
  const put = calls.find((c) => c.path === '/calendar/41/occurrences/2026-10-02');
  assert.deepEqual(put?.body.reminder_offsets, [1440]);
});

test('die Vorkommens-Anfrage laesst reminder_offsets bei null weg, bei [] nicht', async () => {
  const sent = [];
  const api = { put: async (path, body) => { sent.push(body); return { data: { id: 1 } }; } };
  const event = { series_id: 41, recurrence_id: '2026-10-02' };
  for (const reminderOffsets of [null, []]) {
    await recurrenceScope.requestCalendarOccurrenceMutation({
      api, event, scope: 'this', body: { title: 'x' }, reminderOffsets, confirmCount: async () => true,
    });
  }
  assert.deepEqual(sent, [{ title: 'x' }, { title: 'x', reminder_offsets: [] }],
    'null heisst „nicht anfassen", ein leeres Array weiterhin „alle entfernen"');
});
