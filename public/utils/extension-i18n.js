/**
 * Modul: Extension-i18n-Helfer
 * Zweck: Third-Party-Module liefern locales/{locale}.json fuer jede vom Kern
 *        unterstuetzte Sprache (oder eine Teilmenge plus defaultLocale). Der
 *        Router laedt alle vorhandenen Dateien; t() faellt zur Laufzeit ueber
 *        UI-Locale -> module.defaultLocale -> en -> de, danach statische
 *        label/title-Fallbacks aus module.json.
 */

import {
  getLocale,
  setExtensionLocaleBundles,
  clearExtensionLocaleBundles,
  clearExtensionTranslations,
  nestFlatLocaleDict,
  t,
} from '../i18n.js';

export {
  clearExtensionTranslations,
  clearExtensionLocaleBundles,
  setExtensionLocaleBundles,
};

const LABEL_KEY_RE = /^[a-z][a-z0-9._-]{0,79}$/;

export function isValidExtensionLabelKey(key) {
  return typeof key === 'string' && LABEL_KEY_RE.test(key.trim());
}

/** Voller i18n-Schluessel fuer ein Modul (Kurz- oder Langform). */
export function extensionTranslationKey(moduleId, key) {
  const k = String(key || '').trim();
  if (!k) return '';
  if (k.startsWith('extensions.')) return k;
  return `extensions.${moduleId}.${k}`;
}

/** labelKey -> t(), sonst statisches label, sonst fallback. */
export function resolveExtensionLabel(moduleId, { labelKey, label, fallback = '' } = {}) {
  if (labelKey && isValidExtensionLabelKey(labelKey)) {
    const fullKey = extensionTranslationKey(moduleId, labelKey);
    const translated = t(fullKey);
    if (translated !== fullKey) return translated;
  }
  return label || fallback;
}

export function moduleDisplayLabel(module) {
  if (!module) return '';
  return resolveExtensionLabel(module.id, {
    labelKey: module.menu?.labelKey || module.capabilities?.permissionModule?.labelKey,
    label: module.menu?.label || module.name,
    fallback: module.id,
  });
}

export function widgetDisplayLabel(meta) {
  if (!meta) return '';
  const moduleId = meta.moduleId || String(meta.id || '').split(':')[0];
  return resolveExtensionLabel(moduleId, {
    labelKey: meta.labelKey,
    label: meta.label,
    fallback: meta.id || '',
  });
}

export function optionFieldLabel(moduleId, field, key) {
  if (!field) return key;
  if (field.titleKey && isValidExtensionLabelKey(field.titleKey)) {
    return resolveExtensionLabel(moduleId, {
      labelKey: field.titleKey,
      label: field.title,
      fallback: key,
    });
  }
  return field.title || key;
}

async function fetchModuleLocale(moduleId, locale) {
  const url = `/api/v1/modules/assets/${encodeURIComponent(moduleId)}/locales/${encodeURIComponent(locale)}.json`;
  const resp = await fetch(url, { cache: 'no-store' });
  if (!resp.ok) return null;
  const data = await resp.json();
  return data && typeof data === 'object' && !Array.isArray(data) ? data : null;
}

function moduleI18nMeta(module) {
  if (typeof module === 'string') {
    return { id: module, defaultLocale: 'en', availableLocales: [] };
  }
  const i18n = module?.i18n && typeof module.i18n === 'object' ? module.i18n : {};
  return {
    id: module.id,
    defaultLocale: i18n.defaultLocale || 'en',
    availableLocales: Array.isArray(i18n.availableLocales) ? i18n.availableLocales : [],
  };
}

/**
 * Laedt alle vom Server gemeldeten locale-Dateien eines Moduls.
 * @returns {Promise<{ loaded: boolean, complete: boolean }>} `loaded`: es gibt
 *   Uebersetzungen; `complete`: jede gemeldete Datei kam an
 */
async function loadModuleLocales(module) {
  const { id: moduleId, defaultLocale, availableLocales } = moduleI18nMeta(module);
  if (!availableLocales.length) {
    clearExtensionLocaleBundles(moduleId);
    return { loaded: false, complete: true };
  }

  const trees = {};
  await Promise.all(availableLocales.map(async (loc) => {
    try {
      const dict = await fetchModuleLocale(moduleId, loc);
      if (dict) trees[loc] = nestFlatLocaleDict(dict);
    } catch {
      // Einzelne Locale darf fehlen; die Fallback-Kette traegt den Rest.
    }
  }));
  const complete = Object.keys(trees).length === availableLocales.length;

  if (!Object.keys(trees).length) {
    clearExtensionLocaleBundles(moduleId);
    return { loaded: false, complete };
  }

  setExtensionLocaleBundles(moduleId, { defaultLocale, trees });
  return { loaded: true, complete };
}

/** Laedt alle vom Server gemeldeten locale-Dateien des Moduls. */
export async function loadExtensionLocales(module) {
  return (await loadModuleLocales(module)).loaded;
}

// Fingerabdruck des zuletzt geladenen Modulsatzes. Der Router ruft diese
// Funktion nach JEDER /modules-Abfrage (alle 30 s); ohne den Vergleich holte
// jeder Takt alle Sprachdateien aller Module mit no-store neu.
let _loadedLocaleSignature = null;

function localeSignature(enabled) {
  return JSON.stringify(enabled.map((m) => {
    const meta = moduleI18nMeta(m);
    return [meta.id, String(m.version ?? ''), meta.defaultLocale, meta.availableLocales];
  }));
}

/**
 * Laedt die Sprachdateien aller aktiven Module - aber nur, wenn sich Satz,
 * Version oder Sprachliste geaendert haben. `force` laedt trotzdem (nach
 * Installation oder Update in den Einstellungen).
 * @returns {Promise<boolean>} true, wenn neu geladen wurde
 */
export async function reloadExtensionLocales(modules, { force = false } = {}) {
  const enabled = (Array.isArray(modules) ? modules : [])
    .filter((m) => m?.enabled && m.status === 'enabled');
  const signature = localeSignature(enabled);
  if (!force && signature === _loadedLocaleSignature) return false;
  clearExtensionTranslations();
  const results = await Promise.all(enabled.map((m) => loadModuleLocales(m)));
  // Nur ein VOLLSTAENDIG geladener Satz gilt als erledigt. Scheiterte eine
  // Datei (Netz weg, Server neu gestartet), versucht es der naechste Takt
  // wieder - sonst fehlte die Uebersetzung bis zum Neuladen des Tabs
  // (Codex-Review zu #2055).
  _loadedLocaleSignature = results.every((r) => r.complete) ? signature : null;
  return true;
}

let _localeHookInstalled = false;

/** locale-changed: Overlay neu aufloesen (Bundles bleiben im Speicher). */
export function initExtensionI18n(reloadFn) {
  if (_localeHookInstalled || typeof window === 'undefined') return;
  _localeHookInstalled = true;
  window.addEventListener('locale-changed', () => {
    // Bundles sind pro Locale gecacht — kein Refetch noetig, t() waehlt neu.
    if (typeof reloadFn === 'function') {
      Promise.resolve(reloadFn()).catch(() => {});
    }
  });
}

export { getLocale };
