import test from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import {
  noteMatchesCategories,
  occupiedNoteCategoryIds,
  pruneMissingNoteCategoryIds,
  removeNoteCategoryFromState,
} from '../public/utils/note-category-filter.js';
import { categoryNameKey } from '../server/services/note-categories.js';
import { schemas as openApiSchemas } from '../server/openapi/schemas.js';
import { notesPaths as buildNotePaths } from '../server/openapi/paths/notes.js';
import { visibleCategoryCount, scrollCategoryTooltip, wireNoteCategoryOverflow } from '../public/utils/note-category-overflow.js';
import { eachRule } from './css-rules.js';

test('category overflow fits the largest prefix and reserves the actual +N width', () => {
  assert.equal(visibleCategoryCount([40, 50, 60], 158, 4, () => 44), 3);
  assert.equal(visibleCategoryCount([40, 50, 60], 150, 4, () => 44), 2);
  assert.equal(visibleCategoryCount([40, 50, 60], 100, 4, () => 44), 1);
  assert.equal(visibleCategoryCount([240, 30], 100, 4, () => 44), 0);
  assert.equal(visibleCategoryCount([], 100, 4, () => 44), 0);
  assert.equal(visibleCategoryCount(Array(12).fill(20), 98, 4, (n) => n >= 10 ? 50 : 40), 2);
});

test('keyboard scrolling reaches every hidden category without moving focus', () => {
  let top = 0;
  const tooltip = {
    clientHeight: 300, scrollHeight: 900,
    get scrollTop() { return top; },
    set scrollTop(value) { top = Math.max(0, Math.min(value, 600)); },
  };
  for (const [key, expected] of [
    ['ArrowDown', 40], ['ArrowUp', 0], ['PageDown', 300],
    ['End', 600], ['PageUp', 300], ['Home', 0],
  ]) {
    assert.equal(scrollCategoryTooltip(tooltip, key), true);
    assert.equal(top, expected, key);
  }
  assert.equal(scrollCategoryTooltip(tooltip, 'Tab'), false);
  assert.equal(scrollCategoryTooltip(tooltip, 'Escape'), false);
});

function overflowFixture(badgeCount) {
  const attrs = new Map([['aria-label', 'Categories']]);
  const button = Object.assign(new EventTarget(), {
    hidden: true,
    textContent: '',
    setAttribute(name, value) { attrs.set(name, value); },
    getAttribute(name) { return attrs.get(name); },
    getBoundingClientRect() { return { width: 30, left: 0, top: 0, bottom: 20 }; },
    matches() { return false; },
    contains() { return false; },
  });
  const badges = Array.from({ length: badgeCount }, (_, index) => ({
    hidden: false,
    textContent: `Category ${index + 1}`,
    getBoundingClientRect() { return { width: 70 }; },
  }));
  const row = {
    clientWidth: 110,
    querySelectorAll(selector) { return selector === '.note-item__category' ? badges : []; },
    querySelector(selector) { return selector === '.note-item__categories-more' ? button : null; },
  };
  return { root: { querySelectorAll: () => [row] }, row, button, badges, attrs };
}

