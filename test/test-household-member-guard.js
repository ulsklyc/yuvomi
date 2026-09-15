/**
 * Modul: Guard - jede Personenliste aus `users` geht ueber das eine Praedikat (#1207)
 * Zweck: Rot, sobald irgendwo unter `server/` eine Liste von Personen direkt aus
 *        `users` gebaut wird, ohne `householdMemberSql()` aus
 *        `server/services/household-members.js`. Eine `users`-Zeile ist nicht
 *        automatisch ein Haushaltsmitglied (docs/DECISIONS.md, Eintrag 4): wer
 *        die Frage in einer Liste selbst beantwortet, zeigt die Haushaltskraft,
 *        den Gast oder kuenftig das Display-Konto (#913) dort, wo alle anderen
 *        Listen es verbergen - "inconsistently visible" statt verborgen (#1007).
 *
 *        WAS ALS PERSONENLISTE ZAEHLT, entscheidet die Bauart, nicht ein Name:
 *          - ein `.prepare(...)`, dessen SQL auf oberster Klammerebene
 *            `FROM users` liest (users ist die fuehrende Tabelle - ein
 *            `JOIN users` fuer den Namen des Erstellers ist keine Liste von
 *            Personen, sondern eine Liste von Datensaetzen mit Namen daran),
 *          - und dessen Ergebnis als Liste abgeholt wird (`.all()`/`.iterate()`,
 *            oder das Statement wird aufgehoben und spaeter benutzt - das zaehlt
 *            vorsichtshalber mit). `.get()`/`.run()` sind Einzelzeile/Schreiben.
 *
 *        WAS ALS PRAEDIKAT ZAEHLT: ein AUFRUF von `householdMemberSql`, der aus
 *        dem Praedikat-Modul importiert ist, als `${...}` im SQL selbst oder in
 *        einer Konstante, die dort eingesetzt wird. Gelesen wird ein Token-
 *        strom ohne Kommentare, und Zeichenketten sind Zeichenketten: ein
 *        Kommentar, der den Namen nennt, oder der Name als Text im SQL macht
 *        den Guard nicht gruen (siehe die Selbsttests unten - jeder davon ist
 *        eine Weise, auf die ein Textguard sich taeuschen laesst).
 *
 *        DIE ALLOWLIST ist die Liste der Stellen, die bewusst ALLE Zeilen sehen
 *        (Benutzerverwaltung, Anmeldung, Hintergrundjobs je Konto). Sie ist
 *        eine Allowlist, keine Denylist: eine NEUE Stelle ist rot, bis jemand
 *        sie mit Grund eintraegt. Jeder Eintrag nennt Datei, Stelle (Route oder
 *        Funktion) und die Zahl der Listen dort - eine zweite ungefilterte Liste
 *        an einer erlaubten Stelle schluepft so nicht mit durch. Ein Eintrag,
 *        der nichts mehr trifft, ist ebenfalls rot.
 *
 *        Grenzen: SQL, das erst zur Laufzeit zusammengesetzt wird (Aufruf einer
 *        Funktion statt Literal/Konstante), sieht der Guard nicht. Anzahlen
 *        (`COUNT(*) ... .get()`) sind keine Liste und nicht Teil dieses Guards.
 * Ausfuehren: npm run test:household-member-guard
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const PREDICATE_MODULE = 'server/services/household-members.js';
const PREDICATE_EXPORT = 'householdMemberSql';

/**
 * Stellen, die bewusst jede `users`-Zeile sehen. Datei + Stelle + Zahl der
 * Listen + Grund. Neue Eintraege nur mit einem Grund, der erklaert, warum
 * Personal, Gaeste und Display-Konten dort hingehoeren.
 */
