/**
 * Modul: Test-Infrastruktur - Kaskaden-Guard fuer das `hidden`-Attribut (#1340).
 * Zweck: Ein Element, das der Code mit `hidden` ausblendet, bleibt sichtbar,
 *        sobald eine Autorenregel auf ihm `display` setzt. Das UA-Stylesheet
 *        traegt `[hidden] { display: none }` auf der untersten Ebene, und JEDE
 *        Autorenregel schlaegt es - `display: grid`, `flex`, `block`, gleich
 *        welche Spezifitaet. Dieser Guard verlangt fuer jedes solche Element eine
 *        `[hidden]`-Regel mit `display: none`, die es wieder herunterholt.
 * Ausfuehren: node --test test/test-hidden-cascade.js
 *
 * WARUM EIN TEST UND KEINE KONVENTION. Die Konvention steht in fuenf Kommentaren
 * (budget.css, category-manager.css, housekeeping.css, calendar.css,
 * inventory.css) und wurde trotzdem wieder und wieder gebrochen. Jedes Mal
 * erreichte das Symptom einen Menschen vor einem Test: ein Bedienelement, das
 * weg sein sollte, steht da und nimmt Eingaben an. Nichts wirft, nichts loggt,
 * das Attribut ist wirklich gesetzt - nur ein Screenshot widerspricht. Zuletzt
 * PR #1257: `<div class="inventory-form-row" id="inv-odometer-group" hidden>`
 * gegen `.inventory-form-row { display: grid }`, gefunden im Review, waehrend
 * test:frontend-audit, test:module-write-access und test:detail-view gruen waren.
 *
 * DREI LESER, EIN URTEIL.
 *
 *   1. Welche Elemente werden ausgeblendet? Zwei Wege:
 *      - `hidden` im Markup (index.html und jedes String-/Template-Literal unter
 *        `public/`), auch bedingt als `${x ? '' : 'hidden'}`;
 *      - `X.hidden = ...` im JS. X wird zurueckverfolgt: `getElementById`,
 *        `querySelector(All)`, `closest`, `$`/`$$`, die Bindung, die AN DIESER
 *        STELLE gilt (nicht irgendeine gleichnamige in der Datei), for-of- und
 *        forEach-Parameter ueber eine Liste, `document.createElement` samt
 *        `className`/`id`/`classList.add`. Der gefundene Selektor wird im
 *        Markup-Index nachgeschlagen, damit das Element seine GANZE
 *        Klassenliste mitbringt: `#inv-odometer-group` allein trifft keine
 *        `.inventory-form-row`-Regel.
 *   2. Welche Regeln setzen `display` auf etwas anderes als `none`? Gelesen
 *      ueber `eachRule()` aus test/css-rules.js, nie ueber ein eigenes Regex.
 *   3. Welche `[hidden]`-Regeln mit `display: none` holen es zurueck?
 *
 * WAS NICHT AUFLOESBAR IST, WIRD GEZAEHLT, NICHT UEBERSPRUNGEN. Ein Parameter
 * einer Hilfsfunktion (`function show(el) { el.hidden = false }`) ist statisch
 * nicht zu verfolgen. Die Suite nennt jede solche Stelle als Diagnose und
 * haelt den Anteil der aufgeloesten Stellen ueber einer Schwelle: ein Leser,
 * der still die Haelfte seines Gegenstands verliert, ist genau die Bauart, die
 * dieses Ticket beschreibt.
 *
 * ZWEI LESER, DIE GLEICH ENG SIND, HEBEN SICH AUF (#1324). Deshalb hat jede
 * Seite ihren eigenen Reichweiten-Nachweis, und jeder Leser wird an
 * ERFUNDENER Eingabe geprueft, nicht nur am Baum. Ein Sammler, der nichts
 * liefert, sieht am echten Baum genauso aus wie ein Baum ohne Befund.
 *
 * BEKANNTE GRENZEN, festgenagelt statt verschwiegen:
 *   - Keine Spezifitaets- oder Reihenfolgepruefung. Der Guard verlangt, dass
 *     eine passende `[hidden]`-Regel EXISTIERT, nicht, dass sie gewinnt. Eine
 *     Rettung `.a[hidden]` (0,2,0) gegen `.x .y .a { display: flex }` (0,3,0)
 *     bestaende ihn, obwohl sie verliert.
 *   - Eine Rettung, die das Element beim Namen nennt (`.modal-panel
 *     .js-entry-field[hidden]`), zaehlt ohne Nachweis ihres Vorfahren. Eine
 *     Rettung OHNE Namen (`.tasks-toolbar [hidden]`) braucht dagegen den
 *     Nachweis, dass das Element unter diesem Vorfahren steht - sonst waere
 *     eine einzige solche Regel eine Generalabsolution fuer die ganze App.
 *   - Markup, das per `+` aus Stuecken zusammengesetzt wird
 *     (`'<fieldset' + (x ? ' hidden' : '') + '>'`), ist fuer den Markup-Leser
 *     kein Tag. Und eine ID, die eine Hilfsfunktion als Parameter einsetzt
 *     (`fabHtml(id)` in utils/fab.js), laesst sich nicht mit der ID an der
 *     Aufrufstelle verbinden - deshalb haengt kein `.page-fab`-Element an
 *     diesem Guard. `.page-fab[hidden]` haelt weiter test:budget-ui.
 *   - Inline-`style` und `style.display` aus JS bleiben aussen vor (#1340,
 *     "Out of scope"), ebenso `visibility` und `opacity`.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { eachRule } from './css-rules.js';
import { withoutCommentsKeepingLines } from './source-text.js';

const PUBLIC = new URL('../public/', import.meta.url);
const STYLES = new URL('../public/styles/', import.meta.url);

/* ===========================================================================
 * Literale und Klammern
 * ======================================================================== */

const IDENT = /[\w$]/;
const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const TEMPLATE_HOLE = /\$\{[^}]*\}/g;

/** Index hinter dem String-/Template-Literal ab `i`, samt `${...}` und Verschachtelung. */
function endOfLiteral(src, i) {
  const quote = src[i];
  let j = i + 1;
  while (j < src.length) {
    const c = src[j];
    if (c === '\\') { j += 2; continue; }
    if (c === quote) return j + 1;
    if (quote !== '`' && c === '\n') return j;
    if (quote === '`' && c === '$' && src[j + 1] === '{') { j = endOfSubstitution(src, j + 2); continue; }
    j += 1;
  }
  return src.length;
}

/** Index hinter der `}`, die eine bei `i` beginnende `${`-Ersetzung schliesst. */
function endOfSubstitution(src, i) {
  let depth = 0;
  let j = i;
  while (j < src.length) {
    const c = src[j];
    if (c === '"' || c === "'" || c === '`') { j = endOfLiteral(src, j); continue; }
    if (c === '{') depth += 1;
    else if (c === '}') { if (depth === 0) return j + 1; depth -= 1; }
    j += 1;
  }
  return src.length;
}

/** Index der passenden schliessenden Klammer zu `src[open]`. */
function closingBracket(src, open) {
  const close = { '(': ')', '[': ']', '{': '}' }[src[open]];
  let depth = 0;
  let j = open;
  while (j < src.length) {
    const c = src[j];
    if (c === '"' || c === "'" || c === '`') { j = endOfLiteral(src, j); continue; }
    if (c === src[open]) depth += 1;
    else if (c === close && --depth === 0) return j;
    j += 1;
  }
  return src.length;
}

/** Index der passenden oeffnenden Klammer zu `src[close]`, rueckwaerts gelesen. */
function openingBracket(src, close) {
  const open = { ')': '(', ']': '[' }[src[close]];
  let depth = 0;
  for (let j = close; j >= 0; j -= 1) {
    const c = src[j];
    if (c === '"' || c === "'" || c === '`') {
      j = src.lastIndexOf(c, j - 1);
      if (j < 0) return -1;
      continue;
    }
    if (c === src[close]) depth += 1;
    else if (c === open && --depth === 0) return j;
  }
  return -1;
}

