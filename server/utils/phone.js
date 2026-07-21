/**
 * Modul: Telefon-Normalisierung (Server)
 * Zweck: EINE gekapselte E.164-Berechnung für Phase 2 (value_e164), genutzt von
 *        Migration, CardDAV-Sync und den contacts-Routen. Server darf npm nutzen.
 *
 * WICHTIG - additiv & nicht-destruktiv: value_e164 ist eine reine Zusatzspalte
 * fürs format-unabhängige CardDAV-Matching. Der Rohwert (contact_phones.value)
 * bleibt IMMER die Wahrheit und wird hier nie berührt. Nicht parsebare Nummern
 * liefern null → value_e164 bleibt NULL und das Matching fällt auf den exakten
 * Rohwert-Vergleich zurück.
 */

import { parsePhoneNumberFromString } from 'libphonenumber-js';

/**
 * Berechnet die E.164-Form einer Telefonnummer, sofern plausibel parsebar.
 * @param {string} value - roher Telefon-String (unverändert, nur gelesen)
 * @param {string} [defaultCountry] - ISO-3166-Alpha-2 (z. B. 'DE') für Nummern
 *        ohne internationale Vorwahl. Fehlt es, werden nur +-Vorwahl-Nummern erkannt.
 * @returns {string|null} E.164 (z. B. '+493012345678') oder null wenn nicht parsebar
 */
export function toE164(value, defaultCountry) {
  if (!value || typeof value !== 'string' || !value.trim()) return null;
  try {
    const parsed = parsePhoneNumberFromString(value, defaultCountry || undefined);
    // Nur „mögliche" Nummern übernehmen → keine Zufalls-E.164 aus Kurzstrings.
    if (parsed && parsed.isPossible()) return parsed.number; // .number = E.164
  } catch {
    /* still: nicht parsebar → null, Rohwert-Vergleich bleibt Fallback */
  }
  return null;
}

/**
 * Leitet das Default-Land (ISO-3166-Alpha-2) aus der haushaltweiten Konfiguration
 * ab: bevorzugt die gespeicherte Region (BCP-47, z. B. 'de-DE' → 'DE'), sonst das
 * Feiertags-Land (bereits ISO). Fehlt beides → null (nur +-Nummern werden erkannt).
 * @param {{prepare: Function}} dbConn - better-sqlite3-Verbindung (Runtime oder Migration)
 * @returns {string|null}
 */
export function defaultCountryFromConfig(dbConn) {
  try {
    const read = (key) => dbConn.prepare('SELECT value FROM sync_config WHERE key = ?').get(key)?.value;
    const region = read('region');
    const fromRegion = countryFromRegion(region);
    if (fromRegion) return fromRegion;
    const holiday = read('holiday_country');
    return /^[A-Za-z]{2}$/.test(holiday || '') ? String(holiday).toUpperCase() : null;
  } catch {
    return null;
  }
}

/**
 * BCP-47-Region-Tag → ISO-3166-Alpha-2 ('de-DE' → 'DE'). Ungültig → null.
 * @param {string} region
 * @returns {string|null}
 */
export function countryFromRegion(region) {
  if (!region || typeof region !== 'string') return null;
  const parts = region.split('-');
  const cc = parts[parts.length - 1];
  return /^[A-Za-z]{2}$/.test(cc) ? cc.toUpperCase() : null;
}
