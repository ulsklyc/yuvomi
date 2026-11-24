export default {
    version: 160,
    description: 'Quick links: household links as a tile row on the overview (#469)',
    up: `
      -- EINE KACHELREIHE, KEIN MODUL - und deshalb auch keine zweite Tabelle
      -- fuer Sammlungen, Tags oder Ordner. Der Thread zu #469 lief ueber beide
      -- Ambitionen: Schnellzugriff auf die anderen Dienste im Haus (#469) und
      -- eine Lesezeichen-Bibliothek (#759). Die zweite ist zugunsten der ersten
      -- geschlossen worden, weil vier Melder dasselbe wollten: Name, Adresse,
      -- Bild, und der Weg dorthin von der Startseite aus.
      --
      -- Wer spaeter doch eine Bibliothek will, findet hier die Zeilen, die er
      -- braucht - eine Sammlung waere eine Spalte, kein Umbau.
      CREATE TABLE IF NOT EXISTS quick_links (
        id          INTEGER PRIMARY KEY AUTOINCREMENT,
        name        TEXT    NOT NULL,
        url         TEXT    NOT NULL,

        -- WARUM EIN BILD UND KEIN FAVICON. Ein Favicon zu holen hiesse, dass
        -- der Haushalt bei jedem Aufbau der Startseite jeden verlinkten Host
        -- anspricht - also genau der leise Aussenverkehr, den diese App nicht
        -- macht. Ein hochgeladenes Bild bleibt hier liegen und spricht mit
        -- niemandem. Es steht als Data-URL in der Zeile, wie users.avatar_data
        -- schon seit v58: ein zweiter Dateispeicher fuer ein paar Kilobyte
        -- Kachelbild waere Betriebsaufwand ohne Gegenwert.
        icon_data   TEXT,

        -- Ohne Bild traegt die Kachel den Anfangsbuchstaben ihres Namens auf
        -- dieser Farbe - dieselbe Antwort, die ein Mitglied ohne Foto bekommt.
        -- Ein generisches Symbol waere die schlechtere: zwoelf gleiche Weltkugeln
        -- unterscheiden nichts, "J" auf Violett schon.
        color       TEXT,

        -- all | private. Die dritte Stufe der Aufgaben und Termine
        -- ("assignees") fehlt hier mit Absicht: ein Link wird niemandem
        -- zugewiesen, und eine Stufe, die nichts bedeuten kann, waere ein
        -- Versprechen, das die Oberflaeche nicht einloest.
        visibility  TEXT    NOT NULL DEFAULT 'all',

        created_by  INTEGER REFERENCES users(id),

        -- Die Reihenfolge ist Haushaltssache und wird gezogen, nicht sortiert:
        -- welcher Dienst zuerst steht, weiss nur die Familie.
        position    INTEGER NOT NULL DEFAULT 0,

        created_at  TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
        updated_at  TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
      );

      -- Der Lesepfad sortiert immer nach position und filtert ueber visibility
      -- plus created_by; das ist der eine Index, den er braucht.
      CREATE INDEX IF NOT EXISTS idx_quick_links_position ON quick_links(position);
    `,
  };
