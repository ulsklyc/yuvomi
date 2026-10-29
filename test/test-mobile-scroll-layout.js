/**
 * Modul: Mobile scroll layout regression test
 * Zweck: Verhindert Scrollzeit-Layoutmutationen, die mobile Browser beim Dashboard-Scrollen blanken lassen.
 * Ausführen: node test-mobile-scroll-layout.js
 */

import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import test from 'node:test';

import { eachRule } from './css-rules.js';
import {
  rememberScrollPosition,
  scrollPositionFor,
  portPositionsFor,
  forgetScrollPositions,
  adoptEntryKey,
  captureScrollPorts,
  restoreScrollPorts,
} from '../public/utils/scroll-restore.js';

const routerJs = readFileSync(new URL('../public/router.js', import.meta.url), 'utf8');
const layoutCss = readFileSync(new URL('../public/styles/layout.css', import.meta.url), 'utf8');
const glassCss = readFileSync(new URL('../public/styles/glass.css', import.meta.url), 'utf8');
const tokensCss = readFileSync(new URL('../public/styles/tokens.css', import.meta.url), 'utf8');

/* Der Rumpf der ersten Regel, deren Selektorliste GENAU diesen Selektor
 * fuehrt. Frueher ein Regex auf `<selektor> {` - das fand auch das Ende eines
 * laengeren Selektors: seit `html.page-swapping .nav-bottom` (Re-Critique
 * 2026-09-28, G1) las der Safe-Area-Guard den Uebergangsnamen statt der Bar. */
function cssRuleBody(css, selector) {
  for (const rule of eachRule(css)) {
    if (rule.selector.split(',').some((part) => part.trim() === selector)) return rule.body;
  }
  return '';
}

test('mobile scrolling keeps navigation and fixed layers stable', () => {
  assert.equal(
    routerJs.includes('document.documentElement.classList.toggle(\'nav-bottom--hidden\''),
    false,
    'Scroll-Handler darf den Bottom-Nav-Status nicht auf <html> spiegeln'
  );

  assert.equal(
    routerJs.includes('setNavHidden'),
    false,
    'Kein Scrollpfad darf die mobile Bottom-Nav ausblenden'
  );

  assert.equal(
    layoutCss.includes('html.nav-bottom--hidden .page-fab'),
    false,
    'FAB darf nicht über eine Root-Klasse während des Scrollens umpositioniert werden'
  );

  const pageFabRule = cssRuleBody(layoutCss, '.page-fab');
  assert.equal(
    /transition\s*:[^;]*\bbottom\b/.test(pageFabRule),
    false,
    'FAB darf bottom nicht animieren; fixed Layer sollen beim Scrollen stabil bleiben'
  );

  assert.equal(
    glassCss.includes('.nav-bottom--hidden'),
    false,
    'Die Glass-Schicht darf keinen versteckten Bottom-Nav-Zustand definieren'
  );
});

test('mobile bottom navigation reserves safe-area space without scroll-time root mutation', () => {
  const navRule = cssRuleBody(layoutCss, '.nav-bottom');
  const rootRule = cssRuleBody(layoutCss, ':root');

  // Der Guard hält die ZUSAGE fest (die Bar reserviert die Safe-Area selbst,
  // niemand mutiert sie beim Scrollen am :root), nicht die Schreibweise. Seit
  // dem HIG-Rollout ist die Bar eine transparente Zone mit schwebender
  // Glas-Kapsel: die Reserve steht als dritter Wert im padding-Shorthand und
  // trägt zusätzlich die Luft unter der Kapsel.
  assert.match(
    navRule,
    /padding(-bottom)?:[^;]*var\(--safe-area-inset-bottom\)/,
    'die Bar muss die Safe-Area selbst reservieren',
  );
  // Die Zone rechnet mit der gemessenen Kapselhoehe und der Token-Hoehe als
  // Rueckfall (Review zu #1475, test:mobile-chrome); die Zusage hier ist nur,
  // dass die Safe-Area in der Zone steckt.
  const zone = tokensCss.match(/--nav-bottom-height:\s*([^;]+);/)?.[1] ?? '';
  assert.match(zone, /var\(--nav-height-mobile\)/);
  assert.match(zone, /var\(--safe-area-inset-bottom\)\)$/);
  assert.equal(rootRule.includes('nav-bottom--hidden'), false);
});

