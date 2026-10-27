import { api } from '/api.js';
import { t } from '/i18n.js';
import { dateText, dateTimeText } from '/utils/date-format.js';
import {
  captureModalContext,
  captureOpenContext,
  closeModal,
  confirmModal,
  isModalContextCurrent,
  openModal,
  refocusAfterRender,
  reportFieldErrors,
  constraintErrors,
} from '/components/modal.js';
import {
  createDisclosure,
  createInlineError,
  createRetryState,
  createSettingRow,
  createStatusSummary,
  hintFoldHtml,
  settingRowHtml,
  settingSwitchRowHtml,
} from '/settings/components.js';
import { withBusy } from '/utils/ux.js';
import { formRowHtml, formRowsHtml } from '/utils/form-row.js';
import { esc, REQUIRED_MARK } from '/utils/html.js';
import { loadFamilyUsers } from '/settings/family-users.js';
import { buildAssigneeMenu } from '/settings/assignee-menu.js';
import { reloadAfterSave } from '/utils/reload-after-save.js';
import { errorSentence, loadErrorSentence } from '/utils/friendly-error.js';

// Seit R23 ein eigenes Blatt (registry.js, D14; R10-R22 ein Abschnitt im
// Blatt Kalender). Neu laden heisst, das Blatt neu zu zeichnen - nicht ueber
// die Alt-Adresse, die erst umleitet.
const SYNC_CALENDAR_HREF = '/settings/modules/calendar-sync?section=sync-calendar';

const MORE_PROVIDERS_ID = 'sync-more-providers';
const GOOGLE_PROVIDER_ID = 'sync-provider-google';
const APPLE_PROVIDER_ID = 'sync-provider-apple';
const OUTLOOK_PROVIDER_ID = 'sync-provider-outlook';

