/**
 * Modul: Das Ziel einer Erinnerung und wer es sehen darf
 * Zweck: Die eine Stelle, die fuer `reminders.entity_type` + `entity_id` sagt,
 *        ob es die Zeile gibt und ob eine Person sie sieht - als Einzelfrage
 *        fuer die Schreibwege und als SQL-Fragment fuer die Lesewege.
 * Abhaengigkeiten: visibility (Aufgaben, Termine), budget-visibility (Abos).
 *
 * WARUM ES DIESE DATEI GIBT. `reminders.entity_id` ist ein weicher Verweis ohne
 * Fremdschluessel, und der Router fragte fuer ihn nur das MODULRECHT
 * (`mayTouchOrigin()`): darf dieses Mitglied Aufgaben ueberhaupt. Ob es DIESE
 * Aufgabe sehen darf, fragte niemand. Eine Erinnerung liess sich deshalb auf
 * eine geratene Kennung setzen, und `GET /reminders/pending` wie die
 * Zustellung nannten danach den Titel der Zeile - einer privaten Aufgabe,
 * eines privaten Termins, eines privaten Abos.
 *
 * HIER STEHT KEINE ZWEITE REGEL. Jede Herkunft reicht die Klausel durch, die
 * ihr eigenes Modul beim Lesen zieht:
 *   task          `visibilityWhere()` wie GET /tasks und `mayAccessTask()`
 *   event         `visibilityWhere()` UND der Abo-Filter, wie die Kalenderliste
 *                 (routes/calendar/read.js), die Suche und `getUpcomingEvents()`:
 *                 ein ICS-Termin nur aus einem geteilten oder eigenen Abo
 *   subscription  `budgetVisibilityWhere()` mit dem Budget-Modus des Haushalts,
 *                 wie GET /subscriptions
 *   inventory_*   keine Zeilen-Sichtbarkeit (das Inventar hat weder owner_id
 *                 noch visibility) - das Modulrecht ist dort die ganze Regel,
 *                 gefragt wird nur, ob es die Zeile gibt
 *
 * WAS HIER NICHT STEHT, IST ABGELEITET. Die uebrigen Herkuenfte (Vorrat,
 * Zyklus, Schichtplan, Muell, Dokumentablauf, Vorsorge, Fasten) nimmt kein
 * Schreibweg von Hand an; ihre Zeilen stellt der jeweilige Sync je Empfaenger
 * her, und der zieht seine eigene Regel beim Herstellen. Der Lese-Filter
 * laesst sie deshalb unberuehrt.
 */

import { icsSubscriptionVisibleWhere, visibilityWhere } from './visibility.js';
import { budgetVisibilityWhere, resolveBudgetMode } from './budget-visibility.js';
import { documentVisibleSql } from './document-access.js';

/** Platzhaltername fuer "niemand Bestimmtes" - wird im SQL durch NULL ersetzt. */
const NOBODY = 'reminder_target_nobody';

/**
 * Je Herkunft: die Tabelle und die Klausel, unter der `viewer` (ein
 * SQL-Ausdruck, kein Wert) die Zeile mit dem Alias `x` sieht. `rowRule` sagt,
 * dass die Herkunft eine eigene Zeilen-Sichtbarkeit HAT - nur dann gibt es am
 * Leseweg etwas zu verbergen.
 */
const TARGETS = Object.freeze({
  task: {
    table: 'tasks',
    rowRule: true,
    visible: (viewer) => visibilityWhere('x', 'task_assignments', 'task_id', viewer),
  },
  event: {
    table: 'calendar_events',
    rowRule: true,
    visible: (viewer) => `${icsSubscriptionVisibleWhere('x', viewer)}
      AND ${visibilityWhere('x', 'event_assignments', 'event_id', viewer)}`,
  },
  subscription: {
    table: 'budget_subscriptions',
    rowRule: true,
    visible: (viewer, database) =>
      budgetVisibilityWhere('x', viewer, { mode: resolveBudgetMode(database) }),
  },
  inventory_item: { table: 'inventory_items', visible: () => '1=1' },
  inventory_tracked_date: { table: 'inventory_item_dates', visible: () => '1=1' },
});

/** Herkuenfte, deren Ziel diese Datei beurteilt - fuer den Guard im Test. */
export const TARGET_ENTITY_TYPES = Object.freeze(Object.keys(TARGETS));

/**
 * Gibt es die Zeile, und sieht `userId` sie?
 *
 * Fuer die Schreibwege. EINE Antwort fuer "gibt es nicht" und "siehst du
 * nicht": der Aufrufer macht aus beidem dieselbe 404, weil der Unterschied
 * selbst schon die Auskunft waere. Eine Herkunft ohne Eintrag ist `false` -
 * was diese Datei nicht kennt, nimmt kein Schreibweg an (Allowlist).
 */
