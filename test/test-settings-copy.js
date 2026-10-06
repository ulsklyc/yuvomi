/**
 * Tests: Beschriftungswahrheit der Settings-Blätter (Critique 2026-07-27)
 * Zweck: Registry-Metadaten und Blatt-Inhalte sind unabhängig voneinander
 *        gewachsen. Vier Descriptions beschrieben Controls, die es auf dem
 *        Blatt nicht gibt ("Übersicht: Widgets und Aufbau anpassen" rendert
 *        Wetter und App-Name, null Widget-Controls). Nichts im Repo hat
 *        Label, Description und Inhalt nebeneinander gelesen.
 *
 * Prüft zwei Invarianten:
 *   1. Jedes Substantiv einer Leaf-Description kommt in den Strings vor, die
 *      dasselbe Blatt tatsächlich rendert.
 *   2. Jede Leaf-Description endet mit einem Satzschlusszeichen (sie stehen in
 *      der Domänen-Übersicht direkt untereinander).
 *
 * Grenze: Der Test prüft Vokabular, nicht Fähigkeit. Ein Blatt, das einen
 * Begriff nur read-only anzeigt, besteht ihn. Er fängt die stärkere Klasse:
 * Begriffe, die auf dem Blatt überhaupt nicht auftauchen.
 *
 * Seit dem IA-Umbau gilt er ohne Ausnahmeliste: die vier Blätter, die ihn beim
 * Aufsetzen brachen, sind aufgelöst oder zusammengelegt.
 *
 * Ausführen: node test/test-settings-copy.js
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

import { SETTINGS_LEAVES, SETTINGS_SECTIONS, settingsSheetSections } from '../public/settings/registry.js';

const de = JSON.parse(readFileSync(new URL('../public/locales/de.json', import.meta.url), 'utf8'));
const translate = (key) => key.split('.').reduce((value, segment) => value?.[segment], de);

const SENTENCE_SPLIT = /[.!?]+\s+/;
// Deutsche Substantive sind großgeschrieben. Das erste Wort eines Satzes ist
// es qua Orthografie, also überspringen - sonst zählt jedes Satzanfangs-Verb
// als Substantiv.
const NOUN = /^[A-ZÄÖÜ][A-Za-zÄÖÜäöüß-]{4,}$/;
// Stamm statt Volltreffer: Deutsch flektiert ("Rollen" in der Description,
// "Rolle" im Blatt). Zwei Zeichen Nachsilbe fallen weg, Minimum fünf, damit
// kurze Wörter nicht zu Rauschen werden, Maximum acht, damit lange Komposita
// nicht faktisch auf Volltreffer hinauslaufen.
const stemOf = (word) => word
  .slice(0, Math.min(Math.max(5, word.length - 2), 8))
  .toLowerCase();

/** Quelldatei eines Abschnitts (seit R10 traegt der Abschnitt den Loader, nicht das Blatt). */
function sectionSourcePath(section) {
  const match = String(section.loader).match(/\/settings\/(pages\/[\w-]+\.js)/);
  assert.ok(match, `${section.id}: Loader-Pfad nicht erkennbar`);
  return new URL(`../public/settings/${match[1]}`, import.meta.url);
}

