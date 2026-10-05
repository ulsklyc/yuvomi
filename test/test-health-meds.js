/**
 * Modul: Medikamenten-Logik-Test
 * Zweck: Reine Funktionen computeDueDoses (days_mask/Zeitfenster/Zeitraum-Bucketing),
 *        computeAdherence und refillState plus Wochentags-Masken-Helfer. DOM-frei.
 * Ausführen: node --loader ./test/test-browser-loader.mjs --test test/test-health-meds.js
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const {
  WEEKDAY_COUNT,
  weekdayIndex,
  daysMaskMatches,
  daysMaskToIndices,
  indicesToDaysMask,
  computeDueDoses,
  computeAdherence,
  refillState,
  parseLogInstant,
  toLocalStamp,
  prnDoseState,
  splitRemaining,
  scheduledLogs,
} = await import('../public/utils/health-meds.js');

const { __test: healthHelpers } = await import('../public/pages/health.js');

// --------------------------------------------------------
// Wochentags-Masken
// --------------------------------------------------------

test('weekdayIndex: Montag = 0 … Sonntag = 6', () => {
  assert.equal(WEEKDAY_COUNT, 7);
  assert.equal(weekdayIndex('2026-06-15'), 0); // Montag
  assert.equal(weekdayIndex('2026-06-20'), 5); // Samstag
  assert.equal(weekdayIndex('2026-06-21'), 6); // Sonntag
});

test('daysMaskMatches: NULL/leer = täglich, sonst Bitmaske', () => {
  assert.equal(daysMaskMatches(null, 0), true);
  assert.equal(daysMaskMatches(undefined, 3), true);
  assert.equal(daysMaskMatches('', 6), true);
  // Nur Montag (Bit 0) + Mittwoch (Bit 2) = 0b0000101 = 5
  assert.equal(daysMaskMatches(5, 0), true);
  assert.equal(daysMaskMatches(5, 1), false);
  assert.equal(daysMaskMatches(5, 2), true);
});

test('daysMaskToIndices / indicesToDaysMask sind konsistent', () => {
  assert.deepEqual(daysMaskToIndices(null), [0, 1, 2, 3, 4, 5, 6]); // täglich
  assert.deepEqual(daysMaskToIndices(5), [0, 2]);
  // Round-Trip einer echten Teilmenge
  assert.equal(indicesToDaysMask([0, 2]), 5);
  // Alle oder keine Tage → null (= täglich)
  assert.equal(indicesToDaysMask([0, 1, 2, 3, 4, 5, 6]), null);
  assert.equal(indicesToDaysMask([]), null);
});

// --------------------------------------------------------
// computeDueDoses
// --------------------------------------------------------

test('computeDueDoses: tägliches Zeitfenster über eine Woche', () => {
  const schedules = [
    { id: 1, medication_id: 10, time_of_day: '08:00', days_mask: null, dose_qty: 1, active: 1 },
  ];
  const doses = computeDueDoses(schedules, { from: '2026-06-15', to: '2026-06-21' });
  assert.equal(doses.length, 7);
  assert.equal(doses[0].scheduledAt, '2026-06-15T08:00');
  assert.equal(doses[0].scheduleId, 1);
  assert.equal(doses[0].medicationId, 10);
  assert.equal(doses[0].dose_qty, 1);
});

test('computeDueDoses: days_mask filtert Wochentage', () => {
  // Nur Mo (0) + Mi (2) = 5
  const schedules = [
    { id: 2, medication_id: 11, time_of_day: '20:00', days_mask: 5, dose_qty: 2, active: 1 },
  ];
  const doses = computeDueDoses(schedules, { from: '2026-06-15', to: '2026-06-21' });
  // Mo 15., Mi 17. → 2 Dosen
  assert.equal(doses.length, 2);
  assert.deepEqual(doses.map((d) => d.date), ['2026-06-15', '2026-06-17']);
});

test('computeDueDoses: mehrere Zeitfenster pro Tag, chronologisch sortiert', () => {
  const schedules = [
    { id: 1, medication_id: 10, time_of_day: '20:00', days_mask: null, dose_qty: 1, active: 1 },
    { id: 2, medication_id: 10, time_of_day: '08:00', days_mask: null, dose_qty: 1, active: 1 },
  ];
  const doses = computeDueDoses(schedules, { from: '2026-06-15', to: '2026-06-15' });
  assert.equal(doses.length, 2);
  assert.equal(doses[0].scheduledAt, '2026-06-15T08:00');
  assert.equal(doses[1].scheduledAt, '2026-06-15T20:00');
});

test('computeDueDoses: inaktive Pläne und Start/End-Grenzen', () => {
  const schedules = [
    { id: 1, medication_id: 10, time_of_day: '08:00', days_mask: null, active: 0 },
    { id: 2, medication_id: 11, time_of_day: '09:00', days_mask: null, active: 1, start_date: '2026-06-18' },
    { id: 3, medication_id: 12, time_of_day: '10:00', days_mask: null, active: 1, end_date: '2026-06-16' },
  ];
  const doses = computeDueDoses(schedules, { from: '2026-06-15', to: '2026-06-19' });
  // Plan 1 inaktiv → nie; Plan 2 ab 18.; Plan 3 bis 16.
  assert.equal(doses.filter((d) => d.scheduleId === 1).length, 0);
  assert.deepEqual(doses.filter((d) => d.scheduleId === 2).map((d) => d.date), ['2026-06-18', '2026-06-19']);
  assert.deepEqual(doses.filter((d) => d.scheduleId === 3).map((d) => d.date), ['2026-06-15', '2026-06-16']);
});

test('computeDueDoses: leerer / ungültiger Zeitraum → []', () => {
  assert.deepEqual(computeDueDoses([], { from: '2026-06-15', to: '2026-06-21' }), []);
  assert.deepEqual(computeDueDoses([{ id: 1, time_of_day: '08:00' }], {}), []);
  assert.deepEqual(computeDueDoses([{ id: 1, time_of_day: '08:00' }], { from: '2026-06-21', to: '2026-06-15' }), []);
});

// --------------------------------------------------------
// computeAdherence
// --------------------------------------------------------

test('computeAdherence: genommen / geplant', () => {
  const logs = [
    { status: 'taken' }, { status: 'taken' }, { status: 'skipped' }, { status: 'pending' },
  ];
  const a = computeAdherence(logs, 5);
  assert.equal(a.taken, 2);
  assert.equal(a.skipped, 1);
  assert.equal(a.pending, 1);
  assert.equal(a.planned, 5);
  assert.equal(a.rate, 2 / 5);
});

test('computeAdherence: ohne planned → Basis aus getroffenen Entscheidungen', () => {
  const logs = [{ status: 'taken' }, { status: 'taken' }, { status: 'skipped' }];
  const a = computeAdherence(logs);
  assert.equal(a.planned, 3); // taken + skipped
  assert.equal(a.rate, 2 / 3);
});

test('computeAdherence: nie über 100 % bei Ad-hoc-Logs', () => {
  const logs = [{ status: 'taken' }, { status: 'taken' }, { status: 'taken' }];
  const a = computeAdherence(logs, 1); // mehr genommen als geplant
  assert.equal(a.rate, 1); // gedeckelt auf 3/3
});

test('computeAdherence: keine Basis → rate null', () => {
  const a = computeAdherence([], 0);
  assert.equal(a.rate, null);
  assert.equal(a.taken, 0);
});

// --------------------------------------------------------
// refillState
// --------------------------------------------------------

test('refillState: kein Bestand erfasst → none', () => {
  const s = refillState({ stock_qty: null, refill_threshold: 5 });
  assert.equal(s.level, 'none');
  assert.equal(s.stock, null);
  assert.equal(s.below, false);
});

test('refillState: leer → out', () => {
  const s = refillState({ stock_qty: 0, refill_threshold: 5 });
  assert.equal(s.level, 'out');
  assert.equal(s.below, true);
});

test('refillState: unter/gleich Schwelle → low', () => {
  assert.equal(refillState({ stock_qty: 5, refill_threshold: 5 }).level, 'low');
  assert.equal(refillState({ stock_qty: 3, refill_threshold: 5 }).level, 'low');
  assert.equal(refillState({ stock_qty: 3, refill_threshold: 5 }).below, true);
});

test('refillState: über Schwelle oder ohne Schwelle → ok', () => {
  assert.equal(refillState({ stock_qty: 10, refill_threshold: 5 }).level, 'ok');
  assert.equal(refillState({ stock_qty: 10, refill_threshold: null }).level, 'ok');
  assert.equal(refillState({ stock_qty: 10, refill_threshold: null }).below, false);
});

// --------------------------------------------------------
// Bedarfsmedikation (#700)
// --------------------------------------------------------

test('parseLogInstant: Wanduhrzeit bleibt Wanduhrzeit, Z bleibt Instant', () => {
  const wall = parseLogInstant('2026-08-16T18:40');
  assert.equal(wall.getHours(), 18);
  assert.equal(wall.getMinutes(), 40);
  assert.equal(wall.getFullYear(), 2026);

  // Mit Sekunden, weiterhin ohne Zone.
  assert.equal(parseLogInstant('2026-08-16T18:40:30').getHours(), 18);

  // Mit Zone: derselbe Moment wie Date.parse, also NICHT als Wanduhrzeit gelesen.
  assert.equal(parseLogInstant('2026-08-16T18:40:00Z').getTime(),
    Date.parse('2026-08-16T18:40:00Z'));

  assert.equal(parseLogInstant(''), null);
  assert.equal(parseLogInstant(null), null);
  assert.equal(parseLogInstant('kein Datum'), null);
});

test('toLocalStamp: Minutenstempel ohne Zone, Gegenstueck zu parseLogInstant', () => {
  const at = new Date(2026, 7, 16, 9, 5);
  assert.equal(toLocalStamp(at), '2026-08-16T09:05');
  // Hin und zurueck ergibt denselben Moment - das ist der Punkt der beiden.
  assert.equal(parseLogInstant(toLocalStamp(at)).getTime(), at.getTime());
});

test('prnDoseState: ohne Mindestabstand gibt es keinen Countdown', () => {
  const med = { id: 1, min_interval_hours: null };
  const logs = [{ status: 'taken', taken_at: '2026-08-16T12:40' }];
  const s = prnDoseState(med, logs, new Date(2026, 7, 16, 13, 0));
  assert.equal(s.allowed, true);
  assert.equal(s.nextAllowedAt, null);
  assert.equal(s.remainingMs, 0);
  assert.equal(s.lastTakenAt.getHours(), 12);
});

test('prnDoseState: naechste Dosis faellt aus letzter Einnahme plus Abstand', () => {
  const med = { id: 1, min_interval_hours: 6 };
  const logs = [{ status: 'taken', taken_at: '2026-08-16T12:40' }];
  const s = prnDoseState(med, logs, new Date(2026, 7, 16, 13, 20));

  assert.equal(s.allowed, false);
  assert.equal(s.nextAllowedAt.getHours(), 18);
  assert.equal(s.nextAllowedAt.getMinutes(), 40);
  assert.equal(s.remainingMs, 5 * 3600_000 + 20 * 60_000);
});

test('prnDoseState: der Countdown haengt an der Uhr, nicht am Seitenaufbau', () => {
  const med = { id: 1, min_interval_hours: 6 };
  const logs = [{ status: 'taken', taken_at: '2026-08-16T12:40' }];
  // Derselbe Eintrag, zwei Zeitpunkte: nur die Restdauer wandert, der erlaubte
  // Zeitpunkt bleibt stehen. Genau das muss einen Reload ueberleben.
  const early = prnDoseState(med, logs, new Date(2026, 7, 16, 13, 40));
  const later = prnDoseState(med, logs, new Date(2026, 7, 16, 17, 40));
  assert.equal(early.nextAllowedAt.getTime(), later.nextAllowedAt.getTime());
  assert.equal(early.remainingMs, 5 * 3600_000);
  assert.equal(later.remainingMs, 1 * 3600_000);

  const after = prnDoseState(med, logs, new Date(2026, 7, 16, 18, 41));
  assert.equal(after.allowed, true);
  assert.equal(after.remainingMs, 0);
});

test('prnDoseState: nur genommene Dosen zaehlen', () => {
  const med = { id: 1, min_interval_hours: 6 };
  const logs = [
    { status: 'taken',   taken_at: '2026-08-16T08:00' },
    { status: 'skipped', taken_at: null, scheduled_at: '2026-08-16T14:00' },
    { status: 'pending', taken_at: null, scheduled_at: '2026-08-16T16:00' },
  ];
  const s = prnDoseState(med, logs, new Date(2026, 7, 16, 15, 0));
  // Uebersprungen und ausstehend sagen nichts darueber, wann der Koerper
  // zuletzt etwas bekommen hat - sonst schoebe eine ignorierte Zeile den
  // Countdown nach hinten.
  assert.equal(s.lastTakenAt.getHours(), 8);
  assert.equal(s.nextAllowedAt.getHours(), 14);
  assert.equal(s.allowed, true);
});

test('prnDoseState: die spaeteste genommene Dosis gewinnt, egal wie sortiert', () => {
  const med = { id: 1, min_interval_hours: 4 };
  const logs = [
    { status: 'taken', taken_at: '2026-08-16T09:00' },
    { status: 'taken', taken_at: '2026-08-16T15:00' },
    { status: 'taken', taken_at: '2026-08-16T12:00' },
  ];
  const s = prnDoseState(med, logs, new Date(2026, 7, 16, 16, 0));
  assert.equal(s.lastTakenAt.getHours(), 15);
  assert.equal(s.nextAllowedAt.getHours(), 19);
});

test('prnDoseState: eine alte Z-Zeile wird nicht um den UTC-Abstand verschoben', () => {
  const med = { id: 1, min_interval_hours: 6 };
  const instant = Date.parse('2026-08-16T10:40:00Z');
  const logs = [{ status: 'taken', taken_at: '2026-08-16T10:40:00Z' }];
  const s = prnDoseState(med, logs, new Date(instant));
  assert.equal(s.lastTakenAt.getTime(), instant);
  assert.equal(s.nextAllowedAt.getTime(), instant + 6 * 3600_000);
});

test('prnDoseState: ohne Einnahme steht die Dosis offen', () => {
  const s = prnDoseState({ id: 1, min_interval_hours: 6 }, [], new Date());
  assert.equal(s.lastTakenAt, null);
  assert.equal(s.nextAllowedAt, null);
  assert.equal(s.allowed, true);
});

test('prnDoseState: ein Abstand von 0 oder darunter ist keiner', () => {
  const logs = [{ status: 'taken', taken_at: '2026-08-16T12:00' }];
  const now = new Date(2026, 7, 16, 12, 1);
  assert.equal(prnDoseState({ min_interval_hours: 0 }, logs, now).nextAllowedAt, null);
  assert.equal(prnDoseState({ min_interval_hours: -3 }, logs, now).nextAllowedAt, null);
});

test('splitRemaining: auf die volle Minute AUFgerundet', () => {
  assert.deepEqual(splitRemaining(5 * 3600_000 + 20 * 60_000), { hours: 5, minutes: 20 });
  assert.deepEqual(splitRemaining(90 * 60_000), { hours: 1, minutes: 30 });
  // Die letzten Sekunden duerfen nicht als „0 Min." dastehen - das gaebe eine
  // Dosis frei, die noch nicht erlaubt ist.
  assert.deepEqual(splitRemaining(30_000), { hours: 0, minutes: 1 });
  assert.deepEqual(splitRemaining(0), { hours: 0, minutes: 0 });
  assert.deepEqual(splitRemaining(-5000), { hours: 0, minutes: 0 });
});

test('scheduledLogs: eine Bedarfsdosis zaehlt nicht als eingehaltener Plan', () => {
  const logs = [
    { id: 1, status: 'taken', schedule_id: 7, scheduled_at: '2026-08-16T08:00' },
    { id: 2, status: 'taken', schedule_id: null, taken_at: '2026-08-16T12:40' }, // bei Bedarf
    { id: 3, status: 'skipped', schedule_id: 7, scheduled_at: '2026-08-16T20:00' },
    // Der Plan dahinter wurde geloescht: `schedule_id` ist per ON DELETE SET NULL
    // weg, der geplante Zeitpunkt steht noch. Die Dosis WAR geplant und muss in
    // der Rechnung bleiben - sonst faellt die Adhaerenz vergangener Wochen in
    // sich zusammen, weil jemand einen alten Einnahmeplan aufgeraeumt hat.
    { id: 4, status: 'taken', schedule_id: null, scheduled_at: '2026-08-15T08:00' },
  ];
  assert.deepEqual(scheduledLogs(logs).map((l) => l.id), [1, 3, 4]);

  // Der Fall aus dem Review: drei von sieben geplanten genommen, dazu acht
  // Bedarfsdosen. Ungefiltert stünde da „100 %, 11 von 11".
  const viele = [
    ...Array.from({ length: 3 }, (_, i) => ({ status: 'taken', schedule_id: i + 1, scheduled_at: `2026-08-1${i}T08:00` })),
    ...Array.from({ length: 8 }, () => ({ status: 'taken', schedule_id: null, scheduled_at: null })),
  ];
  assert.equal(computeAdherence(viele, 7).rate, 1);
  assert.equal(computeAdherence(scheduledLogs(viele), 7).rate, 3 / 7);

  assert.deepEqual(scheduledLogs(null), []);
});

// --------------------------------------------------------
// Betreuungsrechte im Einnahmeprotokoll (#999)
// --------------------------------------------------------

test('Einnahmeprotokoll: Korrektur folgt dem gemeinsamen Betreuungsrecht', () => {
  const source = readFileSync(new URL('../public/pages/health.js', import.meta.url), 'utf8');
  const start = source.indexOf('function medLogHistoryMarkup()');
  const end = source.indexOf('/** Ein Log-Eintrag', start);
  assert.ok(start >= 0 && end > start, 'medLogHistoryMarkup muss auffindbar sein');

  const historyMarkup = source.slice(start, end);
  assert.match(historyMarkup, /const own = canEditFor\(meds\.personId, meds\.meId\)/,
    'auch eine ausdruecklich betreute Person braucht den Korrekturknopf');
  assert.doesNotMatch(historyMarkup, /meds\.personId === meds\.meId/,
    'eine reine Eigentuemerpruefung schneidet Betreuende vom erlaubten API-Weg ab');
});

test('canEditFor: eigene Daten, betreute Person und unbeteiligtes Mitglied (#1031, Option 2)', () => {
  // Der Test oben beweist nur, dass die Aufrufstelle canEditFor() benutzt statt
  // einer reinen Eigentuemerpruefung - er beweist nicht, dass canEditFor() selbst
  // die drei Berechtigungsfaelle richtig unterscheidet. Das prueft dieser Test.
  const selfId = 1;
  const caredForId = 2;
  const unrelatedId = 3;
  try {
    healthHelpers.setCareForForTest([caredForId]);
    assert.equal(healthHelpers.canEditFor(selfId, selfId), true,
      'eigene Daten muessen bearbeitbar bleiben');
    assert.equal(healthHelpers.canEditFor(caredForId, selfId), true,
      'eine betreute Person muss bearbeitbar sein');
    assert.equal(healthHelpers.canEditFor(unrelatedId, selfId), false,
      'ein unbeteiligtes Mitglied darf nicht bearbeitbar sein');
  } finally {
    healthHelpers.setCareForForTest([]);
  }
});

// --------------------------------------------------------
// Dosis-Knoepfe nennen das Medikament (Re-Critique 2026-09-28, A6 P2-3)
// --------------------------------------------------------

test('Dosis-Knoepfe: Name nennt das Medikament, kein Haken-Kreis, beide Renderer gleich', async () => {
  // Vorher: aria-label nur „Einnehmen"/„Ueberspringen", zweimal identisch in
  // einer Liste mit zwei Medikamenten; mobil ein gefuellter Haken-Kreis, der
  // sich als „erledigt" liest (Erinnerungen-Grammatik).
  const { eachRule } = await import('./css-rules.js');
  const dosis = (medicationId) => ({ medicationId, scheduleId: 2, scheduledAt: '2026-06-15T08:00', time: '08:00', dose_qty: 1 });
  const med = (id, name) => ({ id, name, active: 1, prn: 0 });
  const knoepfe = (html) => ({
    take: html.match(/<button[^>]*health-dose__take[^>]*>[\s\S]*?<\/button>/)?.[0],
    skip: html.match(/<button[^>]*health-dose__skip[^>]*>[\s\S]*?<\/button>/)?.[0],
  });
  const label = (tag) => tag.match(/aria-label="([^"]*)"/)?.[1] ?? '';
  healthHelpers.setViewStateForTest('meds', { meId: 1, personId: 1 });
  try {
    const renderers = [
      ['Medikamente', (d, m) => healthHelpers.dueRowMarkup(d, m, null)],
      ['Uebersicht', (d, m) => healthHelpers.overviewDueRowMarkup(d, m, null, true)],
    ];
    for (const [wo, render] of renderers) {
      const a = knoepfe(render(dosis(1), med(1, 'Vitamin D3')));
      const b = knoepfe(render(dosis(2), med(2, 'Eisen')));
      assert.ok(a.take && a.skip, `${wo}: beide Knoepfe gerendert`);
      assert.match(label(a.take), /Vitamin D3/, `${wo}: Einnehmen nennt das Medikament`);
      assert.match(label(a.skip), /Vitamin D3/, `${wo}: Ueberspringen nennt das Medikament`);
      assert.notEqual(label(a.take), label(a.skip), `${wo}: zwei Knoepfe, zwei Namen`);
      assert.notEqual(label(a.take), label(b.take), `${wo}: zwei Medikamente, zwei Namen`);
      assert.doesNotMatch(a.take, /data-lucide="check"/, `${wo}: kein Haken auf der Handlung - der Haken ist der Zustand danach`);
      assert.match(a.take, /health-dose__take-label/, `${wo}: der Knopf traegt sein Wort`);
    }
  } finally {
    healthHelpers.setViewStateForTest('meds', { meId: null, personId: null });
  }
  // Mobil (Container 324px bei 390, also unter 21rem) bleibt das Wort am
  // Einnehmen-Knopf: eine Kapsel mit Kurzlabel statt eines Icon-Kreises.
  const css = readFileSync(new URL('../public/styles/health.css', import.meta.url), 'utf8');
  for (const { selector, body, at } of eachRule(css)) {
    if (!/\.health-dose__take-label/.test(selector) || !/display:\s*none/.test(body)) continue;
    const grenze = at.join(' ').match(/max-width:\s*([\d.]+)rem/);
    assert.ok(grenze, `${selector}: das Wort faellt nur unter einer Containergrenze`);
    assert.ok(Number(grenze[1]) * 16 < 324, `${at.join(' ')}: bei 390px (Container 324px) muss „Einnehmen" stehen bleiben`);
  }
});

// --------------------------------------------------------
// Einnahmeprotokoll: die Uhrzeit ist die des Haushalts (#1539)
// --------------------------------------------------------
// `taken_at`/`scheduled_at` sind Wanduhrzeit des Haushalts. Das Protokoll
// reichte `new Date(taken_at)` an `formatTime` - ein Zeitpunkt der GERAETE-
// Zone, den `formatTime` danach in die Haushaltszone umrechnet. Der Prozess
// laeuft deshalb in New York, der Haushalt in Berlin. Der Stub von
// `formatTime` gibt sein Argument als Text zurueck; gelesen wird es ueber
// `zonedTimeKey`, dieselbe Umrechnung wie im echten `formatTime`.

const tzModule = await import('/utils/timezone.js');

function medLogTimes(logs) {
  healthHelpers.setViewStateForTest('meds', {
    list: [{ id: 1, name: 'Ibuprofen', active: 1 }], logsByMed: { 1: logs }, personId: 5, meId: 5,
  });
  const html = healthHelpers.medLogHistoryMarkup();
  return [...html.matchAll(/health-medlog__time">([^<]*)</g)].map(([, label]) => {
    const [day, time] = label.split(' · ');
    return [tzModule.zonedDateKey(day), tzModule.zonedTimeKey(time)];
  });
}

async function withZones(processZone, householdZone, fn) {
  const prevTz = process.env.TZ;
  process.env.TZ = processZone;
  tzModule.setDisplayTimeZone(householdZone);
  try {
    await fn();
  } finally {
    tzModule.setDisplayTimeZone(null);
    healthHelpers.setViewStateForTest('meds', { list: [], logsByMed: {} });
    if (prevTz === undefined) delete process.env.TZ;
    else process.env.TZ = prevTz;
  }
}

const LOGS = [
  { id: 1, status: 'taken', schedule_id: 3, scheduled_at: '2026-06-15T08:00', taken_at: '2026-06-15T08:10' },
  { id: 2, status: 'pending', schedule_id: 3, scheduled_at: '2026-06-14T20:00', taken_at: null },
  // Ohne beide Zeiten steht created_at da - ein UTC-Instant (…Z): 23:30Z ist in Berlin 01:30 am Folgetag.
  { id: 3, status: 'skipped', schedule_id: null, scheduled_at: null, taken_at: null, created_at: '2026-06-12T23:30:00Z' },
];

test('#1539: Einnahmeprotokoll zeigt die Uhrzeit des Haushalts, nicht die des Geraets', () => withZones('America/New_York', 'Europe/Berlin', () => {
  assert.equal(new Date('2026-06-15T12:00').getTimezoneOffset(), 240, 'Prozess muss in New York laufen');
  assert.deepEqual(medLogTimes(LOGS), [
    ['2026-06-15', '08:10'], ['2026-06-14', '20:00'], ['2026-06-13', '01:30'],
  ]);
}));

test('#1539: Einnahmeprotokoll mit Geraet in der Haushaltszone - Wanduhrzeit unveraendert, created_at am Tag des Haushalts', () => withZones('Europe/Berlin', 'Europe/Berlin', () => {
  assert.deepEqual(medLogTimes(LOGS), [
    ['2026-06-15', '08:10'], ['2026-06-14', '20:00'], ['2026-06-13', '01:30'],
  ]);
}));

// --------------------------------------------------------
// Einnahmetreue: EIN Zeitraum auf beiden Flaechen (Critique 2026-10-05, R16)
// --------------------------------------------------------
//
// Die Uebersicht rechnete ueber 30 Tage, die Medikamenten-Seite ueber 7 -
// dieselbe Kennzahl mit demselben Namen zeigte 21 % hier und 86 % dort. Beide
// rechnen jetzt ueber dasselbe Fenster und nennen es im Label.

test('R16: Uebersicht und Medikamenten-Seite zeigen dieselbe Einnahmetreue ueber denselben Zeitraum', async () => {
  const { mock } = await import('node:test');
  const prevTz = process.env.TZ;
  process.env.TZ = 'Europe/Berlin';
  tzModule.setDisplayTimeZone('Europe/Berlin');
  mock.timers.enable({ apis: ['Date'], now: new Date('2026-10-05T10:00:00Z') });
  // Taeglich 08:00; genommen an den sechs Tagen VOR heute, davor nichts.
  const schedule = { id: 3, medication_id: 1, time_of_day: '08:00', days_mask: null, active: 1, dose_qty: 1 };
  const logs = ['09-29', '09-30', '10-01', '10-02', '10-03', '10-04'].map((day, i) => (
    { id: i + 1, status: 'taken', schedule_id: 3, scheduled_at: `2026-${day}T08:00`, taken_at: `2026-${day}T08:05` }));
  const shared = { schedulesByMed: { 1: [schedule] }, logsByMed: { 1: logs } };
  healthHelpers.setViewStateForTest('meds', { list: [{ id: 1, name: 'Ramipril', active: 1 }], personId: 5, meId: 5, ...shared });
  healthHelpers.setViewStateForTest('overview', { meds: [{ id: 1, name: 'Ramipril', active: 1 }], ...shared });
  try {
    const page = healthHelpers.adherenceMarkup();
    const overview = healthHelpers.overviewAdherenceMarkup();
    const pagePct = page.match(/metric-card__value">(\d+)%/)?.[1];
    const overviewPct = overview.match(/health-overview__stat-value">(\d+)%/)?.[1];
    assert.equal(pagePct, '86', 'sechs von sieben');
    assert.equal(overviewPct, pagePct, 'dieselbe Kennzahl, dieselbe Zahl');
    // Der t()-Stub haengt die Werte als JSON an; esc() macht daraus &quot;.
    const days = (html, key) => html.replaceAll('&quot;', '"')
      .match(new RegExp(`${key.replaceAll('.', '\\.')}\\{"days":(\\d+)\\}`))?.[1];
    assert.equal(days(page, 'health.meds.adherence.period'), '7');
    assert.equal(days(overview, 'health.overview.adherence.period'), '7', 'das Label nennt den Zeitraum, der gilt');
  } finally {
    mock.timers.reset();
    tzModule.setDisplayTimeZone(null);
    healthHelpers.setViewStateForTest('meds', { list: [], logsByMed: {}, schedulesByMed: {} });
    healthHelpers.setViewStateForTest('overview', { meds: [], logsByMed: {}, schedulesByMed: {} });
    if (prevTz === undefined) delete process.env.TZ; else process.env.TZ = prevTz;
  }
});

// --------------------------------------------------------
// Uebersicht mobil: Kernwerte statt Wand (Critique 2026-10-05, R16)
// --------------------------------------------------------
//
// Bei 390x844 war die Gesundheit-Startseite 2711px lang: unter "Heute faellig"
// und der Bereichsliste hing die ganze Uebersicht, samt neun Vitalkacheln
// (575px) und dem CSV-Export (374px). Der Export steht jetzt im Kopf (ein
// Knopf, der den Dialog oeffnet - auch am Desktop), und mobil zeigt die
// Vitalkarte die drei juengsten Kennzahlen; ihr Titel fuehrt zu allen.

test('R16: der CSV-Export steht im Kopf, nicht mehr als Karte in der Uebersicht', async () => {
  const { installMiniDom } = await import('./mini-dom.js');
  const abraeumen = installMiniDom();
  healthHelpers.setViewStateForTest('overview', { meds: [], vitals: [], members: [], personId: 5, meId: 5, exportRange: { from: '2026-07-08', to: '2026-10-05' } });
  try {
    const grid = healthHelpers.overviewGridMarkup();
    assert.doesNotMatch(grid, /health-overview__export|health\.export\.title/, 'keine Export-Karte im Raster');
    const tools = healthHelpers.healthToolsHtml();
    assert.match(tools, /data-action="health-export"/);
    assert.match(tools, /aria-label="health\.export\.title"/, 'der Knopf nennt, was er tut');
    // Der Dialog traegt, was die Karte trug: Zeitraum und je Bereich ein Download.
    const dialog = healthHelpers.overviewExportMarkup();
    assert.match(dialog, /id="ov-export-from"[\s\S]*id="ov-export-to"/);
    assert.match(dialog, /href="\/api\/v1\/health\/export\/vitals\?user_id=5&amp;from=2026-07-08&amp;to=2026-10-05"/);
  } finally {
    healthHelpers.setViewStateForTest('overview', { meds: [], vitals: [], exportRange: { from: null, to: null } });
    abraeumen();
  }
});

test('R16: mobil bleiben zwei Vitalkennzahlen, der Titel fuehrt zu allen', async () => {
  const at = (type, value, day) => ({ id: day, type, value_num: value, value_num2: type === 'bp' ? 80 : null, value_num3: type === 'bp' ? 60 : null, unit: '', measured_at: `2026-10-0${day}T07:00` });
  const { installMiniDom } = await import('./mini-dom.js');
  const abraeumen = installMiniDom();
  healthHelpers.setViewStateForTest('overview', {
    vitals: [at('bp', 120, 1), at('weight', 70, 2), at('glucose', 95, 3), at('spo2', 98, 4), at('temp', 36.6, 5)],
  });
  try {
    const html = healthHelpers.overviewVitalsMarkup();
    const cards = [...html.matchAll(/<button type="button" class="([^"]*)" data-vital-nav="([^"]+)"/g)].map((m) => ({ cls: m[1], type: m[2] }));
    const core = cards.filter((c) => !/health-overview__vital--extra/.test(c.cls));
    assert.equal(core.length, 2, 'zwei Kernwerte: eine Reihe im zweispaltigen Raster');
    // Die zwei JUENGSTEN Messungen, nicht die ersten zwei der Metrikliste.
    assert.deepEqual(core.map((c) => c.type).sort(), ['spo2', 'temp']);
    assert.ok(cards.length > 2, 'die uebrigen stehen weiter im Baum - breit sind sie sichtbar');

    const grid = healthHelpers.overviewGridMarkup();
    assert.match(grid, /<h3 class="health-overview__card-title u-section-title"><button type="button" class="section-title-link" data-action="ov-go-vitals">/,
      'der Titel der Karte ist der Weg zu allen Werten');
  } finally {
    healthHelpers.setViewStateForTest('overview', { vitals: [] });
    abraeumen();
  }
  // Telefon: Vitalwerte, dann EINE Zeile, dahinter der Rest - im Baum in der Reihenfolge des Bilds.
  {
    const { installMiniDom } = await import('./mini-dom.js');
    const raeumen = installMiniDom();
    try {
      const phone = healthHelpers.overviewGridMarkup({ phone: true });
      const at = (needle) => { const i = phone.indexOf(needle); assert.ok(i > 0, `${needle} fehlt`); return i; };
      assert.ok(at('health.overview.vitals.title') < at('health-overview__more-toggle'), 'die Vitalwerte stehen vor der Zeile');
      assert.ok(at('health-overview__more-toggle') < at('health.overview.adherence.title</h3>'), 'die Einnahmetreue liegt dahinter');
      assert.match(phone, /health-overview__more-toggle"\s+aria-expanded="false" aria-controls="health-overview-more"/);
      assert.match(phone, /id="health-overview-more" hidden>/, 'eingeklappt beim ersten Blick');
      assert.match(phone, /health-vitals__more-names">health\.overview\.adherence\.title, health\.overview\.reminders\.title</,
        'die Zeile nennt, was hinter ihr liegt');
      const wide = healthHelpers.overviewGridMarkup({ phone: false });
      assert.doesNotMatch(wide, /health-overview__more/, 'breit gibt es keine Zeile - dort stehen alle Karten');
      assert.ok(wide.indexOf('health.overview.adherence.title') < wide.indexOf('health.overview.vitals.title'), 'und in der bisherigen Reihenfolge');
    } finally { raeumen(); }
  }
  const { eachRule } = await import('./css-rules.js');
  const css = readFileSync(new URL('../public/styles/health.css', import.meta.url), 'utf8');
  const hide = [...eachRule(css)].find((r) => /\.health-overview__vital--extra\b/.test(r.selector) && /display:\s*none/.test(r.body));
  assert.ok(hide, 'die Extras werden per CSS verborgen');
  assert.ok(hide.at.some((a) => /max-width:\s*639px/.test(a)), `nur unter der Telefon-Grenze, gefunden: ${JSON.stringify(hide.at)}`);
});
