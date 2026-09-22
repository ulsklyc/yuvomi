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

    checkInvariant({
      viewport: { width: vw, height: vh },
      gap,
      safeTop,
      safeBottom,
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
 * JEDE STELLE, DIE EINEN DIALOG BAUT, UND WO SEINE KNOEPFE SITZEN - je Datei
 * gezaehlt nach dem Weg, auf dem die Platzierung die Leisten findet:
 *
 * `modalPanel`: `.modal-panel__header`/`__footer` bzw. `.modal-actions`
 *   (openModal, confirmModal, Detailansicht, eigene modal-panel-Dialoge).
 * `marked`: eigene Kopf-/Fusszeilen, ausgezeichnet mit `data-dialog-actions`.
 * `none`: ein Dialog ohne Leisten; die Platzierung behandelt dann seine
 *   Bedienelemente selbst als Leisten - nur mit Grund (`why`).
 *
 * Eine Denylist ("diese Dialoge sind schlecht") sagte zu jedem neuen Dialog JA.
 * Diese Liste sagt NEIN, bis er hier steht. Und sie wird in BEIDE Richtungen
 * gegen das Markup gelesen: die erste Fassung fuehrte den Rundgang als
 * modal-panel, obwohl er `data-dialog-actions` traegt, und die Pruefung der
 * Auszeichnung uebersprang ihn damit (Review an #1421).
 */
const DIALOG_REGISTRY = {
  'public/components/modal.js': { modalPanel: 1 },
  'public/components/detail-view.js': { modalPanel: 1 },
  'public/components/document-attach.js': { marked: 1 },
  'public/components/datepicker.js': { none: 1, why: 'Monatsraster ohne Leiste; jeder Tag ist ein Knopf und damit selbst Leiste' },
  'public/pages/budget.js': { marked: 1 },
  'public/pages/calendar.js': { modalPanel: 1 },
  'public/pages/dashboard.js': { marked: 1 },
  'public/pages/documents.js': { marked: 1 },
  'public/pages/inventory.js': { marked: 1 },
  'public/pages/subscriptions.js': { marked: 1 },
  'public/router.js': { modalPanel: 1, none: 2, why: 'Mehr-Blatt und Suche sind Navigation ohne Kopf- und Fusszeile; ihre Links und Felder sind selbst die Leisten' },
};

const dialogCount = (entry) => (entry.modalPanel ?? 0) + (entry.marked ?? 0) + (entry.none ?? 0);
const MARK = /data-dialog-actions|dataset\.dialogActions\s*=/g;
const MODAL_PANEL_ZONE = /modal-panel__header|modal-panel__footer|modal-actions/;

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

const DIALOG_ROLE = /role="dialog"|setAttribute\(\s*'role'\s*,\s*'dialog'\s*\)/g;

test('jeder Dialog der App steht im Register, mit dem Weg zu seinen Knoepfen', () => {
  const found = {};
  for (const path of walk(join(ROOT, 'public'))) {
    const source = readFileSync(path, 'utf8');
    // Kommentare zaehlen nicht: sie bauen keinen Dialog.
    const code = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
    const count = (code.match(DIALOG_ROLE) || []).length;
    if (count) found[relative(ROOT, path)] = count;
  }
  const expected = Object.fromEntries(Object.entries(DIALOG_REGISTRY).map(([k, v]) => [k, dialogCount(v)]));
  assert.deepEqual(found, expected,
    'ein Dialog kam dazu oder fiel weg - im Register eintragen und sagen, wo seine Knoepfe sitzen');
});

test('das Register stimmt mit dem Markup ueberein, in beide Richtungen', () => {
  const code = (file) => readFileSync(join(ROOT, file), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  for (const [file, entry] of Object.entries(DIALOG_REGISTRY)) {
    const source = code(file);
    const marks = (source.match(MARK) || []).length;
    if (entry.marked) {
      assert.ok(marks >= entry.marked,
        `${file}: ${marks} Auszeichnung(en) fuer ${entry.marked} ausgezeichnete(n) Dialog(e) - jede Leiste braucht data-dialog-actions`);
    } else {
      assert.equal(marks, 0, `${file}: traegt data-dialog-actions, steht aber nicht als "marked" im Register`);
    }
    if (entry.modalPanel) {
      assert.match(source, MODAL_PANEL_ZONE, `${file}: als modalPanel gefuehrt, aber ohne modal-panel-Leisten`);
    }
    if (entry.none) assert.ok(entry.why, `${file}: ein Dialog ohne Leisten braucht einen Grund`);
  }
  // Und keine Auszeichnung ausserhalb des Registers.
  for (const path of walk(join(ROOT, 'public'))) {
    const file = relative(ROOT, path);
    if (DIALOG_REGISTRY[file]) continue;
    const marks = (code(file).match(MARK) || []).length;
    assert.equal(marks, 0, `${file}: traegt data-dialog-actions, baut aber keinen registrierten Dialog`);
  }
});
