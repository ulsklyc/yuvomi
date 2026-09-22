/**
 * Tests: Feld fuer den Schluessel eines fremden Backups im Restore-Dialog (#1267)
 * Zweck: Die Regel, wann das Feld erscheint, bleibt oder geleert wird, laeuft
 *        hier als Programm - ebenso das Markup, dessen `aria-describedby` die
 *        HTTP-Warnung erreichen muss (der Fokus springt direkt ins Feld), und
 *        die Kodierung, die der Server wieder zu denselben Bytes lesen muss.
 * Ausführen: node --loader ./test/test-browser-loader.mjs --test test/test-settings-backup-key.js
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const { backupKeyFieldHtml, keyFieldAfterError, keyFieldDescribedBy, encodeBackupKey } = await import('../public/settings/backup-key.js');

function describedIds(html) {
  const input = html.match(/<input[^>]*id="backup-restore-key"[^>]*>/s)?.[0];
  assert.ok(input, 'Vorbedingung: das Eingabefeld ist im Markup');
  return input.match(/aria-describedby="([^"]+)"/)?.[1]?.split(/\s+/).sort() ?? [];
}

test('ueber HTTP verweist aria-describedby auf Hinweis UND Warnung, und beide IDs stehen im Markup', () => {
  const html = backupKeyFieldHtml('http:');
  const ids = describedIds(html);
  assert.deepEqual(ids, ['backup-restore-key-hint', 'backup-restore-key-http']);
  // Gegenprobe: ein Verweis auf eine ID, die es nicht gibt, beschreibt nichts.
  for (const id of ids) assert.match(html, new RegExp(`id="${id}"`), `${id} muss im Markup existieren`);
  assert.match(html, /id="backup-restore-key-http"[^>]*>settings\.backupRestoreKeyHttpWarning</, 'die Warnung traegt ihren Text');
  assert.equal(keyFieldDescribedBy('http:'), ids.join(' '), 'dieselbe Regel setzt das Blatt beim Einblenden');
});

test('ueber HTTPS verweist aria-describedby NICHT auf die (versteckte) Warnung', () => {
  // accname liest ein per aria-describedby verknuepftes Element auch dann vor,
  // wenn es hidden ist - die Warnung kaeme sonst auf jeder HTTPS-Seite.
  assert.deepEqual(describedIds(backupKeyFieldHtml('https:')), ['backup-restore-key-hint']);
  assert.equal(keyFieldDescribedBy('https:'), 'backup-restore-key-hint');
});

test('das Blatt setzt aria-describedby beim Einblenden ueber dieselbe Regel', () => {
  const page = readFileSync(new URL('../public/settings/pages/admin-backup.js', import.meta.url), 'utf8');
  assert.match(page, /setAttribute\('aria-describedby', keyFieldDescribedBy\(protocol\)\)/);
});

test('das Feld ist ein Passwortfeld ohne Autovervollstaendigung', () => {
  const input = backupKeyFieldHtml().match(/<input[^>]*>/s)[0];
  assert.match(input, /type="password"/);
  assert.match(input, /autocomplete="off"/);
});

test('Gruende: Schluessel gefragt zeigt das Feld, bewiesener Schluessel behaelt es, der Rest leert es', () => {
  for (const reason of ['backup_key_required', 'backup_key_wrong', 'backup_key_invalid']) {
    assert.equal(keyFieldAfterError(reason), 'show', reason);
  }
  // Der Schluessel stimmte, die Datei war kaputt: nicht leeren (Review #1417).
  for (const reason of ['backup_damaged', 'backup_unreadable']) {
    assert.equal(keyFieldAfterError(reason), 'keep', reason);
  }
  for (const reason of ['own_key_missing', undefined, 'irgendwas']) {
    assert.equal(keyFieldAfterError(reason), 'reset', String(reason));
  }
});

test('jeder Grund, den der Server kennt, hat im Dialog eine Regel', () => {
  // Die Liste steht im Server; faellt dort ein neuer Grund dazu, muss er hier
  // bewusst eingeordnet werden, statt still auf „reset" zu fallen.
  const db = readFileSync(new URL('../server/db.js', import.meta.url), 'utf8');
  const route = readFileSync(new URL('../server/routes/backup.js', import.meta.url), 'utf8');
  const reasons = new Set([...`${db}\n${route}`.matchAll(/'((?:backup|own)_[a-z_]+)'/g)].map((m) => m[1]));
  const known = {
    backup_key_required: 'show', backup_key_wrong: 'show', backup_key_invalid: 'show',
    backup_damaged: 'keep', backup_unreadable: 'keep', own_key_missing: 'reset',
  };
  assert.deepEqual([...reasons].sort(), Object.keys(known).sort(), 'Gruende im Server');
  for (const [reason, action] of Object.entries(known)) assert.equal(keyFieldAfterError(reason), action, reason);
});

test('die Kodierung liefert dem Server dieselben UTF-8-Bytes zurueck', () => {
  for (const key of ['abc', ' mit Leerzeichen am Rand ', 'schlüssel-€-ü', '鍵🔑']) {
    const encoded = encodeBackupKey(key);
    assert.match(encoded, /^[A-Za-z0-9+/]+={0,2}$/, 'nur Base64-Zeichen - so prueft die Route');
    assert.equal(Buffer.from(encoded, 'base64').toString('utf8'), key);
  }
});
