/**
 * Modul: Secrets aus Dateien (`<NAME>_FILE`)
 * Zweck: Prüft server/utils/file-secrets.js und den Start-Handschlag
 *        server/utils/load-file-secrets.js.
 *
 *        Deckt ab:
 *          - der Inhalt der Datei landet in der Variable, Zeilenumbruch am Ende fällt weg
 *          - sonst bleibt der Wert unberührt (Leerzeichen, Zeilenumbrüche in der Mitte)
 *          - ohne `<NAME>_FILE` bleibt `<NAME>` wie es war
 *          - beide gesetzt, eine fehlende oder eine leere Datei: Fehler, kein stiller Rückfall
 *          - nur Namen aus FILE_SECRET_VARS werden aufgelöst
 *          - die Meldungen nennen den Namen, nie den Wert
 *          - Kopplung an .env.example: jedes dort eingetragene Secret ist in der Liste
 *          - der Handschlag beendet den Prozess mit Code 1, wenn ein Secret nicht lädt
 *          - eine Datei, die andere lesen dürfen und die nicht schreibgeschützt ist
 *            (0644 aus `printf ... >`), gibt eine Warnung; 0600, 0440 und 0444
 *            (Podman/Swarm) nicht
 *          - der Handschlag ist der erste Import in server/index.js und steht in
 *            setup.js vor server/db.js
 * Ausführen: node --test test/test-file-secrets.js
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, readFileSync, chmodSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { applyFileSecrets, looseSecretFiles, FILE_SECRET_VARS } from '../server/utils/file-secrets.js';
import { tempDir } from './tmp-dir.js';

const dir = tempDir('yuvomi-file-secrets-');

function secretFile(name, content) {
  const p = join(dir, name);
  writeFileSync(p, content);
  return p;
}

test('der Inhalt der Datei landet in der Variable', () => {
  const env = { SESSION_SECRET_FILE: secretFile('a', 'abc123') };
  assert.deepEqual(applyFileSecrets(env), ['SESSION_SECRET']);
  assert.equal(env.SESSION_SECRET, 'abc123');
});

test('Zeilenumbrüche am Ende fallen weg, der Rest bleibt', () => {
  for (const [content, expected] of [
    ['abc\n', 'abc'],
    ['abc\r\n', 'abc'],
    ['abc\n\n', 'abc'],
    [' a b \n', ' a b '],
    ['a\nb\n', 'a\nb'],
  ]) {
    const env = { DB_ENCRYPTION_KEY_FILE: secretFile('b', content) };
    applyFileSecrets(env);
    assert.equal(env.DB_ENCRYPTION_KEY, expected, JSON.stringify(content));
  }
});

test('ohne `_FILE` bleibt die Variable unberührt', () => {
  const env = { SESSION_SECRET: 'from-env' };
  assert.deepEqual(applyFileSecrets(env), []);
  assert.equal(env.SESSION_SECRET, 'from-env');
});

test('eine leere `_FILE`-Variable zählt als nicht gesetzt', () => {
  const env = { SESSION_SECRET: 'from-env', SESSION_SECRET_FILE: '' };
  assert.deepEqual(applyFileSecrets(env), []);
  assert.equal(env.SESSION_SECRET, 'from-env');
});

test('eine leere Variable neben `_FILE` ist kein Konflikt', () => {
  const env = { SESSION_SECRET: '', SESSION_SECRET_FILE: secretFile('c', 'x') };
  applyFileSecrets(env);
  assert.equal(env.SESSION_SECRET, 'x');
});

test('beide gesetzt bricht ab und nennt keinen Wert', () => {
  const env = { SESSION_SECRET: 'from-env', SESSION_SECRET_FILE: secretFile('d', 'from-file') };
  assert.throws(() => applyFileSecrets(env), (err) => {
    assert.match(err.message, /SESSION_SECRET and SESSION_SECRET_FILE are both set/);
    assert.ok(!err.message.includes('from-env') && !err.message.includes('from-file'));
    return true;
  });
  assert.equal(env.SESSION_SECRET, 'from-env', 'der Konflikt ändert nichts');
});

test('eine fehlende Datei bricht ab, statt still zurückzufallen', () => {
  const env = { DB_ENCRYPTION_KEY_FILE: join(dir, 'gibt-es-nicht') };
  assert.throws(() => applyFileSecrets(env), /DB_ENCRYPTION_KEY_FILE points to .*cannot be read \(ENOENT\)/);
  assert.equal(env.DB_ENCRYPTION_KEY, undefined);
});

test('eine leere Datei bricht ab', () => {
  for (const content of ['', '\n', '\r\n\n']) {
    const env = { DB_ENCRYPTION_KEY_FILE: secretFile('e', content) };
    assert.throws(() => applyFileSecrets(env), /DB_ENCRYPTION_KEY_FILE points to .*which is empty/, JSON.stringify(content));
    assert.equal(env.DB_ENCRYPTION_KEY, undefined);
  }
});

test('andere `_FILE`-Variablen werden nicht angefasst', () => {
  const env = { DB_PATH_FILE: secretFile('f', 'x'), SOMETHING_ELSE_FILE: join(dir, 'nope') };
  assert.deepEqual(applyFileSecrets(env), []);
  assert.deepEqual(Object.keys(env).sort(), ['DB_PATH_FILE', 'SOMETHING_ELSE_FILE']);
});

test('mehrere Secrets werden unabhängig geladen', () => {
  const env = {
    SESSION_SECRET_FILE: secretFile('g1', 's\n'),
    DB_ENCRYPTION_KEY_FILE: secretFile('g2', 'k\n'),
    OIDC_CLIENT_SECRET: 'unchanged',
  };
  assert.deepEqual(applyFileSecrets(env).sort(), ['DB_ENCRYPTION_KEY', 'SESSION_SECRET']);
  assert.equal(env.SESSION_SECRET, 's');
  assert.equal(env.DB_ENCRYPTION_KEY, 'k');
  assert.equal(env.OIDC_CLIENT_SECRET, 'unchanged');
});

test('jedes Secret aus .env.example steht in der Liste', () => {
  const example = readFileSync(fileURLToPath(new URL('../.env.example', import.meta.url)), 'utf8');
  const names = [...example.matchAll(/^#?\s*([A-Z][A-Z0-9_]*(?:SECRET|PASSWORD|PASS|API_KEY|PRIVATE_KEY|ENCRYPTION_KEY))=/gm)]
    .map((m) => m[1]);
  assert.ok(names.length >= 10, 'die Erkennung findet die Secrets in .env.example');
  for (const name of names) {
    assert.ok(FILE_SECRET_VARS.includes(name), `${name} fehlt in FILE_SECRET_VARS`);
  }
});

test('der Start-Handschlag lädt das Secret und beendet sich bei einem Fehler mit Code 1', () => {
  const loader = fileURLToPath(new URL('../server/utils/load-file-secrets.js', import.meta.url));
  const probe = `await import(${JSON.stringify(loader)}); process.stdout.write(process.env.SESSION_SECRET ?? '');`;
  const run = (env) => spawnSync(process.execPath, ['--input-type=module', '-e', probe], {
    env: { PATH: process.env.PATH, LOG_LEVEL: 'error', ...env },
    encoding: 'utf8',
  });

  const ok = run({ SESSION_SECRET_FILE: secretFile('h', 'geladen\n') });
  assert.equal(ok.status, 0);
  assert.equal(ok.stdout, 'geladen');

  const bad = run({ SESSION_SECRET_FILE: join(dir, 'gibt-es-nicht') });
  assert.equal(bad.status, 1);
  assert.ok(!bad.stdout.includes('geladen'));
  assert.match(bad.stdout + bad.stderr, /SESSION_SECRET_FILE points to/);
});

test('eine Datei, die andere lesen dürfen, gibt eine Warnung ohne Wert', () => {
  for (const [mode, warns] of [
    [0o600, false],
    [0o400, false],
    [0o440, false],
    [0o444, false], // Podman, Swarm: schreibgeschützt eingehängt
    [0o644, true],  // printf ... > mit umask 022
    [0o640, true],
    [0o660, true],
    [0o666, true],
  ]) {
    const p = secretFile(`m${mode.toString(8)}`, 'geheim-123');
    chmodSync(p, mode);
    const warnings = looseSecretFiles({ SESSION_SECRET_FILE: p });
    assert.equal(warnings.length, warns ? 1 : 0, mode.toString(8));
    if (warns) {
      assert.match(warnings[0], new RegExp(`SESSION_SECRET_FILE points to .* \\(mode ${mode.toString(8)}\\)\\. Restrict it with chmod 600\\.`));
      assert.ok(!warnings[0].includes('geheim-123'));
    }
  }
});

test('die Warnung prüft nur gesetzte `_FILE`-Variablen und übergeht, was sie nicht lesen kann', () => {
  assert.deepEqual(looseSecretFiles({ SESSION_SECRET: 'x', SESSION_SECRET_FILE: '' }), []);
  assert.deepEqual(looseSecretFiles({ DB_PATH_FILE: '/irgendwo' }, () => ({ mode: 0o100666 })), []);
  const fail = () => { throw Object.assign(new Error('nope'), { code: 'EACCES' }); };
  assert.deepEqual(looseSecretFiles({ SESSION_SECRET_FILE: '/x' }, fail), []);
});

test('der Start-Handschlag warnt bei 0644 und startet trotzdem', () => {
  const loader = fileURLToPath(new URL('../server/utils/load-file-secrets.js', import.meta.url));
  const p = secretFile('i', 'locker\n');
  chmodSync(p, 0o644);
  const res = spawnSync(process.execPath, ['--input-type=module', '-e', `await import(${JSON.stringify(loader)});`], {
    env: { PATH: process.env.PATH, LOG_LEVEL: 'warn', SESSION_SECRET_FILE: p },
    encoding: 'utf8',
  });
  assert.equal(res.status, 0);
  assert.match(res.stdout + res.stderr, /SESSION_SECRET_FILE points to .*other users can read \(mode 644\)/);
  assert.ok(!(res.stdout + res.stderr).includes('locker'));
});

// ES-Module werden in Import-Reihenfolge ausgewertet. Rutscht der Handschlag
// unter server/db.js, liest db.js DB_ENCRYPTION_KEY als nicht gesetzt und öffnet
// still eine unverschlüsselte Datenbank - genau der Rückfall, den das Modul
// verhindern soll. Die Tests oben bemerken das nicht, sie laden den Handschlag allein.
function importSpecifiers(relPath) {
  const source = readFileSync(fileURLToPath(new URL(relPath, import.meta.url)), 'utf8');
  return [...source.matchAll(/^import\s(?:[^'";]*?\sfrom\s)?['"]([^'"]+)['"]/gm)].map((m) => m[1]);
}

test('der Handschlag ist der erste Import in server/index.js', () => {
  assert.equal(importSpecifiers('../server/index.js')[0], './utils/load-file-secrets.js');
});

test('setup.js lädt den Handschlag vor server/db.js', () => {
  const imports = importSpecifiers('../setup.js');
  const loader = imports.indexOf('./server/utils/load-file-secrets.js');
  const db = imports.indexOf('./server/db.js');
  assert.ok(loader !== -1 && db !== -1, `beide Imports gefunden: ${imports.join(', ')}`);
  assert.ok(loader < db, 'load-file-secrets.js steht vor server/db.js');
});

test('das Restore-CLI laedt den Handschlag, bevor es server/db.js dynamisch importiert', () => {
  // restore-backup.js holt db.js erst im try per `await import()`; ohne den
  // statischen Handschlag liest es DB_ENCRYPTION_KEY_FILE nie.
  assert.ok(importSpecifiers('../scripts/restore-backup.js').includes('../server/utils/load-file-secrets.js'));
});
