/**
 * Modul: Gesundheits-CSV-Export-Test
 * Zweck: Reine Serialisierung aus server/services/health-export.js — CSV-Quoting
 *        inklusive Formel-Injection-Schutz, Header/Spaltenbreiten-Kopplung über
 *        HEALTH_EXPORT_HEADERS und die Zeilenaufbau-Regeln je Bereich (Labor-Fan-out,
 *        Medikamenten-Spaltenname, Zyklus-Längenberechnung). DB-frei, DOM-frei.
 * Ausführen: node --test test/test-health-export.js
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import {
  csvCell, toCsv, HEALTH_EXPORT_HEADERS,
  vitalsToCsv, activitiesToCsv, labsToCsv, medLogsToCsv, cycleToCsv,
} from '../server/services/health-export.js';

/**
 * Zerlegt eine CSV-Zeile in ihre Felder. Jede Zelle ist gequotet, doppelte
 * Anführungszeichen sind verdoppelt — ein naives split(',') zerbricht an Werten
 * mit Komma, deshalb hier über die Quoting-Grammatik.
 */
function splitCsvLine(line) {
  return [...line.matchAll(/"((?:[^"]|"")*)"/g)].map((m) => m[1].replace(/""/g, '"'));
}

const lines = (csv) => csv.split('\n');

// --------------------------------------------------------
// Zell-Serialisierung
// --------------------------------------------------------

test('csvCell: quotet immer und verdoppelt innere Anführungszeichen', () => {
  assert.equal(csvCell('abc'), '"abc"');
  assert.equal(csvCell('mit "Zitat"'), '"mit ""Zitat"""');
  assert.equal(csvCell('Komma, drin'), '"Komma, drin"');
  assert.equal(csvCell(42), '"42"');
  assert.equal(csvCell(0), '"0"');
  assert.equal(csvCell(null), '""');
  assert.equal(csvCell(undefined), '""');
});

// CSV-Injection: Tabellenkalkulationen werten führende =,+,-,@ als Formel aus.
// Ein Notizfeld ist Nutzereingabe, also muss die Entschärfung hier greifen.
test('csvCell: entschärft Formel-Injection mit führendem Apostroph', () => {
  for (const prefix of ['=', '+', '-', '@', '\t', '\r']) {
    assert.equal(csvCell(`${prefix}CMD()`), `"'${prefix}CMD()"`,
      `Präfix ${JSON.stringify(prefix)} wurde nicht entschärft`);
  }
  // Nur am Zeilenanfang, nicht mitten im Text.
  assert.equal(csvCell('7-9'), '"7-9"');
  assert.equal(csvCell('a=b'), '"a=b"');
});

test('toCsv: ohne Zeilen nur der Header, kein abschließender Zeilenumbruch', () => {
  assert.equal(toCsv(['a', 'b'], []), '"a","b"');
  assert.equal(toCsv(['a', 'b'], null), '"a","b"');
  assert.equal(toCsv(['a', 'b'], [[1, 2]]), '"a","b"\n"1","2"');
  assert.ok(!toCsv(['a'], [[1]]).endsWith('\n'));
});

// --------------------------------------------------------
// Header-Kopplung
// --------------------------------------------------------

// Jeder Serialisierer baut seine Zeilen anders auf: vitals/activities mappen über
// die Header-Schlüssel, labs/medLogs/cycle schreiben die Spalten von Hand aus. Nur
// bei den handgeschriebenen kann eine Header-Änderung stillschweigend auseinander-
// laufen — genau dafür ist HEALTH_EXPORT_HEADERS der gemeinsame Bezugspunkt.
const CASES = [
  {
    key: 'vitals',
    run: (h) => vitalsToCsv([Object.fromEntries(h.map((k, i) => [k, `v${i}`]))]),
  },
  {
    key: 'activities',
    run: (h) => activitiesToCsv([Object.fromEntries(h.map((k, i) => [k, `a${i}`]))]),
  },
  {
    key: 'labs',
    run: () => labsToCsv([{
      report_date: '2026-01-05', lab_name: 'Praxis', visibility: 'private', note: 'n',
      results: [{ analyte: 'Hb', value_num: 13.5, unit: 'g/dl', ref_low: 12, ref_high: 16, flag: 'normal' }],
    }]),
  },
  {
    key: 'medLogs',
    run: () => medLogsToCsv([{
      scheduled_at: '2026-01-05T08:00:00Z', medication_name: 'Ibu', status: 'taken',
      taken_at: '2026-01-05T08:05:00Z', dose_qty: 1, note: 'n',
    }]),
  },
  {
    key: 'cycle',
    run: () => cycleToCsv([{ start_date: '2026-01-01', end_date: '2026-01-05', note: 'n', visibility: 'private' }]),
  },
];

test('jede Export-Zeile hat exakt so viele Spalten wie ihr Header', () => {
  for (const { key, run } of CASES) {
    const header = HEALTH_EXPORT_HEADERS[key];
    assert.ok(Array.isArray(header), `HEALTH_EXPORT_HEADERS.${key} fehlt`);
    const rows = lines(run(header));
    assert.deepEqual(splitCsvLine(rows[0]), header, `${key}: Kopfzeile weicht ab`);
    for (const [i, row] of rows.slice(1).entries()) {
      assert.equal(splitCsvLine(row).length, header.length,
        `${key}: Datenzeile ${i + 1} hat abweichende Spaltenzahl`);
    }
  }
});

