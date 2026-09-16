/**
 * Einstellungen: Wandtabletts (#1208, entschieden in #913)
 *
 * Ein Display anlegen, ihm einen Kopplungscode ausstellen, sein Geraet
 * widerrufen. Die Seite ist bewusst duenn - die ganze Entscheidung liegt im
 * Server, hier steht nur, was ein Mensch davon sieht.
 *
 * DER CODE STEHT GENAU EINMAL AUF DEM SCHIRM, wie der Klartext eines
 * API-Tokens. Er wandert nicht in die Liste und ueberlebt kein Neuladen: der
 * Server verwahrt nur seinen Hash, es gibt ihn danach schlicht nicht mehr.
 * Wer ihn verpasst, stellt einen neuen aus - und der entwertet den alten.
 */

import { api, auth } from '/api.js';
import { formatDate, formatTime, t } from '/i18n.js';
import { esc } from '/utils/html.js';
import { confirmModal, refocusAfterRender } from '/components/modal.js';

function formatSeen(value) {
  if (!value) return null;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  return `${formatDate(date)} ${formatTime(date)}`.trim();
}

function showError(element, message) {
  if (!element) return;
  element.textContent = message || t('common.errorGeneric');
  element.hidden = false;
}

function clearError(element) {
  if (!element) return;
  element.textContent = '';
  element.hidden = true;
}

/**
 * Der Code in zwei Gruppen zu fuenf. Nur Darstellung - der Server normalisiert
 * Leerzeichen und Bindestriche weg, damit ein abgetippter Code mit oder ohne
 * Trennung passt.
 */
function groupCode(code) {
  return `${code.slice(0, 5)} ${code.slice(5)}`.trim();
}

/**
 * Ein Geraet in einer Zeile.
 *
 * „ZULETZT GESEHEN" IST DIE GANZE BEGRUENDUNG DES KNOPFS DANEBEN. Ohne sie
 * waere „Widerrufen" eine Frage ins Dunkle: welches der beiden Tabletts ist
 * das? Ein Geraet, das seit Wochen nichts mehr gesagt hat, ist die Antwort.
 */
function renderDevice(display, device) {
  const seen = formatSeen(device.last_seen_at);
  const revoked = formatSeen(device.revoked_at);
  const label = device.label || t('settings.displayDeviceUnnamed');
  return `
    <li class="settings-members__item">
      <span class="settings-members__name">${esc(label)}</span>
      <span class="form-hint">${revoked
        ? esc(t('settings.displayDeviceRevokedAt', { when: revoked }))
        : esc(seen ? t('settings.displayDeviceLastSeen', { when: seen }) : t('settings.displayDeviceNeverSeen'))}</span>
      ${revoked ? '' : `
      <button type="button" class="btn btn--secondary btn--sm"
              data-display-revoke="${display.id}" data-device="${device.id}">
        ${esc(t('settings.displayRevokeDevice'))}
      </button>`}
    </li>`;
}

function renderDisplay(display) {
  const active = (display.devices || []).filter((d) => !d.revoked_at);
  return `
    <li class="settings-card" data-display="${display.id}">
      <h3 class="settings-card__title">${esc(display.display_name)}</h3>
      <p class="form-hint">${esc(active.length
        ? t('settings.displayPaired')
        : t('settings.displayNotPaired'))}</p>
      <ul class="settings-members">
        ${(display.devices || []).map((device) => renderDevice(display, device)).join('')}
      </ul>
      <div class="settings-token-output" data-display-code="${display.id}" hidden>
        <p class="form-label">${esc(t('settings.displayPairingCodeLabel'))}</p>
        <p class="settings-token-output__row"><code data-display-code-value="${display.id}"></code></p>
        <p class="form-hint">${esc(t('settings.displayPairingCodeHint'))}</p>
      </div>
      <div class="settings-actions">
        <button type="button" class="btn btn--secondary btn--sm" data-display-pair="${display.id}">
          ${esc(t('settings.displayIssueCode'))}
        </button>
        <button type="button" class="btn btn--ghost btn--sm" data-display-delete="${display.id}"
                data-name="${esc(display.display_name)}">
          ${esc(t('settings.displayDelete'))}
        </button>
      </div>
    </li>`;
}

