/**
 * Test: Third-party-Modul-Registry (Härtung)
 * Zweck: End-to-End über den echten Router (server/routes/modules.js) plus direkte
 *        Service-Assertions (server/services/modules.js) - beide zuvor ohne
 *        datei-importierenden Test. Substanz:
 *          - Manifest-Validierung/-Normalisierung (ID/entry/style/accent/menu-Defaults)
 *          - Path-Traversal-Schutz (isSafeRelativeFile + resolve-Confinement) an
 *            entry/style/asset - sicherheitskritisch
 *          - error-Modul-Fallback bei kaputtem/ungültigem module.json
 *          - listModules admin- vs. non-admin-Filter + Sortierung (order, dann name)
 *          - setModuleEnabled-Gates (400 id / 404 / 400 error-enable) + disabled-
 *            Persistenz in sync_config (idempotenter Toggle)
 *          - resolveAssetPath-Fehlerpfade (404 unbekannt/disabled, 400 unsafe, 404 fehlt)
 *          - Route-Auth (requireAdmin auf PATCH, admin-Query-Gate auf GET, KEIN Bypass),
 *            Asset-MIME + Cache-Header
 *
 *        Abweichung vom :memory:-DB-Standard nur beim Dateisystem: MODULES_DIR zeigt
 *        auf einen isolierten Temp-Ordner (der Service liest echte Ordner/Manifeste),
 *        die DB bleibt In-Memory (sync_config genügt). Kein Netz, keine Mocks.
 * Ausführen: node --experimental-sqlite --test test/test-modules.js
 */

import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';

// ── Isolierte Temp-Modul-Umgebung VOR den dynamischen Imports einrichten ─────────
const TMP_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'yuvomi-modules-'));
const MODULES_DIR = path.join(TMP_ROOT, 'modules');
fs.mkdirSync(MODULES_DIR, { recursive: true });

process.env.SESSION_SECRET = process.env.SESSION_SECRET || 'test-secret';
process.env.DB_PATH = ':memory:';
process.env.MODULES_DIR = MODULES_DIR; // wird beim Modul-Load als const gelesen

// Fake-Module schreiben, bevor der Service geladen wird.
function writeModule(folder, manifest, files = {}) {
  const dir = path.join(MODULES_DIR, folder);
  fs.mkdirSync(dir, { recursive: true });
  if (manifest !== null) {
    const body = typeof manifest === 'string' ? manifest : JSON.stringify(manifest);
    fs.writeFileSync(path.join(dir, 'module.json'), body);
  }
  for (const [name, content] of Object.entries(files)) {
    const filePath = path.join(dir, name);
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, content);
  }
}

// Drei valide Module (unterschiedliche menu.order für die Sortier-Assertion).
writeModule('alpha-mod', {
  id: 'alpha-mod', name: 'Alpha', version: '1.0.0', description: 'Alpha module',
  entry: 'index.js', style: 'style.css', icon: 'star', accent: '#112233',
  menu: { order: 10, label: 'Alpha Menu', icon: 'sparkles', show: true },
}, { 'index.js': 'export default {};\n', 'style.css': '.alpha{}\n' });

// Minimal-Manifest: prüft die Default-Ableitungen (accent-Fallback, menu-Defaults,
// style=null). menu.show=false ist reine UI-Sichtbarkeit, NICHT enabled.
writeModule('beta-mod', {
  id: 'beta-mod', entry: 'app.js', menu: { order: 5, show: false },
}, { 'app.js': 'export default {};\n' });

// Ohne menu-Objekt → order-Default 1000, sortiert zuletzt.
writeModule('omega-mod', {
  id: 'omega-mod', name: 'Omega', entry: 'main.js',
}, { 'main.js': 'export default {};\n' });

// Vier fehlerhafte Module (jeweils anderer Fehlerpfad).
writeModule('broken-json-mod', '{ das ist kein json', { 'index.js': '' });
writeModule('mismatch-mod', { id: 'other-id', entry: 'index.js' }, { 'index.js': '' });
writeModule('no-entry-mod', { id: 'no-entry-mod', entry: 'missing.js' }); // Datei fehlt
writeModule('bad-entry-mod', { id: 'bad-entry-mod', entry: '../evil.js' }); // unsafe entry
// style vorhanden, aber weder sicher noch .css → normalizeManifest lehnt ab.
writeModule('bad-style-mod', { id: 'bad-style-mod', entry: 'index.js', style: 'theme.txt' },
  { 'index.js': '' });
// style ist ein sicherer .css-Pfad, aber die Datei fehlt → readModule wirft.
writeModule('no-style-file-mod', { id: 'no-style-file-mod', entry: 'index.js', style: 'theme.css' },
  { 'index.js': '' });

// Loser Nicht-Ordner-Eintrag im MODULES_DIR → muss weggefiltert werden.
fs.writeFileSync(path.join(MODULES_DIR, 'loose.txt'), 'not a module');

writeModule('cap-mod', {
  id: 'cap-mod',
  name: 'Capabilities Module',
  entry: 'index.js',
  capabilities: {
    permissions: {
      module: { label: 'Cap Module', icon: 'star' },
      widgets: [{ id: 'tile', label: 'Tile' }],
    },
    widgets: [{
      id: 'tile',
      entry: 'widgets/tile.js',
      label: 'Tile',
      defaultSize: '2x1',
      optionsSchema: {
        show_title: { type: 'boolean', title: 'Show title', default: true },
      },
    }],
    api: { prefix: '/api/extensions/cap-mod' },
  },
}, {
  'index.js': 'export async function render() {}\n',
  'widgets/tile.js': 'export async function renderWidget(c) { c.textContent = "ok"; }\n',
});

