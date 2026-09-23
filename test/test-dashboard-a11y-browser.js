/**
 * Modul: Dashboard - Bedienung und Barrierefreiheit im gerenderten Dokument
 * Zweck: Was die Critique vom 2026-09-23 am lebenden Dashboard gemessen hat,
 *        hier als Programm gefahren statt als Textguard:
 *          (1) der Aktualisieren-Knopf der Wetterkarte ist erreichbar - er lag
 *              UNTER dem Widget-Kopf (z-index 2 gegen 1), elementFromPoint traf
 *              an seinem Zentrum den Kopf, und Sonde 4 (test-document-guards.js)
 *              ueberspringt verdeckte Ziele stillschweigend,
 *          (2) das Raster hat eine eigene h2, und keine Widget-Ueberschrift
 *              traegt die Badge-Zahl im Namen,
 *          (3) im Anpassen-Modus bleibt der Fokus nach jeder Geste auf der
 *              Flaeche, und die Zustandswechsel werden angesagt,
 *          (4) die Startknoepfe des Wand-Timers ruhen sichtbar, und der erste
 *              Tipp auf eine schlafende Wand weckt nur,
 *          (5) die Kopf-Knoepfe halten am Touch-Tablet (1180px) die Fingergroesse
 *              - das Kriterium ist die Zeigerfaehigkeit, nicht die Breite,
 *          (4b) das Wecken verschiebt die Startknoepfe nicht (der zweite Tipp
 *              traefe sonst einen anderen),
 *          (6) die Wieder-Einblenden-Chips messen am Zeiger dieselben 40px wie
 *              jedes andere Bedienelement des Anpassen-Modus.
 * Ausfuehren: npm run test:dashboard-a11y-browser (haengt an test:document-guards)
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startHarness, openPage, gotoRoute, settle, DEVICES } from './document-guards-harness.js';

let harness;
before(async () => { harness = await startHarness(); });
after(async () => { await harness?.close(); });

const WEATHER = {
  data: {
    provider: 'open-meteo', city: 'Dortmund', units: 'metric',
    current: { temp: 20, feels_like: 18, humidity: 47, icon: 'cloud', desc: 'wmo.3', wind_speed: 11 },
    today: { date: '2026-09-23', temp_min: 13, temp_max: 21, icon: 'cloud', desc: 'wmo.3' },
    forecast: [
      { date: '2026-09-24', temp_min: 14, temp_max: 19, icon: 'cloud', desc: 'wmo.3' },
      { date: '2026-09-25', temp_min: 12, temp_max: 22, icon: 'cloud', desc: 'wmo.3' },
      { date: '2026-09-26', temp_min: 13, temp_max: 25, icon: 'cloud', desc: 'wmo.3' },
    ],
  },
};

const LAYOUT = [
  { id: 'weather', visible: true, size: '2x1', order: 0 },
  { id: 'birthdays', visible: true, size: '1x1', order: 1 },
  { id: 'notes', visible: true, size: '1x1', order: 2 },
  { id: 'clock', visible: true, size: '1x1', order: 3 },
];

/** Seite mit festem Layout und einer Wetterantwort, die nicht vom Netz abhaengt. */
async function dashboardPage({ device = 'desktop', viewport = null } = {}) {
  await harness.reset();
  const page = await openPage(harness, { device, theme: 'light', locale: 'de' });
  if (viewport) await page.setViewport(viewport);
  page.__yuvomiRequestInterceptor = (req) => {
    if (!/\/api\/v1\/weather\?/.test(req.url())) return false;
    req.respond({ status: 200, contentType: 'application/json', body: JSON.stringify(WEATHER) });
    return true;
  };
  await page.evaluate(async (layout) => {
    const { api } = await import('/api.js');
    await api.put('/preferences', { dashboard_widgets: layout });
    localStorage.setItem('yuvomi-dash-customize-hint', '1');
    localStorage.setItem('yuvomi:fabSeen:dashboard', '5');
  }, LAYOUT);
  await gotoRoute(page, '/');
  await page.waitForSelector('#dashboard-widget-grid .widget-wrapper');
  return page;
}

