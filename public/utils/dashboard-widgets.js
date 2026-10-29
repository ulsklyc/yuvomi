/**
 * Modul: Dashboard-Widget-Konfiguration
 * Zweck: Der Standard-Satz der Dashboard-Widgets und die reine Logik darauf -
 *        Normalisieren eines gespeicherten Layouts, Vergleich zweier
 *        Konfigurationen, Nachrechnen des dicht gepackten Rasters.
 * Abhängigkeiten: nur utils/dashboard-event-limit.js (rein, ohne eigene Importe)
 *
 * WARUM ALS UTIL UND NICHT IN dashboard.js: `normalizeDashboardConfig` traegt
 * eine Zusicherung (siehe unten an WIDGET_IDS) und war bis 2026-08-13 durch
 * keinen einzigen Test gedeckt.
 * NICHT der Grund ist Unerreichbarkeit - `dashboard.js` ist über den
 * Browser-Loader importierbar, `test-dashboard.js` tut das für den Wand-Modus.
 * Der Grund ist, dass diese Zusicherung dann am `__test`-Export hinge: einer
 * Tür, die für Ansichts-Renderer gebaut ist und deren Inhalt sich nach dem
 * Bedarf der Tests richtet. Eine Regel, an der ein Bestandslayout hängt, gehört
 * hinter eine echte Modulgrenze.
 * Diese Datei hat deshalb bewusst keine Importe ausser einer reinen Schwester
 * (die Stufen der Kalender-Kachel, #1680, die auch die Route liest): sie ist
 * die Teilmenge, die ohne DOM, ohne `window.yuvomi` und ohne Haushaltskontext
 * entscheidbar ist.
 * Was an `isSoloHousehold()` oder den Modul-Schaltern hängt
 * (`isWidgetModuleEnabled`), bleibt drüben in der Seite.
 * Guards: test/test-dashboard.js, Abschnitt „Widget-Konfiguration".
 */

import { EVENT_LIMIT_DEFAULT, clampEventLimit } from './dashboard-event-limit.js';

// Reihenfolge = Standard-Layout. Die primären Inhalte (tasks, calendar) führen,
// damit sie beim Wieder-Einblenden oben stehen; das einzige passive Widget
// (weather) steht bewusst am Ende, statt die sichtbare Grid-Spitze zu belegen.
/* DIE REIHENFOLGE DIESER LISTE IST SEIT 2026-08-13 FREI - sie war es vorher
 * nicht. Bis dahin hängte `normalizeDashboardConfig` eine neu bekannte Id an
 * bestehende Layouts HINTEN an, und ein Vergleich gegen genau diese Liste
 * (`isUserOrderedConfig`) las jedes Bestandslayout als „umsortiert", sobald
 * eine neue Id vor einer bestehenden stand - das Raster schaltete dann
 * stillschweigend von der dichten Packung auf die Quellordnung um (Audit A1-03).
 * Der Merge sortiert eine fehlende Id seitdem an ihrer Default-Position ein.
 *
 * SEIT 2026-09-23 GIBT ES DEN VERGLEICH NICHT MEHR, und die Einsortierung
 * bleibt trotzdem richtig. Das Raster packt jetzt IMMER dicht (siehe `packGrid`
 * unten), eine Umsortierung schaltet nichts mehr um. Die Default-Position ist
 * aber weiter der Ort, an dem ein Neuzugang erscheint, und der Guard
 * „eine fehlende Id landet an ihrer Default-Position" haelt das fest. */
export const WIDGET_IDS = ['tasks', 'calendar', 'meals', 'shopping', 'pantry', 'birthdays', 'countdown', 'budget', 'rewards', 'health', 'cycle', 'fasting', 'nutrition', 'housekeeping', 'schedule', 'waste', 'family', 'notes', 'weather', 'clock', 'metrics', 'quicklinks'];

// Vier kuratierte Formen statt sechs: über vier Auswahlmöglichkeiten pro Widget
// (× bis zu 12 Widgets) kippt der Anpassen-Modus in Mikro-Entscheidungs-Overhead
// für ein Familienpublikum (Critique P2, ≤4-Choices-Regel). Die früheren 3x2/4x2
// bleiben als Legacy-Werte gültig (WIDGET_SIZE_OPTIONS) — bestehende Layouts werden
// nicht zurückgesetzt, nur die Neu-Auswahl steuert auf diese vier zu.
export const WIDGET_SIZE_PRESETS = [
  { value: '1x1', labelKey: 'dashboard.widgetSizeTiny'     },
  // 2 Spalten x 1 Zeile ist BREIT. Der Schluessel hiess `widgetSizeNarrow`
  // („Schmal (2×1)"), und wer das woertlich nahm, bekam das Gegenteil
  // (Re-Critique 2026-09-27, W2).
  { value: '2x1', labelKey: 'dashboard.widgetSizeWide'     },
  { value: '1x2', labelKey: 'dashboard.widgetSizeTall'     },
  // 2x2 ist die GROESSTE der vier Formen, aber keine ist mehr der Vorschlag:
  // defaultWidgetSize() liefert 1x2, 2x1 oder 1x1. Der Schluessel hiess
  // `widgetSizeStandard` („Standard (2×2)") und behauptete damit einen
  // Ausgangswert, den es nicht gibt (#1723). Der Name sagt jetzt die Form.
  { value: '2x2', labelKey: 'dashboard.widgetSizeSquare'   },
];

// Alle bekannten Größen inkl. Legacy-Werte — für normalizeDashboardConfig-Validierung
export const WIDGET_SIZE_OPTIONS = [...new Set([
  ...WIDGET_SIZE_PRESETS.map((p) => p.value),
  '1x2', '1x3', '1x4', '2x3', '2x4', '3x1', '3x3', '3x4', '4x1', '4x3', '4x4',
])];

// Bildet einen beliebigen (auch Legacy-)Größenwert auf das nächstliegende der vier
// kuratierten Presets ab: Breite/Höhe ≥2 → 2, sonst 1. So kann normalizeDashboardConfig
// migrierte Layouts (z.B. 4x2 aus einer früheren Version) auf ein Preset zusammenziehen,
// statt dem betroffenen Nutzer als einziger eine 5. Dropdown-Option zu zeigen (Critique P2).
export function nearestPreset(size) {
  const values = WIDGET_SIZE_PRESETS.map((p) => p.value);
  if (values.includes(size)) return size;
  const [cols, rows] = String(size).split('x').map(Number);
  if (!Number.isFinite(cols) || !Number.isFinite(rows)) return '1x1';
  return `${cols >= 2 ? 2 : 1}x${rows >= 2 ? 2 : 1}`;
}

