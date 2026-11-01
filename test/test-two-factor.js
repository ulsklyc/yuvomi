/**
 * Modul: Zwei-Faktor-Anmeldung, Regeln und Routen (#672)
 * Zweck: Der Rechenkern steht in test-totp.js. Hier geht es um das, was mit der
 *        Datenbank und der Sitzung geschieht - die Stellen, an denen eine
 *        Zwei-Faktor-Anmeldung praktisch scheitert, sind fast nie die Mathematik.
 *
 *        Deckt ab:
 *          - die Einrichtung ist erst nach einem gueltigen Code scharf; ein
 *            unbestaetigtes Geheimnis sperrt niemanden aus
 *          - ein bestaetigtes Geheimnis wird von /setup NICHT ueberschrieben
 *          - Wiederherstellungscodes gelten genau einmal
 *          - DER WARTEZUSTAND IST KEINE ANMELDUNG: `pendingTwoFactor` traegt
 *            einen anderen Schluessel als `userId`, damit `requireAuth` blind
 *            dafuer ist. Der Test liest das aus der Quelle nach, weil ein
 *            Tippfehler hier eine stille Vollanmeldung waere
 *          - der Wartezustand verfaellt
 *          - Abschalten verlangt den zweiten Faktor und ist gesperrt, solange
 *            der Haushalt ihn verlangt
 *          - neue Wiederherstellungscodes entwerten die alten
 *          - das Loeschen eines Nutzers raeumt Geheimnis und Codes mit weg
 * Ausfuehren: node --experimental-sqlite --test test/test-two-factor.js
 */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import Database from 'better-sqlite3-multiple-ciphers';

process.env.DB_PATH = ':memory:';
process.env.SESSION_SECRET = 'two-factor-test-secret';

const { MIGRATIONS, get, _setTestDatabase } = await import('../server/db.js');
const twoFactor = await import('../server/services/two-factor.js');
const { generateCode, generateSecret } = await import('../server/utils/totp.js');

const moduleDatabase = get();
const db = buildMigratedDatabase(MIGRATIONS);
_setTestDatabase(db);
moduleDatabase.close();

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

function seedUser(prefix) {
  const username = `${prefix}-${randomUUID()}`;
  const id = db.prepare(`
    INSERT INTO users (username, display_name, password_hash, avatar_color, role)
    VALUES (?, ?, 'hash', '#007AFF', 'member')
  `).run(username, prefix).lastInsertRowid;
  return { id, username };
}

// Feste Uhr. Ohne sie haengt jeder Testlauf davon ab, wie weit die echte Zeit
// gerade im 30-Sekunden-Fenster steht - ein Code "einen Schritt spaeter" kann
// dann zwei Schritte entfernt landen und der Lauf wird sporadisch rot.
const NOW  = 1_700_000_000_000;
const STEP = 30_000;

/** Richtet einen Nutzer vollstaendig ein und liefert Geheimnis + Codes. */
function enableFor(user, nowMs = NOW) {
  const { secret } = twoFactor.beginSetup(db, user);
  const { recovery_codes: codes } = twoFactor.confirmSetup(db, user.id, generateCode(secret, nowMs), { nowMs });
  return { secret, codes };
}

test.after(() => { db.close(); });

// --------------------------------------------------------
// Einrichtung
// --------------------------------------------------------

test('frisch angelegt ist nichts scharf', () => {
  const user = seedUser('neu');
  const status = twoFactor.getStatus(db, user.id);
  assert.deepEqual(status, { enabled: false, pending: false, recovery_remaining: 0, required: false });
  assert.equal(twoFactor.isEnabled(db, user.id), false);
});

test('ein unbestaetigtes Geheimnis sperrt niemanden aus', () => {
  const user = seedUser('halb');
  const { secret, uri, qr } = twoFactor.beginSetup(db, user);

  assert.equal(secret.length, 32);
  assert.ok(uri.startsWith('otpauth://totp/Yuvomi:'));
  assert.ok(qr.startsWith('data:image/svg+xml;base64,'));

  // Angelegt, aber nicht scharf: der Login darf hier NICHT nach einem Code fragen.
  assert.equal(twoFactor.isEnabled(db, user.id), false);
  const status = twoFactor.getStatus(db, user.id);
  assert.equal(status.pending, true);
  assert.equal(status.enabled, false);
});

