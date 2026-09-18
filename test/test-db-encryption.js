/**
 * Test-Suite: Datenbank-Verschlüsselung (DB_ENCRYPTION_KEY).
 *
 * Hintergrund: Bis v1.52.x war `DB_ENCRYPTION_KEY` faktisch wirkungslos — das
 * ausgelieferte Binary hatte keine Cipher-Schicht, reguläres SQLite ignorierte
 * das unbekannte `PRAGMA key` kommentarlos, und die App lief still auf einer
 * unverschlüsselten Datenbank weiter. Diese Suite hält fest, dass genau das
 * nicht mehr passieren kann.
 *
 * Geprüft wird bewusst gegen den Dateikopf auf der Platte statt gegen eine
 * API-Zusage: eine unverschlüsselte SQLite-Datei beginnt mit
 * "SQLite format 3\0", eine verschlüsselte mit Zufallsrauschen.
 *
 * Jedes Szenario lädt eine frische db.js-Instanz (dynamischer Import mit
 * Cache-Busting-Query), da DB_PATH und DB_ENCRYPTION_KEY beim Modul-Load aus
 * der Env gelesen werden.
 *
 * Lauf: node --experimental-sqlite test/test-db-encryption.js
 *   (bzw. npm run test:db-encryption)
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, existsSync, readFileSync, readdirSync, copyFileSync, writeFileSync, chmodSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3-multiple-ciphers';

const KEY = 'test-encryption-key-0123456789';
const PLAINTEXT_HEADER = Buffer.from('SQLite format 3\0', 'binary');

let scenarioCounter = 0;

/** Frische db.js-Instanz mit gegebenem Pfad und Key laden und initialisieren. */
async function bootDb(dbPath, encryptionKey) {
  process.env.DB_PATH = dbPath;
  if (encryptionKey === null) {
    delete process.env.DB_ENCRYPTION_KEY;
  } else {
    process.env.DB_ENCRYPTION_KEY = encryptionKey;
  }
  const mod = await import(`../server/db.js?encryption=${++scenarioCounter}`);
  mod.init();
  return mod;
}

function tmpDir() {
  return mkdtempSync(join(tmpdir(), 'yuvomi-encryption-'));
}

/** true, wenn die Datei mit dem unverschlüsselten SQLite-Header beginnt. */
function isPlaintext(filePath) {
  const head = readFileSync(filePath).subarray(0, PLAINTEXT_HEADER.length);
  return head.equals(PLAINTEXT_HEADER);
}

/** Unverschlüsselte Bestands-Datenbank erzeugen, wie sie vor dem Fix entstand. */
function seedPlaintextDb(filePath, rows) {
  const seed = new Database(filePath);
  seed.pragma('journal_mode = WAL');
  seed.exec('CREATE TABLE legacy_marker (id INTEGER PRIMARY KEY, note TEXT, payload BLOB)');
  const insert = seed.prepare('INSERT INTO legacy_marker (note, payload) VALUES (?, ?)');
  for (let i = 0; i < rows; i++) {
    insert.run(`Befund-${i} Müller/Ärztin`, Buffer.from([i % 256, 1, 2]));
  }
  seed.close();
}

test('das Binding bringt Cipher-Support mit', () => {
  const probe = new Database(':memory:');
  const { version } = probe.prepare('SELECT sqlite3mc_version() AS version').get();
  probe.close();
  assert.match(version, /Multiple Ciphers/, 'sqlite3mc_version() muss verfügbar sein');
});

test('ohne DB_ENCRYPTION_KEY bleibt die Datenbank unverschlüsselt (Entwicklung)', async () => {
  const dbPath = join(tmpDir(), 'yuvomi.db');
  await bootDb(dbPath, null);

  assert.ok(existsSync(dbPath), 'Datenbank muss angelegt werden');
  assert.ok(isPlaintext(dbPath), 'ohne Key darf nicht verschlüsselt werden');
});

test('mit DB_ENCRYPTION_KEY ist eine frisch angelegte Datenbank wirklich verschlüsselt', async () => {
  const dbPath = join(tmpDir(), 'yuvomi.db');
  await bootDb(dbPath, KEY);

  assert.ok(existsSync(dbPath), 'Datenbank muss angelegt werden');
  assert.ok(!isPlaintext(dbPath), 'Datei darf keinen Klartext-Header haben');

  // Ohne Key darf die Datei nicht zu öffnen sein.
  assert.throws(
    () => {
      const intruder = new Database(dbPath);
      intruder.prepare('SELECT count(*) FROM sqlite_master').get();
    },
    /file is not a database/,
    'ohne Key darf die Datenbank nicht lesbar sein'
  );
});

test('eine unverschlüsselte Bestands-Datenbank wird beim Start migriert', async () => {
  const dbPath = join(tmpDir(), 'yuvomi.db');
  seedPlaintextDb(dbPath, 150);
  assert.ok(isPlaintext(dbPath), 'Vorbedingung: Bestands-DB ist unverschlüsselt');

  const mod = await bootDb(dbPath, KEY);

  assert.ok(!isPlaintext(dbPath), 'Datenbank muss nach dem Start verschlüsselt sein');

  // Daten müssen vollständig und unverändert sein.
  const { count } = mod.get().prepare('SELECT count(*) AS count FROM legacy_marker').get();
  assert.equal(count, 150, 'alle Zeilen müssen erhalten bleiben');
  const row = mod.get().prepare('SELECT note, payload FROM legacy_marker WHERE id = 42').get();
  assert.equal(row.note, 'Befund-41 Müller/Ärztin', 'Textinhalte inkl. Umlauten bleiben erhalten');
  assert.deepEqual([...row.payload], [41, 1, 2], 'BLOBs bleiben erhalten');
});

test('die Migration hinterlässt ein unverschlüsseltes Backup der Originaldatei', async () => {
  const dbPath = join(tmpDir(), 'yuvomi.db');
  const backupPath = `${dbPath}.plaintext-backup`;
  seedPlaintextDb(dbPath, 10);

  await bootDb(dbPath, KEY);

  assert.ok(existsSync(backupPath), 'Backup der Originaldatei muss existieren');
  assert.ok(isPlaintext(backupPath), 'das Backup ist bewusst die unverschlüsselte Originaldatei');

  // Das Backup muss für sich lesbar sein, damit ein Rollback möglich bleibt.
  const backup = new Database(backupPath, { readonly: true });
  const { count } = backup.prepare('SELECT count(*) AS count FROM legacy_marker').get();
  backup.close();
  assert.equal(count, 10, 'das Backup muss den vollständigen Datenbestand enthalten');
});

