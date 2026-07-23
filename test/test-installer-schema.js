import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { ENV_SCHEMA } from '../tools/installer/env-schema.js';

const ORIGINAL_KEYS = [
  'SESSION_SECRET', 'DB_ENCRYPTION_KEY', 'WEATHER_LAT',
  'WEATHER_LON', 'WEATHER_CITY', 'WEATHER_UNITS',
  'GOOGLE_CLIENT_ID', 'GOOGLE_CLIENT_SECRET', 'GOOGLE_REDIRECT_URI',
  'APPLE_USERNAME', 'APPLE_APP_SPECIFIC_PASSWORD', 'SYNC_INTERVAL_MINUTES',
];

const GOOGLE_DRIVE_KEYS = [
  'GOOGLE_DRIVE_CLIENT_ID',
  'GOOGLE_DRIVE_CLIENT_SECRET',
  'GOOGLE_DRIVE_REDIRECT_URI',
];

// Phase 5 ergänzt Reverse-Proxy-, OIDC- und Backup-Settings sowie APPLE_CALDAV_URL.
const P5_KEYS = [
  'APPLE_CALDAV_URL', 'SESSION_SECURE', 'TRUST_PROXY',
  'OIDC_ISSUER', 'OIDC_CLIENT_ID', 'OIDC_CLIENT_SECRET', 'OIDC_REDIRECT_URI',
  'BACKUP_ENABLED', 'BACKUP_SCHEDULE', 'BACKUP_KEEP',
];

const DOCUMENT_STORAGE_KEYS = [
  'DOCUMENT_STORAGE_WEBDAV_ENABLED',
  'DOCUMENT_STORAGE_WEBDAV_URL',
  'DOCUMENT_STORAGE_WEBDAV_USERNAME',
  'DOCUMENT_STORAGE_WEBDAV_PASSWORD',
  'DOCUMENT_STORAGE_WEBDAV_PATH',
];

const DOCUMENT_STORAGE_LOCAL_KEYS = [
  'DOCUMENT_STORAGE_LOCAL_ENABLED',
  'DOCUMENT_STORAGE_LOCAL_PATH',
];

const SUBSCRIPTION_KEYS = ['FIXER_API_KEY'];

// Laien-Wizard-Ausbau: BASE_URL (abgeleitet), SMTP für „Passwort vergessen",
// externe WebDAV-Backups und die Push-Kontaktadresse.
const EMAIL_KEYS = [
  'EMAIL_SMTP_HOST', 'EMAIL_SMTP_PORT', 'EMAIL_SMTP_SECURE',
  'EMAIL_SMTP_USER', 'EMAIL_SMTP_PASS', 'EMAIL_FROM_ADDRESS', 'EMAIL_FROM_NAME',
];

const WEBDAV_BACKUP_KEYS = [
  'WEBDAV_BACKUP_ENABLED', 'WEBDAV_BACKUP_URL', 'WEBDAV_BACKUP_USERNAME',
  'WEBDAV_BACKUP_PASSWORD', 'WEBDAV_BACKUP_PATH', 'WEBDAV_BACKUP_KEEP',
];

const WIZARD_EXTRA_KEYS = ['BASE_URL', 'VAPID_SUBJECT'];

const TOTAL_KEYS = ORIGINAL_KEYS.length + GOOGLE_DRIVE_KEYS.length + 2 + P5_KEYS.length
  + DOCUMENT_STORAGE_KEYS.length + DOCUMENT_STORAGE_LOCAL_KEYS.length
  + SUBSCRIPTION_KEYS.length + EMAIL_KEYS.length + WEBDAV_BACKUP_KEYS.length
  + WIZARD_EXTRA_KEYS.length; // + TZ + OIKOS_HTTP_PORT

