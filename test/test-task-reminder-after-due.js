/**
 * Modul: Erinnerung nach der Faelligkeit im Aufgaben-Dialog
 * Zweck: `remind_at` ist ein absoluter Zeitpunkt, die Auswahlliste kennt nur
 *        Vorlaeufe. Wer ein Faelligkeitsdatum VOR eine bestehende Erinnerung
 *        zieht, hat keinen Vorlauf mehr - und der Dialog behauptete fuer
 *        diesen Fall „Zum Startzeitpunkt". Mit Schreibrecht heilte das
 *        naechste Speichern die Anzeige still: es rechnete aus dem FALSCHEN
 *        Preset einen neuen Zeitpunkt, die Erinnerung wanderte ungefragt.
 *
 *        Diese Suite prueft beide Haelften an der ECHTEN Naht - das Markup,
 *        das der Dialog schreibt, geht vorne hinein, und der Zeitpunkt, den
 *        das Speichern daraus macht, kommt hinten heraus:
 *          - der Zustand bekommt einen eigenen Eintrag mit Warnton, nicht die
 *            Notluege „zum Zeitpunkt";
 *          - der gespeicherte Zeitpunkt reist im Formular mit;
 *          - Speichern ohne Anfassen laesst die Erinnerung STEHEN;
 *          - ein gewaehlter Vorlauf verschiebt sie weiterhin;
 *          - ein normaler Vorlauf bringt weder Eintrag noch Warnton mit;
 *          - ALLE VIER Felder der Naht, auch die beiden Custom-Felder: eine
 *            Naht, die nur zur Haelfte gemessen ist, laesst die andere Haelfte
 *            umbenennen, ohne dass etwas rot wird;
 *          - und der Zustand heilt sich im Dialog, wenn die Faelligkeit nach
 *            hinten wandert - samt der Verdrahtung, die das ausloest, denn ein
 *            Listener, den niemand anhaengt, ist der haeufigste Ausfall.
 * Ausfuehren: npm run test:task-reminder-after-due
 */
import test from 'node:test';
import assert from 'node:assert/strict';

process.env.TZ = 'Asia/Yekaterinburg'; // UTC+5: eine Nicht-UTC-Zone wie in test-reminder-offset.js

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

const { __test: tasks } = await import('../public/pages/tasks.js');

const TASK = { id: 7, title: 'Reifen wechseln', due_date: '2026-09-18', due_time: null };
const AFTER_DUE = { remind_at: '2026-09-25T06:00:00' }; // sechs Tage NACH der Faelligkeit
const ONE_DAY_BEFORE = { remind_at: '2026-09-17T18:59:59' }; // 23:59:59 lokal (UTC+5) minus 1 Tag

/**
 * Ein Formular-Doppel, das seine Werte aus dem GERENDERTEN Markup nimmt.
 *
 * Bewusst kein handgesetzter Zustand: die Frage dieser Suite ist, ob das, was
 * der Dialog schreibt, und das, was das Speichern liest, dieselben Felder sind.
 * Ein Doppel mit eigenen Werten koennte gruen sein, waehrend die beiden Seiten
 * aneinander vorbeigreifen.
 */
function formFromMarkup(html, overrides = {}) {
  const value = (id) => {
    if (id in overrides) return overrides[id];
    // <select id="x"> ... <option value="v" selected>
    const selectAt = html.indexOf(`id="${id}"`);
    if (selectAt < 0) return undefined;
    const tagEnd = html.indexOf('>', selectAt);
    const tag = html.slice(html.lastIndexOf('<', selectAt), tagEnd + 1);
    if (/^<(input|textarea)\b/.test(tag)) {
      return /\bvalue="([^"]*)"/.exec(tag)?.[1] ?? '';
    }
    const close = html.indexOf('</select>', tagEnd);
    const body = html.slice(tagEnd, close);
    return /<option value="([^"]*)"[^>]*\bselected\b/.exec(body)?.[1] ?? '';
  };
  return {
    querySelector: (selector) => {
      const id = selector.replace(/^#/, '');
      const found = value(id);
      return found === undefined ? null : { value: found };
    },
  };
}

