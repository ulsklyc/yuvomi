export default {
    version: 163,
    description: 'Quick links: a built-in symbol as a third face, next to image and monogram (#873)',
    up: `
      -- DAS DRITTE GESICHT EINER KACHEL (#873).
      --
      -- Gemeldet war: "It's just an icon and as heavy self-hoster I don't want
      -- to search and fetch icons from somewhere, I would like to have it just
      -- built-in Yuvomi." Bisher gab es zwei Gesichter - ein hochgeladenes Bild
      -- (icon_data, v160) oder den Anfangsbuchstaben auf der gewaehlten Farbe.
      -- Wer weder das eine wollte noch das andere, hatte keine dritte Wahl.
      --
      -- WARUM EIN NAME UND KEIN ZWEITES BILD. Hier steht der Lucide-Name des
      -- Symbols ("film", "server", "cloud"), nicht seine Zeichnung: den Vorrat
      -- bringt public/lucide.min.js ohnehin mit, auf jeder Seite, fuer die
      -- ganze App. Ein Symbol kostet damit die Laenge seines Namens statt der
      -- zwanzig bis vierzig Kilobyte einer Data-URL - und es bleibt scharf,
      -- faerbt mit und folgt dem Hell/Dunkel-Wechsel, was ein Rasterbild nicht
      -- kann.
      --
      -- KEIN CHECK AUF EINE NAMENSLISTE. Der Server kennt den Lucide-Vorrat
      -- nicht und soll ihn nicht kennen: eine Liste von 1743 Namen in der
      -- Datenbank waere eine zweite Wahrheit, die bei jedem Lucide-Update
      -- veraltet. Ein unbekannter Name bricht nichts - die Kachel zeigt dann
      -- ihren Buchstaben, genau wie ohne Eintrag. Geprueft wird nur die FORM
      -- (Kleinbuchstaben, Ziffern, Bindestriche), und die ist die
      -- Sicherheitsgrenze; siehe iconName() in server/routes/quick-links.js.
      --
      -- WELCHES GESICHT GEWINNT, wenn beide Spalten gefuellt sind, entscheidet
      -- der Lesepfad und nicht das Schema: das Bild. Wer eines hochgeladen hat,
      -- hat die aufwendigere Wahl getroffen. Ein CHECK, der nur eine der beiden
      -- Spalten zulaesst, waere strenger als noetig und machte aus dem Wechsel
      -- zwischen den Gesichtern zwei Schreibvorgaenge statt einem.
      ALTER TABLE quick_links ADD COLUMN icon_name TEXT;
    `,
  };
