/**
 * Tests: koreanische Partikel hinter Platzhaltern (#1607)
 * Zweck: ko.json schreibt hinter einen Platzhalter die Doppelform der Partikel
 *        (`{{name}}이(가)`), weil die richtige Form vom letzten Laut des
 *        eingesetzten Werts abhaengt. Auf dem Schirm stand sie woertlich:
 *        "캘린더이(가)". t() loest sie jetzt auf - nur bei aktiver Sprache `ko`,
 *        nur an Stellen, die aus der Uebersetzung stammen, und nur, wenn das
 *        Zeichen davor eine Hangul-Silbe ist.
 *
 *        Drei Schichten:
 *        (1) Tabelle ueber den Helfer, je Partikel und je Art von Vorgaenger.
 *        (2) Die ECHTE t() mit echten ko.json-Schluesseln, dazu die Gegenprobe
 *            in einer anderen Sprache.
 *        (3) Guards ueber ko.json: jede Doppelform dort ist dem Aufloeser
 *            bekannt, und jede Form, die er kennt, kommt dort vor.
 * Ausführen: node --test test/test-i18n-ko-particles.js
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import {
  KOREAN_PARTICLE_FORMS,
  resolveKoreanParticles,
} from '../public/utils/korean-particles.js';

const LOCALE_DIR = new URL('../public/locales/', import.meta.url);
const localeFile = (locale) => JSON.parse(readFileSync(new URL(`${locale}.json`, LOCALE_DIR), 'utf8'));

const flattenLocale = (obj, prefix = '', out = new Map()) => {
  for (const [k, v] of Object.entries(obj)) {
    const key = prefix ? `${prefix}.${k}` : k;
    if (v && typeof v === 'object') flattenLocale(v, key, out);
    else out.set(key, v);
  }
  return out;
};

const ko = flattenLocale(localeFile('ko'));

// ---------------------------------------------------------------------------
// (1) Tabelle ueber den Helfer
// ---------------------------------------------------------------------------

// Die Formen stehen hier ein zweites Mal, mit Absicht: die Tabelle soll rot
// werden, wenn jemand im Helfer Konsonanten- und Vokalform vertauscht. Aus
// KOREAN_PARTICLE_FORMS gelesen, wuerde sie den Tausch mitmachen.
const EXPECTED = [
  // [Doppelform, nach Batchim, nach Vokal, nach Batchim ㄹ]
  ['을(를)', '을', '를', '을'],
  ['이(가)', '이', '가', '이'],
  ['은(는)', '은', '는', '은'],
  ['과(와)', '과', '와', '과'],
  ['(으)로', '으로', '로', '로'],
];

// Vorgaenger: 민준 endet auf ㄴ, 지우 auf einen Vokal, 서울 auf ㄹ.
const BATCHIM = '민준';
const VOWEL = '지우';
const RIEUL = '서울';

// Was KEINE Hangul-Silbe ist, laesst die Doppelform stehen. Bei Latein und
// Ziffern haengt die Form an der Aussprache ("3" ist 삼, "API" endet auf 이) -
// die ist nicht zu raten, ohne gelegentlich falsch zu liegen.
const UNDECIDABLE = [
  ['Latein', 'Anna'],
  ['Ziffer', '2026'],
  ['leer', ''],
  ['Emoji', '사과🍎'],
  ['Satzzeichen', '사과!'],
  ['Leerraum', '사과 '],
  ['einzelnes Jamo', 'ㅋㅋ'],
];

test('Tabelle: jede Doppelform faellt nach Hangul auf die passende Form', () => {
  const rows = [];
  for (const [form, afterBatchim, afterVowel, afterRieul] of EXPECTED) {
    rows.push([`${BATCHIM}${form}`, `${BATCHIM}${afterBatchim}`]);
    rows.push([`${VOWEL}${form}`, `${VOWEL}${afterVowel}`]);
    rows.push([`${RIEUL}${form}`, `${RIEUL}${afterRieul}`]);
  }
  const wrong = rows
    .map(([input, want]) => [input, want, resolveKoreanParticles(input)])
    .filter(([, want, got]) => want !== got)
    .map(([input, want, got]) => `${input} -> ${got} (erwartet ${want})`);
  assert.deepEqual(wrong, []);
});

test('Tabelle: ohne Hangul-Silbe davor bleibt die Doppelform woertlich stehen', () => {
  const wrong = [];
  for (const [form] of EXPECTED) {
    for (const [label, value] of UNDECIDABLE) {
      const input = `${value}${form} 끝`;
      const got = resolveKoreanParticles(input);
      if (got !== input) wrong.push(`${label}: ${input} -> ${got}`);
    }
  }
  assert.deepEqual(wrong, []);
});

test('die erste und die letzte Hangul-Silbe gehoeren dazu (U+AC00, U+D7A3)', () => {
  assert.equal(resolveKoreanParticles('가을(를)'), '가를');
  assert.equal(resolveKoreanParticles('힣을(를)'), '힣을');
});

test('schliessende Anfuehrungszeichen: der Blick geht durch sie hindurch', () => {
  // 26 der 56 Stellen in ko.json stehen hinter einem zitierten Platzhalter
  // ("{{name}}"을(를)). Gelesen wird das Wort, nicht das Zeichen.
  for (const [open, close] of [['"', '"'], ['“', '”'], ['‘', '’'], ["'", "'"], ['「', '」'], ['『', '』']]) {
    assert.equal(resolveKoreanParticles(`${open}${BATCHIM}${close}을(를)`), `${open}${BATCHIM}${close}을`);
    assert.equal(resolveKoreanParticles(`${open}${VOWEL}${close}을(를)`), `${open}${VOWEL}${close}를`);
    // Leerer Wert zwischen den Zeichen: dahinter kommt nichts Lesbares mehr.
    assert.equal(resolveKoreanParticles(`${open}${close}을(를)`), `${open}${close}을(를)`);
    assert.equal(resolveKoreanParticles(`${open}Anna${close}을(를)`), `${open}Anna${close}을(를)`);
  }
});

test('schliessende Klammern: kein Durchblick, die Doppelform bleibt stehen', () => {
  // Ob ein Klammerzusatz mitgelesen wird, entscheidet der Leser: "우유 (2L)"
  // spricht sich je nachdem auf 유 oder auf 리터. Kein Wert in ko.json stellt
  // eine Klammer vor die Partikel - die Frage stellt nur ein Nutzerwert.
  for (const close of [')', ']', '}', '）', '〉', '》']) {
    const input = `${BATCHIM}${close}을(를)`;
    assert.equal(resolveKoreanParticles(input), input);
  }
});

test('mehrere Doppelformen in einem Text entscheiden je fuer sich', () => {
  assert.equal(
    resolveKoreanParticles('민준이(가) 지우을(를) 서울(으)로 Anna과(와)'),
    '민준이 지우를 서울로 Anna과(와)',
  );
});

test('der Helfer fuellt Platzhalter ueber den Rueckruf und liest NUR die Vorlage', () => {
  const fill = (segment) => segment.replace('{{name}}', '지우을(를)');
  // Die Form im Nutzerwert bleibt woertlich; die der Vorlage richtet sich nach
  // dem Zeichen davor, und das ist hier die Klammer des Nutzerwerts.
  assert.equal(resolveKoreanParticles('{{name}}이(가) 추가됨', fill), '지우을(를)이(가) 추가됨');
  assert.equal(
    resolveKoreanParticles('{{name}}이(가) 추가됨', (s) => s.replace('{{name}}', '지우')),
    '지우가 추가됨',
  );
});

test('Text ohne Doppelform kommt unveraendert zurueck', () => {
  for (const text of ['', '저장', '기간(일)', '시간(왼쪽)과 목표(오른쪽)이며', 'Speichern (optional)']) {
    assert.equal(resolveKoreanParticles(text), text);
  }
});

// ---------------------------------------------------------------------------
// (2) Die echte t()
// ---------------------------------------------------------------------------

const store = new Map();
global.localStorage = {
  getItem: (k) => store.get(k) ?? null,
  setItem: (k, v) => store.set(k, String(v)),
  removeItem: (k) => store.delete(k),
};
global.document = { documentElement: { lang: '', dir: '' } };
global.window = { dispatchEvent: () => {}, matchMedia: () => ({ matches: false }) };
global.CustomEvent = class { constructor(type, init) { this.type = type; Object.assign(this, init); } };
global.fetch = async (url) => {
  const locale = String(url).replace('/locales/', '').replace('.json', '');
  return { ok: true, json: async () => localeFile(locale) };
};
Object.defineProperty(global, 'navigator', {
  value: { languages: ['de-DE'], language: 'de-DE' },
  writable: true,
  configurable: true,
});

const {
  initI18n, setLocale, t, registerExtensionTranslations, clearExtensionTranslations,
} = await import('../public/i18n.js');
await initI18n();

test('t() in ko: echte Schluessel, je Partikel mit und ohne Batchim', async () => {
  await setLocale('ko');
  const cases = [
    ['settings.memberAddedToast', { name: '민준' }, '민준이 추가되었습니다.'],
    ['settings.memberAddedToast', { name: '지우' }, '지우가 추가되었습니다.'],
    ['settings.moduleStatusOn', { module: '캘린더' }, '캘린더가 가정에서 켜져 있습니다.'],
    ['changelog.updateAvailable', { version: '버전' }, '버전 버전을 사용할 수 있습니다.'],
    ['rrule.lastDayOfMonthHintSame', { date: '말일' }, '말일은 이미 해당 월의 마지막 날이며 첫 일정이 됩니다.'],
    ['rrule.lastDayOfMonthHintSame', { date: '오늘 하루' }, '오늘 하루는 이미 해당 월의 마지막 날이며 첫 일정이 됩니다.'],
    ['budget.trendNeutral', { month: '지난달' }, '- 지난달과 동일'],
    ['budget.trendNeutral', { month: '작년 같은 시기' }, '- 작년 같은 시기와 동일'],
    ['tasks.tagFilterBy', { tag: '집' }, '태그 집으로 필터'],
    ['tasks.tagFilterBy', { tag: '학교' }, '태그 학교로 필터'],
    ['tasks.tagFilterBy', { tag: '서울' }, '태그 서울로 필터'],
    // Zitierter Platzhalter: vier Arten von Anfuehrungszeichen im Bestand.
    ['tasks.subtaskDeleteConfirm', { title: '우유' }, '「우유」를 삭제할까요?'],
    ['shopping.storeDeleteConfirm', { name: '시장' }, '상점 “시장”을 삭제할까요?'],
    ['quickLinks.deleteConfirm', { name: '날씨' }, "'날씨'를 삭제할까요?"],
    ['inventory.deleteConfirm', { name: '냉장고' }, null],
  ];
  const wrong = [];
  for (const [key, params, want] of cases) {
    const got = t(key, params);
    // `null`: nur pruefen, dass die Doppelform weg ist - der Rest des Satzes
    // gehoert der Uebersetzung und soll diesen Test nicht festnageln.
    if (want === null ? /\((?:를|가|는|와|으)\)/.test(got) : got !== want) {
      wrong.push(`${key} ${JSON.stringify(params)} -> ${got}`);
    }
  }
  assert.deepEqual(wrong, []);
});

test('t() in ko: Latein, Ziffer, leer und Emoji lassen die Doppelform stehen', async () => {
  await setLocale('ko');
  assert.equal(t('settings.memberAddedToast', { name: 'Anna' }), 'Anna이(가) 추가되었습니다.');
  assert.equal(t('changelog.updateAvailable', { version: '1.2.3' }), '버전 1.2.3을(를) 사용할 수 있습니다.');
  assert.equal(t('settings.memberAddedToast', { name: '' }), '이(가) 추가되었습니다.');
  assert.equal(t('settings.memberAddedToast', { name: '지우🍎' }), '지우🍎이(가) 추가되었습니다.');
  // Fehlender Parameter: der Platzhalter bleibt stehen, die Form auch.
  assert.equal(t('settings.memberAddedToast'), '{{name}}이(가) 추가되었습니다.');
});

test('t() in ko: eine Doppelform im NUTZERWERT wird nicht angefasst', async () => {
  await setLocale('ko');
  assert.equal(
    t('tasks.subtaskDeleteConfirm', { title: '지우이(가) 할 일' }),
    '「지우이(가) 할 일」을 삭제할까요?',
  );
});

test('t() in ko: der Pluralweg (count) laeuft durch denselben Aufloeser', async () => {
  await setLocale('ko');
  assert.equal(t('tasks.tagDeleteConfirm', { tag: '학교', count: 3 }), '학교를 작업 3개에서 제거할까요?');
  assert.equal(t('tasks.tagDeleteConfirm', { tag: '집', count: 1 }), '집을 작업 1개에서 제거할까요?');
});

test('t() in ko: Texte eines Erweiterungsmoduls laufen durch denselben Aufloeser', async () => {
  await setLocale('ko');
  registerExtensionTranslations('probe', { msg: '{{name}}을(를) 삭제' });
  try {
    assert.equal(t('extensions.probe.msg', { name: '지우' }), '지우를 삭제');
  } finally {
    clearExtensionTranslations();
  }
});

test('andere Sprachen: dieselbe Zeichenfolge bleibt woertlich stehen', async () => {
  registerExtensionTranslations('probe', { msg: '{{name}}을(를) 삭제, {{name}}(으)로' });
  try {
    for (const locale of ['de', 'en', 'ja', 'zh']) {
      await setLocale(locale);
      assert.equal(
        t('extensions.probe.msg', { name: '지우' }),
        '지우을(를) 삭제, 지우(으)로',
        locale,
      );
    }
  } finally {
    clearExtensionTranslations();
    await setLocale('de');
  }
});

// ---------------------------------------------------------------------------
// (3) Guards ueber den Bestand
// ---------------------------------------------------------------------------

const KNOWN = new Set(KOREAN_PARTICLE_FORMS.map((entry) => entry.form));

test('der Aufloeser kennt genau die Doppelformen der Tabelle', () => {
  assert.deepEqual([...KNOWN].sort(), EXPECTED.map(([form]) => form).sort());
});

test('jede Form, die der Aufloeser kennt, kommt in ko.json vor', () => {
  const unused = [...KNOWN].filter((form) => ![...ko.values()].some((value) => String(value).includes(form)));
  assert.deepEqual(unused, []);
});

const H = '[\\uAC00-\\uD7A3]';
const CLOSING_QUOTES = '["\'”’」』]';

/**
 * Doppelformen eines Werts, an zwei Merkmalen erkannt - eines allein ist blind:
 *
 *  - an der STELLE: direkt hinter einem Platzhalter (samt schliessendem
 *    Anfuehrungszeichen) steht eine Klammergruppe aus Hangul, an Hangul
 *    geklebt. Das faengt auch eine Partikel, an die hier niemand gedacht hat.
 *    `{{date}} (성공)` zaehlt nicht: dort steht ein Leerzeichen, das ist ein
 *    Zusatz und keine Partikel.
 *  - am WORTLAUT: eine der Partikeln, die im Koreanischen je nach Auslaut
 *    wechseln, in einer der ueblichen Schreibweisen - auch mitten im Satz.
 */
