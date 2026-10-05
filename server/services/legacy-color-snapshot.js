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
const SINCE_PREFIX = 'caldav_legacy_color_heal_since_';

/** sync_config-Schluessel des Schnappschusses je Konto. */
export function legacyColorSnapshotKey(accountId) {
  return `${SNAPSHOT_PREFIX}${accountId}`;
}

/** So lange laeuft die Farb-Heilung (#1270) je Konto, ab seinem ersten Lauf. */
export const LEGACY_HEAL_DAYS = 30;

/**
 * sync_config-Schluessel der Farb-Heilung je Konto (#1270). Wert: der Beginn
 * der Frist als ISO-Zeitstempel, oder `never` fuer ein Konto, das nichts zu
 * heilen hat. Fehlt er, beginnt die Frist mit dem naechsten Lauf - deshalb
 * bleibt er auch nach dem Ende der Frist stehen.
 */
export function legacyColorHealKey(accountId) {
  return `${SINCE_PREFIX}${accountId}`;
}

/**
 * Ist die Frist mit diesem Wert des Fristbeginns vorbei (#1442)? Ja fuer
 * `never` und jeden anderen Wert, der kein Datum ist, und fuer einen Beginn vor
 * mehr als LEGACY_HEAL_DAYS Tagen. Ein Beginn in der Zukunft (die Uhr ging beim
 * Start vor) ist nicht vorbei: die Frist laeuft, sobald die Uhr ihn erreicht.
 */
export function legacyColorHealEnded(value, now = new Date()) {
  const since = Date.parse(value);
  return !(Number.isFinite(since) && now.getTime() - since < LEGACY_HEAL_DAYS * 24 * 60 * 60 * 1000);
}

/** Migration, mit der #891 den Import aufhoeren liess, Kalenderfarben einzubrennen. */
const LEGACY_COLOR_FIX_MIGRATION = 166;

/**
 * Wann diese Installation den Fix aus #891 bekam (`applied_at` von Migration
 * 166), oder null ohne `schema_migrations` - das gibt es nur in gekuerzten
 * Test-Fixtures, nie nach `migrate()`. Aeltere Zeilen koennen eine
 * eingebrannte Farbe tragen, juengere nicht (#1270).
 */
export function legacyColorCutoff(conn) {
  const hasTable = conn.prepare(
    "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'schema_migrations'"
  ).get();
  if (!hasTable) return null;
  return conn.prepare('SELECT applied_at FROM schema_migrations WHERE version = ?')
    .get(LEGACY_COLOR_FIX_MIGRATION)?.applied_at ?? null;
}

/**
 * Nimmt Termine aus JEDEM Schnappschuss (welches Konto einen Termin sieht,
 * steht an der Zeile nicht). Liest den Stand zum Zeitpunkt des Schreibens,
 * damit ein laufender Sync keine Entfernung der Route ueberschreibt. Ein
 * unlesbarer Schnappschuss bleibt, wie er ist: er heilt ohnehin nichts.
 *
 * Der Schnappschuss eines Kontos, dessen Frist vorbei ist, faellt dabei ganz
 * weg (#1442): aus ihm heilt nichts mehr, und sonst laese und schriebe jede
 * lokale Umfaerbung ihn weiter. Der Fristbeginn bleibt stehen.
 *
 * @param {object} conn  Datenbank-Handle
 * @param {Iterable<number>} eventIds
 */
export function forgetLegacyColorSnapshot(conn, eventIds, { now = new Date() } = {}) {
  const ids = [...eventIds].map(String);
  if (!ids.length) return;
  const rows = conn.prepare(`
    SELECT s.key, s.value, h.value AS since FROM sync_config s
    LEFT JOIN sync_config h ON h.key = ? || substr(s.key, ?)
    WHERE s.key LIKE ?
  `).all(SINCE_PREFIX, SNAPSHOT_PREFIX.length + 1, `${SNAPSHOT_PREFIX}%`);
  const write = conn.prepare('UPDATE sync_config SET value = ? WHERE key = ?');
  const drop = conn.prepare('DELETE FROM sync_config WHERE key = ?');
  for (const row of rows) {
    // Ohne Fristbeginn ist nicht zu sagen, ob die Frist vorbei ist: bleibt.
    if (row.since != null && legacyColorHealEnded(row.since, now)) { drop.run(row.key); continue; }
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
 * Die IDs unter `ids`, die ein Schnappschuss ueberhaupt aufnehmen koennte: es
 * gibt sie noch, sie sind gespiegelt und aelter als der Fix. Dieselbe
 * Altersgrenze wie in `legacyCandidateRows` (caldav-sync.js).
 */
function legacyRowIds(conn, ids) {
  const cutoff = legacyColorCutoff(conn);
  return new Set(conn.prepare(`
    SELECT id FROM calendar_events
    WHERE id IN (SELECT value FROM json_each(?)) AND external_source = 'caldav'
      AND (? IS NULL OR datetime(created_at) <= datetime(?))
  `).all(JSON.stringify([...ids]), cutoff, cutoff).map((r) => r.id));
}

/**
 * Eine lokale Farbwahl an einem gespiegelten CalDAV-Termin: raus aus jedem
 * bestehenden Schnappschuss, und vorgemerkt fuer jeden, der noch entsteht.
 *
 * VORGEMERKT WERDEN NUR ALTZEILEN (#1442). Ein Schnappschuss nimmt nur Zeilen
 * von vor dem Fix auf; eine juengere auf der Liste liess sie nur wachsen, und
 * jede Umfaerbung laese und schriebe sie ganz neu. So bleibt die Liste durch
 * die Zeilen von vor dem Fix begrenzt, und eine Umfaerbung an einer juengeren
 * Zeile fasst sie gar nicht an.
 *
 * Geleert wird sie nicht, auch wenn gerade keine Frist laeuft oder aussteht:
 * ein spaeter angelegtes oder umgehaengtes Konto kann noch eine Frist beginnen
 * (`decideLegacyHeal`, solange verwaiste Altzeilen da sind), und eine Wahl
 * davor stuende sonst als Altlast in seinem Schnappschuss.
 *
 * Die Liste behaelt nur Altzeilen, die es noch gibt; das raeumt auch
 * Eintraege von vor #1442 ab.
 *
 * @param {object} conn
 * @param {Iterable<number>} eventIds
 */
export function recordLocalColorChoice(conn, eventIds) {
  const ids = [...eventIds].map(Number);
  if (!ids.length) return;
  forgetLegacyColorSnapshot(conn, ids);
  if (!legacyRowIds(conn, ids).size) return;
  const known = legacyColorChosenIds(conn) ?? new Set();
  for (const id of ids) known.add(id);
  const keep = legacyRowIds(conn, known);
  conn.prepare('INSERT INTO sync_config (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
    .run(CHOSEN_KEY, JSON.stringify([...known].filter((id) => keep.has(id))));
}