test('ein falscher Code schaltet nicht scharf', () => {
  const user = seedUser('falsch');
  twoFactor.beginSetup(db, user);
  assert.throws(() => twoFactor.confirmSetup(db, user.id, '000000'), (err) => err.code === 'invalid_code');
  assert.equal(twoFactor.isEnabled(db, user.id), false);
});

test('ein gueltiger Code schaltet scharf und liefert zehn Codes', () => {
  const user = seedUser('scharf');
  const { secret } = twoFactor.beginSetup(db, user);
  const { recovery_codes: codes } = twoFactor.confirmSetup(db, user.id, generateCode(secret, NOW), { nowMs: NOW });

  assert.equal(codes.length, 10);
  assert.equal(new Set(codes).size, 10);
  assert.equal(twoFactor.isEnabled(db, user.id), true);
  assert.deepEqual(twoFactor.getStatus(db, user.id), {
    enabled: true, pending: false, recovery_remaining: 10, required: false,
  });

  // Im Klartext steht nichts in der Datenbank.
  const stored = db.prepare('SELECT code_hash FROM user_recovery_codes WHERE user_id = ?').all(user.id);
  assert.equal(stored.length, 10);
  for (const codeText of codes) {
    assert.ok(!stored.some((r) => r.code_hash === codeText), 'Klartext in der Datenbank');
  }
});

test('ein bestaetigtes Geheimnis wird von /setup nicht ueberschrieben', () => {
  const user = seedUser('bestand');
  const { secret } = enableFor(user);

  assert.throws(() => twoFactor.beginSetup(db, user), (err) => err.code === 'already_enabled');

  // Das alte Geheimnis gilt weiter - ein versehentlicher Klick darf den
  // zweiten Faktor eines aktiven Kontos nicht ersetzen.
  const later = NOW + STEP;
  assert.equal(twoFactor.verifySecondFactor(db, user.id, generateCode(secret, later), { nowMs: later }).valid, true);
});

test('eine abgebrochene Einrichtung laesst sich neu beginnen', () => {
  const user = seedUser('nochmal');
  const first = twoFactor.beginSetup(db, user);
  const second = twoFactor.beginSetup(db, user);
  assert.notEqual(first.secret, second.secret);

  // Nur das zweite Geheimnis zaehlt.
  assert.throws(() => twoFactor.confirmSetup(db, user.id, generateCode(first.secret, NOW), { nowMs: NOW }), (err) => err.code === 'invalid_code');
  assert.doesNotThrow(() => twoFactor.confirmSetup(db, user.id, generateCode(second.secret, NOW), { nowMs: NOW }));
});

// --------------------------------------------------------
// Pruefung
// --------------------------------------------------------

test('ein TOTP-Code gilt, ein falscher nicht', () => {
  const user = seedUser('pruef');
  const { secret } = enableFor(user);
  const later = NOW + STEP;

  const good = twoFactor.verifySecondFactor(db, user.id, generateCode(secret, later), { nowMs: later });
  assert.equal(good.valid, true);
  assert.equal(good.method, 'totp');

  assert.equal(twoFactor.verifySecondFactor(db, user.id, '000000', { nowMs: later }).valid, false);
  assert.equal(twoFactor.verifySecondFactor(db, user.id, '', { nowMs: later }).valid, false);
});

test('derselbe TOTP-Code gilt kein zweites Mal', () => {
  const user = seedUser('replay');
  const { secret } = enableFor(user);
  const later = NOW + STEP;
  const code = generateCode(secret, later);

  assert.equal(twoFactor.verifySecondFactor(db, user.id, code, { nowMs: later }).valid, true);
  assert.equal(twoFactor.verifySecondFactor(db, user.id, code, { nowMs: later }).valid, false, 'Replay durchgelassen');
});

test('ein Wiederherstellungscode gilt genau einmal', () => {
  const user = seedUser('rescue');
  const { codes } = enableFor(user);

  const first = twoFactor.verifySecondFactor(db, user.id, codes[0]);
  assert.equal(first.valid, true);
  assert.equal(first.method, 'recovery');
  assert.equal(first.recovery_remaining, 9);

  assert.equal(twoFactor.verifySecondFactor(db, user.id, codes[0]).valid, false, 'zweimal eingeloest');
  assert.equal(twoFactor.verifySecondFactor(db, user.id, codes[1]).valid, true);
  assert.equal(twoFactor.getStatus(db, user.id).recovery_remaining, 8);
});

