export const KITCHEN_CHILD_IDS = Object.freeze(['meals', 'recipes', 'shopping', 'pantry']);

// Eingebaute Module in kanonischer Domaenen-Reihenfolge. Uebersicht und
// Einstellungen sind gesperrt: nicht sortierbar, nicht abschaltbar, nicht
// ausblendbar - wer sie wegnimmt, versteckt sich den Weg zurueck.
//
// Sie liegen HIER und nicht in einem der beiden Blaetter, seit der
// Haushalts-Schalter aus der Navigation nach `modules-active` gezogen ist
// (#673): zwei Blaetter zeigen dieselbe Modulliste mit verschiedenen
// Bedienelementen, und eine zweite Liste waere die naechste, die driftet.
// Nur `labelKey`, kein `t()` - diese Datei bleibt ohne DOM und ohne i18n
// importierbar, weil Tests sie direkt laden.
//
// UND KEIN `icon`, aus demselben Grund wie der Kommentar darueber (2026-08-17):
// welches Zeichen ein Modul fuehrt, steht in `MODULE_ICON` (nav-icons.js). Es
// stand hier ein zweites Mal - noch stimmte es ueberein, aber „noch" ist genau
// die Lage, aus der die Stecknadel im Widget-Kopf entstanden ist. Die beiden
// Blaetter, die diese Liste lesen, laufen im Browser und holen es sich dort;
// dieser Datei bliebe sonst nur die Wahl zwischen einer Abschrift und einem
// Import, der ihre Test-Ladbarkeit kostet.
export const BUILT_IN_MODULES = Object.freeze([
  { id: 'dashboard', labelKey: 'nav.dashboard', locked: true },
  { id: 'calendar', labelKey: 'nav.calendar' },
  { id: 'schedule', labelKey: 'nav.schedule' },
  { id: 'tasks', labelKey: 'nav.tasks' },
  { id: 'notes', labelKey: 'nav.notes' },
  { id: 'contacts', labelKey: 'nav.contacts' },
  { id: 'birthdays', labelKey: 'nav.birthdays' },
  { id: 'budget', labelKey: 'nav.budget' },
  { id: 'documents', labelKey: 'nav.documents' },
  { id: 'inventory', labelKey: 'nav.inventory' },
  { id: 'housekeeping', labelKey: 'nav.housekeeping' },
  { id: 'waste', labelKey: 'nav.waste' },
  { id: 'rewards', labelKey: 'nav.rewards' },
  { id: 'health', labelKey: 'nav.health' },
  { id: 'settings', labelKey: 'nav.settings', locked: true },
]);

export const KITCHEN_CHILD_LABEL_KEYS = Object.freeze({
  meals: 'nav.meals',
  recipes: 'nav.recipes',
  shopping: 'nav.shopping',
  pantry: 'nav.pantry',
});

export const DEFAULT_MOBILE_NAV_ORDER = Object.freeze(['calendar', 'tasks', 'kitchen']);
export const NAV_SECTION = Object.freeze({
  overview: 0,
  plan: 1,
  household: 2,
  people: 3,
  finance: 4,
  customModules: 5,
});

// Die Navigationsgruppen in Anzeigereihenfolge, samt ihren Beschriftungen.
// Auch das lesen BEIDE Modul-Blaetter (Audit 2026-08-16): sie standen kurz
// doppelt da, und eine neue Gruppe haette in zwei Dateien nachgetragen werden
// muessen - dieselbe Drift, gegen die es fuer die Kuechen-Kinder schon einen
// Guard gibt.
export const NAV_SECTION_LABEL_KEYS = Object.freeze({
  [NAV_SECTION.overview]: 'nav.sectionOverview',
  [NAV_SECTION.plan]: 'nav.sectionPlan',
  [NAV_SECTION.household]: 'nav.sectionHousehold',
  [NAV_SECTION.people]: 'nav.sectionPeople',
  [NAV_SECTION.finance]: 'nav.sectionFinance',
  [NAV_SECTION.customModules]: 'nav.sectionCustomModules',
});

export const NAV_SECTIONS = Object.freeze([
  NAV_SECTION.overview,
  NAV_SECTION.plan,
  NAV_SECTION.household,
  NAV_SECTION.people,
  NAV_SECTION.finance,
  NAV_SECTION.customModules,
]);

// Akzent einer Drittanbieter-Zeile, wenn das Modul keinen eigenen mitbringt.
export const DEFAULT_MODULE_ACCENT = 'var(--color-accent)';

const KITCHEN_CHILD_ID_SET = new Set(KITCHEN_CHILD_IDS);
const PLAN_MODULE_IDS = new Set(['calendar', 'schedule', 'tasks', 'notes']);
// Ehemals ein einziger „Zuhause"-Sammeltopf (8 Module) — aufgeteilt in semantische
// Gruppen ≤5, damit die Sidebar-Sektion eine Bedeutung trägt statt „nicht Plan/Übersicht".
const HOUSEHOLD_MODULE_IDS = new Set(['kitchen', 'meals', 'recipes', 'shopping', 'housekeeping', 'waste', 'documents', 'inventory', 'rewards']);
const PEOPLE_MODULE_IDS = new Set(['contacts', 'birthdays', 'health']);
const FINANCE_MODULE_IDS = new Set(['budget']);
const MOBILE_NAV_ID_RE = /^[a-z0-9][a-z0-9-]*$/;

