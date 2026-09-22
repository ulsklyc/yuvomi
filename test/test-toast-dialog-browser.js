/**
 * Modul: Toast ueber offenem Dialog (#1160) - Browser-Sonde
 * Zweck: Ein Toast bleibt sichtbar, waehrend ein Dialog offen ist, aber er
 *        verdeckt keinen Bedienknopf des Dialogs und nimmt keinen Klick, der
 *        dem Dialog gilt.
 * Ausfuehren: npm run test:toast-dialog-browser (haengt an test:document-guards)
 *
 * ANLASS (12.09.2026): der Toast einer faelligen Erinnerung lag bei 1280x900
 * genau auf "Speichern" des Kalenderdialogs. `elementFromPoint` auf der Mitte
 * des Knopfs lieferte `.toast--reminder`, der Klick verwarf die Erinnerung
 * (`PATCH /reminders/:id/dismiss`) und speicherte nichts. Drei Kalender-Sonden
 * der Dokument-Guards wurden dadurch rot; der Harness verwirft seitdem jede
 * Erinnerung des Seeds, damit die uebrigen Sonden nicht am Lauftag haengen.
 * Diese Sonde legt die Erinnerung deshalb SELBST an: sie haengt nicht davon ab,
 * ob der Seed am Lauftag eine faellige traegt.
 *
 * GEMESSEN WIRD DER KLICK, NICHT DIE LAGE ALLEIN. Eine Sonde, die nur Rechtecke
 * vergleicht, waere gruen, wenn der Toast unsichtbar ueber dem Knopf laege und
 * trotzdem den Treffer nimmt; eine, die nur `elementFromPoint` fragt, waere
 * gruen, wenn der Toast verschwindet. Deshalb drei Zusicherungen: jeder Knopf
 * in Kopf und Fuss des Dialogs ist an seiner Mitte das oberste Element, der
 * Toast ist dabei sichtbar im Bild, und ein echter Mausklick auf "Speichern"
 * speichert - ohne die Erinnerung zu verwerfen.
 */