test('ein Wiederherstellungscode wird auch mit anderer Schreibweise erkannt', () => {
  const user = seedUser('schreib');
  const { codes } = enableFor(user);
  assert.equal(twoFactor.verifySecondFactor(db, user.id, codes[0].toLowerCase()).valid, true);
  assert.equal(twoFactor.verifySecondFactor(db, user.id, codes[1].replace('-', ' ')).valid, true);
  assert.equal(twoFactor.verifySecondFactor(db, user.id, ` ${codes[2]} `).valid, true);
});

test('der Code eines anderen Nutzers gilt nicht', () => {
  const anna = seedUser('anna');
  const bob  = seedUser('bob');
  const a = enableFor(anna);
  enableFor(bob);
  const later = NOW + STEP;

  assert.equal(twoFactor.verifySecondFactor(db, bob.id, generateCode(a.secret, later), { nowMs: later }).valid, false);
  assert.equal(twoFactor.verifySecondFactor(db, bob.id, a.codes[0]).valid, false);
});

test('wer nichts eingerichtet hat, besteht keine Pruefung', () => {
  const user = seedUser('ohne');
  assert.equal(twoFactor.verifySecondFactor(db, user.id, generateCode(generateSecret(), NOW), { nowMs: NOW }).valid, false);
  // Auch ein halb eingerichtetes Konto nicht.
  twoFactor.beginSetup(db, user);
  assert.equal(twoFactor.verifySecondFactor(db, user.id, '123456').valid, false);
});

// --------------------------------------------------------
// Abschalten und Erneuern
// --------------------------------------------------------

test('Abschalten raeumt Geheimnis und Codes weg', () => {
  const user = seedUser('weg');
  enableFor(user);
  twoFactor.disable(db, user.id);

  assert.equal(twoFactor.isEnabled(db, user.id), false);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM user_totp WHERE user_id = ?').get(user.id).n, 0);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM user_recovery_codes WHERE user_id = ?').get(user.id).n, 0);
});

test('neue Wiederherstellungscodes entwerten die alten', () => {
  const user = seedUser('erneuern');
  const { codes: old } = enableFor(user);
  const { recovery_codes: fresh } = twoFactor.regenerateRecoveryCodes(db, user.id);

  assert.equal(fresh.length, 10);
  assert.equal(twoFactor.getStatus(db, user.id).recovery_remaining, 10);
  assert.equal(twoFactor.verifySecondFactor(db, user.id, old[0]).valid, false, 'alter Code gilt noch');
  assert.equal(twoFactor.verifySecondFactor(db, user.id, fresh[0]).valid, true);
});

test('ohne eingerichteten Faktor gibt es keine neuen Codes', () => {
  const user = seedUser('nichts');
  assert.throws(() => twoFactor.regenerateRecoveryCodes(db, user.id), (err) => err.code === 'not_enabled');
});

test('die Pflicht-Route traegt ihr Admin-Gate als Middleware', () => {
  // Der erste Anlauf haengte die Pflicht als Feld an `PUT /preferences` und
  // pruefte die Rolle in einem `if`-Zweig im Handler - wie es dort Zeitzone und
  // Sprache tun. `test-settings-admin-gate.js` hat das abgewiesen, zu Recht:
  // eine Berechtigungsregel, die in einem Feld-Zweig wohnt, ist von aussen
  // nicht als solche zu erkennen, und die Settings-Seite, die sie bedient,
  // gilt als adminOnly, waehrend ihr Endpunkt es nicht ist.
  const source = readFileSync(new URL('../server/auth.js', import.meta.url), 'utf8');
  const line = source.split('\n').find((l) => l.includes("router.put('/2fa/require'"));
  assert.ok(line, 'die Route zum Setzen der Pflicht fehlt');
  assert.ok(line.includes('requireAdmin'), 'die Pflicht laesst sich ohne Admin-Gate setzen');
  assert.ok(line.includes('csrfMiddleware'), 'die Pflicht laesst sich ohne CSRF-Schutz setzen');

  // Und sie steht NICHT mehr an den Preferences.
  const prefs = readFileSync(new URL('../server/routes/preferences.js', import.meta.url), 'utf8');
  assert.ok(!prefs.includes('require_two_factor'), 'die Pflicht haengt wieder an PUT /preferences');
});

