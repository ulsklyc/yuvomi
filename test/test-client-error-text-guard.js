/**
 * Test: no exception text reaches the client (Phase 0, section H; roadmap decision 19)
 * Purpose: an error a route catches is answered with a fixed English sentence
 *          plus `reason` (CONTRIBUTING, error contract). What a foreign library,
 *          the network stack, SQLite or the filesystem wrote into `err.message`
 *          names hosts, ports, absolute paths, SQL and table names - none of it
 *          belongs in a response body, not even for an admin (decision E4b:
 *          a connection test answers with `reason` plus the error class in
 *          `detail`, e.g. `ECONNREFUSED` or `HTTP 401`, never the raw text).
 *
 *          A SOURCE READER WITH AN EXPIRY DATE. Phase 1b brings the central
 *          error handler (status from `err.status`, route into the log) and an
 *          ESLint `no-restricted-syntax` rule; this file goes then. Until then
 *          it reads every file under server/ and reports each place where an
 *          exception's text is handed to a response:
 *            - `err.message` (any name ending in err/error, `e`, `ex`, `exc`,
 *              `cause`, `failure`; with or without `?.`), `String(err)` or
 *              `${err}` inside the arguments of `res.json(...)`,
 *              `res.send(...)`, `res.end(...)` - also behind a chain such as
 *              `res.status(500).json(...)` across lines;
 *            - the same inside the arguments of a SEND HELPER: any call that
 *              takes `res` as its first argument (`sendGoogleError(res, err)`,
 *              `sendStorageError(res, err, err.message)`, `sendRefusal(res,
 *              ...)`, `categoryErrorResponse(res, ...)`, `sendInstallError`,
 *              `passwordRequiredResponse` ...). A helper's own body is read
 *              like a route, so a helper that answers with the text is seen
 *              where it does it;
 *            - an alias assigned within the three lines before the call
 *              (`const message = err.message || 'x'; ... res.json({ error:
 *              message })`).
 *
 *          Every hit is counted per `file -> function` (the nearest enclosing
 *          route `METHOD /path` or named function). A hit is fine only where
 *          ALLOWED names it with its reason - class A, the text is our own:
 *          an `instanceof` gate on our own error class, an `err.code` or
 *          `err.reason` allowlist, a 4xx our own service threw. The counts can
 *          only fall: a new hit is red, and so is an entry with fewer hits than
 *          it allows (lower it) or none (remove it).
 *
 *          BASELINE holds the class B (foreign text) and class C (our text and
 *          foreign text in the same catch) places measured on 08.11.2026. They
 *          are the fix list of the follow-up PRs and must shrink to nothing.
 *
 *          WHY NOT A BEHAVIOUR TEST PER ROUTE: about 40 routes would each need
 *          a fake of the service they call, and the test would only find what
 *          this list already names. Three places where a reader is blind run
 *          as programs instead, in their route suites: the module asset route
 *          with a filesystem error that has no `status` (test:module-install),
 *          a split-expense create that hits a broken table (SQLite text,
 *          test:split-expenses-routes), and the WebDAV connection test against
 *          a fake server whose status line names host and path
 *          (test:backup-routes).
 *
 *          LIMITS (on purpose, a parser would be needed): a service that
 *          returns the text in a result object (`{ ok: false, error:
 *          err.message }`) and a route that hands that object on is not seen;
 *          neither is text stored in a `last_error` column and sent by a later
 *          status GET. An alias more than three lines above the call is not
 *          followed. The known indirect ways, measured on 08.11.2026, are
 *          fixed by hand in the follow-up PRs of Phase 0 section H:
 *            - routes/dms.js POST /accounts/:id/test <- dms/paperless.js,
 *              dms/papra.js (`error: err.message` in the probe result)
 *            - routes/recipe-providers.js (probe.error) <- recipe-providers/
 *              mealie.js, tandoor.js
 *            - services/email.js (SMTP test result), services/waste-url-source.js
 *              (`errorMessage` of a refresh)
 *            - services/modules.js (`error` of a module that fails to load,
 *              shown in the admin module list: fs/JSON text with paths)
 *            - stored text sent by a status GET: backup-webdav.js
 *              (`webdav_backup_last_error`), backup-scheduler.js
 *              (lastBackup.webdav.error), document-storage.js (`last_error`),
 *              routes/notifications.js (markChannelTestResult)
 *
 *          The three behaviour tests carry the todo marker TODO_MARKER while
 *          their BASELINE key is open; the last test below couples the two, so
 *          a fix cannot leave a silently passing `# TODO` behind.
 *
 * Run: npm run test:client-error-text-guard
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { withoutCommentsKeepingLines } from './source-text.js';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const SERVER = fileURLToPath(new URL('../server/', import.meta.url));

/**
 * Class A: the text in the response is our own. `file -> function` ->
 * [allowed hits, reason]. ONLY LOWER: whoever gates a place further lowers the
 * number or removes the line - the test asks for it.
 */
