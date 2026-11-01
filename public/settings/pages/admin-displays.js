/**
 * Einstellungen: Wandtabletts (#1208, entschieden in #913)
 *
 * Ein Display anlegen, ihm einen Kopplungscode ausstellen, sein Geraet
 * widerrufen, ein widerrufenes Geraet entfernen. Die Seite ist bewusst duenn - die ganze Entscheidung liegt im
 * Server, hier steht nur, was ein Mensch davon sieht.
 *
 * DER CODE STEHT GENAU EINMAL AUF DEM SCHIRM, wie der Klartext eines
 * API-Tokens. Er wandert nicht in die Liste und ueberlebt kein Neuladen: der
 * Server verwahrt nur seinen Hash, es gibt ihn danach schlicht nicht mehr.
 * Wer ihn verpasst, stellt einen neuen aus - und der entwertet den alten.
 */

import { api, auth } from '/api.js';
import { formatTime, formatUnit, getLocale, t } from '/i18n.js';
import { dateTimeText } from '/utils/date-format.js';
import { esc } from '/utils/html.js';
import { confirmModal, refocusAfterRender, reportFieldErrors, constraintErrors } from '/components/modal.js';
import { hintFoldHtml, settingRowHtml, settingSwitchRowHtml } from '/settings/components.js';
import { DISPLAY_DEVICE_DEFAULTS, DISPLAY_IDLE_STEPS, normalizeDisplayDeviceSettings } from '/utils/display-device-settings.js';
import { errorSentence } from '/utils/friendly-error.js';
import { reloadAfterSave } from '/utils/reload-after-save.js';