export function defaultWidgetSize(id) {
  // Listen-Widgets defaulten auf schmal-hoch (1×2) statt breit-hoch (2×2): eine
  // „Heute"-Liste braucht Höhe, nicht Breite — 1×2 halbiert die Grundfläche und
  // packt sich sauber neben andere Widgets, statt als 2-spaltige Kachel eine
  // ganze Rasterzeile zu belegen (löst die Masonry-Imbalance an der Wurzel).
  // Inhaltsschwere Karten (gestapelte Blöcke) starten hoch statt 1×1, damit die
  // Zeile nicht per grid-auto ragged nachwächst (Critique P4). Budget stapelt
  // Saldo + Sparen + Einnahme/Ausgabe + Top-Ausgabe → 1×2; family stapelt seit
  // dem „Heute dran"-Umbau Mitglieder-Zeilen und braucht dieselbe Höhe.
  //
  // NOTIZEN UND GEBURTSTAGE GEHOEREN IN DIESELBE LISTE, und dass sie es nicht
  // taten, hat man am Standard-Desktop gesehen: sichtbar sind ab Werk genau
  // vier Widgets - Geburtstage (1x1), Budget (1x2), Familie (1x2), Notizen
  // (2x1). Vier Spalten fassen die drei hohen nebeneinander, die breite
  // Notizkachel passt daneben nicht mehr und faellt eine Zeile tiefer; was
  // bleibt, ist das Loch rechts unten, das `dense` nicht schliessen kann,
  // weil kein Widget mehr uebrig ist. Beide sind Listen wie die anderen und
  // brauchen Hoehe, nicht Breite: mit 1x2 fuellen die vier Standard-Widgets
  // die Zeile lueckenlos. Bestandslayouts bleiben unberuehrt - gespeichert
  // wird die Groesse, nicht dieser Default.
  // `countdown` steht bei den Geburtstagen, weil es dieselbe Kachel ist: eine
  // nach Nähe sortierte Liste aus Name und „noch so lange". Es ist zugleich das
  // einzige Widget, das erst existiert, sobald jemand etwas markiert hat -
  // siehe die Verfügbarkeitsregel in pages/dashboard.js.
  // `schedule` joins `family` for the same reason: it too is a member list -
  // avatar, name, shift - and left at the 1x1 default it rendered 318px against
  // the 218px the size class promised, stretching whatever shared its grid row
  // (PR #930 review).
  // `pantry` („Laeuft bald ab") ist dieselbe Kachel wie die Geburtstage: eine
  // nach Naehe sortierte Liste aus Name und „noch so lange".
  if (['tasks', 'calendar', 'rewards', 'budget', 'family', 'notes', 'birthdays', 'countdown', 'schedule', 'waste', 'pantry'].includes(id)) return '1x2';
  // Die Uhr startet breit statt quadratisch: Uhrzeit und darunter der ausgeschriebene
  // Wochentag brauchen Zeile, nicht Höhe - auf 1x1 bräche das Datum um (#651).
  // `quicklinks` steht bei der Uhr und nicht bei den Listen: es ist eine ZEILE
  // aus Kacheln (#469), keine Liste aus Zeilen. Auf 1x1 passten zwei davon
  // nebeneinander, und eine Startrampe mit zwei Plaetzen ist keine.
  // `nutrition` steht hier und nicht bei den Listen: die Kachel zeigt eine
  // Fortschrittszeile je Naehrwert, also Balken nebeneinander - sie braucht
  // Zeile, nicht Hoehe, genau wie das Fasten daneben.
  if (['weather', 'shopping', 'health', 'cycle', 'fasting', 'nutrition', 'meals', 'clock', 'quicklinks'].includes(id)) return '2x1';
  // DIE KENNZAHLREIHE IST EINE ZEILE, KEIN BLOCK (Critique 2026-08-13, P1).
  //
  // Hier stand '2x2' mit der Begruendung, das Raster sei der Vergleich, fuer den
  // die Reihe gebaut ist. Gerendert war das Ergebnis ein anderes: 753x671px bei
  // 1440x900, vier Kacheln zu je 372x330px fuer einen Inhalt von rund 80px
  // Hoehe. Die eigene Zusage der Mitteilung lautete „in der Hoehe, die ein
  // Widget-Kopf kostet" - das sind 44px. Faktor 15.
  //
  // Vier Kacheln nebeneinander vergleichen sich genauso wie vier im Quadrat,
  // und sie tun es in einer Zeile statt in einem Drittel des Schirms. Das
  // 2x2-Raster bleibt waehlbar, es ist nur nicht mehr der Vorschlag.
  // Bestandslayouts bleiben unberuehrt - gespeichert wird die Groesse, nicht
  // dieser Default.
  if (id === 'metrics') return '2x1';
  return '1x1';
}

// Das „Heute"-Cockpit fasst diese vier Domänen bereits als Kurzüberblick zusammen.
// Ihre Widgets starten deshalb ausgeblendet: kein Echo, keine Erststart-Überladung.
// Über „Anpassen" jederzeit wieder einblendbar; Bestandskonfigurationen bleiben unberührt.
export const COCKPIT_COVERED_WIDGETS = new Set(['tasks', 'calendar', 'shopping', 'meals']);

// Standardmäßig ausgeblendet: die vier vom Cockpit abgedeckten Domänen (kein Echo)
// plus die spezialisierten Module und Widgets (unter anderem Health, fasting,
// Haushaltshilfe und Abfall). Sie sind nicht in jedem Haushalt aktiv und erscheinen als Opt-in im
// „Anpassen"-Panel, statt frische Dashboards mit leeren Kacheln zu überladen
// (PRODUCT.md: „Power wird auf Abruf enthüllt, nicht in einem Raster ausgebreitet").
// `clock` kommt dazu: auf einem Gerät mit Statusleiste ist eine zweite Uhr
// Doppelung. Ihren Zweck erfüllt sie am Wandtablet ohne Systemleiste (#651) -
// das ist ein bewusster Aufbau, kein Standardfall.
// `weather` ebenso (Seele-Paket): das Wetter spricht als Masthead-Zeile unterm
// Gruß; die große Karte mit Vorhersage ist der Wandtablet-Opt-in im Tray.
// Bestandslayouts behalten ihre gespeicherte Sichtbarkeit - dort entfällt
// stattdessen die Masthead-Zeile (kein Echo).
// `quicklinks` reiht sich bei den Opt-ins ein, und zwar aus dem staerksten der
// hier genannten Gruende: die Reihe ist am ersten Tag LEER. Sichtbar ab Werk
// haette jeder Haushalt - auch jeder bestehende, denn eine neu bekannte Id erbt
// diesen Default - eine Kachel bekommen, die nichts zeigt und um Einrichtung
// bittet. Sie steht im Anpassen-Tray und kommt, wenn jemand sie holt.
// `nutrition` steht bei den Opt-ins aus demselben Grund wie `fasting`: ein
// Tagebuch fuehrt, wer es fuehren will. Und der Eintrag hier ist nicht
// Kosmetik - eine Id, die in dieser Menge FEHLT, ist nach dem Update in JEDEM
// bestehenden Haushalt eingeblendet, weil `normalizeDashboardConfig` eine neu
// bekannte Id mit `defaultWidgetVisible(id)` einsortiert.
// `pantry` („Laeuft bald ab", Critique 2026-09-23) aus demselben Grund: nicht
// jeder Haushalt fuehrt Mindesthaltbarkeiten, und ein frisches Dashboard mit
// einer Kachel „nichts laeuft ab" waere die Ueberladung, die diese Menge
// verhindern soll.
// `budget` steht seit R21 hier (Critique 2026-10-21, D5 "Uebersicht als
// Briefing"): ein Saldo von 34px in Gruen war die groesste Zahl der Startseite,
// noch vor dem, was heute ansteht - und ein Kontostand gehoert nicht auf einen
// Schirm, den jeder im Haushalt und jeder Gast am Kuehlschrank sieht. Wer ihn
// dort will, holt ihn ueber "Anpassen". Bestandslayouts behalten, was sie
// gespeichert haben (keine Migration); nur wer der Vorgabe folgt oder ein
// Layout ohne `budget` mitbringt, startet ohne. Die Kennzahlreihe fuehrt den
// Saldo aus demselben Grund nicht mehr (METRIC_TILE_ORDER, pages/dashboard.js).
export const DEFAULT_HIDDEN_WIDGETS = new Set([...COCKPIT_COVERED_WIDGETS, 'budget', 'rewards', 'health', 'cycle', 'fasting', 'nutrition', 'housekeeping', 'schedule', 'waste', 'pantry', 'clock', 'weather', 'quicklinks']);

export function defaultWidgetVisible(id) {
  return !DEFAULT_HIDDEN_WIDGETS.has(id);
}

export const DEFAULT_WIDGET_CONFIG = WIDGET_IDS.map((id, i) => ({ id, visible: defaultWidgetVisible(id), order: i, size: defaultWidgetSize(id) }));

