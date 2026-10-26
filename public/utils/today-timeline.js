/**
 * Modul: Zeitleiste des Heute-Blatts
 * Zweck: Ordnet die heutigen Termine auf eine Stundenachse - eine Spur je
 *        Person, eine fuer den ganzen Haushalt - und rechnet Lage, Breite,
 *        Ueberlappung und den Jetzt-Strich. Rein, ohne DOM und ohne Zone: die
 *        Minuten des Tages kommen schon in der Wanduhr des Haushalts an
 *        (dashboard.js, buildTodayTimeline).
 *
 * WARUM ES DIE LEISTE GIBT (Entwurf „Heute wichtig", 2026-10-26). Die Liste
 * darunter beantwortet „was steht als Naechstes an"; sie kann nicht zeigen,
 * wann der Tag voll ist und wer wann unterwegs ist. Die Leiste zeigt die Form
 * des Tages, die Liste bleibt das Versprechen (#1449): Vergangenes tritt in
 * der Leiste zurueck, in der Liste steht es gar nicht.
 *
 * NUR ECHTE ZEIT (Critique 2026-10-26, Befund 3). Termine mit Uhrzeit und
 * die eigene Schicht sind Bloecke mit Dauer. Die Mahlzeit hat nur die
 * Nennzeit ihres Typs - sie kommt als Punkt (`end === start`), ohne Dauer und
 * ohne „laeuft gerade". Eine Aufgabe hat eine Frist, der Einkauf keine Zeit:
 * ein Balken dafuer waere eine erfundene Auskunft. Ganztaegiges hat keinen Ort
 * auf der Achse; es steht als Band darueber (dashboard.js), nicht hier.
 */

/** Der Rahmen, den die Achse mindestens zeigt: 07 bis 22 Uhr. */
export const TIMELINE_MIN_START = 7 * 60;
export const TIMELINE_MIN_END = 22 * 60;
const DAY_END = 24 * 60;

/* Ein Termin ohne Ende oder mit Ende gleich Beginn bekommt eine halbe Stunde
 * Flaeche: als Strich waere er weder zu lesen noch zu treffen. */
export const TIMELINE_MIN_DURATION = 30;

/* Eine Punktmarke (Mahlzeit) hat keine Dauer, aber ihr Typ steht daneben
 * („Abendessen"). Fuer Lage und Reihen nimmt sie anderthalb Stunden ein -
 * so viel Platz braucht ihre Beschriftung bei 1440px -, damit sie nicht unter
 * den naechsten Block der Spur laeuft. Ihr Zustand rechnet weiter mit dem
 * Punkt (`realEnd === start`). */
export const TIMELINE_POINT_SPAN = 90;

/**
 * Der Bereich der Achse in Minuten, auf volle Stunden: mindestens 07-22, und
 * so weit darueber hinaus, wie ein Termin reicht - der Lauf um 6:00 faellt
 * sonst lautlos vom Blatt.
 * @param {{start: number, end: number}[]} items
 * @returns {{start: number, end: number}}
 */
export function timelineRange(items) {
  let start = TIMELINE_MIN_START;
  let end = TIMELINE_MIN_END;
  for (const item of items) {
    start = Math.min(start, Math.floor(item.start / 60) * 60);
    end = Math.max(end, Math.ceil(item.end / 60) * 60);
  }
  return { start: Math.max(0, start), end: Math.min(DAY_END, end) };
}

/**
 * Verteilt die Termine einer Spur auf Reihen, damit sich zwei gleichzeitige
 * nicht ueberdecken: jeder geht in die erste Reihe, deren letzter Termin vor
 * seinem Beginn endet. Schreibt `row` an jeden Eintrag.
 * @param {{start: number, end: number, row?: number}[]} items  nach Beginn sortiert
 * @returns {number} Zahl der Reihen (mindestens 1)
 */
export function packLane(items) {
  const rowEnds = [];
  for (const item of items) {
    let row = rowEnds.findIndex((end) => end <= item.start);
    if (row === -1) {
      row = rowEnds.length;
      rowEnds.push(item.end);
    } else {
      rowEnds[row] = item.end;
    }
    item.row = row;
  }
  return Math.max(1, rowEnds.length);
}

