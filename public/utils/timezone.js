/**
 * Modul: Anzeigezone (Frontend) - #829 Teil 3
 * Zweck: Die eine Antwort auf „auf welcher Uhr liest dieser Haushalt seine
 *        Zeiten ab". Gegenstück zu server/utils/timezone.js: dort wurden fünf
 *        serverseitige Uhren auf `householdTimeZone(database)` zusammengeführt,
 *        hier folgt die Anzeige derselben Zone statt der des Browsers.
 * Abhängigkeiten: keine (Intl.DateTimeFormat, localStorage defensiv)
 *
 * WARUM ES DIESE DATEI BRAUCHT. In `calendar_events.start_datetime` liegen zwei
 * Speicherformen in EINER Spalte (siehe `hasExplicitZone` in
 * server/utils/timezone.js): lokal angelegte Termine sind zonenlose Wanduhrzeit
 * (`2026-08-21T19:00`), extern synchronisierte sind Instants (`…Z` oder mit
 * Offset). Der Browser liest die erste Form in SEINER Zone - also unverändert,
 * 19:00 bleibt 19:00 - und rechnet die zweite in SEINE Zone um. Solange Browser
 * und Haushalt dieselbe Zone haben, fällt das nie auf. Auf Reisen, im Ausland
 * oder mit einem falsch gestellten Gerät zeigt derselbe Termin zwei Uhrzeiten,
 * je nachdem, woher er kam. Das ist die letzte der fünf Uhren.
 *
 * DIE REGEL, DIE DIE UMRECHNUNG STEUERT: umgerechnet wird nur, was seine Zone
 * SELBST TRÄGT. Eine zonenlose Wanduhrzeit ist bereits die Antwort - wer
 * „19:00" eingetippt hat, meinte 19:00, und eine Umrechnung würde daraus eine
 * andere Zahl machen. Ein reines Datum hat gar keine Uhrzeit. Beide werden
 * deshalb gelesen, nicht gerechnet.
 *
 * OHNE EINSTELLUNG ÄNDERT SICH NICHTS. `displayTimeZone()` liefert `null`,
 * solange niemand `household_timezone` gesetzt hat, und jeder Helfer hier fällt
 * dann auf exakt das bisherige Browser-Verhalten zurück. Gespiegelt wird
 * bewusst `timezone` (die getroffene Wahl), nicht `timezone_effective` (die
 * Rückfallkette, die nie leer ist): `TZ` ist ein Compose-Schalter des Servers
 * und sagt nichts darüber aus, wo dieser Haushalt lebt. Erst wer die Zone
 * bewusst setzt, sagt „so tickt es hier" - und nur dann darf sich die Anzeige
 * eines Bestandshaushalts ändern.
 */

const STORAGE_KEY = 'yuvomi-timezone';

/** Gecachte Formatter je Zone - `new Intl.DateTimeFormat` pro Wert wäre teuer. */
const _formatterCache = new Map();

let _cachedZone;   // undefined = noch nicht gelesen, null = keine Einstellung

/**
 * Ist `zone` eine von dieser Browser-/ICU-Version gekannte IANA-Zone?
 * Spiegel von `isValidTimeZone` in server/utils/timezone.js.
 * @param {unknown} zone
 * @returns {boolean}
 */
export function isValidTimeZone(zone) {
  if (typeof zone !== 'string' || !zone.trim()) return false;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: zone });
    return true;
  } catch { return false; }
}

/**
 * Die Zone, in der diese Oberfläche Zeiten anzeigt - oder `null` für „die des
 * Browsers", was dem Verhalten vor #829 entspricht.
 * @returns {string|null} IANA-Zone oder null
 */
export function displayTimeZone() {
  if (_cachedZone !== undefined) return _cachedZone;
  let stored = null;
  try { stored = localStorage.getItem(STORAGE_KEY); } catch { stored = null; }
  _cachedZone = isValidTimeZone(stored) ? stored : null;
  return _cachedZone;
}

