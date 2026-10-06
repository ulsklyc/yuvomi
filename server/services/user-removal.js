/**
 * Modul: Ein Konto entfernen - deaktivieren oder loeschen (#1381)
 * Zweck: Die eine Entscheidung hinter `DELETE /api/v1/auth/users/:id`. Wer
 *        Spuren in geteilten Daten hinterlassen hat, wird deaktiviert; nur wer
 *        nichts Geteiltes hinterlaesst, wird wirklich geloescht.
 * Abhaengigkeiten: birthdays (die Artefakte eines Mitglieds-Geburtstags)
 *
 * WARUM NICHT EINFACH `DELETE FROM users`. Bis hierher entschieden die
 * Fremdschluessel, was mit allem geschieht, was ein Konto angefasst hat, und
 * fuer geteilte Daten war das zweimal falsch, in entgegengesetzte Richtungen:
 *
 *   - CASCADE auf `created_by`: wer eine Buchung fuer ANDERE eingetragen hatte,
 *     ohne beteiligt zu sein, nahm sie beim Loeschen mit - die Salden der
 *     anderen aenderten sich still. Dasselbe galt fuer Termine, Notizen,
 *     Dokumente und Aufgaben.
 *   - RESTRICT auf den Beteiligten-Spalten der geteilten Ausgaben (und NO
 *     ACTION bei Quick-Links und Outlook-Konten): das Loeschen scheiterte, und
 *     die Route antwortete mit einem nackten 500.
 *
 * WAS EINE SPUR IST. Jede Zeile in einer Fremdschluessel-Spalte auf
 * `users(id)`, die NICHT in `PRIVATE_USER_COLUMNS` steht. Die Spalten kommen
 * zur Laufzeit aus `PRAGMA foreign_key_list`, nicht aus einer zweiten Liste:
 * eine NEUE Spalte gilt damit ohne Zutun als geteilt, und ein vergessener
 * Eintrag kostet hoechstens ein Konto, das stehen bleibt, statt Daten, die
 * verschwinden. Auch SET-NULL-Verweise zaehlen (zugewiesen, erledigt von): der
 * Datensatz bliebe, aber er wuesste nicht mehr, wer es war.
 *
 * EINE ZEILE, DIE OHNEHIN ALS PRIVATE ZEILE DES KONTOS GEHT, IST KEINE SPUR.
 * Traegt eine Tabelle eine private CASCADE-Spalte (`health_fasts.user_id`) und
 * daneben eine weitere (`health_fasts.created_by`), dann zaehlt die zweite nur
 * fuer Zeilen, die NICHT dem Konto selbst gehoeren. Wer seine eigene Messung
 * eingetragen hat, hinterlaesst nichts Geteiltes; wer als Betreuer die Messung
 * eines Kindes eingetragen hat, schon - genau dessen Zeile ginge sonst mit.
 *
 * ALLES IN EINER TRANSAKTION, SYNCHRON. Der Treiber ist synchron, ein `await`
 * waere ein Yield-Punkt zwischen Pruefung und Schreiben. Und die Sitzungen
 * enden IN der Transaktion, nicht danach: `requireAuth` fragt eine Sitzung
 * nicht bei jedem Request nach dem Passwort, also waere ein Konto, das zwar
 * deaktiviert ist, dessen Sitzungen aber noch stehen, bis zu deren Ablauf
 * weiter drin.
 *
 * ZUGANGSMATERIAL IST AUCH, WAS DAS KONTO AUSGESTELLT HAT. Ein API-Token zeigt
 * seinen Klartext genau einmal dem Aussteller, ein Einladungslink und ein
 * Kopplungscode ebenso. Was davon noch gilt, waere ein Weg zurueck fuer
 * jemanden, der gerade entfernt wurde - als ein anderes Konto, als ein neues
 * Konto oder als Wandtablett. Deshalb enden beim Deaktivieren auch die Tokens
 * mit `created_by`, die offenen Einladungen und die offenen Kopplungscodes des
 * Kontos.
 */
