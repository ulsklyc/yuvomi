/**
 * Test-Suite: die Karte "Automatische Backups" im Admin-Blatt "Backup"
 * (Phase 1b, Abschnitt G; #2525, #2540).
 *
 * Das Blatt läuft über seinen echten Einstieg `render()` gegen das Mini-DOM:
 * die Zeilen sind die, die der Code gebaut hat, und der Knopf "Jetzt Backup
 * erstellen" trägt den Handler, den der Code angehängt hat. Geprüft wird
 *  - der Grund des letzten Fehlschlags als übersetzter Satz,
 *  - "Letztes Backup" als das letzte GELUNGENE neben dem letzten Versuch,
 *  - der Warnzustand, wenn das letzte gelungene Backup überfällig ist, samt
 *    der reinen Entscheidung dahinter (`backupSuccessOverdue`, "jetzt" als
 *    Parameter),
 *  - der Toast nach einem ausgelösten Lauf, der mit 200 und `success: false`
 *    antwortet,
 *  - der Erfolgston an "Aktiv", der nur steht, solange nichts auf der Karte
 *    warnt (`backupStatusTone`),
 *  - die Zeile zum nächsten geplanten Lauf.
 *
 * Nichts hier liest den Quelltext des Blatts.
 *
 * Ausführen: npm run test:settings-backup-card
 */

import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import { installMiniDom, MiniElement, MiniText } from './mini-dom.js';

installMiniDom();

/**
 * Jedes Element unter `node`, in Dokumentreihenfolge.
 * @param {any} node
 * @returns {Generator<any>}
 */
function* elements(node) {
  for (const child of node.childNodes ?? []) {
    if (child instanceof MiniText || !(child instanceof MiniElement)) continue;
    yield child;
    yield* elements(child);
  }
}

/**
 * Das Mini-DOM merkt sich nur, DASS ein Listener hängt, und kennt weder
 * `classList` noch eine Suche; hier muss der Handler laufen, `createInfoRow()`
 * hängt die Ton-Klasse über `classList.add` an, und die Karte sucht ihren
 * Knopf per `#id`.
 */
class LiveElement extends MiniElement {
  nodeType = 1;
  hidden = false;
  disabled = false;
  /** @type {Record<string, (event?: unknown) => unknown>} */
  handlers = {};
  classList = {
    add: (/** @type {string[]} */ ...names) => { this.className = [this.className, ...names].filter(Boolean).join(' '); },
  };
  /** @param {string} type @param {(event?: unknown) => unknown} [fn] */
  addEventListener(type, fn) { if (fn) this.handlers[type] = fn; }
  /** @param {string} [selector] @returns {any} */
  querySelector(selector) {
    const id = /^#([\w-]+)$/.exec(selector ?? '')?.[1];
    if (!id) return null;
    return [...elements(this)].find((el) => el.id === id) ?? null;
  }
}
/** @type {any} */ (globalThis.document).createElement = (/** @type {string} */ tag) => new LiveElement(tag);

const { backupErrorRow, backupStatusTone, backupSuccessOverdue, render } = await import('../public/settings/pages/admin-backup.js');
const { cronScheduleIntervalMs } = await import('../public/settings/cron-label.js');
const { dateTimeText } = await import('../public/utils/date-format.js');

const hasClass = (/** @type {any} */ el, /** @type {string} */ name) => el.className.split(/\s+/).includes(name);
const byClass = (/** @type {any} */ root, /** @type {string} */ name) => [...elements(root)].filter((el) => hasClass(el, name));

/** Die Zeilen der Karte in ihrer Reihenfolge: Etikett, Text und Klassen des Werts. */
function rowsOf(/** @type {any} */ info) {
  return byClass(info, 'settings-info-row').map((row) => {
    const [label] = byClass(row, 'settings-info-label');
    const [value] = byClass(row, 'settings-info-value');
    return { label: label.textContent, value: value.textContent, valueClass: value.className };
  });
}
const labelsOf = (/** @type {any} */ info) => rowsOf(info).map((row) => row.label);
const rowOf = (/** @type {any} */ info, /** @type {string} */ label) => rowsOf(info).find((row) => row.label === label);

