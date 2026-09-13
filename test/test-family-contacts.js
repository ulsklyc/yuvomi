import { DatabaseSync } from 'node:sqlite';
import { MIGRATIONS_SQL } from '../server/db-schema-test.js';

let passed = 0, failed = 0;
function test(name, fn) {
  try { fn(); console.log(`  ✓ ${name}`); passed++; }
  catch (err) { console.error(`  ✗ ${name}: ${err.message}`); failed++; }
}
function assert(cond, msg) { if (!cond) throw new Error(msg || 'Assertion failed'); }

const db = new DatabaseSync(':memory:');
db.exec('PRAGMA foreign_keys = ON;');

// Setup schema up to migration 23 (where family_user_id was added)
// Since we don't have all migrations in SQL strings easily available, 
// we'll just mock the necessary tables for this specific test.
db.exec(`
  CREATE TABLE users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    display_name TEXT NOT NULL
  );
  CREATE TABLE contacts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    first_name TEXT, last_name TEXT, middle_name TEXT, name_prefix TEXT, name_suffix TEXT,
    family_user_id INTEGER REFERENCES users(id) ON DELETE CASCADE
  );
`);

const userId = db.prepare("INSERT INTO users (display_name) VALUES ('Papa')").run().lastInsertRowid;
const contactIdFamily = db.prepare("INSERT INTO contacts (name, family_user_id) VALUES ('Papa', ?)").run(userId).lastInsertRowid;
const contactIdRegular = db.prepare("INSERT INTO contacts (name, family_user_id) VALUES ('Regular Contact', NULL)").run().lastInsertRowid;

console.log('\n[Family-Contacts-Test] Backend Deletion Prevention\n');

test('Regular contact can be deleted', () => {
  const result = db.prepare('DELETE FROM contacts WHERE id = ?').run(contactIdRegular);
  assert(result.changes === 1, 'Should have deleted 1 row');
});

test('Family contact should NOT be deleted if we apply the logic from the route', () => {
  // Mocking the logic in server/routes/contacts.js
  const id = contactIdFamily;
  const contact = db.prepare('SELECT family_user_id FROM contacts WHERE id = ?').get(id);
  
  let deleted = false;
  let forbidden = false;
  
  if (contact.family_user_id) {
    forbidden = true;
  } else {
    db.prepare('DELETE FROM contacts WHERE id = ?').run(id);
    deleted = true;
  }
  
  assert(forbidden === true, 'Should be forbidden');
  assert(deleted === false, 'Should not have been deleted');
});

// ── Realer Schreibpfad: syncFamilyMemberArtifacts (server/auth.js) ──────────
// Der Mock oben prueft nur die Loeschsperre. Hier laeuft der echte Sync gegen
// eine frisch migrierte Datenbank: der beim Anlegen eines Haushaltsmitglieds
// gespiegelte Kontakt muss den stabilen Kategorie-Key 'misc' tragen, nicht das
// alte deutsche Literal 'Sonstiges' - das ist kein Key in contact_categories,
// die UI zeigte es unuebersetzt an (#1140).
const { freshTestDbPath } = await import('./tmp-db.js');
freshTestDbPath('family-contacts');
process.env.SESSION_SECRET = process.env.SESSION_SECRET || 'family-contacts-test-secret-32byte';

const real = await import('../server/db.js');
const { syncFamilyMemberArtifacts } = await import('../server/auth.js');
real.init();
const realDb = real.get();

console.log('\n[Family-Contacts-Test] Gespiegelter Mitglieds-Kontakt (#1140)\n');

test('syncFamilyMemberArtifacts legt den Mitglieds-Kontakt mit category = misc an', () => {
  const memberId = realDb.prepare(`
    INSERT INTO users (username, display_name, password_hash, avatar_color, role)
    VALUES ('misc-mirror', 'Mia Misc', 'x', '#007AFF', 'member')
  `).run().lastInsertRowid;

  syncFamilyMemberArtifacts(realDb, memberId, { displayName: 'Mia Misc', actorUserId: 1 });

  const contact = realDb.prepare('SELECT category FROM contacts WHERE family_user_id = ?').get(memberId);
  assert(contact, 'Kontakt-Artefakt wurde angelegt');
  assert(contact.category === 'misc',
    `category ist '${contact && contact.category}', erwartet den stabilen Key 'misc' (#1140)`);
});

console.log(`\nResults: ${passed} passed, ${failed} failed\n`);
if (failed > 0) process.exit(1);