writeModule('bad-cap-mod', {
  id: 'bad-cap-mod',
  entry: 'index.js',
  capabilities: {
    permissions: { module: { label: 'Bad', icon: 'box' } },
    widgets: [{ id: 'tile', entry: 'widgets/missing.js', label: 'Tile' }],
  },
}, { 'index.js': 'export async function render() {}\n' });

writeModule('i18n-mod', {
  id: 'i18n-mod',
  name: 'I18n Module',
  entry: 'index.js',
  i18n: { defaultLocale: 'en' },
  menu: { label: 'I18n', labelKey: 'menu', show: false },
}, {
  'index.js': 'export async function render() {}\n',
  'locales/en.json': JSON.stringify({ menu: 'Menu EN' }),
  'locales/de.json': JSON.stringify({ menu: 'Menu DE' }),
  'locales/xx.json': JSON.stringify({ menu: 'Invalid' }),
});

const VALID_IDS = ['alpha-mod', 'beta-mod', 'omega-mod', 'cap-mod', 'i18n-mod'];
const ERROR_IDS = ['broken-json-mod', 'mismatch-mod', 'no-entry-mod', 'bad-entry-mod',
  'bad-style-mod', 'no-style-file-mod', 'bad-cap-mod'];

import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';

const dbmod = await import('../server/db.js');
const svc = await import('../server/services/modules.js');
const { SUPPORTED_MANIFEST_VERSION } = svc;
const { normalizeCapabilities, fullWidgetId, isWidgetId, isNamespacedWidgetId, MODULE_ID_RE, WIDGET_SHORT_ID_RE } = await import('../server/services/module-capabilities.js');
const { default: modulesRouter } = await import('../server/routes/modules.js');
const db = dbmod.get();

// ── App mit injizierter Auth (actor zur Request-Zeit gelesen) ────────────────────
let actor = { id: 1, role: 'admin' };
const app = express();
app.use((req, _res, next) => {
  req.authUserId = actor.id;
  req.authRole = actor.role;
  req.session = { userId: actor.id, role: actor.role };
  // Wie requireAuth fuer den Browser: Einschalten (PATCH enabled:true) verlangt
  // seit #1671 eine Sitzung; die Token-Seite prueft test-module-install.js.
  req.authMethod = 'session';
  next();
});
app.use(express.json());
app.use('/', modulesRouter);
const server = app.listen(0, '127.0.0.1');
const baseUrl = await new Promise((r) => server.on('listening', () => r(`http://127.0.0.1:${server.address().port}`)));

const ADM = { id: 1, role: 'admin' };
const MEM = { id: 2, role: 'member' };

async function call(method, route, { actor: a, body } = {}) {
  if (a) actor = a;
  const headers = {};
  let payload;
  if (body !== undefined) {
    headers['Content-Type'] = 'application/json';
    payload = JSON.stringify(body);
  }
  const res = await fetch(`${baseUrl}${route}`, { method, headers, body: payload });
  const buf = Buffer.from(await res.arrayBuffer());
  const ct = res.headers.get('content-type') || '';
  let json = null;
  if (ct.includes('application/json')) { try { json = JSON.parse(buf.toString('utf8')); } catch { /* leer */ } }
  return { status: res.status, body: json, buf, contentType: ct, cacheControl: res.headers.get('cache-control') || '' };
}

function disabledConfig() {
  const row = db.prepare("SELECT value FROM sync_config WHERE key = 'third_party_disabled_modules'").get();
  if (!row) return null;
  try {
    return JSON.parse(row.value);
  } catch {
    return null;
  }
}

test.after(() => {
  server.close();
  try { fs.rmSync(TMP_ROOT, { recursive: true, force: true }); } catch { /* best effort */ }
});

// ── Service: Manifest-Normalisierung + Default-Ableitung ─────────────────────────
test('listModules(admin): valide Manifeste werden vollständig normalisiert', async () => {
  const mods = await svc.listModules({ admin: true });
  const byId = Object.fromEntries(mods.map((m) => [m.id, m]));

  const alpha = byId['alpha-mod'];
  assert.equal(alpha.name, 'Alpha');
  assert.equal(alpha.version, '1.0.0');
  assert.equal(alpha.accent, '#112233');
  assert.equal(alpha.status, 'enabled');
  assert.equal(alpha.enabled, true);
  // Öffentliche Asset-URLs werden aus id + relativem Pfad gebaut.
  assert.equal(alpha.route.path, '/m/alpha-mod');
  assert.equal(alpha.route.entry, '/api/v1/modules/assets/alpha-mod/index.js');
  assert.equal(alpha.route.style, '/api/v1/modules/assets/alpha-mod/style.css');
  assert.equal(alpha.menu.label, 'Alpha Menu');
  assert.equal(alpha.menu.icon, 'sparkles');
  assert.equal(alpha.menu.order, 10);

  const beta = byId['beta-mod'];
  assert.equal(beta.name, 'beta-mod', 'name fällt auf id zurück');
  assert.equal(beta.accent, '#6366F1', 'accent-Fallback greift');
  assert.equal(beta.style, null, 'ohne style bleibt style null');
  assert.equal(beta.route.style, null);
  assert.equal(beta.menu.show, false, 'menu.show wird übernommen');
  assert.equal(beta.menu.label, 'beta-mod', 'menu.label fällt auf name zurück');
  assert.equal(beta.enabled, true, 'menu.show=false lässt das Modul dennoch enabled');
});

