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
import { mkdtempSync, existsSync, readFileSync, readdirSync, copyFileSync, writeFileSync } from 'node:fs';
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
