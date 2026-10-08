/**
 * Test-Suite: jede Top-Level-Route ist waehrend eines Restores gedeckt (#1531).
 *
 * Solange `restoreFromFile()` die Verbindung zu hat, beantwortet das Gate
 * (server/middleware/restore-gate.js) alle Anfragen mit 503, deren Pfad
 * `needsDatabase()` kennt. Die Funktion kennt die Praefixe, die es heute gibt.
 * Eine neue Top-Level-Route ausserhalb davon, die die Datenbank liest, scheitert
 * mitten im Restore mit 500 - und kein Test merkte es (Folge aus #1441).
 *
 * Gelesen wird der Router-Stack der ECHTEN App, nicht der Quelltext von
 * server/index.js. Express 5 legt den Mount-Pfad eines `app.use()` nicht am
 * Layer ab; deshalb schreibt die Suite ihn vor dem Import mit (`app.use` und
 * `app.route` am Prototyp), Layer fuer Layer.
 *
 * Allowlist, keine Denylist: jede Route, die weder `needsDatabase()` deckt noch
 * hier mit Begruendung steht, macht die Suite rot - ebenso ein Eintrag, den es
 * in der App nicht mehr gibt, und eine globale Middleware ohne Eintrag.
 *
 * Der zweite Teil misst dieselbe Liste am laufenden Server: Restore angehalten,
 * Verbindung zu, jede Route einmal abgefragt (mit Bearer-Kopf, der jeden
 * Token-Lookup ausloest). Gedeckte Routen bekommen 503, die Allowlist-Routen
 * antworten ohne 5xx - die Begruendung in der Liste ist damit gemessen, nicht
 * behauptet.
 *
 * Lauf: npm run test:restore-gate-routes
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';
import { join } from 'node:path';
import express from 'express';
import { startTestServer } from './server-ready.js';
import { tempDir } from './tmp-dir.js';
import { needsDatabase } from '../server/middleware/restore-gate.js';

/**
 * Routen, die waehrend eines Restores ohne Datenbank antworten. Schluessel ist
 * der Pfad, wie er in server/index.js registriert ist.
 */
const ROUTE_ALLOWLIST = new Map([
  ['/sw.js', 'Service Worker aus Datei und Release-Stand, keine Datenbank'],
  ['/manifest.webmanifest', 'liest `sync_config.app_name`, faellt bei geschlossener Verbindung im catch auf den Standardnamen zurueck'],
  ['/health', 'Container-Healthcheck, antwortet ohne Datenbank (ein 503 dort liesse Docker den Container waehrend des Restores neu starten)'],
  ['/{*path}', 'SPA-Fallback, liefert index.html aus public/'],
]);

/**
 * Globale Middleware (Mount-Pfad `/`), nach Funktionsname. Sie laeuft fuer
 * JEDE Anfrage, also auch vor dem Gate oder an ihm vorbei.
 */
const GLOBAL_MIDDLEWARE_ALLOWLIST = new Map([
  ['helmetMiddleware', 'Sicherheitskoepfe, keine Datenbank'],
  ['compression', 'Antwortkompression, keine Datenbank'],
  ['restoreWriteGate', 'das Gate selbst'],
  ['jsonParser', 'Body-Parser, keine Datenbank'],
  ['urlencodedParser', 'Body-Parser, keine Datenbank'],
  ['bodyParseErrorHandler', 'wandelt Parse-Fehler in 400/413, keine Datenbank'],
  ['sessionMiddleware', 'Store liefert bei geschlossener Verbindung keine Sitzung (`get`) und setzt `touch`/`set` aus (server/auth.js, #1431)'],
  ['serveStatic', 'statische Dateien aus public/'],
  ['serveCompressedStatic', 'dieselben Dateien aus public/ als Brotli-Fassung aus dem Speicher (R18), keine Datenbank'],
  ['staticStoreLimiter', 'Bremse je Absender vor dem Brotli-Speicher, Zaehler im Prozess, keine Datenbank; ueber der Grenze kein 429, nur am Speicher vorbei'],
  ['errorHandler', 'globaler Fehlerbehandler, keine Datenbank'],
]);

// Mount-Pfade mitschreiben, bevor server/index.js die App baut.
const mountPaths = new WeakMap();
const originalUse = express.application.use;
express.application.use = function recordingUse(...args) {
  const before = this.router.stack.length;
  const result = originalUse.apply(this, args);
  // Ohne Pfadargument haengt `app.use(fn)` an `/`.
  const mountPath = typeof args[0] === 'function' ? '/' : args[0];
  for (const layer of this.router.stack.slice(before)) mountPaths.set(layer, mountPath);
  return result;
};

const { baseUrl: BASE, app } = await startTestServer({
  name: 'restore-gate-routes',
  env: { SESSION_SECRET: 'test-restore-gate-routes-secret-min-32-chars' },
});
express.application.use = originalUse;
const dbmod = await import('../server/db.js');

/**
 * Jeder Layer der App als `{ kind, paths, name }`. Ein Layer ohne
 * mitgeschriebenen Pfad ist selbst ein Befund: dann kam er an `app.use` vorbei.
 */
function topLevelLayers() {
  return app.router.stack.map((layer) => {
    if (layer.route) {
      const paths = [layer.route.path].flat();
      return { kind: 'route', paths, name: layer.name };
    }
    const mountPath = mountPaths.get(layer);
    return { kind: 'use', paths: mountPath === undefined ? [] : [mountPath].flat(), name: layer.name };
  });
}

function isGlobal(entry) {
  return entry.kind === 'use' && entry.paths.length === 1 && entry.paths[0] === '/';
}