test('overflow formats visible counts separately from whole accessible action labels', () => {
  const previous = {
    document: globalThis.document,
    window: globalThis.window,
    ResizeObserver: globalThis.ResizeObserver,
    getComputedStyle: globalThis.getComputedStyle,
  };
  const appended = [];
  const makeNode = (tag) => Object.assign(new EventTarget(), {
    tag,
    className: '',
    id: '',
    textContent: '',
    style: {},
    clientHeight: 0,
    scrollHeight: 0,
    scrollTop: 0,
    children: [],
    setAttribute() {},
    append(child) { this.children.push(child); },
    replaceChildren() { this.children = []; },
    remove() {},
    showPopover() {},
    hidePopover() {},
    matches() { return false; },
    contains() { return false; },
    getBoundingClientRect() { return { width: 100, height: 30, left: 0, top: 0, bottom: 30 }; },
  });
  globalThis.document = Object.assign(new EventTarget(), {
    body: { append(node) { appended.push(node); } },
    documentElement: { clientWidth: 800 },
    activeElement: null,
    fonts: Object.assign(new EventTarget(), { ready: Promise.resolve() }),
    createElement: makeNode,
  });
  globalThis.window = { innerHeight: 600 };
  globalThis.ResizeObserver = class ResizeObserver {
    observe() {}
    disconnect() {}
  };
  globalThis.getComputedStyle = () => ({ columnGap: '4px' });

  const disposers = [];
  try {
    for (const [badgeCount, hiddenCount, accessibleLabel] of [
      [2, 1, '1 more category'],
      [3, 2, '2 more categories'],
    ]) {
      const fixture = overflowFixture(badgeCount);
      const labelCounts = [];
      disposers.push(wireNoteCategoryOverflow(
        fixture.root,
        (count) => `localized-${count}`,
        (count) => {
          labelCounts.push(count);
          return count === 1 ? '1 more category' : `${count} more categories`;
        },
      ));

      assert.equal(fixture.button.textContent, `+localized-${hiddenCount}`);
      assert.equal(fixture.attrs.get('aria-label'), accessibleLabel);
      assert.deepEqual(labelCounts, [hiddenCount]);
    }
  } finally {
    disposers.forEach((dispose) => dispose());
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete globalThis[key];
      else globalThis[key] = value;
    }
  }
});

const picker = await import('../public/utils/note-category-picker.js');

function fakePickerOption(id) {
  const attrs = new Map([['aria-selected', 'false']]);
  return {
    id,
    classList: { toggle() {} },
    setAttribute(name, value) { attrs.set(name, value); },
    getAttribute(name) { return attrs.get(name); },
    scrollIntoView() {},
  };
}

test('no selected categories keeps every note, including uncategorized notes', () => {
  assert.equal(noteMatchesCategories({ categories: [] }, []), true);
  assert.equal(noteMatchesCategories({ categories: [{ id: 1 }] }, []), true);
});

test('multiple selected categories use AND semantics', () => {
  const note = { categories: [{ id: 1 }, { id: 2 }, { id: 3 }] };
  assert.equal(noteMatchesCategories(note, [1, 2]), true);
  assert.equal(noteMatchesCategories(note, [1, 4]), false);
  assert.equal(noteMatchesCategories({ categories: [] }, [1]), false);
});

test('occupied category ids follow first assignment and last removal', () => {
  let notes = [{ id: 1, categories: [] }];
  assert.deepEqual([...occupiedNoteCategoryIds(notes)], []);

  notes = [{ id: 1, categories: [{ id: 7 }] }];
  assert.deepEqual([...occupiedNoteCategoryIds(notes)], [7]);

  notes = [];
  assert.deepEqual([...occupiedNoteCategoryIds(notes)], []);
});

test('successful category deletion clears filters, card badges and detail backing state immediately', () => {
  const state = {
    categories: [{ id: 7, name: 'Old' }, { id: 8, name: 'Keep' }],
    filterCategoryIds: [7, 8],
    notes: [
      { id: 1, categories: [{ id: 7, name: 'Old' }, { id: 8, name: 'Keep' }] },
      { id: 2, categories: [{ id: 7, name: 'Old' }] },
    ],
  };

  removeNoteCategoryFromState(state, 7);

  assert.deepEqual(state.categories.map((category) => category.id), [8]);
  assert.deepEqual(state.filterCategoryIds, [8]);
  assert.deepEqual(state.notes.map((note) => note.categories.map((category) => category.id)), [[8], []]);
});

test('a later page render prunes a selected category deleted in another session', () => {
  assert.deepEqual(
    pruneMissingNoteCategoryIds([7, 8], [{ id: 8, name: 'Keep' }]),
    [8],
  );
});

