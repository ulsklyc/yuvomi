/**
 * Schicht-Guard (Frontend/Backend-Grenze).
 * Hält die Architektur-Invariante dauerhaft:
 *
 *   - `public/` (Browser-Frontend) importiert NIEMALS aus `server/`.
 *     Frontend-Code läuft im Browser; ein Server-Modul (node:*, better-sqlite3,
 *     Middleware) dort zu importieren bricht zur Laufzeit und vermischt die Schichten.
 *   - `server/` (Node-Backend) importiert aus `public/` NUR bewusst geteilte,
 *     isomorphe Utilities aus der Allowlist unten (reine Funktionen ohne DOM/Node-
 *     Abhängigkeit, die Front- und Backend identisch nutzen sollen).
 *
 * Motivation: Ein AST-Namensauflöser (z. B. graphify) band gleichnamige Funktionen
 * (`num()`, `save()`) über die Schichtgrenze hinweg falsch aneinander. Die Regel
 * „public/ ruft nie server/ direkt auf, außer über geteilte isomorphe Utils" ist der
 * zuverlässige Filter dafür — und zugleich eine echte Architektur-Invariante des
 * Produkts. Dieser Guard erzwingt sie an der Quelle statt am regenerierten Graphen.
 *
 * Eine neue geteilte isomorphe Util wird bewusst durch Aufnahme in SHARED_ISOMORPHIC
 * freigegeben — nicht durch Aufweichen der Regel.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const ROOT = fileURLToPath(new URL('../', import.meta.url));
const PUBLIC_DIR = path.join(ROOT, 'public');
const SERVER_DIR = path.join(ROOT, 'server');

/**
 * Allowlist geteilter, isomorpher Module (repo-relativer Pfad), die `server/`
 * aus `public/` importieren darf. Reine Funktionen, front- und backend-identisch.
 */
