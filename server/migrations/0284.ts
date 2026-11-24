import { searchIndexRowidMigrationSql } from './helpers.ts';

export default {
    version: 284,
    description: 'search index: every row is found by a rowid derived from entity and id',
    // JEDE ZEILE IM SUCHINDEX KOSTETE BEIM LOESCHEN EINEN SCAN UEBER DEN GANZEN
    // INDEX. search_index ist eine regulaere FTS5-Tabelle; die Trigger loeschten
    // per `WHERE entity = ... AND entity_id = ...`, und fuer UNINDEXED-Spalten
    // hat FTS5 keinen Index. Jede geaenderte oder geloeschte Zeile las den
    // ganzen Index, eine Massenoperation wurde quadratisch (4000 Einkaufsartikel
    // umbenennen: 5,5 s; CalDAV-Sync, Aufgaben, Tags ebenso).
    //
    // Jetzt traegt jede Zeile ein deterministisches rowid, und alle Trigger
    // loeschen und schreiben ueber dieses rowid (ein Zugriff ueber den
    // Primaerschluessel der FTS5-Tabelle):
    //
    //   rowid = (<code> << 40) + <id>
    //
    //   task 1, event 2, note 3, contact 4, item 5, medication 6, activity 7,
    //   waste_type 8
    //
    // CODES WERDEN NIE NEU VERGEBEN; ein neues Modul nimmt den naechsten freien
    // (9). Die Tabelle steht auch in docs/SPEC.md. 40 Bit fuer die ID reichen
    // bis 2^40 (rund 1,1 Billionen) Zeilen je Tabelle - weit jenseits eines
    // Haushalts -, und 63 - 40 = 23 Bit lassen Platz fuer Millionen Codes, ohne
    // dass das rowid das Vorzeichen erreicht. Klammern sind Pflicht: in SQLite
    // bindet `+` staerker als `<<`.
    //
    // Inhalt, Namen und Trigger-Ereignisse bleiben WORTGLEICH zur bisherigen
    // Fassung (v44/66/117/151/206/239); nur der Schluessel aendert sich. Ein
    // AFTER-INSERT-Trigger, der bisher ohne DELETE einfuegte, nimmt jetzt
    // `INSERT OR REPLACE`: ein schlichtes INSERT auf ein belegtes rowid scheitert
    // mit "constraint failed" und braeche den Schreibvorgang des Nutzers ab
    // (SQLite 3.53 belegt; die regulaere FTS5-Tabelle nimmt REPLACE). Die
    // Feuerreihenfolge (juengster AFTER-Trigger zuerst) verschiebt sich durch
    // DROP + CREATE; die Rumpfe lesen nur die eigene Zeile und schreiben nur
    // search_index, sind also von der Reihenfolge unabhaengig - auch gegen den
    // sort_order-Trigger der Einkaufsartikel, wie v151 es verlangt.
    //
    // Der Index wird danach mit denselben Ausdruecken neu befuellt (Helfer
    // unten, einer fuer Trigger und Neuaufbau). test:search-index-rowid haelt
    // Struktur und Gleichwertigkeit, test:shopping-routes den Massenpfad.
    up: searchIndexRowidMigrationSql(),
  };