test('category suggestions ignore accents and exclude selected categories', () => {
  assert.equal(typeof picker.findCategorySuggestions, 'function');
  const categories = [
    { id: 1, name: 'Domácnost', scope: 'personal' },
    { id: 2, name: 'Dovolená', scope: 'household' },
    { id: 3, name: 'Škola', scope: 'personal' },
  ];
  assert.deepEqual(
    picker.findCategorySuggestions(categories, [2], 'doma').map((item) => item.id),
    [1],
  );
  assert.deepEqual(
    picker.findCategorySuggestions(categories, [], 'skola').map((item) => item.id),
    [3],
  );
});

test('exact category lookup prevents duplicate creation but preserves distinct accents', () => {
  assert.equal(typeof picker.findExactCategory, 'function');
  const categories = [
    { id: 1, name: 'Café', scope: 'personal' },
    { id: 2, name: 'Rodina', scope: 'household' },
  ];
  assert.equal(picker.findExactCategory(categories, '  CAFÉ  ')?.id, 1);
  assert.equal(picker.findExactCategory(categories, 'Cafe'), null);
  assert.equal(picker.findExactCategory(categories, 'rodina')?.id, 2);
});

test('picker identity follows the server Unicode case-folding contract', () => {
  const categories = [{ id: 1, name: 'Straße', scope: 'personal' }];
  assert.deepEqual(
    picker.findCategorySuggestions(categories, [], 'STRASSE').map((item) => item.id),
    [1],
  );
  assert.equal(picker.findExactCategory(categories, 'STRASSE', 'personal')?.id, 1);
  assert.equal(picker.categoryIdentityKey('ẞ'), picker.categoryIdentityKey('SS'));
  assert.equal(
    picker.categoryIdentityKey(picker.categoryIdentityKey('ẞ')),
    picker.categoryIdentityKey('ẞ'),
  );
});

test('browser and server category identity agree for every Unicode scalar value', () => {
  const mismatches = [];
  for (let codePoint = 0; codePoint <= 0x10FFFF; codePoint += 1) {
    if (codePoint >= 0xD800 && codePoint <= 0xDFFF) continue;
    const char = String.fromCodePoint(codePoint);
    if (picker.categoryIdentityKey(char) !== categoryNameKey(char)) {
      mismatches.push(`U+${codePoint.toString(16).toUpperCase()}`);
      if (mismatches.length === 10) break;
    }
  }
  assert.deepEqual(mismatches, []);
});

test('exact lookup is scoped so the same name can exist personally and at home', () => {
  const categories = [
    { id: 1, name: 'Work', scope: 'personal' },
    { id: 2, name: 'Work', scope: 'household' },
  ];
  assert.equal(picker.findExactCategory(categories, 'work', 'personal')?.id, 1);
  assert.equal(picker.findExactCategory(categories, 'work', 'household')?.id, 2);
  assert.equal(picker.findExactCategory(categories.slice(0, 1), 'work', 'household'), null);
});

test('authorized scope control stays reachable when only the current scope has an exact match', () => {
  const categories = [{ id: 1, name: 'Work', scope: 'personal' }];
  assert.deepEqual(
    picker.categoryCreationState(categories, 'Work', 'personal', true),
    { canCreate: false, showControls: true },
  );
  assert.deepEqual(
    picker.categoryCreationState(categories, 'Work', 'household', true),
    { canCreate: true, showControls: true },
  );
  assert.deepEqual(
    picker.categoryCreationState(categories, 'Work', 'personal', false),
    { canCreate: false, showControls: false },
  );
});