import { deleteBirthdayArtifacts } from './birthdays.js';

/**
 * Spalten, die auf `users(id)` zeigen und trotzdem keine Spur in geteilten
 * Daten sind: Zugangsmaterial, die eigene Karteikarte und persoenliche Daten
 * des Kontos selbst. Handgepflegt, mit Absicht - siehe oben, was ein fehlender
 * Eintrag kostet. `npm run test:user-traces-guard` haelt fest, dass jeder
 * Eintrag eine echte Fremdschluessel-Spalte mit CASCADE oder SET NULL ist und
 * dass ein Konto mit je einer Zeile in JEDER dieser Spalten sich loeschen
 * laesst.
 *
 * NICHT HIER, obwohl es naheliegt: `reward_ledger`/`reward_redemptions` (der
 * Punktestand ist ein Haushaltsbuch), `notes.created_by` (eine Notiz kann
 * geteilt sein), `task_assignments`/`event_assignments` (wer zustaendig war,
 * ist Teil des Datensatzes) und alles, was `created_by` heisst.
 */
export const PRIVATE_USER_COLUMNS = new Set([
  // Zugangsmaterial - endet mit dem Konto.
  'api_tokens.subject_user_id',
  'push_subscriptions.user_id',
  'password_resets.user_id',
  'user_totp.user_id',
  'user_recovery_codes.user_id',
  'idempotency_keys.user_id',
  'notification_channels.user_id',
  'family_document_access.user_id',
  'invites.accepted_user_id',
  // Was das Konto zu der Art Zeile macht, die es ist.
  'housekeeping_workers.user_id',
  'split_expense_guest_users.user_id',
  'display_accounts.user_id',
  'display_devices.user_id',
  'display_pairing_codes.user_id',
  'display_pairing_codes.created_by',
  // Die eigene Karteikarte: Kontakt und Geburtstag der Person selbst.
  'contacts.family_user_id',
  'birthdays.family_user_id',
  // Erinnerungen sind Zustellungen AN das Konto, keine Daten des Haushalts.
  'reminders.created_by',
  'reminders.assigned_from',
  // Gesundheit und Zyklus.
  'health_activities.user_id',
  'health_fasting_settings.user_id',
  'health_fasts.user_id',
  'health_lab_reports.user_id',
  'health_nutrition_entries.user_id',
  'health_nutrition_targets.user_id',
  'health_prevention_records.user_id',
  'health_visibility_defaults.user_id',
  'health_vitals.user_id',
  'health_care_grants.caregiver_id',
  'health_care_grants.subject_id',
  'medications.user_id',
  'cycle_day_logs.user_id',
  'cycle_periods.user_id',
  'cycle_reminder_anchors.user_id',
  'cycle_settings.user_id',
  'cycle_settings.notify_partner_user_id',
  // Der eigene Schichtplan und die eigenen Abfuhr-Erinnerungen.
  'schedule_patterns.user_id',
  'schedule_overrides.user_id',
  'schedule_extra_shifts.user_id',
  'schedule_reminder_entries.user_id',
  'waste_reminder_settings.user_id',
  'waste_reminder_entries.user_id',
  // Teilnahme und Einordnung, die nur das Konto selbst betreffen.
  'reward_participants.user_id',
  'note_categories.owner_user_id',
  'expense_group_members.user_id',
]);

/** Die fuenf Abo-Adressen, unter denen ein Konto ohne Anmeldung gelesen wird. */
export const FEED_TOKEN_COLUMNS = [
  'calendar_feed_token',
  'inventory_deadlines_feed_token',
  'cycle_feed_token',
  'schedule_feed_token',
  'waste_feed_token',
];

const IDENT = /^[A-Za-z_][A-Za-z0-9_]*$/;
const columnCache = new WeakMap();

/**
 * Jede Spalte, die per Fremdschluessel auf `users(id)` zeigt.
 *
 * Je Verbindung einmal gelesen: das Schema aendert sich nur durch Migrationen
 * beim Start, und ein Restore tauscht die Verbindung aus.
 *
 * @returns {{ table: string, column: string, onDelete: string, key: string, private: boolean }[]}
 */
