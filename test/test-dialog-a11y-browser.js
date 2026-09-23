/**
 * Modul: Dialog-a11y im Browser (Familie, Foto-Dialoge)
 * Zweck: Was die a11y-Runden an "Familie" (admin-family.js) und an den
 *        Foto-Dialogen gemessen haben, im gerenderten Dokument festhalten:
 *        gueltige Listen, benannte Datei-Inputs ausserhalb der Tab-Folge und
 *        ein Erstfokus auf dem ersten Feld, das man sieht.
 * Ausfuehren: npm run test:dialog-a11y-browser (haengt an test:document-guards)
 *
 * WARUM IM BROWSER: alle drei Befunde entstehen erst im Dokument. Der leere
 * Zustand der Einladungen wird per `createElement('p')` in die `<ul>` gehaengt,
 * die Fehlerkarte per `createRetryState()`; der Erstfokus entscheidet sich in
 * modal.js an einem Selektor, der ueber das ganze Panel laeuft. Eine Textsuche
 * sieht keinen davon.
 *
 * 1. `<ul id="invites-list">` und `<ul id="members-list">` haben nur `<li>`-Kinder
 *    - leer, gefuellt und nach einem Ladefehler (axe `list`).
 * 2. `#edit-member-avatar-file` hat einen zugaenglichen Namen (axe `label`,
 *    critical) und liegt nicht in der Tab-Folge: Vorschau und Stift oeffnen ihn.
 * 3. Der Erstfokus in "Mitglied bearbeiten" liegt auf dem Benutzernamen. Vorher
 *    lag er auf dem versteckten Datei-Input, den `.sr-only:focus-visible` als
 *    Streifen ueber dem Dialogkopf sichtbar machte.
 */

