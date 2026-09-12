import { api } from '/api.js';
import { formatDate, formatTime, t } from '/i18n.js';
import { closeModal, confirmModal, openModal, refocusAfterRender } from '/components/modal.js';
import {
  createDisclosure,
  createInlineError,
  createRetryState,
  createStatusSummary,
  createToggleRow,
} from '/settings/components.js';
import { withBusy } from '/utils/ux.js';
import { loadFamilyUsers } from '/settings/family-users.js';

const MORE_PROVIDERS_ID = 'sync-more-providers';
const GOOGLE_PROVIDER_ID = 'sync-provider-google';
const APPLE_PROVIDER_ID = 'sync-provider-apple';
const OUTLOOK_PROVIDER_ID = 'sync-provider-outlook';

function formatSyncTime(value) {
  if (!value) return null;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  return `${formatDate(date)} ${formatTime(date)}`.trim();
}

function lastSyncDetail(value) {
  const formatted = formatSyncTime(value);
  return formatted
    ? t('settings.lastSyncValue', { value: formatted })
    : t('settings.neverSynced');
}

function enabledCalendarCount(calendars) {
  return calendars.filter((cal) => cal.enabled).length;
}

function showToast(message, tone = 'default') {
  window.yuvomi?.showToast(message, tone);
}

function providerConnectionStatus(status) {
  if (!status) return t('settings.notConnected');
  if (status.connected) {
    const formatted = formatSyncTime(status.lastSync);
    return formatted
      ? t('settings.connectedLastSync', { date: formatted })
      : t('settings.connected');
  }
  if (status.configured) {
    const formatted = formatSyncTime(status.lastSync);
    return formatted
      ? t('settings.configuredLastSync', { date: formatted })
      : t('settings.configured');
  }
  return t('settings.notConfigured');
}

// --------------------------------------------------------------------------
// Page scaffold
// --------------------------------------------------------------------------

function renderPage(container, user) {
  container.replaceChildren();
  container.insertAdjacentHTML('beforeend', `
    <div id="sync-calendar-banner"></div>

    <section class="settings-section">
      <h2 class="settings-section__title">${t('settings.caldavTitle')}</h2>
      <div class="settings-card">
        <p class="settings-card-description">${t('settings.caldavDescription')}</p>
        <div id="caldav-accounts" class="settings-sync-accounts"></div>
        ${user?.role === 'admin' ? `
          <div class="settings-form-actions">
            <button type="button" class="btn btn--primary" id="caldav-add-account-btn">
              ${t('settings.caldavAddAccount')}
            </button>
          </div>
        ` : ''}
      </div>
    </section>



    <section class="settings-section">
      <div id="sync-more-providers-container"></div>
    </section>
  `);
}

// --------------------------------------------------------------------------
// Standard-Zuweisung pro Kalender-Sync-Ziel (#459)
// --------------------------------------------------------------------------

/**
 * Kompaktes Auswahlfeld „Standard-Zuweisung" für eine synchronisierte
 * Kalenderzeile (Google/Apple/CalDAV). Schreibt provider-übergreifend über
 * PATCH /calendar/external-calendars. Options werden async nachgeladen, damit die
 * Zeile sofort rendert; Interaktionen werden vom Zeilen-Label entkoppelt.
 */
function buildCalendarAssigneeSelect({ source, externalId, currentId }) {
  const select = document.createElement('select');
  select.className = 'caldav-calendar-assignee';
  select.title = t('settings.sync.defaultAssignee');
  select.setAttribute('aria-label', t('settings.sync.defaultAssignee'));

  const none = document.createElement('option');
  none.value = '';
  none.textContent = t('settings.sync.defaultAssigneeNone');
  select.appendChild(none);

  // Kurzer Ladehinweis, bis die Nutzerliste aufgelöst ist.
  const loadingOpt = document.createElement('option');
  loadingOpt.value = '';
  loadingOpt.disabled = true;
  loadingOpt.textContent = t('common.loading');
  select.appendChild(loadingOpt);

  // Klicks/Änderungen nicht an das umschließende Label (Checkbox) weiterreichen.
  ['click', 'mousedown', 'change'].forEach((ev) =>
    select.addEventListener(ev, (e) => e.stopPropagation()));

  loadFamilyUsers().then((users) => {
    loadingOpt.remove();
    for (const u of users) {
      const opt = document.createElement('option');
      opt.value = String(u.id);
      opt.textContent = u.display_name;
      if (Number(currentId) === u.id) opt.selected = true;
      select.appendChild(opt);
    }
  });

  let last = currentId ? String(currentId) : '';
  select.addEventListener('change', async () => {
    const value = select.value;
    select.disabled = true;
    try {
      await api.patch('/calendar/external-calendars', {
        source,
        external_id: externalId,
        default_assignee_user_id: value ? Number(value) : null,
      });
      last = value;
      showToast(t('settings.ics.updatedToast'), 'success');
    } catch (err) {
      select.value = last;
      showToast(err.message || t('common.errorGeneric'), 'danger');
    } finally {
      select.disabled = false;
    }
  });

  return select;
}

// --------------------------------------------------------------------------
// CalDAV calendar accounts
// --------------------------------------------------------------------------

let calendarListSeq = 0;