test('eine unverschlüsselte Legacy-oikos.db wird im selben Start umbenannt und verschlüsselt', async () => {
  // Der kritische Bestandsfall: Legacy-Dateiname UND gesetzter Key. Würde die
  // Rename-Migration der noch unverschlüsselten oikos.db den Cipher-Key
  // aufsetzen, scheiterte ihr Checkpoint mit „file is not a database", der
  // Rename verschöbe sich auf den nächsten Boot und die Klartext-Sicherheits-
  // kopie hieße oikos.db.plaintext-backup — nicht der Name, den .env.example,
  // SECURITY.md und docs/installation.md zum Löschen nennen.
  const dir = tmpDir();
  const legacyPath = join(dir, 'oikos.db');
  const dbPath = join(dir, 'yuvomi.db');
  seedPlaintextDb(legacyPath, 20);

  const mod = await bootDb(legacyPath, KEY);

  assert.ok(existsSync(dbPath), 'die Datenbank muss im selben Start nach yuvomi.db umgezogen sein');
  assert.ok(!existsSync(legacyPath), 'die Legacy-Datei darf nicht liegenbleiben');
  assert.ok(!isPlaintext(dbPath), 'nach dem Umzug muss verschlüsselt sein');

  assert.ok(
    existsSync(`${dbPath}.plaintext-backup`),
    'die Sicherheitskopie muss unter dem dokumentierten Namen <DB_PATH>.plaintext-backup liegen'
  );
  assert.ok(
    !existsSync(`${legacyPath}.plaintext-backup`),
    'keine unverschlüsselte Kopie unter einem Namen, den die Doku nicht nennt'
  );

  const { count } = mod.get().prepare('SELECT count(*) AS count FROM legacy_marker').get();
  assert.equal(count, 20, 'alle Zeilen müssen den Umzug überstehen');
});

test('eine bereits verschlüsselte Datenbank wird beim nächsten Start nicht erneut migriert', async () => {
  const dbPath = join(tmpDir(), 'yuvomi.db');
  const backupPath = `${dbPath}.plaintext-backup`;
  await bootDb(dbPath, KEY);
  assert.ok(!existsSync(backupPath), 'Neuinstallation braucht kein Migrations-Backup');

  // Zweiter Start auf derselben, bereits verschlüsselten Datei.
  const mod = await bootDb(dbPath, KEY);

  assert.ok(!isPlaintext(dbPath), 'Datenbank bleibt verschlüsselt');
  assert.ok(!existsSync(backupPath), 'ohne Klartext-Datei darf kein Backup entstehen');
  assert.doesNotThrow(
    () => mod.get().prepare('SELECT count(*) FROM sqlite_master').get(),
    'die Datenbank muss weiterhin nutzbar sein'
  );
});

test('ein falscher Key führt zu einem klaren Startfehler statt zu stillem Datenverlust', async () => {
  const dbPath = join(tmpDir(), 'yuvomi.db');
  await bootDb(dbPath, KEY);

  await assert.rejects(
    () => bootDb(dbPath, 'ein-voellig-anderer-key'),
    /Wrong encryption key/,
    'falscher Key muss den Start abbrechen'
  );

  // Die Datei darf dabei unangetastet bleiben.
  assert.ok(!isPlaintext(dbPath), 'die Datenbank bleibt verschlüsselt');
});

test('ein blockierter WAL-Checkpoint bricht die Migration ab, statt Teildaten zu verschlüsseln', async () => {
  // wal_checkpoint(TRUNCATE) wirft nicht, wenn eine andere Verbindung liest —
  // es meldet busy != 0. Würde die Migration das ignorieren, verschlüsselte sie
  // eine unvollständige Kopie und löschte anschließend die WAL-Sidecars.
  const dbPath = join(tmpDir(), 'yuvomi.db');
  seedPlaintextDb(dbPath, 50);

  // Zweite Instanz auf demselben Volume: ein offener Writer hält das WAL
  // gefüllt, ein Reader mit laufender Transaktion blockiert den TRUNCATE.
  const writer = new Database(dbPath);
  writer.pragma('journal_mode = WAL');
  writer.prepare('INSERT INTO legacy_marker (note) VALUES (?)').run('im-wal');
  const reader = new Database(dbPath);
  reader.exec('BEGIN');
  reader.prepare('SELECT count(*) FROM legacy_marker').get();

  try {
    await assert.rejects(
      () => bootDb(dbPath, KEY),
      /write-ahead log could not be checkpointed/,
      'die Migration muss bei blockiertem Checkpoint abbrechen'
    );

    // Entscheidend: die Datenbank muss unangetastet und vollständig bleiben.
    assert.ok(isPlaintext(dbPath), 'die Originaldatei bleibt unverändert');
  } finally {
    reader.exec('COMMIT');
    reader.close();
    writer.close();
  }

  const survivor = new Database(dbPath);
  const { count } = survivor.prepare('SELECT count(*) AS count FROM legacy_marker').get();
  survivor.close();
  assert.equal(count, 51, 'kein Datenverlust durch den abgebrochenen Versuch (50 + die WAL-Zeile)');
});

test('ein Backup der verschlüsselten Datenbank ist selbst verschlüsselt und wiederherstellbar', async () => {
  const dir = tmpDir();
  const dbPath = join(dir, 'yuvomi.db');
  const backupPath = join(dir, 'backup.db');
  const mod = await bootDb(dbPath, KEY);
  mod.get().exec('CREATE TABLE backup_marker (note TEXT)');
  mod.get().prepare('INSERT INTO backup_marker VALUES (?)').run('vor-backup');

  // Die SQLite-Backup-API scheitert an verschlüsselten Quellen ("incompatible
  // source and target databases"). Ohne den VACUUM-INTO-Zweig wäre bei gesetztem
  // Key jedes Backup kaputt — inklusive Scheduler und WebDAV-Upload.
  await mod.backupToFile(backupPath);

  assert.ok(existsSync(backupPath), 'Backup muss angelegt werden');
  assert.ok(!isPlaintext(backupPath), 'das Backup darf nicht im Klartext liegen');
  assert.ok(
    !readFileSync(backupPath).includes(Buffer.from('vor-backup')),
    'Inhalte dürfen im Backup nicht im Klartext auffindbar sein'
  );

  const restored = await mod.restoreFromFile(backupPath);
  assert.equal(restored.schemaVersion, mod.currentVersion(), 'Restore muss die Schema-Version melden');
  assert.equal(
    mod.get().prepare('SELECT note FROM backup_marker').get()?.note,
    'vor-backup',
    'Daten müssen den Restore überstehen'
  );
});

