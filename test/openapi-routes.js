/**
 * Modul: Test-Infrastruktur - die echten Routen unter /api/v1, so wie die Router sie haengen.
 * Zweck: EIN Router-Verfolger fuer die OpenAPI-Guards (test:openapi-coverage,
 * test:openapi-reasons), statt zwei Kopien, die einzeln blind werden.
 * Ausfuehren: keine eigene Suite - Helfer, importiert von den Guard-Suiten.
 *
 * Jede Blindstelle, die hier geschlossen wurde, liess den Guard GRUENER
 * aussehen statt roter (Sub-Mounts, benannte Importe, `targetRouter`, der
 * Mount von `requireAuth`) - die Begruendungen stehen an den Funktionen.
 */

import { readFileSync, existsSync } from 'node:fs';
import { dirname, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { withoutCommentsKeepingLines } from './source-text.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '..');
const INDEX = readFileSync(resolve(ROOT, 'server/index.js'), 'utf8');

/**
 * `app.use('/api/v1/x', xRouter)` - der erste Mount je Router gewinnt.
 *
 * NUR NAMEN AUF `Router`, und der Grund ist ein gemessener Fehlalarm: unter
 * `/api/v1` haengen ausser den Routern auch `requireAuth`, `csrfMiddleware` und
 * `idempotencyMiddleware`. `requireAuth` kommt aus server/auth.js - DERSELBEN
 * Datei wie `authRouter`. Ohne diesen Filter wurde auth.js zweimal
 * ausgewertet, einmal korrekt unter `/api/v1/auth` und einmal unter `/api/v1`,
 * und der Guard meldete 26 Routen als undokumentiert, die es unter dem
 * erfundenen Pfad `/api/v1/2fa/setup` nie gab. Ein Guard, der Falsches meldet,
 * wird abgeschaltet statt befolgt.
 */
function routerMounts() {
  const mounts = new Map();
  for (const m of INDEX.matchAll(/app\.use\(\s*'(\/api\/v1[^']*)'\s*,\s*(?:[\w.]+\s*,\s*)*(\w+)\s*\)/g)) {
    if (!m[2].endsWith('Router')) continue;
    if (!mounts.has(m[2])) mounts.set(m[2], m[1]);
  }
  return mounts;
}

/**
 * Importname -> Datei, fuer alles was aus server/ kommt.
 *
 * BEIDE IMPORTFORMEN, und das ist kein Detail: der Auth-Router kommt als
 * `import { router as authRouter, ... } from './auth.js'`. Ein Regex, der nur
 * den Default-Import kennt, sieht ihn nicht - und dann faellt der GANZE
 * /auth-Zweig aus der Pruefung, ohne dass etwas rot wird. Der Guard sah dabei
 * gruener aus, nicht roter.
 */
function routerFiles() {
  const files = new Map();
  for (const m of INDEX.matchAll(/import\s+(\w+)\s+from\s+'\.\/([\w./-]+\.js)'/g)) {
    files.set(m[1], resolve(ROOT, 'server', m[2]));
  }
  for (const m of INDEX.matchAll(/import\s+\{([^}]+)\}\s+from\s+'\.\/([\w./-]+\.js)'/g)) {
    for (const part of m[1].split(',')) {
      const alias = part.trim().split(/\s+as\s+/).pop().trim();
      if (alias && !files.has(alias)) files.set(alias, resolve(ROOT, 'server', m[2]));
    }
  }
  return files;
}

/**
 * Routen, die index.js selbst haelt (`app.get('/api/v1/version', ...)`).
 *
 * Sie gehen durch keinen Router und wuerden der Gegenrichtung sonst als
 * "Spec verspricht etwas, das es nicht gibt" auffallen - eine Falschmeldung,
 * die den Guard unglaubwuerdig macht.
 */
