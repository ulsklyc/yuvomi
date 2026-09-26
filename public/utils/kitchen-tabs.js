import { t } from '/i18n.js';
import { api } from '/api.js';
import { renderSubTabs, selectSubTab, setSubTabBadge, scrollActiveSubTabIntoView } from '/utils/sub-tabs.js';
import { navigationFrom } from '/utils/view-transition.js';
import { MODULE_ICON, moduleIconEl } from '/nav-icons.js';
import { todayKey } from '/utils/date.js';
import { KITCHEN_MODULES as KITCHEN_MODULES_SOURCE } from '/utils/module-accent.js';

// Reihenfolge = Küchen-Kreislauf: planen → kochen → einkaufen → lagern.
//
// DIE ABLEITUNG LÄUFT SEIT 2026-08-18 ANDERSHERUM: die Modul-Ids stehen in
// `/utils/module-accent.js`, die Routen entstehen hier daraus. Vorher war es
// umgekehrt, und das ging so lange gut, wie niemand ausserhalb dieser Datei die
// Gruppe brauchte - der geteilte Ton-Auflöser tut es, und diese Datei wird vom
// Test-Loader gestubt. Die Begründung steht dort; die Aussage ist dieselbe wie
// vorher: EINE Quelle für die Frage „gehört dieses Modul zur Küche?".
export { KITCHEN_MODULES } from '/utils/module-accent.js';
export const KITCHEN_ROUTES = Object.freeze(KITCHEN_MODULES_SOURCE.map((mod) => `/${mod}`));
export const KITCHEN_STORAGE_KEY = 'yuvomi-kitchen-tab';

const TABS = () => [
  { route: '/meals',    labelKey: 'nav.meals',    icon: 'utensils'      },
  { route: '/recipes',  labelKey: 'nav.recipes',  icon: 'book-text'     },
  { route: '/shopping', labelKey: 'nav.shopping', icon: 'shopping-cart' },
  { route: '/pantry',   labelKey: 'nav.pantry',   icon: 'archive'       },
].filter(({ route }) => !window.yuvomi?.isModuleDisabled(route.slice(1)));

export function getLastKitchenRoute() {
  try {
    const stored = sessionStorage.getItem(KITCHEN_STORAGE_KEY);
    if (KITCHEN_ROUTES.includes(stored) && !window.yuvomi?.isModuleDisabled(stored.slice(1))) {
      return stored;
    }
  } catch { /* ignore */ }
  const first = ['meals', 'recipes', 'shopping', 'pantry'].find((m) => !window.yuvomi?.isModuleDisabled(m));
  return first ? `/${first}` : '/meals';
}

export function isKitchenRoute(path) {
  return KITCHEN_ROUTES.includes(path);
}

export function isKitchenModule(mod) {
  return !!mod && KITCHEN_MODULES.includes(mod);
}

// --------------------------------------------------------
// Kreislauf-Zustand in der Leiste
// --------------------------------------------------------

