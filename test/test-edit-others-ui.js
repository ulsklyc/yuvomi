/**
 * Test: Oberflaeche zu den R23-Rechten (D4, D5, D15)
 * Zweck: Die Server-Regeln haelt test-edit-others-permissions.js. Hier steht,
 *        was die Oberflaeche daraus macht - keine toten Knoepfe:
 *        - die Client-Helfer in public/permissions.js folgen den Capabilities
 *          (Standard offen, `none` sperrt Fremdes, Eigenes bleibt);
 *        - Kalender, Notizen und Inventar fragen je EINTRAG (nicht nur je
 *          Modul) vor Bearbeiten, Loeschen, Anpinnen;
 *        - das Rollenprofil "Kind" nennt, was neue Kinderkonten zusaetzlich
 *          bekommen;
 *        - die Gesundheit fuehrt EINE Personenwahl je Sitzung
 *          (utils/health-person.js), jeder Bereich liest sie.
 * Ausfuehren: node --loader ./test/test-browser-loader.mjs --test test/test-edit-others-ui.js
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const perms = await import('../public/permissions.js');
const { childStartSummary } = await import('../public/settings/pages/admin-permissions.js');
const hp = await import('../public/utils/health-person.js');

const src = (rel) => readFileSync(new URL(`../public/${rel}`, import.meta.url), 'utf8');

test('Client-Helfer: Fremdes aendern folgt der Capability, Eigenes bleibt offen', () => {
  perms.setPermissions({ admin: false, modules: {}, widgets: {}, capabilities: {} });
  assert.equal(perms.canEditOthers('calendar'), true, 'ohne Zeile gilt der Standard allow');
  assert.equal(perms.canChangeRecord('notes', false), true);
  assert.equal(perms.canSeeInventoryPrices(), true);
  assert.equal(perms.canReorderTasks(), true);

  perms.setPermissions({
    admin: false,
    modules: { calendar: 'write', notes: 'write', inventory: 'write', tasks: 'write' },
    widgets: {},
    capabilities: {
      calendar_edit_others: 'none', notes_edit_others: 'none', inventory_edit_others: 'none',
      inventory_view_prices: 'none', tasks_reorder_family: 'none',
    },
  });
  for (const m of ['calendar', 'notes', 'inventory']) {
    assert.equal(perms.canChangeRecord(m, false), false, `${m}: fremd gesperrt`);
    assert.equal(perms.canChangeRecord(m, true), true, `${m}: eigen offen`);
  }
  assert.equal(perms.canSeeInventoryPrices(), false);
  assert.equal(perms.canReorderTasks(), false);

  perms.setPermissions({ admin: false, modules: { notes: 'read' }, widgets: {}, capabilities: {} });
  assert.equal(perms.canChangeRecord('notes', true), false, 'Nur-lesen sperrt auch Eigenes');
  perms.setPermissions({ admin: true, modules: {}, widgets: {}, capabilities: { notes_edit_others: 'none' } });
  assert.equal(perms.canChangeRecord('notes', false), true, 'Admins umgehen die Rechte');
  perms.clearPermissions();
});

test('Seiten fragen je Eintrag: Kalender, Notizen, Inventar, Aufgaben-Griffe', () => {
  const calendar = src('pages/calendar.js');
  assert.match(calendar, /function mayChangeEvent\(ev\)[\s\S]{0,120}canChangeRecord\('calendar', ownsEvent\(ev\)\)/);
  assert.match(calendar, /const locked = !mayChangeEvent\(ev\);/);
  assert.match(calendar, /edit: locked \? undefined :/);
  assert.match(calendar, /async function requestDeleteEvent\(event\) \{[\s\S]{0,400}if \(!mayChangeEvent\(event\)\) return;/);

  const notes = src('pages/notes.js');
  assert.match(notes, /function mayChange\(note\)[\s\S]{0,120}canChangeRecord\('notes'/);
  assert.match(notes, /function pinMarkup\(note\) \{\s*if \(mayChange\(note\)\)/);
  assert.match(notes, /\$\{!mayChange\(note\) \? '' : rowMenuHtml\(/);
  assert.match(notes, /if \(readOnly\(\) \|\| \(mode === 'edit' && note && !mayChange\(note\)\)\)/);

  const inventory = src('pages/inventory.js');
  assert.match(inventory, /const ro = !mayChangeItem\(item\);/);
  assert.match(inventory, /async function removeItem\(item\) \{\s*if \(!mayChangeItem\(item\)\) return;/);
  assert.match(inventory, /canSeeInventoryPrices\(\) \? `<span class="inventory-row__value">/);

  const tasks = src('pages/tasks.js');
  assert.match(tasks, /function canReorderTasks\(groupMode\)[\s\S]{0,400}&& mayReorderHousehold\(\);/);
});

test('Rollenprofil Kind: die Zeile nennt die Startrechte, nach Stufe gebuendelt', () => {
  const catalog = {
    modules: [{ key: 'budget' }, { key: 'waste' }, { key: 'housekeeping' }],
    capabilities: [{ key: 'calendar_edit_others', labelKey: 'settings.permCapabilityCalendarEditOthers' }],
    childStart: { modules: { budget: 'none', housekeeping: 'read', waste: 'read' }, capabilities: { calendar_edit_others: 'none' } },
  };
  const text = childStartSummary(catalog);
  // Der Stub von t() gibt Schluessel und Parameter zurueck.
  assert.equal(text, 'settings.permChildRoleHint{"list":"settings.permAccessNone: budget; '
    + 'settings.permAccessRead: housekeeping, waste; settings.permCapabilityBlocked: settings.permCapabilityCalendarEditOthers"}');
  assert.equal(childStartSummary({ modules: [], capabilities: [] }), '', 'ohne childStart keine Zeile');
  const page = src('settings/pages/admin-permissions.js');
  assert.match(page, /state\.mode === 'role' && state\.subjectId === 'child' && childStartSummary\(\)/);
});

test('Gesundheit: eine Personenwahl je Sitzung, geprueft gegen die Liste', () => {
  const store = new Map();
  globalThis.sessionStorage = {
    getItem: (k) => (store.has(k) ? store.get(k) : null),
    setItem: (k, v) => store.set(k, String(v)),
    removeItem: (k) => store.delete(k),
  };
  try {
    assert.equal(hp.readHealthPerson(2), null);
    hp.writeHealthPerson(2, 3);
    assert.equal(hp.readHealthPerson(2), 3);
    assert.equal(hp.readHealthPerson(5), null, 'je Konto ein eigener Schluessel');
    assert.equal(hp.healthPersonIsOther(2), true);
    const members = [{ id: 2 }, { id: 3 }];
    assert.equal(hp.pickHealthPerson({ members, meId: 2, stored: 3 }), 3);
    assert.equal(hp.pickHealthPerson({ members, meId: 2, stored: 9 }), 2, 'nicht in der Liste: zurueck zu mir');
    hp.writeHealthPerson(2, 2);
    assert.equal(hp.readHealthPerson(2), null, 'die eigene Person ist der Normalfall, kein Eintrag');
    assert.equal(hp.healthPersonIsOther(2), false);
  } finally {
    delete globalThis.sessionStorage;
  }
  assert.equal(hp.readHealthPerson(2), null, 'ohne Speicher gilt die eigene Person');

  const health = src('pages/health.js');
  for (const view of ['vitals', 'meds', 'labs', 'activity', 'prevention', 'nutrition', 'overview', 'cycle']) {
    assert.match(health, new RegExp(`adoptSessionPerson\\(${view}\\);\\n  if \\(${view}\\.root === root && ${view}\\.loaded\\) return;`),
      `${view}: liest die Person der Sitzung beim Oeffnen`);
  }
  assert.match(health, /view\.personId = id;\s*\/\/[^\n]*\n\s*writeHealthPerson\(view\.meId, id\);/);
  assert.match(health, /view\.personId = pickHealthPerson\(\{ members: view\.members, meId: view\.meId, stored: readHealthPerson\(view\.meId\) \}\);/);
  assert.match(health, /if \(healthPersonIsOther\(healthUser\?\.id\)\) \{\s*for \(const area of HEALTH_AREAS/);
  const fasting = src('pages/health-fasting.js');
  assert.match(fasting, /const wanted = readHealthPerson\(userId\) \?\? userId;/);
  assert.match(fasting, /writeHealthPerson\(view\.self, id\);/);
});
