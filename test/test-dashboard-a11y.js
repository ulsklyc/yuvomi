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
