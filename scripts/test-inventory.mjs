#!/usr/bin/env node
/**
 * Module: test inventory - which suites read app source as text (Phase 1b, section C)
 * Purpose: Detects the text readers among test/test-*.js, compares them with
 *          test/text-reader-inventory.json and answers which suites read a given
 *          source file. The inventory carries what no script can measure (class,
 *          number of spelling blocks, fate); this script carries what can be measured
 *          (who reads what, how many blocks a suite has).
 * Run: node scripts/test-inventory.mjs [--root <dir>] [--json | --missing | --phases |
 *      --target <file> | --update]
 *   (no flag)        summary: suites, narrow and wide unit, blocks, state of the
 *                    inventory; exit 1 with what is wrong, as the guard reports it
 *   --json           the measurement per suite as JSON
 *   --missing        the lines a suite without an entry has to add
 *   --phases         spelling blocks and suites per phase that removes them
 *   --target <file>  inventory entries that read this file (or a directory above it)
 *   --update         lowers the ceiling to the current sums and drops the lines of
 *                    suites that are gone or read nothing any more; it never raises
 *                    a value
 * The rules of the inventory (classes, grey zones, fate) are in docs/test-suites.md,
 * "Text-Leser-Inventar"; test/test-text-reader-inventory.js is the guard.
 *
 * UNITS. A suite is one file test/test-*.js. The NARROW unit counts a suite with at
 * least one read call (readFileSync, readFile, readdirSync and the other directory
 * scanners, a local wrapper around them, or a helper under test/ that reads) whose
 * target, after resolving path constants, lies under public/ or server/ and is not a
 * locale JSON. The WIDE unit counts a suite that names a read call and a path under
 * public/ or server/ in a string anywhere outside comments and import specifiers. Wide
 * minus narrow is the set where the detector saw no read: each of those suites is
 * assigned by hand, as an entry or under `wideOnly` with a reason.
 *
 * LIMITS. This is a lexer with constant folding, not a parser. It resolves `const`
 * initialisers, loop and callback variables, parameters of named functions and helpers
 * imported from test/. It does not follow object properties, destructured constants,
 * re-exports or paths built at run time from data. What it cannot resolve shows up in
 * the wide unit, which is why that unit is guarded as well.
 */

