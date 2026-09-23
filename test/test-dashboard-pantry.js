/**
 * Modul: Vorrat - Dashboard-Widget „Läuft bald ab"
 * Zweck: Die Kachel, die die Critique vom 2026-09-23 als fehlend fand: der
 *        Vorrat ist das einzige Küchenmodul mit echten täglichen Fristen und
 *        hatte keine. Geprüft werden vier Dinge, jedes an seiner eigenen Naht:
 *
 *        1. Registrierung - Widget-Liste, Standardgröße, ab Werk AUSgeblendet,
 *           Modulzuordnung für Rechte und Modulschalter, Renderer im Dispatch.
 *        2. Payload - `pantryExpiring` aus GET /dashboard: abgelaufen zuerst,
 *           dann nach Resttagen; Horizont = EXPIRY_SOON_DAYS (inklusiv);
 *           ohne MHD und leere Chargen fallen heraus; Deckel der Liste, aber
 *           die Zahlen zählen ungedeckelt.
 *        3. Tagesgrenze - „heute" ist der Tag der HAUSHALTSZONE, nicht der
 *           UTC-Tag; gemessen mit einer Uhr kurz nach Mitternacht Berlin und
 *           einer kurz vor Mitternacht Los Angeles.
 *        4. Rechte - Modul `none` und ein Token ohne Vorrats-Scope liefern die
 *           leere Form; `read` ist keine Sperre.
 *        Dazu der Renderer (Zeilendeckel je Größe, „+N weitere" gegen die
 *        SERVER-Gesamtzahl, Ton nach Dringlichkeit, Deep-Link je Zeile) und der
 *        Filter-Deep-Link der Vorratsseite, auf den die Zeilen zeigen.
 *
 *        Die Datenbasis ist bewusst die Charge (eine `pantry_items`-Zeile):
 *        das Haushalts-Produkt über der Charge (#1448) steht noch aus, die
 *        Kachel gruppiert deshalb nichts.
 * Ausführen: npm run test:dashboard-pantry
 */
import test, { mock } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import http from 'node:http';
import { register } from 'node:module';
import Database from 'better-sqlite3-multiple-ciphers';
import express from 'express';

register('./test-browser-loader.mjs', import.meta.url);

process.env.DB_PATH = ':memory:';
process.env.SESSION_SECRET = 'dashboard-pantry-test-secret';

const widgets = await import('../public/utils/dashboard-widgets.js');
const { PERMISSION_WIDGETS, resolvePermissions, buildSessionModuleAccess } = await import('../server/permissions.js');
const { EXPIRY_SOON_DAYS, pantryFilterFromSearch } = await import('../public/utils/pantry-status.js');
const { __test } = await import('../public/pages/dashboard.js');
const { renderPantryWidget, listRowCap } = __test;

const src = (path) => readFileSync(new URL(path, import.meta.url), 'utf8');

// --------------------------------------------------------------------------
// 1. Registrierung
// --------------------------------------------------------------------------

test('Registrierung: pantry steht in WIDGET_IDS, ab Werk ausgeblendet, als hohe Liste', () => {
  assert.ok(widgets.WIDGET_IDS.includes('pantry'), 'WIDGET_IDS fehlt pantry');
  // Eine Id, die in DEFAULT_HIDDEN_WIDGETS FEHLT, ist nach dem Update in jedem
  // bestehenden Haushalt eingeblendet (normalizeDashboardConfig ergänzt sie mit
  // defaultWidgetVisible) - die Anti-Referenz ist das überladene Dashboard.
  assert.ok(widgets.DEFAULT_HIDDEN_WIDGETS.has('pantry'), 'pantry muss ein Opt-in im Anpassen-Tray sein');
  assert.equal(widgets.DEFAULT_WIDGET_CONFIG.find((w) => w.id === 'pantry')?.visible, false,
    'das Standard-Layout zeigt die Kachel nicht');
  assert.equal(widgets.defaultWidgetSize('pantry'), '1x2', 'eine Liste braucht Höhe, nicht Breite (wie waste/birthdays)');
});