/**
 * Die Vorgabe fuer ein Kinderkonto (R20, Kinder-Standards): die eigenen Punkte
 * zuerst, die Budget-Kachel aus. Gilt nur, solange das Konto der Vorgabe
 * FOLGT (nichts Eigenes gespeichert) - ein eigenes Layout bleibt, wie es ist.
 * Kein Recht: wer Budget sehen darf, holt die Kachel ueber "Anpassen" zurueck;
 * ein neues Kinderkonto hat das Modul ohnehin nicht (server/permissions.js).
 * Die Aufgaben stehen schon im Heute-Blatt ganz oben, eigene zuerst
 * (pages/dashboard.js `buildTodayProgram`).
 *
 * Rein und ohne Seiteneffekt, auf einer schon normalisierten Liste.
 */
export function childDefaultWidgetConfig(config) {
  const list = (Array.isArray(config) ? config : []).map((w) => ({ ...w }));
  const rewards = list.find((w) => w.id === 'rewards');
  const rest = list
    .filter((w) => w.id !== 'rewards')
    .map((w) => (w.id === 'budget' ? { ...w, visible: false } : w));
  const ordered = rewards ? [{ ...rewards, visible: true }, ...rest] : rest;
  return ordered.map((w, i) => ({ ...w, order: i }));
}

/**
 * Wo eine fehlende Id in ein gespeichertes Layout gehört: direkt hinter den
 * nächsten in WIDGET_IDS VORANGEHENDEN Eintrag, der dort schon vorkommt.
 *
 * ANHÄNGEN WAR DIE BEQUEMERE ANTWORT UND DIE TEURERE. Eine ans Ende gehängte
 * Id ist nur dann an ihrer Default-Position, wenn sie auch in WIDGET_IDS ganz
 * hinten steht. Aus einer Datenoperation wurde so eine Reihenfolgen-Vorschrift
 * für eine Liste zwei Bildschirme weiter oben. Hier kostet die richtige
 * Antwort eine Rückwärtssuche.
 *
 * SIE FOLGT IHREM VORGÄNGER, AUCH WENN DER UMGEZOGEN IST, und das ist eine
 * Entscheidung, keine Nebenwirkung. In einem Layout, das der Nutzer selbst
 * umsortiert hat, gibt es keine „Default-Position" mehr - es gibt nur noch
 * Nachbarn. Gemessen am Demo-Haushalt (Stand 2026-08-13): dort steht `weather`
 * ganz vorn, und `metrics` rückt deshalb von hinten auf Platz zwei, weil sein
 * Vorgänger `clock` an `weather` hängt. Die Alternative wäre, in umsortierten
 * Layouts weiter anzuhängen - dann stünde ein Widget am Ende, weil dort Platz
 * ist, und nicht, weil es dorthin gehört. Festgehalten im Guard
 * „ein umsortiertes Layout laesst den Neuzugang seinem Vorgaenger folgen".
 */
function defaultInsertIndex(ordered, missingId) {
  for (let i = WIDGET_IDS.indexOf(missingId) - 1; i >= 0; i--) {
    const at = ordered.findIndex((w) => w.id === WIDGET_IDS[i]);
    if (at !== -1) return at + 1;
  }
  return 0;
}

export function normalizeDashboardConfig(input) {
  const valid = Array.isArray(input)
    ? input
      .filter((w) => w && typeof w === 'object' && WIDGET_IDS.includes(w.id))
      .map((w, i) => ({
        id: w.id,
        visible: w.visible !== false,
        order: Number.isFinite(Number(w.order)) ? Number(w.order) : i,
        // Gültige (inkl. Legacy-)Größen auf das nächste Preset ziehen; Unbekanntes
        // fällt auf den Domänen-Default. So sieht niemand eine 5. Größen-Option.
        size: WIDGET_SIZE_OPTIONS.includes(w.size) ? nearestPreset(w.size) : defaultWidgetSize(w.id),
        // OPTIONEN GEHEN DURCH, OHNE DASS DIESE DATEI SIE KENNT (#814). Sie
        // gehören dem Widget, das sie stellt; hier hätten sie nur eine zweite
        // Liste ergeben, die bei jedem neuen Widget nachgezogen werden müsste -
        // dieselbe Entscheidung wie im Backend, das sie als Form prüft und
        // nicht als Bedeutung. Ein leeres Objekt wird nicht mitgeschleppt.
        ...(w.options && typeof w.options === 'object' && !Array.isArray(w.options) && Object.keys(w.options).length
          ? { options: { ...w.options } }
          : {}),
      }))
    : [];
  // Erst sortieren, dann einsortieren: `order` und Array-Position können in
  // einem gespeicherten Layout auseinanderlaufen, und eingefügt wird an einer
  // Position, nicht an einer Zahl.
  const ordered = valid.sort((a, b) => a.order - b.order);
  const presentIds = new Set(ordered.map((w) => w.id));
  for (const id of WIDGET_IDS) {
    if (presentIds.has(id)) continue;
    // Neu hinzugekommene Widget-IDs (bei bestehenden, gespeicherten Layouts) erben den
    // Standard-Sichtbarkeitswert ihrer Domäne — Opt-in-Module (rewards/health/housekeeping)
    // erscheinen also nicht ungefragt, sondern bleiben im „Anpassen"-Panel angeboten.
    ordered.splice(defaultInsertIndex(ordered, id), 0, { id, visible: defaultWidgetVisible(id), order: 0, size: defaultWidgetSize(id) });
    // Zwei neue Ids nacheinander: die erste zählt für die zweite bereits als
    // vorhanden, deshalb bleiben sie in ihrer WIDGET_IDS-Reihenfolge stehen.
    presentIds.add(id);
  }
  return ordered.map((w, i) => ({ ...w, order: i }));
}

/* DAS DICHTE RASTER, NACHGERECHNET (Critique 2026-09-23).
 *
 * Das Raster packt seit dieser Runde IMMER dicht (`grid-auto-flow: row dense`),
 * auch bei eigener Reihenfolge und im Bearbeiten-Modus. Was danach noch an
 * Loechern bleibt, liegt nicht an der Reihenfolge, sondern an den GROESSEN:
 * drei Breitkacheln in drei Spalten lassen rechts je eine Zelle frei, weil keine
 * spaetere Kachel hineinpasst. Das kann nur eine andere Groesse loesen, und die
 * schlaegt der Bearbeiten-Modus vor.
 *
 * Dafuer braucht es die Belegung, BEVOR sie gerendert ist - fuer jede
 * Kandidaten-Groesse ein Raster, das es nie gibt. `packGrid` rechnet den
 * Auto-Placement-Algorithmus fuer den einzigen Fall nach, den das Raster kennt:
 * jede Kachel hat nur Spans und keine feste Position, und `dense` setzt den
 * Suchcursor fuer JEDE Kachel zurueck an den Anfang (CSS Grid 2, §8.5, Schritt
 * 4). Erste passende Zelle von oben links gewinnt. Die Spans kommen vom
 * Aufrufer, gelesen aus dem gerenderten Stylesheet - die Zuordnung Groesse →
 * Span steht damit weiter nur in dashboard.css. */

/* Was am Ende einer Spalte frei bleiben darf, bevor es ein Loch ist (F9):
 * hoechstens ein Kachelabstand (`--tile-gap-rows` ab 1024px, 20px). Dieselbe
 * Spanne macht zwei Stellen einer breiten Kachel "gleich frueh" (`packGrid`). */
export const GRID_END_SLACK = 5;

