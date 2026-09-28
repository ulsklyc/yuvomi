import { api } from '/api.js';
import { t } from '/i18n.js';
import { esc } from '/utils/html.js';
import { caldavTargetValue, SYNC_TARGET_LOCAL } from '/utils/sync-target.js';
import { getPreferences, savePreferences } from '/settings/preferences-cache.js';
import { createRetryState } from '/settings/components.js';

/**
 * Standardwerte, die nur für die eigenen neuen Aufgaben gelten (#695).
 *
 * Eigenes Blatt und nicht in `sync-reminders`: welche Erinnerungslisten der
 * Haushalt überhaupt abgleicht, ist eine Admin-Entscheidung, in welche davon
 * MEINE neuen Aufgaben laufen, ist meine. `preferences.js` schreibt den Wert
 * entsprechend per `cfgUserSet`. Derselbe Fehler steckte schon einmal in
 * `modules-calendar` (Critique 2026-07-27), und dort kamen fünf von sechs
 * Familienmitgliedern nie an ihre eigenen Vorgaben.
 *
 * DREI ZUSTÄNDE (#1516). Der Abschnitt hält genau eine Einstellung, und die
 * gibt es erst, wenn ein Admin eine Erinnerungsliste für Aufgaben freigibt.
 * Ausblenden kann die Registry ihn nicht: ihre Sichtbarkeit ist die Rolle,
 * synchron, und aus ihr bauen Router, Suche und Befehlspalette ihre Ziele -
 * ein Zustand, der erst per Anfrage feststeht, hätte dort keinen Platz, und
 * für Mitglieder verschwände mit dem Abschnitt das ganze Aufgabenblatt samt
 * Lesezeichen `/settings/personal/tasks`. Also steht er immer da und sagt,
 * woran es liegt:
 *   - Listen da (oder ein gespeichertes Ziel): das Feld.
 *   - Antwort leer: der Leerzustand, und für den Admin der Weg zur Freigabe.
 *     Mitglieder bekommen keinen Link - der Abschnitt `sync-reminders` ist
 *     adminOnly, der Sprung endete oben im Blatt.
 *   - Anfrage gescheitert: ein Fehler mit Erneut-Knopf. Der Leerzustand wäre
 *     hier eine falsche Behauptung ("nichts freigegeben"), gerade neben einem
 *     gespeicherten Ziel.
 */

// Die Freigabestelle im selben Blatt (Abschnitt "Für den Haushalt"). Dieselbe
// Adresse baut settingsSectionUrl() aus der Registry; test:settings-navigation
// hält beide gleich.
const SYNC_REMINDERS_PATH = '/settings/modules/tasks?section=sync-reminders';

/**
 * Optionen des Standard-Ziel-Dropdowns.
 *
 * Bewusst nicht über buildSyncTargetOptions: die Aufgaben kennen kein
 * Google-Ziel und keine Kalender, sondern Erinnerungslisten. Die Kennung selbst
 * kommt trotzdem aus dem geteilten Util - sie ist dieselbe Form wie beim
 * Kalender, und genau dafür gibt es das Modul.
 */
export function reminderTargetOptions(lists, labels, current = '') {
  const options = [{ value: SYNC_TARGET_LOCAL, label: labels.local, group: null }];

  for (const list of lists || []) {
    options.push({
      value: caldavTargetValue(list.accountId, list.listUrl),
      label: list.listName || list.listUrl,
      group: list.accountName,
    });
  }

  // Ein gespeichertes, aber nicht mehr angebotenes Ziel als eigene Option
  // nachtragen: sonst zeigte die Oberfläche "nur lokal", während in der
  // Datenbank etwas anderes steht - und es gäbe keinen Weg, es abzuwählen.
  if (current && !options.some((option) => option.value === current)) {
    options.push({ value: current, label: labels.unavailable, group: null });
  }

  return options;
}

function targetFieldHtml(options, current) {
  let html = '';
  let openGroup = null;
  for (const option of options) {
    if (option.group !== openGroup) {
      if (openGroup) html += '</optgroup>';
      openGroup = option.group;
      if (openGroup) html += `<optgroup label="${esc(openGroup)}">`;
    }
    const selected = option.value === current ? ' selected' : '';
    html += `<option value="${esc(option.value)}"${selected}>${esc(option.label)}</option>`;
  }
  if (openGroup) html += '</optgroup>';

  return `
        <div class="form-group">
          <label class="form-label" for="tasks-default-target">${t('settings.tasksDefaultTargetLabel')}</label>
          <select id="tasks-default-target" class="form-input">${html}</select>
          <p class="form-hint">${t('settings.tasksDefaultTargetHint')}</p>
        </div>
  `;
}

