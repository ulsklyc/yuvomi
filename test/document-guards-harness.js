/**
 * Modul: Test-Infrastruktur - Harness der Dokument-Guards (Guard-Ebene 4)
 *
 * Zweck: einen echten Browser gegen eine echte Instanz fahren, damit Guards
 *        messen koennen, was im gerenderten Dokument steht - nicht was im
 *        Stylesheet geschrieben ist.
 *
 * WARUM EINE EIGENE EBENE (Redesign-Handoff §2, „vier Guard-Ebenen"):
 * drei Befundklassen des Architektur-Audits 2026-08-07 sind im Quelltext
 * unsichtbar und im Dokument offensichtlich.
 *   - Ein Kontrastverstoss aus der KOMPOSITION zweier Regeln (ein
 *     Nachfahren-Selektor greift in einen Knopf hinein) stand seit Runde 1
 *     live bei 1.13:1. Der bestehende Token-Guard prueft Token-PAARE und kann
 *     ihn prinzipiell nicht sehen.
 *   - Ein Kopf-Ueberlauf von 79px war nur durch `overflow-x: hidden` verdeckt.
 *   - Zielgroessen misst keine Textsuche.
 * Alle drei fand ein Reviewer. Beim naechsten Mal ist kein Reviewer da.
 *
 * ABGRENZUNG ZU `npm test`: diese Suite haengt bewusst NICHT in der
 * netzfreien Kette. Sie braucht einen Serverprozess und einen Browser; die
 * uebrige Testinfrastruktur importiert Route-Handler direkt gegen
 * In-Memory-SQLite und soll das bleiben. Der Suite-Registry-Guard
 * (test-suite-chain.js) kennt diese Zweiteilung als REGEL: eine Suite, deren
 * Datei `puppeteer` importiert, haengt in `test:document-guards` statt in
 * `test`. Keine Namensausnahme.
 *
 * KEIN NETZZUGRIFF: der Server laeuft auf localhost gegen eine temporaere
 * SQLite-Datei, der Service Worker wird im Testkontext abgeschaltet (sonst
 * misst man den Shell-Cache statt der Aenderung).
 *
 * Aufruf ueber test/test-document-guards.js. Waehrend der Entwicklung kann
 * `DOCUMENT_GUARDS_BASE_URL` auf einen bereits laufenden Preview-Server
 * zeigen; dann entfaellt das Hochfahren samt Seed - und mit ihm die Isolation
 * der Sonden (#1104), weil es keinen Server gibt, den `reset()` neu starten
 * koennte. Ein solcher Lauf taugt deshalb nicht als Beleg.
 */

import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3-multiple-ciphers';
import puppeteer from 'puppeteer';
import { SETTINGS_LEAVES } from '../public/settings/registry.js';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/**
 * Verwirft jede Erinnerung des Ausgangsstands (#1160).
 *
 * Der Seed traegt Geburtstage mit festem Datum und Vorlauf, und der Harness
 * seedet am Lauftag. An solchen Tagen ist eine Erinnerung faellig, ihr Toast
 * liegt ueber dem Fuss eines offenen Dialogs und nimmt den Klick auf
 * "Speichern": am 12.09.2026 wurden dadurch drei Kalender-Sonden rot, einen Tag
 * spaeter waeren sie zufaellig wieder gruen gewesen. Keine Sonde prueft
 * Erinnerungen, also soll auch keine davon abhaengen, an welchem Tag der
 * Handlauf faehrt. Der Fehler in der Oberflaeche selbst ist #1160 und gehoert in
 * eine eigene Sonde, nicht in ein Ausblenden hier.
 *
 * VERWORFEN, NICHT GELOESCHT, und die Geburtstage bleiben unangetastet. Ihre
 * Kalendertermine und Erinnerungen entstehen erst beim ersten Abgleich
 * (`syncAllBirthdayReminders`, ausgeloest von `GET /reminders/pending`); deshalb
 * gleicht `startHarness` einmal als die angemeldete Person ab, BEVOR diese
 * Funktion laeuft. Der erste Versuch leerte stattdessen `reminder_offset` - der
 * Wert bedeutet in `syncBirthdayCalendarEvent` aber auch "kein Termin", und der
 * Kalender haette fuer den ganzen Lauf keinen einzigen Geburtstag mehr gezeigt
 * (Review an #1161). Dass eine Verwerfung den naechsten Abgleich ueberlebt, gilt
 * erst, seit `syncBirthdayReminder` die Zeile desselben Termins behaelt.
 */
