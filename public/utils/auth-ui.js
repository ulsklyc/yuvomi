/**
 * Modul: Bausteine der Auth-Seiten (auth-ui)
 * Zweck: EIN Kopf, EIN Passwortfeld, EIN Fehlerfeld fuer Anmeldung,
 *        Ersteinrichtung, Einladung und Passwort-Reset.
 * Abhaengigkeiten: /utils/html.js
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
        <span class="auth-hero__mark" aria-hidden="true">
          <svg viewBox="0 0 160 160" fill="currentColor">
            <g fill-opacity="0.82">
              <circle cx="64" cy="72" r="27" />
              <circle cx="100" cy="78" r="25" />
              <circle cx="80" cy="106" r="24" />
            </g>
          </svg>
        </span>
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
