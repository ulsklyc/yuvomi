import { api } from '/api.js';
import { formatDate, formatTime, t } from '/i18n.js';
import { esc } from '/utils/html.js';
import {
  closeModal,
  confirmModal,
  openModal,
  validateAll,
  wireBlurValidation,
} from '/components/modal.js';
import {
  createDisclosure,
  createInlineError,
  createRetryState,
  createStatusSummary,
} from '/settings/components.js';
import { withBusy } from '/utils/ux.js';
import { renderSkeletonList } from '/utils/skeleton.js';

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

function enabledAddressbookCount(addressbooks) {
  return addressbooks.filter((ab) => ab.enabled).length;
}

function showToast(message, tone = 'default') {
  window.yuvomi?.showToast(message, tone);
}

/**
 * Übersetzt eine Server-Fehlerantwort. Der Server liefert einen stabilen
 * `errorCode`; `err.message` ist nur eine englische Entwickler-Notiz und dient
 * als letzter Fallback - unübersetzt angezeigt wäre sie in 22 von 23 Locales
 * ein Fremdkörper.
 *
 * @param {Error & { data?: { errorCode?: string } }} err
 * @returns {string} übersetzte, anzeigbare Meldung
 */
function errorMessage(err) {
  const code = err?.data?.errorCode;
  const KEYS = {
    account_duplicate: 'settings.cardavErrorDuplicate',
    account_not_found: 'settings.cardavErrorAccountNotFound',
    addressbook_not_found: 'settings.cardavErrorAddressbookNotFound',
    internal: 'common.errorGeneric',
    invalid_id: 'common.errorGeneric',
  };
  // Validierungsfehler tragen die betroffenen Felder im Text - der ist bereits
  // vom Server zusammengesetzt und wird durchgereicht.
  if (code && code !== 'validation' && KEYS[code]) return t(KEYS[code]);
  return err?.message || t('common.errorGeneric');
}

function renderPage(container, user) {
  container.replaceChildren();
  container.insertAdjacentHTML('beforeend', `
    <!-- Kein eigener Sektionstitel: der Seitenkopf sagt bereits „Kontakt-Sync",
         eine zweite Überschrift für die einzige Sektion ist reine Wiederholung.
         aria-label hält die Sektion für Screenreader trotzdem benannt. -->
    <section class="settings-section" aria-label="${t('settings.cardavTitle')}">
      <div class="settings-card">
        <p class="settings-card-description">${t('settings.cardavDescription')}</p>
        <div id="cardav-accounts" class="settings-sync-accounts"></div>
        ${user?.role === 'admin' ? `
          <div class="settings-form-actions">
            <button type="button" class="btn btn--primary" id="cardav-add-account-btn">
              ${t('settings.cardavAddAccount')}
            </button>
          </div>
        ` : ''}
      </div>
    </section>
  `);
}

let addressbookListSeq = 0;

