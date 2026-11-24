export default {
    version: 240,
    description: 'Calendar: a pending deletion can carry the ETag of the entry it was queued for (#1883)',
    // EIN LOESCHAUFTRAG, DER WARTET, KANNTE NUR DIE ADRESSE SEINES OBJEKTS. Der
    // Auftrag aus einem Umzug, dessen Quelle ihr Loeschen abgelehnt hat (#1861),
    // wartet ueber Laeufe hinweg; liegt der Termin dann wieder im alten Kalender
    // (auf einem anderen Geraet zurueckgeschoben), traf ihn der naechste Versuch,
    // und er war in beiden Kalendern fort.
    //
    // `etag` ist der Stand des Objekts, fuer den der Auftrag vorgemerkt wurde.
    // Traegt ein Auftrag einen, gilt er genau diesem Objekt in genau diesem
    // Stand: das DELETE geht mit ihm als If-Match hinaus, und ein anderer Stand
    // verwirft den Auftrag. NULL heisst "gleich in welchem Stand" - das Loeschen
    // durch den Nutzer und jeder Auftrag von vor dieser Migration; fuer sie
    // aendert sich nichts.
    up: `
      ALTER TABLE calendar_pending_deletions ADD COLUMN etag TEXT;
    `,
  };
