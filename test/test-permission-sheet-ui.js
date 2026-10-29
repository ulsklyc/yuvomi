import test from 'node:test';
import assert from 'node:assert/strict';
import { capabilityDeviationHtml, capabilityRowHtml } from '../public/settings/pages/admin-permissions.js';

// R24 (E11): die Stufe ist eine Auswahl je Zeile - gewaehlt ist die <option selected>.
function selectedValue(html) {
  return html.match(/<option value="([^"]+)" selected>/)?.[1];
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
    // Unter dem h1 des Blatts (`.settings-leaf-header__title`) ist das die
    // erste Ueberschrift: h2, nicht h3. Die h2 der Settings-Navigation standen
    // bis R10 sichtbar davor und verdeckten den Sprung; seit dem Blatt je
    // Modul sind sie dort nicht mehr im Bild (Sonde 10 der Dokument-Guards).
    assert.match(matrix, /<h2 class="perm-matrix__subject">/, 'die Matrix-Ueberschrift folgt dem h1 ohne Sprung');
    assert.doesNotMatch(matrix, /class="perm-legend"/, 'die Stufen tragen ihr Wort selbst - keine Legende (R21)');
  } finally {
    delete globalThis.__apiStub;
  }
});

// Die beiden Legenden-Tests (H7, Codex an #1485) entfallen mit der Legende
// (R21): jedes Segment nennt sein Wort aus den Optionen SEINES Abschnitts
// (moduleOptions/widgetOptions/capabilityOptions) - am Modul "Lesen", am
// Widget "Verfuegbar", an einer Faehigkeit "Erlaubt".
test('jede Stufe nennt das Wort ihres Abschnitts (H7, Codex an #1485)', async () => {
  const { initialSubject } = await import('../public/settings/pages/admin-permissions.js');
  const page = (await import('node:fs')).readFileSync(new URL('../public/settings/pages/admin-permissions.js', import.meta.url), 'utf8');
  // R24 (E11): das Wort ist die Option der Auswahl - am Modul "Nur lesen", am
  // Widget "Verfuegbar", an einer Faehigkeit "Erlaubt".
  assert.match(page, /<option value="\$\{esc\(o\.value\)\}"\$\{o\.value === current \? ' selected' : ''\}>\$\{esc\(o\.label\)\}<\/option>/, 'das Wort steht in der Auswahl');
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
    assert.doesNotMatch(matrix.html, /perm-select/, `keine Auswahl, die eine Voreinstellung vortaeuscht: ${matrix.html}`);
    assert.doesNotMatch(matrix.html, /perm-reset/, 'kein Zuruecksetzen ohne geladene Rechte');
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
    assert.match(matrix.html, /data-group="module:tasks"/);
    assert.match(matrix.html, /data-group="module:tasks"[\s\S]*?<option value="read" selected>/,
      'der geladene Wert, nicht die Voreinstellung');
  } finally {
    console.error = origErr;
    delete globalThis.__apiStub;
    if (prev.confirm === undefined) delete globalThis.__confirmModal; else globalThis.__confirmModal = prev.confirm;
    if (had.window) globalThis.window = prev.window; else delete globalThis.window;
    if (had.document) globalThis.document = prev.document; else delete globalThis.document;
  }
});

