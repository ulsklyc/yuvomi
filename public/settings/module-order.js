export const KITCHEN_CHILD_IDS = Object.freeze(['meals', 'recipes', 'shopping']);
export const DEFAULT_MOBILE_NAV_ORDER = Object.freeze(['calendar', 'tasks', 'kitchen']);
export const NAV_SECTION = Object.freeze({
  overview: 0,
  plan: 1,
  home: 2,
  customModules: 3,
});

const KITCHEN_CHILD_ID_SET = new Set(KITCHEN_CHILD_IDS);
const PLAN_MODULE_IDS = new Set(['calendar', 'tasks', 'notes']);
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
  if (typeof id === 'string' && id.startsWith('third-party-')) return NAV_SECTION.customModules;
  return NAV_SECTION.home;
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