function buildCalendarList(account, calendars) {
  const list = document.createElement('div');
  list.className = 'caldav-calendars-list';
  for (const cal of calendars) {
    const label = document.createElement('label');
    label.className = 'caldav-calendar-item';

    const checkbox = document.createElement('input');
    checkbox.type = 'checkbox';
    checkbox.className = 'caldav-calendar-checkbox';
    checkbox.checked = Boolean(cal.enabled);

    const color = document.createElement('span');
    color.className = 'caldav-calendar-color';
    color.style.backgroundColor = cal.calendarColor || 'var(--color-accent)';

    const name = document.createElement('span');
    name.className = 'caldav-calendar-name';
    name.textContent = cal.calendarName || cal.calendarUrl;

    label.append(checkbox, color, name);
    // VOR DEM HAKEN, NICHT NACH DEM SYNC: Das Feld stand früher erst da, wenn
    // der Kalender aktiv UND einmal synchronisiert war - also frühestens, als
    // der erste Schwung Termine bereits ohne Zuweisung hereingekommen war, bei
    // Serien Dutzende (#730). Jetzt lässt es sich vorher setzen; der PATCH legt
    // die external_calendars-Zeile nötigenfalls selbst an, und der spätere Sync
    // aktualisiert daran nur Name und Farbe.
    label.appendChild(buildCalendarAssigneeSelect({
      source: 'caldav',
      externalId: cal.calendarUrl,
      currentId: cal.default_assignee_user_id,
    }));
    list.appendChild(label);

    checkbox.addEventListener('change', async () => {
      const enabled = checkbox.checked;

      // DIE FRAGE KOMMT NACH DEM ABWÄHLEN, NICHT DAVOR: Der Haken wirkt in
      // dieser Oberfläche sofort, wie jede andere Einstellung auch. Vorgeschaltet
      // hieße die Frage "willst du wirklich abwählen?" und stellte das Abwählen
      // in Zweifel, um das es gar nicht geht - gefragt ist nur, was mit den
      // bereits übernommenen Terminen geschehen soll (#732).
      //
      // Behalten ist der Weg von Escape und vom Nebenknopf, also die Vorgabe.
      // Ein versehentliches Abwählen ist der häufigere Fall - der Melder nennt
      // ihn selbst -, und Behalten ist der einzige der beiden Ausgänge, der sich
      // rückgängig machen lässt.
      let deleteEvents = false;
      if (!enabled && cal.eventCount > 0) {
        deleteEvents = await confirmModal(
          t('settings.syncCleanup.question', { count: cal.eventCount }),
          {
            danger: true,
            confirmLabel: t('settings.syncCleanup.delete'),
            cancelLabel: t('settings.syncCleanup.keep'),
            detail: t('settings.syncCleanup.detail'),
          },
        );
      }

      await withBusy(checkbox, async () => {
        try {
          const res = await api.patch(`/calendar/caldav/accounts/${account.id}/calendars`, {
            calendarUrl: cal.calendarUrl,
            enabled,
            deleteEvents,
          });
          const removed = res.data?.removed ?? 0;
          if (removed) cal.eventCount = 0;
          showToast(
            removed
              ? t('settings.syncCleanup.removed', { count: removed })
              : (enabled ? t('settings.calendarEnabled') : t('settings.calendarDisabled')),
            'success',
          );
        } catch (err) {
          checkbox.checked = !enabled;
          showToast(err.message || t('common.errorGeneric'), 'danger');
        }
      });
    });
  }

  // Seit dem Opt-in (#732) bringt ein frisch verbundenes Konto seine Kalender
  // abgewählt mit - ohne ein Wort dazu sähe das aus, als sei die Verbindung
  // gescheitert. Der Hinweis steht nur, solange wirklich keiner aktiv ist, und
  // verschwindet mit dem ersten Haken.
  const none = enabledCalendarCount(calendars) === 0 && calendars.length > 0;
  if (none) {
    const hint = document.createElement('p');
    hint.className = 'form-hint';
    hint.textContent = t('settings.calendarsNoneEnabledHint');
    list.insertBefore(hint, list.firstChild);
  }

  // Gleiche Aufklapp-Grammatik wie Kontakt-Sync und die Settings-Navigation:
  // geteilte Komponente mit Chevron und ARIA statt rohem <details>.
  // Eine Zahl statt zweier: „1 von 3 Kalendern" - gleiche Grammatik wie Kontakt-Sync.
  return createDisclosure({
    id: `caldav-calendars-${++calendarListSeq}`,
    summary: t('settings.calendarsEnabledOfTotal', {
      enabled: enabledCalendarCount(calendars),
      total: calendars.length,
      count: calendars.length,
    }),
    // Steht keiner an, ist die Auswahl der nächste Schritt und nicht eine
    // Nebensache hinter einem Chevron.
    expanded: none,
    content: list,
  });
}

function renderCalDAVAccount(container, account, calendars, refresh, user) {
  const card = document.createElement('article');
  card.className = 'caldav-account-item';

  // listAccounts() liefert camelCase (caldavUrl/lastSync), nicht die Roh-Spalten.
  // Zähler lebt im Aufklapp-Label; die URL ist Nachschlage-Information, ans Ende.
  const details = [lastSyncDetail(account.lastSync)];
  if (account.caldavUrl) details.push(account.caldavUrl);

  const syncBtn = document.createElement('button');
  syncBtn.type = 'button';
  // Gleiche Rangfolge wie Kontakt-Sync: Sync akzentuiert, Wartung still.
  syncBtn.className = 'btn btn--secondary btn--sm';
  syncBtn.textContent = t('settings.syncNow');
  syncBtn.addEventListener('click', async () => {
    syncBtn.disabled = true;
    try {
      await api.post('/calendar/caldav/sync');
      showToast(t('settings.caldavSyncSuccess'), 'success');
      await refresh();
    } catch (err) {
      showToast(err.message || t('settings.caldavSyncFailed'), 'danger');
      syncBtn.disabled = false;
    }
  });

  card.appendChild(createStatusSummary({
    title: account.name,
    status: account.lastSync ? t('settings.connected') : t('settings.notConnected'),
    details,
    action: syncBtn,
    tone: account.lastSync ? 'success' : 'neutral',
  }));

  card.appendChild(buildCalendarList(account, calendars));

  // Wie beim Google-Picker (#1060): die Standard-Zuweisung waehlt auch das Ziel neuer Termine.
  if (calendars.length) {
    const routingHint = document.createElement('p');
    routingHint.className = 'form-hint';
    routingHint.textContent = t('settings.sync.defaultAssigneeRoutingHint');
    card.appendChild(routingHint);
  }

  const actions = document.createElement('div');
  actions.className = 'caldav-account-actions';

  const refreshBtn = document.createElement('button');
  refreshBtn.type = 'button';
  refreshBtn.className = 'btn btn--ghost btn--sm';
  refreshBtn.textContent = t('settings.caldavRefreshCalendars');
  refreshBtn.addEventListener('click', async () => {
    refreshBtn.disabled = true;
    try {
      await api.get(`/calendar/caldav/accounts/${account.id}/calendars?refresh=true`);
      showToast(t('settings.calendarsRefreshed'), 'success');
      await refresh();
    } catch (err) {
      showToast(err.message || t('common.errorGeneric'), 'danger');
      refreshBtn.disabled = false;
    }
  });
  actions.appendChild(refreshBtn);

  if (user?.role === 'admin') {
    const deleteBtn = document.createElement('button');
    deleteBtn.type = 'button';
    deleteBtn.className = 'btn btn--danger-outline btn--sm';
    deleteBtn.textContent = t('common.delete');
    deleteBtn.addEventListener('click', async () => {
      // Frage nennt das Konto, Detail nennt die Folge (mehrere Konten möglich).
      const confirmed = await confirmModal(
        t('settings.disconnectAccountConfirmTitle', { name: account.name }),
        {
          detail: t('settings.deleteAccountConfirm'),
          confirmLabel: t('common.delete'),
          danger: true,
        },
      );
      if (!confirmed) return;

      // Zweite Frage nur, wenn es etwas zu entscheiden gibt: Ohne sie war das
      // Trennen der einzige Weg, bei dem Termine sichtbar stehen bleiben und
      // dabei ihre Kalenderzuordnung verlieren - Waisen ohne erkennbare
      // Herkunft (#732). Die Vorgabe ist auch hier Behalten.
      let deleteEvents = false;
      if (account.eventCount > 0) {
        deleteEvents = await confirmModal(
          t('settings.syncCleanup.accountQuestion', { count: account.eventCount }),
          {
            danger: true,
            confirmLabel: t('settings.syncCleanup.delete'),
            cancelLabel: t('settings.syncCleanup.keep'),
            detail: t('settings.syncCleanup.accountDetail'),
          },
        );
      }

      try {
        const res = await api.delete(
          `/calendar/caldav/accounts/${account.id}?deleteEvents=${deleteEvents ? 'true' : 'false'}`
        );
        const removed = res.data?.removed ?? 0;
        showToast(
          removed
            ? t('settings.syncCleanup.removed', { count: removed })
            : t('settings.caldavAccountDeleted'),
          'success',
        );
        await refresh();
        refocusAfterRender();
      } catch (err) {
        showToast(err.message || t('common.errorGeneric'), 'danger');
      }
    });
    actions.appendChild(deleteBtn);
  }

  card.appendChild(actions);
  container.appendChild(card);
}

