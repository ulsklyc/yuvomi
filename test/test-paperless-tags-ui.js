/** Exercise settings/dialog controllers through the existing browser import stubs. */
import assert from 'node:assert/strict';
import test, { afterEach } from 'node:test';
import { render } from '../public/settings/pages/documents-live-folders.js';
import { openPaperlessTags } from '../public/components/paperless-tags.js';

class Node {
  constructor(tag = 'div') {
    this.tagName = tag; this.children = []; this.controls = new Map(); this.events = new Map();
    this.isConnected = true; this.hidden = false; this.disabled = false; this.value = ''; this.markup = '';
  }
  insertAdjacentHTML(_position, markup) {
    this.markup += markup;
    if (markup.includes('data-tags-picker hidden')) this.querySelector('[data-tags-picker]').hidden = true;
  }
  querySelector(selector) {
    if (!this.controls.has(selector)) this.controls.set(selector, new Node());
    return this.controls.get(selector);
  }
  replaceChildren(...children) { this.children = [...children]; this.markup = ''; }
  append(...children) { this.children.push(...children); }
  addEventListener(type, listener) { this.events.set(type, listener); }
  async fire(type) { await this.events.get(type)?.({ target: this, currentTarget: this, preventDefault() {} }); }
}
const previous = { document: globalThis.document, window: globalThis.window };
afterEach(() => {
  globalThis.document = previous.document; globalThis.window = previous.window;
  delete globalThis.__apiStub; delete globalThis.__openModal;
});
const flush = () => new Promise((resolve) => setImmediate(resolve));

test('central tag catalogue is loaded and visible in all-tags mode; switching to selected tags enables choices', async () => {
  const forms = [], requests = [], writes = [];
  globalThis.document = {
    createElement(tag) { const node = new Node(tag); if (tag === 'form') forms.push(node); return node; },
    createTextNode(text) { return { textContent: text }; },
  };
  globalThis.window = { yuvomi: { showToast() {} } };
  globalThis.__apiStub = {
    get: async (path) => {
      requests.push(path);
      if (path.endsWith('/live-settings')) return { data: [{ id: 1, name: 'Paperless', token_mode: 'shared',
        allowed_tag_ids: null, revision: 0, has_personal_token: false }], meta: { can_manage: true } };
      return { data: [{ id: 7, name: 'House' }, { id: 150, name: 'Insurance' }], meta: { has_more: false } };
    },
    put: async (path, body) => { writes.push({ path, body }); return { data: { ...body, revision: 1 } }; },
  };
  await render(new Node()); await flush();
  const form = forms.find((entry) => entry.markup.includes('data-policy-error'));
  assert.ok(form, 'the settings form must actually be built');
  assert.equal(form.querySelector('[data-tags-picker]').hidden, false);
  assert.ok(requests.some((path) => path.endsWith('/live-settings/1/tags?page=1')));
  const list = form.querySelector('[data-tags-list]');
  assert.deepEqual(list.children.map((label) => label.children[1].textContent.trim()), ['House (#7)', 'Insurance (#150)']);
  assert.ok(list.children.every((label) => label.children[0].disabled && label.children[0].checked));
  const mode = form.querySelector('#live-tags-mode-1');
  mode.value = 'selected'; await mode.fire('change');
  assert.ok(list.children.every((label) => !label.children[0].disabled));
  const chosen = list.children[1].children[0]; chosen.checked = true; await chosen.fire('change');
  await form.fire('submit');
  assert.deepEqual(writes[0].body.allowed_tag_ids, [150]);
});

test('active-folder tag dialog shows names plus IDs and searches by ID', async () => {
  const panel = new Node();
  globalThis.__openModal = ({ onSave }) => onSave(panel);
  globalThis.__apiStub = { get: async () => ({ data: { tags: [{ id: 7, name: 'House' }, { id: 150, name: 'Insurance' }],
    tag_ids: [7, 150], can_edit: false } }) };
  openPaperlessTags({ path: '/documents/dms/paperless/folders/1/documents/99/tags', title: 'Receipt' });
  await flush();
  const list = panel.querySelector('[data-pl-tag-list]');
  assert.ok(list.markup.includes('House (#7)'));
  assert.ok(list.markup.includes('Insurance (#150)'));
  const search = panel.querySelector('#pl-tag-search'); search.value = '150'; await search.fire('input');
  assert.ok(list.markup.includes('Insurance (#150)'));
  assert.ok(!list.markup.includes('House (#7)'));
});

test('unreadable tag names keep the assigned ID and show an actionable explanation', async () => {
  const panel = new Node();
  globalThis.__openModal = ({ onSave }) => onSave(panel);
  globalThis.__apiStub = { get: async () => ({ data: { tags: [{ id: 150, name: '#150' }],
    tag_ids: [150], unresolved_tag_ids: [150], can_edit: false } }) };
  openPaperlessTags({ path: '/documents/dms/paperless/folders/1/documents/99/tags', title: 'Receipt' });
  await flush();
  assert.equal(panel.querySelector('[data-pl-tag-names-warning]').hidden, false);
  assert.ok(panel.querySelector('[data-pl-tag-list]').markup.includes('#150'));
});