/**
 * Übernimmt die Haushaltszone aus einer Preferences-Antwort.
 *
 * `null`/leer entfernt sie wieder - das ist die Automatik-Stellung des
 * Auswahlfelds und muss die Anzeige zurück auf den Browser stellen, sonst bliebe
 * eine abgewählte Zone bis zum nächsten Neuladen aktiv.
 * @param {string|null|undefined} zone
 */
export function setDisplayTimeZone(zone) {
  const next = isValidTimeZone(zone) ? zone : null;
  _cachedZone = next;
  try {
    if (next) localStorage.setItem(STORAGE_KEY, next);
    else localStorage.removeItem(STORAGE_KEY);
  } catch { /* privater Modus o.ä.: der Prozess-Cache oben trägt die Sitzung */ }
}

/** Nur für Tests: den gelesenen Wert vergessen, damit der nächste Aufruf neu liest. */
export function _resetDisplayTimeZoneCache() {
  _cachedZone = undefined;
}

/**
 * Trägt dieser Zeitwert seine Zone selbst?
 * Spiegel von `hasExplicitZone` in server/utils/timezone.js - dieselbe Frage,
 * dieselbe Antwort, damit Server und Anzeige denselben Wert gleich einordnen.
 * @param {unknown} value
 * @returns {boolean}
 */
export function hasExplicitZone(value) {
  return /(?:Z|[+-]\d{2}:?\d{2})$/.test(String(value ?? ''));
}

/** Ein reines Datum ohne Uhrzeit ('YYYY-MM-DD'). */
export function isDateOnly(value) {
  return typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value.trim());
}

/**
 * Muss dieser Wert in die Anzeigezone umgerechnet werden?
 *
 * Genau dann, wenn er einen ZEITPUNKT bezeichnet: ein `Date`-Objekt oder ein
 * String mit eigener Zone. Zonenlose Strings und reine Daten sind bereits
 * Wanduhrzeit und werden nur gelesen.
 * @param {unknown} value
 * @returns {boolean}
 */
export function isInstant(value) {
  if (value instanceof Date) return true;
  if (typeof value === 'number') return true;
  return typeof value === 'string' && hasExplicitZone(value);
}

function formatterFor(zone) {
  let fmt = _formatterCache.get(zone);
  if (!fmt) {
    fmt = new Intl.DateTimeFormat('en-US', {
      timeZone: zone, era: 'short', year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false,
    });
    _formatterCache.set(zone, fmt);
  }
  return fmt;
}

/**
 * Die Wanduhr-Bestandteile eines Zeitwerts in der Anzeigezone.
 *
 * Das ist die EINE Umrechnung, auf der alles andere hier aufsetzt. Sie liefert
 * Zahlen, keine formatierten Texte - die Schreibweise (Datumsformat,
 * 12h/24h, Locale) gehört nach public/i18n.js und hat mit der Zone nichts zu
 * tun.
 *
 * @param {Date|string|number|null|undefined} value
 * @returns {{year:number,month:number,day:number,hour:number,minute:number,second:number}|null}
 *          `null`, wenn der Wert nicht lesbar ist
 */
