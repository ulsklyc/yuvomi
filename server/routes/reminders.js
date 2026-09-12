/**
 * Modul: Erinnerungen (Reminders)
 * Zweck: REST-API für Erinnerungen an Aufgaben und Kalender-Events
 * Abhängigkeiten: express, server/db.js
 */

import { createLogger } from '../logger.js';
import express from 'express';
import * as db from '../db.js';
import * as v from '../middleware/validate.js';
import { syncAllBirthdayReminders } from '../services/birthdays.js';
import { fanOutEventReminders, eventAuthorId } from '../services/event-reminder-fanout.js';
import { deniedModules } from '../permissions.js';
import { tokenAllows } from '../scopes.js';

const log    = createLogger('Reminders');
const router = express.Router();

const VALID_ENTITY_TYPES = ['task', 'event', 'subscription', 'inventory_item', 'inventory_tracked_date', 'pantry_item', 'cycle_period', 'cycle_log_nudge', 'schedule_entry', 'schedule_extra_entry', 'waste_pickup'];

/**
 * Nach jedem Schreibvorgang an den Erinnerungen eines Termins: die Zugewiesenen
 * nachziehen (#921).
 *
 * EINE ZEILE HINTER JEDEM DER VIER WEGE, weil die Regel dieselbe ist. Setzen,
 * Ersetzen, einzeln Loeschen und Alles-Loeschen enden alle hier, und
 * `fanOutEventReminders` liest die Vorlage jedes Mal frisch: nach einem
 * Loeschen ist sie leer, und dann raeumt derselbe Aufruf die geerbten Zeilen
 * ab, statt Meldungen stehen zu lassen, die der Ersteller gerade abgeschafft
 * hat. Verteilt wird nur, wenn der Aufrufer den Termin ANGELEGT hat - wer sich
 * sonst eine Erinnerung setzt, setzt sie fuer sich.
 */
function syncEventFanout(entityType, entityId, userId) {
  if (entityType !== 'event') return;
  try {
    if (eventAuthorId(db.get(), entityId) !== userId) return;
    fanOutEventReminders(db.get(), entityId, userId);
  } catch (err) {
    // Bewusst nicht durchgereicht: die eigene Erinnerung des Aufrufers steht
    // bereits, und sie darf nicht daran scheitern, dass das Nachziehen fuer
    // jemand anderen schiefging. Stumm bleibt es trotzdem nicht (#... siehe
    // das stille catch, das monatelang einen ReferenceError verdeckt hat).
    log.error('Error fanning out event reminders:', err.message);
  }
}

/**
 * HERKÜNFTE, DIE EIN LAUF LAUFEND HERSTELLT und die deshalb keine Handeingabe
 * annehmen: `pantry_item` stellt server/services/pantry-reminders.js in JEDEM
 * Benachrichtigungsdurchgang wieder her. Ein von Hand gesetzter Termin ist dort
 * binnen einer Minute weg, und zwar spurlos - ihn anzunehmen wäre eine Zusage,
 * die niemand hält. Ein ehrliches 400 sagt es sofort.
 *
 * `schedule_entry` gehört aus demselben Grund dazu:
 * server/services/schedule-reminders.js stellt seine Zeile bei jedem Lauf neu
 * her, und `entity_id` zeigt zudem auf einen Anker
 * (`schedule_reminder_entries`), den ein Aufrufer von aussen gar nicht bilden
 * könnte.
 *
 * `schedule_extra_entry` ebenso: derselbe periodische Sync stellt sie her,
 * auch wenn `entity_id` hier direkt auf eine echte `schedule_extra_shifts`-
 * Zeile zeigt statt auf einen Anker - der Vorlauf selbst
 * (`reminder_offset_minutes`) ist nur ueber die Extra-Routen aenderbar, nicht
 * ueber diesen generischen Router.
 *
 * WARUM NICHT AUCH `subscription`, `inventory_item`, `inventory_tracked_date`.
 * Auch sie werden abgeleitet, aber nur beim SCHREIBEN ihres Objekts: dort hält
 * ein handgesetzter Termin bis zur nächsten Änderung des Abos oder Geräts, und
 * das ist eine Halbwertszeit, mit der man arbeiten kann. Sie mitzusperren wäre
 * die geradere Regel und ein rückwirkender Bruch an einer zugesagten
 * `/api/v1`-Oberfläche, für den es keinen Anlass gibt. Die Unterscheidung ist
 * nicht Bequemlichkeit, sondern der Unterschied zwischen "hält bis du es
 * änderst" und "ist in sechzig Sekunden weg" (Entscheidung 2026-08-26).
 *
 * `cycle_period` und `cycle_log_nudge` gehören aus einem verwandten, aber
 * eigenen Grund dazu: server/services/cycle-reminders.js stellt ihre Zeile bei
 * jedem Lauf neu her, und `entity_id` zeigt auf einen Anker
 * (`cycle_reminder_anchors`), den ein Aufrufer von außen gar nicht bilden
 * könnte - ein vorhergesagter Periodenbeginn und "heute noch nicht geloggt"
 * sind beide keine gespeicherte Zeile, an die man von Hand eine Erinnerung
 * hängen könnte.
 *
 * Die LESEWEGE (GET) kennen alle Typen weiter: der Erinnerungs-Toast muss eine
 * abgeleitete Meldung anzeigen und wegwischen können.
 */