// ── Formatvertrag des Manifests (#919 Folgearbeit) ──────────────────────────────
// `capabilities` ist seit #919 eine ZUGESAGTE Oberflaeche, und `modules/` ist
// gitignored: die Module kommen zur Laufzeit, niemand hier sieht, wer sie mit
// welchen Annahmen benutzt. Ohne eine Formatversion waere jede Umbenennung
// eines Feldes ein stiller Bruch - das Modul laedt, das Feld fehlt, und der
// Haushalt merkt es an einem Widget, das nichts mehr tut.
//
// Geprueft wird DIREKT an den beiden Funktionen, die den Vertrag tragen, nicht
// ueber angelegte Ordner: ein Test, der dafuer Module auf die Platte schreibt,
// veraendert die Liste, die sieben andere Tests hier zaehlen. (Beim ersten
// Versuch genau so passiert.)

test('ein Manifest ohne manifestVersion gilt als Version 1', () => {
  // Der einzige Wert, der die Manifeste nicht bricht, die es seit #919 schon
  // geben kann: sie beschreiben genau dieses Format.
  const m = svc.normalizeManifest({ id: 'x-mod', entry: 'index.js' }, 'x-mod');
  assert.equal(m.manifestVersion, SUPPORTED_MANIFEST_VERSION);
});

test('ein Manifest fuer ein neueres Format wird abgewiesen, nicht halb gelesen', () => {
  const zuNeu = SUPPORTED_MANIFEST_VERSION + 1;
  assert.throws(
    () => svc.normalizeManifest({ id: 'x-mod', entry: 'index.js', manifestVersion: zuNeu }, 'x-mod'),
    (err) => {
      // Die Meldung nennt BEIDE Zahlen - wer sie liest, weiss sofort, wer wen
      // ueberholt hat, und muss nicht im Quelltext nachsehen.
      assert.match(err.message, new RegExp(String(zuNeu)));
      assert.match(err.message, new RegExp(`${SUPPORTED_MANIFEST_VERSION}\\b`));
      return true;
    },
  );
});

test('eine unsinnige manifestVersion wird abgewiesen', () => {
  for (const bad of ['zwei', 0, -1, 1.5]) {
    assert.throws(
      () => svc.normalizeManifest({ id: 'x-mod', entry: 'index.js', manifestVersion: bad }, 'x-mod'),
      /manifestVersion/,
      `manifestVersion ${JSON.stringify(bad)} haette abgewiesen werden muessen`,
    );
  }
});

test('jedes zugesagte capabilities-Feld kommt beim Modul auch an', async () => {
  // DER EIGENTLICHE VERTRAG, und er prueft VERHALTEN statt Schreibweise: ein
  // Manifest mit allen dokumentierten Feldern geht durch den echten
  // Normalisierer, und jedes Feld muss im Ergebnis ankommen. Wer eines
  // entfernt oder umbenennt, macht diesen Test rot - und die Reparatur ist
  // nicht, ihn anzupassen, sondern SUPPORTED_MANIFEST_VERSION anzuheben und
  // die alte Fassung weiter zu lesen. Ein Guard ueber den Quelltext haette
  // denselben Namen an anderer Stelle akzeptiert.
  const caps = await normalizeCapabilities(
    {
      capabilities: {
        permissions: { module: { labelKey: 'contract.title', icon: 'box' } },
        widgets: [{
          id: 'panel', entry: 'widget.js', titleKey: 'contract.panel',
          optionsSchema: { properties: { rows: { type: 'number' } } },
        }],
        api: { prefix: '/api/extensions/contract-mod' },
      },
    },
    'contract-mod',
    '/nowhere',
    (id, rel) => `/api/v1/modules/assets/${id}/${rel}`,
    async () => true,        // jede Datei existiert
    () => true,              // jeder Pfad ist sicher
  );

  assert.ok(caps, 'capabilities duerfen nicht ganz wegfallen');
  assert.equal(caps.permissionModuleKey, 'ext:contract-mod', 'ext:<id> ist der zugesagte Namensraum');
  assert.ok(caps.permissionModule, 'permissions.module');
  assert.equal(caps.apiPrefix, '/api/extensions/contract-mod', 'api.prefix');
  assert.equal(caps.widgets.length, 1, 'widgets');
  assert.equal(caps.widgets[0].shortId, 'panel');
  assert.equal(caps.widgets[0].id, 'contract-mod:panel', '<module-id>:<widget-id> ist zugesagt');
  assert.ok(caps.widgets[0].optionsSchema, 'widgets[].optionsSchema');
});

// ── Service: error-Fallback bei ungültigem Manifest ──────────────────────────────
test('listModules(admin): jedes kaputte Modul wird zum error-Eintrag (kein Wurf)', async () => {
  const mods = await svc.listModules({ admin: true });
  const byId = Object.fromEntries(mods.map((m) => [m.id, m]));
  for (const id of ERROR_IDS) {
    const m = byId[id];
    assert.ok(m, `error-Modul ${id} taucht in der Admin-Liste auf`);
    assert.equal(m.status, 'error');
    assert.equal(m.enabled, false);
    assert.equal(m.route, null);
    assert.ok(typeof m.error === 'string' && m.error.length > 0, `${id} trägt eine Fehlermeldung`);
  }
  // Der lose Nicht-Ordner-Eintrag ist kein Modul.
  assert.equal(byId['loose.txt'], undefined, 'lose Datei wird gefiltert');
  // Insgesamt exakt valide + error, nichts sonst.
  assert.equal(mods.length, VALID_IDS.length + ERROR_IDS.length);
});

// ── Service: non-admin filtert + Sortierung ──────────────────────────────────────
test('listModules(): non-admin zeigt nur enabled+ok, sortiert nach order dann name', async () => {
  const mods = await svc.listModules({ admin: false });
  assert.deepEqual(mods.map((m) => m.id), ['beta-mod', 'alpha-mod', 'cap-mod', 'i18n-mod', 'omega-mod'],
    'order 5 < 10 < 1000, dann name');
  assert.ok(mods.every((m) => m.status === 'enabled'), 'keine error-Module für Nutzer');
});

