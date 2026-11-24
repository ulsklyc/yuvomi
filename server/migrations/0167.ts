export default {
    version: 167,
    description: 'Calendar: color_modified tells a local recolour apart from any other edit (#899)',
    // WARUM EINE ZWEITE SPALTE UND NICHT WEITER user_modified. Das Flag wird bei
    // JEDER Bearbeitung eines gespiegelten Termins gesetzt (routes/calendar/
    // crud.js), der Inbound aller drei Anbieter liest es aber als "die Farbe
    // wird ab jetzt lokal gefuehrt". Wer den Titel aendert, friert damit die
    // Farbspalte dauerhaft ein: faerbt danach jemand denselben Termin auf dem
    // Server, erfaehrt Yuvomi es nie mehr (#899).
    //
    // Und weil dadurch "keine eigene Farbe" (#891) nicht von "wir haben nie eine
    // gelernt" zu unterscheiden war, konnte der Ausgang das Leeren einer Farbe
    // nicht spiegeln - ein hinausgeschicktes null haette die Farbe eines anderen
    // Clients abgeraeumt (#897/#898). Mit einem eigenen Zustand ist
    // `color IS NULL AND color_modified = 1` eindeutig "geleert".
    //
    // DER BACKFILL IST BEWUSST KONSERVATIV. `color_modified = user_modified`
    // uebernimmt die bisherige Bedeutung wortwoertlich: jede Zeile, deren Farbe
    // heute geschuetzt ist, bleibt geschuetzt. Ein pauschales 0 waere
    // verlockend - es nimmt genau den Fehler zurueck, um den es hier geht -,
    // ueberschriebe beim naechsten Sync aber auch jede Farbe, die jemand
    // absichtlich gesetzt hat. Die beiden sind in Bestandsdaten nicht
    // auseinanderzuhalten, und die absichtliche wegzuwerfen ist der teurere
    // Fehler: sie kommt von selbst nicht zurueck, die eingefrorene schon, sobald
    // der Termin einmal umgefaerbt wird.
    up: `
      ALTER TABLE calendar_events ADD COLUMN color_modified INTEGER NOT NULL DEFAULT 0;
      UPDATE calendar_events SET color_modified = user_modified;
    `,
  };
