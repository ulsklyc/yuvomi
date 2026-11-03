/**
 * Modul: Angemeldete Geraete (Refs #255)
 * Zweck: Die Telefone mit nativem Client, die mit dem eigenen Konto angemeldet
 *        sind, und der Code, mit dem ein weiteres ohne Passwort hineinkommt. Ein
 *        Haushalt nur mit SSO hat kein Passwort, das jemand in eine App tippen
 *        koennte (docs/SPEC.md, signed-in devices).
 */

import { api } from '/api.js';
import { t } from '/i18n.js';
import { confirmModal, refocusAfterRender } from '/components/modal.js';
import { clockText, dateTimeText } from '/utils/date-format.js';
import { errorSentence } from '/utils/friendly-error.js';
import { esc } from '/utils/html.js';

/** Plattformen, die einen eigenen Namen tragen. Alles andere steht, wie es kommt. */
const PLATFORM_LABELS = Object.freeze({ ios: 'iOS', android: 'Android' });

/**
 * Zum Abtippen in Fuenfergruppen, wie die App ihn zeigt ("ACDEF GHJK3"). Der
 * Server ignoriert Leerzeichen; die Laenge entscheidet er, deshalb wird nichts
 * abgeschnitten.
 * @param {string} code
 * @returns {string}
 */
export function groupPairingCode(code) {
  return String(code || '').replace(/[\s-]/g, '').toUpperCase().match(/.{1,5}/g)?.join(' ') ?? '';
}

/**
 * Fuenf Minuten, wie `DEVICE_PAIRING_CODE_TTL_MS` im Server
 * (server/services/device-pairing.js).
 */
export const PAIRING_CODE_TTL_MS = 5 * 60 * 1000;

/**
 * Wann der Code hier als abgelaufen gilt: fuenf Minuten ab Empfang. NICHT
 * `expires_at` gegen die Uhr dieses Geraets - geht sie vor, stuende ein frischer
 * Code sofort als abgelaufen da. Ob er gilt, entscheidet ohnehin der Server beim
 * Einloesen; die Seite zeigt ihn hoechstens die Laufzeit einer Antwort zu lange.
 * @param {number} receivedAt
 * @returns {number}
 */
export function pairingDeadline(receivedAt) {
  return receivedAt + PAIRING_CODE_TTL_MS;
}

/**
 * Die Geraete, die seit der letzten Liste dazukamen. Waehrend ein Code offen
 * ist, nennt die Seite sie sofort: `yuvomi://` ist nicht exklusiv, eine fremde
 * App koennte den Link abfangen und selbst einloesen (ADR 0001 in yuvomi-ios).
 * Ein Name, den niemand erwartet, faellt so auf, solange er sich abmelden laesst.
 */
export function newDevices(before, after) {
  const known = new Set(before.map((device) => device.id));
  return after.filter((device) => !known.has(device.id));
}

function lastUsedText(value, when) {
  const date = value ? new Date(value) : null;
  if (!date || Number.isNaN(date.getTime())) return t('settings.devicesNeverUsed');
  return `${t('settings.devicesLastUsed')}: ${when(date)}`;
}

/**
 * Die Zeilen der Liste. Ein Knopf je Zeile, und der meldet ab: ein Geraet, das
 * nicht mehr gilt, liefert `GET /auth/devices` gar nicht erst.
 * @param {Array<{ id: number, name: string, platform: string, last_used_at: string|null, current?: boolean }>} list
 * @param {{ when?: (date: Date) => string }} [options] wie ein Zeitpunkt geschrieben wird
 * @returns {string}
 */
export function devicesListHtml(list, { when = dateTimeText } = {}) {
  if (!list.length) return `<li class="form-hint">${esc(t('settings.devicesEmpty'))}</li>`;
  return list.map((device) => {
    const platform = PLATFORM_LABELS[device.platform] ?? device.platform;
    const current = device.current
      ? ` <span class="settings-member__self">${esc(t('settings.devicesCurrent'))}</span>`
      : '';
    const meta = [platform, lastUsedText(device.last_used_at, when)].filter(Boolean).join(' · ');
    return `
    <li class="settings-member" data-device-id="${device.id}">
      <div class="settings-member__info">
        <span class="settings-member__name">${esc(device.name)}${current}</span>
        <span class="settings-member__meta">${esc(meta)}</span>
      </div>
      <button type="button" class="btn btn--icon btn--danger-outline" data-revoke-device="${device.id}" data-name="${esc(device.name)}" aria-label="${esc(t('settings.devicesRevokeNamed', { name: device.name }))}">
        <i data-lucide="log-out" aria-hidden="true"></i>
      </button>
    </li>`;
  }).join('');
}

/**
 * Die Karte im Konto-Blatt. Liste und Kopplung fuellt `bindSignedInDevices()`:
 * die Seite steht, bevor `GET /auth/devices` antwortet, und ein Ausfall dort
 * kostet nur diese Karte.
 * @returns {string}
 */
