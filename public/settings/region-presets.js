// Region/Format-Presets: reine UI-Komfortschicht über die haushaltweiten
// Felder currency / date_format / time_format. Es wird KEIN eigenes
// `region`-Feld gespeichert — die aktive Region wird beim Laden per
// detectRegion() aus den drei vorhandenen Werten abgeleitet.
//
// Jeder Wert muss in den serverseitigen Listen enthalten sein:
//   currency    ∈ VALID_CURRENCIES      (server/routes/preferences.js)
//   date_format ∈ DATE_FORMATS          (public/settings/pages/personal-appearance.js)
//   time_format ∈ { '24h', '12h' }
// (per test/test-region-presets.js abgesichert).

export const CUSTOM_REGION = 'custom';

export const REGION_PRESETS = {
  'de-DE': { currency: 'EUR', date_format: 'dmy', time_format: '24h' },
  'de-AT': { currency: 'EUR', date_format: 'dmy', time_format: '24h' },
  'de-CH': { currency: 'CHF', date_format: 'dmy', time_format: '24h' },
  'en-US': { currency: 'USD', date_format: 'mdy', time_format: '12h' },
  'en-GB': { currency: 'GBP', date_format: 'dmy_slash', time_format: '24h' },
  'en-CA': { currency: 'CAD', date_format: 'ymd', time_format: '12h' },
  'en-AU': { currency: 'AUD', date_format: 'dmy_slash', time_format: '12h' },
  'es-ES': { currency: 'EUR', date_format: 'dmy_slash', time_format: '24h' },
  'fr-FR': { currency: 'EUR', date_format: 'dmy_slash', time_format: '24h' },
  'it-IT': { currency: 'EUR', date_format: 'dmy_slash', time_format: '24h' },
  'sv-SE': { currency: 'SEK', date_format: 'ymd', time_format: '24h' },
  'pl-PL': { currency: 'PLN', date_format: 'dmy', time_format: '24h' },
  'cs-CZ': { currency: 'CZK', date_format: 'dmy', time_format: '24h' },
  'uk-UA': { currency: 'UAH', date_format: 'dmy', time_format: '24h' },
  'ru-RU': { currency: 'RUB', date_format: 'dmy', time_format: '24h' },
  'tr-TR': { currency: 'TRY', date_format: 'dmy', time_format: '24h' },
  'zh-CN': { currency: 'CNY', date_format: 'ymd', time_format: '24h' },
  'ja-JP': { currency: 'JPY', date_format: 'ymd', time_format: '24h' },
  'hi-IN': { currency: 'INR', date_format: 'dmy_slash', time_format: '12h' },
  'pt-PT': { currency: 'EUR', date_format: 'dmy_slash', time_format: '24h' },
  'pt-BR': { currency: 'BRL', date_format: 'dmy_slash', time_format: '24h' },
  'nl-NL': { currency: 'EUR', date_format: 'dmy', time_format: '24h' },
  'ar-AE': { currency: 'AED', date_format: 'dmy_slash', time_format: '12h' },
  'ar-SA': { currency: 'SAR', date_format: 'dmy_slash', time_format: '12h' },
};

export const REGION_CODES = Object.keys(REGION_PRESETS);

// Liefert den ersten Regions-Code, dessen Preset exakt den drei Werten
// entspricht, sonst CUSTOM_REGION. Mehrere Regionen teilen dasselbe Triple
// (z. B. de-DE und de-AT) — da kein `region`-Feld gespeichert wird, kann nur
// ein Repräsentant zurückgegeben werden. Für die Formate ist das ohne Belang.
export function detectRegion({ currency, date_format, time_format } = {}) {
  for (const [code, preset] of Object.entries(REGION_PRESETS)) {
    if (
      preset.currency === currency
      && preset.date_format === date_format
      && preset.time_format === time_format
    ) {
      return code;
    }
  }
  return CUSTOM_REGION;
}

// Lokalisierter Anzeigename eines Regions-Codes (z. B. "de-DE" → "Deutsch (Deutschland)").
// Fällt auf den Code zurück, wenn Intl.DisplayNames nicht verfügbar ist.
export function regionLabel(code, locale) {
  try {
    const names = new Intl.DisplayNames([locale], { type: 'language' });
    return names.of(code) || code;
  } catch {
    return code;
  }
}
