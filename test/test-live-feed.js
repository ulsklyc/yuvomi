/**
 * Test: Live-Feed (Client), public/utils/live-feed.js
 * Zweck: Die Regeln, nach denen ein Zettel aus einem Versions-Strom eine
 *        Nachlade-Meldung macht - reine Logik gegen eine EventSource-Attrappe:
 *        die erste Antwort setzt nur Marken, jede Bewegung danach meldet die
 *        Liste, eine Wiederverbindung meldet genau die Listen, die sich in der
 *        Zwischenzeit bewegt haben, und `isLive()` haengt daran, wann zuletzt
 *        etwas GEHOERT wurde - nicht daran, ob die Verbindung offen aussieht.
 * Ausfuehren: node --test test/test-live-feed.js
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { connectLiveFeed } from '../public/utils/live-feed.js';

/** EventSource-Attrappe: merkt Listener, laesst Ereignisse von Hand ausloesen. */
class FakeEventSource {
  static instances = [];
  constructor(url) {
    this.url = url;
    this.readyState = 0;
    this.closed = false;
    this.listeners = new Map();
    FakeEventSource.instances.push(this);
  }
  addEventListener(type, fn) {
    if (!this.listeners.has(type)) this.listeners.set(type, []);
    this.listeners.get(type).push(fn);
  }
  close() { this.closed = true; this.readyState = 2; }
  open() { this.readyState = 1; this.fire('open'); }
  fire(type, data) {
    const evt = data === undefined ? {} : { data: typeof data === 'string' ? data : JSON.stringify(data) };
    for (const fn of this.listeners.get(type) ?? []) fn(evt);
  }
}

function connect(extra = {}) {
  FakeEventSource.instances.length = 0;
  const changes = [];
  const feed = connectLiveFeed({
    url: '/api/v1/shopping/feed',
    onChange: (id) => changes.push(id),
    EventSourceImpl: FakeEventSource,
    ...extra,
  });
  const source = FakeEventSource.instances[0];
  return { feed, source, changes };
}

test('die erste versions-Antwort setzt nur Marken und meldet nichts', () => {
  const { source, changes } = connect();
  source.open();
  source.fire('versions', { lists: [{ listId: 1, version: 4 }, { listId: 2, version: 9 }] });
  assert.deepEqual(changes, [], 'was beim Verbinden steht, ist der Ausgangsstand, keine Bewegung');
});

test('eine bewegte Laufnummer meldet die Liste, dieselbe Nummer noch einmal nicht', () => {
  const { source, changes } = connect();
  source.open();
  source.fire('versions', { lists: [{ listId: 1, version: 4 }] });
  source.fire('change', { listId: 1, version: 5 });
  assert.deepEqual(changes, [1]);
  source.fire('change', { listId: 1, version: 5 });
  assert.deepEqual(changes, [1], 'ein Wiederholen derselben Nummer ist keine Bewegung');
  source.fire('change', { listId: 1, version: 6 });
  assert.deepEqual(changes, [1, 1]);
});

test('eine Liste, die erst mit einem change auftaucht, wird gemerkt und erst bei der naechsten Bewegung gemeldet', () => {
  const { source, changes } = connect();
  source.open();
  source.fire('versions', { lists: [] });
  source.fire('change', { listId: 7, version: 1 });
  assert.deepEqual(changes, [], 'die erste Sichtung einer Liste ist ihr Ausgangsstand');
  source.fire('change', { listId: 7, version: 2 });
  assert.deepEqual(changes, [7]);
});

test('nach der Wiederverbindung meldet versions genau die Listen, die sich bewegt haben', () => {
  const { source, changes } = connect();
  source.open();
  source.fire('versions', { lists: [{ listId: 1, version: 4 }, { listId: 2, version: 9 }] });
  // Der Browser verbindet von selbst neu; der Server schickt den Stand erneut.
  source.fire('versions', { lists: [{ listId: 1, version: 4 }, { listId: 2, version: 11 }, { listId: 3, version: 1 }] });
  assert.deepEqual(changes, [2], 'Liste 1 stand still, Liste 3 ist neu (Ausgangsstand), nur Liste 2 hat sich bewegt');
});

test('isLive(): offen und juengst gehoert; ohne Lebenszeichen tot; ein Ping belebt', () => {
  let clock = 1_000_000;
  const { feed, source } = connect({ now: () => clock, staleAfterMs: 60_000 });
  assert.equal(feed.isLive(), false, 'vor dem Oeffnen traegt der Strom nichts');
  source.open();
  assert.equal(feed.isLive(), true);
  clock += 59_000;
  assert.equal(feed.isLive(), true);
  clock += 2_000;
  assert.equal(feed.isLive(), false, 'eine Verbindung, die OFFEN aussieht, aber nichts hoert, gilt als tot (Proxy puffert)');
  source.fire('ping', {});
  assert.equal(feed.isLive(), true, 'der Ping ist das Lebenszeichen');
});

test('das Signal schliesst die Quelle; danach traegt nichts mehr', () => {
  const ac = new AbortController();
  const { feed, source } = connect({ signal: ac.signal });
  source.open();
  assert.equal(feed.isLive(), true);
  ac.abort();
  assert.equal(source.closed, true, 'die Seite verlassen schliesst den Strom');
  assert.equal(feed.isLive(), false);
});

test('ein schon abgebrochenes Signal oeffnet gar keine Verbindung', () => {
  const ac = new AbortController();
  ac.abort();
  const { feed, source } = connect({ signal: ac.signal });
  assert.equal(source, undefined, 'kein EventSource fuer eine Seite, die schon weg ist');
  assert.equal(feed.isLive(), false);
});

test('ohne EventSource kommt ein toter Feed zurueck - die Seite faellt auf ihren Takt zurueck', () => {
  const changes = [];
  const feed = connectLiveFeed({ url: '/x', onChange: (id) => changes.push(id), EventSourceImpl: undefined });
  assert.equal(feed.isLive(), false);
  assert.doesNotThrow(() => feed.close());
});

test('kaputte oder fremde Daten werfen nicht und melden nichts', () => {
  const { source, changes } = connect();
  source.open();
  assert.doesNotThrow(() => {
    source.fire('versions', 'kein json');
    source.fire('change', '{');
    source.fire('change', { listId: 'eins', version: 2 });
    source.fire('change', { version: 2 });
    source.fire('versions', { lists: 'nicht mal eine Liste' });
  });
  assert.deepEqual(changes, []);
});