function formatSyncTime(value) {
  if (!value) return null;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  return dateTimeText(date);
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

    ${user?.role === 'admin' ? `
      <section class="settings-section">
        <h2 class="settings-section__title">${t('settings.sync.backfillTitle')}</h2>
        <div class="settings-card">
          ${hintFoldHtml({ lead: t('settings.sync.backfillDescription'), moreHtml: `<p>${esc(t('settings.sync.backfillDescriptionMore'))}</p>` })}
          <div class="settings-form-actions">
            <button type="button" class="btn btn--secondary" id="sync-default-assignee-backfill-btn">
              ${t('settings.sync.backfillAction')}
            </button>
          </div>
        </div>
      </section>
    ` : ''}
  `);
}

// --------------------------------------------------------------------------
// Standard-Zuweisung auf bereits importierte Termine nachtragen (#1154)
// --------------------------------------------------------------------------

/**
 * Eine Aktion für alle Konten, nicht je Kalender: jeder Kalender mit
 * Standard-Zuweisung füllt seine eigenen, noch unzugewiesenen Termine. Die
 * Zahl kommt vor der Rückfrage vom Server, weil sich die Aktion nur Termin
 * für Termin zurücknehmen lässt. Die Rückfrage steht AUSSERHALB von withBusy:
 * sonst gäbe der Dialog den Fokus an einen deaktivierten Knopf zurück.
 *
 * Dazu Termine, die vor #1306 in einen anderen Kalender desselben Kontos
 * umgezogen sind und noch dessen Person tragen (#1307). Sie lassen sich in den
 * Daten nicht von einem Kalender trennen, dessen Standard-Person später
 * umgestellt wurde - deshalb listet die Rückfrage sie einzeln ("Titel, Datum,
 * X -> Y"), der Admin wählt ab, was bleiben soll, und nur die abgehakten
 * gehen mit der Bestätigung zurück.
 */
function bindDefaultAssigneeBackfill(container) {
  const btn = container.querySelector('#sync-default-assignee-backfill-btn');
  if (!btn) return;
  const endpoint = '/calendar/external-calendars/default-assignee-backfill';

  // Eine Seite der Vorschau holen. Wer währenddessen wegnavigiert, bekommt die
  // Rückfrage nicht über eine fremde Seite gelegt - bestätigt würde sonst eine
  // Aktion, deren Seite gar nicht mehr offen ist.
  const loadPage = async (after) => {
    const context = captureModalContext();
    let data = null;
    try {
      await withBusy(btn, async () => {
        const query = after ? `?moved_after=${encodeURIComponent(after)}` : '';
        data = (await api.get(`${endpoint}${query}`)).data ?? {};
      });
    } catch (err) {
      if (isModalContextCurrent(context)) showToast(errorSentence(err), 'danger');
      return null;
    }
    if (!isModalContextCurrent(context)) return null;
    const moved = Array.isArray(data.moved) ? data.moved : [];
    return {
      count: data.count ?? 0,
      token: data.token ?? null,
      moved,
      total: Number.isInteger(data.moved_total) ? data.moved_total : moved.length,
      offset: Number.isInteger(data.moved_offset) ? data.moved_offset : 0,
      next: typeof data.moved_next === 'string' ? data.moved_next : null,
    };
  };

  // Zahl und Fingerabdruck der gezählten Menge gehen mit: hat sich die Menge
  // seit der Zählung geändert - auch bei gleicher Größe (#1171) -, weist der
  // Server mit 409 ab, statt mehr oder andere Termine zu füllen, als die
  // Rückfrage genannt hat. Jeder abgehakte Umzug nennt Termin, bisherige und
  // neue Person, so wie die Liste ihn gezeigt hat (#1307).
  const apply = async (page, moves) => {
    let ok = false;
    await withBusy(btn, async () => {
      try {
        const res = await api.post(endpoint, { expected_count: page.count, expected_token: page.token, moves });
        showToast(t('settings.sync.backfillDone', { count: res.data?.assigned ?? 0 }), 'success');
        ok = true;
      } catch (err) {
        if (err.status === 409) showToast(t('settings.sync.backfillChanged'), 'warning');
        else showToast(errorSentence(err), 'danger');
      }
    });
    return ok;
  };

  btn.addEventListener('click', async () => {
    // loadPage() gibt ohne seinen Kontext schon null zurueck; die Frage, die
    // aus der Antwort entsteht, prueft ihn hier noch einmal dort, wo der
    // Scanner aus test/late-modal-close.js ihn sieht (#2134).
    const context = captureOpenContext();
    let page = await loadPage(null);
    if (!page || !isModalContextCurrent(context)) return;
    if (page.count === 0 && page.moved.length === 0) {
      showToast(t('settings.sync.backfillNone'));
      return;
    }
    if (page.moved.length === 0) {
      const confirmed = await confirmModal(t('settings.sync.backfillQuestion', { count: page.count }), {
        confirmLabel: t('settings.sync.backfillConfirm'),
        detail: t('settings.sync.backfillDetail'),
      });
      if (confirmed) await apply(page, []);
      return;
    }

    // Seite für Seite (#1307): bestätigt wird je Seite, "Nächste anzeigen"
    // blättert ohne Übernehmen weiter. Der Zeiger zeigt hinter den letzten
    // gezeigten Termin - abgewählte bleiben davor liegen und halten die nächste
    // Seite nicht auf.
    for (;;) {
      const choice = await pickMovedCandidates(page);
      if (!choice) return;
      if (choice.action === 'apply' && !(await apply(page, choice.moves))) return;
      if (!page.next) return;
      page = await loadPage(page.next);
      if (!page || page.moved.length === 0) return;
    }
  });
}

function movedCandidateMeta(entry) {
  const value = String(entry.start_datetime || '');
  const timed = !entry.all_day && value.length > 10;
  const when = timed ? dateTimeText(value) : dateText(value);
  return [when, entry.calendar_name].filter(Boolean).join(' · ');
}

/**
 * Die Rückfrage mit Einzelliste (#1307), eine Seite. Alle umgezogenen Termine
 * sind vorausgewählt; abgewählt bleibt ein Termin, wie er ist.
 *
 * @param {{ count: number, moved: object[], total: number, offset: number,
 *   next: string|null }} page eine Seite der Vorschau: `count` Termine ohne
 *   Zuweisung (werden pauschal gefüllt), `moved` die Einträge dieser Seite,
 *   `total`/`offset` für "Termine N bis M von X", `next` gibt es eine weitere
 * @returns {Promise<{ action: 'apply', moves: {event_id: number, from_user_id: number,
 *   to_user_id: number}[] } | { action: 'next' } | null>} null bei Abbruch
 */
function pickMovedCandidates({ count, moved, total, offset, next }) {
  return new Promise((resolve) => {
    let resolved = false;
    const finish = (value) => {
      if (resolved) return;
      resolved = true;
      closeModal({ force: true });
      resolve(value);
    };
    // Der Hinweis nennt die Seite und die beiden Knöpfe - nur, solange es eine
    // nächste Seite gibt. Die letzte Seite zeigt den Rest ohne ihn.
    const paged = Boolean(next) && total > moved.length;

    const rows = moved.map((entry, index) => `
      <label class="backfill-moved__item">
        <input type="checkbox" data-index="${index}" checked>
        <span class="backfill-moved__body">
          <span class="backfill-moved__title">${esc(entry.title || '')}</span>
          <span class="backfill-moved__meta">${esc(movedCandidateMeta(entry))}</span>
          <span class="backfill-moved__change">${esc(t('settings.sync.backfillMovedChange', { from: entry.from_name ?? '', to: entry.to_name ?? '' }))}</span>
        </span>
      </label>`).join('');

    openModal({
      pointerDeadTime: true,
      title: t('settings.sync.backfillTitle'),
      size: 'md',
      content: `
        <form id="backfill-review-form" class="backfill-review" novalidate>
          ${count > 0 ? `
            <section class="backfill-review__part">
              <h3 class="backfill-review__heading">${esc(t('settings.sync.backfillFillCount', { count }))}</h3>
              <p class="modal-confirm__detail">${esc(t('settings.sync.backfillDetail'))}</p>
            </section>` : ''}
          <fieldset class="backfill-review__part backfill-moved" aria-describedby="backfill-moved-hint">
            <legend class="backfill-review__heading">${esc(t('settings.sync.backfillMovedTitle'))}</legend>
            <p class="modal-confirm__detail" id="backfill-moved-hint">${esc(t('settings.sync.backfillMovedHint'))}</p>
            ${paged ? `
              <p class="modal-confirm__detail backfill-moved__partial">${esc(t('settings.sync.backfillMovedPartial', { first: offset + 1, last: offset + moved.length, total }))}</p>` : ''}
            ${moved.length > 1 ? `
              <label class="form-check backfill-moved__all">
                <input type="checkbox" id="backfill-moved-all" checked>
                <span>${esc(t('settings.sync.backfillMovedAll'))}</span>
              </label>` : ''}
            <div class="backfill-moved__list">${rows}</div>
          </fieldset>
          <div class="modal-panel__footer modal-panel__footer--plain">
            <button type="button" class="btn btn--secondary" id="backfill-review-cancel">${esc(t('common.cancel'))}</button>
            ${next ? `<button type="button" class="btn btn--secondary" id="backfill-review-next">${esc(t('settings.sync.backfillMovedNext'))}</button>` : ''}
            <button type="submit" class="btn btn--primary" id="backfill-review-ok">${esc(t('settings.sync.backfillConfirm'))}</button>
          </div>
        </form>`,
      onClose: () => finish(null),
      onSave(panel) {
        const form = panel.querySelector('#backfill-review-form');
        const all = panel.querySelector('#backfill-moved-all');
        const ok = panel.querySelector('#backfill-review-ok');
        const boxes = [...panel.querySelectorAll('.backfill-moved__list input[type="checkbox"]')];

        // Ohne leere Termine und ohne Haken gäbe es nichts zu tun.
        const sync = () => {
          const checked = boxes.filter((b) => b.checked).length;
          if (all) {
            all.checked = checked === boxes.length;
            all.indeterminate = checked > 0 && checked < boxes.length;
          }
          ok.disabled = count === 0 && checked === 0;
        };
        all?.addEventListener('change', () => {
          for (const box of boxes) box.checked = all.checked;
          sync();
        });
        panel.querySelector('.backfill-moved__list').addEventListener('change', sync);
        panel.querySelector('#backfill-review-cancel').addEventListener('click', () => finish(null));
        panel.querySelector('#backfill-review-next')?.addEventListener('click', () => finish({ action: 'next' }));
        form.addEventListener('submit', (event) => {
          event.preventDefault();
          if (ok.disabled) return;
          finish({
            action: 'apply',
            moves: boxes.filter((b) => b.checked).map((b) => {
              const entry = moved[Number(b.dataset.index)];
              // Mengen (#1897): genau die Personen, die die Vorschau gezeigt hat.
              return { event_id: entry.event_id, from_user_ids: entry.from_user_ids, to_user_ids: entry.to_user_ids };
            }),
          });
        });
        sync();
      },
    });
  });
}

// --------------------------------------------------------------------------
// Standard-Zuweisung pro Kalender-Sync-Ziel (#459)
// --------------------------------------------------------------------------

/**
 * Die Standard-Personen einer synchronisierten Kalenderzeile (Google/Apple/
 * CalDAV, #459, #1897): ein Knopf mit den Namen, der ein Menue mit einem
 * Schalter je Person oeffnet (assignee-menu.js). Jeder Haken schreibt sofort
 * ueber PATCH /calendar/external-calendars. Das Panel steht in `host`, nicht
 * im Zeilen-Label.
 */
function buildCalendarAssigneeMenu({ source, externalId, currentIds, host }) {
  return buildAssigneeMenu({
    currentIds,
    host,
    save: (ids) => api.patch('/calendar/external-calendars', {
      source,
      external_id: externalId,
      default_assignee_user_ids: ids,
    }),
    onSaved: () => showToast(t('settings.ics.updatedToast'), 'success'),
    onError: (err) => showToast(errorSentence(err), 'danger'),
  });
}

// --------------------------------------------------------------------------
// CalDAV calendar accounts
// --------------------------------------------------------------------------

let calendarListSeq = 0;
let calendarNameSeq = 0;

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
    // Nur lesbar geteilt (#1840): lesen geht, als Ziel neuer Termine wird
    // der Kalender nicht angeboten. Wartet schon etwas auf den Upload
    // hierher, nennt die Zeile die Zahl - ein gespeichertes Ziel wird nicht
    // still geleert.
    if (cal.writable === false) {
      const note = document.createElement('span');
      note.className = 'caldav-calendar-source';
      note.textContent = cal.waitingUploads > 0
        ? t('settings.caldavCalendarReadOnlyWaiting', { count: cal.waitingUploads })
        : t('settings.caldavCalendarReadOnly');
      name.appendChild(note);
    }

    label.append(checkbox, color, name);
    // Der Haken heisst wie der Kalender. Als Label-Text trug sein Name sonst
    // auch den Personen-Knopf mit, der in derselben Zeile steht (#1897).
    name.id = `caldav-calendar-name-${++calendarNameSeq}`;
    checkbox.setAttribute('aria-labelledby', name.id);
    // VOR DEM HAKEN, NICHT NACH DEM SYNC: Das Feld stand früher erst da, wenn
    // der Kalender aktiv UND einmal synchronisiert war - also frühestens, als
    // der erste Schwung Termine bereits ohne Zuweisung hereingekommen war, bei
    // Serien Dutzende (#730). Jetzt lässt es sich vorher setzen; der PATCH legt
    // die external_calendars-Zeile nötigenfalls selbst an, und der spätere Sync
    // aktualisiert daran nur Name und Farbe.
    label.appendChild(buildCalendarAssigneeMenu({
      source: 'caldav',
      externalId: cal.calendarUrl,
      currentIds: cal.default_assignee_user_ids,
      host: list,
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
      await reloadAfterSave(() => refresh());
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
    routingHint.textContent = t('settings.sync.defaultAssigneesRoutingHint');
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

/** Das Pflichtzeichen hinter einem Etikett - Markup, kein Text (aria-hidden). */

function bindCalDAVAddButton(container, user) {
  const addBtn = container.querySelector('#caldav-add-account-btn');
  if (!addBtn) return;
  addBtn.addEventListener('click', () => {
    openModal({
      title: t('settings.caldavAddAccount'),
      size: 'sm',
      content: `
        <form id="caldav-add-form" novalidate autocomplete="off">
          ${/* DER DIALOG SPRICHT DENSELBEN DIALEKT (R19, B7): Zeilen im Traeger,
               Etikett links, Feld rechts, Hinweis unter der Zeile - die Form
               der iOS-Kontoanlage. Jede Zeile ist die Fehlergruppe ihres Felds. */ ''}
          ${formRowsHtml([
            formRowHtml({
              label: t('settings.caldavNameLabel'), labelFor: 'caldav-name', labelExtra: REQUIRED_MARK, field: true,
              control: `<input class="form-input" type="text" id="caldav-name" required
                   placeholder="${t('settings.caldavNamePlaceholder')}" maxlength="100" />`,
            }),
            formRowHtml({
              label: t('settings.caldavUrlLabel'), labelFor: 'caldav-url', labelExtra: REQUIRED_MARK, field: true,
              description: t('settings.caldavUrlHint'), descriptionId: 'caldav-url-hint',
              control: `<input class="form-input" type="url" id="caldav-url" required aria-describedby="caldav-url-hint"
                   placeholder="${t('settings.caldavUrlPlaceholder')}" />`,
            }),
            formRowHtml({
              label: t('settings.caldavUsernameLabel'), labelFor: 'caldav-username', labelExtra: REQUIRED_MARK, field: true,
              control: '<input class="form-input" type="text" id="caldav-username" required autocomplete="off" />',
            }),
            formRowHtml({
              label: t('settings.caldavPasswordLabel'), labelFor: 'caldav-password', labelExtra: REQUIRED_MARK, field: true,
              description: t('settings.caldavPasswordHint'), descriptionId: 'caldav-password-hint',
              control: '<input class="form-input" type="password" id="caldav-password" required autocomplete="new-password" aria-describedby="caldav-password-hint" />',
            }),
          ])}
          <div id="caldav-add-error" class="form-error" role="alert" hidden></div>
          <div class="modal-panel__footer modal-panel__footer--plain">
            <button type="button" class="btn btn--secondary" id="caldav-add-cancel">${t('common.cancel')}</button>
            <button type="submit" class="btn btn--primary">${t('common.add')}</button>
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

          // Geschlossen wird nur dieser Dialog, nicht einer, der waehrend der
          // Anfrage aufgegangen ist (#1997).
          const modalContext = captureModalContext();
          try {
            await api.post('/calendar/caldav/accounts', {
              name,
              caldavUrl,
              username,
              password,
            });
            closeModal({ force: true, context: modalContext });
            showToast(t('settings.caldavAccountAdded'), 'success');
            await reloadAfterSave(() => loadCalDAVAccounts(container, user));
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
  // Google hat das Token abgelehnt (#2019): derselbe Text wie bei Outlook statt
  // "Verbunden", denn ohne neues OAuth synchronisiert hier nichts mehr.
  const reauth = Boolean(googleStatus?.connected && googleStatus.needsReauth);

  // EINE Stelle für jede Google-Antwort, die das abgelehnte Token meldet: der
  // Status oben ist dann veraltet, also neu holen und die Karte im neuen Zustand
  // aufbauen. Jeder Aufruf der Karte läuft über `googleCall` und damit hier
  // vorbei (Kalenderauswahl, Kalender an/aus, Jetzt synchronisieren,
  // Schreibschutz). Status und Trennen fragen Google nicht. Der Fehler geht danach mit `reauthHandled` weiter:
  // der Aufrufer nimmt seinen Zustand zurück, zeigt aber keinen Toast mehr.
  const handleReauth = async (err) => {
    if (err?.data?.reason !== GOOGLE_REAUTH_REASON) return false;
    const fresh = await api.get('/calendar/google/status').catch(() => null);
    // Nur wenn die Karte wirklich neu steht: sonst zeigt der Aufrufer den
    // ursprünglichen Fehler, statt still auf einer veralteten Karte zu bleiben.
    if (!fresh?.needsReauth) return false;
    section.replaceWith(buildGoogleProvider(fresh, user));
    return true;
  };
  const googleCall = async (request) => {
    try {
      return await request();
    } catch (err) {
      if (await handleReauth(err)) err.reauthHandled = true;
      throw err;
    }
  };
  status.textContent = reauth
    ? t('settings.outlookReauthRequired')
    : providerConnectionStatus(googleStatus);
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
    // Fuer den Admin eine Anleitung statt der Sackgasse (#2221); die
    // Statuszeile oben sagt "Nicht konfiguriert" schon, ein zweites Mal
    // derselbe Satz half niemandem weiter.
    section.appendChild(user?.role === 'admin'
      ? buildGoogleSetupGuide(googleStatus)
      : buildProviderHint(t('settings.notConfigured')));
    if (cleanup) section.appendChild(cleanup);
    return section;
  }

  // Auswahl und Schreibschutz brauchen ein gültiges Token - bis zum neuen
  // Verbinden bleiben sie weg, statt mit einem Fehler zu laden.
  if (googleStatus.connected && !reauth && user?.role === 'admin') {
    // Stellt erst der Kalenderabruf fest, dass Google das Token ablehnt, ist der
    // Status oben veraltet: neu holen und die Karte im neuen Zustand aufbauen.
    section.appendChild(buildGoogleCalendarPicker(googleCall));
    section.appendChild(buildGoogleReadonlyToggle(googleStatus, googleCall));
  }

  const actions = document.createElement('div');
  actions.className = 'settings-sync-actions';
  if (googleStatus.connected && reauth) {
    if (user?.role === 'admin') {
      const reconnect = document.createElement('a');
      reconnect.href = '/api/v1/calendar/google/auth';
      reconnect.className = 'btn btn--primary';
      reconnect.textContent = t('settings.outlookReconnect');
      actions.appendChild(reconnect);
      actions.appendChild(buildGoogleDisconnectButton(googleStatus));
    } else {
      section.appendChild(buildProviderHint(t('settings.googleOnlyAdmin')));
    }
  } else if (googleStatus.connected) {
    const syncBtn = document.createElement('button');
    syncBtn.type = 'button';
    syncBtn.className = 'btn btn--secondary';
    syncBtn.textContent = t('settings.syncNow');
    syncBtn.addEventListener('click', async () => {
      syncBtn.disabled = true;
      syncBtn.textContent = t('settings.synchronizing');
      try {
        await googleCall(() => api.post('/calendar/google/sync', {}));
        showToast(t('settings.syncSuccess', { provider: 'Google Calendar' }), 'success');
      } catch (err) {
        if (err.reauthHandled) return;
        showToast(googleErrorSentence(err), 'danger');
      } finally {
        syncBtn.disabled = false;
        syncBtn.textContent = t('settings.syncNow');
      }
    });
    actions.appendChild(syncBtn);

    if (user?.role === 'admin') {
      actions.appendChild(buildGoogleDisconnectButton(googleStatus));
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

/** Trennen-Knopf der Google-Karte: im verbundenen wie im abgelehnten Zustand. */
function buildGoogleDisconnectButton(googleStatus) {
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
      window.yuvomi?.navigate(SYNC_CALENDAR_HREF);
    } catch (err) {
      showToast(errorSentence(err), 'danger');
    }
  });
  return disconnectBtn;
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
        showToast(errorSentence(err), 'danger');
      }
    });
  });
  actions.appendChild(btn);
  group.appendChild(actions);

  return group;
}

