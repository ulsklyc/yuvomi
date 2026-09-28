/**
 * Modul: Web Push (Client)
 * Zweck: Push-Subscription verwalten und Status zwischenspeichern.
 * Abhängigkeiten: /api.js
 */
import { api } from '/api.js';

let _subscribedCache = false;

function urlBase64ToUint8Array(base64String) {
  const padding = '='.repeat((4 - (base64String.length % 4)) % 4);
  const base64 = (base64String + padding).replace(/-/g, '+').replace(/_/g, '/');
  const raw = atob(base64);
  const out = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
  return out;
}

function pushSupported() {
  return 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window;
}

/**
 * So lange wartet Push hoechstens auf einen aktiven Service Worker.
 *
 * `navigator.serviceWorker.ready` loest NIE auf, solange keine Registrierung
 * aktiv ist (Registrierung gescheitert oder blockiert, Proxy ohne SW). Ohne
 * Frist hing daran das Blatt Benachrichtigungen, an ihm die Einstellungs-Shell
 * und an der die Navigationssperre des Routers: danach wechselte kein Klick
 * mehr das Blatt (Re-Critique 2026-09-28, A7 P1-2).
 */
const SW_READY_TIMEOUT_MS = 3000;

/** `serviceWorker.ready` mit Frist; lehnt nach SW_READY_TIMEOUT_MS ab. */
function serviceWorkerReady() {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error('service-worker-unavailable')), SW_READY_TIMEOUT_MS);
  });
  return Promise.race([navigator.serviceWorker.ready, timeout]).finally(() => clearTimeout(timer));
}

/** Synchron gecachter Status (für reminders.js). */
function isPushSubscribed() {
  return _subscribedCache;
}

async function pushStatus() {
  if (!pushSupported()) {
    _subscribedCache = false;
    return { supported: false, permission: 'unsupported', subscribed: false };
  }
  let reg;
  try {
    reg = await serviceWorkerReady();
  } catch {
    // Der Browser kann Push, aber hier laeuft kein Service Worker: "nicht
    // verfuegbar" ist etwas anderes als "nicht unterstuetzt".
    _subscribedCache = false;
    return { supported: true, available: false, permission: Notification.permission, subscribed: false };
  }
  let subscribed = false;
  try {
    subscribed = Boolean(await reg.pushManager.getSubscription());
  } catch {
    subscribed = false;
  }
  _subscribedCache = subscribed;
  return { supported: true, available: true, permission: Notification.permission, subscribed };
}

async function enablePush() {
  if (!pushSupported()) throw new Error('unsupported');
  const permission = await Notification.requestPermission();
  if (permission !== 'granted') {
    _subscribedCache = false;
    return { subscribed: false, permission };
  }
  const reg = await serviceWorkerReady();
  const { data } = await api.get('/push/vapid-public-key');
  const sub = await reg.pushManager.subscribe({
    userVisibleOnly: true,
    applicationServerKey: urlBase64ToUint8Array(data.key),
  });
  await api.post('/push/subscribe', sub.toJSON());
  _subscribedCache = true;
  return { subscribed: true, permission };
}

async function disablePush() {
  if (!pushSupported()) return { subscribed: false };
  const reg = await serviceWorkerReady();
  const sub = await reg.pushManager.getSubscription();
  if (sub) {
    await api.post('/push/unsubscribe', { endpoint: sub.endpoint });
    await sub.unsubscribe();
  }
  _subscribedCache = false;
  return { subscribed: false };
}

/** true, wenn das Abo mit genau diesem applicationServerKey erstellt wurde. */
function matchesServerKey(sub, serverKey) {
  const local = sub.options?.applicationServerKey;
  if (!local) return true; // Kein Vergleich möglich - Abo nicht wegwerfen.
  const bytes = new Uint8Array(local);
  if (bytes.length !== serverKey.length) return false;
  return bytes.every((b, i) => b === serverKey[i]);
}

/**
 * Lokales Abo erneut beim Server registrieren. `/push/subscribe` ist ein Upsert,
 * der Aufruf also idempotent. Heilt den Fall, dass der Server das Abo verloren hat
 * (410 vom Push-Dienst, DB-Restore, Gerätewechsel), der Browser es aber weiterhin
 * kennt - ohne Resync bleibt das Gerät still, obwohl der Schalter "aktiv" zeigt.
 */
async function resyncSubscription() {
  if (!pushSupported() || Notification.permission !== 'granted') return false;
  const reg = await serviceWorkerReady();
  const sub = await reg.pushManager.getSubscription();
  if (!sub) {
    _subscribedCache = false;
    return false;
  }
  await api.post('/push/subscribe', sub.toJSON());
  _subscribedCache = true;
  return true;
}

/**
 * Vollständige Reparatur nach erfolgloser Zustellung: legt das Abo neu an, wenn es
 * lokal fehlt oder auf einem anderen VAPID-Key läuft als der Server inzwischen nutzt
 * (z. B. nach DB-Restore ohne sync_config). Fragt nicht erneut nach der Berechtigung,
 * setzt eine bereits erteilte also voraus.
 */
async function repairPush() {
  if (!pushSupported() || Notification.permission !== 'granted') return false;
  const reg = await serviceWorkerReady();
  const { data } = await api.get('/push/vapid-public-key');
  const serverKey = urlBase64ToUint8Array(data.key);

  let sub = await reg.pushManager.getSubscription();
  if (sub && !matchesServerKey(sub, serverKey)) {
    // Abo auf altem Key: serverseitig abmelden, damit keine Karteileiche bleibt.
    try { await api.post('/push/unsubscribe', { endpoint: sub.endpoint }); } catch { /* egal */ }
    try { await sub.unsubscribe(); } catch { /* egal */ }
    sub = null;
  }
  if (!sub) {
    sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: serverKey });
  }
  await api.post('/push/subscribe', sub.toJSON());
  _subscribedCache = true;
  return true;
}

/** Beim App-Start einmal den Cache füllen und ein bestehendes Abo nachregistrieren. */
async function initPush() {
  try {
    const st = await pushStatus();
    if (st.subscribed) await resyncSubscription();
  } catch { /* ignore */ }
}

function stopPush() {
  _subscribedCache = false;
}

export {
  SW_READY_TIMEOUT_MS,
  pushSupported, pushStatus, isPushSubscribed, enablePush, disablePush,
  resyncSubscription, repairPush, initPush, stopPush,
};
