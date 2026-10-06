/**
 * Modul: Push-Service
 * Zweck: VAPID-Schlüssel auflösen/persistieren und Web-Push-Nachrichten senden.
 * Abhängigkeiten: web-push, server/db.js
 */
import webpushDefault from 'web-push';
import * as dbModule from '../db.js';
import { createLogger } from '../logger.js';
import { isActiveAccount } from './household-members.js';

const log = createLogger('Push');

/**
 * Letzte Ausweich-Adresse für das VAPID-Subject. `example.com` ist per RFC 2606
 * reserviert und im DNS auflösbar - anders als das frühere `admin@localhost`,
 * das Apple ablehnt (siehe normalizeSubject).
 */
const FALLBACK_SUBJECT = 'mailto:admin@example.com';

const LOCAL_HOSTS = new Set(['localhost', 'localhost.localdomain', '127.0.0.1', '[::1]', '::1']);
const LOCAL_SUFFIXES = ['.local', '.localdomain', '.internal', '.lan', '.home', '.invalid'];

/** Nur der Host des Endpoints - der volle Endpoint enthält ein Geräte-Token. */
function pushHost(endpoint) {
  try {
    return new URL(endpoint).host;
  } catch {
    return 'unknown';
  }
}

/**
 * Ein Host, den ein Push-Dienst als erreichbar durchgehen lässt: benannte Domain
 * mit TLD, kein Loopback und keine reine LAN-Endung.
 */
function isRoutableHost(host) {
  if (!host) return false;
  const h = String(host).toLowerCase().replace(/\.$/, '');
  if (LOCAL_HOSTS.has(h)) return false;
  if (LOCAL_SUFFIXES.some((suffix) => h.endsWith(suffix))) return false;
  const dot = h.lastIndexOf('.');
  return dot > 0 && dot < h.length - 1;
}

/**
 * Prüft einen Subject-Kandidaten und gibt ihn normalisiert zurück, sonst null.
 *
 * Hintergrund: Apple (web.push.apple.com) validiert die `sub`-Claim des
 * VAPID-JWT strenger als FCM und Mozilla. Ein nicht routbarer Wert - allen voran
 * der frühere Default `mailto:admin@localhost` - wird mit `403 BadJwtToken`
 * abgewiesen, wodurch Push auf iOS/iPadOS komplett ausfällt, während dieselbe
 * Installation an Android problemlos ausliefert (Discussion #580).
 */
function normalizeSubject(raw) {
  if (!raw) return null;
  const value = String(raw).trim();
  if (!value) return null;

  if (value.toLowerCase().startsWith('mailto:')) {
    const address = value.slice('mailto:'.length).trim();
    const at = address.lastIndexOf('@');
    if (at <= 0) return null;
    return isRoutableHost(address.slice(at + 1)) ? `mailto:${address}` : null;
  }

  // Bloße Mailadresse ohne Schema akzeptieren - ein häufiger Konfigurationsfehler.
  if (!value.includes('://') && value.includes('@')) {
    return normalizeSubject(`mailto:${value}`);
  }

  try {
    const url = new URL(value);
    if (url.protocol !== 'https:' && url.protocol !== 'http:') return null;
    return isRoutableHost(url.hostname) ? url.origin : null;
  } catch {
    return null;
  }
}

