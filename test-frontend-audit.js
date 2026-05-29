/**
 * Frontend audit regression tests.
 * Guards the accessibility and hard-constraint fixes from the UX audit.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';

const read = (path) => readFileSync(new URL(path, import.meta.url), 'utf8');

function cssRuleBody(css, selector) {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = css.match(new RegExp(`${escaped}\\s*\\{([^}]*)\\}`, 'm'));
  return match?.[1] ?? '';
}

function assertRuleUsesToken(css, selector, property, token, file) {
  const body = cssRuleBody(css, selector);
  assert.match(body, new RegExp(`${property}:\\s*var\\(${token}\\)`), `${file} ${selector} ${property} should use ${token}`);
}

test('audited frontend files do not assign innerHTML', () => {
  const files = [
    './public/components/oikos-install-prompt.js',
    './public/pages/notes.js',
    './public/pages/meals.js',
    './public/pages/contacts.js',
    './public/pages/documents.js',
    './public/pages/housekeeping.js',
  ];

  for (const file of files) {
    assert.doesNotMatch(read(file), /\.innerHTML\s*=/, `${file} must not assign innerHTML`);
  }
});

test('date helpers produce local YYYY-MM-DD keys without toISOString slicing', async () => {
  const { toLocalDateKey } = await import('./public/utils/date.js');
  const date = new Date(2026, 4, 24, 2, 30, 0);
  assert.equal(toLocalDateKey(date), '2026-05-24');
});

test('meals and budget pages do not slice toISOString for date keys', () => {
  for (const file of ['./public/pages/meals.js', './public/pages/budget.js']) {
    assert.doesNotMatch(read(file), /toISOString\(\)\.slice\(0,\s*10\)/, `${file} must use local date keys`);
  }
});

test('shared sub-tabs wire tabs to panels with aria-controls and aria-labelledby support', () => {
  const source = read('./public/utils/sub-tabs.js');
  assert.match(source, /btn\.id\s*=/);
  assert.match(source, /aria-controls/);
  assert.match(source, /aria-labelledby/);
});

test('settings theme toggle exposes pressed state', () => {
  const source = read('./public/pages/settings.js');
  assert.match(source, /aria-pressed/);
  assert.match(source, /setAttribute\('aria-pressed'/);
});

test('router hides inactive overlays from keyboard focus', () => {
  const source = read('./public/router.js');
  assert.match(source, /\.inert\s*=/);
  assert.match(source, /returnFocus/);
});

test('mobile More sheet trigger controls its dialog and traps keyboard focus', () => {
  const source = read('./public/router.js');

  assert.match(source, /moreBtn\.setAttribute\('aria-controls',\s*'more-sheet'\)/);
  assert.match(source, /function\s+createFocusTrap/);
  assert.match(source, /moreSheetTrap/);
  assert.match(source, /addEventListener\('keydown',\s*moreSheetTrap/);
  assert.match(source, /removeEventListener\('keydown',\s*moreSheetTrap/);
});

test('More button active state keeps visible and accessible labels in sync', () => {
  const source = read('./public/router.js');

  assert.match(source, /function\s+setMoreButtonState/);
  assert.match(source, /moreBtn\.setAttribute\('aria-current',\s*'page'\)/);
  assert.match(source, /moreBtn\.setAttribute\('aria-label',\s*moreLabel\)/);
  assert.match(source, /moreBtn\.setAttribute\('title',\s*moreLabel\)/);
  assert.doesNotMatch(source, /moreBtn\.toggleAttribute\('aria-current',\s*inMoreSheet\)/);
});

test('mobile Kitchen and More nav buttons keep colored icon wells while inactive', () => {
  const source = read('./public/router.js');

  assert.match(source, /kitchenBtn\.style\.setProperty\('--item-module-accent',\s*'var\(--module-meals\)'\)/);
  assert.match(source, /moreBtn\.style\.setProperty\('--item-module-accent',\s*'var\(--color-accent\)'\)/);
  assert.doesNotMatch(source, /kitchenNavBtn\.style\.removeProperty\('--item-module-accent'\)/);
  assert.doesNotMatch(source, /moreBtn\.style\.removeProperty\('--item-module-accent'\)/);
});

test('More sheet closes route clicks through delegated handler after rebuilds', () => {
  const source = read('./public/router.js');

  assert.match(source, /sheet\.addEventListener\('click',\s*\(e\) =>/);
  assert.match(source, /e\.target\.closest\('\[data-route\]'\)/);
  assert.doesNotMatch(source, /sheet\.querySelectorAll\('\[data-route\]'\)\.forEach/);
});

test('More sheet search trigger is a native button with visible focus styling', () => {
  const router = read('./public/router.js');
  const layout = read('./public/styles/layout.css');
  const focusRule = cssRuleBody(layout, '.more-sheet__search:focus-visible');

  assert.match(router, /const moreSearchBar = document\.createElement\('button'\)/);
  assert.match(router, /moreSearchBar\.type = 'button'/);
  assert.doesNotMatch(router, /moreSearchBar\.setAttribute\('role',\s*'button'\)/);
  assert.match(focusRule, /outline:/);
  assert.match(focusRule, /box-shadow:/);
});

test('SPA navigation can move focus to main content after route changes', () => {
  const source = read('./public/router.js');

  assert.match(source, /main\.tabIndex\s*=\s*-1/);
  assert.match(source, /function\s+focusMainContentAfterNavigation/);
  assert.match(source, /focusMainContentAfterNavigation\(basePath/);
});

test('bottom navigation labels are constrained against localized overflow', () => {
  const layout = read('./public/styles/layout.css');
  const labelRule = cssRuleBody(layout, '.nav-item__label');

  assert.match(labelRule, /max-width:\s*100%/);
  assert.match(labelRule, /overflow:\s*hidden/);
  assert.match(labelRule, /text-overflow:\s*ellipsis/);
  assert.match(labelRule, /white-space:\s*nowrap/);
});

test('mobile bottom navigation avoids clipped Android labels and sparse icon spacing', () => {
  const layout = read('./public/styles/layout.css');
  const navItemRule = cssRuleBody(layout, '.nav-bottom .nav-item');
  const iconWellRule = cssRuleBody(layout, '.nav-bottom .nav-item__icon-well');
  const labelRule = cssRuleBody(layout, '.nav-bottom .nav-item__label');

  assert.match(navItemRule, /padding-block:\s*var\(--space-0h\)/);
  assert.match(iconWellRule, /width:\s*var\(--target-base\)/);
  assert.match(iconWellRule, /height:\s*var\(--target-sm\)/);
  assert.match(iconWellRule, /border-radius:\s*var\(--radius-full\)/);
  assert.match(labelRule, /line-height:\s*1\.2/);
});

test('phase 3 high-frequency controls use tokenized touch targets', () => {
  const tasks = read('./public/styles/tasks.css');
  const shopping = read('./public/styles/shopping.css');
  const notes = read('./public/styles/notes.css');

  assert.match(tasks, /\.task-status-btn::before[\s\S]*var\(--target-base\)/);
  assert.match(shopping, /\.item-check[\s\S]*(?:min-width|width):\s*var\(--target-base\)/);
  assert.match(shopping, /\.shopping-item[\s\S]*min-height:\s*var\(--target-base\)/);
  assert.match(notes, /\.note-card__pin[\s\S]*width:\s*var\(--target-base\)/);
  assert.match(notes, /\.note-card__delete[\s\S]*width:\s*var\(--target-base\)/);
});

test('phase 6 touched UI files continue using design tokens for target sizes', () => {
  const tasks = read('./public/styles/tasks.css');
  const shopping = read('./public/styles/shopping.css');
  const notes = read('./public/styles/notes.css');
  const contacts = read('./public/styles/contacts.css');
  const targetRules = [
    ['./public/styles/tasks.css', tasks, '.task-status-btn'],
    ['./public/styles/shopping.css', shopping, '.quick-add__btn'],
    ['./public/styles/shopping.css', shopping, '.item-check'],
    ['./public/styles/notes.css', notes, '.note-card__pin'],
    ['./public/styles/notes.css', notes, '.note-card__delete'],
    ['./public/styles/contacts.css', contacts, '.contact-action-btn'],
  ];

  for (const [file, source, selector] of targetRules) {
    const body = cssRuleBody(source, selector);
    assert.doesNotMatch(
      body,
      /\b(?:min-)?(?:height|width):\s*(?:[1-9]|[1-3]\d|4[0-3])px\b/,
      `${file} ${selector} should not use sub-44px hardcoded target sizes`
    );
  }

  for (const property of ['width', 'height']) {
    assertRuleUsesToken(tasks, '.task-status-btn', property, '--target-base', './public/styles/tasks.css');
    assertRuleUsesToken(shopping, '.quick-add__btn', property, '--target-base', './public/styles/shopping.css');
    assertRuleUsesToken(shopping, '.item-check', property, '--target-base', './public/styles/shopping.css');
    assertRuleUsesToken(notes, '.note-card__pin', property, '--target-base', './public/styles/notes.css');
    assertRuleUsesToken(notes, '.note-card__delete', property, '--target-base', './public/styles/notes.css');
    assertRuleUsesToken(contacts, '.contact-action-btn', property, '--target-lg', './public/styles/contacts.css');
  }

  assertRuleUsesToken(contacts, '.contact-action-btn', 'min-height', '--target-lg', './public/styles/contacts.css');
  assertRuleUsesToken(contacts, '.contact-action-btn', 'min-width', '--target-lg', './public/styles/contacts.css');
});

test('phase 4 keeps Kitchen navigation identity stable', () => {
  const routerSource = read('./public/router.js');

  assert.match(routerSource, /t\('nav\.kitchen'\)/);
  assert.match(routerSource, /t\('nav\.kitchenActiveLabel',\s*\{\s*section/);
  assert.doesNotMatch(routerSource, /kitchenBtnLabel\.textContent\s*=\s*kitchenTarget\.label/);
  assert.doesNotMatch(routerSource, /kitchenBtnIcon\)\s*kitchenBtnIcon\.dataset\.lucide\s*=\s*kitchenTarget\.icon/);
  assert.doesNotMatch(routerSource, /sidebarLabel\)\s*sidebarLabel\.textContent\s*=\s*kitchenTarget\.label/);
  assert.doesNotMatch(routerSource, /sidebarIcon\)\s*sidebarIcon\.dataset\.lucide\s*=\s*kitchenTarget\.icon/);
});

test('phase 4 opens search from More sheet in a single handoff', () => {
  const routerSource = read('./public/router.js');

  assert.match(routerSource, /closeSheet\(\{\s*restoreFocus:\s*false\s*\}\)/);
  assert.match(routerSource, /requestAnimationFrame\(\(\) => \{\s*openSearch\(\);/);
});

// --------------------------------------------------------
// Liquid-Glass-Migration: Regressions-Guards (UX-Audit)
// --------------------------------------------------------

test('calendar week-view time labels use a readable text token, not the disabled token', () => {
  const calendar = read('./public/styles/calendar.css');
  const body = cssRuleBody(calendar, '.week-view__time-label');

  assert.match(body, /color:\s*var\(--color-text-tertiary\)/, 'time labels must use --color-text-tertiary for WCAG AA contrast');
  assert.doesNotMatch(body, /color:\s*var\(--color-text-disabled\)/, 'time labels must not reuse the disabled token (insufficient contrast)');
});

test('sticky section headers stack above glass cards via --z-sticky', () => {
  const stickyHeaders = [
    ['./public/styles/meals.css', '.day-header'],
    ['./public/styles/calendar.css', '.agenda-day__header'],
    ['./public/styles/contacts.css', '.contact-group__header'],
  ];

  for (const [file, selector] of stickyHeaders) {
    const body = cssRuleBody(read(file), selector);
    assert.match(body, /position:\s*sticky/, `${file} ${selector} should be sticky`);
    assert.match(body, /z-index:\s*var\(--z-sticky\)/, `${file} ${selector} must use --z-sticky so glass cards do not scroll over it`);
    assert.doesNotMatch(body, /z-index:\s*var\(--z-base\)/, `${file} ${selector} must not sit on the base layer`);
  }
});

test('every locale resolves nav.section.household as a nested key', () => {
  const localesDir = new URL('./public/locales/', import.meta.url);
  const files = readdirSync(localesDir).filter((f) => f.endsWith('.json'));

  assert.ok(files.length >= 16, 'expected at least 16 locale files');
  for (const file of files) {
    const data = JSON.parse(readFileSync(new URL(file, localesDir), 'utf8'));
    assert.equal(typeof data.nav?.section?.household, 'string', `${file}: nav.section.household must be a nested string`);
    assert.ok(data.nav.section.household.length > 0, `${file}: nav.section.household must not be empty`);
    assert.ok(!('section.household' in data.nav), `${file}: nav must not keep the flat "section.household" key (t() cannot resolve it)`);
  }
});

test('dark-mode token blocks stay in sync between @media and [data-theme="dark"]', () => {
  const tokens = read('./public/styles/tokens.css');

  const mediaBlock = tokens.match(/@media \(prefers-color-scheme: dark\)\s*\{\s*:root:not\(\[data-theme="light"\]\)\s*\{([\s\S]*?)\n {2}\}\n\}/);
  const attrBlock = tokens.match(/\n\[data-theme="dark"\]\s*\{([\s\S]*?)\n\}/);

  assert.ok(mediaBlock, 'expected a prefers-color-scheme dark block');
  assert.ok(attrBlock, 'expected a [data-theme="dark"] block');

  const parseVars = (block) => {
    const map = new Map();
    for (const [, name, value] of block.matchAll(/(--[\w-]+)\s*:\s*([^;]+);/g)) {
      map.set(name, value.trim());
    }
    return map;
  };

  const media = parseVars(mediaBlock[1]);
  const attr = parseVars(attrBlock[1]);

  assert.ok(media.size > 0 && attr.size > 0, 'both dark blocks must declare variables');
  const allKeys = new Set([...media.keys(), ...attr.keys()]);
  const divergent = [...allKeys].filter((k) => media.get(k) !== attr.get(k));
  assert.deepEqual(divergent, [], `dark token blocks diverge for: ${divergent.join(', ')}`);
});

// ============================================================
// UX-Audit Mai 2026 — P2/P3 (docs/UI-UX-AUDIT-2026-05.md)
// ============================================================

const LOCALE_DIR = new URL('./public/locales/', import.meta.url);
const LOCALES = readdirSync(LOCALE_DIR).filter((f) => f.endsWith('.json'));

// --- Kontrast-Helfer (WCAG 2.x relative luminance) ---
function parseTokenMap(block) {
  const map = new Map();
  for (const [, name, value] of block.matchAll(/(--[\w-]+)\s*:\s*([^;]+);/g)) {
    map.set(name, value.trim());
  }
  return map;
}

function resolveColor(name, map) {
  let value = map.get(name);
  let guard = 0;
  while (value && /^var\(/.test(value) && guard++ < 12) {
    const ref = value.match(/^var\(\s*(--[\w-]+)\s*\)$/);
    if (!ref) break;
    value = map.get(ref[1]);
  }
  return value;
}

function hexToRgb(hex) {
  const m = String(hex).trim().match(/^#([0-9a-f]{6})$/i);
  assert.ok(m, `expected a 6-digit hex color, got: ${hex}`);
  return [0, 2, 4].map((i) => parseInt(m[1].slice(i, i + 2), 16));
}

function relLum([r, g, b]) {
  const f = (c) => { c /= 255; return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4); };
  return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
}

function contrastRatio(a, b) {
  const l1 = relLum(hexToRgb(a));
  const l2 = relLum(hexToRgb(b));
  const [hi, lo] = l1 > l2 ? [l1, l2] : [l2, l1];
  return (hi + 0.05) / (lo + 0.05);
}

test('text/surface token pairs meet WCAG AA 4.5:1 in both themes', () => {
  const tokens = read('./public/styles/tokens.css');
  const rootBlock = tokens.match(/:root\s*\{([\s\S]*?)\n\}/);
  const darkBlock = tokens.match(/\n\[data-theme="dark"\]\s*\{([\s\S]*?)\n\}/);
  assert.ok(rootBlock, 'expected a :root token block');
  assert.ok(darkBlock, 'expected a [data-theme="dark"] block');

  const light = parseTokenMap(rootBlock[1]);
  const dark = new Map(light);
  for (const [k, v] of parseTokenMap(darkBlock[1])) dark.set(k, v);

  // Normaltext-Paare, die laut Design AA erfüllen müssen.
  const pairs = [
    ['--color-text-primary', '--color-surface'],
    ['--color-text-primary', '--color-bg'],
    ['--color-text-secondary', '--color-surface'],
    ['--color-text-secondary', '--color-bg'],
    ['--color-text-tertiary', '--color-bg'],
    ['--color-accent', '--color-surface'],
  ];

  for (const [theme, map] of [['light', light], ['dark', dark]]) {
    for (const [fg, bg] of pairs) {
      const fgHex = resolveColor(fg, map);
      const bgHex = resolveColor(bg, map);
      const ratio = contrastRatio(fgHex, bgHex);
      assert.ok(
        ratio >= 4.5,
        `${theme}: ${fg} (${fgHex}) on ${bg} (${bgHex}) is ${ratio.toFixed(2)}:1, below WCAG AA 4.5:1`,
      );
    }
  }
});

test('modal Enter submits the form instead of advancing to the next field (audit 1.4)', () => {
  const src = read('./public/components/modal.js');
  const enterBlock = src.match(/if \(e\.key === 'Enter'\) \{[\s\S]*?\n {4}\}/);
  assert.ok(enterBlock, 'expected an Enter keydown handler');
  assert.match(enterBlock[0], /submitBtn\.click\(\)/, 'Enter must trigger the submit button');
  assert.doesNotMatch(enterBlock[0], /next\.focus\(\)/, 'Enter must not advance focus to the next field');
});

test('shared modal centrally escapes title and select labels (audit 1.8)', () => {
  const src = read('./public/components/modal.js');
  assert.match(src, /id="shared-modal-title">\$\{esc\(title\)\}/, 'modal title must be escaped');
  assert.match(src, /<option value="\$\{esc\(o\.value\)\}">\$\{esc\(o\.label\)\}/, 'select options must be escaped');
  assert.match(src, /import \{ esc \} from '\/utils\/html\.js'/, 'modal must import esc');
});

test('modal lifecycle uses an explicit state machine, not the old _isClosing flag (audit 1.5)', () => {
  const src = read('./public/components/modal.js');
  assert.match(src, /let modalState = 'idle';/, 'expected an explicit modalState variable');
  assert.match(src, /modalState === 'closing'/, 'close guard must key off modalState');
  assert.doesNotMatch(src, /_isClosing/, 'legacy _isClosing flag must be removed');
});

test('budget chart exposes a screen-reader summary (audit 1.7)', () => {
  const src = read('./public/pages/budget.js');
  assert.match(src, /<p class="sr-only">\$\{esc\(chartSummary\(/, 'chart must render an .sr-only summary');
  assert.match(src, /function chartSummary\(byCategory\)/, 'expected a chartSummary helper');

  for (const file of LOCALES) {
    const json = JSON.parse(read(`./public/locales/${file}`));
    assert.ok(json.budget?.chartSummary, `${file} must define budget.chartSummary`);
    assert.match(json.budget.chartSummary, /\{\{count\}\}/, `${file} chartSummary must interpolate count`);
    assert.match(json.budget.chartSummary, /\{\{top\}\}/, `${file} chartSummary must interpolate top`);
    assert.match(json.budget.chartSummary, /\{\{pct\}\}/, `${file} chartSummary must interpolate pct`);
  }
});

test('toolbar "new" buttons are hidden via a shared class, not an ID list (audit 1.9)', () => {
  const layout = read('./public/styles/layout.css');
  assert.match(layout, /\.toolbar-new-btn\s*\{\s*display:\s*none\s*!important;/, 'expected .toolbar-new-btn rule');
  assert.doesNotMatch(layout, /#btn-new-task,\s*\n\s*#notes-add-btn/, 'legacy ID-list selector must be gone');

  const pages = {
    './public/pages/tasks.js': 'btn-new-task',
    './public/pages/notes.js': 'notes-add-btn',
    './public/pages/contacts.js': 'contacts-add-btn',
    './public/pages/budget.js': 'budget-add',
    './public/pages/calendar.js': 'cal-add',
  };
  for (const [file, id] of Object.entries(pages)) {
    const src = read(file);
    const btn = src.match(new RegExp(`<button[^>]*id="${id}"[^>]*>`));
    assert.ok(btn, `${file} must keep #${id}`);
    assert.match(btn[0], /toolbar-new-btn/, `${file} #${id} must carry the .toolbar-new-btn class`);
  }
});

test('login keeps username-style input hints, not email (audit 1.6 — login is by username)', () => {
  const src = read('./public/pages/login.js');
  const input = src.match(/<input[\s\S]*?id="username"[\s\S]*?\/>/);
  assert.ok(input, 'expected a username input');
  assert.match(input[0], /type="text"/, 'username field stays type=text (login is by username, not email)');
  assert.match(input[0], /autocomplete="username"/);
  assert.match(input[0], /autocapitalize="none"/);
  assert.match(input[0], /autocorrect="off"/);
  assert.doesNotMatch(input[0], /type="email"|inputmode="email"/, 'must not use email keyboard for username login');
});
