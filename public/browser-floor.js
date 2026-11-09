// Die Browser-Untergrenze, als erstes Skript im <head> von index.html und
// offline.html (Phase 1a, Abschnitt E; Entscheidung 11 des Umbaufahrplans).
//
// Das Buendel ist fuer Chrome 105, Firefox 115 und Safari/iOS 15.4 gebaut
// (vite.config.ts `build.target`). Darunter scheitert es beim Laden, und bis
// hierhin sah ein zu alter Browser nur eine leere Seite. Diese Probe fragt zwei
// APIs ab, die genau dort ankamen, und schickt einen Browser ohne sie auf eine
// statische Seite, die sagt, was fehlt und was hilft:
//   - CSSLayerBlockRule (Chrome 99, Firefox 97, Safari 15.4), die Kaskaden-
//     Ebenen, auf die das Stylesheet der App baut;
//   - Object.hasOwn (Chrome 93, Firefox 92, Safari 15.4).
// Bewusst eine Naeherung: Chrome 99-104 und Firefox 97-114 bestehen die Probe,
// obwohl sie unter build.target liegen - dort startet die App mit Luecken
// statt gar nicht (docs/installation.md, "Browser Support").
//
// ES5 OHNE AUSNAHME: die Datei laeuft auf genau dem Browser, der neuere Syntax
// nicht versteht. Kein `const`, kein `=>`, kein Template-Literal - ein
// Syntaxfehler hier liesse die Probe stumm (test:browser-floor-page).
// Eine eigene Datei statt eines Inline-Skripts: die CSP dieses Servers erlaubt
// nur `script-src 'self'`.
(function () {
  if (typeof CSSLayerBlockRule === 'undefined' || typeof Object.hasOwn !== 'function') {
    location.replace('/browser-too-old.html');
  }
})();