test('Registrierung: ein Bestandslayout ohne pantry bekommt die Kachel ausgeblendet dazu', () => {
  const bestand = widgets.DEFAULT_WIDGET_CONFIG
    .filter((w) => w.id !== 'pantry')
    .map((w, i) => ({ ...w, order: i }));
  const merged = widgets.normalizeDashboardConfig(bestand);
  const pantry = merged.find((w) => w.id === 'pantry');
  assert.ok(pantry, 'die neue Id wird ergänzt');
  assert.equal(pantry.visible, false, 'und zwar AUSgeblendet');
  // `isUserOrderedConfig` gibt es seit dem dichten Raster nicht mehr (a1); was
  // bleibt, ist die Default-Position des Neuzugangs: hinter dem Einkauf.
  const ids = merged.map((w) => w.id);
  assert.equal(ids.indexOf('pantry'), ids.indexOf('shopping') + 1, 'die Ergänzung steht an ihrer Default-Position');
});

test('Registrierung: Rechte hängen am Modul pantry', () => {
  assert.deepEqual(PERMISSION_WIDGETS.find((w) => w.id === 'pantry'), { id: 'pantry', module: 'pantry' },
    'ein gesperrter Vorrat muss auch die Kachel sperren (#467)');
});

test('Registrierung: Modulschalter, Dispatch, Beschriftung und Ton sind verdrahtet', () => {
  const page = src('../public/pages/dashboard.js');
  assert.match(page, /const MODULE_FOR_WIDGET = \{[^}]*\bpantry: 'pantry'/,
    'MODULE_FOR_WIDGET: ein abgeschalteter Vorrat muss die Kachel aus Raster UND Tray nehmen');
  assert.match(page, /pantry: \(size\) => renderPantryWidget\(data\.pantryExpiring, size\)/,
    'widgetById muss die Kachel mit ihrer Größe rendern, sonst greift der Zeilendeckel nicht');
  assert.match(page, /pantry:\s*\(\) => t\('dashboard\.pantryExpiringTitle'\)/, 'widgetLabel (Tray, Fehlerkachel)');
  const admin = src('../public/settings/pages/admin-permissions.js');
  assert.match(admin, /pantry: 'dashboard\.pantryExpiringTitle'/, 'die Rechteverwaltung nennt die Kachel beim selben Namen');
  const css = src('../public/styles/dashboard.css');
  assert.match(css, /\.widget--pantry\s*\{\s*--widget-accent:\s*var\(--module-pantry\);\s*\}/,
    'Familienton kitchen über --module-pantry');
});

// --------------------------------------------------------------------------
// Server: echter Router gegen eine migrierte In-Memory-DB
// --------------------------------------------------------------------------

const { MIGRATIONS, get, _setTestDatabase } = await import('../server/db.js');
const { default: dashboardRouter } = await import('../server/routes/dashboard.js');

function buildMigratedDatabase(migrations) {
  const database = new Database(':memory:');
  database.pragma('foreign_keys = ON');
  database.exec(`
    CREATE TABLE schema_migrations (
      version INTEGER PRIMARY KEY,
      description TEXT NOT NULL,
      applied_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
    )
  `);
  for (const migration of migrations) {
    if (typeof migration.up === 'function') migration.up(database);
    else database.exec(migration.up);
    if (typeof migration.afterUp === 'function') migration.afterUp(database);
    database.prepare('INSERT INTO schema_migrations (version, description) VALUES (?, ?)')
      .run(migration.version, migration.description);
  }
  return database;
}

const moduleDatabase = get();
const db = buildMigratedDatabase(MIGRATIONS);
_setTestDatabase(db);
moduleDatabase.close();

const MEMBER = db.prepare(`
  INSERT INTO users (username, display_name, password_hash, avatar_color, role, family_role)
  VALUES (?, 'Mitglied', 'hash', '#7C3AED', 'member', 'parent')
`).run(`pantry-member-${randomUUID()}`).lastInsertRowid;

