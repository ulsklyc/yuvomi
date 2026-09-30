/**
 * Modul: Test-Infrastruktur - Woerterbuch-Zugriff auf die docs/-Seiten.
 * Zweck: Die Seiten unter `docs/` tragen ihre Uebersetzungen als Objektliteral
 *        im Quelltext (`en: { key:'…' }` / `de: { … }`). Zwei Guard-Suiten
 *        lesen dieselben Bloecke: `test-docs-landing.js` prueft sie gegen sich
 *        selbst, `test-readme-consistency.js` gegen die beiden READMEs.
 * Ausfuehren: keine eigene Suite - Helfer, importiert von den Guard-Suiten.
 *
 * WARUM HIER UND NICHT ZWEIMAL: dieses Repo hat schon zweimal erlebt, dass zwei
 * Kopien desselben Musters zwei VERSCHIEDENE Blindstellen behalten (siehe den
 * Kopf von `css-rules.js`). Ein Wert-Extraktor, der in einer Suite Entities
 * aufloest und in der anderen nicht, vergleicht in genau einer davon gegen
 * einen Text, den niemand geschrieben hat.
 */

/**
 * Der Rumpf eines Woerterbuch-Blocks (`en: { … }` / `de: { … }`).
 * Leerer String, wenn der Block fehlt - der Aufrufer entscheidet, ob das ein
 * Befund ist.
 */
export function dictBlock(html, lang) {
  const m = html.match(new RegExp(`\\n\\s*${lang}: \\{\\n([\\s\\S]*?)\\n\\s*\\}`));
  return m ? m[1] : '';
}

/**
 * Ein einzelner Wert aus einem Block, roh (Entities noch drin, Markup noch drin).
 *
 * Das Muster laesst `\\'` im Wert zu, weil englische Werte Apostrophe tragen
 * ("your family's data"). Ein naives `'([^']*)'` schnitte dort mitten im Satz ab
 * und der Guard vergliche gegen einen halben String.
 */
export function dictValue(block, key) {
  // Beide Quote-Arten: Werte mit Apostroph stehen in doppelten Anfuehrungszeichen
  // (`ho_2_b:"...kid's..."`). Nur `'` zu lesen hiess, genau diese 14 Werte gab es
  // fuer jeden Guard nicht - null statt Text, und der Guard lief still vorbei.
  const m = block.match(new RegExp(`\\b${key}:(?:'((?:[^'\\\\]|\\\\.)*)'|"((?:[^"\\\\]|\\\\.)*)")`));
  return m ? (m[1] ?? m[2]) : null;
}

/**
 * Die Escapes eines JS-String-Literals aufloesen: `\'`, `\\` und `\uXXXX`.
 *
 * Noetig, weil `dictValue` den ROHEN Literalrumpf zurueckgibt. Wer ihn ohne
 * diesen Schritt gegen gerenderten Text vergleicht, misst `child\u2019s` gegen
 * `child’s` und meldet eine Abweichung, die es nicht gibt.
 */
export function unescapeJs(s) {
  return s
    .replace(/\\u([0-9a-fA-F]{4})/g, (_, h) => String.fromCharCode(parseInt(h, 16)))
    .replace(/\\(['"\\])/g, '$1');
}

/** Alle Schluessel eines Blocks, die auf ein gegebenes Muster passen. */
export function dictKeysMatching(block, pattern) {
  return [...block.matchAll(/(?:^|[{,]\s*)\s*([a-z][a-z0-9_]*)\s*:\s*['"]/gm)]
    .map((m) => m[1])
    .filter((k) => pattern.test(k));
}

/**
 * Entities aufloesen. `&amp;` MUSS zuletzt kommen: stuende es vorn, wuerde
 * `&amp;lt;` erst zu `&lt;` und dann zu `<` - also doppelt aufgeloest.
 * (CodeQL js/double-escaping, PR #782.)
 */
export function decodeEntities(s) {
  return s
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&nbsp;|\u00a0/g, ' ')
    .replace(/&amp;/g, '&');
}

/**
 * Markup aus einem Woerterbuchwert schneiden, damit der reine Text uebrig bleibt.
 *
 * Als Fixpunkt und nicht als ein Durchlauf: `<scr<b>ipt>` setzt beim
 * Herausschneiden des inneren Tags ein neues `<script>` zusammen, das der erste
 * Lauf nie gesehen hat. Hier wird eine Repo-Datei gelesen und das Ergebnis nur
 * verglichen, nie als HTML geschrieben - aber ein SCHNITT, der unvollstaendig
 * ist, laesst den Guard ueber einen Text urteilen, den es so nicht gibt.
 * Dasselbe Muster und derselbe Grund wie in `test/source-text.js`.
 * (CodeQL js/incomplete-multi-character-sanitization, PR #788.)
 */
export function stripTags(s) {
  let out = s;
  let prev;
  do { prev = out; out = out.replace(/<[^>]+>/g, ''); } while (out !== prev);
  return decodeEntities(out).replace(/\s+/g, ' ').trim();
}
