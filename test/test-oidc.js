/**
 * Tests: OIDC/SSO-Integration
 * Ausführen: node --experimental-sqlite test-oidc.js
 */
import { DatabaseSync } from 'node:sqlite';
import { readFileSync, readdirSync } from 'node:fs';
import { MIGRATIONS_SQL } from '../server/db-schema-test.js';

let passed = 0;
let failed = 0;

function test(name, fn) {
  try {
    fn();
    console.log(`  ✓ ${name}`);
    passed++;
  } catch (err) {
    console.error(`  ✗ ${name}`);
    console.error(`    ${err.message}`);
    failed++;
  }
}

function assert(condition, message) {
  if (!condition) throw new Error(message || 'Assertion fehlgeschlagen');
}

// ─── Hilfsfunktion: Schema-DB aufbauen ───────────────────────────────────────

function buildSchemaDb() {
  const db = new DatabaseSync(':memory:');
  db.exec('PRAGMA foreign_keys = ON;');
  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version     INTEGER PRIMARY KEY,
      description TEXT NOT NULL,
      applied_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
    );
  `);
  // MIGRATIONS_SQL[1] ist ein zusammengeführter Basis-Snapshot aller Tabellen
  // bis v10 (kein sequentielles Replay — db-schema-test.js ist kein inkrementeller
  // Migrations-Log). Migration 42 wird danach als echter Schritt angewendet.
  db.exec(MIGRATIONS_SQL[1]);
  if (MIGRATIONS_SQL[42]) db.exec(MIGRATIONS_SQL[42]);
  return db;
}

console.log('\n[OIDC-Test] Migration v42 — Schema\n');

test('users-Tabelle hat oidc_sub-Spalte', () => {
  const db = buildSchemaDb();
  const cols = db.prepare("PRAGMA table_info(users)").all();
  const colNames = cols.map(c => c.name);
  assert(colNames.includes('oidc_sub'), `oidc_sub fehlt in: ${colNames.join(', ')}`);
});

test('users-Tabelle hat oidc_provider-Spalte', () => {
  const db = buildSchemaDb();
  const cols = db.prepare("PRAGMA table_info(users)").all();
  const colNames = cols.map(c => c.name);
  assert(colNames.includes('oidc_provider'), `oidc_provider fehlt in: ${colNames.join(', ')}`);
});

test('Eindeutiger Index idx_users_oidc_sub existiert', () => {
  const db = buildSchemaDb();
  const idx = db.prepare("SELECT name FROM sqlite_master WHERE type='index' AND name='idx_users_oidc_sub'").get();
  assert(idx !== undefined, 'Index idx_users_oidc_sub nicht gefunden');
});

test('OIDC-Nutzer kann ohne Passwort angelegt werden', () => {
  const db = buildSchemaDb();
  db.exec(`
    INSERT INTO users (username, display_name, password_hash, avatar_color, role, oidc_sub, oidc_provider)
    VALUES ('oidcuser', 'OIDC User', '$oidc$', '#007AFF', 'member', 'sub-abc-123', 'oidc')
  `);
  const user = db.prepare("SELECT * FROM users WHERE oidc_sub = 'sub-abc-123'").get();
  assert(user !== undefined, 'Nutzer nicht gefunden');
  assert(user.password_hash === '$oidc$', `Falscher password_hash: ${user.password_hash}`);
});

test('oidc_sub ist unique — doppelter sub wird abgelehnt', () => {
  const db = buildSchemaDb();
  db.exec(`
    INSERT INTO users (username, display_name, password_hash, avatar_color, role, oidc_sub, oidc_provider)
    VALUES ('user1', 'User One', '$oidc$', '#007AFF', 'member', 'sub-duplicate', 'oidc')
  `);
  let threw = false;
  try {
    db.exec(`
      INSERT INTO users (username, display_name, password_hash, avatar_color, role, oidc_sub, oidc_provider)
      VALUES ('user2', 'User Two', '$oidc$', '#34C759', 'member', 'sub-duplicate', 'oidc')
    `);
  } catch {
    threw = true;
  }
  assert(threw, 'UNIQUE-Verletzung auf oidc_sub hätte einen Fehler werfen müssen');
});

// ─── isOidcEnabled ────────────────────────────────────────────────────────────
// Hinweis: Da server/services/oidc.js process.env beim Import liest,
// setzen wir die Vars vor dem Import und testen synchron.

console.log('\n[OIDC-Test] isOidcEnabled\n');

// Alle vier Vars gesetzt → aktiviert
{
  process.env.OIDC_ISSUER         = 'https://idp.example.com';
  process.env.OIDC_CLIENT_ID      = 'oikos';
  process.env.OIDC_CLIENT_SECRET  = 'secret';
  process.env.OIDC_REDIRECT_URI   = 'https://app.example.com/callback';

  const { isOidcEnabled } = await import('../server/services/oidc.js');

  test('isOidcEnabled() → true wenn alle vier Vars gesetzt', () => {
    assert(isOidcEnabled() === true, 'Erwartet true');
  });

  delete process.env.OIDC_CLIENT_SECRET;

  test('isOidcEnabled() → false wenn OIDC_CLIENT_SECRET fehlt', () => {
    assert(isOidcEnabled() === false, 'Erwartet false');
  });

  delete process.env.OIDC_ISSUER;
  delete process.env.OIDC_CLIENT_ID;
  delete process.env.OIDC_REDIRECT_URI;
}

// ─── findOrCreateOidcUser ─────────────────────────────────────────────────────

console.log('\n[OIDC-Test] findOrCreateOidcUser\n');

// Seiteneffekte von server/auth.js neutralisieren, bevor importiert wird:
process.env.SESSION_SECRET = 'test-oidc-secret-minimum-32-chars-xx';
process.env.SESSION_SECURE = 'false';

const { _setTestDatabase } = await import('../server/db.js');
const sessionDb = buildSchemaDb(); // schema_migrations + alle Migrationen; die sessions-Tabelle legt der BetterSQLiteStore-Konstruktor selbst per CREATE TABLE IF NOT EXISTS an
_setTestDatabase(sessionDb);

const { findOrCreateOidcUser } = await import('../server/auth.js');

function buildOidcTestDb() {
  const db = new DatabaseSync(':memory:');
  db.exec('PRAGMA foreign_keys = ON;');
  // Minimales Schema für findOrCreateOidcUser-Tests
  db.exec(`
    CREATE TABLE users (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      username      TEXT UNIQUE NOT NULL,
      display_name  TEXT NOT NULL,
      password_hash TEXT NOT NULL,
      avatar_color  TEXT NOT NULL DEFAULT '#007AFF',
      role          TEXT NOT NULL DEFAULT 'member' CHECK(role IN ('admin','member')),
      family_role   TEXT,
      avatar_data   TEXT,
      oidc_sub      TEXT,
      oidc_provider TEXT,
      created_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
      updated_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
    );
    CREATE UNIQUE INDEX idx_users_oidc_sub ON users(oidc_sub) WHERE oidc_sub IS NOT NULL;
    CREATE TABLE split_expense_guest_users (
      user_id INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE
    );
    CREATE TABLE housekeeping_workers (
      id      INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL UNIQUE REFERENCES users(id) ON DELETE CASCADE
    );
    -- Die dritte Markierungstabelle neben Personal und Gaesten (#1208). Sie
    -- steht hier, weil canSignIn() sie liest: dieses Fixture baut das Schema
    -- von Hand, also faellt jede neue Tabelle, an der die Anmeldung haengt,
    -- hier als "no such table" auf - und zwar zu Recht.
    CREATE TABLE display_accounts (
      user_id    INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
      created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
      created_at TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
    );
    CREATE TABLE contacts (
      id             INTEGER PRIMARY KEY AUTOINCREMENT,
      name           TEXT NOT NULL,
      email          TEXT,
      family_user_id INTEGER REFERENCES users(id) ON DELETE CASCADE
    );
    CREATE TABLE contact_emails (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      contact_id INTEGER NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
      label      TEXT,
      value      TEXT NOT NULL,
      is_primary INTEGER NOT NULL DEFAULT 0
    );
  `);
  return db;
}

// Legt einen lokalen (Nicht-OIDC) Family-User samt Kontakt-E-Mail an.
function addLocalUserWithEmail(db, username, email) {
  const { lastInsertRowid: userId } = db.prepare(
    "INSERT INTO users (username, display_name, password_hash) VALUES (?, ?, '$2b$12$fakehash')",
  ).run(username, username);
  db.prepare(
    'INSERT INTO contacts (name, email, family_user_id) VALUES (?, ?, ?)',
  ).run(username, email, userId);
  return userId;
}

test('legt neuen Nutzer aus OIDC-Userinfo an', () => {
  const db = buildOidcTestDb();
  const userinfo = { sub: 'new-sub-001', email: 'alice@example.com', name: 'Alice', preferred_username: 'alice' };
  const user = findOrCreateOidcUser(db, userinfo);
  assert(user.oidc_sub === 'new-sub-001', `Falscher oidc_sub: ${user.oidc_sub}`);
  assert(user.display_name === 'Alice', `Falscher display_name: ${user.display_name}`);
  assert(user.password_hash === '$oidc$', `Falscher password_hash: ${user.password_hash}`);
  assert(user.role === 'member', `Falscher role: ${user.role}`);
});

test('findet bestehenden Nutzer über oidc_sub', () => {
  const db = buildOidcTestDb();
  db.exec(`INSERT INTO users (username, display_name, password_hash, oidc_sub, oidc_provider)
           VALUES ('bob', 'Bob', '$oidc$', 'existing-sub-002', 'oidc')`);
  const userinfo = { sub: 'existing-sub-002', email: 'bob@example.com', name: 'Bob' };
  const user = findOrCreateOidcUser(db, userinfo);
  const count = db.prepare('SELECT count(*) as n FROM users').get();
  assert(count.n === 1, 'Es darf kein zweiter Nutzer angelegt werden');
  assert(user.oidc_sub === 'existing-sub-002', 'Falscher oidc_sub');
});

test('verknüpft bestehenden Account bei verifizierter E-Mail (email_verified=true)', () => {
  const db = buildOidcTestDb();
  const localId = addLocalUserWithEmail(db, 'charlie', 'charlie@example.com');
  const userinfo = { sub: 'link-sub-003', email: 'charlie@example.com', email_verified: true, name: 'Charlie' };
  const user = findOrCreateOidcUser(db, userinfo);
  const count = db.prepare('SELECT count(*) as n FROM users').get();
  assert(count.n === 1, 'Es darf KEIN zweiter Account angelegt werden — Linking erwartet');
  assert(user.id === localId, `Falscher User verknüpft: ${user.id} statt ${localId}`);
  assert(user.oidc_sub === 'link-sub-003', `oidc_sub nicht gesetzt: ${user.oidc_sub}`);
});

test('verknüpft auch über sekundäre contact_emails-Adresse', () => {
  const db = buildOidcTestDb();
  const userId = addLocalUserWithEmail(db, 'cora', 'cora.primary@example.com');
  const contact = db.prepare('SELECT id FROM contacts WHERE family_user_id = ?').get(userId);
  db.prepare("INSERT INTO contact_emails (contact_id, label, value, is_primary) VALUES (?, 'work', ?, 0)")
    .run(contact.id, 'cora.work@example.com');
  const userinfo = { sub: 'link-sub-sec', email: 'cora.work@example.com', email_verified: true };
  const user = findOrCreateOidcUser(db, userinfo);
  const count = db.prepare('SELECT count(*) as n FROM users').get();
  assert(count.n === 1, 'Sekundär-E-Mail muss verknüpfen, nicht neu anlegen');
  assert(user.id === userId, `Falscher User verknüpft: ${user.id}`);
});

test('matcht E-Mail case-insensitiv', () => {
  const db = buildOidcTestDb();
  const localId = addLocalUserWithEmail(db, 'carol', 'Carol@Example.com');
  const userinfo = { sub: 'link-sub-ci', email: 'carol@example.COM', email_verified: true };
  const user = findOrCreateOidcUser(db, userinfo);
  assert(user.id === localId, 'Case-insensitiver E-Mail-Match fehlgeschlagen');
});

test('verknüpft NICHT bei unverifizierter E-Mail (Takeover-Schutz)', () => {
  const db = buildOidcTestDb();
  addLocalUserWithEmail(db, 'charlie', 'charlie@example.com');
  const userinfo = { sub: 'link-sub-004', email: 'charlie@example.com', email_verified: false, name: 'Charlie' };
  const user = findOrCreateOidcUser(db, userinfo);
  const count = db.prepare('SELECT count(*) as n FROM users').get();
  assert(count.n === 2, 'Ohne email_verified muss ein separater Account entstehen');
  assert(user.oidc_sub === 'link-sub-004', `oidc_sub nicht gesetzt: ${user.oidc_sub}`);
  const local = db.prepare("SELECT * FROM users WHERE username = 'charlie'").get();
  assert(local.oidc_sub === null, 'Unverifizierte E-Mail darf keinen Account übernehmen');
});

test('verknüpft NICHT wenn email_verified fehlt (Standard — sicherer Default)', () => {
  delete process.env.OIDC_TRUST_EMAIL_WITHOUT_VERIFIED_CLAIM;
  const db = buildOidcTestDb();
  addLocalUserWithEmail(db, 'charlie', 'charlie@example.com');
  const userinfo = { sub: 'link-sub-005', email: 'charlie@example.com' }; // kein email_verified
  findOrCreateOidcUser(db, userinfo);
  const count = db.prepare('SELECT count(*) as n FROM users').get();
  assert(count.n === 2, 'Fehlendes email_verified darf ohne Opt-in nicht verknüpfen');
});

test('verknüpft wenn email_verified fehlt und OIDC_TRUST_EMAIL_WITHOUT_VERIFIED_CLAIM=true', () => {
  process.env.OIDC_TRUST_EMAIL_WITHOUT_VERIFIED_CLAIM = 'true';
  const db = buildOidcTestDb();
  addLocalUserWithEmail(db, 'charlie', 'charlie@example.com');
  const userinfo = { sub: 'link-sub-005b', email: 'charlie@example.com' }; // kein email_verified
  const user = findOrCreateOidcUser(db, userinfo);
  const count = db.prepare('SELECT count(*) as n FROM users').get();
  assert(count.n === 1, 'Mit Opt-in soll fehlender Claim verknüpfen');
  assert(user.oidc_sub === 'link-sub-005b', `oidc_sub nicht gesetzt: ${user.oidc_sub}`);
  delete process.env.OIDC_TRUST_EMAIL_WITHOUT_VERIFIED_CLAIM;
});

test('verknüpft NICHT bei mehrdeutiger E-Mail (mehrere Treffer)', () => {
  const db = buildOidcTestDb();
  addLocalUserWithEmail(db, 'twin-a', 'twins@example.com');
  addLocalUserWithEmail(db, 'twin-b', 'twins@example.com');
  const userinfo = { sub: 'link-sub-006', email: 'twins@example.com', email_verified: true };
  const user = findOrCreateOidcUser(db, userinfo);
  const count = db.prepare('SELECT count(*) as n FROM users').get();
  assert(count.n === 3, 'Mehrdeutige E-Mail muss neuen Account erzeugen, nicht raten');
  assert(user.oidc_sub === 'link-sub-006', 'Neuer Account muss oidc_sub tragen');
});

test('verknüpft NICHT mit bereits OIDC-gebundenem Account', () => {
  const db = buildOidcTestDb();
  const { lastInsertRowid: userId } = db.prepare(
    "INSERT INTO users (username, display_name, password_hash, oidc_sub, oidc_provider) VALUES ('linked', 'Linked', '$oidc$', 'other-sub', 'oidc')",
  ).run();
  db.prepare('INSERT INTO contacts (name, email, family_user_id) VALUES (?, ?, ?)')
    .run('linked', 'shared@example.com', userId);
  const userinfo = { sub: 'link-sub-007', email: 'shared@example.com', email_verified: true };
  const user = findOrCreateOidcUser(db, userinfo);
  const count = db.prepare('SELECT count(*) as n FROM users').get();
  assert(count.n === 2, 'Ein bereits gebundener Account darf nicht erneut verknüpft werden');
  assert(user.oidc_sub === 'link-sub-007', 'Neuer Account muss eigenen sub tragen');
});

test('verknüpft KEIN Konto der Haushaltshilfe über die E-Mail', () => {
  // Sonst truege das Personal-Konto den sub, und jede spaetere SSO-Anmeldung
  // faende es in Schritt 1. Dass der Callback es abweist, prueft
  // test-staff-sign-in.js am echten Router.
  const db = buildOidcTestDb();
  const staffId = addLocalUserWithEmail(db, 'hilfe', 'hilfe@example.com');
  db.prepare('INSERT INTO housekeeping_workers (user_id) VALUES (?)').run(staffId);
  const user = findOrCreateOidcUser(db, { sub: 'link-sub-staff', email: 'hilfe@example.com', email_verified: true });
  assert(user.id === staffId, `Erwartet das Personal-Konto ${staffId}, war ${user.id}`);
  assert(user.oidc_sub === null, `sub an ein Personal-Konto geschrieben: ${user.oidc_sub}`);
  const count = db.prepare('SELECT count(*) as n FROM users').get();
  assert(count.n === 1, 'Es darf auch kein Ersatzkonto entstehen');
});

test('vergibt eindeutigen username bei Kollision', () => {
  const db = buildOidcTestDb();
  db.exec(`INSERT INTO users (username, display_name, password_hash)
           VALUES ('dana', 'Dana Local', '$2b$12$fakehash')`);
  const userinfo = { sub: 'collide-sub', preferred_username: 'dana', email: 'dana@example.com' };
  const user = findOrCreateOidcUser(db, userinfo);
  assert(user.username !== 'dana', `Username-Kollision nicht aufgelöst: ${user.username}`);
  assert(user.username.startsWith('dana-'), `Unerwarteter Username: ${user.username}`);
});

test('legt Nutzer ohne Name mit preferred_username als display_name an', () => {
  const db = buildOidcTestDb();
  const userinfo = { sub: 'no-name-sub', preferred_username: 'dana', email: 'dana@example.com' };
  const user = findOrCreateOidcUser(db, userinfo);
  assert(user.display_name === 'dana', `Falscher display_name: ${user.display_name}`);
});

// ─── Username-Ableitung (#653) ────────────────────────────────────────────────

// Das app-weite Username-Format aus /setup, /invites und den User-Routen.
const USERNAME_PATTERN = /^[a-zA-Z0-9._-]{3,64}$/;

/* ────────────────────────────────────────────────────────────────────────────
 * Das Format steht ZEHNMAL von Hand da - und diese Zeile war die elfte
 *
 * #653 war kein OIDC-Fehler, sondern ein Drift-Fehler: die OIDC-Anlage schrieb
 * an einer Kopie des Formats vorbei, und weil der User-PUT den unveraenderten
 * Bestandsnamen revalidiert, liess sich ein so benanntes Konto danach gar nicht
 * mehr speichern. Die Guard-Abdeckung fuehrte es mit „fuenfmal in
 * server/auth.js"; gezaehlt sind es zehn, in sechs Dateien, ueber Backend,
 * Frontend und Installer.
 *
 * WARUM KEINE GETEILTE KONSTANTE: es gibt keine Datei, die alle drei erreichen.
 * `public/` wird ausgeliefert und darf nichts aus `server/` importieren,
 * `tools/installer/install.html` steht allein und laeuft vor der ersten
 * Installation. Eine Konstante wuerde die Kopien also nicht abschaffen, nur
 * verstecken - und die Zusage ist ohnehin nicht „es gibt eine Stelle", sondern
 * „alle Stellen sagen dasselbe". Genau das prueft dieser Guard.
 *
 * GESUCHT WIRD DIE BAUART, NICHT DER WERT: jedes anker-gebundene
 * Zeichenklassen-Literal mit Laengenangabe (`/^[...]{n,m}$/`), das auf einer
 * Zeile steht, die von einem Nutzernamen spricht. Ein Guard, der nach
 * `{3,64}` sucht, faende genau die Kopien, die den richtigen Wert schon haben -
 * er waere blind fuer die abweichende, also fuer die einzige, die zaehlt.
 * Gemessen: zwoelf Literale dieser Bauart im Repo, zehn davon Usernamen; die
 * zwei anderen (Metrik-Schluessel in health/cycle.js, Laendercode in
 * weather.js) nennen auf ihrer Zeile keinen Nutzer und fallen richtig heraus.
 * ──────────────────────────────────────────────────────────────────────────── */

const USERNAME_PATTERN_SHAPE = /\/\^\[[^\]]+\]\{\d+,\d+\}\$\//g;
const SPEAKS_OF_USER = /user/i;

/** Jede Quelldatei unter den drei Baeumen, in denen ein Username validiert wird. */
function sourceFiles() {
  const found = [];
  const walk = (dir) => {
    for (const entry of readdirSync(new URL(dir, import.meta.url), { withFileTypes: true })) {
      const next = `${dir}${entry.name}`;
      if (entry.isDirectory()) {
        if (/node_modules|vendor/.test(entry.name)) continue;
        walk(`${next}/`);
      } else if (/\.(js|html)$/.test(entry.name)) {
        found.push(next);
      }
    }
  };
  for (const dir of ['../server/', '../public/', '../tools/']) walk(dir);
  return found;
}

test('das app-weite Username-Format steht ueberall gleich da', () => {
  const expected = USERNAME_PATTERN.toString();
  const sites = [];
  const findings = [];

  for (const file of sourceFiles()) {
    const src = readFileSync(new URL(file, import.meta.url), 'utf8');
    const lines = src.split('\n');
    lines.forEach((line, index) => {
      for (const match of line.matchAll(USERNAME_PATTERN_SHAPE)) {
        if (!SPEAKS_OF_USER.test(line)) continue;
        const at = `${file.replace(/^\.\.\//, '')}:${index + 1}`;
        sites.push(at);
        if (match[0] !== expected) {
          findings.push(`${at}: ${match[0]} statt ${expected}`);
        }
      }
    });
  }

  // Ein Guard, der nichts gemessen hat, darf nicht urteilen. Ohne diese
  // Zusicherung waere eine kaputte Suche von „alle Kopien stimmen" nicht zu
  // unterscheiden - und das ist hier die wahrscheinlichere Fehlerart, weil der
  // Guard ueber eine Textform laeuft.
  assert(sites.length >= 8,
    `Nur ${sites.length} Fundstellen des Username-Formats gesehen (gemessen: 10 in sechs Dateien). `
    + 'Die Suche greift nicht mehr - entweder hat sich die Schreibweise geaendert, oder eine '
    + 'Validierung ist in eine Datei gewandert, die hier nicht durchsucht wird.');

  assert(findings.length === 0,
    'Eine Kopie des Username-Formats weicht ab. Das ist der Fehler aus #653: die OIDC-Anlage '
    + 'schrieb an einer Kopie vorbei, und weil der User-PUT den unveraenderten Bestandsnamen '
    + 'revalidiert, liess sich das entstandene Konto danach gar nicht mehr speichern. Wer das '
    + 'Format aendert, aendert ALLE Fundstellen - Backend, Frontend und Installer.\n    '
    + findings.join('\n    '));
});