export function signedInDevicesCardHtml() {
  return `
      <div class="settings-card settings-devices" id="signed-in-devices">
        <h3 class="settings-card__title">${t('settings.devicesTitle')}</h3>
        <p class="form-hint">${t('settings.devicesHint')}</p>
        <ul class="settings-members row-divided" id="devices-list" aria-busy="true"></ul>
        <div id="devices-error" class="form-error" role="alert" hidden></div>
        <div class="settings-token-output settings-pairing" id="device-pairing" hidden>
          <div class="settings-pairing__body" id="device-pairing-body">
            <div class="settings-pairing__intro">
              <p class="settings-pairing__warning">${t('settings.devicesPairWarning')}</p>
              <p class="form-hint">${t('settings.devicesPairSteps')}</p>
            </div>
            <div class="settings-pairing__qr" id="device-pairing-qr"></div>
            <div class="settings-pairing__code-block">
              <p class="form-label" id="device-pairing-code-label">${t('settings.devicesPairCodeLabel')}</p>
              <p><code class="settings-pairing__code" id="device-pairing-code" aria-labelledby="device-pairing-code-label" dir="ltr" translate="no"></code></p>
              <p class="form-hint" id="device-pairing-expiry"></p>
              <a class="btn btn--primary" id="device-pairing-open" href="#">${t('settings.devicesPairOpenApp')}</a>
            </div>
          </div>
          <p class="form-hint settings-pairing__status" id="device-pairing-status" role="status"></p>
        </div>
        <div class="settings-form-actions">
          <button type="button" class="btn btn--secondary" id="device-pair-btn">${t('settings.devicesPair')}</button>
        </div>
      </div>`;
}

/** Wie oft die Liste nachsieht, solange ein Code offen ist. */
const PAIRING_POLL_MS = 4000;

/**
 * Loest den Sichtbarkeits-Lauscher der vorigen Karte. Das Konto-Blatt zeichnet
 * sich neu (zweiter Faktor, "Erneut versuchen"), und ohne das hielte jeder
 * Lauf eine tote Karte samt Closure fest.
 */
let detachPrevious = null;

/**
 * Liste, Abmelden und Kopplung. Laeuft, solange die Karte im Dokument haengt:
 * jeder Takt fragt zuerst `isConnected`, ein Wechsel des Blatts beendet ihn.
 * @param {HTMLElement} container das Konto-Blatt
 */
