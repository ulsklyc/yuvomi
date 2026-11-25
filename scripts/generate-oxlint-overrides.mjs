#!/usr/bin/env node
/**
 * Module: oxlint overrides for the senders and the rights rules
 * Purpose: Writes the `overrides` of .oxlintrc.json: `server/**` gets the base
 *          no-restricted-syntax list plus the sender selectors CHANNEL-SEND and PUSH-SEND
 *          and the rights selectors RIGHTS-SQL, RIGHTS-MODULE (phase 2, B5) and RIGHTS-ROW
 *          (phase 2, B8c), the list rule SQL-IN-LIST (Refs #2810) and the transaction rule
 *          TX-DRIVER (phase 2, F6d), and a few
 *          files get the same list minus what they are allowed to do. Areas (phase 2, F6c:
 *          SYNC-ONLY, DB-SINGLETON) add selectors to the files under them; every pattern gets
 *          one entry with the server list + the additions of its areas - its drops, the
 *          enclosing pattern first.
 * WHY: oxlint replaces the whole option list per override, and the later override wins.
 *      Written by hand, one forgotten selector switches a sender rule off for a file without
 *      a sound. Generated, every list is the server list minus a named exemption.
 *      The push senders are read from the dependency-cruiser rule `push-service-importers`,
 *      so a new sender is named in one place (.dependency-cruiser.mjs, with its reason) and
 *      this script carries it into the lint exceptions.
 * Run: node scripts/generate-oxlint-overrides.mjs           (rewrites .oxlintrc.json)
 *      node scripts/generate-oxlint-overrides.mjs --check   (exit 1 if the file would change)
 *      --root <dir> reads and writes in <dir> instead of the repository (tests).
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const RULE = 'eslint-js/no-restricted-syntax';
const PUSH_SERVICE = 'server/services/push.js';
const CHANNEL_DELIVERY = 'server/services/channel-delivery.js';

const CHANNEL = 'CHANNEL-SEND: a channel provider is called only in server/services/channel-delivery.js; send through sendToChannel() from a file that dependency-cruiser lets import it.';
const PUSH = 'PUSH-SEND: a Web Push is sent only by the files .dependency-cruiser.mjs names in push-service-importers, each with its recipient check; add the new sender there with its reason.';
const WEBPUSH = 'PUSH-SEND: web-push is called only in server/services/push.js, which checks isActiveAccount first.';

// Phase 2, B5: the SQL visibility rules and the module verdict have one home,
// server/authorize/ (index.ts is its only door). These selectors find them spelled again
// elsewhere. RIGHTS-SQL is a list of exceptions (lint-baseline-reasons.json: a write,
// never a read); RIGHTS-MODULE is hard. Neither sees a computed key
// (`modules[name] === 'none'`), a module level read into a variable first, or SQL assembled
// from pieces that split `visibility` from its value; these are left to review and to
// test:visibility-matrix.
// Phase 2, B8c: RIGHTS-ROW finds a visibility level compared with a string literal in
// JavaScript (`row.visibility === 'all'`), the read rule B8b moved into server/authorize/.
// Like RIGHTS-SQL it is a list of exceptions: a write filter or data upkeep, never a read
// rule, stands in lint-baseline-reasons.json with its reason. Its operand is a member
// `.visibility` (dot, `['visibility']`, optional chain, behind a call) or a variable named
// `visibility`; seen: ===, !==, ==, != in both orders, a `case` literal of a switch on it,
// `[<literal>, ...].includes(it)`, and the level as one side of a `||`, `&&` or `??`
// (`(row.visibility ?? 'private') !== 'private'`). Blind: a level under another name (`level`, `vis`, a
// destructured alias), a template literal or a constant as the other side, a named list
// (`VISIBILITIES.includes`, `new Set([...]).has`), indexOf, some(), a regex, a level passed through a call first (`String(row.visibility)`,
// `row.visibility.toLowerCase()`), a list whose first element is no literal, a lookup table keyed by the
// level (`MAP[row.visibility]`), a comparison in SQL (that is RIGHTS-SQL's).
const RIGHTS_SQL = 'RIGHTS-SQL: a visibility literal in SQL outside server/authorize/; ask visibleWhere()/filterVisible() or a named rule of server/authorize/index.ts. A write, never a read, stands in lint-baseline-reasons.json with its reason.';
const RIGHTS_MODULE = "RIGHTS-MODULE: a module level compared with 'none' outside server/authorize/; ask authorize(actor, 'read' | 'write' | 'receive', { module }).";
const RIGHTS_ROW = 'RIGHTS-ROW: a visibility level compared in JavaScript outside server/authorize/; ask rowVisible(), householdVisible() or a named rule of server/authorize/index.ts. A write filter or data upkeep, never a read rule, stands in lint-baseline-reasons.json with its reason.';
/**
 * The ways `<path>` holds a visibility level: row.visibility, row['visibility'],
 * row?.visibility, row?.['visibility'] (a ChainExpression around the member), `visibility`.
 * A computed key held in a variable (`row[visibility]`) is not one.
 * @param {string} path
 */
