/**
 * Modul: Install-Prompt Web Component
 * Zweck: Dezentes Banner für PWA-Installation (Chrome/Android) und iOS-Anleitung
 * Abhängigkeiten: Design Tokens aus tokens.css (via CSS custom properties), i18n.js (t)
 *
 * Verhalten:
 *   - Chrome/Android: Fängt beforeinstallprompt ab, zeigt Install-Banner
 *   - iOS (Safari): Zeigt Anleitung "Zum Home-Bildschirm"
 *   - Standalone-Modus: Zeigt nichts an
 *   - Dismiss: 7 Tage via localStorage gespeichert
 *   - Timing: Banner erst nach 2 Nutzer-Interaktionen anzeigen
 */

import { t, whenI18nReady } from '/i18n.js';
import {
  getPwaInstallState,
  onPwaInstallStateChanged,
  promptPwaInstall,
} from '/utils/pwa-install.js';

const DISMISS_KEY = 'yuvomi-install-dismissed';
const DISMISS_DURATION_MS = 7 * 24 * 60 * 60 * 1000; // 7 Tage

const INTERACTION_KEY = 'yuvomi-install-interactions';
const INTERACTION_THRESHOLD = 2;

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

  disconnectedCallback() {
    window.removeEventListener('beforeinstallprompt', this._onBeforeInstall);
    if (this._offInteraction) this._offInteraction();
    if (this._offInstallState) this._offInstallState();
    if (this._onLocaleChanged) {
      window.removeEventListener('locale-changed', this._onLocaleChanged);
    }
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
        bottom: calc(var(--nav-height-mobile, 56px) + env(safe-area-inset-bottom, 0px) + 8px);
        left: var(--space-3, 12px);
        right: var(--space-3, 12px);
        z-index: var(--z-toast, 300);
        pointer-events: none;
      }

      .banner {
        display: flex;
        align-items: center;
        gap: var(--space-3, 12px);
        padding: var(--space-3, 12px) var(--space-4, 16px);
        background: var(--color-surface, #fff);
        border: 1px solid var(--color-border, #e8e7e2);
        border-radius: var(--radius-md, 12px);
        box-shadow: var(--shadow-md, 0 2px 8px rgba(0,0,0,0.08));
        pointer-events: auto;
        transform: translateY(calc(100% + 20px));
        transition: transform 0.35s cubic-bezier(0.16, 1, 0.3, 1);
      }

      .banner--visible {
        transform: translateY(0);
      }

      .icon {
        width: 40px;
        height: 40px;
        border-radius: var(--radius-sm, 8px);
        flex-shrink: 0;
      }

      .text {
        flex: 1;
        min-width: 0;
      }

      .title {
        font-family: var(--font-sans, system-ui);
        font-size: var(--text-base, 0.875rem);
        font-weight: var(--font-weight-semibold, 600);
        color: var(--color-text-primary, #1c1c1a);
        line-height: var(--line-height-tight, 1.25);
      }

      .subtitle {
        font-family: var(--font-sans, system-ui);
        font-size: var(--text-sm, 0.8125rem);
        color: var(--color-text-secondary, #6c6b67);
        line-height: var(--line-height-base, 1.5);
        margin-top: 2px;
      }

      .btn-install {
        flex-shrink: 0;
        padding: var(--space-2, 8px) var(--space-4, 16px);
        background: var(--color-btn-primary, #4338CA);
        color: var(--color-text-on-accent, #fff);
        border: none;
        border-radius: var(--radius-sm, 8px);
        font-family: var(--font-sans, system-ui);
        font-size: var(--text-sm, 0.8125rem);
        font-weight: var(--font-weight-semibold, 600);
        cursor: pointer;
        min-height: 36px;
        min-width: 36px;
        transition: background 0.15s ease;
      }

      .btn-install:hover {
        background: var(--color-btn-primary-hover, #1E429A);
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
        border-radius: var(--radius-xs, 4px);
        cursor: pointer;
        color: var(--color-text-tertiary, #737370);
        padding: 0;
        min-height: 32px;
        min-width: 32px;
        transition: background 0.15s ease;
      }

      .btn-dismiss:hover {
        background: var(--color-surface-3, #efeee9);
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

      @media (min-width: 1024px) {
        :host {
          /* Desktop: Sidebar statt Bottom-Nav, Banner unten rechts */
          bottom: calc(var(--space-4, 16px) + env(safe-area-inset-bottom, 0px));
          left: auto;
          right: var(--space-4, 16px);
          max-width: 380px;
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

  /** Banner mit Slide-out entfernen */
  _remove() {
    const banner = this._shadow.querySelector('.banner');
    if (!banner) return;

    banner.classList.remove('banner--visible');
    banner.addEventListener('transitionend', () => this.remove(), { once: true });
  }

  /** iOS: Banner direkt anzeigen */
  _showIOSPrompt() {
    this._showBanner(true);
  }
}

customElements.define('yuvomi-install-prompt', YuvomiInstallPrompt);
