/**
 * Modul: Authentifizierung (Auth)
 * Zweck: Login-Route, Session-Middleware, Auth-Guard für geschützte Routen
 * Abhängigkeiten: express, express-session, server/db.js, server/utils/password.js
 */

import express from 'express';
import session from 'express-session';
import rateLimit from 'express-rate-limit';
import crypto from 'node:crypto';
import { readFileSync } from 'node:fs';
import * as db from './db.js';
import { generateToken, csrfMiddleware } from './middleware/csrf.js';
import { collectErrors, date as validateDate, str, MAX_SHORT, MAX_TITLE } from './middleware/validate.js';
import { createLogger } from './logger.js';
import { memberEmail } from './services/member-email.js';
import { deleteBirthdayArtifacts, syncBirthdayArtifacts } from './services/birthdays.js';
import * as oidcClient from 'openid-client';
import {
  isOidcEnabled,
  isOidcSignupAllowed,
  isPasswordLoginEnabled as passwordLoginAllowedByEnv,
  isSsoOnlyAccount,
  OIDC_PASSWORD_SENTINEL,
  getConfig as getOidcConfig,
} from './services/oidc.js';
import { emailService as defaultEmailService } from './services/email.js';
import { passwordResetService as defaultResetService } from './services/password-reset.js';
import { inviteService as defaultInviteService } from './services/invites.js';
import { parseScopes, serializeScopes, normalizeScopes } from './scopes.js';
import { hashPassword, normalizePassword, verifyPassword } from './utils/password.js';
import {
  resolvePermissions, buildSessionModuleAccess, clientPermissions,
  invitePresetPermissions, isValidInvitePreset, writeSubjectPermissions,
  INVITE_PRESET_DEFAULT,
} from './permissions.js';
import { requireAdmin } from './middleware/require-admin.js';
import * as twoFactor from './services/two-factor.js';

const log = createLogger('Auth');
const router = express.Router();

// Die laufende Version, wie sie auch server/index.js und die Changelog-Route
// lesen. Sie steht hier, weil `/changelog-seen` den Merker aus SERVERWISSEN
// setzt statt aus dem Body: welche Version installiert ist, weiss der Server,
// und ein Client koennte es falsch behaupten (#496).
const { version: APP_VERSION } = JSON.parse(
  readFileSync(new URL('../package.json', import.meta.url), 'utf-8')
);
// Präfix für NEUE API-Tokens. Bereits ausgegebene `oikos_`-Tokens bleiben gültig:
// validiert wird über den Hash des gesamten Tokens, nicht über den Präfix.
const API_TOKEN_PREFIX = 'yuvomi_';
const FAMILY_ROLES = ['dad', 'mom', 'parent', 'child', 'grandparent', 'relative', 'other'];
// Platzhalter-Hash für den Timing-Attack-Schutz beim Login unbekannter Benutzer.
const DUMMY_PASSWORD_HASH = '$2b$12$invalidhashfortimingprotection000000000000000000000';
const MAX_AVATAR_DATA_LENGTH = 768 * 1024;
/**
 * WIEVIELE MENSCHEN IM HAUSHALT LEBEN, und warum der Server das sagt.
 *
 * PRODUCT.md fuehrt seit 2026-08-06 Solo-Nutzer als bestaetigte zweite
 * Zielgruppe. Die Oberflaeche wusste davon nichts: das prominenteste Widget
 * zeigte eine grosse 1 mit „im Haushalt", jede Aufgabe trug ein Pflichtfeld
 * „Sichtbarkeit: Alle Familienmitglieder" mit genau einer sinnvollen Belegung,
 * jede Dokumentkarte wiederholte „Ganze Familie" (Critique 2026-08-10).
 *
 * Die Regel dagegen ist eine, keine Liste: WAS NUR EINE SINNVOLLE BELEGUNG HAT,
 * WIRD NICHT GEFRAGT. Damit sie ueberall gleich faellt, braucht der Client eine
 * Zahl, und die gehoert an `/auth/me` - dieselbe Antwort, die er ohnehin bei
 * jedem Start holt, statt eines zweiten Rundwegs pro Modul.
 *
 * SPLIT-GAeSTE ZAEHLEN NICHT MIT. Sie sind externe Beteiligte einer
 * Ausgabenteilung, keine Haushaltsmitglieder - dieselbe Grenze, die
 * `access_scope` schon zieht. Ein Haushalt von einer Person mit drei
 * Reisebekanntschaften ist ein Solo-Haushalt.
 */
const HOUSEHOLD_SIZE_SQL = `
  SELECT COUNT(*) AS n FROM users
  WHERE NOT EXISTS (SELECT 1 FROM split_expense_guest_users sg WHERE sg.user_id = users.id)
`;

function householdSize(database) {
  return database.prepare(HOUSEHOLD_SIZE_SQL).get()?.n ?? 1;
}

/**
 * Die Einfuehrungs-Version, die ein Konto gesehen haben muss, damit der
 * Onboarding-Rundgang nicht erneut erscheint. Ein Konto mit einer kleineren
 * gespeicherten `users.onboarding_version` bekommt ihn wieder vorgesetzt -
 * angehoben werden muss diese Zahl nur dort, wo eine kuenftige Aenderung eine
 * erneute Einfuehrung rechtfertigt (siehe Migration 168 in db.js).
 */
const CURRENT_ONBOARDING_VERSION = 1;

const USER_PUBLIC_COLUMNS = `
  id,
  username,
  display_name,
  avatar_color,
  avatar_data,
  role,
  family_role,
  onboarding_version,
  changelog_seen_version,
  changelog_seen_latest,
  CASE WHEN EXISTS (
    SELECT 1 FROM split_expense_guest_users sg WHERE sg.user_id = users.id
  ) THEN 'split_guest' ELSE 'family' END AS access_scope,
  created_at,
  (SELECT phone FROM contacts WHERE contacts.family_user_id = users.id LIMIT 1) AS phone,
  (SELECT email FROM contacts WHERE contacts.family_user_id = users.id LIMIT 1) AS email,
  (SELECT birth_date FROM birthdays WHERE birthdays.family_user_id = users.id LIMIT 1) AS birth_date
`;

// --------------------------------------------------------
// Session-Store (better-sqlite3, gleiche DB-Instanz wie App)
// Eigene Implementierung - kein connect-sqlite3 (nutzt sqlite3-Bindings,
// die separat kompiliert werden müssten und die Fehlerquelle waren).
// --------------------------------------------------------
class BetterSQLiteStore extends session.Store {
  constructor() {
    super();
    // Tabelle anlegen falls nicht vorhanden
    db.get().exec(`
      CREATE TABLE IF NOT EXISTS sessions (
        sid        TEXT PRIMARY KEY,
        sess       TEXT NOT NULL,
        expired_at INTEGER NOT NULL
      )
    `);
    // Abgelaufene Sessions regelmäßig aufräumen (alle 15 Minuten)
    setInterval(() => {
      db.get().prepare('DELETE FROM sessions WHERE expired_at <= ?').run(Date.now());
    }, 15 * 60_000).unref();
  }

  get(sid, callback) {
    try {
      const row = db.get()
        .prepare('SELECT sess FROM sessions WHERE sid = ? AND expired_at > ?')
        .get(sid, Date.now());
      callback(null, row ? JSON.parse(row.sess) : null);
    } catch (err) {
      callback(err);
    }
  }

  set(sid, sess, callback) {
    try {
      const ttl = sess.cookie?.maxAge ?? 7 * 24 * 60 * 60 * 1000;
      const expiredAt = Date.now() + ttl;
      db.get()
        .prepare('INSERT OR REPLACE INTO sessions (sid, sess, expired_at) VALUES (?, ?, ?)')
        .run(sid, JSON.stringify(sess), expiredAt);
      callback(null);
    } catch (err) {
      callback(err);
    }
  }

  destroy(sid, callback) {
    try {
      db.get().prepare('DELETE FROM sessions WHERE sid = ?').run(sid);
      callback(null);
    } catch (err) {
      callback(err);
    }
  }

  touch(sid, sess, callback) {
    try {
      const ttl = sess.cookie?.maxAge ?? 7 * 24 * 60 * 60 * 1000;
      const expiredAt = Date.now() + ttl;
      db.get()
        .prepare('UPDATE sessions SET expired_at = ? WHERE sid = ?')
        .run(expiredAt, sid);
      callback(null);
    } catch (err) {
      callback(err);
    }
  }
}

const sessionStore = new BetterSQLiteStore();

/**
 * Session-Middleware konfigurieren.
 * Wird in server/index.js eingebunden.
 */
if (!process.env.SESSION_SECRET) {
  throw new Error('[Auth] SESSION_SECRET must be set in .env. Run: node setup.js');
}

/**
 * Ein Platzhalter aus `.env.example` ist kein Geheimnis.
 *
 * `.env.example` liefert `SESSION_SECRET=REPLACE_WITH_A_LONG_RANDOM_STRING`.
 * Wer die Quick-Start-Zeilen am Stueck kopiert und das Bearbeiten von `.env`
 * ueberspringt, signiert seine Session-Cookies gegen eine Konstante, die in
 * diesem Repository steht - also gegen nichts. Wer die Instanz erreicht, kann
 * sich damit ein Admin-Cookie ausstellen; das wiegt schwerer als ein
 * mitgelesener Datenbankschluessel, der nur die Datei im Ruhezustand betrifft.
 *
 * ANDERS ALS BEIM DATENBANKSCHLUESSEL (server/db.js) bricht dieser Guard auch
 * bei einer BESTEHENDEN Installation ab, statt nur zu warnen. Dort waere der
 * Abbruch teurer als der Fehler: ein Schluesselwechsel macht die Datenbank
 * unlesbar, eine laufende Instanz haette also ihre Daten verloren. Hier kostet
 * die Reparatur eine neue Zeile in `.env` und einen erneuten Login - alle
 * Sessions werden ungueltig, sonst nichts. Weiterlaufen zu lassen hiesse, ein
 * offenes Tor offen zu halten, solange niemand die Warnung liest.
 */
if (process.env.SESSION_SECRET.startsWith('REPLACE_WITH_')) {
  throw new Error(
    '[Auth] SESSION_SECRET is still the placeholder from .env.example ' +
    `(${process.env.SESSION_SECRET}). That value is published in this ` +
    'repository, so anyone who can reach this instance could forge a session ' +
    'cookie and sign in as any user. Generate a real one with ' +
    '`openssl rand -base64 48` and put it in .env. Everyone will have to sign ' +
    'in again once - nothing else is lost.'
  );
}

// Session-Cookie-Name. Legacy „Oikos"-Installationen nutzten `oikos.sid`; der
// Name ist nun `yuvomi.sid`. Der Wechsel ist NAHTLOS (kein Zwangs-Logout): der
// signierte Session-Wert ist nur über den Wert (die sid) signiert, nicht über den
// Cookie-Namen — daher kann ein vorhandenes `oikos.sid` transparent als
// `yuvomi.sid` weitergereicht werden (siehe sessionMiddleware unten).
const SESSION_COOKIE = 'yuvomi.sid';
const LEGACY_SESSION_COOKIE = 'oikos.sid';

const expressSession = session({
  store: sessionStore,
  secret: process.env.SESSION_SECRET,
  resave: false,
  saveUninitialized: false,
  name: SESSION_COOKIE,
  cookie: {
    httpOnly: true,
    // secure=false by default; set SESSION_SECURE=true when behind an HTTPS reverse proxy
    secure: process.env.SESSION_SECURE === 'true',
    // lax (not strict): Safari ITP blocks strict cookies on certain navigations
    // (e.g. reverse proxy, direct URL entry), causing 401 on login. Lax is safe
    // because CSRF is protected by the double-submit token and HTTPS secure flag.
    sameSite: 'lax',
    maxAge: 1000 * 60 * 60 * 24 * 7, // 7 Tage in ms
  },
});

/**
 * Session-Middleware mit nahtloser Legacy-Cookie-Migration.
 * Trägt ein vorhandenes `oikos.sid`-Cookie einmalig als `yuvomi.sid` nach, sodass
 * bestehende Anmeldungen über das Rename hinweg gültig bleiben (gleiche signierte
 * sid, gleiches SESSION_SECRET). Das alte Cookie wird dabei verworfen.
 */
function sessionMiddleware(req, res, next) {
  const header = req.headers.cookie;
  if (header && header.includes(`${LEGACY_SESSION_COOKIE}=`) && !header.includes(`${SESSION_COOKIE}=`)) {
    const match = header.match(/(?:^|;\s*)oikos\.sid=([^;]+)/);
    if (match) {
      const legacyValue = match[1];
      // 1. Legacy-Wert zusätzlich unter dem neuen Namen exponieren, damit
      //    express-session die Session in DIESEM Request findet.
      req.headers.cookie = `${header}; ${SESSION_COOKIE}=${legacyValue}`;
      // 2. Den neuen Cookie EXPLIZIT setzen — mit demselben (bereits signierten,
      //    bereits URL-kodierten) Wert und denselben Attributen wie expressSession.
      //    Sonst sendet express-session bei read-only-Requests (/auth/me, /version),
      //    die die Session nicht verändern, KEIN Set-Cookie — und der Browser bliebe
      //    nach dem Verwerfen von oikos.sid komplett ohne Session-Cookie zurück.
      res.cookie(SESSION_COOKIE, legacyValue, {
        httpOnly: true,
        sameSite: 'lax',
        secure: process.env.SESSION_SECURE === 'true',
        maxAge: 1000 * 60 * 60 * 24 * 7,
        path: '/',
        encode: (v) => v, // Wert ist bereits kodiert → kein Doppel-Encoding
      });
      // 3. Erst jetzt das Legacy-Cookie verwerfen (der neue Cookie ist gesetzt).
      res.clearCookie(LEGACY_SESSION_COOKIE, { path: '/' });
    }
  }
  return expressSession(req, res, next);
}

// --------------------------------------------------------
// Rate Limiting für Login
// --------------------------------------------------------
const loginLimiter = rateLimit({
  windowMs: parseInt(process.env.RATE_LIMIT_WINDOW_MS) || 60_000,
  max: parseInt(process.env.RATE_LIMIT_MAX_ATTEMPTS) || 5,
  skipSuccessfulRequests: true,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Zu viele Login-Versuche. Bitte warte kurz.', code: 429 },
});

// Eigener Limiter für Passwort-Reset: zählt ALLE Antworten (kein
// skipSuccessfulRequests). /forgot-password antwortet aus Anti-Enumeration-
// Gründen immer mit 200 — würden erfolgreiche Antworten übersprungen, könnte
// ein bekannter Account unbegrenzt Reset-Mails/Token erzeugen.
const passwordResetLimiter = rateLimit({
  windowMs: parseInt(process.env.RATE_LIMIT_WINDOW_MS) || 60_000,
  max: parseInt(process.env.RATE_LIMIT_MAX_ATTEMPTS) || 5,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Zu viele Anfragen. Bitte warte kurz.', code: 429 },
});

// Eigener Limiter für den zweiten Faktor (#672). Zählt wie der Reset-Limiter
// ALLE Antworten: ein TOTP-Code hat sechs Stellen, also eine Million
// Möglichkeiten, von denen das Toleranzfenster jederzeit drei gültig hält.
// Würden erfolgreiche Versuche übersprungen, könnte ein Angreifer mit einem
// erbeuteten Passwort beliebig oft raten - der Login selbst war ja korrekt.
const twoFactorLimiter = rateLimit({
  windowMs: parseInt(process.env.RATE_LIMIT_WINDOW_MS) || 60_000,
  max: parseInt(process.env.RATE_LIMIT_MAX_ATTEMPTS) || 5,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Zu viele Versuche. Bitte warte kurz.', code: 429 },
});

// Wie lange ein bestandenes Passwort auf den zweiten Faktor warten darf.
const TWO_FACTOR_WINDOW_MS = 5 * 60 * 1000;

function hashApiToken(token) {
  return crypto.createHash('sha256').update(token, 'utf8').digest('hex');
}

function extractApiToken(req) {
  const auth = req.headers.authorization || '';
  if (auth.toLowerCase().startsWith('bearer ')) return auth.slice(7).trim();
  return String(req.headers['x-api-key'] || req.headers['api-key'] || '').trim();
}

function publicApiToken(row) {
  return {
    id: row.id,
    name: row.name,
    token_prefix: row.token_prefix,
    created_by: row.created_by,
    creator_name: row.creator_name,
    subject_user_id: row.effective_subject_user_id ?? row.subject_user_id ?? row.created_by,
    subject_name: row.subject_name ?? row.creator_name,
    scopes: parseScopes(row.scopes),
    expires_at: row.expires_at,
    revoked_at: row.revoked_at,
    last_used_at: row.last_used_at,
    created_at: row.created_at,
  };
}