test('all supported locales contain every note-category translation', () => {
  const directory = new URL('../public/locales/', import.meta.url);
  const keys = [
    'categories', 'filterLabel', 'empty', 'personal', 'household', 'noResults',
    'deleteDetail', 'widgetHint', 'permissionLabel', 'searchPlaceholder',
    'searchResultsLabel', 'removeAction', 'createAction', 'scopeLabel', 'scopeHelp',
    'moreAction', 'moreAction_one', 'personalManagementHint',
  ];
  const files = readdirSync(directory).filter((file) => file.endsWith('.json'));
  assert.equal(files.length, 24);
  for (const file of files) {
    const locale = JSON.parse(readFileSync(new URL(file, directory), 'utf8'));
    for (const key of keys) {
      assert.equal(typeof locale.noteCategories?.[key], 'string', `${file}: noteCategories.${key}`);
      assert.notEqual(locale.noteCategories[key].trim(), '', `${file}: noteCategories.${key} is empty`);
    }
    for (const key of ['permCapabilitiesHeading', 'permCapabilityBlocked', 'permCapabilityAllowed']) {
      assert.equal(typeof locale.settings?.[key], 'string', `${file}: settings.${key}`);
      assert.notEqual(locale.settings[key].trim(), '', `${file}: settings.${key} is empty`);
    }
  }
});

test('permission module rerender keeps capability controls in the editor', () => {
  const source = readFileSync(new URL('../public/settings/pages/admin-permissions.js', import.meta.url), 'utf8');
  const rebuild = source.match(/function rebuildModuleWidgets\([\s\S]*?\n\}/)?.[0] || '';
  assert.match(rebuild, /capabilitiesForModule/);
  assert.match(rebuild, /capabilityRowHtml/);
  assert.match(source, /permCapabilitiesHeading/);
  assert.match(source, /capabilityOptions/);
  assert.match(source, /perm-row--capability/);
});

