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
 *          - ein normaler Vorlauf bringt weder Eintrag noch Warnton mit.
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