test('der OIDC-Bereiniger laesst genau die Zeichen durch, die das Format erlaubt', () => {
  // Die zweite Haelfte derselben Zusage, und die Stelle, an der #653 wirklich
  // sass: `sanitizeOidcUsername` filtert ueber eine NEGIERTE Zeichenklasse
  // (`[^a-zA-Z0-9._-]`). Laeuft die auseinander, erzeugt der Bereiniger genau
  // die Namen, die die Validierung danach ablehnt - und dieser Fall faellt in
  // keinem Test auf, der nur die Validierung prueft.
  const auth = readFileSync(new URL('../server/auth.js', import.meta.url), 'utf8');
  const classes = [...auth.matchAll(/\[\^([^\]]+)\]\+?/g)]
    .map((m) => m[1])
    .filter((cls) => /a-zA-Z0-9/.test(cls));
  assert(classes.length >= 1,
    'Keine negierte Zeichenklasse in server/auth.js gefunden - sanitizeOidcUsername '
    + 'filtert anders als beim Bau dieses Guards, der Guard gehoert nachgezogen.');

  const allowed = USERNAME_PATTERN.source.match(/\[([^\]]+)\]/)[1];
  const mismatched = classes.filter((cls) => cls !== allowed);
  assert(mismatched.length === 0,
    `Der Bereiniger laesst "${mismatched.join('", "')}" durch, das Format erlaubt "${allowed}". `
    + 'Ein Bereiniger, der mehr durchlaesst als die Validierung annimmt, erzeugt Konten, die '
    + 'sich nicht mehr speichern lassen (#653).');
});

