/**
 * Tests: Die Zahl am Nav-Ziel (#868)
 * Modul: /public/utils/nav-badges.js
 *
 * Gemeldet war: nach dem Anmelden fehlt das Badge mit den ueberfaelligen
 * Aufgaben und erscheint erst nach einem Besuch der Aufgabenseite.
 *
 * DIE ZWEI FEHLER, GEGEN DIE HIER GEPRUEFT WIRD, sind beide Zustandsfehler und
 * keine Zeichenfehler - ein Test auf „erzeugt ein span.nav-badge" waere gruen
 * und blind gewesen, denn genau das tat der alte Code auch:
 *   1. die Zahl kam aus dem Zustand eines Moduls, das noch nicht gerendert war,
 *   2. und sie verschwand, sobald `rebuildNavigation()` die Navigation neu
 *      baute (`replaceChildren()`), bis das Modul erneut rendert.
 * Der zweite Fall ist der unangenehmere: nach einem Sprachwechsel kam das
 * Badge unter Umstaenden gar nicht mehr.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

// --------------------------------------------------------
// DOM-Attrappe: nur so viel, wie das Modul anfasst
// --------------------------------------------------------

function makeEl(tag = 'div') {
  const el = {
    tagName: tag.toUpperCase(),
    className: '',
    textContent: '',
    children: [],
    attrs: {},
    parent: null,
    setAttribute(name, value) { this.attrs[name] = String(value); },
    getAttribute(name) { return this.attrs[name] ?? null; },
    appendChild(child) { child.parent = this; this.children.push(child); return child; },
    prepend(child) { child.parent = this; this.children.unshift(child); return child; },
    replaceWith(next) {
      const siblings = this.parent?.children;
      if (!siblings) return;
      siblings[siblings.indexOf(this)] = next;
      next.parent = this.parent;
    },
    remove() {
      const siblings = this.parent?.children;
      if (!siblings) return;
      siblings.splice(siblings.indexOf(this), 1);
      this.parent = null;
    },
    // Reicht fuer die zwei Klassen, die das Modul sucht.
    querySelector(sel) { return this.querySelectorAll(sel)[0] ?? null; },
    querySelectorAll(sel) {
      const cls = sel.replace(/^\./, '');
      const hits = [];
      for (const child of this.children) {
        if (child.className.split(/\s+/).includes(cls)) hits.push(child);
        hits.push(...child.querySelectorAll(sel));
      }
      return hits;
    },
  };
  return el;
}

/**
 * Ein Nav-Eintrag, wie ihn die Navigation baut: ein Ziel mit `data-route` und
 * einem Icon darin.
 */
function makeNavItem(route) {
  const item = makeEl('a');
  item.route = route;
  const icon = makeEl('i');
  icon.className = 'nav-item__icon';
  item.appendChild(icon);
  return item;
}

let instanceSeq = 0;

/**
 * Frische Modulinstanz je Test - der Badge-Speicher ist Modulzustand.
 * Die „Navigation" ist eine Liste von Nav-Eintraegen; `rebuild()` ersetzt sie
 * durch frische, genau wie `replaceChildren()` es im Router tut.
 */
async function freshModule(routes = ['/tasks'], pageRoutes = []) {
  let navItems = routes.map(makeNavItem);
  // Seiteninhalt mit derselben Route, ABSICHTLICH ausserhalb der Navigation -
  // Widget-Kacheln, Cockpit-Karten und FAB-Kurzwahlen tragen `data-route`
  // genauso. Sie duerfen kein Badge abbekommen.
  let pageItems = pageRoutes.map(makeNavItem);

  const scope = {
    querySelectorAll(sel) {
      const match = /^\[data-route="([^"]+)"\]$/.exec(sel);
      if (!match) return [];
      return navItems.filter((item) => item.route === match[1]);
    },
  };
  globalThis.document = {
    createElement: makeEl,
    querySelectorAll(sel) {
      // Der Modul-Selektor fragt zuerst nach den Nav-Containern.
      if (sel === '.nav-sidebar, .nav-bottom') return [scope];
      const match = /^\[data-route="([^"]+)"\]$/.exec(sel);
      if (!match) return [];
      return [...navItems, ...pageItems].filter((item) => item.route === match[1]);
    },
  };
  const mod = await import(`../public/utils/nav-badges.js?instance=${++instanceSeq}`);
  return {
    ...mod,
    rebuild() { navItems = routes.map(makeNavItem); },
    pageItem(index = 0) { return pageItems[index]; },
    badgeText(route) {
      const item = navItems.find((n) => n.route === route);
      return item?.querySelectorAll('.nav-badge')[0]?.textContent ?? null;
    },
    label(route) {
      return navItems.find((n) => n.route === route)?.getAttribute('aria-label') ?? null;
    },
    badgeCount(route) {
      const item = navItems.find((n) => n.route === route);
      return item ? item.querySelectorAll('.nav-badge').length : 0;
    },
  };
}