const levelForms = (path) => [
  `[${path}.type='MemberExpression'][${path}.computed=false][${path}.property.name='visibility']`,
  `[${path}.type='MemberExpression'][${path}.property.value='visibility']`,
  `[${path}.type='Identifier'][${path}.name='visibility']`,
  `[${path}.type='ChainExpression'][${path}.expression.computed=false][${path}.expression.property.name='visibility']`,
  `[${path}.type='ChainExpression'][${path}.expression.property.value='visibility']`,
];
// One level of ||, && or ?? around it counts as well: (row.visibility ?? 'private'),
// (visibility || existing.visibility).
/** @param {string} path */
const visibilityAt = (path) => `:matches(${[
  ...levelForms(path),
  ...['left', 'right'].flatMap((side) => levelForms(`${path}.${side}`)
    .map((form) => `[${path}.type='LogicalExpression']${form}`)),
].join(', ')})`;
// A string literal (the regex passes only strings: null, undefined, numbers stay silent).
/** @param {string} path */
const levelAt = (path) => `[${path}.type='Literal'][${path}.value=/./]`;
const looseOrStrict = '[operator=/^[!=]==?$/]';
// Case-insensitive (the `i` flag passes the esquery bridge, measured 13 Nov 2026).
const sqlVisibility = "/visibility\\s*(=|<>|!=|(NOT\\s+)?IN)\\s*('|\\()/i";
const RIGHTS_SELECTORS = [
  // `... t.visibility = 'all' ...`, `${alias}.visibility IN ('a', 'b')`, `not in (`, also over a line break
  { selector: `TemplateElement[value.raw=${sqlVisibility}]`, message: RIGHTS_SQL },
  // "... q.visibility <> 'private'"
  { selector: `Literal[value=${sqlVisibility}]`, message: RIGHTS_SQL },
  // perms.modules.health === 'none', resolve(u).modules.tasks != 'none'
  { selector: "BinaryExpression[operator=/^[!=]==?$/][left.type='MemberExpression'][left.object.type='MemberExpression'][left.object.property.name='modules'][right.value='none']", message: RIGHTS_MODULE },
  // 'none' === perms.modules.notes
  { selector: "BinaryExpression[operator=/^[!=]==?$/][right.type='MemberExpression'][right.object.type='MemberExpression'][right.object.property.name='modules'][left.value='none']", message: RIGHTS_MODULE },
  // row.visibility === 'all', row?.visibility != 'family', visibility !== 'restricted'
  { selector: `BinaryExpression${looseOrStrict}${levelAt('right')}${visibilityAt('left')}`, message: RIGHTS_ROW },
  // 'all' === row.visibility
  { selector: `BinaryExpression${looseOrStrict}${levelAt('left')}${visibilityAt('right')}`, message: RIGHTS_ROW },
  // switch (row.visibility) { case 'all': ... } - one finding per literal case
  { selector: `SwitchStatement${visibilityAt('discriminant')} > SwitchCase${levelAt('test')}`, message: RIGHTS_ROW },
  // ['all', 'family'].includes(row.visibility)
  { selector: `CallExpression[callee.type='MemberExpression'][callee.property.name='includes'][callee.object.type='ArrayExpression']${levelAt('callee.object.elements.0')}${visibilityAt('arguments.0')}`, message: RIGHTS_ROW },
];
// Refs #2810 (follow-up 5a): SQL-IN-LIST finds a list built with one SQL placeholder per
// value: `ids.map(() => '?')`, `() => '(?, ?)'` for multi-row VALUES, `(_v, i) => `@f${i}``
// for named ones, either branch of a conditional, a `return '?'` in a function passed to
// map/flatMap/from, `.fill('?')`, `'?, '.repeat(n)` and `.join('?')`. SQLite takes at most
// 32766 host parameters per statement, so such a list breaks with "too many SQL variables"
// (a 500) at that length, and every length is a new statement text. A value list goes in as
// one parameter: sqlInList() from server/utils/sql-in-list.ts (json_each). A fixed column
// list (`VALUES (${COLUMNS.map(() => '?')})`) is no value list and stands in
// lint-baseline-reasons.json with its reason. Blind: a placeholder string held in a variable
// first (`const q = '?'; ids.map(() => q)`), a loop that pushes '?', a function declared
// elsewhere and passed by name, string concatenation in a reduce; left to review.
const SQL_LIST = 'SQL-IN-LIST: one SQL placeholder per value breaks at 32766 host parameters with a 500; pass the list as one parameter with sqlInList() (server/utils/sql-in-list.ts). A fixed column list stands in lint-baseline-reasons.json with its reason.';
// Only placeholders, commas, blanks and parentheses, at least one `?`: '?', '(?, ?)', '?,'.
const marks = '/^[\\s(]*\\?[\\s?,()]*$/';
// A named placeholder in front of the index: `@f${i}`, `:d${i}`, `$${i}`.
const named = '/^[\\s(]*[@:$][A-Za-z_]*$/';
const SQL_LIST_SELECTORS = [
  // ids.map(() => '?'), rows.map(() => '(?, ?, ?)')
  { selector: `ArrowFunctionExpression[body.type='Literal'][body.value=${marks}]`, message: SQL_LIST },
  // ids.map(() => `?`)
  { selector: `ArrowFunctionExpression[body.type='TemplateLiteral'][body.expressions.length=0][body.quasis.0.value.raw=${marks}]`, message: SQL_LIST },
  // ids.map((_v, i) => `@f${i}`)
  { selector: `ArrowFunctionExpression[body.type='TemplateLiteral'][body.expressions.length>0][body.quasis.0.value.raw=${named}]`, message: SQL_LIST },
  // ids.map((_, i) => (named ? `@${named}${i}` : '?'))
  { selector: `ArrowFunctionExpression[body.type='ConditionalExpression']:matches([body.consequent.value=${marks}], [body.alternate.value=${marks}], [body.consequent.quasis.0.value.raw=${named}], [body.alternate.quasis.0.value.raw=${named}])`, message: SQL_LIST },
  // ids.map(function () { return '?'; })
  { selector: `CallExpression[callee.property.name=/^(map|flatMap|from)$/] > FunctionExpression ReturnStatement[argument.value=${marks}]`, message: SQL_LIST },
  // Array(n).fill('?'), '?, '.repeat(n), Array(n + 1).join('?')
  { selector: `CallExpression[callee.property.name='fill'][arguments.0.value=${marks}]`, message: SQL_LIST },
  { selector: `CallExpression[callee.property.name='repeat'][callee.object.value=${marks}]`, message: SQL_LIST },
  { selector: `CallExpression[callee.property.name='join'][arguments.0.value=${marks}]`, message: SQL_LIST },
];
// Phase 2, F6d (hard): TX-DRIVER finds a call of a method named `transaction` in the server:
// the driver's `conn.transaction(fn)` (which builds the function and runs nothing without the
// second call), `.immediate()` and friends behind it, and the old facade `db.transaction(fn)`.
// A transaction is withTx(db, fn) from server/db/tx.ts, one way for both SQLite drivers.
// test/ is outside the rule (tests use the driver on purpose). Blind: a computed key
// (`conn['transaction']`), the method under another name (`const t = conn.transaction`
// is a member read, not a call, and its later call `t(fn)` names no `transaction`).
const TX_DRIVER = 'TX-DRIVER: a transaction is withTx(db, fn) from server/db/tx.ts, one way for both SQLite drivers, without the second call that conn.transaction(fn) needs and that runs nothing when it is forgotten.';
const TX_DRIVER_SELECTOR = { selector: "CallExpression[callee.type='MemberExpression'][callee.computed=false][callee.property.name='transaction']", message: TX_DRIVER };
// #2956 (hard): DOC-CONTENT keeps the content of a document row fixed once it is created.
// The calendar's attachment copies reuse a read buffer and staged files across planning
// rounds (runWithAttachmentClonePlan in server/routes/calendar/crud.js); that holds because
// nothing in the server rewrites storage_key, storage_backend, storage_provider,
// content_data, mime_type or file_size of a family_documents row. The selectors read the SQL
// text of a string or of one template part (also multi-line) and find three forms:
//   - `UPDATE [OR x] [schema.]family_documents [[AS] alias] SET ... <column> =` before any
//     WHERE, the table, schema and column names bare, quoted or bracketed, also a column in a
//     row-value list (`SET (name, storage_key) = (...)`);
//   - an upsert `INSERT [OR x] INTO [schema.]family_documents ... DO UPDATE SET ... <column> =`
//     before any WHERE;
//   - `INSERT OR REPLACE INTO` / `REPLACE INTO` [schema.]family_documents, which replaces a
//     whole row with the same key.
// Silent: another table (also one whose name starts with family_documents), a content column
// in a WHERE clause or on the right of `=`. The migrations stay outside (SCHEMA_HOME).
// Blind, by design of a text rule: the table, schema or column name interpolated
// (`UPDATE ${table}`, `SET ${column} = ?`); SQL split over several strings or template parts
// joined with `+`, `.join()` or an interpolation before the SET clause; SQL built outside a
// string literal (a query builder, a variable holding the column list); a write through a
// view or a trigger; a row deleted and inserted again with its old id (AUTOINCREMENT does not
// hand out an old id by itself, an explicit id can); the file itself changed in storage
// without touching the row.
const DOC_CONTENT = 'DOC-CONTENT: the content of a document row (storage_key, storage_backend, storage_provider, content_data, mime_type, file_size) is fixed once it is created; a new file is a new document row. The calendar attachment copies rely on it (#2956).';
const DOC_Q = '["`\\[]?';
const DOC_QE = '["`\\]]?';
const DOC_TABLE = `(${DOC_Q}\\w+${DOC_QE}\\.)?${DOC_Q}family_documents${DOC_QE}`;
const DOC_COLUMNS = '(storage_key|storage_backend|storage_provider|content_data|mime_type|file_size)';
const DOC_SET_COLUMN = `SET((?!\\bWHERE\\b)[\\s\\S])*?\\b${DOC_COLUMNS}${DOC_QE}(\\s*=|[\\w\\s,"\`\\[\\]]*\\)\\s*=)`;
const DOC_CONTENT_RE = `/UPDATE\\s+(OR\\s+\\w+\\s+)?${DOC_TABLE}(\\s+(AS\\s+)?${DOC_Q}\\w+${DOC_QE})?\\s+${DOC_SET_COLUMN}`
  + `|INSERT\\s+(OR\\s+\\w+\\s+)?INTO\\s+${DOC_TABLE}\\b[\\s\\S]*?\\bDO\\s+UPDATE\\s+${DOC_SET_COLUMN}`
  + `|(INSERT\\s+OR\\s+REPLACE|REPLACE)\\s+INTO\\s+${DOC_TABLE}\\b/i`;
