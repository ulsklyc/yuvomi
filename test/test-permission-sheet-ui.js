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
        html: '', nodes: [], disabled: false, hidden: false,
        replaceChildren(...nodes) { this.html = ''; this.nodes = nodes; },
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

// ── Codex an #1485: scheitert das Laden eines Subjekts, steht keine scheinbar bearbeitbare Matrix da ──

/** Gerade genug `document` fuer createRetryState(): Knoten, die ihre Kinder und Klicks behalten. */
function fakeDocument() {
  const node = (tag) => ({
    tagName: tag.toUpperCase(), className: '', textContent: '', type: '', disabled: false,
    children: [], attrs: {}, listeners: {},
    appendChild(child) { this.children.push(child); return child; },
    setAttribute(k, v) { this.attrs[k] = String(v); },
    addEventListener(type, fn) { this.listeners[type] = fn; },
  });
  return { createElement: node };
}

test('Codex an #1485: scheitert das Laden der Rechte, zeigt das Blatt Meldung und „Erneut versuchen" statt einer Voreinstellung', async () => {
  const { render } = await import('../public/settings/pages/admin-permissions.js');
  const had = { window: 'window' in globalThis, document: 'document' in globalThis };
  const prev = { window: globalThis.window, document: globalThis.document, confirm: globalThis.__confirmModal };
  globalThis.window = {};
  globalThis.document = fakeDocument();
  const confirms = [];
  globalThis.__confirmModal = async (...args) => { confirms.push(args); return true; };
  let fail = true;
  globalThis.__apiStub = {
    get: async (url) => {
      if (url === '/permissions/catalog') return { data: CATALOG };
      if (url === '/permissions/role/parent' && fail) throw new Error('offline');
      return { data: { modules: { tasks: 'read' }, widgets: {}, capabilities: {} } };
    },
  };
  const origErr = console.error;
  console.error = () => {};
  try {
    const ui = wiredSheet();
    await render(ui.sheet, { user: { role: 'admin' } });
    const matrix = ui.sheet.parts.get('#perm-matrix');
    assert.doesNotMatch(matrix.html, /perm-seg/, `keine Segmente, die eine Voreinstellung vortaeuschen: ${matrix.html}`);
    assert.doesNotMatch(matrix.html, /perm-reset|perm-save/, 'kein Zuruecksetzen und kein Speichern ohne geladene Rechte');
    const [retry] = matrix.nodes;
    assert.equal(retry?.className, 'settings-retry-state', 'der Fehler-Baustein der Einstellungen steht im Blatt');
    const [message, button] = retry.children;
    assert.equal(message.textContent, 'settings.permLoadError');
    assert.equal(message.attrs.role, 'alert');
    assert.equal(button.textContent, 'settings.retry');

    // Ein Tipp auf das (alte) Zuruecksetzen fragt nicht und tut nichts.
    await ui.clickReset();
    assert.deepEqual(confirms, [], 'ohne geladenen Entwurf gibt es nichts zurueckzusetzen');

    // Erneut versuchen laedt dasselbe Subjekt, danach steht die Matrix bedienbar da.
    fail = false;
    await button.listeners.click();
    assert.match(matrix.html, /class="perm-matrix__subject">settings\.familyRoleParent</);
    assert.match(matrix.html, /data-group="module:tasks" data-value="read"/);
    assert.match(matrix.html, /aria-checked="true"[^>]*data-group="module:tasks" data-value="read"/,
      'der geladene Wert, nicht die Voreinstellung');
  } finally {
    console.error = origErr;
    delete globalThis.__apiStub;
    if (prev.confirm === undefined) delete globalThis.__confirmModal; else globalThis.__confirmModal = prev.confirm;
    if (had.window) globalThis.window = prev.window; else delete globalThis.window;
    if (had.document) globalThis.document = prev.document; else delete globalThis.document;
  }
});