export function userReferenceColumns(database) {
  const cached = columnCache.get(database);
  if (cached) return cached;
  const tables = database
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'")
    .all();
  const columns = [];
  for (const { name } of tables) {
    if (!IDENT.test(name)) continue;
    for (const fk of database.prepare(`PRAGMA foreign_key_list("${name}")`).all()) {
      if (fk.table !== 'users' || !IDENT.test(fk.from)) continue;
      const key = `${name}.${fk.from}`;
      columns.push({
        table: name, column: fk.from, onDelete: fk.on_delete, key, private: PRIVATE_USER_COLUMNS.has(key),
      });
    }
  }
  columnCache.set(database, columns);
  return columns;
}

/**
 * Was dieses Konto in geteilten Daten hinterlassen hat.
 *
 * @returns {{ table: string, column: string, rows: number }[]} nur Spalten mit Treffern
 */
export function userTraces(database, userId) {
  const columns = userReferenceColumns(database);
  const traces = [];
  for (const col of columns) {
    if (col.private) continue;
    // Zeilen, die als private Zeile des Kontos ohnehin mitgehen, sind keine Spur.
    const owned = columns
      .filter((other) => other.table === col.table && other.private && other.onDelete === 'CASCADE')
      .map((other) => `COALESCE("${other.column}" = @id, 0)`);
    const notOwned = owned.length ? ` AND NOT (${owned.join(' OR ')})` : '';
    const { rows } = database
      .prepare(`SELECT COUNT(*) AS rows FROM "${col.table}" WHERE "${col.column}" = @id${notOwned}`)
      .get({ id: userId });
    if (rows > 0) traces.push({ table: col.table, column: col.column, rows });
  }
  return traces;
}

/** Eine Absage mit Grund - die Route macht daraus Status, Text und `reason`. */
export class RemovalRefused extends Error {
  constructor(message, reason) {
    super(message);
    this.name = 'RemovalRefused';
    this.reason = reason;
  }
}

/**
 * Beendet JEDE Sitzung dieses Kontos. Die Zeilen tragen die Konto-Id nur im
 * JSON der Sitzung, deshalb der Lauf ueber alle - wie `invalidateUserSessions`
 * in server/auth.js, nur ohne Ausnahme und auf der uebergebenen Verbindung.
 *
 * DREI STELLEN, AN DENEN EINE SITZUNG EIN KONTO NENNT (server/auth.js), nicht
 * nur die angemeldete:
 *   - `userId`: die angemeldete Sitzung;
 *   - `pendingTwoFactor.userId`: das Passwort stimmte, der Code steht aus;
 *   - `oidc.linkUserId`: ein laufender Verknuepfungs-Lauf zum Anbieter.
 * Die beiden halbfertigen fragen beim Einloesen selbst nach (`canSignIn()` in
 * `/2fa/verify` und im Verknuepfungszweig des Callbacks); hier enden sie
 * trotzdem, damit nach dem Entfernen keine Zeile mehr auf das Konto zeigt.
 * Eine Display-Sitzung traegt keine Konto-Id: sie ist eine leere Sitzung fuer
 * den CSRF-Token, das Geraet weist sich mit seinem eigenen Cookie aus.
 */
function endSessions(database, userId) {
  const drop = database.prepare('DELETE FROM sessions WHERE sid = ?');
  for (const row of database.prepare('SELECT sid, sess FROM sessions').all()) {
    let sess = null;
    try { sess = JSON.parse(row.sess); } catch { /* kaputte Zeile: gehoert niemandem */ }
    const owners = [sess?.userId, sess?.pendingTwoFactor?.userId, sess?.oidc?.linkUserId];
    if (owners.includes(userId)) drop.run(row.sid);
  }
}

