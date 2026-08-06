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

// Die Lücken, die der Critique vom 2026-08-02 aufgedeckt hat: alles Altbestand
// aus März bis Juli, den nie jemand entschieden hat. Zwei Host-Mounts (ohne die
// Uploads bzw. die Datenbank am falschen Ort landen), zwei SSRF-Opt-ins (ohne
// die der häufigste Self-Hoster-Fall stumm scheitert) und ein OIDC-Schalter.
const COMPLETENESS_KEYS = [
  'DATA_DIR',
  'DOCUMENT_STORAGE_LOCAL_DIR',
  'DOCUMENT_STORAGE_WEBDAV_ALLOW_PRIVATE_NETWORK',
  'ICS_SUBSCRIPTION_ALLOW_PRIVATE_NETWORK',
  'RECIPE_PROVIDER_ALLOW_PRIVATE_NETWORK',
  'OIDC_TRUST_EMAIL_WITHOUT_VERIFIED_CLAIM',
];

const TOTAL_KEYS = ORIGINAL_KEYS.length + GOOGLE_DRIVE_KEYS.length + 2 + P5_KEYS.length
  + DOCUMENT_STORAGE_KEYS.length + DOCUMENT_STORAGE_LOCAL_KEYS.length
  + SUBSCRIPTION_KEYS.length + EMAIL_KEYS.length + WEBDAV_BACKUP_KEYS.length
  + WIZARD_EXTRA_KEYS.length + COMPLETENESS_KEYS.length; // + TZ + OIKOS_HTTP_PORT

// ── Regel-Guard: .env.example ⇄ ENV_SCHEMA ⇄ gesendetes env-Objekt ───────────
//
// Diese Prüfrichtung fehlte vollständig. Nichts im Repo fragte, ob eine neu
// dokumentierte Variable im Installer überhaupt ankommt, und so drifteten 21
// Keys über Monate unbemerkt. `TOTAL_KEYS` konnte das nie fangen: die Zahl
// wächst mit dem Schema mit und wird nie gegen die Aussenwelt geprüft. Ein
// Guard über eine Liste deckt eine Liste ab, kein Guard über eine Regel.
//
// Die Regel: jede in .env.example dokumentierte Variable steht entweder im
// ENV_SCHEMA oder mit Begründung in der Karte unten. Eine neue Variable
// erzwingt damit eine Entscheidung, statt still zu driften.

const INTENTIONALLY_NOT_IN_INSTALLER = {
  // Setzt jeder Container-Descriptor selbst; im Installer wäre der Wert eine
  // zweite Wahrheit, die der Descriptor überschreibt.
  NODE_ENV: 'Vom Image gesetzt (production).',
  PORT: 'Container-interner Port, überall fest 3000. Der Host-Port ist OIKOS_HTTP_PORT.',
  DB_PATH: 'Vom Descriptor auf /data/yuvomi.db gesetzt.',
  BACKUP_DIR: 'Vom Image auf /backups gesetzt; hat wegen der Doppelrolle Host-Pfad gegen Container-Env einen eigenen Guard (#579).',
  MODULES_DIR: 'Compose-Host-Pfad für Dritt-Modul-Drop-ins (MODULES.md). Der Default ./modules ist für jede vom Wizard erzeugte Installation richtig; wer Module nutzt, ändert bewusst die Compose-Ebene.',
  OIKOS_HTTP_BIND: 'Bindungsadresse für rootless Podman hinter Proxy. Ein falscher Wert macht die App unerreichbar, und der Default ist für jede vom Wizard erzeugte Installation richtig.',

  // Werden zur Laufzeit erzeugt und in der Datenbank abgelegt.
  VAPID_PUBLIC_KEY: 'Wird bei Erstnutzung automatisch erzeugt; nur VAPID_SUBJECT ist konfigurierbar.',
  VAPID_PRIVATE_KEY: 'Wird bei Erstnutzung automatisch erzeugt.',

  // Legacy: der Wetter-Default ist seit 2026-06-07 Open-Meteo ohne Schlüssel,
  // und der Provider ist in der App-UI nicht mehr wählbar.
  OPENWEATHER_API_KEY: 'Legacy-Wetterprovider; Default ist Open-Meteo ohne Schlüssel.',
  OPENWEATHER_CITY: 'Legacy-Wetterprovider.',
  OPENWEATHER_UNITS: 'Legacy-Wetterprovider.',
  OPENWEATHER_LANG: 'Legacy-Wetterprovider.',

  // Betriebs-Feinjustage, keine Installationsentscheidung.
  LOG_LEVEL: 'Betriebs-Feinjustage.',
  ENABLE_API_DOCS: 'Betriebs-Feinjustage.',
  MCP_INTERNAL_BASE_URL: 'Betriebs-Feinjustage.',
  RATE_LIMIT_WINDOW_MS: 'Betriebs-Feinjustage.',
  RATE_LIMIT_MAX_ATTEMPTS: 'Betriebs-Feinjustage.',
};

