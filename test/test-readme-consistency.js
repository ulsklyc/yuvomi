/**
 * Modul: README als Landingpage - Drift- und Struktur-Guard
 * Zweck: Yuvomi hat DREI handgepflegte Verkaufsflaechen, die dasselbe Produkt
 *        beschreiben: `README.md`, `README.de.md` und `docs/index.html`. Die
 *        Critique vom 2026-08-16 hat fuenf bereits eingetretene Einwegdrifts
 *        gefunden - jedes Mal war die Homepage weiter und die README nicht
 *        nachgezogen. `test-docs-landing.js` haelt die Substitutionstabelle
 *        zusammen; diese Suite haelt den Rest:
 *
 *        (1) Der Installationsweg trennt den menschlichen Schritt vom Start.
 *            Vorher stand `cp .env.example .env` als Kommentar in DEMSELBEN
 *            Copy-Block, dessen letzte Zeile `docker compose up -d` war - wer
 *            ihn einfuegte, startete mit dem Platzhalter-Schluessel, und
 *            `openssl rand -hex 32` kam in 486 Zeilen kein einziges Mal vor.
 *
 *        (2) Die behaupteten Zahlen sind die gezaehlten. Modulzahl gegen die
 *            Tabellenzeilen UND gegen die Karten der Homepage, Sprachzahl gegen
 *            `public/locales/`.
 *
 *        (3) Jeder Modulname der Homepage steht in der README-Tabelle. Ein
 *            neunzehntes Modul, das nur eine der beiden Flaechen lernt, faellt
 *            hier auf - nicht erst in der naechsten Critique.
 *
 *        (4) EN und DE bleiben strukturgleich. Die Uebersetzung ist bisher
 *            zeilengenau parallel; sie driftet still, weil ein Fix in der einen
 *            Datei ohne Fehlermeldung in der anderen fehlen kann.
 *
 *        (5) Kein toter relativer Link, kein toter Anker, kein Em- oder
 *            En-Dash (CLAUDE.md: immer "-").
 *
 * Ausfuehren: node --test test/test-readme-consistency.js
 *             (bzw. npm run test:readme-consistency)
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { dictBlock, dictKeysMatching, dictValue, stripTags, unescapeJs } from './docs-dict.js';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const READMES = { en: 'README.md', de: 'README.de.md' };

const read = (rel) => readFileSync(resolve(ROOT, rel), 'utf8');
const readme = (lang) => read(READMES[lang]);

/**
 * Fenced Code-Bloecke einer Markdown-Datei, als reiner Inhalt ohne Zaun.
 *
 * Bewusst ueber die Zaunzeilen und nicht ueber ein `[\s\S]*?`-Paar: ein Block,
 * dessen Inhalt selbst drei Backticks traegt, wuerde vom non-greedy Muster in
 * der Mitte geschnitten, und der Guard urteilte dann ueber einen halben Block.
 */
function codeBlocks(md) {
  const blocks = [];
  let current = null;
  for (const line of md.split('\n')) {
    if (/^```/.test(line)) {
      if (current === null) current = [];
      else { blocks.push(current.join('\n')); current = null; }
      continue;
    }
    if (current !== null) current.push(line);
  }
  return blocks;
}

// ── (1) Der Install-Block trennt den menschlichen Schritt vom Start ──────────

/**
 * Die Falle in einem Satz: EIN Block, in dem der Start hinter dem Schritt
 * steht, den ein Mensch dazwischen tun muss. Genau diese Form pruefen wir, und
 * nicht "steht irgendwo ein Warnsatz" - der stand vorher auch da, nur eben
 * NACH dem Block, der schon durchgelaufen war.
 */
function startsAfterHumanStep(md) {
  // Beide Engines und beide Podman-Schreibweisen: docs/installation.md traegt
  // einen eigenen Podman-Block (`podman compose -f ... up -d`), und genau der
  // war bis 2026-09-30 so verschmolzen wie der Docker-Block darueber.
  const start = /\b(?:docker|podman)[ -]compose\b[^\n]*\bup -d\b/;
  return codeBlocks(md).filter((b) => start.test(b) && /cp .env.example .env/.test(b));
}

for (const lang of Object.keys(READMES)) {
  test(`${READMES[lang]}: der Start steht nicht im selben Block wie das Anlegen der .env`, () => {
    const md = readme(lang);

    assert.match(md, /openssl rand -hex 32/,
      'Die README verlangt zwei Secrets und sagt nicht, wie man sie erzeugt. '
      + '`openssl rand -hex 32` gehoert in den Install-Block.');

    const fused = startsAfterHumanStep(md);
    assert.deepEqual(fused, [],
      'Ein Copy-Block legt die .env an UND startet den Container. Wer ihn einfuegt, '
      + 'startet mit dem Platzhalter-Schluessel aus .env.example. Der Start gehoert in '
      + 'einen eigenen Block hinter den Hinweis.');

    // Blockquote-Marken mit wegschneiden: der Warnsatz steht als `>`-Zitat und
    // ist umbrochen, ein blosses \n->" " liesse "geaenderter > Schluessel" stehen.
    const warn = /verlorener oder ge[aä]nderter\s+Schl[uü]ssel|lost or changed key/;
    assert.match(md.replace(/\n>?\s*/g, ' '), warn,
      'Die Unumkehrbarkeit des DB-Schluessels steht nirgends. Wer den Platzhalter '
      + 'stehen laesst, verschluesselt mit einem oeffentlich bekannten Wert.');
  });
}

test('der Install-Guard erkennt den Schaden, gegen den er gebaut ist', () => {
  const damaged = [
    '```bash',
    'curl -O https://example.invalid/docker-compose.yml',
    'cp .env.example .env          # set SESSION_SECRET and DB_ENCRYPTION_KEY',
    'docker compose up -d',
    '```',
  ].join('\n');

  assert.equal(startsAfterHumanStep(damaged).length, 1,
    'Der Guard muss genau die Fassung rot machen, die bis 2026-08-16 in der README stand.');
  assert.equal(startsAfterHumanStep(read('README.md')).length, 0);

  // Die Podman-Fassung aus docs/installation.md bis 2026-09-30.
  const podman = [
    '```bash',
    'cp .env.example .env  # set SESSION_SECRET and DB_ENCRYPTION_KEY',
    'podman compose -f podman-compose.yml up -d   # or: podman-compose -f podman-compose.yml up -d',
    '```',
  ].join('\n');
  assert.equal(startsAfterHumanStep(podman).length, 1, 'Der Podman-Start im selben Block faellt nicht auf.');
});

