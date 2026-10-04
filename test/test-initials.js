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

const { initials, compactInitials, graphemes } = await import('../public/utils/initials.js');

const PUBLIC = new URL('../public/', import.meta.url);
const read = (rel) => readFileSync(new URL(rel, PUBLIC), 'utf8');

// --------------------------------------------------------
// 1. Die Regel
// --------------------------------------------------------

const E_ACUTE = 'e\u0301'; // e + kombinierender Akut: ein Graphem, zwei Codepoints
const FAMILY = '\u{1F469}\u200D\u{1F467}'; // Frau + ZWJ + Maedchen: ein Graphem
const FLAG = '\u{1F1F0}\u{1F1F7}'; // zwei Regional-Indikatoren: ein Graphem

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
  assert.equal(compactInitials('김'), '김');
  assert.equal(compactInitials('Anna Schmidt'), 'AS');
  assert.equal(compactInitials('Anna'), 'A');
  assert.equal(compactInitials('', '?'), '?');
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
  const run = (currentUser) => new Function(
    'currentUser', 'initials', 'prefersInkText', 't', 'withUpdateHint', 'pendingUpdateVersion', 'document',
    `${source}\nreturn syncSidebarAccount;`,
  )(currentUser, initials, () => false, (key) => key, (label) => label, () => null, { querySelector: () => null })(root);

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
