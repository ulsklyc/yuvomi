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
  forgetScrollPositions,
} from '../public/utils/scroll-restore.js';

const routerJs = readFileSync(new URL('../public/router.js', import.meta.url), 'utf8');
const layoutCss = readFileSync(new URL('../public/styles/layout.css', import.meta.url), 'utf8');
const glassCss = readFileSync(new URL('../public/styles/glass.css', import.meta.url), 'utf8');
const tokensCss = readFileSync(new URL('../public/styles/tokens.css', import.meta.url), 'utf8');

function cssRuleBody(css, selector) {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = css.match(new RegExp(`${escaped}\\s*\\{([^}]*)\\}`, 'm'));
  return match?.[1] ?? '';
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
  assert.match(tokensCss, /--nav-bottom-height:\s*calc\(var\(--nav-height-mobile\)[^;]*var\(--safe-area-inset-bottom\)\)/);
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
  const fn = routerJs.slice(routerJs.indexOf('function positionTabIndicator'));
  const body = fn.slice(0, fn.indexOf('\n}\n') + 2);

  assert.match(body, /querySelector\('\.nav-item__icon-well'\)/);
  assert.match(body, /Math\.min\(ar\.width - TAB_INDICATOR_INSET \* 2, TAB_INDICATOR_MAX_WIDTH\)/);
  assert.match(body, /indicator\.style\.height = `\$\{wr\.height\}px`/);
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
  assert.match(
    routerJs,
    /if \(shouldAnimate\) \{\s*pageWrapper\.classList\.add\(inClass\);/,
    'the slide class must only be applied after an existing route',
  );
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
  assert.match(
    routerJs,
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
 * Dieser Guard hält die Liste ehrlich: kommt ein neuntes Modul dazu oder
 * verliert eines seinen inneren Scroller, verschiebt sich die Reichweite der
 * Zusage - und Kommentar wie Spezifikation müssen mitziehen, statt still falsch
 * zu werden. Geprüft wird die REGEL über alle Modul-Stylesheets, nicht eine
 * Handvoll bekannter Dateien.
 */
test('the modules with an inner scroll container are the documented eight', () => {
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
      '.budget-page', '.calendar-page', '.contacts-page', '.meals-page',
      '.notes-page', '.pantry-page', '.recipes-page', '.shopping-page',
    ],
    'Die Module mit innerem Scroller haben sich geändert. Sie sind genau die, in '
    + 'denen Browser-Zurück NICHT an die alte Position zurückkehrt - die Liste in '
    + 'utils/scroll-restore.js und in docs/SPEC.md (Responsive Composition) muss mit.',
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