function buildAddressbookList(addressbooks, onToggle, { open = false, accountId = null } = {}) {
  // Die URL nur dort zeigen, wo sie unterscheidet: bei fehlendem oder
  // doppeltem Namen. Sonst ist sie Lärm in einer Liste, die eine einzige
  // Frage beantworten soll - welches Adressbuch wird synchronisiert.
  const nameCounts = new Map();
  for (const ab of addressbooks) {
    const key = (ab.name || '').trim().toLowerCase();
    nameCounts.set(key, (nameCounts.get(key) ?? 0) + 1);
  }

  const list = document.createElement('div');
  list.className = 'caldav-calendars-list';
  for (const ab of addressbooks) {
    const label = document.createElement('label');
    label.className = 'caldav-calendar-item';

    const checkbox = document.createElement('input');
    checkbox.type = 'checkbox';
    checkbox.className = 'cardav-addressbook-checkbox';
    checkbox.checked = Boolean(ab.enabled);

    const name = document.createElement('span');
    name.className = 'caldav-calendar-name';
    name.textContent = ab.name || ab.url;
    name.title = ab.name ? `${ab.name}\n${ab.url}` : ab.url;

    const ambiguous = !ab.name || (nameCounts.get(ab.name.trim().toLowerCase()) ?? 0) > 1;
    if (ambiguous && ab.url) {
      const source = document.createElement('span');
      source.className = 'caldav-calendar-source';
      source.textContent = ab.url;
      name.appendChild(source);
    }

    // Der Fehler steht an der Zeile, die ihn verursacht hat. Vorher nannte die
    // Kontokarte einen Adressbuchnamen als Fließtext, den man in der Liste
    // selbst suchen musste - und der dort nicht zwingend so heißt.
    if (ab.lastError) {
      label.classList.add('caldav-calendar-item--failed');
      const note = document.createElement('span');
      note.className = 'caldav-calendar-error';
      note.textContent = ab.lastError;
      name.appendChild(note);
    }

    label.append(checkbox, name);
    list.appendChild(label);

    checkbox.addEventListener('change', async () => {
      const enabled = checkbox.checked;
      await withBusy(checkbox, async () => {
        try {
          await api.put(`/contacts/cardav/addressbooks/${ab.id}`, { enabled });
          ab.enabled = enabled ? 1 : 0;
          syncLabel();
          onToggle?.(enabledAddressbookCount(addressbooks), addressbooks.length);
          showToast(
            enabled ? t('settings.addressbookEnabled') : t('settings.addressbookDisabled'),
            'success',
          );
        } catch (err) {
          checkbox.checked = !enabled;
          showToast(errorMessage(err), 'danger');
        }
      });
    });
  }

  // Genau eine Zahl auf dem Bildschirm: „1 von 2 Adressbüchern". Vorher standen
  // aktivierte und vorhandene Anzahl 20px auseinander und meinten Verschiedenes.
  const labelEl = document.createElement('span');
  const syncLabel = () => {
    labelEl.textContent = t('settings.addressbooksEnabledOfTotal', {
      enabled: enabledAddressbookCount(addressbooks),
      total: addressbooks.length,
      count: addressbooks.length,
    });
  };
  syncLabel();

  // Sammelschalter: bei sechs Adressbüchern waren das sechs Klicks mit sechs
  // Toasts. Ab zwei Einträgen erscheint eine Zeile, die alle auf einmal setzt -
  // ein Request-Bündel, ein Toast.
  const panel = document.createElement('div');
  if (addressbooks.length > 1 && accountId) {
    const bulk = document.createElement('div');
    bulk.className = 'caldav-bulk-actions';

    const makeBulkBtn = (labelKey, enable) => {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'btn btn--ghost btn--sm';
      btn.textContent = t(labelKey);
      btn.addEventListener('click', () => withBusy(btn, async () => {
        const targets = addressbooks.filter((ab) => Boolean(ab.enabled) !== enable);
        if (targets.length === 0) return;
        const results = await Promise.allSettled(targets.map((ab) => (
          api.put(`/contacts/cardav/addressbooks/${ab.id}`, { enabled: enable })
            .then(() => { ab.enabled = enable ? 1 : 0; })
        )));
        // Checkboxen an den tatsächlichen Stand anpassen, nicht an die Absicht:
        // scheitert ein Request, bleibt genau diese eine Zeile stehen.
        for (const [i, ab] of addressbooks.entries()) {
          const box = list.querySelectorAll('.cardav-addressbook-checkbox')[i];
          if (box) box.checked = Boolean(ab.enabled);
        }
        syncLabel();
        onToggle?.(enabledAddressbookCount(addressbooks), addressbooks.length);
        const failed = results.filter((r) => r.status === 'rejected');
        if (failed.length) {
          showToast(errorMessage(failed[0].reason), 'danger');
        } else {
          showToast(
            enable ? t('settings.allAddressbooksEnabled') : t('settings.allAddressbooksDisabled'),
            'success',
          );
        }
      }, { loadingClass: 'btn--loading' }));
      return btn;
    };

    bulk.append(
      makeBulkBtn('settings.enableAll', true),
      makeBulkBtn('settings.disableAll', false),
    );
    panel.appendChild(bulk);
  }
  panel.appendChild(list);

  // Geteilte Aufklapp-Komponente statt rohem <details>: gleiche Geste, gleicher
  // Chevron und gleiche ARIA-Verdrahtung wie in der Settings-Navigation.
  return createDisclosure({
    id: `cardav-addressbooks-${++addressbookListSeq}`,
    summary: labelEl,
    expanded: open,
    content: panel,
  });
}