/**
 * Liest die Scopes eines mitgeschickten API-Tokens, OHNE `last_used_at` zu
 * beruehren - reiner Lesepfad fuer das Auth-Router-Gate unten (die volle
 * Authentifizierung inkl. Update macht spaeter `requireAuth` pro Route).
 * Rueckgabe:
 *   - `undefined` = kein/kein gueltiges Token (Session- oder oeffentliche Route)
 *   - `null`      = gueltiges, aber UNGESCOPTES Token (Legacy, voller Zugriff)
 *   - `string[]`  = die gewaehrten Scopes eines gescopten Tokens
 * @param {import('express').Request} req
 * @returns {string[]|null|undefined}
 */
function requestTokenScopes(req) {
  const token = extractApiToken(req);
  if (!token) return undefined;
  const row = db.get().prepare(`
    SELECT scopes FROM api_tokens
    WHERE token_hash = ?
      AND revoked_at IS NULL
      AND (expires_at IS NULL OR expires_at > strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
  `).get(hashApiToken(token));
  if (!row) return undefined;
  return parseScopes(row.scopes);
}

// Sicherheits-Gate (GHSA-xcv5-6w6x-x5q2): Der Auth-Router ist in server/index.js
// bewusst VOR den globalen Scope-/Guest-/Modul-Gates gemountet, damit oeffentliche
// Routen (login, setup, oidc, 2fa/verify) ohne Authentifizierung erreichbar sind.
// Genau dadurch umging ein gescoptes API-Token hier aber die Scope-Durchsetzung:
// `/auth` ist kein scopebares Modul (moduleForPath === null), also wuerde das
// globale Gate JEDES gescopte Token verwerfen - dieser Router bekam es aber nie zu
// sehen. Ein auf ein einzelnes Lese-Modul beschraenktes Token konnte so ein
// unbeschraenktes Token oder einen Admin anlegen. Die Sperre zieht dieselbe Grenze
// schon am Router-Eingang: gescopte Tokens erreichen keine Auth-Route. Ungescopte
// (Legacy-)Tokens und Session-Auth bleiben unberuehrt. Muss VOR allen Routen
// dieses Routers registriert sein.
router.use((req, res, next) => {
  const scopes = requestTokenScopes(req);
  if (scopes != null) {
    return res.status(403).json({ error: 'Token scope does not permit this operation.', code: 403 });
  }
  next();
});

function publicUser(row) {
  return {
    id: row.id,
    username: row.username,
    display_name: row.display_name,
    avatar_color: row.avatar_color,
    avatar_data: row.avatar_data ?? null,
    role: row.role,
    family_role: row.family_role,
    access_scope: row.access_scope ?? 'family',
    phone: row.phone ?? null,
    email: row.email ?? null,
    birth_date: row.birth_date ?? null,
    created_at: row.created_at,
    // Ob DIESES Konto den Onboarding-Rundgang noch braucht - jede Abfrage
    // ueber USER_PUBLIC_COLUMNS traegt die Spalte, daher hier unbedingt statt
    // ueber die `!== undefined`-Bedingung der beiden Felder darunter.
    onboarding_pending: row.onboarding_version < CURRENT_ONBOARDING_VERSION,
    // Die beiden Changelog-Merker (#496). Wie `onboarding_pending` unbedingt:
    // sie haengen an USER_PUBLIC_COLUMNS, also traegt jede Abfrage sie mit.
    // `null` heisst "noch nie hingesehen" und ist ein anderer Zustand als
    // "alles gesehen" - der Client blendet die Liste dann bewusst aus.
    changelog_seen: {
      version: row.changelog_seen_version ?? null,
      latest: row.changelog_seen_latest ?? null,
    },
    // Nur wenn die Query das Flag mitselektiert (GET /users); andere
    // publicUser-Pfade behalten ihre bisherige Feldmenge.
    ...(row.is_worker !== undefined && { is_worker: Boolean(row.is_worker) }),
    // Ebenso bedingt, und zusaetzlich nur fuer Administratoren (#847): "dieses
    // Konto hat ein Passwort" ist dieselbe Sorte Angabe wie die
    // 2FA-Uebersicht, die aus demselben Grund nicht an /auth/users haengt.
    ...(row.sso_only !== undefined && { sso_only: Boolean(row.sso_only) }),
  };
}

function validateMemberProfileFields(body) {
  const vPhone = body.phone !== undefined
    ? str(body.phone, 'Phone number', { max: MAX_SHORT, required: false })
    : { value: undefined, error: null };
  const vEmail = body.email !== undefined
    ? str(body.email, 'Email', { max: MAX_TITLE, required: false })
    : { value: undefined, error: null };
  const vBirthDate = body.birth_date !== undefined
    ? validateDate(body.birth_date, 'Birthday date')
    : { value: undefined, error: null };
  return {
    values: {
      phone: vPhone.value,
      email: vEmail.value,
      birth_date: vBirthDate.value,
    },
    errors: collectErrors([vPhone, vEmail, vBirthDate]),
  };
}

function syncFamilyMemberArtifacts(database, userId, {
  displayName,
  phone = undefined,
  email = undefined,
  birthDate = undefined,
  avatarData = undefined,
  actorUserId,
} = {}) {
  const user = database.prepare('SELECT id, display_name, avatar_data FROM users WHERE id = ?').get(userId);
  if (!user) return;
  const name = displayName || user.display_name;
  const photo = avatarData !== undefined ? avatarData : user.avatar_data;

  const contact = database.prepare('SELECT * FROM contacts WHERE family_user_id = ?').get(userId);
  if (contact) {
    database.prepare(`
      UPDATE contacts
      SET name = ?,
          category = COALESCE(category, 'Sonstiges'),
          phone = ?,
          email = ?
      WHERE id = ?
    `).run(
      name,
      phone !== undefined ? phone : contact.phone,
      email !== undefined ? email : contact.email,
      contact.id,
    );

    // Der gespiegelte Anzeigename hat keine strukturierte Quelle (#535). Ändert
    // er sich, sind zuvor im Kontakt gepflegte Namensteile veraltet - sonst
    // sortierte die Liste weiter nach dem alten Nachnamen und der Dialog
    // belegte damit vor. NULL heißt: Sortierung fällt auf `name` zurück.
    if (contact.name !== name) {
      database.prepare(`
        UPDATE contacts
        SET first_name = NULL, last_name = NULL, middle_name = NULL,
            name_prefix = NULL, name_suffix = NULL
        WHERE id = ?
      `).run(contact.id);
    }
  } else {
    database.prepare(`
      INSERT INTO contacts (name, category, phone, email, family_user_id)
      VALUES (?, 'Sonstiges', ?, ?, ?)
    `).run(name, phone ?? null, email ?? null, userId);
  }

  const birthday = database.prepare('SELECT * FROM birthdays WHERE family_user_id = ?').get(userId);
  if (birthDate === null) {
    if (birthday) {
      deleteBirthdayArtifacts(database, birthday);
      database.prepare('DELETE FROM birthdays WHERE id = ?').run(birthday.id);
    }
    return;
  }

  if (birthday) {
    database.prepare(`
      UPDATE birthdays
      SET name = ?,
          birth_date = COALESCE(?, birth_date),
          photo_data = ?,
          updated_at = strftime('%Y-%m-%dT%H:%M:%SZ', 'now')
      WHERE id = ?
    `).run(name, birthDate ?? null, photo ?? null, birthday.id);
    const updated = database.prepare('SELECT * FROM birthdays WHERE id = ?').get(birthday.id);
    syncBirthdayArtifacts(database, updated);
    return;
  }

  if (birthDate) {
    const result = database.prepare(`
      INSERT INTO birthdays (name, birth_date, photo_data, created_by, family_user_id)
      VALUES (?, ?, ?, ?, ?)
    `).run(name, birthDate, photo ?? null, actorUserId || userId, userId);
    const created = database.prepare('SELECT * FROM birthdays WHERE id = ?').get(result.lastInsertRowid);
    syncBirthdayArtifacts(database, created);
  }
}

function normalizeAvatarData(value) {
  if (value === undefined) return undefined;
  if (value === null || value === '') return null;
  if (typeof value !== 'string') return { error: 'Avatar image must be a data URL string.' };
  if (value.length > MAX_AVATAR_DATA_LENGTH) {
    return { error: 'Avatar image is too large.' };
  }
  if (!/^data:image\/(?:png|jpeg|webp);base64,[a-z0-9+/=]+$/i.test(value)) {
    return { error: 'Avatar image must be PNG, JPEG, or WebP.' };
  }
  return value;
}

function assertAdminWouldRemain(targetUserId, nextRole) {
  if (nextRole === 'admin') return null;
  const current = db.get().prepare('SELECT role FROM users WHERE id = ?').get(targetUserId);
  if (!current || current.role !== 'admin') return null;
  const row = db.get().prepare('SELECT COUNT(*) AS count FROM users WHERE role = ? AND id != ?').get('admin', targetUserId);
  return row.count > 0 ? null : 'At least one system admin must remain.';
}

/**
 * Bleibt nach dieser Aenderung ein per SSO verknuepfter Administrator uebrig? (#847)
 *
 * Der Zustand "SSO ist der einzige Weg hinein" haengt genau daran. Faellt der
 * letzte solche Administrator weg, sieht die Regel null Treffer, faellt
 * fail-open und macht Anmeldeformular, Anmelderoute und Passwort-Reset des
 * ganzen Haushalts wieder auf - still, ohne Aenderung an der Umgebung und ohne
 * Neustart.
 *
 * Wegfallen kann er auf DREI Wegen, und alle drei sind gewoehnliche Verwaltung:
 * Verknuepfung loesen, zum Mitglied herabstufen, Konto loeschen. Ein Riegel an
 * nur einem davon ist kein Riegel - deshalb steht die Frage hier einmal und
 * wird dreimal gestellt.
 *
 * @param {number} targetUserId  das betroffene Konto
 * @param {string|null} nextRole  die Rolle danach; `null` = Konto verschwindet
 * @returns {string|null} Fehlermeldung oder null
 */
function assertSsoAdminWouldRemain(targetUserId, nextRole) {
  // Nur wenn der Schalter ueberhaupt gesetzt ist - sonst gibt es nichts zu
  // bewahren, und jede Verwaltungsaktion kostete eine Abfrage.
  if (passwordLoginAllowedByEnv() || !isOidcEnabled()) return null;
  if (nextRole === 'admin') return null;

  const current = db.get()
    .prepare('SELECT role, oidc_sub FROM users WHERE id = ?').get(targetUserId);
  if (!current || current.role !== 'admin' || !current.oidc_sub) return null;

  const other = db.get().prepare(`
    SELECT 1 FROM users
    WHERE oidc_sub IS NOT NULL AND role = 'admin' AND id != ?
    LIMIT 1
  `).get(targetUserId);
  if (other) return null;

  return 'This is the last administrator linked to SSO. Removing that link would switch password '
    + 'login back on for the whole household. Link another administrator first.';
}

function updateUserRoleSessions(userId, role) {
  const allSessions = db.get().prepare('SELECT sid, sess FROM sessions').all();
  const updateSession = db.get().prepare('UPDATE sessions SET sess = ? WHERE sid = ?');
  for (const row of allSessions) {
    try {
      const sess = JSON.parse(row.sess);
      if (sess.userId === userId) {
        sess.role = role;
        updateSession.run(JSON.stringify(sess), row.sid);
      }
    } catch { /* ignore malformed session */ }
  }
}

function invalidateUserSessions(userId, exceptSid) {
  const allSessions = db.get().prepare('SELECT sid, sess FROM sessions').all();
  for (const row of allSessions) {
    if (row.sid === exceptSid) continue;
    try {
      const sess = JSON.parse(row.sess);
      if (sess.userId === userId) {
        db.get().prepare('DELETE FROM sessions WHERE sid = ?').run(row.sid);
      }
    } catch { /* ignore malformed session */ }
  }
}

function authenticateApiToken(req) {
  const token = extractApiToken(req);
  if (!token) return null;

  const tokenHash = hashApiToken(token);
  const row = db.get().prepare(`
    SELECT t.*,
      subject.id AS effective_subject_user_id,
      subject.role, subject.username, subject.display_name, subject.avatar_color,
      subject.avatar_data, subject.family_role,
      creator.display_name AS creator_name,
      subject.display_name AS subject_name
    FROM api_tokens t
    JOIN users subject ON subject.id = COALESCE(t.subject_user_id, t.created_by)
    JOIN users creator ON creator.id = t.created_by
    WHERE t.token_hash = ?
      AND t.revoked_at IS NULL
      AND (t.expires_at IS NULL OR t.expires_at > strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
  `).get(tokenHash);
  if (!row) return null;

  db.get().prepare(`
    UPDATE api_tokens SET last_used_at = strftime('%Y-%m-%dT%H:%M:%SZ', 'now') WHERE id = ?
  `).run(row.id);

  req.apiToken = publicApiToken(row);
  req.user = {
    id: row.effective_subject_user_id,
    username: row.username,
    display_name: row.display_name,
    avatar_color: row.avatar_color,
    avatar_data: row.avatar_data,
    role: row.role,
    family_role: row.family_role,
  };
  return row;
}

// --------------------------------------------------------
// Auth-Guard Middleware
// --------------------------------------------------------

function applyRoleModuleAccess(req) {
  // Rollen-/Mitglied-basierte Modulrechte (#467) gelten unabhängig davon, ob
  // das Subjekt interaktiv oder über ein Integrationstoken authentifiziert ist.
  // Admins: null = Vollzugriff. Token-Scopes bleiben eine zusätzliche
  // Least-Privilege-Grenze und können diese Rechte niemals erweitern.
  req.sessionModuleAccess = null;
  if (req.authRole === 'admin') return;
  try {
    const user = db.get()
      .prepare('SELECT id, role, family_role FROM users WHERE id = ?')
      .get(req.authUserId);
    if (user) {
      req.sessionModuleAccess = buildSessionModuleAccess(resolvePermissions(db.get(), user));
    }
  } catch (err) {
    log.error('Permission resolution failed:', err.message);
  }
}

/**
 * Prüft ob der Request authentifiziert ist.
 * Schützt alle API-Routen außer /auth/login.
 */
function requireAuth(req, res, next) {
  const apiToken = authenticateApiToken(req);
  if (apiToken) {
    req.authMethod = 'api_token';
    req.authUserId = apiToken.effective_subject_user_id ?? apiToken.subject_user_id ?? apiToken.created_by;
    req.authRole = apiToken.role;
    // null = kein Scoping (voller rollenbasierter Zugriff, Legacy-Token).
    req.authScopes = parseScopes(apiToken.scopes);
    applyRoleModuleAccess(req);
    return next();
  }

  if (req.session && req.session.userId) {
    req.authMethod = 'session';
    req.authUserId = req.session.userId;
    req.authRole = req.session.role;
    // Interaktive Sessions kennen kein Token-Scoping.
    req.authScopes = null;
    applyRoleModuleAccess(req);
    return next();
  }
  res.status(401).json({ error: 'Not authenticated.', code: 401 });
}

/**
 * Prüft ob der authentifizierte User Admin-Rolle hat.
 */

/**
 * Richtet eine neue Session nach erfolgter Authentifizierung ein.
 * Wird von POST /login und GET /oidc/callback geteilt.
 * @param {import('express').Request} req
 * @param {import('express').Response} res
 * @param {{ id: number, role: string }} user
 * @returns {Promise<void>}
 */
function setupAuthSession(req, res, user) {
  return new Promise((resolve, reject) => {
    req.session.regenerate((err) => {
      if (err) return reject(err);
      req.session.userId    = user.id;
      req.session.role      = user.role;
      req.session.csrfToken = generateToken();
      res.cookie('csrf-token', req.session.csrfToken, {
        httpOnly: false,
        sameSite: 'lax',
        secure: process.env.SESSION_SECURE === 'true',
        maxAge: 1000 * 60 * 60 * 24 * 7,
      });
      resolve();
    });
  });
}

/**
 * Die Antwort auf eine geglueckte Anmeldung. Steht einmal, weil sie an zwei
 * Stellen faellig wird: beim Login ohne zweiten Faktor und nach dessen
 * Pruefung. Zwei Kopien waeren zwei Gelegenheiten, ein Feld zu vergessen.
 *
 * @param {import('express').Request} req
 * @param {object} user Zeile aus `users`
 * @returns {object}
 */
