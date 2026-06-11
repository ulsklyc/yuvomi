export const KITCHEN_CHILD_IDS = Object.freeze(['meals', 'recipes', 'shopping']);

const KITCHEN_CHILD_ID_SET = new Set(KITCHEN_CHILD_IDS);

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
