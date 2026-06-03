/**
 * oikos-locale-picker - Sprachauswahl-Web-Component
 * Zeigt ein <select>-Dropdown für System/Deutsch/English.
 * Bei Auswahl: setLocale() oder localStorage-Eintrag löschen (System).
 * Dependencies: i18n.js
 */

import { t, setLocale, getLocale, getSupportedLocales } from '/i18n.js';

const LOCALE_LABELS = {
  de: 'Deutsch',
  en: 'English',
  es: 'Español',
  fr: 'Français',
  it: 'Italiano',
  sv: 'Svenska',
  el: 'Ελληνικά',
  ru: 'Русский',
  tr: 'Türkçe',
  zh: '中文',
  ja: '日本語',
  ar: 'العربية',
  hi: 'हिन्दी',
  pt: 'Português',
  uk: 'Українська',
  pl: 'Polski',
  nl: 'Nederlands',
};

class OikosLocalePicker extends HTMLElement {
  connectedCallback() {
    this._render();
    this._onLocaleChanged = () => this._render();
    window.addEventListener('locale-changed', this._onLocaleChanged);
  }

  disconnectedCallback() {
    window.removeEventListener('locale-changed', this._onLocaleChanged);
  }

  _render() {
    const stored = localStorage.getItem('oikos-locale');

    const label = document.createElement('label');
    label.className = 'locale-picker__label';
    label.htmlFor = 'locale-select';
    label.textContent = t('settings.localeLabel');

    const select = document.createElement('select');
    select.className = 'form-input locale-picker__select';
    select.id = 'locale-select';

    // System-Option
    const systemOpt = document.createElement('option');
    systemOpt.value = 'system';
    systemOpt.textContent = t('settings.localeSystem');
    systemOpt.selected = !stored;
    select.appendChild(systemOpt);

    // Sprach-Optionen
    for (const locale of getSupportedLocales()) {
      const opt = document.createElement('option');
      opt.value = locale;
      opt.textContent = LOCALE_LABELS[locale] || locale;
      opt.selected = stored === locale;
      select.appendChild(opt);
    }

    select.addEventListener('change', () => {
      select.disabled = true;
      select.style.opacity = '0.5';
      if (select.value === 'system') {
        localStorage.removeItem('oikos-locale');
        // Kurze Verzögerung damit der Browser den disabled-Zustand rendert
        setTimeout(() => location.reload(), 60);
      } else {
        setLocale(select.value);
      }
    });

    this.replaceChildren(label, select);
  }
}

customElements.define('oikos-locale-picker', OikosLocalePicker);
