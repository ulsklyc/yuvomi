/**
 * Modul: Spalten für sich überlappende Termine (#1633)
 * Zweck: Die Platzierung nach Person als reine Funktion - wer in Tages- und
 *        Wochenansicht neben wem steht. Erwartungswerte sind von Hand
 *        gerechnet, nicht aus der Funktion abgelesen.
 * Ausfuehren: node --test test/test-overlap-lanes.js
 * Dependencies: public/utils/overlap-lanes.js
 *
 * Die Verdrahtung (woher der Kalender Rang und Personen nimmt, und dass
 * Schichtplan-Blöcke die alte Packung behalten) misst test-calendar.js am
 * Aufrufer `layoutOverlaps()`.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  assignLanes,
  assignLanesByPerson,
  memberRank,
  overlapGroups,
} from '../public/utils/overlap-lanes.js';

// Drei Mitglieder in der Reihenfolge der Liste. Die IDs laufen bewusst GEGEN
// die Reihenfolge und die Namen gegen beide: wer heimlich nach ID oder Name
// sortiert, fällt hier auf.
const ANNA = 30;   // Rang 0
const BEN = 20;    // Rang 1
const CLEO = 10;   // Rang 2
const MEMBERS = [
  { id: ANNA, display_name: 'Zora' },
  { id: BEN, display_name: 'Mika' },
  { id: CLEO, display_name: 'Adam' },
];

let nextId = 1;
/** Zeiten als "9:30" -> Minuten seit Mitternacht. */
function at(text) {
  const [h, m = '0'] = text.split(':');
  return Number(h) * 60 + Number(m);
}
function ev(start, end, people = [], id = nextId++) {
  return { id, start: at(start), end: at(end), people };
}

function place(items, members = MEMBERS) {
  return assignLanesByPerson(items, {
    rangeFn: (item) => ({ start: item.start, end: item.end }),
    peopleFn: (item) => item.people,
    rank: memberRank(members),
  });
}
/** Platz eines Eintrags als "Spalte/Breite". */
function spot(layout, item) {
  const entry = layout.get(item);
  return entry ? `${entry.colIndex}/${entry.totalCols}` : 'fehlt';
}

function permutations(list) {
  if (list.length <= 1) return [list];
  return list.flatMap((item, i) =>
    permutations([...list.slice(0, i), ...list.slice(i + 1)]).map((rest) => [item, ...rest]));
}

test('dieselben Personen behalten ihre Position, egal wer zuerst beginnt', () => {
  // Tag 1: Anna beginnt vor Ben. Tag 2: Ben beginnt vor Anna.
  const annaFrueh = ev('9', '10', [ANNA]);
  const benSpaet = ev('9:30', '10:30', [BEN]);
  const tag1 = place([annaFrueh, benSpaet]);
  assert.equal(spot(tag1, annaFrueh), '0/2');
  assert.equal(spot(tag1, benSpaet), '1/2');

  const benFrueh = ev('9', '10', [BEN]);
  const annaSpaet = ev('9:30', '10:30', [ANNA]);
  const tag2 = place([benFrueh, annaSpaet]);
  assert.equal(spot(tag2, annaSpaet), '0/2', 'Anna bleibt links, obwohl Ben zuerst beginnt');
  assert.equal(spot(tag2, benFrueh), '1/2');
});

test('gleiche Slots stehen in der Reihenfolge der Mitgliederliste', () => {
  const cleo = ev('9', '10', [CLEO]);
  const anna = ev('9', '10', [ANNA]);
  const ben = ev('9', '10', [BEN]);
  const layout = place([cleo, anna, ben]);
  assert.equal(spot(layout, anna), '0/3');
  assert.equal(spot(layout, ben), '1/3');
  assert.equal(spot(layout, cleo), '2/3');
});

test('ein einzelner Termin hat eine Spalte und die volle Breite', () => {
  const allein = ev('9', '10', [CLEO]);
  assert.equal(spot(place([allein]), allein), '0/1');

  // Zwei, die sich nur berühren, überlappen nicht (hälfte-offen): jeder für sich.
  const vorher = ev('9', '10', [CLEO]);
  const nachher = ev('10', '11', [ANNA]);
  const layout = place([vorher, nachher]);
  assert.equal(spot(layout, vorher), '0/1');
  assert.equal(spot(layout, nachher), '0/1');
});

test('keine reservierte Spur für Personen, die in der Gruppe nicht vorkommen', () => {
  // Anna (Rang 0) hat an diesem Tag einen Termin, aber nicht in dieser Gruppe.
  const annaMorgens = ev('7', '8', [ANNA]);
  const ben = ev('9', '10', [BEN]);
  const cleo = ev('9', '10', [CLEO]);
  const layout = place([cleo, annaMorgens, ben]);
  assert.equal(spot(layout, annaMorgens), '0/1');
  assert.equal(spot(layout, ben), '0/2', 'Ben rückt auf die erste Position, Annas Spalte bleibt nicht frei');
  assert.equal(spot(layout, cleo), '1/2');
});

