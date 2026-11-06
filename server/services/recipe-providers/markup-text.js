/**
 * Modul: Markup -> Klartext fuer gespiegelte Rezepte
 * Zweck: Mealies Zubereitungsschritte sind Markdown mit eingebettetem HTML
 *        (der Editor legt ein eingefuegtes Bild als <img src="/api/media/...">
 *        ab). Yuvomis `notes` ist Klartext und wird per textContent mit
 *        white-space: pre-wrap gezeigt; ein Tag stuende dort woertlich (#2558).
 *        Deshalb wird beim Spiegeln serverseitig in lesbaren Text ueberfuehrt,
 *        statt im Browser HTML zu rendern (kein innerHTML, keine Bibliothek).
 *
 *        Bilder fallen weg, in HTML wie in Markdown: ihre src ist ein Pfad auf
 *        dem Mealie-Server (relativ, hinter dessen Auth), im Browser weder
 *        ladbar noch durch die CSP (img-src) gedeckt, und als Text waere sie
 *        eine tote Adresse. Das Rezept verlinkt ohnehin auf das Original.
 *        Links bleiben als "Text (URL)", wenn die URL absolut http(s) ist,
 *        sonst nur ihr Text.
 *
 *        Bewusst klein: kein vollstaendiger Markdown- oder HTML-Parser, nur
 *        was Rezeptschritte tatsaechlich tragen. Entities werden ZULETZT
 *        aufgeloest, damit ein kodiertes "&lt;b&gt;" Text bleibt und nicht
 *        als Tag entfernt wird.
 * Dependencies: keine
 */

const NAMED_ENTITIES = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ',
  ndash: '-', mdash: '-', hellip: '...', deg: '°', frac12: '½', frac14: '¼', frac34: '¾',
  times: '×', middot: '·', laquo: '«', raquo: '»', bdquo: '„', ldquo: '“', rdquo: '”', lsquo: '‘', rsquo: '’',
};

function decodeEntities(text) {
  return text.replace(/&(#x[0-9a-f]+|#\d+|[a-z][a-z0-9]*);/gi, (match, body) => {
    if (body[0] === '#') {
      const code = body[1] === 'x' || body[1] === 'X' ? parseInt(body.slice(2), 16) : parseInt(body.slice(1), 10);
      if (!Number.isFinite(code) || code <= 0 || code > 0x10ffff) return match;
      return code === 0xa0 ? ' ' : String.fromCodePoint(code);
    }
    const named = NAMED_ENTITIES[body.toLowerCase()];
    return named ?? match;
  });
}

/**
 * Ersetzt so lange, bis sich nichts mehr aendert: ein einzelner Durchgang
 * laesst aus verschachteltem Markup ("<<script>script>") einen neuen Tag
 * stehen (CodeQL js/incomplete-multi-character-sanitization).
 */
function replaceUntilStable(text, pattern, replacement) {
  let prev;
  let next = text;
  do {
    prev = next;
    next = prev.replace(pattern, replacement);
  } while (next !== prev);
  return next;
}