function renderList(container, displays) {
  const list = container.querySelector('#display-list');
  if (!list) return;
  if (!displays.length) {
    list.replaceChildren();
    list.insertAdjacentHTML('beforeend', `<li class="form-hint">${esc(t('settings.displayEmpty'))}</li>`);
    return;
  }
  list.replaceChildren();
  list.insertAdjacentHTML('beforeend', displays.map(renderDisplay).join(''));
}

function renderPage(container) {
  container.replaceChildren();
  container.insertAdjacentHTML('beforeend', `
    <section class="settings-section">
      <!-- KEINE eigene Ueberschrift: die Shell setzt den Blatt-Titel schon
           darueber, und ein <h2> mit demselben Wort waere er ein zweites Mal
           (test:typography haelt das fest). settings.displaysTitle traegt
           weiterhin den Namen in der Navigation. -->
      <div class="settings-card">
        <p class="form-hint" style="margin-bottom:var(--space-3)">${esc(t('settings.displaysHint'))}</p>
        <ul class="settings-cards" id="display-list"></ul>
        <form id="display-form" class="settings-form" autocomplete="off">
          <div class="form-group">
            <!-- displayDeviceNameLabel, NICHT displayNameLabel: der zweite
                 existiert laengst und heisst "Anzeigename" - der Name eines
                 MENSCHEN (admin-family.js, personal-account.js). Ihn hier
                 mitzubenutzen haette dem Tablett-Dialog ein Label gegeben, das
                 von etwas anderem spricht, und ihn umzuschreiben haette vier
                 Bestandsstellen still verdreht. -->
            <label class="form-label" for="display-name">${esc(t('settings.displayDeviceNameLabel'))}</label>
            <input class="form-input" type="text" id="display-name" maxlength="128" required />
            <p class="form-hint">${esc(t('settings.displayDeviceNameHint'))}</p>
          </div>
          <div id="display-error" class="form-error" role="alert" hidden></div>
          <button type="submit" class="btn btn--primary">${esc(t('settings.displayCreate'))}</button>
        </form>
      </div>
    </section>
  `);
}

async function reload(container) {
  const res = await api.get('/displays');
  const displays = res.data ?? [];
  renderList(container, displays);
  window.lucide?.createIcons({ el: container });
  return displays;
}

/**
 * Welche Code-Anfrage je Display die juengste ist. Eine Antwort, deren Nummer
 * nicht mehr stimmt, wurde ueberholt und darf nichts mehr schreiben.
 */
const pairTickets = new Map();

