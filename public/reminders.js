/**
 * Modul: Erinnerungen (Reminders)
 * Zweck: Clientseitiges Polling für fällige Erinnerungen, Browser-Benachrichtigungen,
 *        In-App-Toasts und Bell-Badge-Aktualisierung.
 * Abhängigkeiten: /api.js, /i18n.js
 */

import { api } from '/api.js';
import { t } from '/i18n.js';
import { isPushSubscribed } from '/push.js';

// --------------------------------------------------------
// Konfiguration
// --------------------------------------------------------

const POLL_INTERVAL_MS = 60_000; // 1 Minute

// --------------------------------------------------------
// Zustand
// --------------------------------------------------------

let _pollTimer     = null;
let _shownIds      = new Set(); // bereits angezeigte Reminder-IDs in dieser Session
let _isInitialized = false;

// --------------------------------------------------------
// Browser-Benachrichtigungen
// --------------------------------------------------------

/**
 * Aktuellen Benachrichtigungs-Permission-Status zurückgeben.
 * @returns {'granted'|'denied'|'default'|'unsupported'}
 */
function notificationStatus() {
  if (!('Notification' in window)) return 'unsupported';
  return Notification.permission;
}

/**
 * Browser-Benachrichtigung anfordern.
 * @returns {Promise<'granted'|'denied'|'default'>}
 */
async function requestPermission() {
  if (!('Notification' in window)) return 'unsupported';
  if (Notification.permission === 'granted') return 'granted';
  return Notification.requestPermission();
}

/**
 * Zeigt eine native Browser-Benachrichtigung an.
 * @param {string} title
 * @param {string} body
 */
function showBrowserNotification(title, body) {
  if (isPushSubscribed()) return; // Web Push übernimmt die System-Benachrichtigung
  if (!('Notification' in window) || Notification.permission !== 'granted') return;
  try {
    const n = new Notification(title, { body, icon: '/icons/icon-192.png' });
    setTimeout(() => n.close(), 8000);
  } catch {
    // Notification-API kann in bestimmten Kontexten fehlschlagen
  }
}

// --------------------------------------------------------
// Bell-Badge (Sidebar / Bottom-Nav)
// --------------------------------------------------------

/**
 * Aktualisiert den Badge-Zähler am Bell-Icon in der Navigation.
 * @param {number} count
 */
function updateBellBadge(count) {
  const navLabel = count > 0
    ? t(count === 1 ? 'reminders.pendingBadgeTitle' : 'reminders.pendingBadgeTitlePlural', { count })
    : t('nav.reminders');
  document.querySelectorAll('[data-route="/reminders"]').forEach((navItem) => {
    navItem.setAttribute('aria-label', navLabel);
  });
  document.querySelectorAll('.reminder-bell-badge').forEach((badge) => {
    if (count > 0) {
      badge.setAttribute('aria-hidden', 'true');
      badge.textContent = count > 9 ? '9+' : String(count);
      badge.hidden = false;
    } else {
      badge.hidden = true;
    }
  });
}

// --------------------------------------------------------
// SVG-Helfer (DOM-API, kein innerHTML)
// --------------------------------------------------------

