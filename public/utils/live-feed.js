/**
 * Modul: Live-Feed (Client)
 * Zweck: Fragt die Laufnummern der Einkaufslisten im Takt ab und meldet, wenn
 *        sich eine bewegt hat. Was sich geaendert hat, sagt die Nummer nicht -
 *        die Seite laedt selbst nach, ueber den Weg, den sie ohnehin hat.
 *
 *        Gemeldet wird nur, was sich gegen einen SCHON GESEHENEN Stand bewegt:
 *        die erste Antwort setzt die Marken, jede spaetere vergleicht gegen
 *        sie. Drei Bewegungen zaehlen - eine Nummer ist gestiegen, eine Liste
 *        ist neu, eine Liste ist weg. Was der Server dabei nie sieht: die
 *        Seite selbst schreibt ja auch. `acknowledge()` nimmt die Quittung
 *        eines eigenen Schreibvorgangs (`list_change: { list_id, before,
 *        after }`) entgegen und rueckt die Marke vor, wenn `before` der eigene
 *        Stand war - dann ist alles bis `after` das eigene Werk, und die
 *        naechste Abfrage laedt nicht umsonst nach. Stimmt `before` nicht,
 *        hat jemand anderes dazwischen geschrieben, und die Marke bleibt
 *        stehen: die naechste Abfrage sieht die Bewegung und laedt.
 *
 *        Eine Antwort, die eine KLEINERE Nummer traegt als die Marke, ist eine
 *        ueberholte - sie war unterwegs, als die Quittung die Marke vorrueckte.
 *        Sie bewegt nichts. Nummern steigen nur.
 *
 *        Bewusst eine Abfrage im Takt und kein offener Strom: eine Anfrage,
 *        die endet, braucht keinen Proxy, der Stroeme durchlaesst, belegt
 *        keine der wenigen Verbindungen je Origin und laesst sich spaeter
 *        durch einen Strom auf demselben Zaehler ersetzen, ohne dass ein
 *        Vertrag bricht. Der Takt laeuft nur, solange `isHidden()` nein sagt;
 *        ein verborgener Tab fragt nicht.
 * Abhaengigkeiten: keine
 */

/**
 * @param {object} opts
 * @param {() => Promise<Array<{ list_id: number, version: number }>>} opts.fetchVersions
 * @param {(listId: number) => void} opts.onChange   eine gesehene Liste hat sich bewegt, ist neu oder weg
 * @param {AbortSignal} [opts.signal]                beendet den Takt (Seite verlassen)
 * @param {number} [opts.intervalMs]                 Takt, solange sichtbar
 * @param {() => boolean} [opts.isHidden]            verborgener Tab: der Takt schweigt
 * @param {(fn: () => void, ms: number) => any} [opts.setInterval]   fuer Tests
 * @param {(id: any) => void} [opts.clearInterval]                    fuer Tests
 * @returns {{ poll: () => Promise<void>, acknowledge: (change: any) => void, stop: () => void }}
 */
export function startLiveFeed({
  fetchVersions,
  onChange,
  signal = null,
  intervalMs = 10_000,
  isHidden = () => (typeof document !== 'undefined' ? document.hidden : false),
  setInterval: schedule = globalThis.setInterval,
  clearInterval: unschedule = globalThis.clearInterval,
}) {
  /** Zuletzt gesehene Laufnummer je Liste; null bis zur ersten Antwort. */
  let seen = null;
  let inFlight = null;
  let stopped = signal?.aborted ?? false;

  const apply = (rows) => {
    // Keine Liste ist eine Antwort ("es gibt keine Listen mehr"); etwas, das
    // gar keine Liste ist, ist keine - und bewegt nichts.
    if (!Array.isArray(rows)) return;
    const fresh = new Map();
    for (const row of rows) {
      if (Number.isInteger(row?.list_id) && Number.isInteger(row?.version)) fresh.set(row.list_id, row.version);
    }
    if (!seen) {
      seen = fresh;
      return;
    }
    const moved = new Set();
    for (const [listId, version] of fresh) {
      const before = seen.get(listId);
      if (before === undefined) moved.add(listId);            // neue Liste
      else if (version > before) moved.add(listId);           // bewegt
      else if (version < before) fresh.set(listId, before);   // ueberholte Antwort: die Marke bleibt
    }
    for (const listId of seen.keys()) {
      if (!fresh.has(listId)) moved.add(listId);              // Liste weg
    }
    seen = fresh;
    for (const listId of moved) onChange(listId);
  };

  const poll = () => {
    if (stopped) return Promise.resolve();
    if (inFlight) return inFlight;
    inFlight = Promise.resolve()
      .then(fetchVersions)
      .then((rows) => { if (!stopped) apply(rows); })
      .catch(() => { /* still: die naechste Abfrage versucht es wieder */ })
      .finally(() => { inFlight = null; });
    return inFlight;
  };

  const acknowledge = (change) => {
    if (!seen || !change) return;
    const { list_id: listId, before, after } = change;
    if (!Number.isInteger(listId) || !Number.isInteger(after)) return;
    if (seen.get(listId) === before) seen.set(listId, after);
  };

  const timer = stopped ? null : schedule(() => { if (!isHidden()) poll(); }, intervalMs);
  const stop = () => {
    stopped = true;
    if (timer != null) unschedule(timer);
  };
  signal?.addEventListener('abort', stop, { once: true });

  return { poll, acknowledge, stop };
}
