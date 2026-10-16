/**
 * Modul: Kommentare beim Ausliefern entfernen (Critique R19, docs/DECISIONS.md #13)
 * Zweck: Der Quelltext unter public/ bleibt kommentiert; was das Haus verlaesst,
 *        nicht. Rund 59 % des CSS und 41 % des JS sind Kommentar, und nach
 *        Brotli sind es noch mehr: deutscher Fliesstext packt schlechter als Code.
 * Abhaengigkeiten: keine
 *
 * KEIN BUILD-SCHRITT. Die Dateien liegen im Image, wie sie im Repo stehen; der
 * Server schneidet beim ersten Abruf und haelt das Ergebnis im Speicher
 * (utils/static-assets.js). Wer eine Datei im Container oeffnet, liest sie mit
 * Begruendung.
 *
 * DIE ZEILEN BLEIBEN. Ein Kommentar ueber mehrere Zeilen wird zu ebenso vielen
 * Zeilenumbruechen; eine Zeile, die nur Kommentar war, bleibt leer stehen.
 * Damit zeigt jeder Stacktrace und jede Zeile im Browser-Inspektor auf dieselbe
 * Zeile im Repo - ein Fehlerbericht bleibt lesbar. Leere Zeilen kosten nach
 * Brotli fast nichts.
 *
 * WAS STEHEN BLEIBT: `/*!`-Kommentare und solche mit `@license` oder
 * `@preserve` (Lizenzhinweise gehoeren zur Kopie). Gevendorter Code wird gar
 * nicht angefasst, das entscheidet der Aufrufer.
 *
 * JS: EIN DURCHGANG MIT ZUSTAENDEN. Code, Zeichenkette, Template-Literal samt
 * `${}`-Ersetzung (beliebig tief), Regex-Literal mit Zeichenklassen und
 * Escapes. Ob ein `/` ein Regex-Literal oeffnet oder teilt, entscheidet das
 * Token davor, wie in jedem Tokenizer ohne Parser:
 *   - nach einem Wert (Bezeichner, Zahl, Literal, `]`) teilt es;
 *   - nach einem Schluesselwort, das einen Ausdruck erwartet (`return`,
 *     `typeof`, `case` ...), und nach jedem anderen Operator oeffnet es;
 *   - nach `)` oeffnet es nur, wenn die Klammer zu `if`, `while`, `for` oder
 *     `with` gehoert;
 *   - nach `}` oeffnet es, wenn die Klammer einen Block schloss, und teilt,
 *     wenn sie ein Objekt-Literal schloss.
 * Belegt wird das nicht durch diese Regeln, sondern durch den Vergleich mit
 * einem echten Parser: `npm run test:strip-comments` legt fuer JEDE
 * ausgelieferte .js-Datei die gefundenen Kommentare neben die von acorn (aus
 * Node selbst) und prueft jedes Ergebnis mit `node --check`.
 *
 * CSS: Zeichenkette, `url(` ohne Anfuehrungszeichen (dort ist `/*` Teil der
 * Adresse) und Escapes. Ein Kommentar trennt in CSS Token, ohne Leerraum zu
 * sein: `.a/* x *\/.b` ist `.a.b`, nicht `.a .b`. Er wird deshalb nur dann
 * durch Zeilenumbrueche ersetzt, wenn neben ihm ohnehin Leerraum steht; sonst
 * faellt er ganz weg, und zwischen zwei Zeichen, die verschmelzen koennten,
 * bleibt ein leeres `/**\/`.
 */

const LINE_TERMINATOR = /[\n\r\u2028\u2029]/;
const HSPACE = /[ \t]/;

/** Ein Kommentar, der bleiben muss. */
function keepComment(text) {
  return text.startsWith('/*!') || /@license|@preserve/.test(text);
}

/** Nur die Zeilenumbrueche eines Kommentars, in ihrer Schreibweise. */
function lineBreaksOf(text) {
  return text.replace(/\r\n/g, '\n').replace(/[^\n\r\u2028\u2029]/g, '');
}

