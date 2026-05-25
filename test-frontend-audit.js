/**
 * Frontend audit regression tests.
 * Guards the accessibility and hard-constraint fixes from the UX audit.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

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

test('bottom navigation labels are constrained against localized overflow', () => {
  const layout = read('./public/styles/layout.css');
  const labelRule = cssRuleBody(layout, '.nav-item__label');

  assert.match(labelRule, /max-width:\s*100%/);
  assert.match(labelRule, /overflow:\s*hidden/);
  assert.match(labelRule, /text-overflow:\s*ellipsis/);
  assert.match(labelRule, /white-space:\s*nowrap/);
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