/** Tastet wie Sonde 4: trifft das Zentrum das Element selbst, und wie weit reicht es? */
async function hitArea(page, selector) {
  return page.$eval(selector, async (el) => {
    el.scrollIntoView({ block: 'center', behavior: 'instant' });
    await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
    document.getAnimations().forEach((a) => { try { a.finish(); } catch { /* egal */ } });
    const r = el.getBoundingClientRect();
    const cx = Math.round(r.left + r.width / 2);
    const cy = Math.round(r.top + r.height / 2);
    const mine = (x, y) => { const h = document.elementFromPoint(x, y); return !!h && (h === el || el.contains(h)); };
    const reach = (dx, dy) => { let n = 0; while (n < 80 && mine(cx + dx * (n + 1), cy + dy * (n + 1))) n += 1; return n; };
    const top = document.elementFromPoint(cx, cy);
    return {
      covered: !mine(cx, cy),
      by: top ? `${top.tagName.toLowerCase()}.${[...top.classList].join('.')}` : null,
      box: { w: r.width, h: r.height },
      w: Math.max(r.width, reach(-1, 0) + reach(1, 0) + 1),
      h: Math.max(r.height, reach(0, -1) + reach(0, 1) + 1),
    };
  });
}

/** Der Text des Ansagers - er setzt verzoegert (50ms), also kurz warten. */
async function announced(page) {
  await new Promise((r) => { setTimeout(r, 150); });
  return page.$eval('#route-announcer', (el) => el.textContent.trim());
}

test('(1) der Aktualisieren-Knopf der Wetterkarte liegt nicht unter dem Kopf', async () => {
  for (const device of ['desktop', 'mobile']) {
    const page = await dashboardPage({ device });
    await page.waitForSelector('#weather-refresh-btn');
    const area = await hitArea(page, '#weather-refresh-btn');
    assert.equal(area.covered, false, `${device}: das Zentrum des Knopfs trifft ${area.by}, nicht den Knopf`);
    const min = device === 'mobile' ? 48 : 44;
    assert.ok(area.w >= min && area.h >= min,
      `${device}: Trefferflaeche ${area.w}x${area.h}, verlangt ${min} (Box ${area.box.w}x${area.box.h})`);
    await page.close();
  }
});

test('(2) das Raster hat eine eigene h2, die Widget-Ueberschriften keine Zahl im Namen', async () => {
  const page = await dashboardPage({ device: 'mobile' });
  const tree = await page.evaluate(() => {
    const grid = document.querySelector('#dashboard-widget-grid');
    const all = [...document.querySelectorAll('main h1, main h2, main h3')];
    // Die letzte h2 VOR dem Raster ist die, unter der seine h3 haengen.
    const parentH2 = all.filter((h) => h.tagName === 'H2'
      && (h.compareDocumentPosition(grid) & Node.DOCUMENT_POSITION_FOLLOWING)).pop();
    const name = (h) => {
      const clone = h.cloneNode(true);
      clone.querySelectorAll('[aria-hidden="true"]').forEach((n) => n.remove());
      return clone.textContent.replace(/\s+/g, ' ').trim();
    };
    return {
      parent: parentH2 ? { text: name(parentH2), labels: grid.getAttribute('aria-labelledby') === parentH2.id } : null,
      h3: [...grid.querySelectorAll('h3')].map(name),
      badges: grid.querySelectorAll('.widget__badge').length,
      wrappers: grid.querySelectorAll('.widget-wrapper').length,
      wrappersWithHeading: [...grid.querySelectorAll('.widget-wrapper')].filter((w) => w.querySelector('h3')).length,
    };
  });
  assert.ok(tree.parent, 'es gibt eine h2 vor dem Raster');
  assert.equal(tree.parent.text, 'Widgets', `die Widgets haengen unter „${tree.parent.text}"`);
  assert.ok(tree.parent.labels, 'und das Raster nennt sich nach ihr');
  assert.ok(tree.badges > 0, 'Reichweite: mindestens eine Kachel traegt eine Badge-Zahl');
  assert.equal(tree.wrappersWithHeading, tree.wrappers, 'jede Kachel hat eine Ueberschrift');
  const withDigits = tree.h3.filter((n) => /\d/.test(n));
  assert.deepEqual(withDigits, [], 'Ueberschriften mit einer Zahl im zugaenglichen Namen');
  await page.close();
});

