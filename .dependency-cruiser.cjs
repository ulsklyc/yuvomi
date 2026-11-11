/**
 * Layer rules on the resolved module graph (phase 1b, section D2, decision E3).
 * Run through scripts/check-lint-baseline.ts, which keys every violation per file and
 * rule in lint-baseline.json; a known violation stays countable and may only sink.
 * Paths match `.js` and `.ts` alike: phase 2 renames files, and the `.ts` fixture in
 * test/fixtures/lint/layers/ proves the tool reads TypeScript (through @swc/core, as
 * dependency-cruiser 18.7 does not take TypeScript 7 as its transpiler).
 * Browser code imports from the web root (`/api.js`); public/tsconfig.json maps `/*` to
 * `public/*` for the type check, and the same mapping resolves those imports here, so a
 * cycle through them is an edge like any other (without it 1,535 imports stayed unresolved).
 */
const { existsSync } = require('node:fs');

const BROWSER_PATHS = 'public/tsconfig.json';

module.exports = {
  forbidden: [
    {
      name: 'no-circular',
      comment: 'A cycle makes load order matter and blocks every later cut of a module.',
      severity: 'error',
      from: {},
      to: { circular: true },
    },
    {
      name: 'lower-layers-not-to-routes',
      comment: 'Services, utils, middleware and the MCP adapter never import a route module.',
      severity: 'error',
      from: { path: '^server/(services|utils|middleware|mcp)/' },
      to: { path: '^server/routes/' },
    },
    {
      name: 'push-service-importers',
      comment: 'Web Push goes through server/services/push.js; these four files may import it, '
        + 'each with its recipient check (test/test-background-sender-guard.js names the checks).',
      severity: 'error',
      from: {
        pathNot: [
          '^server/routes/tasks\\.[jt]s$',
          '^server/routes/push\\.[jt]s$',
          '^server/services/medication-scheduler\\.[jt]s$',
          '^server/services/notifications\\.[jt]s$',
          '^server/services/push\\.[jt]s$',
        ],
      },
      to: { path: '^server/services/push\\.[jt]s$' },
    },
    {
      name: 'web-push-only-in-push-service',
      comment: 'The web-push package is called in one place, which checks isActiveAccount first.',
      severity: 'error',
      from: { pathNot: '^server/services/push\\.[jt]s$' },
      to: { path: '(^|/)node_modules/web-push/' },
    },
    {
      name: 'server-not-to-public-except-shared',
      comment: 'The server reads only utils/ and locales/ from public/, until phase 2 moves them to shared/.',
      severity: 'error',
      from: { path: '^server/' },
      to: { path: '^public/', pathNot: ['^public/utils/', '^public/locales/'] },
    },
    {
      name: 'public-not-to-server',
      comment: 'Browser code never imports server code.',
      severity: 'error',
      from: { path: '^public/' },
      to: { path: '^server/' },
    },
  ],
  options: {
    doNotFollow: { path: 'node_modules' },
    exclude: { path: ['^public/vendor/', '^public/lucide\\.min\\.js$'] },
    moduleSystems: ['es6'],
    tsPreCompilationDeps: true,
    // Relative to the working directory: the repository, or a fixture project with its own.
    ...(existsSync(BROWSER_PATHS) ? { tsConfig: { fileName: BROWSER_PATHS } } : {}),
  },
};