/**
 * Das Blatt, wie die Shell es übergibt - hier nur mit der Stelle, an der die
 * Karte ihre Zeilen ablegt. Jede andere Id beantwortet der Container mit null,
 * wie ein echter es für ein fehlendes Element täte; die übrigen Karten des
 * Blatts (Restore, WebDAV, CLI) binden dann nichts und fragen nichts ab.
 */
function createContainer() {
  const info = new LiveElement('div');
  return {
    info,
    replaceChildren() {},
    insertAdjacentHTML() {},
    querySelector(/** @type {string} */ selector) { return selector === '#backup-scheduler-info' ? info : null; },
  };
}

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;
const NOW = Date.parse('2026-11-12T10:00:00.000Z');
/** Ein Zeitpunkt `ms` vor NOW als ISO-Text, wie der Server ihn liefert. */
const ago = (/** @type {number} */ ms) => new Date(NOW - ms).toISOString();

/** Ein gesunder Stand: täglich um zwei, der Lauf von heute früh gelang. */
const HEALTHY = {
  enabled: true,
  schedule: '0 2 * * *',
  keepCount: 7,
  running: true,
  lastBackup: { timestamp: ago(8 * HOUR), success: true, file: 'yuvomi-backup-x.db' },
  lastError: null,
  lastSuccess: ago(8 * HOUR),
  nextRun: new Date(NOW + 16 * HOUR).toISOString(),
};

/**
 * Der Stand nach einem Fehlschlag vor `attemptAgo`, mit dem letzten Erfolg vor
 * `successAgo` (null: noch nie einer).
 * @param {{ attemptAgo?: number, successAgo?: number | null, reason?: string, schedule?: string }} [options]
 */
function failed({ attemptAgo = 8 * HOUR, successAgo = 32 * HOUR, reason = 'disk_full', schedule = '0 2 * * *' } = {}) {
  const timestamp = ago(attemptAgo);
  return {
    ...HEALTHY,
    schedule,
    lastBackup: { timestamp, success: false, error: 'The backup failed.', reason },
    lastError: { timestamp, reason, message: 'The backup failed.' },
    lastSuccess: successAgo == null ? null : ago(successAgo),
  };
}

/** @type {{ message: string, tone: string }[]} */
let toasts = [];
/** @type {string[]} */
let requested = [];

/**
 * Rendert das Blatt gegen eine Welt: `statuses` sind die Antworten von
 * `GET /backup/status` der Reihe nach (die letzte bleibt stehen), `trigger`
 * ist die Antwort von `POST /backup/trigger` oder ein Fehler.
 * @param {{ statuses: object[], trigger?: unknown }} world
 */
async function renderCard({ statuses, trigger }) {
  toasts = [];
  requested = [];
  let statusCalls = 0;
  /** @type {any} */ (globalThis).__apiStub = {
    get: async (/** @type {string} */ path) => {
      requested.push(`GET ${path}`);
      if (path !== '/backup/status') throw new Error(`unexpected request ${path}`);
      const scheduler = statuses[Math.min(statusCalls, statuses.length - 1)];
      statusCalls += 1;
      return { data: { scheduler } };
    },
    post: async (/** @type {string} */ path) => {
      requested.push(`POST ${path}`);
      if (path !== '/backup/trigger') throw new Error(`unexpected request ${path}`);
      if (trigger instanceof Error) throw trigger;
      return trigger;
    },
  };
  /** @type {any} */ (globalThis).window = {
    location: { protocol: 'https:' },
    addEventListener() {},
    yuvomi: { showToast: (/** @type {string} */ message, /** @type {string} */ tone) => { toasts.push({ message, tone }); } },
  };
  const container = createContainer();
  await render(container, { user: { role: 'admin' } });
  return container.info;
}

/** Klickt "Jetzt Backup erstellen" und wartet, bis die Karte neu geladen hat. */
async function clickTrigger(/** @type {any} */ info) {
  const button = info.querySelector('#backup-trigger-btn');
  assert.ok(button, 'Vorbedingung: die Karte trägt den Knopf');
  await button.handlers.click();
  // Das Neuladen läuft ohne await hinter dem Toast her.
  await new Promise((resolve) => setImmediate(resolve));
}

test.beforeEach(() => { mock.timers.enable({ apis: ['Date'], now: NOW }); });
test.afterEach(() => { mock.timers.reset(); });