const DERIVED_ENTITY_TYPES = ['pantry_item', 'cycle_period', 'cycle_log_nudge', 'schedule_entry', 'schedule_extra_entry', 'waste_pickup'];

/* DIESER ROUTER IST EINE MISCHSTELLE, UND SEIN PFAD SAGT DAS NICHT.
 *
 * `/api/v1/reminders` löst über `moduleForPath()` auf `calendar` auf - der
 * Router teilt sich das Scope-Modul mit Kalender und Geburtstagen (scopes.js).
 * Die Zeilen, die er ausliefert, stammen aber aus SECHS Modulen: er nennt
 * Aufgabentitel, Abo-Namen, Inventar-Gegenstände und seit #811 auch
 * Vorratsartikel.
 *
 * Damit reichte ein Token mit `calendar:read`, um über `/reminders/pending` den
 * Namen eines Vorratsartikels zu lesen, und `calendar:write`, um die Meldung zu
 * verwerfen - ohne je einen `pantry`- oder `budget`-Scope zu besitzen. Dasselbe
 * gilt für ein Mitglied, dem ein Modul per `access_permissions` entzogen ist:
 * der Pfad-Guard in server/index.js fragt nach `calendar` und lässt es durch.
 *
 * Genau die Lage, für die es `deniedModules()` gibt (siehe dessen Kommentarkopf
 * zu /dashboard): wo ein Endpunkt Inhalte aus mehreren Modulen trägt, muss das
 * Aussortieren in der Route passieren. Eine Rechteregel darf nicht in einer
 * Middleware wohnen.
 *
 * Der Befund kam aus der PR-Review zu #811 und ist älter als dieses Feature -
 * er betraf fünf Herkünfte, bevor die sechste dazukam. Deshalb steht hier eine
 * Karte über alle und keine Ausnahme für die neue.
 */
const ORIGIN_MODULE = Object.freeze({
  task:                   'tasks',
  event:                  'calendar',
  subscription:           'budget',
  inventory_item:         'inventory',
  inventory_tracked_date: 'inventory',
  pantry_item:            'pantry',
  cycle_period:           'health',
  cycle_log_nudge:        'health',
  schedule_entry:         'schedule',
  schedule_extra_entry:   'schedule',
  waste_pickup:           'waste',
});

/**
 * Darf dieser Aufrufer eine Erinnerung dieser Herkunft sehen bzw. anfassen?
 * Beide Achsen, wie überall: Token-Scopes (Allowlist) und Mitgliedsrechte
 * (Denylist).
 */
function mayTouchOrigin(req, entityType, access = 'read') {
  const moduleKey = ORIGIN_MODULE[entityType];
  // Eine unbekannte Herkunft ist keine, die dieser Router ausliefern soll.
  if (!moduleKey) return false;
  if (deniedModules(req.sessionModuleAccess).has(moduleKey)) return false;
  return tokenAllows(req.authScopes, moduleKey, access);
}

/** Die Herkünfte, die dieser Aufrufer lesen darf - als SQL-taugliche Liste. */
function readableOrigins(req) {
  return Object.keys(ORIGIN_MODULE).filter((type) => mayTouchOrigin(req, type, 'read'));
}

