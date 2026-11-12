/**
 * Layer rules on the resolved module graph (phase 1b, section D2, decision E3).
 * Run through scripts/check-lint-baseline.ts, which keys every violation per file and
 * rule in lint-baseline.json; a known violation stays countable and may only sink.
 * Paths match `.js` and `.ts` alike: phase 2 renames files, and the `.ts` fixture in
 * test/fixtures/lint/layers/ proves the tool reads TypeScript: @swc/core is its parser
 * (`parser: 'swc'`), as dependency-cruiser 18.7 does not take TypeScript 7 as its
 * transpiler; without swc the .ts files would be skipped or guessed at, without an error.
 * Browser code imports from the web root (`/api.js`); public/tsconfig.json maps `/*` to
 * `public/*` for the type check, and the same mapping resolves those imports here, so a
 * cycle through them is an edge like any other (without it 1,535 imports stayed unresolved).
 */
import { existsSync } from 'node:fs';

const BROWSER_PATHS = 'public/tsconfig.json';

// Every file under public/ the server imports today (decision E16), measured with this
// tool on 12 Nov 2026: 25 modules under public/utils/, none under public/locales/ (the
// server reads the locale files through fs, which is no import). Frozen on purpose until
// the move to shared/ at the start of phase 4: a new target is a design decision, not a
// list edit. `.[jt]s` so that the rename to TypeScript in phase 2 is no new target.
const SERVER_PUBLIC_IMPORTS = [
  'budget-chart-category',
  'budget-recurrence',
  'contact-limits',
  'contact-name',
  'currency-codes',
  'dashboard-event-limit',
  'digits',
  'display-device-settings',
  'document-expiry',
  'event-color',
  'folder-tree',
  'health-cycle',
  'html-escape',
  'ingredient-match-key',
  'interval-date',
  'korean-particles',
  'markdown-checklist',
  'mentions',
  'note-access',
  'note-category-name',
  'pantry-units',
  'quick-link-url',
  'recipe-meal-types',
  'sync-target',
  'vital-units',
].map((name) => `^public/utils/${name}\\.[jt]s$`);

export default {
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
    // THE SENDERS (#2602, #2598). Every file that hands household data to a device or
    // an outside service is named below with the reason why its recipients may hear
    // what it sends; a new sender changes this file, and that is what a review sees.
    // The reasons (the permission check itself stays with each sender until phase 2
    // moves it behind authorize(); a behaviour test holds each one):
    // - server/services/notifications.js: processDueNotifications() drops every due row
    //   whose module is denied to its recipient (#1289) and gives a non-public row only
    //   to channels the recipient owns (GHSA-r3q8-gh3w-5qvw); testChannel() sends an
    //   admin-composed test message without household data.
    //   Held by test:denied-module-reminders and test:reminder-target-visibility.
    // - server/services/medication-scheduler.js: recipients with Health denied are
    //   skipped (#2602), and only channels the recipient owns get a dose - never a
    //   household channel (#2598). Held by test:medication-scheduler.
    // - server/routes/tasks.js: the @-mention push asks for each mentioned member
    //   whether they can see the task and whether Tasks is denied to them
    //   (resolvePermissions, own spelling; moves to authorize() in phase 2).
    //   Held by test:tasks-routes.
    // - server/routes/push.js: the test push goes to the requester themself, with the
    //   text they sent. Held by test:push.
    // A provider or the push service handed to another file as a parameter imports
    // nothing these rules could see; the lint selectors CHANNEL-SEND and PUSH-SEND
    // (.oxlintrc.json, server/ only) catch the call there. Neither rule sees a
    // destructured `const { send } = provider`, `send.call/apply`, an alias without a
    // `channel` key or a `provider(s)` name, or an object spread `{ ...opts }`; these
    // are left to review.
    // A new push sender goes into the pathNot of push-service-importers below, with its
    // reason above; then `node scripts/generate-oxlint-overrides.mjs` carries it into the
    // lint exceptions of .oxlintrc.json (test:lint-baseline fails until it does).
    {
      name: 'push-service-importers',
      comment: 'Web Push goes through server/services/push.js; only the senders named above may import it, '
        + 'each with its recipient check.',
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
      name: 'channel-delivery-importers',
      comment: 'Channel messages (Gotify, ntfy, webhook, e-mail) go through server/services/channel-delivery.js; '
        + 'only notifications.js and medication-scheduler.js may import it, each with its recipient check named above.',
      severity: 'error',
      from: {
        pathNot: [
          '^server/services/notifications\\.[jt]s$',
          '^server/services/medication-scheduler\\.[jt]s$',
        ],
      },
      to: { path: '^server/services/channel-delivery\\.[jt]s$' },
    },
    {
      name: 'providers-only-in-channel-delivery',
      comment: 'The four channel providers (the modules that send) are imported only by channel-delivery.js; '
        + 'their helpers (guarded-fetch, provider-error, webhook-template) are free to import.',
      severity: 'error',
      from: { pathNot: '^server/services/channel-delivery\\.[jt]s$' },
      to: { path: '^server/services/notification-providers/(gotify|ntfy|webhook|email)\\.[jt]s$' },
    },
    {
      name: 'web-push-only-in-push-service',
      comment: 'The web-push package is called in one place, which checks isActiveAccount first.',
      severity: 'error',
      from: { pathNot: '^server/services/push\\.[jt]s$' },
      // Resolved into node_modules, or left as the bare name when resolution fails.
      to: { path: '^web-push(/|$)|(^|/)node_modules/web-push/' },
    },
    {
      name: 'server-not-to-public-except-shared',
      comment: 'The server imports from public/ only the frozen list SERVER_PUBLIC_IMPORTS, until phase 4 moves them to shared/.',
      severity: 'error',
      from: { path: '^server/' },
      to: { path: '^public/', pathNot: SERVER_PUBLIC_IMPORTS },
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
    parser: 'swc',
    // Relative to the working directory: the repository, or a fixture project with its own.
    ...(existsSync(BROWSER_PATHS) ? { tsConfig: { fileName: BROWSER_PATHS } } : {}),
  },
};
