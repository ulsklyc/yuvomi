// --------------------------------------------------------
// Ein Durchgang je Provider, nie zwei gleichzeitig (#593).
//
// Ausgehende Kalenderarbeit wird zweifach angestoßen: vom Sofortversuch hinter
// jeder Schreibroute (flushOutbound) und vom Sync-Lauf des Schedulers. Beide
// laufen über Netzaufrufe, also über awaits, und beide führen dieselbe
// Buchhaltung - Tombstones in calendar_pending_deletions, outbound_dirty und
// outbound_move_to an der Terminzeile. Ohne Serialisierung lesen sie einander
// den Zustand unter den Füßen weg:
//
//   - Ein zweiter Flush räumt den Tombstone der Quelle ab, während ein Umzug
//     noch zwischen createCalendarObject und deleteCalendarObject hängt. Der
//     Umzug findet ihn danach nicht mehr, die Kopie im Ziel bleibt stehen und
//     der nächste Inbound-Lauf importiert den gelöschten Termin neu.
//   - Ein Sync-Inbound importiert die gerade angelegte Kopie im Ziel, während
//     derselbe Umzug noch auf das DELETE in der Quelle wartet.
//
// Einzelne Wachen an den betroffenen Stellen schließen jeweils einen dieser
// Fälle und bauen den nächsten ein (vier Reviewrunden an PR #1127). Diese Datei
// ersetzt sie durch eine Regel, die sich in einem Satz sagen lässt.
//
// Der Schlüssel ist die PROVIDER-DOMÄNE, nicht das Konto: ein Sync-Lauf
// arbeitet alle Konten in einer Schleife ab, ein Flush bündelt nach Konto.
// Feiner zu sperren hieße, dass ein Lauf mehrere Schlüssel gleichzeitig hält -
// der Weg in eine Verklemmung, für eine Gleichzeitigkeit, die ein Haushalt mit
// ein bis zwei Konten nicht hat.
//
// Die Sperre ist prozesslokal, und genau das ist ihre Voraussetzung: Yuvomi läuft
// als ein Prozess (ein Container, kein cluster, SQLite auf einem lokalen Volume).
// Würde je eine zweite Instanz gegen dieselbe Datenbank zugesagt, hielte diese
// Datei lautlos nichts mehr - dann braucht es ein Lease in der Datenbank.
// --------------------------------------------------------

// Schlüssel → { busy, queue, pending }
//   queue    FIFO der wartenden Durchgänge
//   pending  je Art HÖCHSTENS ein vorgemerkter Nachlauf: während eines Laufs
//            treffen bei drei Bearbeitungen drei Sofortversuche ein, und alle
//            drei wollen dasselbe - einmal nacharbeiten, was danach aussteht.
const locks = new Map();

function lockFor(key) {
  let lock = locks.get(key);
  if (!lock) {
    lock = { key, busy: false, queue: [], pending: new Map() };
    locks.set(key, lock);
  }
  return lock;
}

function entryPromise(entry) {
  return new Promise((resolve, reject) => entry.waiters.push({ resolve, reject }));
}

async function drain(lock) {
  lock.busy = true;
  while (lock.queue.length) {
    const entry = lock.queue.shift();
    // Die Vormerkung gilt nur, solange der Nachlauf noch NICHT begonnen hat. Ein
    // Sofortversuch, der während seines Laufs eintrifft, meint Arbeit, die
    // dieser Lauf schon gelesen haben kann, und braucht deshalb einen eigenen.
    if (lock.pending.get(entry.kind) === entry) lock.pending.delete(entry.kind);
    try {
      const value = await entry.run();
      for (const w of entry.waiters) w.resolve(value);
    } catch (err) {
      for (const w of entry.waiters) w.reject(err);
    }
  }
  lock.busy = false;
  if (!lock.queue.length && lock.pending.size === 0) locks.delete(lock.key);
}

/**
 * Führt `run` aus, sobald unter `key` nichts mehr läuft.
 *
 * Ist der Schlüssel frei, läuft `run` sofort. Ist er belegt, wartet der Aufrufer
 * auf einen Nachlauf - und zwar auf denselben wie jeder weitere Aufrufer
 * derselben `kind`, statt eine Schlange zu bilden, die bei einem langsamen
 * Server mit jeder Bearbeitung wächst. Erst das macht die Sperre für den
 * Sofortversuch brauchbar: hinter jeder Schreibroute steht einer, und hundert
 * Bearbeitungen während eines Laufs ergeben einen Nachlauf, nicht hundert.
 *
 * Getrennte Vormerkung je `kind`, weil die Ergebnisse verschieden sind: der
 * Aufrufer eines Syncs (der Knopf "Jetzt synchronisieren") bekäme sonst das
 * Ergebnis eines Sofortversuchs.
 *
 * Der Fehler eines Laufs geht an alle seine Wartenden und gibt den Schlüssel
 * frei; ein gescheiterter Durchgang darf den Provider nicht dauerhaft sperren.
 *
 * @param {string}   key   Provider-Domäne ('caldav', 'apple', 'google', ...)
 * @param {string}   kind  Art des Durchgangs ('sync' | 'flush')
 * @param {Function} run   der Durchgang selbst
 * @returns {Promise<*>} was `run` zurückgibt
 */
export function runSerialized(key, kind, run) {
  const lock = lockFor(key);

  if (!lock.busy && lock.queue.length === 0) {
    const entry = { kind, run, waiters: [] };
    const promise = entryPromise(entry);
    lock.queue.push(entry);
    drain(lock);
    return promise;
  }

  const waiting = lock.pending.get(kind);
  if (waiting) return entryPromise(waiting);

  const entry = { kind, run, waiters: [] };
  lock.pending.set(kind, entry);
  lock.queue.push(entry);
  return entryPromise(entry);
}

// Nur für Tests: eine Suite darf nicht die Sperren der vorigen erben.
export const __test = {
  reset: () => locks.clear(),
  size: () => locks.size,
};