test('listModules(): korrupter disabled-Eintrag in sync_config → als leer behandelt', async () => {
  // parseDisabledModules fängt ungültiges JSON ab und liefert [] (kein Wurf).
  db.prepare("INSERT INTO sync_config (key, value) VALUES ('third_party_disabled_modules', '{kaputt')").run();
  const mods = await svc.listModules({ admin: false });
  assert.deepEqual(mods.map((m) => m.id), ['beta-mod', 'alpha-mod', 'cap-mod', 'i18n-mod', 'omega-mod'],
    'nichts gilt als deaktiviert, wenn der Eintrag unlesbar ist');
  // Wieder entfernen: die folgenden PATCH-Tests erwarten einen jungfräulichen Zustand.
  db.prepare("DELETE FROM sync_config WHERE key = 'third_party_disabled_modules'").run();
});

// ── Route GET /: non-admin sieht nur nutzbare Module ─────────────────────────────
test('GET /: member erhält nur enabled Module', async () => {
  const r = await call('GET', '/', { actor: MEM });
  assert.equal(r.status, 200);
  assert.deepEqual(r.body.data.map((m) => m.id), ['beta-mod', 'alpha-mod', 'cap-mod', 'i18n-mod', 'omega-mod']);
});

test('GET /?admin=1: member wird NICHT als admin behandelt (kein Bypass)', async () => {
  const r = await call('GET', '/?admin=1', { actor: MEM });
  assert.equal(r.status, 200);
  assert.equal(r.body.data.length, VALID_IDS.length, 'admin-Query von Nicht-Admin ignoriert');
  assert.ok(!r.body.data.some((m) => m.status === 'error'));
});

test('GET /?admin=1: admin sieht alle Module inkl. error/disabled', async () => {
  const r = await call('GET', '/?admin=1', { actor: ADM });
  assert.equal(r.status, 200);
  assert.equal(r.body.data.length, VALID_IDS.length + ERROR_IDS.length);
  assert.ok(r.body.data.some((m) => m.status === 'error'), 'error-Module sichtbar');
});

test('GET / ohne admin-Query: admin erhält dennoch nur die Nutzer-Liste', async () => {
  const r = await call('GET', '/', { actor: ADM });
  assert.equal(r.status, 200);
  assert.equal(r.body.data.length, VALID_IDS.length, 'admin=1 muss explizit gesetzt sein');
});

// ── Route GET /assets: Auslieferung + MIME + Cache-Header ─────────────────────────
test('GET /assets/:id/*: liefert JS mit korrektem MIME und no-cache', async () => {
  const r = await call('GET', '/assets/alpha-mod/index.js', { actor: MEM });
  assert.equal(r.status, 200);
  assert.match(r.contentType, /text\/javascript/);
  assert.match(r.cacheControl, /no-cache/, 'Modul-Assets werden nicht dauerhaft gecacht');
  assert.equal(r.buf.toString('utf8'), 'export default {};\n');
});

test('GET /assets/:id/*: liefert CSS mit korrektem MIME', async () => {
  const r = await call('GET', '/assets/alpha-mod/style.css', { actor: MEM });
  assert.equal(r.status, 200);
  assert.match(r.contentType, /text\/css/);
  assert.equal(r.buf.toString('utf8'), '.alpha{}\n');
});

test('GET /assets/:id/*: fehlende Datei → 404', async () => {
  const r = await call('GET', '/assets/alpha-mod/nope.js', { actor: MEM });
  assert.equal(r.status, 404);
});

test('GET /assets/:id/*: unbekanntes Modul → 404', async () => {
  const r = await call('GET', '/assets/ghost-mod/index.js', { actor: MEM });
  assert.equal(r.status, 404);
});

// ── Service resolveAssetPath: Traversal-/Fehlerpfade (deterministisch) ───────────
test('resolveAssetPath: gültiger Pfad zeigt in den Modul-Ordner', async () => {
  const p = await svc.resolveAssetPath('alpha-mod', 'index.js');
  assert.equal(p, path.join(MODULES_DIR, 'alpha-mod', 'index.js'));
});

test('resolveAssetPath: Path-Traversal wird mit 400 abgewiesen', async () => {
  for (const rel of ['../evil.js', '../../etc/passwd', '/etc/passwd', 'a\\b.js', 'sub/../../x']) {
    await assert.rejects(
      () => svc.resolveAssetPath('alpha-mod', rel),
      (err) => err.status === 400,
      `unsafe path ${rel} muss 400 werfen`,
    );
  }
});

test('resolveAssetPath: unbekanntes Modul → 404', async () => {
  await assert.rejects(() => svc.resolveAssetPath('ghost-mod', 'index.js'), (e) => e.status === 404);
});

test('resolveAssetPath: existierendes Modul, fehlende Datei → 404', async () => {
  await assert.rejects(() => svc.resolveAssetPath('alpha-mod', 'nope.js'), (e) => e.status === 404);
});

// ── Service setModuleEnabled: Gates ──────────────────────────────────────────────
test('setModuleEnabled: ungültige id → 400', async () => {
  await assert.rejects(() => svc.setModuleEnabled('Bad_ID!', false), (e) => e.status === 400);
});

test('setModuleEnabled: unbekanntes Modul → 404', async () => {
  await assert.rejects(() => svc.setModuleEnabled('ghost-mod', false), (e) => e.status === 404);
});