test('mobile bottom navigation keeps five equal slots with inset indicator geometry', () => {
  const itemsRule = cssRuleBody(layoutCss, '.nav-bottom__items');
  const itemRule = cssRuleBody(layoutCss, '.nav-bottom .nav-item');
  const baseItemRule = cssRuleBody(layoutCss, '.nav-item');
  const indicatorRule = cssRuleBody(layoutCss, '.nav-bottom__indicator');
  const indicatorSurfaceRule = cssRuleBody(layoutCss, '.nav-bottom__indicator::before');

  assert.match(itemsRule, /display:\s*flex/);
  assert.match(baseItemRule, /flex:\s*1/);
  assert.match(itemRule, /min-width:\s*0/);
  assert.match(indicatorSurfaceRule, /inset-inline:\s*var\(--space-1\)/);
  // Kapsel hinter dem Icon statt über die ganze Bar-Höhe: bar-hoch schnitt sie
  // die Label-Grundlinie an und lief in die Safe-Area (#569-Nachtrag).
  assert.match(indicatorRule, /top:\s*0/);
  assert.match(indicatorRule, /bottom:\s*auto/);
  assert.match(indicatorRule, /height:\s*var\(--target-md\)/);
  assert.doesNotMatch(indicatorRule, /transition:[^;]*\bwidth\b/);
});

test('mobile tab indicator stays a capsule behind the icon, clear of the bar edges', () => {
  // Slot-breite Pille lief im ersten/letzten Tab bis an die Bar-Kante, wo die
  // Rundung gekappt wurde (#569-Nachtrag). Die Geometrie kommt aus dem
  // Icon-Well-Rect plus seitlichem Inset, nicht aus der reinen Slot-Breite.
  // Seit R24 S12 misst `tabGeometry` (gemerkt je Ziel), positionTabIndicator setzt.
  const fnBody = (name) => { const fn = routerJs.slice(routerJs.indexOf(`function ${name}`)); return fn.slice(0, fn.indexOf('\n}\n') + 2); };
  const geometry = fnBody('tabGeometry');
  const body = fnBody('positionTabIndicator');

  assert.match(geometry, /querySelector\('\.nav-item__icon-well'\)/);
  assert.match(geometry, /Math\.min\(ar\.width - TAB_INDICATOR_INSET \* 2, TAB_INDICATOR_MAX_WIDTH\)/);
  assert.match(geometry, /height: wr\.height/);
  assert.match(body, /tabGeometry\(nav, active\)/);
  assert.match(body, /indicator\.style\.height = `\$\{height\}px`/);
  assert.match(body, /translate\(\$\{left\}px, \$\{top\}px\)/);
  assert.doesNotMatch(body, /indicator\.style\.width = `\$\{ar\.width\}px`/);
  assert.match(routerJs, /const TAB_INDICATOR_INSET = 4;/);
  assert.match(routerJs, /const TAB_INDICATOR_MAX_WIDTH = 64;/);
});

test('cold dashboard load does not transform the scroll surface', () => {
  assert.match(
    routerJs,
    /const shouldAnimate = Boolean\(previousPath\);/,
    'the router must distinguish a cold load from an in-app navigation',
  );
  // Seit 2026-09-26 tauscht der Wechsel per View Transition, seit R22 (D1)
  // schneidet er hart - auch ohne API gibt es keine Rueckfall-Klasse mehr, die
  // die Scrollflaeche animieren koennte.
  assert.match(
    routerJs,
    /animate: shouldAnimate,/,
    'the view transition must only run after an existing route',
  );
  assert.doesNotMatch(routerJs, /page-transition--in/, 'no fallback fade on the page wrapper (R22, D1)');
});

