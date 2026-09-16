/**
 * Test: Der voreingestellte Monat der Budget-Ansichten folgt der Haushaltszone
 *
 * Zweck: `GET /budget/summary` und `GET /budget/` bilden ohne `?month=` selbst
 *        einen Monat. Das ist eine FRAGE AN DIE UHR, und die folgt der
 *        Haushaltszone - nicht UTC. Beide Stellen nahmen
 *        `new Date().toISOString().slice(0, 7)`, den UTC-Monat: oestlich von
 *        UTC zeigen sie am Ersten frueh noch den Vormonat, westlich davon am
 *        Letzten abends schon den naechsten.
 *
 * WARUM DIESE SUITE NEBEN DEM GUARD STEHT. `test:household-timezone` verbietet
 * die Schreibweise im Quelltext, und das ist wertvoll, aber es ist eine
 * Textsuche: sie belegt nicht, dass der AUFRUFER den richtigen Monat
 * herausgibt, und sie saehe nicht, wenn jemand denselben Fehler anders
 * schreibt. Hier faehrt der echte Server mit einer echten Zone und wird
 * gefragt.
 *
 * DIE UHR WIRD GESTELLT, UND ZWAR AUF DEN RAND. Ein Test zur Monatsmitte waere
 * in jeder Zone gruen und wuerde nichts messen: der Unterschied zwischen dem
 * UTC-Monat und dem Haushaltsmonat existiert nur fuer ein paar Stunden am
 * Monatswechsel. Gewaehlt ist der 31.08. um 20:00 UTC; in Pacific/Kiritimati
 * (UTC+14) ist es dann bereits der 01.09., also September gegen August. Beide
 * Werte kommen im Test vor, damit ein Rot zeigt, welcher gewonnen hat.
 *
 * Ausfuehren: node --experimental-sqlite --test test/test-budget-month-zone.js
 */
import { test, mock } from 'node:test';
import assert from 'node:assert/strict';

import { startTestServer, cookieHeader } from './server-ready.js';

const { baseUrl: BASE } = await startTestServer({
  name: 'budget-month-zone',
  env: { SESSION_SECRET: 'test-budget-month-zone-secret-min32c' },
});
const dbmod = await import('../server/db.js');
const db = dbmod.get();

await fetch(`${BASE}/api/v1/auth/setup`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ username: 'admin', display_name: 'Admin', password: 'adminpass123' }),
});
const login = await fetch(`${BASE}/api/v1/auth/login`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ username: 'admin', password: 'adminpass123' }),
});
assert.equal(login.status, 200, 'Anmeldung');
const COOKIE = cookieHeader(login.headers.get('set-cookie'));

/** Die Haushaltszone setzen - dieselbe Stelle, die die Einstellungsseite schreibt. */
function setzeZone(zone) {
  db.prepare(`
    INSERT INTO sync_config (key, value) VALUES ('household_timezone', ?)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value
  `).run(zone);
}

async function summaryMonat() {
  const res = await fetch(`${BASE}/api/v1/budget/summary`, { headers: { Cookie: COOKIE } });
  assert.equal(res.status, 200);
  return (await res.json()).data.month;
}

// 31.08.2026, 20:00 UTC. In Pacific/Kiritimati (UTC+14) ist es der 01.09.,
// in Pacific/Niue (UTC-11) noch der 31.08. - beide Male ein anderer Monat als
// der, den die jeweils andere Zone sieht, und einmal ein anderer als UTC.
const RANDZEIT = new Date('2026-08-31T20:00:00Z');

test('oestlich von UTC gilt der Monat des Haushalts, nicht der von UTC', async () => {
  setzeZone('Pacific/Kiritimati');
  mock.timers.enable({ apis: ['Date'], now: RANDZEIT });
  try {
    assert.equal(new Date().toISOString().slice(0, 7), '2026-08', 'UTC steht auf August');
    assert.equal(await summaryMonat(), '2026-09',
      'der Haushalt steht auf September, und der zaehlt');
  } finally {
    mock.timers.reset();
  }
});

test('westlich von UTC ebenso - und dort ist es der Vormonat', async () => {
  // DIE GEGENRICHTUNG, und sie ist nicht Zierde: eine Fassung, die einfach
  // einen Tag addierte, waere im Test darueber gruen. Hier muss sie beim
  // August bleiben, waehrend UTC am 01.09. schon weiter waere.
  setzeZone('Pacific/Niue');
  mock.timers.enable({ apis: ['Date'], now: new Date('2026-09-01T05:00:00Z') });
  try {
    assert.equal(new Date().toISOString().slice(0, 7), '2026-09', 'UTC steht auf September');
    assert.equal(await summaryMonat(), '2026-08',
      'in Pacific/Niue ist noch August');
  } finally {
    mock.timers.reset();
  }
});

test('die Eintragsliste nennt denselben Monat wie die Zusammenfassung darueber', async () => {
  // SIE STEHEN AUF EINER SEITE. Zwei Vorgaben, die auseinanderlaufen, zeigten
  // fuer ein paar Stunden im Monat eine Zusammenfassung ueber einem Zeitraum,
  // aus dem die Liste darunter nicht stammt - der unangenehmste Fall, weil
  // beides einzeln plausibel aussieht.
  setzeZone('Pacific/Kiritimati');
  mock.timers.enable({ apis: ['Date'], now: RANDZEIT });
  try {
    const monat = await summaryMonat();
    const res = await fetch(`${BASE}/api/v1/budget/`, { headers: { Cookie: COOKIE } });
    assert.equal(res.status, 200);
    // Die Liste gibt den Monat nicht zurueck, also wird er ueber die Wirkung
    // gemessen: derselbe Aufruf mit ausdruecklichem `?month=` muss dieselbe
    // Antwort liefern wie der ohne.
    const explizit = await fetch(`${BASE}/api/v1/budget/?month=${monat}`, { headers: { Cookie: COOKIE } });
    assert.equal(explizit.status, 200);
    assert.deepEqual(await res.json(), await explizit.json(),
      `die Liste ohne month muss ${monat} meinen`);
  } finally {
    mock.timers.reset();
  }
});

test('ohne gesetzte Haushaltszone bleibt alles wie zuvor', async () => {
  // Die Rueckwaertsvertraeglichkeit: eine Bestandsinstallation hat den
  // Schluessel nicht, und `householdTimeZone` faellt dann auf die
  // Container-Zone zurueck. Der Test darf also keine bestimmte Antwort
  // verlangen, nur eine gueltige - und vor allem keinen Fehler.
  db.prepare("DELETE FROM sync_config WHERE key = 'household_timezone'").run();
  mock.timers.enable({ apis: ['Date'], now: RANDZEIT });
  try {
    assert.match(await summaryMonat(), /^\d{4}-\d{2}$/);
  } finally {
    mock.timers.reset();
  }
});
