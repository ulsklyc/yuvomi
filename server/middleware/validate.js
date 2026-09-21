/**
 * Modul: Eingabe-Validierung (Validate)
 * Zweck: Wiederverwendbare Validierungs-Helfer für alle API-Routen
 * Abhängigkeiten: server/utils/timezone.js (reine Rechnung, keine Datenbank)
 */

import { isValidTimeZone, utcToWall } from '../utils/timezone.js';

// Globale Längengrenzen
const MAX_TITLE    = 200;
const MAX_TEXT     = 5000;
const MAX_SHORT    = 100;
const MAX_RRULE    = 300;
const MAX_URL      = 2000;

// Regex-Muster
const DATE_RE     = /^\d{4}-\d{2}-\d{2}$/;
const TIME_RE     = /^\d{2}:\d{2}$/;
const DATETIME_RE = /^\d{4}-\d{2}-\d{2}(T\d{2}:\d{2}(:\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:?\d{2})?)?$/;
const COLOR_RE    = /^#[0-9A-Fa-f]{6}$/;
const MONTH_RE    = /^\d{4}-\d{2}$/;
// UNTIL und COUNT schließen sich laut RFC 5545 gegenseitig aus (#513).
// Erlaubt ist AUSSCHLIESSLICH `BYMONTHDAY=-1` ("letzter Tag des Monats", #960),
// und AUSSCHLIESSLICH unter `FREQ=MONTHLY`. Beide Einschraenkungen mussten
// nachgezogen werden, und die zweite ist die subtilere: als blosse optionale
// Gruppe NEBEN der Frequenz-Alternation nahm der Ausdruck auch
// `FREQ=WEEKLY;BYMONTHDAY=-1` an - eine Regel, die `parseRRule` danach
// ignoriert, weil es die Angabe nur bei MONTHLY liest. Genau das
// "angenommen, aber nie beachtet", gegen das die Verengung ueberhaupt
// gebaut wurde, nur eine Ebene hoeher.
//
// Deshalb zwei Zweige statt einer gemeinsamen Gruppe: der Monatszweig darf sie
// tragen, die anderen Frequenzen nicht. Der gemeinsame Schwanz (Endebedingung)
// steht hinter beiden.
const RRULE_TAIL  = '(;(UNTIL=\\d{8}(T\\d{6}Z)?|COUNT=\\d{1,4}))?';
const RRULE_HEAD  = '(;INTERVAL=\\d{1,2})?(;BYDAY=[A-Z,]{2,}(,[A-Z]{2})*)?';
const RRULE_RE    = new RegExp(
  `^(FREQ=MONTHLY${RRULE_HEAD}(;BYMONTHDAY=-1)?${RRULE_TAIL}`
  + `|FREQ=(DAILY|WEEKLY|YEARLY)${RRULE_HEAD}${RRULE_TAIL})?$`
);

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
 * Validiert ein Datumsformat YYYY-MM-DD - Form UND Kalendergueltigkeit.
 *
 * Die reine Regex liesse 2026-02-30 oder 2026-13-01 durch. Solche Werte landeten
 * frueher unbemerkt in der Datenbank und sprengten erst spaeter die Dienste, die
 * das Datum wirklich parsen (server/services/inventory-deadlines.js#parseDateKey,
 * server/services/subscriptions.js#parseDateKey) - also nach dem Schreibvorgang,
 * mit halb geschriebenem Zustand und dauerhaft kaputtem ICS-Feed. Der
 * UTC-Round-Trip hier spiegelt genau die Pruefung dieser beiden parseDateKey.
 * @param {any}    val
 * @param {string} field
 * @param {boolean} required
 */
function date(val, field, required = false) {
  if (!val) {
    if (required) return { value: null, error: `${field} is required.` };
    return { value: null, error: null };
  }
  const raw = String(val);
  const match = raw.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!match)
    return { value: null, error: `${field} must be in YYYY-MM-DD format.` };
  const [, y, m, d] = match;
  const parsed = new Date(Date.UTC(Number(y), Number(m) - 1, Number(d)));
  const roundTrip = [
    parsed.getUTCFullYear(),
    String(parsed.getUTCMonth() + 1).padStart(2, '0'),
    String(parsed.getUTCDate()).padStart(2, '0'),
  ].join('-');
  if (roundTrip !== raw)
    return { value: null, error: `${field} must be a valid calendar date.` };
  return { value: raw, error: null };
}

/**
 * Validiert ein Zeit-Format HH:MM.
 */
function time(val, field) {
  if (!val) return { value: null, error: null };
  const raw = String(val);
  if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(raw))
    return { value: null, error: `${field} must be a valid HH:MM time.` };
  return { value: raw, error: null };
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

// Theme-aware Akzent-Tokens, die einige Module (Budget-Konten, #542) statt eines
// festen Hex speichern, damit die Farbe im Dark Mode mit aufgehellt wird. Bewusst
// eng auf die `--chart-series-*`-Palette begrenzt: Die Validierung bleibt damit
// eine dichte Sicherheitsgrenze - es landet kein beliebiger CSS-Ausdruck in einem
// style-Attribut, sondern nur eine bekannte Custom-Property-Referenz.
const SERIES_TOKEN_RE = /^var\(--chart-series-[1-9][0-9]?\)$/;

