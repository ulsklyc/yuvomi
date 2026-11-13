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
// Each one is pure (no DOM, no Node) and shared because two copies would drift apart;
// the reason is noted where it was recorded. test/test-layer-boundary.js reads this
// named export, so the list exists once.
export const SERVER_PUBLIC_IMPORT_NAMES = [
  // The Savings chart bucket must identify the same stored category/subcategory in API and UI.
  'budget-chart-category',
  // One recurrence maximum for the API validation and both budget dialogs; a constant only.
  'budget-recurrence',
  // #1909: how long a phone number may be. The route checks `phone` and `phones` against it,
  // the form sets `maxlength`; two numbers had drifted apart before (100 and 50).
  'contact-limits',
  'contact-name',
  // #841: the selectable currencies. The list stood four times in the repo, held together by
  // regex guards; a currency added to one copy was settable in the household and missing in
  // two modules (KRW, IDR, IRR). A constant only.
  'currency-codes',
  // #1680: how many events the calendar tile lists (5, 8 or 12). The route clamps the
  // parameter with the same allowlist the tile cuts with and the dialog builds its radios
  // from; with two lists the server delivered the next step and the browser still showed five.
  'dashboard-event-limit',
  // #1074: digits of other scripts to ASCII. The client scales a quantity text with it, the
  // server sums the same text into the shopping list; two copies would split on every
  // household that writes its own digits. Derived from Intl.
  'digits',
  // #2436: the API and the tablet agree on the five display options; no storage.
  'display-device-settings',
  // #1705: one day for "expiring soon" on the document chip and the Key dates tile.
  'document-expiry',
  // #891: how an event gets its colour (own, else the primary assignee's, else the
  // calendar's). The browser paints the calendar with it, the server answers the countdown
  // tile with it; two copies would give one event two colours in two tiles.
  'event-color',
  // #785: what a folder tree means - what lies below a folder, where it sits, whether it may
  // move there. The sidebar counts with it, the route filters with it; the cycle and depth
  // limit must be stated once, or the second copy is a suggestion, not a limit.
  'folder-tree',
  // Cycle prediction (Health): next period, ovulation, fertile window. The cycle tab draws the
  // ring and calendar with it, services/cycle-reminders.js times the reminder; two copies
  // would name a different day than the ring. Its import of public/utils/date.js is an edge
  // inside public/, which no rule here restricts.
  'health-cycle',
  // #944: HTML escaping for user text in the HTML part of a reminder mail, the same rule as
  // in the DOM. Kept narrow on purpose: utils/html.js re-exports esc() but carries the note
  // renderer and its CSS classes, so it is frontend code, not a shared util.
  'html-escape',
  // #1314: the anchor of a confirmed ingredient match. The server writes the key and reads it
  // when merging, the UI shows the result on the same ingredient; a name one side folds
  // differently would lose the match without an error. trim, whitespace, toLowerCase.
  'ingredient-match-key',
  // #1748: the step of a series (`addInterval`, `nextRunNotBefore`). The split-expenses
  // dialog says before saving how many dates the server skips with `missed: skip` and where
  // it lands; a second calculation would miss on a 31st or 29 Feb. Date maths in UTC.
  'interval-date',
  // #1607: which form of a Korean particle follows an inserted word (`{{name}}이(가)`).
  // t() in the browser and translate() on the server read the same ko.json (push texts,
  // ICS feeds, stored calendar titles); two copies would print both forms in a notification.
  'korean-particles',
  // #704: what a checklist line is. The renderer decides which line gets a tappable box, the
  // route which line may change a tick; two copies would draw a box that answers 409, or let
  // a line without a box be rewritten through the route.
  'markdown-checklist',
  // #734: how a comment is read against the member list. The browser highlights with it, the
  // server picks the notification recipients; two copies would colour a name nobody notifies.
  'mentions',
  // #1514, #1602: who sees a note and who changes it. The card removes pin, delete and boxes,
  // the route refuses; two copies would give a box that looks tappable and bounces with 403.
  'note-access',
  // Notes category identity must match in the API and the duplicate-name picker; a pure
  // Unicode normalization.
  'note-category-name',
  'pantry-units',
  // #469: what turns an address field into an address, or a refusal. The result becomes the
  // `href` of a home tile; the route checks it because a client check is no boundary, the
  // form checks it to object at once. Two copies would split exactly on the value somebody
  // looking for the split would try.
  'quick-link-url',
  'recipe-meal-types',
  // #620: the format of the sync target id. The server validates exactly what the event modal
  // and the settings build.
  'sync-target',
  // #2375: which unit a measurement type carries and what converts. The chart calculates with
  // it, the route accepts exactly that and checks the hard limits on the converted value.
  'vital-units',
];

const SERVER_PUBLIC_IMPORTS = SERVER_PUBLIC_IMPORT_NAMES.map((name) => `^public/utils/${name}\\.[jt]s$`);

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
      name: 'authorize-not-to-db',
      comment: 'server/authorize/ never reaches server/db.js, not even transitively: db.js opens the database '
        + 'on import, and server/openapi.js reaches the permission module (through server/services/reminder-origins.js, '
        + 'phase 2, B1). The connection is a parameter.',
      severity: 'error',
      from: { path: '^server/authorize/' },
      to: { path: '^server/db\\.[jt]s$', reachable: true },
    },
    {
      name: 'rights-only-through-authorize',
      comment: 'A rights predicate has exactly one door (phase 2, F2): outside server/authorize/ a module imports '
        + 'only server/authorize/index.ts, never an inner seam (actor, catalog, modules, care, rows/). '
        + 'Tests are not walked by the lint run and are left out on purpose: a test may import an inner seam '
        + 'to check it on its own (test:authorize-modules, test:authorize-rows).',
      severity: 'error',
      from: { pathNot: ['^server/authorize/', '^test/'] },
      to: { path: '^server/authorize/', pathNot: '^server/authorize/index\\.ts$' },
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