function createBellSvg() {
  const NS  = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(NS, 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('fill', 'none');
  svg.setAttribute('stroke', 'currentColor');
  svg.setAttribute('stroke-width', '2');
  svg.setAttribute('width', '16');
  svg.setAttribute('height', '16');
  svg.setAttribute('aria-hidden', 'true');

  const path1 = document.createElementNS(NS, 'path');
  path1.setAttribute('d', 'M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9');
  const path2 = document.createElementNS(NS, 'path');
  path2.setAttribute('d', 'M13.73 21a2 2 0 0 1-3.46 0');

  svg.appendChild(path1);
  svg.appendChild(path2);
  return svg;
}

// --------------------------------------------------------
// Erinnerungen anzeigen
// --------------------------------------------------------

/**
 * Verarbeitet eine Liste fälliger Erinnerungen und zeigt Toast + Browser-Notification.
 * @param {Array} reminders
 */
function processReminders(reminders) {
  const newOnes = reminders.filter((r) => !_shownIds.has(r.id));
  if (!newOnes.length) return;

  newOnes.forEach((reminder) => {
    _shownIds.add(reminder.id);
    showReminderToast(reminder);
    showBrowserNotification(
      t('reminders.toastTitle'),
      reminder.entity_title || ''
    );
  });
}

/**
 * Zeigt einen persistenten Toast für eine Erinnerung mit Verwerfen-Button.
 * @param {{ id: number, entity_title: string }} reminder
 */
function showReminderToast(reminder) {
  const container = document.getElementById('toast-container');
  if (!container) return;

  const existing = container.querySelectorAll('.toast');
  if (existing.length >= 3) existing[0].remove();

  const toast = document.createElement('div');
  toast.className = 'toast toast--reminder';
  toast.setAttribute('role', 'alert');
  toast.dataset.reminderId = reminder.id;

  const iconWrap = document.createElement('span');
  iconWrap.className = 'toast__reminder-icon';
  iconWrap.setAttribute('aria-hidden', 'true');
  iconWrap.appendChild(createBellSvg());

  const textSpan = document.createElement('span');
  textSpan.className = 'toast__reminder-text';

  const titleEl = document.createElement('strong');
  titleEl.textContent = t('reminders.toastTitle');

  const sep = document.createTextNode(': ');

  const bodyEl = document.createElement('span');
  bodyEl.textContent = reminder.entity_title || '';

  textSpan.appendChild(titleEl);
  textSpan.appendChild(sep);
  textSpan.appendChild(bodyEl);

  const dismissBtn = document.createElement('button');
  dismissBtn.className = 'toast__undo';
  dismissBtn.textContent = t('reminders.dismiss');
  dismissBtn.addEventListener('click', () => {
    dismissReminder(reminder.id);
    toast.remove();
  });

  toast.appendChild(iconWrap);
  toast.appendChild(textSpan);
  toast.appendChild(dismissBtn);
  container.appendChild(toast);

  // Reminder-Toasts bleiben 30 Sekunden sichtbar
  const dismissTimer = setTimeout(() => {
    toast.classList.add('toast--out');
    toast.addEventListener('animationend', () => toast.remove(), { once: true });
  }, 30_000);

  toast.addEventListener('click', (e) => {
    if (e.target === dismissBtn) return;
    clearTimeout(dismissTimer);
    dismissReminder(reminder.id);
    toast.remove();
  });
}

// --------------------------------------------------------
// API-Aktionen
// --------------------------------------------------------

/**
 * Verwirft eine Erinnerung serverseitig.
 * @param {number} id
 */
async function dismissReminder(id) {
  try {
    await api.patch(`/reminders/${id}/dismiss`, {});
    _shownIds.delete(id);
  } catch {
    // Netzwerkfehler ignorieren
  }
}

/**
 * Lädt fällige Erinnerungen vom Server und verarbeitet sie.
 */
async function poll() {
  try {
    const data = await api.get('/reminders/pending');
    const reminders = data.data ?? [];
    updateBellBadge(reminders.length);
    processReminders(reminders);
  } catch {
    // Polling-Fehler ignorieren (kann Offline-Zustand sein)
  }
}

// --------------------------------------------------------
// Öffentliche API
// --------------------------------------------------------

/**
 * Startet das Reminder-Polling. Idempotent.
 */
function init() {
  if (_isInitialized) return;
  _isInitialized = true;
  poll();
  _pollTimer = setInterval(poll, POLL_INTERVAL_MS);
}

/**
 * Stoppt das Polling (z.B. nach Logout).
 */
function stop() {
  if (_pollTimer) {
    clearInterval(_pollTimer);
    _pollTimer = null;
  }
  _isInitialized = false;
  _shownIds.clear();
  updateBellBadge(0);
}

/**
 * Erzwingt sofortigen Poll (z.B. nach Erstellen einer Erinnerung).
 */
function refresh() {
  poll();
}

export { init, stop, refresh, requestPermission, notificationStatus };