/** Der Auswahl-Eintrag, der gerade gewaehlt ist. */
function selectedOffset(html) {
  return formFromMarkup(html).querySelector('#reminder-offset')?.value ?? null;
}

/** Steht der Warnton sichtbar da? */
function warningVisible(html) {
  const at = html.indexOf('id="reminder-after-due-warning"');
  assert.ok(at > 0, 'der Warnton ist im Markup angelegt');
  const tag = html.slice(html.lastIndexOf('<', at), html.indexOf('>', at) + 1);
  return !/\shidden(\s|>)/.test(tag);
}

test('der Dialog nennt den Zustand, statt „zum Zeitpunkt" zu behaupten', () => {
  const html = tasks.renderReminderSection(TASK, AFTER_DUE);
  assert.equal(selectedOffset(html), 'offset_after_due');
  assert.match(html, /reminders\.offsetAfterDue/, 'der Eintrag traegt einen eigenen Text');
  assert.equal(warningVisible(html), true, 'und einen Warnton dazu');
  assert.match(html, /reminders\.afterDueHint/, 'der Warnton nennt den tatsaechlichen Zeitpunkt');
});

test('der gespeicherte Zeitpunkt reist im Formular mit', () => {
  const html = tasks.renderReminderSection(TASK, AFTER_DUE);
  assert.equal(formFromMarkup(html).querySelector('#reminder-stored-at')?.value, AFTER_DUE.remind_at);
});

test('Speichern ohne Anfassen laesst die Erinnerung STEHEN', () => {
  const html = tasks.renderReminderSection(TASK, AFTER_DUE);
  const remindAt = tasks.reminderRemindAtFromForm(formFromMarkup(html), {
    dueDate: TASK.due_date, dueTime: TASK.due_time,
  });
  assert.equal(remindAt, AFTER_DUE.remind_at, 'kein stilles Verschieben auf die Faelligkeit');
});

test('wer doch einen Vorlauf waehlt, verschiebt die Erinnerung', () => {
  const html = tasks.renderReminderSection(TASK, AFTER_DUE);
  const form = formFromMarkup(html, { 'reminder-offset': 'offset_1d' });
  const remindAt = tasks.reminderRemindAtFromForm(form, { dueDate: TASK.due_date, dueTime: TASK.due_time });
  assert.equal(remindAt, ONE_DAY_BEFORE.remind_at, 'ein Tag vor der Faelligkeit');
  // Und der Rueckweg nennt wieder genau dieses Preset.
  assert.equal(selectedOffset(tasks.renderReminderSection(TASK, { remind_at: remindAt })), 'offset_1d');
});

test('ein gewoehnlicher Vorlauf bringt weder den Eintrag noch den Warnton mit', () => {
  const html = tasks.renderReminderSection(TASK, ONE_DAY_BEFORE);
  assert.equal(selectedOffset(html), 'offset_1d');
  assert.equal(warningVisible(html), false);
  assert.doesNotMatch(html, /value="offset_after_due"/, 'man waehlt diesen Zustand nicht, man ist darin');
});

test('ohne Erinnerung bleibt es beim Vorgabe-Preset', () => {
  const html = tasks.renderReminderSection(TASK, null);
  assert.equal(selectedOffset(html), 'offset_15m');
  assert.equal(warningVisible(html), false);
  assert.equal(formFromMarkup(html).querySelector('#reminder-stored-at')?.value, '');
});

// --------------------------------------------------------------------------
// Die GANZE Naht, nicht die halbe
//
// `reminderRemindAtFromForm` liest vier Felder. Solange nur zwei davon aus
// echtem Markup kommen, koennte man die anderen beiden im Renderer umbenennen,
// ohne dass eine Suite es merkt - und jedes Speichern mit eigenem Vorlauf
// stuerbe an `common.invalidInput`.
// --------------------------------------------------------------------------

