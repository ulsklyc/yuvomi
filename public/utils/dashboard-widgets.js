/**
 * Modul: Dashboard-Widget-Konfiguration
 * Zweck: Der Standard-Satz der Dashboard-Widgets und die reine Logik darauf -
 *        Normalisieren eines gespeicherten Layouts, Erkennen einer echten
 *        Nutzer-Umsortierung, Vergleich zweier Konfigurationen.
 * Abhängigkeiten: keine
 *
 * WARUM ALS UTIL UND NICHT IN dashboard.js: `normalizeDashboardConfig` und
 * `isUserOrderedConfig` tragen zusammen eine Zusicherung (siehe unten an
 * WIDGET_IDS) und waren bis 2026-08-13 durch keinen einzigen Test gedeckt.
 * NICHT der Grund ist Unerreichbarkeit - `dashboard.js` ist über den
 * Browser-Loader importierbar, `test-dashboard.js` tut das für den Wand-Modus.
 * Der Grund ist, dass diese Zusicherung dann am `__test`-Export hinge: einer
 * Tür, die für Ansichts-Renderer gebaut ist und deren Inhalt sich nach dem
 * Bedarf der Tests richtet. Eine Regel, an der ein Bestandslayout hängt, gehört
 * hinter eine echte Modulgrenze.
 * Diese Datei hat deshalb bewusst keine Importe: sie ist die Teilmenge, die
 * ohne DOM, ohne `window.yuvomi` und ohne Haushaltskontext entscheidbar ist.
 * Was an `isSoloHousehold()` oder den Modul-Schaltern hängt
 * (`isWidgetModuleEnabled`), bleibt drüben in der Seite.
 * Guards: test/test-dashboard.js, Abschnitt „Widget-Konfiguration".
 */

// Reihenfolge = Standard-Layout. Die primären Inhalte (tasks, calendar) führen,
// damit sie beim Wieder-Einblenden oben stehen; das einzige passive Widget
// (weather) steht bewusst am Ende, statt die sichtbare Grid-Spitze zu belegen.
/* DIE REIHENFOLGE DIESER LISTE IST SEIT 2026-08-13 FREI - sie war es vorher
 * nicht. Bis dahin hängte `normalizeDashboardConfig` eine neu bekannte Id an
 * bestehende Layouts HINTEN an, während `isUserOrderedConfig` die Reihenfolge
 * gegen genau diese Liste vergleicht. Beide Reihenfolgen stimmten nur überein,
 * solange neue Ids auch hier hinten standen; wer eine neue Id vor eine
 * bestehende setzte, liess JEDES Bestandslayout als „umsortiert" lesen, und das
 * Raster schaltete stillschweigend von der dichten Packung auf preserve-order
 * um (der Regress aus Audit A1-03). `metrics` steht deshalb bis heute am Ende,
 * obwohl die Kachelreihe oben am meisten taugt.
 * Der Merge sortiert eine fehlende Id jetzt an ihrer Default-Position ein statt
 * sie anzuhängen, damit hält der Vergleich unabhängig von der Position. Die
 * Zusicherung ist damit nicht mehr eine Regel im Kopf, sondern ein Guard:
 * „Bestandslayout ohne genau eine Id liest sich nicht als umsortiert", über
 * JEDE Id dieser Liste. Wer hier umsortiert, prüft ihn - er ist der Ort, an dem
 * ein Fehler auffällt. */
export const WIDGET_IDS = ['tasks', 'calendar', 'meals', 'shopping', 'birthdays', 'countdown', 'budget', 'rewards', 'health', 'cycle', 'housekeeping', 'schedule', 'family', 'notes', 'weather', 'clock', 'metrics', 'quicklinks'];

