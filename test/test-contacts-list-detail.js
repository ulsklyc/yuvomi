/**
 * Test: Kontakte in Liste + Detail (Breitenregel, DESIGN.md)
 * Zweck: Die Kontakte haengen den geteilten Baustein utils/master-detail.js ein.
 *        Der Baustein findet seine Zeilen NUR ueber `data-md-id` und fokussiert
 *        bei Pfeiltasten das Element mit `data-md-focus` - fehlt eines, steht
 *        die Detailspalte, aber keine Zeile ist waehlbar. Die Spalte zeigt
 *        ueber den Zeilen eine Karte mit Schnellaktionen (A5 P1-1), die nur
 *        anbietet, was der Kontakt hat, und Kontaktdaten nur als Text setzt;
 *        unter der Schwelle bleibt die Leseansicht, wie sie war. Die Suche im
 *        Kopf ist ab der Schwelle auf die Breite der Listenzeilen gedeckelt -
 *        ihre Container-Abfrage muss dieselbe Schwelle nennen wie layout.css.
 *        Geprueft wird das Verhalten der echten Funktionen, wo es eines gibt.
 * Ausfuehren: node --loader ./test/test-browser-loader.mjs --test test/test-contacts-list-detail.js
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { eachRule } from './css-rules.js';

// Die Seite zieht Web Components mit, die zur Ladezeit von HTMLElement
// ableiten (Muster aus test-module-readonly-ui.js).
globalThis.HTMLElement = globalThis.HTMLElement ?? class {};
globalThis.customElements = globalThis.customElements ?? { define() {}, get() {} };

const { installMiniDom } = await import('./mini-dom.js');
installMiniDom();

const { __test: contacts } = await import('../public/pages/contacts.js');

const read = (rel) => readFileSync(new URL(rel, import.meta.url), 'utf8');

const KONTAKT = {
  id: 42, name: 'Dr. Anna Weber', category: 'doctor', phone: '+49 231 4452210',
  email: 'praxis@example.org', address: 'Buergerstrasse 12, Dortmund',
  organization: 'Praxis am Markt', job_title: 'Allgemeinmedizin', family_user_id: null,
};

contacts.state.categories = [{ key: 'doctor', icon: 'stethoscope', name: 'Arzt' }];

test('jede Kontaktzeile ist fuer den Baustein waehlbar (data-md-id) und fokussierbar (data-md-focus)', () => {
  contacts.state.selectMode = false;
  const html = contacts.renderContactItem(KONTAKT);
  const row = html.match(/<div class="list-row[^"]*contact-item"[^>]*>/)?.[0];
  assert.ok(row, 'Zeile nicht gefunden - der Test liest das Markup nicht mehr');
  assert.match(row, /data-md-id="42"/, 'die Zeile traegt ihre ID fuer utils/master-detail.js');
  const main = html.match(/<button[^>]*class="contact-item__open[^>]*>/)?.[0];
  assert.ok(main, 'Hauptknopf nicht gefunden');
  assert.match(main, /\bdata-md-focus\b/, 'der Hauptknopf ist das Fokusziel der Pfeiltasten');
  assert.match(main, /data-open="42"/, 'der Klick-Weg der Zeile bleibt data-open');
});

test('im Auswahlmodus bleibt die Zeile bekannt, aber die Pfeiltasten gehoeren der Checkbox', () => {
  // Ohne `data-md-id` raeumte refresh() die Auswahl ab, sobald jemand den
  // Auswahlmodus betritt - der Kontakt rechts verschwaende ohne Grund.
  contacts.state.selectMode = true;
  try {
    const html = contacts.renderContactItem(KONTAKT);
    assert.match(html, /data-md-id="42"/);
    assert.doesNotMatch(html, /data-md-focus/, 'kein Fokusziel: die Pfeile bewegen hier keine Auswahl');
  } finally {
    contacts.state.selectMode = false;
  }
});

test('die Karte der Spalte bietet nur an, was der Kontakt hat, und setzt Daten als Text', () => {
  const card = contacts.contactCardEl(KONTAKT);
  const sub = card.childNodes.find((n) => n.className === 'contact-card__sub');
  assert.equal(sub?.textContent, 'Praxis am Markt · Allgemeinmedizin', 'Organisation und Position unter dem Bild');
  const bar = card.childNodes.find((n) => n.className === 'contact-card__actions');
  const hrefs = bar.childNodes.map((a) => a.href);
  assert.deepEqual(hrefs.map((h) => h.split(':')[0]), ['tel', 'mailto', 'https'],
    'Anrufen, E-Mail, Karte - in dieser Reihenfolge');
  assert.equal(bar.childNodes[0].dataset.phoneRaw, KONTAKT.phone,
    'der tel:-Link bekommt die E.164-Aufbereitung der Liste (enhancePhones)');
  // Organisation kommt ungeprueft aus CardDAV: als Text, nie als Markup.
  const boese = contacts.contactCardEl({ ...KONTAKT, organization: '<img src=x onerror=alert(1)>' });
  assert.match(boese.outerHTML, /&lt;img src=x/, 'die Organisation steht als Text in der Karte');
  assert.doesNotMatch(boese.outerHTML, /<img src=x/, 'kein Markup-Pfad fuer Kontaktdaten');

  const nackt = contacts.contactCardEl({ id: 7, name: 'Leer', category: 'doctor' });
  assert.equal(nackt.childNodes.find((n) => n.className === 'contact-card__actions'), undefined,
    'ohne Nummer, Mail und Adresse gibt es keine Aktionsreihe - keinen Knopf ins Leere');
  assert.equal(nackt.childNodes.find((n) => n.className === 'contact-card__sub'), undefined,
    'ohne Organisation keine Unterzeile (die Kategorie steht als Zeile darunter)');
});

test('die Organisation steht in der Spalte einmal (Karte), in der Leseansicht wie bisher als Zeile', () => {
  const org = (sections) => sections.find((s) => s.icon === 'building-2');
  assert.equal(org(contacts.renderContactDetail(KONTAKT)).hidden, false,
    'unter der Schwelle bleibt die Leseansicht, wie sie war');
  assert.equal(org(contacts.renderContactDetail(KONTAKT, { inPane: true })).hidden, true,
    'in der Spalte traegt sie die Karte - zweimal dieselbe Zeile waere Rauschen');
});

test('die Seite haengt Liste + Detail ein: Klick ueber den Baustein, Signal des Routers, Leerzustand', () => {
  const src = read('../public/pages/contacts.js');
  assert.match(src, /app-page--list-detail/, 'die Wurzel ist der Container der Schwelle');
  assert.match(src, /class="split-view contacts-split">\s*<div id="contacts-list" class="[^"]*\bsplit-view__list\b/,
    'der bisherige Scrollport ist die linke Spalte');
  assert.match(src, /splitViewDetailHtml\(\{[\s\S]*?label: t\('contacts\.detailPaneLabel'\)[\s\S]*?t\('contacts\.pickOne'\)/,
    'die Spalte hat einen Namen und einen Leerzustand');
  assert.match(src, /mountMasterDetail\(\{[\s\S]*?signal,/, 'der Baustein baut mit der Seite ab');
  assert.match(src, /if \(md\) md\.open\(open\.dataset\.open, open\)/,
    'der Zeilen-Klick geht ueber den Baustein: in der Spalte auswaehlen, darunter oeffnen');
  // Jeder Neuaufbau der Liste meldet sich beim Baustein - sonst stuende rechts
  // ein geloeschter oder weggefilterter Kontakt.
  const renderList = src.slice(src.indexOf('function renderList('));
  const body = renderList.slice(0, renderList.indexOf('\n}\n'));
  assert.equal((body.match(/md\?\.refresh\(\)/g) ?? []).length, 2,
    'beide Ausgaenge von renderList (leer und gefuellt) melden sich beim Baustein');
});

test('die Suche nennt dieselbe Schwelle wie layout.css und deckelt auf die Listenbahn', () => {
  const tokens = read('../public/styles/tokens.css');
  const threshold = Number(tokens.match(/--layout-split-threshold:\s*([0-9.]+)rem/)?.[1]);
  assert.ok(threshold > 0, 'tokens.css: --layout-split-threshold fehlt');
  let seen = false;
  for (const { selector, body, at } of eachRule(read('../public/styles/contacts.css'))) {
    const chain = at.join(' ');
    if (!/@container\s+module-surface/.test(chain)) continue;
    const width = Number(chain.match(/min-width:\s*([0-9.]+)rem/)?.[1]);
    assert.equal(width, threshold,
      `contacts.css: @container module-surface ${width}rem, tokens.css ${threshold}rem - @container kann keine Variable lesen`);
    if (selector.trim() === '.contacts-toolbar__search') {
      seen = true;
      assert.match(body, /max-inline-size:[\s\S]*--layout-list-min[\s\S]*--layout-list-max/,
        'die Kappung kommt aus der Formel der Listenbahn, nicht aus einer Zahl');
    }
  }
  assert.ok(seen, 'die Suche ist ab der Schwelle nicht gedeckelt - sie liefe quer ueber das Detail');
});