test('setModuleEnabled: error-Modul aktivieren → 400 (bleibt fehlerhaft)', async () => {
  await assert.rejects(() => svc.setModuleEnabled('broken-json-mod', true), (e) => e.status === 400);
});

// ── Route PATCH /:id: Auth + Validierung ─────────────────────────────────────────
test('PATCH /:id: member → 403 (requireAdmin, kein Bypass), sync_config unverändert', async () => {
  assert.equal(disabledConfig(), null, 'Vorbedingung: noch nichts deaktiviert');
  const r = await call('PATCH', '/alpha-mod', { actor: MEM, body: { enabled: false } });
  assert.equal(r.status, 403);
  assert.equal(disabledConfig(), null, 'kein Schreib-Durchschlag durch das Auth-Gate');
});

test('PATCH /:id: enabled kein boolean → 400', async () => {
  for (const bad of [{ enabled: 'yes' }, { enabled: 1 }, {}]) {
    const r = await call('PATCH', '/alpha-mod', { actor: ADM, body: bad });
    assert.equal(r.status, 400, `Body ${JSON.stringify(bad)} muss 400 liefern`);
  }
});

test('PATCH /:id: unbekanntes Modul → 404', async () => {
  const r = await call('PATCH', '/ghost-mod', { actor: ADM, body: { enabled: false } });
  assert.equal(r.status, 404);
});

// ── Route PATCH /:id: Toggle + Persistenz (mutierend → gegen Ende) ────────────────
test('PATCH /:id: deaktivieren persistiert und verbirgt das Modul für Nutzer', async () => {
  const r = await call('PATCH', '/alpha-mod', { actor: ADM, body: { enabled: false } });
  assert.equal(r.status, 200);
  assert.equal(r.body.data.status, 'disabled');
  assert.equal(r.body.data.enabled, false);
  assert.deepEqual(disabledConfig(), ['alpha-mod'], 'in sync_config gespeichert');

  // Nutzer-Liste zeigt alpha-mod nicht mehr, resolveAssetPath verweigert Assets.
  const list = await call('GET', '/', { actor: MEM });
  assert.ok(!list.body.data.some((m) => m.id === 'alpha-mod'));
  const asset = await call('GET', '/assets/alpha-mod/index.js', { actor: MEM });
  assert.equal(asset.status, 404, 'Assets deaktivierter Module sind nicht abrufbar');
});

test('PATCH /:id: reaktivieren ist idempotent und stellt das Modul wieder her', async () => {
  const r1 = await call('PATCH', '/alpha-mod', { actor: ADM, body: { enabled: true } });
  assert.equal(r1.status, 200);
  assert.equal(r1.body.data.status, 'enabled');
  assert.deepEqual(disabledConfig(), [], 'aus der disabled-Liste entfernt');

  // Erneutes enable=true ändert nichts (idempotent).
  const r2 = await call('PATCH', '/alpha-mod', { actor: ADM, body: { enabled: true } });
  assert.equal(r2.status, 200);
  assert.deepEqual(disabledConfig(), []);

  const list = await call('GET', '/', { actor: MEM });
  assert.ok(list.body.data.some((m) => m.id === 'alpha-mod'), 'wieder sichtbar');
});

test('listModules: capabilities werden normalisiert und exponiert', async () => {
  const mods = await svc.listModules({ admin: true });
  const cap = mods.find((m) => m.id === 'cap-mod');
  assert.ok(cap, 'cap-mod vorhanden');
  assert.equal(cap.capabilities.permissionModuleKey, 'ext:cap-mod');
  assert.equal(cap.capabilities.widgets[0].id, 'cap-mod:tile');
  assert.equal(cap.capabilities.apiPrefix, '/api/extensions/cap-mod');
  assert.equal(cap.capabilities.widgets[0].optionsSchema.show_title.type, 'boolean');
});

test('listModules: i18n metadata scans locales/ and filters unsupported codes', async () => {
  const mods = await svc.listModules({ admin: true });
  const i18nMod = mods.find((m) => m.id === 'i18n-mod');
  assert.ok(i18nMod, 'i18n-mod vorhanden');
  assert.equal(i18nMod.i18n.defaultLocale, 'en');
  assert.deepEqual(i18nMod.i18n.availableLocales, ['de', 'en']);
  assert.ok(Array.isArray(i18nMod.i18n.coreLocales) && i18nMod.i18n.coreLocales.includes('de'));
});

test('listModules: fehlende widget entry datei → error status', async () => {
  const mods = await svc.listModules({ admin: true });
  const bad = mods.find((m) => m.id === 'bad-cap-mod');
  assert.equal(bad.status, 'error');
  assert.match(bad.error, /does not exist/i);
});

// ── Die Freigabe wohnt in der Installationsdatei (#1671, DECISIONS.md 12) ────────
// Kein Backup enthaelt modules/. Eine zurueckgespielte oder frische Datenbank
// darf kein Modul einschalten, das installiert und nie angesehen wurde - also
// entscheidet die Datei im Ordner, nicht die Sperrliste in sync_config.
const installRecord = (overrides = {}) => JSON.stringify({
  source: 'zip', installedAt: '2026-10-06T10:00:00.000Z', installedBy: 1, approved: false, ...overrides,
});
const clearDisabledConfig = () => db.prepare("DELETE FROM sync_config WHERE key = 'third_party_disabled_modules'").run();
const find = async (id) => (await svc.listModules({ admin: true })).find((m) => m.id === id);