export function reminderTargetVisible(database, entityType, entityId, userId) {
  const target = Object.hasOwn(TARGETS, entityType) ? TARGETS[entityType] : null;
  if (!target) return false;
  return !!database.prepare(`
    SELECT 1 FROM ${target.table} x
    WHERE x.id = @id AND ${target.visible('@me', database)}
  `).get({ id: entityId, me: userId });
}

/**
 * WHERE-Fragment (ohne fuehrendes AND) fuer eine Abfrage ueber `reminders`:
 * wahr, wenn der EMPFAENGER der Zeile (`created_by`) ihr Ziel sieht.
 *
 * Fuer die Lesewege - `GET /reminders/pending` und die Zustellung. Der Filter
 * steht dort und nicht nur am Schreibweg, weil die Sichtbarkeit sich nach dem
 * Anlegen aendert: eine Aufgabe wird privat, eine Zuweisung faellt weg, ein
 * ICS-Abo wird nicht mehr geteilt, der Haushalt wechselt den Budget-Modus. Und
 * weil es Zeilen von vor dieser Pruefung gibt.
 *
 * UEBERSPRUNGEN, NICHT GELOESCHT - derselbe Grund wie bei einem abgeschalteten
 * oder entzogenen Modul (reminder-origins.js): ein Leseweg schreibt nicht, und
 * die Sichtbarkeit kann zurueckkommen. Wer wieder zugewiesen wird, bekommt
 * seine Erinnerung wieder; geloescht waere sie fuer immer weg, ohne dass er es
 * erfuehre. Die eigene Zeile bleibt ueber DELETE aufraeumbar.
 *
 * EINE ZEILE, DIE ES NICHT MEHR GIBT, BEURTEILT DIESER FILTER NICHT. Er
 * verbirgt, was da ist und nicht gesehen werden darf - nicht, was fehlt. Fuer
 * Aufgaben und Termine raeumen Trigger und die Abfragen selbst eine Waise ab
 * (#1258); fuer Abo und Inventar geht sie mit dem neutralen Text hinaus, den
 * `reminderPayload()` fuer eine Zeile ohne Titel bildet (#581). Beides ist
 * aelter als diese Datei und bleibt, wie es ist: eine Waise nennt nichts.
 * Deshalb fragt das Fragment "gibt es die Zeile UND ist sie verborgen", und
 * Herkuenfte ohne Zeilen-Sichtbarkeit (Inventar) kommen darin nicht vor.
 * `COALESCE(..., 0)`, weil eine Klausel ueber eine leere Spalte (ein Abo ohne
 * `owner_id`) NULL ergibt - und NULL heisst hier "nicht sichtbar".
 *
 * Eine Herkunft ohne Eintrag bleibt durchgelassen (siehe Kopf): das ist hier
 * keine Denylist ueber Unbekanntes, sondern die Liste der Herkuenfte, die ein
 * Mensch setzen kann. Der Guard in test/test-reminder-target-visibility.js
 * haelt fest, dass jede SETZBARE Herkunft hier steht.
 *
 * @param {object} database  fuer den Budget-Modus (ein Lesezugriff, synchron)
 * @param {string} alias     Alias der reminders-Tabelle in der Abfrage
 */
export function reminderTargetVisibleSql(database, alias = 'r', viewer = `${alias}.created_by`) {
  const hidden = Object.keys(TARGETS)
    .filter((type) => TARGETS[type].rowRule)
    .map((type) => `(${alias}.entity_type = '${type}' AND EXISTS (
      SELECT 1 FROM ${TARGETS[type].table} x
      WHERE x.id = ${alias}.entity_id
        AND COALESCE(${TARGETS[type].visible(viewer, database)}, 0) = 0
    ))`);
  return `NOT (
    ${hidden.join('\n    OR ')}
  )`;
}

