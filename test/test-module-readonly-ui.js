/**
 * Modul: Kreuzabhaengige Modulrechte in der Oberflaeche
 * Zweck: Ein Dialog gehoert EINEM Modul, schreibt aber in ein zweites. Diese
 *        Suite haelt den einen Fall fest, den es gibt: der Aufgaben-Dialog
 *        (`tasks`) stellt die Erinnerung ein, und Erinnerungen gehoeren dem
 *        Kalender - `server/scopes.js` fuehrt die Praefixe `calendar`,
 *        `reminders` und `birthdays` unter EINEM Schluessel. Wer `tasks: write`
 *        und `calendar: read` traegt, sah deshalb einen Schalter, dessen
 *        Speichern serverseitig mit 403 endete: die Aufgabe war gespeichert,
 *        die Erinnerung nicht.
 *
 *        Geprueft wird an beiden Enden, weil der Riegel an beiden Enden sitzt:
 *          - am Markup, das `renderModalContent()` wirklich erzeugt (gesperrt
 *            bei `read`, weg bei `none`, unveraendert bei `write`),
 *          - am gefahrenen `handleFormSubmit()`, das die Erinnerungs-Anfrage
 *            dann UNTERLASSEN muss. Das ist die Haelfte, die kein Textguard
 *            sehen kann: er liest einen Aufruf, nicht dessen Ausbleiben.
 *
 *        Die Gegenrichtung braucht keinen Test: `public/pages/calendar.js` und
 *        `public/pages/birthdays.js` schreiben nichts nach `/tasks`, und ihr
 *        Erinnerungsabschnitt liegt im eigenen Modul. Gemessen mit einem Sweep
 *        ueber `moduleForPath()` gegen jedes `api.post/put/patch/delete` in
 *        `public/pages/*`; die drei weiteren Kreuzpfade (Haushaltshilfe →
 *        `/documents`, Vorrat ↔ Einkauf) sind Handlungsknoepfe ohne Zustand und
 *        stehen in der Notiz zum Vorgang, nicht hier.
 *
 *        KEIN eigenes mini-dom: die Attrappen unten reichen genau so weit, wie
 *        der Handler greift, und stehen deshalb hier statt in einer geteilten
 *        Datei mit einem Verbraucher - ein Stub fuer einen Verbraucher kann nur
 *        driften (siehe die Begruendung zu date.js im Loader).
 * Ausfuehren: npm run test:module-readonly-ui
 */
import test from 'node:test';
import assert from 'node:assert/strict';

globalThis.HTMLElement = globalThis.HTMLElement ?? class {};
globalThis.customElements = globalThis.customElements ?? { define() {}, get() {} };
const localStore = new Map();
globalThis.localStorage = {
  getItem: (k) => (localStore.has(k) ? localStore.get(k) : null),
  setItem: (k, v) => { localStore.set(k, String(v)); },
  removeItem: (k) => { localStore.delete(k); },
  clear: () => localStore.clear(),
};

// --------------------------------------------------------------------------
// Attrappen: nur so viel DOM, wie handleFormSubmit wirklich anfasst
// --------------------------------------------------------------------------

/** Ein Feld, wie der Handler es liest: `.value`, sonst nichts. */
const field = (value = '') => ({ value: String(value) });

/**
 * Das Formular. Benannte Felder liegen direkt darauf (`form.title.value` -
 * genau wie im Browser), alles mit einer id kommt ueber querySelector.
 */
function fakeForm({ byId = {}, ...named } = {}) {
  const form = {
    querySelector: (sel) => byId[sel] ?? null,
  };
  for (const [name, value] of Object.entries(named)) form[name] = field(value);
  return form;
}

/** Fehlerzeile, Knopf und die versteckte Task-id - drei getElementById-Ziele. */
function fakeDocument(taskId = '') {
  const nodes = {
    'task-form-error': { hidden: true, textContent: '' },
    'task-submit-btn': { disabled: false, textContent: '', classList: { add() {}, remove() {} } },
    'task-id': field(taskId),
  };
  return {
    getElementById: (id) => nodes[id] ?? null,
    documentElement: { lang: 'de', classList: { toggle() {}, add() {}, remove() {}, contains: () => false } },
    addEventListener() {},
  };
}