test('a forward navigation opens the target page at the top, a back navigation where it was', () => {
  forgetScrollPositions();

  // Übersicht weit unten verlassen (gemessener Fall: scrollTop 1267 → /tasks).
  rememberScrollPosition('/', 1267);

  assert.equal(
    scrollPositionFor('/tasks', { restore: false }),
    0,
    'ein eigener Aufruf (pushState) muss oben beginnen',
  );
  assert.equal(
    scrollPositionFor('/', { restore: true }),
    1267,
    'Browser-Zurück muss den gemerkten Stand der ZIELseite liefern',
  );
  assert.equal(
    scrollPositionFor('/tasks', { restore: true }),
    0,
    'ohne gemerkten Stand bleibt auch popstate bei 0',
  );

  // Oben stehende Seiten werden nicht eingetragen - der Default liefert dieselbe 0.
  rememberScrollPosition('/', 0);
  assert.equal(scrollPositionFor('/', { restore: true }), 0);

  forgetScrollPositions();
  rememberScrollPosition('/', 1267);
  forgetScrollPositions();
  assert.equal(
    scrollPositionFor('/', { restore: true }),
    0,
    'nach Sitzungsende darf kein Stand überleben',
  );
});

/* Attrappe eines Ports: `scrollTop` klemmt wie im Browser auf die Hoehe. */
function fakePort(name, { height = 2000, client = 500, inert = false } = {}) {
  let top = 0;
  return {
    name,
    scrollHeight: height,
    clientHeight: client,
    get scrollTop() { return top; },
    set scrollTop(v) { top = Math.max(0, Math.min(v, this.scrollHeight - this.clientHeight)); },
    getAttribute: (attr) => (attr === 'data-scroll-port' ? name : null),
    closest: (sel) => (sel === '[inert]' && inert ? {} : null),
  };
}
function fakeRoot(ports) {
  return {
    ports,
    querySelectorAll: (sel) => (sel === '[data-scroll-port]' ? ports : []),
    addEventListener() {},
    removeEventListener() {},
  };
}

test('back restores the named INNER scroll ports, keyed per history entry (R22, D2)', () => {
  forgetScrollPositions();
  // Kontakte: `#main-content` steht auf 0, die Liste auf 250 (gemessen a6: 250 -> 0).
  const list = fakePort('contacts');
  list.scrollTop = 250;
  const ghost = fakePort('contacts', { inert: true });
  ghost.scrollTop = 900;
  const ports = captureScrollPorts(fakeRoot([list, ghost]));
  assert.deepEqual(ports, { contacts: 250 },
    'der sichtbare Port zaehlt; ein geparkter Nachbar (inert) nicht');
  rememberScrollPosition('entry-1', 0, ports);
  assert.deepEqual(portPositionsFor('entry-1', { restore: true }), { contacts: 250 },
    'Zurueck liefert den Stand des inneren Ports');
  assert.equal(portPositionsFor('entry-1', { restore: false }), null,
    'eine neue Navigation startet oben - auch im inneren Port');

  // DERSELBE PFAD ZWEIMAL IN DER HISTORIE: zwei Eintraege, zwei Staende.
  rememberScrollPosition('entry-2', 0, { contacts: 40 });
  assert.deepEqual(portPositionsFor('entry-1', { restore: true }), { contacts: 250 },
    'der erste Besuch behaelt seinen Stand, der zweite ueberschreibt ihn nicht');
  assert.deepEqual(portPositionsFor('entry-2', { restore: true }), { contacts: 40 });

  // Neuaufbau nach dem Zurueck: der Port ist ein NEUES Element, zuerst noch kurz
  // (die Zeilen kommen nach dem Render). Gesetzt wird, was schon geht ...
  const fresh = fakePort('contacts', { height: 600 });
  const stop = restoreScrollPorts(fakeRoot([fresh]), { contacts: 250 }, { timeoutMs: 50 });
  assert.equal(fresh.scrollTop, 100, 'ein zu kurzer Port klemmt erst auf sein Maximum');
  stop();
  // ... und ein Port, der sofort die Hoehe hat, sitzt sofort.
  const tall = fakePort('contacts');
  restoreScrollPorts(fakeRoot([tall]), { contacts: 250 })();
  assert.equal(tall.scrollTop, 250);
  forgetScrollPositions();
});

