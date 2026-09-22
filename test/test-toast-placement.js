/**
 * Modul: Toast-Lage ueber offenen Dialogen (#1160) - reine Platzierung + Dialog-Register
 * Zweck: Zwei Zusagen von public/utils/toast-placement.js, die ohne Browser
 *        pruefbar sind.
 *   1. Die Lage, die `chooseToastPlacement` waehlt, liegt IMMER ganz im Bild
 *      (innerhalb der Sicherheitszonen), und sie verdeckt keine Bedienleiste,
 *      solange es irgendeine Lage gibt, die keine verdeckt.
 *   2. Jeder Dialog der App ist hier eingetragen, samt dem Weg, auf dem die
 *      Platzierung seine Bedienleisten findet (Allowlist: ein neuer Dialog ist
 *      rot, bis jemand sagt, wo seine Knoepfe sitzen).
 * Ausfuehren: npm run test:toast-placement
 *
 * ANLASS (Review an #1421): ein Vollbild-Dialog ohne ausgezeichnete Leisten bei
 * 400x600 - die erste Fassung legte den Stapel dann auf `bottom: 612px`, also
 * ganz ueber den oberen Rand. Die Erinnerung war unsichtbar und nicht mehr
 * wegzuklicken, genau das, was #1160 verhindern sollte. Die Pruefung darauf
 * war da (`docked.top >= safeTop`), aber beide Zweige lieferten dieselbe Lage.
 * Deshalb hier kein Einzelfall, sondern Geometrien aus einem festen Zufall,
 * und fuer jede die Gegenrechnung von Hand: jede ganzzahlige Hoehe wird
 * durchprobiert, ob es eine freie Lage gegeben haette.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { chooseToastPlacement } from '../public/utils/toast-placement.js';

const box = (top, left, width, height) => ({
  top, left, width, height, right: left + width, bottom: top + height,
});
const intersects = (a, b) => a.left < b.right && a.right > b.left && a.top < b.bottom && a.bottom > b.top;

/** Das Rechteck, das eine Entscheidung ergibt - oder null fuer "bleibt stehen". */
function placedRect(input, decision) {
  if (!decision) return null;
  const h = input.dockedHeight;
  const left = input.dockedCenter - input.dockedWidth / 2;
  return box(decision.top, left, input.dockedWidth, h);
}

function bounds(input) {
  const minTop = input.safeTop + input.gap;
  const maxBottom = input.viewport.height - input.safeBottom - input.gap;
  return { minTop, maxBottom };
}

/** Gibt es irgendeine Lage im Bild, die keine Bedienleiste verdeckt? Von Hand. */
function someFreeTop(input) {
  const { minTop, maxBottom } = bounds(input);
  const left = input.dockedCenter - input.dockedWidth / 2;
  for (let top = Math.ceil(minTop); top + input.dockedHeight <= maxBottom; top += 1) {
    const r = box(top, left, input.dockedWidth, input.dockedHeight);
    if ((input.keepClear ?? []).some((c) => intersects(r, c))) continue;
    if (!input.zones.some((z) => intersects(r, z))) return top;
  }
  return null;
}

function checkInvariant(input, label) {
  const decision = chooseToastPlacement(input);
  if (!decision) {
    // Stehen bleiben darf er nur, wo er keine Bedienleiste beruehrt.
    const hit = input.zones.find((z) => intersects(input.stack, z));
    assert.equal(hit, undefined, `${label}: bleibt stehen, verdeckt aber eine Bedienleiste`);
    return;
  }
  assert.ok(Number.isFinite(decision.top), `${label}: Oberkante ist keine Zahl`);
  const r = placedRect(input, decision);
  const { minTop, maxBottom } = bounds(input);
  const eps = 0.5;
  if (input.dockedHeight <= maxBottom - minTop) {
    assert.ok(r.top >= minTop - eps && r.bottom <= maxBottom + eps,
      `${label}: Stapel ${Math.round(r.top)}..${Math.round(r.bottom)} liegt nicht in ${minTop}..${maxBottom}`);
  } else {
    // Hoeher als das Bild: dann bleibt wenigstens sein Anfang sichtbar.
    assert.ok(Math.abs(r.top - minTop) <= eps, `${label}: zu hoher Stapel beginnt nicht oben (${r.top})`);
  }
  assert.ok(r.left >= -eps && r.right <= input.viewport.width + eps, `${label}: Stapel ragt seitlich hinaus`);
  // Die Navigation bleibt frei, solange es im Bild ueberhaupt einen Platz neben ihr gibt.
  const { minTop: lo, maxBottom: hi } = bounds(input);
  const roomBesideChrome = (() => {
    for (let top = Math.ceil(lo); top + input.dockedHeight <= hi; top += 1) {
      const probe = box(top, r.left, input.dockedWidth, input.dockedHeight);
      if (!(input.keepClear ?? []).some((c) => intersects(probe, c))) return true;
    }
    return false;
  })();
  if (roomBesideChrome) {
    const hit = (input.keepClear ?? []).find((c) => intersects(r, c));
    assert.equal(hit, undefined, `${label}: Stapel ${Math.round(r.top)}..${Math.round(r.bottom)} liegt auf der Navigation`);
  }
  if (input.zones.some((z) => intersects(r, z))) {
    assert.equal(someFreeTop(input), null,
      `${label}: verdeckt eine Bedienleiste, obwohl bei top=${someFreeTop(input)} Platz war`);
  }
}

