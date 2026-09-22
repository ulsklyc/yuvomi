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
import { startHarness, openPage, gotoRoute } from './document-guards-harness.js';

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
async function seedDueReminder(page, { count = 1, refresh = true } = {}) {
  const ids = await page.evaluate(async ({ count, refresh }) => {
    const { api } = await import('/api.js');
    const created = [];
    for (let i = 0; i < count; i += 1) {
      const { data: event } = await api.post('/calendar', {
        title: i === 0 ? 'Toast probe event' : `Toast probe event ${i + 1}`,
        start_datetime: '2048-04-03T09:00:00',
        end_datetime: '2048-04-03T10:00:00',
      });
      await api.post('/reminders', {
        entity_type: 'event',
        entity_id: event.id,
        remind_at: '2020-01-01T08:00:00',
      });
      created.push(event.id);
    }
    if (refresh) (await import('/reminders.js')).refresh();
    return created;
  }, { count, refresh });
  if (refresh) await waitForToasts(page, count);
  return ids[0];
}

/** Wartet, bis mindestens `count` Erinnerungs-Toasts im Stapel stehen. */
async function waitForToasts(page, count) {
  await page.waitForFunction(
    (n) => document.querySelectorAll('.toast--reminder').length >= n,
    { timeout: 10000 },
    count,
  );
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
const MODAL_PANEL = '.modal-overlay:not([inert]) .modal-panel';
const MODAL_CONTROLS = '.modal-panel__header button, .modal-panel__footer button, .modal-panel__footer a, .modal-actions button';

async function measureDialog(page, { panelSelector = MODAL_PANEL, controlSelector = MODAL_CONTROLS } = {}) {
  return page.evaluate(({ panelSelector, controlSelector }) => {
    const panels = [...document.querySelectorAll(panelSelector)];
    const panel = panels.at(-1);
    if (!panel) return { panel: false };
    const controls = [...panel.querySelectorAll(controlSelector)].filter((el) => {
      const r = el.getBoundingClientRect();
      return r.width > 0 && r.height > 0 && getComputedStyle(el).visibility !== 'hidden';
    });
    const covered = [];
    for (const el of controls) {
      const r = el.getBoundingClientRect();
      const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
      // Ein gesperrter Knopf nimmt keine Zeiger an (`.btn:disabled`), der Treffer
      // faellt durch ihn hindurch; verdeckt ist er dann nur, wenn der Stapel dort liegt.
      const blocked = el.disabled ? Boolean(hit?.closest('.shell-bottom-stack')) : !el.contains(hit);
      if (blocked) {
        covered.push({
          control: el.id || el.className || el.textContent.trim(),
          hit: hit?.closest('.toast')?.className || hit?.className || String(hit),
        });
      }
    }
    // Sichtbar heisst: mindestens EIN Toast ganz im Bild und an seiner Mitte
    // oben. Bei engem Platz zeigt der Stapel nur einen (die uebrigen bleiben
    // fuer die Live-Region im Dokument), also zaehlt der beste.
    const toasts = [...document.querySelectorAll('.toast--reminder')];
    const vw = document.documentElement.clientWidth;
    const vh = document.documentElement.clientHeight;
    const toastVisible = toasts.some((toast) => {
      const r = toast.getBoundingClientRect();
      const inView = r.top >= 0 && r.left >= 0 && r.bottom <= vh && r.right <= vw && r.height > 1 && r.width > 1;
      const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
      return inView && toast.contains(hit);
    });
    return { panel: true, controls: controls.length, covered, toast: toasts.length > 0, toastVisible };
  }, { panelSelector, controlSelector });
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

/*
 * DIALOGE OHNE `.modal-panel`-LEISTEN (Review an #1421).
 *
 * Die erste Fassung kannte Bedienleisten nur als `.modal-panel__header/__footer`
 * und `.modal-actions`; fehlten sie, galt der ganze Dialog als Leiste. Fuer
 * einen Vollbild-Dialog rechnete sie den Stapel damit ueber den oberen Rand
 * hinaus - die Erinnerung war weg und nicht mehr wegzuklicken. Der Rundgang
 * beim ersten Start ist genau so ein Dialog (`role="dialog"` auf der ganzen
 * Flaeche), die Dokumentauswahl einer mit eigenen Kopf- und Fusszeilen.
 */
for (const device of ['mobile', 'desktop']) {
  test(`#1160 ${device} - ueber dem Vollbild-Rundgang bleibt der Toast im Bild und seine Knoepfe frei`, async () => {
    const page = await openPage(harness, { device, locale: 'de' });
    try {
      await seedDueReminder(page);
      // Der Harness unterdrueckt den Rundgang ueber diesen Schluessel; das
      // Konto des Seeds hat ihn noch nicht gesehen.
      await page.evaluate(() => localStorage.removeItem('yuvomi-onboarded'));
      await gotoRoute(page, '/');
      await page.waitForSelector('.onboarding-overlay .onboarding-actions button', { timeout: 10000 });
      await page.waitForSelector('.toast--reminder', { timeout: 10000 });
      await settleAnimations(page);
      const measured = await measureDialog(page, {
        panelSelector: '.onboarding-overlay',
        controlSelector: '.onboarding-actions button',
      });
      assert.equal(measured.panel, true, 'kein Rundgang offen');
      assert.ok(measured.controls >= 1, 'keine Knoepfe im Rundgang gemessen');
      assert.equal(measured.toast, true, 'der Erinnerungs-Toast ist verschwunden - so misst die Sonde nichts');
      assert.equal(measured.toastVisible, true, 'der Toast muss sichtbar, im Bild und oben bleiben');
      assert.deepEqual(measured.covered, [], 'ein Knopf des Rundgangs ist an seiner Mitte verdeckt');
    } finally {
      await page.close();
    }
  });
}

for (const device of ['mobile', 'desktop']) {
  test(`#1160 ${device} - die Dokumentauswahl in einem Formular bleibt bedienbar, der Toast bleibt sichtbar`, async () => {
    const page = await openPage(harness, { device, locale: 'de' });
    try {
      await seedDueReminder(page);
      // Die echten Bausteine: openModal mit dem Anhangsfeld, das die Aufgaben,
      // das Budget und das Inventar ebenso einbinden.
      await page.evaluate(async () => {
        const { openModal } = await import('/components/modal.js');
        const attach = await import('/components/document-attach.js');
        openModal({
          title: 'Toast probe attach',
          // Hoch wie ein echtes Formular: die Auswahl liegt IM Panel und wird von
          // dessen Rand beschnitten, ein Zwei-Zeilen-Formular schnitte sie ab.
          content: `<div class="modal-panel__body"><div style="min-height: 520px">${attach.renderDocumentAttachField()}</div></div>
            <div class="modal-panel__footer"><button class="btn btn--primary" type="button">OK</button></div>`,
          dirtyGuard: false,
        });
        const panel = document.querySelector('#shared-modal-overlay .modal-panel');
        attach.bindDocumentAttachField(panel);
      });
      await page.waitForSelector('[data-doc-attach-pick]');
      await settleAnimations(page);
      await page.$eval('[data-doc-attach-pick]', (el) => el.click());
      await page.waitForSelector('.doc-attach-picker__panel [data-picker-confirm]');
      await page.waitForNetworkIdle({ idleTime: 300, timeout: 5000 }).catch(() => {});
      await settleAnimations(page);
      const measured = await measureDialog(page, {
        panelSelector: '.doc-attach-picker__panel',
        controlSelector: '.doc-attach-picker__header button, .doc-attach-picker__footer button',
      });
      assert.equal(measured.panel, true, 'keine Dokumentauswahl offen');
      assert.ok(measured.controls >= 3, `zu wenige Knoepfe gemessen (${measured.controls})`);
      assert.equal(measured.toast, true, 'der Erinnerungs-Toast ist verschwunden - so misst die Sonde nichts');
      assert.equal(measured.toastVisible, true, 'der Toast muss sichtbar, im Bild und oben bleiben');
      assert.deepEqual(measured.covered, [], 'ein Knopf der Dokumentauswahl ist an seiner Mitte verdeckt');
    } finally {
      await page.close();
    }
  });
}

/*
 * DIE UNTERE NAVIGATION BLEIBT FREI (Review an #1421).
 *
 * Ein modales Overlay deckt die Tab-Leiste ab, ein Popover nicht: die
 * Detailansicht ist ab 768px ein nicht-modales Popover, und bis 1023px steht
 * die Leiste noch. Die erste Fassung hielt ihr `--nav-bottom-height` nur an der
 * Grundlage des Stapels frei; unter einem hohen Popover legte sie ihn auf die
 * Leiste, und der Erinnerungs-Toast nahm dreissig Sekunden lang deren Tipps.
 */
test('#1160 800x900 - unter einem hohen Popover legt sich der Toast nicht auf die Tab-Leiste', async () => {
  const page = await openPage(harness, { device: 'desktop', locale: 'de' });
  try {
    await page.setViewport({ width: 800, height: 900, deviceScaleFactor: 1 });
    await seedDueReminder(page);
    await page.evaluate(async () => {
      const { openDetailView } = await import('/components/detail-view.js');
      const anchor = document.createElement('button');
      anchor.textContent = 'Anker';
      anchor.style.cssText = 'position:fixed;top:40px;left:300px';
      document.body.append(anchor);
      // Zehn Zeilen: der Popover endet bei 800x900 gemessen um y=775, knapp
      // ueber der Leiste (824). Ueber ihm ist kein Platz, unter ihm - zwischen
      // Popover und Leiste - genau nicht genug; dort lag der Stapel (787..853).
      openDetailView({
        title: 'Toast probe popover',
        anchor,
        sections: Array.from({ length: 10 }, (_, i) => ({ icon: 'info', label: `Zeile ${i + 1}`, value: 'Eine Notiz.', multiline: true })),
        actions: [{ label: 'Aktion', variant: 'secondary', onClick: () => {} }],
      });
    });
    await page.waitForSelector('.detail-popover');
    await settleAnimations(page);
    const result = await page.evaluate(() => {
      const nav = document.querySelector('.nav-bottom');
      const navRect = nav.getBoundingClientRect();
      const targets = [...nav.querySelectorAll('a, button')].filter((el) => el.getBoundingClientRect().width > 0);
      const covered = targets.filter((el) => {
        const r = el.getBoundingClientRect();
        const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
        return Boolean(hit?.closest('.shell-bottom-stack'));
      }).map((el) => el.getAttribute('aria-label') || el.textContent.trim());
      const toast = document.querySelector('.toast--reminder');
      const t = toast?.getBoundingClientRect();
      const popover = document.querySelector('.detail-popover').getBoundingClientRect();
      // Die Flaeche zaehlt, nicht nur die Mitte der Ziele: ein Toast, der die
      // obere Haelfte der Leiste deckt, nimmt dort jeden Tipp, und gemessen lag
      // er genau so (787..853 ueber einer Leiste ab 824, Zielmitten bei 862).
      const overlapsNav = Boolean(t && t.bottom > navRect.top && t.top < navRect.bottom
        && t.right > navRect.left && t.left < navRect.right);
      return {
        overlapsNav,
        navVisible: navRect.height > 0,
        targets: targets.length,
        covered,
        toast: Boolean(toast),
        toastInView: Boolean(t && t.top >= 0 && t.bottom <= innerHeight && t.height > 0),
        popoverBottom: Math.round(popover.bottom),
        toastTop: t ? Math.round(t.top) : null,
        navTop: Math.round(navRect.top),
      };
    });
    assert.equal(result.navVisible, true, 'bei 800px muss die Tab-Leiste stehen - sonst misst die Sonde nichts');
    assert.ok(result.targets >= 3, `zu wenige Ziele in der Tab-Leiste (${result.targets})`);
    assert.equal(result.toast, true, 'der Erinnerungs-Toast ist verschwunden - so misst die Sonde nichts');
    assert.equal(result.toastInView, true, `der Toast muss im Bild bleiben (${JSON.stringify(result)})`);
    assert.equal(result.overlapsNav, false, `der Toast liegt auf der Tab-Leiste (${JSON.stringify(result)})`);
    assert.deepEqual(result.covered, [], `der Toast deckt Ziele der Tab-Leiste (${JSON.stringify(result)})`);
  } finally {
    await page.close();
  }
});

/*
 * DIE ZWEITE REVIEW-RUNDE (Ersatz-Review an #1421, im Browser gemessen).
 *
 * 1. openModal-Dialoge tragen immer `.modal-panel__header`; ihre Speichern-
 *    Zeile steht aber oft in einer eigenen Klasse im Koerper
 *    (`.settings-form-actions`, `.housekeeping-form-submit`). Sobald der Kopf
 *    als Leiste zaehlte, fiel der Rueckfall auf die Bedienelemente weg, und
 *    "Speichern" lag wieder unter dem Toast.
 * 2. Der Koerper scrollt; ohne Neumessen beim Scrollen wanderte die
 *    Aktionszeile unter den Toast, der vor dem Scrollen richtig lag.
 * 3. Drei Toasts im Kalender-Editor fanden auf kleinen Bildern keinen freien
 *    Platz und deckten Loeschen und Abbrechen.
 */
const FAMILY_SIZES = [
  { label: '1280x900', device: 'desktop', viewport: { width: 1280, height: 900, deviceScaleFactor: 1 } },
  { label: '1280x700', device: 'desktop', viewport: { width: 1280, height: 700, deviceScaleFactor: 1 } },
  { label: '320x568', device: 'mobile', viewport: { width: 320, height: 568, deviceScaleFactor: 2, isMobile: true, hasTouch: true } },
];

for (const size of FAMILY_SIZES) {
  test(`#1160 ${size.label} - Mitglied bearbeiten, ans Ende gescrollt: Speichern und Abbrechen bleiben frei (2 Toasts)`, async () => {
    const page = await openPage(harness, { device: size.device, locale: 'de' });
    try {
      await seedDueReminder(page, { count: 2, refresh: false });
      await page.setViewport(size.viewport);
      await gotoRoute(page, '/settings/admin/family');
      await waitForToasts(page, 2);
      await page.waitForSelector('[data-edit-user]');
      await page.$eval('[data-edit-user]', (el) => el.click());
      await page.waitForSelector('#edit-member-cancel');
      await settleAnimations(page);
      // Ans Ende des Koerpers scrollen, wie ein Mensch es tut, um zu speichern.
      await page.$eval('#shared-modal-overlay .modal-panel__body', (body) => {
        body.scrollTop = body.scrollHeight;
      });
      await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
      await settleAnimations(page);
      const measured = await measureDialog(page, {
        controlSelector: `${MODAL_CONTROLS}, .settings-form-actions button`,
      });
      assert.equal(measured.panel, true, 'kein Dialog offen');
      assert.ok(measured.controls >= 3, `zu wenige Knoepfe gemessen (${measured.controls})`);
      assert.equal(measured.toast, true, 'die Erinnerungs-Toasts sind verschwunden - so misst die Sonde nichts');
      assert.equal(measured.toastVisible, true, 'mindestens ein Toast muss sichtbar bleiben');
      assert.deepEqual(measured.covered, [], 'Speichern oder Abbrechen liegt unter dem Stapel');

      const requests = [];
      page.on('request', (req) => requests.push(`${req.method()} ${new URL(req.url()).pathname}`));
      const box = await page.$eval('#edit-member-cancel', (el) => {
        const r = el.getBoundingClientRect();
        return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
      });
      await page.mouse.click(box.x, box.y);
      await page.waitForFunction(() => !document.querySelector('.modal-overlay'), { timeout: 5000 }).catch(() => {});
      assert.equal(await page.$('.modal-overlay'), null, `Abbrechen hat den Dialog nicht geschlossen: ${JSON.stringify(requests)}`);
      assert.ok(!requests.some((r) => /reminders\/\d+\/dismiss/.test(r)), `der Klick verwarf eine Erinnerung: ${JSON.stringify(requests)}`);
    } finally {
      await page.close();
    }
  });
}

const SMALL_SIZES = [
  { label: '667x375', device: 'desktop', viewport: { width: 667, height: 375, deviceScaleFactor: 1 } },
  { label: '320x568', device: 'mobile', viewport: { width: 320, height: 568, deviceScaleFactor: 2, isMobile: true, hasTouch: true } },
  // Telefon quer: hier findet selbst der Kalender-Editor fuer drei Toasts keinen
  // freien Platz mehr; ohne das Zuruecknehmen bis auf einen lag der Stapel auf
  // "Zurueck" im Kopf (gemessen, Gegenprobe mit abgeschaltetem Zuruecknehmen).
  { label: '568x320', device: 'mobile', viewport: { width: 568, height: 320, deviceScaleFactor: 2, isMobile: true, hasTouch: true } },
];

for (const size of SMALL_SIZES) {
  test(`#1160 ${size.label} - drei Toasts im Kalender-Editor decken keinen seiner Knoepfe`, async () => {
    const page = await openPage(harness, { device: size.device, locale: 'de' });
    try {
      const eventId = await seedDueReminder(page, { count: 3, refresh: false });
      await page.setViewport(size.viewport);
      await gotoRoute(page, '/calendar');
      await waitForToasts(page, 3);
      await openEventEditor(page, eventId);
      const measured = await measureDialog(page);
      assert.equal(measured.panel, true, 'kein Dialog offen');
      assert.ok(measured.controls >= 3, `zu wenige Knoepfe gemessen (${measured.controls})`);
      assert.equal(measured.toast, true, 'die Erinnerungs-Toasts sind verschwunden - so misst die Sonde nichts');
      assert.equal(measured.toastVisible, true, 'mindestens ein Toast muss sichtbar bleiben');
      assert.deepEqual(measured.covered, [], 'ein Knopf des Editors liegt unter dem Stapel');
      assert.equal(await page.$$eval('.toast--reminder', (list) => list.length), 3,
        'die verborgenen Toasts muessen im Dokument bleiben (Live-Region)');
    } finally {
      await page.close();
    }
  });
}

/*
 * WELCHER TOAST BLEIBT, UND WAS DIE ANDEREN NOCH KOENNEN (Review an #1421).
 *
 * Die bestimmte Live-Region (Fehler) steht im Stapel immer HINTER der
 * hoeflichen (Erinnerungen). Wer den letzten nach DOM-Reihenfolge behielt,
 * behielt jede Fehlermeldung und nahm die Erinnerung zurueck, die gerade kam.
 * Und ein zurueckgenommener Toast ist unsichtbar - seine Knoepfe (Verwerfen,
 * Oeffnen) duerfen dann auch per Tab nicht erreichbar sein.
 */
test('#1160 568x320 - der juengste Toast bleibt sichtbar, auch nach einem Fehler; die zurueckgenommenen sind inert', async () => {
  const page = await openPage(harness, { device: 'mobile', locale: 'de' });
  try {
    const eventId = await seedDueReminder(page, { count: 1, refresh: false });
    await page.setViewport({ width: 568, height: 320, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
    await gotoRoute(page, '/calendar');
    await waitForToasts(page, 1);
    await openEventEditor(page, eventId);
    // Erst ein Fehler (bestimmt, lange Standzeit), DANACH eine neue Erinnerung.
    await page.evaluate(() => window.yuvomi.showToast('Toast probe error', 'danger', 30000));
    await page.waitForFunction(() => document.querySelectorAll('.toast--danger').length >= 1);
    await seedDueReminder(page, { count: 1, refresh: false });
    await page.evaluate(async () => (await import('/reminders.js')).refresh());
    await waitForToasts(page, 2);
    await settleAnimations(page);
    const state = await page.evaluate(() => {
      const reminders = [...document.querySelectorAll('.toast--reminder')];
      const newest = reminders[reminders.length - 1];
      const all = [...document.querySelectorAll('.shell-bottom-stack .toast')];
      return {
        count: all.length,
        tucked: all.filter((t) => t.classList.contains('toast--tucked')).length,
        newestTucked: newest.classList.contains('toast--tucked'),
        newestInert: newest.inert,
        dangerTucked: document.querySelector('.toast--danger')?.classList.contains('toast--tucked'),
        tuckedNotInert: all.filter((t) => t.classList.contains('toast--tucked') && !t.inert).length,
      };
    });
    assert.equal(state.count, 3, `drei Toasts erwartet (${JSON.stringify(state)})`);
    assert.ok(state.tucked >= 1, `bei 568x320 muss der Stapel zuruecknehmen, sonst misst die Sonde nichts (${JSON.stringify(state)})`);
    assert.equal(state.newestTucked, false, `die zuletzt eingetroffene Erinnerung wurde zurueckgenommen (${JSON.stringify(state)})`);
    assert.equal(state.newestInert, false, 'der sichtbare Toast darf nicht inert sein');
    assert.equal(state.dangerTucked, true, `der aeltere Fehler muss zuruecktreten (${JSON.stringify(state)})`);
    assert.equal(state.tuckedNotInert, 0, 'ein zurueckgenommener Toast ist per Tab erreichbar (nicht inert)');
    const measured = await measureDialog(page);
    assert.deepEqual(measured.covered, [], 'ein Knopf des Editors liegt unter dem Stapel');
    assert.equal(measured.toastVisible, true, 'der juengste Toast muss sichtbar sein');

    // Nach dem Schliessen kommen die zurueckgenommenen Toasts zurueck - und
    // wieder bedienbar. Ohne `inert = false` in untuck() blieben sie sichtbar,
    // aber Verwerfen und Oeffnen reagierten nicht mehr (Review an #1421).
    await page.evaluate(async () => (await import('/components/modal.js')).closeModal({ force: true }));
    await page.waitForFunction(() => !document.querySelector('.modal-overlay'), { timeout: 5000 });
    await settleAnimations(page);
    const after = await page.evaluate(() => {
      const all = [...document.querySelectorAll('.shell-bottom-stack .toast')];
      return {
        count: all.length,
        inert: all.filter((t) => t.inert).length,
        tucked: all.filter((t) => t.classList.contains('toast--tucked')).length,
      };
    });
    assert.ok(after.count >= 2, `die Toasts sind mit dem Dialog verschwunden (${JSON.stringify(after)})`);
    assert.equal(after.tucked, 0, `nach dem Schliessen ist noch ein Toast zurueckgenommen (${JSON.stringify(after)})`);
    assert.equal(after.inert, 0, `nach dem Schliessen ist noch ein Toast inert (${JSON.stringify(after)})`);
  } finally {
    await page.close();
  }
});