const GOOGLE_SETUP_GUIDE_URL = 'https://github.com/ulsklyc/yuvomi/blob/main/docs/installation.md#google-calendar-sync-optional';
const GOOGLE_CALLBACK_PATH = '/api/v1/calendar/google/callback';
const CALENDAR_SUBSCRIPTIONS_HREF = '/settings/modules/calendar?section=personal-calendar-subscriptions';
const GOOGLE_ENV_KEYS = ['GOOGLE_CLIENT_ID', 'GOOGLE_CLIENT_SECRET', 'GOOGLE_REDIRECT_URI'];

/**
 * Nimmt Google diese Rueckrufadresse an? Google verlangt HTTPS und einen
 * Hostnamen, `localhost` ist ausgenommen (docs/installation.md, "Setting it up
 * at Google"). Eine IP-Adresse oder http faellt dort erst nach dem Eintragen
 * auf - hier soll es vorher auffallen.
 */
function googleAcceptsRedirect(uri) {
  let url;
  try { url = new URL(uri); } catch { return false; }
  const host = url.hostname.replace(/^\[|\]$/g, '');
  if (host === 'localhost') return true;
  const isIp = /^\d{1,3}(\.\d{1,3}){3}$/.test(host) || host.includes(':');
  return url.protocol === 'https:' && !isIp;
}