test('ENV_SCHEMA enthält alle Original-Keys, TZ, OIKOS_HTTP_PORT, P5, Subscriptions und Dokument-WebDAV', () => {
  assert.equal(ENV_SCHEMA.length, TOTAL_KEYS);
  const keys = ENV_SCHEMA.map(e => e.key);
  for (const k of ORIGINAL_KEYS) {
    assert.ok(keys.includes(k), `Key fehlt: ${k}`);
  }
  for (const k of GOOGLE_DRIVE_KEYS) {
    assert.ok(keys.includes(k), `Google-Drive-Key fehlt: ${k}`);
  }
  assert.ok(keys.includes('TZ'), 'Key fehlt: TZ');
  assert.ok(keys.includes('OIKOS_HTTP_PORT'), 'Key fehlt: OIKOS_HTTP_PORT');
  for (const k of P5_KEYS) {
    assert.ok(keys.includes(k), `P5-Key fehlt: ${k}`);
  }
  for (const k of SUBSCRIPTION_KEYS) {
    assert.ok(keys.includes(k), `Subscription-Key fehlt: ${k}`);
  }
  for (const k of DOCUMENT_STORAGE_KEYS) {
    assert.ok(keys.includes(k), `Dokument-WebDAV-Key fehlt: ${k}`);
  }
  for (const k of DOCUMENT_STORAGE_LOCAL_KEYS) {
    assert.ok(keys.includes(k), `Dokument-Local-Key fehlt: ${k}`);
  }
  for (const k of [...EMAIL_KEYS, ...WEBDAV_BACKUP_KEYS, ...WIZARD_EXTRA_KEYS]) {
    assert.ok(keys.includes(k), `Wizard-Ausbau-Key fehlt: ${k}`);
  }
});

test('E-Mail/SMTP-Keys sind optional, das Passwort ist ein Secret', () => {
  for (const key of EMAIL_KEYS) {
    const entry = ENV_SCHEMA.find(e => e.key === key);
    assert.ok(entry, `${key} nicht in ENV_SCHEMA`);
    assert.equal(entry.writeToEnv, true, `${key}.writeToEnv ist nicht true`);
    assert.equal(entry.group, 'email', `${key} muss group 'email' haben`);
  }
  const pass = ENV_SCHEMA.find(e => e.key === 'EMAIL_SMTP_PASS');
  assert.equal(pass.secret, true, 'EMAIL_SMTP_PASS muss als Secret markiert sein');
  const secure = ENV_SCHEMA.find(e => e.key === 'EMAIL_SMTP_SECURE');
  assert.equal(secure.default, 'starttls', 'EMAIL_SMTP_SECURE-Default muss starttls sein');
});

test('WebDAV-Backup-Keys sind optional, standardmäßig deaktiviert, Passwort maskiert', () => {
  for (const key of WEBDAV_BACKUP_KEYS) {
    const entry = ENV_SCHEMA.find(e => e.key === key);
    assert.ok(entry, `${key} nicht in ENV_SCHEMA`);
    assert.equal(entry.writeToEnv, true, `${key}.writeToEnv ist nicht true`);
    assert.equal(entry.group, 'backup', `${key} muss group 'backup' haben`);
  }
  const enabled = ENV_SCHEMA.find(e => e.key === 'WEBDAV_BACKUP_ENABLED');
  assert.equal(enabled.default, 'false');
  const pass = ENV_SCHEMA.find(e => e.key === 'WEBDAV_BACKUP_PASSWORD');
  assert.equal(pass.secret, true, 'WEBDAV_BACKUP_PASSWORD muss als Secret markiert sein');
});

test('BASE_URL und VAPID_SUBJECT sind schreibbar mit leerem Default', () => {
  for (const key of WIZARD_EXTRA_KEYS) {
    const entry = ENV_SCHEMA.find(e => e.key === key);
    assert.ok(entry, `${key} nicht in ENV_SCHEMA`);
    assert.equal(entry.writeToEnv, true, `${key}.writeToEnv ist nicht true`);
    assert.equal(entry.default, '', `${key}-Default muss leer sein`);
  }
});

test('Lokaler Dokumentspeicher ist optional, standardmäßig deaktiviert und hat den Pfad-Default /documents', () => {
  for (const key of DOCUMENT_STORAGE_LOCAL_KEYS) {
    const entry = ENV_SCHEMA.find(e => e.key === key);
    assert.ok(entry, `${key} nicht in ENV_SCHEMA`);
    assert.equal(entry.required, false, `${key} muss optional sein`);
    assert.equal(entry.type, 'default', `${key} muss type 'default' haben`);
    assert.equal(entry.writeToEnv, true, `${key}.writeToEnv ist nicht true`);
  }
  const enabled = ENV_SCHEMA.find(e => e.key === 'DOCUMENT_STORAGE_LOCAL_ENABLED');
  assert.equal(enabled.default, 'false');
  const path = ENV_SCHEMA.find(e => e.key === 'DOCUMENT_STORAGE_LOCAL_PATH');
  assert.equal(path.default, '/documents');
});