/**
 * Die Tab-Leiste trägt den Zustand der Nachbar-Stationen.
 *
 * WARUM: Der Kreislauf planen → kochen → einkaufen → lagern ist die Produktidee
 * dieses Moduls, und erzählt wurde er ausschließlich in den vier
 * Leerzustands-Hinweisen. Mit dem ersten Datensatz verschwand er, und übrig blieben
 * vier Schubladen (Critique 2026-07-30, P1). Mit „Einkaufen 12" neben „Vorrat 8"
 * ist der nächste Schritt immer sichtbar.
 *
 * WARUM REZEPTE UND MAHLZEITEN KEINS BEKOMMEN: ein Badge sagt „dort wartet
 * etwas". Eine Rezeptsammlung hat keinen offenen Zustand - „6 Rezepte" wäre eine
 * Bestandszahl, keine Aufforderung.
 *
 * Der Essensplan hatte eins („{{count}} freie Mahlzeiten diese Woche") und es
 * zählte das Gegenteil: nicht was wartet, sondern was fehlt, gemessen an einem
 * Maximum, das niemand füllen will. Sichtbare Mahlzeitentypen × 7 Tage minus die
 * belegten Slots - bei leerer Woche und vier Typen also 28, die lauteste Zahl in
 * der Leiste, ausgerechnet für den Zustand „nichts geplant". Dazu zählte es Tage
 * mit, die schon vorbei waren: freitags stand das Frühstück vom Montag in der
 * Zahl, und das lässt sich nicht mehr planen. Eine Aufforderung, die
 * Unerreichbares mitzählt und die Null nie erreicht, ist keine. Die freien Slots
 * auf der Seite selbst erzählen es vollständiger.
 *
 * Übrig bleiben die zwei Stationen, die wirklich einen offenen Vorrat haben:
 * offene Artikel auf der Einkaufsliste, Vorratsartikel mit einer Frist.
 *
 * WARUM DER AKTIVE TAB KEIN BADGE TRÄGT: das Badge sagt „dort wartet etwas". Auf dem
 * Tab, auf dem man steht, sagt die Seite das vollständiger - die Einkaufsliste hat
 * ihre Zähler-Chips pro Liste, der Vorrat seine Filter-Chips („Abgelaufen 2",
 * „Fast leer 8"), der Essensplan zeigt die freien Slots als leere Kacheln.
 *
 * Das ist nicht nur Redundanzvermeidung, es löst ein Problem: eine Zahl auf dem
 * aktiven Tab müsste nach JEDER Mutation der eigenen Seite nachgezogen werden -
 * abhaken, löschen, Menge ändern, Mahlzeit anlegen. Entweder man verdrahtet
 * zwanzig Aufrufstellen oder man zeigt eine veraltete Zahl direkt neben der
 * korrekten. Der inaktive Tab hat dieses Problem nicht: seine Zahl kann sich nur
 * durch einen Transfer ändern, und die vier Transfers rufen refreshKitchenBadges()
 * selbst auf.
 */
// Das `aria-label` ERSETZT den Namen des Tabs, es ergänzt ihn nicht. Deshalb wird
// der Tabname vorangestellt und die Locale-Keys tragen nur das Zustandsfragment -
// ohne das hörte ein Screenreader „12 offene Artikel" und wüsste nicht, wohin der
// Knopf führt.
const BADGES = [
  {
    route: '/shopping',
    pick: (d) => d.shopping?.open ?? 0,
    label: (count) => `${t('nav.shopping')}: ${t('nav.shoppingOpen', { count })}`,
  },
  {
    route: '/pantry',
    pick: (d) => d.pantry?.attention ?? 0,
    // Der einzige Ton-Ausschlag: abgelaufene und fast leere Artikel sind das
    // einzige Küchen-Signal mit einer Frist.
    tone: 'warning',
    label: (count) => `${t('nav.pantry')}: ${t('nav.pantryAttention', { count })}`,
  },
];

/** Aktuelle Leiste; der Zustand wird nachgeladen, nachdem sie schon steht. */
let _bar = null;
/** Der ResizeObserver der stehenden Leiste - einer, nie mehr. */
let _indicatorObserver = null;
let _activeRoute = null;
let _refreshTimer = null;
/**
 * Die letzte Antwort von /kitchen/summary. Sie haelt den PLATZ der Zahlen
 * (Critique 2026-09-26, A4): die Leiste zeichnet ihre Badges beim Tabwechsel
 * sofort aus dem letzten Stand, statt 22px breiter zu werden, sobald die
 * Antwort kommt - sonst verschoebe sich das Ziel der gleitenden Kapsel mitten
 * in der Bewegung. Der Abruf danach zieht nur nach, was sich geaendert hat.
 */
let _lastSummary = null;

function applyBadges(data) {
  if (!_bar || !data) return;
  for (const { route, pick, label, tone } of BADGES) {
    const count = route === _activeRoute ? 0 : Number(pick(data)) || 0;
    setSubTabBadge(_bar, route, count > 0 ? { count, tone, label: label(count) } : null);
  }
}