const ALLOWED = new Map([
  ['server/auth.js -> POST /invites/accept', [1, '`linkError` is the sentence assertSsoOnlyAllowed() returns, not an exception']],
  ['server/auth.js -> POST /2fa/setup', [1, 'gated on err.code === already_enabled, thrown by twoFactor.beginSetup']],
  ['server/auth.js -> POST /2fa/enable', [2, 'gated on the three err.code values twoFactor throws itself']],
  ['server/auth.js -> POST /me/avatar/gravatar', [1, 'Gravatar import: instanceof the own GravatarError, an operator error (500) gets a fixed sentence']],
  ['server/auth.js -> DELETE /users/:id', [2, 'instanceof RemovalRefused, the sentence of the last-admin rule']],
  ['server/middleware/error-handler.js -> errorHandler', [1, 'gated on reason restore_in_progress, the sentence of server/utils/restore-messages.js']],
  ['server/routes/calendar/apple.js -> POST /apple/connect', [1, 'gated on err.code === apple_no_calendars, thrown by apple-calendar.js itself']],
  ['server/routes/calendar/caldav.js -> POST /caldav/accounts', [2, 'gated on err.code caldav_account_exists / caldav_no_calendars, thrown by caldav-sync.js']],
  ['server/routes/calendar/caldav.js -> PUT /caldav/accounts/:id', [1, 'gated on err.code === password_required, thrown by updateAccount']],
  ['server/routes/calendar/caldav.js -> PATCH /caldav/accounts/:id/reminder-lists', [1, 'instanceof caldavReminders.ReminderListAssigneeError']],
  ['server/routes/calendar/crud.js -> sendNonMemberAssignment', [1, 'every caller gates on instanceof NonMemberAssignmentError']],
  ['server/routes/calendar/outlook.js -> PUT /outlook/accounts/:id', [2, 'gated on err.code not_household_member / outlook_auto_sync_overrides, thrown by outlook-calendar.js']],
  ['server/routes/calendar/outlook.js -> PATCH /outlook/accounts/:id/calendars', [1, 'gated on err.code === outlook_auto_sync_overrides']],
  ['server/routes/calendar/subscriptions.js -> POST /subscriptions', [2, "only behind icsFetchCase(): a named fetch case (own sentence, Node's `Invalid URL`); accepted: a BlockedAddressError names the private address the member's own URL resolved to"]],
  ['server/routes/calendar/subscriptions.js -> POST /subscriptions/:id/sync', [1, "only behind icsFetchCase(): a named fetch case (own sentence, Node's `Invalid URL`); accepted: a BlockedAddressError names the private address the member's own URL resolved to"]],
  ['server/routes/calendar/subscriptions.js -> POST /import', [1, "only behind icsFetchCase(): a named fetch case (own sentence, Node's `Invalid URL`); accepted: a BlockedAddressError names the private address the member's own URL resolved to"]],
  ['server/routes/health/fasting.js -> sendError', [1, 'instanceof FastingError, everything else gets a fixed sentence']],
  ['server/routes/health/visibility-defaults.js -> allowFastingMutation', [1, 'instanceof FastingError, everything else is rethrown']],
  ['server/routes/modules.js -> sendInstallError', [1, 'callers gate on instanceof InstallError (reason + status set by module-install.js)']],
  ['server/routes/modules.js -> PATCH /:id', [1, 'the pattern: text only with a reason or a 4xx, a raw 5xx gets a fixed sentence']],
  ['server/routes/notes.js -> categoryErrorResponse', [1, 'callers gate on categoryInputError(): the category validator\'s own 4xx']],
  ['server/routes/permissions.js -> PUT /role/:familyRole', [1, 'wording gate on the validator throws of server/permissions.js (Unknown/Invalid ...); SQLite never says either']],
  ['server/routes/permissions.js -> PUT /user/:userId', [1, 'wording gate on the validator throws of server/permissions.js (Unknown/Invalid ...); SQLite never says either']],
  ['server/routes/rewards.js -> moneyInputRefusal', [1, 'callers gate on err.name === SplitInputError or pass the parser\'s own sentence']],
  ['server/routes/schedule-extras.js -> fail', [1, '`error` is the route\'s own sentence passed as a parameter; String(error) only picks the range reason']],
  ['server/routes/schedule.js -> fail', [1, '`error` is the route\'s own sentence passed as a parameter; String(error) only picks the range reason']],
  ['server/routes/split-expenses.js -> sendRefusal', [1, 'callers gate on instanceof Refusal, the route\'s own refusal class']],
  ['server/routes/waste/helpers.js -> wasteErrorResponse', [2, 'instanceof WasteConflictError / WasteNotFoundError']],
  ['server/routes/waste/sources.js -> emptyFeedResponse', [1, 'emptyFeedAsFetchFailure() only returns its own fixed WasteFetchError behind instanceof WasteValidationError + reason']],
  ['server/services/document-deletion-lock.js -> sendDocumentDeletionConflict', [1, 'instanceof DocumentDeletionInProgressError']],
  ['server/services/document-links.js -> sendDocumentLinkRefusal', [1, 'instanceof DocumentLinkRefusedError']],
]);