test('Web-Installer zeigt, sammelt und sendet die lokalen Dokumentspeicher-Werte', () => {
  const src = readFileSync(new URL('../tools/installer/install.html', import.meta.url), 'utf8');
  for (const id of ['adv-document-local-enable', 'adv-document-local-path']) {
    assert.match(src, new RegExp(`id="${id}"`), `Web-Installer-Feld fehlt: ${id}`);
  }
  for (const key of DOCUMENT_STORAGE_LOCAL_KEYS) {
    assert.match(src, new RegExp(`${key}:\\s*S\\.${key}`), `Web-Installer sendet ${key} nicht`);
    assert.match(src, new RegExp(`${key}:\\s*''`), `Web-Installer-State fehlt ${key}`);
  }
});

test('CLI-Installer sammelt und schreibt die lokalen Dokumentspeicher-Werte', () => {
  const src = readFileSync(new URL('../install.sh', import.meta.url), 'utf8');
  for (const key of DOCUMENT_STORAGE_LOCAL_KEYS) {
    assert.match(src, new RegExp(`^${key}=`, 'm'), `CLI-Installer schreibt ${key} nicht in .env`);
  }
});

test('.env.example dokumentiert die lokalen Dokumentspeicher-Werte', () => {
  const src = readFileSync(new URL('../.env.example', import.meta.url), 'utf8');
  for (const key of DOCUMENT_STORAGE_LOCAL_KEYS) {
    assert.match(src, new RegExp(`^#?\\s*${key}=`, 'm'), `.env.example fehlt ${key}`);
  }
});

test('Unraid deklariert die lokalen Dokumentspeicher-Werte advanced und optional', () => {
  const src = readFileSync(new URL('../templates/yuvomi.xml', import.meta.url), 'utf8');
  for (const key of DOCUMENT_STORAGE_LOCAL_KEYS) {
    const config = src.match(new RegExp(`<Config[^>]+Target="${key}"[^>]*>`));
    assert.ok(config, `Unraid fehlt ${key}`);
    assert.match(config[0], /Display="advanced"/, `${key} muss advanced sein`);
    assert.match(config[0], /Required="false"/, `${key} muss optional sein`);
  }
});

test('Portainer Compose reicht die lokalen Dokumentspeicher-Werte durch', () => {
  const src = readFileSync(new URL('../docs/docker-compose.portainer.yml', import.meta.url), 'utf8');
  for (const key of DOCUMENT_STORAGE_LOCAL_KEYS) {
    assert.match(
      src,
      new RegExp(`- ${key}=\\$\\{${key}:-`),
      `Portainer Compose fehlt ${key}`
    );
  }
});

test('Lokale Dokumentspeicher-Werte erzeugen keine TrueNAS- oder Umbrel-Fragen', () => {
  for (const path of [
    '../deploy/truenas/questions.yaml',
    '../deploy/truenas/templates/docker-compose.yaml',
    '../deploy/umbrel/docker-compose.yml',
    '../deploy/umbrel/umbrel-app.yml',
  ]) {
    const src = readFileSync(new URL(path, import.meta.url), 'utf8');
    for (const key of DOCUMENT_STORAGE_LOCAL_KEYS) {
      assert.doesNotMatch(src, new RegExp(key), `${path} darf ${key} nicht explizit deklarieren`);
    }
  }
});

test('TZ und OIKOS_HTTP_PORT haben writeToEnv: true', () => {
  for (const key of ['TZ', 'OIKOS_HTTP_PORT']) {
    const entry = ENV_SCHEMA.find(e => e.key === key);
    assert.ok(entry, `${key} nicht in ENV_SCHEMA`);
    assert.equal(entry.writeToEnv, true, `${key}.writeToEnv ist nicht true`);
  }
});