function doubleFormsIn(value) {
  const found = new Set();
  const positional = new RegExp(`\\}\\}${CLOSING_QUOTES}*(${H}*\\(${H}+\\)${H}?)`, 'g');
  for (const m of value.matchAll(positional)) {
    const token = m[1];
    const known = [...KNOWN].find((form) => token.startsWith(form));
    found.add(known ?? token);
  }
  for (const spelling of ALTERNATION_SPELLINGS) {
    let from = 0;
    for (;;) {
      const at = value.indexOf(spelling, from);
      if (at === -1) break;
      from = at + 1;
      // `(으)로` steckt woertlich in `(으)로서`; eine bekannte Form, die an
      // derselben Stelle beginnt, hat Vorrang vor der laengeren unbekannten.
      const known = [...KNOWN].find((form) => value.startsWith(form, at));
      found.add(known ?? spelling);
    }
  }
  return found;
}

// [Form nach Konsonant, Form nach Vokal]
const ALTERNATIONS = [
  ['이', '가'], ['을', '를'], ['은', '는'], ['과', '와'], ['아', '야'],
  ['으로', '로'], ['으로서', '로서'], ['으로써', '로써'],
  ['이나', '나'], ['이랑', '랑'], ['이라', '라'], ['이며', '며'], ['이든', '든'],
  ['이여', '여'], ['이야', '야'], ['이에요', '예요'], ['이라고', '라고'], ['이란', '란'],
];
const ALTERNATION_SPELLINGS = ALTERNATIONS.flatMap(([consonant, vowel]) => {
  const spellings = [`${consonant}(${vowel})`, `${vowel}(${consonant})`];
  // `(으)로`, `(이)나`: die Vokalform ist die Konsonantenform ohne ihre erste Silbe.
  if (consonant.endsWith(vowel) && consonant.length > vowel.length) {
    spellings.push(`(${consonant.slice(0, consonant.length - vowel.length)})${vowel}`);
  }
  return spellings;
});