globalThis.document = fakeDocument();
globalThis.window = {
  yuvomi: { showToast() {} },
  location: { search: '' },
  matchMedia: () => ({ matches: false, addEventListener() {} }),
  addEventListener() {},
};
// Der Loader-Stub gibt ohne diesen Haken ein leeres Objekt zurueck, und der
// Handler bricht dann an `!rrule.valid_until` mit "invalidDate" ab, bevor er
// ueberhaupt bis zur Erinnerung kommt.
globalThis.__rruleValues = { is_recurring: 0, recurrence_rule: null, recurrence_from_completion: 0, valid_until: true };

const permissions = await import('../public/permissions.js');
const { __test: tasks } = await import('../public/pages/tasks.js');

/** Rechte setzen, Test fahren, Rechte zurueckgeben. */
function withModules(modules, fn) {
  const saved = permissions.getPermissions();
  try {
    permissions.setPermissions({ admin: false, modules, widgets: {}, capabilities: {} });
    return fn();
  } finally {
    permissions.setPermissions(saved);
  }
}

const TASK = {
  id: 7, title: 'Fenster putzen', status: 'open', priority: 'none', category: 'household',
  visibility: 'all', due_date: '2026-10-01', assigned_to: null, assigned_users: [],
};
const REMINDER = { id: 3, entity_type: 'task', entity_id: 7, remind_at: '2026-09-30T23:59:59' };

/** Der Erinnerungsabschnitt aus dem echten Dialog-Markup, oder '' . */
function reminderSection(html) {
  const start = html.indexOf('<div class="reminder-section">');
  if (start < 0) return '';
  const end = html.indexOf('<div id="task-form-error"', start);
  assert.ok(end > start, 'der Abschnitt endet vor der Fehlerzeile des Formulars');
  return html.slice(start, end);
}

/** Jedes Bedienelement des Abschnitts, mit seinem oeffnenden Tag. */
function controls(section) {
  return [...section.matchAll(/<(input|select|textarea)\b[^>]*>/g)].map((m) => m[0]);
}

// --------------------------------------------------------------------------
// Vorbedingung der Suite
// --------------------------------------------------------------------------

/**
 * Eine Zusicherung weiter unten nennt einen UTC-Zeitpunkt, der aus einer
 * Wanduhrzeit entsteht - der Wert haengt also an der Zone. Faellt das `TZ=` aus
 * dem npm-Script, misst diese Suite still die Zone der Maschine und ist auf
 * jeder anderen rot (oder, schlimmer, gruen aus dem falschen Grund). Deshalb
 * steht die Zone hier als eigene Zusicherung und nicht nur als Kommentar.
 *
 * Gefragt wird `process.env.TZ`, NICHT `Intl...resolvedOptions().timeZone`:
 * letzteres faellt ohne `TZ=` auf die SYSTEMZONE zurueck, und die ist auf dem
 * Entwicklungsrechner gerade Europe/Berlin. Ein verlorenes `TZ=` waere lokal
 * also gruen geblieben und erst in der CI (UTC) rot - genau der Fehler, den
 * dieser Test ausschliessen soll. Nachgemessen: ohne `TZ=` meldet Intl
 * "Europe/Berlin" und `process.env.TZ` ist undefined.
 */
test('die Suite laeuft in der Zone, auf die ihre Zeitpunkte festgenagelt sind', () => {
  assert.equal(
    process.env.TZ,
    'Europe/Berlin',
    'npm run test:module-readonly-ui setzt TZ=Europe/Berlin',
  );
});

// --------------------------------------------------------------------------
// Markup: gesperrt bei read, weg bei none, unveraendert bei write
// --------------------------------------------------------------------------

test('calendar: write laesst den Erinnerungsabschnitt unangetastet', () => {
  withModules({ tasks: 'write', calendar: 'write' }, () => {
    const section = reminderSection(tasks.renderModalContent({ task: TASK, users: [], reminder: REMINDER }));
    assert.ok(section, 'der Abschnitt steht im Dialog');
    assert.ok(controls(section).length >= 4, 'Schalter, Vorlauf und die zwei eigenen Felder');
    for (const tag of controls(section)) {
      assert.doesNotMatch(tag, /\sdisabled/, `kein Feld ist gesperrt: ${tag}`);
    }
    assert.doesNotMatch(section, /reminders\.readOnlyNotice/, 'kein Hinweis, wo es nichts zu erklaeren gibt');
  });
});

