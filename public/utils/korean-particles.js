/**
 * Modul: koreanische Partikel hinter Platzhaltern (#1607)
 * Zweck: Viele koreanische Partikeln haben zwei Formen, und welche gilt, haengt
 *        am letzten Laut des Wortes davor: nach einem Schlusskonsonanten
 *        (Batchim) 이/을/은/과/으로, nach einem Vokal 가/를/는/와/로. Hinter einem
 *        Platzhalter kennt die Uebersetzung das Wort nicht und schreibt beide
 *        Formen hin - `{{name}}이(가)`. Ohne Aufloesung steht das woertlich auf
 *        dem Schirm: "캘린더이(가) 가정에서 켜져 있습니다."
 *
 *        Die Regel lebt hier und nur hier. ko.json behaelt die Doppelform, t()
 *        in public/i18n.js ruft diesen Helfer bei aktiver Sprache `ko`, und
 *        translate() in server/utils/i18n.js ruft ihn, wenn der gelieferte Text
 *        aus ko.json stammt (geteiltes Modul, siehe test/test-layer-boundary.js).
 * Dependencies: keine (reine Funktion, kein DOM, kein Node)
 */

/**
 * Die Doppelformen, die ko.json tatsaechlich schreibt - nicht mehr. Eine neue
 * Schreibweise (`와(과)`, `(이)나`) gehoert hierher UND wird von
 * test/test-i18n-ko-particles.js gefordert, sobald sie in ko.json auftaucht.
 *
 * `rieulAsVowel`: 로 folgt auch auf den Schlusskonsonanten ㄹ (서울로, nicht
 * 서울으로). Das gilt nur fuer (으)로, die anderen behandeln ㄹ wie jeden
 * Konsonanten.
 */
export const KOREAN_PARTICLE_FORMS = [
  { form: '을(를)', consonant: '을', vowel: '를' },
  { form: '이(가)', consonant: '이', vowel: '가' },
  { form: '은(는)', consonant: '은', vowel: '는' },
  { form: '과(와)', consonant: '과', vowel: '와' },
  { form: '(으)로', consonant: '으로', vowel: '로', rieulAsVowel: true },
];

const BY_FORM = new Map(KOREAN_PARTICLE_FORMS.map((entry) => [entry.form, entry]));

/**
 * Ein Muster, das genau die uebergebenen Schreibweisen woertlich trifft. Jedes
 * Metazeichen wird maskiert, der Backslash eingeschlossen, in EINEM Durchgang -
 * nacheinander maskiert, wuerde der zweite Durchgang die Backslashes des ersten
 * erneut anfassen.
 * Exportiert, damit der Test Formen hindurchschicken kann, die der Bestand
 * nicht hat.
 */
export function buildFormPattern(forms) {
  return new RegExp(
    forms.map((form) => form.replace(/[\\^$.*+?()[\]{}|/-]/g, '\\$&')).join('|'),
    'g',
  );
}

const FORM_PATTERN = buildFormPattern(KOREAN_PARTICLE_FORMS.map((entry) => entry.form));

// Hangul-Silbenblock: 19 Anlaute x 21 Vokale x 28 Auslaute, der Auslaut 0 ist
// "keiner". Der Rest der Division durch 28 ist also der Batchim.
const SYLLABLE_FIRST = 0xAC00;
const SYLLABLE_LAST = 0xD7A3;
const FINALS = 28;
const FINAL_RIEUL = 8;

/**
 * Schliessende Anfuehrungszeichen, durch die der Blick hindurchgeht. Fast die
 * Haelfte der Stellen in ko.json zitiert den Platzhalter ("{{name}}"을(를)), und
 * gelesen wird das Wort, nicht das Zeichen.
 *
 * Schliessende KLAMMERN stehen bewusst nicht hier. Ob ein Klammerzusatz
 * mitgelesen wird, entscheidet der Leser - "우유 (2L)" endet je nachdem auf 유
 * oder auf 리터 -, und keine Vorlage stellt eine Klammer vor die Partikel. Dort
 * bleibt die Doppelform stehen, wie hinter allem, was keine Hangul-Silbe ist.
 */
const CLOSING_QUOTES = new Set(['"', "'", '”', '’', '」', '』']);

/**
 * Die Form, die hinter `before` gilt - oder die Doppelform selbst, wenn das
 * Zeichen davor keine Hangul-Silbe ist. Latein, Ziffern und Emoji haengen an
 * der Aussprache ("3" ist 삼, "API" endet auf 이); geraten laege das gelegentlich
 * falsch, und eine falsche Partikel ist schlechter als die ehrliche Doppelform.
 */
function pickForm(entry, before) {
  let i = before.length - 1;
  while (i >= 0 && CLOSING_QUOTES.has(before[i])) i -= 1;
  if (i < 0) return entry.form;
  const code = before.charCodeAt(i);
  if (code < SYLLABLE_FIRST || code > SYLLABLE_LAST) return entry.form;
  const final = (code - SYLLABLE_FIRST) % FINALS;
  if (final === 0 || (entry.rieulAsVowel && final === FINAL_RIEUL)) return entry.vowel;
  return entry.consonant;
}

/**
 * Loest die Doppelformen einer koreanischen Vorlage auf.
 *
 * `fill` setzt die Platzhalter eines Vorlagen-Stuecks ein. Die Vorlage wird an
 * ihren Doppelformen zerlegt, jedes Stueck einzeln gefuellt, und jede Form
 * entscheidet am Ende dessen, was bis dahin entstanden ist. So ist das Zeichen
 * davor das des EINGESETZTEN Werts, aber gesucht wird nur in der Vorlage: ein
 * Aufgabentitel, der selbst "이(가)" enthaelt, bleibt, wie der Nutzer ihn
 * geschrieben hat.
 *
 * @param {string} template  Uebersetzungstext, Platzhalter noch nicht eingesetzt
 * @param {(segment: string) => string} [fill]  setzt Platzhalter ein
 * @returns {string}
 */
export function resolveKoreanParticles(template, fill = (segment) => segment) {
  // Jede Doppelform traegt eine Klammer. Die meisten Texte haben keine.
  if (!template.includes('(')) return fill(template);
  let out = '';
  let last = 0;
  for (const match of template.matchAll(FORM_PATTERN)) {
    out += fill(template.slice(last, match.index));
    out += pickForm(BY_FORM.get(match[0]), out);
    last = match.index + match[0].length;
  }
  return out + fill(template.slice(last));
}
