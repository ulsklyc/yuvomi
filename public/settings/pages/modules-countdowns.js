import { t } from '/i18n.js';
import { getPreferences, savePreferences } from '/settings/preferences-cache.js';
import { settingRowHtml } from '/settings/components.js';

// Spiegelt MAX_COUNTDOWN_GRACE_DAYS in server/routes/preferences (#969).
const MAX_COUNTDOWN_GRACE_DAYS = 90;
const DEFAULT_GRACE_DAYS = 7;

/**
 * Feldwert als Nachfrist-Tage lesen, oder `null` bei ungültiger Eingabe.
 * Ein leeres/nur-Leerzeichen-Feld ist ausdrücklich ungültig statt `0` - anders
 * als bei rewards-default-points ist `0` hier nicht folgenlos, sondern lässt
 * jeden überfälligen Countdown sofort verschwinden (Review-Fund 2026-09-06,
 * #1027). `Number('')` wäre sonst `0` und ein versehentlich geleertes Feld
 * würde diesen Wert unbemerkt speichern.
 */
export function parseGraceDaysInput(raw) {
  if (String(raw).trim() === '') return null;
  const n = Math.trunc(Number(raw));
  if (!Number.isFinite(n) || n < 0 || n > MAX_COUNTDOWN_GRACE_DAYS) return null;
  return n;
}

function renderPage(container, preferences) {
  container.replaceChildren();
  container.insertAdjacentHTML('beforeend', `
    <section class="settings-section">
      <!-- Eine Zeile im Traeger statt einer Karte fuer ein Feld (R17, E9). Der
           fruehere Kartentitel ist die Ueberschrift des Abschnitts (der
           Suchtreffer), der Hinweis der Fuss der Gruppe. -->
      <h2 class="settings-section__title">${t('settings.countdownGraceDaysTitle')}</h2>
      <div class="row-carrier settings-group">
        <!-- EIN EINZELNES KURZFELD SPEICHERT BEIM VERLASSEN (H12 vom 27.09.,
             R17 Schritt 5): dieselbe Antwort wie das Punktefeld der Belohnungen
             - beim Verlassen und mit Enter, quittiert per Toast. Ein eigener
             Speichern-Knopf fuer EIN Zahlfeld gab derselben Frage in zwei
             Blaettern zwei Antworten. Blaetter mit echten Formularen (Konto,
             Passwort, CalDAV, SMTP) behalten den Knopf rechts im Kartenfuss. -->
        ${settingRowHtml({
          label: t('settings.countdownGraceDaysLabel'),
          labelFor: 'countdown-grace-days',
          extra: '<div id="countdown-grace-days-error" class="form-error" role="alert" hidden></div>',
          control: `<form class="settings-row-form" id="countdown-grace-days-form" novalidate autocomplete="off">
            <input class="form-input" type="number" id="countdown-grace-days" inputmode="numeric"
                   min="0" max="${MAX_COUNTDOWN_GRACE_DAYS}" step="1"
                   enterkeyhint="done" aria-describedby="countdown-grace-days-hint countdown-grace-days-error"
                   value="${Number.isFinite(preferences.countdown_grace_days) ? preferences.countdown_grace_days : DEFAULT_GRACE_DAYS}">
          </form>`,
        })}
      </div>
      <p class="form-hint settings-group__footer" id="countdown-grace-days-hint">${t('settings.countdownGraceDaysHint')}</p>
    </section>
  `);
}

/**
 * Nachfrist für abgelaufene Countdowns (#969). Speichert wie das Punktefeld der
 * Belohnungen (modules-rewards.js, H12) ohne eigenen Knopf: beim Verlassen des
 * Feldes und mit Enter. Nicht bei jedem `change` - an Zahlenfeldern feuert er
 * für jeden Pfeilschritt, und `0` ist hier nicht folgenlos (jeder überfällige
 * Countdown verschwände sofort). Escape nimmt eine noch nicht gespeicherte
 * Eingabe zurück.
 */
export function bindGraceDays(container, preferences) {
  const form = container.querySelector('#countdown-grace-days-form');
  const input = container.querySelector('#countdown-grace-days');
  const errorEl = container.querySelector('#countdown-grace-days-error');
  if (!form || !input) return;

  let persisted = Number.isFinite(preferences.countdown_grace_days) ? preferences.countdown_grace_days : DEFAULT_GRACE_DAYS;
  let saving = false;

  const showError = (message) => {
    errorEl.textContent = message;
    errorEl.hidden = false;
    input.setAttribute('aria-invalid', 'true');
  };
  const clearError = () => {
    errorEl.hidden = true;
    input.removeAttribute('aria-invalid');
  };

  async function commit() {
    if (saving) return;
    const next = parseGraceDaysInput(input.value ?? '');
    if (next === null) {
      showError(t('settings.countdownGraceDaysInvalid', { max: MAX_COUNTDOWN_GRACE_DAYS }));
      return;
    }
    clearError();
    if (next === persisted) {
      input.value = String(next);
      return;
    }

    // Feld sperren, solange der Request läuft - sonst überschreibt der
    // Erfolgspfad eine Eingabe, die währenddessen getippt wurde. `readOnly`
    // statt `disabled`: ein deaktiviertes Feld verliert nach Enter den Fokus.
    saving = true;
    input.readOnly = true;
    input.setAttribute('aria-busy', 'true');
    const previous = persisted;
    try {
      await savePreferences({ countdown_grace_days: next });
      persisted = next;
      input.value = String(next);
      preferences.countdown_grace_days = next;
      window.yuvomi?.showToast(t('settings.countdownGraceDaysSaved'), 'success');
    } catch (error) {
      input.value = String(previous); // Rollback
      showError(error.message || t('common.errorGeneric'));
    } finally {
      saving = false;
      input.readOnly = false;
      input.removeAttribute('aria-busy');
    }
  }

  // Die Handler geben das Versprechen zurück: dem Browser ist es gleich, ein
  // Test kann so auf den ganzen Speichervorgang warten.
  form.addEventListener('submit', (event) => {
    event.preventDefault();
    return commit();
  });
  input.addEventListener('blur', () => commit());
  input.addEventListener('keydown', (event) => {
    if (event.key !== 'Escape' || saving) return;
    input.value = String(persisted);
    clearError();
  });
}

export async function render(container, { user }) {
  void user;
  const preferences = await getPreferences();
  renderPage(container, preferences);
  bindGraceDays(container, preferences);
}