async function loadCalDAVAccounts(container, user) {
  const listEl = container.querySelector('#caldav-accounts');
  if (!listEl) return;
  listEl.replaceChildren();

  const reload = () => loadCalDAVAccounts(container, user);

  let accounts;
  try {
    const res = await api.get('/calendar/caldav/accounts');
    accounts = res.data || [];
  } catch (err) {
    listEl.appendChild(createRetryState({
      message: err.message || t('settings.caldavConnectionFailed'),
      onRetry: reload,
    }));
    return;
  }

  if (accounts.length === 0) {
    const empty = document.createElement('p');
    empty.className = 'form-hint';
    empty.textContent = t('settings.caldavEmptyState');
    listEl.appendChild(empty);
    return;
  }

  for (const account of accounts) {
    let calendars = [];
    try {
      const calRes = await api.get(`/calendar/caldav/accounts/${account.id}/calendars`);
      calendars = calRes.data || [];
    } catch (err) {
      const wrapper = document.createElement('div');
      wrapper.className = 'caldav-account-item';
      wrapper.appendChild(createStatusSummary({
        title: account.name,
        status: t('settings.notConnected'),
        details: [lastSyncDetail(account.lastSync)],
        tone: 'warning',
      }));
      wrapper.appendChild(createInlineError(err.message || t('common.errorGeneric')));
      listEl.appendChild(wrapper);
      continue;
    }
    renderCalDAVAccount(listEl, account, calendars, reload, user);
  }
  // Die Karten tragen Lucide-Platzhalter (Disclosure-Chevron) und entstehen bei
  // jedem Reload neu.
  window.lucide?.createIcons({ el: listEl });
}

function bindCalDAVAddButton(container, user) {
  const addBtn = container.querySelector('#caldav-add-account-btn');
  if (!addBtn) return;
  addBtn.addEventListener('click', () => {
    openModal({
      title: t('settings.caldavAddAccount'),
      size: 'sm',
      content: `
        <form id="caldav-add-form" novalidate autocomplete="off">
          <div class="form-group">
            <label class="form-label" for="caldav-name">${t('settings.caldavNameLabel')}<span class="required-marker" aria-hidden="true"> *</span></label>
            <input class="form-input" type="text" id="caldav-name" required
                   placeholder="${t('settings.caldavNamePlaceholder')}" maxlength="100" />
          </div>
          <div class="form-group">
            <label class="form-label" for="caldav-url">${t('settings.caldavUrlLabel')}<span class="required-marker" aria-hidden="true"> *</span></label>
            <input class="form-input" type="url" id="caldav-url" required
                   placeholder="${t('settings.caldavUrlPlaceholder')}" />
            <small class="form-hint">${t('settings.caldavUrlHint')}</small>
          </div>
          <div class="form-group">
            <label class="form-label" for="caldav-username">${t('settings.caldavUsernameLabel')}<span class="required-marker" aria-hidden="true"> *</span></label>
            <input class="form-input" type="text" id="caldav-username" required autocomplete="off" />
          </div>
          <div class="form-group">
            <label class="form-label" for="caldav-password">${t('settings.caldavPasswordLabel')}<span class="required-marker" aria-hidden="true"> *</span></label>
            <input class="form-input" type="password" id="caldav-password" required autocomplete="current-password" />
            <small class="form-hint">${t('settings.caldavPasswordHint')}</small>
          </div>
          <div id="caldav-add-error" class="form-error" role="alert" hidden></div>
          <div class="modal-actions">
            <button type="button" class="btn btn--ghost" id="caldav-add-cancel">${t('common.cancel')}</button>
            <button type="submit" class="btn btn--primary">${t('common.save')}</button>
          </div>
        </form>
      `,
      onSave: (panel) => {
        const form = panel.querySelector('#caldav-add-form');
        const errorEl = panel.querySelector('#caldav-add-error');
        panel.querySelector('#caldav-add-cancel')?.addEventListener('click', () => closeModal({ force: true }));

        form.addEventListener('submit', async (e) => {
          e.preventDefault();
          errorEl.hidden = true;

          const name = panel.querySelector('#caldav-name').value.trim();
          const caldavUrl = panel.querySelector('#caldav-url').value.trim();
          const username = panel.querySelector('#caldav-username').value.trim();
          const password = panel.querySelector('#caldav-password').value;

          if (!name || !caldavUrl || !username || !password) {
            errorEl.textContent = t('common.requiredFields');
            errorEl.hidden = false;
            return;
          }

          try {
            await api.post('/calendar/caldav/accounts', {
              name,
              caldavUrl,
              username,
              password,
            });
            closeModal({ force: true });
            showToast(t('settings.caldavAccountAdded'), 'success');
            await loadCalDAVAccounts(container, user);
            refocusAfterRender();
          } catch (err) {
            errorEl.textContent = err.message || t('common.errorGeneric');
            errorEl.hidden = false;
          }
        });
      },
    });
  });
}

// --------------------------------------------------------------------------
// More providers (Google · Apple)
// --------------------------------------------------------------------------

