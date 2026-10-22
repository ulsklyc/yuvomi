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
  // Taiwan schreibt 2026/11/05 und rechnet in 12h (上午/下午) - beides CLDR
  // zh-Hant-TW. Mit Schrift-Subtag, damit regionLocale() auf zh-Hant faellt.
  'zh-Hant-TW': { currency: 'TWD', date_format: 'ymd_slash', time_format: '12h' },
  // Hongkong und Macau schreiben 5/11/2026 und rechnen in 12h - CLDR zh-Hant-HK
  // und zh-Hant-MO. Ohne diese beiden bekaeme ein Haushalt dort die Sprache,
  // aber nicht seine Waehrung (dieselbe Luecke wie VND vor #297).
  'zh-Hant-HK': { currency: 'HKD', date_format: 'dmy_slash', time_format: '12h' },
  'zh-Hant-MO': { currency: 'MOP', date_format: 'dmy_slash', time_format: '12h' },
  'ja-JP': { currency: 'JPY', date_format: 'ymd', time_format: '24h' },
  'hi-IN': { currency: 'INR', date_format: 'dmy_slash', time_format: '12h' },
  'pt-PT': { currency: 'EUR', date_format: 'dmy_slash', time_format: '24h' },
  'pt-BR': { currency: 'BRL', date_format: 'dmy_slash', time_format: '24h' },
  'nl-NL': { currency: 'EUR', date_format: 'dmy_dash', time_format: '24h' },
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