test('nutzt die E-Mail NICHT als username-Fallback', () => {
  const db = buildOidcTestDb();
  const userinfo = { sub: 'synology-user-01', email: 'familie@example.com', name: 'Kind Eins' };
  const user = findOrCreateOidcUser(db, userinfo);
  assert(!user.username.includes('@'), `E-Mail als username übernommen: ${user.username}`);
  assert(user.username === 'synology-user-01', `Falscher username: ${user.username}`);
});

test('geteilte Familien-E-Mail erzeugt getrennte, eindeutige Usernamen', () => {
  const db = buildOidcTestDb();
  const shared = 'familie@example.com';
  const first  = findOrCreateOidcUser(db, { sub: 'kind-eins', email: shared, name: 'Kind Eins' });
  const second = findOrCreateOidcUser(db, { sub: 'kind-zwei', email: shared, name: 'Kind Zwei' });
  assert(first.username === 'kind-eins', `Falscher username: ${first.username}`);
  assert(second.username === 'kind-zwei', `Falscher username: ${second.username}`);
  assert(first.id !== second.id, 'Zwei subs müssen zwei Accounts ergeben');
});

test('sub dient ohne oidc--Präfix als Fallback', () => {
  const db = buildOidcTestDb();
  const user = findOrCreateOidcUser(db, { sub: '550e8400-e29b-41d4-a716-446655440000' });
  assert(user.username === '550e8400-e29b-41d4-a716-446655440000', `Falscher username: ${user.username}`);
});

