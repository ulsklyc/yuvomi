/**
 * Modul: Install-Prompt Web Component
 * Zweck: Dezentes Banner für PWA-Installation (Chrome/Android) und iOS-Anleitung
 * Abhängigkeiten: Design Tokens aus tokens.css (via CSS custom properties), i18n.js (t)
 *
 * Verhalten:
 *   - Chrome/Android: Fängt beforeinstallprompt ab, zeigt Install-Banner
 *   - iOS (Safari): Zeigt Anleitung "Zum Home-Bildschirm"
 *   - Standalone-Modus: Zeigt nichts an
 *   - Dismiss (X): 30 Tage via localStorage gespeichert
 *   - Jede tatsaechliche Anzeige: 24h Ruhe (SEEN_KEY) - sonst kam das Banner
 *     bei jedem Seitenwechsel wieder
 *   - Timing: Banner erst nach 2 Nutzer-Interaktionen anzeigen
 */

import { t, whenI18nReady } from '/i18n.js';
import {
  getPwaInstallState,
  onPwaInstallStateChanged,
  promptPwaInstall,
} from '/utils/pwa-install.js';

/**
 * DER ZUSTAND, AN DEM DER NACHLAUF HAENGT.
 *
 * layout.css reserviert unter jedem Scrollport Platz fuer dieses Banner. Die
 * Bedingung dort war `:root:has(yuvomi-install-prompt)` - also die ANWESENHEIT
 * des Elements. Das Element steht statisch in index.html und ist damit nie
 * abwesend: es rendert 0x0 mit leerem Shadow-Root, solange keine der
 * Bedingungen in `connectedCallback` erfuellt ist (installiert, weggeklickt,
 * zu wenige Interaktionen) - und auf iOS feuert `beforeinstallprompt` ohnehin
 * nie. Gemessen kostete das JEDEN Scrollport der App dauerhaft 105px, ohne
 * dass je ein Banner zu sehen war; im Kalender waren das 21% der Rasterhoehe
 * auf dem Telefon.
 *
 * Das Attribut sagt „ich belege gerade Flaeche" und wird genau dann gesetzt,
 * wenn das Banner tatsaechlich im Shadow-Root steht. Der 89px-Fallback der
 * Hoehe bleibt davon unberuehrt - er traegt weiter das Fenster zwischen Render
 * und erster ResizeObserver-Meldung.
 */
const SHOWN_ATTR = 'data-shown';

const DISMISS_KEY = 'yuvomi-install-dismissed';
// 30 Tage statt 7 (Critique 2026-08-27): wer bewusst im Browser bleibt, sah
// das Banner sonst ~4x im Monat neu - fuer eine Familien-App ist ein ruhiger
// Monatstakt die passendere Erinnerung als ein Wochentakt.
const DISMISS_DURATION_MS = 30 * 24 * 60 * 60 * 1000; // 30 Tage

const INTERACTION_KEY = 'yuvomi-install-interactions';
const INTERACTION_THRESHOLD = 2;

// EIN Blick pro Tag statt einer je Navigation: das Bauteil wird bei jedem
// Seitenwechsel neu eingehaengt und legte sich damit auf JEDER Route erneut
// ueber Daumenzone und FAB (~110px), bis X gedrueckt war (Critique 2026-08-31,
// P2). Jede TATSAECHLICHE Anzeige startet deshalb eine 24h-Ruhe - das deckt
// die laufende Sitzung gleich mit ab. Das ausdrueckliche X behaelt seine
// 30 Tage (DISMISS_DURATION_MS oben).
const SEEN_KEY = 'yuvomi-install-seen';
const SEEN_QUIET_MS = 24 * 60 * 60 * 1000; // 24 Stunden

// Auto-Hide als Soft-Dismiss: das Bauteil ist PERSISTENT (index.html, ausserhalb
// des Seiten-Swaps) - ein einmal gezeigtes Banner stuende sonst die GANZE
// Sitzung auf jeder Route ueber Daumenzone und FAB. 15s reichen, um auch die
// iOS-Anleitung zu lesen; die 24h-Ruhe ist beim Anzeigen laengst geschrieben.
const AUTO_HIDE_MS = 15000;

class YuvomiInstallPrompt extends HTMLElement {
  constructor() {
    super();
    this._deferredPrompt = null;
    this._shadow = this.attachShadow({ mode: 'open' });
  }

