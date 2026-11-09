/**
 * Modul: Platzhalter-Guard für SESSION_SECRET
 * Zweck: `.env.example` liefert `SESSION_SECRET=REPLACE_WITH_A_LONG_RANDOM_STRING`,
 *        keine leere Zeile. Wer den Quick-Start am Stück kopiert und `.env` nicht
 *        bearbeitet, signiert seine Session-Cookies gegen eine Konstante, die in
 *        diesem Repository steht - wer die Instanz erreicht, kann sich damit ein
 *        Admin-Cookie ausstellen.
 *
 *        Anders als der Schwester-Guard für DB_ENCRYPTION_KEY (server/db.js)
 *        bricht dieser IMMER ab, auch bei einer bestehenden Installation: dort
 *        wäre der Abbruch teurer als der Fehler (ein Schlüsselwechsel macht die
 *        Datenbank unlesbar), hier kostet die Reparatur einen erneuten Login.
 *        Dieser Unterschied ist Absicht und wird hier festgehalten, damit ihn
 *        niemand später als Inkonsistenz "aufräumt".
 *
 *        Deckt ab:
 *          - der Platzhalter aus .env.example bricht den Start ab
 *          - geprüft wird das PRÄFIX, nicht ein einzelner Literalwert
 *          - ein echtes Secret startet weiterhin
 *          - eine fehlende Variable behält ihre eigene, ältere Meldung
 *          - die Kopplung an .env.example: steht dort ein Platzhalter, der
 *            nicht mit REPLACE_WITH_ beginnt, ist der Guard still wirkungslos
 * Ausführen: node --test test/test-session-secret-guard.js
 */
process.env.DB_PATH = ':memory:';

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

let scenario = 0;

/**
 * Lädt server/auth.js frisch. Der Guard läuft beim Modul-Load, also muss jedes
 * Szenario an der Modulzwischenspeicherung vorbei (Cache-Busting-Query, wie in
 * test-db-encryption.js).
 */
async function bootAuth(secret) {
  if (secret === null) delete process.env.SESSION_SECRET;
  else process.env.SESSION_SECRET = secret;
  return import(`../server/auth.js?session-secret=${++scenario}`);
}

test('der Platzhalter aus .env.example bricht den Start ab', async () => {
  await assert.rejects(
    () => bootAuth('REPLACE_WITH_A_LONG_RANDOM_STRING'),
    /SESSION_SECRET is still the placeholder/,
  );
});

test('die Meldung nennt den Ausweg und seinen Preis', async () => {
  // Ein Startabbruch ohne Anleitung ist für eine Bestandsinstallation ein Rätsel:
  // sie lief gestern noch. Beides muss dastehen - der Befehl und die Zusicherung,
  // dass nur die Anmeldungen verloren gehen.
  const err = await bootAuth('REPLACE_WITH_A_LONG_RANDOM_STRING').catch((e) => e);
  assert.match(err.message, /openssl rand -base64 48/);
  assert.match(err.message, /sign in again/);
});

test('geprüft wird das Präfix, nicht ein einzelner Literalwert', async () => {
  await assert.rejects(
    () => bootAuth('REPLACE_WITH_SOMETHING_ELSE'),
    /SESSION_SECRET is still the placeholder/,
    'sonst rutscht jede umbenannte Platzhalter-Variante durch',
  );
});

test('eine fehlende Variable behält ihre eigene Meldung', async () => {
  await assert.rejects(
    () => bootAuth(null),
    /SESSION_SECRET must be set/,
    'die beiden Fälle brauchen verschiedene Auswege: setzen vs. ersetzen',
  );
});

test('ein echtes Secret startet weiterhin', async () => {
  const mod = await bootAuth('R+7k2wQmXn4pL9vTzYbF3jHsA6dEuGcK1oNrPiWxMlZ0');
  assert.ok(mod.router, 'auth.js lädt vollständig durch');
});

test('.env.example trägt einen Platzhalter, den der Guard auch erkennt', () => {
  // Die eigentliche Kopplung: der Guard prüft auf REPLACE_WITH_, die Datei
  // liefert den Wert. Wird der Platzhalter dort umbenannt, greift der Guard
  // still nicht mehr - und ausgerechnet dieser Weg (Quick-Start kopieren,
  // .env nicht bearbeiten) ist der einzige, der ihn überhaupt braucht.
  const example = readFileSync(new URL('../.env.example', import.meta.url), 'utf8');
  const line = example.split('\n').find((l) => l.startsWith('SESSION_SECRET='));
  assert.ok(line, 'SESSION_SECRET fehlt in .env.example');

  const value = line.slice('SESSION_SECRET='.length).trim();
  assert.ok(
    value.startsWith('REPLACE_WITH_'),
    `.env.example liefert "${value}" - der Guard in server/auth.js prüft aber auf das Präfix REPLACE_WITH_ und ginge daran vorbei`,
  );
});
