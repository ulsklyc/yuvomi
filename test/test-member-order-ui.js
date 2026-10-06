/**
 * Test: Haushaltsreihenfolge in den Familien-Einstellungen (#1644), Oberflaeche
 * Zweck: Laedt die echte Seite (public/settings/pages/admin-family.js) ueber
 *        den Browser-Loader und prueft, WER einen Griff bekommt und wie ein
 *        Schritt die Folge aendert:
 *          - Griffe nur fuer einen Administrator, nur an Haushaltsmitgliedern
 *            (Personal, Gaeste, Ehemalige stehen in der Liste, aber nicht in
 *            der Reihenfolge), und nicht bei einem einzelnen Mitglied;
 *          - wer nicht ordnen darf, sieht dieselbe Reihenfolge ohne Griff
 *            (Nur-lesen-Regel: Zustand bleibt, Handlung entfaellt);
 *          - der Griff ist ein Knopf mit Namen und ohne das DOM-Attribut
 *            `draggable`, das SortableJS die Geste nimmt;
 *          - die Liste steht in der Haushaltsreihenfolge, Ehemalige am Ende,
 *            ein lokal angehaengtes neues Mitglied im Alphabet der Unplatzierten.
 *
 *        NICHT hier: das Ziehen und die Pfeiltasten selbst. Beides braucht ein
 *        DOM, das Zeilen umhaengt; gefahren wurde es im Browser (PR-Text).
 * Ausfuehren: npm run test:member-order
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

globalThis.window = globalThis.window ?? {};

const { __test: family } = await import('../public/settings/pages/admin-family.js');

const ADMIN = { id: 1, role: 'admin' };
const MEMBER = { id: 2, role: 'member' };

function person(id, name, extra = {}) {
  return {
    id, username: `u${id}`, display_name: name, role: 'member', family_role: 'other', avatar_color: '#123456',
    sort_order: null, is_household_member: true, is_worker: false, deactivated_at: null, ...extra,
  };
}

const USERS = [
  person(1, 'Mara', { role: 'admin', sort_order: 2 }),
  person(2, 'Zoe', { sort_order: 1 }),
  person(3, 'Anna'),
  person(4, 'Carla Putzhilfe', { is_household_member: false, is_worker: true }),
  person(5, 'Gustav Gast', { is_household_member: false, access_scope: 'split_guest' }),
  person(6, 'Dora', { is_household_member: false, deactivated_at: '2026-10-01T10:00:00Z' }),
];

function fakeList() {
  return {
    html: '',
    dataset: {},
    replaceChildren() { this.html = ''; },
    insertAdjacentHTML(_position, markup) { this.html += markup; },
    appendChild() {},
  };
}

function render(users, currentUser) {
  const list = fakeList();
  const hint = { hidden: true };
  const container = { querySelector: (sel) => ({ '#members-list': list, '#members-order-hint': hint }[sel] ?? null) };
  family.renderMemberList(container, users, currentUser.id, currentUser);
  return { list, hint };
}

const rowIds = (html) => [...html.matchAll(/<li class="settings-member[^"]*" data-id="(\d+)"/g)].map((m) => Number(m[1]));
const handleIds = (html) => [...html.matchAll(/data-member-handle="(\d+)"/g)].map((m) => Number(m[1]));

test('an admin gets a handle on every household member, and on nobody else', () => {
  assert.deepEqual(family.orderableIds(USERS, ADMIN), [1, 2, 3]);
  const { list, hint } = render(USERS, ADMIN);
  assert.deepEqual(handleIds(list.html), [2, 1, 3], 'Griffe in der Haushaltsreihenfolge, nicht an Personal, Gast, Ehemaliger');
  assert.equal(hint.hidden, false, 'der Hinweis zur Reihenfolge steht da');
  // Zeilen ohne Position halten den Platz des Griffs frei - als leere Flaeche, nicht als Knopf.
  assert.equal((list.html.match(/settings-member__drag--none" aria-hidden="true"/g) ?? []).length, 3);
  assert.equal((list.html.match(/<button[^>]*settings-member__drag/g) ?? []).length, 3, 'drei Knoepfe, nicht sechs');
});

test('the list stands in the household order: placed, unplaced by name, former accounts last', () => {
  const { list } = render(USERS, ADMIN);
  assert.deepEqual(rowIds(list.html), [2, 1, 3, 4, 5, 6]);
});

test('someone who may not reorder sees the same order without a handle', () => {
  assert.deepEqual(family.orderableIds(USERS, MEMBER), []);
  const { list, hint } = render(USERS, MEMBER);
  assert.deepEqual(rowIds(list.html), [2, 1, 3, 4, 5, 6], 'dieselbe Reihenfolge');
  assert.deepEqual(handleIds(list.html), [], 'kein Griff');
  assert.doesNotMatch(list.html, /settings-member--orderable|settings-member__drag/, 'auch kein freigehaltener Platz');
  assert.equal(hint.hidden, true);
});

test('a single household member has no order to set', () => {
  const alone = [USERS[0], USERS[3], USERS[5]];
  assert.deepEqual(family.orderableIds(alone, ADMIN), []);
  assert.deepEqual(handleIds(render(alone, ADMIN).list.html), []);
});

test('the handle is a named button and never carries the draggable attribute', () => {
  const html = family.memberHtml(person(3, 'Anna <b>'), 1, { orderable: true });
  assert.match(html, /<button type="button" class="row-action settings-member__drag" data-member-handle="3"/);
  assert.match(html, /aria-label="[^"]*Anna &lt;b&gt;[^"]*"/, 'der Name steht escaped in der Beschriftung');
  assert.match(html, /class="settings-member settings-member--orderable"/);
  assert.doesNotMatch(html, /\bdraggable\b/, 'das DOM-Attribut bricht SortableJS');
  assert.doesNotMatch(family.memberHtml(person(3, 'Anna'), 1), /settings-member__drag|settings-member--orderable/);
});

test('a member added locally lands in the alphabet of the unplaced, not at the end', () => {
  const users = [...USERS, person(7, 'Aaron')];
  assert.deepEqual(family.orderedMembers(users).map((u) => u.id), [2, 1, 7, 3, 4, 5, 6]);
});

test('movedOrder: one step up or down, and the same array back at an edge', () => {
  const ids = [5, 6, 7];
  assert.deepEqual(family.movedOrder(ids, 6, -1), [6, 5, 7]);
  assert.deepEqual(family.movedOrder(ids, 6, 1), [5, 7, 6]);
  assert.equal(family.movedOrder(ids, 5, -1), ids, 'oben geht es nicht weiter');
  assert.equal(family.movedOrder(ids, 7, 1), ids, 'unten auch nicht');
  assert.equal(family.movedOrder(ids, 99, 1), ids);
  assert.deepEqual(ids, [5, 6, 7], 'die Eingabe bleibt unveraendert');
});

test('timetable: patterns, overrides and extra shifts are grouped in the household order, not by user id', async () => {
  const { __test: schedule } = await import('../public/pages/schedule.js');
  const state = schedule.scheduleState();
  const saved = state.users;
  // Person 9 steht im Haushalt vor Person 2.
  state.users = [{ id: 9, display_name: 'Zoe', sort_order: 1 }, { id: 2, display_name: 'Anna', sort_order: 2 }];
  try {
    const patterns = [{ id: 1, user_id: 2, valid_from: '2026-02-01' }, { id: 2, user_id: 9, valid_from: '2026-03-01' }, { id: 3, user_id: 9, valid_from: '2026-01-01' }];
    assert.deepEqual(schedule.patternsInMemberOrder(patterns).map((p) => p.id), [2, 3, 1], 'Zoe zuerst, je Person in Serverfolge');
    const overrides = [
      { id: 1, user_id: 2, date_key: '2026-10-05', shift_type_id: 1 },
      { id: 2, user_id: 9, date_key: '2026-10-07', shift_type_id: 1 },
    ];
    assert.deepEqual(schedule.overrideGroups(overrides).map((g) => Number(g.user_id)), [9, 2]);
  } finally {
    state.users = saved;
  }
});

test('wiring: drag and arrow keys share one persistence path, and the route takes the full list', () => {
  const source = readFileSync(path.join(ROOT, 'public/settings/pages/admin-family.js'), 'utf8');
  assert.match(source, /onEnd: \(evt\) => persistMemberOrder\(container, currentUser, users, evt\?\.item\)/);
  assert.match(source, /persistMemberOrder\(ctx\.container, ctx\.currentUser, ctx\.users, row\)/);
  assert.match(source, /api\.patch\('\/family\/members\/reorder', \{ order \}\)/);
  assert.match(source, /draggable: '\.settings-member--orderable'/);
});