function renderAccount(container, account, addressbooks, refresh, user) {
  const card = document.createElement('article');
  card.className = 'caldav-account-item';

  const enabledCount = enabledAddressbookCount(addressbooks);

  // Gleiche Grammatik wie Kalender-Sync: Status = Verbindungszustand,
  // Zähler und URL als Details, primäre Aktion im action-Slot.
  const syncBtn = document.createElement('button');
  syncBtn.type = 'button';
  // Wichtigste Aktion der Karte: akzentuiert umrandet und im Kopf-Slot. KEIN
  // btn--primary - die Seite hat bereits genau einen gefüllten CTA („Konto
  // hinzufügen"), ein zweiter je Karte würde mit ihm konkurrieren.
  syncBtn.className = 'btn btn--secondary btn--sm';
  syncBtn.textContent = t('settings.syncNow');
  syncBtn.addEventListener('click', () => {
    // Inaktiv über aria-disabled statt disabled: der Button bleibt in der
    // Tab-Ordnung, der Klick wird hier verworfen.
    if (syncBtn.getAttribute('aria-disabled') === 'true') return;
    return withBusy(syncBtn, async () => {
      try {
        await api.post(`/contacts/cardav/accounts/${account.id}/sync`);
        showToast(t('settings.cardavSyncSuccess'), 'success');
        await refresh();
      } catch (err) {
        showToast(err?.data?.errorCode ? errorMessage(err) : (err.message || t('settings.cardavSyncFailed')), 'danger');
      }
    }, { loadingClass: 'btn--loading' });
  });

  const details = [lastSyncDetail(account.lastSync)];
  // Die URL ist Nachschlage-Information, kein Status: ans Ende, nicht an den Anfang.
  if (account.cardavUrl) details.push(account.cardavUrl);

  // Ein Teilfehler des letzten Laufs schlägt den Erfolgszustand: „zuletzt
  // synchronisiert" zu melden, während ein Adressbuch scheiterte, war der Kern
  // von #534 - der Fehler stand nur im Server-Log.
  const statusText = (count) => {
    if (count === 0) return t('settings.noAddressbookEnabled');
    if (account.lastError) return t('settings.syncPartiallyFailed');
    return account.lastSync ? t('settings.connected') : t('settings.notSyncedYet');
  };
  // Ein Serverfehler und „noch nichts angehakt" sind nicht gleich dringend.
  // Beides amber zu färben macht die Seite zur Warnwand und lehrt, Amber zu
  // ignorieren - „kein Adressbuch aktiviert" ist der erwartete Zwischenzustand
  // einer frischen Einrichtung, kein Problem.
  const toneFor = (count) => {
    if (account.lastError) return 'danger';
    if (count === 0) return 'neutral';
    return account.lastSync ? 'success' : 'neutral';
  };

  const summary = createStatusSummary({
    title: account.name,
    status: statusText(enabledCount),
    details,
    action: syncBtn,
    tone: toneFor(enabledCount),
  });
  card.appendChild(summary);

  const statusEl = summary.querySelector('.settings-status-summary__status');

  // Der Konto-Fehler nur, wenn ihn keine Adressbuch-Zeile trägt - sonst stünde
  // dieselbe Meldung zweimal auf dem Bildschirm. Er bleibt für Fälle, die kein
  // einzelnes Adressbuch betreffen (falsches Passwort, Server nicht erreichbar).
  // Platz: direkt hinter der Statuszeile, die er erklärt - nicht unter dem
  // Sync-Button, wo der Blick erst zurückspringen müsste.
  const rowCarriesError = addressbooks.some((ab) => ab.lastError);
  if (account.lastError && !rowCarriesError) {
    const inlineError = createInlineError(
      t('settings.syncErrorDetail', { error: account.lastError }),
    );
    if (statusEl) statusEl.insertAdjacentElement('afterend', inlineError);
    else summary.appendChild(inlineError);
  }

  statusEl?.setAttribute('aria-live', 'polite');
  // Der Grund für die Sperre steht sichtbar in der Statuszeile - der Button
  // verweist darauf, statt ihn in einem title zu verstecken.
  if (statusEl) {
    if (!statusEl.id) statusEl.id = `cardav-status-${account.id}`;
    syncBtn.setAttribute('aria-describedby', statusEl.id);
  }

  // Ohne aktiviertes Adressbuch gibt es nichts zu synchronisieren. Der Button
  // würde sonst Erfolg für einen Nicht-Vorgang melden - die teuerste Form von
  // Fehlinformation, weil der Nutzer den Fehler danach überall sucht, nur
  // nicht bei der Checkbox in der zugeklappten Liste.
  const setSyncEnabled = (count) => {
    syncBtn.setAttribute('aria-disabled', String(count === 0));
  };
  setSyncEnabled(enabledCount);

  card.appendChild(buildAddressbookList(addressbooks, (count) => {
    if (statusEl) statusEl.textContent = statusText(count);
    setSyncEnabled(count);
    const tone = toneFor(count);
    for (const name of ['danger', 'warning', 'success', 'neutral']) {
      summary.classList.toggle(`settings-status-summary--${name}`, tone === name);
    }
    // Bei einem Fehler ist die Liste die Antwort, nicht das Versteck: die Regel
    // öffnete bisher für den harmlosen Fall und schloss für den dringenden.
  }, {
    open: enabledCount === 0 || addressbooks.some((ab) => ab.lastError),
    accountId: account.id,
  }));

  const actions = document.createElement('div');
  actions.className = 'caldav-account-actions';

  const refreshBtn = document.createElement('button');
  refreshBtn.type = 'button';
  // Wartungsaktion, kein Alltagsweg: leiser als Bearbeiten.
  refreshBtn.className = 'btn btn--ghost btn--sm';
  refreshBtn.textContent = t('settings.cardavRefreshAddressbooks');
  refreshBtn.addEventListener('click', () => withBusy(refreshBtn, async () => {
    try {
      await api.post(`/contacts/cardav/accounts/${account.id}/addressbooks/refresh`);
      showToast(t('settings.addressbooksRefreshed'), 'success');
      await refresh();
    } catch (err) {
      showToast(errorMessage(err), 'danger');
    }
  }, { loadingClass: 'btn--loading' }));
  actions.appendChild(refreshBtn);

  // Bearbeiten statt Löschen-und-neu-Anlegen: ein rotiertes Passwort darf die
  // Adressbuch-Auswahl nicht kosten.
  if (user?.role === 'admin') {
    const editBtn = document.createElement('button');
    editBtn.type = 'button';
    editBtn.className = 'btn btn--ghost btn--sm';
    editBtn.textContent = t('common.edit');
    editBtn.addEventListener('click', () => openAccountModal(account, refresh));
    actions.appendChild(editBtn);
  }

  const deleteBtn = buildDisconnectButton(account, refresh, user);
  if (deleteBtn) actions.appendChild(deleteBtn);

  card.appendChild(actions);
  container.appendChild(card);
}

