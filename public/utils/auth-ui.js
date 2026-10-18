/**
 * Modul: Bausteine der Auth-Seiten (auth-ui)
 * Zweck: EIN Kopf, EIN Passwortfeld, EIN Fehlerfeld fuer Anmeldung,
 *        Ersteinrichtung, Einladung und Passwort-Reset.
 * Abhaengigkeiten: /utils/html.js, /utils/brand-mark.js
 *
 * WARUM (Critique 2026-10-05, R16 "Bausteine werden nicht vererbt"): die fuenf
 * Seiten vor der Anmeldung bauten dieselben drei Dinge je selbst.
 * - Die Marke stand nur auf der Anmeldung; Einrichtung, Einladung und Reset
 *   begannen ohne ein Zeichen, wessen Seite das ist - ausgerechnet dort, wo
 *   jemand ueber einen Link aus einer E-Mail ankommt.
 * - Das Auge am Passwortfeld gab es auf Anmeldung und Einrichtung (zweimal
 *   derselbe Code), auf Einladung und Reset nicht - dort tippt man ein NEUES
 *   Passwort zweimal blind.
 * - Das Fehlerfeld stand in drei Fassungen da: `role="alert"` mit
 *   `tabindex="-1"`, `role="alert"` mit `aria-live="polite"` (ein Widerspruch:
 *   alert ist assertiv) und beides gemischt.
 */
import { esc } from '/utils/html.js';
import { brandMarkSvg } from '/utils/brand-mark.js';

const DEFAULT_APP_NAME = 'Yuvomi';
const APP_NAME_STORAGE_KEY = 'yuvomi-app-name';

/** Der Name, unter dem dieser Haushalt die App fuehrt (zuletzt vom Server gemeldet). */
export function getStoredAppName() {
  try {
    return localStorage.getItem(APP_NAME_STORAGE_KEY) || DEFAULT_APP_NAME;
  } catch {
    return DEFAULT_APP_NAME;
  }
}

/**
 * Der Kopf einer Auth-Seite: Marke, Name, optional ein Satz darunter.
 *
 * `heading: true` macht den Namen zur <h1> (Anmeldung, Einrichtung - die Karte
 * darunter traegt keinen eigenen Titel). `false` setzt ihn als Absatz ueber
 * eine Karte, die ihre eigene <h1> hat (Einladung, Reset): eine Seite, eine h1.
 *
 * @param {object} o
 * @param {string} [o.appName]
 * @param {string} [o.tagline]
 * @param {boolean} [o.heading=true]
 */
export function authHeroHtml({ appName = getStoredAppName(), tagline = '', heading = true } = {}) {
  const tag = heading ? 'h1' : 'p';
  return `
      <div class="auth-hero${heading ? '' : ' auth-hero--compact'}">
        <span class="auth-hero__mark" aria-hidden="true">${brandMarkSvg()}</span>
        <${tag} class="auth-hero__title">${esc(appName)}</${tag}>
        ${tagline ? `<p class="auth-hero__tagline">${esc(tagline)}</p>` : ''}
      </div>`;
}

/**
 * Das eine Fehlerfeld. `role="alert"` sagt den Fehler sofort an (und bringt
 * sein eigenes, assertives Live-Verhalten mit - kein `aria-live` daneben);
 * `tabindex="-1"` laesst die Seite den Fokus darauf setzen, damit auch
 * sehende Tastaturnutzer dort landen, wo die Meldung steht.
 */
export function authErrorHtml(id) {
  return `<div class="form-error" id="${esc(id)}" role="alert" tabindex="-1" hidden></div>`;
}

/**
 * Das Auge am Passwortfeld: umhuellt das Feld und haengt den Umschalter an.
 * Ein echter Knopf nach dem Feld in der Tab-Folge, sein Name nennt, was der
 * naechste Druck tut ("Passwort anzeigen" / "Passwort verbergen").
 *
 * @param {HTMLInputElement|null} input
 * @param {{ show: string, hide: string }} labels  schon uebersetzt
 * @returns {HTMLButtonElement|null}
 */