/** Auf oberster Ebene an Kommas trennen (Klammern und Literale bleiben ganz). */
function topLevelSplit(text) {
  const parts = [];
  let depth = 0;
  let from = 0;
  let j = 0;
  while (j < text.length) {
    const c = text[j];
    if (c === '"' || c === "'" || c === '`') { j = endOfLiteral(text, j); continue; }
    if ('([{'.includes(c)) depth += 1;
    else if (')]}'.includes(c)) depth -= 1;
    else if (c === ',' && depth === 0) { parts.push(text.slice(from, j).trim()); from = j + 1; }
    j += 1;
  }
  parts.push(text.slice(from).trim());
  return parts.filter(Boolean);
}

/** Index des Anweisungsendes ab `from`: `;`, Zeilenende oder Komma auf oberster Ebene. */
function statementEnd(src, from) {
  let depth = 0;
  let j = from;
  while (j < src.length) {
    const c = src[j];
    if (c === '"' || c === "'" || c === '`') { j = endOfLiteral(src, j); continue; }
    if ('([{'.includes(c)) depth += 1;
    else if (')]}'.includes(c)) { if (depth === 0) return j; depth -= 1; }
    else if (depth === 0 && (c === ';' || c === '\n' || c === ',')) return j;
    j += 1;
  }
  return src.length;
}

/** Zeilennummer (ab 1) zu einem Index - ueber die Zeilenanfaenge, nicht ueber `split` je Aufruf. */
function lineCounter(src) {
  const starts = [0];
  for (let i = src.indexOf('\n'); i >= 0; i = src.indexOf('\n', i + 1)) starts.push(i + 1);
  return (at) => {
    let lo = 0;
    let hi = starts.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (starts[mid] <= at) lo = mid; else hi = mid - 1;
    }
    return lo + 1;
  };
}

/** Der Inhalt aller String-Literale eines Ausdrucks; Template-Ersetzungen werden Leerraum. */
function stringContents(expr) {
  const out = [];
  let j = 0;
  while (j < expr.length) {
    const c = expr[j];
    if (c === '"' || c === "'" || c === '`') {
      const end = endOfLiteral(expr, j);
      const body = expr.slice(j + 1, end - 1);
      out.push(c === '`' ? body.replace(TEMPLATE_HOLE, ' ') : body);
      j = end;
      continue;
    }
    j += 1;
  }
  return out;
}

/* ===========================================================================
 * Leser 1a: `X.hidden = ...` im JS
 * ======================================================================== */

/** Nach diesen Woertern ist eine Klammer eine Bedingung, kein Aufruf. */
const KEYWORDS = new Set([
  'if', 'while', 'for', 'switch', 'catch', 'return', 'typeof', 'await', 'case', 'do',
  'else', 'in', 'of', 'new', 'delete', 'void', 'yield', 'throw', 'instanceof',
]);

/**
 * Die Member-/Aufrufkette, die vor dem `.` bei `at` steht - `root.querySelector('.x')`
 * in `root.querySelector('.x').hidden`. Eine Klammer, die kein Aufruf ist, gehoert
 * nur dann dazu, wenn die Kette noch leer ist (`(a || b).hidden`); sonst ist sie
 * die Bedingung davor (`if (x) x.hidden = ...`) und beendet die Kette.
 */
function chainBefore(src, at) {
  let i = at - 1;
  let start = at;
  for (;;) {
    while (i >= 0 && /\s/.test(src[i])) i -= 1;
    if (i < 0) break;
    const c = src[i];
    if (c === ')' || c === ']') {
      const open = openingBracket(src, i);
      if (open < 0) break;
      let k = open - 1;
      while (k >= 0 && /\s/.test(src[k])) k -= 1;
      let word = '';
      for (let w = k; w >= 0 && IDENT.test(src[w]); w -= 1) word = src[w] + word;
      const isCall = k >= 0 && ((word && !KEYWORDS.has(word)) || src[k] === ')' || src[k] === ']');
      if (!isCall) {
        if (start === at) start = open;
        break;
      }
      start = open;
      i = open - 1;
    } else if (IDENT.test(c)) {
      while (i >= 0 && IDENT.test(src[i])) i -= 1;
      start = i + 1;
    } else if (c === '.') {
      i -= src[i - 1] === '?' ? 2 : 1;
      start = i + 1;
    } else {
      break;
    }
  }
  return src.slice(start, at).trim();
}

/** Jede Schreibstelle `X.hidden = ...` (nicht `==`/`===`), mit Kette X. */
function hiddenWrites(src) {
  return [...src.matchAll(/\.hidden\s*=(?!=)/g)].map((m) => ({ index: m.index, expr: chainBefore(src, m.index) }));
}

/** Umschliesst der Block, in dem `from` steht, noch die Stelle `to`? */
function blockEncloses(src, from, to) {
  let depth = 0;
  let j = from;
  while (j < to) {
    const c = src[j];
    if (c === '"' || c === "'" || c === '`') { j = endOfLiteral(src, j); continue; }
    if (c === '{') depth += 1;
    else if (c === '}' && --depth < 0) return false;
    j += 1;
  }
  return true;
}

/** Rumpf ab `from`: `{...}` oder ein Ausdruck bis zum Anweisungsende. */
function bodyRange(src, from) {
  let j = from;
  while (j < src.length && /\s/.test(src[j])) j += 1;
  return src[j] === '{' ? [j, closingBracket(src, j)] : [j, statementEnd(src, j)];
}

/**
 * Alle Bindungen eines Namens. `value`: Deklaration oder Zuweisung, gilt bis zum
 * Ende ihres Blocks. `item`: ein Element einer Liste (for-of, forEach-Parameter),
 * gilt nur im Rumpf der Schleife.
 */
function bindingsOf(src, name) {
  const n = escapeRe(name);
  const out = [];
  const valueRe = new RegExp(`(?:^|[;{}(\\s])(?:(?:const|let|var)\\s+)?(?<![\\w$.])${n}\\s*=(?![=>])\\s*`, 'g');
  for (const m of src.matchAll(valueRe)) {
    const from = m.index + m[0].length;
    out.push({ kind: 'value', index: m.index, init: src.slice(from, statementEnd(src, from)).trim() });
  }
  for (const m of src.matchAll(new RegExp(`for\\s*\\(\\s*(?:const|let|var)\\s+${n}\\s+of\\s+`, 'g'))) {
    const open = src.indexOf('(', m.index);
    const close = closingBracket(src, open);
    out.push({ kind: 'item', index: m.index, list: src.slice(m.index + m[0].length, close).trim(), body: bodyRange(src, close + 1) });
  }
  const forEachRe = new RegExp(`\\.forEach\\(\\s*(?:\\(\\s*${n}\\s*(?:,[^)]*)?\\)|${n})\\s*=>`, 'g');
  for (const m of src.matchAll(forEachRe)) {
    out.push({ kind: 'item', index: m.index, list: chainBefore(src, m.index), body: bodyRange(src, m.index + m[0].length) });
  }
  return out;
}

/**
 * Die Bindung von `name`, die an der Stelle `at` gilt: die naechste davor, deren
 * Geltungsbereich `at` noch umschliesst. Ein Name kann in einer Datei zwanzigmal
 * gebunden sein (`host`, `form`, `hint`) - die Vereinigung aller Bindungen meldete
 * ein Element, das an dieser Stelle nie gemeint war.
 */
function bindingAt(src, name, at) {
  return bindingsOf(src, name)
    .filter((b) => b.index < at && (b.kind === 'value'
      ? blockEncloses(src, b.index, at)
      : b.body[0] <= at && at <= b.body[1]))
    .sort((a, b) => b.index - a.index)[0] ?? null;
}

