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
  timelineKnee, timelineScale, timelineHourMarks, timelineHourCovered,
  TIMELINE_MIN_START, TIMELINE_MIN_END, TIMELINE_MIN_DURATION, TIMELINE_POINT_SPAN,
  TIMELINE_PAST_SHARE, TIMELINE_HOUR_LABEL_MIN, TIMELINE_NOW_COVER,
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
  // Um 18:05 liegt das Knie bei 17:00 (D7): davor ein Drittel der Achse, danach
  // fuenf gleich breite Stunden auf den uebrigen zwei Dritteln.
  assert.equal(layout.knee, at(17));
  const after = (minute) => TIMELINE_PAST_SHARE + ((minute - at(17)) / at(5)) * (1 - TIMELINE_PAST_SHARE);
  const film = layout.lanes[0].items.find((item) => item.id === 'film');
  assert.ok(Math.abs(film.left - after(at(20, 15))) < 1e-9);
  assert.ok(Math.abs(film.width - (at(1, 45) / at(5)) * (1 - TIMELINE_PAST_SHARE)) < 1e-9);
  assert.equal(film.state, 'next');
  assert.equal(layout.lanes[1].items[0].state, 'past');
  assert.ok(Math.abs(layout.now - after(at(18, 5))) < 1e-9);
  const schule = layout.lanes.find((lane) => lane.key === 3).items[0];
  assert.ok(Math.abs(schule.left - (at(1) / at(10)) * TIMELINE_PAST_SHARE) < 1e-9, 'vor dem Knie gestaucht');
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

test('eine Punktmarke nimmt fuer Reihen ihre Beschriftung ein, „laeuft" aber nie', () => {
  const layout = layoutTodayTimeline([
    { id: 'abend', start: at(18, 30), end: at(18, 30), point: true, peopleIds: [] },
    { id: 'film', start: at(19, 30), end: at(21), peopleIds: [] },
  ], { nowMinute: at(18, 45), members });
  const lane = layout.lanes[0];
  assert.equal(lane.rows, 2, 'der Film beginnt, solange die Beschriftung des Abendessens noch steht - eigene Reihe');
  const abend = lane.items.find((item) => item.id === 'abend');
  // Hinter dem Knie (17:00): eine volle Stunde ist ein Fuenftel der zwei Drittel.
  assert.ok(Math.abs(abend.width - (TIMELINE_POINT_SPAN / at(5)) * (1 - TIMELINE_PAST_SHARE)) < 1e-9);
  assert.equal(abend.state, 'past', 'ein Punkt ist vorbei, sobald seine Zeit da war - er laeuft nicht');
});

// DIE GEWICHTETE ACHSE (Ulas, 2026-10-26, D7): Vergangenes bis zum Knie
// gestaucht auf hoechstens ein Drittel, ab dem Knie volle Breite je Stunde.
const AXIS = { start: at(6), end: at(22) };

test('D7: das Knie ist die volle Stunde von jetzt - 1 h und springt nur zur vollen Stunde', () => {
  assert.equal(timelineKnee(at(16, 26), AXIS), at(15));
  assert.equal(timelineKnee(at(16, 0), AXIS), at(15));
  assert.equal(timelineKnee(at(16, 59), AXIS), at(15), 'zwischen den Stunden steht es still');
  assert.equal(timelineKnee(at(17, 0), AXIS), at(16), 'zur vollen Stunde ruckt es eine Stunde vor');
  for (let minute = at(16); minute < at(17); minute += 1) assert.equal(timelineKnee(minute, AXIS), at(15));
  assert.equal(timelineKnee(at(7, 30), AXIS), null, 'faellt auf den Anfang der Achse - linear');
  assert.equal(timelineKnee(at(5, 30), AXIS), null, 'jetzt vor der Achse - linear');
  assert.equal(timelineKnee(at(23), AXIS), null, 'jetzt nach der Achse - linear');
  assert.equal(timelineKnee(NaN, AXIS), null);
});

