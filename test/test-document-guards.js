/**
 * Modul: Dokument-Guards (Guard-Ebene 4 des Redesigns)
 * Zweck: Invarianten pruefen, die nur das GERENDERTE Dokument kennt. Das
 *        Stylesheet zeigt sie nicht: ein Ueberlauf kann von
 *        `overflow-x: hidden` verdeckt sein, eine Zielgroesse misst keine
 *        Textsuche, und ein Kontrastverstoss kann erst durch die Komposition
 *        zweier Regeln entstehen, deren Token-Paare je fuer sich AA halten.
 * Ausfuehren: npm run test:document-guards   (braucht Browser + Serverprozess)
 *
 * NICHT in `npm test`: die uebrige Kette ist netzfrei und serverlos und soll
 * das bleiben. test-suite-chain.js kennt die Zweiteilung als Regel (eine Suite,
 * die `puppeteer` importiert, gehoert in die Browser-Kette), nicht als
 * Namensausnahme.
 *
 * Der Harness (test/document-guards-harness.js) faehrt Server und Browser hoch.
 * Waehrend der Entwicklung zeigt `DOCUMENT_GUARDS_BASE_URL` auf einen bereits
 * laufenden Preview-Server und spart Migration + Seed.
 */

import { test, before, beforeEach, after, describe } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import {
  ROUTES,
  ANON_ROUTES,
  SETTINGS_ROUTES,
  startHarness,
  openPage,
  openAnonPage,
  gotoRoute,
  gotoAnonRoute,
  parseColor,
  composite,
  contrastRatio,
  toHex,
} from './document-guards-harness.js';
import { eachRule } from './css-rules.js';

const ROUTE_NAMES = Object.keys(ROUTES);
const SETTINGS_NAMES = Object.keys(SETTINGS_ROUTES);
const ALL_ROUTES = { ...ROUTES, ...SETTINGS_ROUTES };
let harness;

/* ────────────────────────────────────────────────────────────────────────────
 * Welche Sonde faehrt die 23 Settings-Blaetter - und welche nicht
 *
 * Die Blaetter kommen aus der Registry (siehe `SETTINGS_ROUTES` im Harness).
 * Sie an JEDE Sonde zu haengen waere bequem und falsch: die Suite liegt bei
 * ~26 Minuten, und 23 zusaetzliche Zustaende mal elf Sonden sind nicht gratis.
 *
 * DIE VOREINSTELLUNG IST „JA". Wer ein Blatt auslaesst, traegt hier ein, WARUM
 * die Regel dort nichts zu messen hat - das ist eine Aussage ueber die Regel,
 * keine Bequemlichkeit (Sonde 8 faehrt aus genau diesem Grund seit jeher nur
 * mobil). Eine neu gebaute Sonde sieht die Blaetter damit automatisch; das
 * Vergessen faellt auf die Seite der Vollstaendigkeit, nicht auf die der Luecke.
 *
 * Jeder Eintrag ist gegen den Bestand geprueft, nicht vermutet.
 * ──────────────────────────────────────────────────────────────────────────── */
const LEAVES_SKIPPED = new Map([
  ['Sonde 1', 'misst `.page-toolbar`. Ein Settings-Blatt traegt keine - sein Kopf ist '
    + '`.settings-leaf-header` (settings/shell.js:509), und das ist die Leisten-Regel (§2) '
    + 'und keine Auslassung: `/settings` fuehrt der Router als EINE Route mit einem '
    + 'Modulkopf, die Blaetter darunter sind Detailseiten. Die Sonde faende dort null '
    + 'Leisten und meldete 69 gruene Zustaende, die nie gemessen wurden. Den '
    + 'Dokument-Ueberlauf der Blaetter misst Sonde 10, und die faehrt sie.'],
  ['Sonde 20', 'misst Kopf-Tablists (`.page-toolbar [role="tablist"]`) und die Kuechen-Rail '
    + '(`.sub-tabs-bar`). Ein Settings-Blatt traegt keine `.page-toolbar` (siehe Sonde 1), und '
    + '`.sub-tabs-bar` kommt in `public/settings/**` nicht vor (geprueft, 0 Treffer). Die Sonde '
    + 'faende dort null Leisten und kostete 23 Blaetter Ladezeit fuer nichts.'],
  ['Sonde 19', 'misst `.page-toolbar` und zaehlt ihre Zeilen. Ein Settings-Blatt traegt '
    + 'keine - derselbe Grund wie bei Sonde 1, und dieselbe Folge: 23 Blaetter mal zwei '
    + 'Sprachen mal drei Breiten waeren 138 Zustaende ohne eine einzige Messung, die '
    + 'anschliessend als gruen zaehlten.'],
  ['Sonde 5', 'faehrt eine Wischgeste auf `.swipe-row`. In `public/settings/**` kommt die '
    + 'Klasse nicht vor (geprueft, 0 Treffer); die Sonde ueberspringt einen Zustand ohne '
    + 'Wischzeile ohnehin. 23 Blaetter mal zwei Sprachen waeren reine Ladezeit ohne eine '
    + 'einzige Messung.'],
  ['Sonde 6', 'misst `.metric-grid`. Kommt in `public/settings/**` nicht vor (0 Treffer). '
    + 'Kennzahlreihen sind eine Bauform der Module, nicht der Einstellungen.'],
  ['Sonde 8', 'prueft das Andocken eines Kopfes MIT `--page-toolbar-lead`. Den setzt nur '
    + '`.page-toolbar`, und die gibt es auf einem Blatt nicht (siehe Sonde 1). Ohne '
    + 'Lead-Zone faellt jedes Blatt in die triviale Haelfte der Regel, die die Sonde dann '
    + '23-mal bestaetigt.'],
  ['Sonde 12', 'misst Glasflaechen, und die sitzen in der SHELL - Tab-Bar, Sidebar, Sheets, '
    + 'Toast, Datepicker-Popover, FAB. Die ist auf jeder Route dieselbe, also kaeme ein Befund '
    + 'dort 39-mal statt 16-mal. (Hier stand „dieselbe Begruendung wie bei Sonde 11" - Sonde 11 '
    + 'steht gar nicht in dieser Map, sie FAEHRT die Blaetter. Der Kopf oben verspricht „gegen '
    + 'den Bestand geprueft, nicht vermutet"; dieser Verweis war es nicht.) Gegengeprueft, dass '
    + 'die Blaetter keine eigene Glasflaeche mitbringen: `public/settings/**` setzt nirgends '
    + '`backdrop-filter`, und der einzige Glastraeger ihrer Shell ist die Sidebar der App.'],
  ['Sonde 13', 'oeffnet Modals ueber den FAB, und die Einstellungen haben keinen - weder die '
    + 'Uebersicht noch eines der 23 Blaetter. Die Sonde wuerde 23 Zustaende laden und '
    + '23-mal „kein FAB" in den Uebersprungsbeleg schreiben. Der Eintrag steht hier, weil sie '
    + 'bis Session 24 `ROUTE_NAMES` direkt nahm und die Blaetter damit STILLSCHWEIGEND '
    + 'ausliess: die Auslassung war richtig, aber nicht an der Stelle begruendet, an der '
    + 'jemand sie sucht - und genau dafuer gibt es diese Map.'],
  ['Sonde 15', 'misst die Bauhoehe von `.page-toolbar` - dieselbe Begruendung wie Sonde 1: '
    + 'ein Settings-Blatt traegt keine, sein Kopf ist `.settings-leaf-header`. Die Sonde '
    + 'faende dort null Koepfe, und ihre eigene „nichts gemessen"-Zusicherung (seen >= 12) '
    + 'wuerde von 23 leeren Zustaenden nicht beruehrt - sie meldete gruen aus dem falschen '
    + 'Grund. Die Chrome-Regel gilt fuer die Blaetter trotzdem; wer sie dort pruefen will, '
    + 'misst `.settings-leaf-header` und nicht diesen Selektor.'],
]);

/** Die Zustaende, die eine Sonde abfaehrt: die 16 Routen, dazu die Blaetter. */
function sweep(probe) {
  return LEAVES_SKIPPED.has(probe) ? ROUTE_NAMES : [...ROUTE_NAMES, ...SETTINGS_NAMES];
}

/**
 * Auf einem Settings-Blatt wird NICHT durch die Sichten geklickt.
 *
 * `visitViews` faehrt jede exklusive Auswahl, die eine Seite deklariert - in den
 * Modulen ist das ein Sichtwechsel. In `public/settings/**` sind es drei
 * Gruppen, und zwei davon SCHREIBEN: der Themenschalter
 * (personal-appearance.js:165, setzt die Farbwelt fuer alles danach) und der
 * Wochenstart (modules-calendar.js:88, eine haushaltweite Einstellung in der
 * Datenbank). Nur der Modus-Umschalter der Rechtevergabe
 * (admin-permissions.js:547) ist ein reiner Sichtwechsel.
 *
 * Eine Sonde, die zwei von drei Gruppen umstellt, schreibt in den Seed und misst
 * beim naechsten Lauf eine andere App - genau die Grenze, die `visitViews` fuer
 * das `<select>` schon zieht. Die Signatur unterscheidet die drei nicht: ein
 * Themenknopf und ein Sicht-Umschalter tragen beide `aria-pressed`. Deshalb hier
 * die Regel und keine Ausnahmeliste; der Preis ist die zweite Sicht der
 * Rechtevergabe, deren erste (Rollen) im Standardzustand gemessen wird.
 */
const isLeaf = (name) => name.startsWith('settings/');

test('die Auslassungen der Settings-Blaetter nennen eine Sonde, die es gibt', () => {
  // Eine Begruendung fuer eine Sonde, die niemand mehr faehrt, ist eine
  // Allowlist, die keiner liest - dieselbe Stale-Pruefung wie bei SHAPE_EXEMPT
  // und TARGET_EXEMPT, nur ueber die eigene Datei.
  //
  // GESUCHT WIRD DER AUFRUF, NICHT DER NAME. Ein `includes('Sonde 1 -')` waere
  // gruen auf dem Kommentar, der das Entfallen der Sonde begruendet - genau die
  // Bauart, mit der der Eyebrow-Guard drei Runden lang das Gegenteil seiner
  // Regel bestaetigt hat. Ein Kommentar ist kein Aufruf von `test`/`describe`.
  const source = readFileSync(new URL(import.meta.url), 'utf8');
  const stale = [...LEAVES_SKIPPED.keys()]
    .filter((probe) => !new RegExp(`(?:test|describe)\\(\\s*'${probe} -`).test(source));
  assert.deepEqual(stale, [],
    'LEAVES_SKIPPED begruendet eine Auslassung fuer eine Sonde, die es nicht mehr gibt.');

  // Und die Gegenrichtung: die Ableitung muss ueberhaupt etwas liefern. Keine
  // feste Zahl - die Registry ist die Quelle, und ein neues Blatt soll die Suite
  // erweitern statt sie rot zu faerben (dieselbe Zusicherung wie „eine Sonde,
  // die nichts gemessen hat, darf nicht urteilen").
  assert.ok(SETTINGS_NAMES.length >= 20,
    `Nur ${SETTINGS_NAMES.length} Settings-Blaetter aus der Registry abgeleitet - `
    + 'die Ableitung greift nicht mehr, und die Sonden faehren wieder nur `/settings`.');
});

/* ────────────────────────────────────────────────────────────────────────────
 * Die Stylesheet-Quelle der Stale-Pruefungen
 *
 * Drei Ausnahmelisten dieser Datei fragen „gibt es die Klasse noch?". Bis
 * 2026-08-09 fragten zwei davon `allCss.includes('.' + cls)` ueber
 * zusammengehaengte, KOMMENTARBEHAFTETE Quellen - dieselbe Falle, die den
 * CSS-Regelscanner ueberhaupt erst noetig gemacht hat, in ihrer Schwesterform:
 *
 *   1. Eine Klasse, die nur noch in einem Kommentar steht („frueher trug
 *      `.item-check` hier…"), behaelt ihre Ausnahme fuer immer.
 *   2. `includes('.item-check')` ist auf `.item-checkbox` gruen. Eine
 *      Teilzeichenkette ist kein Klassenname.
 *
 * `eachRule()` (test/css-rules.js) ist seit Session 25 DER eine Regelscanner -
 * er strippt Kommentare und liefert Selektoren. Die Klassen kommen aus dem
 * SELEKTOR und als ganze Token, damit beide Fallen zu sind.
 * ──────────────────────────────────────────────────────────────────────────── */

/** Jede Regel aller App-Stylesheets, mit ihrer Datei. */
function allStyleRules() {
  const styles = new URL('../public/styles/', import.meta.url);
  const out = [];
  for (const entry of readdirSync(styles).filter((name) => name.endsWith('.css'))) {
    const css = readFileSync(new URL(entry, styles), 'utf8');
    for (const rule of eachRule(css)) out.push({ ...rule, file: entry });
  }
  return out;
}

/** Jeder Klassenname, den irgendein Selektor nennt - als ganzes Token. */
function selectorClasses(rules = allStyleRules()) {
  const out = new Set();
  for (const rule of rules) {
    for (const match of rule.selector.matchAll(/\.(-?[_a-zA-Z][\w-]*)/g)) out.add(match[1]);
  }
  return out;
}

/**
 * Die aktuelle Route besuchen UND jede SICHT, die sie selbst als umschaltbar
 * deklariert. `visit(where)` laeuft in jedem Zustand einmal.
 *
 * WARUM DAS SEIN MUSS: eine Route ist nicht dasselbe wie eine Sicht. Von sieben
 * Kennzahlreihen der App liegt genau eine auf einer eigenen Route, die
 * Abo-Wischliste auf gar keiner, und die Listenansicht der Dokumente ebenso
 * wenig - Standard ist dort das Raster. Wer nur `ROUTES` abfaehrt, bekommt
 * seinen Guard gruen und hat die Haelfte der App nie gesehen. Die Leisten-Regel
 * (§2) sagt es von der anderen Seite: ein Untertab wechselt die SICHT, nicht
 * die Route.
 *
 * DIE SICHTEN KOMMEN AUS DEM MARKUP, NICHT AUS EINER LISTE: gefahren wird, was
 * die Seite selbst als exklusive Auswahl auszeichnet - `role="tab"` in einer
 * Tablist und Gruppen von `aria-pressed`-Knoepfen unter einem Traeger. Das ist
 * dieselbe Ableitung wie beim Glas-Guard (Session 16): die Zusage steht im
 * Element, nicht in einem Namen. Damit erreicht der Helfer alle vier Bauarten,
 * die es heute gibt (Budget-Untertabs, Health-Routen, Housekeeping-Tabs, der
 * Raster/Listen-Umschalter der Dokumente) und die, die noch kommen.
 *
 * NICHT ANGEFASST WIRD EIN `<select>`: das ist ein Eingabefeld. Eine Sonde, die
 * eines umstellt, schreibt in den Seed - genau die Grenze, die Sonde 5 fuer die
 * Wischgeste zieht.
 *
 * ZURUECKGESTELLT WIRD IMMER: `localStorage` haengt am Origin, nicht an der
 * Page. Ein hier umgeschalteter Zustand (die Dokumente merken sich ihre
 * Ansicht) fuende sich sonst in der naechsten Sonde wieder, und die maesse dann
 * eine Seite, die so nie jemand oeffnet.
 */
async function visitViews(page, where, visit) {
  await visit(where);

  const groups = await page.evaluate(() => {
    const vis = (el) => {
      const r = el.getBoundingClientRect();
      return r.width > 0 && r.height > 0;
    };
    const out = [];
    for (const list of document.querySelectorAll('[role="tablist"]')) {
      const tabs = [...list.querySelectorAll('[role="tab"]')].filter(vis);
      const cls = [...list.classList][0];
      if (tabs.length > 1 && cls) out.push({ sel: `.${cls} [role="tab"]`, n: tabs.length });
    }
    const byParent = new Map();
    for (const btn of document.querySelectorAll('[aria-pressed]')) {
      if (!vis(btn) || btn.closest('[role="tablist"]')) continue;
      const parent = btn.parentElement;
      if (!parent) continue;
      if (!byParent.has(parent)) byParent.set(parent, []);
      byParent.get(parent).push(btn);
    }
    for (const [parent, btns] of byParent) {
      const cls = [...parent.classList][0];
      if (btns.length > 1 && cls) out.push({ sel: `.${cls} > [aria-pressed]`, n: btns.length });
    }
    return out;
  });

  const active = (sel) => page.evaluate((s) => [...document.querySelectorAll(s)]
    .findIndex((e) => e.getAttribute('aria-selected') === 'true' || e.getAttribute('aria-pressed') === 'true'), sel);
  const clickAt = (sel, idx) => page.evaluate((s, i) => {
    const el = document.querySelectorAll(s)[i];
    if (!el) return false;
    el.click();
    return true;
  }, sel, idx);

  for (const group of groups) {
    const before = await active(group.sel);
    for (let i = 0; i < group.n; i += 1) {
      if (!(await clickAt(group.sel, i))) continue;
      // Der Wechsel laedt seine Daten nach; ohne das Warten misst die Sonde die
      // VORIGE Sicht (dieselbe Falle wie in Session 11, „eine Sonde misst nur,
      // was zum Messzeitpunkt existiert").
      await new Promise((resolve) => setTimeout(resolve, 1000));
      await visit(`${where}:${i}`);
    }
    if (before >= 0) {
      await clickAt(group.sel, before);
      await new Promise((resolve) => setTimeout(resolve, 600));
    }
  }
}

before(async () => {
  harness = await startHarness();
});

// JEDE SONDE BEGINNT AUF DEMSELBEN STAND (#1104). Die Sonden teilen einen
// Server, und bis hierher trug jede drei Dinge an die naechste weiter: das
// API-Limit (300 Anfragen pro Minute je IP, und jede Sonde ist 127.0.0.1), ihre
// liegengebliebenen Daten und - ueber einen 429 auf /auth/me - eine Seite, die
// auf /login steht. Eine Sonde fiel dann fuer die Sonde vor ihr: in #1044 war
// derselbe Probe-Code einmal gruen und einmal rot. `reset()` startet den Server
// auf dem Stand nach Seed und Anmeldung neu und gibt jeder Sonde einen frischen
// Browser-Kontext; eine Sonde ohne Seite kostet nur den Kontext. Damit misst ein
// gezielter Lauf (`--test-name-pattern`) dieselben Vorbedingungen wie der volle.
beforeEach(async () => {
  await harness.reset();
});

after(async () => {
  await harness?.close();
});

test('save confirmations preserve the same editor across repeated gates and keep legacy delete closing', async () => {
  const page = await openPage(harness, { device: 'desktop', locale: 'de' });
  try {
    await page.evaluate(async () => {
      const modal = await import('/components/modal.js');
      let closeCount = 0;
      modal.openModal({
        title: 'Unsaved editor',
        content: '<form><input id="gate-title" value="Original title"><textarea id="gate-description">Original notes</textarea><button type="button" id="gate-save">Save</button></form>',
        onClose: () => { closeCount += 1; },
      });
      window.saveGateTest = {
        modal,
        editor: document.getElementById('shared-modal-overlay'),
        title: document.getElementById('gate-title'),
        description: document.getElementById('gate-description'),
        closeCount: () => closeCount,
      };
      modal.refreshDirtySnapshot();
      window.saveGateTest.title.value = 'Unsaved title';
      window.saveGateTest.description.value = 'Unsaved multiline\nnotes';
    });

    for (const confirmed of [false, true, true, false]) {
      await page.evaluate(() => {
        document.getElementById('gate-save').focus();
        const state = window.saveGateTest;
        state.pending = state.modal.confirmOverModal('Continue saving?', { closeOnConfirm: false });
      });
      await page.click(confirmed ? '#confirm-modal-ok' : '#confirm-modal-cancel');
      const state = await page.evaluate(async () => {
        const state = window.saveGateTest;
        const confirmed = await state.pending;
        return {
          confirmed,
          sameEditor: document.getElementById('shared-modal-overlay') === state.editor,
          sameTitle: document.getElementById('gate-title') === state.title,
          sameDescription: document.getElementById('gate-description') === state.description,
          title: document.getElementById('gate-title')?.value,
          description: document.getElementById('gate-description')?.value,
          interactive: state.editor.isConnected && !state.editor.inert,
          closeCount: state.closeCount(),
          focus: document.activeElement?.id,
          overlayCount: document.querySelectorAll('.modal-overlay').length,
        };
      });
      assert.deepEqual(state, {
        confirmed,
        sameEditor: true,
        sameTitle: true,
        sameDescription: true,
        title: 'Unsaved title',
        description: 'Unsaved multiline\nnotes',
        interactive: true,
        closeCount: 0,
        focus: 'gate-save',
        overlayCount: 1,
      });
    }

    // Resuming a save gate must preserve the editor's original dirty baseline.
    await page.evaluate(() => { window.saveGateTest.pending = window.saveGateTest.modal.closeModal(); });
    await page.waitForSelector('#confirm-modal-cancel');
    await page.click('#confirm-modal-cancel');
    assert.equal(await page.evaluate(async () => {
      await window.saveGateTest.pending;
      return document.getElementById('shared-modal-overlay') === window.saveGateTest.editor;
    }), true);

    // Delete callers omit the new option and still close on confirmation.
    await page.evaluate(() => {
      window.saveGateTest.pending = window.saveGateTest.modal.confirmOverModal('Delete this event?');
    });
    await page.click('#confirm-modal-ok');
    assert.deepEqual(await page.evaluate(async () => {
      const confirmed = await window.saveGateTest.pending;
      return { confirmed, closeCount: window.saveGateTest.closeCount(), editorConnected: window.saveGateTest.editor.isConnected };
    }), { confirmed: true, closeCount: 1, editorConnected: false });
  } finally {
    await page.close();
  }
});

async function openCalendarSaveGateEditor(page, { wholeSeriesOnly = false } = {}) {
  const seriesId = await page.evaluate(async (wholeSeriesOnly) => {
    const { api } = await import('/api.js');
    const { data: event } = await api.post('/calendar', {
      title: 'Calendar save gate original',
      start_datetime: '2048-04-03T09:00:00',
      end_datetime: '2048-04-03T10:00:00',
      recurrence_rule: 'FREQ=DAILY;COUNT=3',
    });
    await api.put(`/calendar/${event.id}/occurrences/2048-04-04`, { title: 'Linked second occurrence' });
    if (wholeSeriesOnly) {
      // Preserve the real response shape while exercising the server capability
      // contract for local series that cannot offer occurrence edits.
      const get = api.get.bind(api);
      api.get = async (...args) => {
        const response = await get(...args);
        for (const row of Array.isArray(response.data) ? response.data : [response.data]) {
          if (row?.id === event.id) {
            row.can_override_occurrence = false;
            row.can_detach_occurrence = false;
          }
        }
        return response;
      };
    }
    return event.id;
  }, wholeSeriesOnly);
  await page.evaluate((path) => window.yuvomi.navigate(path), `/calendar?open=${seriesId}&date=2048-04-03`);
  await page.waitForSelector('#detail-popover-edit, #detail-view-edit');
  await page.click('#detail-popover-edit, #detail-view-edit');
  await page.waitForSelector('#modal-title');
  await page.evaluate(() => {
    window.calendarGateTest = {
      editor: document.getElementById('shared-modal-overlay'),
      title: document.getElementById('modal-title'),
      description: document.getElementById('modal-description'),
    };
    window.calendarGateTest.title.value = 'Calendar save gate unsaved';
    window.calendarGateTest.description.value = 'Typed notes must survive';
  });
  return seriesId;
}

async function assertCalendarSaveGateEditor(page) {
  assert.deepEqual(await page.evaluate(() => {
    const state = window.calendarGateTest;
    return {
      sameEditor: document.getElementById('shared-modal-overlay') === state.editor,
      sameTitle: document.getElementById('modal-title') === state.title,
      sameDescription: document.getElementById('modal-description') === state.description,
      title: document.getElementById('modal-title')?.value,
      description: document.getElementById('modal-description')?.value,
      interactive: state.editor.isConnected && !state.editor.inert,
      saveEnabled: document.getElementById('modal-save')?.disabled === false,
    };
  }), {
    sameEditor: true,
    sameTitle: true,
    sameDescription: true,
    title: 'Calendar save gate unsaved',
    description: 'Typed notes must survive',
    interactive: true,
    saveEnabled: true,
  });
}

test('calendar save gates retain unsaved fields after orphan confirmation, server failure and canceled retry', async () => {
  const page = await openPage(harness, { device: 'desktop', locale: 'de' });
  try {
    const seriesId = await openCalendarSaveGateEditor(page);
    const attempts = [];
    page.removeAllListeners('request');
    page.on('request', (request) => {
      const pathname = new URL(request.url()).pathname;
      if (pathname === '/sw.js') return void request.abort();
      if (pathname === `/api/v1/calendar/${seriesId}` && request.method() === 'PUT') {
        const body = JSON.parse(request.postData());
        attempts.push(body);
        if (body.confirmed_orphan_count === 1) {
          return void request.respond({
            status: 500,
            contentType: 'application/json',
            body: JSON.stringify({ error: 'Save gate test server failure', code: 500 }),
          });
        }
      }
      void request.continue();
    });
    await page.select('#modal-edit-scope', 'series');
    await page.evaluate(() => { document.getElementById('event-rrule-count').value = '1'; });
    await page.click('#modal-save');
    await page.waitForSelector('#confirm-modal-ok');
    assert.equal(attempts.length, 1, 'the real server must reject the rule that orphans its linked child');
    await page.click('#confirm-modal-ok');
    await page.waitForFunction(() => [...document.querySelectorAll('[role="alert"], .toast')]
      .some((element) => element.textContent.includes('Save gate test server failure')));
    await assertCalendarSaveGateEditor(page);
    assert.equal(attempts.length, 2);
    assert.equal(attempts[1].confirmed_orphan_count, 1);
    assert.equal(attempts[1].title, 'Calendar save gate unsaved');

    await page.waitForFunction(() => ![...document.querySelectorAll('.toast')]
      .some((element) => element.textContent.includes('Save gate test server failure')));
    await page.click('#modal-save');
    await page.waitForSelector('#confirm-modal-cancel');
    await page.click('#confirm-modal-cancel');
    await page.waitForFunction(() => !document.getElementById('confirm-modal-cancel')
      && document.getElementById('modal-save')?.disabled === false);
    await assertCalendarSaveGateEditor(page);
    assert.equal(attempts.length, 3, 'canceling the repeated gate must not send a confirmed write');
    const persisted = await page.evaluate(async (id) => {
      const { api } = await import('/api.js');
      return (await api.get(`/calendar/${id}`)).data;
    }, seriesId);
    assert.equal(persisted.title, 'Calendar save gate original');
    assert.equal(persisted.recurrence_rule, 'FREQ=DAILY;COUNT=3');
  } finally {
    await page.close();
  }
});

test('calendar whole-series save confirmation leaves invalid UNTIL editable', async () => {
  const page = await openPage(harness, { device: 'desktop', locale: 'de' });
  try {
    await openCalendarSaveGateEditor(page, { wholeSeriesOnly: true });
    assert.equal(await page.$('#modal-edit-scope'), null, 'the fixture must use the whole-series-only capability');
    await page.select('#event-rrule-end', 'until');
    await page.evaluate(() => {
      const picker = document.getElementById('event-rrule-until');
      const input = picker.querySelector('input');
      input.value = '31.02.2048';
      // The picker currently exposes invalid text as an empty canonical value.
      // Supply its raw-value boundary explicitly to exercise saveEvent's real
      // valid_until=false branch without changing datepicker behavior here.
      Object.defineProperty(picker, 'value', { get: () => input.value, configurable: true });
    });
    await page.click('#modal-save');
    await page.waitForSelector('#confirm-modal-ok');
    await page.click('#confirm-modal-ok');
    await page.waitForFunction(() => document.getElementById('event-rrule-until')?.getAttribute('aria-invalid') === 'true');
    await assertCalendarSaveGateEditor(page);
    assert.equal(await page.$eval('#event-rrule-until', (input) => input.value), '31.02.2048');
  } finally {
    await page.close();
  }
});

test('PR2 #975 - das zusammengesetzte Kalenderformular und seine Seriennamen bleiben wahr', async () => {
  const page = await openPage(harness, { device: 'desktop', locale: 'de' });
  const title = 'PR2 Serienprobe 975';
  try {
    await gotoRoute(page, '/calendar');
    await page.click('#cal-add');
    await page.waitForSelector('#modal-title');

    const hints = await page.evaluate((eventTitle) => {
      const change = (el) => el.dispatchEvent(new Event('change', { bubbles: true }));
      const setDate = (selector, value) => {
        const el = document.querySelector(selector);
        el.value = value;
        change(el);
      };
      const text = () => document.querySelector('#event-rrule-monthday-hint')?.textContent || '';

      document.querySelector('#modal-title').value = eventTitle;
      setDate('#modal-start-date', '2026-09-15');
      const freq = document.querySelector('#event-rrule-freq');
      freq.value = 'MONTHLY';
      change(freq);
      const lastDay = document.querySelector('#event-rrule-last-day');
      lastDay.checked = true;
      change(lastDay);
      const timed = text();

      const end = document.querySelector('#event-rrule-end');
      end.value = 'until';
      change(end);
      setDate('#event-rrule-until', '2026-09-20');
      const ended = text();

      end.value = 'never';
      change(end);
      const allDay = document.querySelector('#modal-allday');
      allDay.checked = true;
      change(allDay);
      setDate('#modal-allday-start', '2026-10-20');
      const allDayOctober = text();

      allDay.checked = false;
      change(allDay);
      setDate('#modal-start-date', '2026-09-15');
      return { timed, ended, allDayOctober };
    }, title);

    assert.match(hints.timed, /30\.09\.2026/,
      'das echte Zeitfeld bestimmt den ersten Monatsletzten');
    assert.doesNotMatch(hints.ended, /30\.09\.2026/,
      'ein live gesetztes fruehes UNTIL darf keinen unmoeglichen Termin versprechen');
    assert.match(hints.allDayOctober, /31\.10\.2026/,
      'nach dem Umschalten bestimmt das echte Ganztagsfeld die Vorschau');

    await page.click('#modal-save');
    await page.waitForFunction((eventTitle) => [...document.querySelectorAll('.month-day__event span')]
      .some((el) => el.textContent === eventTitle), {}, title);
    const monthA11y = await page.evaluate((eventTitle) => {
      const chip = [...document.querySelectorAll('.month-day__event')]
        .find((el) => el.querySelector('span:last-child')?.textContent === eventTitle);
      const repeat = chip?.querySelector('.calendar-repeat-icon');
      return {
        repeatLabel: repeat?.getAttribute('aria-label') || '',
        repeatIsSvg: Boolean(repeat?.querySelector('svg')),
        dayLabel: chip?.closest('.month-day')?.getAttribute('aria-label') || '',
      };
    }, title);
    assert.ok(monthA11y.repeatLabel, 'die Serienmarke hat nach der Lucide-Ersetzung einen Namen');
    assert.equal(monthA11y.repeatIsSvg, true, 'die echte Lucide-Ersetzung ist Teil der Komposition');
    assert.match(monthA11y.dayLabel, new RegExp(title),
      'das Tages-aria-label verschluckt den zugänglichen Serientitel nicht');

    await page.click('#cal-view-tab-agenda');
    await page.waitForFunction((eventTitle) => [...document.querySelectorAll('.agenda-event')]
      .some((el) => el.textContent.includes(eventTitle)), {}, title);
    const agendaLabel = await page.evaluate((eventTitle) => [...document.querySelectorAll('.agenda-event')]
      .find((el) => el.textContent.includes(eventTitle))?.getAttribute('aria-label') || '', title);
    assert.match(agendaLabel, new RegExp(title));
    assert.match(agendaLabel, new RegExp(monthA11y.repeatLabel),
      'das eigene Agenda-aria-label muss dieselbe Serienbedeutung tragen');
  } finally {
    await page.close();
  }
});

/* ────────────────────────────────────────────────────────────────────────────
 * Sonde 1: Kopf-Ueberlauf
 *
 * Der Modulkopf ist die einzige Komponente, die alle 17 Module teilen, und die
 * Stelle, an der ein Ueberlauf unsichtbar bleibt: `main.app-content` traegt
 * `overflow-x: hidden`, also wird abgeschnitten statt scrollbar. Gemessen im
 * Architektur-Audit: der Kopf der Haushaltshilfe ragte bei 375px 79px ueber die
 * rechte Kante, Titel und rechte Tabs waren teilweise unerreichbar.
 *
 * Die Regel prueft NACHFAHREN, nicht nur Kinder: eine Tab-Leiste im Kopf darf
 * ihre Tabs ueberlaufen lassen, WENN sie selbst scrollt oder clippt. Deshalb
 * wird jeder Nachfahre uebersprungen, dessen Weg zur Toolbar durch einen
 * Container mit nicht-sichtbarem overflow-x fuehrt - genau die Bauart, die die
 * Shell-Regel vorschreibt.
 *
 * Sprachen: `de` als Referenz, `uk` und `vi` als die beiden Locales mit den
 * laengsten Modulnamen. Ein Kopf, der in allen dreien passt, passt.
 * ──────────────────────────────────────────────────────────────────────────── */

const OVERFLOW_LOCALES = ['de', 'uk', 'vi'];

async function measureHeadOverflow(page) {
  return page.evaluate(() => {
    const out = [];
    const vw = document.documentElement.clientWidth;
    const selector = (el) => {
      const cls = [...el.classList].filter((c) => !c.startsWith('is-')).join('.');
      return `${el.tagName.toLowerCase()}${cls ? `.${cls}` : ''}`;
    };
    for (const bar of document.querySelectorAll('.page-toolbar')) {
      const barRect = bar.getBoundingClientRect();
      if (!barRect.width || !barRect.height) continue;
      const walk = (el, clipped) => {
        for (const child of el.children) {
          const cs = getComputedStyle(child);
          if (cs.display === 'none' || cs.visibility === 'hidden') continue;
          const r = child.getBoundingClientRect();
          if (!r.width && !r.height) continue;
          if (!clipped) {
            const over = Math.round(Math.max(r.right - vw, -r.left));
            if (over > 1) {
              out.push({
                toolbar: selector(bar),
                el: selector(child),
                over,
                width: Math.round(r.width),
              });
            }
          }
          const clips = cs.overflowX !== 'visible';
          walk(child, clipped || clips);
        }
      };
      const barOver = Math.round(Math.max(barRect.right - vw, -barRect.left));
      if (barOver > 1) {
        out.push({ toolbar: selector(bar), el: '(die Leiste selbst)', over: barOver, width: Math.round(barRect.width) });
      }
      walk(bar, false);
    }
    return out;
  });
}

