import { t } from '/i18n.js';
import { renderSubTabs } from '/utils/sub-tabs.js';

export const KITCHEN_ROUTES = Object.freeze(['/meals', '/recipes', '/shopping']);
export const KITCHEN_STORAGE_KEY = 'yuvomi-kitchen-tab';

const TABS = () => [
  { route: '/meals',    labelKey: 'nav.meals',    icon: 'utensils'      },
  { route: '/recipes',  labelKey: 'nav.recipes',  icon: 'book-text'     },
  { route: '/shopping', labelKey: 'nav.shopping', icon: 'shopping-cart' },
].filter(({ route }) => !window.yuvomi?.isModuleDisabled(route.slice(1)));

export function getLastKitchenRoute() {
  try {
    const stored = sessionStorage.getItem(KITCHEN_STORAGE_KEY);
    if (KITCHEN_ROUTES.includes(stored) && !window.yuvomi?.isModuleDisabled(stored.slice(1))) {
      return stored;
    }
  } catch { /* ignore */ }
  const first = ['meals', 'recipes', 'shopping'].find((m) => !window.yuvomi?.isModuleDisabled(m));
  return first ? `/${first}` : '/meals';
}

export function isKitchenRoute(path) {
  return KITCHEN_ROUTES.includes(path);
}

export function renderKitchenTabsBar(container, activeRoute) {
  container.classList.add('has-kitchen-tabs');

  renderSubTabs(container, {
    tabs: TABS().map(({ route, labelKey, icon }) => ({ id: route, label: t(labelKey), icon })),
    activeId: activeRoute,
    storageKey: KITCHEN_STORAGE_KEY,
    extraClass: 'kitchen-tabs-bar',
    ariaLabel: t('nav.kitchen'),
    title: t('nav.kitchen'),
    insertPosition: 'afterbegin',
    onChange: (route) => window.yuvomi?.navigate(route),
  });
}