/**
 * Belegung eines dicht gepackten Rasters.
 *
 * GLEICH FRUEH, WENIGER LOCH (U1 b, F9). Seit die Kacheln so hoch sind wie
 * ihr Inhalt, enden die Spalten verschieden tief, und eine breite Kachel passt
 * oft an zwei Stellen fast gleich frueh. `dense` naehme die frueheste - auch
 * wenn sie nur 8px frueher ist und darueber ein Loch bleibt, das eine
 * Nachbarin mit Hoehe ohne Inhalt fuellen muss. Gemessen im Demo-Haushalt bei
 * 1440px: das Wetter setzte sich 8px frueher in Spalte 2-3, jede weitere
 * breite Kachel folgte ihm, und Spalte 1 blieb unter der Familie 536px leer.
 * Hier nimmt eine breite Kachel unter den Stellen, die hoechstens `slack`
 * Spuren spaeter sind als die frueheste, die mit dem kleinsten Loch ueber
 * sich; bei Gleichstand die fruehere, dann die linke. Die Rangfolge bleibt die
 * Reihenfolge - keine spaetere Kachel rueckt vor, eine breite wird hoechstens
 * einen Kachelabstand spaeter. Weil CSS das nicht kann, setzt `applyRowFill`
 * die Spalte breiter Kacheln fest (`col`, `--tile-col`); mit fester Spalte
 * rechnet diese Funktion wie CSS: erste passende Zeile in genau dieser Spalte.
 *
 * @param {{ id: string, cols: number, rows: number, col?: number }[]} items in Rangfolge
 * @param {number} columns Spaltenzahl des Rasters
 * @param {{ slack?: number }} [options] Spuren, die "gleich frueh" sind
 * @returns {(string|null)[][]} Zeilen x Spalten, belegt mit der Widget-Id
 */
export function packGrid(items, columns, { slack = GRID_END_SLACK } = {}) {
  const cols = Math.max(1, Math.floor(columns) || 1);
  const cells = [];
  const row = (r) => (cells[r] ??= Array(cols).fill(null));
  // Die erste Zeile ab `r`, in der die Kachel an Spalte `c` passt: stoesst die
  // Probe auf eine belegte Zelle, geht es unter ihr weiter, nicht eine Zeile
  // tiefer (bei feinen Spuren sonst tausende Proben je Kachel).
  const fitFrom = (r, c, w, h) => {
    for (let top = r; ; ) {
      let blocked = -1;
      for (let a = top; a < top + h && blocked < 0; a += 1) {
        for (let b = c; b < c + w; b += 1) if (cells[a]?.[b]) { blocked = a; break; }
      }
      if (blocked < 0) return top;
      top = blocked + 1;
    }
  };
  // Die oberste freie Zeile je Spalte: darueber ist alles belegt.
  const firstFree = Array(cols).fill(0);
  // Wo die Spalte ueber Zeile r zuletzt belegt ist (fuer das Loch ueber einer Stelle).
  const bottomAbove = (c, r) => {
    for (let a = r - 1; a >= 0; a -= 1) if (cells[a]?.[c]) return a + 1;
    return 0;
  };
  for (const item of items) {
    // Breiter als das Raster geht nicht: CSS legte dafuer eine implizite
    // Spalte an, die das Raster nie zeigen soll - gerechnet wird mit der Kante.
    const w = Math.min(Math.max(1, item.cols | 0), cols);
    const h = Math.max(1, item.rows | 0);
    const locked = Number.isInteger(item.col) && item.col >= 0 && item.col + w <= cols ? item.col : null;
    const spots = [];
    for (let c = locked ?? 0; c + w <= cols; c += 1) {
      const start = Math.min(...firstFree.slice(c, c + w));
      spots.push({ r: fitFrom(start, c, w, h), c });
      if (locked !== null) break;
    }
    let place = spots[0];
    if (w > 1 && locked === null) {
      // Fast gleich frueh: das kleinste Loch darueber, dann frueher, dann links.
      const earliest = Math.min(...spots.map((s) => s.r));
      for (const s of spots) {
        s.hole = s.r > earliest + slack ? Infinity
          : Array.from({ length: w }, (_, k) => s.r - bottomAbove(s.c + k, s.r)).reduce((a, b) => a + b, 0);
      }
      place = spots.reduce((best, s) => (s.hole < best.hole || (s.hole === best.hole && s.r < best.r) ? s : best));
    } else {
      // Wie `dense`: frueher gewinnt, gleich frueh die linke.
      place = spots.reduce((best, s) => (s.r < best.r ? s : best));
    }
    for (let a = place.r; a < place.r + h; a += 1) for (let b = place.c; b < place.c + w; b += 1) row(a)[b] = item.id;
    for (let b = 0; b < cols; b += 1) while (cells[firstFree[b]]?.[b]) firstFree[b] += 1;
  }
  return cells;
}

/**
 * Die Spalte jeder breiten Kachel in der Packung (`packGrid`): Id -> erste
 * Spalte (0-basiert). `applyRowFill` setzt sie fest, damit CSS dasselbe
 * Raster legt wie diese Rechnung.
 */
export function wideTileColumns(items, columns) {
  const cells = packGrid(items, columns);
  const placed = new Map();
  for (const item of items) {
    if (Math.min(item.cols | 0, columns) < 2) continue;
    for (let r = 0; r < cells.length && !placed.has(item.id); r += 1) {
      const c = cells[r].indexOf(item.id);
      if (c >= 0) placed.set(item.id, c);
    }
  }
  return placed;
}

/**
 * Toter Platz im Raster, in Zellen: jede leere Zelle, unter der in derselben
 * Spalte noch eine Kachel steht (ein Loch MITTEN in der Flaeche), UND das
 * freie Ende einer Spalte bis zur Unterkante des Rasters, sobald es laenger
 * ist als `slack` Spuren (F9).
 *
 * U1 b zaehlte das Spaltenende nie mit - ein kuerzeres Spaltenende sollte
 * ruhig auslaufen duerfen, statt die Kachel darueber zu strecken. Gemessen
 * meldete die Funktion so "0 Loecher", waehrend im Demo-Haushalt bei 1440px
 * eine ganze Spalte unter der Familie 536px leer stand, neben drei Kacheln.
 * Eine leere Spalte neben einer vollen ist ein Loch, wo auch immer sie endet;
 * nur ein ausgefranster Rand bis zu einem Kachelabstand ist keins.
 * `slack: Infinity` zaehlt nur das Loch mitten in der Flaeche (der
 * Lueckenhinweis, `suggestGridHoleFill`, schlaegt nur dafuer etwas vor).
 */
export function gridHoleCount(cells, { slack = GRID_END_SLACK } = {}) {
  let holes = 0;
  const width = cells[0]?.length ?? 0;
  for (let c = 0; c < width; c += 1) {
    let below = false;
    let end = 0;
    for (let r = cells.length - 1; r >= 0; r -= 1) {
      if (cells[r][c]) below = true;
      else if (below) holes += 1;
      else end += 1;
    }
    if (end > slack) holes += end;
  }
  return holes;
}

/**
 * Die billigste Groessenaenderung EINER Kachel, nach der kein Loch mehr bleibt
 * und das Raster nicht hoeher wird. `null`, wenn es nichts zu schliessen gibt
 * oder keine einzelne Aenderung es schafft - dann schweigt der Hinweis lieber,
 * als einen Umbau in mehreren Schritten anzuregen.
 *
 * @param {{ id: string, size: string, cols: number, rows: number }[]} items
 * @param {number} columns
 * @param {(item: object) => { size: string, cols: number, rows: number }[]} candidatesFor
 */
export function suggestGridHoleFill(items, columns, candidatesFor) {
  const base = packGrid(items, columns);
  const enclosed = (cells) => gridHoleCount(cells, { slack: Infinity });
  if (!enclosed(base)) return null;
  // Zuerst die NACHBARN des Lochs - die Kachel darueber kann nach unten, die
  // links daneben nach rechts wachsen -, dann der Rest. Ein Vorschlag, der eine
  // Kachel am anderen Ende des Rasters umbaut, schliesst das Loch zwar auch,
  // aber niemand sieht, warum.
  const neighbours = new Set();
  for (let r = 0; r < base.length - 1; r += 1) {
    for (let c = 0; c < base[r].length; c += 1) {
      if (base[r][c]) continue;
      if (r > 0 && base[r - 1][c]) neighbours.add(base[r - 1][c]);
      if (c > 0 && base[r][c - 1]) neighbours.add(base[r][c - 1]);
    }
  }
  // Danach die Kosten der Aenderung: gleiche Flaeche (aus breit wird hoch) vor
  // groesser vor kleiner - ein Vorschlag, der Inhalt wegnimmt, ist der teuerste.
  // Erst zuletzt die Rangfolge.
  const area = (x) => x.cols * x.rows;
  const cost = (item, cand) => {
    const delta = area(cand) - area(item);
    return delta === 0 ? 0 : delta > 0 ? delta : 100 - delta;
  };
  const tries = items.flatMap((item, i) => candidatesFor(item)
    .filter((cand) => cand.size !== item.size)
    .map((cand) => ({ i, cand, near: neighbours.has(item.id) ? 0 : 1, cost: cost(item, cand) })))
    .sort((x, y) => x.near - y.near || x.cost - y.cost || x.i - y.i);
  for (const { i, cand } of tries) {
    const next = items.map((it, j) => (j === i ? { ...it, ...cand } : it));
    const cells = packGrid(next, columns);
    if (enclosed(cells) === 0 && cells.length <= base.length) {
      return { id: items[i].id, size: cand.size };
    }
  }
  return null;
}

