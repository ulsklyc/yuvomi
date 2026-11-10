// Der <title> der statischen Seiten in ihrer Sprache (browser-too-old.html,
// offline.html). Beide tragen ihre Texte fest auf Deutsch und Englisch, je in
// einem Block `<div class="copy" lang="xx" data-title="...">`; welcher Block
// sichtbar ist, entscheidet das Stylesheet der Seite an `<html lang>`, das
// lang-init.js setzt. Ein <title> nimmt an keiner Kaskade teil - deshalb dieses
// Skript, am Ende des <body>: Deutsch fuer `de` und `de-*`, sonst Englisch, wie
// das Stylesheet.
//
// Die Ausnahme von "UI-Text nur ueber t()" gilt fuer genau diese zwei Seiten:
// dort laeuft kein Modul (die eine ist fuer Browser unter der Untergrenze, die
// andere die Huelle des Service Workers ohne Netz). test:browser-floor-page
// bindet jeden Text an seinen Schluessel in de.json und en.json.
//
// ES5 ohne Ausnahme, aus demselben Grund wie browser-floor.js.
(function () {
  var lang = String(document.documentElement.lang || '');
  var want = /^de(?:-|$)/i.test(lang) ? 'de' : 'en';
  var blocks = document.querySelectorAll('.copy[data-title]');
  for (var i = 0; i < blocks.length; i++) {
    if (blocks[i].getAttribute('lang') === want) {
      document.title = blocks[i].getAttribute('data-title') || document.title;
      return;
    }
  }
})();