let tokenScopes = null;
const app = express();
app.use((req, _res, next) => {
  const user = db.prepare('SELECT id, role, family_role FROM users WHERE id = ?').get(MEMBER);
  req.authUserId = user.id;
  req.authRole = user.role;
  req.session = { userId: user.id, role: user.role };
  req.sessionModuleAccess = buildSessionModuleAccess(resolvePermissions(db, user));
  req.authScopes = tokenScopes;
  next();
});
app.use('/', dashboardRouter);
const server = http.createServer(app);
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const endpoint = `http://127.0.0.1:${server.address().port}/`;

test.after(async () => {
  await new Promise((resolve) => server.close(resolve));
  db.close();
});

async function dashboard() {
  const res = await fetch(endpoint);
  assert.equal(res.status, 200);
  return res.json();
}

// Die Uhr steht fest - „heute" darf nicht mit dem Kalender kippen, und die
// Zonen-Tests brauchen einen Zeitpunkt, an dem Haushaltstag und UTC-Tag
// auseinanderfallen. Nur `Date` wird gemockt; die Timer des HTTP-Servers
// laufen weiter.
function withClock(iso, zone, fn) {
  return async () => {
    db.prepare("INSERT OR REPLACE INTO sync_config (key, value) VALUES ('household_timezone', ?)").run(zone);
    mock.timers.enable({ apis: ['Date'], now: new Date(iso) });
    try {
      await fn();
    } finally {
      mock.timers.reset();
    }
  };
}

const LOC_FRIDGE = db.prepare("SELECT id FROM pantry_locations WHERE name = 'Kühlschrank'").get().id;

