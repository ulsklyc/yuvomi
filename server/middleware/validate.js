/**
 * Modul: Eingabe-Validierung (Validate)
 * Zweck: Wiederverwendbare Validierungs-Helfer für alle API-Routen
 * Abhängigkeiten: keine
 */

// Globale Längengrenzen
const MAX_TITLE    = 200;
const MAX_TEXT     = 5000;
const MAX_SHORT    = 100;
const MAX_RRULE    = 300;

// Regex-Muster
const DATE_RE     = /^\d{4}-\d{2}-\d{2}$/;
const TIME_RE     = /^\d{2}:\d{2}$/;
const DATETIME_RE = /^\d{4}-\d{2}-\d{2}(T\d{2}:\d{2}(:\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:?\d{2})?)?$/;
const COLOR_RE    = /^#[0-9A-Fa-f]{6}$/;
const MONTH_RE    = /^\d{4}-\d{2}$/;
const RRULE_RE    = /^(FREQ=(DAILY|WEEKLY|MONTHLY|YEARLY)(;INTERVAL=\d{1,2})?(;BYDAY=[A-Z,]{2,}(,[A-Z]{2})*)?(;UNTIL=\d{8}(T\d{6}Z)?)?)?$/;

/**
 * Bereinigt und validiert einen Pflicht-String.
 * @param {any}    val      - Eingabewert
 * @param {string} field    - Feldname (für Fehlermeldung)
 * @param {object} opts
 * @param {number} [opts.max=200]      - Maximale Länge
 * @param {boolean}[opts.required=true]- Ob das Feld Pflicht ist
 * @returns {{ value: string|null, error: string|null }}
 */
function str(val, field, { max = MAX_TITLE, required = true } = {}) {
  if (val === undefined || val === null || val === '') {
    if (required) return { value: null, error: `${field} is required.` };
    return { value: null, error: null };
  }
  const s = String(val).trim();
  if (required && !s) return { value: null, error: `${field} must not be empty.` };
  if (s.length > max)  return { value: null, error: `${field} may be at most ${max} characters long.` };
  return { value: s || null, error: null };
}

/**
 * Validiert einen Enum-Wert.
 * @param {any}      val
 * @param {string[]} allowed
 * @param {string}   field
 * @returns {{ value: string|null, error: string|null }}
 */
function oneOf(val, allowed, field) {
  if (val === undefined || val === null || val === '') return { value: null, error: null };
  if (!allowed.includes(val))
    return { value: null, error: `${field} must be one of: ${allowed.join(', ')}.` };
  return { value: val, error: null };
}

/**
 * Validiert ein Datumsformat YYYY-MM-DD.
 * @param {any}    val
 * @param {string} field
 * @param {boolean} required
 */
function date(val, field, required = false) {
  if (!val) {
    if (required) return { value: null, error: `${field} is required.` };
    return { value: null, error: null };
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(val)))
    return { value: null, error: `${field} must be in YYYY-MM-DD format.` };
  return { value: String(val), error: null };
}

/**
 * Validiert ein Zeit-Format HH:MM.
 */
function time(val, field) {
  if (!val) return { value: null, error: null };
  if (!/^\d{2}:\d{2}$/.test(String(val)))
    return { value: null, error: `${field} must be in HH:MM format.` };
  return { value: String(val), error: null };
}

/**
 * Validiert eine Zahl (positiv oder negativ).
 */
function num(val, field, { required = false } = {}) {
  if (val === undefined || val === null || val === '') {
    if (required) return { value: null, error: `${field} is required.` };
    return { value: null, error: null };
  }
  const n = Number(val);
  if (!isFinite(n)) return { value: null, error: `${field} must be a valid number.` };
  return { value: n, error: null };
}

/**
 * Validiert eine Hex-Farbe (#RRGGBB).
 */
function color(val, field) {
  if (!val) return { value: null, error: null };
  if (!/^#[0-9A-Fa-f]{6}$/.test(String(val)))
    return { value: null, error: `${field} must be a valid HEX color (#RRGGBB).` };
  return { value: String(val), error: null };
}

/**
 * Sammelt alle Fehler aus einem Array von Validierungsergebnissen.
 * @param {Array<{ error: string|null }>} results
 * @returns {string[]} Fehlerliste
 */
function collectErrors(results) {
  return results.map((r) => r.error).filter(Boolean);
}

/**
 * Validiert ein Datetime-Format YYYY-MM-DD oder YYYY-MM-DDTHH:MM[:SS][Z].
 */
function datetime(val, field, required = false) {
  if (!val) {
    if (required) return { value: null, error: `${field} is required.` };
    return { value: null, error: null };
  }
  if (!DATETIME_RE.test(String(val)))
    return { value: null, error: `${field} must be in YYYY-MM-DD or YYYY-MM-DDTHH:MM format.` };
  const raw = String(val).trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(raw)) return { value: raw, error: null };
  const match = raw.match(
    /^(\d{4}-\d{2}-\d{2})[T ](\d{2}):(\d{2})(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:?\d{2})?$/
  );
  if (!match) {
    return { value: null, error: `${field} must be in YYYY-MM-DD or YYYY-MM-DDTHH:MM format.` };
  }
  return { value: `${match[1]}T${match[2]}:${match[3]}`, error: null };
}

/**
 * Validiert ein Monatsformat YYYY-MM.
 */
function month(val, field) {
  if (!val) return { value: null, error: null };
  if (!MONTH_RE.test(String(val)))
    return { value: null, error: `${field} must be in YYYY-MM format.` };
  return { value: String(val), error: null };
}

/**
 * Validiert eine optionale RRULE.
 */
function rrule(val, field) {
  if (!val) return { value: null, error: null };
  const s = String(val).trim();
  if (s.length > MAX_RRULE)
    return { value: null, error: `${field} may be at most ${MAX_RRULE} characters long.` };
  if (!RRULE_RE.test(s))
    return { value: null, error: `${field}: invalid recurrence rule.` };
  return { value: s, error: null };
}

/**
 * Validiert eine ganzzahlige ID (positiv).
 */
function id(val, field) {
  const n = parseInt(val, 10);
  if (!n || n < 1) return { value: null, error: `${field} must be a positive number.` };
  return { value: n, error: null };
}

/**
 * Validiert einen Boolean-Wert.
 * @param {any}    val
 * @param {string} field
 * @returns {{ value: boolean|null, error: string|null }}
 */
function bool(val, field) {
  if (val === undefined || val === null) {
    return { value: null, error: `${field} is required.` };
  }
  if (typeof val !== 'boolean') {
    return { value: null, error: `${field} must be a boolean.` };
  }
  return { value: val, error: null };
}

export {
  str, oneOf, date, time, datetime, month, num, color, rrule, id, bool, collectErrors,
  MAX_TITLE, MAX_TEXT, MAX_SHORT, MAX_RRULE,
  DATE_RE, TIME_RE, DATETIME_RE, COLOR_RE, MONTH_RE,
};
