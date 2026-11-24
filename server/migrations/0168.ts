// @ts-nocheck - eingefrorene Migration (append-only): Typen nachziehen hiesse den Text aendern.

export default {
    version: 168,
    description: 'Users: onboarding walkthrough remembered per account instead of per browser',
    // WARUM PRO KONTO UND NICHT PRO GERAET. Der Merker lag bisher allein in
    // localStorage: ein neues Geraet oder ein privates Fenster kennt ihn nicht
    // und zeigt die Einfuehrung erneut, obwohl das Konto sie laengst gesehen
    // hat - genau das war gemeldet.
    //
    // EINE ZAHL STATT EINES SCHALTERS, weil "gesehen" allein keine spaetere
    // Erweiterung erlaubt: bringt eine kuenftige Version eine grosse
    // Verhaltensaenderung, die eine erneute Einfuehrung rechtfertigt, hebt ein
    // Wartungscommit nur CURRENT_ONBOARDING_VERSION in server/auth.js an, und
    // jedes Konto mit einer kleineren gespeicherten Zahl sieht sie erneut -
    // ohne eine weitere Migration.
    //
    // DER BACKFILL LAEUFT AUF 1, NICHT AUF 0: Bestandskonten haben die
    // Einfuehrung (in ihrer bisherigen, geraetegebundenen Form) bereits
    // gesehen und sollen sie nicht erneut bekommen, nur weil der Merker jetzt
    // im Konto statt im Browser lebt. Die Spalten-DEFAULT bleibt 0 (= "noch
    // nicht gesehen"), damit jedes kuenftige INSERT INTO users - und davon
    // gibt es mehrere Stellen im Code - ohne eigene Aenderung das richtige
    // Verhalten fuer ein neues Konto bekommt.
    up: `
      ALTER TABLE users ADD COLUMN onboarding_version INTEGER NOT NULL DEFAULT 0;
      UPDATE users SET onboarding_version = 1;
    `,
  };
