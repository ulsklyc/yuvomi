// @ts-nocheck - eingefrorene Migration (append-only): Typen nachziehen hiesse den Text aendern.

import { backfillSeriesAuthored } from './helpers.ts';

export default {
    version: 246,
    description: 'Calendar: an event remembers that its start and rule were written in Yuvomi (#1935)',
    // WER START UND WIEDERHOLUNGSREGEL ZULETZT GESCHRIEBEN HAT, STEHT AB HIER
    // IN EINER EIGENEN SPALTE. Bisher las der ausgehende Weg das aus
    // `external_source` ('local' = hier angelegt), und die Spalte verliert genau
    // diese Auskunft, sobald der Upload gebucht ist: sie sagt dann, WO die Zeile
    // gespiegelt liegt. Eine hier angelegte Serie "am letzten Tag des Monats"
    // ging deshalb nur beim ersten Upload mit einem Start hinaus, den ihre Regel
    // trifft (#986), und nach jeder Bearbeitung mit dem eingegebenen.
    //
    // `series_authored = 1`: Start und Regel stammen aus Yuvomi - gesetzt beim
    // Anlegen und bei jeder Aenderung von Start oder Regel in Yuvomi, auch an
    // einer eingelesenen Serie. Der Abruf nimmt die Marke zurueck, wenn er vom
    // Anbieter einen anderen Start oder eine andere Regel uebernimmt.
    // `0`: nicht von hier, oder unbekannt - die Serie geht Wort fuer Wort
    // zurueck (#756). Regel und Leser: services/outbound-dtstart.js.
    //
    // BESTAND. Eine Zeile mit `external_source = 'local'` ist nie durch einen
    // Abruf gegangen, ihr Start ist der eingegebene: 1. Das ist auch, wie der
    // ausgehende Weg sie bis hierher behandelt hat. Fuer schon gespiegelte
    // Zeilen (google, caldav, apple, ics) laesst sich die Herkunft NICHT mehr
    // feststellen - die eigene, hochgeladene Serie und die eingelesene sehen in
    // der Zeile gleich aus, und ein Start neben der eigenen Regel kommt in
    // beiden vor. Sie bleiben 0 und verhalten sich wie vor dieser Migration;
    // die Marke bekommen sie mit der naechsten Aenderung von Start oder Regel.
    // Geraten wird nicht: eine faelschlich gesetzte Marke schriebe einem fremden
    // Kalender ein anderes DTSTART.
    //
    // DIE TRIGGER VON calendar_events RUHEN WAEHREND DES NACHTRAGS, wie in
    // Migration 238: `trg_calendar_events_updated_at` setzte sonst jeden
    // lokalen Termin auf "eben geaendert". Sie werden mit ihrem gespeicherten
    // Wortlaut wieder angelegt, in derselben Reihenfolge, in derselben
    // Transaktion.
    //
    // ADD COLUMN, KEIN REBUILD: der Default ist konstant und erfuellt den CHECK.
    // Ein kuenftiger Rebuild von calendar_events muss die Spalte mitnehmen.
    up(database) {
      // Eine gedriftete Datenbank kann die Spalte schon tragen: dann nur noch
      // der Nachtrag.
      const hasColumn = database.prepare('PRAGMA table_info(calendar_events)').all()
        .some((column) => column.name === 'series_authored');
      if (!hasColumn) {
        database.exec(`
          ALTER TABLE calendar_events ADD COLUMN series_authored INTEGER NOT NULL DEFAULT 0
            CHECK(series_authored IN (0, 1));
        `);
      }

      backfillSeriesAuthored(database);
    },
  };
