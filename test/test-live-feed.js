/**
 * Test: Live-Feed (Client), public/utils/live-feed.js
 * Zweck: Die Regeln, nach denen ein Zettel aus den abgefragten Laufnummern
 *        eine Nachlade-Meldung macht - reine Logik gegen eine gestellte
 *        Antwort: die erste Antwort setzt nur Marken; danach meldet eine
 *        gestiegene Nummer, eine neue und eine verschwundene Liste; die
 *        Quittung eines eigenen Schreibvorgangs rueckt die Marke nur vor,
 *        wenn `before` der eigene Stand war; eine ueberholte Antwort mit
 *        kleinerer Nummer bewegt nichts; ein verborgener Tab fragt nicht;
 *        das Signal beendet den Takt.
 * Ausfuehren: node --test test/test-live-feed.js
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { startLiveFeed } from '../public/utils/live-feed.js';

const rows = (...pairs) => pairs.map(([list_id, version]) => ({ list_id, version }));

/** Ein Feed mit gestellter Antwort und einem Takt, den der Test von Hand schlaegt. */
function make({ hidden = false, signal = null } = {}) {
  const state = { answer: [], calls: 0, changes: [], ticks: [], cleared: false };
  const feed = startLiveFeed({
    fetchVersions: async () => { state.calls += 1; if (state.answer instanceof Error) throw state.answer; return state.answer; },
    onChange: (id) => state.changes.push(id),
    signal,
    intervalMs: 10_000,
    isHidden: () => hidden,
    setInterval: (fn, ms) => { state.ticks.push({ fn, ms }); return 'timer'; },
    clearInterval: (id) => { state.cleared = id; },
  });
  return { feed, state };
}

test('die erste Antwort setzt nur Marken und meldet nichts', async () => {
  const { feed, state } = make();
  state.answer = rows([1, 4], [2, 9]);
  await feed.poll();
  assert.deepEqual(state.changes, [], 'was zuerst steht, ist der Ausgangsstand');
  assert.equal(state.calls, 1);
});

test('eine gestiegene Nummer meldet die Liste, dieselbe Nummer noch einmal nicht', async () => {
  const { feed, state } = make();
  state.answer = rows([1, 4], [2, 9]);
  await feed.poll();
  state.answer = rows([1, 5], [2, 9]);
  await feed.poll();
  assert.deepEqual(state.changes, [1]);
  await feed.poll();
  assert.deepEqual(state.changes, [1], 'ein Wiederholen derselben Nummer ist keine Bewegung');
  state.answer = rows([1, 5], [2, 11]);
  await feed.poll();
  assert.deepEqual(state.changes, [1, 2]);
});

test('eine neue und eine verschwundene Liste sind Bewegungen - der Zettel zieht seine Reiter nach', async () => {
  const { feed, state } = make();
  state.answer = rows([1, 0]);
  await feed.poll();
  state.answer = rows([1, 0], [7, 0]);
  await feed.poll();
  assert.deepEqual(state.changes, [7], 'eine Liste, die jemand anderes angelegt hat');
  state.answer = rows([7, 0]);
  await feed.poll();
  assert.deepEqual(state.changes, [7, 1], 'eine Liste, die jemand anderes geloescht hat');
});

test('acknowledge: die Quittung des eigenen Schreibvorgangs rueckt die Marke vor - die naechste Abfrage laedt nicht umsonst', async () => {
  const { feed, state } = make();
  state.answer = rows([1, 4]);
  await feed.poll();
  feed.acknowledge({ list_id: 1, before: 4, after: 6 });
  state.answer = rows([1, 6]);
  await feed.poll();
  assert.deepEqual(state.changes, [], 'alles zwischen 4 und 6 war das eigene Werk');
});

test('acknowledge: stimmt `before` nicht, hat jemand anderes dazwischen geschrieben - die Marke bleibt, die Abfrage meldet', async () => {
  const { feed, state } = make();
  state.answer = rows([1, 4]);
  await feed.poll();
  // Ein anderes Geraet hat 4 -> 5 bewegt, dann kam der eigene Haken: 5 -> 7.
  feed.acknowledge({ list_id: 1, before: 5, after: 7 });
  state.answer = rows([1, 7]);
  await feed.poll();
  assert.deepEqual(state.changes, [1], 'die fremde Aenderung darf nicht hinter der eigenen Quittung verschwinden');
});