import { test, before, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { startHarness, openPage } from './document-guards-harness.js';

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

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Legt einen Termin und eine faellige Erinnerung dafuer an und laesst die
 * Erinnerungen sofort abgleichen - das Polling wartet sonst eine Minute.
 */
async function seedDueReminder(page) {
  const eventId = await page.evaluate(async () => {
    const { api } = await import('/api.js');
    const { data: event } = await api.post('/calendar', {
      title: 'Toast probe event',
      start_datetime: '2048-04-03T09:00:00',
      end_datetime: '2048-04-03T10:00:00',
    });
    await api.post('/reminders', {
      entity_type: 'event',
      entity_id: event.id,
      remind_at: '2020-01-01T08:00:00',
    });
    const reminders = await import('/reminders.js');
    reminders.refresh();
    return event.id;
  });
  await page.waitForSelector('.toast--reminder', { timeout: 10000 });
  return eventId;
}

/** Wartet, bis jede laufende Animation der Seite zu Ende ist. */
async function settleAnimations(page) {
  // Endlose Animationen (der Hintergrund der Shell driftet dauernd) enden nie.
  await page.evaluate(() => Promise.all(
    document.getAnimations()
      .filter((a) => a.effect?.getComputedTiming().endTime !== Infinity)
      .map((a) => a.finished.catch(() => {})),
  ));
  // Zwei Frames fuer die Reaktion auf `animationend`.
  await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
}

/**
 * Misst das oberste Dialogfenster: welche Knoepfe in Kopf und Fuss an ihrer
 * Mitte etwas anderes treffen, und ob der Toast dabei sichtbar ist.
 */
async function measureDialog(page) {
  return page.evaluate(() => {
    const panels = [...document.querySelectorAll('.modal-overlay:not([inert]) .modal-panel')];
    const panel = panels.at(-1);
    if (!panel) return { panel: false };
    const controls = [...panel.querySelectorAll(
      '.modal-panel__header button, .modal-panel__footer button, .modal-panel__footer a, .modal-actions button',
    )].filter((el) => {
      const r = el.getBoundingClientRect();
      return r.width > 0 && r.height > 0 && getComputedStyle(el).visibility !== 'hidden';
    });
    const covered = [];
    for (const el of controls) {
      const r = el.getBoundingClientRect();
      const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
      if (!el.contains(hit)) {
        covered.push({
          control: el.id || el.className || el.textContent.trim(),
          hit: hit?.closest('.toast')?.className || hit?.className || String(hit),
        });
      }
    }
    const toast = document.querySelector('.toast--reminder');
    let toastVisible = false;
    if (toast) {
      const r = toast.getBoundingClientRect();
      const vw = document.documentElement.clientWidth;
      const vh = document.documentElement.clientHeight;
      const inView = r.top >= 0 && r.left >= 0 && r.bottom <= vh && r.right <= vw && r.height > 0;
      const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
      toastVisible = inView && toast.contains(hit);
    }
    return { panel: true, controls: controls.length, covered, toast: Boolean(toast), toastVisible };
  });
}

async function openEventEditor(page, eventId) {
  await page.evaluate((path) => window.yuvomi.navigate(path), `/calendar?open=${eventId}&date=2048-04-03`);
  await page.waitForSelector('#detail-popover-edit, #detail-view-edit');
  // Der Weg in den Editor ist nicht Gegenstand der Sonde: ein Klick per Knoten,
  // damit ihn kein Toast abfaengt, bevor die Messung beginnt.
  await page.$eval('#detail-popover-edit, #detail-view-edit', (el) => el.click());
  await page.waitForSelector('#modal-save');
  await settleAnimations(page);
}

for (const device of ['desktop', 'mobile', 'short']) {
  test(`#1160 ${device} - der Erinnerungs-Toast verdeckt keinen Knopf des Kalenderdialogs und nimmt "Speichern" keinen Klick`, async () => {
    const page = await openPage(harness, { device, locale: 'de' });
    try {
      const eventId = await seedDueReminder(page);
      await openEventEditor(page, eventId);

      const measured = await measureDialog(page);
      assert.equal(measured.panel, true, 'kein offener Dialog');
      assert.ok(measured.controls >= 2, `zu wenige Knoepfe gemessen (${measured.controls})`);
      assert.equal(measured.toast, true, 'der Erinnerungs-Toast ist verschwunden - so misst die Sonde nichts');

      // Erst klicken, dann urteilen: so zeigt ein roter Lauf beide Befunde,
      // den verdeckten Knopf UND den geschluckten Klick.
      const requests = [];
      page.on('request', (req) => {
        requests.push(`${req.method()} ${new URL(req.url()).pathname}`);
      });
      const box = await page.$eval('#modal-save', (el) => {
        const r = el.getBoundingClientRect();
        return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
      });
      await page.mouse.click(box.x, box.y);
      await page.waitForFunction(() => !document.querySelector('.modal-overlay'), { timeout: 5000 })
        .catch(() => {});
      await wait(300);
      assert.ok(
        requests.includes(`PUT /api/v1/calendar/${eventId}`),
        `der Klick auf Speichern hat nicht gespeichert: ${JSON.stringify(requests)}`,
      );
      assert.ok(
        !requests.some((r) => /^PATCH \/api\/v1\/reminders\/\d+\/dismiss$/.test(r)),
        `der Klick auf Speichern hat die Erinnerung verworfen: ${JSON.stringify(requests)}`,
      );
      assert.deepEqual(measured.covered, [], 'ein Knopf des Dialogs ist an seiner Mitte verdeckt');
      assert.equal(measured.toastVisible, true, 'der Toast muss sichtbar und oben bleiben');
    } finally {
      await page.close();
    }
  });
}

for (const device of ['desktop', 'mobile']) {
  test(`#1160 ${device} - auch eine kurze Rueckfrage bleibt bedienbar, der Toast bleibt sichtbar`, async () => {
    const page = await openPage(harness, { device, locale: 'de' });
    try {
      await seedDueReminder(page);
      await page.evaluate(async () => {
        const { confirmModal } = await import('/components/modal.js');
        window.__toastProbeConfirm = confirmModal('Toast probe question?', { confirmLabel: 'Ja', cancelLabel: 'Nein' });
      });
      await page.waitForSelector('#confirm-modal-ok');
      await settleAnimations(page);
      const measured = await measureDialog(page);
      assert.equal(measured.panel, true, 'kein offener Dialog');
      assert.equal(measured.toast, true, 'der Erinnerungs-Toast ist verschwunden - so misst die Sonde nichts');
      assert.deepEqual(measured.covered, [], 'ein Knopf der Rueckfrage ist an seiner Mitte verdeckt');
      assert.equal(measured.toastVisible, true, 'der Toast muss sichtbar und oben bleiben');
    } finally {
      await page.close();
    }
  });
}
