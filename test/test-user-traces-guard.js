/**
 * Modul: Guard - was beim Entfernen eines Kontos eine Spur ist (#1381)
 * Zweck: `server/services/user-removal.js` entscheidet zwischen Deaktivieren
 *        und Loeschen ueber eine handgepflegte Liste, `PRIVATE_USER_COLUMNS`:
 *        Spalten, die auf `users(id)` zeigen und trotzdem nichts Geteiltes
 *        sind. Alles andere ist eine Spur. Die Liste ist die Stelle, an der
 *        die Regel falsch werden kann, und sie wird falsch, ohne dass eine
 *        Verhaltenssuite es merkt - deshalb diese Suite, gegen das ECHTE
 *        Schema (alle Migrationen, in einer Datenbank im Speicher):
 *
 *          1. Jeder Eintrag ist eine echte Fremdschluessel-Spalte auf
 *             `users(id)` mit CASCADE oder SET NULL. Ein Tippfehler oder eine
 *             umbenannte Spalte macht die Zeile sonst wirkungslos - und damit
 *             jedes Konto mit Gesundheitsdaten unloeschbar, still.
 *          2. Keine RESTRICT- oder NO-ACTION-Spalte ist privat: das Loeschen
 *             scheiterte daran, und die Route antwortete wieder 500.
 *          3. Ein Konto mit je einer Zeile in JEDER privaten Spalte laesst sich
 *             loeschen. Das haelt 1 und 2 als Verhalten fest, nicht als Text.
 *          4. Je eine Zeile in JEDER nicht-privaten Spalte fuehrt zu
 *             `deactivated`, und keine Tabelle ausserhalb der privaten verliert
 *             dabei eine Zeile. Eine NEUE Spalte faellt ohne Zutun hierher.
 *          5. Die Spalte `users.deactivated_at` wird unter server/ nur an den
 *             Stellen geschrieben und gelesen, die hier stehen. Eine zweite
 *             Fassung von "ist dieses Konto aktiv" waere genau die zweite
 *             Wahrheit, gegen die das Praedikat gebaut ist.
 *          6. Das Entfernen laeuft in EINER Transaktion - insbesondere enden
 *             die Sitzungen darin und nicht danach.
 *
 *        WIE DIE ZEILEN ENTSTEHEN. Fuer 133 Spalten in rund 100 Tabellen gibt
 *        es keine 133 handgeschriebenen INSERTs: jede Zeile wird aus
 *        `PRAGMA table_xinfo` gebaut, Pflichtspalten bekommen einen Fuellwert.
 *        CHECK-Bedingungen und Fremdschluessel sind dabei AUS - geprueft wird
 *        hier nicht, ob die Zeile fachlich Sinn ergibt, sondern was das
 *        Entfernen mit einer Zeile tut, die auf das Konto zeigt. Beim Entfernen
 *        selbst sind die Fremdschluessel wieder AN.
 * Ausfuehren: npm run test:user-traces-guard
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

import { withoutCommentsKeepingLines } from './source-text.js';

process.env.DB_PATH = ':memory:';
process.env.SESSION_SECRET = 'user-traces-guard-test-secret-32chars';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const db = (await import('../server/db.js')).get();
const {
  PRIVATE_USER_COLUMNS, FEED_TOKEN_COLUMNS, RemovalRefused, removeUser, userReferenceColumns, userTraces,
} = await import('../server/services/user-removal.js');
const { householdMemberSql } = await import('../server/services/household-members.js');

db.exec('CREATE TABLE IF NOT EXISTS sessions (sid TEXT PRIMARY KEY, sess TEXT NOT NULL, expired_at INTEGER NOT NULL)');

const COLUMNS = userReferenceColumns(db);
const KEYS = new Set(COLUMNS.map((col) => col.key));

// --------------------------------------------------------------------------
// Zeilen bauen
// --------------------------------------------------------------------------

let serial = 1000;
function addUser(name) {
  serial += 1;
  return Number(db.prepare(`
    INSERT INTO users (username, display_name, password_hash, role) VALUES (?, ?, 'x', 'member') RETURNING id
  `).get(`guard-${serial}`, name).id);
}

/** Ein Konto, auf das Pflichtspalten zeigen, die nicht das gepruefte Konto meinen. */
const BYSTANDER = addUser('Unbeteiligt');

