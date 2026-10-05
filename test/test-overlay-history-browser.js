/**
 * Modul: Ein Dialog nach dem anderen und die History (#871-Nachlauf) - Browser-Sonde
 * Zweck: Geht ein Overlay zu und das naechste einen Tick spaeter auf, steht der
 *        Browser danach AUF dem Marker der Zurueck-Geste, und das Schliessen
 *        des letzten Dialogs fuehrt auf die Seite zurueck, nicht auf die davor.
 * Ausfuehren: npm run test:overlay-history-browser (haengt an test:document-guards)
 *
 * ANLASS (04.10.2026). In der Tages-, Wochen- und Monatsansicht ist die
 * Leseansicht eines Termins am Desktop ein Popover mit eigenem Eintrag im
 * Register (`components/detail-view.js`). "Bearbeiten" schliesst es und
 * oeffnet das Formular erst, wenn die Erinnerungen da sind; "Loeschen" wartet
 * das Schliessen ab und fragt bei einer Serie dann nach der Reichweite.
 * Zwischen Abmelden und Anmelden liegt ein Tick - der Abgleich in
 * `utils/overlay-history.js` hatte sein `back()` schon abgeschickt, und der
 * neue Marker entstand, bevor es ankam. Gemessen in 18 von 18 Wegen
 * (Bearbeiten, Loeschen aus der Leseansicht, Loeschen aus dem Formular; je
 * "Nur diesen Termin", "Diesen und folgende", "Ganze Serie", Abbrechen,
 * Escape, Zurueck): nach dem Schliessen zeigte die Adresse die Seite DAVOR,
 * waehrend der Kalender im Bild blieb.
 *
 * WARUM IM BROWSER. `test:overlay-history` haelt dieselbe Regel an einer
 * Attrappe, und die Attrappe stellt `popstate` so zu, wie dieser Lauf es
 * gemessen hat. Ob Chrome das beim naechsten Update noch so tut, und ob die
 * Aufrufer ihre Overlays weiter in dieser Reihenfolge wechseln, sieht nur der
 * echte Browser gegen die echte Seite.
 *
 * GEMESSEN WIRD ERST, WENN DIE HISTORY RUHT. `popstate` kommt asynchron, und
 * ein Dialog meldet sich erst nach seiner Ausgangs-Animation ab; wer sofort
 * nachsieht, liest den Stand davor und haelt ihn fuer das Ergebnis.
 */