async function loadBadges() {
  if (!_bar?.isConnected) return;
  try {
    // `today` kommt vom Client: „abgelaufen" hängt am lokalen Kalendertag, und der
    // Server rechnet in UTC (siehe server/routes/kitchen.js).
    const res = await api.get(`/kitchen/summary?today=${encodeURIComponent(todayKey())}`);
    const data = res.data ?? {};
    if (!_bar?.isConnected) return;
    _lastSummary = data;
    applyBadges(data);
    // Die Zahlen machen die Leiste breiter (je 22px gemessen). Bei 320px läuft sie
    // damit über, und der aktive Tab - beim Rendern korrekt eingescrollt - konnte
    // danach teilweise außerhalb liegen.
    scrollActiveSubTabIntoView(_bar);
  } catch {
    // Ein fehlender Zustand ist kein Fehler, den der Nutzer sehen muss: die Leiste
    // navigiert weiter, sie erzählt nur weniger. Genau wie vor diesem Zusatz.
  }
}

/**
 * Lädt die Zahlen neu. Debounced, weil die aufrufenden Renderer in Serie feuern
 * (ein Abhaken löst in der Einkaufsliste mehrere Teil-Renders aus).
 *
 * Aufrufer sind die VIER TRANSFERS - nicht jede Mutation: nur ein Transfer ändert
 * die Zahl eines anderen Tabs, und nur die wird angezeigt (der aktive Tab trägt
 * kein Badge, siehe oben). Alles andere deckt der Abruf beim Seitenwechsel ab.
 */
export function refreshKitchenBadges() {
  clearTimeout(_refreshTimer);
  _refreshTimer = setTimeout(loadBadges, 200);
}

// --------------------------------------------------------
// Die gleitende Kapsel
// --------------------------------------------------------

/**
 * DIE LEISTE STEHT, DIE KAPSEL GLEITET (Critique 2026-09-26, A4 P2).
 *
 * Ein Kuechen-Tab ist ein Routenwechsel, und bis hierher baute jede der vier
 * Seiten ihre eigene Leiste: die angetippte Leiste glitt mit der Seite herein
 * (20px + Blende), die aktive Pille sprang. "Ein Ort mit vier Tabs" fuehlte
 * sich an wie vier Seiten. Apples Segmented Control steht still, nur die
 * Auswahl gleitet.
 *
 * Deshalb zwei Dinge:
 *   1. Die Leiste ist ueber einen Wechsel INNERHALB der Kueche derselbe Knoten.
 *      Die naechste Seite haengt ihn wieder ein, statt einen neuen zu bauen,
 *      und die View Transition zeigt von ihm nur das lebende Bild
 *      (`kitchen-tabs` in layout.css) - er steht.
 *   2. Die Auswahl ist eine eigene Kapsel unter den Labels, keine Flaeche am
 *      Tab. Sie gleitet per Web Animations vom alten zum neuen Tab. Web
 *      Animations und nicht `transition`: das Wiedereinhaengen beim
 *      Seitentausch bricht eine CSS-Transition ab, eine Script-Animation laeuft
 *      weiter.
 *
 * Die Bewegung beginnt schon beim Tipp (onChange), nicht erst, wenn die neue
 * Seite steht - wie die Pille der unteren Kapsel (updateNav in router.js).
 */
const INDICATOR_CLASS = 'kitchen-tabs-bar__indicator';

function tokenValue(name, fallback) {
  const value = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  return value || fallback;
}

function tokenMs(name, fallback) {
  const value = parseFloat(tokenValue(name, ''));
  return Number.isFinite(value) ? value : fallback;
}

function reducedMotion() {
  return typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;
}

function indicatorOf(bar) {
  return bar?.querySelector(`:scope > .${INDICATOR_CLASS}`) ?? null;
}

function activeTabBox(bar) {
  const tab = bar.querySelector('.sub-tab--active');
  if (!tab || !tab.offsetWidth) return null;
  return { x: tab.offsetLeft, y: tab.offsetTop, w: tab.offsetWidth, h: tab.offsetHeight };
}