function loginPayload(req, user) {
  return {
    user: {
      id:           user.id,
      username:     user.username,
      display_name: user.display_name,
      avatar_color: user.avatar_color,
      avatar_data:  user.avatar_data,
      role:         user.role,
      family_role:  user.family_role,
      access_scope: db.get().prepare('SELECT 1 FROM split_expense_guest_users WHERE user_id = ?').get(user.id) ? 'split_guest' : 'family',
      // Auch hier, aus demselben Grund wie householdSize unten: der Router
      // fragt nach dem Login nicht extra /me, bevor die Uebersicht rendert.
      onboarding_pending: user.onboarding_version < CURRENT_ONBOARDING_VERSION,
      // Und aus demselben Grund die Changelog-Merker (#496): ohne sie kaeme
      // der Router mit einem Konto ohne Merker in die Uebersicht, haelte den
      // ersten Blick fuer den allerersten und liesse die "Neu bei dir"-Liste
      // beim Anmelden weg. Genau das ist beim Bauen passiert, obwohl der
      // Kommentar darueber davor warnt.
      changelog_seen: {
        version: user.changelog_seen_version ?? null,
        latest: user.changelog_seen_latest ?? null,
      },
    },
    permissions: clientPermissions(db.get(), user),
    // Auch hier, nicht nur an /me: nach dem Login navigiert der Router
    // direkt weiter, ohne /me noch einmal zu fragen. Ohne diese Zeile
    // stuende ein Solo-Haushalt bis zum naechsten Kaltstart wieder voller
    // Familienfelder.
    householdSize: householdSize(db.get()),
    csrfToken: req.session.csrfToken,
  };
}

// --------------------------------------------------------
/**
 * Bringt einen Claim-Wert auf das app-weite Username-Format
 * `[a-zA-Z0-9._-]{3,64}` (siehe die Prüfungen in /setup, /invites und den
 * User-Routen). Fremde Zeichen (`@` aus Synology-`sub`s, Leerzeichen, Umlaute)
 * werden zu Bindestrichen, Diakritika vorher transliteriert. Ergibt der Wert
 * weniger als drei verwertbare Zeichen, liefert die Funktion `null`, damit der
 * nächste Kandidat greift.
 *
 * @param {unknown} raw
 * @returns {string|null}
 */
function sanitizeOidcUsername(raw) {
  if (typeof raw !== 'string') return null;
  const cleaned = raw
    .normalize('NFKD')
    .replace(/\p{Diacritic}/gu, '')
    .replace(/[^a-zA-Z0-9._-]+/g, '-')
    .replace(/-{2,}/g, '-')
    .slice(0, 64)
    .replace(/^[.-]+|[.-]+$/g, '');
  return cleaned.length >= 3 ? cleaned : null;
}

/**
 * Findet oder erstellt einen User anhand der (validierten) OIDC-Claims.
 *
 * Identität primär über den (kryptografisch validierten) `sub`. Existiert kein
 * sub-Match, wird ein bestehender lokaler Account NUR verknüpft, wenn der IdP
 * `email_verified: true` liefert UND genau ein noch nicht OIDC-gebundener Account
 * dieselbe E-Mail führt. Ohne verifizierte E-Mail (oder bei Mehrdeutigkeit) wird
 * ein separater Account angelegt — Linking auf unverifizierte E-Mails wäre ein
 * Account-Takeover-Vektor.
 *
 * Ausnahme: `OIDC_TRUST_EMAIL_WITHOUT_VERIFIED_CLAIM=true` — Opt-in für IdPs, die
 * den Claim zwar weglassen, aber nur verifizierte Adressen ausgeben (z. B. ältere
 * Authentik-Deployments). Nur setzen, wenn der IdP vollständig unter eigener
 * Kontrolle steht und keine unverifizierten E-Mails zulässt.
 *
 * Mit `OIDC_ALLOW_SIGNUP=false` entfällt ausschließlich der letzte Schritt, das
 * Anlegen (#654); die Rückgabe ist dann `null`. Erkennen und Verknüpfen laufen
 * unverändert, sonst käme auch niemand mehr hinein, den der Admin von Hand
 * angelegt hat.
 *
 * @param {import('better-sqlite3-multiple-ciphers').Database} database
 * @param {{ sub: string, iss?: string, email?: string, email_verified?: boolean, name?: string, preferred_username?: string, username?: string }} claims
 * @returns {{ id: number, role: string, [key: string]: any }|null} `null`, wenn
 *   das Konto neu wäre und die automatische Kontoerstellung abgeschaltet ist.
 */
export function findOrCreateOidcUser(database, claims) {
  const { sub, iss, email, email_verified, name, preferred_username, username: usernameClaim } = claims;

  // Der Issuer aus dem validierten ID-Token kennt sich selbst am besten; OIDC_ISSUER
  // ist nur der konfigurierte Einstiegspunkt und kann davon abweichen (CNAME o. Ä.).
  const provider = iss || process.env.OIDC_ISSUER || null;

  // 1. Bestehenden OIDC-Nutzer über den eindeutigen sub finden
  const existing = database.prepare('SELECT * FROM users WHERE oidc_sub = ?').get(sub);
  if (existing) return existing;

  // 2. Linking an bestehenden lokalen Account — ausschließlich bei verifizierter
  //    E-Mail oder explizitem Opt-in via OIDC_TRUST_EMAIL_WITHOUT_VERIFIED_CLAIM.
  //    Family-User-E-Mails hängen an contacts.email (Primär) bzw.
  //    contact_emails.value (Sekundär). Verknüpft wird nur, wenn GENAU EIN noch
  //    nicht OIDC-gebundener Account die E-Mail führt; 0 oder >1 Treffer →
  //    sicherheitshalber neuer Account.
  const trustMissingVerified = process.env.OIDC_TRUST_EMAIL_WITHOUT_VERIFIED_CLAIM === 'true';
  if (email && (email_verified === true || (trustMissingVerified && email_verified !== false))) {
    const matches = database.prepare(`
      SELECT DISTINCT u.id
      FROM users u
      JOIN contacts c ON c.family_user_id = u.id
      LEFT JOIN contact_emails ce ON ce.contact_id = c.id
      WHERE u.oidc_sub IS NULL
        AND (lower(c.email) = lower(?) OR lower(ce.value) = lower(?))
    `).all(email, email);

    if (matches.length === 1) {
      database.prepare(
        'UPDATE users SET oidc_sub = ?, oidc_provider = ? WHERE id = ?',
      ).run(sub, provider, matches[0].id);
      return database.prepare('SELECT * FROM users WHERE id = ?').get(matches[0].id);
    }
  }

  // 3. Ab hier waere das Konto NEU - und genau hier endet der Weg, wenn die
  //    automatische Kontoerstellung abgeschaltet ist (#654). Das Gate steht
  //    bewusst hinter der Verknuepfung und nicht vor Schritt 1: ein bereits
  //    verknuepftes oder von Hand angelegtes Konto ist eine Entscheidung, die
  //    jemand getroffen hat, und die soll der Schalter nicht zuruecknehmen.
  if (!isOidcSignupAllowed()) return null;

  // 4. Eindeutigen username ableiten (Kollision mit bestehenden Usernamen vermeiden).
  //    Reihenfolge: preferred_username (Standard-Claim) → username (non-standard,
  //    u. a. Synology DSM SSO) → sub. Die E-Mail ist bewusst KEIN Kandidat (#653):
  //    sie ist bei geteilten Familien-Adressen nicht eindeutig, vermischt Kontaktdaten
  //    mit dem Identifikator und trägt den Domain-Teil unnötig in den Namen.
  const base = sanitizeOidcUsername(preferred_username)
    ?? sanitizeOidcUsername(usernameClaim)
    ?? sanitizeOidcUsername(sub)
    ?? 'oidc-user';
  let username = base;
  for (let n = 1; database.prepare('SELECT 1 FROM users WHERE username = ?').get(username); n++) {
    const suffix = `-${n}`;
    username = base.slice(0, 64 - suffix.length) + suffix;
  }

  const display_name = (name || preferred_username || usernameClaim || email || username).slice(0, 128);
  const avatar_color = avatarColors[Math.floor(Math.random() * avatarColors.length)];

  // oidc_provider = Issuer-URL (zukunftssicher für mehrere Provider)
  const result = database.prepare(`
    INSERT INTO users (username, display_name, password_hash, avatar_color, role, oidc_sub, oidc_provider)
    VALUES (?, ?, ?, ?, 'member', ?, ?)
  `).run(username, display_name, OIDC_PASSWORD_SENTINEL, avatar_color, sub, provider);

  return database.prepare('SELECT * FROM users WHERE id = ?').get(result.lastInsertRowid);
}

/**
 * Verknüpft ein OIDC-Konto mit einem bereits angemeldeten lokalen Konto (#832).
 *
 * Die automatische Zuordnung greift nur über den `sub` oder eine verifizierte
 * E-Mail; gleiche Benutzernamen zählen bewusst nicht, sonst nähme sich jeder,
 * der sich im IdP `admin` nennt, das lokale Admin-Konto. Wer beide Konten
 * wirklich besitzt, hatte damit aber gar keinen Weg: er bekam bei der ersten
 * SSO-Anmeldung ein zweites Konto (`test1-1`), seine Daten blieben im ersten.
 *
 * Diesen Weg geht der Nutzer deshalb selbst und angemeldet: die Session belegt
 * das lokale Konto, der validierte `sub` das entfernte. Beides zusammen ist der
 * Besitznachweis, den ein gleicher Benutzername nie erbracht hat.
 *
 * @returns {{ ok: true } | { ok: false, reason: 'user_gone'|'already_linked'|'sub_taken' }}
 */
export function linkOidcAccount(database, userId, { sub, iss }) {
  const user = database.prepare('SELECT id, oidc_sub FROM users WHERE id = ?').get(userId);
  if (!user) return { ok: false, reason: 'user_gone' };

  // Schon verknüpft: denselben sub erneut zu binden ist folgenlos, ein anderer
  // wäre ein stiller Wechsel des Zugangs - der gehört über das Lösen.
  if (user.oidc_sub) {
    return user.oidc_sub === sub ? { ok: true } : { ok: false, reason: 'already_linked' };
  }

  // Der sub ist der Identitätsanker: hinge er an zwei Konten, entschiede die
  // Zeilenreihenfolge, wer sich damit anmeldet.
  const taken = database.prepare('SELECT id FROM users WHERE oidc_sub = ?').get(sub);
  if (taken) return { ok: false, reason: 'sub_taken' };

  database.prepare('UPDATE users SET oidc_sub = ?, oidc_provider = ? WHERE id = ?')
    .run(sub, iss || process.env.OIDC_ISSUER || null, userId);
  return { ok: true };
}

/**
 * Löst eine Verknüpfung wieder.
 *
 * Verweigert wird das nur in dem einen Fall, in dem es den Zugang kostet: ein
 * per SSO angelegtes Konto trägt kein Passwort, sondern den Platzhalter - ohne
 * OIDC käme dort niemand mehr hinein. Erst ein gesetztes Passwort macht das
 * Lösen gefahrlos.
 *
 * @returns {{ ok: true } | { ok: false, reason: 'user_gone'|'not_linked'|'no_password'|'last_sso_admin' }}
 */
export function unlinkOidcAccount(database, userId) {
  const user = database
    .prepare('SELECT id, oidc_sub, password_hash FROM users WHERE id = ?').get(userId);
  if (!user) return { ok: false, reason: 'user_gone' };
  if (!user.oidc_sub) return { ok: false, reason: 'not_linked' };
  if (isSsoOnlyAccount(user.password_hash)) return { ok: false, reason: 'no_password' };

  // Mit SSO als einzigem Weg hinein haengt der Zustand des ganzen Haushalts an
  // den verknuepften Administratoren (#847): faellt der letzte weg, sieht die
  // Regel null verknuepfte Admins, faellt fail-open und macht Anmeldeformular,
  // Anmelderoute und Passwort-Reset wieder auf. Das darf kein einzelnes
  // Mitglied an seinem eigenen Konto ausloesen - und es geschaehe still, ohne
  // Aenderung an der Umgebung und ohne Neustart.
  //
  // Der eigene Zugang ist dabei NICHT das Argument: dieses Konto traegt ein
  // Passwort (die Zeile darueber), es sperrt sich also nicht selbst aus. Es
  // ginge um die Einstellung des Betreibers.
  if (!passwordLoginAllowedByEnv() && isOidcEnabled()) {
    const self = database.prepare('SELECT role FROM users WHERE id = ?').get(userId);
    if (self?.role === 'admin') {
      const otherAdmin = database.prepare(`
        SELECT 1 FROM users
        WHERE oidc_sub IS NOT NULL AND role = 'admin' AND id != ?
        LIMIT 1
      `).get(userId);
      if (!otherAdmin) return { ok: false, reason: 'last_sso_admin' };
    }
  }

  database.prepare('UPDATE users SET oidc_sub = NULL, oidc_provider = NULL WHERE id = ?').run(userId);
  return { ok: true };
}

// --------------------------------------------------------
// Routen
// --------------------------------------------------------

const avatarColors = ['#007AFF', '#34C759', '#FF9500', '#FF3B30', '#AF52DE', '#FF2D55'];

/**
 * Darf man sich hier mit Passwort anmelden? (#847)
 *
 * Legt die Datenbank-Bedingung unter den Env-Schalter: solange KEIN Konto mit
 * dem Anbieter verknuepft ist, bleibt die eingebaute Anmeldung offen, weil es
 * sonst gar keinen Weg hinein gaebe. Betrifft vor allem die frische
 * Installation, deren erster Administrator ueber `/setup` mit einem Passwort
 * entsteht - und jede Einladung, die vor dem ersten SSO-Login eingeloest wird.
 *
 * Die Abfrage ist billig: `idx_users_oidc_sub` deckt sie, und ein `EXISTS`
 * haelt bei der ersten Zeile an.
 *
 * @param {object} [database]  fuer Tests; sonst die laufende Instanz
 * @returns {boolean}
 */
export function isPasswordLoginEnabled(database = null) {
  // Nur fragen, wenn der Schalter ueberhaupt greifen koennte - sonst kostet
  // jeder Anmeldeversuch eine Abfrage, die das Ergebnis nicht aendert.
  if (passwordLoginAllowedByEnv()) return true;
  let hasLinkedSsoAccount = true;
  try {
    const db_ = database || db.get();
    // Ein verknuepfter ADMINISTRATOR, nicht irgendein verknuepftes Konto.
    // Meldet sich in einem bestehenden Haushalt als Erstes ein gewoehnliches
    // Mitglied per SSO an, waere der Riegel sonst sofort zu - und der Admin,
    // dessen Konto mangels eindeutiger verifizierter Adresse nie verknuepft
    // wurde, kaeme nach Ablauf seiner Sitzung nicht mehr an seine eigene
    // Verwaltung. Der Weg hinein muss fuer den offen bleiben, der ihn wieder
    // aufmachen koennte.
    hasLinkedSsoAccount = !!db_
      .prepare("SELECT 1 FROM users WHERE oidc_sub IS NOT NULL AND role = 'admin' LIMIT 1").get();
  } catch (err) {
    // Eine Datenbank, die gerade nicht antwortet, darf niemanden aussperren.
    log.warn('SSO-Verknuepfungspruefung fehlgeschlagen:', err?.message || err);
    return true;
  }
  return passwordLoginAllowedByEnv({ hasLinkedSsoAccount });
}

/**
 * Ist dieses Konto ein Gast aus den geteilten Ausgaben? (#847)
 *
 * Solche Konten legt ein Admin fuer externe Personen an - Mitfahrer, Freunde,
 * Nachbarn - und vergibt ihnen dabei ein Passwort. Sie gehoeren nicht zum
 * Haushalt und tauchen in dessen Identitaetsanbieter nicht auf, also nimmt
 * `AUTH_ALLOW_PASSWORD_LOGIN` sie nicht mit.
 *
 * @param {number} userId
 * @returns {boolean}
 */
function isSplitExpenseGuest(userId, database = null) {
  try {
    return !!(database || db.get())
      .prepare('SELECT 1 FROM split_expense_guest_users WHERE user_id = ?').get(userId);
  } catch {
    // Fehlt die Tabelle (aeltere Testschemata), gibt es auch keine Gaeste.
    return false;
  }
}

/**
 * Gibt es ueberhaupt einen solchen Gast? (#962)
 *
 * Die Ausnahme oben ist eine Antwort auf eine Frage, die nur ein Haushalt mit
 * geteilten Ausgaben stellt. Ohne einen einzigen Gast zeigt die Anmeldeseite
 * sonst einen Weg hinein, den niemand gehen kann - und wer `AUTH_ALLOW_PASSWORD_LOGIN=false`
 * gesetzt hat, liest ihn als Sicherheitsluecke statt als Ausnahme.
 *
 * Die Antwort ist EIN Bit und bleibt eins: sie sagt "es gibt welche", nie wer
 * oder wie viele. `LIMIT 1` haelt bei der ersten Zeile an, `idx_split_guest_group`
 * deckt die Tabelle.
 *
 * @param {object} [database]  fuer Tests; sonst die laufende Instanz
 * @returns {boolean}
 */
export function hasSplitExpenseGuests(database = null) {
  try {
    return !!(database || db.get())
      .prepare('SELECT 1 FROM split_expense_guest_users LIMIT 1').get();
  } catch {
    // Fehlt die Tabelle (aeltere Testschemata), gibt es auch keine Gaeste.
    return false;
  }
}

