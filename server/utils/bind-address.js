/**
 * Modul: Bindungsadresse des HTTP-Servers
 * Zweck: `BIND_ADDRESS` an EINER Stelle auslegen. Zwei Aufrufer brauchen dieselbe
 *        Antwort: `app.listen()` in server/index.js und der Loopback-Selbstaufruf
 *        der MCP-Bruecke (server/mcp/tools.js). Lauscht der Server nur auf einer
 *        LAN-Adresse, geht ein Aufruf an 127.0.0.1 ins Leere - und zwar still,
 *        erst beim ersten MCP-Werkzeug.
 * Abhängigkeiten: keine
 */

/** Adressen, die "alle Interfaces" meinen - dort ist 127.0.0.1 erreichbar. */
const WILDCARDS = new Set(['0.0.0.0', '::']);

/**
 * Leer oder nur Leerraum heisst: keine Angabe. Dann lauscht der Server wie vor
 * der Variable auf allen Interfaces - das braucht jeder Container, weil das
 * veroeffentlichte Port-Mapping die App sonst nicht erreicht.
 *
 * @param {string|undefined} value Rohwert aus der Umgebung
 * @returns {string|undefined} Adresse fuer `listen()`, undefined fuer alle Interfaces
 */
export function readBindAddress(value) {
  const trimmed = typeof value === 'string' ? value.trim() : '';
  return trimmed || undefined;
}

/**
 * Host fuer einen Aufruf an den eigenen Server, in URL-Schreibweise.
 *
 * @param {string|undefined} bindAddress Ergebnis von readBindAddress()
 * @returns {string} z.B. `127.0.0.1`, `192.168.1.5` oder `[fd00::5]`
 */
export function selfCallHost(bindAddress) {
  if (!bindAddress || WILDCARDS.has(bindAddress)) return '127.0.0.1';
  return bindAddress.includes(':') ? `[${bindAddress}]` : bindAddress;
}