function isMobileNavId(id) {
  return (
    typeof id === 'string'
    && MOBILE_NAV_ID_RE.test(id)
    && id !== 'dashboard'
    && id !== 'settings'
  );
}

export function normalizeModuleOrder(order = []) {
  const normalized = [];
  const seen = new Set();
  let hasKitchen = false;

  for (const id of Array.isArray(order) ? order : []) {
    if (id === 'kitchen' || KITCHEN_CHILD_ID_SET.has(id)) {
      if (!hasKitchen) {
        normalized.push('kitchen');
        hasKitchen = true;
      }
      continue;
    }

    if (!seen.has(id)) {
      normalized.push(id);
      seen.add(id);
    }
  }

  return normalized;
}

export function expandModuleOrder(order = []) {
  return normalizeModuleOrder(order).flatMap((id) => (
    id === 'kitchen' ? KITCHEN_CHILD_IDS : [id]
  ));
}

export function moduleSection(id) {
  if (id === 'dashboard') return NAV_SECTION.overview;
  if (PLAN_MODULE_IDS.has(id)) return NAV_SECTION.plan;
  if (HOUSEHOLD_MODULE_IDS.has(id)) return NAV_SECTION.household;
  if (PEOPLE_MODULE_IDS.has(id)) return NAV_SECTION.people;
  if (FINANCE_MODULE_IDS.has(id)) return NAV_SECTION.finance;
  if (typeof id === 'string' && id.startsWith('third-party-')) return NAV_SECTION.customModules;
  return NAV_SECTION.household;
}

export function sortNavigationItems(items = [], order = []) {
  const orderIndex = new Map(
    normalizeModuleOrder(order).map((id, index) => [id, index]),
  );

  return (Array.isArray(items) ? items : [])
    .map((item, index) => ({ item, index }))
    .sort((left, right) => {
      const leftId = left.item?.orderId || left.item?.module || left.item?.id;
      const rightId = right.item?.orderId || right.item?.module || right.item?.id;

      if (leftId === 'dashboard') return rightId === 'dashboard' ? left.index - right.index : -1;
      if (rightId === 'dashboard') return 1;
      if (leftId === 'settings') return rightId === 'settings' ? left.index - right.index : 1;
      if (rightId === 'settings') return -1;

      const sectionDelta = moduleSection(leftId) - moduleSection(rightId);
      if (sectionDelta !== 0) return sectionDelta;

      const leftOrderId = KITCHEN_CHILD_ID_SET.has(leftId) ? 'kitchen' : leftId;
      const rightOrderId = KITCHEN_CHILD_ID_SET.has(rightId) ? 'kitchen' : rightId;
      const leftRank = orderIndex.get(leftOrderId) ?? Number.MAX_SAFE_INTEGER;
      const rightRank = orderIndex.get(rightOrderId) ?? Number.MAX_SAFE_INTEGER;
      return leftRank - rightRank || left.index - right.index;
    })
    .map(({ item }) => item);
}

export function normalizeMobileNavOrder(order = []) {
  return normalizeModuleOrder(order)
    .filter(isMobileNavId)
    .slice(0, 3);
}

export function resolveMobileNavOrder(order = [], availableIds = []) {
  const available = normalizeModuleOrder(availableIds).filter(isMobileNavId);
  const availableSet = new Set(available);
  const resolved = [];

  for (const id of [
    ...normalizeMobileNavOrder(order),
    ...DEFAULT_MOBILE_NAV_ORDER,
    ...available,
  ]) {
    if (availableSet.has(id) && !resolved.includes(id)) {
      resolved.push(id);
    }
    if (resolved.length === 3) break;
  }

  return resolved;
}

export function groupBuiltInModules(disabledModules = [], definitions = []) {
  const disabled = new Set(Array.isArray(disabledModules) ? disabledModules : []);
  const children = KITCHEN_CHILD_IDS.map((id) => ({
    id,
    enabled: !disabled.has(id),
  }));
  const enabledChildren = children.filter((child) => child.enabled).length;
  const kitchen = {
    id: 'kitchen',
    children,
    enabledChildren,
    enabled: enabledChildren > 0,
  };
  const grouped = [];
  let kitchenInserted = false;

  for (const definition of Array.isArray(definitions) ? definitions : []) {
    if (definition?.id === 'kitchen' || KITCHEN_CHILD_ID_SET.has(definition?.id)) {
      if (!kitchenInserted) {
        grouped.push(kitchen);
        kitchenInserted = true;
      }
      continue;
    }

    grouped.push(definition);
  }

  if (!kitchenInserted) {
    grouped.push(kitchen);
  }

  return grouped;
}
