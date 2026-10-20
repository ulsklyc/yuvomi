/**
 * Modul: Layout-Hinweis der Uebersicht (Skelett-Vorhersage)
 * Zweck: Haelt die Kachelformen des zuletzt geladenen Dashboards, damit das
 *        Skelett das Raster zeichnet, das gleich kommt - und nicht das
 *        Standardraster, das dann umspringt (Critique R1, A10).
 *
 * WARUM DAS EIN EIGENES MODUL IST UND NICHT IN dashboard.js BLEIBT.
 * Der Hinweis liegt im localStorage und gilt damit dem GERAET, nicht dem Konto.
 * Solange die Anordnung haushaltweit war, war das richtig: alle sahen ohnehin
 * dasselbe Raster. Seit sie jeder Person gehoert (#585), ist derselbe Eintrag
 * am geteilten Familientablett eine Vorhersage ueber den vorigen Nutzer - genau
 * der „kurze falsche Bildschirm", den er verhindern soll. Er muss deshalb beim
 * Abmelden mit weg, und das passiert in `auth.logout()`, wo der API-Cache aus
 * demselben Grund schon verworfen wird. Ein Modul, das beide importieren
 * koennen, ist der Preis dafuer, dass der Schluessel nur an einer Stelle steht.
 *
 * Er bleibt eine VORHERSAGE, keine Quelle: die Wahrheit ist die Serverantwort,
 * und ein veralteter oder kaputter Eintrag faellt still auf den Standard zurueck.
 *
 * UND WARUM NICHT IN utils/dashboard-widgets.js, wo die uebrige Widget-Logik
 * liegt: jene Datei ist ausdruecklich die Teilmenge, die OHNE Browser-Umgebung
 * entscheidbar ist, und wird genau deshalb direkt aus node:test importiert.
 * `localStorage` gehoert nicht hinein. Die Standardformen kommen deshalb als
 * Parameter herein, statt dass dieses Modul die Default-Konfiguration kennt.
 */

const LAYOUT_HINT_KEY = 'yuvomi-dash-layout-hint';

/** Der gespeicherte Hinweis, in beiden Formen: Alt-Eintraege sind ein Array. */
function readHint() {
  try {
    const stored = JSON.parse(localStorage.getItem(LAYOUT_HINT_KEY) ?? 'null');
    if (Array.isArray(stored)) return { sizes: stored, query: null, listRows: null };
    if (stored && typeof stored === 'object') {
      return { sizes: stored.sizes, query: stored.query ?? null, listRows: stored.listRows ?? null };
    }
  } catch { /* unlesbar: Standard */ }
  return { sizes: null, query: null, listRows: null };
}

/**
 * Merkt sich die Kachelformen der sichtbaren Widgets (duenn: nur die Form) und
 * den Abfragepfad, den diese Anordnung erzeugt.
 *
 * WARUM DER PFAD MITKOMMT (#814): welche Filter gelten, steht in den
 * Praeferenzen, und die kommen mit derselben Antwort wie die Uebersicht selbst -
 * die erste Abfrage weiss also noch nichts von ihnen. Ohne diesen Hinweis
 * zahlte jeder, der Optionen gesetzt hat, bei jedem Kaltstart eine zweite
 * Abfrage. Er bleibt eine Vorhersage wie die Formen darueber: stimmt er nicht
 * mehr, holt die Seite nach, bevor sie zeichnet.
 *
 * UND DIE LISTENZEILEN (#2087, Codex-Review zu PR #2117): eine hohe
 * Kalenderkachel mit acht oder zwoelf Terminen belegt drei oder vier
 * Rasterzeilen, obwohl ihre Groesse 1x2 bleibt. Die Groesse allein sagte dem
 * Skelett zwei Zeilen voraus, und beim Laden wuchs die Kachel um eine oder
 * zwei. `listRowsOf` liefert je Kachel die Zahl, die das Raster als
 * `data-list-rows` traegt, oder nichts; welche Kachel das kennt, weiss
 * dashboard.js, nicht dieses Modul. Ein Eintrag ohne das Feld (vor #2087)
 * bleibt gueltig und sagt nur die Groessen voraus.
 *
 * @param {object[]} cfg     Widget-Konfiguration
 * @param {string} [query]   Abfragepfad zu dieser Konfiguration
 * @param {(w: object) => (number|null)} [listRowsOf] Listenzeilen je Kachel
 */
export function rememberLayoutHint(cfg, query = null, listRowsOf = () => null) {
  try {
    const visible = cfg.filter((w) => w.visible);
    const listRows = visible.map((w) => listRowsOf(w) ?? 0);
    localStorage.setItem(LAYOUT_HINT_KEY, JSON.stringify({
      sizes: visible.map((w) => w.size),
      ...(query ? { query } : {}),
      ...(listRows.some(Boolean) ? { listRows } : {}),
    }));
  } catch { /* z.B. voller oder gesperrter Speicher: der Hinweis ist entbehrlich */ }
}

/**
 * Gemerkte Kachelformen samt Listenzeilen, sonst die uebergebenen
 * Standardformen ohne. Die Listenzeilen gelten nur zusammen mit den gemerkten
 * Groessen und nur als ganze Zahl je Kachel - alles andere ist 0 (keine
 * Angabe), denn der Wert landet im Markup des Skeletts.
 *
 * @returns {{ sizes: string[], listRows: number[] }}
 */
export function layoutHintTiles(fallbackSizes) {
  const { sizes, listRows } = readHint();
  if (!(Array.isArray(sizes) && sizes.length && sizes.every((s) => typeof s === 'string'))) {
    return { sizes: fallbackSizes, listRows: fallbackSizes.map(() => 0) };
  }
  const rows = Array.isArray(listRows) && listRows.length === sizes.length ? listRows : [];
  return { sizes, listRows: sizes.map((_, i) => (Number.isInteger(rows[i]) && rows[i] > 0 ? rows[i] : 0)) };
}

/** Gemerkte Formen, sonst die uebergebenen Standardformen. */
export function layoutHintSizes(fallbackSizes) {
  return layoutHintTiles(fallbackSizes).sizes;
}

/** Gemerkter Abfragepfad, sonst der uebergebene Standardpfad. */
export function layoutHintQuery(fallbackQuery) {
  const { query } = readHint();
  // Nur ein Pfad der eigenen Route, nie ein fremdes Ziel: der Eintrag liegt im
  // localStorage und ist damit beschreibbar von allem, was auf dieser Seite
  // laeuft.
  return typeof query === 'string' && query.startsWith('/dashboard') ? query : fallbackQuery;
}

/** Beim Abmelden: der naechste Nutzer an diesem Geraet hat sein eigenes Raster. */
export function forgetLayoutHint() {
  try {
    localStorage.removeItem(LAYOUT_HINT_KEY);
  } catch { /* gesperrter Speicher: dann bleibt hoechstens ein Skelett falsch */ }
}