/** Der letzte Aufruf einer Kette: `a.b.querySelector('.x')[0]` -> querySelector + Argumente. */
function lastCall(expr) {
  const e = expr.trim().replace(/\s*\[\s*\d+\s*\]$/, '');
  if (!e.endsWith(')')) return null;
  const open = openingBracket(e, e.length - 1);
  if (open <= 0) return null;
  const before = e.slice(0, open).trimEnd();
  const callee = /[\w$]+$/.exec(before)?.[0];
  if (!callee) return null;
  return {
    callee,
    receiver: before.slice(0, -callee.length).replace(/\.\s*$/, '').trim(),
    args: topLevelSplit(e.slice(open + 1, -1)),
  };
}

const SELECTOR_CALLS = new Set(['getElementById', 'querySelector', 'querySelectorAll', 'closest', '$', '$$']);

/**
 * Die moeglichen Stringwerte eines Ausdrucks, oder null. Liest Literale,
 * Bindungen auf Literale und ein Element einer Literal-Liste
 * (`['#a', '#b'].forEach((sel) => ...)`). Ein Template mit Ersetzung liefert
 * seine Form mit `${}` als Platzhalter - so trifft `#${prefix}-rrule-details`
 * das Markup `id="${prefix}-rrule-details"`.
 */
function stringValues(expr, src, at, seen = new Set()) {
  const e = expr.trim();
  const literal = /^(['"`])([^'"`]*)\1$/.exec(e);
  if (literal) return [literal[2].replace(TEMPLATE_HOLE, '${}')];
  if (!/^[\w$]+$/.test(e) || seen.has(e)) return null;
  seen.add(e);
  const binding = bindingAt(src, e, at);
  if (!binding) return null;
  if (binding.kind === 'value') return stringValues(binding.init, src, binding.index, seen);
  const list = /^\[([\s\S]*)\]$/.exec(binding.list);
  if (!list) return null;
  const values = topLevelSplit(list[1]).map((item) => /^(['"])([^'"]*)\1$/.exec(item)?.[2]);
  return values.every((v) => v !== undefined) ? values : null;
}

/**
 * Worauf zeigt ein Ausdruck? Liefert `{ selector }` oder `{ node }` (fuer ein per
 * createElement gebautes Element), oder null, wenn es statisch nicht zu sagen ist.
 */
function targetsOf(expr, src, at, seen = new Set()) {
  const e = expr.trim().replace(/\?\./g, '.').replace(/\s*\[\s*\d+\s*\]$/, '');
  if (!e || seen.has(e)) return null;
  seen.add(e);
  const spread = /^\[\s*\.\.\.([\s\S]+)\]$/.exec(e);
  if (spread) return targetsOf(spread[1], src, at, seen);
  const call = lastCall(e);
  if (call) {
    if (call.callee === 'from' && /(?:^|\.)Array$/.test(call.receiver)) return targetsOf(call.args[0] ?? '', src, at, seen);
    if (!SELECTOR_CALLS.has(call.callee)) return null;
    const values = stringValues(call.args[0] ?? '', src, at);
    if (!values) return null;
    return values.map((v) => ({ selector: call.callee === 'getElementById' ? `#${v}` : v }));
  }
  if (!/^[\w$]+$/.test(e)) return null;
  const binding = bindingAt(src, e, at);
  if (!binding) return null;
  if (binding.kind === 'item') return targetsOf(binding.list, src, binding.index, seen);
  if (lastCall(binding.init)?.callee === 'createElement') return [{ node: createdNode(src, e, binding) }];
  return targetsOf(binding.init, src, binding.index, seen);
}

/**
 * Ein per `document.createElement` gebautes Element: Tag aus dem Aufruf, Klassen
 * und ID aus den Schreibstellen, an denen DIESE Bindung gilt.
 */
function createdNode(src, name, binding) {
  const tag = stringValues(lastCall(binding.init)?.args[0] ?? '', src, binding.index)?.[0]?.toLowerCase() ?? null;
  const node = { tag, id: null, classes: [], attrs: null, ancestors: null, hidden: false, origin: 'createElement', at: binding.index };
  const writes = new RegExp(`(?<![\\w$.])${escapeRe(name)}\\s*\\.\\s*(className|id|classList\\s*\\.\\s*(?:add|toggle))\\s*(=(?!=)|\\()`, 'g');
  for (const m of src.matchAll(writes)) {
    if (m.index < binding.index || bindingAt(src, name, m.index)?.index !== binding.index) continue;
    const from = m.index + m[0].length;
    const rhs = m[2] === '(' ? src.slice(from, closingBracket(src, from - 1)) : src.slice(from, statementEnd(src, from));
    if (m[1] === 'id') {
      const id = stringValues(rhs, src, m.index)?.[0];
      if (id && /^(?:[\w-]|\$\{\})+$/.test(id)) node.id = id;
    } else {
      const args = m[1].endsWith('toggle') ? topLevelSplit(rhs).slice(0, 1) : [rhs];
      for (const token of args.flatMap(stringContents).flatMap((s) => s.split(/\s+/))) {
        if (/^[\w-]+$/.test(token) && !node.classes.includes(token)) node.classes.push(token);
      }
    }
  }
  return node;
}

/* ===========================================================================
 * Leser 1b: Markup
 * ======================================================================== */

const VOID_ELEMENTS = new Set(['area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta', 'param', 'source', 'track', 'wbr']);

/** Oeffnende und schliessende Tags einer Markup-Quelle, in Reihenfolge. */
function scanTags(src) {
  const tags = [];
  let i = 0;
  while (i < src.length) {
    const lt = src.indexOf('<', i);
    if (lt < 0) break;
    const head = src.slice(lt, lt + 64);
    const closing = /^<\/([a-zA-Z][\w-]*)\s*>/.exec(head);
    if (closing) {
      tags.push({ closing: closing[1].toLowerCase(), index: lt });
      i = lt + closing[0].length;
      continue;
    }
    const open = /^<([a-zA-Z][\w-]*)/.exec(head);
    if (!open) { i = lt + 1; continue; }
    let j = lt + open[0].length;
    while (j < src.length && src[j] !== '>' && src[j] !== '<') {
      if (src[j] === '$' && src[j + 1] === '{') { j = endOfSubstitution(src, j + 2); continue; }
      if (src[j] === '"' || src[j] === "'") {
        const q = src.indexOf(src[j], j + 1);
        j = q < 0 ? src.length : q + 1;
        continue;
      }
      j += 1;
    }
    if (src[j] !== '>') { i = lt + 1; continue; }
    tags.push({ tag: open[1].toLowerCase(), attrs: src.slice(lt + open[0].length, j), index: lt, selfClosing: src[j - 1] === '/' });
    i = j + 1;
  }
  return tags;
}

/** Wert eines Attributs, Template-Ersetzungen eingeschlossen; null, wenn es fehlt. */
function attrValue(attrs, name) {
  const re = new RegExp(`(?:^|[\\s"'\`])${name}\\s*=\\s*(["'])((?:\\$\\{[^}]*\\}|(?!\\1)[\\s\\S])*?)\\1`, 'i');
  return re.exec(attrs)?.[2] ?? null;
}

/** Klassen aus einem class-Wert: die statischen Teile und jeder String in einer Ersetzung. */
function classTokens(value) {
  if (!value) return [];
  const tokens = value.replace(TEMPLATE_HOLE, ' ').split(/\s+/);
  for (const hole of value.match(TEMPLATE_HOLE) ?? []) tokens.push(...stringContents(hole).flatMap((s) => s.split(/\s+/)));
  return [...new Set(tokens.filter((t) => /^[\w-]+$/.test(t)))];
}

/**
 * Traegt der Attributtext ein `hidden`? Auch bedingt: `${x ? '' : 'hidden'}` und
 * `${x ? '' : ' hidden'}`, und ueber eine Variable (`${hidden}` mit
 * `const hidden = aktiv ? '' : 'hidden'`) - `resolveHole` liefert deren Strings.
 * Nicht: `aria-hidden`, `data-hidden`, eine Klasse namens `hidden` oder das Wort
 * in einem Attributwert.
 */
function hasHiddenAttr(attrs, resolveHole = () => []) {
  const flat = attrs.replace(TEMPLATE_HOLE, (hole) => {
    const ident = /^\$\{\s*([\w$]+)\s*\}$/.exec(hole)?.[1];
    return ` ${[...stringContents(hole), ...(ident ? resolveHole(ident) : [])].join(' ')} `;
  });
  const bare = flat.replace(/=\s*(["'])[\s\S]*?\1/g, '=');
  return /(?:^|[^\w-])hidden(?![\w-])/.test(bare);
}

/** Bereiche, in denen Markup stehen kann: jedes aeussere Literal einer JS-Datei mit einem `<`. */
function literalRanges(src) {
  const ranges = [];
  let j = 0;
  while (j < src.length) {
    const c = src[j];
    if (c === '"' || c === "'" || c === '`') {
      const end = endOfLiteral(src, j);
      if (src.slice(j, end).includes('<')) ranges.push([j, end]);
      j = end;
      continue;
    }
    j += 1;
  }
  return ranges;
}

/**
 * Jedes Element im Markup einer Quelle, mit seinen Vorfahren. Die Vorfahren
 * zaehlen nur innerhalb DESSELBEN aeusseren Literals: ein Template, das ein
 * `<div>` oeffnet, das ein anderes schliesst, darf nicht jedes spaetere
 * Element der Datei zu seinem Kind machen - das waere ein erfundener Vorfahr,
 * und ein erfundener Vorfahr ist eine erfundene Rettung.
 */
function markupNodes(src, file, { html = false } = {}) {
  const nodes = [];
  const lineOf = lineCounter(src);
  const ranges = html ? [[0, src.length]] : literalRanges(src);
  for (const [from, to] of ranges) {
    const stack = [];
    for (const t of scanTags(src.slice(from, to))) {
      if (t.closing) {
        const k = stack.findLastIndex((s) => s.tag === t.closing);
        if (k >= 0) stack.length = k;
        continue;
      }
      const rawId = attrValue(t.attrs, 'id');
      const id = rawId && /^(?:[\w-]|\$\{[^}]*\})+$/.test(rawId) ? rawId.replace(TEMPLATE_HOLE, '${}') : null;
      const node = {
        file,
        line: lineOf(from + t.index),
        tag: t.tag,
        id,
        classes: classTokens(attrValue(t.attrs, 'class')),
        attrs: t.attrs,
        hidden: hasHiddenAttr(t.attrs, (ident) => {
          const binding = bindingAt(src, ident, from + t.index);
          return binding?.kind === 'value' ? stringContents(binding.init) : [];
        }),
        ancestors: stack.map(({ tag, id: aid, classes, attrs }) => ({ tag, id: aid, classes, attrs })),
        origin: 'markup',
      };
      nodes.push(node);
      if (!VOID_ELEMENTS.has(t.tag) && !t.selfClosing) stack.push(node);
    }
  }
  return nodes;
}

/* ===========================================================================
 * Leser 2 und 3: Stylesheets
 * ======================================================================== */

/** Selektor in seine Compounds zerlegen, an Kombinatoren ausserhalb von Klammern. */
function compoundsOf(selector) {
  const parts = [];
  let depth = 0;
  let from = 0;
  for (let i = 0; i < selector.length; i += 1) {
    const c = selector[i];
    if (c === '(' || c === '[') depth += 1;
    else if (c === ')' || c === ']') depth -= 1;
    else if (depth === 0 && /[\s>+~]/.test(c)) {
      if (i > from) parts.push(selector.slice(from, i));
      while (i + 1 < selector.length && /[\s>+~]/.test(selector[i + 1])) i += 1;
      from = i + 1;
    }
  }
  if (from < selector.length) parts.push(selector.slice(from));
  return parts;
}

/** Ein Compound in Tag, IDs, Klassen, Attribute und Pseudoklassen. */
function parseCompound(raw) {
  const c = { raw, tag: null, ids: [], classes: [], attrs: [], pseudos: [], pseudoElement: false };
  let i = 0;
  const name = () => {
    const m = /^(?:[\w-]|\$\{\})+/.exec(raw.slice(i))?.[0] ?? '';
    i += m.length;
    return m;
  };
  while (i < raw.length) {
    const ch = raw[i];
    if (ch === '.') { i += 1; c.classes.push(name()); }
    else if (ch === '#') { i += 1; c.ids.push(name()); }
    else if (ch === '[') {
      const end = raw.indexOf(']', i);
      c.attrs.push(raw.slice(i + 1, end).trim());
      i = end + 1;
    } else if (ch === ':') {
      if (raw[i + 1] === ':') { c.pseudoElement = true; i += 1; }
      i += 1;
      const pseudo = { name: name(), args: null };
      if (raw[i] === '(') {
        const end = closingBracket(raw, i);
        pseudo.args = raw.slice(i + 1, end);
        i = end + 1;
      }
      c.pseudos.push(pseudo);
    } else if (ch === '*') {
      i += 1;
      c.tag ??= '*';
    } else if (/[\w-]/.test(ch)) {
      // Erst lesen, dann zuweisen: `c.tag ??= name()` liesse den Namen ungelesen,
      // sobald ein Tag steht, und die Schleife kaeme nie vom Fleck.
      const tag = name().toLowerCase();
      c.tag ??= tag;
    } else {
      i += 1;
    }
  }
  return c;
}

/** Die letzte `display`-Deklaration eines Regelrumpfs, oder null. */
function lastDisplay(body) {
  const decls = [...body.matchAll(/(?:^|;)\s*display\s*:\s*([^;]+)/g)];
  if (!decls.length) return null;
  const value = decls.at(-1)[1].trim();
  return { display: value.replace(/!\s*important/i, '').trim().toLowerCase(), important: /!\s*important/i.test(value) };
}

/** Jede Regel mit `display`, je Einzelselektor, samt Subjekt und Vorfahren-Compounds. */
function displayRules(css, file) {
  const rules = [];
  for (const rule of eachRule(css)) {
    const decl = lastDisplay(rule.body);
    if (!decl) continue;
    for (const selector of topLevelSplit(rule.selector)) {
      const parts = compoundsOf(selector);
      rules.push({
        file,
        selector,
        ...decl,
        at: rule.at,
        subject: parseCompound(parts.at(-1)),
        ancestors: parts.slice(0, -1).map(parseCompound),
      });
    }
  }
  return rules;
}

/* ===========================================================================
 * Urteil
 * ======================================================================== */

/**
 * VORFAHREN, DIE ERST ZUR LAUFZEIT ENTSTEHEN - die Ausnahmekarte.
 *
 * Eine Rettung ohne Namen (`.settings-page [hidden]`) braucht den Nachweis, dass
 * das Element unter ihrem Vorfahren steht. Der Markup-Leser findet ihn nur im
 * selben Literal. Wo der Vorfahr im JS entsteht und alles aus einem Verzeichnis
 * in ihn hinein rendert, steht er hier - je Eintrag mit Grund, und nur, wenn der
 * Grund fuer JEDE Datei des Musters gilt. Ein Eintrag, der das nicht tut, ist
 * eine Generalabsolution und gehoert geloescht.
 */
const RUNTIME_ANCESTORS = new Map([
  ['.settings-page', {
    files: /^settings\//,
    reason: "settings/shell.js setzt `page.className = 'page settings-page'` auf den "
      + 'Seitencontainer, und jedes Blatt unter settings/ rendert in diese Shell.',
  }],
]);

/** Zustaende, die ein Element mit `display: none` nie haben kann. */
const UNREACHABLE_STATES = new Set(['hover', 'focus', 'focus-visible', 'focus-within', 'active']);

const carriesHidden = (c) => c.attrs.includes('hidden');
const excludesHidden = (c) => c.pseudos.some((p) => p.name === 'not' && /\[\s*hidden\s*\]/.test(p.args ?? ''));
const namesElement = (c) => c.classes.length > 0 || c.ids.length > 0;

/** Trifft ein Compound ein Element? Unbekanntes am Element zaehlt als Treffer. */
function compoundMatches(c, el, { strictTag = false } = {}) {
  if (c.classes.some((x) => !el.classes.includes(x))) return false;
  if (c.ids.some((x) => x !== el.id)) return false;
  if (c.tag && c.tag !== '*' && (el.tag ? el.tag !== c.tag : strictTag)) return false;
  if (el.attrs != null) {
    for (const attr of c.attrs) {
      const attrName = /^[\w-]+/.exec(attr)?.[0];
      if (attrName && attrName !== 'hidden' && !new RegExp(`(?:^|[\\s"'\`])${attrName}(?![\\w-])`).test(el.attrs)) return false;
    }
  }
  for (const p of c.pseudos) {
    if (p.name !== 'not' || !p.args) continue;
    const inner = p.args.trim();
    if (/^\.[\w-]+$/.test(inner) && el.classes.includes(inner.slice(1))) return false;
    if (/^#[\w-]+$/.test(inner) && el.id === inner.slice(1)) return false;
  }
  return true;
}

/** Steht das Element nachweislich unter einem Vorfahren, der auf `c` passt? */
function underAncestor(c, el, runtimeAncestors) {
  if (el.ancestors?.some((a) => compoundMatches(c, a, { strictTag: true }))) return true;
  const runtime = runtimeAncestors.get(c.raw);
  return Boolean(runtime && el.file && runtime.files.test(el.file));
}

/** Trifft die Regel das Element - mit Namen direkt, ohne Namen nur unter nachgewiesenem Vorfahren? */
function ruleHits(rule, el, runtimeAncestors) {
  return namesElement(rule.subject)
    ? compoundMatches(rule.subject, el)
    : compoundMatches(rule.subject, el, { strictTag: true }) && rule.ancestors.every((a) => underAncestor(a, el, runtimeAncestors));
}

/**
 * Regeln, die `display` auf etwas anderes als `none` setzen und das Element
 * treffen. Nennt das Subjekt eine Klasse oder ID des Elements, zaehlen seine
 * Vorfahren nicht - lieber ein Fehlalarm als ein blinder Fleck. Nennt es keine
 * (`.x span`, `yuvomi-datepicker`), muessen die Vorfahren nachgewiesen sein,
 * sonst traefe `.x span` jedes versteckte `<span>` der App.
 */
function offendersFor(el, rules, runtimeAncestors = RUNTIME_ANCESTORS) {
  return rules.filter((r) => r.display !== 'none'
    && !carriesHidden(r.subject) && !excludesHidden(r.subject) && !r.subject.pseudoElement
    && !r.subject.pseudos.some((p) => UNREACHABLE_STATES.has(p.name))
    && ruleHits(r, el, runtimeAncestors));
}

/**
 * `[hidden]`-Regeln mit `display: none`, die das Element zurueckholen. Mit Namen
 * im Subjekt genuegt der Name; ohne Namen (`.tasks-toolbar [hidden]`) muss der
 * Vorfahr nachgewiesen sein.
 */
function rescuesFor(el, rules, runtimeAncestors = RUNTIME_ANCESTORS) {
  return rules.filter((r) => r.display === 'none' && carriesHidden(r.subject) && ruleHits(r, el, runtimeAncestors));
}

const describe = (el) => `${el.tag ?? '?'}${el.id ? `#${el.id}` : ''}${el.classes.map((c) => `.${c}`).join('')}`;
const elementKey = (el) => `${el.file}:${el.line ?? ''}|${describe(el)}`;

/**
 * Ein Befund als Text, fuer jemanden, der diese Kaskade nie getroffen hat.
 *
 * DER RAT IST TEIL DES GUARDS. Fuer den Andock-Slot des Routers (`dockSlot`)
 * waere die uebliche Paarung genau der falsche Fix: `.page-toolbar__actions[hidden]`
 * haette den dort angedockten "Neues Rezept"-Knopf versteckt (Review zu #1347).
 * Dort lautet der Rat deshalb, den Slot gar nicht auszublenden.
 */
function report({ el, sites, offenders }, { dockSlot = null } = {}) {
  const setters = [...new Set(offenders.map((o) => `${o.file}: \`${o.selector} { display: ${o.display}${o.important ? ' !important' : ''} }\``))];
  const pairing = [...new Set(offenders.map((o) => `\`${o.subject.raw}[hidden] { display: none; }\``))];
  const origin = el.origin === 'markup' || el.origin === 'createElement' ? ` (${el.file}:${el.line})` : '';
  const advice = dockSlot && el.classes.includes(dockSlot)
    ? `KEINE [hidden]-Regel fuer .${dockSlot}: in diesen Slot dockt der Router den FAB, eine Rettungsregel `
      + 'versteckte ihn mit. Den eigenen Inhalt in einen eigenen Container IM Slot legen und nur den schalten.'
    : `es fehlt eine [hidden]-Regel mit display: none, die dieses Element trifft - etwa ${pairing.join(' oder ')}`;
  return `${describe(el)}${origin}\n`
    + `      ausgeblendet: ${sites.join(', ')}\n`
    + `      setzt display: ${setters.join(' | ')}\n`
    + `      ${advice}`;
}

/** Jedes ausgeblendete Element, das eine Regel sichtbar haelt und keine zurueckholt. */
function findings(elements, rules) {
  const byElement = new Map();
  for (const { el, site } of elements) {
    const offenders = offendersFor(el, rules);
    if (!offenders.length || rescuesFor(el, rules).length) continue;
    const key = elementKey(el);
    if (!byElement.has(key)) byElement.set(key, { el, sites: [], offenders });
    const entry = byElement.get(key);
    if (!entry.sites.includes(site)) entry.sites.push(site);
  }
  return [...byElement.values()];
}

/* ===========================================================================
 * Der Baum
 * ======================================================================== */

const SKIP_DIRS = new Set(['vendor', 'locales', 'icons', 'styles']);

/** HTML-Kommentare durch Leerraum ersetzen - die Zeilennummern bleiben stehen. */
const blankHtmlComments = (src) => src.replace(/<!--[\s\S]*?-->/g, (m) => m.replace(/[^\n]/g, ' '));

function publicSources(dir = PUBLIC, prefix = '') {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    if (entry.isDirectory()) {
      return SKIP_DIRS.has(entry.name) ? [] : publicSources(new URL(`${entry.name}/`, dir), `${prefix}${entry.name}/`);
    }
    if (!/\.(?:js|html)$/.test(entry.name) || entry.name === 'lucide.min.js') return [];
    const raw = readFileSync(new URL(entry.name, dir), 'utf8');
    const html = entry.name.endsWith('.html');
    return [{ file: `${prefix}${entry.name}`, html, src: html ? blankHtmlComments(raw) : withoutCommentsKeepingLines(raw) }];
  });
}

/**
 * Sammelt aus dem Baum: jedes ausgeblendete Element (mit der Stelle, die es
 * ausblendet), jede nicht aufloesbare Schreibstelle und alle Regeln.
 */
function collectTree() {
  const sources = publicSources();
  const index = [];
  for (const { file, html, src } of sources) {
    index.push(...markupNodes(src, file, { html }));
    if (html) continue;
    const lineOf = lineCounter(src);
    for (const m of src.matchAll(/(?:const|let|var)\s+([\w$]+)\s*=\s*document\s*\.\s*createElement\s*\(/g)) {
      const binding = bindingAt(src, m[1], m.index + m[0].length);
      if (!binding) continue;
      const node = { ...createdNode(src, m[1], binding), file, line: lineOf(m.index) };
      if (node.id || node.classes.length) index.push(node);
    }
  }

  const byId = new Map();
  for (const node of index) if (node.id) byId.set(node.id, [...(byId.get(node.id) ?? []), node]);

  /**
   * Die Elemente im Index, die ein Selektor meint - oder null, wenn er keines
   * benennt. Traegt die Datei der Schreibstelle selbst passendes Markup, gilt
   * nur dieses: `[data-picker-list]` steht in inventory.js UND in
   * document-attach.js, und `listEl.hidden` in inventory.js meint das eigene.
   * Erst ohne Treffer in der Datei zaehlt der ganze Baum (geteilte Komponenten).
   */
  const nodesFor = (selector, file) => {
    const subject = parseCompound(compoundsOf(selector.trim()).at(-1) ?? '');
    const matches = (n) => compoundMatches(subject, n, { strictTag: true });
    let found;
    if (subject.ids.length) found = (byId.get(subject.ids[0]) ?? []).filter(matches);
    else if (subject.classes.length) found = index.filter(matches);
    // Nur nach Attribut gesucht: nur Markup kennt seine Attribute. Ein per
    // createElement gebautes Element (attrs null) passte sonst auf JEDEN
    // Attributselektor.
    else if (subject.attrs.length) found = index.filter((n) => n.attrs != null && matches(n));
    else return null;
    const local = found.filter((n) => n.file === file);
    return local.length ? local : found;
  };

  /** Die Elemente, die eine Kette an der Stelle `at` meint - leer, wenn nicht aufloesbar. */
  const resolveChain = (file, src, lineOf, expr, at) => {
    const resolved = [];
    for (const target of targetsOf(expr, src, at) ?? []) {
      if (target.node) {
        // Das Element steht dort, wo es gebaut wird, nicht dort, wo es
        // ausgeblendet wird - sonst zaehlte jede Schreibstelle als eigenes.
        resolved.push({ ...target.node, file, line: lineOf(target.node.at) });
        continue;
      }
      const found = nodesFor(target.selector, file);
      if (found?.length) {
        resolved.push(...found);
      } else if (found) {
        // Der Selektor benennt ein Element, das kein Markup im Baum traegt
        // (etwa per Hilfsfunktion gebaut): es geht mit dem ins Urteil, was
        // der Selektor selbst sagt.
        const s = parseCompound(compoundsOf(target.selector.trim()).at(-1));
        resolved.push({ tag: s.tag, id: s.ids[0] ?? null, classes: s.classes, attrs: null, ancestors: null, file, line: lineOf(at), origin: 'selector' });
      }
    }
    return resolved;
  };

  const elements = [];
  const unresolved = [];
  const cleared = [];
  let writes = 0;
  for (const node of index) {
    if (node.hidden) elements.push({ el: node, site: `${node.file}:${node.line} (hidden im Markup)` });
  }
  for (const { file, html, src } of sources) {
    if (html) continue;
    const lineOf = lineCounter(src);
    for (const w of hiddenWrites(src)) {
      writes += 1;
      const site = `${file}:${lineOf(w.index)} (\`${w.expr.replace(/\s+/g, ' ')}.hidden = ...\`)`;
      const resolved = resolveChain(file, src, lineOf, w.expr, w.index);
      if (!resolved.length) { unresolved.push(site); continue; }
      for (const el of resolved) elements.push({ el, site });
    }
    // Wer die Kinder eines Knotens ersetzt, nimmt auch mit, was ein anderer
    // hineingehaengt hat - fuer den Andock-Slot des Routers der FAB.
    for (const m of src.matchAll(/\.replaceChildren\s*\(/g)) {
      const expr = chainBefore(src, m.index);
      const site = `${file}:${lineOf(m.index)} (\`${expr.replace(/\s+/g, ' ')}.replaceChildren(...)\`)`;
      for (const el of resolveChain(file, src, lineOf, expr, m.index)) cleared.push({ el, site });
    }
  }

  const rules = readdirSync(STYLES)
    .filter((f) => f.endsWith('.css'))
    .flatMap((f) => displayRules(readFileSync(new URL(f, STYLES), 'utf8'), f));

  return { elements, unresolved, writes, rules, index, cleared };
}

/* ===========================================================================
 * Der Andock-Slot des Routers
 * ======================================================================== */

/**
 * DER SLOT, IN DEN DER ROUTER DEN FAB DOCKT, GEHOERT NICHT DEM MODUL ALLEIN.
 *
 * Auf dem Desktop haengt dockFabIntoToolbar() (router.js) den Page-FAB in den
 * ersten `.page-toolbar__actions` unter #main-content. Blendet ein Modul diesen
 * Knoten aus, blendet es seine Primaeraktion mit aus; ersetzt es seine Kinder,
 * wirft es den FAB aus dem DOM, und kein spaeterer Router-Schritt holt ihn
 * zurueck. Beides hat die Rezepte-Seite getan, weil ihr Quellenfilter der Slot
 * WAR (Review zu #1347): ohne gespiegelte Rezepte stand der "Neues
 * Rezept"-Knopf in einem `hidden`-Container - sichtbar nur, weil
 * `.page-toolbar__actions { display: flex }` das UA-`[hidden]` schlug, und die
 * erste Rettungsregel dieser Suite fuer die Klasse hat ihn versteckt. Mit
 * gespiegelten Rezepten nahm `replaceChildren()` ihn mit, schon auf main.
 *
 * Die Klasse liest der Guard aus dockFabIntoToolbar() selbst, nicht aus einer
 * Konstante: waehlt der Router seinen Slot anders, schuetzt der Guard den neuen.
 */
function dockSlotClass(routerSrc) {
  const src = withoutCommentsKeepingLines(routerSrc);
  const start = src.indexOf('function dockFabIntoToolbar(');
  if (start < 0) return null;
  const body = src.slice(start, closingBracket(src, src.indexOf('{', start)) + 1);
  return /\bslot\s*=\s*[^;]*querySelector\(\s*(['"])\.([\w-]+)\1\s*\)/.exec(body)?.[2] ?? null;
}

/* ===========================================================================
 * Leser an erfundener Eingabe
 * ======================================================================== */

test('Markup-Leser: hidden bedingt und unbedingt, nie aria-hidden, Klassen samt Vorfahren', () => {
  const src = [
    'const a = `',
    '<section class="zz-shell">',
    '  <div class="zz-row zz-row--wide" id="zz-group" hidden></div>',
    "  <p class=\"zz-note\" ${open ? '' : 'hidden'}>x</p>",
    '  <i class="zz-icon" aria-hidden="true"></i>',
    '  <span class="hidden zz-label" data-hidden="1" title="hidden"></span>',
    "  <b class=\"zz-b ${on ? 'zz-on' : ''}\"${lastDay ? '' : ' hidden'}></b>",
    '</section>`;',
  ].join('\n');
  const nodes = markupNodes(src, 'x.js');
  const pick = (cls) => nodes.find((n) => n.classes.includes(cls));
  assert.equal(pick('zz-row').hidden, true);
  assert.equal(pick('zz-row').id, 'zz-group');
  assert.deepEqual(pick('zz-row').classes, ['zz-row', 'zz-row--wide']);
  assert.deepEqual(pick('zz-row').ancestors.map((a) => a.classes), [['zz-shell']]);
  assert.equal(pick('zz-row').line, 3);
  assert.equal(pick('zz-note').hidden, true, 'bedingtes hidden in einer Ersetzung');
  assert.equal(pick('zz-icon').hidden, false, 'aria-hidden ist kein hidden');
  assert.equal(pick('zz-label').hidden, false, 'Klasse, data- und Attributwert namens hidden zaehlen nicht');
  assert.equal(pick('zz-b').hidden, true, 'hidden mit fuehrendem Leerzeichen in der Ersetzung');
  assert.deepEqual(pick('zz-b').classes, ['zz-b', 'zz-on'], 'bedingte Klasse aus der Ersetzung');
});

test('Markup-Leser: hidden ueber eine Variable, die an DIESER Stelle gilt', () => {
  const src = [
    'function a(on) {',
    "  const hidden = on ? '' : 'hidden';",
    '  return `<section class="zz-panel" ${hidden}></section>`;',
    '}',
    'function b() {',
    "  const hidden = 'data-x';",
    '  return `<section class="zz-other" ${hidden}></section>`;',
    '}',
  ].join('\n');
  const nodes = markupNodes(src, 'x.js');
  assert.equal(nodes.find((n) => n.classes.includes('zz-panel')).hidden, true);
  assert.equal(nodes.find((n) => n.classes.includes('zz-other')).hidden, false);
});

test('Markup-Leser: ein Vorfahr aus einem ANDEREN Literal ist keiner', () => {
  const src = 'const open = `<div class="zz-outer">`;\nconst inner = `<span class="zz-inner" hidden></span>`;\n';
  const inner = markupNodes(src, 'x.js').find((n) => n.classes.includes('zz-inner'));
  assert.deepEqual(inner.ancestors, []);
});

test('JS-Leser: Kette, Bindung an der Stelle, Liste, createElement', () => {
  const src = [
    'function a(root) {',
    "  const zzHost = root.querySelector('#zz-a');",
    '  zzHost.hidden = true;',
    '}',
    'function b(root) {',
    "  const zzHost = root.querySelector('.zz-b');",
    '  if (zzHost) zzHost.hidden = false;',
    "  root.querySelector('.zz-c').querySelector('.zz-d').hidden = true;",
    "  document.getElementById('zz-e').hidden = true;",
    "  ['#zz-f', '#zz-g'].forEach((sel) => { const el = root.querySelector(sel); el.hidden = true; });",
    "  for (const row of root.querySelectorAll('.zz-h')) row.hidden = true;",
    "  const box = document.createElement('div');",
    "  box.className = 'zz-box zz-box--wide';",
    "  box.id = 'zz-box';",
    '  box.hidden = true;',
    '}',
    'function c(el) { el.hidden = true; }',
    'function d(root) {',
    "  let zzEl = root.querySelector('.zz-early');",
    '  zzEl.hidden = true;',
    "  zzEl = root.querySelector('.zz-late');",
    '  zzEl.hidden = true;',
    '}',
  ].join('\n');
  const resolved = hiddenWrites(src).map((w) => targetsOf(w.expr, src, w.index));
  assert.deepEqual(resolved.slice(0, 6).map((t) => t && t.map((x) => x.selector)), [
    ['#zz-a'], ['.zz-b'], ['.zz-d'], ['#zz-e'], ['#zz-f', '#zz-g'], ['.zz-h'],
  ], 'jede Schreibstelle meint den Selektor ihrer EIGENEN Bindung');
  assert.deepEqual(resolved[6].map((t) => ({ tag: t.node.tag, id: t.node.id, classes: t.node.classes })),
    [{ tag: 'div', id: 'zz-box', classes: ['zz-box', 'zz-box--wide'] }]);
  assert.equal(resolved[7], null, 'ein Funktionsparameter ist nicht aufloesbar - und wird nicht erfunden');
  assert.deepEqual(resolved.slice(8).map((t) => t && t.map((x) => x.selector)), [['.zz-early'], ['.zz-late']],
    'nach einer Neuzuweisung gilt die NAECHSTE Bindung davor, nicht die erste');
});

test('CSS-Leser: display je Einzelselektor, Subjekt und Vorfahren getrennt', () => {
  const css = '/* .zz-kommentar { display: flex } */\n'
    + '.zz-a, .zz-wrap > .zz-b { display: grid; }\n'
    + '@media (min-width: 40rem) { .zz-c { display: flex !important; } }\n'
    + '.zz-d[hidden] { display: none; }\n'
    + '.zz-e:not([hidden]) { display: flex; }\n';
  const rules = displayRules(css, 'zz.css');
  assert.deepEqual(rules.map((r) => [r.selector, r.display, r.important]), [
    ['.zz-a', 'grid', false],
    ['.zz-wrap > .zz-b', 'grid', false],
    ['.zz-c', 'flex', true],
    ['.zz-d[hidden]', 'none', false],
    ['.zz-e:not([hidden])', 'flex', false],
  ]);
  assert.deepEqual(rules[1].subject.classes, ['zz-b']);
  assert.deepEqual(rules[1].ancestors.map((a) => a.classes), [['zz-wrap']]);
  assert.deepEqual(rules[2].at, ['@media (min-width: 40rem)'], 'die Regel im At-Block wird gesehen');
});

test('Slot-Leser: die Klasse kommt aus dockFabIntoToolbar(), nicht aus einer Konstante', () => {
  const router = [
    '// function dockFabIntoToolbar(fab) { const slot = main.querySelector(\'.zz-kommentar\'); }',
    'function other() { const slot = main.querySelector(\'.zz-fremd\'); }',
    'function dockFabIntoToolbar(fab) {',
    '  /* `.page-fab` bleibt */',
    "  const slot = main?.querySelector('.zz-slot');",
    '  slot.appendChild(fab);',
    '}',
  ].join('\n');
  assert.equal(dockSlotClass(router), 'zz-slot');
  assert.equal(dockSlotClass('function dockFabIntoToolbar(fab) { return false; }'), null);
});

/* ===========================================================================
 * Urteil an erfundener Eingabe
 * ======================================================================== */

/** Ein Mini-Baum aus erfundenem Markup und CSS, durch dieselben Leser. */
function judgeInvented(markup, css) {
  const nodes = markupNodes(`const t = \`${markup}\`;`, 'zz.js');
  return findings(nodes.filter((n) => n.hidden).map((el) => ({ el, site: `zz.js:${el.line}` })), displayRules(css, 'zz.css'));
}

test('der Zustand von PR #1257 wird mit Element, Selektor und fehlender Regel benannt', () => {
  const found = judgeInvented(
    '<form class="zz-form"><div class="inventory-form-row" id="inv-odometer-group" hidden><input id="inv-odometer"></div></form>',
    '.inventory-form-row { display: grid; grid-template-columns: 1fr 1fr; }',
  );
  assert.equal(found.length, 1);
  const message = report(found[0]);
  assert.match(message, /div#inv-odometer-group\.inventory-form-row/, 'welches Element');
  assert.match(message, /zz\.css: `\.inventory-form-row \{ display: grid \}`/, 'welcher Selektor display setzt');
  assert.match(message, /`\.inventory-form-row\[hidden\] \{ display: none; \}`/, 'welche Regel fehlt');
});

test('fuer den Andock-Slot raet die Meldung vom [hidden]-Fix ab, statt ihn vorzuschlagen', () => {
  const [finding] = judgeInvented('<div class="page-toolbar__actions" id="zz-filter" hidden></div>',
    '.page-toolbar__actions { display: flex; }');
  assert.ok(finding, 'der Slot mit hidden und display: flex ist ein Befund');
  const message = report(finding, { dockSlot: 'page-toolbar__actions' });
  assert.doesNotMatch(message, /\.page-toolbar__actions\[hidden\] \{ display: none; \}/,
    'die Meldung schlaegt genau den Fix vor, der den angedockten FAB versteckt');
  assert.match(message, /KEINE \[hidden\]-Regel fuer \.page-toolbar__actions/);
  // Ohne Slot-Klasse bleibt es beim ueblichen Rat.
  assert.match(report(finding), /\.page-toolbar__actions\[hidden\] \{ display: none; \}/);
});

test('jede der drei Rettungsformen holt das Element zurueck', () => {
  const markup = '<nav class="zz-toolbar"><button class="zz-btn" hidden></button></nav>'
    + '<div class="zz-filters" hidden></div><div class="zz-field" id="zz-due" hidden></div>';
  const css = '.zz-btn { display: inline-flex; } .zz-filters { display: flex; } .zz-field { display: flex; }';
  assert.equal(judgeInvented(markup, css).length, 3, 'ohne Rettung: drei Befunde');
  assert.deepEqual(judgeInvented(markup, `${css} .zz-toolbar [hidden] { display: none !important; }`
    + ' .zz-filters[hidden] { display: none; } #zz-due[hidden] { display: none; }'), []);
});

test('eine Rettung ohne Namen gilt nur unter ihrem Vorfahren', () => {
  const markup = '<div class="zz-elsewhere"><div class="zz-row" hidden></div></div>';
  const css = '.zz-row { display: grid; } .zz-toolbar [hidden] { display: none !important; }';
  assert.equal(judgeInvented(markup, css).length, 1, 'ein fremder Vorfahr rettet nicht');
});

test('was nicht ueberstimmt, ist kein Befund', () => {
  const markup = '<p class="zz-a" hidden></p><p class="zz-b" hidden></p><p class="zz-c" hidden></p><p class="zz-d" hidden></p>';
  const css = '.zz-a:not([hidden]) { display: flex; } .zz-b:hover { display: flex; } .zz-c::before { display: block; }'
    + ' .zz-d { color: red; } .zz-e { display: flex; }';
  assert.deepEqual(judgeInvented(markup, css), []);
});

test('eine Regel ohne Namen im Subjekt trifft nur unter nachgewiesenem Vorfahren', () => {
  const inside = judgeInvented('<div class="zz-amounts"><span hidden></span></div>', '.zz-amounts span { display: block; }');
  assert.equal(inside.length, 1, '`.zz-amounts span` haelt ein verstecktes span darin sichtbar');
  const outside = judgeInvented('<div class="zz-other"><span hidden></span></div>', '.zz-amounts span { display: block; }');
  assert.deepEqual(outside, [], 'ausserhalb trifft sie nicht');
});

/* ===========================================================================
 * Der Baum
 * ======================================================================== */

// Erst im Test gebaut, nicht beim Laden der Datei: ein Sammler, der wirft,
// soll die Baum-Tests rot machen - nicht die ganze Datei mitsamt den Tests an
// erfundener Eingabe, die genau sagen wuerden, welcher Leser bricht.
let cachedTree;
const theTree = () => (cachedTree ??= collectTree());

test('jedes ausgeblendete Element, das eine Regel sichtbar haelt, hat eine [hidden]-Regel', () => {
  const tree = theTree();
  const dockSlot = dockSlotClass(readFileSync(new URL('../public/router.js', import.meta.url), 'utf8'));
  const lines = findings(tree.elements, tree.rules).map((f) => report(f, { dockSlot }));
  assert.deepEqual(
    lines, [],
    'Diese Elemente blendet der Code mit `hidden` aus, eine Autorenregel setzt aber `display` '
    + 'und schlaegt damit das UA-`[hidden] { display: none }` - sie bleiben sichtbar und bedienbar:\n  '
    + lines.join('\n  '),
  );
});

test('Reichweite: der Sammler findet ausgeblendete Elemente und die Regeln, die sie ueberstimmen', (t) => {
  // REICHWEITE VOR DEM URTEIL. Die Liste oben ist leer, sobald der Baum sauber
  // ist - und genauso leer, wenn ein Leser nichts mehr liefert. Diese Schwellen
  // unterscheiden die beiden Faelle. Die gemessenen Werte stehen in der
  // Diagnose jedes Laufs; die Schwellen liegen darunter, damit ein Umbau nicht
  // rot wird, und hoch genug, dass ein halbierter Leser es wird.
  const tree = theTree();
  const unique = new Set(tree.elements.map(({ el }) => elementKey(el)));
  const contested = new Set(tree.elements.filter(({ el }) => offendersFor(el, tree.rules).length).map(({ el }) => elementKey(el)));
  const share = (tree.writes - tree.unresolved.length) / tree.writes;

  t.diagnostic(`${unique.size} ausgeblendete Elemente, ${contested.size} davon mit einer display-Regel, `
    + `${tree.writes} Schreibstellen \`.hidden =\`, ${tree.unresolved.length} davon nicht aufloesbar`);
  for (const site of tree.unresolved) t.diagnostic(`nicht aufloesbar: ${site}`);

  assert.ok(unique.size >= 150, `Nur ${unique.size} ausgeblendete Elemente gefunden - der Sammler greift nicht mehr`);
  assert.ok(contested.size >= 60,
    `Nur ${contested.size} ausgeblendete Elemente mit einer display-Regel - der CSS-Leser oder die Aufloesung greift nicht mehr`);
  assert.ok(share >= 0.6,
    `Nur ${Math.round(share * 100)} % der \`.hidden =\`-Stellen aufgeloest - die Rueckverfolgung greift nicht mehr`);
});

test('der Andock-Slot des Routers wird nie ausgeblendet und nie geleert', () => {
  const slot = dockSlotClass(readFileSync(new URL('../public/router.js', import.meta.url), 'utf8'));
  assert.ok(slot, "dockFabIntoToolbar() in router.js waehlt seinen Slot nicht mehr ueber querySelector('.<klasse>') "
    + '- der Guard weiss nicht mehr, welchen Knoten er schuetzt');
  const tree = theTree();

  // Reichweite: ohne Slot-Knoten im Index und ohne aufgeloeste replaceChildren-
  // Stellen waere die leere Liste unten ein Befund ueber nichts.
  const slots = tree.index.filter((n) => n.classes.includes(slot));
  assert.ok(slots.length >= 5, `Nur ${slots.length} Knoten mit .${slot} im Baum - der Markup-Leser greift nicht mehr`);
  assert.ok(tree.cleared.length >= 100,
    `Nur ${tree.cleared.length} aufgeloeste replaceChildren-Ziele - die Rueckverfolgung greift nicht mehr`);

  const hits = (list, what) => [...new Set(list
    .filter(({ el }) => el.classes.includes(slot))
    .map(({ el, site }) => `${describe(el)} (${el.file}:${el.line}) ${what}: ${site}`))];
  const found = [...hits(tree.elements, 'ausgeblendet'), ...hits(tree.cleared, 'geleert')];
  assert.deepEqual(found, [],
    `In .${slot} dockt der Router auf dem Desktop den FAB an (dockFabIntoToolbar in router.js). `
    + 'Ausgeblendet verschwindet die Primaeraktion der Seite mit, geleert fliegt sie aus dem DOM. '
    + 'Eigenen Inhalt in einen eigenen Container IM Slot legen und nur den schalten '
    + `(wie #recipes-source-filter in recipes.js):\n  ${found.join('\n  ')}`);
});

test('Reichweite: jede Ausnahme in RUNTIME_ANCESTORS traegt noch', () => {
  // Ein Eintrag, ohne den kein einziges Element anders beurteilt wuerde, ist
  // toter Text - und toter Text in einer Ausnahmekarte wird beim naechsten Mal
  // ungeprueft abgeschrieben. Gefragt wird deshalb nicht, ob das Dateimuster
  // IRGENDETWAS trifft, sondern ob ohne den Eintrag ein Element seine letzte
  // Rettung verloere.
  const tree = theTree();
  for (const ancestor of RUNTIME_ANCESTORS.keys()) {
    const without = new Map(RUNTIME_ANCESTORS);
    without.delete(ancestor);
    const carried = tree.elements.filter(({ el }) => offendersFor(el, tree.rules).length
      && rescuesFor(el, tree.rules).length
      && !rescuesFor(el, tree.rules, without).length);
    assert.ok(carried.length > 0,
      `${ancestor} steht in RUNTIME_ANCESTORS, aber ohne den Eintrag verloere kein Element seine Rettung - loeschen`);
  }
});