export function zonedFields(value, timeZone = displayTimeZone()) {
  if (value === null || value === undefined || value === '') return null;

  // Wanduhrzeit: direkt lesen. Ein Umweg über `new Date()` wäre hier nicht nur
  // unnötig, sondern falsch - er würde die Zeichen in einen Zeitpunkt der
  // Browser-Zone verwandeln und ihn anschließend in eine andere umrechnen.
  if (typeof value === 'string' && !hasExplicitZone(value)) {
    const m = /^(\d{4}|[+-]\d{6})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2})(?::(\d{2}))?)?/.exec(value.trim());
    if (m) {
      return {
        year: Number(m[1]), month: Number(m[2]), day: Number(m[3]),
        hour: Number(m[4] ?? 0), minute: Number(m[5] ?? 0), second: Number(m[6] ?? 0),
      };
    }
    // Kein erkanntes Muster (z. B. 'March 3, 2026'): unten als Instant versuchen.
  }

  const d = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(d.getTime())) return null;

  const zone = timeZone;
  if (!zone) {
    return {
      year: d.getFullYear(), month: d.getMonth() + 1, day: d.getDate(),
      hour: d.getHours(), minute: d.getMinutes(), second: d.getSeconds(),
    };
  }

  const parts = formatterFor(zone).formatToParts(d);
  const g = (type) => {
    const p = parts.find((x) => x.type === type);
    return p ? Number(p.value) : 0;
  };
  // Mitternacht kommt in manchen ICU-Locales als '24' statt '00'. Die Korrektur
  // gilt NUR für die Stunde - auf den Tag angewandt würde sie den 24. eines
  // Monats auf 0 setzen (dieselbe Falle wie in server/utils/timezone.js).
  const hour = g('hour');
  return {
    year: parts.find((part) => part.type === 'era')?.value === 'BC' ? 1 - g('year') : g('year'), month: g('month'), day: g('day'),
    hour: hour === 24 ? 0 : hour, minute: g('minute'), second: g('second'),
  };
}

const pad2 = (n) => String(n).padStart(2, '0');
const isoYear = (year) => year >= 0 && year <= 9999 ? String(year).padStart(4, '0') : `${year < 0 ? '-' : '+'}${String(Math.abs(year)).padStart(6, '0')}`;

/** Editable wall time in an explicit recorded zone, never the browser zone. */
export function wallTimeValue(value, zone) {
  const f = zonedFields(value, zone);
  return f ? `${isoYear(f.year)}-${pad2(f.month)}-${pad2(f.day)}T${pad2(f.hour)}:${pad2(f.minute)}:${pad2(f.second)}` : '';
}

function wallEpoch(value) {
  const date = new Date(`${value}Z`);
  return date.getTime();
}

/** Enumerate valid offsets; round-trip rejects DST gaps and malformed dates. */
export function wallTimeCandidates(value, zone) {
  if (!isValidTimeZone(zone) || !/^(?:\d{4}|[+-]\d{6})-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2})?$/.test(value)) return [];
  const wall = /T\d{2}:\d{2}$/.test(value) ? `${value}:00` : value;
  const epoch = wallEpoch(wall);
  if (!Number.isFinite(epoch)) return [];
  const offsets = new Set();
  for (let hours = -36; hours <= 36; hours += 6) {
    const sample = epoch + hours * 3600000;
    offsets.add(wallEpoch(wallTimeValue(sample, zone)) - sample);
  }
  return [...offsets].map((offset) => ({ instant: new Date(epoch - offset).toISOString(), offsetMinutes: offset / 60000 }))
    .filter((candidate) => wallTimeValue(candidate.instant, zone) === wall)
    .sort((a, b) => a.instant.localeCompare(b.instant));
}

/** Retain an existing fold's offset, including exact unchanged milliseconds. */
export function wallTimeInstant(value, zone, original = null, offsetMinutes = null) {
  const wall = /T\d{2}:\d{2}$/.test(value) ? `${value}:00` : value;
  if (original && wallTimeValue(original, zone) === wall && offsetMinutes === null) return original;
  const candidates = wallTimeCandidates(wall, zone);
  if (!candidates.length) throw new Error('Invalid wall time');
  const preferred = offsetMinutes ?? (original ? (wallEpoch(wallTimeValue(original, zone)) - Math.floor(Date.parse(original) / 1000) * 1000) / 60000 : null);
  return (candidates.find((candidate) => candidate.offsetMinutes === preferred) || candidates[0]).instant;
}

/**
 * Der Kalendertag eines Zeitwerts in der Anzeigezone (YYYY-MM-DD).
 * @param {Date|string|number} value
 * @returns {string} '' bei unlesbarem Wert
 */
export function zonedDateKey(value) {
  const f = zonedFields(value);
  return f ? `${f.year}-${pad2(f.month)}-${pad2(f.day)}` : '';
}

