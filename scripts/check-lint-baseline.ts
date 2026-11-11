#!/usr/bin/env node
/**
 * Module: lint baseline - lint findings against a baseline that only sinks (phase 1b, section D)
 * Purpose: Runs the lint tools, counts findings per `file<TAB>tool/rule` and compares them with
 *          lint-baseline.json. Exit 1 when a key rises or is new, or when a hard rule fires at
 *          all; exit 2 when a tool did not run. The baseline is a debt register, not a licence.
 *          One mechanism for every tool (pattern: scripts/check-tsc-baseline.ts).
 * Tools:   oxlint (`.oxlintrc.json`, rules with `no-restricted-syntax` are keyed by the tag at the
 *          start of their message, e.g. `oxlint/no-restricted-syntax/LOG-PLUS-500`).
 * Inline:  oxlint obeys `eslint-disable` and `oxlint-disable` comments and has no switch to
 *          ignore them, so a comment would hide a finding from this gate. Every such directive
 *          in a linted file is counted as `directive/disable` under the same ratchet; one without
 *          a rule list or one naming `no-restricted-syntax` is a hard key.
 * Run:     node scripts/check-lint-baseline.ts [--update | --init] [--root <dir>]
 *   --update  writes back ONLY lower or vanished counts, never higher ones.
 *   --init    fills a missing or empty baseline completely (one-time start).
 * Erasable TS syntax only (runs through type stripping on Node 24.12+ and 26, no build).
 */

import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

type Counts = Record<string, number>;
type OxlintDiagnostic = { filename?: string; code?: string; message?: string };

const repo = fileURLToPath(new URL('..', import.meta.url));
const args = process.argv.slice(2);
const rootIdx = args.indexOf('--root');
const root = rootIdx >= 0 ? resolve(String(args[rootIdx + 1])) : repo;
const baselinePath = resolve(root, 'lint-baseline.json');
const oxlintBin = resolve(repo, 'node_modules', 'oxlint', 'bin', 'oxlint');

// Rules with no debt: they stand at zero, and no baseline may ever carry them.
// The transaction rules guard a driver behaviour (better-sqlite3 throws on a returned
// promise and rolls back; code after the first await runs outside any transaction);
// the HTML rule is hard constraint 1. A blanket or no-restricted-syntax suppression
// would switch them off, so it is hard as well.
const HARD = new Set([
  'oxlint/no-restricted-syntax/HTML-STRING-WRITE',
  'oxlint/no-restricted-syntax/TX-ASYNC-FN',
  'oxlint/no-restricted-syntax/TX-AWAIT-INSIDE',
  'directive/blanket-disable',
  'directive/disable-no-restricted-syntax',
]);

// Line and block comments with eslint-disable, -line or -next-line (or oxlint-...); the rule list is
// what follows the directive up to `--` and the end of the comment: the end of the line for `//`,
// the closing `*/` for a block, which may span lines.
// Matched as text over the files oxlint lints: wider than the tool's own parser (a directive
// spelled inside a string counts too), which errs on the side of a red gate.
const DIRECTIVE = /\/\/\s*(?:eslint|oxlint)-disable(?:-next-line|-line)?(?![\w-])([^\n]*)|\/\*\s*(?:eslint|oxlint)-disable(?:-next-line|-line)?(?![\w-])([\s\S]*?)(?:\*\/|$(?![\s\S]))/g;

function fail(message: string): never {
  console.error(message);
  process.exit(2);
}

/** `eslint(max-lines)` -> `max-lines`, `import(namespace)` -> `import/namespace`. */
function oxlintRule(code: string, message: string): string {
  const m = /^([\w-]+)\(([\w/-]+)\)$/.exec(code);
  if (!m) return code;
  const [, plugin, rule] = m as unknown as [string, string, string];
  const name = plugin === 'eslint' || plugin === 'eslint-js' ? rule : `${plugin}/${rule}`;
  if (rule !== 'no-restricted-syntax') return name;
  const tag = /^([A-Z0-9][A-Z0-9-]*):/.exec(message);
  return tag ? `${name}/${tag[1]}` : name;
}

const posix = (file: string) => relative(root, resolve(root, file)).split(sep).join('/');