test('Dokument-WebDAV ist optional, standardmäßig deaktiviert und maskiert das Passwort', () => {
  for (const key of DOCUMENT_STORAGE_KEYS) {
    const entry = ENV_SCHEMA.find(e => e.key === key);
    assert.ok(entry, `${key} nicht in ENV_SCHEMA`);
    assert.equal(entry.required, false, `${key} muss optional sein`);
    assert.equal(entry.writeToEnv, true, `${key}.writeToEnv ist nicht true`);
  }

  const enabled = ENV_SCHEMA.find(e => e.key === 'DOCUMENT_STORAGE_WEBDAV_ENABLED');
  assert.equal(enabled.type, 'default');
  assert.equal(enabled.default, 'false');

  const password = ENV_SCHEMA.find(e => e.key === 'DOCUMENT_STORAGE_WEBDAV_PASSWORD');
  assert.equal(password.secret, true, 'WebDAV-Passwort muss als Secret markiert sein');
});

test('Google Drive OAuth installer wiring is optional, masked, validated and deployed consistently', () => {
  for (const key of GOOGLE_DRIVE_KEYS) {
    const entry = ENV_SCHEMA.find((item) => item.key === key);
    assert.ok(entry, `${key} missing from ENV_SCHEMA`);
    assert.equal(entry.required, false);
    assert.equal(entry.writeToEnv, true);
    assert.equal(entry.group, 'googleDrive');
  }
  assert.equal(
    ENV_SCHEMA.find((item) => item.key === 'GOOGLE_DRIVE_CLIENT_SECRET').secret,
    true
  );

  const web = readFileSync(new URL('../tools/installer/install.html', import.meta.url), 'utf8');
  for (const id of [
    'adv-document-google-drive-enable',
    'adv-document-google-drive-client-id',
    'adv-document-google-drive-client-secret',
    'document-google-drive-redirect-hint',
    'rv-document-google-drive',
  ]) assert.match(web, new RegExp(`id="${id}"`), `web installer missing ${id}`);
  for (const key of GOOGLE_DRIVE_KEYS) {
    assert.match(web, new RegExp(`${key}:\\s*S\\.${key}`));
    assert.match(web, new RegExp(`${key}:\\s*''`));
  }
  assert.match(web, /errDocumentGoogleDrivePair/);
  assert.match(web, /errDocumentGoogleDriveCredentials/);
  assert.match(web, /\/api\/v1\/documents\/storage\/google-drive\/callback/);

  const cli = readFileSync(new URL('../install.sh', import.meta.url), 'utf8');
  for (const key of GOOGLE_DRIVE_KEYS) assert.match(cli, new RegExp(`^${key}=`, 'm'));
  assert.match(cli, /read -rs GOOGLE_DRIVE_CLIENT_SECRET/);
  assert.match(cli, /document_google_drive\.err_pair/);

  const envExample = readFileSync(new URL('../.env.example', import.meta.url), 'utf8');
  const portainer = readFileSync(new URL('../docs/docker-compose.portainer.yml', import.meta.url), 'utf8');
  const unraid = readFileSync(new URL('../templates/yuvomi.xml', import.meta.url), 'utf8');
  for (const key of GOOGLE_DRIVE_KEYS) {
    assert.match(envExample, new RegExp(`^${key}=`, 'm'));
    assert.match(portainer, new RegExp(`- ${key}=\\$\\{${key}:-`));
    assert.match(unraid, new RegExp(`Target="${key}"`));
  }
  assert.match(
    unraid.match(/<Config[^>]+Target="GOOGLE_DRIVE_CLIENT_SECRET"[^>]*>/)[0],
    /Mask="true"/
  );
  for (const deployment of [
    '../deploy/truenas/questions.yaml',
    '../deploy/truenas/templates/docker-compose.yaml',
    '../deploy/umbrel/docker-compose.yml',
    '../deploy/umbrel/umbrel-app.yml',
  ]) {
    const source = readFileSync(new URL(deployment, import.meta.url), 'utf8');
    for (const key of GOOGLE_DRIVE_KEYS) assert.doesNotMatch(source, new RegExp(key));
  }
});