test('#1531 der Router-Stack wird gelesen, nicht leer', () => {
  const layers = topLevelLayers();
  // Ohne Mitschrift waeren alle use-Layer pfadlos und die Pruefung unten leer.
  assert.ok(layers.some((l) => l.kind === 'route'), 'keine Route im Stack gefunden');
  assert.ok(layers.some((l) => l.kind === 'use' && l.paths[0] === '/api/v1/backup'), 'Mount-Pfade nicht mitgeschrieben');
  const unrecorded = layers.filter((l) => l.kind === 'use' && l.paths.length === 0);
  assert.deepEqual(unrecorded, [], 'Layer ohne bekannten Mount-Pfad');
});

test('#1531 jede Top-Level-Route ist von needsDatabase() gedeckt oder begruendet freigestellt', () => {
  const uncovered = [];
  for (const entry of topLevelLayers()) {
    if (isGlobal(entry)) continue;
    for (const path of entry.paths) {
      if (typeof path !== 'string') {
        uncovered.push(`${entry.kind} ${String(path)} (kein String-Pfad, nicht pruefbar)`);
        continue;
      }
      if (needsDatabase(path) || ROUTE_ALLOWLIST.has(path)) continue;
      uncovered.push(`${entry.kind} ${path}`);
    }
  }
  assert.deepEqual(uncovered, [],
    'Diese Routen bekommen waehrend eines Restores kein 503: in needsDatabase() '
    + '(server/middleware/restore-gate.js) aufnehmen oder mit Begruendung in ROUTE_ALLOWLIST');
});

test('#1531 jede globale Middleware steht mit Begruendung in der Allowlist', () => {
  const unknown = topLevelLayers()
    .filter(isGlobal)
    .map((entry) => entry.name)
    .filter((name) => !GLOBAL_MIDDLEWARE_ALLOWLIST.has(name));
  assert.deepEqual(unknown, [], 'globale Middleware ohne Eintrag (anonyme Funktionen einen Namen geben)');
});

test('#1531 jeder Allowlist-Eintrag gibt es in der App noch', () => {
  const layers = topLevelLayers();
  const routePaths = new Set(layers.filter((l) => !isGlobal(l)).flatMap((l) => l.paths));
  const globalNames = new Set(layers.filter(isGlobal).map((l) => l.name));
  const stale = [
    ...[...ROUTE_ALLOWLIST.keys()].filter((p) => !routePaths.has(p)),
    ...[...GLOBAL_MIDDLEWARE_ALLOWLIST.keys()].filter((n) => !globalNames.has(n)),
  ];
  assert.deepEqual(stale, [], 'veraltete Allowlist-Eintraege');
});

/** Ein Muster aus dem Router in eine abfragbare URL uebersetzen. */
function concretePath(pattern) {
  return pattern
    .replace(/\{\*\w+\}/g, 'restore-gate-probe')
    .replace(/:(\w+)/g, 'x');
}

/**
 * Einen Restore starten und dort anhalten, wo die Verbindung zu ist (beim
 * Anlegen der Rollback-Kopie) - wie in test/test-restore-server.js.
 */
async function restoreHeldWithDatabaseClosed() {
  const backupPath = join(tempDir('yuvomi-test-restore-gate-routes-'), 'backup.db');
  await dbmod.backupToFile(backupPath);
  const holdAt = dbmod.getPath();
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  let reached;
  const copying = new Promise((resolve) => { reached = resolve; });
  const realCopyFile = fsp.copyFile;
  fsp.copyFile = async (src, dest, mode) => {
    if (String(src) === holdAt) {
      reached();
      await gate;
    }
    return realCopyFile(src, dest, mode);
  };
  const done = dbmod.restoreFromFile(backupPath).finally(() => { fsp.copyFile = realCopyFile; });
  await copying;
  assert.equal(dbmod.isRestoreRunning(), true, 'Vorbedingung: der Restore laeuft');
  assert.equal(dbmod.isDatabaseOpen(), false, 'Vorbedingung: die Verbindung ist zu');
  return { release, done };
}

test('#1531 bei geschlossener Verbindung: gedeckte Routen 503, freigestellte ohne 5xx', async () => {
  const probes = [];
  for (const entry of topLevelLayers()) {
    if (isGlobal(entry)) continue;
    for (const path of entry.paths) {
      const url = concretePath(path);
      // Express 5 nimmt einen angehaengten Schraegstrich mehr noch als dieselbe
      // Route (`/docs/` trifft auch `/docs//`) - das Gate muss dieselbe
      // Schreibweise sehen wie der Router (Review #1537).
      for (const variant of [url, `${url}/`]) {
        probes.push({ path, url: variant, covered: needsDatabase(path) });
      }
    }
  }
  const restore = await restoreHeldWithDatabaseClosed();
  const wrong = [];
  try {
    for (const probe of probes) {
      const res = await fetch(`${BASE}${probe.url}`, {
        // Ein Bearer-Kopf loest in `requireAuth` den Token-Lookup aus - ohne
        // ihn antworteten angemeldete Routen mit 401, ohne die Datenbank zu fragen.
        headers: { Authorization: 'Bearer restore-gate-probe', Accept: 'application/json' },
        redirect: 'manual',
      });
      await res.arrayBuffer();
      if (probe.covered ? res.status !== 503 : res.status >= 500) {
        wrong.push(`GET ${probe.url} (${probe.path}): ${res.status}`);
      }
    }
  } finally {
    restore.release();
    await restore.done;
  }
  assert.deepEqual(wrong, [], 'gedeckt heisst 503, freigestellt heisst ohne 5xx');
});