test('Codex an #1485: waehrend die Rechte eines Subjekts laden, sind die stehenden Auswahlen gesperrt', async () => {
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
    assert.ok(asked.some((sel) => /\.perm-select/.test(sel)), 'gesucht werden die Auswahlen der Zeilen');
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
      found.addEventListener = (type, fn) => {
        if (type === 'click') listeners.set(sel, fn);
        if (type === 'change') listeners.set(`${sel}:change`, fn);
      };
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
    // R24 (E11): kein Speichern-Knopf mehr - eine Wahl in einer Zeile speichert sofort.
    change: (group, value) => {
      const select = { dataset: { group }, value, disabled: false };
      select.closest = (sel) => (sel === '.perm-select' ? select : null);
      return listeners.get('#perm-matrix:change')({ target: select });
    },
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
    await ui.change('module:tasks', 'read');
    await tick();
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

test('solange die Rechte des Subjekts laden, speichert eine Wahl nichts', async () => {
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
    // Die alten Zeilen stehen noch: eine Wahl darf die Rolle nicht mit dem
    // leeren Platzhalter-Entwurf ueberschreiben.
    await ui.change('module:tasks', 'none');
    await tick();
    assert.deepEqual(puts, [], 'kein PUT mit einem Entwurf, der nicht geladen ist');
    releaseRole();
    await tick();
    await tick();
    await ui.change('module:tasks', 'write');
    await tick();
    await tick();
    assert.deepEqual(puts, [{ url: '/permissions/role/parent', payload: { modules: { tasks: 'write' }, widgets: {}, capabilities: {} } }],
      'erst der geladene Entwurf, mit der neuen Wahl');
  } finally {
    delete globalThis.__apiStub;
    if (hadWindow) globalThis.window = prevWindow;
    else delete globalThis.window;
  }
});

// ── R24 (E11; Critique G6-Familie-P2-2): Modulzeile mit EINEM Wert, sofort gespeichert ──
//
// Vorher: je Modul ein Dreier-Segment (A7: aktive Pille getoent, Kante 3:1),
// je Widget ein Zweier, je Zusatzrecht ein dritter, „Speichern" klebte am
// Telefon, sobald etwas ungespeichert war (A7 P2-5). Gemessen 1440: 4166px,
// 390: 4989px. Nachher: 2186 / 2535px mit einer aufgeklappten Zeile; die
// Segment-Tests dieser Datei (getoente Pille, klebender Fuss, Wort am Zeiger)
// sind mit den Segmenten gegenstandslos.
test('R24 E11: je Modul eine Optionszeile, Widgets und Zusatzrechte aufgeklappt, sofort gespeichert mit Rueckgaengig', async () => {
  const { readFileSync } = await import('node:fs');
  const { eachRule } = await import('./css-rules.js');
  const page = readFileSync(new URL('../public/settings/pages/admin-permissions.js', import.meta.url), 'utf8');
  const css = readFileSync(new URL('../public/styles/settings.css', import.meta.url), 'utf8');
  assert.doesNotMatch(page, /perm-seg|perm-save|state\.dirty|confirmDiscardIfDirty/, 'keine Segmente, kein Speichern, kein Entwurf');
  const group = page.slice(page.indexOf('function moduleGroupHtml('), page.indexOf('// ── Abweichungs'));
  assert.match(group, /data-perm-expand="\$\{esc\(mod\.key\)\}"\s*aria-expanded=/, 'die Zeile klappt auf');
  assert.match(group, /<div class="perm-modgroup__more" id="\$\{esc\(moreId\)\}"\$\{open \? '' : ' hidden'\}>\$\{moduleMoreHtml\(mod\.key\)\}<\/div>/, 'eingeklappt nur die Zeile');
  const apply = page.slice(page.indexOf('async function applyChange('), page.indexOf('// ── Interaktion'));
  assert.match(apply, /persist\(\(\) => \{\s*if \(ownsRow\(bucket, key, seq\)\) set\(savedOf\.get\(draft\)/, 'ein Fehler legt zurueck, solange die Wahl die Zeile besitzt');
  assert.match(apply, /label: t\('common\.undo'\)/, 'Rueckgaengig im Toast');
  const rules = [...eachRule(css)];
  assert.ok(!rules.some((r) => /\.perm-actions/.test(r.selector) && /position:\s*sticky/.test(r.body)), 'kein klebender Fuss mehr');

  // Gefahren: aendern -> PUT, Rueckgaengig -> PUT mit dem alten Stand.
  const { render } = await import('../public/settings/pages/admin-permissions.js');
  const hadWindow = 'window' in globalThis;
  const prevWindow = globalThis.window;
  const toasts = [];
  globalThis.window = { yuvomi: { showToast: (...args) => toasts.push(args) } };
  const puts = [];
  const tick = () => new Promise((r) => setTimeout(r, 0));
  globalThis.__apiStub = {
    get: async (url) => (url === '/permissions/catalog'
      ? { data: CATALOG }
      : { data: { modules: {}, widgets: {}, capabilities: {} } }),
    put: async (url, payload) => { puts.push({ url, payload: JSON.parse(JSON.stringify(payload)) }); return { data: payload }; },
  };
  try {
    const ui = wiredSheet();
    await render(ui.sheet, { user: { role: 'admin' } });
    await ui.change('module:tasks', 'read');
    await tick(); await tick();
    assert.deepEqual(puts, [{ url: '/permissions/role/parent', payload: { modules: { tasks: 'read' }, widgets: {}, capabilities: {} } }], 'die Wahl wirkt sofort');
    const [, kind, , action] = toasts.at(-1);
    assert.equal(kind, 'success');
    assert.equal(action.label, 'common.undo');
    await action.onClick();
    await tick();
    assert.deepEqual(puts.at(-1), { url: '/permissions/role/parent', payload: { modules: {}, widgets: {}, capabilities: {} } }, 'Rueckgaengig schreibt den alten Stand');
  } finally {
    delete globalThis.__apiStub;
    if (hadWindow) globalThis.window = prevWindow; else delete globalThis.window;
  }
});

/* R24 S13 (Critique G6-Einst-P2-3): die Rollen-Chips brachen am Telefon in
 * drei Zeilen (390px: y254/310/366), das erste Recht stand 170px tiefer. Sie
 * sind jetzt EINE waagerecht scrollende Zeile wie jede Chipreihe
 * (`.page-chip-row`), mit Fade-Kanten aus wireScrollFade. */
test('R24 S13: Rollen- und Mitglieder-Chips stehen in EINER scrollenden Zeile', async () => {
  const { readFileSync } = await import('node:fs');
  const { eachRule } = await import('./css-rules.js');
  const css = [...eachRule(readFileSync(new URL('../public/styles/settings.css', import.meta.url), 'utf8'))];
  const row = css.find((r) => !r.at.length && r.selector.trim() === '.perm-subjects');
  assert.ok(row, 'Regel fehlt');
  assert.doesNotMatch(row.body, /flex-wrap:\s*wrap/, 'die Chips duerfen nicht umbrechen - mobil drei Zeilen');
  assert.match(row.body, /overflow-x:\s*auto/, 'die Zeile scrollt waagerecht');
  assert.ok(css.some((r) => !r.at.length && r.selector.trim() === '.perm-subjects > *' && /flex-shrink:\s*0/.test(r.body)),
    'kein Chip wird gestaucht');
  assert.ok(!css.some((r) => r.at.length && r.selector.trim() === '.perm-subjects' && /flex-wrap:\s*wrap/.test(r.body)),
    'auch keine Breite bricht wieder um');
  const js = readFileSync(new URL('../public/settings/pages/admin-permissions.js', import.meta.url), 'utf8');
  assert.match(js, /wireScrollFade\(container\.querySelector\('#perm-subjects'\)\)/, 'die Kanten sagen, dass es weitergeht');
});

// ── Codex an #2364 (P1): ein spaet fertiges Zuruecksetzen schreibt nicht ins neue Subjekt ──
//
// `persist()` meldet false, sobald inzwischen ein anderes Subjekt gewaehlt ist -
// auch wenn der PUT gelang. Das Zuruecksetzen stellte dann `before` wieder her,
// sobald nur IRGENDEIN Entwurf geladen war: die Rechte der alten Rolle standen
// unter der neuen, und die naechste Wahl speicherte sie dort.
test('ein Zuruecksetzen, das erst nach dem Subjektwechsel fertig wird, laesst den Entwurf des neuen Subjekts stehen', async () => {
  const { render } = await import('../public/settings/pages/admin-permissions.js');
  const had = { window: 'window' in globalThis, document: 'document' in globalThis };
  const prev = { window: globalThis.window, document: globalThis.document, confirm: globalThis.__confirmModal };
  globalThis.window = {};
  globalThis.document = fakeDocument();
  globalThis.__confirmModal = async () => true;
  const tick = () => new Promise((r) => setTimeout(r, 0));
  let releasePut = null;
  const puts = [];
  globalThis.__apiStub = {
    get: async (url) => {
      if (url === '/permissions/catalog') return { data: CATALOG };
      if (url === '/permissions/role/parent') return { data: { modules: { tasks: 'read', notes: 'none' }, widgets: {}, capabilities: {} } };
      return { data: { modules: {}, widgets: {}, capabilities: {} } };
    },
    put: (url, payload) => {
      puts.push({ url, payload });
      if (url === '/permissions/role/parent') return new Promise((resolve) => { releasePut = () => resolve({ data: payload }); });
      return Promise.resolve({ data: payload });
    },
  };
  try {
    const ui = wiredSheet();
    await render(ui.sheet, { user: { role: 'admin' } });
    const reset = ui.clickReset();
    await tick();
    assert.ok(releasePut, 'das Zuruecksetzen der Eltern-Rolle speichert');
    ui.clickRole('child');
    await tick();
    await tick();
    releasePut();
    await reset;
    await tick();
    await ui.change('module:tasks', 'write');
    await tick();
    await tick();
    assert.deepEqual(puts.at(-1), { url: '/permissions/role/child', payload: { modules: { tasks: 'write' }, widgets: {}, capabilities: {} } },
      'die Kind-Rolle speichert ihre eigene Wahl, nicht die alten Rechte der Eltern-Rolle');
  } finally {
    delete globalThis.__apiStub;
    if (prev.confirm === undefined) delete globalThis.__confirmModal; else globalThis.__confirmModal = prev.confirm;
    if (had.window) globalThis.window = prev.window; else delete globalThis.window;
    if (had.document) globalThis.document = prev.document; else delete globalThis.document;
  }
});

// ── Codex an #2364 (P1): ein gescheiterter PUT legt keine neuere Wahl zurueck ──
//
// Die Wahlen laufen in einer Speicherreihe. Scheiterte der ERSTE PUT, waehrend
// eine zweite Wahl derselben Zeile schon wartete, setzte `set(before)` den
// aelteren Wert zurueck - der Entwurf stand ohne Einschraenkung da, der Server
// auf `none`, und die naechste Wahl hob die Sperre wieder auf. Ebenso schickte
// ein wartender PUT einer anderen Zeile noch den Stand mit der gescheiterten
// Wahl, und ein spaetes Rueckgaengig einer aelteren Wahl ueberschrieb eine neuere.
function queuedPutStub(catalog) {
  const puts = [];
  const held = [];
  globalThis.__apiStub = {
    get: async (url) => (url === '/permissions/catalog'
      ? { data: catalog }
      : { data: { modules: {}, widgets: {}, capabilities: {} } }),
    put: (url, payload) => {
      const entry = { url, payload: JSON.parse(JSON.stringify(payload)) };
      puts.push(entry);
      return new Promise((resolve, reject) => {
        held.push({ ok: () => resolve({ data: payload }), fail: () => reject(new Error('offline')) });
      });
    },
  };
  return { puts, held };
}

async function withPermissionWindow(fn) {
  const hadWindow = 'window' in globalThis;
  const prevWindow = globalThis.window;
  const toasts = [];
  globalThis.window = { yuvomi: { showToast: (...args) => toasts.push(args) } };
  try {
    await fn(toasts);
  } finally {
    delete globalThis.__apiStub;
    if (hadWindow) globalThis.window = prevWindow; else delete globalThis.window;
  }
}

const settle = async () => { for (let i = 0; i < 8; i += 1) await new Promise((r) => setTimeout(r, 0)); };
const TWO_MODULES = { ...CATALOG, modules: [...CATALOG.modules, { key: 'notes', icon: 'sticky-note', labelKey: 'nav.notes' }] };

test('scheitert der erste PUT, waehrend die zweite Wahl derselben Zeile wartet, bleibt die neuere Wahl im Entwurf', async () => {
  const { render } = await import('../public/settings/pages/admin-permissions.js');
  await withPermissionWindow(async () => {
    const { puts, held } = queuedPutStub(TWO_MODULES);
    const ui = wiredSheet();
    await render(ui.sheet, { user: { role: 'admin' } });
    ui.change('module:tasks', 'read');
    await settle();
    ui.change('module:tasks', 'none');
    await settle();
    held[0].fail();
    await settle();
    held[1].ok();
    await settle();
    await settle();
    assert.deepEqual(puts.at(-1).payload.modules, { tasks: 'none' }, 'der Server haelt die Sperre');
    ui.change('module:notes', 'read');
    await settle();
    held.at(-1).ok();
    await settle();
    assert.deepEqual(puts.at(-1).payload.modules, { tasks: 'none', notes: 'read' },
      'die naechste Wahl schickt die Sperre mit, statt sie aufzuheben');
  });
});

test('scheitert ein PUT, schickt der wartende PUT einer anderen Zeile die gescheiterte Wahl nicht mehr mit', async () => {
  const { render } = await import('../public/settings/pages/admin-permissions.js');
  await withPermissionWindow(async () => {
    const { puts, held } = queuedPutStub(TWO_MODULES);
    const ui = wiredSheet();
    await render(ui.sheet, { user: { role: 'admin' } });
    ui.change('module:tasks', 'read');
    await settle();
    ui.change('module:notes', 'none');
    await settle();
    held[0].fail();
    await settle();
    held[1].ok();
    await settle();
    await settle();
    assert.equal(puts.length, 2);
    assert.deepEqual(puts[1].payload.modules, { notes: 'none' },
      'der zweite PUT traegt nur, was im Entwurf steht - die gescheiterte Wahl ist zurueckgelegt');
  });
});

test('Rueckgaengig einer aelteren Wahl ueberschreibt keine neuere derselben Zeile', async () => {
  const { render } = await import('../public/settings/pages/admin-permissions.js');
  await withPermissionWindow(async (toasts) => {
    const { puts, held } = queuedPutStub(TWO_MODULES);
    const ui = wiredSheet();
    await render(ui.sheet, { user: { role: 'admin' } });
    ui.change('module:tasks', 'read');
    await settle();
    held[0].ok();
    await settle();
    const undoFirst = toasts.at(-1)[3];
    ui.change('module:tasks', 'none');
    await settle();
    held[1].ok();
    await settle();
    const count = puts.length;
    undoFirst.onClick();
    await settle();
    held.slice(count).forEach((h) => h.ok());
    await settle();
    await settle();
    ui.change('module:notes', 'read');
    await settle();
    held.at(-1).ok();
    await settle();
    assert.deepEqual(puts.at(-1).payload.modules, { tasks: 'none', notes: 'read' },
      'die Sperre der neueren Wahl steht noch');
  });
});
