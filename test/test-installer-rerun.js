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

import { createInstallerServer, readEnvFile } from '../tools/installer/install-server.js';
import {
  ENV_SCHEMA, RERUN_PREFILL_KEYS, RERUN_SECRET_KEYS, RERUN_DERIVED_KEYS,
} from '../tools/installer/env-schema.js';
import {
  prefillPlan, accessEnv, PREFILL_FIELDS, KEPT_SECRET_FIELDS,
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
