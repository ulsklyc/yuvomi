/**
 * Modul: Küche (Kitchen)
 * Zweck: Ein Zustandsabruf für die Küchen-Tab-Leiste (offene Einkaufsartikel,
 *        Vorratsartikel mit Frist).
 * Abhängigkeiten: express, server/db.js
 *
 * WARUM ES DIESE ROUTE GIBT: Die vier Tabs sind Stationen eines Kreislaufs -
 * planen → kochen → einkaufen → lagern. Erzählt wurde dieser Kreislauf bisher nur
 * in den vier Leerzustands-Hinweisen; mit dem ersten Datensatz verschwand er, und
 * übrig blieben vier Schubladen (Critique 2026-07-30, P1). Die Tab-Leiste kann ihn
 * dauerhaft tragen, wenn sie den Zustand der Nachbarn kennt - und den kennt keine
 * der vier Seiten, weil jede nur ihre eigenen Daten lädt.
 *
 * WARUM EIN EIGENER ROUTER UND NICHT ZWEI AUFRUFE: die Leiste rendert auf jeder
 * Küchen-Seite. Zwei Fremd-Endpunkte pro Seitenaufruf wären zwei Roundtrips und
 * zwei Mal Logik, die der Client nachrechnen müsste (was zählt als „fast leer"?).
 * Eine Abfrage, zwei Zahlen.
 *
 * WARUM DER ESSENSPLAN NICHT MEHR DABEI IST: er lieferte `meals.gaps` = sichtbare
 * Mahlzeitentypen × 7 Tage minus die belegten Slots, also die FEHLENDEN Einträge
 * einer Woche. Bei leerer Woche stand dort 28 - die lauteste Zahl der Leiste für
 * den Zustand „nichts geplant" -, und mitgezählt wurden Tage, die schon vorbei
 * waren. Das Badge ist deshalb entfallen (Begründung am BADGES-Array in
 * public/utils/kitchen-tabs.js), und mit ihm die Rechnung: eine COUNT-DISTINCT-
 * Abfrage über `meals` plus ein sync_config-Lesevorgang auf JEDEM Küchen-
 * Seitenaufruf, deren Ergebnis niemand mehr liest.
 *
 * WARUM `today` VOM CLIENT KOMMT: „abgelaufen" hängt am lokalen Kalendertag des
 * Nutzers. Der Server rechnet in UTC und läge westlich von UTC bis zu einen Tag
 * daneben - genau die Fehlerklasse, gegen die `toLocalDateKey()` existiert (siehe
 * den Kommentarkopf von public/utils/pantry-status.js, wo dieselbe Entscheidung
 * schon einmal getroffen wurde). Ohne `today` fällt die Route auf den UTC-Tag
 * zurück und meldet das nicht - sie liefert dann eine Zahl, die um höchstens einen
 * Tag verschoben ist, statt zu scheitern.
 */

import express from 'express';
import * as db from '../db.js';
import { createLogger } from '../logger.js';
import { deniedModules } from '../permissions.js';
import { todayKey } from '../utils/timezone.js';

const log = createLogger('Kitchen');
const router = express.Router();

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

// Nichts zu melden - dieselbe Form, nur ohne Zahlen.
const EMPTY_PANTRY = Object.freeze({ attention: 0, expired: 0, low: 0, out: 0 });

/**
 * GET /api/v1/kitchen/summary?today=YYYY-MM-DD
 *
 * Response: { data: {
 *   shopping: { open },
 *   pantry:   { attention, expired, low, out },
 * } }
 *
 * `attention` = abgelaufen ODER leer ODER fast leer, ohne Doppelzählung. Die drei
 * Teilzahlen kommen mit, damit die Leiste später verfeinert werden kann, ohne die
 * Route zu ändern - sie summieren sich bewusst NICHT auf `attention`, weil ein
 * Artikel abgelaufen UND fast leer sein kann.
 *
 * WHAT IS COUNTED, SINCE THE MINIMUM IS THE PRODUCT'S (#1448, step 3). The two
 * facts live in different places: expiry is a property of a batch, low and out
 * of a product (the sum of its batches against the product's minimum; a
 * product without batches is out only when it has a minimum). So:
 *
 * - `expired` counts batches, as the "Expired" chip does.
 * - `low` and `out` count products, as the "Running low" chip does.
 * - `attention` counts PRODUCTS, each one once: a product needs attention when
 *   it is out, running low, or has at least one expired batch. A product that
 *   is low and has an expired batch is one item needing attention, not two
 *   (the maintainer's rule on #1448), and so is a product with two expired
 *   batches: the badge says how many things in the stock need you, and the
 *   page lists products, the expired chip then names the batches.
 *
 * A batch without a product (written by an older version under
 * DB_ALLOW_NEWER_SCHEMA, until the next start adopts it) stands for itself,
 * with its own minimum, as the client treats it.
 */