test('Installationsdatei ohne Freigabe + leere Datenbank → aus; ohne Datei entscheidet die Sperrliste', async () => {
  writeModule('record-mod', { id: 'record-mod', entry: 'index.js' },
    { 'index.js': '', '.yuvomi-install.json': installRecord() });
  clearDisabledConfig();
  const m = await find('record-mod');
  assert.equal(m.enabled, false, 'die Datei sagt nicht freigegeben - die leere Sperrliste zaehlt nicht');
  assert.equal(m.status, 'disabled');
  assert.equal(m.install.approved, false);
  assert.equal(m.install.installedBy, undefined, 'die Nutzer-Id bleibt in der Datei');
  // Nur das Literal true ist eine Freigabe.
  fs.writeFileSync(path.join(MODULES_DIR, 'record-mod', '.yuvomi-install.json'), installRecord({ approved: 'true' }));
  assert.equal((await find('record-mod')).enabled, false, '"true" als Text ist keine Freigabe');
  fs.writeFileSync(path.join(MODULES_DIR, 'record-mod', '.yuvomi-install.json'), installRecord({ approved: 1 }));
  assert.equal((await find('record-mod')).enabled, false, '1 ist keine Freigabe');
  // Von Hand kopiert (keine Datei): wie bisher, an bei leerer Sperrliste.
  fs.rmSync(path.join(MODULES_DIR, 'record-mod', '.yuvomi-install.json'));
  assert.equal((await find('record-mod')).enabled, true);
  assert.equal((await find('record-mod')).install, null);
});
// Eine Datei, die DA ist, aber nicht lesbar (abgeschnitten, von Hand verdorben,
// zu gross), darf das Modul nicht als "von Hand kopiert" durchwinken: sie sagt,
// dass hier die Oberflaeche installiert hat, und was sie nicht freigibt, bleibt
// aus. Als Fehler, nicht als bloss "aus" - der Admin soll sehen, warum der
// Schalter fehlt, und die Datei auf dem Server richten oder den Ordner entfernen.
test('Installationsdatei vorhanden, aber unlesbar → aus und als Fehler gemeldet, nie an', async () => {
  writeModule('broken-record', { id: 'broken-record', entry: 'index.js' }, { 'index.js': '' });
  clearDisabledConfig();
  const file = path.join(MODULES_DIR, 'broken-record', '.yuvomi-install.json');
  for (const [label, content] of [
    ['abgeschnitten', installRecord().slice(0, 20)],
    ['kein Objekt', '[]'],
    ['unbekannte Quelle', installRecord({ source: 'ftp' })],
    ['zu gross', JSON.stringify({ source: 'zip', approved: true, pad: 'x'.repeat(5000) })],
  ]) {
    fs.writeFileSync(file, content);
    const m = await find('broken-record');
    assert.equal(m.enabled, false, `${label}: laeuft trotz unlesbarer Datei`);
    assert.equal(m.status, 'error', `${label}: nicht als Fehler gemeldet`);
    assert.match(m.error, /.yuvomi-install.json/, `${label}: der Fehler nennt die Datei nicht`);
  }
  // Gegenprobe: dieselbe Datei lesbar und freigegeben → an.
  fs.writeFileSync(file, installRecord({ approved: true }));
  assert.equal((await find('broken-record')).enabled, true);
});

test('Einschalten schreibt die Freigabe in die Datei; eine leere Datenbank danach laesst das Modul an', async () => {
  const file = path.join(MODULES_DIR, 'record-mod', '.yuvomi-install.json');
  fs.writeFileSync(file, installRecord());
  assert.equal((await find('record-mod')).enabled, false);
  const on = await call('PATCH', '/record-mod', { actor: ADM, body: { enabled: true } });
  assert.equal(on.status, 200, JSON.stringify(on.body));
  assert.equal(on.body.data.enabled, true);
  assert.equal(on.body.data.install.approved, true);
  const written = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.equal(written.approved, true, 'die Freigabe steht in der Datei');
  assert.equal(written.installedBy, 1, 'die anderen Felder bleiben, wie die Installation sie schrieb');
  assert.equal(written.source, 'zip');
  assert.ok(!fs.readdirSync(path.join(MODULES_DIR, 'record-mod')).some((n) => n.endsWith('.tmp')), 'keine Temp-Datei bleibt liegen');
  // Datenbank "zurueckgespielt": die Sperrliste ist weg - das Modul bleibt an.
  clearDisabledConfig();
  assert.equal((await find('record-mod')).enabled, true, 'die Freigabe ueberlebt die Datenbank');
  // Runde 4: Ausschalten setzt die Sperrliste UND schreibt `approved: false`
  // zurueck - `approved` heisst "ein Admin hat diese Fassung eingeschaltet",
  // und "aus" soll den Ordner ebenso begleiten wie "an": eine zurueckgespielte
  // Datenbank schaltete sonst wieder ein, was der Admin abgeschaltet hatte.
  const off = await call('PATCH', '/record-mod', { actor: ADM, body: { enabled: false } });
  assert.equal(off.body.data.enabled, false);
  assert.equal(off.body.data.install.approved, false);
  assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).approved, false, 'ausschalten nimmt die Freigabe zurueck');
  assert.deepEqual(disabledConfig(), ['record-mod']);
  clearDisabledConfig();
  assert.equal((await find('record-mod')).enabled, false, 'leere Datenbank: das Aus ueberlebt in der Datei');
  assert.equal((await call('PATCH', '/record-mod', { actor: ADM, body: { enabled: true } })).body.data.enabled, true);
  assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).approved, true, 'wieder einschalten ist eine neue Freigabe');
  assert.deepEqual(disabledConfig(), []);
  // Ein Ordner, den der Server nicht schreiben kann: aus geht trotzdem - die
  // Sperrliste reicht, und Code wegnehmen darf nie an der Datei scheitern.
  const restore = svc.__setModulesFsOpsForTests({
    writeFile: async () => { throw Object.assign(new Error('read-only'), { code: 'EROFS' }); },
  });
  try {
    const ro = await call('PATCH', '/record-mod', { actor: ADM, body: { enabled: false } });
    assert.equal(ro.status, 200, JSON.stringify(ro.body));
    assert.equal(ro.body.data.enabled, false, 'aus ueber die Sperrliste');
    assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).approved, true, 'die Datei blieb, wie sie war (nur gewarnt)');
  } finally {
    restore();
  }
  fs.rmSync(path.join(MODULES_DIR, 'record-mod'), { recursive: true, force: true });
});

