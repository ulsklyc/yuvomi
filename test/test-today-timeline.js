/**
 * Modul: Zeitleiste des Heute-Blatts (public/utils/today-timeline.js)
 * Zweck: Bereich der Achse, Spuren je Person, Ueberlappung und der Zustand
 *        eines Blocks - rein, ohne DOM. Die Minuten kommen in der Wanduhr
 *        des Haushalts an; die Zone rechnet dashboard.js davor.
 *
 * Ausfuehren: npm run test:today-timeline
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  timelineRange, packLane, laneKeysFor, timelineState, layoutTodayTimeline,
  TIMELINE_MIN_START, TIMELINE_MIN_END, TIMELINE_MIN_DURATION,
} from '../public/utils/today-timeline.js';

const at = (h, m = 0) => h * 60 + m;
const members = [{ id: 1, display_name: 'Linda' }, { id: 2, display_name: 'Alex' }, { id: 3, display_name: 'Emma' }];

test('die Achse zeigt mindestens 07-22 und waechst mit dem fruehesten und spaetesten Termin', () => {
  assert.deepEqual(timelineRange([{ start: at(9), end: at(10) }]), { start: TIMELINE_MIN_START, end: TIMELINE_MIN_END });
  // Der Lauf um 6:15 stuende sonst vor der Achse - sie beginnt um 6:00.
  assert.deepEqual(timelineRange([{ start: at(6, 15), end: at(7) }]), { start: at(6), end: TIMELINE_MIN_END });
  assert.deepEqual(timelineRange([{ start: at(20), end: at(23, 10) }]), { start: TIMELINE_MIN_START, end: at(24) });
  assert.deepEqual(timelineRange([{ start: 0, end: 24 * 60 }]), { start: 0, end: 24 * 60 });
});

test('gleichzeitige Termine einer Spur gehen in eigene Reihen, nacheinander folgende teilen eine', () => {
  const items = [
    { start: at(8), end: at(13) },
    { start: at(9), end: at(11) },
    { start: at(11), end: at(12) },
    { start: at(13), end: at(14) },
  ];
  assert.equal(packLane(items), 2);
  assert.deepEqual(items.map((item) => item.row), [0, 1, 1, 0]);
  assert.equal(packLane([]), 1);
});

test('ein Termin ohne Person oder fuer alle steht in der Spur des Haushalts, sonst bei jeder Person', () => {
  const ids = members.map((m) => m.id);
  assert.deepEqual(laneKeysFor([], ids), ['all']);
  assert.deepEqual(laneKeysFor([1, 2, 3], ids), ['all']);
  // Ein Termin fuer zwei geht beide an (#1828).
  assert.deepEqual(laneKeysFor([1, 3], ids), [1, 3]);
  // Wer nicht (mehr) zum Haushalt gehoert, bekommt keine Spur.
  assert.deepEqual(laneKeysFor([99], ids), ['all']);
  // Allein im Haushalt gibt es nur eine Spur, auch fuer den eigenen Termin.
  assert.deepEqual(laneKeysFor([1], [1], { solo: true }), ['all']);
});

test('vorbei heisst: das echte Ende liegt hinter uns - dieselbe Grenze wie eventHasEnded', () => {
  assert.equal(timelineState({ start: at(9), realEnd: at(10) }, at(10)), 'past');
  assert.equal(timelineState({ start: at(9), realEnd: at(10) }, at(9, 59)), 'now');
  assert.equal(timelineState({ start: at(9), realEnd: at(10) }, at(9)), 'now');
  assert.equal(timelineState({ start: at(9), realEnd: at(10) }, at(8, 59)), 'next');
  // Ohne Dauer ist der Beginn das Ende.
  assert.equal(timelineState({ start: at(9), realEnd: at(9) }, at(9)), 'past');
});

test('die Leiste: Spuren in Haushaltsreihenfolge, nur mit Terminen, Anteile auf der Achse', () => {
  const layout = layoutTodayTimeline([
    { id: 'zahnarzt', start: at(11), end: at(12), peopleIds: [2] },
    { id: 'film', start: at(20, 15), end: at(22), peopleIds: [] },
    { id: 'schule', start: at(8), end: at(13), peopleIds: [3] },
    { id: 'abend', start: at(18, 30), end: at(19, 30), peopleIds: [1, 2, 3] },
  ], { nowMinute: at(18, 5), members });
  assert.equal(layout.start, at(7));
  assert.equal(layout.end, at(22));
  assert.equal(layout.hours.length, 15);
  // „Alle" zuerst, dann die Mitglieder in ihrer Reihenfolge - Linda hat heute nichts.
  assert.deepEqual(layout.lanes.map((lane) => lane.key), ['all', 2, 3]);
  assert.equal(layout.lanes[1].member.display_name, 'Alex');
  const film = layout.lanes[0].items.find((item) => item.id === 'film');
  assert.ok(Math.abs(film.left - (at(20, 15) - at(7)) / at(15)) < 1e-9);
  assert.ok(Math.abs(film.width - at(1, 45) / at(15)) < 1e-9);
  assert.equal(film.state, 'next');
  assert.equal(layout.lanes[1].items[0].state, 'past');
  assert.ok(Math.abs(layout.now - (at(18, 5) - at(7)) / at(15)) < 1e-9);
});

test('ein Termin fuer zwei steht in beiden Spuren mit je eigener Reihe', () => {
  const layout = layoutTodayTimeline([
    { id: 'a', start: at(9), end: at(11), peopleIds: [1] },
    { id: 'b', start: at(10), end: at(12), peopleIds: [1, 2] },
  ], { nowMinute: at(8), members });
  const linda = layout.lanes.find((lane) => lane.key === 1);
  const alex = layout.lanes.find((lane) => lane.key === 2);
  assert.equal(linda.rows, 2);
  assert.equal(alex.rows, 1);
  assert.equal(alex.items[0].row, 0);
});

test('ohne Dauer bekommt ein Termin eine halbe Stunde Flaeche; ausserhalb der Achse kein Jetzt-Strich', () => {
  const layout = layoutTodayTimeline([{ id: 'p', start: at(9), end: at(9), peopleIds: [] }], { nowMinute: at(23), members });
  const item = layout.lanes[0].items[0];
  assert.ok(Math.abs(item.width - TIMELINE_MIN_DURATION / at(15)) < 1e-9);
  assert.equal(item.state, 'past');
  assert.equal(layout.now, null);
});

test('kein Termin mit Uhrzeit, keine Leiste', () => {
  assert.equal(layoutTodayTimeline([], { nowMinute: at(9), members }), null);
});