function formatSeen(value) {
  if (!value) return null;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  return dateTimeText(date);
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
      ${revoked ? `
      <button type="button" class="btn btn--ghost btn--sm"
              data-display-remove-device="${display.id}" data-device="${device.id}">
        ${esc(t('settings.displayRemoveDevice'))}
      </button>` : `
      <button type="button" class="btn btn--secondary btn--sm"
              data-display-revoke="${display.id}" data-device="${device.id}">
        ${esc(t('settings.displayRevokeDevice'))}
      </button>`}
    </li>`;
}

function hourOptions(selected, other) {
  return Array.from({ length:24 }, (_, hour) => `<option value="${hour}"${hour === selected ? ' selected' : ''}${hour === other ? ' disabled' : ''}>${esc(formatTime(`${String(hour).padStart(2, '0')}:00`))}</option>`).join('');
}

function renderDeviceSettings(display) {
  const settings = normalizeDisplayDeviceSettings(display.device_settings) ?? DISPLAY_DEVICE_DEFAULTS;
  const prefix = `display-options-${display.id}`;
  return `<form class="settings-form" id="${prefix}-form" data-display-device-settings="${display.id}" data-name="${esc(display.display_name)}" novalidate>
    <p class="form-hint">${esc(t('settings.displayDeviceSettingsHint'))}</p>
    ${!display.device_settings ? `<p class="form-hint" data-display-local-hint>${esc(t('settings.displayDeviceSettingsLocal'))}</p>` : ''}
    <div class="row-divided settings-group">
      ${settingRowHtml({ label:t('settings.nightHoursLabel'), labelId:`${prefix}-night-label`,
        control:`<span class="form-composite" role="group" aria-labelledby="${prefix}-night-label">
          <select class="form-input" name="night_from" aria-label="${esc(t('settings.nightHoursFrom'))}">${hourOptions(settings.night_from, settings.night_until)}</select>
          <span class="form-composite__sep" aria-hidden="true">-</span>
          <select class="form-input" name="night_until" aria-label="${esc(t('settings.nightHoursUntil'))}">${hourOptions(settings.night_until, settings.night_from)}</select>
        </span>` })}
      ${settingRowHtml({ label:t('settings.screensaverIdleLabel'), labelFor:`${prefix}-idle`,
        control:`<select class="form-input" id="${prefix}-idle" name="idle_seconds">${DISPLAY_IDLE_STEPS.map(seconds => `<option value="${seconds}"${seconds === settings.idle_seconds ? ' selected' : ''}>${esc(formatUnit(seconds / 60, 'minute', { unitDisplay:'long' }))}</option>`).join('')}</select>` })}
      ${settingSwitchRowHtml({ label:t('settings.screensaverClockLabel'), checked:settings.show_clock,
        attrs:{id:`${prefix}-clock`, name:'show_clock'} })}
      ${settingSwitchRowHtml({ label:t('settings.screensaverCoverLabel'), checked:settings.cover_photo,
        attrs:{id:`${prefix}-cover`, name:'cover_photo'} })}
    </div>
    <p class="form-hint" role="status" aria-live="polite" data-display-settings-status></p>
    <div class="settings-form-actions"><button class="btn btn--primary" type="submit">${esc(t('common.save'))}</button></div>
  </form>`;
}

/** The two night boundaries cannot select the same hour. */
function syncNightOptions(form) {
  const from = form.querySelector('[name="night_from"]');
  const until = form.querySelector('[name="night_until"]');
  if (!from || !until) return;
  for (const [select, other] of [[from, until], [until, from]]) {
    for (const option of select.options) option.disabled = option.value === other.value;
  }
}

export function bindDisplayDeviceSettings(list) {
  list.addEventListener('submit', async event => {
    const form = event.target.closest?.('[data-display-device-settings]');
    if (!form) return;
    event.preventDefault();
    if (form.dataset.saving === 'true' || reportFieldErrors(constraintErrors(form))) return;
    const field = name => form.querySelector(`[name="${name}"]`);
    const settings = normalizeDisplayDeviceSettings({
      night_from:Number(field('night_from').value), night_until:Number(field('night_until').value),
      idle_seconds:Number(field('idle_seconds').value), show_clock:field('show_clock').checked, cover_photo:field('cover_photo').checked,
    });
    const status = form.querySelector('[data-display-settings-status]');
    if (!settings) { status.textContent = t('common.invalidInput'); return; }
    const controls = form.querySelectorAll('input, select, button');
    form.dataset.saving = 'true';
    for (const control of controls) control.disabled = true;
    status.textContent = '';
    try {
      await api.patch(`/displays/${form.dataset.displayDeviceSettings}`, {device_settings:settings});
      form.querySelector('[data-display-local-hint]')?.remove();
      status.textContent = t('common.savedNamed', {name:form.dataset.name});
    } catch (error) { status.textContent = errorSentence(error); }
    finally {
      form.dataset.saving = 'false';
      for (const control of controls) control.disabled = false;
    }
  });
}

// Exported so test:display-screensaver-switch can read the real card.
export function renderDisplay(display) {
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
      <!-- Ob dieses Tablett den Foto-Bildschirmschoner zeigt (#1766). Ein
           Display aendert keine Einstellungen, also entscheidet es hier ein
           Administrator, je Display und standardmaessig aus; der Server
           sperrt die Fotos bei "aus" am Gate. row-divided, nicht
           row-carrier: die Zeile liegt schon in der Karte, ein eigener
           Traeger waere eine Karte in der Karte (DESIGN.md, "Folge
           gleichartiger Zeilen"). settings-group gibt ihr nur das Raster
           der Einstellungszeile, keine Flaeche. Keine Backticks in diesem
           Kommentar - er steht im Template-Literal. -->
      <div class="row-divided settings-group">
      ${settingSwitchRowHtml({
        label: t('settings.displayScreensaverLabel'),
        checked: display.show_screensaver === true,
        icon: 'image',
        description: t('settings.displayScreensaverHint'),
        descriptionId: `display-screensaver-hint-${display.id}`,
        attrs: {
          id: `display-screensaver-${display.id}`,
          'data-display-screensaver': display.id,
          'data-name': display.display_name,
        },
      })}
      </div>
      ${renderDeviceSettings(display)}
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
        ${/* Kern vorn, der Rest aufklappbar (R22, D13). Der Absatz zu den
             Bereichen (#1808) kommt mit der Liste: WELCHE Bereiche ein Tablett
             zeigt, weiss nur der Server (DISPLAY_SCOPES), und eine zweite
             Handliste hier bliebe beim naechsten Scope stehen. Bis dahin
             leer und versteckt. Der Weg zum Wand-Modus dieses Geraets
             steht am Ende (D13: Wand an zwei Orten, gegenseitig verwiesen). */ ''}
        ${hintFoldHtml({
          lead: t('settings.displaysLead'),
          moreHtml: `<p class="form-hint">${esc(t('settings.displaysMore'))}</p>
            <p class="form-hint" id="display-areas-hint" hidden></p>
            <p class="form-hint" id="display-wall-mode">${esc(t('settings.displaysWallModeLinkHint'))}
              <a href="/settings/personal/device" id="display-wall-mode-link">${esc(t('settings.pageDevice'))}</a></p>`,
        })}
        ${/* Der Weg des Tabletts, bevor es einen Code gibt (#2294). Es koppelt
             unter /pair, einer oeffentlichen Route, nicht ueber die
             Anmeldeseite - bei reinem OIDC-Login gaebe es dort nicht einmal
             ein Passwortfeld. Deshalb steht die Adresse mit dem eigenen
             Ursprung sichtbar vor der Liste, nicht im Aufklapper und nicht
             erst neben einem frischen Code. Dieselbe Ziffernliste wie die
             Google-Einrichtung (settings-provider__steps). */ ''}
        <ol class="settings-provider__steps" id="display-pair-steps">
          <li>${esc(t('settings.displayPairStepCode'))}</li>
          <li>${esc(t('settings.displayPairStepOpen'))}
            <code id="display-pair-address" dir="ltr">${esc(`${window.location.origin}/pair`)}</code></li>
        </ol>
        <ul class="settings-cards" id="display-list"></ul>
        <form id="display-form" class="settings-form" autocomplete="off" novalidate>
          ${/* displayDeviceNameLabel, NICHT displayNameLabel: der zweite heisst
               "Anzeigename" - der Name eines MENSCHEN (admin-family.js,
               personal-account.js). Eine Zeile der Gruppe (R19, B7). */ ''}
          <div class="row-carrier settings-group">
            ${settingRowHtml({
              label: t('settings.displayDeviceNameLabel'), labelFor: 'display-name',
              description: t('settings.displayDeviceNameHint'), descriptionId: 'display-name-hint',
              control: '<input class="form-input" type="text" id="display-name" maxlength="128" required aria-describedby="display-name-hint" />',
            })}
          </div>
          <div id="display-error" class="form-error" role="alert" hidden></div>
          <div class="settings-form-actions">
            <button type="submit" class="btn btn--primary">${esc(t('settings.displayCreate'))}</button>
          </div>
        </form>
      </div>
    </section>
  `);
}

