import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync, readdirSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  commandAvailable, checkPrereqs, spawnStart, createInstallerServer,
  detectEngine, composeCommand, inspectCommand, safeSpawn,
} from '../tools/installer/install-server.js';

const REPO_ROOT = fileURLToPath(new URL('../', import.meta.url));

// ── commandAvailable ──────────────────────────────────────────────────────────

test('commandAvailable meldet false für ein nicht existierendes Kommando', async () => {
  assert.equal(await commandAvailable('definitely-not-a-real-binary-xyz', ['--version']), false);
});

test('commandAvailable meldet true für ein vorhandenes Kommando (node)', async () => {
  assert.equal(await commandAvailable('node', ['--version']), true);
});

// ── checkPrereqs (injizierbarer Probe-Callback, deterministisch) ───────────────

test('checkPrereqs meldet fehlendes docker als ok:false mit missing-Liste', async () => {
  const r = await checkPrereqs(async () => false);
  assert.equal(r.ok, false);
  assert.ok(Array.isArray(r.missing));
  assert.ok(r.missing.includes('docker'), 'missing enthält "docker" nicht');
});

test('checkPrereqs meldet ok:true mit leerer missing-Liste, wenn alles vorhanden ist', async () => {
  const r = await checkPrereqs(async () => true);
  assert.equal(r.ok, true);
  assert.deepEqual(r.missing, []);
});

// ── spawnStart (Spawn-Fehler an Aufrufer melden) ───────────────────────────────

test('spawnStart meldet ok:false bei Spawn-Fehler (unbekanntes Kommando)', async () => {
  const r = await spawnStart('definitely-not-a-real-binary-xyz', []);
  assert.equal(r.ok, false);
  assert.ok(r.error, 'Spawn-Fehler liefert keine error-Meldung');
});

test('spawnStart meldet ok:true, wenn der Prozess erfolgreich startet', async () => {
  const r = await spawnStart('node', ['-e', '']);
  assert.equal(r.ok, true);
});

// ── detectEngine (Docker bevorzugt, Podman-Fallback) ───────────────────────────

// Baut einen injizierbaren check(cmd, args), der nur für die in `present`
// gelisteten "cmd args"-Kombinationen true liefert.
function checkFor(present) {
  const set = new Set(present);
  return async (cmd, args = []) => set.has([cmd, ...args].join(' '));
}

test('detectEngine wählt docker, wenn docker + compose v2 vorhanden sind', async () => {
  const e = await detectEngine(checkFor(['docker --version', 'docker compose version']));
  assert.equal(e.engine, 'docker');
  assert.equal(e.composeBin, 'docker');
  assert.deepEqual(e.compose, ['compose']);
  assert.deepEqual(e.missing, []);
});

test('detectEngine fällt auf "podman compose" zurück, wenn docker fehlt', async () => {
  const e = await detectEngine(checkFor(['podman --version', 'podman compose version']));
  assert.equal(e.engine, 'podman');
  assert.equal(e.composeBin, 'podman');
  assert.deepEqual(e.compose, ['compose', '-f', 'podman-compose.yml']);
  assert.deepEqual(e.missing, []);
});

test('detectEngine nutzt podman-compose, wenn "podman compose" fehlt', async () => {
  const e = await detectEngine(checkFor(['podman --version', 'podman-compose --version']));
  assert.equal(e.engine, 'podman');
  assert.equal(e.composeBin, 'podman-compose');
  assert.deepEqual(e.compose, ['-f', 'podman-compose.yml']);
  assert.deepEqual(e.missing, []);
});

test('detectEngine meldet engine:null, wenn weder docker noch podman da sind', async () => {
  const e = await detectEngine(async () => false);
  assert.equal(e.engine, null);
  assert.ok(e.missing.includes('docker'));
  assert.ok(e.missing.includes('podman'));
});

test('detectEngine meldet fehlendes compose, wenn nur podman (ohne compose) da ist', async () => {
  const e = await detectEngine(checkFor(['podman --version']));
  assert.equal(e.engine, null);
  assert.ok(e.missing.some(m => /compose/.test(m)), 'missing nennt kein fehlendes compose');
});

// ── composeCommand / inspectCommand (Engine-aware Spawn-Argumente) ──────────────