test('Guard: ko.json enthaelt keine Doppelform, die der Aufloeser nicht kennt', () => {
  const unknown = [];
  for (const [key, value] of ko) {
    if (typeof value !== 'string') continue;
    for (const form of doubleFormsIn(value)) {
      if (!KNOWN.has(form)) unknown.push(`${key}: ${form}`);
    }
  }
  assert.deepEqual(unknown, [], 'neue Doppelform: in public/utils/korean-particles.js aufnehmen oder ausschreiben');
});

test('Guard: zaehlt im Bestand genau die bekannten Formen (kein blinder Scanner)', () => {
  const counts = new Map();
  for (const value of ko.values()) {
    if (typeof value !== 'string') continue;
    for (const form of KNOWN) {
      const n = value.split(form).length - 1;
      if (n) counts.set(form, (counts.get(form) ?? 0) + n);
    }
  }
  // Keine Zahl festgenagelt: der Bestand waechst. Aber der Scanner, der oben
  // "nichts Unbekanntes" meldet, muss die bekannten Stellen SEHEN.
  let seen = 0;
  for (const value of ko.values()) {
    if (typeof value === 'string') seen += [...doubleFormsIn(value)].filter((form) => KNOWN.has(form)).length;
  }
  assert.ok(seen > 0, 'der Scanner findet keine einzige bekannte Doppelform');
  assert.deepEqual([...counts.keys()].sort(), [...KNOWN].sort());
});

