// Die Browser-Untergrenze, als erstes Skript im <head> von index.html,
// offline.html und browser-too-old.html (Phase 1a, Abschnitt E; Entscheidung
// 11 des Umbaufahrplans).
//
// Das Buendel ist fuer Chrome 105, Firefox 115 und Safari/iOS 15.4 gebaut
// (vite.config.ts `build.target`). Darunter scheitert es beim Laden, und bis
// hierhin sah ein zu alter Browser nur eine leere Seite. Diese Probe fragt zwei
// APIs ab, die genau dort ankamen, und schickt einen Browser ohne sie auf eine
// statische Seite, die sagt, was fehlt und was hilft:
//   - CSSLayerBlockRule (Chrome 99, Firefox 97, Safari 15.4) - nur als
//     Versionsmerkmal: die App nutzt `@layer` nicht, die Schnittstelle kam
//     aber in allen drei Engines nahe der Untergrenze an;
//   - Object.hasOwn (Chrome 93, Firefox 92, Safari 15.4), ebenso.
// Bewusst eine Naeherung: Chrome 99-104 und Firefox 97-114 bestehen die Probe,
// obwohl sie unter build.target liegen - dort startet die App mit Luecken
// statt gar nicht (docs/installation.md, "Browser Support").
//
// ES5 OHNE AUSNAHME: die Datei laeuft auf genau dem Browser, der neuere Syntax
// nicht versteht. Kein `const`, kein `=>`, kein Template-Literal - ein
// Syntaxfehler hier liesse die Probe stumm (test:browser-floor-page).
// Eine eigene Datei statt eines Inline-Skripts: die CSP dieses Servers erlaubt
// nur `script-src 'self'`.
//
// ZWEI RICHTUNGEN, EIN PRAEDIKAT (#2651): auf der Hinweisseite (Schalter
// `data-browser-floor-notice` am <html>) laeuft dieselbe Frage andersherum -
// ein faehiger Browser, der die Seite direkt oeffnet oder nach einem Update
// neu laedt, geht von selbst zurueck auf `/`. Keine Schleife: ein zu alter
// Browser geht von `/` auf die Hinweisseite und bleibt dort, ein faehiger von
// der Hinweisseite auf `/` und bleibt dort (test:browser-floor-page). Der
// Schalter steht am <html> statt am Skript-Tag, weil `document.currentScript`
// gerade den aeltesten Browsern fehlt - ohne ihn liefe die Hinweisseite sonst
// in den Zweig der App und laede sich selbst neu.
(function () {
  var capable = typeof CSSLayerBlockRule !== 'undefined' && typeof Object.hasOwn === 'function';
  if (document.documentElement.hasAttribute('data-browser-floor-notice')) {
    if (capable) location.replace('/');
  } else if (!capable) {
    location.replace('/browser-too-old.html');
  }
})();