/**
 * POST /api/v1/auth/login
 * Body: { username: string, password: string }
 * Response: { user: { id, username, display_name, avatar_color, role, family_role } }
 */
router.post('/login', loginLimiter, async (req, res) => {
  try {
    const { username, password } = req.body;

    if (!username || !password) {
      return res.status(400).json({ error: 'Username and password are required.', code: 400 });
    }

    if (username.length > 64 || password.length > 1024) {
      return res.status(400).json({ error: 'Input is too long.', code: 400 });
    }

    const user = db.get().prepare('SELECT * FROM users WHERE username = ?').get(username);

    if (!user) {
      // Timing-Attack-Schutz: trotzdem bcrypt ausführen. Bewusst über
      // verifyPassword, damit ein Fehlversuch dieselbe Anzahl bcrypt-Läufe
      // kostet wie bei einem existierenden Konto.
      await verifyPassword(password, DUMMY_PASSWORD_HASH);
      log.warn('Login failed', { ip: req.ip, username, reason: 'user_not_found' });
      return res.status(401).json({ error: 'Invalid credentials.', code: 401 });
    }

    const { valid, needsRehash } = await verifyPassword(password, user.password_hash);
    if (!valid) {
      log.warn('Login failed', { ip: req.ip, username, reason: 'invalid_password' });
      return res.status(401).json({ error: 'Invalid credentials.', code: 401 });
    }

    // Der Hash stammt aus einer nicht-normalisierten Eingabe (Issue #608):
    // still auf NFC migrieren, damit künftig jeder Browser passt.
    if (needsRehash) {
      try {
        const migrated = await hashPassword(password);
        db.get().prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(migrated, user.id);
        log.info('Password hash migrated to NFC', { userId: user.id });
      } catch (rehashErr) {
        log.error('Password hash migration failed:', rehashErr.message);
      }
    }

    const isStaff = db.get().prepare('SELECT 1 FROM housekeeping_workers WHERE user_id = ?').get(user.id);
    if (isStaff) {
      log.warn('Login blocked for housekeeping staff account', { ip: req.ip, username });
      return res.status(403).json({ error: 'This account cannot sign in.', code: 403 });
    }

    // Wer die eingebaute Anmeldung abgeschaltet hat, hat sie auch fuer alles
    // abgeschaltet, was das Formular umgeht (#847) - eine Regel, die nur die
    // Anmeldeseite kennt, ist keine Regel, sondern eine Bitte.
    //
    // Der Schalter gilt aber dem HAUSHALT, und ein Gast aus den geteilten
    // Ausgaben ist keiner: er ist eine externe Person, die der Admin mit einem
    // vergebenen Passwort anlegt und die im Identitaetsanbieter des Haushalts
    // nichts zu suchen hat. Ein globaler Riegel haette diese Konten stumm
    // unbrauchbar gemacht, samt der bereits bestehenden.
    //
    // Steht hier und nicht am Anfang der Route, weil die Entscheidung das Konto
    // kennen muss - und weil eine Ablehnung VOR der Passwortpruefung verraten
    // haette, welche Benutzernamen es gibt. Dieselbe Reihenfolge wie beim
    // Ausschluss darueber: erst die Zugangsdaten, dann die Berechtigung.
    if (!isPasswordLoginEnabled() && !isSplitExpenseGuest(user.id)) {
      log.warn('Login rejected: password login is disabled', { ip: req.ip, username });
      return res.status(403).json({ error: 'Password login is disabled.', code: 403 });
    }

    // Zweiter Faktor (#672): das Passwort stimmt, die Sitzung entsteht aber
    // noch nicht. Der Wartezustand traegt bewusst einen ANDEREN Schluessel als
    // `userId` - `requireAuth` prueft genau den und ist damit blind fuer einen
    // halb angemeldeten Zustand. Ein neuer Schluessel kann hier nichts
    // aufschliessen, was der alte nicht schon aufgeschlossen haette.
    if (twoFactor.isEnabled(db.get(), user.id)) {
      req.session.pendingTwoFactor = { userId: user.id, expiresAt: Date.now() + TWO_FACTOR_WINDOW_MS };
      return res.json({
        twoFactorRequired: true,
        recoveryAvailable: twoFactor.getStatus(db.get(), user.id).recovery_remaining > 0,
      });
    }

    try {
      await setupAuthSession(req, res, user);
      res.json(loginPayload(req, user));
    } catch (sessionErr) {
      log.error('Session regeneration failed:', sessionErr);
      res.status(500).json({ error: 'Internal server error.', code: 500 });
    }
  } catch (err) {
    log.error('Login error:', err);
    res.status(500).json({ error: 'Internal server error.', code: 500 });
  }
});

/**
 * Registriert die öffentlichen Forgot-/Reset-Routen auf dem gegebenen Router.
 * Dependency-Injection für Tests (DB, Email-Service, Reset-Service, baseUrl).
 */
export function buildResetRoutes(targetRouter, {
  database = null,
  emailService = defaultEmailService,
  resetService = defaultResetService,
  baseUrl = process.env.BASE_URL || '',
  limiter = passwordResetLimiter,
} = {}) {
  const getDb = () => (database || db.get());

  function resolveUser(identifier) {
    const id = String(identifier || '').trim();
    if (!id) return null;
    const byName = getDb().prepare('SELECT id FROM users WHERE username = ?').get(id);
    if (byName) return byName.id;
    const byEmail = getDb().prepare(
      'SELECT family_user_id AS id FROM contacts WHERE email = ? AND family_user_id IS NOT NULL LIMIT 1'
    ).get(id);
    return byEmail?.id ?? null;
  }

  /**
   * Hat dieses Konto ueberhaupt ein Passwort, das man zuruecksetzen koennte?
   *
   * Ein rein per SSO angelegtes Konto traegt den Platzhalter statt eines Hashs.
   * Der Reset hat diesen Zustand bis #847 nicht gekannt und haette ihm ein
   * echtes, funktionierendes Passwort gegeben - genau die zweite Tuer, die der
   * Platzhalter zuhalten soll. Wer den Reset ausloest, braucht dafuer nur eine
   * E-Mail-Adresse aus den Kontakten, nicht das Konto selbst.
   */
  function hasResettablePassword(userId) {
    const row = getDb().prepare('SELECT password_hash FROM users WHERE id = ?').get(userId);
    return !!row && !isSsoOnlyAccount(row.password_hash);
  }

  // Seit #944 fragt auch der Versand der Einkaufsliste danach. Beide gehen
  // durch dieselbe Funktion, damit "wie erreiche ich dieses Mitglied" genau
  // eine Antwort behaelt.
  const emailFor = (userId) => memberEmail(userId, { db: getDb() });

  targetRouter.post('/forgot-password', limiter, async (req, res) => {
    try {
      const { identifier } = req.body || {};
      const userId = resolveUser(identifier);
      // Anti-enumeration: identical response regardless of outcome. Deshalb
      // gehen auch die beiden neuen Gruende (#847) durch dieselbe Antwort -
      // ein eigener Statuscode fuer "dieses Konto hat kein Passwort" wuerde
      // verraten, welche Konten per SSO gefuehrt werden.
      if (userId && (isPasswordLoginEnabled(getDb()) || isSplitExpenseGuest(userId, getDb()))
          && hasResettablePassword(userId)
          && emailService.isConfigured()) {
        const to = emailFor(userId);
        // Reset links MUST use an explicitly configured, trusted origin.
        // Never derive it from the request Host header (password-reset
        // poisoning: a forged Host would point the victim's token at an
        // attacker-controlled domain).
        const origin = String(baseUrl || '').trim().replace(/\/$/, '');
        if (to && origin) {
          const { token } = resetService.createToken(userId);
          const link = `${origin}/reset-password?token=${token}`;
          await emailService.sendMail({
            to,
            subject: 'Reset your Yuvomi password',
            text: `Open this link to choose a new password (valid for 1 hour): ${link}`,
            html: `<p>Open this link to choose a new password (valid for 1 hour):</p>`
              + `<p><a href="${link}">${link}</a></p>`,
          }).catch((err) => log.error('Reset mail failed:', err.message));
        } else if (to && !origin) {
          log.warn('BASE_URL not configured; password-reset link not sent.');
        }
      }
      res.json({ data: { ok: true } });
    } catch (err) {
      log.error('forgot-password error:', err.message);
      // Still return generic success to avoid leaking failures.
      res.json({ data: { ok: true } });
    }
  });

  targetRouter.post('/reset-password', limiter, async (req, res) => {
    try {
      const { token, password } = req.body || {};
      if (!token || !password) {
        return res.status(400).json({ error: 'Token and password are required.', code: 400 });
      }
      if (normalizePassword(password).length < 8) {
        return res.status(400).json({ error: 'Password must be at least 8 characters long.', code: 400 });
      }
      const userId = resetService.verifyToken(token);
      if (!userId) {
        return res.status(400).json({ error: 'Invalid or expired token.', code: 400 });
      }
      // Zwischen dem Ausstellen des Tokens und dem Einloesen kann der Admin das
      // Konto auf SSO umgestellt oder die eingebaute Anmeldung abgeschaltet
      // haben (#847). Ein noch gueltiger Token darf diese Entscheidung nicht
      // ueberholen. Bewusst dieselbe Meldung wie ein ungueltiger Token: der
      // Unterschied ginge sonst an jemanden, der das Konto nicht besitzt.
      if ((!isPasswordLoginEnabled(getDb()) && !isSplitExpenseGuest(userId, getDb()))
          || !hasResettablePassword(userId)) {
        resetService.consumeToken(token);
        return res.status(400).json({ error: 'Invalid or expired token.', code: 400 });
      }
      const hash = await hashPassword(password);
      getDb().prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(hash, userId);
      resetService.consumeToken(token);
      // Best-effort: invalidate existing sessions for this user.
      try {
        const rows = getDb().prepare('SELECT sid, sess FROM sessions').all();
        for (const r of rows) {
          try { if (JSON.parse(r.sess)?.userId === userId) getDb().prepare('DELETE FROM sessions WHERE sid = ?').run(r.sid); }
          catch { /* ignore malformed session rows */ }
        }
      } catch { /* sessions table may not exist in tests */ }
      res.json({ data: { ok: true } });
    } catch (err) {
      log.error('reset-password error:', err.message);
      res.status(500).json({ error: 'Internal server error.', code: 500 });
    }
  });
}

buildResetRoutes(router);

/**
 * Registriert die Einladungs-Routen auf dem gegebenen Router: drei Admin-Routen
 * (erzeugen, auflisten, widerrufen) und zwei öffentliche (Vorschau, Einlösen).
 * Dependency-Injection für Tests wie bei buildResetRoutes.
 *
 * Die öffentlichen Routen tragen bewusst kein CSRF, genau wie /forgot-password
 * und /reset-password: der Einladungstoken ist das Geheimnis.
 *
 * `database` und `inviteService` müssen auf derselben DB-Instanz sitzen - das
 * Einlösen markiert die Einladung innerhalb der User-Transaktion.
 */
