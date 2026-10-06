/**
 * Initialen auf Avatar-Scheiben (#1464, #1607).
 *
 * Drei Zusagen:
 *
 * 1. DIE REGEL als Tabelle am Helfer `public/utils/initials.js`.
 * 2. ES GIBT NUR DIESEN EINEN. Der Guard liest jede JS-Datei unter `public/`
 *    und wird rot, wenn dort wieder eine eigene Initialen-Regel steht - an
 *    ihrer DEFINITION (eine Funktion oder Variable dieses Namens) und an ihrer
 *    FORM (erstes Zeichen je Wort, zwei Zeichen in Grossbuchstaben). Ob der
 *    Detektor die Form ueberhaupt sieht, misst er an den vierzehn Kopien, die
 *    es bis v2.71 gab: sie stehen unten woertlich als Probe.
 * 3. JEDER AUFRUFER zeigt die Zeichen des Helfers. Gemessen wird am Markup,
 *    das der Aufrufer baut, mit einem Namen, den keine der alten Kopien
 *    richtig schrieb (김민수 -> 민수) - ein Aufrufer, der eine eigene Regel
 *    behielte oder zurueckbekaeme, schriebe 김.
 *
 * Laeuft mit dem Browser-Loader. `/utils/initials.js` ist dort KEIN Stub, die
 * Seiten laden also den echten Helfer; `/components/user-multi-select.js` ist
 * einer, darum wird die Komponente hier ueber ihren Dateipfad geladen.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';

globalThis.HTMLElement = globalThis.HTMLElement ?? class {};
globalThis.customElements = globalThis.customElements ?? { define() {}, get() {} };

const { installMiniDom } = await import('./mini-dom.js');
installMiniDom();

const {
  initials, compactInitials, graphemes, resolveInitials, setInitialsRoster, clearInitialsRoster,
} = await import('../public/utils/initials.js');

const PUBLIC = new URL('../public/', import.meta.url);
const read = (rel) => readFileSync(new URL(rel, PUBLIC), 'utf8');

// --------------------------------------------------------
// 1. Die Regel
// --------------------------------------------------------

const E_ACUTE = 'e\u0301'; // e + kombinierender Akut: ein Graphem, zwei Codepoints
const FAMILY = '\u{1F469}\u200D\u{1F467}'; // Frau + ZWJ + Maedchen: ein Graphem
const FLAG = '\u{1F1F0}\u{1F1F7}'; // zwei Regional-Indikatoren: ein Graphem
const KEYCAP_1 = '1\uFE0F\u20E3'; // Ziffer + Variantenselektor + Tastenkappe: ein Graphem
const KEYCAP_2 = '2\uFE0F\u20E3';
// Die Flagge von England: schwarze Flagge + sechs Tag-Zeichen (gbeng + Ende).
const ENGLAND = '\u{1F3F4}\u{E0067}\u{E0062}\u{E0065}\u{E006E}\u{E0067}\u{E007F}';
// Derselbe Name, kanonisch ZERLEGT: jede Silbe steht als zwei oder drei Jamo
// da (Import, macOS-Dateinamen). Namen werden ohne NFC-Normalisierung
// gespeichert, also kommt das auf der Scheibe an.
const NFD_KIM_MINSU = '김민수'.normalize('NFD');
const NFD_MINSU = '민수'.normalize('NFD');
const NFD_SU = '수'.normalize('NFD');

const TABLE = [
  // Name, erwartete Zeichen, was die Zeile haelt
  ['Anna', 'A', 'ein Wort'],
  ['Anna Schmidt', 'AS', 'zwei Woerter'],
  ['Anna Maria Schmidt', 'AS', 'drei Woerter: das erste und das letzte, nicht die ersten zwei'],
  ['Dr. Hans Müller', 'DM', 'ein Titel vorn: das letzte Wort ist der Familienname'],
  ['Jean-Luc Picard', 'JP', 'zwei Woerter, das erste mit Bindestrich'],
  ['Maria del Carmen Ruiz Soto', 'MS', 'fuenf Woerter: weiterhin das erste und das letzte'],
  ['Anna-Lena Vogt', 'AV', 'ein Bindestrich trennt nicht'],
  ['Jean-Luc', 'J', 'ein Wort mit Bindestrich'],
  ['anna schmidt', 'AS', 'Kleinbuchstaben werden gross'],
  ['  Anna   Schmidt ', 'AS', 'Leerraum am Rand und doppelt'],
  ['Anna\tSchmidt', 'AS', 'Tabulator trennt wie ein Leerzeichen'],
  ['김민수', '민수', 'Hangul ohne Leerraum: der Rufname'],
  ['민수', '민수', 'zwei Hangul-Zeichen: der ganze Name'],
  ['김', '김', 'ein Hangul-Zeichen: der ganze Name'],
  ['田中太郎', '太郎', 'Han ohne Leerraum: die letzten zwei'],
  ['やまだ', 'まだ', 'Hiragana'],
  ['サトー', 'トー', 'Katakana mit Laengungszeichen'],
  ['佐々木', '々木', 'das Wiederholungszeichen zaehlt als Han'],
  ['김 민수', '민수', 'zwei Hangul-Woerter: das zweite ist der Rufname - wie ohne Leerraum'],
  ['田中 太郎', '太郎', 'zwei Han-Woerter: wie 田中太郎'],
  ['田中\u3000太郎', '太郎', 'das ideografische Leerzeichen ist Leerraum'],
  ['남궁 민', '민', 'ein Rufname aus einem Zeichen'],
  ['김 민수아', '수아', 'ein laengerer Rufname: seine letzten zwei Zeichen'],
  ['김 Minsu', '김M', 'ein lateinisches Wort: Wortregel'],
  ['Minsu 김', 'M김', 'ein lateinisches Wort vorn: Wortregel'],
  ['김 민 수', '김수', 'drei CJK-Woerter: Wortregel, erstes und letztes'],
  ['Kim민수', 'K', 'gemischte Schrift in einem Wort ist kein CJK-Name'],
  ['श्रुति शर्मा', 'श्रुश', 'eine Devanagari-Ligatur (Konsonant + Virama + Konsonant) bleibt ganz'],
  ['क्षमा', 'क्ष', 'eine Ligatur am Wortanfang'],
  ['\u{1F984} Einhorn', '\u{1F984}E', 'ein Emoji bleibt ganz (Surrogatpaar)'],
  ['\u{1F984}', '\u{1F984}', 'ein Emoji allein'],
  [`${FAMILY} Mama`, `${FAMILY}M`, 'eine ZWJ-Folge bleibt ganz'],
  [`${FLAG} Seoul`, `${FLAG}S`, 'eine Flagge bleibt ganz'],
  [`${E_ACUTE}lodie`, 'E\u0301', 'ein kombinierendes Zeichen bleibt bei seinem Buchstaben'],
  [NFD_KIM_MINSU, NFD_MINSU, 'zerlegtes Hangul: drei Silben aus acht Jamo, der Rufname bleibt ganz'],
  [`${KEYCAP_1} Eins`, `${KEYCAP_1}E`, 'eine Tastenkappe bleibt ganz'],
  // GROSSSCHREIBUNG KANN EIN ZEICHEN VERLAENGERN (#1464): `toUpperCase()` macht
  // aus einem Buchstaben zwei oder drei, und die Scheibe trug drei Zeichen.
  ['ßeta Schmidt', 'SS', 'ß wird gross zu SS - auf der Scheibe bleibt EIN Zeichen je Wort'],
  ['ßeta', 'S', 'dasselbe bei einem Wort'],
  ['\uFB01ona \uFB02ora', 'FF', 'die Ligaturen fi und fl werden gross zu FI und FL'],
  ['\uFB03 x', 'FX', 'ffi wird zu drei Buchstaben'],
  ['\u0149gomo', 'N', 'U+0149 wird zu Apostroph + N: der Buchstabe zaehlt, nicht der Apostroph'],
  ['\u01F0an', 'J\u030C', 'U+01F0 wird zu J + Hatschek: zwei Codepoints, EIN Zeichen'],
  ['\u0587 x', '\u0535X', 'die armenische Ligatur wird zu zwei Buchstaben'],
  // Tuerkisch: OHNE Locale, damit dieselbe Person bei jedem Betrachter
  // dieselben Zeichen traegt - die Sprache des Namens kennt die App nicht.
  ['İpek Yılmaz', 'İY', 'das grosse I mit Punkt bleibt, wie es eingegeben wurde'],
  ['ipek', 'I', 'ein kleines i wird zu I, in jeder Oberflaechensprache'],
  ['ırmak', 'I', 'das i ohne Punkt wird zu I'],
  // Schriften ohne Gross und Klein bleiben, wie sie sind.
  ['محمد', 'م', 'Arabisch: ein Wort'],
  ['محمد علي', 'م\u200Cع', 'Arabisch: zwei Buchstaben verbinden sich NICHT zu einem Wort (U+200C dazwischen)'],
  ['فاطمة Müller', 'فM', 'Arabisch neben Latein: nichts zu trennen'],
  ['दीपक कुमार', 'दीकु', 'Devanagari: der Vokal bleibt an seinem Konsonanten'],
  ['გიორგი', 'გ', 'Georgisch: `toUpperCase()` gaebe Mtavruli, das kaum eine Schrift zeichnet'],
  ['Ελένη Παπαδοπούλου', 'ΕΠ', 'Griechisch'],
  ['дмитрий иванов', 'ДИ', 'Kyrillisch wird gross'],
  // Was kein Buchstabe, keine Ziffer und kein Emoji ist, steht nicht auf der
  // Scheibe, solange der Name etwas anderes hergibt.
  ['(Oma) Erika', 'OE', 'eine Klammer vorn'],
  ['"Anna" Schmidt', 'AS', 'Anfuehrungszeichen'],
  ['¡Ana! ¿Ruiz?', 'AR', 'spanische Satzzeichen'],
  ["'t Hooft", 'TH', 'ein Apostroph vorn'],
  ['-Anna', 'A', 'ein Strich vorn, ein Wort'],
  ['Anna -', 'A', 'ein Wort nur aus Satzzeichen zaehlt nicht'],
  ['- Anna Schmidt', 'AS', 'auch vorn nicht'],
  ['Anna & Bert', 'AB', 'und in der Mitte nicht'],
  ['\u200Fمحمد', 'م', 'ein unsichtbares Richtungszeichen vorn ergab eine leere Scheibe'],
  ['\uFEFFAnna', 'A', 'ebenso ein BOM'],
  [':-)', ':', 'NUR Satzzeichen: dann das erste, wie bisher - keine leere Scheibe'],
  ['#1 Papa', '1P', 'eine Ziffer zaehlt'],
  [`${ENGLAND} Harry`, `${ENGLAND}H`, 'eine Flagge aus Tag-Zeichen bleibt ganz'],
  ['ﾔﾏﾀﾞ', 'ﾏﾀﾞ', 'halbbreite Katakana: das Truebungszeichen bleibt an seiner Silbe'],
];

// Namen in den Schriften, in denen die App spricht - fuer den Vergleich des
// Rueckfalls mit `Intl.Segmenter`.
const NAMES_BY_SCRIPT = [
  'श्रुति', 'क्षमा', 'स्मिता', 'प्रिया', 'ज्ञानेश', // Devanagari, mit Ligaturen
  'প্রিয়া', 'শ্রেয়া', // Bengalisch
  'ప్రియ', 'ശ്രീ', 'પ્રિયા', // Telugu, Malayalam, Gujarati
  'ப்ரியா', 'ஸ்ரீ', // Tamil: der Segmenter trennt dort nach dem Virama
  'محمد', 'فاطمة', 'علی', // Arabisch, Persisch
  'Ελένη', 'Дмитрий', 'Zoë', 'Łukasz', 'İpek', 'Nguyễn',
  '김민수', '田中太郎', 'やまだ', 'サトー',
  `${E_ACUTE}lodie`, `${FAMILY}${FLAG}\u{1F984}`, '\u{1F44D}\u{1F3FD}',
  // Zerlegtes Hangul: Anlaut + Vokal (+ Auslaut) sind EINE Silbe (UAX #29,
  // GB6-GB8), auch gemischt mit einer fertigen Silbe.
  NFD_KIM_MINSU, '한글'.normalize('NFD'), '\u1100\uAC00\u11A8', '\uAC00\u1161', '\uAC01\u1161',
  `${KEYCAP_1}${KEYCAP_2}`,
  // #1464: Tag-Zeichen (Flaggen von England, Schottland, Wales), halbbreite
  // Katakana mit Truebungszeichen, U+200C zwischen zwei arabischen Initialen.
  `${ENGLAND}A`, 'ﾔﾏﾀﾞ', 'ﾊﾟﾊﾟ', 'م\u200Cع',
];

test('die Regel: Name -> Zeichen auf der Scheibe', () => {
  for (const [name, expected, why] of TABLE) {
    assert.equal(initials(name), expected, `${JSON.stringify(name)}: ${why}`);
  }
});

test('ein leerer Name ergibt den Rueckfall des Aufrufers', () => {
  for (const empty of ['', '   ', '\t\n', null, undefined]) {
    assert.equal(initials(empty), '', `${JSON.stringify(empty)} ohne Rueckfall: leer`);
    assert.equal(initials(empty, '?'), '?', `${JSON.stringify(empty)} mit Rueckfall`);
  }
  assert.equal(initials('Anna', '?'), 'A', 'ein Name schlaegt den Rueckfall');
});

test('ohne Intl.Segmenter gilt dieselbe Tabelle', () => {
  const descriptor = Object.getOwnPropertyDescriptor(Intl, 'Segmenter');
  assert.ok(descriptor, 'diese Node-Version hat Intl.Segmenter - sonst misst der Test nichts');
  Object.defineProperty(Intl, 'Segmenter', { value: undefined, configurable: true, writable: true });
  try {
    assert.deepEqual(graphemes(`a${E_ACUTE}${FAMILY}${FLAG}\u{1F984}`), ['a', E_ACUTE, FAMILY, FLAG, '\u{1F984}']);
    for (const [name, expected, why] of TABLE) {
      assert.equal(initials(name), expected, `${JSON.stringify(name)}: ${why}`);
    }
    assert.equal(compactInitials(NFD_KIM_MINSU), NFD_SU, 'die kleine Scheibe zeigt die Silbe, nicht ihren Vokal');
    // DER RUECKFALL IST EINE ABKUERZUNG, also misst er sich am Original: fuer
    // Namen in den Schriften der App-Sprachen muss er dieselben Grapheme
    // liefern wie der Segmenter (Review zu #1637: ohne die Virama-Regel wurde
    // aus श्रुति ein श mit sichtbarem Halant).
    const real = new descriptor.value(undefined, { granularity: 'grapheme' });
    for (const name of NAMES_BY_SCRIPT) {
      assert.deepEqual(graphemes(name), Array.from(real.segment(name), (part) => part.segment), name);
    }
  } finally {
    Object.defineProperty(Intl, 'Segmenter', descriptor);
  }
  assert.equal(typeof Intl.Segmenter, 'function', 'der Segmenter ist zurueck');
});

test('die kleine Scheibe: zwei Geviert-Zeichen werden zu einem, lateinische bleiben', () => {
  assert.equal(compactInitials('김민수'), '수');
  assert.equal(compactInitials('田中太郎'), '郎');
  assert.equal(compactInitials('김 민수'), '수', 'mit Leerraum dasselbe Zeichen wie ohne');
  // Nur ZWEI Geviert-Zeichen werden zu einem. Ein gemischtes Paar ist nicht
  // breiter als zwei breite lateinische Buchstaben, und das erste Zeichen zu
  // streichen naehme ihm die Haelfte seiner Aussage (Review zu #1637).
  assert.equal(compactInitials('김 Smith'), '김S');
  assert.equal(compactInitials('Minsu 김'), 'M김');
  assert.equal(compactInitials('\u{1F984} Einhorn'), '\u{1F984}E');
  assert.equal(compactInitials('\u{1F984} \u{1F431}'), '\u{1F431}', 'zwei Emoji sind zwei Geviert-Zeichen');
  // Eine Tastenkappe ist ein Emoji, ihr erstes Zeichen aber eine Ziffer - an
  // ihr erkennt man die Breite nicht (Review zu #1637).
  assert.equal(compactInitials(`${KEYCAP_1} ${KEYCAP_2}`), KEYCAP_2, 'zwei Tastenkappen sind zwei Geviert-Zeichen');
  assert.equal(compactInitials(`${KEYCAP_1} Eins`), `${KEYCAP_1}E`);
  assert.equal(compactInitials('1 2'), '12', 'zwei Ziffern ohne Tastenkappe bleiben');
  // Zerlegtes Hangul: das letzte ZEICHEN ist die ganze Silbe, nicht ihr Vokal.
  assert.equal(compactInitials(NFD_KIM_MINSU), NFD_SU);
  assert.equal(compactInitials('김'), '김');
  assert.equal(compactInitials('Anna Schmidt'), 'AS');
  assert.equal(compactInitials('Anna'), 'A');
  assert.equal(compactInitials('', '?'), '?');
  // Halbbreite Katakana sind ein halbes Geviert breit: zwei passen (#1464).
  assert.equal(compactInitials('ﾔﾏﾀﾞ'), 'ﾏﾀﾞ', 'halbbreit: beide Zeichen bleiben');
  assert.equal(compactInitials('ヤマダ'), 'ダ', 'vollbreit: eines');
  // Geschwister mit demselben Familiennamen bleiben auch dort verschieden.
  assert.notEqual(compactInitials('김민수'), compactInitials('김민지'));
});

// --------------------------------------------------------
// 2. Es gibt nur diesen einen
// --------------------------------------------------------

const RULES = [
  // Definition: etwas, das `initials` heisst und eine Funktion ist.
  // (`[iI]nitials` ohne i-Flag: `initialSubject` und `initialSub` sind etwas
  // anderes und sollen es bleiben.)
  ['definiert eine Funktion', /\bfunction\s+\w*[iI]nitials\w*\s*\(/],
  ['definiert eine Funktion', /\b\w*[iI]nitials\w*\s*[:=]\s*(?:async\s+)?(?:function\b|\([^)]*\)\s*=>|\w+\s*=>)/],
  // Definition: eine Variable dieses Namens, die NICHT aus dem Helfer kommt.
  ['berechnet Initialen selbst', /\b(?:const|let|var)\s+\w*[iI]nitials\w*\s*=(?!\s*(?:compactInitials|initials)\()/],
  // Form: das erste Zeichen je Wort.
  ['nimmt das erste Zeichen je Wort', /\.map\(\s*\(?\s*(\w+)\s*\)?\s*=>\s*\1\s*(?:\?\.)?(?:\[0\]|\.charAt\(0\)|\.at\(0\))/],
  ['nimmt das erste Zeichen eines Worts', /\[(?:0|\w+\.length\s*-\s*1)\]\s*(?:\?\.)?\[0\]/],
  // Form: zwei Zeichen, gross.
  ['schneidet zwei Zeichen und macht sie gross', /\.(?:slice|substring|substr)\(0,\s*2\)\s*(?:\.join\([^)]*\)\s*)?\.to(?:Locale)?UpperCase\(/],
  ['schneidet zwei Zeichen und macht sie gross', /\.to(?:Locale)?UpperCase\(\)\s*\.(?:slice|substring|substr)\(0,\s*2\)/],
];

function findLocalRules(source) {
  const hits = [];
  for (const [why, pattern] of RULES) {
    const global = new RegExp(pattern.source, `${pattern.flags.replace('g', '')}g`);
    for (const match of source.matchAll(global)) {
      hits.push({ why, line: source.slice(0, match.index).split('\n').length, text: match[0] });
    }
  }
  return hits;
}

// Die Kopien aus v2.71, woertlich. Jede muss dem Detektor auffallen - sonst
// ist er fuer genau die Form blind, die es schon einmal gab.
const FORMER_COPIES = {
  'router.js (accountInitials)': "function accountInitials(name) {\n  return String(name || '').trim().split(/\\s+/).map((w) => w[0] ?? '').join('').toUpperCase().slice(0, 2);\n}",
  'settings/pages/admin-family.js, admin-permissions.js': "function initials(name) {\n  if (!name) return '?';\n  return name.split(' ').map((w) => w[0]).slice(0, 2).join('').toUpperCase();\n}",
  'settings/pages/personal-account.js': "function initials(name) {\n  if (!name) return '?';\n  return name\n    .split(' ')\n    .map((part) => part[0])\n    .slice(0, 2)\n    .join('')\n    .toUpperCase();\n}",
  'pages/birthdays.js': "function initials(name) {\n  return String(name || '')\n    .split(/\\s+/)\n    .filter(Boolean)\n    .slice(0, 2)\n    .map((part) => part[0]?.toUpperCase() || '')\n    .join('') || '?';\n}",
  'pages/tasks.js, dashboard.js, housekeeping.js': "function initials(name = '') {\n  return name.split(' ').map((w) => w[0]).join('').slice(0, 2).toUpperCase();\n}",
  'pages/rewards.js': "function initials(name = '') {\n  return name.split(' ').filter(Boolean).map((p) => p[0]).join('').slice(0, 2).toUpperCase() || '?';\n}",
  'pages/contacts.js': "function initials(name) {\n  const parts = String(name || '').trim().split(/\\s+/).filter(Boolean);\n  if (!parts.length) return '?';\n  const first = parts[0][0] || '';\n  const last  = parts.length > 1 ? parts[parts.length - 1][0] : '';\n  return (first + last).toUpperCase();\n}",
  'pages/calendar.js (personInitials)': "function personInitials(name) {\n  return String(name ?? '')\n    .split(' ')\n    .map((w) => w[0] ?? '')\n    .join('')\n    .toUpperCase()\n    .slice(0, 2);\n}",
  'pages/schedule.js': "  const initials = (name ?? '').split(' ').map((w) => w[0] ?? '').join('').toUpperCase().slice(0, 2);",
  'utils/seal-pair.js': "  const initials = name.split(/\\s+/).map((w) => w[0] ?? '').join('').toUpperCase().slice(0, 2);",
  'components/user-multi-select.js (zweimal)': "    const initials = (u.display_name ?? '')\n      .split(' ')\n      .map((w) => w[0] ?? '')\n      .join('')\n      .toUpperCase()\n      .slice(0, 2);",
};

// Dieselben Regeln OHNE den verraeterischen Namen: nur die Form bleibt.
const RENAMED = (source) => source.replace(/\b\w*initials\w*\b/gi, 'kuerzel');

test('der Detektor sieht jede der frueheren Kopien, am Namen und an der Form', () => {
  for (const [where, source] of Object.entries(FORMER_COPIES)) {
    assert.ok(findLocalRules(source).length > 0, `${where}: die Kopie faellt auf`);
    assert.ok(findLocalRules(RENAMED(source)).length > 0, `${where}: auch unter anderem Namen, an der Form`);
  }
});

test('der Detektor laesst den Aufruf des Helfers durch', () => {
  for (const ok of [
    "import { initials } from '/utils/initials.js';",
    "const text = fits ? initials(u.display_name) : compactInitials(u.display_name);",
    "const memberInitials = initials(m.display_name, '?');",
    "swatchLabel: initials(u.display_name),",
    "avatar.textContent = initials(displayName);",
    '// Ohne Bild und ohne Namen stand hier das "?" aus initials() - es las sich',
  ]) {
    assert.deepEqual(findLocalRules(ok), [], ok);
  }
});

// KEINE PERSONEN-INITIALEN, und darum hier ausgenommen: das Kuerzel eines
// Abos ohne Logo sind die ersten zwei Buchstaben des DIENSTES ("NE" fuer
// Netflix). Die Namensregel waere dort falsch - ein Dienst hat keinen
// Rufnamen. Ausgenommen ist die Datei fuer GENAU diese Form, nicht ganz.
const NOT_A_PERSON = {
  'pages/subscriptions.js': 'schneidet zwei Zeichen und macht sie gross',
};

function publicScripts(dir = '') {
  return readdirSync(new URL(dir, PUBLIC), { withFileTypes: true }).flatMap((entry) => {
    const rel = `${dir}${entry.name}`;
    if (entry.isDirectory()) return rel === 'vendor' ? [] : publicScripts(`${rel}/`);
    return /\.(?:js|mjs|html)$/.test(entry.name) ? [rel] : [];
  });
}

test('unter public/ steht keine eigene Initialen-Regel mehr', () => {
  const files = publicScripts();
  assert.ok(files.includes('pages/tasks.js') && files.includes('router.js'), 'der Lauf sieht Seiten und Router');
  assert.ok(files.length > 100, `der Lauf sieht den ganzen Baum (${files.length} Dateien)`);

  const found = [];
  for (const rel of files) {
    if (rel === 'utils/initials.js') continue;
    for (const hit of findLocalRules(read(rel))) {
      if (NOT_A_PERSON[rel] === hit.why) continue;
      found.push(`${rel}:${hit.line} ${hit.why}: ${hit.text.replace(/\s+/g, ' ')}`);
    }
  }
  assert.deepEqual(found, [], 'Initialen kommen aus /utils/initials.js - siehe den Kopf jener Datei');

  // Die Ausnahme darf nicht veralten: gibt es die Form dort nicht mehr, faellt sie weg.
  for (const [rel, why] of Object.entries(NOT_A_PERSON)) {
    assert.ok(findLocalRules(read(rel)).some((hit) => hit.why === why), `${rel}: die Ausnahme hat noch einen Grund`);
  }
});

// --------------------------------------------------------
// 3. Jeder Aufrufer
// --------------------------------------------------------

const MINSU = '김민수';
const SHOWS = (html, text) => new RegExp(`>\\s*${text}\\s*<`).test(html);
const assertShows = (html, text, where) => {
  assert.equal(typeof html, 'string', `${where}: Markup`);
  assert.ok(SHOWS(html, text), `${where}: zeigt ${text}\n${html.slice(0, 600)}`);
  assert.ok(!SHOWS(html, '김'), `${where}: nicht mehr nur den Familiennamen`);
};

test('Avatar-Stapel und Personenauswahl (components/user-multi-select.js)', async () => {
  const ums = await import('../public/components/user-multi-select.js');
  const user = { id: 1, display_name: MINSU, color: '#34C759', avatar_color: '#34C759' };

  assertShows(ums.renderAvatarStack([user], { size: 28 }), '민수', 'Stapel 28px');
  assertShows(ums.renderUserMultiSelect([user], [], 'assignees', 'tasks.assignedTo'), '민수', 'Auswahl');
  assertShows(ums.renderAvatarStack([{ ...user, display_name: 'Anna Maria Schmidt' }], { size: 22 }), 'AS', 'Stapel lateinisch');
  assert.ok(SHOWS(ums.renderAvatarStack([{ ...user, display_name: '김 Smith' }], { size: 22 }), '김S'), 'Stapel gemischt: beide Zeichen bleiben');
  assertShows(ums.renderAvatarStack([{ ...user, display_name: '김 민수' }], { size: 28 }), '민수', 'Stapel: mit Leerraum wie ohne');

  // Die Passrechnung: der Rand (2px je Seite) zaehlt in die Scheibe.
  const css = read('styles/user-multi-select.css');
  assert.match(css, /\.avatar-stack__item \{[^}]*border: 2px solid/, 'der Rand, mit dem der Stapel rechnet');
  for (const size of [20, 22, 24]) {
    const html = ums.renderAvatarStack([user], { size });
    assertShows(html, '수', `Stapel ${size}px: ein Zeichen, zwei passen nicht`);
    const font = Number(/font-size:(\d+)px/.exec(html)[1]);
    assert.ok(2 * font > size - 4, `Stapel ${size}px: zwei Geviert-Zeichen (${2 * font}px) passten wirklich nicht`);
  }
  const wide = ums.renderAvatarStack([user], { size: 28 });
  assert.ok(2 * Number(/font-size:(\d+)px/.exec(wide)[1]) <= 28 - 4, 'Stapel 28px: zwei Geviert-Zeichen passen');
  assert.ok(!SHOWS(ums.renderAvatarStack([user], { size: 16 }), '수'), 'unter 20px bleibt die Scheibe ohne Text');
});

test('Ueberlappungszeichen (utils/seal-pair.js)', async () => {
  const { isSoloHousehold } = await import('../public/utils/household.js');
  const { whoMark } = await import('../public/utils/seal-pair.js');
  assert.equal(isSoloHousehold(), false, 'ohne gezaehlten Haushalt erscheint das Zeichen');
  // 20px breit, neben dem kleinen Siegel 16px, bei 10px Schrift: ein Zeichen.
  assertShows(whoMark({ display_name: MINSU, avatar_color: '#34C759' }), '수', 'Siegel-Avatar');
  assert.ok(SHOWS(whoMark({ display_name: 'Anna Maria Schmidt' }), 'AS'), 'lateinisch: zwei Buchstaben');
});

test('Kontozeile der Seitenleiste (router.js)', () => {
  // router.js laesst sich hier nicht laden (der Loader stubt seine Nachbarn),
  // also laeuft die Funktion selbst: ihr Quelltext, mit dem ECHTEN Helfer.
  const router = read('router.js');
  assert.match(router, /^import \{ initials \} from '\/utils\/initials\.js';$/m, 'der Router laedt den Helfer');
  const start = router.indexOf('function syncSidebarAccount(');
  const end = router.indexOf('\n}\n', start);
  assert.ok(start > 0 && end > start);
  const source = router.slice(start, end + 2);

  const node = () => ({
    textContent: '', style: {}, dataset: {},
    classList: { toggle() {} }, setAttribute() {}, replaceChildren() {},
    querySelector() { return null; }, querySelectorAll() { return []; },
  });
  const avatar = node();
  const parts = {
    '.nav-sidebar__account-trigger': node(), '.nav-sidebar__avatar': avatar, '.nav-sidebar__account-name': node(),
  };
  const root = { querySelector: (sel) => parts[sel], querySelectorAll: () => [] };
  // Der Nutzer steht im geteilten Zustand des Routers (`routerState`, #1657).
  const run = (currentUser) => new Function(
    'routerState', 'initials', 'prefersInkText', 't', 'withUpdateHint', 'pendingUpdateVersion', 'document',
    `${source}\nreturn syncSidebarAccount;`,
  )({ currentUser }, initials, () => false, (key) => key, (label) => label, () => null, { querySelector: () => null })(root);

  run({ display_name: MINSU });
  assert.equal(avatar.textContent, '민수');
  run({ display_name: 'Anna Maria Schmidt' });
  assert.equal(avatar.textContent, 'AS');
});

test('Einstellungen: Familie, Konto und Rechte', async () => {
  const family = await import('../public/settings/pages/admin-family.js');
  const account = await import('../public/settings/pages/personal-account.js');
  const permissions = await import('../public/settings/pages/admin-permissions.js');
  const user = { id: 1, display_name: MINSU, avatar_color: '#34C759' };

  assertShows(family.__test.avatarHtml(user), '민수', 'Familie');
  assertShows(account.__test.avatarHtml(user), '민수', 'Konto');
  assertShows(permissions.memberChipHtml(user), '민수', 'Rechte');
  assert.ok(SHOWS(family.__test.avatarHtml({}), '\\?'), 'Familie ohne Namen: ?');
  assert.ok(SHOWS(account.__test.avatarHtml(null), '\\?'), 'Konto ohne Namen: ?');
  assert.ok(SHOWS(permissions.memberChipHtml({ id: 2, display_name: '' }), '\\?'), 'Rechte ohne Namen: ?');
});

test('Kalender: die Scheibe im Filterblatt', async () => {
  const { __test: calendar } = await import('../public/pages/calendar.js');
  const html = calendar.personFilterRowsHtml([{ id: 1, display_name: MINSU, avatar_color: '#34C759' }]);
  assertShows(html, '민수', 'Filterblatt');
});

test('Dienstplan: die Kopfzeile einer Spur', async () => {
  const { __test: schedule } = await import('../public/pages/schedule.js');
  const state = schedule.scheduleState();
  const before = state.users;
  state.users = [{ id: 5, display_name: MINSU }];
  try {
    assertShows(schedule.overviewLaneHeader(5), '민수', 'Spur');
  } finally {
    state.users = before;
  }
});

test('Kontakte: ein verknuepftes Haushaltsmitglied', async () => {
  const { __test: contacts } = await import('../public/pages/contacts.js');
  const html = contacts.renderContactItem({
    id: 1, name: MINSU, category: 'family', family_user_id: 5, family_display_name: MINSU, family_avatar_color: '#34C759',
  });
  assertShows(html, '민수', 'Kontaktzeile');
  // Erstes und letztes Wort - die Regel, die die Kontakte schon hatten und die
  // jetzt ueberall gilt.
  const latin = contacts.renderContactItem({
    id: 2, name: 'Anna Maria Schmidt', category: 'family', family_user_id: 6, family_display_name: 'Anna Maria Schmidt',
  });
  assert.ok(SHOWS(latin, 'AS'), 'drei Woerter: das erste und das letzte, wie ueberall');
});

test('Geburtstage: Zeile und Vorschau', async () => {
  const { __test: birthdays } = await import('../public/pages/birthdays.js');
  const row = {
    id: 9, name: MINSU, birth_date: '1990-10-06', next_birthday: '2026-10-06', next_age: 36, days_until: 10,
  };
  assertShows(birthdays.birthdayItemHtml(row), '민수', 'Zeile ohne Verknuepfung');
  assertShows(birthdays.birthdayItemHtml({ ...row, family_user_id: 5, family_display_name: MINSU }), '민수', 'Zeile eines Mitglieds');
  assertShows(birthdays.birthdayPreviewHtml(MINSU, null), '민수', 'Vorschau');
});

test('Belohnungen: die Punktestandszeile', async () => {
  const { __test: rewards } = await import('../public/pages/rewards.js');
  const s = rewards.state;
  const before = { user: s.user, overview: s.overview, catalog: s.catalog, redemptions: s.redemptions, prevBalances: s.prevBalances };
  const member = { id: 3, display_name: MINSU, avatar_color: '#34C759', balance: 20 };
  try {
    s.user = { role: 'admin' };
    s.overview = { me: 1, balances: [member] };
    s.catalog = [];
    s.redemptions = [];
    s.prevBalances = new Map();
    assertShows(rewards.renderStandingRow(member), '민수', 'Punktestand');
  } finally {
    Object.assign(s, before);
  }
});

test('Hauspersonal: die Zeile einer Kraft', async () => {
  const { __test: hk } = await import('../public/pages/housekeeping.js');
  const state = hk.state();
  const before = state.workers;
  state.workers = [{ id: 7, display_name: MINSU, current_session: null, today_session: null }];
  try {
    assertShows(hk.renderWorkerSummary(), '민수', 'Kraft');
  } finally {
    state.workers = before;
  }
});

test('Uebersicht: Familie, Geburtstage, Dienstplan, Belohnungen und Wandansicht', async () => {
  const { __test: dashboard, renderUpcomingBirthdays } = await import('../public/pages/dashboard.js');
  const user = { id: 1, display_name: MINSU, avatar_color: '#34C759' };

  assertShows(dashboard.renderFamilyWidget([user, { id: 2, display_name: 'Anna Maria Schmidt' }], { upcomingEvents: [] }), '민수', 'Familie');
  assertShows(renderUpcomingBirthdays([{ id: 1, name: MINSU, days_until: 3, next_birthday: '2026-10-06', next_age: 9 }], '1x2'), '민수', 'Geburtstage');

  const type = { id: 1, name: 'Frueh', short_code: 'F', color: '#6C3AED' };
  const schedule = { hasTypes: true, entries: [{ user_id: 1, shift_type: type }] };
  assertShows(dashboard.renderScheduleWidget(schedule, [user], '1x2'), '민수', 'Dienstplan');

  const rewards = dashboard.renderRewardsWidget({
    view: 'household', me: 99, standings: [{ id: 1, display_name: MINSU, avatar_color: '#34C759', balance: 10 }],
    catalog: [], recent: [],
  }, '2x2');
  assertShows(rewards, '민수', 'Belohnungen');

  const wall = dashboard.renderWallWho({ users: [user] }, { allRows: [{ who: { id: 1 } }] });
  assertShows(wall, '민수', 'Wandansicht');
});

// --------------------------------------------------------
// 4. Gleiche Initialen im Haushalt (#1464)
// --------------------------------------------------------

const LINDA = 'Linda Johnson';
const LEO = 'Leo Johnson';
const resolved = (names) => Object.fromEntries(resolveInitials(names));

function permutations(list) {
  if (list.length < 2) return [list];
  return list.flatMap((item, i) => permutations([...list.slice(0, i), ...list.slice(i + 1)]).map((rest) => [item, ...rest]));
}

test('gleiche Initialen: der zweite Buchstabe des Vornamens unterscheidet', () => {
  assert.equal(initials(LINDA), 'LJ', 'Vorbedingung: ohne Haushalt tragen beide LJ');
  assert.equal(initials(LEO), 'LJ');
  assert.deepEqual(resolved([LINDA, LEO, 'Anna Schmidt']), { [LINDA]: 'LI', [LEO]: 'LE', 'Anna Schmidt': 'AS' });
});

test('gleiche Initialen: die Tabelle der Regel', () => {
  for (const [names, expected, why] of [
    [['Anna Schmidt', 'Ben Vogt'], { 'Anna Schmidt': 'AS', 'Ben Vogt': 'BV' }, 'ohne Kollision bleibt alles'],
    [[LINDA, LEO, 'Lars Johnson'], { [LINDA]: 'LI', [LEO]: 'LE', 'Lars Johnson': 'LA' }, 'drei mit LJ'],
    [[LINDA, 'Lisa Johnson', LEO], { [LEO]: 'LE', [LINDA]: 'LI', 'Lisa Johnson': 'LS' },
      'LI ist nach Linda vergeben (Namensfolge): Lisa nimmt ihren naechsten Buchstaben'],
    [[LINDA, LEO, 'Lisa Imhof'], { [LINDA]: 'LN', [LEO]: 'LE', 'Lisa Imhof': 'LI' },
      'LI gehoert schon jemandem ohne Kollision - die behaelt es, Linda weicht aus'],
    [['Leo Johnson', 'Leo Jansen'], { 'Leo Jansen': 'LE', 'Leo Johnson': 'LO' }, 'derselbe Vorname: der naechste freie Buchstabe'],
    [['Jo Lang', 'Jo Lenz'], { 'Jo Lang': 'JO', 'Jo Lenz': 'JE' }, 'der Vorname ist aufgebraucht: der Familienname ab dem zweiten Buchstaben'],
    [['Linda', 'Leo'], { Linda: 'LI', Leo: 'LE' }, 'ein Wort: L und L'],
    [['Linda', 'Leo Johnson'], { Linda: 'L', 'Leo Johnson': 'LJ' }, 'L und LJ sind schon verschieden'],
    [['ßeta Schmidt', 'Sven Schmidt'], { 'ßeta Schmidt': 'SE', 'Sven Schmidt': 'SV' }, 'ß zaehlt als ein Zeichen'],
    [["D'Arcy Lee", 'Dora Lee'], { "D'Arcy Lee": 'DA', 'Dora Lee': 'DO' }, 'ein Apostroph ist kein zweiter Buchstabe'],
    [['김민수', '박민수'], { 김민수: '김수', 박민수: '박수' }, 'Hangul: Familienname + letztes Zeichen des Rufnamens'],
    [['田中 太郎', '山田太郎'], { '田中 太郎': '田郎', 山田太郎: '山郎' }, 'Han, mit und ohne Leerraum'],
    [['محمد علي', 'مريم علي'], { 'محمد علي': 'م‌ح', 'مريم علي': 'م‌ر' }, 'Arabisch'],
    [['Ab Cd', 'AB CD'], { 'AB CD': 'AB', 'Ab Cd': 'AD' }, 'nur Gross und Klein verschieden: auch die werden unterscheidbar'],
    [['Al Jo', 'Alf Jo'], { 'Al Jo': 'AL', 'Alf Jo': 'AF' }, 'ein Name im anderen enthalten'],
    [['A B', 'a b'], { 'A B': 'AB', 'a b': 'AB' }, 'kein Buchstabe mehr frei: beide behalten ihre Zeichen'],
    [[LINDA, LINDA, ' Linda  Johnson '], { [LINDA]: 'LJ' }, 'derselbe Name zweimal ist keine Kollision'],
    [[LINDA, '', null, undefined, '  '], { [LINDA]: 'LJ' }, 'leere Namen zaehlen nicht'],
  ]) {
    assert.deepEqual(resolved(names), expected, why);
  }
});

test('gleiche Initialen: hoechstens zwei Zeichen, und jedes Ergebnis nur einmal', () => {
  const household = [LINDA, LEO, 'Lisa Imhof', 'Lars Jensen', 'Leo Jansen', 'Anna Schmidt', 'Arne Sommer', '김민수', '박민수', 'ßeta Schmidt'];
  const map = resolveInitials(household);
  assert.equal(map.size, household.length);
  for (const [name, text] of map) {
    assert.ok(graphemes(text).length <= 2, `${name}: ${text} passt in zwei Zeichen`);
  }
  assert.equal(new Set(map.values()).size, map.size, `jeder traegt eigene Zeichen: ${JSON.stringify([...map])}`);
});

test('gleiche Initialen: die Reihenfolge der Liste aendert nichts', () => {
  const household = [LINDA, LEO, 'Lisa Imhof', 'Lars Jensen', 'Anna Schmidt', 'Arne Sommer'];
  const expected = resolved(household);
  const all = permutations(household);
  assert.equal(all.length, 720);
  for (const order of all) assert.deepEqual(resolved(order), expected, order.join(', '));
});

test('der Haushalt gilt fuer JEDEN Aufruf des Helfers, und nur bis zum Abmelden', () => {
  try {
    setInitialsRoster([LINDA, LEO, 'Anna Schmidt']);
    assert.equal(initials(LINDA), 'LI');
    assert.equal(initials(LEO, '?'), 'LE');
    assert.equal(initials('  Linda   Johnson '), 'LI', 'Leerraum aendert die Person nicht');
    assert.equal(compactInitials(LINDA), 'LI', 'die kleine Scheibe traegt dieselben Zeichen');
    assert.equal(initials('Anna Schmidt'), 'AS', 'ohne Kollision bleibt alles');
    assert.equal(initials('Lars Jensen'), 'LJ', 'ein Name, der im Haushalt nicht steht, folgt der einfachen Regel');
    assert.equal(initials('', '?'), '?');

    // Eine Antwort OHNE Liste (aelterer Server waehrend eines Updates) setzt
    // nicht zurueck - sonst sprangen die Zeichen fuer einen Seitenaufruf um.
    setInitialsRoster(undefined);
    setInitialsRoster(null);
    assert.equal(initials(LINDA), 'LI');

    // Wird ein Konto GELOESCHT, faellt es aus der Liste; ein deaktiviertes
    // bleibt darin (server/auth.js, test:household-members).
    setInitialsRoster([LINDA, 'Anna Schmidt']);
    assert.equal(initials(LINDA), 'LJ');

    // Die kleine Scheibe zeigt von zwei Geviert-Zeichen eines. Bei einer
    // Ausweichform ist das letzte gerade das gemeinsame - dann das erste.
    setInitialsRoster(['김민수', '박민수', '이지수']);
    assert.equal(initials('김민수'), '김수');
    assert.equal(compactInitials('김민수'), '김');
    assert.equal(compactInitials('박민수'), '박');
    assert.equal(compactInitials('이지수'), '수', 'ohne Kollision bleibt es beim letzten Zeichen');

    setInitialsRoster([LINDA, LEO]);
    clearInitialsRoster();
    assert.equal(initials(LINDA), 'LJ', 'nach dem Abmelden gilt der Haushalt nicht mehr');
  } finally {
    clearInitialsRoster();
  }
});

test('mit Haushalt: JEDER Aufrufer zeigt fuer Linda LI und fuer Leo LE', async () => {
  const ums = await import('../public/components/user-multi-select.js');
  const { whoMark } = await import('../public/utils/seal-pair.js');
  const family = await import('../public/settings/pages/admin-family.js');
  const account = await import('../public/settings/pages/personal-account.js');
  const permissions = await import('../public/settings/pages/admin-permissions.js');
  const { __test: calendar } = await import('../public/pages/calendar.js');
  const { __test: schedule } = await import('../public/pages/schedule.js');
  const { __test: contacts } = await import('../public/pages/contacts.js');
  const { __test: birthdays } = await import('../public/pages/birthdays.js');
  const { __test: rewards } = await import('../public/pages/rewards.js');
  const { __test: hk } = await import('../public/pages/housekeeping.js');
  const { __test: dashboard, renderUpcomingBirthdays } = await import('../public/pages/dashboard.js');

  const withState = (state, patch, run) => {
    const before = Object.fromEntries(Object.keys(patch).map((key) => [key, state[key]]));
    Object.assign(state, patch);
    try { return run(); } finally { Object.assign(state, before); }
  };
  const person = (name) => ({ id: 1, display_name: name, color: '#34C759', avatar_color: '#34C759' });
  const shift = { id: 1, name: 'Frueh', short_code: 'F', color: '#6C3AED' };

  const CALLERS = {
    'Stapel 28px': (name) => ums.renderAvatarStack([person(name)], { size: 28 }),
    'Stapel 22px': (name) => ums.renderAvatarStack([person(name)], { size: 22 }),
    Personenauswahl: (name) => ums.renderUserMultiSelect([person(name)], [], 'assignees', 'tasks.assignedTo'),
    'Siegel-Avatar': (name) => whoMark(person(name)),
    'Einstellungen Familie': (name) => family.__test.avatarHtml(person(name)),
    'Einstellungen Konto': (name) => account.__test.avatarHtml(person(name)),
    'Einstellungen Rechte': (name) => permissions.memberChipHtml(person(name)),
    'Kalender Filterblatt': (name) => calendar.personFilterRowsHtml([person(name)]),
    'Dienstplan Spur': (name) => withState(schedule.scheduleState(), { users: [{ id: 5, display_name: name }] },
      () => schedule.overviewLaneHeader(5)),
    Kontaktzeile: (name) => contacts.renderContactItem({
      id: 1, name, category: 'family', family_user_id: 5, family_display_name: name, family_avatar_color: '#34C759',
    }),
    Geburtstagszeile: (name) => birthdays.birthdayItemHtml({
      id: 9, name, birth_date: '1990-10-06', next_birthday: '2026-10-06', next_age: 36, days_until: 10,
      family_user_id: 5, family_display_name: name,
    }),
    Geburtstagsvorschau: (name) => birthdays.birthdayPreviewHtml(name, null),
    'Belohnungen Punktestand': (name) => {
      const member = { id: 3, display_name: name, avatar_color: '#34C759', balance: 20 };
      return withState(rewards.state, {
        user: { role: 'admin' }, overview: { me: 1, balances: [member] }, catalog: [], redemptions: [], prevBalances: new Map(),
      }, () => rewards.renderStandingRow(member));
    },
    Hauspersonal: (name) => withState(hk.state(), {
      workers: [{ id: 7, display_name: name, current_session: null, today_session: null }],
    }, () => hk.renderWorkerSummary()),
    'Uebersicht Familie': (name) => dashboard.renderFamilyWidget([person(name), { id: 2, display_name: 'Anna Schmidt' }], { upcomingEvents: [] }),
    'Uebersicht Geburtstage': (name) => renderUpcomingBirthdays([{ id: 1, name, days_until: 3, next_birthday: '2026-10-06', next_age: 9 }], '1x2'),
    'Uebersicht Dienstplan': (name) => dashboard.renderScheduleWidget({ hasTypes: true, entries: [{ user_id: 1, shift_type: shift }] }, [person(name)], '1x2'),
    'Uebersicht Belohnungen': (name) => dashboard.renderRewardsWidget({
      view: 'household', me: 99, standings: [{ id: 1, display_name: name, avatar_color: '#34C759', balance: 10 }], catalog: [], recent: [],
    }, '2x2'),
    'Uebersicht Wandansicht': (name) => dashboard.renderWallWho({ users: [person(name)] }, { allRows: [{ who: { id: 1 } }] }),
  };

  // Die Kontozeile der Seitenleiste: derselbe Weg wie im Test weiter oben.
  const router = read('router.js');
  const start = router.indexOf('function syncSidebarAccount(');
  const source = router.slice(start, router.indexOf('\n}\n', start) + 2);
  const node = () => ({
    textContent: '', style: {}, dataset: {}, classList: { toggle() {} }, setAttribute() {}, replaceChildren() {},
    querySelector() { return null; }, querySelectorAll() { return []; },
  });
  CALLERS['Seitenleiste Kontozeile'] = (name) => {
    const avatar = node();
    const parts = { '.nav-sidebar__account-trigger': node(), '.nav-sidebar__avatar': avatar, '.nav-sidebar__account-name': node() };
    // Der Nutzer steht im geteilten Zustand des Routers (`routerState`, #1657).
    new Function(
      'routerState', 'initials', 'prefersInkText', 't', 'withUpdateHint', 'pendingUpdateVersion', 'document',
      `${source}\nreturn syncSidebarAccount;`,
    )({ currentUser: { display_name: name } }, initials, () => false, (key) => key, (label) => label, () => null, { querySelector: () => null })(
      { querySelector: (sel) => parts[sel], querySelectorAll: () => [] },
    );
    return `<span>${avatar.textContent}</span>`;
  };

  // Positivkontrolle: OHNE Haushalt zeigt jeder Aufrufer LJ - sonst traefe
  // `>LI<` unten vielleicht etwas anderes als die Scheibe.
  for (const [where, render] of Object.entries(CALLERS)) {
    assert.ok(SHOWS(render(LINDA), 'LJ'), `${where}: ohne Haushalt LJ\n${String(render(LINDA)).slice(0, 400)}`);
  }

  try {
    setInitialsRoster([LINDA, LEO, 'Anna Schmidt']);
    for (const [where, render] of Object.entries(CALLERS)) {
      for (const [name, text] of [[LINDA, 'LI'], [LEO, 'LE'], ['Anna Schmidt', 'AS']]) {
        const html = render(name);
        assert.ok(SHOWS(html, text), `${where}: ${name} zeigt ${text}\n${String(html).slice(0, 400)}`);
        assert.ok(!SHOWS(html, 'LJ'), `${where}: ${name} zeigt nicht mehr LJ`);
      }
    }
  } finally {
    clearInitialsRoster();
  }
});

// --------------------------------------------------------
// 5. Die kleine Scheibe in einer Kollisionsgruppe (Review zu #1690)
// --------------------------------------------------------

const compactOf = (names) => {
  try {
    setInitialsRoster(names);
    return Object.fromEntries(names.map((name) => [name, compactInitials(name)]));
  } finally {
    clearInitialsRoster();
  }
};

test('die kleine Scheibe unterscheidet in einer Kollisionsgruppe - am Zeichen, das verschieden ist', () => {
  // Wortregel mit drei Woertern: die Ausweichform ist 김진 / 김아, das ERSTE
  // Zeichen ist das gemeinsame. Die erste Fassung nahm es unbedingt.
  assert.deepEqual(compactOf(['김 민 수진', '김 민 수아']), { '김 민 수진': '진', '김 민 수아': '아' });
  // Ein Wort aus zwei Emoji: beide tragen 😀, die Ausweichform haengt das zweite an.
  assert.deepEqual(compactOf(['😀😺', '😀🐶']), { '😀😺': '😺', '😀🐶': '🐶' });
  // Dasselbe als zwei Woerter ist keine Kollision (😀😺 und 😀🐶 sind schon
  // verschieden) und folgt der Regel der kleinen Scheibe: das letzte Zeichen.
  assert.deepEqual(compactOf(['😀 😺', '😀 🐶']), { '😀 😺': '😺', '😀 🐶': '🐶' });
  // Namen nach Regel 2 und 3: dort unterscheidet das ERSTE Zeichen.
  assert.deepEqual(compactOf(['김민수', '박민수']), { 김민수: '김', 박민수: '박' });
  assert.deepEqual(compactOf(['田中 太郎', '山田太郎']), { '田中 太郎': '田', 山田太郎: '山' });
  // Keines der beiden Zeichen unterscheidet fuer sich allein alle drei: jede
  // bekommt eines, das in der Gruppe sonst niemand zeigt.
  const mixed = ['김민수', '민 가 수', '민 가 수아'];
  assert.deepEqual(resolved(mixed), { 김민수: '김수', '민 가 수': '민수', '민 가 수아': '민아' }, 'Vorbedingung: 수, 수, 아 und 김, 민, 민');
  const three = compactOf(mixed);
  assert.equal(new Set(Object.values(three)).size, 3, JSON.stringify(three));
  assert.equal(three['민 가 수아'], '아', 'wer mit dem letzten Zeichen auskommt, behaelt es');
  // DER BEKANNTE REST, keine Kollision der Initialen: 민수 und 지수 sind
  // verschieden, die kleine Scheibe zeigt von beiden das letzte Zeichen
  // (Regel aus #1637). Nur eine Kollisionsgruppe wird aufgeloest.
  assert.deepEqual(compactOf(['김민수', '이지수']), { 김민수: '수', 이지수: '수' });
});

test('die kleine Scheibe: jede aufloesbare Kollisionsgruppe ist auch dort aufgeloest', () => {
  const POOL = [
    '김민수', '박민수', '이민수', '김 민수', '김 민 수진', '김 민 수아', '박 민 수진', '김 가 나다', '김 가 나라', '박가나',
    '田中太郎', '山田太郎', '田中 太郎', '😀😺', '😀🐶', '😀', '😀 😺', '🐶😀', '이지수', '민수', LINDA, LEO, '김 Smith', '김 Sato', '민 가 수', '민 가 수아',
  ];
  const wide = (text) => {
    const chars = graphemes(text);
    return chars.length === 2 && chars.every((char) => compactInitials(char) === char && compactInitials(`${char} ${char}`) === char);
  };
  // Gibt es eine Zuordnung "je Person eines ihrer Zeichen", bei der alle
  // verschieden sind? Ausprobiert, nicht berechnet.
  const solvable = (fulls) => {
    const walk = (i, used) => i === fulls.length
      || graphemes(fulls[i]).some((char) => !used.has(char) && walk(i + 1, new Set([...used, char])));
    return walk(0, new Set());
  };

  let groups = 0;
  let changed = 0;
  let neitherSide = 0;
  const subsets = [];
  for (let a = 0; a < POOL.length; a += 1) {
    for (let b = a + 1; b < POOL.length; b += 1) {
      subsets.push([POOL[a], POOL[b]]);
      for (let c = b + 1; c < POOL.length; c += 1) subsets.push([POOL[a], POOL[b], POOL[c]]);
    }
  }
  for (const names of subsets) {
    const base = Object.fromEntries(names.map((name) => [name, initials(name)]));
    const full = resolved(names);
    const key = (name) => name.trim().split(/\s+/u).join(' ');
    const compact = compactOf(names);
    const byBase = new Map();
    for (const name of names) byBase.set(base[name], [...(byBase.get(base[name]) ?? []), name]);
    for (const group of byBase.values()) {
      if (group.length < 2) {
        // Ohne Kollision bleibt die Regel der kleinen Scheibe.
        assert.equal(compact[group[0]], compactInitials(group[0]), `${names.join(', ')}: ${group[0]} ohne Kollision`);
        continue;
      }
      const fulls = group.map((name) => full[key(name)]);
      const allWide = fulls.every(wide);
      if (!allWide || new Set(fulls).size !== fulls.length || !solvable(fulls)) continue;
      groups += 1;
      const shown = group.map((name) => compact[name]);
      if (group.some((name, i) => shown[i] !== graphemes(fulls[i])[1])) changed += 1;
      if ([0, 1].every((side) => new Set(fulls.map((text) => graphemes(text)[side])).size < fulls.length)) neitherSide += 1;
      assert.equal(new Set(shown).size, shown.length, `${names.join(', ')}: ${JSON.stringify(fulls)} -> ${JSON.stringify(shown)}`);
      group.forEach((name, i) => assert.ok(graphemes(fulls[i]).includes(shown[i]), `${name}: ${shown[i]} ist eines der Zeichen aus ${fulls[i]}`));
    }
  }
  assert.ok(groups > 50, `der Lauf sieht aufloesbare Gruppen (${groups})`);
  assert.ok(changed > 10, `und darunter solche, in denen das letzte Zeichen nicht reicht (${changed})`);
  assert.ok(neitherSide > 0, `und solche, in denen keine Seite fuer sich alle unterscheidet (${neitherSide})`);
});
