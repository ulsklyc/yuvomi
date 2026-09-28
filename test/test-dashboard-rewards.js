/**
 * Modul: Belohnungen-Widget der Uebersicht (Critique 2026-09-23, Persona Emma)
 * Zweck: Das Widget zeigte jedem Betrachter eine Rangliste der Geschwister
 *        ("1 Leo 60 / 2 Emma 30"). Aus Sicht eines neunjaehrigen Kindes ist
 *        das Wettbewerb statt Fortschritt. Diese Suite haelt die drei Sichten
 *        fest, die das Widget seitdem kennt:
 *          - wer freigeben darf (dieselbe Rolle, die das Modul fuer
 *            "Bestaetigen/Ablehnen" fragt: isAdminRequest), sieht jedes
 *            teilnehmende Kind nebeneinander, ohne Platz, plus die offenen
 *            Freigaben;
 *          - wer selbst Punkte sammelt und nicht freigibt, sieht NUR sich:
 *            Stand, Fortschritt zur naechsten Praemie, zuletzt Verdientes;
 *          - wer weder das eine noch das andere ist (Wandtablett, Grosseltern
 *            ohne Teilnahme), sieht die Familie ohne Platz und ohne Freigaben.
 *        Server (Auswahl der Daten) und Renderer (was davon erscheint) werden
 *        getrennt geprueft: ein Renderer, der nur die eigene Zeile zeigt,
 *        waehrend die Antwort alle Kinder mitliefert, waere eine Rangliste im
 *        Netzwerk-Tab.
 * Ausfuehren: node --experimental-sqlite --test test/test-dashboard-rewards.js
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { register } from 'node:module';
import express from 'express';

process.env.DB_PATH = ':memory:';
process.env.SESSION_SECRET = process.env.SESSION_SECRET || 'dashboard-rewards-test-secret';

register('./test-browser-loader.mjs', import.meta.url);

const { get } = await import('../server/db.js');
const { default: dashboardRouter } = await import('../server/routes/dashboard.js');
const { __test } = await import('../public/pages/dashboard.js');
const { selectMetricTiles } = __test;
// Die Stub-Uebersetzung liefert `key{"a":1}`; im Markup steht das durch esc()
// als `&quot;`. Gelesen wird der Text, den ein Mensch saehe.
const renderRewardsWidget = (...args) => __test.renderRewardsWidget(...args)
  .replace(/&quot;/g, '"').replace(/&amp;/g, '&');

// --------------------------------------------------------------------------
// Server: welche Daten gehen an wen
// --------------------------------------------------------------------------

const d = get();

function user(username, displayName, role) {
  return d.prepare(`
    INSERT INTO users (username, display_name, password_hash, avatar_color, role)
    VALUES (?, ?, 'x', '#34C759', ?)
  `).run(username, displayName, role).lastInsertRowid;
}

const PARENT = user('rw-parent', 'Linda', 'admin');
const EMMA = user('rw-emma', 'Emma', 'member');
const LEO = user('rw-leo', 'Leo', 'member');
const OMA = user('rw-oma', 'Oma Erna', 'member');

for (const uid of [EMMA, LEO]) {
  d.prepare('INSERT INTO reward_participants (user_id, enabled) VALUES (?, 1)').run(uid);
}
d.prepare("INSERT INTO reward_ledger (user_id, delta, type, reason, created_at) VALUES (?, 20, 'earn', 'Zimmer aufraeumen', '2026-09-20T08:00:00Z')").run(EMMA);
d.prepare("INSERT INTO reward_ledger (user_id, delta, type, reason, created_at) VALUES (?, 10, 'bonus', NULL, '2026-09-21T08:00:00Z')").run(EMMA);
d.prepare("INSERT INTO reward_ledger (user_id, delta, type, reason, created_at) VALUES (?, 60, 'earn', 'Rasen maehen', '2026-09-21T09:00:00Z')").run(LEO);
d.prepare("INSERT INTO reward_catalog (name, cost, is_active) VALUES ('Kinoabend', 45, 1)").run();
d.prepare("INSERT INTO reward_catalog (name, cost, is_active) VALUES ('Alter Gutschein', 5, 0)").run();
d.prepare("INSERT INTO reward_redemptions (user_id, reward_name, cost, status) VALUES (?, 'Eis', 10, 'pending')").run(LEO);
d.prepare("INSERT INTO reward_redemptions (user_id, reward_name, cost, status) VALUES (?, 'Eis', 10, 'pending')").run(EMMA);

async function dashboardAs(userId, authRole) {
  const app = express();
  app.use((req, _res, next) => {
    req.authUserId = userId;
    req.authRole = authRole;
    req.session = { userId };
    next();
  });
  app.use('/', dashboardRouter);
  const server = app.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  try {
    return await (await fetch(`http://127.0.0.1:${server.address().port}/`)).json();
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

test('Server: ein Kind bekommt nur die eigene Zeile, eigene Anfragen und eigene Buchungen', async () => {
  const body = await dashboardAs(EMMA, 'member');
  const r = body.rewards;
  assert.equal(r.view, 'self', 'ein teilnehmendes Kind ohne Freigaberecht sieht die eigene Sicht');
  assert.deepEqual(r.standings.map((s) => s.id), [EMMA], 'die Geschwister gehen gar nicht erst ueber die Leitung');
  assert.equal(r.standings[0].balance, 30);
  assert.ok(!('rank' in r.standings[0]), 'eine Platzierung gibt es nicht');
  assert.equal(r.pending, 1, 'gezaehlt wird die EIGENE offene Anfrage, nicht die des Bruders');
  assert.deepEqual(r.recent.map((row) => row.delta), [10, 20], 'zuletzt verdient: nur eigene Gutschriften, neueste zuerst');
  assert.deepEqual(r.catalog.map((c) => c.name), ['Kinoabend'], 'nur einloesbare Praemien sind ein Ziel');
});

test('Server: wer freigeben darf, sieht jedes Kind alphabetisch, ohne Rang, mit allen offenen Freigaben', async () => {
  const body = await dashboardAs(PARENT, 'admin');
  const r = body.rewards;
  assert.equal(r.view, 'approver');
  assert.deepEqual(r.standings.map((s) => s.display_name), ['Emma', 'Leo'],
    'nach Namen, nicht nach Punkten - Leo hat mehr und steht trotzdem nicht vorn');
  assert.ok(r.standings.every((s) => !('rank' in s)));
  assert.equal(r.pending, 2);
  assert.deepEqual(r.recent, [], 'die eigene Buchungsliste gehoert nur der eigenen Sicht');
});

test('Server: wer weder sammelt noch freigibt, sieht die Familie, aber keine fremden Anfragen', async () => {
  const body = await dashboardAs(OMA, 'member');
  const r = body.rewards;
  assert.equal(r.view, 'family');
  assert.deepEqual(r.standings.map((s) => s.display_name), ['Emma', 'Leo']);
  assert.equal(r.pending, 0, 'offene Anfragen anderer sind Sache der Eltern');
});

// --------------------------------------------------------------------------
// Renderer: was davon erscheint
// --------------------------------------------------------------------------

const KINO = { id: 1, name: 'Kinoabend', cost: 60, remaining: null };
const EIS = { id: 2, name: 'Eis', cost: 20, remaining: null };

const emma = (balance) => ({ id: 7, display_name: 'Emma', avatar_color: '#34C759', balance });
const leo = (balance) => ({ id: 8, display_name: 'Leo', avatar_color: '#FF9500', balance });

function progressValue(html) {
  const m = /role="progressbar"[^>]*aria-valuenow="(\d+)"/.exec(html);
  return m ? Number(m[1]) : null;
}

test('Kind: sieht den eigenen Stand und keine Geschwister, keine Plaetze', () => {
  const html = renderRewardsWidget({
    view: 'self', me: 7, standings: [emma(45), leo(60)], catalog: [KINO],
    recent: [{ delta: 10, reason: 'Zimmer', type: 'earn', created_at: '2026-09-21T08:00:00Z' }],
  }, '1x2');
  assert.doesNotMatch(html, /Leo/, 'ein Geschwisterkind taucht in der Kind-Sicht nicht auf');
  assert.doesNotMatch(html, /__rank/, 'kein Rang-Element');
  assert.match(html, /rewards\.remainingToReward\{"points":"15","reward":"Kinoabend"\}/, 'noch 15 bis Kinoabend');
  assert.equal(progressValue(html), 75);
  assert.match(html, /Zimmer/, 'die zuletzt verdienten Punkte stehen da');
});

test('Kind: zuletzt verdient liest sich rueckwaerts - heute, gestern, sonst ohne Jahr', () => {
  const now = new Date();
  const html = renderRewardsWidget({
    view: 'self', me: 7, standings: [emma(45)], catalog: [KINO],
    recent: [
      { delta: 5, reason: 'Heute', type: 'earn', created_at: now.toISOString() },
      { delta: 5, reason: 'Gestern', type: 'earn', created_at: new Date(now.getTime() - 86_400_000).toISOString() },
    ],
  }, '1x2');
  const whens = [...html.matchAll(/rewards-recent__when">([^<]*)</g)].map((m) => m[1]);
  assert.deepEqual(whens, ['common.today', 'common.yesterday']);
});

test('Eltern: alle Kinder ohne Platzierungsnummer, nach Namen, dazu die offenen Freigaben', () => {
  const html = renderRewardsWidget({
    view: 'approver', me: 1, standings: [leo(60), emma(30)], catalog: [KINO], pending: 2,
  }, '1x2');
  assert.doesNotMatch(html, /__rank/, 'keine Rangziffer');
  assert.doesNotMatch(html, /--leader/, 'kein hervorgehobener Spitzenreiter');
  assert.ok(html.indexOf('Emma') < html.indexOf('Leo'), 'nebeneinander nach Namen, nicht nach Punkten');
  assert.match(html, /dashboard\.rewardsPending\{"count":2\}/);
  assert.match(html, /href="\/rewards"[^>]*data-route="\/rewards"|data-route="\/rewards"[^>]*href="\/rewards"/, 'die Freigaben verlinken auf die Freigabe-Ansicht');
  const bars = html.match(/role="progressbar"/g) || [];
  assert.equal(bars.length, 2, 'je Kind ein Fortschritt zum Ziel');
});

test('Familie (Wand, Grosseltern): alle Kinder, aber kein Freigabe-Hinweis', () => {
  const html = renderRewardsWidget({
    view: 'family', me: 99, standings: [emma(30), leo(60)], catalog: [KINO], pending: 3,
  }, '1x2');
  assert.match(html, /Emma/);
  assert.match(html, /Leo/);
  assert.doesNotMatch(html, /rewardsPending/, 'wer nicht freigibt, bekommt keinen Freigabe-Zaehler');
});

test('Fortschritt: kein Ziel, Ziel erreicht, 0 Punkte, vergriffene Praemie', () => {
  const self = (balance, catalog) => renderRewardsWidget({ view: 'self', me: 7, standings: [emma(balance)], catalog }, '1x1');

  const none = self(30, []);
  assert.equal(progressValue(none), null, 'ohne Praemie gibt es keinen Balken');
  assert.match(none, /rewards\.noRewardsYet/);

  const reached = self(80, [KINO, EIS]);
  assert.equal(progressValue(reached), 100);
  assert.match(reached, /rewards\.canRedeemNow/);

  const zero = self(0, [KINO]);
  assert.equal(progressValue(zero), 0);
  assert.match(zero, /rewards\.remainingToReward\{"points":"60","reward":"Kinoabend"\}/);

  const negative = self(-5, [KINO]);
  assert.equal(progressValue(negative), 0, 'ein negativer Stand ist leer, nicht negativ');

  const soldOut = self(30, [{ ...EIS, remaining: 0 }, KINO]);
  assert.match(soldOut, /reward":"Kinoabend"/, 'eine vergriffene Praemie ist kein Ziel');
  assert.equal(progressValue(soldOut), 50);
});

test('Ein einziges Mitglied: die eigene Zeile wird zur eigenen Sicht, eine fremde bleibt benannt', () => {
  const soloSelf = renderRewardsWidget({
    view: 'approver', me: 7, standings: [emma(45)], catalog: [KINO], pending: 0,
    recent: [{ delta: 5, reason: 'Blumen giessen', type: 'earn', created_at: '2026-09-21T08:00:00Z' }],
  }, '1x2');
  assert.equal(progressValue(soloSelf), 75);
  assert.match(soloSelf, /Blumen giessen/, 'wer allein sammelt und freigibt, sieht die eigene Sicht');

  const oneKid = renderRewardsWidget({
    view: 'approver', me: 1, standings: [leo(15)], catalog: [KINO], pending: 0,
  }, '1x1');
  assert.match(oneKid, /Leo/, 'das eine Kind bleibt mit Namen stehen');
  assert.equal(progressValue(oneKid), 25);
});

test('Groessen: die Kachel entscheidet, wie viel davon steht', () => {
  const recent = [1, 2, 3].map((n) => ({ delta: n, reason: `R${n}`, type: 'earn', created_at: '2026-09-01T08:00:00Z' }));
  const kid = (size) => renderRewardsWidget({ view: 'self', me: 7, standings: [emma(45)], catalog: [KINO], recent }, size);
  const rowsOf = (html) => (html.match(/rewards-recent__row"/g) || []).length;
  assert.equal(rowsOf(kid('1x1')), 0, '1x1 traegt nur den Weg zum Ziel');
  assert.equal(rowsOf(kid('2x1')), 2);
  assert.equal(rowsOf(kid('1x2')), 3);
  assert.equal(progressValue(kid('1x1')), 75, 'der Balken bleibt auf jeder Groesse');

  const kids = ['Anna', 'Ben', 'Carla'].map((name, i) => ({ id: 20 + i, display_name: name, balance: 10 }));
  const parent = (size) => renderRewardsWidget({ view: 'approver', me: 1, standings: kids, catalog: [KINO], pending: 1 }, size);
  const short = parent('1x1');
  assert.equal((short.match(/class="rewards-member"/g) || []).length, 2);
  assert.match(short, /dashboard\.shoppingMore\{"count":1\}/, 'wer nicht passt, wird gezaehlt');
  assert.doesNotMatch(short, /class="rewards-goal__label"/, 'die flache Kachel zeigt den Balken ohne Satz');
  assert.match(short, /aria-valuetext="rewards\.remainingToReward/, 'die Ansage behaelt den Satz');
  const tall = parent('1x2');
  assert.equal((tall.match(/class="rewards-member"/g) || []).length, 3);
  assert.match(tall, /class="rewards-goal__label"/);
});

test('Leerzustand: ein Kind bekommt keinen Knopf, den es nicht benutzen darf', () => {
  const kid = renderRewardsWidget({ view: 'self', me: 7, standings: [], catalog: [] }, '1x1');
  assert.match(kid, /dashboard\.noRewards/);
  assert.doesNotMatch(kid, /rewards\.addReward/, 'Praemien anlegen ist Elternsache');
  const parent = renderRewardsWidget({ view: 'approver', me: 1, standings: [], catalog: [] }, '1x1');
  assert.match(parent, /rewards\.addReward/);
});

test('Kennzahlkachel: das Kind sieht den eigenen Stand, niemand einen Spitzenreiter', () => {
  global.window = { yuvomi: null };
  // Eine Kachelreihe braucht mindestens zwei Kacheln - das Budget ist die zweite.
  const base = { budget: { entryCount: 3, balance: 100, income: 200 }, birthdays: [], pinnedNotes: [], health: {}, housekeeping: {} };
  const kidTile = selectMetricTiles({
    ...base, rewards: { view: 'self', me: 7, standings: [emma(45)], catalog: [KINO] },
  }, 'EUR', new Set()).find((tile) => tile.id === 'rewards');
  assert.ok(kidTile, 'die eigene Punktzahl ist eine Kennzahl');
  assert.match(kidTile.value, /"count":45/);
  assert.match(kidTile.note, /Kinoabend/, 'darunter das Ziel, nicht ein Name');

  const parentTile = selectMetricTiles({
    ...base, rewards: { view: 'approver', me: 1, standings: [leo(60), emma(30)], catalog: [KINO], pending: 0 },
  }, 'EUR', new Set()).find((tile) => tile.id === 'rewards');
  assert.ok(!parentTile || !/Leo|Emma/.test(`${parentTile.value} ${parentTile.note}`),
    'die Kachel kuert keinen Spitzenreiter');
});

test('Verdrahtung: das Widget bekommt seine Groesse, und das Ziel kommt aus EINER Regel', () => {
  const dash = readFileSync(new URL('../public/pages/dashboard.js', import.meta.url), 'utf8');
  assert.ok(/rewards:\s*\(size\)\s*=>\s*renderRewardsWidget\(data\.rewards \?\? \{\}, size\)/.test(dash),
    'widgetById reicht die Kachelgroesse nicht an das Belohnungen-Widget durch');
  const page = readFileSync(new URL('../public/pages/rewards.js', import.meta.url), 'utf8');
  for (const [name, text] of [['dashboard.js', dash], ['rewards.js', page]]) {
    assert.ok(/from '\/utils\/reward-goal\.js'/.test(text), `${name} rechnet das naechste Ziel selbst statt ueber utils/reward-goal.js`);
  }
});

// --------------------------------------------------------
// Die Seite: Kopf und Inhalt teilen je Reiter eine Kante
// (Re-Critique 2026-09-27, A3 P2-5 / R10 L7)
//
// Gemessen bei 1440x900: Punktestand bis 972, sein Kopfknopf bis 1408; das
// Ledger 1156px breit mit dem Punktwert 1100px vom Grund; im Katalog endete
// die Kopfpille bei 972, das Raster bei 1408. Jetzt: Zeilenlisten auf dem
// Lesemass, das Raster breit, und die Kopfpille an der Kante ihres Inhalts.
// --------------------------------------------------------

const { __test: rewardsPage } = await import('../public/pages/rewards.js');

/** Ein Inhaltsknoten, der das Markup einsammelt - mehr fassen die Renderer nicht an. */
function markupEl() {
  return {
    html: '',
    replaceChildren() { this.html = ''; },
    insertAdjacentHTML(_pos, html) { this.html += html; },
    querySelector() { return null; },
    querySelectorAll() { return []; },
  };
}