/** Schreibpuffer, der Leerraum am Ende billig zurueckschneiden kann. */
function createOut() {
  const parts = [];
  return {
    push(text) { if (text) parts.push(text); },
    /** Leerzeichen und Tabs am Ende entfernen (nur Code-Zusammenhang). */
    trimEnd() {
      while (parts.length) {
        const last = parts[parts.length - 1];
        let k = last.length;
        while (k > 0 && HSPACE.test(last[k - 1])) k -= 1;
        if (k === last.length) return;
        if (k > 0) { parts[parts.length - 1] = last.slice(0, k); return; }
        parts.pop();
      }
    },
    lastChar() {
      for (let i = parts.length - 1; i >= 0; i -= 1) if (parts[i]) return parts[i][parts[i].length - 1];
      return '';
    },
    toString() { return parts.join(''); },
  };
}

// --------------------------------------------------------
// JavaScript
// --------------------------------------------------------

/** Nach diesen Woertern beginnt ein Ausdruck: ein `/` oeffnet ein Regex-Literal. */
const EXPRESSION_KEYWORDS = new Set([
  'await', 'case', 'delete', 'do', 'else', 'extends', 'in', 'instanceof', 'new', 'of',
  'return', 'throw', 'typeof', 'void', 'yield',
]);
/** Vor dieser `(` steht eine Bedingung: nach ihrer `)` beginnt eine Anweisung. */
const CONDITION_KEYWORDS = new Set(['if', 'while', 'for', 'with']);
/** Nach diesen Woertern oeffnet `{` einen Block, kein Objekt-Literal. */
const BLOCK_KEYWORDS = new Set(['do', 'else', 'try', 'finally', 'static']);

const isIdentStart = (c) => /[A-Za-z_$\u0080-￿]/.test(c);
const isIdentPart = (c) => /[\w$\u0080-￿‌‍]/.test(c);

/**
 * Laeuft einmal ueber die Quelle und meldet jeden Kommentar.
 * @param {string} src
 * @returns {Array<{ start: number, end: number, block: boolean }>}
 */
