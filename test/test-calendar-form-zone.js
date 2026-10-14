/**
 * Modul: Terminformular, wenn Browser- und Serverzone auseinanderliegen (#1958)
 * Zweck: Ohne Haushaltszone zeigt das Formular einen Termin in der Zone des
 *        BROWSERS (`displayTimeZone()` ist dann null), der Server deutet eine
 *        zonenlose Wanduhrzeit aber in SEINER Zone (`householdTimeZone()` faellt
 *        auf die Prozesszone zurueck). Ein eingelesener Termin liegt als Instant
 *        in der Zeile (`14:00:00Z`); das Formular zeigte ihn in New York als
 *        10:00 und schickte beim Speichern `10:00` als nackte Ziffern zurueck -
 *        gespeichert stand danach 10:00 Serverzeit, vier Stunden daneben, auch
 *        wenn nur der Titel geaendert wurde.
 *
 *        GEMESSEN WIRD DER GANZE WEG. Das Formular entsteht aus dem echten
 *        Markup (`buildEventModalContent`), verdrahtet wird es von
 *        `wireEventForm`, und was `saveEvent` schickt, geht an die echte Route.
 *        Die beiden Zonen sind ausdruecklich getrennt: das Formular rechnet
 *        unter `BROWSER_ZONE`, die Route laeuft unter `SERVER_ZONE` (die
 *        Prozesszone wird fuer die Dauer der Anfrage umgestellt), und eine
 *        Haushaltszone ist nicht gesetzt. Zwei Browserzonen, eine westlich und
 *        eine oestlich von UTC: eine Rechnung, die nur in eine Richtung stimmt,
 *        faellt in der anderen auf.
 *
 *        Zugesichert wird an zwei Enden: die Zeile meint danach denselben
 *        Zeitpunkt wie vorher (die Sicht des Servers), und das neu geoeffnete
 *        Formular zeigt dieselben Ziffern wie vorher (die Sicht des Browsers).
 * Ausfuehren: npm run test:calendar-form-zone
 */
process.env.TZ = 'UTC';
process.env.SESSION_SECRET = process.env.SESSION_SECRET || 'test-secret';
process.env.DB_PATH = ':memory:';

import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';

const SERVER_ZONE = 'UTC';
const BROWSER_ZONES = ['America/New_York', 'Europe/Berlin'];

globalThis.window = globalThis.window ?? {};
globalThis.window.yuvomi = { showToast() {} };

const dbmod = await import('../server/db.js');
const { default: calendarRouter } = await import('../server/routes/calendar.js');
const { householdTimeZone, configuredHouseholdTimeZone, storedToInstantMs } = await import('../server/utils/timezone.js');
const { __test: calendar } = await import('../public/pages/calendar.js');
const { displayTimeZone } = await import('../public/utils/timezone.js');
const db = dbmod.get();

db.prepare("INSERT INTO users (username, display_name, password_hash, role) VALUES ('admin','Admin','x','admin')").run();

const app = express();
app.use(express.json({ limit: '5mb' }));
app.use((req, _res, next) => {
  req.authUserId = 1; req.authRole = 'admin';
  req.session = { userId: 1, role: 'admin' };
  req.user = { id: 1, role: 'admin' };
  next();
});
app.use('/', calendarRouter);
const server = app.listen(0, '127.0.0.1');
const baseUrl = await new Promise((r) => server.on('listening', () => r(`http://127.0.0.1:${server.address().port}`)));
test.after(() => server.close());

/** Fuehrt `fn` unter der Prozesszone `zone` aus und stellt sie danach zurueck. */
async function inZone(zone, fn) {
  const before = process.env.TZ;
  process.env.TZ = zone;
  try { return await fn(); } finally { process.env.TZ = before; }
}

// --------------------------------------------------------------------------
// Ein Formular-Doppel, gerade gross genug fuer wireEventForm + saveEvent
// (kein jsdom, siehe test/mini-dom.js; dieselbe Bauart wie in
// test-calendar-reminder-after-start.js)
// --------------------------------------------------------------------------

class FakeEl {
  constructor(tag, { id = null } = {}) {
    this.tagName = tag.toUpperCase();
    this.id = id;
    this.classes = new Set();
    this.classList = {
      add: (c) => this.classes.add(c),
      remove: (c) => this.classes.delete(c),
      toggle: (c, on) => (on ?? !this.classes.has(c)) ? this.classes.add(c) : this.classes.delete(c),
      contains: (c) => this.classes.has(c),
    };
    this.attrs = {};
    this.dataset = {};
    this.children = [];
    this.parent = null;
    this.listeners = {};
    this.hidden = false;
    this.disabled = false;
    this.checked = false;
    this.style = {};
    this.textContent = '';
    this.value = '';
  }