// --------------------------------------------------------

test('eine gesetzte Zahl erscheint am Nav-Ziel', async () => {
  const nav = await freshModule();
  nav.setNavBadge('/tasks', 3);
  assert.equal(nav.badgeText('/tasks'), '3');
});

test('die Zahl ueberlebt einen Neuaufbau der Navigation (#868)', async () => {
  // DAS IST DER ZWEITE GEMELDETE FEHLER. `rebuildNavigation()` laeuft bei
  // Sprachwechsel, Modul-Umschaltung und Kontowechsel und ersetzt die
  // Nav-Eintraege komplett. Vorher war das Badge danach weg, bis das Modul
  // erneut rendert - nach einem Sprachwechsel unter Umstaenden nie.
  const nav = await freshModule();
  nav.setNavBadge('/tasks', 3);

  nav.rebuild();
  assert.equal(nav.badgeText('/tasks'), null, 'der Neuaufbau hat die Navigation frisch gebaut');

  nav.applyNavBadges();
  assert.equal(nav.badgeText('/tasks'), '3', 'die gemerkte Zahl ist wieder da');
});

test('null entfernt das Badge, statt eine Null hinzuschreiben', async () => {
  const nav = await freshModule();
  nav.setNavBadge('/tasks', 3);
  nav.setNavBadge('/tasks', 0);
  assert.equal(nav.badgeCount('/tasks'), 0);
});

test('eine Null bleibt auch nach dem Neuaufbau eine Leerstelle', async () => {
  // Sonst haette der Speicher die Null als „male eine 0" gemerkt.
  const nav = await freshModule();
  nav.setNavBadge('/tasks', 0);
  nav.rebuild();
  nav.applyNavBadges();
  assert.equal(nav.badgeCount('/tasks'), 0);
});

test('ein zweites Setzen ersetzt das Badge, es sammelt sich nichts an', async () => {
  const nav = await freshModule();
  nav.setNavBadge('/tasks', 3);
  nav.setNavBadge('/tasks', 4);
  assert.equal(nav.badgeCount('/tasks'), 1, 'genau ein Badge am Ziel');
  assert.equal(nav.badgeText('/tasks'), '4');
});

test('ab hundert steht 99+ statt einer dreistelligen Zahl', async () => {
  const nav = await freshModule();
  nav.setNavBadge('/tasks', 100);
  assert.equal(nav.badgeText('/tasks'), '99+');
  nav.setNavBadge('/tasks', 99);
  assert.equal(nav.badgeText('/tasks'), '99');
});

test('die Ansage steht im Namen des ZIELS, nicht im Badge', async () => {
  // „3" neben „Aufgaben" vorgelesen ergibt keinen Satz.
  const nav = await freshModule();
  nav.setNavBadge('/tasks', 3, (count) => `Aufgaben, ${count} ueberfaellig`);
  assert.equal(nav.label('/tasks'), 'Aufgaben, 3 ueberfaellig');

  const item = document.querySelectorAll('[data-route="/tasks"]')[0];
  const badge = item.querySelectorAll('.nav-badge')[0];
  assert.equal(badge.getAttribute('aria-hidden'), 'true');
});

test('die Beschriftung wird bei jedem Zeichnen neu ausgewertet', async () => {
  // Sie haengt an der Sprache. Ein fertiger String stuende nach einem
  // Sprachwechsel in der alten Sprache da - und der Sprachwechsel ist genau
  // einer der Anlaesse, bei denen die Navigation neu gebaut wird.
  const nav = await freshModule();
  let sprache = 'de';
  nav.setNavBadge('/tasks', 3, (count) => (sprache === 'de' ? `Aufgaben, ${count} ueberfaellig` : `Tasks, ${count} overdue`));
  assert.equal(nav.label('/tasks'), 'Aufgaben, 3 ueberfaellig');

  sprache = 'en';
  nav.rebuild();
  nav.applyNavBadges();
  assert.equal(nav.label('/tasks'), 'Tasks, 3 overdue');
});

test('auch der leere Fall bekommt seinen Namen', async () => {
  // Sonst bliebe „Aufgaben, 3 ueberfaellig" stehen, nachdem die letzte
  // ueberfaellige Aufgabe erledigt wurde.
  const nav = await freshModule();
  const label = (count) => (count > 0 ? `Aufgaben, ${count} ueberfaellig` : 'Aufgaben');
  nav.setNavBadge('/tasks', 3, label);
  nav.setNavBadge('/tasks', 0, label);
  assert.equal(nav.label('/tasks'), 'Aufgaben');
});