const DOC_CONTENT_SELECTORS = [
  { selector: `Literal[value=${DOC_CONTENT_RE}]`, message: DOC_CONTENT },
  { selector: `TemplateElement[value.raw=${DOC_CONTENT_RE}]`, message: DOC_CONTENT },
];
// The schema and its migrations write SQL that is frozen once applied.
const SCHEMA_HOME = ['server/db.js', 'server/migrations/**'];

// Where the rule is the rule itself: the permission module and the API documentation;
// the schema and its migrations (migrations and seeds write visibility values) are SCHEMA_HOME.
const RIGHTS_HOME = ['server/authorize/**', 'server/openapi/**'];

// Phase 2, F6c (plan E15 (a)): rules that hold only in some directories. They are areas: the
// generator adds their selectors to every file under them, on top of the server list and
// minus what that file's exceptions drop, and writes one override per pattern, the
// enclosing one first.
//
// SYNC-ONLY (hard): the database driver is synchronous, and every await is a yield point
// where another request runs between a read and the write that depends on it. The
// permission module, the migrations, the database core and the read slices of the overview
// stay without async, await and for await. server/db/backup.ts and server/db/restore.ts
// work on files and are asynchronous by nature; they get a later override that drops the
// rule again (a second entry, not excludeFiles, so that one resolution rule covers all).
// Blind: a promise chain (`.then()`) or a callback that defers the write, a call into an async
// helper outside the areas.
const SYNC = 'SYNC-ONLY: the database driver is synchronous and every await is a yield point between a read and its write; server/authorize/, server/migrations/, server/db/ (backup.ts and restore.ts apart), server/db.js and the read slices server/services/*-slices.ts stay without async/await.';
const SYNC_SELECTORS = [
  { selector: ':function[async=true]', message: SYNC },
  { selector: 'AwaitExpression', message: SYNC },
  { selector: 'ForOfStatement[await=true]', message: SYNC },
];
const SYNC_HOME = ['server/authorize/**', 'server/migrations/**', 'server/db/**', 'server/db.js', 'server/services/*-slices.ts'];
const SYNC_EXEMPT = ['server/db/backup.ts', 'server/db/restore.ts'];

