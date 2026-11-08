/**
 * Module: guard - every sender of push or channel messages is named, with its
 *         permission check
 * Purpose: Every file under `server/` that calls `sendPushToUser(` or a
 *          channel provider's `send(` hands household data to a device or an
 *          outside service. Each of them stands in SENDERS below, with the
 *          reason why its recipients may hear what it sends and the code that
 *          enforces that reason. A new sender that is not listed is red; a
 *          listed file that no longer sends is red too (the list may only
 *          shrink); a listed file whose check is gone is red.
 *
 * WHY: the medication scheduler (#2602) sent on its own, outside the
 * filtered delivery path in notifications.js, and never asked whether the
 * recipient still had Health - nor whether the channel was the household's
 * (#2598). The regular path had both filters for months. A comment listing the
 * senders would not have stopped the next one; this guard does.
 *
 * A TEXT READER WITH AN EXPIRY DATE: phase 1b of the architecture roadmap
 * replaces it with a dependency-cruiser rule ("only these files import
 * server/services/push.js"), which sees imports instead of call spellings.
 * Until then it reads the source with comments cut out
 * (`withoutCommentsKeepingLines()`), so a comment that names a call neither
 * counts as a sender nor satisfies a check.
 *
 * Counterproof: a copy of a file that calls `sendPushToUser(` dropped into
 * `server/` turns the first case red with its path; against `main` before
 * #2602 the scheduler's missing `recipientDeniedModules(` turns the third case
 * red.
 * Run: node --test test/test-background-sender-guard.js
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { withoutCommentsKeepingLines } from './source-text.js';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SERVER = join(ROOT, 'server');

// The one bottleneck for Web Push itself: it calls web-push and checks
// `isActiveAccount` before any send (#1381). Not a sender in the sense above.
const PUSH_SERVICE = 'server/services/push.js';

// What counts as sending. `sendNotification(` is web-push's own call and may
// only live in push.js; `provider(s)[...].send(` is the channel providers'.
const SEND_CALLS = [
  /\bsendPushToUser\s*\(/,
  /\bproviders?(?:\[[^\]\n]*\])?\.send\s*\(/,
  /\bsendNotification\s*\(/,
];

const SENDERS = {
  'server/services/notifications.js': {
    why: 'processDueNotifications() drops every due row whose module is denied to its recipient '
      + '(#1289) and gives a non-public row only to channels the recipient owns (GHSA-r3q8-gh3w-5qvw); '
      + 'testChannel() sends an admin-composed test message without household data.',
    checks: ['withoutModulesDeniedToRecipient(', "channel.scope === 'user'"],
  },
  'server/services/medication-scheduler.js': {
    why: 'recipients with Health denied are skipped (#2602), and only channels the recipient owns '
      + 'get a dose - never a household channel (#2598).',
    checks: ['recipientDeniedModules(', "channel.scope === 'user'"],
  },
  'server/routes/tasks.js': {
    why: 'the @-mention push asks for each mentioned member whether they can see the task and '
      + 'whether Tasks is denied to them (resolvePermissions, own spelling; moves to authorize() in phase 2).',
    checks: ['findVisibleTask(', "modules?.tasks === 'none'"],
  },
  'server/routes/push.js': {
    why: 'the test push goes to the requester themself, with the text they sent.',
    checks: ['req.authUserId || req.session.userId'],
  },
};

function listSourceFiles(dir) {
  const out = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules') continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...listSourceFiles(full));
    else if (/\.(?:m|c)?js$/.test(entry.name)) out.push(full);
  }
  return out;
}

const toRepoPath = (full) => relative(ROOT, full).split(sep).join('/');
const code = (repoPath) => withoutCommentsKeepingLines(readFileSync(join(ROOT, repoPath), 'utf8'));

/** The `path:line` of every send call in the file's code (comments cut out). */
function sendCallSites(repoPath) {
  return code(repoPath).split('\n').flatMap((line, i) => (
    SEND_CALLS.some((re) => re.test(line)) ? [`${repoPath}:${i + 1}`] : []
  ));
}

const callers = new Map(
  listSourceFiles(SERVER)
    .map(toRepoPath)
    .filter((repoPath) => repoPath !== PUSH_SERVICE)
    .map((repoPath) => [repoPath, sendCallSites(repoPath)])
    .filter(([, sites]) => sites.length),
);

test('every file under server/ that sends push or channel messages is named in SENDERS', () => {
  const unlisted = [...callers].filter(([repoPath]) => !SENDERS[repoPath]).flatMap(([, sites]) => sites);
  assert.deepEqual(unlisted, [],
    'a new sender without a named permission check - filter its recipients like '
    + 'withoutModulesDeniedToRecipient()/recipientDeniedModules() do, then add it to SENDERS with the reason');
});

test('every entry in SENDERS still sends (the list may only shrink)', () => {
  const stale = Object.keys(SENDERS).filter((repoPath) => !callers.has(repoPath));
  assert.deepEqual(stale, [], 'listed but no longer sending - remove the entry');
});

test('every entry in SENDERS still contains the check its reason names', () => {
  const missing = Object.entries(SENDERS).flatMap(([repoPath, { checks }]) => {
    const text = code(repoPath);
    return checks.filter((check) => !text.includes(check)).map((check) => `${repoPath}: ${check}`);
  });
  assert.deepEqual(missing, [], 'a sender lost the permission check its entry relies on');
});

test('the scan sees the senders it is meant to see (no blind guard)', () => {
  // If the patterns or the walk broke, every case above would be green on an
  // empty map. The four known senders must be found by the scan itself.
  assert.deepEqual([...callers.keys()].sort(), Object.keys(SENDERS).sort());
  for (const repoPath of Object.keys(SENDERS)) assert.ok(callers.get(repoPath)?.length, repoPath);
});