test('mehrere Zuständige: es zählt die erste Person in der Mitgliederliste, nicht die erste im Termin', () => {
  // Cleo steht im Termin vorn, Anna hat den kleineren Rang.
  const beide = ev('9', '10', [CLEO, ANNA]);
  const ben = ev('9', '10', [BEN]);
  const layout = place([ben, beide]);
  assert.equal(spot(layout, beide), '0/2', 'als Annas Termin platziert');
  assert.equal(spot(layout, ben), '1/2');

  // Derselbe Termin teilt sich Annas Spalte mit ihrem nächsten, statt eine eigene zu öffnen.
  const lang = ev('9', '12', [BEN]);
  const gemeinsam = ev('9', '10', [CLEO, ANNA]);
  const annaAllein = ev('11', '12', [ANNA]);
  const zwei = place([lang, annaAllein, gemeinsam]);
  assert.equal(spot(zwei, gemeinsam), '0/2');
  assert.equal(spot(zwei, annaAllein), '0/2');
  assert.equal(spot(zwei, lang), '1/2');
});

test('ein Termin ohne Person kommt zuletzt', () => {
  // Er beginnt als Erster und stand deshalb bisher links.
  const ohne = ev('8', '10', []);
  const cleo = ev('9', '10', [CLEO]);
  const anna = ev('9:30', '10:30', [ANNA]);
  const layout = place([ohne, cleo, anna]);
  assert.equal(spot(layout, anna), '0/3');
  assert.equal(spot(layout, cleo), '1/3');
  assert.equal(spot(layout, ohne), '2/3');
});

test('zwei überlappende Termine derselben Person stehen nebeneinander', () => {
  // Nach Zeit gepackt schob sich Ben zwischen Annas zwei Termine.
  const anna1 = ev('9', '11', [ANNA]);
  const ben = ev('9:15', '10', [BEN]);
  const anna2 = ev('9:30', '10:30', [ANNA]);
  const layout = place([anna1, ben, anna2]);
  assert.equal(spot(layout, anna1), '0/3');
  assert.equal(spot(layout, anna2), '1/3');
  assert.equal(spot(layout, ben), '2/3');

  // Drei gleichzeitig: drei Spalten nebeneinander, erst danach Cleo.
  const a = ev('13', '15', [BEN], 501);
  const b = ev('13', '15', [BEN], 502);
  const c = ev('13', '15', [BEN], 503);
  const cleo = ev('13', '14', [CLEO]);
  const drei = place([cleo, c, a, b]);
  assert.equal(spot(drei, a), '0/4');
  assert.equal(spot(drei, b), '1/4');
  assert.equal(spot(drei, c), '2/4');
  assert.equal(spot(drei, cleo), '3/4');
});

test('eine Person, deren Termine sich nicht überlappen, behält in der Gruppe EINE Spalte', () => {
  const annaFrueh = ev('9', '10', [ANNA]);
  const benLang = ev('9', '12', [BEN]);
  const annaSpaet = ev('11', '12', [ANNA]);
  const layout = place([benLang, annaSpaet, annaFrueh]);
  assert.equal(spot(layout, annaFrueh), '0/2');
  assert.equal(spot(layout, annaSpaet), '0/2');
  assert.equal(spot(layout, benLang), '1/2');
});

test('der bekannte Preis: die Kette aus dem Issue ist drei breit statt zwei', () => {
  const a = ev('9', '10', [ANNA]);
  const b = ev('9:30', '11', [BEN]);
  const c = ev('10:30', '12', [CLEO]);
  const layout = place([a, b, c]);
  assert.equal(spot(layout, a), '0/3');
  assert.equal(spot(layout, b), '1/3');
  assert.equal(spot(layout, c), '2/3', 'Cleo darf Annas frei gewordenen Platz nicht nehmen');

  // Dieselbe Kette nach Zeit gepackt bleibt zwei breit - das ist die Packung,
  // die Schichtplan-Blöcke behalten.
  const byTime = assignLanes([a, b, c], (item) => ({ start: item.start, end: item.end }), (item) => item);
  assert.deepEqual([a, b, c].map((item) => spot(byTime, item)), ['0/2', '1/2', '0/2']);
});

