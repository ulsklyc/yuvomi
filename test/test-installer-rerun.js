/**
 * Modul: Web-Installer - Rerun über eine bestehende .env
 * Zweck: Ein zweiter Lauf über den Erweitert-Pfad lässt die Einstellungen stehen,
 *        die der Nutzer nicht anfasst. Vorher startete jedes Feld mit seinem
 *        Default, buildEnv() schickte Port, BASE_URL, SESSION_SECURE,
 *        TRUST_PROXY, TZ und WEATHER_UNITS immer mit, und der Server bewahrt nur,
 *        was der Client NICHT schickt: aus einer HTTPS-Instanz hinter zwei
 *        Proxys wurde still eine auf localhost:3000 mit TRUST_PROXY=1.
 *        Dazu (a) die Grenze des Preflights: er gibt Allowlist-Werte heraus und
 *        von Secrets nur die Namen.
 * Ausführen: node --test test/test-installer-rerun.js
 */

import assert from 'node:assert/strict';
import test from 'node:test';
import { writeFileSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tempDir } from './tmp-dir.js';

import { createInstallerServer, readEnvFile, decodeEnvValue } from '../tools/installer/install-server.js';
import { FILE_SECRET_VARS } from '../server/utils/file-secrets.js';
import {
  ENV_SCHEMA, RERUN_PREFILL_KEYS, RERUN_SECRET_KEYS,
} from '../tools/installer/env-schema.js';
import {
  prefillPlan, accessEnv, PREFILL_FIELDS, KEPT_SECRET_FIELDS,
  omitUnchanged, unchangedSince, EMAIL_SECTION_FIELDS,
  BASELINE_FIELDS, REDIRECT_SOURCES, isInterpolated,
} from '../tools/installer/rerun-prefill.js';
import * as rerunPrefill from '../tools/installer/rerun-prefill.js';
import {
  isValidCron, isAbsoluteContainerPath, pairGap, enabledWithoutUrl,
} from '../tools/installer/field-checks.js';

const html = readFileSync(new URL('../tools/installer/install.html', import.meta.url), 'utf8');

async function withServer(root, fn) {
  const prev = process.env.OIKOS_INSTALLER_ROOT;
  process.env.OIKOS_INSTALLER_ROOT = root;
  const server = createInstallerServer();
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const { port } = server.address();
  try {
    await fn(`http://127.0.0.1:${port}`);
  } finally {
    await new Promise(r => server.close(r));
    if (prev === undefined) delete process.env.OIKOS_INSTALLER_ROOT;
    else process.env.OIKOS_INSTALLER_ROOT = prev;
  }
}

// Eine erfundene Bestandsinstallation: HTTPS hinter zwei Proxys, eigener Port,
// Zone und Einheiten weichen von jedem Default ab, dazu je ein Secret pro Art.
const SECRETS = {
  SESSION_SECRET: 'sess-geheim-1111',
  DB_ENCRYPTION_KEY: 'db-geheim-2222',
  EMAIL_SMTP_PASS: 'smtp-geheim-3333',
  GOOGLE_CLIENT_SECRET: 'google-geheim-4444',
  OIDC_CLIENT_SECRET: 'oidc-geheim-5555',
  APPLE_APP_SPECIFIC_PASSWORD: 'apple-geheim-6666',
  FIXER_API_KEY: 'fixer-geheim-7777',
};
const EXISTING = {
  BASE_URL: 'https://yuvomi.example.test',
  SESSION_SECURE: 'true',
  TRUST_PROXY: '2',
  TZ: 'America/Chicago',
  WEATHER_LAT: '41.88',
  WEATHER_LON: '-87.63',
  WEATHER_UNITS: 'imperial',
  OIKOS_HTTP_PORT: '8443',
  EMAIL_SMTP_HOST: 'smtp.example.test',
  GOOGLE_CLIENT_ID: 'gid.apps.example.test',
  ...SECRETS,
};
const envText = Object.entries(EXISTING).map(([k, v]) => `${k}=${v}`).join('\n') + '\n';

// ── Allowlist: jeder Schema-Schlüssel ist eingeordnet ─────────────────────────

test('jeder Schema-Schlüssel steht in genau einer Rerun-Liste', () => {
  const lists = { RERUN_PREFILL_KEYS, RERUN_SECRET_KEYS };
  for (const { key } of ENV_SCHEMA) {
    const hits = Object.entries(lists).filter(([, l]) => l.includes(key)).map(([n]) => n);
    assert.equal(hits.length, 1,
      `${key} steht in ${hits.length ? hits.join(' und ') : 'keiner Liste'} - neu einordnen (env-schema.js)`);
  }
  const schemaKeys = new Set(ENV_SCHEMA.map(e => e.key));
  for (const key of [...RERUN_PREFILL_KEYS, ...RERUN_SECRET_KEYS]) {
    assert.ok(schemaKeys.has(key), `${key} steht in einer Rerun-Liste, aber nicht im Schema`);
  }
});

test('die Allowlist enthält kein Secret, auch keins ohne secret-Merkmal', () => {
  const bySchema = new Map(ENV_SCHEMA.map(e => [e.key, e]));
  for (const key of RERUN_PREFILL_KEYS) {
    const e = bySchema.get(key);
    assert.ok(!e.secret && e.type !== 'auto', `${key} ist ein Secret und darf nicht vorbelegt werden`);
    assert.doesNotMatch(key, /SECRET|PASS(WORD)?$|_KEY$|TOKEN/,
      `${key} klingt nach einem Secret - bewusst einordnen`);
  }
  // Das Merkmal und die Secret-Liste sagen dasselbe: drei Secrets trugen es nicht.
  const flagged = ENV_SCHEMA.filter(e => e.secret || e.type === 'auto').map(e => e.key).sort();
  assert.deepEqual([...RERUN_SECRET_KEYS].sort(), flagged);
});

test('jeder vorbelegte Schlüssel hat ein Feld im Wizard und jedes Feld gibt es', () => {
  const mapped = new Set(PREFILL_FIELDS.map(([k]) => k));
  // TZ und SESSION_SECURE/TRUST_PROXY laufen über eigene Wege (cfg-tz, adv-proxy),
  // GOOGLE_DRIVE_REDIRECT_URI schaltet die Drive-Gruppe ein; die Redirect-URIs
  // ohne Feld gehen über keptRedirect() unverändert zurück (REDIRECT_SOURCES).
  const special = new Set(['TZ', 'SESSION_SECURE', 'TRUST_PROXY', 'GOOGLE_DRIVE_REDIRECT_URI',
    'GOOGLE_REDIRECT_URI', 'MS_REDIRECT_URI']);
  for (const key of RERUN_PREFILL_KEYS) {
    assert.ok(mapped.has(key) || special.has(key), `${key} ist erlaubt, wird aber nirgends vorbelegt`);
  }
  for (const [, id] of [...PREFILL_FIELDS, ...KEPT_SECRET_FIELDS]) {
    assert.match(html, new RegExp(`id="${id}"`), `Feld ${id} gibt es in install.html nicht`);
  }
});

// ── (a) Preflight: Werte der Allowlist, nie ein Secret ───────────────────────