// DB-SINGLETON (a baseline that only sinks): the services and the permission module ask the
// module-wide connection with `db.get()`. New and rebuilt modules take the connection as
// their first parameter (resolvePermissions(db, ...), pantryExpiringSlice(db, ...),
// withTx(db, fn)); db.get() stays the facade of routes and entry points. Both names
// server/services/ imports server/db.js under (`db`, `dbModule`) are matched.
// Blind: another import name, `const { get } = db`, `db['get']()`, the connection reached
// through a detour (`getDb()`, a helper that calls db.get() for the caller).
const DB_HANDLE = 'DB-SINGLETON: a service reads the module-wide connection with db.get(); take the connection as the first parameter (resolvePermissions(db, ...), withTx(db, fn)) and leave db.get() to routes and entry points. The baseline only sinks.';
const DB_SELECTOR = { selector: "CallExpression[arguments.length=0][callee.type='MemberExpression'][callee.computed=false][callee.property.name='get'][callee.object.type='Identifier'][callee.object.name=/^(db|dbModule)$/]", message: DB_HANDLE };
const DB_HOME = ['server/services/**', 'server/authorize/**'];

/** @type {{ files: string[], add: object[] }[]} */
const AREAS = [
  { files: SYNC_HOME, add: SYNC_SELECTORS },
  { files: DB_HOME, add: [DB_SELECTOR] },
];
/** @type {{ files: string[], drop: object[] }[]} */
const SYNC_EXEMPT_GROUPS = [{ files: SYNC_EXEMPT, drop: SYNC_SELECTORS }];