import { test, before, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { startHarness, openPage, gotoRoute } from './document-guards-harness.js';

const require = createRequire(import.meta.url);
// Als Quelltext ueber CDP, nicht per `addScriptTag`: die CSP der App laesst kein
// eingefuegtes Inline-Skript zu, `Runtime.evaluate` unterliegt ihr nicht.
const AXE_SOURCE = readFileSync(require.resolve('axe-core/axe.min.js'), 'utf8');

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

const ROUTE = '/settings/admin/family';

/** Die Kinder der beiden Listen, die kein `<li>` sind. */
async function nonItemChildren(page) {
  return page.evaluate(() => ['members-list', 'invites-list'].flatMap((id) => {
    const list = document.getElementById(id);
    if (!list) return [`#${id} fehlt`];
    return [...list.children]
      .filter((child) => child.tagName !== 'LI')
      .map((child) => `#${id} > ${child.tagName.toLowerCase()}.${child.className}`);
  }));
}

test('Familie: die Mitglieder- und Einladungslisten haben nur <li>-Kinder, auch leer', async () => {
  const page = await openPage(harness, { device: 'desktop', locale: 'de' });
  try {
    await gotoRoute(page, ROUTE);
    await page.waitForSelector('#members-list > *');
    await page.waitForFunction(() => document.getElementById('invites-list')?.children.length > 0, { timeout: 10000 });
    const state = await page.evaluate(() => ({
      members: document.querySelectorAll('#members-list > .settings-member').length,
      invites: document.querySelectorAll('#invites-list > .settings-member').length,
    }));
    assert.ok(state.members >= 1, 'keine Mitglieder gerendert - so misst die Sonde nichts');
    assert.equal(state.invites, 0, 'der Seed traegt Einladungen - dann misst die Sonde den leeren Zustand nicht');
    assert.deepEqual(await nonItemChildren(page), []);
  } finally {
    await page.close();
  }
});

test('Familie: nach einem Ladefehler bleiben die Listen gueltig', async () => {
  const page = await openPage(harness, { device: 'desktop', locale: 'de' });
  try {
    page.__yuvomiRequestInterceptor = (req) => {
      const path = new URL(req.url()).pathname;
      if (req.method() === 'GET' && (path === '/api/v1/auth/invites' || path === '/api/v1/auth/users')) {
        req.respond({ status: 500, contentType: 'application/json', body: '{"error":"probe"}' });
        return true;
      }
      return false;
    };
    await gotoRoute(page, ROUTE);
    await page.waitForFunction(
      () => ['members-list', 'invites-list'].every((id) => document.getElementById(id)?.querySelector('button')),
      { timeout: 10000 },
    );
    assert.deepEqual(await nonItemChildren(page), []);
  } finally {
    page.__yuvomiRequestInterceptor = null;
    await page.close();
  }
});

for (const device of ['desktop', 'mobile']) {
  test(`Familie ${device}: "Mitglied bearbeiten" - Erstfokus auf dem Benutzernamen, Datei-Input benannt und ausser Tab-Folge`, async () => {
    const page = await openPage(harness, { device, locale: 'de' });
    try {
      await gotoRoute(page, ROUTE);
      await page.waitForSelector('[data-edit-user]');
      await page.$eval('[data-edit-user]', (el) => el.click());
      await page.waitForSelector('#edit-member-username');
      // Der Erstfokus kommt 50 ms nach dem Oeffnen (modal.js, applyInitialFocus).
      await page.waitForFunction(
        () => document.activeElement && document.activeElement !== document.body
          && document.querySelector('#shared-modal-overlay')?.contains(document.activeElement),
        { timeout: 5000 },
      );
      await new Promise((r) => setTimeout(r, 150));
      const focus = await page.evaluate(() => {
        const el = document.activeElement;
        const file = document.getElementById('edit-member-avatar-file');
        return {
          active: el?.id || el?.tagName,
          fileTabIndex: file?.tabIndex,
          fileLabel: file?.getAttribute('aria-label') || file?.labels?.[0]?.textContent?.trim() || '',
        };
      });
      assert.equal(focus.active, 'edit-member-username', `der Erstfokus liegt auf ${focus.active}`);
      assert.equal(focus.fileTabIndex, -1, 'der Datei-Input liegt in der Tab-Folge - Vorschau und Stift sind der Weg');
      assert.ok(focus.fileLabel, 'der Datei-Input hat keinen zugaenglichen Namen');

      await page.evaluate(AXE_SOURCE);
      const violations = await page.evaluate(async () => {
        const result = await window.axe.run(document.querySelector('#shared-modal-overlay .modal-panel'), {
          runOnly: { type: 'rule', values: ['label', 'list', 'listitem'] },
        });
        return result.violations.map((v) => `${v.id} (${v.impact}): ${v.nodes.map((n) => n.target.join(' ')).join(', ')}`);
      });
      assert.deepEqual(violations, []);
    } finally {
      await page.close();
    }
  });
}

/*
 * DIE FOTO-DIALOGE (Nachtrag zur a11y-Runde). Dasselbe Muster wie in
 * "Mitglied bearbeiten": ein `.sr-only`-Datei-Input, den eine Vorschau oder ein
 * Knopf oeffnet. In Geburtstag und Haushaltshilfe lag der Erstfokus darauf
 * (gemessen auf desktop und mobile); in Rezept und Inventar war er ohne Namen,
 * im Beleg-Feld des Budget-Dialogs ein zweiter, unsichtbarer Tab-Halt neben
 * "Hochladen".
 */
const PHOTO_DIALOGS = [
  { name: 'Geburtstag anlegen', route: '/birthdays', open: ['#fab-new-birthday'], file: '#bd-photo', first: 'bd-name' },
  { name: 'Rezept anlegen', route: '/recipes', open: ['#fab-new-recipe'], file: '#recipe-image' },
  { name: 'Inventar anlegen', route: '/inventory', open: ['.page-fab'], file: '#inv-photo' },
  { name: 'Haushaltshilfe bearbeiten', route: '/housekeeping', open: ['[data-tab-id="staff"]', '[data-edit-worker]'], file: '#housekeeping-avatar-file' },
  // Das Beleg-Feld (components/document-attach.js): "Hochladen" oeffnet den Input.
  { name: 'Budget-Eintrag anlegen', route: '/budget', open: ['#budget-add'], file: '[data-doc-attach-input]' },
];

for (const dialog of PHOTO_DIALOGS) {
  for (const device of ['desktop', 'mobile']) {
    test(`${dialog.name} ${device}: der Foto-Input ist benannt, ausser Tab-Folge und nicht der Erstfokus`, async () => {
      const page = await openPage(harness, { device, locale: 'de' });
      try {
        await gotoRoute(page, dialog.route);
        for (const selector of dialog.open) {
          await page.waitForSelector(selector, { timeout: 10000 });
          await page.$eval(selector, (el) => el.click());
        }
        await page.waitForSelector(dialog.file, { timeout: 10000 });
        await page.waitForFunction(
          () => document.activeElement && document.activeElement !== document.body
            && Boolean(document.activeElement.closest('.modal-overlay')),
          { timeout: 5000 },
        );
        await new Promise((r) => setTimeout(r, 150));
        const state = await page.evaluate((selector) => {
          const el = document.activeElement;
          const file = document.querySelector(selector);
          const labelledBy = file.getAttribute('aria-labelledby');
          return {
            active: el?.id || el?.getAttribute('name') || el?.tagName,
            activeIsFile: el === file,
            fileTabIndex: file.tabIndex,
            fileLabel: (file.getAttribute('aria-label')
              || (labelledBy && document.getElementById(labelledBy)?.textContent) || '').trim(),
          };
        }, dialog.file);
        assert.equal(state.activeIsFile, false, 'der Erstfokus liegt auf dem versteckten Datei-Input');
        if (dialog.first) assert.equal(state.active, dialog.first, `der Erstfokus liegt auf ${state.active}`);
        assert.equal(state.fileTabIndex, -1, 'der Datei-Input liegt in der Tab-Folge - sein Knopf ist der Weg');
        assert.ok(state.fileLabel, 'der Datei-Input hat keinen zugaenglichen Namen');
      } finally {
        await page.close();
      }
    });
  }
}
