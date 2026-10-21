import test from 'node:test';
import assert from 'node:assert/strict';

const dashboard = await import('../public/pages/dashboard.js');

test('birthday widget renders a name day as its own labelled occurrence', () => {
  assert.equal(typeof dashboard.renderUpcomingBirthdays, 'function');
  const html = dashboard.renderUpcomingBirthdays([{
    id: 7,
    kind: 'name_day',
    name: 'Jiří',
    next_date: '2026-04-24',
    days_until: 2,
    next_age: null,
    photo_data: null,
    family_user_color: null,
  }], '1x1');

  assert.match(html, />Jiří</);
  assert.match(html, /birthdays\.nameDay/);
  assert.doesNotMatch(html, /birthdays\.turnsAge/);
  assert.match(html, /2026-04-24/);
});

test('birthday occurrence continues to show the upcoming age', () => {
  assert.equal(typeof dashboard.renderUpcomingBirthdays, 'function');
  const html = dashboard.renderUpcomingBirthdays([{
    id: 8,
    kind: 'birthday',
    name: 'Mila',
    next_date: '2026-05-03',
    days_until: 4,
    next_age: 36,
    photo_data: null,
    family_user_color: null,
  }], '1x1');

  assert.match(html, /birthdays\.turnsAge/);
  assert.doesNotMatch(html, /birthdays\.nameDay/);
});

test('legacy birthday data without an age does not render an empty age label', () => {
  const html = dashboard.renderUpcomingBirthdays([{
    id: 9,
    name: 'Bez věku',
    next_birthday: '2026-05-03',
    days_until: 4,
    next_age: null,
    photo_data: null,
    family_user_color: null,
  }], '1x1');

  assert.doesNotMatch(html, /birthdays\.turnsAge/);
  assert.doesNotMatch(html, />null</);
});

test('birthday metric identifies a name-day occurrence instead of calling it a birthday', () => {
  const previousWindow = globalThis.window;
  globalThis.window = { yuvomi: { isModuleDisabled: () => false } };
  try {
    // Eine Kachelreihe braucht mindestens zwei Kacheln (selectMetricTiles). Die
    // zweite war bis R21 der Saldo; seit D5 steht kein Kontostand mehr in der
    // Reihe, also traegt eine angeheftete Notiz die Reihe. Die Geburtstagskachel
    // selbst ist unveraendert in METRIC_TILE_ORDER (test-dashboard.js prueft das).
    const tiles = dashboard.__test.selectMetricTiles({
      pinnedNotes: [{ title: 'Zettel', pinned: 1 }],
      pinnedNotesCount: 1,
      birthdays: [{
        id: 10,
        kind: 'name_day',
        name: 'Jiří',
        days_until: 2,
      }],
    }, 'EUR');

    const birthdayTile = tiles.find((tile) => tile.id === 'birthdays');
    assert.ok(birthdayTile);
    assert.equal(birthdayTile.note, 'Jiří · birthdays.nameDay');
  } finally {
    globalThis.window = previousWindow;
  }
});
