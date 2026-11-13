#!/usr/bin/env node
/**
 * Module: oxlint overrides for the senders and the rights rules
 * Purpose: Writes the `overrides` of .oxlintrc.json: `server/**` gets the base
 *          no-restricted-syntax list plus the sender selectors CHANNEL-SEND and PUSH-SEND
 *          and the rights selectors RIGHTS-SQL and RIGHTS-MODULE (phase 2, B5), and a few
 *          files get the same list minus what they are allowed to do.
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
// never a read); RIGHTS-MODULE is hard. Neither sees a JS comparison of a row's
// visibility (`row.visibility === 'all'`), a computed key (`modules[name] === 'none'`), a
// level read into a variable first, or SQL assembled from pieces that split `visibility`
// from its value; these are left to review and to test:visibility-matrix.
const RIGHTS_SQL = 'RIGHTS-SQL: a visibility literal in SQL outside server/authorize/; ask visibleWhere()/filterVisible() or a named rule of server/authorize/index.ts. A write, never a read, stands in lint-baseline-reasons.json with its reason.';
const RIGHTS_MODULE = "RIGHTS-MODULE: a module level compared with 'none' outside server/authorize/; ask authorize(actor, 'read' | 'write' | 'receive', { module }).";
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
];
// Where the rule is the rule itself: the permission module, the schema and its test
// mirror (migrations and seeds write visibility values), the API documentation.
const RIGHTS_HOME = ['server/authorize/**', 'server/db.js', 'server/db-schema-test.js', 'server/openapi/**'];

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
 * @param {any} config - the parsed .oxlintrc.json
 * @param {string[]} senders - the push senders, push.js apart
 * @returns {any[]} the overrides
 */
export function buildOverrides(config, senders) {
  const [severity, ...base] = config.rules[RULE];
  const server = [...base, ...CHANNEL_SELECTORS, PUSH_SELECTOR, WEBPUSH_SELECTOR, ...RIGHTS_SELECTORS];
  /** @param {object[]} drop */
  const without = (drop) => [severity, ...server.filter((s) => !drop.includes(s))];
  const utc = base.filter((/** @type {{ message: string }} */ s) => s.message.startsWith('UTC-DAY-KEY:'));
  /** @param {unknown[]} list */
  const rule = (list) => ({ [RULE]: list });
  const exceptions = [
    { files: ['server/utils/timezone.js'], rules: rule(without(utc)) },
    { files: [CHANNEL_DELIVERY], rules: rule(without(CHANNEL_SELECTORS)) },
    { files: senders, rules: rule(without([PUSH_SELECTOR])) },
    { files: [PUSH_SERVICE], rules: rule(without([PUSH_SELECTOR, WEBPUSH_SELECTOR])) },
    { files: RIGHTS_HOME, rules: rule(without(RIGHTS_SELECTORS)) },
  ];
  // The later override wins whole: a file under two exceptions would keep only the
  // second one's list and silently regain what the first one dropped.
  /** @param {string} pattern @param {string} file */
  const covers = (pattern, file) => (pattern.endsWith('/**') ? file.startsWith(pattern.slice(0, -2)) : pattern === file);
  exceptions.forEach((a, i) => exceptions.slice(i + 1).forEach((b) => {
    for (const f of a.files) for (const g of b.files) {
      if (covers(f, g) || covers(g, f)) throw new Error(`oxlint overrides overlap: ${f} and ${g}`);
    }
  }));
  return [{ files: ['server/**'], rules: rule([severity, ...server]) }, ...exceptions];
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
