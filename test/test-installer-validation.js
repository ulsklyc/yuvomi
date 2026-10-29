/**
 * Modul: Web-Installer - Feldpruefungen und Fehlerpfade
 * Zweck: Der Wizard nimmt keinen Wert mehr an, an dem der Server erst nach dem
 *        Speichern scheitert, und ein gescheiterter Request bleibt nicht still.
 *        - Cron: Wertebereiche je Feld statt nur fuenf Felder zaehlen; jede
 *          akzeptierte Form nimmt auch node-cron an (die Regel des Schedulers).
 *        - Paare ID/Secret (Google, Outlook, Apple), WebDAV an ohne URL,
 *          absoluter Container-Pfad, kein REPLACE_WITH_-Platzhalter.
 *        - genSecret() prueft r.ok, die Schritt-Hooks fangen ab und zeigen den
 *          Fehler; das Docker-Polling ist eine setTimeout-Kette, die nie zwei
 *          Requests gleichzeitig offen hat.
 * Ausführen: node --test test/test-installer-validation.js
 */

import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import cron from 'node-cron';

import {
  isValidCron, isAbsoluteContainerPath, isPlaceholderSecret, PLACEHOLDER_PREFIX,
  pairGap, enabledWithoutUrl,
} from '../tools/installer/field-checks.js';
import { createInstallerServer } from '../tools/installer/install-server.js';

const read = rel => readFileSync(new URL(rel, import.meta.url), 'utf8');
const html = read('../tools/installer/install.html');

function fnSource(name) {
  const m = html.match(new RegExp(`(?:async )?function ${name}\\([^)]*\\) \\{[\\s\\S]*?\\n\\}`));
  assert.ok(m, `function ${name} nicht gefunden`);
  return m[0];
}

function handler(id) {
  const from = html.indexOf(`$('${id}').addEventListener('click'`);
  assert.ok(from !== -1, `Handler ${id} nicht gefunden`);
  const end = html.indexOf('\n});', from);
  return html.slice(from, end);
}

// ── Cron ─────────────────────────────────────────────────────────────────────

const CRON_OK = [
  '0 2 * * *', '*/15 * * * *', '0 */6 * * *', '30 3 * * 0', '30 3 * * 7',
  '0 2 1 * *', '0 2 31 12 *', '0 0,12 * * 1-5', '0-59/10 * * * *',
  '0 2 * * mon', '0 2 * * MON-FRI', '0 2 1 jan *', '0 2 1-15/2 * *', '00 02 * * *',
  '  0 2 * * *  ',
  // Sechs Felder mit fuehrender Sekunde, volle Namen, ? und Kurzformen: die
  // Grammatik des Schedulers (node-cron 4), Review #2382.
  '0 0 2 * * *', '*/30 0 2 * * MON-FRI', '0 2 * * Sunday', '0 2 1 January *',
  '0 2 * * monday-friday', '0 2 1 jan-march *', '0 2 ? * mon', '@daily', '@Weekly',
  // Tag und Monat passen in mindestens einem Monat zusammen (Re-Critique 29.10.).
  '0 3 29 2 *', '0 3 31 1,2 *', '0 3 30 feb-apr *', '0 3 1,31 2 *', '0 3 31 * *',
];
const CRON_BAD = [
  '99 * * * *',     // Minute ausserhalb 0-59 - der Befund aus der Critique
  '60 * * * *', '* 24 * * *', '* * 0 * *', '* * 32 * *', '* * * 0 *', '* * * 13 *',
  '* * * * 8', '*/0 * * * *', '1-60 * * * *', '0,60 * * * *', '- * * * *',
  '1- * * * *', ',1 * * * *', '2/5 * * * *', 'a * * * *', '0 2 * * jan', '',
  '0 2 * *', '0 0 0 2 * * *', '60 0 2 * * *', '0 2 ? ? *', '? 2 * * *', '0 2 * * sundays',
  '@sometimes',
  // Tag und Monat gibt es nie zugleich: node-cron 4.6 lehnt das ab
  // ("impossible day of month"), der Wizard nahm es an, und der Server schaltete
  // die Backups beim Start still ab (Re-Critique 29.10.).
  '0 3 31 2 *', '0 3 30 feb *', '0 3 30,31 2 *', '0 3 31 4,6,9,11 *', '0 0 3 31 apr *',
  '0 3 30-31 2 *',
];