test('ein vor der Umstellung erzeugtes Klartext-Backup bleibt einspielbar', async () => {
  // Bestandsnutzer haben Backups aus der Zeit, in der DB_ENCRYPTION_KEY
  // wirkungslos war. Würde die Validierung ihnen den Key aufsetzen, wären diese
  // Backups nach dem Update wertlos.
  const legacyPath = join(tmpDir(), 'yuvomi.db');
  const legacy = await bootDb(legacyPath, null);
  legacy.get().exec('CREATE TABLE backup_marker (note TEXT)');
  legacy.get().prepare('INSERT INTO backup_marker VALUES (?)').run('altbestand');
  legacy.get().pragma('wal_checkpoint(TRUNCATE)');

  const dir = tmpDir();
  const oldBackup = join(dir, 'old-plaintext-backup.db');
  copyFileSync(legacyPath, oldBackup);
  assert.ok(isPlaintext(oldBackup), 'Vorbedingung: das alte Backup ist unverschlüsselt');

  const dbPath = join(dir, 'yuvomi.db');
  const mod = await bootDb(dbPath, KEY);

  const restored = await mod.restoreFromFile(oldBackup);
  assert.ok(restored.schemaVersion > 0, 'das alte Backup muss einspielbar sein');
  assert.equal(
    mod.get().prepare('SELECT note FROM backup_marker').get()?.note,
    'altbestand',
    'Daten aus dem alten Backup müssen ankommen'
  );
  assert.ok(!isPlaintext(dbPath), 'nach dem Restore muss wieder verschlüsselt sein');
});

test('ein Restore hinterlässt keine unverschlüsselte Kopie im Datenverzeichnis', async () => {
  // Ein eingespieltes Alt-Backup wird beim Restore verschlüsselt. Die Sicherung
  // dafür ist die Backup-Datei selbst plus `.pre-restore-*` — eine zusätzliche
  // Klartext-Vollkopie bliebe dauerhaft liegen und käme bei jedem weiteren
  // Restore erneut dazu, ohne dass die Backup-UI davon berichtet.
  const legacyPath = join(tmpDir(), 'yuvomi.db');
  const legacy = await bootDb(legacyPath, null);
  legacy.get().exec('CREATE TABLE restore_marker (note TEXT)');
  legacy.get().prepare('INSERT INTO restore_marker VALUES (?)').run('aus-dem-altbackup');
  legacy.get().pragma('wal_checkpoint(TRUNCATE)');

  const dir = tmpDir();
  const oldBackup = join(dir, 'altbestand.db');
  copyFileSync(legacyPath, oldBackup);
  assert.ok(isPlaintext(oldBackup), 'Vorbedingung: das alte Backup ist unverschlüsselt');

  const dbPath = join(dir, 'yuvomi.db');
  const mod = await bootDb(dbPath, KEY);

  await mod.restoreFromFile(oldBackup);
  await mod.restoreFromFile(oldBackup); // zweiter Lauf: nichts darf sich anhäufen

  const leftovers = readdirSync(dir).filter((name) => name.includes('plaintext-backup'));
  assert.deepEqual(leftovers, [], `keine Klartext-Kopien erwartet, gefunden: ${leftovers.join(', ')}`);

  assert.ok(!isPlaintext(dbPath), 'die wiederhergestellte Datenbank muss verschlüsselt sein');
  assert.equal(
    mod.get().prepare('SELECT note FROM restore_marker').get()?.note,
    'aus-dem-altbackup',
    'die Daten aus dem Backup müssen ankommen'
  );

  // Der Rollback-Anker bleibt: er ist verschlüsselt und deckt den Fehlerfall ab.
  assert.ok(
    readdirSync(dir).some((name) => name.includes('.pre-restore-')),
    'die pre-restore-Sicherung muss weiterhin entstehen'
  );
});

test('der SQLCipher-Cipher (AES-256) ist aktiv, nicht der Default ChaCha20', async () => {
  const dbPath = join(tmpDir(), 'yuvomi.db');
  await bootDb(dbPath, KEY);

  const handle = new Database(dbPath);
  handle.pragma("cipher = 'sqlcipher'");
  handle.pragma(`key="x'${Buffer.from(KEY, 'utf8').toString('hex')}'"`);
  const readable = handle.prepare('SELECT count(*) AS count FROM sqlite_master').get();
  handle.close();

  assert.ok(readable.count >= 0, 'die Datenbank muss im sqlcipher-Modus lesbar sein');
});

// ----------------------------------------------------------------------------
// Platzhalter-Schlüssel aus .env.example
//
// `.env.example` liefert DB_ENCRYPTION_KEY=REPLACE_WITH_A_STRONG_ENCRYPTION_KEY,
// keine leere Zeile. Wer den Quick-Start am Stück kopiert und `.env` nicht
// bearbeitet, verschlüsselt damit gegen eine Konstante, die im Repository steht.
// Die zwei Fälle sind bewusst verschieden: bei einer NEUEN Datenbank ist der
// Fehler vermeidbar und wird abgebrochen, bei einer BESTEHENDEN ist er längst
// passiert und ein Startfehler würde nur eine laufende Instanz stilllegen.
// ----------------------------------------------------------------------------

const PLACEHOLDER_KEY = 'REPLACE_WITH_A_STRONG_ENCRYPTION_KEY';

/** Verschlüsselte Bestands-Datenbank mit gegebenem Key erzeugen. */
function seedEncryptedDb(filePath, key) {
  const seed = new Database(filePath);
  seed.pragma("cipher = 'sqlcipher'");
  seed.pragma(`key="x'${Buffer.from(key, 'utf8').toString('hex')}'"`);
  seed.exec('CREATE TABLE legacy_marker (id INTEGER PRIMARY KEY, note TEXT)');
  seed.prepare('INSERT INTO legacy_marker (note) VALUES (?)').run('Bestand');
  seed.close();
}

test('der Platzhalter aus .env.example bricht den Start einer NEUEN Datenbank ab', async () => {
  const dbPath = join(tmpDir(), 'yuvomi.db');

  await assert.rejects(
    () => bootDb(dbPath, PLACEHOLDER_KEY),
    /placeholder from \.env\.example/,
    'ein Platzhalter darf keine neue Datenbank verschlüsseln'
  );

  assert.ok(
    !existsSync(dbPath),
    'es darf keine Datei entstehen, die gegen eine veröffentlichte Konstante verschlüsselt ist'
  );
});

test('jeder REPLACE_WITH_-Wert wird abgefangen, nicht nur der aus .env.example', async () => {
  const dbPath = join(tmpDir(), 'yuvomi.db');

  await assert.rejects(
    () => bootDb(dbPath, 'REPLACE_WITH_SOMETHING_ELSE'),
    /placeholder from \.env\.example/,
    'der Guard prüft das Präfix, nicht einen einzelnen Literalwert'
  );
});

