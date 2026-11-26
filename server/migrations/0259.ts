// @ts-nocheck - eingefrorene Migration (append-only): Typen nachziehen hiesse den Text aendern.

import { backfillShoppingMoveSince } from './helpers.ts';

export default {
    version: 259,
    description: 'Shopping: a waiting move of a mirrored item remembers when it began (#1911)',
    // EIN WARTENDER UMZUG BEKOMMT EIN ENDE (#1911). Ein Umzug (#1700, v243)
    // wartet, solange die Server-Liste seines Objekts nicht eingeschaltet ist -
    // ohne Zaehler und ohne Uhr, also fuer immer, mit einem Eintrag, der am
    // alten Platz weiterlebt. `outbound_move_since` ist der Zeitpunkt, an dem
    // die Vormerkung gesetzt wurde (UTC, `datetime('now')`); nach der Frist
    // geht die Zeile auf die Liste ihres Objekts zurueck.
    //
    // NACHTRAG: ein schon wartender Umzug beginnt seine Frist mit dem Update,
    // nicht mit einem geratenen Zeitpunkt davor - sonst ginge er beim ersten
    // Lauf danach ohne Frist zurueck.
    up(db) {
      const has = db.prepare('PRAGMA table_info(shopping_items)').all().some((c) => c.name === 'outbound_move_since');
      if (!has) db.exec('ALTER TABLE shopping_items ADD COLUMN outbound_move_since TEXT');
      backfillShoppingMoveSince(db);
    },
  };
