/**
 * Modul: Zeitzonen-Helfer (Server)
 * Zweck: Lokale Wanduhrzeit <-> UTC über eine IANA-TZID, ohne externe Libs, und
 *        die eine Zone, in der dieser Haushalt lebt.
 *        Genutzt vom ICS-Parser (Sync) und der Kalender-Expansion (Anzeige), damit
 *        wiederkehrende Termine die lokale Uhrzeit über die DST-Grenze behalten (#549),
 *        und von allem, was „heute" meint (#829).
 * Abhängigkeiten: keine (Intl.DateTimeFormat)
 *
 * KEIN Import von server/db.js: dieses Modul hängt an ICS-Parser und Expansion,
 * und `db.js` verbindet und migriert die Datenbank BEIM IMPORT. Ein Import hier
 * hieße, dass jede Suite, die einen Kalender-Helfer anfasst, die echte Datei
 * anfasst. Die Verbindung wird deshalb übergeben - dasselbe Muster wie
 * `resolveHouseholdLocale(database)` in server/utils/i18n.js.
 */

/**
 * Ist `zone` eine von dieser Node-/ICU-Version gekannte IANA-Zone?
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
 * Die Zone der Laufzeitumgebung: Container-TZ (TZ-Env, siehe .env.example) →
 * System-Zone → UTC.
 *
 * Das ist der RÜCKFALL, nicht die Antwort. Wer die Zone des Haushalts braucht,
 * ruft `householdTimeZone(database)` - `TZ` ist ein Compose-Schalter, der auf
 * Umbrel/TrueNAS/Unraid für den Nutzer nicht erreichbar ist und zugleich
 * Logzeitstempel und Backup-Cron steuert. Direkte Aufrufer außerhalb dieses
 * Moduls fängt der Guard in test/test-household-timezone.js ab.
 * @returns {string} IANA-Zone
 */
export function serverTimeZone() {
  const envTz = (process.env.TZ || '').trim();
  if (envTz && isValidTimeZone(envTz)) return envTz;
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
  } catch { return 'UTC'; }
}

/**
 * Die Zone, in der dieser Haushalt lebt.
 *
 * Kette: Einstellung `household_timezone` (sync_config) → `TZ` → System-Zone →
 * UTC. Ohne Einstellung ist das exakt das bisherige Verhalten, ein
 * Bestandshaushalt erlebt also keinen stillen Wechsel.
 *
 * Nötig überall dort, wo ein Zeitpunkt ohne eigene Zone auf eine Wanduhrzeit
 * trifft (Google-Outbound ohne Kalenderzone, Outlook-Push, VTODO-Fälligkeiten
 * #617, ICS-Feed #818) und überall dort, wo „heute" gemeint ist (`todayKey`).
 *
 * @param {object|null} database  better-sqlite3-Connection; `null`, wo keine in
 *        Reichweite ist - dann bleibt es beim Rückfall auf die Umgebung.
 * @returns {string} IANA-Zone
 */
export function householdTimeZone(database) {
  try {
    const stored = database?.prepare('SELECT value FROM sync_config WHERE key = ?')
      .get('household_timezone')?.value;
    if (isValidTimeZone(stored)) return stored;
  } catch { /* Tabelle fehlt oder DB zu: Rückfall unten */ }
  return serverTimeZone();
}

/**
 * Der Kalendertag, der für diesen Haushalt gerade „heute" ist.
 *
 * `new Date().toISOString().slice(0, 10)` ist der UTC-Tag und damit westlich von
 * UTC ab dem frühen Abend, östlich davon am frühen Morgen der falsche - dieselbe
 * Falle, die `toLocalDateKey()` im Frontend abfängt (CLAUDE.md) und die #824 im
 * Kalenderfenster ausgelöst hat. Serverseitig gibt es keinen Browser, dessen
 * Zone man nehmen könnte; die Antwort ist die Haushaltszone.
 *
 * @param {object|null} database  better-sqlite3-Connection (siehe householdTimeZone)
 * @param {Date} [now]  Ersetzbar für Tests
 * @returns {string} YYYY-MM-DD
 */
export function todayKey(database, now = new Date()) {
  const iso = now instanceof Date ? now.toISOString() : new Date(now).toISOString();
  return utcToWall(iso, householdTimeZone(database))?.date ?? iso.slice(0, 10);
}