/**
 * „Trennen" - nur für Admins. Wird auch von der Fehlerkarte verwendet: ein Konto,
 * dessen Adressbücher nicht geladen werden können, muss entfernbar bleiben.
 */
function buildDisconnectButton(account, refresh, user) {
  if (user?.role !== 'admin') return null;
  const deleteBtn = document.createElement('button');
  deleteBtn.type = 'button';
  deleteBtn.className = 'btn btn--danger-outline btn--sm';
  deleteBtn.textContent = t('settings.disconnect');
  deleteBtn.addEventListener('click', async () => {
    // Die Frage nennt das Konto, die Erklärung nennt die Folge - sonst ist bei
    // mehreren Konten nicht erkennbar, welches gerade getrennt wird.
    const confirmed = await confirmModal(
      t('settings.disconnectAccountConfirmTitle', { name: account.name }),
      {
        detail: t('settings.deleteCardDAVAccountConfirm'),
        confirmLabel: t('settings.disconnect'),
        danger: true,
      },
    );
    if (!confirmed) return;
    await withBusy(deleteBtn, async () => {
      try {
        await api.delete(`/contacts/cardav/accounts/${account.id}`);
        showToast(t('settings.cardavAccountDeleted'), 'success');
        await refresh();
      } catch (err) {
        showToast(errorMessage(err), 'danger');
      }
    }, { loadingClass: 'btn--loading' });
  });
  return deleteBtn;
}

/**
 * Karte für ein Konto, dessen Adressbücher nicht abrufbar sind. Zeigt den Fehler
 * und lässt zwei Auswege offen: erneut versuchen oder das Konto trennen.
 */