function buildGoogleProvider(googleStatus, user) {
  const section = document.createElement('div');
  section.className = 'settings-card settings-provider';
  section.id = `${GOOGLE_PROVIDER_ID}-panel`;

  const header = document.createElement('div');
  header.className = 'settings-provider__header';
  const title = document.createElement('h4');
  title.className = 'settings-provider__name';
  title.textContent = t('settings.googleCalendar');
  const badge = document.createElement('span');
  badge.className = 'badge badge--neutral settings-provider__badge';
  badge.textContent = t('settings.providerSpecific');
  header.append(title, badge);
  section.appendChild(header);

  const status = document.createElement('p');
  status.className = 'settings-sync-info__status';
  status.textContent = providerConnectionStatus(googleStatus);
  section.appendChild(status);
  appendSyncError(status, googleStatus?.lastError);

  // Der Rückstand eines getrennten Kontos: hier vorbereitet, aber unten angehängt.
  // Er steht am Fuß der Karte, hinter dem Verbinden - was man als Nächstes tun
  // will, gehört vor das Wegräumen dessen, was war. Vorbereitet wird er trotzdem
  // schon hier, weil der Early-Return darunter ihn sonst verschluckte: fehlen die
  // OAuth-Credentials in der Umgebung, ist die Karte fertig, bevor sie Aktionen
  // gebaut hat - und genau dann muss der Weg zum Aufräumen erreichbar bleiben (#820).
  const cleanup = (!googleStatus?.connected && user?.role === 'admin')
    ? buildMirroredCleanup({
      count: googleStatus?.mirroredEvents || 0,
      endpoint: '/calendar/google/mirrored-events',
    })
    : null;

  if (!googleStatus?.configured) {
    section.appendChild(buildProviderHint(t('settings.notConfigured')));
    if (cleanup) section.appendChild(cleanup);
    return section;
  }

  if (googleStatus.connected && user?.role === 'admin') {
    section.appendChild(buildGoogleCalendarPicker());
    section.appendChild(buildGoogleReadonlyToggle(googleStatus));
  }

  const actions = document.createElement('div');
  actions.className = 'settings-sync-actions';
  if (googleStatus.connected) {
    const syncBtn = document.createElement('button');
    syncBtn.type = 'button';
    syncBtn.className = 'btn btn--secondary';
    syncBtn.textContent = t('settings.syncNow');
    syncBtn.addEventListener('click', async () => {
      syncBtn.disabled = true;
      syncBtn.textContent = t('settings.synchronizing');
      try {
        await api.post('/calendar/google/sync', {});
        showToast(t('settings.syncSuccess', { provider: 'Google Calendar' }), 'success');
      } catch (err) {
        showToast(err.message || t('common.errorGeneric'), 'danger');
      } finally {
        syncBtn.disabled = false;
        syncBtn.textContent = t('settings.syncNow');
      }
    });
    actions.appendChild(syncBtn);

    if (user?.role === 'admin') {
      const disconnectBtn = document.createElement('button');
      disconnectBtn.type = 'button';
      disconnectBtn.className = 'btn btn--danger-outline';
      disconnectBtn.textContent = t('settings.disconnect');
      disconnectBtn.addEventListener('click', async () => {
        if (!await confirmModal(t('settings.googleDisconnectConfirm'),
          { danger: true, detail: t('settings.googleDisconnectConfirmDetail') })) return;
        const deleteEvents = await askDeleteMirrored(googleStatus.mirroredEvents);
        try {
          // Die Zahl statt der blossen Trennmeldung, wenn geraeumt wurde: sonst
          // bliebe der zweite Teil der Aktion unbestaetigt (#820). Wie bei CalDAV.
          const res = await api.delete(`/calendar/google/disconnect?deleteEvents=${deleteEvents ? 'true' : 'false'}`);
          const removed = res?.removed ?? 0;
          showToast(
            removed
              ? t('settings.syncCleanup.removed', { count: removed })
              : t('settings.disconnectedToast', { provider: 'Google Calendar' }),
            'default',
          );
          window.yuvomi?.navigate('/settings/sync/calendar');
        } catch (err) {
          showToast(err.message || t('common.errorGeneric'), 'danger');
        }
      });
      actions.appendChild(disconnectBtn);
    }
  } else if (user?.role === 'admin') {
    const connect = document.createElement('a');
    connect.href = '/api/v1/calendar/google/auth';
    connect.className = 'btn btn--primary';
    connect.textContent = t('settings.connectGoogle');
    actions.appendChild(connect);
  } else {
    section.appendChild(buildProviderHint(t('settings.googleOnlyAdmin')));
  }
  if (actions.childElementCount) section.appendChild(actions);
  if (cleanup) section.appendChild(cleanup);

  return section;
}

/**
 * Der letzte Sync-Fehler, direkt hinter der Statuszeile, die er erklärt (#820).
 *
 * Bis dahin stand er nur im Serverlog: ein Google-Sync konnte wochenlang stumm
 * scheitern, und der Haushalt sah lediglich einen Kalender, der aufhörte sich zu
 * aktualisieren. Derselbe Platz und derselbe Schlüssel wie bei CardDAV
 * (sync-contacts.js) - eine zweite Schreibweise für dieselbe Aussage wäre teurer
 * als der geteilte Text.
 *
 * @param {HTMLElement} statusEl  die Statuszeile des Providers
 * @param {string|null} lastError
 */
function appendSyncError(statusEl, lastError) {
  if (!lastError) return;
  statusEl.insertAdjacentElement(
    'afterend',
    createInlineError(t('settings.syncErrorDetail', { error: lastError })),
  );
}

// --------------------------------------------------------------------------
// Übernommene Termine aufräumen (#820)
// --------------------------------------------------------------------------
// Das Trennen löscht Zugangsdaten und Kalenderauswahl, nicht die schon
// übernommenen Termine. Die blieben bisher ohne jeden Ausgang liegen: kein Sync
// fasst sie wieder an, und beim erneuten Verbinden legt der Inbound sie ein
// zweites Mal an - Dubletten, am sichtbarsten bei Serien. Von Hand hiess das:
// Termin für Termin.
//
// Nur im getrennten Zustand: bei laufendem Sync holt der nächste Inbound alles
// zurück, ein Löschen wäre folgenlos und deshalb irreführend.

/** Zweite Rückfrage vor dem Trennen: Termine mitnehmen oder behalten? */
async function askDeleteMirrored(count) {
  if (!count) return false;
  return confirmModal(
    t('settings.syncCleanup.accountQuestion', { count }),
    {
      danger: true,
      detail: t('settings.syncCleanup.accountDetail'),
      confirmLabel: t('settings.syncCleanup.delete'),
      cancelLabel: t('settings.syncCleanup.keep'),
    },
  );
}

/**
 * Der Aufräum-Block eines getrennten Providers - oder null, wenn nichts liegt.
 * @param {object} opts
 * @param {number} opts.count     Termine, die lokal liegen
 * @param {string} opts.endpoint  DELETE-Pfad für das Aufräumen
 */