test('eine BESTEHENDE Datenbank mit Platzhalter-Key startet weiter', async () => {
  const dbPath = join(tmpDir(), 'yuvomi.db');
  seedEncryptedDb(dbPath, PLACEHOLDER_KEY);
  assert.ok(!isPlaintext(dbPath), 'Vorbedingung: Bestands-DB ist verschlüsselt');

  // Kein rejects: wer diesen Weg schon gegangen ist, behält seine laufende
  // Instanz. Der Guard verhindert den Fehler, er bestraft ihn nicht rückwirkend.
  const mod = await bootDb(dbPath, PLACEHOLDER_KEY);

  const row = mod.get().prepare('SELECT note FROM legacy_marker WHERE id = 1').get();
  assert.equal(row.note, 'Bestand', 'die Bestandsdaten müssen lesbar bleiben');
});

test('ein echter Key, der zufällig mit REPLACE beginnt, wird nicht abgefangen', async () => {
  const dbPath = join(tmpDir(), 'yuvomi.db');

  // Der Guard hängt am Präfix `REPLACE_WITH_`, nicht am Wort "REPLACE". Ein
  // Nutzer, dessen Passphrase so anfängt, darf nicht ausgesperrt werden.
  await bootDb(dbPath, 'REPLACEMENT-KEY-die-echt-ist-0123456789');

  assert.ok(existsSync(dbPath), 'Datenbank muss angelegt werden');
  assert.ok(!isPlaintext(dbPath), 'und verschlüsselt sein');
});

/* EIN BACKUP AUS EINER FREMDEN INSTALLATION SCHEITERT AM SCHLUESSEL, NICHT AN SICH.
 *
 * `restoreFromFile()` oeffnet die hochgeladene Datei mit dem Key DIESER Instanz.
 * Passt er nicht, sagt SQLite denselben Satz wie zu jeder beliebigen fremden
 * Datei: `file is not a database`. Die Route reicht ihn woertlich an den
 * Restore-Dialog durch, und dort liest er sich als „dein Backup ist kaputt".
 *
 * Gemeldet als #1267: Umzug von einer Instanz mit selbst gesetzten Secrets auf
 * eine, die sich ihre eigenen erzeugt. Der Melder hat daraufhin die
 * Datenbankdatei im Container von Hand ersetzt und die Installation zerlegt -
 * der teure Teil des Fehlers steckt nicht im Abbruch, sondern darin, wozu die
 * Auskunft einlaedt.
 *
 * Gemessen werden beide Richtungen: die Meldung muss den Schluessel nennen, wo
 * er die Ursache ist, und sie darf es NICHT tun, wo die Datei wirklich keine
 * Datenbank ist - sonst schickt sie den naechsten in die falsche Richtung.
 */

/**
 * BEIDE verschluesselten Zweige muessen die ZWEITE Moeglichkeit nennen.
 *
 * Ohne Klartext-Kopf ist eine Datei verschluesselt ODER ueberhaupt keine
 * Datenbank - ein hochgeladenes Zip, ein abgebrochener Download. Welches von
 * beidem, kann `validateBackupFile()` nicht wissen, und eine Meldung, die sich
 * auf den Schluessel festlegt, schickt einen Admin ohne gesetzten Key genau so
 * in die Irre wie die rohe SQLite-Zeile es in #1267 getan hat: er sucht nach
 * einem Schluessel, den es nie gab.
 *
 * Der erste Anlauf dieses PRs hatte genau diese Asymmetrie - der Zweig MIT Key
 * nannte die Alternative, der ohne behauptete flach „it is encrypted" (Befund
 * der Review-Runde auf #1272). Deshalb steht die Regel hier als eigene Probe
 * und nicht als Nebensatz in einem der beiden Faelle: die naechste Umformulierung
 * soll sie nicht wieder verlieren koennen.
 */
function nenntSchluesselUndAlternative(err, fall) {
  assert.match(err.message, /DB_ENCRYPTION_KEY/, `${fall}: die Meldung muss den Schluessel nennen`);
  assert.match(
    err.message,
    /is not a (valid )?Yuvomi database/,
    `${fall}: die Meldung darf die zweite Moeglichkeit nicht verschweigen`
  );
  return true;
}

/** Ein echtes Backup einer Instanz mit `key` - ueber den Weg, den die App nimmt. */
async function backupFromInstance(key) {
  const dir = tmpDir();
  const mod = await bootDb(join(dir, 'quelle.db'), key);
  const backupPath = join(dir, 'backup.db');
  await mod.backupToFile(backupPath);
  return backupPath;
}

test('ein Backup mit fremdem Schluessel nennt den Schluessel als Ursache', async () => {
  const backupPath = await backupFromInstance('schluessel-der-alten-instanz-0123');
  assert.ok(!isPlaintext(backupPath), 'Vorbedingung: das Backup ist verschluesselt');

  const ziel = await bootDb(join(tmpDir(), 'yuvomi.db'), 'schluessel-der-neuen-instanz-0123');

  await assert.rejects(
    () => ziel.restoreFromFile(backupPath),
    (err) => nenntSchluesselUndAlternative(err, 'fremder Schluessel'),
    'die Meldung muss den Schluessel nennen, nicht nur „is not a database"'
  );
});

test('ohne eigenen Schluessel sagt die Meldung, dass gar keiner gesetzt ist', async () => {
  const backupPath = await backupFromInstance('schluessel-der-alten-instanz-0123');
  const ziel = await bootDb(join(tmpDir(), 'yuvomi.db'), null);

  // Der Unterschied ist kein Wortspiel: hier gibt es nichts zu vergleichen,
  // `applyEncryptionKey()` ist ohne Key ein Leerlauf. Wer „falscher Schluessel"
  // liest, sucht an der falschen Stelle - er hat ueberhaupt keinen.
  await assert.rejects(
    () => ziel.restoreFromFile(backupPath),
    (err) => /DB_ENCRYPTION_KEY is not set on this instance/.test(err.message)
      && nenntSchluesselUndAlternative(err, 'kein Key gesetzt'),
    'ohne gesetzten Key muss die Meldung genau das sagen'
  );
});

test('mit dem richtigen Schluessel laeuft derselbe Restore durch', async () => {
  const KEY_QUELLE = 'schluessel-der-alten-instanz-0123';
  const backupPath = await backupFromInstance(KEY_QUELLE);
  const ziel = await bootDb(join(tmpDir(), 'yuvomi.db'), KEY_QUELLE);

  // Ohne diesen Fall waere die Suite auch dann gruen, wenn JEDER Restore mit
  // der neuen Meldung abbraeche - die Diagnose darf den Weg nicht zumauern.
  const result = await ziel.restoreFromFile(backupPath);
  assert.ok(result.schemaVersion > 0, 'der Restore muss durchlaufen und eine Schemaversion melden');
});

