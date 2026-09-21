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
// Resolve-Logik gespiegelt aus i18n.js (pickLocale/resolveLocale): bei Änderung
// dort mitziehen. Ein Import ginge nicht - das hier läuft vor jedem Modul -, und
// deshalb hält test:lang-init beide Fassungen und beide Sprachlisten aneinander:
// `fil` kam am 04.08.2026 dazu und fehlte hier bis zum 21.09.2026 (#1324), also
// bekam ein philippinisches System lang="en" auf einen Body auf Filipino.
(function() {
  var SUPPORTED = ['de', 'en', 'es', 'fr', 'it', 'sv', 'el', 'ru', 'tr', 'zh', 'ja', 'ar', 'hi', 'pt', 'uk', 'pl', 'nl', 'cs', 'vi', 'hu', 'ko', 'id', 'fa', 'fil'];
  var STORAGE_KEY = 'yuvomi-locale';
  // Regionen, die eine Schrift implizieren: ein Browser meldet `zh-TW`, nie
  // `zh-Hant-TW`. `CN` und `SG` fehlen bewusst - unser `zh` ist Vereinfacht.
  var REGION_SCRIPT = { TW: 'Hant', HK: 'Hant', MO: 'Hant' };

  /** Kanonische BCP-47-Schreibweise: Sprache klein, Schrift Titlecase, Region groß. */
  function canonicalTag(tag) {
    var teile = String(tag).split('-');
    for (var i = 0; i < teile.length; i++) {
      if (i === 0) teile[i] = teile[i].toLowerCase();
      else if (teile[i].length === 4) teile[i] = teile[i].charAt(0).toUpperCase() + teile[i].slice(1).toLowerCase();
      else if (teile[i].length === 2) teile[i] = teile[i].toUpperCase();
      else teile[i] = teile[i].toLowerCase();
    }
    return teile.join('-');
  }

  /** Die spezifischste unterstützte Locale: `zh-Hant-TW` > `zh-Hant` > `zh`. */
  function pickLocale(tags) {
    for (var i = 0; i < tags.length; i++) {
      if (!tags[i]) continue;
      var teile = canonicalTag(tags[i]).split('-');
      while (teile.length) {
        var tag = teile.join('-');
        if (SUPPORTED.indexOf(tag) !== -1) return tag;
        var letzter = teile[teile.length - 1];
        var schrift = Object.prototype.hasOwnProperty.call(REGION_SCRIPT, letzter) ? REGION_SCRIPT[letzter] : null;
        if (schrift && SUPPORTED.indexOf(teile[0] + '-' + schrift) !== -1) return teile[0] + '-' + schrift;
        teile.pop();
      }
    }
    return 'en';
  }

  function resolve() {
    try {
      var stored = localStorage.getItem(STORAGE_KEY);
      if (stored && SUPPORTED.indexOf(stored) !== -1) return stored;
    } catch (e) { /* localStorage kann blockiert sein (Privatmodus) */ }

    return pickLocale(navigator.languages || [navigator.language || '']);
  }

  var locale = resolve();
  document.documentElement.lang = locale;
  document.documentElement.dir = (locale === 'ar' || locale === 'fa') ? 'rtl' : 'ltr';
})();