const ALLOWLIST = [
  {
    file: 'server/auth.js', site: 'GET /users', lists: 2,
    reason: 'User administration: lists every account and flags staff (is_worker) and guests (access_scope). The calendar, budget and schedule pickers also read it unfiltered - open question in #1207.',
  },
  {
    file: 'server/auth.js', site: 'findOrCreateOidcUser', lists: 1,
    reason: 'Sign-in: SSO links the one account that carries the verified address, whichever kind it is.',
  },
  {
    file: 'server/routes/permissions.js', site: 'GET /catalog', lists: 1,
    reason: 'Permission matrix for admins: rights are set per account, staff and guests included.',
  },
  {
    file: 'server/routes/split-expenses.js', site: 'GET /search', lists: 1,
    reason: 'Scoped by shared expense groups, not by household: guests are legitimate co-members there.',
  },
  {
    file: 'server/services/pantry-reminders.js', site: 'usersWithPantry', lists: 1,
    reason: 'Background job per account: resolves who may receive pantry reminders, shows no one.',
  },
  {
    file: 'server/services/notifications.js', site: 'processDueNotifications', lists: 1,
    reason: 'Background job per account: syncs each account\'s own birthday reminders, shows no one.',
  },
  {
    file: 'server/services/schedule.js', site: 'scheduleData', lists: 1,
    reason: 'Schedule entries per account: staff have schedules of their own (#787).',
  },
  {
    file: 'server/services/schedule-reminders.js', site: 'syncAllScheduleReminders', lists: 1,
    reason: 'Background job per account that opted into shift reminders, shows no one.',
  },
  {
    file: 'server/services/ics-export.js', site: 'findUserIdByFeedToken', lists: 1,
    reason: 'Feed token lookup: compares a presented token against every stored one in constant time, shows no one.',
  },
  {
    file: 'server/services/waste-ics.js', site: 'findUserIdByFeedToken', lists: 1,
    reason: 'Feed token lookup: compares a presented token against every stored one in constant time, shows no one.',
  },
  {
    file: 'server/services/waste-store.js', site: 'pruneFeedTypeSelections', lists: 1,
    reason: 'Cleanup per account: drops a deleted waste type from every feed selection, shows no one.',
  },
  {
    file: 'server/routes/health/caregivers.js', site: 'PUT /caregivers/:subjectId', lists: 1,
    reason: 'Existence check for the ids the request names, not a list offered to anyone.',
  },
];

// --------------------------------------------------------------------------
// Tokenizer: gerade genug JavaScript, um Kommentare, Zeichenketten, Template-
// Literale (mit verschachtelten `${}`) und Regex-Literale auseinanderzuhalten.
// --------------------------------------------------------------------------

const REGEX_AFTER_KEYWORD = new Set(['return', 'typeof', 'case', 'do', 'else', 'in', 'of', 'new', 'delete', 'void', 'throw', 'yield', 'await']);

