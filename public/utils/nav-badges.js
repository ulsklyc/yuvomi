/**
 * DIE ZAHL AM NAV-ZIEL - EINMAL GEBAUT, EINMAL GEMERKT (#868).
 *
 * Gemeldet war: nach dem Anmelden fehlt das Badge mit den ueberfaelligen
 * Aufgaben und erscheint erst, wenn man die Aufgaben einmal geoeffnet hat.
 *
 * DAS IST KEIN ANZEIGEFEHLER, SONDERN DIE BAUART. Drei Module (Aufgaben,
 * Geburtstage, Inventar) bauten dasselbe Badge-DOM je einzeln nach - jeweils
 * dieselben zwanzig Zeilen, die den Icon-Wrapper nachruesten und die Zahl
 * anhaengen -, und sie taten es aus IHREM Zustand heraus. Ein Modul, das nie
 * gerendert wurde, hat keinen Zustand; also gab es kein Badge. Genauso fiel es
 * weg, wenn `rebuildNavigation()` die Navigation neu baute (Sprachwechsel,
 * Modul-Umschaltung, Kontowechsel): `replaceChildren()` warf die Badges mit
 * weg, und sie kamen erst beim naechsten Modul-Rendern wieder.
 *
 * ── ZWEI DINGE, DIE HIER ZUSAMMENKOMMEN ───────────────────────────────────
 *
 * 1. DER SPEICHER. Ein Badge ist ab jetzt ein gemerkter WERT, kein DOM-Effekt.
 *    `applyNavBadges()` malt ihn nach jedem Neuaufbau der Navigation wieder
 *    hin - dieselbe Rolle, die `applyUpdateBadge()` im Router fuer den
 *    Aktualisierungspunkt spielt.
 * 2. DAS ZEICHNEN. Einmal, hier. Wer eine vierte Zahl ans Nav haengen will,
 *    ruft `setNavBadge()` und erbt Icon-Wrapper, Zugaenglichkeitsname und
 *    Deckelung, statt sie ein viertes Mal nachzubauen.
 *
 * ── WORAUS DIE ZAHL KOMMT ─────────────────────────────────────────────────
 *
 * Aus zwei Quellen, und das ist Absicht:
 *   - beim Start aus `/dashboard`, das die Zahlen ohnehin mitliefert. Das ist
 *     der Fix fuer den gemeldeten Fall.
 *   - danach aus dem Modul selbst, sobald es seine Liste hat. Eine Aufgabe,
 *     die man gerade abgehakt hat, soll die Zahl SOFORT senken und nicht erst
 *     nach einem Roundtrip.
 * Beide schreiben in denselben Speicher, also gewinnt immer die juengste
 * Angabe - und nicht die, die zufaellig zuletzt gerendert hat.
 *
 * ── DER NAME BLEIBT EINE ANSAGE, KEINE ZIFFER ─────────────────────────────
 *
 * Das Badge selbst ist `aria-hidden`: „3" neben „Aufgaben" vorgelesen ergibt
 * keinen Satz. Die Ansage steckt im `aria-label` des Ziels („Aufgaben, 3
 * ueberfaellig"), und weil die Beschriftung von der Sprache abhaengt, wird sie
 * als FUNKTION gemerkt und bei jedem Zeichnen neu ausgewertet. Ein fertiger
 * String stuende nach einem Sprachwechsel in der alten Sprache da.
 */

// Route → { count, label }. `label` ist eine Funktion, siehe oben.
const badges = new Map();

// Ab hier zeigt das Badge „99+". Zweistellig ist die Zahl noch eine Zahl;
// dreistellig ist sie ein Balken neben dem Icon.
const MAX_VISIBLE = 99;

/**
 * Ab wie vielen Tagen Naehe ein Geburtstag ans Nav-Ziel gehoert.
 *
 * Hier und nicht in birthdays.js, obwohl sie dort gebraucht wird: den
 * Startwert setzt der Router aus der `/dashboard`-Antwort, und er darf dafuer
 * nicht das ganze Geburtstagsmodul laden. Zwei Literale liefen genau bei der
 * einen Aenderung auseinander, bei der es auffaellt.
 */
export const BIRTHDAY_BADGE_DAYS = 3;

/**
 * Der Anker, an dem das Badge haengt: eine Huelle um das Icon, damit die Zahl
 * an dessen Ecke sitzt und nicht an der des ganzen Nav-Eintrags. Sie wird
 * nachgeruestet, falls die Nav-Vorlage sie nicht schon mitbringt.
 */
function iconWrap(navItem) {
  const existing = navItem.querySelector('.nav-item__icon-wrap');
  if (existing) return existing;

  const wrap = document.createElement('span');
  wrap.className = 'nav-item__icon-wrap';
  const icon = navItem.querySelector('.nav-item__icon');
  if (icon) {
    icon.replaceWith(wrap);
    wrap.appendChild(icon);
  } else {
    navItem.prepend(wrap);
  }
  return wrap;
}