function writeBox(indicator, box) {
  indicator.style.transform = `translate(${box.x}px, ${box.y}px)`;
  indicator.style.width = `${box.w}px`;
  indicator.style.height = `${box.h}px`;
}

/** Wo die Kapsel GERADE zu sehen ist - mitten in einer Bewegung nicht ihr Ziel. */
function visibleBox(indicator) {
  if (!indicator._box) return null;
  if (indicator._glide?.playState !== 'running') return indicator._box;
  const style = getComputedStyle(indicator);
  const matrix = new DOMMatrixReadOnly(style.transform === 'none' ? undefined : style.transform);
  return { x: matrix.m41, y: matrix.m42, w: parseFloat(style.width), h: parseFloat(style.height) };
}

/**
 * Setzt die Kapsel unter den aktiven Tab.
 * @param {HTMLElement} bar
 * @param {{ glide?: boolean }} [opts]  glide: vom sichtbaren Stand aus gleiten
 */
function placeIndicator(bar, { glide = false } = {}) {
  const indicator = indicatorOf(bar);
  if (!indicator) return;
  const to = activeTabBox(bar);
  if (!to) return;
  const current = indicator._box;
  if (current && current.x === to.x && current.y === to.y && current.w === to.w && current.h === to.h) return;

  const from = visibleBox(indicator);
  indicator._glide?.cancel();
  indicator._glide = null;
  writeBox(indicator, to);
  indicator._box = to;
  bar.classList.add('has-indicator');

  if (!glide || !from || reducedMotion() || typeof indicator.animate !== 'function') return;
  indicator._glide = indicator.animate([
    { transform: `translate(${from.x}px, ${from.y}px)`, width: `${from.w}px`, height: `${from.h}px` },
    { transform: `translate(${to.x}px, ${to.y}px)`, width: `${to.w}px`, height: `${to.h}px` },
  ], {
    duration: tokenMs('--duration-lg', 250),
    easing: tokenValue('--ease-out', 'ease-out'),
  });
}

function wireIndicator(bar) {
  const indicator = document.createElement('span');
  indicator.className = INDICATOR_CLASS;
  indicator.setAttribute('aria-hidden', 'true');
  bar.prepend(indicator);
  // Schrift nachgeladen, Badge dazu, Breakpoint gewechselt: die Tabs aendern
  // Breite oder Lage, und die Kapsel zieht mit - mitten in einer Bewegung
  // gleitend, sonst ohne.
  // Es gibt nur EINE Leiste: der Beobachter der vorigen geht mit ihr, sonst
  // hielte jeder Eintritt in die Kueche einen weiteren samt abgehaengter Knoten.
  _indicatorObserver?.disconnect();
  _indicatorObserver = null;
  if (typeof ResizeObserver === 'function') {
    _indicatorObserver = new ResizeObserver(() => {
      placeIndicator(bar, { glide: indicator._glide?.playState === 'running' });
    });
    _indicatorObserver.observe(bar);
    bar.querySelectorAll('.sub-tab').forEach((tab) => _indicatorObserver.observe(tab));
  }
}

/**
 * Passt die stehende Leiste noch? Ziele UND Beschriftungen: nach einem
 * Sprachwechsel zeichnet der Router dieselbe Route neu, und eine nur nach
 * Zielen verglichene Leiste bliebe in der alten Sprache stehen.
 */
function sameTabs(bar, tabs) {
  if (bar.getAttribute('aria-label') !== t('nav.kitchen')) return false;
  const els = [...bar.querySelectorAll('[data-tab-id]')];
  return els.length === tabs.length && tabs.every(({ route, labelKey }, i) =>
    els[i].dataset.tabId === route
    && els[i].querySelector('.sub-tab__label')?.textContent === t(labelKey));
}

/**
 * Die stehende Leiste auf die Route ziehen, auf der die App wirklich steht.
 * Der Router nimmt waehrend einer laufenden Navigation keine zweite an; die
 * Leiste hat den zweiten Tipp dann schon markiert, und niemand zeichnete sie
 * danach neu - Einkauf offen, Vorrat aktiv und als letzte Kuechen-Route gemerkt.
 */