function tokenize(src, start = 0, untilBrace = false) {
  const tokens = [];
  let i = start;
  let depth = 0;
  const prevSignificant = () => tokens[tokens.length - 1];
  while (i < src.length) {
    const ch = src[i];
    const next = src[i + 1];
    if (/\s/.test(ch)) { i += 1; continue; }
    if (ch === '/' && next === '/') {
      while (i < src.length && src[i] !== '\n') i += 1;
      continue;
    }
    if (ch === '/' && next === '*') {
      const end = src.indexOf('*/', i + 2);
      i = end === -1 ? src.length : end + 2;
      continue;
    }
    if (ch === '\'' || ch === '"') {
      let j = i + 1;
      let value = '';
      while (j < src.length && src[j] !== ch) {
        if (src[j] === '\\') { value += src[j + 1]; j += 2; continue; }
        value += src[j];
        j += 1;
      }
      tokens.push({ type: 'string', value, start: i });
      i = j + 1;
      continue;
    }
    if (ch === '`') {
      const quasis = [];
      const exprs = [];
      let cur = '';
      let j = i + 1;
      while (j < src.length && src[j] !== '`') {
        if (src[j] === '\\') { cur += src[j + 1]; j += 2; continue; }
        if (src[j] === '$' && src[j + 1] === '{') {
          quasis.push(cur);
          cur = '';
          const inner = tokenize(src, j + 2, true);
          exprs.push(inner.tokens);
          j = inner.end + 1;
          continue;
        }
        cur += src[j];
        j += 1;
      }
      quasis.push(cur);
      tokens.push({ type: 'template', quasis, exprs, start: i });
      i = j + 1;
      continue;
    }
    if (/[A-Za-z_$]/.test(ch)) {
      let j = i + 1;
      while (j < src.length && /[\w$]/.test(src[j])) j += 1;
      tokens.push({ type: 'ident', value: src.slice(i, j), start: i });
      i = j;
      continue;
    }
    if (/[0-9]/.test(ch)) {
      let j = i + 1;
      while (j < src.length && /[\w.]/.test(src[j])) j += 1;
      tokens.push({ type: 'number', value: src.slice(i, j), start: i });
      i = j;
      continue;
    }
    if (ch === '/') {
      const prev = prevSignificant();
      const division = prev && (
        prev.type === 'number' || prev.type === 'string' || prev.type === 'template' || prev.type === 'regex'
        || (prev.type === 'ident' && !REGEX_AFTER_KEYWORD.has(prev.value))
        || (prev.type === 'punct' && (prev.value === ')' || prev.value === ']'))
      );
      if (!division) {
        let j = i + 1;
        let inClass = false;
        while (j < src.length) {
          const c = src[j];
          if (c === '\\') { j += 2; continue; }
          if (c === '[') inClass = true;
          else if (c === ']') inClass = false;
          else if (c === '/' && !inClass) break;
          else if (c === '\n') break;
          j += 1;
        }
        j += 1;
        while (j < src.length && /[a-z]/i.test(src[j])) j += 1;
        tokens.push({ type: 'regex', start: i });
        i = j;
        continue;
      }
    }
    if (untilBrace) {
      if (ch === '{') depth += 1;
      if (ch === '}') {
        if (depth === 0) return { tokens, end: i };
        depth -= 1;
      }
    }
    tokens.push({ type: 'punct', value: ch, start: i });
    i += 1;
  }
  return { tokens, end: i };
}

const isPunct = (tok, value) => tok?.type === 'punct' && tok.value === value;
const isIdent = (tok, value) => tok?.type === 'ident' && (value === undefined || tok.value === value);

function bracketPairs(tokens) {
  const pairs = new Map();
  const stack = [];
  const open = { '(': ')', '[': ']', '{': '}' };
  tokens.forEach((tok, idx) => {
    if (tok.type !== 'punct') return;
    if (open[tok.value]) stack.push(idx);
    else if (tok.value === ')' || tok.value === ']' || tok.value === '}') {
      const from = stack.pop();
      if (from !== undefined) pairs.set(from, idx);
    }
  });
  return pairs;
}

// --------------------------------------------------------------------------
// Datei-Analyse
// --------------------------------------------------------------------------

function importedPredicateNames(tokens, file) {
  const names = new Set();
  if (file === PREDICATE_MODULE) names.add(PREDICATE_EXPORT);
  for (let i = 0; i < tokens.length; i += 1) {
    if (!isIdent(tokens[i], 'import') || !isPunct(tokens[i + 1], '{')) continue;
    let j = i + 2;
    const local = [];
    while (j < tokens.length && !isPunct(tokens[j], '}')) {
      if (isIdent(tokens[j], PREDICATE_EXPORT)) {
        local.push(isIdent(tokens[j + 1], 'as') ? tokens[j + 2].value : PREDICATE_EXPORT);
      }
      j += 1;
    }
    if (!isIdent(tokens[j + 1], 'from') || tokens[j + 2]?.type !== 'string') continue;
    const spec = tokens[j + 2].value;
    if (!spec.startsWith('.')) continue;
    const target = relative(ROOT, resolve(ROOT, dirname(file), spec)).split(sep).join('/');
    if (target === PREDICATE_MODULE) local.forEach((name) => names.add(name));
  }
  return names;
}