test('D7: die Abbildung ist stetig und monoton, beginnt bei 0 und endet bei 1', () => {
  for (const knee of [null, at(8), at(12), at(15), at(20), at(21)]) {
    const scale = timelineScale({ ...AXIS, knee });
    assert.equal(scale.x(AXIS.start), 0);
    assert.ok(Math.abs(scale.x(AXIS.end) - 1) < 1e-12);
    let last = -Infinity;
    for (let minute = AXIS.start; minute <= AXIS.end; minute += 1) {
      const x = scale.x(minute);
      assert.ok(x > last, `monoton bei Knie ${knee}, Minute ${minute}`);
      // Stetig: ein Minutenschritt bewegt nie mehr als eine Minute der vollen Breite.
      if (minute > AXIS.start) assert.ok(x - last <= 1 / (AXIS.end - (knee ?? AXIS.start)) + 1e-12, `stetig bei Minute ${minute}`);
      last = x;
    }
    if (scale.knee != null) {
      const left = scale.x(scale.knee - 1e-6);
      const right = scale.x(scale.knee + 1e-6);
      assert.ok(Math.abs(right - left) < 1e-6, 'am Knie kein Sprung');
    }
    assert.ok(Math.abs(scale.width(at(18), at(19)) - (scale.x(at(19)) - scale.x(at(18)))) < 1e-12, 'width ist die Differenz der Lagen');
  }
});

test('D7: die Vergangenheit bekommt hoechstens ein Drittel - und nie mehr als linear', () => {
  const late = timelineScale({ ...AXIS, knee: at(15) });
  assert.ok(Math.abs(late.x(at(15)) - TIMELINE_PAST_SHARE) < 1e-12, 'um 16:26: neun Stunden auf einem Drittel');
  assert.ok(late.x(at(15)) < (at(15) - AXIS.start) / (AXIS.end - AXIS.start), 'weniger als linear (9/16)');
  // Ab dem Knie gleich breite Stunden.
  const hour = late.width(at(15), at(16));
  for (let h = 16; h < 22; h += 1) assert.ok(Math.abs(late.width(at(h), at(h + 1)) - hour) < 1e-12);
  assert.ok(hour > 1 / 16, 'eine kommende Stunde ist breiter als linear');
  // Frueh am Morgen ist die Vergangenheit linear schon schmaler als ein Drittel: linear.
  const early = timelineScale({ ...AXIS, knee: at(9) });
  assert.equal(early.knee, null);
  assert.equal(early.share, 0);
  for (let minute = AXIS.start; minute <= AXIS.end; minute += 7) {
    assert.ok(Math.abs(early.x(minute) - (minute - AXIS.start) / (AXIS.end - AXIS.start)) < 1e-12);
  }
  for (let h = 7; h < 22; h += 1) {
    const scale = timelineScale({ ...AXIS, knee: at(h) });
    const linear = (at(h) - AXIS.start) / (AXIS.end - AXIS.start);
    assert.ok(scale.x(at(h)) <= TIMELINE_PAST_SHARE + 1e-12, `Knie ${h}: hoechstens ein Drittel`);
    assert.ok(scale.x(at(h)) <= linear + 1e-12, `Knie ${h}: nie mehr als linear`);
  }
});

test('D7: die Leiste ist linear, wenn jetzt nicht auf der Achse liegt - und die Reihen rechnen in Minuten', () => {
  const items = [
    { id: 'lauf', start: at(7), end: at(8), peopleIds: [] },
    { id: 'buero', start: at(9), end: at(17), peopleIds: [] },
    { id: 'abend', start: at(17), end: at(18), peopleIds: [] },
  ];
  // 22:30 liegt hinter der Achse 07-22, obwohl „jetzt - 1 h" noch auf ihr laege.
  for (const nowMinute of [at(23), at(22, 30), at(6), undefined]) {
    const layout = layoutTodayTimeline(items, { nowMinute, members });
    assert.equal(layout.knee, null);
    const buero = layout.lanes[0].items.find((item) => item.id === 'buero');
    assert.ok(Math.abs(buero.left - at(2) / at(15)) < 1e-12, `linear um ${nowMinute}`);
    assert.ok(Math.abs(buero.width - at(8) / at(15)) < 1e-12);
  }
  const bent = layoutTodayTimeline(items, { nowMinute: at(18, 30), members });
  assert.equal(bent.knee, at(17));
  assert.equal(bent.lanes[0].rows, 1, 'nacheinander bleibt eine Reihe');
  const [lauf, buero, abend] = bent.lanes[0].items;
  assert.ok(lauf.left + lauf.width <= buero.left + 1e-12 && buero.left + buero.width <= abend.left + 1e-12, 'auf der Achse ueberlappt nichts, was es in der Zeit nicht tut');
  assert.ok(abend.width > 1 / 15, 'das Kommende ist breiter als linear');
  assert.ok(buero.width < at(8) / at(15), 'das Vergangene schmaler');
});