const SHARED_ISOMORPHIC = new Set([
  // Notes category identity must match in the API and duplicate-name picker.
  // This pure Unicode normalization has no browser or server dependencies.
  'public/utils/note-category-name.js',
  // #469: Was aus einem Adressfeld eine Adresse macht - oder eine Absage. Das
  // Ergebnis landet als `href` einer Kachel auf der Startseite; die Route
  // prueft es, weil eine Client-Pruefung keine Grenze ist, und das Formular
  // prueft es, damit es sofort widerspricht statt nach dem Absenden. Zwei
  // Fassungen liefen hier nicht bei einem Tippfehler auseinander, sondern bei
  // genau dem Wert, den jemand sucht, der sie auseinanderlaufen sehen will.
  'public/utils/quick-link-url.js',
  'public/utils/recipe-meal-types.js',
  'public/utils/contact-name.js',
  'public/utils/pantry-units.js',
  // #1074: Ziffern fremder Systeme nach ASCII. Client und Server lesen dieselben
  // Mengentexte („۲۵۰ g") - der Client, um eine Zutat zu skalieren, der Server,
  // um sie beim Uebertrag in die Einkaufsliste zusammenzuzaehlen. Zwei Fassungen
  // wuerden hier nicht bei einem Randfall auseinanderlaufen, sondern bei jedem
  // Haushalt, der seine eigenen Ziffern schreibt: die eine Seite rechnete, die
  // andere nicht. Rein aus Intl abgeleitet, ohne DOM und ohne Node.
  'public/utils/digits.js',
  // #620: Das Format der Sync-Ziel-Kennung. Der Server validiert genau das,
  // was Event-Modal und Einstellungen bauen - zwei Definitionen desselben
  // Formats würden sich unbemerkt auseinanderentwickeln.
  'public/utils/sync-target.js',
  // #944: HTML-Escaping. Eine Erinnerungsmail traegt Nutzertexte (Aufgaben-,
  // Terminnamen) in ihren HTML-Teil; dort gilt dieselbe Regel wie im DOM. Das
  // Modul ist absichtlich schmal - die Nachbardatei utils/html.js re-exportiert
  // esc(), traegt aber auch den Notiz-Renderer mit seinen CSS-Klassen und ist
  // damit Frontend-Code, kein geteiltes Util.
  'public/utils/html-escape.js',
  // #891: Wie ein Termin zu seiner Farbe kommt - eigene Farbe, sonst die der
  // PRIMAEREN zugewiesenen Person, sonst die des Kalenders. Der Browser malt
  // damit Kalender und Uebersicht, der Server beantwortet damit die
  // Countdown-Kachel, die ihre Zeilen fertig ausliefert statt die Rohfelder.
  // Zwei Fassungen liefen genau dort auseinander, wo es niemandem auffaellt:
  // derselbe Termin traegt in der einen Kachel die Farbe der Person und in der
  // anderen den Modulton - und vor #891 war der Unterschied unsichtbar, weil
  // die Spalte NOT NULL war und die Rangfolge nie ueber ihr erstes Glied kam.
  'public/utils/event-color.js',
  // #734: Wie ein Kommentartext gegen die Mitgliederliste gelesen wird. Der
  // Browser hebt damit hervor, der Server wählt damit die Empfänger der
  // Benachrichtigung. Zwei Fassungen hieße: ein Name steht farbig da, und
  // niemand erfährt, dass er gemeint war.
  'public/utils/mentions.js',
  // #825: Der lokale Kalendertag. `start_date` und `due_date` sind Tage, die
  // jemand lokal eingegeben hat - wer sie gegen `date('now')` oder
  // `toISOString()` prueft, vergleicht sie mit dem UTC-Tag und liegt westlich
  // von UTC abends, oestlich davon morgens um einen Tag daneben. Genau deshalb
  // nennt CLAUDE.md diese Funktion als DIE Antwort auf die Falle. Eine zweite
  // Fassung im Backend waere die dritte im Repo und wuerde von der ersten nur
  // dort abweichen, wo es niemandem auffaellt: nicht in der CI, die in UTC laeuft.
  'public/utils/date.js',
  // #841: Der Vorrat waehlbarer Waehrungen. Er stand viermal woertlich im Repo
  // (Einstellungen, Abos, Preferences-Route, Geteilte Ausgaben) und wurde von
  // zwei Guards per Regex ueber den Quelltext zusammengehalten - eine teure
  // Antwort auf die falsche Frage. Wer eine Waehrung aufnahm, musste vier
  // Listen anfassen, und wer eine vergass, bekam eine Waehrung, die im
  // Haushalt einstellbar und in zwei Modulen nicht waehlbar war (KRW, IDR,
  // IRR waren genau so gestrandet). Eine reine Konstante, sonst nichts.
  'public/utils/currency-codes.js',
  // #704: Was eine Checklisten-Zeile ist. Der Renderer im Browser entscheidet
  // damit, welche Zeile ein antippbares Kaestchen bekommt, und die Route
  // entscheidet damit, welche Zeile einen Haken aendern darf. Zwei Fassungen
  // hiessen: eine Zeile wird als Kaestchen gezeichnet und beim Antippen mit
  // 409 abgewiesen - oder, schlimmer, eine Zeile ohne Kaestchen laesst sich
  // ueber die Route umschreiben. Reine Textfunktionen, kein DOM, kein Node.
  'public/utils/markdown-checklist.js',
  // #785: Was ein Ordnerbaum bedeutet - was liegt unter einem Ordner, wo liegt
  // er selbst, und darf er dorthin. Die Seitenleiste zaehlt damit ihre
  // Dokumente je Ordner, die Route filtert damit ihre Abfrage. Zwei Fassungen
  // ergaeben die unangenehmste Sorte Fehler: eine Zahl links, die nicht zur
  // Liste rechts passt, ohne dass eine von beiden falsch aussieht. Dass beide
  // Seiten "auch die Unterordner" gleich beantworten, ist die ganze Aussage
  // des Baums - und die Zyklus- und Tiefengrenze darf gar nicht erst zweimal
  // formuliert sein: die eine Fassung ist die Grenze, die andere waere ein
  // Vorschlag. Reine Funktionen ueber eine Ordnerliste, kein DOM, kein Node.
  'public/utils/folder-tree.js',
  // Zyklus-Vorhersage (Health, Phase 1 der Cycle-Roadmap): nächster
  // Periodenbeginn, Eisprung, fruchtbares Fenster. Der Zyklus-Tab zeichnet
  // damit den Ring und den Kalender, server/services/cycle-reminders.js
  // berechnet damit den Zeitpunkt der Erinnerung. Zwei Fassungen liefen genau
  // dort auseinander, wo es niemandem auffiele: eine Erinnerung, die einen
  // anderen Tag nennt als der Ring zeigt. Rein, ohne DOM/Node - der einzige
  // Import (date.js) steht selbst schon in dieser Liste.
  'public/utils/health-cycle.js',
]);

const SOURCE_EXT = /\.(js|mjs)$/;

/** Alle .js/.mjs-Dateien unter dir (rekursiv), als absolute Pfade. */
function sourceFiles(dir) {
  const out = [];
  for (const name of readdirSync(dir)) {
    const full = path.join(dir, name);
    if (statSync(full).isDirectory()) out.push(...sourceFiles(full));
    else if (SOURCE_EXT.test(name)) out.push(full);
  }
  return out;
}

/**
 * Liefert je import/export-from und dynamischem import() das Modul-Specifier
 * samt Zeilennummer. Deckt statische ES-Module und `import('…')` ab.
 */
function importSpecifiers(code) {
  const out = [];
  // static: import ... from '…'  |  export ... from '…'  |  import '…'
  const staticRe = /\b(?:import|export)\b[^;'"]*?\bfrom\s*['"]([^'"]+)['"]|\bimport\s*['"]([^'"]+)['"]/g;
  // dynamic: import('…')  — nur String-Literale (variable Specifier sind hier ohnehin selten)
  const dynRe = /\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g;
  for (const re of [staticRe, dynRe]) {
    let m;
    while ((m = re.exec(code)) !== null) {
      const spec = m[1] ?? m[2];
      if (!spec) continue;
      const line = code.slice(0, m.index).split('\n').length;
      out.push({ spec, line });
    }
  }
  return out;
}