function constInitializers(tokens, pairs) {
  const consts = new Map();
  for (let i = 0; i < tokens.length; i += 1) {
    if (!isIdent(tokens[i], 'const') || !isIdent(tokens[i + 1]) || !isPunct(tokens[i + 2], '=')) continue;
    let j = i + 3;
    const init = [];
    while (j < tokens.length && !isPunct(tokens[j], ';')) {
      if (pairs.has(j)) {
        const end = pairs.get(j);
        init.push(...tokens.slice(j, end + 1));
        j = end + 1;
        continue;
      }
      if (isPunct(tokens[j], ')') || isPunct(tokens[j], '}') || isPunct(tokens[j], ']')) break;
      init.push(tokens[j]);
      j += 1;
    }
    consts.set(tokens[i + 1].value, init);
  }
  return consts;
}

function carriesPredicate(exprTokens, ctx, seen = new Set()) {
  for (let i = 0; i < exprTokens.length; i += 1) {
    const tok = exprTokens[i];
    if (tok.type === 'template' && tok.exprs.some((inner) => carriesPredicate(inner, ctx, seen))) return true;
    if (tok.type !== 'ident') continue;
    if (ctx.predicateNames.has(tok.value) && isPunct(exprTokens[i + 1], '(') && !isPunct(exprTokens[i - 1], '.')) return true;
    if (ctx.consts.has(tok.value) && !seen.has(tok.value) && !isPunct(exprTokens[i - 1], '.')) {
      seen.add(tok.value);
      if (carriesPredicate(ctx.consts.get(tok.value), ctx, seen)) return true;
    }
  }
  return false;
}

function sqlText(exprTokens, ctx, seen = new Set()) {
  let text = '';
  for (let i = 0; i < exprTokens.length; i += 1) {
    const tok = exprTokens[i];
    if (tok.type === 'string') text += ` ${tok.value} `;
    else if (tok.type === 'template') text += ` ${tok.quasis.join(' __expr__ ')} `;
    else if (tok.type === 'ident' && ctx.consts.has(tok.value) && !seen.has(tok.value) && !isPunct(exprTokens[i - 1], '.')) {
      const init = ctx.consts.get(tok.value);
      if (init.length === 1 && (init[0].type === 'string' || init[0].type === 'template')) {
        seen.add(tok.value);
        text += sqlText(init, ctx, seen);
      }
    }
  }
  return text;
}

/** Liest die SQL `FROM users` auf oberster Klammerebene? */
export function drivesFromUsers(sql) {
  const clean = sql
    .replace(/--[^\n]*/g, ' ')
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/'(?:''|[^'])*'/g, "''");
  let depth = 0;
  const words = [];
  const re = /[()]|[A-Za-z_][\w]*/g;
  let m;
  while ((m = re.exec(clean))) {
    if (m[0] === '(') depth += 1;
    else if (m[0] === ')') depth -= 1;
    else words.push({ word: m[0].toLowerCase(), depth });
  }
  return words.some((w, idx) => w.depth === 0 && w.word === 'from'
    && words[idx + 1]?.word === 'users' && words[idx + 1].depth === 0);
}

function siteRanges(tokens, pairs) {
  const ranges = [];
  for (let i = 0; i < tokens.length; i += 1) {
    const tok = tokens[i];
    // router.get('/path', ...)
    if (isIdent(tok) && /router$/i.test(tok.value) && isPunct(tokens[i + 1], '.')
      && isIdent(tokens[i + 2]) && /^(get|post|put|patch|delete)$/.test(tokens[i + 2].value)
      && isPunct(tokens[i + 3], '(') && tokens[i + 4]?.type === 'string' && pairs.has(i + 3)) {
      ranges.push({ name: `${tokens[i + 2].value.toUpperCase()} ${tokens[i + 4].value}`, from: i + 3, to: pairs.get(i + 3) });
      continue;
    }
    // function name(...) { ... }
    if (isIdent(tok, 'function') && isIdent(tokens[i + 1]) && isPunct(tokens[i + 2], '(') && pairs.has(i + 2)) {
      const bodyStart = pairs.get(i + 2) + 1;
      if (isPunct(tokens[bodyStart], '{') && pairs.has(bodyStart)) {
        ranges.push({ name: tokens[i + 1].value, from: i, to: pairs.get(bodyStart) });
      }
      continue;
    }
    // const name = (...) => { ... } / const name = async function (...) { ... }
    if ((isIdent(tok, 'const') || isIdent(tok, 'let')) && isIdent(tokens[i + 1]) && isPunct(tokens[i + 2], '=')) {
      let j = i + 3;
      if (isIdent(tokens[j], 'async')) j += 1;
      if (isIdent(tokens[j], 'function')) {
        j += 1;
        if (isIdent(tokens[j])) j += 1;
      }
      if (isPunct(tokens[j], '(') && pairs.has(j)) j = pairs.get(j) + 1;
      else if (isIdent(tokens[j])) j += 1;
      else continue;
      if (isPunct(tokens[j], '=') && isPunct(tokens[j + 1], '>')) j += 2;
      if (isPunct(tokens[j], '{') && pairs.has(j)) {
        ranges.push({ name: tokens[i + 1].value, from: i, to: pairs.get(j) });
      }
    }
  }
  return ranges;
}