/**
 * Welche Kachel im NORMALMODUS in den Rest ihrer Zeile waechst (Re-Critique
 * 2026-09-27, A7 P2-12 / R10 L9). Gemessen bei 1440x900: neben der
 * Kennzahlreihe (2x1) und neben den Notizen (2x1) blieb je eine Spalte leer,
 * 367x110 und 367x201px - der Loch-Hinweis steht nur im Anpassen-Modus, und
 * wer nie anpasst, sieht die Loecher fuer immer.
 *
 * Die Regel: nach der dichten Packung waechst jede Kachel nach rechts ueber
 * die freien Zellen, die in ALLEN ihren Zeilen frei sind, bis zur naechsten
 * belegten Zelle oder zum Rand. Gespeichert wird nichts - die gewaehlte Groesse
 * bleibt die des Nutzers, gewachsen wird nur in der Darstellung.
 *
 * WARUM DAS DIE PACKUNG NICHT UMWIRFT (Aequivalenz, getestet): gewachsen wird
 * nur in Zellen, die nach der VOLLEN Packung leer sind. Keine Kachel stand je
 * dort, also findet bei der Neupackung mit den breiteren Spans jede Kachel
 * dieselbe erste passende Stelle - die davor passten schon mit der schmaleren
 * Breite nicht, und die eigene ist weiterhin frei. Der Test packt beide
 * Fassungen und vergleicht die Positionen.
 *
 * NUR, WAS BREITE IN INHALT UMSETZT (DW-P2-6, U1 b): `wide: true`. Gemessen
 * 1440px: Wetter, Kennzahlen, Notizen und Uhr wuchsen auf 1156px und zeigten
 * dort dasselbe wie auf 764px - Breite ohne Information ist Leere quer. Das
 * Wetter zeigt in der Breite mehr Tage; alles andere bleibt so breit, wie es
 * gewaehlt ist, und den Platz daneben nimmt die naechste Kachel (die Packung
 * ist dicht).
 *
 * DER LETZTE AUSWEG (`holes: true`): bleibt nach dem Wachsen nach unten ein
 * Loch, das keine Kachel darueber erreicht - es liegt unter einem Teil einer
 * breiten Kachel, gemessen 1024px neben "Belohnungen" (246px, darunter die
 * Notizen) -, waechst eine Kachel daneben hinein, auch ohne Mehrinhalt. Das
 * gilt seit F9 auch fuer ein Spaltenende: eine leere Spalte neben vollen ist
 * ein Loch (`gridHoleCount`), schmal wie breit - drei breite Kacheln in drei
 * Spalten liessen sonst eine ganze Spalte leer, und im Demo-Haushalt stand
 * Spalte 1 bei 1440px unter der Familie 536px leer. Ein Loch im Raster liest
 * als kaputt, eine breitere Karte nicht.
 *
 * AUCH NACH LINKS (F9, `left: true`, nur `fillGridSpans` im letzten Ausweg):
 * liegt das Loch LINKS neben einer Kachel (im Kinderkonto bei 1440px unter den
 * Belohnungen, rechts daneben Wetter und Notizen), waechst sie dorthin; ihre
 * Startspalte setzen `fillGridSpans`/`applyRowFill` dann fest. Nur nach rechts
 * blieb dort 588px leer.
 *
 * @param {{ id: string, cols: number, rows: number, wide?: boolean }[]} items in Rangfolge
 * @param {number} columns Spaltenzahl des Rasters
 * @param {{ holes?: boolean }} [options]
 * @returns {Map<string, number>} Id -> neue Spaltenbreite, nur fuer Kacheln, die wachsen
 */
export function rowFillSpans(items, columns, { holes = false } = {}) {
  return new Map([...acrossFill(items, columns, { holes })].map(([id, span]) => [id, span.cols]));
}

/** Das Wachsen in die Breite, nach rechts und (`left`) nach links:
 *  Id -> { col, cols } (neue Startspalte, neue Breite). */
function acrossFill(items, columns, { holes = false, left = false } = {}) {
  const cols = Math.max(1, Math.floor(columns) || 1);
  const grown = new Map();
  if (cols < 2) return grown;
  const cells = packGrid(items, cols);
  for (const item of items) {
    if (!holes && item.wide !== true) continue;
    // Die Stelle der Kachel: ihre erste Zelle in Lesereihenfolge.
    let top = -1;
    let start = -1;
    for (let r = 0; r < cells.length && top < 0; r += 1) {
      const c = cells[r].indexOf(item.id);
      if (c >= 0) { top = r; start = c; }
    }
    if (top < 0) continue;
    const w = Math.min(Math.max(1, item.cols | 0), cols);
    const h = Math.max(1, item.rows | 0);
    let first = start;
    let end = start + w;
    // Frei in ALLEN Zeilen der Kachel - mehr fragt das Wachsen in die Breite nicht.
    const columnFree = (c) => {
      for (let r = top; r < top + h; r += 1) if (!cells[r] || cells[r][c]) return false;
      return true;
    };
    const take = (c) => { for (let r = top; r < top + h; r += 1) cells[r][c] = item.id; };
    while (end < cols && columnFree(end)) { take(end); end += 1; }
    while (left && first > 0 && columnFree(first - 1)) { first -= 1; take(first); }
    if (end - first > w) grown.set(item.id, { col: first, cols: end - first });
  }
  return grown;
}

/**
 * Welche Kachel UEBER einer freien Zelle nach unten waechst (R21, Critique
 * 2026-10-21, D5). Das Wachsen nach rechts (`rowFillSpans`) schliesst eine
 * Zelle nur, wenn links von ihr eine Kachel steht, die in ALLEN ihren Zeilen
 * Platz hat. Steht eine 1x1-Kachel neben zwei hohen, bleibt darunter ein Loch,
 * das niemand von links erreicht: gemessen bei 1440px mit eingeklappter
 * Seitenleiste (vier Spalten) 305x185px unter "Belohnungen", bei 1280px fuer
 * ein Kinderkonto 319x201px - mitten im Raster, nicht an seinem Ende.
 *
 * Dieselbe Regel, um neunzig Grad gedreht: nach dem Wachsen nach rechts waechst
 * jede Kachel nach unten ueber die Zellen, die in ALLEN ihren Spalten frei sind,
 * bis zur naechsten belegten Zelle. Seit die Hoehe aus dem Inhalt kommt (U1 b,
 * `contentSpanRows`), nur noch dorthin: ein freies Spaltenende ist kein Loch
 * (`gridHoleCount`), und wer es fuellte, setzte Hoehe ohne Inhalt in die
 * Kachel. Hoeher wird das Raster dadurch nie. `grow: false` nimmt eine Kachel aus (die
 * Kennzahlreihe ist so hoch wie ihr Inhalt, gestreckt laege die Leere nur in
 * ihr statt neben ihr).
 *
 * DIE AEQUIVALENZ GILT WIE OBEN: gewachsen wird nur in Zellen, die nach der
 * vollen Packung leer sind, also findet jede Kachel bei der Neupackung mit den
 * hoeheren Spans dieselbe erste passende Stelle (Guard in test-dashboard.js).
 *
 * @param {{ id: string, cols: number, rows: number, grow?: boolean }[]} items in Rangfolge,
 *        `cols` schon nach `rowFillSpans` verbreitert
 * @param {number} columns
 * @returns {Map<string, number>} Id -> neue Zeilenzahl, nur fuer Kacheln, die wachsen
 */