function emptyStateHtml(user) {
  const release = user?.role === 'admin'
    ? `
        <p class="form-hint">
          ${t('settings.tasksDefaultTargetEmptyAdmin')}
          <a href="${SYNC_REMINDERS_PATH}" id="tasks-sync-reminders-link">${t('settings.pageSyncReminders')}</a>
        </p>
`
    : '';
  return `        <p class="form-hint">${t('settings.tasksDefaultTargetEmpty')}</p>
${release}`;
}

function renderPage(container, preferences, lists, user) {
  const current = preferences.tasks_default_target || '';
  // Das Feld erscheint nur, wenn es etwas zu wählen gibt - ohne freigegebene
  // Erinnerungsliste bliebe ein Dropdown mit der einzigen Option "nur lokal".
  // Ist die Abfrage selbst gescheitert (lists === null), bleibt es ebenfalls
  // weg: dann ist unbekannt, was zur Wahl stünde, und statt des Leerzustands
  // steht der Fehler da (mountTargetError).
  const options = lists ? reminderTargetOptions(lists, {
    local: t('tasks.syncTargetLocal'),
    unavailable: t('settings.tasksDefaultTargetUnavailable'),
  }, current) : [];
  let body = '';
  if (options.length > 1) body = targetFieldHtml(options, current);
  else if (lists) body = emptyStateHtml(user);

  container.replaceChildren();
  container.insertAdjacentHTML('beforeend', `
    <section class="settings-section">
      <!-- Bewusst NICHT der Blatt-Titel: die Shell zeigt ihn bereits darüber,
           und ein h2, das ihn wiederholt, ist eine Überschrift ohne Aussage
           (Guard in test-typography.js). -->
      <h2 class="settings-section__title">${t('settings.tasksDefaultsTitle')}</h2>
      <div class="settings-card">
        <p class="settings-card-description">${t('settings.tasksDefaultsDescription')}</p>
${body}      </div>
    </section>
  `);
}

// Instant-Save mit Rollback auf den letzten gespeicherten Wert, damit ein
// abgelehnter Wert nicht sichtbar stehenbleibt.
function bindEvents(container) {
  container.querySelector('#tasks-sync-reminders-link')?.addEventListener('click', (event) => {
    if (!window.yuvomi?.navigate) return;
    event.preventDefault();
    window.yuvomi.navigate(SYNC_REMINDERS_PATH);
  });

  const select = container.querySelector('#tasks-default-target');
  if (!select) return;

  let persisted = select.value;
  select.addEventListener('change', async () => {
    const value = select.value;
    select.disabled = true;
    try {
      await savePreferences({ tasks_default_target: value });
      persisted = value;
      window.yuvomi?.showToast(t('settings.tasksDefaultsSaved'), 'success');
    } catch (error) {
      select.value = persisted;
      window.yuvomi?.showToast(error.message || t('common.errorGeneric'), 'danger');
    } finally {
      if (select.isConnected) select.disabled = false;
    }
  });
}

// Der Fehler steht in der Karte, unter der Beschreibung - an der Stelle, an
// der sonst Feld oder Leerzustand stünden. Erneut versuchen baut den Abschnitt
// neu auf und legt den Fokus dorthin, wo es weitergeht: aufs Feld, auf den
// Leerzustand-Link oder, scheitert es wieder, auf den neuen Knopf.
function mountTargetError(container, user) {
  container.querySelector('.settings-card')?.appendChild(createRetryState({
    message: t('settings.tasksDefaultTargetLoadError'),
    onRetry: async () => {
      await render(container, { user });
      container.querySelector('#tasks-default-target, #tasks-sync-reminders-link, .settings-retry-state__button')
        ?.focus?.({ preventScroll: true });
    },
  }));
}

export async function render(container, { user } = {}) {
  const [preferences, lists] = await Promise.all([
    getPreferences(),
    api.get('/tasks/sync-targets')
      .then((res) => res.data?.caldav || [])
      .catch((error) => {
        console.error('[Settings] Reminder lists for tasks failed to load:', error);
        return null;
      }),
  ]);
  renderPage(container, preferences, lists, user);
  if (lists === null) mountTargetError(container, user);
  bindEvents(container);
}
