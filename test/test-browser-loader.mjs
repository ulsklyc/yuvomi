/**
 * test-browser-loader.mjs - Node.js Custom Loader für Tests
 * Zweck: Browser-absolute Pfade (/foo.js) auf Stubs umleiten, damit
 *        Frontend-Module im Node-Test-Kontext importierbar sind.
 * Verwendung: node --loader ./test-browser-loader.mjs test-xxx.js
 * Dependencies: none
 */

const STUBS = {
  '/sw-register.js': `
    export function clearApiCache() {}
  `,
  '/api.js': `
    // Tests, die eine REIHENFOLGE pruefen (die Antwort kommt NACH der
    // Bearbeitung), brauchen die Kontrolle ueber den Zeitpunkt der Aufloesung.
    // Sie setzen globalThis.__apiStub = { get, patch, ... }; ohne das bleibt es
    // bei der stummen Antwort wie bisher - dasselbe Muster wie __formatLocale
    // weiter unten. Jede Methode steht ausgeschrieben da und nicht als Fabrik:
    // test:frontend-audit liest diesen Stub als TEXT und prueft die Schreibweise
    // "patch: async" samt der auth-Namen. Und KEINE Backticks in diesem
    // Kommentar - der Stub IST ein Template-Literal, ein Backtick darin beendet
    // ihn mitten im Text.
    const viaStub = (name, args, fallback) => (
      typeof globalThis.__apiStub?.[name] === 'function'
        ? globalThis.__apiStub[name](...args)
        : fallback
    );
    export const api = {
      get: async (...a) => viaStub('get', a, { data: null }),
      // Liefert im Echtbetrieb { data, fromCache } - siehe api.js. Der Stub
      // faellt auf 'get' zurueck, damit Suiten, die die Cache-Herkunft gar
      // nicht pruefen, nichts davon wissen muessen.
      getWithSource: async (...a) => (
        typeof globalThis.__apiStub?.getWithSource === 'function'
          ? globalThis.__apiStub.getWithSource(...a)
          : { data: await viaStub('get', a, { data: null }), fromCache: false }
      ),
      post: async (...a) => viaStub('post', a, { data: null }),
      put: async (...a) => viaStub('put', a, { data: null }),
      patch: async (...a) => viaStub('patch', a, { data: null }),
      delete: async (...a) => viaStub('delete', a, { data: null }),
    };
    export const auth = {
      me: async () => ({ user: null }),
      getUsers: async () => ({ data: [] }),
      logout: async () => ({ ok: true }),
      updateProfile: async () => ({ user: null }),
    };
    export const notifications = {
      providers: async () => ({ data: [] }),
      listChannels: async () => ({ data: [] }),
      createChannel: async () => ({ data: null }),
      updateChannel: async () => ({ data: null }),
      deleteChannel: async () => ({ data: null }),
      testChannel: async () => ({ data: null }),
    };
    export const recipeProviders = {
      listAccounts: async () => ({ data: [] }),
      createAccount: async () => ({ data: null }),
      updateAccount: async () => ({ data: null }),
      deleteAccount: async () => ({ data: null }),
      testAccount: async () => ({ data: null }),
      syncAccount: async () => ({ data: null }),
      getStatus: async () => ({ data: [] }),
    };
  `,
  '/i18n.js': `
    export const t = (key, values = {}) => {
      if (!values || Object.keys(values).length === 0) return key;
      return key + JSON.stringify(values);
    };
    export const initI18n = async () => {};
    export const setLocale = async () => {};
    // Wie __formatLocale: Tests, die lokalisierte Monatsnamen pruefen, setzen
    // globalThis.__locale; ohne das bleibt es bei 'de'.
    export const getLocale = () => globalThis.__locale ?? 'de';
    // Die Format-Locale ist im Browser eine Einstellung des Haushalts und
    // entscheidet ueber Ziffernsystem, Dezimaltrenner und Gruppierung. Tests, die
    // genau das pruefen (utils/money.js und alles, was dessen Umschrift nutzt),
    // setzen globalThis.__formatLocale; ohne das bleibt es bei 'de' wie bisher.
    export const getFormatLocale = () => globalThis.__formatLocale ?? 'de';
    export const getNumberFormat = (options = {}) =>
      new Intl.NumberFormat(globalThis.__formatLocale ?? 'de', options);
    // Wert mit Einheit: das Wort aus der UI-Sprache (__locale), die Zahl aus der
    // Region (__formatLocale) - dieselbe Rechnung wie formatUnit() in
    // public/i18n.js. Ein Nachbau, weil das Original die Sprache aus seinem
    // eigenen Modulzustand liest und nicht aus __locale. Damit er nicht still
    // auseinanderlaeuft, fuehrt test:region-presets Original und Stub ueber
    // dieselben Sprach- und Regionspaare.
    export const formatUnit = (value, unit, options = {}) => {
      const { unitDisplay, ...digits } = options;
      const parts = new Intl.NumberFormat(globalThis.__locale ?? 'de', {
        ...digits, style: 'unit', unit, unitDisplay,
      }).formatToParts(value);
      const numeric = (part) => ['minusSign', 'plusSign', 'integer', 'group', 'decimal', 'fraction'].includes(part.type);
      let first = parts.findIndex(numeric);
      if (first === -1) return parts.map((part) => part.value).join('');
      const last = parts.findLastIndex(numeric);
      while (first > 0 && parts[first - 1].type === 'literal'
        && /^[\\u061c\\u200e\\u200f]+$/.test(parts[first - 1].value)) first--;
      return [
        ...parts.slice(0, first).map((part) => part.value),
        new Intl.NumberFormat(globalThis.__formatLocale ?? 'de', digits).format(value),
        ...parts.slice(last + 1).map((part) => part.value),
      ].join('');
    };
    export const getSupportedLocales = () => ['de', 'en'];
    export const formatDate = (d) => String(d);
    export const formatDayMonth = (d) => String(d);
    export const formatTime = (d) => String(d);
    export const getTimeFormat = () => '24h';
    export const timeSuffix = () => '';
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
    // Dieselbe Form wie das Original, das immer { refreshMonthdayHint }
    // zurueckgibt: der Kalender-Dialog haengt es an sein Startdatum, und ein
    // leerer Rueckgabewert liess jede Suite sterben, die wireEventForm FAEHRT.
    export const bindRRuleEvents = () => ({ refreshMonthdayHint: () => {} });
    // Das leere Objekt ist fuer jede Suite richtig, die nur das MARKUP prueft -
    // aber es hat kein 'valid_until', und jeder Formular-Handler, der die
    // Wiederholung mitliest, bricht damit sofort mit "invalidDate" ab. Suiten,
    // die einen Handler wirklich FAHREN, setzen globalThis.__rruleValues -
    // dasselbe Muster wie __apiStub in /api.js.
    export const getRRuleValues = () => globalThis.__rruleValues ?? ({});
    export const describeRRule = () => '';
    export const recurrenceRow = () => ({ icon: 'repeat', label: '', value: '' });
    export const intervalUnitLabel = () => '';
  `,
  '/components/modal.js': `
    export const openModal = (...args) => globalThis.__openModal?.(...args);
    // Suiten, die pruefen wollen, OB und WANN ein Handler schliesst (das
    // Formular bleibt nach einem Abbrechen offen), setzen globalThis.__closeModal.
    export const closeModal = (...args) => { globalThis.__closeModal?.(...args); };
    // Wer die Rueckfrage selbst sehen will (Titel, Optionen, Antwort), setzt
    // globalThis.__confirmModal - dasselbe Muster wie __apiStub in /api.js.
    export const confirmModal = async (...args) => (
      typeof globalThis.__confirmModal === 'function' ? globalThis.__confirmModal(...args) : true
    );
    export const confirmOverModal = async (...args) => globalThis.__confirmOverModal?.(...args) ?? true;
    // Wie das Original ohne offenes Modal: ask() oeffnet den Dialog (ueber
    // openModal, also __openModal) und liefert die Antwort. Wer sehen will,
    // DASS eine Frage ueber dem Formular gestellt wird statt es zu ersetzen,
    // setzt globalThis.__askOverModal und bekommt ask in die Hand.
    export const askOverModal = async (ask) => (
      typeof globalThis.__askOverModal === 'function' ? globalThis.__askOverModal(ask) : ask()
    );
    export const selectModal = async () => null;
    // Wer wissen will, OB ein Abschnitt aufgeklappt aufgeht, setzt
    // globalThis.__advancedSection und bekommt Inhalt UND Optionen - die
    // Entscheidung trifft der Aufrufer, und hier kaeme sie sonst nie an.
    export const advancedSection = (inner = '', options = {}) => (
      typeof globalThis.__advancedSection === 'function'
        ? globalThis.__advancedSection(inner, options)
        : String(inner)
    );
    export const wireBlurValidation = () => {};
    // Suiten, die pruefen wollen, WO ein Handler einen Fehler meldet (statt zu
    // speichern), setzen globalThis.__reportFieldError - dasselbe Muster wie
    // __apiStub in /api.js. Ohne das bleibt es beim stummen false.
    export const reportFieldError = (...args) => {
      globalThis.__reportFieldError?.(...args);
      return false;
    };
    export const mountFooter = () => null;
    export const refreshDirtySnapshot = () => {};
    export const captureModalContext = () => globalThis.__modalContextId?.() ?? 'test-modal-context';
    export const isModalContextCurrent = (context) => (
      globalThis.__modalContextId?.() === undefined
        ? true
        : globalThis.__modalContextId() === context
    );
    export const focusFirstField = () => null;
    export const updateHeaderAction = () => null;
    export const validateAll = () => true;
    export const promptModal = async (...args) => globalThis.__promptModal?.(...args) ?? null;
    // Gibt eine FUNKTION zurueck wie das Original - der Aufrufer haelt sie als
    // stop() fest und ruft sie im Fehlerpfad. Ein leeres Objekt hier liess jeden
    // Test sterben, der genau diesen Pfad faehrt, und zwar an einem TypeError
    // statt an der Sache, die er messen wollte. Den Knopfzustand baut der Stub
    // bewusst NICHT nach: wer ihn pruefen will, wuerde sonst den Stub messen.
    export const btnLoading = () => () => {};
    export const btnSuccess = () => {};
    export const btnError = () => {};
    export const refocusAfterRender = () => {};
    export const renderKeepingFocus = (render) => { render(); return null; };
    export const forgetRestore = () => {};
  `,
  '/components/detail-view.js': `
    // Tests, die pruefen wollen, WELCHE Bedienelemente ein Aufrufer anbietet -
    // die Statusknoepfe der Aufgaben-Leseansicht etwa -, setzen
    // globalThis.__openDetailView und bekommen die Optionen in die Hand,
    // dasselbe Muster wie __apiStub in /api.js. Ohne das bleibt es beim stummen
    // Rueckgabewert wie bisher. Ein Guard ueber den QUELLTEXT der Ansicht
    // taete es hier nicht: er sieht eine Aktionsliste, die gebaut wird, nicht
    // eine, die auch bei diesem Status herauskommt.
    export const openDetailView = (options) => {
      globalThis.__openDetailView?.(options);
      return { update: () => true, isOpen: () => true };
    };
    export const closeDetailView = () => {};
    export const detailRowEl = () => null;
    export const visibilityRow = () => ({ icon: 'users', label: '', value: '' });
    export const assignedRow = () => ({ icon: 'user', label: '', value: '' });
  `,
  '/utils/ux.js': `
    export const stagger = () => {};
    export const vibrate = () => {};
    export const wireScrollFade = () => ({ update: () => {}, destroy: () => {} });
    // Tests, die das Undo-Fenster selbst schliessen oder zuruecknehmen wollen,
    // setzen globalThis.__undoStub = (opts) => {} und bekommen commit/restore
    // in die Hand - dasselbe Muster wie __apiStub in /api.js.
    export const scheduleUndoableDelete = (opts) => { globalThis.__undoStub?.(opts); };
    // Im Test gibt es keine Animation, die ausspielen koennte - der Aufrufer
    // awaitet das Ergebnis, also loest der Stub sofort auf.
    export const animationSettled = () => Promise.resolve();
  `,
  '/utils/html.js': `
    export const esc = (value) => String(value ?? '')
      .replaceAll('&', '&amp;')
      .replaceAll('<', '&lt;')
      .replaceAll('>', '&gt;')
      .replaceAll('"', '&quot;')
      .replaceAll("'", '&#039;');
    export const fmtLocation = (value) => String(value ?? '');
    // Wie __renderUserMultiSelect weiter unten: Suiten, die pruefen wollen, WAS
    // ein Aufrufer dem Markdown-Renderer uebergibt (die Checklisten-Optionen
    // etwa), setzen globalThis.__renderMarkdownLight. Ohne das bleibt es beim
    // durchgereichten Text wie bisher - der Stub soll nicht die halbe
    // Markdown-Umschrift nachbauen.
    export const renderMarkdownLight = (value, options) => (
      typeof globalThis.__renderMarkdownLight === 'function'
        ? globalThis.__renderMarkdownLight(value, options)
        : String(value ?? '')
    );
  `,
  '/utils/sortable.js': `
    // Suiten, die pruefen wollen, WORAUF eine Seite das Ziehen ueberhaupt
    // einhaengt, setzen globalThis.__sortableCalls auf ein Array und bekommen
    // je Aufruf das Element und die Optionen - dasselbe Muster wie __apiStub in
    // /api.js. Der Riegel, den das misst, ist nicht im Markup zu sehen: eine
    // Ablegezone, die gar nicht erst verdrahtet wird, sieht im HTML aus wie
    // jede andere.
    export const isDragActive = () => false;
    export const makeSortable = async (listEl, opts) => {
      if (Array.isArray(globalThis.__sortableCalls)) {
        globalThis.__sortableCalls.push({ el: listEl, opts });
      }
      return { destroy() {} };
    };
  `,
  '/reminders.js': `
    export const refresh = async () => {};
  `,
  '/components/user-multi-select.js': `
    // Tests, die das Markup einer Personen-Auswahl pruefen, setzen
    // globalThis.__renderUserMultiSelect (etwa auf die echte Komponente).
    export const renderUserMultiSelect = (...args) => globalThis.__renderUserMultiSelect?.(...args) ?? '';
    // Suiten, die einen Formular-Handler mit gewaehlten Personen FAHREN, setzen
    // globalThis.__getSelectedUserIds; ohne das bleibt es bei niemandem.
    export const getSelectedUserIds = (...args) => globalThis.__getSelectedUserIds?.(...args) ?? [];
    export const bindUserMultiSelect = () => {};
    export const renderAvatarStack = () => '';
  `,
  '/utils/shopping-categories.js': `
    export const DEFAULT_CATEGORY_NAME = 'Sonstiges';
    export const categoryLabel = (category) => category?.name ?? String(category ?? '');
  `,
  '/utils/kitchen-tabs.js': `
    export const renderKitchenTabsBar = () => {};
    export const refreshKitchenBadges = () => {};
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
  // /utils/timezone.js steht ebenfalls nicht hier - localStorage ist dort in
  // try/catch gekapselt, in Node faellt der ReferenceError also auf 'keine Zone'
  // zurueck, und genau das ist das Verhalten ohne Einstellung.
  // /utils/date.js steht bewusst NICHT hier: die Datei hat keine DOM- oder
  // i18n-Abhängigkeit und wird vom Pfad-Fallback unten direkt geladen. Der
  // Nachbau, der hier stand, war schon auseinandergelaufen (er kannte den
  // Default-Parameter von toLocalDateKey() nicht) - ein Stub für ein Modul,
  // das im Node-Kontext ohnehin läuft, kann nur driften.
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