export function buildInviteRoutes(targetRouter, {
  database = null,
  emailService = defaultEmailService,
  inviteService = defaultInviteService,
  baseUrl = process.env.BASE_URL || '',
  limiter = passwordResetLimiter,
} = {}) {
  const getDb = () => (database || db.get());

  targetRouter.post('/invites', requireAuth, requireAdmin, csrfMiddleware, async (req, res) => {
    try {
      const body = req.body || {};
      const username = String(body.username || '').trim();
      const displayName = String(body.display_name || '').trim();
      const email = String(body.email || '').trim();
      const familyRole = String(body.family_role || 'other').trim();
      const sendEmail = body.send_email === true || body.send_email === 'true';
      const role = body.system_admin === true || body.system_admin === 'true' ? 'admin' : 'member';
      // Startrechte (#869). Fehlt das Feld, gilt die enge Vorlage - ein
      // Client, der sie nicht kennt, laedt damit nicht versehentlich mit
      // vollem Zugriff ein. Das ist die einzige Stelle, an der die Umkehr
      // wirkt: der gespeicherte Standard in `access_permissions` bleibt, was
      // er seit v74 ist.
      const preset = body.permission_preset === undefined
        ? INVITE_PRESET_DEFAULT
        : String(body.permission_preset || '').trim();

      if (username && !/^[a-zA-Z0-9._-]{3,64}$/.test(username)) {
        return res.status(400).json({ error: 'Username must be 3-64 characters long and may only contain letters, numbers, dots, hyphens, and underscores.', code: 400 });
      }
      if (displayName.length > 128) {
        return res.status(400).json({ error: 'Display name may be at most 128 characters long.', code: 400 });
      }
      if (!FAMILY_ROLES.includes(familyRole)) {
        return res.status(400).json({ error: 'Invalid family role.', code: 400 });
      }
      if (!isValidInvitePreset(preset)) {
        return res.status(400).json({ error: 'Invalid permission preset.', code: 400 });
      }
      // Bewusst grob: eine selbstgehostete Instanz verschickt auch an Adressen
      // ohne Punkt in der Domain (user@nas). Der Versand meldet den Rest.
      if (email && !/^[^\s@]+@[^\s@]+$/.test(email)) {
        return res.status(400).json({ error: 'Invalid email address.', code: 400 });
      }
      if (sendEmail && !email) {
        return res.status(400).json({ error: 'An email address is required to send the invitation.', code: 400 });
      }
      if (username && getDb().prepare('SELECT 1 FROM users WHERE username = ?').get(username)) {
        return res.status(409).json({ error: 'Username is already taken.', code: 409 });
      }

      // Aufgeloest gespeichert, nicht als Name der Vorlage: massgeblich ist,
      // was der Admin beim Einladen gesehen hat - auch wenn das Rollenprofil
      // sich bis zur Annahme aendert.
      const presetPermissions = invitePresetPermissions(preset);
      const { token } = inviteService.createInvite({
        email: email || null,
        username: username || null,
        displayName: displayName || null,
        role,
        familyRole,
        permissions: presetPermissions ? JSON.stringify(presetPermissions) : null,
        createdBy: req.authUserId,
      });
      // Die frisch angelegte Zeile ohne token_hash - gleiche Form wie GET /invites.
      const invite = inviteService.verifyToken(token);

      let emailSent = false;
      if (sendEmail) {
        // Hier formuliert der Server die Zieladresse, also gilt BASE_URL und
        // nicht der Host-Header. Den Link fürs Weitergeben von Hand baut das
        // Admin-UI dagegen selbst aus location.origin.
        const origin = String(baseUrl || '').trim().replace(/\/$/, '');
        if (!origin) {
          log.warn('BASE_URL not configured; invite mail not sent.');
        } else if (!emailService.isConfigured()) {
          log.warn('Email not configured; invite mail not sent.');
        } else {
          const link = `${origin}/join?token=${token}`;
          try {
            await emailService.sendMail({
              to: email,
              subject: 'You have been invited to Yuvomi',
              text: `Open this link to set up your account (valid for 7 days): ${link}`,
              html: '<p>Open this link to set up your account (valid for 7 days):</p>'
                + `<p><a href="${link}">${link}</a></p>`,
            });
            emailSent = true;
          } catch (mailErr) {
            // email_sent muss ehrlich bleiben: meldet das UI einen Versand, den
            // es nie gab, gibt der Admin den Link nicht selbst weiter.
            log.error('Invite mail failed:', mailErr.message);
          }
        }
      }

      // Aus der Datenbank ist der Klartext-Token danach nie wieder zu holen: dort
      // liegt nur sein Hash. Diese Antwort ist die einzige Stelle, die ihn dem
      // Admin zeigt (der Mailversand oben hat ihn ggf. zusätzlich verschickt).
      res.status(201).json({ data: { invite, token, email_sent: emailSent } });
    } catch (err) {
      log.error('Invite creation error:', err.message);
      res.status(500).json({ error: 'Internal server error.', code: 500 });
    }
  });

  targetRouter.get('/invites', requireAuth, requireAdmin, (_req, res) => {
    try {
      res.json({ data: { invites: inviteService.listOpen() } });
    } catch (err) {
      log.error('Invite list error:', err.message);
      res.status(500).json({ error: 'Internal server error.', code: 500 });
    }
  });

  targetRouter.delete('/invites/:id', requireAuth, requireAdmin, csrfMiddleware, (req, res) => {
    try {
      const id = parseInt(req.params.id, 10);
      if (!Number.isFinite(id)) {
        return res.status(400).json({ error: 'Invalid invite ID.', code: 400 });
      }
      if (inviteService.revoke(id) === 0) {
        return res.status(404).json({ error: 'Invite not found.', code: 404 });
      }
      res.json({ data: { ok: true } });
    } catch (err) {
      log.error('Invite revocation error:', err.message);
      res.status(500).json({ error: 'Internal server error.', code: 500 });
    }
  });

  targetRouter.get('/invites/preview', limiter, (req, res) => {
    try {
      const invite = inviteService.verifyToken(String(req.query.token || ''));
      if (!invite) return res.json({ data: { valid: false } });
      res.json({
        // `password_required` sagt der /join-Seite, ob sie ueberhaupt nach einem
        // Passwort fragen soll (#847). Ohne die Angabe zeigte sie zwei
        // Pflichtfelder, deren Inhalt der Server verwirft - und der Eingeladene
        // haette sich ein Passwort ausgedacht, mit dem er sich nie anmeldet.
        data: {
          valid: true,
          display_name: invite.display_name,
          username: invite.username,
          password_required: isPasswordLoginEnabled(getDb()),
        },
      });
    } catch (err) {
      log.error('Invite preview error:', err.message);
      res.status(500).json({ error: 'Internal server error.', code: 500 });
    }
  });

  targetRouter.post('/invites/accept', limiter, async (req, res) => {
    try {
      const { token, password } = req.body || {};
      if (!token) {
        return res.status(400).json({ error: 'Token and password are required.', code: 400 });
      }
      // Der Token wird VOR dem Passwort geprueft, seit nicht mehr jede
      // Einladung eines verlangt: er ist ohnehin das Geheimnis, und erst er
      // sagt, welche E-Mail-Adresse dieser Einladung anhaengt.
      const invite = inviteService.verifyToken(token);
      if (!invite) {
        return res.status(400).json({ error: 'Invalid or expired token.', code: 400 });
      }

      // Mit abgeschalteter Passwort-Anmeldung entstuende hier sonst ein Konto,
      // das seinen Zugang im selben Moment verliert (#847): der Eingeladene
      // vergibt ein Passwort, die Einladung ist verbraucht, und die Anmeldung
      // weist ihn ab. Stattdessen entsteht ein Konto ohne Passwort - die
      // Adresse der Einladung ist genau der Weg, auf dem die erste
      // SSO-Anmeldung es findet.
      const ssoOnly = !isPasswordLoginEnabled(getDb());
      if (ssoOnly) {
        // Dieselbe Pruefung wie beim Anlegen durch einen Admin, und aus
        // demselben Grund: eine vorhandene Adresse genuegt nicht, sie muss
        // dieses eine Konto MEINEN. Gehoert sie schon einem anderen
        // unverknuepften Mitglied - auch in anderer Schreibweise oder als
        // dessen Zweitadresse -, findet der Linker zwei Kandidaten und
        // verknuepft gar nicht. Die Einladung waere verbraucht und das Konto
        // unerreichbar.
        const linkError = assertSsoOnlyAllowed(true, '', { email: invite.email });
        if (linkError) {
          return res.status(400).json({
            error: `${linkError} Ask for a new invitation.`,
            code: 400,
          });
        }
      } else {
        if (!password) {
          return res.status(400).json({ error: 'Token and password are required.', code: 400 });
        }
        if (normalizePassword(password).length < 8) {
          return res.status(400).json({ error: 'Password must be at least 8 characters long.', code: 400 });
        }
      }

      // Benutzer- und Anzeigename darf der Eingeladene selbst setzen, solange die
      // Einladung sie nicht vorgibt. Rolle und Familienrolle NIE: sie stammen
      // ausschließlich aus der Einladung, sonst schreibt sich der Eingeladene
      // über den Body selbst zum Admin.
      const username = String(invite.username || req.body.username || '').trim();
      const displayName = String(invite.display_name || req.body.display_name || '').trim() || username;

      if (!/^[a-zA-Z0-9._-]{3,64}$/.test(username)) {
        return res.status(400).json({ error: 'Username must be 3-64 characters long and may only contain letters, numbers, dots, hyphens, and underscores.', code: 400 });
      }
      if (displayName.length > 128) {
        return res.status(400).json({ error: 'Display name may be at most 128 characters long.', code: 400 });
      }

      const hash = ssoOnly ? OIDC_PASSWORD_SENTINEL : await hashPassword(password);
      const avatarColor = avatarColors[crypto.randomInt(avatarColors.length)];

      const ACCEPT_LOST = Symbol('accept_lost');
      try {
        getDb().transaction(() => {
          const created = getDb().prepare(`
            INSERT INTO users (username, display_name, password_hash, avatar_color, role, family_role)
            VALUES (?, ?, ?, ?, ?, ?)
          `).run(username, displayName, hash, avatarColor, invite.role, invite.family_role);
          const newUserId = Number(created.lastInsertRowid);
          // Startrechte, bevor das Konto zum ersten Mal benutzbar ist (#869).
          // In DERSELBEN Transaktion wie das Konto: entstuende es ohne seine
          // Rechte, waere die Einladung verbraucht und das Mitglied saehe
          // genau das, wovor die Vorlage es bewahren sollte. Deshalb hier
          // `writeSubjectPermissions()` und nicht `replaceSubjectPermissions()`
          // - dessen eigenes BEGIN waere in dieser Klammer ein Fehler.
          if (invite.permissions) {
            let parsed = null;
            try {
              parsed = JSON.parse(invite.permissions);
            } catch {
              // Eine unlesbare Vorgabe darf die Annahme nicht scheitern lassen,
              // aber auch nicht still zu vollem Zugriff werden: gemeldet und
              // die engste bekannte Vorlage angewandt.
              log.error('Invite permissions unreadable; falling back to the restricted preset.');
              parsed = invitePresetPermissions('restricted');
            }
            writeSubjectPermissions(getDb(), 'user', newUserId, parsed);
          }
          syncFamilyMemberArtifacts(getDb(), newUserId, {
            displayName,
            // Die eingeladene Adresse wird zur Kontaktadresse: ohne sie fände der
            // neue Nutzer den Weg über /forgot-password nicht.
            email: invite.email || undefined,
            actorUserId: newUserId,
          });
          // In derselben Transaktion: von zwei parallelen Einlösungen desselben
          // Tokens sieht nur eine changes === 1, die andere rollt zurück.
          if (inviteService.markAccepted(token, newUserId) === 0) throw ACCEPT_LOST;
        })();
      } catch (txErr) {
        if (txErr === ACCEPT_LOST) {
          return res.status(400).json({ error: 'Invalid or expired token.', code: 400 });
        }
        throw txErr;
      }

      res.status(201).json({ data: { ok: true, username } });
    } catch (err) {
      if (err.message?.includes('UNIQUE constraint')) {
        return res.status(409).json({ error: 'Username is already taken.', code: 409 });
      }
      log.error('Invite accept error:', err.message);
      res.status(500).json({ error: 'Internal server error.', code: 500 });
    }
  });
}

buildInviteRoutes(router);

/**
 * POST /api/v1/auth/logout
 * Response: { ok: true }
 */
router.post('/logout', requireAuth, csrfMiddleware, (req, res) => {
  if (req.authMethod === 'api_token') {
    return res.json({ ok: true });
  }
  req.session.destroy((err) => {
    if (err) {
      log.error('Logout error:', err);
      return res.status(500).json({ error: 'Logout failed.', code: 500 });
    }
    res.clearCookie(SESSION_COOKIE);
    res.clearCookie(LEGACY_SESSION_COOKIE); // best effort: verwaistes Legacy-Cookie räumen
    res.json({ ok: true });
  });
});

/**
 * GET /api/v1/auth/oidc/config
 * Öffentlicher Endpunkt — kein Auth, kein CSRF.
 * Beantwortet vollständig, welche Anmeldewege dieser Server anbietet.
 * Response: { enabled, password_login_enabled, guest_password_login_enabled }
 *
 * `password_login_enabled` liegt bewusst hier und nicht in `/version` (#847):
 * die Anmeldeseite wartet auf genau diese eine Antwort, bevor sie zeichnet, um
 * kein Formular einzublenden, das gleich wieder verschwindet. Ein zweiter
 * blockierender Aufruf waere ein zweiter Grund, warum die Seite haengt.
 *
 * `guest_password_login_enabled` beantwortet die Frage, die die Seite bisher
 * nicht gestellt hat (#962): ob die Gast-Ausnahme aus #847 hier ueberhaupt
 * jemanden betrifft. Die Kurzschluss-Reihenfolge ist Absicht - steht der
 * Passwort-Login offen, ist die Frage gegenstandslos und die Gaeste-Abfrage
 * laeuft gar nicht erst. Der oeffentliche Endpunkt verraet damit in der
 * Normalkonfiguration nichts, was er nicht ohnehin sagt, und in der
 * SSO-only-Konfiguration genau das eine Bit, das die Anzeige braucht.
 */
router.get('/oidc/config', (_req, res) => {
  const passwordLoginEnabled = isPasswordLoginEnabled();
  res.json({
    enabled: isOidcEnabled(),
    password_login_enabled: passwordLoginEnabled,
    guest_password_login_enabled: !passwordLoginEnabled && hasSplitExpenseGuests(),
  });
});

/**
 * GET /api/v1/auth/oidc/start
 * Leitet den Browser zum OIDC-Provider weiter.
 * state + nonce + PKCE-code_verifier werden in der Session abgelegt (CSRF-,
 * Replay- und Code-Injection-Schutz) und im Callback einmalig verbraucht.
 */
/**
 * Legt state/nonce/PKCE in der Session ab und baut die Authorization-URL.
 * Geteilt von der Anmeldung und dem Verknüpfen (#832) - zwei Fassungen wären
 * zwei Gelegenheiten, einen der Schutzwerte zu vergessen.
 *
 * @param {object} extra  zusätzliche Session-Felder, z. B. { linkUserId }
 */
async function beginOidcFlow(req, config, extra = {}) {
  const state         = oidcClient.randomState();
  const nonce         = oidcClient.randomNonce();
  const codeVerifier  = oidcClient.randomPKCECodeVerifier();
  const codeChallenge = await oidcClient.calculatePKCECodeChallenge(codeVerifier);

  req.session.oidc = { state, nonce, codeVerifier, ...extra };

  await new Promise((resolve, reject) =>
    req.session.save(err => (err ? reject(err) : resolve()))
  );

  return oidcClient.buildAuthorizationUrl(config, {
    redirect_uri:          process.env.OIDC_REDIRECT_URI,
    scope:                 'openid email profile',
    state,
    nonce,
    code_challenge:        codeChallenge,
    code_challenge_method: 'S256',
  }).href;
}

router.get('/oidc/start', async (req, res) => {
  try {
    const config = await getOidcConfig();
    if (!config) {
      return res.status(404).json({ error: 'OIDC is not configured.', code: 404 });
    }
    res.redirect(await beginOidcFlow(req, config));
  } catch (err) {
    log.error('OIDC start error:', err);
    res.status(500).json({ error: 'OIDC initialization failed.', code: 500 });
  }
});

/**
 * GET /api/v1/auth/oidc/link
 * Verknüpfungsstand des eigenen Kontos (#832).
 * Response: { enabled, linked, provider, can_unlink }
 */
router.get('/oidc/link', requireAuth, (req, res) => {
  const user = db.get()
    .prepare('SELECT oidc_sub, oidc_provider, password_hash FROM users WHERE id = ?')
    .get(req.authUserId);
  if (!user) return res.status(404).json({ error: 'User not found.', code: 404 });

  res.json({
    enabled:    isOidcEnabled(),
    linked:     !!user.oidc_sub,
    provider:   user.oidc_provider ?? null,
    // Ein per SSO angelegtes Konto hat kein Passwort - das Lösen nähme ihm den
    // einzigen Zugang. Die Oberfläche erklärt das, statt den Fehler abzuwarten.
    can_unlink: !!user.oidc_sub && !isSsoOnlyAccount(user.password_hash),
  });
});

/**
 * POST /api/v1/auth/oidc/link/start
 * Startet den Verknüpfungs-Flow für das angemeldete Konto (#832).
 *
 * Bewusst POST mit CSRF-Prüfung und nicht der Redirect von /oidc/start: sonst
 * genügte ein untergeschobener Link, um das Konto eines Angreifers an die
 * fremde Sitzung zu heften (Login-CSRF). Die Weiterleitung übernimmt der
 * Browser mit der zurückgegebenen URL.
 *
 * Response: { url: string }
 */
router.post('/oidc/link/start', requireAuth, csrfMiddleware, async (req, res) => {
  try {
    const config = await getOidcConfig();
    if (!config) return res.status(404).json({ error: 'OIDC is not configured.', code: 404 });

    const user = db.get().prepare('SELECT oidc_sub FROM users WHERE id = ?').get(req.authUserId);
    if (user?.oidc_sub) {
      return res.status(409).json({ error: 'Account is already linked.', code: 409 });
    }

    res.json({ url: await beginOidcFlow(req, config, { linkUserId: req.authUserId }) });
  } catch (err) {
    log.error('OIDC link start error:', err);
    res.status(500).json({ error: 'OIDC initialization failed.', code: 500 });
  }
});

/**
 * DELETE /api/v1/auth/oidc/link
 * Löst die Verknüpfung des eigenen Kontos (#832).
 * Response: { ok: true }
 */
router.delete('/oidc/link', requireAuth, csrfMiddleware, (req, res) => {
  const result = unlinkOidcAccount(db.get(), req.authUserId);
  if (result.ok) return res.json({ ok: true });

  if (result.reason === 'user_gone')   return res.status(404).json({ error: 'User not found.', code: 404 });
  if (result.reason === 'not_linked')  return res.status(409).json({ error: 'Account is not linked.', code: 409 });
  if (result.reason === 'last_sso_admin') return res.status(409).json({
    error: 'This is the last administrator linked to SSO. Unlinking it would switch password login '
      + 'back on for the whole household. Link another administrator first.',
    code: 409,
  });
  return res.status(409).json({
    error: 'Set a password before unlinking - it is currently the only way into this account.',
    code:  409,
  });
});

/**
 * GET /api/v1/auth/oidc/callback
 * Wird vom OIDC-Provider nach erfolgter Authentifizierung aufgerufen.
 * Validiert state/nonce/PKCE, tauscht den Code gegen Tokens (client.callback
 * prüft Signatur, iss, aud, exp, nonce), ermittelt/erstellt den User über den
 * validierten sub und richtet die Session ein.
 */
router.get('/oidc/callback', async (req, res) => {
  try {
    const config = await getOidcConfig();
    if (!config) return res.redirect('/login?error=oidc_not_configured');

    // Einmalig konsumieren — verhindert Wiederverwendung von state/nonce/verifier
    const stored = req.session.oidc;
    delete req.session.oidc;

    if (!stored?.state) {
      log.warn('OIDC callback: kein Session-State (abgelaufen oder nicht initiiert)');
      return res.redirect('/login?error=oidc_state_mismatch');
    }

    // Aktuelle Callback-URL: Host/Schema aus der registrierten redirect_uri (zuverlässig
    // hinter Reverse-Proxy), Query (code, state, …) aus der eingehenden Anfrage.
    const currentUrl = new URL(req.originalUrl, process.env.OIDC_REDIRECT_URI);

    // authorizationCodeGrant validiert state, tauscht den Code gegen Tokens und prüft
    // Signatur, iss, aud, exp sowie nonce (über expectedNonce) am ID-Token.
    const tokens = await oidcClient.authorizationCodeGrant(config, currentUrl, {
      expectedState:    stored.state,
      expectedNonce:    stored.nonce,
      pkceCodeVerifier: stored.codeVerifier,
    });

    // Identität aus dem validierten ID-Token; fetchUserInfo erzwingt sub-Abgleich
    const claims   = tokens.claims();
    const userinfo = await oidcClient.fetchUserInfo(config, tokens.access_token, claims.sub);

    // Verknüpfungs-Lauf (#832): der Nutzer ist bereits angemeldet und bindet
    // sein OIDC-Konto an genau dieses Konto. Kein Anlegen, kein Zuordnen über
    // E-Mail - die Session hat das lokale Konto schon benannt, bevor der Flow
    // begann, und der linkUserId stammt aus derselben signierten Session wie
    // der state.
    if (stored.linkUserId) {
      const result = linkOidcAccount(db.get(), stored.linkUserId, {
        sub: claims.sub,
        iss: claims.iss,
      });
      if (!result.ok) {
        log.warn(`OIDC link rejected for user ${stored.linkUserId}: ${result.reason}`);
      }
      return res.redirect(result.ok
        ? '/settings/personal/account?oidc_linked=1'
        : `/settings/personal/account?oidc_link_error=${result.reason}`);
    }

    const user = findOrCreateOidcUser(db.get(), {
      sub:                claims.sub,
      // iss stammt aus dem validierten ID-Token und ist gegen die Discovery-Metadaten
      // geprüft, also verlässlicher als die konfigurierte OIDC_ISSUER-URL
      iss:                claims.iss,
      email:              userinfo.email,
      // email_verified kann je nach Provider im UserInfo oder im ID-Token stehen
      email_verified:     userinfo.email_verified ?? claims.email_verified,
      name:               userinfo.name,
      preferred_username: userinfo.preferred_username,
      // non-standard, u. a. Synology DSM SSO: der reine Kontoname ohne Directory-Teil
      username:           userinfo.username ?? claims.username,
    });

    // Kein Konto, und keins anlegen duerfen (#654). Der Grund steht im
    // Redirect, weil die Anmeldeseite sonst „SSO-Anmeldung fehlgeschlagen"
    // zeigt - und das ist hier schlicht falsch: die Anmeldung am IdP hat
    // funktioniert, es fehlt das Konto. Wer das liest, sucht den Fehler bei
    // seinem Passwort statt bei seinem Admin.
    if (!user) {
      log.warn(`OIDC signup blocked (OIDC_ALLOW_SIGNUP=false): sub=${claims.sub}`);
      return res.redirect('/login?error=oidc_signup_disabled');
    }

    // Der zweite Faktor gilt AUCH auf diesem Weg (#672).
    //
    // Es gaebe ein Argument dagegen: bei SSO hat der Provider authentifiziert,
    // womoeglich selbst mit zweitem Faktor, und ein weiterer waere doppelt.
    // Zwei Dinge wiegen schwerer. Erstens hat der Nutzer ihn HIER
    // eingeschaltet - eine Zusage, die von der Anmeldeart abhaengt, ist keine.
    // Zweitens, und das entscheidet: die haushaltsweite Pflicht waere sonst
    // ueber diesen Weg auszuhebeln, und damit waere sie keine Pflicht,
    // sondern eine Bitte an die, die den Passwort-Weg nehmen.
    //
    // Der Wartezustand ist derselbe wie beim Passwort-Login, deshalb landet
    // der Browser auf der Anmeldeseite und wird dort nach dem Code gefragt.
    if (twoFactor.isEnabled(db.get(), user.id)) {
      req.session.pendingTwoFactor = { userId: user.id, expiresAt: Date.now() + TWO_FACTOR_WINDOW_MS };
      return res.redirect('/login?two_factor=1');
    }

    await setupAuthSession(req, res, user);

    res.redirect('/');
  } catch (err) {
    log.error('OIDC callback error:', err);
    res.redirect('/login?error=oidc_failed');
  }
});

