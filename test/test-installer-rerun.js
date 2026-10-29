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
  ENV_SCHEMA, RERUN_PREFILL_KEYS, RERUN_SECRET_KEYS, RERUN_DERIVED_KEYS,
} from '../tools/installer/env-schema.js';
import {
  prefillPlan, accessEnv, PREFILL_FIELDS, KEPT_SECRET_FIELDS,
  omitUnchanged, unchangedSince, EMAIL_SECTION_FIELDS,
} from '../tools/installer/rerun-prefill.js';

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
  const lists = { RERUN_PREFILL_KEYS, RERUN_SECRET_KEYS, RERUN_DERIVED_KEYS };
  for (const { key } of ENV_SCHEMA) {
    const hits = Object.entries(lists).filter(([, l]) => l.includes(key)).map(([n]) => n);
    assert.equal(hits.length, 1,
      `${key} steht in ${hits.length ? hits.join(' und ') : 'keiner Liste'} - neu einordnen (env-schema.js)`);
  }
  const schemaKeys = new Set(ENV_SCHEMA.map(e => e.key));
  for (const key of [...RERUN_PREFILL_KEYS, ...RERUN_SECRET_KEYS, ...RERUN_DERIVED_KEYS]) {
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
  // GOOGLE_DRIVE_REDIRECT_URI schaltet nur die Drive-Gruppe ein.
  const special = new Set(['TZ', 'SESSION_SECURE', 'TRUST_PROXY', 'GOOGLE_DRIVE_REDIRECT_URI']);
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
  const omitted = (html.match(/omitUnchanged\(buildEnv\(\), rerunValues\)/g) || []).length;
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
  const skip = email.indexOf('unchangedSince(emailBaseline');
  const check = email.indexOf("t('email.errIncomplete')");
  assert.ok(skip !== -1 && skip < check, 'email-next prüft auch einen unveränderten Bestand');
  assert.match(html, /emailBaseline = fieldState\(EMAIL_SECTION_FIELDS\)/,
    'applyRerunPrefill hält den Stand nach der Vorbelegung nicht fest');
});

test('ein unverändert übernommenes Kalender-Paar wird beim Rerun nicht blockiert', () => {
  // Nur APPLE_USERNAME in der .env, das App-Passwort steht in der App
  // (sync_config; server/services/apple-calendar.js getCredentials() löst
  // URL, Nutzer und Passwort einzeln auf). keptSecrets kennt nur .env-Secrets,
  // die Paarprüfung hielt einen unveränderten Rerun an calendar.errApplePair fest.
  const cal = handler('cal-next');
  const skip = cal.indexOf('unchangedSince(calBaseline');
  const check = cal.indexOf('pairGap(');
  assert.ok(skip !== -1 && skip < check, 'cal-next prüft auch ein unverändert übernommenes Paar');
  assert.match(html, /calBaseline = fieldState\(CAL_PAIR_FIELDS\)/,
    'applyRerunPrefill hält den Kalender-Stand nach der Vorbelegung nicht fest');
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