test('Guard: der Scanner wird an erfundenen Werten rot', () => {
  const samples = [
    ['{{name}}와(과) 함께', '와(과)'],
    ['{{name}}(이)나 다른 것', '(이)나'],
    ['"{{name}}"(이)랑', '(이)랑'],
    ['{{name}}아(야)', '아(야)'],
    ['{{name}}으로(로)', '으로(로)'],
    ['{{name}}(으)로서', '(으)로'],
    // Unbekannte Partikel an der Platzhalter-Stelle, in keiner Liste gefuehrt.
    ['{{name}}께(께서) 보냄', '께(께서)'],
    ['“{{name}}”(이)지만', '(이)지'],
  ];
  for (const [value, want] of samples) {
    assert.ok(doubleFormsIn(value).has(want), `${value}: ${[...doubleFormsIn(value)].join(', ') || 'nichts'}`);
  }
  // Zusaetze mit Leerzeichen und Klammern ohne Platzhalter davor sind keine.
  for (const value of ['{{date}} (성공)', '기간(일)', '시간(왼쪽)과 기록된 목표(오른쪽)이며', '{{n}} (예상)']) {
    assert.deepEqual([...doubleFormsIn(value)], [], value);
  }
});

// Der Installer hat eigene Locales und ein eigenes t() (tools/installer/
// i18n-mini.js), die CLI liest Shell-Dateien. Beide laufen NICHT durch den
// Aufloeser - eine Doppelform dort kaeme woertlich auf den Schirm.
test('Guard: die Installer-Locales fuer ko tragen keine Doppelform', () => {
  const files = ['../tools/installer/locales/ko.json', '../tools/installer/locales/cli/ko.sh'];
  const hits = [];
  for (const file of files) {
    const text = readFileSync(new URL(file, import.meta.url), 'utf8');
    for (const spelling of ALTERNATION_SPELLINGS) {
      if (text.includes(spelling)) hits.push(`${file}: ${spelling}`);
    }
  }
  assert.deepEqual(hits, []);
});
