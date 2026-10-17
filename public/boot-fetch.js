// Fragt die Daten des Starts an, BEVOR die Module geladen sind (R20,
// Re-Critique 2026-10-17 a6 P2 "Kaltstart").
//
// Warum: am gedrosselten Telefon (4x CPU, Fast 4G, ohne Service Worker) liefen
// die ersten API-Abrufe erst nach dem letzten Modul los (DOMContentLoaded,
// ~3,3 s), und dann hintereinander: /auth/me -> /preferences + /modules ->
// /reminders/pending -> /dashboard. Dieses klassische Skript im <head> stellt
// genau diese Fragen sofort, parallel zum Laden der Module. api.js holt die
// Antwort beim ersten passenden GET ab (takeBootResponse) - einmal, fuer
// dieselbe Adresse, binnen BOOT_TTL_MS; danach fragt alles wie bisher selbst.
//
// Nur, was jede angemeldete Seite gleich fragt: Sitzung, Version,
// Einstellungen und Module. Ohne Sitzung antworten sie 401 und verfallen - die
// Sitzungspruefung des Routers fragt dann selbst und bekommt ihre 401 wie
// bisher. BEWUSST NICHT die Uebersicht, ihre Erinnerungen und das Wetter:
// vorab gefragt gewannen sie gemessen nochmals 0,1 s (Start vom Homescreen
// 0,80 -> 0,69 s), aber die Uebersicht zeichnete dann mitten im Laden der
// Module, und Lighthouse (simuliert) fiel auf "/" von 75 auf 68-72 (Speed
// Index 2,2 -> 3,6 s, TBT 30 -> 130 ms).
//
// Ein Import ginge nicht (das hier laeuft vor jedem Modul), ein Inline-Skript
// scheitert an der CSP (`script-src 'self'`). Keine API juenger als die des
// Startpfads (Chrome 87, Firefox 79, Safari 14.1).
(function () {
  if (typeof window.fetch !== 'function') return;
  // Die oeffentlichen Seiten fragen anders (oder gar nicht) - dort nichts vorab.
  var path = location.pathname;
  if (/^\/(login|setup|join|pair|reset-password|forgot-password|offline)(\/|$)/.test(path)) return;

  var BOOT_TTL_MS = 20000;
  var started = Date.now();
  var pending = {};
  var ask = function (apiPath) {
    var url = '/api/v1' + apiPath;
    pending[url] = fetch(url, {
      credentials: 'same-origin',
      cache: 'no-store',
      headers: { 'Content-Type': 'application/json' },
    });
    // Eine abgelehnte Vorab-Frage ist kein Fehler der Seite: api.js fragt dann selbst.
    pending[url].catch(function () {});
  };

  ask('/version');
  ask('/auth/me');
  ask('/preferences');
  ask('/modules');

  /**
   * Die Antwort einer Vorab-Frage - einmal je Adresse, nur binnen BOOT_TTL_MS.
   * `null` verwirft alle (eine schreibende Anfrage, etwa das Anmelden).
   * @param {string|null} url  voller Pfad samt /api/v1
   * @returns {Promise<Response>|null}
   */
  window.__yuvomiTakeBoot = function (url) {
    if (url === null || Date.now() - started > BOOT_TTL_MS) { pending = {}; return null; }
    var response = Object.prototype.hasOwnProperty.call(pending, url) ? pending[url] : null;
    if (response) delete pending[url];
    return response;
  };
})();