test('FIXER_API_KEY ist optional und als Secret markiert', () => {
  const fixer = ENV_SCHEMA.find(e => e.key === 'FIXER_API_KEY');
  assert.ok(fixer, 'FIXER_API_KEY nicht in ENV_SCHEMA');
  assert.equal(fixer.required, false);
  assert.equal(fixer.writeToEnv, true);
  assert.equal(fixer.secret, true);
});

test('Alle Schema-Einträge haben die Pflichtfelder key, type, label, group, writeToEnv', () => {
  for (const entry of ENV_SCHEMA) {
    assert.ok(typeof entry.key === 'string' && entry.key, `key fehlt oder leer`);
    assert.ok(typeof entry.type === 'string' && entry.type, `type fehlt für ${entry.key}`);
    assert.ok(typeof entry.label === 'string' && entry.label, `label fehlt für ${entry.key}`);
    assert.ok(typeof entry.group === 'string' && entry.group, `group fehlt für ${entry.key}`);
    assert.equal(entry.writeToEnv, true, `writeToEnv !== true für ${entry.key}`);
  }
});

test('Schema-Datei enthält genau so viele key-Felder wie Schema-Einträge (grep-Parität)', () => {
  const src = readFileSync(new URL('../tools/installer/env-schema.js', import.meta.url), 'utf8');
  const matches = src.match(/\bkey:/g);
  assert.equal(matches?.length ?? 0, TOTAL_KEYS, `Anzahl "key:"-Vorkommen in env-schema.js stimmt nicht mit ${TOTAL_KEYS} überein`);
});

test('/api/defaults-Route in install-server.js liefert ENV_SCHEMA (Snapshot)', () => {
  const src = readFileSync(new URL('../tools/installer/install-server.js', import.meta.url), 'utf8');
  assert.ok(src.includes("import { ENV_SCHEMA }"), 'install-server.js importiert ENV_SCHEMA nicht');
  assert.ok(src.includes('catalog: ENV_SCHEMA'), '/api/defaults gibt ENV_SCHEMA nicht unter dem Schlüssel "catalog" zurück');
});

// ── Phase 1: Zeitzone und Port wirken ───────────────────────────────────────

test('install.html nimmt TZ und OIKOS_HTTP_PORT ins gesendete env-Objekt auf', () => {
  const src = readFileSync(new URL('../tools/installer/install.html', import.meta.url), 'utf8');
  assert.match(src, /TZ:\s*S\.tz/, 'install.html sendet TZ nicht im env-Objekt');
  assert.match(src, /OIKOS_HTTP_PORT:\s*S\.port/, 'install.html sendet OIKOS_HTTP_PORT nicht im env-Objekt');
});

test('Web-Installer zeigt, sammelt und sendet alle Dokument-WebDAV-Werte', () => {
  const src = readFileSync(new URL('../tools/installer/install.html', import.meta.url), 'utf8');
  for (const id of [
    'adv-document-webdav-enable',
    'adv-document-webdav-url',
    'adv-document-webdav-username',
    'adv-document-webdav-password',
    'adv-document-webdav-path',
  ]) {
    assert.match(src, new RegExp(`id="${id}"`), `Web-Installer-Feld fehlt: ${id}`);
  }
  assert.match(
    src,
    /id="adv-document-webdav-password"[^>]*type="password"|type="password"[^>]*id="adv-document-webdav-password"/,
    'WebDAV-Passwortfeld muss maskiert sein'
  );
  for (const key of DOCUMENT_STORAGE_KEYS) {
    assert.match(src, new RegExp(`${key}:\\s*S\\.${key}`), `Web-Installer sendet ${key} nicht`);
    assert.match(src, new RegExp(`${key}:\\s*''`), `Web-Installer-State fehlt ${key}`);
  }
});

test('CLI-Installer sammelt und schreibt alle Dokument-WebDAV-Werte', () => {
  const src = readFileSync(new URL('../install.sh', import.meta.url), 'utf8');
  assert.match(src, /configure_document_storage\b/, 'CLI-Installer konfiguriert Dokument-WebDAV nicht');
  for (const key of DOCUMENT_STORAGE_KEYS) {
    assert.match(src, new RegExp(`^${key}=`, 'm'), `CLI-Installer schreibt ${key} nicht in .env`);
  }
  assert.match(
    src,
    /read -rs DOCUMENT_STORAGE_WEBDAV_PASSWORD/,
    'CLI-Installer muss das WebDAV-Passwort verdeckt einlesen'
  );
});

