#!/usr/bin/env node
/**
 * Modul: Release-Kadenz-Guard
 * Zweck: Prueft vor dem Tag, ob dieses Release in seine Spur passt
 * Abhaengigkeiten: git im PATH, vollstaendiges Klon mit Tags
 *
 * Die Regel kommt aus #496 und #850. Gemessen am 02.09.2026: 92 Releases in
 * 21 Tagen, und 72 davon fassten die Oberflaeche an - rund 3,4-mal pro aktivem
 * Tag. Der Einwand war nie "zu viele Tags", sondern "sie lernt eine Funktion,
 * waehrend sie sich aendert". Deshalb zielt die Regel auf die Oberflaeche und
 * nicht auf die Release-Zahl:
 *
 *   Spur 1 (Oberflaeche): alles unter public/pages, public/styles, public/utils,
 *     public/components, public/settings faehrt nur im Oberflaechen-Zug,
 *     mittwochs und sonntags.
 *   Spur 2 (alles andere): Server, Doku, Tests, Deploy - jederzeit, aber
 *     hoechstens ein Release pro Kalendertag.
 *
 * Bis zum 12.09.2026 fuhr der Zug nur dienstags. Seitdem zwei feste Tage statt
 * einem: eine fertige Oberflaechen-Aenderung wartet hoechstens vier Tage statt
 * einer Woche, und die Oberflaeche bewegt sich trotzdem nur an zwei bekannten
 * Tagen statt immer dann, wenn gerade etwas fertig ist.
 *
 * Ausstieg: `--hotfix "<Grund>"` laesst ein Release jederzeit durch. Ein Guard
 * ohne Ausstieg wird beim ersten echten Notfall umgangen oder geloescht, und
 * dann gilt gar nichts mehr. Der Grund ist Pflicht, damit die Ausnahme in der
 * Release-Ausgabe steht statt im Kopf des Ausfuehrenden.
 *
 * Aufruf:  node scripts/check-release-cadence.mjs [--hotfix "Grund"]
 * Exit 0 = darf raus, Exit 1 = falsche Spur oder falscher Tag.
 *
 * `--day N` und `--since <ref>` sind Pruefnaehte: sie setzen Wochentag und
 * Vergleichspunkt von Hand, damit die Gegenprobe jeden Zweig einzeln rot stellen
 * kann. Ein Guard, den man nie hat scheitern sehen, ist eine Behauptung.
 */

import { execFileSync } from 'node:child_process';

const TRAIN_DAYS = [3, 7]; // ISO-8601: 3 = Mittwoch, 7 = Sonntag

const UI_PREFIXES = [
  'public/pages/',
  'public/styles/',
  'public/utils/',
  'public/components/',
  'public/settings/',
];

const args = parseArgs(process.argv.slice(2));

const DAY_NAMES = ['', 'Montag', 'Dienstag', 'Mittwoch', 'Donnerstag', 'Freitag', 'Samstag', 'Sonntag'];

function git(...args) {
  return execFileSync('git', args, { encoding: 'utf8' }).trim();
}

function fail(message) {
  console.error(`\nRelease-Kadenz: ABGELEHNT\n\n${message}\n`);
  process.exit(1);
}

function parseArgs(argv) {
  const out = { hotfix: null, day: null, since: null };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--hotfix') out.hotfix = argv[i + 1] ?? '';
    if (argv[i] === '--day') out.day = Number(argv[i + 1]);
    if (argv[i] === '--since') out.since = argv[i + 1];
  }
  return out;
}

/** ISO-Wochentag (1-7) des heutigen LOKALEN Tages. */
function todayIsoWeekday() {
  const d = new Date().getDay(); // 0 = Sonntag
  return d === 0 ? 7 : d;
}

/** YYYY-MM-DD des heutigen LOKALEN Tages - nie ueber toISOString(). */
function todayLocalKey() {
  const n = new Date();
  const p = (v) => String(v).padStart(2, '0');
  return `${n.getFullYear()}-${p(n.getMonth() + 1)}-${p(n.getDate())}`;
}

