/**
 * Modul: Zuweisung nachtragen - Rueckfrage mit Einzelliste (#1307), Browser-Sonde
 * Zweck: Termine, die vor #1306 in einen anderen Kalender umgezogen sind, stehen
 *        in der Rueckfrage einzeln zur Wahl, und nur die abgehakten gehen mit
 *        der Bestaetigung an den Server.
 * Ausfuehren: npm run test:backfill-review-browser (haengt an test:document-guards)
 *
 * WARUM IM BROWSER: `test:calendar-routes` misst die Route mit einem `moves`,
 * das der Test selbst schreibt. Ob die Oberflaeche ueberhaupt eines schickt -
 * und genau die abgehakten Zeilen -, sieht keine Route. Der Seed hat keine
 * Sync-Konten; die Sonde beantwortet deshalb GET und POST der Aktion selbst
 * (Request-Interception des Harness) und liest den Body, den die Seite schickt.
 */

import { test, before, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { startHarness, openPage, gotoRoute, clickPastDeadTime } from './document-guards-harness.js';

let harness;

before(async () => {
  harness = await startHarness();
});

beforeEach(async () => {
  await harness.reset();
});

after(async () => {
  await harness?.close();
});

const ENDPOINT = '/api/v1/calendar/external-calendars/default-assignee-backfill';
const TOKEN = 'a'.repeat(64);

const MOVED = [
  {
    event_id: 41, title: 'Zahnarzt <Probe>', start_datetime: '2036-02-04T10:00', all_day: 0,
    calendar_name: 'Familie', from_user_id: 2, from_name: 'Maria', to_user_id: 3, to_name: 'Tom',
  },
  {
    event_id: 42, title: 'Schwimmen', start_datetime: '2036-02-05', all_day: 1,
    calendar_name: 'Familie', from_user_id: 2, from_name: 'Maria', to_user_id: 3, to_name: 'Tom',
  },
];

/** Beantwortet die Aktion selbst und merkt sich jeden POST-Body. */
function interceptBackfill(page, { count, moved, movedTotal = moved.length }) {
  const posts = [];
  page.__yuvomiRequestInterceptor = (req) => {
    if (!req.url().includes(ENDPOINT)) return false;
    if (req.method() === 'GET') {
      req.respond({ status: 200, contentType: 'application/json', body: JSON.stringify({ data: { count, token: TOKEN, moved, moved_total: movedTotal } }) });
      return true;
    }
    if (req.method() === 'POST') {
      posts.push(JSON.parse(req.postData() || '{}'));
      req.respond({ status: 200, contentType: 'application/json', body: JSON.stringify({ data: { assigned: 1 } }) });
      return true;
    }
    return false;
  };
  return posts;
}

async function openReview(page) {
  await gotoRoute(page, '/settings/sync/calendar');
  await page.waitForSelector('#sync-default-assignee-backfill-btn');
  await page.click('#sync-default-assignee-backfill-btn');
  await page.waitForSelector('#backfill-review-form .backfill-moved__item');
}

test('die Rueckfrage listet jeden umgezogenen Termin und schickt nur die abgehakten (#1307)', async () => {
  const page = await openPage(harness, { device: 'desktop' });
  try {
    const posts = interceptBackfill(page, { count: 3, moved: MOVED });
    await openReview(page);

    const rows = await page.$$eval('.backfill-moved__item', (items) => items.map((item) => ({
      checked: item.querySelector('input[type="checkbox"]').checked,
      title: item.querySelector('.backfill-moved__title').textContent,
      change: item.querySelector('.backfill-moved__change').textContent,
      meta: item.querySelector('.backfill-moved__meta').textContent,
    })));
    assert.equal(rows.length, 2);
    assert.deepEqual(rows.map((r) => r.checked), [true, true], 'alle vorausgewaehlt');
    assert.equal(rows[0].title, 'Zahnarzt <Probe>', 'der Titel als Text, nicht als Markup');
    assert.equal(rows[0].change, 'Von Maria zu Tom');
    assert.match(rows[0].meta, /Familie/);
    assert.match(await page.$eval('#backfill-review-form', (f) => f.textContent), /3 Termine ohne Zuweisung/);

    // Den ersten abwaehlen: er bleibt, wie er ist.
    await clickPastDeadTime(page, '.backfill-moved__item:first-child input[type="checkbox"]');
    assert.equal(await page.$eval('#backfill-moved-all', (b) => b.indeterminate), true, '"Alle" zeigt die Teilauswahl');
    await page.click('#backfill-review-ok');
    await page.waitForFunction(() => !document.querySelector('#backfill-review-form'));
    await page.waitForFunction(() => document.querySelector('.toast'));

    assert.equal(posts.length, 1);
    assert.deepEqual(posts[0], {
      expected_count: 3,
      expected_token: TOKEN,
      moves: [{ event_id: 42, from_user_id: 2, to_user_id: 3 }],
    });
  } finally {
    await page.close();
  }
});

test('ohne leere Termine und ohne Haken gibt es nichts zu bestaetigen (#1307)', async () => {
  const page = await openPage(harness, { device: 'desktop' });
  try {
    const posts = interceptBackfill(page, { count: 0, moved: MOVED });
    await openReview(page);
    assert.equal(await page.$('#backfill-review-form .backfill-review__part h3'), null, 'kein Abschnitt fuer leere Termine');

    await clickPastDeadTime(page, '#backfill-moved-all');
    assert.equal(await page.$eval('#backfill-review-ok', (b) => b.disabled), true);
    await page.click('#backfill-moved-all');
    assert.equal(await page.$eval('#backfill-review-ok', (b) => b.disabled), false);

    await page.click('#backfill-review-cancel');
    await page.waitForFunction(() => !document.querySelector('#backfill-review-form'));
    assert.equal(posts.length, 0, 'Abbrechen schickt nichts');
  } finally {
    await page.close();
  }
});

test('eine gekuerzte Liste sagt, wie viele es insgesamt sind (#1307)', async () => {
  // Der Server liefert hoechstens so viele, wie eine Bestaetigung annimmt
  // (movedCandidatesLimit); `moved_total` nennt den Rest.
  const page = await openPage(harness, { device: 'desktop' });
  try {
    interceptBackfill(page, { count: 0, moved: MOVED, movedTotal: 5 });
    await openReview(page);
    assert.equal(
      await page.$eval('.backfill-moved__partial', (p) => p.textContent.trim()),
      'Angezeigt werden die ersten 2 von 5. Nach dem Übernehmen erscheinen die übrigen beim nächsten Öffnen.',
    );
    await clickPastDeadTime(page, '#backfill-review-cancel');
    await page.waitForFunction(() => !document.querySelector('#backfill-review-form'));

    // Vollstaendige Liste: kein Hinweis.
    interceptBackfill(page, { count: 0, moved: MOVED });
    await page.click('#sync-default-assignee-backfill-btn');
    await page.waitForSelector('#backfill-review-form .backfill-moved__item');
    assert.equal(await page.$('.backfill-moved__partial'), null);
  } finally {
    await page.close();
  }
});
