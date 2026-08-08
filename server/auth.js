/**
 * Modul: Authentifizierung (Auth)
 * Zweck: Login-Route, Session-Middleware, Auth-Guard für geschützte Routen
 * Abhängigkeiten: express, express-session, server/db.js, server/utils/password.js
 */

import express from 'express';
import session from 'express-session';
import rateLimit from 'express-rate-limit';
import crypto from 'node:crypto';
import * as db from './db.js';
import { generateToken, csrfMiddleware } from './middleware/csrf.js';
import { collectErrors, date as validateDate, str, MAX_SHORT, MAX_TITLE } from './middleware/validate.js';
import { createLogger } from './logger.js';
import { deleteBirthdayArtifacts, syncBirthdayArtifacts } from './services/birthdays.js';
import * as oidcClient from 'openid-client';
import { isOidcEnabled, getConfig as getOidcConfig } from './services/oidc.js';
import { emailService as defaultEmailService } from './services/email.js';
import { passwordResetService as defaultResetService } from './services/password-reset.js';
import { inviteService as defaultInviteService } from './services/invites.js';
import { parseScopes, serializeScopes, normalizeScopes } from './scopes.js';
import { hashPassword, normalizePassword, verifyPassword } from './utils/password.js';
import { resolvePermissions, buildSessionModuleAccess, clientPermissions } from './permissions.js';
import { requireAdmin } from './middleware/require-admin.js';

const log = createLogger('Auth');
const router = express.Router();
// Präfix für NEUE API-Tokens. Bereits ausgegebene `oikos_`-Tokens bleiben gültig:
// validiert wird über den Hash des gesamten Tokens, nicht über den Präfix.
const API_TOKEN_PREFIX = 'yuvomi_';
const FAMILY_ROLES = ['dad', 'mom', 'parent', 'child', 'grandparent', 'relative', 'other'];
// Platzhalter-Hash für den Timing-Attack-Schutz beim Login unbekannter Benutzer.
const DUMMY_PASSWORD_HASH = '$2b$12$invalidhashfortimingprotection000000000000000000000';
const MAX_AVATAR_DATA_LENGTH = 768 * 1024;
const USER_PUBLIC_COLUMNS = `
  id,
  username,
  display_name,
  avatar_color,
  avatar_data,
  role,
  family_role,
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
    // Nur wenn die Query das Flag mitselektiert (GET /users); andere
    // publicUser-Pfade behalten ihre bisherige Feldmenge.
    ...(row.is_worker !== undefined && { is_worker: Boolean(row.is_worker) }),
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
 * @param {import('better-sqlite3-multiple-ciphers').Database} database
 * @param {{ sub: string, iss?: string, email?: string, email_verified?: boolean, name?: string, preferred_username?: string, username?: string }} claims
 * @returns {{ id: number, role: string, [key: string]: any }}
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

  // 3. Eindeutigen username ableiten (Kollision mit bestehenden Usernamen vermeiden).
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
    VALUES (?, ?, '$oidc$', ?, 'member', ?, ?)
  `).run(username, display_name, avatar_color, sub, provider);

  return database.prepare('SELECT * FROM users WHERE id = ?').get(result.lastInsertRowid);
}

// --------------------------------------------------------
// Routen
// --------------------------------------------------------