function syncToLocation() {
  const path = location.pathname;
  if (!_bar?.isConnected || !isKitchenRoute(path) || path === _activeRoute) return;
  _activeRoute = path;
  selectSubTab(_bar, path);
  applyBadges(_lastSummary);
  placeIndicator(_bar, { glide: true });
}

/** Tipp auf einen Tab: Zahlen und Kapsel ziehen sofort, die Seite folgt. */
function onTabChosen(route) {
  _activeRoute = route;
  applyBadges(_lastSummary);
  placeIndicator(_bar, { glide: true });
  // Abgelehnt loest das Promise sofort auf, angenommen nach dem Render - beide
  // Male steht danach fest, wo die App ist.
  Promise.resolve(window.yuvomi?.navigate(route)).finally(syncToLocation);
}

export function renderKitchenTabsBar(container, activeRoute) {
  container.classList.add('has-kitchen-tabs');
  _activeRoute = activeRoute;

  const tabs = TABS();
  // Nur innerhalb der Kueche bleibt die Leiste stehen. Wer von aussen kommt,
  // bekommt eine frische - dort gibt es nichts, von wo die Kapsel gleiten
  // koennte, und die Leiste blendet mit der Seite ein.
  if (_bar && isKitchenRoute(navigationFrom()) && sameTabs(_bar, tabs)) {
    container.insertAdjacentElement('afterbegin', _bar);
    selectSubTab(_bar, activeRoute);
    applyBadges(_lastSummary);
    // Das Wiedereinhaengen setzt den waagrechten Scrollstand zurueck.
    scrollActiveSubTabIntoView(_bar);
    placeIndicator(_bar, { glide: true });
    refreshKitchenBadges();
    return _bar;
  }

  // Eine frische Leiste zeichnet ihre Zahlen nur aus einem frischen Abruf. Der
  // letzte Stand dient allein dem Gleiten innerhalb der Kueche; von aussen
  // koennte er einem anderen Konto gehoeren (Abmelden, Anmelden ohne Neuladen)
  // und bliebe bei einem gescheiterten Abruf fuer immer stehen.
  _lastSummary = null;
  _bar = renderSubTabs(container, {
    // Zielorte, keine Sichten: die vier Küchen-Routen sind vier eigenständige
    // Module (eigener `module:`-Wert in router.js, eigene Seitendatei, einzeln
    // abschaltbar). Die Leiste wird damit zur Navigation aus echten Links -
    // cmd-Klick öffnet den Vorrat im neuen Tab, wie überall sonst in der Shell.
    semantics: 'nav',
    tabs: tabs.map(({ route, labelKey, icon }) => ({ id: route, label: t(labelKey), icon })),
    activeId: activeRoute,
    storageKey: KITCHEN_STORAGE_KEY,
    extraClass: 'kitchen-tabs-bar',
    ariaLabel: t('nav.kitchen'),
    title: t('nav.kitchen'),
    // DER ABSENDER DER KÜCHE STEHT EINMAL, UND ZWAR HIER. Die vier Küchen-Köpfe
    // bekommen keinen: sie teilen EINEN Tint, weil sie EIN Raum sind - vier
    // Siegel wiederholten denselben Absender bei jedem Tabwechsel, und zwei der
    // vier Köpfe (Rezepte, Vorrat) tragen gar keinen Seitentitel, hätten also
    // einen Absender ohne Brief. Das Besteck ist dasselbe Zeichen, das die
    // Bottom-Nav für „Küche" führt (kitchenNavButtonEl in router.js).
    sealIcon: () => moduleIconEl(MODULE_ICON.kitchen),
    insertPosition: 'afterbegin',
    onChange: onTabChosen,
  });
  wireIndicator(_bar);
  applyBadges(_lastSummary);
  scrollActiveSubTabIntoView(_bar);
  placeIndicator(_bar);

  refreshKitchenBadges();
  return _bar;
}