test('eine Datei, die wirklich keine Datenbank ist, bekommt weiter die alte Auskunft', async () => {
  const dir = tmpDir();
  const fremd = join(dir, 'kein-backup.db');
  // Klartext-SQLite-Kopf, dahinter Unsinn: damit ist die Datei nachweislich
  // nicht verschluesselt, und der Schluessel ist als Ursache ausgeschlossen.
  writeFileSync(fremd, Buffer.concat([PLAINTEXT_HEADER, Buffer.from('kein gueltiger Inhalt')]));

  const ziel = await bootDb(join(dir, 'yuvomi.db'), KEY);

  await assert.rejects(
    () => ziel.restoreFromFile(fremd),
    (err) => /not a valid Yuvomi database|file is not a database/.test(err.message)
      && !/DB_ENCRYPTION_KEY/.test(err.message),
    'eine unverschluesselte Datei darf den Schluessel nicht beschuldigen'
  );
});

/*
 * ---------------------------------------------------------------------------
 * #1267, zweiter Anlauf: die Auskunft selbst war die Sackgasse.
 *
 * Nach der ersten Runde nannte die Restore-Meldung zwar den Schluessel, gab aber
 * eine Anweisung dazu: „set DB_ENCRYPTION_KEY to it and restart Yuvomi, then
 * restore again". Der Melder hat sie befolgt und stand danach vor einer Instanz,
 * die gar nicht mehr startete - die eigene Datenbank ist mit dem eigenen
 * Schluessel verschluesselt, `init()` bricht ab, und der Dialog, der den Rat
 * gegeben hat, ist ab da unerreichbar. Die Auskunft war nicht ungenau, sie war
 * ein Weg ins Aus.
 *
 * Die Faelle darunter halten drei Dinge auseinander, die sich beim naechsten
 * Umformulieren leicht wieder vermischen:
 *   - MIT eigenem Schluessel ist der Rat falsch und muss ausdruecklich davor
 *     warnen (er ist genau das, was der Melder getan hat),
 *   - OHNE eigenen Schluessel ist derselbe Rat RICHTIG - die Klartextdatenbank
 *     wird beim Start mitverschluesselt, danach passt der Schluessel zu beidem.
 *     Nachgemessen, nicht angenommen, bevor die Unterscheidung in den Code kam.
 *   - der Abbruch beim Start muss den Rueckweg nennen, sonst sitzt man fest.
 * ---------------------------------------------------------------------------
 */

test('mit eigenem Schluessel warnt die Meldung vor dem Schluesseltausch, statt ihn zu raten', async () => {
  const backupPath = await backupFromInstance('schluessel-der-alten-instanz-0123');
  const ziel = await bootDb(join(tmpDir(), 'yuvomi.db'), 'schluessel-der-neuen-instanz-0123');

  await assert.rejects(
    () => ziel.restoreFromFile(backupPath),
    (err) => {
      // Der Kern: die Meldung darf den Handgriff, der den Melder ausgesperrt
      // hat, nicht mehr empfehlen, und sie muss die Folge benennen.
      assert.match(
        err.message,
        /Do NOT just set DB_ENCRYPTION_KEY/,
        'die Meldung muss vom Schluesseltausch abraten'
      );
      assert.match(
        err.message,
        /would not start at all/,
        'sie muss sagen, was der Tausch anrichtet - sonst liest er sich wie eine Vorsichtsmassnahme'
      );
      assert.match(
        err.message,
        /CLI \/ Docker Compose restore/,
        'und sie muss den Weg nennen, der wirklich traegt'
      );
      return true;
    },
    'die Meldung mit eigenem Schluessel darf nicht in die Sackgasse raten'
  );
});

test('ohne eigenen Schluessel bleibt der Rat zum Setzen des Schluessels stehen', async () => {
  const backupPath = await backupFromInstance('schluessel-der-alten-instanz-0123');
  const ziel = await bootDb(join(tmpDir(), 'yuvomi.db'), null);

  // Regressionsschutz gegen eine Korrektur, die zu weit greift: hier ist der
  // Rat richtig, weil `encryptPlaintextDatabase()` die eigene Klartextdatenbank
  // beim naechsten Start mit genau diesem Schluessel verschluesselt. Wer die
  // Warnung aus dem anderen Zweig hierher kopiert, nimmt dem Admin den einzigen
  // Weg, der ohne Kommandozeile auskommt.
  await assert.rejects(
    () => ziel.restoreFromFile(backupPath),
    (err) => {
      assert.match(
        err.message,
        /restart Yuvomi, then restore again/,
        'ohne eigenen Schluessel muss der Weg ueber .env erhalten bleiben'
      );
      assert.ok(
        !/Do NOT just set DB_ENCRYPTION_KEY/.test(err.message),
        'die Warnung aus dem anderen Zweig gehoert hier nicht hin'
      );
      return true;
    },
    'der Zweig ohne Schluessel darf nicht mitkorrigiert werden'
  );
});

test('der Abbruch beim Start nennt den Rueckweg statt nur den Schluessel zu pruefen', async () => {
  const quelle = await backupFromInstance('schluessel-der-alten-instanz-0123');
  const dir = tmpDir();
  const eigene = join(dir, 'yuvomi.db');
  copyFileSync(quelle, eigene);

  // Die Lage des Melders: die Datenbank gehoert zu Schluessel A, in der
  // Umgebung steht B. Ohne den Rueckweg in der Meldung bleibt nur Raten.
  await assert.rejects(
    () => bootDb(eigene, 'ein-ganz-anderer-schluessel-0123'),
    (err) => {
      assert.match(err.message, /Wrong encryption key/, 'der Anlass muss weiter oben stehen');
      assert.match(
        err.message,
        /change it back/,
        'die Meldung muss den Rueckweg nennen - ohne ihn sitzt man fest'
      );
      assert.ok(
        !/—/.test(err.message),
        'kein Em-Dash in einer Meldung, die in Logs und Tickets landet'
      );
      return true;
    },
    'der Startabbruch darf nicht bei „check the key" aufhoeren'
  );
});

