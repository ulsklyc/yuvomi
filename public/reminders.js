/**
 * Modul: Erinnerungen (Reminders)
 * Zweck: Clientseitiges Polling für fällige Erinnerungen, Browser-Benachrichtigungen,
 *        In-App-Toasts und Bell-Badge-Aktualisierung.
 * Abhängigkeiten: /api.js, /i18n.js
 */

import { api } from '/api.js';
import { t, formatDate } from '/i18n.js';
import { isPushSubscribed } from '/push.js';
import { moduleIconEl } from '/nav-icons.js';
import { toastSurface } from '/utils/toast-surface.js';

// --------------------------------------------------------
// Konfiguration
// --------------------------------------------------------

const POLL_INTERVAL_MS = 60_000; // 1 Minute

// Wie oft ein Poll kurz nachfassen darf, solange die Toast-Fläche der Shell noch
// nicht steht (Begründung in processReminders).
const MAX_DEFERRED_RETRIES = 5;

// --------------------------------------------------------
// Zustand
// --------------------------------------------------------

let _pollTimer     = null;
let _shownIds      = new Set(); // bereits angezeigte Reminder-IDs in dieser Session
let _isInitialized = false;
let _deferredRetries = 0;

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
 *
 * Ihr Titel nennt die HERKUNFT, nicht den App-Namen - dieselbe Antwort, die das
 * Siegel im Toast gibt, auf dem einzigen Kanal, der sie tragen kann: eine
 * Systembenachrichtigung hat kein DOM, ihr `icon` zeigt nur ein Teil der
 * Plattformen. Denselben Titel setzt der Server fuer den Push-Weg
 * (REMINDER_TITLE_KEYS in server/services/notifications.js); hier uebersetzt der
 * Client, der seine eigene Sprache kennt.
 *
 * @param {string} title
 * @param {string} body
 * @param {string|null} targetUrl
 */