/**
 * Eine Zeile in `table`, deren `column` auf `userId` zeigt. Jede andere Spalte,
 * die auf `users` zeigt, bekommt ein unbeteiligtes Konto (Pflicht) oder NULL -
 * die Zeile soll GENAU EINE Verbindung zum geprueften Konto haben. `overrides`
 * setzt einzelne Spalten ausdruecklich.
 */
function insertRow(table, column, userId, overrides = {}) {
  const userColumns = new Set(COLUMNS.filter((col) => col.table === table).map((col) => col.column));
  const names = [];
  const values = [];
  for (const info of db.prepare(`PRAGMA table_xinfo("${table}")`).all()) {
    if (info.hidden) continue;
    let value;
    if (info.name === column) value = userId;
    else if (info.name in overrides) value = overrides[info.name];
    else if (userColumns.has(info.name)) {
      if (!info.notnull && !info.pk) continue;
      // Je Zeile ein eigenes fremdes Konto: manche Tabellen erlauben je Konto
      // nur eine Zeile (ein laufendes Fasten, eine Einstellung).
      value = addUser('Unbeteiligt');
    } else if (info.pk && /INT/i.test(info.type)) {
      // Ein zusammengesetzter Schluessel braucht einen Wert, ein einfacher
      // INTEGER PRIMARY KEY vergibt ihn selbst.
      const composite = db.prepare(`PRAGMA table_xinfo("${table}")`).all().filter((c) => c.pk).length > 1;
      if (!composite) continue;
      serial += 1; value = serial;
    } else if (!info.notnull || info.dflt_value !== null) continue;
    else if (/INT|REAL|NUM/i.test(info.type)) { serial += 1; value = serial; }
    else { serial += 1; value = `x${serial}`; }
    names.push(`"${info.name}"`);
    values.push(value);
  }
  db.prepare(`INSERT INTO "${table}" (${names.join(', ')}) VALUES (${names.map(() => '?').join(', ')})`).run(...values);
}

/** Baut Zeilen ohne CHECK und ohne Fremdschluessel, und stellt beides danach wieder her. */
function fabricate(fn) {
  db.pragma('ignore_check_constraints = ON');
  db.pragma('foreign_keys = OFF');
  try { fn(); } finally {
    db.pragma('foreign_keys = ON');
    db.pragma('ignore_check_constraints = OFF');
  }
}

function tableCounts(tables) {
  return Object.fromEntries(tables.map((name) => [name, db.prepare(`SELECT COUNT(*) AS n FROM "${name}"`).get().n]));
}

const ALL_TABLES = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'")
  .all().map((r) => r.name);
const PRIVATE_TABLES = new Set(COLUMNS.filter((col) => col.private).map((col) => col.table));
/** Tabellen, an denen das Deaktivieren nichts wegnehmen darf: alle ohne private Spalte. */
// Ohne den Volltextindex: er ist abgeleitet und folgt per Trigger jeder Zeile,
// auch der eigenen Karteikarte eines Kontos.
const SHARED_TABLES = ALL_TABLES
  .filter((name) => !PRIVATE_TABLES.has(name) && name !== 'sessions' && !name.startsWith('search_index'));

// --------------------------------------------------------------------------
// 1 + 2: die Liste gegen das Schema
// --------------------------------------------------------------------------

test('das Schema traegt Fremdschluessel auf users - sonst prueft diese Suite nichts', () => {
  assert.ok(COLUMNS.length >= 133, `gefunden: ${COLUMNS.length}`);
  assert.ok(COLUMNS.some((col) => col.onDelete === 'RESTRICT'));
  assert.ok(COLUMNS.some((col) => col.onDelete === 'NO ACTION'));
});

test('jeder private Eintrag ist eine echte Fremdschluessel-Spalte auf users mit CASCADE oder SET NULL', () => {
  for (const key of PRIVATE_USER_COLUMNS) {
    assert.ok(KEYS.has(key), `${key} steht in PRIVATE_USER_COLUMNS, ist aber keine Fremdschluessel-Spalte auf users(id)`);
    const col = COLUMNS.find((c) => c.key === key);
    assert.ok(['CASCADE', 'SET NULL'].includes(col.onDelete),
      `${key} ist ${col.onDelete}: eine private Spalte muss das Loeschen des Kontos zulassen`);
  }
});