/**
 * Validiert eine Hex-Farbe (#RRGGBB). Mit `{ allowTokens: true }` werden zusätzlich
 * die theme-aware `var(--chart-series-N)`-Akzent-Tokens akzeptiert (siehe #542).
 */
function color(val, field, { allowTokens = false } = {}) {
  if (!val) return { value: null, error: null };
  const str = String(val);
  if (/^#[0-9A-Fa-f]{6}$/.test(str)) return { value: str, error: null };
  if (allowTokens && SERIES_TOKEN_RE.test(str)) return { value: str, error: null };
  return { value: null, error: `${field} must be a valid HEX color (#RRGGBB).` };
}

/**
 * Validiert eine optionale URL. Erlaubt ausschließlich http/https-Schemata,
 * damit gespeicherte Werte gefahrlos als <a href> gerendert werden können
 * (blockt javascript:/data:/file: etc. — XSS-Schutz an der Quelle).
 * @param {any}    val
 * @param {string} field
 * @returns {{ value: string|null, error: string|null }}
 */
function url(val, field) {
  if (val === undefined || val === null || val === '') return { value: null, error: null };
  const s = String(val).trim();
  if (!s) return { value: null, error: null };
  if (s.length > MAX_URL)
    return { value: null, error: `${field} may be at most ${MAX_URL} characters long.` };
  let parsed;
  try {
    parsed = new URL(s);
  } catch {
    return { value: null, error: `${field} must be a valid URL.` };
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:')
    return { value: null, error: `${field} must be an http(s) URL.` };
  return { value: s, error: null };
}

/**
 * Sammelt alle Fehler aus einem Array von Validierungsergebnissen.
 * @param {Array<{ error: string|null }>} results
 * @returns {string[]} Fehlerliste
 */
function collectErrors(results) {
  return results.map((r) => r.error).filter(Boolean);
}

// Ein Wert, der seinen Zeitpunkt selbst traegt: `Z` oder ein numerischer
// Offset, mit oder ohne Doppelpunkt (`+02:00`, `+0200`). Die Teile werden
// selbst gelesen statt ueber `Date.parse`: `+0200` und mehr als drei
// Nachkommastellen stehen nicht im ECMAScript-Format, und was die Engine
// daraus macht, ist nicht zugesagt.
const ZONED_DATETIME_RE = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.(\d+))?)?(?:(Z)|([+-])(\d{2}):?(\d{2}))$/;
const NAIVE_DATETIME_RE = /^(\d{4}-\d{2}-\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.\d+)?)?$/;

/**
 * Ein Wert mit `Z` oder Offset als Millisekunden seit Epoch, oder null, wenn
 * seine Ziffern keinen echten Zeitpunkt bilden (30. Februar, Stunde 24).
 * @param {string} raw
 * @returns {number|null}
 */
function zonedInstantMs(raw) {
  const m = ZONED_DATETIME_RE.exec(raw);
  if (!m) return null;
  const [, y, mo, d, h, mi, s = '0', frac = '', zulu, sign, oh, om] = m;
  if (Number(h) > 23 || Number(mi) > 59 || Number(s) > 59) return null;
  if (!zulu && (Number(oh) > 23 || Number(om) > 59)) return null;
  const digitsAsUtc = Date.UTC(
    Number(y), Number(mo) - 1, Number(d), Number(h), Number(mi), Number(s),
    Number(frac.padEnd(3, '0').slice(0, 3)),
  );
  const check = new Date(digitsAsUtc);
  if (check.getUTCFullYear() !== Number(y)
      || check.getUTCMonth() !== Number(mo) - 1
      || check.getUTCDate() !== Number(d)) return null;
  const offsetMinutes = zulu ? 0 : (sign === '-' ? -1 : 1) * (Number(oh) * 60 + Number(om));
  return digitsAsUtc - offsetMinutes * 60000;
}

