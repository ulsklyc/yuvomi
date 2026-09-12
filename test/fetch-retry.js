/**
 * Modul: Test-Infrastruktur - `fetch` gegen einen Testserver, der die
 *        Portknappheit des HOSTS uebersteht.
 *
 * Warum es diese Datei gibt (gemessen am 09.09.2026):
 * `test-push.js` galt als "unter Parallellast flaky". Der Fehler war nie im
 * Test: laufen daneben genug Prozesse, die Loopback-Verbindungen aufbauen,
 * findet `fetch` keinen freien ephemeren Port mehr und wirft
 * `TypeError: fetch failed` mit `EADDRNOTAVAIL` - der Request erreicht den
 * Handler nie. Im Log sieht das aus wie ein fachlicher Fehlschlag, es fehlt
 * nur die Logzeile, die der Handler sonst schreibt.
 *
 * Reproduziert mit vier Lastgebern a 400 gleichzeitigen Loopback-Verbindungen:
 * 50 von 60 Laeufen rot. Mit CPU-Last allein (sechs Brenner) 0 von 220 - der
 * Engpass ist der Socket-Vorrat, nicht der Scheduler. Genau deshalb blieb die
 * Ursache lange unentdeckt.
 *
 * Wiederholt wird NUR bei Ressourcenfehlern des CLIENTS, und zwar nach einer
 * Allowlist ([[reference-allowlist-over-denylist]]): eine Denylist wuerde zu
 * jedem unbekannten Code "ja, nochmal" sagen und damit echte Fehlschlaege
 * verstecken. Insbesondere `ECONNREFUSED` steht bewusst NICHT darin - das ist
 * die Antwort auf einen Server, den es nicht (mehr) gibt, also genau der
 * Fehler, den ein Test finden soll. HTTP-Antworten werden nie wiederholt: ein
 * 500er ist ein Ergebnis, kein Verbindungsproblem.
 */

/**
 * Fehlercodes, die "der Host hat gerade keine Ressource frei" bedeuten - und
 * nichts ueber den Server aussagen.
 */
const TRANSIENT = new Set([
  'EADDRNOTAVAIL', // kein freier ephemerer Port (der gemessene Fall)
  'EADDRINUSE',    // Portvergabe kollidiert unter Last
  'EMFILE',        // Dateideskriptoren des Prozesses erschoepft
  'ENFILE',        // dieselbe Grenze systemweit
  'ENOBUFS',       // Kernel-Puffer voll
  'EAGAIN',        // Ressource momentan nicht verfuegbar
  'ECONNRESET',    // Accept-Backlog uebergelaufen, RST statt Antwort
  'ETIMEDOUT',
]);

function istVoruebergehend(err) {
  // `fetch` verpackt den Netzwerkfehler in `cause`; verschachtelte Aggregate
  // (Happy Eyeballs) tragen ihn eine Ebene tiefer.
  const codes = [err?.code, err?.cause?.code, ...(err?.cause?.errors || []).map((e) => e?.code)];
  return codes.some((code) => code && TRANSIENT.has(code));
}

/**
 * Wie `fetch`, aber uebersteht die Portknappheit des Hosts.
 *
 * @param {string|URL} url
 * @param {RequestInit} [options]
 * @param {{ versuche?: number }} [config] Gesamtzahl der Versuche (Standard 4).
 * @returns {Promise<Response>}
 */
export async function fetchRetry(url, options, { versuche = 4 } = {}) {
  let letzter;
  for (let versuch = 1; versuch <= versuche; versuch++) {
    try {
      return await fetch(url, options);
    } catch (err) {
      if (!istVoruebergehend(err) || versuch === versuche) throw err;
      letzter = err;
      // Wachsende Pause: der Portvorrat fuellt sich erst wieder auf, wenn die
      // Sockets der Nachbarprozesse aus TIME_WAIT fallen.
      await new Promise((r) => setTimeout(r, 25 * 2 ** (versuch - 1)));
    }
  }
  throw letzter;
}