/** Herkünfte, die ein Schreibweg annehmen darf: alle ausser den abgeleiteten. */
const SETTABLE_ENTITY_TYPES = VALID_ENTITY_TYPES.filter((t) => !DERIVED_ENTITY_TYPES.includes(t));

/** Fehlertext, wenn ein Schreibweg eine abgeleitete Herkunft von Hand setzen will. */
function derivedTypeError(entityType) {
  return `Reminders for ${entityType} are derived from the item itself and cannot be set here.`;
}

// Obergrenze für mehrere Erinnerungen je Entität (z. B. Kalender-Termin, #436).
const MAX_REMINDERS_PER_ENTITY = 5;

// --------------------------------------------------------
// GET /api/v1/reminders/pending
// Gibt alle fälligen, nicht-verworfenen Erinnerungen des aktuellen Nutzers zurück.
// "Fällig" = remind_at <= jetzt
// Response: { data: Reminder[] }
// --------------------------------------------------------
router.get('/pending', (req, res) => {
  try {
    const userId = req.authUserId || req.session.userId;
    const now    = new Date().toISOString();
    syncAllBirthdayReminders(db.get(), userId, new Date());

    // Nur die Herkünfte, die dieser Aufrufer sehen darf - der Pfad-Guard fragt
    // für den ganzen Router nach `calendar` und deckt die anderen fünf nicht.
    const origins = readableOrigins(req);
    if (!origins.length) return res.json({ data: [] });

    const rows = db.get().prepare(`
      SELECT
        r.*,
        CASE r.entity_type
          WHEN 'task'  THEN (SELECT title FROM tasks           WHERE id = r.entity_id)
          WHEN 'event' THEN (SELECT title FROM calendar_events WHERE id = r.entity_id)
          WHEN 'subscription' THEN (SELECT name FROM budget_subscriptions WHERE id = r.entity_id)
          WHEN 'inventory_item' THEN (SELECT name FROM inventory_items WHERE id = r.entity_id)
          WHEN 'inventory_tracked_date' THEN (
            SELECT ii.name || ' · ' || d.label
            FROM inventory_item_dates d JOIN inventory_items ii ON ii.id = d.item_id
            WHERE d.id = r.entity_id
          )
          WHEN 'pantry_item' THEN (SELECT name FROM pantry_items WHERE id = r.entity_id)
          WHEN 'cycle_period' THEN (SELECT anchor_date FROM cycle_reminder_anchors WHERE id = r.entity_id)
          WHEN 'cycle_log_nudge' THEN (SELECT anchor_date FROM cycle_reminder_anchors WHERE id = r.entity_id)
          WHEN 'schedule_entry' THEN (
            SELECT t.name FROM schedule_reminder_entries e JOIN schedule_shift_types t ON t.id = e.shift_type_id
            WHERE e.id = r.entity_id
          )
          WHEN 'schedule_extra_entry' THEN (
            SELECT t.name FROM schedule_extra_shifts e JOIN schedule_shift_types t ON t.id = e.shift_type_id
            WHERE e.id = r.entity_id
          )
          WHEN 'waste_pickup' THEN (
            SELECT t.name FROM waste_reminder_entries e JOIN waste_types t ON t.id = e.type_id
            WHERE e.id = r.entity_id
          )
        END AS entity_title
      FROM reminders r
      WHERE r.created_by  = ?
        AND r.dismissed   = 0
        AND r.remind_at  <= ?
        AND r.entity_type IN (${origins.map(() => '?').join(', ')})
      ORDER BY r.remind_at ASC
    `).all(userId, now, ...origins);

    res.json({ data: rows });
  } catch (err) {
    log.error('Error loading due reminders:', err.message);
    res.status(500).json({ error: 'Internal error.', code: 500 });
  }
});