function showBrowserNotification(title, body, targetUrl = null) {
  if (isPushSubscribed()) return; // Web Push übernimmt die System-Benachrichtigung
  if (!('Notification' in window) || Notification.permission !== 'granted') return;
  try {
    const n = new Notification(title, { body, icon: '/icons/icon-192.png' });
    if (typeof targetUrl === 'string' && targetUrl.startsWith('/') && !targetUrl.startsWith('//')) {
      n.onclick = () => {
        window.focus?.();
        window.yuvomi?.navigate(targetUrl);
        n.close();
      };
    }
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
// Herkunft einer Erinnerung (Markensiegel, Block 2)
// --------------------------------------------------------

/**
 * DIE ERINNERUNGEN SIND EINE MISCHSTELLE, und zwar die einzige, die den Nutzer
 * von sich aus anspricht: eine Meldung erscheint, ohne dass man den Raum
 * betreten hat, in dem sie entstanden ist. Genau dort ist die Herkunft nicht
 * selbstverstaendlich - also traegt jede Meldung ihr Siegel (Herkunfts-Regel,
 * .impeccable/block2-brief.md).
 *
 * ERHOBEN, NICHT GERATEN: durch `/reminders/pending` laufen genau die
 * `entity_type`-Werte aus `VALID_ENTITY_TYPES` (server/routes/reminders.js),
 * und jeder ist an seiner Schreibstelle im Server belegt. Zwei setzt der
 * Nutzer selbst (`task`, `event`), die uebrigen leitet ihr Modul ab:
 * subscriptions.js, inventory/items.js, inventory/item-dates.js und
 * services/pantry-reminders.js. Medikamente laufen NICHT hierueber.
 *
 * KEINE ZAHL MEHR AN DIESER STELLE: hier stand "exakt drei", waehrend die
 * Tabelle unten laengst mehr trug - dieselbe Drift, gegen die die Modulliste
 * in CLAUDE.md bewusst keine Zahl nennt. Die Vollstaendigkeit haelt ein Guard
 * in test/test-frontend-audit.js, nicht dieser Satz.
 *
 * GEBURTSTAGE SPRECHEN MIT DER STIMME DES KALENDERS, und das ist richtig:
 * `syncBirthdayReminder` (server/services/birthdays.js) haengt die Erinnerung an
 * den KALENDEREINTRAG des Geburtstags, nicht an den Geburtstag selbst. Die
 * Meldung zeigt damit die Herkunft, die die Zeile wirklich hat. Sie am `icon`
 * des Termins ('cake') zu erkennen waere ein Marker, der ungenauer schluesselt
 * als das Markierte - jeder Termin darf dieses Icon tragen.
 *
 * WER HIER FEHLT, FAELLT AUF DIE GLOCKE ZURUECK statt zu verschwinden: ein
 * kuenftiger `entity_type` zeigt den Erinnerungs-Ton und das Glocken-Zeichen,
 * bis er hier eingetragen ist.
 */
const REMINDER_ORIGINS = {
  task:                   { accent: 'var(--module-tasks)',     icon: 'check-square', labelKey: 'nav.tasks' },
  event:                  { accent: 'var(--module-calendar)',  icon: 'calendar',     labelKey: 'nav.calendar' },
  subscription:           { accent: 'var(--module-budget)',    icon: 'wallet',       labelKey: 'subscriptions.tabLabel' },
  inventory_item:         { accent: 'var(--module-inventory)', icon: 'package',      labelKey: 'nav.inventory' },
  inventory_tracked_date: { accent: 'var(--module-inventory)', icon: 'package',      labelKey: 'nav.inventory' },
  pantry_item:            { accent: 'var(--module-pantry)',    icon: 'archive',      labelKey: 'nav.pantry' },
  cycle_period:           { accent: 'var(--module-health)',    icon: 'droplet',      labelKey: 'health.cycle.title' },
  cycle_log_nudge:        { accent: 'var(--module-health)',    icon: 'droplet',      labelKey: 'health.cycle.title' },
  schedule_entry:         { accent: 'var(--module-schedule)',  icon: 'calendar-clock', labelKey: 'nav.schedule' },
  schedule_extra_entry:   { accent: 'var(--module-schedule)',  icon: 'calendar-clock', labelKey: 'nav.schedule' },
  waste_pickup:           { accent: 'var(--module-waste)',     icon: 'trash-2',      labelKey: 'nav.waste' },
  document_expiry:        { accent: 'var(--module-documents)', icon: 'calendar-clock', labelKey: 'nav.documents' },
  health_prevention_due:  { accent: 'var(--module-health)',    icon: 'syringe',      labelKey: 'health.tabs.prevention' },
  fasting_goal:            { accent: 'var(--module-health)',    icon: 'timer',         labelKey: 'health.fasting.title', url: '/health/fasting' },
  fasting_next_start:      { accent: 'var(--module-health)',    icon: 'timer',         labelKey: 'health.fasting.title', url: '/health/fasting' },
};

function reminderTargetUrl(reminder) {
  const target = reminder.target_url || REMINDER_ORIGINS[reminder.entity_type]?.url;
  return typeof target === 'string' && target.startsWith('/') && !target.startsWith('//') ? target : null;
}

function createOriginSeal(entityType) {
  const origin = REMINDER_ORIGINS[entityType];
  const seal = document.createElement('span');
  // Hier stand zusaetzlich `module-seal--vivid`: der Toast ist die eine
  // umgekehrte Flaeche der App und brauchte deshalb das Vollton-Gesicht. Es
  // ist seit 2026-08-17 das einzige, also steht es in der Basisregel.
  seal.className = 'module-seal module-seal--sm';
  seal.setAttribute('aria-hidden', 'true');
  seal.style.setProperty('--seal-accent', origin?.accent ?? 'var(--module-reminders)');
  // Der Fallback oben deckt einen unbekannten entity_type ab; ein Icon-Name
  // ohne eigenes Zeichen faellt in moduleIconEl still auf Lucide zurueck.
  seal.appendChild(origin?.icon ? moduleIconEl(origin.icon) : createBellSvg());
  return seal;
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

  let deferred = false;
  newOnes.forEach((reminder) => {
    // NUR MERKEN, WAS AUCH ERSCHIENEN IST.
    //
    // Vorher wanderte jede Erinnerung in `_shownIds`, BEVOR feststand, ob sie
    // eine Fläche gefunden hat. Beim ersten Laden gibt es die noch nicht:
    // `initReminders()` läuft im Auth-Guard von `navigate()`, die App-Shell mit
    // ihren Toast-Regionen entsteht ein paar hundert Zeilen später im SELBEN
    // Aufruf. Wer sich das Ungezeigte merkt, zeigt es nie wieder - die
    // Erinnerung war für diese Sitzung verbraucht, ohne je erschienen zu sein.
    if (!showReminderToast(reminder)) { deferred = true; return; }
    _shownIds.add(reminder.id);
    const labelKey = REMINDER_ORIGINS[reminder.entity_type]?.labelKey;
    showBrowserNotification(
      labelKey ? t(labelKey) : t('reminders.toastTitle'),
      reminderBody(reminder),
      reminderTargetUrl(reminder),
    );
  });

  // Die Fläche entsteht im selben Rendergang wie dieser Poll, also lohnt ein
  // kurzer zweiter Anlauf statt der vollen Minute bis zum nächsten Intervall.
  // Begrenzt, damit ein Zustand ohne Shell (Logout mitten im Poll) nicht in
  // eine Dauerschleife läuft; der reguläre Poll bleibt der Auffangweg.
  if (deferred && _deferredRetries < MAX_DEFERRED_RETRIES) {
    _deferredRetries += 1;
    setTimeout(poll, 500);
  } else if (!deferred) {
    _deferredRetries = 0;
  }
}

/**
 * Bei cycle_period/cycle_log_nudge ist entity_title das rohe anchor_date, kein
 * Name - "Zyklus" mit einem nackten Datum sagt nicht, ob die Periode erwartet
 * wird oder der heutige Tag noch nicht geloggt ist. Gleiche Korrektur wie
 * server/services/notifications.js#cycleBody für den Push-Body, hier mit der
 * Locale des Empfängers statt der Haushaltssprache, weil der Client sie kennt.
 *
 * PARTNER-ERINNERUNG: server/services/notifications.js#cycleBody
 * unterscheidet den Partner-Fall (ein ganzer Satz mit Name + Datum statt
 * "Nächste Periode") über `reminder.cycle_anchor_kind === 'partner_period'`.
 * `GET /reminders/pending` (server/routes/reminders.js) liefert dieselben
 * zwei Felder auch hier mit: `cycle_anchor_kind` (dieselben Anker-Arten wie
 * server/services/cycle-reminders.js, der Partner-Anker heisst
 * 'partner_period') und `cycle_owner_name` (nur bei 'partner_period'
 * gesetzt). Ein aelterer Server ohne dieses Feld liefert schlicht
 * `undefined` - dann bleibt es beim bisherigen (eigenen) Text, kein Absturz
 * auf einen fehlenden Namen.
 *
 * FEHLT DER NAME TROTZ 'partner_period': der Text darf dann
 * NICHT auf den eigenen "Nächste Periode"-Text zurueckfallen - das behauptet
 * faelschlich die eigene Periode der empfangenden Person. Ein neutraler
 * Platzhaltertext (`partnerNextPeriodNeutral`) nennt niemanden.
 * @returns {string|null} null für jede andere Erinnerungsart - Aufrufer fällt dann auf entity_title zurück.
 */
function cycleReminderBody(reminder) {
  if (reminder.entity_type === 'cycle_log_nudge') return t('health.cycle.settings.remindLogDaily');
  if (reminder.entity_type === 'cycle_period') {
    if (reminder.cycle_anchor_kind === 'partner_period') {
      if (reminder.cycle_owner_name) {
        return t('health.cycle.status.partnerNextPeriod', { name: reminder.cycle_owner_name, date: formatDate(reminder.entity_title) });
      }
      return `${t('health.cycle.status.partnerNextPeriodNeutral')} - ${reminder.entity_title}`;
    }
    return `${t('health.cycle.status.nextPeriod')} - ${reminder.entity_title}`;
  }
  // Nur die geerbte Zeile (assigned_from gesetzt) nennt die betreute Person -
  // server/services/notifications.js#preventionDueBody haelt denselben Riegel
  // fuer die Push-Benachrichtigung; ohne dieses Gegenstueck hier saehe der
  // In-App-Toast bei zwei betreuten Personen nur den Typnamen, ohne zu sagen,
  // fuer wen (Review #1256).
  if (reminder.entity_type === 'health_prevention_due' && reminder.assigned_from != null && reminder.prevention_subject_name) {
    return `${reminder.entity_title} - ${reminder.prevention_subject_name}`;
  }
  return null;
}

function fastingReminderBody(reminder) {
  if (reminder.entity_type === 'fasting_goal') return t('health.fasting.goalReached');
  if (reminder.entity_type === 'fasting_next_start') return t('health.fasting.remindNext');
  return null;
}

function reminderBody(reminder) {
  return fastingReminderBody(reminder) ?? cycleReminderBody(reminder) ?? reminder.entity_title ?? '';
}

/**
 * Zeigt einen persistenten Toast für eine Erinnerung mit Verwerfen-Button.
 * @param {{ id: number, entity_type: string, entity_title: string }} reminder
 * @returns {boolean} ob der Toast tatsächlich angehängt wurde
 */
function showReminderToast(reminder) {
  // Höflich, nicht bestimmend: die bestimmte Live-Region gehört den Meldungen,
  // die eine laufende Vorlesung unterbrechen dürfen (Fehler, Warnungen) -
  // dieselbe Zuordnung, die auch `showToast` in der Shell trifft.
  const container = toastSurface('polite');
  if (!container) return false;

  const existing = container.querySelectorAll('.toast');
  if (existing.length >= 3) existing[0].remove();

  const toast = document.createElement('div');
  toast.className = 'toast toast--reminder';
  toast.setAttribute('role', 'alert');
  toast.dataset.reminderId = reminder.id;

  const seal = createOriginSeal(reminder.entity_type);

  const targetUrl = reminderTargetUrl(reminder);
  const textBlock = document.createElement('button');
  textBlock.className = 'toast__reminder-text';
  textBlock.setAttribute('type', 'button');

  const titleEl = document.createElement('strong');
  titleEl.textContent = t('reminders.toastTitle');

  const bodyEl = document.createElement('span');
  bodyEl.textContent = reminderBody(reminder);

  // KEIN DOPPELPUNKT MEHR ZWISCHEN BEIDEN. Er stammt aus einer einzeiligen
  // Fassung („Erinnerung: Zahnarzttermin"); der Textblock ist längst eine
  // Spalte (`flex-direction: column`), und ein Textknoten in einer Spalte ist
  // ein eigenes Flex-Item - der Doppelpunkt stand als eigene Zeile zwischen
  // Versal-Label und Titel. Ein Versal-Mikro-Label über seinem Wert braucht
  // ihn ohnehin nicht; die Zeile darunter IST der Wert.
  textBlock.appendChild(titleEl);
  textBlock.appendChild(bodyEl);

  const dismissBtn = document.createElement('button');
  dismissBtn.className = 'toast__undo';
  dismissBtn.textContent = t('reminders.dismiss');
  dismissBtn.addEventListener('click', () => {
    dismissReminder(reminder.id);
    toast.remove();
  });

  toast.appendChild(seal);
  toast.appendChild(textBlock);
  toast.appendChild(dismissBtn);
  container.appendChild(toast);

  // Reminder-Toasts bleiben 30 Sekunden sichtbar
  const dismissTimer = setTimeout(() => {
    toast.classList.add('toast--out');
    toast.addEventListener('animationend', () => toast.remove(), { once: true });
  }, 30_000);

  textBlock.addEventListener('click', () => {
    clearTimeout(dismissTimer);
    dismissReminder(reminder.id);
    toast.remove();
    if (targetUrl) window.yuvomi?.navigate(targetUrl);
  });

  return true;
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
  _deferredRetries = 0;
  updateBellBadge(0);
}

/**
 * Erzwingt sofortigen Poll (z.B. nach Erstellen einer Erinnerung).
 */
function refresh() {
  poll();
}

export {
  init, stop, refresh, requestPermission, notificationStatus,
};