// Vier kuratierte Formen statt sechs: über vier Auswahlmöglichkeiten pro Widget
// (× bis zu 12 Widgets) kippt der Anpassen-Modus in Mikro-Entscheidungs-Overhead
// für ein Familienpublikum (Critique P2, ≤4-Choices-Regel). Die früheren 3x2/4x2
// bleiben als Legacy-Werte gültig (WIDGET_SIZE_OPTIONS) — bestehende Layouts werden
// nicht zurückgesetzt, nur die Neu-Auswahl steuert auf diese vier zu.
export const WIDGET_SIZE_PRESETS = [
  { value: '1x1', labelKey: 'dashboard.widgetSizeTiny'     },
  { value: '2x1', labelKey: 'dashboard.widgetSizeNarrow'   },
  { value: '1x2', labelKey: 'dashboard.widgetSizeTall'     },
  { value: '2x2', labelKey: 'dashboard.widgetSizeStandard' },
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
  if (['tasks', 'calendar', 'rewards', 'budget', 'family', 'notes', 'birthdays', 'countdown', 'schedule'].includes(id)) return '1x2';
  // Die Uhr startet breit statt quadratisch: Uhrzeit und darunter der ausgeschriebene
  // Wochentag brauchen Zeile, nicht Höhe - auf 1x1 bräche das Datum um (#651).
  // `quicklinks` steht bei der Uhr und nicht bei den Listen: es ist eine ZEILE
  // aus Kacheln (#469), keine Liste aus Zeilen. Auf 1x1 passten zwei davon
  // nebeneinander, und eine Startrampe mit zwei Plaetzen ist keine.
  if (['weather', 'shopping', 'health', 'cycle', 'meals', 'clock', 'quicklinks'].includes(id)) return '2x1';
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
// plus die drei neueren Module (rewards, health, housekeeping). Letztere sind
// spezialisiert und nicht in jedem Haushalt aktiv — sie erscheinen als Opt-in im
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
export const DEFAULT_HIDDEN_WIDGETS = new Set([...COCKPIT_COVERED_WIDGETS, 'rewards', 'health', 'cycle', 'housekeeping', 'schedule', 'clock', 'weather', 'quicklinks']);

export function defaultWidgetVisible(id) {
  return !DEFAULT_HIDDEN_WIDGETS.has(id);
}

export const DEFAULT_WIDGET_CONFIG = WIDGET_IDS.map((id, i) => ({ id, visible: defaultWidgetVisible(id), order: i, size: defaultWidgetSize(id) }));

/**
 * Wo eine fehlende Id in ein gespeichertes Layout gehört: direkt hinter den
 * nächsten in WIDGET_IDS VORANGEHENDEN Eintrag, der dort schon vorkommt.
 *
 * ANHÄNGEN WAR DIE BEQUEMERE ANTWORT UND DIE TEURERE. Eine ans Ende gehängte
 * Id ist nur dann an ihrer Default-Position, wenn sie auch in WIDGET_IDS ganz
 * hinten steht - und `isUserOrderedConfig` vergleicht gegen WIDGET_IDS. Aus
 * einer Datenoperation wurde so eine Reihenfolgen-Vorschrift für eine Liste
 * zwei Bildschirme weiter oben. Hier kostet die richtige Antwort eine
 * Rückwärtssuche.
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

// Hat der Nutzer die Widget-Reihenfolge bewusst geändert (vs. dem Autor-Default)?
// Nur dann darf das Grid auf `grid-auto-flow: row` umschalten, um die gesetzte
// Ordnung zu bewahren. Beim unveränderten Default packt `dense` die Kacheln dicht
// (kein toter Weißraum auf breitem Desktop) — die Löcher entstünden sonst nicht aus
// „Nutzerabsicht", sondern nur, weil der Default-Satz nicht sauber tesselliert (Critique P2).
export function isUserOrderedConfig(cfg) {
  if (!Array.isArray(cfg)) return false;
  // Nur sichtbare, beidseitig bekannte Widgets vergleichen: eine Id, die im
  // gespeicherten Layout steht und in WIDGET_IDS nicht mehr (abgeschaffte
  // Widgets alter Stände), und reine Sichtbarkeits-Toggles sind KEINE
  // Nutzer-Umsortierung. Der strikte Voll-Vergleich schaltete sonst dauerhaft
  // auf preserve-order und der dense-Bento füllte nie wieder Lücken
  // (Audit A1-03).
  //
  // DER UMGEKEHRTE FALL - eine Id, die normalizeDashboardConfig gerade selbst
  // ERGÄNZT hat, weil sie in WIDGET_IDS neu ist - fällt hier nicht auf, und
  // zwar seit 2026-08-13 aus dem richtigen Grund: der Merge setzt sie an ihre
  // Default-Position, nicht ans Ende. Vorher hing das an der Vereinbarung, neue
  // Ids auch in WIDGET_IDS hinten anzuhängen. Siehe die Notiz dort.
  const defaultIds = DEFAULT_WIDGET_CONFIG.map((w) => w.id);
  const currentOrder = [...cfg]
    .filter((w) => w.visible !== false && defaultIds.includes(w.id))
    .sort((a, b) => a.order - b.order)
    .map((w) => w.id);
  const defaultOrder = defaultIds.filter((id) => currentOrder.includes(id));
  return currentOrder.join(',') !== defaultOrder.join(',');
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
export function dashboardQuery(config) {
  const params = new URLSearchParams();
  const optionsOf = (id) => (Array.isArray(config) ? config.find((w) => w.id === id)?.options : null) ?? {};
  if (optionsOf('calendar').scope === 'mine') params.set('events_scope', 'mine');
  // Nur die Abwahl reist mit (#927): „mit Geburtstagen" ist der Auslieferungs-
  // zustand der Route, und ein Parameter, der ihn wiederholt, stuende in jeder
  // Anfrage - dieselbe Regel, nach der `scope: 'all'` nicht gespeichert wird.
  if (optionsOf('calendar').birthdays === 'hide') params.set('events_birthdays', 'hide');
  for (const key of optionsOf('tasks').categories ?? []) params.append('tasks_category', key);
  for (const id of optionsOf('notes').categories ?? []) params.append('notes_category', String(id));
  const query = params.toString();
  return query ? `/dashboard?${query}` : '/dashboard';
}