test('calendar: write zeigt den Abschnitt auch OHNE bestehende Erinnerung - dort wird ja angelegt', () => {
  withModules({ tasks: 'write', calendar: 'write' }, () => {
    for (const args of [
      { task: null, users: [], reminder: null },
      { task: TASK, users: [], reminder: null },
    ]) {
      const section = reminderSection(tasks.renderModalContent(args));
      assert.ok(section, 'mit Schreibrecht ist der leere Schalter das Angebot, eine anzulegen');
      assert.equal(controls(section).filter((tag) => /\sdisabled/.test(tag)).length, 0);
    }
  });
});

test('calendar: read sperrt JEDES Feld des Abschnitts und laesst die Erinnerung stehen', () => {
  withModules({ tasks: 'write', calendar: 'read' }, () => {
    const section = reminderSection(tasks.renderModalContent({ task: TASK, users: [], reminder: REMINDER }));
    assert.ok(section, 'eine bestehende Erinnerung IST Zustand und bleibt sichtbar');
    assert.match(section, /id="reminder-toggle"[^>]*\schecked/, 'der gespeicherte Stand steht weiter da');
    const tags = controls(section);
    assert.ok(tags.length >= 4, 'der Abschnitt bringt seine Felder mit');
    // Die Regel, nicht die Aufzaehlung: ein spaeter dazugekommenes Feld ohne
    // `disabled` faellt hier auf, ohne dass diese Liste gepflegt werden muss.
    for (const tag of tags) {
      assert.match(tag, /\sdisabled/, `gesperrt gehoert auch: ${tag}`);
    }
    assert.match(section, /reminders\.readOnlyNotice/, 'der Dialog sagt, warum');
  });
});

// Die erste Fassung dieses Riegels sperrte den Abschnitt bei `read` immer -
// auch dort, wo es nichts zu sperren gab. Das widerspricht derselben
// Faustregel, mit der `none` begruendet ist: gesperrt wird ZUSTAND, und ein
// leerer Schalter ist keiner. Beide Wege dorthin stehen hier, weil sie
// verschiedene Ursachen haben: im Anlege-Dialog gibt es die Aufgabe noch
// nicht, an einer bestehenden Aufgabe hing nie eine Erinnerung.
test('calendar: read zeigt im ANLEGE-Dialog keinen Abschnitt - eine neue Aufgabe hat keinen Zustand', () => {
  withModules({ tasks: 'write', calendar: 'read' }, () => {
    const html = tasks.renderModalContent({ task: null, users: [], reminder: null });
    assert.equal(reminderSection(html), '', 'kein gesperrter leerer Schalter');
    assert.doesNotMatch(html, /id="reminder-toggle"/);
    assert.doesNotMatch(html, /reminders\.readOnlyNotice/, 'auch kein Hinweis auf ein Feld, das es nicht gibt');
  });
});

test('calendar: read zeigt an einer Aufgabe OHNE Erinnerung keinen Abschnitt', () => {
  withModules({ tasks: 'write', calendar: 'read' }, () => {
    const html = tasks.renderModalContent({ task: TASK, users: [], reminder: null });
    assert.equal(reminderSection(html), '', 'nichts gespeichert heisst nichts zu zeigen');
    assert.doesNotMatch(html, /id="reminder-toggle"/);
  });
});

test('calendar: none entfernt den Abschnitt ganz - es gibt keinen Zustand zu zeigen', () => {
  withModules({ tasks: 'write', calendar: 'none' }, () => {
    const html = tasks.renderModalContent({ task: TASK, users: [], reminder: null });
    assert.equal(reminderSection(html), '', 'kein Schalter, der nur einen 403 verspricht');
    assert.doesNotMatch(html, /id="reminder-toggle"/);
  });
});

test('ohne geladene Rechte bleibt es beim Vollzugriff (fail-open wie permissions.js)', () => {
  const saved = permissions.getPermissions();
  try {
    permissions.clearPermissions();
    assert.equal(tasks.reminderAccess(), 'write');
    const section = reminderSection(tasks.renderModalContent({ task: TASK, users: [], reminder: REMINDER }));
    for (const tag of controls(section)) assert.doesNotMatch(tag, /\sdisabled/);
  } finally {
    permissions.setPermissions(saved);
  }
});

// --------------------------------------------------------------------------
// Speichern: der Riegel, den kein Textguard sehen kann
// --------------------------------------------------------------------------

