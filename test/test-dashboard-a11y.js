/**
 * Modul: Dashboard - Ueberschriftenbaum und Zaehler im Widget-Kopf
 * Zweck: Die Struktur, die ein Screenreader per Ueberschriften-Navigation
 *        abgeht (Critique 2026-09-23, Persona Sam):
 *          - das Raster hat eine eigene h2; vorher hingen alle Widget-h3 unter
 *            der h2 „Heute wichtig", als waeren sie ein Teil davon,
 *          - jede Kachel hat eine Ueberschrift, auch die Kennzahlen-Reihe,
 *          - die Badge-Zahl steht NICHT im Namen der Ueberschrift („Geburtstage
 *            5"), sondern daneben, mit Kontext.
 *        Rendering ueber __test mit dem Loader-Stub: t('key', values) kommt als
 *        "key" + JSON.stringify(values) zurueck. Das Verhalten im gerenderten
 *        Dokument (Fokus, Ansagen, Trefferflaechen) prueft
 *        test-dashboard-a11y-browser.js.
 * Ausfuehren: npm run test:dashboard-a11y
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { register } from 'node:module';

register('./test-browser-loader.mjs', import.meta.url);

const { __test } = await import('../public/pages/dashboard.js');
const { widgetHeader, renderDashboardLayout, renderMetricTiles } = __test;

/** Der Text, den ein Screenreader aus einem Markup-Stueck liest: ohne aria-hidden und ohne Tags. */
function accessibleText(html) {
  // Tag fuer Tag statt per Ersetzung: ein Teilbaum unter aria-hidden="true" bleibt stumm,
  // auch verschachtelt, und aus den Resten kann kein neues Tag zusammenwachsen.
  const VOID = new Set(['br', 'hr', 'img', 'input', 'meta', 'link', 'wbr']);
  const hidden = [];
  const parts = [];
  for (const [token, closing, name] of html.matchAll(/<(\/?)([a-zA-Z][\w-]*)\b[^>]*>|[^<]+|</g)) {
    const muted = hidden.length > 0 && hidden[hidden.length - 1];
    if (name === undefined) {
      if (!muted) parts.push(token);
    } else if (closing) {
      hidden.pop();
    } else if (!VOID.has(name.toLowerCase()) && !token.endsWith('/>')) {
      hidden.push(muted || /\baria-hidden="true"/.test(token));
    }
    if (name !== undefined) parts.push(' ');
  }
  return parts.join('').replace(/\s+/g, ' ').trim();
}

function h3Of(html) {
  const m = html.match(/<h3\b[^>]*>([\s\S]*?)<\/h3>/);
  assert.ok(m, `Reichweite: keine h3 im Kopf gefunden: ${html.slice(0, 200)}`);
  return m[1];
}

test('die Badge-Zahl steht nicht im Namen der Ueberschrift', () => {
  const html = widgetHeader('birthdays', 'Geburtstage', 5, '/birthdays');
  // Reichweite: die Zahl wird ueberhaupt gezeigt - sonst waere „nicht im Namen" trivial wahr.
  assert.match(html, /class="widget__badge"[^>]*>5</, 'die Badge zeigt die Zahl weiterhin');
  const name = accessibleText(h3Of(html));
  assert.equal(name, 'Geburtstage',
    `der zugaengliche Name der Ueberschrift ist „${name}" - die Zahl gehoert nicht hinein`);
});

test('die Zahl bleibt hoerbar - mit Kontext, ausserhalb der Ueberschrift', () => {
  const html = widgetHeader('birthdays', 'Geburtstage', 5, '/birthdays');
  const afterHeading = html.slice(html.indexOf('</h3>'));
  assert.match(afterHeading, /class="sr-only"[^>]*>\s*dashboard\.badgeCount\{(?:"|&quot;)count(?:"|&quot;):5\}/,
    'hinter der Ueberschrift steht die Zahl als Satz („5 Eintraege") fuer den Screenreader');
});

test('ohne Zahl kein Zaehler-Text - auch nicht unsichtbar', () => {
  for (const count of [0, null, undefined, 'x']) {
    const html = widgetHeader('birthdays', 'Geburtstage', count, '/birthdays');
    assert.ok(!/badgeCount/.test(html), `count=${String(count)}: ein leerer Kopf sagt keine Zahl an`);
    assert.ok(!/widget__badge/.test(html), `count=${String(count)}: und zeigt keine`);
  }
});

test('die Signatur bleibt: fuenf Positionsargumente plus optionaler Siegel-Slug', () => {
  // Parallel rufen neue Widgets widgetHeader auf - ein Umbau der Signatur
  // braeche sie still. `length` zaehlt die Parameter vor dem ersten Default.
  assert.equal(widgetHeader.length, 5);
  const html = widgetHeader('countdown', 'Countdowns', 2, null, null, 'calendar');
  assert.match(html, /--seal-accent: var\(--module-calendar/, 'sealSlug wirkt weiter');
  assert.ok(!/widget__link/.test(html), 'ohne Ziel weiterhin kein Link');
});

// R18: DER SLUG DES SIEGELS IST EIN MODUL, KEIN STUECK ADRESSE. Das Budget-Widget
// verlinkt auf `/budget?tab=budget`; der Slug wurde am ersten `/` geschnitten und
// ergab `var(--module-budget?tab=budget, ...)` - ungueltig, das Siegel stand im
// geerbten Violett. Der Text-Guard „wer ein Markensiegel baut, benennt eine
// Herkunft" (test-frontend-audit.js) sah die Zeichenkette `--seal-accent` und
// war gruen. Deshalb hier der AUFRUF: jedes Ziel, das dashboard.js einem
// Widget-Kopf gibt, laeuft durch widgetHeader, und der Ton muss ein Token sein,
// das tokens.css kennt.
test('jedes Widget-Siegel nennt einen Modulton, den tokens.css kennt (R18)', async () => {
  const { readFileSync } = await import('node:fs');
  const read = (rel) => readFileSync(new URL(rel, import.meta.url), 'utf8');
  const known = new Set([...read('../public/styles/tokens.css').matchAll(/--module-([a-z-]+)\s*:/g)].map((m) => m[1]));
  assert.ok(known.has('budget') && known.has('health'), 'Reichweite: die Modulliste wurde gelesen');

  const src = read('../public/pages/dashboard.js');
  const constants = Object.fromEntries(
    [...src.matchAll(/^const ([A-Z_]+_ROUTE) = '([^']+)';/gm)].map((m) => [m[1], m[2]]));
  const slugOf = (html) => html.match(/--seal-accent: var\(--module-([^,)]*)/)?.[1];

  // Jeder Aufruf mit seinen Argumenten - ueber die Klammern, nicht ueber ein
  // Muster: `t('nav.budget')` schliesst vor dem Ziel schon einmal.
  const calls = [];
  for (const m of src.matchAll(/(?<!function )widgetHeader\('([a-z-]+)'/g)) {
    let depth = 0;
    let end = m.index + 'widgetHeader'.length;
    do {
      if (src[end] === '(') depth += 1;
      else if (src[end] === ')') depth -= 1;
      end += 1;
    } while (depth > 0);
    calls.push([src.slice(m.index, end), m[1]]);
  }
  assert.ok(calls.length >= 30, `Reichweite: ${calls.length} Aufrufe gefunden`);

  const offenders = [];
  let viaConstant = 0;
  for (const [text, id] of calls) {
    const route = text.match(/'(\/[^']*)'/)?.[1];
    const constant = text.match(/\b([A-Z_]+_ROUTE)\b/)?.[1];
    // Die benannte Herkunft ist das letzte Argument - oder das vor dem
    // Optionsobjekt (`{ action }`, die Endzone des Wetter-Kopfes, DW-P3-3).
    const seal = text.match(/,\s*'([a-z-]+)'(?:,\s*\{[^{}]*\})?\)$/)?.[1] ?? null;
    if (constant) viaConstant += 1;
    const href = route ?? (constant ? constants[constant] : null);
    if (constant) assert.ok(href, `${constant} ist aufloesbar`);
    // Ohne Ziel und ohne benannte Herkunft bleibt nur, was der Aufruf selbst
    // mitgibt (das Familie-Widget rechnet sein Ziel zur Laufzeit, nennt aber
    // die Herkunft).
    const slug = slugOf(widgetHeader(id, 'Titel', null, href, null, seal));
    if (!slug) offenders.push(`${id}: kein Modulton (weder Ziel noch sealSlug) in ${text}`);
    else if (!known.has(slug)) offenders.push(`${id}: --module-${slug} gibt es nicht (${text})`);
  }
  assert.ok(viaConstant >= 2, 'Reichweite: der Budget-Kopf (Route mit Query) ist dabei');
  assert.deepEqual(offenders, []);

  // Und die Regel selbst, an den Formen, die eine Adresse haben kann.
  for (const href of ['/budget?tab=budget', '/budget#monat', '/budget/', '/budget/x?y=1']) {
    assert.equal(slugOf(widgetHeader('budget', 'Budget', null, href)), 'budget', href);
  }
});

test('das Raster hat eine eigene h2 - die Widgets haengen nicht unter „Heute wichtig"', () => {
  const html = renderDashboardLayout([{ id: 'clock', visible: true, size: '1x1' }], {}, null, 'EUR');
  const gridAt = html.indexOf('dashboard__grid');
  assert.ok(gridAt > 0, 'Reichweite: das Raster wurde gerendert');
  const before = html.slice(0, gridAt);
  const h2 = before.match(/<h2\b([^>]*)>([\s\S]*?)<\/h2>/);
  assert.ok(h2, 'vor dem Raster steht eine h2');
  assert.match(h2[2], /dashboard\.widgetsHeading/, 'mit eigenem Text, nicht dem Titel des Kopfbands');
  // Und das Raster verweist auf sie - dann traegt der Bereich denselben Namen.
  const id = h2[1].match(/id="([^"]+)"/)?.[1];
  assert.ok(id, 'die h2 hat eine id');
  assert.match(html, new RegExp(`aria-labelledby="${id}"`), 'und der Rasterbereich nennt sich nach ihr');
});

test('die Bearbeiten-Leiste jeder Kachel nennt die Kachel', () => {
  // Per Tab hoerte man je Kachel denselben Griff („Widget umsortieren") und
  // dieselben Groessenknoepfe - die Leiste steht VOR der Ueberschrift der
  // Kachel, also fehlte beim Betreten jeder Hinweis, WELCHE man gerade anfasst.
  global.window ??= { yuvomi: null };
  const html = renderDashboardLayout([
    { id: 'clock', visible: true, size: '1x1' },
    { id: 'weather', visible: true, size: '2x1' },
  ], {}, null, 'EUR', { editing: true });
  const bars = [...html.matchAll(/<div class="widget-edit-controls"([^>]*)>/g)].map((m) => m[1]);
  assert.equal(bars.length, 1, 'Reichweite: eine Leiste je gerenderter Kachel (Wetter ohne Daten faellt weg)');
  for (const attrs of bars) {
    assert.match(attrs, /role="group"/, 'die Leiste ist eine Gruppe');
    assert.match(attrs, /aria-label="dashboard\.clock"/, `und traegt den Namen der Kachel: ${attrs}`);
  }
});

test('die Kennzahlen-Reihe hat eine Ueberschrift', () => {
  // Die Modulfreigabe fragt `window.yuvomi` - ohne Shell ist jedes Modul frei.
  global.window ??= { yuvomi: null };
  const data = {
    budget: { entryCount: 3, balance: 120, income: 200 },
    birthdays: [{ days_until: 3, name: 'Anna', kind: 'birthday' }],
    pinnedNotes: [{ id: 1, pinned: 1 }], pinnedNotesCount: 1,
  };
  const html = renderMetricTiles(data, 'EUR');
  assert.ok(/metric-tiles/.test(html), `Reichweite: die Reihe wurde gerendert: ${html.slice(0, 120)}`);
  const h3 = html.match(/<h3\b([^>]*)>([\s\S]*?)<\/h3>/);
  assert.ok(h3, 'die Kachelreihe war das einzige Widget ohne Ueberschrift');
  assert.match(h3[2], /dashboard\.metrics/, 'sie heisst wie das Widget in der Anpassen-Leiste');
});

// ── Re-Critique 2026-09-27 (R8): Ziele, die luegen oder schweigen ─────────────

const { familyManageHref, customizeHasChanges, todayMoreRoute, renderDashboardOverview, renderTodayCockpit } = __test;
const { toLocalDateKey } = await import('../public/utils/date.js');
const { readFile } = await import('node:fs/promises');
const dashboardSource = await readFile(new URL('../public/pages/dashboard.js', import.meta.url), 'utf8');

function familyWidgetOf(html) {
  const at = html.indexOf('widget--family');
  assert.ok(at >= 0, `Reichweite: das Familie-Widget wurde gerendert: ${html.slice(0, 160)}`);
  return html.slice(at);
}