/**
 * POST /api/v1/auth/setup
 * First-run bootstrap: creates the first admin when no users exist.
 * Returns 403 if any user already exists.
 * Body: { username: string, display_name: string, password: string }
 * Response: { user: { id, username, display_name, avatar_color, role } }
 */
router.post('/setup', loginLimiter, async (req, res) => {
  try {
    const { count } = db.get().prepare('SELECT COUNT(*) as count FROM users').get();
    if (count > 0) {
      if (process.env.NODE_ENV === 'production') {
        return res.status(404).json({ error: 'Not found.', code: 404 });
      }
      return res.status(403).json({ error: 'Setup has already been completed.', code: 403 });
    }

    const username = (req.body.username || '').trim();
    const display_name = (req.body.display_name || '').trim();
    const { password } = req.body;

    if (!username || !display_name || !password) {
      return res.status(400).json({ error: 'Username, display name, and password are required.', code: 400 });
    }
    if (!/^[a-zA-Z0-9._-]{3,64}$/.test(username)) {
      return res.status(400).json({ error: 'Username must be 3-64 characters long and may only contain letters, numbers, dots, hyphens, and underscores.', code: 400 });
    }
    if (display_name.length > 128) {
      return res.status(400).json({ error: 'Display name may be at most 128 characters long.', code: 400 });
    }
    if (normalizePassword(password).length < 8) {
      return res.status(400).json({ error: 'Password must be at least 8 characters long.', code: 400 });
    }

    const avatarColor = avatarColors[Math.floor(Math.random() * avatarColors.length)];
    const hash = await hashPassword(password);

    const SETUP_DONE = Symbol('setup_done');
    let result;
    try {
      result = db.transaction(() => {
        const { count: liveCount } = db.get().prepare('SELECT COUNT(*) as count FROM users').get();
        if (liveCount > 0) throw SETUP_DONE;
        const created = db.get()
          .prepare('INSERT INTO users (username, display_name, password_hash, avatar_color, role) VALUES (?, ?, ?, ?, ?)')
          .run(username, display_name, hash, avatarColor, 'admin');
        syncFamilyMemberArtifacts(db.get(), created.lastInsertRowid, {
          displayName: display_name,
          actorUserId: created.lastInsertRowid,
        });
        return created;
      });
    } catch (txErr) {
      if (txErr === SETUP_DONE) {
        return res.status(403).json({ error: 'Setup has already been completed.', code: 403 });
      }
      throw txErr;
    }
    const createdUser = db.get().prepare(`SELECT ${USER_PUBLIC_COLUMNS} FROM users WHERE id = ?`).get(result.lastInsertRowid);

    res.status(201).json({
      user: publicUser(createdUser),
    });
  } catch (err) {
    if (err.message?.includes('UNIQUE constraint')) {
      return res.status(409).json({ error: 'Username is already taken.', code: 409 });
    }
    log.error('Setup error:', err);
    res.status(500).json({ error: 'Internal server error.', code: 500 });
  }
});

/**
 * GET /api/v1/auth/me
 * Response: { user: { id, username, display_name, avatar_color, role } }
 */
router.get('/me', requireAuth, (req, res) => {
  try {
    const user = db.get()
      .prepare(`SELECT ${USER_PUBLIC_COLUMNS} FROM users WHERE id = ?`)
      .get(req.authUserId);

    if (!user) {
      if (req.authMethod === 'session' && typeof req.session.destroy === 'function') {
        req.session.destroy(() => {});
      }
      return res.status(401).json({ error: 'User not found.', code: 401 });
    }

    if (req.authMethod === 'api_token') {
      return res.json({
        user: publicUser(user),
        permissions: clientPermissions(db.get(), user),
        householdSize: householdSize(db.get()),
      });
    }

    // CSRF-Token erneuern falls vorhanden (wichtig fuer iOS-PWA-Resume:
    // iOS kann den CSRF-Cookie verwerfen waehrend die Session-Cookie erhalten bleibt.
    // /me ist der erste API-Call nach App-Resume, also hier den Cookie wiederherstellen.)
    if (!req.session.csrfToken) {
      req.session.csrfToken = generateToken();
    }
    res.cookie('csrf-token', req.session.csrfToken, {
      httpOnly: false,
      sameSite: 'lax',
      secure: process.env.SESSION_SECURE !== 'false',
      maxAge: 1000 * 60 * 60 * 24 * 7,
    });

    res.json({
      user: publicUser(user),
      permissions: clientPermissions(db.get(), user),
      householdSize: householdSize(db.get()),
      csrfToken: req.session.csrfToken,
    });
  } catch (err) {
    log.error('/me error:', err);
    res.status(500).json({ error: 'Internal server error.', code: 500 });
  }
});

/**
 * POST /api/v1/auth/onboarding-seen
 * Merkt das Konto als "hat den aktuellen Onboarding-Rundgang gesehen" vor -
 * am Konto, nicht am Geraet, damit er auf einem neuen Geraet oder in einem
 * privaten Fenster nicht erneut erscheint.
 */
router.post('/onboarding-seen', requireAuth, csrfMiddleware, (req, res) => {
  try {
    db.get().prepare('UPDATE users SET onboarding_version = ? WHERE id = ?')
      .run(CURRENT_ONBOARDING_VERSION, req.authUserId);
    res.json({ ok: true });
  } catch (err) {
    log.error('/onboarding-seen error:', err);
    res.status(500).json({ error: 'Internal server error.', code: 500 });
  }
});

/**
 * POST /api/v1/auth/changelog-seen
 * Body: { latest?: string }
 * Merkt am KONTO, was dieses Konto zuletzt gesehen hat (#496) - nicht am
 * Geraet, sonst zeigt das Tablet dieselbe Liste noch einmal.
 *
 * DIE INSTALLIERTE VERSION KOMMT VOM SERVER, nicht aus dem Body: welche
 * Version hier laeuft, weiss er selbst, und ein Client, der sie mitschickt,
 * koennte sie falsch behaupten. Die veroeffentlichte Version dagegen stammt
 * aus der GitHub-Abfrage, die der Client ohnehin schon hat - fehlt sie, bleibt
 * der bisherige Wert stehen, statt ihn mit null zu ueberschreiben.
 */
router.post('/changelog-seen', requireAuth, csrfMiddleware, (req, res) => {
  try {
    const latest = String(req.body?.latest || '').trim();
    if (latest && latest.length > 64) {
      return res.status(400).json({ error: 'Invalid version.', code: 400 });
    }
    db.get().prepare(`
      UPDATE users
         SET changelog_seen_version = ?,
             changelog_seen_latest  = COALESCE(NULLIF(?, ''), changelog_seen_latest)
       WHERE id = ?
    `).run(APP_VERSION, latest, req.authUserId);
    res.json({ data: { version: APP_VERSION, latest: latest || null } });
  } catch (err) {
    log.error('/changelog-seen error:', err);
    res.status(500).json({ error: 'Internal server error.', code: 500 });
  }
});

// --------------------------------------------------------
// Zwei-Faktor-Anmeldung (#672)
// --------------------------------------------------------

/**
 * Holt den Wartezustand aus der Session und prüft ihn auf Frist.
 * @param {import('express').Request} req
 * @returns {{ userId: number }|null}
 */
function consumePendingTwoFactor(req) {
  const pending = req.session?.pendingTwoFactor;
  if (!pending) return null;
  if (!pending.expiresAt || pending.expiresAt < Date.now()) {
    delete req.session.pendingTwoFactor;
    return null;
  }
  return pending;
}

/**
 * POST /api/v1/auth/2fa/verify
 * Zweiter Schritt der Anmeldung. Body: { code: string }
 *
 * Der Code darf ein TOTP-Code oder ein Wiederherstellungscode sein - welcher
 * es war, steht in der Antwort, damit die Oberfläche auf zur Neige gehende
 * Codes hinweisen kann.
 */
router.post('/2fa/verify', twoFactorLimiter, async (req, res) => {
  try {
    const pending = consumePendingTwoFactor(req);
    if (!pending) {
      return res.status(401).json({ error: 'No pending sign-in.', code: 401 });
    }

    const code = String(req.body?.code || '');
    if (code.length > 64) {
      return res.status(400).json({ error: 'Input is too long.', code: 400 });
    }

    const result = twoFactor.verifySecondFactor(db.get(), pending.userId, code);
    if (!result.valid) {
      log.warn('Second factor failed', { ip: req.ip, userId: pending.userId });
      return res.status(401).json({ error: 'Invalid code.', code: 401 });
    }

    const user = db.get().prepare('SELECT * FROM users WHERE id = ?').get(pending.userId);
    if (!user) {
      delete req.session.pendingTwoFactor;
      return res.status(401).json({ error: 'Invalid credentials.', code: 401 });
    }

    // `regenerate` legt eine neue, leere Session an - der Wartezustand ist
    // danach von selbst fort, und ein vor der Anmeldung untergeschobener
    // Sitzungsschlüssel taugt nichts mehr.
    await setupAuthSession(req, res, user);
    log.info('Second factor accepted', { userId: user.id, method: result.method });

    res.json({
      ...loginPayload(req, user),
      twoFactorMethod: result.method,
      recoveryRemaining: result.recovery_remaining,
    });
  } catch (err) {
    log.error('Second factor error:', err);
    res.status(500).json({ error: 'Internal server error.', code: 500 });
  }
});

/**
 * GET /api/v1/auth/2fa
 * Zustand für die eigene Einstellungsseite.
 */
router.get('/2fa', requireAuth, (req, res) => {
  try {
    res.json({ data: twoFactor.getStatus(db.get(), req.authUserId) });
  } catch (err) {
    log.error('2FA status error:', err);
    res.status(500).json({ error: 'Internal server error.', code: 500 });
  }
});

/**
 * POST /api/v1/auth/2fa/setup
 * Erzeugt ein Geheimnis und liefert QR-Bild plus Klartext. Noch nicht scharf -
 * das wird es erst mit /2fa/enable.
 */
router.post('/2fa/setup', requireAuth, csrfMiddleware, (req, res) => {
  try {
    const user = db.get().prepare('SELECT id, username FROM users WHERE id = ?').get(req.authUserId);
    if (!user) return res.status(401).json({ error: 'User not found.', code: 401 });

    const { secret, uri, qr } = twoFactor.beginSetup(db.get(), user);
    res.json({ data: { secret, uri, qr } });
  } catch (err) {
    if (err.code === 'already_enabled') {
      return res.status(409).json({ error: err.message, code: 409 });
    }
    log.error('2FA setup error:', err);
    res.status(500).json({ error: 'Internal server error.', code: 500 });
  }
});

/**
 * POST /api/v1/auth/2fa/enable
 * Body: { code: string }
 * Bestätigt die Einrichtung und liefert die Wiederherstellungscodes - einmalig,
 * im Klartext. Danach stehen sie nur noch als Hash in der Datenbank.
 */
router.post('/2fa/enable', requireAuth, csrfMiddleware, twoFactorLimiter, (req, res) => {
  try {
    const code = String(req.body?.code || '');
    if (code.length > 64) return res.status(400).json({ error: 'Input is too long.', code: 400 });

    const { recovery_codes: codes } = twoFactor.confirmSetup(db.get(), req.authUserId, code);

    // Alle anderen Sitzungen dieses Kontos beenden: wer den zweiten Faktor
    // einschaltet, will nicht, dass eine alte Anmeldung ohne ihn weiterläuft.
    invalidateUserSessions(req.authUserId, req.sessionID);

    res.json({ data: { recovery_codes: codes } });
  } catch (err) {
    if (err.code === 'invalid_code') {
      return res.status(400).json({ error: err.message, code: 400, reason: 'invalid_code' });
    }
    if (err.code === 'no_pending_setup' || err.code === 'already_enabled') {
      return res.status(409).json({ error: err.message, code: 409, reason: err.code });
    }
    log.error('2FA enable error:', err);
    res.status(500).json({ error: 'Internal server error.', code: 500 });
  }
});

/**
 * POST /api/v1/auth/2fa/disable
 * Body: { code: string }
 *
 * Verlangt einen gültigen zweiten Faktor, kein Passwort: gegen eine gekaperte
 * Sitzung hilft nur der Faktor selbst, und OIDC-Konten haben gar kein Passwort,
 * mit dem sie sich hier ausweisen könnten. Wer sein Gerät verloren hat, nimmt
 * einen Wiederherstellungscode.
 *
 * Verlangt der Haushalt die Zwei-Faktor-Anmeldung, ist Abschalten gesperrt.
 */
router.post('/2fa/disable', requireAuth, csrfMiddleware, twoFactorLimiter, (req, res) => {
  try {
    if (!twoFactor.isEnabled(db.get(), req.authUserId)) {
      return res.status(409).json({ error: 'Two-factor authentication is not enabled.', code: 409, reason: 'not_enabled' });
    }
    if (twoFactor.isRequiredForHousehold(db.get())) {
      return res.status(403).json({ error: 'Two-factor authentication is required for this household.', code: 403, reason: 'required' });
    }

    const code = String(req.body?.code || '');
    if (code.length > 64) return res.status(400).json({ error: 'Input is too long.', code: 400 });

    const result = twoFactor.verifySecondFactor(db.get(), req.authUserId, code);
    if (!result.valid) {
      log.warn('2FA disable rejected', { ip: req.ip, userId: req.authUserId });
      return res.status(400).json({ error: 'Invalid code.', code: 400, reason: 'invalid_code' });
    }

    twoFactor.disable(db.get(), req.authUserId);
    res.json({ data: twoFactor.getStatus(db.get(), req.authUserId) });
  } catch (err) {
    log.error('2FA disable error:', err);
    res.status(500).json({ error: 'Internal server error.', code: 500 });
  }
});

/**
 * POST /api/v1/auth/2fa/recovery-codes
 * Body: { code: string }
 * Wirft alle bisherigen Wiederherstellungscodes weg und liefert einen neuen
 * Satz. Auch das verlangt den zweiten Faktor.
 */
router.post('/2fa/recovery-codes', requireAuth, csrfMiddleware, twoFactorLimiter, (req, res) => {
  try {
    if (!twoFactor.isEnabled(db.get(), req.authUserId)) {
      return res.status(409).json({ error: 'Two-factor authentication is not enabled.', code: 409, reason: 'not_enabled' });
    }
    const code = String(req.body?.code || '');
    if (code.length > 64) return res.status(400).json({ error: 'Input is too long.', code: 400 });

    const result = twoFactor.verifySecondFactor(db.get(), req.authUserId, code);
    if (!result.valid) {
      return res.status(400).json({ error: 'Invalid code.', code: 400, reason: 'invalid_code' });
    }

    const { recovery_codes: codes } = twoFactor.regenerateRecoveryCodes(db.get(), req.authUserId);
    res.json({ data: { recovery_codes: codes } });
  } catch (err) {
    log.error('2FA recovery codes error:', err);
    res.status(500).json({ error: 'Internal server error.', code: 500 });
  }
});

