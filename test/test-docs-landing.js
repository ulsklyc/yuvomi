/**
 * Modul: Doku-Seiten (GitHub Pages) - Struktur- und Drift-Guard
 * Zweck: Die fünf Seiten unter `docs/` sind eigenständige Dateien ohne Build-Schritt
 *        und ohne Framework. Was sie behaupten, steht handgepflegt an mehreren
 *        Stellen gleichzeitig - und genau daran ist es wiederholt auseinander
 *        gelaufen. Diese Suite hält die fünf Kopplungen, die schon gerissen sind:
 *
 *        (1) Kein Quelltextkommentar rendert als sichtbarer Text.
 *            Der Sektionsumbau vom 2026-08-16 hat einen Kommentar in zwei
 *            Hälften geschnitten. Die Schlusszeile stand danach als Textknoten
 *            bei 32 % Scrolltiefe auf der Seite, der Kopf blieb unterminiert
 *            zurück und verschluckte die nächste Kommentar-Marke. Weder
 *            Kontrast- noch Überlauf- noch Konsolenprüfung sieht so etwas, und
 *            Sektions-Screenshots erst recht nicht: der Rest stand ZWISCHEN
 *            zwei Sektionen.
 *
 *        (2) Die Substitutionstabelle stimmt wörtlich mit der README überein.
 *            Die zehn Zeilen in `docs/index.html` sind aus der README-Tabelle
 *            übernommen. Nichts hielt sie zusammen.
 *
 *        (3) Die Modulzahl der Proof-Leiste ist die Summe dessen, was die Seite
 *            zeigt, und die Zeilenzahl der README-Modultabelle. "Die übrigen
 *            dreizehn" stand über vierzehn Karten, weil das achtzehnte Modul
 *            dazukam und die Zahl im Absatz darüber nicht. Seit 2026-09-29
 *            steht ein ausgeschriebenes Zahlwort nur noch dort, wo die Suite es
 *            nachzählt; dazu OpenAPI-Version gegen `server/openapi.js` und die
 *            Outbound-Liste gegen die README.
 *
 *        (4) Jede referenzierte Aufnahme hat ihre zwei WebP-Ableitungen, in
 *            BEIDEN Sprachordnern. `onerror` greift nur bei FEHLENDEN Dateien,
 *            nicht bei veralteten - eine fehlende Ableitung fällt still auf das
 *            5-10x größere PNG zurück.
 *
 *        (5) Die Wörterbücher sind vollständig und deckungsgleich. Ein `data-t`
 *            ohne Eintrag rendert stumm den englischen Fallback, auch auf der
 *            deutschen Seite.
 *
 *        (6) Jede Sektion schliesst genau die `div`s, die sie oeffnet.
 *            Ein einziges ueberzaehliges `</div>` in `.showcase` schloss dort
 *            `.wrap` statt `.feat-grid`; alles danach - Modulraster, Vorspann,
 *            Telefonreihe, Abgrenzungsabsatz - fiel aus dem 1152px-Container.
 *            `.mod-grid` mass danach `left:0 width:1440 padding:0`, mobil
 *            klebten die Karten bei `left:0/right:390` an beiden Bildschirm-
 *            raendern. Vier Prueflaeufe haben es nicht gesehen, weil alle nach
 *            UEBERLAUF fragten: volle Viewport-Breite laeuft nicht ueber,
 *            `scrollWidth > clientWidth` bleibt still. Der Browser repariert
 *            solches Markup klaglos, deshalb ist auch die Konsole leer. Was
 *            fehlte, war die Frage nach der BILANZ.
 *
 *        (7) Ein Telefonrahmen hat die Proportion eines Telefons.
 *            Vier Stellen zeichnen denselben Handyrahmen (26px Ecke, 4px Steg),
 *            zwei davon standen auf erfundenen Zuschnitten: `.feat-phone` auf
 *            1320/1780 und `.mod-shot img` auf 1320/1900, waehrend `.hero-float
 *            img` und der schmale Galerierahmen daneben das echte Mass 1320/2867
 *            fuehrten. Dasselbe Objekt sprach auf einer Seite zwei Sprachen, und
 *            die beiden falschen Kaesten machten aus dem Telefon ein gedrungenes
 *            Tablet - 200x270 statt 200x434. Kein Kontrast-, Ueberlauf- oder
 *            Bilanz-Guard sieht das: die Aufnahme darin ist unverzerrt, nur
 *            unten abgeschnitten. Der Guard fragt deshalb nach der QUELLE des
 *            Verhaeltnisses (ein Name, `--ar-phone`) und danach, ob dieser Name
 *            noch das misst, was die Aufnahmen wirklich sind.
 *
 *        (8) Die Installationsseite sagt, was die Dateien tun, die sie
 *            beschreibt. Port-Variable und Datenordner aus docker-compose.yml,
 *            der Platzhalter aus server/auth.js und .env.example, jede
 *            heruntergeladene Datei im Repository, jeder Anker in die
 *            installation.md, jeder seiteninterne Link auf einen Tab-Slug statt
 *            auf den Tab-Knopf. Anlass: `down -v` bei Host-Ordnern,
 *            `3000:3000` statt OIKOS_HTTP_PORT, `#tab-docker` (2026-09-29).
 *
 * Ausführen: node --test test/test-docs-landing.js   (bzw. npm run test:docs-landing)
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { dictBlock, dictValue, decodeEntities, stripTags, unescapeJs } from './docs-dict.js';
import { eachRule } from './css-rules.js';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const DOCS = resolve(ROOT, 'docs');
const SHOTS = resolve(DOCS, 'screenshots');
const PAGES = ['index.html', 'install.html', 'datenschutz.html', 'impressum.html', 'privacy.html'];

const read = (p) => readFileSync(resolve(DOCS, p), 'utf8');
/**
 * Entities aufloesen und Woerterbuch-Bloecke schneiden - beides aus
 * `docs-dict.js`, weil `test-readme-consistency.js` dieselben Bloecke liest.
 * Zwei Kopien desselben Extraktors haben in diesem Repo schon zweimal zwei
 * verschiedene Blindstellen behalten (siehe den Kopf von `css-rules.js`).
 */
const decode = decodeEntities;

// ── (1) Kein Kommentar rendert als Text ──────────────────────────────────────

/**
 * Kommentare entfernen und schauen, was an Kommentar-Syntax übrig bleibt.
 *
 * Bewusst so herum und nicht als Zählung von `<!--` gegen `-->`: die war beim
 * echten Schaden AUSGEGLICHEN. Der abgetrennte Rest hatte ein `-->` und der
 * unterminierte Kopf ein `<!--`, die Bilanz stimmte also, während beide Hälften
 * kaputt waren. Ein Guard, der Paare zählt, wäre hier grün gewesen.
 *
 * `--!>` schliesst einen Kommentar genauso wie `-->` (HTML-Parser, "comment end
 * bang state"). Ohne diese Variante haette der Guard einen so geschlossenen
 * Kommentar fuer unterminiert gehalten und Fehlalarm geschlagen.
 * (CodeQL js/bad-tag-filter, PR #782.)
 */
const COMMENT_END = /--!?>/g;
const COMMENT = /<!--[\s\S]*?--!?>/g;

/**
 * In einem Durchgang zu entfernen reicht nicht: `<!<!-- x -->-- y -->` setzt
 * beim Herausschneiden des inneren Kommentars ein neues `<!--` zusammen, das der
 * erste Lauf nie gesehen hat. Es wird deshalb wiederholt, bis sich nichts mehr
 * aendert. (CodeQL js/incomplete-multi-character-sanitization, PR #782.)
 */
function stripComments(html) {
  let prev;
  let out = html;
  do { prev = out; out = out.replace(COMMENT, ''); } while (out !== prev);
  return out;
}

function commentDamage(html) {
  const stripped = stripComments(html);
  const strayClose = [...stripped.matchAll(COMMENT_END)].map((m) => ({
    line: stripped.slice(0, m.index).split('\n').length,
    context: stripped.slice(Math.max(0, m.index - 60), m.index + 3).replace(/\s+/g, ' ').trim(),
  }));
  const unterminated = (stripped.match(/<!--/g) || []).length;
  return { strayClose, unterminated };
}

for (const page of PAGES) {
  test(`${page}: kein Kommentarrest steht als sichtbarer Text im Dokument`, () => {
    const { strayClose, unterminated } = commentDamage(read(page));
    assert.equal(
      strayClose.length, 0,
      `Kommentar-Ende ausserhalb eines Kommentars (rendert als Text):\n` +
      strayClose.map((s) => `  Zeile ~${s.line}: …${s.context}`).join('\n')
    );
    assert.equal(unterminated, 0, 'nicht geschlossener <!-- Kommentar: verschluckt allen Text bis zum nächsten -->');
  });
}

test('der Kommentar-Guard erkennt den Schaden, gegen den er gebaut ist', () => {
  // Gegenprobe gegen den ECHTEN alten Stand: ein Kommentar, dessen Schlusszeile
  // abgetrennt wurde, plus der unterminierte Kopf. Die Paar-Bilanz ist hier
  // ausgeglichen (je ein <!-- und ein -->), der Schaden trotzdem da.
  const broken = [
    '</section>',
    '     with modules the reader has just been introduced to. -->',
    '<section class="handoff">',
    '</section>',
    '<!-- HANDOFFS - the payoff for the feature list above. Each row is one piece',
    '     of data crossing from the module that produces it to the module that',
    '<section class="longevity">',
  ].join('\n');

  assert.equal((broken.match(/<!--/g) || []).length, (broken.match(/--!?>/g) || []).length,
    'Vorbedingung: die Paar-Bilanz ist ausgeglichen, ein zaehlender Guard waere hier gruen');

  const { strayClose, unterminated } = commentDamage(broken);
  assert.equal(strayClose.length, 1, 'der abgetrennte Rest muss gefunden werden');
  assert.match(strayClose[0].context, /introduced to\. -->/);
  assert.equal(unterminated, 1, 'der unterminierte Kopf muss gefunden werden');
});