test('readInstallRecord/readInstallMeta/writeInstallApproval: Felder, Grenzen, Atomaritaet', async () => {
  const dir = path.join(MODULES_DIR, 'rec-api-mod');
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, '.yuvomi-install.json');
  fs.writeFileSync(file, installRecord({ installedBy: 42, url: 'https://github.com/o/r', extra: 'ignored' }));
  const record = await svc.readInstallRecord(dir);
  assert.deepEqual(record, {
    source: 'zip', url: 'https://github.com/o/r', ref: null, commit: null, path: null,
    installedAt: '2026-10-06T10:00:00.000Z', approved: false, installedBy: 42,
  });
  const meta = await svc.readInstallMeta(dir);
  assert.equal(meta.installedBy, undefined, 'die Antwortform traegt keine Nutzer-Id');
  assert.equal(meta.approved, false);
  // Eine Nutzer-Id, die keine Zahl ist, wird null - nie ein String in der Abfrage.
  fs.writeFileSync(file, installRecord({ installedBy: '42' }));
  assert.equal((await svc.readInstallRecord(dir)).installedBy, null);
  await svc.writeInstallApproval(dir, true);
  const after = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.equal(after.approved, true);
  assert.equal(after.installedBy, '42', 'die Datei wird umgeschrieben, nicht neu erfunden');
  assert.deepEqual(fs.readdirSync(dir), ['.yuvomi-install.json'], 'die Temp-Datei ist nach dem rename weg');
  await assert.rejects(svc.writeInstallApproval(path.join(MODULES_DIR, 'nope-mod'), true), 'ohne Datei kein Umschreiben');
  fs.rmSync(dir, { recursive: true, force: true });
});

// Runde 4 der Review (#1671): kann die Freigabe nicht geschrieben werden, weil
// der Modulordner schreibgeschuetzt ist, antwortet die Route 503 not_writable -
// nicht 500 mit der rohen Meldung, die den absoluten Serverpfad der Temp-Datei
// nennt. Jeder andere Fehler bleibt 500, aber mit festem Satz. Simuliert ueber
// den writeFile-Haken: chmod auf Ordnern ist unter Windows wirkungslos.
test('Freigabe nicht schreibbar → 503 not_writable ohne Serverpfad; anderer Fehler → 500 mit festem Satz', async () => {
  const dir = path.join(MODULES_DIR, 'ro-record-mod');
  writeModule('ro-record-mod', { id: 'ro-record-mod', entry: 'index.js' }, { 'index.js': '', '.yuvomi-install.json': installRecord() });
  const failWith = (code) => svc.__setModulesFsOpsForTests({
    writeFile: async (p) => { throw Object.assign(new Error(`${code}: permission denied, open '${p}'`), { code }); },
  });
  for (const code of ['EACCES', 'EPERM', 'EROFS']) {
    const restore = failWith(code);
    try {
      const r = await call('PATCH', '/ro-record-mod', { actor: ADM, body: { enabled: true } });
      assert.equal(r.status, 503, `${code}: ${JSON.stringify(r.body)}`);
      assert.equal(r.body.reason, 'not_writable', code);
      assert.equal(r.body.code, 503);
      assert.ok(!r.body.error.includes(MODULES_DIR), `${code}: der Serverpfad steht in der Antwort`);
      assert.ok(!r.body.error.includes(code), `${code}: der rohe Fehlercode steht in der Antwort`);
      assert.match(r.body.error, /modules\/ro-record-mod/, 'der relative Ordner darf genannt werden');
      // Direkt am Service: status und reason am Fehler.
      await assert.rejects(svc.setModuleEnabled('ro-record-mod', true), (e) => e.status === 503 && e.reason === 'not_writable');
    } finally {
      restore();
    }
  }
  assert.equal(JSON.parse(fs.readFileSync(path.join(dir, '.yuvomi-install.json'), 'utf8')).approved, false, 'nichts freigegeben');
  assert.equal((await find('ro-record-mod')).enabled, false, 'und das Modul bleibt aus');
  assert.deepEqual(fs.readdirSync(dir).filter((n) => n.endsWith('.tmp')), [], 'keine Temp-Datei bleibt liegen');
  // Ein anderer Fehler (die Datei ist zwischen Lesen und Schreiben weg): 500
  // mit festem Satz, ohne reason, ohne Pfad.
  const restore = failWith('ENOENT');
  try {
    const r = await call('PATCH', '/ro-record-mod', { actor: ADM, body: { enabled: true } });
    assert.equal(r.status, 500, JSON.stringify(r.body));
    assert.deepEqual(r.body, { error: 'Module update failed.', code: 500 });
  } finally {
    restore();
  }
  assert.equal((await find('ro-record-mod')).enabled, false);
  // Ohne Haken geht es, und die Freigabe steht in der Datei.
  const ok = await call('PATCH', '/ro-record-mod', { actor: ADM, body: { enabled: true } });
  assert.equal(ok.status, 200, JSON.stringify(ok.body));
  assert.equal(JSON.parse(fs.readFileSync(path.join(dir, '.yuvomi-install.json'), 'utf8')).approved, true);
  fs.rmSync(dir, { recursive: true, force: true });
});