const avatarColors = ['#007AFF', '#34C759', '#FF9500', '#FF3B30', '#AF52DE', '#FF2D55'];

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

    try {
      await setupAuthSession(req, res, user);
      res.json({
        user: {
          id:           user.id,
          username:     user.username,
          display_name: user.display_name,
          avatar_color: user.avatar_color,
          avatar_data:  user.avatar_data,
          role:         user.role,
          family_role:  user.family_role,
          access_scope: db.get().prepare('SELECT 1 FROM split_expense_guest_users WHERE user_id = ?').get(user.id) ? 'split_guest' : 'family',
        },
        permissions: clientPermissions(db.get(), user),
        csrfToken: req.session.csrfToken,
      });
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

  function emailFor(userId) {
    const row = getDb().prepare(
      'SELECT email FROM contacts WHERE family_user_id = ? AND email IS NOT NULL AND email != \'\' LIMIT 1'
    ).get(userId);
    return row?.email ?? null;
  }

  targetRouter.post('/forgot-password', limiter, async (req, res) => {
    try {
      const { identifier } = req.body || {};
      const userId = resolveUser(identifier);
      // Anti-enumeration: identical response regardless of outcome.
      if (userId && emailService.isConfigured()) {
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

      if (username && !/^[a-zA-Z0-9._-]{3,64}$/.test(username)) {
        return res.status(400).json({ error: 'Username must be 3-64 characters long and may only contain letters, numbers, dots, hyphens, and underscores.', code: 400 });
      }
      if (displayName.length > 128) {
        return res.status(400).json({ error: 'Display name may be at most 128 characters long.', code: 400 });
      }
      if (!FAMILY_ROLES.includes(familyRole)) {
        return res.status(400).json({ error: 'Invalid family role.', code: 400 });
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

      const { token } = inviteService.createInvite({
        email: email || null,
        username: username || null,
        displayName: displayName || null,
        role,
        familyRole,
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
        data: { valid: true, display_name: invite.display_name, username: invite.username },
      });
    } catch (err) {
      log.error('Invite preview error:', err.message);
      res.status(500).json({ error: 'Internal server error.', code: 500 });
    }
  });

  targetRouter.post('/invites/accept', limiter, async (req, res) => {
    try {
      const { token, password } = req.body || {};
      if (!token || !password) {
        return res.status(400).json({ error: 'Token and password are required.', code: 400 });
      }
      if (normalizePassword(password).length < 8) {
        return res.status(400).json({ error: 'Password must be at least 8 characters long.', code: 400 });
      }
      const invite = inviteService.verifyToken(token);
      if (!invite) {
        return res.status(400).json({ error: 'Invalid or expired token.', code: 400 });
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

      const hash = await hashPassword(password);
      const avatarColor = avatarColors[crypto.randomInt(avatarColors.length)];

      const ACCEPT_LOST = Symbol('accept_lost');
      try {
        getDb().transaction(() => {
          const created = getDb().prepare(`
            INSERT INTO users (username, display_name, password_hash, avatar_color, role, family_role)
            VALUES (?, ?, ?, ?, ?, ?)
          `).run(username, displayName, hash, avatarColor, invite.role, invite.family_role);
          const newUserId = Number(created.lastInsertRowid);
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
 * Gibt zurück ob OIDC konfiguriert und aktiviert ist.
 * Response: { enabled: boolean }
 */
router.get('/oidc/config', (_req, res) => {
  res.json({ enabled: isOidcEnabled() });
});

/**
 * GET /api/v1/auth/oidc/start
 * Leitet den Browser zum OIDC-Provider weiter.
 * state + nonce + PKCE-code_verifier werden in der Session abgelegt (CSRF-,
 * Replay- und Code-Injection-Schutz) und im Callback einmalig verbraucht.
 */
router.get('/oidc/start', async (req, res) => {
  try {
    const config = await getOidcConfig();
    if (!config) {
      return res.status(404).json({ error: 'OIDC is not configured.', code: 404 });
    }

    const state         = oidcClient.randomState();
    const nonce         = oidcClient.randomNonce();
    const codeVerifier  = oidcClient.randomPKCECodeVerifier();
    const codeChallenge = await oidcClient.calculatePKCECodeChallenge(codeVerifier);

    req.session.oidc = { state, nonce, codeVerifier };

    await new Promise((resolve, reject) =>
      req.session.save(err => (err ? reject(err) : resolve()))
    );

    const authUrl = oidcClient.buildAuthorizationUrl(config, {
      redirect_uri:          process.env.OIDC_REDIRECT_URI,
      scope:                 'openid email profile',
      state,
      nonce,
      code_challenge:        codeChallenge,
      code_challenge_method: 'S256',
    });

    res.redirect(authUrl.href);
  } catch (err) {
    log.error('OIDC start error:', err);
    res.status(500).json({ error: 'OIDC initialization failed.', code: 500 });
  }
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
      return res.json({ user: publicUser(user), permissions: clientPermissions(db.get(), user) });
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

    res.json({ user: publicUser(user), permissions: clientPermissions(db.get(), user), csrfToken: req.session.csrfToken });
  } catch (err) {
    log.error('/me error:', err);
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
    const users = db.get()
      .prepare(`
        SELECT ${USER_PUBLIC_COLUMNS},
               EXISTS(SELECT 1 FROM housekeeping_workers hw WHERE hw.user_id = users.id) AS is_worker
        FROM users
        ORDER BY display_name
      `)
      .all();
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
 * POST /api/v1/auth/users
 * Admin only. Erstellt neues Familienmitglied.
 * Body: { username, display_name, password, avatar_color?, family_role?, system_admin? }
 * Response: { user: { id, username, display_name, avatar_color, role } }
 */
router.post('/users', requireAuth, requireAdmin, csrfMiddleware, async (req, res) => {
  try {
    const {
      username,
      display_name,
      password,
      avatar_color = avatarColors[crypto.randomInt(avatarColors.length)],
      avatar_data,
      family_role = 'other',
      system_admin = req.body.role === 'admin',
    } = req.body;
    const role = system_admin === true || system_admin === 'true' ? 'admin' : 'member';

    if (!username || !display_name || !password) {
      return res.status(400).json({ error: 'Username, display name, and password are required.', code: 400 });
    }

    if (normalizePassword(password).length < 8) {
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

    const hash = await hashPassword(password);

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

    const createdUser = db.get().prepare(`SELECT ${USER_PUBLIC_COLUMNS} FROM users WHERE id = ?`).get(result.lastInsertRowid);

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

    const adminError = assertAdminWouldRemain(userId, nextRole);
    if (adminError) return res.status(400).json({ error: adminError, code: 400 });

    const newPasswordHash = newPassword ? await hashPassword(newPassword) : null;

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

    const updated = db.get().prepare(`SELECT ${USER_PUBLIC_COLUMNS} FROM users WHERE id = ?`).get(userId);
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

    const result = db.transaction(() => {
      const birthday = db.get().prepare('SELECT * FROM birthdays WHERE family_user_id = ?').get(userId);
      if (birthday) deleteBirthdayArtifacts(db.get(), birthday);
      // Standard-Zuweisungen von Sync-Zielen lösen (kein FK auf diesen Spalten, #459).
      db.get().prepare('UPDATE ics_subscriptions SET default_assignee_user_id = NULL WHERE default_assignee_user_id = ?').run(userId);
      db.get().prepare('UPDATE external_calendars SET default_assignee_user_id = NULL WHERE default_assignee_user_id = ?').run(userId);
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
