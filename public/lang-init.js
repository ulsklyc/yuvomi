// Setzt document.documentElement.lang auf die aufgelöste Nutzer-Locale, BEVOR
// der Body geparst/gerendert wird (render-blockierend im <head>, wie theme-init.js).
//
// Warum: index.html liefert statisch lang="de" aus. Chromium-Browser (z. B. Brave)
// werten dieses Attribut beim initialen Parse aus und bieten auf nicht-deutschen
// Systemen sofort an, „aus dem Deutschen zu übersetzen" — obwohl die App bereits in
// der Nutzersprache lokalisiert ist. i18n.js korrigiert lang erst nach dem Modul-Load
// (zu spät: die Übersetzungs-Heuristik hat da bereits entschieden). Dieses synchrone
// Bootstrap setzt das Attribut rechtzeitig auf die echte Locale, sodass deklarierte
// Sprache und gerenderter Inhalt übereinstimmen.
//
// Resolve-Logik gespiegelt aus i18n.js (resolveLocale): bei Änderung dort mitziehen.
(function() {
  var SUPPORTED = ['de', 'en', 'es', 'fr', 'it', 'sv', 'el', 'ru', 'tr', 'zh', 'ja', 'ar', 'hi', 'pt', 'uk', 'pl', 'nl', 'cs', 'vi'];
  var STORAGE_KEY = 'oikos-locale';

  function resolve() {
    try {
      var stored = localStorage.getItem(STORAGE_KEY);
      if (stored && SUPPORTED.indexOf(stored) !== -1) return stored;
    } catch (e) { /* localStorage kann blockiert sein (Privatmodus) */ }

    var browserLocales = navigator.languages || [navigator.language || ''];
    for (var i = 0; i < browserLocales.length; i++) {
      var base = String(browserLocales[i]).split('-')[0].toLowerCase();
      if (SUPPORTED.indexOf(base) !== -1) return base;
    }
    return 'en';
  }

  var locale = resolve();
  document.documentElement.lang = locale;
  document.documentElement.dir = locale === 'ar' ? 'rtl' : 'ltr';
})();