export function bindSignedInDevices(container) {
  const card = container.querySelector('#signed-in-devices');
  if (!card) return;
  const list = card.querySelector('#devices-list');
  const errorBox = card.querySelector('#devices-error');
  const panel = card.querySelector('#device-pairing');
  const body = card.querySelector('#device-pairing-body');
  const status = card.querySelector('#device-pairing-status');
  const pairButton = card.querySelector('#device-pair-btn');
  // `known` gilt erst als Vergleich, wenn die Liste einmal geladen ist: davor
  // waere jedes vorhandene Geraet "gerade angemeldet".
  let known = null;
  let shown = '';
  let pairing = null; // { deadline, timer }
  let ticking = false;

  const showError = (message) => {
    errorBox.textContent = message;
    errorBox.hidden = false;
  };

  // Nur neu zeichnen, was sich geaendert hat: der Takt fragt alle vier Sekunden,
  // und ein ersetzter Knopf naehme den Tastaturfokus mit.
  const fill = (items) => {
    known = items;
    const next = JSON.stringify(items);
    if (next === shown) return;
    shown = next;
    list.replaceChildren();
    list.insertAdjacentHTML('beforeend', devicesListHtml(items));
    list.removeAttribute('aria-busy');
    window.lucide?.createIcons({ el: list });
  };

  const fetchDevices = async () => (await api.get('/auth/devices'))?.data ?? [];

  const load = async () => {
    try {
      fill(await fetchDevices());
      errorBox.hidden = true;
    } catch {
      list.removeAttribute('aria-busy');
      showError(t('settings.devicesLoadError'));
    }
  };

  const stopPairing = () => {
    if (pairing) clearInterval(pairing.timer);
    pairing = null;
  };

  const joinedSentence = (device) => t('settings.devicesPairJoined', {
    name: device.name, platform: PLATFORM_LABELS[device.platform] ?? device.platform,
  });

  // Ein Takt: hat sich ein Geraet angemeldet, und ist der Code abgelaufen?
  // Ein neues Geraet beweist nicht, dass DIESER Code verbraucht ist (es kann sich
  // auch mit Passwort angemeldet haben): die Meldung nennt es, der Code bleibt
  // bis zu seinem Ende stehen. Vor "abgelaufen" fragt der Takt die Liste noch
  // einmal, sonst fehlte ein Geraet, das nach dem letzten Takt kam oder waehrend
  // die Seite im Hintergrund schlief. Fehler beim Nachsehen bleiben still, der
  // naechste Takt fragt neu.
  const tick = async () => {
    if (!card.isConnected) return stopPairing();
    if (!pairing || ticking) return undefined;
    const current = pairing;
    let items;
    ticking = true;
    try {
      items = await fetchDevices();
    } catch {
      items = null;
    } finally {
      ticking = false;
    }
    if (pairing !== current) return undefined;
    if (items) {
      const joined = known ? newDevices(known, items) : [];
      fill(items);
      if (joined.length) current.joined = joinedSentence(joined[0]);
    }
    if (Date.now() >= current.deadline) {
      stopPairing();
      body.hidden = true;
      status.textContent = [current.joined, t('settings.devicesPairExpired')].filter(Boolean).join(' ');
      pairButton.textContent = t('settings.devicesPairNewCode');
    } else if (current.joined) {
      status.textContent = current.joined;
    }
    return undefined;
  };

  pairButton.addEventListener('click', async () => {
    if (pairButton.getAttribute('aria-disabled') === 'true') return;
    pairButton.setAttribute('aria-disabled', 'true');
    errorBox.hidden = true;
    try {
      // Erst die Liste: ein Geraet, das sich seit dem letzten Takt angemeldet
      // hat, gehoert zum alten Code und darf nicht als Antwort auf den neuen gelten.
      // Der alte Takt laeuft weiter, bis der neue Code da ist: scheitert die
      // Anfrage, bleibt der alte Code sichtbar und muss weiter ablaufen koennen.
      await load();
      const { data } = await api.post('/auth/devices/pair', { server: window.location.origin });
      stopPairing();
      const deadline = pairingDeadline(Date.now());
      // Das Bild entsteht erst mit dem Code: ein <img> ohne Quelle im Markup
      // waere ein kaputtes Bild, sobald jemand die Mulde frueher zeigt.
      const qr = document.createElement('img');
      qr.src = data.qr;
      qr.alt = t('settings.devicesPairQrAlt');
      qr.width = 200;
      qr.height = 200;
      card.querySelector('#device-pairing-qr').replaceChildren(qr);
      card.querySelector('#device-pairing-code').textContent = groupPairingCode(data.code);
      card.querySelector('#device-pairing-open').href = data.link;
      card.querySelector('#device-pairing-expiry').textContent = t('settings.devicesPairValidUntil', { time: clockText(new Date(deadline)) });
      status.textContent = '';
      body.hidden = false;
      panel.hidden = false;
      pairButton.textContent = t('settings.devicesPairNewCode');
      pairing = { deadline, timer: setInterval(tick, PAIRING_POLL_MS) };
    } catch (error) {
      // Personal und Gaeste melden sich an, bekommen aber kein Geraet
      // (`mayHaveDevice()` in server/auth.js). Der Grund steht woertlich hier,
      // weil test:api die 403-Gruende in der Seite sucht, die sie liest.
      showError(error?.data?.reason === 'not_a_household_member'
        ? t('settings.devicesPairNotMember')
        : errorSentence(error, 'settings.devicesPairError'));
    } finally {
      pairButton.removeAttribute('aria-disabled');
    }
  });

  // Ein Abmelden hat kein Rueckgaengig: das Credential ist danach tot, das
  // Geraet muss neu gekoppelt werden. Deshalb die Rueckfrage vorab.
  list.addEventListener('click', async (event) => {
    const button = event.target.closest('[data-revoke-device]');
    if (!button) return;
    const id = Number(button.dataset.revokeDevice);
    const name = button.dataset.name;
    if (!await confirmModal(t('settings.devicesRevokeConfirm', { name }), {
      danger: true,
      confirmLabel: t('settings.devicesRevoke'),
      detail: t('settings.devicesRevokeDetail'),
    })) return;
    try {
      await api.delete(`/auth/devices/${id}`);
      fill((known ?? []).filter((device) => device.id !== id));
      refocusAfterRender();
      window.yuvomi?.showToast(t('settings.devicesRevokedToast', { name }), 'default');
    } catch (error) {
      window.yuvomi?.showToast(errorSentence(error), 'danger');
      load();
    }
  });

  // Wer auf demselben Telefon "In der App oeffnen" tippt, kommt danach hierher
  // zurueck: dann soll das Geraet schon in der Liste stehen.
  const onVisible = () => {
    if (!card.isConnected) return detach();
    if (document.visibilityState === 'visible') (pairing ? tick() : load());
    return undefined;
  };
  // "Auf anderen Geraeten abmelden", ein neues Passwort und das Einschalten der
  // Zwei-Faktor-Anmeldung widerrufen alle Geraete und entwerten den offenen Code
  // (`invalidateUserSessions()` in server/auth.js): der Code verschwindet, die
  // Liste kommt neu.
  const onOtherSessionsEnded = () => {
    if (!card.isConnected) return detach();
    stopPairing();
    panel.hidden = true;
    body.hidden = true;
    status.textContent = '';
    pairButton.textContent = t('settings.devicesPair');
    load();
    return undefined;
  };
  const detach = () => {
    stopPairing();
    document.removeEventListener('visibilitychange', onVisible);
    document.removeEventListener('other-sessions-ended', onOtherSessionsEnded);
  };
  detachPrevious?.();
  detachPrevious = detach;
  document.addEventListener('visibilitychange', onVisible);
  document.addEventListener('other-sessions-ended', onOtherSessionsEnded);

  load();
}