import { test, before, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { startHarness, openPage, gotoRoute, clickPastDeadTime } from './document-guards-harness.js';

let harness;
let page;

const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const EDIT = '#detail-popover-edit';
const DELETE = '#detail-delete';

before(async () => {
  harness = await startHarness();
});

/* EIN FRISCHER STAND JE FALL, und das ist gemessen: an EINER Seite ueber zehn
 * Faelle wurde im zehnten der harte Aufruf von /tasks nach /login umgeleitet -
 * nur auf einem schnellen Rechner, also dann, wenn alle Faelle in dieselbe
 * Minute fielen (der Server laesst 300 API-Anfragen je Minute zu). "Ein
 * Zurueck danach" landete auf "/": ein roter Fall, der mit der History nichts
 * zu tun hatte. `reset()` startet den Server neu, und das Limit liegt in
 * dessen Speicher. */
beforeEach(async () => {
  await harness.reset();
  page = await openPage(harness, { device: 'desktop' });
  // Jeder History-Schritt der Seite wird mitgeschrieben: `rest()` sieht daran,
  // ob noch einer unterwegs ist, und ein roter Fall nennt die Reihenfolge.
  await page.evaluateOnNewDocument(() => {
    const log = (window.__historyLog = []);
    for (const name of ['pushState', 'replaceState', 'back', 'forward', 'go']) {
      const original = history[name];
      history[name] = function patched(...args) {
        log.push(name.endsWith('State') ? `${name}(${JSON.stringify(args[0])})` : `${name}()`);
        return original.apply(this, args);
      };
    }
    window.addEventListener('popstate', (e) => {
      log.push(`popstate -> ${location.pathname} ${JSON.stringify(e.state)}`);
    }, true);
  });
  // Die Tagesansicht: dort oeffnet ein Termin am Desktop das Popover. In der
  // Agenda steht er in der Detailspalte, und die ist kein Overlay.
  await page.evaluate(() => localStorage.setItem('yuvomi:calendar:view', 'day'));
});

after(async () => {
  await harness?.close();
});

/** Wartet, bis kein History-Schritt mehr kommt und kein Dialog mehr ausblendet. */
async function rest() {
  let last = null;
  let stable = 0;
  for (let i = 0; i < 80 && stable < 5; i += 1) {
    await wait(100);
    const now = await page.evaluate(() => `${window.__historyLog.length}/${document.querySelectorAll('.modal-overlay--closing').length}`);
    stable = now === last ? stable + 1 : 0;
    last = now;
  }
  assert.ok(stable >= 5, 'die History kommt nicht zur Ruhe');
}

async function measure() {
  await rest();
  return page.evaluate(() => ({
    path: location.pathname,
    length: history.length,
    marker: history.state?.overlay === true,
    open: document.querySelectorAll('.modal-overlay').length + (document.querySelector('#detail-view-popover') ? 1 : 0),
    calendar: Boolean(document.querySelector('#cal-body')),
    log: window.__historyLog.join(' | '),
  }));
}

let seq = 0;

/**
 * Von /tasks in den Kalender, einen Serientermin von heute oeffnen. Der Weg
 * ueber /tasks gibt der History eine Seite DAVOR, auf der ein Schritt zu viel
 * sichtbar landet.
 */
async function openOccurrence() {
  await gotoRoute(page, '/tasks');
  assert.equal(await page.evaluate(() => location.pathname), '/tasks', 'Vorbedingung: die Seite davor steht');
  seq += 1;
  const title = `History-Sonde ${seq}`;
  await page.evaluate(async (name) => {
    const { api } = await import('/api.js');
    const { todayKey } = await import('/utils/timezone.js');
    const day = todayKey();
    await api.post('/calendar', {
      title: name, start_datetime: `${day}T09:00:00`, end_datetime: `${day}T10:00:00`, recurrence_rule: 'FREQ=DAILY',
    });
  }, title);
  await page.evaluate(() => window.yuvomi.navigate('/calendar'));
  const chip = await page.waitForFunction(
    (name) => [...document.querySelectorAll('.day-event')].find((el) => el.textContent.includes(name)) || false,
    { timeout: 15000 },
    title,
  );
  const start = await measure();
  assert.equal(start.path, '/calendar');
  await chip.asElement().click();
  await page.waitForSelector('#detail-view-popover', { timeout: 8000 });
  const opened = await measure();
  assert.equal(opened.marker, true, 'Vorbedingung: die Leseansicht haelt den Marker');
  return start;
}

/** Bis zum Serien-Dialog: ueber Bearbeiten und Speichern oder ueber Loeschen. */
async function reachScopeDialog(action) {
  if (action === 'edit') {
    await page.click(EDIT);
    await page.waitForSelector('#modal-title', { timeout: 8000 });
    const form = await measure();
    assert.equal(form.marker, true,
      'das Formular ist offen, also steht der Browser auf dem Marker - sonst gibt sein Schliessen einen Eintrag zurueck, den es nie gab');
    assert.equal(form.path, '/calendar');
    await page.click('#modal-title');
    await page.type('#modal-title', ' x');
    await page.click('#modal-save');
  } else {
    await page.click(DELETE);
  }
  await page.waitForSelector('[data-scope="this"]', { timeout: 8000 });
  const dialog = await measure();
  assert.equal(dialog.marker, true, 'der Serien-Dialog ist offen, also steht der Browser auf dem Marker');
  assert.equal(dialog.path, '/calendar');
}

/** Nach dem letzten Dialog: auf der Seite, ohne Marker, und EIN Zurueck fuehrt auf die Seite davor. */
async function assertBackOnThePage(start) {
  const end = await measure();
  assert.equal(end.open, 0, 'Vorbedingung: nichts steht mehr offen');
  assert.equal(end.path, '/calendar', `die Adresse zeigt den Kalender, nicht die Seite davor (${end.log})`);
  assert.equal(end.marker, false, 'der Marker ist zurueckgegeben');
  assert.equal(end.calendar, true);
  assert.equal(end.length, start.length + 1, 'ein Marker lag darueber, nicht zwei');

  await page.evaluate(() => history.back());
  const before = await measure();
  assert.equal(before.path, '/tasks', `ein Zurueck danach fuehrt auf die Seite davor - nicht daran vorbei (${before.log})`);
  assert.equal(before.calendar, false, 'und der Router hat sie gezeichnet');
}

for (const action of ['edit', 'delete']) {
  for (const scope of ['this', 'following', 'series']) {
    test(`${action}: "${scope}" im Serien-Dialog laesst die Adresse auf dem Kalender`, async () => {
      const start = await openOccurrence();
      await reachScopeDialog(action);
      await clickPastDeadTime(page, `[data-scope="${scope}"]`);
      await page.waitForFunction(() => !document.querySelector('.modal-overlay'), { timeout: 8000 });
      await assertBackOnThePage(start);
    });
  }

  test(`${action}: Escape im Serien-Dialog, dann alles zu`, async () => {
    const start = await openOccurrence();
    await reachScopeDialog(action);
    await page.keyboard.press('Escape');
    await rest();
    // Beim Bearbeiten kommt das Formular zurueck: verwerfen.
    if (await page.$('#modal-title')) {
      await page.keyboard.press('Escape');
      await clickPastDeadTime(page, '#confirm-modal-ok', { timeout: 5000 });
    }
    await page.waitForFunction(() => !document.querySelector('.modal-overlay'), { timeout: 8000 });
    await assertBackOnThePage(start);
  });

  test(`${action}: die Zurueck-Geste schliesst den Serien-Dialog und bleibt im Kalender`, async () => {
    const start = await openOccurrence();
    await reachScopeDialog(action);
    await page.evaluate(() => history.back());
    await page.waitForFunction(() => !document.querySelector('[data-scope="this"]'), { timeout: 8000 });
    const after = await measure();
    assert.equal(after.path, '/calendar', 'die Geste gehoert dem Dialog');
    assert.equal(after.calendar, true);
    if (await page.$('#modal-title')) {
      assert.equal(after.marker, true, 'das Formular darunter haelt den Marker weiter');
      await page.keyboard.press('Escape');
      await clickPastDeadTime(page, '#confirm-modal-ok', { timeout: 5000 });
      await page.waitForFunction(() => !document.querySelector('.modal-overlay'), { timeout: 8000 });
    }
    await assertBackOnThePage(start);
  });
}