function buildMirroredCleanup({ count, endpoint }) {
  if (!count) return null;

  const group = document.createElement('div');

  const hint = document.createElement('p');
  hint.className = 'form-hint';
  hint.textContent = t('settings.syncCleanup.orphanHint', { count });
  group.appendChild(hint);

  // Die Aktionszeile der Karte statt einer `form-group`: die ist Flex mit
  // stretch, der Knopf lief dort auf volle Breite und wog damit schwerer als
  // das Verbinden darueber - laut fuer das Aufraeumen, leise fuer die Hauptsache.
  const actions = document.createElement('div');
  actions.className = 'settings-sync-actions';

  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'btn btn--danger-outline';
  btn.textContent = t('settings.syncCleanup.orphanAction');
  btn.addEventListener('click', async () => {
    const ok = await confirmModal(
      t('settings.syncCleanup.orphanQuestion', { count }),
      {
        danger: true,
        detail: t('settings.syncCleanup.orphanDetail'),
        confirmLabel: t('settings.syncCleanup.delete'),
        cancelLabel: t('settings.syncCleanup.keep'),
      },
    );
    if (!ok) return;
    await withBusy(btn, async () => {
      try {
        const { data } = await api.delete(endpoint);
        showToast(t('settings.syncCleanup.removed', { count: data?.removed ?? 0 }), 'success');
        // Nur diesen Block wegnehmen, die Seite NICHT neu aufbauen: ein
        // navigate() klappte „Weitere Anbieter" wieder zu und nahm den Toast
        // mit - der Nutzer landete ohne jede Rückmeldung dort, wo er angefangen
        // hatte. Der Block existiert wegen des Rückstands; der ist jetzt fort.
        group.remove();
      } catch (err) {
        showToast(err.message || t('common.errorGeneric'), 'danger');
      }
    });
  });
  actions.appendChild(btn);
  group.appendChild(actions);

  return group;
}

function buildProviderHint(text) {
  const hint = document.createElement('p');
  hint.className = 'form-hint';
  hint.textContent = text;
  return hint;
}

function buildGoogleCalendarPicker() {
  const group = document.createElement('div');
  group.className = 'form-group settings-google-calendars';

  const label = document.createElement('label');
  label.className = 'form-label';
  label.textContent = t('settings.googleCalendarsSelect');
  group.appendChild(label);

  const list = document.createElement('div');
  list.className = 'google-calendars-list';
  const loading = document.createElement('p');
  loading.className = 'form-hint';
  loading.textContent = t('common.loading');
  list.appendChild(loading);
  group.appendChild(list);

  const hint = document.createElement('p');
  hint.className = 'form-hint';
  hint.textContent = t('settings.googleCalendarsSelectHint');
  group.appendChild(hint);

  // Die Standard-Zuweisung wirkt seit #1060 in zwei Richtungen - das steht dort,
  // wo sie gesetzt wird, samt der Kalender, fuer die die zweite nicht gilt.
  const routingHint = document.createElement('p');
  routingHint.className = 'form-hint';
  routingHint.textContent = t('settings.sync.defaultAssigneeRoutingHint');
  group.appendChild(routingHint);

  (async () => {
    try {
      const { data } = await api.get('/calendar/google/calendars');
      const calendars = data || [];
      list.replaceChildren();
      for (const cal of calendars) {
        const item = document.createElement('label');
        item.className = 'caldav-calendar-item';

        const checkbox = document.createElement('input');
        checkbox.type = 'checkbox';
        checkbox.className = 'google-calendar-checkbox';
        checkbox.checked = Boolean(cal.enabled);

        const dot = document.createElement('span');
        dot.className = 'caldav-calendar-color';
        dot.style.backgroundColor = cal.backgroundColor || 'var(--color-accent)';

        const name = document.createElement('span');
        name.className = 'caldav-calendar-name';
        name.textContent = cal.summary || cal.id;

        item.append(checkbox, dot, name);
        // Wie bei CalDAV vor dem Haken setzbar (#730) - hier zählt es doppelt:
        // Das Aktivieren startet den Sync unmittelbar (PATCH /google/calendars),
        // eine Zuweisung danach käme für die erste Ladung immer zu spät.
        item.appendChild(buildCalendarAssigneeSelect({
          source: 'google',
          externalId: cal.id,
          currentId: cal.default_assignee_user_id,
        }));
        list.appendChild(item);

        checkbox.addEventListener('change', async () => {
          const enabled = checkbox.checked;
          await withBusy(checkbox, async () => {
            try {
              await api.patch('/calendar/google/calendars', { calendarId: cal.id, enabled });
              showToast(
                enabled ? t('settings.calendarEnabled') : t('settings.calendarDisabled'),
                'success',
              );
            } catch (err) {
              checkbox.checked = !enabled;
              showToast(err.message || t('common.errorGeneric'), 'danger');
            }
          });
        });
      }
    } catch (err) {
      const p = document.createElement('p');
      p.className = 'form-hint';
      p.textContent = err.message || t('common.errorGeneric');
      list.replaceChildren(p);
    }
  })();

  return group;
}

function buildGoogleReadonlyToggle(googleStatus) {
  const group = document.createElement('div');
  group.className = 'form-group';

  const row = createToggleRow({
    label: t('settings.googleReadonly'),
    checked: Boolean(googleStatus.readonly),
  });
  const checkbox = row.querySelector('input');
  group.appendChild(row);

  const hint = document.createElement('p');
  hint.className = 'form-hint';
  hint.textContent = t('settings.googleReadonlyHint');
  group.appendChild(hint);

  checkbox.addEventListener('change', async () => {
    const enabled = checkbox.checked;
    await withBusy(checkbox, async () => {
      try {
        await api.put('/calendar/google/readonly', { readonly: enabled });
      } catch (err) {
        checkbox.checked = !enabled;
        showToast(err.message || t('common.errorGeneric'), 'danger');
      }
    });
  });

  return group;
}

// --------------------------------------------------------------------------
// Outlook (Microsoft Graph, One-Way-Push Yuvomi → Outlook)
// --------------------------------------------------------------------------