test('Belohnungen: nur der Katalog ist ein breiter Abschnitt, Uebersicht und Verlauf stehen auf dem Lesemass', () => {
  const s = rewardsPage.state;
  const vorher = { user: s.user, overview: s.overview, catalog: s.catalog, ledger: s.ledger, redemptions: s.redemptions };
  try {
    s.user = { id: 1, role: 'admin' };
    s.overview = { me: 1, balances: [{ id: 2, display_name: 'Emma', balance: 30 }] };
    s.catalog = [{ id: 7, name: 'Kinoabend', cost: 100, is_active: 1 }];
    s.ledger = [{ id: 1, type: 'earn', delta: 5, reason: 'Zimmer', user_name: 'Emma', created_at: '2026-09-20' }];
    s.redemptions = [];
    const wide = /class="rw-section rw-section--wide"/g;
    for (const [name, render] of [['renderOverview', rewardsPage.renderOverview], ['renderLedger', rewardsPage.renderLedger]]) {
      const el = markupEl();
      render(el);
      assert.match(el.html, /class="rw-section"/, `${name}: der Abschnitt steht da`);
      assert.doesNotMatch(el.html, wide, `${name}: eine Zeilenliste ist kein breiter Abschnitt`);
    }
    const katalog = markupEl();
    rewardsPage.renderCatalog(katalog);
    assert.equal((katalog.html.match(wide) || []).length, 1, 'das Katalograster ist der eine breite Abschnitt');
  } finally {
    Object.assign(s, vorher);
  }
});

