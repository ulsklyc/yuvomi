/**
 * Modul: Wiederholungsregeln (Recurrence)
 * Zweck: RRULE-Subset-Parser (FREQ=DAILY/WEEKLY/MONTHLY, BYDAY, INTERVAL, UNTIL)
 *        + Berechnung des nächsten Fälligkeitsdatums für wiederkehrende Aufgaben
 * Abhängigkeiten: keine
 */

const DAY_MAP = { MO: 1, TU: 2, WE: 3, TH: 4, FR: 5, SA: 6, SU: 0 };

/**
 * Parsed einen RRULE-String in ein Objekt.
 * Beispiel: "FREQ=WEEKLY;BYDAY=MO,TH;INTERVAL=1;COUNT=10"
 * @param {string} rule
 * @returns {{ freq, interval, byday, until, count }|null}
 */
function parseRRule(rule) {
  if (!rule) return null;
  // Strip "RRULE:" prefix if present (ICS stores rules as "RRULE:FREQ=...")
  const raw = rule.startsWith('RRULE:') ? rule.slice(6) : rule;
  const parts = {};
  for (const segment of raw.split(';')) {
    const eq = segment.indexOf('=');
    if (eq === -1) continue;
    parts[segment.slice(0, eq).toUpperCase()] = segment.slice(eq + 1);
  }

  const freq     = parts.FREQ ?? null;
  const interval = parseInt(parts.INTERVAL ?? '1', 10) || 1;
  const byday    = (parts.BYDAY ?? '').split(',')
    .map((d) => DAY_MAP[d.trim().toUpperCase()])
    .filter((d) => d !== undefined);
  const until    = parts.UNTIL ? parseUntilDate(parts.UNTIL) : null;
  // COUNT begrenzt die Serie auf N Vorkommen (DTSTART = Vorkommen 1). Der
  // stateless nextOccurrence() kann COUNT nicht selbst durchsetzen – das
  // übernimmt die Expansion (expandRecurringEvents), die von DTSTART zählt.
  const countRaw = parts.COUNT ? parseInt(parts.COUNT, 10) : null;
  const count    = Number.isInteger(countRaw) && countRaw > 0 ? countRaw : null;

  if (!['DAILY', 'WEEKLY', 'MONTHLY', 'YEARLY'].includes(freq)) return null;

  return { freq, interval, byday, until, count };
}

function parseUntilDate(str) {
  // Akzeptiert YYYYMMDD oder YYYYMMDDTHHmmssZ
  const clean = str.replace(/[TZ]/g, '');
  const y = parseInt(clean.slice(0, 4), 10);
  const m = parseInt(clean.slice(4, 6), 10) - 1;
  const d = parseInt(clean.slice(6, 8), 10);
  return new Date(Date.UTC(y, m, d));
}

/**
 * Berechnet das nächste Fälligkeitsdatum nach dem gegebenen Basisdatum.
 * @param {string} baseDateStr - ISO-Datums-String (YYYY-MM-DD)
 * @param {string} rrule       - RRULE-String
 * @returns {string|null}      - Nächstes Datum als YYYY-MM-DD oder null (Ende der Serie)
 */
function nextOccurrence(baseDateStr, rrule) {
  const parsed = parseRRule(rrule);
  if (!parsed || !baseDateStr) return null;

  const base = new Date(baseDateStr + 'T00:00:00Z');
  if (isNaN(base.getTime())) return null;

  const { freq, interval, byday, until } = parsed;
  const next = new Date(base);

  if (freq === 'DAILY') {
    next.setUTCDate(next.getUTCDate() + interval);

  } else if (freq === 'WEEKLY') {
    if (byday.length === 0) {
      // Kein BYDAY → selber Wochentag, nächste Woche
      next.setUTCDate(next.getUTCDate() + 7 * interval);
    } else {
      // Finde den nächsten passenden Wochentag (nach heute)
      const currentDay = base.getUTCDay();
      const sorted = [...byday].sort((a, b) => {
        const da = (a - currentDay + 7) % 7 || 7;
        const db = (b - currentDay + 7) % 7 || 7;
        return da - db;
      });
      // Tage bis zum nächsten Vorkommen (mind. 1, damit nicht derselbe Tag)
      let daysUntil = (sorted[0] - currentDay + 7) % 7;
      if (daysUntil === 0) {
        // Selber Wochentag → ganzes Intervall überspringen
        daysUntil = 7 * interval;
      } else if ((sorted[0] + 6) % 7 < (currentDay + 6) % 7) {
        // Wochengrenze überschritten (ISO-Woche MO–SO) → interval-1 Wochen extra überspringen
        daysUntil += 7 * (interval - 1);
      }
      next.setUTCDate(next.getUTCDate() + daysUntil);
    }

  } else if (freq === 'MONTHLY') {
    const targetDay = base.getUTCDate();
    next.setUTCMonth(next.getUTCMonth() + interval);
    // Monatsüberlauf korrigieren (z.B. 31. März + 1 Monat → 30. April)
    const lastDay = new Date(Date.UTC(next.getUTCFullYear(), next.getUTCMonth() + 1, 0)).getUTCDate();
    next.setUTCDate(Math.min(targetDay, lastDay));

  } else if (freq === 'YEARLY') {
    const targetMonth = base.getUTCMonth();
    const targetDay   = base.getUTCDate();
    next.setUTCFullYear(next.getUTCFullYear() + interval);
    // Feb 29 in non-leap year → Feb 28
    next.setUTCMonth(targetMonth);
    const lastDay = new Date(Date.UTC(next.getUTCFullYear(), targetMonth + 1, 0)).getUTCDate();
    next.setUTCDate(Math.min(targetDay, lastDay));
  }

  // UNTIL-Grenze prüfen
  if (until && next > until) return null;

  return next.toISOString().slice(0, 10); // YYYY-MM-DD
}

/**
 * Wie nextOccurrence, überspringt aber alle Vorkommen vor `notBeforeStr`, bis das
 * erste Vorkommen >= notBeforeStr gefunden ist (Aufholen übersprungener Serien).
 * Gibt null zurück, wenn die Serie (UNTIL) vorher endet oder kein Basisdatum existiert.
 * @param {string} baseDateStr  - ISO-Datums-String (YYYY-MM-DD)
 * @param {string} rrule        - RRULE-String
 * @param {string} notBeforeStr - Untere Schranke (YYYY-MM-DD); Ergebnis ist >= dieser
 * @returns {string|null}       - Nächstes zukünftiges Datum als YYYY-MM-DD oder null
 */
function nextOccurrenceAfter(baseDateStr, rrule, notBeforeStr) {
  let current = nextOccurrence(baseDateStr, rrule);
  // Vergleich per lexikografischem YYYY-MM-DD-String (Format ist fix, daher sicher).
  let guard = 0;
  while (current && notBeforeStr && current < notBeforeStr && guard++ < 1000) {
    current = nextOccurrence(current, rrule);
  }
  return current;
}

export { parseRRule, nextOccurrence, nextOccurrenceAfter };