function dismissAllReminders(dbPath) {
  const db = new Database(dbPath);
  try {
    return db.prepare('UPDATE reminders SET dismissed = 1 WHERE dismissed = 0').run().changes;
  } finally {
    db.close();
  }
}

/** Die 16 Hauptrouten - dieselbe Liste, die capture.mjs und head-audit belegen. */
export const ROUTES = {
  dashboard: '/',
  tasks: '/tasks',
  calendar: '/calendar',
  shopping: '/shopping',
  meals: '/meals',
  recipes: '/recipes',
  pantry: '/pantry',
  notes: '/notes',
  contacts: '/contacts',
  birthdays: '/birthdays',
  budget: '/budget',
  documents: '/documents',
  health: '/health',
  rewards: '/rewards',
  housekeeping: '/housekeeping',
  settings: '/settings',
};

/**
 * Die Settings-Blaetter - ABGELEITET, nicht aufgezaehlt.
 *
 * `ROUTES` oben faehrt `/settings` und landet damit auf der Domaenen-Uebersicht.
 * Dahinter liegen 23 Blaetter mit eigener Route, und keines davon hatte je eine
 * Sonde gesehen: die Rechtevergabe, die Familienverwaltung, die API-Token, die
 * Backup-Wiederherstellung und jedes Sync-Konto. Elf Sonden massen 16 Module und
 * ein Uebersichtsraster.
 *
 * DIE QUELLE IST DIE REGISTRY, WEIL SIE DIE ROUTEN AUCH ERZEUGT: `router.js:84`
 * baut die Routentabelle aus genau diesem Array. Eine Handliste hier wuerde beim
 * naechsten IA-Umbau still veralten - und zwar in die falsche Richtung: ein neu
 * dazugekommenes Blatt fiele lautlos aus jeder Messung, so wie es diese 23 zwoelf
 * Sessions lang getan haben. Der Preis dafuer ist ein Import aus `public/` in den
 * Testbaum, und den zahlt `test-settings-navigation.js` fuer dieselbe Quelle
 * bereits.
 *
 * ES SIND ALLE 23, NICHT DIE OEFFENTLICHEN SIEBEN: der Harness meldet sich als
 * `linda` an, und die ist im Seed `admin` (scripts/seed-demo.js:279). Ein
 * nicht-administrativer Aufruf wuerde von `findSettingsLeaf` auf
 * `/settings/personal/account` umgeleitet, und die Sonde maesse sechzehnmal
 * dasselbe Konto-Formular, ohne es zu merken.
 */
export const SETTINGS_ROUTES = Object.freeze(Object.fromEntries(
  SETTINGS_LEAVES.map((leaf) => [`settings/${leaf.id}`, leaf.path]),
));

/**
 * Die Seiten VOR der Anmeldung.
 *
 * WARUM SIE EIGENS STEHEN: `ROUTES` oben sind angemeldete Zustaende, und
 * `openPage` reicht dafuer ein Sitzungs-Cookie durch. Alle vier Guard-Ebenen
 * und alle Sonden massen deshalb ausschliesslich die App hinter dem Login -
 * der Erstkontakt und der Weg jedes neuen Familienmitglieds hatte nie eine
 * Sonde gesehen (Audit 2026-08-08, P2-5).
 *
 * `offline.html` gehoert dazu: sie ist die Service-Worker-Huelle, laedt kein
 * App-Stylesheet und faellt damit aus jeder anderen Pruefung heraus.
 *
 * Die Tokens sind Attrappen - beide Seiten rendern ihr Formular auch mit einem
 * ungueltigen Token; geprueft wird die Struktur, nicht der Einloeseweg.
 */