test('composeCommand baut den richtigen Befehl je Engine', async () => {
  const docker = await detectEngine(checkFor(['docker --version', 'docker compose version']));
  assert.deepEqual(composeCommand(docker, ['up', '-d']),
    { cmd: 'docker', args: ['compose', 'up', '-d'] });

  const podman = await detectEngine(checkFor(['podman --version', 'podman compose version']));
  assert.deepEqual(composeCommand(podman, ['up', '-d']),
    { cmd: 'podman', args: ['compose', '-f', 'podman-compose.yml', 'up', '-d'] });

  const pc = await detectEngine(checkFor(['podman --version', 'podman-compose --version']));
  assert.deepEqual(composeCommand(pc, ['logs', '--tail', '30']),
    { cmd: 'podman-compose', args: ['-f', 'podman-compose.yml', 'logs', '--tail', '30'] });
});

test('inspectCommand nutzt das passende Binary (podman auch bei podman-compose)', async () => {
  const pc = await detectEngine(checkFor(['podman --version', 'podman-compose --version']));
  assert.deepEqual(inspectCommand(pc, ['inspect', 'yuvomi']),
    { cmd: 'podman', args: ['inspect', 'yuvomi'] });

  const docker = await detectEngine(checkFor(['docker --version', 'docker compose version']));
  assert.deepEqual(inspectCommand(docker, ['inspect', 'yuvomi']),
    { cmd: 'docker', args: ['inspect', 'yuvomi'] });
});

// ── checkPrereqs liefert den Engine-Deskriptor mit ─────────────────────────────

test('checkPrereqs gibt engine-Deskriptor zurück (podman-Fallback)', async () => {
  const r = await checkPrereqs(checkFor(['podman --version', 'podman compose version']));
  assert.equal(r.ok, true);
  assert.equal(r.engine.engine, 'podman');
});

// ── Statische Artefakte: podman-compose.yml, Quadlet, install.sh ────────────────

test('podman-compose.yml trägt :Z-Labels, OIKOS_HTTP_BIND und SESSION_SECURE-Default', () => {
  const src = readFileSync(new URL('../podman-compose.yml', import.meta.url), 'utf8');
  assert.match(src, /\/data:Z/, 'kein :Z-Label auf dem /data-Mount');
  assert.match(src, /\$\{OIKOS_HTTP_BIND:-0\.0\.0\.0\}/, 'kein konfigurierbares Host-Binding');
  assert.match(src, /SESSION_SECURE=\$\{SESSION_SECURE:-false\}/, 'kein SESSION_SECURE-Default');
});

test('Quadlet-Unit existiert mit :Z-Volume und EnvironmentFile', () => {
  const src = readFileSync(new URL('../tools/quadlet/oikos.container', import.meta.url), 'utf8');
  assert.match(src, /\[Container\]/, 'keine [Container]-Sektion');
  assert.match(src, /EnvironmentFile=/, 'kein EnvironmentFile');
  assert.match(src, /:Z\b/, 'kein :Z-SELinux-Label');
  assert.match(src, /WantedBy=default\.target/, 'kein [Install]-Autostart-Target');
});

test('install.sh enthält den Podman-Fallback', () => {
  const src = readFileSync(new URL('../install.sh', import.meta.url), 'utf8');
  assert.match(src, /podman compose/, 'install.sh kennt "podman compose" nicht');
  assert.match(src, /podman-compose/, 'install.sh kennt "podman-compose" nicht');
});

// ── HTTP-Route /api/prereqs ────────────────────────────────────────────────────

async function withServer(fn) {
  const prev = process.env.OIKOS_INSTALLER_ROOT;
  process.env.OIKOS_INSTALLER_ROOT = REPO_ROOT;
  const server = createInstallerServer();
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const { port } = server.address();
  try {
    await fn(`http://127.0.0.1:${port}`);
  } finally {
    await new Promise(r => server.close(r));
    if (prev === undefined) delete process.env.OIKOS_INSTALLER_ROOT;
    else process.env.OIKOS_INSTALLER_ROOT = prev;
  }
}