// ── (2) Substitutionstabelle == README ───────────────────────────────────────

/** Die zehn Zeilen aus der README-Tabelle "Instead of juggling… | Yuvomi gives you". */
function readmeSwapRows() {
  const readme = readFileSync(resolve(ROOT, 'README.md'), 'utf8');
  return readme.split('\n')
    .map((l) => l.match(/^\| (.+?) \| \*\*(.+?)\*\* - (.+?) \|$/))
    .filter(Boolean)
    .map((m) => [decode(m[1]).trim(), decode(m[2]).trim(), decode(m[3]).trim()]);
}

/** Dieselben Zeilen aus dem englischen Wörterbuch von index.html. */
function pageSwapRows(html) {
  const en = dictBlock(html, 'en');
  const rows = [];
  for (let i = 1; ; i++) {
    const a = en.match(new RegExp(`\\bswap_${i}_a:'((?:[^'\\\\]|\\\\.)*)'`));
    const b = en.match(new RegExp(`\\bswap_${i}_b:'<b>(.*?)</b> - ((?:[^'\\\\]|\\\\.)*)'`));
    if (!a || !b) break;
    rows.push([decode(a[1]).trim(), decode(b[1]).trim(), decode(b[2]).trim()]);
  }
  return rows;
}

test('die Substitutionszeilen stimmen woertlich mit der README-Tabelle ueberein', () => {
  const readme = readmeSwapRows();
  const page = pageSwapRows(read('index.html'));

  assert.ok(readme.length >= 5, `README-Tabelle nicht gefunden oder zu kurz (${readme.length} Zeilen)`);
  assert.equal(page.length, readme.length,
    `Die Seite zeigt ${page.length} Zeilen, die README hat ${readme.length}. ` +
    'Beide sind handgepflegt - wer eine aendert, aendert die andere mit.');

  for (let i = 0; i < readme.length; i++) {
    assert.deepEqual(page[i], readme[i],
      `Zeile ${i + 1} weicht ab.\n  README: ${JSON.stringify(readme[i])}\n  Seite : ${JSON.stringify(page[i])}`);
  }
});

// ── (3) Modulzahl == was die Seite zeigt ─────────────────────────────────────