/**
 * GET /api/v1/auth/2fa/overview
 * Wer im Haushalt hat den zweiten Faktor eingerichtet.
 *
 * Bewusst eine eigene Admin-Route und nicht ein Feld an /auth/users: das liest
 * jedes Mitglied, und wer welchen Schutz hat, ist keine Angabe fuer alle.
 */
router.get('/2fa/overview', requireAuth, requireAdmin, (_req, res) => {
  try {
    res.json({ data: twoFactor.householdOverview(db.get()), required: twoFactor.isRequiredForHousehold(db.get()) });
  } catch (err) {
    log.error('2FA overview error:', err);
    res.status(500).json({ error: 'Internal server error.', code: 500 });
  }
});

/**
 * PUT /api/v1/auth/2fa/require
 * Body: { required: boolean }
 * Schaltet die haushaltsweite Pflicht ein oder aus.
 *
 * Bewusst eine eigene Route mit `requireAdmin` als MIDDLEWARE und kein Feld an
 * `PUT /preferences`. Dort läge die Rechteprüfung als `if`-Zweig im Handler,
 * wie bei Zeitzone und Sprache - für eine Anzeige-Einstellung tragbar, für die
 * Frage, wer die Zwei-Faktor-Pflicht setzen darf, nicht. Der Settings-Guard
 * (`test-settings-admin-gate.js`) sieht genau diesen Unterschied und hat den
 * ersten Anlauf zu Recht abgewiesen: eine Berechtigungsregel, die in einem
 * Feld-Zweig wohnt, ist von außen nicht als solche zu erkennen.
 *
 * Die Pflicht sperrt niemanden aus. Sie verbietet das ABSCHALTEN und stellt
 * allen ohne zweiten Faktor einen Hinweis auf ihre Kontoseite. Eine Pflicht,
 * die bestehende Anmeldungen sofort abwiese, hätte in einem Haushalt ohne
 * eingerichtete Geräte genau eine Folge: niemand kommt mehr hinein, auch der
 * Admin nicht.
 */
router.put('/2fa/require', requireAuth, requireAdmin, csrfMiddleware, (req, res) => {
  try {
    const required = req.body?.required === true || req.body?.required === '1';
    twoFactor.setRequiredForHousehold(db.get(), required);
    log.info('Household two-factor requirement changed', { userId: req.authUserId, required });
    res.json({ data: { required: twoFactor.isRequiredForHousehold(db.get()) } });
  } catch (err) {
    log.error('2FA requirement error:', err);
    res.status(500).json({ error: 'Internal server error.', code: 500 });
  }
});

/**
 * GET /api/v1/auth/users
 * Listet alle Familienmitglieder (für Zuweisung in Kalender, Tasks etc.).
 * Response: { data: User[] }
 */
router.get('/users', requireAuth, (req, res) => {
  try {
    // is_worker markiert Konten der Haushaltshilfe (housekeeping_workers),
    // damit die Familien-Verwaltung sie nicht als Familienmitglied labelt
    // (Audit A2-25e). Muster wie der Worker-Ausschluss in routes/family.js.
    // Der Anmeldeweg eines fremden Kontos geht nur Administratoren etwas an -
    // siehe den Kommentar in publicUser (#847). Der Platzhalter wird gebunden
    // und nicht in die Query geschrieben, damit hier keine zusammengesetzte SQL
    // steht, der man erst ansehen muss, dass ihre Bestandteile konstant sind.
    //
    // `req.authRole` und NICHT `req.session.role`: `requireAuth` bedient beide
    // Anmeldearten und legt die geltende Rolle dort ab. Ein Admin-API-Token hat
    // gar keine Session und verloere das Feld; ein Mitglieds-Token neben einem
    // Admin-Cookie bekaeme es umgekehrt zu Unrecht. Jede andere Rollenpruefung
    // in dieser Datei fragt aus genau diesem Grund `authRole`.
    const isAdmin = req.authRole === 'admin';
    const users = isAdmin
      ? db.get().prepare(`
          SELECT ${USER_PUBLIC_COLUMNS},
                 EXISTS(SELECT 1 FROM housekeeping_workers hw WHERE hw.user_id = users.id) AS is_worker,
                 (password_hash = ?) AS sso_only
          FROM users
          ORDER BY display_name
        `).all(OIDC_PASSWORD_SENTINEL)
      : db.get().prepare(`
          SELECT ${USER_PUBLIC_COLUMNS},
                 EXISTS(SELECT 1 FROM housekeeping_workers hw WHERE hw.user_id = users.id) AS is_worker
          FROM users
          ORDER BY display_name
        `).all();
    res.json({ data: users.map(publicUser) });
  } catch (err) {
    log.error('Users error:', err);
    res.status(500).json({ error: 'Internal server error.', code: 500 });
  }
});

router.get('/api-tokens', requireAuth, requireAdmin, (req, res) => {
  try {
    const rows = db.get().prepare(`
      SELECT t.*, creator.display_name AS creator_name,
        subject.id AS effective_subject_user_id,
        subject.display_name AS subject_name
      FROM api_tokens t
      LEFT JOIN users creator ON creator.id = t.created_by
      LEFT JOIN users subject ON subject.id = COALESCE(t.subject_user_id, t.created_by)
      ORDER BY t.created_at DESC
    `).all();
    const subjects = db.get().prepare(`
      SELECT u.id, u.username, u.display_name
      FROM users u
      WHERE NOT EXISTS (
        SELECT 1 FROM split_expense_guest_users sg WHERE sg.user_id = u.id
      )
      ORDER BY u.display_name
    `).all();
    res.json({ data: rows.map(publicApiToken), subjects });
  } catch (err) {
    log.error('API token list error:', err);
    res.status(500).json({ error: 'Internal server error.', code: 500 });
  }
});

