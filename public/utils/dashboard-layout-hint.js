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
    if (Array.isArray(stored)) return { sizes: stored, query: null, spans: null };
    if (stored && typeof stored === 'object') {
      return { sizes: stored.sizes, query: stored.query ?? null, spans: stored.spans ?? null };
    }
  } catch { /* unlesbar: Standard */ }
  return { sizes: null, query: null, spans: null };
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
 * UND DIE HOEHEN (U1 b, DW-P1-3; vorher die Listenstufe der Kalenderkachel,
 * #2087): seit jede Kachel so hoch ist wie ihre Daten, sagt die Groesse dem
 * Skelett die Hoehe nicht mehr voraus - eine 1x2-Liste mit zwei Eintraegen
 * ist halb so hoch wie eine mit fuenf. `spanOf` liefert je Kachel die Spuren
 * (`data-span-rows`), die sie beim letzten Zeichnen belegt hat, oder nichts;
 * welche das sind, weiss dashboard.js, nicht dieses Modul. Ein Eintrag ohne
 * das Feld (vor U1 b) bleibt gueltig und sagt nur die Groessen voraus.
 *
 * @param {object[]} cfg     Widget-Konfiguration
 * @param {string} [query]   Abfragepfad zu dieser Konfiguration
 * @param {(w: object) => (number|null)} [spanOf] Rasterspuren je Kachel
 */
export function rememberLayoutHint(cfg, query = null, spanOf = () => null) {
  try {
    const visible = cfg.filter((w) => w.visible);
    const spans = visible.map((w) => spanOf(w) ?? 0);
    localStorage.setItem(LAYOUT_HINT_KEY, JSON.stringify({
      sizes: visible.map((w) => w.size),
      ...(query ? { query } : {}),
      ...(spans.some(Boolean) ? { spans } : {}),
    }));
  } catch { /* z.B. voller oder gesperrter Speicher: der Hinweis ist entbehrlich */ }
}

/** Mehr Spuren hat keine Kachel (eine 12-Termine-Liste: rund 190). */
const SPAN_MAX = 1000;

/**
 * Gemerkte Kachelformen samt Hoehen, sonst die uebergebenen Standardformen
 * ohne. Die Hoehen gelten nur zusammen mit den gemerkten Groessen und nur als
 * ganze Zahl je Kachel - alles andere ist 0 (keine Angabe), denn der Wert
 * landet im Markup des Skeletts.
 *
 * @returns {{ sizes: string[], spans: number[] }}
 */
export function layoutHintTiles(fallbackSizes) {
  const { sizes, spans } = readHint();
  if (!(Array.isArray(sizes) && sizes.length && sizes.every((s) => typeof s === 'string'))) {
    return { sizes: fallbackSizes, spans: fallbackSizes.map(() => 0) };
  }
  const rows = Array.isArray(spans) && spans.length === sizes.length ? spans : [];
  return { sizes, spans: sizes.map((_, i) => (Number.isInteger(rows[i]) && rows[i] > 0 && rows[i] <= SPAN_MAX ? rows[i] : 0)) };
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

/* DIE HOEHE DES KOPFES (DW-P2-5). Das Raster beginnt unter Gruss und
 * Heute-Blatt, und deren Hoehe haengt am Fenster (das Blatt fuellt am Telefon
 * den ersten Schirm) und am Tag. Ohne sie stand das Skelett-Raster bei y 80
 * und der Inhalt bei y 720 - die ganze Seite sprang beim Laden um. Gemerkt
 * wird je Fenstergroesse die zuletzt gezeichnete Hoehe des Kopfbands und ob
 * es ein Blatt trug; wenige Eintraege, der juengste gewinnt. Wie die
 * Kachelformen eine Vorhersage: ein fremder oder kaputter Wert faellt still
 * auf die Form des Skeletts zurueck. */
const HEAD_HINT_KEY = 'yuvomi-dash-head-hint';
const HEAD_HINT_MAX = 6;

function readHeadHints() {
  try {
    const stored = JSON.parse(localStorage.getItem(HEAD_HINT_KEY) ?? 'null');
    return stored && typeof stored === 'object' && !Array.isArray(stored) ? stored : {};
  } catch {
    return {};
  }
}

/**
 * Merkt die Hoehe des Kopfbands fuer eine Fenstergroesse.
 * @param {string} viewport  z. B. "390x844"
 * @param {number} px        Rahmenhoehe des Bands
 * @param {boolean} sheet    ob es ein Heute-Blatt trug
 */
export function rememberHeadHint(viewport, px, sheet) {
  if (!viewport || !(px > 0)) return;
  try {
    const hints = readHeadHints();
    const next = { px: Math.round(px), sheet: Boolean(sheet) };
    const prev = hints[viewport];
    if (prev && prev.px === next.px && prev.sheet === next.sheet) return;
    delete hints[viewport];
    const kept = Object.entries(hints).slice(-(HEAD_HINT_MAX - 1));
    localStorage.setItem(HEAD_HINT_KEY, JSON.stringify(Object.fromEntries([...kept, [viewport, next]])));
  } catch { /* der Hinweis ist entbehrlich */ }
}

/**
 * Die gemerkte Kopfhoehe fuer diese Fenstergroesse, sonst null. Nur eine
 * ganze Zahl in Bildschirmgroesse wird zum Wert - er landet im Markup.
 * @returns {{ px: number, sheet: boolean } | null}
 */
export function headHint(viewport) {
  const hint = readHeadHints()[viewport];
  if (!hint || !Number.isInteger(hint.px) || hint.px <= 0 || hint.px > 4000) return null;
  return { px: hint.px, sheet: hint.sheet !== false };
}

/** Beim Abmelden: der naechste Nutzer an diesem Geraet hat sein eigenes Raster. */
export function forgetLayoutHint() {
  try {
    localStorage.removeItem(LAYOUT_HINT_KEY);
    localStorage.removeItem(HEAD_HINT_KEY);
  } catch { /* gesperrter Speicher: dann bleibt hoechstens ein Skelett falsch */ }
}