function linkText(text, url) {
  const label = text.trim();
  const href = String(url || '').trim();
  if (/^https?:\/\//i.test(href) && href !== label) return label ? `${label} (${href})` : href;
  return label;
}

/**
 * Markdown/HTML eines Rezepttexts als Klartext. Zeilenumbrueche bleiben,
 * Leerzeilen werden auf eine zusammengezogen, Raender getrimmt; leerer
 * Rest ergibt ''.
 */
export function markupToText(input) {
  let s = String(input ?? '').replace(/\r\n?/g, '\n');
  if (!s.trim()) return '';

  // Markdown-Autolinks ("<https://...>") sind kein Tag: die URL bleibt.
  s = s.replace(/<(https?:\/\/[^\s<>]+)>/gi, '$1');

  // Kommentare und Bilder zuerst - beide tragen nichts Lesbares.
  s = replaceUntilStable(s, /<!--[\s\S]*?-->/g, '');
  s = replaceUntilStable(s, /<img\b[^>]*>/gi, '');
  s = s.replace(/!\[[^\]]*\]\([^)]*\)/g, '');

  // Links: HTML und Markdown.
  s = s.replace(/<a\b[^>]*?\bhref\s*=\s*(["'])(.*?)\1[^>]*>([\s\S]*?)<\/a>/gi, (_m, _q, href, text) => linkText(replaceUntilStable(text, /<[^>]*>/g, ''), href));
  s = s.replace(/\[([^\]]*)\]\(([^)\s]*)(?:\s+"[^"]*")?\)/g, (_m, text, href) => linkText(text, href));

  // Blockgrenzen in HTML werden Zeilenumbrueche, Listenpunkte "- ".
  s = s.replace(/<br\s*\/?>/gi, '\n');
  s = s.replace(/<li\b[^>]*>/gi, '\n- ');
  s = s.replace(/<\/?(?:p|div|ul|ol|li|h[1-6]|blockquote|pre|tr|table|section|article)\b[^>]*>/gi, '\n');
  // Restliche Tags weg (nur echte Tags: "<" direkt gefolgt von Buchstabe oder "/").
  s = replaceUntilStable(s, /<\/?[a-z][^>]*>/gi, '');
  // Was danach noch einen Tag oeffnen koennte (ein "<" vor Buchstabe, "/", "!"
  // oder "?", etwa aus einem nie geschlossenen "<script"), verliert sein "<".
  // Ein freistehendes "2 < 3" bleibt; kodierte Zeichen ("&lt;b&gt;") werden
  // erst danach aufgeloest und sind gewollter Text. notes geht im Frontend
  // ohnehin per textContent hinaus - das hier haelt den Spiegel frei von Markup.
  s = s.replace(/<(?=[a-z/!?])/gi, '');

  // Markdown je Zeile: Ueberschriften, Zitate, Listenmarker, Trennlinien.
  s = s.split('\n').map((line) => line
    .replace(/^\s{0,3}#{1,6}\s+/, '')
    .replace(/\s+#+\s*$/, '')
    .replace(/^\s{0,3}>\s?/, '')
    .replace(/^(\s*)[*+]\s+/, '$1- ')
    .replace(/^\s*(?:[-*_]\s*){3,}$/, ''))
    .join('\n');

  // Markdown-Escapes ("\*") vorher maskieren, damit ein escaptes Zeichen
  // keine Hervorhebung oeffnet oder schliesst; danach als Zeichen zurueck.
  const escaped = [];
  s = s.replace(/\\([\\`*_{}[\]()#+\-.!>~|])/g, (_m, ch) => `\uE000${escaped.push(ch) - 1}\uE001`);

  // Hervorhebungen: **x**, __x__, *x*, _x_ (nicht innerhalb von Woertern), `x`.
  s = s.replace(/(\*\*|__)(?=\S)([\s\S]*?\S)\1/g, '$2');
  s = s.replace(/(^|[^\w*])\*(?=\S)([^*\n]*?\S)\*(?![\w*])/g, '$1$2');
  s = s.replace(/(^|[^\w])_(?=\S)([^_\n]*?\S)_(?!\w)/g, '$1$2');
  s = s.replace(/~~(?=\S)([^~\n]*?\S)~~/g, '$1');
  s = s.replace(/`([^`\n]+)`/g, '$1');
  s = s.replace(/\uE000(\d+)\uE001/g, (_m, i) => escaped[Number(i)]);

  s = decodeEntities(s);

  return s.split('\n')
    .map((line) => line.replace(/[ \t ]+/g, ' ').trim())
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/**
 * Portionen einer Quelle als recipes.servings: nur eine ganze Zahl 1-99
 * (dieselbe Grenze wie die CHECK-Bedingung und die Rezept-Route), sonst
 * null. Mealie defaultet auf 0 fuer "keine Angabe"; einen Bruch zu runden
 * hiesse, die Basis des Portions-Reglers zu verschieben.
 */
export function servingsFrom(value) {
  return typeof value === 'number' && Number.isInteger(value) && value >= 1 && value <= 99 ? value : null;
}