test('das eigene Journal nach einem unsauberen Stopp wird NICHT zum Loeschen empfohlen', async () => {
  const dir = tmpDir();
  const eigene = join(dir, 'yuvomi.db');
  const KEY_EIGEN = 'schluessel-dieser-instanz-0123456';

  // Der Fall, den die erste Fassung dieses Fixes uebersehen hat (Review-Befund
  // auf PR #1275): `journal_mode = WAL` steht dauerhaft, und es gibt nirgends
  // einen SIGTERM-Handler, der die Verbindung schliesst. Nach einem gewoehnlichen
  // Container-Stopp liegt das Journal also da - als EIGENES Journal dieser
  // Datenbank, mit bestaetigten Transaktionen, die noch nicht in der Hauptdatei
  // stehen. Wer hier „loesch es" liest, wirft sie weg und hat den Schluessel
  // trotzdem nicht repariert.
  const laufend = new Database(eigene);
  laufend.pragma("cipher = 'sqlcipher'");
  laufend.pragma(`key="x'${Buffer.from(KEY_EIGEN, 'utf8').toString('hex')}'"`);
  laufend.pragma('journal_mode = WAL');
  laufend.exec('CREATE TABLE eigener_marker (a INTEGER)');
  laufend.prepare('INSERT INTO eigener_marker VALUES (1)').run();
  // Kein close(): genau das unterlaesst auch ein `docker stop`.
  assert.ok(existsSync(`${eigene}-wal`), 'Vorbedingung: das eigene Journal liegt da');

  await assert.rejects(
    () => bootDb(eigene, 'ein-vertippter-schluessel-0123456'),
    (err) => {
      assert.match(
        err.message,
        /Do not delete it in that case/,
        'die Meldung muss vom Loeschen des eigenen Journals abraten'
      );
      assert.match(
        err.message,
        /committed transactions that are not in the main file yet/,
        'und sagen, was dabei verlorenginge'
      );
      assert.ok(
        !/stop Yuvomi, delete/i.test(err.message),
        'kein unbedingter Loeschbefehl - die Bedingung kennt nur der Admin'
      );
      assert.match(
        err.message,
        /move .*-wal and .*-shm aside/,
        'und wenn doch, dann beiseitelegen statt loeschen'
      );
      return true;
    },
    'ein eigenes Journal darf nicht zum Wegwerfen empfohlen werden'
  );
  laufend.close();
});

test('ein liegengebliebenes Write-Ahead-Log wird als eigene Ursache genannt', async () => {
  const quelle = await backupFromInstance('schluessel-der-alten-instanz-0123');
  const dir = tmpDir();
  const eigene = join(dir, 'yuvomi.db');
  copyFileSync(quelle, eigene);

  // Ein echtes, ungecheckpointetes WAL einer FREMDEN Datenbank danebenlegen -
  // genau das bleibt liegen, wenn jemand die .db-Datei von Hand tauscht. Die
  // Datei selbst ist einwandfrei und der Schluessel stimmt; trotzdem scheitert
  // das Oeffnen, weil SQLite die Frames des fremden Journals mitliest. Genau
  // diese Kombination hat in #1267 wie ein falscher Schluessel ausgesehen.
  const fremdDir = tmpDir();
  const fremd = join(fremdDir, 'fremd.db');
  const offen = new Database(fremd);
  offen.pragma("cipher = 'sqlcipher'");
  offen.pragma(`key="x'${Buffer.from('schluessel-der-neuen-instanz-0123', 'utf8').toString('hex')}'"`);
  offen.pragma('journal_mode = WAL');
  offen.exec('CREATE TABLE fremd_marker (a INTEGER)');
  offen.prepare('INSERT INTO fremd_marker VALUES (1)').run();
  // Bewusst NICHT schliessen: close() checkpointet und raeumt das WAL weg.
  copyFileSync(`${fremd}-wal`, `${eigene}-wal`);
  offen.close();

  await assert.rejects(
    () => bootDb(eigene, 'schluessel-der-alten-instanz-0123'),
    (err) => {
      assert.match(
        err.message,
        /write-ahead log is lying next to the database/,
        'die zweite Ursache muss genannt werden - der Schluessel stimmt hier ja'
      );
      assert.match(
        err.message,
        /only a cause of this error if you replaced the database file by hand/,
        'und zwar BEDINGT: von hier aus ist nicht zu sehen, ob das Journal dazugehoert'
      );
      assert.match(err.message, /-wal/, 'die Meldung muss die Datei benennen, die weg muss');
      assert.match(err.message, /-shm/, 'und die zweite dazu - eine allein reicht nicht');
      return true;
    },
    'ein fremdes WAL darf nicht als falscher Schluessel durchgehen'
  );
});

test('ohne liegengebliebenes Log schweigt die Meldung davon', async () => {
  const quelle = await backupFromInstance('schluessel-der-alten-instanz-0123');
  const dir = tmpDir();
  const eigene = join(dir, 'yuvomi.db');
  copyFileSync(quelle, eigene);
  assert.ok(!existsSync(`${eigene}-wal`), 'Vorbedingung: hier liegt kein Journal');

  // Die Gegenrichtung, und sie ist kein Beiwerk: ein Absatz ueber eine Datei,
  // die es nicht gibt, schickt in eine Richtung, in der nichts zu finden ist -
  // dieselbe Art Fehler wie die Auskunft, die diesen Befund ausgeloest hat.
  await assert.rejects(
    () => bootDb(eigene, 'ein-ganz-anderer-schluessel-0123'),
    (err) => {
      assert.ok(
        !/write-ahead log is lying next to the database/.test(err.message),
        'ohne Journal darf die Meldung keines erfinden'
      );
      return true;
    },
    'die WAL-Diagnose darf nicht unbedingt erscheinen'
  );
});

/*
 * ---------------------------------------------------------------------------
 * #1267, dritte Runde: der Startabbruch unterscheidet nach dem SQLite-Code.
 *
 * `init()` hat jeden Fehler beim ersten Lesen als falschen Schluessel gemeldet,
 * ohne `err.code` anzusehen. Gemessen sind aber Faelle, in denen der Schluessel
 * nachweislich STIMMT: eine abgeschnittene Kopie liefert mit dem richtigen Key
 * `SQLITE_CORRUPT` (mit falschem Key dieselbe Datei `SQLITE_NOTADB`), eine
 * WAL-Datenbank in einem Verzeichnis ohne Schreibrecht
 * `SQLITE_READONLY_DIRECTORY`, ein `-wal` ohne Zugriffsrecht `SQLITE_CANTOPEN`.
 * Wer dort „Wrong encryption key" liest, sucht am Schluessel, der in Ordnung ist.
 *
 * Und der Rueckweg der Key-Meldung („change it back") galt nur fuer den, der
 * ALLEIN den Schluessel getauscht hat. Wer Datei und Schluessel zusammen
 * ersetzt hat - der richtige Weg, und genau der des Melders -, wurde damit in
 * denselben Abbruch zurueckgeschickt.
 *
 * Jeder Fall prueft deshalb zuerst den SQLite-Code direkt (sonst misst er am
 * Ende einen anderen Zweig als behauptet) und BEFOLGT danach den Rat der
 * Meldung auf demselben Stand: eine Meldung, die einen Handgriff empfiehlt, ist
 * ausfuehrbarer Rat, und erst der Start danach zeigt, ob er traegt.
 * ---------------------------------------------------------------------------
 */