/**
 * Kopiert den Wert eines Feldes und sagt, ob es wirklich geklappt hat. Ueber
 * http im Heimnetz - genau dort, wo die Einrichtung meist passiert - gibt es
 * `navigator.clipboard` nicht; dann bleibt der Auswahl-Weg, und das Feld steht
 * markiert, falls auch der scheitert. Dasselbe Muster wie `copyInviteLink`
 * (admin-family.js).
 */
async function copyFieldValue(input) {
  if (navigator.clipboard?.writeText) {
    try {
      await navigator.clipboard.writeText(input.value);
      return true;
    } catch { /* auf den Auswahl-Weg zurueckfallen */ }
  }
  try {
    input.focus();
    input.select();
    return document.execCommand('copy') === true;
  } catch {
    return false;
  }
}

function iconNote(icon, ...content) {
  const note = document.createElement('p');
  note.className = 'settings-provider-note settings-provider-note--hint';
  const glyph = document.createElement('i');
  glyph.dataset.lucide = icon;
  glyph.setAttribute('aria-hidden', 'true');
  const text = document.createElement('span');
  text.append(...content);
  note.append(glyph, text);
  return note;
}

function envName(name) {
  const code = document.createElement('code');
  code.textContent = name;
  return code;
}

/**
 * Die Google-Karte, solange die OAuth-Zugangsdaten fehlen (#2221): was fehlt,
 * welche Rueckrufadresse bei Google hingehoert, die vier Schritte, und daneben
 * die Wege ganz ohne Google-Einrichtung. Nur Namen von Variablen, nie Werte.
 */