test('isValidCron prueft die Wertebereiche je Feld, nicht nur die Feldzahl', () => {
  for (const expr of CRON_OK) assert.equal(isValidCron(expr), true, `abgelehnt: "${expr}"`);
  for (const expr of CRON_BAD) assert.equal(isValidCron(expr), false, `angenommen: "${expr}"`);
});

test('was der Wizard als Cron annimmt, nimmt auch der Backup-Scheduler an', () => {
  // Die Regel, an die die Pruefung gebunden ist: backup-scheduler.js schaltet
  // die Backups bei `!cron.validate(BACKUP_SCHEDULE)` still ab.
  const scheduler = read('../server/services/backup-scheduler.js');
  assert.match(scheduler, /if \(!cron\.validate\(BACKUP_SCHEDULE\)\)/,
    'der Scheduler prueft nicht mehr mit cron.validate - die Bindung zeigt ins Leere');

  for (const expr of CRON_OK) assert.equal(cron.validate(expr.trim()), true, `node-cron lehnt "${expr}" ab`);
  // Die unmoeglichen Tag/Monat-Paare sind dieselbe Regel wie im Scheduler.
  for (const expr of ['0 3 31 2 *', '0 3 30 feb *', '0 3 31 4,6,9,11 *']) {
    assert.equal(cron.validate(expr), false, `node-cron nimmt "${expr}" inzwischen an`);
  }
  for (const expr of ['99 * * * *', '* 24 * * *', '* * 32 * *', '* * * 13 *', '* * * * 8']) {
    assert.equal(cron.validate(expr), false, `node-cron nimmt "${expr}" inzwischen an`);
  }

  // Erzeugter Korpus: jede Kombination, die isValidCron annimmt, muss auch
  // node-cron annehmen (Teilmenge). Deterministischer Zufall, damit ein Rot
  // reproduzierbar bleibt.
  let seed = 7;
  const rnd = n => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed % n; };
  const atoms = ['*', '*/1', '*/7', '*/59', '*/60', '0', '1', '7', '12', '13', '23', '24', '31', '32',
    '59', '60', '0-7', '1-5', '5-1', '1-31/2', '0-59/15', 'mon', 'sun-sat', 'jan', 'jan-dec', 'feb-jan', '1,2', '0,59',
    'Monday', 'sunday-SATURDAY', 'March', 'january-june', 'mar-december', '?', 'mon,friday',
    // Tag-/Monat-Paare, die es nie gibt (31. Februar): node-cron lehnt sie ab.
    '30', '29', '2', 'feb', '4,6', '30-31', 'feb,apr', 'nov'];
  let accepted = 0;
  for (let i = 0; i < 60000; i++) {
    const expr = Array.from({ length: 5 + rnd(2) }, () => atoms[rnd(atoms.length)]).join(' ');
    if (!isValidCron(expr)) continue;
    accepted++;
    assert.equal(cron.validate(expr), true, `isValidCron nimmt "${expr}" an, der Scheduler nicht`);
  }
  assert.ok(accepted > 300, `zu wenige angenommene Ausdruecke im Korpus (${accepted}) - der Test misst nichts`);
});

test('was der Backup-Scheduler in gaengiger Form annimmt, nimmt auch der Wizard an', () => {
  // Gegenrichtung fuer die Formen aus dem Review (#2382): BACKUP_SCHEDULE=0 0 2 * * *
  // lief auf dem Server, der Wizard hielt den unveraenderten Rerun daran fest.
  const forms = [
    '0 0 2 * * *', '30 15 3 * * 0', '*/10 * * * * *', '0 2 * * Sunday', '0 2 * * SAT',
    '0 2 1 December *', '0 2 1 feb *', '0 0 2 * * monday-friday', '0 2 ? * *', '0 2 * * ?',
    '@daily', '@hourly', '@yearly', '@annually', '@monthly', '@weekly', '@midnight',
  ];
  for (const expr of forms) {
    assert.equal(cron.validate(expr), true, `node-cron lehnt "${expr}" ab - Liste pruefen`);
    assert.equal(isValidCron(expr), true, `der Scheduler nimmt "${expr}" an, der Wizard nicht`);
  }
});

