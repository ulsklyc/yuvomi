// Region/Format-Presets: reine UI-Komfortschicht über die haushaltweiten
// Felder currency / date_format / time_format. Es wird KEIN eigenes
// `region`-Feld gespeichert — die aktive Region wird beim Laden per
// detectRegion() aus den drei vorhandenen Werten abgeleitet.
//
// Jeder Wert muss in den serverseitigen Listen enthalten sein:
//   currency    ∈ CURRENCY_CODES        (public/utils/currency-codes.js)
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
  'en-NZ': { currency: 'NZD', date_format: 'dmy_slash', time_format: '12h' },
  'en-PH': { currency: 'PHP', date_format: 'mdy', time_format: '12h' },
  // #1697: Singapur, CLDR-Default von en-SG (06/10/2026, 3:05 pm).
  'en-SG': { currency: 'SGD', date_format: 'dmy_slash', time_format: '12h' },
  'fil-PH': { currency: 'PHP', date_format: 'mdy', time_format: '12h' },
  'es-ES': { currency: 'EUR', date_format: 'dmy_slash', time_format: '24h' },
  'es-CL': { currency: 'CLP', date_format: 'dmy_slash', time_format: '24h' },
  // Amerika: alle souveränen Staaten Nord-, Mittel- und Südamerikas samt Karibik.
  // Datums- und Zeitformat stammen aus den CLDR-Defaults der jeweiligen Locale,
  // nicht aus Schätzung - deshalb steht Panama auf mdy und Argentinien auf 12h.
  // Abhängige Gebiete (Aruba/AWG, Curaçao/ANG, Kaiman/KYD, Bermuda/BMD) sind
  // bewusst nicht enthalten; wer dort lebt, wählt Region "Benutzerdefiniert".
  'es-MX': { currency: 'MXN', date_format: 'dmy_slash', time_format: '12h' },
  'es-AR': { currency: 'ARS', date_format: 'dmy_slash', time_format: '12h' },
  'es-BO': { currency: 'BOB', date_format: 'dmy_slash', time_format: '12h' },
  'es-CO': { currency: 'COP', date_format: 'dmy_slash', time_format: '12h' },
  'es-CR': { currency: 'CRC', date_format: 'dmy_slash', time_format: '12h' },
  'es-CU': { currency: 'CUP', date_format: 'dmy_slash', time_format: '12h' },
  'es-DO': { currency: 'DOP', date_format: 'dmy_slash', time_format: '12h' },
  'es-EC': { currency: 'USD', date_format: 'dmy_slash', time_format: '12h' },
  'es-GT': { currency: 'GTQ', date_format: 'dmy_slash', time_format: '12h' },
  'es-HN': { currency: 'HNL', date_format: 'dmy_slash', time_format: '12h' },
  'es-NI': { currency: 'NIO', date_format: 'dmy_slash', time_format: '12h' },
  'es-PA': { currency: 'PAB', date_format: 'mdy', time_format: '12h' },
  'es-PE': { currency: 'PEN', date_format: 'dmy_slash', time_format: '12h' },
  'es-PY': { currency: 'PYG', date_format: 'dmy_slash', time_format: '12h' },
  'es-SV': { currency: 'USD', date_format: 'dmy_slash', time_format: '12h' },
  'es-UY': { currency: 'UYU', date_format: 'dmy_slash', time_format: '12h' },
  'es-VE': { currency: 'VES', date_format: 'dmy_slash', time_format: '12h' },
  'fr-CA': { currency: 'CAD', date_format: 'ymd', time_format: '24h' },
  'fr-HT': { currency: 'HTG', date_format: 'dmy_slash', time_format: '24h' },
  'nl-SR': { currency: 'SRD', date_format: 'dmy_slash', time_format: '24h' },
  'en-BZ': { currency: 'BZD', date_format: 'dmy_slash', time_format: '24h' },
  'en-JM': { currency: 'JMD', date_format: 'dmy_slash', time_format: '12h' },
  'en-TT': { currency: 'TTD', date_format: 'dmy_slash', time_format: '12h' },
  'en-BS': { currency: 'BSD', date_format: 'dmy_slash', time_format: '12h' },
  'en-BB': { currency: 'BBD', date_format: 'dmy_slash', time_format: '12h' },
  'en-GY': { currency: 'GYD', date_format: 'dmy_slash', time_format: '12h' },
  // Ostkaribischer Währungsraum: sechs Staaten, ein identisches Triple (XCD).
  // detectRegion() liefert für sie denselben Repräsentanten - das gespeicherte
  // `region`-Feld hält den Dropdown trotzdem auf der gewählten Insel (#486).
  'en-AG': { currency: 'XCD', date_format: 'dmy_slash', time_format: '12h' },
  'en-DM': { currency: 'XCD', date_format: 'dmy_slash', time_format: '12h' },
  'en-GD': { currency: 'XCD', date_format: 'dmy_slash', time_format: '12h' },
  'en-KN': { currency: 'XCD', date_format: 'dmy_slash', time_format: '12h' },
  'en-LC': { currency: 'XCD', date_format: 'dmy_slash', time_format: '12h' },
  'en-VC': { currency: 'XCD', date_format: 'dmy_slash', time_format: '12h' },
  'fr-FR': { currency: 'EUR', date_format: 'dmy_slash', time_format: '24h' },
  'it-IT': { currency: 'EUR', date_format: 'dmy_slash', time_format: '24h' },
  'sv-SE': { currency: 'SEK', date_format: 'ymd', time_format: '24h' },
  'nb-NO': { currency: 'NOK', date_format: 'dmy', time_format: '24h' },
  'pl-PL': { currency: 'PLN', date_format: 'dmy', time_format: '24h' },
  'cs-CZ': { currency: 'CZK', date_format: 'dmy', time_format: '24h' },
  'uk-UA': { currency: 'UAH', date_format: 'dmy', time_format: '24h' },
  'ru-RU': { currency: 'RUB', date_format: 'dmy', time_format: '24h' },
  'be-BY': { currency: 'BYN', date_format: 'dmy', time_format: '24h' },
  'tr-TR': { currency: 'TRY', date_format: 'dmy', time_format: '24h' },
  'zh-CN': { currency: 'CNY', date_format: 'ymd', time_format: '24h' },
  'ja-JP': { currency: 'JPY', date_format: 'ymd', time_format: '24h' },
  'hi-IN': { currency: 'INR', date_format: 'dmy_slash', time_format: '12h' },
  'pt-PT': { currency: 'EUR', date_format: 'dmy_slash', time_format: '24h' },
  'pt-BR': { currency: 'BRL', date_format: 'dmy_slash', time_format: '24h' },
  'nl-NL': { currency: 'EUR', date_format: 'dmy', time_format: '24h' },
  'ar-AE': { currency: 'AED', date_format: 'dmy_slash', time_format: '12h' },
  'ar-SA': { currency: 'SAR', date_format: 'dmy_slash', time_format: '12h' },
  'ko-KR': { currency: 'KRW', date_format: 'ymd', time_format: '12h' },
  'id-ID': { currency: 'IDR', date_format: 'dmy', time_format: '24h' },
  'ms-MY': { currency: 'MYR', date_format: 'dmy_slash', time_format: '12h' },
  // #841: Israel schreibt d.M.yyyy und rechnet in 24h (CLDR he-IL) - dasselbe
  // Triple wie de-DE bis auf die Waehrung. Das Zeichen ₪ liefert
  // Intl.NumberFormat, es steht in keiner eigenen Tabelle.
  'he-IL': { currency: 'ILS', date_format: 'dmy', time_format: '24h' },
  'fa-IR': { currency: 'IRR', date_format: 'ymd', time_format: '24h' },
  // #297: drei ausgelieferte Sprachen hatten keine einzige Region - wer die App
  // auf Griechisch, Ungarisch oder Vietnamesisch stellte, landete zwangslaeufig
  // auf "Benutzerdefiniert" und musste Waehrung, Datum und Zeit einzeln raten.
  // Alle drei Tripel stammen aus dem CLDR-Default der Locale, nicht aus
  // Schaetzung - zweimal ueberrascht das:
  //   el-GR laeuft auf 12h (2:30 μ.μ.), obwohl ganz Europa ringsum 24h schreibt,
  //   hu-HU schreibt das Jahr zuerst (2026. 11. 05.) und ist die erste Region
  //   ueberhaupt auf `ymd_dot`.
  'el-GR': { currency: 'EUR', date_format: 'dmy_slash', time_format: '12h' },
  'hu-HU': { currency: 'HUF', date_format: 'ymd_dot', time_format: '24h' },
  'vi-VN': { currency: 'VND', date_format: 'dmy_slash', time_format: '24h' },
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