describe('Sonde 1 - kein Modulkopf laeuft bei 375px ueber die Viewport-Kante', () => {
  for (const locale of OVERFLOW_LOCALES) {
    test(`Locale ${locale}`, async () => {
      const page = await openPage(harness, { device: 'mobile', theme: 'light', locale });
      const findings = [];
      for (const name of sweep('Sonde 1')) {
        await gotoRoute(page, ALL_ROUTES[name]);
        for (const f of await measureHeadOverflow(page)) {
          findings.push(`${name}/${locale}: ${f.el} in ${f.toolbar} ragt ${f.over}px hinaus (Breite ${f.width}px)`);
        }
      }
      await page.close();
      assert.deepEqual(
        findings,
        [],
        `Kopf-Ueberlauf bei 375px. Die Shell-Regel lautet: eine .page-toolbar bleibt in ` +
          `Zeilenrichtung, und eine Tab-Leiste im Kopf ist eine eigene, horizontal ` +
          `scrollende Zeile darunter (layout.css, Sektion "Tab-Leiste im Modulkopf").\n  ` +
          findings.join('\n  '),
      );
    });
  }
});

/* ────────────────────────────────────────────────────────────────────────────
 * Sonde 2: komponierter Textkontrast
 *
 * Der bestehende Guard `Textfarbe auf vividen Fuellflaechen haelt WCAG AA in
 * beiden Themes` (test-frontend-audit.js) prueft TOKEN-PAARE. Er kann einen
 * Verstoss nicht sehen, der erst im Dokument entsteht - etwa wenn ein
 * Nachfahren-Selektor mit hoeherer Spezifitaet Sekundaertext in einen
 * gefuellten Knopf hineinschreibt (gemessen: 1.13:1 im Light, 1.29:1 im Dark,
 * seit Runde 1 live).
 *
 * Gemessen wird der EFFEKTIVE Hintergrund: die Kette der Vorfahren wird
 * komponiert, bis eine deckende Flaeche erreicht ist. Alpha und `color-mix`
 * zaehlen dabei mit - `color-mix()` rendert als `color(srgb …)` und nicht als
 * `rgba()`, ein naiver Parser meldet hier Fehltreffer.
 *
 * Verlaeufe zaehlen als Kandidaten (siehe evaluateSample); bliebe die Sonde an
 * ihnen stehen, hoerte sie bei `.app-shell` auf zu messen - dreissig Elemente
 * je Route. Deaktivierte Bedienelemente sind ausgenommen, die nimmt WCAG 1.4.3
 * aus. Nur ein echtes Bild bleibt unrechenbar, und die Zahl steht im
 * Fehlertext, damit ein Anstieg auffaellt.
 * ──────────────────────────────────────────────────────────────────────────── */

async function collectTextSamples(page) {
  return page.evaluate(() => {
    const out = [];
    const selector = (el) => {
      const cls = [...el.classList].filter((c) => !c.startsWith('is-')).join('.');
      return `${el.tagName.toLowerCase()}${cls ? `.${cls}` : ''}`;
    };
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_ELEMENT);
    let el = walker.currentNode;
    while (el) {
      el = walker.nextNode();
      if (!el) break;
      if (el.closest('[aria-hidden="true"], .sr-only, yuvomi-install-prompt')) continue;
      if (el.matches(':disabled') || el.closest(':disabled, [aria-disabled="true"]')) continue;
      const text = [...el.childNodes]
        .filter((n) => n.nodeType === Node.TEXT_NODE)
        .map((n) => n.textContent.trim())
        .join(' ')
        .trim();
      if (!text) continue;
      const cs = getComputedStyle(el);
      if (cs.visibility === 'hidden' || cs.display === 'none' || parseFloat(cs.opacity) < 0.5) continue;
      const rect = el.getBoundingClientRect();
      if (rect.width < 2 || rect.height < 2) continue;

      // Die VOLLE Untergrund-Kette bis zum Wurzelelement einsammeln, roh. Wo
      // sie deckend wird und ob ein Verlauf dazwischenliegt, entscheidet Node -
      // so existiert der Farbparser genau einmal (im Harness) statt zweimal in
      // zwei Sprachen.
      //
      // BEKANNTE GRENZE, gemessen statt vermutet: die Kette ist der BAUM. Eine
      // Flaeche, die unter dem Text liegt, ohne ihn zu enthalten - die absolut
      // positionierte Pille der Tab-Bar gleitet als GESCHWISTER des aktiven
      // Eintrags -, faellt heraus. Gegen den gerenderten Pixel geprueft: die
      // Sonde meldet dort 4.20:1, das Bild zeigt 3.41:1. Sie findet den Fall
      // also, urteilt aber zu milde. Ein Versuch ueber `elementsFromPoint`
      // machte es SCHLECHTER statt besser (die Pille traegt
      // `pointer-events: none` und faellt aus dem Stapel, dafuer verschwand der
      // Befund ganz) - der ehrliche naechste Schritt waere der gerenderte
      // Pixel, nicht der Elementstapel.
      const layers = [];
      let node = el;
      while (node) {
        const ncs = getComputedStyle(node);
        layers.push({ bg: ncs.backgroundColor, image: ncs.backgroundImage });
        node = node.parentElement;
      }
      out.push({
        selector: selector(el),
        text: text.slice(0, 40),
        color: cs.color,
        size: parseFloat(cs.fontSize),
        weight: Number(cs.fontWeight) || 400,
        layers,
      });
    }
    return out;
  });
}

/**
 * Zerlegt einen `background-image`-Wert in seine Farbstops.
 * @returns {null|string[]} null, wenn ein echtes Bild im Spiel ist (dann ist
 *          der Untergrund nicht rechenbar), sonst die Stops eines Verlaufs.
 */