// Die Seitenerklaerung (`page.composition`, `page.width`) ist seit #929 Teil
// des Manifests. Sie zaehlt nur, wenn der Router sie auch anwendet - der Guard
// dafuer steht in test-frontend-audit.js (PAGE-012); hier wird die Normalisierung
// festgehalten, auf die er sich verlaesst.
test('page.composition wird normalisiert und page.width folgt dem Modus', () => {
  const norm = (page) => svc.normalizeManifest({ id: 'x-mod', entry: 'index.js', page }, 'x-mod').page;
  assert.deepEqual(norm(undefined), { composition: 'reading', width: 'reading', navigation: 'standard', responsive: 'standard' },
    'ohne page-Block: reading in Lesebreite');
  assert.equal(norm({ composition: 'data' }).width, 'content', 'data liest --layout-content');
  assert.equal(norm({ composition: 'dashboard' }).width, 'wide', 'dashboard liest --layout-wide');
  assert.equal(norm({ composition: 'full' }).width, 'reading',
    'full traegt den Rueckfall reading - layout.css wendet width auf full/split nicht an');
  assert.equal(norm({ composition: 'data', width: 'wide' }).width, 'wide', 'eine erklaerte Breite gewinnt');
  assert.equal(norm({ composition: 'tabelle' }).composition, 'reading', 'ein unbekannter Modus faellt auf reading');
  assert.equal(norm({ composition: 'data', width: 'riesig' }).width, 'content', 'eine unbekannte Breite faellt auf die des Modus');
  // navigation/responsive folgen derselben Regel: MODULES.md nennt nur
  // `standard`, und ein Tippfehler darf nicht als eigener Zustand ankommen
  // (Codex, dritte Runde an #995 - die erste Fassung reichte ihn roh durch).
  assert.equal(norm({ navigation: 'tabs' }).navigation, 'standard', 'eine unbekannte navigation faellt auf standard');
  assert.equal(norm({ responsive: 'collapse' }).responsive, 'standard', 'ein unbekanntes responsive faellt auf standard');
  assert.equal(norm({ navigation: 'standard', responsive: 'standard' }).navigation, 'standard', 'standard bleibt standard');
});

// ── Die Speicherform einer Widget-Id (#1013) ─────────────────────────────────
//
// DER EIGENTLICHE GUARD IST DER ERSTE: was `fullWidgetId()` baut, muss
// `isWidgetId()` annehmen - und zwar an den LAENGENGRENZEN, nicht an einem
// huebschen Beispiel. Genau daran ist #1013 gescheitert: die Speicherform stand
// in einer anderen Datei und kannte den Doppelpunkt nicht, den die
// Zusammensetzung erzeugt. Ein Beispiel-Test mit 'my-addon:chart' waere auch mit
// einer Schranke von 64 Zeichen gruen geblieben, obwohl eine legale volle Id 97
// erreichen kann.
test('was fullWidgetId baut, nimmt die Speicherform an - auch am Rand (#1013)', () => {
  const maxModuleId = 'm'.repeat(64);
  const maxShortId = 'w'.repeat(32);
  assert.ok(MODULE_ID_RE.test(maxModuleId), 'Voraussetzung: 64 Zeichen sind eine legale Modul-Id');
  assert.ok(WIDGET_SHORT_ID_RE.test(maxShortId), 'Voraussetzung: 32 Zeichen sind eine legale Kurz-Id');

  const longest = fullWidgetId(maxModuleId, maxShortId);
  assert.equal(longest.length, 97, 'die laengste legale Widget-Id ist 97 Zeichen lang');
  assert.ok(isWidgetId(longest), 'die laengste legale Id muss speicherbar sein');

  // Eine Modul-Id darf mit einer ZIFFER beginnen (ID_RE), eine Kern-Widget-Id
  // nicht. Wer die Namensraum-Form aus der Kern-Form ableitet, verliert das.
  assert.ok(MODULE_ID_RE.test('7up'), 'Voraussetzung: eine Modul-Id darf mit einer Ziffer beginnen');
  assert.ok(isWidgetId(fullWidgetId('7up', 'chart')), 'auch eine Modul-Id mit fuehrender Ziffer bleibt speicherbar');
});

test('isWidgetId nimmt Kern- und Namensraum-Ids an und weist kaputte ab (#1013)', () => {
  for (const id of ['weather', 'tasks', 'my-addon', 'my-addon:chart', '7up:chart']) {
    assert.ok(isWidgetId(id), `${id} muss angenommen werden`);
  }
  for (const id of [
    'mo:chart',                       // Modul-Id kuerzer als drei Zeichen
    `${'m'.repeat(65)}:chart`,        // Modul-Id zu lang
    `my-addon:${'w'.repeat(33)}`,     // Kurz-Id zu lang
    'a:b:c',                          // zweiter Doppelpunkt: kaputt, nicht verschachtelt
    'my-addon:', ':chart', '::',
    '../weather', 'My-Addon:chart', 'my-addon:Chart', 'my-addon:1chart',
    '-my-addon:chart', 'my-addon-:chart',
    null, undefined, 42, {},
  ]) {
    assert.equal(isWidgetId(id), false, `${String(id)} darf nicht angenommen werden`);
  }
  // Eine Kern-Id ist NICHT namensraumbehaftet - sonst wuerde jede Kachel als
  // Fremdmodul-Widget gelten, sobald jemand die beiden Pruefungen verwechselt.
  assert.equal(isNamespacedWidgetId('weather'), false);
  assert.equal(isNamespacedWidgetId('my-addon:chart'), true);
});
