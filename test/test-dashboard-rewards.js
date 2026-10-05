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

// Critique R16 (2026-10-05): der Kopf folgte dem Reiter (`--wide` nur im
// Katalog), die angedockte Pille sprang zwischen Katalog (1408) und Verlauf
// (972) um 431px. Jetzt fuehrt die SEITE das breite Mass, und Uebersicht und
// Verlauf fuellen es mit einer Seitenspalte.
test('Belohnungen: eine Kante fuer alle Reiter - die Seite fuehrt das breite Mass, der Kopf schaltet nicht um', () => {
  const page = readFileSync(new URL('../public/pages/rewards.js', import.meta.url), 'utf8');
  const css = readFileSync(new URL('../public/styles/rewards.css', import.meta.url), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '');
  assert.match(page, /class="rewards-page app-page app-page--dashboard app-page--columns" data-composition="dashboard"/,
    'die Seitenwurzel fuehrt das breite Mass und ist der Container der Spalten');
  assert.match(page, /<header class="page-toolbar page-toolbar--narrow rewards-toolbar">/,
    '--narrow bleibt: der Kopf endet am Mass der Seite, in jedem Reiter am selben');
  assert.equal(rewardsPage.syncToolbarMeasure, undefined, 'kein Umschalter am Kopf mehr');
  assert.doesNotMatch(page, /rewards-toolbar--wide/, 'der Kopf-Modifier je Reiter ist weg');
  assert.doesNotMatch(css, /rewards-toolbar--wide/, 'und seine Regeln auch');
  assert.match(css, /\.rewards-page \.rw-section\s*\{[^}]*max-width:\s*var\(--page-measure/,
    'jeder Abschnitt endet am Mass der Seite - auch das Katalograster');
});

test('Belohnungen: Uebersicht und Verlauf stehen im Spaltenraster, die Seitenspalte nimmt nur vorhandene Daten', () => {
  const s = rewardsPage.state;
  const vorher = { user: s.user, overview: s.overview, catalog: s.catalog, ledger: s.ledger, redemptions: s.redemptions, recentLedger: s.recentLedger };
  const buchung = { id: 1, type: 'earn', delta: 5, reason: 'Zimmer', user_name: 'Emma', created_at: '2026-09-20' };
  try {
    s.user = { id: 1, role: 'admin' };
    s.overview = { me: 1, balances: [{ id: 2, display_name: 'Emma', balance: 30 }] };
    s.catalog = [{ id: 7, name: 'Kinoabend', cost: 100, is_active: 1 }];
    s.ledger = [buchung];
    s.redemptions = [];

    // Uebersicht mit Buchungen: Punktestaende links, die letzten Buchungen rechts.
    s.recentLedger = [buchung];
    let el = markupEl();
    rewardsPage.renderOverview(el);
    const [main, rail] = el.html.split('<div class="page-columns__rail">');
    assert.match(main, /<div class="page-columns__main">[\s\S]*rw-standings/, 'die Punktestaende stehen in der Listenspalte');
    assert.ok(rail, 'mit Buchungen gibt es eine Seitenspalte');
    assert.match(rail, /class="section-title-link rw-section__more"[^>]*>rewards\.tabLedger/, 'der Abschnittstitel ist der Weg in den Verlauf');
    assert.match(rail, /<ul class="rw-ledger row-carrier">[\s\S]*list-row rw-ledger-row/, 'derselbe Zeilenbaustein wie im Verlauf');

    // Ohne Antwort (null) und ohne Buchung ([]) entfaellt die Spalte - kein
    // Leerzustand, der "keine Buchungen" behauptet, wenn die Abfrage scheiterte.
    for (const leer of [null, []]) {
      s.recentLedger = leer;
      el = markupEl();
      rewardsPage.renderOverview(el);
      assert.match(el.html, /page-columns__main/);
      assert.doesNotMatch(el.html, /page-columns__rail/, `recentLedger=${JSON.stringify(leer)}: keine Seitenspalte`);
    }

    // Verlauf: Buchungen links, Punktestaende in Kurzform rechts.
    el = markupEl();
    rewardsPage.renderLedger(el);
    const [lMain, lRail] = el.html.split('<div class="page-columns__rail">');
    assert.match(lMain, /<ul class="rw-ledger row-carrier">/, 'die Buchungen stehen in der Listenspalte');
    assert.match(lRail ?? '', /rw-standing--compact[\s\S]*Emma/, 'die Punktestaende stehen in der Seitenspalte');
    assert.doesNotMatch(lRail ?? '', /rw-redeem-open|rw-progress__track/, 'Kurzform: kein Fortschritt, kein Einloesen');
  } finally {
    Object.assign(s, vorher);
  }
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

test('Belohnungen: eine Buchung ohne Grund zeigt den Namen ihres Typs, keine leere Zeile', () => {
  // Der Server liefert `reason: null`, wenn die Aufgabe hinter einer Buchung
  // fuer die betrachtende Person nicht sichtbar ist (routes/rewards.js). Die
  // Zeile bleibt dann stehen - mit Betrag und Person - und braucht einen Text,
  // der nichts verraet: den Namen des Buchungstyps. Ohne den Rueckfall staende
  // dort "null" oder nichts.
  const s = rewardsPage.state;
  const vorher = { user: s.user, overview: s.overview, ledger: s.ledger, ledgerFilter: s.ledgerFilter };
  try {
    s.user = { id: 1, role: 'member' };
    s.overview = { me: 1, balances: [{ id: 2, display_name: 'Emma', balance: 30 }] };
    s.ledgerFilter = null;
    const reasonOf = (row) => {
      s.ledger = [{ id: 1, delta: 5, user_name: 'Emma', created_at: '2026-09-20', ...row }];
      const el = markupEl();
      rewardsPage.renderLedger(el);
      return el.html.match(/<p class="list-row__name rw-ledger-row__reason">([^<]*)<\/p>/)?.[1];
    };
    const named = reasonOf({ type: 'earn', reason: 'Zimmer', task_id: 7 });
    assert.equal(named, 'Zimmer');
    for (const type of ['earn', 'reversal']) {
      const masked = reasonOf({ type, reason: null, task_id: null });
      assert.ok(masked && masked.trim(), `${type}: die Zeile hat keinen Text`);
      assert.notEqual(masked, 'null', `${type}: die Zeile zeigt das Wort null`);
      assert.match(masked, new RegExp(`ledgerType\\.${type}$`), `${type}: der Text ist nicht der Name des Typs (${masked})`);
    }
    // Betrag und Person stehen in der maskierten Zeile weiter da.
    s.ledger = [{ id: 1, type: 'earn', delta: 5, reason: null, task_id: null, user_name: 'Emma', created_at: '2026-09-20' }];
    const el = markupEl();
    rewardsPage.renderLedger(el);
    assert.match(el.html, /rw-ledger-row__meta">Emma/);
    assert.match(el.html, /rw-delta--pos/);
  } finally {
    Object.assign(s, vorher);
  }
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

// --------------------------------------------------------
// Negativer Punktestand (#1607)
//
// Seit das Wiederoeffnen einer Aufgabe gegenbucht statt die Gutschrift zu
// loeschen, ist ein Saldo unter null ein gewoehnlicher Zustand: die Punkte der
// wieder geoeffneten Aufgabe stecken schon in einer Praemie. Drei Dinge duerfen
// dann nicht passieren - kein NaN, kein Balken unter null, kein Minus ohne
// einen Satz, der es erklaert.
// --------------------------------------------------------

const lesbar = (html) => html.replace(/&quot;/g, '"').replace(/&amp;/g, '&');

test('Server: eine zurueckgenommene Gutschrift steht nicht mehr unter "zuletzt verdient" (#1607)', async () => {
  // Gebucht wird ueber den Dienst: die Gegenbuchung zeigt auf ihre Gutschrift
  // (`reverses_id`), und eine von Hand eingefuegte Zeile truege den Bezug nicht.
  const { syncTaskRewards } = await import('../server/services/rewards.js');
  const kid = user('rw-mia', 'Mia', 'member');
  d.prepare('INSERT INTO reward_participants (user_id, enabled) VALUES (?, 1)').run(kid);
  const task = d.prepare("INSERT INTO tasks (title, status, created_by, points) VALUES ('Muell', 'open', ?, 60)").run(PARENT).lastInsertRowid;
  d.prepare('INSERT INTO task_assignments (task_id, user_id) VALUES (?, ?)').run(task, kid);
  syncTaskRewards(d, task, 'open', 'done', PARENT, null, { now: new Date('2026-09-22T08:00:00Z') });
  d.prepare("INSERT INTO reward_ledger (user_id, delta, type, reason, created_at) VALUES (?, -50, 'redeem', 'Eis', '2026-09-22T09:00:00Z')").run(kid);
  syncTaskRewards(d, task, 'done', 'open', PARENT);

  const zurueckgenommen = (await dashboardAs(kid, 'member')).rewards;
  assert.equal(zurueckgenommen.standings[0].balance, -50, 'der Saldo geht unveraendert als Zahl hinaus');
  assert.deepEqual(zurueckgenommen.recent, [], 'die Aufgabe ist wieder offen - verdient ist hier nichts');

  // Erneut erledigt: die NEUE Gutschrift gilt, die alte bleibt zurueckgenommen.
  syncTaskRewards(d, task, 'open', 'done', PARENT, null, { now: new Date('2026-09-22T11:00:00Z') });
  const neu = (await dashboardAs(kid, 'member')).rewards;
  assert.deepEqual(neu.recent.map((r) => r.created_at), ['2026-09-22T11:00:00Z']);

  d.prepare('DELETE FROM reward_participants WHERE user_id = ?').run(kid);
});

test('Server: auch nach dem Loeschen der Aufgabe bleibt die zurueckgenommene Gutschrift draussen (#1607)', async () => {
  // Das Loeschen setzt task_id an BEIDEN Zeilen auf NULL (ON DELETE SET NULL).
  // Ein Bezug ueber die Aufgabe traefe danach nie mehr, und die zurueckgenommene
  // Gutschrift stuende wieder unter "zuletzt verdient". Gebucht wird hier ueber
  // den Dienst, damit die Zeilen so entstehen wie im Betrieb.
  const { syncTaskRewards } = await import('../server/services/rewards.js');
  const kid = user('rw-noa', 'Noa', 'member');
  d.prepare('INSERT INTO reward_participants (user_id, enabled) VALUES (?, 1)').run(kid);
  const task = d.prepare("INSERT INTO tasks (title, status, created_by, points) VALUES ('Flur', 'open', ?, 15)").run(PARENT).lastInsertRowid;
  d.prepare('INSERT INTO task_assignments (task_id, user_id) VALUES (?, ?)').run(task, kid);
  syncTaskRewards(d, task, 'open', 'done', PARENT);
  syncTaskRewards(d, task, 'done', 'open', PARENT);
  d.prepare('DELETE FROM tasks WHERE id = ?').run(task);
  assert.deepEqual(
    d.prepare('SELECT delta, task_id FROM reward_ledger WHERE user_id = ? ORDER BY id').all(kid),
    [{ delta: 15, task_id: null }, { delta: -15, task_id: null }],
    'Vorbedingung: beide Zeilen haben die Aufgabe verloren',
  );

  assert.deepEqual((await dashboardAs(kid, 'member')).rewards.recent, []);
  d.prepare('DELETE FROM reward_participants WHERE user_id = ?').run(kid);
});

test('Widget: ein Minus traegt seinen Satz, der Balken steht bei null (#1607)', () => {
  for (const [view, size] of [['self', '1x2'], ['approver', '2x2'], ['family', '2x2']]) {
    const html = renderRewardsWidget({
      view, me: 7, standings: [emma(-50)], participantCount: 1, pending: 0, catalog: [KINO], recent: [],
    }, size);
    assert.doesNotMatch(html, /NaN|undefined/, `${view}: keine kaputte Zahl`);
    assert.equal(progressValue(html), 0, `${view}: der Balken steht bei null`);
    assert.match(html, /--rewards-progress:0[;"]/, `${view}: keine negative Breite`);
    assert.match(html, /aria-valuetext="rewards\.balanceBelowZero"/, `${view}: die Ansage erklaert das Minus`);
    assert.doesNotMatch(html, /remainingToReward/, `${view}: "noch 110 bis Kinoabend" erklaerte die Zahl nicht`);
  }
  // Auch ohne eine einzige Praemie: der Satz haengt nicht am Katalog.
  const ohne = renderRewardsWidget({ view: 'self', me: 7, standings: [emma(-50)], catalog: [], recent: [] }, '1x2');
  assert.match(ohne, /rewards\.balanceBelowZero/);
  assert.doesNotMatch(ohne, /rewards\.noRewardsYet/);
});

test('Belohnungsseite: Punktestandzeile, Anfrage und Verlauf erklaeren das Minus (#1607)', () => {
  const s = rewardsPage.state;
  const vorher = { user: s.user, overview: s.overview, catalog: s.catalog, redemptions: s.redemptions, prevBalances: s.prevBalances };
  const mia = { id: 3, display_name: 'Mia', avatar_color: '#34C759', balance: -50 };
  const tom = { id: 4, display_name: 'Tom', avatar_color: '#FF9500', balance: 20 };
  try {
    s.user = { role: 'admin' };
    s.overview = { me: 1, balances: [mia, tom] };
    s.catalog = [{ id: 11, name: 'Kinoabend', cost: 60, is_active: 1, remaining: null }];
    s.prevBalances = new Map();
    s.redemptions = [
      { id: 1, user_id: 3, user_name: 'Mia', reward_name: 'Eis', cost: 50 },
      { id: 2, user_id: 4, user_name: 'Tom', reward_name: 'Eis', cost: 50 },
    ];

    const zeile = lesbar(rewardsPage.renderStandingRow(mia));
    assert.doesNotMatch(zeile, /NaN|undefined/);
    assert.match(zeile, /aria-valuenow="0"/);
    assert.match(zeile, /--rw-progress:0"/, 'keine negative Balkenbreite');
    assert.match(zeile, /rw-progress__label[^>]*>rewards\.balanceBelowZero</, 'der sichtbare Satz erklaert das Minus');
    assert.match(lesbar(rewardsPage.renderStandingRow(tom)), /rewards\.remainingToReward/, 'ein Saldo ueber null bleibt unveraendert');

    // Ohne Katalog stand dort "noch keine Praemien" - neben einer -50.
    s.catalog = [];
    assert.match(lesbar(rewardsPage.renderStandingRow(mia)), /rewards\.balanceBelowZero/);

    // Der Hinweis neben der offenen Anfrage: nur fuer Entscheidende, nur bei wem er zutrifft.
    const anfragen = lesbar(rewardsPage.renderPendingPanel());
    const hinweise = anfragen.match(/rewards\.pendingBalanceBelowZero\{[^}]*\}/g) || [];
    assert.equal(hinweise.length, 1, 'Mia ist im Minus, Tom nicht');
    assert.match(hinweise[0], /"points":"-50"/);
    assert.match(anfragen, /data-decide="fulfill" data-id="1"/, 'ein Hinweis, keine Sperre: freigeben bleibt moeglich');
    s.user = { role: 'member' };
    assert.doesNotMatch(lesbar(rewardsPage.renderPendingPanel()), /pendingBalanceBelowZero/, 'das Kind liest seinen Stand in der eigenen Zeile');

    // Verlauf: die Gegenbuchung sagt, was geschah - die Einloese-Rueckbuchung bleibt, wie sie war.
    assert.equal(lesbar(rewardsPage.ledgerReason({ type: 'reversal', delta: -60, reason: 'Muell' })), 'rewards.ledgerTaskReopenedNamed{"task":"Muell"}');
    assert.equal(rewardsPage.ledgerReason({ type: 'reversal', delta: -60, reason: null }), 'rewards.ledgerTaskReopened');
    assert.equal(rewardsPage.ledgerReason({ type: 'reversal', delta: 50, reason: 'Eis' }), 'Eis');
    assert.equal(rewardsPage.ledgerReason({ type: 'earn', delta: 60, reason: 'Muell' }), 'Muell');
  } finally {
    Object.assign(s, vorher);
  }
});

test('Kachel, eine Rasterzeile hoch: das Minus steht sichtbar da, nicht nur in der Ansage (#1623)', () => {
  const kids = [emma(-50), leo(15)];
  for (const size of ['1x1', '2x1']) {
    for (const view of ['approver', 'family']) {
      const html = renderRewardsWidget({ view, me: 1, standings: kids, participantCount: 2, pending: 0, catalog: [KINO] }, size);
      const sichtbar = html.match(/<p class="rewards-goal__label[^"]*"[^>]*>([^<]*)<\/p>/g) || [];
      assert.equal(sichtbar.length, 1, `${view} ${size}: genau eine sichtbare Zeile - Emmas, nicht Leos`);
      assert.match(sichtbar[0], /rewards-goal__label--compact/, `${view} ${size}: die kompakte Zeile`);
      assert.match(sichtbar[0], />rewards\.balanceBelowZeroShort</, `${view} ${size}: die Kurzform`);
      assert.match(sichtbar[0], /aria-hidden="true"/, 'die Ansage traegt den ganzen Satz schon');
      assert.match(html, /aria-valuetext="rewards\.balanceBelowZero"/, 'der ganze Satz bleibt in der Ansage');
      assert.equal(progressValue(html), 0);
      // Der leere Balken weicht der Kurzzeile sichtbar, bleibt aber fuer die Ansage im DOM.
      const balken = html.match(/<div class="rewards-goal__track[^"]*"[^>]*>/g) || [];
      assert.equal(balken.length, 2, `${view} ${size}: beide Balken stehen im DOM`);
      const emmas = balken.find((b) => /aria-valuetext="rewards\.balanceBelowZero"/.test(b));
      assert.match(emmas, /class="rewards-goal__track sr-only"/, `${view} ${size}: im Minus nicht sichtbar`);
      assert.match(emmas, /role="progressbar"/);
      assert.match(emmas, /aria-valuenow="0"/);
      const leos = balken.find((b) => b !== emmas);
      assert.match(leos, /class="rewards-goal__track"/, `${view} ${size}: ein Saldo ueber null behaelt seinen Balken`);
    }
  }
  // Hoch bleibt, wie es war: der ganze Satz, keine Kurzform.
  const tall = renderRewardsWidget({ view: 'approver', me: 1, standings: kids, participantCount: 2, pending: 0, catalog: [KINO] }, '1x2');
  assert.match(tall, /class="rewards-goal__label"[^>]*>rewards\.balanceBelowZero</);
  assert.doesNotMatch(tall, /balanceBelowZeroShort/);
  assert.doesNotMatch(tall, /sr-only/, 'hoch bleibt der Balken sichtbar');
});

test('Kachel: die Kurzform bricht um, hoechstens zwei Zeilen (#1623)', async () => {
  // Zwei Mitglieder nebeneinander (Viewports um 500 und um 1000px) lassen dem
  // Satz nur 165-197px: einzeilig mit Ellipse schnitt de, fr und el ab.
  const { eachRule } = await import('./css-rules.js');
  const css = readFileSync(new URL('../public/styles/dashboard.css', import.meta.url), 'utf8');
  const rule = [...eachRule(css)].find((r) => r.selector.trim() === '.rewards-goal__label--compact');
  assert.ok(rule, 'die Regel gibt es');
  assert.doesNotMatch(rule.body, /white-space:\s*nowrap/, 'kein Einzeiler');
  assert.match(rule.body, /(?:^|[;\s])line-clamp:\s*2\b/, 'Standard-Eigenschaft');
  assert.match(rule.body, /-webkit-line-clamp:\s*2\b/);
  assert.match(rule.body, /display:\s*-webkit-box/);
  assert.match(rule.body, /-webkit-box-orient:\s*vertical/);
  assert.match(rule.body, /overflow:\s*hidden/, 'ohne overflow klemmt line-clamp nichts ab');
});

test('Genehmigungsliste: der Saldo kommt mit der Anfrage, nicht aus der Teilnehmerliste (#1623)', () => {
  const s = rewardsPage.state;
  const vorher = { user: s.user, overview: s.overview, redemptions: s.redemptions };
  try {
    s.user = { role: 'admin' };
    // Mia ist ausgetragen: `balances` fuehrt sie nicht mehr.
    s.overview = { me: 1, balances: [{ id: 4, display_name: 'Tom', balance: 20 }] };
    s.redemptions = [
      { id: 1, user_id: 3, user_name: 'Mia', reward_name: 'Eis', cost: 50, user_balance: -50 },
      { id: 2, user_id: 4, user_name: 'Tom', reward_name: 'Eis', cost: 50, user_balance: 20 },
    ];
    const hinweise = lesbar(rewardsPage.renderPendingPanel()).match(/rewards\.pendingBalanceBelowZero\{[^}]*\}/g) || [];
    assert.equal(hinweise.length, 1, 'Mia ist im Minus, auch ohne Zeile in balances');
    assert.match(hinweise[0], /"points":"-50"/);
    // Die Anfrage gewinnt gegen die Teilnehmerliste, wenn beide etwas sagen.
    s.redemptions = [{ id: 2, user_id: 4, user_name: 'Tom', reward_name: 'Eis', cost: 50, user_balance: -5 }];
    assert.match(lesbar(rewardsPage.renderPendingPanel()), /pendingBalanceBelowZero\{"points":"-5"\}/);
    s.user = { role: 'member' };
    assert.doesNotMatch(lesbar(rewardsPage.renderPendingPanel()), /pendingBalanceBelowZero/);
  } finally {
    Object.assign(s, vorher);
  }
});

test('Uebersicht ohne Teilnehmende: die offene Anfrage steht trotzdem da und ist entscheidbar (#1623)', async () => {
  // Der haerteste Fall: die Anfragende war die LETZTE Teilnehmende und wurde
  // ausgetragen. `balances` ist leer, die Uebersicht kehrte mit dem
  // Leerzustand zurueck - vor dem Anfragen-Panel.
  const { setPermissions, clearPermissions } = await import('../public/permissions.js');
  // Der Leerzustand BAUT Knoten (emptyStateHTML): dafuer das Mini-DOM, nur hier.
  const { installMiniDom } = await import('./mini-dom.js');
  const domZurueck = installMiniDom();
  const s = rewardsPage.state;
  const vorher = { user: s.user, overview: s.overview, catalog: s.catalog, redemptions: s.redemptions };
  try {
    s.user = { id: 1, role: 'admin' };
    s.overview = { me: 1, balances: [], setup: { participantCount: 0, catalogCount: 1, pointedTaskCount: 1 } };
    s.catalog = [];
    s.redemptions = [{ id: 9, user_id: 3, user_name: 'Mia', reward_name: 'Eis', cost: 50, user_balance: -50 }];
    const el = markupEl();
    rewardsPage.renderOverview(el);
    const html = lesbar(el.html);
    assert.doesNotMatch(html, /NaN|undefined/);
    assert.match(html, /rw-pending-panel/, 'das Panel steht ohne Punktestaende');
    assert.match(html, /Mia/);
    assert.match(html, /pendingBalanceBelowZero\{"points":"-50"\}/, 'samt Hinweis auf das Minus');
    assert.match(html, /data-decide="fulfill" data-id="9"/, 'genehmigen ist erreichbar');
    assert.match(html, /data-decide="reject" data-id="9"/, 'ablehnen auch');
    assert.match(html, /rewards\.emptyOverviewTitle/, 'der Leerzustand bleibt daneben stehen');
    assert.ok(html.indexOf('rw-pending-panel') < html.indexOf('rewards.emptyOverviewTitle'), 'das Dringende zuerst');

    // Nur lesen: der Zustand bleibt als Zeichen, die Handlung geht.
    setPermissions({ admin: false, modules: { rewards: 'read' }, widgets: {}, capabilities: {} });
    try {
      const ro = markupEl();
      rewardsPage.renderOverview(ro);
      assert.match(ro.html, /rw-pending-panel/);
      assert.doesNotMatch(ro.html, /data-decide=/);
      assert.doesNotMatch(ro.html, /rw-manage-participants/);
    } finally {
      clearPermissions();
    }

    // Ohne offene Anfrage bleibt es beim blossen Leerzustand.
    s.redemptions = [];
    const leer = markupEl();
    rewardsPage.renderOverview(leer);
    assert.doesNotMatch(leer.html, /rw-pending/);
    assert.match(leer.html, /rewards\.emptyOverviewTitle/);
  } finally {
    Object.assign(s, vorher);
    domZurueck();
  }
});