export function columnFillSpans(items, columns, { ends = null } = {}) {
  const cols = Math.max(1, Math.floor(columns) || 1);
  const grown = new Map();
  if (cols < 2) return grown;
  const cells = packGrid(items, cols);
  for (const item of items) {
    if (item.grow === false) continue;
    let top = -1;
    let left = -1;
    for (let r = 0; r < cells.length && top < 0; r += 1) {
      const c = cells[r].indexOf(item.id);
      if (c >= 0) { top = r; left = c; }
    }
    if (top < 0) continue;
    const w = Math.min(Math.max(1, item.cols | 0), cols);
    const own = top + Math.max(1, item.rows | 0);
    let end = own;
    const rowFree = (r) => {
      for (let c = left; c < left + w; c += 1) if (!cells[r] || cells[r][c]) return false;
      return true;
    };
    while (end < cells.length && rowFree(end)) end += 1;
    // NUR EIN ECHTES LOCH (U1 b): darunter steht noch eine Kachel. Laeuft die
    // freie Strecke bis ans Ende des Rasters, endet die Spalte dort - ruhig,
    // solange es ein ausgefranster Rand ist. Erst als letzter Ausweg
    // (`ends`, F9) waechst die letzte Kachel einer Spalte, deren freies Ende
    // laenger ist als `ends` Spuren, bis an die Unterkante: eine leere Spalte
    // neben vollen liest als kaputt, eine hoehere Karte nicht.
    if (end === own) continue;
    if (end >= cells.length && (ends === null || end - own <= ends)) continue;
    for (let r = own; r < end; r += 1) for (let c = left; c < left + w; c += 1) cells[r][c] = item.id;
    grown.set(item.id, end - top);
  }
  return grown;
}

/**
 * DAS GANZE FUELLEN IN EINER RECHNUNG (U1 b, F9) - fuer `applyRowFill` und
 * die Tests dieselbe. Nach der dichten Packung (`packGrid`, breite Kacheln
 * mit fester Spalte, `wideTileColumns`):
 *   1. das Wetter waechst in den Platz daneben (`rowFillSpans`, `wide`) und
 *      zeigt dort mehr Tage;
 *   2. ein Loch unter einer Kachel fuellt die Kachel darueber
 *      (`columnFillSpans`);
 *   3. was dann noch Loch ist, nimmt eine Kachel daneben in die Breite -
 *      erst nach rechts, dann nach links (`holes`, `left`) -, danach noch
 *      einmal 2.; hoechstens drei Runden, solange sich etwas tut;
 *   4. ein Spaltenende, das laenger ist als `slack` Spuren, nimmt die letzte
 *      Kachel der Spalte (`columnFillSpans`, `ends`).
 * Bleibt danach ein Loch, das ohne Schritt 1 nicht bliebe, gilt die Rechnung
 * ohne ihn.
 * Jede Kachel bleibt dabei, wo sie steht (gewachsen wird nur in Zellen, die
 * nach der vollen Packung leer sind); wer in die Breite waechst, bekommt seine
 * Startspalte fest (`col`), damit CSS sie nicht anders setzt. Gespeichert wird
 * nichts.
 *
 * @param {{ id: string, cols: number, rows: number, wide?: boolean, grow?: boolean }[]} items in Rangfolge
 * @param {number} columns
 * @param {{ slack?: number }} [options]
 * @returns {{ id: string, cols: number, rows: number, col?: number }[]} je Kachel die gezeichnete Spanne
 */
export function fillGridSpans(items, columns, { slack = GRID_END_SLACK } = {}) {
  const cols = Math.max(1, Math.floor(columns) || 1);
  if (cols < 2) return items.map((item) => ({ ...item }));
  const locks = wideTileColumns(items, cols);
  const start = items.map((item) => (locks.has(item.id) ? { ...item, col: locks.get(item.id) } : { ...item }));
  const filled = fillFrom(start, cols, slack, true);
  // Nimmt das Wetter mit seinen Tagen eine Zelle, ohne die ein Loch darunter
  // nicht mehr zu schliessen ist (gemessen mit allen Kacheln bei vier
  // Spalten: 100px unter dem Wetter, darunter die Schnellzugriffe), bleibt es
  // so breit, wie es gewaehlt ist - ein Loch wiegt schwerer als ein Tag mehr.
  if (!gridHoleCount(packGrid(filled, cols), { slack })) return filled;
  const narrow = fillFrom(start, cols, slack, false);
  return gridHoleCount(packGrid(narrow, cols), { slack }) < gridHoleCount(packGrid(filled, cols), { slack }) ? narrow : filled;
}

function fillFrom(start, cols, slack, wideFirst) {
  let spans = start;
  const widen = (grown) => {
    spans = spans.map((item) => {
      const span = grown.get(item.id);
      return span ? { ...item, cols: span.cols, col: span.col } : item;
    });
  };
  const deepen = (grown) => { spans = spans.map((item) => ({ ...item, rows: grown.get(item.id) ?? item.rows })); };
  if (wideFirst) widen(acrossFill(spans, cols));
  deepen(columnFillSpans(spans, cols));
  for (let round = 0; round < 3; round += 1) {
    const across = acrossFill(spans, cols, { holes: true, left: true });
    widen(across);
    const down = columnFillSpans(spans, cols);
    deepen(down);
    if (!across.size && !down.size) break;
  }
  deepen(columnFillSpans(spans, cols, { ends: slack }));
  return spans;
}

/* DIE HOEHE KOMMT AUS DEN DATEN, NICHT AUS DER NACHBARKACHEL (DW-P1-3, U1 b,
 * Entscheidung Ulas 2026-10-26; revidiert R10 L9 / R21 D5, docs/DECISIONS.md).
 *
 * Bis hierher war jede Kachel so hoch wie die Rasterzeilen, die ihre Groesse
 * belegte, und eine Rasterzeile so hoch wie ihre hoechste Kachel: gemessen
 * 1440px mit allen Kacheln 19 %, 1920px 27 % der Kachelflaeche leer unter dem
 * letzten Inhalt - Schichtplan 608 von 759px, die leere Entsorgung 629 von 759.
 * Ein Apple-Widget hat nie Hoehe ohne Inhalt.
 *
 * Jetzt meldet jede Kachel aus ihren DATEN, wie hoch sie ist: so viele Zeilen,
 * wie sie zeigt (hoechstens so viele, wie ihre Groesse erlaubt - die gewaehlte
 * Groesse ist die OBERGRENZE, `listRowCap`), mal der Zeilenhoehe des
 * Zeilengeruests, dazu Kopf und Polster; leer genau eine Zeile. Das Raster
 * rechnet in feinen Spuren (`--dashboard-row-unit`, 4px) und packt dicht wie
 * bisher - eine Kachel nimmt dabei so viele Spuren, wie ihr Inhalt hoch ist.
 * Deterministisch VOR dem Zeichnen und ohne Layout-Messung: das Skelett und
 * der Layout-Hinweis kennen dieselbe Spanne, und in jedem Browser steht
 * dasselbe Raster (grid-lanes/Masonry hat keine Mehrheit, PLAN U1 a).
 *
 * Die Masse sind die des Stylesheets (dashboard.css, Abschnitt "EIN
 * ZEILENGERUEST" und "Widget-Grid"); `test:dashboard` haelt beide Seiten
 * zusammen. Sie gelten ab 768px, wo das Raster Spalten hat - am Telefon steht
 * jede Kachel ohnehin in ihrer eigenen Hoehe untereinander. */
