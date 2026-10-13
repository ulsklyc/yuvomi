// Einmalige, idempotente Migration aller Legacy-„oikos"-Storage-Keys → „yuvomi".
// Läuft als ALLERERSTES (im <head>, vor jeder Seite/Komponente), damit
// migrierte Werte (Theme, Locale, Ansichten …) ohne Flackern verfügbar sind.
// Benennt jeden Key, der mit `oikos-`, `oikos:` oder `oikos.` beginnt, auf das
// gleiche Suffix mit `yuvomi`-Präfix um (z. B. `oikos-theme` → `yuvomi-theme`).
(function migrateLegacyStorage() {
  // Kein gemeinsames Flag: sessionStorage ist pro Tab. Würde ein localStorage-Flag
  // die Migration kurzschließen, verlöre ein zweiter, vor dem Update geöffneter Tab
  // seine eigenen sessionStorage-Keys. Der Scan ist idempotent und günstig (wenige
  // Keys), daher laufen wir ihn bei jedem Load über BEIDE Stores.
  try {
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

  // DIE STATUSBAR GEHOERT ZUR THEME-ENTSCHEIDUNG, ALSO HIERHER.
  //
  // Beide `<meta name="theme-color">` tragen ein `media="(prefers-color-scheme:
  // …)"`: welche gilt, entscheidet das SYSTEM - waehrend die Zeilen darueber es
  // gerade ueber `data-theme` entschieden haben. Wer auf einem hellen Geraet
  // ausdruecklich Dunkel waehlt, bekam eine helle Statusbar ueber einer dunklen
  // Seite. Bei ausdruecklicher Wahl tragen deshalb beide Metas die AKTIVE
  // Farbe; dann ist gleichgueltig, welche der Browser nimmt. Im
  // Automatik-Modus bleibt das Paar ein Paar - dort ist das System die richtige
  // Quelle.
  //
  // HIER UND NICHT NUR IM ROUTER: dieses Skript laeuft in index.html UND in
  // offline.html, und die Offline-Huelle hat keinen Router, der es nachholen
  // koennte. Der Router korrigiert weiter beim Theme- und Routenwechsel; das
  // ist die Bewegung, das hier der Anfangszustand.
  //
  // Die Werte kommen aus den Metas selbst, nicht als Literale: eine vierte
  // Kopie von #F5F3ED/#191816 waere eine vierte Stelle, an der die Farbe der
  // Seite und die ihrer Statusbar auseinanderlaufen koennen.
  try {
    var metas = document.querySelectorAll('meta[name="theme-color"]');
    if (metas.length >= 2 && (stored === 'dark' || stored === 'light')) {
      var active = metas[stored === 'dark' ? 1 : 0].getAttribute('content');
      metas[0].setAttribute('content', active);
      metas[1].setAttribute('content', active);
    }
  } catch (e) { /* ohne Metas bleibt es beim Systemverhalten */ }
})();

// DER WAND-MODUS GEHOERT ZUM ERSTZUSTAND, ALSO HIERHER.
//
// Er blendet Sidebar und Tab-Leiste aus und uebernimmt die ganze Flaeche. Ohne
// diesen Block laedt ein Wandtablet sichtbar erst das normale Dashboard und
// klappt die Navigation dann weg - genau das Flackern, gegen das der Theme-Block
// darueber existiert, nur eine Etage groesser. Der Router haelt es danach beim
// Routenwechsel nach (utils/wall-mode.js, syncWallMode), das hier ist der
// Anfangszustand.
//
// Die Werte stehen als Literale da und nicht als Import: dieses Skript laeuft
// als klassisches <script> im <head>, vor jedem Modul. Die eine Quelle bleibt
// `utils/wall-mode.js`; dass die beiden nicht auseinanderlaufen, haelt ein Guard
// in test-frontend-audit.js.
(function () {
  try {
    if (localStorage.getItem('yuvomi-wall-mode') !== '1') return;
    if (location.pathname !== '/') return;
    document.documentElement.setAttribute('data-wall-mode', '');
    var hour = new Date().getHours();
    if (hour >= 22 || hour < 6) {
      document.documentElement.setAttribute('data-wall-night', '');
      // Nachts erzwungen dunkel - ohne `yuvomi-theme` anzufassen.
      document.documentElement.setAttribute('data-theme', 'dark');
    }
  } catch (e) { /* Storage nicht verfuegbar → kein Wand-Modus in dieser Sitzung */ }
})();

// THE SCREENSAVER DELAY BELONGS TO THE INITIAL STATE TOO (#885).
//
// components/photo-screensaver.js arms its idle timer as soon as somebody is
// signed in (#1919), from `data-screensaver-idle`. On a page that loads into a
// running session that is the first answer of /auth/me. Set here, before any
// module, so the first idle period already uses the delay chosen on this device. Only a step from
// utils/screensaver-idle.js is applied; anything else leaves the attribute off
// and the component keeps its five-minute default. The key and the steps are
// literals because this classic script cannot import - a guard in
// test-frontend-audit.js keeps them in step with the module.
(function () {
  try {
    var idle = localStorage.getItem('yuvomi-screensaver-idle');
    if ([60, 120, 300, 600, 900].indexOf(Number(idle)) === -1) return;
    document.documentElement.setAttribute('data-screensaver-idle', String(Number(idle)));
  } catch (e) { /* Storage nicht verfuegbar → Standardwert */ }
})();
