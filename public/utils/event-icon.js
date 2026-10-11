/**
 * Modul: Das Icon eines Termins
 * Zweck: EINE Stelle sagt, welche Icons ein Termin tragen kann, welches davon
 *        ein eigenes ist und wie es gezeichnet wird - fuer den Kalender und
 *        fuer jede Flaeche, die seine Termine zeigt (Wand-Modus, #1829).
 * Abhaengigkeiten: /i18n.js (nur die Beschriftungen des Auswahldialogs)
 *
 * WARUM DAS NICHT IN DER KALENDERSEITE STEHT. Dort stand es, und die Uebersicht
 * konnte es nicht fragen: sie setzte an jeden Termin das Kalenderzeichen. Eine
 * zweite Liste in der Uebersicht waere die naheliegende Abkuerzung gewesen und
 * die falsche - ein Name, den der Lucide-Stand der App nicht kennt, bricht
 * nichts, der Platz bleibt einfach leer. Wer hier ein Icon ergaenzt, ergaenzt
 * es fuer alle; der Server fuehrt dieselbe Liste als `VALID_EVENT_ICONS`
 * (server/routes/calendar/helpers.js).
 */
import { t } from '/i18n.js';

const EVENT_ICON_ALIASES = {
  drill: 'tooth',
};

export const EVENT_ICON_CATEGORIES = () => [
  {
    key: 'general',
    label: t('calendar.iconCategoryGeneral'),
    icons: [
      { value: 'calendar', label: t('calendar.iconCalendar') },
      { value: 'alarm-clock', label: t('calendar.iconAlarm') },
      { value: 'clock', label: t('calendar.iconClock') },
      { value: 'bell', label: t('calendar.iconBell') },
      { value: 'map-pin', label: t('calendar.iconLocation') },
      { value: 'star', label: t('calendar.iconStar') },
      { value: 'flag', label: t('calendar.iconFlag') },
      { value: 'target', label: t('calendar.iconTarget') },
      { value: 'flame', label: t('calendar.iconFlame') },
    ],
  },
  {
    key: 'health',
    label: t('calendar.iconCategoryHealth'),
    icons: [
      { value: 'tooth', label: t('calendar.iconTooth') },
      { value: 'hospital', label: t('calendar.iconHospital') },
      { value: 'stethoscope', label: t('calendar.iconDoctor') },
      { value: 'syringe', label: t('calendar.iconVaccine') },
      { value: 'pill', label: t('calendar.iconMedicine') },
      { value: 'bandage', label: t('calendar.iconBandage') },
      { value: 'heart-pulse', label: t('calendar.iconHealth') },
      { value: 'activity', label: t('calendar.iconActivity') },
      { value: 'scissors', label: t('calendar.iconHaircut') },
      { value: 'dumbbell', label: t('calendar.iconSports') },
      { value: 'trophy', label: t('calendar.iconTrophy') },
    ],
  },
  {
    key: 'transport',
    label: t('calendar.iconCategoryTransport'),
    icons: [
      { value: 'car', label: t('calendar.iconCar') },
      { value: 'bus', label: t('calendar.iconBus') },
      { value: 'train', label: t('calendar.iconTrain') },
      { value: 'plane', label: t('calendar.iconPlane') },
      { value: 'plane-takeoff', label: t('calendar.iconFlight') },
      { value: 'fuel', label: t('calendar.iconFuel') },
      { value: 'navigation', label: t('calendar.iconNavigation') },
      { value: 'bike', label: t('calendar.iconBike') },
    ],
  },
  {
    key: 'work',
    label: t('calendar.iconCategoryWork'),
    icons: [
      { value: 'briefcase', label: t('calendar.iconWork') },
      { value: 'laptop', label: t('calendar.iconLaptop') },
      { value: 'presentation', label: t('calendar.iconPresentation') },
      { value: 'school', label: t('calendar.iconSchool') },
      { value: 'graduation-cap', label: t('calendar.iconEducation') },
      { value: 'book-open', label: t('calendar.iconReading') },
      { value: 'pencil', label: t('calendar.iconStudy') },
      { value: 'calculator', label: t('calendar.iconCalculator') },
    ],
  },
  {
    key: 'food',
    label: t('calendar.iconCategoryFood'),
    icons: [
      { value: 'utensils', label: t('calendar.iconMeal') },
      { value: 'cooking-pot', label: t('calendar.iconCooking') },
      { value: 'coffee', label: t('calendar.iconCoffee') },
      { value: 'cake', label: t('calendar.iconCake') },
      { value: 'pizza', label: t('calendar.iconPizza') },
      { value: 'wine', label: t('calendar.iconWine') },
      { value: 'beer', label: t('calendar.iconBeer') },
    ],
  },
  {
    key: 'shopping',
    label: t('calendar.iconCategoryShopping'),
    icons: [
      { value: 'shopping-bag', label: t('calendar.iconShopping') },
      { value: 'shopping-cart', label: t('calendar.iconGroceries') },
      { value: 'gift', label: t('calendar.iconGift') },
      { value: 'credit-card', label: t('calendar.iconCard') },
      { value: 'wallet', label: t('calendar.iconWallet') },
      { value: 'piggy-bank', label: t('calendar.iconSavings') },
      { value: 'landmark', label: t('calendar.iconBank') },
    ],
  },
  {
    key: 'leisure',
    label: t('calendar.iconCategoryLeisure'),
    icons: [
      { value: 'music', label: t('calendar.iconMusic') },
      { value: 'film', label: t('calendar.iconMovie') },
      { value: 'ticket', label: t('calendar.iconTicket') },
      { value: 'gamepad-2', label: t('calendar.iconGame') },
      { value: 'camera', label: t('calendar.iconPhoto') },
      { value: 'party-popper', label: t('calendar.iconParty') },
    ],
  },
  {
    key: 'family',
    label: t('calendar.iconCategoryFamily'),
    icons: [
      { value: 'users', label: t('calendar.iconFamily') },
      { value: 'baby', label: t('calendar.iconBaby') },
      { value: 'dog', label: t('calendar.iconDog') },
      { value: 'cat', label: t('calendar.iconCat') },
      { value: 'paw-print', label: t('calendar.iconPet') },
    ],
  },
  {
    key: 'home',
    label: t('calendar.iconCategoryHome'),
    icons: [
      { value: 'home', label: t('calendar.iconHome') },
      { value: 'building', label: t('calendar.iconBuilding') },
      { value: 'wrench', label: t('calendar.iconRepair') },
      { value: 'hammer', label: t('calendar.iconMaintenance') },
      { value: 'paintbrush', label: t('calendar.iconCleaning') },
      { value: 'sofa', label: t('calendar.iconFurniture') },
      { value: 'washing-machine', label: t('calendar.iconLaundry') },
    ],
  },
  {
    key: 'nature',
    label: t('calendar.iconCategoryNature'),
    icons: [
      { value: 'leaf', label: t('calendar.iconLeaf') },
      { value: 'tree-pine', label: t('calendar.iconTree') },
      { value: 'flower', label: t('calendar.iconFlower') },
      { value: 'sun', label: t('calendar.iconSun') },
      { value: 'moon', label: t('calendar.iconMoon') },
      { value: 'cloud-sun', label: t('calendar.iconWeather') },
    ],
  },
];