/** 'public' | 'server' | null für einen absoluten Pfad. */
function layerOf(absPath) {
  const rel = path.relative(ROOT, absPath);
  if (rel === 'public' || rel.startsWith('public' + path.sep)) return 'public';
  if (rel === 'server' || rel.startsWith('server' + path.sep)) return 'server';
  return null;
}

/**
 * Löst einen relativen Specifier gegen die Datei auf und liefert den absoluten
 * Zielpfad — oder null für nicht-relative Specifier (node:*, npm, Browser-Root `/…`).
 * Nur relative Pfade können die Schichtgrenze überqueren; alles andere ist irrelevant.
 */
function resolveRelative(fromFile, spec) {
  if (!spec.startsWith('.')) return null;
  return path.resolve(path.dirname(fromFile), spec);
}

test('public/ importiert niemals aus server/', () => {
  const violations = [];
  for (const file of sourceFiles(PUBLIC_DIR)) {
    const code = readFileSync(file, 'utf8');
    for (const { spec, line } of importSpecifiers(code)) {
      const target = resolveRelative(file, spec);
      if (target && layerOf(target) === 'server') {
        violations.push(`${path.relative(ROOT, file)}:${line} → importiert '${spec}' (server/)`);
      }
    }
  }
  assert.deepEqual(
    violations,
    [],
    'Frontend-Code darf keine Server-Module importieren — die Logik gehört hinter die API:\n' +
      violations.join('\n'),
  );
});

test('server/ importiert aus public/ nur geteilte isomorphe Utils (Allowlist)', () => {
  const violations = [];
  for (const file of sourceFiles(SERVER_DIR)) {
    const code = readFileSync(file, 'utf8');
    for (const { spec, line } of importSpecifiers(code)) {
      const target = resolveRelative(file, spec);
      if (target && layerOf(target) === 'public') {
        const relTarget = path.relative(ROOT, target).split(path.sep).join('/');
        if (!SHARED_ISOMORPHIC.has(relTarget)) {
          violations.push(
            `${path.relative(ROOT, file)}:${line} → importiert '${spec}' (${relTarget})`,
          );
        }
      }
    }
  }
  assert.deepEqual(
    violations,
    [],
    'Backend darf aus public/ nur bewusst freigegebene isomorphe Utils importieren.\n' +
      'Ist das Modul wirklich isomorph (rein, ohne DOM/Node), in SHARED_ISOMORPHIC aufnehmen —\n' +
      'sonst die Logik ins Backend verschieben:\n' +
      violations.join('\n'),
  );
});

// ── Keine Quelldatei ist fuer Textwerkzeuge unsichtbar ───────────────────────
//
// Ein rohes NUL-Byte im Quelltext laeuft zur Laufzeit einwandfrei - JavaScript
// erlaubt das Zeichen im String, und beide Fundstellen benutzten es bewusst als
// Trennzeichen in einem Map-Schluessel. Fuer Unix-Werkzeuge macht es die Datei
// aber zur BINAERDATEI: `file` meldet "data", und `grep` schweigt ohne `-a`,
// statt "keine Treffer" auch nur zu behaupten.
//
// Gefunden wurde das, weil eine Suche nach `sync` in server/services/holidays.js
// leer zurueckkam - bei einer Datei mit 33 Treffern. Der falsche Schluss daraus
// ("der Service liest diese Konfiguration nicht") war schon gezogen. Jeder
// Guard dieses Repos, der ueber Textsuche arbeitet, haette dieselbe Luecke
// gehabt, ohne je rot zu werden.
//
// Die Escape-Sequenz `\x00` erzeugt exakt dasselbe Zeichen; geprueft wird
// deshalb die SCHREIBWEISE, nicht die Absicht.

test('keine Quelldatei enthaelt ein rohes NUL-Byte', () => {
  const roots = ['server', 'public', 'tools', 'test'];
  const files = [];
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (/\.(js|mjs|json|css|html)$/.test(entry.name)) files.push(full);
    }
  };
  for (const r of roots) walk(path.join(ROOT, r));

  assert.ok(files.length >= 200, `nur ${files.length} Quelldateien gefunden - die Suche greift nicht mehr`);

  const binary = files
    .filter((f) => readFileSync(f).includes(0x00))
    .map((f) => path.relative(ROOT, f));
  assert.deepEqual(binary, [],
    'Diese Dateien enthalten ein rohes NUL-Byte und gelten damit als Binaerdateien - '
    + 'grep und Konsorten ueberspringen sie stumm. Schreib das Zeichen als \\x00:\n  '
    + binary.join('\n  '));
});