test('nutzt den non-standard username-Claim vor dem sub', () => {
  const db = buildOidcTestDb();
  const userinfo = { sub: 'daniel@LDAP-Domain', username: 'daniel', email: 'daniel@example.com' };
  const user = findOrCreateOidcUser(db, userinfo);
  assert(user.username === 'daniel', `Falscher username: ${user.username}`);
});

test('abgeleiteter username erfüllt immer das app-weite Format', () => {
  const db = buildOidcTestDb();
  const cases = [
    { sub: 'daniel@LDAP-Domain' },                        // Synology: sub trägt den Directory-Teil
    { sub: 'x' },                                          // zu kurz → nächster Kandidat
    { sub: '@@@' },                                        // nach Bereinigung leer
    { sub: 'ok-1', preferred_username: 'Björn Müller' },   // Umlaute + Leerzeichen
    { sub: 'ok-2', preferred_username: 'a'.repeat(200) },  // über der Längengrenze
  ];
  for (const userinfo of cases) {
    const user = findOrCreateOidcUser(db, userinfo);
    assert(
      USERNAME_PATTERN.test(user.username),
      `Ungültiger username für sub=${userinfo.sub}: ${user.username}`,
    );
  }
});

test('transliteriert Diakritika statt sie zu Bindestrichen zu machen', () => {
  const db = buildOidcTestDb();
  const user = findOrCreateOidcUser(db, { sub: 'umlaut-sub', preferred_username: 'Björn Müller' });
  assert(user.username === 'Bjorn-Muller', `Falscher username: ${user.username}`);
});

