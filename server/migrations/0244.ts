// @ts-nocheck - eingefrorene Migration (append-only): Typen nachziehen hiesse den Text aendern.

export default {
    version: 244,
    description: 'Displays: the photo screensaver is switched on per display by an administrator (#1766)',
    // OB EIN WANDTABLETT DEN FOTO-SCHONER ZEIGT, ENTSCHEIDET EIN ADMINISTRATOR,
    // JE DISPLAY (#1766, PR #1793). Ohne diese Spalte haette jedes gekoppelte
    // Tablett in einem Haushalt mit Immich nach fuenf Minuten Fotos gezeigt -
    // und ein Display aendert keine Einstellungen: die Wartezeit kennt kein
    // "nie", und die Display-Oberflaeche hat keine Einstellungen. Ein
    // Haushaltsschalter (Modul) koennte die Kueche nicht vom Flur
    // unterscheiden, deshalb steht die Wahl am Display.
    //
    // DEFAULT 0, KEIN BACKFILL: ein Display, das bisher den Kalender zeigte,
    // zeigt ihn nach dem Update weiter. Bei 0 sperrt das Gate in
    // server/index.js die beiden Bildrouten, nicht erst die Seite.
    //
    // Der CHECK geht mit ADD COLUMN, weil der Default konstant ist und den
    // Ausdruck erfuellt. Ein kuenftiger Rebuild von display_accounts muss die
    // Spalte samt CHECK mitnehmen.
    up: `
      ALTER TABLE display_accounts ADD COLUMN show_screensaver INTEGER NOT NULL DEFAULT 0 CHECK(show_screensaver IN (0, 1));
    `,
  };