  connectedCallback() {
    // Bereits im Standalone-Modus - nichts anzeigen
    if (getPwaInstallState().installed) {
      return;
    }

    // Dismiss noch aktiv?
    const dismissed = localStorage.getItem(DISMISS_KEY);
    if (dismissed && Date.now() - Number(dismissed) < DISMISS_DURATION_MS) {
      return;
    }

    // Heute schon gesehen? Dann Ruhe bis morgen (siehe SEEN_KEY oben).
    const seen = localStorage.getItem(SEEN_KEY);
    if (seen && Date.now() - Number(seen) < SEEN_QUIET_MS) {
      return;
    }

    // locale-changed: Banner neu rendern wenn Sprache wechselt
    this._onLocaleChanged = () => {
      if (this._currentIsIOS !== undefined) {
        this._showBanner(this._currentIsIOS);
      }
    };
    window.addEventListener('locale-changed', this._onLocaleChanged);

    // Noch nicht genug Interaktionen
    const interactions = Number(localStorage.getItem(INTERACTION_KEY) || '0');
    if (interactions < INTERACTION_THRESHOLD) {
      this._waitForInteractions();
      return;
    }

    if (this._isIOS()) {
      this._showIOSPrompt();
    } else {
      this._listenForInstallPrompt();
    }
  }

  /**
   * EIN `disconnectedCallback`, und das ist der eigentliche Befund.
   *
   * Diese Klasse hatte ZWEI davon - diesen und einen zweiten unten beim
   * ResizeObserver. In einer JS-Klasse gewinnt die spaetere Definition
   * kommentarlos: der Listener-Abbau hier lief nie. Nach jedem `_remove()`
   * blieben `beforeinstallprompt`, `locale-changed` und der Click-Zaehler auf
   * `document` haengen - letzterer schrieb bei jedem Klick der Sitzung weiter
   * in localStorage hoch, obwohl das Banner laengst weg war. Kein Test konnte
   * das sehen, weil beide Fassungen fuer sich richtig aussahen.
   */
  disconnectedCallback() {
    clearTimeout(this._autoHideTimer);
    window.removeEventListener('beforeinstallprompt', this._onBeforeInstall);
    if (this._offInteraction) this._offInteraction();
    if (this._offInstallState) this._offInstallState();
    if (this._onLocaleChanged) {
      window.removeEventListener('locale-changed', this._onLocaleChanged);
    }

    // Die gemeldete Hoehe geht mit dem Banner. Sie steht am `html`-Element und
    // ueberlebte sonst jedes Entfernen - der Nachlauf am Seitenende bliebe als
    // Loch stehen, obwohl nichts mehr darueber liegt.
    this._sizeObserver?.disconnect();
    this._sizeObserver = null;
    document.documentElement.style.removeProperty('--install-prompt-height');
    this.removeAttribute(SHOWN_ATTR);
  }

  _waitForInteractions() {
    const onInteraction = () => {
      const count = Number(localStorage.getItem(INTERACTION_KEY) || '0') + 1;
      localStorage.setItem(INTERACTION_KEY, String(count));

      if (count >= INTERACTION_THRESHOLD) {
        document.removeEventListener('click', onInteraction);
        if (this._isIOS()) {
          this._showIOSPrompt();
        } else {
          this._listenForInstallPrompt();
        }
      }
    };
    document.addEventListener('click', onInteraction);
    this._offInteraction = () => document.removeEventListener('click', onInteraction);
  }

  /** iOS Safari erkennen (kein beforeinstallprompt-Support) */
  _isIOS() {
    return getPwaInstallState().ios;
  }

  /** Chrome/Android: beforeinstallprompt abfangen */
  _listenForInstallPrompt() {
    this._onBeforeInstall = () => {
      this._showBanner(false);
    };
    this._offInstallState = onPwaInstallStateChanged((state) => {
      if (state.canPrompt) this._onBeforeInstall();
    });
  }

