import { DatabaseSync } from 'node:sqlite';
import { MIGRATIONS_SQL } from '../server/db-schema-test.js';
import http from 'node:http';
import { normalizeUrl, checkSSRF, isPrivateNetworkAllowed, fetchAndParse } from '../server/services/ics-subscription.js';

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

  // --- checkSSRF: literale private IPs werden ohne Flag geblockt (kein DNS nötig) ---
  delete process.env[ENV_FLAG];
  await atest('checkSSRF blockt literale IPv4-Loopback', () =>
    assertThrows(() => checkSSRF('https://127.0.0.1/cal.ics')));
  await atest('checkSSRF blockt literales privates IPv4-Netz', () =>
    assertThrows(() => checkSSRF('https://192.168.0.1/cal.ics')));
  await atest('checkSSRF blockt Link-Local/Cloud-Metadata 169.254.169.254', () =>
    assertThrows(() => checkSSRF('https://169.254.169.254/latest/meta-data/')));
  await atest('checkSSRF blockt literales IPv6-Loopback [::1]', () =>
    assertThrows(() => checkSSRF('https://[::1]/cal.ics')));
  await atest('checkSSRF blockt IPv4-mapped-IPv6 auf private IPv4', () =>
    assertThrows(() => checkSSRF('https://[::ffff:192.168.0.1]/cal.ics')));
  await atest('checkSSRF lässt literale öffentliche IP durch', async () => {
    await checkSSRF('https://8.8.8.8/cal.ics');
  });

  // --- fetchAndParse: echter HTTP-Round-Trip über den neuen node-nativen Client ---
  // Verifiziert, dass der Ersatz von node-fetch (server/utils/http.js) den ICS-Body,
  // Status/ETag/Last-Modified und die 304-Kurzform verhaltensgleich liefert. Flag
  // gesetzt, damit checkSSRF/Lookup das 127.0.0.1-Testziel zulassen (die Anti-Rebinding-
  // Prüfung selbst ist in test:http und test:ssrf abgedeckt).
  const SAMPLE_ICS = [
    'BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//Test//EN',
    'BEGIN:VEVENT', 'UID:evt-1@test', 'DTSTART:20260714T090000Z',
    'DTEND:20260714T100000Z', 'SUMMARY:Zahnarzt für M(ä)ria', 'END:VEVENT',
    'END:VCALENDAR', '',
  ].join('\r\n');

  await atest('fetchAndParse: liefert Events + ETag/Last-Modified (Body korrekt dekodiert)', async () => {
    process.env[ENV_FLAG] = '1';
    const server = http.createServer((req, res) => {
      res.writeHead(200, {
        'Content-Type': 'text/calendar; charset=utf-8',
        ETag: '"v1"',
        'Last-Modified': 'Mon, 14 Jul 2026 08:00:00 GMT',
      });
      res.end(Buffer.from(SAMPLE_ICS, 'utf8'));
    });
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    try {
      const { port } = server.address();
      const result = await fetchAndParse(`http://127.0.0.1:${port}/cal.ics`, null, null);
      assert(result.notModified === false, 'notModified sollte false sein');
      assert(result.newEtag === '"v1"', `ETag falsch: ${result.newEtag}`);
      assert(result.newLastModified === 'Mon, 14 Jul 2026 08:00:00 GMT', 'Last-Modified falsch');
      assert(Array.isArray(result.events) && result.events.length === 1, 'genau 1 Event erwartet');
      // Umlaute im Body müssen als UTF-8-Text ankommen (kein Uint8Array.toString-Trap):
      assert(result.events[0].summary === 'Zahnarzt für M(ä)ria', `Summary falsch: ${result.events[0].summary}`);
    } finally {
      await new Promise((r) => server.close(r));
      delete process.env[ENV_FLAG];
    }
  });

  await atest('fetchAndParse: 304 wird als notModified erkannt (If-None-Match gesendet)', async () => {
    process.env[ENV_FLAG] = '1';
    let seenIfNoneMatch = null;
    const server = http.createServer((req, res) => {
      seenIfNoneMatch = req.headers['if-none-match'] || null;
      res.writeHead(304);
      res.end();
    });
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    try {
      const { port } = server.address();
      const result = await fetchAndParse(`http://127.0.0.1:${port}/cal.ics`, '"v1"', null);
      assert(result.notModified === true, 'notModified sollte true sein');
      assert(seenIfNoneMatch === '"v1"', `If-None-Match nicht gesendet: ${seenIfNoneMatch}`);
    } finally {
      await new Promise((r) => server.close(r));
      delete process.env[ENV_FLAG];
    }
  });
})();