/**
 * Der heutige Kalendertag in UTC.
 *
 * NICHT die Antwort auf "welcher Tag ist heute" - das ist `todayKey`. Diese hier
 * gibt es genau für den Fall, dass eine FREMDE Liste selbst in UTC-Tagen
 * geschlüsselt ist und man einen ihrer Schlüssel treffen muss: die
 * Drei-Stunden-Schritte der OpenWeatherMap-Vorhersage (`dt_txt`) etwa. Dort wäre
 * die Haushaltszone der Fehler, nicht die Lösung, weil sie an dem Schlüsselraum
 * vorbeigriffe.
 *
 * Sie existiert als benannte Funktion, damit der Guard in
 * test/test-household-timezone.js den rohen Ausdruck verbieten kann, ohne eine
 * Ausnahmeliste zu führen: wer hierher greift, sagt mit dem Namen, dass er den
 * UTC-Tag wirklich meint.
 * @param {Date} [now]
 * @returns {string} YYYY-MM-DD
 */
export function utcDateKey(now = new Date()) {
  return now.toISOString().slice(0, 10);
}

/**
 * Trägt dieser gespeicherte Zeitwert seine Zone selbst?
 *
 * In `calendar_events.start_datetime` liegen zwei Formen in EINER Spalte: lokal
 * angelegte Termine sind zonenlose Wanduhrzeit (`2026-08-21T19:00`), extern
 * synchronisierte sind Instants (`…Z` oder mit Offset). Wer beide als Strings
 * vergleicht, vergleicht Äpfel mit Birnen - und merkt es nur westlich von UTC.
 * @param {unknown} value
 * @returns {boolean}
 */
export function hasExplicitZone(value) {
  return /(?:Z|[+-]\d{2}:?\d{2})$/.test(String(value ?? ''));
}

/**
 * Ein gespeicherter Termin-Zeitpunkt als Millisekunden seit Epoch.
 *
 * Zonenlose Werte werden in der Haushaltszone gelesen - das ist die Uhr, die
 * gemeint war, als jemand "19:00" eingetippt hat. Werte mit eigener Zone bleiben
 * der Zeitpunkt, der sie sind. Ganztägige Werte (nur Datum) beginnen um
 * Mitternacht dieser Zone.
 * @param {string} value  Wert aus start_datetime/end_datetime
 * @param {string} tz     IANA-Zone (aus householdTimeZone)
 * @returns {number|null} ms seit Epoch, oder null bei unlesbarem Wert
 */
export function storedToInstantMs(value, tz) {
  return readStoredInstant(value, tz, localToUTC);
}

/**
 * Dieselbe Lesart, nur mit der DST-genauen Umrechnung (`localToUTCPrecise`).
 *
 * Fuer den Erinnerungspfad (#1300): dort wird die Differenz zweier so gelesener
 * Anker auf `reminders.remind_at` addiert, und `localToUTC()` bildet rund um
 * eine DST-Grenze ein ganzes Wanduhr-Band auf DENSELBEN Zeitpunkt ab - 00:30
 * und 01:30 am Umstelltag ergeben in Europe/Berlin beide 23:30Z. Eine
 * Verschiebung zwischen zwei solchen Uhrzeiten kaeme als 0 heraus, und der
 * Vorlauf waechse still um eine Stunde.
 *
 * `storedToInstantMs()` daneben bleibt unveraendert: sein einziger anderer
 * Aufrufer (`calendar-event-reader.js`) sortiert und filtert Termine, und dort
 * kostet eine Stunde innerhalb der Umstellstunde nichts, waehrend jeder Wert
 * zwei zusaetzliche `Intl`-Formatierungen kosten wuerde.
 * @param {string} value  Wert aus start_datetime/end_datetime
 * @param {string} tz     IANA-Zone (aus householdTimeZone)
 * @returns {number|null} ms seit Epoch, oder null bei unlesbarem Wert
 */
export function storedToInstantMsPrecise(value, tz) {
  return readStoredInstant(value, tz, localToUTCPrecise);
}

/**
 * Die eine Stelle, die die zwei Speicherformen auseinanderhaelt - welche
 * Umrechnung die zonenlose Haelfte nimmt, entscheidet der Aufrufer.
 *
 * Ohne diesen gemeinsamen Rumpf stuenden die Formregeln (reines Datum ->
 * Mitternacht, fehlende Sekunden) zweimal da und drifteten auseinander.
 * @param {string} value
 * @param {string} tz
 * @param {(localStr: string, tzid: string) => string} toUTC
 * @returns {number|null}
 */
function readStoredInstant(value, tz, toUTC) {
  const raw = String(value ?? '').trim();
  if (!raw) return null;
  if (hasExplicitZone(raw)) {
    const ms = new Date(raw).getTime();
    return Number.isNaN(ms) ? null : ms;
  }
  const local = raw.length <= 10 ? `${raw}T00:00:00` : (raw.length === 16 ? `${raw}:00` : raw);
  const ms = new Date(toUTC(local, tz)).getTime();
  return Number.isNaN(ms) ? null : ms;
}