test('keine RESTRICT- oder NO-ACTION-Spalte ist privat', () => {
  for (const col of COLUMNS) {
    if (col.onDelete === 'CASCADE' || col.onDelete === 'SET NULL') continue;
    assert.equal(col.private, false, `${col.key} (${col.onDelete}) haelt das Loeschen auf und darf nicht privat sein`);
  }
});

test('was als geteilt gilt, obwohl es naheliegt, es privat zu nennen', () => {
  // Diese Abgrenzung ist eine Entscheidung, kein Versehen (#1381). Wer eine
  // davon nach PRIVATE_USER_COLUMNS verschiebt, loescht beim Entfernen eines
  // Kontos wieder Daten, die anderen gehoeren oder die der Haushalt braucht.
  for (const key of [
    'reward_ledger.user_id', 'reward_redemptions.user_id', 'notes.created_by',
    'task_assignments.user_id', 'event_assignments.user_id', 'api_tokens.created_by',
    'health_fasts.created_by', 'health_nutrition_entries.created_by', 'health_prevention_records.created_by',
    'expense_ledger_entries.created_by', 'settlements.created_by', 'quick_links.created_by',
  ]) {
    assert.ok(KEYS.has(key), `${key} gibt es nicht mehr - die Abgrenzung neu ansehen`);
    assert.equal(PRIVATE_USER_COLUMNS.has(key), false, `${key} ist geteilt`);
  }
});

// --------------------------------------------------------------------------
// 3: je eine Zeile in JEDER privaten Spalte -> geloescht
// --------------------------------------------------------------------------

test('ein Konto mit je einer Zeile in JEDER privaten Spalte wird geloescht', () => {
  const id = addUser('Nur Privates');
  fabricate(() => {
    for (const col of COLUMNS.filter((c) => c.private)) insertRow(col.table, col.column, id);
  });
  for (const col of COLUMNS.filter((c) => c.private)) {
    assert.equal(db.prepare(`SELECT COUNT(*) AS n FROM "${col.table}" WHERE "${col.column}" = ?`).get(id).n, 1,
      `Vorbedingung: ${col.key} hat eine Zeile`);
  }
  assert.deepEqual(userTraces(db, id), [], 'private Zeilen sind keine Spur');
  const others = db.prepare('SELECT COUNT(*) AS n FROM users WHERE id != ?').get(id).n;
  const shared = tableCounts(SHARED_TABLES.filter((name) => name !== 'users'));

  const result = removeUser(db, id);
  assert.equal(result.outcome, 'deleted');
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM users WHERE id = ?').get(id).n, 0);
  for (const col of COLUMNS.filter((c) => c.private)) {
    assert.equal(db.prepare(`SELECT COUNT(*) AS n FROM "${col.table}" WHERE "${col.column}" = ?`).get(id).n, 0,
      `${col.key}: kein Verweis auf das geloeschte Konto bleibt`);
  }
  assert.deepEqual(tableCounts(SHARED_TABLES.filter((name) => name !== 'users')), shared,
    'und keine Tabelle ohne private Spalte verliert dabei eine Zeile');
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM users').get().n, others, 'kein anderes Konto geht mit');
  assert.equal(db.prepare('PRAGMA foreign_key_check').all().filter((v) => v.parent === 'users').length, 0);
});

// --------------------------------------------------------------------------
// 4: je eine Zeile in JEDER nicht-privaten Spalte -> deaktiviert
// --------------------------------------------------------------------------

for (const col of COLUMNS.filter((c) => !c.private)) {
  test(`eine Zeile in ${col.key} (${col.onDelete}) ist eine Spur: deaktiviert, nichts Geteiltes geht verloren`, () => {
    const id = addUser(`Spur ${col.key}`);
    fabricate(() => insertRow(col.table, col.column, id));
    const before = tableCounts(SHARED_TABLES);

    const result = removeUser(db, id);
    assert.equal(result.outcome, 'deactivated');
    assert.deepEqual(result.traces, [{ table: col.table, column: col.column, rows: 1 }]);
    assert.deepEqual(tableCounts(SHARED_TABLES), before, 'keine Tabelle ohne private Spalte verliert eine Zeile');
    assert.equal(db.prepare(`SELECT COUNT(*) AS n FROM "${col.table}" WHERE "${col.column}" = ?`).get(id).n,
      col.key === 'outlook_accounts.owner_user_id' ? 0 : 1,
      'der Verweis bleibt (nur das Outlook-Konto wird herrenlos)');
    assert.equal(db.prepare(`SELECT 1 AS member FROM users u WHERE u.id = ? AND ${householdMemberSql('u')}`).get(id), undefined,
      'und das Konto ist kein Haushaltsmitglied mehr');
  });
}

