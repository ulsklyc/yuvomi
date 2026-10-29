/**
 * Modul: Eine Erinnerungsliste mit langem Namen laesst der Modulwahl ihren Wert (#2284) - Browser-Sonde
 * Zweck: In den Sync-Einstellungen (Erinnerungen) steht je Liste eine Zeile aus
 *        Name samt Schalter (`createSettingRow()`) und der Modulwahl daneben
 *        (`.caldav-reminder-module`). Die Zeile war eine Flex-Reihe ohne
 *        Umbruch, die Modulwahl trug `flex: 1; min-width: 0`: ein langer Name
 *        nahm sich die Breite, und die Auswahl schrumpfte am Telefon bis auf
 *        ihr Pfeilzeichen - welches Modul gewaehlt ist, war nicht mehr lesbar.
 *        Jetzt bricht der Name um, die Auswahl behaelt mindestens die Breite
 *        ihres Werts und rutscht, wo beide nicht nebeneinander passen, unter
 *        den Namen.
 * Ausfuehren: npm run test:reminder-list-row-browser (haengt an test:document-guards)
 *
 * WARUM IM BROWSER. Wie breit "Einkaufsliste" in der Auswahl steht und ob eine
 * Flex-Reihe umbricht, weiss nur der Browser. Die Sonde braucht dafuer weder
 * Server noch Anmeldung: eine statische Seite mit den ECHTEN Stylesheets und
 * dem Markup, das `buildReminderRow()` (public/settings/pages/sync-reminders.js)
 * und `createSettingRow()` (public/settings/components.js) bauen. Dass dieses
 * Markup noch das der Seite ist, haelt der erste Test.
 *
 * JEDE SONDE PRUEFT ZUERST, DASS SIE ETWAS MISST: eine Auswahl, der die Sonde
 * selbst die Breite nimmt, faellt auf.
 */

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import puppeteer from 'puppeteer';
import { launchBrowser } from '../scripts/lib/chrome-executable.js';
import { tempDir } from './tmp-dir.js';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SHEETS = ['tokens', 'reset', 'layout', 'typography', 'list-row', 'panel', 'settings'];

/* Kurz, lang mit Leerzeichen, und ein einziges langes Wort (ohne Bruchstelle). */
const NAMES = [
  'Einkauf',
  'Familien-Einkaufsliste fuer das Wochenende bei Oma und Opa im Garten',
  'Wocheneinkaufsgemeinschaftshaushaltssommerferienliste',
];

const row = (name, i, { readOnly = false } = {}) => `<div class="caldav-reminder-item">
  <div class="settings-setting-row form-row">
    <div class="settings-setting-row__copy form-row__copy"><label class="settings-setting-row__label form-row__label" for="c${i}">${name}</label></div>
    <div class="settings-setting-row__control form-row__control"><input type="checkbox" class="caldav-reminder-checkbox" id="c${i}" checked></div>
  </div>
  <select class="form-input caldav-reminder-module"><option value="tasks">Aufgaben</option><option value="shopping" selected>Einkaufsliste</option></select>
  <button type="button" class="form-input caldav-reminder-assignees assignee-menu__trigger popover-menu__trigger" hidden><span class="assignee-menu__text">Keine</span></button>
  ${readOnly ? '<p class="caldav-calendar-source caldav-reminder-note">Nur lesbar geteilt: neue Aufgaben landen nicht in dieser Liste.</p>' : ''}
</div>`;

const PAGE = `<!doctype html><html lang="de"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
${SHEETS.map((name) => `<link rel="stylesheet" href="${pathToFileURL(join(ROOT, 'public/styles', `${name}.css`)).href}">`).join('\n')}
</head><body>
<section class="settings-section"><div class="settings-card"><div id="host" class="settings-sync-accounts"><article class="caldav-account-item"><div class="caldav-calendars-list">
${NAMES.map((name, i) => row(name, i)).join('\n')}
${row(NAMES[1], 9, { readOnly: true })}
</div></article></div></div></section>
</body></html>`;

let browser;
let url;

before(async () => {
  // tempDir() raeumt beim Prozessende weg (test/tmp-dir.js, test:tmp-clean).
  const file = join(tempDir('yuvomi-reminder-row-'), 'rows.html');
  writeFileSync(file, PAGE);
  url = pathToFileURL(file).href;
  browser = await launchBrowser(puppeteer, { headless: true, args: ['--no-sandbox', '--disable-dev-shm-usage'] });
});

after(async () => {
  await browser?.close();
});

/** Misst jede Listenzeile bei jeder der genannten Breiten der Liste. */
async function sweep(viewport, widths, { squeeze = false } = {}) {
  const page = await browser.newPage();
  try {
    await page.setViewport({ width: viewport, height: 900 });
    await page.goto(url);
    await page.evaluate(() => document.fonts.ready);
    return await page.evaluate((widths, squeeze) => {
      const list = document.querySelector('.caldav-calendars-list');
      // Nur fuer die Gegenprobe am Messgeraet: die alte Regel, die der Auswahl die Breite nahm.
      if (squeeze) {
        for (const item of list.querySelectorAll('.caldav-reminder-item')) item.style.flexWrap = 'nowrap';
        for (const s of list.querySelectorAll('.caldav-reminder-module')) { s.style.flex = '1'; s.style.minWidth = '0'; s.style.minInlineSize = '0'; s.style.flexBasis = 'auto'; }
      }
      // Die Breite, die die Auswahl fuer ihren laengsten Wert samt Pfeil braucht.
      const probe = list.querySelector('.caldav-reminder-module').cloneNode(true);
      probe.removeAttribute('style');
      probe.style.cssText = 'position:absolute;visibility:hidden;inline-size:max-content;min-inline-size:0;flex:none';
      document.body.appendChild(probe);
      const need = probe.getBoundingClientRect().width;
      probe.remove();
      const out = [];
      for (const w of widths) {
        list.style.width = `${w}px`;
        for (const item of list.querySelectorAll('.caldav-reminder-item')) {
          const label = item.querySelector('.settings-setting-row__label');
          const select = item.querySelector('.caldav-reminder-module');
          const box = item.getBoundingClientRect();
          const l = label.getBoundingClientRect();
          const s = select.getBoundingClientRect();
          out.push({
            w,
            name: label.textContent.slice(0, 24),
            need: Math.round(need),
            select: Math.round(s.width),
            // Unter dem Namen steht die Auswahl, sobald ihre Oberkante dessen Unterkante erreicht.
            below: s.top >= l.bottom - 1,
            overflow: Math.round(Math.max(l.right, s.right, item.scrollWidth + box.left) - box.right),
          });
        }
      }
      return out;
    }, widths, squeeze);
  } finally {
    await page.close();
  }
}

