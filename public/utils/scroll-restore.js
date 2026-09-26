/**
 * Modul: Scroll-Restoration für den SPA-Router
 * Zweck: Merkt den Scrollstand je Pfad, damit eine Navigation oben beginnt und
 *   ein Browser-Zurück dort weitermacht, wo der Nutzer stand.
 * Abhängigkeiten: keine (bewusst DOM-frei, damit direkt testbar)
 */

// Der Scrollport der App überlebt jede Navigation: `#main-content` IST
// `.app-content` (renderAppShell), und renderPage() tauscht nur dessen Inhalt
// per replaceChildren(). Der Knoten behält damit den Scrollstand der Vorseite,
// und die Zielseite öffnete mitten im Bestand - gemessen 2026-08-02 auf 375x812:
// von der Übersicht (scrollTop 1267) auf /tasks gewechselt, dort weiterhin 1267
// bei scrollHeight 2185. Auffällig wird das nur, wenn die Zielseite mindestens
// so lang ist wie die Vorseite war; sonst klemmt der Browser die Position selbst
// auf das neue Maximum, und der Fehler versteckt sich hinter dem Zufall.
//
// DIE RICHTUNG ENTSCHEIDET, NICHT DIE SEITENTRANSITION. Ein eigener Aufruf
// (pushState) heißt „neue Seite, oben anfangen"; Browser-Zurück/-Vor (popstate)
// heißt „dorthin, wo ich war". Die Slide-Richtung nach Nav-Reihenfolge, die der
// Router bis 2026-09-26 fuer seinen Seitenwechsel rechnete, taugte dafür nie: sie
// lieferte 'left' genauso für einen Vorwärts-Tap auf einen weiter links liegenden
// Nav-Eintrag (der Wechsel ist seitdem eine Blende ohne Richtung). Maßgeblich ist
// allein das pushState-Flag von navigate() - false kommt nur vom popstate-
// Handler und vom Erstladen, und beim Erstladen ist die Map leer.
//
// MERKEN STATT NUR NICHT-ZURÜCKSETZEN. Ein „bei popstate einfach nichts tun"
// bewahrt nicht die Position der Zielseite, sondern die der Seite, von der man
// gerade kommt - dass das gelegentlich gleich aussieht, ist Zufall.
//
// REICHWEITE: Das Merken hängt am Scrollstand von `#main-content`. Acht
// Modul-Roots (.budget-page, .calendar-page, .contacts-page, .meals-page,
// .notes-page, .pantry-page, .recipes-page, .shopping-page) sind `overflow:
// hidden` auf voller Höhe und scrollen einen inneren Container; dort steht
// `#main-content` immer auf 0, es gibt also nichts zu merken und ein Zurück
// landet oben. Das OBEN-ANFANGEN stimmt trotzdem überall - jene inneren
// Container entstehen bei jeder Navigation neu und starten zwangsläufig bei 0.
//
// Warum nicht einfach der erste scrollbare Nachfahre: den müsste man nach dem
// Render wiederfinden, und ein aus Klassen abgeleiteter Selektor bricht beim
// nächsten Umbau still. Der Weg dahin führt über ein Modul, das seinen
// Scrollbereich benennt (Attribut), nicht über einen ratenden Router.
//
// Schlüssel ist der Pfad, nicht der History-Eintrag. Wer eine Route zweimal in
// derselben Historie besucht, teilt sich damit einen Eintrag: nach zweimal
// Zurück trägt der erste Besuch die Position des zweiten. Das kostet einen
// Sprung an eine falsche Stelle derselben Seite, wo es vorher gar keine
// Wiederherstellung gab - ein Schlüssel in `history.state` wäre die Antwort,
// wenn das jemandem auffällt.
const positions = new Map();

/**
 * Hält den Scrollstand eines Pfades fest, bevor er verlassen wird.
 * @param {string} path - Pfad ohne Query (Routen-Schlüssel)
 * @param {number} top - scrollTop des Scrollports
 */
export function rememberScrollPosition(path, top) {
  if (typeof path !== 'string' || !path) return;
  const value = Number(top);
  // Oben stehende Seiten nicht eintragen: der Default liefert dieselbe 0, und
  // die Map bleibt auf die Pfade beschränkt, bei denen es etwas zu merken gibt.
  if (!Number.isFinite(value) || value <= 0) {
    positions.delete(path);
    return;
  }
  positions.set(path, value);
}

/**
 * Zielposition für eine Navigation.
 * @param {string} path - Zielpfad ohne Query
 * @param {{ restore?: boolean }} options - restore=true nur bei popstate
 * @returns {number} scrollTop, auf den der Scrollport gesetzt werden soll
 */
export function scrollPositionFor(path, { restore = false } = {}) {
  if (!restore) return 0;
  return positions.get(path) ?? 0;
}

/** Verwirft alle gemerkten Positionen (Sitzungsende, Tests). */
export function forgetScrollPositions() {
  positions.clear();
}