export const ANON_ROUTES = {
  login: '/login',
  'forgot-password': '/forgot-password',
  'reset-password': '/reset-password?token=demo-token-for-audit',
  join: '/join?token=demo-token-for-audit',
  setup: '/setup',
  offline: '/offline.html',
};

export const DEVICES = {
  desktop: { width: 1280, height: 900, deviceScaleFactor: 1, isMobile: false, hasTouch: false },
  mobile: { width: 375, height: 812, deviceScaleFactor: 2, isMobile: true, hasTouch: true },
  /* DIE KOMPAKTE HOEHENKLASSE (tokens.css §11c, DESIGN.md „Die Chrome-Regel").
   *
   * 640x400 ist kein erfundener Wert: es ist ein 1280x800-Laptop bei 200 %
   * Browserzoom, also genau der Zustand, den WCAG 1.4.4 verlangt. Dieselben
   * Masse hat ein Splitscreen-Tablet und ungefaehr jedes Telefon im Querformat.
   *
   * Bewusst KEIN Touch: wer auf 200 % zoomt, sitzt in aller Regel an einem
   * Zeigergeraet, und `--target-base` schaltet ueber `(hover: none)`. Eine
   * dritte Welt mit Touch waere ein vierter Zustand fuer jede Sonde, die sie
   * faehrt - dieselbe Rechnung, die LEAVES_SKIPPED oben fuehrt. */
  short: { width: 640, height: 400, deviceScaleFactor: 1, isMobile: false, hasTouch: false },
};

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

async function freePort() {
  return new Promise((res, rej) => {
    const srv = createServer();
    srv.on('error', rej);
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address();
      srv.close(() => res(port));
    });
  });
}

function run(cmd, args, env) {
  return new Promise((res, rej) => {
    const child = spawn(cmd, args, { cwd: REPO, env: { ...process.env, ...env }, stdio: 'ignore' });
    child.on('error', rej);
    child.on('exit', (code) => (code === 0 ? res() : rej(new Error(`${args[0]} exit ${code}`))));
  });
}

async function waitForHttp(baseUrl, timeoutMs = 30000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const r = await fetch(`${baseUrl}/login`, { redirect: 'manual' });
      if (r.status < 500) return;
    } catch {
      /* noch nicht oben */
    }
    await wait(200);
  }
  throw new Error(`Server auf ${baseUrl} kam nicht hoch`);
}

function startServer(dbPath, port) {
  const child = spawn(process.execPath, ['server/index.js'], {
    cwd: REPO,
    env: {
      ...process.env,
      NODE_ENV: 'development',
      DB_PATH: dbPath,
      PORT: String(port),
      BASE_URL: `http://127.0.0.1:${port}`,
      SESSION_SECRET: 'document-guards-secret-0123456789abcdef',
      // Der Login-Limiter laesst fuenf Versuche pro Minute zu. Das ist fuer die
      // App richtig und fuer eine Suite, die mehrfach hintereinander laeuft,
      // eine Fehlerquelle, die wie ein fehlender Seed aussieht.
      RATE_LIMIT_MAX_ATTEMPTS: '1000',
      // Hintergrundarbeit aus dem Messfenster halten.
      DISABLE_BACKUP_SCHEDULER: '1',
    },
    stdio: 'ignore',
  });
  return child;
}

async function stopServer(child) {
  // `signalCode` zaehlt mit: ein per Signal beendeter Prozess hat keinen
  // `exitCode`, und auf sein `exit` zu warten hiesse ewig warten.
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  // ERST NACH DEM EXIT ZURUECK, auch nach SIGKILL. Seit `reset()` folgt auf
  // jedes Stoppen ein Kopieren der Datenbank und ein Neustart auf demselben
  // Port - ein Server, der noch stirbt, schreibt dann in die Kopie oder haelt
  // den Port.
  const exited = new Promise((res) => child.once('exit', res));
  child.kill('SIGTERM');
  const hard = setTimeout(() => child.kill('SIGKILL'), 5000);
  await exited;
  clearTimeout(hard);
}