export const TILE_GEOMETRY = Object.freeze({
  unit: 4,     // eine Rasterspur: --dashboard-row-unit (--space-1)
  frame: 2,    // Haarlinie der Karte oben und unten
  head: 52,    // Widget-Kopf (.widget__header, ab 640px)
  rowsPad: 20, // .widget__body--rows: --space-2 oben, --space-3 unten
  row: 54,     // eine Zeile des Zeilengeruests ab 768px (--target-lg + --space-1h, Haarlinie innen)
  more: 27,    // "+N weitere" (Footnote) samt Abstand zur Liste
  empty: 72,   // die Leerzeile (`cardEmptyRowHtml` im `.widget__empty`)
});

/**
 * Wie hoch eine Kachel aus ihren Daten ist - in Rasterspuren.
 *
 * Eine Listenkachel nennt `items` (geladene Eintraege), `total` (alle, fuer
 * "+N weitere") und `cap` (die Zeilen ihrer Groesse); gezeigt werden
 * hoechstens `cap`, ohne Eintrag steht genau die Leerzeile. Eine Kachel mit
 * eigenem Aufbau (Wetter, Uhr, Budget ...) nennt statt dessen `body`, die Hoehe
 * unter dem Kopf. `row` ersetzt die Zeilenhoehe, `extra` traegt feste Teile
 * unter der Liste (eine Fusszeile). `more: false`: die Kachel nennt den Rest
 * nicht (sie hat keine Zeile "+N weitere"). `bare: true` mit `body`: die
 * Kachel hat weder Karte noch Kopf.
 *
 * @param {{ items?: number, total?: number, cap?: number, row?: number, extra?: number, body?: number, more?: boolean, bare?: boolean }} content
 * @param {Partial<typeof TILE_GEOMETRY>} [geometry]
 * @returns {{ shown: number, rest: number, px: number, rows: number }} `rows` = Spuren
 */
export function contentSpanRows(content = {}, geometry = {}) {
  const g = { ...TILE_GEOMETRY, ...geometry };
  const count = (v) => Math.max(0, Math.floor(Number(v) || 0));
  let shown = 0;
  let rest = 0;
  let px;
  if (content.body !== undefined && content.body !== null) {
    // `bare`: ohne Karte und Kopf (die Kennzahlreihe ist selbst Kacheln).
    px = (content.bare ? 0 : g.frame + g.head) + Math.max(0, Number(content.body) || 0);
  } else {
    const items = count(content.items);
    const cap = content.cap === undefined || content.cap === null ? Infinity : count(content.cap);
    shown = Math.min(items, cap);
    rest = Math.max(items, count(content.total)) - shown;
    px = shown
      ? g.frame + g.head + g.rowsPad + shown * (Number(content.row) || g.row) + (rest > 0 && content.more !== false ? g.more : 0)
        + Math.max(0, Number(content.extra) || 0)
      : g.frame + g.head + g.empty;
  }
  // Eine Spur Toleranz gegen Rundungsreste (52.6 + ...), nie weniger als eine Spur.
  return { shown, rest, px, rows: Math.max(1, Math.ceil(px / g.unit - 1e-6)) };
}

/* HOEHE WIRD INHALT (U14, Entscheidung Ulas 2026-10-27). Eine Kachel bekommt
 * beim Fuellen (`fillGridSpans`) manchmal mehr Hoehe, als ihre Daten melden -
 * sie schliesst ein Loch oder ein Spaltenende. Hat sie dafuer weitere Zeilen
 * geladen (der Server liefert den Vorrat fuer die groesste Fassung, die
 * Groesse zeigt weniger), stehen sie im gewonnenen Platz; ohne Mehrdaten
 * bleibt er leer. Vorbild war die Fuell-Liste der Belohnungen (R22 S10), die
 * das nur fuer sich und nur per CSS konnte.
 *
 * KEINE RUECKKOPPLUNG: die Spanne kommt weiter aus den Daten in der gewaehlten
 * Groesse (`contentSpanRows`), die Packung rechnet nur damit. Die Zusatzzeilen
 * fuellen danach, was die Packung zugeteilt hat, und fragen nie zurueck - kein
 * zweiter Packlauf, kein Layout-Lesen. Wie viele es sind, rechnet der Renderer
 * mit derselben Geometrie vorab aus: `steps[k - 1]` = Spuren der Kachel mit k
 * Zusatzzeilen (dann auch mit kleinerem oder ohne "+N weitere").
 *
 * @param {number[]} steps aufsteigend, Spuren mit 1, 2, ... Zusatzzeilen
 * @param {number} allotted die Spuren, die die Packung der Kachel zuteilt (ohne Abstand)
 * @returns {number} wie viele Zusatzzeilen hineinpassen
 */
export function fillRowCount(steps, allotted) {
  const room = Number(allotted);
  if (!Array.isArray(steps) || !Number.isFinite(room)) return 0;
  let k = 0;
  while (k < steps.length && Number(steps[k]) > 0 && Number(steps[k]) <= room) k += 1;
  return k;
}

export function sameWidgetConfig(a, b) {
  if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
  return a.every((w, i) => w.id === b[i].id && w.visible === b[i].visible
    && w.size === b[i].size && w.order === b[i].order
    // Die Optionen zählen mit, sonst bietet der Toast kein „Rückgängig" an,
    // wenn NUR eine Option umgestellt wurde (#814) - genau der Fall, in dem
    // die Änderung am wenigsten sichtbar ist. Der Vergleich läuft über die
    // serialisierte Form: die Werte sind flach und stammen aus derselben
    // Normalisierung, ihre Schlüsselreihenfolge ist damit stabil.
    && JSON.stringify(w.options ?? null) === JSON.stringify(b[i].options ?? null));
}

/**
 * Die Optionen der Widgets als Pfad der Uebersichts-Abfrage (#814).
 *
 * SIE MUESSEN MIT DER ANFRAGE REISEN, nicht im Browser nachfiltern: die Route
 * deckelt die Liste bei fuenf und zaehlt die Kacheln unbegrenzt. Wer hier
 * nachtraeglich siebte, stellte zwei Zeilen unter eine Kachel, die sieben sagt
 * (dieselbe Lehre wie #647).
 *
 * WELCHE OPTION WELCHEN PARAMETER ERGIBT, WEISS NUR DER BROWSER. Der Server
 * speichert `options` als Form und kennt weder Widget noch Bedeutung - eine
 * Registry dort waere der billige Anfang und danach der Preis jedes weiteren
 * Widgets. Diese Funktion ist die Uebersetzung, und sie steht hier, weil sie
 * rein ist und ihre Zusicherung sonst am `__test`-Export der Seite haenge.
 *
 * @param {object[]} config normalisierte Widget-Konfiguration
 * @returns {string} '/dashboard' oder '/dashboard?…'
 */
/**
 * Die gespeicherte Listen-Auswahl der Einkaufs-Kachel als Ids (#1818):
 * positive ganze Zahlen, ohne Doppelte. Was sonst im Layout steht (ein
 * Fremdwert, ein String aus aelterem Stand), faellt weg - dieselbe Form, die
 * die Route aus `?shopping_list=` liest.
 *
 * @param {unknown} value `options.lists`
 * @returns {number[]}
 */
export function normalizeShoppingListSelection(value) {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.map(Number).filter((id) => Number.isInteger(id) && id > 0))];
}

/**
 * Die gespeicherte Kalender-Auswahl der Kalender-Kachel als Schluessel (#2062):
 * `local:N`, `cal:N` oder `sub:N` (die Schluessel des Kalendermoduls), ohne
 * Doppelte. Was sonst im Layout steht, faellt weg - dieselbe Form, die die
 * Route aus `?events_calendar=` liest (server/services/calendar-selection.js).
 *
 * @param {unknown} value `options.calendars`
 * @returns {string[]}
 */
export function normalizeCalendarSelection(value) {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.filter((key) => typeof key === 'string' && /^(local|cal|sub):[1-9]\d{0,14}$/.test(key)))];
}