/** Verweise ohne Fremdschluessel, die auf ein Konto zeigen, das keines mehr ist. */
function clearDefaultAssignee(database, userId) {
  // Standard-Zuweisungen von Sync-Zielen (kein FK auf diesen Spalten, #459).
  database.prepare('UPDATE ics_subscriptions SET default_assignee_user_id = NULL WHERE default_assignee_user_id = ?').run(userId);
  database.prepare('UPDATE external_calendars SET default_assignee_user_id = NULL WHERE default_assignee_user_id = ?').run(userId);
}

/**
 * Offene Kopplungscodes, die das Konto ausgestellt hat, sind verbraucht: den
 * Code sieht nur, wer ihn anfordert, und mit ihm koppelte er noch ein eigenes
 * Geraet als Wandtablett. Verbraucht, wie `issuePairingCode()` einen alten Code
 * entwertet. Gilt fuer BEIDE Ausgaenge - `created_by` ist SET NULL, der Code
 * ueberlebte also auch das Loeschen.
 *
 * SCHON GEKOPPELTE GERAETE BLEIBEN: ihr Geheimnis steht nur im Cookie des
 * Geraets, das den Code eingeloest hat (`POST /displays/pair`), nie in einer
 * Antwort an den Aussteller, und `display_devices` haelt nicht fest, wer
 * gekoppelt hat. Ein Tablett an der Wand zu widerrufen, weil der Mensch geht,
 * der es einst eingerichtet hat, waere der falsche Schluss.
 */
function endPairingCodes(database, userId, now) {
  database.prepare(`
    UPDATE display_pairing_codes SET used_at = ? WHERE created_by = ? AND used_at IS NULL
  `).run(now, userId);
}

function isoNow() {
  return new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');
}

