/**
 * Modul: Live-Feed (Client)
 * Zweck: Haelt eine EventSource zu einem Versions-Feed des Servers und meldet,
 *        wenn sich die Laufnummer einer Liste bewegt hat. Was sich geaendert
 *        hat, sagt der Feed nicht - die Seite laedt selbst nach, ueber den Weg,
 *        den sie ohnehin hat.
 *
 *        Der Feed spricht drei Ereignisse: `versions` beim Verbinden (alle
 *        Listen), `change` (eine Liste), `ping` (Lebenszeichen). Gemeldet wird
 *        nur, was sich gegen einen SCHON GESEHENEN Stand bewegt: die erste
 *        `versions`-Antwort setzt die Marken, jede spaetere - nach einem
 *        Verbindungsabriss verbindet der Browser von selbst neu - vergleicht
 *        gegen sie. So holt ein Zettel, der eine Weile offline war, genau die
 *        Listen nach, die sich in der Zwischenzeit bewegt haben.
 *
 *        `isLive()` sagt der Seite, ob der Strom traegt. Ein Proxy, der
 *        Antworten puffert, laesst die Verbindung OFFEN aussehen, obwohl nie
 *        ein Ereignis ankommt - deshalb zaehlt nicht der readyState, sondern
 *        wann zuletzt etwas gehoert wurde. Der Server pingt alle 25 s; nach
 *        `staleAfterMs` ohne Lebenszeichen gilt der Strom als tot, und die
 *        Seite faellt auf ihren langsamen Takt zurueck.
 * Abhaengigkeiten: keine
 */

/**
 * @param {object} opts
 * @param {string} opts.url                  Feed-URL
 * @param {AbortSignal} [opts.signal]        schliesst den Strom (Seite verlassen)
 * @param {(listId: number) => void} opts.onChange  eine gesehene Liste hat sich bewegt
 * @param {typeof EventSource} [opts.EventSourceImpl]  fuer Tests
 * @param {() => number} [opts.now]          fuer Tests
 * @param {number} [opts.staleAfterMs]       ohne Lebenszeichen gilt der Strom als tot
 * @returns {{ isLive: () => boolean, close: () => void }}
 */
export function connectLiveFeed({
  url,
  signal = null,
  onChange,
  EventSourceImpl = globalThis.EventSource,
  now = Date.now,
  staleAfterMs = 60_000,
}) {
  const dead = { isLive: () => false, close() {} };
  if (typeof EventSourceImpl !== 'function' || signal?.aborted) return dead;

  /** Zuletzt gesehene Laufnummer je Liste. */
  const seen = new Map();
  let lastHeardAt = now();
  let source = new EventSourceImpl(url);

  const heard = () => { lastHeardAt = now(); };
  const parse = (evt) => {
    try { return JSON.parse(evt.data); } catch { return null; }
  };
  const note = (listId, version) => {
    if (!Number.isInteger(listId)) return;
    const before = seen.get(listId);
    seen.set(listId, version);
    if (before !== undefined && before !== version) onChange(listId);
  };

  source.addEventListener('open', heard);
  source.addEventListener('ping', heard);
  source.addEventListener('versions', (evt) => {
    heard();
    for (const entry of parse(evt)?.lists ?? []) note(entry.listId, entry.version);
  });
  source.addEventListener('change', (evt) => {
    heard();
    const change = parse(evt);
    if (change) note(change.listId, change.version);
  });

  const close = () => {
    source?.close();
    source = null;
  };
  signal?.addEventListener('abort', close, { once: true });

  return {
    // 1 = EventSource.OPEN; die Konstante selbst fehlt einer Test-Attrappe.
    isLive: () => source !== null && source.readyState === 1 && (now() - lastHeardAt) < staleAfterMs,
    close,
  };
}
