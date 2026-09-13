/**
 * Tests: Live changelog parser/proxy.
 * Ausführen: node --test test/test-changelog.js
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { execSync, execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import express from 'express';
import changelogRouter, { buildRouter, __test } from '../server/routes/changelog.js';
import { compareVersions, isNewerVersion, displayVersion, releasesNewForMe } from '../public/utils/version.js';

test('parseReleaseBody keeps release sections and removes GitHub noise', () => {
  const sections = __test.parseReleaseBody(`
## Added
- New dashboard changelog modal ([#455](https://github.com/ulsklyc/yuvomi/pull/455))
- Internal commit 9f4a12bc should not leak

## Fixed
- Better widget sizing

Full Changelog: https://github.com/ulsklyc/yuvomi/compare/v1.0.0...v1.1.0
Assets
`);

  // `items` ist unveraendert die eine-Zeile-je-Eintrag-Form: /api/v1 ist eine
  // zugesagte Oberflaeche, `entries` liegt additiv daneben (#496).
  assert.deepEqual(sections.map((s) => ({ title: s.title, items: s.items })), [
    {
      title: 'Added',
      items: [
        'New dashboard changelog modal (#455)',
        'Internal commit should not leak',
      ],
    },
    {
      title: 'Fixed',
      items: ['Better widget sizing'],
    },
  ]);
  // Ohne fettgedruckten Vorspann (alles vor 2.41.0) ist die ganze Zeile der
  // Vorspann - erfunden wird keiner.
  assert.deepEqual(sections[0].entries[0], {
    lead: 'New dashboard changelog modal (#455)', detail: '',
  });
});

test('parseReleaseBody trennt den fettgedruckten Vorspann von der Begruendung', () => {
  // DAS IST DIE LUECKE, UM DIE ES GEHT (#496): seit 2.41.0 oeffnet jeder
  // Eintrag mit einem Vorspann, und ein Guard setzt das durch (#850) - die
  // Ansicht bekam ihn bis hierher aber als Fliesstext, weil die Auszeichnung
  // vorher eingeebnet wurde. Wer scannen will, konnte nicht scannen.
  const sections = __test.parseReleaseBody(`
## Fixed
- **The weather forecast was off by a day** (#851). The server already keeps the
  running day out of \`forecast\` so it is not shown twice.
- **A second change** with its own reason.
`);

  assert.equal(sections.length, 1);
  const [first, second] = sections[0].entries;
  assert.equal(first.lead, 'The weather forecast was off by a day');
  assert.match(first.detail, /^\(#851\)\. The server already keeps/);
  // Die Fortsetzungszeile gehoert zur Begruendung, nicht zum Vorspann.
  assert.match(first.detail, /shown twice\.$/);
  assert.equal(second.lead, 'A second change');
  assert.equal(second.detail, 'with its own reason.');

  // Und `items` bleibt daneben die zusammengesetzte Zeile von frueher.
  assert.match(sections[0].items[0], /^The weather forecast was off by a day \(#851\)\./);
});

test('buildChangelogPayload marks current version when it appears in releases', () => {
  const payload = __test.buildChangelogPayload([
    { tag_name: 'v1.2.2', body: '- Newest release', html_url: 'https://example.test/latest' },
    { tag_name: 'v1.2.1', body: '- Current release', html_url: 'https://example.test/current' },
  ], '1.2.1');

  assert.equal(payload.current_version, '1.2.1');
  assert.equal(payload.latest_version, 'v1.2.2');
  assert.equal(payload.current_in_releases, true);
  assert.equal(payload.releases.length, 2);
});

test('buildChangelogPayload reports current version missing from releases', () => {
  const payload = __test.buildChangelogPayload([
    { tag_name: 'v0.88.1', body: '- Public release notes' },
  ], '1.2.1');

  assert.equal(payload.latest_version, 'v0.88.1');
  assert.equal(payload.current_in_releases, false);
});

test('changelog router fetches and sanitizes GitHub release JSON', async () => {
  const app = express();
  app.use(buildRouter({
    appVersion: '1.2.1',
    now: () => 1000,
    fetchFn: async (url, options) => {
      assert.match(url, /api\.github\.com\/repos\/ulsklyc\/yuvomi\/releases/);
      assert.equal(options.headers.Accept, 'application/vnd.github+json');
      return {
        ok: true,
        json: async () => [
          {
            tag_name: 'v1.2.1',
            body: '## Added\n- Live changelog\n\nFull Changelog: https://example.test',
            html_url: 'https://github.com/ulsklyc/yuvomi/releases/tag/v1.2.1',
          },
        ],
      };
    },
  }));

  const server = app.listen(0);
  try {
    const res = await fetch(`http://127.0.0.1:${server.address().port}/`);
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.data.current_in_releases, true);
    assert.equal(body.data.releases[0].sections[0].items[0], 'Live changelog');
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

// --------------------------------------------------------
// „Neu in deiner App" - die Auswahl der Releases (#496)
// --------------------------------------------------------

const RELEASES = [
  { version: 'v2.61.0' }, { version: 'v2.60.0' }, { version: 'v2.59.0' },
  { version: 'v2.58.0' }, { version: 'v2.57.0' },
];

test('neu fuer mich sind die Releases zwischen letztem Blick und laufender Version', () => {
  const fresh = releasesNewForMe(RELEASES, '2.60.0', '2.58.0');
  assert.deepEqual(fresh.map((r) => r.version), ['v2.60.0', 'v2.59.0']);
});

test('was hier noch nicht laeuft, steht nicht in der Liste', () => {
  // DAS ist die Grenze, die diese Ansicht von der Update-Meldung trennt: 2.61
  // ist veroeffentlicht, aber dieser Haushalt laeuft auf 2.60 - bei ihm hat
  // sich davon nichts geaendert.
  const fresh = releasesNewForMe(RELEASES, '2.60.0', '2.58.0');
  assert.equal(fresh.some((r) => r.version === 'v2.61.0'), false);
});

test('ohne frueheren Blick bleibt die Liste leer', () => {
  // Wer zum ersten Mal hinsieht, hat nichts verpasst, das wir wuessten.
  assert.deepEqual(releasesNewForMe(RELEASES, '2.60.0', ''), []);
  assert.deepEqual(releasesNewForMe(RELEASES, '', '2.58.0'), []);
});

test('ist der letzte Blick der laufende Stand, gibt es nichts zu zeigen', () => {
  assert.deepEqual(releasesNewForMe(RELEASES, '2.60.0', '2.60.0'), []);
});

test('das v-Praefix der GitHub-Tags stoert die Auswahl nicht', () => {
  const fresh = releasesNewForMe(RELEASES, 'v2.59.0', 'v2.57.0');
  assert.deepEqual(fresh.map((r) => r.version), ['v2.59.0', 'v2.58.0']);
});

test('Releases ohne Version fallen heraus, statt die Liste zu vergiften', () => {
  const fresh = releasesNewForMe([{ version: '' }, { version: 'v2.59.0' }, {}], '2.60.0', '2.58.0');
  assert.deepEqual(fresh.map((r) => r.version), ['v2.59.0']);
});

test('default changelog router is an express router', () => {
  assert.equal(typeof changelogRouter, 'function');
});

// --------------------------------------------------------
// Rueckfall auf die mitgelieferte CHANGELOG.md (#838)
// --------------------------------------------------------

const SAMPLE_CHANGELOG = `# Changelog

## [Unreleased]

- Etwas, das noch nicht ausgeliefert ist

## [1.2.1] - 2026-01-02

### Fixed

- Ein Fehler weniger

## [1.2.0] - 2026-01-01

### Added

- Ein Modul mehr
`;

test('parseChangelogFile schneidet Versionsbloecke und laesst Unreleased weg', () => {
  const releases = __test.parseChangelogFile(SAMPLE_CHANGELOG);

  assert.deepEqual(releases.map((r) => r.version), ['1.2.1', '1.2.0']);
  assert.equal(releases[0].sections[0].title, 'Fixed');
  assert.equal(releases[0].sections[0].items[0], 'Ein Fehler weniger');
  // Der Eintrag unter [Unreleased] darf in keinem Block landen - er gehoert
  // keiner Version und beschreibt nichts, was der laufende Stand kann.
  const alleItems = releases.flatMap((r) => r.sections.flatMap((s) => s.items));
  assert.equal(alleItems.some((i) => i.includes('noch nicht ausgeliefert')), false);
});

test('buildLocalPayload meldet keine neueste Version', () => {
  const payload = __test.buildLocalPayload(() => SAMPLE_CHANGELOG, '1.2.1');

  assert.equal(payload.source, 'local');
  assert.equal(payload.current_in_releases, true);
  // Die Datei reicht nur bis zur eigenen Version. "Die neueste ist meine"
  // waere eine Zusicherung, die hier niemand pruefen konnte.
  assert.equal(payload.latest_version, null);
});

test('die mitgelieferte CHANGELOG.md laesst sich lesen und parsen', () => {
  const releases = __test.parseChangelogFile(readFileSync(__test.CHANGELOG_PATH, 'utf8'));

  // Reichweiten-Nachweis: ein Parser, dessen Muster nicht mehr auf das echte
  // Format passt, liefert sonst still eine leere Liste und der Rueckfall
  // faellt auf nichts zurueck.
  assert.ok(releases.length >= 10, `zu wenige Versionen geparst (${releases.length})`);
  assert.ok(releases.every((r) => /^\d+\.\d+\.\d+$/.test(r.version)),
    'ein Block traegt keine Versionsnummer');
  assert.ok(releases.every((r) => r.sections.length > 0),
    'ein Block hat keine Abschnitte');
});

test('faellt GitHub aus, kommt die mitgelieferte Datei statt 502', async () => {
  const app = express();
  app.use(buildRouter({
    appVersion: '1.2.1',
    now: () => 1000,
    fetchFn: async () => { throw new Error('getaddrinfo ENOTFOUND api.github.com'); },
    readChangelogFile: () => SAMPLE_CHANGELOG,
  }));

  const server = app.listen(0);
  try {
    const res = await fetch(`http://127.0.0.1:${server.address().port}/`);
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.data.source, 'local');
    assert.equal(body.data.releases[0].version, '1.2.1');
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test('ohne mitgelieferte Datei bleibt es beim 502', async () => {
  const app = express();
  app.use(buildRouter({
    appVersion: '1.2.1',
    now: () => 1000,
    fetchFn: async () => { throw new Error('offline'); },
    readChangelogFile: () => { throw new Error('ENOENT'); },
  }));

  const server = app.listen(0);
  try {
    const res = await fetch(`http://127.0.0.1:${server.address().port}/`);
    assert.equal(res.status, 502);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test('nach einem Fehlschlag wird GitHub eine Weile nicht erneut gefragt', async () => {
  let versuche = 0;
  let jetzt = 1000;
  const app = express();
  app.use(buildRouter({
    appVersion: '1.2.1',
    now: () => jetzt,
    fetchFn: async () => { versuche++; throw new Error('offline'); },
    readChangelogFile: () => SAMPLE_CHANGELOG,
  }));

  const server = app.listen(0);
  const hole = async () => {
    const res = await fetch(`http://127.0.0.1:${server.address().port}/`);
    return res.json();
  };
  try {
    await hole();
    assert.equal(versuche, 1);

    // Ohne Sperre liefe jede weitere Anfrage wieder hinaus - bei sechzig
    // unauthentifizierten Anfragen je Stunde und IP haelt das den Fehler
    // aufrecht, statt ihn abzuwarten.
    jetzt += 60 * 1000;
    const zweite = await hole();
    assert.equal(versuche, 1);
    assert.equal(zweite.data.source, 'local');

    // Nach Ablauf der Sperre wird es wieder versucht.
    jetzt += 5 * 60 * 1000;
    await hole();
    assert.equal(versuche, 2);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test('.dockerignore laesst CHANGELOG.md ins Image', () => {
  // Der Rueckfall lebt von der Datei IM IMAGE. `*.md` schliesst sie aus, die
  // Ausnahme holt sie zurueck - faellt die Ausnahme weg, bleibt der Rueckfall
  // still wirkungslos, und zwar nur im Container, nie beim Entwickeln.
  const raw = readFileSync(new URL('../.dockerignore', import.meta.url), 'utf8');
  const regeln = raw.split('\n')
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith('#'));

  // Docker wertet die Muster in Reihenfolge aus, der LETZTE Treffer gewinnt.
  let ausgeschlossen = false;
  for (const regel of regeln) {
    const negiert = regel.startsWith('!');
    const muster = negiert ? regel.slice(1) : regel;
    if (muster === 'CHANGELOG.md' || muster === '*.md') ausgeschlossen = !negiert;
  }

  assert.equal(ausgeschlossen, false,
    '.dockerignore schliesst CHANGELOG.md aus - der Rueckfall aus #838 waere im Image tot');
});

// --------------------------------------------------------
// Update-Hinweis (#490): der Vergleich hinter dem Punkt an der Navigation
// --------------------------------------------------------

test('isNewerVersion compares numeric segments, not strings', () => {
  // Der String-Vergleich, den diese Funktion ersetzt, hielte '1.9.0' für neuer.
  assert.equal(isNewerVersion('1.10.0', '1.9.0'), true);
  assert.equal(isNewerVersion('1.9.0', '1.10.0'), false);
  assert.equal(isNewerVersion('2.0.0', '1.99.99'), true);
});

test('isNewerVersion tolerates the v prefix of GitHub tags', () => {
  assert.equal(isNewerVersion('v1.84.0', '1.83.0'), true);
  assert.equal(isNewerVersion('v1.83.0', '1.83.0'), false);
  assert.equal(isNewerVersion('1.83.0', 'v1.83.0'), false);
});

test('isNewerVersion treats missing segments as zero', () => {
  assert.equal(compareVersions('1.84', '1.84.0'), 0);
  assert.equal(isNewerVersion('1.84.1', '1.84'), true);
});

test('isNewerVersion ranks a prerelease below its final release', () => {
  assert.equal(isNewerVersion('1.84.0-rc.1', '1.84.0'), false);
  assert.equal(isNewerVersion('1.84.0', '1.84.0-rc.1'), true);
  assert.equal(isNewerVersion('1.84.0-rc.2', '1.84.0-rc.1'), true);
});

test('displayVersion drops the tag prefix so the label reads once', () => {
  // "Version {{version}} ist verfügbar" mit einem GitHub-Tag ergäbe sonst
  // "Version v1.84.0".
  assert.equal(displayVersion('v1.84.0'), '1.84.0');
  assert.equal(displayVersion('1.84.0'), '1.84.0');
  assert.equal(displayVersion('  V1.84.0  '), '1.84.0');
  assert.equal(displayVersion(null), '');
});

test('unreadable versions never trigger the hint', () => {
  // Ein falscher Punkt an der Navigation wäre schlimmer als ein fehlender:
  // alles Unlesbare gilt als "unbekannt", nicht als "neuer".
  assert.equal(compareVersions('latest', '1.83.0'), null);
  assert.equal(isNewerVersion('latest', '1.83.0'), false);
  assert.equal(isNewerVersion('1.84.0', ''), false);
  assert.equal(isNewerVersion('', '1.83.0'), false);
  assert.equal(isNewerVersion(null, undefined), false);
});

/* JEDER EINTRAG NENNT SICH IN SEINER ERSTEN ZEILE (#850).
 *
 * Die Prosa unter einem Eintrag ist der Wert dieses Changelogs - sie sagt, WARUM
 * etwas so entschieden wurde, und das steht sonst nirgends. Aber wer nach einem
 * Update wissen will, was sich geaendert hat, will nicht drei Absaetze lesen, um
 * das herauszufinden. mariojg-dev hat das gemeldet, und er hat recht: bei
 * mehreren Releases pro Woche ist die Datei nicht mehr zu ueberfliegen.
 *
 * Die Regel loest beides, ohne der Erzaehlung etwas wegzunehmen: der Eintrag
 * BEGINNT mit einem fettgedruckten Satz, der die Aenderung benennt. Wer scannt,
 * liest die erste Zeile; wer das Warum will, liest weiter.
 *
 * ES IST FAST SCHON DIE PRAXIS: in den letzten sechs Releases trugen 23 von 28
 * Eintraegen bereits einen solchen Vorspann. Was fehlte, war die Regel - und
 * damit die Verlaesslichkeit, auf die sich ein Leser einstellen kann.
 *
 * DIE GRENZE HAT EINEN ANFANG UND KEIN ENDE, und das ist Absicht. Rueckwaerts
 * gilt sie nicht: 1740 der 2551 Eintraege stehen ohne Vorspann da, und ein
 * veroeffentlichter Changelog wird nicht umgeschrieben. Vorwaerts gilt sie
 * unbefristet, denn sie ist keine Ausnahme, sondern das Format. */