test('storage-next prueft den Zeitplan mit isValidCron', () => {
  assert.match(html, /import \{[^}]*isValidCron[^}]*\} from '\/field-checks\.js'/, 'field-checks.js wird nicht importiert');
  const body = handler('storage-next');
  // Ein unveraendert uebernommener Zeitplan bleibt ungeprueft (untouched, Review #2382).
  assert.match(body, /schedule && !untouched\('adv-backup-schedule'\) && !isValidCron\(schedule\)/,
    'storage-next prueft den Cron-Ausdruck nicht mit isValidCron');
  assert.doesNotMatch(body, /schedule\.split\(\/\\s\+\/\)\.length !== 5/, 'die alte Feldzaehlung steht noch');
});

test('der Installer-Server liefert field-checks.js aus', async () => {
  const server = createInstallerServer();
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  try {
    const r = await fetch(`http://127.0.0.1:${server.address().port}/field-checks.js`);
    assert.equal(r.status, 200);
    assert.match(r.headers.get('content-type'), /javascript/);
    assert.match(await r.text(), /export function isValidCron/);
  } finally {
    await new Promise(r => server.close(r));
  }
});

// ── Platzhalter, Container-Pfad ──────────────────────────────────────────────

test('REPLACE_WITH_-Platzhalter: dieselbe Regel wie der Server-Start', () => {
  for (const file of ['../server/auth.js', '../server/db.js']) {
    assert.ok(read(file).includes(`startsWith('${PLACEHOLDER_PREFIX}')`), `${file} prueft das Praefix nicht mehr`);
  }
  assert.equal(isPlaceholderSecret('REPLACE_WITH_A_LONG_RANDOM_STRING'), true);
  assert.equal(isPlaceholderSecret('REPLACE_WITH_SOMETHING_ELSE'), true);
  assert.equal(isPlaceholderSecret('a'.repeat(64)), false);
  assert.equal(isPlaceholderSecret(''), false);

  const body = handler('sec-next');
  assert.match(body, /isPlaceholderSecret\(ss\)/, 'sec-next prueft das Session-Secret nicht auf den Platzhalter');
  assert.match(body, /isPlaceholderSecret\(dk\)/, 'sec-next prueft den DB-Schluessel nicht auf den Platzhalter');
  assert.match(body, /secrets\.errPlaceholder/);
});

test('DOCUMENT_STORAGE_LOCAL_PATH muss absolut sein', () => {
  assert.equal(isAbsoluteContainerPath('/documents'), true);
  assert.equal(isAbsoluteContainerPath('/srv/yuvomi/docs'), true);
  assert.equal(isAbsoluteContainerPath('documents'), false);
  assert.equal(isAbsoluteContainerPath('./documents'), false);
  // docker-compose.yml bindet den Host-Ordner an genau diesen Pfad.
  assert.match(read('../docker-compose.yml'), /:\$\{DOCUMENT_STORAGE_LOCAL_PATH:-\/documents\}/);

  const body = handler('storage-next');
  assert.match(body, /localPath && !untouched\('adv-document-local-path'\) && !isAbsoluteContainerPath\(localPath\)/,
    'storage-next prueft den Container-Pfad nicht');
  assert.match(body, /fail\('storage-err', t\('storage\.errLocalPath'\), 'adv-document-local-path'\)/);
});

// ── Paare und WebDAV ─────────────────────────────────────────────────────────

test('pairGap: ID ohne Secret, Secret ohne ID; ein uebernommenes Secret zaehlt', () => {
  assert.equal(pairGap('', '', false), null);
  assert.equal(pairGap('id', 'secret', false), null);
  assert.equal(pairGap('id', '', false), 'secret');
  assert.equal(pairGap('', 'secret', false), 'id');
  // Rerun: das Secret-Feld bleibt leer, der Wert steht in der .env.
  assert.equal(pairGap('id', '', true), null);
  // Uebernommenes Secret, ID geleert: der Server bewahrt die ID ohnehin.
  assert.equal(pairGap('', '', true), null);
});