export function createPushService({ db, webpush = webpushDefault } = {}) {
  const getDb = () => (db || dbModule.get());
  // ensureVapid() läuft bei jedem Versand - der Hinweis auf den Platzhalter soll
  // die Logs nicht fluten, aber nach einer Konfigurationsänderung wieder greifen.
  let lastWarnedSubject = null;

  function cfgGet(key) {
    const row = getDb().prepare('SELECT value FROM sync_config WHERE key = ?').get(key);
    return row?.value ?? null;
  }
  function cfgSet(key, value) {
    getDb().prepare(`
      INSERT INTO sync_config (key, value) VALUES (?, ?)
      ON CONFLICT(key) DO UPDATE SET value = excluded.value
    `).run(key, value);
  }

  function ensureVapid() {
    let pub  = process.env.VAPID_PUBLIC_KEY  || cfgGet('push_vapid_public');
    let priv = process.env.VAPID_PRIVATE_KEY || cfgGet('push_vapid_private');
    if (!pub || !priv) {
      const keys = webpush.generateVAPIDKeys();
      pub = keys.publicKey;
      priv = keys.privateKey;
      cfgSet('push_vapid_public', pub);
      cfgSet('push_vapid_private', priv);
    }
    const subject = resolveSubject();
    webpush.setVapidDetails(subject, pub, priv);
    return { publicKey: pub, privateKey: priv, subject };
  }

  /**
   * Erster routbarer Kandidat gewinnt: explizites Env, dann die Absenderadresse
   * aus den Mail-Einstellungen, dann die öffentliche Origin der Installation.
   * Greift keiner, bleibt nur der Platzhalter - mit Hinweis im Log, weil Apple
   * einen unbrauchbaren Wert stumm mit 403 quittiert.
   */
  function resolveSubject() {
    const candidates = [
      ['VAPID_SUBJECT', process.env.VAPID_SUBJECT],
      ['email_from_address', cfgGet('email_from_address')],
      ['BASE_URL', process.env.BASE_URL],
    ];

    for (const [source, raw] of candidates) {
      const subject = normalizeSubject(raw);
      if (subject) return subject;
      if (raw && String(raw).trim()) {
        log.warn(`Ignoring unusable VAPID subject from ${source} (not routable): ${String(raw).trim()}`);
      }
    }

    if (lastWarnedSubject !== FALLBACK_SUBJECT) {
      lastWarnedSubject = FALLBACK_SUBJECT;
      log.warn(
        `No routable VAPID subject configured, falling back to ${FALLBACK_SUBJECT}. `
        + 'Set VAPID_SUBJECT (mailto: address or https: origin) or BASE_URL - '
        + 'Apple rejects pushes signed with a non-routable subject.',
      );
    }
    return FALLBACK_SUBJECT;
  }

  function getPublicKey() {
    return ensureVapid().publicKey;
  }

  async function sendPushToUser(userId, payload) {
    // DER EINE ENGPASS FUER WEB PUSH: Erinnerungen, die Zuweisung einer Aufgabe
    // und die Medikamenten-Meldung enden alle hier. Ein ehemaliges Konto
    // bekommt nichts mehr (#1381) - auch nicht ueber ein Abo, das nach dem
    // Deaktivieren noch dasteht. Synchron vor dem ersten `await`.
    if (!isActiveAccount(userId, { db: getDb() })) return 0;
    const { subject } = ensureVapid();
    const subs = getDb().prepare('SELECT * FROM push_subscriptions WHERE user_id = ?').all(userId);
    let sent = 0;
    for (const sub of subs) {
      const subscription = { endpoint: sub.endpoint, keys: { p256dh: sub.p256dh, auth: sub.auth } };
      try {
        await webpush.sendNotification(subscription, JSON.stringify(payload));
        getDb().prepare('UPDATE push_subscriptions SET last_used_at = ? WHERE id = ?')
          .run(new Date().toISOString(), sub.id);
        sent += 1;
      } catch (err) {
        if (err && (err.statusCode === 404 || err.statusCode === 410)) {
          getDb().prepare('DELETE FROM push_subscriptions WHERE id = ?').run(sub.id);
          log.info(`Removed gone push subscription ${sub.id} (${pushHost(sub.endpoint)})`);
        } else {
          // Statuscode und Body des Push-Dienstes mitloggen - ohne sie ist ein
          // abgelehnter Push (z. B. Apple 403 BadJwtToken) nicht diagnostizierbar.
          // Bei einem abgewiesenen JWT ist fast immer das Subject die Ursache -
          // ohne den benutzten Wert im Log bleibt es beim ratlosen 403.
          const jwtRejected = err?.statusCode === 401 || err?.statusCode === 403;
          const parts = [
            `host=${pushHost(sub.endpoint)}`,
            err?.statusCode ? `status=${err.statusCode}` : null,
            err?.body ? `body=${String(err.body).slice(0, 300)}` : null,
            jwtRejected ? `sub=${subject}` : null,
          ].filter(Boolean);
          log.error(`Push send failed (${parts.join(' ')}):`, err?.message || err);
          if (jwtRejected) {
            log.error(
              'The push service rejected the VAPID token. Check that the subject above is a '
              + 'routable mailto: address or https: origin (set VAPID_SUBJECT or BASE_URL).',
            );
          }
        }
      }
    }
    return sent;
  }

  return { getPublicKey, sendPushToUser, ensureVapid };
}

export const pushService = createPushService();
