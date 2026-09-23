// --------------------------------------------------------
// Schnappschuss der Farb-Heilung (#1270), geteilt von CalDAV-Sync und
// Kalender-Route.
//
// Die Heilung nimmt eine eingebrannte Kalenderfarbe nur, solange ein Termin
// genau die Farbe traegt, die er bei Fristbeginn trug (Schnappschuss je Konto
// in sync_config). Waehlt jemand in Yuvomi eine Farbe, ist der Termin von da
// an keine Altlast mehr - auch wenn er spaeter wieder die alte Farbe bekommt.
// Deshalb faellt er bei jeder lokalen Umfaerbung aus dem Schnappschuss, und
// zwar an der Route selbst: dort kommt jede lokale Farbwahl an, auch eine,
// die nie hinausgeht (etwa ohne erreichbaren Ausgang).
// --------------------------------------------------------

const SNAPSHOT_PREFIX = 'caldav_legacy_color_heal_snapshot_';

/** sync_config-Schluessel des Schnappschusses je Konto. */
export function legacyColorSnapshotKey(accountId) {
  return `${SNAPSHOT_PREFIX}${accountId}`;
}

/**
 * Nimmt Termine aus JEDEM Schnappschuss (welches Konto einen Termin sieht,
 * steht an der Zeile nicht). Liest den Stand zum Zeitpunkt des Schreibens,
 * damit ein laufender Sync keine Entfernung der Route ueberschreibt. Ein
 * unlesbarer Schnappschuss bleibt, wie er ist: er heilt ohnehin nichts.
 *
 * @param {object} conn  Datenbank-Handle
 * @param {Iterable<number>} eventIds
 */
export function forgetLegacyColorSnapshot(conn, eventIds) {
  const ids = [...eventIds].map(String);
  if (!ids.length) return;
  const rows = conn.prepare('SELECT key, value FROM sync_config WHERE key LIKE ?').all(`${SNAPSHOT_PREFIX}%`);
  const write = conn.prepare('UPDATE sync_config SET value = ? WHERE key = ?');
  for (const row of rows) {
    let snapshot;
    try { snapshot = JSON.parse(row.value); } catch { continue; }
    if (!snapshot || typeof snapshot !== 'object' || Array.isArray(snapshot)) continue;
    let changed = false;
    for (const id of ids) {
      if (Object.hasOwn(snapshot, id)) { delete snapshot[id]; changed = true; }
    }
    if (changed) write.run(JSON.stringify(snapshot), row.key);
  }
}

/**
 * Lokal gewaehlte Farben, die ein SPAETER angelegter Schnappschuss nicht
 * aufnehmen darf. Ein Konto legt ihn erst bei seinem ersten Heil-Lauf an:
 * nach dem Serverstart 10 Sekunden, fuer ein neu angelegtes, umgehaengtes
 * oder bisher ohne aktivierte Kalender laufendes Konto aber erst beim
 * naechsten Takt (Standard 15 Minuten) oder spaeter. Eine Farbwahl in dieser
 * Luecke stuende sonst als Altlast im Schnappschuss.
 */
const CHOSEN_KEY = 'caldav_legacy_color_heal_chosen';

/**
 * Die Event-IDs mit lokaler Farbwahl, oder null, wenn der Eintrag unlesbar ist
 * - dann nimmt ein neuer Schnappschuss gar nichts auf (fail closed).
 */
export function legacyColorChosenIds(conn) {
  const raw = conn.prepare('SELECT value FROM sync_config WHERE key = ?').get(CHOSEN_KEY)?.value;
  if (raw == null) return new Set();
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? new Set(parsed.map(Number)) : null;
  } catch { return null; }
}

/**
 * Eine lokale Farbwahl an einem gespiegelten CalDAV-Termin: raus aus jedem
 * bestehenden Schnappschuss, und vorgemerkt fuer jeden, der noch entsteht.
 * Die Vormerkliste behaelt nur Termine, die es noch gibt.
 *
 * @param {object} conn
 * @param {Iterable<number>} eventIds
 */
export function recordLocalColorChoice(conn, eventIds) {
  const ids = [...eventIds].map(Number);
  if (!ids.length) return;
  forgetLegacyColorSnapshot(conn, ids);
  const known = legacyColorChosenIds(conn) ?? new Set();
  for (const id of ids) known.add(id);
  const existing = new Set(conn.prepare('SELECT id FROM calendar_events WHERE id IN (SELECT value FROM json_each(?))')
    .all(JSON.stringify([...known])).map((r) => r.id));
  conn.prepare('INSERT INTO sync_config (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
    .run(CHOSEN_KEY, JSON.stringify([...known].filter((id) => existing.has(id))));
}
