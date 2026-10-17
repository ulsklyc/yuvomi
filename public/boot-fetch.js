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
// Nur, was ohnehin gleich gefragt wird: Sitzung, Version, Einstellungen und
// Module auf jeder angemeldeten Seite, Erinnerungen, Uebersicht und Wetter nur
// auf "/". Die Abfrage der Uebersicht ist die, die sie selbst vorhersagt (der
// Layout-Hinweis aus utils/dashboard-layout-hint.js); weicht sie ab, bleibt die
// Antwort liegen und verfaellt. Ohne Sitzung antworten sie 401 und verfallen
// ebenso - die Sitzungspruefung des Routers bekommt ihre 401 wie bisher.
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
  if (path === '/') {
    ask('/reminders/pending');
    var query = '/dashboard';
    try {
      var hint = JSON.parse(localStorage.getItem('yuvomi-dash-layout-hint') || 'null');
      if (hint && typeof hint === 'object' && !Array.isArray(hint) && typeof hint.query === 'string'
        && hint.query.indexOf('/dashboard') === 0) query = hint.query;
    } catch (e) { /* gesperrter Speicher: die Standardabfrage */ }
    ask(query);
    ask('/weather?lang=' + encodeURIComponent(document.documentElement.lang || 'de'));
  }

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