/**
 * NUR DIE NAVIGATION, NICHT JEDER LINK MIT DIESER ROUTE.
 *
 * `data-route` ist app-weit der Weg, einem beliebigen Element eine Route zu
 * geben - Widget-Kacheln, Cockpit-Karten, Kurzwahl-Knoepfe im FAB-Menue tragen
 * es genauso wie die Nav-Ziele. Ein Selektor ueber das ganze Dokument haengte
 * die Zahl also in die Seite hinein: gemessen bekam der Aufgaben-Knopf im
 * FAB-Menue eine Icon-Huelle samt Badge, und sein Name wurde mit „Aufgaben, 3
 * ueberfaellig" ueberschrieben.
 *
 * Nach CONTAINER und nicht nach Item-Klasse: „in der Navigation" ist die
 * Aussage, und sie ueberlebt eine Umbenennung von `.nav-item`. Das Mehr-Blatt
 * steht bewusst NICHT dabei - seine Kacheln fuehren ihre eigenen Zaehler
 * (`.more-item__badge`, siehe `paintMoreSheetBadges` im Router), und die
 * beantworten eine andere Frage.
 */
const NAV_SCOPES = '.nav-sidebar, .nav-bottom';

function navTargets(route) {
  return [...document.querySelectorAll(NAV_SCOPES)]
    .flatMap((scope) => [...scope.querySelectorAll(`[data-route="${route}"]`)]);
}

function paint(route, entry) {
  navTargets(route).forEach((navItem) => {
    navItem.querySelectorAll('.nav-badge').forEach((el) => el.remove());

    const label = entry?.label?.(entry.count ?? 0);
    if (label) navItem.setAttribute('aria-label', label);

    if (!entry || !(entry.count > 0)) return;

    const badge = document.createElement('span');
    // Die VALENZ gehoert zur Zahl (Critique 2026-08-27): Danger ist der
    // Default und meint eine gerissene Frist (ueberfaellige Aufgaben).
    // Ein anstehender Geburtstag ist eine Nachricht (accent, dieselbe
    // Begruendung wie der Update-Punkt: „eine Nachricht, kein Alarm"), eine
    // ablaufende Inventar-Frist eine Warnung. Drei Aussagen in einem
    // Alarm-Rot erzogen dazu, das Rot zu ueberblaettern.
    badge.className = `nav-badge${entry.tone ? ` nav-badge--${entry.tone}` : ''}`;
    // Die Ansage steht im Namen des Ziels - siehe Modulkopf.
    badge.setAttribute('aria-hidden', 'true');
    badge.textContent = entry.count > MAX_VISIBLE ? `${MAX_VISIBLE}+` : String(entry.count);
    iconWrap(navItem).appendChild(badge);
  });
}

/**
 * Die Zahl an einem Nav-Ziel setzen.
 *
 * @param {string} route - der `data-route`-Wert des Ziels, z. B. '/tasks'.
 * @param {number} count - 0 oder weniger entfernt das Badge.
 * @param {(count: number) => string} [label] - der Zugaenglichkeitsname des
 *   ZIELS (nicht des Badges), als Funktion: er haengt an der Sprache und wird
 *   bei jedem Zeichnen neu ausgewertet. Er bekommt die Zahl uebergeben, damit
 *   dieselbe Funktion den leeren Fall mit beantworten kann.
 * @param {'accent'|'warning'} [tone] - die Valenz der Zahl. Ohne Angabe Danger
 *   (gerissene Frist); 'warning' fuer eine ablaufende Frist, 'accent' fuer
 *   eine Nachricht (Geburtstag - siehe paint()).
 */
export function setNavBadge(route, count, label, tone) {
  const entry = { count: Number(count) || 0, label, tone };
  badges.set(route, entry);
  paint(route, entry);
}

/**
 * Alle gemerkten Zahlen neu zeichnen.
 *
 * Der Router ruft das nach jedem Neuaufbau der Navigation. Ohne diesen Aufruf
 * ueberlebte kein Badge einen Sprachwechsel oder das Ein-/Ausschalten eines
 * Moduls - `replaceChildren()` wirft sie mit weg.
 */
export function applyNavBadges() {
  for (const [route, entry] of badges) paint(route, entry);
}

/** Welche Routen gerade eine gemerkte Zahl tragen. */
export function navBadgeRoutes() {
  return [...badges.keys()];
}

/**
 * Sitzungsende. Die Zahlen gehoeren der SITZUNG, nicht dem Geraet - dieselbe
 * Ueberlegung wie bei den Zaehlstaenden der Modulkacheln im Router: sonst
 * baute die naechste Anmeldung am selben Geraet ihre Badges aus den Zahlen des
 * vorigen Mitglieds.
 */
export function resetNavBadges() {
  badges.clear();
}

