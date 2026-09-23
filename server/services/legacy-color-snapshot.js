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