// ── Selbstpruefung: ein Guard, der seine Eingabe nicht findet, muss laut
// scheitern statt gruen durchzuwinken. Ein flacher CI-Klon hat keine Tags.
let previousTag;
try {
  previousTag = args.since ?? git('describe', '--tags', '--abbrev=0');
  git('rev-parse', '--verify', `${previousTag}^{commit}`);
} catch {
  fail(args.since
    ? `Der Vergleichspunkt "${args.since}" ist in diesem Klon nicht aufloesbar.`
    : 'Kein Tag gefunden. In einem flachen Klon kann dieser Guard nichts pruefen -\n'
      + 'er faellt deshalb durch, statt gruen zu behaupten, alles sei in Ordnung.\n'
      + 'Abhilfe: vollstaendig klonen (fetch-depth: 0) oder den Guard nur lokal fahren.');
}

let changed;
try {
  changed = git('diff', '--name-only', `${previousTag}..HEAD`).split('\n').filter(Boolean);
} catch {
  fail(`git diff ${previousTag}..HEAD ist fehlgeschlagen - der Guard konnte nichts pruefen.`);
}
if (changed.length === 0) {
  fail(`Keine Aenderung zwischen ${previousTag} und HEAD. Es gibt nichts zu releasen.`);
}

const uiFiles = changed.filter((f) => UI_PREFIXES.some((p) => f.startsWith(p)));
const weekday = args.day ?? todayIsoWeekday();
const today = todayLocalKey();

// Spur 2 laeuft hoechstens einmal am Tag.
const tagsToday = git('for-each-ref', '--format=%(creatordate:short) %(refname:short)', 'refs/tags')
  .split('\n')
  .filter((line) => line.startsWith(today))
  .map((line) => line.split(' ')[1]);

console.log(`Release-Kadenz: ${changed.length} Datei(en) seit ${previousTag}, `
  + `davon ${uiFiles.length} an der Oberflaeche. Heute ist ${DAY_NAMES[weekday]}.`);

if (args.hotfix !== null) {
  if (!args.hotfix || args.hotfix.trim().length < 10) {
    fail('--hotfix braucht einen Grund von mindestens 10 Zeichen. Eine Ausnahme ohne\n'
      + 'notierten Grund ist keine Ausnahme, sondern eine abgeschaltete Regel.');
  }
  console.log(`Release-Kadenz: HOTFIX-AUSNAHME - ${args.hotfix.trim()}`);
  process.exit(0);
}

if (uiFiles.length > 0 && !TRAIN_DAYS.includes(weekday)) {
  const sample = uiFiles.slice(0, 8).map((f) => `  ${f}`).join('\n');
  const more = uiFiles.length > 8 ? `\n  ... und ${uiFiles.length - 8} weitere` : '';
  const trainDays = TRAIN_DAYS.map((d) => `${DAY_NAMES[d].toLowerCase()}s`).join(' und ');
  fail(`Dieses Release fasst die Oberflaeche an und faehrt deshalb nur ${trainDays}.\n`
    + `Heute ist ${DAY_NAMES[weekday]}.\n\n${sample}${more}\n\n`
    + 'Wege von hier: bis zum naechsten Zug warten, die Oberflaechen-Aenderung aus\n'
    + 'diesem Release herausnehmen, oder - wenn es Sicherheit oder Datenverlust\n'
    + 'betrifft - `--hotfix "<Grund>"` setzen.');
}

if (uiFiles.length === 0 && tagsToday.length > 0) {
  fail(`Heute wurde bereits released: ${tagsToday.join(', ')}.\n`
    + 'Spur 2 faehrt hoechstens ein Release pro Kalendertag. Sammle den Rest bis morgen,\n'
    + 'oder setze `--hotfix "<Grund>"`, wenn es nicht warten kann.');
}

console.log(uiFiles.length > 0
  ? `Release-Kadenz: in Ordnung - Oberflaechen-Zug, ${uiFiles.length} Oberflaechen-Datei(en).`
  : 'Release-Kadenz: in Ordnung - Spur 2 ohne Oberflaeche, erstes Release heute.');