const CUSTOM = { remind_at: '2026-09-18T17:29:59' }; // 23:59:59 lokal minus 90 Minuten

test('ein eigener Vorlauf ueberlebt den Weg durch das echte Markup', () => {
  const html = tasks.renderReminderSection(TASK, CUSTOM);
  assert.equal(selectedOffset(html), 'offset_custom', 'der Zustand ist „benutzerdefiniert"');
  const form = formFromMarkup(html);
  // Beide Custom-Felder kommen aus dem Markup, nicht aus dieser Datei.
  assert.equal(form.querySelector('#reminder-custom-amount')?.value, '90');
  assert.equal(form.querySelector('#reminder-custom-unit')?.value, 'minutes');
  assert.equal(
    tasks.reminderRemindAtFromForm(form, { dueDate: TASK.due_date, dueTime: TASK.due_time }),
    CUSTOM.remind_at,
    'derselbe Zeitpunkt kommt hinten wieder heraus',
  );
});

test('die Einheit wird gelesen, nicht geraten', () => {
  const html = tasks.renderReminderSection(TASK, CUSTOM);
  // Dieselben 90 als TAGE ergeben einen anderen Zeitpunkt - wuerde die Einheit
  // ignoriert, waere dieser Test nicht von dem darueber zu unterscheiden.
  const asDays = tasks.reminderRemindAtFromForm(
    formFromMarkup(html, { 'reminder-custom-unit': 'days' }),
    { dueDate: TASK.due_date, dueTime: TASK.due_time },
  );
  assert.notEqual(asDays, CUSTOM.remind_at);
  assert.equal(asDays, '2026-06-20T18:59:59');
});

// --------------------------------------------------------------------------
// Der Zustand heilt sich im Dialog
//
// „Nach der Faelligkeit" ist kein Merkmal der Erinnerung, sondern das
// VERHAELTNIS zweier Zeitpunkte. Wer die Faelligkeit nach hinten schiebt - der
// naheliegende Weg, das Problem zu beheben - loest den Zustand auf, und die
// Beschriftung darf nicht stehenbleiben.
// --------------------------------------------------------------------------

test('die Faelligkeit hinter die Erinnerung geschoben: der Zustand ist vorbei', () => {
  const opts = { dueTime: null, storedRemindAt: AFTER_DUE.remind_at };
  // 26.09. ohne Uhrzeit heisst 23:59:59; bis zur Erinnerung am 25.09. 11:00
  // (lokal) sind es 37 Stunden - kein runder Vorlauf, also „benutzerdefiniert".
  // Genau das ist der Regelfall beim Heilen, nicht der Ausnahmefall.
  assert.deepEqual(tasks.afterDueResolution('offset_after_due', { ...opts, dueDate: '2026-09-26' }),
    { preset: 'offset_custom', amount: '2220', unit: 'minutes' });
  assert.equal(tasks.afterDueResolution('offset_after_due', { ...opts, dueDate: '2026-09-18' }), null,
    'davor bleibt es beim Zustand');
});

test('trifft das Heilen einen runden Vorlauf, steht auch der da', () => {
  // 25.09. 12:00 lokal, eine Stunde nach der Erinnerung um 11:00.
  assert.deepEqual(
    tasks.afterDueResolution('offset_after_due', {
      dueDate: '2026-09-25', dueTime: '12:00', storedRemindAt: AFTER_DUE.remind_at,
    }),
    { preset: 'offset_1h', amount: '1', unit: 'days' },
  );
});