function buildGoogleSetupGuide(googleStatus) {
  const guide = document.createElement('div');
  guide.className = 'settings-provider__setup';

  const missing = Array.isArray(googleStatus?.missingEnv) && googleStatus.missingEnv.length
    ? googleStatus.missingEnv
    : GOOGLE_ENV_KEYS;
  const names = [];
  missing.forEach((name, i) => {
    if (i) names.push(', ');
    names.push(envName(name));
  });
  guide.appendChild(iconNote('key-round', `${t('settings.googleSetupMissing')} `, ...names));

  const steps = document.createElement('ol');
  steps.className = 'settings-provider__steps';
  const step = (...content) => {
    const li = document.createElement('li');
    li.append(...content);
    steps.appendChild(li);
    return li;
  };
  step(t('settings.googleSetupStepApi'));
  step(t('settings.googleSetupStepConsent'));

  const redirectUri = googleStatus?.redirectUri || `${window.location.origin}${GOOGLE_CALLBACK_PATH}`;
  const uriId = 'google-setup-redirect-uri';
  const uriStep = step(t('settings.googleSetupStepClient'));
  const uriRow = document.createElement('div');
  uriRow.className = 'settings-provider__copy-row';
  const uriInput = document.createElement('input');
  uriInput.id = uriId;
  uriInput.className = 'form-input';
  uriInput.type = 'text';
  uriInput.readOnly = true;
  uriInput.value = redirectUri;
  uriInput.setAttribute('aria-label', t('settings.googleSetupRedirectLabel'));
  const copy = document.createElement('button');
  copy.type = 'button';
  copy.className = 'btn btn--secondary';
  copy.textContent = t('settings.googleSetupCopy');
  copy.addEventListener('click', async () => {
    const copied = await copyFieldValue(uriInput);
    showToast(t(copied ? 'settings.googleSetupCopied' : 'settings.googleSetupCopyFailed'), copied ? 'success' : 'danger');
  });
  uriRow.append(uriInput, copy);
  uriStep.appendChild(uriRow);
  if (!googleAcceptsRedirect(redirectUri)) {
    const warn = document.createElement('p');
    warn.className = 'form-hint';
    warn.textContent = t('settings.googleSetupRedirectHttps');
    uriStep.appendChild(warn);
  }

  step(t('settings.googleSetupStepEnv'), ' ', envName('GOOGLE_CLIENT_ID'), ', ', envName('GOOGLE_CLIENT_SECRET'), ', ', envName('GOOGLE_REDIRECT_URI'));
  guide.appendChild(steps);

  const more = document.createElement('p');
  more.className = 'settings-provider-note';
  const link = document.createElement('a');
  link.href = GOOGLE_SETUP_GUIDE_URL;
  link.target = '_blank';
  link.rel = 'noopener noreferrer';
  link.textContent = t('settings.googleSetupGuideLink');
  more.appendChild(link);
  guide.appendChild(more);

  guide.appendChild(iconNote('calendar-plus', t('settings.googleSetupWithout')));
  const actions = document.createElement('div');
  actions.className = 'settings-sync-actions';
  const alt = document.createElement('a');
  alt.className = 'btn btn--secondary';
  alt.href = CALENDAR_SUBSCRIPTIONS_HREF;
  alt.textContent = t('settings.googleSetupWithoutAction');
  alt.addEventListener('click', (event) => {
    if (!window.yuvomi?.navigate) return;
    event.preventDefault();
    window.yuvomi.navigate(CALENDAR_SUBSCRIPTIONS_HREF);
  });
  actions.appendChild(alt);
  guide.appendChild(actions);

  return guide;
}

