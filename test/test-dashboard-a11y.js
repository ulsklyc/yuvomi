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
  assert.match(body, /if \(customizeHasChanges\([\s\S]*?confirmModal\(/, 'die Rueckfrage haengt an der Aenderung');
});

test('„+N weitere heute" ist ein Weg dorthin, wo die verdeckten Zeilen stehen (H13)', () => {
  const day = '2026-09-27';
  assert.equal(todayMoreRoute([{ route: '/tasks' }, { route: '/tasks' }], day), '/tasks');
  assert.equal(todayMoreRoute([{ route: '/calendar?open=4&date=2026-09-27' }, { route: '/calendar?open=5' }], day),
    '/calendar?date=2026-09-27', 'mehrere Termine: der Tag, nicht ein einzelnes Vorkommen');
  assert.equal(todayMoreRoute([{ route: '/tasks' }, { route: '/calendar?open=4' }], day), '/calendar?date=2026-09-27',
    'gemischt mit Terminen: der Kalendertag zeigt beides');
  assert.equal(todayMoreRoute([{ route: '/tasks' }, { route: '/health' }], day), '/tasks');
  assert.equal(todayMoreRoute([{ route: '/pantry?filter=soon' }], day), '/pantry?filter=soon', 'ein Modul allein: sein Ziel samt Filter');
  assert.equal(todayMoreRoute([], day), null);

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
  assert.match(more[0], /href="\/tasks"/);
  assert.match(more[0], /data-route="\/tasks"/, 'wireLinks haengt an data-route');
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