test('dasselbe Ziel in Seitenleiste UND Tab-Bar bekommt beide Badges', async () => {
  // Auf Tablet-Breiten stehen beide gleichzeitig im DOM.
  const nav = await freshModule(['/tasks', '/tasks']);
  nav.setNavBadge('/tasks', 5);
  const items = document.querySelectorAll('[data-route="/tasks"]');
  assert.equal(items.length, 2);
  for (const item of items) {
    assert.equal(item.querySelectorAll('.nav-badge')[0]?.textContent, '5');
  }
});

test('das Sitzungsende vergisst die Zahlen', async () => {
  // Sie gehoeren dem Mitglied, nicht dem Geraet: sonst baute die naechste
  // Anmeldung am selben Geraet ihre Badges aus den Zahlen des vorigen.
  const nav = await freshModule();
  nav.setNavBadge('/tasks', 3);
  nav.resetNavBadges();

  nav.rebuild();
  nav.applyNavBadges();
  assert.equal(nav.badgeCount('/tasks'), 0);
});

test('das Badge haengt am Icon, nicht am ganzen Nav-Eintrag', async () => {
  // Sonst saesse die Zahl an der Ecke des Eintrags statt an der des Symbols.
  const nav = await freshModule();
  nav.setNavBadge('/tasks', 3);
  const item = document.querySelectorAll('[data-route="/tasks"]')[0];
  const wrap = item.querySelectorAll('.nav-item__icon-wrap')[0];
  assert.ok(wrap, 'die Icon-Huelle wurde nachgeruestet');
  assert.ok(wrap.children.some((c) => c.className === 'nav-badge'),
    'das Badge liegt in der Huelle');
  assert.ok(wrap.children.some((c) => c.className === 'nav-item__icon'),
    'und das Icon ist mit hineingewandert, nicht ersetzt worden');
});

// --------------------------------------------------------
// Die Ableitung aus der /dashboard-Antwort
//
// SIE STAND BIS #868 MITTEN IM ROUTER und rief dort ein `isAdmin()`, das es in
// jener Datei nie gab - es lebt modul-lokal in pages/rewards.js. Der Aufruf
// warf bei JEDEM Durchlauf, ein `catch` schluckte den ReferenceError, und die
// Zaehlstaende der Modulkacheln kamen nie an. Es fiel niemandem auf, weil ein
// Blatt ohne Badges genauso aussieht wie eines ohne wartende Arbeit.
//
// Dass die Ableitung jetzt eine reine Funktion mit Parametern ist, IST der
// Fix: diese Tests haetten den Fehler in der ersten Sekunde gefangen.
// --------------------------------------------------------

const { moduleCountsFrom, navBadgeCountsFrom } = await import('../public/utils/nav-badges.js');

const DASHBOARD = Object.freeze({
  openTaskCount: 7,
  overdueTaskCount: 3,
  shoppingOpenCount: 4,
  rewards: { pending: 2 },
  health: { dosesTotal: 5, dosesTaken: 1, dosesSkipped: 1 },
  // Die Liste ist der gedeckelte Vorrat der Kachel; der Zaehler daneben ist
  // die ungedeckelte Wahrheit - hier absichtlich groesser als die Liste.
  birthdays: [
    { name: 'A', days_until: 0 },
    { name: 'B', days_until: 3 },
    { name: 'C', days_until: 4 },
    { name: 'D' },
  ],
  birthdaySoonCount: 7,
});

test('die Ableitung laeuft ueberhaupt durch (#868)', () => {
  // Der eigentliche Regressionstest. Vorher warf dieser Aufruf.
  assert.doesNotThrow(() => moduleCountsFrom(DASHBOARD, { isAdmin: true, shoppingVisible: true }));
});

test('die Zahlen der Modulkacheln kommen aus der Nutzlast', () => {
  const counts = moduleCountsFrom(DASHBOARD, { isAdmin: true, shoppingVisible: true });
  assert.equal(counts.tasks, 7, 'die Kachel zeigt OFFENE, nicht ueberfaellige Aufgaben');
  assert.equal(counts.shopping, 4);
  assert.equal(counts.health, 3, 'offene Dosen = gesamt minus genommen minus uebersprungen');
});