// ── Der Grund des letzten Fehlschlags (#2525) ────────────────────────────────

test('Backup-Karte: je Grund steht der übersetzte Satz, als Fehler ausgezeichnet', () => {
  const faelle = {
    backup_dir_not_writable: 'settings.backupSchedulerReasonDirNotWritable',
    disk_full: 'settings.backupSchedulerReasonDiskFull',
    backup_verify_failed: 'settings.backupSchedulerReasonVerifyFailed',
    unknown: 'settings.backupSchedulerReasonUnknown',
  };
  for (const [reason, key] of Object.entries(faelle)) {
    const row = /** @type {any} */ (backupErrorRow({ timestamp: '2026-01-01T00:00:00Z', reason, message: 'raw system text' }));
    assert.ok(row, reason);
    const [labelEl, valueEl] = row.childNodes;
    assert.equal(labelEl.textContent, 'settings.backupSchedulerLastError', reason);
    // lastError.reason wählt den übersetzten Satz (#1909: nie der rohe
    // lastError.message-Text des Systemfehlers, der bleibt im Server-Log).
    assert.equal(valueEl.textContent, key, `${reason} muss auf ${key} zeigen, nicht auf den rohen message-Text`);
    assert.match(valueEl.className, /settings-info-value--danger/, reason);
  }
});

test('Backup-Karte: ein Grund außerhalb der vier bekannten fällt auf den Allgemeinsatz zurück', () => {
  const row = /** @type {any} */ (backupErrorRow({ timestamp: '2026-01-01T00:00:00Z', reason: 'etwas-neues', message: 'x' }));
  assert.equal(row.childNodes[1].textContent, 'common.errorGeneric');
});

test('Backup-Karte: ein erfolgreicher Lauf setzt lastError auf null - die Zeile verschwindet von selbst', () => {
  assert.equal(backupErrorRow(null), null);
});

// ── Letzter Versuch und letzter Erfolg ───────────────────────────────────────

test('nach einem Fehlschlag bleibt stehen, wann zuletzt ein Backup gelang', async () => {
  const state = failed();
  const info = await renderCard({ statuses: [state] });

  assert.deepEqual(labelsOf(info), [
    'settings.backupSchedulerStatus',
    'settings.backupSchedulerSchedule',
    'settings.backupSchedulerKeep',
    'settings.backupSchedulerLastBackup',
    'settings.backupSchedulerLastAttempt',
    'settings.backupSchedulerLastError',
    'settings.backupSchedulerNextRun',
  ]);

  const success = dateTimeText(state.lastSuccess);
  const attempt = dateTimeText(state.lastBackup.timestamp);
  assert.notEqual(success, attempt, 'Vorbedingung: die zwei Zeitpunkte sehen verschieden aus');
  // "Letztes Backup" ist das letzte GELUNGENE, nicht der fehlgeschlagene Lauf.
  assert.equal(
    rowOf(info, 'settings.backupSchedulerLastBackup')?.value,
    `settings.backupSchedulerLastSuccess${JSON.stringify({ date: success })}`,
  );
  assert.equal(
    rowOf(info, 'settings.backupSchedulerLastAttempt')?.value,
    `settings.backupSchedulerLastFail${JSON.stringify({ date: attempt })}`,
  );
  assert.equal(rowOf(info, 'settings.backupSchedulerLastError')?.value, 'settings.backupSchedulerReasonDiskFull');

  // Gegenprobe: gelang der letzte Lauf, sagt "Letztes Backup" alles - kein
  // Versuch, kein Fehler, kein Warnton.
  const healthy = await renderCard({ statuses: [HEALTHY] });
  assert.deepEqual(labelsOf(healthy), [
    'settings.backupSchedulerStatus',
    'settings.backupSchedulerSchedule',
    'settings.backupSchedulerKeep',
    'settings.backupSchedulerLastBackup',
    'settings.backupSchedulerNextRun',
  ]);
  const last = rowOf(healthy, 'settings.backupSchedulerLastBackup');
  assert.equal(last?.value, `settings.backupSchedulerLastSuccess${JSON.stringify({ date: dateTimeText(HEALTHY.lastSuccess) })}`);
  assert.equal(last?.valueClass, 'settings-info-value');
});