function buildOutlookCalendarList(account, calendars, user) {
  const list = document.createElement('div');
  list.className = 'caldav-calendars-list';
  for (const cal of calendars) {
    const label = document.createElement('label');
    label.className = 'caldav-calendar-item';

    const checkbox = document.createElement('input');
    checkbox.type = 'checkbox';
    checkbox.className = 'caldav-calendar-checkbox';
    checkbox.checked = Boolean(cal.enabled);
    checkbox.disabled = user?.role !== 'admin';

    const color = document.createElement('span');
    color.className = 'caldav-calendar-color';
    color.style.backgroundColor = cal.calendarColor || 'var(--color-accent)';

    const name = document.createElement('span');
    name.className = 'caldav-calendar-name';
    name.textContent = cal.calendarName || cal.calendarId;

    label.append(checkbox, color, name);
    list.appendChild(label);

    checkbox.addEventListener('change', async () => {
      const enabled = checkbox.checked;
      await withBusy(checkbox, async () => {
        try {
          await api.patch(`/calendar/outlook/accounts/${account.id}/calendars`, {
            calendarId: cal.calendarId,
            enabled,
          });
          showToast(
            enabled ? t('settings.calendarEnabled') : t('settings.calendarDisabled'),
            'success',
          );
        } catch (err) {
          checkbox.checked = !enabled;
          showToast(err.message || t('common.errorGeneric'), 'danger');
        }
      });
    });
  }

  return createDisclosure({
    id: `outlook-calendars-${++calendarListSeq}`,
    summary: t('settings.calendarsEnabledOfTotal', {
      enabled: enabledCalendarCount(calendars),
      total: calendars.length,
      count: calendars.length,
    }),
    expanded: false,
    content: list,
  });
}

/**
 * Auto-Sync-Steuerung eines Outlook-Kontos: ein Zielkalender (beschreibbar,
 * Empfehlung: dedizierter „Yuvomi"-Kalender) + die Person, deren sichtbare
 * Termine automatisch gepusht werden. Beides admin-only, Partial-Update via
 * PUT /calendar/outlook/accounts/:id.
 */
function buildOutlookAutoSyncControls(account, calendars) {
  const wrap = document.createElement('div');
  wrap.className = 'form-group';

  const hint = document.createElement('p');
  hint.className = 'form-hint';
  hint.textContent = t('settings.outlookAutoSyncHint');
  wrap.appendChild(hint);

  const saveField = async (payload, selectEl, revertValue) => {
    selectEl.disabled = true;
    try {
      await api.put(`/calendar/outlook/accounts/${account.id}`, payload);
      showToast(t('settings.ics.updatedToast'), 'success');
    } catch (err) {
      selectEl.value = revertValue;
      showToast(err.message || t('common.errorGeneric'), 'danger');
    } finally {
      selectEl.disabled = false;
    }
  };

  // Zielkalender (nur beschreibbare)
  const calLabel = document.createElement('label');
  calLabel.className = 'form-label';
  calLabel.textContent = t('settings.outlookAutoSyncCalendar');
  wrap.appendChild(calLabel);

  const calSelect = document.createElement('select');
  calSelect.className = 'form-input';
  const offOpt = document.createElement('option');
  offOpt.value = '';
  offOpt.textContent = t('settings.outlookAutoSyncOff');
  calSelect.appendChild(offOpt);
  for (const cal of calendars.filter((c) => c.canEdit)) {
    const opt = document.createElement('option');
    opt.value = cal.calendarId;
    opt.textContent = cal.calendarName;
    if (cal.calendarId === account.autoSyncCalendarId) opt.selected = true;
    calSelect.appendChild(opt);
  }
  let lastCal = account.autoSyncCalendarId || '';
  calSelect.addEventListener('change', async () => {
    const value = calSelect.value;
    await saveField({ autoSyncCalendarId: value || null }, calSelect, lastCal);
    lastCal = calSelect.value;
  });
  wrap.appendChild(calSelect);

  // Owner (bestimmt „für mich sichtbare Termine")
  const ownerLabel = document.createElement('label');
  ownerLabel.className = 'form-label';
  ownerLabel.textContent = t('settings.outlookOwner');
  wrap.appendChild(ownerLabel);

  const ownerSelect = document.createElement('select');
  ownerSelect.className = 'form-input';
  const noneOpt = document.createElement('option');
  noneOpt.value = '';
  noneOpt.textContent = t('settings.outlookOwnerNone');
  ownerSelect.appendChild(noneOpt);
  loadFamilyUsers().then((users) => {
    for (const u of users) {
      const opt = document.createElement('option');
      opt.value = String(u.id);
      opt.textContent = u.display_name;
      if (Number(account.ownerUserId) === u.id) opt.selected = true;
      ownerSelect.appendChild(opt);
    }
  });
  let lastOwner = account.ownerUserId ? String(account.ownerUserId) : '';
  ownerSelect.addEventListener('change', async () => {
    const value = ownerSelect.value;
    await saveField({ ownerUserId: value ? Number(value) : null }, ownerSelect, lastOwner);
    lastOwner = ownerSelect.value;
  });
  wrap.appendChild(ownerSelect);

  return wrap;
}

function buildOutlookAccountCard(account, refresh, user) {
  const card = document.createElement('article');
  card.className = 'caldav-account-item';

  const details = [lastSyncDetail(account.lastSync)];
  if (account.email) details.push(account.email);
  if (account.lastError) details.push(account.lastError);

  const syncBtn = document.createElement('button');
  syncBtn.type = 'button';
  syncBtn.className = 'btn btn--secondary btn--sm';
  syncBtn.textContent = t('settings.syncNow');
  syncBtn.disabled = user?.role !== 'admin';
  syncBtn.addEventListener('click', async () => {
    syncBtn.disabled = true;
    try {
      await api.post('/calendar/outlook/sync');
      showToast(t('settings.syncSuccess', { provider: 'Outlook' }), 'success');
      await refresh();
    } catch (err) {
      showToast(err.message || t('common.errorGeneric'), 'danger');
      syncBtn.disabled = false;
    }
  });

  card.appendChild(createStatusSummary({
    title: account.name,
    status: account.needsReauth
      ? t('settings.outlookReauthRequired')
      : (account.lastSync ? t('settings.connected') : t('settings.notConnected')),
    details,
    action: syncBtn,
    tone: account.needsReauth ? 'warning' : (account.lastSync ? 'success' : 'neutral'),
  }));

  (async () => {
    try {
      const calRes = await api.get(`/calendar/outlook/accounts/${account.id}/calendars`);
      const calendars = calRes.data || [];
      if (user?.role === 'admin') {
        card.appendChild(buildOutlookAutoSyncControls(account, calendars));
      }
      card.appendChild(buildOutlookCalendarList(account, calendars, user));
      window.lucide?.createIcons({ el: card });
    } catch (err) {
      card.appendChild(createInlineError(err.message || t('common.errorGeneric')));
    }
  })();

  if (user?.role === 'admin') {
    const actions = document.createElement('div');
    actions.className = 'caldav-account-actions';

    const refreshBtn = document.createElement('button');
    refreshBtn.type = 'button';
    refreshBtn.className = 'btn btn--ghost btn--sm';
    refreshBtn.textContent = t('settings.caldavRefreshCalendars');
    refreshBtn.addEventListener('click', async () => {
      refreshBtn.disabled = true;
      try {
        await api.get(`/calendar/outlook/accounts/${account.id}/calendars?refresh=true`);
        showToast(t('settings.calendarsRefreshed'), 'success');
        await refresh();
      } catch (err) {
        showToast(err.message || t('common.errorGeneric'), 'danger');
        refreshBtn.disabled = false;
      }
    });
    actions.appendChild(refreshBtn);

    if (account.needsReauth) {
      const reconnect = document.createElement('a');
      reconnect.href = '/api/v1/calendar/outlook/auth';
      reconnect.className = 'btn btn--primary btn--sm';
      reconnect.textContent = t('settings.outlookReconnect');
      actions.appendChild(reconnect);
    }

    const deleteBtn = document.createElement('button');
    deleteBtn.type = 'button';
    deleteBtn.className = 'btn btn--danger-outline btn--sm';
    deleteBtn.textContent = t('common.delete');
    deleteBtn.addEventListener('click', async () => {
      const confirmed = await confirmModal(
        t('settings.disconnectAccountConfirmTitle', { name: account.name }),
        {
          detail: t('settings.outlookDisconnectConfirm'),
          confirmLabel: t('common.delete'),
          danger: true,
        },
      );
      if (!confirmed) return;
      try {
        await api.delete(`/calendar/outlook/accounts/${account.id}`);
        showToast(t('settings.disconnectedToast', { provider: 'Outlook' }), 'default');
        await refresh();
        refocusAfterRender();
      } catch (err) {
        showToast(err.message || t('common.errorGeneric'), 'danger');
      }
    });
    actions.appendChild(deleteBtn);
    card.appendChild(actions);
  }

  return card;
}

