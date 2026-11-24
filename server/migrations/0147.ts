// @ts-nocheck - eingefrorene Migration (append-only): Typen nachziehen hiesse den Text aendern.

export default {
    version: 147,
    description: 'repair reward icons and descriptions stored as the text null',
    up(db) {
      // Issue #789: der PATCH-Handler fuer den Praemienkatalog unterschied
      // `undefined` (Feld fehlt, unveraendert lassen) nicht von `null` (Feld
      // leer abgeschickt) und schickte das gesendete `null` durch `String()`.
      // Jede Praemie ohne Icon bekam beim ersten Bearbeiten deshalb den
      // vierstelligen Text "null" als Icon - und wer eine Beschreibung leerte,
      // bekam sie als "null" zurueck. Die Route ist repariert, die bereits
      // geschriebenen Zeilen bleiben ohne diese Migration stehen.
      //
      // Getroffen wird ausschliesslich der exakte Wert - kein LIKE, kein TRIM.
      // Eine Beschreibung, die "null" nur ENTHAELT, ist echter Text.
      db.prepare("UPDATE reward_catalog SET icon = NULL WHERE icon = 'null'").run();
      db.prepare("UPDATE reward_catalog SET description = NULL WHERE description = 'null'").run();

      // Der Einloese-Verlauf haelt Name/Icon/Kosten als Snapshot (siehe
      // Migration 1). Wer eine bereits verdorbene Praemie eingeloest hat, traegt
      // das "null" auch dort - und der Verlauf wird aus dem Katalog nicht mehr
      // nachgezogen, muss also eigens repariert werden.
      db.prepare("UPDATE reward_redemptions SET reward_icon = NULL WHERE reward_icon = 'null'").run();
    },
  };
