/**
 * Modul: SSO als einziger Weg hinein (#847)
 * Zweck: Der Schalter `AUTH_ALLOW_PASSWORD_LOGIN`, Konten ohne Passwort und die
 *        Loecher, die beide im Passwort-Reset aufreissen wuerden.
 * Ausfuehren: node --experimental-sqlite test/test-sso-only.js
 *
 * Warum eine eigene Suite und nicht ein Kapitel in test-oidc.js: die Regeln
 * hier gelten fuer die EINGEBAUTE Anmeldung. Dass OIDC ueber ihr Wirksamwerden
 * entscheidet, macht sie nicht zu OIDC-Regeln - test-oidc.js prueft, was der
 * Anbieter darf, diese Datei prueft, was das Formular noch darf.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { DatabaseSync } from 'node:sqlite';
import { createPasswordResetService } from '../server/services/password-reset.js';
import {
  isPasswordLoginEnabled,
  passwordLoginWarning,
  isSsoOnlyAccount,
  OIDC_PASSWORD_SENTINEL,
} from '../server/services/oidc.js';

process.env.SESSION_SECRET = process.env.SESSION_SECRET || 'test-secret';

const OIDC_ENV = {
  OIDC_ISSUER: 'https://idp.example/',
  OIDC_CLIENT_ID: 'yuvomi',
  OIDC_CLIENT_SECRET: 'shh',
  OIDC_REDIRECT_URI: 'https://home.example/api/v1/auth/oidc/callback',
};

/**
 * Fuehrt `fn` mit einer gesetzten Umgebung aus und stellt sie danach exakt
 * wieder her - auch die Faelle "war vorher nicht gesetzt". Ein Test, der eine
 * Variable stehen laesst, verschiebt das Ergebnis des naechsten.
 *
 * Gibt `fn` ein Promise zurueck, wird bis dahin gewartet. Ein `finally` allein
 * raeumte sonst auf, sobald das Promise ERZEUGT ist - der eigentliche Aufruf
 * liefe dann schon wieder mit der alten Umgebung und der Test waere gruen,
 * ohne je den Zustand geprueft zu haben, um den es ihm ging.
 */