test('docker-compose.yml mappt den Host-Port über OIKOS_HTTP_PORT mit Default 3000', () => {
  const src = readFileSync(new URL('../docker-compose.yml', import.meta.url), 'utf8');
  assert.match(
    src,
    /\$\{OIKOS_HTTP_PORT:-3000\}:3000/,
    'Port-Mapping nutzt OIKOS_HTTP_PORT nicht mit Default :-3000 (Container-Port muss 3000 bleiben)'
  );
  assert.doesNotMatch(
    src,
    /^\s*-\s*"0\.0\.0\.0:3000:3000"/m,
    'Hartkodiertes Port-Mapping 3000:3000 darf nicht mehr vorhanden sein'
  );
});

test('install.sh schreibt TZ und OIKOS_HTTP_PORT in die generierte .env', () => {
  const src = readFileSync(new URL('../install.sh', import.meta.url), 'utf8');
  assert.match(src, /^TZ=\$\{YUVOMI_TZ\}/m, 'install.sh schreibt TZ=${YUVOMI_TZ} nicht in den .env-Block');
  assert.match(src, /^OIKOS_HTTP_PORT=\$\{YUVOMI_PORT\}/m, 'install.sh schreibt OIKOS_HTTP_PORT=${YUVOMI_PORT} nicht in den .env-Block');
});

test('.env.example dokumentiert OIKOS_HTTP_PORT', () => {
  const src = readFileSync(new URL('../.env.example', import.meta.url), 'utf8');
  assert.match(src, /OIKOS_HTTP_PORT/, '.env.example dokumentiert OIKOS_HTTP_PORT nicht');
});

test('.env.example dokumentiert alle optionalen Dokument-WebDAV-Werte', () => {
  const src = readFileSync(new URL('../.env.example', import.meta.url), 'utf8');
  for (const key of DOCUMENT_STORAGE_KEYS) {
    assert.match(src, new RegExp(`^#?\\s*${key}=`, 'm'), `.env.example fehlt ${key}`);
  }
});

test('Unraid deklariert alle Dokument-WebDAV-Werte advanced und maskiert das Passwort', () => {
  const src = readFileSync(new URL('../templates/yuvomi.xml', import.meta.url), 'utf8');
  for (const key of DOCUMENT_STORAGE_KEYS) {
    const config = src.match(new RegExp(`<Config[^>]+Target="${key}"[^>]*>`));
    assert.ok(config, `Unraid fehlt ${key}`);
    assert.match(config[0], /Display="advanced"/, `${key} muss advanced sein`);
    assert.match(config[0], /Required="false"/, `${key} muss optional sein`);
  }
  const password = src.match(/<Config[^>]+Target="DOCUMENT_STORAGE_WEBDAV_PASSWORD"[^>]*>/);
  assert.match(password[0], /Mask="true"/, 'Unraid muss WebDAV-Passwort maskieren');
});

test('Portainer Compose reicht alle explizit aufgezählten Dokument-WebDAV-Werte durch', () => {
  const src = readFileSync(new URL('../docs/docker-compose.portainer.yml', import.meta.url), 'utf8');
  for (const key of DOCUMENT_STORAGE_KEYS) {
    assert.match(
      src,
      new RegExp(`- ${key}=\\$\\{${key}:-`),
      `Portainer Compose fehlt ${key}`
    );
  }
});

test('Optionale Dokument-WebDAV-Werte erzeugen keine TrueNAS- oder Umbrel-Fragen', () => {
  for (const path of [
    '../deploy/truenas/questions.yaml',
    '../deploy/truenas/templates/docker-compose.yaml',
    '../deploy/umbrel/docker-compose.yml',
    '../deploy/umbrel/umbrel-app.yml',
  ]) {
    const src = readFileSync(new URL(path, import.meta.url), 'utf8');
    for (const key of DOCUMENT_STORAGE_KEYS) {
      assert.doesNotMatch(src, new RegExp(key), `${path} darf ${key} nicht explizit deklarieren`);
    }
  }
});