// Flache Liste aller Icons für Kompatibilität (z.B. eventIconName-Validierung)
const EVENT_ICONS = EVENT_ICON_CATEGORIES().flatMap((cat) => cat.icons);

// `balloon` was added to Lucide after the app's vendored v0.469.0 bundle. Keep
// this single glyph local instead of turning name-day polish into a full icon
// library upgrade. Its SVG paths come from Lucide v0.557.0 and are covered by
// public/vendor/lucide/LICENSE.balloon-v0.557.0.
export const CUSTOM_EVENT_ICON_PATHS = Object.freeze({
  tooth: [
    'M8.5 3.5c1.2 0 2.1.5 3.5.5s2.3-.5 3.5-.5c2.4 0 4 1.8 4 4.4 0 2.2-1 4.2-1.7 5.7-.7 1.6-.8 3.1-1.1 4.7-.3 1.7-1.1 3.2-2.4 3.2-1.1 0-1.5-1.1-1.8-2.7-.2-1.2-.4-2.1-.5-2.1s-.3.9-.5 2.1c-.3 1.6-.7 2.7-1.8 2.7-1.3 0-2.1-1.5-2.4-3.2-.3-1.6-.4-3.1-1.1-4.7C5.5 12.1 4.5 10.1 4.5 7.9c0-2.6 1.6-4.4 4-4.4Z',
    'M10 6.2c.7.3 1.3.5 2 .5s1.3-.2 2-.5',
  ],
  balloon: [
    'M12 16v1a2 2 0 0 0 2 2h1a2 2 0 0 1 2 2v1',
    'M12 6a2 2 0 0 1 2 2',
    'M18 8c0 4-3.5 8-6 8s-6-4-6-8a6 6 0 0 1 12 0',
  ],
});
const CUSTOM_EVENT_ICONS = new Set(Object.keys(CUSTOM_EVENT_ICON_PATHS));

export function eventIconName(icon) {
  const normalized = EVENT_ICON_ALIASES[icon] || icon;
  return CUSTOM_EVENT_ICONS.has(normalized) || EVENT_ICONS.some((item) => item.value === normalized)
    ? normalized
    : 'calendar';
}

/**
 * Hat dieser Termin ein EIGENES Icon - also eines, das etwas hinzufuegt?
 *
 * 'calendar' ist der Datenbank-Default der Spalte und zugleich der Rueckfall
 * von eventIconName() fuer alles Unbekannte: ein Termin, an dem nie jemand ein
 * Icon gewaehlt hat, traegt es trotzdem. Ein generisches Kalender-Glyph an
 * jedem Termin INNERHALB des Kalenders sagt nichts (Herkunfts-Regel: im
 * eigenen Raum ist die Herkunft selbstverstaendlich) und kostet den Titel
 * Platz. Die Zugehoerigkeit traegt die Farbkante.
 *
 * DIE REGEL GILT IN JEDER ANSICHT (Critique 2026-09-24, P2). Bis dahin fragte
 * nur das Tagesraster; Woche, Ganztag und Agenda setzten das Standardglyph als
 * Fuellsel, der Monat gar keins - vier Antworten auf eine Frage. Jetzt geht
 * jeder Termin durch eventGlyphsHtml().
 */
export function hasEventIcon(icon) {
  return eventIconName(icon) !== 'calendar';
}

function customEventIconHtml(icon, className) {
  const paths = CUSTOM_EVENT_ICON_PATHS[icon];
  if (!paths) return '';
  return `<svg class="${className} event-icon--custom" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
    ${paths.map((path) => `<path d="${path}"/>`).join('\n    ')}
  </svg>`;
}

export function eventIconHtml(icon, className = 'event-icon') {
  const name = eventIconName(icon);
  if (CUSTOM_EVENT_ICONS.has(name)) return customEventIconHtml(name, className);
  return `<i class="${className}" data-lucide="${name}" aria-hidden="true"></i>`;
}