/** SQLite-Code beim ersten Lesen mit diesem Key - `null`, wenn es gelingt. */
function sqliteCodeOnFirstRead(filePath, key) {
  const handle = new Database(filePath);
  try {
    handle.pragma("cipher = 'sqlcipher'");
    handle.pragma(`key="x'${Buffer.from(key, 'utf8').toString('hex')}'"`);
    handle.prepare('SELECT count(*) FROM sqlite_master').get();
    return null;
  } catch (err) {
    return err.code;
  } finally {
    handle.close();
  }
}

function sha256(filePath) {
  return createHash('sha256').update(readFileSync(filePath)).digest('hex');
}

/** Saetze einer Meldung - ein Punkt im Dateinamen (`yuvomi.db`) trennt keinen. */
function saetze(message) {
  return message.split(/(?<=\.)\s+(?=[A-Z])/);
}

test('nur den Schluessel getauscht: „change it back" gilt fuer genau diesen Fall und fuehrt zurueck', async () => {
  const dir = tmpDir();
  const eigene = join(dir, 'yuvomi.db');
  const KEY_EIGEN = 'schluessel-dieser-instanz-0123456';
  const KEY_GETAUSCHT = 'schluessel-einer-anderen-instanz-01';

  const laufend = await bootDb(eigene, KEY_EIGEN);
  laufend.get().exec('CREATE TABLE eigener_marker (note TEXT)');
  laufend.get().prepare('INSERT INTO eigener_marker VALUES (?)').run('vor-dem-tausch');
  laufend.get().close(); // sauberer Stopp: kein -wal, der WAL-Absatz spricht hier nicht mit
  assert.equal(
    sqliteCodeOnFirstRead(eigene, KEY_GETAUSCHT),
    'SQLITE_NOTADB',
    'Vorbedingung: ein falscher Key scheitert an Seite 1'
  );

  await assert.rejects(
    () => bootDb(eigene, KEY_GETAUSCHT),
    (err) => {
      assert.match(err.message, /Wrong encryption key/, 'NOTADB bleibt die Key-Meldung');
      const rueckweg = saetze(err.message).find((satz) => /change it back/.test(satz));
      assert.ok(rueckweg, 'der Rueckweg muss genannt sein');
      assert.match(
        rueckweg,
        /changed only DB_ENCRYPTION_KEY and left the database file as it was/,
        'der Rat „change it back" traegt nur, wenn allein der Key getauscht wurde - und muss das selbst sagen'
      );
      return true;
    },
    'die Key-Meldung muss ihren Rueckweg auf den reinen Schluesseltausch beschraenken'
  );

  // Den Rat befolgen: Key zurueck, und die Instanz ist wieder da, mit ihren Daten.
  const zurueck = await bootDb(eigene, KEY_EIGEN);
  assert.equal(
    zurueck.get().prepare('SELECT note FROM eigener_marker').get()?.note,
    'vor-dem-tausch',
    'nach dem Zuruecktauschen muss die eigene Datenbank wieder starten'
  );
});

test('Datei und Schluessel zusammen ersetzt: der Rat schickt nicht zurueck, sondern trennt Datei und Schluessel', async () => {
  // Die Lage des Melders: die Zielinstanz hatte ihre eigene Datenbank mit ihrem
  // eigenen Key. Er hat das Backup an ihre Stelle gelegt und den Key der Quelle
  // gesetzt - nur kam der nicht Byte fuer Byte an. Hier ist es ein Backslash,
  // den systemds EnvironmentFile in einer unquotierten Zeile verschluckt.
  const KEY_QUELLE = 'quell\\schluessel-mit-backslash-0123';
  const KEY_ANGEKOMMEN = 'quellschluessel-mit-backslash-0123';
  const KEY_ZIEL = 'eigener-schluessel-der-zielinstanz-01';
  const backupPath = await backupFromInstance(KEY_QUELLE);

  const dir = tmpDir();
  const ziel = join(dir, 'yuvomi.db');
  const vorher = await bootDb(ziel, KEY_ZIEL);
  vorher.get().close();
  copyFileSync(backupPath, ziel);
  assert.ok(!existsSync(`${ziel}-wal`), 'Vorbedingung: kein Journal, die Meldung spricht nur ueber Datei und Key');
  assert.equal(
    sqliteCodeOnFirstRead(ziel, KEY_ANGEKOMMEN),
    'SQLITE_NOTADB',
    'Vorbedingung: der verschluckte Backslash macht einen anderen Key'
  );

  await assert.rejects(
    () => bootDb(ziel, KEY_ANGEKOMMEN),
    (err) => {
      assert.match(
        err.message,
        /replaced the database file and the key together, changing the key back will not help/,
        'die Meldung muss den Fall kennen, in dem „change it back" in denselben Abbruch fuehrt'
      );
      assert.match(
        err.message,
        /Compare the size and sha256sum of .*yuvomi\.db with the original file; if they differ, copy the file again/,
        'erste Probe: die Datei gegen das Original, ohne etwas zu veraendern'
      );
      assert.match(
        err.message,
        /If they match, the key Yuvomi was started with is not, byte for byte, the one the file was written with/,
        'zweite Probe: stimmt die Datei, ist es der Key - nicht „der richtige Key", sondern seine Bytes'
      );
      assert.match(
        err.message,
        /drops a backslash in an unquoted value/,
        'die Regel, die hier den Key veraendert hat, muss genannt sein'
      );
      assert.ok(!/\bdelete\b/i.test(err.message), 'kein Rat zum Loeschen');
      return true;
    },
    'wer Datei und Key zusammen ersetzt hat, braucht eine andere Auskunft als „change it back"'
  );

  // Den Rat befolgen, erste Probe: Groesse und Pruefsumme stimmen, also ist es der Key.
  assert.equal(sha256(ziel), sha256(backupPath), 'die Datei ist unversehrt - die Probe zeigt auf den Key');

  // Warum der Rueckweg hier nicht reicht: mit dem alten Key der Zielinstanz
  // oeffnet die eingesetzte Datei genauso wenig.
  await assert.rejects(
    () => bootDb(ziel, KEY_ZIEL),
    /Wrong encryption key/,
    '„change it back" fuehrt nach einem Dateitausch in denselben Abbruch'
  );

  // Zweite Probe: der Key Byte fuer Byte wie in der Quelle, und die Instanz startet.
  const mod = await bootDb(ziel, KEY_QUELLE);
  assert.doesNotThrow(
    () => mod.get().prepare('SELECT count(*) FROM sqlite_master').get(),
    'mit dem Key der Quelle muss die ersetzte Datei starten'
  );
});