test('die Ladereihenfolge ändert nichts am Ergebnis', () => {
  const items = [
    ev('9', '10', [BEN], 11),
    ev('9', '10', [BEN], 12),       // gleicher Slot, gleiche Person: nur die ID trennt sie
    ev('9', '10', [ANNA], 13),
    ev('9', '10', [], 14),
    ev('9:30', '11', [CLEO, BEN], 15), // zählt als Ben
  ];
  // Von Hand: Anna 0; Ben belegt 1 und 2 (11 vor 12 über die ID) und für den
  // dritten gleichzeitigen (15, beginnt später) Spalte 3; ohne Person 4.
  const expected = { 13: '0/5', 11: '1/5', 12: '2/5', 15: '3/5', 14: '4/5' };
  const all = permutations(items);
  assert.equal(all.length, 120);
  for (const order of all) {
    const layout = place(order);
    const got = Object.fromEntries(items.map((item) => [item.id, spot(layout, item)]));
    assert.deepEqual(got, expected, `Reihenfolge ${order.map((item) => item.id).join(',')}`);
  }
});

test('eine Person, die nicht in der Mitgliederliste steht: nach allen Mitgliedern, vor "ohne Person"', () => {
  const fremd99 = ev('9', '10', [99]);
  const ohne = ev('9', '10', []);
  const fremd50 = ev('9', '10', [50]);
  const cleo = ev('9', '10', [CLEO]);
  const layout = place([fremd99, ohne, fremd50, cleo]);
  assert.equal(spot(layout, cleo), '0/4', 'das Mitglied mit dem letzten Rang steht trotzdem vor jeder unbekannten Person');
  assert.equal(spot(layout, fremd50), '1/4', 'unbekannte Personen untereinander nach ID');
  assert.equal(spot(layout, fremd99), '2/4');
  assert.equal(spot(layout, ohne), '3/4');

  // Unbekannt neben bekannt in EINEM Termin: das Mitglied zählt.
  const gemischt = ev('14', '15', [5, CLEO]);
  const ben = ev('14', '15', [BEN]);
  const fremd5 = ev('14', '15', [5]);
  const zwei = place([fremd5, gemischt, ben]);
  assert.equal(spot(zwei, ben), '0/3');
  assert.equal(spot(zwei, gemischt), '1/3');
  assert.equal(spot(zwei, fremd5), '2/3');

  // Eine leere Mitgliederliste (Laden fehlgeschlagen) ist kein Sonderfall:
  // alle sind unbekannt und stehen nach ID, ohne Person bleibt hinten.
  const leer = place([fremd99, ohne, fremd50, cleo], []);
  assert.equal(spot(leer, cleo), '0/4');
  assert.equal(spot(leer, fremd50), '1/4');
  assert.equal(spot(leer, fremd99), '2/4');
  assert.equal(spot(leer, ohne), '3/4');
});

test('der Rang ist die Eingabe: umgedrehte Mitgliederliste, umgedrehte Positionen', () => {
  const anna = ev('9', '10', [ANNA]);
  const ben = ev('9', '10', [BEN]);
  const cleo = ev('9', '10', [CLEO]);
  const ohne = ev('9', '10', []);
  const vor = place([anna, ben, cleo, ohne], MEMBERS);
  assert.deepEqual([anna, ben, cleo, ohne].map((item) => spot(vor, item)), ['0/4', '1/4', '2/4', '3/4']);

  const zurueck = place([anna, ben, cleo, ohne], [...MEMBERS].reverse());
  assert.deepEqual([anna, ben, cleo, ohne].map((item) => spot(zurueck, item)), ['2/4', '1/4', '0/4', '3/4'],
    'die Mitglieder drehen sich um, "ohne Person" bleibt hinten');
});

test('memberRank: Position in der Liste, wie sie kommt - weder nach ID noch nach Name', () => {
  const rank = memberRank(MEMBERS);
  assert.deepEqual([...rank.entries()], [['30', 0], ['20', 1], ['10', 2]]);
  // Eine ID als Text und als Zahl ist dieselbe Person.
  const text = ev('9', '10', [String(BEN)]);
  const zahl = ev('9', '10', [CLEO]);
  const layout = place([zahl, text]);
  assert.equal(spot(layout, text), '0/2');
  assert.equal(spot(layout, zahl), '1/2');
  assert.equal(memberRank(null).size, 0);
  assert.equal(memberRank(undefined).size, 0);
});

test('overlapGroups: die Gruppe ist die transitive Hülle, Berühren ist kein Überlappen', () => {
  const a = ev('9', '10');
  const b = ev('9:30', '11');
  const c = ev('10:30', '12');
  const d = ev('12', '13');
  const groups = overlapGroups([d, c, a, b], (item) => ({ start: item.start, end: item.end }));
  assert.deepEqual(groups.map((group) => group.map((item) => item.id)), [[a.id, b.id, c.id], [d.id]]);
});