test('Codex an #1485: waehrend die Rechte eines Subjekts laden, sind die stehenden Segmente gesperrt', async () => {
  const { render } = await import('../public/settings/pages/admin-permissions.js');
  const hadWindow = 'window' in globalThis;
  const prevWindow = globalThis.window;
  globalThis.window = {};
  const tick = () => new Promise((r) => setTimeout(r, 0));
  let release = null;
  let slow = false;
  globalThis.__apiStub = {
    get: async (url) => {
      if (url === '/permissions/catalog') return { data: CATALOG };
      if (url === '/permissions/role/child' && slow) {
        return new Promise((resolve) => { release = () => resolve({ data: { modules: {}, widgets: {}, capabilities: {} } }); });
      }
      return { data: { modules: {}, widgets: {}, capabilities: {} } };
    },
  };
  try {
    const ui = wiredSheet();
    await render(ui.sheet, { user: { role: 'admin' } });
    const controls = [{ disabled: false }, { disabled: false }, { disabled: false }];
    const matrix = ui.sheet.parts.get('#perm-matrix');
    const asked = [];
    matrix.querySelectorAll = (sel) => { asked.push(sel); return controls; };
    slow = true;
    ui.clickRole('child');
    await tick();
    assert.ok(release, 'die Rolle wird geladen');
    assert.ok(asked.some((sel) => /\.perm-seg__opt/.test(sel)), 'gesucht werden die Segmente');
    assert.deepEqual(controls.map((c) => c.disabled), [true, true, true], 'bis die Rechte da sind, ist nichts bedienbar');
    release();
    await tick();
  } finally {
    delete globalThis.__apiStub;
    if (hadWindow) globalThis.window = prevWindow;
    else delete globalThis.window;
  }
});

// ── Codex an #1485 (P1): eine veraltete Antwort schreibt nicht in das neue Subjekt ──

/**
 * Wie `fakeSheet()`, aber die Klick-Handler werden mitgeschrieben, damit der
 * Test die echte Bedienfolge faehrt: Umschaltung, Mitglieds-Chip, Speichern.
 */
function wiredSheet() {
  const sheet = fakeSheet();
  const listeners = new Map();
  const baseQuery = sheet.querySelector;
  sheet.querySelector = (sel) => {
    const found = baseQuery(sel);
    if (found && sel.startsWith('#')) {
      found.addEventListener = (type, fn) => { if (type === 'click') listeners.set(sel, fn); };
    }
    return found;
  };
  const modeButtons = ['role', 'user'].map((mode) => ({
    dataset: { mode },
    classList: { toggle() {} },
    setAttribute() {},
    addEventListener(type, fn) { if (type === 'click') this.onclick = fn; },
  }));
  sheet.querySelectorAll = (sel) => (sel === '[data-mode]' ? modeButtons : []);
  const target = (matches) => ({ closest: (sel) => matches[sel] ?? null });
  return {
    sheet,
    clickMode: (mode) => modeButtons.find((b) => b.dataset.mode === mode).onclick(),
    clickUser: (id) => listeners.get('#perm-subjects')({ target: target({ '.perm-chip': { dataset: { user: String(id) } } }) }),
    clickSave: () => listeners.get('#perm-matrix')({ target: target({ '#perm-save': {} }) }),
    clickReset: () => listeners.get('#perm-matrix')({ target: target({ '#perm-reset': {} }) }),
    clickRole: (role) => listeners.get('#perm-subjects')({ target: target({ '.perm-chip': { dataset: { role } } }) }),
  };
}

