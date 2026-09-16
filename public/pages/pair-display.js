/**
 * Modul: Kopplungsseite fuer ein Wandtablett (#1208)
 * Zweck: Den Kopplungscode entgegennehmen und gegen das Geraete-Credential
 *        tauschen. Danach ist dieses Geraet ein Display.
 * Abhaengigkeiten: /api.js, /i18n.js, /utils/html.js
 *
 * SIE BRAUCHT KEINE ANMELDUNG, UND ZWAR AUS DEMSELBEN GRUND WIE /login: ein
 * frisch aufgehaengtes Tablett hat nichts, womit es sich ausweisen koennte. Was
 * es hat, ist ein Code, den ein Mensch ihm aus den Einstellungen eintippt.
 *
 * WAS DIE SEITE NICHT TUT: sie zeigt kein Ergebnis-Geheimnis, sie merkt sich
 * nichts, und sie hat keinen zweiten Weg. Das Credential kommt als httpOnly-
 * Cookie zurueck - dieses Skript bekommt es nie zu sehen, und genau das ist der
 * Punkt. Nach dem Tausch fuehrt der Weg auf die Uebersicht, und von da an ist
 * das Tablett ein Display.
 */
import { api } from '/api.js';
import { clearApiCache } from '/sw-register.js';
import { t } from '/i18n.js';
import { esc } from '/utils/html.js';

export async function render(container) {
  container.replaceChildren();
  container.insertAdjacentHTML('beforeend', `
    <main class="auth-page" id="main-content">
      <div class="auth-card card card--padded">
        <h1 class="auth-card__title">${esc(t('pairDisplay.title'))}</h1>
        <p class="auth-card__intro">${esc(t('pairDisplay.intro'))}</p>
        <form id="pair-form" class="auth-form" autocomplete="off">
          <div class="form-group">
            <label class="form-label" for="pair-code">${esc(t('pairDisplay.codeLabel'))}</label>
            <input class="form-input" type="text" id="pair-code" required
                   autocapitalize="characters" autocorrect="off" spellcheck="false"
                   inputmode="text" maxlength="14" />
            <p class="form-hint">${esc(t('pairDisplay.codeHint'))}</p>
          </div>
          <div class="form-group">
            <label class="form-label" for="pair-label">${esc(t('pairDisplay.labelLabel'))}</label>
            <input class="form-input" type="text" id="pair-label" maxlength="120" />
            <p class="form-hint">${esc(t('pairDisplay.labelHint'))}</p>
          </div>
          <div id="pair-error" class="form-error" role="alert" hidden></div>
          <button type="submit" class="btn btn--primary auth-form__submit">${esc(t('pairDisplay.submit'))}</button>
        </form>
      </div>
    </main>
  `);

  const form = container.querySelector('#pair-form');
  const errorEl = container.querySelector('#pair-error');

  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    errorEl.hidden = true;
    const code = container.querySelector('#pair-code').value.trim();
    const label = container.querySelector('#pair-label').value.trim();
    const btn = form.querySelector('[type=submit]');
    btn.disabled = true;
    try {
      await api.post('/displays/pair', { code, label: label || null });
      // DER OFFLINE-CACHE MUSS WEG, BEVOR NEU GELADEN WIRD. Wer ein Tablett
      // koppelt, auf dem vorher ein Mitglied angemeldet war, wechselt hier den
      // Nutzer - und der Service Worker haelt Antworten von `/dashboard`,
      // `/tasks` und `/calendar` nach Request-URL vor und liefert sie aus, wenn
      // das Netz fehlt. Ohne dieses Leeren bekaeme das eingeschraenkte Display
      // im Offline-Fall die privaten Daten der Person, die das Geraet vorher
      // benutzt hat. Abmelden und Sitzungsende tun dasselbe und aus demselben
      // Grund (api.js, router.js).
      clearApiCache();
      // Ein voller Neuaufbau statt einer Navigation im Router: das Cookie ist
      // gerade erst entstanden, und alles, was die App ueber „wer bin ich"
      // schon im Speicher hat, stammt von davor.
      window.location.href = '/';
    } catch (err) {
      // Der Server unterscheidet unbekannt, abgelaufen und schon benutzt
      // bewusst nicht - diese Seite tut es also auch nicht.
      errorEl.textContent = err.message || t('pairDisplay.failed');
      errorEl.hidden = false;
      btn.disabled = false;
    }
  });
}