router.post('/api-tokens', requireAuth, requireAdmin, csrfMiddleware, (req, res) => {
  try {
    const name = String(req.body.name || '').trim();
    const expiresAt = req.body.expires_at ? String(req.body.expires_at).trim() : null;

    if (!name) return res.status(400).json({ error: 'Token name is required.', code: 400 });
    if (name.length > 100) return res.status(400).json({ error: 'Token name may be at most 100 characters long.', code: 400 });
    if (expiresAt && Number.isNaN(Date.parse(expiresAt))) {
      return res.status(400).json({ error: 'expires_at must be a valid ISO date/time.', code: 400 });
    }
    if (expiresAt && new Date(expiresAt).getTime() <= Date.now()) {
      return res.status(400).json({ error: 'Expiration date must be in the future.', code: 400 });
    }

    // scopes: fehlend/null → uneingeschränktes Token (Voll-Zugriff, Default wie bisher).
    // Explizit gesetzt → Least-Privilege-Allowlist; muss mind. einen gültigen Scope
    // enthalten, ungültige/unbekannte Einträge werden abgewiesen (kein stilles Verwerfen).
    let serializedScopes = null;
    if (req.body.scopes !== undefined && req.body.scopes !== null) {
      if (!Array.isArray(req.body.scopes)) {
        return res.status(400).json({ error: 'scopes must be an array of "module:read"/"module:write" strings.', code: 400 });
      }
      const normalized = normalizeScopes(req.body.scopes);
      if (normalized.length !== req.body.scopes.length) {
        return res.status(400).json({ error: 'scopes contains unknown or duplicate entries.', code: 400 });
      }
      if (normalized.length === 0) {
        return res.status(400).json({ error: 'Provide at least one scope, or omit scopes for full access.', code: 400 });
      }
      serializedScopes = serializeScopes(normalized);
    }

    const token = API_TOKEN_PREFIX + crypto.randomBytes(32).toString('base64url');
    const tokenHash = hashApiToken(token);
    const tokenPrefix = token.slice(0, 12);
    const normalizedExpiresAt = expiresAt ? new Date(expiresAt).toISOString() : null;
    let subjectUserId = req.authUserId;
    if (req.body.subject_user_id !== undefined && req.body.subject_user_id !== null) {
      subjectUserId = Number(req.body.subject_user_id);
      if (!Number.isSafeInteger(subjectUserId) || subjectUserId < 1) {
        return res.status(400).json({ error: 'subject_user_id must be a valid user ID.', code: 400 });
      }
    }
    const subject = db.get().prepare(`
      SELECT u.id,
        EXISTS(SELECT 1 FROM split_expense_guest_users sg WHERE sg.user_id = u.id) AS is_split_guest
      FROM users u WHERE u.id = ?
    `).get(subjectUserId);
    if (!subject) return res.status(400).json({ error: 'Token subject user was not found.', code: 400 });
    if (subject.is_split_guest) {
      return res.status(400).json({ error: 'A split-expense guest cannot be an API token subject.', code: 400 });
    }

    const result = db.get().prepare(`
      INSERT INTO api_tokens (name, token_hash, token_prefix, created_by, subject_user_id, expires_at, scopes)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(name, tokenHash, tokenPrefix, req.authUserId, subjectUserId, normalizedExpiresAt, serializedScopes);

    const row = db.get().prepare(`
      SELECT t.*, creator.display_name AS creator_name,
        subject.id AS effective_subject_user_id,
        subject.display_name AS subject_name
      FROM api_tokens t
      LEFT JOIN users creator ON creator.id = t.created_by
      LEFT JOIN users subject ON subject.id = COALESCE(t.subject_user_id, t.created_by)
      WHERE t.id = ?
    `).get(result.lastInsertRowid);

    res.status(201).json({ data: publicApiToken(row), token });
  } catch (err) {
    log.error('API token creation error:', err);
    res.status(500).json({ error: 'Internal server error.', code: 500 });
  }
});

router.delete('/api-tokens/:id', requireAuth, requireAdmin, csrfMiddleware, (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    if (!Number.isFinite(id)) return res.status(400).json({ error: 'Invalid token ID.', code: 400 });

    const result = db.get().prepare(`
      UPDATE api_tokens
      SET revoked_at = COALESCE(revoked_at, strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
      WHERE id = ?
    `).run(id);

    if (result.changes === 0) return res.status(404).json({ error: 'API token not found.', code: 404 });
    res.json({ ok: true });
  } catch (err) {
    log.error('API token revocation error:', err);
    res.status(500).json({ error: 'Internal server error.', code: 500 });
  }
});

/**
 * Liest ein Konto so, wie die Verwaltungsoberflaeche es braucht: oeffentliche
 * Felder PLUS `sso_only` (#847).
 *
 * Die Familienverwaltung uebernimmt die Antwort von POST/PATCH direkt in ihre
 * Mitgliederliste. Faehrt `sso_only` darin nicht mit, zeigt der Umschalter
 * unmittelbar nach dem Anlegen AUS, obwohl das Konto kein Passwort hat - und
 * die naechste beliebige Aenderung schickt `sso_only: false` mit, was der
 * Server ohne Passwort abweist. Der Fehler erschiene dann an einer Stelle, die
 * mit der Ursache nichts zu tun hat.
 *
 * Nur fuer die beiden Admin-Routen gedacht; `GET /users` entscheidet die
 * Sichtbarkeit selbst, weil es auch Nicht-Admins bedient.
 *
 * @param {number|bigint} userId
 * @returns {object|undefined}
 */
function adminUserRow(userId) {
  return db.get()
    .prepare(`SELECT ${USER_PUBLIC_COLUMNS}, (password_hash = ?) AS sso_only FROM users WHERE id = ?`)
    .get(OIDC_PASSWORD_SENTINEL, userId);
}

/**
 * Prueft, ob ein Konto ohne Passwort gefuehrt werden darf (#847).
 *
 * Zwei Bedingungen, beide aus demselben Grund - ein Konto ohne Passwort und
 * ohne SSO ist ein Konto, in das niemand hineinkommt:
 *
 * - OIDC muss konfiguriert sein. Sonst legte der Admin ein totes Konto an.
 * - Passwort und `sso_only` schliessen sich aus. Kaeme beides, muesste der
 *   Server raten, welches der beiden der Admin ernst gemeint hat.
 *
 * @param {boolean} ssoOnly
 * @param {string|undefined} password
 * @returns {string|null} Fehlermeldung oder null
 */
function assertSsoOnlyAllowed(ssoOnly, password, { linked = false, email = null, excludeUserId = null } = {}) {
  if (!ssoOnly) return null;
  if (!isOidcEnabled()) {
    return 'An account without a password requires OIDC to be configured.';
  }
  if (password) {
    return 'An account without a password cannot be given a password at the same time.';
  }
  // Ein Konto ohne Passwort muss auf einem Weg ERREICHBAR bleiben, und es gibt
  // genau zwei: es ist bereits mit dem Anbieter verknuepft, oder die erste
  // SSO-Anmeldung findet es. Letzteres laeuft ausschliesslich ueber eine
  // verifizierte E-Mail-Adresse - ein gleicher Benutzername verknuepft aus
  // gutem Grund NICHT (sonst naehme sich jeder, der sich im IdP "admin" nennt,
  // das lokale Admin-Konto). Ohne beides entstuende ein Konto, in das niemand
  // hineinkommt: mit OIDC_ALLOW_SIGNUP=false wird die Person abgewiesen, mit
  // Signup bekommt sie ein ZWEITES Konto und dieses bleibt leer zurueck.
  if (linked) return null;
  const address = String(email || '').trim();
  if (!address) {
    return 'An account without a password needs an email address, so the first SSO sign-in can link it.';
  }
  // Und sie muss dieses eine Konto meinen: `findOrCreateOidcUser` verknuepft
  // nur bei GENAU einem Treffer und laesst zwei Kandidaten unangetastet.
  //
  // Die Bedingung ist bewusst dieselbe wie dort - `lower()` UND die
  // Zweitadressen aus `contact_emails`. Eine engere Pruefung hier waere
  // schlimmer als keine: sie gaebe gruenes Licht fuer genau die Faelle, an
  // denen der Linker spaeter scheitert (andere Gross-/Kleinschreibung, oder
  // dieselbe Adresse als Zweitadresse eines anderen Mitglieds), und das Konto
  // stuende dann ohne Passwort und ohne Verknuepfung da.
  const clash = db.get().prepare(`
    SELECT 1
    FROM users u
    JOIN contacts c ON c.family_user_id = u.id
    LEFT JOIN contact_emails ce ON ce.contact_id = c.id
    WHERE u.id IS NOT ?
      AND u.oidc_sub IS NULL
      AND (lower(c.email) = lower(?) OR lower(ce.value) = lower(?))
    LIMIT 1
  `).get(excludeUserId, address, address);
  if (clash) {
    return 'This email address already belongs to another member, so SSO could not tell the accounts apart.';
  }
  return null;
}

/**
 * POST /api/v1/auth/users
 * Admin only. Erstellt neues Familienmitglied.
 * Body: { username, display_name, password?, sso_only?, avatar_color?, family_role?, system_admin? }
 * Response: { user: { id, username, display_name, avatar_color, role } }
 *
 * `sso_only: true` legt ein Konto ohne Passwort an (#847). Bis dahin musste ein
 * Admin, der ein Konto fuer einen SSO-Nutzer vorbereitet, ein Passwort
 * erfinden - und das erfundene Passwort blieb ein funktionierender Zugang.
 * Ausdruecklich ein eigenes Feld und nicht "Passwort weggelassen": ein
 * vergessenes Feld darf nie still ein Konto ohne Passwort ergeben.
 */
router.post('/users', requireAuth, requireAdmin, csrfMiddleware, async (req, res) => {
  try {
    const {
      username,
      display_name,
      password,
      sso_only,
      avatar_color = avatarColors[crypto.randomInt(avatarColors.length)],
      avatar_data,
      family_role = 'other',
      system_admin = req.body.role === 'admin',
    } = req.body;
    const role = system_admin === true || system_admin === 'true' ? 'admin' : 'member';
    const ssoOnly = sso_only === true || sso_only === 'true';

    if (!username || !display_name || (!ssoOnly && !password)) {
      return res.status(400).json({ error: 'Username, display name, and password are required.', code: 400 });
    }

    if (!ssoOnly && normalizePassword(password).length < 8) {
      return res.status(400).json({ error: 'Password must be at least 8 characters long.', code: 400 });
    }

    if (!/^[a-zA-Z0-9._-]{3,64}$/.test(username)) {
      return res.status(400).json({ error: 'Username must be 3-64 characters long and may only contain letters, numbers, dots, hyphens, and underscores.', code: 400 });
    }

    if (display_name.length > 128) {
      return res.status(400).json({ error: 'Display name may be at most 128 characters long.', code: 400 });
    }

    if (!FAMILY_ROLES.includes(family_role)) {
      return res.status(400).json({ error: 'Invalid family role.', code: 400 });
    }

    const normalizedAvatarData = normalizeAvatarData(avatar_data);
    if (normalizedAvatarData?.error) {
      return res.status(400).json({ error: normalizedAvatarData.error, code: 400 });
    }
    const memberFields = validateMemberProfileFields(req.body);
    if (memberFields.errors.length) {
      return res.status(400).json({ error: memberFields.errors.join(' '), code: 400 });
    }

    // Erst hier, weil die Pruefung die E-Mail braucht: ein neues Konto ist noch
    // mit nichts verknuepft, also ist die Adresse sein einziger Weg hinein.
    const ssoOnlyError = assertSsoOnlyAllowed(ssoOnly, password, { email: memberFields.values.email });
    if (ssoOnlyError) return res.status(400).json({ error: ssoOnlyError, code: 400 });

    const hash = ssoOnly ? OIDC_PASSWORD_SENTINEL : await hashPassword(password);

    const result = db.transaction(() => {
      const created = db.get()
        .prepare(`
          INSERT INTO users (username, display_name, password_hash, avatar_color, avatar_data, role, family_role)
          VALUES (?, ?, ?, ?, ?, ?, ?)
        `)
        .run(username, display_name, hash, avatar_color, normalizedAvatarData ?? null, role, family_role);
      syncFamilyMemberArtifacts(db.get(), created.lastInsertRowid, {
        displayName: display_name,
        phone: memberFields.values.phone,
        email: memberFields.values.email,
        birthDate: memberFields.values.birth_date,
        avatarData: normalizedAvatarData ?? null,
        actorUserId: req.authUserId,
      });
      return created;
    });

    const createdUser = adminUserRow(result.lastInsertRowid);

    res.status(201).json({
      user: publicUser(createdUser),
    });
  } catch (err) {
    if (err.message && err.message.includes('UNIQUE constraint')) {
      return res.status(409).json({ error: 'Username is already taken.', code: 409 });
    }
    log.error('User creation error:', err);
    res.status(500).json({ error: 'Internal server error.', code: 500 });
  }
});

/**
 * PATCH /api/v1/auth/users/:id
 * Admin only. Updates a family member profile, system-admin flag, and
 * optionally resets the member's password (e.g. when they forgot it and
 * have no working email for the self-service reset flow).
 *
 * `sso_only` schaltet ein bestehendes Konto zwischen "hat ein Passwort" und
 * "kommt nur per SSO herein" um (#847). Damit ist das Entfernen eines Passworts
 * eine Entscheidung pro Konto, die der Admin ausdruecklich trifft - und keine
 * Nebenwirkung einer Umgebungsvariablen, die beim Zuruecksetzen stillschweigend
 * jedes Passwort im Haushalt geloescht haette.
 */
router.patch('/users/:id', requireAuth, requireAdmin, csrfMiddleware, async (req, res) => {
  try {
    const userId = parseInt(req.params.id, 10);
    if (!Number.isFinite(userId)) return res.status(400).json({ error: 'Invalid user ID.', code: 400 });

    const existing = db.get().prepare(`SELECT ${USER_PUBLIC_COLUMNS} FROM users WHERE id = ?`).get(userId);
    if (!existing) return res.status(404).json({ error: 'User not found.', code: 404 });

    const username = req.body.username !== undefined ? String(req.body.username || '').trim() : existing.username;
    const displayName = req.body.display_name !== undefined ? String(req.body.display_name || '').trim() : existing.display_name;
    const avatarColor = req.body.avatar_color !== undefined ? String(req.body.avatar_color || '').trim() : existing.avatar_color;
    const familyRole = req.body.family_role !== undefined ? String(req.body.family_role || '').trim() : existing.family_role;
    const nextRole = req.body.system_admin !== undefined
      ? (req.body.system_admin === true || req.body.system_admin === 'true' ? 'admin' : 'member')
      : existing.role;
    const avatarData = req.body.avatar_data !== undefined
      ? normalizeAvatarData(req.body.avatar_data)
      : existing.avatar_data;

    if (!username || !displayName) {
      return res.status(400).json({ error: 'Username and display name are required.', code: 400 });
    }
    if (!/^[a-zA-Z0-9._-]{3,64}$/.test(username)) {
      return res.status(400).json({ error: 'Username must be 3-64 characters long and may only contain letters, numbers, dots, hyphens, and underscores.', code: 400 });
    }
    if (displayName.length > 128) {
      return res.status(400).json({ error: 'Display name may be at most 128 characters long.', code: 400 });
    }
    if (!FAMILY_ROLES.includes(familyRole)) {
      return res.status(400).json({ error: 'Invalid family role.', code: 400 });
    }
    if (avatarData?.error) {
      return res.status(400).json({ error: avatarData.error, code: 400 });
    }
    const memberFields = validateMemberProfileFields(req.body);
    if (memberFields.errors.length) {
      return res.status(400).json({ error: memberFields.errors.join(' '), code: 400 });
    }

    const newPassword = req.body.password !== undefined ? String(req.body.password) : '';
    if (newPassword && normalizePassword(newPassword).length < 8) {
      return res.status(400).json({ error: 'Password must be at least 8 characters long.', code: 400 });
    }

    // undefined = unveraendert; nur ein mitgesendetes Feld schaltet um.
    const ssoOnly = req.body.sso_only !== undefined
      ? (req.body.sso_only === true || req.body.sso_only === 'true')
      : null;
    // Ein bereits verknuepftes Konto braucht keine E-Mail mehr - sein `sub`
    // findet es. Sonst zaehlt die Adresse, die nach diesem Aufruf gilt.
    const linkedRow = db.get().prepare('SELECT oidc_sub FROM users WHERE id = ?').get(userId);
    const effectiveEmail = memberFields.values.email !== undefined
      ? memberFields.values.email
      : existing.email;
    const ssoOnlyError = assertSsoOnlyAllowed(ssoOnly === true, newPassword, {
      linked: !!linkedRow?.oidc_sub,
      email: effectiveEmail,
      excludeUserId: userId,
    });
    if (ssoOnlyError) return res.status(400).json({ error: ssoOnlyError, code: 400 });

    // Zurueck zu "hat ein Passwort" geht nur MIT einem Passwort: sonst bliebe
    // der Platzhalter stehen und das Konto haette weder SSO-Pflicht noch einen
    // Zugang, den jemand kennt.
    const existingHash = db.get().prepare('SELECT password_hash FROM users WHERE id = ?').get(userId)?.password_hash;
    if (ssoOnly === false && isSsoOnlyAccount(existingHash) && !newPassword) {
      return res.status(400).json({ error: 'Turning off SSO-only requires setting a password.', code: 400 });
    }

    const adminError = assertAdminWouldRemain(userId, nextRole);
    if (adminError) return res.status(400).json({ error: adminError, code: 400 });

    // Dieselbe Frage fuer den SSO-Zustand: eine Herabstufung darf den Riegel
    // des Haushalts nicht nebenbei aufmachen (#847).
    const ssoAdminError = assertSsoAdminWouldRemain(userId, nextRole);
    if (ssoAdminError) return res.status(400).json({ error: ssoAdminError, code: 400 });

    // Nur ein echter UEBERGANG schreibt und meldet ab. Die Verwaltung schickt
    // den Umschalter bei JEDER Speicherung mit, also auch beim Aendern des
    // Namens oder der Farbe eines laengst SSO-gefuehrten Kontos - der Zweig
    // haette den Platzhalter dann erneut geschrieben und `invalidateUserSessions`
    // ausgeloest. Das Mitglied waere auf allen Geraeten abgemeldet worden, ohne
    // dass sich an seinem Zugang das Geringste geaendert hat.
    const alreadySsoOnly = isSsoOnlyAccount(existingHash);
    const newPasswordHash = (ssoOnly === true && !alreadySsoOnly)
      ? OIDC_PASSWORD_SENTINEL
      : (newPassword ? await hashPassword(newPassword) : null);

    db.transaction(() => {
      db.get().prepare(`
        UPDATE users
        SET username = ?, display_name = ?, avatar_color = ?, avatar_data = ?, role = ?, family_role = ?
        WHERE id = ?
      `).run(username, displayName, avatarColor || '#007AFF', avatarData ?? null, nextRole, familyRole, userId);

      if (newPasswordHash) {
        db.get().prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(newPasswordHash, userId);
      }

      syncFamilyMemberArtifacts(db.get(), userId, {
        displayName,
        phone: memberFields.values.phone,
        email: memberFields.values.email,
        birthDate: memberFields.values.birth_date,
        avatarData: avatarData ?? null,
        actorUserId: req.authUserId,
      });
    });

    if (newPasswordHash) {
      invalidateUserSessions(userId, req.sessionID);
    }

    if (nextRole !== existing.role) {
      updateUserRoleSessions(userId, nextRole);
      if (userId === req.authUserId && req.session) req.session.role = nextRole;
    }

    const updated = adminUserRow(userId);
    res.json({ user: publicUser(updated) });
  } catch (err) {
    if (err.message && err.message.includes('UNIQUE constraint')) {
      return res.status(409).json({ error: 'Username is already taken.', code: 409 });
    }
    log.error('User update error:', err);
    res.status(500).json({ error: 'Internal server error.', code: 500 });
  }
});

/**
 * PATCH /api/v1/auth/me/profile
 * Updates the current user's profile picture and basic profile fields.
 */
router.patch('/me/profile', requireAuth, csrfMiddleware, (req, res) => {
  try {
    const existing = db.get().prepare(`SELECT ${USER_PUBLIC_COLUMNS} FROM users WHERE id = ?`).get(req.authUserId);
    if (!existing) return res.status(404).json({ error: 'User not found.', code: 404 });

    const displayName = req.body.display_name !== undefined ? String(req.body.display_name || '').trim() : existing.display_name;
    const avatarColor = req.body.avatar_color !== undefined ? String(req.body.avatar_color || '').trim() : existing.avatar_color;
    const avatarData = req.body.avatar_data !== undefined
      ? normalizeAvatarData(req.body.avatar_data)
      : existing.avatar_data;
    const memberFields = validateMemberProfileFields(req.body);

    if (!displayName) return res.status(400).json({ error: 'Display name is required.', code: 400 });
    if (displayName.length > 128) {
      return res.status(400).json({ error: 'Display name may be at most 128 characters long.', code: 400 });
    }
    if (avatarData?.error) {
      return res.status(400).json({ error: avatarData.error, code: 400 });
    }
    if (memberFields.errors.length) {
      return res.status(400).json({ error: memberFields.errors.join(' '), code: 400 });
    }

    db.transaction(() => {
      db.get().prepare(`
        UPDATE users
        SET display_name = ?, avatar_color = ?, avatar_data = ?
        WHERE id = ?
      `).run(displayName, avatarColor || '#007AFF', avatarData ?? null, req.authUserId);
      syncFamilyMemberArtifacts(db.get(), req.authUserId, {
        displayName,
        phone: memberFields.values.phone,
        email: memberFields.values.email,
        birthDate: memberFields.values.birth_date,
        avatarData: avatarData ?? null,
        actorUserId: req.authUserId,
      });
    });

    const updated = db.get().prepare(`SELECT ${USER_PUBLIC_COLUMNS} FROM users WHERE id = ?`).get(req.authUserId);
    res.json({ user: publicUser(updated) });
  } catch (err) {
    log.error('Profile update error:', err);
    res.status(500).json({ error: 'Internal server error.', code: 500 });
  }
});

/**
 * PATCH /api/v1/auth/me/password
 * Ändert das eigene Passwort.
 * Body: { current_password: string, new_password: string }
 * Response: { ok: true }
 */
router.patch('/me/password', requireAuth, csrfMiddleware, async (req, res) => {
  try {
    const { current_password, new_password } = req.body;

    if (!current_password || !new_password) {
      return res.status(400).json({ error: 'Current and new password are required.', code: 400 });
    }
    if (normalizePassword(new_password).length < 8) {
      return res.status(400).json({ error: 'New password must be at least 8 characters long.', code: 400 });
    }

    const user = db.get().prepare('SELECT password_hash FROM users WHERE id = ?').get(req.authUserId);
    if (!user) return res.status(404).json({ error: 'User not found.', code: 404 });

    const { valid } = await verifyPassword(current_password, user.password_hash);
    if (!valid) return res.status(401).json({ error: 'Current password is incorrect.', code: 401 });

    const hash = await hashPassword(new_password);
    db.get().prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(hash, req.authUserId);

    invalidateUserSessions(req.authUserId, req.sessionID);

    res.json({ ok: true });
  } catch (err) {
    log.error('Password change error:', err);
    res.status(500).json({ error: 'Internal server error.', code: 500 });
  }
});

/**
 * DELETE /api/v1/auth/users/:id
 * Admin only. Löscht ein Familienmitglied.
 * Response: { ok: true }
 */
router.delete('/users/:id', requireAuth, requireAdmin, csrfMiddleware, (req, res) => {
  try {
    const userId = parseInt(req.params.id, 10);

    if (userId === req.authUserId) {
      return res.status(400).json({ error: 'You cannot delete your own account.', code: 400 });
    }

    // Der dritte Weg, auf dem der letzte SSO-Administrator verschwinden kann
    // (#847). `null` = das Konto bleibt gar keine Rolle uebrig.
    const ssoAdminError = assertSsoAdminWouldRemain(userId, null);
    if (ssoAdminError) return res.status(400).json({ error: ssoAdminError, code: 400 });

    const result = db.transaction(() => {
      const birthday = db.get().prepare('SELECT * FROM birthdays WHERE family_user_id = ?').get(userId);
      if (birthday) deleteBirthdayArtifacts(db.get(), birthday);
      // Standard-Zuweisungen von Sync-Zielen lösen (kein FK auf diesen Spalten, #459).
      db.get().prepare('UPDATE ics_subscriptions SET default_assignee_user_id = NULL WHERE default_assignee_user_id = ?').run(userId);
      db.get().prepare('UPDATE external_calendars SET default_assignee_user_id = NULL WHERE default_assignee_user_id = ?').run(userId);
      // Schichtplan (Migration 189): schedule_patterns→pattern_days, schedule_overrides
      // und schedule_extra_shifts kaskadieren gleich mit weg (FK CASCADE auf user_id),
      // ihre schedule_custom_field_values-Zeilen nicht - polymorph, kein echter
      // Fremdschluessel. Deshalb hier vorab entfernt, solange die Ids noch auffindbar
      // sind, sonst blieben sie als verwaiste Zeilen unter fremder Bedeutung liegen.
      const patternIds = db.get().prepare('SELECT id FROM schedule_patterns WHERE user_id = ?').all(userId).map((row) => row.id);
      if (patternIds.length) {
        const dayIds = db.get().prepare(`SELECT id FROM schedule_pattern_days WHERE pattern_id IN (${patternIds.map(() => '?').join(',')})`).all(...patternIds).map((row) => row.id);
        if (dayIds.length) db.get().prepare(`DELETE FROM schedule_custom_field_values WHERE entry_type='pattern_day' AND entry_id IN (${dayIds.map(() => '?').join(',')})`).run(...dayIds);
      }
      db.get().prepare(`DELETE FROM schedule_custom_field_values WHERE entry_type='override' AND entry_id IN (SELECT id FROM schedule_overrides WHERE user_id=?)`).run(userId);
      db.get().prepare(`DELETE FROM schedule_custom_field_values WHERE entry_type='extra_shift' AND entry_id IN (SELECT id FROM schedule_extra_shifts WHERE user_id=?)`).run(userId);
      return db.get().prepare('DELETE FROM users WHERE id = ?').run(userId);
    });

    if (result.changes === 0) {
      return res.status(404).json({ error: 'User not found.', code: 404 });
    }

    // Alle aktiven Sessions des geloeschten Users invalidieren
    const allSessions = db.get().prepare('SELECT sid, sess FROM sessions').all();
    for (const row of allSessions) {
      try {
        const sess = JSON.parse(row.sess);
        if (sess.userId === userId) {
          db.get().prepare('DELETE FROM sessions WHERE sid = ?').run(row.sid);
        }
      } catch { /* ignore malformed session */ }
    }

    res.json({ ok: true });
  } catch (err) {
    log.error('User deletion error:', err);
    res.status(500).json({ error: 'Internal server error.', code: 500 });
  }
});

setInterval(() => {
  try { defaultResetService.cleanupExpired(); } catch { /* best effort */ }
  // Abgelaufene, nie eingelöste Einladungen gehören in denselben Lauf.
  // Eingelöste bleiben liegen, sie sind die Spur "wer hat wen eingeladen".
  try { defaultInviteService.cleanupExpired(); } catch { /* best effort */ }
}, 60 * 60_000).unref();

export { router, sessionMiddleware, requireAuth, requireAdmin, syncFamilyMemberArtifacts, normalizeAvatarData };