/**
 * Wie wird ein Statement abgeholt? Folgt der Methodenkette hinter `prepare(...)`.
 * @returns {'list'|'row'|'kept'}
 */
function fetchKind(tokens, pairs, from) {
  let j = from;
  while (isPunct(tokens[j], '.') && isIdent(tokens[j + 1]) && isPunct(tokens[j + 2], '(') && pairs.has(j + 2)) {
    const method = tokens[j + 1].value;
    if (method === 'all' || method === 'iterate') return 'list';
    if (method === 'get' || method === 'run') return 'row';
    j = pairs.get(j + 2) + 1;
  }
  return 'kept';
}

/**
 * Ein aufgehobenes Statement (`const stmt = db.prepare(...)`): wie wird die
 * Variable in der Datei benutzt? Irgendein `.all()`/`.iterate()` macht es zur
 * Liste; nur `.get()`/`.run()` zur Einzelzeile. Nicht auffindbar zaehlt als
 * Liste - im Zweifel lieber rot.
 */
function keptStatementKind(tokens, pairs, dotIndex) {
  let k = dotIndex - 1;
  // Rueckwaerts ueber den Empfaenger: `db.get()`, `database`, `this.db` ...
  while (k >= 0) {
    if (isPunct(tokens[k], ')')) {
      const open = [...pairs.entries()].find(([, close]) => close === k)?.[0];
      if (open === undefined) break;
      k = open - 1;
    } else if (isIdent(tokens[k]) || isPunct(tokens[k], '.')) {
      k -= 1;
    } else break;
  }
  if (!isPunct(tokens[k], '=') || !isIdent(tokens[k - 1]) || !(isIdent(tokens[k - 2], 'const') || isIdent(tokens[k - 2], 'let'))) {
    return 'list';
  }
  const name = tokens[k - 1].value;
  const uses = new Set();
  for (let i = 0; i < tokens.length; i += 1) {
    if (isIdent(tokens[i], name) && !isPunct(tokens[i - 1], '.') && isPunct(tokens[i + 1], '.') && isIdent(tokens[i + 2])) {
      uses.add(fetchKind(tokens, pairs, i + 1));
    }
  }
  if (uses.has('list') || uses.has('kept') || uses.size === 0) return 'list';
  return 'row';
}

function lineOf(src, offset) {
  let line = 1;
  for (let i = 0; i < offset; i += 1) if (src[i] === '\n') line += 1;
  return line;
}

/**
 * Alle Personenlisten aus `users` ohne das Praedikat in einer Quelle.
 * @returns {Array<{ file: string, site: string, line: number }>}
 */