const isSend = ":matches([callee.property.name='send'], [callee.property.value='send'])";
const CHANNEL_SELECTORS = [
  // provider.send(...), providers.send(...)
  { selector: `CallExpression${isSend}[callee.object.type='Identifier'][callee.object.name=/^providers?$/]`, message: CHANNEL },
  // providers[x].send(...), provider.x.send(...)
  { selector: `CallExpression${isSend}[callee.object.type='MemberExpression'][callee.object.object.type='Identifier'][callee.object.object.name=/^providers?$/]`, message: CHANNEL },
  // x.provider.send(...), this.providers.send(...), x['providers'].send(...)
  { selector: `CallExpression${isSend}[callee.object.type='MemberExpression']:matches([callee.object.property.name=/^providers?$/], [callee.object.property.value=/^providers?$/])`, message: CHANNEL },
  // this.providers[x].send(...), svc.providers[x].send(...), x['providers'][y].send(...)
  { selector: `CallExpression${isSend}[callee.object.type='MemberExpression'][callee.object.object.type='MemberExpression']:matches([callee.object.object.property.name=/^providers?$/], [callee.object.object.property.value=/^providers?$/])`, message: CHANNEL },
  // anything.send({ channel, ... }) - the shape, whatever the provider is called
  { selector: `CallExpression${isSend} > ObjectExpression:first-child > Property:matches([key.name='channel'], [key.value='channel'])`, message: CHANNEL },
];
const PUSH_SELECTOR = { selector: "CallExpression:matches([callee.property.name='sendPushToUser'], [callee.property.value='sendPushToUser'], [callee.name='sendPushToUser'])", message: PUSH };
const WEBPUSH_SELECTOR = { selector: "CallExpression:matches([callee.property.name='sendNotification'], [callee.property.value='sendNotification'], [callee.name='sendNotification'])", message: WEBPUSH };