test('fehlt `lastSuccess` in der Antwort, zählt ein gelungener letzter Lauf als letzter Erfolg', async () => {
  // Ein Erfolg, der nur in `lastBackup` steht, darf nicht als "noch kein
  // Backup" erscheinen - und nach einem Fehlschlag ohne `lastSuccess` steht
  // dort "noch keins" statt des Datums des Fehlschlags.
  const noField = { ...failed(), lastSuccess: undefined };
  const info = await renderCard({ statuses: [noField] });
  assert.equal(rowOf(info, 'settings.backupSchedulerLastBackup')?.value, 'settings.backupSchedulerNever');

  const onlyLastBackup = await renderCard({ statuses: [{ ...HEALTHY, lastSuccess: undefined }] });
  assert.equal(
    rowOf(onlyLastBackup, 'settings.backupSchedulerLastBackup')?.value,
    `settings.backupSchedulerLastSuccess${JSON.stringify({ date: dateTimeText(HEALTHY.lastBackup.timestamp) })}`,
  );
});

// ── Überfällig: die reine Entscheidung ───────────────────────────────────────

test('überfällig ist ein Erfolg, der älter ist als zwei Abstände des Zeitplans', () => {
  /** @type {[string, string, number, number][]} Muster, Ausdruck, noch gut, überfällig */
  const faelle = [
    ['täglich', '0 2 * * *', 2 * DAY, 2 * DAY + 1],
    ['wöchentlich', '30 3 * * 1', 14 * DAY, 14 * DAY + 1],
    ['monatlich', '15 1 15 * *', 62 * DAY, 62 * DAY + 1],
    // Am 31. fällt der Lauf in kurzen Monaten aus: der Abstand reicht über zwei.
    ['monatlich am 31.', '0 2 31 * *', 124 * DAY, 124 * DAY + 1],
    ['alle sechs Stunden', '0 */6 * * *', 12 * HOUR, 12 * HOUR + 1],
  ];
  for (const [name, schedule, fresh, stale] of faelle) {
    const at = (/** @type {number} */ ms) => ({ ...HEALTHY, schedule, lastSuccess: ago(ms), lastBackup: { timestamp: ago(ms), success: true } });
    assert.equal(backupSuccessOverdue(at(fresh), NOW), false, `${name}: genau zwei Abstände sind noch keine Warnung`);
    assert.equal(backupSuccessOverdue(at(stale), NOW), true, `${name}: älter als zwei Abstände`);
  }
});

test('überfällig misst am letzten ERFOLG, nicht am letzten Versuch', () => {
  // Der Zeitplan läuft, jeder Lauf scheitert: der Versuch ist frisch, der Erfolg alt.
  assert.equal(backupSuccessOverdue(failed({ attemptAgo: 8 * HOUR, successAgo: 5 * DAY }), NOW), true);
  // Ein einzelner Fehlschlag nach einem Erfolg von gestern ist noch keine Warnung.
  assert.equal(backupSuccessOverdue(failed({ attemptAgo: 8 * HOUR, successAgo: 32 * HOUR }), NOW), false);
});

test('ein Zeitplan ohne erkanntes Muster warnt nie über das Alter', () => {
  for (const schedule of ['0 2,14 * * *', '0 8-17 * * *', '0 2 * 3 *', '*/15 * * * *', 'kein cron', '']) {
    assert.equal(cronScheduleIntervalMs(schedule), null, schedule);
    const state = { ...HEALTHY, schedule, lastSuccess: ago(400 * DAY), lastBackup: { timestamp: ago(400 * DAY), success: true } };
    assert.equal(backupSuccessOverdue(state, NOW), false, `"${schedule}": kein Abstand ablesbar, keine geratene Warnung`);
  }
});

test('noch nie ein Erfolg: Warnung erst, wenn schon ein Lauf versucht wurde', () => {
  const fresh = { ...HEALTHY, lastBackup: null, lastSuccess: null };
  assert.equal(backupSuccessOverdue(fresh, NOW), false, 'frische Installation vor dem ersten Lauf');
  assert.equal(backupSuccessOverdue(failed({ successAgo: null }), NOW), true, 'ein Versuch lief, keiner gelang');
  // Dafür braucht es keinen Abstand - auch ein nicht erkannter Zeitplan warnt hier.
  assert.equal(backupSuccessOverdue(failed({ successAgo: null, schedule: '0 2,14 * * *' }), NOW), true);
});