import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const READ_NAMES = 'readFileSync|readFile|readdirSync|readdir|opendirSync|globSync|createReadStream';
const READ_API = new RegExp(`(?<![\\w$])(?:${READ_NAMES})\\s*\\(`, 'g');
const READ_NAMED = new RegExp(`(?<![\\w$])(?:${READ_NAMES})(?![\\w$])`);
// `import { readFileSync as read }` and `const { readFileSync: read } = ...`
const READ_ALIAS = new RegExp(`(?<![\\w$])(?:${READ_NAMES})\\s*(?::|\\sas\\s)\\s*([A-Za-z_$][\\w$]*)`, 'g');
// A block is one test: `test(`, `it(` and the hand-written runners of the older suites.
const BLOCK = /(?<![\w$.])(?:test|it|asyncTest|atest|testAsync)(?:\.(?:only|skip|todo))?\s*\(/g;
const IDENT = /(?<![\w$.])[A-Za-z_$][\w$]*/g;
const AREA = /(?:^|\/)(public|server)(?:\/|$)/;
const ROOT_MARK = /import\.meta|__dirname|__filename|process\.cwd/;
const TMP_MARK = /(?<![\w$])(?:tmpdir|mkdtempSync|mkdtemp|tempDir|freshTestDbPath)(?![\w$])/;
const REGEX_AFTER_WORD = new Set(['return', 'typeof', 'case', 'do', 'else', 'in', 'of', 'void', 'delete', 'throw', 'new', 'yield', 'await', 'instanceof']);
const ARRAY_CALLBACKS = 'map|forEach|filter|flatMap|some|every|find|findIndex|findLast|reduce';
/** @param {string} text a name as a literal inside a regular expression */
const escapeRe = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const MAX_DEPTH = 6;
const MAX_ROUNDS = 4;
const MAX_INIT = 60_000;
const MAX_ITEMS = 4_000;
const MAX_FIXED = 40;

/**
 * Splits a source into what is code and what is text.
 * `code` has comments, string contents, template text and regex literals blanked, so a
 * call inside a string is no call. `pieces` are the string and template chunks with
 * their position; they carry the paths.
 * @param {string} src
 */
export function lex(src) {
  const n = src.length;
  const code = src.split('');
  /** @type {{ s: number, e: number, v: string }[]} */
  const pieces = [];
  /** @type {number[]} */
  const templates = [];
  let lastSig = '';
  let lastWord = '';
  let i = src.startsWith('#!') ? Math.max(src.indexOf('\n'), 0) : 0;
  const blank = (/** @type {number} */ a, /** @type {number} */ b) => {
    for (let k = a; k < b && k < n; k++) if (code[k] !== '\n') code[k] = ' ';
  };
  if (i > 0) blank(0, i);
  // Reads template text from `from` up to the closing backtick or the next `${`.
  const templateText = (/** @type {number} */ from) => {
    let j = from;
    while (j < n && src[j] !== '`' && !(src[j] === '$' && src[j + 1] === '{')) j += src[j] === '\\' ? 2 : 1;
    j = Math.min(j, n);
    if (j > from) pieces.push({ s: from, e: j, v: src.slice(from, j) });
    blank(from, j);
    if (src[j] === '`' || j >= n) return j + 1;
    blank(j, j + 2);
    templates.push(0);
    return j + 2;
  };
  while (i < n) {
    const c = String(src[i]);
    const d = src[i + 1];
    if (c === '/' && d === '/') {
      let j = src.indexOf('\n', i);
      if (j < 0) j = n;
      blank(i, j);
      i = j;
      continue;
    }
    if (c === '/' && d === '*') {
      let j = src.indexOf('*/', i + 2);
      j = j < 0 ? n : j + 2;
      blank(i, j);
      i = j;
      continue;
    }
    if (c === '"' || c === "'") {
      let j = i + 1;
      while (j < n && src[j] !== c && src[j] !== '\n') j += src[j] === '\\' ? 2 : 1;
      j = Math.min(j, n);
      pieces.push({ s: i + 1, e: j, v: src.slice(i + 1, j) });
      blank(i + 1, j);
      i = j + 1;
      lastSig = c;
      lastWord = '';
      continue;
    }
    if (c === '`') {
      i = templateText(i + 1);
      lastSig = '`';
      lastWord = '';
      continue;
    }
    if (c === '/' && (lastSig === '' || '(,=:[!&|?{};+-*%<>~^'.includes(lastSig) || REGEX_AFTER_WORD.has(lastWord))) {
      let j = i + 1;
      let inClass = false;
      let closed = false;
      for (; j < n && src[j] !== '\n'; j++) {
        const ch = src[j];
        if (ch === '\\') j++;
        else if (ch === '[') inClass = true;
        else if (ch === ']') inClass = false;
        else if (ch === '/' && !inClass) { closed = true; break; }
      }
      if (closed) {
        blank(i + 1, j);
        j++;
        while (j < n && /[a-z]/.test(String(src[j]))) j++;
        i = j;
        lastSig = '/';
        lastWord = '';
        continue;
      }
    }
    if (templates.length > 0) {
      const top = templates.length - 1;
      if (c === '{') templates[top] = Number(templates[top]) + 1;
      if (c === '}') {
        if (templates[top] === 0) {
          templates.pop();
          blank(i, i + 1);
          i = templateText(i + 1);
          lastSig = '`';
          lastWord = '';
          continue;
        }
        templates[top] = Number(templates[top]) - 1;
      }
    }
    if (/\s/.test(c)) { i++; continue; }
    if (/[\w$]/.test(c)) {
      let j = i;
      while (j < n && /[\w$]/.test(String(src[j]))) j++;
      lastWord = src.slice(i, j);
      lastSig = String(src[j - 1]);
      i = j;
      continue;
    }
    lastSig = c;
    lastWord = '';
    i++;
  }
  return { code: code.join(''), pieces };
}

/** @param {string} code */
function brackets(code) {
  /** @type {Map<number, number>} */
  const match = new Map();
  // The opening brace of the innermost block around each position, -1 at top level.
  const inner = new Int32Array(code.length).fill(-1);
  /** @type {number[]} */
  const stack = [];
  /** @type {number[]} */
  const braces = [];
  for (let i = 0; i < code.length; i++) {
    const c = code[i];
    inner[i] = braces.at(-1) ?? -1;
    if (c === '(' || c === '[' || c === '{') {
      stack.push(i);
      if (c === '{') braces.push(i);
    } else if (c === ')' || c === ']' || c === '}') {
      const open = stack.pop();
      if (open === undefined) continue;
      match.set(open, i);
      match.set(i, open);
      if (c === '}' && braces.at(-1) === open) braces.pop();
    }
  }
  return { match, inner };
}

/** @param {string} code @param {number} from first position at or after `from` that is not white space */
function skipSpace(code, from) {
  let i = from;
  while (i < code.length && /\s/.test(String(code[i]))) i++;
  return i;
}

/**
 * End of the statement that starts at `from`: a `;` or a line end at bracket depth 0
 * that no operator carries over, or the bracket that closes the surrounding context.
 * @param {string} code
 * @param {number} from
 */
function statementEnd(code, from) {
  let depth = 0;
  for (let i = from; i < code.length; i++) {
    const c = String(code[i]);
    if ('([{'.includes(c)) depth++;
    else if (')]}'.includes(c)) {
      if (depth === 0) return i;
      depth--;
    } else if (depth === 0 && c === ';') return i;
    else if (depth === 0 && c === '\n') {
      let b = i - 1;
      while (b >= from && /\s/.test(String(code[b]))) b--;
      const before = b >= from ? String(code[b]) : '';
      const after = code[skipSpace(code, i)] ?? '';
      if (before === '' || '=+-*/%&|?:,.(<[{>'.includes(before)) continue;
      if ('.+-*/%&|?:,)]}='.includes(after)) continue;
      return i;
    }
  }
  return code.length;
}

/**
 * The parameters of a list, in order: name (null for a pattern) and where its default
 * value stands, as positions in the file.
 * @param {string} text
 * @param {number} offset position of `text` in the file
 */
function parameters(text, offset = 0) {
  /** @type {{ name: string | null, def: [number, number] | null }[]} */
  const list = [];
  let depth = 0;
  let from = 0;
  const flush = (/** @type {number} */ to) => {
    const part = text.slice(from, to);
    const m = /^\s*(?:\.\.\.)?\s*([A-Za-z_$][\w$]*)\s*(=)?/.exec(part);
    if (part.trim() !== '' || list.length > 0) {
      list.push({ name: m ? String(m[1]) : null, def: m?.[2] ? [offset + from + m[0].length, offset + to] : null });
    }
    from = to + 1;
  };
  for (let i = 0; i < text.length; i++) {
    const c = String(text[i]);
    if ('([{'.includes(c)) depth++;
    if (')]}'.includes(c)) depth--;
    if (c === ',' && depth === 0) flush(i);
  }
  flush(text.length);
  return list;
}

/** @param {string} pattern every identifier a destructuring pattern binds */
function patternNames(pattern) {
  return [...pattern.matchAll(/(?<![\w$.])([A-Za-z_$][\w$]*)(?!\s*:)/g)].map((m) => String(m[1]));
}

/**
 * @typedef {{ k: 's', v: string } | { k: 'm', v: 'root' | 'tmp' } | { k: 'p', fn: Fn, i: number }} Item
 * @typedef {{ name: string, params: (string | null)[], defaults: (Item[] | null)[], range: [number, number], decl: number, carried: Item[][], fixed: Item[][] }} Fn
 * @typedef {{ name: string, init: [number, number], scope: [number, number], items: Item[] | null }} Decl
 */

/**
 * One source file, lexed and indexed: scopes, constants, loop and callback variables,
 * named functions.
 * @param {string} src
 */
function index(src) {
  const { code, pieces } = lex(src);
  const { match, inner } = brackets(code);
  const blockOf = (/** @type {number} */ pos) => {
    const open = inner[pos] ?? -1;
    return /** @type {[number, number]} */ (open < 0 ? [0, code.length] : [open, match.get(open) ?? code.length]);
  };
  /** @type {Map<string, Decl[]>} */
  const decls = new Map();
  const declare = (/** @type {string} */ name, /** @type {[number, number]} */ init, /** @type {[number, number]} */ scope) => {
    const list = decls.get(name) ?? [];
    list.push({ name, init, scope, items: null });
    decls.set(name, list);
  };
  for (const m of code.matchAll(/(?<![\w$.])(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=(?!=)/g)) {
    const from = m.index + m[0].length;
    declare(String(m[1]), [from, statementEnd(code, from)], blockOf(m.index));
  }
  for (const m of code.matchAll(/(?<![\w$.])for\s*(?:await\s*)?\(\s*(?:const|let|var)\s+(\[[^\]]*\]|\{[^}]*\}|[A-Za-z_$][\w$]*)\s+(?:of|in)\s/g)) {
    const open = code.indexOf('(', m.index);
    const close = match.get(open);
    if (close === undefined) continue;
    const next = skipSpace(code, close + 1);
    const end = code[next] === '{' ? (match.get(next) ?? code.length) : statementEnd(code, next);
    for (const name of patternNames(String(m[1]))) declare(name, [m.index + m[0].length, close], [m.index, end]);
  }
  const callback = new RegExp(`\\.(${ARRAY_CALLBACKS})\\s*\\(\\s*(?:async\\s*)?(?:\\(([^()]*)\\)|([A-Za-z_$][\\w$]*))\\s*=>`, 'g');
  for (const m of code.matchAll(callback)) {
    const open = code.indexOf('(', m.index);
    const close = match.get(open) ?? code.length;
    // Receiver: walk back over identifiers, dots and balanced brackets.
    let start = m.index;
    for (;;) {
      let j = start - 1;
      while (j >= 0 && /\s/.test(String(code[j]))) j--;
      if (j < 0) break;
      const ch = String(code[j]);
      if (ch === ')' || ch === ']') {
        const o = match.get(j);
        if (o === undefined) break;
        start = o;
      } else if (/[\w$]/.test(ch)) {
        while (j >= 0 && /[\w$]/.test(String(code[j]))) j--;
        start = j + 1;
      } else if (ch === '.' || ch === '?') {
        start = j;
      } else break;
    }
    const params = m[2] !== undefined ? parameters(m[2]).map((p) => p.name) : [String(m[3])];
    const first = m[1] === 'reduce' ? params[1] : params[0];
    const bound = m[2] !== undefined && first === null ? patternNames(String(m[2])) : [first];
    for (const name of bound) if (name) declare(name, [start, m.index], [m.index, close]);
  }
  /** @type {Fn[]} */
  const fns = [];
  /** @type {Map<Fn, ([number, number] | null)[]>} */
  const defaultRanges = new Map();
  const addFn = (/** @type {string} */ name, /** @type {number} */ decl, /** @type {string} */ paramText, /** @type {number} */ paramsAt, /** @type {number} */ bodyFrom) => {
    const at = skipSpace(code, bodyFrom);
    const end = code[at] === '{' ? (match.get(at) ?? code.length) : statementEnd(code, at);
    const params = parameters(paramText, paramsAt);
    /** @type {Fn} */
    const fn = { name, params: params.map((p) => p.name), defaults: [], range: [decl, end], decl, carried: [], fixed: [] };
    defaultRanges.set(fn, params.map((p) => p.def));
    fns.push(fn);
  };
  for (const m of code.matchAll(/(?<![\w$.])function\s*\*?\s*([A-Za-z_$][\w$]*)\s*\(/g)) {
    const open = m.index + m[0].length - 1;
    const close = match.get(open);
    if (close !== undefined) addFn(String(m[1]), m.index, code.slice(open + 1, close), open + 1, close + 1);
  }
  for (const m of code.matchAll(/(?<![\w$.])(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:async\s+)?(?:(function\s*\*?\s*[\w$]*\s*\()|(\()|([A-Za-z_$][\w$]*)\s*=>)/g)) {
    if (m[4] !== undefined) {
      addFn(String(m[1]), m.index, m[4], m.index, m.index + m[0].length);
      continue;
    }
    const open = m.index + m[0].length - 1;
    const close = match.get(open);
    if (close === undefined) continue;
    if (m[2] !== undefined) {
      addFn(String(m[1]), m.index, code.slice(open + 1, close), open + 1, close + 1);
      continue;
    }
    const arrow = skipSpace(code, close + 1);
    if (code.startsWith('=>', arrow)) addFn(String(m[1]), m.index, code.slice(open + 1, close), open + 1, arrow + 2);
  }
  // A function is no path constant: its body is evidence only where it is called.
  const fnStarts = new Set(fns.map((f) => f.decl));
  for (const [name, list] of decls) {
    const constants = list.filter((d) => !fns.some((f) => f.name === name && fnStarts.has(f.decl) && f.range[0] <= d.init[0] && d.init[1] <= f.range[1] + 1));
    if (constants.length === 0) decls.delete(name);
    else decls.set(name, constants);
  }
  /** @type {Map<string, Fn[]>} */
  const byParam = new Map();
  for (const fn of fns) {
    for (const param of fn.params) if (param) byParam.set(param, [...(byParam.get(param) ?? []), fn]);
  }
  const specifiers = importSpecifiers(code, pieces);
  const file = { src, code, pieces: pieces.filter((p) => !specifiers.has(p)), specifiers, match, decls, fns, byParam };
  // What a parameter stands for when the call leaves it out.
  for (const [fn, ranges] of defaultRanges) fn.defaults = ranges.map((r) => (r ? evidence(file, r) : null));
  return file;
}

/**
 * The declaration a name refers to at a position: the innermost scope wins, and a name
 * inside its own initialiser is not that declaration.
 * @param {{ decls: Map<string, Decl[]> }} file
 * @param {string} name
 * @param {number} pos
 */
function resolveDecl(file, name, pos) {
  /** @type {Decl | undefined} */
  let best;
  for (const d of file.decls.get(name) ?? []) {
    if (d.scope[0] > pos || pos > d.scope[1] || (d.init[0] <= pos && pos <= d.init[1])) continue;
    if (!best || d.scope[1] - d.scope[0] < best.scope[1] - best.scope[0]) best = d;
  }
  return best;
}

/**
 * The strings a range of code can evaluate to, in order: literals, the initialisers of
 * the constants it names, markers for the repository root and the temp directory, and
 * placeholders for parameters of the surrounding named function.
 * @param {ReturnType<typeof index>} file
 * @param {[number, number]} range
 * @param {number} depth
 * @param {Set<Decl>} seen
 * @returns {Item[]}
 */
function evidence(file, range, depth = 0, seen = new Set()) {
  /** @type {{ at: number, items: Item[] }[]} */
  const found = [];
  let lo = 0;
  let hi = file.pieces.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (Number(file.pieces[mid]?.s) < range[0]) lo = mid + 1; else hi = mid;
  }
  for (let k = lo; k < file.pieces.length; k++) {
    const p = file.pieces[k];
    if (!p || p.s > range[1]) break;
    if (p.e <= range[1]) found.push({ at: p.s, items: [{ k: 's', v: p.v }] });
  }
  const text = file.code.slice(range[0], range[1]);
  if (ROOT_MARK.test(text)) found.push({ at: range[0], items: [{ k: 'm', v: 'root' }] });
  if (TMP_MARK.test(text)) found.push({ at: range[0], items: [{ k: 'm', v: 'tmp' }] });
  const size = (/** @type {[number, number]} */ r) => r[1] - r[0];
  for (const m of text.matchAll(IDENT)) {
    const pos = range[0] + m.index;
    const name = m[0];
    const decl = resolveDecl(file, name, pos);
    const fn = (file.byParam.get(name) ?? [])
      .filter((f) => f.range[0] <= pos && pos <= f.range[1])
      .sort((a, b) => size(a.range) - size(b.range))[0];
    if (fn && (!decl || size(fn.range) <= size(decl.scope))) {
      found.push({ at: pos, items: [{ k: 'p', fn, i: fn.params.indexOf(name) }] });
    } else if (!decl && file.code[skipSpace(file.code, pos + name.length)] === '(') {
      // `const dir = fixture()`: where the function builds its path decides, not its name.
      for (const called of file.fns.filter((f) => f.name === name && size(f.range) <= MAX_INIT)) {
        const body = file.code.slice(called.range[0], called.range[1]);
        if (TMP_MARK.test(body)) found.push({ at: pos, items: [{ k: 'm', v: 'tmp' }] });
        if (ROOT_MARK.test(body)) found.push({ at: pos, items: [{ k: 'm', v: 'root' }] });
      }
    } else if (decl && depth < MAX_DEPTH && !seen.has(decl) && size(decl.init) <= MAX_INIT) {
      decl.items ??= evidence(file, decl.init, depth + 1, new Set([...seen, decl])).slice(0, MAX_ITEMS);
      found.push({ at: pos, items: decl.items });
    }
  }
  return found.sort((a, b) => a.at - b.at).flatMap((f) => f.items).slice(0, MAX_ITEMS);
}

/**
 * The paths under public/ and server/ a list of evidence names. A path is followed as
 * far as it exists in the repository; what follows a variable stays a directory.
 * @param {Item[]} items
 * @param {string} root
 */
export function targetsOf(items, root) {
  const marks = new Set(items.flatMap((i) => (i.k === 'm' ? [i.v] : [])));
  const strings = items.flatMap((i) => (i.k === 's' ? [i.v] : []));
  /** @type {Set<string>} */
  const targets = new Set();
  /** @type {Set<string>} */
  const locales = new Set();
  if (marks.has('tmp') && !marks.has('root')) return { targets, locales };
  const isDir = (/** @type {string} */ p) => existsSync(join(root, p)) && statSync(join(root, p)).isDirectory();
  for (let i = 0; i < strings.length; i++) {
    const value = String(strings[i]);
    const m = AREA.exec(value);
    if (!m || /\s/.test(value)) continue;
    const prefix = value.slice(0, m.index);
    if (prefix !== '' && !/^(?:\.{0,2}\/)*\.{0,2}$/.test(prefix) && !prefix.endsWith('/')) continue;
    if (/^[a-z]+:\/\//i.test(value)) continue;
    let cur = value.slice(value.indexOf(String(m[1]), m.index)).replace(/\/+$/, '');
    while (!existsSync(join(root, cur)) && cur.includes('/')) cur = dirname(cur);
    if (!existsSync(join(root, cur))) continue;
    for (let j = i + 1; j < strings.length && isDir(cur); j++) {
      const next = String(strings[j]).replace(/^\.?\/+/, '').replace(/\/+$/, '');
      if (next === '' || /\s/.test(next) || next.startsWith('..') || !existsSync(join(root, cur, next))) break;
      cur = join(cur, next);
    }
    const target = isDir(cur) ? `${cur}/` : cur;
    if (target.startsWith('public/locales/')) locales.add(target);
    else targets.add(target);
  }
  return { targets, locales };
}

/** @param {string} code @param {number} open @param {Map<number, number>} match */
function argumentRanges(code, open, match) {
  const close = match.get(open) ?? code.length;
  /** @type {[number, number][]} */
  const ranges = [];
  let depth = 0;
  let from = open + 1;
  for (let i = open + 1; i < close; i++) {
    const c = String(code[i]);
    if ('([{'.includes(c)) depth++;
    else if (')]}'.includes(c)) depth--;
    else if (c === ',' && depth === 0) {
      ranges.push([from, i]);
      from = i + 1;
    }
  }
  ranges.push([from, close]);
  return ranges;
}

/**
 * Every read of a file: where it happens and what it names.
 * @param {ReturnType<typeof index>} file
 * @param {Map<string, Fn>} imported read helpers by local name
 */
function reads(file, imported) {
  /** @type {{ at: number, items: Item[] }[]} */
  const terminal = [];
  const record = (/** @type {number} */ at, /** @type {Item[]} */ items) => {
    const params = items.filter((i) => i.k === 'p');
    for (const p of params) if (p.k === 'p' && !p.fn.carried.includes(items)) p.fn.carried.push(items);
    terminal.push({ at, items });
  };
  const aliases = [...file.code.matchAll(READ_ALIAS)].map((m) => escapeRe(String(m[1])));
  const calls = aliases.length === 0 ? READ_API : new RegExp(`${READ_API.source}|(?<![\\w$.])(?:${aliases.join('|')})\\s*\\(`, 'g');
  for (const m of file.code.matchAll(calls)) {
    const before = file.code.slice(Math.max(0, m.index - 40), m.index);
    if (/function\s*$/.test(before)) continue;
    // `fs.readFile(`, `fs.promises.readFile(` and `(await import('node:fs')).readFile(`
    // read a file, `storage.readFile(` does not. A spread (`...readdirSync(`) is no receiver.
    if (before.endsWith('.') && !before.endsWith('...') && !/(?:(?:fs|fsp|promises)|import\('\s*'\)\)?)\.$/i.test(before)) continue;
    const open = m.index + m[0].length - 1;
    record(m.index, evidence(file, [open + 1, file.match.get(open) ?? file.code.length]));
  }
  const callable = new Map([...imported, ...file.fns.map((f) => /** @type {[string, Fn]} */ ([f.name, f]))]);
  /** @type {Set<string>} */
  const done = new Set();
  for (let round = 0; round < MAX_ROUNDS; round++) {
    // A named function with a read in its body reads wherever it is called.
    for (const fn of file.fns) {
      for (const t of terminal) {
        if (fn.fixed.length >= MAX_FIXED) break;
        if (t.at > fn.range[0] && t.at <= fn.range[1] && !t.items.some((i) => i.k === 'p' && i.fn === fn) && !fn.fixed.includes(t.items)) fn.fixed.push(t.items);
      }
    }
    for (const [name, fn] of callable) {
      if (fn.carried.length === 0 && fn.fixed.length === 0) continue;
      const call = new RegExp(`(?<![\\w$.])${escapeRe(name)}\\s*\\(`, 'g');
      for (const m of file.code.matchAll(call)) {
        if (/(?:function\s*\*?|const|let|var)\s*$/.test(file.code.slice(Math.max(0, m.index - 40), m.index))) continue;
        const args = argumentRanges(file.code, m.index + m[0].length - 1, file.match);
        for (const items of [...fn.carried, ...fn.fixed]) {
          const key = `${name}@${m.index}:${fn.carried.indexOf(items)}:${fn.fixed.indexOf(items)}`;
          if (done.has(key)) continue;
          done.add(key);
          record(m.index, items.flatMap((item) => {
            if (item.k !== 'p' || item.fn !== fn) return [item];
            const arg = args[item.i];
            const given = arg && file.code.slice(arg[0], arg[1]).trim() !== '';
            return given ? evidence(file, arg) : (fn.defaults[item.i] ?? []);
          }));
        }
      }
    }
  }
  return terminal;
}

/** @param {string} code @param {{ s: number, e: number, v: string }[]} pieces */
function importsOf(code, pieces) {
  /** @type {{ from: string, names: [string, string][] }[]} */
  const list = [];
  for (const m of code.matchAll(/(?<![\w$.])import\s*(\{[^}]*\})\s*from\s*(['"])/g)) {
    const spec = pieces.find((p) => p.s === m.index + m[0].length);
    if (!spec) continue;
    const names = String(m[1]).slice(1, -1).split(',').map((n) => n.trim()).filter(Boolean)
      .map((n) => /** @type {[string, string]} */ (n.split(/\s+as\s+/).map((x) => x.trim())))
      .map(([a, b]) => /** @type {[string, string]} */ ([a, b ?? a]));
    list.push({ from: spec.v, names });
  }
  return list;
}

/** @param {string} code @param {{ s: number, e: number, v: string }[]} pieces positions of import specifiers */
function importSpecifiers(code, pieces) {
  /** @type {Set<number>} */
  const at = new Set();
  for (const m of code.matchAll(/(?<![\w$.])(?:from|import)\s*\(?\s*(['"`])/g)) at.add(m.index + m[0].length);
  return new Set(pieces.filter((p) => at.has(p.s)));
}

/**
 * Measures one suite.
 * @param {string} src
 * @param {{ root: string, helpers?: Map<string, Map<string, Fn>> }} options
 *   `helpers` maps an import specifier ('./css-rules.js') to its reading exports.
 */
export function analyzeSuite(src, { root, helpers = new Map() }) {
  const file = index(src);
  /** @type {Map<string, Fn>} */
  const imported = new Map();
  for (const imp of importsOf(file.code, [...file.specifiers])) {
    const exported = helpers.get(imp.from);
    if (!exported) continue;
    for (const [name, local] of imp.names) {
      const fn = exported.get(name);
      if (fn) imported.set(local, fn);
    }
  }
  const terminal = reads(file, imported);
  /** @type {Set<string>} */
  const targets = new Set();
  /** @type {number[]} */
  const hits = [];
  for (const t of terminal) {
    const found = targetsOf(t.items.filter((i) => i.k !== 'p'), root);
    if (found.targets.size > 0) hits.push(t.at);
    for (const target of found.targets) targets.add(target);
  }
  const namesRead = READ_NAMED.test(file.code) || imported.size > 0;
  const namesArea = file.pieces.some((p) => !/\s/.test(p.v) && AREA.test(p.v) && !/^[a-z]+:\/\//i.test(p.v));
  const blockStarts = [...file.code.matchAll(BLOCK)]
    .filter((m) => !/function\s*\*?\s*$/.test(file.code.slice(Math.max(0, m.index - 40), m.index)))
    .map((m) => m.index);
  // Blocks that touch source text: a read inside the block, or a name derived from one.
  // Derived means: a constant whose initialiser reads, or names a derived constant or a
  // function that reads; a function reads when its body does either. Names resolve by
  // scope, and an object key is no name.
  /** @type {Set<string>} */
  const readingFns = new Set(file.fns.filter((fn) => hits.some((at) => at >= fn.range[0] && at <= fn.range[1])).map((fn) => fn.name));
  /** @type {Set<Decl>} */
  const derived = new Set();
  const touches = (/** @type {number} */ from, /** @type {number} */ to) => {
    if (hits.some((at) => at >= from && at <= to)) return true;
    for (const m of file.code.slice(from, to).matchAll(IDENT)) {
      const pos = from + m.index;
      if (file.code[skipSpace(file.code, pos + m[0].length)] === ':' && /[{,]\s*$/.test(file.code.slice(Math.max(0, pos - 80), pos))) continue;
      if (readingFns.has(m[0])) return true;
      const decl = resolveDecl(file, m[0], pos);
      if (decl && derived.has(decl)) return true;
    }
    return false;
  };
  const constants = [...file.decls.values()].flat().filter((d) => d.init[1] - d.init[0] <= MAX_INIT);
  for (let round = 0; round < MAX_ROUNDS; round++) {
    for (const d of constants) if (!derived.has(d) && touches(d.init[0], d.init[1])) derived.add(d);
    for (const fn of file.fns) if (!readingFns.has(fn.name) && touches(fn.range[0], fn.range[1])) readingFns.add(fn.name);
  }
  /** @type {number[]} */
  const lineStarts = [0];
  for (let i = file.src.indexOf('\n'); i >= 0; i = file.src.indexOf('\n', i + 1)) lineStarts.push(i + 1);
  const lineOf = (/** @type {number} */ pos) => {
    let lo = 0;
    let hi = lineStarts.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (Number(lineStarts[mid]) <= pos) lo = mid; else hi = mid - 1;
    }
    return lo + 1;
  };
  /** @type {[number, number][]} first and last line of each block that touches source text */
  const textBlocks = [];
  for (const start of blockStarts) {
    const end = file.match.get(file.code.indexOf('(', start)) ?? file.code.length;
    if (touches(start, end)) textBlocks.push([lineOf(start), lineOf(end)]);
  }
  return {
    narrow: hits.length > 0,
    wide: hits.length > 0 || (namesRead && namesArea),
    targets: [...targets].sort(),
    blocks: blockStarts.length,
    textBlocks,
    readLines: [...new Set(hits.map(lineOf))].sort((a, b) => a - b),
    fns: file.fns,
  };
}

/** @param {string} root reading exports of the helper modules under test/ */
function helperExports(root) {
  const dir = join(root, 'test');
  const files = readdirSync(dir).filter((f) => /\.m?js$/.test(f) && !/^test-/.test(f));
  /** @type {Map<string, Map<string, Fn>>} */
  const helpers = new Map();
  for (let round = 0; round < 2; round++) {
    for (const f of files) {
      const src = readFileSync(join(dir, f), 'utf8');
      const measured = analyzeSuite(src, { root, helpers });
      const { code } = lex(src);
      /** @type {Map<string, Fn>} */
      const exported = new Map();
      for (const fn of measured.fns) {
        const reads = [...fn.carried, ...fn.fixed].some((items) => targetsOf(items.filter((i) => i.k !== 'p'), root).targets.size > 0)
          || fn.carried.length > 0;
        const isExported = new RegExp(`export\\s+(?:async\\s+)?(?:function\\s*\\*?|const|let)\\s+${escapeRe(fn.name)}(?![\\w$])|export\\s*\\{[^}]*(?<![\\w$])${escapeRe(fn.name)}(?![\\w$])[^}]*\\}`).test(code);
        if (reads && isExported) exported.set(fn.name, fn);
      }
      if (exported.size > 0) helpers.set(`./${f}`, exported);
    }
  }
  return helpers;
}

/** @param {string} root every suite, measured */
export function scan(root) {
  const dir = join(root, 'test');
  const helpers = helperExports(root);
  /** @type {Record<string, { narrow: boolean, wide: boolean, targets: string[], blocks: number, textBlocks: [number, number][], readLines: number[] }>} */
  const suites = {};
  for (const f of readdirSync(dir).filter((n) => /^test-.*\.js$/.test(n)).sort()) {
    const { narrow, wide, targets, blocks, textBlocks, readLines } = analyzeSuite(readFileSync(join(dir, f), 'utf8'), { root, helpers });
    suites[f] = { narrow, wide, targets, blocks, textBlocks, readLines };
  }
  return suites;
}

/* ---------- inventory ---------- */

/**
 * @typedef {{ class: 'V' | 'S' | 'M', sBlocks: number, targets: string[], fate: string }} Entry
 * @typedef {{ title: string, lines: [number, number], blocks: number, sBlocks: number, fate: string }} Section
 * @typedef {{ ceiling: { sBlocks: number, suites: number }, sections: Record<string, Section[]>, suites: Record<string, Entry>, wideOnly: Record<string, string> }} Inventory
 * @typedef {ReturnType<typeof scan>} Measured
 */

export const INVENTORY_FILE = 'test/text-reader-inventory.json';
export const PHASES = ['1b', '2', '4', 'stays'];
const FATE = /^(?:lint:[a-z][a-z0-9-]*|falls-with:(?:public|server)\/\S*|stays:[^<>\s][^<>]*)$/;

/** @param {string} root @returns {Inventory} */
export function readInventory(root) {
  const raw = JSON.parse(readFileSync(join(root, INVENTORY_FILE), 'utf8'));
  return {
    ceiling: { sBlocks: 0, suites: 0, ...raw.ceiling },
    sections: raw.sections ?? {},
    suites: raw.suites ?? {},
    wideOnly: raw.wideOnly ?? {},
  };
}

/** @param {Record<string, unknown>} map one line per key, keys sorted */
function lines(map) {
  const keys = Object.keys(map).sort();
  if (keys.length === 0) return '{}';
  return `{\n${keys.map((k) => `  ${JSON.stringify(k)}: ${JSON.stringify(map[k])}`).join(',\n')}\n }`;
}

/** @param {Inventory} inv one line per suite, so a new entry is a one line diff */
export function formatInventory(inv) {
  return `{\n "ceiling": ${JSON.stringify(inv.ceiling)},\n "sections": ${lines(inv.sections)},\n "suites": ${lines(inv.suites)},\n "wideOnly": ${lines(inv.wideOnly)}\n}\n`;
}

/** @param {string} name @param {string[]} targets the line a new text reader pastes into "suites" */
export function entryLine(name, targets) {
  return `  ${JSON.stringify(name)}: ${JSON.stringify({ class: 'V', sBlocks: 0, targets, fate: 'stays:<executed|contract|coupling|cascade>' })},`;
}

/** @param {Inventory} inv spelling blocks, and suites that carry at least one */
export function sums(inv) {
  const entries = Object.values(inv.suites);
  return {
    sBlocks: entries.reduce((n, e) => n + e.sBlocks, 0),
    suites: entries.filter((e) => e.class !== 'V').length,
  };
}

/**
 * The phase that removes an entry's spelling blocks: the linter (1b, section D), the
 * server rebuild (2), the page rebuild (4), or none.
 * @param {{ fate: string }} entry
 */
export function phaseOf(entry) {
  if (entry.fate.startsWith('lint:')) return '1b';
  if (entry.fate.startsWith('stays:')) return 'stays';
  return entry.fate.slice('falls-with:'.length).startsWith('server/') ? '2' : '4';
}

/** @param {Inventory} inv spelling blocks and suites per phase; a suite with sections counts per section */
export function phases(inv) {
  /** @type {Record<string, { suites: number, sBlocks: number }>} */
  const table = Object.fromEntries(PHASES.map((p) => [p, { suites: 0, sBlocks: 0 }]));
  for (const [name, entry] of Object.entries(inv.suites)) {
    if (entry.class === 'V') continue;
    const parts = inv.sections[name]?.filter((p) => p.sBlocks > 0) ?? [entry];
    const home = table[phaseOf(entry)];
    if (home) home.suites++;
    for (const part of parts) {
      const row = table[phaseOf(part)];
      if (row) row.sBlocks += part.sBlocks;
    }
  }
  return table;
}

/** @param {Inventory} inv @param {string} file entries that read `file` or a directory above it */
export function readersOf(inv, file) {
  return Object.entries(inv.suites)
    .filter(([, e]) => e.targets.some((t) => t === file || (t.endsWith('/') && file.startsWith(t)) || (file.endsWith('/') && t.startsWith(file))))
    .map(([name, e]) => ({ name, ...e }));
}

/**
 * What the inventory lacks or carries too much, compared with the tree.
 * @param {Inventory} inv
 * @param {Measured} measured
 */
export function compare(inv, measured) {
  const narrow = Object.keys(measured).filter((f) => measured[f]?.narrow);
  const wide = Object.keys(measured).filter((f) => measured[f]?.wide);
  return {
    narrow,
    wide,
    missing: narrow.filter((f) => !inv.suites[f]),
    unassigned: wide.filter((f) => !measured[f]?.narrow && !inv.suites[f] && !(f in inv.wideOnly)),
    gone: [...Object.keys(inv.suites), ...Object.keys(inv.wideOnly)].filter((f) => !measured[f]),
    both: Object.keys(inv.wideOnly).filter((f) => measured[f]?.narrow || inv.suites[f]),
    idle: [
      ...Object.keys(inv.suites).filter((f) => measured[f] && !measured[f].wide),
      ...Object.keys(inv.wideOnly).filter((f) => measured[f] && !measured[f].wide),
    ],
  };
}

/**
 * Everything that makes the inventory wrong, as sentences that say what to do.
 * `hints` are what could sink; they never fail a run.
 * @param {Inventory} inv
 * @param {Measured} measured
 * @param {string} root
 */
export function verify(inv, measured, root) {
  const diff = compare(inv, measured);
  /** @type {string[]} */
  const problems = [];
  /** @type {string[]} */
  const hints = [];
  const exists = (/** @type {string} */ p) => existsSync(join(root, p));
  if (diff.missing.length > 0) {
    problems.push(`${diff.missing.length} suites read source text from public/ or server/ and have no entry. Add under "suites" in ${INVENTORY_FILE} `
      + '(a new suite tests behaviour, so its class is V; pick the reason from docs/test-suites.md, "Text-Leser-Inventar"):\n'
      + diff.missing.map((f) => entryLine(f, measured[f]?.targets ?? [])).join('\n'));
  }
  if (diff.unassigned.length > 0) {
    problems.push(`${diff.unassigned.length} suites name a read call and a path under public/ or server/, but the detector sees no read of source text. `
      + `Decide by hand: an entry under "suites" if the suite does read source text, otherwise a line under "wideOnly" in ${INVENTORY_FILE}:\n`
      + diff.unassigned.map((f) => `  ${JSON.stringify(f)}: "<what it reads instead>",`).join('\n'));
  }
  for (const f of diff.gone) problems.push(`${f}: listed, but test/${f} does not exist. Remove the line (node scripts/test-inventory.mjs --update does it).`);
  for (const f of diff.both) problems.push(`${f}: listed under "wideOnly", but it reads source text or has an entry. Keep one of the two.`);
  for (const f of diff.idle) hints.push(`${f}: no longer names a read of public/ or server/, the line can go (--update).`);
  for (const [name, e] of Object.entries(inv.suites)) {
    const where = `${name}:`;
    if (!['V', 'S', 'M'].includes(e.class)) problems.push(`${where} class is "${e.class}", expected V, S or M.`);
    if (!Number.isInteger(e.sBlocks) || e.sBlocks < 0) problems.push(`${where} sBlocks is not a count.`);
    if ((e.class === 'V') !== (e.sBlocks === 0)) problems.push(`${where} class ${e.class} with ${e.sBlocks} spelling blocks. V means none, S and M mean at least one.`);
    const blocks = measured[name]?.blocks;
    if (blocks !== undefined && e.sBlocks > blocks) problems.push(`${where} ${e.sBlocks} spelling blocks, but the suite has ${blocks} blocks.`);
    if (!Array.isArray(e.targets) || e.targets.length === 0) problems.push(`${where} no target. Name the files under public/ or server/ the suite reads.`);
    for (const t of e.targets ?? []) {
      if (!/^(?:public|server)\//.test(t) || t.startsWith('public/locales/')) problems.push(`${where} target ${t} is not source text under public/ or server/.`);
      else if (!exists(t)) problems.push(`${where} target ${t} does not exist. The file was moved or rebuilt: work off the entry by its fate, or point it at the new file.`);
      else if (t.endsWith('/') !== statSync(join(root, t)).isDirectory()) problems.push(`${where} target ${t}: a directory ends with "/", a file does not.`);
    }
    if (!FATE.test(e.fate ?? '')) problems.push(`${where} fate "${e.fate}" is none of lint:<rule>, falls-with:<file under public/ or server/>, stays:<reason>.`);
    else if (e.class === 'V' && !e.fate.startsWith('stays:')) problems.push(`${where} a V suite stays; its fate is stays:<reason>.`);
    else if (e.fate.startsWith('falls-with:') && !exists(e.fate.slice('falls-with:'.length))) problems.push(`${where} fate names ${e.fate.slice('falls-with:'.length)}, which does not exist.`);
  }
  for (const [name, parts] of Object.entries(inv.sections)) {
    const entry = inv.suites[name];
    if (!entry) {
      problems.push(`${name}: sections without an entry.`);
      continue;
    }
    const sum = parts.reduce((n, p) => n + p.sBlocks, 0);
    if (sum !== entry.sBlocks) problems.push(`${name}: its sections count ${sum} spelling blocks, the entry says ${entry.sBlocks}.`);
    for (const p of parts) {
      if (!FATE.test(p.fate ?? '')) problems.push(`${name}, section "${p.title}": fate "${p.fate}" has no known form.`);
    }
  }
  const now = sums(inv);
  if (now.sBlocks > inv.ceiling.sBlocks) {
    problems.push(`Spelling blocks rose: ${now.sBlocks}, ceiling ${inv.ceiling.sBlocks}. The number only sinks: test the behaviour instead (run the code, read dist/ or the DOM), `
      + 'or remove as many spelling blocks elsewhere in the same change.');
  }
  if (now.suites > inv.ceiling.suites) {
    problems.push(`Suites with spelling blocks rose: ${now.suites}, ceiling ${inv.ceiling.suites}. The number only sinks.`);
  }
  if (now.sBlocks < inv.ceiling.sBlocks || now.suites < inv.ceiling.suites) {
    hints.push(`The ceiling can sink to ${JSON.stringify(now)} (node scripts/test-inventory.mjs --update).`);
  }
  return { problems, hints, diff, now };
}

function main() {
  const args = process.argv.slice(2);
  const value = (/** @type {string} */ flag) => (args.includes(flag) ? String(args[args.indexOf(flag) + 1]) : undefined);
  const root = resolve(value('--root') ?? fileURLToPath(new URL('..', import.meta.url)));
  const measured = scan(root);
  if (args.includes('--json')) {
    console.log(JSON.stringify(measured, null, 1));
    return;
  }
  if (!existsSync(join(root, INVENTORY_FILE))) {
    console.error(`${INVENTORY_FILE} is missing.`);
    process.exit(2);
  }
  const inv = readInventory(root);
  if (args.includes('--target')) {
    const file = String(value('--target')).replace(/^\.\//, '');
    const found = readersOf(inv, file);
    for (const e of found) console.log(`${e.class}  ${String(e.sBlocks).padStart(4)}  ${e.name}  ${e.fate}`);
    console.log(`${found.length} suites read ${file}: ${found.filter((e) => e.class !== 'V').length} carry spelling blocks, ${found.reduce((n, e) => n + e.sBlocks, 0)} in all (the count is per suite, not per file).`);
    return;
  }
  if (args.includes('--phases')) {
    const table = phases(inv);
    for (const phase of PHASES) console.log(`${phase.padEnd(6)} ${String(table[phase]?.suites).padStart(4)} suites  ${String(table[phase]?.sBlocks).padStart(5)} spelling blocks`);
    return;
  }
  const { problems, hints, diff, now } = verify(inv, measured, root);
  if (args.includes('--missing')) {
    for (const f of diff.missing) console.log(entryLine(f, measured[f]?.targets ?? []));
    for (const f of diff.unassigned) console.log(`  ${JSON.stringify(f)}: "<what it reads instead>",`);
    return;
  }
  if (args.includes('--update')) {
    for (const f of [...diff.gone, ...diff.idle]) {
      delete inv.suites[f];
      delete inv.wideOnly[f];
      delete inv.sections[f];
    }
    const next = sums(inv);
    inv.ceiling = { sBlocks: Math.min(inv.ceiling.sBlocks, next.sBlocks), suites: Math.min(inv.ceiling.suites, next.suites) };
    writeFileSync(join(root, INVENTORY_FILE), formatInventory(inv));
    console.log(`Inventory written: ceiling ${JSON.stringify(inv.ceiling)}, ${diff.gone.length + diff.idle.length} lines dropped.`);
    return;
  }
  const blocks = Object.values(measured).reduce((n, m) => n + m.blocks, 0);
  const entries = Object.values(inv.suites);
  const onPublic = entries.filter((e) => e.targets.some((t) => t.startsWith('public/')));
  const count = (/** @type {string} */ c) => entries.filter((e) => e.class === c).length;
  console.log(`Suites: ${Object.keys(measured).length}, blocks: ${blocks}`);
  console.log(`Text readers: ${diff.narrow.length} narrow, ${diff.wide.length} wide, ${diff.wide.length - diff.narrow.length} wide only`);
  console.log(`Inventory: ${entries.length} entries (V ${count('V')}, S ${count('S')}, M ${count('M')}), ${Object.keys(inv.wideOnly).length} wide only`);
  console.log(`Readers of public/: ${onPublic.length} suites, ${onPublic.filter((e) => e.class !== 'V').length} of them with spelling blocks`);
  console.log(`Spelling: ${now.sBlocks} blocks (ceiling ${inv.ceiling.sBlocks}) in ${now.suites} suites (ceiling ${inv.ceiling.suites}), ${(100 * now.sBlocks / Math.max(blocks, 1)).toFixed(1)} % of all blocks`);
  for (const hint of hints) console.log(`Hint: ${hint}`);
  for (const problem of problems) console.error(problem);
  if (problems.length > 0) process.exitCode = 1;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