/**
 * Kopiert eine SQLite-Datenbank samt `-wal` und `-shm` - nur bei gestopptem
 * Server. Die drei gehoeren zusammen: eine Hauptdatei ohne ihre WAL ist ein
 * aelterer Stand, und eine liegengebliebene WAL neben einer fremden
 * Hauptdatei spielt SQLite beim naechsten Oeffnen auf die falsche Datei.
 * Deshalb wird am Ziel zuerst alles entfernt.
 */
function copyDatabase(from, to) {
  for (const suffix of ['-wal', '-shm', '']) rmSync(`${to}${suffix}`, { force: true });
  for (const suffix of ['', '-wal', '-shm']) {
    if (existsSync(`${from}${suffix}`)) copyFileSync(`${from}${suffix}`, `${to}${suffix}`);
  }
}

/** Meldet sich einmal an und liefert die Session-Cookies als puppeteer-Objekte. */
async function loginCookies(baseUrl) {
  let res;
  // Ein 429 ist hier kein Fehler der Suite, sondern der Nachhall eines
  // vorherigen Laufs im selben Minutenfenster (fuenf Versuche pro IP). Beim
  // eigenen Server ist der Limiter per Env hochgesetzt; gegen einen externen
  // Preview-Server hilft nur kurz warten.
  for (let attempt = 0; attempt < 3; attempt += 1) {
    res = await fetch(`${baseUrl}/api/v1/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: 'linda', password: 'demo1234' }),
    });
    if (res.status !== 429) break;
    await wait(8000);
  }
  if (!res.ok) {
    throw new Error(
      `Login als linda/demo1234 fehlgeschlagen (${res.status}) - ` +
        `${res.status === 429 ? 'Login-Limiter, eine Minute warten' : 'Seed vorhanden?'}`,
    );
  }
  const { hostname } = new URL(baseUrl);
  return res.headers.getSetCookie().map((raw) => {
    const [pair] = raw.split(';');
    const idx = pair.indexOf('=');
    return {
      name: pair.slice(0, idx).trim(),
      value: pair.slice(idx + 1).trim(),
      domain: hostname,
      path: '/',
    };
  });
}

/**
 * Faehrt Server (falls noetig) und Browser hoch.
 *
 * `reset()` stellt vor jeder Sonde den Ausgangsstand wieder her (#1104): der
 * Server startet neu auf dem Stand nach Seed und Anmeldung, und die Sonde
 * bekommt einen frischen Browser-Kontext. Gegen `DOCUMENT_GUARDS_BASE_URL`
 * gibt es keinen Server zum Neustarten - dort erneuert `reset()` nur den
 * Kontext, und Limit wie Daten laufen weiter von Sonde zu Sonde.
 *
 * @returns {Promise<{baseUrl: string, browser: import('puppeteer').Browser, context: import('puppeteer').BrowserContext, reset: () => Promise<void>, close: () => Promise<void>}>}
 */
export async function startHarness() {
  const external = process.env.DOCUMENT_GUARDS_BASE_URL;
  let server = null;
  let tmpDir = null;
  let dbPath = null;
  let port = null;
  let baseUrl = external;

  if (!external) {
    tmpDir = mkdtempSync(join(tmpdir(), 'yuvomi-document-guards-'));
    dbPath = join(tmpDir, 'guards.db');
    port = await freePort();
    baseUrl = `http://127.0.0.1:${port}`;

    // Erster Start migriert das leere Schema. Der Seed laeuft danach als
    // eigener Prozess auf derselben Datei - deshalb muss der Server dafuer
    // aus dem Weg sein, statt parallel auf die WAL zu schreiben.
    const migrator = startServer(dbPath, port);
    await waitForHttp(baseUrl);
    await stopServer(migrator);

    await run(process.execPath, ['scripts/seed-demo.js', '--db', dbPath, '--locale', 'de']);

    server = startServer(dbPath, port);
    await waitForHttp(baseUrl);
  }

  const browser = await puppeteer.launch({
    headless: true,
    args: ['--no-sandbox', '--disable-dev-shm-usage'],
  });

  // EINMAL anmelden, Cookie an alle Seiten weiterreichen.
  //
  // WARUM NICHT PRO SEITE: `/api/v1/auth/login` haengt hinter einem Limiter mit
  // fuenf Versuchen pro Minute. Eine Suite, die pro Sprache und pro
  // Geraet-Theme-Paar neu anmeldet, faellt beim zweiten Lauf hintereinander in
  // ihn hinein - und der Fehler sieht dann aus wie ein fehlender Seed.
  const cookies = await loginCookies(baseUrl);

  // DER STAND NACH SEED UND ANMELDUNG IST DER AUSGANGSPUNKT JEDER SONDE (#1104).
  // Die Anmeldung gehoert in den Snapshot, weil die Sitzung in der Datenbank
  // liegt (`sessions`): nach dem Zuruecksetzen ist das Cookie oben wieder gueltig,
  // und der Login-Limiter sieht keinen zweiten Versuch.
  let snapshotPath = null;
  if (!external) {
    // Ein Abgleich als die angemeldete Person legt die Geburtstagstermine und
    // ihre Erinnerungen an; danach verwirft `dismissAllReminders` sie (#1160).
    const pending = await fetch(`${baseUrl}/api/v1/reminders/pending`, {
      headers: { Cookie: cookies.map((c) => `${c.name}=${c.value}`).join('; ') },
    });
    if (!pending.ok) throw new Error(`Abgleich der Erinnerungen fehlgeschlagen (${pending.status})`);
    await stopServer(server);
    dismissAllReminders(dbPath);
    mkdirSync(join(tmpDir, 'snapshot'));
    snapshotPath = join(tmpDir, 'snapshot', 'guards.db');
    copyDatabase(dbPath, snapshotPath);
    server = startServer(dbPath, port);
    await waitForHttp(baseUrl);
  }

  const harness = {
    baseUrl,
    browser,
    cookies,
    context: await browser.createBrowserContext(),
    // Hat seit dem letzten Zuruecksetzen eine Seite den Server erreicht? Eine
    // Sonde ohne Browser (etwa der Abgleich zweier Listen) laesst ihn
    // unberuehrt, und dafuer den Server neu zu starten kostet nur Zeit.
    touched: false,

    /**
     * Stellt den Ausgangsstand wieder her: zuerst ein frischer Browser-Kontext,
     * damit keine Seite der vorigen Sonde weiter anfragt (Cookies, localStorage
     * und Cache gehen mit), dann ein Neustart auf dem Snapshot. Der Neustart
     * leert das Limit, weil es im Speicher des Prozesses liegt, und die Kopie
     * nimmt jede Zeile zurueck, die eine Sonde angelegt und nicht wieder
     * geloescht hat.
     */
    async reset() {
      await harness.context.close();
      harness.context = await browser.createBrowserContext();
      if (external || !harness.touched) return;
      await stopServer(server);
      copyDatabase(snapshotPath, dbPath);
      server = startServer(dbPath, port);
      await waitForHttp(baseUrl);
      harness.touched = false;
    },

    async close() {
      await browser.close();
      await stopServer(server);
      if (tmpDir) rmSync(tmpDir, { recursive: true, force: true });
    },
  };
  return harness;
}

/**
 * Schaltet den Service Worker einer Seite ab, bevor eines ihrer Skripte laeuft.
 *
 * Der Service Worker cacht die Shell. Ohne diese Abschaltung misst der Guard
 * den Stand des letzten Laufs statt den der Arbeitskopie (Handoff §6).
 *
 * DER ABBRUCH VON `/sw.js` HAT IHN NIE ERREICHT (gemessen fuer #1104). Den
 * Skriptabruf von `navigator.serviceWorker.register()` sieht die
 * Request-Interception der Seite nicht: der Abbruch griff kein einziges Mal,
 * und nach dem ersten Laden war `navigator.serviceWorker.controller` gesetzt.
 * Solange alle Sonden einen Browser-Kontext teilten, installierte er sich
 * einmal pro Lauf. Mit einem frischen Kontext je Sonde installiert er sich je
 * Sonde, `sw-register.js` laedt beim `controllerchange` die Seite nach 200 ms
 * neu, und in Sonde 10 zerstoerte das den Ausfuehrungskontext mitten in der
 * Messung.
 *
 * ABGELEHNT, NICHT WEGDEFINIERT: ein `navigator.serviceWorker`, das
 * `undefined` liefert, laesst die App beim Aufbau abstuerzen (sie haengt
 * Listener daran) - die Seite blieb dann leer und die Sonden massen ein
 * Dokument ohne Modul. Hier bleibt der Container, nur `register()` lehnt ab,
 * und `sw-register.js` faengt das selbst.
 *
 * `ready` LEHNT EBENFALLS AB, SONST HAENGT ES. Laut Spezifikation erfuellt
 * sich `ready` erst mit einer aktiven Registrierung - lehnt `register()` ab,
 * bliebe es fuer immer offen, und kein `try/catch` hilft gegen ein Promise,
 * das sich nie entscheidet. `pushStatus()` in push.js wartet darauf, das
 * Benachrichtigungs-Blatt blieb dann auf "wird geprueft" mit gesperrten
 * Knoepfen stehen, und die Sonden massen diesen Zwischenstand. Als der Worker
 * noch wirklich installierte, erreichte das Blatt "nicht abonniert"; ein
 * abgelehntes `ready` landet in genau diesem catch. Die uebrigen Leser in
 * push.js laufen nur nach einem Klick oder mit erteilter Berechtigung.
 */
async function disableServiceWorker(page) {
  await page.evaluateOnNewDocument(() => {
    if (typeof ServiceWorkerContainer === 'undefined') return;
    const abgeschaltet = () => Promise.reject(new Error('document-guards: Service Worker abgeschaltet'));
    ServiceWorkerContainer.prototype.register = abgeschaltet;
    Object.defineProperty(ServiceWorkerContainer.prototype, 'ready', { configurable: true, get: abgeschaltet });
  });
}

/**
 * Oeffnet eine angemeldete Seite in der gewuenschten Groessenklasse, Sprache
 * und Farbwelt.
 */
export async function openPage(harness, { device = 'mobile', theme = 'light', locale = 'de' } = {}) {
  harness.touched = true;
  const page = await harness.context.newPage();
  await page.setViewport(DEVICES[device]);
  await page.emulateMediaFeatures([{ name: 'prefers-color-scheme', value: theme }]);
  await disableServiceWorker(page);

  // Die Interception bleibt eingeschaltet, obwohl sie den Service Worker nicht
  // abschaltet: eine Sonde kann darueber einzelne Anfragen anhalten.
  await page.setRequestInterception(true);
  page.on('request', (req) => req.continue());

  await page.setCookie(...harness.cookies);
  // Nicht ueber `/login`: die angemeldete App leitet von dort sofort weiter, und
  // die Weiterleitung zerreisst den Ausfuehrungskontext des naechsten
  // `evaluate` („Execution context was destroyed"). Der Einstieg ist deshalb
  // eine Route, die stehen bleibt.
  await page.goto(`${harness.baseUrl}/`, { waitUntil: 'domcontentloaded' });
  await page.evaluate(
    ({ t, l }) => {
      localStorage.setItem('yuvomi-locale', l);
      localStorage.setItem('yuvomi-onboarded', '1');
      localStorage.setItem('yuvomi-install-dismissed', String(Date.now()));
      localStorage.setItem('yuvomi-theme', t);
    },
    { t: theme, l: locale },
  );

  page.__yuvomiBase = harness.baseUrl;
  page.__yuvomiTheme = theme;
  await gotoRoute(page, '/');
  return page;
}

/** Wartet, bis die Route wirklich aufgebaut ist - nicht nur, bis der Pfad passt. */
export async function settle(page) {
  try {
    await page.waitForFunction(
      () => {
        const loading = document.getElementById('app-loading');
        const gone = !loading || loading.hidden || getComputedStyle(loading).display === 'none';
        const main = document.getElementById('main-content');
        return gone && main && main.children.length > 0;
      },
      { timeout: 15000 },
    );
  } catch {
    /* Die Sonden melden ohnehin, wenn nichts zu messen war. */
  }
  // `main.children.length > 0` ist erfuellt, sobald der Modulkopf steht - die
  // LISTEN holt das Modul danach per API nach. Wer nur darauf wartet, misst
  // ein halbes Dokument: in einem Volllauf fehlten so die Einkaufszeilen, die
  // Kalendertage und die Notizkarten, waehrend Kopf und Navigation da waren.
  // Das ist kein Stale-Problem einer Ausnahmeliste, sondern eine Sonde, die
  // einen Verstoss uebersehen kann (Session 11).
  // Das Zeitbudget ist knapp bemessen, und zwar gemessen: mit 8000ms lief die
  // Suite von 15s auf 153s je Locale, weil mindestens ein Modul dauerhaft
  // pollt und die Ruhe nie eintritt - der Timeout wurde zur Regel statt zur
  // Ausnahme. 2000ms kosten den Polling-Fall zwei Sekunden und geben allen
  // anderen ihre Liste.
  try {
    await page.waitForNetworkIdle({ idleTime: 400, timeout: 2000 });
  } catch {
    /* Ein Modul mit dauerndem Polling erreicht nie Ruhe - dann zaehlt wait(). */
  }
  await wait(700);
  // Der Aufruf faellt gelegentlich in eine Weiterleitung, die die App selbst
  // ausloest („Execution context was destroyed"). Das ist kein Messfehler,
  // sondern ein Rennen - der naechste Aufruf misst dieselbe Seite.
  try {
    await page.evaluate(() => document.querySelector('yuvomi-install-prompt')?.remove());
  } catch {
    await wait(500);
  }
}

/**
 * Navigiert auf eine Route und wartet den Aufbau ab.
 *
 * HART statt per pushState: die App legt keinen Navigations-Einstieg auf
 * `window`, und ein blosses `popstate` baute die Zielseite messbar NICHT auf -
 * der Pfad stimmte, die `.page-toolbar` blieb aus. Ein Guard, der auf der
 * falschen Seite misst, ist schlimmer als keiner; der SPA-Fallback des Servers
 * macht den harten Weg verlaesslich.
 */
export async function gotoRoute(page, path) {
  await page.goto(`${page.__yuvomiBase}${path}`, { waitUntil: 'domcontentloaded' });
  // Ein harter Ladevorgang setzt das Attribut zurueck, das der Theme-Umschalter
  // sonst aus localStorage schreibt - hier wird es explizit nachgezogen.
  try {
    await page.evaluate((t) => document.documentElement.setAttribute('data-theme', t), page.__yuvomiTheme);
  } catch {
    /* Weiterleitung mitten im Aufruf; settle() wartet den Aufbau ohnehin ab. */
  }
  await settle(page);
  await page.evaluate((t) => document.documentElement.setAttribute('data-theme', t), page.__yuvomiTheme);
}

/**
 * Oeffnet eine Seite OHNE Sitzung - fuer die Zustaende vor der Anmeldung.
 *
 * Kein Cookie, kein Einstieg ueber `/`: beides wuerde die App genau von den
 * Seiten wegleiten, um die es hier geht. `settle()` entfaellt aus demselben
 * Grund - es wartet auf `#main-content` mit Kindern, und `offline.html` ist
 * kein SPA-Dokument. Stattdessen wird auf den ersten stabilen Aufbau gewartet.
 */
export async function openAnonPage(harness, { device = 'mobile', theme = 'light', locale = 'de' } = {}) {
  harness.touched = true;
  const page = await harness.context.newPage();
  await page.setViewport(DEVICES[device]);
  await page.emulateMediaFeatures([{ name: 'prefers-color-scheme', value: theme }]);
  await disableServiceWorker(page);
  // DIE SPRACHE STEHT FEST, BEVOR EIN SKRIPT DER SEITE LAEUFT. Ohne
  // `yuvomi-locale` greifen lang-init.js und i18n.js auf `navigator.languages`
  // zurueck, und das ist im headless Chrome Englisch. Solange alle Sonden einen
  // Kontext teilten, hatte ein frueheres `openPage()` den Schluessel schon
  // gesetzt; mit einem frischen Kontext je Sonde ist er weg, und Sonde 10 mass
  // die Seiten vor der Anmeldung auf Englisch - bei Ueberlauf und Zielgroessen,
  // die an der Textlaenge haengen.
  await page.evaluateOnNewDocument((l) => {
    try { localStorage.setItem('yuvomi-locale', l); } catch { /* undurchsichtiger Ursprung */ }
  }, locale);
  await page.setRequestInterception(true);
  page.on('request', (req) => req.continue());
  page.__yuvomiBase = harness.baseUrl;
  page.__yuvomiTheme = theme;
  return page;
}

/** Navigiert eine anonyme Seite an und wartet, bis sie steht. */
export async function gotoAnonRoute(page, path) {
  await page.goto(`${page.__yuvomiBase}${path}`, { waitUntil: 'domcontentloaded' });
  try {
    await page.waitForFunction(
      () => document.querySelector('h1, [role="heading"]') !== null,
      { timeout: 15000 },
    );
  } catch {
    /* Die Sonde meldet selbst, wenn nichts zu messen war. */
  }
  await wait(400);
}

/**
 * Farb-Parser fuer BEIDE Notationen, die Chromium liefert.
 *
 * FALLE, die das Architektur-Audit selbst getroffen hat: `color-mix()` rendert
 * als `color(srgb 0.4 0.2 0.8 / 0.16)`, nicht als `rgba()`. Ein naiver
 * rgba-Parser meldet daraufhin Fehltreffer - im ersten Auditlauf zwei falsche
 * AA-Befunde. Wer hier etwas ergaenzt, ergaenzt beide Notationen.
 *
 * @returns {[number, number, number, number]} r,g,b in 0..255, alpha 0..1
 */
export function parseColor(value) {
  if (!value) return [0, 0, 0, 0];
  const srgbMatch = value.match(/^color\(srgb\s+([^)]+)\)$/i);
  if (srgbMatch) {
    const parts = srgbMatch[1].split('/');
    const rgb = parts[0].trim().split(/\s+/).map(Number);
    const alpha = parts[1] === undefined ? 1 : parseFloat(parts[1]);
    return [rgb[0] * 255, rgb[1] * 255, rgb[2] * 255, Number.isFinite(alpha) ? alpha : 1];
  }
  const rgbMatch = value.match(/^rgba?\(([^)]+)\)$/i);
  if (rgbMatch) {
    const parts = rgbMatch[1].split(/[,\s/]+/).filter(Boolean).map(Number);
    return [parts[0], parts[1], parts[2], parts[3] === undefined ? 1 : parts[3]];
  }
  if (value === 'transparent') return [0, 0, 0, 0];
  return [0, 0, 0, 1];
}

const channel = (c) => {
  const v = c / 255;
  return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
};

export function luminance([r, g, b]) {
  return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
}

export function contrastRatio(fg, bg) {
  const l1 = luminance(fg);
  const l2 = luminance(bg);
  return (Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05);
}

/** Alpha-Komposition eines Vordergrunds auf einen deckenden Untergrund. */
export function composite([r, g, b, a], base) {
  if (a >= 1) return [r, g, b];
  return [
    r * a + base[0] * (1 - a),
    g * a + base[1] * (1 - a),
    b * a + base[2] * (1 - a),
  ];
}

export function toHex([r, g, b]) {
  const h = (v) => Math.round(Math.max(0, Math.min(255, v))).toString(16).padStart(2, '0');
  return `#${h(r)}${h(g)}${h(b)}`.toUpperCase();
}