/**
 * `todayKey` um `days` Tage verschoben - reine UTC-Arithmetik auf dem
 * Datums-Key, damit die Verschiebung nicht ihrerseits über eine DST-Grenze
 * kippt. Zwei aufeinanderfolgende Kalendertage liegen nicht immer 24 h
 * auseinander, ihre Keys aber immer genau einen Tag.
 * @param {string} dateKey  YYYY-MM-DD
 * @param {number} days
 * @returns {string} YYYY-MM-DD
 */
export function shiftDateKey(dateKey, days) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(dateKey ?? '').slice(0, 10));
  if (!m) return dateKey;
  const ms = Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])) + days * 86400000;
  return new Date(ms).toISOString().slice(0, 10);
}

/**
 * Ganze Kalendertage zwischen zwei Datumsschluesseln (YYYY-MM-DD).
 *
 * Die Rechnung bleibt ueber DST-Grenzen korrekt, weil Datumsschluessel als
 * UTC-Kalendertage statt als lokale Zeitpunkte behandelt werden.
 */
export function daysBetweenDateKeys(fromKey, toKey) {
  const parse = (key) => {
    const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(key ?? '').slice(0, 10));
    if (!match) return null;
    const ms = Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3]));
    return new Date(ms).toISOString().slice(0, 10) === key ? ms : null;
  };
  const from = parse(fromKey);
  const to = parse(toKey);
  return from === null || to === null ? null : Math.round((to - from) / 86400000);
}

/**
 * Lokale Wanduhrzeit in einer IANA-Zone -> UTC-ISO (…Z).
 * @param {string} localStr  'YYYY-MM-DDTHH:mm:ss' ohne Offset
 * @param {string} tzid      z.B. 'Europe/Berlin'
 * @returns {string}         UTC-ISO mit 'Z', oder localStr bei ungültiger Eingabe
 */
export function localToUTC(localStr, tzid) {
  try {
    const fakeUTC = new Date(localStr + 'Z');
    if (isNaN(fakeUTC.getTime())) return localStr;
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone: tzid, year: 'numeric', month: 'numeric', day: 'numeric',
      hour: 'numeric', minute: 'numeric', second: 'numeric', hour12: false,
    }).formatToParts(fakeUTC);
    const get = (type) => {
      const part = parts.find((p) => p.type === type);
      const v = part ? part.value : '0';
      // '24' → 0 gilt NUR für die Stunde: manche ICU-Locales geben Mitternacht als
      // '24' statt '00' aus. Auf Tag/Minute/Sekunde angewandt würde es z.B. den 24.
      // eines Monats in den Vormonat rutschen lassen (falsches Datum, #549).
      if (type === 'hour' && v === '24') return 0;
      return parseInt(v, 10);
    };
    const asUTC = Date.UTC(
      get('year'), get('month') - 1, get('day'), get('hour'), get('minute'), get('second')
    );
    const offsetMs = fakeUTC.getTime() - asUTC;
    return new Date(fakeUTC.getTime() + offsetMs).toISOString().replace('.000Z', 'Z');
  } catch { return localStr; }
}

/**
 * Zonen-Offset (Minuten, Wanduhr minus UTC) an einem gegebenen UTC-Zeitpunkt,
 * ueber utcToWall gelesen - dieselbe Intl-Quelle wie ueberall sonst in diesem
 * Baum, nur zurueckgerechnet in eine Zahl statt Datumsteilen.
 */
function offsetMinutesAt(utcMs, tzid) {
  const wall = utcToWall(new Date(utcMs).toISOString(), tzid);
  if (!wall) return null;
  return (Date.parse(`${wall.date}T${wall.time}Z`) - utcMs) / 60000;
}