test('GET /api/prereqs liefert 200 mit ok-Flag und missing-Array', async () => {
  await withServer(async base => {
    const r = await fetch(`${base}/api/prereqs`);
    assert.equal(r.status, 200);
    const d = await r.json();
    assert.equal(typeof d.ok, 'boolean');
    assert.ok(Array.isArray(d.missing), 'missing ist kein Array');
  });
});

// ── Statische Prüfungen: UI verdrahtet Prereq-Check und Start-Fehler ───────────

test('install.html ruft /api/prereqs auf und behandelt Start-Fehler', () => {
  const src = readFileSync(new URL('../tools/installer/install.html', import.meta.url), 'utf8');
  assert.match(src, /\/api\/prereqs/, 'install.html ruft /api/prereqs nicht auf');
  assert.match(src, /id="cfg-prereq"/, 'install.html hat kein Prereq-Banner cfg-prereq');
});

test('install.html enthält den Erweitert-Step mit Reverse-Proxy-, OIDC- und Backup-Feldern', () => {
  const src = readFileSync(new URL('../tools/installer/install.html', import.meta.url), 'utf8');
  assert.match(src, /id="step-advanced"/, 'kein Erweitert-Step (step-advanced)');
  assert.match(src, /id="adv-proxy"/, 'keine Reverse-Proxy-Auswahl (adv-proxy)');
  assert.match(src, /id="oidc-issuer"/, 'kein OIDC-Issuer-Feld');
  assert.match(src, /id="adv-backup-enable"/, 'kein Backup-Aktivieren-Feld');
});

// ── Reverse-Proxy: SESSION_SECURE wirkt zur Laufzeit ───────────────────────────

test('docker-compose.yml leitet SESSION_SECURE aus der .env ab (Default false)', () => {
  const src = readFileSync(new URL('../docker-compose.yml', import.meta.url), 'utf8');
  assert.match(src, /SESSION_SECURE=\$\{SESSION_SECURE:-false\}/,
    'compose nutzt nicht ${SESSION_SECURE:-false} (env_file darf nicht hart überstimmt werden)');
  assert.doesNotMatch(src, /^\s*-\s*SESSION_SECURE=false\s*$/m,
    'hartkodiertes SESSION_SECURE=false darf nicht mehr im environment-Block stehen');
});

// ── env_file bleibt in der Kurzform (Compose-Kompatibilität, Issue #765) ──────
//
// Die Langform (`- path: .env` / `required: false`) gibt es erst ab Compose
// v2.24. Ältere Engines - Synology DSM, QNAP, Distro-Pakete - lehnen das
// Manifest mit "services.<name>.env_file.0 must be a string" ab, also noch
// bevor irgendetwas startet. Die Regel gilt für jedes Compose-Manifest im
// Repo, nicht für eine Liste bekannter Dateien: eine neue Datei mit derselben
// Falle wäre sonst unbewacht.

function composeManifests(dir, out = []) {
  const SKIP = new Set(['node_modules', '.git', '.claude', '.agents', 'coverage', 'data', 'backups']);
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name.startsWith('.') && entry.name !== '.github') continue;
    if (SKIP.has(entry.name)) continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) { composeManifests(full, out); continue; }
    if (!/\.ya?ml$/.test(entry.name)) continue;
    const src = readFileSync(full, 'utf8');
    if (/^services:/m.test(src)) out.push({ path: relative(REPO_ROOT, full), src });
  }
  return out;
}

