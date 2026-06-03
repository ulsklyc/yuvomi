/**
 * i18n-mini — schlanke Internationalisierung für den Oikos-Installer.
 * Spiegelt die Locale-Auflösung der App (public/i18n.js:26-34) wider, ohne
 * deren Abhängigkeiten. Keine externen Libs, reine Fetch-/DOM-/Intl-APIs.
 *
 * de ist die Referenzlocale, en der Fallback für fehlende Schlüssel.
 */

export const SUPPORTED_LOCALES = ['de', 'en', 'es', 'fr', 'it', 'sv', 'el', 'ru', 'tr', 'zh', 'ja', 'ar', 'hi', 'pt', 'uk', 'pl', 'nl'];
const FALLBACK_LOCALE = 'en';
const RTL_LOCALES = ['ar'];

let translations = {};
let fallbackTranslations = {};
let activeLocale = FALLBACK_LOCALE;

/** Browsersprache > Englisch, analog public/i18n.js:31-34. */
export function resolveLocale(languages = navigator.languages || [navigator.language]) {
  for (const tag of languages) {
    const base = (tag || '').split('-')[0].toLowerCase();
    if (SUPPORTED_LOCALES.includes(base)) return base;
  }
  return FALLBACK_LOCALE;
}

async function loadLocale(locale) {
  const resp = await fetch(`/locales/${locale}.json`);
  if (!resp.ok) throw new Error(`Failed to load locale: ${locale}`);
  return resp.json();
}

/** Einmal beim Laden des Installers aufrufen. Setzt lang/dir am <html>. */
export async function initInstallerI18n() {
  activeLocale = resolveLocale();
  fallbackTranslations = await loadLocale(FALLBACK_LOCALE).catch(() => ({}));
  if (activeLocale === FALLBACK_LOCALE) {
    translations = fallbackTranslations;
  } else {
    try {
      translations = await loadLocale(activeLocale);
    } catch {
      translations = fallbackTranslations;
      activeLocale = FALLBACK_LOCALE;
    }
  }
  document.documentElement.lang = activeLocale;
  document.documentElement.dir = RTL_LOCALES.includes(activeLocale) ? 'rtl' : 'ltr';
  return activeLocale;
}

export function getLocale() {
  return activeLocale;
}

/** Dot-Notation in verschachteltem Objekt auflösen. */
function resolve(obj, key) {
  return key.split('.').reduce((o, k) => (o != null ? o[k] : undefined), obj);
}

/** Übersetzung mit {{platzhalter}}-Ersetzung; Fallback en > Schlüssel selbst. */
export function t(key, params = {}) {
  let str = resolve(translations, key) ?? resolve(fallbackTranslations, key) ?? key;
  for (const [k, v] of Object.entries(params)) {
    str = str.replaceAll(`{{${k}}}`, String(v));
  }
  return str;
}

/**
 * Setzt textContent für [data-i18n] und placeholder für [data-i18n-ph].
 * Reine DOM-API, kein innerHTML.
 */
export function applyTranslations(root = document) {
  root.querySelectorAll('[data-i18n]').forEach(el => {
    el.textContent = t(el.dataset.i18n);
  });
  root.querySelectorAll('[data-i18n-ph]').forEach(el => {
    el.placeholder = t(el.dataset.i18nPh);
  });
}

/**
 * Baut einen Text mit eingebetteten Knoten (Links, <code>) aus einer
 * Übersetzung mit {{slot}}-Platzhaltern — ohne innerHTML, nur Text-/Elementknoten.
 * `slots` bildet Platzhaltername → vorbereiteten DOM-Knoten ab.
 */
export function applyRich(el, key, slots = {}) {
  const str = t(key);
  const frag = document.createDocumentFragment();
  const re = /\{\{(\w+)\}\}/g;
  let last = 0;
  let m;
  while ((m = re.exec(str)) !== null) {
    if (m.index > last) frag.appendChild(document.createTextNode(str.slice(last, m.index)));
    const slot = slots[m[1]];
    if (slot) frag.appendChild(slot);
    last = re.lastIndex;
  }
  if (last < str.length) frag.appendChild(document.createTextNode(str.slice(last)));
  el.replaceChildren(frag);
}