test('every history entry gets a scroll key without losing its state (R22, D2)', () => {
  const calls = [];
  const history = {
    state: { path: '/contacts', overlay: false },
    replaceState(state) { calls.push(state); this.state = state; },
  };
  const key = adoptEntryKey(history, '/contacts');
  assert.match(key, /^s/, 'ein frischer Schluessel');
  assert.equal(history.state.path, '/contacts', 'der Router liest `path` weiter');
  assert.equal(history.state.scrollKey, key);
  assert.equal(adoptEntryKey(history, '/contacts'), key, 'ein Eintrag behaelt seinen Schluessel');
  assert.equal(calls.length, 1, 'nur der erste Aufruf schreibt');
  const locked = { state: null, replaceState() { throw new Error('SecurityError'); } };
  assert.equal(adoptEntryKey(locked, '/tasks'), '/tasks', 'gesperrte History: der Pfad bleibt Schluessel');
});

test('every page scroll port names itself for the restore (R22, D2)', () => {
  // Die Rolle `.page-scrollport` ist das, was scrollt; der NAME ist das, woran
  // der Router den Port nach dem Neuaufbau wiederfindet. Ein Port ohne Namen
  // faellt beim Zurueck still auf 0 - der Befund aus sieben Modulen.
  const dir = new URL('../public/pages/', import.meta.url);
  const unnamed = [];
  for (const file of readdirSync(dir).filter((f) => f.endsWith('.js'))) {
    const src = readFileSync(new URL(file, dir), 'utf8');
    for (const m of src.matchAll(/<[a-z]+\b[^<>]*\bpage-scrollport\b[^<>]*>/g)) {
      if (!/data-scroll-port="[a-z-]+"/.test(m[0])) unnamed.push(`${file}: ${m[0].slice(0, 80)}`);
    }
    for (const m of src.matchAll(/^(\s*)(\w+)\.className = '[^']*\bpage-scrollport\b[^']*';\n([^\n]*)/gm)) {
      if (!new RegExp(`${m[2]}\\.dataset\\.scrollPort = '[a-z-]+'`).test(m[3])) unnamed.push(`${file}: ${m[0].trim().split('\n')[0]}`);
    }
  }
  assert.deepEqual(unnamed, [], 'jeder Port braucht data-scroll-port="<name>" (utils/scroll-restore.js)');
  // Aufgaben setzen die Rolle erst in der Spaltenform - der Name steht am festen Markup.
  assert.match(readFileSync(new URL('tasks.js', dir), 'utf8'), /<div id="task-list" class="split-view__list" data-scroll-port="tasks">/);
});