// Dieselbe Falle in der ausfuehrlichen Anleitung. Die README war seit
// 2026-08-16 getrennt; docs/installation.md "Option C" legte die .env weiter im
// selben Block an, der auch startete - ohne `openssl rand` und fuer Docker UND
// Podman (Critique 2026-09-30).
test('docs/installation.md: kein Copy-Block legt die .env an und startet', () => {
  const md = read('docs/installation.md');
  assert.deepEqual(startsAfterHumanStep(md), [],
    'docs/installation.md: ein Copy-Block legt die .env an UND startet den Container. '
    + 'Secrets erzeugen, .env von Hand fuellen, dann erst in einem eigenen Block starten.');
  // Ohne diese Vorbedingung waere der Test gruen, weil es gar keinen
  // Kurzweg mehr gibt, den er pruefen koennte.
  const quick = md.split(/^### /m).find((s) => /^Option C .*Manual/.test(s));
  assert.ok(quick, 'Abschnitt "Option C - Manual" nicht gefunden - Muster veraltet?');
  assert.match(quick, /openssl rand -hex 32/, 'Der Kurzweg sagt nicht, wie man die Secrets erzeugt.');
  assert.match(quick, /REPLACE_WITH_/, 'Der Kurzweg nennt den Platzhalter nicht, den man ersetzen muss.');
});

// ── (2) Behauptete Zahlen == gezaehlte Zahlen ───────────────────────────────

/** Markdown-Tabellen als zusammenhaengende Bloecke: Kopfzeile plus Datenzeilen. */
function tables(md) {
  const lines = md.split('\n');
  const found = [];
  for (let i = 0; i < lines.length; i++) {
    if (!/^\|[-: |]+\|$/.test(lines[i]) || i === 0) continue;
    const rows = [];
    for (let j = i + 1; j < lines.length && /^\|.*\|$/.test(lines[j]); j++) rows.push(lines[j]);
    found.push({ header: lines[i - 1], rows });
  }
  return found;
}

/**
 * Die Modultabelle: Zeilen der Form `| **Name** | Ein Satz. |`, aus der Tabelle
 * mit BENANNTER Kopfzeile.
 *
 * Erst an der Form und dann am Kopf erkannt, nicht an der Position - die
 * verschiebt sich beim naechsten Umbau. Der Kopf muss sein: die Betriebsdaten
 * standen im ersten Entwurf als titellose Tabelle (`| **Image** | ghcr.io/… |`)
 * im Installationsabschnitt, trugen dieselbe Zeilenform, und der Guard erfand
 * daraus funf Module dazu - er sagte 23 statt 18. Sie sind inzwischen eine
 * Liste, aber die naechste titellose Tabelle kommt bestimmt. Die
 * Substitutionstabelle faellt schon ueber die Form heraus
 * (`| text | **Name** - text |`).
 */
function moduleRows(md) {
  const parse = (rows) => rows
    .map((l) => l.match(/^\| \*\*(.+?)\*\* \| (.+?) \|$/))
    .filter(Boolean)
    .map((m) => ({ name: m[1].replace(/&amp;/g, '&').trim(), line: m[2].trim() }));

  const named = tables(md).filter((t) => /\|\s*\S/.test(t.header));
  for (const t of named) {
    const parsed = parse(t.rows);
    if (parsed.length === t.rows.length && parsed.length >= 10) return parsed;
  }
  return [];
}

const NUMBER_WORDS = {
  sixteen: 16, seventeen: 17, eighteen: 18, nineteen: 19, twenty: 20,
  sechzehn: 16, siebzehn: 17, achtzehn: 18, neunzehn: 19, zwanzig: 20,
};

/** Das Zahlwort aus der Ueberschrift ueber der Modultabelle. */
function claimedModuleWord(md) {
  const heading = md.split('\n').find((l) => /^## /.test(l) && new RegExp(`\\b(${Object.keys(NUMBER_WORDS).join('|')})\\b`, 'i').test(l));
  if (!heading) return null;
  const hit = Object.entries(NUMBER_WORDS).find(([w]) => new RegExp(`\\b${w}\\b`, 'i').test(heading));
  return hit ? { word: hit[0], value: hit[1], heading: heading.trim() } : null;
}

/** Die Ziffer aus der Kennzahlenzeile (`<b>18</b> modules` / `… Module`). */
function claimedModuleDigit(md) {
  const m = md.match(/<b>(\d+)<\/b>\s*(?:modules|Module)\b/);
  return m ? Number(m[1]) : null;
}

for (const lang of Object.keys(READMES)) {
  test(`${READMES[lang]}: jede genannte Modulzahl ist die Zahl der Tabellenzeilen`, () => {
    const md = readme(lang);
    const rows = moduleRows(md);
    assert.ok(rows.length >= 10, `Modultabelle nicht gefunden oder zu kurz (${rows.length} Zeilen) - Muster veraltet?`);

    const word = claimedModuleWord(md);
    assert.ok(word, 'Keine Ueberschrift mit ausgeschriebener Modulzahl gefunden.');
    assert.equal(word.value, rows.length,
      `"${word.heading}" sagt ${word.value}, die Tabelle hat ${rows.length} Zeilen.`);

    const digit = claimedModuleDigit(md);
    assert.equal(digit, rows.length,
      `Die Kennzahlenzeile sagt ${digit} Module, die Tabelle hat ${rows.length} Zeilen.`);
  });

  test(`${READMES[lang]}: die genannte Sprachzahl ist die Zahl der Locale-Dateien`, () => {
    const md = readme(lang);
    const locales = readdirSync(resolve(ROOT, 'public/locales')).filter((f) => f.endsWith('.json')).length;

    const claims = [...md.matchAll(/(\d+)\s*(?:<\/b>\s*)?(?:languages|Sprachen)\b/g)].map((m) => Number(m[1]));
    assert.ok(claims.length >= 2, `nur ${claims.length} Sprachangaben gefunden - Muster veraltet?`);

    for (const claimed of claims) {
      assert.equal(claimed, locales,
        `Die README nennt ${claimed} Sprachen, public/locales/ enthaelt ${locales} Dateien.`);
    }
  });
}

// ── (3) Modulnamen README == Modulnamen Homepage ────────────────────────────

test('jeder Modulname der Homepage steht in der README-Modultabelle', () => {
  const html = read('docs/index.html');
  const en = dictBlock(html, 'en');
  assert.ok(en, 'en-Woerterbuch in docs/index.html nicht gefunden');

  const cardNames = dictKeysMatching(en, /^m_[a-z0-9]+_t$/)
    .map((k) => stripTags(dictValue(en, k) || ''))
    .filter(Boolean);
  assert.ok(cardNames.length >= 10, `nur ${cardNames.length} Modulkarten gefunden - Schluesselmuster veraltet?`);

  // Kleinschreibung, weil die Flaechen sich bewusst in der Grossschreibung
  // unterscheiden duerfen ("API tokens" vs. "API Tokens") - der NAME ist die
  // Zusage, nicht seine Typografie.
  const inReadme = new Set(moduleRows(readme('en')).map((r) => r.name.toLowerCase()));
  // Eine README-Zeile "A & B" darf auf der Homepage als zwei Eintraege A und B
  // stehen - aber nur beide zusammen. Seit 2026-09-29 (Critique, Runde 2)
  // stehen Notizen und Kontakte dort getrennt in ihren Menuegruppen der App
  // (Planen, Menschen), waehrend die README sie als EINE Zeile fuehrt.
  // test-docs-landing.js (3) haelt die Gegenrichtung (jede README-Zeile steht
  // auf der Seite) und die Modulzahl.
  const onPage = new Set(cardNames.map((n) => n.toLowerCase()));
  const halves = new Set([...inReadme]
    .map((n) => n.split(' & '))
    .filter((parts) => parts.length === 2 && parts.every((part) => onPage.has(part)))
    .flat());
  const missing = cardNames.filter((n) => !inReadme.has(n.toLowerCase()) && !halves.has(n.toLowerCase())).sort();

  assert.deepEqual(missing, [],
    'Die Homepage zeigt Module, die die README-Tabelle nicht kennt: ' + missing.join(', ')
    + '\nDie Tabelle in README.md ist die kanonische Modulliste (CLAUDE.md).');
});

// ── (3b) Die Gruppenzeilen ueber der Modultabelle ───────────────────────────

/**
 * Seit der Critique vom 2026-09-30 steht die Modultabelle in einem <details>,
 * und sichtbar bleiben fuenf Gruppenzeilen in der Reihenfolge des App-Menues
 * (`- **Plan** - Tasks · Calendar · …`). Die Homepage (#modules) zeigt dieselben
 * Gruppen, und `test-docs-landing.js` haelt sie gegen `public/router.js`. Hier:
 * README-Gruppen == Homepage-Gruppen (Name, Reihenfolge, Mitglieder), je
 * Sprache, und die Gruppenzeilen nennen genau die Module der Tabelle - eine
 * Zeile "A & B" darf als A und B in zwei Gruppen stehen (Notizen bei Planen,
 * Kontakte bei Menschen), aber nur beide zusammen.
 */
function readmeGroups(md) {
  const sec = md.split(/^## /m).find((s) => claimedModuleWord(`## ${s.split('\n')[0]}`)) || '';
  return [...sec.matchAll(/^- \*\*(.+?)\*\* - (.+)$/gm)]
    .map((m) => ({ label: m[1].trim(), names: m[2].split(' · ').map((n) => n.replace(/&amp;/g, '&').trim()) }));
}

function pageGroups(html, lang) {
  const block = dictBlock(html, lang);
  const from = html.indexOf('id="modGrid"');
  const grid = html.slice(from, html.indexOf('id="modToggle"', from)).replace(/<!--[\s\S]*?-->/g, ' ');
  return grid.split(/data-t="grp_/).slice(1).map((chunk) => ({
    label: stripTags(unescapeJs(dictValue(block, `grp_${chunk.slice(0, chunk.indexOf('"'))}`) || '')),
    names: [...chunk.matchAll(/class="(?:feat-row|mod-card)"[\s\S]*?data-t="(f_[a-z]+_k|m_[a-z]+_t)"/g)]
      .map((m) => stripTags(unescapeJs(dictValue(block, m[1]) || m[1]))),
  }));
}

/** Abweichungen zwischen Gruppenzeilen, Homepage-Gruppen und Modultabelle, als lesbare Zeilen. */
function groupFindings(md, html, lang) {
  const found = [];
  const readmeG = readmeGroups(md);
  const pageG = pageGroups(html, lang);
  if (pageG.length < 4) return [`Homepage (${lang}): nur ${pageG.length} Modulgruppen gefunden - Muster veraltet?`];
  if (readmeG.length !== pageG.length) found.push(`${readmeG.length} Gruppenzeilen, die Homepage zeigt ${pageG.length} Gruppen`);
  const low = (list) => list.map((n) => n.toLowerCase()).join(' · ');
  pageG.forEach((pg, i) => {
    const rg = readmeG[i];
    if (!rg) return;
    if (rg.label !== pg.label) found.push(`Gruppe ${i + 1}: README "${rg.label}", Homepage "${pg.label}"`);
    if (low(rg.names) !== low(pg.names)) found.push(`Gruppe "${pg.label}": README ${rg.names.join(' · ')} / Homepage ${pg.names.join(' · ')}`);
  });
  const inGroups = readmeG.flatMap((g) => g.names.map((n) => n.toLowerCase()));
  const used = new Set();
  for (const row of moduleRows(md)) {
    const name = row.name.toLowerCase();
    const parts = inGroups.includes(name) ? [name] : name.split(' & ');
    if (!parts.every((p) => inGroups.includes(p))) found.push(`Tabellenzeile "${row.name}" steht in keiner Gruppenzeile`);
    parts.forEach((p) => used.add(p));
  }
  for (const n of inGroups) if (!used.has(n)) found.push(`Gruppenzeile nennt "${n}", die Tabelle nicht`);
  if (inGroups.length !== new Set(inGroups).size) found.push('ein Modul steht in zwei Gruppenzeilen');
  return found;
}

for (const lang of Object.keys(READMES)) {
  test(`${READMES[lang]}: die Gruppenzeilen sind die Menuegruppen der Homepage und nennen jedes Modul der Tabelle`, () => {
    assert.deepEqual(groupFindings(readme(lang), read('docs/index.html'), lang), []);
  });
}

test('der Gruppen-Guard erkennt den Schaden, gegen den er gebaut ist', () => {
  const md = readme('en');
  const html = read('docs/index.html');
  const hit = (list, re) => list.some((l) => re.test(l));
  const swap = (from, to) => {
    assert.ok(md.includes(from), `Vorbedingung: "${from}" steht in README.md`);
    return groupFindings(md.replace(from, to), html, 'en');
  };
  // Kontakte zurueck zu den Notizen (der Anlass von Runde 2 auf der Homepage).
  const f1 = swap('Schedule · Notes\n', 'Schedule · Notes · Contacts\n');
  assert.ok(hit(f1, /Gruppe "Plan"/) && hit(f1, /zwei Gruppenzeilen/), f1.join(' | '));
  // Ein Modul fehlt in den Gruppenzeilen, steht aber in der Tabelle.
  assert.ok(hit(swap(' · Waste collection', ''), /Tabellenzeile "Waste collection" steht in keiner Gruppenzeile/));
  // Eine Gruppe umbenannt.
  assert.ok(hit(swap('- **People** - ', '- **Persons** - '), /Gruppe 3: README "Persons", Homepage "People"/));
  // Die Homepage bekommt ein Modul, das die Gruppenzeilen nicht kennen.
  const more = html.replace('<h4 data-t="m_backup_t">', '<h4 data-t="m_backup_t">x</h4></div><div class="mod-card"><h4 data-t="m_bday_t">');
  assert.notEqual(more, html, 'Vorbedingung: m_backup_t steht als <h4> im Markup');
  assert.ok(hit(groupFindings(md, more, 'en'), /Gruppe "Settings"/));
});

// ── (4) EN und DE bleiben strukturgleich ────────────────────────────────────

const shape = (md) => ({
  h2: (md.match(/^## /gm) || []).length,
  h3: (md.match(/^### /gm) || []).length,
  details: (md.match(/<details>/g) || []).length,
  codeBlocks: codeBlocks(md).length,
  moduleRows: moduleRows(md).length,
  swapRows: md.split('\n').filter((l) => /^\| (.+?) \| \*\*(.+?)\*\* - (.+?) \|$/.test(l)).length,
  tables: (md.match(/^\|[-: |]+\|$/gm) || []).length,
});

test('README.md und README.de.md haben dieselbe Struktur', () => {
  const en = shape(readme('en'));
  const de = shape(readme('de'));

  for (const key of Object.keys(en)) {
    assert.equal(de[key], en[key],
      `README.de.md hat ${de[key]}x "${key}", README.md hat ${en[key]}x. `
      + 'Die Uebersetzung folgt der englischen Fassung; ein Abschnitt fehlt oder ist doppelt.');
  }
});

// ── (5) Links, Anker, Dashes ────────────────────────────────────────────────

/**
 * GitHubs Ueberschriften-Slug: kleingeschrieben, Leerzeichen zu `-`, alles
 * Uebrige ausser Buchstaben, Ziffern, `-` und `_` faellt weg.
 *
 * `\p{L}` und nicht `\w`: GitHub behaelt Unicode-Buchstaben, `#überall-installieren`
 * ist ein gueltiger Anker. Ein naiver `\w`-Filter wirft das `ü` weg und meldet
 * einen intakten Anker als tot.
 */
const slug = (heading) => heading
  .toLowerCase()
  .replace(/[^\p{L}\p{N} _-]/gu, '')
  .trim()
  .replace(/\s+/g, '-');

for (const lang of Object.keys(READMES)) {
  test(`${READMES[lang]}: jeder relative Link zeigt auf eine existierende Datei`, () => {
    const md = readme(lang);
    const targets = new Set();
    for (const m of md.matchAll(/\]\(([^)#][^)]*)\)/g)) targets.add(m[1]);
    for (const m of md.matchAll(/href="([^"#][^"]*)"/g)) targets.add(m[1]);
    for (const m of md.matchAll(/(?:src|srcset)="([^"]+)"/g)) targets.add(m[1]);

    // Erst hier aussortiert und nicht im Muster oben: ein Ausschluss ueber das
    // ERSTE Zeichen trifft `https://…` nicht, weil dessen Doppelpunkt an vierter
    // Stelle steht. Die erste Fassung meldete deshalb funf intakte externe
    // Links als tot.
    const relative = [...targets].filter((t) => !/^([a-z][a-z0-9+.-]*:|\/\/)/i.test(t));
    assert.ok(relative.length >= 5, `nur ${relative.length} relative Links gefunden - Muster veraltet?`);

    const broken = relative
      .map((t) => t.split('#')[0])
      .filter((t) => t && !existsSync(resolve(ROOT, t)))
      .sort();
    assert.deepEqual(broken, [], 'Relative Links ohne Ziel: ' + broken.join(', '));
  });

  test(`${READMES[lang]}: jeder Anker trifft eine Ueberschrift`, () => {
    const md = readme(lang);
    const headings = new Set((md.match(/^#{1,6} .+$/gm) || []).map((h) => slug(h.replace(/^#+ /, ''))));

    const anchors = [...md.matchAll(/(?:\]\(|href=")#([^)"]+)/g)].map((m) => decodeURIComponent(m[1]));
    assert.ok(anchors.length >= 2, `nur ${anchors.length} Anker gefunden - Muster veraltet?`);

    const dead = anchors.filter((a) => !headings.has(a)).sort();
    assert.deepEqual(dead, [],
      'Anker ohne passende Ueberschrift: ' + dead.join(', ')
      + '\nVorhanden: ' + [...headings].join(', '));
  });

  test(`${READMES[lang]}: jeder Anker, den eine ANDERE Repo-Datei hierher setzt, trifft`, () => {
    // Die Gegenrichtung zum Test darueber, und die Luecke, durch die `#faq`
    // gefallen ist: der Abschnitt verschwand mit dem Landingpage-Umbau,
    // waehrend `SUPPORT.md` weiter "the README FAQ" versprach. Ein Guard, der
    // nur die eigenen Anker prueft, sieht eingehende Links nie - er war gruen,
    // und der Link ging trotzdem ins Leere (PR #788).
    const md = readme(lang);
    const headings = new Set((md.match(/^#{1,6} .+$/gm) || []).map((h) => slug(h.replace(/^#+ /, ''))));

    const target = READMES[lang];
    const dead = [];
    let scanned = 0;
    for (const file of readdirSync(ROOT).filter((f) => f.endsWith('.md') && f !== target)) {
      const src = readFileSync(resolve(ROOT, file), 'utf8');
      for (const m of src.matchAll(new RegExp(`${target.replace('.', '\\.')}#([\\w-]+)`, 'gu'))) {
        scanned++;
        if (!headings.has(decodeURIComponent(m[1]))) dead.push(`${file} -> #${m[1]}`);
      }
    }

    assert.deepEqual(dead, [],
      `Anker auf ${target}, die keine Ueberschrift treffen:\n  ${dead.join('\n  ')}`
      + `\nVorhanden: ${[...headings].join(', ')}`);
    // Kein Reichweiten-Nachweis ueber eine Mindestzahl: dass HEUTE nur eine
    // Datei hierher verlinkt, ist ein Zustand und keine Zusicherung. Was
    // zaehlt, ist dass jede gefundene Referenz geprueft wurde.
    assert.ok(scanned >= 0);
  });

  test(`${READMES[lang]}: jedes Bild hat einen Alt-Text`, () => {
    // GitHub packt jedes <img> ausserhalb eines <picture> in einen Link auf die
    // Bilddatei. Mit alt="" hat dieser Link keinen Namen (axe link-name) - so
    // stand das Logo bis 2026-09-30 zweimal in jeder README.
    const imgs = [...readme(lang).matchAll(/<img\b[^>]*>/g)].map((m) => m[0]);
    assert.ok(imgs.length >= 5, `nur ${imgs.length} Bilder gefunden - Muster veraltet?`);
    // Den Wert erst herausloesen und dann pruefen: ein `\S` im Muster selbst
    // passte auf das schliessende Anfuehrungszeichen von alt="" und liess das
    // leere Logo durch (Gegenprobe 2026-09-30).
    const nameless = imgs.filter((tag) => !(tag.match(/\balt="([^"]*)"/)?.[1] || '').trim());
    assert.deepEqual(nameless, [], 'Bilder ohne Alt-Text (GitHub verlinkt sie, der Link bliebe namenlos)');
  });

  test(`${READMES[lang]}: kein Em- oder En-Dash`, () => {
    const hits = readme(lang).split('\n')
      .map((line, i) => (/[–—]/.test(line) ? `${i + 1}: ${line.trim()}` : null))
      .filter(Boolean);
    assert.deepEqual(hits, [],
      'CLAUDE.md: immer "-", nie "—" oder "–".\n  ' + hits.join('\n  '));
  });
}

// ── (6) Saetze, die der Code halten muss (Critique 2026-09-30) ──────────────

/**
 * Die Critique vom 2026-09-30 fand in der README Saetze, die mehr versprachen
 * als der Code: "The week's meal plan writes the shopping list" (es ist ein
 * Import-Dialog, den jemand bestaetigt), "Turn on what your household needs"
 * (die Module sind an; drei starten aus, vier lassen sich gar nicht schalten),
 * "configures HTTPS" (der Installer setzt Proxy- und Cookie-Werte, ein
 * Zertifikat holt er nicht), eine LAN-Zeile, die drei von sechs Schaltern
 * nannte, und ein Web-Installer ohne den Hinweis, dass er nur auf 127.0.0.1
 * lauscht.
 *
 * Jede Zeile hier: was BEIDE READMEs sagen, und woran es im Code haengt. Faellt
 * eins von beidem, wird der Test rot - der Satz ist umformuliert (dann die
 * Zeile hier nachziehen) oder der Code haelt ihn nicht mehr.
 */
const README_FACTS = [
  { says: { en: /One import turns the week's meal plan into a shopping list/, de: /Ein Import macht aus dem Wochenplan eine Einkaufsliste/ },
    holds: (s) => /\/import-meal-plan`/.test(s.shoppingPage) && /addLocalDays\(today, 6\)/.test(s.shoppingPage) && /mi\.category/.test(s.shoppingRoutes),
    what: 'Import-Dialog mit vorausgewaehlten sieben Tagen, Kategorie der Zutat (public/pages/shopping.js, server/routes/shopping.js import-meal-plan)' },
  { says: { en: /one button books what you ticked off back into the pantry, with amount and unit/, de: /bucht ein Knopf, was ihr abgehakt habt, mit Menge und Einheit zur[uü]ck in den Vorrat/ },
    holds: (s) => /async function openPantryTransfer/.test(s.shoppingPage) && /pantry-transfer__qty/.test(s.shoppingPage) && /pantry-transfer__unit/.test(s.shoppingPage),
    what: 'Uebernahme-Dialog Einkauf -> Vorrat mit Menge und Einheit (public/pages/shopping.js openPantryTransfer)' },
  { says: { en: /Inventory,\s+Waste collection and Schedule start switched off/, de: /Inventar,\s+Entsorgung und Schichtplan sind anfangs aus/ },
    holds: (s) => ['inventory', 'waste', 'schedule'].every((m) => new RegExp(`disabled\\.push\\('${m}'\\)`).test(s.db) && s.toggleable.includes(m)),
    what: 'Migrationen in server/db.js schalten die drei ab, TOGGLEABLE_MODULES (server/routes/preferences.js) kennt sie' },
  { says: { en: /amd64 and arm64 \(Raspberry Pi 4\/5\)/, de: /amd64 und arm64 \(Raspberry Pi 4\/5\)/ },
    holds: (s) => /platforms:\s*linux\/amd64,\s*linux\/arm64/.test(s.dockerPublish),
    what: 'Multi-Arch-Build (.github/workflows/docker-publish.yml platforms)' },
  { says: { en: /With a placeholder left in, Yuvomi refuses to start/, de: /Bleibt ein Platzhalter stehen, startet Yuvomi nicht/ },
    holds: (s) => /SESSION_SECRET\.startsWith\('REPLACE_WITH_'\)\) \{\s*throw/.test(s.auth) && /if \(!existsSync\(DB_PATH\)\) \{\s*throw/.test(s.db),
    what: 'Startabbruch bei Platzhaltern (server/auth.js SESSION_SECRET, server/db.js assertKeyIsNotPlaceholder)' },
  { says: { en: /ssh -L 8090:localhost:8090/, de: /ssh -L 8090:localhost:8090/ },
    holds: (s) => /server\.listen\(PORT, '127\.0\.0\.1'/.test(s.installer),
    what: 'Web-Installer lauscht nur auf 127.0.0.1 (tools/installer/install-server.js) - faellt das, ist der Tunnel-Hinweis ueberfluessig' },
  { says: { en: /optional WebDAV upload/, de: /optionalem WebDAV-Upload/ },
    holds: (s) => s.backupWebdav && /WEBDAV_BACKUP_URL/.test(s.envExample),
    what: 'WebDAV-Backupziel (server/services/backup-webdav.js, .env.example WEBDAV_BACKUP_*)' },
  { says: { en: /a backup from another installation restores right in the browser/, de: /Backup einer anderen Installation spielt ihr direkt im Browser zur[uü]ck/ },
    holds: (s) => /backupKeyFromHeader\(req\)/.test(s.backupRoute) && /restoreFromFile\(uploadPath, \{ backupKey \}\)/.test(s.backupRoute),
    what: 'Wiederherstellen mit dem Schluessel der anderen Installation (server/routes/backup.js, seit 2.69.0)' },
  { says: { en: /medications, warranties, best-before dates, expiring documents/, de: /Medikamente, Garantien, Mindesthaltbarkeit, ablaufende Dokumente/ },
    holds: (s) => s.medicationScheduler && /document_expiry:/.test(s.reminderOrigins),
    what: 'Medikamenten-Erinnerungen (server/services/medication-scheduler.js) und Dokumentablauf (reminder-origins.js)' },
  // Die Familien-Sektion (RD2 derselben Critique), aus docs/index.html fam_1..3 abgeleitet:
  // dieselben Stellen im Code, an denen test-docs-landing.js (10) die Homepage haelt.
  { says: { en: /pick who did it, and the points go to them/, de: /ausw[aä]hlen, wer sie erledigt hat, und die Punkte gehen an diese Person/ },
    holds: (s) => s.display.includes("method: 'PATCH', pattern: /^\\/tasks\\/\\d+\\/status$/") && /if \(doneByUserId\) return enrolled\.has\(doneByUserId\)/.test(s.rewards),
    what: 'das Wand-Tablet hakt fuer eine gewaehlte Person ab (server/display-scopes.js PATCH /tasks/:id/status, server/services/rewards.js)' },
  { says: { en: /the last shopping list you opened stays readable without signal/, de: /die zuletzt ge[oö]ffnete Einkaufsliste bleibt lesbar/ },
    holds: (s) => /API_CACHE_WHITELIST = \[[^\]]*'\/shopping'/.test(s.sw),
    what: "Offline-Cache der Einkaufsliste (public/sw.js API_CACHE_WHITELIST '/shopping')" },
  { says: { en: /each module is full, read only or not at all/, de: /jedes Modul voll, nur lesen oder gar nicht/ },
    holds: (s) => /MODULE_ACCESS_LEVELS = Object\.freeze\(\['none', 'read', 'write'\]\)/.test(s.permissions),
    what: 'drei Zugriffsstufen je Modul (server/permissions.js MODULE_ACCESS_LEVELS)' },
  { says: { en: /a child without a phone gets an account created directly/, de: /ein Kind ohne Handy bekommt sein Konto direkt angelegt/ },
    holds: (s) => /FAMILY_ROLES = Object\.freeze\(\[[^\]]*'child'/.test(s.permissions),
    what: "Kind als Familienrolle (server/permissions.js FAMILY_ROLES 'child')" },
  // "Wie sicher ist der Zugang von aussen?" (Before you commit), wie long_a4 der Homepage.
  { says: { en: /an admin can require it for the whole household/, de: /ein Admin kann ihn f[uü]r den ganzen Haushalt verlangen/ },
    holds: (s) => /export function setRequiredForHousehold/.test(s.twoFactor) && /user_recovery_codes/.test(s.twoFactor),
    what: 'haushaltsweite 2FA-Pflicht und Wiederherstellungscodes (server/services/two-factor.js)' },
  { says: { en: /join through an invite link and pick their own password/, de: /kommen per Einladungslink und w[aä]hlen ihr Passwort selbst/ },
    holds: (s) => /\.post\('\/invites\/accept'/.test(s.auth),
    what: 'Einladung annehmen mit eigenem Passwort (server/auth.js POST /invites/accept)' },
  { says: { en: /password login can be switched off for the household/, de: /l[aä]sst sich die Passwort-Anmeldung f[uü]r den Haushalt abschalten/ },
    holds: (s) => /export function isPasswordLoginEnabled/.test(s.auth) && /AUTH_ALLOW_PASSWORD_LOGIN=false/.test(s.envExample),
    what: 'SSO als einziger Weg (server/auth.js isPasswordLoginEnabled, .env.example AUTH_ALLOW_PASSWORD_LOGIN)' },
  { says: { en: /signed out from any of your other devices/, de: /von jedem eurer anderen Ger[aä]te aus ab/ },
    holds: (s) => /router\.post\('\/logout-others'/.test(s.auth),
    what: 'andere Sitzungen beenden (server/auth.js POST /logout-others)' },
];

/** Saetze, die nicht zurueckkommen duerfen - in beiden READMEs. */
const README_NEVER = [
  /writes the shopping list/i, /schreibt die Einkaufsliste/,
  /the reward catalog spends them/i, /Belohnungskatalog gibt sie aus/,
  /Turn on what your household needs/i, /Schalte an, was dein Haushalt braucht/,
  /optional cloud upload/i, /Cloud-Upload/,
  // Der Import aus dem Essensplan ist ein Dialog (Zeitraum vorbelegt, bestaetigen), kein Tipp.
  /one-tap import from the meal plan/i, /Ein-Tipp-Import aus dem Essensplan/,
];

/**
 * Der Installer holt kein Zertifikat. Dieselbe Uebertreibung stand in der
 * README ("configures HTTPS") und auf der Homepage (`quick_note`: "handles
 * HTTPS", "kuemmert sich um HTTPS") - deshalb gegen alle drei Flaechen und die
 * Installationsseite, Markup und Woerterbuch in einem Zug.
 */
const INSTALLER_HTTPS_NEVER = [/configures HTTPS/i, /handles HTTPS/i, /richtet HTTPS,/, /k[uü]mmert sich um HTTPS/];

/**
 * Jeder Schalter `*_ALLOW_PRIVATE_NETWORK` aus .env.example und der Begriff,
 * unter dem ihn die LAN-Zeile nennt. Ein neuer Schalter, der hier fehlt, macht
 * den Test rot - die LAN-Zeile nannte bis 2026-09-30 drei von sechs.
 */
const LAN_BLOCKED = {
  ICS_SUBSCRIPTION_ALLOW_PRIVATE_NETWORK: { en: /calendar subscriptions/, de: /Kalender-Abos/ },
  NOTIFICATION_ALLOW_PRIVATE_NETWORK: { en: /notification channels/, de: /Benachrichtigungskan[aä]le/ },
  DOCUMENT_STORAGE_WEBDAV_ALLOW_PRIVATE_NETWORK: { en: /WebDAV document storage/, de: /WebDAV-Dokumentenspeicher/ },
  RECIPE_PROVIDER_ALLOW_PRIVATE_NETWORK: { en: /recipe mirrors/, de: /Rezept-Spiegel/ },
  WASTE_SOURCE_ALLOW_PRIVATE_NETWORK: { en: /waste-collection feeds/, de: /Abfuhr-Feeds/ },
};
/** Die Gegenrichtung: Schalter, die ab Werk OFFEN stehen (Default true). */
const LAN_OPEN = {
  DMS_ALLOW_PRIVATE_NETWORK: { en: /Paperless and Papra are the exception/, de: /Paperless und Papra sind die Ausnahme/ },
};

function factSources() {
  const src = (p) => read(p);
  const prefs = src('server/routes/preferences.js');
  const toggleable = (prefs.match(/TOGGLEABLE_MODULES = \[([\s\S]*?)\]/) || [, ''])[1];
  return {
    readmes: { en: readme('en'), de: readme('de') },
    shoppingPage: src('public/pages/shopping.js'),
    shoppingRoutes: src('server/routes/shopping.js'),
    db: src('server/db.js'),
    toggleable: [...toggleable.matchAll(/'([a-z-]+)'/g)].map((m) => m[1]),
    dockerPublish: src('.github/workflows/docker-publish.yml'),
    auth: src('server/auth.js'),
    installer: src('tools/installer/install-server.js'),
    envExample: src('.env.example'),
    backupWebdav: existsSync(resolve(ROOT, 'server/services/backup-webdav.js')),
    backupRoute: src('server/routes/backup.js'),
    medicationScheduler: existsSync(resolve(ROOT, 'server/services/medication-scheduler.js')),
    reminderOrigins: src('server/services/reminder-origins.js'),
    display: src('server/display-scopes.js'),
    rewards: src('server/services/rewards.js'),
    sw: src('public/sw.js'),
    permissions: src('server/permissions.js'),
    twoFactor: src('server/services/two-factor.js'),
    pages: { 'docs/index.html': src('docs/index.html'), 'docs/install.html': src('docs/install.html') },
  };
}

/** Alles, was an (6) nicht stimmt, als lesbare Zeilen. */
function factFindings(s) {
  const found = [];
  for (const lang of Object.keys(READMES)) {
    const file = READMES[lang];
    // Umbrueche und Blockquote-Marken weg: die Saetze stehen umbrochen, teils als `>`-Zitat.
    const md = s.readmes[lang].replace(/\n>?\s*/g, ' ');
    for (const f of README_FACTS) {
      if (!f.says[lang].test(md)) found.push(`${file} sagt nicht mehr ${f.says[lang]} - README_FACTS nachziehen`);
      else if (!f.holds(s)) found.push(`${file}: haengt an ${f.what}, und das haelt nicht mehr`);
    }
    for (const re of README_NEVER) if (re.test(md)) found.push(`${file} sagt wieder ${re}`);
    for (const re of INSTALLER_HTTPS_NEVER) if (re.test(md)) found.push(`${file} sagt wieder ${re} (der Installer holt kein Zertifikat)`);

    const lan = s.readmes[lang].match(/^- \*\*(?:Your|Dein|Euer) LAN\*\* - (.+)$/m);
    if (!lan) { found.push(`${file}: LAN-Zeile nicht gefunden - Muster veraltet?`); continue; }
    const flags = [...s.envExample.matchAll(/^#?\s*([A-Z_]+_ALLOW_PRIVATE_NETWORK)=(true|false)\b/gm)];
    if (flags.length < 5) found.push(`.env.example: nur ${flags.length} *_ALLOW_PRIVATE_NETWORK-Schalter gefunden - Muster veraltet?`);
    for (const [, flag, dflt] of flags) {
      const map = dflt === 'false' ? LAN_BLOCKED : LAN_OPEN;
      if (!map[flag]) found.push(`${flag}=${dflt} steht in .env.example, aber nicht in ${dflt === 'false' ? 'LAN_BLOCKED' : 'LAN_OPEN'} - die LAN-Zeile nennt ihn nicht`);
      else if (!map[flag][lang].test(lan[1])) found.push(`${file}: die LAN-Zeile nennt ${flag} nicht (${map[flag][lang]})`);
    }
  }
  for (const [page, html] of Object.entries(s.pages)) {
    for (const re of INSTALLER_HTTPS_NEVER) if (re.test(html)) found.push(`${page} sagt wieder ${re} (der Installer holt kein Zertifikat)`);
  }
  return found;
}

test('README.md + README.de.md: die Saetze aus der Critique vom 2026-09-30 sagen nur, was der Code haelt', () => {
  assert.deepEqual(factFindings(factSources()), []);
});

test('der Guard aus (6) erkennt den Schaden, gegen den er gebaut ist', () => {
  const real = factSources();
  const hit = (list, re) => list.some((l) => re.test(l));
  const withReadme = (lang, from, to) => {
    assert.ok(real.readmes[lang].includes(from), `Vorbedingung: "${from}" steht in ${READMES[lang]}`);
    return { ...real, readmes: { ...real.readmes, [lang]: real.readmes[lang].replace(from, to) } };
  };

  // Die alten Saetze kommen zurueck.
  const f1 = factFindings(withReadme('en', "One import turns the week's meal plan into a shopping list", "The week's meal plan writes the shopping list"));
  assert.ok(hit(f1, /README\.md sagt nicht mehr/) && hit(f1, /README\.md sagt wieder \/writes the shopping list/), f1.join(' | '));
  const f2 = factFindings(withReadme('de', 'richtet Single', 'richtet HTTPS, Single'));
  assert.ok(hit(f2, /README\.de\.md sagt wieder \/richtet HTTPS,/), f2.join(' | '));
  const oldPage = real.pages['docs/index.html'].replace('sets up SSO and backups and prepares Yuvomi for your HTTPS reverse proxy', 'handles HTTPS, SSO and backups for you');
  assert.notEqual(oldPage, real.pages['docs/index.html'], 'Vorbedingung: quick_note steht so auf der Homepage');
  assert.ok(hit(factFindings({ ...real, pages: { ...real.pages, 'docs/index.html': oldPage } }), /docs\/index\.html sagt wieder \/handles HTTPS/));

  // Die LAN-Zeile verliert einen Schalter, und .env.example bekommt einen neuen.
  const f3 = factFindings(withReadme('en', 'notification channels (webhook, Gotify, ntfy), ', ''));
  assert.ok(hit(f3, /README\.md: die LAN-Zeile nennt NOTIFICATION_ALLOW_PRIVATE_NETWORK nicht/), f3.join(' | '));
  const f4 = factFindings({ ...real, envExample: real.envExample + '\n# IMMICH_ALLOW_PRIVATE_NETWORK=false\n' });
  assert.ok(hit(f4, /IMMICH_ALLOW_PRIVATE_NETWORK=false steht in \.env\.example, aber nicht in LAN_BLOCKED/), f4.join(' | '));

  // Der Code verliert, woran die Zusage haengt.
  const f5 = factFindings({ ...real, installer: real.installer.replace("server.listen(PORT, '127.0.0.1'", "server.listen(PORT, '0.0.0.0'") });
  assert.ok(hit(f5, /haengt an Web-Installer lauscht nur auf 127\.0\.0\.1/), f5.join(' | '));
  const f6 = factFindings({ ...real, db: real.db.replace("disabled.push('waste')", "void 0") });
  assert.ok(hit(f6, /haengt an Migrationen in server\/db\.js/), f6.join(' | '));
  const f7 = factFindings({ ...real, dockerPublish: real.dockerPublish.replace('linux/amd64,linux/arm64', 'linux/amd64') });
  assert.ok(hit(f7, /haengt an Multi-Arch-Build/), f7.join(' | '));
  const f8 = factFindings({ ...real, display: real.display.replace(/method: 'PATCH'/, "method: 'GET'") });
  assert.ok(hit(f8, /haengt an das Wand-Tablet hakt/), f8.join(' | '));
  const f9 = factFindings({ ...real, auth: real.auth.replace("router.post('/logout-others'", "router.post('/logout-all'") });
  assert.ok(hit(f9, /README\.de\.md: haengt an andere Sitzungen beenden/), f9.join(' | '));
  const f10 = factFindings(withReadme('en', 'with swipe gestures and an import from the meal plan', 'with swipe gestures and one-tap import from the meal plan'));
  assert.ok(hit(f10, /README\.md sagt wieder \/one-tap import/), f10.join(' | '));
});