export function jsCommentRanges(src) {
  const n = src.length;
  const comments = [];
  // Was zuletzt kam: 'start' | 'value' | 'op' | 'keyword-expr' | 'paren-cond' | 'brace-block'
  let prev = 'start';
  // Letztes Wort (Bezeichner oder Schluesselwort), fuer `(` und `{`.
  let lastWord = '';
  // Das Satzzeichen davor, wenn das letzte Token eines war; sonst ''.
  let lastPunct = '';
  const parens = [];   // je `(`: ob sie eine Bedingung umschliesst
  const braces = [];   // je `{`: 'block' | 'expr' | 'template'
  let i = 0;

  const regexAllowed = () => prev === 'start' || prev === 'op' || prev === 'keyword-expr'
    || prev === 'paren-cond' || prev === 'brace-block';

  /** Ein Template ab `j` (hinter dem Backtick oder hinter `}`), bis Backtick oder `${`. */
  function scanTemplate(j) {
    while (j < n) {
      const c = src[j];
      if (c === '\\') { j += 2; continue; }
      if (c === '`') { prev = 'value'; lastPunct = ''; lastWord = ''; return j + 1; }
      if (c === '$' && src[j + 1] === '{') { braces.push('template'); prev = 'op'; lastPunct = '${'; lastWord = ''; return j + 2; }
      j += 1;
    }
    return n;
  }

  while (i < n) {
    const c = src[i];
    const d = src[i + 1];

    if (c === '/' && d === '/') {
      let j = i + 2;
      while (j < n && !LINE_TERMINATOR.test(src[j])) j += 1;
      comments.push({ start: i, end: j, block: false });
      i = j;
      continue;
    }
    if (c === '/' && d === '*') {
      const close = src.indexOf('*/', i + 2);
      const end = close === -1 ? n : close + 2;
      comments.push({ start: i, end, block: true });
      i = end;
      continue;
    }
    if (c === ' ' || c === '\t' || LINE_TERMINATOR.test(c) || c === ' ' || c === '﻿' || c === '\v' || c === '\f') {
      i += 1;
      continue;
    }
    if (c === '"' || c === "'") {
      let j = i + 1;
      while (j < n && src[j] !== c) {
        if (src[j] === '\\') j += 2;
        else if (src[j] === '\n' || src[j] === '\r') break;
        else j += 1;
      }
      i = j + 1;
      prev = 'value';
      lastPunct = '';
      lastWord = '';
      continue;
    }
    if (c === '`') {
      i = scanTemplate(i + 1);
      continue;
    }
    if (c === '/' && regexAllowed()) {
      let j = i + 1;
      let inClass = false;
      while (j < n) {
        const z = src[j];
        if (z === '\\') { j += 2; continue; }
        if (LINE_TERMINATOR.test(z)) break;
        if (inClass) { if (z === ']') inClass = false; }
        else if (z === '[') inClass = true;
        else if (z === '/') { j += 1; break; }
        j += 1;
      }
      while (j < n && isIdentPart(src[j])) j += 1;
      i = j;
      prev = 'value';
      lastPunct = '';
      lastWord = '';
      continue;
    }
    if (isIdentStart(c) || (c === '\\' && d === 'u')) {
      let j = i;
      while (j < n && (isIdentPart(src[j]) || (src[j] === '\\' && src[j + 1] === 'u'))) j += src[j] === '\\' ? 2 : 1;
      const word = src.slice(i, j);
      // `x.return` ist eine Eigenschaft, kein Schluesselwort.
      const afterDot = lastPunct === '.';
      lastPunct = '';
      lastWord = afterDot ? '' : word;
      prev = !afterDot && EXPRESSION_KEYWORDS.has(word) ? 'keyword-expr' : 'value';
      i = j;
      continue;
    }
    if (/[0-9]/.test(c) || (c === '.' && /[0-9]/.test(d ?? ''))) {
      let j = i + 1;
      while (j < n && /[\w.]/.test(src[j])) {
        // Exponent mit Vorzeichen: 1e-5
        if ((src[j] === 'e' || src[j] === 'E') && (src[j + 1] === '+' || src[j + 1] === '-') && !/^0[xXbBoO]/.test(src.slice(i, j))) j += 2;
        else j += 1;
      }
      i = j;
      prev = 'value';
      lastWord = '';
      lastPunct = '';
      continue;
    }
    if (c === '(') {
      parens.push(CONDITION_KEYWORDS.has(lastWord) && prev !== 'op');
      prev = 'op';
      lastWord = '';
      lastPunct = '(';
      i += 1;
      continue;
    }
    if (c === ')') {
      prev = parens.pop() ? 'paren-cond' : 'value';
      lastWord = '';
      lastPunct = ')';
      i += 1;
      continue;
    }
    if (c === '{') {
      // Block: am Anfang, nach `;`, `{`, `}`, `)`, `=>`, nach einem Bezeichner
      // (Klassenrumpf) oder Block-Schluesselwort. Sonst ein Ausdruck.
      const block = prev === 'start' || prev === 'brace-block' || prev === 'paren-cond'
        || (prev === 'value' && lastWord !== '' && !EXPRESSION_KEYWORDS.has(lastWord))
        || BLOCK_KEYWORDS.has(lastWord) || lastPunct === ';' || lastPunct === '=>' || lastPunct === ')' || lastPunct === '{' || lastPunct === '}';
      braces.push(block ? 'block' : 'expr');
      prev = block ? 'brace-block' : 'op';
      lastWord = '';
      lastPunct = '{';
      i += 1;
      continue;
    }
    if (c === '}') {
      const kind = braces.pop();
      lastWord = '';
      lastPunct = '}';
      if (kind === 'template') { i = scanTemplate(i + 1); continue; }
      prev = kind === 'block' ? 'brace-block' : 'value';
      i += 1;
      continue;
    }
    if (c === ']') {
      prev = 'value';
      lastWord = '';
      lastPunct = ']';
      i += 1;
      continue;
    }
    // Uebrige Satzzeichen: Operatoren. `++`/`--` nach einem Wert sind Postfix,
    // danach teilt ein `/`.
    if ((c === '+' || c === '-') && d === c) {
      if (prev !== 'value') prev = 'op';
      lastWord = '';
      lastPunct = c + c;
      i += 2;
      continue;
    }
    if (c === '=' && d === '>') {
      prev = 'op';
      lastWord = '';
      lastPunct = '=>';
      i += 2;
      continue;
    }
    if (c === ';') {
      prev = 'start';
      lastWord = '';
      lastPunct = ';';
      i += 1;
      continue;
    }
    prev = 'op';
    lastWord = '';
    lastPunct = c;
    i += 1;
  }
  return comments;
}

