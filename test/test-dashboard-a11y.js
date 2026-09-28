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
  assert.match(normal, /<button class="dashboard-icon-btn" id="dashboard-search"[^>]*aria-label="nav\.search"[^>]*aria-haspopup="dialog"/,
    'ein benannter Icon-Knopf wie die zwei daneben');
  const editing = renderDashboardOverview(user, true, null, { followsDefault: true, canPublish: false });
  assert.doesNotMatch(editing, /id="dashboard-search"/, 'im Anpassen-Modus zaehlt nur Abbrechen oder Speichern');
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
    const region = html.match(new RegExp(`<div\\b[^>]*id="${controls}"[^>]*>([\\s\\S]*?)</div>\\s*<button`));
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
  const handler = dashboardSource.slice(dashboardSource.indexOf("grid.querySelectorAll('[data-widget-size-preset]')"));
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

test('Router: jeder Wechsel einer angemeldeten Sitzung fragt den Verlassen-Schutz, bevor er navigiert (A7 P2-1)', async () => {
  const { readFileSync } = await import('node:fs');
  const router = readFileSync(new URL('../public/router.js', import.meta.url), 'utf8');
  assert.match(router, /import \{[^}]*\bmayLeave\b[^}]*\} from '\/utils\/leave-guard\.js';/);
  const head = router.slice(router.indexOf('async function navigate('), router.indexOf('isNavigating = true;', router.indexOf('async function navigate(')));
  assert.match(head, /if \(currentUser && typeof userOrPushState !== 'object' &&[^\n]*!\(await mayLeave\(path\)\)\)/,
    'der Schutz steht VOR isNavigating = true - sonst blockierte die offene Rueckfrage jede weitere Navigation');
  assert.match(head, /userOrPushState === false && currentPath\)[\s\S]*history\.pushState\(\{ path: /,
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
  const start = router.indexOf('async function navigate(');
  const head = router.slice(start, router.indexOf('isNavigating = true;', start));
  assert.match(head, /hasLeaveGuard\(\) && !\(await mayLeave\(path\)\)/,
    'erst der synchrone Blick auf den Waechter, dann das await');
});

test('Router: ein abgelehntes Zurueck legt die Adresse erst zurueck, wenn der Dialog seinen Marker zurueckgab', async () => {
  const { readFileSync } = await import('node:fs');
  const router = readFileSync(new URL('../public/router.js', import.meta.url), 'utf8');
  const start = router.indexOf('async function navigate(');
  const head = router.slice(start, router.indexOf('isNavigating = true;', start));
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
  // Die Uhr steht fest auf dem Morgen: die Termine liegen am Abend und waren
  // nach 21 Uhr schon vorbei - dann fiel der Test je nach Tageszeit.
  const now = new Date(`${todayStr}T08:00:00`);
  const upcomingEvents = [1, 2, 3].map((i) => ({ id: 40 + i, title: `Termin ${i}`, start_datetime: `${todayStr}T2${i}:00:00` }));
  const model = __test.buildTodayCockpitModel({ urgentTasks: fiveOverdue(), upcomingEvents }, [], { now });
  assert.equal(model.rows.length, 2, `zwei Zeilen auf dem Telefon, erhalten: ${model.rows.map((r) => r.title)}`);
  assert.equal(model.rows[0].kind, 'overdue', 'das Offene bleibt unter dem Deckel');
  assert.equal(model.overflow, 2, 'der Rest steht hinter "+N weitere"');
  // Termine plus Essen: keine Ansicht zeigt beides, also klappt die Fusszeile auf.
  const shop = { urgentTasks: fiveOverdue(), upcomingEvents, todayMeals: [{ id: 9, meal_type: 'dinner', title: 'Pasta' }],
    shoppingLists: [{ id: 1, name: 'Wocheneinkauf', open_count: 7 }] };
  const withShop = renderTodayCockpit(shop, [], false, { now, moreOpen: false });
  assert.match(withShop, /dashboard\.todayShopping</, 'Reichweite: die Einkaufszeile steht im Blatt');
  const regionStart = withShop.indexOf('id="today-cockpit-more"');
  const button = withShop.indexOf('data-today-more');
  const shopAt = withShop.indexOf('dashboard.todayShopping<');
  assert.ok(regionStart > 0 && regionStart < shopAt && shopAt < button,
    'auf dem Telefon steht der Einkauf hinter dem Knopf, nicht als eigene Zeile darunter');
  assert.match(withShop, /dashboard\.todayMore\{(?:"|&quot;)count(?:"|&quot;):4\}/, 'und der Knopf zaehlt ihn mit (zwei Termine, Essen, Einkauf)');
  const wall = __test.buildTodayCockpitModel({ urgentTasks: fiveOverdue() }, [], { cap: 8, groupOverdue: false });
  assert.equal(wall.rows.filter((r) => r.overdue).length, 5, 'die Wand bekommt ihre Zeilen, wenn sie es sagt');
}));

test('R14 P2: die Sammelzeile ist verdrahtet, und der Wand-Aufruf sammelt nicht', () => {
  assert.equal(typeof __test.wireTodayOverdue, 'function');
  assert.match(dashboardSource, /function wireLinks\([^)]*\) \{[\s\S]{0,200}wireTodayOverdue\(container\)/);
  assert.match(dashboardSource, /buildTodayCockpitModel\(data, \[\], \{ cap, now, groupOverdue: false \}\)/,
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
    { id: 'weather', visible: false, size: '1x1' },
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
  assert.match(dashboardSource, /function wireNewMenu\(container, signal\)/);
  assert.match(dashboardSource, /wireNewMenu\(container, signal\)/);
}));

test('R14: auf dem Telefon bleibt der Speed-Dial in der Kapsel', () => withStage(true, () => {
  assert.match(__test.renderFab(), /class="page-fab-group"/);
  assert.doesNotMatch(renderDashboardOverview({ display_name: 'Linda' }, false, null, {}), /id="fab-main"/);
}));