test('die Modulzahl der Proof-Leiste ist die Summe aus Feature-Zeilen und Modulkarten', () => {
  const html = read('index.html');
  const claimed = Number(html.match(/<b>(\d+)<\/b>\s*<span data-t="proof_modules"/)?.[1]);
  const featureRows = (html.match(/class="feat-row/g) || []).length;
  const modCards = (html.match(/class="mod-card/g) || []).length;

  assert.ok(Number.isInteger(claimed), 'Modulzahl in der Proof-Leiste nicht gefunden');
  assert.equal(featureRows + modCards, claimed,
    `Die Proof-Leiste behauptet ${claimed} Module, die Seite zeigt ${featureRows} Feature-Zeilen ` +
    `plus ${modCards} Modulkarten = ${featureRows + modCards}.`);
});

/**
 * Die Modultabelle der README: `| **Name** | Ein Satz. |` unter einer
 * `## `-Ueberschrift, die von Modulen spricht, bis zur naechsten.
 *
 * Die README-Tabelle ist die kanonische Modulliste, und `test-readme-
 * consistency.js` haelt dort Ueberschrift, Kennzahl und Zeilen zusammen. Was
 * fehlte, war die Bruecke zur Homepage: beide Flaechen zaehlten fuer sich
 * richtig und haetten trotzdem verschiedene Zahlen nennen koennen.
 */
function readmeModuleCount() {
  // Abschnitt fuer Abschnitt zaehlen und den mit den meisten Zeilen nehmen:
  // "## The modules talk to each other" steht VOR der Tabelle und traegt das
  // Wort ebenfalls - die erste Fassung griff genau dort ins Leere.
  const sections = readFileSync(resolve(ROOT, 'README.md'), 'utf8').split(/^## /m).slice(1);
  const counts = sections
    .filter((sec) => /\bmodules\b/i.test(sec.split('\n')[0]))
    .map((sec) => sec.split('\n').filter((l) => /^\| \*\*(.+?)\*\* \| (.+?) \|$/.test(l)).length);
  assert.ok(counts.length > 0, 'README: keine Modul-Ueberschrift gefunden - Muster veraltet?');
  return Math.max(...counts);
}

test('die Modulzahl der Proof-Leiste ist die Zeilenzahl der README-Modultabelle', () => {
  const claimed = Number(read('index.html').match(/<b>(\d+)<\/b>\s*<span data-t="proof_modules"/)?.[1]);
  const rows = readmeModuleCount();
  assert.ok(rows >= 10, `README-Modultabelle nicht gefunden oder zu kurz (${rows} Zeilen)`);
  assert.equal(claimed, rows,
    `Die Proof-Leiste sagt ${claimed} Module, die README-Modultabelle hat ${rows} Zeilen.`);
});

/**
 * Ausgeschriebene Zahlwoerter stehen nur dort, wo sie gezaehlt werden.
 *
 * Frueher hielt dieser Guard EIN Zahlwort fest: "the other sixteen" ueber den
 * Modulkarten, gegen die Kartenzahl. Gehalten hat er den Absatz, aber nicht die
 * Nachbarn - "twenty separate apps" und "twenty separate tabs" standen daneben
 * ungeprueft, und "turn on what fits" galt fuer vier der sechzehn Karten gar
 * nicht (Familie, Erinnerungen, API, Backup sind nicht abschaltbar). Seit der
 * Critique vom 2026-09-29 nennt der Absatz keine Zahl mehr; die eine Modulzahl
 * steht in der Proof-Leiste und ist oben gegen Seite UND README gehalten.
 *
 * Die Regel ist deshalb jetzt allgemein: ein Zahlwort in einem Woerterbuchwert
 * ist nur erlaubt, wo diese Suite die Zahl nachzaehlt. Das sind die zehn
 * Zeilen der Substitutionstabelle ("Ten apps, one place."). Jede andere
 * Fundstelle ist eine Zahl, die niemand haelt, und faellt hier auf. Der
 * Markup-Fallback braucht keine eigene Pruefung: er ist ueber Kopplung (6)
 * an T.en gebunden.
 */
const NUMBER_WORDS = {
  ten: 10, eleven: 11, twelve: 12, thirteen: 13, fourteen: 14, fifteen: 15, sixteen: 16,
  seventeen: 17, eighteen: 18, nineteen: 19, twenty: 20,
  zehn: 10, zehnmal: 10, elf: 11, zwoelf: 12, zwölf: 12, dreizehn: 13, vierzehn: 14, fuenfzehn: 15,
  fünfzehn: 15, sechzehn: 16, siebzehn: 17, achtzehn: 18, neunzehn: 19, zwanzig: 20,
};

/** Alle Woerterbuchwerte eines Blocks als [Schluessel, Text], beide Quotierungen. */
function dictEntries(block) {
  return [...block.matchAll(/(?:^|[{,]\s*)\s*([a-z][a-z0-9_]*)\s*:\s*(['"])((?:(?!\2)[^\\]|\\.)*)\2/gm)]
    .map((m) => [m[1], stripTags(unescapeJs(m[3]))]);
}

/** Jede Zahlwort-Fundstelle eines Blocks, als { key, word, value }. */
function numberWordClaims(block) {
  const claims = [];
  for (const [key, text] of dictEntries(block)) {
    for (const [word, value] of Object.entries(NUMBER_WORDS)) {
      // \b kennt kein ü/ö: die Grenze deshalb ueber Unicode-Buchstaben selbst.
      if (new RegExp(`(?<!\\p{L})${word}(?!\\p{L})`, 'iu').test(text)) claims.push({ key, word, value });
    }
  }
  return claims;
}

/** Schluessel, deren Zahlwort gezaehlt wird, und die Zahl, die sie nennen muessen. */
function countedKeys(html) {
  const swapRows = pageSwapRows(html).length;
  return { swap_title: swapRows, swap_desc: swapRows };
}

function unheldNumbers(html, block) {
  const counted = countedKeys(html);
  return numberWordClaims(block)
    .filter(({ key, value }) => counted[key] !== value)
    .map(({ key, word }) => `${key}: "${word}"` + (key in counted ? ` (gezaehlt: ${counted[key]})` : ' (von nichts gehalten)'));
}

test('ein Zahlwort steht nur dort, wo die Suite es nachzaehlt', () => {
  const html = read('index.html');
  assert.equal(pageSwapRows(html).length, 10, 'Vorbedingung: die Substitutionstabelle hat zehn Zeilen');
  for (const lang of ['en', 'de']) {
    const block = dictBlock(html, lang);
    assert.ok(block, `${lang}-Woerterbuch nicht gefunden`);
    assert.ok(numberWordClaims(block).some((c) => c.key === 'swap_title'),
      `swap_title (${lang}) nennt kein Zahlwort mehr - Extraktor gebrochen oder Titel umgebaut?`);
    assert.deepEqual(unheldNumbers(html, block), [],
      `Zahlwoerter im ${lang}-Woerterbuch, die keiner Zaehlung entsprechen.`);
  }
});

test('der Zahlwort-Guard erkennt den Schaden, gegen den er gebaut ist', () => {
  const html = read('index.html');
  // Der Anlassfall ("dreizehn" ueber vierzehn Karten) und der Stand vor der
  // Critique vom 2026-09-29 - beide muessen anschlagen.
  const damaged = [
    "more_desc:'The other thirteen, each one independent.',",
    "ho_desc:'This is the part twenty separate apps cannot do.',",
    "swap_title:'Nine apps, <em>one place.</em>',",
  ].join('\n');
  assert.deepEqual(unheldNumbers(html, damaged).sort(), [
    'ho_desc: "twenty" (von nichts gehalten)',
    'more_desc: "thirteen" (von nichts gehalten)',
  ], 'freie Zahlwoerter muessen gemeldet werden');
  // Ein Zahlwort ausserhalb der Liste ("Nine") ist fuer den Guard unsichtbar -
  // das ist die Grenze: er haelt die Zahlen, die Modul- und App-Mengen nennen.
  assert.equal(numberWordClaims(damaged).filter((c) => c.key === 'swap_title').length, 0);
  // Der gezaehlte Schluessel mit falscher Zahl schlaegt an, mit richtiger nicht.
  assert.deepEqual(unheldNumbers(html, "swap_title:'Twelve apps, <em>one place.</em>',"),
    ['swap_title: "twelve" (gezaehlt: 10)']);
  assert.deepEqual(unheldNumbers(html, "swap_desc:'Zehn Apps, zehn Konten, zehnmal eure Daten.',"), []);
  // Umlaut-Grenze: "zwölf" und "fünfzehn" werden gefunden, "Elfenbein" nicht.
  assert.deepEqual(numberWordClaims("a:'zwölf Tabs', b:'Elfenbein', c:'fünfzehn'").map((c) => c.key).sort(), ['a', 'c']);
});

// ── (3c) OpenAPI-Version == was der Server ausliefert ────────────────────────

/**
 * "OpenAPI 3.0" stand auf der Homepage, in beiden READMEs und in SPEC.md, waehrend
 * `server/openapi.js` seit langem `openapi: '3.1.0'` ausliefert. Eine
 * Versionsnummer in einem Werbetext veraltet still - sie gehoert an den Code.
 */
function servedOpenApiVersion() {
  const src = readFileSync(resolve(ROOT, 'server/openapi.js'), 'utf8');
  const m = src.match(/\bopenapi:\s*'(\d+)\.(\d+)\.\d+'/);
  assert.ok(m, 'server/openapi.js: openapi-Version nicht gefunden - Muster veraltet?');
  return `${m[1]}.${m[2]}`;
}

function claimedOpenApiVersions(text) {
  return [...text.matchAll(/OpenAPI[\s-](\d+\.\d+)/g)].map((m) => m[1]);
}

test('jede genannte OpenAPI-Version ist die, die der Server ausliefert', () => {
  const served = servedOpenApiVersion();
  const sources = {
    'docs/index.html': read('index.html'),
    'README.md': readFileSync(resolve(ROOT, 'README.md'), 'utf8'),
    'README.de.md': readFileSync(resolve(ROOT, 'README.de.md'), 'utf8'),
    'docs/SPEC.md': read('SPEC.md'),
  };
  const claims = claimedOpenApiVersions(sources['docs/index.html']);
  assert.ok(claims.length >= 3, `nur ${claims.length} OpenAPI-Angaben in index.html - Muster veraltet?`);
  const wrong = Object.entries(sources).flatMap(([file, text]) =>
    claimedOpenApiVersions(text).filter((v) => v !== served).map((v) => `${file}: OpenAPI ${v}`));
  assert.deepEqual(wrong, [], `server/openapi.js liefert OpenAPI ${served}.`);
  // Gegenprobe: beide Schreibweisen des Altstands werden erkannt.
  assert.deepEqual(claimedOpenApiVersions('an OpenAPI 3.0 spec, eine OpenAPI-3.0-Spezifikation'), ['3.0', '3.0']);
});

// ── (3d) Die Outbound-Liste der Seite nennt, was die README nennt ─────────────

/**
 * Die README fuehrte die Dienste, die sich erst nach dem Einschalten verbinden,
 * vollstaendig; die Homepage nannte fuenf davon (Wetter, Feiertage, Kalender-
 * Sync, Push, Cloud-Backup) und liess Wechselkurse, Kontakte-Sync, Rezept-
 * Spiegel, Immich, Paperless/Papra und die Benachrichtigungskanaele weg - auf
 * der Seite, deren staerkstes Argument ist, dass nichts ungefragt nach aussen
 * geht. Die README ist hier die Quelle; die Seite muss jeden Eintrag nennen.
 */
const OUTBOUND = {
  en: { readme: 'README.md', bullet: /^- \*\*Outbound\*\* - (.+)$/m, list: /, and ((?:(?!, and ).)+?) connect once you switch them on/, base: 'one update check against the GitHub releases API' },
  de: { readme: 'README.de.md', bullet: /^- \*\*Nach außen\*\* - (.+)$/m, list: /, und ((?:(?!, und ).)+?) verbinden sich erst/, base: 'eine Update-Abfrage an die GitHub-Releases-API' },
};

function outboundItems(lang, md) {
  const spec = OUTBOUND[lang];
  const bullet = md.match(spec.bullet)?.[1];
  assert.ok(bullet, `${spec.readme}: Outbound-Zeile nicht gefunden - Muster veraltet?`);
  const list = bullet.match(spec.list)?.[1];
  assert.ok(list, `${spec.readme}: Liste der zuschaltbaren Verbindungen nicht gefunden`);
  return list.split(', ').map((s) => s.trim()).filter(Boolean);
}

function missingOutbound(items, siteText) {
  const norm = (s) => s.replace(/[’‘]/g, "'").toLowerCase();
  return items.filter((item) => !norm(siteText).includes(norm(item)));
}

for (const lang of ['en', 'de']) {
  test(`index.html (${lang}): die Outbound-Angabe nennt jede Verbindung der README`, () => {
    const items = outboundItems(lang, readFileSync(resolve(ROOT, OUTBOUND[lang].readme), 'utf8'));
    assert.ok(items.length >= 8, `nur ${items.length} Eintraege in der README-Liste - Muster veraltet?`);
    const raw = dictValue(dictBlock(read('index.html'), lang), 'tb_out_v');
    assert.ok(raw, `tb_out_v fehlt im ${lang}-Woerterbuch`);
    const site = stripTags(unescapeJs(raw));
    assert.ok(site.includes(OUTBOUND[lang].base), `tb_out_v (${lang}) nennt die Versionspruefung nicht mehr`);
    assert.deepEqual(missingOutbound(items, site), [],
      `tb_out_v (${lang}) verschweigt Verbindungen, die ${OUTBOUND[lang].readme} nennt.`);
  });
}

test('der Outbound-Guard erkennt den Schaden, gegen den er gebaut ist', () => {
  // Der Stand vor der Critique vom 2026-09-29, woertlich.
  const old = 'and weather, holidays, calendar sync, push and cloud backup connect once you switch them on.';
  const items = outboundItems('en', readFileSync(resolve(ROOT, 'README.md'), 'utf8'));
  const missing = missingOutbound(items, old);
  assert.ok(missing.includes('exchange rates') && missing.includes('Immich'),
    `der Altstand muss als unvollstaendig auffallen, gemeldet: ${missing.join(', ')}`);
});

// ── (4) WebP-Ableitungen je referenzierter Aufnahme ──────────────────────────

/** Sprachordner unter docs/screenshots/ - am Namen erkannt, nicht am Inhalt. */
function localeDirs() {
  return ['', ...readdirSync(SHOTS, { withFileTypes: true })
    .filter((e) => e.isDirectory() && /^[a-z]{2}(-[a-z]{2})?$/.test(e.name))
    .map((e) => e.name)];
}

test('jede referenzierte Aufnahme hat beide WebP-Ableitungen in allen Sprachordnern', () => {
  const bases = new Set();
  for (const page of PAGES) {
    for (const m of read(page).matchAll(/(?:src|data-light|data-dark|data-light-m|data-dark-m)="screenshots\/([^"]+\.png)"/g)) {
      bases.add(m[1]);
    }
  }
  assert.ok(bases.size > 0, 'keine referenzierten Screenshots gefunden - Regex veraltet?');

  const missing = [];
  for (const base of bases) {
    for (const dir of localeDirs()) {
      for (const suffix of ['.webp', '@1x.webp']) {
        const rel = (dir ? `${dir}/` : '') + base.replace(/\.png$/, suffix);
        if (!existsSync(resolve(SHOTS, rel))) missing.push(`screenshots/${rel}`);
      }
    }
  }
  assert.deepEqual(missing, [],
    'Fehlende WebP-Ableitungen. onerror faengt nur FEHLENDE Dateien ab, der Fallback landet also ' +
    'still auf dem 5-10x groesseren PNG:\n  ' + missing.join('\n  '));
});

// ── (5) Woerterbuecher vollstaendig und deckungsgleich ───────────────────────

/**
 * Schlüssel eines Blocks.
 *
 * Verlangt `key:'` oder `key:"` direkt hinter Zeilenanfang, Komma oder Klammer.
 * Ohne diese Verankerung liest das Muster Wörter INNERHALB von Werten als
 * Schlüssel (ein Satzteil wie "own: " in einem Fließtext) und meldet dann
 * Phantom-Einträge.
 */
function dictKeys(block) {
  return new Set([...block.matchAll(/(?:^|[{,]\s*)\s*([a-z][a-z0-9_]*)\s*:\s*['"]/gm)].map((m) => m[1]));
}

/** Alle über `data-t`/`data-alt-t`/`data-t-aria` verlangten Schlüssel im Markup. */
function usedKeys(html) {
  const body = html.split(/\n\s*(?:var |const )?(?:DICT|T)\s*=/)[0];
  const keys = new Set();
  for (const attr of ['data-t', 'data-alt-t', 'data-t-aria']) {
    for (const m of body.matchAll(new RegExp(`${attr}="([^"]+)"`, 'g'))) keys.add(m[1]);
  }
  return keys;
}

/* ---------------------------------------------------------------------------
 * (7) Die beiden Rechtsseiten sind ein Zwillingspaar.
 *
 * `privacy.html` ist die englische Fassung von `datenschutz.html` und als Kopie
 * entstanden. Eine Kopie erbt das CSS zuverlaessig und das MARKUP nicht: die
 * englische Seite kam mit den `.toc`-Klassen-losen Zwillingen ihrer eigenen
 * Regeln auf die Welt, wodurch der gesamte Inhaltsverzeichnis-Block in
 * `privacy.html:224-234` tot war - Kartenflaeche, Rahmen, Zweispalten-Raster und
 * `min-height: 44px` auf 13 Links, die daraufhin 18px hoch waren. Die
 * BEGRUENDUNG des Fixes war mitkopiert und stand als Kommentar ueber totem CSS.
 *
 * Geprueft wird auf der Ebene STRUKTUR, nicht Text: gleiche Klassenmenge im
 * Rumpf und gleiche Kopf-Folge. Beides ist sprachunabhaengig und faengt genau
 * die Kopier-Luecke, die der Anlass war - ein Textvergleich koennte das
 * grundsaetzlich nicht, weil die Seiten verschiedene Sprachen sprechen sollen.
 * ------------------------------------------------------------------------- */

const TWINS = ['datenschutz.html', 'privacy.html'];

/** Alle im Rumpf verwendeten CSS-Klassen (der Kopf traegt die Regeln, nicht die Nutzung). */
function markupClasses(html) {
  const body = html.split(/<\/head>/)[1] || html;
  return new Set([...body.matchAll(/class="([^"]+)"/g)].flatMap((m) => m[1].trim().split(/\s+/)));
}

/** Die Kopf-Folge in Dokumentreihenfolge, z.B. ['h1','h2','h2','h3']. */
function headingShape(html) {
  const body = html.split(/<\/head>/)[1] || html;
  return [...body.matchAll(/<(h[1-6])\b/g)].map((m) => m[1]);
}

test('die beiden Rechtsseiten benutzen dieselben Klassen', () => {
  const [de, en] = TWINS.map((p) => markupClasses(read(p)));
  assert.ok(de.size > 10, `nur ${de.size} Klassen gefunden - Regex veraltet?`);

  const onlyDe = [...de].filter((c) => !en.has(c)).sort();
  const onlyEn = [...en].filter((c) => !de.has(c)).sort();
  assert.deepEqual([onlyDe, onlyEn], [[], []],
    `Klassen nur auf einer der beiden Rechtsseiten - die Regeln der anderen laufen ins Leere.\n`
    + `  nur datenschutz.html: ${onlyDe.join(', ') || '-'}\n  nur privacy.html: ${onlyEn.join(', ') || '-'}`);
});

test('die beiden Rechtsseiten haben dieselbe Abschnittsstruktur', () => {
  const [de, en] = TWINS.map((p) => headingShape(read(p)));
  assert.ok(de.length > 5, `nur ${de.length} Ueberschriften gefunden - Regex veraltet?`);
  assert.deepEqual(en, de,
    `Kopf-Folge der Rechtsseiten unterschiedlich - eine Fassung fuehrt einen Abschnitt, den die andere nicht hat.\n`
    + `  datenschutz.html: ${de.join(' ')}\n  privacy.html    : ${en.join(' ')}`);
});

test('der Zwillings-Guard erkennt den Schaden, gegen den er gebaut ist', () => {
  // Der Anlassfall: dieselbe Struktur, aber die Klassen fehlen auf einer Seite.
  const withClasses = '</head><nav class="toc"><p class="toc-title">x</p><ol class="toc-list"></ol></nav>';
  const without = '</head><nav><h2>x</h2><ol></ol></nav>';
  const a = markupClasses(withClasses);
  const b = markupClasses(without);
  assert.notDeepEqual([...a].sort(), [...b].sort(),
    'der Klassen-Guard sieht die fehlenden toc-Klassen nicht');
  assert.notDeepEqual(headingShape(without), headingShape(withClasses),
    'der Struktur-Guard sieht den zusaetzlichen Kopf nicht');
});

/* ---------------------------------------------------------------------------
 * (6) Der Markup-Fallback sagt dasselbe wie der englische Woerterbucheintrag.
 *
 * Der Text im Markup ist NICHT nur Platzhalter: er ist das, was ein Besucher
 * ohne JavaScript zu sehen bekommt - also ausgerechnet der Teil des Publikums,
 * das eine selbstgehostete, telemetriefreie App sucht. Kopplung (5) prueft, dass
 * jeder Schluessel EXISTIERT; dass sein Fallback noch dasselbe SAGT, prueft sie
 * nicht.
 *
 * Der Anlass war kein Schoenheitsfehler. v2.15.0 hat drei falsche Zusagen in den
 * Woerterbuechern korrigiert und das Markup stehen lassen; danach sagte die Seite
 * mit JavaScript "One update check against the GitHub releases API" und ohne
 * JavaScript "Nothing until you configure it." Zwei Antworten auf dieselbe Frage,
 * und die falsche stand fuer den misstrauischsten Leser.
 *
 * Verglichen wird der TEXT, nicht das Markup: der Fallback darf sein `<b>` anders
 * setzen als der Woerterbuchwert. Was er nicht darf, ist etwas anderes behaupten.
 * ------------------------------------------------------------------------- */

/** Alle `<tag data-t="key">…</tag>`-Paare einer Seite, als [key, Innentext]. */
function fallbackNodes(html) {
  const body = html.split(/\n\s*(?:var |const )?(?:DICT|T)\s*=/)[0];
  return [...body.matchAll(/<(\w+)[^>]*\sdata-t="([\w-]+)"[^>]*>([\s\S]*?)<\/\1>/g)]
    .map((m) => [m[2], stripTags(m[3])]);
}

/** Der englische Woerterbuchwert als reiner Text, Escapes und Markup aufgeloest. */
function englishText(block, key) {
  const raw = dictValue(block, key);
  return raw === null ? null : stripTags(unescapeJs(raw));
}

for (const page of ['index.html', 'install.html']) {
  test(`${page}: der Markup-Fallback sagt dasselbe wie das englische Woerterbuch`, () => {
    const html = read(page);
    const en = dictBlock(html, 'en');
    assert.ok(en, 'en-Woerterbuch nicht gefunden');

    const nodes = fallbackNodes(html);
    assert.ok(nodes.length > 20, `nur ${nodes.length} data-t-Knoten gefunden - Regex veraltet?`);

    const drift = [];
    for (const [key, markup] of nodes) {
      const dict = englishText(en, key);
      if (dict === null || markup === dict) continue;
      drift.push(`${key}\n    Markup: ${markup}\n    T.en  : ${dict}`);
    }
    assert.deepEqual(drift, [],
      `Markup-Fallback und en-Woerterbuch sagen Verschiedenes (ohne JS steht der Markup-Text da):\n  ${drift.join('\n  ')}`);
  });
}

test('der Fallback-Guard erkennt den Schaden, gegen den er gebaut ist', () => {
  // Der Anlassfall im Original-Wortlaut, gegen ein Woerterbuch, das die
  // korrigierte Fassung fuehrt. Ohne diese Gegenprobe waere ein Guard, dessen
  // Regex ins Leere greift, gruen und blind.
  const damaged = [
    '<p data-t="tb_out_v">Nothing until you configure it.</p>',
    'const T = {',
    "  en: {",
    "tb_out_v:'One update check against the GitHub releases API, nothing else.',",
    '  },',
    '  de: {',
    "tb_out_v:'Eine Update-Abfrage an die GitHub-Releases-API, sonst nichts.',",
    '  }',
    '};',
  ].join('\n');

  const en = dictBlock(damaged, 'en');
  assert.ok(en, 'Testvorlage: en-Block muss auffindbar sein');
  const [[key, markup]] = fallbackNodes(damaged);
  assert.equal(key, 'tb_out_v');
  assert.notEqual(markup, englishText(en, key),
    'der Guard sieht den Drift nicht, gegen den er geschrieben wurde');
});

test('der Fallback-Guard vergleicht Text, nicht Markup', () => {
  // Gegenrichtung: unterschiedliche Auszeichnung bei gleichem Text ist KEIN
  // Befund. Ohne diese Zusicherung waere die erste Fassung, die ein <b> im
  // Woerterbuch anders setzt als im Markup, ein Fehlalarm - und der naechste
  // Reflex waere, den Guard abzuschwaechen statt ihn zu praezisieren.
  const same = [
    '<dd data-t="long_a1"><b>Nothing changes.</b> It is MIT-licensed.</dd>',
    'const T = {',
    '  en: {',
    "long_a1:'<b>Nothing changes.</b> It is MIT-licensed.',",
    '  },',
    '  de: {',
    "long_a1:'<b>Nichts aendert sich.</b> Es ist MIT-lizenziert.',",
    '  }',
    '};',
  ].join('\n');

  const [[key, markup]] = fallbackNodes(same);
  assert.equal(markup, englishText(dictBlock(same, 'en'), key));
});

for (const page of ['index.html', 'install.html']) {
  test(`${page}: jeder benutzte Schluessel steht in beiden Woerterbuechern`, () => {
    const html = read(page);
    const used = usedKeys(html);
    assert.ok(used.size > 20, `nur ${used.size} data-t-Schluessel gefunden - Regex veraltet?`);

    for (const lang of ['en', 'de']) {
      const block = dictBlock(html, lang);
      assert.ok(block, `${lang}-Woerterbuch nicht gefunden`);
      const missing = [...used].filter((k) => !dictKeys(block).has(k)).sort();
      assert.deepEqual(missing, [],
        `Schluessel ohne Eintrag im ${lang}-Woerterbuch (rendert stumm den Markup-Fallback): ${missing.join(', ')}`);
    }
  });
}

// ── (6) Jede Sektion schliesst, was sie oeffnet ──────────────────────────────

/**
 * Kommentare, `<script>` und `<style>` werden MASKIERT statt entfernt: die
 * Zeilennummern in der Fehlermeldung sollen auf die echte Datei zeigen, und die
 * Woerterbuecher am Dateiende tragen Markup in Zeichenketten (`<code>`, `<a>`),
 * das sonst als Struktur mitzaehlte. Ein `</div>` IM Kommentar ueber
 * `.mod-shots` war genau die Falle, die beim Auffinden dieses Befunds zuerst
 * einen Fehlalarm erzeugt hat.
 */
function maskNonMarkup(html) {
  const blank = (m) => m.replace(/[^\n]/g, ' ');
  // Bis zum Fixpunkt: die Maskierung ist idempotent (sie zerstoert ihr eigenes
  // Muster), aber erst die Schleife belegt das auch fuer verschraenkte Faelle.
  // Der $-Ersatz danach frisst einen UNTERMINIERTEN Kommentar: den matcht die
  // COMMENT-Regex nie, und im Browser waere ab dort ohnehin alles Kommentar.
  // End-Tags duerfen Attribute tragen (</script bar> schliesst) - daher [^>]*.
  let out = html, prev;
  do {
    prev = out;
    out = out
      .replace(COMMENT, blank)
      .replace(/<!--[\s\S]*$/, blank)
      .replace(/<script\b[^>]*>[\s\S]*?<\/script\b[^>]*>/gi, blank)
      .replace(/<style\b[^>]*>[\s\S]*?<\/style\b[^>]*>/gi, blank);
  } while (out !== prev);
  return out;
}

const classOf = (tag) => (tag.match(/class="([^"]*)"/) || [])[1] || '(ohne class)';

/**
 * Prueft je Sektion, ob sie genau die `div`s schliesst, die sie oeffnet.
 *
 * Die gemeldete Zeile ist der Punkt, an dem die BILANZ REISST - nicht die
 * Fehlstelle. Das ist keine Nachlaessigkeit, sondern die Grenze der Methode:
 * ein ueberzaehliges `</div>` sieht an seiner eigenen Stelle voellig gueltig
 * aus, es schliesst nur das falsche Element. Beim echten Befund lag zwischen
 * beidem fast das ganze Modulraster (Fehler Z1119, Riss Z1210).
 *
 * Zur Fehlstelle fuehren die `groundings`: die Stellen, an denen die Sektion
 * auf ihre GRUNDTIEFE zurueckfaellt, also kein div mehr offen hat. Eine
 * gesunde Sektion tut das genau einmal, mit ihrem letzten Tag. Kommt es
 * frueher vor, ist genau dort ein `</div>` zu viel - beim echten Befund
 * schloss Z1119 das `.wrap` von Z1038, waehrend `.feat-grid` noch offen sein
 * musste. Eine simple Liste der letzten Schliessungen taugt dafuer NICHT: die
 * Fehlstelle lag 91 Zeilen und zwei Dutzend Modulkarten vor dem Riss.
 */
function sectionDivBalance(html) {
  const masked = maskNonMarkup(html);
  const lineAt = (i) => masked.slice(0, i).split('\n').length;
  const sections = [];
  const divs = [];
  const problems = [];

  for (const m of masked.matchAll(/<(\/?)(section|div)\b[^>]*>/gi)) {
    const closing = m[1] === '/';
    const tag = m[2].toLowerCase();
    const line = lineAt(m.index);

    if (tag === 'section') {
      if (closing) {
        const sec = sections.pop();
        if (!sec) continue;
        if (divs.length !== sec.divDepth) {
          problems.push({
            kind: 'balance', section: sec.cls, line: sec.line, end: line,
            delta: divs.length - sec.divDepth, groundings: sec.groundings,
          });
          while (divs.length > sec.divDepth) divs.pop();
        }
      } else {
        sections.push({ cls: classOf(m[0]), line, divDepth: divs.length, groundings: [] });
      }
      continue;
    }

    const sec = sections[sections.length - 1];
    if (!closing) { divs.push({ cls: classOf(m[0]), line }); continue; }

    if (sec && divs.length <= sec.divDepth) {
      problems.push({ kind: 'underflow', section: sec.cls, line, groundings: sec.groundings });
      continue;
    }
    const opened = divs.pop();
    // Nur die Rueckfaelle auf die Grundtiefe festhalten - siehe Kopfkommentar.
    if (sec && opened && divs.length === sec.divDepth) {
      sec.groundings.push(`Z${line} </div> schliesst .${opened.cls} von Z${opened.line}`);
    }
  }
  return problems;
}

const describeProblems = (problems) => problems.map((p) => {
  const head = p.kind === 'underflow'
    ? `  <section class="${p.section}">: in Z${p.line} schliesst ein </div> ueber die Sektionsgrenze hinaus`
    : `  <section class="${p.section}"> (Z${p.line}-${p.end}): Bilanz ${p.delta > 0 ? '+' : ''}${p.delta}` +
      ` (${p.delta > 0 ? `${p.delta} div nicht geschlossen` : `${-p.delta} div zu viel geschlossen`})`;
  // Der Riss steht oben, die Fehlstelle ist der erste ueberzaehlige Rueckfall.
  if (p.groundings.length < 2) return head;
  const list = p.groundings.map((t, i) => `      ${i === 0 ? '-> ' : '   '}${t}`).join('\n');
  return `${head}\n    die Sektion steht ${p.groundings.length}x ohne offenes div da, gesund waere 1x`
       + ` - der erste Rueckfall ist die Fehlstelle:\n${list}`;
}).join('\n');

for (const page of PAGES) {
  test(`${page}: jede Sektion schliesst genau die divs, die sie oeffnet`, () => {
    const problems = sectionDivBalance(read(page));
    assert.equal(
      problems.length, 0,
      'Sektion mit unausgeglichener div-Bilanz - alles danach faellt aus seinem Container:\n' +
      describeProblems(problems)
    );
  });
}

test('der Bilanz-Guard erkennt den Schaden, gegen den er gebaut ist', () => {
  // Der ECHTE Stand vor dem Fix, verkuerzt: das </div> in Z7 schloss .wrap
  // statt .feat-grid, .mod-grid stand danach ausserhalb des Containers.
  const broken = [
    '<section class="showcase" id="modules">',   // 1
    '  <div class="wrap">',                      // 2
    '    <div class="feat-grid">',               // 3
    '      <div class="feat-row">',              // 4
    '      </div>',                              // 5
    '    </div>',                                // 6
    '    </div>',                                // 7  <- die Fehlstelle
    '    <div class="mod-grid">',                // 8
    '    </div>',                                // 9
    '  </div>',                                  // 10 <- hier reisst die Bilanz
    '</section>',                                // 11
  ].join('\n');

  const problems = sectionDivBalance(broken);
  assert.equal(problems.length, 1, 'der Bruch muss gefunden werden');
  assert.equal(problems[0].kind, 'underflow');
  assert.equal(problems[0].section, 'showcase');

  // Der Riss wird dort gemeldet, wo er auffaellt - NICHT an der Fehlstelle.
  // Diese Zusicherung haelt die Grenze der Methode fest, damit niemand die
  // gemeldete Zeile fuer den Fehler haelt.
  assert.equal(problems[0].line, 10, 'gemeldet wird der Riss, nicht die Fehlstelle');

  // Zur Fehlstelle fuehren die Rueckfaelle auf die Grundtiefe: eine gesunde
  // Sektion hat genau einen, hier sind es zwei, und der ERSTE ist der Fehler.
  assert.equal(problems[0].groundings.length, 2, 'zwei Rueckfaelle statt einem');
  assert.equal(problems[0].groundings[0], 'Z7 </div> schliesst .wrap von Z2',
    `der erste Rueckfall muss die Fehlstelle sein, war:\n${problems[0].groundings.join('\n')}`);

  // Gegenprobe zur Gegenprobe: der reparierte Stand ist still.
  const fixed = broken.split('\n').filter((_, i) => i !== 6).join('\n');
  assert.deepEqual(sectionDivBalance(fixed), [], 'ohne das ueberzaehlige Tag meldet der Guard nichts');
});

test('der Bilanz-Guard zaehlt kein Markup aus Kommentaren, Skripten und Woerterbuechern', () => {
  // Alle drei Quellen haetten in dieser Datei einen Fehlalarm erzeugt: der
  // Kommentar ueber .mod-shots ENTHAELT die Zeichenfolge </div>, und die
  // Woerterbuecher tragen <code>- und <a>-Markup in Zeichenketten.
  const noise = [
    '<section class="platforms">',
    '  <div class="wrap">',
    '    <!-- The </div> above closes .mod-grid, which was missing. -->',
    '    <script>var s = "<div class=\\"x\\">";</script>',
    '    <style>.x::after { content: "</div>"; }</style>',
    '  </div>',
    '</section>',
  ].join('\n');

  assert.deepEqual(sectionDivBalance(noise), [], 'nur echtes Struktur-Markup zaehlt');
});

// ── (7) Eine Rechtsseite nennt ihren Stand nur EINMAL ────────────────────────

/**
 * `datenschutz.html` trug den Stand an zwei Stellen: im Untertitel oben
 * (16.08.2026) und in Abschnitt 14 unten (09.06.2026). Zwei Monate
 * Unterschied, in einem Dokument, dessen einziger Zweck Verbindlichkeit ist.
 * Das englische Gegenstueck war an beiden Stellen konsistent - die deutsche
 * Fassung widersprach also nur sich selbst, und keiner der bestehenden
 * Zwillings-Guards konnte das sehen: sie vergleichen Klassen und
 * Abschnittsstruktur, nicht Inhalte.
 *
 * Geprueft wird je Seite gegen sich selbst, nicht Seite gegen Seite: die
 * Rechtstexte duerfen unterschiedliche Staende haben (das Impressum ist ein
 * eigenes Dokument), eine einzelne Seite darf sich nur nicht widersprechen.
 */
const MONTHS = ['january', 'february', 'march', 'april', 'may', 'june',
  'july', 'august', 'september', 'october', 'november', 'december'];

const D_NUM = String.raw`(\d{1,2})\.(\d{1,2})\.(\d{4})`;
const D_WORD = String.raw`(\d{1,2})\s+(${MONTHS.join('|')})\s+(\d{4})`;

/**
 * Nur Daten zaehlen, die einen STAND nennen. Ein Rechtstext ist voller anderer
 * Daten - `datenschutz.html` nennt den Angemessenheitsbeschluss vom 10.07.2023,
 * und der ist ein Sachdatum, kein Stand. Die erste Fassung dieses Guards hat
 * genau daran auf beiden Seiten falsch angeschlagen.
 *
 * `\bStand\b` steht bewusst als ganzes Wort: "Standardvertragsklauseln"
 * enthaelt denselben Stamm und stand im selben Absatz wie das Sachdatum.
 */
function statedDates(html) {
  const text = stripComments(html).replace(/<[^>]+>/g, ' ');
  const found = new Map(); // ISO -> Originalschreibweise
  const anchor = String.raw`(?:\bStand\b|last updated)[\s\S]{0,45}?`;

  for (const m of text.matchAll(new RegExp(anchor + D_NUM, 'gi'))) {
    found.set(`${m[3]}-${m[2].padStart(2, '0')}-${m[1].padStart(2, '0')}`, `${m[1]}.${m[2]}.${m[3]}`);
  }
  for (const m of text.matchAll(new RegExp(anchor + D_WORD, 'gi'))) {
    const month = String(MONTHS.indexOf(m[2].toLowerCase()) + 1).padStart(2, '0');
    found.set(`${m[3]}-${month}-${m[1].padStart(2, '0')}`, `${m[1]} ${m[2]} ${m[3]}`);
  }
  return found;
}

for (const page of ['datenschutz.html', 'privacy.html', 'impressum.html']) {
  test(`${page}: nennt genau einen Stand`, () => {
    const dates = statedDates(read(page));
    assert.ok(dates.size > 0, 'die Seite muss einen Stand nennen');
    assert.equal(
      dates.size, 1,
      `widersprechende Standsangaben in einem Dokument:\n` +
      [...dates].map(([iso, raw]) => `  ${iso}  ("${raw}")`).join('\n')
    );
  });
}

test('der Stands-Guard erkennt den Schaden, gegen den er gebaut ist', () => {
  // Der ECHTE Stand vor dem Fix, beide Schreibweisen gemischt.
  const de = '<p class="subtitle">Stand: 16.08.2026</p><p>Diese Erklaerung hat den Stand vom <strong>09.06.2026</strong>.</p>';
  const found = statedDates(de);
  assert.equal(found.size, 2, 'der Widerspruch muss gefunden werden');
  assert.deepEqual([...found.keys()].sort(), ['2026-06-09', '2026-08-16']);

  // Beide Schreibweisen zaehlen als DASSELBE Datum, sonst schluege der Guard
  // auf jeder englischen Seite grundlos an.
  assert.equal(statedDates('<p>Stand: 16.08.2026</p><p>Last updated: 16 August 2026</p>').size, 1);

  // Und ein Sachdatum ohne "Stand" davor bleibt aussen vor - das ist der Fall,
  // an dem die erste Fassung dieses Guards falsch angeschlagen hat.
  assert.equal(statedDates(
    '<p>Stand: 16.08.2026</p><p>Angemessenheitsbeschluss der EU-Kommission vom 10.07.2023, '
    + 'ergaenzt durch Standardvertragsklauseln nach Art. 46 DSGVO.</p>').size, 1);

  // Und der reparierte Stand ist still.
  assert.equal(statedDates(de.replace('09.06.2026', '16.08.2026')).size, 1);
});

// ── (8) Die Kapitelmarken bleiben in der Minderheit ──────────────────────────

/**
 * `docs/index.html` fuehrt zwei Sorten Sektionskopf, und die Regel steht dort
 * ausformuliert im CSS: `.sec-head.lead` ist eine KAPITELMARKE (linksbuendig,
 * unter einem Eyebrow, groesser gesetzt), `.sec-head.center` gehoert zum
 * Kapitel darueber. Der Quelltext haelt ausdruecklich fest, dass die Zahl der
 * Kapitelmarken nicht weiter wachsen darf: "ab der Haelfte ist die
 * Unterscheidung wieder eine Liste."
 *
 * Genau diese Regel hat eine Design-Critique am 2026-08-20 als "Koepfe mal
 * links, mal zentriert ohne erkennbares Kriterium" gemeldet und vorgeschlagen,
 * alle Koepfe linksbuendig zu stellen - also den einen Schritt zu tun, vor dem
 * der Kommentar warnt. Eine Regel, die nur als Prosa im Stylesheet steht, ist
 * gegen so einen Vorschlag wehrlos; sie steht deshalb jetzt auch hier.
 */
function sectionHeads(html) {
  const body = stripComments(html);
  return [...body.matchAll(/<div class="sec-head([^"]*)"[^>]*>([\s\S]{0,400}?)<\/div>/g)].map((m) => ({
    lead: /\blead\b/.test(m[1]),
    centered: /\bcenter\b/.test(m[1]),
    eyebrow: /class="eyebrow"/.test(m[2]),
  }));
}

/**
 * Gezaehlt werden SEKTIONEN, nicht Sektionskoepfe - das ist die Grundmenge, die
 * der Kommentar im Stylesheet nennt ("vier von acht"). Zwei Flaechen tragen
 * keinen `.sec-head` (der Hero und die CTA-Box) und wuerden als Nenner fehlen:
 * gegen die Koepfe gerechnet stuenden dieselben vier Kapitelmarken bei 4 von 6
 * und der Guard schluege auf dem gesunden Stand an. Der Hero zaehlt mit, er ist
 * eine Flaeche der Seite wie die anderen.
 */
function sectionCount(html) {
  const body = stripComments(html);
  return (body.match(/<section\b/g) || []).length + (body.match(/<header class="hero"/g) || []).length;
}

test('index.html: Kapitelmarken bleiben hoechstens die Haelfte der Sektionen', () => {
  const html = read('index.html');
  const heads = sectionHeads(html);
  const sections = sectionCount(html);
  assert.ok(heads.length >= 6, `zu wenige Sektionskoepfe gefunden (${heads.length}) - Extraktor gebrochen?`);
  assert.ok(sections >= 7, `zu wenige Sektionen gefunden (${sections}) - Extraktor gebrochen?`);
  const lead = heads.filter((h) => h.lead).length;
  assert.ok(
    lead * 2 <= sections,
    `${lead} von ${sections} Sektionen sind Kapitelmarken. Ab der Haelfte ist die `
    + `Unterscheidung wieder eine Liste - siehe die Begruendung an .sec-head.lead.`
  );
});

test('index.html: der Eyebrow markiert die Kapitelmarke, nicht die Folgesektion', () => {
  const heads = sectionHeads(read('index.html'));
  const leadOhne = heads.filter((h) => h.lead && !h.eyebrow).length;
  const centerMit = heads.filter((h) => h.centered && h.eyebrow).length;
  assert.equal(leadOhne, 0, 'eine Kapitelmarke ohne Eyebrow: der Leser sieht keinen Kapitelanfang');
  assert.equal(centerMit, 0, 'eine zentrierte Folgesektion mit Eyebrow: sie gibt sich als Kapitel aus');
});

test('der Kapitelmarken-Guard erkennt den Schaden, gegen den er gebaut ist', () => {
  // Genau der Vorschlag aus der Critique vom 2026-08-20: alle Koepfe linksbuendig.
  const kopf = '<div class="sec-head lead"><span class="eyebrow">A</span></div>';
  const alleLead = ('<section>' + kopf + '</section>').repeat(6);
  assert.equal(sectionHeads(alleLead).filter((h) => h.lead).length, 6, 'Vorbedingung: sechs Kapitelmarken');
  assert.ok(6 * 2 > sectionCount(alleLead), 'der Guard muss hier anschlagen');

  // Der echte Stand ist still - und zwar KNAPP: vier von acht ist der Hoechststand,
  // den der Kommentar erlaubt. Eine fuenfte Kapitelmarke laesst diesen Test fallen,
  // und das ist die Absicht.
  const html = read('index.html');
  const lead = sectionHeads(html).filter((h) => h.lead).length;
  assert.equal(lead * 2, sectionCount(html), 'der Stand liegt exakt auf der erlaubten Grenze');
});

// ── (7) Ein Telefonrahmen hat die Proportion eines Telefons ──────────────────
/**
 * Zwei Fragen, die zusammen erst die Kopplung halten:
 *
 * a) Steht das Verhaeltnis an EINER Stelle? Ein Literal in einer Regel ist die
 *    Bauart, an der es schon einmal auseinandergelaufen ist - dieselbe Drift,
 *    die die Geraete-Radien in `site.css` schon hinter `--r-phone` gezwungen
 *    hat, nur eine Ebene groeber. Der Guard fragt nicht nach den beiden
 *    bekannten Klassennamen, sondern nach der REGEL: ein hochkant stehendes
 *    `aspect-ratio` auf diesen Seiten beschreibt immer einen Handyrahmen, also
 *    laeuft es ueber `var(--ar-phone)`. Querformat (die 4/3-Desktopaufnahme)
 *    bleibt erlaubt - sie ist kein Geraeterahmen.
 *
 * b) Misst dieser Name noch die Wirklichkeit? Ein sauber getokenter falscher
 *    Wert waere derselbe Fehler mit besserer Buchhaltung. Die 124 Mobil-PNGs
 *    unter `docs/screenshots/` sind die Quelle, und sie sind alle gleich gross;
 *    wer sie in einer anderen Geraetegroesse neu aufnimmt, faellt hier auf.
 */
const PNG_SIG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

function pngSize(file) {
  const buf = readFileSync(file);
  assert.ok(buf.subarray(0, 8).equals(PNG_SIG), `${file} ist kein PNG`);
  return { w: buf.readUInt32BE(16), h: buf.readUInt32BE(20) };
}

function mobileShotFiles() {
  const files = [];
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = resolve(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.name.endsWith('-mobile.png')) files.push(full);
    }
  };
  walk(SHOTS);
  return files;
}

/** Alle Stylesheet-Quellen der Doku-Seiten: die `<style>`-Bloecke plus site.css. */
function docsStylesheets() {
  const sheets = [{ where: 'assets/site.css', css: read('assets/site.css') }];
  for (const page of PAGES) {
    const html = read(page);
    const blocks = html.match(/<style\b[^>]*>[\s\S]*?<\/style>/gi) || [];
    blocks.forEach((block, i) => {
      sheets.push({ where: `${page} <style> #${i + 1}`, css: block.replace(/^<style\b[^>]*>/i, '').replace(/<\/style>$/i, '') });
    });
  }
  return sheets;
}

/**
 * Liefert jedes `aspect-ratio`, das als LITERAL geschrieben ist und hochkant
 * steht. `var(...)` zaehlt nicht - genau darauf soll es ja laufen.
 */
function portraitRatioLiterals(sheets) {
  const found = [];
  for (const { where, css } of sheets) {
    for (const rule of eachRule(css)) {
      for (const decl of rule.body.split(';')) {
        const m = decl.match(/(^|[^-\w])aspect-ratio\s*:\s*([^;]+)$/);
        if (!m) continue;
        const value = m[2].trim().replace(/\s*!important$/, '');
        if (value.includes('var(')) continue;
        const parts = value.split('/').map((n) => Number(n.trim()));
        if (parts.length !== 2 || !parts.every((n) => Number.isFinite(n) && n > 0)) continue;
        if (parts[0] >= parts[1]) continue;
        found.push({ where, selector: rule.selector, value });
      }
    }
  }
  return found;
}

function tokenRatio() {
  const css = read('assets/site.css');
  const m = css.match(/--ar-phone\s*:\s*([^;]+);/);
  assert.ok(m, '--ar-phone fehlt in docs/assets/site.css - die vier Handyrahmen haetten wieder keine gemeinsame Quelle');
  const parts = m[1].split('/').map((n) => Number(n.trim()));
  assert.equal(parts.length, 2, `--ar-phone muss ein Verhaeltnis "b / h" sein, war: ${m[1].trim()}`);
  return { w: parts[0], h: parts[1] };
}

test('docs: kein Handy-Seitenverhaeltnis steht als Literal in einer Regel', () => {
  const found = portraitRatioLiterals(docsStylesheets());
  assert.deepEqual(
    found, [],
    'hochkantes aspect-ratio als Literal - das ist die Bauart, an der .feat-phone (1320/1780) und '
    + '.mod-shot img (1320/1900) vom echten Mass weggelaufen sind. Es gehoert auf var(--ar-phone):\n'
    + found.map((f) => `  ${f.where}: ${f.selector} { aspect-ratio: ${f.value} }`).join('\n')
  );
});

test('docs: --ar-phone misst die Aufnahmen, die es rahmt', () => {
  const token = tokenRatio();
  const files = mobileShotFiles();
  assert.ok(files.length > 0, 'keine -mobile.png gefunden - der Guard haette nichts zu vergleichen');

  const sizes = new Map();
  for (const file of files) {
    const { w, h } = pngSize(file);
    const key = `${w}x${h}`;
    if (!sizes.has(key)) sizes.set(key, []);
    sizes.get(key).push(file.slice(SHOTS.length + 1));
  }

  assert.equal(
    sizes.size, 1,
    'die Handyaufnahmen haben nicht mehr alle dasselbe Mass, ein Token kann sie also nicht mehr '
    + 'gemeinsam rahmen:\n'
    + [...sizes].map(([k, v]) => `  ${k}: ${v.length}x, z.B. ${v[0]}`).join('\n')
  );

  const [w, h] = [...sizes.keys()][0].split('x').map(Number);
  assert.deepEqual(
    { w: token.w, h: token.h }, { w, h },
    `--ar-phone steht auf ${token.w} / ${token.h}, die ${files.length} Aufnahmen sind aber ${w}x${h}. `
    + 'Ein getokenter falscher Wert ist derselbe Fehler mit besserer Buchhaltung.'
  );
});

test('der Ratio-Guard erkennt den Schaden, gegen den er gebaut ist', () => {
  // Der ECHTE Stand vor dem Fix, beide Fundstellen woertlich.
  const kaputt = [{
    where: 'test',
    css: '.feat-phone { display: block; width: 100%; aspect-ratio: 1320 / 1780; object-fit: cover; }\n'
      + '@media (max-width: 700px) { .mod-shot img { width: 100%; aspect-ratio: 1320 / 1900; } }',
  }];
  const treffer = portraitRatioLiterals(kaputt);
  assert.equal(treffer.length, 2, 'beide Fundstellen muessen anschlagen - auch die im @media-Block');
  assert.deepEqual(treffer.map((f) => f.value), ['1320 / 1780', '1320 / 1900']);

  // Gegenprobe zur Gegenprobe: der reparierte Stand ist still - und das echte
  // Mass als Literal waere es NICHT. Ein Name, nicht ein richtiger Wert.
  const repariert = [{ where: 'test', css: kaputt[0].css.replace(/1320 \/ (?:1780|1900)/g, 'var(--ar-phone)') }];
  assert.deepEqual(portraitRatioLiterals(repariert), [], 'ueber den Token gefuehrt meldet der Guard nichts');
  assert.equal(
    portraitRatioLiterals([{ where: 'test', css: '.x { aspect-ratio: 1320 / 2867; }' }]).length, 1,
    'auch das RICHTIGE Verhaeltnis als Literal ist ein Treffer'
  );

  // Und Querformat bleibt erlaubt: die Desktopaufnahme ist kein Geraeterahmen.
  assert.deepEqual(
    portraitRatioLiterals([{ where: 'test', css: '.gal-frame img { aspect-ratio: 4 / 3; }' }]), [],
    '4/3 ist die Desktopaufnahme und darf als Literal stehen'
  );
});

// ── (8) Die Installationsseite: Befehle und Verweise gegen ihre Quelle ───────

/* ---------------------------------------------------------------------------
 * Die Critique vom 2026-09-29 fand auf `install.html` fuenf Anweisungen, die
 * gegen die Dateien verstiessen, die sie beschreiben, und keine davon haette
 * eine Suite gesehen:
 *   - "Port belegt": `3000:3000` in docker-compose.yml aendern - die Datei
 *     liest den Host-Port laengst aus `.env` (OIKOS_HTTP_PORT).
 *   - "Verschluesselungsfehler": `docker compose down -v` - die Compose-Datei
 *     bindet Host-Ordner ein, `-v` loescht dort nichts, der Fehler bleibt.
 *   - Schritt 2 nannte die `REPLACE_WITH_`-Platzhalter nicht, an denen der
 *     Server den Start verweigert.
 *   - Der Proxmox-Link zeigte auf `#tab-docker`. Das ist eine ID (der Knopf),
 *     also sprang der Browser brav hin - nur die Tab-Logik kennt `#docker`.
 *   - Portainer stand nirgends, obwohl installation.md einen Abschnitt hat.
 * Jede Zusage wird deshalb an der Stelle festgemacht, die sie wahr macht.
 * ------------------------------------------------------------------------- */

const INSTALL = 'install.html';
const repo = (p) => readFileSync(resolve(ROOT, p), 'utf8');

/** Beide Woerterbuchwerte eines Schluessels als reiner Text. */
function bothLangs(html, key) {
  return ['en', 'de'].map((lang) => {
    const raw = dictValue(dictBlock(html, lang), key);
    assert.ok(raw !== null, `${key} fehlt im ${lang}-Woerterbuch (oder steht in doppelten Anfuehrungszeichen)`);
    return [lang, stripTags(unescapeJs(raw))];
  });
}

/** Host-Port-Variable und Datenordner-Default, wie docker-compose.yml sie mappt. */
function composeFacts() {
  const yml = repo('docker-compose.yml');
  const port = yml.match(/"[^"]*\$\{(\w+):-3000\}:3000"/)?.[1];
  const data = yml.match(/\$\{DATA_DIR:-([^}]+)\}:\/data/)?.[1];
  assert.ok(port && data, 'docker-compose.yml: Port- oder Daten-Mapping nicht gefunden - Muster veraltet?');
  return { port, data, namedVolumes: /^volumes:/m.test(yml) };
}

/** Alle Befehlstexte der Seite: Codeplatten und Copy-Payloads. */
function commandTexts(html) {
  const body = stripComments(html.split('<script>\n  (function(){')[0]);
  const plates = [...body.matchAll(/<div class="code-block">([\s\S]*?)<\/div>/g)].map((m) => stripTags(m[1]));
  const copies = [...body.matchAll(/data-copy="([^"]*)"/g)].map((m) => decode(m[1].replace(/&#10;/g, '\n')));
  return [...plates, ...copies];
}

test('install.html: der Port-Weg nennt die Variable, die docker-compose.yml liest', () => {
  const html = read(INSTALL);
  const { port } = composeFacts();
  for (const key of ['trouble_port_change', 'trouble_nginx_port', 'success_remote']) {
    for (const [lang, text] of bothLangs(html, key)) {
      assert.ok(text.includes(port), `${key} (${lang}) nennt ${port} nicht: ${text}`);
    }
  }
  // Keine Anleitung, die Portzuordnung in der Compose-Datei von Hand zu aendern.
  assert.deepEqual(html.match(/\b\d{2,5}:3000\b/g) || [], [],
    `install.html schickt Leser in die Compose-Datei, obwohl sie ${port} aus .env liest`);
});

test('install.html: der Datenbank-Reset loescht den Ordner, den die Compose-Datei einbindet', () => {
  const html = read(INSTALL);
  const { data, namedVolumes } = composeFacts();
  assert.equal(namedVolumes, false,
    'docker-compose.yml hat jetzt benannte Volumes - dann waere `down -v` wieder ein Weg, Anleitung neu pruefen');
  const cmds = commandTexts(html);
  assert.ok(cmds.length > 15, `nur ${cmds.length} Befehle gefunden - Muster veraltet?`);
  assert.deepEqual(cmds.filter((c) => /down\s+-v\b/.test(c)), [],
    '`down -v` als Befehl: bei Host-Ordnern loescht es nichts, der Schluesselfehler bleibt');
  assert.ok(cmds.some((c) => c.includes(`rm -rf ${data}`)), `kein Reset-Befehl fuer ${data} gefunden`);
});

test('install.html: Schritt 2 und die Neustart-Hilfe nennen den Platzhalter, an dem der Server stoppt', () => {
  const html = read(INSTALL);
  const prefix = repo('server/auth.js').match(/SESSION_SECRET\.startsWith\('([A-Z_]+)'\)/)?.[1];
  assert.ok(prefix, 'server/auth.js: Platzhalter-Pruefung nicht gefunden - Muster veraltet?');
  assert.ok(repo('server/db.js').includes(`DB_KEY.startsWith('${prefix}')`), 'server/db.js prueft einen anderen Praefix');
  const example = repo('.env.example');
  for (const v of ['SESSION_SECRET', 'DB_ENCRYPTION_KEY']) {
    assert.ok(new RegExp(`^${v}=${prefix}`, 'm').test(example), `.env.example liefert ${v} nicht mehr als ${prefix}...`);
  }
  for (const key of ['step_a2_edit', 'trouble_restart_desc']) {
    for (const [lang, text] of bothLangs(html, key)) {
      assert.ok(text.includes(prefix), `${key} (${lang}) nennt ${prefix} nicht`);
    }
  }
});

test('docs: jede heruntergeladene Datei und jede Compose-Datei existiert im Repository', () => {
  for (const page of ['index.html', INSTALL]) {
    const html = read(page);
    const fetched = [...html.matchAll(/raw\.githubusercontent\.com\/ulsklyc\/yuvomi\/main\/([\w./-]+)/g)].map((m) => m[1]);
    const composed = [...html.matchAll(/compose -f ([\w./-]+\.ya?ml)/g)].map((m) => m[1]);
    assert.ok(fetched.length >= 2, `${page}: keine Download-URL gefunden - Muster veraltet?`);
    const missing = [...new Set([...fetched, ...composed])].filter((f) => !existsSync(resolve(ROOT, f)));
    assert.deepEqual(missing, [], `${page} verweist auf Dateien, die es im Repository nicht gibt`);
  }
  // Der Podman-Start ist woertlich der aus installation.md, nicht eine Nachdichtung.
  const up = 'podman compose -f podman-compose.yml up -d';
  assert.ok(read(INSTALL).includes(up) && read('installation.md').includes(up), `"${up}" fehlt auf der Seite oder in installation.md`);
});

/**
 * GitHubs Anker fuer eine Markdown-Ueberschrift: klein, alles ausser Buchstaben,
 * Ziffern, Leerzeichen, `-` und `_` faellt weg, Leerzeichen werden `-`. Ein
 * Gedankenstrich hinterlaesst deshalb ZWEI Bindestriche (`option-g--portainer`).
 */
function githubSlug(heading) {
  return heading.replace(/<[^>]+>/g, '').replace(/`/g, '').trim().toLowerCase()
    .replace(/[^\p{L}\p{N} _-]/gu, '').replace(/ /g, '-');
}

function markdownAnchors(md) {
  const seen = new Map();
  const out = new Set();
  const body = md.replace(/^```[\s\S]*?^```/gm, '');
  for (const m of body.matchAll(/^#{1,6}\s+(.+?)\s*$/gm)) {
    const base = githubSlug(m[1]);
    const n = seen.get(base) || 0;
    seen.set(base, n + 1);
    out.add(n ? `${base}-${n}` : base);
  }
  for (const m of body.matchAll(/<a name="([^"]+)"/g)) out.add(m[1]);
  return out;
}

function brokenGuideAnchors(html, anchors) {
  return [...html.matchAll(/installation\.md#([^"'\s)]+)/g)].map((m) => m[1]).filter((a) => !anchors.has(a));
}

test('docs: jeder Anker in die installation.md trifft eine Ueberschrift', () => {
  const anchors = markdownAnchors(read('installation.md'));
  for (const page of ['index.html', INSTALL]) {
    assert.deepEqual(brokenGuideAnchors(read(page), anchors), [], `${page}: Anker ohne Ziel in docs/installation.md`);
  }
  assert.ok(read(INSTALL).includes('installation.md#option-g--portainer'), 'install.html verweist nicht mehr auf den Portainer-Abschnitt');
});

/** Seiteninterne Sprungziele: ein Tab-Slug (samt Alias) oder eine ID, die kein Tab-Knopf ist. */
function brokenHashLinks(html) {
  const body = stripComments(html);
  const tabIds = [...body.matchAll(/class="tab-btn[^"]*"[^>]*\sid="([\w-]+)"/g)].map((m) => m[1]);
  const slugs = new Set(tabIds.map((id) => id.replace(/^tab-/, '')));
  for (const m of body.matchAll(/TAB_ALIAS = \{([^}]*)\}/g)) for (const a of m[1].matchAll(/(\w+):/g)) slugs.add(a[1]);
  const ids = new Set([...body.matchAll(/\sid="([\w-]+)"/g)].map((m) => m[1]));
  return [...body.matchAll(/href=\\?"#([\w-]+)\\?"/g)].map((m) => m[1])
    .filter((h) => !slugs.has(h) && (!ids.has(h) || tabIds.includes(h)));
}

test('install.html: jeder seiteninterne Link trifft einen Tab oder eine Sektion', () => {
  const html = read(INSTALL);
  assert.deepEqual(brokenHashLinks(html), [],
    'Link auf einen Tab-KNOPF statt auf den Tab-Slug: der Browser springt, der Tab wechselt nicht');
  assert.ok(html.includes('href="#docker"') && html.includes('href="#installer"'), 'Tab-Links nicht gefunden - Muster veraltet?');
});

test('die Installationsseiten-Guards erkennen den Schaden, gegen den sie gebaut sind', () => {
  // Der Stand vor dem Fix, woertlich.
  const alt = '<button class="tab-btn" role="tab" id="tab-docker" type="button"></button>'
    + '<p>the <a href="#tab-docker">Docker image</a> path</p>'
    + '<div class="code-block">docker compose down -v\n<span class="cmd">docker compose up -d</span></div>'
    + '<p>change <code>3000:3000</code> to e.g. <code>8080:3000</code>.</p>';
  assert.deepEqual(brokenHashLinks(alt), ['tab-docker']);
  assert.ok(commandTexts(alt).some((c) => /down\s+-v\b/.test(c)), 'der Reset-Guard sieht `down -v` nicht');
  assert.equal((alt.match(/\b\d{2,5}:3000\b/g) || []).length, 2, 'der Port-Guard sieht die Compose-Anleitung nicht');
  // Anker: der Gedankenstrich wird zu zwei Bindestrichen, ein falscher Slug faellt auf.
  const anchors = markdownAnchors('### Option G \u2014 Portainer (Stack or Git/GitOps)\n## Backup & Restore\n');
  assert.ok(anchors.has('option-g--portainer-stack-or-gitgitops') && anchors.has('backup--restore'));
  assert.deepEqual(brokenGuideAnchors('installation.md#option-g-portainer', anchors), ['option-g-portainer']);
});