  append(child) { child.parent = this; this.children.push(child); return child; }
  matches(selector) {
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
  removeEventListener(type, fn) { this.listeners[type] = (this.listeners[type] ?? []).filter((f) => f !== fn); }
  dispatch(type) {
    const event = { type, target: this, preventDefault() {} };
    for (let node = this; node; node = node.parent) {
      for (const fn of [...(node.listeners[type] ?? [])]) fn(event);
    }
  }
  setAttribute(name, value) { this.attrs[name] = String(value); }
  getAttribute(name) { return this.attrs[name] ?? null; }
  insertAdjacentHTML() {}
}

const attrOf = (markup, id) => {
  const tag = new RegExp(`<[^>]*\\bid="${id}"[^>]*>`).exec(markup)?.[0] ?? '';
  return { value: /\bvalue="([^"]*)"/.exec(tag)?.[1] ?? '', checked: /\schecked\b/.test(tag) };
};

/** Was das echte Formular fuer diesen Termin in seine Felder schreibt. */
function formValues(event, create = null) {
  const markup = calendar.buildEventModalContent(create ? { mode: 'create', ...create } : { mode: 'edit', event });
  const ids = ['modal-start-date', 'modal-start-time', 'modal-end-date', 'modal-end-time',
    'modal-allday-start', 'modal-allday-end'];
  const values = Object.fromEntries(ids.map((id) => [id, attrOf(markup, id).value]));
  values['modal-allday'] = attrOf(markup, 'modal-allday').checked;
  return values;
}

function openDialog(event, create = null) {
  const values = formValues(event, create);
  const panel = new FakeEl('div');
  const field = (id, value = '', tag = 'input') => {
    const el = panel.append(new FakeEl(tag, { id }));
    el.value = value;
    return el;
  };
  field('modal-title', event?.title ?? '');
  const allday = field('modal-allday');
  allday.type = 'checkbox';
  allday.checked = values['modal-allday'];
  field('time-fields', '', 'div');
  field('allday-fields', '', 'div');
  for (const id of ['modal-start-date', 'modal-start-time', 'modal-end-date', 'modal-end-time',
    'modal-allday-start', 'modal-allday-end']) field(id, values[id]);
  field('modal-location', event?.location ?? '');
  field('modal-description', event?.description ?? '');
  field('modal-cancel', '', 'button');
  field('modal-save', '', 'button');
  const toggle = field('modal-reminder-toggle');
  toggle.type = 'checkbox';
  const fields = field('modal-reminder-fields', '', 'div');
  fields.append(new FakeEl('div', { id: 'modal-reminder-rows' }));
  fields.append(new FakeEl('button', { id: 'modal-reminder-add' }));
  calendar.wireEventForm(panel, { mode: create ? 'create' : 'edit', event, reminder: [] });
  return panel;
}

function userSets(el, value, type = 'change') {
  el.value = value;
  el.dispatch(type);
}

/**
 * Faehrt `saveEvent` unter der Browserzone; jede Kalenderanfrage geht unter der
 * Serverzone an die echte Route. Erinnerungen bleiben aussen vor.
 */