/**
 * Validiert ein Datetime-Format YYYY-MM-DD oder YYYY-MM-DDTHH:MM[:SS[.f]][Z|+hh:mm]
 * und bringt es in die Form der Spalte, in der es landet (#1364).
 *
 * EIN OFFSET WIRD UMGERECHNET, NICHT ABGESCHNITTEN. Bis hierher kamen von
 * `2026-09-21T16:00:00Z` nur die Ziffern `2026-09-21T16:00` an, und jede Route
 * speicherte sie als Wanduhrzeit des Haushalts: der Termin lag in Berlin zwei
 * Stunden zu frueh, ohne Fehler. Ein Wert mit `Z` oder Offset ist ein
 * eindeutiger Zeitpunkt; welche Form er danach annimmt, haengt an der Spalte,
 * nicht am Wert - deshalb nennt jeder Aufrufer sein Ziel:
 *
 * - `to: 'wall'` mit `zone`: Wanduhrzeit der Haushaltszone, `YYYY-MM-DDTHH:MM`
 *   (Kalender start/end, Gesundheits-Zeitstempel). Die Zone kommt von der Route
 *   (`householdTimeZone(db)`): dieses Modul kennt keine Datenbank. Mit
 *   `allDay: true` zaehlt nur das Datum, wie es gesendet wurde - ein
 *   ganztaegiger Termin mit `T00:00Z` bleibt westlich von UTC an seinem Tag,
 *   statt auf den Vorabend zu rutschen.
 * - `to: 'utc'`: naive UTC `YYYY-MM-DDTHH:MM:SS`, die Form, gegen die der
 *   Erinnerungs-Scheduler vergleicht (`reminders.remind_at`).
 * - `to: 'instant'`: UTC-Instant `YYYY-MM-DDTHH:MM:SS.sssZ`, wie ihn
 *   `/decay-tasks/:id/complete` schreibt (`last_completed`).
 *
 * Werte OHNE Offset behalten ihre Bedeutung: Wanduhrzeit, auf
 * `YYYY-MM-DDTHH:MM` gekuerzt, ein reines Datum bleibt ein reines Datum. Wer
 * lokale Ziffern schickt, merkt also nichts. Die eine Ausnahme ist die FORM
 * bei `to: 'utc'`: die zonenlose Eingabe ist dort schon die UTC-Zeit, kommt
 * aber in dieselbe Form `YYYY-MM-DDTHH:MM:SS` wie ein umgerechneter Offset
 * (fehlende Sekunden :00, Bruchteile weg), und ein reines Datum wird
 * `YYYY-MM-DDT00:00:00` - Mitternacht UTC, genau der Zeitpunkt, zu dem der
 * Scheduler es schon vorher feuerte. Sonst waeren `07:00`, `07:00:00` und
 * `09:00:00+02:00` drei Erinnerungen fuer einen Zeitpunkt (#1364).
 *
 * Ein Offset-Wert OHNE genanntes Ziel wirft: das waere wieder das stille
 * Abschneiden, gegen das diese Funktion gebaut ist, und ein neuer Aufrufer soll
 * es beim ersten Versuch merken statt am verschobenen Datensatz.
 *
 * @param {any}     val
 * @param {string}  field
 * @param {boolean} [required=false]
 * @param {object}  [opts]
 * @param {'wall'|'utc'|'instant'} [opts.to]  Form der Zielspalte
 * @param {string}  [opts.zone]    IANA-Zone des Haushalts (Pflicht bei 'wall')
 * @param {boolean} [opts.allDay]  ganztaegig: nur das Datum zaehlt
 * @returns {{ value: string|null, error: string|null }}
 */
function datetime(val, field, required = false, { to, zone, allDay = false } = {}) {
  if (!val) {
    if (required) return { value: null, error: `${field} is required.` };
    return { value: null, error: null };
  }
  if (!DATETIME_RE.test(String(val)))
    return { value: null, error: `${field} must be in YYYY-MM-DD or YYYY-MM-DDTHH:MM format.` };
  const raw = String(val).trim();
  if (DATE_RE.test(raw)) return { value: to === 'utc' ? `${raw}T00:00:00` : raw, error: null };

  if (ZONED_DATETIME_RE.test(raw)) {
    if (to !== 'wall' && to !== 'utc' && to !== 'instant') {
      throw new TypeError(`datetime(): ${field} carries an offset, but the caller names no target form.`);
    }
    const ms = zonedInstantMs(raw);
    if (ms === null) return { value: null, error: `${field} must be a valid date and time.` };
    if (to === 'wall' && allDay) return { value: raw.slice(0, 10), error: null };
    if (to === 'wall' && !isValidTimeZone(zone)) {
      throw new TypeError(`datetime(): ${field} needs the household zone to be converted.`);
    }
    const iso = new Date(ms).toISOString();
    if (to === 'utc') return { value: iso.slice(0, 19), error: null };
    if (to === 'instant') return { value: iso, error: null };
    const wall = utcToWall(iso, zone);
    if (!wall) return { value: null, error: `${field} must be a valid date and time.` };
    return { value: `${wall.date}T${wall.time.slice(0, 5)}`, error: null };
  }

  const match = NAIVE_DATETIME_RE.exec(raw);
  if (!match) {
    return { value: null, error: `${field} must be in YYYY-MM-DD or YYYY-MM-DDTHH:MM format.` };
  }
  if (to === 'utc') return { value: `${match[1]}T${match[2]}:${match[3]}:${match[4] ?? '00'}`, error: null };
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
  str, oneOf, date, time, datetime, month, num, color, url, rrule, id, bool, collectErrors,
  MAX_TITLE, MAX_TEXT, MAX_SHORT, MAX_RRULE, MAX_URL,
  DATE_RE, TIME_RE, DATETIME_RE, COLOR_RE, MONTH_RE, RRULE_RE,
};