/**
 * Die Bereiche eines Displays als Satz (#1808).
 *
 * Die Namen sind die der Scope-Module, wie sie der API-Zugriff nebenan nennt
 * (`settings.apiTokenScopeModules.*`) - dieselben Schluessel, die der Server
 * liefert, also keine zweite Zuordnung. Dass es zu jedem Bereich in jeder
 * Sprache einen Namen gibt, haelt `test:display-account` fest. Ohne Liste (alte
 * Antwort aus dem Cache) bleibt der Absatz aus, statt einen halben Satz zu zeigen.
 */
function displayAreasText(modules) {
  const names = (Array.isArray(modules) ? modules : [])
    .map((key) => t(`settings.apiTokenScopeModules.${key}`));
  if (!names.length) return '';
  const areas = new Intl.ListFormat(getLocale(), { style: 'long', type: 'conjunction' }).format(names);
  return t('settings.displaysAreasHint', { areas });
}

function renderAreasHint(container, modules) {
  const hint = container.querySelector('#display-areas-hint');
  if (!hint) return;
  const text = displayAreasText(modules);
  hint.textContent = text;
  hint.hidden = !text;
}

async function reload(container) {
  const res = await api.get('/displays');
  const displays = res.data ?? [];
  renderAreasHint(container, res.area_modules);
  renderList(container, displays);
  window.lucide?.createIcons({ el: container });
  return displays;
}

