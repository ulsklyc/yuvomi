/**
 * Modul: Authentifizierung (Auth)
 * Zweck: Login-Route, Session-Middleware, Auth-Guard für geschützte Routen
 * Abhängigkeiten: express, bcrypt, express-session, server/db.js
 */

import express from 'express';
import bcrypt from 'bcrypt';
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

const log = createLogger('Auth');
const router = express.Router();
const API_TOKEN_PREFIX = 'oikos_';
const FAMILY_ROLES = ['dad', 'mom', 'parent', 'child', 'grandparent', 'relative', 'other'];
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

const sessionMiddleware = session({
  store: sessionStore,
  secret: process.env.SESSION_SECRET,
  resave: false,
  saveUninitialized: false,
  name: 'oikos.sid',
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

function hashApiToken(token) {
  return crypto.createHash('sha256').update(token, 'utf8').digest('hex');
}

function extractApiToken(req) {
  const auth = req.headers.authorization || '';
  if (auth.toLowerCase().startsWith('bearer ')) return auth.slice(7).trim();
  return String(req.headers['x-api-key'] || '').trim();
}

function publicApiToken(row) {
  return {
    id: row.id,
    name: row.name,
    token_prefix: row.token_prefix,
    created_by: row.created_by,
    creator_name: row.creator_name,
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

function authenticateApiToken(req) {
  const token = extractApiToken(req);
  if (!token) return null;

  const tokenHash = hashApiToken(token);
  const row = db.get().prepare(`
    SELECT t.*, u.role, u.username, u.display_name, u.avatar_color, u.avatar_data, u.family_role
    FROM api_tokens t
    JOIN users u ON u.id = t.created_by
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
    id: row.created_by,
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

/**
 * Prüft ob der Request authentifiziert ist.
 * Schützt alle API-Routen außer /auth/login.
 */
function requireAuth(req, res, next) {
  const apiToken = authenticateApiToken(req);
  if (apiToken) {
    req.authMethod = 'api_token';
    req.authUserId = apiToken.created_by;
    req.authRole = apiToken.role;
    return next();
  }

  if (req.session && req.session.userId) {
    req.authMethod = 'session';
    req.authUserId = req.session.userId;
    req.authRole = req.session.role;
    return next();
  }
  res.status(401).json({ error: 'Not authenticated.', code: 401 });
}

/**
 * Prüft ob der authentifizierte User Admin-Rolle hat.
 */
function requireAdmin(req, res, next) {
  if (req.authRole === 'admin') {
    return next();
  }
  res.status(403).json({ error: 'Permission denied.', code: 403 });
}

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
 * @param {import('better-sqlite3').Database} database
 * @param {{ sub: string, email?: string, email_verified?: boolean, name?: string, preferred_username?: string }} claims
 * @returns {{ id: number, role: string, [key: string]: any }}
 */
export function findOrCreateOidcUser(database, claims) {
  const { sub, email, email_verified, name, preferred_username } = claims;

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
      ).run(sub, process.env.OIDC_ISSUER ?? null, matches[0].id);
      return database.prepare('SELECT * FROM users WHERE id = ?').get(matches[0].id);
    }
  }

  // 3. Eindeutigen username ableiten (Kollision mit bestehenden Usernamen vermeiden)
  const base = (preferred_username || email || `oidc-${sub}`).slice(0, 64);
  let username = base;
  for (let n = 1; database.prepare('SELECT 1 FROM users WHERE username = ?').get(username); n++) {
    const suffix = `-${n}`;
    username = base.slice(0, 64 - suffix.length) + suffix;
  }

  const display_name = (name || preferred_username || email || username).slice(0, 128);
  const avatar_color = avatarColors[Math.floor(Math.random() * avatarColors.length)];

  // oidc_provider = Issuer-URL (zukunftssicher für mehrere Provider)
  const result = database.prepare(`
    INSERT INTO users (username, display_name, password_hash, avatar_color, role, oidc_sub, oidc_provider)
    VALUES (?, ?, '$oidc$', ?, 'member', ?, ?)
  `).run(username, display_name, avatar_color, sub, process.env.OIDC_ISSUER ?? null);

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
      // Timing-Attack-Schutz: trotzdem bcrypt ausführen
      await bcrypt.compare(password, '$2b$12$invalidhashfortimingprotection000000000000000000000');
      log.warn('Login failed', { ip: req.ip, username, reason: 'user_not_found' });
      return res.status(401).json({ error: 'Invalid credentials.', code: 401 });
    }

    const valid = await bcrypt.compare(password, user.password_hash);
    if (!valid) {
      log.warn('Login failed', { ip: req.ip, username, reason: 'invalid_password' });
      return res.status(401).json({ error: 'Invalid credentials.', code: 401 });
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
    res.clearCookie('oikos.sid');
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
      email:              userinfo.email,
      // email_verified kann je nach Provider im UserInfo oder im ID-Token stehen
      email_verified:     userinfo.email_verified ?? claims.email_verified,
      name:               userinfo.name,
      preferred_username: userinfo.preferred_username,
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
    if (password.length < 8) {
      return res.status(400).json({ error: 'Password must be at least 8 characters long.', code: 400 });
    }

    const avatarColor = avatarColors[Math.floor(Math.random() * avatarColors.length)];
    const hash = await bcrypt.hash(password, 12);

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
      return res.json({ user: publicUser(user) });
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

    res.json({ user: publicUser(user), csrfToken: req.session.csrfToken });
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
    const users = db.get()
      .prepare(`
        SELECT ${USER_PUBLIC_COLUMNS}
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
      SELECT t.*, u.display_name AS creator_name
      FROM api_tokens t
      LEFT JOIN users u ON u.id = t.created_by
      ORDER BY t.created_at DESC
    `).all();
    res.json({ data: rows.map(publicApiToken) });
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

    const token = API_TOKEN_PREFIX + crypto.randomBytes(32).toString('base64url');
    const tokenHash = hashApiToken(token);
    const tokenPrefix = token.slice(0, 12);
    const normalizedExpiresAt = expiresAt ? new Date(expiresAt).toISOString() : null;

    const result = db.get().prepare(`
      INSERT INTO api_tokens (name, token_hash, token_prefix, created_by, expires_at)
      VALUES (?, ?, ?, ?, ?)
    `).run(name, tokenHash, tokenPrefix, req.authUserId, normalizedExpiresAt);

    const row = db.get().prepare(`
      SELECT t.*, u.display_name AS creator_name
      FROM api_tokens t
      LEFT JOIN users u ON u.id = t.created_by
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

    if (password.length < 8) {
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

    const hash = await bcrypt.hash(password, 12);

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
 * Admin only. Updates a family member profile and system-admin flag.
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

    const adminError = assertAdminWouldRemain(userId, nextRole);
    if (adminError) return res.status(400).json({ error: adminError, code: 400 });

    db.transaction(() => {
      db.get().prepare(`
        UPDATE users
        SET username = ?, display_name = ?, avatar_color = ?, avatar_data = ?, role = ?, family_role = ?
        WHERE id = ?
      `).run(username, displayName, avatarColor || '#007AFF', avatarData ?? null, nextRole, familyRole, userId);

      syncFamilyMemberArtifacts(db.get(), userId, {
        displayName,
        phone: memberFields.values.phone,
        email: memberFields.values.email,
        birthDate: memberFields.values.birth_date,
        avatarData: avatarData ?? null,
        actorUserId: req.authUserId,
      });
    });

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
    if (new_password.length < 8) {
      return res.status(400).json({ error: 'New password must be at least 8 characters long.', code: 400 });
    }

    const user = db.get().prepare('SELECT password_hash FROM users WHERE id = ?').get(req.authUserId);
    if (!user) return res.status(404).json({ error: 'User not found.', code: 404 });

    const valid = await bcrypt.compare(current_password, user.password_hash);
    if (!valid) return res.status(401).json({ error: 'Current password is incorrect.', code: 401 });

    const hash = await bcrypt.hash(new_password, 12);
    db.get().prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(hash, req.authUserId);

    // Alle anderen Sessions dieses Users invalidieren (aktuelle behalten)
    const currentSid = req.sessionID;
    const allSessions = db.get().prepare('SELECT sid, sess FROM sessions').all();
    for (const row of allSessions) {
      if (row.sid === currentSid) continue;
      try {
        const sess = JSON.parse(row.sess);
        if (sess.userId === req.authUserId) {
          db.get().prepare('DELETE FROM sessions WHERE sid = ?').run(row.sid);
        }
      } catch { /* ignore malformed session */ }
    }

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

export { router, sessionMiddleware, requireAuth, requireAdmin, syncFamilyMemberArtifacts, normalizeAvatarData };