test('wer selbst einen Vorlauf gewaehlt hat, bekommt ihn nicht umgestellt', () => {
  const opts = { dueDate: '2026-09-26', dueTime: null, storedRemindAt: AFTER_DUE.remind_at };
  assert.equal(tasks.afterDueResolution('offset_1h', opts), null);
  assert.equal(tasks.afterDueResolution('offset_custom', opts), null);
});

test('ohne Faelligkeit oder ohne gespeicherten Zeitpunkt bleibt alles stehen', () => {
  assert.equal(tasks.afterDueResolution('offset_after_due', { dueDate: '', storedRemindAt: AFTER_DUE.remind_at }), null);
  assert.equal(tasks.afterDueResolution('offset_after_due', { dueDate: '2026-09-26', storedRemindAt: null }), null);
});

// --------------------------------------------------------------------------
// Und die Verdrahtung, die das ausloest
//
// Die Regel oben kann richtig sein, waehrend sie niemand ruft - und genau das
// waere der haeufigste Ausfall. Deshalb geht das Panel-Doppel durch
// `wireTaskForm`, den ECHTEN Verdrahter des Dialogs, statt durch
// `wireReminderAfterDue` von Hand: ein Test, der die Funktion selbst aufruft,
// beweist nur, dass die Funktion tut, was sie tut.
//
// Das Doppel liefert fuer jeden Selektor, den es nicht kennt, `null`. Alle
// anderen Verdrahtungen steigen daran per `?.` aus - `wireCountdownGate`
// namentlich, weil es ohne `#task-countdown` sofort zurueckkehrt. Die Listener
// an den Datumsfeldern stammen also aus genau einer Quelle.
// --------------------------------------------------------------------------

function fakePanel({ offsetValue = 'offset_after_due', dueDate = '2026-09-18', storedRemindAt = AFTER_DUE.remind_at, locked = false } = {}) {
  const el = (value, extra = {}) => ({
    value,
    listeners: {},
    addEventListener(type, fn) { (this.listeners[type] ??= []).push(fn); },
    fire(type) { for (const fn of this.listeners[type] ?? []) fn(); },
    ...extra,
  });
  const nodes = {
    '#reminder-offset': el(offsetValue, {
      disabled: locked,
      options: ['offset_none', 'offset_after_due', 'offset_at_time', 'offset_15m', 'offset_1h',
        'offset_1d', 'offset_2d', 'offset_1w', 'offset_2w', 'offset_custom'].map((value) => ({ value })),
    }),
    '#reminder-after-due-warning': el('', { hidden: false }),
    '#reminder-stored-at': el(storedRemindAt ?? ''),
    // Auf dem Render-Stand, wie im echten Dialog: 1 Tag, versteckt.
    '#reminder-custom-amount': el('1'),
    '#reminder-custom-unit': el('days'),
    '#reminder-custom-fields': el('', { style: { display: 'none' } }),
    '#task-due-date': el(dueDate),
    '#task-due-time': el(''),
  };
  return {
    nodes,
    querySelector: (sel) => nodes[sel] ?? null,
    querySelectorAll: () => [],
    addEventListener: () => {},
  };
}

/** Verdrahtet das Doppel so, wie der Dialog es tut. */
function wireLikeTheDialog(panel) {
  tasks.wireTaskForm(panel, { task: null });
  return panel;
}

test('DER DIALOG haengt die Verdrahtung an - an beide Felder, an beide Ereignisse', () => {
  const panel = wireLikeTheDialog(fakePanel());
  for (const sel of ['#task-due-date', '#task-due-time']) {
    for (const type of ['change', 'input']) {
      assert.equal(panel.nodes[sel].listeners[type]?.length, 1, `${sel} hoert auf ${type}`);
    }
  }
});

