/**
 * Modul: Live-Feed der Einkaufslisten
 * Zweck: Sagt offenen Einkaufszetteln, DASS sich eine Liste geaendert hat -
 *        nicht was. Der Client laedt dann selbst nach, ueber denselben Weg wie
 *        beim Oeffnen der Seite. Ein Feed, der Inhalte truege, waere ein
 *        zweiter Leseweg neben GET /:listId/items, mit eigener Sortierung und
 *        eigenen Rechten, und beide liefen auseinander.
 *
 *        Die Quelle ist shopping_list_changes (Migration v194): eine Laufnummer
 *        je Liste, die Trigger bei jedem INSERT/UPDATE/DELETE an
 *        shopping_items bewegen. Der Feed liest sie im Sekundentakt - eine
 *        Abfrage ueber eine Tabelle mit einer Zeile je Liste - und meldet, was
 *        sich gegen den letzten Durchgang bewegt hat. Der Takt laeuft NUR,
 *        solange jemand zuhoert; ohne Abonnenten kostet der Feed nichts.
 *
 *        Warum kein Aufruf aus den Routen heraus: shopping_items wird aus sechs
 *        Modulen beschrieben. Der Trigger sieht sie alle, ein Aufruf nur die,
 *        an die jemand gedacht hat.
 * Abhaengigkeiten: server/db.js
 */

import * as db from '../db.js';
import { createLogger } from '../logger.js';

const log = createLogger('ShoppingFeed');

/** Takt des Vergleichs, solange mindestens ein Zettel zuhoert. */
export const POLL_MS = 1000;

const subscribers = new Set();
let timer = null;
/** Stand des letzten Durchgangs: list_id -> version. null, solange niemand zuhoert. */
let last = null;

/** Alle Laufnummern auf einmal: list_id -> version. */
export function readVersions() {
  const rows = db.get().prepare('SELECT list_id, version FROM shopping_list_changes').all();
  return new Map(rows.map((r) => [r.list_id, r.version]));
}

function emit(change) {
  for (const fn of subscribers) {
    try { fn(change); } catch (err) { log.warn('Abonnent hat geworfen:', err.message); }
  }
}

/**
 * Ein Durchgang: lesen, mit dem letzten Stand vergleichen, Bewegungen melden.
 * Oeffentlich, damit eine Suite ihn ausloesen kann, statt eine Sekunde zu warten.
 */
export function tick() {
  let now;
  try {
    now = readVersions();
  } catch (err) {
    log.warn('Laufnummern nicht lesbar:', err.message);
    return;
  }
  if (last) {
    for (const [listId, version] of now) {
      if (last.get(listId) !== version) emit({ listId, version });
    }
  }
  last = now;
}

/**
 * Zuhoeren. Gibt die Abmeldung zurueck; mit dem letzten Abonnenten steht der
 * Takt still. `unref()`, damit ein offener Feed den Prozess nicht am Leben
 * haelt - das tut der Server-Socket, wie bei den uebrigen Schedulern.
 *
 * @param {(change: { listId: number, version: number }) => void} fn
 * @returns {() => void}
 */
export function subscribe(fn) {
  subscribers.add(fn);
  if (!timer) {
    last = readVersions();
    timer = setInterval(tick, POLL_MS);
    timer.unref?.();
  }
  return () => {
    subscribers.delete(fn);
    if (subscribers.size === 0 && timer) {
      clearInterval(timer);
      timer = null;
      last = null;
    }
  };
}

export const __test = {
  subscriberCount: () => subscribers.size,
  isTicking: () => timer !== null,
};