function directives(counts: Counts) {
  const run = spawnSync(process.execPath, [oxlintBin, '--debug=files', '.'], {
    cwd: root, encoding: 'utf8', maxBuffer: 1 << 29,
  });
  const files = `${run.stdout}`.split('\n').map((l) => l.trim()).filter(Boolean);
  if (run.status !== 0 || files.length === 0) fail(`oxlint listed no files (exit ${run.status}): ${`${run.stderr}`.slice(0, 400)}`);
  for (const file of files) {
    for (const m of readFileSync(resolve(root, file), 'utf8').matchAll(DIRECTIVE)) {
      const rules = String(m[1] ?? m[2]).split('--')[0]!.trim();
      const kind = rules === '' ? 'blanket-disable'
        : /(^|[\s,/])no-restricted-syntax\b/.test(rules) ? 'disable-no-restricted-syntax' : 'disable';
      const key = `${posix(file)}\tdirective/${kind}`;
      counts[key] = (counts[key] ?? 0) + 1;
    }
  }
}

function oxlint(counts: Counts) {
  const run = spawnSync(process.execPath, [oxlintBin, '--format', 'json', '.'], {
    cwd: root, encoding: 'utf8', maxBuffer: 1 << 29,
  });
  let report: { diagnostics?: OxlintDiagnostic[]; number_of_files?: number };
  try {
    report = JSON.parse(run.stdout);
  } catch {
    fail(`oxlint did not run (exit ${run.status}):\n${`${run.stdout}${run.stderr}`.slice(0, 600)}`);
  }
  if (!Array.isArray(report.diagnostics)) fail('oxlint gave no diagnostics list.');
  for (const d of report.diagnostics) {
    // A parse error or a crashed JS plugin comes without a rule code.
    const rule = d.code ? oxlintRule(String(d.code), String(d.message ?? '')) : 'parse-error';
    const key = `${posix(String(d.filename))}\toxlint/${rule}`;
    counts[key] = (counts[key] ?? 0) + 1;
  }
}

function measure(): Counts {
  if (!existsSync(oxlintBin)) fail(`oxlint is not installed (${oxlintBin}); run npm ci.`);
  const counts: Counts = {};
  oxlint(counts);
  directives(counts);
  return counts;
}

function sorted(counts: Counts): Counts {
  return Object.fromEntries(Object.entries(counts).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));
}

function write(counts: Counts) {
  writeFileSync(baselinePath, `${JSON.stringify(sorted(counts), null, 1)}\n`);
}

const ruleOf = (key: string) => key.slice(key.indexOf('\t') + 1);
const total = (counts: Counts) => Object.values(counts).reduce((a, b) => a + b, 0);

const current = measure();
const exists = existsSync(baselinePath);
const baseline: Counts = exists ? JSON.parse(readFileSync(baselinePath, 'utf8')) : {};

const hard = Object.entries(current).filter(([key]) => HARD.has(ruleOf(key)));
if (hard.length > 0) {
  console.error(`Hard rules have no baseline; fix these (${hard.length} keys):`);
  for (const [key, n] of hard) {
    const [file, rule] = key.split('\t');
    console.error(`  ${file}  ${rule}  ${n}`);
  }
  process.exit(1);
}

if (args.includes('--init')) {
  if (Object.keys(baseline).length > 0) fail('--init only fills a missing or empty baseline; --update lowers an existing one.');
  write(current);
  console.log(`Baseline created: ${Object.keys(current).length} keys, ${total(current)} findings.`);
  process.exit(0);
}
if (!exists) fail('lint-baseline.json is missing (one-time: --init).');

const worse = Object.entries(current).filter(([key, n]) => n > (baseline[key] ?? 0));
const better = Object.entries(baseline).filter(([key, n]) => (current[key] ?? 0) < n);

if (worse.length > 0) {
  console.error(`New or more lint findings than the baseline (${worse.length} keys):`);
  for (const [key, n] of worse.slice(0, 40)) {
    const [file, rule] = key.split('\t');
    console.error(`  ${file}  ${rule}  ${baseline[key] ?? 0} -> ${n}`);
  }
  if (worse.length > 40) console.error(`  ... and ${worse.length - 40} more`);
  console.error('Fix the new findings; the baseline only sinks (CONTRIBUTING.md, "Linting").');
  process.exit(1);
}

if (args.includes('--update')) {
  const next: Counts = {};
  for (const key of Object.keys(baseline)) if ((current[key] ?? 0) > 0) next[key] = current[key] as number;
  write(next);
  console.log(`Baseline lowered: ${better.length} keys changed or removed.`);
} else if (better.length > 0) {
  console.log(`Baseline can sink: ${better.length} keys (node scripts/check-lint-baseline.ts --update).`);
}
console.log(`Lint ok: ${Object.keys(current).length} keys, ${total(current)} findings (baseline ${Object.keys(baseline).length} keys, ${total(baseline)}).`);