test('eine abgeschnittene Kopie mit richtigem Schluessel heisst beschaedigt, nicht Wrong encryption key', async () => {
  const KEY_QUELLE = 'schluessel-der-alten-instanz-0123';
  const backupPath = await backupFromInstance(KEY_QUELLE);
  const dir = tmpDir();
  const eigene = join(dir, 'yuvomi.db');
  // Eine Uebertragung, die nach der ersten Seite abgerissen ist.
  writeFileSync(eigene, readFileSync(backupPath).subarray(0, 4096));
  assert.equal(
    sqliteCodeOnFirstRead(eigene, KEY_QUELLE),
    'SQLITE_CORRUPT',
    'Vorbedingung: mit dem richtigen Key meldet SQLite CORRUPT'
  );
  assert.equal(
    sqliteCodeOnFirstRead(eigene, 'ein-ganz-anderer-schluessel-0123'),
    'SQLITE_NOTADB',
    'Vorbedingung: mit falschem Key meldet dieselbe Datei NOTADB - erst das belegt, dass CORRUPT den Key bestaetigt'
  );

  await assert.rejects(
    () => bootDb(eigene, KEY_QUELLE),
    (err) => {
      assert.match(err.message, /is damaged or incomplete \(SQLITE_CORRUPT/, 'Befund und Code gehoeren in die Meldung');
      assert.ok(!/Wrong encryption key/.test(err.message), 'der Key stimmt - die Meldung darf ihn nicht beschuldigen');
      assert.ok(!/change it back/.test(err.message), 'und keinen Schluesseltausch raten');
      assert.match(err.message, /changing the key will not help/, 'sie muss vom Weg am Key wegfuehren');
      assert.match(
        err.message,
        /copy it again from the original and compare its size and sha256sum with the original/,
        'und den Weg nennen, der traegt'
      );
      return true;
    },
    'eine unvollstaendige Kopie darf nicht als falscher Schluessel durchgehen'
  );

  // Den Rat befolgen: vollstaendig neu kopieren, Pruefsumme vergleichen, starten.
  copyFileSync(backupPath, eigene);
  assert.equal(sha256(eigene), sha256(backupPath), 'die neue Kopie stimmt mit dem Original ueberein');
  const mod = await bootDb(eigene, KEY_QUELLE);
  assert.doesNotThrow(
    () => mod.get().prepare('SELECT count(*) FROM sqlite_master').get(),
    'mit vollstaendiger Kopie und demselben Key muss die Instanz starten'
  );
});

const ALS_ROOT = typeof process.getuid === 'function' && process.getuid() === 0;

test(
  'ein Datenverzeichnis ohne Schreibrecht nennt den Code und behauptet nichts ueber den Schluessel',
  { skip: ALS_ROOT && 'root ignoriert Dateirechte - der Fall ist so nicht herstellbar' },
  async () => {
    const dir = tmpDir();
    const eigene = join(dir, 'yuvomi.db');
    const laufend = await bootDb(eigene, KEY);
    laufend.get().close(); // -wal und -shm sind weg, journal_mode = WAL steht in der Datei
    chmodSync(dir, 0o555);
    try {
      assert.equal(
        sqliteCodeOnFirstRead(eigene, KEY),
        'SQLITE_READONLY_DIRECTORY',
        'Vorbedingung: richtiger Key, aber SQLite kann sein Journal nicht anlegen'
      );

      await assert.rejects(
        () => bootDb(eigene, KEY),
        (err) => {
          assert.match(err.message, /could not be read \(SQLITE_READONLY_DIRECTORY: /, 'Code und SQLite-Text gehoeren in die Meldung');
          assert.ok(
            !/encryption key|DB_ENCRYPTION_KEY|decrypt/i.test(err.message),
            'kein Wort ueber den Key - er ist hier nicht beteiligt'
          );
          assert.match(err.message, /needs read and write access to the database file/, 'der Rat muss die Rechte nennen');
          assert.ok(
            err.message.includes(`permissions of ${dir} `),
            'und das Verzeichnis, dessen Rechte zu pruefen sind'
          );
          return true;
        },
        'ein Rechteproblem darf nicht als falscher Schluessel durchgehen'
      );

      // Den Rat befolgen: Schreibrecht zurueck, dieselbe Datei startet mit demselben Key.
      chmodSync(dir, 0o755);
      const wieder = await bootDb(eigene, KEY);
      assert.doesNotThrow(
        () => wieder.get().prepare('SELECT count(*) FROM sqlite_master').get(),
        'mit Schreibrecht auf das Verzeichnis muss die Instanz starten'
      );
    } finally {
      chmodSync(dir, 0o755);
    }
  }
);

test(
  'ein Journal ohne Zugriffsrecht nennt den Code und behauptet nichts ueber den Schluessel',
  { skip: ALS_ROOT && 'root ignoriert Dateirechte - der Fall ist so nicht herstellbar' },
  async () => {
    const dir = tmpDir();
    const eigene = join(dir, 'yuvomi.db');
    const laufend = await bootDb(eigene, KEY);
    laufend.get().close();
    // Ein -wal, das dem Dienst nicht gehoert - etwa von einem Lauf unter einem
    // anderen Benutzer liegengeblieben.
    const wal = `${eigene}-wal`;
    writeFileSync(wal, '');
    chmodSync(wal, 0o000);
    try {
      assert.equal(sqliteCodeOnFirstRead(eigene, KEY), 'SQLITE_CANTOPEN', 'Vorbedingung: richtiger Key, Journal unzugaenglich');

      await assert.rejects(
        () => bootDb(eigene, KEY),
        (err) => {
          assert.match(err.message, /could not be read \(SQLITE_CANTOPEN: /, 'Code und SQLite-Text gehoeren in die Meldung');
          assert.ok(
            !/encryption key|DB_ENCRYPTION_KEY|decrypt/i.test(err.message),
            'kein Wort ueber den Key - er ist hier nicht beteiligt'
          );
          assert.ok(err.message.includes(wal), 'der Rat muss das Journal nennen, an dem es haengt');
          assert.match(err.message, /Check the owner and permissions of/, 'und sagen, was zu pruefen ist');
          assert.ok(!/\bdelete\b/i.test(err.message), 'kein Rat zum Loeschen - das Journal kann Daten tragen');
          return true;
        },
        'ein unzugaengliches Journal darf nicht als falscher Schluessel durchgehen'
      );

      // Den Rat befolgen: Rechte am Journal geradeziehen, und die Instanz startet.
      chmodSync(wal, 0o644);
      const wieder = await bootDb(eigene, KEY);
      assert.doesNotThrow(
        () => wieder.get().prepare('SELECT count(*) FROM sqlite_master').get(),
        'mit Zugriff auf das Journal muss die Instanz starten'
      );
    } finally {
      chmodSync(wal, 0o644);
    }
  }
);