// --------------------------------------------------------
// GET /api/v1/reminders/all?entity_type=event&entity_id=5
// Gibt ALLE nicht-verworfenen Erinnerungen einer Entität zurück (#436).
// Kalender-Termine unterstützen mehrere Erinnerungen; Tasks/Subscriptions
// nutzen weiterhin den Single-Endpoint (GET /).
// Response: { data: Reminder[] }
// --------------------------------------------------------
router.get('/all', (req, res) => {
  try {
    const userId     = req.authUserId || req.session.userId;
    const entityType = req.query.entity_type;
    const entityId   = parseInt(req.query.entity_id, 10);

    if (!VALID_ENTITY_TYPES.includes(entityType) || !entityId) {
      return res.status(400).json({ error: 'entity_type und entity_id sind erforderlich.', code: 400 });
    }
    if (!mayTouchOrigin(req, entityType)) {
      return res.status(403).json({ error: 'You do not have access to this module.', code: 403 });
    }

    const rows = db.get().prepare(`
      SELECT * FROM reminders
      WHERE entity_type = ? AND entity_id = ? AND created_by = ? AND dismissed = 0
      ORDER BY remind_at ASC
    `).all(entityType, entityId, userId);

    res.json({ data: rows });
  } catch (err) {
    log.error('Error loading reminders:', err.message);
    res.status(500).json({ error: 'Internal error.', code: 500 });
  }
});

// --------------------------------------------------------
// GET /api/v1/reminders?entity_type=task&entity_id=5
// Gibt die Erinnerung für eine spezifische Entität zurück (oder null).
// Response: { data: Reminder | null }
// --------------------------------------------------------
router.get('/', (req, res) => {
  try {
    const userId      = req.authUserId || req.session.userId;
    const entityType  = req.query.entity_type;
    const entityId    = parseInt(req.query.entity_id, 10);

    if (!VALID_ENTITY_TYPES.includes(entityType) || !entityId) {
      return res.status(400).json({ error: 'entity_type und entity_id sind erforderlich.', code: 400 });
    }
    if (!mayTouchOrigin(req, entityType)) {
      return res.status(403).json({ error: 'You do not have access to this module.', code: 403 });
    }

    const row = db.get().prepare(`
      SELECT * FROM reminders
      WHERE entity_type = ? AND entity_id = ? AND created_by = ? AND dismissed = 0
      ORDER BY created_at DESC LIMIT 1
    `).get(entityType, entityId, userId);

    res.json({ data: row || null });
  } catch (err) {
    log.error('Error loading reminder:', err.message);
    res.status(500).json({ error: 'Internal error.', code: 500 });
  }
});

// --------------------------------------------------------
// POST /api/v1/reminders
// Erstellt oder ersetzt die Erinnerung für eine Entität.
// Body: { entity_type, entity_id, remind_at }
// Response: { data: Reminder }
// --------------------------------------------------------
router.post('/', (req, res) => {
  try {
    const userId = req.authUserId || req.session.userId;
    const { entity_type, entity_id, remind_at } = req.body;

    const errors = v.collectErrors([
      v.id(entity_id,          'entity_id'),
      v.datetime(remind_at,    'remind_at', true),
    ]);

    // Der `v.oneOf` gegen VALID_ENTITY_TYPES stand hier zusätzlich und sagte
    // dasselbe ein zweites Mal - seit die abgeleiteten Herkünfte abgewiesen
    // werden, sagte er sogar etwas anderes: eine Liste, aus der vier Einträge
    // im nächsten Zweig doch scheitern. Ein Check, eine Antwort.
    if (!entity_type || !SETTABLE_ENTITY_TYPES.includes(entity_type)) {
      errors.push(DERIVED_ENTITY_TYPES.includes(entity_type)
        ? derivedTypeError(entity_type)
        : `entity_type must be one of: ${SETTABLE_ENTITY_TYPES.join(', ')}.`);
    }

    if (errors.length) {
      return res.status(400).json({ error: errors.join(' '), code: 400 });
    }
    if (!mayTouchOrigin(req, entity_type, 'write')) {
      return res.status(403).json({ error: 'You do not have access to this module.', code: 403 });
    }

    const entityId = parseInt(entity_id, 10);

    // Bestehende nicht-verworfene Erinnerungen für diese Entität löschen
    db.get().prepare(`
      DELETE FROM reminders
      WHERE entity_type = ? AND entity_id = ? AND created_by = ?
    `).run(entity_type, entityId, userId);

    const result = db.get().prepare(`
      INSERT INTO reminders (entity_type, entity_id, remind_at, created_by)
      VALUES (?, ?, ?, ?)
    `).run(entity_type, entityId, remind_at, userId);

    syncEventFanout(entity_type, entityId, userId);

    const row = db.get().prepare('SELECT * FROM reminders WHERE id = ?').get(result.lastInsertRowid);
    res.status(201).json({ data: row });
  } catch (err) {
    log.error('Error creating reminder:', err.message);
    res.status(500).json({ error: 'Internal error.', code: 500 });
  }
});