// Früherer Triple einer Region, dessen Preset sich geändert hat. Haushalte
// speichern `region` samt Triple; ohne diese Zuordnung fiele ein bereits
// gespeicherter Haushalt nach der Preset-Änderung auf detectRegion() zurück
// (nl-NL → de-DE: andere Zahlen-Locale, falsche Region im Dropdown). #1847:
// nl-NL wechselte von dmy auf dmy_dash. Der Eintrag muss bleiben, solange
// gespeicherte Haushalte den alten Triple tragen können.
const LEGACY_REGION_TRIPLES = {
  'nl-NL': { currency: 'EUR', date_format: 'dmy', time_format: '24h' },
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
  const values = { currency, date_format, time_format };
  const matches = (triple) => Boolean(triple)
    && triple.currency === values.currency
    && triple.date_format === values.date_format
    && triple.time_format === values.time_format;
  if (region && (matches(REGION_PRESETS[region]) || matches(LEGACY_REGION_TRIPLES[region]))) {
    return region;
  }
  return detectRegion(values);
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

// Laender, deren Voreinstellung die Sprache im Namen behaelt, obwohl es nur
// EINE gibt: dort haengt das Format an der Sprache, nicht am Land (de-CH
// schreibt 1'234.50, fr-CH 1 234,50). "Schweiz" allein verspraeche jedem dort
// das deutschschweizer Format. Laender mit mehreren Voreinstellungen (Kanada,
// Philippinen) brauchen keinen Eintrag - sie zaehlt `regionKeepsLanguage()`.
const LANGUAGE_BOUND_COUNTRIES = ['CH'];

function countryOf(code) {
  return code.slice(code.lastIndexOf('-') + 1);
}

/**
 * Traegt der Name dieser Region ihre Sprache? Ja, wenn das Land mehr als eine
 * Voreinstellung hat (sonst waeren "Kanada" und "Kanada" nicht unterscheidbar)
 * oder seine Sprache das Format bestimmt (LANGUAGE_BOUND_COUNTRIES).
 */
export function regionKeepsLanguage(code) {
  const country = countryOf(code);
  return LANGUAGE_BOUND_COUNTRIES.includes(country)
    || REGION_CODES.filter((other) => countryOf(other) === country).length > 1;
}

/**
 * Lokalisierter Anzeigename eines Regions-Codes: das LAND ("de-DE" →
 * "Deutschland"), bei mehrsprachigen Regionen mit Sprache ("de-CH" →
 * "Schweiz (Deutsch)").
 *
 * KURZ, WEIL DER WERT IN DER ZEILE STEHT (R21, Critique 2026-10-21): mobil hat
 * die geschlossene Auswahl rund 180 px, und "Deutsch (Deutschland)" endete dort
 * als "Deutsch (Deutsch…". Wer seine Region sucht, sucht sein Land - die
 * Sprache sagt nur dort etwas, wo das Land allein es nicht tut.
 *
 * `withLanguage(region, language)` setzt die Langform, damit sie der Seite
 * folgt (t('settings.regionWithLanguage')); ohne sie gilt "Land (Sprache)".
 * Fällt auf den Code zurück, wenn Intl.DisplayNames nicht verfügbar ist.
 */
export function regionLabel(code, locale, withLanguage = (region, language) => `${region} (${language})`) {
  try {
    const region = new Intl.DisplayNames([locale], { type: 'region' }).of(countryOf(code)) || code;
    if (!regionKeepsLanguage(code)) return region;
    const language = new Intl.DisplayNames([locale], { type: 'language' }).of(code.slice(0, code.indexOf('-')));
    return language ? withLanguage(region, language) : region;
  } catch {
    return code;
  }
}

/**
 * Laender, deren CLDR-Name in mindestens einer Sprache nicht in die
 * geschlossene Auswahl passt (#2151). Ihre Kurzform steht je Sprache unter
 * `settings.regionShort.<Land>` - in Sprachen, in denen der volle Name passt,
 * steht dort der volle Name. test:settings-navigation haelt die Liste: jeder
 * Name, der das Zeichenbudget reisst, braucht hier einen Eintrag.
 */
export const SHORT_NAME_COUNTRIES = ['AE', 'AG', 'BS', 'DO', 'GB', 'HK', 'KN', 'MO', 'PH', 'SA', 'TT', 'US', 'VC'];

/**
 * Kurzer Anzeigename einer Region - das, was in der Auswahl steht (#2151).
 * Der volle Name (`regionLabel`) steht in der Hinweiszeile, sobald er sich
 * von diesem unterscheidet.
 *
 * WARUM DER WERT SELBST KURZ IST: die geschlossene Auswahl zeigt den Text der
 * gewaehlten Option, und der ist derselbe wie in der Liste. Einen kuerzeren
 * Wert nur fuer den geschlossenen Zustand gibt es nativ erst mit
 * `appearance: base-select` (kein Firefox, Safari erst ab 27) - ohne es waere
 * der Wert dort wieder gekappt. Mobil hat die Auswahl rund 145 px Text
 * (R17: Bedienspalte 50cqi), und "Vereinigte Arabische Emirate" endete dort
 * als "Vereinigte Arabisc…".
 *
 * - Land: `countryName(Land)` (die Seite liest `settings.regionShort.*`),
 *   sonst der CLDR-Name.
 * - Mehrsprachige Regionen tragen statt der Sprache ihr Kuerzel ("Kanada
 *   (FR)") - die Form der Sprachwahl auf Seiten in Kanada und der Schweiz,
 *   und in jeder Sprache gleich kurz. Mit ausgeschriebener Sprache ("Kanada
 *   (Französisch)", "Philippinen (Englisch)") war mindestens eine dieser
 *   Regionen in 13 von 26 Sprachen gekappt.
 *
 * @param {string} code Regions-Code wie "fr-CA"
 * @param {string} locale UI-Sprache
 * @param {object} [opts]
 * @param {(country: string) => (string|null)} [opts.countryName]
 * @param {(region: string, language: string) => string} [opts.withLanguage]
 */
export function regionShortLabel(code, locale, {
  countryName = () => null,
  withLanguage = (region, language) => `${region} (${language})`,
} = {}) {
  try {
    const country = countryOf(code);
    const region = countryName(country) || new Intl.DisplayNames([locale], { type: 'region' }).of(country) || code;
    if (!regionKeepsLanguage(code)) return region;
    return withLanguage(region, code.slice(0, code.indexOf('-')).toUpperCase());
  } catch {
    return code;
  }
}

/**
 * UI-Sprachen, deren CLDR-Name in mindestens einer Sprache nicht in die
 * geschlossene Auswahl passt (#2151): "Portugiesisch (Brasilien)",
 * "Norwegisch (Bokmål)". Kurzform je Sprache unter
 * `settings.languageShort.<Tag ohne Bindestrich>` ("Portugiesisch (BR)",
 * "Norwegisch" - Bokmål ist das einzige Norwegisch der App). Die beiden
 * Chinesisch stehen hier, weil ihre vollen Namen ("Chinesisch (vereinfacht)",
 * "Chinesisch (traditionell)") in den meisten Sprachen das Budget reissen.
 */
export const SHORT_NAME_LANGUAGES = ['nb', 'pt-BR', 'zh', 'zh-Hant'];

/**
 * Unter welchem Tag eine UI-Sprache ihren NAMEN sucht, wenn der Code allein
 * zu wenig sagt (D#1320). `zh` ist Vereinfacht, heisst im CLDR aber nur
 * "Chinesisch" - neben "Chinesisch (traditionell)" las sich der unmarkierte
 * Eintrag wie der Standard fuer alle Chinesisch Lesenden. Nur der Name folgt
 * `zh-Hans`; Code, Datei und gespeicherter Wert bleiben `zh`.
 */
const LANGUAGE_LABEL_TAGS = Object.freeze({ zh: 'zh-Hans' });

/** Voller Name einer UI-Sprache in `locale` (CLDR), oder der Code. */
export function languageLabel(tag, locale) {
  try {
    const labelTag = Object.prototype.hasOwnProperty.call(LANGUAGE_LABEL_TAGS, tag) ? LANGUAGE_LABEL_TAGS[tag] : tag;
    return new Intl.DisplayNames([locale], { type: 'language' }).of(labelTag) || tag;
  } catch {
    return tag;
  }
}

/** Schluessel der Kurzform einer UI-Sprache unter `settings.languageShort`. */
export const languageShortKey = (tag) => tag.replace('-', '');

/**
 * Kurzer Name einer UI-Sprache fuer die Sprachwahlen (#2151), aus demselben
 * Grund kurz wie `regionShortLabel`. Der volle Name (CLDR) steht in der
 * Hinweiszeile der Datensprache.
 *
 * @param {string} tag Sprach-Tag wie "pt-BR"
 * @param {string} locale UI-Sprache
 * @param {(tag: string) => (string|null)} [shortName] die Seite liest
 *        `settings.languageShort.*`
 */
export function languageShortLabel(tag, locale, shortName = () => null) {
  try {
    return shortName(tag) || languageLabel(tag, locale);
  } catch {
    return tag;
  }
}