/**
 * DARF EINE HERKUNFT IN EINEN KANAL DES GANZEN HAUSHALTS? Eine Karte ueber ALLE
 * Herkuenfte, und sie ist eine Allowlist: was hier nicht steht, geht nicht
 * hinein. Ein Haushaltskanal (ntfy-Topic, Gotify, Webhook, E-Mail) ist ein
 * Leser ohne Kennung - wer ihn liest, legt der Admin fest, der ihn einrichtet,
 * und die Zeilen-Sichtbarkeit kennt keinen Admin-Bypass (#474).
 *
 *   'row'        die Zeile entscheidet: nur wenn JEDES Mitglied ihr Ziel sieht.
 *                Die setzbaren Herkuenfte (TARGETS) und der Dokumentablauf -
 *                Dokumente haben eine eigene Zeilenregel (`documentVisibleSql`).
 *   'household'  Haushaltsdaten ohne Zeilen-Sichtbarkeit: Vorrat und Muell.
 *   'personal'   nie. Die Meldung geht an Web Push und an Kanaele, die der
 *                Person selbst gehoeren.
 *
 * WARUM GESUNDHEIT GANZ PERSOENLICH IST und nicht der Zeile folgt: Zyklus,
 * Vorsorge und Fasten tragen zwar eine Sichtbarkeit, aber die Meldung selbst
 * ist die Auskunft - "naechste Periode am ...", in der Partner-Fassung mit dem
 * Namen der Person, "heute noch nichts eingetragen", der faellige
 * Vorsorgetermin. Ihre Erinnerungen hängen zudem an Ankern und abgeleiteten
 * Zeitpunkten, nicht an einer Zeile mit `visibility`; eine Regel "fuer alle
 * sichtbar" liesse sich dort nur raten. Wer sie einer zweiten Person zeigen
 * will, hat dafuer eigene Wege (Partner-Hinweis, Betreuung) - die bleiben.
 *
 * WARUM SCHICHTEN PERSOENLICH SIND: der Schichtplan hat keine Zeilenregel, aus
 * der sich "fuer alle" ableiten liesse, die Erinnerung entsteht je Person aus
 * deren eigenem Vorlauf, und ihr Text nennt die Person nicht ("Fruehschicht -
 * 06:00"). Im Haushaltskanal waere sie eine Meldung ohne Adressaten ueber den
 * Arbeitstag eines Einzelnen.
 */
export const HOUSEHOLD_CHANNEL_POLICY = Object.freeze({
  ...Object.fromEntries(Object.keys(TARGETS).map((type) => [type, 'row'])),
  document_expiry:       'row',
  pantry_item:           'household',
  waste_pickup:          'household',
  cycle_period:          'personal',
  cycle_log_nudge:       'personal',
  health_prevention_due: 'personal',
  fasting_goal:          'personal',
  fasting_next_start:    'personal',
  schedule_entry:        'personal',
  schedule_extra_entry:  'personal',
});

/**
 * WHERE-Fragment: wahr, wenn die Zeile in einen Kanal des ganzen Haushalts
 * darf - also wenn JEDES Mitglied ihr Ziel sieht.
 *
 * Fuer die Zustellung. Ein solcher Kanal ist ein Leser wie jeder andere, nur
 * ohne Kennung: die Frage "sieht der Empfaenger es" beantwortet fuer ihn
 * nichts, weil er nicht der Empfaenger ist.
 *
 * KEINE ZWEITE REGEL. Fuer die Herkuenfte mit Zeilenregel sind es dieselben
 * Klauseln wie oben, gefragt fuer einen Betrachter, der NIEMAND BESTIMMTES ist
 * (`NULL`): `created_by = NULL`, `owner_id = NULL` und die Zuweisung an `NULL`
 * sind nie wahr, also bleibt von jeder Klausel genau der Teil uebrig, der fuer
 * alle gilt - `visibility = 'all'`, ein geteiltes Abo, ein nicht privates Abo
 * im persoenlichen Budget-Modus, ein Dokument mit `visibility = 'family'`. Wer
 * die Regel eines Moduls aendert, aendert damit beide Fragen.
 *
 * Bei den setzbaren Herkuenften gilt eine Zeile ohne Ziel und eine Herkunft
 * ohne Zeilen-Sichtbarkeit (Inventar) als fuer alle da: dort gibt es nichts zu
 * verbergen. Ein Dokument muss es dagegen GEBEN - eine Waise hat hier keinen
 * Bestandsschutz, und die Allowlist entscheidet im Zweifel fuer "nicht".
 *
 * EINE UNBEKANNTE HERKUNFT IST NICHT OEFFENTLICH (`ELSE 0`). Das ist der
 * Unterschied zu `reminderTargetVisibleSql()`: dort geht es um den Empfaenger
 * der eigenen Zeile, hier um Dritte.
 */
export function reminderTargetPublicSql(database, alias = 'r') {
  const quoted = (policy) => Object.keys(HOUSEHOLD_CHANNEL_POLICY)
    .filter((type) => HOUSEHOLD_CHANNEL_POLICY[type] === policy)
    .map((type) => `'${type}'`).join(', ');
  // `documentVisibleSql` nimmt den Namen eines Bind-Parameters; hier steht an
  // seiner Stelle NULL, damit die Regel der Dokumente woertlich dieselbe bleibt.
  const documentForAll = documentVisibleSql('x', NOBODY).replaceAll(`@${NOBODY}`, 'NULL');
  return `(CASE
    WHEN ${alias}.entity_type IN (${Object.keys(TARGETS).map((type) => `'${type}'`).join(', ')})
      THEN ${reminderTargetVisibleSql(database, alias, 'NULL')}
    WHEN ${alias}.entity_type = 'document_expiry'
      THEN EXISTS (
        SELECT 1 FROM family_documents x
        WHERE x.id = ${alias}.entity_id AND COALESCE(${documentForAll}, 0) = 1
      )
    WHEN ${alias}.entity_type IN (${quoted('household')}) THEN 1
    ELSE 0
  END) = 1`;
}