export function unfilteredPeopleLists(src, file) {
  const { tokens } = tokenize(src);
  const pairs = bracketPairs(tokens);
  const ctx = {
    predicateNames: importedPredicateNames(tokens, file),
    consts: constInitializers(tokens, pairs),
  };
  const ranges = siteRanges(tokens, pairs);
  const findings = [];
  for (let i = 0; i < tokens.length; i += 1) {
    if (!isPunct(tokens[i], '.') || !isIdent(tokens[i + 1], 'prepare') || !isPunct(tokens[i + 2], '(')) continue;
    const close = pairs.get(i + 2);
    if (close === undefined) continue;
    const arg = tokens.slice(i + 3, close);
    const sql = sqlText(arg, ctx);
    // Nur Lesen: ein `INSERT ... SELECT ... FROM users` schreibt, es zeigt niemanden.
    if (!/^\s*(select|with)\b/i.test(sql) || !drivesFromUsers(sql)) continue;

    let kind = fetchKind(tokens, pairs, close + 1);
    if (kind === 'kept') kind = keptStatementKind(tokens, pairs, i);
    if (kind === 'row') continue;
    if (carriesPredicate(arg, ctx)) continue;

    const enclosing = ranges
      .filter((r) => r.from <= i && i <= r.to)
      .sort((a, b) => (a.to - a.from) - (b.to - b.from))[0];
    findings.push({ file, site: enclosing?.name ?? '<module>', line: lineOf(src, tokens[i].start) });
  }
  return findings;
}

function serverFiles(dir = join(ROOT, 'server')) {
  const out = [];
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) out.push(...serverFiles(full));
    else if (name.endsWith('.js')) out.push(relative(ROOT, full).split(sep).join('/'));
  }
  return out.sort();
}

// --------------------------------------------------------------------------
// Selbsttests: jede Weise, auf die ein Textguard sich taeuschen laesst.
// --------------------------------------------------------------------------

const ROUTE = 'server/routes/probe.js';
const IMPORT = "import { householdMemberSql } from '../services/household-members.js';\n";
const sites = (src, file = ROUTE) => unfilteredPeopleLists(src, file).map((f) => f.site);

test('self-test: an unfiltered list of people in a new route is red', () => {
  const src = `${IMPORT}router.get('/people', (req, res) => {
    const rows = db.get().prepare('SELECT id, display_name FROM users ORDER BY display_name').all();
    res.json({ data: rows });
  });`;
  assert.deepEqual(sites(src), ['GET /people']);
});

test('self-test: the predicate interpolated into the SQL is green', () => {
  const src = `${IMPORT}router.get('/people', (req, res) => {
    const rows = db.get().prepare(\`SELECT u.id FROM users u WHERE \${householdMemberSql('u')}\`).all();
  });`;
  assert.deepEqual(sites(src), []);
});

test('self-test: a comment naming the predicate does not make it green', () => {
  const src = `${IMPORT}router.get('/people', (req, res) => {
    // \${householdMemberSql('u')}
    /* householdMemberSql('u') */
    const rows = db.get().prepare(\`SELECT u.id FROM users u /* \${'x'} */ ORDER BY u.id\`).all();
  });`;
  assert.deepEqual(sites(src), ['GET /people']);
});

test('self-test: the predicate name as text inside the SQL does not make it green', () => {
  const src = `${IMPORT}router.get('/people', (req, res) => {
    const rows = db.get().prepare("SELECT u.id FROM users u WHERE householdMemberSql('u')").all();
  });`;
  assert.deepEqual(sites(src), ['GET /people']);
});

test('self-test: a same-named function that is not the imported predicate is red', () => {
  const src = `const householdMemberSql = () => '1 = 1';
  router.get('/people', (req, res) => {
    const rows = db.get().prepare(\`SELECT u.id FROM users u WHERE \${householdMemberSql('u')}\`).all();
  });`;
  assert.deepEqual(sites(src), ['GET /people']);
});

test('self-test: an import of the predicate that is never used is red', () => {
  const src = `${IMPORT}function listPeople() {
    return db.prepare('SELECT u.id FROM users u').all();
  }`;
  assert.deepEqual(sites(src), ['listPeople']);
});

test('self-test: a predicate held in a constant counts, an SQL held in a constant is read', () => {
  const green = `${IMPORT}const MEMBER = householdMemberSql('u');
  function listPeople() { return db.prepare(\`SELECT u.id FROM users u WHERE \${MEMBER}\`).all(); }`;
  assert.deepEqual(sites(green), []);
  const red = `const PEOPLE_SQL = \`SELECT id FROM users ORDER BY id\`;
  function listPeople() { return db.prepare(PEOPLE_SQL).all(); }`;
  assert.deepEqual(sites(red), ['listPeople']);
});