/**
 * The push senders as `push-service-importers` names them, push.js itself apart.
 * Each pathNot entry must spell one file (`^server/x/y\.[jt]s$`); anything else is an error,
 * because a pattern cannot become a lint `files` entry without guessing.
 * @param {string} root
 * @returns {Promise<string[]>}
 */
export async function pushSenders(root) {
  const { default: config } = await import(pathToFileURL(resolve(root, '.dependency-cruiser.mjs')).href);
  const rule = config.forbidden.find((/** @type {{ name: string }} */ r) => r.name === 'push-service-importers');
  if (!rule) throw new Error('.dependency-cruiser.mjs has no rule push-service-importers');
  return [rule.from.pathNot].flat().map((/** @type {string} */ pattern) => {
    const match = /^\^(server\/[\w/-]+)\\\.\[jt\]s\$$/.exec(pattern);
    if (!match) throw new Error(`push-service-importers: ${pattern} does not name one file (^server/x/y\\.[jt]s$)`);
    return `${match[1]}.js`;
  }).filter((file) => file !== PUSH_SERVICE);
}

/**
 * Does pattern `a` take in everything pattern `b` names? Three forms only: `dir/**`, a file
 * glob with `*` inside one path segment (`dir/*-x.ts`, `*` never crosses a `/`, measured
 * against oxlint 1.93), and a plain file. Anything else is an error: the overlap check below
 * must not guess.
 * @param {string} a @param {string} b
 */
export function patternCovers(a, b) {
  if (a === b) return true;
  if (a.endsWith('/**')) return b.startsWith(a.slice(0, -2));
  if (a.includes('**')) throw new Error(`oxlint override pattern ${a}: ** only as the last segment`);
  if (!a.includes('*')) return false;
  if (b.includes('*')) return false;
  const re = new RegExp(`^${a.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '[^/]*')}$`);
  return re.test(b);
}

/**
 * Can two patterns name a common file? Nested or equal counts; so do two file globs in one
 * directory that are not the same (their intersection is not worked out, the check errs red).
 * @param {string} a @param {string} b
 */
function patternsOverlap(a, b) {
  if (patternCovers(a, b) || patternCovers(b, a)) return true;
  if (a.endsWith('/**') || b.endsWith('/**')) return false;
  const dir = (/** @type {string} */ p) => p.slice(0, p.lastIndexOf('/'));
  return a.includes('*') && b.includes('*') && dir(a) === dir(b);
}

/**
 * The overrides as oxlint reads them: for a file the LAST override whose `files` match wins
 * whole, else the base rule (measured on a fixture, test:lint-baseline). Two overrides may name
 * a common file only when the later one sits inside the earlier one (every pattern of the later
 * entry is covered by a pattern of the earlier one) and keeps every selector of the earlier
 * one it is not allowed to drop. Two entries of the same rank (same pattern twice, or patterns
 * that cross without nesting) are an error: the later list would win whole and silently take
 * back what the earlier one adds.
 * @param {{ files: string[], rules: Record<string, unknown[]> }[]} overrides
 * @param {(file: string) => object[]} mayDrop - selectors a pattern may lose against its parent
 */
export function checkNesting(overrides, mayDrop) {
  overrides.forEach((a, i) => overrides.slice(i + 1).forEach((b) => {
    for (const f of a.files) for (const g of b.files) {
      if (!patternsOverlap(f, g)) continue;
      if (f === g || !patternCovers(f, g)) throw new Error(`oxlint overrides overlap: ${f} and ${g}`);
      const kept = new Set(b.rules[RULE].slice(1));
      const lost = a.rules[RULE].slice(1).filter((s) => !kept.has(s) && !mayDrop(g).includes(/** @type {object} */ (s)));
      if (lost.length > 0) throw new Error(`oxlint override ${g} loses what ${f} adds: ${lost.map((s) => /** @type {{ message: string }} */ (s).message.split(':')[0]).join(', ')}`);
    }
  }));
}

/**
 * @param {any} config - the parsed .oxlintrc.json
 * @param {string[]} senders - the push senders, push.js apart
 * @returns {any[]} the overrides
 */