test('ohne aktiven Zeitplan und bei unlesbarem Zeitpunkt gibt es keine Warnung', () => {
  assert.equal(backupSuccessOverdue({ ...failed({ successAgo: 400 * DAY }), enabled: false }, NOW), false);
  assert.equal(backupSuccessOverdue({ ...HEALTHY, lastSuccess: 'kein Datum', lastBackup: null }, NOW), false);
});

test('der Abstand je Muster ist der längste, den der Zeitplan lässt', () => {
  assert.equal(cronScheduleIntervalMs('0 2 * * *'), DAY);
  assert.equal(cronScheduleIntervalMs('30 3 * * SUN'), 7 * DAY);
  assert.equal(cronScheduleIntervalMs('0 */6 * * *'), 6 * HOUR);
  assert.equal(cronScheduleIntervalMs('15 1 28 * *'), 31 * DAY);
  for (const day of [29, 30, 31]) assert.equal(cronScheduleIntervalMs(`0 2 ${day} * *`), 62 * DAY, `Tag ${day}`);
});

// ── Überfällig: die Karte ────────────────────────────────────────────────────

test('überfällig steht als Warnton mit Satz an der Zeile "Letztes Backup"', async () => {
  const state = failed({ attemptAgo: 8 * HOUR, successAgo: 5 * DAY });
  const info = await renderCard({ statuses: [state] });
  const row = rowOf(info, 'settings.backupSchedulerLastBackup');
  assert.ok(row);
  assert.match(row.valueClass, /settings-info-value--warning/);
  // Der Ton allein sagt nichts: Datum UND Satz stehen in der Zeile.
  assert.ok(row.value.includes(JSON.stringify({ date: dateTimeText(state.lastSuccess) })), row.value);
  assert.ok(row.value.includes('settings.backupSchedulerOverdue'), row.value);

  // Auch ohne Fehlschlag: der Zeitplan steht still, der letzte Lauf gelang vor Tagen.
  const silent = { ...HEALTHY, lastBackup: { timestamp: ago(5 * DAY), success: true }, lastSuccess: ago(5 * DAY) };
  const stalled = rowOf(await renderCard({ statuses: [silent] }), 'settings.backupSchedulerLastBackup');
  assert.match(stalled?.valueClass ?? '', /settings-info-value--warning/);
  assert.ok(stalled?.value.includes('settings.backupSchedulerOverdue'));

  // Gegenproben: derselbe alte Erfolg bei nicht erkanntem Zeitplan, und ein
  // einzelner Fehlschlag nach einem Erfolg von gestern, tragen keinen Warnton.
  for (const calm of [{ ...silent, schedule: '0 2,14 * * *' }, failed()]) {
    const calmRow = rowOf(await renderCard({ statuses: [calm] }), 'settings.backupSchedulerLastBackup');
    assert.equal(calmRow?.valueClass, 'settings-info-value');
    assert.ok(!calmRow?.value.includes('settings.backupSchedulerOverdue'));
  }
});

test('noch nie gelungen nach einem Versuch: "noch kein Backup" im Warnton, ohne den Satz zum Alter', async () => {
  const info = await renderCard({ statuses: [failed({ successAgo: null })] });
  const row = rowOf(info, 'settings.backupSchedulerLastBackup');
  assert.equal(row?.value, 'settings.backupSchedulerNever');
  assert.match(row?.valueClass ?? '', /settings-info-value--warning/);

  // Gegenprobe: vor dem ersten Lauf steht derselbe Satz ohne Ton.
  const fresh = await renderCard({ statuses: [{ ...HEALTHY, lastBackup: null, lastSuccess: null }] });
  const freshRow = rowOf(fresh, 'settings.backupSchedulerLastBackup');
  assert.equal(freshRow?.value, 'settings.backupSchedulerNever');
  assert.equal(freshRow?.valueClass, 'settings-info-value');
});

// ── Der Zeitplan in der Karte ────────────────────────────────────────────────