test('eine eigene Zeile in den eigenen privaten Daten ist keine Spur, die Zeile fuer jemand anderen schon', () => {
  // health_fasts.user_id ist privat (CASCADE), health_fasts.created_by nicht.
  const own = addUser('Eigene Messung');
  const carer = addUser('Betreuende');
  fabricate(() => {
    insertRow('health_fasts', 'created_by', own, { user_id: own });
    insertRow('health_fasts', 'created_by', carer, { user_id: BYSTANDER });
  });
  assert.deepEqual(userTraces(db, own), []);
  assert.equal(removeUser(db, own).outcome, 'deleted');
  assert.deepEqual(userTraces(db, carer), [{ table: 'health_fasts', column: 'created_by', rows: 1 }]);
  assert.equal(removeUser(db, carer).outcome, 'deactivated');
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM health_fasts WHERE created_by = ?').get(carer).n, 1,
    'die Messung des anderen bleibt samt Urheber');
});

// --------------------------------------------------------------------------
// 6: eine Transaktion, und der letzte Administrator
// --------------------------------------------------------------------------

/** Die Verbindung, die mitschreibt, in welchem Zustand jedes Schreiben lief. */
function recording(database) {
  const writes = [];
  const proxy = new Proxy(database, {
    get(target, prop) {
      if (prop === 'prepare') {
        return (sql) => {
          const statement = target.prepare(sql);
          return new Proxy(statement, {
            get(stmt, name) {
              const value = stmt[name];
              if (typeof value !== 'function') return value;
              return (...args) => {
                if (name === 'run') writes.push({ sql: sql.replace(/\s+/g, ' ').trim(), inTransaction: target.inTransaction });
                return value.apply(stmt, args);
              };
            },
          });
        };
      }
      if (prop === 'transaction') {
        // Die Transaktion der ECHTEN Verbindung, mit dem Proxy als Empfaenger
        // der Aufrufe darin.
        return (fn) => target.transaction(fn);
      }
      const value = target[prop];
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
  return { proxy, writes };
}

function addSession(userId) {
  serial += 1;
  db.prepare('INSERT INTO sessions (sid, sess, expired_at) VALUES (?, ?, ?)')
    .run(`sid-${serial}`, JSON.stringify({ userId, role: 'member' }), Date.now() + 3_600_000);
}
const sessionsOf = (userId) => db.prepare('SELECT sess FROM sessions').all()
  .filter((row) => JSON.parse(row.sess).userId === userId).length;

for (const outcome of ['deactivated', 'deleted']) {
  test(`${outcome}: jedes Schreiben laeuft in der Transaktion - auch das Ende der Sitzungen`, () => {
    const id = addUser(`Transaktion ${outcome}`);
    addSession(id);
    addSession(BYSTANDER);
    if (outcome === 'deactivated') fabricate(() => insertRow('quick_links', 'created_by', id));
    const { proxy, writes } = recording(db);

    assert.equal(removeUser(proxy, id).outcome, outcome);
    assert.ok(writes.length > 3, 'Vorbedingung: der Mitschnitt sieht die Schreibvorgaenge');
    const sessionWrites = writes.filter((w) => /DELETE FROM sessions/.test(w.sql));
    assert.equal(sessionWrites.length, 1, 'genau die eine Sitzung des Kontos endet');
    const outside = writes.filter((w) => !w.inTransaction);
    assert.deepEqual(outside, [], 'kein Schreiben ausserhalb der Transaktion');
    assert.equal(sessionsOf(id), 0);
    assert.ok(sessionsOf(BYSTANDER) >= 1, 'fremde Sitzungen bleiben');
  });
}

test('eine Absage aus `refuse` rollt alles zurueck und kommt als RemovalRefused an', () => {
  const id = addUser('Abgelehnt');
  addSession(id);
  fabricate(() => insertRow('quick_links', 'created_by', id));
  let asked = null;
  assert.throws(
    () => removeUser(db, id, { refuse: (outcome) => { asked = outcome; return new RemovalRefused('no', 'last_admin'); } }),
    (err) => err instanceof RemovalRefused && err.reason === 'last_admin',
  );
  assert.equal(asked, 'deactivated', 'die Absage erfaehrt, was geschehen wuerde');
  assert.equal(db.prepare(`SELECT 1 AS member FROM users u WHERE u.id = ? AND ${householdMemberSql('u')}`).get(id).member, 1);
  assert.equal(sessionsOf(id), 1, 'die Sitzung steht noch');
});

test('ein Konto, das es nicht gibt', () => {
  assert.deepEqual(removeUser(db, 987654321), { outcome: 'not_found', traces: [] });
});

test('beim Deaktivieren enden alle fuenf Abo-Adressen - und es gibt keine sechste', () => {
  const feedColumns = db.prepare('PRAGMA table_info(users)').all()
    .map((c) => c.name).filter((name) => /_feed_token$/.test(name)).sort();
  assert.deepEqual([...FEED_TOKEN_COLUMNS].sort(), feedColumns,
    'eine neue *_feed_token-Spalte an users gehoert in FEED_TOKEN_COLUMNS, sonst ueberlebt sie das Deaktivieren');
});

// --------------------------------------------------------------------------
// Das Inventar: jede Spalte, die ein Geheimnis traegt
// --------------------------------------------------------------------------

/**
 * Jede Spalte des Schemas, deren Name nach einem Geheimnis aussieht, und was
 * beim DEAKTIVIEREN eines Kontos mit ihr geschieht. Die Liste ist das Inventar
 * hinter `deactivate()` in server/services/user-removal.js: eine NEUE solche
 * Spalte ist rot, bis hier steht, ob sie ein Weg hinein ist - sonst waechst
 * das Schema an der Stelle vorbei, an der Zugaenge enden.
 *
 *   ended    - endet in der Transaktion (das Verhalten misst test:user-deactivation)
 *   kept     - bleibt, und kein Weg wertet sie fuer ein deaktiviertes Konto aus
 *   household- gehoert dem Haushalt, nicht dem Konto; oeffnet nichts in Yuvomi
 *   no-secret- heisst nur so
 */
const SECRET_COLUMNS = {
  'local_calendars.feed_token': 'household: the calendar belongs to the household; its feed stays when its creator leaves and can be revoked or rotated by an admin',
  'users.password_hash': 'kept: nur POST /auth/login (canSignIn) und PATCH /auth/me/password (requireAuth) lesen ihn',
  'users.oidc_sub': 'kept: der SSO-Rueckweg muss das Konto finden, um es abzuweisen statt ein neues anzulegen',
  'users.calendar_feed_token': 'ended: auf NULL gesetzt',
  'users.inventory_deadlines_feed_token': 'ended: auf NULL gesetzt',
  'users.cycle_feed_token': 'ended: auf NULL gesetzt',
  'users.schedule_feed_token': 'ended: auf NULL gesetzt',
  'users.waste_feed_token': 'ended: auf NULL gesetzt',
  'api_tokens.token_hash': 'ended: revoked_at fuer Subjekt UND Aussteller',
  'api_tokens.token_prefix': 'no-secret: Anzeigehilfe zum Token darueber',
  'password_resets.token_hash': 'ended: geloescht',
  'invites.token_hash': 'ended: offene Einladungen des Kontos widerrufen',
  'push_subscriptions.p256dh': 'ended: geloescht',
  'push_subscriptions.auth': 'ended: geloescht',
  'notification_channels.secret_json': 'ended: eigene Kanaele geloescht; Haushaltskanaele gehoeren dem Haushalt',
  'user_totp.secret': 'kept: nur /auth/2fa/verify (canSignIn vor der Pruefung) und 2FA-Routen hinter requireAuth',
  'user_recovery_codes.code_hash': 'ended: geloescht',
  'display_pairing_codes.code_hash': 'ended: offene Codes des Kontos verbraucht (auch beim Loeschen)',
  'display_devices.token_hash': 'kept: das Geheimnis hat nur das gekoppelte Geraet, nie der Aussteller des Codes',
  'outlook_accounts.access_token': 'household: Zugang zu Microsoft; das Konto verliert nur seinen Eigentuemer',
  'outlook_accounts.refresh_token': 'household: wie access_token',
  'outlook_accounts.token_expiry': 'no-secret: Ablaufzeit',
  'caldav_accounts.password': 'household: Zugang zu einem fremden Kalenderdienst',
  'carddav_accounts.password': 'household: Zugang zu einem fremden Adressbuchdienst',
  'dms_accounts.api_token': 'household: Zugang zu einem fremden Dokumentendienst',
  'recipe_provider_accounts.api_token': 'household: Zugang zu einem fremden Rezeptdienst',
  'google_calendar_selection.sync_token': 'no-secret: Fortschrittsmarke des Abgleichs',
};

test('jede Spalte, die ein Geheimnis traegt, steht im Inventar - und keine darin ist erfunden', () => {
  const looksSecret = /token|secret|password|code_hash|p256dh|^auth$|^oidc_sub$/i;
  const found = [];
  for (const name of ALL_TABLES) {
    if (name.startsWith('search_index')) continue;
    for (const info of db.prepare(`PRAGMA table_info("${name}")`).all()) {
      if (looksSecret.test(info.name)) found.push(`${name}.${info.name}`);
    }
  }
  const unknown = found.filter((key) => !(key in SECRET_COLUMNS));
  assert.deepEqual(unknown, [],
    'neue Spalte mit Geheimnis: in deactivate() (server/services/user-removal.js) entscheiden, ob sie endet, und hier eintragen');
  const gone = Object.keys(SECRET_COLUMNS).filter((key) => !found.includes(key));
  assert.deepEqual(gone, [], 'Eintrag ohne Spalte - entfernen');
  for (const [key, fate] of Object.entries(SECRET_COLUMNS)) {
    assert.match(fate, /^(ended|kept|household|no-secret): .{8,}/, `${key} braucht ein Urteil mit Grund`);
  }
});

test('was beim Deaktivieren als "ended" gilt, ist danach wirklich weg', () => {
  const id = addUser('Inventar');
  const other = addUser('Inventar Nachbar');
  const display = addUser('Inventar Tablett');
  fabricate(() => {
    insertRow('quick_links', 'created_by', id);
    db.prepare(`UPDATE users SET ${FEED_TOKEN_COLUMNS.map((c) => `${c} = '${c}-${id}'`).join(', ')}, oidc_sub = 'sub-${id}' WHERE id = ?`).run(id);
    insertRow('api_tokens', 'subject_user_id', id);
    insertRow('api_tokens', 'created_by', id, { subject_user_id: other });
    insertRow('password_resets', 'user_id', id);
    insertRow('invites', 'created_by', id, { expires_at: Date.now() + 3_600_000 });
    insertRow('push_subscriptions', 'user_id', id);
    insertRow('notification_channels', 'user_id', id);
    insertRow('user_totp', 'user_id', id);
    insertRow('user_recovery_codes', 'user_id', id);
    insertRow('display_pairing_codes', 'created_by', id, { user_id: display, expires_at: '2999-01-01T00:00:00Z' });
    insertRow('display_devices', 'user_id', display);
  });
  addSession(id);
  db.prepare('INSERT INTO sessions (sid, sess, expired_at) VALUES (?, ?, ?)')
    .run(`pending-${id}`, JSON.stringify({ pendingTwoFactor: { userId: id } }), Date.now() + 60_000);
  db.prepare('INSERT INTO sessions (sid, sess, expired_at) VALUES (?, ?, ?)')
    .run(`linking-${id}`, JSON.stringify({ userId: id, oidc: { linkUserId: id } }), Date.now() + 60_000);
  const hashBefore = db.prepare('SELECT password_hash FROM users WHERE id = ?').get(id).password_hash;

  assert.equal(removeUser(db, id).outcome, 'deactivated');
  const n = (sql, ...args) => db.prepare(sql).get(...args).n;
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(id);
  for (const column of FEED_TOKEN_COLUMNS) assert.equal(user[column], null, column);
  assert.equal(n('SELECT COUNT(*) AS n FROM api_tokens WHERE (subject_user_id = ? OR created_by = ?) AND revoked_at IS NULL', id, id), 0);
  assert.equal(n('SELECT COUNT(*) AS n FROM api_tokens WHERE subject_user_id = ? OR created_by = ?', id, id), 2, 'widerrufen, nicht geloescht');
  assert.equal(n('SELECT COUNT(*) AS n FROM password_resets WHERE user_id = ?', id), 0);
  assert.equal(n('SELECT COUNT(*) AS n FROM invites WHERE created_by = ? AND revoked_at IS NULL', id), 0);
  assert.equal(n('SELECT COUNT(*) AS n FROM push_subscriptions WHERE user_id = ?', id), 0);
  assert.equal(n('SELECT COUNT(*) AS n FROM notification_channels WHERE user_id = ?', id), 0);
  assert.equal(n('SELECT COUNT(*) AS n FROM user_recovery_codes WHERE user_id = ?', id), 0);
  assert.equal(n('SELECT COUNT(*) AS n FROM display_pairing_codes WHERE created_by = ? AND used_at IS NULL', id), 0);
  assert.equal(n('SELECT COUNT(*) AS n FROM sessions WHERE sid IN (?, ?)', `pending-${id}`, `linking-${id}`), 0,
    'auch die Sitzungen, die das Konto nur im Wartezustand oder im Verknuepfungs-Lauf nennen');
  assert.equal(sessionsOf(id), 0);
  // kept:
  assert.equal(user.password_hash, hashBefore);
  assert.equal(user.oidc_sub, `sub-${id}`);
  assert.equal(n('SELECT COUNT(*) AS n FROM user_totp WHERE user_id = ?', id), 1);
  assert.equal(n('SELECT COUNT(*) AS n FROM display_devices WHERE user_id = ? AND revoked_at IS NULL', display), 1,
    'das gekoppelte Geraet eines Tabletts bleibt');
});

// --------------------------------------------------------------------------
// 5: die Spalte hat genau ein Zuhause
// --------------------------------------------------------------------------

/**
 * Wo `deactivated_at` unter server/ stehen darf. Die ersten vier schreiben oder
 * lesen die Spalte selbst; die Eintraege mit Zahl nennen nur den NAMEN des
 * API-Felds, und die Zahl haelt fest, dass dort nichts dazukommt.
 */
const COLUMN_HOMES = new Map([
  ['server/services/account-state.js', null],
  ['server/services/user-removal.js', null],
  ['server/db.js', null],
  ['server/db-schema-test.js', null],
  // publicUser(): `deactivated_at: row.deactivated_at ?? null` - das Feld der Antwort.
  ['server/auth.js', 2],
  // Die Beschreibung desselben Felds an GET /auth/users.
  ['server/openapi/paths/auth.js', 1],
]);

function sourceFiles(dir) {
  const out = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...sourceFiles(full));
    else if (/\.(js|mjs|cjs)$/.test(entry)) out.push(full);
  }
  return out;
}

test('users.deactivated_at wird unter server/ nur an den benannten Stellen geschrieben', () => {
  const seen = new Map();
  for (const file of sourceFiles(join(ROOT, 'server'))) {
    const rel = relative(ROOT, file).split(sep).join('/');
    const code = withoutCommentsKeepingLines(readFileSync(file, 'utf8'));
    const hits = code.match(/deactivated_at/g)?.length ?? 0;
    if (hits) seen.set(rel, hits);
  }
  for (const [file, hits] of seen) {
    assert.ok(COLUMN_HOMES.has(file),
      `${file} nennt deactivated_at (${hits}x). Die Frage "ist dieses Konto aktiv" stellt activeAccountSql() `
      + 'aus server/services/account-state.js (weitergereicht von household-members.js) - nicht eine eigene Bedingung.');
    const allowed = COLUMN_HOMES.get(file);
    if (allowed !== null) assert.equal(hits, allowed, `${file}: erwartet ${allowed} Nennung(en) des Feldnamens, gefunden ${hits}`);
  }
  for (const file of COLUMN_HOMES.keys()) {
    assert.ok(seen.has(file), `${file} steht in COLUMN_HOMES, nennt die Spalte aber nicht mehr - Eintrag entfernen`);
  }
});

test('Selbsttest: der Schnitt liest Code, keine Kommentare', () => {
  const code = withoutCommentsKeepingLines('// deactivated_at\nconst a = "deactivated_at"; /* deactivated_at */\n');
  assert.equal(code.match(/deactivated_at/g).length, 1);
});
