import test from 'node:test';
import assert from 'node:assert/strict';
import { capabilityDeviationHtml, capabilityRowHtml } from '../public/settings/pages/admin-permissions.js';

function selectedValue(html) {
  return html.match(/<button[^>]*aria-checked="true"[^>]*data-value="([^"]+)"/)?.[1];
}

test('sparse role capability rows render each catalog default as selected', () => {
  const view = { mode: 'role', draft: {}, inherited: {} };
  const fasting = capabilityRowHtml({
    key: 'health_use_fasting', default: 'allow', labelKey: 'settings.permCapabilityFasting',
  }, { ...view, label: 'Fasting' });
  const notes = capabilityRowHtml({
    key: 'notes_manage_household_categories', default: 'none', labelKey: 'settings.permCapabilityNotes',
  }, { ...view, label: 'Notes' });

  assert.equal(selectedValue(fasting), 'allow');
  assert.equal(selectedValue(notes), 'none');
});

test('sparse role capability defaults do not render a deviation marker', () => {
  const fasting = {
    key: 'health_use_fasting', default: 'allow', labelKey: 'settings.permCapabilityFasting',
  };
  const view = { mode: 'role', draft: {}, inherited: {}, label: 'Fasting' };

  assert.equal(capabilityDeviationHtml(fasting, view), '');
  assert.match(capabilityDeviationHtml(fasting, { ...view, draft: { health_use_fasting: 'none' } }), /Fasting/);
});

// ── Re-Critique 2026-09-27 (R8, H7): die Rechte-Matrix sagt, was gewaehlt ist ──

/**
 * Gerade genug Container fuer `render()`: jede per Id gefragte Flaeche ist ein
 * Stueck Markup, das mitschreibt. Die Umschaltung (`.perm-modeswitch`) fehlt
 * absichtlich - ihre gleitende Kapsel misst Layout, das es hier nicht gibt.
 */
function fakeSheet() {
  const parts = new Map();
  const part = (sel) => {
    if (!parts.has(sel)) {
      parts.set(sel, {
        html: '', disabled: false, hidden: false,
        replaceChildren() { this.html = ''; },
        insertAdjacentHTML(_pos, markup) { this.html += markup; },
        addEventListener() {},
        querySelector: (inner) => part(inner),
        querySelectorAll: () => [],
      });
    }
    return parts.get(sel);
  };
  return {
    parts,
    replaceChildren() {},
    insertAdjacentHTML() {},
    querySelector: (sel) => (sel.startsWith('#') ? part(sel) : null),
    querySelectorAll: () => [],
  };
}

const CATALOG = {
  roles: ['parent', 'child'],
  members: [],
  modules: [{ key: 'tasks', icon: 'check-square', labelKey: 'nav.tasks' }],
  widgets: [],
  capabilities: [],
};

test('die Rollen-Chips sagen ihren Zustand, und die erste Rolle steht gewaehlt da (H7)', async () => {
  const { render } = await import('../public/settings/pages/admin-permissions.js');
  globalThis.window ??= {};
  const asked = [];
  globalThis.__apiStub = {
    get: async (url) => {
      asked.push(url);
      return url === '/permissions/catalog'
        ? { data: CATALOG }
        : { data: { modules: {}, widgets: {}, capabilities: {} } };
    },
  };
  try {
    const sheet = fakeSheet();
    await render(sheet, { user: { role: 'admin' } });
    const chips = sheet.parts.get('#perm-subjects')?.html ?? '';
    const pressed = [...chips.matchAll(/<button\b[^>]*data-role="([^"]+)"/g)].map((m) => [m[1], m[0].match(/aria-pressed="(\w+)"/)?.[1]]);
    assert.deepEqual(pressed, [['parent', 'true'], ['child', 'false']], `Chips mit aria-pressed: ${chips}`);
    assert.ok(asked.includes('/permissions/role/parent'), 'die Rechte der vorgewaehlten Rolle werden geladen');
    const matrix = sheet.parts.get('#perm-matrix')?.html ?? '';
    assert.doesNotMatch(matrix, /settings\.permSelectRolePrompt/, 'keine leere Flaeche mit Aufforderung');
    assert.match(matrix, /class="perm-matrix__subject">settings\.familyRoleParent</, 'die Matrix der ersten Rolle steht');
    assert.match(matrix, /class="perm-legend"/, 'mit sichtbarer Legende der Icon-Segmente');
  } finally {
    delete globalThis.__apiStub;
  }
});

test('die Legende nennt jedes Segment-Icon mit seinem Wort, im Mitglieds-Modus auch „Erben" (H7)', async () => {
  const { permLegendHtml, initialSubject } = await import('../public/settings/pages/admin-permissions.js');
  const items = (html) => [...html.matchAll(/data-lucide="([^"]+)"[^>]*><\/i>([^<]+)</g)].map((m) => [m[1], m[2]]);
  assert.deepEqual(items(permLegendHtml('role')), [
    ['eye-off', 'settings.permAccessNone'],
    ['eye', 'settings.permAccessRead'],
    ['pencil', 'settings.permAccessWrite'],
  ]);
  assert.deepEqual(items(permLegendHtml('user'))[0], ['corner-down-right', 'settings.permInherit']);
  assert.equal(initialSubject('role', CATALOG), 'parent');
  assert.equal(initialSubject('user', CATALOG), null, 'Mitglieder bleiben ohne Vorwahl');
});