function deactivate(database, userId) {
  const now = isoNow();

  // Die Zeile bleibt, der Zugang nicht. Die Rolle faellt auf `member`: ein
  // Ehemaliger ist kein Administrator, und keine Zaehlung von Administratoren
  // soll sich darauf verlassen muessen, dass sie nach "aktiv" fragt.
  // Der Zeitpunkt des ERSTEN Mals bleibt; die Rolle faellt bei jedem Lauf.
  // Ein schon deaktiviertes Konto geht denselben Weg noch einmal, damit
  // Material, das danach entstand, ebenfalls endet.
  database.prepare(`
    UPDATE users SET deactivated_at = COALESCE(deactivated_at, ?), role = 'member' WHERE id = ?
  `).run(now, userId);

  // ZUGANGSMATERIAL ENDET SOFORT.
  endSessions(database, userId);
  // Tokens, die FUER dieses Konto handeln - und Tokens, die es AUSGESTELLT hat,
  // auch fuer ein anderes Konto. Den Klartext eines Tokens sieht genau einmal
  // der Aussteller (`POST /auth/api-tokens` gibt ihn in der Antwort zurueck):
  // ein ehemaliger Administrator hielte sonst weiter ein gueltiges Geheimnis,
  // das als fremdes Konto handelt. Wer das Token noch braucht, stellt es neu
  // aus. Widerrufen statt geloescht - die Zeile ist die Spur, dass es das
  // Token gab.
  database.prepare(`
    UPDATE api_tokens SET revoked_at = strftime('%Y-%m-%dT%H:%M:%SZ', 'now')
     WHERE revoked_at IS NULL AND (COALESCE(subject_user_id, created_by) = ? OR created_by = ?)
  `).run(userId, userId);
  // Offene Einladungen, die das Konto erstellt hat: den Link kennt der
  // Ersteller, und mit ihm legte sich ein Ehemaliger selbst ein neues Konto an
  // - mit der Rolle, die er in die Einladung geschrieben hat. Widerrufen, wie
  // `inviteService.revoke()` es ausdrueckt; eingeloeste bleiben die Spur, wer
  // wen eingeladen hat.
  database.prepare(`
    UPDATE invites SET revoked_at = ? WHERE created_by = ? AND accepted_at IS NULL AND revoked_at IS NULL
  `).run(now, userId);
  endPairingCodes(database, userId, now);
  database.prepare(`
    UPDATE users SET ${FEED_TOKEN_COLUMNS.map((column) => `${column} = NULL`).join(', ')} WHERE id = ?
  `).run(userId);
  database.prepare('DELETE FROM password_resets WHERE user_id = ?').run(userId);
  database.prepare('DELETE FROM idempotency_keys WHERE user_id = ?').run(userId);
  // Wiederherstellungscodes sind Einmal-Geheimnisse auf Papier, die den zweiten
  // Faktor ERSETZEN. Sie enden; wer je zurueckkaeme, stellt neue aus.
  database.prepare('DELETE FROM user_recovery_codes WHERE user_id = ?').run(userId);
  //
  // WAS BEWUSST STEHEN BLEIBT, UND WARUM ES KEIN WEG HINEIN IST:
  //   - `users.password_hash`: ausgewertet nur in `POST /auth/login` (dahinter
  //     `canSignIn()`) und in `PATCH /auth/me/password` (hinter `requireAuth`).
  //     Den Hash zu ueberschreiben hiesse, ein spaeteres Reaktivieren heute
  //     schon zu entscheiden - das ist offen (#1381).
  //   - `user_totp.secret`: ausgewertet nur in `/auth/2fa/verify` (fragt
  //     `canSignIn()` vor der Pruefung) und in den 2FA-Routen hinter
  //     `requireAuth`. Ohne Sitzung und ohne Wartezustand fragt niemand danach.
  //   - `users.oidc_sub`/`oidc_provider`: muss bleiben. Der SSO-Rueckweg findet
  //     das Konto ueber den `sub` und weist es ab; ohne die Bindung legte er
  //     derselben Person ein NEUES Konto an (`findOrCreateOidcUser`).
  //   - Geraete eines Wandtabletts (`display_devices.token_hash`): siehe
  //     `endPairingCodes()` - das Geheimnis hat nur das Geraet.
  //   - Zugangsdaten des HAUSHALTS zu fremden Diensten (CalDAV/CardDAV, DMS,
  //     Outlook, Rezept-Anbieter, Haushaltskanaele): sie oeffnen nichts in
  //     Yuvomi und gehoeren nicht dem Konto. Das Outlook-Konto verliert unten
  //     seinen Eigentuemer.
  // `npm run test:user-traces-guard` haelt die Liste der Spalten fest, die ein
  // Geheimnis tragen: eine neue ist rot, bis hier steht, was mit ihr geschieht.
  // Wer nicht mehr im Haushalt ist, betreut niemanden mehr. Dass ANDERE dieses
  // Konto betreuen, bleibt: dessen Daten stehen noch, und die Betreuenden sind
  // die, die sie noch lesen koennen.
  database.prepare('DELETE FROM health_care_grants WHERE caregiver_id = ?').run(userId);

  // NICHTS WIRD MEHR ZUGESTELLT.
  database.prepare('DELETE FROM push_subscriptions WHERE user_id = ?').run(userId);
  database.prepare('DELETE FROM notification_channels WHERE user_id = ?').run(userId);
  // Die eigenen, noch nicht ausgeloesten Erinnerungen. Schon zugestellte
  // bleiben als Verlauf; die Zustellung selbst fragt zusaetzlich den
  // Aktiv-Zustand, falls ein Abgleich eine Zeile neu anlegt.
  database.prepare('DELETE FROM reminders WHERE created_by = ? AND pushed_at IS NULL').run(userId);

  // Ein Ehemaliger ist weder Eigentuemer eines synchronisierten Kontos noch
  // der Standard-Zustaendige eines Kalenders.
  database.prepare('UPDATE outlook_accounts SET owner_user_id = NULL WHERE owner_user_id = ?').run(userId);
  clearDefaultAssignee(database, userId);
}