function bindEvents(container) {
  const form = container.querySelector('#display-form');
  const list = container.querySelector('#display-list');
  const errorEl = container.querySelector('#display-error');
  if (!form || !list) return;

  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    clearError(errorEl);
    const input = container.querySelector('#display-name');
    const name = input.value.trim();
    if (!name) return;
    const btn = form.querySelector('[type=submit]');
    btn.disabled = true;
    try {
      await api.post('/displays', { display_name: name });
      // DAS ERSTE DISPLAY MACHT AUS EINEM EIN-PERSONEN-HAUSHALT EINEN MIT
      // MITLESER. `othersCanRead` entscheidet, ob Aufgaben und Kalender ihre
      // Sichtbarkeitsfelder ueberhaupt zeigen; der Wert kommt aus /auth/me und
      // liegt im Speicher. Ohne dieses Nachholen blieben die Felder bis zum
      // naechsten vollen Laden verborgen, und alles, was in derselben Sitzung
      // noch entsteht, waere "fuer alle" - also lesbar fuer das Tablett, das
      // gerade erst angelegt wurde. Rechteaenderungen holen den Wert aus
      // demselben Grund nach (admin-permissions.js).
      await auth.me().catch(() => {});
      input.value = '';
      await reload(container);
    } catch (err) {
      showError(errorEl, err.message);
    } finally {
      btn.disabled = false;
    }
  });

  list.addEventListener('click', async (event) => {
    const pair = event.target.closest('[data-display-pair]');
    if (pair) {
      // ZWEI KLICKS DUERFEN NICHT ZWEI CODES ANFRAGEN. Der Server entwertet
      // beim Ausstellen jeden aelteren Code - kommen die Antworten in der
      // anderen Reihenfolge zurueck als die Anfragen hinausgingen, steht am
      // Ende der ALTE, laengst ungueltige Code auf dem Schirm, und das Tablett
      // bekommt darauf beharrlich 400. Der Knopf sperrt sich deshalb fuer die
      // Dauer der Anfrage, und eine ueberholte Antwort schreibt nicht mehr.
      if (pair.disabled) return;
      clearError(errorEl);
      const id = pair.dataset.displayPair;
      const ticket = (pairTickets.get(id) ?? 0) + 1;
      pairTickets.set(id, ticket);
      pair.disabled = true;
      try {
        const res = await api.post(`/displays/${id}/pairing-code`, {});
        if (pairTickets.get(id) !== ticket) return;
        const box = list.querySelector(`[data-display-code="${id}"]`);
        const value = list.querySelector(`[data-display-code-value="${id}"]`);
        if (box && value) {
          value.textContent = groupCode(res.data.code);
          box.hidden = false;
        }
      } catch (err) {
        if (pairTickets.get(id) === ticket) showError(errorEl, err.message);
      } finally {
        // Die Liste wird hier nicht neu gezeichnet, der Knopf von eben ist also
        // noch derselbe - `isConnected` faengt den Fall trotzdem ab, falls ein
        // paralleles `reload()` ihn ersetzt hat.
        if (pair.isConnected) pair.disabled = false;
      }
      return;
    }

    const revoke = event.target.closest('[data-display-revoke]');
    if (revoke) {
      // Die Frage nennt die HANDLUNG, das Detail die FOLGE - getrennt, weil ein
      // Titel beides nicht traegt und „widerrufen" allein nicht verraet, dass
      // das Tablett an der Wand danach leer ist.
      const ok = await confirmModal(t('settings.displayRevokeConfirm'), {
        danger: true,
        detail: t('settings.displayRevokeDetail'),
      });
      if (!ok) return;
      clearError(errorEl);
      try {
        await api.post(`/displays/${revoke.dataset.displayRevoke}/devices/${revoke.dataset.device}/revoke`, {});
        await reload(container);
        // Der Dialog hat den Fokus gehalten, und `reload()` ersetzt die Liste
        // darunter - ohne das hier landet der Fokus nach dem Schliessen am
        // Dokumentanfang statt an der Stelle, an der gerade gearbeitet wurde.
        refocusAfterRender();
      } catch (err) {
        showError(errorEl, err.message);
      }
      return;
    }

    const del = event.target.closest('[data-display-delete]');
    if (del) {
      const ok = await confirmModal(t('settings.displayDeleteConfirm', { name: del.dataset.name }), {
        danger: true,
        detail: t('settings.displayDeleteDetail'),
      });
      if (!ok) return;
      clearError(errorEl);
      try {
        await api.delete(`/displays/${del.dataset.displayDelete}`);
        // Und der Rueckweg: war es das letzte Display, liest in einem
        // Ein-Personen-Haushalt wieder niemand mit, und die Felder gehoeren
        // wieder weg. Derselbe Wert, dieselbe Quelle wie beim Anlegen.
        await auth.me().catch(() => {});
        await reload(container);
        refocusAfterRender();
      } catch (err) {
        showError(errorEl, err.message);
      }
    }
  });
}

export async function render(container) {
  renderPage(container);
  try {
    await reload(container);
  } catch {
    renderList(container, []);
  }
  bindEvents(container);
  window.lucide?.createIcons({ el: container });
}