test('der Vollbild-Dialog aus dem Review: der Stapel bleibt im Bild (400x600)', () => {
  const dialog = box(0, 0, 400, 600);
  checkInvariant({
    viewport: { width: 400, height: 600 },
    gap: 12,
    safeTop: 0,
    safeBottom: 0,
    stack: box(600 - 16 - 64, 16, 368, 64),
    dockedHeight: 64,
    dockedWidth: 376,
    dockedCenter: 200,
    primary: dialog,
    dialogs: [dialog],
    zones: [dialog],
  }, 'Vollbild ohne Leisten');
});

test('ein Vollbild-Dialog mit Kopf und Fuss: der Stapel liegt dazwischen, nicht darueber', () => {
  const dialog = box(0, 0, 375, 812);
  const header = box(0, 0, 375, 64);
  const footer = box(740, 0, 375, 72);
  const input = {
    viewport: { width: 375, height: 812 },
    gap: 12,
    safeTop: 47,
    safeBottom: 34,
    stack: box(812 - 16 - 66, 16, 343, 66), // liegt auf dem Fuss
    dockedHeight: 66,
    dockedWidth: 343,
    dockedCenter: 187.5,
    primary: dialog,
    dialogs: [dialog],
    zones: [header, footer],
  };
  checkInvariant(input, 'Vollbild mit Leisten');
  const r = placedRect(input, chooseToastPlacement(input));
  assert.ok(r && r.bottom <= footer.top && r.top >= header.bottom, 'zwischen Kopf und Fuss');
});

test('der Popover aus dem Review: der Stapel legt sich nicht auf die untere Navigation (800x900)', () => {
  const popover = box(50, 200, 400, 750);
  const nav = box(824, 0, 800, 76);
  checkInvariant({
    viewport: { width: 800, height: 900 },
    gap: 12,
    safeTop: 0,
    safeBottom: 0,
    stack: box(824 - 16 - 64, 210, 380, 64),
    dockedHeight: 64,
    dockedWidth: 376,
    dockedCenter: 400,
    primary: popover,
    dialogs: [popover],
    zones: [box(740, 200, 400, 60)],
    keepClear: [nav],
  }, 'Popover ueber der Navigation');
});

// Fester Zufall: jeder Lauf prueft dieselben Geometrien, ein roter Fall ist
// damit nachstellbar (die Nummer steht in der Meldung).
function lcg(seed) {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 2 ** 32;
  };
}

test('jede Geometrie: im Bild, und keine Bedienleiste verdeckt, wo es eine freie Lage gibt', () => {
  const rnd = lcg(1160);
  const between = (a, b) => a + (b - a) * rnd();
  for (let i = 0; i < 3000; i += 1) {
    const vw = Math.round(between(320, 1600));
    const vh = Math.round(between(320, 1000));
    const gap = Math.round(between(8, 16));
    const safeTop = rnd() < 0.4 ? Math.round(between(0, 50)) : 0;
    const safeBottom = rnd() < 0.4 ? Math.round(between(0, 40)) : 0;

    const kind = rnd();
    let dialog;
    if (kind < 0.25) {
      dialog = box(0, 0, vw, vh); // Vollbild
    } else if (kind < 0.5) {
      const h = between(vh * 0.4, vh * 0.95); // Sheet von unten
      dialog = box(vh - h, 0, vw, h);
    } else {
      const w = between(Math.min(280, vw), Math.min(960, vw));
      const h = between(120, vh);
      dialog = box((vh - h) / 2, (vw - w) / 2, w, h); // zentriert
    }

    const zones = [];
    const zoneKind = rnd();
    if (zoneKind < 0.2) {
      zones.push(dialog); // keine Leisten erkannt: der ganze Dialog
    } else {
      if (rnd() < 0.8) zones.push(box(dialog.top, dialog.left, dialog.width, Math.min(64, dialog.height / 3)));
      if (rnd() < 0.8) {
        const fh = Math.min(between(48, 120), dialog.height / 3);
        zones.push(box(dialog.bottom - fh, dialog.left, dialog.width, fh));
      }
      if (rnd() < 0.3) {
        const mh = between(30, 80);
        zones.push(box(between(dialog.top, dialog.bottom - mh), dialog.left + 16, dialog.width - 32, mh));
      }
    }

    const width = Math.min(380, vw - 32);
    const h = rnd() < 0.1 ? between(vh * 0.6, vh * 1.4) : between(40, 200);
    const defaultBottom = vh - between(16, 120);
    const stack = box(defaultBottom - h, (vw - width) / 2, width, h);
    const dockedWidth = Math.max(40, Math.min(width, dialog.width - 2 * gap));
    const half = dockedWidth / 2;
    const dockedCenter = Math.min(Math.max(dialog.left + dialog.width / 2, gap + half), vw - gap - half);

    // Eine sichtbare untere Navigation (Telefon, Tablet) in jeder zweiten Welt.
    const keepClear = rnd() < 0.5 ? [box(vh - between(56, 96), 0, vw, vh)] : [];
    checkInvariant({
      viewport: { width: vw, height: vh },
      gap,
      safeTop,
      safeBottom,
      keepClear,
      stack,
      dockedHeight: h,
      dockedWidth,
      dockedCenter,
      primary: dialog,
      dialogs: [dialog],
      zones,
    }, `Geometrie #${i}`);
  }
});