/**
 * Entfernt die Kommentare einer JS-Quelle; Zeilen bleiben, wo sie waren.
 * @param {string} src
 * @returns {string}
 */
export function stripJsComments(src) {
  const ranges = jsCommentRanges(src);
  const out = createOut();
  let pos = 0;
  for (const { start, end, block } of ranges) {
    const text = src.slice(start, end);
    out.push(src.slice(pos, start));
    pos = end;
    if (block && keepComment(text)) { out.push(text); continue; }
    out.trimEnd();
    if (!block) continue; // der Zeilenumbruch dahinter bleibt stehen
    const breaks = lineBreaksOf(text);
    if (breaks) { out.push(breaks); continue; }
    const after = src[end];
    // Ohne Umbruch trennt ein Leerzeichen, was der Kommentar trennte
    // (`1/**//2` darf nicht zu `1//2` werden).
    if (after !== undefined && !HSPACE.test(after) && !LINE_TERMINATOR.test(after)) out.push(' ');
  }
  out.push(src.slice(pos));
  return out.toString();
}

// --------------------------------------------------------
// CSS
// --------------------------------------------------------

/**
 * Kommentare einer CSS-Quelle.
 * @param {string} src
 * @returns {Array<{ start: number, end: number }>}
 */
export function cssCommentRanges(src) {
  const n = src.length;
  const comments = [];
  let i = 0;
  while (i < n) {
    const c = src[i];
    if (c === '\\') { i += 2; continue; }
    if (c === '/' && src[i + 1] === '*') {
      const close = src.indexOf('*/', i + 2);
      const end = close === -1 ? n : close + 2;
      comments.push({ start: i, end });
      i = end;
      continue;
    }
    if (c === '"' || c === "'") {
      let j = i + 1;
      while (j < n && src[j] !== c) {
        if (src[j] === '\\') j += 2;
        else if (src[j] === '\n' || src[j] === '\r' || src[j] === '\f') break;
        else j += 1;
      }
      i = j + 1;
      continue;
    }
    // url( ohne Anfuehrungszeichen: alles bis `)` ist Adresse.
    if ((c === 'u' || c === 'U') && /^url\(/i.test(src.slice(i, i + 4)) && !/[\w-]/.test(src[i - 1] ?? '')) {
      let j = i + 4;
      while (j < n && /[ \t\n\r\f]/.test(src[j])) j += 1;
      if (src[j] !== '"' && src[j] !== "'") {
        while (j < n && src[j] !== ')') j += src[j] === '\\' ? 2 : 1;
        i = j + 1;
        continue;
      }
      i += 4;
      continue;
    }
    i += 1;
  }
  return comments;
}

const CSS_SPACE = /[ \t\n\r\f]/;
/** Neben diesen Zeichen kann nichts verschmelzen, ein Kommentar faellt ersatzlos weg. */
const CSS_DELIMITER = /[{}();:,>[\]"']/;

/**
 * Entfernt die Kommentare einer CSS-Quelle, ohne ein Token zu veraendern.
 * @param {string} src
 * @returns {string}
 */
export function stripCssComments(src) {
  const out = createOut();
  let pos = 0;
  for (const { start, end } of cssCommentRanges(src)) {
    const text = src.slice(start, end);
    out.push(src.slice(pos, start));
    pos = end;
    if (keepComment(text)) { out.push(text); continue; }
    const before = out.lastChar() || '\n';
    const after = src[end] ?? '\n';
    const breaks = lineBreaksOf(text);
    if (CSS_SPACE.test(before) || CSS_SPACE.test(after)) {
      // Leerraum steht ohnehin daneben: Umbrueche aendern nichts an der Trennung.
      if (breaks || LINE_TERMINATOR.test(after)) out.trimEnd();
      out.push(breaks);
      continue;
    }
    if (CSS_DELIMITER.test(before) || CSS_DELIMITER.test(after)) continue;
    out.push('/**/');
  }
  out.push(src.slice(pos));
  return out.toString();
}