test('acknowledge vor der ersten Antwort oder mit unbrauchbarer Quittung tut nichts', async () => {
  const { feed, state } = make();
  assert.doesNotThrow(() => {
    feed.acknowledge({ list_id: 1, before: 0, after: 1 });
    feed.acknowledge(null);
    feed.acknowledge({ list_id: 'eins', before: 0, after: 1 });
  });
  state.answer = rows([1, 1]);
  await feed.poll();
  state.answer = rows([1, 2]);
  await feed.poll();
  assert.deepEqual(state.changes, [1]);
});

test('eine ueberholte Antwort mit kleinerer Nummer bewegt nichts und senkt die Marke nicht', async () => {
  const { feed, state } = make();
  state.answer = rows([1, 4]);
  await feed.poll();
  feed.acknowledge({ list_id: 1, before: 4, after: 6 });
  // Diese Antwort war unterwegs, als die Quittung die Marke auf 6 rueckte.
  state.answer = rows([1, 4]);
  await feed.poll();
  assert.deepEqual(state.changes, []);
  state.answer = rows([1, 6]);
  await feed.poll();
  assert.deepEqual(state.changes, [], 'die Marke steht weiter auf 6');
});

test('eine gescheiterte Abfrage bleibt still, und die naechste vergleicht weiter gegen die alte Marke', async () => {
  const { feed, state } = make();
  state.answer = rows([1, 4]);
  await feed.poll();
  state.answer = new Error('500');
  await assert.doesNotReject(() => feed.poll());
  state.answer = rows([1, 5]);
  await feed.poll();
  assert.deepEqual(state.changes, [1]);
});

test('zwei Abfragen zugleich sind eine', async () => {
  const { feed, state } = make();
  state.answer = rows([1, 4]);
  await Promise.all([feed.poll(), feed.poll()]);
  assert.equal(state.calls, 1);
});

test('der Takt fragt nur, solange der Tab sichtbar ist', async () => {
  const shown = make();
  shown.state.answer = rows([1, 4]);
  assert.equal(shown.state.ticks[0].ms, 10_000);
  shown.state.ticks[0].fn();
  await Promise.resolve(); await Promise.resolve(); await Promise.resolve();
  assert.equal(shown.state.calls, 1, 'sichtbar: der Takt fragt');

  const hidden = make({ hidden: true });
  hidden.state.ticks[0].fn();
  await Promise.resolve(); await Promise.resolve(); await Promise.resolve();
  assert.equal(hidden.state.calls, 0, 'verborgen: der Takt schweigt');
});

test('das Signal beendet den Takt, und ein schon abgebrochenes Signal startet keinen', async () => {
  const ac = new AbortController();
  const { feed, state } = make({ signal: ac.signal });
  ac.abort();
  assert.equal(state.cleared, 'timer', 'die Seite verlassen raeumt den Takt ab');
  state.answer = rows([1, 4]);
  await feed.poll();
  assert.equal(state.calls, 0, 'nach dem Ende fragt nichts mehr');

  const dead = new AbortController();
  dead.abort();
  const late = make({ signal: dead.signal });
  assert.equal(late.state.ticks.length, 0, 'kein Takt fuer eine Seite, die schon weg ist');
});

test('kaputte oder fremde Antworten werfen nicht und melden nichts', async () => {
  const { feed, state } = make();
  state.answer = rows([1, 4]);
  await feed.poll();
  for (const bad of ['kein array', null, [{ list_id: 'eins', version: 2 }], [{ version: 2 }], [{ list_id: 1 }]]) {
    state.answer = bad;
    await assert.doesNotReject(() => feed.poll());
  }
  // Nach lauter unbrauchbaren Antworten steht Liste 1 als "weg" - eine
  // leere Antwort IST die Nachricht, dass es keine Listen mehr gibt.
  assert.deepEqual(state.changes, [1]);
});
