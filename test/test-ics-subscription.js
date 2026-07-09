import { DatabaseSync } from 'node:sqlite';
import { MIGRATIONS_SQL } from '../server/db-schema-test.js';
import { normalizeUrl, checkSSRF, isPrivateNetworkAllowed } from '../server/services/ics-subscription.js';

let passed = 0, failed = 0;
function test(name, fn) {
  try { fn(); console.log(`  ✓ ${name}`); passed++; }
  catch (err) { console.error(`  ✗ ${name}: ${err.message}`); failed++; }
}
async function atest(name, fn) {
  try { await fn(); console.log(`  ✓ ${name}`); passed++; }
  catch (err) { console.error(`  ✗ ${name}: ${err.message}`); failed++; }
}
function assert(cond, msg) { if (!cond) throw new Error(msg || 'Assertion failed'); }
async function assertThrows(fn, msg) {
  let threw = false;
  try { await fn(); } catch { threw = true; }
  assert(threw, msg || 'expected throw');
}
const ENV_FLAG = 'ICS_SUBSCRIPTION_ALLOW_PRIVATE_NETWORK';

const db = new DatabaseSync(':memory:');
db.exec('PRAGMA foreign_keys = ON;');

db.exec(`CREATE TABLE users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  username TEXT UNIQUE NOT NULL, display_name TEXT NOT NULL,
  password_hash TEXT NOT NULL, avatar_color TEXT NOT NULL DEFAULT '#007AFF',
  role TEXT NOT NULL DEFAULT 'member',
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
);`);
db.exec(MIGRATIONS_SQL[10]);
db.exec(MIGRATIONS_SQL[11]);

const uid1 = db.prepare(`INSERT INTO users (username,display_name,password_hash,role) VALUES ('admin','Admin','x','admin')`).run().lastInsertRowid;
const uid2 = db.prepare(`INSERT INTO users (username,display_name,password_hash) VALUES ('maria','Maria','x')`).run().lastInsertRowid;

console.log('\n[ICS-Subscription-Test] DB-Schema\n');

let subId;

test('Abonnement anlegen', () => {
  subId = db.prepare(`INSERT INTO ics_subscriptions (name,url,color,shared,created_by) VALUES ('Feiertage','https://x.com/de.ics','#FF3B30',0,?)`).run(uid1).lastInsertRowid;
  assert(subId > 0);
});

test('Geteiltes Abonnement anlegen', () => {
  const id = db.prepare(`INSERT INTO ics_subscriptions (name,url,color,shared,created_by) VALUES ('Schulferien','https://x.com/school.ics','#34C759',1,?)`).run(uid2).lastInsertRowid;
  assert(id > 0);
});

test('ICS-Event einfügen (external_source=ics)', () => {
  const id = db.prepare(`INSERT INTO calendar_events (title,start_datetime,all_day,external_source,external_calendar_id,subscription_id,created_by) VALUES ('Neujahr','2026-01-01',1,'ics','neujahr@test',?,?)`).run(subId, uid1).lastInsertRowid;
  assert(id > 0);
});

test('Doppelte UID in gleicher Subscription verletzt UNIQUE', () => {
  let threw = false;
  try { db.prepare(`INSERT INTO calendar_events (title,start_datetime,all_day,external_source,external_calendar_id,subscription_id,created_by) VALUES ('Dup','2026-01-01',1,'ics','neujahr@test',?,?)`).run(subId, uid1); }
  catch { threw = true; }
  assert(threw, 'UNIQUE should fire');
});

test('Gleiche UID in anderer Subscription erlaubt', () => {
  const sub2 = db.prepare(`INSERT INTO ics_subscriptions (name,url,color,created_by) VALUES ('Sub2','https://b.com/b.ics','#000',?)`).run(uid1).lastInsertRowid;
  const id = db.prepare(`INSERT INTO calendar_events (title,start_datetime,all_day,external_source,external_calendar_id,subscription_id,created_by) VALUES ('Neujahr2','2026-01-01',1,'ics','neujahr@test',?,?)`).run(sub2, uid1).lastInsertRowid;
  assert(id > 0);
});

test('user_modified Default ist 0', () => {
  const ev = db.prepare(`SELECT user_modified FROM calendar_events WHERE subscription_id = ?`).get(subId);
  assert(ev.user_modified === 0);
});

test('user_modified auf 1 setzen', () => {
  db.prepare(`UPDATE calendar_events SET user_modified = 1 WHERE subscription_id = ?`).run(subId);
  assert(db.prepare(`SELECT user_modified FROM calendar_events WHERE subscription_id = ?`).get(subId).user_modified === 1);
});