// --------------------------------------------------------
// PUT /api/v1/reminders?entity_type=event&entity_id=5
// Ersetzt die komplette Erinnerungs-Menge einer Entität (#436).
// Body: { remind_ats: string[] } (dedupliziert, max. MAX_REMINDERS_PER_ENTITY)
// Response: { data: Reminder[] }
// --------------------------------------------------------
router.put('/', (req, res) => {
  try {
    const userId     = req.authUserId || req.session.userId;
    const entityType = req.query.entity_type;
    const entityId   = parseInt(req.query.entity_id, 10);
    const remindAts  = req.body?.remind_ats;

    if (!VALID_ENTITY_TYPES.includes(entityType) || !entityId) {
      return res.status(400).json({ error: 'entity_type und entity_id sind erforderlich.', code: 400 });
    }
    // DERSELBE RIEGEL WIE IN POST. Er fehlte hier zunächst, und das war der
    // teurere Weg: PUT ersetzt die ganze Menge und darf bis zu fünf Termine
    // schreiben. Für eine abgeleitete Herkunft zieht der Modul-Sync sie
    // anschliessend alle auf denselben Zeitpunkt - fünf identische Meldungen
    // für einen Artikel, statt einer.
    if (DERIVED_ENTITY_TYPES.includes(entityType)) {
      return res.status(400).json({ error: derivedTypeError(entityType), code: 400 });
    }
    if (!mayTouchOrigin(req, entityType, 'write')) {
      return res.status(403).json({ error: 'You do not have access to this module.', code: 403 });
    }
    if (!Array.isArray(remindAts)) {
      return res.status(400).json({ error: 'remind_ats muss ein Array sein.', code: 400 });
    }

    // Duplikate entfernen, jeden Eintrag als Datetime validieren, Cap anwenden.
    const unique = [...new Set(remindAts)];
    const errors = v.collectErrors(unique.map((value, i) => v.datetime(value, `remind_ats[${i}]`, true)));
    if (errors.length) {
      return res.status(400).json({ error: errors.join(' '), code: 400 });
    }
    if (unique.length > MAX_REMINDERS_PER_ENTITY) {
      return res.status(400).json({ error: `Maximal ${MAX_REMINDERS_PER_ENTITY} Erinnerungen je Eintrag.`, code: 400 });
    }

    const replace = db.get().transaction((values) => {
      db.get().prepare(`
        DELETE FROM reminders
        WHERE entity_type = ? AND entity_id = ? AND created_by = ?
      `).run(entityType, entityId, userId);

      const insert = db.get().prepare(`
        INSERT INTO reminders (entity_type, entity_id, remind_at, created_by)
        VALUES (?, ?, ?, ?)
      `);
      for (const remindAt of values) {
        insert.run(entityType, entityId, remindAt, userId);
      }
    });
    replace(unique);
    syncEventFanout(entityType, entityId, userId);

    const rows = db.get().prepare(`
      SELECT * FROM reminders
      WHERE entity_type = ? AND entity_id = ? AND created_by = ? AND dismissed = 0
      ORDER BY remind_at ASC
    `).all(entityType, entityId, userId);

    res.json({ data: rows });
  } catch (err) {
    log.error('Error setting reminders:', err.message);
    res.status(500).json({ error: 'Internal error.', code: 500 });
  }
});

// --------------------------------------------------------
// PATCH /api/v1/reminders/:id/dismiss
// Markiert eine Erinnerung als verworfen.
// Response: { data: { id } }
// --------------------------------------------------------
router.patch('/:id/dismiss', (req, res) => {
  try {
    const userId     = req.authUserId || req.session.userId;
    const reminderId = parseInt(req.params.id, 10);

    if (!reminderId) {
      return res.status(400).json({ error: 'Ungültige Erinnerungs-ID.', code: 400 });
    }

    const reminder = db.get().prepare(
      'SELECT * FROM reminders WHERE id = ? AND created_by = ?'
    ).get(reminderId, userId);

    if (!reminder) {
      return res.status(404).json({ error: 'Erinnerung nicht gefunden.', code: 404 });
    }
    // Verwerfen ist ein Schreibvorgang am fremden Modul: ein Token mit
    // `calendar:write` durfte hier bis zur Review von #811 eine Vorrats- oder
    // Abo-Meldung wegwischen, ohne den Scope dieses Moduls zu besitzen.
    if (!mayTouchOrigin(req, reminder.entity_type, 'write')) {
      return res.status(403).json({ error: 'You do not have access to this module.', code: 403 });
    }

    db.get().prepare('UPDATE reminders SET dismissed = 1 WHERE id = ?').run(reminderId);
    res.json({ data: { id: reminderId } });
  } catch (err) {
    log.error('Error dismissing reminder:', err.message);
    res.status(500).json({ error: 'Internal error.', code: 500 });
  }
});

