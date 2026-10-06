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
 *
 * WAS AUF DER SCHEIBE STEHT, IST EIN ZEICHEN JE WORT (#1464)
 *
 * - Gross wird je Zeichen, und es bleibt EINES: `toUpperCase()` macht aus ß
 *   "SS", aus der Ligatur ﬁ "FI" und aus ŉ einen Apostroph mit N. Die Scheibe
 *   trug damit drei Zeichen ("ßeta Schmidt" -> "SSS"). Bleibt nach dem
 *   Grossschreiben mehr als ein Zeichen, zaehlt das erste mit einem
 *   Grossbuchstaben.
 * - OHNE Locale. Tuerkisch schriebe "ipek" als "İ", aber die Sprache eines
 *   Namens kennt die App nicht, und mit der Oberflaechensprache truege dieselbe
 *   Person je Betrachter andere Zeichen. Wer İpek eingibt, behaelt das İ.
 * - Georgisch bleibt, wie es ist: `toUpperCase()` gaebe Mtavruli, das kaum eine
 *   Schrift zeichnet. Schriften ohne Gross und Klein aendert es ohnehin nicht.
 * - Zwei arabische (oder syrische, N'Ko-) Buchstaben verbaenden sich zu einem
 *   Wort (م + ع liest sich "مع", "mit"); ein U+200C dazwischen haelt sie
 *   getrennt. Es haengt am ersten Zeichen und zaehlt nicht als eigenes.
 * - Satzzeichen und unsichtbare Zeichen stehen nicht auf der Scheibe, solange
 *   der Name etwas anderes hergibt: "(Oma) Erika" -> "OE", ein Wort nur aus
 *   Satzzeichen zaehlt nicht ("Anna -" -> "A"), und ein Richtungszeichen vor
 *   einem arabischen Namen ergab eine leere Scheibe.
 *
 * GLEICHE INITIALEN IM HAUSHALT (#1464)
 *
 * Linda Johnson und Leo Johnson trugen beide "LJ", und die Farbe allein
 * unterscheidet nicht (WCAG 1.4.1). Die Regel, in dieser Reihenfolge:
 *
 * a. Wer seine Zeichen mit niemandem teilt, behaelt sie.
 * b. Wer sie teilt, bekommt das erste Zeichen des Vornamens und dazu den
 *    naechsten Buchstaben seines Vornamens, den noch niemand traegt - zuerst
 *    also den ZWEITEN ("LI", "LE"), sonst den dritten, vierten ..., danach die
 *    Buchstaben des Familiennamens ab dem zweiten. Namen nach Regel 2 und 3
 *    nehmen das erste Zeichen des ganzen Namens und das letzte (김민수,
 *    박민수 -> 김수, 박수).
 * c. Vergeben wird in der Reihenfolge der NAMEN (nach Codepoints sortiert,
 *    Gruppen nach ihren Zeichen), nicht in der Reihenfolge der Liste: Linda
 *    und Lisa Johnson werden "LI" und "LS", gleich wer zuerst angelegt wurde.
 *    Was irgendjemand nach der einfachen Regel traegt, ist dabei schon
 *    vergeben (neben Lisa Imhof, "LI", wird Linda Johnson "LN").
 * d. Hat ein Name keinen freien Buchstaben mehr, behaelt er seine Zeichen
 *    ("A B" neben "a b").
 *
 * Es bleibt bei zwei Zeichen. Das Ergebnis haengt nur an der Menge der Namen.
 *
 * WOHER DER HELFER DEN HAUSHALT KENNT. Aus jeder Auth-Antwort
 * (`initialsRoster` an /auth/me und /auth/login, api.js), wie die
 * Haushaltsgroesse in utils/household.js - und NICHT als Parameter: die
 * meisten Aufrufer haben nur einen Namen in der Hand (eine Kontaktzeile, eine
 * Punktestandszeile, die Kontozeile der Seitenleiste), und ein Aufrufer ohne
 * Liste zeigte still "LJ", wo der Nachbar "LI" zeigt. Gesucht wird ueber den
 * NAMEN, also traegt auch der verknuepfte Kontakt und der Geburtstag eines
 * Mitglieds dessen Zeichen. In der Liste steht jedes Konto, auch ein
 * deaktiviertes: sonst aenderten sich die Zeichen eines Mitglieds, sobald ein
 * anderes geht. Zwei Konten mit DEMSELBEN Namen bleiben gleich - Initialen
 * koennen sie nicht unterscheiden.
 */

// Hangul, Han und Kana ueber `Script_Extensions`, damit auch das
// Laengungszeichen (ー) und das Wiederholungszeichen (々) dazugehoeren - beide
// haben als Schrift "Common", stehen aber nur in japanischen Namen.
const CJK = /^[\p{scx=Hangul}\p{scx=Han}\p{scx=Hiragana}\p{scx=Katakana}]/u;

// Was auf der Scheibe ein ganzes Geviert breit ist: die Schriften oben und
// Emoji. Zwei davon brauchen 2em, zwei lateinische Grossbuchstaben rund 1.4em.
// Die Tastenkappe (U+20E3) steht eigens da: ihr Emoji beginnt mit einer Ziffer,
// `#` oder `*`, und an denen ist die Breite nicht zu erkennen.
// HALBBREITE Formen (U+FF61-FFDC: Katakana und Hangul-Jamo) gehoeren zu
// denselben Schriften, sind aber ein halbes Geviert breit - zwei passen (#1464).
const FULL_WIDTH = /(?![\uFF61-\uFFDC])[\p{scx=Hangul}\p{scx=Han}\p{scx=Hiragana}\p{scx=Katakana}\p{Extended_Pictographic}\p{Regional_Indicator}\u20E3]/u;

// Was ausser `\p{M}` an seinem Vorgaenger haengt (UAX #29, Extend): der
// Verbinder und der Nichtverbinder (U+200D, U+200C), Hauttoene, die halbbreiten
// Truebungszeichen (U+FF9E, U+FF9F - Buchstaben der Kategorie Lm, aber
// Grapheme_Extend) und die Tag-Zeichen, aus denen die Flaggen von England,
// Schottland und Wales bestehen (U+E0020-E007F). Ohne die letzten zerfiel so
// eine Flagge im Rueckfall in sieben Teile, und auf der Scheibe blieb die
// schwarze Flagge (#1464).
const EXTENDS = /^[\p{M}\u200C\u200D\p{Emoji_Modifier}\uFF9E\uFF9F\u{E0020}-\u{E007F}]$/u;

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
 * das zweite Zeichen einer Flagge, die Tag-Zeichen einer Regionalflagge, der
 * Konsonant hinter einem Virama, die Jamo einer zerlegten Hangul-Silbe),
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
      EXTENDS.test(cp)
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

// Was auf einer Scheibe etwas sagt: ein Buchstabe, eine Ziffer, ein Emoji
// (auch die Tastenkappe, die mit `#` oder `*` beginnt). Alles andere -
// Satzzeichen, Klammern, unsichtbare Richtungszeichen - nicht.
const MEANINGFUL = /^(?:[\p{L}\p{N}\p{Extended_Pictographic}\p{Regional_Indicator}]|[#*]️?⃣)/u;

// Schriften, deren Buchstaben sich verbinden: zwei Initialen nebeneinander
// laesen sich als ein Wort.
const JOINING = /^[\p{Script=Arabic}\p{Script=Syriac}\p{Script=Nko}]/u;
const GEORGIAN = /^\p{Script=Georgian}/u;

/** Ein Zeichen, gross - und danach immer noch EIN Zeichen. */
function upper(char) {
  if (!char || GEORGIAN.test(char)) return char ?? '';
  const up = char.toUpperCase();
  if (up === char) return char;
  const parts = graphemes(up);
  if (parts.length === 1) return up;
  return parts.find((part) => /\p{Lu}/u.test(part)) ?? parts[0];
}

/** Zwei Zeichen nebeneinander, ohne dass sie sich zu einem Wort verbinden. */
function pair(first, second) {
  if (!first || !second) return `${first ?? ''}${second ?? ''}`;
  return JOINING.test(first) && JOINING.test(second) ? `${first}‌${second}` : `${first}${second}`;
}

/**
 * Zerlegt einen Namen in das, woraus Initialen und ihre Ausweichformen
 * entstehen.
 *
 * @returns {null | { cjk: boolean, words: string[][] }} `words`: je Wort seine
 *   Zeichen, ab dem ersten, das etwas sagt; Woerter ohne ein solches fehlen.
 */
function parse(name) {
  const raw = String(name ?? '').trim().split(/\s+/u).filter(Boolean).map(graphemes);
  if (!raw.length) return null;
  const said = raw
    .map((chars) => chars.slice(Math.max(0, chars.findIndex((char) => MEANINGFUL.test(char)))))
    .filter((chars) => MEANINGFUL.test(chars[0] ?? ''));
  // Ein Name NUR aus Satzzeichen: dann sein erstes Zeichen, wie bisher - eine
  // leere Scheibe sagte noch weniger.
  const words = said.length ? said : raw;
  const cjk = words.length <= 2 && words.every((chars) => chars.every((char) => CJK.test(char)));
  return { cjk, words };
}

function baseOf(parsed) {
  const { cjk, words } = parsed;
  // Regel 2 und 3: der Rufname ist das einzige Wort oder das zweite von zweien.
  if (cjk) return words[words.length - 1].slice(-2).join('');
  if (words.length === 1) return upper(words[0][0]);
  // Regel 1: erstes und letztes Wort.
  return pair(upper(words[0][0]), upper(words[words.length - 1][0]));
}

/**
 * Die Ausweichformen eines Namens, in der Reihenfolge, in der er sie nimmt.
 */
function variantsOf(parsed) {
  const { cjk, words } = parsed;
  if (cjk) {
    const all = words.flat();
    return all.length > 2 ? [pair(all[0], all[all.length - 1])] : [];
  }
  const letters = (chars) => chars.filter((char) => MEANINGFUL.test(char));
  const first = letters(words[0]);
  const last = words.length > 1 ? letters(words[words.length - 1]) : [];
  const lead = upper(first[0]);
  return [...first.slice(1), ...last.slice(1)].map((char) => pair(lead, upper(char)));
}

/** Der Schluessel, unter dem ein Name im Haushalt steht: ohne Rand- und Doppel-Leerraum. */
const keyOf = (name) => String(name ?? '').trim().split(/\s+/u).filter(Boolean).join(' ');

function resolve(names) {
  const keys = [...new Set((Array.isArray(names) ? names : []).map(keyOf).filter(Boolean))].sort();
  const people = keys.map((key) => {
    const parsed = parse(key);
    return { key, base: baseOf(parsed), variants: variantsOf(parsed) };
  });

  const groups = new Map();
  for (const person of people) {
    if (!groups.has(person.base)) groups.set(person.base, []);
    groups.get(person.base).push(person);
  }

  // Vergeben ist zuerst, was irgendjemand nach der einfachen Regel traegt -
  // eine Ausweichform darf niemandem die Zeichen nehmen, auch keinem, der am
  // Ende bei seinen bleibt.
  const taken = new Set(groups.keys());
  const result = new Map(people.map((person) => [person.key, person.base]));

  for (const base of [...groups.keys()].sort()) {
    const group = groups.get(base);
    if (group.length < 2) continue;
    // `keys` ist sortiert, also ist es jede Gruppe auch.
    for (const person of group) {
      const free = person.variants.find((text) => !taken.has(text));
      if (free === undefined) continue;
      result.set(person.key, free);
      taken.add(free);
    }
  }
  return { result, groups: [...groups.values()] };
}

/**
 * Die Zeichen fuer jeden Namen einer Liste, so dass sich zwei Personen mit
 * gleichen Initialen unterscheiden. Regel: siehe Dateikopf, "Gleiche Initialen
 * im Haushalt". Das Ergebnis haengt nur an der MENGE der Namen, nicht an ihrer
 * Reihenfolge.
 *
 * @param {Array<string|null|undefined>} names
 * @returns {Map<string, string>} Name (ohne ueberzaehligen Leerraum) -> Zeichen
 */
export function resolveInitials(names) {
  return resolve(names).result;
}

const isWidePair = (chars) => chars.length === 2 && chars.every((char) => FULL_WIDTH.test(char));

/**
 * Die Zeichen fuer die KLEINE Scheibe, fuer alle, die in einer Kollisionsgruppe
 * stehen und zwei Geviert-Zeichen tragen: je Person EINES ihrer beiden, und in
 * der Gruppe jedes nur einmal.
 *
 * WARUM NICHT EINFACH "DAS LETZTE" ODER "DAS ERSTE". Die kleine Scheibe nimmt
 * sonst das letzte Zeichen (siehe `compactInitials`). In einer Gruppe ist aber
 * mal das eine, mal das andere das gemeinsame: nach Regel 2 und 3 unterscheidet
 * das erste (김수, 박수), nach der Wortregel das letzte (김진, 김아 - Review zu
 * #1690: die erste Fassung nahm unbedingt das erste). Darum: unterscheidet
 * das letzte Zeichen alle, nehmen es alle; sonst das erste, wenn das alle
 * unterscheidet. Reicht keine Seite fuer sich (ab drei Personen), nimmt jede
 * in Namensfolge ihr letztes Zeichen und, ist das schon vergeben, ihr erstes.
 * `test:initials` haelt an einer Namensmenge, dass damit jede Gruppe
 * unterschieden ist, in der es ueberhaupt eine solche Zuordnung gibt.
 *
 * Wer NICHT in einer Kollisionsgruppe steht, kommt hier nicht vor: 민수 und
 * 지수 zeigen beide 수, wie vor dieser Regel.
 *
 * @param {Array<{ key: string, full: string }>} group  in Namensfolge
 * @returns {Map<string, string>} Name -> Zeichen
 */
function compactGroup(group) {
  const people = group
    .map((person) => ({ key: person.key, chars: graphemes(person.full) }))
    .filter((person) => isWidePair(person.chars))
    // Das letzte Zeichen zuerst: es ist die Regel der kleinen Scheibe.
    .map((person) => ({ key: person.key, options: [person.chars[1], person.chars[0]] }));

  // Unterscheidet EINE Seite alle, nehmen alle diese Seite - 김 und 박 statt
  // 김 und 수.
  for (const side of [0, 1]) {
    const chars = people.map((person) => person.options[side]);
    if (new Set(chars).size === chars.length) return new Map(people.map((person, i) => [person.key, chars[i]]));
  }

  // Keine Seite reicht fuer sich (김수, 민수, 민아): in Namensfolge nimmt jede
  // ihr letztes Zeichen, und ist das in der Gruppe schon vergeben, ihr erstes.
  const taken = new Set();
  const out = new Map();
  for (const person of people) {
    const char = person.options.find((option) => !taken.has(option)) ?? person.options[0];
    taken.add(char);
    out.set(person.key, char);
  }
  return out;
}

let roster = null;
let compactRoster = null;

/**
 * Uebernimmt die Namen aller Konten aus einer Auth-Antwort (`initialsRoster`).
 *
 * Ein fehlender Wert setzt NICHT zurueck, aus demselben Grund wie bei
 * `setHouseholdSize()`: eine aeltere Antwort (ein Client, der waehrend eines
 * Updates offen bleibt) liesse die Zeichen sonst fuer einen Seitenaufruf
 * umspringen.
 *
 * @param {string[]|undefined} names
 */
export function setInitialsRoster(names) {
  if (!Array.isArray(names)) return;
  const { result, groups } = resolve(names);
  roster = result;
  compactRoster = new Map();
  for (const group of groups) {
    if (group.length < 2) continue;
    const shown = compactGroup(group.map((person) => ({ key: person.key, full: result.get(person.key) })));
    for (const [key, char] of shown) compactRoster.set(key, char);
  }
}

/** Setzt den Haushalt beim Abmelden zurueck - der naechste Nutzer hat seinen eigenen. */
export function clearInitialsRoster() {
  roster = null;
  compactRoster = null;
}

/**
 * Die Zeichen fuer die Avatar-Scheibe eines Namens. Regel: siehe Dateikopf.
 * Steht der Name im Haushalt (`setInitialsRoster`), gelten dessen Zeichen.
 *
 * Das Ergebnis ist TEXT, kein Markup - wer es in einen HTML-String setzt,
 * schickt es durch `esc()`.
 *
 * @param {string|null|undefined} name
 * @param {string} [fallback]  Was bei leerem Namen auf der Scheibe steht.
 * @returns {string}
 */
export function initials(name, fallback = '') {
  const parsed = parse(name);
  if (!parsed) return fallback;
  return roster?.get(keyOf(name)) ?? (baseOf(parsed) || fallback);
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
  if (!isWidePair(chars)) return full;
  // In einer Kollisionsgruppe das Zeichen, das dort unterscheidet (compactGroup).
  return compactRoster?.get(keyOf(name)) ?? chars[1];
}