test('ein Zeitplan über mehrere Wochentage steht als Ausdruck da und warnt nie über das Alter', async () => {
  // `mon-fri` läuft an fünf Tagen: kein "Jeden Montag", und kein Abstand von
  // sieben Tagen, an dem "überfällig" gemessen würde.
  for (const schedule of ['0 2 * * mon-fri', '0 2 * * mon,wed,fri']) {
    const old = { ...HEALTHY, schedule, lastSuccess: ago(400 * DAY), lastBackup: { timestamp: ago(400 * DAY), success: true } };
    assert.equal(backupSuccessOverdue(old, NOW), false, schedule);
    const info = await renderCard({ statuses: [old] });
    assert.equal(rowOf(info, 'settings.backupSchedulerSchedule')?.value, schedule);
    assert.equal(rowOf(info, 'settings.backupSchedulerLastBackup')?.valueClass, 'settings-info-value', schedule);
  }

  // Gegenprobe: ein einzelner Wochentag bleibt Klartext mit sieben Tagen Abstand.
  const weekly = { ...HEALTHY, schedule: '0 2 * * mon' };
  const info = await renderCard({ statuses: [weekly] });
  assert.ok(rowOf(info, 'settings.backupSchedulerSchedule')?.value.startsWith('settings.backupSchedulerCronWeekly'));
  assert.equal(cronScheduleIntervalMs(weekly.schedule), 7 * DAY);
});

// ── Der Ton an "Aktiv" ───────────────────────────────────────────────────────

test('"Aktiv" trägt den Erfolgston nur, solange nichts auf der Karte warnt', async () => {
  const silent = { ...HEALTHY, lastBackup: { timestamp: ago(5 * DAY), success: true }, lastSuccess: ago(5 * DAY) };
  /** @type {[string, object, 'success' | null][]} */
  const faelle = [
    ['gesund', HEALTHY, 'success'],
    ['vor dem ersten Lauf', { ...HEALTHY, lastBackup: null, lastSuccess: null }, 'success'],
    // Ein alter Erfolg bei nicht erkanntem Zeitplan warnt nicht - dann bleibt auch das Grün.
    ['nicht erkannter Zeitplan', { ...silent, schedule: '0 2,14 * * *' }, 'success'],
    ['ein Fehlschlag nach einem Erfolg von gestern', failed(), null],
    ['Fehlschlag, noch nie gelungen', failed({ successAgo: null }), null],
    ['überfällig nach Fehlschlägen', failed({ attemptAgo: 8 * HOUR, successAgo: 5 * DAY }), null],
    ['überfällig ohne Fehlschlag', silent, null],
    // Nur `lastError` gesetzt: die Fehlerzeile steht, also kein Grün daneben.
    ['Fehler ohne `lastBackup`', { ...HEALTHY, lastBackup: null, lastError: failed().lastError }, null],
  ];
  for (const [name, state, tone] of faelle) {
    assert.equal(backupStatusTone(state, NOW), tone, name);

    // Die Karte setzt, was die Entscheidung sagt - und der Text bleibt "Aktiv":
    // der Zeitplan läuft ja.
    const row = rowOf(await renderCard({ statuses: [state] }), 'settings.backupSchedulerStatus');
    assert.equal(row?.value, 'settings.backupSchedulerEnabled', name);
    assert.equal(
      row?.valueClass,
      tone ? 'settings-info-value settings-info-value--success' : 'settings-info-value',
      name,
    );
  }
});

test('ein abgeschalteter Zeitplan steht ohne Ton da, was auch immer zuletzt war', async () => {
  for (const state of [{ ...HEALTHY, enabled: false }, { ...failed(), enabled: false }]) {
    assert.equal(backupStatusTone(state, NOW), null);
    const row = rowOf(await renderCard({ statuses: [state] }), 'settings.backupSchedulerStatus');
    assert.equal(row?.value, 'settings.backupSchedulerDisabled');
    assert.equal(row?.valueClass, 'settings-info-value');
  }
});

// ── Der nächste geplante Lauf ────────────────────────────────────────────────