test('Belohnungen: der Kopf gibt im Katalog der Pille die volle Kante zurueck, sonst nicht', () => {
  assert.equal(typeof rewardsPage.syncToolbarMeasure, 'function', 'syncToolbarMeasure fehlt im __test-Export');
  const classes = new Set(['page-toolbar', 'page-toolbar--narrow', 'rewards-toolbar']);
  const toolbar = { classList: { toggle: (c, on) => (on ? classes.add(c) : classes.delete(c)) } };
  const container = { querySelector: (sel) => (sel === '.rewards-toolbar' ? toolbar : null) };
  const s = rewardsPage.state;
  const tabVorher = s.tab;
  try {
    for (const [tab, breit] of [['catalog', true], ['ledger', false], ['overview', false], ['catalog', true]]) {
      s.tab = tab;
      rewardsPage.syncToolbarMeasure(container);
      assert.equal(classes.has('rewards-toolbar--wide'), breit, `${tab}: --wide ${breit ? 'gesetzt' : 'weg'}`);
      assert.ok(classes.has('page-toolbar--narrow'),
        `${tab}: --narrow bleibt - ohne passte die gekappte Reiterleiste in die Titelzeile (52px Sprung, gemessen)`);
    }
  } finally {
    s.tab = tabVorher;
  }
  const css = readFileSync(new URL('../public/styles/rewards.css', import.meta.url), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '');
  assert.match(css, /\.rewards-page \.rw-section:not\(\.rw-section--wide\)\s*\{[^}]*max-width:\s*var\(--page-measure/,
    'jeder Abschnitt ausser dem Raster endet am Lesemass - samt Kopf');
  assert.match(css, /\.rewards-toolbar--wide\s*\{[^}]*padding-inline-end:\s*var\(--page-inline-pad\)/);
  assert.match(css, /\.rewards-toolbar--wide\s*\{[^}]*--page-measure:\s*100%/,
    'der breite Kopf erklaert sein Mass als Spalte - sonst behauptet er das Lesemass der Seite, an dem er nicht endet (Sonde 19)');
  assert.match(css, /\.rewards-toolbar--wide::after\s*\{[^}]*content:\s*none/, 'kein Rest-Slot, der die Pille zurueckschoebe');
  assert.match(css, /\.rewards-toolbar--wide > \.rewards-tabs\s*\{[^}]*max-width:\s*none/, 'die Reiterleiste bricht weiter um');
  const page = readFileSync(new URL('../public/pages/rewards.js', import.meta.url), 'utf8');
  assert.match(page, /async function renderCurrentTab\(container\) \{[\s\S]{0,120}syncToolbarMeasure\(container\);/,
    'jeder Reiterwechsel fuehrt den Kopf mit');
});

test('Belohnungen: der Einrichtungsschritt „Praemien" wechselt wirklich in den Katalog', () => {
  // Er suchte `[data-rw-tab="catalog"]` - ein Attribut, das es nie gab; die
  // Reiter tragen `data-tab-id` (tabButton). Der Klick lief ins Leere.
  let gefragt = null;
  let geklickt = false;
  const vorher = globalThis.document;
  globalThis.document = { querySelector: (sel) => { gefragt = sel; return /data-tab-id="catalog"/.test(sel) ? { click() { geklickt = true; } } : null; } };
  try {
    rewardsPage.handleSetupStep('catalog');
  } finally {
    globalThis.document = vorher;
  }
  assert.ok(geklickt, `gesucht wurde ${gefragt} - der Reiter heisst data-tab-id="catalog"`);
});

test('Belohnungen: Verlaufs-Chips sind Kanon-Filterchips mit aria-pressed (Re-Critique 2026-09-28 P2-6)', () => {
  // `.rw-chip` war ein eigener Dialekt: 31px hoch, kein Zustand fuer den
  // Screenreader (aria-pressed fehlte). Kanon ist `.filter-chip` (40/48px,
  // Tonrezept) plus aria-pressed.
  const s = rewardsPage.state;
  const vorher = { user: s.user, overview: s.overview, ledger: s.ledger, ledgerFilter: s.ledgerFilter };
  try {
    s.user = { id: 1, role: 'admin' };
    s.overview = { me: 1, balances: [{ id: 2, display_name: 'Emma', balance: 30 }, { id: 3, display_name: 'Leo', balance: 10 }] };
    s.ledger = [{ id: 1, type: 'earn', delta: 5, reason: 'Zimmer', user_name: 'Leo', created_at: '2026-09-20' }];
    s.ledgerFilter = 3;
    const el = markupEl();
    rewardsPage.renderLedger(el);
    const chips = [...el.html.matchAll(/<button[^>]*data-filter="([^"]*)"[^>]*>/g)];
    assert.equal(chips.length, 3, 'Alle + zwei Personen');
    for (const [tag, id] of chips) {
      assert.match(tag, /class="[^"]*\bfilter-chip\b/, `Chip ${id}: .filter-chip`);
      assert.doesNotMatch(tag, /rw-chip/, `Chip ${id}: kein eigener Dialekt`);
      const pressed = tag.match(/aria-pressed="(true|false)"/);
      assert.ok(pressed, `Chip ${id}: aria-pressed fehlt`);
      assert.equal(pressed[1], String(id === '3'), `Chip ${id}: aria-pressed folgt dem Filter`);
      assert.equal(/filter-chip--active/.test(tag), id === '3', `Chip ${id}: Aktivklasse folgt dem Filter`);
    }
  } finally {
    Object.assign(s, vorher);
  }
  const css = readFileSync(new URL('../public/styles/rewards.css', import.meta.url), 'utf8');
  assert.doesNotMatch(css.replace(/\/\*[\s\S]*?\*\//g, ''), /\.rw-chip\b/, 'rewards.css baut keinen eigenen Chip mehr');
});

// Re-Critique 2026-09-28 (P5, A3 P2-5): mobil fiel die Punktestandzeile auf
// eine Spalte mit voller Einloesen-Kapsel - eine Person pro Bildschirm (Leo
// 455-623, ca. 180px). Jetzt wie die Apple-Health-Zusammenfassung: Person und
// Punkte links, Einloesen als kompakte Kapsel rechts, die duenne Leiste
// darunter ueber die volle Zeile. Die offene Anfrage stapelt ihren Avatar
// nicht mehr allein ueber dem Titel.
test('Belohnungen mobil: Punktestand als Zeile mit Trailing-Kapsel, Anfrage mit Avatar in der Zeile', async () => {
  const { eachRule } = await import('./css-rules.js');
  const rules = [...eachRule(readFileSync(new URL('../public/styles/rewards.css', import.meta.url), 'utf8'))];
  const mobil = (sel) => rules.filter((r) => r.selector.trim() === sel && r.at.some((a) => /max-width:\s*639px/.test(a)))
    .map((r) => r.body).join(';');
  assert.match(mobil('.rw-standing'), /grid-template-columns:\s*minmax\(0,\s*1fr\)\s+auto/, 'Person | Kapsel');
  assert.match(mobil('.rw-standing'), /grid-template-areas:\s*"id actions"\s*"progress progress"/);
  assert.doesNotMatch(mobil('.rw-standing__actions .btn'), /flex:\s*1 1 auto/, 'keine volle Kapselbreite mehr');
  assert.match(mobil('.rw-standing__progress'), /grid-area:\s*progress/);
  assert.match(mobil('.rw-pending'), /grid-template-columns:\s*auto\s+minmax\(0,\s*1fr\)/, 'Avatar und Titel in einer Zeile');
  assert.match(mobil('.rw-pending__actions'), /grid-column:\s*2/, 'die Knoepfe stehen unter dem Titel, nicht unter dem Avatar');
});