/**
 * Lokale Wanduhrzeit -> UTC, DST-korrekt per Fixpunkt-Iteration.
 *
 * `localToUTC()` daneben macht nur EINEN Durchgang: die lokalen Ziffern werden
 * als UTC gelesen, der Zonen-Offset AN DIESEM (falschen) Punkt bestimmt und
 * einmal angewandt. Das stimmt, solange der Offset an der falschen und der
 * richtigen Stelle gleich ist - rund um eine DST-Grenze aber nicht (bis zu
 * einer Offset-Breite daneben), und eine wegen des Fruehjahrssprungs gar nicht
 * existierende Wanduhrzeit wird gar nicht erst erkannt. Praktisch heisst das:
 * ein ganzes Wanduhr-Band bildet auf DENSELBEN Zeitpunkt ab (in Europe/Berlin
 * ergeben 00:30 und 01:30 am 29.03.2026 beide 23:30Z), die Abbildung ist dort
 * also nicht eindeutig.
 *
 * ZWEI FASSUNGEN, NICHT EINE GEAENDERTE: `localToUTC()` bleibt, wie es ist -
 * ICS-Parser, Expansion und Outbound verlassen sich auf sein exaktes
 * Ein-Durchgang-Verhalten, und eine Umstellung dort waere eine andere Frage mit
 * anderen Tests. Wer die tatsaechliche Minute braucht (eine Erinnerung, die eine
 * Stunde zu frueh oder spaet feuert, ist keine Erinnerung mehr), nimmt diese
 * hier: der Schichtplan-Sync (#786) und der Erinnerungspfad des Kalenders
 * (#1300).
 *
 * Verfahren (der uebliche Zwei-Pass-Fixpunkt): Startschaetzung wie localToUTC,
 * daraus den Offset ablesen, die Schaetzung damit korrigieren, den Offset an
 * DIESER korrigierten Stelle erneut ablesen. Bleibt er gleich, ist das
 * Ergebnis exakt (der Rundlauf-Test, den ein einzelner Durchgang nie macht).
 * Weicht er ab, liegt localStr auf/um eine DST-Grenze:
 * - Zweiter Durchgang stabilisiert sich (Herbst/Fold, die Wanduhrzeit gab es
 *   zweimal): das Ergebnis des zweiten Durchgangs gilt - eine der beiden
 *   gueltigen Antworten, deterministisch statt zufaellig. Es ist die SPAETERE,
 *   also die Lage nach der Umstellung (in Europe/Berlin CET): der erste
 *   Durchgang startet auf der Winterseite und findet dort seinen Fixpunkt.
 * - Kein Fixpunkt nach zwei Durchgaengen (Fruehling/Luecke, die Wanduhrzeit
 *   gab es GAR NICHT): um die Luecke vorschieben, deren Breite die Differenz
 *   der beiden gesehenen Offsets ist - dokumentierter Ausweichweg, keine
 *   perfekte Antwort, weil es keine gibt.
 *
 * Ground-truth manuell geprueft (Europe/Berlin): 06:00 lokal am 2026-03-29
 * (schon CEST, +02:00) -> 04:00Z; 06:00 lokal am 2026-10-25 (schon wieder CET,
 * +01:00) -> 05:00Z; beide Tage liegen fuer 06:00 bereits auf der jeweils
 * richtigen Seite der Grenze, single-pass und diese Funktion stimmen dort
 * ueberein - der Unterschied zeigt sich erst innerhalb der Sprung-/Fold-Stunde
 * selbst.
 *
 * @param {string} localStr  'YYYY-MM-DDTHH:mm:ss' ohne Offset
 * @param {string} tzid      IANA-Zone
 * @returns {string} UTC-ISO mit 'Z'
 */
export function localToUTCPrecise(localStr, tzid) {
  const naiveMs = Date.parse(`${localStr}Z`);
  if (Number.isNaN(naiveMs)) return localToUTC(localStr, tzid);

  const o1 = offsetMinutesAt(naiveMs, tzid);
  if (o1 == null) return localToUTC(localStr, tzid);
  const guessA = naiveMs - o1 * 60000;

  const o2 = offsetMinutesAt(guessA, tzid);
  if (o2 == null) return localToUTC(localStr, tzid);
  if (o2 === o1) return new Date(guessA).toISOString().replace('.000Z', 'Z');

  const guessB = naiveMs - o2 * 60000;
  const o3 = offsetMinutesAt(guessB, tzid);
  if (o3 === o2) return new Date(guessB).toISOString().replace('.000Z', 'Z');

  // Kein Fixpunkt in zwei Durchgaengen: Fruehjahrsluecke. Um die Luecke
  // vorschieben statt eine Antwort vorzutaeuschen, die es nicht gibt.
  const gapMinutes = Math.abs(o2 - o1);
  return new Date(guessA + gapMinutes * 60000).toISOString().replace('.000Z', 'Z');
}

/**
 * UTC-Instant (ISO …Z) -> lokale Wanduhr-Bestandteile in einer IANA-Zone.
 * @param {string} iso   UTC-ISO
 * @param {string} tzid  z.B. 'Europe/Berlin'
 * @returns {{ date: string, time: string }|null}  { 'YYYY-MM-DD', 'HH:mm:ss' } oder null
 */
export function utcToWall(iso, tzid) {
  try {
    const d = new Date(iso);
    if (isNaN(d.getTime())) return null;
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone: tzid, year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false,
    }).formatToParts(d);
    const g = (t) => { const p = parts.find((x) => x.type === t); return p ? p.value : '00'; };
    let hh = g('hour'); if (hh === '24') hh = '00'; // Mitternacht '24' → '00'
    return { date: `${g('year')}-${g('month')}-${g('day')}`, time: `${hh}:${g('minute')}:${g('second')}` };
  } catch { return null; }
}