test('die Karte nennt den nächsten geplanten Lauf, nach einem Fehlschlag gleich unter dem Fehler', async () => {
  const next = dateTimeText(HEALTHY.nextRun);
  assert.notEqual(next, dateTimeText(HEALTHY.lastSuccess), 'Vorbedingung: nächster Lauf und letzter Erfolg sehen verschieden aus');

  const healthy = await renderCard({ statuses: [HEALTHY] });
  assert.equal(rowOf(healthy, 'settings.backupSchedulerNextRun')?.value, next);
  // Ein Zeitpunkt, kein Befund: ohne Ton.
  assert.equal(rowOf(healthy, 'settings.backupSchedulerNextRun')?.valueClass, 'settings-info-value');
  assert.equal(labelsOf(healthy).at(-1), 'settings.backupSchedulerNextRun', 'Vergangenes zuerst, der nächste Lauf am Ende');

  // "Wann versucht er es wieder" ist die Frage nach dem Fehler.
  const afterFailure = await renderCard({ statuses: [failed()] });
  assert.deepEqual(labelsOf(afterFailure).slice(-2), ['settings.backupSchedulerLastError', 'settings.backupSchedulerNextRun']);
  assert.equal(rowOf(afterFailure, 'settings.backupSchedulerNextRun')?.value, next);
});

test('ohne Zeitpunkt und ohne aktiven Zeitplan gibt es keine Zeile zum nächsten Lauf', async () => {
  // `nextRun` ist null, solange kein Zeitplan läuft; ein unlesbarer Wert ist
  // keine Auskunft und darf nicht als leere Zeile dastehen.
  for (const nextRun of [null, undefined, '', 'kein Datum']) {
    const info = await renderCard({ statuses: [{ ...HEALTHY, nextRun }] });
    assert.ok(!labelsOf(info).includes('settings.backupSchedulerNextRun'), JSON.stringify(nextRun));
    assert.ok(labelsOf(info).includes('settings.backupSchedulerLastBackup'), 'die übrigen Zeilen bleiben');
  }
  const disabled = await renderCard({ statuses: [{ ...HEALTHY, enabled: false }] });
  assert.deepEqual(labelsOf(disabled), ['settings.backupSchedulerStatus']);
});

// ── "Jetzt Backup erstellen" ─────────────────────────────────────────────────

test('ein ausgelöster Lauf mit `success: false` meldet den Grund statt eines Erfolgs', async () => {
  const after = failed({ attemptAgo: 0, successAgo: 8 * HOUR, reason: 'backup_dir_not_writable' });
  const info = await renderCard({
    statuses: [HEALTHY, after],
    trigger: { data: after.lastBackup },
  });
  await clickTrigger(info);

  assert.deepEqual(toasts, [{ message: 'settings.backupSchedulerReasonDirNotWritable', tone: 'danger' }]);
  // Die Karte lädt neu und zeigt den Lauf, der gerade war.
  assert.deepEqual(requested, ['GET /backup/status', 'POST /backup/trigger', 'GET /backup/status']);
  assert.ok(labelsOf(info).includes('settings.backupSchedulerLastAttempt'));
  assert.equal(rowOf(info, 'settings.backupSchedulerLastError')?.value, 'settings.backupSchedulerReasonDirNotWritable');

  // Gegenprobe: ein gelungener Lauf meldet weiter den Erfolg und lädt neu.
  const fine = await renderCard({ statuses: [HEALTHY], trigger: { data: { ...HEALTHY.lastBackup, timestamp: ago(0) } } });
  await clickTrigger(fine);
  assert.deepEqual(toasts, [{ message: 'settings.backupSchedulerTriggeredToast', tone: 'success' }]);
  assert.deepEqual(requested, ['GET /backup/status', 'POST /backup/trigger', 'GET /backup/status']);
});

test('ein Grund außerhalb der vier bekannten und eine Antwort ohne `success` melden den Allgemeinsatz', async () => {
  for (const data of [{ timestamp: ago(0), success: false, reason: 'etwas-neues' }, { timestamp: ago(0), success: false }, null]) {
    const info = await renderCard({ statuses: [HEALTHY], trigger: { data } });
    await clickTrigger(info);
    assert.deepEqual(toasts, [{ message: 'common.errorGeneric', tone: 'danger' }], JSON.stringify(data));
    assert.equal(requested.filter((entry) => entry === 'GET /backup/status').length, 2, 'die Karte lädt neu');
  }
});