// --------------------------------------------------------
// DELETE /api/v1/reminders/:id
// Löscht eine Erinnerung dauerhaft.
// Response: 204 No Content
// --------------------------------------------------------
router.delete('/:id', (req, res) => {
  try {
    const userId     = req.authUserId || req.session.userId;
    const reminderId = parseInt(req.params.id, 10);

    if (!reminderId) {
      return res.status(400).json({ error: 'Ungültige Erinnerungs-ID.', code: 400 });
    }

    const reminder = db.get().prepare(
      'SELECT id, entity_type, entity_id FROM reminders WHERE id = ? AND created_by = ?'
    ).get(reminderId, userId);

    if (!reminder) {
      return res.status(404).json({ error: 'Erinnerung nicht gefunden.', code: 404 });
    }
    if (!mayTouchOrigin(req, reminder.entity_type, 'write')) {
      return res.status(403).json({ error: 'You do not have access to this module.', code: 403 });
    }
    // Dieselbe Sperre wie beim Filter-Weg daneben: ohne sie bliebe eine
    // Hintertuer mit exakt derselben folgenlosen Wirkung.
    if (DERIVED_ENTITY_TYPES.includes(reminder.entity_type)) {
      return res.status(400).json({ error: derivedTypeError(reminder.entity_type), code: 400 });
    }

    db.get().prepare('DELETE FROM reminders WHERE id = ?').run(reminderId);
    syncEventFanout(reminder.entity_type, reminder.entity_id, userId);
    res.status(204).end();
  } catch (err) {
    log.error('Error deleting reminder:', err.message);
    res.status(500).json({ error: 'Internal error.', code: 500 });
  }
});

// --------------------------------------------------------
// DELETE /api/v1/reminders?entity_type=task&entity_id=5
// Löscht alle Erinnerungen für eine Entität (z.B. bei Task-Löschung).
// Response: 204 No Content
// --------------------------------------------------------
router.delete('/', (req, res) => {
  try {
    const userId     = req.authUserId || req.session.userId;
    const entityType = req.query.entity_type;
    const entityId   = parseInt(req.query.entity_id, 10);

    if (!VALID_ENTITY_TYPES.includes(entityType) || !entityId) {
      return res.status(400).json({ error: 'entity_type und entity_id sind erforderlich.', code: 400 });
    }
    if (!mayTouchOrigin(req, entityType, 'write')) {
      return res.status(403).json({ error: 'You do not have access to this module.', code: 403 });
    }
    // AUCH HIER, aus demselben Grund wie bei POST und PUT - und mit derselben
    // Wirkungslosigkeit: die geloeschte Zeile legt der naechste Modul-Sync
    // wieder an, beim Vorrat binnen einer Minute und mit zurueckgesetztem
    // `pushed_at`, also als frische Meldung. Wer eine abgeleitete Erinnerung
    // loswerden will, verwirft sie (PATCH /:id/dismiss): das haelt, weil die
    // Zeile bestehen bleibt.
    if (DERIVED_ENTITY_TYPES.includes(entityType)) {
      return res.status(400).json({ error: derivedTypeError(entityType), code: 400 });
    }

    db.get().prepare(`
      DELETE FROM reminders
      WHERE entity_type = ? AND entity_id = ? AND created_by = ?
    `).run(entityType, entityId, userId);
    syncEventFanout(entityType, entityId, userId);

    res.status(204).end();
  } catch (err) {
    log.error('Error deleting reminders:', err.message);
    res.status(500).json({ error: 'Internal error.', code: 500 });
  }
});

export default router;
