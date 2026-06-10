/**
 * test-browser-loader.mjs - Node.js Custom Loader für Tests
 * Zweck: Browser-absolute Pfade (/foo.js) auf Stubs umleiten, damit
 *        Frontend-Module im Node-Test-Kontext importierbar sind.
 * Verwendung: node --loader ./test-browser-loader.mjs test-xxx.js
 * Dependencies: none
 */

const STUBS = {
  '/api.js': `
    export const api = {
      get: async () => ({ data: null }),
      post: async () => ({ data: null }),
      put: async () => ({ data: null }),
      patch: async () => ({ data: null }),
      delete: async () => ({ data: null }),
    };
    export const auth = {
      me: async () => ({ user: null }),
      getUsers: async () => ({ data: [] }),
      logout: async () => ({ ok: true }),
      updateProfile: async () => ({ user: null }),
    };
  `,
  '/i18n.js': `
    export const t = (key, values = {}) => {
      if (!values || Object.keys(values).length === 0) return key;
      return key + JSON.stringify(values);
    };
    export const initI18n = async () => {};
    export const setLocale = async () => {};
    export const getLocale = () => 'de';
    export const getSupportedLocales = () => ['de', 'en'];
    export const formatDate = (d) => String(d);
    export const formatTime = (d) => String(d);
    export const dateInputPlaceholder = () => 'YYYY-MM-DD';
    export const formatDateInput = (d) => String(d ?? '');
    export const parseDateInput = (d) => String(d ?? '');
    export const isDateInputValid = () => true;
    export const formatTimeInput = (d) => String(d ?? '');
    export const parseTimeInput = (d) => String(d ?? '');
    export const timeInputPlaceholder = () => 'HH:MM';
  `,
  '/rrule-ui.js': `
    export const renderRRuleFields = () => '';
    export const bindRRuleEvents = () => {};
    export const getRRuleValues = () => ({});
  `,
  '/components/modal.js': `
    export const openModal = () => {};
    export const closeModal = () => {};
    export const selectModal = async () => null;
  `,
  '/utils/ux.js': `
    export const stagger = () => {};
  `,
  '/utils/html.js': `
    export const esc = (value) => String(value ?? '')
      .replaceAll('&', '&amp;')
      .replaceAll('<', '&lt;')
      .replaceAll('>', '&gt;')
      .replaceAll('"', '&quot;')
      .replaceAll("'", '&#039;');
    export const fmtLocation = (value) => String(value ?? '');
    export const renderMarkdownLight = (value) => String(value ?? '');
  `,
  '/reminders.js': `
    export const refresh = async () => {};
  `,
  '/components/user-multi-select.js': `
    export const renderUserMultiSelect = () => '';
    export const getSelectedUserIds = () => [];
    export const bindUserMultiSelect = () => {};
    export const renderAvatarStack = () => '';
  `,
  '/utils/shopping-categories.js': `
    export const DEFAULT_CATEGORY_NAME = 'Sonstiges';
    export const categoryLabel = (category) => category?.name ?? String(category ?? '');
  `,
  '/utils/kitchen-tabs.js': `
    export const renderKitchenTabsBar = () => {};
  `,
  '/utils/pwa-install.js': `
    export const getPwaInstallState = () => ({
      installed: false,
      ios: false,
      canPrompt: false,
      supported: false,
    });
    export const onPwaInstallStateChanged = () => () => {};
    export const promptPwaInstall = async () => ({ outcome: 'unavailable' });
  `,
  '/utils/date.js': `
    const pad = (n) => String(n).padStart(2, '0');
    export const toLocalDateKey = (date) => {
      const d = date instanceof Date ? date : new Date(String(date) + 'T00:00:00');
      return \`\${d.getFullYear()}-\${pad(d.getMonth() + 1)}-\${pad(d.getDate())}\`;
    };
    export const addLocalDays = (dateStr, days) => {
      const d = new Date(String(dateStr) + 'T00:00:00');
      d.setDate(d.getDate() + days);
      return toLocalDateKey(d);
    };
    export const startOfLocalWeekKey = (dateStr, firstDay = 1) => {
      const d = new Date(String(dateStr) + 'T00:00:00');
      const day = d.getDay();
      const diff = (day < firstDay ? day + 7 : day) - firstDay;
      d.setDate(d.getDate() - diff);
      return toLocalDateKey(d);
    };
    export const shiftEndDateKey = (oldStartKey, newStartKey, endKey) => {
      const from = new Date(String(oldStartKey) + 'T00:00:00');
      const to = new Date(String(newStartKey) + 'T00:00:00');
      const deltaDays = Math.round((to.getTime() - from.getTime()) / 86400000);
      return addLocalDays(endKey, deltaDays);
    };
    export const isEndBeforeStart = (startDatetime, endDatetime) => {
      if (!endDatetime) return false;
      const [startDay, startTime] = String(startDatetime).split('T');
      const [endDay, endTime] = String(endDatetime).split('T');
      if (endDay !== startDay) return endDay < startDay;
      if (startTime && endTime) return endTime < startTime;
      return false;
    };
  `,
};

export async function resolve(specifier, context, nextResolve) {
  if (STUBS[specifier]) {
    return {
      shortCircuit: true,
      url: `data:text/javascript,${encodeURIComponent(STUBS[specifier])}`,
    };
  }
  // Browser-absolute paths (/foo.js, /utils/bar.js) → public/foo.js, public/utils/bar.js
  // Loader liegt in test/, daher eine Ebene hoch ins Projekt-Root.
  if (specifier.startsWith('/') && !specifier.startsWith('//')) {
    const resolved = new URL('../public' + specifier, import.meta.url).href;
    return nextResolve(resolved, context);
  }
  return nextResolve(specifier, context);
}