function buildProviderHint(text) {
  const hint = document.createElement('p');
  hint.className = 'form-hint';
  hint.textContent = text;
  return hint;
}

/** Grund, mit dem /calendar/google/calendars ein abgelehntes Token meldet (#2019). */
const GOOGLE_REAUTH_REASON = 'google_reauth_required';

/**
 * Der Satz der App zu einem gescheiterten Google-Aufruf (#1695), nie der Text
 * des Servers. Konnte handleReauth die Karte nicht neu aufbauen (Status-Abruf
 * gescheitert), nennt der Toast die abgelaufene Anmeldung - in den Worten, die
 * die Outlook-Karte fuer denselben Fall hat.
 */
function googleErrorSentence(err) {
  return err?.data?.reason === GOOGLE_REAUTH_REASON ? t('settings.outlookReauthRequired') : errorSentence(err);
}

function buildGoogleCalendarPicker(googleCall) {
  // Eine Liste, kein Feld (R19): ihr Name ist keine `<label>` ohne
  // Bedienelement, und sie steht nicht im Feld-Dialekt `.form-group`.
  const group = document.createElement('div');
  group.className = 'settings-google-calendars';

  const label = document.createElement('p');
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
  routingHint.textContent = t('settings.sync.defaultAssigneesRoutingHint');
  group.appendChild(routingHint);

  (async () => {
    try {
      const { data } = await googleCall(() => api.get('/calendar/google/calendars'));
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
        name.id = `google-calendar-name-${++calendarNameSeq}`;
        checkbox.setAttribute('aria-labelledby', name.id);
        // Wie bei CalDAV vor dem Haken setzbar (#730) - hier zählt es doppelt:
        // Das Aktivieren startet den Sync unmittelbar (PATCH /google/calendars),
        // eine Zuweisung danach käme für die erste Ladung immer zu spät.
        item.appendChild(buildCalendarAssigneeMenu({
          source: 'google',
          externalId: cal.id,
          currentIds: cal.default_assignee_user_ids,
          host: list,
        }));
        list.appendChild(item);

        checkbox.addEventListener('change', async () => {
          const enabled = checkbox.checked;
          await withBusy(checkbox, async () => {
            try {
              await googleCall(() => api.patch('/calendar/google/calendars', { calendarId: cal.id, enabled }));
              showToast(
                enabled ? t('settings.calendarEnabled') : t('settings.calendarDisabled'),
                'success',
              );
            } catch (err) {
              checkbox.checked = !enabled;
              if (!err.reauthHandled) showToast(googleErrorSentence(err), 'danger');
            }
          });
        });
      }
    } catch (err) {
      if (err.reauthHandled) return;
      const p = document.createElement('p');
      p.className = 'form-hint';
      p.textContent = loadErrorSentence(err) ?? t('common.errorGeneric');
      list.replaceChildren(p);
    }
  })();

  return group;
}