function gradientStops(image) {
  if (!image || image === 'none') return [];
  if (/url\(/i.test(image)) return null;
  return [...image.matchAll(/color\(srgb[^)]*\)|rgba?\([^)]*\)|#[0-9a-f]{3,8}/gi)].map((m) => m[0]);
}

/**
 * Komponiert den effektiven Untergrund eines Textelements und liefert den
 * SCHLECHTESTEN Kontrast, den er dort haben kann.
 *
 * WARUM EIN SCHLECHTESTER FALL UND KEIN EINZELWERT: `.app-shell` trägt
 * radiale Verläufe über dem Seitengrund. Eine Sonde, die bei einem Verlauf
 * aufgibt, hört genau dort auf zu messen, wo die meisten Texte stehen - rund
 * dreissig Elemente je Route, also die Hälfte des Dokuments. Deshalb werden
 * die Farbstops als Kandidaten behandelt: jeder wird auf den bisherigen
 * Untergrund komponiert, und es zählt der ungünstigste. Das ist eine
 * NÄHERUNG (die Stops werden auf das Endergebnis statt auf ihre eigene Ebene
 * gerechnet), aber eine konservative - sie kann strenger urteilen als die
 * Wirklichkeit, nie milder.
 *
 * @returns {null|{ratio: number, min: number, bg: number[], fg: number[]}}
 *          null nur noch bei einem echten Bild (`url(...)`).
 */
function evaluateSample(sample, pageBase) {
  // Erste deckende Ebene suchen; alles darunter ist wirkungslos.
  let opaqueAt = sample.layers.length - 1;
  for (let i = 0; i < sample.layers.length; i += 1) {
    if (parseColor(sample.layers[i].bg)[3] >= 1) {
      opaqueAt = i;
      break;
    }
  }
  let bg = pageBase;
  const candidates = [];
  for (let i = opaqueAt; i >= 0; i -= 1) {
    const layer = parseColor(sample.layers[i].bg);
    if (layer[3] > 0) bg = composite(layer, bg);
    const stops = gradientStops(sample.layers[i].image);
    if (stops === null) return null;
    candidates.push(...stops);
  }

  const fgRaw = parseColor(sample.color);
  const large = sample.size >= 24 || (sample.size >= 18.66 && sample.weight >= 700);
  const min = large ? 3 : 4.5;

  let worst = { ratio: Infinity, bg, fg: composite(fgRaw, bg) };
  for (const variant of [null, ...candidates]) {
    const under = variant === null ? bg : composite(parseColor(variant), bg);
    const fg = composite(fgRaw, under);
    const ratio = contrastRatio(fg, under);
    if (ratio < worst.ratio) worst = { ratio, bg: under, fg };
  }
  return { ...worst, min };
}

describe('Sonde 2 - jeder sichtbare Text haelt WCAG AA auf seinem KOMPONIERTEN Untergrund', () => {
  for (const theme of ['light', 'dark']) {
    for (const device of ['mobile', 'desktop']) {
      test(`${theme} / ${device}`, async () => {
        const page = await openPage(harness, { device, theme, locale: 'de' });
        const base = parseColor(
          await page.evaluate(() => getComputedStyle(document.documentElement).backgroundColor),
        );
        const pageBase = base[3] > 0 ? composite(base, [255, 255, 255]) : [255, 255, 255];
        const findings = [];
        let unpainted = 0;
        let measured = 0;
        for (const name of sweep('Sonde 2')) {
          await gotoRoute(page, ALL_ROUTES[name]);
          for (const sample of await collectTextSamples(page)) {
            const result = evaluateSample(sample, pageBase);
            if (!result) {
              unpainted += 1;
              continue;
            }
            // Der Zaehler steht an DERSELBEN Stelle, an der auch ein Finding
            // entstehen koennte - siehe der Nachweis unten.
            measured += 1;
            const { ratio, min, bg, fg } = result;
            if (ratio + 0.005 < min) {
              findings.push(
                `${name}/${theme}/${device}: ${ratio.toFixed(2)}:1 (soll ${min})  ` +
                  `${toHex(fg)} auf ${toHex(bg)}  ${sample.size}px/${sample.weight}  ` +
                  `${sample.selector}  "${sample.text}"`,
              );
            }
          }
        }
        await page.close();
        // EINE SONDE, DIE NICHTS GEMESSEN HAT, DARF NICHT URTEILEN. Sie war bis
        // 2026-08-09 die einzige der 14 ohne diesen Nachweis - ausgerechnet die,
        // die die ganze Guard-Ebene rechtfertigt. `unpainted` stand nur im
        // Meldungstext und zaehlte die NICHT rechenbaren Proben; liefert
        // `collectTextSamples()` auf jeder Route `[]` (umbenanntes
        // `#main-content`, `settle()`-Regress, abgelaufene Sitzung), sind beide
        // Zahlen null und alle vier Theme/Device-Tests gruen.
        assert.ok(
          measured >= 600,
          `Nur ${measured} Textproben im ganzen Dokument gerechnet - die Sonde hat nichts ` +
            'gemessen, statt nichts gefunden. Seiten nicht aufgebaut?',
        );
        assert.deepEqual(
          findings,
          [],
          `Textkontrast unter AA im gerenderten Dokument (${unpainted} Elemente standen ` +
            `hinter einem echten Bild und waren nicht rechenbar):\n  ${findings.join('\n  ')}`,
        );
      });
    }
  }
});

/* ────────────────────────────────────────────────────────────────────────────
 * Sonde 3: Buttonform im gerenderten Dokument
 *
 * Es gibt EINE Buttonform: die Kapsel. Das Stylesheet kann diese Regel nur zur
 * Haelfte pruefen - dort steht weder Tag noch Rolle, und ein Knopf kann seine
 * Form von einer Regel bekommen, deren Selektor ihn gar nicht nennt. Was das
 * Stylesheet scharf sieht (gleiche Breite und Hoehe = umgrenztes Ziel), prueft
 * `ein quadratischer Icon-Knopf ist ein Kreis` auf Ebene 3. Hier steht der Rest.
 *
 * Die vier Ausnahme-KATEGORIEN stehen im Sektionskommentar von tokens.css:
 * Zustandsschalter, Drop-Ziele, Rasterzellen und ZEILEN einer Zeilenliste.
 * Unten stehen ihre Vertreter - jeder mit seiner Kategorie. Das ist die
 * Umkehrung einer Allowlist: gemessen wird JEDER Knopf des Dokuments, benannt
 * sind nur die begruendeten Ausnahmen, und alles Neue faellt durch.
 *
 * FORMLOS zaehlt nicht als zweite Form: ein Knopf ohne Radius, ohne Flaeche und
 * ohne Kante ist eine Textaktion, kein Kasten.
 * ──────────────────────────────────────────────────────────────────────────── */

// Klassenname -> Kategorie. Der Eintrag ist nur gueltig, wenn seine Kategorie
// eine der vier ist; wer eine fuenfte braucht, aendert erst tokens.css.
const SHAPE_EXEMPT = new Map([
  // 1. Zustandsschalter
  ['item-check', 'Zustandsschalter: Checkbox der Einkaufsliste'],
  ['group-toggle__btn', 'Zustandsschalter: Segment der Aufgaben-Gruppierung'],
  ['cal-toolbar__view-btn', 'Zustandsschalter: Segment der Kalender-Ansicht'],
  ['ydp__trigger', 'Griff: Feld-Oeffner des Datepickers, traegt Feldkante'],
  ['more-sheet__search', 'Griff: Suchfeld des More-Sheets, traegt Feldkante'],
  ['theme-toggle__btn', 'Zustandsschalter: Segment der Farbwelt-Wahl'],
  // 3. Zellen eines Rasters
  ['month-day', 'Rasterzelle: Tag im Kalender-Monat'],
  ['more-action', 'Rasterzelle: Kachel im More-Sheet-Raster'],
  ['metric-card--select', 'Rasterzelle: waehlbare Kennzahlkachel (.metric-card, Block-2-Konsolidierung)'],
  // 4. Zeilen einer Zeilenliste
  ['nav-item', 'Zeile: Eintrag der Sidebar-Navigation'],
  ['settings-shell__navigation-toggle', 'Zeile: Domaenenkopf der Settings-Navigation (Akkordeon)'],
  ['note-item', 'Zeile: Notiz im Dashboard-Widget'],
  ['rewards-widget-row', 'Zeile: Rang im Belohnungs-Widget'],
  ['rw-standing__id', 'Zeile: Oeffner einer Mitglieds-Zeile'],
  ['documents-folder-item__select', 'Zeile: Ordner in der Dokumentenliste'],
  // Der Chip traegt seit 031597b1 (Juli 2026) role="button" und dieselbe flache
  // Bar wie .month-day__event, dessen Zelle sein Traeger ist (calendar.css:
  // "FLACHE BAR, WIE .month-day__event"). Ein Ereignisbalken ist kein Knopf und
  // wird nicht gemessen; die Aufgabe daneben ist einer - eine Kapsel neben
  // einer Bar waeren zwei Formen in EINER Zeilenliste. Gefunden vom Handlauf
  // des Releases v2.65.0, dem ersten vollen Lauf seit dem Eintrag.
  ['cal-task-chip', 'Zeile: Aufgabe in der Eintragsliste einer Kalenderzelle, gleiche Bar wie .month-day__event'],
]);

test('Sonde 3 - es gibt EINE Buttonform, und die Ausnahmen sind Kategorien', async () => {
  const page = await openPage(harness, { device: 'desktop', theme: 'light', locale: 'de' });
  const found = new Map();
  const seen = new Set();

  for (const name of sweep('Sonde 3')) {
    await gotoRoute(page, ALL_ROUTES[name]);
    const rows = await page.evaluate(() => {
      const out = [];
      for (const el of document.querySelectorAll('button, a.btn, [role="button"]')) {
        const rect = el.getBoundingClientRect();
        if (!rect.width || !rect.height) continue;
        const style = getComputedStyle(el);
        const radius = parseFloat(style.borderTopLeftRadius);
        // Kapsel = Radius >= halbe Hoehe. So rendert --radius-full, und bei
        // gleicher Breite und Hoehe ist das genau der Kreis.
        const pill = radius >= rect.height / 2 - 1;
        // Formlos: kein Radius, keine Flaeche, kein KASTEN -> Textaktion oder
        // Zeile, keine zweite Buttonform.
        //
        // Eine Kante zaehlt nur RINGSUM als Kasten. Das Messwerkzeug fragte
        // `borderTopWidth` allein und stufte damit jede Zeile einer
        // Zeilenliste als Kasten ein - deren `X + X { border-top }` ist die
        // vorgeschriebene Trennung, also gerade das Merkmal einer ZEILE
        // (`.budget-entry` war der Fall, der es zeigte).
        const boxed = ['Top', 'Right', 'Bottom', 'Left']
          .every((side) => parseFloat(style[`border${side}Width`]) > 0);
        const flat = radius === 0
          && style.backgroundColor === 'rgba(0, 0, 0, 0)'
          && !boxed;
        // ALLE Knoepfe werden gemeldet, mit ihrem Urteil - sonst kann die
        // Pruefung unten nicht zwischen „Ausnahme entfaellt" und „Knopf haelt
        // die Regel jetzt" unterscheiden.
        const shaped = !pill && !flat;
        const key = [...el.classList].filter((cls) => !cls.startsWith('is-')).join('.')
          || `(klassenlos:${el.id || el.tagName})`;
        out.push({ key, radius, height: Math.round(rect.height), shaped });
      }
      return out;
    });
    for (const row of rows) {
      row.key.split('.').forEach((cls) => seen.add(cls));
      if (!row.shaped) continue;
      if (!found.has(row.key)) found.set(row.key, { ...row, pages: new Set() });
      found.get(row.key).pages.add(name);
    }
  }
  await page.close();

  // Eine Sonde, die nichts gemessen hat, darf nicht urteilen. Ohne diese
  // Zusicherung ist ein leeres Dokument (abgelaufene Sitzung, nicht
  // aufgebaute Route) von „alles in Ordnung" nicht zu unterscheiden - und die
  // Stale-Pruefung unten meldet dann ihre gesamte Liste als verschwunden.
  assert.ok(seen.size >= 20,
    `Nur ${seen.size} Knopf-Klassen im ganzen Dokument gesehen - die Sonde hat `
    + 'nichts gemessen, statt nichts gefunden. Seiten nicht aufgebaut?');

  const offenders = [];
  for (const [key, value] of found) {
    const classes = key.split('.');
    if (classes.some((cls) => SHAPE_EXEMPT.has(cls))) continue;
    offenders.push(
      `${key} (${value.radius}px auf h=${value.height}) auf ${[...value.pages].join(', ')}`,
    );
  }

  assert.deepEqual(offenders.sort(), [],
    'Knoepfe mit eigener Form ausserhalb der vier Ausnahme-Kategorien. Entweder '
    + 'die Kapsel tragen oder in SHAPE_EXEMPT stehen - mit der Kategorie, nicht '
    + 'mit dem Grund „gewachsen".');
});

/* ────────────────────────────────────────────────────────────────────────────
 * Sonde 4: Zielgroessen
 *
 * Die Regel steht im Sektionskommentar von tokens.css („Die Zielgroessen-
 * Regel"): eine REIHE traegt ihre Dichte gemeinsam, ein EINZELZIEL muss allein
 * treffbar sein.
 *
 *   freistehend  -> volle Zielgroesse in mindestens einer Achse, die andere
 *                   erfuellt WCAG 2.5.8
 *   in der Reihe -> allein WCAG 2.5.8 (24x24 oder Spacing-Ausnahme)
 *
 * WARUM DIESE EBENE UND KEINE ANDERE. Im Stylesheet steht weder, wer neben wem
 * liegt, noch was ein Pseudo-Element zur Flaeche beitraegt - beides entscheidet
 * hier ueber Verstoss oder nicht. Die zwei bisherigen Guards
 * (test-frontend-audit.js) pruefen benannte Selektoren und finden damit nur,
 * wer die Regel schon anerkennt; das ist die Allowlist-Signatur, die diese
 * Runde abschafft.
 *
 * DREI FALLEN, DIE BEIM BAU GEMESSEN WURDEN:
 *
 *   (1) DIE BOX IST NICHT DIE TREFFERFLAECHE. `.weather-widget__refresh` ist
 *       34x34 gross und dehnt sich per ::before auf --target-base aus. Eine
 *       Box-Messung meldet ihn als Verstoss, obwohl der Finger 44px findet -
 *       und haette damit ausgerechnet das Rezept fuer „kompakt aussehen, voll
 *       treffen" zum Fehler erklaert. Getastet wird deshalb mit
 *       elementFromPoint vom Zentrum nach aussen.
 *   (2) DAS TASTEN ENDET AN JEDER KANTE, AUCH AN DER FALSCHEN. Am unteren
 *       Viewport-Rand und an der Clip-Kante eines `overflow: hidden`-Moduls
 *       (Kueche, Budget) liefert elementFromPoint den Shell-Container - vier
 *       Ziele sahen dadurch aus, als waeren sie zu einem Drittel verdeckt.
 *       Deshalb gilt `max(Box, getastet)`: die Box ist die Untergrenze, das
 *       Tasten zaehlt nur, was sie ERWEITERT.
 *   (3) DIE ANZAHL IST NICHT DIE EINENGUNG. „Wie oft kommt die Klasse vor"
 *       misst den Seed: bei einer einzigen Aufgabe waere .task-card__title ein
 *       Einzelziel, bei zweien eine Reihe. Die Einengung steht im Layout.
 * ──────────────────────────────────────────────────────────────────────────── */

/**
 * Klassenname -> Begruendung. Die UMKEHRUNG einer Allowlist: gemessen wird
 * jedes Ziel des Dokuments, benannt sind nur die begruendeten Ausnahmen.
 *
 * Sie ist leer, und das ist das Ergebnis von Phase 3c: die Spacing-Ausnahme des
 * Standards deckt jeden bewusst dichten Fall mechanisch ab - Monatsraster-Chips
 * (Zentrumsabstand 31,5), Aufgaben-Tagfilter (29,3), Sidebar-Umschalter (31,5).
 * Wer hier etwas eintraegt, hat in Wahrheit ein Abstandsproblem.
 */
const TARGET_EXEMPT = new Map([]);

/** Ein Ziel gilt als eingeengt, wenn ein gleichartiges naeher steht als das. */
const CROWDING_GAP = 16;

/**
 * Der Schluessel eines Bauteils OHNE seine Varianten.
 *
 * `key` ist die volle Klassenliste, und damit ist
 * `cal-task-chip.cal-task-chip--high` ein anderes Bauteil als `--medium`. Ein
 * Bauteil, das in fuenf von sechs Varianten in einer Reihe steht, ist es auch
 * in der sechsten - die Variante faerbt, sie baut nicht um. Geschnitten wird
 * deshalb am BEM-Modifier, nicht an jedem Token: `btn--ghost` faellt auf `btn`
 * zurueck, `btn` selbst bleibt `btn`, und eine Liste aus mehreren Klassen
 * behaelt ihre erste als Traeger.
 */
function baseKey(key) {
  return String(key).split('.')[0].split('--')[0];
}

async function measureTargets(page, min) {
  return page.evaluate(({ min, gap }) => {
    const SEL = 'button, a[href], [role="button"], input:not([type=hidden]), select, textarea, summary, [tabindex]:not([tabindex="-1"])';
    const key = (el) => [...el.classList].filter((c) => !c.startsWith('is-')).join('.')
      || `(${el.tagName.toLowerCase()}${el.id ? `#${el.id}` : ''})`;

    const els = [];
    for (const el of document.querySelectorAll(SEL)) {
      const cs = getComputedStyle(el);
      if (cs.display === 'none' || cs.visibility === 'hidden' || cs.pointerEvents === 'none') continue;
      if (el.closest('.sr-only, [aria-hidden="true"], yuvomi-install-prompt')) continue;
      const r = el.getBoundingClientRect();
      if (r.width < 1 || r.height < 1) continue;
      els.push(el);
    }
    const rects = els.map((el) => el.getBoundingClientRect());
    const classes = els.map((el) => new Set([...el.classList].filter((c) => !c.startsWith('is-'))));

    const out = [];
    els.forEach((el, i) => {
      const r = rects[i];
      const cx = Math.round(r.left + r.width / 2);
      const cy = Math.round(r.top + r.height / 2);
      // Ein Ziel, dessen eigenes Zentrum es nicht selbst trifft, ist verdeckt
      // oder ausserhalb des Viewports - dort misst die Sonde nichts, statt
      // etwas Falsches zu messen.
      const mine = (x, y) => {
        const hit = document.elementFromPoint(x, y);
        return !!hit && (hit === el || el.contains(hit));
      };
      if (!mine(cx, cy)) return;
      const reach = (dx, dy) => {
        let n = 0;
        while (n < min && mine(cx + dx * (n + 1), cy + dy * (n + 1))) n += 1;
        return n;
      };
      // max(Box, getastet): die Box ist die Untergrenze (Falle 2), das Tasten
      // zaehlt nur, was ein Pseudo-Element hinzufuegt (Falle 1).
      let w = Math.max(r.width, reach(-1, 0) + reach(1, 0) + 1);
      let h = Math.max(r.height, reach(0, -1) + reach(0, 1) + 1);

      // FALLE 4, gemessen an den Settings-Blaettern: EIN BEDIENELEMENT IN
      // EINEM LABEL IST SO GROSS WIE SEIN LABEL. `toggleRowHtml`
      // (settings/components.js) baut `<label class="toggle-row"><input
      // type="checkbox" 18x18>…<span>Text</span></label>`; die Zeile traegt
      // `min-height: var(--target-lg)` und volle Breite, und ein Klick
      // irgendwo darauf schaltet. Die Sonde mass den INPUT und meldete
      // 18x19 - dreissigmal, quer ueber die Blaetter, und jedes Mal falsch.
      //
      // Das Tasten allein rettet sie nicht: `elementFromPoint` liefert
      // ausserhalb des Inputs das LABEL, nicht den Input, also endet `reach`
      // an der Kante der Checkbox. Was hier fehlt, ist keine Geometrie,
      // sondern eine HTML-Beziehung - und die ist eine Regel, keine
      // Ausnahmeliste: `label.control` bzw. `label[for]` sagt verbindlich,
      // welches Element das Label bedient.
      const label = el.closest('label') ?? (el.id ? document.querySelector(`label[for="${CSS.escape(el.id)}"]`) : null);
      if (label && (label.control === el || label.contains(el))) {
        const lr = label.getBoundingClientRect();
        if (lr.width > 0 && lr.height > 0) {
          w = Math.max(w, lr.width);
          h = Math.max(h, lr.height);
        }
      }

      // Eingeengt: ein Ziel, das mindestens eine Klasse teilt, steht naeher als
      // CROWDING_GAP. Nur DAS ist der Grund, aus dem ein Ziel dicht sein darf -
      // es kann nicht wachsen, ohne seinen Nachbarn zu verdraengen.
      let crowded = false;
      // Fuer die Spacing-Ausnahme (WCAG 2.5.8): naechstes Zielzentrum.
      let nearestCenter = Infinity;
      for (let j = 0; j < els.length && !(crowded && nearestCenter < 24); j += 1) {
        if (j === i || els[j].contains(el) || el.contains(els[j])) continue;
        const o = rects[j];
        const dEdge = Math.hypot(
          Math.max(o.left - r.right, r.left - o.right, 0),
          Math.max(o.top - r.bottom, r.top - o.bottom, 0),
        );
        if (dEdge < gap && [...classes[i]].some((c) => classes[j].has(c))) crowded = true;
        const dCenter = Math.hypot(
          o.left + o.width / 2 - cx,
          o.top + o.height / 2 - cy,
        );
        if (dCenter < nearestCenter) nearestCenter = dCenter;
      }

      // WER DIE SPACING-AUSNAHME NIMMT, MUSS SIE BRAUCHEN.
      //
      // WCAG 2.5.8 laesst ein Ziel unter 24x24 durch, wenn kein anderes
      // Zielzentrum naeher als 24px steht. Diese Ausnahme ist fuer Ziele
      // gedacht, die dicht stehen MUESSEN - sie koennen nicht wachsen, ohne
      // ihren Nachbarn zu verdraengen. Genau das ist auch die Begruendung der
      // Zielgroessen-Regel („Das Kriterium ist die Einengung, nicht die
      // Anzahl").
      //
      // `.task-card__title` nahm die Ausnahme in Anspruch, ohne sie zu
      // brauchen: 22,1px hoch, mit 12px leerem Karten-Padding darueber und
      // 4px darunter. Kurz aus Versehen, nicht aus Platznot - und die Sonde
      // sagte gruen, weil das naechste Zielzentrum weit genug weg lag. Die
      // Critique 2026-08-10 mass denselben Fall gegen einen pauschalen
      // 44px-Massstab und hatte damit recht aus dem falschen Grund.
      //
      // Gemessen wird der Raum, den der TRAEGER laesst: bis zur Innenkante
      // des Elternteils oder bis zur naechsten Geschwisterkante, je nachdem
      // was naeher liegt. Wer damit ueber 24 kaeme, hat kein Platzproblem.
      //
      // NUR FUER FREISTEHENDE, und diese Grenze ist gemessen, nicht gesetzt:
      // die erste Fassung meldete prompt die Aufgaben-Tagfilter und zwoelf
      // `.cal-task-chip`. Formal zu Recht - sie stehen NEBENeinander, koennten
      // also vertikal wachsen, ohne einander zu verdraengen. Nur ist das nicht
      // mehr die Regel, sondern eine neue: ein Reihen-Bauteil traegt seine
      // Dichte gemeinsam, und ob die Einengung horizontal oder vertikal wirkt,
      // hat die Zielgroessen-Regel nie unterschieden. Wer sie unterscheiden
      // will, aendert die Regel und misst die Reihen neu - er tut es nicht
      // nebenbei in einer Klausel, die einen freistehenden Titel meinte.
      //
      // DIE AUSNAHME STEHT DESHALB IM URTEIL, NICHT HIER. `crowded` an dieser
      // Stelle waere die INSTANZ-Frage, und die ist die falsche: ein Tagfilter
      // an einer Aufgabe mit nur einem Tag steht allein da und bleibt ein
      // Reihen-Bauteil (siehe `rowBuilt` unten). Genau daran ist der zweite
      // Versuch gescheitert - er band die Klausel an `crowded`, und die vier
      // einzeln haengenden Tagfilter blieben trotzdem gemeldet.
      //
      // DIE INLINE-AUSNAHME IST TEIL DES STANDARDS, nicht eine Milderung:
      // WCAG 2.5.8 nimmt ein Ziel ausdruecklich aus, dessen Groesse „durch die
      // Zeilenhoehe des Nicht-Ziel-Textes bestimmt" ist - ein Link in einem
      // Satz. Ohne sie meldete die Klausel drei Hinweis-Links in
      // `<p class="form-hint">` (18px hoch, weil eine Textzeile 18px hoch
      // ist), und der einzige Weg, sie „zu reparieren", waere gewesen, den
      // Fliesstext um sie herum auseinanderzuziehen.
      const inline = /^inline($|-)/.test(getComputedStyle(el).display)
        && !!el.parentElement
        && el.parentElement.textContent.trim() !== el.textContent.trim();

      let roomy = false;
      if (h < 24 && !inline && el.parentElement) {
        const pr = el.parentElement.getBoundingClientRect();
        const sibs = [...el.parentElement.children]
          .filter((c) => c !== el)
          .map((c) => c.getBoundingClientRect())
          .filter((s) => s.height > 0);
        const above = Math.min(
          r.top - pr.top,
          ...sibs.filter((s) => s.bottom <= r.top + 1).map((s) => r.top - s.bottom),
        );
        const below = Math.min(
          pr.bottom - r.bottom,
          ...sibs.filter((s) => s.top >= r.bottom - 1).map((s) => s.top - r.bottom),
        );
        roomy = h + Math.max(0, above) + Math.max(0, below) >= 24;
      }


      // WCAG 2.5.8: 24x24, oder kein anderes Zielzentrum naeher als 24 - und
      // die Ausnahme nur fuer den, der sie braucht.
      const wcag = (w >= 24 && h >= 24) || nearestCenter >= 24;
      // Volle Zielgroesse in mindestens einer Achse - nur fuer freistehende.
      const full = w >= min || h >= min;
      // Das Urteil faellt NICHT hier: ob ein Bauteil in Reihen gebaut wird,
      // entscheidet sich ueber alle Routen zusammen (siehe unten).
      out.push({
        key: key(el),
        w: Math.round(w),
        h: Math.round(h),
        crowded,
        wcag,
        roomy,
        full,
        center: Math.round(nearestCenter),
      });
    });
    return out;
  }, { min, gap: CROWDING_GAP });
}

/**
 * Misst die Route an jeder Scrollposition und liefert die Messungen einzeln.
 *
 * Die App hat ZWEI Scrollport-Architekturen (Handoff §6): meist scrollt die
 * Seite, in Kueche und Budget ist der Modul-Root `overflow: hidden` und ein
 * Container darin scrollt. Gesucht wird deshalb der Container mit dem groessten
 * Ueberhang, nicht ein fester Knoten.
 */
async function measureScrolled(page, min, maxSteps = 6) {
  const pick = () => {
    const el = document.scrollingElement;
    let best = el;
    let bestOver = el.scrollHeight - el.clientHeight;
    for (const node of document.querySelectorAll('*')) {
      const cs = getComputedStyle(node);
      if (!/auto|scroll/.test(cs.overflowY)) continue;
      const over = node.scrollHeight - node.clientHeight;
      if (over > bestOver) { best = node; bestOver = over; }
    }
    return best;
  };
  const out = [];
  await page.evaluate(pick).catch(() => {});
  for (let step = 0; step < maxSteps; step += 1) {
    out.push(await measureTargets(page, min));
    const moved = await page.evaluate((pickSrc) => {
      // eslint-disable-next-line no-new-func
      const el = new Function(`return (${pickSrc})()`)();
      const before = el.scrollTop;
      // 70 % statt 100 %: was genau auf der Falz sitzt, wuerde sonst in keiner
      // der beiden Messungen vollstaendig im Bild stehen.
      el.scrollTop = before + el.clientHeight * 0.7;
      return el.scrollTop > before + 1;
    }, pick.toString());
    if (!moved) break;
    // Der kollabierende Kopf und die Sticky-Leisten brauchen einen Frame, sonst
    // misst die Sonde eine Zwischenposition.
    await new Promise((r) => { setTimeout(r, 250); });
  }
  return out;
}

describe('Sonde 4 - eine Reihe traegt ihre Dichte, ein Einzelziel ist allein treffbar', () => {
  // Beide Geraetewelten, denn --target-base schaltet ueber (hover: none): am
  // Zeiger 44px, am Finger 48px. Ein Guard, der nur eine Welt misst, prueft
  // genau die Haelfte einer Regel, deren Kern der Wechsel ist.
  for (const [device, min] of [['mobile', 48], ['desktop', 40]]) {
    test(`${device} (Minimum ${min}px)`, async () => {
      const page = await openPage(harness, { device, theme: 'light', locale: 'de' });
      const found = new Map();
      // DIE SONDE MUSS SCROLLEN. elementFromPoint kennt nur den Viewport - ein
      // Ziel unterhalb der Falz meldet sein eigenes Zentrum als verdeckt und
      // wird stillschweigend uebersprungen. Die Gegenprobe hat das aufgedeckt:
      // .ydp__trigger auf 40x40 zurueckgedreht liess den Guard GRUEN, weil er
      // auf /health unter der Falz liegt. Gemessen wird deshalb an jeder
      // Scrollposition, so wie ein Nutzer die Seite durchgeht.
      // Bauteile, die IRGENDWO in einer Reihe stehen. Siehe die Auswertung
      // darunter - erst mit dieser Menge ist das Urteil vollstaendig.
      const rowBuilt = new Set();
      let seen = 0;
      for (const name of sweep('Sonde 4')) {
        await gotoRoute(page, ALL_ROUTES[name]);
        for (const rows of await measureScrolled(page, min)) {
          for (const row of rows) {
            // DER ZAEHLER STEHT IN DER MESSUNG, NICHT DAVOR. Bis 2026-08-09
            // zaehlte er `querySelectorAll(...).length` - rohe DOM-Knoten, in
            // den Tausenden. `measureTargets()` steigt aber pro Element bei
            // `if (!mine(cx, cy)) return;` aus: bricht `elementFromPoint`, ist
            // `offenders` leer und der alte Nachweis hielt trotzdem muehelos.
            // Eine Zeile weiter oben zu zaehlen war der ganze Unterschied
            // zwischen „nichts gefunden" und „nichts gemessen".
            seen += 1;
            // NICHT NUR DIE VOLLE KLASSENLISTE, AUCH JEDE EINZELKLASSE.
            // `key` ist die ganze Liste, und damit ist
            // `cal-task-chip.cal-task-chip--high` ein anderes Bauteil als
            // `cal-task-chip.cal-task-chip--medium`: der Modifier macht aus
            // EINEM Bauteil sechs, und wer nur in fuenf Varianten in einer
            // Reihe vorkommt, gilt in der sechsten als freistehend. Genau so
            // blieben drei `--high`-Chips gemeldet, waehrend `--medium` und
            // `--urgent` als Reihe erkannt wurden. Dieselbe Blindheit wie bei
            // Sonde 6, die nach `.metric-grid` fragte und die Reihe nicht sah.
            //
            // GENAU DIE BASISKLASSE, NICHT JEDER TOKEN. Die erste Fassung warf
            // JEDE Klasse des Schluessels in `rowBuilt` und hat damit die
            // freistehende Haelfte der Sonde app-weit abgeschaltet: zwei
            // benachbarte `.btn` (die Modal-Aktionen stehen mit --space-2
            // Abstand, also unter CROWDING_GAP) legen den blanken Token `btn`
            // hinein, und von da an ist jedes Element mit `btn` als „in einer
            // Reihe" entschuldigt. Ein Guard, der sich selbst eine Ausnahme
            // baut, ist keiner.
            if (row.crowded) {
              rowBuilt.add(row.key);
              rowBuilt.add(baseKey(row.key));
            }
            if (row.wcag && row.full && !row.roomy) continue;
            const id = `${row.key}|${row.w}x${row.h}`;
            if (!found.has(id)) found.set(id, { ...row, pages: new Set() });
            found.get(id).pages.add(name);
          }
        }
      }
      await page.close();

      // Eine Sonde, die nichts gemessen hat, darf nicht urteilen (dieselbe
      // Zusicherung wie bei Sonde 3). Gezaehlt sind GETASTETE Ziele, also
      // Messungen - dasselbe wie bei Sonde 14, wo der Zaehler ebenfalls in der
      // Schleife steht, aus der die Findings kommen.
      assert.ok(seen >= 600,
        `Nur ${seen} Ziele im ganzen Dokument getastet - die Sonde hat nichts `
        + 'gemessen, statt nichts gefunden. Bricht elementFromPoint?');

      // DIE EINENGUNG IST EINE EIGENSCHAFT DES BAUTEILS, NICHT DER INSTANZ.
      // Die erste Fassung urteilte je Instanz und meldete prompt einen
      // .task-tag--filter, der als einziger Tag an seiner Aufgabe hing: ein
      // Reihen-Bauteil, das in dieser einen Zeile allein stand. Ob ein Bauteil
      // in Reihen gebaut wird, steht nicht in einer Zeile, sondern im Bauteil -
      // und ueber sechzehn Routen gemessen ist das eine stabile Aussage, waehrend
      // die einzelne Instanz den Seed misst.
      const offenders = [];
      for (const value of found.values()) {
        if (value.key.split('.').some((cls) => TARGET_EXEMPT.has(cls))) continue;
        const inRow = rowBuilt.has(value.key) || rowBuilt.has(baseKey(value.key));
        if (value.wcag && inRow) continue;
        offenders.push(
          `${value.key}: ${value.w}x${value.h} - `
          + `${value.roomy ? 'nimmt die Spacing-Ausnahme, obwohl sein Traeger Platz laesst'
            : !value.wcag ? 'unter 24x24 ohne Spacing-Abstand' : 'freistehend und in KEINER Achse voll'}`
          + ` (naechstes Zielzentrum ${value.center}px) auf ${[...value.pages].join(', ')}`,
        );
      }

      assert.deepEqual(offenders.sort(), [],
        `Ziele unter der Zielgroesse bei ${device}. Die Regel steht in tokens.css `
        + '(„Die Zielgroessen-Regel"): ein freistehendes Ziel haelt die volle '
        + 'Zielgroesse in mindestens einer Achse, ein eingeengtes erfuellt WCAG '
        + '2.5.8. Wer kompakt aussehen und voll treffen will, dehnt seine Flaeche '
        + 'per ::before aus - .weather-widget__refresh ist der Musterfall.');
    });
  }
});

test('Sonde 3+4 - keine Form- und keine Zielgroessen-Ausnahme ueberlebt ihre Klasse', () => {
  // EINE Pruefung fuer beide Listen, und zwar aus einem Grund, der ueber
  // Sparsamkeit hinausgeht: `TARGET_EXEMPT` ist heute leer (Phase 3c), und eine
  // eigene Assertion darueber ist tautologisch - sie kann nicht rot werden und
  // zaehlte trotzdem als eine der gemeldeten Zusicherungen dieser Suite. Zusammen
  // mit `SHAPE_EXEMPT` und dem Reichweiten-Nachweis unten prueft sie etwas.
  //
  // Gemessen wird gegen das STYLESHEET, nicht gegen das Dokument: ein Element,
  // das nur unter bestimmten Daten erscheint, waere sonst je nach Seed
  // „verschwunden" - die Pruefung urteilte dann ueber Timing statt ueber
  // Ehrlichkeit. Der Klassenname im Selektor ist die stabile Quelle.
  const classes = selectorClasses();

  // Eine Pruefung, die nichts gelesen hat, darf nicht urteilen: liefert der
  // Scanner nichts, waere JEDE Ausnahme „veraltet" - und die Assertion meldete
  // ihre gesamte Liste statt ihres Defekts.
  assert.ok(classes.size >= 500,
    `Nur ${classes.size} Klassennamen aus den Stylesheets gelesen - der Regelscanner `
    + 'hat nichts gefunden, statt nichts zu finden.');

  const stale = [];
  for (const [label, list] of [['SHAPE_EXEMPT', SHAPE_EXEMPT], ['TARGET_EXEMPT', TARGET_EXEMPT]]) {
    for (const cls of list.keys()) if (!classes.has(cls)) stale.push(`${label}: .${cls}`);
  }
  assert.deepEqual(stale, [],
    'Eine Ausnahme fuer einen Knopf, den es nicht mehr gibt, ist eine Allowlist, die '
    + 'niemand mehr liest. Diese Klassen nennt kein Selektor mehr.');
});

/* ────────────────────────────────────────────────────────────────────────────
 * Sonde 5: Wischsemantik
 *
 * Die Wischbedienung ist die einzige Bedienung der App, die im Stylesheet und
 * im Quelltext vollstaendig richtig aussehen und im Dokument trotzdem gar nicht
 * stattfinden kann. Genau das war der Fall: der Einkauf verdrahtete seine
 * Gesten nur in `updateItemsList`, also erst, wenn die Liste ein zweites Mal
 * gebaut wurde - beim ersten Oeffnen der Seite antwortete keine Zeile. Der
 * Aufruf stand seit dem Tag falsch, an dem die Geste eingefuehrt wurde.
 *
 * Deshalb faehrt diese Sonde die Geste wirklich, statt eine Zuordnung zu lesen.
 * Sie misst dabei ZWEI Zusagen auf einmal:
 *
 *   (a) eine Liste mit Wischzeilen antwortet auf die Geste, und zwar beim
 *       ersten Aufbau der Seite;
 *   (b) die Rolle liegt an der vereinbarten Kante - das Zeilenende traegt das
 *       Destruktive, der Zeilenanfang das Primaere und Positive (§2).
 *
 * Und sie faehrt beides in `de` UND `ar`: die Kante ist logisch, die
 * Fingerbewegung dahin ist in RTL die andere. Eine Sonde, die nur LTR misst,
 * wuerde die Spiegelung nie bemerken.
 *
 * SIE LOEST NICHTS AUS: der Finger geht vor dem Loslassen unter die Schwelle
 * zurueck. Eine Sonde, die abhakt und loescht, misst beim zweiten Lauf einen
 * anderen Seed.
 * ──────────────────────────────────────────────────────────────────────────── */

// Die Rollen benennen ihre Bedeutung selbst (layout.css, „ZWEI ACHSEN"). Das
// ist keine Allowlist ueber Dateien, sondern die Regel in Code: `--edit` fehlt
// hier bewusst, weil sein RANG von der Liste abhaengt - primaer, wo es die
// einzige nicht-destruktive Aktion ist, sekundaer neben einer positiven.
const ROLE_SIDE = { 'swipe-reveal--delete': 'trailing', 'swipe-reveal--done': 'leading' };

async function uncoveredPanel(page, sign) {
  // ERST IN DEN VIEWPORT HOLEN. `page.touchscreen` setzt Viewport-Koordinaten;
  // eine Zeile unter der Falz bekaeme einen Finger, der ausserhalb des Bildes
  // aufsetzt, und die Sonde meldete „nicht verdrahtet", wo in Wahrheit nur
  // niemand hingefasst hat. Auf den Hauptrouten steht die erste Wischzeile weit
  // oben, im Abo-Tab liegt sie hinter Kennzahlen und Auswertung.
  //
  // Gemessen wird NACH dem Warten: der kollabierende Kopf verschiebt beim
  // Scrollen alles unter sich, und ein Rechteck von vorher zeigt daneben.
  const scrolled = await page.evaluate(() => {
    const row = document.querySelector('.swipe-row');
    if (!row) return false;
    row.scrollIntoView({ block: 'center' });
    return true;
  });
  if (!scrolled) return null;
  await new Promise((resolve) => setTimeout(resolve, 250));

  const box = await page.evaluate(() => {
    const row = document.querySelector('.swipe-row');
    if (!row) return null;
    const r = row.getBoundingClientRect();
    return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
  });
  if (!box) return null;

  await page.touchscreen.touchStart(box.x, box.y);
  for (const step of [20, 60, 120]) {
    await page.touchscreen.touchMove(box.x + sign * step, box.y);
    await new Promise((resolve) => setTimeout(resolve, 30));
  }
  const shown = await page.evaluate(() => [...document.querySelectorAll('.swipe-row:first-of-type .swipe-reveal')]
    .filter((el) => Number(el.style.opacity) > 0.5)
    .map((el) => [...el.classList].filter((c) => c !== 'swipe-reveal')));
  // Zurueck unter die Schwelle, damit das Loslassen keine Aktion ausloest.
  await page.touchscreen.touchMove(box.x, box.y);
  await page.touchscreen.touchEnd();
  await new Promise((resolve) => setTimeout(resolve, 250));
  return shown[0] ?? [];
}

describe('Sonde 5 - eine Wischzeile antwortet, und jede Rolle liegt an ihrer Kante', () => {
  for (const locale of ['de', 'ar']) {
    test(`Locale ${locale}`, async () => {
      const page = await openPage(harness, { device: 'mobile', theme: 'light', locale });
      const rtl = locale === 'ar';
      const findings = [];
      let listsSeen = 0;

      const measure = async (name) => {
        const hasRows = await page.evaluate(() => Boolean(document.querySelector('.swipe-row .swipe-reveal')));
        if (!hasRows) return;
        listsSeen += 1;

        // In RTL deckt derselbe Finger die andere Kante auf - die Erwartung
        // spiegelt mit, die Kante bleibt dieselbe.
        for (const [sign, side] of [[1, rtl ? 'trailing' : 'leading'], [-1, rtl ? 'leading' : 'trailing']]) {
          const classes = await uncoveredPanel(page, sign);
          const move = sign > 0 ? 'nach rechts' : 'nach links';

          if (!classes?.length) {
            findings.push(`${name}: der Wisch ${move} deckt nichts auf - die Zeilen sind nicht verdrahtet.`);
            continue;
          }
          if (!classes.includes(`swipe-reveal--${side}`)) {
            findings.push(`${name}: der Wisch ${move} deckt ${classes.join('.')} auf, erwartet war die ${side}-Kante.`);
            continue;
          }
          for (const cls of classes) {
            if (ROLE_SIDE[cls] && ROLE_SIDE[cls] !== side) {
              findings.push(`${name}: die Rolle ${cls} liegt an der ${side}-Kante, app-weit gehoert sie an die ${ROLE_SIDE[cls]}-Kante.`);
            }
          }
        }
      };

      for (const name of sweep('Sonde 5')) {
        await gotoRoute(page, ALL_ROUTES[name]);
        // Auch die Sichten hinter den Leisten: die Abo-Liste liegt hinter einem
        // Untertab und waere sonst die einzige Wischliste der App, die nie
        // gefahren wird.
        await visitViews(page, name, measure);
      }
      await page.close();

      // Eine Sonde, die nichts gemessen hat, darf nicht urteilen (dieselbe
      // Zusicherung wie bei Sonde 3 und 4).
      assert.ok(listsSeen >= 4,
        `Nur ${listsSeen} Wischlisten gesehen - erwartet sind mindestens Aufgaben, Einkauf, Geburtstage `
        + 'und Abonnements. Entweder hat der Seed keine Zeilen geliefert, oder die Bauart hat sich geaendert.');

      assert.deepEqual(findings, [],
        'Wischsemantik im gerenderten Dokument. Die Regel lautet: rechts (zum Zeilenanfang hin) '
        + 'traegt die primaere positive Aktion, links das Destruktive oder Sekundaere - und in RTL '
        + 'spiegelt die Fingerbewegung, nicht die Kante.\n  ' + findings.join('\n  '));
    });
  }
});

/* ────────────────────────────────────────────────────────────────────────────
 * Sonde 6: gleiche Hoehe in einer Kennzahlreihe
 *
 * Die Kacheln EINER Kennzahlreihe sind gleich hoch. Die Hoehe gehoert dem
 * TRAEGER, nicht dem laengsten Text einer Zelle - dieselbe Grammatik wie beim
 * Well („der Traeger entscheidet") und beim Lesemass.
 *
 * WARUM EBENE 4 UND NICHT DAS STYLESHEET: im CSS steht `grid-auto-rows: 1fr`,
 * also eine Deklaration. Die ZUSAGE ist „gleich hoch", und ob sie ankommt,
 * haengt daran, wieviele Zeilen das Raster bei dieser Breite bildet und ob eine
 * Host-Stufe die Spaltenzahl aendert. Genau so entstand der Befund: die
 * Abo-Reihe bricht unter 720px Containerbreite auf zwei mal zwei um, und die
 * beiden Rasterzeilen streckten sich unabhaengig - 78px oben, 95px unten, weil
 * eine einzige Fussnote umbrach. Im Stylesheet sah nichts davon falsch aus.
 *
 * SIE PRUEFT DIE ZUSAGE, NICHT IHREN FUNDORT: gesucht wird jede Reihe aus
 * mehreren Kennzahlkarten auf jeder Route - und zusaetzlich hinter jedem
 * Budget-Untertab, weil die Reihen dort hinter einer Leiste liegen, die keine
 * Route wechselt. Damit findet sie auch eine Kennzahlreihe, die es heute noch
 * gar nicht gibt.
 * ──────────────────────────────────────────────────────────────────────────── */

/**
 * Alle Kennzahlreihen der aktuellen Ansicht mit den Hoehen ihrer Kacheln.
 *
 * DIE REIHE KOMMT AUS DEN KARTEN, NICHT AUS EINEM KLASSENNAMEN. Bis 2026-08-10
 * fragte diese Sonde nach `.metric-grid` und pruefte damit N Fundstellen statt
 * einer Regel - genau das Muster, das die Guard-Lehre verbietet. Blind blieb
 * ausgerechnet die Reihe, die den Anlass gab: die Aktivitaets-Kacheln der
 * Gesundheit liegen in `.health-activity__summary`, tragen dieselben
 * `.metric-card` und wurden nie gemessen. Eine Reihe ist jetzt, was sie im
 * Dokument ist: ein Elternknoten mit mehr als einer Kennzahlkarte.
 */
async function metricRowHeights(page) {
  return page.evaluate(() => {
    const carriers = new Map();
    for (const card of document.querySelectorAll('.metric-card')) {
      const parent = card.parentElement;
      if (!parent) continue;
      if (!carriers.has(parent)) carriers.set(parent, []);
      carriers.get(parent).push(card);
    }
    const out = [];
    for (const [grid, cards] of carriers) {
      if (cards.length < 2) continue;
      const name = grid.className || grid.tagName.toLowerCase();
      // Sub-Pixel runden: das Raster verteilt Restpixel, und ein halber Pixel
      // Unterschied ist keine Unruhe, sondern Layout-Arithmetik.
      const box = (c) => c.getBoundingClientRect();
      const lines = new Map();
      for (const card of cards) {
        const top = Math.round(box(card).top);
        if (!lines.has(top)) lines.set(top, []);
        lines.get(top).push(Math.round(box(card).height));
      }
      // (1) NEBENEINANDER: was eine Zeile teilt, ist gleich hoch. Das gilt fuer
      //     jede Reihe aus Kennzahlkarten, gleich in welchem Traeger.
      for (const heights of lines.values()) {
        if (heights.length > 1) out.push({ grid: name, scope: 'Zeile', heights });
      }
      // (2) UEBER DEN UMBRUCH: nur wer gleich hohe Rasterzeilen ZUSAGT, muss sie
      //     auch halten. `.metric-grid` tut das mit `grid-auto-rows: 1fr` - und
      //     genau daran brach es einmal (Abo-Reihe 78px oben, 95px unten). Ein
      //     Kartenraster ohne diese Zusage (die Vitalwerte der Gesundheit)
      //     bemisst jede Zeile fuer sich; das ist keine Unruhe, sondern seine
      //     Bauart. Gelesen wird die Zusage im Dokument, nicht an einem Namen.
      if (getComputedStyle(grid).gridAutoRows === '1fr' && lines.size > 1) {
        out.push({ grid: name, scope: 'Umbruch', heights: cards.map((c) => Math.round(box(c).height)) });
      }
    }
    return out;
  });
}

describe('Sonde 6 - die Kacheln einer Kennzahlreihe sind gleich hoch', () => {
  for (const device of ['mobile', 'desktop']) {
    test(`Geraet ${device}`, async () => {
      const page = await openPage(harness, { device, theme: 'light', locale: 'de' });
      const findings = [];
      let rowsSeen = 0;

      const check = (where, rows) => {
        for (const row of rows) {
          rowsSeen += 1;
          const spread = Math.max(...row.heights) - Math.min(...row.heights);
          if (spread > 0) {
            findings.push(`${where} · ${row.grid} (${row.scope}): Hoehen ${row.heights.join(', ')} (Streuung ${spread}px).`);
          }
        }
      };

      // Auch die Sichten hinter den Leisten: sie wechseln nach der
      // Leisten-Regel (§2) die SICHT innerhalb eines Moduls, nicht die Route.
      // Ohne sie saehe die Sonde von sieben Kennzahlreihen genau eine.
      for (const name of sweep('Sonde 6')) {
        await gotoRoute(page, ALL_ROUTES[name]);
        await visitViews(page, name, async (where) => check(where, await metricRowHeights(page)));
      }
      await page.close();

      // Eine Sonde, die nichts gemessen hat, darf nicht urteilen (dieselbe
      // Zusicherung wie bei Sonde 3, 4 und 5).
      // Der Reichweiten-Nachweis steigt mit der Reichweite: seit die Reihe aus
      // den KARTEN kommt statt aus `.metric-grid`, gehoert die Aktivitaets-Reihe
      // der Gesundheit dazu, die vorher unsichtbar war.
      assert.ok(rowsSeen >= 5,
        `Nur ${rowsSeen} Kennzahlreihen gesehen - erwartet sind mindestens Budget, Abos, Aufteilen, `
        + 'Darlehen und die Aktivitaets-Reihe der Gesundheit. Entweder hat der Seed keine Zahlen '
        + 'geliefert, oder die Bauart hat sich geaendert.');

      assert.deepEqual(findings, [],
        'Kennzahlreihen im gerenderten Dokument. Gleichartige Kacheln nebeneinander sind gleich hoch, '
        + 'auch wenn die Reihe umbricht - die Hoehe gehoert dem Traeger (.metric-grid, panel.css), '
        + 'nicht dem laengsten Text einer Zelle.\n  ' + findings.join('\n  '));
    });
  }
});

/* ────────────────────────────────────────────────────────────────────────────
 * Sonde 7: keine gap-getrennte Kartenspalte
 *
 * Die Zeilenlisten-Regel (§2, Session 6) sagt: eine Folge gleichartiger Zeilen
 * liegt in GENAU EINEM Traeger, und die Zeilen darin sind flaechenlos und
 * trennen sich ueber den `+`-Kombinator. Phase 5 hat die statisch pruefbare
 * Haelfte gezogen - eine Zeile, die ihre Flaeche UND ihren Stapelabstand selbst
 * mitbringt. Die hier gemeinte Bauart ist dieselbe Regelverletzung, nur mit dem
 * Abstand am TRAEGER: die Karte traegt Flaeche, Radius und Schatten, getrennt
 * wird ueber dessen `gap`.
 *
 * WARUM EBENE 4 UND NICHT DAS STYLESHEET: der Traeger ist in dieser Codebasis
 * statisch nicht auflösbar (§2, Session 15). `list.insertAdjacentHTML(...)`
 * bindet ihn an eine JS-Variable; ein Rueckwaerts-Tag-Lauf fand ihn fuer vier
 * Module gar nicht. Wo das `gap` steht, weiss erst das Dokument.
 *
 * WAS EINE KARTENSPALTE IST, UND WAS NICHT - jedes Merkmal gemessen, keines
 * benannt:
 *   - Eine SPALTE IN JEDER GROESSENKLASSE. Mobil bricht jedes mehrspaltige
 *     Raster auf eine Spalte um; wer nur dort misst, meldet die Kennzahlraster
 *     der Gesundheit, die Notiz-Masonry und die Dashboard-Widgets - allesamt
 *     Raster aus Objekten mit eigenem Medium, also die benannte Ausnahme der
 *     Regel. Gemeldet wird deshalb nur, was in BEIDEN Geraetewelten ein
 *     vertikaler Stapel ist. Gemessen: 16 Kandidaten mobil, 6 im Schnitt.
 *   - EINE KARTE HAT EINEN RADIUS. `.week-gutter-label` traegt Flaeche und
 *     Schatten bei Radius 0 - eine Rasterbeschriftung, keine Karte.
 *   - EINE KAPSEL IST EIN GRIFF. Die Buttonform-Regel sagt es positiv: die
 *     Kapsel ist die EINE Form fuer Elemente, die eine Aktion ausloesen.
 *   - EINE BUEHNE TRAEGT EINE ZEILE, KEINE STRUKTUR. `.subscription-card` liegt
 *     in einer `.swipe-row`, die bewusst flaechenlos ist; ohne Durchgriff waere
 *     jede Wischliste unsichtbar. Der Durchgriff greift durch genau EIN Kind im
 *     Fluss - `.list-group` hat zwei (Gruppenkopf und Zeilenliste) und ist
 *     damit das Gegenteil eines Verstosses.
 *   - WAS MAN ZIEHT, IST EIN OBJEKT. `.kanban-card` ist `draggable`; ein Board
 *     ist keine Liste.
 *   - EIN DROP-ZIEL BEHAELT SEINE KANTE (§2, Kasten-in-Kasten). `.meal-slot`
 *     traegt sie gestrichelt und sitzt per `grid-row` in einem Wochenraster.
 * ──────────────────────────────────────────────────────────────────────────── */

/** Jede Folge gleichartiger Karten, die ihre Trennung dem `gap` ihres Traegers ueberlaesst. */
async function cardColumns(page) {
  return page.evaluate(() => {
    const shown = (n) => {
      const r = n.getBoundingClientRect();
      return r.width > 1 && r.height > 1;
    };
    const opaque = (bg) => bg && bg !== 'rgba(0, 0, 0, 0)' && !/\/\s*0?\.\d+\)/.test(bg);
    const inFlow = (el) => [...el.children].filter((c) => {
      const pos = getComputedStyle(c).position;
      return pos !== 'absolute' && pos !== 'fixed';
    });
    const hits = [];
    const seen = new Set();

    for (const el of document.querySelectorAll('*')) {
      const parent = el.parentElement;
      if (!parent) continue;
      const cls = [...el.classList][0];
      if (!cls) continue;
      const key = `${parent.className}>${cls}`;
      if (seen.has(key)) continue;

      // Eine FOLGE, kein Einzelfall - und sichtbar, nicht bloss im DOM: ein
      // inaktives Tab-Panel bleibt stehen, und seine Karten messen 0x0.
      const sibs = [...parent.children].filter((s) => s.classList.contains(cls) && shown(s));
      if (sibs.length < 3) continue;

      // Die Trennung liegt am TRAEGER. Ohne `row-gap` trennt etwas anderes.
      const rowGap = parseFloat(getComputedStyle(parent).rowGap) || 0;
      if (!(rowGap > 0)) continue;

      // Ein vertikaler Stapel: das zweite Geschwister steht UNTER dem ersten,
      // an derselben Kante. Nebeneinander ist ein Raster.
      const first = sibs[0].getBoundingClientRect();
      const second = sibs[1].getBoundingClientRect();
      if (!(second.top >= first.bottom - 1 && Math.abs(second.left - first.left) < 2)) continue;

      let card = el;
      let via = '';
      if (!opaque(getComputedStyle(el).backgroundColor)) {
        const kids = inFlow(el).filter(shown);
        if (kids.length !== 1) continue;
        [card] = kids;
        via = `${cls} > .`;
      }
      const cs = getComputedStyle(card);
      if (!opaque(cs.backgroundColor)) continue;
      if (cs.breakInside === 'avoid') continue;
      if (el.draggable || card.draggable) continue;
      if (cs.borderTopStyle === 'dashed') continue;

      const rect = card.getBoundingClientRect();
      const radius = parseFloat(cs.borderTopLeftRadius) || 0;
      if (radius <= 0) continue;
      if (radius >= rect.height / 2 - 0.5) continue;

      seen.add(key);
      hits.push({
        cls: `${via}${[...card.classList][0]}`,
        parent: parent.className.split(' ')[0] || parent.tagName.toLowerCase(),
        count: sibs.length,
        gap: rowGap,
      });
    }
    return hits;
  });
}

/**
 * Klassenname -> Grund. Bauform-Ausnahmen von Sonde 7: Karten, die WIRKLICH
 * eigenstaendige Objekte sind und keine Listenzeilen im Kartenkostuem.
 *
 * Der draggable-Ausweg der Messung ist fuer sie unerreichbar: SortableJS zieht
 * ueber seine draggable-OPTION (einen Selektor) und traegt das DOM-Attribut
 * nicht ein - und ein von Hand gesetztes draggable="true" aktiviert natives
 * HTML5-DnD, das der Pointer-Geste den Zug wegnimmt (gemessen 2026-09-02 am
 * Board: Baseline gruen, mit Attribut kein Ghost, kein Spaltenwechsel, kein
 * Titel-Klick). Deshalb eine BENANNTE Ausnahme statt eines Attributs.
 *
 * Jeder Eintrag muss im Lauf gesehen werden (Assert unten), sonst ist er eine
 * Leiche - dasselbe Veraltungsmuster wie bei SHAPE_EXEMPT/TARGET_EXEMPT.
 */
const CARD_OBJECT_EXEMPT = new Map([
  ['kanban-card', 'Drag-Objekt zwischen Board-Spalten; die Kartenoptik ist die '
    + 'Greif-Affordance, und ein Schatten je Karte ist dort die Aussage, nicht der Streifen.'],
]);

test('Sonde 7 - eine Zeilenfolge ist keine Spalte aus Karten', async () => {
  const perDevice = new Map();
  let viewsSeen = 0;

  for (const device of ['desktop', 'mobile']) {
    const page = await openPage(harness, { device, theme: 'light', locale: 'de' });
    const found = new Map();
    const note = async (where) => {
      viewsSeen += 1;
      for (const hit of await cardColumns(page)) {
        if (!found.has(hit.cls)) found.set(hit.cls, { ...hit, where });
      }
    };
    for (const name of sweep('Sonde 7')) {
      await gotoRoute(page, ALL_ROUTES[name]);
      // Auf einem Blatt nur der Zustand selbst - siehe `isLeaf`: zwei der drei
      // Umschaltergruppen in den Einstellungen schreiben eine Einstellung.
      if (isLeaf(name)) await note(name);
      else await visitViews(page, name, note);
    }
    await page.close();
    perDevice.set(device, found);
  }

  // Der SCHNITT beider Groessenklassen: was mobil untereinander steht und auf
  // dem Desktop nebeneinander, ist ein Raster, das umbricht.
  const desktop = perDevice.get('desktop');
  const mobile = perDevice.get('mobile');
  const seenExempt = new Set();
  const findings = [...desktop.entries()]
    .filter(([cls]) => mobile.has(cls))
    .filter(([cls]) => {
      if (CARD_OBJECT_EXEMPT.has(cls)) { seenExempt.add(cls); return false; }
      return true;
    })
    .map(([cls, hit]) => `${hit.where} · .${cls}: ${hit.count} Karten in .${hit.parent}, getrennt ueber gap ${hit.gap}px.`);

  // Veraltungs-Nachweis: eine Ausnahme, deren Karte der Lauf nicht mehr sieht,
  // deckt nichts mehr und darf nicht stehen bleiben (SHAPE_EXEMPT-Lehre).
  for (const cls of CARD_OBJECT_EXEMPT.keys()) {
    assert.ok(seenExempt.has(cls),
      `CARD_OBJECT_EXEMPT('${cls}') ohne Fundstelle im Lauf - die Bauform gibt es `
      + 'so nicht mehr, der Eintrag ist eine Leiche und gehoert neu bewertet.');
  }

  // Eine Sonde, die nichts gesehen hat, darf nicht urteilen (dieselbe
  // Zusicherung wie bei Sonde 3, 4, 5 und 6) - und hier ist es die REICHWEITE,
  // die belegt werden muss, nicht die Zahl der Befunde. Gemessen sind es 92 je
  // Geraet: 16 Routen plus die Sichten dahinter. Faellt der Helfer auf die
  // blossen Routen zurueck, ist ein gruener Lauf keine Aussage mehr, sondern
  // genau die Luecke, wegen der es diese Sonde gibt.
  const reach = ROUTE_NAMES.length + SETTINGS_NAMES.length;
  assert.ok(viewsSeen >= 2 * (reach + 30),
    `Nur ${viewsSeen} Sichten besucht (erwartet: deutlich mehr als die ${2 * reach} Zustaende). `
    + 'Der Reichweiten-Helfer erreicht die Sichten hinter den Leisten nicht mehr - '
    + 'Budget-Untertabs, Health-Routen, Housekeeping-Tabs, Raster/Liste der Dokumente - '
    + 'oder die Settings-Blaetter fallen wieder aus der Ableitung.');

  assert.deepEqual(findings, [],
    'Kartenspalten im gerenderten Dokument. Eine Folge gleichartiger Zeilen liegt in GENAU EINEM '
    + 'Traeger (randlose Karte, `overflow: hidden`); die Zeilen darin sind flaechenlos und trennen '
    + 'sich ueber `> * + *`. Eine Karte je Zeile sagt „jedes davon ist ein eigenes Objekt", wo die '
    + 'Gruppe gemeint ist - und ein Schatten je Zeile erzeugt in einer langen Liste Streifen.\n  '
    + findings.join('\n  '));
});

