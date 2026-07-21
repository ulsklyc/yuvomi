/**
 * Modul: Telefon-Anzeige-/Hilfsschicht (Frontend)
 * Zweck: Formatierung, tel:-Links und Plausibilität für Telefonnummern über die
 *        self-gehostete, gepinnte Vendor-Kopie von libphonenumber-js/core
 *        (public/vendor/libphonenumber/). REIN ANZEIGE-/HILFSSCHICHT.
 *
 * WICHTIG - kein Datenverlust: Diese Schicht transformiert NIE gespeicherte
 * Werte. Der Aufrufer speichert immer den rohen User-Input; hier entstehen nur
 * abgeleitete, flüchtige Darstellungen. Ist eine Nummer nicht parsebar (leer,
 * ungültig, exotisch), fällt jede Funktion 1:1 auf den Rohwert zurück.
 *
 * Die Vendor-Lib wird lazy (dynamic import + fetch der Metadaten) und nur bei
 * erster Nutzung geladen, memoisiert. Schlägt das Laden fehl (z. B. offline vor
 * dem ersten Besuch), degradieren alle Funktionen zum Rohwert - nie ein Fehler.
 */

// Pfade der Vendor-Assets (self-hosted, kein CDN). Absolute Origin-Pfade wie bei
// PDF.js, damit sie unabhängig vom aufrufenden Modul auflösen.
const CORE_URL     = '/vendor/libphonenumber/core.min.mjs';
const METADATA_URL = '/vendor/libphonenumber/metadata.min.json';

// Memoisierte Lib-Instanz: { parse, AsYouType, isPossible, metadata } oder null.
let _lib = null;
// Laufendes Lade-Promise (verhindert parallele Doppel-Ladung).
let _loading = null;

/**
 * Lädt Vendor-Bundle + Metadaten einmalig und memoisiert das Ergebnis.
 * @returns {Promise<Object|null>} Lib-Objekt oder null bei Ladefehler.
 */
export async function loadPhoneLib() {
  if (_lib) return _lib;
  if (!_loading) {
    _loading = (async () => {
      try {
        const [mod, metaRes] = await Promise.all([
          import(CORE_URL),
          fetch(METADATA_URL),
        ]);
        const metadata = await metaRes.json();
        _lib = {
          parse:      mod.parsePhoneNumberFromString,
          AsYouType:  mod.AsYouType,
          isPossible: mod.isPossiblePhoneNumber,
          metadata,
        };
        return _lib;
      } catch {
        // Bewusst still: Anzeige degradiert zum Rohwert, kein User-sichtbarer Fehler.
        _loading = null; // späterer Retry möglich (z. B. sobald online)
        return null;
      }
    })();
  }
  return _loading;
}

/**
 * Test-Hook: primt die Lib synchron (net-frei). Nur für Unit-Tests gedacht -
 * im Browser übernimmt loadPhoneLib() das Lazy-Loading.
 * @param {{parse:Function, AsYouType:Function, isPossible:Function, metadata:Object}} lib
 */
export function __primePhoneLib(lib) {
  _lib = lib || null;
  _loading = null;
}

/** Interner Parse-Versuch. Gibt das PhoneNumber-Objekt oder null zurück. */
function tryParse(lib, value, defaultCountry) {
  if (!lib || !value || typeof value !== 'string') return null;
  try {
    const parsed = lib.parse(value, defaultCountry || undefined, lib.metadata);
    return parsed || null;
  } catch {
    return null;
  }
}

/**
 * Baut einen SYNCHRONEN Formatter über eine bereits geladene Lib. So kann ein
 * Aufrufer die Lib EINMAL laden (getPhoneFormatter) und danach viele Nummern ohne
 * weitere await-Runden formatieren (z. B. eine ganze Liste). Alle Methoden fallen
 * bei nicht-parsbaren Werten 1:1 auf den Rohwert zurück - kein Datenverlust.
 */