function withEnv(vars, fn) {
  const before = {};
  for (const [k, v] of Object.entries(vars)) {
    before[k] = process.env[k];
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  const restore = () => {
    for (const [k, v] of Object.entries(before)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  };
  let result;
  try {
    result = fn();
  } catch (err) {
    restore();
    throw err;
  }
  if (result && typeof result.then === 'function') {
    return result.then(
      (value) => { restore(); return value; },
      (err) => { restore(); throw err; },
    );
  }
  restore();
  return result;
}

const withOidc = (extra, fn) => withEnv({ ...OIDC_ENV, ...extra }, fn);
const withoutOidc = (extra, fn) => withEnv({
  OIDC_ISSUER: undefined, OIDC_CLIENT_ID: undefined,
  OIDC_CLIENT_SECRET: undefined, OIDC_REDIRECT_URI: undefined, ...extra,
}, fn);

// ─── Der Schalter selbst ─────────────────────────────────────────────────────

test('ohne den Schalter bleibt die Passwort-Anmeldung an', () => {
  withOidc({ AUTH_ALLOW_PASSWORD_LOGIN: undefined }, () => {
    assert.equal(isPasswordLoginEnabled(), true);
  });
});

test('AUTH_ALLOW_PASSWORD_LOGIN=false schaltet sie ab, wenn OIDC konfiguriert ist', () => {
  withOidc({ AUTH_ALLOW_PASSWORD_LOGIN: 'false' }, () => {
    assert.equal(isPasswordLoginEnabled(), false);
  });
});

test('nur der ausdrueckliche Wert "false" schaltet ab', () => {
  // Ein Sicherheitsschalter, der auf jeden gesetzten Wert reagiert, macht aus
  // einem Tippfehler eine Aussperrung - dieselbe Regel wie OIDC_ALLOW_SIGNUP.
  for (const value of ['true', '1', 'no', 'FALSE', '']) {
    withOidc({ AUTH_ALLOW_PASSWORD_LOGIN: value }, () => {
      assert.equal(isPasswordLoginEnabled(), true, `"${value}" darf nicht abschalten`);
    });
  }
});

test('ohne OIDC wird der Schalter ignoriert, statt alle auszusperren', () => {
  // Das ist die wichtigste Zusicherung der ganzen Datei: griffe er hier, waere
  // eine einzelne Zeile in der .env ein Haushalt ohne Weg in seine eigene App.
  withoutOidc({ AUTH_ALLOW_PASSWORD_LOGIN: 'false' }, () => {
    assert.equal(isPasswordLoginEnabled(), true);
  });
});

test('ein unvollstaendig konfiguriertes OIDC zaehlt nicht als konfiguriert', () => {
  // Drei von vier Werten sind kein Anbieter, sondern ein halb fertiger Versuch.
  withOidc({ OIDC_CLIENT_SECRET: undefined, AUTH_ALLOW_PASSWORD_LOGIN: 'false' }, () => {
    assert.equal(isPasswordLoginEnabled(), true);
  });
});

test('der ignorierte Schalter meldet sich, statt still zu versagen', () => {
  withoutOidc({ AUTH_ALLOW_PASSWORD_LOGIN: 'false' }, () => {
    const warning = passwordLoginWarning();
    assert.ok(warning, 'ohne Warnung glaubt der Betreiber, das Formular sei zu');
    assert.match(warning, /AUTH_ALLOW_PASSWORD_LOGIN/);
    assert.match(warning, /OIDC_ISSUER/, 'die Meldung muss sagen, was fehlt');
  });
});

test('wo der Schalter greift oder gar nicht gesetzt ist, warnt nichts', () => {
  withOidc({ AUTH_ALLOW_PASSWORD_LOGIN: 'false' }, () => {
    assert.equal(passwordLoginWarning(), null);
  });
  withoutOidc({ AUTH_ALLOW_PASSWORD_LOGIN: undefined }, () => {
    assert.equal(passwordLoginWarning(), null);
  });
});

test('ohne ein verknuepftes SSO-Konto bleibt die Anmeldung offen', () => {
  // Der Fall, den das Review fand (#849): eine frische Installation legt ihren
  // ersten Administrator ueber /setup MIT Passwort an. Griffe der Schalter
  // schon davor, waere dieses Konto im selben Moment tot, /setup danach zu und
  // niemand mehr administrativ drin. Konfiguriertes SSO heisst eben noch nicht,
  // dass jemand hindurchkommt.
  withOidc({ AUTH_ALLOW_PASSWORD_LOGIN: 'false' }, () => {
    assert.equal(isPasswordLoginEnabled({ hasLinkedSsoAccount: false }), true);
    assert.equal(isPasswordLoginEnabled({ hasLinkedSsoAccount: true }), false);
  });
});

test('der Default nimmt eine Verknuepfung an, laesst den Schalter also greifen', () => {
  // Ein vergessener Parameter darf kein stiller Fail-open sein: wer die Frage
  // nicht stellt, bekommt die strengere Antwort.
  withOidc({ AUTH_ALLOW_PASSWORD_LOGIN: 'false' }, () => {
    assert.equal(isPasswordLoginEnabled(), false);
  });
});

// ─── Der Platzhalter ─────────────────────────────────────────────────────────

test('der Platzhalter erkennt genau sich selbst', () => {
  assert.equal(isSsoOnlyAccount(OIDC_PASSWORD_SENTINEL), true);
  assert.equal(isSsoOnlyAccount('$2b$12$echterhash'), false);
  assert.equal(isSsoOnlyAccount(null), false);
  assert.equal(isSsoOnlyAccount(undefined), false);
  assert.equal(isSsoOnlyAccount(''), false);
});

test('der Platzhalter steht an genau einer Stelle', () => {
  // Eine zweite Schreibweise waere ein Konto mit einem Passwort, das niemand
  // gesetzt hat: `verifyPassword` schlaegt gegen den einen fehl und koennte
  // gegen den anderen zufaellig gelingen.
  assert.equal(OIDC_PASSWORD_SENTINEL, '$oidc$');
});

// ─── Passwort-Reset ──────────────────────────────────────────────────────────

function makeDb() {
  const db = new DatabaseSync(':memory:');
  db.exec('PRAGMA foreign_keys = ON;');
  db.exec(`
    CREATE TABLE users (id INTEGER PRIMARY KEY AUTOINCREMENT, username TEXT UNIQUE NOT NULL,
      password_hash TEXT NOT NULL DEFAULT 'x', oidc_sub TEXT, role TEXT NOT NULL DEFAULT 'member');
    CREATE TABLE password_resets (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      token_hash TEXT NOT NULL, expires_at INTEGER NOT NULL,
      created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now'))
    );
    CREATE UNIQUE INDEX idx_password_resets_hash ON password_resets(token_hash);
    CREATE TABLE contacts (id INTEGER PRIMARY KEY AUTOINCREMENT,
      family_user_id INTEGER, email TEXT);
    CREATE TABLE split_expense_guest_users (user_id INTEGER PRIMARY KEY);
  `);
  // alice hat ein echtes Passwort, sso hat nur den Platzhalter - beide mit
  // hinterlegter Adresse, damit der Reset an ihnen nicht schon daran scheitert.
  db.prepare("INSERT INTO users (id, username, password_hash) VALUES (1,'alice','$2b$12$fakehash')").run();
  // MIT `oidc_sub` UND als ADMIN: erst ein verknuepfter Administrator macht den
  // Schalter wirksam. Fehlt eines von beidem, faellt er absichtlich offen, weil
  // sonst niemand mehr an die Verwaltung kaeme - und die Tests darunter pruefen
  // genau seine WIRKUNG.
  db.prepare('INSERT INTO users (id, username, password_hash, oidc_sub, role) VALUES (2,?,?,?,?)')
    .run('sso', OIDC_PASSWORD_SENTINEL, 'sub-linked-847', 'admin');
  db.prepare("INSERT INTO contacts (family_user_id, email) VALUES (1, 'alice@test')").run();
  db.prepare("INSERT INTO contacts (family_user_id, email) VALUES (2, 'sso@test')").run();
  // Ein Gast aus den geteilten Ausgaben: externes Konto mit echtem Passwort,
  // das der Schalter nicht mitnehmen darf.
  db.prepare("INSERT INTO users (id, username, password_hash) VALUES (3,'gast','$2b$12$fakehash')").run();
  db.prepare('INSERT INTO split_expense_guest_users (user_id) VALUES (3)').run();
  db.prepare("INSERT INTO contacts (family_user_id, email) VALUES (3, 'gast@test')").run();
  return db;
}

async function makeAuthApp(db) {
  const { buildResetRoutes } = await import('../server/auth.js');
  const sent = [];
  const app = express();
  app.use(express.json());
  const router = express.Router();
  buildResetRoutes(router, {
    database: db,
    emailService: { isConfigured: () => true, sendMail: async (m) => { sent.push(m); } },
    resetService: createPasswordResetService({ db }),
    baseUrl: 'https://oikos.test',
    limiter: (_req, _res, next) => next(),
  });
  app.use('/auth', router);
  return { app, sent };
}

async function callJson(app, method, path, body) {
  const { createServer } = await import('node:http');
  const server = createServer(app);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const { port } = server.address();
  const res = await fetch(`http://127.0.0.1:${port}${path}`, {
    method, headers: { 'content-type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  const json = await res.json().catch(() => null);
  server.close();
  return { status: res.status, json };
}

test('ein Konto ohne Passwort bekommt keinen Reset-Link', async () => {
  // Das Loch, das es vor #847 gab: der Reset kannte den Platzhalter nicht und
  // haette dem SSO-Konto ein echtes, funktionierendes Passwort gegeben - genau
  // die zweite Tuer, die der Platzhalter zuhalten soll. Ausloesen konnte das
  // jeder, der die E-Mail-Adresse kennt.
  const db = makeDb();
  const { app, sent } = await makeAuthApp(db);
  const { status, json } = await callJson(app, 'POST', '/auth/forgot-password', { identifier: 'sso' });
  assert.equal(status, 200, 'die Antwort bleibt generisch');
  assert.equal(json.data.ok, true);
  assert.equal(sent.length, 0, 'es darf keine Mail rausgehen');
  assert.equal(db.prepare('SELECT COUNT(*) c FROM password_resets').get().c, 0,
    'und erst recht kein Token entstehen');
});

test('das Konto mit Passwort bekommt seinen Reset-Link weiterhin', async () => {
  // Gegenprobe: ohne sie belegt der Test darueber nur, dass irgendetwas kaputt
  // ist.
  const db = makeDb();
  const { app, sent } = await makeAuthApp(db);
  await callJson(app, 'POST', '/auth/forgot-password', { identifier: 'alice' });
  assert.equal(sent.length, 1);
  assert.equal(sent[0].to, 'alice@test');
});

test('auch ueber die E-Mail-Adresse fuehrt kein Weg zum Reset eines SSO-Kontos', async () => {
  // `resolveUser` findet ein Konto auf zwei Wegen; ein Riegel, der nur an einem
  // haengt, ist kein Riegel.
  const db = makeDb();
  const { app, sent } = await makeAuthApp(db);
  await callJson(app, 'POST', '/auth/forgot-password', { identifier: 'sso@test' });
  assert.equal(sent.length, 0);
});

test('mit abgeschalteter Passwort-Anmeldung geht ueberhaupt keine Reset-Mail raus', async () => {
  const db = makeDb();
  const { app, sent } = await makeAuthApp(db);
  await withOidc({ AUTH_ALLOW_PASSWORD_LOGIN: 'false' }, async () => {
    const { status, json } = await callJson(app, 'POST', '/auth/forgot-password', { identifier: 'alice' });
    assert.equal(status, 200, 'die Antwort bleibt generisch - der Zustand ist nicht abfragbar');
    assert.equal(json.data.ok, true);
    assert.equal(sent.length, 0);
  });
});

test('ein bereits ausgestellter Token laeuft ins Leere, wenn das Konto auf SSO wechselt', async () => {
  // Der Token entsteht, WAEHREND das Konto noch ein Passwort hat. Zwischen
  // Ausstellen und Einloesen liegt bis zu einer Stunde - genug Zeit fuer einen
  // Admin, das Konto umzustellen. Diese Entscheidung darf ein alter Token nicht
  // ueberholen.
  const db = makeDb();
  const { app, sent } = await makeAuthApp(db);
  await callJson(app, 'POST', '/auth/forgot-password', { identifier: 'alice' });
  const token = sent[0].html.match(/token=([a-f0-9]+)/)[1];

  db.prepare('UPDATE users SET password_hash = ? WHERE id = 1').run(OIDC_PASSWORD_SENTINEL);

  const { status } = await callJson(app, 'POST', '/auth/reset-password', { token, password: 'brandnewpw' });
  assert.equal(status, 400, 'derselbe Grund wie ein ungueltiger Token, damit der Unterschied nichts verraet');
  assert.equal(db.prepare('SELECT password_hash FROM users WHERE id = 1').get().password_hash,
    OIDC_PASSWORD_SENTINEL, 'der Platzhalter muss stehen bleiben');
  assert.equal(db.prepare('SELECT COUNT(*) c FROM password_resets').get().c, 0,
    'der Token wird verbraucht, nicht liegengelassen');
});

test('ein ausgestellter Token laeuft ins Leere, wenn die Passwort-Anmeldung abgeschaltet wird', async () => {
  const db = makeDb();
  const { app, sent } = await makeAuthApp(db);
  await callJson(app, 'POST', '/auth/forgot-password', { identifier: 'alice' });
  const token = sent[0].html.match(/token=([a-f0-9]+)/)[1];
  const before = db.prepare('SELECT password_hash FROM users WHERE id = 1').get().password_hash;

  await withOidc({ AUTH_ALLOW_PASSWORD_LOGIN: 'false' }, async () => {
    const { status } = await callJson(app, 'POST', '/auth/reset-password', { token, password: 'brandnewpw' });
    assert.equal(status, 400);
  });
  assert.equal(db.prepare('SELECT password_hash FROM users WHERE id = 1').get().password_hash, before,
    'das bestehende Passwort bleibt unangetastet');
});

test('ein Gast aus den geteilten Ausgaben behaelt seinen Reset', async () => {
  // Der Schalter gilt dem HAUSHALT. Ein Split-Gast ist eine externe Person, die
  // ein Admin mit vergebenem Passwort anlegt und die im Identitaetsanbieter des
  // Haushalts nichts zu suchen hat - ein globaler Riegel haette diese Konten
  // stumm unbrauchbar gemacht, samt der bereits bestehenden (Review zu #849).
  const db = makeDb();
  const { app, sent } = await makeAuthApp(db);
  await withOidc({ AUTH_ALLOW_PASSWORD_LOGIN: 'false' }, async () => {
    await callJson(app, 'POST', '/auth/forgot-password', { identifier: 'gast' });
  });
  assert.equal(sent.length, 1, 'der Gast muss seinen Link bekommen');
  assert.equal(sent[0].to, 'gast@test');
});

test('das Haushaltsmitglied bekommt im selben Zustand keinen', async () => {
  // Gegenprobe zum Test darueber - ohne sie belegt er nur, dass irgendetwas
  // durchgeht.
  const db = makeDb();
  const { app, sent } = await makeAuthApp(db);
  await withOidc({ AUTH_ALLOW_PASSWORD_LOGIN: 'false' }, async () => {
    await callJson(app, 'POST', '/auth/forgot-password', { identifier: 'alice' });
  });
  assert.equal(sent.length, 0);
});

test('auch der zweite Fail-open-Zustand meldet sich beim Start', () => {
  // Er ist der ERWARTETE Zustand einer frischen Installation, sieht von aussen
  // aber aus wie der eingeschaltete Riegel. Ohne Hinweis haelt der Betreiber
  // das Formular fuer zu, waehrend es offen steht.
  withOidc({ AUTH_ALLOW_PASSWORD_LOGIN: 'false' }, () => {
    const warning = passwordLoginWarning({ hasLinkedSsoAccount: false });
    assert.ok(warning, 'ohne Warnung ist der Zustand von aussen nicht erkennbar');
    // Der Text muss dieselbe Bedingung nennen wie die Abfrage in auth.js und
    // index.js: ein verknuepftes Mitglied ohne Adminrolle schliesst nichts.
    assert.match(warning, /no administrator account is linked/);
    assert.equal(passwordLoginWarning({ hasLinkedSsoAccount: true }), null,
      'greift der Riegel wirklich, gibt es nichts zu melden');
  });
});

test('erst ein verknuepfter ADMINISTRATOR schliesst den Passwort-Weg', () => {
  // Meldet sich in einem bestehenden Haushalt zuerst ein gewoehnliches Mitglied
  // per SSO an, waere der Riegel sonst sofort zu - und der Admin, dessen Konto
  // mangels eindeutiger verifizierter Adresse nie verknuepft wurde, kaeme nach
  // Ablauf seiner Sitzung nicht mehr an seine eigene Verwaltung (Review zu
  // #849). Der Weg hinein muss fuer den offen bleiben, der ihn wieder
  // aufmachen koennte.
  //
  // Verankert an der FUNKTION, nicht an der Datei: dieselbe Bedingung steht
  // auch in `unlinkOidcAccount`, und die erste Fassung dieses Guards fand sie
  // dort und blieb gruen, waehrend die Regel hier zurueckgedreht war. Zweiter
  // blinder Guard in diesem Zweig - die Gegenprobe fand beide.
  const start = authSrc.indexOf('function isPasswordLoginEnabled(database');
  assert.ok(start > 0, 'die Funktion ist nicht mehr auffindbar');
  const body = authSrc.slice(start, authSrc.indexOf('\n}', start));
  assert.match(body, /oidc_sub IS NOT NULL AND role = 'admin'/,
    'die Bedingung fragt nach irgendeinem verknuepften Konto statt nach einem Admin');
});

test('der letzte SSO-Administrator kann seine Verknuepfung nicht loesen', () => {
  // Sonst kippt ein einzelnes Mitglied an seinem eigenen Konto den Zustand des
  // ganzen Haushalts zurueck: null verknuepfte Admins, fail-open, und
  // Anmeldeformular, Anmelderoute und Reset stehen wieder offen - still, ohne
  // Aenderung an der Umgebung und ohne Neustart.
  const start = authSrc.indexOf('export function unlinkOidcAccount');
  const body = authSrc.slice(start, authSrc.indexOf('\n}', start));
  assert.match(body, /last_sso_admin/);
  assert.match(body, /role = 'admin' AND id != \?/,
    'geprueft werden muss, ob ein ANDERER verknuepfter Admin bleibt');
});

test('der letzte SSO-Administrator faellt auf keinem der drei Wege weg', () => {
  // Verknuepfung loesen, herabstufen, Konto loeschen - alle drei sind
  // gewoehnliche Verwaltung, und jeder einzelne haette den Riegel des ganzen
  // Haushalts nebenbei aufgemacht. Ein Riegel an nur einem davon ist keiner
  // (Review zu #849, Runde 5).
  assert.match(authSrc, /function assertSsoAdminWouldRemain/,
    'die Frage steht nicht an einer Stelle');
  const calls = (authSrc.match(/assertSsoAdminWouldRemain\(/g) || []).length;
  assert.ok(calls >= 3, `die Frage wird nur ${calls - 1}x gestellt, gebraucht werden PATCH und DELETE`);
  // Und der dritte Weg, der seine eigene Antwort gibt:
  const unlink = authSrc.slice(authSrc.indexOf('export function unlinkOidcAccount'));
  assert.match(unlink.slice(0, unlink.indexOf('\n}')), /last_sso_admin/);
});

// ─── Die Regeln an ihren Quellen ─────────────────────────────────────────────
//
// Diese drei pruefen den Code selbst. Die Routen dahinter haengen an Session
// und CSRF und waeren hier nur mit halbem Server zu erreichen - aber genau die
// Stellen sind es, an denen die Regel wieder verschwinden koennte.

import { readFileSync } from 'node:fs';

const authSrc = readFileSync(new URL('../server/auth.js', import.meta.url), 'utf8');

test('die Anmelderoute selbst haelt den Riegel, nicht nur die Anmeldeseite', () => {
  // Eine Regel, die nur die Oberflaeche kennt, ist keine Regel, sondern eine
  // Bitte: `curl` auf /login umgeht sie vollstaendig.
  const login = authSrc.slice(authSrc.indexOf("router.post('/login'"));
  const body = login.slice(0, login.indexOf("router.post('/logout'"));
  assert.match(body, /isPasswordLoginEnabled\(\)/,
    'POST /login prueft den Schalter nicht');
  assert.match(body, /status\(403\)/, 'und weist nicht ab');
});

test('ein Konto ohne Passwort verlangt ausdrueckliche Zustimmung, kein fehlendes Feld', () => {
  // Waere "kein Passwort mitgeschickt" das Signal, ergaebe ein vergessenes Feld
  // still ein Konto ohne Passwort.
  assert.match(authSrc, /function assertSsoOnlyAllowed/);
  assert.match(authSrc, /An account without a password requires OIDC to be configured/,
    'ohne SSO waere so ein Konto tot');
  assert.match(authSrc, /cannot be given a password at the same time/,
    'Passwort und sso_only zugleich muss der Server abweisen statt zu raten');
});

test('der Rueckweg aus SSO-only verlangt ein Passwort', () => {
  // Sonst bliebe der Platzhalter stehen: das Konto haette weder SSO-Pflicht
  // noch einen Zugang, den jemand kennt.
  assert.match(authSrc, /Turning off SSO-only requires setting a password/);
});

test('was Anlegen und Aendern zurueckgeben, traegt sso_only mit', () => {
  // Die Verwaltung uebernimmt die Antwort direkt in ihre Mitgliederliste. Fehlt
  // das Feld, zeigt der Umschalter direkt nach dem Anlegen AUS, obwohl das Konto
  // kein Passwort hat - und die naechste beliebige Aenderung schickt
  // `sso_only: false` mit, das der Server ohne Passwort abweist. Der Fehler
  // erschiene dann an einer Stelle, die mit der Ursache nichts zu tun hat.
  // Gefunden im Review zu PR #849, nicht von den Tests darueber.
  const bodies = {};
  for (const route of ["router.post('/users'", "router.patch('/users/:id'"]) {
    const start = authSrc.indexOf(route);
    assert.ok(start > 0, `${route} nicht gefunden`);
    bodies[route] = authSrc.slice(start, authSrc.indexOf('router.', start + 10));
  }
  for (const [route, body] of Object.entries(bodies)) {
    assert.match(body, /adminUserRow\(/,
      `${route} liest die Antwort nicht ueber adminUserRow - sso_only fehlt darin`);
  }
  assert.match(authSrc, /function adminUserRow[\s\S]{0,400}sso_only/,
    'adminUserRow selektiert das Flag nicht mit');
});

test('kein Weg legt ein Konto an, das seinen Zugang sofort verliert', () => {
  // Drei Wege erzeugten ein Passwort-Konto, waehrend die Passwort-Anmeldung aus
  // ist - alle drei aus dem Review zu #849. Setup und Einladung sind ueber die
  // Fail-open-Regel bzw. den sso_only-Zweig abgedeckt, das Umstellen ueber die
  // Erreichbarkeitspruefung.
  assert.match(authSrc, /const ssoOnly = !isPasswordLoginEnabled\(getDb\(\)\)/,
    'die Einladungsannahme fragt den Schalter nicht');
  // Die Einladungsannahme prueft ueber DIESELBE Funktion wie das Anlegen durch
  // einen Admin - eine eigene, schwaechere Pruefung an dieser Stelle war genau
  // der Befund aus Runde 5: `invite.email` VORHANDEN genuegt nicht, sie muss
  // dieses eine Konto meinen.
  assert.match(authSrc, /assertSsoOnlyAllowed\(true, '', \{ email: invite\.email \}\)/,
    'die Einladungsannahme umgeht die Erreichbarkeitspruefung');
  assert.match(authSrc, /Ask for a new invitation/,
    'die Absage muss sagen, wie es weitergeht - die Einladung bleibt stehen');
  assert.match(authSrc, /password_required: isPasswordLoginEnabled/,
    'die Vorschau sagt der /join-Seite nicht, ob sie nach einem Passwort fragen soll');
});

test('ein Konto ohne Passwort muss erreichbar bleiben', () => {
  // Ohne `oidc_sub` und ohne E-Mail findet die erste SSO-Anmeldung dieses Konto
  // nie: ein gleicher Benutzername verknuepft bewusst NICHT. Mit
  // OIDC_ALLOW_SIGNUP=false wird die Person abgewiesen, mit Signup bekommt sie
  // ein zweites Konto - und dieses bliebe leer und unerreichbar zurueck.
  assert.match(authSrc, /needs an email address, so the first SSO sign-in can link it/);
  assert.match(authSrc, /already belongs to another member/,
    'zwei Konten mit derselben Adresse verknuepft der Server bewusst gar nicht');
});

test('nur ein echter Wechsel schreibt den Platzhalter und meldet ab', () => {
  // Die Verwaltung schickt den Umschalter bei JEDER Speicherung mit. Ohne diese
  // Bedingung meldete das Aendern eines Namens ein laengst SSO-gefuehrtes
  // Mitglied auf allen Geraeten ab.
  assert.match(authSrc, /const alreadySsoOnly = isSsoOnlyAccount\(existingHash\)/);
  assert.match(authSrc, /ssoOnly === true && !alreadySsoOnly/);
});

test('die Sichtbarkeit von sso_only haengt am geltenden Zugang, nicht an der Session', () => {
  // `requireAuth` bedient Session UND API-Token und legt die geltende Rolle in
  // `req.authRole` ab. Ein Admin-Token hat gar keine Session und verloere das
  // Feld; ein Mitglieds-Token neben einem Admin-Cookie bekaeme es zu Unrecht.
  const users = authSrc.slice(authSrc.indexOf("router.get('/users'"));
  const body = users.slice(0, users.indexOf("router.get('/api-tokens'"));
  assert.match(body, /const isAdmin = req\.authRole === 'admin'/);
  assert.doesNotMatch(body, /req\.session\?\.role/,
    'die Session ist hier die falsche Quelle');
});

test('die Doppelpruefung der Adresse folgt exakt dem Linker', () => {
  // Eine engere Pruefung waere schlimmer als keine: sie gaebe gruenes Licht fuer
  // genau die Faelle, an denen der Linker spaeter scheitert - andere
  // Schreibweise, oder dieselbe Adresse als ZWEITadresse eines anderen
  // Mitglieds. Das Konto stuende dann ohne Passwort und ohne Verknuepfung da.
  const start = authSrc.indexOf('function assertSsoOnlyAllowed');
  const body = authSrc.slice(start, authSrc.indexOf('\n}', start));
  assert.match(body, /lower\(c\.email\) = lower\(\?\) OR lower\(ce\.value\) = lower\(\?\)/,
    'die Clash-Pruefung kennt weder lower() noch die Zweitadressen');
  assert.match(body, /LEFT JOIN contact_emails/);
});

test('der Reset wird nicht beworben, wenn es kein Passwort mehr gibt', () => {
  // Sind ALLE Konten per Umschalter auf SSO gestellt, ist der Link eine
  // Sackgasse - auch wenn SMTP und BASE_URL stehen.
  //
  // Geprueft wird die ZUWEISUNG, nicht das Vorkommen: die erste Fassung dieses
  // Guards suchte nur nach `hasResettable` irgendwo in der Datei und blieb
  // gruen, als die Gegenprobe den Term aus der Bedingung nahm - die Definition
  // stand ja noch da. Ein Guard ueber eine Zeile deckt eine Zeile ab, keine
  // Regel.
  const index = readFileSync(new URL('../server/index.js', import.meta.url), 'utf8');
  // Die BERECHNUNG, nicht die Initialisierung: `let passwordResetEnabled = false`
  // steht davor und haette den Guard mit dem Wert `false` zufriedengestellt.
  const start = index.indexOf('passwordResetEnabled = isPasswordLoginEnabled');
  assert.ok(start > 0, 'die Berechnung ist nicht mehr auffindbar');
  const expr = index.slice(start, index.indexOf(';', start));
  assert.match(expr, /hasResettable/,
    'die Reset-Faehigkeit haengt nicht davon ab, ob es ueberhaupt ein Passwort gibt');
  // DIE REGEL, NICHT DIE SCHREIBWEISE. Die erste Fassung verlangte woertlich
  // `password_hash != ?` und wurde damit rot, als die Abfrage VERSCHAERFT wurde:
  // seit #1208 traegt auch ein Wandtablett einen Platzhalter (`$display$`) statt
  // eines Hashes, und beide muessen heraus - ein einziges Display liess den
  // Reset-Link in einem reinen SSO-Haushalt sonst wieder erscheinen.
  // Geprueft wird deshalb, dass die Abfrage den Hash gegen die
  // PLATZHALTER-KONSTANTEN haelt, in welcher Form auch immer.
  const hasResettableQuery = index.slice(index.indexOf('const hasResettable'), start);
  assert.match(hasResettableQuery, /password_hash\s+(?:!=\s*\?|NOT IN\s*\()/,
    '/version prueft nicht, ob ueberhaupt ein Konto ein Passwort hat');
  for (const sentinel of ['OIDC_PASSWORD_SENTINEL', 'DISPLAY_PASSWORD_SENTINEL']) {
    assert.match(hasResettableQuery, new RegExp(sentinel),
      `die Abfrage nimmt ${sentinel} nicht aus - ein Konto mit diesem Platzhalter gilt sonst als zuruecksetzbar`);
  }
});

test('die Anmeldeseite behaelt einen Weg fuer Gastkonten', () => {
  // Der Server laesst Gaeste der geteilten Ausgaben ausdruecklich weiter herein.
  // Eine Oberflaeche ohne Formular haette diesen Zugang trotzdem unbrauchbar
  // gemacht - der eigene Fix ohne seine Folge (Review zu #849).
  const login = readFileSync(new URL('../public/pages/login.js', import.meta.url), 'utf8');
  assert.match(login, /show-password-form/,
    'es gibt keinen Weg, das Formular hervorzuholen');
  assert.match(login, /guestPasswordLogin/);
  // Das Formular wird versteckt, nicht weggelassen: sonst haette der Umschalter
  // nichts einzublenden.
  assert.match(login, /id="auth-form" novalidate \$\{!passwordLoginEnabled \? 'hidden' : ''\}/);
});

test('nur die Absage wegen abgeschalteter Anmeldung zeichnet neu', () => {
  // POST /login antwortet auch fuer Konten der Haushaltshilfe mit 403. Ein
  // pauschales Neuzeichnen verschluckte diese dauerhafte Absage und stellte den
  // Nutzer vor dasselbe Formular, ohne ihm je den Grund zu nennen.
  const login = readFileSync(new URL('../public/pages/login.js', import.meta.url), 'utf8');
  assert.match(login, /err\.status === 403 && \/password login is disabled\/i\.test/);
  assert.match(login, /accountCannotSignIn/,
    'die andere 403-Absage braucht eine eigene Meldung, kein "Verbindungsproblem"');
});

test('der neue Schalter erreicht auch ein Unraid-Deployment', () => {
  const xml = readFileSync(new URL('../templates/yuvomi.xml', import.meta.url), 'utf8');
  assert.match(xml, /Name="AUTH_ALLOW_PASSWORD_LOGIN"/,
    'ohne Eintrag ist die Variable dort aus der Oberflaeche nicht erreichbar');
});

test('die Anmeldeseite fragt beide Wege in EINEM Aufruf ab', () => {
  // Ein zweiter blockierender Aufruf vor dem ersten Paint waere ein zweiter
  // Grund, warum die Anmeldeseite haengt.
  const login = readFileSync(new URL('../public/pages/login.js', import.meta.url), 'utf8');
  assert.match(login, /password_login_enabled/,
    'die Seite liest die Angabe nicht');
  assert.match(login, /!\(ssoEnabled && oidc\?\.password_login_enabled === false\)/,
    'ohne die Kopplung an ssoEnabled kann die Seite ganz ohne Weg hinein enden');
  assert.equal((login.match(/fetch\('\/api\/v1\/auth\/oidc\/config'/g) || []).length, 1);
});

// ─── Der Gast-Weg zeigt sich nur, wo es Gaeste gibt (#962) ───────────────────
//
// Die Ausnahme aus #847 ist richtig und bleibt. Falsch war, sie bedingungslos
// ANZUZEIGEN: ein Haushalt ohne geteilte Ausgaben schaltet
// `AUTH_ALLOW_PASSWORD_LOGIN=false` und sieht weiter einen Passwort-Weg, den
// niemand gehen kann. Der Melder las ihn als Loch im Riegel - zu Recht, denn
// von aussen ist eine unbenutzbare Tuer von einer offenen nicht zu
// unterscheiden.

const { hasSplitExpenseGuests } = await import('../server/auth.js');

test('mit einem Gast in den geteilten Ausgaben lautet die Antwort ja', () => {
  assert.equal(hasSplitExpenseGuests(makeDb()), true);
});

test('ohne einen einzigen Gast lautet sie nein', () => {
  const db = makeDb();
  db.exec('DELETE FROM split_expense_guest_users');
  assert.equal(hasSplitExpenseGuests(db), false);
  // Die Konten selbst bleiben stehen - gefragt ist die GAeSTE-Eigenschaft,
  // nicht die Zahl der Nutzer. Ein Haushalt hat immer welche.
  assert.ok(db.prepare('SELECT COUNT(*) AS n FROM users').get().n > 0);
});

test('ein Schema ohne die Tabelle sperrt niemanden aus, es hat nur keine Gaeste', () => {
  const db = new DatabaseSync(':memory:');
  db.exec('CREATE TABLE users (id INTEGER PRIMARY KEY)');
  assert.equal(hasSplitExpenseGuests(db), false);
});

// Der Endpunkt selbst, nicht sein Quelltext: die Anmeldeseite zeichnet nach
// dieser einen Antwort, also muss sie stimmen und nicht nur so aussehen.
async function configFor(db) {
  const [{ router }, { _setTestDatabase, _resetTestDatabase }] = await Promise.all([
    import('../server/auth.js'),
    import('../server/db.js'),
  ]);
  _setTestDatabase(db);
  try {
    const app = express();
    app.use('/auth', router);
    const { json } = await callJson(app, 'GET', '/auth/oidc/config');
    return json;
  } finally {
    _resetTestDatabase();
  }
}

test('bei gesperrtem Passwort-Login und vorhandenem Gast bietet der Server den Gast-Weg an', async () => {
  const db = makeDb();
  await withOidc({ AUTH_ALLOW_PASSWORD_LOGIN: 'false' }, async () => {
    const cfg = await configFor(db);
    assert.equal(cfg.password_login_enabled, false, 'der Riegel muss greifen, sonst prueft der Test nichts');
    assert.equal(cfg.guest_password_login_enabled, true);
  });
});

test('derselbe Haushalt ohne Gaeste bekommt den Weg NICHT angeboten (#962)', async () => {
  const db = makeDb();
  db.exec('DELETE FROM split_expense_guest_users');
  await withOidc({ AUTH_ALLOW_PASSWORD_LOGIN: 'false' }, async () => {
    const cfg = await configFor(db);
    assert.equal(cfg.password_login_enabled, false);
    assert.equal(cfg.guest_password_login_enabled, false);
  });
});

test('steht der Passwort-Login offen, ist die Gast-Frage gegenstandslos', async () => {
  // Sonst verriete der oeffentliche Endpunkt bei JEDER Installation, ob der
  // Haushalt geteilte Ausgaben mit Externen fuehrt - eine Auskunft, die die
  // Anmeldeseite hier gar nicht braucht: das Formular steht ohnehin offen.
  const db = makeDb();
  await withOidc({ AUTH_ALLOW_PASSWORD_LOGIN: 'true' }, async () => {
    const cfg = await configFor(db);
    assert.equal(cfg.password_login_enabled, true);
    assert.equal(cfg.guest_password_login_enabled, false,
      'obwohl es einen Gast gibt - die Antwort haengt an der Anzeigefrage, nicht am Datenbestand');
  });
});

test('die Anmeldeseite zeigt den Gast-Knopf nur unter dieser Antwort', () => {
  // Der Server kann richtig antworten, waehrend die Seite die Antwort nicht
  // liest - genau so stand es vor #962 da.
  const loginSrc = readFileSync(new URL('../public/pages/login.js', import.meta.url), 'utf8');
  const flag = loginSrc.match(/const guestPasswordLoginEnabled = ([^;]+);/);
  assert.ok(flag, 'login.js leitet das Flag nicht aus der Server-Antwort ab');
  assert.match(flag[1], /guest_password_login_enabled/,
    'das Flag muss aus dem Feld des Servers kommen, nicht aus einer zweiten Herleitung');

  // Der Knopf steht INNERHALB der Bedingung: die blosse Anwesenheit beider
  // Namen in der Datei hiesse gar nichts.
  const block = loginSrc.match(/\$\{guestPasswordLoginEnabled \? `([\s\S]*?)` : ''\}/);
  assert.ok(block, 'der Gast-Knopf haengt an keiner Bedingung');
  assert.match(block[1], /id="show-password-form"/,
    'die Bedingung umschliesst nicht den Gast-Knopf');
});