  /** Banner rendern */
  async _showBanner(isIOS) {
    await whenI18nReady();
    if (!this.isConnected) return;

    this._currentIsIOS = isIOS;
    this._shadow.replaceChildren();

    const style = document.createElement('style');
    style.textContent = `
      :host {
        display: block;
        position: fixed;
        /* Ueber der GANZEN Nav-Zone, nicht ueber der Kapselhoehe.
         * --nav-bottom-height zaehlt Kapsel PLUS Luft PLUS safe-area; die
         * frueher hier nachgerechnete Summe (--nav-height-mobile + safe + 8)
         * liess die 8px Luft ueber der Kapsel aus und legte den Banner damit
         * 8px in die Leiste hinein. Seit der FAB in der Kapsel sitzt, deckt
         * dieser eine Wert auch ihn ab - die Sonderregel in layout.css, die
         * den Banner um den schwebenden Knopf herumschob, ist entfallen. */
        bottom: calc(var(--nav-bottom-height) + var(--space-2));
        left: var(--space-3);
        right: var(--space-3);
        z-index: var(--z-toast);
        pointer-events: none;
      }

      .banner {
        display: flex;
        align-items: center;
        gap: var(--space-3);
        padding: var(--space-3) var(--space-4);
        background: var(--color-surface);
        border: 1px solid var(--color-border);
        border-radius: var(--radius-md);
        box-shadow: var(--shadow-md);
        pointer-events: auto;
        transform: translateY(calc(100% + 20px));
        /* Custom Properties erben in den Shadow Tree: Dauer und Kurve aus
           tokens.css, kein zweiter Satz Literale. */
        transition: transform var(--duration-xl) var(--ease-out);
      }

      .banner--visible {
        transform: translateY(0);
      }

      .icon {
        width: 40px;
        height: 40px;
        border-radius: var(--radius-sm);
        flex-shrink: 0;
      }

      .text {
        flex: 1;
        min-width: 0;
      }

      .title {
        font-family: var(--font-sans);
        font-size: var(--text-base);
        font-weight: var(--font-weight-semibold);
        color: var(--color-text-primary);
        line-height: var(--line-height-tight);
      }

      .subtitle {
        font-family: var(--font-sans);
        font-size: var(--text-sm);
        color: var(--color-text-secondary);
        line-height: var(--line-height-base);
        margin-top: 2px;
      }

      .btn-install {
        flex-shrink: 0;
        padding: var(--space-2) var(--space-4);
        background: var(--color-btn-primary);
        color: var(--color-text-on-accent);
        border: none;
        border-radius: var(--radius-sm);
        font-family: var(--font-sans);
        font-size: var(--text-sm);
        font-weight: var(--font-weight-semibold);
        cursor: pointer;
        min-height: 36px;
        min-width: 36px;
        transition: background var(--transition-fast);
      }

      .btn-install:hover {
        background: var(--color-btn-primary-hover);
      }

      .btn-dismiss {
        flex-shrink: 0;
        width: 32px;
        height: 32px;
        display: flex;
        align-items: center;
        justify-content: center;
        background: none;
        border: none;
        border-radius: var(--radius-xs);
        cursor: pointer;
        color: var(--color-text-tertiary);
        padding: 0;
        min-height: 32px;
        min-width: 32px;
        transition: background var(--transition-fast);
      }

      .btn-dismiss:hover {
        background: var(--color-surface-3);
      }

      .btn-dismiss svg {
        width: 18px;
        height: 18px;
      }

      /* iOS share icon inline */
      .share-icon {
        display: inline-block;
        width: 1em;
        height: 1em;
        vertical-align: -0.1em;
      }

      /* Touch-Maß an (hover: none) statt an der Viewport-Breite - dieselbe
       * Konvention wie bei .filter-chip--sm: das Banner erscheint vor allem auf
       * Mobil und Tablet, wo 32px/36px unter dem 44pt-Minimum lagen. Desktop
       * (Maus) bleibt bei der kompakteren Größe. */
      @media (hover: none) {
        .btn-install {
          min-height: var(--target-base);
        }

        .btn-dismiss {
          width: var(--target-base);
          height: var(--target-base);
          min-width: var(--target-base);
          min-height: var(--target-base);
        }
      }

      @media (min-width: 1024px) {
        :host {
          /* Desktop: Sidebar statt Bottom-Nav, Banner unten rechts */
          bottom: calc(var(--space-4) + env(safe-area-inset-bottom, 0px));
          left: auto;
          right: var(--space-4);
          max-width: 380px;
        }
      }

      /* WER EINEN SHADOW ROOT AUFMACHT, BRINGT DEN MOTION-SCHUTZ SELBST MIT.
       *
       * Der globale Universalselektor-Block in reset.css erreicht einen Shadow
       * Tree NICHT - ein Selektor endet an der Schattengrenze, und diese
       * Komponente ist der einzige Shadow-DOM-Bewohner der App. Gemessen: unter
       * emuliertem prefers-reduced-motion liefert dieselbe Deklaration im Light
       * DOM 0s, hier 0.35s (Audit 2026-08-08, P2-2). Das Banner schob sich also
       * auch dann herein, wenn das Geraet Bewegung reduziert - und es ist die
       * erste Begegnung mit der App auf dem Telefon.
       *
       * PRODUCT.md sagt "All animations respect prefers-reduced-motion" zu; ein
       * globaler Block kann diese Zusage fuer einen Shadow Tree nie einloesen.
       *
       * Der Zustandswechsel bleibt: .banner--visible setzt weiter
       * translateY(0), nur ohne Weg dorthin. Das Banner ERSCHEINT, statt sich
       * hereinzuschieben - und _remove() traegt fuer den Rueckweg eine Frist,
       * weil transitionend ohne Transition nie feuert. */
      @media (prefers-reduced-motion: reduce) {
        .banner,
        .btn-install,
        .btn-dismiss {
          transition: none;
        }
      }
    `;

    const banner = document.createElement('div');
    banner.className = 'banner';
    banner.setAttribute('role', 'alert');

    // App-Icon
    const icon = document.createElement('img');
    icon.className = 'icon';
    icon.src = '/icons/icon-192.png';
    icon.alt = 'Yuvomi';
    icon.width = 40;
    icon.height = 40;
    banner.appendChild(icon);

    // Text
    const text = document.createElement('div');
    text.className = 'text';

    const title = document.createElement('div');
    title.className = 'title';
    title.textContent = t('install.title');

    const subtitle = document.createElement('div');
    subtitle.className = 'subtitle';

    if (isIOS) {
      // iOS: Teilen-Icon als SVG inline
      subtitle.replaceChildren();
      subtitle.append(
        document.createTextNode(t('install.iosTip1')),
        this._createShareIcon(),
        document.createTextNode(t('install.iosTip2'))
      );
    } else {
      subtitle.textContent = t('install.subtitle');
    }

    text.appendChild(title);
    text.appendChild(subtitle);
    banner.appendChild(text);

    // Install-Button (nur Chrome/Android)
    if (!isIOS) {
      const btn = document.createElement('button');
      btn.className = 'btn-install';
      btn.textContent = t('install.installButton');
      btn.addEventListener('click', () => this._onInstallClick());
      banner.appendChild(btn);
    }

    // Dismiss-Button
    const dismiss = document.createElement('button');
    dismiss.className = 'btn-dismiss';
    dismiss.setAttribute('aria-label', t('install.dismissLabel'));
    dismiss.appendChild(this._createDismissIcon());
    dismiss.addEventListener('click', () => this._dismiss());
    banner.appendChild(dismiss);

    this._shadow.appendChild(style);
    this._shadow.appendChild(banner);

    // Ab hier belegt das Bauteil wirklich Flaeche - erst jetzt darf der
    // Nachlauf der Scrollports sie einrechnen (siehe SHOWN_ATTR oben).
    this.setAttribute(SHOWN_ATTR, '');
    // Erst die ECHTE Anzeige startet die 24h-Ruhe - nicht das Einhaengen
    // (das passiert auch, wenn Interaktionsschwelle oder beforeinstallprompt
    // das Banner nie zeigen).
    localStorage.setItem(SEEN_KEY, String(Date.now()));
    // Reset statt Stapeln: _showBanner laeuft bei locale-changed erneut.
    clearTimeout(this._autoHideTimer);
    this._autoHideTimer = setTimeout(() => this._remove(), AUTO_HIDE_MS);

    // DER BANNER MELDET SEINE HOEHE AN DIE SHELL.
    //
    // Er liegt fixiert auf der Toast-Ebene und verdeckte damit das Ende jeder
    // Seite: auf /rewards lagen 89px der letzten Punktestandszeile dauerhaft
    // unter ihm, ohne dass man weiterscrollen konnte. Die Nachlauf-Regeln in
    // layout.css rechnen den Wert in `padding-block-end` von `.app-content`
    // ein; ohne Banner steht die Variable auf 0.
    //
    // GEMESSEN, NICHT GERECHNET: die Hoehe haengt am Text, und der bricht in
    // 24 Sprachen unterschiedlich um. Eine Formel aus Icon plus Polsterung
    // waere in genau den Sprachen falsch, in denen der Titel zweizeilig wird.
    this._sizeObserver?.disconnect();
    this._sizeObserver = new ResizeObserver(([entry]) => {
      const height = entry?.borderBoxSize?.[0]?.blockSize ?? entry?.contentRect?.height ?? 0;
      document.documentElement.style.setProperty('--install-prompt-height', `${Math.ceil(height)}px`);
    });
    this._sizeObserver.observe(banner);

    // Slide-in Animation nach nächstem Frame
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        banner.classList.add('banner--visible');
      });
    });
  }

  /** iOS Teilen-Icon (Box mit Pfeil nach oben) */
  _createShareIcon() {
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('viewBox', '0 0 24 24');
    svg.setAttribute('fill', 'none');
    svg.setAttribute('stroke', 'currentColor');
    svg.setAttribute('stroke-width', '2');
    svg.setAttribute('stroke-linecap', 'round');
    svg.setAttribute('stroke-linejoin', 'round');
    svg.classList.add('share-icon');

    const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    path.setAttribute('d', 'M4 12v8a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-8');
    const polyline = document.createElementNS('http://www.w3.org/2000/svg', 'polyline');
    polyline.setAttribute('points', '16 6 12 2 8 6');
    const line = document.createElementNS('http://www.w3.org/2000/svg', 'line');
    line.setAttribute('x1', '12');
    line.setAttribute('y1', '2');
    line.setAttribute('x2', '12');
    line.setAttribute('y2', '15');

    svg.appendChild(path);
    svg.appendChild(polyline);
    svg.appendChild(line);
    return svg;
  }

  /** Schließen-Icon */
  _createDismissIcon() {
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('viewBox', '0 0 24 24');
    svg.setAttribute('fill', 'none');
    svg.setAttribute('stroke', 'currentColor');
    svg.setAttribute('stroke-width', '2');
    svg.setAttribute('stroke-linecap', 'round');
    svg.setAttribute('stroke-linejoin', 'round');
    svg.setAttribute('aria-hidden', 'true');

    const first = document.createElementNS('http://www.w3.org/2000/svg', 'line');
    first.setAttribute('x1', '18');
    first.setAttribute('y1', '6');
    first.setAttribute('x2', '6');
    first.setAttribute('y2', '18');

    const second = document.createElementNS('http://www.w3.org/2000/svg', 'line');
    second.setAttribute('x1', '6');
    second.setAttribute('y1', '6');
    second.setAttribute('x2', '18');
    second.setAttribute('y2', '18');

    svg.appendChild(first);
    svg.appendChild(second);
    return svg;
  }

  /** Install-Button geklickt */
  async _onInstallClick() {
    try {
      const result = await promptPwaInstall();
      console.log('[yuvomi-install-prompt] Ergebnis:', result.outcome);

      if (result.outcome === 'accepted') {
        this._remove();
      }
    } catch (err) {
      console.error('[yuvomi-install-prompt] Fehler:', err);
    }
    this._deferredPrompt = null;
  }

  /** Dismiss: 7 Tage merken, Interaction-Counter zurücksetzen, Banner entfernen */
  _dismiss() {
    localStorage.setItem(DISMISS_KEY, String(Date.now()));
    localStorage.removeItem(INTERACTION_KEY);
    this._remove();
  }

  /**
   * Banner mit Slide-out entfernen.
   *
   * `transitionend` allein reicht nicht als Ausstieg: bei
   * `prefers-reduced-motion: reduce` gibt es keine Transition, das Ereignis
   * feuert nie, und das Host-Element bliebe samt Listenern im Dokument stehen.
   * Dasselbe gilt fuer eine unterbrochene Transition (Sprachwechsel, Re-Render).
   * Deshalb eine Frist als zweiter Weg hinaus - wer zuerst kommt, gewinnt.
   */
  _remove() {
    const banner = this._shadow.querySelector('.banner');
    if (!banner) return;

    banner.classList.remove('banner--visible');

    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      this.remove();
    };
    // Etwas ueber der 0.35s-Transition; sie ist der Normalfall, die Frist der
    // Notausgang.
    const timer = setTimeout(finish, 400);
    banner.addEventListener('transitionend', finish, { once: true });
  }

  /** iOS: Banner direkt anzeigen */
  _showIOSPrompt() {
    this._showBanner(true);
  }
}

customElements.define('yuvomi-install-prompt', YuvomiInstallPrompt);