function buildGoogleReadonlyToggle(googleStatus, googleCall) {
  // Eine Schalterzeile der Gruppe samt Hinweis darunter (R19, ein Dialekt).
  const group = document.createElement('div');
  group.className = 'row-carrier settings-group';
  group.insertAdjacentHTML('beforeend', settingSwitchRowHtml({
    label: t('settings.googleReadonly'),
    checked: Boolean(googleStatus.readonly),
    description: t('settings.googleReadonlyHint'),
    descriptionId: 'google-readonly-hint',
  }));
  const checkbox = group.querySelector('input');

  checkbox.addEventListener('change', async () => {
    const enabled = checkbox.checked;
    await withBusy(checkbox, async () => {
      try {
        await googleCall(() => api.put('/calendar/google/readonly', { readonly: enabled }));
      } catch (err) {
        checkbox.checked = !enabled;
        if (!err.reauthHandled) showToast(googleErrorSentence(err), 'danger');
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
          showToast(errorSentence(err), 'danger');
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
  // Zielkalender und Besitzer als Zeilen der Gruppe, der Hinweis als ihr Fuss
  // (R19, ein Dialekt) - vorher zwei Auswahlen unter ihren Etiketten.
  const wrap = document.createElement('div');
  const group = document.createElement('div');
  group.className = 'row-carrier settings-group';
  wrap.appendChild(group);
  const hint = document.createElement('p');
  hint.className = 'form-hint settings-group__footer';
  hint.textContent = t('settings.outlookAutoSyncHint');

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
  group.appendChild(createSettingRow({ label: t('settings.outlookAutoSyncCalendar'), control: calSelect }));

  // Owner (bestimmt „für mich sichtbare Termine")
  const ownerSelect = document.createElement('select');
  ownerSelect.className = 'form-input';
  const noneOpt = document.createElement('option');
  noneOpt.value = '';
  noneOpt.textContent = t('settings.outlookOwnerNone');
  ownerSelect.appendChild(noneOpt);
  loadFamilyUsers(account.ownerUserId).then((users) => {
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
  group.appendChild(createSettingRow({ label: t('settings.outlookOwner'), control: ownerSelect }));
  wrap.appendChild(hint);

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
      await reloadAfterSave(() => refresh());
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
  const refresh = () => window.yuvomi?.navigate(SYNC_CALENDAR_HREF);

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
          window.yuvomi?.navigate(SYNC_CALENDAR_HREF);
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
  // KEINE BROWSER-BLASEN (Critique R21): die Regeln des Markups melden sich
  // am Feld (constraintErrors, components/modal.js).
  form.noValidate = true;
  // EIN FORMULAR-DIALEKT (R19, Einstellungen B7): die drei Felder als Zeilen
  // der Gruppe, der Passwort-Hinweis unter seiner Zeile.
  form.insertAdjacentHTML('beforeend', `
    <div class="row-carrier settings-group">
      ${settingRowHtml({
        label: t('settings.caldavUrlLabel'), labelFor: 'apple-caldav-url', labelExtra: REQUIRED_MARK,
        control: `<input class="form-input" type="url" id="apple-caldav-url" placeholder="${t('settings.caldavUrlPlaceholder')}" required />`,
      })}
      ${settingRowHtml({
        label: t('settings.appleIdLabel'), labelFor: 'apple-username', labelExtra: REQUIRED_MARK,
        control: '<input class="form-input" type="email" id="apple-username" autocomplete="off" required />',
      })}
      ${settingRowHtml({
        label: t('settings.applePasswordLabel'), labelFor: 'apple-password', labelExtra: REQUIRED_MARK,
        description: t('settings.applePasswordHint'), descriptionId: 'apple-password-hint',
        control: '<input class="form-input" type="password" id="apple-password" autocomplete="new-password" aria-describedby="apple-password-hint" required />',
      })}
    </div>
    <div id="apple-connect-error" class="form-error" role="alert" hidden></div>
    <button type="submit" class="btn btn--primary" id="apple-connect-btn">${t('settings.appleConnectBtn')}</button>
  `);

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    if (reportFieldErrors(constraintErrors(form))) return;
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
      window.yuvomi?.navigate(SYNC_CALENDAR_HREF);
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
  bindDefaultAssigneeBackfill(container);

  await loadCalDAVAccounts(container, user);
  await renderMoreProviders(container, user);

  handleOAuthCallback(container, query);

  window.lucide?.createIcons({ el: container });
}

// Für die Suite: die Google-Karte für sich, ohne die ganze Seite (#2019).
export const __test = { buildGoogleProvider, bindCalDAVAddButton, googleAcceptsRedirect, copyFieldValue };