test('die offene Belohnungsanfrage sieht nur ein Elternteil', () => {
  // `rewards.pending` zaehlt den ganzen Haushalt; einem Kind waerbe die Zahl
  // mit Arbeit, hinter der fuer es nichts steht.
  assert.equal(moduleCountsFrom(DASHBOARD, { isAdmin: true }).rewards, 2);
  assert.equal(moduleCountsFrom(DASHBOARD, { isAdmin: false }).rewards, 0);
  // Geld-Anfragen (#1734) fuehrt der Server in einem eigenen Feld; das Zeichen
  // am Modul zaehlt beide, und weiter nur fuer Eltern.
  const mitGeld = { ...DASHBOARD, rewards: { pending: 2, moneyPending: 3 } };
  assert.equal(moduleCountsFrom(mitGeld, { isAdmin: true }).rewards, 5);
  assert.equal(moduleCountsFrom(mitGeld, { isAdmin: false }).rewards, 0);
});

test('die Kuechenkachel traegt den Einkauf nur, wenn er offensteht', () => {
  assert.equal(moduleCountsFrom(DASHBOARD, { shoppingVisible: true }).kitchen, 4);
  assert.equal(moduleCountsFrom(DASHBOARD, { shoppingVisible: false }).kitchen, 0,
    'sonst wirbt das EINE Kuechenziel mit Arbeit in einem Modul, das sich nicht oeffnen laesst');
});

test('mehr genommene Dosen als geplante ergeben keine negative Zahl', () => {
  const counts = moduleCountsFrom({ health: { dosesTotal: 1, dosesTaken: 3, dosesSkipped: 0 } });
  assert.equal(counts.health, 0);
});

test('eine leere Antwort ergibt Nullen, keine Ausnahme', () => {
  assert.doesNotThrow(() => moduleCountsFrom(undefined));
  assert.deepEqual(moduleCountsFrom(null), { tasks: 0, shopping: 0, rewards: 0, health: 0, kitchen: 0 });
});

test('die Zahlen der Nav-Ziele sind ANDERE als die der Kacheln (#868)', () => {
  const nav = navBadgeCountsFrom(DASHBOARD);
  assert.equal(nav['/tasks'], 3,
    'das Nav-Icon zeigt UEBERFAELLIGE Aufgaben, die Kachel im Mehr-Blatt die offenen');
  assert.equal(navBadgeCountsFrom(DASHBOARD)['/tasks'] !== moduleCountsFrom(DASHBOARD).tasks, true);
});

test('die Geburtstagszahl kommt aus dem SERVER-Zaehler, nicht aus der Liste', () => {
  // `data.birthdays` ist auf fuenf geschnitten - der Vorrat der
  // Dashboard-Kachel, keine Aussage ueber den Bestand. Wer daraus zaehlte,
  // gaebe einem Haushalt mit sieben Geburtstagen in drei Tagen beim Start eine
  // Fuenf und nach dem ersten Besuch der Seite eine Sieben.
  assert.equal(navBadgeCountsFrom(DASHBOARD)['/birthdays'], 7);
  assert.equal(navBadgeCountsFrom({ ...DASHBOARD, birthdaySoonCount: undefined })['/birthdays'], 0,
    'ohne Zaehler KEIN Ersatz aus der gedeckelten Liste - lieber kein Badge als ein falsches');
});

test('auch die Nav-Zahlen ertragen eine leere Antwort', () => {
  assert.deepEqual(navBadgeCountsFrom(undefined), { '/tasks': 0, '/birthdays': 0 });
});

test('nur die Navigation bekommt die Zahl, nicht jeder Link mit dieser Route', async () => {
  // `data-route` ist app-weit der Weg, einem beliebigen Element eine Route zu
  // geben. Ein Selektor ueber das ganze Dokument haengte die Zahl in die SEITE:
  // gemessen bekam der Aufgaben-Knopf im FAB-Menue eine Icon-Huelle samt Badge,
  // und sein Name wurde mit „Aufgaben, 3 ueberfaellig" ueberschrieben.
  const nav = await freshModule(['/tasks'], ['/tasks', '/tasks']);
  nav.setNavBadge('/tasks', 3, (count) => `Aufgaben, ${count} ueberfaellig`);

  assert.equal(nav.badgeText('/tasks'), '3', 'das Nav-Ziel traegt die Zahl');

  for (const index of [0, 1]) {
    const fremd = nav.pageItem(index);
    assert.equal(fremd.querySelectorAll('.nav-badge').length, 0,
      'ein Element ausserhalb der Navigation bekommt kein Nav-Badge');
    assert.equal(fremd.querySelectorAll('.nav-item__icon-wrap').length, 0,
      'und auch keine fremde Icon-Huelle in sein Layout');
    assert.equal(fremd.getAttribute('aria-label'), null,
      'und sein Name bleibt seiner');
  }
});
