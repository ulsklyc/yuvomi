/**
 * Modul: Aufräumen übernommener Sync-Termine (#820)
 * Zweck: Nach dem Trennen eines Google-/Apple-Kontos blieben die schon
 *        übernommenen Termine ohne jeden Ausgang liegen - kein Sync fasst sie
 *        wieder an, und ein erneutes Verbinden legte sie ein zweites Mal an.
 *        Geprüft wird, dass das Aufräumen genau seine Quelle trifft und alles
 *        andere in Ruhe lässt.
 * Ausführen: node test/test-calendar-mirrored-cleanup.js
 */
process.env.DB_PATH = ':memory:';

import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

const db = (await import('../server/db.js')).get();
const { countSourceEvents, deleteSourceEvents } = await import('../server/services/calendar-prune.js');
const googleCalendar = await import('../server/services/google-calendar.js');
const appleCalendar = await import('../server/services/apple-calendar.js');

db.prepare(`INSERT INTO users (username, display_name, password_hash, role)
  VALUES ('admin', 'Admin', 'x', 'admin')`).run();

/** Ein Termin je Quelle - external_source ist der einzige Unterschied. */
function seedEvent(source, title) {
  return db.prepare(`
    INSERT INTO calendar_events (title, start_datetime, all_day, external_source, external_calendar_id, created_by)
    VALUES (?, '2026-06-25T09:00:00Z', 0, ?, ?, 1)
  `).run(title, source, `${title}@x`).lastInsertRowid;
}

function titles() {
  return db.prepare('SELECT title FROM calendar_events ORDER BY title').all().map((r) => r.title);
}

function connectGoogle() {
  for (const [k, v] of [['google_access_token', 'a'], ['google_refresh_token', 'r']]) {
    db.prepare('INSERT OR REPLACE INTO sync_config (key, value) VALUES (?, ?)').run(k, v);
  }
}

function connectApple() {
  for (const [k, v] of [['apple_caldav_url', 'https://caldav.icloud.com'],
    ['apple_username', 'a@b.c'], ['apple_app_password', 'pw']]) {
    db.prepare('INSERT OR REPLACE INTO sync_config (key, value) VALUES (?, ?)').run(k, v);
  }
}

beforeEach(() => {
  db.prepare('DELETE FROM calendar_events').run();
  db.prepare('DELETE FROM sync_config').run();
});

describe('Aufräumen übernommener Termine: der Schnitt liegt an der Quelle (#820)', () => {
  it('zählt nur die eigene Quelle', () => {
    seedEvent('google', 'G1');
    seedEvent('google', 'G2');
    seedEvent('apple', 'A1');
    seedEvent('local', 'L1');

    assert.equal(countSourceEvents(db, 'google'), 2);
    assert.equal(countSourceEvents(db, 'apple'), 1);
  });

  it('löscht nur die eigene Quelle - lokale und fremde Termine bleiben', () => {
    seedEvent('google', 'G1');
    seedEvent('apple', 'A1');
    seedEvent('caldav', 'C1');
    seedEvent('ics', 'I1');
    seedEvent('local', 'L1');

    assert.equal(deleteSourceEvents(db, 'google'), 1);
    // Die drei anderen Sync-Quellen haben eigene Wege (Abo löschen, Konto
    // löschen) - ein Aufräumen, das sie mitnimmt, wäre stiller Datenverlust.
    assert.deepEqual(titles(), ['A1', 'C1', 'I1', 'L1']);
  });

  it('ohne passende Termine ist es ein No-Op, kein Fehler', () => {
    seedEvent('local', 'L1');
    assert.equal(deleteSourceEvents(db, 'google'), 0);
    assert.deepEqual(titles(), ['L1']);
  });
});

describe('Google: Trennen räumt nur auf Ansage auf (#820)', () => {
  it('meldet die Zahl im Status, damit die Rückfrage sie nennen kann', () => {
    connectGoogle();
    seedEvent('google', 'G1');
    seedEvent('google', 'G2');
    seedEvent('local', 'L1');
    assert.equal(googleCalendar.getStatus().mirroredEvents, 2);
  });

  it('nennt die Zahl auch im GETRENNTEN Zustand', () => {
    // Der eigentliche Fall des Melders: getrennt, und der Rückstand liegt noch da.
    // Käme die Zahl nur bei bestehender Verbindung, könnte die UI den Aufräum-Weg
    // genau dann nicht anbieten, wenn er gebraucht wird.
    seedEvent('google', 'G1');
    const status = googleCalendar.getStatus();
    assert.equal(status.connected, false);
    assert.equal(status.mirroredEvents, 1);
  });

  it('Trennen ohne Flag lässt die Termine stehen', () => {
    connectGoogle();
    seedEvent('google', 'G1');
    seedEvent('local', 'L1');

    const { removed } = googleCalendar.disconnect();
    assert.equal(removed, 0);
    assert.equal(googleCalendar.getStatus().connected, false);
    assert.deepEqual(titles(), ['G1', 'L1']);
  });

  it('Trennen mit deleteEvents nimmt die übernommenen Termine mit', () => {
    connectGoogle();
    seedEvent('google', 'G1');
    seedEvent('google', 'G2');
    seedEvent('local', 'L1');

    const { removed } = googleCalendar.disconnect({ deleteEvents: true });
    assert.equal(removed, 2);
    assert.equal(googleCalendar.getStatus().connected, false);
    // Der lokale Termin bleibt: er war nie eine Kopie von irgendwo.
    assert.deepEqual(titles(), ['L1']);
  });

  it('räumt auch nachträglich auf, ohne die Verbindung anzufassen', () => {
    // Wer schon getrennt hat, kommt an den Rückstand sonst nur noch Termin für
    // Termin heran - genau die Lücke aus #820.
    seedEvent('google', 'G1');
    seedEvent('apple', 'A1');

    assert.equal(googleCalendar.clearMirroredEvents(), 1);
    assert.deepEqual(titles(), ['A1']);
  });
});

describe('Apple: Trennen räumt nur auf Ansage auf (#820)', () => {
  it('meldet die Zahl im Status', () => {
    seedEvent('apple', 'A1');
    seedEvent('google', 'G1');
    assert.equal(appleCalendar.getStatus().mirroredEvents, 1);
  });

  it('Trennen ohne Flag lässt die Termine stehen', () => {
    connectApple();
    seedEvent('apple', 'A1');

    const { removed } = appleCalendar.clearCredentials();
    assert.equal(removed, 0);
    assert.equal(appleCalendar.getStatus().connected, false);
    assert.deepEqual(titles(), ['A1']);
  });

  it('Trennen mit deleteEvents nimmt nur die Apple-Termine mit', () => {
    connectApple();
    seedEvent('apple', 'A1');
    seedEvent('google', 'G1');
    seedEvent('local', 'L1');

    const { removed } = appleCalendar.clearCredentials({ deleteEvents: true });
    assert.equal(removed, 1);
    assert.deepEqual(titles(), ['G1', 'L1']);
  });

  it('der fehlgeschlagene Verbindungstest räumt keine Termine weg', () => {
    // POST /apple/connect ruft clearCredentials() im Fehlerpfad, um die gerade
    // gespeicherten Zugangsdaten zurückzunehmen. Bekäme es dort das Löschen als
    // Vorgabe mit, kostete ein Tippfehler im Passwort den ganzen Kalender.
    connectApple();
    seedEvent('apple', 'A1');

    appleCalendar.clearCredentials();
    assert.deepEqual(titles(), ['A1']);
  });
});
