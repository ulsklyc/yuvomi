/**
 * Test: sendFile unter Dot-Pfaden (SPA-Fallback + Modul-Assets)
 * Zweck: `res.sendFile(<absoluter Pfad>)` ohne root-Option laesst `send` JEDES
 *        Segment des absoluten Pfads auf Dotfiles pruefen (Default
 *        dotfiles:'ignore' → NotFoundError → globaler Error-Handler → 500).
 *        Liegt der Checkout bzw. MODULES_DIR unter einem Dot-Verzeichnis
 *        (z. B. ~/.claude/worktrees/...), liefert damit jede Deep-URL des
 *        SPA-Fallbacks und jedes Modul-Asset HTTP 500. Mit root-Option prueft
 *        `send` nur den RELATIVEN Teil - genau darauf stuetzen sich die Fixes
 *        in server/index.js (SPA-Fallback) und server/routes/modules.js.
 *
 *        Der Test baut die Bug-Bedingung selbst (Temp-Ordner mit Dot-Segment)
 *        und ist damit unabhaengig davon, wo der Checkout des Testlaufs liegt:
 *          - Modul-Assets: ECHTER Router mit MODULES_DIR unter dem Dot-Pfad
 *            (vor dem Fix: 500, mit Fix: 200) - der eigentliche Regressionstest.
 *          - SPA-Fallback: Replika der Handler-Form aus server/index.js (die
 *            Route dort ist nicht isoliert importierbar, index.js startet beim
 *            Import den Listener samt Schedulern).
 *          - Gegenprobe: dieselbe Route in der ALTEN Form (absoluter Pfad) muss
 *            unter dem Dot-Pfad im Error-Handler landen. Wird DIESER Test rot,
 *            hat sich das send-Verhalten geaendert, auf dem der Fix beruht.
 * Ausführen: node --experimental-sqlite --test test/test-sendfile-dotpath.js
 */

import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';

// ── Temp-Umgebung MIT Dot-Segment VOR den dynamischen Imports einrichten ─────────
const TMP_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'yuvomi-dotpath-'));
const DOT_ROOT = path.join(TMP_ROOT, '.dot-checkout'); // die Bug-Bedingung
const MODULES_DIR = path.join(DOT_ROOT, 'modules');
const PUBLIC_DIR = path.join(DOT_ROOT, 'public');

fs.mkdirSync(path.join(MODULES_DIR, 'alpha-mod'), { recursive: true });
fs.mkdirSync(PUBLIC_DIR, { recursive: true });
fs.writeFileSync(path.join(MODULES_DIR, 'alpha-mod', 'module.json'),
  JSON.stringify({ id: 'alpha-mod', name: 'Alpha', entry: 'index.js' }));
fs.writeFileSync(path.join(MODULES_DIR, 'alpha-mod', 'index.js'), 'export default {};\n');
fs.writeFileSync(path.join(PUBLIC_DIR, 'index.html'), '<!DOCTYPE html><html><body>spa-shell</body></html>\n');

process.env.SESSION_SECRET = process.env.SESSION_SECRET || 'test-secret';
process.env.DB_PATH = ':memory:';
process.env.MODULES_DIR = MODULES_DIR; // wird beim Modul-Load als const gelesen

import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';

const { default: modulesRouter } = await import('../server/routes/modules.js');

// ── App: echter Modul-Router + SPA-Fallback-Formen + Error-Handler wie prod ──────
let actor = { id: 1, role: 'member' };
const app = express();
app.use((req, _res, next) => {
  req.authUserId = actor.id;
  req.authRole = actor.role;
  req.session = { userId: actor.id, role: actor.role };
  next();
});
app.use('/api/v1/modules', modulesRouter);

// Gegenprobe: die ALTE Handler-Form (absoluter Pfad, keine root-Option). Muss VOR
// dem Catch-all stehen, sonst frisst der die Route.
app.get('/legacy-spa', (_req, res) => {
  res.sendFile(path.join(PUBLIC_DIR, 'index.html'));
});

// SPA-Fallback in exakt der gefixten Form aus server/index.js.
app.get('/{*path}', (req, res) => {
  if (req.path.startsWith('/api/')) {
    return res.status(404).json({ error: 'Not found.', code: 404 });
  }
  res.sendFile('index.html', { root: PUBLIC_DIR });
});

// Globaler Error-Handler wie in server/index.js - dort wird aus dem
// weitergereichten send-Fehler das beobachtete 500.
app.use((_err, _req, res, _next) => {
  res.status(500).json({ error: 'Internal server error.', code: 500 });
});

const server = app.listen(0, '127.0.0.1');
const baseUrl = await new Promise((r) => server.on('listening', () => r(`http://127.0.0.1:${server.address().port}`)));

test.after(() => {
  server.close();
  try { fs.rmSync(TMP_ROOT, { recursive: true, force: true }); } catch { /* best effort */ }
});

async function get(route) {
  const res = await fetch(`${baseUrl}${route}`);
  return { status: res.status, text: await res.text(), contentType: res.headers.get('content-type') || '' };
}

// ── Regressionstest: Modul-Asset ueber den ECHTEN Router unter dem Dot-Pfad ──────
test('GET /api/v1/modules/assets: liefert 200, auch wenn MODULES_DIR unter einem Dot-Pfad liegt', async () => {
  const r = await get('/api/v1/modules/assets/alpha-mod/index.js');
  assert.equal(r.status, 200, 'Dot-Segment im Basispfad darf kein 500 ausloesen');
  assert.match(r.contentType, /text\/javascript/);
  assert.equal(r.text, 'export default {};\n');
});

// ── SPA-Fallback (gefixte Form): Deep-URL liefert die Shell ──────────────────────
test('SPA-Fallback mit root-Option: Deep-URL liefert index.html unter dem Dot-Pfad', async () => {
  const r = await get('/calendar');
  assert.equal(r.status, 200);
  assert.match(r.text, /spa-shell/);
});

// ── Gegenprobe: die alte Form scheitert unter dem Dot-Pfad wirklich ──────────────
test('Gegenprobe: sendFile mit absolutem Dot-Pfad landet im Error-Handler (500)', async () => {
  const r = await get('/legacy-spa');
  assert.equal(r.status, 500,
    'Erwartet: send lehnt Dot-Segmente im absoluten Pfad ab. Wird das hier rot, hat sich das send-Verhalten geaendert und die root-Fixes gehoeren neu bewertet.');
});
