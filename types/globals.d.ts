// Globale Typen der Browser-Seite, die kein Import liefert. Gepflegt von Hand,
// weil die Quelle Objektliterale in public/router.js und public/night-hours.js sind.

type YuvomiFn = (...args: any[]) => any;

interface YuvomiApi {
  navigate: YuvomiFn;
  openSearch: YuvomiFn;
  showToast: YuvomiFn;
  feedbackScope: YuvomiFn;
  setThemeColor: YuvomiFn;
  setDisabledModules: YuvomiFn;
  setHiddenModules: YuvomiFn;
  setModuleOrder: YuvomiFn;
  moduleOrder: YuvomiFn;
  setMobileNavOrder: YuvomiFn;
  refreshThirdPartyModules: YuvomiFn;
  isModuleDisabled: YuvomiFn;
  invalidateModuleCounts: YuvomiFn;
  primeModuleCountsFrom: YuvomiFn;
  takeStartPreferences: YuvomiFn;
  replacePageFab: YuvomiFn;
  applyTheme: YuvomiFn;
  restoreThemeColor: YuvomiFn;
  clearSession: YuvomiFn;
}

interface Window {
  /** Definition: public/router.js, Abschnitt "Globale Exporte". */
  yuvomi: YuvomiApi;
  /** Legacy-Alias fuer Drittanbieter-Module (public/router.js). */
  oikos: YuvomiApi;
  lucide?: any;
  /** Nur im Service Worker: vom Build vorangestellt (scripts/build/service-worker.ts). */
  __PRECACHE__?: string[];
  /** Nur im Service Worker: vom Build vorangestellt (scripts/build/service-worker.ts). */
  __LOCALES__?: string[];
}

/** Definition: public/night-hours.js (klassisches Skript, legt das Objekt auf globalThis). */
declare var yuvomiNightHours: {
  KEY: string;
  ZONE_KEY: string;
  DEFAULT_FROM: number;
  DEFAULT_TO: number;
  parse: YuvomiFn;
  serialize: YuvomiFn;
  read: YuvomiFn;
  readZone: YuvomiFn;
  hourIn: YuvomiFn;
  isNight: YuvomiFn;
};

/**
 * Vite (Phase 1a, Abschnitt D): `import.meta.glob` in public/router.js und
 * `import.meta.env` in public/sw-register.js. Nur die zwei Stellen, die der
 * Code nutzt, statt `vite/client` mit allen Asset-Modulen.
 */
interface ImportMeta {
  glob(pattern: string): Record<string, () => Promise<any>>;
  readonly env?: { readonly DEV: boolean };
}