// Sammelt die Eintragszeilen jedes env_file-Blocks (ohne Kommentare/Leerzeilen).
function envFileEntries(src) {
  const lines = src.split('\n');
  const entries = [];
  for (let i = 0; i < lines.length; i++) {
    const head = /^(\s*)env_file:\s*(\S.*)?$/.exec(lines[i]);
    if (!head) continue;
    const indent = head[1].length;
    if (head[2]) { entries.push({ line: i + 1, text: head[2].trim() }); continue; }
    for (let j = i + 1; j < lines.length; j++) {
      const line = lines[j];
      if (!line.trim() || /^\s*#/.test(line)) continue;
      const lead = line.length - line.trimStart().length;
      if (lead <= indent) break;
      entries.push({ line: j + 1, text: line.trim() });
    }
  }
  return entries;
}

test('kein Compose-Manifest nutzt die env_file-Langform (Compose <2.24 lehnt sie ab)', () => {
  const manifests = composeManifests(REPO_ROOT);
  assert.ok(manifests.length >= 2,
    `zu wenige Compose-Manifeste gefunden (${manifests.length}) - die Suche greift nicht mehr`);

  const withEnvFile = manifests.filter(m => envFileEntries(m.src).length > 0);
  assert.ok(withEnvFile.length >= 1,
    'kein einziger env_file-Block gefunden - der Guard prüft eine leere Liste');

  for (const { path, src } of withEnvFile) {
    for (const { line, text } of envFileEntries(src)) {
      // Ein Eintrag muss ein reiner String sein: "- .env". Alles mit einem
      // Schlüssel darin ("- path: .env", "required: false") ist die Langform.
      // Geprüft wird der Schlüssel, nicht der Listenstrich: `env_file: .env`
      // ohne Liste ist gültige Kurzform und darf nicht anschlagen.
      assert.doesNotMatch(text, /^-?\s*\w[\w-]*:/,
        `${path}:${line} nutzt die env_file-Langform (${text}) - siehe Issue #765`);
    }
  }
});

test('install.html setzt im Reverse-Proxy-Pfad SESSION_SECURE=true', () => {
  const src = readFileSync(new URL('../tools/installer/install.html', import.meta.url), 'utf8');
  assert.match(src, /S\.SESSION_SECURE\s*=\s*'true'/,
    'Proxy-Pfad schreibt SESSION_SECURE nicht auf true');
});

// ── env-schema deckt die neuen Settings ab ─────────────────────────────────────

test('env-schema enthält die neuen P5-Settings als writeToEnv', async () => {
  const { ENV_SCHEMA } = await import('../tools/installer/env-schema.js');
  const writable = new Set(ENV_SCHEMA.filter(e => e.writeToEnv).map(e => e.key));
  for (const key of [
    'SESSION_SECURE', 'TRUST_PROXY', 'APPLE_CALDAV_URL',
    'OIDC_ISSUER', 'OIDC_CLIENT_ID', 'OIDC_CLIENT_SECRET', 'OIDC_REDIRECT_URI',
    'BACKUP_ENABLED', 'BACKUP_SCHEDULE', 'BACKUP_KEEP',
  ]) {
    assert.ok(writable.has(key), `env-schema fehlt writeToEnv-Key ${key}`);
  }
});

// ── Ohne Container-Engine darf der Installer nicht sterben ────────────────────
//
// Ein GET auf /api/status beendete den Serverprozess, wenn weder Docker noch
// Podman vorhanden waren: composeCommand() liefert dann `cmd: null`, und
// spawn(null) wirft SYNCHRON. Der Wurf lag in einem Kind-Prozess-Callback,
// also ausserhalb jedes try/catch. Betroffen war genau die Gruppe, der die UI
// sagt "installiere sie und lade die Seite neu" - das Neuladen schlug dann fehl.

test('composeCommand liefert ohne Engine cmd: null (die Vorbedingung des Absturzes)', () => {
  const keine = { engine: null, composeBin: null, compose: null, missing: ['docker', 'podman'] };
  assert.equal(composeCommand(keine, ['logs']).cmd, null,
    'Vorbedingung geändert: dann gehört dieser Guard nachgezogen');
});

test('safeSpawn wirft nicht bei cmd null, sondern meldet den Fehler asynchron', async () => {
  const kind = safeSpawn(null, ['logs'], { stdio: 'pipe' });   // würde als spawn() werfen
  const fehler = await new Promise((resolve, reject) => {
    kind.on('error', resolve);
    setTimeout(() => reject(new Error('kein error-Event binnen 500ms')), 500);
  });
  assert.ok(fehler instanceof Error, 'error-Event trägt kein Error-Objekt');
});

test('GET /api/status beendet den Server nicht und antwortet danach weiter', async () => {
  await withServer(async base => {
    const r = await fetch(`${base}/api/status`);
    assert.equal(r.status, 200);
    const d = await r.json();
    assert.ok(['running', 'starting', 'error'].includes(d.status), `unerwarteter Status ${d.status}`);

    // Der eigentliche Befund: der Prozess muss den Aufruf überleben. Deshalb
    // ein zweiter Request - er erreichte den toten Server vorher nicht mehr.
    const danach = await fetch(`${base}/api/prereqs`);
    assert.equal(danach.status, 200, 'Server hat den Statusaufruf nicht überlebt');
  });
});

test('GET /api/status weist einen fremden Origin ab (nicht nur POSTs)', async () => {
  await withServer(async base => {
    const r = await fetch(`${base}/api/status`, { headers: { Origin: 'https://evil.example' } });
    assert.equal(r.status, 403, 'lesende API-Routen brauchen denselben Loopback-Guard wie POSTs');
  });
});

test('die statische Auslieferung bleibt ohne Origin erreichbar', async () => {
  await withServer(async base => {
    assert.equal((await fetch(`${base}/`)).status, 200, 'der Guard darf die Seite selbst nicht sperren');
  });
});

// ── Das Überschreiben der .env ist auf JEDEM Pfad bestätigungspflichtig ───────
//
// Der Erweitert-Pfad verlangte zwei Klicks, der Einfach-Pfad einen - und der
// Einfach-Pfad rendert step-config nie, sah die Warnung über eine bestehende
// .env also überhaupt nicht. Damit hatte ausgerechnet der Laien-Pfad weniger
// Netz bei der einzigen irreversiblen Aktion des Wizards.
//
// Als Regel formuliert, nicht als Liste der beiden heutigen Buttons: ein
// dritter Schreibpfad fällt damit beim Hinzufügen auf, nicht erst im Critique.

test('jeder Pfad, der die .env schreibt, verlangt vorher eine Bestätigung', () => {
  const src = readFileSync(new URL('../tools/installer/install.html', import.meta.url), 'utf8');
  const schreibstellen = [...src.matchAll(/fetch\('\/api\/save-env'/g)].map(m => m.index);
  assert.ok(schreibstellen.length >= 2,
    `erwartet mindestens zwei Schreibpfade (einfach + erweitert), gefunden ${schreibstellen.length}`);

  for (const idx of schreibstellen) {
    const handler = src.slice(Math.max(0, idx - 1500), idx);
    assert.match(handler, /if \(!\w*[Cc]onfirmed\)/,
      'ein Pfad schreibt die .env ohne vorherige Zwei-Klick-Bestätigung');
  }
});

test('der Erweitert-Pfad zeigt die Warnung über eine bestehende .env', () => {
  // Nur noch dort: mit bestehender .env ist der Einfach-Pfad gesperrt und lenkt
  // in den Erweitert-Pfad um (test-installer-env-write.js), ein eigener Banner
  // im Einfach-Schritt wäre nie zu sehen.
  const src = readFileSync(new URL('../tools/installer/install.html', import.meta.url), 'utf8');
  // Als Warnung, nicht als Hinweis: der Speichern-Schritt ersetzt die
  // bestehende Konfiguration, auch wenn er sie vorher sichert. Der Text sitzt
  // im inneren span, weil die Übersetzung textContent setzt und ein Icon
  // direkt im Banner sonst beim ersten Sprachwechsel verschwände.
  const banner = src.match(/<div class="([^"]*)" id="cfg-existing"[^>]*>([\s\S]*?)<\/div>/);
  assert.ok(banner, 'cfg-existing fehlt im Markup');
  assert.match(banner[1], /\bwarn-banner\b/, 'cfg-existing ist nicht als Warnung eingefärbt');
  assert.match(banner[2], /class="warn-icon"/, 'cfg-existing trägt kein Warn-Icon');
  assert.match(banner[2], /<span data-i18n="config\.existing">/,
    'cfg-existing trägt den falschen i18n-Schlüssel, oder er sitzt nicht im inneren span');
  // Ein Banner, das der Preflight nie einblendet, ist so gut wie keins - und
  // .warn-banner ist ein Flex-Container: mit display 'block' fiele das Icon
  // aus der Zeile.
  const preflight = src.slice(src.indexOf('d.envExists'), src.indexOf('d.envExists') + 300);
  assert.ok(preflight.includes("$('cfg-existing').style.display = 'flex'"),
    'cfg-existing wird bei envExists nicht als Flex-Banner eingeblendet');
});

// ── Der Wartebildschirm: eine Phase ist kein Fehlschlag ───────────────────────
//
// `spawnStart` löst beim 'spawn'-Event auf, nicht am Ende von `compose up -d`.
// Der Wizard pollt also, während das Image noch geladen wird - und in dieser
// Zeit gibt es den Container noch gar nicht. Eine leere Inspect-Ausgabe wurde
// als Fehlschlag gemeldet: bei jeder Erstinstallation über einer langsamen
// Leitung stand „Container konnte nicht gestartet werden" auf dem Schirm,
// während alles normal lief.

import {
  classifyContainerState, classifyHealth, getStartLog, resetStartLog,
} from '../tools/installer/install-server.js';

test('ein noch nicht existierender Container ist die Pull-Phase, kein Fehler', () => {
  const v = classifyContainerState('');
  assert.equal(v.status, 'starting', 'leere Inspect-Ausgabe heisst „gibt es noch nicht", nicht „kaputt"');
  assert.equal(v.phase, 'pull');
});

test('Durchgangszustände sind kein Fehler, nur exited und dead sind endgültig', () => {
  for (const state of ['created', 'restarting', 'paused', 'running']) {
    assert.equal(classifyContainerState(state).status, 'starting',
      `${state} ist eine Durchgangsstation und darf die Installation nicht abbrechen`);
  }
  for (const state of ['exited', 'dead']) {
    assert.equal(classifyContainerState(state).status, 'error', `${state} muss als Fehler gelten`);
  }
});

test('der Health-Check entscheidet nur, wenn er eine Aussage trifft', () => {
  assert.deepEqual(classifyHealth(0, 'healthy'), { status: 'running', phase: 'running' });
  assert.equal(classifyHealth(0, 'starting').phase, 'health');
  assert.equal(classifyHealth(0, 'unhealthy').phase, 'health');
  // Container ohne Healthcheck: docker druckt `<no value>` mit Exit 0.
  assert.equal(classifyHealth(0, '<no value>'), null, 'ohne Healthcheck entscheidet der Container-Zustand');
  assert.equal(classifyHealth(1, ''), null, 'fehlgeschlagenes Inspect trifft keine Aussage');
});

/**
 * Startet einen Prozess und wartet, bis er wirklich fertig ist - inklusive der
 * letzten Ausgabe.
 *
 * Vorher warteten diese Tests eine feste Zeitspanne (300 bzw. 200 ms) und hofften,
 * dass der Prozess bis dahin gestartet, geschrieben und beendet war. Unter Last -
 * etwa wenn `npm test` alle Suiten hintereinander fährt - reicht das nicht, und die
 * Suite wurde sporadisch rot. spawnStart meldet das Ende über onExit (am
 * 'close'-Event, also nach dem letzten Chunk); darauf lässt sich exakt warten,
 * statt eine Dauer zu raten.
 *
 * Bleibt der Spawn selbst erfolglos, feuert 'close' nie - dann würde das Warten
 * hängen, deshalb der frühe Ausstieg.
 */
async function spawnUndWarten(cmd, args, onOutput = null) {
  const beendet = Promise.withResolvers();
  const r = await spawnStart(cmd, args, {}, onOutput, code => beendet.resolve(code));
  if (!r.ok) return { ...r, code: null };
  return { ...r, code: await beendet.promise };
}

test('spawnStart reicht die Ausgabe durch, wenn ein Callback übergeben wird', async () => {
  // Das ist die einzige Stelle, an der der Fortschritt des Image-Pulls entsteht:
  // `up -d` läuft detached weiter, während der Wizard pollt.
  let gesammelt = '';
  const r = await spawnUndWarten(
    process.execPath,
    ['-e', 'process.stdout.write("pulling layer 1\\n"); process.stderr.write("warn\\n")'],
    chunk => { gesammelt += chunk; }
  );
  assert.equal(r.ok, true);
  assert.match(gesammelt, /pulling layer 1/, 'stdout muss ankommen');
  assert.match(gesammelt, /warn/, 'stderr muss ebenfalls ankommen');
});

test('ohne Callback bleibt spawnStart bei stdio ignore (unverändertes Verhalten)', async () => {
  const r = await spawnStart(process.execPath, ['-e', 'process.stdout.write("x")']);
  assert.equal(r.ok, true);
});

test('das Startprotokoll ist begrenzt und zurücksetzbar', async () => {
  resetStartLog();
  assert.equal(getStartLog(), '', 'reset muss leeren');
  // Mitwarten statt den Prozess unbeaufsichtigt weiterlaufen zu lassen: sonst
  // schreibt er noch 20000 Zeichen, waehrend die naechsten Tests schon laufen.
  await spawnUndWarten(process.execPath, ['-e', 'process.stdout.write("a".repeat(20000))'], () => {});
  // Der Puffer im Server ist auf 8000 Zeichen gedeckelt; ein hängender Pull
  // darf den Speicher nicht füllen.
  const quelle = readFileSync(new URL('../tools/installer/install-server.js', import.meta.url), 'utf8');
  const limit = quelle.match(/START_LOG_LIMIT = (\d+)/);
  assert.ok(limit && Number(limit[1]) > 0 && Number(limit[1]) <= 100_000,
    'das Startprotokoll braucht eine Obergrenze');
  assert.match(quelle, /startLog = \(startLog \+ chunk\)\.slice\(-START_LOG_LIMIT\)/,
    'der Puffer muss hinten abschneiden, nicht unbegrenzt wachsen');
});

// ── Der Client hängt nicht mehr ewig am Spinner ───────────────────────────────

test('pollDocker verschluckt Fehler nicht mehr dauerhaft', () => {
  // Vorher: `catch { /* keep polling during startup */ }`. Ein toter Server
  // bedeutete einen Spinner, der sich für immer dreht.
  const html = readFileSync(new URL('../tools/installer/install.html', import.meta.url), 'utf8');
  assert.match(html, /MAX_POLL_FAILURES/, 'wiederholte Fehlschläge brauchen eine Obergrenze');
  assert.match(html, /\+\+pollFailures >= MAX_POLL_FAILURES/, 'die Serie muss gezählt und beendet werden');
  assert.match(html, /TIMEOUT_MS/, 'der Wartebildschirm braucht ein Gesamt-Timeout');
  assert.match(html, /elapsed >= TIMEOUT_MS/, 'das Timeout muss auch ausgewertet werden');
});

test('der Wartebildschirm benennt jede Phase, die der Server melden kann', () => {
  // Regel statt Allowlist: meldet der Server eine neue Phase, muss der Client
  // ein Wort dafür haben - sonst bleibt die Statuszeile stumm stehen.
  const server = readFileSync(new URL('../tools/installer/install-server.js', import.meta.url), 'utf8');
  const html = readFileSync(new URL('../tools/installer/install.html', import.meta.url), 'utf8');
  const de = JSON.parse(readFileSync(new URL('../tools/installer/locales/de.json', import.meta.url), 'utf8'));

  const phases = new Set(
    [...server.matchAll(/phase: '(\w+)'/g)].map(m => m[1]).filter(p => p !== 'running' && p !== 'engine')
  );
  assert.ok(phases.size >= 3, `erwartet mindestens drei benennbare Phasen, gefunden: ${[...phases]}`);

  const mapped = html.match(/const PHASE_KEYS = \{([\s\S]*?)\};/);
  assert.ok(mapped, 'PHASE_KEYS in install.html nicht gefunden');
  for (const phase of phases) {
    const entry = mapped[1].match(new RegExp(`${phase}:\\s*'docker\\.(\\w+)'`));
    assert.ok(entry, `der Client kennt kein Wort für die Server-Phase "${phase}"`);
    assert.ok(de.docker[entry[1]], `de.json fehlt docker.${entry[1]} für die Phase "${phase}"`);
  }
});

test('die Dauererwartung und der Ausweg stehen im Markup', () => {
  const html = readFileSync(new URL('../tools/installer/install.html', import.meta.url), 'utf8');
  // Ab Sekunde 0 sichtbar, nicht erst wenn es zu lange dauert.
  assert.match(html, /id="dkr-expect"[^>]*data-i18n="docker\.firstRunHint"/,
    'die Dauererwartung gehört von Anfang an auf den Schirm');
  assert.match(html, /id="dkr-logs-toggle"/, 'nach der Schwelle braucht es „Protokoll anzeigen"');
  assert.match(html, /STALL_AFTER_MS/, 'die Schwelle für den Ausweg fehlt');
  assert.match(html, /elapsed >= STALL_AFTER_MS\) revealDockerEscape\(\)/,
    'die Schwelle muss den Ausweg tatsächlich einblenden');
});