/**
 * WELCHE ZAHL AN WELCHER MODULKACHEL STEHT - abgeleitet aus der
 * `/dashboard`-Antwort, ohne den Router.
 *
 * SIE STAND BIS #868 MITTEN IM ROUTER, und das war nicht nur unordentlich: sie
 * rief dort ein `isAdmin()`, das es in jener Datei nie gab (die Funktion lebt
 * modul-lokal in pages/rewards.js). Der Aufruf warf also bei JEDEM Durchlauf,
 * ein `catch` schluckte den ReferenceError, und die Zaehlstaende der
 * Modulkacheln kamen nie an. Niemand sah es, weil ein Blatt ohne Badges
 * genauso aussieht wie eines ohne wartende Arbeit.
 *
 * Hier ist sie eine reine Ableitung: Nutzlast rein, Zahlen raus. Die beiden
 * Fragen, die sie ueber den Betrachter stellen muss, kommen als Parameter -
 * damit ein Test sie beantworten kann, statt eine halbe Shell nachzubauen.
 *
 * @param {object} data - die `/dashboard`-Antwort.
 * @param {{isAdmin?: boolean, shoppingVisible?: boolean}} viewer
 */
export function moduleCountsFrom(data, { isAdmin = false, shoppingVisible = false } = {}) {
  const openDoses = Math.max(0, (data?.health?.dosesTotal ?? 0)
    - (data?.health?.dosesTaken ?? 0) - (data?.health?.dosesSkipped ?? 0));
  const counts = {
    tasks: data?.openTaskCount ?? 0,
    shopping: data?.shoppingOpenCount ?? 0,
    /* NUR FUER ELTERN. `rewards.pending` zaehlt serverseitig JEDE offene Anfrage
     * des Haushalts, waehrend die Belohnungsseite einem Nicht-Admin nur die
     * EIGENEN zeigt: hat ein Geschwister eine offene Anfrage und man selbst
     * keine, warb das Badge mit Arbeit, hinter der nichts stand (Codex-Review
     * zu PR #754). Eine mitgliedseigene Zahl gaebe es nur mit einem neuen Feld
     * in der Nutzlast; bis dahin ist keine Zahl richtiger als eine falsche. */
    rewards: isAdmin ? (Number(data?.rewards?.pending) || 0) + (Number(data?.rewards?.moneyPending) || 0) : 0,
    health: openDoses,
  };
  /* Die Küche ist im mobilen Menü EIN Ziel für vier Module; was dort wartet,
   * ist der Einkaufszettel.
   *
   * NUR WENN DER EINKAUF DIESEM MITGLIED AUCH OFFENSTEHT. Die Kachel ist die
   * einzige, die einen FREMDEN Modulzähler tragen kann - die anderen erscheinen
   * gar nicht erst, wenn ihr Modul fehlt, diese hier bleibt stehen, solange
   * eines der vier da ist. Der Server zählt `shoppingOpenCount` ungefiltert über
   * den ganzen Haushalt (`routes/dashboard.js`), also warb die Kachel mit
   * Arbeit in einem Modul, das sich nicht öffnen lässt, und führte beim Antippen
   * nach Mahlzeiten (Codex-Review zu PR #754). */
  counts.kitchen = shoppingVisible ? counts.shopping : 0;
  return counts;
}

/**
 * Welche Zahl an welchem NAV-ZIEL steht - dieselbe Nutzlast, andere Frage.
 *
 * Nicht dieselben Zahlen wie an den Modulkacheln, und das ist Absicht: die
 * Kachel im Mehr-Blatt sagt „7 offen", das Nav-Icon sagt „3 ueberfaellig". Wer
 * das vereinheitlichen will, aendert eine Produktentscheidung, keine Mechanik.
 *
 * Was hier (noch) FEHLT, ausgesprochen statt verschwiegen: das INVENTAR. Seine
 * Zahl ist „wie viele Gegenstaende haben eine ablaufende Frist", und die
 * beantwortet `/dashboard` nicht - das Modul hat dort keinen Block. Sein Badge
 * erscheint deshalb weiterhin erst nach dem ersten Besuch; es ueberlebt seit
 * #868 immerhin einen Neuaufbau der Navigation. Der saubere Weg dorthin ist
 * ein Zaehler in der Nutzlast, nicht eine zweite Rechnung im Browser.
 *
 * @returns {{ '/tasks': number, '/birthdays': number }}
 */
export function navBadgeCountsFrom(data) {
  return {
    '/tasks': data?.overdueTaskCount ?? 0,
    /* AUS DEM EIGENEN ZAEHLER, NICHT AUS DER LISTE. `data.birthdays` ist auf
     * fuenf geschnitten - das ist der Vorrat der Dashboard-Kachel, keine
     * Aussage ueber den Bestand. Wer daraus zaehlte, gaebe einem Haushalt mit
     * sieben Geburtstagen in drei Tagen beim Start eine Fuenf und nach dem
     * ersten Besuch der Seite eine Sieben. */
    '/birthdays': data?.birthdaySoonCount ?? 0,
  };
}