test('„Verwalten" am Familie-Widget fuehrt an das Familienblatt - und nur, wer es oeffnen darf, sieht ihn (H1)', () => {
  global.window ??= { yuvomi: null };
  // Ohne bekannte Haushaltsgroesse ist niemand solo (utils/household.js).
  {
    const users = [
      { id: 1, display_name: 'Alex', role: 'admin' },
      { id: 2, display_name: 'Leo', role: 'member' },
    ];
    const cfg = [{ id: 'family', visible: true, size: '1x2' }];
    // Die Wurzel stellt das zuletzt besuchte Blatt her (pages/settings.js):
    // ein Link dorthin landet irgendwo. Ohne Ziel gibt es keinen Link.
    const bare = familyWidgetOf(renderDashboardLayout(cfg, { users }, null, 'EUR'));
    assert.doesNotMatch(bare, /href="\/settings"/, 'nie die Einstellungs-Wurzel');

    const admin = familyWidgetOf(renderDashboardLayout(cfg, { users }, null, 'EUR',
      { familyManage: familyManageHref({ role: 'admin' }) }));
    assert.match(admin, /<a href="\/settings\/admin\/family"[^>]*class="widget__link"/, 'Admin: fest ans Familienblatt');

    assert.equal(familyManageHref({ role: 'member' }), null, 'Mitglied darf das Blatt nicht oeffnen');
    const member = familyWidgetOf(renderDashboardLayout(cfg, { users }, null, 'EUR',
      { familyManage: familyManageHref({ role: 'member' }) }));
    assert.doesNotMatch(member, /widget__link/, 'Mitglied: kein Link, der auf das eigene Konto umleitet');

    // Die Verdrahtung: der echte Aufruf reicht das Ziel des angemeldeten Nutzers durch.
    assert.match(dashboardSource,
      /renderDashboardLayout\(cfg, data, weather, currency, \{[^}]*familyManage: familyManageHref\(user\)/,
      'rebuildDashboard gibt familyManageHref(user) an das Raster');
  }
});

test('der Anpassen-Modus hat kein X, das still verwirft - nur Abbrechen und Speichern (H2)', () => {
  global.window ??= { yuvomi: null };
  const user = { display_name: 'Linda' };
  const editing = renderDashboardOverview(user, true, null, { followsDefault: true, canPublish: false });
  assert.match(editing, /id="dashboard-customize-cancel"/, 'Reichweite: die Leiste steht');
  assert.match(editing, /id="dashboard-customize-save"/);
  assert.doesNotMatch(editing, /id="dashboard-customize-btn"/, 'kein zweiter Ausgang neben Abbrechen');
  assert.doesNotMatch(editing, /dashboard\.customizeExit/, 'kein „Anpassung beenden"');
  const normal = renderDashboardOverview(user, false, null, { followsDefault: true, canPublish: false });
  assert.match(normal, /id="dashboard-customize-btn"/, 'der Einstieg bleibt');
});

test('die globale Suche ist von der Uebersicht mit einem Tipp erreichbar, und nicht mitten im Anpassen (R11 S1)', () => {
  global.window ??= { yuvomi: null };
  const user = { display_name: 'Linda' };
  const normal = renderDashboardOverview(user, false, null, { followsDefault: true, canPublish: false });
  // D1 (Critique 2026-10-16): dieselbe Kopf-Icon-Haut wie jeder Modulkopf.
  assert.match(normal, /<button class="btn btn--secondary btn--icon dashboard-icon-btn" id="dashboard-search"[^>]*aria-label="nav\.search"[^>]*aria-haspopup="dialog"/,
    'ein benannter Icon-Knopf in der Kopf-Icon-Haut (btn--secondary btn--icon) wie die zwei daneben');
  for (const id of ['dashboard-wall-enter', 'dashboard-customize-btn']) {
    assert.match(normal, new RegExp(`<button class="btn btn--secondary btn--icon dashboard-icon-btn" id="${id}"`), `${id}: Kopf-Icon-Haut`);
  }
  const editing = renderDashboardOverview(user, true, null, { followsDefault: true, canPublish: false });
  assert.doesNotMatch(editing, /id="dashboard-search"/, 'im Anpassen-Modus zaehlt nur Abbrechen oder Speichern');
});

test('am Wandtablett bietet der Kopf weder Anpassen noch die Suche an (#1808)', () => {
  // Beide Knoepfe enden an einer Route, die ein Display nicht erreicht:
  // `PUT /preferences` und `GET /search` antworten ihm mit 403 (gemessen am
  // echten Server in test:display-account). Der Melder ordnete sein Brett um
  // und bekam beim Speichern den englischen Rohtext der Scope-Sperre.
  global.window ??= { yuvomi: null };
  const mensch = renderDashboardOverview({ display_name: 'Linda' }, false, null, {});
  // BEIM MENSCHEN ZUERST: eine Zusicherung ueber eine Abwesenheit braucht den
  // Gegenfall, sonst ist sie auch gruen, wenn der Kopf die Knoepfe gar nicht
  // mehr zeichnet.
  assert.match(mensch, /id="dashboard-customize-btn"/, 'der Mensch behaelt den Einstieg');
  assert.match(mensch, /id="dashboard-search"/, 'und die Suche');

  const tablett = renderDashboardOverview({ display_name: 'Kueche', access_scope: 'display' }, false, null, {});
  assert.doesNotMatch(tablett, /id="dashboard-customize-btn"/, 'kein Einstieg in eine Anordnung, die sich nicht speichern laesst');
  assert.doesNotMatch(tablett, /id="dashboard-search"/, 'keine Suche, die nur 403 antworten kann');
  // Der Wandmodus bleibt: er ist ein Zustand der Seite und schreibt nichts.
  assert.match(tablett, /id="dashboard-wall-enter"/, 'der Wandmodus gehoert gerade an dieses Geraet');
  // Ein Ausgaben-Gast oder ein anderes enges Konto ist nicht mitgemeint:
  // `/preferences` steht ihnen offen.
  const gast = renderDashboardOverview({ display_name: 'Gast', access_scope: 'split_guest' }, false, null, {});
  assert.match(gast, /id="dashboard-customize-btn"/, 'die Regel haengt am Display, nicht an jedem engen Konto');
});

test('Abbrechen fragt nur, wenn es etwas zu verlieren gibt (H2)', () => {
  const saved = [{ id: 'tasks', visible: true, size: '2x1', order: 0 }, { id: 'notes', visible: true, size: '1x1', order: 1 }];
  const same = saved.map((w) => ({ ...w }));
  assert.equal(customizeHasChanges({ widgetConfig: same, savedWidgetConfig: saved, glanceVisible: true, savedGlanceVisible: true }), false);
  const hidden = saved.map((w, i) => (i === 1 ? { ...w, visible: false } : { ...w }));
  assert.equal(customizeHasChanges({ widgetConfig: hidden, savedWidgetConfig: saved, glanceVisible: true, savedGlanceVisible: true }), true);
  assert.equal(customizeHasChanges({ widgetConfig: same, savedWidgetConfig: saved, glanceVisible: false, savedGlanceVisible: true }), true,
    'das Kopfband zaehlt mit');
  // Verdrahtung: Abbrechen laeuft ueber die Rueckfrage, nicht direkt ins Verwerfen.
  assert.match(dashboardSource, /'#dashboard-customize-cancel'\)\?\.addEventListener\('click', requestCancelDashboardConfig/);
  const body = dashboardSource.match(/async function requestCancelDashboardConfig\(\) \{([\s\S]*?)\n {2}\}/)?.[1] ?? '';
  // Die Rueckfrage ist seit A7 P2-1 (2026-09-28) EINE Funktion fuer Abbrechen
  // und Verlassen - gemessen wird, dass sie an der Aenderung haengt und die
  // Verwerfen-Frage ist, nicht wie sie heisst.
  assert.match(body, /if \(customizeHasChanges\([\s\S]*?confirmDiscardCustomize\(/, 'die Rueckfrage haengt an der Aenderung');
  assert.match(dashboardSource, /const confirmDiscardCustomize = \(\) => confirmModal\(t\('modal\.unsavedChanges'\)/,
    'und sie ist die Verwerfen-Frage');
});

test('„+N weitere heute" ist ein Weg dorthin, wo die verdeckten Zeilen stehen (H13)', () => {
  const day = '2026-09-27';
  assert.equal(todayMoreRoute([{ route: '/tasks' }, { route: '/tasks' }], day), '/tasks?due=today',
    'nur Aufgaben: die Liste, gefiltert auf bis heute faellig (S2)');
  assert.equal(todayMoreRoute([{ route: '/calendar?open=4&date=2026-09-27' }, { route: '/calendar?open=5' }], day),
    '/calendar?date=2026-09-27', 'mehrere Termine: der Tag, nicht ein einzelnes Vorkommen');
  assert.equal(todayMoreRoute([{ route: '/tasks' }, { route: '/calendar?open=4' }], day), '/calendar?date=2026-09-27',
    'heute faellige Aufgabe mit Termin: der Kalendertag zeigt beides');
  assert.equal(todayMoreRoute([{ route: '/pantry?filter=soon' }], day), '/pantry?filter=soon', 'ein Modul allein: sein Ziel samt Filter');
  assert.equal(todayMoreRoute([], day), null);
  // Codex an #1485: ein Link nur, wenn EINE Ansicht ALLE verdeckten Zeilen zeigt.
  assert.equal(todayMoreRoute([{ route: '/tasks' }, { route: '/health' }], day), null,
    'Aufgabe plus Dosis: die Aufgabenliste zeigt die Dosis nicht');
  assert.equal(todayMoreRoute([{ route: '/calendar?open=4' }, { route: '/waste' }], day), null,
    'Termin plus Nicht-Kalender: kein Tag, der beides zeigt');
  assert.equal(todayMoreRoute([{ route: '/tasks', overdue: true }, { route: '/calendar?open=4' }], day), null,
    'eine ueberfaellige Aufgabe steht nicht am heutigen Kalendertag');
  assert.equal(todayMoreRoute([{ route: '/tasks', overdue: true }, { route: '/tasks' }], day), '/tasks?due=today',
    'der Filter schliesst Ueberfaelliges ein');
  assert.equal(todayMoreRoute([{ route: '/tasks' }, { route: null }], day), null, 'eine Zeile ohne Ziel hat keine Ansicht');
  assert.equal(todayMoreRoute([{ route: '/budget?tab=a' }, { route: '/budget?tab=b' }], day), null,
    'zwei Filter desselben Moduls sind zwei Ansichten');

  global.window ??= { yuvomi: null };
  const todayStr = toLocalDateKey(new Date());
  const urgentTasks = Array.from({ length: 8 }, (_, i) => ({
    id: i + 1, title: `Aufgabe ${i + 1}`, due_date: todayStr,
    due_time: `${String(8 + i).padStart(2, '0')}:00`, status: 'open', assigned_users: [],
  }));
  const html = renderTodayCockpit({ urgentTasks }, []);
  const more = html.match(/<(a|div)\b[^>]*class="today-cockpit__more[^"]*"[^>]*>/);
  assert.ok(more, `Reichweite: acht Aufgaben laufen ueber den Deckel: ${html.slice(0, 200)}`);
  assert.equal(more[1], 'a', 'die Fusszeile ist ein Link, keine Sackgasse');
  assert.match(more[0], /href="\/tasks\?due=today"/, 'die Liste, gefiltert auf die Zeilen dieses Blatts (S2)');
  assert.match(more[0], /data-route="\/tasks\?due=today"/, 'wireLinks haengt an data-route');
});

test('Codex an #1485: gemischte verdeckte Zeilen klappen an Ort und Stelle auf, statt in eine halbe Ansicht zu fuehren', () => {
  const hadWindow = 'window' in globalThis;
  const prevWindow = globalThis.window;
  globalThis.window = { yuvomi: null };
  try {
    const todayStr = toLocalDateKey(new Date());
    // Sieben ueberfaellige Aufgaben und ein ganztaegiger Termin: der Deckel
    // behaelt sechs Aufgaben, verdeckt bleiben eine Aufgabe und der Termin -
    // die Aufgabe steht nicht am heutigen Kalendertag, der Termin nicht in der
    // Aufgabenliste.
    const urgentTasks = Array.from({ length: 7 }, (_, i) => ({
      id: i + 1, title: `Aufgabe ${i + 1}`, due_date: '2000-01-01', status: 'open', assigned_users: [],
    }));
    const upcomingEvents = [{ id: 40, title: 'Elternabend', start_datetime: todayStr, all_day: 1 }];
    const html = renderTodayCockpit({ urgentTasks, upcomingEvents }, [], false, { moreOpen: false });
    const more = html.match(/<(a|div|button)\b[^>]*class="today-cockpit__more[^"]*"[^>]*>/);
    assert.ok(more, `Reichweite: die Zeilen laufen ueber den Deckel: ${html.slice(0, 200)}`);
    assert.equal(more[1], 'button', 'kein Link in eine Ansicht, die nur einen Teil zeigt');
    assert.match(more[0], /today-cockpit__more--link/, 'dieselbe Optik wie der Link');
    assert.match(more[0], /aria-expanded="false"/);
    const controls = more[0].match(/aria-controls="([^"]+)"/)?.[1];
    assert.ok(controls, 'der Knopf nennt, was er aufklappt');
    // Der Knopf steht seit dem Entwurf „Heute wichtig" in der Fussleiste, rechts neben der Coda.
    const region = html.match(new RegExp(`<div\\b[^>]*id="${controls}"[^>]*>([\\s\\S]*?)</div>\\s*<div class="today-cockpit__foot">\\s*(?:<span class="today-cockpit__coda">[^<]*</span>)?\\s*<button`));
    assert.ok(region, 'die verdeckten Zeilen stehen im Markup');
    assert.match(region[0], /\bhidden\b/, 'zugeklappt');
    assert.match(region[1], /Elternabend/, 'der verdeckte Termin');
    assert.match(region[1], /Aufgabe 7/, 'die verdeckte Aufgabe');
    assert.doesNotMatch(html, /<a\b[^>]*today-cockpit__more/);
  } finally {
    if (hadWindow) globalThis.window = prevWindow;
    else delete globalThis.window;
  }
});

test('Codex an #1485: der Aufklapp-Knopf schaltet an Ort und Stelle, und ein zweiter Tipp klappt zu', () => {
  const { wireTodayMore } = __test;
  assert.equal(typeof wireTodayMore, 'function', 'die Verdrahtung ist erreichbar');
  const region = { hidden: true };
  const label = { textContent: 'dashboard.todayMore' };
  const attrs = { 'aria-expanded': 'false', 'aria-controls': 'today-cockpit-more' };
  let onClick = null;
  let focusMoved = false;
  const button = {
    dataset: { moreLabel: 'dashboard.todayMore', lessLabel: 'dashboard.todayLess' },
    getAttribute: (name) => attrs[name] ?? null,
    setAttribute: (name, value) => { attrs[name] = String(value); },
    querySelector: (sel) => (sel === 'span' ? label : null),
    addEventListener: (type, fn) => { if (type === 'click') onClick = fn; },
    focus: () => { focusMoved = true; },
  };
  const root = {
    querySelectorAll: (sel) => (sel === '[data-today-more]' ? [button] : []),
    querySelector: (sel) => (sel === '#today-cockpit-more' ? region : null),
  };
  wireTodayMore(root);
  assert.ok(onClick, 'der Knopf hat einen Klick-Handler');
  onClick({ currentTarget: button });
  assert.equal(attrs['aria-expanded'], 'true');
  assert.equal(region.hidden, false, 'die verdeckten Zeilen stehen da');
  assert.equal(label.textContent, 'dashboard.todayLess');
  onClick({ currentTarget: button });
  assert.equal(attrs['aria-expanded'], 'false', 'der zweite Tipp klappt zu');
  assert.equal(region.hidden, true);
  assert.equal(label.textContent, 'dashboard.todayMore');
  assert.equal(focusMoved, false, 'der Fokus bleibt, wo er ist');
  // Verdrahtung: der echte Seitenweg ruft sie auf.
  assert.match(dashboardSource, /function wireLinks\([^)]*\) \{[\s\S]{0,400}wireTodayMore\(container\)/);
});

test('die Heute-Zeile nennt den Titel vor der Person (H13, A7 Sam)', () => {
  global.window ??= { yuvomi: null };
  {
    const todayStr = toLocalDateKey(new Date());
    const html = renderTodayCockpit({
      urgentTasks: [{
        id: 1, title: 'Einverstaendnis abgeben', due_date: todayStr, due_time: '09:00', status: 'open',
        assigned_users: [{ id: 3, display_name: 'Linda Johnson', avatar_color: '#6a5acd' }],
      }],
    }, []);
    assert.match(html, /seal-pair__who/, 'Reichweite: das Zeichen erscheint');
    const row = html.match(/<(?:a|button)\b[^>]*today-cockpit-card[\s\S]*?<\/(?:a|button)>/)?.[0] ?? '';
    const spoken = accessibleText(row);
    assert.ok(spoken.indexOf('Einverstaendnis abgeben') >= 0 && spoken.indexOf('Linda Johnson') >= 0,
      `Titel und Person werden beide gesprochen: ${spoken}`);
    assert.ok(spoken.indexOf('Einverstaendnis abgeben') < spoken.indexOf('Linda Johnson'),
      `der Titel kommt vor dem Namen: ${spoken}`);
  }
});

// ── R9 M7 (Re-Critique 2026-09-27, A7 P1-2): Anpassen-Modus mobil ─────────────
// Gemessen bei 390px vorher: Kopf 248px (Leiste in drei Zeilen), erstes
// Widget y 946, Bedienleiste je Kachel 114px (zwei Zeilen). Nachher: Kopf
// 135px, "Heute wichtig" y 199, erstes Rasterwidget y 833, Leiste 58px.

test('R9 M7: mobil eine Kopfzeile [Abbrechen] Titel [Fertig], Reichweite als Fussnote', async () => {
  const { eachRule } = await import('./css-rules.js');
  const css = await readFile(new URL('../public/styles/dashboard.css', import.meta.url), 'utf8');
  const editing = renderDashboardOverview({ display_name: 'Linda' }, true, null, { followsDefault: false, canPublish: true });
  const bar = editing.slice(editing.indexOf('dashboard-customize-toolbar'));
  const order = ['dashboard-customize-toolbar__title', 'id="dashboard-customize-cancel"', 'id="dashboard-customize-save"'].map((s) => bar.indexOf(s));
  assert.ok(order.every((i) => i > 0), `Titel, Abbrechen und Fertig stehen in der Leiste: ${order}`);
  assert.match(bar, /id="dashboard-customize-save">dashboard\.customizeDone</, 'der Primaerknopf heisst wie in iOS "Fertig"');
  assert.match(bar, /data-customize-publish id="dashboard-customize-publish"/, 'breit bleiben Vorgabe und Zuruecksetzen in der Leiste');

  const foot = __test.renderCustomizeFootnote({ followsDefault: false, canPublish: true });
  assert.match(foot, /dashboard\.customizeScopeHint/, 'der Reichweiten-Satz steht in der Fussnote');
  assert.match(foot, /data-customize-publish/);
  assert.match(foot, /data-customize-reset/);
  assert.doesNotMatch(foot, /\bid="/, 'eine Id gibt es einmal - die Fussnote verdrahtet ueber Datenattribute');
  assert.match(dashboardSource, /\$\{isCustomizing \? renderCustomizeFootnote\(\{ followsDefault, canPublish \}\) : ''\}/, 'die Fussnote steht unter dem Raster, nur im Anpassen-Modus');
  assert.match(dashboardSource, /querySelectorAll\('\[data-customize-publish\]'\)\.forEach/, 'beide Orte laufen durch denselben Handler');

  const rules = [...eachRule(css)];
  const phone = (r) => r.at.some((a) => /\(max-width:\s*639px\)/.test(a));
  const body = (sel, pred) => rules.filter((r) => pred(r) && r.selector.split(',').some((s) => s.trim() === sel)).map((r) => r.body).join(';');
  assert.match(body('.dashboard-overview__header--editing', phone), /grid-template-areas:\s*"tools\s+tools"/, 'die Leiste steht mobil ueber Datum und Gruss');
  assert.match(body('.dashboard-overview__header--editing .dashboard-customize-scope', phone), /display:\s*none/, 'kein Reichweiten-Satz im mobilen Kopf');
  assert.match(body('.dashboard-customize-toolbar', phone), /grid-template-columns:\s*auto minmax\(0, 1fr\) auto/, 'drei Spalten: Abbrechen, Titel, Fertig');
  assert.match(body('.dashboard-customize-footnote', phone), /display:\s*flex/);
  assert.match(body('.dashboard-customize-footnote', (r) => !r.at.length), /display:\s*none/, 'breit steht die Reichweite im Kopf, nicht doppelt');
});

test('R9 M7: einspaltig bietet die Kachel EIN Groessen-Menue mit nur den wirksamen Hoehen', async () => {
  const { eachRule } = await import('./css-rules.js');
  const css = await readFile(new URL('../public/styles/dashboard.css', import.meta.url), 'utf8');
  const menu = __test.renderWidgetSizeMenu('tasks', '2x1');
  const items = [...menu.matchAll(/role="menuitemradio" aria-checked="(true|false)"[^>]*data-widget-size-preset="([\dx]+)" data-widget-id="tasks"/g)].map((m) => `${m[2]}:${m[1]}`);
  assert.deepEqual(items, ['2x1:true', '2x2:false'], 'nur die Hoehen bei gleicher Breite - die Breite wirkt einspaltig nicht');
  const trigger = menu.match(/data-widget-size-menu="tasks"\s+popovertarget="([^"]+)"/);
  assert.ok(trigger, 'der Knopf traegt seine Kachel (Fokus nach dem Neuaufbau) und oeffnet sein Panel');
  assert.match(menu, new RegExp(`id="${trigger[1]}" popover role="menu"`));
  assert.deepEqual([...__test.renderWidgetSizeMenu('notes', '1x2').matchAll(/data-widget-size-preset="([\dx]+)"/g)].map((m) => m[1]), ['1x1', '1x2']);

  assert.match(dashboardSource, /'data-widget-size-preset', 'data-widget-size-menu'/, 'der Menue-Knopf ist eine Fokus-Identitaet');
  assert.match(dashboardSource, /installPopoverMenus\(container\)/, 'Position, Pfeiltasten und Schliessen kommen vom geteilten Menue');
  // Seit DW-P2-1 ein Handler am Zuhoerer der Flaeche (wireDashboardEditMode).
  const handler = dashboardSource.slice(dashboardSource.indexOf('const resize = (btn) => {'));
  assert.match(handler.slice(0, 900), /menu\.hidePopover\?\.\(\);\s*grid\.querySelector\(`\[popovertarget=/, 'nach der Wahl gehoert der Fokus dem Menue-Knopf');

  const rules = [...eachRule(css)];
  const oneCol = (r) => r.at.some((a) => /\(max-width:\s*767px\)/.test(a));
  const body = (sel, pred) => rules.filter((r) => pred(r) && r.selector.split(',').some((s) => s.trim() === sel)).map((r) => r.body).join(';');
  assert.match(body('.widget-edit-controls__size', oneCol), /display:\s*none/, 'einspaltig keine vier Knoepfe');
  assert.match(body('.widget-edit-controls__size-menu', oneCol), /display:\s*inline-flex/, 'einspaltig das Menue');
  assert.match(body('.widget-edit-controls__size-menu', (r) => !r.at.length), /display:\s*none/, 'mehrspaltig bleiben die vier Knoepfe');
  assert.match(css, /@media \(min-width: 768px\)\s*\{\s*\.dashboard__grid\s*\{\s*grid-template-columns:\s*repeat\(2, 1fr\)/,
    'die Menue-Grenze ist die Grenze des Rasters - wandert sie, muss das Menue mit');
});

// Hauptsession-Entscheid R9 (i9): mobil klappt "Heute wichtig" beim Anpassen
// auf seine Kopfzeile zusammen - dort wird nichts angeordnet, und das 613px
// hohe Band schob das erste Rasterwidget auf y 833 von 844. Die Kopfzeile
// bleibt stehen, weil sie den Ausblenden-Knopf des Bands traegt (#740).
test('R9 M7: mobil klappt "Heute wichtig" beim Anpassen auf die Kopfzeile zusammen', async () => {
  const { eachRule } = await import('./css-rules.js');
  const css = await readFile(new URL('../public/styles/dashboard.css', import.meta.url), 'utf8');
  const urgentTasks = [{ id: 1, title: 'Muell', due_date: '2026-09-27', status: 'open' }];
  const editing = renderTodayCockpit({ urgentTasks }, [], true);
  const viewing = renderTodayCockpit({ urgentTasks }, [], false);
  assert.match(editing, /<section class="today-cockpit today-cockpit--editing"/, 'das Band traegt den Modus');
  assert.match(editing, /data-glance-hide/, 'die Kopfzeile behaelt den Ausblenden-Knopf');
  assert.match(viewing, /<section class="today-cockpit"/);
  assert.doesNotMatch(viewing, /today-cockpit--editing/, 'ausserhalb des Anpassens bleibt das Band offen');

  const rules = [...eachRule(css)];
  const phone = (r) => r.at.some((a) => /\(max-width:\s*639px\)/.test(a));
  const hides = rules.filter((r) => phone(r) && /display:\s*none/.test(r.body)
    && r.selector.split(',').some((s) => s.trim() === '.today-cockpit--editing .today-cockpit__grid'));
  assert.equal(hides.length, 1, 'unter 640px faellt der Inhalt des Bands im Anpassen-Modus weg');
  assert.ok(!rules.some((r) => !phone(r) && /today-cockpit--editing/.test(r.selector)),
    'breit bleibt das Band beim Anpassen offen - dort steht es neben dem Raster nicht im Weg');
});

// -------------------------------------------------------------------------
// Anpassen-Modus verliert nichts still (Re-Critique 2026-09-28, A7 P2-1)
// -------------------------------------------------------------------------

test('Verlassen-Schutz: ohne Waechter frei, ein Nein haelt, ein Fehler sperrt nicht, Abmelden trifft nur den eigenen', async () => {
  const { setLeaveGuard, mayLeave } = await import('../public/utils/leave-guard.js');
  assert.equal(await mayLeave('/calendar'), true, 'ohne Waechter geht jeder Wechsel');
  const gefragt = [];
  const abmelden = setLeaveGuard(async (to) => { gefragt.push(to); return false; });
  assert.equal(await mayLeave('/calendar'), false, 'ein Nein haelt die Seite');
  assert.deepEqual(gefragt, ['/calendar'], 'der Waechter erfaehrt das Ziel');
  const zweiter = setLeaveGuard(() => { throw new Error('kaputt'); });
  const fehler = console.error;
  console.error = () => {};
  try {
    assert.equal(await mayLeave('/tasks'), true, 'ein werfender Waechter sperrt die Navigation nicht');
  } finally {
    console.error = fehler;
  }
  abmelden();
  assert.equal(await mayLeave('/tasks'), true, 'ist aber noch der aktive - die alte Abmeldung nimmt ihn nicht weg');
  zweiter();
  assert.equal(await mayLeave('/tasks'), true);
});

test('Anpassen: Verlassen fragt wie Abbrechen - nur mit Aenderung, ein Nein bleibt', async () => {
  const lauf = async ({ customizing = true, changed = false, answer = true, saveDuringDialog = false } = {}) => {
    let modus = customizing;
    const log = [];
    const ok = await __test.customizeLeaveAllowed({
      customizing: () => modus,
      changed: () => changed,
      askDiscard: async () => { log.push('confirm'); if (saveDuringDialog) modus = false; return answer; },
      discard: () => { log.push('discard'); modus = false; },
    });
    return { ok, log, modus };
  };
  assert.deepEqual(await lauf({ customizing: false }), { ok: true, log: [], modus: false }, 'ausserhalb des Modus fragt nichts');
  assert.deepEqual(await lauf({ changed: false }), { ok: true, log: ['discard'], modus: false },
    'ohne Aenderung kein Dialog, der Modus endet mit dem Wechsel');
  assert.deepEqual(await lauf({ changed: true, answer: false }), { ok: false, log: ['confirm'], modus: true },
    'mit Aenderung und Nein: die Anordnung bleibt, die Seite auch');
  assert.deepEqual(await lauf({ changed: true, answer: true }), { ok: true, log: ['confirm', 'discard'], modus: false },
    'mit Aenderung und Ja: verworfen und weiter');
  assert.equal((await lauf({ changed: true, answer: false, saveDuringDialog: true })).ok, true,
    'wurde im Dialog schon beendet, gibt es nichts mehr zu halten');
});

test('Anpassen: der Speed-Dial ist ausgeblendet, und der Neuaufbau meldet den Schutz an', async () => {
  // Der KNOPF wird versteckt, nicht die Gruppe: an `.page-fab:not([hidden])`
  // haengen Kapselreserve und --fab-safe-zone (layout.css), und
  // `.page-fab[hidden]` blendet ihn aus - test:hidden-cascade haelt die Regel.
  const gruppe = { hidden: false, style: {} };
  const fab = { hidden: false, style: {}, closest: (sel) => (sel === '.page-fab-group' ? gruppe : null) };
  const vorher = globalThis.document;
  globalThis.document = { ...(vorher ?? {}), getElementById: (id) => (id === 'fab-main' ? fab : null) };
  try {
    __test.setCustomizeFabHidden(true);
    assert.equal(fab.hidden, true, 'der Knopf ist aus - und mit ihm die Reserve fuer ihn');
    assert.equal(gruppe.hidden, false, 'die Gruppe bleibt: eine versteckte Gruppe hielte die Reserve');
    __test.setCustomizeFabHidden(false);
    assert.equal(fab.hidden, false);
  } finally {
    globalThis.document = vorher;
  }
  const { readFileSync } = await import('node:fs');
  const src = readFileSync(new URL('../public/pages/dashboard.js', import.meta.url), 'utf8');
  const rebuild = src.slice(src.indexOf('function rebuildDashboard('), src.indexOf('setHtml(shell, `\n      <section class="dashboard-masthead'));
  assert.ok(/syncLeaveGuard\(\);/.test(rebuild), 'jeder Neuaufbau gleicht den Verlassen-Schutz mit dem Modus ab');
  assert.ok(/setCustomizeFabHidden\(isCustomizing\);/.test(rebuild), 'und blendet den Speed-Dial mit dem Modus');
  assert.ok(/setLeaveGuard\(\(\) => customizeLeaveAllowed\(/.test(src), 'der Schutz ist die Rueckfrage von Abbrechen');
});

// navigate() steht seit #1657 in utils/router-navigate.js; der Router reicht
// ihm den Verlassen-Schutz als Abhaengigkeit. Die Textguards unten lesen den
// Kopf der Funktion deshalb dort und pruefen am Router die Uebergabe.
const NAVIGATE_GETS_LEAVE_GUARD = /createNavigate\(routerState, \{[^}]*\bhasLeaveGuard, mayLeave\b[^}]*\}\)/;
function navigateHead(readFileSync) {
  const source = readFileSync(new URL('../public/utils/router-navigate.js', import.meta.url), 'utf8');
  const start = source.indexOf('async function navigate(');
  const lock = source.indexOf('state.isNavigating = true;', start);
  assert.ok(start > 0 && lock > start, 'navigate() oder die Sperre nicht gefunden');
  return source.slice(start, lock);
}

test('Router: jeder Wechsel einer angemeldeten Sitzung fragt den Verlassen-Schutz, bevor er navigiert (A7 P2-1)', async () => {
  const { readFileSync } = await import('node:fs');
  const router = readFileSync(new URL('../public/router.js', import.meta.url), 'utf8');
  assert.match(router, /import \{[^}]*\bmayLeave\b[^}]*\} from '\/utils\/leave-guard\.js';/);
  assert.match(router, NAVIGATE_GETS_LEAVE_GUARD, 'der Router reicht den Schutz an navigate() weiter');
  const head = navigateHead(readFileSync);
  assert.match(head, /if \(state\.currentUser && typeof userOrPushState !== 'object' &&[^\n]*!\(await mayLeave\(path\)\)\)/,
    'der Schutz steht VOR isNavigating = true - sonst blockierte die offene Rueckfrage jede weitere Navigation');
  assert.match(head, /userOrPushState === false && state\.currentPath\)[\s\S]*history\.pushState\(\{ path: /,
    'ein abgelehntes Zurueck legt die Adresse zurueck');
});

test('Router: ohne angemeldeten Waechter bleibt der Wechsel ohne Yield - zwei Klicks starten keine zwei Navigationen', async () => {
  const { readFileSync } = await import('node:fs');
  const { setLeaveGuard, hasLeaveGuard } = await import('../public/utils/leave-guard.js');
  assert.equal(hasLeaveGuard(), false, 'ohne Anmeldung kein Waechter');
  const abmelden = setLeaveGuard(() => true);
  assert.equal(hasLeaveGuard(), true);
  abmelden();
  assert.equal(hasLeaveGuard(), false, 'die Abmeldung nimmt ihn weg');
  // `if (isNavigating) return; isNavigating = true;` war ein Paar ohne Luecke.
  // Ein `await` dazwischen oeffnet eine: ein zweiter synchroner Aufruf (Doppelklick,
  // popstate waehrend eines Klicks) saehe noch `isNavigating === false`. Gefragt
  // und gewartet wird daher nur, wenn eine Seite wirklich etwas zu verlieren hat.
  const router = readFileSync(new URL('../public/router.js', import.meta.url), 'utf8');
  assert.match(router, /import \{ hasLeaveGuard, mayLeave \} from '\/utils\/leave-guard\.js';/);
  assert.match(router, NAVIGATE_GETS_LEAVE_GUARD, 'der Router reicht den Schutz an navigate() weiter');
  const head = navigateHead(readFileSync);
  assert.match(head, /hasLeaveGuard\(\) && !\(await mayLeave\(path\)\)/,
    'erst der synchrone Blick auf den Waechter, dann das await');
});

test('Router: ein abgelehntes Zurueck legt die Adresse erst zurueck, wenn der Dialog seinen Marker zurueckgab', async () => {
  const { readFileSync } = await import('node:fs');
  const head = navigateHead(readFileSync);
  // Im Browser gemessen: ohne das Warten stand nach "Abbrechen" /calendar in der
  // Adresse, waehrend die Uebersicht zu sehen war (test:overlay-history haelt den Mechanismus).
  assert.match(head, /await whenHistorySettled\(\);\s*\n\s*history\.pushState\(\{ path: stay \}/,
    'erst das back() der Rueckfrage, dann der eigene Eintrag');
});

// -------------------------------------------------------------------------
// R14 P2 (Re-Critique 2026-09-28, A7 P2-2): Uebersicht mobil - Orientierung
// statt Buehne. Gemessen vorher bei 390x844: "Heute wichtig" y157-748 (591px),
// fuenfmal "Ueberfaellig", zwei Zeilen 87px durch Umbruch neben dem Label,
// erstes Widget y760, Seite 3192px.
// -------------------------------------------------------------------------

/** Ein Fenster, das auf die Telefon-Frage `matches` antwortet - eigener Stub je Test. */
async function withStage(phone, fn) {
  const hadWindow = 'window' in globalThis;
  const prevWindow = globalThis.window;
  globalThis.window = {
    yuvomi: null,
    matchMedia: (q) => ({ matches: phone && /max-width:\s*639px/.test(q), media: q, addEventListener() {}, removeEventListener() {} }),
  };
  try {
    return await fn();
  } finally {
    if (hadWindow) globalThis.window = prevWindow;
    else delete globalThis.window;
  }
}

function overdueDay() {
  return '2000-01-01';
}

function fiveOverdue() {
  const who = [
    { id: 3, display_name: 'Linda Johnson', avatar_color: '#6a5acd' },
    { id: 4, display_name: 'Emma Johnson', avatar_color: '#c2185b' },
    { id: 5, display_name: 'Alex Johnson', avatar_color: '#1565c0' },
  ];
  return Array.from({ length: 5 }, (_, i) => ({
    id: i + 1, title: `Rueckstand ${i + 1}`, due_date: overdueDay(), status: 'open', assigned_users: [who[i % 3]],
  }));
}

test('R14 P2: mobil stehen mehrere Ueberfaellige als EINE Sammelzeile, die an Ort und Stelle aufklappt', () => withStage(true, () => {
  const todayStr = toLocalDateKey(new Date());
  const html = renderTodayCockpit({
    urgentTasks: fiveOverdue(),
    upcomingEvents: [{ id: 40, title: 'Elternabend', start_datetime: todayStr, all_day: 1 }],
  }, [], false, { overdueOpen: false });
  const group = html.match(/<button\b[^>]*data-today-overdue[^>]*>[\s\S]*?<\/button>/)?.[0];
  assert.ok(group, `eine Sammelzeile steht im Blatt: ${html.slice(0, 300)}`);
  assert.match(group, /today-cockpit-card/, 'sie hat die Anatomie einer Heute-Zeile');
  assert.match(group, /aria-expanded="false"/);
  assert.match(group, /dashboard\.todayOverdueCount\{(?:"|&quot;)count(?:"|&quot;):5\}/, 'sie nennt die Zahl, nicht fuenf Zeilen');
  // renderAvatarStack ist im Loader ein Stub - gemessen wird, wen die Zeile nennt.
  assert.match(accessibleText(group), /Linda Johnson, Emma Johnson, Alex Johnson/, 'wen es angeht, jede Person einmal');
  assert.match(group, /today-cockpit-card__trail/, 'die Avatare stehen am Ende, wo sonst die Zeit steht');
  const controls = group.match(/aria-controls="([^"]+)"/)?.[1];
  assert.ok(controls, 'der Knopf nennt, was er aufklappt');
  const region = html.match(new RegExp(`<div\\b[^>]*id="${controls}"[^>]*>`))?.[0];
  assert.ok(region, 'die fuenf Zeilen stehen im Markup');
  assert.match(region, /\bhidden\b/, 'zugeklappt');
  for (let i = 1; i <= 5; i += 1) assert.match(html, new RegExp(`Rueckstand ${i}`));
  assert.equal((html.match(/today-cockpit-card__time--overdue/g) ?? []).length, 0,
    'kein fuenffaches rotes "Ueberfaellig" - die Sammelzeile sagt es einmal');
  assert.match(html, /Elternabend/, 'der Rest des Tages bleibt');
}));

test('#1828 Sammelzeile: eine ueberfaellige Aufgabe fuer zwei nennt BEIDE, nicht nur die erste Person', () => withStage(true, () => {
  const linda = { id: 3, display_name: 'Linda Johnson', avatar_color: '#6a5acd' };
  const emma = { id: 4, display_name: 'Emma Johnson', avatar_color: '#c2185b' };
  const html = renderTodayCockpit({
    urgentTasks: [
      { id: 1, title: 'Rueckstand 1', due_date: overdueDay(), status: 'open', assigned_users: [linda, emma] },
      { id: 2, title: 'Rueckstand 2', due_date: overdueDay(), status: 'open', assigned_users: [linda] },
    ],
  }, [], false, { overdueOpen: false });
  const group = html.match(/<button\b[^>]*data-today-overdue[^>]*>[\s\S]*?<\/button>/)?.[0];
  assert.ok(group, `eine Sammelzeile steht im Blatt: ${html.slice(0, 300)}`);
  assert.match(accessibleText(group), /Linda Johnson, Emma Johnson/, 'Emma ist nur ueber die gemeinsame Aufgabe dran und steht trotzdem da');
  assert.equal((accessibleText(group).match(/Linda Johnson/g) ?? []).length, 1, 'jede Person einmal');
}));

test('R14 P2: am Desktop bleiben die Zeilen einzeln, und eine einzelne Ueberfaellige wird nie gesammelt', async () => {
  await withStage(false, () => {
    const html = renderTodayCockpit({ urgentTasks: fiveOverdue() }, []);
    assert.doesNotMatch(html, /data-today-overdue/, 'breit ist Platz fuer die Zeilen');
  });
  await withStage(true, () => {
    const html = renderTodayCockpit({ urgentTasks: fiveOverdue().slice(0, 1) }, []);
    assert.doesNotMatch(html, /data-today-overdue/, 'eine Zeile braucht keine Sammlung');
    assert.match(html, /Rueckstand 1/);
  });
});

test('R14 P2: mobil deckelt das Blatt bei zwei Zeilen, die Sammelzeile zaehlt als eine, Einkauf klappt mit', () => withStage(true, () => {
  const todayStr = toLocalDateKey(new Date());
  // Die Uhr steht fest auf 13:00: die Termine liegen am Abend und waren
  // nach 21 Uhr schon vorbei - dann fiel der Test je nach Tageszeit. Um 13:00
  // ist das Mittagessen schon dran, also nicht „das Naechste" (nextFirst).
  const now = new Date(`${todayStr}T13:00:00`);
  const upcomingEvents = [1, 2, 3].map((i) => ({ id: 40 + i, title: `Termin ${i}`, start_datetime: `${todayStr}T2${i}:00:00` }));
  const model = __test.buildTodayCockpitModel({ urgentTasks: fiveOverdue(), upcomingEvents }, [], { now });
  assert.equal(model.rows.length, 2, `zwei Zeilen auf dem Telefon, erhalten: ${model.rows.map((r) => r.title)}`);
  assert.equal(model.rows[0].kind, 'overdue', 'das Offene bleibt unter dem Deckel');
  assert.equal(model.overflow, 2, 'der Rest steht hinter "+N weitere"');
  // Termine plus Essen: keine Ansicht zeigt beides, also klappt die Fusszeile auf.
  // So bleiben die verdeckten Zeilen gemischt (Termine und Essen), und nur dann klappt der Einkauf mit.
  // Seit D1 (Critique 2026-10-26, Lauf 2) steht eine Mahlzeit nur als Zeile, solange ihre Zeit
  // noch kommt: um 13:00 ist das Mittagessen vorbei. Der Snack rueckt als Naechstes nach vorn
  // (nextFirst), das Abendessen bleibt verdeckt.
  const shop = { urgentTasks: fiveOverdue(), upcomingEvents, todayMeals: [{ id: 9, meal_type: 'snack', title: 'Obst' }, { id: 10, meal_type: 'dinner', title: 'Pasta' }],
    shoppingLists: [{ id: 1, name: 'Wocheneinkauf', open_count: 7 }] };
  const withShop = renderTodayCockpit(shop, [], false, { now, moreOpen: false });
  assert.match(withShop, /dashboard\.todayShopping</, 'Reichweite: die Einkaufszeile steht im Blatt');
  const regionStart = withShop.indexOf('id="today-cockpit-more"');
  // Der Knopf am Ende der Liste - nicht das Bild ueber den Zeilen, das seit D3
  // (Lauf 2) dieselbe Region steuert.
  const button = withShop.indexOf('<button type="button" class="today-cockpit__more');
  const shopAt = withShop.indexOf('dashboard.todayShopping<');
  assert.ok(regionStart > 0 && regionStart < shopAt && shopAt < button,
    'auf dem Telefon steht der Einkauf hinter dem Knopf, nicht als eigene Zeile darunter');
  assert.match(withShop, /dashboard\.todayMore\{(?:"|&quot;)count(?:"|&quot;):5\}/, 'und der Knopf zaehlt ihn mit (drei Termine, Abendessen, Einkauf)');
  const wall = __test.buildTodayCockpitModel({ urgentTasks: fiveOverdue() }, [], { cap: 8, groupOverdue: false });
  assert.equal(wall.rows.filter((r) => r.overdue).length, 5, 'die Wand bekommt ihre Zeilen, wenn sie es sagt');
}));

test('R14 P2: die Sammelzeile ist verdrahtet, und der Wand-Aufruf sammelt nicht', () => {
  assert.equal(typeof __test.wireTodayOverdue, 'function');
  assert.match(dashboardSource, /function wireLinks\([^)]*\) \{[\s\S]{0,200}wireTodayOverdue\(container\)/);
  assert.match(dashboardSource, /buildTodayCockpitModel\(data, \[\], \{ cap, now, groupOverdue: false(?:, [^}]*)?\}\)/,
    'die Wand ist eine Anzeige ohne Bedienung - dort klappt nichts auf');
});

test('R14 P2: mobil bricht die Heute-Zeile nicht neben ihrem Label um, und die violette Haarlinie ist weg', async () => {
  const { eachRule } = await import('./css-rules.js');
  const css = await readFile(new URL('../public/styles/dashboard.css', import.meta.url), 'utf8');
  const rules = [...eachRule(css)];
  const phone = (r) => r.at.some((a) => /\(max-width:\s*639px\)/.test(a));
  const body = (sel, pred) => rules.filter((r) => pred(r) && r.selector.split(',').some((s) => s.trim() === sel)).map((r) => r.body).join(';');
  assert.match(body('.today-cockpit-card__value', phone), /-webkit-line-clamp:\s*1/, 'eine Zeile Titel auf dem Telefon');
  assert.doesNotMatch(body('.today-cockpit', (r) => !r.at.length), /border-top/, 'keine Deko-Linie zwischen Gruss und Blatt (A7 P3)');
});

test('R14 P2: Listenkacheln zeigen auf dem Telefon die kurze Fassung', () => withStage(true, () => {
  assert.equal(__test.listRowCap('1x2'), 3, 'hoch heisst auf dem Telefon nicht fuenf Zeilen');
  return withStage(false, () => assert.equal(__test.listRowCap('1x2'), 5, 'am Desktop traegt die hohe Kachel fuenf'));
}));

test('R14 P2: Anpassen mobil ist eine kompakte Liste - Name, Griff, Auge - und der Vorrat steht oben', async () => {
  const { eachRule } = await import('./css-rules.js');
  const css = await readFile(new URL('../public/styles/dashboard.css', import.meta.url), 'utf8');
  const cfg = [
    { id: 'notes', visible: true, size: '1x2' },
    { id: 'budget', visible: true, size: '1x1' },
    // Die Uhr, nicht das Wetter: das Wetter ist erst verfuegbar, wenn der
    // Wetter-Proxy es eingerichtet meldet, und diese Sonde laedt nichts.
    { id: 'clock', visible: false, size: '1x1' },
  ];
  global.window ??= { yuvomi: null };
  const html = renderDashboardLayout(cfg, {}, null, 'EUR', { editing: true });
  assert.match(html, /class="widget-edit-controls__caption"[^>]*>[^<]*\S/, 'jede Leiste traegt den Namen ihrer Kachel');
  const tray = html.indexOf('class="widget-restore"');
  const grid = html.indexOf('id="dashboard-widget-grid"');
  assert.ok(tray > 0 && grid > 0, 'Reichweite: Vorrat und Raster stehen da');
  assert.ok(tray < grid, 'der Wieder-Einblenden-Vorrat steht ueber dem Raster');

  const rules = [...eachRule(css)];
  const phone = (r) => r.at.some((a) => /\(max-width:\s*639px\)/.test(a));
  const body = (sel, pred) => rules.filter((r) => pred(r) && r.selector.split(',').some((s) => s.trim() === sel)).map((r) => r.body).join(';');
  assert.match(body('.widget-wrapper--editing > :not(.widget-edit-controls)', phone), /display:\s*none/, 'mobil keine Kachel-Inhalte beim Anordnen');
  assert.match(body('.widget-restore__chips', phone), /flex-wrap:\s*nowrap/, 'der Vorrat oben ist eine Zeile, keine Wand');
  assert.match(body('.widget-edit-controls__caption', phone), /display:\s*block/, 'mobil steht der Name in der Zeile');
  assert.match(body('.widget-edit-controls__caption', (r) => !r.at.length), /display:\s*none/, 'breit traegt der Kachelkopf den Namen');
});

// R14 P12 (Re-Critique 2026-09-28, A8 P3-2): die Uebersicht war der einzige
// schwebende FAB am Desktop (48x48 @1360,820, nur "Schnellaktionen" als Name);
// jedes andere Modul dockt als Pille mit Nomen im Kopf an.
test('R14: am Desktop traegt die Uebersicht "+ Neu" als angedockte Pille mit demselben Menue', () => withStage(false, () => {
  const desk = { ...globalThis.window, matchMedia: (q) => ({ matches: /min-width:\s*1024px/.test(q), media: q }) };
  globalThis.window = desk;
  const header = renderDashboardOverview({ display_name: 'Linda' }, false, null, {});
  const pill = header.match(/<button\b[^>]*id="fab-main"[^>]*>[\s\S]*?<\/button>/)?.[0];
  assert.ok(pill, 'die Pille steht im Kopf');
  assert.match(pill, /class="page-fab btn btn--primary page-fab--docked/, 'dieselbe angedockte Form wie jedes Modul');
  assert.match(pill, /data-dock-label="dashboard\.fabNew"/);
  assert.match(pill, /<span class="toolbar-new-btn__label">dashboard\.fabNew<\/span>/, 'sichtbares Wort, nicht nur ein Plus');
  assert.match(pill, /aria-haspopup="menu"/);
  const target = pill.match(/popovertarget="([^"]+)"/)?.[1];
  assert.ok(target, 'die Pille oeffnet ein Menue');
  const menu = header.match(new RegExp(`<div class="popover-menu" id="${target}" popover role="menu">([\\s\\S]*?)</div>`))?.[1] ?? '';
  for (const route of ['/tasks', '/calendar', '/shopping', '/notes']) {
    assert.match(menu, new RegExp(`role="menuitem"[^>]*data-new-route="${route.replace('/', '\\/')}"`), `${route} steht im Menue`);
  }
  assert.match(header, /class="page-toolbar__actions dashboard-overview__new"/, 'der Slot, in den die Shell andockt');
  assert.equal(__test.renderFab(), '', 'kein schwebender Speed-Dial daneben');
  const editing = renderDashboardOverview({ display_name: 'Linda' }, true, null, {});
  assert.doesNotMatch(editing, /id="fab-main"/, 'im Anpassen-Modus gibt es kein Anlegen');
  // Seit U2 reist der Gastgeber mit (user, refresh): das Blatt geht ueber der Uebersicht auf.
  assert.match(dashboardSource, /function wireNewMenu\(container, signal, host = \{\}\)/);
  assert.match(dashboardSource, /wireNewMenu\(container, signal, \{ user, refresh: refreshAfterSheet \}\)/);
}));

test('R14: auf dem Telefon bleibt der Speed-Dial in der Kapsel', () => withStage(true, () => {
  assert.match(__test.renderFab(), /class="page-fab-group"/);
  assert.doesNotMatch(renderDashboardOverview({ display_name: 'Linda' }, false, null, {}), /id="fab-main"/);
}));

// Critique 2026-10-16: jede Kachel fuehrt mit „Alle" zu ihrer Seite, nur die
// Familie sagte „Verwalten" fuer denselben Weg. Und die Onboarding-Karte trug
// Haarlinie plus 28px-Schatten (Detektor gpt-thin-border-wide-shadow): sie
// nimmt jetzt das Material der schwebenden Tafel (glass.css).
test('Dashboard: ein Wort fuer den Kopf-Link, Onboarding-Karte als schwebende Tafel (Critique 2026-10-16)', async () => {
  const { eachRule } = await import('./css-rules.js');
  const { readFileSync } = await import('node:fs');
  assert.match(dashboardSource, /widgetHeader\('family', t\('dashboard\.familyTitle'\), null, manageHref, null, 'contacts'\)/,
    'die Familie nimmt das gemeinsame Link-Wort');
  assert.doesNotMatch(dashboardSource, /t\('dashboard\.manage'\)/);
  const css = readFileSync(new URL('../public/styles/dashboard.css', import.meta.url), 'utf8');
  const card = [...eachRule(css)].find((r) => !r.at.length && r.selector.trim() === '.onboarding-card');
  assert.match(card?.body ?? '', /border:\s*none/, 'keine Haarlinie');
  assert.match(card?.body ?? '', /box-shadow:\s*var\(--glass-shadow-lg\), var\(--glass-inset-elevated\)/, 'Tiefe und Lichtkante der schwebenden Tafel');
});

// R20 (Re-Critique 2026-10-17, A1 P3): Esc beendete das Anpassen nicht - am
// Telefon war "Abbrechen" der einzige Weg. Esc nimmt denselben Weg wie der
// Knopf (mit Rueckfrage bei Aenderungen) und laesst offene Dialoge und Menues
// ihr eigenes Esc behalten.
test('R20: Esc beendet das Anpassen wie "Abbrechen", nicht an einem offenen Dialog vorbei', async () => {
  const { readFileSync } = await import('node:fs');
  const src = readFileSync(new URL('../public/pages/dashboard.js', import.meta.url), 'utf8');
  const at = src.indexOf("if (event.key !== 'Escape' || event.defaultPrevented || !isCustomizing) return;");
  assert.ok(at > 0, 'kein Esc-Ausstieg aus dem Anpassen');
  const block = src.slice(src.lastIndexOf('if (isCustomizing) {', at), src.indexOf('}, { signal: signal });', at));
  assert.match(block, /document\.addEventListener\('keydown'/);
  assert.match(block, /dialog\[open\]/, 'ein offener Dialog behaelt sein Esc');
  assert.match(block, /requestCancelDashboardConfig\(\)/, 'derselbe Weg wie der Knopf, mit Rueckfrage');
});

/* DIE ZIELE DES HEUTE-BLATTS (Critique R22, D3, a6 P2). Termin, Mahlzeit,
 * Medikament und Haushaltshilfe fuehrten ungleich weit: der Termin verliess die
 * Uebersicht (/calendar?open=7), die Aufgabe oeffnete ihr Blatt ueber ihr, und
 * Mahlzeit und Dosis landeten an der Wurzel ihres Moduls ohne Fokus. Jetzt
 * oeffnet der Termin sein Leseblatt ueber der Uebersicht (calendar.js
 * openEventById, wie openTaskById), und wo es kein Blatt gibt, nennt die Zeile
 * ihr Objekt: Mahlzeit `?open=`, Dosis der Bereich, Geburtstag `?open=`.
 * Gemessen im Browser (s1/probes/dash.mjs): Termin -> "/" mit Blatt. */
test('R22 D3: ein Termin aus der Uebersicht oeffnet sein Blatt ueber ihr, die anderen Zeilen nennen ihr Objekt', async () => {
  const { readFileSync } = await import('node:fs');
  const { eventLinkOf } = await import('../public/pages/dashboard.js');
  assert.deepEqual(eventLinkOf('/calendar?open=7&date=2026-10-23'), { id: '7', date: '2026-10-23' });
  assert.deepEqual(eventLinkOf('/calendar?open=7'), { id: '7', date: null });
  assert.equal(eventLinkOf('/calendar?date=2026-10-23'), null, 'ein Tag ist kein Termin');
  assert.equal(eventLinkOf('/calendar?open=7.2026-10-23'), null, 'die Auswahl-Form der Agenda bleibt dem Kalender');
  assert.equal(eventLinkOf('/tasks?open=7'), null);

  const dash = readFileSync(new URL('../public/pages/dashboard.js', import.meta.url), 'utf8');
  const wire = dash.slice(dash.indexOf('function wireLinks('), dash.indexOf('function reorderWidgetConfig('));
  assert.match(wire, /const eventLink = editing \? null : eventLinkOf\(el\.dataset\.route\);/);
  assert.match(wire, /\? \(\) => openEventFromOverview\(eventLink, el, \{ container, refresh, user, signal \}\)/, 'der Termin geht ueber das Blatt, nicht ueber navigate()');
  assert.match(dash, /const \{ openEventById \} = await import\('\/pages\/calendar\.js'\);/, 'nachgeladen wie die Aufgabe');
  const cal = readFileSync(new URL('../public/pages/calendar.js', import.meta.url), 'utf8');
  assert.match(cal, /export async function openEventById\(id, \{ date = null, anchor = null, user = null, onChanged = null, onRemoving = null, signal = null \} = \{\}\)/);

  const { buildTodayProgram } = __test;
  // Jede Tageszeit belegt: selectTodayMeal waehlt nach der Uhr, gefunden wird immer id 16.
  const meals = Object.fromEntries(['breakfast', 'lunch', 'dinner'].map((type) => [type, { id: 16, title: 'Porridge' }]));
  const program = buildTodayProgram({ todayMeals: meals, upcomingEvents: [], urgentTasks: [] }, { includeTasks: false, includeCalendar: false });
  const meal = (Array.isArray(program) ? program : program.rows).find((row) => row.kind === 'meal');
  assert.equal(meal?.route, '/meals?open=16', 'die Mahlzeit nennt sich selbst');
  assert.match(dash, /route: highlights\.meal\.id != null \? `\/meals\?open=\$\{encodeURIComponent\(String\(highlights\.meal\.id\)\)\}` : '\/meals',/);

  const { TODAY_SHEET_SOURCES } = await import('../public/utils/today-sheet.js');
  const ctx = { todayKey: '2026-10-23', tomorrowKey: '2026-10-24', nowTime: '09:00', existing: [] };
  const doses = TODAY_SHEET_SOURCES.find((s) => s.id === 'doses').collect({ health: { dosesTotal: 1, dosesTaken: 0, nextDose: { name: 'Eisen', time: '08:00' } } }, ctx);
  assert.equal(doses[0].route, '/health/meds', 'die Dosis fuehrt in den Bereich, in dem eingenommen wird');
  const birthdays = TODAY_SHEET_SOURCES.find((s) => s.id === 'birthdays').collect({ birthdays: [{ id: 4, name: 'Oma', days_until: 0 }] }, ctx);
  assert.equal(birthdays[0].route, '/birthdays?open=4', 'der Geburtstag nennt sich selbst');
});

// R22-F (F1 Punkt 1): das Blatt eines Termins ueber der Uebersicht trug nur
// "Im Kalender oeffnen" - Bearbeiten hiess, die Uebersicht zu verlassen
// (gemessen 390/1440: Fuss ["Im Kalender oeffnen"], kein Bearbeiten). Jetzt
// bietet es Loeschen und Bearbeiten wie im Kalender, holt Mitglieder, Kalender
// und Praeferenzen fuer das Formular selbst und meldet sich nach dem
// Schreiben bei der Uebersicht. Am echten Aufrufer: openEventById mit den
// Stubs aus test-browser-loader.mjs (Detailansicht, API, Rueckgaengig).
test('R22-F: ein Termin wird ueber der Uebersicht bearbeitet und geloescht, die Uebersicht frischt auf', async () => {
  globalThis.window ??= {};
  globalThis.window.matchMedia ??= () => ({ matches: false, addEventListener() {}, removeEventListener() {} });
  globalThis.ResizeObserver ??= class { observe() {} disconnect() {} };
  const priorYuvomi = globalThis.window.yuvomi;
  const navigated = [];
  globalThis.window.yuvomi = { showToast: () => {}, navigate: (to) => navigated.push(to) };
  const event = { id: 7, title: 'Sportfest', start_datetime: '2026-10-23', end_datetime: '2026-10-23', all_day: 1, assigned_users: [], external_source: 'local' };
  const calls = [];
  let opened = null;
  let undo = null;
  globalThis.__apiStub = {
    get: async (path) => {
      calls.push(`GET ${path}`);
      if (path === '/calendar/7') return { data: event };
      if (path === '/family/members') return { data: [{ id: 1, display_name: 'Linda' }, { id: 2, display_name: 'Alex' }] };
      if (path === '/calendar/calendars') return { data: [{ id: 3, name: 'Familie', is_default: 1 }] };
      if (path === '/preferences') return { data: { calendar_default_duration: 45 } };
      return { data: [] };
    },
    delete: async (path) => { calls.push(`DELETE ${path}`); return { data: null }; },
  };
  globalThis.__openDetailView = (opts) => { opened = opts; };
  globalThis.__undoStub = (opts) => { undo = opts; };
  const changed = [];
  const removing = [];
  try {
    const { openEventById, __test: cal } = await import('../public/pages/calendar.js');
    await openEventById(7, {
      date: '2026-10-23',
      user: { id: 1, role: 'admin' },
      onChanged: () => { changed.push('rerender'); },
      onRemoving: (scope, on) => removing.push([scope.eventId, on]),
    });
    assert.ok(opened, 'das Blatt geht auf');
    const ids = (opened.actions ?? []).map((a) => a.id);
    assert.ok(ids.includes('detail-delete'), `Loeschen steht im Fuss: ${ids}`);
    assert.ok(!ids.includes('detail-open-calendar'), 'kein Umweg in den Kalender mehr');
    assert.equal(typeof opened.edit?.mount, 'function', 'Bearbeiten steht im Blatt');
    await opened.edit.ready;
    assert.deepEqual(cal.state.users.map((u) => u.display_name), ['Linda', 'Alex'], 'die Mitglieder fuer die Zuweisung sind geladen');
    assert.equal(cal.state.localCalendars.length, 1, 'die eigenen Kalender sind geladen');
    assert.equal(cal.state.defaultDuration, 45, 'die Praeferenzen sind angewandt');
    assert.equal(navigated.length, 0, 'kein Modulwechsel');

    // Loeschen: die Zeile geht sofort, Rueckgaengig holt sie zurueck.
    await opened.actions.find((a) => a.id === 'detail-delete').onClick({ close: async () => {} });
    assert.deepEqual(removing, [[7, true]], 'die Zeilen des Termins sind ausgeblendet');
    assert.ok(undo, 'Loeschen mit Rueckgaengig');
    undo.restore();
    assert.deepEqual(removing, [[7, true], [7, false]], 'Rueckgaengig blendet sie wieder ein');

    // Noch einmal, jetzt bis zum Schreiben: danach frischt die Uebersicht auf.
    undo = null;
    await opened.actions.find((a) => a.id === 'detail-delete').onClick({ close: async () => {} });
    await undo.commit({ keepalive: false });
    assert.ok(calls.includes('DELETE /calendar/7'), 'der Termin ist geloescht');
    assert.deepEqual(changed, ['rerender'], 'die Uebersicht frischt nach dem Schreiben auf');
    assert.equal(navigated.length, 0, 'auch danach kein Modulwechsel');
  } finally {
    delete globalThis.__apiStub;
    delete globalThis.__openDetailView;
    delete globalThis.__undoStub;
    globalThis.window.yuvomi = priorYuvomi;
  }

  // Speichern: ohne Kalenderseite zeichnet es keine Ansicht, es meldet sich.
  const { readFileSync } = await import('node:fs');
  const cal = readFileSync(new URL('../public/pages/calendar.js', import.meta.url), 'utf8');
  const save = cal.slice(cal.indexOf('async function saveEvent('), cal.indexOf('async function deleteEvent('));
  assert.match(save, /if \(hosted\) renderView\(\);\n    else await notifyAwayChanged\(\);/, 'Speichern frischt die Seite unter dem Blatt auf');
  assert.match(save, /if \(reloadAfter && hosted\)/, 'und laedt keine Kalenderansicht, die nicht steht');

  // Welche Zeilen der Uebersicht ein Loeschen mitnimmt.
  const { eventRowRemovedBy } = await import('../public/pages/dashboard.js');
  const row = (id, date) => ({ id: String(id), date });
  assert.equal(eventRowRemovedBy(row(7, '2026-10-23'), { eventId: 7, seriesId: 7, scope: 'all' }), true);
  assert.equal(eventRowRemovedBy(row(8, '2026-10-23'), { eventId: 7, seriesId: 7, scope: 'all' }), false, 'ein anderer Termin bleibt');
  assert.equal(eventRowRemovedBy(row(7, '2026-10-24'), { eventId: 7, seriesId: 7, scope: 'this', occurrenceDate: '2026-10-23' }), false, 'nur dieser Tag');
  assert.equal(eventRowRemovedBy(row(7, '2026-10-23'), { eventId: 7, seriesId: 7, scope: 'this', occurrenceDate: '2026-10-23' }), true);
  assert.equal(eventRowRemovedBy(row(7, '2026-10-22'), { eventId: 7, seriesId: 7, scope: 'following', recurrenceId: '2026-10-23' }), false, 'vor dem Vorkommen bleibt');
  assert.equal(eventRowRemovedBy(row(7, '2026-10-30'), { eventId: 7, seriesId: 7, scope: 'following', recurrenceId: '2026-10-23' }), true, 'danach geht mit');
});

// R22 D16 (Critique 2026-10-22, a1 P3): neben vier Chips der Ablage stand ein
// freier Regler-Kreis ohne Wort. Die Optionen stehen jetzt AM Chip - ein
// geteilter Knopf, dessen Pfeil ein Menue mit Wort oeffnet.
test('R22 D16: die Optionen einer ausgeblendeten Kachel stehen am Chip, in einem Menue mit Wort', async () => {
  global.window ??= { yuvomi: null };
  const html = renderDashboardLayout([
    { id: 'notes', visible: true, size: '1x1' },
    { id: 'tasks', visible: false, size: '1x1' },
    { id: 'clock', visible: false, size: '1x1' },
  ], {}, null, 'EUR', { editing: true });
  const tray = html.slice(html.indexOf('class="widget-restore"'), html.indexOf('id="dashboard-widget-grid"'));
  assert.ok(tray.length > 0, 'Reichweite: die Ablage steht da');
  assert.doesNotMatch(tray, /widget-restore-chip__options/, 'kein freier Regler-Kreis mehr');
  const split = tray.slice(tray.indexOf('widget-restore-chip-group--split'));
  assert.match(split, /data-widget-show="tasks"/, 'der Chip blendet weiter mit einem Tipp ein');
  assert.match(split, /class="widget-restore-chip__more popover-menu__trigger"[^>]*aria-haspopup="menu"/, 'am Chip der Pfeil ins Menue');
  assert.match(split, /role="menuitem"[\s\S]*?data-widget-show="tasks"[\s\S]*?role="menuitem"[\s\S]*?data-widget-options="tasks"/,
    'das Menue nennt beide Handlungen mit Wort');
  const clock = tray.slice(tray.indexOf('data-widget-show="clock"') - 200, tray.indexOf('data-widget-show="clock"'));
  assert.doesNotMatch(clock, /--split/, 'ohne Optionen bleibt es ein einfacher Chip');
});

// --------------------------------------------------------------------------
// DW-P3-2: DIE FEHLERKACHEL HAT DEN KOPF JEDER KACHEL. Sie baute ihren eigenen
// (`<span class="widget__title">` + nackte Glyphe): kein Siegel, keine h3 - in
// der Ueberschriften-Navigation fehlte genau die Kachel, die gerade kaputt ist.
// --------------------------------------------------------------------------
test('DW-P3-2: die Fehlerkachel traegt eine h3 mit Siegel ihres Moduls und die ruhige Zeile mit Wiederholen', () => {
  for (const [id, slug] of [['tasks', 'tasks'], ['schedule', 'schedule'], ['nutrition', 'health'], ['weather', 'dashboard'], ['family', 'contacts']]) {
    const html = __test.renderWidgetError(id);
    assert.match(html, /<h3 class="widget__title">/, `${id}: der Kopf ist eine Ueberschrift`);
    assert.match(html, new RegExp(`<span class="module-seal module-seal--sm" style="--seal-accent: var\\(--module-${slug}, var\\(--color-accent\\)\\)"`),
      `${id}: das Vollton-Siegel nennt die Herkunft (${slug})`);
    assert.doesNotMatch(html, /widget__title-icon|<span class="widget__title"/, `${id}: kein eigener Kopf-Dialekt`);
    assert.match(html, /role="alert"/, `${id}: der Fehler wird angesagt`);
    // Die Zeile: Satz, dann EIN Knopf, der auf den Satz verweist.
    assert.match(html, new RegExp(`class="card-empty-row widget__empty"[\\s\\S]*id="widget-empty-${id}"[\\s\\S]*data-widget-retry="${id}"`));
    assert.match(html, new RegExp(`aria-describedby="widget-empty-${id}"[^>]*data-widget-retry="${id}"|data-widget-retry="${id}"[^>]*aria-describedby="widget-empty-${id}"`),
      `${id}: "Erneut versuchen" nennt, was nicht geladen wurde`);
  }
});

// --------------------------------------------------------------------------
// U7 (Ulas, WCAG 2.5.7): AM ZEIGER UMORDNEN OHNE ZIEHEN. Hoch/Runter stehen nur
// am Finger (DW-P2-3); wer die Maus fuehrt und nicht ziehen kann, hatte nur die
// Pfeiltasten am Griff. Jetzt traegt JEDE Kachel ein Menue (ihr Optionen-
// Knopf als Ausloeser) mit "Nach vorn" und "Nach hinten" - am Rand gesperrt,
// wie "nach oben" an der ersten Kategorie (Menue-Kanon, layout.css).
// --------------------------------------------------------------------------
test('U7: jede Kachel hat ein Menue mit Nach vorn / Nach hinten - Eintraege mit Namen, am Rand gesperrt', () => {
  const entries = (html) => [...html.matchAll(/<button type="button" role="menuitem"( disabled)?\s+class="popover-menu__item"\s+data-action="([^"]+)"([^>]*)>\s*<i[^>]*><\/i>\s*<span>([^<]*)<\/span>/g)]
    .map(([, disabled, action, attrs, label]) => `${action}${/data-widget-move="(up|down)"/.exec(attrs)?.[1] ? `:${/data-widget-move="(up|down)"/.exec(attrs)[1]}` : ''}=${label}${disabled ? ' (gesperrt)' : ''}`);
  for (const id of ['birthdays', 'calendar']) {
    const w = { id, size: '1x1', visible: true };
    const first = __test.renderWidgetCustomizeControls(w, 0, 3);
    const mid = __test.renderWidgetCustomizeControls(w, 1, 3);
    const last = __test.renderWidgetCustomizeControls(w, 2, 3);
    const trigger = mid.match(/<button type="button" class="widget-edit-controls__options popover-menu__trigger"\s+popovertarget="([^"]+)" aria-haspopup="menu" aria-expanded="false"\s+aria-label="([^"]+)"/);
    assert.ok(trigger, `${id}: der Optionen-Knopf oeffnet ein Menue`);
    assert.equal(trigger[1], `widget-tile-menu-${id}`);
    assert.match(trigger[2], new RegExp(`common\\.moreActionsNamed.*${id === 'birthdays' ? 'nav.birthdays' : 'nav.calendar'}|common\\.moreActionsNamed`), `${id}: der Knopf nennt seine Kachel`);
    const options = id === 'calendar' ? ['widget-options=dashboard.optionsFor'] : [];
    const expected = (up, down) => [`widget-move:up=dashboard.customizeMoveForward${up ? ' (gesperrt)' : ''}`, `widget-move:down=dashboard.customizeMoveBack${down ? ' (gesperrt)' : ''}`];
    assert.deepEqual(entries(mid).map((e) => e.replace(/\{.*$/, '')), [...expected(false, false), ...options], `${id}: mitten in der Reihe`);
    assert.deepEqual(entries(first).map((e) => e.replace(/\{.*$/, '')).slice(0, 2), expected(true, false), `${id}: an erster Stelle geht es nicht weiter nach vorn`);
    assert.deepEqual(entries(last).map((e) => e.replace(/\{.*$/, '')).slice(0, 2), expected(false, true), `${id}: an letzter Stelle nicht weiter nach hinten`);
    assert.match(mid, /data-widget-move="down" data-widget-id="[^"]+"/, 'der Eintrag traegt seine Kachel - derselbe Handler wie Hoch/Runter');
  }
});

// U10 (Ulas 2026-10-27): AM FINGER IST DER OPTIONEN-KNOPF EIN TIPP. Mit U7
// standen die Optionen im "..."-Menue - am Telefon zwei Tipps fuer die
// haeufigere Handlung, und das Menue wiederholte dort nur Hoch/Runter aus der
// Leiste. Jetzt traegt jede Kachel mit Optionen zusaetzlich den direkten Knopf;
// die Zeigerart entscheidet, welcher Ausloeser steht: am Finger der Knopf, am
// Zeiger das Menue (mit Nach vorn/hinten). Nie beide, nie keiner.
test('U10: am Finger oeffnet EIN Tipp die Optionen - der direkte Knopf statt des Menues, am Zeiger umgekehrt', async () => {
  const { eachRule } = await import('./css-rules.js');
  const dashboardCss = await readFile(new URL('../public/styles/dashboard.css', import.meta.url), 'utf8');
  const visible = (html) => html.replace(/<template[\s\S]*?<\/template>/g, '');
  const direct = (html) => [...visible(html).matchAll(/<button type="button" class="widget-edit-controls__options widget-edit-controls__options--direct" data-widget-options="([^"]+)"\s+aria-label="([^"]+)"/g)];
  const withOptions = __test.renderWidgetCustomizeControls({ id: 'calendar', size: '1x1' }, 1, 3);
  const [hit] = direct(withOptions);
  assert.ok(hit, 'eine Kachel mit Optionen traegt den direkten Knopf - ausserhalb des Menues, also ohne Oeffnen erreichbar');
  assert.equal(hit[1], 'calendar', 'er nennt seine Kachel - derselbe Handler wie der Menue-Eintrag ([data-widget-options])');
  assert.match(hit[2], /dashboard\.optionsFor/, 'derselbe Name wie der Eintrag im Menue');
  assert.equal(direct(__test.renderWidgetCustomizeControls({ id: 'birthdays', size: '1x1' }, 1, 3)).length, 0,
    'ohne Optionen kein Knopf - er oeffnete nichts');
  assert.match(withOptions, /class="widget-edit-controls__menu"/, 'das Menue bleibt im Markup: am Zeiger ist es der Weg zu Nach vorn/hinten');

  // Welcher Ausloeser steht, entscheidet die Zeigerart.
  const rules = [...eachRule(dashboardCss)];
  const displayOf = (selector, coarse) => rules
    .filter((r) => r.selector.split(',').map((x) => x.trim()).includes(selector)
      && (coarse ? r.at.some((a) => /\(pointer:\s*coarse\)/.test(a)) : !r.at.length))
    .map((r) => /(?:^|;)\s*display:\s*([^;]+)/.exec(r.body)?.[1]?.trim())
    .filter(Boolean)
    .at(-1);
  assert.equal(displayOf('.widget-edit-controls__options--direct', false), 'none', 'am Zeiger steht der direkte Knopf nicht - die Optionen liegen im Menue');
  assert.equal(displayOf('.widget-edit-controls__options--direct', true), 'inline-flex', 'am Finger steht der direkte Knopf');
  assert.equal(displayOf('.widget-edit-controls__menu', true), 'none', 'am Finger kein Menue: Hoch/Runter stehen in der Leiste, die Optionen am Knopf');
  assert.equal(displayOf('.widget-edit-controls__menu', false), 'inline-flex', 'am Zeiger das Menue');

  // Ein Tipp: der Klick auf den Knopf geht ohne Umweg an den Optionen-Dialog.
  const wiring = dashboardSource.slice(dashboardSource.indexOf('function wireDashboardEditMode() {'));
  const click = wiring.slice(wiring.indexOf("shell.addEventListener('click', (event) => {"));
  assert.match(click.slice(0, 900), /else if \(btn\.matches\('\[data-widget-options\]'\)\) void editOptions\(btn\);/,
    'der Knopf laeuft durch denselben Handler wie der Menue-Eintrag');
});

test('U7: die Sperre der Menue-Eintraege folgt dem Platz - auch im noch nicht geoeffneten Menue', () => {
  const btn = (dir) => ({ dataset: { widgetMove: dir }, disabled: false });
  const live = [btn('up'), btn('down')];
  const inTemplate = [btn('up'), btn('down')];
  const controls = {
    querySelectorAll(sel) {
      if (sel === '[data-widget-move]') return live;
      if (sel === '.popover-menu > template') return [{ content: { querySelectorAll: (s) => (s === '[data-widget-move]' ? inTemplate : []) } }];
      return [];
    },
    querySelector: () => null,
  };
  const wrapper = { querySelector: (sel) => (sel === ':scope > [data-widget-controls]' ? controls : null) };
  __test.syncCustomizeControls(wrapper, { id: 'birthdays', size: '1x1' }, 0, 3);
  assert.deepEqual([...live, ...inTemplate].map((b) => b.disabled), [true, false, true, false], 'erste Stelle: nach vorn gesperrt, auch im Template');
  __test.syncCustomizeControls(wrapper, { id: 'birthdays', size: '1x1' }, 2, 3);
  assert.deepEqual([...live, ...inTemplate].map((b) => b.disabled), [false, true, false, true], 'letzte Stelle: nach hinten gesperrt');
});

test('U7: ein Eintrag aus dem Menue ordnet ueber denselben Weg wie Hoch/Runter um, und der Fokus bleibt am Optionen-Knopf', () => {
  const wiring = dashboardSource.slice(dashboardSource.indexOf('function wireDashboardEditMode() {'));
  const click = wiring.slice(wiring.indexOf("shell.addEventListener('click', (event) => {"));
  assert.match(click.slice(0, 700), /if \(btn\.matches\('\.popover-menu \[data-widget-move\]'\)\) moveFromMenu\(btn\);\s*else if \(btn\.matches\('\[data-widget-move\]'\)\) move\(btn\);/,
    'der Menue-Eintrag hat seinen eigenen Weg (Fokus), vor dem Knopf');
  const fromMenu = wiring.slice(wiring.indexOf('const moveFromMenu = (item) => {'), wiring.indexOf('\n    };\n', wiring.indexOf('const moveFromMenu = (item) => {')));
  assert.match(fromMenu, /menu\?\.hidePopover\?\.\(\);/, 'das Menue schliesst');
  assert.match(fromMenu, /trigger\?\.focus\(\{ preventScroll: true \}\);[\s\S]*moveWidget\(item\.dataset\.widgetId, item\.dataset\.widgetMove\)/,
    'der Fokus geht VOR dem Umhaengen an den Ausloeser - arrangeChildren gibt ihn dann zurueck');
  const moveWidget = wiring.slice(wiring.indexOf('const moveWidget = '), wiring.indexOf('\n    };\n', wiring.indexOf('const moveWidget = ')));
  assert.match(moveWidget, /placeWidget\(/, 'moveWidget legt ueber placeWidget (Patch + Ansage "Platz n von m")');
});

// --------------------------------------------------------------------------
// DW p7, Nachtrag p5b: TERMIN BEARBEITEN UEBER DER UEBERSICHT. Das Formular
// traegt Regeln aus calendar.css (Farbwahl, Symbolwahl, Anhang); der Router
// laedt das Blatt nur fuer die Kalenderseite. Ueber der Uebersicht stand
// "Farbe" ohne einen Farbknopf (0px hoch, gemessen 390/1440).
// --------------------------------------------------------------------------
test('DW p7: openEventById leiht calendar.css fuer sein Formular - mit dem Signal der Seite darunter', async () => {
  const savedDoc = Object.getOwnPropertyDescriptor(globalThis, 'document');
  const head = [];
  const makeLink = () => {
    const listeners = {};
    return {
      rel: '', href: '', dataset: {}, isConnected: false, sheet: null,
      getAttribute(name) { return this[name] ?? null; },
      addEventListener(type, fn) { listeners[type] = fn; },
      fire(type) { listeners[type]?.(); },
      remove() { head.splice(head.indexOf(this), 1); this.isConnected = false; },
    };
  };
  const fakeDoc = {
    head: { appendChild(el) { head.push(el); el.isConnected = true; return el; } },
    querySelectorAll: () => [],
    querySelector: () => null,
    createElement: () => makeLink(),
    addEventListener() {}, removeEventListener() {},
    documentElement: { dataset: {} },
  };
  Object.defineProperty(globalThis, 'document', { value: fakeDoc, configurable: true, writable: true });
  globalThis.window ??= {};
  globalThis.window.matchMedia ??= () => ({ matches: false, addEventListener() {}, removeEventListener() {} });
  const priorYuvomi = globalThis.window.yuvomi;
  globalThis.window.yuvomi = { showToast: () => {}, navigate: () => {} };
  let opened = null;
  globalThis.__apiStub = {
    get: async (path) => {
      if (path === '/calendar/7') return { data: { id: 7, title: 'Sportfest', start_datetime: '2026-10-23', end_datetime: '2026-10-23', all_day: 1, assigned_users: [], external_source: 'local' } };
      return { data: [] };
    },
  };
  globalThis.__openDetailView = (opts) => { opened = opts; };
  const page = new AbortController();
  try {
    const { openEventById } = await import('../public/pages/calendar.js');
    await openEventById(7, { date: '2026-10-23', user: { id: 1, role: 'admin' }, onChanged: () => {}, signal: page.signal });
    assert.ok(opened, 'das Blatt geht auf');
    const lent = head.filter((el) => el.href === '/styles/calendar.css');
    assert.equal(lent.length, 1, 'calendar.css haengt am Ende von <head>, einmal');
    let ready = false;
    void Promise.resolve(opened.edit?.ready).then(() => { ready = true; });
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(ready, false, 'das Formular wartet auf das Blatt - die Farbwahl stuende sonst ohne Regeln da');
    lent[0].fire('load');
    await opened.edit.ready;
    page.abort();
    assert.equal(lent[0].isConnected, false, 'die Uebersicht geht, ihr geliehenes Blatt mit');
  } finally {
    delete globalThis.__apiStub;
    delete globalThis.__openDetailView;
    globalThis.window.yuvomi = priorYuvomi;
    if (savedDoc) Object.defineProperty(globalThis, 'document', savedDoc); else delete globalThis.document;
  }
});

// --------------------------------------------------------------------------
// DW p11 (Review zu U2): DAS ANLEGEN-BLATT GEHOERT DER SEITE, VON DER ES KAM.
// "+ Neu" wartet vor dem Oeffnen auf Daten und Seitenblatt (Kategorien,
// Mitglieder, Praeferenzen). Wechselte man in der Zeit die Seite, ging das
// Formular trotzdem auf - ueber der neuen Seite, mit `onChanged` der alten.
// Das Signal der Uebersicht nahm nur das geliehene Seitenblatt mit.
// --------------------------------------------------------------------------
test('DW p11: verlaesst man die Uebersicht, waehrend ein Anlegen-Blatt laedt, geht es nicht ueber der naechsten Seite auf', async () => {
  const savedDoc = Object.getOwnPropertyDescriptor(globalThis, 'document');
  const head = [];
  const makeLink = () => {
    const listeners = {};
    return {
      rel: '', href: '', dataset: {}, isConnected: false, sheet: null, listeners,
      getAttribute(name) { return this[name] ?? null; },
      addEventListener(type, fn) { listeners[type] = fn; },
      remove() { head.splice(head.indexOf(this), 1); this.isConnected = false; },
    };
  };
  const fakeDoc = {
    // Ein Blatt laedt einen Takt spaeter - wie im Browser nie im selben Task.
    head: { appendChild(el) { head.push(el); el.isConnected = true; setImmediate(() => { el.onload?.(); el.listeners.load?.(); }); return el; } },
    styleSheets: [],
    querySelectorAll: () => [],
    querySelector: () => null,
    getElementById: () => null,
    createElement: () => makeLink(),
    addEventListener() {}, removeEventListener() {},
    documentElement: { dataset: {} },
  };
  Object.defineProperty(globalThis, 'document', { value: fakeDoc, configurable: true, writable: true });
  globalThis.window ??= {};
  globalThis.window.matchMedia ??= () => ({ matches: false, addEventListener() {}, removeEventListener() {} });
  const priorYuvomi = globalThis.window.yuvomi;
  globalThis.window.yuvomi = { showToast: () => {}, navigate: () => {} };
  globalThis.__apiStub = {
    get: async (path) => {
      // /tasks/meta/options antwortet ohne data-Huelle (ensureAwayMeta).
      if (path === '/tasks/meta/options') return { users: [{ id: 1, display_name: 'Linda' }], categories: [{ key: 'household', label: 'Haushalt' }], tags: [] };
      if (path === '/notes/categories') return { data: [], meta: { can_manage_household: true } };
      if (path === '/preferences') return { data: {} };
      return { data: [] };
    },
  };
  const opened = [];
  globalThis.__openModal = () => { opened.push('modal'); };
  const user = { id: 1, role: 'admin' };
  // notes.js zieht Custom Elements (category-manager) mit.
  const customGlobals = { HTMLElement: class {}, customElements: { define() {}, get() {} } };
  const missingGlobals = Object.keys(customGlobals).filter((name) => !(name in globalThis));
  for (const name of missingGlobals) globalThis[name] = customGlobals[name];
  try {
    const sheets = {
      '/tasks': (await import('../public/pages/tasks.js')).openNewTask,
      '/calendar': (await import('../public/pages/calendar.js')).openNewEvent,
      '/notes': (await import('../public/pages/notes.js')).openNewNote,
    };
    for (const [route, openNew] of Object.entries(sheets)) {
      // Gegenprobe: bleibt die Uebersicht stehen, geht das Formular auf.
      opened.length = 0;
      await openNew({ user, onChanged: () => {}, signal: new AbortController().signal });
      assert.equal(opened.length, 1, `${route}: das Formular geht ueber der Uebersicht auf`);
      // Die Uebersicht geht, waehrend das Blatt noch vorbereitet.
      opened.length = 0;
      const page = new AbortController();
      const pending = openNew({ user, onChanged: () => {}, signal: page.signal });
      page.abort();
      await pending;
      assert.equal(opened.length, 0, `${route}: das Formular geht nicht ueber der naechsten Seite auf`);
    }
  } finally {
    for (const name of missingGlobals) delete globalThis[name];
    delete globalThis.__apiStub;
    delete globalThis.__openModal;
    globalThis.window.yuvomi = priorYuvomi;
    if (savedDoc) Object.defineProperty(globalThis, 'document', savedDoc); else delete globalThis.document;
  }
});

// --------------------------------------------------------------------------
// Review p11 (B7): DIE NEUE AUFGABE UEBER DER UEBERSICHT KENNT DAS
// STANDARDZIEL. Bis U2 wechselte "+ Neu > Aufgabe" auf die Aufgabenseite,
// deren render() die Praeferenzen las; das Blatt ueber der Uebersicht holte
// nur Mitglieder und Kategorien, und das Formular stand auf "Nur lokal" -
// die Aufgabe kam nie in der eingestellten CalDAV-Liste an. Der Termin holt
// seine Praeferenzen schon (loadAwayFormContext), die Notiz hat kein Ziel.
// --------------------------------------------------------------------------
test('Review p11 (B7): openNewTask uebernimmt tasks_default_target, ohne dass die Aufgabenseite stand', async () => {
  const savedDoc = Object.getOwnPropertyDescriptor(globalThis, 'document');
  const head = [];
  const fakeDoc = {
    head: { appendChild(el) { head.push(el); setImmediate(() => el.onload?.()); return el; } },
    styleSheets: [],
    querySelectorAll: () => [], querySelector: () => null, getElementById: () => null,
    createElement: () => ({ rel: '', href: '', dataset: {}, addEventListener() {} }),
    addEventListener() {}, removeEventListener() {},
    documentElement: { dataset: {} },
  };
  Object.defineProperty(globalThis, 'document', { value: fakeDoc, configurable: true, writable: true });
  globalThis.window ??= {};
  globalThis.window.matchMedia ??= () => ({ matches: false, addEventListener() {}, removeEventListener() {} });
  const priorYuvomi = globalThis.window.yuvomi;
  globalThis.window.yuvomi = { showToast: () => {}, navigate: () => {} };
  const target = 'caldav:3|https://dav.example/lists/family/';
  globalThis.__apiStub = {
    get: async (path) => {
      if (path === '/tasks/meta/options') return { users: [{ id: 1, display_name: 'Linda' }], categories: [{ key: 'household', label: 'Haushalt' }], tags: [] };
      if (path === '/preferences') return { data: { tasks_default_target: target } };
      return { data: [] };
    },
  };
  globalThis.__openModal = () => {};
  // tasks.js zieht Custom Elements mit.
  const customGlobals = { HTMLElement: class {}, customElements: { define() {}, get() {} } };
  const missingGlobals = Object.keys(customGlobals).filter((name) => !(name in globalThis));
  for (const name of missingGlobals) globalThis[name] = customGlobals[name];
  try {
    const { openNewTask, __test: tasks } = await import('../public/pages/tasks.js');
    tasks.state.defaultSyncTarget = '';
    await openNewTask({ user: { id: 1, role: 'admin' }, onChanged: () => {}, signal: new AbortController().signal });
    assert.equal(tasks.state.defaultSyncTarget, target, 'das Formular waehlt das eingestellte Ziel vor (wireSyncTarget liest state.defaultSyncTarget)');
  } finally {
    for (const name of missingGlobals) delete globalThis[name];
    delete globalThis.__apiStub;
    delete globalThis.__openModal;
    globalThis.window.yuvomi = priorYuvomi;
    if (savedDoc) Object.defineProperty(globalThis, 'document', savedDoc); else delete globalThis.document;
  }
});

// --------------------------------------------------------------------------
// DW-P2-11: EINE LEERZEILE. Naehrwerte, Entsorgung und Schnellzugriffe sagten
// "noch nichts" in drei Formen (Glyphe + Caption + Akzent-Textknopf, der je
// nach Breite rechts stand oder unter den Satz brach). Jetzt die ruhige Zeile
// der App (`cardEmptyRowHtml`, utils/empty-state.js): Satz, dann EIN
// sekundaerer Knopf am Ende, der auf den Satz verweist.
// --------------------------------------------------------------------------
test('DW-P2-11: die leeren Kacheln sprechen die eine ruhige Zeile - Satz, Aktion am Ende, kein Glyphen-Dialekt', () => {
  const rows = {
    waste: __test.renderWasteWidget({ items: [] }, '1x1'),
    quicklinks: __test.renderQuickLinks([]),
    shopping: __test.renderShoppingLists([]),
  };
  for (const [id, html] of Object.entries(rows)) {
    const row = html.match(/<div class="card-empty-row widget__empty">\s*<span class="card-empty-row__text" id="([^"]+)">[^<]+<\/span>\s*<button type="button" class="btn btn--secondary btn--sm card-empty-row__action"([^>]*)>/);
    assert.ok(row, `${id}: die ruhige Zeile mit der Aktion am Ende`);
    assert.match(row[2], new RegExp(`aria-describedby="${row[1]}"`), `${id}: die Aktion verweist auf den Satz, der ihr Objekt nennt`);
    assert.doesNotMatch(html, /empty-state__icon|widget__empty-cta/, `${id}: keine Glyphe, kein Akzent-Textknopf`);
  }
  // Ohne Aktion: nur der Satz, ohne Verweis.
  const pantry = __test.renderPantryWidget({ items: [] }, '1x1');
  assert.match(pantry, /<div class="card-empty-row widget__empty">\s*<span class="card-empty-row__text">/);
});

/* DIE RUNDGANG-KARTE STEHT AM ERKLAERTEN ELEMENT (Critique R24, G6-Rundgang-P3-1).
 * Gemessen vorher (s2/bin/tour.mjs): 1440 Karte x 540 bei Ring x 2-234 (306 px
 * daneben), 390 Karte y 64 bei Ring y 766 (Leiste) bzw. 774 (Plus). Nachher
 * neben der Seitenleiste, ueber Leiste und Plus, unter dem Plus im Kopf. */
test('R24: die Rundgang-Karte haengt an der Seite des Rings, die Platz hat', () => {
  const { onboardingCardPlacement: place } = __test;
  const card = { width: 360, height: 375 };
  // Desktop, Seitenleiste (hoch): rechts daneben, senkrecht in der Mitte.
  assert.deepEqual(place({ left: 2, top: 2, right: 234, bottom: 898 }, card, { width: 1440, height: 900 }),
    { side: 'right', x: 250, y: 263 });
  // Desktop, Plus im Kopf (breit): darunter, am rechten Rand gehalten.
  assert.deepEqual(place({ left: 1319, top: 26, right: 1414, bottom: 78 }, card, { width: 1440, height: 900 }),
    { side: 'below', x: 1064, y: 94 });
  // Telefon, Leiste unten (breit): darueber, mittig.
  const phone = { width: 320, height: 376 };
  assert.deepEqual(place({ left: 2, top: 766, right: 388, bottom: 842 }, phone, { width: 390, height: 844 }),
    { side: 'above', x: 35, y: 374 });
  // Telefon, Plus unten rechts (quadratisch): darueber, im Fenster gehalten.
  assert.deepEqual(place({ left: 320, top: 774, right: 380, bottom: 834 }, phone, { width: 390, height: 844 }),
    { side: 'above', x: 54, y: 382 });
  // Kein Platz an keiner Seite: die Karte bleibt, wo das Overlay sie stellt.
  assert.equal(place({ left: 0, top: 200, right: 390, bottom: 600 }, phone, { width: 390, height: 844 }), null);
});

test('R24: der Rundgang setzt nach einem Tipp keinen Ring - der Titel nimmt den Fokus', () => {
  const src = dashboardSource;
  const fn = src.slice(src.indexOf('function focusStep(button)'), src.indexOf('let finished = false;'));
  assert.match(fn, /if \(lastInputWasKeyboard\(\) && !touch\) \{ button\?\.focus\(\); return; \}/);
  assert.match(fn, /querySelector\('\.onboarding-title'\)\?\.focus\(\{ preventScroll: true \}\)/);
  assert.doesNotMatch(src, /next\?\.focus\(\);/, 'kein Fokus an "Weiter" am Zeiger vorbei');
  assert.match(src, /setTimeout\(\(\) => focusStep\(stepEl\.querySelector\('\.btn--primary'\)\), 50\);/);
});
