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
      rawPost: async (...a) => viaStub('rawPost', a, { data: null }),
    };
    export const auth = {
      me: async () => ({ user: null }),
      getUsers: async () => ({ data: [] }),
      logout: async () => ({ ok: true }),
      updateProfile: async () => ({ user: null }),
    };
    export const email = {
      getConfig: async () => ({ data: null }),
      saveConfig: async () => ({ data: null }),
      test: async () => ({ data: null }),
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
      // Wer echte Saetze braucht (der Intervall-Satz waehlt seine Pluralform an
      // der Vorlage, R24 S4), setzt globalThis.__tDict auf flache Schluessel ->
      // Text; Platzhalter werden wie im Original eingesetzt, unbekannte bleiben.
      const dict = globalThis.__tDict;
      if (dict && Object.prototype.hasOwnProperty.call(dict, key)) {
        return String(dict[key]).replace(/\{\{(\w+)\}\}/g, (m, name) => (values && name in values ? String(values[name]) : m));
      }
      if (!values || Object.keys(values).length === 0) return key;
      return key + JSON.stringify(values);
    };
    export const initI18n = async () => {};
    export const whenI18nReady = async () => {};
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
    export const getSupportedLocales = () => globalThis.__supportedLocales ?? ['de', 'en'];
    export const formatDate = (d) => String(d);
    // Tag+Monat und volles Datum sehen im Stub gleich aus. Wer pruefen will,
    // WELCHES von beiden gerufen wurde (relativeDateLabel), setzt
    // globalThis.__formatDayMonth - dasselbe Muster wie __locale.
    export const formatDayMonth = (d) => (globalThis.__formatDayMonth ?? String)(d);
    // Monat und Jahr in der Reihenfolge der Sprache (__locale), gregorianisch.
    // Ein Nachbau wie formatUnit; test:region-presets fuehrt ihn gegen das
    // Original.
    export const formatMonthYear = (year, month) => {
      const y = Number(year);
      const m = Number(month);
      if (!Number.isInteger(y) || !Number.isInteger(m) || m < 1 || m > 12) return '';
      const locale = globalThis.__locale ?? 'de';
      const text = new Intl.DateTimeFormat(locale, {
        month: 'long', year: 'numeric', timeZone: 'UTC', calendar: 'gregory',
      }).format(new Date(Date.UTC(y, m - 1, 1)));
      const [first = ''] = text;
      return first.toLocaleUpperCase(locale) + text.slice(first.length);
    };
    // Wer pruefen will, DASS ein Wert durch den Formatierer geht und wie er
    // danach aussieht, setzt globalThis.__formatTime (etwa auf das Original
    // aus public/i18n.js) - dasselbe Muster wie __formatDayMonth.
    export const formatTime = (d) => (globalThis.__formatTime ?? String)(d);
    export const getTimeFormat = () => '24h';
    // Das Uhrzeit-Suffix der Locale („Uhr"): leer wie in den meisten Sprachen,
    // ausser ein Test setzt globalThis.__timeSuffix - dasselbe Muster wie
    // __locale. So laesst sich pruefen, WO es steht, nicht nur, dass nichts
    // steht.
    export const timeSuffix = () => globalThis.__timeSuffix ?? '';
    export const dateInputPlaceholder = () => 'YYYY-MM-DD';
    export const formatDateInput = (d) => String(d ?? '');
    export const parseDateInput = (d) => String(d ?? '');
    export const isDateInputValid = () => true;
    export const formatTimeInput = (d) => String(d ?? '');
    export const parseTimeInput = (d) => String(d ?? '');
    export const timeInputPlaceholder = () => 'HH:MM';
  `,
  '/rrule-ui.js': `
    // Suiten, die pruefen wollen, WO ein Dialog die Wiederholung hinstellt,
    // setzen globalThis.__renderRRuleFields - dasselbe Muster wie __apiStub.
    export const renderRRuleFields = (...args) => globalThis.__renderRRuleFields?.(...args) ?? '';
    // Dieselbe Form wie das Original, das immer { refreshMonthdayHint,
    // refreshStartDate } zurueckgibt: der Kalender-Dialog haengt es an sein
    // Startdatum, und ein leerer Rueckgabewert liess jede Suite sterben, die
    // wireEventForm FAEHRT.
    export const bindRRuleEvents = () => ({ refreshMonthdayHint: () => {}, refreshStartDate: () => {} });
    // Das leere Objekt ist fuer jede Suite richtig, die nur das MARKUP prueft -
    // aber es hat kein 'valid_until', und jeder Formular-Handler, der die
    // Wiederholung mitliest, bricht damit sofort mit "invalidDate" ab. Suiten,
    // die einen Handler wirklich FAHREN, setzen globalThis.__rruleValues -
    // dasselbe Muster wie __apiStub in /api.js.
    export const getRRuleValues = () => globalThis.__rruleValues ?? ({});
    export const describeRRule = () => '';
    // Wer die Verdrahtung der Detailzeile pruefen will, setzt globalThis.__recurrenceRow.
    export const recurrenceRow = (...args) => globalThis.__recurrenceRow?.(...args) ?? ({ icon: 'repeat', label: '', value: '' });
    export const intervalUnitLabel = () => '';
  `,
  '/components/modal.js': `
    // Dialogregel Erstfokus (Critique R24 S3): wie das Original, rein.
    export const dialogInitialFocus = (isEdit, required = 'first-field') => (isEdit ? 'edit' : required);
    export const openModal = (...args) => globalThis.__openModal?.(...args);
    // Die letzte Eingabe (Taste oder Zeiger); wer den Tastaturweg meint, setzt
    // globalThis.__lastInputKeyboard = true.
    export const lastInputWasKeyboard = () => globalThis.__lastInputKeyboard === true;
    // Suiten, die pruefen wollen, OB und WANN ein Handler schliesst (das
    // Formular bleibt nach einem Abbrechen offen), setzen globalThis.__closeModal.
    // Liefert, was der Haken liefert: das Original sagt mit false, dass das
    // Verwerfen abgelehnt wurde und der Dialog stehen bleibt.
    export const closeModal = async (...args) => globalThis.__closeModal?.(...args);
    // Wer die Rueckfrage selbst sehen will (Titel, Optionen, Antwort), setzt
    // globalThis.__confirmModal - dasselbe Muster wie __apiStub in /api.js.
    export const confirmModal = async (...args) => (
      typeof globalThis.__confirmModal === 'function' ? globalThis.__confirmModal(...args) : true
    );
    export const confirmOverModal = async (...args) => globalThis.__confirmOverModal?.(...args) ?? true;
    // Wer ein VERZOEGERTES Schliessen nachstellt (mobil: Animation bis 400 ms),
    // setzt globalThis.__whenModalClosed; ohne das ist das Modal sofort zu.
    export const whenModalClosed = async (...args) => globalThis.__whenModalClosed?.(...args);
    // Wie das Original ohne offenes Modal: ask() oeffnet den Dialog (ueber
    // openModal, also __openModal) und liefert die Antwort. Wer sehen will,
    // DASS eine Frage ueber dem Formular gestellt wird statt es zu ersetzen,
    // setzt globalThis.__askOverModal und bekommt ask in die Hand.
    export const askOverModal = async (ask) => (
      typeof globalThis.__askOverModal === 'function' ? globalThis.__askOverModal(ask) : ask()
    );
    // Ohne Stub bricht die Auswahl ab (null) - dann sendet KEIN Aufrufer etwas,
    // auch mit Schreibrecht nicht. Wer den Weg hinter der Auswahl messen will
    // (Ordner oder Dokumente verschieben), setzt globalThis.__selectModal und
    // bekommt Titel und Optionen - dasselbe Muster wie __promptModal.
    export const selectModal = async (...args) => (
      typeof globalThis.__selectModal === 'function' ? globalThis.__selectModal(...args) : null
    );
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
    // Das Gegenstueck: wer sehen will, dass ein Handler einen alten
    // Feldfehler raeumt, setzt globalThis.__clearFieldError.
    export const clearFieldError = (...args) => {
      globalThis.__clearFieldError?.(...args);
    };
    // Wie das Original (components/modal.js): alle Eintraege mit Feld, je Feld
    // der erste - ueber __reportFieldError gemeldet, in der Reihenfolge der
    // Liste (eine Dokumentreihenfolge kennt der Stub nicht).
    export const reportFieldErrors = (errors) => {
      const seen = new Set();
      let any = false;
      for (const entry of errors ?? []) {
        if (!Array.isArray(entry) || !entry[0] || seen.has(entry[0])) continue;
        seen.add(entry[0]);
        any = true;
        globalThis.__reportFieldError?.(entry[0], entry[1]);
      }
      return any;
    };
    // Die Regeln des Markups (components/modal.js, Critique R21): das Original
    // liest den ValidityState der Felder - die Attrappen-Panels der Suiten
    // haben keinen, also meldet der Stub nichts. Wer den Weg messen will,
    // setzt globalThis.__constraintErrors.
    export const constraintErrors = (...args) => (
      typeof globalThis.__constraintErrors === 'function' ? globalThis.__constraintErrors(...args) : []
    );
    export const mountFooter = () => null;
    export const decorateFooterDelete = () => [];
    // Wer sehen will, WOHIN ein Formular sich legt (R19, Bearbeiten in der
    // Detailspalte), setzt globalThis.__dockNextModal.
    export const dockNextModal = (...args) => globalThis.__dockNextModal?.(...args);
    export const refreshDirtySnapshot = () => {};
    // Der Tausch selbst muss laufen, genau einmal und synchron. Wer die
    // Dirty-Basis dahinter messen will, haengt die ECHTE Funktion aus
    // components/modal.js an globalThis.__swapFieldsKeepingDirtyBase.
    export const swapFieldsKeepingDirtyBase = (panel, swap) => (
      typeof globalThis.__swapFieldsKeepingDirtyBase === 'function'
        ? globalThis.__swapFieldsKeepingDirtyBase(panel, swap)
        : swap()
    );
    export const captureModalContext = () => globalThis.__modalContextId?.() ?? 'test-modal-context';
    // Wie das Original: ein Platz in der Reihe der Oeffnungswuensche, und nur
    // der neueste gilt (#1997, Codex an #2132). Der Kontext selbst bleibt der
    // von captureModalContext().
    let openIntent = 0;
    export const captureOpenContext = () => ({ openContext: captureModalContext(), intent: ++openIntent });
    export const isModalContextCurrent = (context) => {
      if (context && typeof context === 'object' && 'openContext' in context) {
        if (context.intent !== openIntent) return false;
        context = context.openContext;
      }
      return globalThis.__modalContextId?.() === undefined
        ? true
        : globalThis.__modalContextId() === context;
    };
    // Ob der festgehaltene Dialog noch offen ist (#1997). Ohne Sonde: ja - wer
    // die spaete Antwort messen will, setzt globalThis.__isOwnModalOpen.
    export const isOwnModalOpen = (context) => (
      typeof globalThis.__isOwnModalOpen === 'function' ? globalThis.__isOwnModalOpen(context) : true
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
    // Wer sehen will, OB eine Seite den Fokus nach dem Neuzeichnen
    // zuruecktraegt, setzt globalThis.__refocusAfterRender.
    export const refocusAfterRender = () => { globalThis.__refocusAfterRender?.(); };
    // Wer sehen will, OB ein Neuzeichnen den Fokus mitnimmt, setzt
    // globalThis.__renderKeepingFocus (bekommt den Neuaufbau mitgeliefert).
    export const renderKeepingFocus = (render) => { globalThis.__renderKeepingFocus?.(render); render(); return null; };
    export const forgetRestore = () => {};
    // Die Fokus-Merker der Detailansicht (Popover): ohne Browser nichts zu merken.
    export const rememberFocus = () => null;
    export const restoreFocusAfterClose = () => {};
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
    // R21 D7: Sprung aus der Leseansicht in ein anderes Modul - hier nur Merker.
    export const leaveDetailTo = (url) => { globalThis.__leftDetailTo = url; };
    // Dieselbe Regel wie im Original (R19): Bearbeiten als der eine
    // Primaerknopf am Ende, andere Primaerknoepfe treten zurueck.
    export const withPrimaryEdit = (actions = [], edit = null) => {
      const list = (actions ?? []).filter(Boolean);
      if (!edit) return list;
      return [...list.map((a) => (a.variant === 'primary' ? { ...a, variant: 'secondary' } : a)), { icon: 'pencil', ...edit, variant: 'primary' }];
    };
    // Der Fuss als schlichte Knopfreihe - genug fuer Tests, die nach einer
    // id oder einem Primaerknopf fragen.
    export const detailFooterEl = (actions = []) => {
      const visible = (actions ?? []).filter((a) => a && !a.hidden);
      if (!visible.length || typeof document === 'undefined') return null;
      const footer = document.createElement('div');
      footer.className = 'detail-view__footer';
      for (const action of visible) {
        const btn = document.createElement('button');
        btn.className = 'btn btn--' + (action.variant ?? 'secondary');
        if (action.id) btn.id = action.id;
        btn.textContent = action.label ?? '';
        if (typeof action.onClick === 'function') btn.addEventListener('click', () => action.onClick({ close: () => {}, button: btn }));
        footer.appendChild(btn);
      }
      return footer;
    };
    export const detailRowEl = () => null;
    export const visibilityRow = () => ({ icon: 'users', label: '', value: '' });
    export const assignedRow = () => ({ icon: 'user', label: '', value: '' });
  `,
  '/utils/ux.js': `
    export const stagger = () => {};
    // Suiten, die pruefen wollen, WANN eine Seite vibriert (im Moment des
    // Tipps, nicht nach der Serverantwort), setzen globalThis.__vibrateStub.
    export const vibrate = (pattern) => { globalThis.__vibrateStub?.(pattern); };
    export const wireScrollFade = () => ({ update: () => {}, destroy: () => {} });
    // Tests, die das Undo-Fenster selbst schliessen oder zuruecknehmen wollen,
    // setzen globalThis.__undoStub = (opts) => {} und bekommen commit/restore
    // in die Hand - dasselbe Muster wie __apiStub in /api.js.
    export const scheduleUndoableDelete = (opts) => { globalThis.__undoStub?.(opts); };
    // Die Quittung einer Statusaktion (R23, D6): dieselbe Form wie das Original,
    // damit ein Test am showToast-Stub Satz und Rueckgaengig in die Hand bekommt.
    // Seit R24 mit pending (Quittung im Tipp) und update (Satz nachtragen).
    export const offerUndo = ({ message, undo, onError, label, duration = 5000, pending = null, scope = null }) => {
      const run = async () => {
        if (pending) { try { await pending; } catch { return; } }
        try { await undo(); } catch (err) { onError?.(err); }
      };
      const handle = {};
      const shown = globalThis.window?.yuvomi?.showToast?.(message, 'default', duration, label ? { label, onClick: run } : run, { scope, handle }) === true;
      return { shown, update: (text) => { handle.setMessage?.(text); globalThis.__offerUndoUpdate?.(text); } };
    };
    // Im Test gibt es keine Animation, die ausspielen koennte - der Aufrufer
    // awaitet das Ergebnis, also loest der Stub sofort auf.
    export const acknowledgeCheck = () => Promise.resolve();
    // Austritt und Aufziehen (Abhaken, Gruppen) - ohne Layout gibt es nichts
    // zu bewegen, der Aufrufer wartet nur auf das Ende.
    export const collapseOut = () => Promise.resolve();
    // Wer sehen will, WELCHE Zeile einzieht, setzt globalThis.__expandIn.
    export const expandIn = (el) => { globalThis.__expandIn?.(el); return Promise.resolve(); };
    // Token-Leser ohne Stylesheet: der Rueckfall ist der Wert (utils/flip.js).
    // Region auf-/zuklappen: ohne Layout bleibt nur der Zustand selbst (hidden).
    // Wer sehen will, DASS geklappt wird, setzt globalThis.__motionStub (wie swapContent).
    export const toggleRegion = (region, open) => { globalThis.__motionStub?.('toggleRegion', region, open); if (region) region.hidden = !open; return Promise.resolve(); };
    // Ohne Layout kein Ladezustand am Knopf: nur die Arbeit selbst.
    export const withBusy = (_el, work) => work();
    // Balken wachsen lassen: ohne Layout nichts zu tun, der Endwert steht im Markup.
    export const growBars = () => 0;
    export const drawChartOnce = () => 0;
    export const durationToken = (name, fallback) => fallback;
    export const easingToken = (name, fallback = 'ease-out') => fallback;
    // Den Kopf mit der Flaeche falten (Telefon-Monat): ohne Shell-Kopf nichts zu tun.
    // Wer pruefen will, OB die Seite fragt, setzt globalThis.__headCollapse.
    export const requestHeadCollapse = (toolbar, collapsed) => { globalThis.__headCollapse?.(toolbar, collapsed); };
    // Reine Pruefung ohne DOM - der Stub rechnet wie das Original.
    export const isImeComposing = (event) => Boolean(event?.isComposing || event?.keyCode === 229);
    // Zeichen in Sicht-Reihenfolge (R22): wer sehen will, WIE eine Seite
    // zeichnen laesst, setzt globalThis.__iconStub; das Original haelt test:ux-utils.
    export const drawIconsInSightOrder = (listEl, opts) => { globalThis.__iconStub?.(listEl, opts); };
  `,
  // Inhaltswechsel und Listenbewegung (R16): ohne Layout gibt es nichts zu
  // bewegen - der Tausch selbst muss trotzdem laufen, genau einmal und
  // synchron. Die Originale importieren ux.js RELATIV und bekaemen hier das
  // echte statt des Stubs darueber; test:motion faehrt sie ungestubbt.
  // Suiten, die pruefen wollen, OB und WIE eine Seite den Uebergang anfragt,
  // setzen globalThis.__motionStub = (name, ...args) => {}.
  '/utils/content-swap.js': `
    export const SWAP_SHIFT_PX = 8;
    export const SWAP_FROM_OPACITY = 0.4;
    export function swapContent(host, update, opts = {}) {
      globalThis.__motionStub?.('swapContent', host, opts);
      if (typeof update === 'function') update();
      return null;
    }
    export const REGION_NAME = 'region-swap';
    export function canSwapRegion() { return false; }
    export function regionSwapType(d) { return d > 0 ? 'region-forward' : d < 0 ? 'region-back' : 'region-fade'; }
    export async function swapRegion(host, update, opts = {}) {
      globalThis.__motionStub?.('swapRegion', host, opts);
      if (typeof update === 'function') await update();
      return { transition: false, finished: Promise.resolve() };
    }
  `,
  '/utils/list-motion.js': `
    export function redrawList(host, render, opts = {}) {
      globalThis.__motionStub?.('redrawList', host, opts);
      render();
      return { first: false, entered: 0, moved: 0 };
    }
    export function collapseRow(row, opts = {}) {
      globalThis.__motionStub?.('collapseRow', row, opts);
      return Promise.resolve();
    }
  `,
  '/utils/html.js': `
    export const esc = (value) => String(value ?? '')
      .replaceAll('&', '&amp;')
      .replaceAll('<', '&lt;')
      .replaceAll('>', '&gt;')
      .replaceAll('"', '&quot;')
      .replaceAll("'", '&#039;');
    export const fmtLocation = (value) => String(value ?? '');
    // Der Pflichtstern (R16): dieselbe Zeichenkette wie in public/utils/html.js;
    // test-frontend-audit.js haelt das Original fest.
    export const REQUIRED_MARK = '<span class="required-marker" aria-hidden="true"> *</span>';
    // Rechnet wie das Original (test:detail-view prueft es dort).
    export const externalHref = (value) => {
      const url = String(value ?? '').trim();
      // Doppelte Backslashes: der Stub ist ein Template-Literal.
      return /^https?:\\/\\/\\S/i.test(url) ? url : '';
    };
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
    // Der Merker der Dialog-Instanzen (#2152): reicht an makeSortable unten
    // durch, damit __sortableCalls auch diese Aufrufe sieht. Sein eigenes
    // Verhalten misst test:manager-endzone am echten Modul.
    export const sortableSet = () => ({
      add: (listEl, opts) => makeSortable(listEl, opts),
      clear() {},
      size: () => 0,
    });
    // Wie das Original: gespeicherte Folge nach einem gescheiterten Zug.
    // test:manager-endzone misst das Original UND den Weg der Seiten hierher.
    export const restoreOrder = (listEl, ids, idOf) => {
      if (!listEl) return;
      const rows = new Map([...listEl.children].map((row) => [String(idOf(row)), row]));
      for (const id of ids) {
        const row = rows.get(String(id));
        if (row) listEl.appendChild(row);
      }
    };
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
    // Wie die beiden Haken darueber: Suiten, die das Avatar-Markup pruefen oder
    // die Auswahl-Logik fahren (der Koch einer Mahlzeit, #1679), setzen
    // globalThis.__renderAvatarStack bzw. globalThis.__bindUserMultiSelect auf
    // die echte Komponente. Ohne das bleibt es beim leeren Markup wie bisher.
    export const bindUserMultiSelect = (...args) => globalThis.__bindUserMultiSelect?.(...args);
    export const renderAvatarStack = (...args) => globalThis.__renderAvatarStack?.(...args) ?? '';
    // Der geteilte Nachname (Chips ohne "Johnson"): Suiten, die ihn pruefen,
    // setzen globalThis.__sharedSurname auf die echte Funktion; sonst keiner.
    export const sharedSurname = (...args) => globalThis.__sharedSurname?.(...args) ?? '';
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
