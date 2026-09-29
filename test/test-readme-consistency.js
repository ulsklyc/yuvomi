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
import { dictBlock, dictKeysMatching, dictValue, stripTags } from './docs-dict.js';

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
  return codeBlocks(md).filter((b) => /docker compose up -d/.test(b) && /cp .env.example .env/.test(b));
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

  test(`${READMES[lang]}: kein Em- oder En-Dash`, () => {
    const hits = readme(lang).split('\n')
      .map((line, i) => (/[–—]/.test(line) ? `${i + 1}: ${line.trim()}` : null))
      .filter(Boolean);
    assert.deepEqual(hits, [],
      'CLAUDE.md: immer "-", nie "—" oder "–".\n  ' + hits.join('\n  '));
  });
}