test('self-test: single rows, writes, joins and subqueries are not lists of people', () => {
  const src = `function lookups(id) {
    db.prepare('SELECT * FROM users WHERE id = ?').get(id);
    db.prepare('DELETE FROM users WHERE id = ?').run(id);
    db.prepare('SELECT t.*, u.display_name FROM tasks t LEFT JOIN users u ON u.id = t.created_by').all();
    db.prepare('SELECT * FROM tasks WHERE assigned_to IN (SELECT id FROM users)').all();
    db.prepare('SELECT * FROM users_archive').all();
  }`;
  assert.deepEqual(sites(src), []);
});

test('self-test: a statement kept for later is judged by how its variable is used', () => {
  const list = `function listPeople() {
    const stmt = db.get().prepare('SELECT id FROM users');
    return stmt.all();
  }`;
  assert.deepEqual(sites(list), ['listPeople']);
  const lookup = `function uniqueName(base) {
    const exists = db.get().prepare('SELECT 1 FROM users WHERE username = ?');
    while (exists.get(base)) base += '1';
    return base;
  }`;
  assert.deepEqual(sites(lookup), []);
  const unknown = `function passOn() { return { stmt: db.prepare('SELECT id FROM users') }; }`;
  assert.deepEqual(sites(unknown), ['passOn'], 'a statement whose use cannot be followed counts as a list');
});

test('self-test: INSERT ... SELECT FROM users writes, it lists no one', () => {
  const src = `function copy(entryId, ids) {
    const ins = db.get().prepare(\`INSERT OR IGNORE INTO t (entry_id, user_id) SELECT ?, id FROM users WHERE id = ?\`);
    for (const id of ids) ins.run(entryId, id);
  }`;
  assert.deepEqual(sites(src), []);
});

test('self-test: dead code is dead, and a regex with quotes does not derail the reader', () => {
  const src = `function listPeople() {
    // db.prepare('SELECT id FROM users').all();
    /* db.prepare('SELECT id FROM users').all(); */
    const re = /['\`"]/g;
    const half = total / 2; const other = /x'/.test(half);
    return db.prepare('SELECT id FROM users').all();
  }`;
  assert.deepEqual(sites(src), ['listPeople']);
  assert.equal(unfilteredPeopleLists(src, ROUTE).length, 1);
});

// --------------------------------------------------------------------------
// Der Bestand
// --------------------------------------------------------------------------

test('every list of people in server/ goes through the household member predicate', () => {
  const findings = serverFiles().flatMap((file) => unfilteredPeopleLists(readFileSync(join(ROOT, file), 'utf8'), file));

  const grouped = new Map();
  for (const f of findings) {
    const key = `${f.file} :: ${f.site}`;
    if (!grouped.has(key)) grouped.set(key, []);
    grouped.get(key).push(f.line);
  }

  const problems = [];
  const allowed = new Map(ALLOWLIST.map((entry) => [`${entry.file} :: ${entry.site}`, entry]));
  for (const [key, lines] of grouped) {
    const entry = allowed.get(key);
    if (!entry) {
      problems.push(`${key} (line ${lines.join(', ')}): builds a list of people from users without ${PREDICATE_EXPORT}() from ${PREDICATE_MODULE}. Use the predicate, or add an allowlist entry with a reason why this list must see every row.`);
    } else if (entry.lists !== lines.length) {
      problems.push(`${key}: the allowlist expects ${entry.lists} unfiltered list(s), found ${lines.length} (line ${lines.join(', ')}).`);
    }
  }
  for (const [key] of allowed) {
    if (!grouped.has(key)) problems.push(`${key}: allowlist entry matches no unfiltered list any more - remove it.`);
  }
  assert.deepEqual(problems, []);
});

test('the allowlist stays short and every entry names a reason', () => {
  assert.ok(ALLOWLIST.length <= 15, 'a long allowlist is a second predicate - move lists onto the predicate instead');
  for (const entry of ALLOWLIST) {
    assert.ok(entry.reason && entry.reason.length > 20, `${entry.file} :: ${entry.site} needs a reason`);
  }
});
