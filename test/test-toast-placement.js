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
import { fileURLToPath } from 'node:url';
import { chooseToastPlacement, persistentToastMustYield, placeToastStack } from '../public/utils/toast-placement.js';
import { PERSISTENT_TOAST_SELECTOR } from '../public/utils/toast-surface.js';
import { eachRule } from './css-rules.js';

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

/*
 * WCAG 2.4.11 (a11y-Runde auf 64cc2f5c0): Knoepfe hielt der Stapel frei, das
 * FOKUSSIERTE Feld nicht. Im Budget-Dialog bei 375 lag `#bm-title` ganz unter
 * dem Toast, wer per Tab dorthin kam, sah seinen Fokus nicht. Hier liegt der
 * Stapel mitten im Koerper eines Vollbild-Dialogs, beruehrt keine Leiste und
 * blieb deshalb stehen (Lage 4) - auf dem Feld, das gerade den Fokus hat.
 */
test('WCAG 2.4.11: das fokussierte Feld in einem Vollbild-Dialog bleibt frei (375x812)', () => {
  const dialog = box(0, 0, 375, 812);
  const header = box(0, 0, 375, 64);
  const footer = box(740, 0, 375, 72);
  const field = box(610, 16, 343, 44);
  const input = {
    viewport: { width: 375, height: 812 },
    gap: 12,
    stack: box(600, 16, 343, 66),
    dockedHeight: 66,
    dockedWidth: 343,
    dockedCenter: 187.5,
    primary: dialog,
    dialogs: [dialog],
    zones: [header, footer],
    focused: field,
  };
  const r = placedRect(input, chooseToastPlacement(input));
  assert.ok(r, 'der Stapel bleibt auf dem fokussierten Feld stehen');
  assert.ok(!intersects(r, field), `Stapel ${Math.round(r.top)}..${Math.round(r.bottom)} verdeckt das Feld ${field.top}..${field.bottom}`);
  assert.ok(!intersects(r, header) && !intersects(r, footer), 'und dabei keine Leiste');
  // Ohne Fokus im Dialog bleibt es bei der alten Lage: ein Feld allein ist keine Leiste.
  assert.equal(chooseToastPlacement({ ...input, focused: null }), null, 'ohne Fokus springt der Stapel nicht');
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
  'public/pages/calendar.js': [
    { panel: ['modal-panel__header'] },
    // R14 (Re-Critique 2026-09-28, A2 P2-7): die Filter am Desktop als natives
    // Popover am Knopf. Den Inhalt samt Fuss (Aufheben) baut das Filterblatt
    // vor der Rolle; die Platzierung nimmt jeden sichtbaren Knopf ohnehin dazu.
    { none: true, why: 'Filter-Popover: Haken und Fuss kommen fertig aus dem Filterblatt, ausgezeichnet wird nichts eigenes' },
  ],
  'public/pages/dashboard.js': [{ bars: ['onboarding-actions'] }],
  'public/pages/documents.js': [{ bars: ['dms-preview__header', 'dms-preview__actions'] }],
  'public/pages/inventory.js': [{ bars: ['inventory-booking-picker__header', 'inventory-booking-picker__nav', 'inventory-booking-picker__role-footer'] }],
  'public/pages/subscriptions.js': [{ bars: ['subscriptions-logo-picker-head', 'subscriptions-logo-search'] }],
  // R17 (E13): das Filter-Popover am Desktop baut das Filterblatt selbst, fuer
  // jedes Modul, das es am Knopf oeffnet (Aufgaben; der Kalender traegt seins
  // noch im eigenen Modul). Inhalt und Fuss sind die des Blatts.
  'public/utils/filter-sheet.js': [
    { none: true, why: 'Filter-Popover: Haken und Fuss kommen fertig aus dem Filterblatt, ausgezeichnet wird nichts eigenes' },
  ],
  'public/router.js': [
    { none: true, why: 'Mehr-Blatt: Navigation ohne Kopf- und Fusszeile, seine Links sind selbst die Leisten' },
    { none: true, why: 'Suche: Feld und Treffer sind selbst die Leisten' },
    { panel: ['modal-panel__header'] },
  ],
};

const MARK = /data-dialog-actions|dataset\.dialogActions\s*=/g;
const MODAL_PANEL_ZONE = /modal-panel__header|modal-panel__footer|modal-actions/;
// Ein Attribut-Selektor (`[role="dialog"]`) FRAGT nach Dialogen, er baut
// keinen: das Popover der Leseansicht laesst so Klicks in einer anderen Ebene
// durch (Re-Kritik 2026-09-28, E2) und zaehlte sonst als zweiter Dialog.
const DIALOG_ROLE = /(?<!\[)role="dialog"|setAttribute\(\s*'role'\s*,\s*'dialog'\s*\)/g;

const ROOT = fileURLToPath(new URL('..', import.meta.url));

function walk(dir, out = []) {
  for (const name of readdirSync(dir)) {
    // toast-placement.js liest Rolle und Auszeichnung als Selektoren, es baut keinen Dialog.
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

// --------------------------------------------------------
// Dauerhafter Toast (Re-Critique 2026-09-27, Casey; R9 M14)
// --------------------------------------------------------

/**
 * Gemessen bei 390x844 im Formular „Aufgabe bearbeiten" (Blatt ab y=89, Fuss
 * ab y=758): die Erinnerung (66px) passte nicht in den Streifen ueber dem
 * Blatt und lag nach Lage 5 bei y=621 im Formular - dreissig Sekunden ueber
 * den Feldern. Sie verdeckte keine Bedienleiste und galt damit als gut
 * platziert.
 */
test('M14: ein dauerhafter Toast weicht, sobald seine Lage den Dialog beruehrt', () => {
  const viewport = { width: 390, height: 844 };
  const sheet = box(89, 13, 364, 755);
  const input = {
    viewport, gap: 12, stack: box(686, 16, 358, 66), dockedHeight: 66, dockedWidth: 340, dockedCenter: 195,
    primary: sheet, dialogs: [sheet],
    // Kopf, Fuss und ein Knopf im Formular (der Datumswaehler) an der Stelle,
    // an der der Stapel sonst steht - deshalb Lage 5 statt Lage 4.
    zones: [box(89, 13, 364, 70), box(758, 13, 364, 73), box(690, 29, 332, 48)],
  };
  const decision = chooseToastPlacement(input);
  assert.ok(decision, 'Vorbedingung: der Stapel wird im Dialog platziert');
  assert.equal(decision.covers, false, 'Vorbedingung: er verdeckt keine Leiste - deshalb blieb er bisher stehen');
  assert.equal(persistentToastMustYield({ ...input, decision }), true, 'im Blatt, ueber dem Formular: er weicht');

  // Kompakt (48px) passt er in den Streifen ueber dem Blatt - dort bleibt er.
  const compact = { ...input, stack: box(704, 16, 358, 48), dockedHeight: 48 };
  const above = chooseToastPlacement(compact);
  assert.ok(above && above.top + 48 <= sheet.top, 'kompakt liegt er ueber dem Blatt');
  assert.equal(persistentToastMustYield({ ...compact, decision: above }), false, 'neben dem Dialog bleibt er sichtbar');

  // Am eigenen Platz, ohne den Dialog zu beruehren: nichts zu tun.
  assert.equal(persistentToastMustYield({ ...input, decision: null, stack: box(10, 16, 358, 48) }), false);
  // Am eigenen Platz UEBER dem Dialog-Inhalt (Lage 4 liefert null): er weicht.
  const lage4 = { ...input, zones: input.zones.slice(0, 2) };
  assert.equal(chooseToastPlacement(lage4), null, 'Vorbedingung: Lage 4, er bleibt stehen');
  assert.equal(persistentToastMustYield({ ...lage4, decision: null }), true);
});

test('M14: die Toast-Lage nimmt dauerhafte Toasts zurueck, statt sie ueber dem Dialog stehen zu lassen', () => {
  const src = readFileSync(new URL('../public/utils/toast-placement.js', import.meta.url), 'utf8');
  const fn = src.slice(src.indexOf('export function placeToastStack'), src.indexOf('export function watchToastPlacement'));
  assert.match(fn, /querySelectorAll\(PERSISTENT_TOAST_SELECTOR\)/, 'die Lage kennt die dauerhaften Toasts');
  assert.match(fn, /persistentToastMustYield\(/, 'und fragt, ob sie weichen muessen');
  assert.match(fn, /toast\.classList\.add\('toast--tucked'\);\s*toast\.inert = true;/,
    'zurueckgenommen wie beim Einklappen: unsichtbar und inert, nicht entfernt');
  assert.ok(PERSISTENT_TOAST_SELECTOR.split(',').map((x) => x.trim()).includes('.toast--reminder'),
    'die Erinnerung ist ein dauerhafter Toast');
});

test('M14: mobil ist die Erinnerung eine Zeile in Zielgroesse, der Kicker bleibt vorgelesen', () => {
  const css = readFileSync(new URL('../public/styles/layout.css', import.meta.url), 'utf8');
  const mobile = [...eachRule(css)].filter((r) => r.at.some((a) => /max-width:\s*767px/.test(a)));
  const body = (sel) => mobile.find((r) => r.selector.trim() === sel)?.body ?? '';
  assert.match(body('.toast.toast--reminder'), /padding-block:\s*0/);
  assert.match(body('.toast--reminder .toast__reminder-text'), /min-height:\s*var\(--target-base\)/,
    'die Hoehe ist die Treffflaeche des Knopfs, der die Erinnerung oeffnet');
  const kicker = body('.toast--reminder .toast__reminder-text strong');
  assert.match(kicker, /clip:\s*rect\(0,\s*0,\s*0,\s*0\)/);
  assert.doesNotMatch(kicker, /display:\s*none/);
});

// --------------------------------------------------------
// Erfolg steht auf Glas, nicht auf Gruen (Re-Critique 2026-09-27, C2)
// --------------------------------------------------------
//
// 118 Aufrufe von showToast(..., 'success') liefen ueber EINEN Baustein und
// jeder zeigte eine gruene Vollflaeche. Die Regel, die hier gehalten wird: die
// Flaeche, die ein Erfolgs-Toast am Ende WIRKLICH bekommt - ueber alle
// Stylesheets in Ladereihenfolge, mit Spezifitaet, mit und ohne
// backdrop-filter -, ist das Shell-Material, nie die Erfolgsfarbe; die Farbe
// sitzt am Icon. Fehler behalten ihre Vollflaeche.

const STYLE_ORDER = ['tokens.css', 'layout.css', 'glass.css'];

/** Passt ein Selektorteil auf <div class="toast toast--{tone}"> (nur die letzte Stufe)? */
function matchesToast(part, tone) {
  const last = part.trim().split(/\s+|>|\+|~/).filter(Boolean).pop() ?? '';
  const nots = [...last.matchAll(/:not\(([^)]*)\)/g)].map((m) => m[1].trim());
  const base = last.replace(/:not\([^)]*\)/g, '');
  const classes = [...base.matchAll(/\.([\w-]+)/g)].map((m) => m[1]);
  if (!classes.length || base.replace(/\.[\w-]+/g, '') !== '') return false;
  const own = new Set(['toast', `toast--${tone}`]);
  if (!classes.every((c) => own.has(c))) return false;
  return !nots.some((n) => own.has(n.replace(/^\./, '')));
}

const specificity = (part) => {
  const last = part.trim().split(/\s+|>|\+|~/).filter(Boolean).pop() ?? '';
  return (last.match(/\.[\w-]+/g) ?? []).length;
};

/** Der Hintergrund, der fuer einen Toast des Tons gewinnt. */
function winningBackground(tone, { supportsBlur }) {
  let best = null;
  let order = 0;
  for (const file of STYLE_ORDER) {
    const css = readFileSync(new URL(`../public/styles/${file}`, import.meta.url), 'utf8');
    for (const rule of eachRule(css)) {
      order += 1;
      if (rule.at.some((a) => /@media/.test(a))) continue; // Nutzervorlieben (Kontrast, Transparenz) sind eigene Faelle
      if (rule.at.some((a) => /@supports/.test(a)) && !supportsBlur) continue;
      const decl = rule.body.match(/(?:^|;)\s*background(?:-color)?\s*:\s*([^;]+)/);
      if (!decl) continue;
      for (const part of rule.selector.split(',')) {
        if (!matchesToast(part, tone)) continue;
        const spec = specificity(part);
        if (!best || spec > best.spec || (spec === best.spec && order >= best.order)) {
          best = { spec, order, value: decl[1].trim(), where: `${file}: ${part.trim()}` };
        }
      }
    }
  }
  return best;
}

test('ein Erfolgs-Toast steht auf dem Shell-Material, das Gruen traegt das Icon', () => {
  for (const supportsBlur of [true, false]) {
    const success = winningBackground('success', { supportsBlur });
    assert.ok(success, 'keine Flaeche fuer den Erfolgs-Toast gefunden - der Guard waere blind');
    assert.doesNotMatch(success.value, /--color-success/, `Vollflaeche (${success.where}, backdrop ${supportsBlur})`);
    assert.match(success.value, /--toast-bg/, `nicht das Shell-Material (${success.where})`);
    const danger = winningBackground('danger', { supportsBlur });
    assert.match(danger?.value ?? '', /--color-danger/, 'ein Fehler bleibt eine deutliche Flaeche');
  }
  const glass = readFileSync(new URL('../public/styles/glass.css', import.meta.url), 'utf8');
  const icon = [...eachRule(glass)].find((r) => r.selector.trim() === '.toast--success .toast__icon');
  assert.match(icon?.body ?? '', /color:\s*var\(--shell-success-ink\)/, 'das Haekchen traegt die Erfolgsfarbe');
  const tokens = readFileSync(new URL('../public/styles/tokens.css', import.meta.url), 'utf8');
  // Seit R16 ist das Material in beiden Themes dunkel: EINE Tinte fuer beide
  // (die Gegendrehung #0B6B2B fuer den hellen Dunkelmodus-Grund ist entfallen).
  assert.equal((tokens.match(/--_shell-success-ink:/g) ?? []).length, 1, 'eine Erfolgstinte fuer beide Themes');
});

// --------------------------------------------------------
// Liste+Detail: der Fuss der Detailspalte (Re-Critique 2026-09-28, A3 P1-1)
// --------------------------------------------------------

/*
 * Gemessen bei 1280x800 in den Aufgaben: der Toast lag bei 560-940/710-776,
 * "Loeschen" im Fuss der Detailspalte bei 716-828/730-770; `elementFromPoint`
 * auf der Knopfmitte lieferte den Toast. Die Platzierung kannte nur Dialoge,
 * die Spalte ist keiner. Gefahren wird hier das ECHTE `placeToastStack` gegen
 * einen kleinsten DOM-Stub - die reine Wahl der Lage haette die Spalte schon
 * immer richtig behandelt, sie wurde ihr nur nie gezeigt.
 */
function parseSelector(selector) {
  return selector.split(',').map((part) => {
    const s = part.trim();
    const tag = s.match(/^[a-z][\w-]*/)?.[0] ?? null;
    const classes = [...s.matchAll(/\.([\w-]+)/g)].map((m) => m[1]);
    const attrs = [...s.matchAll(/\[([\w-]+)(?:="([^"]*)")?\]/g)].map((m) => [m[1], m[2]]);
    return { tag, classes, attrs, unsupported: s.includes(':') };
  });
}

class FakeEl {
  constructor(tag, { cls = '', attrs = {}, rect = null, overflow = 'visible' } = {}) {
    this.tagName = tag.toUpperCase();
    this.cls = new Set(cls.split(' ').filter(Boolean));
    this.attrs = new Map(Object.entries(attrs));
    this.rectBox = rect;
    this.overflow = overflow;
    this.children = [];
    this.parentElement = null;
    this.dataset = {};
    this.inert = false;
    this.props = new Map();
    this.style = {
      setProperty: (k, v) => this.props.set(k, v),
      removeProperty: (k) => this.props.delete(k),
    };
    this.classList = {
      contains: (c) => this.cls.has(c),
      add: (c) => this.cls.add(c),
      remove: (c) => this.cls.delete(c),
    };
  }

  add(...kids) {
    for (const kid of kids) { kid.parentElement = this; this.children.push(kid); }
    return this;
  }

  matchesOne({ tag, classes, attrs, unsupported }) {
    if (unsupported) return false;
    if (tag && this.tagName !== tag.toUpperCase()) return false;
    if (!classes.every((c) => this.cls.has(c))) return false;
    return attrs.every(([k, v]) => this.attrs.has(k) && (v === undefined || this.attrs.get(k) === v));
  }

  matches(selector) { return parseSelector(selector).some((p) => this.matchesOne(p)); }
  closest(selector) {
    for (let n = this; n; n = n.parentElement) if (n.matches?.(selector)) return n;
    return null;
  }

  descendants() { return this.children.flatMap((c) => [c, ...c.descendants()]); }
  querySelectorAll(selector) { return this.descendants().filter((n) => n.matches(selector)); }
  querySelector(selector) { return this.querySelectorAll(selector)[0] ?? null; }
  contains(other) { return other === this || this.descendants().includes(other); }
  getAttribute(k) { return this.attrs.has(k) ? this.attrs.get(k) : null; }
  getBoundingClientRect() { return this.rectBox ?? box(0, 0, 0, 0); }
  getClientRects() { return this.rectBox ? [this.rectBox] : []; }
  checkVisibility() { return Boolean(this.rectBox); }
}

/** Aufgaben bei 1280x800: Liste links, Detailspalte rechts, Toast am Platz. */
function splitViewScene({ reminder = false } = {}) {
  const body = new FakeEl('body');
  const pane = new FakeEl('section', { cls: 'split-view__detail', rect: box(140, 680, 576, 644), overflow: 'auto' });
  const head = new FakeEl('header', { cls: 'split-view__detail-head', rect: box(140, 680, 576, 72) })
    .add(new FakeEl('button', { rect: box(152, 1150, 96, 44) }));
  const content = new FakeEl('div', { cls: 'detail-view', rect: box(212, 680, 576, 498) })
    .add(new FakeEl('button', { rect: box(300, 700, 200, 40) }));
  const deleteBtn = new FakeEl('button', { cls: 'btn btn--danger-outline', rect: box(730, 716, 112, 40) });
  const footer = new FakeEl('div', { cls: 'detail-view__footer split-view__detail-footer', rect: box(710, 680, 576, 64) })
    .add(deleteBtn, new FakeEl('button', { cls: 'btn btn--primary', rect: box(730, 1100, 120, 40) }));
  pane.add(head, content, footer);
  const list = new FakeEl('div', { cls: 'split-view__list', rect: box(140, 280, 376, 644) });
  body.add(list, pane);

  const toast = new FakeEl('div', { cls: reminder ? 'toast toast--reminder' : 'toast', rect: box(710, 560, 380, 66) });
  const stack = new FakeEl('div', { cls: 'shell-bottom-stack', rect: box(710, 560, 380, 66) }).add(toast);
  body.add(stack);
  return { body, pane, footer, deleteBtn, stack, toast };
}

function withDom(scene, fn) {
  const saved = { document: global.document, getComputedStyle: global.getComputedStyle };
  global.document = {
    body: scene.body,
    activeElement: scene.body,
    documentElement: { clientWidth: 1280, clientHeight: 800 },
    querySelectorAll: (sel) => scene.body.querySelectorAll(sel),
    querySelector: (sel) => scene.body.querySelector(sel),
    elementFromPoint: () => null,
  };
  global.getComputedStyle = (el) => ({
    overflowX: el.overflow ?? 'visible',
    overflowY: el.overflow ?? 'visible',
    getPropertyValue: (name) => (name === '--toast-dock-gap' ? '12px' : ''),
  });
  try {
    return fn();
  } finally {
    global.document = saved.document;
    global.getComputedStyle = saved.getComputedStyle;
  }
}

test('A3 P1-1: in Liste+Detail weicht der Stapel dem Fuss der Detailspalte (1280x800)', () => {
  const scene = splitViewScene();
  const decision = withDom(scene, () => placeToastStack(scene.stack));
  assert.ok(decision, 'der Stapel blieb auf "Loeschen" stehen - die Detailspalte zaehlte nicht als Flaeche');
  assert.equal(scene.stack.dataset.dock, 'placed');
  const width = parseFloat(scene.stack.props.get('--toast-dock-width'));
  const center = parseFloat(scene.stack.props.get('--toast-dock-center'));
  const placed = box(decision.top, center - width / 2, width, 66);
  const footer = scene.footer.getBoundingClientRect();
  assert.ok(!intersects(placed, footer), `der Stapel ${placed.top}..${placed.bottom} liegt auf dem Fuss ab ${footer.top}`);
  assert.ok(!intersects(placed, scene.deleteBtn.getBoundingClientRect()), '"Loeschen" bleibt frei');
  assert.ok(placed.bottom <= footer.top && placed.top >= 212,
    'er steht in der Spalte ueber ihrem Fuss, nicht ueber dem Seitenkopf');
  assert.ok(placed.left >= 680 && placed.right <= 1256, 'ausgerichtet an der Detailspalte');
});

test('A3 P1-1: die Erinnerung weicht der Detailspalte nicht ganz - nur ihrem Fuss', () => {
  const scene = splitViewScene({ reminder: true });
  const decision = withDom(scene, () => placeToastStack(scene.stack));
  assert.ok(decision, 'die Erinnerung blieb auf dem Fuss');
  assert.equal(scene.toast.classList.contains('toast--tucked'), false,
    'eine Erinnerung verschwaende sonst, solange rechts ein Detail offen ist - also fast immer');
  assert.equal(scene.toast.inert, false);
});

test('A3 P1-1: ohne Detailspalte (unter der Schwelle) bleibt der Stapel, wo er steht', () => {
  const scene = splitViewScene();
  scene.pane.rectBox = null;
  for (const n of scene.pane.descendants()) n.rectBox = null;
  const decision = withDom(scene, () => placeToastStack(scene.stack));
  assert.equal(decision, null);
  assert.equal(scene.stack.dataset.dock, undefined);
});

// --------------------------------------------------------
// Das Shell-Material im Dunkeln (Re-Critique 2026-09-28, A1 P2-2)
// --------------------------------------------------------

/*
 * Toast und Sammelaktions-Pille standen auf --neutral-800, und das wird im
 * Dunkelmodus hell (#E7E2DA): "Gespeichert" war die hellste Flaeche im Bild.
 * Gerechnet wird aus tokens.css selbst - je Thema die Kette der Variablen bis
 * zum Hexwert, Dunkel per Vorliebe UND per Wahl. Die Zusage: dunkel ist der
 * Grund nie heller als --color-surface-raised, und Schrift und Tinten halten
 * ihren Kontrast gegen den opaken Token UND gegen die 90-%-Glasmischung ueber
 * der Buehne und ueber reinem Weiss (einem Foto darunter).
 */
function tokenScopes() {
  const css = readFileSync(new URL('../public/styles/tokens.css', import.meta.url), 'utf8');
  const decls = (rule) => Object.fromEntries([...rule.body.matchAll(/(--[\w-]+)\s*:\s*([^;]+);?/g)].map((m) => [m[1], m[2].trim()]));
  const rules = [...eachRule(css)];
  const root = Object.assign({}, ...rules.filter((r) => r.selector.trim() === ':root' && !r.at.length).map(decls));
  const darkPref = rules.filter((r) => r.selector.trim() === ':root:not([data-theme="light"])'
    && r.at.some((a) => /prefers-color-scheme:\s*dark/.test(a))).map(decls);
  const darkPick = rules.filter((r) => r.selector.trim() === '[data-theme="dark"]').map(decls);
  assert.ok(darkPref.length && darkPick.length, 'die beiden Dunkel-Bloecke nicht gefunden - der Guard waere blind');
  return {
    light: root,
    'dunkel per Vorliebe': { ...root, ...Object.assign({}, ...darkPref) },
    'dunkel per Wahl': { ...root, ...Object.assign({}, ...darkPick) },
  };
}

function resolveHex(scope, name, depth = 0) {
  const value = scope[name];
  assert.ok(value, `${name} fehlt`);
  assert.ok(depth < 10, `${name}: Kette zu tief`);
  const ref = value.match(/^var\((--[\w-]+)\)$/);
  if (ref) return resolveHex(scope, ref[1], depth + 1);
  assert.match(value, /^#[0-9a-f]{6}$/i, `${name} = ${value} ist kein Hexwert`);
  return value;
}

const rgb = (hex) => [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16));
const luminance = (c) => {
  const [r, g, b] = c.map((v) => {
    const s = v / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
};
const contrast = (a, b) => {
  const [x, y] = [luminance(a), luminance(b)].sort((m, n) => n - m);
  return (x + 0.05) / (y + 0.05);
};
const over = (top, under, alpha) => top.map((v, i) => Math.round(v * alpha + under[i] * (1 - alpha)));

test('A1 P2-2: der Toast ist im Dunkeln nicht die hellste Flaeche, und alles darauf bleibt lesbar', () => {
  for (const [theme, scope] of Object.entries(tokenScopes())) {
    const bg = rgb(resolveHex(scope, '--_toast-bg'));
    if (theme !== 'light') {
      const raised = rgb(resolveHex(scope, '--_color-surface-raised'));
      assert.ok(luminance(bg) <= luminance(raised) + 1e-9,
        `${theme}: der Toast (${resolveHex(scope, '--_toast-bg')}) ist heller als --color-surface-raised`);
    }
    const stage = rgb(resolveHex(scope, '--_neutral-100'));
    const grounds = { opak: bg, 'Glas ueber der Buehne': over(bg, stage, 0.9), 'Glas ueber Weiss': over(bg, [255, 255, 255], 0.9) };
    for (const [where, ground] of Object.entries(grounds)) {
      const need = [['--_toast-text', 4.5], ['--_toast-text-secondary', 4.5], ['--_shell-danger-ink', 4.5], ['--_shell-success-ink', 3]];
      for (const [token, min] of need) {
        const ratio = contrast(rgb(resolveHex(scope, token)), ground);
        assert.ok(ratio >= min, `${theme}, ${where}: ${token} nur ${ratio.toFixed(2)}:1`);
      }
    }
  }
  // Und die Flaechen lesen es: Toast und Pille, mit und ohne Glas.
  const layout = readFileSync(new URL('../public/styles/layout.css', import.meta.url), 'utf8');
  const glass = readFileSync(new URL('../public/styles/glass.css', import.meta.url), 'utf8');
  for (const [css, sel] of [[layout, '.toast'], [layout, '.list-bulkbar'], [glass, '.toast.toast--success']]) {
    const body = [...eachRule(css)].filter((r) => !r.at.length && r.selector.trim() === sel).map((r) => r.body).join(';');
    assert.match(body, /background-color:\s*var\(--toast-bg\)/, `${sel}: nicht auf dem Shell-Material`);
    assert.match(body, /(?:^|;|\s)color:\s*var\(--toast-text\)/, `${sel}: nicht mit der Shell-Schrift`);
  }
  const shell = [...eachRule(glass)].filter((r) => /\.toast:not\(\.toast--danger\)/.test(r.selector));
  assert.ok(shell.length >= 2, 'Glas und Reduced-Transparency-Fallback');
  for (const rule of shell) assert.match(rule.body, /var\(--toast-bg\)/, `${rule.at.join(' ')}: nicht auf --toast-bg`);
});