function directAppRoutes() {
  return [...INDEX.matchAll(/app\.(get|post|put|patch|delete)\(\s*'(\/api\/v1[^']*)'/g)]
    .map((m) => ({ verb: m[1], path: m[2].replace(/:(\w+)/g, '{$1}'), file: 'server/index.js', body: '' }));
}

/**
 * Alle Router-Dateien ab `entry`, JE MIT IHREM EIGENEN PRAEFIX.
 *
 * DER SUB-MOUNT IST DER GANZE PUNKT. `inventory/index.js` haengt seine fuenf
 * Unterrouter unter `/locations`, `/categories`, `/items`, `/entries` und
 * `/deadlines-feed` ein. Wer allen Unterdateien den Mount des Elternrouters
 * gibt, erfindet Pfade wie `/api/v1/inventory/{key}`, die es nie gab - und
 * meldet sie dann als fehlende Doku. Ein Guard, der falsche Befunde
 * produziert, wird abgeschaltet, nicht befolgt.
 *
 * Erfasst wird deshalb `router.use('<pfad>', <name>)` zusammen mit dem Import,
 * aus dem `<name>` stammt. Ein `router.use` ohne Pfad (Middleware) aendert den
 * Praefix nicht.
 */
function routerSources(entry, prefix = '', seen = new Map()) {
  if (seen.has(entry) || !existsSync(entry)) return seen;
  seen.set(entry, prefix);
  const src = readFileSync(entry, 'utf8');

  const imports = new Map();
  for (const m of src.matchAll(/import\s+(\w+)\s+from\s+'(\.[^']+\.js)'/g)) {
    imports.set(m[1], resolve(dirname(entry), m[2]));
  }

  const mounted = new Set();
  for (const m of src.matchAll(/router\.use\(\s*'([^']*)'\s*,\s*(?:[\w.]+\s*,\s*)*(\w+)\s*\)/g)) {
    const file = imports.get(m[2]);
    if (!file) continue;
    mounted.add(file);
    routerSources(file, prefix + m[1].replace(/\/+$/, ''), seen);
  }

  // Aufgeteilte Module ohne Sub-Mount (calendar/, budget/, health/) haengen
  // ihre Teile per `router.use(x)` oder als Re-Export ein - sie teilen den
  // Praefix des Elternrouters.
  for (const [, file] of imports) {
    if (mounted.has(file)) continue;
    if (!file.includes(`${resolve(ROOT, 'server/routes')}${sep}`)) continue;
    routerSources(file, prefix, seen);
  }
  return seen;
}

/**
 * Die Routen einer Datei, als OpenAPI-Pfad geschrieben.
 *
 * `:id` wird zu `{id}`, die Express-5-Wildcard `{*rest}` behaelt ihren Namen
 * als `{rest}` - genau so schreibt die Spec sie.
 *
 * DIE ROUTER-VARIABLE HEISST NICHT IMMER `router`. In server/auth.js legt eine
 * Fabrik ihre Routen auf `targetRouter`; ein Regex, der nur `router.` kennt,
 * uebersieht /forgot-password, /reset-password und den ganzen /invites-Zweig -
 * und meldet sie dann als Zusage ohne Code. Wieder ein Fall, in dem die
 * Blindheit den Guard GRUENER aussehen laesst.
 */
function routesIn(file, mount) {
  const src = readFileSync(file, 'utf8');
  const matches = [...src.matchAll(/\b\w*[Rr]outer\.(get|post|put|patch|delete|all)\(\s*'([^']*)'/g)];
  return matches.map((m, i) => {
    const path = m[2]
      .replace(/\{\*(\w+)\}/g, '{$1}')
      .replace(/:(\w+)/g, '{$1}')
      .replace(/\/+$/, '');
    const full = (mount + (path === '/' ? '' : path)).replace(/\/+$/, '') || mount;
    // `router.all` deckt jede Methode ab - fuer die Spec zaehlt es als GET.
    return {
      verb: m[1] === 'all' ? 'get' : m[1], path: full, file,
      body: handlerBody(src, m.index, matches[i + 1]?.index ?? src.length),
    };
  });
}

/**
 * Der Quelltext EINER Route: ab ihrem `router.<verb>(` bis zur naechsten Route
 * oder bis zur ersten Zeile danach, die wieder in Spalte 0 beginnt (das `});`
 * des Handlers oder eine Funktion dahinter) - was zuerst kommt.
 *
 * DIE SPALTE-0-GRENZE IST DER PUNKT. Ohne sie gehoerte ein Helfer, der nach
 * der letzten Route einer Datei steht (`function notFound(res) {...}`), samt
 * seinem `reason` dieser letzten Route - eine Zuordnung, die es nicht gibt.
 * Die Fabrik in server/auth.js legt ihre Routen eingerueckt an; dort greift
 * nur die naechste Route als Grenze.
 *
 * OHNE KOMMENTARE: in server/routes/weather.js steht ueber `/geocode` der
 * Kommentar `reason: 'name_too_short'`, eingerueckt und damit noch im Bereich
 * der Route DAVOR. Ungefiltert sendete GET /weather diesen Grund.
 */
function handlerBody(src, start, next) {
  const lineEnd = src.indexOf('\n', start);
  let end = next;
  if (lineEnd !== -1 && lineEnd < next) {
    const rest = src.slice(lineEnd + 1, next);
    const column0 = rest.search(/^\S/m);
    if (column0 !== -1) {
      const closing = rest.indexOf('\n', column0);
      end = lineEnd + 1 + (closing === -1 ? rest.length : closing);
    }
  }
  return withoutCommentsKeepingLines(src.slice(start, end));
}

function allRoutes() {
  const mounts = routerMounts();
  const files  = routerFiles();
  const routes = [];
  for (const [name, mount] of mounts) {
    const entry = files.get(name);
    if (!entry) continue;
    for (const [source, prefix] of routerSources(entry)) {
      routes.push(...routesIn(source, mount + prefix));
    }
  }
  routes.push(...directAppRoutes());
  return routes;
}

export { allRoutes, routerSources };
