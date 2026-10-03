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
 * 1. Name mit Leerraum: das erste Zeichen der ersten zwei Woerter, gross
 *    ("Anna Maria Schmidt" -> "AM"). Ein Bindestrich trennt nicht
 *    ("Anna-Lena Vogt" -> "AV"). Das ist die Regel, die dreizehn der vierzehn
 *    Kopien schon hatten.
 * 2. Name OHNE Leerraum, ganz in Hangul, Han oder Kana: die LETZTEN ZWEI
 *    Zeichen, also der Rufname (김민수 -> 민수, 田中太郎 -> 太郎); bei einem
 *    oder zwei Zeichen der ganze Name. Das erste Zeichen ist dort der
 *    Familienname - zwei Geschwister sahen damit gleich aus.
 * 3. Sonst ein Wort: sein erstes Zeichen ("Anna" -> "A").
 * 4. Leerer Name: der `fallback` des Aufrufers. Er ist ein Parameter und keine
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
const FULL_WIDTH = /[\p{scx=Hangul}\p{scx=Han}\p{scx=Hiragana}\p{scx=Katakana}\p{Extended_Pictographic}\p{Regional_Indicator}]/u;

let segmenter = null;

/**
 * Zerlegt einen Text in Grapheme.
 *
 * Ohne `Intl.Segmenter` (aeltere WebViews) setzt der Rueckfall die Cluster
 * selbst zusammen: Codepoints statt Code-Units, und was an seinem Vorgaenger
 * haengt (kombinierende Zeichen, Variantenselektoren, Hautton, ZWJ-Folgen,
 * das zweite Zeichen einer Flagge), bleibt bei ihm. Das ist nicht ganz UAX
 * #29, aber es zerschneidet nichts, was in einem Namen vorkommt.
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
      /^[\p{M}‍\p{Emoji_Modifier}]$/u.test(cp)
      || prev.endsWith('‍')
      || (/^\p{Regional_Indicator}$/u.test(cp) && /^\p{Regional_Indicator}$/u.test(prev))
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

  if (words.length === 1) {
    const chars = graphemes(words[0]);
    if (chars.every((char) => CJK.test(char))) return chars.slice(-2).join('');
    return (chars[0] ?? '').toUpperCase() || fallback;
  }

  return words.slice(0, 2)
    .map((word) => (graphemes(word)[0] ?? '').toUpperCase())
    .join('') || fallback;
}

/**
 * Dieselben Zeichen fuer eine Scheibe, in die keine zwei Geviert-Zeichen
 * passen (unter 2em Innenbreite): zwei Hangul-, Han-, Kana- oder Emoji-Zeichen
 * werden zu EINEM, und zwar dem letzten. Lateinische Initialen bleiben, wie
 * sie sind.
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
  if (chars.length < 2 || !chars.some((char) => FULL_WIDTH.test(char))) return full;
  return chars[chars.length - 1];
}