// ─── oidc_provider aus dem iss-Claim (#653) ───────────────────────────────────

test('speichert den iss-Claim als oidc_provider', () => {
  const db = buildOidcTestDb();
  process.env.OIDC_ISSUER = 'https://cname.example.com/';
  const user = findOrCreateOidcUser(db, { sub: 'iss-sub-01', iss: 'https://real-idp.example.com/', preferred_username: 'ida' });
  delete process.env.OIDC_ISSUER;
  assert(user.oidc_provider === 'https://real-idp.example.com/', `Falscher oidc_provider: ${user.oidc_provider}`);
});

test('fällt ohne iss-Claim auf OIDC_ISSUER zurück', () => {
  const db = buildOidcTestDb();
  process.env.OIDC_ISSUER = 'https://idp.example.com/';
  const user = findOrCreateOidcUser(db, { sub: 'iss-sub-02', preferred_username: 'ivo' });
  delete process.env.OIDC_ISSUER;
  assert(user.oidc_provider === 'https://idp.example.com/', `Falscher oidc_provider: ${user.oidc_provider}`);
});

test('setzt beim Linking ebenfalls den iss-Claim', () => {
  const db = buildOidcTestDb();
  addLocalUserWithEmail(db, 'ingo', 'ingo@example.com');
  const user = findOrCreateOidcUser(db, {
    sub: 'iss-sub-03', iss: 'https://real-idp.example.com/', email: 'ingo@example.com', email_verified: true,
  });
  assert(user.oidc_provider === 'https://real-idp.example.com/', `Falscher oidc_provider: ${user.oidc_provider}`);
});

