/**
 * Tests: Der gepinnte Eintrag der Seitenleiste nach dem Neuaufbau (#2324)
 * Modul: /public/utils/sidebar-pinned.js, Aufrufer in /public/router.js
 *
 * Gemeldet war: in Einstellungen > Aktive Module ein Modul umschalten, und
 * „Einstellungen" steht zweimal in der Seitenleiste. `rebuildNavigation()`
 * legte den gepinnten Eintrag in den Scroller, waehrend der aus
 * `renderAppShell()` als Geschwister dahinter stehen blieb.
 *
 * Geprueft wird der ZUSTAND nach zwei Neuaufbauten, nicht ein einzelner Aufruf:
 * der Fehler entstand erst im Zusammenspiel von Erstaufbau und Neuaufbau.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { placeSidebarNavItems, PINNED_CLASS } from '../public/utils/sidebar-pinned.js';

// --------------------------------------------------------
// DOM-Attrappe: genau die Knotenoperationen, die der Helfer benutzt
// --------------------------------------------------------

function makeEl(className = '', name = '') {
  const el = {
    name,
    children: [],
    parentElement: null,
    classList: { contains: (cls) => el.className.split(/\s+/).includes(cls) },
    className,
    detach() {
      const siblings = el.parentElement?.children;
      if (siblings) siblings.splice(siblings.indexOf(el), 1);
      el.parentElement = null;
    },
    appendChild(child) {
      child.detach();
      child.parentElement = el;
      el.children.push(child);
      return child;
    },
    replaceChildren(...nodes) {
      for (const child of [...el.children]) child.detach();
      nodes.forEach((n) => el.appendChild(n));
    },
    after(...nodes) {
      const parent = el.parentElement;
      let index = parent.children.indexOf(el);
      for (const n of nodes) {
        n.detach();
        n.parentElement = parent;
        parent.children.splice(++index, 0, n);
      }
    },
    remove() { el.detach(); },
  };
  return el;
}

/** Was `sidebarNavItems()` liefert: Liste plus der gepinnte Einstellungs-Eintrag. */
function buildItems(modules) {
  return [
    ...modules.map((m) => makeEl('nav-item', m)),
    makeEl(`nav-item ${PINNED_CLASS}`, 'settings'),
  ];
}

/** Die Sidebar-Spalte wie in renderAppShell: Logo, Scroller, Fuss. */
function makeSidebar() {
  const sidebar = makeEl('nav-sidebar');
  const logo = makeEl('nav-sidebar__logo', 'logo');
  const scroller = makeEl('nav-sidebar__items', 'scroller');
  const account = makeEl('nav-sidebar__account', 'account');
  sidebar.appendChild(logo);
  sidebar.appendChild(scroller);
  sidebar.appendChild(account);
  return { sidebar, scroller };
}

const names = (nodes) => nodes.map((n) => n.name);
/** Alle Knoten der Spalte, eine Ebene tief (Scroller samt Inhalt). */
const settingsCount = (sidebar) => sidebar.children
  .flatMap((n) => [n, ...n.children])
  .filter((n) => n.name === 'settings').length;

test('erster Aufbau: Einstellungen stehen hinter dem Scroller, nicht darin', () => {
  const { sidebar, scroller } = makeSidebar();
  placeSidebarNavItems(scroller, buildItems(['dashboard', 'tasks']));
  assert.deepEqual(names(scroller.children), ['dashboard', 'tasks']);
  assert.deepEqual(names(sidebar.children), ['logo', 'scroller', 'settings', 'account']);
});

test('zweimal neu gebaut: Einstellungen genau einmal, die neue Modulliste steht (#2324)', () => {
  const { sidebar, scroller } = makeSidebar();
  placeSidebarNavItems(scroller, buildItems(['dashboard', 'tasks']));
  // Modul angeschaltet
  placeSidebarNavItems(scroller, buildItems(['dashboard', 'tasks', 'calendar']));
  // und wieder abgeschaltet
  placeSidebarNavItems(scroller, buildItems(['dashboard', 'tasks']));

  assert.equal(settingsCount(sidebar), 1, 'Einstellungen stehen genau einmal in der Seitenleiste');
  assert.deepEqual(names(scroller.children), ['dashboard', 'tasks'], 'der Scroller haelt nur die Modulliste');
  assert.deepEqual(names(sidebar.children), ['logo', 'scroller', 'settings', 'account'],
    'der gepinnte Eintrag steht an seinem Platz zwischen Liste und Kontozeile');
});

test('der Neuaufbau ersetzt den gepinnten Eintrag, statt den alten stehen zu lassen', () => {
  const { sidebar, scroller } = makeSidebar();
  placeSidebarNavItems(scroller, buildItems(['dashboard']));
  const first = sidebar.children.find((n) => n.name === 'settings');
  placeSidebarNavItems(scroller, buildItems(['dashboard']));
  const now = sidebar.children.filter((n) => n.name === 'settings');
  assert.equal(now.length, 1);
  assert.notEqual(now[0], first, 'der frisch gebaute Eintrag (neue Sprache, neuer Zustand) steht da');
});

test('rebuildNavigation und renderAppShell setzen die Seitenleiste ueber den Helfer', () => {
  // Ein Aufrufer am Helfer vorbei baut den Fehler wieder: replaceChildren mit
  // allen Elementen legt den gepinnten Eintrag in den Scroller.
  const router = readFileSync(new URL('../public/router.js', import.meta.url), 'utf8');
  const rebuild = /function rebuildNavigation\([\s\S]*?\n\}/.exec(router)?.[0] ?? '';
  assert.ok(rebuild, 'rebuildNavigation() ist nicht mehr auffindbar');
  assert.match(rebuild, /placeSidebarNavItems\(\s*navSidebarItems\s*,/,
    'rebuildNavigation() setzt die Seitenleiste nicht ueber placeSidebarNavItems()');
  assert.doesNotMatch(rebuild, /navSidebarItems\.replaceChildren\(/,
    'rebuildNavigation() fuellt den Scroller selbst und legt die Einstellungen hinein (#2324)');
  const shell = /function renderAppShell\([\s\S]*?\n\}/.exec(router)?.[0] ?? '';
  assert.match(shell, /splitPinnedNavItems\(\s*sidebarNavItems\(\)\s*\)/,
    'renderAppShell() teilt die Elemente nicht mehr ueber splitPinnedNavItems()');
});
