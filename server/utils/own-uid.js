// --------------------------------------------------------
// UIDs der Objekte, die Yuvomi selbst auf einem CalDAV-Server anlegt.
//
// EINE Quelle für Erzeugen und Erkennen. Vorher stand das Muster an sechs
// Stellen von Hand (zwei Upload-Wege, zwei ICS-Builder, eine SQL-Bedingung,
// ein LIKE), und es trug nur die Zeilen-Id:
//
//   yuvomi-task-<id>@yuvomi.local   Aufgabe
//   yuvomi-item-<id>@yuvomi.local   Einkaufsartikel
//   oikos-<id>@oikos.local          Termin (CalDAV und iCloud)
//
// Eine Zeilen-Id ist aber nur in EINER Datenbank eindeutig. Eine zweite
// Installation gegen dasselbe Konto oder eine neu aufgesetzte, deren Ids wieder
// bei 1 beginnen, erzeugt denselben Namen für einen anderen Eintrag. Deshalb
// liess sich die eine Frage nicht beantworten, auf die der Upload eine Antwort
// braucht: der Server meldet 412, "an dieser Adresse liegt schon etwas" - ist
// das unser eigener früherer Upload, dessen Antwort verloren ging, oder ein
// fremdes Objekt?
//
// Neue Uploads tragen deshalb zusätzlich eine Kennung DIESER Installation:
//
//   yuvomi-<art>-<id>-<installation>@yuvomi.local
//
// Die UID bleibt je Zeile fest (kein Zufall je Versuch), also überschreibt eine
// Wiederholung weiterhin, statt zu verdoppeln. Und ein 412 heisst jetzt
// eindeutig "das ist unseres".
//
// BESTAND BLEIBT: eine schon gespiegelte Zeile behält die UID, unter der sie
// auf dem Server liegt. Nichts wird umbenannt. Wo ERKANNT wird ("hat Yuvomi
// das hochgeladen?"), gelten beide Muster. Wo ÜBERNOMMEN wird ("das ist der
// Upload dieser lokalen Zeile"), gilt nur das neue Muster mit der eigenen
// Kennung - eine alte UID kann von einer früheren Installation stammen.
//
// Ohne Import von db.js: die Verbindung wird übergeben, damit kein Helfer hier
// beim Laden die Datenbank anfasst.
// --------------------------------------------------------

import { randomBytes } from 'node:crypto';

const CONFIG_KEY = 'installation_id';
const DOMAIN     = 'yuvomi.local';

/** Art → Präfix des alten Musters und dessen Domain. */
const LEGACY = {
  task:  { prefix: 'yuvomi-task-', domain: 'yuvomi.local' },
  item:  { prefix: 'yuvomi-item-', domain: 'yuvomi.local' },
  event: { prefix: 'oikos-',       domain: 'oikos.local' },
};
const KINDS = Object.keys(LEGACY);

const CURRENT_RE = new RegExp(`^yuvomi-(${KINDS.join('|')})-(\\d+)-([0-9a-f]{16})@yuvomi\\.local$`);
const LEGACY_RES = KINDS.map((kind) => [
  kind,
  new RegExp(`^${LEGACY[kind].prefix}(\\d+)@${LEGACY[kind].domain.replace('.', '\\.')}$`),
]);

function assertKind(kind) {
  if (!LEGACY[kind]) throw new Error(`own-uid: unknown kind "${kind}".`);
}

/**
 * Kennung dieser Installation: einmal zufällig erzeugt, dann für immer dieselbe.
 * Sie liegt in `sync_config` und reist mit der Datenbank - dieselbe Datenbank
 * ist dieselbe Installation, auch nach Backup und Wiederherstellung.
 *
 * Synchron, wie jeder DB-Zugriff hier: `INSERT OR IGNORE` und das Lesen danach
 * lassen zwei gleichzeitige Erstaufrufe bei demselben Wert ankommen.
 *
 * @param {object} database  offene Verbindung (`db.get()`)
 */
export function installationId(database) {
  const read = () => database.prepare('SELECT value FROM sync_config WHERE key = ?').get(CONFIG_KEY)?.value;
  const known = read();
  if (known) return known;
  database.prepare('INSERT OR IGNORE INTO sync_config (key, value) VALUES (?, ?)')
    .run(CONFIG_KEY, randomBytes(8).toString('hex'));
  return read();
}