test('the router remembers and restores the inner ports on the way back (R22, D2)', () => {
  assert.match(routerJs, /rememberScrollPosition\(_shownEntryKey \?\? path, top, captureScrollPorts\(main\)\)/,
    'beim Verlassen: der Eintrag, der stand, samt seiner Ports');
  assert.match(routerJs, /const key = restore \? \(entryKeyOf\(history\.state\) \?\? path\) : path;/,
    'beim Zurueck: der Eintrag, auf den es geht');
  assert.match(routerJs, /if \(scrollTarget > 0\) content\.scrollTop = scrollTarget;\s*restorePorts\(\);/,
    'die Ports nach dem Render, wie der Hauptport');
  assert.match(routerJs, /updateNav: updateNavForEntry,/,
    'navigate() bekommt das updateNav, das den Eintrag festhaelt');
  assert.match(routerJs, /function updateNavForEntry\(section, opts\) \{\s*noteShownEntry\(\);\s*updateNav\(section, opts\);/,
    'der Eintrag gilt, sobald navigate() ihn geschrieben hat');
});

test('the router resets the surviving scrollport on every navigation', () => {
  // #main-content IST .app-content (renderAppShell) und überlebt jede Navigation:
  // renderPage() tauscht per replaceChildren nur seinen Inhalt. Ohne expliziten
  // Reset öffnet die Zielseite auf dem Scrollstand der Vorseite.
  const mainRule = cssRuleBody(layoutCss, '.app-content');
  assert.match(mainRule, /overflow-y:\s*auto/, '.app-content ist der Scrollport');
  assert.match(
    routerJs,
    /main\.className = 'app-content';\s*main\.id = 'main-content';/,
    'Scrollport und getauschter Container müssen dasselbe Element bleiben',
  );

  // Kommentare vorab entfernen, statt sie im Muster mitzudenken. Hier stand eine
  // Alternation aus Zeilen- und Blockkommentar unter einem `*` - die backtrackt
  // exponentiell, sobald ein `/*` ohne Abschluss folgt (CodeQL js/redos). Beide
  // Ersetzungen sind ungierig und ohne äußere Wiederholung, also linear.
  const routerCode = routerJs
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^[ \t]*\/\/[^\n]*$/gm, '');

  assert.match(
    routerCode,
    /content\.replaceChildren\(pageWrapper\);\s*content\.scrollTop = 0;/,
    'der Reset muss direkt am Inhaltstausch hängen - VOR dem Render, sonst kassiert '
    + 'er die modul-eigenen Scrolls (Kalender-Tagesansicht, Essensplan) wieder ein',
  );
  assert.match(
    routerJs,
    /if \(scrollTarget > 0\) content\.scrollTop = scrollTarget;/,
    'die Wiederherstellung bei popstate gehört hinter das await auf den Render',
  );
  // navigate() steht seit #1657 in utils/router-navigate.js - dort faellt die
  // Entscheidung ueber das Scrollziel, renderPage() im Router setzt es um.
  assert.match(
    readFileSync(new URL('../public/utils/router-navigate.js', import.meta.url), 'utf8'),
    /scrollPositionFor\(basePath, \{ restore: !pushState \}\)/,
    'die Richtung kommt aus pushState, nicht aus getDirection() - das ist die '
    + 'Slide-Richtung nach ROUTE_ORDER und auch bei Vorwärts-Taps oft "left"',
  );
});

/**
 * Die Wiederherstellung bei Browser-Zurück hängt am Scrollstand von
 * `#main-content`. Module, deren Root `overflow: hidden` auf voller Höhe ist und
 * die einen INNEREN Container scrollen, halten `#main-content` dauerhaft auf 0 -
 * dort gibt es nichts zu merken, und Zurück landet oben. Das ist eine bewusste
 * Grenze (siehe utils/scroll-restore.js und SPEC, Responsive Composition), keine
 * versehentliche.
 *
 * Dieser Guard hält die Liste ehrlich: kommt ein zehntes Modul dazu oder
 * verliert eines seinen inneren Scroller, verschiebt sich die Reichweite der
 * Zusage - und Kommentar wie Spezifikation müssen mitziehen, statt still falsch
 * zu werden. Geprüft wird die REGEL über alle Modul-Stylesheets, nicht eine
 * Handvoll bekannter Dateien.
 */