// Bevorzugt eine explizit gespeicherte Region, solange deren Preset noch exakt
// zu den gespeicherten Formatwerten passt. Nötig, weil sich mehrere Regionen
// dasselbe Triple teilen (z. B. fr-FR und es-ES = EUR/dmy_slash/24h): ohne
// gespeichertes `region`-Feld liefert detectRegion() immer den ersten Treffer
// und der Dropdown springt nach dem Speichern auf die falsche Region (#486).
// Fällt auf detectRegion() zurück, wenn keine gültige Region gespeichert ist
// oder ihr Preset nicht mehr zu den aktuellen Werten passt (z. B. nach manueller
// Formatänderung).
export function resolveRegion({ region, currency, date_format, time_format } = {}) {
  const preset = region ? REGION_PRESETS[region] : undefined;
  if (
    preset
    && preset.currency === currency
    && preset.date_format === date_format
    && preset.time_format === time_format
  ) {
    return region;
  }
  return detectRegion({ currency, date_format, time_format });
}

// Liefert den BCP-47-Locale-Tag für die Zahlen-/Währungsformatierung
// (z. B. "de-CH" → Tausender-Apostroph + Punkt-Dezimaltrenner: 123'456.78).
// Leerer String, wenn keine passende Region vorliegt (dann formatiert die App
// über die UI-Sprache). Die Region-Codes sind selbst gültige BCP-47-Tags, daher
// eignen sie sich direkt als Intl-Locale.
export function numberLocaleFor(prefs = {}) {
  const region = resolveRegion(prefs);
  return REGION_CODES.includes(region) ? region : '';
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