/**
 * Class B and C, measured on 08.11.2026: fix pending, PR 2-3 of Phase 0
 * section H. `file -> function` -> hits. ONLY LOWER, down to an empty map.
 */
const BASELINE = new Map([
  // Class B: text of a foreign server, library or the network stack.
  ['server/routes/backup.js -> POST /webdav/test', 1],
  ['server/routes/backup.js -> GET /webdav/files', 1],
  ['server/routes/backup.js -> POST /webdav/trigger', 1],
  ['server/routes/calendar/google.js -> sendGoogleError', 1],
  ['server/routes/calendar/google.js -> GET /google/auth', 1],
  ['server/routes/calendar/google.js -> PUT /google/readonly', 1],
  ['server/routes/calendar/outlook.js -> GET /outlook/auth', 1],
  ['server/routes/calendar/outlook.js -> GET /outlook/accounts', 1],
  ['server/routes/calendar/outlook.js -> PUT /outlook/accounts/:id', 1],
  ['server/routes/calendar/outlook.js -> DELETE /outlook/accounts/:id', 1],
  ['server/routes/calendar/outlook.js -> GET /outlook/accounts/:id/calendars', 1],
  ['server/routes/calendar/outlook.js -> PATCH /outlook/accounts/:id/calendars', 1],
  ['server/routes/calendar/outlook.js -> POST /outlook/sync', 1],
  ['server/routes/preferences.js -> POST /holidays/sync', 1],
  ['server/routes/subscriptions.js -> POST /logo-search', 1],
  ['server/routes/waste/sources.js -> icsTextForReimport', 1],
  // Class C: our own refusal and foreign text in the same catch.
  ['server/routes/calendar/subscriptions.js -> POST /import', 1],
  ['server/routes/document-storage-google-drive.js -> sendStorageError', 1],
  ['server/routes/documents.js -> GET /storage/config', 1],
  ['server/routes/documents.js -> PUT /storage/config', 1],
  ['server/routes/documents.js -> POST /storage/test', 1],
  ['server/routes/modules.js -> GET /assets/:id/{*assetPath}', 1],
  ['server/routes/notifications.js -> POST /channels', 1],
  ['server/routes/notifications.js -> PUT /channels/:id', 1],
  ['server/routes/shopping.js -> POST /:listId/send', 1],
  ['server/routes/split-expenses.js -> POST /groups/:id/expenses', 1],
  ['server/routes/split-expenses.js -> PUT /expenses/:id', 1],
  ['server/routes/split-expenses.js -> POST /groups/:id/settlements', 1],
  ['server/routes/split-expenses.js -> POST /groups/:id/recurring', 1],
  ['server/routes/split-expenses.js -> PUT /recurring/:id', 1],
]);

// ── Scanner ──────────────────────────────────────────────────────────────────

const ERR_NAME = String.raw`(?:[\w$]*[eE]rr(?:or)?|e|ex|exc|cause|failure)`;
const MESSAGE_READ = new RegExp(String.raw`\b${ERR_NAME}\s*(?:\?\.|\.)\s*message\b(?!\s*[!=]==)`);
const STRINGIFIED = new RegExp(String.raw`\bString\s*\(\s*${ERR_NAME}\s*\)`);
const TEMPLATE_SUBSTITUTION_ALL = new RegExp(String.raw`\$\{\s*${ERR_NAME}\s*\}`, 'g');