/**
 * Faehrt handleFormSubmit gegen einen Attrappen-Dialog und gibt zurueck, was
 * an den Server ging. `reminderChecked` ist der Stand des (bei `read`
 * gesperrten) Kaestchens - genau der Wert, den ein blindes Wiederholen
 * erneut schicken wuerde.
 */
async function submitAndRecordCalls({ modules, reminderChecked, taskId = '7' }) {
  const calls = [];
  const record = (method) => async (path, body) => {
    calls.push({ method, path, body });
    if (method === 'post' && path === '/tasks') return { data: { id: 7 } };
    return { data: null };
  };
  globalThis.__apiStub = {
    get: record('get'),
    getWithSource: async (path) => { calls.push({ method: 'get', path }); return { data: { data: [] }, fromCache: false }; },
    post: record('post'),
    put: record('put'),
    patch: record('patch'),
    delete: record('delete'),
  };
  globalThis.document = fakeDocument(taskId);
  const form = fakeForm({
    title: 'Fenster putzen',
    description: '',
    priority: 'none',
    category: 'household',
    start_date: '',
    due_date: '2026-10-01',
    due_time: '',
    points: '0',
    byId: {
      '#reminder-toggle': { checked: reminderChecked },
      '#reminder-offset': { value: 'offset_1d' },
      '#task-visibility': { value: 'all' },
    },
  });
  try {
    await withModules(modules, () => tasks.handleFormSubmit(
      { preventDefault() {}, target: form },
      { container: null, onChanged: async () => {} },
    ));
  } finally {
    delete globalThis.__apiStub;
  }
  return calls;
}

const reminderCalls = (calls) => calls.filter((c) => String(c.path).startsWith('/reminders'));

test('calendar: read speichert die Aufgabe und laesst die Erinnerung unangetastet', async () => {
  const calls = await submitAndRecordCalls({ modules: { tasks: 'write', calendar: 'read' }, reminderChecked: true });
  assert.ok(calls.some((c) => c.method === 'put' && c.path === '/tasks/7'), 'die Aufgabe selbst geht raus');
  assert.deepEqual(reminderCalls(calls), [], 'kein POST /reminders, das nur einen 403 holen wuerde');
});

test('calendar: read schickt auch kein DELETE, wenn das gesperrte Kaestchen leer ist', async () => {
  const calls = await submitAndRecordCalls({ modules: { tasks: 'write', calendar: 'read' }, reminderChecked: false });
  assert.ok(calls.some((c) => c.method === 'put' && c.path === '/tasks/7'));
  assert.deepEqual(reminderCalls(calls), [], 'nicht abgewaehlt heisst nicht geloescht');
});

test('calendar: write schreibt die Erinnerung weiter wie bisher', async () => {
  const calls = await submitAndRecordCalls({ modules: { tasks: 'write', calendar: 'write' }, reminderChecked: true });
  const posts = reminderCalls(calls).filter((c) => c.method === 'post');
  assert.equal(posts.length, 1, 'der Weg mit Schreibrecht bleibt offen');
  assert.equal(posts[0].body.entity_type, 'task');
  // Die id kommt aus dem versteckten Feld und ist ein String - so geht sie
  // auch im Browser raus; der Server nimmt sie so.
  assert.equal(posts[0].body.entity_id, '7');
  // Der Zeitpunkt entsteht als WANDUHRZEIT (`new Date('...T23:59:59')`) und
  // geht als UTC raus - in Europe/Berlin am 1.10. also zwei Stunden davor. Die
  // Zone nagelt das npm-Script fest (TZ=Europe/Berlin), sonst misst diese
  // Zeile die Zone der Maschine. Geprueft wird hier nur, DASS der Wert
  // unveraendert durchgeht; der Vorlauf selbst haengt an
  // test:reminder-offset.
  assert.equal(posts[0].body.remind_at, '2026-09-30T21:59:59');
});

test('calendar: write loescht die Erinnerung weiter, wenn der Schalter aus ist', async () => {
  const calls = await submitAndRecordCalls({ modules: { tasks: 'write', calendar: 'write' }, reminderChecked: false });
  const deletes = reminderCalls(calls).filter((c) => c.method === 'delete');
  assert.equal(deletes.length, 1, 'das Abwaehlen loescht weiter');
  assert.match(deletes[0].path, /entity_type=task&entity_id=7/);
});