/** Alle in .env.example dokumentierten Variablennamen, auch die auskommentierten. */
function documentedKeys() {
  const src = readFileSync(new URL('../.env.example', import.meta.url), 'utf8');
  // Mindestens zwei Zeichen, damit auch TZ mitgezählt wird.
  return [...new Set([...src.matchAll(/^#?\s*([A-Z][A-Z0-9_]+)=/gm)].map(m => m[1]))].sort();
}

/** Die Keys, die install.html tatsächlich an /api/save-env sendet. */
function sentKeys() {
  const src = readFileSync(new URL('../tools/installer/install.html', import.meta.url), 'utf8');
  const fn = src.match(/function buildEnv\(\)\s*\{\s*return\s*\{([\s\S]*?)\n\s*\};/);
  assert.ok(fn, 'buildEnv() in install.html nicht gefunden');
  return new Set([...fn[1].matchAll(/(?:^|[\s,{])([A-Z][A-Z0-9_]*)\s*:/g)].map(m => m[1]));
}

test('jede in .env.example dokumentierte Variable ist im Installer oder bewusst ausgenommen', () => {
  const schema = new Set(ENV_SCHEMA.map(e => e.key));
  const undecided = documentedKeys().filter(
    key => !schema.has(key) && !(key in INTENTIONALLY_NOT_IN_INSTALLER)
  );
  assert.deepEqual(undecided, [],
    'Diese Variablen stehen in .env.example, aber weder im ENV_SCHEMA noch in '
    + 'INTENTIONALLY_NOT_IN_INSTALLER. Entscheide bewusst: ins Schema aufnehmen '
    + `oder mit Begründung ausnehmen. Offen: ${undecided.join(', ')}`);
});

test('die Ausnahmekarte enthält keine Karteileichen und jede Ausnahme trägt eine Begründung', () => {
  // Eine Ausnahme für eine Variable, die es nicht mehr gibt, ist ein Loch: sie
  // deckt später stillschweigend einen wiederverwendeten Namen.
  const documented = new Set(documentedKeys());
  const schema = new Set(ENV_SCHEMA.map(e => e.key));
  for (const [key, reason] of Object.entries(INTENTIONALLY_NOT_IN_INSTALLER)) {
    assert.ok(documented.has(key), `${key} ist ausgenommen, steht aber nicht (mehr) in .env.example`);
    assert.ok(!schema.has(key), `${key} ist ausgenommen und steht trotzdem im ENV_SCHEMA`);
    assert.ok(typeof reason === 'string' && reason.length > 15, `${key} braucht eine echte Begründung`);
  }
});

// ── Regel-Guard: ENV_SCHEMA ⇄ Portainer-Compose ─────────────────────────────
//
// Dieselbe Klasse Drift wie oben, nur ein Ziel weiter. Portainer zählt jede
// Variable von Hand auf und hat kein `env_file`: was hier nicht steht, kann ein
// Portainer-Nutzer überhaupt nicht setzen. So fehlten 28 von 55 Schema-Keys -
// darunter OIDC_* komplett, alle WEBDAV_BACKUP_* und BASE_URL, ohne das keine
// einzige Passwort-Reset-Mail rausgeht.
//
// Die bestehenden Portainer-Tests prüfen je eine Feature-Gruppe (Google Drive,
// Dokument-WebDAV, lokaler Speicher). Eine Gruppe, an die niemand denkt, prüft
// auch niemand. Dieser Guard dreht das um: er geht vom Schema aus, nicht von
// einer Liste, und zwingt bei jedem neuen Key eine Entscheidung.

const NOT_IN_PORTAINER = {
  DATA_DIR:
    'Host-Pfad für einen Bind-Mount. Portainer nutzt das benannte Volume oikos_data '
    + '(Legacy-Slug, damit bestehende Stacks an Ort und Stelle aktualisieren statt ihre '
    + 'Daten zu verwaisen). Als Env durchgereicht wäre der Wert wirkungslos und irreführend.',
  OIKOS_HTTP_PORT:
    'Host-Port, keine App-Variable: die App im Container hört immer auf 3000. '
    + 'Steht deshalb im ports-Mapping (${OIKOS_HTTP_PORT:-3000}:3000), nicht unter environment.',
  DOCUMENT_STORAGE_LOCAL_DIR:
    'Host-Ordner des optionalen Dokument-Mounts. Steht im volumes-Block als Bind-Quelle '
    + '(dort auskommentiert), nicht unter environment - die App liest den Container-Pfad '
    + 'DOCUMENT_STORAGE_LOCAL_PATH.',
};

function portainerSource() {
  return readFileSync(new URL('../docs/docker-compose.portainer.yml', import.meta.url), 'utf8');
}

test('jeder Schema-Key erreicht die Portainer-Compose oder ist begründet ausgenommen', () => {
  const src = portainerSource();
  const missing = ENV_SCHEMA
    .map(e => e.key)
    .filter(key => !new RegExp(`^\\s+- "?${key}=`, 'm').test(src) && !(key in NOT_IN_PORTAINER));
  assert.deepEqual(missing, [],
    'Diese Schema-Keys kommen bei einem Portainer-Deployment nie an. Entweder unter '
    + `environment aufnehmen oder mit Begründung in NOT_IN_PORTAINER: ${missing.join(', ')}`);
});

test('die Portainer-Ausnahmekarte trägt keine Karteileichen', () => {
  const schema = new Set(ENV_SCHEMA.map(e => e.key));
  const src = portainerSource();
  for (const [key, reason] of Object.entries(NOT_IN_PORTAINER)) {
    assert.ok(schema.has(key), `${key} ist ausgenommen, steht aber nicht (mehr) im ENV_SCHEMA`);
    assert.ok(typeof reason === 'string' && reason.length > 40, `${key} braucht eine echte Begründung`);
    assert.doesNotMatch(src, new RegExp(`^\\s+- "?${key}=`, 'm'),
      `${key} ist als Ausnahme geführt und steht trotzdem unter environment`);
  }
  // Die beiden Ausnahmen, die an anderer Stelle der Datei landen, müssen dort
  // auch wirklich stehen - sonst deckt die Begründung ein echtes Loch.
  assert.match(src, /\$\{OIKOS_HTTP_PORT:-3000\}:3000/,
    'OIKOS_HTTP_PORT ist als "steht im ports-Mapping" ausgenommen, fehlt dort aber');
  assert.match(src, /\$\{DOCUMENT_STORAGE_LOCAL_DIR:-/,
    'DOCUMENT_STORAGE_LOCAL_DIR ist als "steht im volumes-Block" ausgenommen, fehlt dort aber');
});

test('BASE_URL steht in jedem Deploy-Ziel, das Variablen von Hand aufzählt', () => {
  // Ohne BASE_URL versendet der Server keine Passwort-Reset-Links (der
  // Request-Host-Header wird bewusst nicht vertraut, gegen Reset-Poisoning).
  // Das Ergebnis ist eine Funktion, die stumm nichts tut.
  assert.match(portainerSource(), /^\s+- BASE_URL=\$\{BASE_URL:-\}/m,
    'Portainer-Compose reicht BASE_URL nicht durch');
  const unraid = readFileSync(new URL('../templates/yuvomi.xml', import.meta.url), 'utf8');
  assert.match(unraid, /Target="BASE_URL"/, 'Unraid deklariert BASE_URL nicht');
});

test('jeder Schema-Key ist in .env.example dokumentiert', () => {
  // Die Gegenrichtung: was der Installer schreibt, muss auffindbar sein. Sonst
  // steht der Wert in der .env und niemand weiss, wofür.
  const documented = new Set(documentedKeys());
  const undocumented = ENV_SCHEMA.map(e => e.key).filter(key => !documented.has(key));
  assert.deepEqual(undocumented, [], `Nicht in .env.example dokumentiert: ${undocumented.join(', ')}`);
});

test('jeder Schema-Key landet auch im gesendeten env-Objekt', () => {
  // Genau hier fiel WEBDAV_BACKUP_KEEP durch: seit Monaten im Schema, mit
  // Default '7', null Vorkommen in install.html - der Default war Fiktion.
  const sent = sentKeys();
  const missing = ENV_SCHEMA.filter(e => e.writeToEnv).map(e => e.key).filter(key => !sent.has(key));
  assert.deepEqual(missing, [],
    `Im ENV_SCHEMA, aber von install.html nie gesendet: ${missing.join(', ')}`);
});

test('das gesendete env-Objekt erfindet keine Keys ausserhalb des Schemas', () => {
  const schema = new Set(ENV_SCHEMA.map(e => e.key));
  const extra = [...sentKeys()].filter(key => !schema.has(key));
  assert.deepEqual(extra, [],
    `install.html sendet Keys ohne Schema-Eintrag (sanitizeEnv wirft sie weg): ${extra.join(', ')}`);
});

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

test('Jedes Container-Deployment schreibt Backups nach /backups (issue #579)', () => {
  // Ohne BACKUP_DIR fällt die App auf ihren Bare-Metal-Default './backups' zurück,
  // also /app/backups im Container - ausserhalb des gemounteten Volumes und für den
  // node-User nicht anlegbar. Das Image setzt den Default deshalb selbst, und jeder
  // Descriptor mit einem /backups-Mount muss die Variable passend belegen.
  const dockerfile = readFileSync(new URL('../Dockerfile', import.meta.url), 'utf8');
  assert.match(
    dockerfile,
    /^ENV BACKUP_DIR=\/backups$/m,
    'Dockerfile muss BACKUP_DIR=/backups als Image-Default setzen'
  );

  for (const path of [
    '../docker-compose.yml',
    '../podman-compose.yml',
    '../docs/docker-compose.portainer.yml',
    '../deploy/umbrel/docker-compose.yml',
  ]) {
    const src = readFileSync(new URL(path, import.meta.url), 'utf8');
    assert.match(src, /:\/backups(:Z)?$/m, `${path} mountet kein /backups`);
    assert.match(src, /- BACKUP_DIR=\/backups$/m, `${path} setzt BACKUP_DIR nicht auf /backups`);
  }

  const truenas = readFileSync(
    new URL('../deploy/truenas/templates/docker-compose.yaml', import.meta.url),
    'utf8'
  );
  assert.match(truenas, /add_env\("BACKUP_DIR", "\/backups"\)/, 'TrueNAS setzt BACKUP_DIR nicht');

  const quadlet = readFileSync(new URL('../tools/quadlet/oikos.container', import.meta.url), 'utf8');
  assert.match(quadlet, /^Environment=BACKUP_DIR=\/backups$/m, 'Quadlet setzt BACKUP_DIR nicht');

  const unraid = readFileSync(new URL('../templates/yuvomi.xml', import.meta.url), 'utf8');
  const backupVar = unraid.match(/<Config[^>]+Target="BACKUP_DIR"[^>]*>[^<]*/);
  assert.ok(backupVar, 'Unraid deklariert BACKUP_DIR nicht');
  assert.match(backupVar[0], /Default="\/backups"/, 'Unraid BACKUP_DIR muss /backups defaulten');
  assert.match(unraid, /Target="\/backups"[^>]+Type="Path"/, 'Unraid mountet kein /backups');
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

test('Unraid deklariert alle Web-Push-Variablen advanced und maskiert den privaten Schluessel', () => {
  // Unraid zaehlt jede Variable von Hand auf und hat keinen Fallback: fehlt ein
  // Eintrag, koennen Unraid-Nutzer die Variable ueberhaupt nicht setzen. Genau
  // daran scheiterte Push auf iOS - das Subject war nirgends erreichbar (#580).
  const unraid = readFileSync(new URL('../templates/yuvomi.xml', import.meta.url), 'utf8');
  const envExample = readFileSync(new URL('../.env.example', import.meta.url), 'utf8');

  for (const key of ['VAPID_SUBJECT', 'VAPID_PUBLIC_KEY', 'VAPID_PRIVATE_KEY']) {
    const entry = unraid.match(new RegExp(`<Config[^>]+Target="${key}"[^>]*>`));
    assert.ok(entry, `${key} fehlt in templates/yuvomi.xml`);
    assert.match(entry[0], /Display="advanced"/, `${key} sollte advanced sein`);
    assert.match(entry[0], /Required="false"/, `${key} ist optional`);
    assert.match(envExample, new RegExp(`^# ?${key}=`, 'm'), `${key} fehlt in .env.example`);
  }

  assert.match(
    unraid.match(/<Config[^>]+Target="VAPID_PRIVATE_KEY"[^>]*>/)[0],
    /Mask="true"/,
    'der private VAPID-Schluessel muss maskiert sein'
  );
  assert.match(
    unraid.match(/<Config[^>]+Target="VAPID_SUBJECT"[^>]*>/)[0],
    /BadJwtToken/,
    'die Apple-Falle gehoert in die Beschreibung, sonst setzt sie niemand'
  );
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

// ── Regel-Guard: kein Deploy-Default sperrt ein UI-Feld ──────────────────────
//
// Die SMTP-Felder sind seit dem Critique env-gesteuert: steht die Variable in
// der Umgebung, gewinnt sie, wird NICHT in die Datenbank geschrieben und ist in
// Settings > Administration gesperrt. Die Sperre gilt pro Feld.
//
// Damit wird ein harmlos aussehender Compose-Default zur Falle: ein
// `EMAIL_SMTP_PORT=${EMAIL_SMTP_PORT:-587}` setzt die Variable für JEDEN
// Portainer-Nutzer auf einen nicht-leeren Wert - auch für den, der SMTP nie
// angefasst hat. Port und Verschlüsselung sind dann dauerhaft gesperrt, und wer
// einen Anbieter auf 465/SSL nutzt, kann ihn über die UI gar nicht einstellen.
// Genau das war beim Ergänzen der fehlenden Portainer-Keys passiert.
//
// Die Regel: eine env-Variable, die ein UI-Feld sperrt, darf im Descriptor nur
// mit LEEREM Default stehen. Der Server bringt seine eigenen Defaults mit.

/** Die env-Namen, an denen eine UI-Sperre hängt - aus der Quelle gelesen, nicht abgeschrieben. */
function uiLockingEnvKeys() {
  const email = readFileSync(new URL('../server/services/email.js', import.meta.url), 'utf8');
  const block = email.match(/const CONFIG_KEYS = \{([\s\S]*?)\n\};/);
  assert.ok(block, 'CONFIG_KEYS in server/services/email.js nicht gefunden');
  const keys = [...block[1].matchAll(/env:\s*'([A-Z_]+)'/g)].map(m => m[1]);
  assert.ok(keys.length >= 7, `erwartete die SMTP-Felder, fand ${keys.length}`);

  // backup-webdav sperrt seine UI an genau einer Variable (envControlled: Boolean(ENV_URL)).
  const backup = readFileSync(new URL('../server/services/backup-webdav.js', import.meta.url), 'utf8');
  if (/envControlled:\s*Boolean\(ENV_URL\)/.test(backup)) keys.push('WEBDAV_BACKUP_URL');
  return keys;
}

test('kein Deploy-Descriptor gibt einem UI-sperrenden Schlüssel einen nicht-leeren Default', () => {
  // Repo-relativ gehalten, damit derselbe String die Datei findet UND in der
  // Fehlermeldung stehen kann. Ein nachträgliches Abschneiden von '../' wäre
  // eine Textersetzung, die nur das erste Vorkommen trifft (CodeQL-Regel
  // "Incomplete string escaping or encoding") - hier unnötig, weil der Präfix
  // ohnehin nur beim Lesen gebraucht wird.
  const descriptors = [
    'docs/docker-compose.portainer.yml',
    'docker-compose.yml',
    'podman-compose.yml',
    'deploy/umbrel/docker-compose.yml',
  ];
  const offenders = [];

  for (const key of uiLockingEnvKeys()) {
    for (const path of descriptors) {
      const src = readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');
      // ${KEY:-<default>} - alles ausser sofort schliessender Klammer ist ein Wert.
      for (const m of src.matchAll(new RegExp(`\\$\\{${key}:-([^}]*)\\}`, 'g'))) {
        if (m[1].trim() === '') continue;
        offenders.push(`${path}: ${key} defaultet auf "${m[1]}"`);
      }
    }
  }

  assert.deepEqual(offenders, [],
    'Diese Defaults setzen eine env-Variable, die ein UI-Feld sperrt - der Nutzer kann das '
    + `Feld danach in den Einstellungen nicht mehr ändern:\n${offenders.join('\n')}`);
});

test('der Dokument-Mount zielt auf DOCUMENT_STORAGE_LOCAL_PATH, nie auf einen festen Pfad', () => {
  // DOCUMENT_STORAGE_LOCAL_DIR wurde eingeführt, damit Host-Ordner und
  // Container-Pfad nicht auseinanderlaufen. Die Compose-Dateien mounteten aber
  // weiter auf das LITERALE /documents, während die App nach
  // DOCUMENT_STORAGE_LOCAL_PATH schreibt. Wer diesen Pfad ändert, schreibt
  // seine Uploads damit ins Container-Overlay - beim nächsten
  // `pull && up -d` weg, die Verweise in der Datenbank bleiben. Also genau der
  // Schaden, den die Variable laut ihrem eigenen Kommentar verhindert.
  const offenders = [];
  for (const path of ['docker-compose.yml', 'podman-compose.yml', 'docs/docker-compose.portainer.yml']) {
    const src = readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');
    for (const [line] of src.matchAll(/^.*\$\{DOCUMENT_STORAGE_LOCAL_DIR[^\n]*$/gm)) {
      if (!/:\$\{DOCUMENT_STORAGE_LOCAL_PATH:-\/documents\}/.test(line)) {
        offenders.push(`${path}: ${line.trim()}`);
      }
    }
  }
  assert.deepEqual(offenders, [],
    'Der Host-Ordner wird auf ein festes Ziel gemountet, während die App den konfigurierten '
    + `Pfad benutzt:\n${offenders.join('\n')}`);
});