function buildUnreachableAccount(account, err, reload, user) {
  const wrapper = document.createElement('article');
  wrapper.className = 'caldav-account-item';
  wrapper.appendChild(createStatusSummary({
    title: account.name,
    status: t('settings.notReachable'),
    details: account.cardavUrl
      ? [account.cardavUrl, lastSyncDetail(account.lastSync)]
      : [lastSyncDetail(account.lastSync)],
    tone: 'warning',
  }));
  wrapper.appendChild(createInlineError(errorMessage(err)));

  const actions = document.createElement('div');
  actions.className = 'caldav-account-actions';

  const retryBtn = document.createElement('button');
  retryBtn.type = 'button';
  retryBtn.className = 'btn btn--secondary btn--sm';
  retryBtn.textContent = t('common.retry');
  retryBtn.addEventListener('click', () => withBusy(retryBtn, reload, { loadingClass: 'btn--loading' }));
  actions.appendChild(retryBtn);

  const deleteBtn = buildDisconnectButton(account, reload, user);
  if (deleteBtn) actions.appendChild(deleteBtn);

  wrapper.appendChild(actions);
  return wrapper;
}

async function loadAccounts(container, user) {
  const listEl = container.querySelector('#cardav-accounts');
  if (!listEl) return;
  listEl.replaceChildren();
  listEl.insertAdjacentHTML('beforeend', renderSkeletonList({ rows: 1, lines: 3 }));

  const reload = () => loadAccounts(container, user);

  let accounts;
  try {
    const res = await api.get('/contacts/cardav/accounts');
    accounts = res.data || [];
  } catch (err) {
    listEl.replaceChildren();
    listEl.appendChild(createRetryState({
      message: err?.data?.errorCode ? errorMessage(err) : (err.message || t('settings.cardavConnectionFailed')),
      onRetry: reload,
    }));
    return;
  }

  if (accounts.length === 0) {
    listEl.replaceChildren();
    const empty = document.createElement('p');
    empty.className = 'caldav-empty-state';
    empty.textContent = t('settings.cardavEmptyState');
    listEl.appendChild(empty);
    return;
  }

  // Adressbücher aller Konten parallel holen: ein fehlschlagendes Konto darf die
  // übrigen weder verzögern noch verhindern.
  const loaded = await Promise.all(accounts.map(async (account) => {
    try {
      const abRes = await api.get(`/contacts/cardav/accounts/${account.id}/addressbooks`);
      return { account, addressbooks: abRes.data || [] };
    } catch (err) {
      return { account, error: err };
    }
  }));

  listEl.replaceChildren();
  for (const { account, addressbooks, error } of loaded) {
    if (error) {
      listEl.appendChild(buildUnreachableAccount(account, error, reload, user));
      continue;
    }
    renderAccount(listEl, account, addressbooks, reload, user);
  }
  // Die Karten tragen Lucide-Platzhalter (Disclosure-Chevron) und entstehen bei
  // jedem Reload neu - createIcons muss deshalb hier laufen, nicht nur in render().
  window.lucide?.createIcons({ el: listEl });
}

/**
 * Kontoformular für Anlegen und Bearbeiten. Beim Bearbeiten ist das Passwortfeld
 * leer und optional - leer lassen heißt „bestehendes behalten"; die Adressbuch-
 * Auswahl bleibt in jedem Fall erhalten.
 *
 * Passwortfeld: autocomplete="off". Gefragt ist ein bestehendes Passwort für
 * einen FREMDEN Server - "current-password" bietet das Yuvomi-Passwort an,
 * "new-password" schlägt ein generiertes vor. Beides ist hier falsch.
 *
 * @param {Object|null} account - null = neues Konto
 * @param {() => Promise<void>} onDone
 */
