/**
 * Modul: Test-Infrastruktur - Start und Abbau fuer Suiten, die
 *        `server/index.js` als PROGRAMM importieren (nicht als Text).
 *
 * Warum es diese Datei gibt (gemessen am 09.09.2026):
 * Der Import startet einen echten HTTP-Server und Hintergrund-Scheduler. Deren
 * Handles hielten den Prozess offen, weshalb diese Suiten mit
 * `process.exit(0)` in ihrem `after()`-Hook endeten. Genau das UEBERSCHREIBT
 * den Exit-Code, den node:test erst beim natuerlichen Prozessende setzt: eine
 * absichtlich falsche Assertion meldete `exit=0`, obwohl zwei `✖`-Zeilen im
 * Log standen. In der `npm test`-Kette konnten diese Suiten damit nur noch
 * ueber einen Top-Level-Fehler rot werden, nie ueber einen fehlgeschlagenen
 * `test()`-Block.
 *
 * `process.exit(process.exitCode ?? 0)` half nicht: im `after()`-Hook ist
 * `process.exitCode` noch `undefined` - auch nach `setImmediate` und nach
 * `setTimeout(..., 50)` (beides gemessen).
 *
 * Der Ausweg ist deshalb kein besserer Exit-Code, sondern KEIN `process.exit`:
 * `startTestServer()` raeumt im `after()`-Hook alle Handles ab, die den
 * Prozess offen hielten. Danach endet er von selbst - und node:test setzt den
 * echten Code. Bewiesen wird das nicht per Textguard, sondern von
 * `test/test-suite-exit-code.js`, das die Fixture daneben zweimal als
 * Programm faehrt: gruen muss 0 bleiben, rot muss 1 werden.
 *
 * Offen blieben: der Server-Socket (`server.close()` hier), die beiden
 * Sync-Timer (seither `unref()` in server/index.js) und der Backup-Cron
 * (`BACKUP_ENABLED=false`, der dokumentierte Schalter - `test-backup-
 * scheduler.js` nutzt denselben).
 */
import { after } from 'node:test';
import { once } from 'node:events';

import { freshTestDbPath } from './tmp-db.js';

/**
 * Startet `server/index.js` gegen eine frische Datei-Datenbank und meldet die
 * Basis-URL des tatsaechlich gebundenen Ports.
 *
 * Der Aufrufer setzt vorher nichts an `process.env` - alles, was die Suite
 * braucht, geht ueber `env`. Die Reihenfolge ist wichtig: die Werte muessen
 * stehen, BEVOR `server/index.js` ausgewertet wird.
 *
 * @param {object}  options
 * @param {string}  options.name  Sprechender Teil des DB-Dateinamens.
 * @param {object}  options.env   Zusaetzliche/abweichende Umgebungswerte.
 * @returns {Promise<{ baseUrl: string, app: import('express').Express, server: import('node:http').Server, dbPath: string }>}
 */
export async function startTestServer({ name, env = {} } = {}) {
  // Die eine Hausregel fuer Datei-Datenbanken: `freshTestDbPath` raeumt VOR
  // dem Oeffnen weg und setzt `DB_PATH` gleich mit (siehe test/tmp-db.js).
  const dbPath = freshTestDbPath(name);

  process.env.SESSION_SECURE = 'false';
  // Port 0: der Kernel sucht einen freien Port. Feste Nummern (13098, 13099,
  // 13100) kollidieren, sobald zwei Suiten gleichzeitig laufen - und eine
  // belegte Nummer sah wie ein kaputter Server aus.
  process.env.PORT = '0';
  // Nur Loopback: ohne Angabe lauscht server/index.js auf allen Interfaces, und
  // die Suite waere fuer ihre Dauer aus dem lokalen Netz erreichbar.
  process.env.BIND_ADDRESS = '127.0.0.1';
  // Der Backup-Cron traegt zu keiner dieser Suiten etwas bei, laesst sich aber
  // nicht unref()en; er muesste sonst einzeln gestoppt werden.
  process.env.BACKUP_ENABLED = 'false';
  for (const [key, value] of Object.entries(env)) process.env[key] = String(value);

  const { default: app, server } = await import('../server/index.js');

  // `listening` kann beim Zurueckkehren aus dem Import schon gefallen sein -
  // dann wartet `once()` auf ein Ereignis, das nie wieder kommt.
  if (!server.listening) {
    await Promise.race([
      once(server, 'listening'),
      once(server, 'error').then(([err]) => { throw err; }),
    ]);
  }

  const baseUrl = `http://127.0.0.1:${server.address().port}`;

  after(async () => {
    // Erst die offenen Keep-Alive-Verbindungen: `fetch` haelt sie, und
    // `close()` wartet sonst auf einen Socket, den niemand mehr schliesst.
    server.closeAllConnections?.();
    await new Promise((resolve) => server.close(resolve));
  });

  return { baseUrl, app, server, dbPath };
}

/**
 * `Set-Cookie` einer Antwort in einen `Cookie`-Header umschreiben.
 *
 * Steht hier, weil alle drei Suiten dieselbe Zerlegung brauchen: der Split
 * trennt an einem Komma nur dann, wenn danach ein neues `name=`-Paar beginnt -
 * ein Komma im `Expires`-Datum darf nicht trennen.
 */
export function cookieHeader(setCookie) {
  return String(setCookie || '')
    .split(/,(?=\s*[^;,]+=)/)
    .map((cookie) => cookie.split(';')[0].trim())
    .filter(Boolean)
    .join('; ');
}
