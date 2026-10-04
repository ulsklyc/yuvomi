/**
 * Modul: Initialen (initials)
 * Zweck: Die EINE Regel, nach der ein Name zu den Zeichen auf einer
 *        Avatar-Scheibe wird.
 * Dependencies: keine
 *
 * WARUM ES DIESE DATEI GIBT (#1464, #1607). Die Regel stand in vierzehn
 * Kopien in Seiten, Komponenten und im Router, mit drei Ergebnissen fuer
 * denselben Namen: die meisten nahmen die ersten zwei Woerter, die Kontakte
 * das erste und das letzte, und ob ein leerer Name eine leere Scheibe oder
 * ein "?" ergab, hing an der Seite. Dieselbe Person trug je Ansicht andere
 * Zeichen. `test:initials` haelt, dass keine Kopie zurueckkommt.
 *
 * DIE REGEL
 *
 * 1. Mehrere Woerter: das erste Zeichen des ERSTEN und des LETZTEN Worts,
 *    gross ("Anna Maria Schmidt" -> "AS", "Dr. Hans Müller" -> "DM"). Ein
 *    Bindestrich trennt nicht ("Anna-Lena Vogt" -> "AV"). Die ersten zwei
 *    Woerter - die Regel von dreizehn der vierzehn Kopien - machten aus einem
 *    Zweitnamen oder Titel den Familiennamen; das letzte Wort ist er.
 * 2. Name OHNE Leerraum, ganz in Hangul, Han oder Kana: die LETZTEN ZWEI
 *    Zeichen, also der Rufname (김민수 -> 민수, 田中太郎 -> 太郎); bei einem
 *    oder zwei Zeichen der ganze Name. Das erste Zeichen ist dort der
 *    Familienname - zwei Geschwister sahen damit gleich aus.
 * 3. Genau ZWEI Woerter, beide ganz in Hangul, Han oder Kana: das zweite
 *    Wort ist der Rufname und wird behandelt wie in 2 ("김 민수" -> 민수,
 *    "田中 太郎" -> 太郎). Dieselbe Person sieht damit gleich aus, ob sie mit
 *    oder ohne Leerzeichen eingetragen ist.
 *    DIE GRENZE: nur dieser eine Fall. Steht ein lateinisches Wort dabei
 *    ("김 Minsu", "Minsu Kim 김"), sagt die Schrift nicht mehr, in welcher
 *    Reihenfolge Familien- und Rufname stehen; bei drei und mehr Woertern
 *    ist nicht zu erkennen, welche zusammen den Rufnamen bilden. Beides
 *    faellt auf Regel 1 zurueck, statt zu raten.
 * 4. Ein Wort sonst: sein erstes Zeichen ("Anna" -> "A").
 * 5. Leerer Name: der `fallback` des Aufrufers. Er ist ein Parameter und keine
 *    Konstante, weil beide Antworten begruendet im Einsatz sind: eine Scheibe,
 *    die allein steht, zeigt "?", und eine, neben der der Name ohnehin steht,
 *    bleibt leer.
 *
 * GEZAEHLT WIRD IN GRAPHEMEN, nicht in Code-Units. `w[0]` schneidet ein Emoji
 * in ein halbes Surrogatpaar und trennt ein kombinierendes Zeichen von seinem
 * Buchstaben; beides stand so in den Kopien.
 */

// Hangul, Han und Kana ueber `Script_Extensions`, damit auch das
// Laengungszeichen (ー) und das Wiederholungszeichen (々) dazugehoeren - beide
// haben als Schrift "Common", stehen aber nur in japanischen Namen.
const CJK = /^[\p{scx=Hangul}\p{scx=Han}\p{scx=Hiragana}\p{scx=Katakana}]/u;

// Was auf der Scheibe ein ganzes Geviert breit ist: die Schriften oben und
// Emoji. Zwei davon brauchen 2em, zwei lateinische Grossbuchstaben rund 1.4em.
// Die Tastenkappe (U+20E3) steht eigens da: ihr Emoji beginnt mit einer Ziffer,
// `#` oder `*`, und an denen ist die Breite nicht zu erkennen.
const FULL_WIDTH = /[\p{scx=Hangul}\p{scx=Han}\p{scx=Hiragana}\p{scx=Katakana}\p{Extended_Pictographic}\p{Regional_Indicator}\u20E3]/u;

// Das Virama der Schriften, in denen es zwei Konsonanten zu EINER Ligatur
// bindet (UAX #29, GB9c): Devanagari, Bengalisch, Gujarati, Oriya, Telugu,
// Malayalam. Der Name Shruti beginnt mit Sha + Virama + Ra - ohne diese Regel
// bliebe auf der Scheibe ein Sha mit sichtbarem Halant. Tamil fehlt mit
// Absicht: dort trennt auch der Segmenter.
const CONJUNCT_VIRAMA = /[\u094D\u09CD\u0ACD\u0B4D\u0C4D\u0D4D]$/u;