function openAccountModal(account, onDone) {
  const isEdit = Boolean(account);
  openModal({
    title: isEdit ? t('settings.cardavEditAccount') : t('settings.cardavAddAccount'),
    size: 'sm',
    content: `
      <form id="cardav-account-form" novalidate autocomplete="off">
        <div class="form-group">
          <label class="form-label" for="cardav-name">${t('settings.cardavNameLabel')}<span class="required-marker" aria-hidden="true"> *</span></label>
          <input class="form-input" type="text" id="cardav-name" required
                 placeholder="${t('settings.cardavNamePlaceholder')}" maxlength="100"
                 value="${esc(account?.name ?? '')}" />
        </div>
        <div class="form-group">
          <label class="form-label" for="cardav-url">${t('settings.cardavUrlLabel')}<span class="required-marker" aria-hidden="true"> *</span></label>
          <input class="form-input" type="url" id="cardav-url" required
                 placeholder="${t('settings.cardavUrlPlaceholder')}"
                 value="${esc(account?.cardavUrl ?? '')}" />
          <small class="form-hint">${t('settings.cardavUrlHint')}</small>
        </div>
        <div class="form-group">
          <label class="form-label" for="cardav-username">${t('settings.cardavUsernameLabel')}<span class="required-marker" aria-hidden="true"> *</span></label>
          <input class="form-input" type="text" id="cardav-username" required autocomplete="off"
                 value="${esc(account?.username ?? '')}" />
        </div>
        <div class="form-group">
          <label class="form-label" for="cardav-password">${t('settings.cardavPasswordLabel')}${isEdit ? '' : '<span class="required-marker" aria-hidden="true"> *</span>'}</label>
          <!-- aria-describedby verbindet die Hinweise mit dem Feld. Ohne die
               Verknüpfung hört ein Screenreader nur „Password, edit text, blank" -
               der entscheidende Satz „leer lassen behält das Passwort" existiert
               für ihn dann nicht. -->
          <input class="form-input" type="password" id="cardav-password" ${isEdit ? '' : 'required'}
                 autocomplete="off"
                 aria-describedby="${isEdit ? 'cardav-password-keep ' : ''}cardav-password-hint" />
          ${isEdit ? `<small class="form-hint" id="cardav-password-keep">${t('settings.cardavPasswordKeepHint')}</small>` : ''}
          <small class="form-hint" id="cardav-password-hint">${t('settings.cardavPasswordHint')}</small>
        </div>
        <!-- Die Vertrauensaussage gilt dem ganzen Formular, nicht dem Passwortfeld:
             am Fuß gelesen, nicht als dritter Hinweis unter einem leeren Feld. -->
        <p class="form-hint settings-form-note">${t('settings.cardavCredentialsTrustHint')}</p>
        <div id="cardav-account-error" class="form-error" role="alert" hidden></div>
        <div class="modal-actions">
          <button type="button" class="btn btn--ghost" id="cardav-account-cancel">${t('common.cancel')}</button>
          <button type="submit" class="btn btn--primary">${t('common.save')}</button>
        </div>
      </form>
    `,
    onSave: (panel) => {
      const form = panel.querySelector('#cardav-account-form');
      const errorEl = panel.querySelector('#cardav-account-error');
      // Ohne force: Abbrechen läuft durch dieselbe Dirty-Guard wie Escape.
      // Sonst verwirft derselbe Dialog über zwei Ausgänge unterschiedlich -
      // und der Anlass zum Bearbeiten ist meist ein frisch getipptes Passwort.
      panel.querySelector('#cardav-account-cancel')?.addEventListener('click', () => closeModal());

      // Feldbezogene Validierung statt Sammelbanner: markiert das fehlende
      // Feld, verknüpft die Meldung per aria-describedby und setzt den Fokus
      // auf das erste ungültige Feld.
      wireBlurValidation(form);

      form.addEventListener('submit', async (e) => {
        e.preventDefault();
        errorEl.hidden = true;

        if (!validateAll(form)) return;

        const payload = {
          name: panel.querySelector('#cardav-name').value.trim(),
          cardavUrl: panel.querySelector('#cardav-url').value.trim(),
          username: panel.querySelector('#cardav-username').value.trim(),
          password: panel.querySelector('#cardav-password').value,
        };

        try {
          if (isEdit) {
            await api.put(`/contacts/cardav/accounts/${account.id}`, payload);
          } else {
            await api.post('/contacts/cardav/accounts', payload);
          }
          closeModal({ force: true });
          showToast(
            isEdit ? t('settings.cardavAccountUpdated') : t('settings.cardavAccountAdded'),
            'success',
          );
          await onDone();
        } catch (err) {
          errorEl.textContent = errorMessage(err);
          errorEl.hidden = false;
        }
      });
    },
  });
}

function bindAddButton(container, user) {
  const addBtn = container.querySelector('#cardav-add-account-btn');
  if (!addBtn) return;
  addBtn.addEventListener('click', () => {
    openAccountModal(null, () => loadAccounts(container, user));
  });
}

export async function render(container, { user }) {
  renderPage(container, user);
  bindAddButton(container, user);
  await loadAccounts(container, user);
  window.lucide?.createIcons({ el: container });
}