// ─── Automatische Kontoerstellung abschaltbar (#654) ─────────────────────────
//
// Wer den IdP nicht nur fuer diesen Haushalt betreibt, gab bisher jedem in
// seinem Verzeichnis beim ersten SSO-Klick ein Konto im Familienplaner.
// `OIDC_ALLOW_SIGNUP=false` nimmt AUSSCHLIESSLICH das Anlegen weg: Erkennen und
// Verknuepfen muessen bleiben, sonst kaeme auch der nicht mehr hinein, den der
// Admin gerade von Hand angelegt hat - und der Schalter waere unbenutzbar.

console.log('\n[OIDC-Test] OIDC_ALLOW_SIGNUP\n');

/** Fuehrt fn mit gesetztem Schalter aus und raeumt ihn danach wieder weg. */
function withSignup(value, fn) {
  const before = process.env.OIDC_ALLOW_SIGNUP;
  if (value === undefined) delete process.env.OIDC_ALLOW_SIGNUP;
  else process.env.OIDC_ALLOW_SIGNUP = value;
  try { return fn(); }
  finally {
    if (before === undefined) delete process.env.OIDC_ALLOW_SIGNUP;
    else process.env.OIDC_ALLOW_SIGNUP = before;
  }
}

test('ohne Schalter legt eine unbekannte Identitaet weiterhin ein Konto an', () => {
  // Der Default entscheidet ueber jede bestehende Installation: waere er
  // umgekehrt, spaerrte ein Update jeden SSO-Nutzer aus, der noch kein Konto hat.
  const db = buildOidcTestDb();
  const user = withSignup(undefined, () => findOrCreateOidcUser(db, { sub: 'default-on', preferred_username: 'dana' }));
  assert(user !== null, 'Der Default muss anlegen, sonst ist das Update ein Ausschluss');
  assert(user.oidc_sub === 'default-on', 'Und zwar mit dem validierten sub');
});