test('notes UI keeps the approved category filter and editor contracts', () => {
  const source = readFileSync(new URL('../public/pages/notes.js', import.meta.url), 'utf8');
  const css = readFileSync(new URL('../public/styles/notes.css', import.meta.url), 'utf8');
  const layoutCss = readFileSync(new URL('../public/styles/layout.css', import.meta.url), 'utf8');
  assert.match(source, /data-clear-categories/);
  assert.match(source, /assignedCategoryIds/);
  assert.match(source, /role="combobox"/);
  assert.match(source, /role="listbox"/);
  assert.match(source, /data-category-remove/);
  assert.match(source, /note-category-scope-help/);
  assert.match(source, /findCategorySuggestions/);
  assert.match(source, /findExactCategory/);
  assert.match(source, /function assignableCategories\(\)[\s\S]*?return state\.categories;/,
    'all visible household categories must remain usable without management permission');
  assert.match(source, /renderNoteReadHtml\(note\.content, \{ live: true, categories:/);
  assert.match(source, /sr-only[^\n]*categoryScopeLabel/);
  assert.match(source, /function renderNotesAndFilters\(\)[\s\S]*renderFilters\(\);[\s\S]*renderGrid\(\);/);
  assert.match(source, /state\.filterCategoryIds\s*=\s*pruneMissingNoteCategoryIds\(/,
    'a fresh category catalog must discard filters deleted in another session');
  assert.ok((source.match(/renderNotesAndFilters\(\);/g) || []).length >= 5,
    'initial load, save, reload, delete and undo must all refresh occupied category chips');
  assert.match(source.match(/async function reloadNotes\(\)[\s\S]*?\n\}/)?.[0] || '', /renderNotesAndFilters\(\)/);
  assert.match(css, /\.notes-filters[\s\S]*overflow-x:\s*auto/);
  const rules = [...eachRule(css)];
  const filters = rules.find((rule) => rule.selector === '.notes-filters' && !rule.at.length)?.body || '';
  const groups = rules.find((rule) => rule.selector === '.notes-filter-group' && !rule.at.length)?.body || '';
  assert.match(filters, /scrollbar-width:\s*thin/);
  assert.match(filters, /scrollbar-color:\s*var\(--module-accent\)/);
  assert.match(groups, /flex:\s*0 0 auto/);
  assert.match(source, /wireScrollFade\(container\.querySelector\('#notes-filters'\)\)/);
  assert.match(source, /filterFade\.destroy\(\)/);
  const badgeName = rules.find((rule) => rule.selector === '.note-category-badge__name')?.body || '';
  assert.match(badgeName, /min-width:\s*0/);
  assert.match(badgeName, /overflow-wrap:\s*anywhere/);
  assert.ok(!rules.some((rule) => rule.selector === '.notes-filter-group--categories' && /(?:overflow-x:\s*auto|flex:\s*1)/.test(rule.body)),
    'one outer scroller keeps categories reachable even when creator chips exceed the viewport');
  assert.match(layoutCss, /html\[data-module-readonly\][^\{]*\.notes-manage-categories[^{]*\{\s*display:\s*none\s*!important/,
    'read-only Notes must not offer a category manager whose mutations will be rejected');
});

test('combobox keyboard handling stays inside the picker and keeps virtual focus', () => {
  const source = readFileSync(new URL('../public/pages/notes.js', import.meta.url), 'utf8');
  const handler = source.match(/categorySearch\.addEventListener\('keydown',[\s\S]*?\n\s{6}\}\);/)?.[0] || '';
  assert.match(handler, /event\.stopPropagation\(\)/,
    'handled combobox keys must not trigger modal save or close handlers');
  assert.match(source, /data-category-option="\$\{category\.id\}"[^>]*tabindex="-1"/,
    'aria-activedescendant options must stay out of the tab order');
  assert.match(source, /renderCategorySuggestions\(\{ open: false \}\);\s*closeCategorySuggestions\(\);/,
    'selection must clear virtual focus after rendering the remaining closed options');
});

test('arrow navigation reopens a picker closed by Escape', () => {
  assert.equal(typeof picker.moveCategoryPickerOption, 'function');
  const options = [fakePickerOption('note-category-option-7')];
  const inputAttrs = new Map([['aria-expanded', 'false']]);
  const categorySearch = {
    setAttribute(name, value) { inputAttrs.set(name, value); },
    removeAttribute(name) { inputAttrs.delete(name); },
    getAttribute(name) { return inputAttrs.get(name); },
  };
  const categoryList = {
    hidden: true,
    querySelectorAll: () => options,
  };
  let renderCount = 0;

  const movement = picker.moveCategoryPickerOption({
    categoryList,
    categorySearch,
    renderSuggestions() {
      renderCount += 1;
      categoryList.hidden = false;
      categorySearch.setAttribute('aria-expanded', 'true');
    },
    activeIndex: -1,
    direction: 1,
  });

  assert.equal(renderCount, 1);
  assert.equal(categoryList.hidden, false);
  assert.equal(categorySearch.getAttribute('aria-expanded'), 'true');
  assert.equal(movement.activeIndex, 0);
  assert.equal(categorySearch.getAttribute('aria-activedescendant'), options[0].id);
  assert.equal(options[0].getAttribute('aria-selected'), 'true');
});

test('selection clears hidden virtual focus before the next ArrowDown', () => {
  assert.equal(typeof picker.closeCategoryPicker, 'function');
  const options = [
    fakePickerOption('note-category-option-8'),
    fakePickerOption('note-category-option-9'),
  ];
  const inputAttrs = new Map([
    ['aria-expanded', 'true'],
    ['aria-activedescendant', options[0].id],
  ]);
  const categorySearch = {
    setAttribute(name, value) { inputAttrs.set(name, value); },
    removeAttribute(name) { inputAttrs.delete(name); },
    getAttribute(name) { return inputAttrs.get(name); },
  };
  const categoryList = {
    hidden: false,
    querySelectorAll: () => options,
  };

  const closedIndex = picker.closeCategoryPicker({ categoryList, categorySearch });
  const movement = picker.moveCategoryPickerOption({
    categoryList,
    categorySearch,
    renderSuggestions() {
      categoryList.hidden = false;
      categorySearch.setAttribute('aria-expanded', 'true');
    },
    activeIndex: closedIndex,
    direction: 1,
  });

  assert.equal(closedIndex, -1);
  assert.equal(movement.activeIndex, 0);
  assert.equal(categorySearch.getAttribute('aria-activedescendant'), options[0].id);
});

test('pointer selection keeps combobox focus until the delegated click selects the option', () => {
  const source = readFileSync(new URL('../public/pages/notes.js', import.meta.url), 'utf8');
  const handler = source.match(/categoryList\.addEventListener\('pointerdown',[\s\S]*?\n\s{6}\}\);/)?.[0] || '';
  assert.match(handler, /closest\('\[data-category-option\]'\)/,
    'pointer guard must apply only to a category option');
  assert.match(handler, /event\.preventDefault\(\)/,
    'pointerdown must retain input focus so focusout cannot close the list before click');
});

test('category scope select fills the available creation row space', () => {
  const css = readFileSync(new URL('../public/styles/notes.css', import.meta.url), 'utf8');
  const scopeRule = css.match(/\.note-category-editor__scope\s*\{([^}]*)\}/)?.[1] || '';
  const selectRule = css.match(/\.note-category-editor__scope \.form-input\s*\{([^}]*)\}/)?.[1] || '';
  assert.match(scopeRule, /flex:\s*1 1 0/);
  assert.match(scopeRule, /min-width:\s*0/);
  assert.match(selectRule, /flex:\s*1/);
  assert.match(selectRule, /min-width:\s*0/);
  assert.match(selectRule, /width:\s*100%/);
});

test('compact dashboard note widgets hide category badges', () => {
  const source = readFileSync(new URL('../public/pages/dashboard.js', import.meta.url), 'utf8');
  const css = readFileSync(new URL('../public/styles/dashboard.css', import.meta.url), 'utf8');
  assert.match(source, /noteCategoryScope/);
  assert.match(source, /sr-only[^\n]*noteCategoryScope/);
  assert.match(css, /widget-size--1x1[^\{]*note-item__categories[\s\S]*display:\s*none/);
});

test('OpenAPI documents note category payloads and permission capabilities', () => {
  const schemas = readFileSync(new URL('../server/openapi/schemas.js', import.meta.url), 'utf8');
  const notesPaths = readFileSync(new URL('../server/openapi/paths/notes.js', import.meta.url), 'utf8');
  const permissionPaths = readFileSync(new URL('../server/openapi/paths/permissions.js', import.meta.url), 'utf8');
  for (const name of ['NoteCategoryInput', 'NoteCategoryRenameInput', 'NoteCreateInput', 'NoteUpdateInput', 'NoteCategoryListResponse']) {
    assert.match(schemas, new RegExp(`\\b${name}:`));
    assert.match(notesPaths, new RegExp(`\\b${name}\\b`));
  }
  assert.match(permissionPaths, /capabilities/);
  assert.match(permissionPaths, /notes_manage_household_categories/);

  assert.deepEqual(openApiSchemas.NoteCreateInput.required, ['content']);
  assert.equal(openApiSchemas.NoteCategoryRenameInput.properties.scope, undefined);
  const paths = buildNotePaths();
  assert.equal(paths['/api/v1/notes'].post.requestBody.content['application/json'].schema.$ref, '#/components/schemas/NoteCreateInput');
  assert.equal(paths['/api/v1/notes/{id}'].put.requestBody.content['application/json'].schema.$ref, '#/components/schemas/NoteUpdateInput');
  assert.ok(paths['/api/v1/notes'].post.responses[409]);
  assert.ok(paths['/api/v1/notes/{id}'].put.responses[404]);
  assert.ok(paths['/api/v1/notes/categories'].post.responses[409]);
  assert.ok(paths['/api/v1/notes/categories/{id}'].put.responses[404]);
  assert.ok(paths['/api/v1/notes/categories/{id}'].put.responses[409]);
  assert.ok(paths['/api/v1/notes/categories/{id}'].delete.responses[204]);
});
