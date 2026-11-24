// @ts-nocheck - eingefrorene Migration (append-only): Typen nachziehen hiesse den Text aendern.

export default {
    version: 173,
    description: 'Users: the changelog marks are remembered per account instead of per browser (#496)',
    // DIESELBE LEHRE WIE BEI MIGRATION 168. Der Merker lag allein in
    // localStorage, also weiss ein zweites Geraet nichts davon: wer die
    // Aenderungen am Rechner gelesen hat, bekommt auf dem Tablet denselben
    // Punkt und dieselbe "Neu in deiner App"-Liste noch einmal. Beim Onboarding
    // war genau das gemeldet worden; hier habe ich es im Thread selbst als
    // offene Kante benannt, bevor es jemand melden musste.
    //
    // ZWEI SPALTEN, WEIL ES ZWEI FRAGEN SIND:
    //   changelog_seen_version  die INSTALLIERTE Version beim letzten Blick.
    //                           Beantwortet "was hat sich fuer mich geaendert" -
    //                           die Liste zaehlt nur Releases, die hier auch
    //                           laufen.
    //   changelog_seen_latest   die zuletzt bekannte VEROEFFENTLICHTE Version.
    //                           Beantwortet "gibt es draussen etwas Neueres" -
    //                           der Punkt an der Navigation.
    // Sie in eine zu legen hiesse, eine der beiden Fragen falsch zu
    // beantworten, sobald die Instanz hinter dem Release herlaeuft.
    //
    // WAS NICHT WANDERT: der zuletzt von GitHub gemeldete Stand und der
    // Zeitpunkt der letzten Abfrage. Das ist ein Zwischenspeicher fuer eine
    // Auskunft des Servers, kein Zustand einer Person - er darf je Geraet
    // eigenstaendig altern.
    //
    // NULL heisst "noch nie hingesehen", und das ist ein anderer Zustand als
    // "alles gesehen": die "Neu bei dir"-Liste bleibt beim ersten Blick
    // bewusst leer, statt die gesamte Geschichte als verpasst auszugeben.
    up: `
      ALTER TABLE users ADD COLUMN changelog_seen_version TEXT;
      ALTER TABLE users ADD COLUMN changelog_seen_latest  TEXT;
    `,
  };