test('ein Tastendruck im Datumsfeld stellt den ganzen Abschnitt um', () => {
  const panel = wireLikeTheDialog(fakePanel());

  // Faelligkeit hinter die Erinnerung getippt - `input`, nicht `change`.
  panel.nodes['#task-due-date'].value = '2026-09-26';
  panel.nodes['#task-due-date'].fire('input');

  assert.equal(panel.nodes['#reminder-offset'].value, 'offset_custom', 'die Auswahl nennt den neuen Vorlauf');
  assert.equal(panel.nodes['#reminder-after-due-warning'].hidden, true, 'der Warnton ist weg');
  // DER KERN: die Felder darunter stehen nicht mehr auf dem Render-Stand.
  assert.equal(panel.nodes['#reminder-custom-amount'].value, '2220');
  assert.equal(panel.nodes['#reminder-custom-unit'].value, 'minutes');
  assert.equal(panel.nodes['#reminder-custom-fields'].style.display, '', 'und sie sind zu sehen');
});

test('nach dem Heilen ergibt das Speichern denselben Zeitpunkt, auf die Sekunde genau', () => {
  // Die Rundprobe, die zaehlt: ein umgestellter Abschnitt, der die Erinnerung
  // trotzdem VERSCHIEBT, waere derselbe Schaden in neuem Gewand.
  const panel = wireLikeTheDialog(fakePanel());
  panel.nodes['#task-due-date'].value = '2026-09-26';
  panel.nodes['#task-due-date'].fire('change');

  const saved = tasks.reminderRemindAtFromForm(panel, { dueDate: '2026-09-26', dueTime: null });

  // EINE SEKUNDE, UND SIE GEHOERT NICHT DIESEM ZUSTAND. Eine Faelligkeit ohne
  // Uhrzeit ist 23:59:59, ein eigener Vorlauf zaehlt in ganzen Minuten - die
  // beiden treffen sich nie. Derselbe Verlust entsteht beim ganz gewoehnlichen
  // Oeffnen und Speichern eines krummen Vorlaufs, ohne dass jemand die
  // Faelligkeit anfasst, und er wiederholt sich nicht: ab der zweiten Runde
  // steht der Wert. Hier steht er ausgeschrieben, damit niemand ihn spaeter
  // fuer einen Fehler DIESES Weges haelt.
  assert.equal(saved, '2026-09-25T05:59:59');
  const drift = Math.abs(new Date(`${saved}Z`) - new Date(`${AFTER_DUE.remind_at}Z`));
  assert.ok(drift < 60000, `die Erinnerung bleibt in ihrer Minute (${drift} ms)`);
});

test('der Sekundenverlust haengt an der Minutenaufloesung, nicht am Heilen', () => {
  // Gegenprobe zum Test darueber: derselbe Verlust ohne jedes Zutun des neuen
  // Zustands - eine Aufgabe mit krummem Vorlauf, geoeffnet und gespeichert.
  const task = { due_date: '2026-09-26', due_time: null };
  const html = tasks.renderReminderSection(task, { remind_at: AFTER_DUE.remind_at });
  assert.equal(selectedOffset(html), 'offset_custom', 'kein „nach der Faelligkeit" im Spiel');
  assert.equal(
    tasks.reminderRemindAtFromForm(formFromMarkup(html), { dueDate: task.due_date, dueTime: null }),
    '2026-09-25T05:59:59',
  );
});

test('zurueck vor die Erinnerung, und die Wahl bleibt trotzdem stehen', () => {
  const panel = wireLikeTheDialog(fakePanel());
  panel.nodes['#task-due-date'].value = '2026-09-26';
  panel.nodes['#task-due-date'].fire('change');
  assert.equal(panel.nodes['#reminder-after-due-warning'].hidden, true);

  // Der Nutzer nimmt die Verschiebung zurueck. Die Auswahl steht jetzt auf
  // `offset_custom` - sie wurde nicht von Hand gewaehlt, aber sie steht da, und
  // genau deshalb ruehrt die Regel sie nicht mehr an.
  panel.nodes['#task-due-date'].value = '2026-09-18';
  panel.nodes['#task-due-date'].fire('change');
  assert.equal(panel.nodes['#reminder-offset'].value, 'offset_custom',
    'eine einmal gezeigte Wahl wird nicht wieder umgestellt');
});