router.get('/summary', (req, res) => {
  try {
    const today = DATE_RE.test(req.query.today ?? '')
      ? req.query.today
      : todayKey(db.get());

    /* EIN GESPERRTES MODUL ZÄHLT HIER NICHT MIT (#467).
     *
     * Diese Route trägt zwei Module in einer Antwort, und der Pfad-Guard in
     * server/index.js erreicht sie erst recht nicht: `kitchen` ist nicht
     * einmal ein Scope-Modul, `moduleForPath('/kitchen')` ergibt null.
     *
     * Es sind „nur" Zahlen und keine Titel - aber die Leiste rendert auf JEDER
     * Küchen-Seite, und ein Mitglied ohne Einkaufszugriff bekam auf der
     * Essensplan-Seite ein Abzeichen „7 offen" für eine Liste, die es nicht
     * öffnen darf. Eine Zahl über einen Bestand, den jemand nicht sehen darf,
     * ist eine kleine Auskunft über genau diesen Bestand. */
    const denied = deniedModules(req.sessionModuleAccess);

    const open = denied.has('shopping') ? 0 : db.get().prepare(
      'SELECT COUNT(*) AS c FROM shopping_items WHERE is_checked = 0'
    ).get().c;

    // Die drei Bedingungen spiegeln pantryStockStatus() und pantryItemStatus() in
    // public/utils/pantry-status.js. Bleiben sie hier und dort nicht gleich, zeigt
    // die Leiste eine andere Zahl als die Filter-Chips daneben - ein Guard in
    // test/test-frontend-audit.js hält die Definitionen zusammen.
    //
    // One row per product (`stock`): its total rounded like the client's
    // (normalizePantryQuantity, two decimals), its minimum, and how many of its
    // batches have expired. Every count below reads that row, so a product is
    // counted once however many batches it has. A product without batches is
    // out only when it has a minimum above 0 (hasPantryMinimum() in the
    // client, #2118): without one it tells nobody that something is missing.
    const pantry = denied.has('pantry') ? null : db.get().prepare(`
      WITH stock AS (
        SELECT p.min_quantity AS min_quantity,
               COUNT(pi.id) AS batches,
               ROUND(COALESCE(SUM(pi.quantity), 0), 2) AS quantity,
               SUM(CASE WHEN pi.expires_on IS NOT NULL AND pi.expires_on < ? THEN 1 ELSE 0 END) AS expired
        FROM pantry_products p
        LEFT JOIN pantry_items pi ON pi.product_id = p.id
        GROUP BY p.id
        UNION ALL
        SELECT min_quantity, 1, quantity,
               CASE WHEN expires_on IS NOT NULL AND expires_on < ? THEN 1 ELSE 0 END
        FROM pantry_items WHERE product_id IS NULL
      )
      , status AS (
        SELECT expired,
               CASE WHEN batches > 0 THEN quantity <= 0 ELSE COALESCE(min_quantity > 0, 0) END AS is_out,
               CASE WHEN batches > 0 AND quantity > 0 AND min_quantity IS NOT NULL AND quantity <= min_quantity
                    THEN 1 ELSE 0 END AS is_low
        FROM stock
      )
      SELECT
        SUM(expired) AS expired,
        SUM(is_out) AS out_of_stock,
        SUM(is_low) AS low,
        SUM(CASE WHEN expired > 0 OR is_out OR is_low THEN 1 ELSE 0 END) AS attention
      FROM status
    `).get(today, today);

    res.json({
      data: {
        shopping: { open },
        pantry: pantry ? {
          attention: pantry.attention ?? 0,
          expired: pantry.expired ?? 0,
          low: pantry.low ?? 0,
          out: pantry.out_of_stock ?? 0,
        } : { ...EMPTY_PANTRY },
      },
    });
  } catch (err) {
    log.error('GET /summary error:', err);
    res.status(500).json({ error: 'Internal server error.', code: 500 });
  }
});

export default router;