/* ────────────────────────────────────────────────────────────────────────────
 * Sonde 8: ein Kopf mit Lead-Zone dockt beim Scrollen auch an
 *
 * Die Regel (§2, Session 7, praezisiert Session 19): die Trennlinie erscheint
 * beim Andocken - und andocken kann nur ein Kopf mit Lead-Zone. Die eine
 * Haelfte ist trivial und stimmte immer: ohne Lead-Zone traegt die Leiste ihre
 * Linie durchgehend. Die andere lag DREI RUNDEN falsch, ohne dass ein Test es
 * sah: drei Koepfe mit Lead-Zone (Gesundheit, Belohnungen, Haushaltshilfe)
 * dockten mobil nie an und trugen damit in KEINEM Zustand eine Kante.
 *
 * WARUM EBENE 4: der Fehler stand in keinem Stylesheet und in keinem
 * Modulcode. Er entstand aus einer Geometrie, die genau aufgeht - der
 * beobachtete Zeuge der ersten Zeile ist ein Kind des KLEBENDEN Kopfes und
 * wandert nur so weit, wie das negative `top` ihn hochzieht, also exakt
 * `--page-toolbar-lead`. Bei einem ZWEIZEILIGEN Kopf ist das die Unterkante
 * der ersten Zeile: sie endet buendig auf der Port-Kante, beruehrt sie also,
 * statt sie zu ueberschreiten. Ob eine Kante beruehrt oder ueberschritten
 * wird, weiss erst das Dokument.
 *
 * WARUM NUR MOBIL: die kollabierende Leiste ist eine Regel der KOMPAKTEN
 * Groessenklasse. Ab 1024px steht jeder Kopf einzeilig und traegt seine Linie
 * durchgehend - dort gibt es kein Andocken zu pruefen.
 *
 * WARUM KEIN `visitViews`: die Regel gilt am MODULKOPF, und davon hat jedes
 * Modul genau einen; er ueberlebt den Sichtwechsel. Das ist eine Aussage ueber
 * die Regel, keine Bequemlichkeit - und sie haelt diese Sonde bei rund zwei
 * Minuten statt bei zwanzig.
 * ──────────────────────────────────────────────────────────────────────────── */

/**
 * Liest Lead-Zone, Andock-Zustand, Linienfarbe UND die echte Zeiligkeit des
 * Modulkopfs.
 *
 * Die Zeiligkeit wird hier unabhaengig von `wireCollapsingHeader` bestimmt -
 * eine Sonde, die dessen eigene Rechnung nachspricht, prueft nichts. Zwei
 * Kaesten stehen auf derselben Zeile, wenn sich ihre vertikalen Intervalle
 * ueberlappen; ein Kasten ohne Hoehe macht keine Zeile auf.
 */
async function headDocking(page) {
  return page.evaluate(() => {
    const head = document.querySelector('.page-toolbar');
    if (!head) return null;
    const cs = getComputedStyle(head);
    const visible = (c) => !/rgba\(0, 0, 0, 0\)|\/\s*0\)/.test(c);
    const boxes = [...head.children]
      .filter((c) => c.offsetParent !== null || c.getClientRects().length)
      .map((c) => c.getBoundingClientRect())
      .filter((r) => r.height > 0)
      .sort((a, b) => a.top - b.top);
    const lines = [];
    for (const r of boxes) {
      const line = lines.find((l) => r.top < l.bottom - 1 && r.bottom > l.top + 1);
      if (line) { line.top = Math.min(line.top, r.top); line.bottom = Math.max(line.bottom, r.bottom); }
      else lines.push({ top: r.top, bottom: r.bottom });
    }
    return {
      lead: parseFloat(cs.getPropertyValue('--page-toolbar-lead')) || 0,
      rows: lines.length,
      docked: head.classList.contains('is-docked'),
      line: visible(cs.borderBottomColor) && parseFloat(cs.borderBottomWidth) > 0,
    };
  });
}

/** Scrollt jeden Port bis ans Ende und meldet die groesste gefundene Reserve. */
async function scrollEveryPort(page) {
  return page.evaluate(() => {
    let most = 0;
    for (const el of document.querySelectorAll('*')) {
      const oy = getComputedStyle(el).overflowY;
      const reserve = el.scrollHeight - el.clientHeight;
      if ((oy === 'auto' || oy === 'scroll') && reserve > 8) {
        el.scrollTop = reserve;
        most = Math.max(most, reserve);
      }
    }
    return most;
  });
}

test('Sonde 8 - ein Kopf mit Lead-Zone traegt seine Linie erst angedockt, und dockt auch an', async () => {
  const page = await openPage(harness, { device: 'mobile', theme: 'light', locale: 'de' });
  const findings = [];
  let headsSeen = 0;
  let leadHeads = 0;

  for (const name of sweep('Sonde 8')) {
    await gotoRoute(page, ALL_ROUTES[name]);
    // Der Kopf misst sich ueber ResizeObserver und MutationObserver, und der
    // IntersectionObserver feuert asynchron - eine Messung direkt nach dem
    // Aufbau liest den Zwischenstand.
    await new Promise((r) => setTimeout(r, 700));
    const before = await headDocking(page);
    if (!before) continue;
    headsSeen += 1;

    // Ohne Lead-Zone gilt die andere Haelfte der Regel: die Linie steht
    // durchgehend. Ein Kopf, der DANN keine traegt, hat gar keine Kante - das
    // war der Zustand der Rezepte, verursacht von einem leeren Slot, den die
    // Zeilenmessung fuer eine zweite Zeile hielt.
    if (!before.lead) {
      if (!before.line) {
        findings.push(`${name}: ohne Lead-Zone und ohne Linie - der Kopf hat in keinem Zustand eine Kante.`);
      }
      continue;
    }
    leadHeads += 1;

    // EINE LEAD-ZONE AUF EINEM EINZEILIGEN KOPF IST KEINE. Sie kostet dann
    // nicht nur nichts, sie verbirgt die Linie dauerhaft: `--stacked` schaltet
    // `border-bottom-color: transparent`, und ohne Zeile, die wegwandern kann,
    // gibt es kein Andocken, das sie zurueckholt. Genau so stand der
    // Rezepte-Kopf da - ein leerer Slot ohne Hoehe galt als zweite Zeile.
    if (before.rows < 2) {
      findings.push(
        `${name}: Lead-Zone ${before.lead}px, aber der Kopfinhalt steht in EINER Zeile - `
        + 'eine Lead-Zone ohne zweite Zeile verbirgt die Linie dauerhaft.',
      );
      continue;
    }

    // Mit Lead-Zone: am Scroll-Anfang nahtlos. Ein Kopf, der beim Aufbau schon
    // gescrollt ist (der Essensplan springt auf „jetzt"), ist zu Recht
    // angedockt und wird hier nicht beurteilt.
    if (!before.docked && before.line) {
      findings.push(`${name}: Lead-Zone ${before.lead}px, nicht angedockt, traegt aber schon die Linie.`);
    }

    const reserve = await scrollEveryPort(page);
    await new Promise((r) => setTimeout(r, 700));
    // Ein Kopf, unter dem nichts wegscrollt, MUSS nicht andocken - sonst misst
    // die Sonde den Seed statt der Regel. Die Schwelle ist die Lead-Zone
    // selbst: erst dahinter gibt es ueberhaupt etwas zu beobachten.
    if (reserve <= before.lead) continue;
    const after = await headDocking(page);
    if (!after.docked || !after.line) {
      findings.push(
        `${name}: Lead-Zone ${before.lead}px und ${reserve}px Scroll-Reserve, aber nach dem Scrollen `
        + `${after.docked ? 'angedockt ohne Linie' : 'nicht angedockt'} - die Kopfkante erscheint nie.`,
      );
    }
  }
  await page.close();

  // Eine Sonde, die nichts gesehen hat, darf nicht urteilen (dieselbe
  // Zusicherung wie bei Sonde 3 bis 7). Hier braucht es BEIDES: Koepfe
  // ueberhaupt, und Koepfe MIT Lead-Zone - sonst belegt ein gruener Lauf nur
  // die triviale Haelfte der Regel, und genau die andere war kaputt.
  assert.ok(headsSeen >= ROUTE_NAMES.length - 3,
    `Nur ${headsSeen} Modulkoepfe von ${ROUTE_NAMES.length} Routen gesehen - die Sonde erreicht die Koepfe nicht mehr.`);
  assert.ok(leadHeads >= 5,
    `Nur ${leadHeads} Koepfe mit Lead-Zone gesehen (gemessen: 10). Ohne sie prueft diese Sonde nur, `
    + 'dass einzeilige Koepfe eine Linie tragen.');

  assert.deepEqual(findings, [],
    'Die Trennlinie erscheint beim Andocken, und andocken kann nur ein Kopf mit Lead-Zone - wer eine '
    + 'hat, muss es dann aber auch tun. Wo keine ist, steht die Linie durchgehend und markiert die '
    + 'Kopfkante.\n  '
    + findings.join('\n  '));
});

// ============================================================
// Sonde 9 - Compositor-Ebenen im Ruhezustand
// ============================================================

/**
 * ZWEI NACHBARFRAGEN BLEIBEN HIER BEWUSST UNGEPRUEFT, und beide stehen hier,
 * weil das die Stelle ist, an der jemand nach „ist die Laufzeit abgesichert"
 * sucht (Guard-Abdeckung 2026-08-08, Befund G und die Positivbefund-Tabelle):
 *
 *   KEIN LAYOUT-THRASHING. Gemessen im Implementierungs-Audit: 4 Layout-
 *   Lesungen innerhalb von Schleifen in 61.274 Zeilen, keine Lese-Schreib-
 *   Kaskade. Ein statischer Guard muesste den DATENFLUSS verfolgen - welche
 *   Schreiboperation invalidiert welches Layout -, und jede Naeherung darunter
 *   („eine Layout-Lesung in einer Schleife") meldet Fehltreffer an genau den
 *   vier Stellen, die heute begruendet dastehen. Auf Ebene 4 waere es auch
 *   keine Regel: ein `PerformanceObserver` misst, wie lang der SEED ist, nicht,
 *   ob der Code kaskadiert - eine leere Liste ist immer schnell.
 *
 *   DIE BEGRUENDUNGSDICHTE DER LAYOUT-TRANSITIONS. Sechs Regeln animieren eine
 *   echte Layout-Eigenschaft (detail-view.css:222, layout.css:165/1765/1789/2017,
 *   settings.css:163), und jede traegt im Code, warum `transform` es dort nicht
 *   kann, und ist im passenden `prefers-reduced-motion`-Block abgeschaltet. Ein
 *   Guard koennte die Fundstellen zaehlen und den Reduced-Motion-Block pruefen -
 *   die ZUSAGE ist aber, dass die BEGRUENDUNG traegt, und das ist eine Aussage
 *   ueber einen Prosatext. Ein Guard, der die Existenz eines Kommentars prueft,
 *   erzieht zum Kommentar, nicht zur Begruendung; er waere gruen an dem Tag, an
 *   dem jemand „// bewusst" darueberschreibt. Beim Nachzaehlen fuer diesen
 *   Eintrag fehlte die Begruendung an genau einer Stelle (settings.css:163) und
 *   ist jetzt da - gefunden durch Lesen, nicht durch einen Guard, und das ist
 *   der ehrliche Weg fuer diese Zusage.
 *
 * Zaehlt im Ruhezustand jedes Element mit einem `will-change`, das eine eigene
 * Compositor-Ebene erzwingt, und gruppiert nach Klassensignatur.
 *
 * DIE SIGNATUR IST DER MASSSTAB, NICHT EINE OBERGRENZE. Die Frage ist nicht
 * „wie viele Ebenen sind zu viele", sondern „waechst die Zahl mit dem Inhalt".
 * Ein einmaliges Chrome-Element (die Sidebar-Pille, der Tab-Indikator, ein
 * Backdrop-Blob) darf sein Versprechen dauerhaft halten - es gibt genau eins
 * davon, egal wie lang die Liste wird. Eine Zeile darf es nicht: dieselbe
 * Signatur zweimal heisst, sie kommt auch 200-mal.
 *
 * Genau diese Unterscheidung sieht ein Stylesheet-Scanner nicht: `.lg-blob--1`
 * und `.task-card` tragen dieselbe Deklaration.
 */
// Nur Versprechen, die tatsaechlich eine eigene Ebene erzwingen. `will-change:
// opacity` allein tut das in Blink nicht zwingend, `transform` und `filter`
// schon - und das sind die Faelle, um die es geht.
const LAYER_PROPS = ['transform', 'filter', 'backdrop-filter'];

async function restingLayers(page) {
  return page.evaluate((props) => {
    const out = [];
    for (const el of document.querySelectorAll('*')) {
      const wc = getComputedStyle(el).willChange;
      if (!wc || wc === 'auto') continue;
      if (!props.some((p) => wc.includes(p))) continue;
      const r = el.getBoundingClientRect();
      if (r.width === 0 || r.height === 0) continue;
      const cls = (typeof el.className === 'string' ? el.className : '').trim().replace(/\s+/g, '.');
      out.push({ sig: `${el.tagName.toLowerCase()}${cls ? `.${cls}` : ''}`, wc });
    }
    return out;
  }, LAYER_PROPS);
}

test('Sonde 9 - ein Compositor-Versprechen im Ruhezustand ist einmalig, nie eine Zeile', async () => {
  const page = await openPage(harness, { device: 'mobile', theme: 'light', locale: 'de' });
  const findings = [];
  let routesSeen = 0;
  let layersSeen = 0;

  const routes = sweep('Sonde 9');
  for (const name of routes) {
    await gotoRoute(page, ALL_ROUTES[name]);
    // Die Zeilenlisten bauen sich nach dem ersten Frame auf; eine Messung
    // direkt danach faende die leere Seite und waere immer gruen.
    await new Promise((r) => setTimeout(r, 500));
    routesSeen += 1;

    const counts = new Map();
    for (const { sig, wc } of await restingLayers(page)) {
      layersSeen += 1;
      const entry = counts.get(sig) ?? { count: 0, wc };
      entry.count += 1;
      counts.set(sig, entry);
    }

    for (const [sig, { count, wc }] of counts) {
      if (count < 2) continue;
      findings.push(`${name}: ${count}x ${sig} traegt "will-change: ${wc}" im Ruhezustand.`);
    }
  }
  await page.close();

  // Eine Sonde, die nichts gesehen hat, darf nicht urteilen (dieselbe
  // Zusicherung wie bei Sonde 3 bis 8). Hier zaehlt BEIDES: die Routen, und
  // dass ueberhaupt Ebenen gefunden werden - die Shell traegt drei einmalige
  // (Sidebar-Pille, Sidebar-Hover, Tab-Indikator) plus die Backdrop-Blobs.
  // Findet die Sonde gar keine, misst sie den Selektor falsch statt die App.
  assert.ok(routesSeen >= routes.length - 1,
    `Nur ${routesSeen} von ${routes.length} Zustaenden gesehen.`);
  assert.ok(layersSeen >= routesSeen,
    `Nur ${layersSeen} Ebenen ueber ${routesSeen} Routen gefunden - die Shell allein traegt `
    + 'mehrere je Seite. Die Sonde misst nicht mehr, was sie messen soll.');

  assert.deepEqual(findings, [],
    'Wiederholte Compositor-Versprechen im Ruhezustand. Eine Signatur, die zweimal vorkommt, kommt '
    + 'auch 200-mal: die Ebenen-Last waechst dann mit der Zeilenzahl, auf genau den aelteren '
    + 'Telefonen, die laut PRODUCT.md die Hauptszene sind. Das Versprechen gehoert an die GESTE '
    + '(.swipe-row--armed in layout.css), nicht an die Zeile.\n  '
    + findings.join('\n  '));
});

// ============================================================
// Sonde 10 - die Struktur jedes Dokuments, angemeldet wie davor
// ============================================================

/**
 * Die A11y-Grundlage als GUARD statt als einmalige Messung.
 *
 * Genau ein `h1`, genau ein `main`, ein `lang`, ein beschreibender Titel, ein
 * Name an jedem Ziel, ein Label an jedem Feld, keine doppelte ID, kein
 * Ueberschriftensprung, kein ARIA-Verweis ins Leere, kein Ueberlauf.
 *
 * ZWEI LUECKEN AUF EINMAL. Erstens: `ROUTES` sind angemeldete Zustaende, und
 * `openPage` reicht dafuer ein Cookie durch - Anmelden, Passwort vergessen,
 * Passwort zuruecksetzen, Einladung annehmen, Ersteinrichtung und die
 * Offline-Huelle hatten nie eine Sonde gesehen (Audit 2026-08-08, P2-5).
 * Zweitens: fuer die angemeldete App war diese Grundlage zwar GEMESSEN, aber
 * nie abgesichert - der Audit fuehrte sie unter „Was traegt", und ein
 * Positivbefund ohne Guard ist eine Momentaufnahme. Der Beleg kam sofort: die
 * Nachmessung fand einen 47. toten ARIA-Verweis (`#cal-search` zeigte auf eine
 * Suchleiste, die erst beim Oeffnen entsteht), den der Audit selbst uebersehen
 * hatte. Die Sonde faehrt deshalb BEIDE Welten mit denselben Fragen.
 *
 * ZIELGROESSEN NUR VOR DER ANMELDUNG: dahinter gehoeren sie Sonde 4, und die
 * misst die TREFFERFLAECHE an jeder Scrollposition und unterscheidet
 * freistehende von eingeengten Zielen. Eine zweite, groebere Messung daneben
 * wuerde genau die Fehltreffer melden, die Sonde 4 gelernt hat zu vermeiden
 * (ein 34x34-Knopf, der per `::before` auf 44px ausdehnt). Vor der Anmeldung
 * hat Sonde 4 keine Reichweite - dort ist die grobe Messung besser als keine.
 */
/**
 * Wartet, bis keine ENDLICHE Animation mehr laeuft.
 *
 * `settle()` wartet auf den Aufbau, nicht auf die Ruhe: der Router blendet
 * jede Seite mit einer 200ms-Slide-Animation ein, und waehrend dieser
 * Animation steht der Seiteninhalt auf `opacity: 0`. Genau dort hat diese
 * Sonde einmal gemessen und `desktop/notes: 0 h1` gemeldet - der Titel steht
 * im synchronen Markup, war aber im Sinne der Sichtbarkeitspruefung nicht da.
 * Ein Guard, der von einer Animation abhaengt, meldet Zufall statt Regel.
 *
 * NUR ENDLICHE Animationen: die Backdrop-Blobs laufen mit
 * `animation: lg-drift 26s infinite alternate` und werden NIE fertig - ein
 * naives `Promise.all(getAnimations().map(a => a.finished))` haengt bis zum
 * Timeout der Suite.
 */
async function settleAnimations(page) {
  try {
    await page.evaluate(() => {
      const finite = document.getAnimations().filter((a) => {
        try { return a.effect?.getTiming().iterations !== Infinity; } catch { return false; }
      });
      return Promise.race([
        Promise.all(finite.map((a) => a.finished.catch(() => {}))),
        new Promise((r) => setTimeout(r, 1500)),
      ]);
    });
  } catch {
    /* Kontext beim Navigieren zerstoert - der naechste Aufruf misst ohnehin neu. */
  }
}

async function documentStructure(page) {
  return page.evaluate(() => {
    const path = (el) => {
      const parts = [];
      for (let n = el; n && n.nodeType === 1 && parts.length < 3; n = n.parentElement) {
        let s = n.tagName.toLowerCase();
        if (n.id) { parts.unshift(`${s}#${n.id}`); break; }
        const cls = (typeof n.className === 'string' ? n.className : '').trim().split(/\s+/).filter(Boolean).slice(0, 2);
        if (cls.length) s += `.${cls.join('.')}`;
        parts.unshift(s);
      }
      return parts.join(' > ');
    };
    const visible = (el) => {
      const r = el.getBoundingClientRect();
      const cs = getComputedStyle(el);
      return r.width > 0 && r.height > 0 && cs.visibility !== 'hidden' && cs.display !== 'none'
        && cs.opacity !== '0' && !el.closest('[hidden],[aria-hidden="true"]');
    };
    const accName = (el) => {
      const a = el.getAttribute('aria-label'); if (a?.trim()) return a.trim();
      const lb = el.getAttribute('aria-labelledby');
      if (lb) {
        const txt = lb.split(/\s+/).map((id) => document.getElementById(id)?.textContent || '').join(' ').trim();
        if (txt) return txt;
      }
      const ti = el.getAttribute('title'); if (ti?.trim()) return ti.trim();
      const tx = (el.textContent || '').replace(/\s+/g, ' ').trim(); if (tx) return tx;
      return el.querySelector('img[alt]')?.alt.trim() || '';
    };

    const out = { nameless: [], inputsNoLabel: [], dupIds: [], headings: [], badRefs: [], smallTargets: [] };

    for (const el of document.querySelectorAll('button, a[href], [role="button"], summary, input[type="submit"]')) {
      if (visible(el) && !accName(el)) out.nameless.push(path(el));
    }
    for (const el of document.querySelectorAll('input:not([type="hidden"]), select, textarea')) {
      if (!visible(el)) continue;
      const labelled = (el.id && document.querySelector(`label[for="${CSS.escape(el.id)}"]`)) || el.closest('label');
      if (!labelled && !el.getAttribute('aria-label') && !el.getAttribute('aria-labelledby')) {
        out.inputsNoLabel.push(`${path(el)} (${el.getAttribute('type') || el.tagName.toLowerCase()})`);
      }
    }
    const seen = new Map();
    for (const el of document.querySelectorAll('[id]')) seen.set(el.id, (seen.get(el.id) || 0) + 1);
    for (const [id, n] of seen) if (n > 1) out.dupIds.push(`#${id} (${n}x)`);

    const hs = [...document.querySelectorAll('h1,h2,h3,h4,h5,h6')].filter(visible);
    let prev = 0;
    for (const h of hs) {
      const lvl = Number(h.tagName[1]);
      if (prev && lvl > prev + 1) out.headings.push(`${path(h)}: h${prev} -> h${lvl}`);
      prev = lvl;
    }
    // Dieselbe Pruefung, die die zehn toten aria-controls gefunden hat.
    for (const el of document.querySelectorAll('[aria-labelledby],[aria-describedby],[aria-controls]')) {
      for (const attr of ['aria-labelledby', 'aria-describedby', 'aria-controls']) {
        const v = el.getAttribute(attr);
        if (!v) continue;
        const missing = v.split(/\s+/).filter((id) => id && !document.getElementById(id));
        if (missing.length) out.badRefs.push(`${path(el)} ${attr}="${missing.join(' ')}"`);
      }
    }

    const min = window.innerWidth < 768 ? 44 : 24;
    for (const el of document.querySelectorAll('button, a[href], [role="button"], input[type="checkbox"], input[type="radio"], select')) {
      if (!visible(el)) continue;
      const r = el.getBoundingClientRect();
      if (r.width < min && r.height < min) {
        out.smallTargets.push(`${path(el)} ${Math.round(r.width)}x${Math.round(r.height)} (min ${min})`);
      }
    }


    return {
      ...out,
      h1: hs.filter((h) => h.tagName === 'H1').length,
      main: document.querySelectorAll('main,[role="main"]').length,
      lang: document.documentElement.lang || null,
      title: document.title,
      overflowX: document.documentElement.scrollWidth - document.documentElement.clientWidth,
    };
  });
}

test('Sonde 10 - jedes Dokument traegt dieselbe Struktur, angemeldet wie davor', async () => {
  const anonNames = Object.keys(ANON_ROUTES);
  const authNames = sweep('Sonde 10');
  const findings = [];
  let seen = 0;

  const judge = (at, r, { targets }) => {
    seen += 1;

    // Genau EIN h1 und EIN main: eine Seite braucht einen Namen und eine
    // Landmarke, sonst laeuft ein Screenreader sie von oben durch.
    if (r.h1 !== 1) findings.push(`${at}: ${r.h1} h1 (erwartet: genau eins)`);
    if (r.main !== 1) findings.push(`${at}: ${r.main} main-Landmarken (erwartet: genau eine)`);
    if (!r.lang) findings.push(`${at}: kein lang-Attribut am Dokument`);

    // Der Titel ist in einer SPA die einzige Ansage beim Seitenwechsel
    // (WCAG 2.4.2, Level A). „Yuvomi · Yuvomi" war der gemessene Verstoss.
    const parts = r.title.split('·').map((s) => s.trim());
    if (!r.title.trim()) findings.push(`${at}: leerer Dokumenttitel`);
    else if (parts.length > 1 && parts[0] === parts[1]) {
      findings.push(`${at}: Dokumenttitel "${r.title}" wiederholt nur den App-Namen`);
    }

    for (const sel of r.nameless) findings.push(`${at}: Ziel ohne zugaenglichen Namen - ${sel}`);
    for (const sel of r.inputsNoLabel) findings.push(`${at}: Eingabefeld ohne Label - ${sel}`);
    for (const id of r.dupIds) findings.push(`${at}: doppelte ID ${id}`);
    for (const h of r.headings) findings.push(`${at}: Ueberschriftensprung ${h}`);
    for (const ref of r.badRefs) findings.push(`${at}: ARIA-Verweis ins Leere - ${ref}`);
    if (targets) {
      for (const s of r.smallTargets) findings.push(`${at}: Zielgroesse unter dem Minimum - ${s}`);
    }
    if (r.overflowX > 1) findings.push(`${at}: ${r.overflowX}px horizontaler Ueberlauf`);
  };

  for (const device of ['mobile', 'desktop']) {
    // Vor der Anmeldung: eigene Seite ohne Cookie (openPage wuerde von genau
    // diesen Routen wegleiten).
    const anon = await openAnonPage(harness, { device, theme: 'light' });
    for (const name of anonNames) {
      await gotoAnonRoute(anon, ANON_ROUTES[name]);
      await settleAnimations(anon);
      judge(`${device}/${name}`, await documentStructure(anon), { targets: true });
    }
    await anon.close();

    // Dahinter: dieselben Fragen, ohne die Zielgroessen (die gehoeren Sonde 4).
    const auth = await openPage(harness, { device, theme: 'light', locale: 'de' });
    for (const name of authNames) {
      await gotoRoute(auth, ALL_ROUTES[name]);
      await settleAnimations(auth);
      judge(`${device}/${name}`, await documentStructure(auth), { targets: false });
    }
    await auth.close();
  }

  // Eine Sonde, die nichts gesehen hat, darf nicht urteilen (dieselbe
  // Zusicherung wie bei Sonde 3 bis 9).
  const expected = 2 * (anonNames.length + authNames.length);
  assert.equal(seen, expected, `Nur ${seen} von ${expected} Zustaenden gesehen.`);

  assert.deepEqual(findings, [],
    'Struktur-Befunde im gerenderten Dokument. Die Seiten VOR der Anmeldung sind der Erstkontakt '
    + 'und der Weg jedes neuen Familienmitglieds; die dahinter halten dieselbe Grundlage.\n  '
    + findings.join('\n  '));
});

/**
 * Sonde 11 - was klickbar ist, ist auch mit der Tastatur erreichbar.
 *
 * WARUM DAS EINE SONDE IST UND KEIN SCANNER. Der Cursor sagt es nicht:
 * `cursor: pointer` vererbt, also sieht jedes Kind einer klickbaren Karte
 * klickbar aus. Der Klassenname sagt es auch nicht - `.birthdays-toolbar__import`
 * ist ein Knopf und heisst nach seiner Funktion (Session 12). Gefragt ist die
 * LISTENER-REGISTRY DER ENGINE, und die kennt nur der laufende Browser:
 * `DOMDebugger.getEventListeners` ueber CDP. Puppeteer bringt den Zugang mit,
 * es kommt kein Fremdcode dazu.
 *
 * DER POSITIVBEFUND WAR DER ANLASS. Der Implementierungs-Audit vom 2026-08-08
 * fuehrte unter „Was traegt": *Tastaturbedienung: 0 Befunde. Alle 29 Elemente
 * mit click-Listener ohne eigenen Tastaturzugang sind Container mit
 * Event-Delegation ueber echte Buttons.* Gemessen, gestimmt, nie abgesichert -
 * und ein Positivbefund ohne Guard ist eine Momentaufnahme. Dieselbe Bauform
 * hat bei Sonde 10 sofort einen 47. toten ARIA-Verweis geliefert, den der Audit
 * selbst uebersehen hatte.
 *
 * WAS SIE DURCHLAESST, UND WARUM DAS DIE REGEL IST: ein Container, der einen
 * click-Listener traegt und im Inneren ein echtes Bedienelement hat, ist
 * EVENT-DELEGATION - das Muster, mit dem diese App ihre Listen verdrahtet, und
 * die Tastatur erreicht das Ziel ueber den Knopf darin. Gemeldet wird der
 * Container OHNE inneres Ziel: dort endet der Klick, und die Tastatur kommt
 * nirgends an.
 *
 * SIE FAEHRT NUR DEN SEITENINHALT (`#main-content`). Die Shell ist auf jeder
 * Route dieselbe; ein Befund dort kaeme sechzehnmal.
 *
 * EIN TRAEGER OHNE ZIEL VERSCHLUCKT KEINEN KLICK - es ist keines da. Gemessen
 * an den Settings-Blaettern: die Einladungs- und die Token-Liste
 * (`ul.settings-members`) bekommen ihren delegierenden Listener beim Aufbau der
 * Seite, ihre Zeilen kommen per API danach. Wo der Seed keine liefert, steht
 * dort ein einzelnes `<p class="form-hint">` mit „noch nichts vorhanden" - und
 * die Sonde meldete eine Tastatur-Sackgasse, obwohl jede echte Zeile ihren
 * eigenen Knopf traegt (`button.row-action`) und die Delegation genau richtig
 * gebaut ist. Der Unterschied ist nicht Timing, sondern Bedeutung: ein
 * Sackgassen-Befund braucht etwas, das in der Sackgasse steht.
 *
 * GEPRUEFT WIRD DIE FORM, NICHT DIE KLASSE. Ein Guard auf `.empty-state` oder
 * `.form-hint` faende nur, wer den Namen schon traegt (die Session-8-Lehre).
 * Die Form eines Leerzustands ist: gar kein Kind, oder GENAU EIN kinderloses
 * Element mit Text darin. Alles andere - eine Zeile, ein Raster, irgendetwas
 * mit Struktur - bleibt ein Befund.
 *
 * KOSTEN: rund eine Minute. Sie nimmt `visitViews` NICHT - aus demselben Grund
 * wie Sonde 8: die Verdrahtung einer Liste haengt an ihrem Modul, nicht an der
 * Sicht, und die 16 Routen erreichen jedes Modul einmal.
 */
async function keyboardlessClickTargets(page) {
  const cdp = await page.createCDPSession();
  try {
    // DOMDebugger hat kein `enable` - die Domain ist ohne Aktivierung nutzbar.
    await cdp.send('DOM.enable');
    await cdp.send('Runtime.enable');

    const { result } = await cdp.send('Runtime.evaluate', {
      expression: `
        (() => {
          const scope = document.querySelector('#main-content') || document.body;
          window.__kbCandidates = [...scope.querySelectorAll('*')].filter((el) => {
            const r = el.getBoundingClientRect();
            const cs = getComputedStyle(el);
            return r.width > 0 && r.height > 0 && cs.visibility !== 'hidden'
              && !el.closest('[hidden],[aria-hidden="true"]');
          });
          return window.__kbCandidates.length;
        })()
      `,
      returnByValue: true,
    });

    const findings = [];
    // Der Reichweiten-Nachweis dieser Sonde: NICHT die besuchten Routen, sondern
    // die Elemente, aus denen hier ueberhaupt ein Finding entstehen kann. Das
    // sind die mit einem click-Listener - alles davor ist Vorauswahl, alles
    // danach Freispruch. Degradiert der CDP-Pfad (DOMDebugger weg, Handles tot),
    // bleibt `withClick` null, waehrend `result.value` und die Routenzahl
    // unveraendert aussehen.
    let withClick = 0;
    for (let i = 0; i < result.value; i += 1) {
      const { result: handle } = await cdp.send('Runtime.evaluate', { expression: `window.__kbCandidates[${i}]` });
      try {
        const { listeners } = await cdp.send('DOMDebugger.getEventListeners', { objectId: handle.objectId, depth: 0 });
        if (!listeners.some((l) => l.type === 'click')) continue;
        withClick += 1;
        const hasKeyListener = listeners.some((l) => l.type === 'keydown' || l.type === 'keypress');

        const { result: meta } = await cdp.send('Runtime.callFunctionOn', {
          objectId: handle.objectId,
          returnByValue: true,
          functionDeclaration: `function () {
            const native = this.matches('a[href],button,input,select,textarea,summary,[contenteditable]');
            const tabindex = this.getAttribute('tabindex');
            return {
              tag: this.tagName.toLowerCase(),
              cls: (typeof this.className === 'string' ? this.className : '').trim().slice(0, 60),
              focusable: native || (tabindex !== null && Number(tabindex) >= 0),
              delegates: Boolean(this.querySelector('a[href],button,input,select,textarea,summary,[tabindex]:not([tabindex="-1"])')),
              // Ein Traeger OHNE ZIEL verschluckt keinen Klick - es ist keines
              // da. Siehe den Absatz "Ein Traeger ohne Ziel" im Sondenkommentar.
              // Zwei Formen, beide gemessen: gar kein Kind, oder genau ein
              // kinderloses Textelement (der Leerzustand).
              targetless: this.childElementCount === 0
                || (this.childElementCount === 1
                  && this.firstElementChild.childElementCount === 0
                  && this.firstElementChild.textContent.trim().length > 0),
            };
          }`,
        });
        const el = meta.value;
        if (el.focusable || hasKeyListener || el.delegates || el.targetless) continue;
        findings.push(`<${el.tag}${el.cls ? ` class="${el.cls}"` : ''}>`);
      } finally {
        await cdp.send('Runtime.releaseObject', { objectId: handle.objectId });
      }
    }
    return { findings, withClick };
  } finally {
    await cdp.detach();
  }
}

