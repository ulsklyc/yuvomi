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

/** Synchron gecachter Status (für reminders.js). */
function isPushSubscribed() {
  return _subscribedCache;
}

async function pushStatus() {
  if (!pushSupported()) {
    _subscribedCache = false;
    return { supported: false, permission: 'unsupported', subscribed: false };
  }
  let subscribed = false;
  try {
    const reg = await navigator.serviceWorker.ready;
    subscribed = Boolean(await reg.pushManager.getSubscription());
  } catch {
    subscribed = false;
  }
  _subscribedCache = subscribed;
  return { supported: true, permission: Notification.permission, subscribed };
}

async function enablePush() {
  if (!pushSupported()) throw new Error('unsupported');
  const permission = await Notification.requestPermission();
  if (permission !== 'granted') {
    _subscribedCache = false;
    return { subscribed: false, permission };
  }
  const reg = await navigator.serviceWorker.ready;
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
  const reg = await navigator.serviceWorker.ready;
  const sub = await reg.pushManager.getSubscription();
  if (sub) {
    await api.post('/push/unsubscribe', { endpoint: sub.endpoint });
    await sub.unsubscribe();
  }
  _subscribedCache = false;
  return { subscribed: false };
}

/** Beim App-Start einmal den Cache füllen. */
async function initPush() {
  try { await pushStatus(); } catch { /* ignore */ }
}

function stopPush() {
  _subscribedCache = false;
}

export { pushSupported, pushStatus, isPushSubscribed, enablePush, disablePush, initPush, stopPush };