test('ein fehlgeschlagener Start bleibt nicht ewig in der Pull-Phase', async () => {
  // spawnStart loest beim spawn-Event auf, damit der Request nicht auf den
  // Image-Pull wartet. Der Exit-Code war damit niemandes Zustaendigkeit:
  // beendete sich `up -d` danach mit einem Fehler (belegter Port, Image nicht
  // gefunden, fehlende Rechte), sah /api/status nur einen fehlenden Container -
  // und der galt als laufender Pull. Der Wizard drehte bis zum
  // 15-Minuten-Timeout, statt sofort "Erneut versuchen" anzubieten.
  const { classifyContainerState, spawnStart } = await import('../tools/installer/install-server.js');

  // Solange der Start laeuft, bleibt ein fehlender Container der Normalfall.
  assert.deepEqual(classifyContainerState('', null), { status: 'starting', phase: 'pull' });
  assert.deepEqual(classifyContainerState('', 0), { status: 'starting', phase: 'pull' });
  // Ist er mit Fehler beendet, entsteht hier nie mehr ein Container.
  assert.deepEqual(classifyContainerState('', 1), { status: 'error', phase: 'boot' });
  assert.deepEqual(classifyContainerState('', 125), { status: 'error', phase: 'boot' });
  // Ein vorhandener Container gewinnt weiterhin ueber den Exit-Code: `up -d`
  // kann nonzero enden, obwohl der Container laeuft (etwa beim zweiten Aufruf).
  assert.equal(classifyContainerState('running', 1).status, 'starting');
  assert.equal(classifyContainerState('exited', null).status, 'error');

  // Und spawnStart meldet den Exit ueberhaupt weiter. r.code stammt
  // ausschliesslich aus dem onExit-Callback - kommt er nicht an, bleibt er null.
  const r = await spawnUndWarten('sh', ['-c', 'exit 3']);
  assert.equal(r.ok, true, 'der Spawn selbst gelingt');
  assert.equal(r.code, 3, 'der Exit-Code muss den onExit-Callback erreichen');
});