/** UID, unter der diese Installation die Zeile hochlädt. */
export function ownUid(kind, id, database) {
  assertKind(kind);
  return `yuvomi-${kind}-${id}-${installationId(database)}@${DOMAIN}`;
}

/** UID nach dem alten Muster - nur noch zum Erkennen und für Tests. */
export function legacyOwnUid(kind, id) {
  assertKind(kind);
  return `${LEGACY[kind].prefix}${id}@${LEGACY[kind].domain}`;
}

/**
 * Zerlegt eine von Yuvomi vergebene UID.
 * @returns {{kind: string, id: number, installation: string|null}|null}
 *          `installation: null` heisst altes Muster
 */
export function parseOwnUid(uid) {
  const text = String(uid ?? '');
  const current = CURRENT_RE.exec(text);
  if (current) return { kind: current[1], id: Number(current[2]), installation: current[3] };
  for (const [kind, re] of LEGACY_RES) {
    const match = re.exec(text);
    if (match) return { kind, id: Number(match[1]), installation: null };
  }
  return null;
}

/**
 * Hat Yuvomi diese Zeile selbst hochgeladen? Erkennen, nicht Übernehmen: beide
 * Muster gelten, jede Installationskennung.
 */
export function isOwnUidOfRow(uid, kind, id) {
  const parsed = parseOwnUid(uid);
  return !!parsed && parsed.kind === kind && parsed.id === Number(id);
}

/**
 * Zeilen-Id, deren Upload dieses Objekt ist - oder null. Übernehmen: nur das
 * neue Muster mit der Kennung DIESER Installation.
 */
export function ownUploadRowId(uid, kind, database) {
  const parsed = parseOwnUid(uid);
  if (!parsed || parsed.kind !== kind || parsed.installation === null) return null;
  return parsed.installation === installationId(database) ? parsed.id : null;
}

/**
 * SQL: trägt `column` eine UID, unter der Yuvomi die Zeile `idColumn` selbst
 * als Termin hochgeladen hat? Beide Muster.
 */
export function sqlIsOwnEventUidOfRow(column, idColumn) {
  const legacy = LEGACY.event;
  return `(COALESCE(${column}, '') = ('${legacy.prefix}' || ${idColumn} || '@${legacy.domain}')
        OR COALESCE(${column}, '') LIKE ('yuvomi-event-' || ${idColumn} || '-%@${DOMAIN}'))`;
}

/**
 * SQL: sieht `column` nach einem von Yuvomi hochgeladenen Termin aus, gleich
 * welcher Zeile? Ein `::`-Suffix für Einzelvorkommen darf folgen. `_` ist in
 * LIKE ein Platzhalter; in den Mustern steht keiner.
 */
export function sqlLooksLikeOwnEventUid(column) {
  const legacy = LEGACY.event;
  return `(${column} LIKE '${legacy.prefix}%@${legacy.domain}%'
        OR ${column} LIKE 'yuvomi-event-%@${DOMAIN}%')`;
}

/**
 * Liegt an dieser Adresse ein Objekt mit dieser UID? Die Antwort auf ein 412
 * beim Anlegen: der Name ist vergeben - von uns?
 *
 * Geprüft wird die UID im Objekt, nicht nur die Adresse: der Dateiname ist
 * Konvention, die UID ist die Identität.
 *
 * @returns {Promise<{url: string, etag: string|undefined, data: string}|null>}
 */
export async function findObjectWithUid(client, collectionUrl, objectUrl, uid) {
  const objects = await client.fetchCalendarObjects({
    calendar:   { url: collectionUrl },
    objectUrls: [objectUrl],
  });
  for (const obj of objects || []) {
    const lines = String(obj?.data ?? '').replace(/\r\n/g, '\n').replace(/\n[ \t]/g, '').split('\n');
    if (lines.some((line) => line.trim() === `UID:${uid}`)) {
      return { url: obj.url || objectUrl, etag: obj.etag, data: obj.data };
    }
  }
  return null;
}
