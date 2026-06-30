// Einmalige, idempotente Migration aller Legacy-„oikos"-Storage-Keys → „yuvomi".
// Läuft als ALLERERSTES (im <head>, vor jeder Seite/Komponente), damit
// migrierte Werte (Theme, Locale, Ansichten …) ohne Flackern verfügbar sind.
// Benennt jeden Key, der mit `oikos-`, `oikos:` oder `oikos.` beginnt, auf das
// gleiche Suffix mit `yuvomi`-Präfix um (z. B. `oikos-theme` → `yuvomi-theme`).
(function migrateLegacyStorage() {
  try {
    var FLAG = 'yuvomi:migratedFrom:oikos';
    if (localStorage.getItem(FLAG) === '1') return;
    var stores = [localStorage, sessionStorage];
    for (var s = 0; s < stores.length; s++) {
      var store = stores[s];
      var keys = [];
      for (var i = 0; i < store.length; i++) {
        var k = store.key(i);
        if (k && /^oikos[-:.]/.test(k)) keys.push(k);
      }
      for (var j = 0; j < keys.length; j++) {
        var oldKey = keys[j];
        var newKey = 'yuvomi' + oldKey.slice('oikos'.length);
        if (store.getItem(newKey) === null) {
          store.setItem(newKey, store.getItem(oldKey));
        }
        store.removeItem(oldKey);
      }
    }
    localStorage.setItem(FLAG, '1');
  } catch (e) { /* Storage nicht verfügbar (Privatmodus) → ignorieren */ }
})();

(function() {
  var stored = localStorage.getItem('yuvomi-theme');
  if (stored === 'dark') {
    document.documentElement.setAttribute('data-theme', 'dark');
  } else if (stored === 'light') {
    document.documentElement.setAttribute('data-theme', 'light');
  } else {
    document.documentElement.removeAttribute('data-theme');
  }
})();