test('ein Retry raeumt das laufende Polling ab, statt ein zweites zu starten', () => {
  // "Erneut versuchen" erscheint schon nach 90 Sekunden Stillstand, also
  // waehrend gepollt wird - nicht erst im Fehlerfall, wo clearInterval laeuft.
  // startDocker() ueberschrieb pollInterval, die alte Timer-ID war verloren,
  // und zwei Timer pollten weiter. Beim Erfolg liess sich nur der neuere
  // stoppen; der verwaiste triggerte den Erfolgsuebergang wieder und wieder.
  const html = readFileSync(new URL('../tools/installer/install.html', import.meta.url), 'utf8');

  const startDocker = html.match(/async function startDocker\(\) \{([\s\S]*?)\n\}/);
  assert.ok(startDocker, 'startDocker() nicht gefunden');
  const body = startDocker[1];
  const clearIdx = body.indexOf('clearInterval(pollInterval)');
  const setIdx = body.indexOf('setInterval(pollDocker');
  assert.ok(clearIdx !== -1, 'startDocker() raeumt kein laufendes Intervall ab');
  assert.ok(setIdx !== -1, 'startDocker() setzt kein Polling-Intervall');
  assert.ok(clearIdx < setIdx, 'das Abraeumen muss VOR dem neuen setInterval stehen');

  // Zweiter Riegel: pollDocker ist async, also kann ein Tick seine Antwort noch
  // auswerten, nachdem ein anderer den Endzustand gemeldet hat.
  for (const fn of ['dockerSucceeded', 'dockerFailed']) {
    const m = html.match(new RegExp(`function ${fn}\\([^)]*\\) \\{([\\s\\S]*?)\\n\\}`));
    assert.ok(m, `${fn}() nicht gefunden`);
    assert.match(m[1], /if \(dockerDone\) return;/,
      `${fn}() muss den Endzustand gegen einen zweiten Aufruf schuetzen`);
  }
});