test('OIDC_ALLOW_SIGNUP=false legt kein Konto fuer eine unbekannte Identitaet an', () => {
  const db = buildOidcTestDb();
  const user = withSignup('false', () => findOrCreateOidcUser(db, { sub: 'unknown-sub', preferred_username: 'eve' }));
  assert(user === null, 'Rueckgabe muss null sein, damit der Callback den Grund kennt');
  const { n } = db.prepare('SELECT count(*) AS n FROM users').get();
  assert(n === 0, `Es darf kein Konto entstehen, es waren ${n}`);
});

test('OIDC_ALLOW_SIGNUP=false meldet ein bereits verknuepftes Konto weiterhin an', () => {
  const db = buildOidcTestDb();
  db.exec(`INSERT INTO users (username, display_name, password_hash, oidc_sub, oidc_provider)
           VALUES ('frank', 'Frank', '$oidc$', 'known-sub', 'oidc')`);
  const user = withSignup('false', () => findOrCreateOidcUser(db, { sub: 'known-sub' }));
  assert(user !== null && user.username === 'frank', 'Der sub-Treffer ist von dem Schalter nicht betroffen');
});

test('OIDC_ALLOW_SIGNUP=false verknuepft ein von Hand angelegtes Konto weiterhin', () => {
  // Das ist der Weg, den der Schalter offen laesst - und der ganze Grund, warum
  // er hinter der Verknuepfung steht und nicht davor: Admin legt an, der Nutzer
  // meldet sich per SSO an, beides findet zusammen.
  const db = buildOidcTestDb();
  const localId = addLocalUserWithEmail(db, 'grace', 'grace@example.com');
  const user = withSignup('false', () => findOrCreateOidcUser(db, {
    sub: 'link-sub-654', email: 'grace@example.com', email_verified: true,
  }));
  assert(user !== null, 'Die Verknuepfung darf der Schalter nicht mitnehmen');
  assert(user.id === localId, `Falsches Konto verknuepft: ${user.id} statt ${localId}`);
  const linked = db.prepare('SELECT oidc_sub FROM users WHERE id = ?').get(localId);
  assert(linked.oidc_sub === 'link-sub-654', 'Der sub muss am Konto haengen');
  const { n } = db.prepare('SELECT count(*) AS n FROM users').get();
  assert(n === 1, `Es darf kein zweites Konto entstehen, es waren ${n}`);
});

test('nur der ausdrueckliche Wert "false" schaltet ab', () => {
  // Ein Sicherheitsschalter, der auf jeden gesetzten Wert reagiert, macht aus
  // einem Tippfehler eine Aussperrung.
  const db = buildOidcTestDb();
  for (const value of ['true', '1', 'no', '']) {
    const user = withSignup(value, () => findOrCreateOidcUser(db, { sub: `sub-${value || 'empty'}` }));
    assert(user !== null, `OIDC_ALLOW_SIGNUP="${value}" darf nicht abschalten`);
  }
});

test('der abgewiesene Fall bekommt einen eigenen Grund, keine Sammelmeldung', () => {
  // Regel ueber die Quelle: die Anmeldeseite warf bis #654 JEDEN oidc_-Fehler in
  // dieselbe Meldung ("SSO-Anmeldung fehlgeschlagen"). Fuer diesen Fall ist die
  // falsch - beim Anbieter hat alles funktioniert, hier fehlt das Konto - und
  // wer sie liest, sucht den Fehler bei seinem Passwort statt bei seinem Admin.
  const auth  = readFileSync(new URL('../server/auth.js', import.meta.url), 'utf8');
  const login = readFileSync(new URL('../public/pages/login.js', import.meta.url), 'utf8');

  assert(auth.includes("'/login?error=oidc_signup_disabled'"),
    'der Callback nennt den Grund nicht - dann kann die Anmeldeseite ihn nicht unterscheiden');
  assert(login.includes('oidc_signup_disabled') && login.includes('ssoNoAccount'),
    'die Anmeldeseite kennt den Grund nicht und zeigt weiter die Sammelmeldung');
});

// ─── Verknuepfen und Loesen (#832) ────────────────────────────────────────────
//
// Ein gleicher Benutzername verknuepft bewusst NICHT - sonst naehme sich jeder,
// der sich im IdP "admin" nennt, das lokale Admin-Konto. Wer beide Konten
// wirklich besitzt, bekam damit aber ein zweites Konto (test1-1) und seine
// Daten blieben im ersten. Diesen Weg geht der Nutzer deshalb selbst und
// angemeldet.

console.log('\n[OIDC-Test] Verknuepfen und Loesen\n');

const { linkOidcAccount, unlinkOidcAccount } = await import('../server/auth.js');

/** Lokales Konto mit echtem Passwort-Hash. */
function addLocalUser(db, username) {
  const { lastInsertRowid } = db.prepare(
    "INSERT INTO users (username, display_name, password_hash) VALUES (?, ?, '$2b$12$fakehash')",
  ).run(username, username);
  return Number(lastInsertRowid);
}

const subOf = (db, id) => db.prepare('SELECT oidc_sub FROM users WHERE id = ?').get(id)?.oidc_sub ?? null;