/**
 * Die Uhrzeit eines Zeitwerts in der Anzeigezone (HH:MM).
 * @param {Date|string|number} value
 * @returns {string} '' bei unlesbarem Wert
 */
export function zonedTimeKey(value) {
  const f = zonedFields(value);
  return f ? `${pad2(f.hour)}:${pad2(f.minute)}` : '';
}

/**
 * Der Kalendertag, der für diesen Haushalt gerade „heute" ist.
 *
 * Das Gegenstück zu `todayKey(database)` auf dem Server. `toLocalDateKey()` aus
 * public/utils/date.js bleibt daneben bestehen und ist etwas anderes: ein
 * KONVERTER von einem `Date` der Browser-Wanduhr auf einen Key. Die beiden dürfen
 * nicht verschmelzen - `parseLocalDateKey`/`toLocalDateKey` bilden ein Paar, das
 * seinen Schlüssel unverändert zurückgeben muss, und das tut es nur, wenn beide
 * Seiten dieselbe Zone lesen. Die Zone des Haushalts braucht genau eine Frage:
 * welcher Tag ist jetzt.
 *
 * @param {Date} [now] Ersetzbar für Tests
 * @returns {string} YYYY-MM-DD
 */
export function todayKey(now = new Date()) {
  return zonedDateKey(now);
}

/**
 * Wie spät ist es gerade IM HAUSHALT.
 *
 * Für alles, was die Uhr fragt statt einen gespeicherten Wert zu lesen: die
 * Tageszeit-Begrüßung, das Nachtfenster des Wandmodus, die Position der
 * Jetzt-Linie im Wochenkalender, die vorgeschlagene Uhrzeit für einen neuen
 * Termin. Das ist dieselbe Frage wie `todayKey()`, nur feiner aufgelöst - und
 * sie hat dieselbe Antwort, sonst begrüßt ein Gerät in einer anderen Zone mit
 * „Guten Morgen", während im Haushalt Abend ist.
 *
 * @param {Date} [now] Ersetzbar für Tests
 * @returns {{year:number,month:number,day:number,hour:number,minute:number,second:number}}
 */
export function nowFields(now = new Date()) {
  return zonedFields(now);
}

/**
 * Ein `Date`, dessen UTC-Felder die Wanduhr-Felder der Anzeigezone sind.
 *
 * Für den einen Fall, in dem die Zahlen nicht reichen: eine locale-abhängige
 * Schreibweise, die nur `Intl.DateTimeFormat` kennt (ein Wochentagsname etwa).
 * Der Formatter bekommt dieses Date zusammen mit `timeZone: 'UTC'` - dann
 * rechnet er nicht ein zweites Mal um und ist nicht die nächste eigene Uhr,
 * liefert aber weiter Namen und Ziffernsystem der Locale.
 *
 * NUR ZUM FORMATIEREN. Als Zeitpunkt gelesen ist dieses Date um den Offset der
 * Zone falsch - das ist der Preis dafür, dass Intl keine Felder entgegennimmt.
 * @param {Date|string|number} value
 * @returns {Date|null}
 */
export function zonedUTCProxy(value) {
  const f = zonedFields(value);
  if (!f) return null;
  return new Date(Date.UTC(f.year, f.month - 1, f.day, f.hour, f.minute, f.second));
}

/**
 * Der Wochentag eines Zeitwerts in der Anzeigezone als getDay()-Index (0=So).
 *
 * Bewusst aus den Kalenderfeldern gerechnet statt über `Intl`-Wochentagsnamen:
 * `Date.UTC` auf Jahr/Monat/Tag ist zonenfrei, ein Name müsste erst wieder
 * zurückübersetzt werden.
 * @param {Date|string|number} value
 * @returns {number|null} 0-6, oder null bei unlesbarem Wert
 */
export function zonedWeekday(value) {
  const f = zonedFields(value);
  if (!f) return null;
  return new Date(Date.UTC(f.year, f.month - 1, f.day)).getUTCDay();
}