function hardDelete(database, userId) {
  const birthday = database.prepare('SELECT * FROM birthdays WHERE family_user_id = ?').get(userId);
  if (birthday) deleteBirthdayArtifacts(database, birthday);
  clearDefaultAssignee(database, userId);
  // Schichtplan (Migration 189): schedule_patterns→pattern_days, schedule_overrides
  // und schedule_extra_shifts kaskadieren gleich mit weg (FK CASCADE auf user_id),
  // ihre schedule_custom_field_values-Zeilen nicht - polymorph, kein echter
  // Fremdschluessel. Deshalb hier vorab entfernt, solange die Ids noch auffindbar
  // sind, sonst blieben sie als verwaiste Zeilen unter fremder Bedeutung liegen.
  const patternIds = database.prepare('SELECT id FROM schedule_patterns WHERE user_id = ?').all(userId).map((row) => row.id);
  if (patternIds.length) {
    const dayIds = database.prepare(`SELECT id FROM schedule_pattern_days WHERE pattern_id IN (${patternIds.map(() => '?').join(',')})`).all(...patternIds).map((row) => row.id);
    if (dayIds.length) database.prepare(`DELETE FROM schedule_custom_field_values WHERE entry_type='pattern_day' AND entry_id IN (${dayIds.map(() => '?').join(',')})`).run(...dayIds);
  }
  database.prepare(`DELETE FROM schedule_custom_field_values WHERE entry_type='override' AND entry_id IN (SELECT id FROM schedule_overrides WHERE user_id=?)`).run(userId);
  database.prepare(`DELETE FROM schedule_custom_field_values WHERE entry_type='extra_shift' AND entry_id IN (SELECT id FROM schedule_extra_shifts WHERE user_id=?)`).run(userId);
  // Zwei Verweise ohne Fremdschluessel, die bisher als Waisen liegen blieben:
  // die Einstellungen je Konto (`<schluessel>:user:<id>`, routes/preferences.js)
  // und die abweichenden Rechte des Kontos. SQLite vergibt eine Id nicht neu
  // (AUTOINCREMENT), aber eine Rechtezeile ohne Konto ist trotzdem eine Zeile,
  // die niemand mehr sieht und niemand mehr entfernt.
  database.prepare("DELETE FROM sync_config WHERE key LIKE '%:user:' || ?").run(String(userId));
  database.prepare("DELETE FROM access_permissions WHERE subject_type = 'user' AND subject_id = ?").run(String(userId));
  endPairingCodes(database, userId, isoNow());
  endSessions(database, userId);
  database.prepare('DELETE FROM users WHERE id = ?').run(userId);
}

/**
 * Entfernt ein Konto: deaktiviert es, wenn es Spuren in geteilten Daten hat,
 * und loescht es sonst.
 *
 * `refuse` laeuft IN der Transaktion, nach der Entscheidung und vor dem ersten
 * Schreiben: die Regeln, die server/auth.js fuer den letzten Administrator
 * kennt, sehen so denselben Stand wie das Schreiben danach. Es bekommt, was
 * geschehen wuerde, und gibt eine `RemovalRefused` zurueck oder nichts.
 *
 * Ein schon deaktiviertes Konto wird neu beurteilt: sind seine Spuren
 * inzwischen weg, wird es geloescht, sonst bleibt es, wie es ist.
 *
 * @param {import('better-sqlite3-multiple-ciphers').Database} database
 * @param {number} userId
 * @param {{ refuse?: (outcome: 'deactivated'|'deleted') => RemovalRefused|null|undefined }} [options]
 * @returns {{ outcome: 'deactivated'|'deleted'|'not_found', traces: { table: string, column: string, rows: number }[] }}
 * @throws {RemovalRefused}
 */
export function removeUser(database, userId, { refuse } = {}) {
  return database.transaction(() => {
    if (!database.prepare('SELECT 1 FROM users WHERE id = ?').get(userId)) {
      return { outcome: 'not_found', traces: [] };
    }
    const traces = userTraces(database, userId);
    const outcome = traces.length ? 'deactivated' : 'deleted';
    const refusal = refuse?.(outcome);
    if (refusal) throw refusal;
    if (outcome === 'deactivated') deactivate(database, userId);
    else hardDelete(database, userId);
    return { outcome, traces };
  })();
}