test('the modules with an inner scroll container are the documented nine', () => {
  const styleDir = new URL('../public/styles/', import.meta.url);
  const found = [];

  for (const file of readdirSync(styleDir).filter((f) => f.endsWith('.css'))) {
    const css = readFileSync(new URL(file, styleDir), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
    for (const [, selector, body] of css.matchAll(/([^{}]+)\{([^}]*)\}/g)) {
      const sel = selector.split('\n').pop().trim();
      if (!/^\.[a-z-]+-page$/.test(sel)) continue;
      if (/height:\s*100%/.test(body) && /overflow:\s*hidden/.test(body)) found.push(sel);
    }
  }

  assert.deepEqual(
    [...new Set(found)].sort(),
    [
      // .health-page seit R10: Liste + Detail wie Kontakte und Rezepte - ab der
      // Split-Schwelle scrollen Liste und Bereich je fuer sich, darunter EIN
      // Port (.health-browse, ein .page-scrollport mit Nachlauf).
      '.budget-page', '.calendar-page', '.contacts-page', '.health-page', '.meals-page',
      '.notes-page', '.pantry-page', '.recipes-page', '.shopping-page',
    ],
    'Die Module mit innerem Scroller haben sich geändert. Ihr Rueckweg haengt am '
    + 'benannten Port (data-scroll-port, R22) - die Liste in utils/scroll-restore.js '
    + 'und in docs/SPEC.md (Responsive Composition) muss mit.',
  );
});

test('closed dashboard speed dial cannot capture first-scroll gestures', () => {
  const dashboardCss = readFileSync(new URL('../public/styles/dashboard.css', import.meta.url), 'utf8');
  const layoutCss = readFileSync(new URL('../public/styles/layout.css', import.meta.url), 'utf8');
  const actionsRule = cssRuleBody(dashboardCss, '.fab-actions');

  // Der geschlossene Dial darf nur so viel Fläche belegen wie sein Knopf. Das
  // hing früher an `pointer-events: none` am Kasten - einer Zusicherung, die
  // jede spätere Regel mit `auto` still aushebeln konnte. Jetzt trägt es die
  // Geometrie: die Aktionsliste ist absolut positioniert und bläht die Gruppe
  // gar nicht erst auf, es gibt also keine tote Fläche, die man freistellen müsste.
  assert.match(actionsRule, /position:\s*absolute/,
    'die Aktionsliste muss aus dem Fluss der Gruppe heraus - sonst ist der '
    + 'geschlossene Dial so hoch wie seine ausgeklappte Liste');
  assert.match(actionsRule, /pointer-events:\s*none/,
    'die geschlossene Liste ist unsichtbar und darf keine Klicks fangen');
  assert.match(dashboardCss, /\.fab-actions--visible\s*\{[^}]*pointer-events:\s*auto/s);
  assert.doesNotMatch(cssRuleBody(layoutCss, '.page-fab-group'), /pointer-events/,
    'die Gruppe braucht keinen Pointer-Freibrief mehr - ihr Kasten ist der FAB');
});

/* EIN PAN-VERBOT DARF DEN ZWEI-FINGER-WEG NICHT MITNEHMEN (#1276).
 *
 * `touch-action: pan-y` erlaubt den senkrechten Bildlauf mit EINEM Finger -
 * und verbietet stillschweigend `pinch-zoom`. Chromium behandelt jeden
 * Bildlauf, der mit zwei oder mehr Fingern beginnt, als Zoom-Geste
 * (`TouchActionFilter::ShouldSuppressScrolling`, crbug.com/632525) und
 * verwirft ihn ganz, wo pinch-zoom fehlt. Seit #294 stand genau das an
 * `.app-content`. Gemeldet wurde es von einem Chromebook mit Touchscreen:
 * Hauptinhalt starr, die Seitenleiste daneben (ohne touch-action) nicht,
 * Touchpad und Maus auch nicht. Nachgestellt in Chromium mit Touch-Eingabe
 * bei 1366px: zwei Finger auf dem Hauptinhalt 0px Bildlauf, auf der
 * Seitenleiste 150px, ein Finger ueberall rund 200px. Am Telefon zoomte
 * ausserdem das Aufziehen im Hauptinhalt nicht, obwohl der Viewport
 * `maximum-scale=5` zusagt (WCAG 1.4.4).
 *
 * Die Regel gilt fuer jede Fläche, nicht nur fuer den Scrollport: die
 * Dashboard-Zeilen tragen ihr eigenes `pan-y`, und eine dort begonnene Geste
 * rechnet mit IHREM Wert. `none` bleibt erlaubt - ein Sortiergriff besitzt
 * die Geste ganz und braucht keinen Zoom.
 */