export function buildOverrides(config, senders) {
  const [severity, ...base] = config.rules[RULE];
  const server = [...base, ...CHANNEL_SELECTORS, PUSH_SELECTOR, WEBPUSH_SELECTOR, ...RIGHTS_SELECTORS, ...SQL_LIST_SELECTORS, TX_DRIVER_SELECTOR, ...DOC_CONTENT_SELECTORS];
  const utc = base.filter((/** @type {{ message: string }} */ s) => s.message.startsWith('UTC-DAY-KEY:'));
  // Areas add selectors to every file under them; exceptions drop selectors from their files.
  /** @type {{ files: string[], add: object[] }[]} */
  const areas = AREAS;
  /** @type {{ files: string[], drop: object[] }[]} */
  const exceptions = [
    { files: ['server/utils/timezone.js'], drop: utc },
    { files: [CHANNEL_DELIVERY], drop: CHANNEL_SELECTORS },
    { files: senders, drop: [PUSH_SELECTOR] },
    { files: [PUSH_SERVICE], drop: [PUSH_SELECTOR, WEBPUSH_SELECTOR] },
    { files: RIGHTS_HOME, drop: RIGHTS_SELECTORS },
    { files: SCHEMA_HOME, drop: [...RIGHTS_SELECTORS, ...SQL_LIST_SELECTORS, ...DOC_CONTENT_SELECTORS] },
    ...SYNC_EXEMPT_GROUPS,
  ];
  // Exceptions never overlap one another: what a file may drop is named in one place.
  exceptions.forEach((a, i) => exceptions.slice(i + 1).forEach((b) => {
    for (const f of a.files) for (const g of b.files) {
      if (patternsOverlap(f, g)) throw new Error(`oxlint overrides overlap: ${f} and ${g}`);
    }
  }));
  /** @param {string} pattern */
  const dropsOf = (pattern) => exceptions.filter((e) => e.files.some((f) => patternCovers(f, pattern))).flatMap((e) => e.drop);
  /** @param {string} pattern */
  const listOf = (pattern) => {
    const add = areas.filter((a) => a.files.some((f) => patternCovers(f, pattern))).flatMap((a) => a.add);
    const drop = dropsOf(pattern);
    return [severity, ...[...server, ...add].filter((s) => !drop.includes(s))];
  };
  // Every pattern once, in the order it is first named (exceptions, then areas); its rank is
  // the number of other patterns around it, so an enclosing pattern always comes first and
  // the more special one later (the later override wins).
  const patterns = [...new Set([...exceptions, ...areas].flatMap((e) => e.files))];
  const rank = (/** @type {string} */ p) => patterns.filter((q) => q !== p && patternCovers(q, p)).length;
  const ordered = patterns.map((p, i) => ({ p, i, r: rank(p) })).sort((a, b) => a.r - b.r || a.i - b.i);
  // Patterns of one rank with the same list share an entry.
  /** @type {{ files: string[], rules: Record<string, unknown[]>, rank: number }[]} */
  const entries = [];
  for (const { p, r } of ordered) {
    const list = listOf(p);
    const key = JSON.stringify(list);
    const same = entries.find((e) => e.rank === r && JSON.stringify(e.rules[RULE]) === key);
    if (same) same.files.push(p);
    else entries.push({ files: [p], rules: { [RULE]: list }, rank: r });
  }
  const overrides = [{ files: ['server/**'], rules: { [RULE]: [severity, ...server] } }, ...entries.map(({ files, rules }) => ({ files, rules }))];
  // A pattern may lose against an enclosing one exactly what its own exceptions drop.
  checkNesting(overrides, dropsOf);
  return overrides;
}

async function main() {
  const args = process.argv.slice(2);
  const rootAt = args.indexOf('--root');
  const root = rootAt >= 0 ? resolve(args[rootAt + 1]) : fileURLToPath(new URL('..', import.meta.url));
  const path = resolve(root, '.oxlintrc.json');
  const before = readFileSync(path, 'utf8');
  const config = JSON.parse(before);
  config.overrides = buildOverrides(config, await pushSenders(root));
  const after = `${JSON.stringify(config, null, 2)}\n`;
  if (args.includes('--check')) {
    if (after !== before) {
      console.error('.oxlintrc.json overrides are out of date: run node scripts/generate-oxlint-overrides.mjs');
      process.exit(1);
    }
    console.log('.oxlintrc.json overrides are current.');
    return;
  }
  writeFileSync(path, after);
  console.log(after === before ? '.oxlintrc.json unchanged.' : '.oxlintrc.json overrides rewritten.');
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