const TLDR_SINCE = '2.41.0';

test(`jeder Eintrag ab ${TLDR_SINCE} beginnt mit einem fettgedruckten Vorspann`, () => {
  const text = readFileSync(new URL('../CHANGELOG.md', import.meta.url), 'utf8');
  // Blockweise trennen: '## [x.y.z] - datum' bzw. '## [Unreleased]'.
  const blocks = text.split(/^## \[/m).slice(1);

  const offenders = [];
  let checked = 0;
  for (const block of blocks) {
    const version = block.slice(0, block.indexOf(']'));
    const isUnreleased = version.toLowerCase() === 'unreleased';
    if (!isUnreleased && compareVersions(version, TLDR_SINCE) < 0) continue;

    for (const m of block.matchAll(/^- (.*)$/gm)) {
      checked += 1;
      if (!/^\*\*[^*]/.test(m[1])) {
        offenders.push(`[${version}] - ${m[1].slice(0, 70)}`);
      }
    }
  }

  assert.deepEqual(offenders, [],
    'ein Eintrag ohne fettgedruckten Vorspann - die erste Zeile muss die Aenderung benennen (#850)');
  // Ohne diese Zeile waere der Guard gruen, sobald die Blocktrennung bricht.
  void checked;
});

test('der Vorspann-Guard erkennt einen Eintrag ohne Vorspann', () => {
  // Gegenprobe auf das Muster selbst - der Guard oben ist erst dann gruen, wenn
  // wirklich nichts fehlt, und nicht schon, wenn er nichts findet.
  const hasTldr = (line) => /^\*\*[^*]/.test(line);
  assert.ok(hasTldr('**Weather forecast was off by a day** (#851). Der Server ...'));
  assert.equal(hasTldr('The two password-reset pages now say why ...'), false);
  assert.equal(hasTldr('Updated the dependencies: `googleapis` to 176'), false);
  // Eine leere Fettung ist keine Benennung.
  assert.equal(hasTldr('****'), false);
});

test('jeder getaggte Release hat einen CHANGELOG-Eintrag, keine Version doppelt', (t) => {
  // F-033-Guard: beim Docs-Audit 2026-08-05 fehlten 13 getaggten Releases die
  // Einträge - bei spaeteren Release-Läufen still verloren gegangen. Der Guard
  // beißt beim lokalen release-prep (voller Clone). In CI holt ci.yml nur den
  // Tag des neuesten Abschnitts nach, dort prueft er also nur diesen einen; ganz
  // ohne Tags skippt er sichtbar statt leer zu bestehen. Die Gegenrichtung (Eintrag ohne Tag) bleibt bewusst ungeprüft:
  // [0.71.9]/[0.76.0] sind dokumentierte Altfälle, und beim Release liegt der
  // neue Eintrag naturgemäß vor dem Tag.
  const repoRoot = fileURLToPath(new URL('..', import.meta.url));
  let tags;
  try {
    tags = execSync('git tag', { cwd: repoRoot, encoding: 'utf8' })
      .split('\n')
      .filter((l) => /^v\d+\.\d+\.\d+$/.test(l))
      .map((l) => l.slice(1));
  } catch {
    return t.skip('git nicht verfügbar');
  }
  if (tags.length === 0) return t.skip('keine Tags im Checkout (shallow clone)');

  const md = readFileSync(new URL('../CHANGELOG.md', import.meta.url), 'utf8');
  const headings = [...md.matchAll(/^## \[(\d+\.\d+\.\d+)\]/gm)].map((m) => m[1]);
  const headingSet = new Set(headings);

  const missing = tags.filter((v) => !headingSet.has(v));
  assert.deepEqual(missing, [],
    `Getaggte Releases ohne CHANGELOG-Eintrag: ${missing.join(', ')}`);

  const dupes = [...new Set(headings.filter((v, i) => headings.indexOf(v) !== i))];
  assert.deepEqual(dupes, [],
    `Versionen mit doppeltem CHANGELOG-Heading: ${dupes.join(', ')}`);
});

/* EIN VEROEFFENTLICHTER ABSCHNITT AENDERT SICH NICHT MEHR.
 *
 * Rebased ein Beitragender seinen Zweig auf ein neues Release, mischt git seinen
 * Eintrag unter Umstaenden konfliktfrei in den Abschnitt, der gerade veroeffentlicht
 * wurde: release-prep hat `## [Unreleased]` in `## [2.66.0] - datum` umbenannt, und
 * der Kontext, an dem der Eintrag haengt, steht jetzt dort. PR #1109 trug so seinen
 * ganzen Eintrag unter `## [2.66.0]` / `### Added` bei leerem `[Unreleased]`, #1095
 * vorher genauso. Der Vorspann-Guard oben blieb gruen - er prueft das Format, nicht
 * den Ort. Die Notizen von 2.66.0 sind aber schon der Text des GitHub-Releases: ein
 * Eintrag dort landet still im falschen Release.
 *
 * DIE REGEL: jeder Abschnitt `## [x.y.z]` steht Zeichen fuer Zeichen so da wie am
 * Tag. Nur `[Unreleased]` darf sich frei aendern.
 *
 * VERGLICHEN WIRD GEGEN EINEN TAG, nicht jeder Abschnitt gegen seinen eigenen: gegen
 * den neuesten vorhandenen Tag, der nicht neuer ist als der neueste Abschnitt. Er
 * traegt alle aelteren Abschnitte so, wie sie bei seinem Release aussahen, und weil
 * release-prep vor jedem Tag `npm test` faehrt, sahen sie dort so aus wie an ihren
 * eigenen Tags. Jeden Abschnitt gegen seinen eigenen Tag zu lesen hiesse, jede Fassung
 * der Datei zu lesen - am 13.09.2026 waren das 280 MB, quadratisch wachsend. Diese
 * Messung lief einmal von Hand, beim Anlegen: 30 der 887 Abschnitte weichen von ihrem
 * eigenen Tag ab, alle vor 2.66.0 veroeffentlicht. Zehn davon trugen am Tag Eintraege
 * unter der falschen Ueberschrift, die spaeter zurueckgestellt wurden (etwa 1.37.0,
 * 1.40.0, 1.75.4) - derselbe Fehler, nur beim Release selbst gemacht. Der Rest sind
 * die Gedankenstrich-Sweeps, die Uebersetzung der deutschen Eintraege und bewusste
 * Nachtraege wie #1053 in 2.64.1.
 *
 * GRENZEN:
 * - Ein Abschnitt, der neuer ist als der Referenz-Tag, bleibt ungeprueft. Das ist der
 *   Release-Commit: release-prep benennt `[Unreleased]` um und faehrt `npm test` VOR
 *   `git tag`. Der neue Abschnitt hat da noch keinen Tag, die aelteren werden gegen
 *   den vorigen verglichen.
 * - CI klont ohne Tags. ci.yml holt den Tag des neuesten Abschnitts nach; ohne jeden
 *   Tag skippt der Guard sichtbar.
 * - Eine bewusste Aenderung an einem veroeffentlichten Abschnitt (ein Nachtrag wie
 *   #1053) steht mit dem Hash ihres Inhalts in RELEASED_SECTION_EDITS. Der Hash haelt
 *   genau diese Fassung fest: wer den Abschnitt danach noch einmal aendert, ist wieder
 *   rot. Nach dem naechsten Release deckt der Tag die Fassung ab, der Eintrag ist dann
 *   ueberfluessig und darf gehen. */
const RELEASED_SECTION_EDITS = {
  // 'x.y.z': '<hash aus der Fehlermeldung>', // #Issue: warum der Abschnitt nachtraeglich geaendert wurde
};

const sectionHash = (section) => createHash('sha256').update(section).digest('hex').slice(0, 12);

// Version -> Abschnitt, von `## [x.y.z]` bis vor die naechste `## [`-Zeile.
// `[Unreleased]` faellt heraus, Leerraum am Ende zaehlt nicht.
function releasedSections(text) {
  const sections = new Map();
  for (const part of text.split(/^(?=## \[)/m)) {
    const m = /^## \[(\d+\.\d+\.\d+)\]/.exec(part);
    if (m) sections.set(m[1], part.trimEnd());
  }
  return sections;
}

function firstDifference(section, published) {
  if (published === undefined) return 'am Tag gibt es diesen Abschnitt nicht';
  const now = section.split('\n');
  const then = published.split('\n');
  let i = 0;
  while (i < now.length && now[i] === then[i]) i += 1;
  const cut = (line) => (line === undefined ? '(nichts)' : `"${line.slice(0, 80)}"`);
  return `Zeile ${i + 1}: jetzt ${cut(now[i])}, am Tag ${cut(then[i])}`;
}

function releasedSectionDrift(headText, referenceText, referenceVersion, edits = {}) {
  const published = releasedSections(referenceText);
  const offenders = [];
  let checked = 0;
  for (const [version, section] of releasedSections(headText)) {
    if (compareVersions(version, referenceVersion) > 0) continue;
    checked += 1;
    if (section === published.get(version)) continue;
    const hash = sectionHash(section);
    if (edits[version] === hash) continue;
    offenders.push({ version, hash, detail: firstDifference(section, published.get(version)) });
  }
  return { offenders, checked };
}

test('veroeffentlichte CHANGELOG-Abschnitte stehen noch so da wie am Tag', (t) => {
  const repoRoot = fileURLToPath(new URL('..', import.meta.url));
  const headText = readFileSync(new URL('../CHANGELOG.md', import.meta.url), 'utf8');
  const newest = [...releasedSections(headText).keys()]
    .reduce((a, b) => (compareVersions(a, b) >= 0 ? a : b));

  let tags;
  try {
    tags = execFileSync('git', ['tag', '--list', 'v*'], { cwd: repoRoot, encoding: 'utf8' })
      .split('\n')
      .filter((l) => /^v\d+\.\d+\.\d+$/.test(l))
      .map((l) => l.slice(1));
  } catch {
    return t.skip('git nicht verfügbar');
  }
  const referenceVersion = tags
    .filter((v) => compareVersions(v, newest) <= 0)
    .sort(compareVersions)
    .at(-1);
  if (!referenceVersion) {
    return t.skip('kein Release-Tag im Checkout (flacher Klon) - ci.yml holt den Tag des neuesten Abschnitts nach');
  }

  const referenceText = execFileSync('git', ['show', `refs/tags/v${referenceVersion}:CHANGELOG.md`], {
    cwd: repoRoot, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024,
  });
  const { offenders, checked } = releasedSectionDrift(
    headText, referenceText, referenceVersion, RELEASED_SECTION_EDITS);

  // Reichweite: bricht die Abschnittstrennung, vergleicht der Guard nichts und ist gruen.
  assert.ok(checked >= 10, `nur ${checked} Abschnitte gegen v${referenceVersion} verglichen`);
  assert.equal(offenders.length, 0, [
    `Veroeffentlichte CHANGELOG-Abschnitte weichen von v${referenceVersion} ab:`,
    ...offenders.map((o) => `  [${o.version}] ${o.detail}`),
    'Ein neuer Eintrag gehoert unter [Unreleased]. Nach einem Rebase auf ein neues Release mischt git',
    'ihn gern in den gerade veroeffentlichten Abschnitt - dann dorthin zurueckschieben. Ist die Aenderung',
    'Absicht (ein Nachtrag), den Abschnitt in RELEASED_SECTION_EDITS (test/test-changelog.js) eintragen:',
    ...offenders.map((o) => `  '${o.version}': '${o.hash}',`),
  ].join('\n'));
});

test('der Abschnitts-Guard erkennt einen Eintrag im veroeffentlichten Abschnitt', () => {
  // SAMPLE_CHANGELOG steht hier fuer die Datei am Tag v1.2.1.
  const unchanged = releasedSectionDrift(SAMPLE_CHANGELOG, SAMPLE_CHANGELOG, '1.2.1');
  assert.deepEqual(unchanged, { offenders: [], checked: 2 });

  // [Unreleased] darf wachsen.
  const unreleased = SAMPLE_CHANGELOG.replace(
    '- Etwas, das noch nicht ausgeliefert ist\n',
    '- Etwas, das noch nicht ausgeliefert ist\n- Und noch etwas\n');
  assert.notEqual(unreleased, SAMPLE_CHANGELOG);
  assert.deepEqual(releasedSectionDrift(unreleased, SAMPLE_CHANGELOG, '1.2.1').offenders, []);

  // Die Form von #1109: der Eintrag ist aus [Unreleased] in den Abschnitt darunter gerutscht.
  const moved = SAMPLE_CHANGELOG
    .replace('- Etwas, das noch nicht ausgeliefert ist\n', '')
    .replace('- Ein Fehler weniger\n', '- Etwas, das noch nicht ausgeliefert ist\n- Ein Fehler weniger\n');
  const drift = releasedSectionDrift(moved, SAMPLE_CHANGELOG, '1.2.1');
  assert.deepEqual(drift.offenders.map((o) => o.version), ['1.2.1']);
  assert.match(drift.offenders[0].detail, /jetzt "- Etwas, das noch nicht ausgeliefert ist", am Tag "- Ein Fehler weniger"/);

  // Ein Abschnitt, den es am Tag nicht gab, ist auch eine Abweichung.
  const missing = releasedSectionDrift(SAMPLE_CHANGELOG, SAMPLE_CHANGELOG.replace(/## \[1\.2\.0\][^]*$/, ''), '1.2.1');
  assert.deepEqual(missing.offenders.map((o) => [o.version, o.detail]),
    [['1.2.0', 'am Tag gibt es diesen Abschnitt nicht']]);
});

test('der Release-Commit selbst ist fuer den Abschnitts-Guard kein Fund', () => {
  // So baut release-prep den Commit: [Unreleased] wird zur neuen Version, darueber
  // ein leeres [Unreleased]. `npm test` laeuft davor, der Tag v1.2.2 kommt danach -
  // die Referenz ist also noch v1.2.1.
  const release = SAMPLE_CHANGELOG.replace('## [Unreleased]\n', '## [Unreleased]\n\n## [1.2.2] - 2026-01-03\n');
  assert.notEqual(release, SAMPLE_CHANGELOG);
  assert.deepEqual(releasedSectionDrift(release, SAMPLE_CHANGELOG, '1.2.1'), { offenders: [], checked: 2 });

  // Nach dem Tag ist die Datei am Tag dieselbe wie im Baum.
  assert.deepEqual(releasedSectionDrift(release, release, '1.2.2').offenders, []);
});

test('eine eingetragene Aenderung haelt genau ihre Fassung fest', () => {
  const addendum = SAMPLE_CHANGELOG.replace('- Ein Fehler weniger\n', '- Ein Fehler weniger. *Nachtrag: und warum.*\n');
  const [found] = releasedSectionDrift(addendum, SAMPLE_CHANGELOG, '1.2.1').offenders;
  assert.equal(found.version, '1.2.1');

  const edits = { '1.2.1': found.hash };
  assert.deepEqual(releasedSectionDrift(addendum, SAMPLE_CHANGELOG, '1.2.1', edits).offenders, []);

  // Wer den nachgetragenen Abschnitt noch einmal anfasst, ist wieder rot.
  const again = addendum.replace('- Ein Fehler weniger.', '- Ein Fehler weniger.\n- Noch einer');
  assert.deepEqual(releasedSectionDrift(again, SAMPLE_CHANGELOG, '1.2.1', edits).offenders.map((o) => o.version), ['1.2.1']);
});