test('a touch-action that restricts panning keeps pinch-zoom', () => {
  const styleDir = new URL('../public/styles/', import.meta.url);
  const offenders = [];

  for (const file of readdirSync(styleDir).filter((f) => f.endsWith('.css'))) {
    const css = readFileSync(new URL(file, styleDir), 'utf8');
    for (const rule of eachRule(css)) {
      for (const [, value] of rule.body.matchAll(/(?:^|[;{\s])touch-action\s*:\s*([^;]+)/g)) {
        const tokens = value.trim().toLowerCase().split(/\s+/);
        const restrictsPan = tokens.some((t) => /^pan-(?:x|y|left|right|up|down)$/.test(t));
        if (restrictsPan && !tokens.includes('pinch-zoom')) {
          offenders.push(`${file}: ${rule.selector} { touch-action: ${value.trim()} }`);
        }
      }
    }
  }

  assert.deepEqual(
    offenders,
    [],
    'pan-x/pan-y ohne pinch-zoom verwirft jeden Zwei-Finger-Bildlauf und das '
    + 'Aufziehen zum Zoomen (#1276) - `pinch-zoom` ergaenzen, z.B. `pan-y pinch-zoom`',
  );
});

// R24 S12 (Critique G0-Shell-P2-6, G3-Quer-P2-2): im Seitenwechsel und beim
// Scrollen legt die Shell die Seite nicht zusaetzlich aus. Gemessen bei 4x CPU
// in der Rueckkehr zur Uebersicht: Pille 17 ms, Tastatur-Abgleich 23 ms; beim
// Scrollen `router.js:onscroll` 40 ms erzwungenes Layout.
test('R24 S12: Pille, Tastatur-Abgleich und Port-Merker messen kein Layout, das sie nicht brauchen', () => {
  const fnBody = (name) => { const fn = routerJs.slice(routerJs.indexOf(`function ${name}`)); return fn.slice(0, fn.indexOf('\n}\n') + 2); };
  // Die Lage der Pille ist je Ziel gemerkt und wird beim Druck gemessen.
  assert.match(fnBody('tabGeometry'), /if \(cached\?\.key === key\) return cached;/, 'gemerkte Lage je Ziel');
  assert.match(routerJs, /items\.addEventListener\('pointerdown', warmTabGeometry/, 'gemessen beim Druck, vor dem Tausch');
  assert.match(routerJs, /_tabGeomEpoch \+= 1;/, 'eine neue Kapselgroesse verwirft die gemerkte Lage');
  // Ohne Tippfeld fragt der Abgleich den Viewport gar nicht.
  assert.match(fnBody('syncKeyboardVisible'), /const shrunk = focused && \(/, 'innerHeight erst mit Tippfeld');
  // Der Port-Merker liest keinen Scrollstand.
  const merker = routerJs.slice(routerJs.indexOf('let _lastContentPort = null;'), routerJs.indexOf('function scrollPageToTop'));
  assert.doesNotMatch(merker.replace(/^\s*\/\/.*$/gm, ''), /scrollTop/, 'kein scrollTop je Scroll-Ereignis');
  assert.match(fnBody('scrollPageToTop'), /el\.scrollTop > 0/, 'gefragt wird erst beim Tipp');
});