test('HEALTH_EXPORT_HEADERS: eingefroren, sprachneutrale Maschinen-Header', () => {
  assert.ok(Object.isFrozen(HEALTH_EXPORT_HEADERS));
  assert.deepEqual(Object.keys(HEALTH_EXPORT_HEADERS).sort(),
    ['activities', 'cycle', 'labs', 'medLogs', 'nutrition', 'vitals']);
  for (const [key, header] of Object.entries(HEALTH_EXPORT_HEADERS)) {
    assert.ok(header.length > 0, `${key}: leerer Header`);
    assert.equal(new Set(header).size, header.length, `${key}: doppelte Spaltennamen`);
    for (const col of header) {
      assert.match(col, /^[a-z0-9_]+$/, `${key}: "${col}" ist kein sprachneutraler Header`);
    }
  }
});

// --------------------------------------------------------
// Zeilenaufbau je Bereich
// --------------------------------------------------------

test('vitalsToCsv/activitiesToCsv: leere Eingabe liefert nur den Header', () => {
  assert.equal(lines(vitalsToCsv([])).length, 1);
  assert.equal(lines(activitiesToCsv(null)).length, 1);
});

test('labsToCsv: ein Befund wird pro Analyt zu einer Zeile', () => {
  const csv = labsToCsv([{
    report_date: '2026-01-05', lab_name: 'Praxis', visibility: 'private', note: 'Kontrolle',
    results: [
      { analyte: 'Hb', value_num: 13.5, unit: 'g/dl', ref_low: 12, ref_high: 16, flag: 'normal' },
      { analyte: 'Ferritin', value_num: 8, unit: 'ng/ml', ref_low: 15, ref_high: 150, flag: 'low' },
    ],
  }]);
  const rows = lines(csv);
  assert.equal(rows.length, 3);
  const first = splitCsvLine(rows[1]);
  const second = splitCsvLine(rows[2]);
  assert.equal(first[HEALTH_EXPORT_HEADERS.labs.indexOf('analyte')], 'Hb');
  assert.equal(second[HEALTH_EXPORT_HEADERS.labs.indexOf('analyte')], 'Ferritin');
  // Befund-Kopf wird je Analyt wiederholt, damit jede Zeile für sich lesbar ist.
  assert.equal(first[HEALTH_EXPORT_HEADERS.labs.indexOf('lab_name')], 'Praxis');
  assert.equal(second[HEALTH_EXPORT_HEADERS.labs.indexOf('lab_name')], 'Praxis');
});

test('labsToCsv: Befund ohne Analyten bleibt als Kopfzeile erhalten', () => {
  const csv = labsToCsv([{ report_date: '2026-01-05', lab_name: 'Praxis', visibility: 'all', note: 'ohne Werte' }]);
  const rows = lines(csv);
  assert.equal(rows.length, 2);
  const cells = splitCsvLine(rows[1]);
  assert.equal(cells[HEALTH_EXPORT_HEADERS.labs.indexOf('analyte')], '');
  assert.equal(cells[HEALTH_EXPORT_HEADERS.labs.indexOf('report_date')], '2026-01-05');
});

test('medLogsToCsv: medication_name landet in der Spalte medication', () => {
  const csv = medLogsToCsv([{
    scheduled_at: '2026-01-05T08:00:00Z', medication_name: 'Ibuprofen', status: 'taken',
    taken_at: '2026-01-05T08:05:00Z', dose_qty: 1, note: '',
  }]);
  const cells = splitCsvLine(lines(csv)[1]);
  assert.equal(cells[HEALTH_EXPORT_HEADERS.medLogs.indexOf('medication')], 'Ibuprofen');
  assert.equal(cells[HEALTH_EXPORT_HEADERS.medLogs.indexOf('status')], 'taken');
});

// Periodenlänge zählt beide Randtage mit (01.-05. = 5 Tage), Zykluslänge ist der
// Abstand zum nächsten Start (01.01. -> 29.01. = 28). Die jüngste Periode hat keine
// Folge-Periode und bleibt in der Zykluslänge leer.
test('cycleToCsv: Periodenlänge inklusiv, Zykluslänge bis zum nächsten Start', () => {
  const csv = cycleToCsv([
    { start_date: '2026-01-01', end_date: '2026-01-05', note: '', visibility: 'private' },
    { start_date: '2026-01-29', end_date: '2026-02-02', note: '', visibility: 'private' },
  ]);
  const H = HEALTH_EXPORT_HEADERS.cycle;
  const rows = lines(csv).slice(1).map(splitCsvLine);
  assert.equal(rows[0][H.indexOf('period_length_days')], '5');
  assert.equal(rows[0][H.indexOf('cycle_length_days')], '28');
  assert.equal(rows[1][H.indexOf('period_length_days')], '5');
  assert.equal(rows[1][H.indexOf('cycle_length_days')], '');
});

test('cycleToCsv: laufende Periode ohne Enddatum lässt die Längenspalten leer', () => {
  const csv = cycleToCsv([{ start_date: '2026-01-01', end_date: null, note: '', visibility: 'private' }]);
  const H = HEALTH_EXPORT_HEADERS.cycle;
  const cells = splitCsvLine(lines(csv)[1]);
  assert.equal(cells[H.indexOf('end_date')], '');
  assert.equal(cells[H.indexOf('period_length_days')], '');
});