function seedItem(name, expiresOn, { quantity = 1, unit = 'pcs', location = LOC_FRIDGE, notes = null } = {}) {
  return db.prepare(`
    INSERT INTO pantry_items (name, quantity, unit, location_id, expires_on, notes, created_by)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(name, quantity, unit, location, expiresOn, notes, MEMBER).lastInsertRowid;
}

function clearItems() {
  db.prepare('DELETE FROM pantry_items').run();
}

// Bezugstag des Haushalts in allen Payload-Tests: 2026-09-23 (Europe/Berlin,
// 12:00 Uhr - weit weg von jeder Tagesgrenze).
const NOON_BERLIN = '2026-09-23T10:00:00.000Z';

test('Payload: abgelaufen zuerst, dann nach Resttagen - mit days_left aus dem Haushaltstag', withClock(NOON_BERLIN, 'Europe/Berlin', async () => {
  clearItems();
  seedItem('Joghurt', '2026-09-26');
  seedItem('Milch', '2026-09-22');
  seedItem('Sahne', '2026-09-23');
  seedItem('Quark', '2026-09-10');
  seedItem('Butter', '2026-09-24');

  const { pantryExpiring } = await dashboard();
  assert.deepEqual(pantryExpiring.items.map((i) => [i.name, i.days_left]), [
    ['Quark', -13], ['Milch', -1], ['Sahne', 0], ['Butter', 1], ['Joghurt', 3],
  ]);
  assert.equal(pantryExpiring.total, 5);
  assert.equal(pantryExpiring.expiredCount, 2);
  assert.equal(pantryExpiring.todayCount, 1);
}));

test('Payload: Horizont ist EXPIRY_SOON_DAYS inklusiv - Tag 7 drin, Tag 8 draussen', withClock(NOON_BERLIN, 'Europe/Berlin', async () => {
  assert.equal(EXPIRY_SOON_DAYS, 7, 'Vorbedingung: die Schwelle der Vorratsseite');
  clearItems();
  seedItem('Tag sieben', '2026-09-30');
  seedItem('Tag acht', '2026-10-01');
  seedItem('In zwanzig Tagen', '2026-10-13');

  const { pantryExpiring } = await dashboard();
  assert.deepEqual(pantryExpiring.items.map((i) => i.name), ['Tag sieben'],
    'die Kachel zeigt genau das, was die Vorratsseite als „läuft bald ab" markiert');
  assert.equal(pantryExpiring.total, 1);
}));

test('Payload: ohne MHD und leere Chargen stehen nicht in der Liste', withClock(NOON_BERLIN, 'Europe/Berlin', async () => {
  clearItems();
  seedItem('Salz', null);
  seedItem('Aufgebraucht', '2026-09-24', { quantity: 0 });
  seedItem('Eier', '2026-09-25', { quantity: 6 });

  const { pantryExpiring } = await dashboard();
  assert.deepEqual(pantryExpiring.items.map((i) => i.name), ['Eier'],
    'eine leere Charge hat nichts mehr, das ablaufen könnte');
  assert.equal(pantryExpiring.total, 1);
}));

test('Payload: die Liste ist gedeckelt, die Zahlen nicht', withClock(NOON_BERLIN, 'Europe/Berlin', async () => {
  clearItems();
  for (let i = 0; i < 9; i += 1) seedItem(`Artikel ${i}`, i < 7 ? '2026-09-20' : '2026-09-23');

  const { pantryExpiring } = await dashboard();
  assert.equal(pantryExpiring.items.length, listRowCap('2x2'),
    'der Server liefert die größte Fassung der Kachel, nicht mehr');
  assert.equal(pantryExpiring.total, 9, 'die Gesamtzahl zählt über den Deckel hinaus');
  assert.equal(pantryExpiring.expiredCount, 7);
  assert.equal(pantryExpiring.todayCount, 2);
  // Heute ablaufende stehen hinter sieben abgelaufenen und damit ausserhalb der
  // Liste - das Heute-Blatt bekommt sie trotzdem, aus einem eigenen Feld.
  assert.deepEqual(pantryExpiring.todayItems.map((i) => i.name).sort(), ['Artikel 7', 'Artikel 8']);
}));

test('Payload: schlank - nur die Felder, die Kachel und Heute-Blatt brauchen', withClock(NOON_BERLIN, 'Europe/Berlin', async () => {
  clearItems();
  seedItem('Frischkäse', '2026-09-23', { quantity: 200, unit: 'g', notes: 'Notiz bleibt auf der Vorratsseite' });

  const { pantryExpiring } = await dashboard();
  assert.deepEqual(Object.keys(pantryExpiring.items[0]).sort(),
    ['days_left', 'expires_on', 'id', 'location_icon', 'location_name', 'name', 'quantity', 'unit']);
  assert.equal(pantryExpiring.items[0].location_name, 'Kühlschrank');
  assert.ok(!JSON.stringify(pantryExpiring).includes('Notiz bleibt'), 'Notizen reisen nicht mit');
  assert.deepEqual(pantryExpiring.todayItems, [{ id: pantryExpiring.items[0].id, name: 'Frischkäse', quantity: 200, unit: 'g' }]);
}));

// --------------------------------------------------------------------------
// 3. Tagesgrenze der Haushaltszone
// --------------------------------------------------------------------------

test('Zonenrand: 00:30 in Berlin ist schon der 24. - der UTC-Tag (23.) wäre falsch', withClock('2026-09-23T22:30:00.000Z', 'Europe/Berlin', async () => {
  clearItems();
  seedItem('Gestern', '2026-09-23');
  seedItem('Heute', '2026-09-24');
  seedItem('Tag sieben', '2026-10-01');

  const { pantryExpiring } = await dashboard();
  assert.deepEqual(pantryExpiring.items.map((i) => [i.name, i.days_left]),
    [['Gestern', -1], ['Heute', 0], ['Tag sieben', 7]],
    'nach UTC stünde „Gestern" auf heute und „Tag sieben" ausserhalb des Horizonts');
  assert.equal(pantryExpiring.expiredCount, 1);
  assert.equal(pantryExpiring.todayCount, 1);
}));

test('Zonenrand: 20:00 in Los Angeles ist noch der 23. - UTC ist dort schon am 24.', withClock('2026-09-24T03:00:00.000Z', 'America/Los_Angeles', async () => {
  clearItems();
  seedItem('Heute', '2026-09-23');
  seedItem('Morgen', '2026-09-24');

  const { pantryExpiring } = await dashboard();
  assert.deepEqual(pantryExpiring.items.map((i) => [i.name, i.days_left]), [['Heute', 0], ['Morgen', 1]]);
  assert.equal(pantryExpiring.expiredCount, 0, 'nach UTC wäre „Heute" schon abgelaufen');
}));

// --------------------------------------------------------------------------
// 4. Rechte
// --------------------------------------------------------------------------

function setModuleAccess(access) {
  db.prepare(`
    INSERT OR REPLACE INTO access_permissions (subject_type, subject_id, resource_type, resource_key, access)
    VALUES ('user', ?, 'module', 'pantry', ?)
  `).run(String(MEMBER), access);
}

function clearModuleAccess() {
  db.prepare("DELETE FROM access_permissions WHERE subject_type = 'user' AND subject_id = ?").run(String(MEMBER));
}

const EMPTY = { items: [], todayItems: [], total: 0, expiredCount: 0, todayCount: 0 };

test('Rechte: Vorrat auf none liefert die leere Form, kein Name auf der Leitung', withClock(NOON_BERLIN, 'Europe/Berlin', async () => {
  clearItems();
  seedItem('Geheimer Kuchen', '2026-09-23');
  assert.equal((await dashboard()).pantryExpiring.total, 1, 'Vorbedingung: ohne Sperre steht er da');

  setModuleAccess('none');
  try {
    const body = await dashboard();
    assert.deepEqual(body.pantryExpiring, EMPTY);
    assert.ok(!JSON.stringify(body).includes('Geheimer Kuchen'));
  } finally {
    clearModuleAccess();
  }
}));

test('Rechte: nur lesen ist keine Sperre', withClock(NOON_BERLIN, 'Europe/Berlin', async () => {
  clearItems();
  seedItem('Brot', '2026-09-24');
  setModuleAccess('read');
  try {
    assert.equal((await dashboard()).pantryExpiring.items[0]?.name, 'Brot');
  } finally {
    clearModuleAccess();
  }
}));

test('Rechte: ein Token ohne pantry-Scope bekommt die leere Form, mit pantry:read die Liste', withClock(NOON_BERLIN, 'Europe/Berlin', async () => {
  clearItems();
  seedItem('Brot', '2026-09-24');
  tokenScopes = ['dashboard:read'];
  try {
    assert.deepEqual((await dashboard()).pantryExpiring, EMPTY);
    tokenScopes = ['dashboard:read', 'pantry:read'];
    assert.equal((await dashboard()).pantryExpiring.items[0]?.name, 'Brot');
  } finally {
    tokenScopes = null;
  }
}));

test('Fehlerpfad: eine scheiternde Vorratsabfrage setzt null und lässt den Rest stehen', withClock(NOON_BERLIN, 'Europe/Berlin', async () => {
  db.exec('ALTER TABLE pantry_items RENAME TO pantry_items_unavailable');
  try {
    const body = await dashboard();
    assert.equal(body.pantryExpiring, null, 'null ist der Fehler-Sentinel: die Kachel zeigt „erneut versuchen"');
    assert.ok(Array.isArray(body.users), 'der Rest der Übersicht kommt an');
  } finally {
    db.exec('ALTER TABLE pantry_items_unavailable RENAME TO pantry_items');
  }
}));

// --------------------------------------------------------------------------
// Renderer
// --------------------------------------------------------------------------

// `hasIcon()` fragt das Lucide-Register im Fenster: zwei bekannte Zeichen
// reichen, um den Rückfall für ein unbekanntes zu messen.
globalThis.window ??= {};
globalThis.window.lucide = { icons: { Refrigerator: {}, Package: {} } };

function row(id, daysLeft, overrides = {}) {
  return {
    id, name: `Artikel ${id}`, quantity: 1, unit: 'pcs', expires_on: `2026-09-${String(23 + daysLeft).padStart(2, '0')}`,
    days_left: daysLeft, location_name: 'Kühlschrank', location_icon: 'refrigerator', ...overrides,
  };
}

function slice(items, total = items.length) {
  return {
    items, todayItems: [], total,
    expiredCount: items.filter((i) => i.days_left < 0).length,
    todayCount: items.filter((i) => i.days_left === 0).length,
  };
}

const zeilen = (html) => (html.match(/class="pantry-widget-row"/g) || []).length;

test('Renderer: ein Ladefehler (null) wirft, damit die geteilte Fehlerkachel greift', () => {
  // Mit der eigenen Meldung - ein TypeError aus einem fehlenden Renderer wäre
  // auch ein Wurf und machte diesen Test vor dem Bau grün.
  assert.throws(() => renderPantryWidget(null, '1x2'), /pantry widget slice failed to load/);
});

test('Renderer: leer ist ruhig und nennt den Horizont', () => {
  const html = renderPantryWidget(slice([]), '1x2');
  assert.match(html, /dashboard\.pantryExpiringEmpty\{&quot;count&quot;:7\}|dashboard\.pantryExpiringEmpty\{"count":7\}/,
    'der Leerzustand sagt, wie weit die Kachel schaut');
  assert.doesNotMatch(html, /widget__badge/, 'keine 0-Badge neben einem Leerzustand');
  assert.doesNotMatch(html, /widget__empty-cta/, 'kein Handlungsknopf - die Kachel ist reine Anzeige');
});

test('Renderer: Zeilendeckel folgt der Kachelhöhe (listRowCap), 1x1 und 2x1 flach, 1x2 hoch', () => {
  const items = [-2, -1, 0, 1, 2].map((d, i) => row(i + 1, d));
  assert.equal(zeilen(renderPantryWidget(slice(items, 8), '1x1')), listRowCap('1x1'));
  assert.equal(zeilen(renderPantryWidget(slice(items, 8), '2x1')), listRowCap('2x1'));
  assert.equal(zeilen(renderPantryWidget(slice(items, 8), '1x2')), listRowCap('1x2'));
});

test('Renderer: Badge und „+N weitere" rechnen gegen die Server-Gesamtzahl', () => {
  const items = [-2, -1, 0, 1, 2].map((d, i) => row(i + 1, d));
  const flach = renderPantryWidget(slice(items, 8), '1x1');
  assert.match(flach, /widget__badge">8</, 'die Badge zählt alle im Horizont, nicht die gezeigten');
  assert.match(flach, /dashboard\.pantryExpiringMore\{&quot;count&quot;:5\}/, '8 im Horizont, 3 gezeigt');
  const passt = renderPantryWidget(slice(items.slice(0, 2)), '1x2');
  assert.doesNotMatch(passt, /pantryExpiringMore/, 'ohne Überlauf keine Fussnote');
});

test('Renderer: Ton nach Dringlichkeit - abgelaufen, heute/morgen, später', () => {
  const html = renderPantryWidget(slice([row(1, -3), row(2, -1), row(3, 0), row(4, 1), row(5, 4)]), '1x2');
  const toene = [...html.matchAll(/pantry-widget-row__days--(\w+)/g)].map((m) => m[1]);
  assert.deepEqual(toene, ['expired', 'expired', 'now', 'now', 'soon']);
});

test('Renderer: Resttage in Worten aus den Vorrats-Texten', () => {
  const html = renderPantryWidget(slice([row(1, -3), row(2, -1), row(3, 0), row(4, 1), row(5, 4)]), '1x2');
  assert.match(html, /pantry\.badgeExpiredDays\{&quot;count&quot;:3\}/);
  assert.match(html, /pantry\.badgeExpiredYesterday/);
  assert.match(html, /pantry\.badgeExpiresToday/);
  assert.match(html, /pantry\.badgeExpiresTomorrow/);
  assert.match(html, /pantry\.badgeExpiresDays\{&quot;count&quot;:4\}/);
});

test('Renderer: Zeilen führen in den passend gefilterten Vorrat, der Kopf in den ganzen', () => {
  const html = renderPantryWidget(slice([row(1, -1), row(2, 2)]), '1x2');
  assert.match(html, /class="pantry-widget-row" data-route="\/pantry\?filter=expired"/);
  assert.match(html, /class="pantry-widget-row" data-route="\/pantry\?filter=soon"/);
  assert.match(html, /class="widget__link"/);
  assert.match(html, /data-route="\/pantry" class="widget__link"|href="\/pantry" data-route="\/pantry"/,
    'der Kopf-Link führt auf /pantry - mit Query liefe das Siegel auf den Slug „pantry?filter=…"');
});

test('Renderer: Name und Menge werden escaped, die Menge steht knapp', () => {
  const html = renderPantryWidget(slice([row(1, 0, { name: '<img src=x>', quantity: 2.5, unit: 'kg' })]), '1x2');
  assert.doesNotMatch(html, /<img src=x>/);
  assert.match(html, /&lt;img src=x&gt;/);
  assert.match(html, /2,5 kg/);
});

test('Renderer: das Lagerort-Zeichen fällt bei unbekanntem Namen auf package zurück', () => {
  const html = renderPantryWidget(slice([row(1, 0), row(2, 1, { location_icon: 'kein-solches-zeichen' })]), '1x2');
  const zeichen = [...html.matchAll(/pantry-widget-row__icon" aria-hidden="true"><i data-lucide="([^"]+)"/g)].map((m) => m[1]);
  assert.deepEqual(zeichen, ['refrigerator', 'package'], 'ein leerer Kreis wäre die stille Fassung desselben Fehlers');
});

// --------------------------------------------------------------------------
// Der Filter-Deep-Link der Vorratsseite
// --------------------------------------------------------------------------

test('Vorratsseite: ?filter= öffnet den passenden Chip, Unbekanntes bleibt bei „Alle"', () => {
  assert.equal(pantryFilterFromSearch('?filter=expired'), 'expired');
  assert.equal(pantryFilterFromSearch('?filter=soon'), 'soon');
  assert.equal(pantryFilterFromSearch('?filter=low'), 'low');
  assert.equal(pantryFilterFromSearch('?filter=__proto__'), null);
  assert.equal(pantryFilterFromSearch(''), null);
  const page = src('../public/pages/pantry.js');
  assert.match(page, /pantryFilterFromSearch\(window\.location\.search\)/, 'die Seite liest den Link beim Rendern');
});

// --------------------------------------------------------------------------
// Heute-Blatt: „Läuft heute ab" dockt am Beitrags-Vertrag an (Integration)
// --------------------------------------------------------------------------

/* Was HEUTE abläuft, ist eine Sache von heute - das Heute-Blatt nannte sie
 * nicht und sagte daneben „Danach steht heute nichts mehr an". Die Quelle
 * spricht nach denselben drei Riegeln wie jede andere (Modul an, Widget-Recht,
 * Kein-Echo gegen die Vorrats-Kachel) und hält die Coda auf. */
const { setPermissions, clearPermissions } = await import('../public/permissions.js');

function withSheet(perms, fn) {
  const prevWindow = global.window;
  global.window = { yuvomi: { isModuleDisabled: () => false } };
  setPermissions({ admin: false, modules: {}, widgets: {}, capabilities: {}, ...perms });
  try {
    return fn();
  } finally {
    clearPermissions();
    global.window = prevWindow;
  }
}

const expiringToday = (names, todayCount = names.length) => ({
  items: [], total: todayCount, expiredCount: 0, todayCount,
  todayItems: names.map((name, i) => ({ id: i + 1, name, quantity: 1, unit: 'l' })),
});
const birthdayToday = [{ id: 9, name: 'Oma Erna', days_until: 0, kind: 'birthday' }];
const sheetRows = (model) => model.rows.filter((row) => row.kind === 'pantry');

test('Heute-Blatt: was heute abläuft, steht als eine Zeile im Blatt und hält die Coda auf', () => withSheet({}, () => {
  const model = __test.buildTodayCockpitModel(
    { birthdays: birthdayToday, pantryExpiring: expiringToday(['Milch', 'Joghurt']) }, [],
  );
  const rows = sheetRows(model);
  assert.equal(rows.length, 1, `zwei Chargen von heute sind eine Zeile, erhalten: ${model.rows.map((r) => r.kind)}`);
  assert.match(rows[0].title, /Milch.*Joghurt/);
  assert.match(rows[0].sub, /pantry\.badgeExpiresToday/, 'der Text ist der der Vorratsseite (pantryExpiryPhrase(0))');
  assert.equal(rows[0].tone, 'pantry');
  assert.match(rows[0].route, /^\/pantry\?filter=soon$/, 'die Zeile öffnet den Vorrat mit dem passenden Filter');
  assert.equal(model.coda, null, 'solange heute etwas abläuft, keine Entwarnung');

  const nothing = __test.buildTodayCockpitModel({ birthdays: birthdayToday, pantryExpiring: expiringToday([]) }, []);
  assert.equal(sheetRows(nothing).length, 0);
  assert.match(String(nothing.coda), /todayNothingElse/, 'Gegenprobe: ohne Ablauf fällt die Coda');
}));

test('Heute-Blatt: mehr als die gelieferten Chargen - der Rest steht als Zahl da', () => withSheet({}, () => {
  const model = __test.buildTodayCockpitModel({ pantryExpiring: expiringToday(['A', 'B', 'C', 'D', 'E'], 7) }, []);
  assert.match(sheetRows(model)[0].title, /pantryExpiringMore.*"count":2/, 'todayCount ist ungedeckelt, die Liste nicht');
}));

test('Heute-Blatt: Kein-Echo gegen die Vorrats-Kachel, Rechte und Modulschalter', () => {
  const data = { pantryExpiring: expiringToday(['Milch']) };
  withSheet({}, () => {
    const beside = __test.buildTodayCockpitModel(data, [{ id: 'pantry', visible: true, size: '1x2' }]);
    assert.equal(sheetRows(beside).length, 0, 'neben der sichtbaren Kachel keine zweite Zeile');
    const hiddenTile = __test.buildTodayCockpitModel(data, [{ id: 'pantry', visible: false, size: '1x2' }]);
    assert.equal(sheetRows(hiddenTile).length, 1, 'ausgeblendete Kachel: das Blatt spricht');
  });
  withSheet({ modules: { pantry: 'none' } }, () => {
    assert.equal(sheetRows(__test.buildTodayCockpitModel(data, [])).length, 0, 'ohne Vorratsrecht keine Zeile');
  });
  withSheet({ widgets: { pantry: 'none' } }, () => {
    assert.equal(sheetRows(__test.buildTodayCockpitModel(data, [])).length, 0, 'gesperrtes Widget heisst auch: keine Zeile (#467)');
  });
  const prevWindow = global.window;
  try {
    withSheet({}, () => {
      global.window = { yuvomi: { isModuleDisabled: (m) => m === 'pantry' } };
      assert.equal(sheetRows(__test.buildTodayCockpitModel(data, [])).length, 0, 'abgeschaltetes Modul spricht nicht');
    });
  } finally {
    global.window = prevWindow;
  }
  withSheet({}, () => {
    assert.equal(sheetRows(__test.buildTodayCockpitModel({ pantryExpiring: null }, [])).length, 0,
      'ein Ladefehler (null) ist keine Zeile');
  });
});

test('Heute-Blatt: die Vorratszeile hat ihren Ton in Cockpit und Wand', () => {
  const css = src('../public/styles/dashboard.css');
  assert.match(css, /\.today-cockpit-card--pantry\s*\{\s*--today-card-accent:\s*var\(--module-pantry\)/);
  assert.match(css, /\.wall-row--pantry\s*\{\s*--wall-row-accent:\s*var\(--module-pantry\)/);
});