test('GET /api/preflight liefert die Allowlist-Werte und von Secrets nur die Namen', async () => {
  const dir = tempDir('oikos-rerun-');
  try {
    writeFileSync(join(dir, '.env'), envText + 'LOG_LEVEL=debug\nOPENWEATHER_API_KEY=owm-geheim-8888\n');
    await withServer(dir, async base => {
      const d = await (await fetch(`${base}/api/preflight`)).json();
      assert.equal(d.rerunValues?.BASE_URL, 'https://yuvomi.example.test');
      assert.equal(d.rerunValues.TRUST_PROXY, '2');
      assert.equal(d.rerunValues.OIKOS_HTTP_PORT, '8443');
      assert.equal(d.rerunValues.TZ, 'America/Chicago');
      assert.equal(d.rerunValues.WEATHER_UNITS, 'imperial');
      for (const key of Object.keys(d.rerunValues)) {
        assert.ok(RERUN_PREFILL_KEYS.includes(key), `${key} ist nicht auf der Allowlist`);
      }
      const raw = JSON.stringify(d);
      for (const v of [...Object.values(SECRETS), 'owm-geheim-8888', 'debug']) {
        assert.ok(!raw.includes(v), `die Antwort enthält den Wert "${v}"`);
      }
      assert.deepEqual([...d.keptSecrets].sort(), Object.keys(SECRETS).sort());
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('GET /api/preflight ohne .env liefert leere Rerun-Felder', async () => {
  const dir = tempDir('oikos-rerun-');
  try {
    await withServer(dir, async base => {
      const d = await (await fetch(`${base}/api/preflight`)).json();
      assert.deepEqual(d.rerunValues, {});
      assert.deepEqual(d.keptSecrets, []);
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ── (b) Rerun ohne Änderung lässt die Werte stehen ────────────────────────────

/**
 * Was die Schritt-Handler aus install.html für die sechs Schlüssel bauen, wenn
 * der Nutzer jeden Schritt unverändert bestätigt. Die Handler selbst laufen im
 * Browser; die Bindung an sie hält der statische Test darunter fest.
 */
function envFromUntouchedWizard(plan, rerunValues) {
  const f = plan.fields;
  const access = accessEnv(f['adv-proxy'] ?? 'proxy', rerunValues);
  const scheme = f['adv-proxy'] === 'direct' ? 'http' : 'https';
  const port = f['cfg-port'] ?? '3000';
  const host = f['cfg-host'] ?? 'localhost';
  return {
    OIKOS_HTTP_PORT: port,
    TZ: f['cfg-tz'],
    BASE_URL: f['adv-base-url'] ?? `${scheme}://${host}:${port}`,
    SESSION_SECURE: access.SESSION_SECURE,
    TRUST_PROXY: access.TRUST_PROXY,
    WEATHER_LAT: f['wea-enable'] ? f['wea-lat'] : '',
    WEATHER_LON: f['wea-enable'] ? f['wea-lon'] : '',
    WEATHER_UNITS: f['wea-enable'] ? (f['wea-units'] ?? 'metric') : '',
    // Secrets: das Feld bleibt leer, gesendet wird nichts.
    SESSION_SECRET: '', DB_ENCRYPTION_KEY: '', EMAIL_SMTP_PASS: '',
  };
}

test('ein Rerun über den Erweitert-Pfad ohne Änderung lässt Port, Adresse, Proxy, Zone und Einheiten stehen', async () => {
  const dir = tempDir('oikos-rerun-');
  try {
    writeFileSync(join(dir, '.env'), envText);
    await withServer(dir, async base => {
      const d = await (await fetch(`${base}/api/preflight`)).json();
      const plan = prefillPlan(d.rerunValues || {}, d.keptSecrets || []);
      const env = envFromUntouchedWizard(plan, d.envExists ? (d.rerunValues || {}) : null);
      const r = await fetch(`${base}/api/save-env`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ env }),
      });
      assert.equal(r.status, 200);
    });
    const after = readEnvFile(join(dir, '.env'));
    for (const key of ['OIKOS_HTTP_PORT', 'BASE_URL', 'SESSION_SECURE', 'TRUST_PROXY', 'TZ', 'WEATHER_UNITS']) {
      assert.equal(after[key], EXISTING[key], `${key} wurde beim Rerun geändert`);
    }
    for (const [key, value] of Object.entries(SECRETS)) assert.equal(after[key], value, `${key} ging verloren`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('eine bewusst andere Zugriffsart setzt die Standardpaare', () => {
  assert.deepEqual(accessEnv('direct', EXISTING), { SESSION_SECURE: 'false', TRUST_PROXY: 'loopback' });
  assert.deepEqual(accessEnv('proxy', { SESSION_SECURE: 'false' }), { SESSION_SECURE: 'true', TRUST_PROXY: '1' });
  // Erstinstallation: kein Bestand, also die Paare wie bisher.
  assert.deepEqual(accessEnv('proxy', null), { SESSION_SECURE: 'true', TRUST_PROXY: '1' });
  // Bestand ohne SESSION_SECURE-Zeile ist Direktzugriff (Compose-Default) und
  // bleibt ohne Zeile.
  assert.deepEqual(accessEnv('direct', { BASE_URL: 'http://nas:3000' }), { SESSION_SECURE: '', TRUST_PROXY: '' });
});

test('der Plan belegt Schalter nach ihrem Default vor und lässt Secrets leer', () => {
  const plan = prefillPlan(
    { BACKUP_ENABLED: 'false', OIDC_ALLOW_SIGNUP: 'false', ICS_SUBSCRIPTION_ALLOW_PRIVATE_NETWORK: 'true' },
    ['EMAIL_SMTP_PASS'],
  );
  assert.equal(plan.fields['adv-backup-enable'], false);
  assert.equal(plan.fields['adv-oidc-allow-signup'], false);
  assert.equal(plan.fields['adv-ics-private'], true);
  assert.equal(plan.fields['adv-auth-password-login'], undefined, 'ohne Zeile bleibt der Feld-Default');
  assert.equal(plan.fields['cfg-tz'], 'UTC', 'ohne TZ-Zeile gilt die Containerzone, nicht die des Browsers');
  assert.deepEqual(plan.kept, ['email-pass']);
  for (const id of KEPT_SECRET_FIELDS.map(([, i]) => i)) {
    assert.ok(!(id in plan.fields), `Secret-Feld ${id} wird vorbelegt`);
  }
});

// ── Bindung an install.html ───────────────────────────────────────────────────

function handler(id) {
  const at = html.indexOf(`$('${id}').addEventListener('click'`);
  assert.ok(at > 0, `Handler ${id} nicht gefunden`);
  return html.slice(at, html.indexOf('\n});\n', at));
}

test('install.html wendet den Plan an und rechnet den Zugriff über accessEnv', () => {
  assert.match(html, /import \{[^}]*prefillPlan[^}]*\} from '\/rerun-prefill\.js'/, 'rerun-prefill.js wird nicht importiert');
  assert.match(html, /prefillPlan\(d\.rerunValues/, 'der Preflight-Block wendet den Plan nicht an');
  const cfg = handler('cfg-next');
  assert.match(cfg, /accessEnv\(/, 'cfg-next setzt SESSION_SECURE/TRUST_PROXY weiter hart');
  assert.doesNotMatch(cfg, /S\.TRUST_PROXY = '1'/, 'cfg-next überschreibt TRUST_PROXY weiter hart');
  const wea = handler('wea-next');
  assert.doesNotMatch(wea, /S\.WEATHER_UNITS = 'metric'/,
    'abgeschaltetes Wetter schreibt weiter metric über bestehende Einheiten');
});

test('Paarprüfungen zählen ein übernommenes Secret als vorhanden', () => {
  assert.match(handler('storage-next'), /hasSecret\(/, 'die Drive-Paarprüfung kennt übernommene Secrets nicht');
  assert.match(handler('adv-next'), /hasSecret\(/, 'die OIDC-Prüfung kennt das übernommene Client-Secret nicht');
});

// ── Review #2382: Compose-Syntax, _FILE-Secrets, Teil-SMTP ────────────────────

async function save(base, env) {
  const r = await fetch(`${base}/api/save-env`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ env }),
  });
  assert.equal(r.status, 200, `save-env: ${r.status}`);
}

test('decodeEnvValue liest die .env-Syntax wie Docker Compose', () => {
  // docs.docker.com/compose/how-tos/environment-variables/variable-interpolation
  const cases = [
    ['./data # storage', './data'],
    ['VAL# not a comment', 'VAL# not a comment'],
    ['  spaced  ', 'spaced'],
    ["'a b'", 'a b'],
    ["'$OTHER'", '$OTHER'],
    ["'pa$$wort'", 'pa$$wort'],
    ["'Let\\'s go!' # c", "Let's go!"],
    ["'some\\tvalue'", 'some\\tvalue'],
    ['"VAL # not a comment"', 'VAL # not a comment'],
    ['"VAL" # comment', 'VAL'],
    ['"{\\"hello\\": \\"json\\"}"', '{"hello": "json"}'],
    ['"some\\tvalue"', 'some\tvalue'],
    ['"back\\\\slash"', 'back\\slash'],
    ['"a$$b"', 'a$b'],
    ['pa$$wort', 'pa$wort'],
  ];
  for (const [raw, want] of cases) assert.equal(decodeEnvValue(raw), want, `decodeEnvValue(${raw})`);
});

test('ein unveränderter Rerun lässt Kommentar-, Quote- und $$-Zeilen byte-gleich stehen', async () => {
  // Vorher kam `DATA_DIR=./data # storage` MIT Kommentar zurück, der Wizard
  // belegte das Feld damit vor, schickte es zurück, und der Server schrieb
  // `DATA_DIR="./data # storage"` - Compose mountete ein anderes Verzeichnis.
  const lines = [
    'SESSION_SECRET=alt-session',
    'DB_ENCRYPTION_KEY=alt-db',
    'DATA_DIR=./data # storage',
    "EMAIL_SMTP_USER='mail user' # Konto",
    'WEATHER_CITY="Bad \\"Homburg\\""',
    'EMAIL_FROM_NAME=Kasse$$Haus',
    'OIKOS_HTTP_PORT=8443',
  ];
  const dir = tempDir('oikos-rerun-');
  try {
    writeFileSync(join(dir, '.env'), `${lines.join('\n')}\n`);
    await withServer(dir, async base => {
      const d = await (await fetch(`${base}/api/preflight`)).json();
      assert.equal(d.rerunValues.DATA_DIR, './data', 'der Inline-Kommentar landet in der Vorbelegung');
      assert.equal(d.rerunValues.EMAIL_SMTP_USER, 'mail user', 'einfache Quotes landen in der Vorbelegung');
      assert.equal(d.rerunValues.WEATHER_CITY, 'Bad "Homburg"');
      assert.equal(d.rerunValues.EMAIL_FROM_NAME, 'Kasse$Haus');
      // Der unveränderte Wizard schickt die vorbelegten Werte zurück, dazu
      // einen bewusst geänderten - omitUnchanged nimmt nur die unveränderten raus.
      const plan = prefillPlan(d.rerunValues, d.keptSecrets);
      const wizard = {
        DATA_DIR: plan.fields['adv-data-dir'],
        EMAIL_SMTP_USER: plan.fields['email-user'],
        WEATHER_CITY: plan.fields['wea-city'],
        EMAIL_FROM_NAME: plan.fields['email-from-name'],
        OIKOS_HTTP_PORT: '9000',
        TZ: 'Europe/Berlin',
      };
      const env = omitUnchanged(wizard, d.rerunValues);
      assert.deepEqual(Object.keys(env).sort(), ['OIKOS_HTTP_PORT', 'TZ']);
      await save(base, env);
    });
    const after = readFileSync(join(dir, '.env'), 'utf8').split('\n');
    for (const line of lines.filter(l => !l.startsWith('OIKOS_HTTP_PORT'))) {
      assert.ok(after.includes(line), `Zeile nicht byte-gleich erhalten: ${line}`);
    }
    assert.ok(after.includes('OIKOS_HTTP_PORT=9000'), 'eine bewusste Änderung muss geschrieben werden');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('omitUnchanged lässt bei einer Erstinstallation alles durch', () => {
  const env = { DATA_DIR: './data', TZ: 'UTC' };
  assert.equal(omitUnchanged(env, null), env);
  assert.deepEqual(omitUnchanged(env, { DATA_DIR: './daten' }), env, 'ein geänderter Wert muss gesendet werden');
});

test('install.html schickt unveränderte Vorbelegung nicht zurück', () => {
  const saves = html.split("fetch('/api/save-env'").length - 1;
  const omitted = (html.match(/omitUnchanged\(buildEnv\(\), rerunValues[^)]*\)/g) || []).length;
  assert.ok(saves >= 2 && omitted === saves,
    `${saves} save-env-Aufrufe, ${omitted} davon ohne unveränderte Werte`);
});

test('ein Secret per <NAME>_FILE gilt als übernommen und wird nicht doppelt geschrieben', async () => {
  // GOOGLE_CLIENT_SECRET_FILE zählte nicht: die Paarprüfung hielt den Rerun an,
  // und ein eingetipptes Secret setzte beide Quellen - applyFileSecrets()
  // bricht den App-Start dann ab. Bei SESSION_SECRET_FILE/DB_ENCRYPTION_KEY_FILE
  // erzeugte der Wizard selbst einen zweiten Wert.
  const fileVars = FILE_SECRET_VARS.filter(k => RERUN_SECRET_KEYS.includes(k));
  assert.ok(fileVars.includes('GOOGLE_CLIENT_SECRET') && fileVars.includes('OIDC_CLIENT_SECRET'));
  const lines = [
    'GOOGLE_CLIENT_ID=gid.apps.example.test',
    ...fileVars.map(k => `${k}_FILE=/run/secrets/geheimpfad_${k.toLowerCase()}`),
  ];
  const dir = tempDir('oikos-rerun-');
  try {
    writeFileSync(join(dir, '.env'), `${lines.join('\n')}\n`);
    await withServer(dir, async base => {
      const d = await (await fetch(`${base}/api/preflight`)).json();
      assert.deepEqual([...d.keptSecrets].sort(), [...fileVars].sort(),
        'Secrets per _FILE fehlen in keptSecrets');
      assert.deepEqual([...d.preservedKeys].sort(), ['DB_ENCRYPTION_KEY', 'SESSION_SECRET'],
        'SESSION_SECRET_FILE/DB_ENCRYPTION_KEY_FILE: der Wizard erzeugte zweite Schlüssel');
      assert.ok(!JSON.stringify(d).includes('geheimpfad'), 'der Preflight gibt den Pfad heraus');
      // Ein trotzdem gesendeter Klartext darf nicht neben die Datei-Variante.
      await save(base, { GOOGLE_CLIENT_SECRET: 'getippt', SESSION_SECRET: 'neu', TZ: 'UTC' });
    });
    const after = readFileSync(join(dir, '.env'), 'utf8');
    assert.doesNotMatch(after, /^GOOGLE_CLIENT_SECRET=/m, 'Klartext neben GOOGLE_CLIENT_SECRET_FILE geschrieben');
    assert.doesNotMatch(after, /^SESSION_SECRET=/m, 'Klartext neben SESSION_SECRET_FILE geschrieben');
    for (const line of lines) assert.ok(after.split('\n').includes(line), `Zeile verloren: ${line}`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('ein unverändert übernommener Teil-SMTP-Abschnitt wird nicht auf Vollständigkeit geprüft', () => {
  // Nur EMAIL_SMTP_HOST in der .env, der Absender steht in der App (sync_config,
  // server/services/email.js löst jedes Feld einzeln auf). Die Vorbelegung
  // schaltet den Abschnitt ein, email-next blockierte an email.errIncomplete.
  for (const id of EMAIL_SECTION_FIELDS) assert.match(html, new RegExp(`id="${id}"`), `Feld ${id} fehlt`);
  const baseline = { 'email-enable': true, 'email-host': 'smtp.example.test', 'email-from': '' };
  assert.equal(unchangedSince(baseline, { ...baseline }, Object.keys(baseline)), true);
  assert.equal(unchangedSince(baseline, { ...baseline, 'email-from': 'a@b.test' }, Object.keys(baseline)), false);
  assert.equal(unchangedSince(null, baseline, Object.keys(baseline)), false, 'ohne Rerun wird immer geprüft');

  const email = handler('email-next');
  const skip = email.indexOf('untouched(...EMAIL_SECTION_FIELDS)');
  const check = email.indexOf("t('email.errIncomplete')");
  assert.ok(skip !== -1 && skip < check, 'email-next prüft auch einen unveränderten Bestand');
  for (const id of EMAIL_SECTION_FIELDS) assert.ok(BASELINE_FIELDS.includes(id), `${id} fehlt in BASELINE_FIELDS`);
  assert.match(html, /fieldBaseline = fieldState\(BASELINE_FIELDS\)/,
    'applyRerunPrefill hält den Stand nach der Vorbelegung nicht fest');
});

test('ein unverändert übernommenes Kalender-Paar wird beim Rerun nicht blockiert', () => {
  // Nur APPLE_USERNAME in der .env, das App-Passwort steht in der App
  // (sync_config; server/services/apple-calendar.js getCredentials() löst
  // URL, Nutzer und Passwort einzeln auf). keptSecrets kennt nur .env-Secrets,
  // die Paarprüfung hielt einen unveränderten Rerun an calendar.errApplePair fest.
  const cal = handler('cal-next');
  const skip = cal.indexOf('untouched(idField, secretField)');
  const check = cal.indexOf('pairGap(');
  assert.ok(skip !== -1 && skip < check, 'cal-next prüft auch ein unverändert übernommenes Paar');
  for (const id of ['gcal-id', 'gcal-secret', 'outlook-id', 'outlook-secret', 'apple-user', 'apple-pass']) {
    assert.ok(BASELINE_FIELDS.includes(id), `${id} fehlt in BASELINE_FIELDS`);
  }
});

test('ein umgelegter, vorbelegter Schalter wird ausdrücklich gesendet', () => {
  // BACKUP_ENABLED=false vorbelegt, der Nutzer schaltet Backups ein: storage-next
  // setzt '' (Standard = an), sanitizeEnv verwirft es, preserveUnmanagedLines
  // stellte die alte Zeile wieder her - Backups blieben aus, die Prüfseite sagte an.
  assert.deepEqual(omitUnchanged({ BACKUP_ENABLED: '' }, { BACKUP_ENABLED: 'false' }), { BACKUP_ENABLED: 'true' });
  assert.deepEqual(omitUnchanged({ MODULES_ALLOW_WEB_INSTALL: '' }, { MODULES_ALLOW_WEB_INSTALL: 'true' }),
    { MODULES_ALLOW_WEB_INSTALL: 'false' });
  // Unverändert bleibt ungesendet, auch wenn der Bestand ausdrücklich den Standard schreibt.
  assert.deepEqual(omitUnchanged({ MODULES_ALLOW_WEB_INSTALL: '' }, { MODULES_ALLOW_WEB_INSTALL: 'false' }), {});
  assert.deepEqual(omitUnchanged({ BACKUP_ENABLED: 'false' }, { BACKUP_ENABLED: 'false' }), {});
  // Ohne Vorbelegung bleibt der leere Standard leer.
  assert.deepEqual(omitUnchanged({ BACKUP_ENABLED: '' }, {}), { BACKUP_ENABLED: '' });
});

test('eine IPv6-BASE_URL belegt das Host-Feld nicht mit einem ungültigen Host vor', () => {
  // isValidHost() kennt nur Namen und IPv4; `::1` blockierte cfg-next beim
  // unveränderten Rerun. Die BASE_URL selbst bleibt übernommen.
  const plan = prefillPlan({ BASE_URL: 'http://[::1]:3000' });
  assert.equal(plan.fields['cfg-host'], undefined);
  assert.ok(plan.touched.includes('adv-base-url'));
  assert.equal(prefillPlan({ BASE_URL: 'https://yuvomi.example.test' }).fields['cfg-host'], 'yuvomi.example.test');
});

// ── Review #2382 (Runde 2): unverändert heisst ungeprüft, unabgeleitet, ungesendet ──
//
// Die Schritt-Handler laufen hier wirklich: Quelltext aus install.html, ein
// Feld-Stub statt DOM, dieselbe Vorbelegung wie applyRerunPrefill.

/** Quelltext einer Funktion aus install.html ('' wenn es sie nicht gibt). */
function fnSource(name) {
  return html.match(new RegExp(`\\nfunction ${name}\\([^)]*\\) \\{[\\s\\S]*?\\n\\}`))?.[0] ?? '';
}

function arrowOf(id) {
  const src = handler(id);
  return `${src.slice(src.indexOf('() => {'))}\n}`;
}

/** Der Standardwert eines Feldes laut Markup. */
function markupDefault(id) {
  const tag = html.match(new RegExp(`<input[^>]*\\bid="${id}"[^>]*>`))?.[0] || '';
  return {
    checkbox: /type="checkbox"/.test(tag),
    checked: /\bchecked\b/.test(tag),
    value: tag.match(/\bvalue="([^"]*)"/)?.[1] ?? (id === 'adv-proxy' ? 'proxy' : ''),
  };
}

const HANDLER_SCOPE = [
  '$', 'S', 't', 'fail', 'clearInvalid', 'showErr', 'next', 'accessEnv', 'rerunValues',
  'fieldBaseline', 'unchangedSince', 'REDIRECT_SOURCES', 'EMAIL_SECTION_FIELDS', 'EMAIL_KEYS',
  'keptSecrets', 'hasSecret', 'pairGap', 'isValidCron', 'isAbsoluteContainerPath', 'enabledWithoutUrl',
];
const HANDLER_FNS = [
  'fieldState', 'untouched', 'originUnchanged', 'keptRedirect', 'plannedOrigin', 'deriveBaseUrl',
  'isValidHost', 'isValidTimeZone',
];

/**
 * Ein Wizard über einer bestehenden .env: Felder vorbelegt wie
 * applyRerunPrefill, danach `edit` (Feld-ID -> Wert), dann die Schritte.
 */
function rerunWizard(rerun, edit = {}) {
  const fields = {};
  const $ = id => {
    if (!fields[id]) {
      const d = markupDefault(id);
      fields[id] = {
        id, type: d.checkbox ? 'checkbox' : 'text', checked: d.checked, value: d.value,
        dataset: {}, style: {}, textContent: '', focus() {}, setAttribute() {}, removeAttribute() {},
      };
    }
    return fields[id];
  };
  const plan = rerun ? prefillPlan(rerun, []) : { fields: {}, touched: [] };
  for (const [id, v] of Object.entries(plan.fields)) {
    if (typeof v === 'boolean') $(id).checked = v; else $(id).value = v;
  }
  for (const id of plan.touched) $(id).dataset.touched = '1';
  const S = {};
  const failures = [];
  let advanced = 0;
  const scope = {
    $, S, t: k => k, fail: (_, msg, id) => failures.push(`${msg} @ ${id}`), clearInvalid() {}, showErr() {},
    next: () => { advanced++; }, accessEnv, rerunValues: rerun, fieldBaseline: null, unchangedSince,
    REDIRECT_SOURCES, EMAIL_SECTION_FIELDS, EMAIL_KEYS: [], keptSecrets: new Set(), hasSecret: (key, typed) => Boolean(typed),
    pairGap, isValidCron, isAbsoluteContainerPath, enabledWithoutUrl,
  };
  const build = new Function(...HANDLER_SCOPE, `
    ${HANDLER_FNS.map(fnSource).join('\n')}
    if (rerunValues) fieldBaseline = fieldState(BASELINE_IDS);
    return {
      ${['cfg-next', 'cal-next', 'storage-next', 'adv-next'].map(id => `'${id}': (${arrowOf(id)})`).join(',\n')}
    };
  `.replace('BASELINE_IDS', JSON.stringify(BASELINE_FIELDS)));
  const steps = build(...HANDLER_SCOPE.map(n => scope[n]));
  for (const [id, v] of Object.entries(edit)) {
    if (typeof v === 'boolean') $(id).checked = v; else $(id).value = v;
    $(id).dataset.touched = '1';
  }
  const run = ids => {
    for (const id of ids) {
      const before = advanced;
      steps[id]();
      if (advanced === before) return false;
    }
    return true;
  };
  return { S, $, failures, run };
}

test('Compose-Interpolation in Port und Adresse hält den unveränderten Rerun nicht fest', () => {
  const rerun = {
    BASE_URL: 'https://${PUBLIC_HOST}', OIKOS_HTTP_PORT: '${HTTP_PORT:-3000}',
    SESSION_SECURE: 'true', TZ: 'Europe/Berlin',
  };
  assert.equal(isInterpolated(rerun.BASE_URL), true);
  assert.equal(prefillPlan(rerun).fields['cfg-host'], undefined,
    'der Host aus einer interpolierten BASE_URL landet im Host-Feld');
  const w = rerunWizard(rerun);
  assert.equal(w.run(['cfg-next']), true, `cfg-next blockiert: ${w.failures.join('; ')}`);
  assert.equal(w.S.BASE_URL, rerun.BASE_URL, 'die übernommene BASE_URL wurde neu abgeleitet');
  assert.equal(w.S.port, rerun.OIKOS_HTTP_PORT);
  const sent = omitUnchanged({ BASE_URL: w.S.BASE_URL, OIKOS_HTTP_PORT: w.S.port }, rerun);
  assert.deepEqual(sent, {}, 'unveränderte Werte gehen in den save-Request');

  // Wer den Port anfasst, wird wieder geprüft.
  const typed = rerunWizard(rerun, { 'cfg-port': '${HTTP_PORT}x' });
  assert.equal(typed.run(['cfg-next']), false, 'ein geänderter, ungültiger Port geht durch');
  assert.match(typed.failures.join(), /config\.errPort/);
});

test('ohne Rerun prüft cfg-next weiter jeden Wert', () => {
  const w = rerunWizard(null, { 'cfg-port': '${HTTP_PORT:-3000}' });
  assert.equal(w.run(['cfg-next']), false);
  assert.match(w.failures.join(), /config\.errPort/);
});

const OAUTH_RERUN = {
  BASE_URL: 'https://app.example.test', SESSION_SECURE: 'true', TRUST_PROXY: '1',
  GOOGLE_CLIENT_ID: 'gid.apps.example.test',
  GOOGLE_REDIRECT_URI: 'https://login.example.test/api/v1/calendar/google/callback',
  MS_CLIENT_ID: 'ms-client',
  MS_REDIRECT_URI: 'https://login.example.test/api/v1/calendar/outlook/callback',
  GOOGLE_DRIVE_CLIENT_ID: 'drive.apps.example.test',
  GOOGLE_DRIVE_REDIRECT_URI: 'https://login.example.test/api/v1/documents/storage/google-drive/callback',
  OIDC_ISSUER: 'https://idp.example.test', OIDC_CLIENT_ID: 'yuvomi',
  OIDC_REDIRECT_URI: 'https://login.example.test/api/v1/auth/oidc/callback',
};
const REDIRECT_KEYS = ['GOOGLE_REDIRECT_URI', 'MS_REDIRECT_URI', 'GOOGLE_DRIVE_REDIRECT_URI', 'OIDC_REDIRECT_URI'];

test('registrierte Redirect-URIs bleiben beim unveränderten Rerun stehen und ungesendet', () => {
  for (const key of REDIRECT_KEYS) {
    assert.ok(RERUN_PREFILL_KEYS.includes(key), `${key} fehlt in der Allowlist - omitUnchanged kann ihn nicht bewahren`);
    assert.ok(REDIRECT_SOURCES[key], `${key} ohne REDIRECT_SOURCES`);
  }
  const w = rerunWizard(OAUTH_RERUN);
  // Die Secrets als getippt: die Paarprüfungen sollen hier nicht stören.
  w.$('gcal-secret').value = 'x'; w.$('outlook-secret').value = 'x';
  w.$('adv-document-google-drive-client-secret').value = 'x'; w.$('oidc-client-secret').value = 'x';
  assert.equal(w.run(['cfg-next', 'cal-next', 'storage-next', 'adv-next']), true, w.failures.join('; '));
  for (const key of REDIRECT_KEYS) assert.equal(w.S[key], OAUTH_RERUN[key], `${key} wurde aus BASE_URL neu abgeleitet`);
  const sent = omitUnchanged(Object.fromEntries(REDIRECT_KEYS.map(k => [k, w.S[k]])), OAUTH_RERUN);
  assert.deepEqual(sent, {}, 'unveränderte Redirect-URIs gehen in den save-Request');
});

test('eine geänderte Adresse oder Client-ID leitet die Redirect-URI neu ab', () => {
  const moved = rerunWizard(OAUTH_RERUN, { 'adv-base-url': 'https://neu.example.test' });
  for (const id of ['gcal-secret', 'outlook-secret', 'adv-document-google-drive-client-secret', 'oidc-client-secret']) {
    moved.$(id).value = 'x';
  }
  assert.equal(moved.run(['cfg-next', 'cal-next', 'storage-next', 'adv-next']), true, moved.failures.join('; '));
  for (const key of REDIRECT_KEYS) assert.match(moved.S[key], /^https:\/\/neu\.example\.test\//, `${key} folgt der neuen Adresse nicht`);

  const client = rerunWizard(OAUTH_RERUN, { 'gcal-id': 'other.apps.example.test' });
  client.$('gcal-secret').value = 'x'; client.$('outlook-secret').value = 'x';
  assert.equal(client.run(['cfg-next', 'cal-next']), true, client.failures.join('; '));
  assert.equal(client.S.GOOGLE_REDIRECT_URI, 'https://app.example.test/api/v1/calendar/google/callback');
  assert.equal(client.S.MS_REDIRECT_URI, OAUTH_RERUN.MS_REDIRECT_URI, 'Outlook hängt nicht an der Google-ID');
});

test('ein unverändert übernommener Zeitplan wird nicht gegen isValidCron geprüft', () => {
  // node-cron nimmt L (letzter Tag) an, isValidCron bewusst nicht.
  const rerun = { BACKUP_SCHEDULE: '0 2 L * *', BACKUP_KEEP: '7' };
  assert.equal(isValidCron(rerun.BACKUP_SCHEDULE), false, 'Testannahme: isValidCron kennt L nicht');
  const w = rerunWizard(rerun);
  assert.equal(w.run(['storage-next']), true, `storage-next blockiert: ${w.failures.join('; ')}`);
  assert.equal(w.S.BACKUP_SCHEDULE, rerun.BACKUP_SCHEDULE);
  const typed = rerunWizard(rerun, { 'adv-backup-schedule': '99 * * * *' });
  assert.equal(typed.run(['storage-next']), false, 'ein geänderter, ungültiger Zeitplan geht durch');
});

test('ein unberührter Schalter mit Compose-Ausdruck bleibt ungesendet', () => {
  // BACKUP_ENABLED=${BACKUPS:-false}: prefillPlan liest den Ausdruck als "an",
  // storage-next setzt '', die Schalter-Normalisierung machte daraus 'true' -
  // der Vergleich mit dem Ausdruck erkannte das nie als unverändert, und ein
  // unberührter Rerun schaltete abgeschaltete Backups ein.
  const rerun = { BACKUP_ENABLED: '${BACKUPS:-false}', MODULES_ALLOW_WEB_INSTALL: '${WEB:-true}' };
  const env = { BACKUP_ENABLED: '', MODULES_ALLOW_WEB_INSTALL: '' };
  assert.deepEqual(omitUnchanged(env, rerun, () => true), {}, 'unberührte Schalter wurden gesendet');
  // Umgelegt bleibt ausdrücklich.
  assert.deepEqual(omitUnchanged(env, rerun, () => false), { BACKUP_ENABLED: 'true', MODULES_ALLOW_WEB_INSTALL: 'false' });
  const calls = html.match(/omitUnchanged\(buildEnv\(\), rerunValues[^)]*\)/g) || [];
  assert.ok(calls.length >= 2 && calls.every(c => /untouched/.test(c)),
    'install.html gibt omitUnchanged den Feldstand nach der Vorbelegung nicht mit');
});

test('übernommene Koordinaten mit Compose-Ausdruck blockieren wea-next nicht', () => {
  // WEATHER_LAT=${LAT:-52.52}: ein type=number-Feld verwirft den Ausdruck beim
  // Zuweisen zu '', die Pflichtprüfung lief VOR der untouched-Ausnahme und hielt
  // den unveränderten Rerun fest. Unverändert geht der Bestand zurück.
  const wea = handler('wea-next');
  const keep = wea.indexOf("untouched('wea-lat', 'wea-lon')");
  const required = wea.indexOf("t('weather.errCoords')");
  assert.ok(keep !== -1 && keep < required, 'die Pflichtprüfung läuft vor der untouched-Ausnahme');
  assert.match(wea, /rerunValues\.WEATHER_LAT/, 'unveränderte Koordinaten kommen nicht aus dem Bestand');
});

test('der Erweitert-Pfad öffnet erst nach dem Preflight', () => {
  // Kam die Antwort spät, überschrieb applyRerunPrefill() schon getippte Werte
  // und hielt sie als unverändert fest - die Eingabe ging still verloren.
  const start = html.slice(html.indexOf('async function startFlow('));
  const body = start.slice(0, start.indexOf('\n}\n'));
  const wait = body.indexOf('await preflightDone');
  const branch = body.indexOf("if (m === 'simple')");
  assert.ok(wait !== -1 && wait < branch, 'startFlow wartet nur im Einfach-Pfad auf den Preflight');
});

// ── Re-Critique 2026-10-29 (Folge-PR): Feld leeren, Bestätigung, Heimnetz ─────

/** Ein Element-Stub mit allem, was die Handler unten anfassen. */
function stubEl(extra = {}) {
  const classes = new Set();
  return {
    value: '', type: 'text', checked: false, hidden: true, disabled: false, textContent: '',
    dataset: {}, style: {}, validity: { badInput: false },
    classList: { add: c => classes.add(c), remove: c => classes.delete(c), toggle: (c, on) => (on ? classes.add(c) : classes.delete(c)), contains: c => classes.has(c) },
    classes, focus() {}, setAttribute() {}, removeAttribute() {},
    ...extra,
  };
}

// Entscheidung C: ein vorbelegtes Wert-Feld, das der Nutzer leert, entfernt die
// Zeile. Vorher sendete der Wizard '', sanitizeEnv verwarf es, und
// preserveUnmanagedLines setzte die alte Zeile wieder ein - die Prüfseite sagte
// "Nicht eingerichtet", die .env behielt den Wert.

test('clearedKeys: nur ein vorbelegtes, jetzt geleertes Wert-Feld landet in clear', () => {
  const { clearedKeys } = rerunPrefill;
  assert.equal(typeof clearedKeys, 'function', 'clearedKeys fehlt in rerun-prefill.js');
  const rerun = {
    WEATHER_CITY: 'Bad Homburg', EMAIL_FROM_NAME: 'Haus', WEATHER_LAT: '${LAT:-52.52}',
    BASE_URL: 'https://app.example.test', BACKUP_ENABLED: 'false',
  };
  const baseline = {
    'wea-city': 'Bad Homburg', 'email-from-name': 'Haus',
    // type=number verwirft den Compose-Ausdruck beim Zuweisen: vorbelegt ist ''.
    'wea-lat': '', 'adv-base-url': 'https://app.example.test', 'adv-backup-enable': false,
  };
  // Unberührter Rerun: nichts wird entfernt.
  assert.deepEqual(clearedKeys(rerun, baseline, { ...baseline }, {}), []);
  // Geleert: entfernt.
  assert.deepEqual(clearedKeys(rerun, baseline, { ...baseline, 'wea-city': '' }, {}), ['WEATHER_CITY']);
  // Nur Leerzeichen gilt als leer (der Handler trimmt).
  assert.deepEqual(clearedKeys(rerun, baseline, { ...baseline, 'email-from-name': '   ' }, {}), ['EMAIL_FROM_NAME']);
  // Ein sanitisierter Ausdruck war nie sichtbar vorbelegt - auch leer bleibt er.
  assert.deepEqual(clearedKeys(rerun, baseline, { ...baseline, 'wea-lat': '' }, {}), []);
  // badInput (Zahlfeld mit Buchstaben) meldet value '' - das ist kein Leeren.
  assert.deepEqual(clearedKeys(rerun, baseline, { ...baseline, 'wea-city': null }, {}), []);
  // Ein geleertes Feld, für das der Wizard trotzdem einen Wert baut (BASE_URL aus
  // Host und Port), wird geschrieben, nicht entfernt - auch wenn der gebaute
  // Wert dem Bestand gleicht und omitUnchanged ihn deshalb nicht sendet.
  assert.deepEqual(clearedKeys(rerun, baseline, { ...baseline, 'adv-base-url': '' },
    { BASE_URL: 'https://app.example.test' }), []);
  // Schalter und Secrets sind nie "geleert".
  assert.deepEqual(clearedKeys(rerun, baseline, { ...baseline, 'adv-backup-enable': true }, {}), []);
  // Ohne Rerun gibt es nichts zu entfernen.
  assert.deepEqual(clearedKeys(null, null, { 'wea-city': '' }, {}), []);
  for (const key of ['WEATHER_CITY', 'DATA_DIR', 'OIDC_ISSUER']) {
    assert.ok(PREFILL_FIELDS.some(([k, , kind]) => k === key && kind === 'value'), `${key} ist kein Wert-Feld`);
  }
});

test('POST /api/save-env entfernt nur erlaubte geleerte Zeilen, der Rest bleibt byte-gleich', async () => {
  const lines = [
    'SESSION_SECRET=alt-session',
    'DB_ENCRYPTION_KEY=alt-db',
    'WEATHER_CITY="Bad Homburg" # Stadt',
    'EMAIL_FROM_NAME=Haus',
    'DATA_DIR=./data # storage',
    'EMAIL_SMTP_PASS=geheim-1',
    'LOG_LEVEL=debug',
    'OIKOS_HTTP_PORT=${HTTP_PORT:-3000}',
    'GOOGLE_CLIENT_SECRET_FILE=/run/secrets/g',
  ];
  const dir = tempDir('oikos-rerun-');
  try {
    writeFileSync(join(dir, '.env'), `${lines.join('\n')}\n`);
    await withServer(dir, async base => {
      const r = await fetch(`${base}/api/save-env`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          env: { TZ: 'UTC', EMAIL_FROM_NAME: 'Neu' },
          // Erlaubt: WEATHER_CITY. Ignoriert: Secrets, PRESERVED_KEYS, Schlüssel
          // ausserhalb der Allowlist, _FILE-Varianten, Unsinn - und ein Schlüssel,
          // der zugleich mit Wert kommt (der Wert gewinnt).
          clear: ['WEATHER_CITY', 'SESSION_SECRET', 'DB_ENCRYPTION_KEY', 'EMAIL_SMTP_PASS', 'LOG_LEVEL',
            'GOOGLE_CLIENT_SECRET_FILE', 'NOPE', 42, null, 'EMAIL_FROM_NAME'],
        }),
      });
      assert.equal(r.status, 200);
    });
    const after = readFileSync(join(dir, '.env'), 'utf8').split('\n');
    assert.ok(!after.some(l => l.startsWith('WEATHER_CITY=')), 'die geleerte Zeile steht noch in der .env');
    for (const line of lines.filter(l => !/^(WEATHER_CITY|EMAIL_FROM_NAME)=/.test(l))) {
      assert.ok(after.includes(line), `Zeile nicht byte-gleich erhalten: ${line}`);
    }
    assert.ok(after.includes('EMAIL_FROM_NAME=Neu'), 'ein gesendeter Wert gewinnt gegen clear');
    assert.equal(after.filter(l => l.startsWith('EMAIL_FROM_NAME=')).length, 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('POST /api/save-env ohne clear (oder mit kaputtem clear) bewahrt alles wie bisher', async () => {
  const lines = ['SESSION_SECRET=s', 'DB_ENCRYPTION_KEY=d', 'WEATHER_CITY=Berlin', 'DATA_DIR=./data # x'];
  for (const clear of [undefined, 'WEATHER_CITY', { WEATHER_CITY: true }, []]) {
    const dir = tempDir('oikos-rerun-');
    try {
      writeFileSync(join(dir, '.env'), `${lines.join('\n')}\n`);
      await withServer(dir, async base => {
        const r = await fetch(`${base}/api/save-env`, {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(clear === undefined ? { env: {} } : { env: {}, clear }),
        });
        assert.equal(r.status, 200);
      });
      const after = readFileSync(join(dir, '.env'), 'utf8').split('\n');
      for (const line of lines) assert.ok(after.includes(line), `clear=${JSON.stringify(clear)}: Zeile verloren: ${line}`);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }
});

test('install.html schickt die geleerten Felder mit und zeigt sie auf der Prüfseite', () => {
  const saves = html.split("fetch('/api/save-env'").length - 1;
  const withClear = (html.match(/JSON\.stringify\(\{ env[^}]*, clear: pendingClears\(/g) || []).length;
  assert.ok(saves >= 2 && withClear === saves, `${saves} save-env-Aufrufe, ${withClear} davon mit clear`);
  // pendingClears rechnet über den Feldstand nach der Vorbelegung und gegen
  // das UNGEKÜRZTE buildEnv() (siehe clearedKeys: BASE_URL).
  const fnSrc = fnSource('pendingClears');
  assert.match(fnSrc, /clearedKeys\(rerunValues, fieldBaseline, clearState\(\), /);
  assert.match(fnSource('clearState'), /badInput/, 'ein Zahlfeld mit Buchstaben gälte als geleert');
  // Ausgeführt: badInput -> null, Wert sonst roh.
  const els = {
    'wea-city': stubEl({ value: '' }),
    'wea-lat': stubEl({ value: '', validity: { badInput: true } }),
    'adv-backup-enable': stubEl({ type: 'checkbox', checked: true }),
  };
  const clearState = new Function('$', 'BASELINE_FIELDS', `${fnSource('clearState')}\nreturn clearState;`)(
    id => els[id] ?? stubEl(), Object.keys(els));
  assert.deepEqual(clearState(), { 'wea-city': '', 'wea-lat': null, 'adv-backup-enable': true });
  // Prüfseite: eigene Zeile "Wird entfernt".
  assert.match(html, /id="rv-cleared"/, 'die Prüfseite hat keine Zeile für entfernte Werte');
  assert.match(fnSource('renderReview'), /pendingClears\(/, 'renderReview zeigt die entfernten Werte nicht');
  // Der Server-Kommentar behauptet nicht mehr, Leeren gehe nicht.
  const server = readFileSync(new URL('../tools/installer/install-server.js', import.meta.url), 'utf8');
  assert.doesNotMatch(server, /lässt sich ein Wert nicht mehr LEEREN/);
});

// Entscheidung B: zwei Klicks nur, wenn etwas überschrieben oder neu gestartet
// wird. Bei der Erstinstallation war der zweite Klick reine Reibung - und die
// Bestätigung sagte nicht, WAS sie bestätigt.

/** Den Klick-Handler (async) aus install.html mit Stubs ausführbar machen. */
function saveHandler(id, state) {
  const at = html.indexOf(`$('${id}').addEventListener('click', async () => {`);
  assert.ok(at > 0, `Handler ${id} nicht gefunden`);
  const body = html.slice(at, html.indexOf('\n});\n', at));
  const arrow = `${body.slice(body.indexOf('async () => {'))}\n}`;
  const els = {};
  const $ = k => (els[k] ??= stubEl());
  const fetches = [];
  const fakeFetch = async (url, opts) => { fetches.push({ url, body: JSON.parse(opts.body) }); return { ok: true, json: async () => ({ path: '/x/.env' }) }; };
  const scope = {
    $, t: k => k, S: {}, showErr() {}, fail() {}, clearInvalid() {}, next() {}, startDocker() {},
    buildEnv: () => ({ TZ: 'UTC' }), omitUnchanged: e => e, rerunValues: null, untouched: () => false,
    pendingClears: () => [], fetch: fakeFetch, preflightDone: Promise.resolve(), simpleLockedByEnv: false,
    startFlow() {}, isValidHost: () => true, ensureKeys: async () => {}, deriveBaseUrl: () => 'http://h:3000',
    preflightState: state, savedEnvPath: '',
  };
  const names = Object.keys(scope);
  const make = new Function(...names, `
    let reviewConfirmed = false, reviewArmedAt = 0, simpleConfirmed = false, simpleArmedAt = 0;
    const CONFIRM_COOLDOWN_MS = 0;
    ${fnSource('needsConfirm')}
    ${fnSource('confirmLineKey')}
    ${fnSource('armConfirm')}
    ${fnSource('disarmConfirm')}
    return (${arrow});
  `);
  return { click: make(...names.map(n => scope[n])), fetches, els };
}

test('Erstinstallation: der erste Klick auf Speichern speichert sofort', async () => {
  for (const id of ['rev-next', 'simple-next']) {
    const h = saveHandler(id, { known: true, envExists: false, containerRunning: false });
    await h.click();
    assert.equal(h.fetches.length, 1, `${id}: die Erstinstallation verlangt weiter eine Bestätigung`);
  }
});

test('bestehende .env oder laufender Container: erst bestätigen, und die Zeile sagt was', async () => {
  const cases = [
    [{ known: true, envExists: true, containerRunning: false }, 'review.confirmEnv'],
    [{ known: true, envExists: false, containerRunning: true }, 'review.confirmRunning'],
    [{ known: true, envExists: true, containerRunning: true }, 'review.confirmBoth'],
    // Preflight gescheitert: unbekannt heisst vorsichtig.
    [{ known: false, envExists: false, containerRunning: false }, 'review.confirmUnknown'],
  ];
  for (const [state, key] of cases) {
    for (const [id, line] of [['rev-next', 'rev-confirm-line'], ['simple-next', 'simple-confirm-line']]) {
      const h = saveHandler(id, state);
      await h.click();
      assert.equal(h.fetches.length, 0, `${id} ${JSON.stringify(state)}: speichert ohne Bestätigung`);
      assert.equal(h.els[line]?.textContent, key, `${id}: die Bestätigungszeile nennt nicht, was bestätigt wird`);
      assert.equal(h.els[line].hidden, false, `${id}: die Bestätigungszeile ist nicht sichtbar`);
      await h.click();
      assert.equal(h.fetches.length, 1, `${id}: der zweite Klick speichert nicht`);
    }
  }
  for (const line of ['rev-confirm-line', 'simple-confirm-line']) {
    assert.match(html, new RegExp(`id="${line}"[^>]*hidden`), `${line} fehlt im Markup oder ist nicht anfangs verborgen`);
  }
  assert.match(html, /preflightState\.containerRunning = Boolean\(d\.containerRunning\)/,
    'der Preflight merkt sich den laufenden Container nicht');
});

// Entscheidung A: auch der Erweitert-Pfad beginnt bei der Erstinstallation mit
// der Heimnetz-Adresse. cfg-host stand fest auf localhost: Einladungs- und
// Reset-Links zeigten auf das Gerät, auf dem man sie öffnet.

test('Erweitert-Pfad: cfg-host übernimmt bei der Erstinstallation die Heimnetz-Adresse', () => {
  const run = (rerun, lan, edited, initial = 'localhost') => {
    const els = { 'cfg-host': stubEl({ value: initial }) };
    let refreshed = 0;
    const fn = new Function('$', 'rerunValues', 'lanAddress', 'cfgHostEdited', 'refreshPlannedOrigin',
      `${fnSource('prefillAdvancedHost')}\nreturn prefillAdvancedHost;`)(
      id => els[id], rerun, lan, edited, () => { refreshed++; });
    fn();
    return { value: els['cfg-host'].value, refreshed };
  };
  assert.equal(fnSource('prefillAdvancedHost') !== '', true, 'prefillAdvancedHost fehlt');
  assert.deepEqual(run(null, '192.168.1.20', false), { value: '192.168.1.20', refreshed: 1 });
  assert.equal(run(null, null, false).value, 'localhost', 'ohne Heimnetz-Adresse bleibt localhost');
  assert.equal(run(null, '192.168.1.20', true, 'nas.lan').value, 'nas.lan', 'eine eigene Eingabe wird überschrieben');
  // Rerun: die Vorbelegung (oder ihr Fehlen) gilt; ein späteres Setzen änderte
  // den Feldstand nach fieldBaseline und leitete eine neue BASE_URL ab.
  assert.equal(run({}, '192.168.1.20', false).value, 'localhost', 'der Rerun bekommt die LAN-Adresse übergestülpt');
  const start = html.slice(html.indexOf('async function startFlow('));
  const body = start.slice(0, start.indexOf('\n}\n'));
  assert.ok(body.indexOf('await lanDone') !== -1 && body.indexOf('await lanDone') < body.indexOf('prefillAdvancedHost()'),
    'startFlow belegt cfg-host vor der Antwort von /api/lan-address');
  assert.match(html, /\$\('cfg-host'\)\.addEventListener\('input', \(\) => \{ cfgHostEdited = true; \}\)/);
});

test('Prüfseite: eine Adresse nur für dieses Gerät bekommt einen ruhigen Hinweis', () => {
  assert.match(html, /id="rv-local-note"[^>]*hidden/, 'der Hinweis fehlt oder steht immer da');
  assert.match(html, /id="rv-local-note"[^>]*data-i18n="review.localOnly"/);
  const review = fnSource('renderReview');
  assert.match(review, /\$\('rv-local-note'\)\.hidden = !isLoopbackHost\(/,
    'renderReview blendet den Hinweis nicht nach der öffentlichen Adresse ein');
  // Ausgeführt: welche Adressen gelten als "nur dieses Gerät"?
  const isLoopbackHost = new Function(`${fnSource('isLoopbackHost')}\nreturn isLoopbackHost;`)();
  const originHost = new Function(`${fnSource('originHost')}\nreturn originHost;`)();
  for (const url of ['http://localhost:3000', 'http://127.0.0.1:3000', 'http://[::1]:3000']) {
    assert.equal(isLoopbackHost(originHost(url)), true, url);
  }
  // Heimnetz und Compose-Ausdrücke sind NICHT "nur dieses Gerät".
  for (const url of ['http://192.168.1.20:3000', 'https://app.example.test', 'https://${PUBLIC_HOST}', 'kaputt']) {
    assert.equal(isLoopbackHost(originHost(url)), false, url);
  }
});