test('cal-next prueft Google, Outlook und Apple als Paar - mit uebernommenen Secrets', () => {
  const body = handler('cal-next');
  // Die Tabelle im Handler: ID-Feld, Secret-Feld, Secret-Schluessel der .env.
  for (const row of [
    "['gcal-id', 'gcal-secret', 'GOOGLE_CLIENT_SECRET'",
    "['outlook-id', 'outlook-secret', 'MS_CLIENT_SECRET'",
    "['apple-user', 'apple-pass', 'APPLE_APP_SPECIFIC_PASSWORD'",
  ]) {
    assert.ok(body.includes(row), `cal-next prueft das Paar ${row} nicht`);
  }
  assert.match(body, /pairGap\(\$\(idField\)\.value\.trim\(\), \$\(secretField\)\.value\.trim\(\), keptSecrets\.has\(secretKey\)\)/,
    'cal-next zaehlt ein in der .env uebernommenes Secret nicht - jeder Rerun waere blockiert');
  assert.match(body, /pairGap\(/, 'cal-next nutzt pairGap nicht');
  for (const key of ['errGooglePair', 'errOutlookPair', 'errApplePair']) {
    assert.ok(body.includes(`calendar.${key}`), `cal-next meldet calendar.${key} nicht`);
  }
  // Der Fehler braucht ein Banner im Schritt, an das fail() ihn bindet.
  assert.match(html, /<div class="error-banner" id="cal-err" role="alert" hidden><\/div>/, 'Kalender-Schritt ohne Fehler-Banner');
  // Und das Feld liegt evtl. in einer zugeklappten Karte: fail() klappt sie auf.
  assert.match(fnSource('fail'), /closest\('\.toggle-body'\)/, 'fail() oeffnet eine zugeklappte Karte nicht');
});

test('WebDAV eingeschaltet ohne URL wird abgelehnt - ausser die .env laeuft schon so', () => {
  const E = 'WEBDAV_BACKUP_ENABLED', U = 'WEBDAV_BACKUP_URL';
  assert.equal(enabledWithoutUrl(false, '', null, E, U), false);
  assert.equal(enabledWithoutUrl(true, 'https://dav.example', null, E, U), false);
  assert.equal(enabledWithoutUrl(true, '', null, E, U), true);
  assert.equal(enabledWithoutUrl(true, '', { [E]: 'true', [U]: '' }, E, U), false);
  assert.equal(enabledWithoutUrl(true, '', { [E]: '', [U]: '' }, E, U), true);

  const body = handler('storage-next');
  for (const [enable, url] of [
    ["'DOCUMENT_STORAGE_WEBDAV_ENABLED'", "'DOCUMENT_STORAGE_WEBDAV_URL'"],
    ["'WEBDAV_BACKUP_ENABLED'", "'WEBDAV_BACKUP_URL'"],
  ]) {
    assert.match(body, new RegExp(`enabledWithoutUrl\\([^)]*rerunValues, ${enable}, ${url}\\)`), `storage-next prueft ${enable} ohne URL nicht`);
  }
});

// ── Fehlerpfade der Schluessel ───────────────────────────────────────────────

test('genSecret() wirft bei einer Fehlantwort statt undefined zu liefern', async () => {
  const genSecret = new Function('fetch', `${fnSource('genSecret')}; return genSecret;`);
  const fail = genSecret(async () => ({ ok: false, status: 500, json: async () => ({ error: 'boom' }) }));
  await assert.rejects(fail(), 'eine 500 muss als Fehler ankommen');
  const empty = genSecret(async () => ({ ok: true, status: 200, json: async () => ({}) }));
  await assert.rejects(empty(), 'eine Antwort ohne secret darf kein leeres Feld ergeben');
  const okFn = genSecret(async () => ({ ok: true, status: 200, json: async () => ({ secret: 'ab'.repeat(32) }) }));
  assert.equal(await okFn(), 'ab'.repeat(32));
});

test('onEnterStep faengt fehlgeschlagene Schluessel ab und zeigt den Fehler', () => {
  const body = fnSource('onEnterStep');
  assert.match(body, /autofillSecretFields\(\)\.catch\(\(\) => showErr\('sec-err', t\('secrets\.errGenerate'\)\)\)/,
    'autofillSecretFields() ohne catch: eine Ablehnung bliebe unbehandelt, die Felder still leer');
  assert.match(body, /ensureKeys\(\)\.catch\(\(\) => showErr\('simple-err', t\('secrets\.errGenerate'\)\)\)/,
    'ensureKeys() ohne catch im Einfach-Pfad');
});

// ── Docker-Polling ───────────────────────────────────────────────────────────

test('das Docker-Polling wartet auf die Antwort, bevor es neu fragt', async () => {
  assert.doesNotMatch(html, /setInterval\(pollDocker/, 'setInterval stapelt Requests bei langsamem /api/status');

  const timers = [];
  let inFlight = 0, maxInFlight = 0, resolveCurrent = null;
  const h = new Function('setTimeout', 'clearTimeout', 'pollDocker', `
    let pollTimer = null, pollRun = 0, dockerDone = false;
    const POLL_EVERY_MS = 2000;
    ${fnSource('stopPolling')}
    ${fnSource('schedulePoll')}
    return { schedulePoll, stopPolling, run: () => pollRun };
  `)(
    (fn, ms) => { timers.push({ fn, ms }); return timers.length; },
    id => { if (id) timers[id - 1] = null; },
    () => {
      inFlight++; maxInFlight = Math.max(maxInFlight, inFlight);
      return new Promise(r => { resolveCurrent = () => { inFlight--; r(); }; });
    },
  );
  const fire = async () => {
    const i = timers.findLastIndex(Boolean);
    const t = timers[i]; timers[i] = null;
    const p = t.fn();
    await Promise.resolve();
    return p;
  };
  const pending = () => timers.filter(Boolean).length;

  h.schedulePoll(h.run());
  assert.equal(pending(), 1);
  const first = fire();
  await Promise.resolve();
  // Die Antwort laesst auf sich warten: kein zweiter Timer, kein zweiter Request.
  assert.equal(pending(), 0, 'waehrend ein Request offen ist, darf kein neuer geplant sein');
  resolveCurrent();
  await first;
  assert.equal(pending(), 1, 'nach der Antwort plant die Kette den naechsten Tick');
  assert.equal(maxInFlight, 1);

  // Abraeumen (Erfolg, Fehler, Retry): eine offene Antwort plant nichts mehr.
  const second = fire();
  await Promise.resolve();
  h.stopPolling();
  resolveCurrent();
  await second;
  assert.equal(pending(), 0, 'nach stopPolling() laeuft die alte Kette nicht weiter');
});

test('die Meldung zum Zeitplan nennt fuenf oder sechs Felder und die Kurzformen - in jeder Sprache', async () => {
  // Sie sagte "fuenf Cron-Felder", waehrend isValidCron (und node-cron) seit
  // #2382 auch sechs mit Sekunde und @daily annimmt: wer einen funktionierenden
  // Sechs-Felder-Plan aenderte und vertippte, las, seine Form sei falsch.
  const { SUPPORTED_LOCALES } = await import('../tools/installer/i18n-mini.js');
  const wrong = [];
  for (const locale of SUPPORTED_LOCALES) {
    const msg = JSON.parse(read(`../tools/installer/locales/${locale}.json`)).advanced?.errSchedule || '';
    // Sprachneutrale Marken: ein Fuenf- und ein Sechs-Felder-Beispiel, eine Kurzform.
    for (const mark of ['0 2 * * *', '0 0 2 * * *', '@daily']) {
      if (!msg.includes(mark)) wrong.push(`${locale}: "${mark}" fehlt`);
    }
  }
  assert.deepEqual(wrong, []);
  assert.match(html, /fail\('storage-err', t\('advanced\.errSchedule'\), 'adv-backup-schedule'\)/);
});