function buildOutlookProvider(outlookStatus, user) {
  const section = document.createElement('div');
  section.className = 'settings-card settings-provider';
  section.id = `${OUTLOOK_PROVIDER_ID}-panel`;

  const header = document.createElement('div');
  header.className = 'settings-provider__header';
  const title = document.createElement('h4');
  title.className = 'settings-provider__name';
  title.textContent = t('settings.outlookCalendar');
  const badge = document.createElement('span');
  badge.className = 'badge badge--neutral settings-provider__badge';
  badge.textContent = t('settings.providerSpecific');
  header.append(title, badge);
  section.appendChild(header);

  const hint = document.createElement('p');
  hint.className = 'form-hint';
  hint.textContent = t('settings.outlookPushHint');
  section.appendChild(hint);

  if (!outlookStatus?.configured) {
    section.appendChild(buildProviderHint(t('settings.notConfigured')));
    return section;
  }

  const accounts = outlookStatus.accounts || [];
  const refresh = () => window.yuvomi?.navigate('/settings/sync/calendar');

  if (accounts.length === 0) {
    const empty = document.createElement('p');
    empty.className = 'settings-sync-info__status';
    empty.textContent = t('settings.notConnected');
    section.appendChild(empty);
  } else {
    const list = document.createElement('div');
    list.className = 'settings-sync-accounts';
    for (const account of accounts) {
      list.appendChild(buildOutlookAccountCard(account, refresh, user));
    }
    section.appendChild(list);
  }

  if (user?.role === 'admin') {
    const actions = document.createElement('div');
    actions.className = 'settings-sync-actions';
    const connect = document.createElement('a');
    connect.href = '/api/v1/calendar/outlook/auth';
    connect.className = accounts.length ? 'btn btn--secondary' : 'btn btn--primary';
    connect.textContent = t('settings.outlookConnect');
    actions.appendChild(connect);
    section.appendChild(actions);
  } else if (accounts.length === 0) {
    section.appendChild(buildProviderHint(t('settings.outlookOnlyAdmin')));
  }

  return section;
}

function buildAppleProvider(appleStatus, user) {
  const section = document.createElement('div');
  section.className = 'settings-card settings-provider';
  section.id = `${APPLE_PROVIDER_ID}-panel`;

  const header = document.createElement('div');
  header.className = 'settings-provider__header';
  const title = document.createElement('h4');
  title.className = 'settings-provider__name';
  title.textContent = t('settings.appleCalendar');
  const badge = document.createElement('span');
  badge.className = 'badge badge--warning settings-provider__badge settings-legacy-badge';
  badge.textContent = t('settings.legacy');
  header.append(title, badge);
  section.appendChild(header);

  const status = document.createElement('p');
  status.className = 'settings-sync-info__status';
  status.textContent = providerConnectionStatus(appleStatus);
  section.appendChild(status);
  appendSyncError(status, appleStatus?.lastError);

  const legacyHint = document.createElement('p');
  legacyHint.className = 'form-hint settings-legacy-hint';
  legacyHint.textContent = t('settings.appleLegacyHint');
  section.appendChild(legacyHint);

  const cleanup = (!appleStatus?.connected && user?.role === 'admin')
    ? buildMirroredCleanup({
      count: appleStatus?.mirroredEvents || 0,
      endpoint: '/calendar/apple/mirrored-events',
    })
    : null;

  if (appleStatus?.configured) {
    const actions = document.createElement('div');
    actions.className = 'settings-sync-actions';

    const syncBtn = document.createElement('button');
    syncBtn.type = 'button';
    syncBtn.className = 'btn btn--secondary';
    syncBtn.textContent = t('settings.syncNow');
    syncBtn.addEventListener('click', async () => {
      syncBtn.disabled = true;
      syncBtn.textContent = t('settings.synchronizing');
      try {
        await api.post('/calendar/apple/sync', {});
        showToast(t('settings.syncSuccess', { provider: 'Apple Calendar' }), 'success');
      } catch (err) {
        showToast(err.message || t('common.errorGeneric'), 'danger');
      } finally {
        syncBtn.disabled = false;
        syncBtn.textContent = t('settings.syncNow');
      }
    });
    actions.appendChild(syncBtn);

    if (appleStatus.connected && user?.role === 'admin') {
      const disconnectBtn = document.createElement('button');
      disconnectBtn.type = 'button';
      disconnectBtn.className = 'btn btn--danger-outline';
      disconnectBtn.textContent = t('settings.disconnect');
      disconnectBtn.addEventListener('click', async () => {
        if (!await confirmModal(t('settings.appleDisconnectConfirm'),
          { danger: true, detail: t('settings.appleDisconnectConfirmDetail') })) return;
        const deleteEvents = await askDeleteMirrored(appleStatus.mirroredEvents);
        try {
          await api.delete(`/calendar/apple/disconnect?deleteEvents=${deleteEvents ? 'true' : 'false'}`);
          showToast(t('settings.disconnectedToast', { provider: 'Apple Calendar' }), 'default');
          window.yuvomi?.navigate('/settings/sync/calendar');
        } catch (err) {
          showToast(err.message || t('common.errorGeneric'), 'danger');
        }
      });
      actions.appendChild(disconnectBtn);
    }
    section.appendChild(actions);
  } else if (user?.role === 'admin') {
    section.appendChild(buildAppleConnectForm());
  } else {
    section.appendChild(buildProviderHint(t('settings.appleOnlyAdmin')));
  }
  if (cleanup) section.appendChild(cleanup);

  return section;
}