/** Does this piece of code hand an exception's text on? */
function leaks(code, text) {
  if (MESSAGE_READ.test(code) || STRINGIFIED.test(code)) return true;
  // `${err}` counts only as a substitution: its name survives in the code with
  // blank literals, the same text inside a plain string does not.
  for (const hit of text.matchAll(TEMPLATE_SUBSTITUTION_ALL)) {
    const name = hit.index + 2 + hit[0].slice(2).search(/[\w$]/);
    if (code[name] !== ' ') return true;
  }
  return false;
}

/** Index of the bracket that closes the one opening at `open` (literals are blank). */
function closingIndex(code, open) {
  const pairs = { '(': ')', '{': '}', '[': ']' };
  const close = pairs[code[open]];
  let depth = 0;
  for (let i = open; i < code.length; i += 1) {
    if (code[i] === code[open]) depth += 1;
    else if (code[i] === close && --depth === 0) return i;
  }
  return code.length;
}

// `res` or `res.status(...)` / `.type(...)` / `.set(...)` chains right before `.json(`.
const RES_CHAIN = /\bres(?:\s*\.\s*(?:status|type|set|setHeader|header)\s*\((?:[^()]|\([^()]*\))*\))*\s*$/;
const SEND_CALL = /\.\s*(?:json|send|end)\s*\(/g;
const HELPER_CALL = /\b([A-Za-z_$][\w$]*)\s*\(\s*res\s*[,)]/g;
const NOT_A_HELPER = new Set(['function', 'if', 'for', 'while', 'switch', 'catch', 'return']);

/** Every call that hands something to the response: [index of `(`, label]. */
function sendSites(code) {
  const sites = [];
  for (const hit of code.matchAll(SEND_CALL)) {
    const before = code.slice(Math.max(0, hit.index - 400), hit.index);
    if (RES_CHAIN.test(before)) sites.push(hit.index + hit[0].length - 1);
  }
  for (const hit of code.matchAll(HELPER_CALL)) {
    if (NOT_A_HELPER.has(hit[1])) continue;
    // A declaration `function sendX(res, err) {` is not a call.
    if (/\bfunction\s*\*?\s*$/.test(code.slice(Math.max(0, hit.index - 30), hit.index))) continue;
    sites.push(hit.index + hit[0].indexOf('('));
  }
  return sites.sort((a, b) => a - b);
}

const LABELS = new RegExp([
  String.raw`\b(?:router|app|[\w$]+Router)\s*\.\s*(get|post|put|patch|delete|all|use)\s*\(\s*(['"\x60])([^'"\x60]*)\2`,
  String.raw`\bfunction\s*\*?\s*([\w$]+)\s*\(`,
  String.raw`\b(?:const|let|var)\s+([\w$]+)\s*=\s*(?:async\s+)?(?:function\b|\([^()]*\)\s*=>|[\w$]+\s*=>)`,
  String.raw`^\s*(?:async\s+)?(?!(?:if|for|while|switch|catch|with|return)\b)([\w$]+)\s*\([^()]*\)\s*\{`,
].join('|'), 'gm');

/** End of the statement that starts at `from`: the first `;` outside brackets. */
function statementEnd(code, from) {
  let depth = 0;
  for (let i = from; i < code.length; i += 1) {
    const c = code[i];
    if (c === '(' || c === '{' || c === '[') depth += 1;
    else if (c === ')' || c === '}' || c === ']') { if (--depth < 0) return i; }
    else if (c === ';' && depth === 0) return i;
  }
  return code.length;
}

/** [start, end, label] of every route registration and named function in the file. */
function scopes(code, text) {
  const out = [];
  for (const hit of text.matchAll(LABELS)) {
    const after = hit.index + hit[0].length;
    let end;
    if (hit[1]) {
      // The registration call itself: from its `(` to the matching `)`.
      end = closingIndex(code, code.indexOf('(', hit.index));
    } else if (hit[6] || hit[4]) {
      // `function name(...) {` or `name(...) {`: the body after the parameters.
      end = closingIndex(code, code.indexOf('{', closingIndex(code, code.indexOf('(', hit.index + (hit[0].length - hit[0].trimStart().length)))));
    } else {
      // `const name = (...) => ...`: a block body or an expression up to its `;`.
      const body = code.slice(after).search(/\S/) + after;
      end = code[body] === '{' ? closingIndex(code, body) : statementEnd(code, body);
    }
    const label = hit[1] ? `${hit[1].toUpperCase()} ${hit[3]}` : (hit[4] ?? hit[5] ?? hit[6]);
    out.push([hit.index, end, label]);
  }
  return out;
}

/** The innermost route or named function around `index`. */
function labelAt(allScopes, index) {
  let best = null;
  for (const scope of allScopes) {
    if (scope[0] <= index && index <= scope[1] && (!best || scope[0] > best[0])) best = scope;
  }
  return best ? best[2] : '(module)';
}

const ALIAS = /(?:\b(?:const|let|var)\s+|(?<![.\w$]))([\w$]+)\s*=(?![=>])([^;]*)/g;

/** Names assigned an exception's text in the three lines above `index`. */
function aliasesBefore(code, text, index) {
  const lineStart = code.lastIndexOf('\n', index) + 1;
  let from = lineStart;
  for (let n = 0; n < 3 && from > 0; n += 1) from = code.lastIndexOf('\n', from - 2) + 1;
  const names = new Set();
  const window = code.slice(from, index);
  for (const hit of window.matchAll(ALIAS)) {
    const start = from + hit.index + hit[0].length - hit[2].length;
    const end = start + hit[2].length;
    if (leaks(hit[2], text.slice(start, end))) names.add(hit[1]);
  }
  return names;
}

/** Does `code` use the identifier `name` (not as a property, not inside a longer name)? */
function usesName(code, name) {
  for (let i = code.indexOf(name); i !== -1; i = code.indexOf(name, i + 1)) {
    const before = code[i - 1] ?? '';
    const after = code[i + name.length] ?? '';
    if (!/[.\w$]/.test(before) && !/[\w$]/.test(after)) return true;
  }
  return false;
}

/**
 * Every place in `src` that hands an exception's text to a response.
 * @param {string} src
 * @returns {{ line: number, label: string, snippet: string }[]}
 */
export function clientErrorTextHits(src) {
  const code = withoutCommentsKeepingLines(src, { blankLiterals: true });
  const text = withoutCommentsKeepingLines(src);
  const lines = src.split('\n');
  const allScopes = scopes(code, text);
  const hits = [];
  for (const open of sendSites(code)) {
    const close = closingIndex(code, open);
    const args = code.slice(open, close + 1);
    let leak = leaks(args, text.slice(open, close + 1));
    if (!leak) {
      for (const alias of aliasesBefore(code, text, open)) {
        if (usesName(args, alias)) leak = true;
      }
    }
    if (!leak) continue;
    const line = code.slice(0, open).split('\n').length;
    hits.push({ line, label: labelAt(allScopes, open), snippet: lines[line - 1].trim().slice(0, 140) });
  }
  return hits;
}

function serverFiles(dir = SERVER) {
  return readdirSync(dir).flatMap((name) => {
    const path = `${dir}${name}`;
    if (statSync(path).isDirectory()) return serverFiles(`${path}/`);
    return name.endsWith('.js') ? [path] : [];
  });
}

/** `file -> function` -> hits, over the whole server. */
function measure() {
  const byKey = new Map();
  for (const path of serverFiles()) {
    const file = relative(ROOT, path).split('\\').join('/');
    for (const hit of clientErrorTextHits(readFileSync(path, 'utf8'))) {
      const key = `${file} -> ${hit.label}`;
      if (!byKey.has(key)) byKey.set(key, []);
      byKey.get(key).push({ ...hit, file });
    }
  }
  return byKey;
}

// ── The scanner sees every spelling and nothing else ─────────────────────────

test('the reader sees every way to hand the text on, and nothing in comments or strings', () => {
  const seen = (src) => clientErrorTextHits(src).length;
  for (const [src, expected] of [
    ["res.status(500).json({ error: err.message, code: 500 });", 1],
    ["res.json({ error: error?.message || 'x' });", 1],
    ["return res\n  .status(400)\n  .json({\n    code: 400,\n    error: e.message,\n  });", 1],
    ["res.status(err.status || 500).json({ error: fetchErr.message });", 1],
    ["res.send(String(err));", 1],
    ["res.status(502).json({ error: `Fetch failed: ${err.message}` });", 1],
    ["res.status(502).json({ error: `Fetch failed: ${err}` });", 1],
    ["sendStorageError(res, err, err.message);", 1],
    ["const message = err.message || 'Invalid.';\nconst status = 400;\nres.status(status).json({ error: message });", 1],
    ["const body = { error: err.message, code: 400 };\nres.status(400).json(body);", 1],
    // Not a hit: logged, compared, in a comment or in a string, or no response.
    ["log.error('failed:', err.message);\nres.status(500).json({ error: 'Failed.', code: 500 });", 0],
    ["if (err.message === 'x') return res.status(403).json({ error: 'No.' });", 0],
    ["// res.json({ error: err.message })\nres.json({ data: 1 });", 0],
    ["res.json({ error: 'see err.message in the log' });", 0],
    ["res.status(400).json({ error: '${err}' });", 0],
    ["throw new Error(`wrapped: ${err.message}`);", 0],
    ["function sendX(res, err) {\n  log.error(err.message);\n}", 0],
    // An alias four lines up is out of the window (documented limit).
    ["const message = err.message;\na();\nb();\nc();\nres.json({ error: message });", 0],
  ]) {
    assert.equal(seen(src), expected, src);
  }
});

test('the label of a hit is its route or its function', () => {
  const src = [
    "router.post('/webdav/test', requireAdmin, async (req, res) => {",
    '  try { await x(); } catch (err) {',
    '    res.status(400).json({ error: err.message });',
    '  }',
    '});',
    'function sendGoogleError(res, err) {',
    '  return res.status(500).json({ error: err.message });',
    '}',
  ].join('\n');
  assert.deepEqual(clientErrorTextHits(src).map((h) => h.label), ['POST /webdav/test', 'sendGoogleError']);
});

// ── The server ───────────────────────────────────────────────────────────────

const measured = measure();

test('every place that hands exception text to a response is listed', () => {
  const problems = [];
  for (const [key, hits] of measured) {
    const allowed = (ALLOWED.get(key)?.[0] ?? 0) + (BASELINE.get(key) ?? 0);
    if (hits.length > allowed) {
      problems.push(`${key}: ${hits.length} hit(s), listed ${allowed}\n${hits
        .map((h) => `    ${h.file}:${h.line}  ${h.snippet}`).join('\n')}`);
    }
  }
  assert.equal(problems.length, 0,
    `Exception text reaches the client. Answer with a fixed English sentence plus \`reason\` and log the error `
    + `(pattern: server/routes/modules.js PATCH /:id); only our own text behind an instanceof or reason gate `
    + `belongs in ALLOWED:\n${problems.join('\n')}`);
});

test('the lists only shrink: an entry allows no more than it finds', () => {
  const stale = [];
  for (const [list, name, count] of [[ALLOWED, 'ALLOWED', (v) => v[0]], [BASELINE, 'BASELINE', (v) => v]]) {
    for (const [key, value] of list) {
      const found = measured.get(key)?.length ?? 0;
      const other = name === 'ALLOWED' ? (BASELINE.get(key) ?? 0) : (ALLOWED.get(key)?.[0] ?? 0);
      if (found - other < count(value)) stale.push(`${name} ${key}: allows ${count(value)}, finds ${Math.max(0, found - other)}`);
    }
  }
  assert.equal(stale.length, 0, `Lower or remove these entries:\n${stale.join('\n')}`);
});

test('every ALLOWED entry says why the text is our own', () => {
  for (const [key, [count, reason]] of ALLOWED) {
    assert.ok(Number.isInteger(count) && count > 0, `${key}: count`);
    assert.ok(typeof reason === 'string' && reason.length >= 20, `${key}: reason`);
  }
});

// The behaviour tests of the three blind spots carry this todo marker while
// their place is in BASELINE, and lose it with the fix (review of #2618).
const TODO_MARKER = 'fix pending, Phase 0 section H PR 3';
const BLIND_SPOTS = [
  ['server/routes/modules.js -> GET /assets/:id/{*assetPath}', 'test/test-module-install.js'],
  ['server/routes/split-expenses.js -> POST /groups/:id/expenses', 'test/test-split-expenses-routes.js'],
  ['server/routes/backup.js -> POST /webdav/test', 'test/test-backup-routes.js'],
];

test('a blind-spot test is todo exactly while its place is open', () => {
  for (const [key, file] of BLIND_SPOTS) {
    const marked = readFileSync(new URL(`../${file}`, import.meta.url), 'utf8').includes(TODO_MARKER);
    assert.equal(marked, BASELINE.has(key),
      BASELINE.has(key)
        ? `${file}: the test of ${key} must stay marked todo ('${TODO_MARKER}') while the place is in BASELINE`
        : `${file}: ${key} is fixed - remove the todo marker so the test runs for real`);
  }
});