// ---------------------------------------------------------------------------
// Wiederholte Läufe über einen unveränderten Kalender.
// Der ETag-Kurzschluss (notModified) greift nur, wenn der Server einen ETag
// mitschickt. Ohne ihn kommt bei jedem Lauf der komplette Kalender erneut an
// und lief bis dahin ungebremst in den Upsert.
// ---------------------------------------------------------------------------

console.log('\n[ICS-Subscription-Test] Unveränderte Läufe schreiben nicht\n');

await (async () => {
  const { MIGRATIONS } = await import('../server/db.js');
  const dbModule = await import('../server/db.js');
  const { sync } = await import('../server/services/ics-subscription.js');

  // Eigene, voll migrierte DB: der Upsert braucht den UNIQUE-Index aus
  // Migration 12, damit ON CONFLICT überhaupt greift. Hier better-sqlite3
  // statt node:sqlite, weil syncOne() db.get().transaction() nutzt - die
  // Methode gibt es nur im Produktionstreiber.
  const { default: Database } = await import('better-sqlite3-multiple-ciphers');
  const syncDb = new Database(':memory:');
  syncDb.pragma('foreign_keys = ON');
  syncDb.exec(`CREATE TABLE IF NOT EXISTS schema_migrations (
    version INTEGER PRIMARY KEY, description TEXT NOT NULL,
    applied_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')))`);
  for (const m of MIGRATIONS) {
    if (typeof m.up === 'function') m.up(syncDb); else syncDb.exec(m.up);
    if (typeof m.afterUp === 'function') m.afterUp(syncDb);
    syncDb.prepare('INSERT INTO schema_migrations (version, description) VALUES (?, ?)')
      .run(m.version, m.description);
  }
  syncDb.prepare(`INSERT INTO users (username, display_name, password_hash, role)
                  VALUES ('owner', 'Owner', 'x', 'admin')`).run();

  // Datum relativ zum Testlauf: syncOne() importiert nur das Fenster von sechs
  // Monaten zurück bis zwölf Monate voraus. Ein fest verdrahtetes Datum fiele
  // irgendwann hinten heraus und ließe die Tests scheitern, ohne dass sich am
  // Produktionscode etwas geändert hätte.
  const inDays = (n) => {
    const d = new Date(Date.now() + n * 24 * 60 * 60 * 1000);
    return d.toISOString().slice(0, 10).replace(/-/g, '');
  };
  const DAY = inDays(30);

  const icsWith = (summary) => [
    'BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//Test//EN',
    'BEGIN:VEVENT', 'UID:sync-1@test', `DTSTART:${DAY}T090000Z`,
    `DTEND:${DAY}T100000Z`, `SUMMARY:${summary}`, 'END:VEVENT',
    'END:VCALENDAR', '',
  ].join('\r\n');

  // Server ohne ETag/Last-Modified: erzwingt den vollen Durchlauf pro Sync.
  let body = icsWith('Zahnarzt');
  const server = http.createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/calendar; charset=utf-8' });
    res.end(Buffer.from(body, 'utf8'));
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const { port } = server.address();

  process.env[ENV_FLAG] = '1';
  dbModule._setTestDatabase(syncDb);
  try {
    const subId = syncDb.prepare(`
      INSERT INTO ics_subscriptions (name, url, color, created_by)
      VALUES ('Testabo', ?, '#123456', 1)
    `).run(`http://127.0.0.1:${port}/cal.ics`).lastInsertRowid;

    await atest('Erster Sync legt den Termin an', async () => {
      await sync(subId);
      const n = syncDb.prepare(
        'SELECT COUNT(*) AS n FROM calendar_events WHERE subscription_id = ?'
      ).get(subId).n;
      assert(n === 1, `erwartet 1 Termin, waren ${n}`);
    });

    await atest('Zweiter Sync über unveränderte Daten fasst keine Zeile an', async () => {
      // last_sync/etag-Update der Subscription zählt mit, deshalb nur die
      // Termin-Tabelle betrachten: ihre Zeilen dürfen unangetastet bleiben.
      const before = syncDb.prepare(
        'SELECT id, title, start_datetime, color FROM calendar_events WHERE subscription_id = ? ORDER BY id'
      ).all(subId);
      const changesBefore = syncDb.prepare('SELECT total_changes() AS n').get().n;
      // total_changes() allein genügt nicht: ein INSERT mit ON CONFLICT, dessen
      // DO UPDATE unterdrückt wird, meldet changes = 0, verbraucht aber trotzdem
      // eine AUTOINCREMENT-Rowid und schreibt sqlite_sequence fort.
      const seqBefore = syncDb.prepare(
        "SELECT seq FROM sqlite_sequence WHERE name = 'calendar_events'"
      ).get()?.seq ?? null;

      // Der Logger schreibt info über console.info (server/logger.js) - ein
      // leerer Kanal beweist, dass die Zusammenfassung auf debug bleibt.
      const realInfo = console.info;
      const infoLines = [];
      console.info = (...args) => infoLines.push(args.join(' '));
      try { await sync(subId); } finally { console.info = realInfo; }
      assert(infoLines.length === 0,
        `unveränderter Sync meldete sich auf info: ${JSON.stringify(infoLines)}`);

      const after = syncDb.prepare(
        'SELECT id, title, start_datetime, color FROM calendar_events WHERE subscription_id = ? ORDER BY id'
      ).all(subId);
      const delta = syncDb.prepare('SELECT total_changes() AS n').get().n - changesBefore;

      const seqAfter = syncDb.prepare(
        "SELECT seq FROM sqlite_sequence WHERE name = 'calendar_events'"
      ).get()?.seq ?? null;

      assert(before.length === 1, 'Vorbedingung: der Termin muss vorliegen');
      assert(JSON.stringify(before) === JSON.stringify(after), 'Termin wurde verändert');
      // Genau eine Änderung ist erlaubt: das last_sync/etag-UPDATE der Subscription.
      assert(delta <= 1, `unveränderter Sync schrieb ${delta} Zeilen statt höchstens 1`);
      assert(seqAfter === seqBefore,
        `Rowid verbraucht, obwohl nichts zu tun war: ${seqBefore} -> ${seqAfter}`);
    });

    // Gegenprobe: der Vergleich darf echte Änderungen nicht wegfiltern.
    await atest('Geänderter Titel kommt weiterhin an', async () => {
      body = icsWith('Zahnarzt (verschoben)');
      await sync(subId);
      const row = syncDb.prepare(
        'SELECT title FROM calendar_events WHERE subscription_id = ?'
      ).get(subId);
      assert(row.title === 'Zahnarzt (verschoben)', `Titel blieb "${row.title}"`);
    });

    // D#2330 (Variante A): der Feed-Stand liegt in feed_original. Jeder Sync
    // schreibt ihn, auch an einen lokal geänderten Termin, dessen Felder der
    // Sync nicht anfasst. Sonst stünde beim Zurücksetzen ein veralteter Wert da.
    await atest('Sync schreibt feed_original auch an lokal geänderte Termine', async () => {
      syncDb.prepare("UPDATE calendar_events SET title = 'Lokal', user_modified = 1 WHERE subscription_id = ?").run(subId);
      body = icsWith('Zahnarzt (Feed neu)');
      await sync(subId);
      const row = syncDb.prepare(
        'SELECT title, feed_original FROM calendar_events WHERE subscription_id = ?'
      ).get(subId);
      assert(row.title === 'Lokal', `lokale Änderung ging verloren: "${row.title}"`);
      assert(row.feed_original, 'feed_original blieb leer');
      assert(JSON.parse(row.feed_original).title === 'Zahnarzt (Feed neu)',
        `feed_original hält "${JSON.parse(row.feed_original).title}"`);
    });

    // Altbestand: vor der Migration gesyncte Zeilen haben kein feed_original.
    // Der nächste Sync füllt es nach, ohne den lokalen Stand zu verwerfen.
    await atest('Sync füllt feed_original für Altbestand nach', async () => {
      syncDb.prepare("UPDATE calendar_events SET feed_original = NULL WHERE subscription_id = ?").run(subId);
      await sync(subId);
      const row = syncDb.prepare(
        'SELECT title, feed_original FROM calendar_events WHERE subscription_id = ?'
      ).get(subId);
      assert(row.feed_original, 'feed_original wurde nicht nachgefüllt');
      assert(row.title === 'Lokal', `lokale Änderung ging verloren: "${row.title}"`);
    });

    // Migration 273: Altbestand bekommt ein leeres ETag und Last-Modified, damit
    // der nächste Abruf den vollen Feed (200) statt 304 liefert.
    await atest('Migration 273 leert ETag und Last-Modified der Abos', async () => {
      const m = MIGRATIONS.find((x) => x.version === 273);
      assert(m, 'Migration 273 fehlt');
      const altId = syncDb.prepare(`
        INSERT INTO ics_subscriptions (name, url, color, created_by, etag, last_modified)
        VALUES ('Alt', 'https://x.com/alt.ics', '#000000', 1, '"abc"', 'Wed, 01 Jan 2026 00:00:00 GMT')
      `).run().lastInsertRowid;
      m.up(syncDb);
      const r = syncDb.prepare('SELECT etag, last_modified FROM ics_subscriptions WHERE id = ?').get(altId);
      assert(r.etag === null && r.last_modified === null,
        `ETag blieb: ${JSON.stringify(r)}`);
    });
  } finally {
    dbModule._resetTestDatabase();
    delete process.env[ENV_FLAG];
    await new Promise((r) => server.close(r));
    syncDb.close();
  }
})();

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