// ------------------------------------------------------------------
// Das Dialog-Register
// ------------------------------------------------------------------

/*
 * JEDER DIALOG DER APP, IN QUELLTEXT-REIHENFOLGE JE DATEI, UND WELCHE LEISTEN ER
 * AUSZEICHNET - gebunden an ihre Klassen, nicht an eine Zahl:
 *
 * `bars`: die Klassen der Elemente, die `data-dialog-actions` tragen (eigene
 *   Kopf- und Fusszeilen). Genau diese, nicht mehr und nicht weniger.
 * `panel`: modal-panel-Leisten, die im Abschnitt stehen muessen; baut ein
 *   Helfer sie, nennt `via` ihn.
 * `none`: ein Dialog ohne Leisten - nur mit Grund (`why`).
 *
 * Seit dem Ersatz-Review an #1421 haengt der Schutz NICHT mehr am Register: die
 * Platzierung nimmt jeden sichtbaren Knopf eines Dialogs immer dazu, und ein
 * fehlendes Auszeichnen bricht nichts mehr. Das Register haelt fest, was
 * ausgezeichnet IST, damit eine Leiste ihre Auszeichnung nicht still verliert.
 *
 * Drei Runden am Review zu #1421 fuehrten hierher. Der Rundgang stand als
 * modal-panel und wurde uebersprungen; dann zaehlte die Pruefung je Datei (zwei
 * Leisten, ein Dialog - eine davon zu loeschen blieb gruen); dann je Dialog, aber
 * als Zahl, und eine Attrappe `<span data-dialog-actions>` hielt sie. Jetzt
 * gehoert zu jedem Dialog der Abschnitt ab seiner Rolle bis zur naechsten, und
 * darin muessen genau die genannten Klassen die Auszeichnung tragen.
 *
 * Eine Denylist ("diese Dialoge sind schlecht") sagte zu jedem neuen Dialog JA.
 * Diese Liste sagt NEIN, bis er hier steht.
 */
const DIALOG_REGISTRY = {
  'public/components/modal.js': [{ panel: ['modal-panel__header'] }],
  'public/components/detail-view.js': [{ panel: ['modal-panel__footer'], via: 'detailFooterEl(' }],
  'public/components/document-attach.js': [{ bars: ['doc-attach-picker__header', 'doc-attach-picker__footer'] }],
  'public/components/datepicker.js': [{ none: true, why: 'Monatsraster ohne Leiste; jeder Tag ist ein Knopf und damit selbst Leiste' }],
  'public/pages/budget.js': [{ bars: ['budget-inline-modal__header', 'budget-inline-modal__footer'] }],
  'public/pages/calendar.js': [{ panel: ['modal-panel__header'] }],
  'public/pages/dashboard.js': [{ bars: ['onboarding-actions'] }],
  'public/pages/documents.js': [{ bars: ['dms-preview__header', 'dms-preview__actions'] }],
  'public/pages/inventory.js': [{ bars: ['inventory-booking-picker__header', 'inventory-booking-picker__nav', 'inventory-booking-picker__role-footer'] }],
  'public/pages/subscriptions.js': [{ bars: ['subscriptions-logo-picker-head', 'subscriptions-logo-search'] }],
  'public/router.js': [
    { none: true, why: 'Mehr-Blatt: Navigation ohne Kopf- und Fusszeile, seine Links sind selbst die Leisten' },
    { none: true, why: 'Suche: Feld und Treffer sind selbst die Leisten' },
    { panel: ['modal-panel__header'] },
  ],
};

