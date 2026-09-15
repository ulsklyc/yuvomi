/**
 * Modul: Bindungsadresse des HTTP-Servers
 * Zweck: `BIND_ADDRESS` an EINER Stelle auslegen. Zwei Aufrufer brauchen dieselbe
 *        Antwort: `app.listen()` in server/index.js und der Loopback-Selbstaufruf
 *        der MCP-Bruecke (server/mcp/tools.js). Lauscht der Server nur auf einer
 *        LAN-Adresse, geht ein Aufruf an 127.0.0.1 ins Leere - und zwar still,
 *        erst beim ersten MCP-Werkzeug.
 * Abhängigkeiten: node:net
 */

import { isIP } from 'node:net';

/**
 * Leer oder nur Leerraum heisst: keine Angabe. Dann lauscht der Server wie vor
 * der Variable auf allen Interfaces - das braucht jeder Container, weil das
 * veroeffentlichte Port-Mapping die App sonst nicht erreicht.
 *
 * Eine IPv6-Adresse mit Zonen-ID (`fe80::1%eth0`) wird abgelehnt. `listen()`
 * nimmt sie an, aber keine URL kann sie ausdruecken: Nodes URL-Parser verwirft
 * `[fe80::1%eth0]` wie `[fe80::1%25eth0]` (gemessen am 2026-09-15). Der Server
 * liefe also, und jeder Selbstaufruf der MCP-Bruecke scheiterte - auch mit
 * `MCP_INTERNAL_BASE_URL`, das dieselbe URL braeuchte. Lieber beim Start laut.
 * Diese Pruefung steht VOR `isIP()`, denn `isIP('fe80::1%eth0')` ist 6.
 *
 * Ein Hostname wird ebenfalls abgelehnt, auch `localhost`. `listen()` loest ihn
 * einmal beim Start auf, der Selbstaufruf der MCP-Bruecke bei JEDEM Aufruf neu.
 * Bei Round-Robin-DNS, mehreren Eintraegen oder einem geaenderten Eintrag trifft
 * er dann eine andere Maschine als den gebundenen Socket - und traegt dabei die
 * Anmeldung des Aufrufers mit (Bearer-Token, API-Key, Session-Cookie). Nur ein
 * IP-Literal meint beide Male dieselbe Adresse.
 *
 * @param {string|undefined} value Rohwert aus der Umgebung
 * @returns {string|undefined} Adresse fuer `listen()`, undefined fuer alle Interfaces
 */
export function readBindAddress(value) {
  const trimmed = typeof value === 'string' ? value.trim() : '';
  if (trimmed.includes('%')) {
    throw new Error(
      `BIND_ADDRESS=${trimmed}: IPv6 addresses with a zone ID are not supported. The server `
      + 'could listen there, but no URL can reach it, so the MCP bridge would fail on every '
      + 'call. Use an address without a zone, or leave BIND_ADDRESS unset.',
    );
  }
  if (trimmed && isIP(trimmed) === 0) {
    throw new Error(
      `BIND_ADDRESS=${trimmed}: use an IP address such as 127.0.0.1, 192.168.1.5 or ::1, not a `
      + 'host name. The server resolves a name once at startup, but the MCP bridge would resolve '
      + 'it again on every call and could reach another machine with the caller\'s credentials.',
    );
  }
  return trimmed || undefined;
}

/**
 * Host fuer einen Aufruf an den eigenen Server, in URL-Schreibweise.
 *
 * Die beiden Wildcards sind nicht dasselbe: `::` muss IPv4 nicht annehmen
 * (ein reiner IPv6-Socket), ueber `[::1]` ist er aber immer erreichbar. Ohne
 * Angabe bleibt es bei 127.0.0.1 wie vor der Variable.
 *
 * @param {string|undefined} bindAddress Ergebnis von readBindAddress()
 * @returns {string} z.B. `127.0.0.1`, `[::1]`, `192.168.1.5` oder `[fd00::5]`
 */
export function selfCallHost(bindAddress) {
  if (!bindAddress || bindAddress === '0.0.0.0') return '127.0.0.1';
  if (bindAddress === '::') return '[::1]';
  return bindAddress.includes(':') ? `[${bindAddress}]` : bindAddress;
}
