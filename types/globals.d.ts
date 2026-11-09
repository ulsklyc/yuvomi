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