const MARK = /data-dialog-actions|dataset\.dialogActions\s*=/g;
const MODAL_PANEL_ZONE = /modal-panel__header|modal-panel__footer|modal-actions/;
const DIALOG_ROLE = /role="dialog"|setAttribute\(\s*'role'\s*,\s*'dialog'\s*\)/g;

const ROOT = new URL('..', import.meta.url).pathname;

function walk(dir, out = []) {
  for (const name of readdirSync(dir)) {
    // toast-placement.js nennt die Rolle als Selektor, es baut keinen Dialog.
    if (name === 'vendor' || name === 'locales' || name === 'toast-placement.js') continue;
    const path = join(dir, name);
    if (statSync(path).isDirectory()) walk(path, out);
    else if (name.endsWith('.js')) out.push(path);
  }
  return out;
}

/** Quelltext ohne Kommentare: ein Kommentar baut keinen Dialog und zeichnet nichts aus. */
function code(file) {
  return readFileSync(join(ROOT, file), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '');
}

/** Je Dialog der Abschnitt ab seiner Rolle bis zur naechsten; davor der Vorlauf. */
function dialogSections(source) {
  const starts = [...source.matchAll(DIALOG_ROLE)].map((m) => m.index);
  return {
    lead: source.slice(0, starts[0] ?? source.length),
    sections: starts.map((start, i) => source.slice(start, starts[i + 1] ?? source.length)),
  };
}

const countMarks = (text) => (text.match(MARK) || []).length;

/**
 * Die Klassen der Elemente, die in einem Abschnitt `data-dialog-actions`
 * tragen - aus dem Markup (`<div class="x" data-dialog-actions>`) und aus der
 * DOM-API (`el.className = 'x'; el.dataset.dialogActions = ''`). Ein Element
 * ohne Klasse heisst `(ohne Klasse)` und passt damit zu keinem Eintrag.
 */
function markedBars(section) {
  const bars = [];
  for (const [tag] of section.matchAll(/<[a-z][\w-]*\b[^>]*\bdata-dialog-actions\b[^>]*>/g)) {
    const cls = tag.match(/\bclass="([^"]*)"/)?.[1].trim().split(/\s+/)[0];
    bars.push(cls || '(ohne Klasse)');
  }
  for (const [, variable] of section.matchAll(/\b(\w+)\.dataset\.dialogActions\s*=/g)) {
    const cls = section.match(new RegExp(`\\b${variable}\\.className\\s*=\\s*'([^']*)'`))?.[1].trim().split(/\s+/)[0];
    bars.push(cls || '(ohne Klasse)');
  }
  return bars.sort();
}

test('jeder Dialog der App steht im Register, mit dem Weg zu seinen Knoepfen', () => {
  const found = {};
  for (const path of walk(join(ROOT, 'public'))) {
    const file = relative(ROOT, path);
    const count = dialogSections(code(file)).sections.length;
    if (count) found[file] = count;
  }
  const expected = Object.fromEntries(Object.entries(DIALOG_REGISTRY).map(([k, v]) => [k, v.length]));
  assert.deepEqual(found, expected,
    'ein Dialog kam dazu oder fiel weg - im Register eintragen und sagen, wo seine Knoepfe sitzen');
});

test('jeder Dialog zeichnet genau die Leisten aus, die das Register nennt - nach Klasse', () => {
  for (const [file, entries] of Object.entries(DIALOG_REGISTRY)) {
    const source = code(file);
    const { lead, sections } = dialogSections(source);
    assert.equal(countMarks(lead), 0, `${file}: data-dialog-actions vor dem ersten Dialog gehoert zu keinem`);
    entries.forEach((entry, i) => {
      const section = sections[i] ?? '';
      const label = `${file}, Dialog ${i + 1}`;
      assert.deepEqual(markedBars(section), [...(entry.bars ?? [])].sort(),
        `${label}: diese Elemente tragen data-dialog-actions - das Register nennt andere`);
      for (const cls of entry.panel ?? []) {
        if (entry.via) {
          assert.ok(section.includes(entry.via), `${label}: ruft ${entry.via} nicht auf`);
          assert.ok(source.includes(cls), `${label}: ${entry.via} baut keine ${cls}`);
        } else {
          assert.ok(section.includes(cls), `${label}: als ${cls} gefuehrt, aber ohne diese Leiste`);
        }
      }
      if (entry.none) assert.ok(entry.why, `${label}: ein Dialog ohne Leisten braucht einen Grund`);
    });
  }
  // Und keine Auszeichnung ausserhalb des Registers.
  for (const path of walk(join(ROOT, 'public'))) {
    const file = relative(ROOT, path);
    if (DIALOG_REGISTRY[file]) continue;
    assert.equal(countMarks(code(file)), 0, `${file}: traegt data-dialog-actions, baut aber keinen registrierten Dialog`);
  }
});