async function save(panel, event, mode = 'edit') {
  const requests = [];
  const forward = (method) => async (path, body) => {
    if (!path.startsWith('/calendar')) return { data: null };
    requests.push({ method, path, body });
    return inZone(SERVER_ZONE, async () => {
      const res = await fetch(`${baseUrl}${path.slice('/calendar'.length) || '/'}`, {
        method: method.toUpperCase(),
        headers: { 'content-type': 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      const json = await res.json();
      assert.equal(res.status < 400, true, `${method} ${path}: ${res.status} ${JSON.stringify(json)}`);
      return json;
    });
  };
  globalThis.__closeModal = () => {};
  globalThis.__apiStub = {
    get: forward('get'), post: forward('post'), put: forward('put'),
    patch: forward('patch'), delete: forward('delete'),
  };
  globalThis.__rruleValues = { recurrence_rule: event?.recurrence_rule ?? null, valid_until: true };
  globalThis.__reportFieldError = (_input, message) => { throw new Error(`Feldfehler: ${message}`); };
  try {
    await calendar.saveEvent(panel, mode, event, [], null);
  } finally {
    delete globalThis.__apiStub;
    delete globalThis.__rruleValues;
    delete globalThis.__reportFieldError;
    delete globalThis.__closeModal;
  }
  return requests;
}

function insertEvent({ title, start, end, allDay = false, source = 'caldav' }) {
  return Number(db.prepare(`
    INSERT INTO calendar_events
      (title, start_datetime, end_datetime, created_by, color, icon, visibility,
       external_source, all_day, user_modified)
    VALUES (?, ?, ?, 1, '#007AFF', 'calendar', 'all', ?, ?, 0)
  `).run(title, start, end, source, allDay ? 1 : 0).lastInsertRowid);
}

const row = (id) => db.prepare('SELECT * FROM calendar_events WHERE id = ?').get(id);

/** Der Termin, wie ihn das Formular bekommt (die Felder, die es liest). */
const asEvent = (r) => ({ ...r, all_day: r.all_day, assigned_users: [], recurrence_rule: r.recurrence_rule ?? null });

/** Der Zeitpunkt, den der Server in einem gespeicherten Wert liest. */
const serverInstant = (value) => inZone(SERVER_ZONE, () => storedToInstantMs(value, householdTimeZone(db)));

// --------------------------------------------------------------------------
// Vorbedingungen: die Zonen stehen da, wo der Test sie braucht
// --------------------------------------------------------------------------

test('Vorbedingung: keine Haushaltszone, keine Anzeigezone, die Zonen sind getrennt umstellbar', async () => {
  assert.equal(configuredHouseholdTimeZone(db), null, 'ohne Haushaltszone - das ist der Fall aus #1958');
  assert.equal(displayTimeZone(), null, 'das Formular zeigt in der Zone des Browsers');
  for (const zone of BROWSER_ZONES) {
    await inZone(zone, async () => {
      assert.equal(Intl.DateTimeFormat().resolvedOptions().timeZone, zone, 'die Browserzone greift');
      await inZone(SERVER_ZONE, () => {
        assert.equal(householdTimeZone(db), SERVER_ZONE, 'die Route liest die Serverzone');
      });
    });
  }
});

// --------------------------------------------------------------------------
// Ein Speichern, das die Zeit nicht anfasst, laesst sie stehen
// --------------------------------------------------------------------------

for (const browserZone of BROWSER_ZONES) {
  test(`${browserZone}: Titel-Edit an einem eingelesenen Termin (Instant) verschiebt ihn nicht`, async () => {
    const id = insertEvent({ title: 'Import', start: '2026-10-14T14:00:00Z', end: '2026-10-14T15:00:00Z' });
    const before = row(id);
    const instantStart = await serverInstant(before.start_datetime);
    const instantEnd = await serverInstant(before.end_datetime);

    await inZone(browserZone, async () => {
      const shownBefore = formValues(asEvent(before));
      const panel = openDialog(asEvent(before));
      userSets(panel.querySelector('#modal-title'), 'Import, umbenannt', 'input');
      await save(panel, asEvent(before));

      const after = row(id);
      assert.equal(after.title, 'Import, umbenannt', 'gespeichert wurde');
      assert.equal(await serverInstant(after.start_datetime), instantStart,
        `der Server liest denselben Beginn (vorher ${before.start_datetime}, nachher ${after.start_datetime})`);
      assert.equal(await serverInstant(after.end_datetime), instantEnd,
        `der Server liest dasselbe Ende (vorher ${before.end_datetime}, nachher ${after.end_datetime})`);
      assert.deepEqual(formValues(asEvent(after)), shownBefore, 'das Formular zeigt danach dieselben Ziffern');
    });
  });

  test(`${browserZone}: Titel-Edit an einem lokal angelegten Termin (Wanduhrzeit) laesst ihn stehen`, async () => {
    const id = insertEvent({ title: 'Lokal', start: '2026-10-14T19:00', end: '2026-10-14T20:00', source: 'local' });
    const before = row(id);
    await inZone(browserZone, async () => {
      const shownBefore = formValues(asEvent(before));
      const panel = openDialog(asEvent(before));
      userSets(panel.querySelector('#modal-title'), 'Lokal, umbenannt', 'input');
      await save(panel, asEvent(before));
      const after = row(id);
      assert.equal(after.title, 'Lokal, umbenannt');
      assert.equal(after.start_datetime, before.start_datetime);
      assert.equal(after.end_datetime, before.end_datetime);
      assert.deepEqual(formValues(asEvent(after)), shownBefore);
    });
  });

  test(`${browserZone}: Titel-Edit an einem ganztaegigen Termin laesst seine Tage stehen`, async () => {
    // Zwei Speicherformen: das reine Datum (lokal, CalDAV `VALUE=DATE`) und
    // ein ganztaegiger Termin, der als Mitternacht UTC in der Zeile liegt.
    for (const [start, end] of [['2026-10-14', '2026-10-15'], ['2026-10-14T00:00:00Z', '2026-10-15T00:00:00Z']]) {
      const id = insertEvent({ title: 'Ganztags', start, end, allDay: true });
      const before = row(id);
      await inZone(browserZone, async () => {
        const shownBefore = formValues(asEvent(before));
        const panel = openDialog(asEvent(before));
        userSets(panel.querySelector('#modal-title'), 'Ganztags, umbenannt', 'input');
        await save(panel, asEvent(before));
        const after = row(id);
        assert.equal(after.title, 'Ganztags, umbenannt');
        assert.equal(after.start_datetime.slice(0, 10), before.start_datetime.slice(0, 10),
          `${start}: derselbe Starttag fuer den Server (nachher ${after.start_datetime})`);
        assert.equal(after.end_datetime.slice(0, 10), before.end_datetime.slice(0, 10),
          `${start}: derselbe Endtag fuer den Server (nachher ${after.end_datetime})`);
        assert.deepEqual(formValues(asEvent(after)), shownBefore, `${start}: dieselben Tage im Formular`);
      });
    }
  });

  // ------------------------------------------------------------------------
  // Wer die Zeit aendert, bekommt, was er eingetippt hat
  //
  // Ohne Haushaltszone ist eine eingetippte Uhrzeit eine Wanduhrzeit: der
  // Browser zeigt sie, wie sie eingetippt wurde, und der Server liest sie in
  // seiner Zone. Das ist der Vertrag fuer jeden lokal angelegten Termin seit
  // #829 und nicht Gegenstand von #1958; die Faelle hier halten fest, dass der
  // Fix daran nichts verschiebt.
  // ------------------------------------------------------------------------

  test(`${browserZone}: Neuanlage - der Termin steht danach so da, wie er eingetippt wurde`, async () => {
    await inZone(browserZone, async () => {
      const title = `Neu ${browserZone}`;
      const create = { date: '2026-10-14', time: '19:00' };
      const panel = openDialog(null, create);
      userSets(panel.querySelector('#modal-title'), title, 'input');
      const requests = await save(panel, null, 'create');
      assert.equal(requests.find((r) => r.method === 'post')?.body.start_datetime, '2026-10-14T19:00');
      const created = db.prepare('SELECT * FROM calendar_events WHERE title = ?').get(title);
      assert.equal(created.start_datetime, '2026-10-14T19:00', 'als Wanduhrzeit gespeichert');
      const shown = formValues(asEvent(created));
      assert.equal(shown['modal-start-date'], '2026-10-14');
      assert.equal(shown['modal-start-time'], '19:00', 'und so wieder angezeigt');
    });
  });

  test(`${browserZone}: eine geaenderte Uhrzeit steht danach so im Formular, wie sie eingetippt wurde`, async () => {
    const id = insertEvent({ title: 'Verschoben', start: '2026-10-14T14:00:00Z', end: '2026-10-14T15:00:00Z' });
    const before = row(id);
    await inZone(browserZone, async () => {
      const panel = openDialog(asEvent(before));
      userSets(panel.querySelector('#modal-start-time'), '11:30');
      const requests = await save(panel, asEvent(before));
      const sent = requests.find((r) => r.method === 'put')?.body;
      assert.ok(sent?.start_datetime && sent?.end_datetime, 'Beginn und Ende gehen zusammen mit');
      const after = row(id);
      const shown = formValues(asEvent(after));
      assert.equal(shown['modal-start-time'], '11:30', `angezeigt wie eingetippt (gespeichert ${after.start_datetime})`);
      assert.equal(shown['modal-end-time'], '12:30', 'das Ende ist mit der Dauer mitgewandert');
      assert.equal(/Z$|[+-]\d{2}:?\d{2}$/.test(after.start_datetime), /Z$|[+-]\d{2}:?\d{2}$/.test(after.end_datetime),
        'Beginn und Ende tragen dieselbe Speicherform');
    });
  });

  test(`${browserZone}: nur das Ende geaendert - Beginn und Ende bleiben in derselben Speicherform`, async () => {
    const id = insertEvent({ title: 'Laenger', start: '2026-10-14T14:00:00Z', end: '2026-10-14T15:00:00Z' });
    const before = row(id);
    await inZone(browserZone, async () => {
      const shownBefore = formValues(asEvent(before));
      const panel = openDialog(asEvent(before));
      const [h, m] = shownBefore['modal-end-time'].split(':').map(Number);
      const later = `${String(h + 1).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
      userSets(panel.querySelector('#modal-end-time'), later);
      await save(panel, asEvent(before));
      const after = row(id);
      const shown = formValues(asEvent(after));
      assert.equal(shown['modal-start-time'], shownBefore['modal-start-time'], 'der Beginn steht, wo er stand');
      assert.equal(shown['modal-end-time'], later, 'das Ende wie eingetippt');
      assert.equal(/Z$/.test(after.start_datetime), /Z$/.test(after.end_datetime),
        `eine Zeile, eine Speicherform (${after.start_datetime} / ${after.end_datetime})`);
    });
  });
}