/**
 * Welche Code-Anfrage je Display die juengste ist. Eine Antwort, deren Nummer
 * nicht mehr stimmt, wurde ueberholt und darf nichts mehr schreiben.
 */
const pairTickets = new Map();

/**
 * Der Schalter "Foto-Bildschirmschoner zeigen" je Display (#1766). Er wirkt
 * sofort wie jeder Schalter in den Einstellungen. Scheitert die Anfrage,
 * springt er zurueck - sonst zeigte die Liste einen Zustand, den der Server
 * nicht hat. Exported so test:display-screensaver-switch can drive the real
 * handler.
 */
export function bindDisplayScreensaverSwitches(list, errorEl) {
  list.addEventListener('change', async (event) => {
    const form = event.target.closest?.('[data-display-device-settings]');
    if (form) { syncNightOptions(form); return; }
    const toggle = event.target.closest?.('[data-display-screensaver]');
    if (!toggle) return;
    clearError(errorEl);
    const on = toggle.checked;
    toggle.disabled = true;
    try {
      await api.patch(`/displays/${toggle.dataset.displayScreensaver}`, { show_screensaver: on });
      window.yuvomi?.showToast(
        t(on ? 'settings.displayScreensaverOn' : 'settings.displayScreensaverOff', { name: toggle.dataset.name }),
        'success',
      );
    } catch (err) {
      toggle.checked = !on;
      showError(errorEl, err.message);
    } finally {
      toggle.disabled = false;
    }
  });
}

function bindEvents(container) {
  const form = container.querySelector('#display-form');
  const list = container.querySelector('#display-list');
  const errorEl = container.querySelector('#display-error');
  if (!form || !list) return;

  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    clearError(errorEl);
    // KEINE BROWSER-BLASEN (Critique R21): `novalidate`, die Regeln des Markups melden sich am Feld (constraintErrors, components/modal.js).
    if (reportFieldErrors(constraintErrors(form))) return;
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
      await reloadAfterSave(() => reload(container));
    } catch (err) {
      showError(errorEl, err.message);
    } finally {
      btn.disabled = false;
    }
  });

  bindDisplayScreensaverSwitches(list, errorEl);
  bindDisplayDeviceSettings(list);

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
        await reloadAfterSave(() => reload(container));
        // Der Dialog hat den Fokus gehalten, und `reload()` ersetzt die Liste
        // darunter - ohne das hier landet der Fokus nach dem Schliessen am
        // Dokumentanfang statt an der Stelle, an der gerade gearbeitet wurde.
        refocusAfterRender();
      } catch (err) {
        showError(errorEl, err.message);
      }
      return;
    }

    // EIN WIDERRUFENES GERAET LAESST SICH ENTFERNEN (D#1672). Jede neue Kopplung
    // widerruft das Geraet davor, und dessen Zeile blieb fuer immer stehen.
    // Rueckgaengig gibt es nicht - die Zeile ist danach weg -, also die
    // Rueckfrage vorab, mit der Folge im Detail.
    const remove = event.target.closest('[data-display-remove-device]');
    if (remove) {
      const ok = await confirmModal(t('settings.displayRemoveDeviceConfirm'), {
        danger: true,
        confirmLabel: t('settings.displayRemoveDevice'),
        detail: t('settings.displayRemoveDeviceDetail'),
      });
      if (!ok) return;
      clearError(errorEl);
      try {
        await api.post(`/displays/${remove.dataset.displayRemoveDevice}/devices/${remove.dataset.device}/remove`, {});
      } catch (err) {
        // 404 heisst: schon weg. Alles andere bekommt seinen Satz - der Grund
        // des Servers uebersetzt, nicht sein englischer Text.
        if (err?.status !== 404) {
          showError(errorEl, err?.status === 409 && err.data?.reason === 'display_device_active'
            ? t('settings.displayRemoveDeviceActive')
            : err.message);
        }
      }
      try {
        await reload(container);
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

export const __test = { displayAreasText };