test('das Umstellen schreibt nur, was die Auswahl auch fuehrt', () => {
  // Eine Auswahl ohne den Ziel-Eintrag: der Browser faende ihn nicht und
  // setzte stillschweigend auf den ersten Eintrag - aus einem Vorlauf wuerde
  // „Keine", und das Speichern loeschte die Erinnerung.
  const panel = fakePanel();
  panel.nodes['#reminder-offset'].options = [{ value: 'offset_none' }, { value: 'offset_after_due' }];
  wireLikeTheDialog(panel);
  panel.nodes['#task-due-date'].value = '2026-09-26';
  panel.nodes['#task-due-date'].fire('change');
  assert.equal(panel.nodes['#reminder-offset'].value, 'offset_after_due', 'unveraendert statt falsch');
  assert.equal(panel.nodes['#reminder-custom-amount'].value, '1', 'und die Felder bleiben unberuehrt');
});

test('ein gesperrter Abschnitt wird auch vom Datumswechsel nicht angefasst', () => {
  // Mit `calendar: read` ist die Erinnerung gesperrt, das Faelligkeitsdatum
  // aber bedienbar - es gehoert dem Aufgaben-Modul (#1253). Ein gesperrtes
  // Feld, das sich unter der Hand aendert, behauptete einen gespeicherten
  // Zustand, den es nicht gibt: das Speichern fasst die Erinnerung ohne
  // Schreibrecht gar nicht an.
  const panel = wireLikeTheDialog(fakePanel({ locked: true }));
  panel.nodes['#task-due-date'].value = '2026-09-26';
  panel.nodes['#task-due-date'].fire('change');

  assert.equal(panel.nodes['#reminder-offset'].value, 'offset_after_due', 'die Auswahl bleibt stehen');
  assert.equal(panel.nodes['#reminder-custom-amount'].value, '1', 'und die Felder darunter auch');
  assert.equal(panel.nodes['#reminder-after-due-warning'].hidden, false, 'der Warnton bleibt, wie er gespeichert ist');
});

test('ein halb getipptes Datum ist kein Datum - der Verlass, auf dem der input-Listener ruht', async () => {
  // Der Listener feuert bei JEDEM Tastendruck, und die Umstellung ist eine
  // Einbahnstrasse: was einmal geheilt ist, bleibt beim gezeigten Vorlauf.
  // Ginge ein Zwischenstand wie „2026-09-1" als gueltiges Datum durch,
  // schriebe schon das Tippen einen Vorlauf fest, den niemand gemeint hat -
  // und der naechste Tastendruck koennte ihn nicht zuruecknehmen.
  //
  // GEPRUEFT WIRD DIE ECHTE FUNKTION, NICHT DER WEG DURCH DEN LISTENER. Der
  // Browser-Loader ersetzt `/i18n.js` durch einen Stub, dessen
  // `parseDateInput` jede Eingabe unveraendert durchreicht - ein Test ueber
  // den Listener pruefte also den Stub und waere gruen, egal was die echte
  // Funktion tut. Der relative Import unten umgeht den Stub.
  const { parseDateInput } = await import('../public/i18n.js');
  for (const typed of ['2', '20', '202', '2026', '2026-', '2026-0', '2026-09', '2026-09-', '2026-09-1']) {
    assert.equal(parseDateInput(typed), '', `„${typed}" ist noch kein Datum`);
  }
  assert.equal(parseDateInput('2026-09-26'), '2026-09-26', 'erst das vollstaendige Datum zaehlt');
  // Und ein leeres Datum stellt nichts um - das ist die Seite, die der
  // Listener davon sieht.
  assert.equal(tasks.afterDueResolution('offset_after_due', { dueDate: '', storedRemindAt: AFTER_DUE.remind_at }), null);
});