test('Sichtbarkeitsfilter: privates Abo unsichtbar für anderen User', () => {
  const rows = db.prepare(`
    SELECT e.id FROM calendar_events e
    JOIN ics_subscriptions s ON s.id = e.subscription_id
    WHERE e.external_source = 'ics' AND (s.shared = 1 OR s.created_by = ?)
  `).all(uid2);
  const ids = rows.map(r => r.id);
  const neujahr = db.prepare(`SELECT id FROM calendar_events WHERE external_calendar_id = 'neujahr@test' AND subscription_id = ?`).get(subId);
  assert(!ids.includes(neujahr.id), 'privates Abo nicht sichtbar für uid2');
});

test('Cascade delete: Subscription löschen entfernt Events', () => {
  const tmp = db.prepare(`INSERT INTO ics_subscriptions (name,url,color,created_by) VALUES ('Tmp','https://t.com/t.ics','#999',?)`).run(uid1).lastInsertRowid;
  db.prepare(`INSERT INTO calendar_events (title,start_datetime,all_day,external_source,external_calendar_id,subscription_id,created_by) VALUES ('TmpEv','2026-06-01',1,'ics','tmp@test',?,?)`).run(tmp, uid1);
  db.prepare(`DELETE FROM ics_subscriptions WHERE id = ?`).run(tmp);
  assert(db.prepare(`SELECT count(*) as c FROM calendar_events WHERE subscription_id = ?`).get(tmp).c === 0, 'cascade failed');
});

test('external_source CHECK blockiert ungültige Werte', () => {
  let threw = false;
  try { db.prepare(`INSERT INTO calendar_events (title,start_datetime,external_source,created_by) VALUES ('Bad','2026-01-01','invalid',?)`).run(uid1); }
  catch { threw = true; }
  assert(threw, 'CHECK should reject invalid external_source');
});

console.log('\n[ICS-Subscription-Test] URL-Validierung & Private-Network-Opt-in\n');

await (async () => {
  // --- Flag-Parsing (isPrivateNetworkAllowed) ---
  for (const [val, expected] of [['true', true], ['1', true], ['  true  ', true],
    ['false', false], ['0', false], ['yes', false], ['', false]]) {
    test(`isPrivateNetworkAllowed('${val}') === ${expected}`, () => {
      process.env[ENV_FLAG] = val;
      assert(isPrivateNetworkAllowed() === expected);
    });
  }
  test('isPrivateNetworkAllowed() ohne env === false', () => {
    delete process.env[ENV_FLAG];
    assert(isPrivateNetworkAllowed() === false);
  });

  // --- normalizeUrl: Default (Flag aus) ---
  delete process.env[ENV_FLAG];
  test('https bleibt erhalten', () => {
    assert(normalizeUrl('https://x.com/cal.ics') === 'https://x.com/cal.ics');
  });
  test('webcal wird zu https gemappt', () => {
    assert(normalizeUrl('webcal://x.com/cal.ics') === 'https://x.com/cal.ics');
  });
  test('http wirft ohne Flag', () => {
    let threw = false;
    try { normalizeUrl('http://x.com/cal.ics'); } catch { threw = true; }
    assert(threw, 'http sollte ohne Flag abgelehnt werden');
  });
  test('ftp wirft immer', () => {
    let threw = false;
    try { normalizeUrl('ftp://x.com/cal.ics'); } catch { threw = true; }
    assert(threw);
  });

  // --- normalizeUrl: Flag an ---
  process.env[ENV_FLAG] = 'true';
  test('http erlaubt mit Flag', () => {
    assert(normalizeUrl('http://192.168.1.50:8989/feed/calendar.ics')
      === 'http://192.168.1.50:8989/feed/calendar.ics');
  });
  test('https weiterhin erlaubt mit Flag', () => {
    assert(normalizeUrl('https://x.com/cal.ics') === 'https://x.com/cal.ics');
  });
  test('ftp wirft auch mit Flag', () => {
    let threw = false;
    try { normalizeUrl('ftp://x.com/cal.ics'); } catch { threw = true; }
    assert(threw);
  });
  delete process.env[ENV_FLAG];

  // --- checkSSRF: Flag an überspringt Private-IP-Prüfung (early return, kein DNS) ---
  process.env[ENV_FLAG] = 'true';
  await atest('checkSSRF überspringt private IP mit Flag', async () => {
    await checkSSRF('http://192.168.1.50:8989/feed/calendar.ics');
    await checkSSRF('http://127.0.0.1/cal.ics');
  });
  delete process.env[ENV_FLAG];
})();

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
