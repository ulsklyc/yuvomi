// @ts-nocheck - eingefrorene Migration (append-only): Typen nachziehen hiesse den Text aendern.

export default {
    version: 248,
    description: 'calendar: an event remembers what its last aligned push sent',
    // DER ABRUF ERKENNT DAS ECHO DES EIGENEN PUSHS (#1956). Eine hier verfasste
    // Serie geht mit einem Start hinaus, den ihre Regel trifft (#986, #1935):
    // eingegeben am 15. Januar, beim Anbieter der 31. Der Abruf las genau das
    // zurueck und schrieb es in die Zeile - die Eingabe war weg, die Marke fiel
    // und die Erinnerungen zogen mit, ohne dass beim Anbieter jemand etwas
    // getan hatte.
    //
    // `outbound_snapshot` haelt, was der letzte Push gesendet hat, in der
    // Lesart des Abrufs, und den Zeilenstand, aus dem er entstand (JSON, Regel
    // und Leser: services/outbound-echo.js). Geschrieben nur, wenn das
    // Ausrichten den Start verschoben hat; sonst NULL. Bestandszeilen bleiben
    // NULL und nehmen den Weg von vorher, bis ihr naechster Push sie schreibt -
    // ein Nachtrag liesse sich nicht ableiten, denn was gesendet wurde, steht
    // nirgends.
    up(database) {
      const columns = new Set(database.prepare('PRAGMA table_info(calendar_events)').all().map((c) => c.name));
      if (!columns.has('outbound_snapshot')) database.exec('ALTER TABLE calendar_events ADD COLUMN outbound_snapshot TEXT');
    },
  };