test('die Haushaltspflicht laesst sich setzen und wieder loesen', () => {
  const user = seedUser('pflicht');
  assert.equal(twoFactor.isRequiredForHousehold(db), false);

  twoFactor.setRequiredForHousehold(db, true);
  assert.equal(twoFactor.isRequiredForHousehold(db), true);
  assert.equal(twoFactor.getStatus(db, user.id).required, true);

  twoFactor.setRequiredForHousehold(db, false);
  assert.equal(twoFactor.isRequiredForHousehold(db), false);
});

test('ein geloeschter Nutzer nimmt Geheimnis und Codes mit', () => {
  const user = seedUser('tschuess');
  enableFor(user);
  db.prepare('DELETE FROM users WHERE id = ?').run(user.id);

  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM user_totp WHERE user_id = ?').get(user.id).n, 0);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM user_recovery_codes WHERE user_id = ?').get(user.id).n, 0);
});

// --------------------------------------------------------
// Der Wartezustand ist keine Anmeldung
// --------------------------------------------------------

test('der Wartezustand traegt einen anderen Schluessel als eine echte Sitzung', () => {
  const source = readFileSync(new URL('../server/auth.js', import.meta.url), 'utf8');

  // Der Login setzt beim zweiten Faktor NICHT session.userId.
  const loginBlock = source.slice(source.indexOf("router.post('/login'"), source.indexOf("export function buildResetRoutes"));
  const pendingLine = loginBlock.split('\n').find((line) => line.includes('pendingTwoFactor'));
  assert.ok(pendingLine, 'der Login kennt keinen Wartezustand');
  assert.ok(!pendingLine.includes('session.userId'), 'der Wartezustand setzt session.userId');

  // requireAuth prueft session.userId und kennt pendingTwoFactor nicht.
  const guard = source.slice(source.indexOf('function requireAuth'), source.indexOf('function setupAuthSession'));
  assert.ok(guard.includes('req.session.userId'), 'requireAuth prueft nicht mehr session.userId');
  assert.ok(!guard.includes('pendingTwoFactor'), 'requireAuth kennt den Wartezustand - er waere damit eine Anmeldung');

  // Und die Verify-Route baut die Sitzung ueber setupAuthSession neu auf,
  // statt den Wartezustand aufzuwerten (Schutz gegen Session Fixation).
  const verify = source.slice(source.indexOf("router.post('/2fa/verify'"), source.indexOf("router.get('/2fa'"));
  assert.ok(verify.includes('setupAuthSession'), 'die Verify-Route regeneriert die Sitzung nicht');
  assert.ok(verify.includes('consumePendingTwoFactor'), 'die Verify-Route prueft den Wartezustand nicht');
});