/**
 * Wo ein Termin steht: in der Spur des Haushalts, wenn er niemandem oder allen
 * gehoert, sonst in der Spur jeder zugewiesenen Person (#1828: ein Termin fuer
 * zwei geht beide an). Im Solo-Haushalt gibt es nur die eine Spur.
 * @returns {Array<string|number>} Spur-Schluessel: 'all' oder eine Personen-Id
 */
export function laneKeysFor(peopleIds, memberIds, { solo = false } = {}) {
  if (solo) return ['all'];
  const known = peopleIds.filter((id) => memberIds.includes(id));
  if (!known.length) return ['all'];
  if (memberIds.length >= 2 && memberIds.every((id) => known.includes(id))) return ['all'];
  return known;
}

/**
 * Vorbei, laufend oder kommend. Vorbei heisst: das ECHTE Ende liegt hinter
 * uns, nicht die Mindestflaeche - dieselbe Regel wie `eventHasEnded`, nach der
 * die Liste darunter den Termin verlaesst. Ohne Dauer ist der Beginn das Ende.
 * @returns {'past'|'now'|'next'}
 */
export function timelineState({ start, realEnd }, nowMinute) {
  if (realEnd <= nowMinute) return 'past';
  return start <= nowMinute ? 'now' : 'next';
}

/**
 * Die ganze Leiste.
 * @param {Array<{start: number, end: number, peopleIds?: Array<string|number>}>} items
 *   Minuten des heutigen Tages (0-1440) in der Wanduhr des Haushalts
 * @param {{ nowMinute: number, members?: Array<{id: string|number}>, solo?: boolean }} opts
 *   members in der Reihenfolge, in der die Spuren stehen sollen
 * @returns {null|{
 *   start: number, end: number, hours: number[], now: number|null,
 *   lanes: Array<{key: string|number, member: object|null, rows: number,
 *     items: Array<object & {row: number, left: number, width: number, state: 'past'|'now'|'next'}>}>
 * }}  `left`/`width`/`now` als Anteil 0-1 der Achse; null ohne einen Termin
 */
export function layoutTodayTimeline(items, { nowMinute, members = [], solo = false } = {}) {
  const normalized = items
    .filter((item) => Number.isFinite(item.start))
    .map((item) => {
      const start = Math.max(0, Math.min(DAY_END, item.start));
      const rawEnd = Number.isFinite(item.end) ? Math.min(DAY_END, item.end) : start;
      const end = Math.max(rawEnd, Math.min(DAY_END, start + (item.point ? TIMELINE_POINT_SPAN : TIMELINE_MIN_DURATION)));
      return { ...item, start, end, realEnd: Math.max(start, rawEnd) };
    })
    .sort((a, b) => a.start - b.start || a.end - b.end);
  if (!normalized.length) return null;

  const { start, end } = timelineRange(normalized);
  const span = end - start;
  const memberIds = members.map((member) => member.id);
  const byLane = new Map();
  for (const item of normalized) {
    for (const key of laneKeysFor(item.peopleIds ?? [], memberIds, { solo })) {
      if (!byLane.has(key)) byLane.set(key, []);
      // Je Spur ein eigenes Objekt: dieselbe Reihe gilt nicht in zwei Spuren.
      byLane.get(key).push({ ...item });
    }
  }

  const order = ['all', ...memberIds];
  const lanes = order.filter((key) => byLane.has(key)).map((key) => {
    const laneItems = byLane.get(key);
    const rows = packLane(laneItems);
    return {
      key,
      member: key === 'all' ? null : members.find((member) => member.id === key) ?? null,
      rows,
      items: laneItems.map((item) => ({
        ...item,
        left: (item.start - start) / span,
        width: (item.end - item.start) / span,
        state: timelineState(item, nowMinute),
      })),
    };
  });

  const hours = [];
  for (let minute = start; minute < end; minute += 60) hours.push(minute);
  const now = Number.isFinite(nowMinute) && nowMinute >= start && nowMinute <= end ? (nowMinute - start) / span : null;
  return { start, end, hours, now, lanes };
}