const translationKeysIn = (source) => [...source.matchAll(/\bt\(\s*['"]([\w.]+)['"]/g)].map((m) => m[1]);

/**
 * Alle statischen t('...')-Werte, die das Blatt rendert, plus sein eigener
 * Titel (die Shell rendert ihn als h1, er gehört zu dem, was der Nutzer sieht).
 *
 * Geteilte Bausteine unter `/settings/` zählen mit: seit die beiden
 * Wetter-Blätter sich `weather-location.js` teilen, steht ein Teil ihres
 * sichtbaren Vokabulars nicht mehr in der Blattdatei. Eine Ebene tief, ohne
 * Rekursion - der Guard soll das Blatt prüfen, nicht den halben Baum.
 */
function renderedVocabulary(leaf) {
  const keys = [];
  // Ein Blatt rendert seit R10 ALLE seine Abschnitte (Rolle Admin: alle
  // sichtbar) - das Vokabular ist ihre Vereinigung.
  for (const section of settingsSheetSections(leaf, null, { all: true })) {
    const source = readFileSync(sectionSourcePath(section), 'utf8');
    keys.push(...translationKeysIn(source));
    for (const match of source.matchAll(/from\s+'\/settings\/([\w/-]+\.js)'/g)) {
      const shared = new URL(`../public/settings/${match[1]}`, import.meta.url);
      keys.push(...translationKeysIn(readFileSync(shared, 'utf8')));
    }
  }

  const values = [leaf.labelKey, ...keys]
    .map(translate)
    .filter((value) => typeof value === 'string');
  return values.join(' ').toLowerCase();
}

function descriptionNouns(description) {
  return description
    .split(SENTENCE_SPLIT)
    // Erstes Wort je Satz raus: im Deutschen qua Orthografie großgeschrieben.
    .flatMap((sentence) => sentence.trim().split(/\s+/).slice(1))
    .map((word) => word.replace(/[.,;:!?()„“"»«]/g, ''))
    .filter((word) => NOUN.test(word))
    // Bindestrich-Komposita zerlegen: das Blatt nennt oft nur einen Teil
    // ("CalDAV" und "Kalender" statt "CalDAV-Kalender").
    .flatMap((word) => (word.includes('-') ? word.split('-') : [word]))
    .filter((part) => part.length >= 5);
}

test('jede Leaf-Description endet mit einem Satzschlusszeichen', () => {
  for (const leaf of SETTINGS_LEAVES) {
    const description = translate(leaf.descriptionKey);
    assert.equal(typeof description, 'string', `${leaf.id}: ${leaf.descriptionKey} fehlt in de.json`);
    assert.match(
      description,
      /[.!?]$/,
      `${leaf.id}: "${description}" endet ohne Satzschlusszeichen`,
    );
  }
});

test('jedes Substantiv einer Leaf-Description kommt im Blatt-Inhalt vor', () => {
  const failures = [];
  for (const leaf of SETTINGS_LEAVES) {
    const description = translate(leaf.descriptionKey);
    const vocabulary = renderedVocabulary(leaf);
    for (const noun of descriptionNouns(description)) {
      if (!vocabulary.includes(stemOf(noun))) {
        failures.push(`${leaf.id}: Description nennt "${noun}", das Blatt rendert es nicht`);
      }
    }
  }
  assert.deepEqual(failures, []);
});

/**
 * DIE SUCH-OPTIONEN STEHEN AUF IHREM BLATT (Stichwortsuche, 2026-09-26).
 *
 * `options` in der Registry ist eine Liste von Beschriftungen, die die Suche
 * als Treffer anbietet und die Shell nach dem Sprung im Blatt wiederfindet
 * (shell.js, revealSettingsOption). Eine Option, deren Schluessel das Blatt
 * nicht rendert, ist ein Treffer, der auf ein Blatt ohne diese Einstellung
 * fuehrt - dieselbe Beschriftungsluege wie die veraltete Description oben,
 * nur einen Klick tiefer. Geprueft wird der Schluessel im Quelltext des
 * Blatts (plus geteilte Bausteine unter /settings/, eine Ebene), nicht der
 * Wert: zwei Blaetter duerfen dieselbe Beschriftung tragen.
 */
test('jede Such-Option einer Leaf wird auf genau dieser Leaf gerendert', () => {
  const failures = [];
  let seen = 0;
  // Seit R10 haengen die Optionen am Abschnitt, und der Abschnitt ist die
  // Datei, die sie rendert.
  for (const leaf of SETTINGS_SECTIONS) {
    const source = readFileSync(sectionSourcePath(leaf), 'utf8');
    // `t('x')` UND der Schluessel als Literal: Werte-Listen wie das Theme-
    // Segment tragen `labelKey: 'settings.themeDark'` und uebersetzen spaeter.
    const keysIn = (text) => [
      ...translationKeysIn(text),
      ...[...text.matchAll(/['"]([a-z][\w]*\.[\w.]+)['"]/g)].map((m) => m[1]),
    ];
    const keys = new Set(keysIn(source));
    for (const match of source.matchAll(/from\s+'\/settings\/([\w/-]+\.js)'/g)) {
      const shared = new URL(`../public/settings/${match[1]}`, import.meta.url);
      for (const key of keysIn(readFileSync(shared, 'utf8'))) keys.add(key);
    }
    for (const option of leaf.options ?? []) {
      const entry = typeof option === 'string' ? { key: option, also: [] } : { also: [], ...option };
      for (const key of [entry.key, ...entry.also]) {
        seen += 1;
        if (typeof translate(key) !== 'string') failures.push(`${leaf.id}: ${key} fehlt in de.json`);
        else if (!keys.has(key)) failures.push(`${leaf.id}: Option ${key} wird auf dem Blatt nicht gerendert`);
      }
    }
  }
  // Eine Zusicherung ueber eine leere Liste ist keine.
  assert.ok(seen >= 60, `nur ${seen} Such-Optionen gefunden - liest der Test die Registry noch?`);
  assert.deepEqual(failures, []);
});

/**
 * EIN ABSCHNITT, EIN NAME (#1524).
 *
 * Der Abschnitt fuer die Erinnerungslisten hiess auf dem Blatt
 * "Erinnerungslisten anzeigen/ausblenden", in der Einstellungssuche und im
 * Link aus den Aufgaben-Vorgaben aber "Erinnerungs-Synchronisation": wer nach
 * dem einen suchte, fand den anderen. Die Ueberschrift nimmt deshalb den
 * Schluessel der Registry, statt einen eigenen zu fuehren, und jeder Link in
 * den Abschnitt ebenso.
 *
 * Bewusst nur dieser eine Abschnitt: die Schwester `sync-calendar` titelt mit
 * dem Produktnamen des Protokolls ("CalDAV") unter einem Registry-Namen, der
 * auch Google und Outlook meint - das ist eine andere Frage als zwei Namen
 * fuer dasselbe.
 */
test('der Erinnerungs-Abschnitt traegt auf dem Blatt den Namen aus Suche und Links (#1524)', () => {
  const section = SETTINGS_SECTIONS.find((entry) => entry.id === 'sync-reminders');
  assert.ok(section, 'Abschnitt sync-reminders fehlt in der Registry');
  assert.equal(typeof translate(section.labelKey), 'string', `${section.labelKey} fehlt in de.json`);

  const source = readFileSync(sectionSourcePath(section), 'utf8');
  const headings = [...source.matchAll(/class="settings-section__title">\$\{t\('([\w.]+)'\)\}/g)].map((m) => m[1]);
  assert.deepEqual(headings, [section.labelKey],
    'die Abschnittsueberschrift nennt einen anderen Schluessel als die Registry');

  const tasks = readFileSync(new URL('../public/settings/pages/personal-tasks.js', import.meta.url), 'utf8');
  const link = tasks.match(/id="tasks-sync-reminders-link">\$\{t\('([\w.]+)'\)\}/);
  assert.ok(link, 'der Link aus den Aufgaben-Vorgaben ist nicht mehr auffindbar');
  assert.equal(link[1], section.labelKey, 'der Link nennt den Abschnitt anders als die Registry');

  // Der alte Bildschirmname darf nicht als zweiter Name zurueckkommen.
  assert.equal(translate('settings.caldavRemindersToggle'), undefined,
    'settings.caldavRemindersToggle ist wieder da - ein zweiter Name fuer denselben Abschnitt');
});