export function dashboardQuery(config) {
  const params = new URLSearchParams();
  const optionsOf = (id) => (Array.isArray(config) ? config.find((w) => w.id === id)?.options : null) ?? {};
  if (optionsOf('calendar').scope === 'mine') params.set('events_scope', 'mine');
  // Nur die Abwahl reist mit (#927): „mit Geburtstagen" ist der Auslieferungs-
  // zustand der Route, und ein Parameter, der ihn wiederholt, stuende in jeder
  // Anfrage - dieselbe Regel, nach der `scope: 'all'` nicht gespeichert wird.
  if (optionsOf('calendar').birthdays === 'hide') params.set('events_birthdays', 'hide');
  // Die Stufe reist geklemmt und nur, wenn sie nicht die Vorgabe ist (#1680):
  // ein gespeicherter Fremdwert ergibt hier dieselbe Anfrage wie gar keiner.
  const eventLimit = clampEventLimit(optionsOf('calendar').limit);
  if (eventLimit !== EVENT_LIMIT_DEFAULT) params.set('events_limit', String(eventLimit));
  // Die Kalender-Auswahl (#2062) reist wie „nur meine": sie wirkt auf die
  // Termine der ganzen Uebersicht, also auch auf die Wand, die dieselbe
  // Einstellung liest. Keine Auswahl steht in keiner Anfrage.
  for (const key of normalizeCalendarSelection(optionsOf('calendar').calendars)) params.append('events_calendar', key);
  for (const key of optionsOf('tasks').categories ?? []) params.append('tasks_category', key);
  for (const id of optionsOf('notes').categories ?? []) params.append('notes_category', String(id));
  // Die Listen-Auswahl der Einkaufs-Kachel (#1818). Sie reist wie jede andere
  // Option, ob die Kachel sichtbar ist oder nicht: die Route legt die Auswahl
  // in ein eigenes Feld (`shoppingTile`) und laesst alles andere unberuehrt,
  // also haengt keine Zahl ausserhalb der Kachel an ihr.
  for (const id of normalizeShoppingListSelection(optionsOf('shopping').lists)) params.append('shopping_list', String(id));
  const query = params.toString();
  return query ? `/dashboard?${query}` : '/dashboard';
}

/**
 * Der Abruf der Uebersicht fuer die Flaeche, die ihn zeichnet (#1817).
 *
 * DIE WAND FRAGT DIE HAUSHALTSFASSUNG AB (`audience=household`): sie ist eine
 * geteilte Flaeche, kein persoenlicher Bildschirm, und zeigt nur, was der ganze
 * Haushalt sehen darf - gleich, aus wessen Sitzung sie geoeffnet wurde. Der
 * Server liefert dafuer eine engere Antwort; hier wird nichts weggefiltert, was
 * schon im Browser liegt. Die normale Uebersicht fragt ohne den Parameter und
 * bleibt persoenlich.
 *
 * Dasselbe gilt fuer die faelligen Erinnerungen (`/reminders/pending`), die
 * zweite Antwort der Seite, die davon abhaengt, wer fragt: die Wand haengt den
 * Parameter auch dort an und bekommt keine.
 *
 * @param {string} query '/dashboard' oder '/dashboard?…' (dashboardQuery, layoutHintQuery), oder '/reminders/pending'
 * @param {{ wall?: boolean }} [surface]
 * @returns {string}
 */
export function dashboardRequest(query, { wall = false } = {}) {
  const text = String(query ?? '/dashboard');
  if (!wall) return text;
  return `${text}${text.includes('?') ? '&' : '?'}audience=household`;
}

/* EIN ABRUF DER FAELLIGEN ERINNERUNGEN FUER GLOCKE UND UEBERSICHT (Critique
 * R19, Nachlese 1b). `/reminders/pending` ging beim Start zweimal hinaus: die
 * Glocke (reminders.js) fragte gleich nach der Anmeldung, das Heute-Blatt der
 * Uebersicht (pages/dashboard.js) 0,7 s spaeter dieselbe Adresse - am
 * gedrosselten Telefon eine Rundreise mehr auf einer der sechs Verbindungen,
 * genau waehrend die Uebersicht ihre Module laedt.
 *
 * Wer dieselbe Adresse innerhalb von PENDING_SHARE_MS nach dem letzten Abruf
 * fragt, bekommt dessen Versprechen - laufend oder schon erfuellt. Die Adresse
 * traegt die Reichweite (dashboardRequest oben), also teilen nur Fragen mit
 * derselben Antwort. Ein Fehler wird nicht geteilt. `fresh` (die Glocke nach
 * einer eigenen Aenderung) fragt immer neu, `forgetPendingReminders()`
 * verwirft das Gemerkte - beim Wegklicken und beim Abmelden, damit nie die
 * Antwort einer frueheren Sitzung weitergereicht wird.
 *
 * Es steht HIER, weil beide Aufrufer diese Datei schon laden: ein eigenes
 * Modul war eine Datei mehr in der Startkette und kostete gemessen mehr, als
 * der gesparte Abruf brachte. Den Abruf selbst (`get`, api.get) reicht der
 * Aufrufer herein - diese Datei importiert nichts aus dem Browser. */
export const PENDING_SHARE_MS = 2000;
let sharedPending = null;

/**
 * @param {string} path - '/reminders/pending' samt Reichweite
 * @param {{ get: (path: string) => Promise<any>, fresh?: boolean, now?: number }} options
 * @returns {Promise<any>}
 */
export function fetchPendingReminders(path, { get, fresh = false, now = Date.now() }) {
  if (!fresh && sharedPending && sharedPending.path === path && now - sharedPending.at < PENDING_SHARE_MS) {
    return sharedPending.promise;
  }
  const promise = Promise.resolve().then(() => get(path));
  const entry = { path, at: now, promise };
  sharedPending = entry;
  promise.catch(() => { if (sharedPending === entry) sharedPending = null; });
  return promise;
}

/** Das Gemerkte verwerfen (Erinnerung weggeklickt, Abmeldung). */
export function forgetPendingReminders() {
  sharedPending = null;
}

/* WELCHE PARAMETER DIE ZAHLEN DER ANTWORT UNBERUEHRT LASSEN (#1680).
 *
 * Die Navigations-Badges und Modulkacheln nehmen die `/dashboard`-Antwort der
 * Seite nur an, wenn sie ungefiltert ist (router.js, `primeModuleCountsFrom`):
 * `tasks_category` aendert `openTaskCount`, und eine eingeschraenkte Zahl ist
 * eine andere Zahl. `events_limit` schraenkt nichts ein - es verlaengert eine
 * Liste, die in keine Zahl eingeht. Ohne diese Ausnahme galt jede Antwort mit
 * gewaehlter Stufe als gefiltert, und der Router holte anderthalb Sekunden
 * spaeter dieselbe Aggregation ein zweites Mal, bei jedem Kaltstart.
 *
 * `shopping_list` (#1818) steht aus demselben Grund hier: die Auswahl fuellt
 * ein eigenes Feld der Antwort (`shoppingTile`) und laesst `shoppingOpenCount`
 * unberuehrt - die Zahl, die Navigation und Kuechen-Kachel lesen.
 *
 * ALLOWLIST: was hier nicht steht, gilt als Filter. Ein neuer Parameter kostet
 * so hoechstens den zweiten Abruf, nie eine falsche Zahl. `events_scope` und
 * `events_birthdays` stehen bewusst nicht hier - sie waren vor #1680 schon
 * „gefiltert", und ob sie es bleiben, ist nicht Sache dieser Aenderung. */
const COUNT_NEUTRAL_PARAMS = new Set(['events_limit', 'shopping_list']);

/**
 * @param {string} query Pfad der Uebersichts-Abfrage ('/dashboard' oder '/dashboard?…')
 * @returns {boolean} true, wenn die Antwort darauf andere Zahlen tragen kann als die ungefilterte
 */
export function dashboardQueryFiltersCounts(query) {
  const text = String(query ?? '');
  const at = text.indexOf('?');
  if (at === -1) return false;
  return [...new URLSearchParams(text.slice(at + 1)).keys()].some((key) => !COUNT_NEUTRAL_PARAMS.has(key));
}