test('JEDER Weg in eine Sitzung prueft den zweiten Faktor - auch SSO', () => {
  // Die teuerste Luecke dieses Features, und sie stand nicht im Login:
  // `/oidc/callback` rief `setupAuthSession` direkt auf. Wer den zweiten
  // Faktor eingeschaltet hatte und sich per SSO anmeldete, wurde nie gefragt -
  // und die haushaltsweite PFLICHT waere ueber diesen Weg auszuhebeln gewesen,
  // womit sie keine Pflicht mehr ist, sondern eine Bitte an die, die den
  // Passwort-Weg nehmen.
  //
  // Deshalb prueft dieser Test die Regel und nicht die eine Stelle: JEDER
  // Aufruf von `setupAuthSession` steht hinter einer `isEnabled`-Pruefung.
  //
  // Die Liste der Ausnahmen ist bewusst EINE und nicht vier. Naheliegend
  // waeren auch /setup, die Einladung und der Passwort-Reset - nur meldet
  // keiner der drei selbst an: /setup legt den ersten Nutzer nur an, die
  // Einladung ebenso, und der Reset setzt das Passwort und schickt zum Login.
  // Als Ausnahme eingetragen wuerden sie genau dann zur Luecke, wenn jemand
  // ihnen spaeter eine Anmeldung beigibt - der Guard schwiege dazu. Deshalb
  // steht hier nur der Weg, der die Pruefung wirklich IST.
  const source = readFileSync(new URL('../server/auth.js', import.meta.url), 'utf8');
  const lines = source.split('\n');

  const callers = [];
  const unguarded = [];
  lines.forEach((line, index) => {
    // Der Aufruf, nicht die Definition - die traegt dieselbe Zeichenfolge.
    // (Sie stand hier zuerst mit drin und wurde von einer der toten Ausnahmen
    // verschluckt: genau die Art Treffer, die eine Ausnahmeliste verdeckt.)
    if (!line.includes('setupAuthSession(req, res')) return;
    if (/^\s*function\s/.test(line)) return;

    // Den umgebenden Routen-Block nach oben suchen.
    let start = index;
    while (start > 0 && !/^(router\.(get|post)|\s*targetRouter\.(get|post))/.test(lines[start])) start -= 1;
    const header = lines[start];
    callers.push(header.trim().slice(0, 48));

    // Die Verify-Route ist selbst die Pruefung.
    if (header.includes("'/2fa/verify'")) return;
    if (lines.slice(start, index).join('\n').includes('twoFactor.isEnabled')) return;

    unguarded.push(`auth.js:${index + 1} (Route ab Zeile ${start + 1}: ${header.trim().slice(0, 60)})`);
  });

  assert.deepEqual(
    unguarded,
    [],
    'Diese Stellen bauen eine Sitzung auf, ohne den zweiten Faktor zu pruefen - '
    + `ueber sie ist die Haushaltspflicht auszuhebeln:\n${unguarded.join('\n')}`,
  );

  // Eine leere Liste ist fuer sich keine Zusicherung: sie waere auch leer,
  // wenn der Suchbegriff nicht mehr passte. Deshalb die Gegenprobe, dass
  // ueberhaupt die erwarteten Wege gefunden wurden.
  assert.equal(callers.length, 4, `expected four sign-in paths, found: ${callers.join(' | ')}`);
  assert.ok(callers.some((c) => c.includes("'/login'")), 'der Passwort-Login wurde nicht gefunden');
  assert.ok(callers.some((c) => c.includes("'/passkeys/login/verify'")), 'passkey sign-in route was not found');
  assert.ok(callers.some((c) => c.includes("'/oidc/callback'")), 'der OIDC-Callback wurde nicht gefunden');
  assert.ok(callers.some((c) => c.includes("'/2fa/verify'")), 'die Verify-Route wurde nicht gefunden');

  // Und ausdruecklich fuer den Weg, an dem es wirklich fehlte.
  const callback = source.slice(source.indexOf("router.get('/oidc/callback'"), source.indexOf("router.post('/setup'"));
  assert.ok(callback.includes('twoFactor.isEnabled'), 'der OIDC-Callback prueft den zweiten Faktor nicht');
  assert.ok(callback.includes('pendingTwoFactor'), 'der OIDC-Callback legt keinen Wartezustand an');
});

test('der Wartezustand verfaellt und wird dann verworfen', async () => {
  const source = readFileSync(new URL('../server/auth.js', import.meta.url), 'utf8');
  const helper = source.slice(source.indexOf('function consumePendingTwoFactor'), source.indexOf("router.post('/2fa/verify'"));

  assert.ok(helper.includes('expiresAt'), 'der Wartezustand hat keine Frist');
  assert.ok(helper.includes('delete req.session.pendingTwoFactor'), 'ein abgelaufener Wartezustand bleibt liegen');

  // Die Frist selbst: fuenf Minuten, nicht unbegrenzt.
  assert.match(source, /const TWO_FACTOR_WINDOW_MS = 5 \* 60 \* 1000;/);
});

test('jede 2FA-Route ist gegen Raten gebremst', () => {
  const source = readFileSync(new URL('../server/auth.js', import.meta.url), 'utf8');
  // Jede Route, die einen Code entgegennimmt, braucht den Limiter. Ein
  // sechsstelliger Code ist ohne Bremse in Minuten durchprobiert.
  for (const route of ['/2fa/verify', '/2fa/enable', '/2fa/disable', '/2fa/recovery-codes']) {
    const line = source.split('\n').find((l) => l.includes(`router.post('${route}'`));
    assert.ok(line, `Route ${route} fehlt`);
    assert.ok(line.includes('twoFactorLimiter'), `Route ${route} ist ungebremst`);
  }
  // Der Limiter zaehlt ALLE Antworten, nicht nur die abgelehnten.
  const block = source.slice(source.indexOf('const twoFactorLimiter'), source.indexOf('const TWO_FACTOR_WINDOW_MS'));
  assert.ok(!block.includes('skipSuccessfulRequests'), 'erfolgreiche Versuche werden uebersprungen');
});