test('(3) Anpassen per Tastatur: der Fokus bleibt, die Wechsel werden angesagt', async () => {
  const page = await dashboardPage({ device: 'desktop' });
  const active = () => page.evaluate(() => {
    const el = document.activeElement;
    return {
      body: el === document.body || !el,
      id: el?.id ?? '',
      size: el?.getAttribute('data-widget-size-preset'),
      widget: el?.getAttribute('data-widget-id') ?? el?.closest('[data-widget-id]')?.getAttribute('data-widget-id'),
      hide: el?.getAttribute('data-widget-hide'),
      show: el?.getAttribute('data-widget-show'),
      pressed: el?.getAttribute('aria-pressed'),
    };
  });

  await page.focus('#dashboard-customize-btn');
  await page.keyboard.press('Enter');
  await page.waitForSelector('.widget-edit-controls');
  let a = await active();
  assert.equal(a.id, 'dashboard-customize-btn', `nach „Anpassen" liegt der Fokus auf ${JSON.stringify(a)}`);

  // Eine Groesse, die die Geburtstagskachel gerade NICHT hat.
  const target = await page.$eval('.widget-wrapper[data-widget-id="birthdays"]',
    (w) => w.querySelector('[data-widget-size-preset][aria-pressed="false"]').getAttribute('data-widget-size-preset'));
  await page.focus(`.widget-wrapper[data-widget-id="birthdays"] [data-widget-size-preset="${target}"]`);
  await page.keyboard.press('Enter');
  a = await active();
  assert.equal(a.size, target, `nach der Groessenwahl liegt der Fokus auf ${JSON.stringify(a)}`);
  assert.equal(a.widget, 'birthdays');
  assert.equal(a.pressed, 'true', 'und der Knopf traegt jetzt den gewaehlten Zustand');
  assert.match(await announced(page), /Geburtstage: Größe/, 'die Groessenaenderung wird angesagt');

  await page.focus('.widget-wrapper[data-widget-id="birthdays"] [data-widget-hide]');
  await page.keyboard.press('Enter');
  a = await active();
  assert.equal(a.body, false, 'nach dem Ausblenden faellt der Fokus nicht auf <body>');
  assert.ok(a.hide || a.show, `sondern auf den naechsten Ausblenden- oder den Einblenden-Knopf: ${JSON.stringify(a)}`);
  assert.equal(await page.$('.widget-wrapper[data-widget-id="birthdays"]'), null, 'Reichweite: die Kachel ist weg');
  assert.match(await announced(page), /Geburtstage ausgeblendet/);

  await page.focus('[data-widget-show="birthdays"]');
  await page.keyboard.press('Enter');
  a = await active();
  assert.equal(a.body, false, 'nach dem Einblenden faellt der Fokus nicht auf <body>');
  assert.match(await announced(page), /Geburtstage eingeblendet/);

  await page.focus('#dashboard-customize-cancel');
  await page.keyboard.press('Enter');
  await page.waitForFunction(() => !document.querySelector('.widget-edit-controls'));
  a = await active();
  assert.equal(a.id, 'dashboard-customize-btn', `nach „Abbrechen" liegt der Fokus auf ${JSON.stringify(a)}`);
  await page.close();
});

test('(4) Wand-Timer: sichtbar in Ruhe, der erste Tipp auf die schlafende Wand weckt nur', async () => {
  const page = await dashboardPage({ device: 'mobile' });
  await page.click('#dashboard-wall-enter');
  await page.waitForSelector('.wall [data-wall-timer-start]');
  await settle(page);
  // Schlafend: das Attribut faellt nach sechs Sekunden von selbst - hier sofort.
  const rest = await page.evaluate(() => {
    document.querySelector('.wall').removeAttribute('data-wall-awake');
    document.getAnimations().forEach((a) => { try { a.finish(); } catch { /* egal */ } });
    const btn = document.querySelector('[data-wall-timer-start="5"]');
    const cs = getComputedStyle(btn);
    return { color: cs.color, opacity: cs.opacity };
  });
  const alpha = (c) => { const m = c.match(/rgba?\(([^)]+)\)/); const p = m ? m[1].split(',').map(Number) : []; return p.length === 4 ? p[3] : 1; };
  assert.ok(alpha(rest.color) > 0 && Number(rest.opacity) > 0,
    `die Startknoepfe ruhen unsichtbar (color ${rest.color}, opacity ${rest.opacity})`);

  // Der zweite Tipp landet dort, wo der erste lag - das Wecken darf die Knoepfe
  // also nicht verschieben. Genau das tat es: der Ausstieg bekommt wach seine
  // Beschriftung, und im `space-between`-Fuss rutschte die Mitte um 91px
  // (gemessen 1440) - aus „5 Min" wurde beim zweiten Tipp „10 Min".
  const lefts = () => page.$$eval('[data-wall-timer-start]', (els) => els.map((el) => Math.round(el.getBoundingClientRect().left)));
  const asleep = await lefts();
  await page.$eval('.wall', (w) => w.setAttribute('data-wall-awake', ''));
  const awake = await lefts();
  await page.$eval('.wall', (w) => w.removeAttribute('data-wall-awake'));
  assert.deepEqual(awake, asleep, 'die Startknoepfe verschieben sich beim Wecken');

  await page.tap('[data-wall-timer-start="5"]');
  const afterFirst = await page.evaluate(() => ({
    timer: localStorage.getItem('yuvomi-wall-timer'),
    awake: document.querySelector('.wall').hasAttribute('data-wall-awake'),
  }));
  assert.equal(afterFirst.timer, null, 'der erste Tipp auf die schlafende Wand hat einen Timer gestartet');
  assert.equal(afterFirst.awake, true, 'er hat die Wand geweckt');

  await page.tap('[data-wall-timer-start="5"]');
  await page.waitForSelector('.wall__timer');
  assert.ok(await page.evaluate(() => localStorage.getItem('yuvomi-wall-timer')), 'der zweite Tipp startet');
  assert.equal(await page.$eval('.wall__timer', (el) => el.getAttribute('role')), 'timer',
    'die tickende Anzeige ist keine Live-Region');
  assert.match(await announced(page), /Küchentimer läuft/, 'der Start wird angesagt');

  await page.evaluate(() => {
    localStorage.removeItem('yuvomi-wall-timer');
  });
  await page.close();
});

