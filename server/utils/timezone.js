/**
 * Modul: Zeitzonen-Helfer (Server)
 * Zweck: Lokale Wanduhrzeit <-> UTC über eine IANA-TZID, ohne externe Libs.
 *        Genutzt vom ICS-Parser (Sync) und der Kalender-Expansion (Anzeige), damit
 *        wiederkehrende Termine die lokale Uhrzeit über die DST-Grenze behalten (#549).
 * Abhängigkeiten: keine (Intl.DateTimeFormat)
 */

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
