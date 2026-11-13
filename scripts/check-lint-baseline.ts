#!/usr/bin/env node
/**
 * Module: lint baseline - lint findings against a baseline that only sinks (phase 1b, section D)
 * Purpose: Runs the lint tools, counts findings per `file<TAB>tool/rule` and compares them with
 *          lint-baseline.json. Exit 1 when a key rises or is new, or when a hard rule fires at
 *          all; exit 2 when a tool did not run. The baseline is a debt register, not a licence.
 *          One mechanism for every tool (pattern: scripts/check-tsc-baseline.ts).
 * Tools:   oxlint (`.oxlintrc.json`, rules with `no-restricted-syntax` are keyed by the tag at the
 *          start of their message, e.g. `oxlint/no-restricted-syntax/LOG-PLUS-500`);
 *          dependency-cruiser (`.dependency-cruiser.mjs`, one key per violating module and rule,
 *          e.g. `depcruise/no-circular`, plus `depcruise/unresolved-import` for a local import
 *          it cannot resolve; a missing parser is exit 2);
 *          knip (`knip.json`, one key per file and issue type, e.g. `knip/exports`, `knip/files`;
 *          an entry that names no file is exit 2). In the repository every tool must run; under
 *          `--root` (fixture projects) a tool other than oxlint runs only when its config file is there.
 * Inline:  oxlint obeys `eslint-disable` and `oxlint-disable` comments and has no switch to
 *          ignore them, so a comment would hide a finding from this gate. Every such directive
 *          in a linted file is counted as `directive/disable` under the same ratchet; one without
 *          a rule list or one naming `no-restricted-syntax` is a hard key. knip skips an export
 *          whose JSDoc tags it public, beta or alias; each such tag is `directive/knip-tag`.
 * Reasons: a baseline key of a rule in REASONED may stand only with a reason of at least twenty
 *          characters in lint-baseline-reasons.json (same key -> why the finding is no debt to
 *          pay off, e.g. the text is our own behind an instanceof gate). A missing or short
 *          reason is exit 1, and so is a reason whose key is not in the baseline.
 *          Limits: a key is a file, not a function, so a new place in a file that has a key
 *          stays green while the count does not rise; and the reason is free text, nothing
 *          checks it against the places it names.
 * Run:     node scripts/check-lint-baseline.ts [--update | --init] [--root <dir>]
 *   --update  writes back ONLY lower or vanished counts, never higher ones; the reason of a
 *             key it removes goes with it.
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
const reasonsPath = resolve(root, 'lint-baseline-reasons.json');
const oxlintBin = resolve(repo, 'node_modules', 'oxlint', 'bin', 'oxlint');
const depcruiseBin = resolve(repo, 'node_modules', 'dependency-cruiser', 'bin', 'dependency-cruiser.mjs');
const DEPCRUISE_CONFIG = '.dependency-cruiser.mjs';
const knipBin = resolve(repo, 'node_modules', 'knip', 'bin', 'knip.js');
const KNIP_CONFIG = 'knip.json';
// What dependency-cruiser walks: the app, the build and maintenance code, no tests (a test
// imports whatever it checks, and its imports are not a layer).
const DEPCRUISE_TARGETS = ['server', 'public', 'scripts', 'tools', 'vite.config.ts', 'setup.js'];

// Rules with no debt: they stand at zero, and no baseline may ever carry them.
// The transaction rules guard a driver behaviour (better-sqlite3 throws on a returned
// promise and rolls back; code after the first await runs outside any transaction);
// the HTML rule is hard constraint 1. The sender rules keep household data from
// reaching a device or an outside service past a recipient check (#2602, #2598): who
// sends is named in .dependency-cruiser.mjs, the calls are held by CHANNEL-SEND and
// PUSH-SEND. The rights rules keep the SQL visibility rules and the module verdict in
// server/authorize/ (phase 2, B5): RIGHTS-MODULE (a module level compared with 'none'), the one door
// (rights-only-through-authorize) and a permission module that never opens the database
// (authorize-not-to-db). A blanket or no-restricted-syntax suppression would switch them
// off, so it is hard as well.
const HARD = new Set([
  'oxlint/no-restricted-syntax/HTML-STRING-WRITE',
  'oxlint/no-restricted-syntax/TX-ASYNC-FN',
  'oxlint/no-restricted-syntax/TX-AWAIT-INSIDE',
  'oxlint/no-restricted-syntax/CHANNEL-SEND',
  'oxlint/no-restricted-syntax/PUSH-SEND',
  'depcruise/push-service-importers',
  'depcruise/web-push-only-in-push-service',
  'depcruise/channel-delivery-importers',
  'depcruise/providers-only-in-channel-delivery',
  'oxlint/no-restricted-syntax/RIGHTS-MODULE',
  'depcruise/rights-only-through-authorize',
  'depcruise/authorize-not-to-db',
  'directive/blanket-disable',
  'directive/disable-no-restricted-syntax',
]);

// Rules whose baseline is not a debt list but a list of exceptions: every key says in
// lint-baseline-reasons.json why it may stand. ERROR-TEXT took over the allow-list of
// test-client-error-text-guard.js (phase 1b, section E): the text in the response is our own.
// RIGHTS-SQL (phase 2, B5): a visibility literal in SQL outside server/authorize/ stands
// only as a write, never a read.
const REASONED = new Set([
  'oxlint/no-restricted-syntax/ERROR-TEXT',
  'oxlint/no-restricted-syntax/RIGHTS-SQL',
]);
const MIN_REASON = 20;

// Line and block comments with eslint-disable, -line or -next-line (or oxlint-...); the rule list is
// what follows the directive up to `--` and the end of the comment: the end of the line for `//`,
// the closing `*/` for a block, which may span lines.
// Matched as text over the files oxlint lints: wider than the tool's own parser (a directive
// spelled inside a string counts too), which errs on the side of a red gate.
// knip leaves out an export whose JSDoc carries @public, @beta or @alias, with no switch
// against it: the same hole as a disable comment, counted as `directive/knip-tag`.
const JSDOC = /\/\*\*[\s\S]*?\*\//g;
const KNIP_TAG = /@(?:public|beta|alias)(?![\w-])/g;
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
    const source = readFileSync(resolve(root, file), 'utf8');
    for (const m of source.matchAll(DIRECTIVE)) {
      const rules = String(m[1] ?? m[2]).split('--')[0]!.trim();
      const kind = rules === '' ? 'blanket-disable'
        : /(^|[\s,/])no-restricted-syntax\b/.test(rules) ? 'disable-no-restricted-syntax' : 'disable';
      const key = `${posix(file)}\tdirective/${kind}`;
      counts[key] = (counts[key] ?? 0) + 1;
    }
    for (const doc of source.matchAll(JSDOC)) {
      const n = [...doc[0].matchAll(KNIP_TAG)].length;
      if (n === 0) continue;
      const key = `${posix(file)}\tdirective/knip-tag`;
      counts[key] = (counts[key] ?? 0) + n;
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

type DepcruiseViolation = { from?: string; rule?: { name?: string } };
type DepcruiseModule = { source?: string; dependencies?: { module?: string; couldNotResolve?: boolean }[] };
type DepcruiseReport = {
  modules?: DepcruiseModule[];
  summary?: { violations?: DepcruiseViolation[]; environment?: { issues?: { name?: string }[] } };
};

function depcruise(counts: Counts) {
  if (!existsSync(resolve(root, DEPCRUISE_CONFIG))) {
    if (root === repo) fail(`${DEPCRUISE_CONFIG} is missing.`);
    return;
  }
  if (!existsSync(depcruiseBin)) fail(`dependency-cruiser is not installed (${depcruiseBin}); run npm ci.`);
  const missing = DEPCRUISE_TARGETS.filter((t) => !existsSync(resolve(root, t)));
  // In the repository a renamed target would silently leave the graph; fixture projects
  // bring only the directories they need.
  if (root === repo && missing.length > 0) fail(`dependency-cruiser targets are missing: ${missing.join(', ')} (update DEPCRUISE_TARGETS).`);
  const targets = DEPCRUISE_TARGETS.filter((t) => !missing.includes(t));
  const run = spawnSync(process.execPath, [depcruiseBin, '--config', DEPCRUISE_CONFIG, '--output-type', 'json', ...targets], {
    cwd: root, encoding: 'utf8', maxBuffer: 1 << 29,
  });
  let report: DepcruiseReport;
  try {
    report = JSON.parse(run.stdout);
  } catch {
    fail(`dependency-cruiser did not run (exit ${run.status}):\n${`${run.stdout}${run.stderr}`.slice(0, 600)}`);
  }
  const violations = report.summary?.violations;
  const modules = report.modules;
  if (!Array.isArray(violations) || !Array.isArray(modules)) fail('dependency-cruiser gave no module list.');
  // Without its parser the tool skips or guesses at .ts files and still exits 0.
  const issues = (report.summary?.environment?.issues ?? []).filter((i) => /transpiler/.test(String(i.name)));
  if (issues.length > 0) fail(`dependency-cruiser cannot read every source: ${issues.map((i) => i.name).join(', ')}; run npm ci.`);
  if (root === repo) {
    for (const dir of ['server/', 'public/']) {
      const n = modules.filter((m) => String(m.source).startsWith(dir)).length;
      if (n < 100) fail(`dependency-cruiser read only ${n} modules under ${dir}; the graph is not the app.`);
    }
  }
  for (const v of violations) {
    const key = `${posix(String(v.from))}\tdepcruise/${String(v.rule?.name)}`;
    counts[key] = (counts[key] ?? 0) + 1;
  }
  // A local import the tool cannot resolve is an edge it does not see: every layer rule
  // and the cycle check are blind to it. Package imports (vite, dotenv/config) are not keyed.
  for (const m of modules) {
    for (const d of m.dependencies ?? []) {
      if (!d.couldNotResolve || !/^[./]/.test(String(d.module))) continue;
      const key = `${posix(String(m.source))}\tdepcruise/unresolved-import`;
      counts[key] = (counts[key] ?? 0) + 1;
    }
  }
}

type KnipIssue = { file?: string } & Record<string, unknown>;

function knip(counts: Counts) {
  const configPath = resolve(root, KNIP_CONFIG);
  if (!existsSync(configPath)) {
    if (root === repo) fail(`${KNIP_CONFIG} is missing.`);
    return;
  }
  if (!existsSync(knipBin)) fail(`knip is not installed (${knipBin}); run npm ci.`);
  // knip skips an entry that names no file without a word: after a rename the files behind a
  // CLI entry would count as dead, or a static page's exports would go unchecked.
  let entries: unknown;
  try {
    entries = JSON.parse(readFileSync(configPath, 'utf8')).entry;
  } catch {
    fail(`${KNIP_CONFIG} is not valid JSON.`);
  }
  const named = (Array.isArray(entries) ? entries : []).map(String).filter((e) => !/[*?{[!]/.test(e));
  const gone = named.filter((e) => !existsSync(resolve(root, e)));
  if (gone.length > 0) fail(`${KNIP_CONFIG} names entry files that do not exist: ${gone.join(', ')}.`);
  const run = spawnSync(process.execPath, [knipBin, '--config', KNIP_CONFIG, '--reporter', 'json', '--no-exit-code', '--no-progress'], {
    cwd: root, encoding: 'utf8', maxBuffer: 1 << 29,
  });
  // With --no-exit-code a non-zero exit is an error: a plugin that cannot load its config
  // (vite.config.ts) leaves part of the graph out.
  let report: { issues?: KnipIssue[] } = {};
  try {
    report = JSON.parse(run.stdout);
  } catch {
    fail(`knip did not run (exit ${run.status}):\n${`${run.stdout}${run.stderr}`.slice(0, 600)}`);
  }
  if (run.status !== 0 || !Array.isArray(report.issues)) {
    fail(`knip did not run cleanly (exit ${run.status}):\n${run.stderr.slice(0, 600)}`);
  }
  for (const issue of report.issues) {
    for (const [type, list] of Object.entries(issue)) {
      // `owners` (from a CODEOWNERS file) describes the row, it is not an issue type.
      if (type === 'owners' || !Array.isArray(list) || list.length === 0) continue;
      const key = `${posix(String(issue.file))}\tknip/${type}`;
      counts[key] = (counts[key] ?? 0) + list.length;
    }
  }
}

function measure(): Counts {
  if (!existsSync(oxlintBin)) fail(`oxlint is not installed (${oxlintBin}); run npm ci.`);
  const counts: Counts = {};
  oxlint(counts);
  directives(counts);
  depcruise(counts);
  knip(counts);
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

type Reasons = Record<string, unknown>;

function readReasons(): Reasons {
  if (!existsSync(reasonsPath)) return {};
  try {
    const parsed: unknown = JSON.parse(readFileSync(reasonsPath, 'utf8'));
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed as Reasons;
  } catch { /* reported below */ }
  return fail('lint-baseline-reasons.json is not a JSON object.');
}

/** Exit 1 when a key of a reasoned rule has no reason, or a reason has no key. */
function checkReasons(counts: Counts, reasons: Reasons) {
  const problems: string[] = [];
  for (const key of Object.keys(counts)) {
    if (!REASONED.has(ruleOf(key))) continue;
    const reason = reasons[key];
    if (typeof reason !== 'string' || reason.trim().length < MIN_REASON) problems.push(`${key.split('\t').join('  ')}  no reason`);
  }
  for (const key of Object.keys(reasons)) {
    if (!(key in counts)) problems.push(`${key.split('\t').join('  ')}  reason without a baseline key`);
  }
  if (problems.length === 0) return;
  console.error(`lint-baseline-reasons.json does not match the baseline (${problems.length} keys):`);
  for (const line of problems) console.error(`  ${line}`);
  console.error(`A key of ${[...REASONED].join(', ')} needs a reason of at least ${MIN_REASON} characters; a reason needs its key (CONTRIBUTING.md, "Linting").`);
  process.exit(1);
}

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
  checkReasons(current, readReasons());
  process.exit(0);
}
if (!exists) fail('lint-baseline.json is missing (one-time: --init).');
const reasons = readReasons();

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
  // The reason of a key that just sank away goes with it; any other stray reason stays red.
  const kept = Object.fromEntries(Object.entries(reasons).filter(([key]) => !(key in baseline) || key in next));
  if (Object.keys(kept).length < Object.keys(reasons).length) writeFileSync(reasonsPath, `${JSON.stringify(kept, null, 1)}\n`);
  console.log(`Baseline lowered: ${better.length} keys changed or removed.`);
  checkReasons(next, kept);
} else {
  if (better.length > 0) console.log(`Baseline can sink: ${better.length} keys (node scripts/check-lint-baseline.ts --update).`);
  checkReasons(baseline, reasons);
}
console.log(`Lint ok: ${Object.keys(current).length} keys, ${total(current)} findings (baseline ${Object.keys(baseline).length} keys, ${total(baseline)}).`);