const range = (from, to, step = 4) => {
  const out = [];
  for (let w = from; w <= to; w += step) out.push(w);
  return out;
};

function assertReadable(rows, where) {
  assert.ok(rows.length > 0, `${where}: die Sonde hat keine Zeile gemessen`);
  assert.ok(rows[0].need > 60, `${where}: die Auswahl braucht angeblich ${rows[0].need}px - die Sonde misst nichts`);
  const bad = rows.filter((r) => r.select < r.need || r.overflow > 0);
  const sample = bad.slice(0, 5).map((r) => `"${r.name}" bei ${r.w}px: Auswahl ${r.select}px von ${r.need}px, ${r.overflow}px ueber der Kante`);
  assert.equal(bad.length, 0, `${where}: ${bad.length} von ${rows.length} Messungen mit gequetschter Auswahl oder Ueberlauf\n  ${sample.join('\n  ')}`);
}

test('die Sonde misst das Markup, das sync-reminders.js und createSettingRow() bauen', () => {
  const page = readFileSync(join(ROOT, 'public/settings/pages/sync-reminders.js'), 'utf8');
  assert.ok(page.includes("wrapper.className = 'caldav-reminder-item';"), 'die Listenzeile heisst anders');
  assert.ok(page.includes("select.className = 'form-input caldav-reminder-module';"), 'die Modulwahl heisst anders');
  assert.ok(page.includes("toggle.className = 'caldav-reminder-checkbox';"), 'der Schalter heisst anders');
  // Seit #2316 steht die Personenwahl als dritter Geschwister in der Zeile. Die
  // Sonde fuehrt Einkaufslisten, und dort ist sie verborgen (`hidden`).
  assert.ok(page.includes('wrapper.append(row, select, assignees);'), 'Name samt Schalter, Modulwahl und Personenwahl stehen nicht mehr als Geschwister in der Zeile');
  assert.ok(page.includes("triggerClass: 'form-input caldav-reminder-assignees',"), 'die Personenwahl heisst anders');
  assert.ok(page.includes("trigger.hidden = list.targetModule !== 'tasks';"), 'die Personenwahl steht auch neben einer Einkaufsliste');
  assert.ok(page.includes("note.className = 'caldav-calendar-source caldav-reminder-note';"), 'der Nur-lesbar-Hinweis heisst anders');
  assert.ok(page.includes("list.className = 'caldav-calendars-list';"), 'die Liste heisst anders');
  const components = readFileSync(join(ROOT, 'public/settings/components.js'), 'utf8');
  for (const cls of [
    "row.className = 'settings-setting-row form-row';",
    "copy.className = 'settings-setting-row__copy form-row__copy';",
    "title.className = 'settings-setting-row__label form-row__label';",
    "controlContainer.className = 'settings-setting-row__control form-row__control';",
  ]) assert.ok(components.includes(cls), `createSettingRow() baut anders: ${cls}`);
});

test('die Sonde erkennt eine gequetschte Auswahl: die alte Regel faellt auf', async () => {
  const rows = await sweep(375, [311], { squeeze: true });
  assert.ok(rows.some((r) => r.select < r.need), `mit flex: 1 und min-width: 0 behaelt die Auswahl ihren Wert - die Sonde misst nichts (${JSON.stringify(rows)})`);
});

test('Telefon (375px und 320px Fenster): die Auswahl behaelt ihren Wert, nichts laeuft ueber', async () => {
  for (const viewport of [375, 320]) {
    assertReadable(await sweep(viewport, range(240, viewport - 32)), `${viewport}px`);
  }
});

test('Telefon: neben einem langen Namen rutscht die Auswahl unter ihn', async () => {
  const rows = await sweep(375, [311]);
  for (const r of rows.filter((x) => !x.name.startsWith('Einkauf'))) {
    assert.ok(r.below, `"${r.name}" bei 311px: die Auswahl steht noch neben dem Namen (${r.select}px)`);
  }
});

test('Desktop: Name und Auswahl teilen eine Zeile, auch bei langem Namen', async () => {
  const rows = await sweep(1280, range(480, 720, 8));
  assertReadable(rows, 'Desktop');
  // Der Nur-lesbar-Hinweis bricht die Zeile bewusst um (#1840); gemeint ist die Auswahl.
  const beside = rows.filter((r) => r.below);
  assert.equal(beside.length, 0, `Desktop: die Auswahl rutscht unter den Namen\n  ${beside.slice(0, 5).map((r) => `"${r.name}" bei ${r.w}px`).join('\n  ')}`);
});