test('eine spaet eintreffende Rollen-Antwort landet nicht in den Overrides des inzwischen gewaehlten Mitglieds', async () => {
  const { render } = await import('../public/settings/pages/admin-permissions.js');
  const hadWindow = 'window' in globalThis;
  const prevWindow = globalThis.window;
  globalThis.window = {};
  const catalog = {
    ...CATALOG,
    members: [{ id: 7, display_name: 'Lina', role: 'member', family_role: 'child', access_scope: 'full' }],
  };
  const tick = () => new Promise((r) => setTimeout(r, 0));
  let releaseRole = null;
  let slowRole = false;
  const puts = [];
  globalThis.__apiStub = {
    get: async (url) => {
      if (url === '/permissions/catalog') return { data: catalog };
      if (url === '/permissions/user/7') return { data: { modules: { tasks: 'read' }, widgets: {}, capabilities: {} } };
      if (url === '/permissions/role/parent' && slowRole) {
        return new Promise((resolve) => {
          releaseRole = () => resolve({ data: { modules: { tasks: 'none' }, widgets: { secret: 'none' }, capabilities: {} } });
        });
      }
      return { data: { modules: {}, widgets: {}, capabilities: {} } };
    },
    put: async (url, payload) => {
      puts.push({ url, payload });
      return { data: payload };
    },
  };
  try {
    const ui = wiredSheet();
    await render(ui.sheet, { user: { role: 'admin' } });
    await ui.clickMode('user');
    await tick();
    // Mitglieder -> Rollen: das Laden der ersten Rolle haengt ...
    slowRole = true;
    ui.clickMode('role');
    await tick();
    assert.ok(releaseRole, 'die Rolle wird geladen');
    // ... die alten Mitglieds-Chips stehen noch, eines wird gewaehlt und laedt schnell.
    ui.clickUser(7);
    await tick();
    await tick();
    // Die Rollen-Antwort kommt zuletzt.
    releaseRole();
    await tick();
    await tick();
    await ui.clickSave();
    await tick();
    for (const put of puts) {
      if (put.url === '/permissions/user/7') {
        assert.deepEqual(put.payload, { modules: { tasks: 'read' }, widgets: {}, capabilities: {} },
          'gespeichert werden die Overrides des Mitglieds, nicht die Rechte der Rolle');
      }
    }
    assert.deepEqual(puts.map((p) => p.url), ['/permissions/user/7'], 'es speichert das aktuelle Subjekt');
  } finally {
    delete globalThis.__apiStub;
    if (hadWindow) globalThis.window = prevWindow;
    else delete globalThis.window;
  }
});

test('solange die Rechte des Subjekts laden, speichert der Knopf nichts', async () => {
  const { render } = await import('../public/settings/pages/admin-permissions.js');
  const hadWindow = 'window' in globalThis;
  const prevWindow = globalThis.window;
  globalThis.window = {};
  const tick = () => new Promise((r) => setTimeout(r, 0));
  let releaseRole = null;
  let slowRole = false;
  const puts = [];
  globalThis.__apiStub = {
    get: async (url) => {
      if (url === '/permissions/catalog') return { data: CATALOG };
      if (url === '/permissions/role/parent' && slowRole) {
        return new Promise((resolve) => {
          releaseRole = () => resolve({ data: { modules: { tasks: 'read' }, widgets: {}, capabilities: {} } });
        });
      }
      return { data: { modules: {}, widgets: {}, capabilities: {} } };
    },
    put: async (url, payload) => {
      puts.push({ url, payload });
      return { data: payload };
    },
  };
  try {
    const ui = wiredSheet();
    await render(ui.sheet, { user: { role: 'admin' } });
    await ui.clickMode('user');
    await tick();
    slowRole = true;
    ui.clickMode('role');
    await tick();
    assert.ok(releaseRole, 'die Rolle wird geladen');
    // Der alte Speichern-Knopf ist noch da: ein Tipp darf die Rolle nicht mit
    // dem leeren Platzhalter-Entwurf ueberschreiben.
    await ui.clickSave();
    await tick();
    assert.deepEqual(puts, [], 'kein PUT mit einem Entwurf, der nicht geladen ist');
    releaseRole();
    await tick();
    await tick();
    await ui.clickSave();
    await tick();
    assert.deepEqual(puts, [{ url: '/permissions/role/parent', payload: { modules: { tasks: 'read' }, widgets: {}, capabilities: {} } }]);
  } finally {
    delete globalThis.__apiStub;
    if (hadWindow) globalThis.window = prevWindow;
    else delete globalThis.window;
  }
});