test('verknuepft ein angemeldetes Konto mit dem validierten sub', () => {
  const db = buildOidcTestDb();
  const userId = addLocalUser(db, 'test1');

  const result = linkOidcAccount(db, userId, { sub: 'authentik-sub-1', iss: 'https://idp.example/' });

  assert(result.ok === true, 'Verknuepfung muss durchgehen');
  assert(subOf(db, userId) === 'authentik-sub-1', 'sub muss am Konto stehen');
  assert(
    db.prepare('SELECT oidc_provider FROM users WHERE id = ?').get(userId).oidc_provider === 'https://idp.example/',
    'Der Issuer wird als Provider festgehalten',
  );
});

test('legt dabei kein zweites Konto an', () => {
  const db = buildOidcTestDb();
  const userId = addLocalUser(db, 'test1');
  linkOidcAccount(db, userId, { sub: 'authentik-sub-1', iss: 'https://idp.example/' });

  // Genau das war der Fehler in #832: die erste SSO-Anmeldung legte "test1-1" an.
  const count = db.prepare('SELECT COUNT(*) AS n FROM users').get().n;
  assert(count === 1, `Erwartet 1 Konto, gefunden ${count}`);

  // Und ab jetzt findet die Anmeldung genau dieses Konto.
  const found = findOrCreateOidcUser(db, { sub: 'authentik-sub-1', preferred_username: 'test1' });
  assert(found.id === userId, 'Die SSO-Anmeldung landet im bestehenden Konto');
  assert(db.prepare('SELECT COUNT(*) AS n FROM users').get().n === 1, 'Auch danach bleibt es ein Konto');
});

test('ein fremd vergebener sub wird abgewiesen', () => {
  // Sonst haetten zwei Konten denselben Identitaetsanker und die
  // Zeilenreihenfolge entschiede, wer sich damit anmeldet.
  const db = buildOidcTestDb();
  const owner  = addLocalUser(db, 'owner');
  const second = addLocalUser(db, 'second');
  linkOidcAccount(db, owner, { sub: 'shared-sub' });

  const result = linkOidcAccount(db, second, { sub: 'shared-sub' });

  assert(result.ok === false && result.reason === 'sub_taken', `Erwartet sub_taken, war ${result.reason}`);
  assert(subOf(db, second) === null, 'Das zweite Konto bleibt unverknuepft');
  assert(subOf(db, owner) === 'shared-sub', 'Und das erste behaelt seine Verknuepfung');
});

test('ein bereits verknuepftes Konto wechselt nicht still den Zugang', () => {
  const db = buildOidcTestDb();
  const userId = addLocalUser(db, 'test1');
  linkOidcAccount(db, userId, { sub: 'first-sub' });

  const result = linkOidcAccount(db, userId, { sub: 'other-sub' });

  assert(result.ok === false && result.reason === 'already_linked', `Erwartet already_linked, war ${result.reason}`);
  assert(subOf(db, userId) === 'first-sub', 'Der bestehende sub bleibt stehen');
});

test('dieselbe Verknuepfung ein zweites Mal ist folgenlos', () => {
  const db = buildOidcTestDb();
  const userId = addLocalUser(db, 'test1');
  linkOidcAccount(db, userId, { sub: 'same-sub' });

  assert(linkOidcAccount(db, userId, { sub: 'same-sub' }).ok === true, 'Idempotent, kein Fehler');
});

test('ein verschwundenes Konto verknuepft nichts', () => {
  const db = buildOidcTestDb();
  const result = linkOidcAccount(db, 999, { sub: 'ghost-sub' });
  assert(result.ok === false && result.reason === 'user_gone', `Erwartet user_gone, war ${result.reason}`);
});

test('loest eine Verknuepfung, wenn ein Passwort gesetzt ist', () => {
  const db = buildOidcTestDb();
  const userId = addLocalUser(db, 'test1');
  linkOidcAccount(db, userId, { sub: 'authentik-sub-1', iss: 'https://idp.example/' });

  assert(unlinkOidcAccount(db, userId).ok === true, 'Loesen muss durchgehen');
  const row = db.prepare('SELECT oidc_sub, oidc_provider FROM users WHERE id = ?').get(userId);
  assert(row.oidc_sub === null && row.oidc_provider === null, 'Beide Spalten werden geraeumt');
});

test('ein per SSO angelegtes Konto darf sich nicht aussperren', () => {
  // Es traegt kein Passwort, sondern den Platzhalter - ohne OIDC kaeme dort
  // niemand mehr hinein.
  const db = buildOidcTestDb();
  const user = findOrCreateOidcUser(db, { sub: 'sso-only', preferred_username: 'ssouser' });
  assert(user.password_hash === '$oidc$', 'Vorbedingung: kein echtes Passwort');

  const result = unlinkOidcAccount(db, user.id);

  assert(result.ok === false && result.reason === 'no_password', `Erwartet no_password, war ${result.reason}`);
  assert(subOf(db, user.id) === 'sso-only', 'Die Verknuepfung bleibt bestehen');
});

test('ein unverknuepftes Konto hat nichts zu loesen', () => {
  const db = buildOidcTestDb();
  const userId = addLocalUser(db, 'test1');
  const result = unlinkOidcAccount(db, userId);
  assert(result.ok === false && result.reason === 'not_linked', `Erwartet not_linked, war ${result.reason}`);
});

// ─── Abschluss ────────────────────────────────────────────────────────────────

console.log(`\n  ${passed} bestanden, ${failed} fehlgeschlagen\n`);
if (failed > 0) process.exit(1);