test('D7: vor dem Knie traegt nur jede k-te Stunde ihre Zahl, vom Knie aus gezaehlt', () => {
  const hours = [];
  for (let minute = AXIS.start; minute < AXIS.end; minute += 60) hours.push(minute);
  const marks = timelineHourMarks(timelineScale({ ...AXIS, knee: at(15) }), hours);
  const label = (mark) => `${mark.minute / 60}${mark.sparse ? 's' : ''}${mark.odd ? 'o' : ''}`;
  // Um 16:26: eine Stunde vor dem Knie ist 0,39 einer vollen - jede zweite spricht.
  assert.equal(marks.map(label).join(' '), '6s 7 8s 9o 10s 11 12s 13o 14s 15 16o 17 18o 19 20o 21');
  assert.ok(marks.every((mark) => mark.minute < at(15) || !mark.sparse), 'ab dem Knie spricht jede Stunde');
  assert.ok(Math.abs(marks.find((mark) => mark.minute === at(15)).at - TIMELINE_PAST_SHARE) < 1e-12, 'Lage ueber dieselbe Abbildung');
  // Staerker gestaucht: jede dritte (1 / TIMELINE_HOUR_LABEL_MIN = 2 reicht nicht mehr).
  const tight = timelineScale({ start: at(0), end: at(24), knee: at(20) });
  const every = Math.ceil(TIMELINE_HOUR_LABEL_MIN / tight.density);
  assert.ok(every >= 3, `Vorbedingung: jede ${every}. Stunde`);
  const tightMarks = timelineHourMarks(tight, [...Array(24).keys()].map((h) => at(h)));
  assert.deepEqual(tightMarks.filter((mark) => mark.minute < at(20) && !mark.sparse).map((mark) => mark.minute / 60),
    [...Array(24).keys()].filter((h) => h < 20 && (20 - h) % every === 0));
  // Linear: nichts schweigt, odd wie bisher jede zweite ab dem Anfang.
  const linear = timelineHourMarks(timelineScale(AXIS), hours);
  assert.ok(linear.every((mark) => !mark.sparse));
  assert.deepEqual(linear.map((mark) => mark.odd), hours.map((_, index) => index % 2 === 1));
});

test('D7: die Jetzt-Pille deckt dieselbe Strecke der Achse wie vor der Stauchung', () => {
  const span = AXIS.end - AXIS.start;
  const linear = timelineScale(AXIS);
  assert.equal(timelineHourCovered(linear, at(17), at(16, 26)), true, 'linear: 34 Minuten sind unter 35');
  const bent = timelineScale({ ...AXIS, knee: at(15) });
  // Gestaucht ist die Stunde breiter: 17:00 liegt weiter von 16:26 als die Pille reicht.
  assert.ok(bent.x(at(17)) - bent.x(at(16, 26)) >= TIMELINE_NOW_COVER / span);
  assert.equal(timelineHourCovered(bent, at(17), at(16, 26)), false, 'die 17 spricht wieder');
  assert.equal(timelineHourCovered(bent, at(16, 30), at(16, 26)), true);
  assert.equal(timelineHourCovered(bent, at(16), at(23)), false, 'jetzt nicht auf der Achse - nichts verdeckt');
});