function makeFormatter(lib) {
  return {
    /** national bei gleichem Land, sonst international; sonst Rohwert. */
    display(value, defaultCountry) {
      const raw = String(value ?? '');
      if (!raw.trim()) return raw;
      const parsed = tryParse(lib, raw, defaultCountry);
      if (!parsed) return raw;
      try {
        return (defaultCountry && parsed.country === defaultCountry)
          ? parsed.formatNational()
          : parsed.formatInternational();
      } catch {
        return raw;
      }
    },
    /** tel:-Href, bevorzugt E.164; sonst wählbare Zeichen; sonst Rohwert. */
    tel(value, defaultCountry) {
      const raw = String(value ?? '');
      const parsed = tryParse(lib, raw, defaultCountry);
      if (parsed && parsed.number) return `tel:${parsed.number}`; // .number = E.164
      const dialable = raw.replace(/[^\d+*#]/g, '');
      return `tel:${dialable || raw}`;
    },
    /** unverbindliche Plausibilität; leer → true (kein Warnhinweis). */
    plausible(value, defaultCountry) {
      const raw = String(value ?? '');
      if (!raw.trim()) return true;
      try {
        return lib.isPossible(raw, defaultCountry || undefined, lib.metadata);
      } catch {
        return true;
      }
    },
  };
}

/**
 * Lädt die Lib EINMAL und liefert einen synchronen Formatter (display/tel/
 * plausible). null, wenn die Lib nicht ladbar ist (offline) - der Aufrufer lässt
 * dann Rohwerte stehen. Für Batch-Formatierung (Liste) statt N einzelner awaits.
 * @returns {Promise<{display:Function, tel:Function, plausible:Function}|null>}
 */
export async function getPhoneFormatter() {
  const lib = await loadPhoneLib();
  return lib ? makeFormatter(lib) : null;
}

/**
 * Formatiert eine Nummer zur Anzeige: national bei gleichem Land, sonst
 * international. Nicht-parsbare Werte bleiben UNVERÄNDERT.
 * @param {string} value - roher Wert (Source of Truth, bleibt unberührt)
 * @param {string} [defaultCountry] - ISO-3166-Alpha-2 (z. B. 'DE')
 * @returns {Promise<string>}
 */
export async function formatPhoneDisplay(value, defaultCountry) {
  const fmt = await getPhoneFormatter();
  return fmt ? fmt.display(value, defaultCountry) : String(value ?? '');
}

/**
 * Liefert einen tel:-Href. Bevorzugt E.164 (nur zur Laufzeit abgeleitet, NICHT
 * gespeichert); fällt sonst auf wählbare Zeichen / den Rohwert zurück.
 * @param {string} value - roher Wert
 * @param {string} [defaultCountry] - ISO-3166-Alpha-2
 * @returns {Promise<string>}
 */
export async function toTelHref(value, defaultCountry) {
  const fmt = await getPhoneFormatter();
  if (fmt) return fmt.tel(value, defaultCountry);
  const raw = String(value ?? '');
  const dialable = raw.replace(/[^\d+*#]/g, '');
  return `tel:${dialable || raw}`;
}

/**
 * Unverbindliche Plausibilitätsprüfung (nie blockierend). Leer → true (kein
 * Warnhinweis), nicht ladbare Lib → true (nie fälschlich warnen).
 * @param {string} value - roher Wert
 * @param {string} [defaultCountry] - ISO-3166-Alpha-2
 * @returns {Promise<boolean>}
 */
export async function isPlausiblePhone(value, defaultCountry) {
  const fmt = await getPhoneFormatter();
  return fmt ? fmt.plausible(value, defaultCountry) : true;
}

/**
 * Liefert eine AsYouType-Formatter-Instanz (visuelle Tipphilfe). Gibt null zurück,
 * wenn die Lib (noch) nicht geladen ist - der Aufrufer nutzt dann keine Hilfe.
 * @param {string} [defaultCountry] - ISO-3166-Alpha-2
 * @returns {Promise<Object|null>} Instanz mit .input(text) / .reset()
 */
export async function createAsYouType(defaultCountry) {
  const lib = await loadPhoneLib();
  if (!lib) return null;
  try {
    return new lib.AsYouType(defaultCountry || undefined, lib.metadata);
  } catch {
    return null;
  }
}

/**
 * Leitet das ISO-3166-Alpha-2-Land aus einem BCP-47-Region-Tag ab
 * (z. B. 'de-DE' → 'DE'). Leerer/ungültiger Eingang → null.
 * @param {string} region
 * @returns {string|null}
 */
export function countryFromRegion(region) {
  if (!region || typeof region !== 'string') return null;
  const parts = region.split('-');
  const cc = parts[parts.length - 1];
  return /^[A-Za-z]{2}$/.test(cc) ? cc.toUpperCase() : null;
}