test('(4b) das Wecken verschiebt die Startknoepfe nicht - auch nicht am grossen Wandbildschirm', async () => {
  // Der Fall aus (4) an der Breite, an der er gemessen wurde: am Telefon hat der
  // Fuss keinen Ueberschuss zu verteilen, am Wandbildschirm schon.
  const page = await dashboardPage({ device: 'desktop', viewport: { width: 1440, height: 900, deviceScaleFactor: 1, isMobile: false, hasTouch: false } });
  await page.click('#dashboard-wall-enter');
  await page.waitForSelector('.wall [data-wall-timer-start]');
  await settle(page);
  const lefts = () => page.$$eval('[data-wall-timer-start]', (els) => els.map((el) => Math.round(el.getBoundingClientRect().left)));
  await page.$eval('.wall', (w) => w.removeAttribute('data-wall-awake'));
  const asleep = await lefts();
  await page.$eval('.wall', (w) => w.setAttribute('data-wall-awake', ''));
  const awake = await lefts();
  assert.equal(asleep.length, 5, 'Reichweite: fuenf Startknoepfe');
  assert.deepEqual(awake, asleep, 'die Startknoepfe verschieben sich beim Wecken - der zweite Tipp traefe einen anderen');
  await page.close();
});

test('(5) die Kopf-Knoepfe halten am Touch-Tablet die Fingergroesse', async () => {
  const page = await dashboardPage({
    device: 'mobile',
    viewport: { width: 1180, height: 820, deviceScaleFactor: 1, isMobile: true, hasTouch: true },
  });
  await gotoRoute(page, '/');
  await page.waitForSelector('#dashboard-customize-btn');
  const touch = await page.evaluate(() => matchMedia('(hover: none)').matches && innerWidth >= 1024);
  assert.ok(touch, 'Reichweite: ein Touch-Geraet ueber 1024px Breite');
  for (const sel of ['#dashboard-customize-btn', '#dashboard-wall-enter']) {
    const area = await hitArea(page, sel);
    assert.ok(area.w >= 48 && area.h >= 48, `${sel}: ${area.w}x${area.h} am Finger, verlangt 48`);
  }
  await page.close();
});

test('(6) die Wieder-Einblenden-Chips messen am Zeiger 40px wie ihre Nachbarn', async () => {
  const page = await dashboardPage({ device: 'desktop' });
  assert.equal(DEVICES.desktop.hasTouch, false, 'Reichweite: Zeigergeraet');
  await page.click('#dashboard-customize-btn');
  await page.waitForSelector('.widget-restore-chip');
  const heights = await page.$$eval('.widget-restore-chip', (els) => els.map((el) => el.getBoundingClientRect().height));
  assert.ok(heights.length > 0, 'Reichweite: es gibt ausgeblendete Widgets');
  const low = heights.filter((h) => h < 40);
  assert.deepEqual(low, [], 'Chips unter der Zielgroesse des Zeigers (--target-md)');
  await page.close();
});
