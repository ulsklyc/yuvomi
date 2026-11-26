export default {
    version: 269,
    description: 'users: a member colour is #RRGGBB or the default',
    // Die Mitgliedsfarbe steht bei allen Mitgliedern in einem style-Attribut.
    // Bis hierher nahmen Profil, Mitgliederverwaltung und Haushaltshilfe jede
    // Zeichenkette an; ab jetzt nur #RRGGBB. Was vorher schon drinstand und
    // kein HEX ist, faellt auf den Standard von PATCH /me/profile zurueck.
    up: `
      UPDATE users SET avatar_color = '#007AFF'
       WHERE avatar_color NOT GLOB '#[0-9A-Fa-f][0-9A-Fa-f][0-9A-Fa-f][0-9A-Fa-f][0-9A-Fa-f][0-9A-Fa-f]';
    `,
  };