test('Sonde 11 - was einen Klick annimmt, nimmt auch eine Taste an', async () => {
  const findings = [];
  let seen = 0;
  let withClick = 0;

  const routes = sweep('Sonde 11');
  const page = await openPage(harness, { device: 'desktop', theme: 'light', locale: 'de' });
  for (const name of routes) {
    await gotoRoute(page, ALL_ROUTES[name]);
    await settleAnimations(page);
    seen += 1;
    const probed = await keyboardlessClickTargets(page);
    withClick += probed.withClick;
    for (const el of probed.findings) {
      findings.push(`${name}: ${el}`);
    }
  }
  await page.close();

  // Eine Sonde, die nichts gesehen hat, darf nicht urteilen - und „gesehen" heisst
  // hier nicht „besucht". Der Routenzaehler steht VOR der Messung: er haelt auch
  // dann, wenn die CDP-Schleife in `keyboardlessClickTargets()` nie laeuft.
  // Deshalb steht der zweite Nachweis daneben, und der zaehlt in der Messung.
  assert.equal(seen, routes.length, `Nur ${seen} von ${routes.length} Zustaenden gesehen.`);
  assert.ok(withClick >= 250,
    `Nur ${withClick} Elemente mit click-Listener gefunden - der CDP-Pfad misst nicht `
    + '(DOMDebugger.getEventListeners tot, Handles nicht aufloesbar?), statt nichts zu finden.');

  assert.deepEqual(findings, [],
    'Element mit click-Listener, ohne eigenen Tastaturzugang UND ohne inneres Bedienelement, '
    + 'an das es delegieren koennte - hier endet der Klick und die Tastatur kommt nicht an '
    + '(WCAG 2.1.1, Level A).\n  '
    + findings.join('\n  '));
});

/* ────────────────────────────────────────────────────────────────────────────
 * Sonde 12: die Glas-Familie - wo Glas sitzt, und was ohne es bleibt
 *
 * Zwei Regeln, eine Sonde, weil beide dieselbe Menge brauchen: alle Flaechen,
 * die im Dokument `backdrop-filter` tragen.
 *
 * (F) DIE GLAS-IST-CHROME-REGEL. Der Architektur-Audit mass 54
 *     `backdrop-filter`-Instanzen, ausnahmslos an Navigation und Knoepfen -
 *     gemessen, gestimmt, nie abgesichert. Im STYLESHEET ist die Aussage nicht
 *     scharf: ob ein Selektor Chrome oder Inhalt adressiert, weiss erst das
 *     Dokument. Hier ist sie es: liegt das Element innerhalb von
 *     `#main-content`, ist es Inhalt.
 *
 *     WAS DIE ROT-PROBE ANS LICHT BRACHTE, und es ist der eigentliche Befund:
 *     ein eingebauter Verstoss (`backdrop-filter` auf `.list-rows`) liess die
 *     Sonde GRUEN. Der Grund ist `.app-content *` in glass.css - eine
 *     Blanket-Regel, die `backdrop-filter` im Scroll-Container mit
 *     `!important` abraeumt. Sie steht dort NICHT wegen dieser Regel, sondern
 *     gegen den Blank-Screen-Bug (#166, iOS/Android-Compositor). Erst mit
 *     `!important` im Verstoss wurde die Sonde rot.
 *     Die Glas-ist-Chrome-Regel wird im Dokument also von einer Regel
 *     getragen, die es aus einem ganz anderen Grund gibt. Solange beide
 *     bestehen, ist sie doppelt gesichert; faellt die
 *     Compositor-Gegenmassnahme irgendwann weg, ist diese Sonde die einzige,
 *     die es merkt. Genau deshalb bleibt sie stehen, obwohl sie heute nur
 *     bestaetigt.
 *
 *     ZWEITE EBENE (2026-08-08), und sie kann rot werden, wo die erste es nie
 *     kann: `declaredGlassInMain()` liest das CSSOM statt der berechneten
 *     Werte, sieht also, was GESCHRIEBEN steht, bevor `.app-content *` es
 *     abraeumt. Damit ist die Rot-Probe von oben nicht mehr auf ein
 *     `!important` im Verstoss angewiesen.
 *
 *     SIE HAT BEIM ERSTEN LAUF SOFORT ETWAS GEFUNDEN, und der Befund war
 *     groesser als die Glas-Regel: `.fab-action__btn` und `.fab-action__label`
 *     deklarierten Glas und lagen in `#main-content`. Sie waren kein verirrtes
 *     Glas im Inhalt - sie waren CHROME AM FALSCHEN ORT. Das Dashboard baute
 *     seinen Speed-Dial als eigenen `.fab-container` und hatte gar keine
 *     `.page-fab`; `adoptPageFab()` in router.js sucht aber genau die, um den
 *     FAB in die Shell-Layer `#fab-layer` zu ziehen. Die Haertung aus #634
 *     griff auf der Startseite also nicht.
 *
 *     DIE SONDE BLIEB ROT, BIS DER ANLASS FIEL, statt sich eine Dauerausnahme
 *     zu geben: der Dial ist seit dem Folgevorgang zu #634 eine
 *     `.page-fab-group` mit einem `.page-fab` darin, sein Glas sitzt in der
 *     Shell, und die benannte Ausnahme ist ersatzlos entfallen. Was hier
 *     bleibt, ist die Lehre - eine Ausnahme braucht ein Verfallsdatum an
 *     BEIDEN Enden, am Anlass wie am Verstoss.
 *
 * (B) DIE FALLBACK-REGEL, ihre zweite Haelfte. `jeder Blur kommt aus der
 *     --blur-Skala` (Ebene 3) sichert, dass jede Glasflaeche einen Blur nimmt,
 *     der unter `prefers-reduced-transparency` und `prefers-contrast: more` auf
 *     `blur(0px)` kippt. Was er NICHT sehen kann, ist, ob die Regel im DOKUMENT
 *     ankommt - „im Stylesheet vorhanden, im Dokument wirkungslos" ist derselbe
 *     Fehlertyp wie B-13, und der Handoff notiert ihn seit dem Architektur-Audit
 *     als bekannte Pruefluecke.
 *
 *     GEPRUEFT WIRD NICHT NUR DER BLUR, SONDERN DIE DECKKRAFT. Ein Blur, der
 *     ausgeht, ist die halbe Regel; die andere Haelfte entscheidet ueber
 *     Lesbarkeit. Eine Glasflaeche ohne Blur, die weiter halbdurchsichtig ist,
 *     laesst den Inhalt darunter UNVERWISCHT durchscheinen - der Text davor
 *     steht dann vor allem, was gerade vorbeiscrollt, und sein Kontrast ist
 *     keine Zahl mehr, sondern eine Wette. Genau deshalb kippt tokens.css unter
 *     beiden Zustaenden die `--glass-bg-*` auf `--color-surface`-Werte. Ob das
 *     ankommt, sieht nur das Dokument.
 *
 * KEINE TOLERANZ, und das ist der Grund, warum diese zwei Fragen gebaut sind
 * und die Konzentrik-Frage nicht: „liegt drin" und „Alpha ist 1" sind scharf.
 *
 * DER MEDIENZUSTAND KOMMT UEBER CDP, NICHT UEBER PUPPETEER.
 * `page.emulateMediaFeatures` fuehrt eine Allowlist und kennt
 * `prefers-reduced-transparency` nicht (`Unsupported media feature`) - was den
 * Handoff-Vorschlag „Puppeteer kann beide Medienzustaende emulieren" fuer
 * genau den Zustand widerlegt, um den es hier geht. `Emulation.setEmulatedMedia`
 * kann es, und die Sonde prueft mit `matchMedia`, dass der Zustand wirklich
 * anliegt, statt ihn anzunehmen.
 *
 * SIE FAEHRT DIE 16 ROUTEN, NICHT DIE BLAETTER - siehe LEAVES_SKIPPED.
 * ──────────────────────────────────────────────────────────────────────────── */

/** Setzt einen Medienzustand ueber CDP und belegt, dass er anliegt. */
async function withMedia(page, features) {
  const cdp = await page.createCDPSession();
  await cdp.send('Emulation.setEmulatedMedia', { features });
  const applied = await page.evaluate(
    (list) => list.map((f) => matchMedia(`(${f.name}: ${f.value})`).matches),
    features,
  );
  return { cdp, applied };
}

/**
 * Jede Flaeche, deren GRUND aus einem `--glass-bg-*`-Token kommt.
 *
 * DAS TOKEN IST DIE SIGNATUR, nicht `backdrop-filter`. Die Fallback-Regel sagt
 * woertlich: `prefers-reduced-transparency` kippt „alle Glas-Tokens auf
 * --color-surface-Werte" - sie spricht also ueber die Flaechen, die ihren Grund
 * von dort beziehen, nicht ueber alles, was einen Blur traegt.
 *
 * Der Unterschied ist gemessen und kein Detail: die erste Fassung fragte nach
 * `backdrop-filter` und meldete elf FABs, die unter beiden Zustaenden bei
 * alpha 0,78 bleiben. Das ist kein Verstoss, sondern ihre Bauart - ein
 * `.page-fab` traegt seine MODULFARBE zu 78 % und keinen Glasgrund; sein
 * `backdrop-filter` ist ein Specular, kein Lesegrund. Die Regel meinte ihn nie.
 */