// Zerlegtes Hangul (UAX #29, GB6-GB8): Anlaut (L), Vokal (V) und Auslaut (T)
// stehen als einzelne Jamo da und sind zusammen EINE Silbe. Namen werden ohne
// NFC-Normalisierung gespeichert; ohne diese Regel bliebe von 김민수 in
// zerlegter Form ein einzelner Vokal.
const JAMO_L = /[\u1100-\u115F\uA960-\uA97C]$/u;
const JAMO_V = /[\u1160-\u11A7\uD7B0-\uD7C6]$/u;
const JAMO_T = /[\u11A8-\u11FF\uD7CB-\uD7FB]$/u;
const SYLLABLE = /[\uAC00-\uD7A3]$/u;
// Eine fertige Silbe ohne Auslaut (LV) - nur an sie passt noch ein Vokal.
const isOpenSyllable = (text) => SYLLABLE.test(text) && (text.charCodeAt(text.length - 1) - 0xAC00) % 28 === 0;

function joinsHangul(prev, cp) {
  if (JAMO_L.test(prev)) return JAMO_L.test(cp) || JAMO_V.test(cp) || SYLLABLE.test(cp);
  if (JAMO_V.test(prev) || isOpenSyllable(prev)) return JAMO_V.test(cp) || JAMO_T.test(cp);
  if (JAMO_T.test(prev) || SYLLABLE.test(prev)) return JAMO_T.test(cp);
  return false;
}

let segmenter = null;

/**
 * Zerlegt einen Text in Grapheme.
 *
 * Ohne `Intl.Segmenter` (aeltere WebViews) setzt der Rueckfall die Cluster
 * selbst zusammen: Codepoints statt Code-Units, und was an seinem Vorgaenger
 * haengt (kombinierende Zeichen, Variantenselektoren, Hautton, ZWJ-Folgen,
 * das zweite Zeichen einer Flagge, der Konsonant hinter einem Virama,
 * die Jamo einer zerlegten Hangul-Silbe),
 * bleibt bei ihm. Das ist nicht ganz UAX #29, aber `test:initials` haelt es
 * fuer Namen in den Schriften der App-Sprachen gegen den Segmenter.
 *
 * @param {string} text
 * @returns {string[]}
 */
export function graphemes(text) {
  const value = String(text ?? '');
  if (typeof Intl !== 'undefined' && typeof Intl.Segmenter === 'function') {
    segmenter ??= new Intl.Segmenter(undefined, { granularity: 'grapheme' });
    return Array.from(segmenter.segment(value), (part) => part.segment);
  }
  const out = [];
  for (const cp of value) {
    const prev = out[out.length - 1];
    const joins = prev !== undefined && (
      /^[\p{M}\u200D\p{Emoji_Modifier}]$/u.test(cp)
      || prev.endsWith('\u200D')
      || (CONJUNCT_VIRAMA.test(prev) && /^\p{L}$/u.test(cp))
      || (/^\p{Regional_Indicator}$/u.test(cp) && /^\p{Regional_Indicator}$/u.test(prev))
      || joinsHangul(prev, cp)
    );
    if (joins) out[out.length - 1] = prev + cp;
    else out.push(cp);
  }
  return out;
}

/**
 * Die Zeichen fuer die Avatar-Scheibe eines Namens. Regel: siehe Dateikopf.
 *
 * Das Ergebnis ist TEXT, kein Markup - wer es in einen HTML-String setzt,
 * schickt es durch `esc()`.
 *
 * @param {string|null|undefined} name
 * @param {string} [fallback]  Was bei leerem Namen auf der Scheibe steht.
 * @returns {string}
 */
export function initials(name, fallback = '') {
  const words = String(name ?? '').trim().split(/\s+/u).filter(Boolean);
  if (!words.length) return fallback;

  const letters = words.map(graphemes);
  const isCjk = (chars) => chars.every((char) => CJK.test(char));

  // Regel 2 und 3: der Rufname ist das einzige Wort oder das zweite von zweien.
  if (words.length <= 2 && letters.every(isCjk)) {
    return letters[letters.length - 1].slice(-2).join('');
  }

  if (words.length === 1) return (letters[0][0] ?? '').toUpperCase() || fallback;

  // Regel 1: erstes und letztes Wort.
  return [letters[0], letters[letters.length - 1]]
    .map((chars) => (chars[0] ?? '').toUpperCase())
    .join('') || fallback;
}

/**
 * Dieselben Zeichen fuer eine Scheibe, in die keine zwei Geviert-Zeichen
 * passen (unter 2em Innenbreite): zwei Hangul-, Han-, Kana- oder Emoji-Zeichen
 * werden zu EINEM, und zwar dem letzten. Lateinische Initialen bleiben, wie
 * sie sind - und ebenso ein GEMISCHTES Paar ("김 Smith" -> 김S): es ist nicht
 * breiter als zwei breite lateinische Buchstaben, und wer sein erstes Zeichen
 * striche, naehme ihm die Haelfte der Aussage.
 *
 * WARUM DAS LETZTE: der Zweck der Zwei-Zeichen-Regel ist, Geschwister zu
 * unterscheiden, und unter Geschwistern ist eher die erste Silbe des Rufnamens
 * die gemeinsame (민수 und 민지, 서연 und 서준). Das erste Zeichen des ganzen
 * Namens waere wieder der Familienname.
 *
 * @param {string|null|undefined} name
 * @param {string} [fallback]
 * @returns {string}
 */
export function compactInitials(name, fallback = '') {
  const full = initials(name, fallback);
  const chars = graphemes(full);
  if (chars.length < 2 || !chars.every((char) => FULL_WIDTH.test(char))) return full;
  return chars[chars.length - 1];
}