function buildAppleConnectForm() {
  const form = document.createElement('form');
  form.className = 'settings-form settings-form--compact';
  form.insertAdjacentHTML('beforeend', `
    <div class="form-group">
      <label class="form-label" for="apple-caldav-url">${t('settings.caldavUrlLabel')}</label>
      <input class="form-input" type="url" id="apple-caldav-url" placeholder="${t('settings.caldavUrlPlaceholder')}" required />
    </div>
    <div class="form-group">
      <label class="form-label" for="apple-username">${t('settings.appleIdLabel')}</label>
      <input class="form-input" type="email" id="apple-username" autocomplete="username" required />
    </div>
    <div class="form-group">
      <label class="form-label" for="apple-password">${t('settings.applePasswordLabel')}</label>
      <input class="form-input" type="password" id="apple-password" autocomplete="current-password" required />
      <span class="form-hint">${t('settings.applePasswordHint')}</span>
    </div>
    <div id="apple-connect-error" class="form-error" role="alert" hidden></div>
    <button type="submit" class="btn btn--primary" id="apple-connect-btn">${t('settings.appleConnectBtn')}</button>
  `);

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const errorEl = form.querySelector('#apple-connect-error');
    errorEl.hidden = true;
    const url = form.querySelector('#apple-caldav-url').value.trim();
    const username = form.querySelector('#apple-username').value.trim();
    const password = form.querySelector('#apple-password').value;
    const btn = form.querySelector('#apple-connect-btn');

    btn.disabled = true;
    btn.textContent = t('settings.appleConnecting');
    try {
      await api.post('/calendar/apple/connect', { url, username, password });
      showToast(t('settings.appleConnectedToast'), 'success');
      window.yuvomi?.navigate('/settings/sync/calendar');
    } catch (err) {
      errorEl.textContent = err.message || t('common.errorGeneric');
      errorEl.hidden = false;
    } finally {
      btn.disabled = false;
      btn.textContent = t('settings.appleConnectBtn');
    }
  });

  return form;
}

async function renderMoreProviders(container, user) {
  const host = container.querySelector('#sync-more-providers-container');
  if (!host) return;

  let googleStatus = null;
  let appleStatus = null;
  let outlookStatus = null;
  const [gRes, aRes, oRes] = await Promise.allSettled([
    api.get('/calendar/google/status'),
    api.get('/calendar/apple/status'),
    api.get('/calendar/outlook/status'),
  ]);
  if (gRes.status === 'fulfilled') googleStatus = gRes.value;
  if (aRes.status === 'fulfilled') appleStatus = aRes.value;
  if (oRes.status === 'fulfilled') outlookStatus = oRes.value?.data;

  const panel = document.createElement('div');
  panel.className = 'settings-providers';
  panel.appendChild(buildGoogleProvider(googleStatus, user));
  panel.appendChild(buildOutlookProvider(outlookStatus, user));
  panel.appendChild(buildAppleProvider(appleStatus, user));

  const disclosure = createDisclosure({
    id: MORE_PROVIDERS_ID,
    summary: t('settings.moreProviders'),
    expanded: false,
    content: panel,
  });
  host.replaceChildren(disclosure);
  window.lucide?.createIcons({ el: host });
}

// --------------------------------------------------------------------------
// OAuth callback banner
// --------------------------------------------------------------------------

function expandMoreProviders(container, provider) {
  const trigger = container.querySelector(`#${MORE_PROVIDERS_ID}-trigger`);
  const panel = container.querySelector(`#${MORE_PROVIDERS_ID}-panel`);
  if (trigger && panel) {
    trigger.setAttribute('aria-expanded', 'true');
    panel.hidden = false;
    trigger.focus({ preventScroll: true });
  }
  const providerPanelId = provider === 'apple'
    ? `${APPLE_PROVIDER_ID}-panel`
    : provider === 'outlook'
      ? `${OUTLOOK_PROVIDER_ID}-panel`
      : `${GOOGLE_PROVIDER_ID}-panel`;
  container.querySelector(`#${providerPanelId}`)?.scrollIntoView({ block: 'nearest' });
}

function handleOAuthCallback(container, query) {
  const params = query instanceof URLSearchParams
    ? query
    : new URLSearchParams(query || '');
  const syncOk = params.get('sync_ok');
  const syncErr = params.get('sync_error');
  if (!syncOk && !syncErr) return;

  const banner = container.querySelector('#sync-calendar-banner');
  if (banner) {
    const provider = syncOk || syncErr;
    const successKeys = {
      google: 'settings.syncSuccessGoogle',
      outlook: 'settings.syncSuccessOutlook',
      apple: 'settings.syncSuccessApple',
    };
    const errorKeys = {
      google: 'settings.syncErrorGoogle',
      outlook: 'settings.syncErrorOutlook',
      apple: 'settings.syncErrorApple',
    };
    const message = syncOk
      ? t(successKeys[syncOk] || 'settings.syncSuccessApple')
      : t(errorKeys[syncErr] || 'settings.syncErrorApple');
    const el = document.createElement('div');
    el.className = `settings-banner ${syncOk ? 'settings-banner--success' : 'settings-banner--error'}`;
    el.setAttribute('role', syncOk ? 'status' : 'alert');
    el.textContent = message;
    banner.replaceChildren(el);
    expandMoreProviders(container, provider);
  }

  // Strip only the OAuth callback parameters, keep everything else.
  try {
    const url = new URL(location.href);
    url.searchParams.delete('sync_ok');
    url.searchParams.delete('sync_error');
    history.replaceState(history.state, '', url.pathname + url.search + url.hash);
  } catch {
    // location parsing can fail in restricted contexts; ignore.
  }
}

// --------------------------------------------------------------------------
// Entry point
// --------------------------------------------------------------------------

export async function render(container, { user, query } = {}) {
  renderPage(container, user);
  bindCalDAVAddButton(container, user);

  await loadCalDAVAccounts(container, user);
  await renderMoreProviders(container, user);

  handleOAuthCallback(container, query);

  window.lucide?.createIcons({ el: container });
}