async function glassBackedSurfaces(page) {
  return page.evaluate(() => {
    const path3 = (el) => {
      const parts = [];
      for (let n = el; n && n.nodeType === 1 && parts.length < 3; n = n.parentElement) {
        let s = n.tagName.toLowerCase();
        if (n.id) { parts.unshift(`${s}#${n.id}`); break; }
        const cls = (typeof n.className === 'string' ? n.className : '').trim().split(/\s+/).filter(Boolean).slice(0, 2);
        if (cls.length) s += `.${cls.join('.')}`;
        parts.unshift(s);
      }
      return parts.join(' > ');
    };
    const selectors = new Set();
    const walk = (rules) => {
      for (const rule of rules) {
        // `rule.cssRules` ist seit CSS Nesting KEIN Verzweigungskriterium mehr:
        // jede CSSStyleRule traegt eine leere CSSRuleList, und die ist truthy.
        if (rule.cssRules?.length) { walk(rule.cssRules); continue; }
        if (!rule.style || !rule.selectorText) continue;
        if (/background(-color)?:[^;]*var\(--glass-bg-/.test(rule.cssText)) selectors.add(rule.selectorText);
      }
    };
    for (const sheet of document.styleSheets) {
      try { walk(sheet.cssRules); } catch { /* fremde Herkunft - hier gibt es keine */ }
    }

    const out = [];
    const seen = new Set();
    for (const selector of selectors) {
      let hits = [];
      try { hits = [...document.querySelectorAll(selector)]; } catch { continue; }
      for (const el of hits) {
        if (seen.has(el)) continue;
        seen.add(el);
        const cs = getComputedStyle(el);
        const r = el.getBoundingClientRect();
        if (r.width < 2 || r.height < 2) continue;
        if (cs.visibility === 'hidden' || cs.display === 'none') continue;
        const bf = cs.backdropFilter && cs.backdropFilter !== 'none' ? cs.backdropFilter : cs.webkitBackdropFilter;
        const blur = [...String(bf || '').matchAll(/blur\(\s*([\d.]+)px\s*\)/g)].map((m) => Number(m[1])).filter((v) => v > 0);
        out.push({ sel: path3(el), blur: blur.length ? Math.max(...blur) : 0, bg: cs.backgroundColor });
      }
    }
    return out;
  });
}

/** Jede Flaeche, die Glas traegt - samt Ort im Baum und Deckkraft. */
/**
 * Jede Flaeche, an der eine Regel Glas DEKLARIERT - unabhaengig davon, ob es
 * ankommt.
 *
 * `glassSurfaces()` liest `getComputedStyle`, und genau dort kann die
 * Glas-ist-Chrome-Regel nie rot werden: `.app-content *` in glass.css raeumt
 * `backdrop-filter` im Scroll-Container mit `!important` ab (gegen den
 * Blank-Screen-Bug #166), und `#main-content` IST `.app-content`. Jeder
 * Nachfahre kommt als `none` heraus, also ist `inMain` fuer nichts wahr - der
 * eingebaute Verstoss der Rot-Probe blieb deshalb gruen.
 *
 * Diese Ebene liest stattdessen das CSSOM: sie sieht, was JEMAND GESCHRIEBEN
 * hat. Ein Glas, das in den Seiteninhalt geschrieben und nur von einer fremden
 * Gegenmassnahme neutralisiert wird, ist der Verstoss, den die Regel meint - er
 * wirkt in dem Moment, in dem das Element aus `.app-content` wandert oder die
 * Compositor-Regel faellt. Beide Ebenen zusammen: die eine wacht ueber den
 * Effekt, die andere ueber die Absicht.
 */
async function declaredGlassInMain(page) {
  return page.evaluate(() => {
    const selectors = new Set();
    const walk = (rules) => {
      for (const rule of rules) {
        // Wie in glassBackedSurfaces: `rule.cssRules` ist seit CSS Nesting kein
        // Verzweigungskriterium, jede CSSStyleRule traegt eine leere Liste.
        if (rule.cssRules?.length) { walk(rule.cssRules); continue; }
        if (!rule.style || !rule.selectorText) continue;
        // Ueber cssText und nicht ueber rule.style.backdropFilter: die App
        // schreibt den Blur als TOKEN (`backdrop-filter: var(--blur-md)
        // saturate(120%)`), nie als Literal. Ein Muster auf `blur(Npx)` fand
        // deshalb null Regeln - der Reichweiten-Nachweis unten hat genau das
        // beim ersten Lauf gemeldet.
        const declared = /backdrop-filter:\s*([^;}]+)/i.exec(rule.cssText)?.[1] ?? '';
        if (/^\s*none\s*$/i.test(declared)) continue;          // das Abraeumen selbst
        const viaToken = /var\(\s*--blur-/.test(declared);
        const viaLiteral = [...declared.matchAll(/blur\(\s*([\d.]+)px\s*\)/g)].some((m) => Number(m[1]) > 0);
        if (!viaToken && !viaLiteral) continue;                 // u.a. blur(0px)
        selectors.add(rule.selectorText);
      }
    };
    for (const sheet of document.styleSheets) {
      try { walk(sheet.cssRules); } catch { /* fremde Herkunft - hier gibt es keine */ }
    }

    const main = document.querySelector('#main-content');
    const out = [];
    for (const selector of selectors) {
      let hits = [];
      try { hits = [...document.querySelectorAll(selector)]; } catch { continue; }
      // Das Abraeum-Ziel selbst ist kein Verstoss: `.app-content` traegt die
      // Regel, es liegt nicht IN ihr.
      if (main && hits.some((el) => el !== main && main.contains(el))) out.push(selector);
    }
    return { selectorsSeen: selectors.size, offenders: out };
  });
}

async function glassSurfaces(page) {
  return page.evaluate(() => {
    const path3 = (el) => {
      const parts = [];
      for (let n = el; n && n.nodeType === 1 && parts.length < 3; n = n.parentElement) {
        let s = n.tagName.toLowerCase();
        if (n.id) { parts.unshift(`${s}#${n.id}`); break; }
        const cls = (typeof n.className === 'string' ? n.className : '').trim().split(/\s+/).filter(Boolean).slice(0, 2);
        if (cls.length) s += `.${cls.join('.')}`;
        parts.unshift(s);
      }
      return parts.join(' > ');
    };
    const main = document.querySelector('#main-content');
    const out = [];
    for (const el of document.querySelectorAll('*')) {
      const cs = getComputedStyle(el);
      const bf = cs.backdropFilter && cs.backdropFilter !== 'none' ? cs.backdropFilter : cs.webkitBackdropFilter;
      if (!bf || bf === 'none') continue;
      const r = el.getBoundingClientRect();
      if (r.width < 2 || r.height < 2) continue;
      if (cs.visibility === 'hidden' || cs.display === 'none') continue;
      // Ein Blur mit einem Wert > 0 - `blur(0px)` ist der abgeschaltete Zustand
      // und kein Verstoss.
      const blur = [...bf.matchAll(/blur\(\s*([\d.]+)px\s*\)/g)].map((m) => Number(m[1])).filter((v) => v > 0);
      out.push({
        sel: path3(el),
        inMain: Boolean(main && main.contains(el)),
        blur: blur.length ? Math.max(...blur) : 0,
        bg: cs.backgroundColor,
      });
    }
    return out;
  });
}

test('Sonde 12 - Glas sitzt auf Chrome, nie im Seiteninhalt', async () => {
  const findings = [];
  const declaredFindings = [];
  const seen = new Set();
  let declaredSeen = 0;
  for (const device of ['mobile', 'desktop']) {
    const page = await openPage(harness, { device, theme: 'light', locale: 'de' });
    for (const name of sweep('Sonde 12')) {
      await gotoRoute(page, ALL_ROUTES[name]);
      await settleAnimations(page);
      // Ebene 1 - der EFFEKT. Sie bestaetigt heute nur (siehe Kopf): die
      // Compositor-Gegenmassnahme raeumt jeden backdrop-filter im Scrollport ab.
      // Sie bleibt, weil sie die einzige ist, die es merkt, wenn diese Regel faellt.
      for (const g of await glassSurfaces(page)) {
        seen.add(g.sel);
        if (g.inMain) findings.push(`${device}/${name}: ${g.sel}`);
      }
      // Ebene 2 - die ABSICHT. Sie kann rot werden, wo Ebene 1 es nie kann.
      const declared = await declaredGlassInMain(page);
      declaredSeen = Math.max(declaredSeen, declared.selectorsSeen);
      // Ohne Ausnahmen. Die eine, die es hier gab, hatte einen Anlass - der
      // Speed-Dial des Dashboards stand als `.fab-container` im Scrollport - und
      // ist mit ihm entfallen (Folgevorgang zu #634): der Dial ist jetzt eine
      // `.page-fab-group`, `adoptPageFab()` hebt ihn samt Glas in die Shell.
      for (const sel of declared.offenders) declaredFindings.push(`${device}/${name}: ${sel}`);
    }
    await page.close();
  }
  // Eine Sonde, die nichts gesehen hat, darf nicht urteilen - je Ebene einzeln,
  // sonst deckt der Reichweiten-Nachweis der einen die Blindheit der anderen zu.
  assert.ok(seen.size >= 5,
    `Nur ${seen.size} Glasflaechen im Dokument gesehen - Ebene 1 hat nichts gemessen.`);
  assert.ok(declaredSeen >= 5,
    `Nur ${declaredSeen} Regeln mit deklariertem Blur gefunden - Ebene 2 hat nichts gemessen. `
    + 'Traegt das CSSOM die Regeln noch, oder ist die Blur-Schreibweise eine andere?');

  assert.deepEqual([...findings, ...declaredFindings], [],
    'backdrop-filter INNERHALB von #main-content. Glas ist Chrome: Tab-Bar, Sidebar, Sheets, '
    + 'Toast, Datepicker-Popover, FAB samt Backdrop. Inhalte - Karten, Listen, Widgets, Text - '
    + 'sind opak (Die Glas-ist-Chrome-Regel).\n'
    + 'Treffer aus der zweiten Ebene sind DEKLARIERT und heute womoeglich wirkungslos, weil '
    + '`.app-content *` sie mit !important abraeumt - sie wirken, sobald das Element aus dem '
    + `Scrollport wandert oder jene Regel faellt.\n  ${[...findings, ...declaredFindings].join('\n  ')}`);
});

for (const [label, features] of [
  ['reduzierter Transparenz', [{ name: 'prefers-reduced-transparency', value: 'reduce' }]],
  ['erhoehtem Kontrast', [{ name: 'prefers-contrast', value: 'more' }]],
]) {
  test(`Sonde 12 - unter ${label} bleibt keine Glasflaeche durchsichtig`, async () => {
    const page = await openPage(harness, { device: 'mobile', theme: 'light', locale: 'de' });
    const { cdp, applied } = await withMedia(page, [
      { name: 'prefers-color-scheme', value: 'light' },
      ...features,
    ]);
    // Der Zustand wird BELEGT, nicht angenommen: eine Emulation, die still
    // nicht greift, macht diese Sonde gruen und blind zugleich.
    assert.ok(applied.every(Boolean),
      `Der Medienzustand liegt nicht an (${JSON.stringify(applied)}) - die Sonde misst den Normalfall.`);

    const findings = [];
    let blurred = 0;
    let backed = 0;
    for (const name of sweep('Sonde 12')) {
      await gotoRoute(page, ALL_ROUTES[name]);
      await settleAnimations(page);
      // (1) KEIN wirksamer Blur mehr - ueber alles, was `backdrop-filter` traegt.
      for (const g of await glassSurfaces(page)) {
        blurred += 1;
        if (g.blur > 0) findings.push(`${name}: ${g.sel} traegt weiter blur(${g.blur}px)`);
      }
      // (2) Und die Flaechen, deren GRUND ein Glas-Token ist, sind opak.
      for (const g of await glassBackedSurfaces(page)) {
        backed += 1;
        const alpha = parseColor(g.bg)[3];
        if (alpha < 1) {
          findings.push(`${name}: ${g.sel} bleibt durchsichtig (alpha ${alpha.toFixed(2)}) - `
            + 'ohne Blur scheint der Inhalt darunter unverwischt durch');
        }
      }
    }
    await cdp.detach();
    await page.close();

    assert.ok(blurred > 0, 'Keine Glasflaeche gesehen - die Sonde hat nichts gemessen.');
    assert.ok(backed > 0, 'Keine Flaeche mit Glas-Grund gesehen - die CSSOM-Suche greift nicht mehr.');
    assert.deepEqual(findings, [],
      `Die Fallback-Regel kommt im Dokument nicht an (${label}). Das Stylesheet kippt `
      + '--blur-2xs..lg auf blur(0px) und die --glass-bg-* auf --color-surface-Werte; '
      + `gemessen wird, ob das die Flaeche erreicht.\n  ${findings.join('\n  ')}`);
  });
}

/* ────────────────────────────────────────────────────────────────────────────
 * Sonde 13: die Modals - die Formulare der App, die keine Sonde je gesehen hat
 *
 * DIE REICHWEITENLUECKE. Alle zwoelf Sonden davor messen ROUTEN. Ein Modal ist
 * keine Route - es kommt auf Klick, und dort stehen die Formulare: 20
 * unterscheidbare Dialoge mit 2 bis 12 Feldern und 3 bis 17 Knoepfen. Das ist
 * dieselbe Klasse Luecke wie die 23 Settings-Blaetter vor Session 22, nur eine
 * Ebene tiefer - und der Ort, an dem jede neue Funktion ihr Feld einbaut.
 *
 * DER WEG HINEIN IST DER FAB, weil er der einzige app-weite ist
 * (`findPageFab()`, seit #634 in der Shell-Layer). Vier Module haben keinen,
 * der ein Modal oeffnet, und Einstellungen hat gar keinen - die Sonde
 * ueberspringt sie und sagt es im Reichweiten-Beleg, statt sie stillschweigend
 * zu zaehlen.
 *
 * SIE PRUEFT NICHT DIE DOKUMENTSTRUKTUR, und das ist kein Versehen: ein Modal
 * liegt IM Dokument, das seine `h1`, seine `main`-Landmarke und seinen Titel
 * schon hat. Sonde 10 wuerde dort dreimal dasselbe melden. Was im Modal NEU
 * ist, sind Formularfelder, und die haben ihre eigene Regel (WCAG 3.3.2,
 * Level A).
 *
 * DIE ZWEI FILTER SIND DER UNTERSCHIED ZWISCHEN EINEM BEFUND UND 32
 * FEHLTREFFERN. Beim Messen meldete die erste Fassung 32 Felder ohne Label.
 * Keines davon war eines: der Datepicker haelt ein `input[type=date]` mit
 * `tabindex="-1" aria-hidden="true"` vor, das nur den nativen Picker oeffnet,
 * und der Foto-Upload ist ein `.sr-only`-Feld hinter einem Knopf mit
 * `aria-label`. Beide sind fuer die Zugaenglichkeitsschicht unsichtbar und
 * brauchen kein Label. Sonde 10 filtert genau diese zwei seit jeher.
 *
 * DIE REICHWEITE WIRD BELEGT, NICHT GEZAEHLT (die Sonde-10-Lehre): geprueft
 * wird, dass die geoeffneten Modals sich UNTERSCHEIDEN. Zwei Module, die
 * denselben Titel mit derselben Feld- und Knopfzahl liefern, waeren ein
 * Verdacht auf einen Dialog, der ueberall derselbe ist.
 * ──────────────────────────────────────────────────────────────────────────── */

async function openFabModal(page) {
  return page.evaluate(async () => {
    const wait = (ms) => new Promise((r) => setTimeout(r, ms));
    // Ein Selektor genuegt seit dem Folgevorgang zu #634: auch der Speed-Dial
    // des Dashboards ist ein `.page-fab` und haengt in der Shell-Layer.
    const fab = document.querySelector('#fab-layer .page-fab, .page-fab');
    if (!fab) return { skipped: 'kein FAB' };
    fab.click();
    await wait(700);
    // Ein FAB oeffnet entweder ein Modal ODER ein Aktionsmenue.
    let panel = document.querySelector('.modal-panel');
    if (!panel) {
      const action = document.querySelector('.fab-action__btn, .fab-actions button');
      if (!action) return { skipped: 'kein Modal und kein Aktionsmenue' };
      action.click();
      await wait(700);
      panel = document.querySelector('.modal-panel');
    }
    if (!panel) return { skipped: 'Aktionsmenue oeffnete kein Modal' };

    const path3 = (el) => {
      const parts = [];
      for (let n = el; n && n.nodeType === 1 && parts.length < 3; n = n.parentElement) {
        let s = n.tagName.toLowerCase();
        if (n.id) { parts.unshift(`${s}#${n.id}`); break; }
        const cls = (typeof n.className === 'string' ? n.className : '').trim().split(/\s+/).filter(Boolean).slice(0, 2);
        if (cls.length) s += `.${cls.join('.')}`;
        parts.unshift(s);
      }
      return parts.join(' > ');
    };
    // Dieselben zwei Ausnahmen wie in Sonde 10 - siehe Sondenkommentar.
    const vis = (el) => {
      if (el.closest('[aria-hidden="true"], .sr-only')) return false;
      const r = el.getBoundingClientRect();
      const cs = getComputedStyle(el);
      return r.width > 1 && r.height > 1 && cs.visibility !== 'hidden' && cs.display !== 'none';
    };

    const fields = [...panel.querySelectorAll('input:not([type=hidden]), select, textarea')].filter(vis);
    const targets = [...panel.querySelectorAll('button, [role="button"], a[href], input[type=checkbox], input[type=radio], select')].filter(vis);
    const min = window.innerWidth < 768 ? 44 : 24;

    return {
      title: (panel.querySelector('.modal-panel__title, h2, h3')?.textContent || '').trim().slice(0, 40),
      fields: fields.length,
      targets: targets.length,
      unlabelled: fields.filter((el) => {
        const lab = (el.id && document.querySelector(`label[for="${CSS.escape(el.id)}"]`)) || el.closest('label');
        return !lab && !el.getAttribute('aria-label') && !el.getAttribute('aria-labelledby');
      }).map((el) => `${path3(el)} (${el.getAttribute('type') || el.tagName.toLowerCase()})`),
      badRefs: [...panel.querySelectorAll('[aria-labelledby],[aria-describedby],[aria-controls]')].flatMap((el) =>
        ['aria-labelledby', 'aria-describedby', 'aria-controls'].flatMap((attr) => {
          const v = el.getAttribute(attr);
          if (!v) return [];
          const missing = v.split(/\s+/).filter((id) => id && !document.getElementById(id));
          return missing.length ? [`${path3(el)} ${attr}="${missing.join(' ')}"`] : [];
        })),
      small: targets.filter((el) => {
        const r = el.getBoundingClientRect();
        // DAS LABEL IST DAS ZIEL, nicht die Checkbox darin - dieselbe
        // HTML-Beziehung, die Sonde 4 in Session 22 gekostet hat. Ohne sie
        // meldet diese Sonde die vier 20x20-Haken der Mahlzeitentypen im
        // Rezept-Modal, die in einem `label.form-check` ueber die volle
        // Zeilenbreite sitzen. Gesucht wird die BEZIEHUNG (`label.control`),
        // nicht eine Klasse.
        const label = el.closest('label') ?? (el.id ? document.querySelector(`label[for="${CSS.escape(el.id)}"]`) : null);
        const box = label && (label.control === el || label.contains(el)) ? label.getBoundingClientRect() : r;
        const w = Math.max(r.width, box.width);
        const h = Math.max(r.height, box.height);
        return w < min && h < min;
      }).map((el) => {
        const r = el.getBoundingClientRect();
        return `${path3(el)} ${Math.round(r.width)}x${Math.round(r.height)} (min ${min})`;
      }),
    };
  });
}

test('Sonde 13 - die Formulare hinter dem FAB halten dieselbe Grundlage wie die Seiten', async () => {
  const findings = [];
  const shapes = new Set();
  let opened = 0;
  const skipped = [];

  for (const device of ['mobile', 'desktop']) {
    const page = await openPage(harness, { device, theme: 'light', locale: 'de' });
    for (const name of sweep('Sonde 13')) {
      await gotoRoute(page, ALL_ROUTES[name]);
      await settleAnimations(page);
      const r = await openFabModal(page);
      if (r.skipped) { skipped.push(`${device}/${name}: ${r.skipped}`); continue; }
      opened += 1;
      shapes.add(`${device}|${r.title}|${r.fields}|${r.targets}`);
      const at = `${device}/${name} „${r.title}"`;
      for (const f of r.unlabelled) findings.push(`${at}: Eingabefeld ohne Label - ${f}`);
      for (const b of r.badRefs) findings.push(`${at}: ARIA-Verweis ins Leere - ${b}`);
      for (const s of r.small) findings.push(`${at}: Zielgroesse unter dem Minimum - ${s}`);
    }
    await page.close();
  }

  // Die REICHWEITE wird belegt, nicht gezaehlt: eine Sonde, die 22-mal
  // denselben Dialog oeffnet, waere gruen und haette nichts gesehen.
  assert.ok(opened >= 18, `Nur ${opened} Modals geoeffnet (uebersprungen: ${skipped.join(', ')}).`);
  assert.ok(shapes.size >= 16,
    `${opened} Modals geoeffnet, aber nur ${shapes.size} unterscheidbare - die Sonde misst `
    + 'moeglicherweise mehrfach denselben Dialog.');

  assert.deepEqual(findings, [],
    'Befund in einem Modal. Dort stehen die Formulare der App, und bis Session 23 hat sie '
    + 'keine Sonde gesehen - ein Feld ohne Label ist WCAG 3.3.2 (Level A).\n  '
    + findings.join('\n  '));
});

/* ────────────────────────────────────────────────────────────────────────────
 * Sonde 14: ein Icon auf getoentem Grund haelt 3:1
 *
 * DIE LUECKE, DIE PAKET 5 WIRKLICH HAT. Die Akzent-auf-Toenung-Konvention endet
 * mit einem Satz, der bisher auf KEINER Ebene einen Guard hatte: „NUR fuer
 * Text. Icons tragen weiter den vollen Akzent - dort gilt 3:1."
 *
 *   - Ebene 3 (`jede Regel, die Farbe UND Untergrund setzt`) ueberspringt
 *     `color-mix`-Untergruende ausdruecklich, und zu Recht: eine Toenung hat
 *     keinen Untergrund ohne die Flaeche darunter. Das sind 152 Regeln.
 *   - Sonde 2 misst TEXTKNOTEN. Ein `<svg>` hat keine, faellt also heraus.
 *
 * Ein Icon auf einer Toenung SEINER EIGENEN FARBE ist damit der eine Fall, den
 * beide Ebenen einander zuschieben - und es ist derselbe Fall, an dem Sonde 2
 * als „zu milde" notiert ist: die Tab-Bar-Pille traegt ein Icon, gemessen
 * 3.41:1 am Bild gegen 4.20:1 im Baum, also 0,41 Reserve auf die 3:1 fuer
 * grafische Objekte (WCAG 1.4.11). Ein Token-Wechsel rutschte dort unbemerkt
 * darunter, und genau davor schuetzt diese Sonde - nicht an einer Stelle,
 * sondern ueber jedes Icon der App.
 *
 * DIE GESCHWISTER-FLAECHE GEHOERT DAZU, UND NUR HIER. Sonde 2 komponiert die
 * VORFAHRENKETTE; eine Flaeche, die unter dem Icon liegt, ohne es zu enthalten
 * (die gleitende Pille ist ein Geschwister), faellt heraus. Ueber alle Texte
 * gemessen ist diese Signatur unbrauchbar - 221 Fundstellen, und die Mehrzahl
 * ist Glas ueber scrollendem Inhalt, wo es gar keinen festen Untergrund gibt
 * (`.impeccable/redesign-tools/overlap-probe.mjs`). Ueber ICONS ist sie eng:
 * gesucht wird eine Flaeche im SELBEN Container, die das Icon ueberlappt und
 * im Dokument vor ihm steht. Das ist die Bauform der Pille und nicht die einer
 * Bar ueber einem Scrollport.
 *
 * DEAKTIVIERTE UND DEKORATIVE ICONS SIND AUSGENOMMEN, beides Kategorien aus
 * dem Standard: WCAG 1.4.11 gilt fuer Objekte, die INFORMATION tragen, und
 * 1.4.3 nimmt Deaktiviertes aus.
 * ──────────────────────────────────────────────────────────────────────────── */

async function collectIconSamples(page) {
  return page.evaluate(() => {
    const path3 = (el) => {
      const parts = [];
      for (let n = el; n && n.nodeType === 1 && parts.length < 3; n = n.parentElement) {
        let s = n.tagName.toLowerCase();
        if (n.id) { parts.unshift(`${s}#${n.id}`); break; }
        const cls = (typeof n.className === 'string' ? n.className : n.className?.baseVal || '').trim().split(/\s+/).filter(Boolean).slice(0, 2);
        if (cls.length) s += `.${cls.join('.')}`;
        parts.unshift(s);
      }
      return parts.join(' > ');
    };

    // Alle gemalten Flaechen einmal einsammeln - fuer die Geschwister-Frage.
    const painted = [];
    for (const el of document.querySelectorAll('*')) {
      const cs = getComputedStyle(el);
      if (!cs.backgroundColor || cs.backgroundColor === 'rgba(0, 0, 0, 0)') continue;
      const r = el.getBoundingClientRect();
      if (r.width < 2 || r.height < 2) continue;
      if (cs.visibility === 'hidden' || cs.display === 'none') continue;
      painted.push({ el, r, bg: cs.backgroundColor });
    }

    const out = [];
    for (const icon of document.querySelectorAll('svg')) {
      // Dekoratives und Deaktiviertes nimmt der Standard aus.
      if (icon.closest('[aria-hidden="true"] > *') && !icon.closest('button, a[href], [role="button"]')) continue;
      if (icon.closest(':disabled, [aria-disabled="true"], .sr-only, yuvomi-install-prompt')) continue;
      const cs = getComputedStyle(icon);
      if (cs.visibility === 'hidden' || cs.display === 'none' || parseFloat(cs.opacity) < 0.5) continue;
      const r = icon.getBoundingClientRect();
      if (r.width < 6 || r.height < 6) continue;
      // Ein Icon ohne eigene Farbe erbt sie - dann ist es der Textfall, den
      // Sonde 2 schon misst.
      const stroke = cs.stroke && cs.stroke !== 'none' ? cs.stroke : null;
      const fill = cs.fill && cs.fill !== 'none' && cs.fill !== 'rgba(0, 0, 0, 0)' ? cs.fill : null;
      const ink = stroke || fill || cs.color;
      if (!ink) continue;

      // PSEUDOELEMENTE ZAEHLEN MIT. `.item-check` traegt seine gefuellte
      // Kastenflaeche in einem `::before` - das Element selbst hat
      // `background: none`, und eine Sonde, die nur echte Elemente kettet,
      // rechnet dort „weisses Haken auf weiss" (1.00:1) und meldet zwoelfmal
      // einen Verstoss, den es nicht gibt. Dieselbe Falle wie bei Sonde 4, wo
      // `.weather-widget__refresh` seine Trefferflaeche per `::before` dehnt:
      // in dieser App ist ein Pseudoelement regelmaessig der Traeger.
      const layers = [];
      for (let n = icon.parentElement; n; n = n.parentElement) {
        const ncs = getComputedStyle(n);
        for (const pseudo of ['::before', '::after']) {
          const ps = getComputedStyle(n, pseudo);
          if (!ps.content || ps.content === 'none') continue;
          if (!ps.backgroundColor || ps.backgroundColor === 'rgba(0, 0, 0, 0)') continue;
          // Nur was das Icon wirklich unterlegt - ein Pseudoelement daneben
          // (Badge, Punkt, Specular) ist kein Untergrund.
          const pr = { w: parseFloat(ps.width), h: parseFloat(ps.height) };
          if (!(pr.w >= r.width && pr.h >= r.height)) continue;
          layers.push({ bg: ps.backgroundColor, image: ps.backgroundImage });
        }
        layers.push({ bg: ncs.backgroundColor, image: ncs.backgroundImage });
      }

      // Die Geschwister-Flaeche: im selben Container, ueberlappend, im Dokument
      // VOR dem Icon - die Bauform der gleitenden Pille.
      let sibling = null;
      for (const p of painted) {
        if (p.el === icon || p.el.contains(icon) || icon.contains(p.el)) continue;
        if (!(p.r.left < r.right && p.r.right > r.left && p.r.top < r.bottom && p.r.bottom > r.top)) continue;
        if (!(p.el.compareDocumentPosition(icon) & Node.DOCUMENT_POSITION_FOLLOWING)) continue;
        // ENG, und das ist der ganze Zuschnitt: der gemeinsame Vorfahre liegt
        // hoechstens drei Ebenen ueber dem Icon UND die Flaeche ist sein
        // DIREKTES Kind. Das ist die Bauform der gleitenden Pille
        // (`.nav-bottom__items` > `.nav-bottom__indicator` neben
        // `a.nav-item` > `svg`) und nicht die einer Liste unter einem FAB:
        // dort ist der gemeinsame Vorfahre `#app`, und die erste Fassung liess
        // ihn durch, weil sie nur die Tiefe zaehlte und nicht die Bindung. Sie
        // legte daraufhin die Liste UEBER den FAB-Grund und meldete elf
        // Plus-Icons mit „#FFFFFF auf #FFFFFF".
        let depth = 0;
        let common = icon.parentElement;
        while (common && !common.contains(p.el) && depth < 3) { common = common.parentElement; depth += 1; }
        if (!common || !common.contains(p.el) || depth >= 3) continue;
        if (p.el.parentElement !== common) continue;
        sibling = { bg: p.bg, sel: path3(p.el) };
        break;
      }

      out.push({ sel: path3(icon), ink, layers, sibling });
    }
    return out;
  });
}

test('Sonde 14 - ein Icon auf getoentem Grund haelt 3:1', async () => {
  const findings = [];
  let seen = 0;
  let withSibling = 0;

  for (const theme of ['light', 'dark']) {
    for (const device of ['mobile', 'desktop']) {
      const page = await openPage(harness, { device, theme, locale: 'de' });
      const base = parseColor(
        await page.evaluate(() => getComputedStyle(document.documentElement).backgroundColor),
      );
      const pageBase = base[3] > 0 ? composite(base, [255, 255, 255]) : [255, 255, 255];
      for (const name of sweep('Sonde 14')) {
        await gotoRoute(page, ALL_ROUTES[name]);
        await settleAnimations(page);
        for (const s of await collectIconSamples(page)) {
          // Untergrund komponieren - dieselbe Mechanik wie Sonde 2, bis zur
          // ersten deckenden Ebene.
          let opaqueAt = s.layers.length - 1;
          for (let i = 0; i < s.layers.length; i += 1) {
            if (parseColor(s.layers[i].bg)[3] >= 1) { opaqueAt = i; break; }
          }
          let bg = pageBase;
          // DIE GESCHWISTER-FLAECHE LIEGT UNTER DER EIGENEN KETTE, nicht ueber
          // ihr - sie steht im Dokument VOR dem Icon und wird deshalb zuerst
          // komponiert. Die erste Fassung legte sie zuletzt auf und rechnete
          // damit den Grund des Icons weg.
          if (s.sibling) {
            withSibling += 1;
            const sib = parseColor(s.sibling.bg);
            if (sib[3] > 0) bg = composite(sib, bg);
          }
          let unpaintable = false;
          for (let i = opaqueAt; i >= 0; i -= 1) {
            if (/url\(/i.test(s.layers[i].image || '')) { unpaintable = true; break; }
            const layer = parseColor(s.layers[i].bg);
            if (layer[3] > 0) bg = composite(layer, bg);
          }
          if (unpaintable) continue;
          seen += 1;
          const fg = composite(parseColor(s.ink), bg);
          const ratio = contrastRatio(fg, bg);
          if (ratio + 0.005 < 3) {
            findings.push(
              `${name}/${theme}/${device}: ${ratio.toFixed(2)}:1 (soll 3)  ${toHex(fg)} auf ${toHex(bg)}  `
              + `${s.sel}${s.sibling ? `  [ueber ${s.sibling.sel}]` : ''}`,
            );
          }
        }
      }
      await page.close();
    }
  }

  assert.ok(seen >= 200, `Nur ${seen} Icons gemessen - die Sonde hat nichts gesehen.`);
  // Die Geschwister-Ergaenzung ist der Grund, aus dem es diese Sonde gibt.
  // Findet sie keinen einzigen Fall, misst sie dasselbe wie die Vorfahrenkette.
  assert.ok(withSibling > 0,
    'Keine einzige Geschwister-Flaeche gefunden - die Bauform, wegen der Sonde 2 an der '
    + 'Tab-Bar-Pille zu milde urteilt, wird nicht mehr erkannt.');

  assert.deepEqual(findings, [],
    `Icon unter 3:1 auf seinem komponierten Untergrund (WCAG 1.4.11, grafische Objekte; `
    + `${withSibling} davon auf einer Flaeche, die die Vorfahrenkette nicht sieht).\n  `
    + findings.join('\n  '));
});

/* ────────────────────────────────────────────────────────────────────────────
 * Sonde 15: Die Chrome-Regel
 *
 * Die Regel steht in DESIGN.md („Die Chrome-Regel"): UEBER DEM INHALT STEHEN
 * DER KOPF UND HOECHSTENS EINE BEDIENZEILE.
 *
 * WARUM DIESE EBENE UND KEINE ANDERE. Wie hoch ein Kopf BAUT, steht in keinem
 * Stylesheet - er ist ein Flex-Container, und ob sein Inhalt in eine Zeile
 * passt, entscheidet die Summe aus Titellaenge, Anzahl der Aktionen, Locale
 * und Viewport. Genau daran ist die erste Fassung der Regel gescheitert: sie
 * setzte `flex-wrap: nowrap` mit Spezifitaet 0,1,0 gegen eine Large-Title-Regel
 * mit 0,3,0 und blieb LAUTLOS wirkungslos - gemessen stand `wrap` danach auf
 * allen zehn Koepfen, und der Kalender baute weiter vier Zeilen. Ein Test ueber
 * den Quelltext haette die Zeile gefunden und fuer erledigt erklaert.
 *
 * WAS ALS ZEILE ZAEHLT, ENTSCHEIDET DIE UEBERLAPPUNG DER VERTIKALEN INTERVALLE,
 * NICHT DIE OBERKANTE. Denselben Satz fuehrt DESIGN.md beim Andocken, und hier
 * gilt er aus demselben Grund: mittig ausgerichtete Flex-Items unterschiedlicher
 * Hoehe beginnen bis zu 15px auseinander, ein Zaehler ueber Oberkanten meldet
 * fuer einen 63px hohen, unzweifelhaft einzeiligen Kopf also vier „Zeilen".
 * Gezaehlt werden deshalb disjunkte Cluster.
 *
 * DIE HOEHE ALLEIN WAR ZU MILDE, und das hat erst die Gegenprobe gezeigt. Die
 * erste Fassung erlaubte zwei Bar-Zeilen plus Trennlinie, also 128px. Mit dem
 * absichtlich wieder eingebauten Spezifitaetsfehler baute der Kalender 117px
 * und das Budget 113px - drei Zeilen, und trotzdem unter der Schwelle. Ein
 * Grenzwert, der den Anlassfall nicht faengt, ist kein Guard. Die Hoehe bleibt
 * als zweite, groebere Zusicherung stehen (sie faengt „eine Zeile, aber
 * riesig"), das Urteil faellt die Zeilenzahl.
 *
 * ZWEI ZEILEN SIND DIE GRENZE, und die zweite hat einen Namen: eine Tab-Leiste
 * IM Kopf (Gesundheit, Belohnungen, Haushaltshilfe) ist die eine erlaubte
 * Bedienzeile, und der Essensplan braucht seine Zeitraum-Navigation neben den
 * Aktionen (DESIGN.md, Modulkopf). Alles darueber ist eine dritte Zeile, und
 * die verbietet die Regel.
 * ──────────────────────────────────────────────────────────────────────────── */

/** Eine Bar-Zeile: Zielgroesse plus die Naht der kompakten Hoehe, oben und unten. */
const BAR_ROW = 48 + 2 * 4;
/** Zwei Bar-Zeilen plus die Trennlinie - mehr ist auch als EINE Zeile zu viel. */
const HEAD_MAX = 2 * BAR_ROW + 16;
/** Der Kopf und hoechstens eine Bedienzeile. */
const HEAD_ROWS_MAX = 2;

describe('Sonde 15 - in der kompakten Hoehe traegt der Kopf hoechstens eine Bedienzeile', () => {
  test('short 640x400', async () => {
    const page = await openPage(harness, { device: 'short', theme: 'light', locale: 'de' });
    const offenders = [];
    let seen = 0;

    for (const name of sweep('Sonde 15')) {
      await gotoRoute(page, ALL_ROUTES[name]);
      const heads = await page.evaluate(() => [...document.querySelectorAll('.page-toolbar')]
        .filter((el) => el.getBoundingClientRect().height > 0)
        .map((el) => {
          // Disjunkte Cluster ueber die vertikalen Intervalle der Kinder.
          const spans = [...el.children]
            .map((c) => c.getBoundingClientRect())
            .filter((r) => r.height > 0)
            .map((r) => [r.top, r.bottom])
            .sort((a, b) => a[0] - b[0]);
          let rows = 0;
          let end = -Infinity;
          for (const [top, bottom] of spans) {
            if (top >= end) rows += 1;
            end = Math.max(end, bottom);
          }
          return { h: el.getBoundingClientRect().height, rows, cls: el.className };
        }));
      for (const head of heads) {
        seen += 1;
        if (head.rows <= HEAD_ROWS_MAX && head.h <= HEAD_MAX) continue;
        offenders.push(
          `${name}: ${head.rows} Zeilen / ${Math.round(head.h)}px `
          + `(max ${HEAD_ROWS_MAX} / ${HEAD_MAX}) - ${head.cls}`,
        );
      }
    }
    await page.close();

    // Eine Sonde, die nichts gemessen hat, darf nicht urteilen - dieselbe
    // Zusicherung wie bei Sonde 3 und Sonde 4. Gezaehlt sind GEFUNDENE Koepfe.
    assert.ok(seen >= 12,
      `Nur ${seen} Modulkoepfe gefunden - die Sonde hat nichts gemessen, statt nichts `
      + 'zu finden. Rendert die App in dieser Groessenklasse ueberhaupt?');

    assert.deepEqual(offenders.sort(), [],
      'Modulkopf baut in der kompakten Hoehe hoeher als zwei Bar-Zeilen - damit steht '
      + 'ueber dem Inhalt mehr als der Kopf und eine Bedienzeile (DESIGN.md, Die '
      + `Chrome-Regel).\n  ${offenders.join('\n  ')}`);
  });
});

/* ────────────────────────────────────────────────────────────────────────────
 * Sonde 16: was im Leerlauf weiterlaeuft, darf nicht pro Frame neu rastern
 *
 * DIE REGEL: kein Element, dessen Animation endlos laeuft, traegt gleichzeitig
 * einen `filter`. Ein Filter wird fuer seinen Inhalt gerastert; bewegt sich
 * dieser Inhalt, faellt die Rasterung in JEDEM Frame an - und zwar solange die
 * Seite offen ist, auch wenn niemand sie bedient.
 *
 * DER GEMESSENE ANLASS (Issue #716): `.lg-blob` trug `filter: blur(90px)` UND
 * `animation: lg-drift ... infinite`, ueber vier Flaechen von 30-46vw. Im
 * Leerlauf fielen dadurch 60 auf ~20 fps, bei einem Style-Recalc je Frame; ein
 * Melder sah 100 % GPU auf integrierter Grafik. Die Reparatur trennt beides auf
 * zwei Knoten - die Huelle bewegt sich, das Kind `.lg-blob__ink` traegt den
 * Blur und steht still -, danach standen 60 fps.
 *
 * WARUM NICHT IM STYLESHEET. Die Zuordnung ist dort nicht sichtbar: Filter und
 * Animation koennen in zwei getrennten Regeln stehen (`.lg-blob` und
 * `.lg-blob--2`), oder ueber Vererbung von Kurzschreibweisen zusammenkommen.
 * Ein Scanner ueber Regeltexte haette die Fassung von Issue #443 fuer repariert
 * erklaert - deren Kommentar behauptete zwei Jahre lang genau das, was hier
 * gemessen NICHT stimmte. Erst der berechnete Stil am fertigen Dokument
 * beantwortet die Frage, welche beiden Werte wirklich auf EINEM Kasten liegen.
 *
 * SPINNER UND SKELETTE FALLEN NICHT DARUNTER, weil sie keinen Filter tragen -
 * nicht, weil sie ausgenommen waeren. Es gibt hier bewusst keine Ausnahmeliste:
 * die Regel gilt fuer jedes Element, und ein Element, das sie verletzt, ist
 * kein Sonderfall, sondern der naechste Befund.
 * ──────────────────────────────────────────────────────────────────────────── */

describe('Sonde 16 - kein dauerlaufendes Element rastert pro Frame einen Filter', () => {
  test('desktop 1280x900', async () => {
    const page = await openPage(harness, { device: 'desktop', theme: 'light', locale: 'de' });
    const offenders = [];
    let seen = 0;

    for (const name of sweep('Sonde 16')) {
      await gotoRoute(page, ALL_ROUTES[name]);
      const found = await page.evaluate(() => {
        const out = { animated: 0, offenders: [] };
        for (const el of document.querySelectorAll('*')) {
          const cs = getComputedStyle(el);
          // `infinite` liest sich berechnet als 'infinite'; mehrere Animationen
          // stehen kommagetrennt, eine endlose unter ihnen genuegt.
          const endless = cs.animationIterationCount.split(',')
            .some((v) => v.trim() === 'infinite');
          // Eine Animation mit `animation-play-state: paused` oder Dauer 0
          // laeuft nicht - sie kostet auch nichts.
          const running = cs.animationPlayState.split(',').some((v) => v.trim() === 'running')
            && cs.animationDuration.split(',').some((v) => parseFloat(v) > 0);
          if (!endless || !running) continue;
          out.animated += 1;
          const filter = cs.filter;
          if (filter && filter !== 'none') {
            out.offenders.push(`${el.tagName.toLowerCase()}.${el.className || '(ohne Klasse)'} -> ${filter}`);
          }
        }
        return out;
      });
      seen += found.animated;
      for (const o of found.offenders) offenders.push(`${name}: ${o}`);
    }
    await page.close();

    // Dieselbe Zusicherung wie bei den Sonden 3, 4 und 15, und hier ist sie
    // besonders leicht zu verlieren: waeren die Blobs eines Tages nicht mehr
    // animiert, faende die Sonde nichts mehr zu pruefen und bliebe still gruen.
    // Der lebende Backdrop laeuft auf JEDER Route, also sind vier Blobs mal der
    // Zahl der abgefahrenen Zustaende die Untergrenze.
    assert.ok(seen >= 4 * sweep('Sonde 16').length,
      `Nur ${seen} dauerlaufende Animationen ueber ${sweep('Sonde 16').length} Zustaende `
      + '- die Sonde hat nichts gemessen, statt nichts zu finden. Laeuft der lebende '
      + 'Backdrop (.lg-blob) noch?');

    assert.deepEqual(offenders.sort(), [],
      'Ein endlos animiertes Element traegt einen `filter` und rastert ihn damit pro '
      + 'Frame neu - im Leerlauf, solange die Seite offen ist (Issue #716). Bewegung '
      + 'und Filter gehoeren auf zwei Knoten: die aeussere Huelle bewegt sich, das '
      + `Kind traegt den Filter und steht still (siehe .lg-blob in glass.css).\n  ${offenders.join('\n  ')}`);
  });
});

/* ────────────────────────────────────────────────────────────────────────────
 * Sonde 17: eine Seite, die nur geladen wurde, meldet keinen Fehler
 *
 * DIE REGEL: Ansehen ist keine Handlung. Wer eine Route oeffnet und nichts tut,
 * darf keinen Fehler-Toast bekommen - ein roter Balken ohne Anlass ist der
 * teuerste Toast, den es gibt: er entwertet alle anderen.
 *
 * DER GEMESSENE ANLASS (2026-08-10): das Dashboard zeigte beim Laden „Ein
 * unerwarteter Fehler ist aufgetreten", zweimal. Dahinter stand keine kaputte
 * Anfrage, sondern „ResizeObserver loop completed with undelivered
 * notifications" - eine Zustellnotiz der Spezifikation, die der globale
 * `error`-Handler wie einen Anwendungsfehler behandelte. Instrumentiert man
 * die Observer der Shell, feuert keiner mehr als einmal je Frame; es gab also
 * nichts zu reparieren ausser der Meldung selbst (router.js,
 * RESIZE_OBSERVER_NOTICE).
 *
 * WARUM AM DOKUMENT UND NICHT AM QUELLTEXT. Ein Test, der das Filtermuster in
 * router.js sucht, ist gruen, sobald die Zeile dasteht - auch wenn ein
 * Handler davor schon getoastet hat oder der Toast aus einer ganz anderen
 * Quelle kommt. Gefragt ist nicht, ob der Filter im Code steht, sondern ob am
 * Ende ein roter Balken auf dem Bildschirm liegt.
 *
 * ZWEI FASSUNGEN DAVOR WAREN BLIND, und beide auf dieselbe Art: sie warteten
 * darauf, dass der Befund von SELBST vorbeikommt. Die erste sah 1,2 s nach dem
 * Laden nach, welche Toasts noch dastehen - ein Toast raeumt sich nach 3 s ab,
 * `settle()` wartet den Aufbau vorher ab, der Befund fiel in die Luecke. Die
 * zweite schrieb ab Dokumentstart jeden Fehler-Toast mit und blieb trotzdem
 * gruen: der Harness setzt `yuvomi-onboarded`, und die Meldung haengt gerade an
 * dem Willkommensdialog, den er damit wegnimmt. Beide Male fiel das erst in der
 * Gegenprobe auf - der ausgebaute Filter liess sie gruen.
 *
 * DESHALB WIRD DIE REGEL JETZT AUSGELOEST STATT ABGEWARTET. Die Sonde feuert
 * beide Ereignisse selbst und sieht nach, was der Handler daraus macht. Das ist
 * unabhaengig davon, welcher Zustand die Notiz gerade ausloest - und es prueft
 * die GEGENRICHTUNG gleich mit: ein echter Fehler MUSS weiterhin toasten. Ohne
 * die zweite Haelfte waere ein Filter, der alles verschluckt, ebenso gruen -
 * und das waere der schlimmere Fehler von beiden.
 *
 * EINE ROUTE GENUEGT HIER, und das ist keine Auslassung: der Handler haengt an
 * `window` und wird in router.js genau einmal registriert. Er ist auf jeder
 * Route derselbe Code - ein Sweep wuerde sechzehnmal dasselbe messen. Deshalb
 * steht die Sonde auch nicht in LEAVES_SKIPPED: sie faehrt keinen Sweep.
 * ──────────────────────────────────────────────────────────────────────────── */

describe('Sonde 17 - die Zustellnotiz des ResizeObservers ist kein Anwendungsfehler', () => {
  test('desktop 1280x900', async () => {
    const page = await openPage(harness, { device: 'desktop', theme: 'light', locale: 'de' });
    await gotoRoute(page, ALL_ROUTES[ROUTE_NAMES[0]]);

    const seen = await page.evaluate(async () => {
      const count = () => document.querySelectorAll('.toast-container .toast--danger').length;
      const settleFrame = () => new Promise((r) => requestAnimationFrame(() => r()));
      const fire = (message, error) => window.dispatchEvent(
        new ErrorEvent('error', { message, error, bubbles: false, cancelable: true }));
      // Frei raeumen: showToast deckelt bei drei gleichzeitigen Toasts und
      // wirft dann den aeltesten weg - unter dem Deckel zaehlt jedes Delta.
      const clear = () => document.querySelectorAll('.toast-container .toast')
        .forEach((el) => el.remove());

      clear();
      const start = count();
      // Die Zustellnotiz - Chrome schreibt sie ohne `error`-Objekt.
      fire('ResizeObserver loop completed with undelivered notifications.', null);
      await settleFrame();
      const afterNotice = count();
      // Die aeltere Fassung derselben Notiz.
      fire('ResizeObserver loop limit exceeded', null);
      await settleFrame();
      const afterOldNotice = count();

      // Gegenrichtung, zweimal: MIT und OHNE `error`-Objekt. Ein Fehler aus
      // fremdem Ursprung kommt ohne Objekt an ("Script error."), und genau ihn
      // wuerde ein Filter verschlucken, der statt der Meldung nur „kein
      // error-Objekt" prueft.
      clear();
      fire('Kaputt', new Error('Kaputt'));
      await settleFrame();
      const afterRealWithObject = count();
      clear();
      fire('Kaputt ohne Objekt', null);
      await settleFrame();
      const afterRealWithoutObject = count();
      return { start, afterNotice, afterOldNotice, afterRealWithObject, afterRealWithoutObject };
    });
    await page.close();

    assert.equal(seen.afterNotice, seen.start,
      'Die ResizeObserver-Zustellnotiz hat einen Fehler-Toast erzeugt. Sie ist kein '
      + 'Fehler, sondern die spezifikationsgemaesse Meldung, dass eine weitere '
      + 'Observer-Runde einen Frame spaeter zugestellt wird (router.js, '
      + 'RESIZE_OBSERVER_NOTICE).');
    assert.equal(seen.afterOldNotice, seen.start,
      'Die aeltere Schreibweise „ResizeObserver loop limit exceeded" kommt noch durch.');
    assert.equal(seen.afterRealWithObject, 1,
      'Ein ECHTER unbehandelter Fehler erzeugt keinen Toast mehr - der Filter ist zu '
      + 'breit geworden und verschluckt jetzt, was er melden soll. Das ist der '
      + 'schlimmere der beiden Fehler.');
    assert.equal(seen.afterRealWithoutObject, 1,
      'Ein Fehler OHNE `error`-Objekt wird verschluckt. So kommen Fehler aus fremdem '
      + 'Ursprung an ("Script error."); wer auf das fehlende Objekt statt auf die '
      + 'Meldung filtert, macht sie unsichtbar.');
  });
});

/* ────────────────────────────────────────────────────────────────────────────
 * Sonde 18: Am Scroll-Ende liegt nichts Bedienbares unter dem FAB
 *
 * Der FAB schwebt am Desktop frei in der unteren rechten Ecke. Die Zusicherung
 * aus #634 hiess dafuer bis 2026-08-12 „bei KEINEM Scrollstand liegt etwas
 * Bedienbares unter ihm" und wurde von einer `margin-block-end` getragen, die den
 * Scrollport um 96px verkuerzte. Der Preis war sichtbar: das Dashboard-Raster
 * brach 96px ueber der Fensterkante mitten in einer Widget-Reihe ab (gemessen
 * 12 % eines 900er-Fensters, 25 % zusaetzlicher Scrollweg).
 *
 * DIE ZUSICHERUNG IST JETZT DIE RICHTIGE UND NICHT DIE STRENGERE: nichts ist
 * UNERREICHBAR. Getragen wird sie von einem `padding-block-end` am Inhaltsende -
 * dem Nachlauf. Beide gemessenen Schadensfaelle lagen am SCROLL-ENDE
 * (`.pantry-stepper__btn` und `.contact-more-menu` mobil, 2026-08-10; acht Ziele
 * mit verdecktem Zentrum am Desktop, 2026-08-12), also genau dort, wo sich nichts
 * mehr wegscrollen laesst. Dort liegt jetzt leerer Nachlauf. Mitten im Scrollen
 * laeuft Inhalt unter dem Knopf durch, und das ist Absicht: ein schwebender Knopf
 * laesst sich in beide Richtungen freischieben, und ein Fehlgriff landet auf ihm
 * (Anlegen) statt auf der Zeilenaktion darunter (Loeschen).
 *
 * SONDE 4 KANN DAS NICHT SEHEN, und deshalb steht diese hier: ein Ziel, dessen
 * Zentrum verdeckt ist, ueberspringt Sonde 4 ausdruecklich („dort misst die Sonde
 * nichts, statt etwas Falsches zu messen"). Genau dieser Fall ist hier der
 * Befund.
 *
 * DER SCROLLER WIRD AN SEINEM OVERFLOW GESUCHT, NICHT AN SEINEM NAMEN. Eine
 * Vorfassung dieser Messung nahm `[class$="-page"]` mit `scrollHeight >
 * clientHeight`; bei 1280x900 traf das nichts, fiel auf `.app-content` zurueck
 * und meldete trotzdem `contact-more-menu__trigger` mit 63 % „am Ende" - ein
 * Zwischenstand, der wie ein Befund aussah. Der Scrollstand wird deshalb
 * ZURUECKGELESEN, und wer nicht am Ende steht, wird nicht als Ende gezaehlt.
 * ──────────────────────────────────────────────────────────────────────────── */

/**
 * Ans Scroll-Ende fahren und messen, was dann unter dem FAB liegt.
 *
 * ZWEIMAL FAHREN, UND ZWAR AUS EINEM GEMESSENEN GRUND. Die Zeilenlisten bauen
 * sich nach dem ersten Frame auf (dieselbe Eigenheit, die Sonde 7 kennt): ein
 * `scrollTop = scrollHeight` direkt nach der Navigation landet mitten im Aufbau,
 * die Liste waechst danach weiter, und die Messung sieht Zeilen im Flug. Die
 * erste Fassung dieser Sonde meldete so `row-action` in Einkauf, Vorrat und
 * Mahlzeiten - nachgemessen liegt dort am echten Ende nichts unter dem Knopf.
 * Deshalb: settlen, fahren, settlen, nochmal fahren, und erst dann messen.
 */
/**
 * Der Scrollport der Seite - EINMAL bestimmt, für Fahren UND Klippen.
 *
 * DER GRÖSSTE, NICHT DER ERSTE. Die Vorfassung nahm das erste Element mit
 * `overflow-y: auto` und Überlauf. In den vier Küchen-Tabs ist das die
 * horizontal scrollende Tab-Leiste: `.sub-tabs-bar`, 56px hoch. Gemessen auf
 * /shopping bei 390x844 hiess der Scrollport damit „y 0 bis 56" - 83 von 87
 * Kandidaten fielen als „weggeschnitten" heraus, und die Sonde war auf allen
 * vier Kuechenrouten blind, ohne es zu melden. Der Inhaltsscroller ist der mit
 * der groessten sichtbaren Hoehe.
 */
async function installScrollportFinder(page) {
  await page.evaluate(() => {
    window.__yuvomiScrollport = () => {
      const outer = document.querySelector('.app-content');
      const kandidaten = [...document.querySelectorAll('#main-content *')].filter((el) => {
        const s = getComputedStyle(el);
        return (s.overflowY === 'auto' || s.overflowY === 'scroll')
          && el.scrollHeight > el.clientHeight + 4;
      });
      kandidaten.sort((a, b) => b.clientHeight - a.clientHeight);
      return kandidaten[0] || outer;
    };
  });
}

async function fabAtScrollEnd(page) {
  await installScrollportFinder(page);
  const toEnd = () => page.evaluate(() => {
    const scroller = window.__yuvomiScrollport();
    if (scroller) scroller.scrollTop = scroller.scrollHeight;
  });
  await new Promise((r) => setTimeout(r, 700));
  await toEnd();
  await new Promise((r) => setTimeout(r, 700));
  await toEnd();
  await new Promise((r) => setTimeout(r, 550));

  return page.evaluate(() => {
    const px = (n) => Math.round(n * 10) / 10;
    const outer = document.querySelector('.app-content');
    const scroller = window.__yuvomiScrollport();
    const inner = scroller === outer ? null : scroller;
    const fab = document.querySelector('.page-fab:not([hidden])');
    const o = outer.getBoundingClientRect();
    /* GEKLIPPT WIRD AM SCROLLPORT, DER WIRKLICH SCROLLT.
     *
     * Hier stand `o` - die Kante von `.app-content` - auch dort, wo eine innere
     * Liste den Scrollport bildet. Zum FAHREN nimmt die Sonde `inner` seit jeher,
     * zum KLIPPEN nahm sie `outer`, und dazwischen liegt genau der Bereich, in
     * dem eine weggescrollte Zeile noch eine Layout-Position hat.
     *
     * Gemessen auf /pantry bei 1440x900 am Scroll-Ende: der innere Scroller
     * beginnt bei y=185, die gemeldeten `pantry-stepper__btn` lagen bei y=74-114
     * - also 71px ueber seiner Oberkante, weggescrollt und unsichtbar, aber
     * innerhalb von `.app-content` (y=0). Es ist dieselbe Falle 2, die der
     * Kommentar unten beschreibt, eine Ebene tiefer. */
    const clip = (inner || outer).getBoundingClientRect();
    const res = {
      scrollportUnten: px(o.bottom),
      viewportHoehe: window.innerHeight,
      amEnde: !scroller || scroller.scrollHeight - scroller.clientHeight - scroller.scrollTop <= 2,
      scrollbar: !!scroller && scroller.scrollHeight > scroller.clientHeight + 4,
    };
    if (!fab) return { ...res, keinFab: true };

    const f = fab.getBoundingClientRect();

    /* NUR EIN SCHWEBENDER KNOPF KANN ETWAS VERDECKEN, und auf dem Zeigergeraet
     * schwebt seit Etappe 2 (dc23972f) keiner mehr.
     *
     * Zwei Zustaende, beide harmlos, beide gemessen bei 1440x900:
     *
     *  ANGEDOCKT - fuenf Routen (Vorrat, Mahlzeiten, Rezepte, Geburtstage,
     *  Dokumente) verschieben den Knoten in die Kopfleiste. Er liegt dort IM
     *  FLUSS und verdeckt per Definition nichts. Genau ihn hat die Sonde
     *  bisher als „FAB" vermessen - der /pantry-Befund, mit dem diese Etappe
     *  begonnen hat, war die Ueberlappung weggescrollter Listenzeilen mit
     *  einem Toolbar-Knopf.
     *
     *  EINGEKLAPPT - die uebrigen sieben behalten den Knoten in `.fab-layer`,
     *  aber ohne Geometrie: gemessen 0x0 auf /tasks, /budget, /shopping,
     *  /contacts, /notes. Ein Rechteck ohne Flaeche schneidet nichts.
     *
     * Gefragt wird nach BEIDEM, denn keins allein reicht: die Shell-Ebene
     * erkennt das Andocken (`position` taugt nicht - der Dashboard-FAB ist
     * `static` und schwebt trotzdem, weil `.fab-layer` um ihn herum fixiert
     * ist), die Groesse erkennt das Einklappen. */
    const schwebend = !!fab.closest('.fab-layer') && f.width > 0 && f.height > 0;
    if (!schwebend) {
      return { ...res, keinFab: true, angedockt: !fab.closest('.fab-layer'), eingeklappt: f.width < 1 || f.height < 1 };
    }
    // Der Prefix gehoert an JEDES Glied - `#main-content ${liste}` bindet den
    // Nachfahren-Kombinator sonst nur an das erste, und der Rest gilt
    // dokumentweit (dann meldet die Sonde die Sidebar-Links als Inhalt).
    const SEL = ['button', 'a[href]', '[role="button"]', 'input:not([type=hidden])',
      'select', 'textarea', 'summary', '[tabindex]:not([tabindex="-1"])']
      .map((s) => `#main-content ${s}`).join(', ');
    res.unterFab = [];
    for (const el of document.querySelectorAll(SEL)) {
      if (el === fab || fab.contains(el) || el.contains(fab)) continue;
      const cs = getComputedStyle(el);
      if (cs.display === 'none' || cs.visibility === 'hidden' || cs.pointerEvents === 'none') continue;
      const b = el.getBoundingClientRect();
      if (b.width < 1 || b.height < 1) continue;
      // WAS DER SCROLLPORT WEGSCHNEIDET, LIEGT NICHT UNTER DEM KNOPF - ES LIEGT
      // NIRGENDS. `getBoundingClientRect` meldet die LAYOUT-Position; ein
      // `overflow: auto` aendert sie nicht, sondern nur, was gemalt und
      // getroffen wird. Die erste Fassung meldete darueber mobil drei Ziele
      // (`row-action` 13 %, `pantry-stepper__btn` 10 %,
      // `meal-slot__add-more-btn` 4 %) - alle drei lagen bei y 721-838, waehrend
      // der Scrollport bei 735,9 endet, also im geklippten Bereich hinter der
      // Nav-Zone. Dieselbe Falle 2, die Sonde 4 an ihren Kanten beschreibt.
      if (b.bottom <= clip.top || b.top >= clip.bottom) continue;
      const w = Math.min(b.right, f.right) - Math.max(b.left, f.left);
      const h = Math.min(b.bottom, Math.min(f.bottom, clip.bottom)) - Math.max(b.top, Math.max(f.top, clip.top));
      if (w <= 0 || h <= 0) continue;
      res.unterFab.push({
        sel: [...el.classList].slice(0, 2).join('.') || el.tagName.toLowerCase(),
        anteil: Math.round((w * h) / (b.width * b.height) * 100),
      });
    }
    return res;
  });
}

describe('Sonde 18 - am Scroll-Ende liegt nichts Bedienbares unter dem FAB', () => {
  for (const device of ['mobile', 'desktop']) {
    test(`Geraet ${device}`, async () => {
      const page = await openPage(harness, { device, theme: 'light', locale: 'de' });
      const findings = [];
      let seen = 0;
      let angedockt = 0;
      let eingeklappt = 0;
      let ohneFab = 0;

      for (const name of sweep('Sonde 18')) {
        await gotoRoute(page, ALL_ROUTES[name]);
        const m = await fabAtScrollEnd(page);
        if (m.angedockt) angedockt += 1;
        if (m.eingeklappt) eingeklappt += 1;

        /* Der Nachlauf darf den Scrollport nicht verkuerzen: das war die Marge,
         * und ihr Preis war die abgeschnittene Widget-Reihe.
         *
         * STEHT VOR DER FAB-FRAGE, nicht dahinter. Sie haengt nicht am FAB,
         * sondern an `.app-content`, und seit auf dem Zeiger kein FAB mehr
         * schwebt, waere sie hinter dem `continue` auf genau dem Geraet nie
         * mehr gelaufen, fuer das sie geschrieben wurde. Mobil endet der
         * Scrollport ueber der Nav-Zone, dort gilt die Zusage nicht. */
        if (device === 'desktop' && m.scrollportUnten < m.viewportHoehe - 1) {
          findings.push(`${name}: der Scrollport endet ${Math.round(m.viewportHoehe - m.scrollportUnten)}px `
            + 'ueber der Fensterkante - die FAB-Reserve verkuerzt ihn wieder statt als Nachlauf zu reiten.');
        }

        // Drei Module fuehren ihre Primaeraktion ohne FAB - kein Befund.
        if (m.keinFab) {
          if (!m.angedockt && !m.eingeklappt) ohneFab += 1;
          continue;
        }
        // Ein Zwischenstand zaehlt nicht als Ende (siehe Kopf).
        if (!m.amEnde) continue;
        seen += 1;

        if (m.unterFab.length) {
          findings.push(`${name}: am Scroll-Ende liegt ${m.unterFab.map((h) => `${h.sel} (${h.anteil} %)`).join(', ')} `
            + 'unter dem FAB - dort laesst sich nichts mehr wegscrollen, das Ziel ist unerreichbar.');
        }
      }
      await page.close();

      /* AM ZEIGER SCHWEBT SEIT ETAPPE 2 FAST KEIN FAB MEHR, und damit hat die
       * Frage dieser Sonde dort kaum noch einen Gegenstand. Sie prueft deshalb
       * zuerst die AUFTEILUNG - wer andockt, wer einklappt, wer keinen hat -
       * und misst die Ueberlappung nur noch fuer den einen, der wirklich
       * schwebt.
       *
       * WARUM DAS KEIN NACHGEBEN IST: die alte Fassung hat auf dem Zeiger nicht
       * etwa nichts gefunden, sie hat FALSCH gefunden. Sie mass die
       * Ueberlappung weggescrollter Listenzeilen mit einem Knopf in der
       * Kopfleiste und meldete `/pantry` rot - der Befund, mit dem diese Etappe
       * begonnen hat. Gegengeprueft: mit `--fab-safe-zone: 0` blieb sie gruen,
       * und selbst ein 300px nach oben verschobener FAB machte sie nicht rot.
       * Eine Sonde, die den Anlassfall nicht mehr rot sieht, misst nichts.
       *
       * AM FINGER MISST SIE WEITER, und dort trifft sie: derselbe verschobene
       * FAB liefert auf /budget fuenf und auf /contacts einen Treffer. Der
       * Knopf sitzt seit v2.2.0 in der Nav-Kapsel, ueber Chrome statt ueber
       * Inhalt - dass am Scroll-Ende trotzdem nichts Bedienbares unter ihm
       * liegt, ist genau die Zusage, die zu pruefen bleibt. */
      if (device === 'desktop') {
        /* GENAU EINER SCHWEBT DORT NOCH, und das ist eine Entscheidung, keine
         * Luecke: das Speed-Dial des Dashboards dockt bewusst nicht an, weil es
         * ein MENUE ist und ein halber Umzug schlechter waere als keiner
         * (dc23972f). Fuer ihn gilt die Frage dieser Sonde weiter, und er ist
         * der einzige Fall, in dem sie auf dem Zeiger ueberhaupt etwas misst. */
        assert.equal(seen, 1,
          `Auf dem Zeigergeraet schwebt genau ein FAB ueber dem Inhalt (das Dashboard-Speed-Dial), `
          + `gemessen wurden ${seen}. Entweder dockt ein Modul nicht mehr an, oder die Einklapp-Regel greift nicht.`);
        // Die Aufteilung wird MITGEPRUEFT, nicht nur abgezogen: sonst verschwiege
        // die Sonde still, dass ein Modul seinen FAB ganz verloren hat.
        /* NUR die beiden Zahlen, die dieser Sonde gehoeren. `ohneFab` waere die
         * dritte, aber der Sweep faehrt ausser den 15 Modulrouten auch jedes
         * Einstellungs-Blatt an - gemessen 29 statt 3, und diese Zahl haengt an
         * der Zahl der Einstellungsseiten, nicht am FAB. Ein Modul, das seinen
         * FAB verliert, faellt trotzdem auf: es fehlt dann in einem der beiden
         * Toepfe hier. */
        assert.deepEqual({ angedockt, eingeklappt }, { angedockt: 5, eingeklappt: 6 },
          'Erwartet auf dem Zeiger: 5 FABs in der Kopfleiste (Vorrat, Mahlzeiten, Rezepte, '
          + 'Geburtstage, Dokumente) und 6 eingeklappte (dort traegt der Modulkopf seinen eigenen '
          + `Knopf). Gezaehlt wurden ${angedockt} und ${eingeklappt}, dazu ${ohneFab} Seiten ohne FAB. `
          + 'Aendert sich das, aendert sich die Reichweite dieser Sonde.');
      } else {
        // 15 Routen minus die drei ohne FAB.
        assert.ok(seen >= 12,
          `Nur ${seen} Zustaende am Scroll-Ende gemessen - erwartet sind mindestens 12. Entweder `
          + 'fehlt Modulen ihr FAB, oder keine Seite kam an ihr Scroll-Ende.');
        assert.equal(angedockt, 0, 'am Finger dockt kein FAB an - der Platz dafuer ist die Nav-Kapsel');
      }

      assert.deepEqual(findings, [],
        'Der FAB am Scroll-Ende. Dort gehoert ihm der Nachlauf allein.\n  ' + findings.join('\n  '));
    });
  }
});

/* ────────────────────────────────────────────────────────────────────────────
 * Sonde 19 - in der regulaeren Groessenklasse traegt der Modulkopf EINE Zeile
 *
 * WARUM ES DIESE SONDE VORHER NICHT GAB, UND WAS DURCH DIE LUECKE FIEL. Sonde 1
 * misst Kopf-Ueberlauf, aber nur bei 375px. Sonde 15 zaehlt Kopf-Zeilen, aber
 * nur in der kompakten Hoehe (640x400). Der Zustand aus #882 - Desktop, Kopf
 * baut zwei Zeilen - faellt durch beide Raster: er ist kein Ueberlauf (nichts
 * ragt hinaus, die Leiste wird nur hoeher) und keine kompakte Hoehe. Gemeldet
 * hat ihn ein Nutzer, fuer vier Module, mit Screenshots.
 *
 * WAS GEMESSEN WIRD UND WARUM NICHT DER QUELLTEXT. Ob ein Kopf in eine Zeile
 * passt, entscheidet die Summe aus Titellaenge, Anzahl der Aktionen, Locale und
 * Viewport - in keinem Stylesheet steht das. Beim Anlassfall kam dazu, dass die
 * Ursache aus der KOMPOSITION zweier je fuer sich richtiger Regeln entstand:
 * eine Marge holte das Zeilenende aufs Lesemass zurueck, ein Modifier erlaubte
 * den Umbruch, und zusammen beanspruchte der Aktions-Slot 966px einer 1280px
 * breiten Zeile. Ein Quelltext-Guard haette beide Regeln einzeln gebilligt.
 *
 * EINE TITELZEILE, PLUS HOECHSTENS DIE BAR-ZEILE (Neufassung 2026-08-27,
 * Werkzeugzeilen-Regel). Die erste Fassung dieser Sonde verlangte EINE Zeile
 * fuer den ganzen Kopf - und zwang damit jede Tab-Leiste in die Titelzeile,
 * wo sie ihre eigenen Module versteckte: die Budget-Tabs hatten bei 1280px
 * 138px clientWidth fuer 606px Inhalt (1 von 7 Tabs sichtbar), das
 * Kalender-Segment 212px fuer 245px („Agenda" unsichtbar). Seither gilt:
 * die NICHT-Bar-Kinder (Titel, Center, Aktionen) bilden weiterhin genau eine
 * Zeile - das ist der #882-Fall, und er bleibt rot -, und die Bar-Zeile
 * (.page-toolbar__bar) ist die eine erlaubte zweite, selbst einzeilig.
 * Dieselbe Rollenteilung, die Sonde 15 in der kompakten Hoehe schon immer
 * erlaubt („die zweite hat einen Namen: eine Tab-Leiste IM Kopf").
 *
 * Die Vorgaenger-Fassung dieser Passage - „EINE ZEILE, NICHT ZWEI; die erste
 * Fassung uebernahm die Zwei-Zeilen-Grenze von Sonde 15 und blieb mit wieder
 * eingebautem Fehler gruen" - bleibt als Warnung stehen: ein pauschales <= 2
 * ueber ALLE Kinder liesse #882 wieder durch. Deshalb zaehlt die Sonde jetzt
 * getrennt statt milder.
 *
 * ZWEI ZUSICHERUNGEN, WEIL EINE OHNE DIE ANDERE ERKAUFT WERDEN KANN. Einzeilig
 * zu sein ist wertlos, wenn der Kopf sein Ende dabei verliert - der
 * Lesemass-Abstand existiert ja gerade, damit Kopf und Koerper dieselbe rechte
 * Kante haben. Die erste Fassung des Fix liess ihn nachgeben: der Kopf wurde
 * einzeilig und schob sein Ende um 69 bis 87px ueber die Koerperkante. Kein
 * Guard sah das, weil keiner die Kante mass; gefunden hat es ein Reviewer.
 *
 * DREI BREITEN, WEIL DIE ENGE VON DER BREITE ABHAENGT. 1024px ist die Kante der
 * Groessenklasse (darunter regiert die Large-Title-Zone und der Umbruch ist
 * Absicht), 1280px die Breite, ab der die Content-Spalte steht, und 1960px die
 * Breite, bei der der Melder gemessen hat - dort war der Kopf zweizeilig,
 * obwohl 660px Platz frei standen. Die Zeilenzahl wird nur bei den beiden
 * oberen geprueft; die Begruendung steht an REGULAR_WIDTHS.
 *
 * DURCH DIE SICHTEN GEKLICKT, weil genau dort der Anlassfall sass: der
 * Kalenderkopf baute in Woche, Tag und Agenda eine Zeile mehr als im Monat,
 * ohne dass ein Element dazukam - nur das Datumslabel wurde laenger.
 *
 * `uk` als zweite Sprache: laengste Modulnamen, dieselbe Wahl wie in Sonde 1.
 * ──────────────────────────────────────────────────────────────────────────── */

/* `rows: false` heisst NICHT "hier ist alles erlaubt", sondern "hier ist eine
 * Zeile nicht erreichbar, und das ist gemessen". Bei 1024px nimmt die Sidebar
 * dem Kopf rund 220px; innen bleiben 740px, und davon beansprucht das Lesemass
 * allein 720px. Ein Kopf mit Titel, Suchfeld und vier Aktionen passt da nicht in
 * eine Zeile, ohne dass Inhalt verschwindet - der Umbruch ist dort die richtige
 * Antwort auf echten Platzmangel und nicht der Rechenfehler aus #882. Gefunden
 * hat das erst der GESAMTLAUF: einzeln gefahren blieb die Sonde gruen, weil die
 * Testinstanz nach achtzehn anderen Sonden mehr Daten traegt und die Filter im
 * Kopf damit breiter werden.
 *
 * Die FLUCHTLINIE wird trotzdem auch dort geprueft: dass ein Kopf umbricht,
 * entbindet ihn nicht davon, auf der Kante seines Koerpers zu enden. */
const REGULAR_WIDTHS = [
  { w: 1024, why: 'Kante der Groessenklasse', rows: false },
  { w: 1280, why: 'Breite der Content-Spalte', rows: true },
  { w: 1960, why: 'gemeldete Breite (#882)',   rows: true },
];

describe('Sonde 19 - in der regulaeren Groessenklasse traegt der Modulkopf eine Zeile', () => {
  for (const locale of ['de', 'uk']) {
    test(`Locale ${locale}`, async () => {
      const findings = [];
      let seen = 0;

      for (const { w, why, rows: pruefeZeilen } of REGULAR_WIDTHS) {
        const page = await openPage(harness, { device: 'desktop', theme: 'light', locale });
        await page.setViewport({ width: w, height: 900, deviceScaleFactor: 1, isMobile: false, hasTouch: false });

        for (const name of sweep('Sonde 19')) {
          await gotoRoute(page, ALL_ROUTES[name]);
          await visitViews(page, name, async (where) => {
            const heads = await page.evaluate(() => [...document.querySelectorAll('.page-toolbar')]
              .filter((el) => el.getBoundingClientRect().height > 0)
              .map((el) => {
                // Disjunkte Cluster ueber die vertikalen Intervalle der Kinder -
                // dieselbe Rechnung wie in Sonde 15, und aus demselben Grund:
                // mittig ausgerichtete Slots unterschiedlicher Hoehe beginnen
                // auseinander, ein Zaehler ueber Oberkanten meldete sonst fuer
                // einen einzeiligen Kopf vier "Zeilen".
                //
                // GETRENNT GEZAEHLT wird die Bar-Zeile (.page-toolbar__bar,
                // Werkzeugzeilen-Regel): sie ist die eine erlaubte zweite Zeile
                // und darf selbst nicht umbrechen. Alle uebrigen Kinder bilden
                // die Titelzeile - und fuer die gilt #882 unveraendert.
                const kids = [...el.children]
                  .map((c) => ({ c, r: c.getBoundingClientRect(), cs: getComputedStyle(c) }))
                  .filter((x) => x.r.height > 0 && x.cs.display !== 'none' && x.cs.visibility !== 'hidden');
                const clusters = (items) => {
                  const spans = items.map((x) => [x.r.top, x.r.bottom]).sort((a, b) => a[0] - b[0]);
                  let n = 0;
                  let end = -Infinity;
                  for (const [top, bottom] of spans) {
                    if (top >= end) n += 1;
                    end = Math.max(end, bottom);
                  }
                  return n;
                };
                const rows = clusters(kids.filter((x) => !x.c.classList.contains('page-toolbar__bar')));
                const barRows = clusters(kids.filter((x) => x.c.classList.contains('page-toolbar__bar')));
                // Wo endet der letzte echte Slot, gemessen ab dem Anfang der
                // Content-Box? Nur fuer gedeckelte Koepfe - die uebrigen haben
                // keine Kante, an die sie sich halten muessten.
                let narrowEnd = null;
                let measure = null;
                if (el.classList.contains('page-toolbar--narrow')) {
                  const cs = getComputedStyle(el);
                  const contentLeft = el.getBoundingClientRect().left + parseFloat(cs.paddingInlineStart);
                  const inner = el.clientWidth - parseFloat(cs.paddingInlineStart) - parseFloat(cs.paddingInlineEnd);
                  // DAS MASS GEHOERT DER SEITE, NICHT DER WURZEL (#1008). Die
                  // Regel in layout.css richtet den Kopf an `--page-measure`
                  // aus und nimmt `--content-max-width-narrow` NUR als
                  // Rueckfall fuer Seiten, die keins erklaeren. Diese Sonde las
                  // den Rueckfall von :root und meldete damit jede Seite mit
                  // eigener Komposition als defekt - housekeeping ist
                  // `app-page--data` (--layout-content, 60rem), sein Kopf endete
                  // korrekt bei 960px und wurde gegen 720px geprueft.
                  //
                  // Zwei Fallen dabei. Erstens liefert getComputedStyle fuer eine
                  // Custom Property den SUBSTITUIERTEN, nicht den umgerechneten
                  // Wert: hier steht `60rem`, und ein parseFloat darauf ergibt
                  // 60. Deshalb laesst ein Messelement den Browser rechnen.
                  // Zweitens ist `100%` ein legitimer Wert (--split, --full):
                  // dort macht `max()` in der CSS-Regel den Abstand zum No-op,
                  // und ein naiv umgerechnetes Prozent wuerde aus unbetroffenen
                  // Seiten Fehlschlaege bei 100px machen. Prozent heisst hier
                  // deshalb: nicht pruefen, genau wie im Stylesheet.
                  const raw = (getComputedStyle(el).getPropertyValue('--page-measure') || '').trim()
                    || (getComputedStyle(document.documentElement)
                      .getPropertyValue('--content-max-width-narrow') || '').trim();
                  if (raw.includes('%')) {
                    measure = null;
                  } else {
                    const ruler = document.createElement('div');
                    ruler.style.cssText = `position:absolute;visibility:hidden;height:0;width:${raw}`;
                    document.documentElement.appendChild(ruler);
                    measure = ruler.getBoundingClientRect().width;
                    ruler.remove();
                  }
                  // Nur pruefen, wo die Spalte ueberhaupt breiter als das
                  // Lesemass ist - darunter nimmt `max()` den Abstand zurueck
                  // und der Kopf endet richtigerweise an der Spaltenkante.
                  if (measure !== null && inner > measure) {
                    const last = [...el.children]
                      .filter((c) => getComputedStyle(c).display !== 'none')
                      .pop();
                    if (last) narrowEnd = Math.round(last.getBoundingClientRect().right - contentLeft);
                  }
                }
                return {
                  rows, barRows, h: Math.round(el.getBoundingClientRect().height), cls: el.className,
                  narrowEnd, measure,
                };
              }));
            for (const head of heads) {
              seen += 1;
              // DIE FLUCHTLINIE, ZWEITE HAELFTE DERSELBEN FRAGE. Einzeilig zu
              // sein ist wertlos, wenn der Kopf sein Ende dabei verliert: der
              // Lesemass-Abstand existiert, damit Kopf und Koerper dieselbe
              // rechte Kante haben (DESIGN.md, "fuer BEIDE Kanten"). Die erste
              // Fassung dieses Fix liess ihn nachgeben, blieb einzeilig - und
              // schob das Kopfende um 69 bis 87px ueber die Koerperkante
              // hinaus. Kein Guard sah das, weil keiner die Kante mass.
              if (head.narrowEnd !== null && head.measure !== null
                && Math.abs(head.narrowEnd - head.measure) > 1) {
                findings.push(
                  `${w}px (${why}) ${where}: Kopfende bei ${head.narrowEnd}px statt `
                  + `${Math.round(head.measure)}px (Mass der Seite) - ${head.cls}`,
                );
              }
              // EINE TITELZEILE, UND DAS IST WEITER DER #882-FALL: die
              // Nicht-Bar-Kinder (Titel, Center, Aktionen) duerfen nicht
              // umbrechen - ihr Umbruch war der gemeldete Zustand, und ein
              // pauschales <= 2 ueber ALLE Kinder hatte ihn in der ersten
              // Fassung dieser Sonde durchgelassen (die Gegenprobe blieb GRUEN
              // mit wieder eingebautem Fehler). Die Bar-Zeile
              // (.page-toolbar__bar) wird deshalb GETRENNT gezaehlt: sie ist
              // seit der Werkzeugzeilen-Regel (2026-08-27) die eine erlaubte
              // zweite Zeile - eine Tab-Leiste in der Titelzeile versteckte
              // ihre eigenen Module (Budget: 1 von 7 Tabs bei 1280px) - und
              // sie selbst darf ebenfalls nicht umbrechen (sie scrollt).
              if (!pruefeZeilen) continue;
              if (head.rows > 1) {
                findings.push(
                  `${w}px (${why}) ${where}: Titelzeile baut ${head.rows} Zeilen (${head.h}px) - ${head.cls}`,
                );
              }
              if (head.barRows > 1) {
                findings.push(
                  `${w}px (${why}) ${where}: Bar-Zeile baut ${head.barRows} Zeilen statt zu scrollen - ${head.cls}`,
                );
              }
            }
          });
        }
        await page.close();
      }

      assert.ok(seen >= 3 * 12,
        `Nur ${seen} Kopfzustaende gemessen - erwartet sind mindestens 36 (drei Breiten mal `
        + 'zwoelf Koepfe). Hat sich die Schreibweise von .page-toolbar geaendert, oder faehrt '
        + 'die Sonde ihre Routen nicht mehr?');

      assert.deepEqual(findings, [],
        'Ab 1024px traegt der Modulkopf eine einzeilige Titelzeile plus hoechstens die '
        + 'scrollende Bar-Zeile (Werkzeugzeilen-Regel), und ein gedeckelter Kopf endet auf '
        + 'der Kante seines Koerpers - der Titelzeilen-Umbruch war #882.\n  '
        + findings.join('\n  '));
    });
  }
});

/* ────────────────────────────────────────────────────────────────────────────
 * Sonde 20 - ein Werkzeug des Kopfs ist sichtbar oder sichtbar angeschnitten
 *
 * DIE REGEL (Werkzeugzeilen-Regel, DESIGN.md 2026-08-27): eine Tab-Leiste, die
 * ueberlaeuft, zeigt ihre Fortsetzung - als Scroll-Fade UND als sichtbar
 * angeschnittenes naechstes Werkzeug. Der Anlass war die Kehrseite der alten
 * Einzeilen-Doktrin: die Budget-Tabs zeigten bei 1280px 1 von 7 Tabs,
 * Gesundheit mobil 3 von 6, die Haushaltshilfe 3 von 4 - und das einzige
 * Existenzsignal der verborgenen Werkzeuge war ein 26px-Fade, der den mageren
 * Anschnitt komplett verdeckte. Eine Leiste, die BUENDIG endet, sieht aus wie
 * eine vollstaendige Leiste (Critique 2026-08-27, P1).
 *
 * WARUM AM DOKUMENT UND NICHT IM QUELLTEXT: ob eine Leiste ueberlaeuft,
 * entscheidet die Summe aus Tabzahl, Locale, Badge-Breite und Viewport - in
 * keinem Stylesheet steht das. Und ob der Anschnitt SICHTBAR ist, haengt an
 * der Maskenbreite gegen die zufaellige Lage der Tab-Kanten: genau das kann
 * nur Geometrie beantworten.
 *
 * ZWEI ZUSICHERUNGEN JE UEBERLAUFENDER LEISTE:
 *   1. Sie traegt has-fade-start/-end - wireScrollFade ist verdrahtet. Eine
 *      Leiste ohne den Helfer scrollt stumm. (Die erste Fassung dieser Sonde
 *      fand hier sofort einen Treffer: die eps-Toleranz des Helfers stand auf
 *      8px und schluckte einen echten 4px-Ueberlauf des Kalender-Segments in
 *      `uk` - kein Fade trotz abgeschnittenem Wort.)
 *   2. Die letzte sichtbare Werkzeugkante liegt IN der Fade-Zone (12px,
 *      filter-chip.css) oder ein Kind ist geometrisch angeschnitten. Die
 *      Maske schneidet auch einen zufaellig buendig endenden Tab sichtbar an -
 *      das Signal ist da. Schlecht ist nur LEERRAUM vor der Kante, der
 *      breiter ist als der Fade: dann faded die Maske Leere, und das naechste
 *      Werkzeug ist unauffindbar (der Ur-Befund aus Audit P2, wo der breite
 *      24px-Fade einen 9px-Anschnitt komplett verdeckte). Die erste Fassung
 *      verlangte den GEOMETRISCHEN Anschnitt hart - und meldete in `uk` eine
 *      Gesundheit-Leiste, deren Tab-Kante zufaellig buendig fiel, obwohl die
 *      Maske sie laengst anschnitt. Tab-Breiten sind Inhalt; eine Zusicherung
 *      darf nicht an der Zufallslage einer Wortgrenze haengen.
 *
 * GEMESSEN WIRD DER INITIALZUSTAND jeder Route (nach Load, ohne Nutzer-Scroll,
 * inkl. scrollActiveIntoView der Seite selbst) - er ist deterministisch, und
 * er ist der Zustand, in dem ein Nutzer die Leiste zum ersten Mal liest.
 * Beide LTR-Messlocales (de als Referenz, uk mit den laengsten Namen); die
 * RTL-Spiegelung der Masken prueft test:frontend-audit ueber die Regelpaare.
 * ──────────────────────────────────────────────────────────────────────────── */

describe('Sonde 20 - ein Werkzeug des Kopfs ist sichtbar oder sichtbar angeschnitten', () => {
  for (const locale of ['de', 'uk']) {
    test(`Locale ${locale}`, async () => {
      const findings = [];
      let seen = 0;
      let overflowed = 0;

      for (const { device, w } of [{ device: 'mobile', w: 375 }, { device: 'desktop', w: 1280 }]) {
        const page = await openPage(harness, { device, theme: 'light', locale });
        if (device === 'desktop') {
          await page.setViewport({ width: w, height: 900, deviceScaleFactor: 1, isMobile: false, hasTouch: false });
        }

        for (const name of sweep('Sonde 20')) {
          await gotoRoute(page, ALL_ROUTES[name]);
          const bars = await page.evaluate(() => {
            const lists = new Set([
              ...document.querySelectorAll('.page-toolbar [role="tablist"]'),
              ...document.querySelectorAll('.sub-tabs-bar[role="tablist"], nav.sub-tabs-bar'),
            ]);
            return [...lists]
              .filter((el) => el.getBoundingClientRect().width > 0)
              .map((el) => {
                const r = el.getBoundingClientRect();
                const overflow = el.scrollWidth - el.clientWidth;
                // Nur an einer Kante bewerten, hinter der wirklich Inhalt
                // verborgen liegt (am Initialstand ist das die Endkante,
                // solange die Leiste nicht schon ans Ende gescrollt wurde).
                // `gapAtEdge` ist der Leerraum zwischen der letzten sichtbaren
                // Werkzeugkante und der Leisten-Endkante: liegt er innerhalb
                // der 12px-Fade-Zone, schneidet die Maske das letzte Werkzeug
                // sichtbar an - auch wenn keine Kind-Box die Kante geometrisch
                // kreuzt.
                let gapAtEdge = null;
                if (overflow > 1 && el.scrollLeft < overflow - 1) {
                  const edge = r.left + el.clientWidth;
                  let lastEnd = r.left;
                  for (const child of el.children) {
                    const cr = child.getBoundingClientRect();
                    if (cr.width <= 0) continue;
                    if (cr.left < edge) lastEnd = Math.max(lastEnd, Math.min(cr.right, edge));
                  }
                  gapAtEdge = edge - lastEnd;
                }
                return {
                  cls: el.className,
                  overflow: Math.round(overflow),
                  fade: el.classList.contains('has-fade-end') || el.classList.contains('has-fade-start'),
                  gapAtEdge: gapAtEdge === null ? null : Math.round(gapAtEdge),
                };
              });
          });

          for (const bar of bars) {
            seen += 1;
            if (bar.overflow <= 1) continue;
            overflowed += 1;
            if (!bar.fade) {
              findings.push(`${w}px ${name}: Leiste laeuft ${bar.overflow}px ueber, traegt aber `
                + `keinen Scroll-Fade (wireScrollFade nicht verdrahtet oder eps zu grob) - ${bar.cls}`);
            }
            if (bar.gapAtEdge !== null && bar.gapAtEdge > 12) {
              findings.push(`${w}px ${name}: ${bar.gapAtEdge}px Leerraum vor der Endkante - der `
                + `12px-Fade faded Leere, das naechste Werkzeug ist unauffindbar - ${bar.cls}`);
            }
          }
        }
        await page.close();
      }

      // Eine Sonde, die nichts gemessen hat, darf nicht urteilen (Muster
      // Sonde 15): gezaehlt werden GEFUNDENE Leisten ueber beide Breiten.
      assert.ok(seen >= 14,
        `Nur ${seen} Kopf-Leisten gefunden - erwartet sind mindestens 14 (sieben Leisten `
        + 'mal zwei Breiten). Hat sich die Schreibweise der Tablists geaendert?');

      // Und die Gegenrichtung: mindestens eine Leiste MUSS bei 375px
      // ueberlaufen (die Budget-Tabs tragen 600px Inhalt) - findet die Sonde
      // keinen einzigen Ueberlauf, misst sie den Anschnitt an nichts und die
      // zweite Zusicherung ist leer.
      assert.ok(overflowed > 0,
        'Keine einzige ueberlaufende Kopf-Leiste gefunden - die Anschnitt-Zusicherung '
        + 'hat nichts gemessen. Rendert der Seed noch alle Budget-Tabs?');

      assert.deepEqual(findings, [],
        'Eine ueberlaufende Kopf-Leiste zeigt ihre Fortsetzung: Scroll-Fade plus sichtbar '
        + 'angeschnittenes naechstes Werkzeug (Werkzeugzeilen-Regel).\n  '
        + findings.join('\n  '));
    });
  }
});
// Notes probes deliberately live at the existing end-of-file boundary. #1055
// also adds a browser block immediately after the shared after() hook; keeping
// this complete independent block here avoids a placement-only merge conflict.
function holdNextRequest(page, { method, pathname, label }) {
  let request = null;
  let settled = false;
  let actionInFlight = false;
  let responseAbort = null;
  let markSeen;
  const captured = new Promise((resolve) => { markSeen = resolve; });
  page.__yuvomiRequestInterceptor = (candidate) => {
    if (
      !request
      && candidate.method() === method
      && new URL(candidate.url()).pathname === pathname
    ) {
      request = candidate;
      markSeen();
      return true;
    }
    return false;
  };
  const waitForCapture = async () => {
    let timeout;
    try {
      return await Promise.race([
        captured,
        new Promise((_, reject) => {
          timeout = setTimeout(
            () => reject(new Error(`${label} was not captured within 5 seconds`)),
            5000,
          );
        }),
      ]);
    } finally {
      clearTimeout(timeout);
    }
  };
  const finish = async (action, ...args) => {
    if (settled) return;
    if (actionInFlight) throw new Error(`${label} release is already in progress`);
    if (!request) await waitForCapture();
    actionInFlight = true;
    page.__yuvomiRequestInterceptor = null;
    // Register before releasing the intercepted request: `request.continue()`
    // only starts the network operation. The async predicate also consumes the
    // body, so fulfillment means the complete response reached Chromium rather
    // than only its headers. Attach both handlers immediately: if continue() or
    // respond() rejects, cancelling this waiter must never leave a later timeout
    // as an unhandled rejection.
    const controller = new AbortController();
    responseAbort = controller;
    const responseCompleted = page.waitForResponse(
      async (response) => {
        if (response.request() !== request) return false;
        await response.buffer();
        return true;
      },
      { timeout: 5000, signal: controller.signal },
    ).then(
      (response) => ({ response, error: null }),
      (error) => ({ response: null, error }),
    );
    try {
      try {
        await request[action](...args);
      } catch (actionError) {
        controller.abort();
        await responseCompleted;
        throw actionError;
      }
      const outcome = await responseCompleted;
      if (outcome.error) throw outcome.error;
      settled = true;
      return outcome.response;
    } finally {
      actionInFlight = false;
      responseAbort = null;
    }
  };
  return {
    get seen() { return waitForCapture(); },
    release: () => finish('continue'),
    respond: (response) => finish('respond', response),
    reject: () => finish('respond', {
      status: 500,
      contentType: 'application/json',
      body: JSON.stringify({ error: `${label} delayed failure` }),
    }),
    async dispose() {
      page.__yuvomiRequestInterceptor = null;
      responseAbort?.abort();
      if (settled) return;
      if (request) await request.abort();
      settled = true;
    },
  };
}

function holdNextNoteCategoryCreate(page) {
  return holdNextRequest(page, {
    method: 'POST',
    pathname: '/api/v1/notes/categories',
    label: 'note category POST',
  });
}

function holdNextNoteSave(page, { method = 'POST', noteId = null } = {}) {
  return holdNextRequest(page, {
    method,
    pathname: noteId === null ? '/api/v1/notes' : `/api/v1/notes/${noteId}`,
    label: `${method} note save`,
  });
}

async function openReadyNoteModal(page) {
  await page.click('#notes-add-btn');
  await page.waitForSelector('#note-content');
  // Shared-modal initialization applies its first focus after 50 ms and takes
  // the dirty baseline after 150 ms. The 300 ms barrier includes both timers
  // before Puppeteer's real keyboard events start moving through the fields.
  await new Promise((resolve) => setTimeout(resolve, 300));
}

async function activateNoteSave(page) {
  // These probes exercise save ownership and request ordering, not toast
  // geometry. A due reminder can legitimately cover the button's screen
  // coordinates depending on the wall-clock date. HTMLElement.click() still
  // drives the real control, respects its disabled state, and keeps the probe
  // independent of unrelated seed reminders.
  assert.equal(await page.$eval('#note-modal-save', (button) => {
    if (button.disabled) return false;
    button.click();
    return true;
  }), true, 'the note save button must be enabled before activation');
}

async function typeExactly(page, selector, value) {
  await page.type(selector, value);
  assert.equal(await page.$eval(selector, (field) => field.value), value);
}

async function replaceExactly(page, selector, value) {
  await page.focus(selector);
  // Puppeteer's keyboard shortcuts do not select all on macOS; the editing
  // command does on every platform.
  const modifier = process.platform === 'darwin' ? 'Meta' : 'Control';
  await page.keyboard.down(modifier);
  await page.keyboard.press('KeyA', { commands: ['SelectAll'] });
  await page.keyboard.up(modifier);
  const length = await page.$eval(selector, (field) => field.value.length);
  assert.deepEqual(
    await page.$eval(selector, (field) => [field.selectionStart, field.selectionEnd]),
    [0, length],
    `select-all did not select the whole value of ${selector}`,
  );
  await page.type(selector, value);
  assert.equal(await page.$eval(selector, (field) => field.value), value);
}

async function openExistingNoteEditor(page, noteId) {
  await page.click(`.note-card[data-id="${noteId}"] .note-card__open`);
  await page.waitForSelector('#note-content');
  await new Promise((resolve) => setTimeout(resolve, 300));
  await page.click('.note-mode-switch [data-view="edit"]');
  await page.waitForSelector('#note-pane-edit:not([hidden])');
}

async function discardOpenNoteEditor(page) {
  await page.keyboard.press('Escape');
  await page.waitForSelector('#confirm-modal-ok');
  await page.click('#confirm-modal-ok');
  await page.waitForFunction(() => !document.querySelector('.note-modal'));
}

async function clearMatchingToast(page, { tone, text }) {
  await page.evaluate(({ tone: expectedTone, text: expectedText }) => {
    for (const toast of document.querySelectorAll(`.toast--${expectedTone}`)) {
      if (toast.querySelector('span')?.textContent === expectedText) toast.remove();
    }
  }, { tone, text });
}

async function waitForMatchingToast(page, { tone, text }) {
  await page.waitForFunction(({ tone: expectedTone, text: expectedText }) => (
    [...document.querySelectorAll(`.toast--${expectedTone}`)]
      .some((toast) => toast.querySelector('span')?.textContent === expectedText)
  ), {}, { tone, text });
}

test('eine unbenutzte Request-Sperre laesst sich ohne Warten entsorgen', async () => {
  const page = {};
  const hold = holdNextNoteCategoryCreate(page);
  const disposed = await Promise.race([
    hold.dispose().then(() => true),
    new Promise((resolve) => setTimeout(() => resolve(false), 50)),
  ]);

  assert.equal(disposed, true, 'dispose must not wait for a request that never started');
  assert.equal(page.__yuvomiRequestInterceptor, null);
});

for (const action of ['continue', 'respond']) {
  test(`eine bei ${action} gescheiterte Request-Sperre bricht die gehaltene Anfrage ab`, async () => {
    let aborted = false;
    const page = {
      waitForResponse: (_predicate, { signal }) => new Promise((_, reject) => {
        const timeout = setTimeout(() => reject(new Error('response timeout')), 5000);
        signal.addEventListener('abort', () => {
          clearTimeout(timeout);
          reject(new Error('response wait aborted'));
        }, { once: true });
      }),
    };
    const request = {
      method: () => 'POST',
      url: () => 'http://127.0.0.1/api/v1/notes/categories',
      [action]: async () => { throw new Error(`${action} action failed`); },
      abort: async () => { aborted = true; },
    };
    const hold = holdNextNoteCategoryCreate(page);
    assert.equal(page.__yuvomiRequestInterceptor(request), true);

    const startedAt = Date.now();
    await assert.rejects(action === 'continue' ? hold.release() : hold.reject(), {
      message: `${action} action failed`,
    });
    assert.ok(Date.now() - startedAt < 100, 'failed release must cancel its five-second response waiter');
    await hold.dispose();

    assert.equal(aborted, true, 'a failed release attempt must remain disposable');
  });
}

test('eine freigegebene Request-Sperre wartet auf den vollstaendigen Response-Body', async () => {
  let finishBody;
  const bodyComplete = new Promise((resolve) => { finishBody = resolve; });
  let request;
  const page = {
    waitForResponse: async (predicate) => {
      const response = {
        request: () => request,
        buffer: () => bodyComplete,
      };
      return (await predicate(response)) ? response : null;
    },
  };
  request = {
    method: () => 'POST',
    url: () => 'http://127.0.0.1/api/v1/notes/categories',
    continue: async () => {},
    abort: async () => {},
  };
  const hold = holdNextNoteCategoryCreate(page);
  assert.equal(page.__yuvomiRequestInterceptor(request), true);

  const released = hold.release().then(() => true);
  assert.equal(await Promise.race([
    released,
    new Promise((resolve) => setTimeout(() => resolve(false), 20)),
  ]), false, 'response headers alone must not complete release');

  finishBody();
  assert.equal(await released, true);
});

async function removeNoteProbeRecords(page, { titles, categoryNames }) {
  await page.evaluate(async (fixture) => {
    const { api } = await import('/api.js');
    const notes = (await api.get('/notes')).data;
    for (const note of notes.filter(({ title }) => fixture.titles.includes(title))) {
      await api.delete(`/notes/${note.id}`);
    }
    const categories = (await api.get('/notes/categories')).data;
    for (const category of categories.filter(({ name }) => fixture.categoryNames.includes(name))) {
      await api.delete(`/notes/categories/${category.id}`);
    }
  }, { titles, categoryNames });
}

test('Sonde 21 - Notiz-Kategorien behalten Fokus, Gruppenrolle und Reader-Icons', async () => {
  const page = await openPage(harness, { device: 'desktop', locale: 'en' });
  const fixtureName = `Sonde 21 ${randomUUID()}`;
  const categoryIds = [];
  let noteId = null;
  let probeError = null;
  try {
    const first = await page.evaluate(async (name) => {
      const { api } = await import('/api.js');
      return (await api.post('/notes/categories', {
        name: `${name} one`,
        scope: 'personal',
      })).data;
    }, fixtureName);
    categoryIds.push(first.id);
    const second = await page.evaluate(async (name) => {
      const { api } = await import('/api.js');
      return (await api.post('/notes/categories', {
        name: `${name} two`,
        scope: 'personal',
      })).data;
    }, fixtureName);
    categoryIds.push(second.id);
    const note = await page.evaluate(async ({ name, ids }) => {
      const { api } = await import('/api.js');
      return (await api.post('/notes', {
        title: name,
        content: 'Reader icons survive repeated pane replacement.',
        category_ids: ids,
      })).data;
    }, { name: fixtureName, ids: categoryIds });
    noteId = note.id;

    await gotoRoute(page, '/notes');
    await page.waitForSelector(`[data-category-id="${first.id}"]`);
    await page.$eval(`[data-category-id="${first.id}"]`, (chip) => {
      chip.focus();
      chip.click();
    });
    await page.waitForFunction(
      (id) => document.activeElement?.dataset.categoryId === String(id),
      {},
      first.id,
    );
    const focusState = await page.evaluate(() => ({
      focusedCategory: document.activeElement?.dataset.categoryId ?? null,
      categoryPressed: document.activeElement?.getAttribute('aria-pressed') ?? null,
    }));

    await page.click(`.note-card[data-id="${noteId}"] .note-card__open`);
    await page.waitForSelector('.note-modal[data-view="read"]');
    const readTurns = [];
    for (let turn = 0; turn < 2; turn += 1) {
      await page.click('.note-mode-switch [data-view="edit"]');
      await page.click('.note-mode-switch [data-view="read"]');
      readTurns.push(await page.evaluate(() => ({
        icons: document.querySelectorAll('.note-read__categories svg').length,
        placeholders: document.querySelectorAll('.note-read__categories i[data-lucide]').length,
      })));
    }

    const actual = await page.evaluate(({ noteId }) => ({
      outerFilterLabel: document.querySelector('#notes-filters')?.getAttribute('aria-label'),
      cardRole: document.querySelector(`.note-card[data-id="${noteId}"] .note-card__categories`)?.getAttribute('role'),
      readRole: document.querySelector('.note-read__categories')?.getAttribute('role'),
    }), { noteId });

    assert.deepEqual({ ...focusState, ...actual, readTurns }, {
      focusedCategory: String(first.id),
      categoryPressed: 'true',
      outerFilterLabel: null,
      cardRole: 'group',
      readRole: 'group',
      readTurns: [
        { icons: 2, placeholders: 0 },
        { icons: 2, placeholders: 0 },
      ],
    });
  } catch (err) {
    probeError = err;
  } finally {
    const cleanupErrors = [];
    if (noteId !== null) {
      try {
        await page.evaluate(async (id) => {
          const { api } = await import('/api.js');
          await api.delete(`/notes/${id}`);
        }, noteId);
      } catch (err) {
        cleanupErrors.push(err);
      }
    }
    for (const id of categoryIds) {
      try {
        await page.evaluate(async (categoryId) => {
          const { api } = await import('/api.js');
          await api.delete(`/notes/categories/${categoryId}`);
        }, id);
      } catch (err) {
        cleanupErrors.push(err);
      }
    }
    try {
      await page.evaluate(async ({ expectedNoteId, expectedCategoryIds }) => {
        const { api } = await import('/api.js');
        const [notes, categories] = await Promise.all([
          api.get('/notes'),
          api.get('/notes/categories'),
        ]);
        if (expectedNoteId !== null && notes.data.some(({ id }) => id === expectedNoteId)) {
          throw new Error(`note ${expectedNoteId} survived Sonde 21 cleanup`);
        }
        const survivors = categories.data
          .filter(({ id }) => expectedCategoryIds.includes(id))
          .map(({ id }) => id);
        if (survivors.length) {
          throw new Error(`categories ${survivors.join(', ')} survived Sonde 21 cleanup`);
        }
      }, { expectedNoteId: noteId, expectedCategoryIds: categoryIds });
    } catch (err) {
      cleanupErrors.push(err);
    }
    try {
      await page.close();
    } catch (err) {
      cleanupErrors.push(err);
    }
    if (cleanupErrors.length) {
      throw new AggregateError(
        probeError ? [probeError, ...cleanupErrors] : cleanupErrors,
        'Sonde 21 cleanup failed',
      );
    }
  }
  if (probeError) throw probeError;
});
test('Sonde 22 - Anlegen einer Kategorie blockiert Speichern und beruehrt keinen Ersatzdialog', async () => {
  const page = await openPage(harness, { device: 'desktop', locale: 'en' });
  const suffix = randomUUID();
  const savedTitle = `Sonde 22 saved ${suffix}`;
  const savedCategory = `Sonde 22 assigned ${suffix}`;
  const failedCategory = `Sonde 22 failed ${suffix}`;
  const closedCategory = `Sonde 22 closed ${suffix}`;
  const replacementTitle = `Sonde 22 replacement ${suffix}`;
  const replacementContent = 'Replacement content must keep its exact value and focus.';
  const noteApiResponses = [];
  const recordNoteApiResponse = (response) => {
    const url = new URL(response.url());
    if (url.pathname.startsWith('/api/v1/notes')) {
      noteApiResponses.push({ method: response.request().method(), path: url.pathname, status: response.status() });
    }
  };
  page.on('response', recordNoteApiResponse);
  let heldRequest = null;
  let probeError = null;
  try {
    await gotoRoute(page, '/notes');
    await openReadyNoteModal(page);
    await typeExactly(page, '#note-title', savedTitle);
    await typeExactly(page, '#note-content', 'The delayed category must be assigned before this note is saved.');
    await typeExactly(page, '#note-category-search', savedCategory);
    await page.waitForSelector('#note-category-create:not([hidden])');

    heldRequest = holdNextNoteCategoryCreate(page);
    await page.click('#note-category-create');
    await heldRequest.seen;
    assert.deepEqual(await page.evaluate(() => ({
      createDisabled: document.querySelector('#note-category-create')?.disabled,
      saveDisabled: document.querySelector('#note-modal-save')?.disabled,
    })), { createDisabled: true, saveDisabled: true });

    await page.$eval('#note-modal-save', (button) => {
      button.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    await new Promise((resolve) => setTimeout(resolve, 100));
    assert.equal(await page.evaluate(async (title) => {
      const { api } = await import('/api.js');
      return (await api.get('/notes')).data.some((note) => note.title === title);
    }, savedTitle), false, 'a programmatic Save must not bypass the pending category create');

    await heldRequest.release();
    heldRequest = null;
    await page.waitForSelector(`[data-selected-category-id] .note-category-selection__name`);
    await page.waitForFunction(() => !document.querySelector('#note-modal-save')?.disabled);
    await activateNoteSave(page);
    await page.waitForSelector('#shared-modal-overlay', { hidden: true });

    const persisted = await page.evaluate(async ({ title, categoryName }) => {
      const { api } = await import('/api.js');
      const note = (await api.get('/notes')).data.find((item) => item.title === title);
      const category = (await api.get('/notes/categories')).data.find((item) => item.name === categoryName);
      return {
        noteFound: !!note,
        categoryFound: !!category,
        assigned: !!note?.categories?.some(({ id }) => id === category?.id),
      };
    }, { title: savedTitle, categoryName: savedCategory });
    assert.deepEqual(persisted, { noteFound: true, categoryFound: true, assigned: true });

    await openReadyNoteModal(page);
    await typeExactly(page, '#note-content', 'A failed category request must unlock this editor.');
    await typeExactly(page, '#note-category-search', failedCategory);
    await page.waitForSelector('#note-category-create:not([hidden])');
    heldRequest = holdNextNoteCategoryCreate(page);
    await page.click('#note-category-create');
    await heldRequest.seen;
    await heldRequest.reject();
    heldRequest = null;
    await page.waitForFunction(() => (
      !document.querySelector('#note-category-create')?.disabled
      && !document.querySelector('#note-modal-save')?.disabled
    ));
    assert.equal(await page.evaluate(async (name) => {
      const { api } = await import('/api.js');
      return (await api.get('/notes/categories')).data.some((category) => category.name === name);
    }, failedCategory), false);
    await page.evaluate(async () => {
      const { closeModal } = await import('/components/modal.js');
      await closeModal({ force: true });
    });

    await openReadyNoteModal(page);
    await typeExactly(page, '#note-content', 'This editor will close while its category request is pending.');
    await typeExactly(page, '#note-category-search', closedCategory);
    await page.waitForSelector('#note-category-create:not([hidden])');
    await page.evaluate(() => {
      const choices = document.querySelector('#note-category-choices');
      window.__sonde22DetachedMutations = 0;
      new MutationObserver((records) => {
        window.__sonde22DetachedMutations += records.length;
      }).observe(choices, { childList: true, subtree: true });
    });

    heldRequest = holdNextNoteCategoryCreate(page);
    await page.click('#note-category-create');
    await heldRequest.seen;
    await page.evaluate(async () => {
      const { closeModal } = await import('/components/modal.js');
      await closeModal({ force: true });
    });
    await openReadyNoteModal(page);
    await typeExactly(page, '#note-title', replacementTitle);
    await typeExactly(page, '#note-content', replacementContent);
    await page.focus('#note-content');
    const replacementBefore = await page.evaluate(() => ({
      open: document.querySelector('.note-modal')?.isConnected ?? false,
      title: document.querySelector('#note-title')?.value,
      content: document.querySelector('#note-content')?.value,
      focus: document.activeElement?.id,
    }));

    await heldRequest.release();
    heldRequest = null;
    const closedCategoryPersisted = await page.evaluate(async (name) => {
      const { api } = await import('/api.js');
      return (await api.get('/notes/categories')).data.some((category) => category.name === name);
    }, closedCategory);
    assert.equal(closedCategoryPersisted, true);
    await new Promise((resolve) => setTimeout(resolve, 100));
    const replacementAfter = await page.evaluate(() => ({
      open: document.querySelector('.note-modal')?.isConnected ?? false,
      title: document.querySelector('#note-title')?.value,
      content: document.querySelector('#note-content')?.value,
      focus: document.activeElement?.id,
      detachedMutations: window.__sonde22DetachedMutations,
    }));
    assert.deepEqual(replacementAfter, {
      ...replacementBefore,
      detachedMutations: 0,
    });
  } catch (err) {
    probeError = err;
  } finally {
    const cleanupErrors = [];
    if (heldRequest) {
      try {
        await heldRequest.dispose();
      } catch (err) {
        cleanupErrors.push(err);
      }
    }
    try {
      await removeNoteProbeRecords(page, {
        titles: [savedTitle, replacementTitle],
        categoryNames: [savedCategory, closedCategory],
      });
    } catch (err) {
      cleanupErrors.push(err);
    }
    try {
      const rateLimited = noteApiResponses.filter(({ status }) => status === 429);
      const categoryReads = noteApiResponses.filter(({ method, path }) => (
        method === 'GET' && path === '/api/v1/notes/categories'
      ));
      if (process.env.SONDE_REQUEST_COUNTS === '1') {
        console.log(`Sonde 22 request counts: total=${noteApiResponses.length}, categoryGET=${categoryReads.length}, 429=${rateLimited.length}`);
      }
      assert.deepEqual(rateLimited, [], `Sonde 22 received 429 responses: ${JSON.stringify(rateLimited)}`);
      assert.ok(categoryReads.length <= 6,
        `Sonde 22 used ${categoryReads.length} category GETs; bounded budget is 6`);
      assert.ok(noteApiResponses.length <= 24,
        `Sonde 22 used ${noteApiResponses.length} Notes API responses; bounded budget is 24`);
    } catch (err) {
      cleanupErrors.push(err);
    }
    page.off('response', recordNoteApiResponse);
    try {
      await page.close();
    } catch (err) {
      cleanupErrors.push(err);
    }
    if (cleanupErrors.length) {
      throw new AggregateError(
        probeError ? [probeError, ...cleanupErrors] : cleanupErrors,
        'Sonde 22 cleanup failed',
      );
    }
  }
  if (probeError) throw probeError;
});

test('Sonde 23 - spaete Notizantworten respektieren Ersatz- und Bestaetigungsdialoge', async () => {
  const page = await openPage(harness, { device: 'desktop', locale: 'en' });
  const suffix = randomUUID();
  const successTitle = `Sonde 23 late success ${suffix}`;
  const successContent = 'A completed delayed POST must persist without closing a replacement.';
  const successReplacementTitle = `Sonde 23 success replacement ${suffix}`;
  const failureFixtureTitle = `Sonde 23 PUT fixture ${suffix}`;
  const failureReplacementTitle = `Sonde 23 failure replacement ${suffix}`;
  const replacementContent = 'Unrelated replacement content must stay exact and focused.';
  const retryContent = 'An in-place failed PUT can be retried without losing these exact characters.';
  const confirmationTitle = `Sonde 23 confirmation ${suffix}`;
  const confirmationContent = 'A delayed success must not answer the discard question for the user.';
  const cleanupTitles = [
    successTitle,
    successReplacementTitle,
    failureFixtureTitle,
    failureReplacementTitle,
    confirmationTitle,
  ];
  const noteApiResponses = [];
  const recordNoteApiResponse = (response) => {
    const url = new URL(response.url());
    if (url.pathname.startsWith('/api/v1/notes')) {
      noteApiResponses.push({ method: response.request().method(), path: url.pathname, status: response.status() });
    }
  };
  page.on('response', recordNoteApiResponse);
  let heldRequest = null;
  let probeError = null;
  try {
    await gotoRoute(page, '/notes');

    // A late successful POST belongs to this original editor, not to whichever
    // modal occupies the shared slot when the response finally arrives.
    await openReadyNoteModal(page);
    await typeExactly(page, '#note-title', successTitle);
    await typeExactly(page, '#note-content', successContent);
    await clearMatchingToast(page, { tone: 'success', text: 'Note created' });
    heldRequest = holdNextNoteSave(page);
    await activateNoteSave(page);
    await heldRequest.seen;
    await discardOpenNoteEditor(page);
    await openReadyNoteModal(page);
    await typeExactly(page, '#note-title', successReplacementTitle);
    await typeExactly(page, '#note-content', replacementContent);
    await page.focus('#note-content');
    await heldRequest.release();
    heldRequest = null;
    await waitForMatchingToast(page, { tone: 'success', text: 'Note created' });

    const afterLateSuccess = await page.evaluate(() => ({
      replacementOpen: document.querySelector('.note-modal')?.isConnected ?? false,
      title: document.querySelector('#note-title')?.value,
      content: document.querySelector('#note-content')?.value,
      focus: document.activeElement?.id,
    }));
    assert.deepEqual(afterLateSuccess, {
      replacementOpen: true,
      title: successReplacementTitle,
      content: replacementContent,
      focus: 'note-content',
    });
    const savedPost = await page.evaluate(async (title) => {
      const { api } = await import('/api.js');
      return (await api.get('/notes')).data.find((note) => note.title === title) ?? null;
    }, successTitle);
    assert.equal(savedPost?.content, successContent);

    await page.evaluate(async () => {
      const { closeModal } = await import('/components/modal.js');
      await closeModal({ force: true });
    });
    await page.waitForFunction(() => !document.querySelector('.note-modal'));

    // Exercise the PUT path independently. Its late failure must remain globally
    // visible after the originating editor was discarded, without mutating the
    // replacement editor's values, focus, or controls.
    const failureFixture = await page.evaluate(async ({ title, content }) => {
      const { api } = await import('/api.js');
      return (await api.post('/notes', { title, content })).data;
    }, { title: failureFixtureTitle, content: 'Original PUT fixture content.' });
    await gotoRoute(page, '/notes');
    await openExistingNoteEditor(page, failureFixture.id);
    await replaceExactly(page, '#note-content', 'This PUT is expected to fail after its editor closes.');
    await clearMatchingToast(page, { tone: 'danger', text: 'PUT note save delayed failure' });
    heldRequest = holdNextNoteSave(page, { method: 'PUT', noteId: failureFixture.id });
    await activateNoteSave(page);
    await heldRequest.seen;
    await discardOpenNoteEditor(page);
    await openReadyNoteModal(page);
    await typeExactly(page, '#note-title', failureReplacementTitle);
    await typeExactly(page, '#note-content', replacementContent);
    await page.focus('#note-content');
    await heldRequest.reject();
    heldRequest = null;
    await waitForMatchingToast(page, { tone: 'danger', text: 'PUT note save delayed failure' });

    const afterLateFailure = await page.evaluate((errorText) => ({
      replacementOpen: document.querySelector('.note-modal')?.isConnected ?? false,
      title: document.querySelector('#note-title')?.value,
      content: document.querySelector('#note-content')?.value,
      focus: document.activeElement?.id,
      errorVisible: [...document.querySelectorAll('.toast--danger')]
        .some((toast) => toast.textContent.includes(errorText)),
    }), 'PUT note save delayed failure');
    assert.deepEqual(afterLateFailure, {
      replacementOpen: true,
      title: failureReplacementTitle,
      content: replacementContent,
      focus: 'note-content',
      errorVisible: true,
    });
    const afterRejectedPut = await page.evaluate(async (id) => {
      const { api } = await import('/api.js');
      return (await api.get('/notes')).data.find((note) => note.id === id) ?? null;
    }, failureFixture.id);
    assert.equal(afterRejectedPut?.content, 'Original PUT fixture content.');

    await page.evaluate(async () => {
      const { closeModal } = await import('/components/modal.js');
      await closeModal({ force: true });
    });
    await page.waitForFunction(() => !document.querySelector('.note-modal'));

    // Preserve the established in-place recovery contract as the stale-editor
    // guards get stricter: the same editor unlocks and a real retry persists.
    await gotoRoute(page, '/notes');
    await openExistingNoteEditor(page, failureFixture.id);
    await replaceExactly(page, '#note-content', retryContent);
    await clearMatchingToast(page, { tone: 'danger', text: 'PUT note save delayed failure' });
    heldRequest = holdNextNoteSave(page, { method: 'PUT', noteId: failureFixture.id });
    await activateNoteSave(page);
    await heldRequest.seen;
    await heldRequest.reject();
    heldRequest = null;
    await waitForMatchingToast(page, { tone: 'danger', text: 'PUT note save delayed failure' });
    await page.waitForFunction(() => !document.querySelector('#note-modal-save')?.disabled);
    assert.deepEqual(await page.evaluate(() => ({
      open: document.querySelector('.note-modal')?.isConnected ?? false,
      content: document.querySelector('#note-content')?.value,
      saveDisabled: document.querySelector('#note-modal-save')?.disabled,
    })), { open: true, content: retryContent, saveDisabled: false });

    await clearMatchingToast(page, { tone: 'success', text: 'Note saved' });
    heldRequest = holdNextNoteSave(page, { method: 'PUT', noteId: failureFixture.id });
    await activateNoteSave(page);
    await heldRequest.seen;
    await heldRequest.release();
    heldRequest = null;
    await waitForMatchingToast(page, { tone: 'success', text: 'Note saved' });
    await page.waitForFunction(() => !document.querySelector('.note-modal'));
    const afterRetry = await page.evaluate(async (id) => {
      const { api } = await import('/api.js');
      return (await api.get('/notes')).data.find((note) => note.id === id) ?? null;
    }, failureFixture.id);
    assert.equal(afterRetry?.content, retryContent);

    // A dirty-close confirmation temporarily parks the editor without detaching
    // it. A successful response must not force-close that active question. If
    // the user cancels the discard, normal successful-save closure resumes only
    // after the editor owns the shared modal slot again.
    await gotoRoute(page, '/notes');
    await openReadyNoteModal(page);
    await typeExactly(page, '#note-title', confirmationTitle);
    await typeExactly(page, '#note-content', confirmationContent);
    await clearMatchingToast(page, { tone: 'success', text: 'Note created' });
    heldRequest = holdNextNoteSave(page);
    await activateNoteSave(page);
    await heldRequest.seen;
    await page.keyboard.press('Escape');
    await page.waitForSelector('#confirm-modal-cancel');
    assert.deepEqual(await page.evaluate(() => ({
      confirmationOpen: document.querySelector('#confirm-modal-cancel')?.isConnected ?? false,
      originalConnected: document.querySelector('.note-modal')?.isConnected ?? false,
      originalInert: document.querySelector('.note-modal')?.closest('.modal-overlay')?.inert ?? false,
    })), { confirmationOpen: true, originalConnected: true, originalInert: true });

    await heldRequest.release();
    heldRequest = null;
    await waitForMatchingToast(page, { tone: 'success', text: 'Note created' });
    assert.deepEqual(await page.evaluate(() => ({
      confirmationOpen: document.querySelector('#confirm-modal-cancel')?.isConnected ?? false,
      originalConnected: document.querySelector('.note-modal')?.isConnected ?? false,
      originalInert: document.querySelector('.note-modal')?.closest('.modal-overlay')?.inert ?? false,
    })), { confirmationOpen: true, originalConnected: true, originalInert: true });
    await page.click('#confirm-modal-cancel');
    await page.waitForFunction(() => !document.querySelector('.note-modal'));
    const confirmationSave = await page.evaluate(async (title) => {
      const { api } = await import('/api.js');
      return (await api.get('/notes')).data.find((note) => note.title === title) ?? null;
    }, confirmationTitle);
    assert.equal(confirmationSave?.content, confirmationContent);
  } catch (err) {
    probeError = err;
  } finally {
    const cleanupErrors = [];
    if (heldRequest) {
      try {
        await heldRequest.dispose();
      } catch (err) {
        cleanupErrors.push(err);
      }
    }
    try {
      await page.evaluate(async () => {
        const { closeModal } = await import('/components/modal.js');
        await closeModal({ force: true });
      });
    } catch (err) {
      cleanupErrors.push(err);
    }
    try {
      await removeNoteProbeRecords(page, { titles: cleanupTitles, categoryNames: [] });
    } catch (err) {
      cleanupErrors.push(err);
    }
    try {
      const rateLimited = noteApiResponses.filter(({ status }) => status === 429);
      if (process.env.SONDE_REQUEST_COUNTS === '1') {
        console.log(`Sonde 23 request counts: total=${noteApiResponses.length}, 429=${rateLimited.length}`);
      }
      assert.deepEqual(rateLimited, [], `Sonde 23 received 429 responses: ${JSON.stringify(rateLimited)}`);
      assert.ok(noteApiResponses.length <= 32,
        `Sonde 23 used ${noteApiResponses.length} Notes API responses; bounded budget is 32`);
    } catch (err) {
      cleanupErrors.push(err);
    }
    page.off('response', recordNoteApiResponse);
    try {
      await page.close();
    } catch (err) {
      cleanupErrors.push(err);
    }
    if (cleanupErrors.length) {
      throw new AggregateError(
        probeError ? [probeError, ...cleanupErrors] : cleanupErrors,
        'Sonde 23 cleanup failed',
      );
    }
  }
  if (probeError) throw probeError;
});

test('Sonde 24 - spaeter Umbenennungskonflikt ersetzt keinen neuen Notizeditor', async () => {
  const page = await openPage(harness, { device: 'desktop', locale: 'en' });
  const suffix = randomUUID();
  const renamedCategory = `Sonde 24 renamed ${suffix}`;
  const conflictingCategory = `Sonde 24 conflict ${suffix}`;
  const replacementTitle = `Sonde 24 replacement ${suffix}`;
  const replacementContent = 'A stale rename retry must not replace this unsaved note.';
  const conflictError = 'Sonde 24 delayed rename conflict';
  let heldRequest = null;
  let probeError = null;
  try {
    await gotoRoute(page, '/notes');
    const categoryIds = await page.evaluate(async ({ firstName, secondName }) => {
      const { api } = await import('/api.js');
      const first = await api.post('/notes/categories', { name: firstName, scope: 'personal' });
      const second = await api.post('/notes/categories', { name: secondName, scope: 'personal' });
      return [first.data.id, second.data.id];
    }, { firstName: renamedCategory, secondName: conflictingCategory });
    await gotoRoute(page, '/notes');

    await page.click('#notes-manage-categories');
    await page.waitForSelector(`yuvomi-category-manager .cat-row[data-key="${categoryIds[0]}"]`);
    await page.click(`yuvomi-category-manager .cat-row[data-key="${categoryIds[0]}"] .cat-row__name`);
    await page.waitForSelector('#prompt-modal-input');
    await new Promise((resolve) => setTimeout(resolve, 300));
    await replaceExactly(page, '#prompt-modal-input', conflictingCategory);
    await clearMatchingToast(page, { tone: 'danger', text: conflictError });
    heldRequest = holdNextRequest(page, {
      method: 'PUT',
      pathname: `/api/v1/notes/categories/${categoryIds[0]}`,
      label: 'note category rename PUT',
    });
    await page.click('#prompt-modal-ok');
    await heldRequest.seen;

    await openReadyNoteModal(page);
    await typeExactly(page, '#note-title', replacementTitle);
    await typeExactly(page, '#note-content', replacementContent);
    await page.focus('#note-content');
    const replacementBefore = await page.evaluate(() => ({
      open: document.querySelector('.note-modal')?.isConnected ?? false,
      title: document.querySelector('#note-title')?.value,
      content: document.querySelector('#note-content')?.value,
      focus: document.activeElement?.id,
    }));

    await heldRequest.respond({
      status: 409,
      contentType: 'application/json',
      body: JSON.stringify({ error: conflictError, code: 409 }),
    });
    heldRequest = null;
    await waitForMatchingToast(page, { tone: 'danger', text: conflictError });

    assert.deepEqual(await page.evaluate(() => ({
      open: document.querySelector('.note-modal')?.isConnected ?? false,
      title: document.querySelector('#note-title')?.value,
      content: document.querySelector('#note-content')?.value,
      focus: document.activeElement?.id,
      renamePromptOpen: document.querySelector('#prompt-modal-input')?.isConnected ?? false,
    })), { ...replacementBefore, renamePromptOpen: false });
  } catch (err) {
    probeError = err;
  } finally {
    const cleanupErrors = [];
    if (heldRequest) {
      try {
        await heldRequest.dispose();
      } catch (err) {
        cleanupErrors.push(err);
      }
    }
    try {
      await page.evaluate(async () => {
        const { closeModal } = await import('/components/modal.js');
        await closeModal({ force: true });
      });
    } catch (err) {
      cleanupErrors.push(err);
    }
    try {
      await removeNoteProbeRecords(page, {
        titles: [replacementTitle],
        categoryNames: [renamedCategory, conflictingCategory],
      });
    } catch (err) {
      cleanupErrors.push(err);
    }
    try {
      await page.close();
    } catch (err) {
      cleanupErrors.push(err);
    }
    if (cleanupErrors.length) {
      throw new AggregateError(
        probeError ? [probeError, ...cleanupErrors] : cleanupErrors,
        'Sonde 24 cleanup failed',
      );
    }
  }
  if (probeError) throw probeError;
});