export function wirePasswordToggle(input, { show, hide }) {
  if (!input?.parentNode) return null;
  const wrapper = document.createElement('div');
  wrapper.className = 'input-password-wrapper';
  input.parentNode.insertBefore(wrapper, input);
  wrapper.appendChild(input);

  const toggle = document.createElement('button');
  toggle.type = 'button';
  toggle.className = 'password-toggle';
  toggle.setAttribute('aria-label', show);
  const icon = document.createElement('i');
  icon.setAttribute('data-lucide', 'eye');
  icon.setAttribute('aria-hidden', 'true');
  toggle.appendChild(icon);
  wrapper.appendChild(toggle);
  if (window.lucide) window.lucide.createIcons({ el: toggle });

  toggle.addEventListener('click', () => {
    const reveal = input.type === 'password';
    input.type = reveal ? 'text' : 'password';
    // Lucide ersetzt das <i> durch ein <svg>: das Zeichen wird neu gesetzt,
    // nicht umgeschrieben.
    const next = document.createElement('i');
    next.setAttribute('data-lucide', reveal ? 'eye-off' : 'eye');
    next.setAttribute('aria-hidden', 'true');
    toggle.replaceChildren(next);
    toggle.setAttribute('aria-label', reveal ? hide : show);
    if (window.lucide) window.lucide.createIcons({ el: toggle });
  });
  return toggle;
}

/**
 * DIE PASSWORTREGEL VOR DEM ERSTEN VERSUCH (Modern-Web-Guidance-Audit,
 * Befund 15). Einrichtung, Einladung und Reset nannten "mindestens 8 Zeichen"
 * erst als Fehler, nachdem man abgeschickt hatte. Der Hinweis steht unter dem
 * neuen Passwort, das Feld zeigt per `aria-describedby` auf ihn.
 *
 * @param {string} id    die id, auf die das Feld zeigt
 * @param {string} text  schon uebersetzt
 */
export function passwordRuleHtml(id, text) {
  return `<p class="auth-form__hint" id="${esc(id)}">${esc(text)}</p>`;
}

/**
 * DER FEHLER STEHT AM FELD, nicht nur im Fehlerfeld oben: `aria-invalid` und
 * ein `aria-describedby` auf die Meldung (ein vorhandener Hinweis bleibt
 * davor stehen). Die naechste Eingabe in diesem Feld nimmt beides zurueck.
 *
 * @param {HTMLElement|null} field
 * @param {HTMLElement|null} errorEl  das Fehlerfeld aus `authErrorHtml()`
 */
export function flagField(field, errorEl) {
  if (!field || !errorEl?.id) return;
  field.setAttribute('aria-invalid', 'true');
  const ids = (field.getAttribute('aria-describedby') || '').split(/\s+/).filter(Boolean);
  if (!ids.includes(errorEl.id)) field.setAttribute('aria-describedby', [...ids, errorEl.id].join(' '));
  if (field._authFlagged) return;
  field._authFlagged = true;
  // Wer das Feld korrigiert, nimmt die Meldung mit - auf JEDER Seite, nicht nur
  // dort, wo ein eigener Eingabe-Handler sie ausblendet: auf Einladung und Reset
  // stand "stimmt nicht ueberein" sonst bis zum naechsten Absenden da
  // (Codex-Review zu #2059). Ohne Formular nur dieses Feld.
  field.addEventListener('input', () => {
    if (field.form) hideAuthError(field.form, errorEl);
    else unflagField(field, errorEl);
  }, { once: true });
}

/** Nimmt Markierung und Verweis auf die Meldung von EINEM Feld. */
function unflagField(field, errorEl) {
  field._authFlagged = false;
  field.removeAttribute('aria-invalid');
  const rest = (field.getAttribute('aria-describedby') || '').split(/\s+/).filter((id) => id && id !== errorEl.id);
  if (rest.length) field.setAttribute('aria-describedby', rest.join(' '));
  else field.removeAttribute('aria-describedby');
}

/**
 * MELDUNG WEG, MARKIERUNGEN WEG - zusammen (Codex-Review zu #2059). Blendete
 * eine Seite ihr Fehlerfeld bei der ersten Eingabe aus, blieben die ANDEREN
 * markierten Felder `aria-invalid` und zeigten auf eine Meldung, die niemand
 * mehr sah. Wer die Meldung ausblendet, nimmt hiermit jede Markierung ab, die
 * auf sie zeigt.
 *
 * @param {HTMLElement|null} form
 * @param {HTMLElement|null} errorEl
 */
export function hideAuthError(form, errorEl) {
  if (!errorEl) return;
  errorEl.hidden = true;
  for (const field of form?.querySelectorAll?.('[aria-invalid="true"]') ?? []) {
    if ((field.getAttribute('aria-describedby') || '').split(/\s+/).includes(errorEl.id)) unflagField(field, errorEl);
  }
}
