/**
 * Modul: Nur-lesen-Rechte in der Oberfläche (#467, Codex-Review zu PR #1241)
 * Zweck: Drei Seiten zeichneten ihre SCHREIBENDEN Bedienelemente auch dann,
 *        wenn der Nutzer auf das Modul nur `read` hat. Der Server wies die
 *        Aufrufe korrekt mit 403 ab - sichtbar wurde das als Fehlermeldung
 *        oder, beim optimistischen Abhaken, als zurückspringende Checkbox.
 *
 *        Die Regel, die hier geprüft wird, hat zwei Hälften:
 *          - Ein Element, das ZUSTAND ANZEIGT (der Erledigt-Haken einer
 *            Aufgabe, der Haken einer Unteraufgabe), bleibt STEHEN - aber als
 *            `span`, dessen Beschriftung den Zustand nennt, nicht als
 *            `disabled`-Knopf. Der trüge Treffläche und Hover-Rahmen weiter
 *            und verspräche „als erledigt markieren" für eine Berührung, die
 *            nichts tut. Die Begründung steht seit #1209 an der Teilaufgabe
 *            des Wandtabletts; hier gilt sie Wort für Wort.
 *          - Ein reiner HANDLUNGSKNOPF (bearbeiten, löschen, ablegen,
 *            Unteraufgabe anlegen, Sammelaktionsleiste, einlösen, freigeben)
 *            VERSCHWINDET. Er sagt nichts, was neben ihm nicht schon stünde.
 *
 *        Die verbindliche Sperre bleibt serverseitig (server/index.js); dies
 *        ist die ehrliche UI-Entsprechung dazu.
 *
 *        EIN WANDTABLETT IST EIN NUR-LESEN-NUTZER MIT ZWEI AUSNAHMEN (#1209).
 *        Seine Scope-Liste ist `tasks:read`/`rewards:read`, die zwei erlaubten
 *        Schreibwege führt der Server als benannte Routen
 *        (`DISPLAY_WRITE_ROUTES`), nicht als Modulrecht. Die Modulregel hier
 *        darf sie deshalb nicht mitreißen - ohne Personenauswahl und
 *        Einlöse-Knopf hätte ein Tablett genau die zwei Dinge verloren, für
 *        die es aufgehängt wird. Jede dieser Stellen fragt zuerst
 *        `actingAsDisplay()`; die Tests unten halten beide Richtungen fest.
 *
 *        Aufgaben und Belohnungen werden am echten Markup gemessen: ihre
 *        Zeilen-, Karten- und Leerzustands-Renderer sind reine Funktionen und
 *        über `__test` erreichbar. Der Kalender hat keine solche Funktion -
 *        sein Kopf und seine Detailansicht bauen direkt ins DOM -, deshalb
 *        stehen seine sechs Weichen als Quelltext-Zusicherungen hier, nach
 *        demselben Muster wie test/test-router-guest-guard.js. Gemessen wird
 *        dabei der KOMMENTARFREIE Quelltext: sonst hielte ausgerechnet die
 *        Begründung den Test grün (siehe WASTE_CODE in test-waste-ui.js).
 *
 *        DAZU DIE KREUZABHAENGIGKEIT (#1253, Abschnitt am Ende). Alles
 *        oben prueft das EIGENE Modul. Der Aufgaben-Dialog stellt aber auch
 *        die Erinnerung ein, und Erinnerungen gehoeren dem KALENDER -
 *        `server/scopes.js` fuehrt `calendar`, `reminders` und `birthdays`
 *        unter einem Schluessel. `tasks: write` plus `calendar: read` zeigte
 *        deshalb einen Schalter, dessen Speichern mit 403 endete.
 *        `applyModuleReadonly()` im Router sieht das nicht: es urteilt ueber
 *        das gerade offene Nav-Modul. Dieser Teil fuehrt als einziger einen
 *        Handler WIRKLICH aus (`handleFormSubmit`), weil die Zusage dort das
 *        AUSBLEIBEN einer Anfrage ist - das sieht kein Textguard.
 *
 *        Die Suite braucht deshalb TZ=Europe/Berlin (siehe die Zone-Zeile in
 *        jenem Abschnitt); das npm-Script setzt sie.
 *
 * Ausführen: npm run test:module-readonly-ui
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { eachRule } from './css-rules.js';

// Die Seiten ziehen Web Components mit, die zur Ladezeit von HTMLElement
// ableiten. Node kennt das Global nicht; ein leerer Platzhalter reicht, weil
// hier nur reine Funktionen geprüft werden (Muster aus test-task-groups.js).
globalThis.HTMLElement = globalThis.HTMLElement ?? class {};
globalThis.customElements = globalThis.customElements ?? { define() {}, get() {} };

// Der Leerzustand geht durch emptyStateHTML(), und das BAUT Knoten. Der Stub
// gibt Attribute in outerHTML aus; dass er das wirklich tut, sichert jeder
// dieser Tests selbst ab, indem er den Schreibrecht-Fall mitprueft - bliebe die
// gesuchte id dort aus, waere der Stub kaputt und der Test rot.
const { installMiniDom } = await import('./mini-dom.js');
const miniDomAbraeumen = installMiniDom();

const { setPermissions, clearPermissions } = await import('../public/permissions.js');
const { canEditTaskDefinition } = await import('../public/utils/task-fields.js');
const { __test: detail } = await import('../public/components/task-detail.js');
const { renderMarkdownLight } = await import('../public/utils/html.js');
const { __test: tasks } = await import('../public/pages/tasks.js');
const { __test: rewards } = await import('../public/pages/rewards.js');
const { __test: calendar } = await import('../public/pages/calendar.js');
// #1265 P1: Pinnwand, Kontakte, Geburtstage.
const { __test: notes } = await import('../public/pages/notes.js');
const { __test: contacts } = await import('../public/pages/contacts.js');
const { __test: birthdays } = await import('../public/pages/birthdays.js');
// #1265 P2: Gesundheit (acht Tabs).
const { __test: health } = await import('../public/pages/health.js');

/** Ein Modul auf 'read' stellen und danach wieder aufräumen. */
function withAccess(modules, fn) {
  setPermissions({ admin: false, modules, widgets: {}, capabilities: {} });
  // EIN `finally` UM EIN PROMISE HERUM FEUERT AM ERSTEN `await`, NICHT AM ENDE.
  // Die rund vierzig Tests oben sind synchron, fuer sie aendert der Zweig
  // nichts. Der Erinnerungs-Abschnitt unten faehrt aber einen async Handler:
  // dort raeumte `clearPermissions()` die Rechte weg, sobald der Handler das
  // erste Mal wartete, und alles danach las wieder den fail-open-Standard
  // `write`. Nachgemessen am echten Helfer: vor dem await `calendar = read`,
  // danach `calendar = write`.
  //
  // Heute faellt darauf keine Zusicherung herein, weil jede rechte-abhaengige
  // Entscheidung vor dem ersten await getroffen und gemerkt wird. Das ist
  // Glueck, keine Zusage - und weil der Standard fail-OPEN ist, waere ein
  // spaeteres Nachlesen still zu `write` geworden statt rot. Der naechste
  // async Test erbte die Falle ohne das Glueck.
  let ergebnis;
  try {
    ergebnis = fn();
  } catch (err) {
    clearPermissions();
    throw err;
  }
  if (typeof ergebnis?.then === 'function') return ergebnis.finally(() => clearPermissions());
  clearPermissions();
  return ergebnis;
}

const mitglied = (over = {}) => ({ id: 3, display_name: 'Emma', balance: 120, ...over });

const aufgabe = (over = {}) => ({
  id: 7, title: 'Müll rausbringen', status: 'open', category: 'household',
  due_date: null, subtasks: [], subtask_total: 0, subtask_done: 0, ...over,
});

// -------------------------------------------------------------------------
// Die geteilte Domänenregel: darf ich die DEFINITION einer Aufgabe ändern?
// -------------------------------------------------------------------------

test('canEditTaskDefinition: `tasks: read` schlägt jede Urheberschaft', () => {
  const eigene = aufgabe({ locked: 0, created_by: 1 });
  // Ohne Rechte-Overrides (fail-open) bleibt alles wie zuvor.
  assert.equal(canEditTaskDefinition(eigene, null, { isAdmin: false, currentUserId: 1 }), true);

  withAccess({ tasks: 'read' }, () => {
    assert.equal(canEditTaskDefinition(eigene, null, { isAdmin: false, currentUserId: 1 }), false,
      'die eigene, ungesperrte Aufgabe bleibt unantastbar, wenn das Modul nur lesbar ist');
    assert.equal(canEditTaskDefinition(eigene, null, { isAdmin: true, currentUserId: 99 }), false,
      'auch der Admin-Bypass aus #830 hebt das Modulrecht nicht auf');
  });

  withAccess({ tasks: 'write' }, () => {
    assert.equal(canEditTaskDefinition(eigene, null, { isAdmin: false, currentUserId: 1 }), true);
  });
});

// -------------------------------------------------------------------------
// Aufgaben: die Zeile
// -------------------------------------------------------------------------

test('Aufgabenzeile mit Schreibrecht: alle Bedienelemente stehen da', () => {
  withAccess({ tasks: 'write' }, () => {
    const html = tasks.renderTaskCard(aufgabe({ subtasks: [{ id: 8, title: 'Tonne', status: 'open' }] }));
    assert.match(html, /data-action="edit-task"/);
    assert.match(html, /data-action="archive-task"/);
    assert.match(html, /data-action="add-subtask"/);
    assert.match(html, /data-action="rename-subtask"/);
    assert.match(html, /data-action="delete-subtask"/);
    assert.doesNotMatch(html, /data-action="toggle-status"[^>]*disabled/,
      'mit Schreibrecht ist der Haken bedienbar');
  });
});

test('Aufgabenzeile mit `tasks: read`: der Haken wird zum Zustandszeichen', () => {
  withAccess({ tasks: 'read' }, () => {
    const html = tasks.renderTaskCard(aufgabe({ subtasks: [{ id: 8, title: 'Tonne', status: 'done' }] }));

    // Zustand ANZEIGEN: bleibt stehen - als span, nicht als gesperrter Knopf.
    assert.match(html, /<span class="task-status-btn task-status-btn--open task-status-btn--static check-ring check-ring--static"[\s\S]*?role="img"/,
      'der Erledigt-Haken zeigt den Zustand der Aufgabe und darf nicht verschwinden');
    assert.doesNotMatch(html, /data-action="toggle-status"/,
      'aber er ist kein Knopf mehr: ein disabled-Knopf verspricht eine Berührung, die nichts tut');
    assert.match(html, /subtask-item__checkbox--static[\s\S]*?role="img"/,
      'derselbe Grund und dieselbe Bauart für den Haken einer Unteraufgabe (#1209)');
    assert.doesNotMatch(html, /data-action="toggle-subtask"/);
    // Die Beschriftung nennt den ZUSTAND, nicht eine Handlung.
    assert.match(html, /aria-label="[^"]*tasks\.statusOpen"/,
      'nicht "als erledigt markieren", sondern "Titel: offen"');
    assert.doesNotMatch(html, /tasks\.markDone/);
    // Und der Zustand steht wirklich noch daneben.
    assert.match(html, /subtask-item--done/);
    assert.match(html, /Tonne/);

    // Reine HANDLUNG: verschwindet.
    assert.doesNotMatch(html, /data-action="edit-task"/);
    assert.doesNotMatch(html, /data-action="archive-task"/);
    assert.doesNotMatch(html, /data-action="unarchive-task"/);
    assert.doesNotMatch(html, /data-action="add-subtask"/);
    assert.doesNotMatch(html, /data-action="rename-subtask"/);
    assert.doesNotMatch(html, /data-action="delete-subtask"/);

    // Der Leseweg bleibt: die Zeile führt weiter in die Detailansicht.
    assert.match(html, /data-action="open-task"/);
  });
});

// DAS ZEICHEN NENNT JEDEN DER DREI ZUSTAENDE BEIM NAMEN. Die Beschriftung
// kannte nur „erledigt oder nicht" und rief eine begonnene Aufgabe „offen" -
// sehend sah man den gelben Ring, der Screenreader sagte das Gegenteil. Der
// Knopf mit Schreibrecht braucht die Unterscheidung nicht, weil er eine
// Handlung nennt; das Zeichen nennt den Zustand und muss ihn deshalb treffen.
test('Zustandszeichen bei `tasks: read`: eine begonnene Aufgabe heisst "In Bearbeitung", nicht "Offen"', () => {
  const zustaende = [
    ['open', 'tasks.statusOpen'],
    ['in_progress', 'tasks.statusInProgress'],
    ['done', 'tasks.statusDone'],
  ];
  withAccess({ tasks: 'read' }, () => {
    for (const [status, key] of zustaende) {
      const html = tasks.renderTaskCard(aufgabe({ status }));
      const zeichen = html.match(/<span class="task-status-btn [^"]*task-status-btn--static check-ring check-ring--static"[^>]*aria-label="([^"]*)"/);
      assert.ok(zeichen, `Zeichen fuer ${status} vorhanden`);
      assert.equal(zeichen[1], `Müll rausbringen: ${key}`, `Aufgabe im Zustand ${status}`);

      const mitTeil = tasks.renderTaskCard(aufgabe({ subtasks: [{ id: 8, title: 'Tonne', status }] }));
      const teil = mitTeil.match(/subtask-item__checkbox--static[^"]*"[^>]*aria-label="([^"]*)"/);
      assert.ok(teil, `Teilaufgaben-Zeichen fuer ${status} vorhanden`);
      assert.equal(teil[1], `Tonne: ${key}`, `Teilaufgabe der Liste im Zustand ${status}`);

      const ctx = { users: [], currentUserId: 1, isAdmin: false, categories: [], container: null, onChanged: () => {} };
      const zeile = detail.subtaskListNode(aufgabe({ subtasks: [{ id: 8, title: 'Tonne', status }] }), ctx).childNodes[0];
      assert.equal(zeile.getAttribute('aria-label'), `Tonne: ${key}`, `Teilaufgabe der Leseansicht im Zustand ${status}`);
    }
  });
});

test('Aufgabenzeile mit `tasks: read`: auch die aufgeklappte Unteraufgabenliste bietet kein Anlegen an', () => {
  withAccess({ tasks: 'read' }, () => {
    const html = tasks.renderTaskCard(aufgabe({
      subtasks: [{ id: 8, title: 'Tonne', status: 'open' }],
      subtask_total: 1, subtask_done: 0,
    }));
    assert.doesNotMatch(html, /subtask-item__add/,
      'der Knopf am Fuß der Liste hing an keiner Rechteprüfung und blieb als einziger stehen');
    // Der Fortschrittsbalken ist reine Auskunft und bleibt aufklappbar.
    assert.match(html, /data-action="toggle-subtasks"/);
  });
});

test('Personenauswahl beim Abhaken verschwindet bei `tasks: read`', () => {
  const zwei = [{ id: 1, display_name: 'Ada' }, { id: 2, display_name: 'Linus' }];
  tasks.state.users = zwei;
  try {
    withAccess({ tasks: 'write' }, () => {
      assert.notEqual(tasks.renderDoerPicker(aufgabe(), false, false), '',
        'mit zwei Mitgliedern und Schreibrecht steht sie da');
    });
    withAccess({ tasks: 'read' }, () => {
      assert.equal(tasks.renderDoerPicker(aufgabe(), false, false), '',
        'sie hakt für eine benannte Person ab - reine Handlung');
    });
  } finally {
    tasks.state.users = [];
  }
});

// -------------------------------------------------------------------------
// Aufgaben: Board und Leerzustand
// -------------------------------------------------------------------------

test('Boardkarte mit `tasks: read`: kein Weiterschalt-Knopf', () => {
  withAccess({ tasks: 'write' }, () => {
    assert.match(tasks.renderKanbanCard(aufgabe()), /data-next-status=/);
  });
  withAccess({ tasks: 'read' }, () => {
    const html = tasks.renderKanbanCard(aufgabe());
    assert.doesNotMatch(html, /data-next-status=/,
      'wo die Aufgabe steht, sagt ihre Spalte - der Knopf ist reine Handlung');
    assert.match(html, /kanban-card__title/, 'der Weg in die Details bleibt');
  });
});

test('Leere Aufgabenliste mit `tasks: read`: kein Anlegen-CTA', () => {
  tasks.state.searchQuery = '';
  withAccess({ tasks: 'write' }, () => {
    assert.match(tasks.renderTaskGroups([], 'category'), /empty-cta-tasks/);
  });
  withAccess({ tasks: 'read' }, () => {
    const html = tasks.renderTaskGroups([], 'category');
    assert.doesNotMatch(html, /empty-cta-tasks/,
      'der CTA klickt den FAB, und den gibt es hier nicht mehr');
    assert.match(html, /tasks\.emptyTitle/, 'der erklärende Leerzustand bleibt');
  });
});

// -------------------------------------------------------------------------
// Aufgaben: der Wachposten im delegierten Handler
// -------------------------------------------------------------------------

test('READ_SAFE_ACTIONS der Aufgabenliste enthält nur lesende Aktionen', () => {
  const src = readFileSync(new URL('../public/pages/tasks.js', import.meta.url), 'utf8');
  const start = src.indexOf("const READ_SAFE_ACTIONS = new Set([");
  assert.ok(start > -1, 'die Positivliste muss es geben - eine Denylist sagt zu unbekannten Aktionen ja');
  const body = src.slice(start, src.indexOf(']);', start));
  // Die zwei Zustandsknöpfe stehen bewusst NICHT darin: sie bleiben sichtbar,
  // sind aber `disabled` - und ein per Devtools wiederbelebter Knopf findet
  // dort denselben Riegel.
  for (const schreibend of ['toggle-status', 'toggle-subtask', 'edit-task', 'archive-task', 'add-subtask', 'pick-doer']) {
    assert.ok(!body.includes(`'${schreibend}'`), `${schreibend} schreibt und darf nicht freigestellt sein`);
  }
  assert.match(body, /'open-task'/);
  assert.match(body, /'toggle-subtasks'/);
});

test('der Riegel in wireTaskList() steht VOR der ersten Aktion', () => {
  const src = readFileSync(new URL('../public/pages/tasks.js', import.meta.url), 'utf8');
  const fn = src.slice(src.indexOf('function wireTaskList(container) {'));
  const riegel = fn.indexOf('if (readOnly() && !erlaubt) return;');
  const ersteAktion = fn.indexOf("if (action === 'toggle-status')");
  assert.ok(riegel > -1, 'ohne Riegel ist die Markup-Unterdrückung die einzige Verteidigungslinie');
  assert.ok(riegel < ersteAktion, 'ein Riegel hinter der ersten Aktion ist keiner');
  // Die Display-Ausnahme hängt am Riegel, nicht an READ_SAFE_ACTIONS: dort
  // stünde sie auch für einen Menschen mit `tasks: read` offen.
  assert.match(fn.slice(0, riegel), /actingAsDisplay\(\) && DISPLAY_WRITE_ACTIONS\.has\(action\)/);
});

// -------------------------------------------------------------------------
// Das Zustandszeichen darf nicht animieren
//
// `check-pop` quittiert eine BERUEHRUNG. An einem `span`, den niemand antippen
// kann, liefe sie bei jedem Neuzeichnen der Liste los und behauptete ein
// Abhaken, das gerade nicht stattfand.
//
// GEPRUEFT WIRD DIE KASKADE, NICHT DER TEXT. Der erste Anlauf schrieb
// `animation: none` in `.task-status-btn--static` und war wirkungslos:
// `.task-status-btn--done` traegt dieselbe Spezifitaet (0,1,0) und steht
// WEITER UNTEN, gewinnt also nach Quellreihenfolge (Review zu PR #1252). Ein
// Textguard haette die Zeile gefunden und gruen gemeldet. Der kleine
// Kaskadenloeser unten fragt stattdessen, was am Ende wirklich gilt - und
// faellt damit auch, wenn jemand den Fehler auf einem anderen Weg wieder
// einbaut.
// -------------------------------------------------------------------------

/** Spezifitaet eines einfachen Selektors als vergleichbare Zahl. */
function spezifitaet(selektor) {
  const ids = (selektor.match(/#[\w-]+/g) ?? []).length;
  const klassen = (selektor.match(/[.:[][\w-]+/g) ?? []).length;
  const elemente = (selektor.match(/(?:^|[\s>+~])[a-z][\w-]*/gi) ?? []).length;
  return ids * 10000 + klassen * 100 + elemente;
}

/**
 * Welchen Wert traegt `eigenschaft` am Ende, wenn ein Element GENAU diese
 * Klassen hat?
 *
 * Beruecksichtigt werden Regeln auf der Basisebene, deren Selektor aus Klassen
 * dieser Menge besteht, optional mit `:not(.fremd)` und optional mit einem
 * Zustands-Suffix (`:hover`, `::after`, `:hover::after`). Das Suffix muss dem
 * gefragten GENAU entsprechen: eine `:hover`-Regel sagt nichts ueber den
 * ruhenden Zustand, und eine `::after`-Regel nichts ueber das Element selbst.
 * Alles andere - Kombinatoren, fremde Klassen, At-Bloecke - traegt zu diesem
 * Element nichts bei und wird uebersprungen.
 *
 * DAS SUFFIX KAM DAZU, WEIL DIE ERSTE FASSUNG GENAU DARAN VORBEIMASS: sie
 * verwarf jeden Selektor mit Pseudo und sah damit die Hover-Regeln gar nicht -
 * also die Stelle, an der dieselbe Kaskadenfalle ein zweites Mal zuschlug
 * (Review zu PR #1252). Ein Loeser, der die Haelfte der Regeln ueberspringt,
 * ist ein gruener Test, der nichts misst.
 *
 * Bei Gleichstand gewinnt die spaetere Regel, wie im Browser.
 */
function effektiverWert(css, klassen, eigenschaft, zustand = '') {
  const menge = new Set(klassen);
  let treffer = null;
  let bestes = -1;
  let laufnummer = 0;
  for (const { selector, body, at } of eachRule(css)) {
    laufnummer += 1;
    if (at.length) continue;
    for (const teil of selector.split(',')) {
      const sel = teil.trim();
      // Selektor zerlegen: Klassenkette (mit `:not(.x)`) + Zustands-Suffix.
      const m = /^((?:\.[\w-]+|:not\(\.[\w-]+\))+)((?:::?[\w-]+)*)$/.exec(sel);
      if (!m) continue;
      const [, kette, suffix] = m;
      if (suffix !== zustand) continue;
      const verboten = [...kette.matchAll(/:not\(\.([\w-]+)\)/g)].map((x) => x[1]);
      if (verboten.some((k) => menge.has(k))) continue;
      const gefordert = kette.replace(/:not\(\.[\w-]+\)/g, '').split('.').filter(Boolean);
      if (!gefordert.every((k) => menge.has(k))) continue;
      const wert = new RegExp(`(?:^|;)\\s*${eigenschaft}\\s*:([^;]*)`).exec(body);
      if (!wert) continue;
      const rang = spezifitaet(sel) * 100000 + laufnummer;
      if (rang >= bestes) { bestes = rang; treffer = wert[1].trim(); }
    }
  }
  return treffer;
}

const TASKS_CSS = readFileSync(new URL('../public/styles/tasks.css', import.meta.url), 'utf8');

test('der Kaskadenloeser selbst: spaetere Regel gewinnt bei gleicher Spezifitaet', () => {
  // Ohne diese Probe misst der Test unten vielleicht gar nichts. Genau dieser
  // Fall ist der Fehler, den er fangen soll.
  const probe = '.a--static { animation: none; } .a--done { animation: pop 1s; }';
  assert.equal(effektiverWert(probe, ['a--done', 'a--static'], 'animation'), 'pop 1s');
  const geheilt = probe + ' .a--done.a--static { animation: none; }';
  assert.equal(effektiverWert(geheilt, ['a--done', 'a--static'], 'animation'), 'none');
  // Eine Regel, die eine Klasse fordert, die das Element nicht hat, zaehlt nicht.
  assert.equal(effektiverWert('.b { animation: pop 1s; }', ['a--done'], 'animation'), null);
});

test('der Kaskadenloeser selbst: Zustands-Suffix und :not() zaehlen mit', () => {
  const css = '.a:hover::after { border-color: blau; } .a--done::after { border-color: gruen; }';
  // Eine :hover-Regel sagt nichts ueber den ruhenden Zustand - und umgekehrt.
  assert.equal(effektiverWert(css, ['a', 'a--done'], 'border-color', '::after'), 'gruen');
  assert.equal(effektiverWert(css, ['a', 'a--done'], 'border-color', ':hover::after'), 'blau');
  // Die Falle: eine Gegenregel mit Pseudo schlaegt den Zustand ueber Spezifitaet.
  const gegenregel = css + ' .a--static:hover::after { border-color: grau; }';
  assert.equal(effektiverWert(gegenregel, ['a', 'a--done', 'a--static'], 'border-color', ':hover::after'), 'grau');
  // `:not()` nimmt das Element aus, statt eine zweite Farbe zu behaupten.
  const ausgenommen = '.a:not(.a--static):hover::after { border-color: blau; } .a--done::after { border-color: gruen; }';
  assert.equal(effektiverWert(ausgenommen, ['a', 'a--done', 'a--static'], 'border-color', ':hover::after'), null,
    'keine Hover-Regel trifft das Zeichen - der ruhende Zustand bleibt stehen');
  assert.equal(effektiverWert(ausgenommen, ['a', 'a--done'], 'border-color', ':hover::after'), 'blau',
    'der bedienbare Knopf reagiert weiter');
});

test('eine erledigte Aufgabe im Zustandszeichen animiert nicht', () => {
  assert.equal(
    effektiverWert(TASKS_CSS, ['task-status-btn', 'task-status-btn--done', 'task-status-btn--static'], 'animation'),
    'none',
    'check-pop quittiert eine Beruehrung - hier hat niemand etwas beruehrt',
  );
  // Der bedienbare Knopf behaelt sie: die Quittung gehoert zum gedrueckten Haken.
  assert.match(
    effektiverWert(TASKS_CSS, ['task-status-btn', 'task-status-btn--done'], 'animation') ?? '',
    /check-pop/,
  );
});

test('dieselbe Zusicherung fuer die Teilaufgabe (#1209 und #467 teilen sich das Zeichen)', () => {
  assert.equal(
    effektiverWert(TASKS_CSS, ['subtask-item__checkbox', 'subtask-item__checkbox--done', 'subtask-item__checkbox--static'], 'animation'),
    'none',
  );
  assert.match(
    effektiverWert(TASKS_CSS, ['subtask-item__checkbox', 'subtask-item__checkbox--done'], 'animation') ?? '',
    /check-pop/,
  );
});

// -------------------------------------------------------------------------
// Und das Zeichen reagiert auf Ueberfahren gar nicht
//
// Die erste Fassung schrieb dem Zeichen eine eigene Hover-FARBE zu. Mit
// (0,2,1) schlug die den Zustandsring (`--done::after`, (0,1,1)): beim
// Ueberfahren wurde der gruene Ring einer erledigten Aufgabe grau. Das ist
// dieselbe Falle wie bei `check-pop`, nur in die andere Richtung - zu viel
// Spezifitaet statt zu wenig. Jetzt nimmt die Hover-Regel das Zeichen aus,
// statt gegen es anzuschreiben (Review zu PR #1252).
// -------------------------------------------------------------------------

test('das Zustandszeichen reagiert nicht auf Ueberfahren, und der Ring behaelt seine Farbe', () => {
  // Der Ring samt Einladung steht seit R16 geteilt in list-row.css
  // (`.check-ring`), der Zustand weiter in tasks.css - gemessen wird die
  // Kaskade in Ladereihenfolge (index.html: list-row.css vor dem Seiten-CSS).
  const KASKADE = `${readFileSync(new URL('../public/styles/list-row.css', import.meta.url), 'utf8')}\n${TASKS_CSS}`;
  for (const [name, klassen, ruhend] of [
    ['erledigt', ['task-status-btn', 'task-status-btn--done', 'task-status-btn--static', 'check-ring', 'check-ring--static'], 'var(--color-success)'],
    ['in Arbeit', ['task-status-btn', 'task-status-btn--in_progress', 'task-status-btn--static', 'check-ring', 'check-ring--static'], 'var(--color-warning)'],
  ]) {
    assert.equal(effektiverWert(KASKADE, klassen, 'border-color', ':hover::after'), null,
      `${name}: keine Hover-Regel darf das Zeichen treffen`);
    assert.equal(effektiverWert(KASKADE, klassen, 'border-color', '::after'), ruhend,
      `${name}: der Ring behaelt die Farbe, die den Zustand traegt`);
  }
  // Der bedienbare Knopf behaelt seine Hover-Reaktion.
  assert.match(
    effektiverWert(KASKADE, ['task-status-btn', 'task-status-btn--done', 'check-ring'], 'border-color', ':hover::after') ?? '',
    /module-accent/,
  );
});

test('und an der Zeile der Leseansicht - dort war es nur noch nicht schaedlich', () => {
  // DIE DRITTE STELLE MIT DEMSELBEN ZEICHEN. Ihre Gegenregel
  // (`--static:hover { background: none }`) richtete keinen Schaden an, weil
  // `.detail-subtask--done` zufaellig keinen Hintergrund setzt - sie trug aber
  // dieselbe (0,2,0) und haette jede Zustandsfarbe geschlagen, die dort morgen
  // dazukommt. Eine Bauart, die nur an einer Stelle haelt, ist eine zu viel.
  const css = readFileSync(new URL('../public/styles/detail-view.css', import.meta.url), 'utf8');
  const zeichen = ['detail-subtask', 'detail-subtask--done', 'detail-subtask--static'];
  assert.equal(effektiverWert(css, zeichen, 'background', ':hover'), null);
  assert.match(
    effektiverWert(css, ['detail-subtask', 'detail-subtask--done'], 'background', ':hover') ?? '',
    /surface-2/,
    'die bedienbare Zeile reagiert weiter',
  );
});

test('dasselbe an der Teilaufgabe - dort seit #1209', () => {
  const zeichen = ['subtask-item__checkbox', 'subtask-item__checkbox--done', 'subtask-item__checkbox--static'];
  assert.equal(effektiverWert(TASKS_CSS, zeichen, 'border-color', ':hover'), null);
  assert.equal(effektiverWert(TASKS_CSS, zeichen, 'border-color'), 'var(--color-success)');
  assert.match(
    effektiverWert(TASKS_CSS, ['subtask-item__checkbox', 'subtask-item__checkbox--done'], 'border-color', ':hover') ?? '',
    /module-accent/,
  );
});

// -------------------------------------------------------------------------
// Die Leseansicht - der zweite Einstieg in dieselbe Aufgabe
// -------------------------------------------------------------------------

test('Markdown-Renderer: drei Formen des Kaestchens, und sie schliessen sich aus', () => {
  const text = '- [x] Muell\n- [ ] Spuelen';
  const live = renderMarkdownLight(text, { checklist: { interactive: true, toggleLabel: 'um' } });
  assert.match(live, /<button[^>]*role="checkbox"[^>]*aria-checked="true"/, 'Bedienelement');

  // Dekoration: sichtbar, aber fuer Hilfstechnik gar nicht da.
  const deko = renderMarkdownLight(text, {});
  assert.match(deko, /<span class="note-md-box" aria-hidden="true">/);

  // Zeichen: kein Bedienelement, aber der Zustand steht drin.
  const zeichen = renderMarkdownLight(text, {
    checklist: { stateLabels: { checked: 'erledigt', unchecked: 'offen' } },
  });
  assert.doesNotMatch(zeichen, /<button/, 'nichts, was zum Tippen einlaedt');
  assert.doesNotMatch(zeichen, /aria-hidden/, 'und nichts, was die Auskunft verschweigt');
  assert.match(zeichen, /role="img" aria-label="Muell: erledigt"/);
  assert.match(zeichen, /role="img" aria-label="Spuelen: offen"/);

  // `interactive` schlaegt `stateLabels` - ein Kaestchen ist entweder das eine
  // oder das andere, nie beides.
  const beides = renderMarkdownLight(text, {
    checklist: { interactive: true, toggleLabel: 'um', stateLabels: { checked: 'erledigt', unchecked: 'offen' } },
  });
  assert.match(beides, /<button[^>]*role="checkbox"/);
  assert.doesNotMatch(beides, /role="img"/);
});

test('Beschreibungs-Checkliste: bedienbar mit Schreibrecht, Zeichen ohne', () => {
  // GEMESSEN WIRD, WAS DER AUFRUFER DEM RENDERER UEBERGIBT, nicht dessen
  // Ausgabe: der Test-Loader stubbt `/utils/html.js`, und ein Test gegen die
  // Ausgabe des Stubs pruefte den Stub. Welches Markup aus welcher Option
  // entsteht, steht im Test darueber - dort gegen die ECHTE Funktion.
  const task = aufgabe({ description: '- [x] Muell rausbringen\n- [ ] Spuelmaschine' });
  const gesehen = [];
  globalThis.__renderMarkdownLight = (text, optionen) => { gesehen.push(optionen); return String(text); };
  try {
    withAccess({ tasks: 'write' }, () => {
      detail.descriptionNode(task);
      assert.equal(gesehen.at(-1).checklist.interactive, true,
        'mit Schreibrecht haengt der Haken am selben Weg wie bisher');
      assert.equal(gesehen.at(-1).checklist.stateLabels, undefined);
    });

    withAccess({ tasks: 'read' }, () => {
      const knoten = detail.descriptionNode(task);
      const optionen = gesehen.at(-1).checklist;
      // PATCH /tasks/:id/check verlangt Schreibrecht, und der Server kennt
      // dafuer keine Ausnahme - auch keine fuer ein Wandtablett.
      assert.notEqual(optionen.interactive, true, 'kein Bedienelement, das im 403 endet');
      // Und nicht die Dekorationsform: die ist aria-hidden, dann verloere ein
      // Nur-lesen-Nutzer die Auskunft selbst.
      assert.deepEqual(optionen.stateLabels, { checked: 'tasks.statusDone', unchecked: 'tasks.statusOpen' });
      // Der Klick-Weg wird gar nicht erst verdrahtet.
      assert.equal(knoten.listener, undefined);
    });
  } finally {
    delete globalThis.__renderMarkdownLight;
  }
});

test('Teilaufgabe der Leseansicht: Knopf mit Schreibrecht, Zustandszeichen ohne', () => {
  const task = aufgabe({ subtasks: [{ id: 8, title: 'Tonne', status: 'done' }] });
  const ctx = { users: [], currentUserId: 1, isAdmin: false, categories: [], container: null, onChanged: () => {} };

  withAccess({ tasks: 'write' }, () => {
    const zeile = detail.subtaskListNode(task, ctx).childNodes[0];
    assert.equal(zeile.tagName, 'button');
    assert.equal(zeile.getAttribute('aria-pressed'), 'true', 'ein Knopf, der einen Zustand umschaltet');
    assert.match(zeile.getAttribute('aria-label'), /tasks\.subtaskMarkDone/);
  });

  withAccess({ tasks: 'read' }, () => {
    const zeile = detail.subtaskListNode(task, ctx).childNodes[0];
    assert.equal(zeile.tagName, 'span',
      'kein disabled-Knopf: .detail-subtask:disabled heisst in diesem Stylesheet "gerade unterwegs" (cursor: progress)');
    assert.equal(zeile.getAttribute('role'), 'img');
    assert.equal(zeile.getAttribute('aria-pressed'), null, 'nichts wird hier gedrueckt');
    assert.match(zeile.getAttribute('aria-label'), /^Tonne: tasks\.statusDone$/,
      'die Beschriftung nennt den ZUSTAND, nicht eine Handlung');
    assert.match(zeile.className, /detail-subtask--static/);
    // Und der Anlegen-Knopf darunter faellt ganz weg - er sagt nichts.
    assert.equal(detail.subtaskListNode(task, ctx).childNodes.length, 1);
  });
});

// -------------------------------------------------------------------------
// Das Wandtablett: derselbe `tasks: read`, zwei benannte Ausnahmen (#1209)
//
// Ein Display bekommt seine Rechte aus DISPLAY_SCOPES und faellt damit unter
// genau dieselbe Modulregel wie ein Mensch mit Leserecht. Was es trotzdem darf,
// fuehrt der Server als benannte Routen. Ohne diese Tests waere die Regel oben
// still ueber das Tablett hinweggegangen - sie war vor dem Rebase auf #1245
// gruen und haette dem Geraet den Picker genommen.
// -------------------------------------------------------------------------

/** `tasks: read` UND ein Display-Konto - so sieht ein Wandtablett sich selbst. */
function amTablett(fn, { people = [{ id: 5, display_name: 'Lea', can_redeem: 1 }] } = {}) {
  const vorher = { user: tasks.state.user, displayPeople: tasks.state.displayPeople };
  tasks.state.user = { access_scope: 'display' };
  tasks.state.displayPeople = people;
  try {
    return withAccess({ tasks: 'read', rewards: 'read' }, fn);
  } finally {
    Object.assign(tasks.state, vorher);
  }
}

test('am Tablett bleibt die Personenauswahl - die Modulregel darf sie nicht mitreissen', () => {
  amTablett(() => {
    assert.notEqual(tasks.renderDoerPicker(aufgabe(), false, false), '',
      'sie ist der EINE erlaubte Schreibweg des Geraets; ohne sie haette das Tablett keinen Zweck');
  });
  // Und derselbe Leserecht-Stand ohne Display-Konto nimmt sie sehr wohl weg.
  tasks.state.users = [{ id: 1, display_name: 'Ada' }, { id: 2, display_name: 'Linus' }];
  try {
    withAccess({ tasks: 'read' }, () => {
      assert.equal(tasks.renderDoerPicker(aufgabe(), false, false), '');
    });
  } finally {
    tasks.state.users = [];
  }
});

test('am Tablett steht KEIN Statuszeichen neben dem Picker', () => {
  amTablett(() => {
    const html = tasks.renderTaskCard(aufgabe());
    assert.doesNotMatch(html, /task-status-btn--static/,
      'die Personenauswahl tritt dort an diese Stelle und traegt denselben Ring - ein Zeichen davor waere ein zweiter Kreis in derselben Zeile');
    assert.doesNotMatch(html, /data-action="toggle-status"/);
    assert.match(html, /data-action="pick-doer"/, 'der Weg zum Abhaken bleibt');
  });
  // Ohne Display-Konto ist genau dieses Zeichen die Auskunft, die bleiben muss.
  withAccess({ tasks: 'read' }, () => {
    assert.match(tasks.renderTaskCard(aufgabe()), /task-status-btn--static/);
  });
});

test('am Tablett bleibt der Einloese-Knopf, wo der Server ihn erlaubt', () => {
  const vorher = { user: rewards.state.user, overview: rewards.state.overview, catalog: rewards.state.catalog, displayPeople: rewards.state.displayPeople };
  rewards.state.user = { access_scope: 'display' };
  rewards.state.overview = { me: null, balances: [mitglied()] };
  rewards.state.catalog = [{ id: 11, name: 'Kinoabend', cost: 100, is_active: 1 }];
  try {
    withAccess({ rewards: 'read' }, () => {
      rewards.state.displayPeople = [{ id: 3, can_redeem: 1 }];
      assert.match(rewards.renderStandingRow(mitglied()), /rw-redeem-open/,
        'die Antwort kommt von /displays/people (can_redeem), nicht aus einer zweiten Regel hier');

      // Und sie folgt dem Server auch in die andere Richtung.
      rewards.state.displayPeople = [{ id: 3, can_redeem: 0 }];
      assert.doesNotMatch(rewards.renderStandingRow(mitglied()), /rw-redeem-open/,
        'wem der Server das Einloesen verwehrt, dem bietet das Tablett es nicht an');
    });
  } finally {
    Object.assign(rewards.state, vorher);
  }
});

// -------------------------------------------------------------------------
// Belohnungen
// -------------------------------------------------------------------------

function mitBelohnungsstand(fn) {
  const vorher = { overview: rewards.state.overview, catalog: rewards.state.catalog, redemptions: rewards.state.redemptions, user: rewards.state.user };
  rewards.state.user = { role: 'admin' };
  rewards.state.overview = { me: 3, balances: [mitglied()], setup: { participantCount: 0, pointedTaskCount: 0, catalogCount: 0 } };
  rewards.state.catalog = [{ id: 11, name: 'Kinoabend', cost: 100, is_active: 1 }];
  rewards.state.redemptions = [{ id: 21, user_id: 3, user_name: 'Emma', reward_name: 'Kinoabend', cost: 100, status: 'pending' }];
  try {
    return fn();
  } finally {
    Object.assign(rewards.state, vorher);
  }
}

test('Punktestandzeile mit `rewards: read`: Saldo bleibt, Einlösen verschwindet', () => {
  mitBelohnungsstand(() => {
    withAccess({ rewards: 'write' }, () => {
      assert.match(rewards.renderStandingRow(mitglied()), /rw-redeem-open/);
    });
    withAccess({ rewards: 'read' }, () => {
      const html = rewards.renderStandingRow(mitglied());
      assert.doesNotMatch(html, /rw-redeem-open/,
        'der Server hat für /rewards/redemptions keine Ausnahme wie /schedule/preferences - der POST endet im 403');
      // Die Auskunft selbst bleibt vollständig.
      assert.match(html, /Emma/);
      assert.match(html, /data-countup="120"/);
      assert.match(html, /role="progressbar"/);
      assert.match(html, /rw-standing__id/, 'der Weg in die Mitgliedsansicht bleibt');
    });
  });
});

test('Prämienkarte mit `rewards: read`: weder bearbeiten noch einlösen', () => {
  mitBelohnungsstand(() => {
    const praemie = { id: 11, name: 'Kinoabend', cost: 100, is_active: 1 };
    withAccess({ rewards: 'write' }, () => {
      const html = rewards.renderRewardCard(praemie);
      assert.match(html, /data-edit="11"/);
      assert.match(html, /data-redeem-item="11"/);
    });
    withAccess({ rewards: 'read' }, () => {
      const html = rewards.renderRewardCard(praemie);
      assert.doesNotMatch(html, /data-edit="11"/);
      assert.doesNotMatch(html, /data-redeem-item="11"/);
      assert.match(html, /Kinoabend/, 'was es gibt und was es kostet, bleibt lesbar');
      assert.match(html, /rewards\.pointsUnit/);
    });
  });
});

test('Offene Anfragen mit `rewards: read`: die Liste bleibt, die Entscheidung fällt weg', () => {
  mitBelohnungsstand(() => {
    withAccess({ rewards: 'write' }, () => {
      const html = rewards.renderPendingPanel();
      assert.match(html, /data-decide="fulfill"/);
      assert.match(html, /data-decide="reject"/);
    });
    withAccess({ rewards: 'read' }, () => {
      const html = rewards.renderPendingPanel();
      assert.doesNotMatch(html, /data-decide=/,
        'genehmigen, ablehnen und abbrechen sind reine Handlungen');
      assert.doesNotMatch(html, /rw-pending__actions/,
        'der Flex-Behaelter geht mit: eine leere Box mit gap waere eine Spalte fuer nichts');
      assert.match(html, /Kinoabend/, 'DASS eine Anfrage offen ist, bleibt eine Auskunft');
      assert.match(html, /rw-pending__title/);
    });
  });
});

test('Ersteinrichtung mit `rewards: read`: keine Aufforderung, die ins 403 führt', () => {
  mitBelohnungsstand(() => {
    withAccess({ rewards: 'write' }, () => {
      assert.match(rewards.renderSetupHints(), /data-setup="participants"/);
    });
    withAccess({ rewards: 'read' }, () => {
      assert.equal(rewards.renderSetupHints(), '',
        'alle drei Schritte legen etwas an');
    });
  });
});

// Taschengeld (#1734): der Geld-Saldo ist ein Zustand, Abheben/Einzahlen/
// Buchen/Plan sind Handlungen. WER ein Konto sieht, entscheidet der Server -
// hier steht nur, was die Seite aus der Antwort macht.
function mitTaschengeld(fn, { role = 'member', me = 3, former = false } = {}) {
  const vorher = { overview: rewards.state.overview, user: rewards.state.user, money: rewards.state.money, redemptions: rewards.state.redemptions };
  rewards.state.user = { role };
  rewards.state.overview = { me, balances: [] };
  // DER HAUSHALT FUEHRT INZWISCHEN YEN, das Konto wurde in EUR eroeffnet (#1734):
  // jede Zahl unten muss aus der Waehrung des KONTOS kommen. Kaeme sie aus der
  // des Haushalts, staende "7.731 JPY" da und kein "77,31".
  const EUR = { currency: 'EUR', minor_unit: 2 };
  rewards.state.money = {
    currency: 'JPY', minor_unit: 0,
    accounts: [{ id: 3, display_name: 'Emma', balance_minor: 7731, former, ...EUR, plan: { amount_minor: 500, ...EUR, frequency: 'weekly', anchor_day: 5, next_run_date: '2026-10-09', paused: false } }],
    candidates: role === 'admin' ? [{ id: 4, display_name: 'Leo' }] : [],
  };
  rewards.state.redemptions = [{ id: 31, user_id: 3, user_name: 'Emma', kind: 'withdrawal', reward_name: 'withdrawal', cost: 421, ...EUR, user_balance: 7731, status: 'pending' }];
  // Wie bei withAccess oben: ein `finally` um ein Promise feuert am ersten
  // `await`. Ein async Aufrufer bekaeme den Zustand mitten im Test weggeraeumt.
  const restore = () => Object.assign(rewards.state, vorher);
  let result;
  try {
    result = fn();
  } catch (err) {
    restore();
    throw err;
  }
  if (typeof result?.then === 'function') return result.finally(restore);
  restore();
  return result;
}

test('Taschengeld mit `rewards: read`: der Stand bleibt, Abheben und Einzahlen verschwinden', () => {
  mitTaschengeld(() => {
    withAccess({ rewards: 'write' }, () => {
      const html = rewards.renderMoneySection();
      assert.match(html, /data-money-request="withdrawal"/);
      assert.match(html, /data-money-request="deposit"/);
      assert.doesNotMatch(html, /data-money-book|data-money-plan|rw-money-setup/, 'ein Kind bucht nicht und plant nicht');
    });
    withAccess({ rewards: 'read' }, () => {
      const html = rewards.renderMoneySection();
      assert.doesNotMatch(html, /data-money-request=/, 'der POST endete im 403 - wie beim Einloesen');
      assert.doesNotMatch(html, /rw-standing__actions/, 'der leere Behaelter geht mit');
      assert.match(html, /Emma/);
      assert.match(html, /77[.,]31/, 'der Saldo bleibt lesbar');
      assert.match(html, /rewards\.money\.planWeekly/, 'und der Plan auch');
      assert.match(html, /data-money-member="3"/, 'der Weg in den Verlauf bleibt');
    });
  });
});

test('Taschengeld: das eigene Konto traegt die Anfrage-Knoepfe, ein fremdes nie', () => {
  // Der Server schickt einem Kind kein fremdes Konto. Kaeme doch eines an,
  // haengt an ihm trotzdem kein Knopf: die Anfrage gilt immer der eigenen Person.
  mitTaschengeld(() => {
    withAccess({ rewards: 'write' }, () => {
      assert.doesNotMatch(rewards.renderMoneySection(), /data-money-request=|data-money-book=/);
    });
  }, { me: 9 });
});

test('Taschengeld fuer Eltern: buchen, planen, einrichten - und mit `rewards: read` nichts davon', () => {
  mitTaschengeld(() => {
    withAccess({ rewards: 'write' }, () => {
      const html = rewards.renderMoneySection();
      assert.match(html, /data-money-book="3"/);
      assert.match(html, /data-money-plan="3"/);
      assert.match(html, /rw-money-setup/, 'Leo hat noch kein Konto');
      assert.doesNotMatch(html, /data-money-request=/, 'Eltern buchen direkt, sie stellen keine Anfrage');
    });
    withAccess({ rewards: 'read' }, () => {
      const html = rewards.renderMoneySection();
      assert.doesNotMatch(html, /data-money-book|data-money-plan|rw-money-setup/);
      assert.match(html, /77[.,]31/);
    });
  }, { role: 'admin', me: 1 });
});

test('Taschengeld: ein ehemaliges Konto traegt das Zeichen und genau eine Handlung - auszahlen', () => {
  const vorher = globalThis.__openModal;
  const dialoge = [];
  globalThis.__openModal = (options) => { dialoge.push(options); };
  try {
    mitTaschengeld(() => {
      withAccess({ rewards: 'write' }, () => {
        const html = rewards.renderMoneySection();
        assert.match(html, /settings\.memberFormerBadge/, 'als ehemalig gekennzeichnet');
        assert.match(html, /data-money-book="3"/, 'abbuchen geht');
        assert.match(html, /rewards\.money\.debit/);
        assert.doesNotMatch(html, /rewards\.money\.book[^a-zA-Z]/, 'nicht "Buchen": gutschreiben gibt es nicht mehr');
        assert.doesNotMatch(html, /data-money-plan|data-money-request/, 'kein Plan, keine Anfrage');
        assert.match(html, /77[.,]31/, 'das Restguthaben steht da');

        rewards.openMoneyPlanModal(3);
        assert.equal(dialoge.length, 0, 'der Plan-Dialog oeffnet fuer ein ehemaliges Konto nicht');
        rewards.openMoneyBookModal(3);
        assert.equal(dialoge.length, 1);
        assert.match(dialoge[0].content, /type="hidden" id="rw-money-direction" value="debit"/, 'der Dialog bucht nur ab');
        assert.doesNotMatch(dialoge[0].content, /value="credit"/);
      });
      withAccess({ rewards: 'read' }, () => {
        const html = rewards.renderMoneySection();
        assert.doesNotMatch(html, /data-money-book/, 'nur-lesen: auch das Auszahlen ist eine Handlung');
        assert.match(html, /settings\.memberFormerBadge/);
      });
    }, { role: 'admin', me: 1, former: true });
    // Ein aktives Konto bietet weiter beides.
    mitTaschengeld(() => withAccess({ rewards: 'write' }, () => {
      dialoge.length = 0;
      rewards.openMoneyBookModal(3);
      assert.match(dialoge[0].content, /value="credit"/);
      assert.doesNotMatch(rewards.renderMoneySection(), /settings\.memberFormerBadge/);
    }), { role: 'admin', me: 1 });
  } finally {
    globalThis.__openModal = vorher;
  }
});

test('Taschengeld: Konto eroeffnen ist ein eigener Dialog, und schliessen laesst sich nur, was der Server leer nennt', async () => {
  const vorher = globalThis.__openModal;
  const dialoge = [];
  globalThis.__openModal = (options) => { dialoge.push(options); };
  try {
    await mitTaschengeld(async () => {
      withAccess({ rewards: 'write' }, () => {
        // Eroeffnen: die Mitglieder ohne Konto, kein Betrag, kein Plan.
        rewards.openMoneyAccountModal();
        assert.equal(dialoge.length, 1);
        assert.match(dialoge[0].content, /id="rw-account-member"/);
        assert.match(dialoge[0].content, /<option value="4">Leo<\/option>/);
        assert.match(dialoge[0].content, /rewards\.money\.openAccount/);
        assert.doesNotMatch(dialoge[0].content, /rw-money-amount|rw-plan-frequency/, 'ein Konto braucht weder Betrag noch Plan');

        // Schliessen: nur am leeren Konto.
        assert.doesNotMatch(rewards.renderMoneySection(), /data-money-close/, 'mit Guthaben und Plan: kein Schliessen');
        rewards.state.money.accounts[0] = { ...rewards.state.money.accounts[0], balance_minor: 0, plan: null, closable: true };
        assert.match(rewards.renderMoneySection(), /data-money-close="3"/);
      });
      withAccess({ rewards: 'read' }, () => {
        assert.doesNotMatch(rewards.renderMoneySection(), /data-money-close|rw-money-setup/, 'nur-lesen: weder eroeffnen noch schliessen');
        dialoge.length = 0;
        rewards.openMoneyAccountModal();
        assert.equal(dialoge.length, 0);
      });

      // Zwischen Anzeige und Klick ging eine Anfrage ein: der Server weist ab,
      // die Seite sagt es in ihrer Sprache und laedt neu.
      await withAccess({ rewards: 'write' }, () => mitSeitenSonde(async (sonde) => {
        globalThis.__apiStub = { delete: async () => { throw Object.assign(new Error('Only an empty account can be closed'), { data: { reason: 'money_account_not_empty' } }); } };
        await assert.doesNotReject(rewards.closeMoneyAccount(rewards.state.money.accounts[0]));
        assert.equal(sonde.gefragt.length, 2, 'die Rueckfrage und die Absage');
        assert.match(sonde.gefragt[0], /rewards\.money\.confirmCloseAccount/);
        assert.match(sonde.gefragt[1], /rewards\.money\.accountNotEmpty/);
        assert.equal(sonde.reloads, 1);
        const calls = [];
        globalThis.__apiStub = { delete: async (path) => { calls.push(path); return { ok: true }; } };
        await rewards.closeMoneyAccount(rewards.state.money.accounts[0]);
        assert.deepEqual(calls, ['/rewards/money/accounts/3']);
      }));
    }, { role: 'admin', me: 1 });
    // Das Kind selbst schliesst nichts und eroeffnet nichts.
    mitTaschengeld(() => withAccess({ rewards: 'write' }, () => {
      rewards.state.money.accounts[0] = { ...rewards.state.money.accounts[0], balance_minor: 0, plan: null, closable: true };
      assert.doesNotMatch(rewards.renderMoneySection(), /data-money-close|rw-money-setup/);
      dialoge.length = 0;
      rewards.openMoneyAccountModal();
      assert.equal(dialoge.length, 0);
    }));
  } finally {
    globalThis.__openModal = vorher;
  }
});

test('Taschengeld: ohne Antwort oder ohne Konto steht kein leerer Abschnitt da', () => {
  mitTaschengeld(() => {
    withAccess({ rewards: 'write' }, () => {
      rewards.state.money = null;
      assert.equal(rewards.renderMoneySection(), '', 'ohne Antwort: kein Abschnitt (auch am Wandtablett)');
      rewards.state.money = { currency: 'EUR', minor_unit: 2, accounts: [], candidates: [] };
      assert.equal(rewards.renderMoneySection(), '', 'ein Kind ohne Konto sieht keine Ueberschrift ueber nichts');
    });
  });
});

test('eine Geld-Anfrage in der Liste: Betrag in Geld, nicht in Punkten - und nur-lesen ohne Entscheidung', () => {
  mitTaschengeld(() => {
    withAccess({ rewards: 'write' }, () => {
      const html = rewards.renderPendingPanel();
      assert.match(html, /rewards\.money\.ledgerWithdrawal/, 'der Titel ist die Art der Anfrage, nicht der Marker aus der Datenbank');
      assert.match(html, /4[.,]21/);
      assert.doesNotMatch(html, /rewards\.pointsUnit/, '421 Cent sind keine 421 Punkte');
      assert.match(html, /77[.,]31/, 'wer entscheidet, liest das Guthaben daneben');
      assert.match(html, /data-decide="fulfill"/);
    });
    withAccess({ rewards: 'read' }, () => {
      assert.doesNotMatch(rewards.renderPendingPanel(), /data-decide=/);
    });
  }, { role: 'admin', me: 1 });
});

// DIE NACHKOMMASTELLEN KOMMEN VOM SERVER (Review zu #1745). Der Plan-Dialog
// belegte sein Betragsfeld ueber `Intl` vor: fuer COP, HUF, IDR, IRR und PYG
// (CLDR 0 Stellen, ISO 4217 zwei) stand der Betrag hundertfach im Feld, und
// jedes Speichern verhundertfachte das Taschengeld. Gemessen wird der ganze
// Rundlauf - Server-Betrag -> Feld -> Pruefung -> Text an den Server ->
// Server-Betrag - mit dem ECHTEN Parser des Servers und fuer JEDE waehlbare
// Waehrung, nicht fuer drei Beispiele.
test('Taschengeld: ein Betrag ueberlebt den Rundlauf durch das Feld, in jeder waehlbaren Waehrung', async () => {
  const { CURRENCY_CODES } = await import('../public/utils/currency-codes.js');
  const { minorUnit, parseMoneyToMinor } = await import('../server/services/split-expenses.js');
  const { toDecimalString, currencyFractionDigits } = await import('../public/utils/money.js');
  assert.ok(CURRENCY_CODES.length >= 20, 'die Liste der Waehrungen ist da');
  const vorher = rewards.state.money;
  const abweichend = [];
  try {
    for (const currency of CURRENCY_CODES) {
      const digits = minorUnit(currency);
      if (digits !== currencyFractionDigits(currency)) abweichend.push(currency);
      // Das KONTO rechnet in `currency`; der Haushalt fuehrt inzwischen eine
      // andere Waehrung mit anderen Stellen (#1734). Jede Rechnung muss dem
      // Konto folgen.
      const household = digits === 0 ? { currency: 'KWD', minor_unit: 3 } : { currency: 'JPY', minor_unit: 0 };
      rewards.state.money = { ...household, accounts: [], candidates: [] };
      const account = { currency, minor_unit: digits };
      // Glatt, mit Nachkommastellen (wo die Waehrung welche hat), klein, gross.
      for (const minor of [5000 * 10 ** digits, 123456, 1, 10 ** 12]) {
        const field = rewards.minorToAmountInput(minor, account);
        assert.equal(rewards.moneyAmountProblem(field, account), null, `${currency} ${minor}: "${field}" ist speicherbar`);
        assert.equal(parseMoneyToMinor(toDecimalString(field), currency), minor,
          `${currency}: ${minor} steht als "${field}" im Feld und kommt als derselbe Betrag zurueck`);
        assert.equal(rewards.decimalToMinor(toDecimalString(field), account), minor, `${currency}: der Vergleich mit dem Guthaben rechnet gleich`);
      }
      // Eine Stelle mehr, als der Server annimmt, ist ein Grund am Feld.
      assert.equal(rewards.moneyAmountProblem(`1,${'1'.repeat(digits + 1)}`, account), 'precision', `${currency}: zu viele Stellen`);
      // Ohne Konto (ein neues wird eroeffnet) gilt die Waehrung des Haushalts.
      assert.equal(rewards.minorToAmountInput(1, undefined), rewards.minorToAmountInput(1, household));
    }
  } finally {
    rewards.state.money = vorher;
  }
  // Ohne diese Waehrungen maesse der Rundlauf den Fehler gar nicht.
  assert.ok(abweichend.includes('HUF') && abweichend.includes('IDR'),
    `die Probe braucht Waehrungen, bei denen Intl und ISO 4217 auseinandergehen (gefunden: ${abweichend.join(', ')})`);
});

test('Taschengeld: der Plan-Dialog eines Forint-Haushalts zeigt 5000, nicht 500000', () => {
  const vorher = rewards.state.money;
  try {
    rewards.state.money = { currency: 'HUF', minor_unit: 2, accounts: [], candidates: [] };
    assert.equal(rewards.minorToAmountInput(500000), '5000');
    assert.equal(rewards.minorToAmountInput(500050), '5000,50', 'ein Betrag mit Filler bleibt, wie er gespeichert ist');
    rewards.state.money = { currency: 'EUR', minor_unit: 2, accounts: [], candidates: [] };
    assert.equal(rewards.minorToAmountInput(500), '5,00');
    rewards.state.money = { currency: 'JPY', minor_unit: 0, accounts: [], candidates: [] };
    assert.equal(rewards.minorToAmountInput(500), '500');
    rewards.state.money = { currency: 'KWD', minor_unit: 3, accounts: [], candidates: [] };
    assert.equal(rewards.minorToAmountInput(1234), '1,234');
  } finally {
    rewards.state.money = vorher;
  }
});

test('Taschengeld: der Plan-Dialog selbst belegt das Feld mit dem Betrag, den der Server gespeichert hat', () => {
  // Der Helfer oben kann stimmen und der Dialog trotzdem an ihm vorbei rechnen:
  // gelesen wird deshalb das Feld, das der Dialog baut.
  const vorher = { money: rewards.state.money, user: rewards.state.user, open: globalThis.__openModal };
  const dialoge = [];
  globalThis.__openModal = (options) => { dialoge.push(options); };
  try {
    rewards.state.user = { role: 'admin' };
    withAccess({ rewards: 'write' }, () => {
      for (const [currency, minor_unit, stored, shown] of [['HUF', 2, 500000, '5000'], ['IDR', 2, 15000000, '150000'], ['EUR', 2, 500, '5,00'], ['JPY', 0, 500, '500'], ['KWD', 3, 1500, '1,500']]) {
        // Der Haushalt fuehrt eine ANDERE Waehrung als das Konto.
        const household = minor_unit === 0 ? { currency: 'KWD', minor_unit: 3 } : { currency: 'JPY', minor_unit: 0 };
        rewards.state.money = {
          ...household, candidates: [],
          accounts: [{ id: 3, display_name: 'Emma', balance_minor: 0, currency, minor_unit, plan: { amount_minor: stored, currency, minor_unit, frequency: 'weekly', anchor_day: 5, next_run_date: '2026-10-09', paused: false } }],
        };
        dialoge.length = 0;
        rewards.openMoneyPlanModal(3);
        assert.equal(dialoge.length, 1, `${currency}: der Dialog oeffnet`);
        const value = dialoge[0].content.match(/id="rw-money-amount"[^>]*value="([^"]*)"/)?.[1];
        assert.equal(value, shown, `${currency}: ${stored} kleinste Einheiten stehen als "${shown}" im Feld`);
        assert.match(dialoge[0].content, new RegExp(`\\(${currency}\\)`), `${currency}: das Feld nennt die Waehrung des Kontos, nicht die des Haushalts`);
      }
    });
  } finally {
    rewards.state.money = vorher.money;
    rewards.state.user = vorher.user;
    globalThis.__openModal = vorher.open;
  }
});

/** Zaehlt, wie oft die Seite sich neu laden will (`refreshActiveTab` sucht ihren Traeger). */
async function mitSeitenSonde(fn) {
  const vorher = { document: globalThis.document, api: globalThis.__apiStub, confirm: globalThis.__confirmModal };
  const sonde = { reloads: 0, gefragt: [] };
  globalThis.document = {
    querySelector: (sel) => { if (sel === '.rewards-page') sonde.reloads += 1; return null; },
    getElementById: () => null,
    body: {},
  };
  globalThis.__confirmModal = async (text) => { sonde.gefragt.push(text); return true; };
  try {
    return await fn(sonde);
  } finally {
    globalThis.document = vorher.document;
    globalThis.__apiStub = vorher.api;
    globalThis.__confirmModal = vorher.confirm;
  }
}

test('Taschengeld: scheitert "Plan beenden", sagt die Seite es - keine unbehandelte Rejection', async () => {
  await mitTaschengeld(() => withAccess({ rewards: 'write' }, () => mitSeitenSonde(async (sonde) => {
    globalThis.__apiStub = { delete: async () => { throw Object.assign(new Error('Server nicht erreichbar'), { status: 503 }); } };
    await assert.doesNotReject(rewards.removeMoneyPlan({ id: 3, display_name: 'Emma' }),
      'das Formular ist schon zu - der Fehler darf nicht ins Leere fallen');
    assert.deepEqual(sonde.gefragt, ['Server nicht erreichbar'], 'die Meldung steht in einem Dialog');
    assert.equal(sonde.reloads, 1, 'und die Liste zeigt danach, was gilt');

    sonde.gefragt.length = 0;
    const calls = [];
    globalThis.__apiStub = { delete: async (path) => { calls.push(path); return { ok: true }; } };
    await rewards.removeMoneyPlan({ id: 3, display_name: 'Emma' });
    assert.deepEqual(calls, ['/rewards/money/plans/3']);
    assert.deepEqual(sonde.gefragt, [], 'gelingt es, fragt niemand nach');
  })), { role: 'admin', me: 1 });
});

test('Taschengeld: reicht das Guthaben bei der Freigabe nicht mehr, laedt die Liste neu', async () => {
  await mitTaschengeld(() => withAccess({ rewards: 'write' }, () => mitSeitenSonde(async (sonde) => {
    globalThis.__apiStub = {
      patch: async () => { throw Object.assign(new Error('The balance no longer covers this withdrawal'), { data: { reason: 'insufficient_funds' } }); },
    };
    await rewards.decideRedemption(31, 'fulfill', null);
    assert.equal(sonde.gefragt.length, 1);
    assert.match(sonde.gefragt[0], /rewards\.money\.insufficientOnApprove/, 'der Satz ist uebersetzt, nicht der Servertext');
    assert.equal(sonde.reloads, 1, 'das Guthaben neben der Anfrage war der Stand von vor der Absage');

    // Ein anderer Fehler laesst die Liste stehen, wie bisher.
    sonde.reloads = 0;
    globalThis.__apiStub = { patch: async () => { throw new Error('kaputt'); } };
    await rewards.decideRedemption(31, 'fulfill', null);
    assert.equal(sonde.reloads, 0);
  })), { role: 'admin', me: 1 });
});

test('Geldbuchungen im Verlauf: was sie waren, steht in ihren Feldern', () => {
  mitTaschengeld(() => {
    assert.equal(rewards.moneyRowKind({ delta: 500, type: 'bonus', allowance_date: '2026-10-09' }), 'allowance');
    assert.equal(rewards.moneyRowKind({ delta: 2000, type: 'bonus', request_kind: 'deposit' }), 'deposit');
    assert.equal(rewards.moneyRowKind({ delta: -1234, type: 'redeem', request_kind: 'withdrawal' }), 'withdrawal');
    assert.equal(rewards.moneyRowKind({ delta: 300, type: 'bonus' }), 'credit');
    assert.equal(rewards.moneyRowKind({ delta: -300, type: 'adjust' }), 'debit');
    const html = rewards.moneyLedgerRowHtml({ delta: -1234, currency: 'EUR', minor_unit: 2, type: 'redeem', request_kind: 'withdrawal', reason: '<b>Kino</b>', created_at: '2026-10-06T10:00:00Z' });
    // Eine Zeile aus der Zeit vor einem Neuanfang traegt ihre eigene Waehrung.
    assert.match(rewards.moneyLedgerRowHtml({ delta: 500, currency: 'KWD', minor_unit: 3, type: 'bonus', created_at: '2026-10-06T10:00:00Z' }), /0[.,]500/);
    assert.match(html, /12[.,]34/);
    assert.match(html, /rw-delta--neg/);
    assert.doesNotMatch(html, /<b>Kino<\/b>/, 'die Notiz des Kindes laeuft durch esc()');
  });
});

// -------------------------------------------------------------------------
// Kalender
//
// Kopf, Ansichten und Detailansicht bauen direkt ins DOM; es gibt keine reine
// Markup-Funktion, an der sich das Ergebnis messen ließe. Geprüft werden
// deshalb die sechs Weichen am kommentarfreien Quelltext - und die
// Nur-lesen-Frage selbst am echten Rechte-Store.
// -------------------------------------------------------------------------

const CAL_SRC = readFileSync(new URL('../public/pages/calendar.js', import.meta.url), 'utf8');
// Ohne diesen Schnitt hielte ausgerechnet die BEGRÜNDUNG den Test grün: die
// Kommentare nennen `readOnly()` und `page-fab` mehrfach beim Namen.
const CAL_CODE = CAL_SRC.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

test('calendar.readOnly() folgt dem Rechte-Store', () => {
  withAccess({ calendar: 'read' }, () => assert.equal(calendar.readOnly(), true));
  withAccess({ calendar: 'write' }, () => assert.equal(calendar.readOnly(), false));
  // birthdays und reminders laufen serverseitig auf dasselbe Modul; die Seite
  // fragt deshalb genau einen Schlüssel ab.
  withAccess({}, () => assert.equal(calendar.readOnly(), false, 'ohne Overrides fail-open wie überall'));
});

test('openEventModal() riegelt ALLE Anlegewege an einer Stelle ab', () => {
  const fn = CAL_CODE.slice(CAL_CODE.indexOf('function openEventModal({ mode,'));
  const riegel = fn.indexOf('if (readOnly()) return;');
  assert.ok(riegel > -1 && riegel < 400,
    'der Riegel gehört an den Anfang: es gibt sieben Wege in dieses Formular, und sie alle einzeln zu sperren wäre sechs Chancen, eine zu vergessen');
});

test('requestDeleteEvent() riegelt alle drei Serien-Löschwege ab', () => {
  const fn = CAL_CODE.slice(CAL_CODE.indexOf('async function requestDeleteEvent(event) {'));
  assert.ok(fn.indexOf('if (readOnly()) return;') > -1 && fn.indexOf('if (readOnly()) return;') < 200);
});

test('Kalender: FAB und beide Leerzustands-CTAs hängen an readOnly()', () => {
  // Einen eigenen Kopfknopf gibt es nicht mehr (Re-Critique 2026-09-27, D3):
  // am Zeigergeraet dockt die Shell den FAB in den Kopf.
  assert.doesNotMatch(CAL_CODE, /toolbar-new-btn(?![\w-])/, 'kein zweiter Primaerknopf neben dem FAB');
  for (const [name, muster] of [
    ['der FAB', /\$\{readOnly\(\) \? '' : `\s*<button class="page-fab" id="fab-new-event"/],
    ['der Agenda-CTA', /action: readOnly\(\) \? undefined : \{ label: t\('calendar\.newEvent'\), attrs: \{ id: 'agenda-empty-cta' \} \}/],
    ['der Such-CTA', /\$\{readOnly\(\) \? '' : `<button class="btn btn--secondary" id="cal-search-empty-cta">/],
  ]) {
    assert.match(CAL_CODE, muster, `${name} muss bei 'calendar: read' verschwinden`);
  }
});

test('Kalender-Detailansicht: Löschen, Zurücksetzen und Bearbeiten fallen weg, die Karte bleibt', () => {
  assert.match(CAL_CODE, /const actions = readOnly\(\) \? \[\] : \[\{\s*id: 'detail-delete'/,
    'die Fußzeile fängt bei Nur-lesen leer an');
  assert.match(CAL_CODE, /ev\.external_source === 'ics' && ev\.user_modified === 1 && !readOnly\(\)/,
    'auch das Zurücksetzen eines ICS-Termins ist ein Schreibvorgang');
  assert.match(CAL_CODE, /edit: readOnly\(\) \? undefined : \{/,
    'ohne Mounter baut die geteilte Ansicht keinen Bearbeiten-Knopf');
  // Und die einzige nicht schreibende Aktion bleibt bedingungslos drin - seit
  // R10 als Folgeaktion der Ort-Zeile (mapRowAction), nicht im Fuss.
  assert.match(CAL_CODE, /id: 'detail-open-map'/);
  const mapBlock = CAL_CODE.slice(CAL_CODE.indexOf('function mapRowAction'), CAL_CODE.indexOf("id: 'detail-open-map'"));
  assert.ok(mapBlock.length > 0 && !mapBlock.includes('readOnly()'), '"In Karte öffnen" schreibt nichts und gehört auch einem Nur-lesen-Nutzer');
  assert.match(CAL_CODE, /action: mapRowAction\(ev\)/, 'die Ort-Zeile traegt die Karte fuer jeden, auch Nur-lesen');
});

// -------------------------------------------------------------------------
// Die Begründung für das Ausblenden des Einlösens - am Server gemessen
// -------------------------------------------------------------------------

test('die Ausnahmen vom Modulrecht stehen am Server, und es sind genau zwei Sorten', async () => {
  // WOVON DIESE SEITE ABHÄNGT. Bekäme `/rewards/redemptions` eine
  // Niveau-Senkung wie `/schedule/preferences`, gehörte der Einlöse-Knopf
  // einem Menschen mit `rewards: read` zurück. Und verlöre ein Display seine
  // benannten Schreibrouten, gehörten Personenauswahl und Tablett-Einlösen
  // weg. Beides sind Entscheidungen, die anderswo fallen - dieser Test macht
  // die Kopplung sichtbar, statt sie zu erraten.
  //
  // Die Senkungen stehen seit #1290 in EINER Tabelle (`READ_LEVEL_WRITES` in
  // server/scopes.js), die beide Gates lesen - gemessen wird deshalb das
  // Urteil, nicht die Schreibweise der Funktion.
  const { READ_LEVEL_WRITES, sessionModuleAccessRequirement } = await import('../server/scopes.js');
  assert.equal(sessionModuleAccessRequirement('/schedule/preferences', 'PUT').access, 'read',
    'Gegenprobe: die Tabelle wird wirklich gelesen');
  for (const pfad of ['/rewards/redemptions', '/rewards/redemptions/1/approve', '/rewards/1/redeem', '/rewards']) {
    assert.equal(sessionModuleAccessRequirement(pfad, 'POST').access, 'write',
      `eine Senkung für ${pfad} hieße: der Einlöse-Knopf gehört in rewards.js zurück`);
  }
  assert.ok(!READ_LEVEL_WRITES.some((e) => /rewards/i.test(e.pattern)),
    'eine Senkung für /rewards hieße: der Einlöse-Knopf gehört in rewards.js zurück');

  // Die zweite Sorte: benannte Routen für ein gekoppeltes Gerät.
  const display = readFileSync(new URL('../server/display-scopes.js', import.meta.url), 'utf8');
  assert.match(display, /DISPLAY_SCOPES = Object\.freeze\(\[[\s\S]*?'tasks:read'/,
    'ein Display liest Aufgaben - deshalb greift die Modulregel dieser Seite auf ihm überhaupt');
  assert.match(display, /DISPLAY_WRITE_ROUTES/,
    'und schreibt genau die Routen, die diese Liste benennt');
});

// -------------------------------------------------------------------------
// Die KREUZABHAENGIGKEIT: ein Dialog gehoert EINEM Modul, schreibt aber in ein
// zweites (#1253)
// -------------------------------------------------------------------------
//
// Alles oberhalb prueft das EIGENE Modul: `tasks: read` verbirgt die Knoepfe
// der Aufgabenseite. Hier geht es um den Fall, den das nicht abdeckt - der
// Aufgaben-Dialog stellt die Erinnerung ein, und Erinnerungen gehoeren dem
// KALENDER: `server/scopes.js` fuehrt die Praefixe `calendar`, `reminders` und
// `birthdays` unter EINEM Schluessel. Wer `tasks: write` und `calendar: read`
// traegt, stand deshalb vor einem Schalter, dessen Speichern serverseitig mit
// 403 endete: die Aufgabe war gespeichert, die Erinnerung nicht, und zu sehen
// bekam er nur eine Fehlermeldung. `applyModuleReadonly()` im Router kann das
// nicht sehen - es urteilt ueber das gerade offene Nav-Modul.
//
// Geprueft wird an BEIDEN Enden, weil der Riegel an beiden Enden sitzt: am
// Markup, das `renderModalContent()` wirklich erzeugt, und am GEFAHRENEN
// `handleFormSubmit()`, das die Erinnerungs-Anfrage dann unterlassen muss. Das
// zweite ist die Haelfte, die kein Textguard sehen kann - er liest einen
// Aufruf, nicht dessen Ausbleiben.

/**
 * Eine Zusicherung weiter unten nennt einen UTC-Zeitpunkt, der aus einer
 * Wanduhrzeit entsteht - der Wert haengt also an der Zone.
 *
 * Gefragt wird `process.env.TZ`, NICHT `Intl...resolvedOptions().timeZone`:
 * letzteres faellt ohne `TZ=` auf die SYSTEMZONE zurueck, und die ist auf dem
 * Entwicklungsrechner gerade Europe/Berlin. Ein verlorenes `TZ=` waere lokal
 * also gruen geblieben und erst in der CI (UTC) rot - genau der Fehler, den
 * diese Zeile ausschliessen soll. Nachgemessen: ohne `TZ=` meldet Intl
 * "Europe/Berlin" und `process.env.TZ` ist undefined.
 */
// Der Abschnitt hier ist der EINZIGE, der einen async Handler faehrt - alles
// oben ist synchron. Damit haengt er als einziger daran, dass `withAccess()`
// die Rechte auch ueber ein `await` haelt. Diese Zeile misst genau das, statt
// es dem Helfer zu glauben: ohne den Promise-Zweig dort steht nach dem ersten
// await wieder der fail-open-Standard `write`, und jede rechte-abhaengige
// Entscheidung NACH einem await waere still falsch statt rot.
test('withAccess haelt die Rechte auch ueber ein await', async () => {
  const gemessen = [];
  await withAccess({ tasks: 'write', calendar: 'read' }, async () => {
    gemessen.push(tasks.reminderAccess());
    await Promise.resolve();
    gemessen.push(tasks.reminderAccess());
  });
  assert.deepEqual(gemessen, ['read', 'read'], 'vor UND nach dem await');
  assert.equal(tasks.reminderAccess(), 'write', 'und danach ist wieder aufgeraeumt (fail-open)');
});

test('die Erinnerungs-Tests laufen in der Zone, auf die ihre Zeitpunkte festgenagelt sind', () => {
  assert.equal(
    process.env.TZ,
    'Europe/Berlin',
    'npm run test:module-readonly-ui setzt TZ=Europe/Berlin',
  );
});

const erinnerung = (over = {}) => ({
  id: 3, entity_type: 'task', entity_id: 7, remind_at: '2026-09-30T23:59:59', ...over,
});
const faelligeAufgabe = (over = {}) => aufgabe({
  due_date: '2026-10-01', priority: 'none', visibility: 'all',
  assigned_to: null, assigned_users: [], ...over,
});

/**
 * Der Erinnerungsabschnitt aus dem echten Dialog-Markup, oder '' .
 *
 * Gesucht wird der Tag-ANFANG, nicht der ganze Tag: der gesperrte Abschnitt
 * traegt `data-locked-due`, und ein wortwoertliches
 * `<div class="reminder-section">` fand ihn danach nicht mehr - die Suite
 * meldete "kein Abschnitt", wo einer stand. Ein Helfer, der am Markup nur eine
 * Schreibweise kennt, macht jede Zusicherung darueber blind.
 */
function reminderSection(html) {
  const start = html.search(/<div class="reminder-section"[\s>]/);
  if (start < 0) return '';
  const end = html.indexOf('<div id="task-form-error"', start);
  assert.ok(end > start, 'der Abschnitt endet vor der Fehlerzeile des Formulars');
  return html.slice(start, end);
}

/** Jedes Bedienelement des Abschnitts, mit seinem oeffnenden Tag. */
function reminderControls(section) {
  return [...section.matchAll(/<(input|select|textarea)\b[^>]*>/g)].map((m) => m[0]);
}

test('calendar: write laesst den Erinnerungsabschnitt unangetastet', () => {
  withAccess({ tasks: 'write', calendar: 'write' }, () => {
    const section = reminderSection(tasks.renderModalContent({
      task: faelligeAufgabe(), users: [], reminder: erinnerung(),
    }));
    assert.ok(section, 'der Abschnitt steht im Dialog');
    assert.ok(reminderControls(section).length >= 4, 'Schalter, Vorlauf und die zwei eigenen Felder');
    for (const tag of reminderControls(section)) {
      assert.doesNotMatch(tag, /\sdisabled/, `kein Feld ist gesperrt: ${tag}`);
    }
    assert.doesNotMatch(section, /reminders\.readOnlyNotice/, 'kein Hinweis, wo es nichts zu erklaeren gibt');
  });
});

test('calendar: write zeigt den Abschnitt auch OHNE bestehende Erinnerung - dort wird ja angelegt', () => {
  withAccess({ tasks: 'write', calendar: 'write' }, () => {
    for (const task of [null, faelligeAufgabe()]) {
      const section = reminderSection(tasks.renderModalContent({ task, users: [], reminder: null }));
      assert.ok(section, 'mit Schreibrecht ist der leere Schalter das Angebot, eine anzulegen');
      assert.equal(reminderControls(section).filter((tag) => /\sdisabled/.test(tag)).length, 0);
    }
  });
});

test('calendar: read sperrt JEDES Feld des Abschnitts und laesst die Erinnerung stehen', () => {
  withAccess({ tasks: 'write', calendar: 'read' }, () => {
    const section = reminderSection(tasks.renderModalContent({
      task: faelligeAufgabe(), users: [], reminder: erinnerung(),
    }));
    assert.ok(section, 'eine bestehende Erinnerung IST Zustand und bleibt sichtbar');
    assert.match(section, /id="reminder-toggle"[^>]*\schecked/, 'der gespeicherte Stand steht weiter da');
    const tags = reminderControls(section);
    assert.ok(tags.length >= 4, 'der Abschnitt bringt seine Felder mit');
    // Die Regel, nicht die Aufzaehlung: ein spaeter dazugekommenes Feld ohne
    // `disabled` faellt hier auf, ohne dass diese Liste gepflegt werden muss.
    for (const tag of tags) {
      assert.match(tag, /\sdisabled/, `gesperrt gehoert auch: ${tag}`);
    }
    assert.match(section, /reminders\.readOnlyNotice/, 'der Dialog sagt, warum');
  });
});

// Die erste Fassung dieses Riegels sperrte den Abschnitt bei `read` immer -
// auch dort, wo es nichts zu sperren gab. Das widerspricht derselben
// Faustregel, mit der `none` begruendet ist: gesperrt wird ZUSTAND, und ein
// leerer Schalter ist keiner. Beide Wege dorthin stehen hier, weil sie
// verschiedene Ursachen haben: im Anlege-Dialog gibt es die Aufgabe noch
// nicht, an einer bestehenden Aufgabe hing nie eine Erinnerung.
test('calendar: read zeigt im ANLEGE-Dialog keinen Abschnitt - eine neue Aufgabe hat keinen Zustand', () => {
  withAccess({ tasks: 'write', calendar: 'read' }, () => {
    const html = tasks.renderModalContent({ task: null, users: [], reminder: null });
    assert.equal(reminderSection(html), '', 'kein gesperrter leerer Schalter');
    assert.doesNotMatch(html, /id="reminder-toggle"/);
    assert.doesNotMatch(html, /reminders\.readOnlyNotice/, 'auch kein Hinweis auf ein Feld, das es nicht gibt');
  });
});

test('calendar: read zeigt an einer Aufgabe OHNE Erinnerung keinen Abschnitt', () => {
  withAccess({ tasks: 'write', calendar: 'read' }, () => {
    const html = tasks.renderModalContent({ task: faelligeAufgabe(), users: [], reminder: null });
    assert.equal(reminderSection(html), '', 'nichts gespeichert heisst nichts zu zeigen');
    assert.doesNotMatch(html, /id="reminder-toggle"/);
  });
});

test('calendar: none entfernt den Abschnitt ganz - es gibt keinen Zustand zu zeigen', () => {
  withAccess({ tasks: 'write', calendar: 'none' }, () => {
    // BEIDE Lagen, und die zweite ist der eigentliche Test. Mit `reminder: null`
    // allein faellt diese Zeile auch dann noch richtig aus, wenn die Bedingung
    // zu `(none || read) && !reminder` verengt wird - nachgemessen: 51 von 51
    // blieben gruen. Dass eine Erinnerung hier nie ankommt, liegt allein daran,
    // dass `loadReminderForTask()` fuer `none` vorher abbiegt; das ist eine
    // Kopplung zwischen zwei Funktionen, keine Eigenschaft dieser hier.
    for (const reminder of [null, erinnerung()]) {
      const html = tasks.renderModalContent({ task: faelligeAufgabe(), users: [], reminder });
      assert.equal(reminderSection(html), '', 'kein Schalter, der nur einen 403 verspricht');
      assert.doesNotMatch(html, /id="reminder-toggle"/);
    }
  });
});

test('ohne geladene Rechte bleibt die Erinnerung bei Vollzugriff (fail-open wie permissions.js)', () => {
  clearPermissions();
  assert.equal(tasks.reminderAccess(), 'write');
  const section = reminderSection(tasks.renderModalContent({
    task: faelligeAufgabe(), users: [], reminder: erinnerung(),
  }));
  for (const tag of reminderControls(section)) assert.doesNotMatch(tag, /\sdisabled/);
});

test('calendar: write haengt gar kein data-locked-due an - dort gibt es nichts zu bewachen', () => {
  withAccess({ tasks: 'write', calendar: 'write' }, () => {
    const section = reminderSection(tasks.renderModalContent({
      task: faelligeAufgabe(), users: [], reminder: erinnerung(),
    }));
    assert.doesNotMatch(section, /data-locked-due/);
  });
});

test('das Markup nennt eine leere Faelligkeit auch leer - sonst sperrte der Riegel den Unschuldigen aus', () => {
  withAccess({ tasks: 'write', calendar: 'read' }, () => {
    const section = reminderSection(tasks.renderModalContent({
      task: faelligeAufgabe({ due_date: null }), users: [], reminder: erinnerung(),
    }));
    assert.match(section, /data-locked-due=""/, 'kein "null" und kein "undefined" im Attribut');
  });
});

// -------------------------------------------------------------------------
// Und das zweite Ende: der gefahrene Formular-Handler
// -------------------------------------------------------------------------

/** Ein Feld, wie der Handler es liest: `.value`, sonst nichts. */
const feld = (value = '') => ({ value: String(value) });

/**
 * Das Formular. Benannte Felder liegen direkt darauf (`form.title.value` -
 * genau wie im Browser), alles mit einem Selektor kommt ueber querySelector.
 */
function attrappenFormular({ byId = {}, ...named } = {}) {
  const form = { querySelector: (sel) => byId[sel] ?? null };
  for (const [name, value] of Object.entries(named)) form[name] = feld(value);
  return form;
}

/**
 * Fehlerzeile, Knopf und die versteckte Task-id - drei getElementById-Ziele.
 * `errorNode` liegt zusaetzlich offen: ob das Speichern ABGEBROCHEN hat, steht
 * nur dort, und ein Test, der nur die ausgebliebenen Anfragen zaehlt, koennte
 * einen stillen Abbruch nicht von einem geglueckten Speichern unterscheiden.
 */
function attrappenDokument(taskId = '') {
  const nodes = {
    'task-form-error': { hidden: true, textContent: '' },
    'task-submit-btn': { disabled: false, textContent: '', classList: { add() {}, remove() {} } },
    'task-id': feld(taskId),
  };
  return {
    getElementById: (id) => nodes[id] ?? null,
    documentElement: { lang: 'de', classList: { toggle() {}, add() {}, remove() {}, contains: () => false } },
    addEventListener() {},
    errorNode: nodes['task-form-error'],
  };
}

/**
 * Faehrt handleFormSubmit gegen einen Attrappen-Dialog und gibt zurueck, was an
 * den Server ging. `reminderChecked` ist der Stand des (bei `read` gesperrten)
 * Kaestchens - genau der Wert, den ein blindes Wiederholen erneut schicken
 * wuerde.
 *
 * Das globale `document` gehoert hier dem Mini-DOM aus installMiniDom(); es
 * wird nur fuer die Dauer des Aufrufs getauscht und danach zurueckgegeben,
 * sonst stehen die Markup-Tests darueber und das Aufraeumen unten ohne da.
 */
async function speichernUndAufrufeSammeln({
  modules, reminderChecked, taskId = '7', dueDate = '2026-10-01',
  // Die Faelligkeit, mit der der Dialog AUFGING - im Browser traegt sie der
  // gesperrte Abschnitt als `data-locked-due`. Standard ist derselbe Wert wie
  // im Feld, also "unveraendert"; ein Test, der das Leerraeumen messen will,
  // setzt `dueDate: ''` und laesst diesen stehen.
  dueDateWhenOpened = '2026-10-01',
}) {
  const calls = [];
  const record = (method) => async (path, body) => {
    calls.push({ method, path, body });
    if (method === 'post' && path === '/tasks') return { data: { id: 7 } };
    return { data: null };
  };
  globalThis.__apiStub = {
    get: record('get'),
    getWithSource: async (path) => { calls.push({ method: 'get', path }); return { data: { data: [] }, fromCache: false }; },
    post: record('post'),
    put: record('put'),
    patch: record('patch'),
    delete: record('delete'),
  };
  // Der Loader-Stub liefert ohne diesen Haken ein leeres Objekt, und der
  // Handler bricht dann an `!rrule.valid_until` mit "invalidDate" ab, bevor er
  // ueberhaupt bis zur Erinnerung kommt.
  globalThis.__rruleValues = {
    is_recurring: 0, recurrence_rule: null, recurrence_from_completion: 0, valid_until: true,
  };
  const echtesDocument = globalThis.document;
  const doc = attrappenDokument(taskId);
  globalThis.document = doc;
  // `installMiniDom()` setzt `window.yuvomi = {}` - ohne `showToast` wirft der
  // Handler NACH dem erfolgreichen PUT, das aeussere catch macht daraus eine
  // Fehlermeldung, und die Erinnerungs-Anfrage bleibt aus. Das saehe wie der
  // Riegel aus und waere keiner: gemessen an
  // "window.yuvomi.showToast is not a function" in der Fehlerzeile. Der Toast
  // gehoert also zur Attrappe, nicht zum Befund.
  const echterToast = globalThis.window.yuvomi.showToast;
  globalThis.window.yuvomi.showToast = () => {};
  const form = attrappenFormular({
    title: 'Fenster putzen',
    description: '',
    priority: 'none',
    category: 'household',
    start_date: '',
    due_date: dueDate,
    due_time: '',
    points: '0',
    byId: {
      '#reminder-toggle': { checked: reminderChecked },
      '#reminder-offset': { value: 'offset_1d' },
      '#task-visibility': { value: 'all' },
      // Den Abschnitt gibt es nur gesperrt und nur mit haengender Erinnerung -
      // genau dann traegt er im Browser das Attribut (eigens gemessen, siehe
      // die Naht-Zusicherung weiter unten).
      '.reminder-section[data-locked-due]': reminderChecked && modules.calendar === 'read'
        ? { dataset: { lockedDue: dueDateWhenOpened } }
        : null,
    },
  });
  try {
    await withAccess(modules, () => tasks.handleFormSubmit(
      { preventDefault() {}, target: form },
      { container: null, onChanged: async () => {} },
    ));
  } finally {
    delete globalThis.__apiStub;
    delete globalThis.__rruleValues;
    globalThis.document = echtesDocument;
    if (echterToast === undefined) delete globalThis.window.yuvomi.showToast;
    else globalThis.window.yuvomi.showToast = echterToast;
  }
  return { calls, error: doc.errorNode.hidden ? null : doc.errorNode.textContent };
}

const erinnerungsAufrufe = (calls) => calls.filter((c) => String(c.path).startsWith('/reminders'));

test('calendar: read speichert die Aufgabe und laesst die Erinnerung unangetastet', async () => {
  const { calls } = await speichernUndAufrufeSammeln({
    modules: { tasks: 'write', calendar: 'read' }, reminderChecked: true,
  });
  assert.ok(calls.some((c) => c.method === 'put' && c.path === '/tasks/7'), 'die Aufgabe selbst geht raus');
  assert.deepEqual(erinnerungsAufrufe(calls), [], 'kein POST /reminders, das nur einen 403 holen wuerde');
});

test('calendar: read schickt auch kein DELETE, wenn das gesperrte Kaestchen leer ist', async () => {
  const { calls } = await speichernUndAufrufeSammeln({
    modules: { tasks: 'write', calendar: 'read' }, reminderChecked: false,
  });
  assert.ok(calls.some((c) => c.method === 'put' && c.path === '/tasks/7'));
  assert.deepEqual(erinnerungsAufrufe(calls), [], 'nicht abgewaehlt heisst nicht geloescht');
});

test('calendar: write schreibt die Erinnerung weiter wie bisher', async () => {
  const { calls } = await speichernUndAufrufeSammeln({
    modules: { tasks: 'write', calendar: 'write' }, reminderChecked: true,
  });
  const posts = erinnerungsAufrufe(calls).filter((c) => c.method === 'post');
  assert.equal(posts.length, 1, 'der Weg mit Schreibrecht bleibt offen');
  assert.equal(posts[0].body.entity_type, 'task');
  // Die id kommt aus dem versteckten Feld und ist ein String - so geht sie
  // auch im Browser raus; der Server nimmt sie so.
  assert.equal(posts[0].body.entity_id, '7');
  // Der Zeitpunkt entsteht als WANDUHRZEIT (`new Date('...T23:59:59')`) und
  // geht als UTC raus - in Europe/Berlin am 1.10. also zwei Stunden davor. Die
  // Zone nagelt das npm-Script fest; geprueft wird hier nur, DASS der Wert
  // unveraendert durchgeht (der Vorlauf selbst haengt an test:reminder-offset).
  assert.equal(posts[0].body.remind_at, '2026-09-30T21:59:59');
});

test('calendar: write loescht die Erinnerung weiter, wenn der Schalter aus ist', async () => {
  const { calls } = await speichernUndAufrufeSammeln({
    modules: { tasks: 'write', calendar: 'write' }, reminderChecked: false,
  });
  const deletes = erinnerungsAufrufe(calls).filter((c) => c.method === 'delete');
  assert.equal(deletes.length, 1, 'das Abwaehlen loescht weiter');
  assert.match(deletes[0].path, /entity_type=task&entity_id=7/);
});

// Der Riegel uebersprang mit dem Schreibvorgang auch die VORBEDINGUNG, und die
// gilt unabhaengig vom Schreibrecht - eine Erinnerung braucht ein
// Faelligkeitsdatum. Mit `write` verweigert die App genau diese Kombination
// seit immer; ohne Schreibrecht ging die Aufgabe mit `due_date: null` durch und
// liess die Erinnerung an einer Aufgabe ohne Faelligkeit zurueck
// (`server/routes/tasks.js` fasst die Tabelle nicht an). Die Meldung nennt
// deshalb das Faelligkeitsdatum, das dieser Nutzer BEDIENEN kann, nicht den
// Schalter, den er nicht bedienen kann.
test('calendar: read darf das Faelligkeitsdatum nicht wegraeumen, solange eine Erinnerung haengt', async () => {
  const { calls, error } = await speichernUndAufrufeSammeln({
    modules: { tasks: 'write', calendar: 'read' }, reminderChecked: true, dueDate: '',
  });
  assert.equal(error, 'tasks.reminderLockedNeedsDueDate', 'die Meldung nennt das bedienbare Feld');
  assert.deepEqual(calls.filter((c) => c.path === '/tasks/7'), [], 'die Aufgabe geht NICHT raus');
  assert.deepEqual(erinnerungsAufrufe(calls), [], 'und an der Erinnerung wird auch nichts versucht');
});

test('calendar: read ohne haengende Erinnerung darf das Faelligkeitsdatum leeren', async () => {
  const { calls, error } = await speichernUndAufrufeSammeln({
    modules: { tasks: 'write', calendar: 'read' }, reminderChecked: false, dueDate: '',
  });
  assert.equal(error, null, 'ohne Erinnerung gibt es keine Regel zu brechen');
  assert.ok(calls.some((c) => c.method === 'put' && c.path === '/tasks/7'), 'die Aufgabe geht raus');
});

// Eine Aufgabe kann schon OHNE Faelligkeit ankommen, waehrend eine gesperrte
// Erinnerung an ihr haengt, und daran ist dieser Nutzer dann unschuldig:
// Erinnerungen sind pro `created_by` gefuehrt (server/routes/reminders.js
// filtert GET, Upsert und DELETE danach) und niemand erzwingt die Regel
// tabellenuebergreifend - ein ZWEITES Mitglied raeumt das Datum weg und loescht
// dabei nur seine eigene, nicht vorhandene Zeile. Ein Riegel auf den
// Endzustand haette den Erstbesitzer danach aus JEDER Aenderung ausgesperrt,
// auch aus einer Titelkorrektur, und ohne Ausweg.
test('calendar: read darf eine Aufgabe speichern, die schon OHNE Faelligkeit kam', async () => {
  const { calls, error } = await speichernUndAufrufeSammeln({
    modules: { tasks: 'write', calendar: 'read' },
    reminderChecked: true,
    dueDate: '',
    dueDateWhenOpened: '', // so ging der Dialog auf: fremde Erinnerung, keine Faelligkeit
  });
  assert.equal(error, null, 'wer nichts weggeraeumt hat, wird nicht aufgehalten');
  assert.ok(calls.some((c) => c.method === 'put' && c.path === '/tasks/7'), 'die Titelaenderung geht durch');
  assert.deepEqual(erinnerungsAufrufe(calls), [], 'die fremde Erinnerung bleibt unangetastet');
});

test('calendar: read darf das Faelligkeitsdatum WECHSELN - das bricht die Regel nicht', async () => {
  const { calls, error } = await speichernUndAufrufeSammeln({
    modules: { tasks: 'write', calendar: 'read' }, reminderChecked: true, dueDate: '2026-11-15',
  });
  assert.equal(error, null);
  const put = calls.find((c) => c.method === 'put' && c.path === '/tasks/7');
  assert.equal(put?.body?.due_date, '2026-11-15', 'das neue Datum geht durch');
  assert.deepEqual(erinnerungsAufrufe(calls), [], 'die Erinnerung bleibt unangetastet');
});

// DIE PRAEMISSE, AUF DER DER GANZE `read`-ZWEIG STEHT: dass `GET /reminders`
// fuer `calendar: read` durchgeht und der angezeigte Wert deshalb WIRKLICH da
// ist und nicht geraten. Der Satz stand dreimal in Prosa und nirgends als
// Zusicherung. Was das kostet, ist gemessen: aendert man in
// `loadReminderForTask()` das `=== 'none'` zu `!== 'write'`, bekommt ein
// `read`-Mitglied nie eine Erinnerung, `renderReminderSection` nimmt dann immer
// den `(read && !reminder) -> ''`-Ausgang, und der gesamte gesperrte Abschnitt
// ist produktiv toter Code - bei 51 von 51 gruenen Tests. Dasselbe beim
// ersatzlosen Loeschen der Zeile (dann nur ein 403 je Dialog).
async function ladenUndAufrufeSammeln(access) {
  const calls = [];
  globalThis.__apiStub = {
    get: async (path) => {
      calls.push(path);
      if (access === 'none') throw new Error('403');
      return { data: { id: 3, entity_type: 'task', entity_id: 7, remind_at: '2026-09-30T23:59:59' } };
    },
  };
  try {
    const reminder = await withAccess({ tasks: 'write', calendar: access }, () => tasks.loadReminderForTask(7));
    return { calls, reminder };
  } finally {
    delete globalThis.__apiStub;
  }
}

test('calendar: read holt die Erinnerung wirklich - darauf steht der ganze gesperrte Zweig', async () => {
  const { calls, reminder } = await ladenUndAufrufeSammeln('read');
  assert.deepEqual(calls, ['/reminders?entity_type=task&entity_id=7'], 'genau eine Anfrage, und zwar diese');
  assert.equal(reminder?.remind_at, '2026-09-30T23:59:59', 'der Wert kommt an und wird nicht verworfen');
});

test('calendar: write holt sie genauso', async () => {
  const { calls, reminder } = await ladenUndAufrufeSammeln('write');
  assert.equal(calls.length, 1);
  assert.ok(reminder, 'mit Schreibrecht erst recht');
});

test('calendar: none fragt gar nicht erst - der 403 waere die einzige Antwort', async () => {
  const { calls, reminder } = await ladenUndAufrufeSammeln('none');
  assert.deepEqual(calls, [], 'keine Anfrage, die nur ein 403 holen kann');
  assert.equal(reminder, null);
});

// DIE NAHT ZWISCHEN DEN ZWEI HAELFTEN. Der Riegel im Speichern liest die
// Faelligkeit, mit der der Dialog aufging, aus `data-locked-due` am Markup -
// und alle Tests darueber reichen diesen Wert als Attrappe herein. Damit
// pruefen beide Haelften einander gegen ihre eigene Annahme: nachgemessen
// blieben alle Tests gruen, als das Attribut im echten Markup tot gestellt
// wurde. Dieser Test holt den Wert deshalb AUS dem erzeugten Markup und
// schickt ihn durch den Handler. Verschwindet das Attribut oder wird es
// umbenannt, kommt '' heraus, der Riegel schweigt und diese Zeile wird rot.
test('das Markup traegt die Faelligkeit, die der Riegel im Speichern liest', async () => {
  const task = faelligeAufgabe();
  const ausDemMarkup = withAccess({ tasks: 'write', calendar: 'read' }, () => {
    const section = reminderSection(tasks.renderModalContent({
      task, users: [], reminder: erinnerung(),
    }));
    return section.match(/data-locked-due="([^"]*)"/)?.[1] ?? null;
  });
  assert.equal(ausDemMarkup, task.due_date, 'der gesperrte Abschnitt nennt die Faelligkeit der Aufgabe');

  const { error } = await speichernUndAufrufeSammeln({
    modules: { tasks: 'write', calendar: 'read' },
    reminderChecked: true,
    dueDate: '',
    dueDateWhenOpened: ausDemMarkup,
  });
  assert.equal(error, 'tasks.reminderLockedNeedsDueDate', 'und der Handler erkennt daran das Leerraeumen');
});

// =========================================================================
// #1265 P1: Pinnwand, Kontakte, Geburtstage
//
// Drei Seiten, die ihre Schreibwege bei `read` weiter voll bedienbar trugen.
// Gemessen wird am ERZEUGTEN MARKUP, nicht am Quelltext: jede Zusicherung
// kommt im Paar - „bei read weg" UND „bei write da" -, denn ein Test, der nur
// ein fehlendes Element prueft, ist auch gruen, wenn gar nichts gerendert
// wurde. Jeder Nur-lesen-Fall prueft deshalb zusaetzlich einen INHALT, den der
// Renderer nur ausgeben kann, wenn er wirklich gelaufen ist.
//
// Was hier NICHT steht, weil es diese drei Seiten nicht betrifft: eine
// Display-Ausnahme. `DISPLAY_WRITE_ROUTES` (server/display-scopes.js) fuehrt
// genau zwei Routen, `/tasks/:id/status` und `/rewards/redemptions` - fuer
// Notizen, Kontakte und Geburtstage gibt es keine. Ein Tablett traegt auf
// `calendar` (und damit auf den Geburtstagen) `read` und darf dort nichts;
// `notes` und `contacts` stehen gar nicht in seiner Scope-Liste. Die Modulregel
// nimmt einem Display hier also nichts weg, was der Server ihm gaebe - der
// Test unten haelt genau das fest.
// =========================================================================

test('keine der drei Seiten hat eine Display-Ausnahme - der Server gibt keine her', () => {
  const display = readFileSync(new URL('../server/display-scopes.js', import.meta.url), 'utf8');
  const routen = display.slice(display.indexOf('DISPLAY_WRITE_ROUTES = Object.freeze(['));
  const liste = routen.slice(0, routen.indexOf(']);'));
  assert.ok(!/notes|contacts|birthdays/.test(liste),
    'gaebe es hier eine Route, brauchte die betroffene Seite ein actingAsDisplay() VOR der Modulregel');
  // Und die Gegenrichtung: die zwei, die es gibt, stehen noch da. Verschwaenden
  // sie, waere der Satz oben trivial wahr.
  assert.match(liste, /\/tasks\\\/\\d\+\\\/status/);
  assert.match(liste, /\/rewards\\\/redemptions/);
});

// -------------------------------------------------------------------------
// Pinnwand (Notizen)
// -------------------------------------------------------------------------

const notiz = (over = {}) => ({
  id: 12, title: 'Einkauf', content: '- [x] Milch\n- [ ] Brot',
  color: '#EFE3BE', pinned: 0, creator_name: 'Ada', creator_color: '#4455AA',
  categories: [], ...over,
});

/**
 * Die Notizen holen `renderMarkdownLight` ueber `/utils/html.js`, und das ist
 * im Loader ein Stub, der den Text nur durchreicht. Fuer diese Tests tritt der
 * ECHTE Renderer an seine Stelle (er ist oben schon relativ importiert) - sonst
 * stuende im Kartenmarkup gar kein Kaestchen, und „kein Bedienelement" waere
 * trivial wahr.
 */
function mitEchtemMarkdown(fn) {
  const vorher = globalThis.__renderMarkdownLight;
  globalThis.__renderMarkdownLight = renderMarkdownLight;
  try { return fn(); } finally {
    if (vorher === undefined) delete globalThis.__renderMarkdownLight;
    else globalThis.__renderMarkdownLight = vorher;
  }
}

test('Notizkarte mit Schreibrecht: Nadel, Loeschen und das antippbare Kaestchen', () => {
  mitEchtemMarkdown(() => withAccess({ notes: 'write' }, () => {
    const html = notes.renderNoteCard(notiz());
    assert.match(html, /data-action="pin"/);
    assert.match(html, /data-action="delete"/);
    assert.match(html, /data-action="open"/);
    assert.match(html, /<button type="button" class="note-md-box" role="checkbox"/,
      'die Checkliste ist bedienbar (#704)');
    assert.doesNotMatch(html, /note-card__pin--static/);
  }));
});

test('R8 H15: der Notiztitel ist eine echte Ueberschrift der passenden Ebene, ohne neue Optik', async () => {
  mitEchtemMarkdown(() => withAccess({ notes: 'read' }, () => {
    const html = notes.renderNoteCard(notiz({ title: 'Einkauf' }));
    assert.match(html, /<h2 class="note-card__title">Einkauf<\/h2>/,
      'ohne Gruppenkoepfe steht die Notiz direkt unter dem Seitentitel (h1)');
    assert.doesNotMatch(html, /<div class="note-card__title">/, 'ein `div` findet die Ueberschriften-Navigation nicht');
    assert.match(notes.renderNoteCard(notiz({ title: 'Einkauf' }), { headingLevel: 3 }), /<h3 class="note-card__title">/,
      'unter "Angeheftet"/"Weitere" (h2) eine Ebene tiefer');
    assert.doesNotMatch(notes.renderNoteCard(notiz({ title: '' })), /note-card__title/, 'ohne Titel keine leere Ueberschrift');
  }));
  // Die Optik haengt an der Klasse, nicht am Element: die Rolle setzt die
  // Groesse, sonst griffe die UA-Groesse eines h2.
  const { readFileSync } = await import('node:fs');
  const typo = readFileSync(new URL('../public/styles/typography.css', import.meta.url), 'utf8');
  assert.ok([...eachRule(typo)].some((r) => r.selector.split(',').map((x) => x.trim()).includes('.note-card__title')
    && /font-size\s*:/.test(r.body)), '.note-card__title bringt seine Schriftgroesse selbst mit');
  // Der Aufruf mit `map()` reichte den Index als zweites Argument durch - die
  // Ebene kommt deshalb als benanntes Objekt, und das Raster ruft sie so auf.
  const src = readFileSync(new URL('../public/pages/notes.js', import.meta.url), 'utf8');
  assert.doesNotMatch(src, /\.map\(renderNoteCard\)/, 'map() darf renderNoteCard keinen Index als Optionen geben');
});

test('Notizkarte mit `notes: read`: das Kaestchen wird zum Zustandszeichen', () => {
  mitEchtemMarkdown(() => withAccess({ notes: 'read' }, () => {
    const html = notes.renderNoteCard(notiz());

    // Zustand ANZEIGEN: das Kaestchen bleibt - als span mit role="img", dessen
    // Beschriftung den Zustand nennt, nicht als gesperrter Knopf.
    assert.match(html, /<span class="note-md-box" role="img" aria-label="Milch: notes\.checklistDone"/,
      'der Haken ist die Auskunft der Zeile und darf nicht verschwinden');
    assert.match(html, /<span class="note-md-box" role="img" aria-label="Brot: notes\.checklistOpen"/);
    assert.doesNotMatch(html, /role="checkbox"/,
      'aber kein Bedienelement mehr: ein toter Knopf verspricht eine Beruehrung, die nichts tut');
    assert.doesNotMatch(html, /data-md-line/,
      'ohne Zeilennummer findet auch der delegierte Handler nichts zum Umschalten');
    assert.doesNotMatch(html, /aria-hidden="true"><\/span>/,
      'und ausdruecklich nicht die dekorative Form - die verschwiege den Zustand');

    // Reine HANDLUNG: verschwindet.
    assert.doesNotMatch(html, /data-action="pin"/);
    assert.doesNotMatch(html, /data-action="delete"/);

    // Der Leseweg bleibt, und der Inhalt steht wirklich noch da - sonst maesse
    // dieser Test einen Renderer, der nie gelaufen ist.
    assert.match(html, /data-action="open"/);
    assert.match(html, /Einkauf/);
    assert.match(html, /Milch/);
    assert.match(html, /Brot/);
    assert.match(html, /is-checked/, 'der erledigte Punkt ist auch sichtbar erledigt');
  }));
});

test('Nadel bei `notes: read`: gesetzt bleibt als Zeichen, nicht gesetzt faellt weg', () => {
  withAccess({ notes: 'read' }, () => {
    const angepinnt = notes.pinMarkup(notiz({ pinned: 1 }));
    assert.match(angepinnt, /<span class="note-card__pin note-card__pin--static" role="img"/);
    assert.match(angepinnt, /aria-label="notes\.pinnedState"/,
      'die Beschriftung nennt den ZUSTAND, nicht „Anpinnen aufheben"');
    assert.doesNotMatch(angepinnt, /notes\.unpinAction/);
    assert.doesNotMatch(angepinnt, /<button/);

    assert.equal(notes.pinMarkup(notiz({ pinned: 0 })), '',
      'ein leerer Schalter ist kein Zustand, den man anzeigen koennte');
  });
  // Und mit Schreibrecht ist beides ein Knopf.
  withAccess({ notes: 'write' }, () => {
    assert.match(notes.pinMarkup(notiz({ pinned: 1 })), /<button class="note-card__pin" data-action="pin"/);
    assert.match(notes.pinMarkup(notiz({ pinned: 0 })), /<button class="note-card__pin" data-action="pin"/);
  });
});

test('CHECKLIST_OPTS: bedienbar oder Zeichen, nie beides', () => {
  withAccess({ notes: 'write' }, () => {
    const opts = notes.CHECKLIST_OPTS().checklist;
    assert.equal(opts.interactive, true);
    assert.equal(opts.stateLabels, undefined);
  });
  withAccess({ notes: 'read' }, () => {
    const opts = notes.CHECKLIST_OPTS().checklist;
    assert.notEqual(opts.interactive, true);
    assert.deepEqual(opts.stateLabels, { checked: 'notes.checklistDone', unchecked: 'notes.checklistOpen' });
  });
});

test('Leere Pinnwand mit `notes: read`: kein Anlegen-CTA, der den FAB klickt', () => {
  const vorher = { ...notes.state };
  Object.assign(notes.state, { notes: [], filterQuery: '', filterCreator: '', filterCategoryIds: [] });
  try {
    withAccess({ notes: 'write' }, () => {
      assert.match(notes.notesEmptyStateHtml(false), /id="empty-cta-notes"/);
    });
    withAccess({ notes: 'read' }, () => {
      const html = notes.notesEmptyStateHtml(false);
      assert.doesNotMatch(html, /empty-cta-notes/,
        'der CTA klickt den FAB, und .click() erreicht auch ein display:none-Element');
      assert.match(html, /notes\.emptyTitle/, 'der Leerzustand selbst bleibt - er erklaert ja etwas');
    });
  } finally { Object.assign(notes.state, vorher); }
});

/** Faengt die Optionen ab, mit denen eine Seite `openModal` ruft. */
function modalOptionen(fn) {
  const vorher = globalThis.__openModal;
  let letzte = null;
  globalThis.__openModal = (opts) => { letzte = opts; };
  try { fn(); } finally {
    if (vorher === undefined) delete globalThis.__openModal;
    else globalThis.__openModal = vorher;
  }
  return letzte;
}

test('Notiz-Dialog mit `notes: read`: Leseansicht, kein Editor, keine Fusszeile', () => {
  const offen = mitEchtemMarkdown(() => withAccess({ notes: 'read' }, () => (
    modalOptionen(() => notes.openNoteModal({ mode: 'edit', note: notiz({ pinned: 1 }) }))
  )));
  assert.ok(offen, 'der Zettel geht auf - Lesen ist erlaubt');
  assert.match(offen.content, /note-read-view/);
  assert.match(offen.content, /Milch/, 'und er zeigt wirklich den Inhalt');
  assert.doesNotMatch(offen.content, /note-mode-switch/,
    'kein Reiter „Bearbeiten" - er fuehrte auf ein 403');
  assert.doesNotMatch(offen.content, /note-modal-save/);
  assert.doesNotMatch(offen.content, /note-modal-delete/);
  assert.doesNotMatch(offen.content, /note-category-search/, 'und kein Weg, eine Kategorie anzulegen');
  assert.match(offen.content, /note-md-box" role="img"/, 'die Kaestchen sind hier Zeichen');

  // Der Anlegeweg fuehrt gar nirgends hin.
  const angelegt = withAccess({ notes: 'read' }, () => (
    modalOptionen(() => notes.openNoteModal({ mode: 'create' }))
  ));
  assert.equal(angelegt, null, 'ein Dialog zum Anlegen ginge bei `read` nur ins 403');

  // Und mit Schreibrecht steht der ganze Dialog da.
  const schreibend = mitEchtemMarkdown(() => withAccess({ notes: 'write' }, () => (
    modalOptionen(() => notes.openNoteModal({ mode: 'edit', note: notiz() }))
  )));
  assert.match(schreibend.content, /note-mode-switch/);
  assert.match(schreibend.content, /note-modal-save/);
  assert.match(schreibend.content, /note-modal-delete/);
});

// -------------------------------------------------------------------------
// Kontakte
// -------------------------------------------------------------------------

const kontakt = (over = {}) => ({
  id: 4, name: 'Dr. Meier', category: 'misc', phone: '+4930123456',
  email: 'praxis@example.org', address: 'Hauptstr. 1', family_user_id: null,
  ...over,
});

/**
 * KONTAKT-ZEILENMENUE NACH KANON (Re-Kritik 2026-09-28, A5 P2-5 im P1 "Sam
 * erreicht ... nicht"). Das Menue war ein Eigenbau: `role="menu"` ohne
 * `aria-haspopup`/`aria-expanded` am Ausloeser und ohne Pfeiltasten - Sam
 * hoerte "Menue", und nichts davon hielt. Der Kanon-Baustein
 * (utils/popover-menu.js) bringt Semantik UND Bedienung mit; hier wird
 * gemessen, dass die Zeile ihn nimmt, und dass die lesenden Eintraege als
 * Aktionen weiter an ihrem Ziel ankommen.
 */
test('Kontaktzeile: das Mehr-Menue ist der Kanon-Baustein mit Menue-Semantik', () => {
  withAccess({ contacts: 'write' }, () => {
    const html = contacts.renderContactItem(kontakt());
    assert.match(html, /popovertarget="[^"]+" aria-haspopup="menu" aria-expanded="false"/,
      'der Ausloeser sagt, dass er ein Menue oeffnet, und ob es offen ist');
    assert.match(html, /class="popover-menu" id="[^"]+" popover role="menu"/,
      'das Panel ist das geteilte popover-menu (Pfeiltasten, Fokus, aria-expanded aus popover-menu.js)');
    for (const action of ['contact-email', 'contact-maps', 'contact-export', 'delete']) {
      assert.match(html, new RegExp(`class="popover-menu__item[^"]*"\\s+data-action="${action}" data-id="4"`),
        `Eintrag ${action} ist ein Kanon-Eintrag`);
    }
    assert.doesNotMatch(html, /contact-more-menu__panel|contact-menu-item/, 'kein Eigenbau mehr daneben');
  });
});

test('Kontaktzeile: die lesenden Menue-Eintraege kommen an ihrem Ziel an', () => {
  const opened = [];
  const savedOpen = globalThis.window?.open;
  const savedLocation = globalThis.window?.location;
  globalThis.window = globalThis.window ?? {};
  globalThis.window.open = (...args) => { opened.push(args); return null; };
  const loc = { href: '' };
  globalThis.window.location = loc;
  try {
    const c = kontakt();
    contacts.runContactMenuAction('contact-email', c);
    assert.equal(loc.href, 'mailto:praxis@example.org');
    contacts.runContactMenuAction('contact-maps', c);
    assert.deepEqual(opened.at(-1), ['https://www.openstreetmap.org/search?query=Hauptstr.%201', '_blank', 'noopener']);
    contacts.runContactMenuAction('contact-export', c);
    assert.deepEqual(opened.at(-1), ['/api/v1/contacts/4/vcard', '_blank', 'noopener']);
    assert.equal(contacts.runContactMenuAction('delete', c), false, 'Loeschen bleibt beim Schreib-Zweig der Liste');
  } finally {
    globalThis.window.open = savedOpen;
    globalThis.window.location = savedLocation;
  }
});

test('Kontaktzeile mit Schreibrecht: das Menue fuehrt auch Loeschen', () => {
  withAccess({ contacts: 'write' }, () => {
    const html = contacts.renderContactItem(kontakt());
    assert.match(html, /data-action="delete"/);
  });
});

// Die E-Mail-Adressen eines verknuepften Kontakts fuehren zu seinem Konto
// (Passwort-Reset, SSO); aendern duerfen sie nur die Person selbst und ein
// Admin, der Server weist alle anderen mit 403 ab (contact-identity.js). Das
// Formular zeigt sie den anderen deshalb nur-lesen, mit Hinweis statt
// Hinzufuegen-Knopf. Gemessen am ERZEUGTEN Markup, immer im Paar.
function emailGruppe(html) {
  const start = html.indexOf('data-mv-group="email"');
  assert.ok(start > 0, 'E-Mail-Gruppe fehlt im Formular');
  // Bis zum ersten Feld dahinter (Adresse, im aufklappbaren Abschnitt).
  const ende = html.indexOf('id="cm-address"', start);
  assert.ok(ende > start, 'Adressfeld hinter der E-Mail-Gruppe fehlt');
  return html.slice(start, ende);
}

test('Kontaktformular: E-Mail am verknuepften Kontakt eines ANDEREN ist nur-lesen', () => {
  const vorher = contacts.state.user;
  try {
    const linked = { ...kontakt({ family_user_id: 7 }), emails: [{ label: 'work', value: 'a@example.org' }], phones: [] };
    contacts.state.user = { id: 9, role: 'member' };
    const fremd = contacts.buildContactForm({ mode: 'edit', contact: linked }).content;
    const gruppe = emailGruppe(fremd);
    assert.match(gruppe, /type="email"[^>]*readonly/);
    assert.match(gruppe, /id="cm-email-locked"/);
    assert.doesNotMatch(gruppe, /data-mv-add/);
    assert.doesNotMatch(gruppe, /data-mv-remove/);
    // Die uebrigen Felder bleiben offen.
    assert.doesNotMatch(fremd.slice(0, fremd.indexOf('data-mv-group="email"')), /readonly/);

    for (const user of [{ id: 7, role: 'member' }, { id: 1, role: 'admin' }]) {
      contacts.state.user = user;
      const offen = emailGruppe(contacts.buildContactForm({ mode: 'edit', contact: linked }).content);
      assert.doesNotMatch(offen, /readonly/, `gesperrt fuer ${JSON.stringify(user)}`);
      assert.match(offen, /data-mv-add/);
    }
    contacts.state.user = { id: 9, role: 'member' };
    const unverknuepft = emailGruppe(contacts.buildContactForm({ mode: 'edit', contact: { ...linked, family_user_id: null } }).content);
    assert.doesNotMatch(unverknuepft, /readonly/);
  } finally {
    contacts.state.user = vorher;
  }
});

test('Kontaktzeile mit `contacts: read`: Loeschen weg, jeder Leseweg bleibt', () => {
  withAccess({ contacts: 'read' }, () => {
    const html = contacts.renderContactItem(kontakt());
    assert.doesNotMatch(html, /data-action="delete"/,
      'der eine schreibende Eintrag des Menues');

    // Die vier lesenden bleiben - und das Menue ist damit nie leer, es entsteht
    // hier also kein Knopf ohne Inhalt (der Befund aus waste.js).
    assert.match(html, /href="tel:/);
    // Seit dem Kanon-Menue (Re-Kritik 2026-09-28) sind Mail, Karte und Export
    // Menue-Aktionen statt Links; wohin sie fuehren, misst der Test
    // "die lesenden Menue-Eintraege kommen an ihrem Ziel an".
    assert.match(html, /data-action="contact-email"/);
    assert.match(html, /data-action="contact-maps"/);
    assert.match(html, /data-action="contact-export"/);
    assert.match(html, /class="popover-menu"/);
    // Und die Zeile fuehrt weiter in die Detailansicht, mit ihrem Inhalt.
    assert.match(html, /data-open="4"/);
    assert.match(html, /Dr\. Meier/);
  });
});

test('Kontakte-Kopf mit `contacts: read`: Kategorien, Auswahl und Import fallen weg', () => {
  // Seit der Kopfregel mobil (2026-09-26) stehen die drei als Eintraege im
  // EINEN Werkzeugmenue - geprueft wird dieselbe Frage an ihrem neuen Ort.
  withAccess({ contacts: 'write' }, () => {
    const html = contacts.toolbarActionsHtml();
    assert.match(html, /data-action="manage-categories"/);
    assert.match(html, /data-action="select-mode"/);
    assert.match(html, /data-action="import-vcard"/);
    assert.match(html, /id="contacts-import-input"/);
    assert.match(html, /page-tools-btn/);
  });
  withAccess({ contacts: 'read' }, () => {
    const html = contacts.toolbarActionsHtml();
    assert.doesNotMatch(html, /manage-categories/,
      'der Kategorie-Verwalter legt an und loescht - keine CSS-Regel hat ihn je erfasst');
    assert.doesNotMatch(html, /select-mode|contacts-select-cancel/,
      'der Auswahlmodus hat als einzige Aktion „Loeschen"');
    assert.doesNotMatch(html, /import-vcard|contacts-import-input/,
      'und der Import legt Kontakte an');
    assert.doesNotMatch(html, /page-tools-btn/,
      'ein Werkzeugmenue ohne Eintraege waere ein Knopf, der ins Leere oeffnet');
    // Der Slot bleibt LEER: die Primaeraktion ist seit der Re-Critique
    // 2026-09-27 (D3) der FAB, den die Shell andockt und den
    // `html[data-module-readonly]` ausblendet (layout.css). Die Zeilen darueber
    // pruefen damit eine leere Zeichenkette - genau das ist die Zusage.
    assert.equal(html.trim(), '', 'bei Nur-lesen steht im Kopf-Slot nichts, das schreibt');
  });
});

test('Leere Kontaktliste mit `contacts: read`: kein Anlegen-CTA, Filter-Reset bleibt', () => {
  withAccess({ contacts: 'write' }, () => {
    assert.match(contacts.contactsEmptyStateHtml(false), /data-action="empty-cta"/);
  });
  withAccess({ contacts: 'read' }, () => {
    const leer = contacts.contactsEmptyStateHtml(false);
    assert.doesNotMatch(leer, /empty-cta/);
    assert.match(leer, /contacts\.emptyTitle/);
    // „Zuruecksetzen" ist ein Filter, kein Schreibweg - und bleibt.
    assert.match(contacts.contactsEmptyStateHtml(true), /data-action="reset-filters"/);
  });
});

/** Faengt die Optionen ab, mit denen eine Seite `openDetailView` ruft. */
function detailOptionen(fn) {
  const vorher = globalThis.__openDetailView;
  let letzte = null;
  globalThis.__openDetailView = (opts) => { letzte = opts; };
  try { fn(); } finally {
    if (vorher === undefined) delete globalThis.__openDetailView;
    else globalThis.__openDetailView = vorher;
  }
  return letzte;
}

test('Kontakt-Detailansicht mit `contacts: read`: kein Bearbeiten, kein Loeschen, alles Lesen', () => {
  const ids = (opts) => opts.actions.map((a) => a.id);

  const schreibend = withAccess({ contacts: 'write' }, () => (
    detailOptionen(() => contacts.openContactDetail(kontakt()))
  ));
  assert.ok(schreibend.edit, 'mit Schreibrecht traegt die Ansicht „Bearbeiten"');
  // R17 (E7): Bearbeiten sitzt im Blatt an EINER Stelle - als Primaerknopf am
  // Ende des Fusses, wie im Termin und im Inventar; bis dahin stand es im
  // Kontakt als Kopfaktion.
  assert.equal(schreibend.edit.primary, true, 'Bearbeiten ist im Blatt die Hauptaktion unten');
  assert.ok(ids(schreibend).includes('contact-detail-delete'));

  const lesend = withAccess({ contacts: 'read' }, () => (
    detailOptionen(() => contacts.openContactDetail(kontakt()))
  ));
  assert.ok(!lesend.edit,
    '`openDetailView` setzt die Kopf-Aktion genau dann, wenn dieser Schluessel steht');
  assert.ok(!ids(lesend).includes('contact-detail-delete'));
  // Und die Ansicht ist wirklich eine: Export bleibt, die Abschnitte stehen.
  assert.ok(ids(lesend).includes('contact-detail-export'));
  assert.equal(lesend.title, 'Dr. Meier');
  assert.ok(lesend.sections.length > 0);
});

// -------------------------------------------------------------------------
// Der Import-Toast der Kontakte und sein Sprung in ein FREMDES Modul (#1348)
//
// Nach einem vCard-Import mit Geburtstagen bot der Toast „Zu Geburtstagen" an.
// Das Ziel gehoert `calendar`, nicht `contacts`: bei `calendar: read` ging die
// Seite auf und der Import-Dialog nicht, bei `calendar: none` warf der Router
// auf `/`, und das Flag blieb in der sessionStorage liegen. Gemessen wird am
// wirklichen Aufruf von `showToast` und am wirklichen Flag - die Zusage ist
// das AUSBLEIBEN einer Handlung, und das sieht kein Textguard.
// -------------------------------------------------------------------------

/** Setzt Stellen an `window.yuvomi` fuer die Dauer von `fn` und raeumt sie wieder ab. */
function mitYuvomi(felder, fn) {
  const yuvomi = globalThis.window.yuvomi;
  const vorher = Object.fromEntries(Object.keys(felder).map((k) => [k, yuvomi[k]]));
  Object.assign(yuvomi, felder);
  try { return fn(); } finally {
    for (const [k, v] of Object.entries(vorher)) {
      if (v === undefined) delete yuvomi[k];
      else yuvomi[k] = v;
    }
  }
}

/** Die Argumente des EINEN Toasts, den `fn` zeigt. */
function toastVon(fn) {
  const toasts = [];
  mitYuvomi({
    showToast: (message, type, duration, action) => toasts.push({ message, type, duration, action }),
  }, fn);
  assert.equal(toasts.length, 1, 'genau ein Toast - sonst misst der Test den falschen');
  return toasts[0];
}

const importErgebnis = (over = {}) => ({
  imported: 2, withBirthday: 1, failedList: [], lastName: 'Oma Erna', lastError: null, ...over,
});

test('Import-Toast: „Zu Geburtstagen" nur, wenn das Ziel `calendar` beschreibbar ist', () => {
  const bei = (calendar, over) => withAccess({ contacts: 'write', calendar }, () => (
    toastVon(() => contacts.showImportResult(importErgebnis(over)))
  ));

  const schreibend = bei('write');
  assert.equal(schreibend.action?.label, 'contacts.importOpenBirthdays',
    'mit Schreibrecht auf den Kalender fuehrt der Toast in den Import');
  assert.equal(schreibend.duration, 6000, 'ein Toast mit Aktion bleibt laenger stehen');

  for (const calendar of ['read', 'none']) {
    const toast = bei(calendar);
    assert.equal(toast.action, null,
      `calendar: ${calendar} - /birthdays gehoert dem Kalender, contacts: write sagt darueber nichts`);
    assert.equal(toast.duration, 3000);
    // Die Meldung selbst bleibt vollstaendig - die Zahl ist eine Auskunft ueber
    // den Import, keine Handlung.
    assert.match(toast.message, /contacts\.importDetailBirthday/);
    assert.equal(toast.type, 'success');
  }

  // Der Wiederholen-Knopf fuer fehlgeschlagene Kontakte schreibt in `contacts`
  // und bleibt deshalb, wie der Kalender auch steht.
  const mitFehler = bei('none', { failedList: [{ name: 'X' }] });
  assert.equal(mitFehler.action?.label, 'contacts.importRetry');
});

test('Import-Toast: ein abgeschaltetes Geburtstagsmodul ist dieselbe Sackgasse', () => {
  // Der Router leitet ein haushaltweit abgeschaltetes Modul genauso auf `/`
  // um wie ein gesperrtes - das Flag bliebe liegen wie bei `calendar: none`.
  const toast = withAccess({ contacts: 'write', calendar: 'write' }, () => (
    mitYuvomi({ isModuleDisabled: (modul) => modul === 'birthdays' }, () => (
      toastVon(() => contacts.showImportResult(importErgebnis()))
    ))
  ));
  assert.equal(toast.action, null);
});

test('Der Sprung selbst: ohne `calendar: write` kein Flag und keine Navigation', () => {
  // Die zweite Linie hinter dem Toast: eine Aktion, die vor einem
  // Rechtewechsel angeboten wurde, lebt sechs Sekunden weiter.
  const flags = new Map();
  const vorher = Object.getOwnPropertyDescriptor(globalThis, 'sessionStorage');
  Object.defineProperty(globalThis, 'sessionStorage', {
    configurable: true,
    writable: true,
    value: {
      getItem: (k) => (flags.has(k) ? flags.get(k) : null),
      setItem: (k, v) => { flags.set(k, String(v)); },
      removeItem: (k) => { flags.delete(k); },
    },
  });
  const wege = [];
  try {
    mitYuvomi({ navigate: (pfad) => wege.push(pfad) }, () => {
      for (const calendar of ['none', 'read']) {
        withAccess({ contacts: 'write', calendar }, () => contacts.openBirthdayImport());
        assert.equal(flags.size, 0,
          `calendar: ${calendar} - ein Flag, dessen Seite es nie liest, bliebe liegen und oeffnete den Dialog beim naechsten Besuch`);
        assert.deepEqual(wege, [], `calendar: ${calendar} - und keine Fahrt in eine Umleitung`);
      }
      // Gegenfall: mit Schreibrecht setzt der Sprung sein Flag und faehrt los -
      // sonst waeren die zwei Zeilen darueber auch bei einem toten Sprung gruen.
      withAccess({ contacts: 'write', calendar: 'write' }, () => contacts.openBirthdayImport());
      assert.equal(flags.get('yuvomi:birthdays:autoImport'), '1');
      assert.deepEqual(wege, ['/birthdays']);
    });
  } finally {
    if (vorher) Object.defineProperty(globalThis, 'sessionStorage', vorher);
    else delete globalThis.sessionStorage;
  }
});

// -------------------------------------------------------------------------
// Geburtstage - die Seite, deren Modul `calendar` heisst
// -------------------------------------------------------------------------

const geburtstag = (over = {}) => ({
  id: 9, name: 'Oma Erna', birth_date: '1950-04-03', next_birthday: '2027-04-03',
  next_age: 77, days_until: 12, notes: 'Mag Kuchen', next_name_day: null,
  name_day_days_until: null, photo_data: null, family_user_id: null, ...over,
});

test('Geburtstage fragen `calendar`, nicht `birthdays` - sonst faellt die Frage fail-open aus', () => {
  withAccess({ calendar: 'read' }, () => {
    assert.equal(birthdays.readOnly(), true,
      'server/scopes.js fuehrt calendar, reminders und birthdays unter EINEM Schluessel');
  });
  withAccess({ birthdays: 'read' }, () => {
    assert.equal(birthdays.readOnly(), false,
      'ein Modul dieses Namens gibt es in den Rechten nicht - die Antwort waere still `write`');
  });
  withAccess({ calendar: 'write' }, () => {
    assert.equal(birthdays.readOnly(), false);
  });
});

test('Geburtstagszeile mit Schreibrecht: zwei Knoepfe und zwei Wischflaechen', () => {
  withAccess({ calendar: 'write' }, () => {
    const html = birthdays.birthdayItemHtml(geburtstag());
    assert.match(html, /data-action="edit"/);
    assert.match(html, /data-action="delete"/);
    assert.match(html, /swipe-reveal--edit/);
    assert.match(html, /swipe-reveal--delete/);
    assert.doesNotMatch(html, /swipe-row--static/, 'mit Geste bleibt der Wisch-Chevron');
  });
});

test('Geburtstagszeile mit `calendar: read`: beide Handlungen weg, die Auskunft bleibt', () => {
  withAccess({ calendar: 'read' }, () => {
    const html = birthdays.birthdayItemHtml(geburtstag());
    assert.doesNotMatch(html, /data-action="edit"/);
    assert.doesNotMatch(html, /data-action="delete"/);
    assert.doesNotMatch(html, /swipe-reveal/,
      'eine Reveal-Flaeche ohne Geste kuendigt eine Bedienung an, die es nicht gibt');
    // Ebenso der Wisch-Chevron (`.swipe-row::after`, Muster aus #1426): auf
    // Touch stand der Pfeil an einer Zeile, die sich nicht wischen laesst.
    assert.match(html, /class="swipe-row swipe-row--static"/, 'ohne Geste auch kein Wisch-Chevron');
    assert.doesNotMatch(html, /row-actions/);

    // Nichts davon war ein Zustand, der ohne die Knoepfe unlesbar wuerde - die
    // Zeile traegt ihre Auskunft selbst, und sie ist wirklich gerendert.
    assert.match(html, /Oma Erna/);
    assert.match(html, /birthdays\.inDays/);
    assert.match(html, /birthdays\.turnsAge/);
    assert.match(html, /Mag Kuchen/);
    assert.match(html, /data-id="9"/);
  });
});

test('Wischgeste der Geburtstage: bei `calendar: read` wird keine Seite verdrahtet', () => {
  // GEMESSEN AN DEN VERDRAHTETEN SEITEN. Die Geste hat kein Markup, das sich
  // pruefen liesse (dieselbe Begruendung wie bei `wireSwipeGestures` in
  // tasks.js). Anders als dort bleibt hier keine Lese-Seite uebrig: beide
  // Richtungen schreiben.
  const host = { querySelectorAll: () => [], querySelector: () => null, addEventListener() {} };
  // DER NUDGE-HINWEIS HAENGT AN DERSELBEN BEDINGUNG und laeuft im
  // Schreibrecht-Fall deshalb wirklich mit - er braucht `window.innerWidth` und
  // `location`, die es in Node nicht gibt (nachgemessen: „location is not
  // defined"). Eine Breite jenseits von 1024px laesst ihn in seiner ersten
  // Zeile zurueckkehren; gemessen wird hier die Verdrahtung, nicht der Hinweis.
  const vorherBreite = globalThis.window.innerWidth;
  globalThis.window.innerWidth = 1280;
  try {
    const schreibend = withAccess({ calendar: 'write' }, () => birthdays.wireBirthdaySwipe(host));
    assert.ok(schreibend.leading, 'mit Schreibrecht oeffnet der Wisch nach vorn das Formular');
    assert.ok(schreibend.trailing, 'und der nach hinten loescht');

    const lesend = withAccess({ calendar: 'read' }, () => birthdays.wireBirthdaySwipe(host));
    assert.equal(lesend.leading, null);
    assert.equal(lesend.trailing, null);
  } finally {
    if (vorherBreite === undefined) delete globalThis.window.innerWidth;
    else globalThis.window.innerWidth = vorherBreite;
  }
});

test('Import-Knopf der Geburtstage: er braucht BEIDE Rechte', () => {
  // Er schreibt Geburtstage (`calendar`) und liest Kontakte (`contacts`) -
  // server/routes/birthdays.js prueft beides, also fragt der Knopf beides.
  // Seit Runde 5 (2026-09-26) steht der Import als Eintrag im EINEN
  // Werkzeugmenue des Kopfs statt als Textknopf daneben; die Rechtefrage ist
  // dieselbe, und ohne Import gibt es kein Menue.
  withAccess({ calendar: 'write', contacts: 'read' }, () => {
    assert.match(birthdays.importActionHtml(), /data-action="import-contacts"/,
      'Kontakte LESEN reicht fuer die Quelle');
  });
  withAccess({ calendar: 'write', contacts: 'none' }, () => {
    assert.equal(birthdays.importActionHtml(), '',
      'ohne Sicht auf Kontakte hat der Import keine Quelle (#1241)');
  });
  withAccess({ calendar: 'read', contacts: 'write' }, () => {
    assert.equal(birthdays.importActionHtml(), '',
      'und ohne Schreibrecht auf das eigene Modul kein Ziel - das war der halbe Befund dieser Seite');
  });
});

// -------------------------------------------------------------------------
// Und die Darstellung der neuen Nadel - ein Guard, weil CSS still versagt
//
// Das Zeichen sieht aus wie der Knopf, den es ersetzt; was es davon
// unterscheidet, steht ausschliesslich im Stylesheet. Geprueft wird mit
// demselben Kaskadenloeser wie oben bei den Aufgaben, also das, was am Ende
// WIRKLICH gilt - nicht der Text der Regel.
// -------------------------------------------------------------------------

const NOTES_CSS = readFileSync(new URL('../public/styles/notes.css', import.meta.url), 'utf8');

test('die Nadel als Zeichen traegt keinen Zeiger, keine Trefferflaeche und keine Hover-Quittung', () => {
  const zeichen = ['note-card__pin', 'note-card__pin--static'];
  const knopf = ['note-card__pin'];

  assert.equal(effektiverWert(NOTES_CSS, zeichen, 'cursor'), 'default',
    'ein Zeigefinger verspricht eine Handlung');
  assert.equal(effektiverWert(NOTES_CSS, knopf, 'cursor'), 'pointer',
    'der bedienbare Knopf behaelt ihn - sonst maesse die Zeile darueber nichts');

  assert.equal(effektiverWert(NOTES_CSS, zeichen, 'content', '::before'), 'none',
    'die Trefferflaeche des ::before gehoert zum Bedienelement, nicht zum Zeichen');
  assert.notEqual(effektiverWert(NOTES_CSS, knopf, 'content', '::before'), 'none');

  assert.equal(effektiverWert(NOTES_CSS, zeichen, 'background', ':hover'), null,
    'keine Hover-Regel darf das Zeichen treffen - sie nimmt es per :not() aus, statt dagegen anzuschreiben');
  assert.match(effektiverWert(NOTES_CSS, knopf, 'background', ':hover') ?? '', /note-action-bg-hover/,
    'und der Knopf reagiert weiter');
});

test('und das Zeichen faengt die Klicks nicht ab, mit denen die Karte aufgeht', () => {
  // DER KASKADENLOESER OBEN SIEHT DIESE REGELN NICHT: sie tragen einen
  // Kombinator (`.note-card--pinned .note-card__pin`), und er ueberspringt
  // alles, was nicht eine einzelne Klassenkette ist. Gemessen wird deshalb
  // direkt, was hier entscheidet - Spezifitaet gleich, also Quellreihenfolge.
  let knopfRegel = -1;
  let zeichenRegel = -1;
  let nummer = 0;
  let wert = null;
  for (const { selector, body, at } of eachRule(NOTES_CSS)) {
    nummer += 1;
    if (at.length) continue;
    for (const teil of selector.split(',')) {
      const sel = teil.trim();
      if (sel === '.note-card--pinned .note-card__pin') knopfRegel = nummer;
      if (sel === '.note-card--pinned .note-card__pin--static') {
        zeichenRegel = nummer;
        wert = /(?:^|;)\s*pointer-events\s*:([^;]*)/.exec(body)?.[1].trim() ?? null;
      }
    }
  }
  assert.ok(knopfRegel > 0, 'die Regel, die hier ueberschrieben werden muss, steht noch da');
  assert.ok(zeichenRegel > knopfRegel,
    'gleiche Spezifitaet: die Ausnahme muss DANACH stehen, sonst gilt pointer-events: auto weiter');
  assert.equal(wert, 'none',
    'sonst faengt das Zeichen den Klick ab, mit dem die Karte sich oeffnet');
});

test('Leere Geburtstagsliste mit `calendar: read`: kein Anlegen-CTA', () => {
  const vorher = birthdays.state.query;
  birthdays.state.query = '';
  try {
    withAccess({ calendar: 'write' }, () => {
      assert.match(birthdays.emptyStateHtml(), /id="birthdays-empty-cta"/);
    });
    withAccess({ calendar: 'read' }, () => {
      const html = birthdays.emptyStateHtml();
      assert.doesNotMatch(html, /birthdays-empty-cta/);
      assert.match(html, /birthdays\.emptyTitle/);
    });
  } finally { birthdays.state.query = vorher; }
});

// -------------------------------------------------------------------------
// Die Notiz eines Geburtstags bei `calendar: read` (#1348)
//
// birthdays.css blendet `.birthday-item__notes` unter 560px Traegerbreite aus,
// mit Namenstag schon unter 840px - „wer die Notiz sucht, oeffnet den
// Eintrag". Seit #1311 oeffnete bei `read` aber nichts mehr: auf dem Telefon
// war die Notiz unerreichbar. Die Bauart ist die des Zettels (#1311): der
// Editor-Einstieg oeffnet bei `read` eine eigene Leseansicht mit allem, was
// der Editor zeigt, und ohne ein einziges Bedienelement.
// -------------------------------------------------------------------------

/** Ein Klick in die Liste, wie `closest()` ihn sieht. */
function klickAuf(treffer) {
  return { target: { closest: (sel) => treffer[sel] ?? null } };
}

/** `state.birthdays` fuer die Dauer von `fn` belegen. */
function mitGeburtstagen(liste, fn) {
  const vorher = birthdays.state.birthdays;
  birthdays.state.birthdays = liste;
  try { return fn(); } finally { birthdays.state.birthdays = vorher; }
}

test('Geburtstagszeile: die Textspalte ist fuer Lesende UND Schreibende der Weg zum Eintrag (H8)', () => {
  withAccess({ calendar: 'write' }, () => {
    const html = birthdays.birthdayItemHtml(geburtstag());
    // Bis R8 blieb die Spalte mit Schreibrecht ein `div`: ein Tipp auf die
    // Zeile tat nichts, waehrend der Wisch-Chevron Navigation versprach.
    // `data-md-focus` (R10): im Split landet der Pfeiltasten-Fokus auf diesem
    // Knopf - weitere Attribute aendern nichts an der Regel.
    assert.match(html, /<button type="button" class="list-row__main list-row__main--interactive" data-open="9"[^>]*>/,
      'mit Schreibrecht ist die Hauptspalte ein Knopf, der den Editor oeffnet');
    assert.doesNotMatch(html, /<div class="list-row__main">/);
    assert.doesNotMatch(html, /swipe-row--static/, 'Schreibende behalten die Geste und ihren Chevron');
  });
  withAccess({ calendar: 'read' }, () => {
    assert.match(birthdays.birthdayItemHtml(geburtstag()), /class="swipe-row swipe-row--static"/,
      'Nur-Lesende sehen keinen Chevron, der eine Geste verspricht');
  });
  withAccess({ calendar: 'read' }, () => {
    const html = birthdays.birthdayItemHtml(geburtstag());
    const knopf = /<button type="button" class="list-row__main list-row__main--interactive" data-open="9"[^>]*>([\s\S]*?)<\/button>/.exec(html);
    assert.ok(knopf, 'ohne diesen Knopf oeffnet bei `read` gar nichts - und die Notiz ist auf dem Telefon ausgeblendet');
    assert.match(knopf[1], /Oma Erna/, 'der Knopf traegt die Zeile selbst, nicht eine leere Flaeche');
    assert.doesNotMatch(knopf[1], /<div/, 'in einem `button` steht nur Phrasing-Inhalt');
  });
});

test('R17 E7: ein Tipp auf die Geburtstagszeile oeffnet das Leseblatt, Bearbeiten steht primaer am Ende', async () => {
  // Bis R17 ging der Tipp unter der Schwelle direkt in den Editor (H8) - als
  // einzige Liste neben Kalender und Kontakten, die ein Leseblatt oeffnen.
  const eintrag = geburtstag();
  let blatt = null;
  const editor = mitGeburtstagen([eintrag], () => withAccess({ calendar: 'write' }, () => modalOptionen(() => {
    blatt = detailOptionen(() => birthdays.onListClick(klickAuf({ '[data-open]': { dataset: { open: '9' } } })));
  })));
  assert.ok(blatt, 'der Tipp oeffnet die geteilte Leseansicht (openDetailView)');
  assert.equal(editor, null, 'und NICHT den Editor - kein Formular, keine Tastatur');
  assert.equal(blatt.title, 'Oma Erna');
  assert.equal(blatt.pane, undefined, 'als Blatt, nicht in der Spalte');
  assert.ok(blatt.sections.some((row) => row.value === 'Mag Kuchen'), 'die Notiz, die die Zeile am Telefon ausblendet');
  assert.deepEqual(blatt.actions.map((a) => [a.id, a.variant, a.align ?? 'end']), [
    ['birthday-detail-delete', 'danger-ghost', 'start'],
    ['detail-view-edit', 'primary', 'end'],
  ], 'Loeschen zurueckgenommen am Anfang, Bearbeiten als Primaerknopf am Ende - wie im Termin');

  // Bearbeiten schliesst das Blatt und oeffnet den Editor mit dem Bestand.
  const geschlossen = [];
  let offen = null;
  const vorher = globalThis.__openModal;
  globalThis.__openModal = (opts) => { offen = opts; };
  try {
    await blatt.actions[1].onClick({ close: async (o) => { geschlossen.push(o); } });
  } finally {
    if (vorher === undefined) delete globalThis.__openModal;
    else globalThis.__openModal = vorher;
  }
  assert.deepEqual(geschlossen, [{ force: true }], 'erst geht das Blatt zu');
  assert.ok(offen, 'dann oeffnet der Editor');
  assert.match(offen.content, /id="bd-save"/);
  assert.match(offen.content, /id="bd-name"[^>]*value="Oma Erna"/, 'mit dem Bestand vorbelegt');
});
test('Ein Tipp bei `calendar: read` oeffnet die Leseansicht, und sie zeigt, was der Editor zeigt', () => {
  const eintrag = geburtstag({ name_day: '05-12', reminder_offset: '2880' });
  const offen = mitGeburtstagen([eintrag], () => withAccess({ calendar: 'read' }, () => (
    modalOptionen(() => birthdays.onListClick(klickAuf({ '[data-open]': { dataset: { open: '9' } } })))
  )));
  assert.ok(offen, 'der Tipp oeffnet einen Dialog - Lesen ist erlaubt');
  assert.equal(offen.title, 'Oma Erna');
  assert.match(offen.content, /data-view="read"/);

  // Was der Editor zeigt: Bild, Geburtsdatum, Namenstag, Notiz, Erinnerung.
  assert.match(offen.content, /Mag Kuchen/, 'die Notiz - der Anlass dieses Tickets');
  assert.match(offen.content, /birthdays\.notesLabel/);
  assert.match(offen.content, /birthdays\.birthDateLabel/);
  assert.match(offen.content, /1950/, 'das Geburtsdatum mit seinem Jahr, nicht der naechste Termin');
  assert.match(offen.content, /birthdays\.nameDay</);
  assert.match(offen.content, /12\. Mai/, 'der Namenstag als Tag und Monat, wie im Editor - ohne Jahr');
  assert.match(offen.content, /reminders\.offset2days/, 'die Erinnerung heisst wie im Editor');
  assert.match(offen.content, /birthday-avatar-editor--static/);
  assert.match(offen.content, /OE/, 'das Bild in der Fassung des Editors, hier die Initialen');

  // Und kein einziges Bedienelement: jedes Stueck des Editors schreibt.
  assert.doesNotMatch(offen.content, /<(input|textarea|select|button)\b/);
  assert.doesNotMatch(offen.content, /yuvomi-datepicker|bd-save|bd-delete|bd-photo/);
});

test('Leseansicht: eine eigene Erinnerung steht als Dauer da, eine fehlende als „am Tag"', () => {
  const inhalt = (over) => withAccess({ calendar: 'read' }, () => (
    modalOptionen(() => birthdays.openBirthdayModal({ mode: 'edit', birthday: geburtstag(over) }))
  )).content;

  const eigen = inhalt({ reminder_offset: 'custom', reminder_custom_amount: 3, reminder_custom_unit: 'weeks' });
  assert.match(eigen, /reminders\.offsetLabel/);
  assert.match(eigen, /3 Wochen/, 'Anzahl und Einheit des Editors, mit der Pluralform aus Intl');
  assert.doesNotMatch(eigen, /reminders\.offsetCustom/,
    '„Benutzerdefiniert…" ist ein Auswahl-Label, keine Auskunft');

  assert.match(inhalt({ reminder_offset: '' }), /reminders\.offsetNone/,
    '„Keine" ist ein Zustand, den der Editor zeigt');

  // Aus den Kontakten uebernommene Geburtstage tragen `null`, und der Server
  // erinnert dann am Tag selbst. Bis #1363 schwieg die Leseansicht hier, weil
  // der Editor „1 Tag vorher" behauptete; seit er dem Server folgt, sagt sie
  // dasselbe wie er.
  const ohne = inhalt({ reminder_offset: null });
  assert.match(ohne, /reminders\.offsetLabel/, 'die Zeile steht da');
  assert.equal(leseErinnerung(ohne), 'birthdays.reminderOnDay', 'und nennt den Tag selbst');
  assert.doesNotMatch(ohne, /reminders\.offsetAtTime/, 'nicht mit dem Startzeitpunkt des Kalenders');
  assert.doesNotMatch(ohne, /reminders\.offset1day/, 'nicht die fruehere Behauptung des Editors');
  assert.match(ohne, /Mag Kuchen/, 'der Rest steht trotzdem da');

  // Die Notiz ist Nutzertext und geht durch esc().
  const roh = inhalt({ notes: '<img src=x onerror=alert(1)>' });
  assert.doesNotMatch(roh, /<img src=x/);
  assert.match(roh, /&lt;img src=x/);
});

// -------------------------------------------------------------------------
// Ein Geburtstag ohne gespeicherte Erinnerung (#1363)
//
// Vier Wege legen einen Geburtstag mit `reminder_offset = NULL` an, und der
// Server erinnert dann am Tag selbst (`getOffsetMinutes()` rechnet `null` als
// 0). Der Editor zeigte „1 Tag vorher" und schrieb es beim naechsten Speichern
// fest. Entschieden: der Editor folgt dem Server, und er schreibt eine
// Erinnerung nur, wenn jemand eine waehlt.
// -------------------------------------------------------------------------

/** Der Wert der Erinnerungszeile in der Leseansicht, oder null ohne Zeile. */
function leseErinnerung(html) {
  const treffer = /<span class="detail-row__label">reminders\.offsetLabel<\/span>\s*<span class="detail-row__value">([^<]*)<\/span>/.exec(html);
  return treffer ? treffer[1] : null;
}

/**
 * Die Optionen einer Auswahl aus dem gerenderten Markup. `gewaehlt` ist, was
 * ein Browser zeigt: die Option mit `selected`, ohne eine solche die erste.
 */
function auswahlAusMarkup(html, id) {
  const block = new RegExp(`<select[^>]*id="${id}"[^>]*>([\\s\\S]*?)</select>`).exec(html);
  assert.ok(block, `keine Auswahl #${id} im Markup`);
  const optionen = [...block[1].matchAll(/<option value="([^"]*)"([^>]*)>([^<]*)<\/option>/g)]
    .map(([, value, attrs, label]) => ({ value, selected: /\bselected\b/.test(attrs), label }));
  assert.ok(optionen.length, `#${id} ohne Optionen - der Leser passt nicht mehr zum Markup`);
  return { optionen, gewaehlt: optionen.find((o) => o.selected) ?? optionen[0] };
}

/** Ein Element, wie `onSave(panel)` es anfasst: Wert, Handler, sonst nichts. */
function editorElement(felder = {}) {
  const handler = {};
  return {
    value: '', hidden: false, disabled: false, ...felder,
    handlers: handler,
    addEventListener(type, fn) { (handler[type] ??= []).push(fn); },
    async feuern(type) { for (const fn of handler[type] ?? []) await fn({ target: this }); },
    click() {}, focus() {}, replaceChildren() {}, insertAdjacentHTML() {},
  };
}

/**
 * Eine Auswahl mit Browser-Verhalten: sie steht, wo das Markup sie hinstellt,
 * und nimmt nur Werte an, fuer die es eine Option gibt - sonst steht sie wie
 * `select.value = 'x'` im Browser auf ''. Ohne das koennte ein Test eine
 * Vorgabe waehlen, die der Editor gar nicht anbietet.
 */
function editorAuswahl(html, id) {
  const { optionen, gewaehlt } = auswahlAusMarkup(html, id);
  let wert = gewaehlt.value;
  const el = editorElement();
  Object.defineProperty(el, 'value', {
    get: () => wert,
    set: (neu) => { wert = optionen.some((o) => o.value === String(neu)) ? String(neu) : ''; },
  });
  return el;
}

/**
 * Oeffnet den Editor mit Schreibrecht, verdrahtet ihn gegen eine Attrappe aus
 * seinem eigenen Markup, laesst `bedienen` daran drehen und klickt Speichern.
 * Zurueck kommt, was an den Server ging - durch JSON, wie in api.js: ein Feld
 * mit `undefined` kaeme dort gar nicht an.
 */
async function geburtstagSpeichern(eintrag, { mode = 'edit', bedienen = async () => {}, roh = false } = {}) {
  const optionen = withAccess({ calendar: 'write' }, () => modalOptionen(
    () => birthdays.openBirthdayModal({ mode, birthday: mode === 'edit' ? eintrag : null }),
  ));
  assert.ok(optionen, 'mit Schreibrecht geht der Editor auf');
  const html = optionen.content;
  const betrag = /id="bd-reminder-custom-amount"[^>]*value="([^"]*)"/.exec(html);
  assert.ok(betrag, 'das Anzahl-Feld der eigenen Angabe steht im Markup');
  const el = {
    '#bd-name': editorElement({ value: eintrag.name }),
    '#birthday-preview': editorElement(),
    '#bd-photo': editorElement(),
    '#bd-photo-edit': editorElement(),
    '#bd-remove-photo': editorElement(),
    '#bd-birth-date': editorElement({ value: eintrag.birth_date }),
    '#bd-notes': editorElement({ value: eintrag.notes ?? '' }),
    '#bd-name-day-month': editorElement(),
    '#bd-name-day-day': editorElement(),
    '#bd-name-day-clear': editorElement(),
    '#bd-reminder-offset': editorAuswahl(html, 'bd-reminder-offset'),
    '#bd-reminder-custom': editorElement(),
    '#bd-reminder-custom-amount': editorElement({ value: betrag[1] }),
    '#bd-reminder-custom-unit': editorAuswahl(html, 'bd-reminder-custom-unit'),
    '#bd-cancel': editorElement(),
    '#bd-delete': editorElement(),
    '#bd-save': editorElement(),
  };
  optionen.onSave({ querySelector: (sel) => el[sel] ?? null });
  await bedienen(el);

  const gesendet = [];
  const vorher = {
    api: globalThis.__apiStub,
    toast: globalThis.window.yuvomi?.showToast,
    liste: birthdays.state.birthdays,
  };
  const mitschreiben = (method) => async (path, body) => {
    gesendet.push({ method, path, body: JSON.parse(JSON.stringify(body)) });
    return { data: { id: 9 } };
  };
  globalThis.__apiStub = { get: async () => ({ data: vorher.liste }), post: mitschreiben('post'), put: mitschreiben('put') };
  globalThis.window.yuvomi = globalThis.window.yuvomi ?? {};
  const toasts = [];
  globalThis.window.yuvomi.showToast = (text, art) => { toasts.push({ text, art }); };
  try {
    await el['#bd-save'].feuern('click');
  } finally {
    globalThis.__apiStub = vorher.api;
    globalThis.window.yuvomi.showToast = vorher.toast;
    birthdays.state.birthdays = vorher.liste;
  }
  if (roh) return { gesendet, toasts, el };
  assert.equal(gesendet.length, 1, 'genau ein Schreibaufruf - sonst misst der Test den Speichern-Weg nicht');
  return gesendet[0];
}

const ERINNERUNGSFELDER = ['reminder_offset', 'reminder_custom_amount', 'reminder_custom_unit'];

test('eigene Angabe mit ungueltiger Anzahl: der Editor speichert nicht und sagt es ueber t() (Nachzug zu #1384)', async () => {
  for (const anzahl of ['0', '1000', '1.5', '']) {
    const { gesendet, toasts } = await geburtstagSpeichern(geburtstag(), {
      roh: true,
      bedienen: async (el) => {
        el['#bd-reminder-offset'].value = 'custom';
        el['#bd-reminder-custom-amount'].value = anzahl;
      },
    });
    assert.equal(gesendet.length, 0, `Anzahl ${JSON.stringify(anzahl)}: nichts geht an den Server`);
    assert.deepEqual(toasts.map((toast) => toast.text), ['birthdays.reminderAmountInvalid{"max":999}'],
      `Anzahl ${JSON.stringify(anzahl)}: der Hinweis kommt aus t(), nicht als Servermeldung`);
  }
});

test('eine gespeicherte Anzahl ausserhalb 1-999 blockiert nicht, wenn niemand die Erinnerung anfasst', async () => {
  // #1384 sagt zu: ein gespeicherter Wert, wie er auch sei, laesst eine
  // Namensaenderung nie scheitern. Die Pruefung gilt nur dem, was mitgeht.
  const eintrag = geburtstag({ reminder_offset: 'custom', reminder_custom_amount: 1500, reminder_custom_unit: 'days' });
  const { gesendet, toasts } = await geburtstagSpeichern(eintrag, {
    roh: true,
    bedienen: async (el) => { el['#bd-name'].value = 'Oma Erna M.'; },
  });
  assert.deepEqual(toasts.map((toast) => toast.text).filter((text) => text.includes('reminderAmountInvalid')), [],
    'kein Hinweis zu einer Erinnerung, die nicht mitgeht');
  assert.equal(gesendet.length, 1, 'gespeichert wird trotzdem');
  assert.equal(gesendet[0].body.name, 'Oma Erna M.');
  assert.ok(ERINNERUNGSFELDER.every((feld) => !(feld in gesendet[0].body)), 'die unberuehrte Erinnerung geht nicht mit');
});

test('Vorgabe nach getippter ungueltiger Anzahl: gespeichert wird ohne Anzahl und Einheit', async () => {
  const gesendet = await geburtstagSpeichern(geburtstag(), {
    bedienen: async (el) => {
      el['#bd-reminder-custom-amount'].value = '0';
      el['#bd-reminder-offset'].value = '2880';
    },
  });
  assert.equal(gesendet.body.reminder_offset, '2880');
  assert.ok(!('reminder_custom_amount' in gesendet.body) && !('reminder_custom_unit' in gesendet.body),
    'das verborgene Feld laesst das Speichern nicht scheitern');
});

test('Geburtstag ohne gespeicherte Erinnerung: der Editor zeigt den Tag selbst, wie der Server erinnert', () => {
  const editor = (birthday, mode = 'edit') => withAccess({ calendar: 'write' }, () => modalOptionen(
    () => birthdays.openBirthdayModal({ mode, birthday }),
  )).content;

  for (const eintrag of [geburtstag({ reminder_offset: null }), geburtstag()]) {
    const { gewaehlt } = auswahlAusMarkup(editor(eintrag), 'bd-reminder-offset');
    assert.equal(gewaehlt.value, '0', `ohne Wert (${eintrag.reminder_offset}) steht die Auswahl auf dem Tag selbst`);
    assert.equal(gewaehlt.label, 'birthdays.reminderOnDay', '„Am Tag selbst", ein eigener Schluessel');
  }

  // Der Kalender-Schluessel „Zum Startzeitpunkt" gehoert dem Kalender: ein
  // Geburtstag hat keinen Startzeitpunkt, erinnert wird mittags am Tag.
  const { optionen } = auswahlAusMarkup(editor(geburtstag({ reminder_offset: null })), 'bd-reminder-offset');
  assert.ok(!optionen.some((o) => o.label === 'reminders.offsetAtTime'), 'kein Kalender-Label im Geburtstags-Editor');
  assert.equal(optionen.filter((o) => o.value === '0').length, 1, 'genau eine Option fuer den Tag selbst');

  // Gegenfaelle: ein gespeicherter Wert steht, wie er ist, und ein NEUER
  // Geburtstag beginnt weiter bei „1 Tag vorher".
  assert.equal(auswahlAusMarkup(editor(geburtstag({ reminder_offset: '2880' })), 'bd-reminder-offset').gewaehlt.value, '2880');
  assert.equal(auswahlAusMarkup(editor(null, 'create'), 'bd-reminder-offset').gewaehlt.value, '1440');
});

test('Editor und Leseansicht nennen fuer jeden gespeicherten Wert dieselbe Erinnerung', () => {
  for (const reminder_offset of [null, '', '0', '1440', '2880', '10080', '20160', '15', '-90', '01440']) {
    const eintrag = geburtstag({ reminder_offset });
    const editor = withAccess({ calendar: 'write' }, () => modalOptionen(
      () => birthdays.openBirthdayModal({ mode: 'edit', birthday: eintrag }),
    )).content;
    const lesen = withAccess({ calendar: 'read' }, () => modalOptionen(
      () => birthdays.openBirthdayModal({ mode: 'edit', birthday: eintrag }),
    )).content;
    assert.equal(leseErinnerung(lesen), auswahlAusMarkup(editor, 'bd-reminder-offset').gewaehlt.label,
      `gespeichert: ${JSON.stringify(reminder_offset)}`);
  }
});

test('„Weitere Einstellungen" klappt fuer `null` auf wie fuer \'0\' - beide heissen „Am Tag selbst"', () => {
  // Die Entscheidung trifft der Aufrufer; der Loader-Stub reicht die Optionen
  // von `advancedSection()` nur mit diesem Haken heraus.
  const aufgeklappt = (over) => {
    let optionen = null;
    const vorher = globalThis.__advancedSection;
    globalThis.__advancedSection = (inner, opts) => { optionen = opts; return String(inner); };
    try {
      withAccess({ calendar: 'write' }, () => modalOptionen(() => birthdays.openBirthdayModal({
        mode: 'edit', birthday: geburtstag({ notes: null, name_day: null, ...over }),
      })));
    } finally {
      if (vorher === undefined) delete globalThis.__advancedSection;
      else globalThis.__advancedSection = vorher;
    }
    assert.ok(optionen, 'der Editor baut „Weitere Einstellungen" ueber advancedSection()');
    return optionen.open;
  };

  assert.equal(aufgeklappt({ reminder_offset: '0' }), true, '„Am Tag selbst" weicht von der Vorgabe ab');
  assert.equal(aufgeklappt({ reminder_offset: null }), true, 'NULL heisst dasselbe und klappt genauso auf');
  assert.equal(aufgeklappt({}), true, 'ein fehlendes Feld ebenso');

  // Gegenfaelle: die Vorgabe eines neuen Geburtstags klappt nicht auf, „Keine"
  // wie bisher auch nicht, jede andere Vorgabe schon - und die Notiz oeffnet
  // unabhaengig von der Erinnerung.
  assert.equal(aufgeklappt({ reminder_offset: '1440' }), false);
  assert.equal(aufgeklappt({ reminder_offset: '' }), false);
  assert.equal(aufgeklappt({ reminder_offset: '2880' }), true);
  assert.equal(aufgeklappt({ reminder_offset: '1440', notes: 'Mag Kuchen' }), true);
});

test('Oeffnen und Speichern ohne Aenderung schreibt keine Erinnerung', async () => {
  const ohne = await geburtstagSpeichern(geburtstag({ reminder_offset: null }));
  assert.equal(ohne.method, 'put');
  assert.equal(ohne.path, '/birthdays/9');
  assert.equal(ohne.body.name, 'Oma Erna', 'der Rest des Editors geht mit - gespeichert wurde wirklich');
  for (const feld of ERINNERUNGSFELDER) {
    assert.ok(!(feld in ohne.body), `${feld} bleibt weg, also bleibt NULL stehen`);
  }

  // Auch ein gespeicherter Wert wird nicht neu geschrieben, und mit ihm nicht
  // Anzahl und Einheit der eigenen Angabe, die verborgen mitstehen.
  const mit = await geburtstagSpeichern(geburtstag({ reminder_offset: '2880' }));
  for (const feld of ERINNERUNGSFELDER) assert.ok(!(feld in mit.body), feld);
});

test('Eine gewaehlte Erinnerung wird geschrieben', async () => {
  const waehle = (wert) => async (el) => {
    el['#bd-reminder-offset'].value = wert;
    await el['#bd-reminder-offset'].feuern('change');
  };

  const vorher = await geburtstagSpeichern(geburtstag({ reminder_offset: null }), { bedienen: waehle('2880') });
  assert.equal(vorher.body.reminder_offset, '2880');

  // Den Tag selbst gibt es als Vorgabe: wer ihn waehlt, bekommt ihn.
  const amTag = await geburtstagSpeichern(geburtstag({ reminder_offset: '1440' }), { bedienen: waehle('0') });
  assert.equal(amTag.body.reminder_offset, '0');

  const keine = await geburtstagSpeichern(geburtstag({ reminder_offset: null }), { bedienen: waehle('') });
  assert.equal(keine.body.reminder_offset, '', '„Keine" ist eine Wahl und wird geschrieben');

  // Eine eigene Angabe: nur die Anzahl geaendert, und alle drei Felder gehen mit.
  const eigen = await geburtstagSpeichern(
    geburtstag({ reminder_offset: 'custom', reminder_custom_amount: 3, reminder_custom_unit: 'weeks' }),
    { bedienen: async (el) => { el['#bd-reminder-custom-amount'].value = '4'; } },
  );
  assert.deepEqual(
    ERINNERUNGSFELDER.map((feld) => eigen.body[feld]),
    ['custom', '4', 'weeks'],
  );

  // Ein neuer Geburtstag schreibt, was die Auswahl zeigt.
  const neu = await geburtstagSpeichern(geburtstag(), { mode: 'create' });
  assert.equal(neu.method, 'post');
  assert.deepEqual(ERINNERUNGSFELDER.map((feld) => neu.body[feld]), ['1440', '1', 'days']);
});

// -------------------------------------------------------------------------
// Ein gespeicherter Wert, den der Editor nicht mehr anbietet (#1367)
//
// Bis v1.6.5 bot der Editor '15', '60' und '20160' an, und `POST`/`PUT
// /birthdays` nehmen jede Zahl an. Der Server erinnert so viele Minuten vor
// 12:00 (`getOffsetMinutes()`), der Editor stand ohne passende Option auf der
// ersten, „Keine". Wer dort „Keine" waehlte, um die Erinnerung abzuschalten,
// aenderte nichts - und sie lief weiter.
// -------------------------------------------------------------------------

/** Der Editor mit Schreibrecht, als Markup. */
const geburtstagsEditor = (eintrag) => withAccess({ calendar: 'write' }, () => modalOptionen(
  () => birthdays.openBirthdayModal({ mode: 'edit', birthday: eintrag }),
)).content;

test('Ein Wert, den der Editor nicht anbietet, steht als eigene Option da, wie er wirkt', () => {
  const faelle = [
    ['20160', /^birthdays\.reminderBefore\{.*2 Wochen/],
    ['15', /^birthdays\.reminderBefore\{.*15 Minuten/],
    ['60', /^birthdays\.reminderBefore\{.*1 Stunde\b/],
    ['4320', /^birthdays\.reminderBefore\{.*3 Tage/],
    ['-90', /^birthdays\.reminderAfterNoon\{.*90 Minuten/],
  ];
  for (const [reminder_offset, beschriftung] of faelle) {
    const { optionen, gewaehlt } = auswahlAusMarkup(geburtstagsEditor(geburtstag({ reminder_offset })), 'bd-reminder-offset');
    assert.equal(gewaehlt.value, reminder_offset, `${reminder_offset}: die Auswahl traegt den gespeicherten Wert`);
    assert.match(gewaehlt.label, beschriftung, `${reminder_offset}: benannt nach der Wirkung`);
    assert.notEqual(gewaehlt.label, 'reminders.offsetNone', 'nicht „Keine" - der Server erinnert');
    assert.ok(optionen.some((o) => o.value === ''), '„Keine" bleibt waehlbar');
    assert.equal(optionen.at(-1).value, 'custom', 'die eigene Angabe bleibt die letzte Option');
  }

  // Die Option gibt es nur fuer diesen Eintrag: ein Geburtstag mit einer
  // Vorgabe bekommt keine zusaetzliche.
  const vorgabe = auswahlAusMarkup(geburtstagsEditor(geburtstag({ reminder_offset: '2880' })), 'bd-reminder-offset');
  assert.deepEqual(vorgabe.optionen.map((o) => o.value), ['', '0', '1440', '2880', '10080', 'custom']);

  // Ein Wert, der in anderer Schreibweise dasselbe tut wie eine Vorgabe, steht
  // auf der Vorgabe - und ein unlesbarer auf dem Tag selbst, wie der Server
  // ihn liest (`parseInt(...) || 0`).
  assert.equal(auswahlAusMarkup(geburtstagsEditor(geburtstag({ reminder_offset: '01440' })), 'bd-reminder-offset').gewaehlt.value, '1440');
  assert.equal(auswahlAusMarkup(geburtstagsEditor(geburtstag({ reminder_offset: 'abc' })), 'bd-reminder-offset').gewaehlt.value, '0');

  // Der gespeicherte Wert steht jetzt im Markup, und die API nimmt jeden Text:
  // er geht durch esc() wie jeder Nutzerwert.
  const roh = geburtstagsEditor(geburtstag({ reminder_offset: '5"><img src=x onerror=alert(1)>' }));
  assert.doesNotMatch(roh, /<img src=x/);
  assert.match(roh, /value="5&quot;&gt;&lt;img/);
});

test('Ein unbekannter Wert bleibt beim Speichern ohne Wahl stehen, „Keine" schaltet ihn ab', async () => {
  const eintrag = () => geburtstag({ reminder_offset: '20160' });

  const unberuehrt = await geburtstagSpeichern(eintrag());
  assert.equal(unberuehrt.body.name, 'Oma Erna', 'gespeichert wurde wirklich');
  for (const feld of ERINNERUNGSFELDER) {
    assert.ok(!(feld in unberuehrt.body), `${feld} bleibt weg, also bleiben die zwei Wochen stehen`);
  }

  // Der eigentliche Fall: wer „Keine" waehlt, will die Erinnerung loswerden.
  // Stand die Auswahl schon auf „Keine", war das keine Aenderung und ging nie
  // an den Server.
  const keine = await geburtstagSpeichern(eintrag(), {
    bedienen: async (el) => {
      el['#bd-reminder-offset'].value = '';
      await el['#bd-reminder-offset'].feuern('change');
    },
  });
  assert.equal(keine.body.reminder_offset, '', '„Keine" geht an den Server');
});

test('Geburtstags-Dialog: Editor mit Schreibrecht, bei `read` kein Anlegen und kein Editor', () => {
  // Gegenfall: mit Schreibrecht steht der ganze Editor da - sonst waeren die
  // Zusicherungen oben auch gruen, wenn der Abgreifer gar nichts saehe.
  const schreibend = withAccess({ calendar: 'write' }, () => (
    modalOptionen(() => birthdays.openBirthdayModal({ mode: 'edit', birthday: geburtstag() }))
  ));
  assert.match(schreibend.content, /id="bd-save"/);
  assert.match(schreibend.content, /id="bd-notes"/);
  assert.doesNotMatch(schreibend.content, /data-view="read"/);

  const angelegt = withAccess({ calendar: 'read' }, () => (
    modalOptionen(() => birthdays.openBirthdayModal({ mode: 'create' }))
  ));
  assert.equal(angelegt, null, 'ein Dialog zum Anlegen ginge bei `read` nur ins 403');

  // Ein Stift aus einem aelteren Render findet weiter den Riegel.
  const alt = mitGeburtstagen([geburtstag()], () => withAccess({ calendar: 'read' }, () => (
    modalOptionen(() => birthdays.onListClick(klickAuf({ '[data-action]': { dataset: { action: 'edit', id: '9' } } })))
  )));
  assert.equal(alt, null);
});

// Die Dauer einer eigenen Erinnerung (#1365): unter englischer Oberflaeche mit
// Region de-DE stand „3 Wochen" da - der Zahlformatierer der Region lieferte
// auch das Wort. Das Wort gehoert der UI-Sprache (`__locale`), die Zahl der
// Region (`__formatLocale`). Der Stub von formatUnit ist ein Nachbau;
// test:region-presets haelt ihn am Original.
test('Leseansicht: die Dauer spricht die UI-Sprache, die Ziffern bleiben die der Region (#1365)', () => {
  const vorher = { locale: globalThis.__locale, formatLocale: globalThis.__formatLocale };
  const lesen = (over) => withAccess({ calendar: 'read' }, () => (
    modalOptionen(() => birthdays.openBirthdayModal({ mode: 'edit', birthday: geburtstag(over) }))
  )).content;
  const dauer = () => lesen({ reminder_offset: 'custom', reminder_custom_amount: 3, reminder_custom_unit: 'weeks' });
  try {
    globalThis.__locale = 'en';
    globalThis.__formatLocale = 'de-DE';
    assert.match(dauer(), /3 weeks/);
    // Ohne gespeicherten Wert bleibt es beim Tag selbst (#1363) - ein
    // Schluessel, kein Zahlwort; der Stub-t() gibt ihn als Schluessel aus.
    assert.equal(leseErinnerung(lesen({ reminder_offset: null })), 'birthdays.reminderOnDay');
    const locale = (code) => JSON.parse(readFileSync(new URL(`../public/locales/${code}.json`, import.meta.url), 'utf8'));
    assert.equal(locale('en').birthdays.reminderOnDay, 'On the day');
    assert.equal(locale('de').birthdays.reminderOnDay, 'Am Tag selbst');
    globalThis.__formatLocale = 'ar-SA';
    assert.match(dauer(), /٣ weeks/, 'die Ziffern der Region, das Wort der Sprache');
  } finally {
    globalThis.__locale = vorher.locale;
    globalThis.__formatLocale = vorher.formatLocale;
  }
});

// -------------------------------------------------------------------------
// Leertexte bei `read` (#1348): die drei Seiten aus P1
//
// Der CTA war seit #1311 weg, der Satz, der zu ihm einlud, nicht: „Neue
// Kontakte über den + Button hinzufügen" unter einer Liste ohne +-Knopf.
// Beschreibung und Hinweis laden auf allen drei Seiten zum Anlegen ein, also
// gehen beide; der Titel nennt den Zustand und bleibt.
// -------------------------------------------------------------------------

test('Leerzustaende bei `read`: kein Satz, der zu einem fehlenden Knopf schickt', () => {
  const vorherNotes = { ...notes.state };
  const vorherQuery = birthdays.state.query;
  Object.assign(notes.state, { notes: [], filterQuery: '', filterCreator: '', filterCategoryIds: [] });
  birthdays.state.query = '';
  const seiten = [
    ['contacts', 'calendar', () => contacts.contactsEmptyStateHtml(false), 'contacts'],
    ['notes', 'calendar', () => notes.notesEmptyStateHtml(false), 'notes'],
    ['calendar', 'contacts', () => birthdays.emptyStateHtml(), 'birthdays'],
  ];
  try {
    for (const [modul, anderes, leer, ns] of seiten) {
      const beschreibung = new RegExp(`${ns}\\.emptyDescription`);
      const hinweis = new RegExp(`emptyHint\\.${ns}`);
      withAccess({ [modul]: 'write', [anderes]: 'write' }, () => {
        const html = leer();
        assert.match(html, beschreibung, `${ns}: mit Schreibrecht steht die Einladung da`);
        assert.match(html, hinweis);
      });
      withAccess({ [modul]: 'read', [anderes]: 'write' }, () => {
        const html = leer();
        assert.doesNotMatch(html, beschreibung, `${ns}: die Einladung zum +-Knopf geht mit dem Knopf`);
        assert.doesNotMatch(html, hinweis, `${ns}: der Hinweis laedt ebenso zum Anlegen ein`);
        assert.match(html, new RegExp(`${ns}\\.emptyTitle`), `${ns}: der Titel nennt den Zustand und bleibt`);
      });
    }
  } finally {
    Object.assign(notes.state, vorherNotes);
    birthdays.state.query = vorherQuery;
  }
});


// =========================================================================
// #1265 P2: Gesundheit
//
// Die groesste Seite der App: acht Tabs, 38 schreibende API-Aufrufe in
// `pages/health.js` und sieben weitere im Fasten-Zweig. Gemessen wird wie in
// P1 am ERZEUGTEN MARKUP und immer im Paar - „bei read weg" UND „bei write
// da" -, denn eine Zusicherung, die nur ein fehlendes Element prueft, ist auch
// gruen, wenn gar nichts gerendert wurde. Jeder Nur-lesen-Fall prueft deshalb
// zusaetzlich einen INHALT, den der Renderer nur ausgeben kann, wenn er wirklich
// gelaufen ist.
//
// DIE ZWEI FRAGEN, DIE HIER AUSEINANDERGEHALTEN WERDEN. Das Gesundheitsmodul
// kennt eine eigene Schreibfreigabe je PERSON (Betreuung, #584:
// `canEditFor()`), und der Zyklus-Tab kennt zusaetzlich „bin ich das selbst?"
// (`isOwnCycleView()`). Keine davon ist das MODULRECHT. Dieses Paket regelt
// allein Letzteres: was bei `health: read` an der Oberflaeche verschwindet.
// Was eine fremde ZEILE preisgibt (`visibility`, `resolveOwner()`), entscheidet
// weiterhin der Server - hier steht dazu nichts.
//
// Und die Gegenrichtung, die der Zyklus-Tab braucht: bei `health: read` bleibt
// die EIGENE Ansicht vollstaendig lesbar - Intimitaets-Marker, PMS-Fenster,
// Historie, Export. Waere das Recht in `isOwnCycleView()` gewandert, haette es
// genau diese Auskunft mitgenommen.
// =========================================================================

/** Die sieben Tab-Zustaende sind Modul-Singletons: setzen, messen, aufraeumen. */
function mitView(name, patch, fn) {
  const { __reset: zurueck, ...felder } = patch;
  health.setViewStateForTest(name, felder);
  try { return fn(); } finally { health.setViewStateForTest(name, zurueck || {}); }
}

const HEALTH_SRC = readFileSync(new URL('../public/pages/health.js', import.meta.url), 'utf8');
// Kommentarfrei messen: sonst haelt ausgerechnet die Begruendung den Test gruen
// (dieselbe Regel wie bei CAL_CODE oben).
const HEALTH_CODE = HEALTH_SRC.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

function healthFn(name) {
  const start = HEALTH_CODE.indexOf(`function ${name}(`);
  assert.ok(start >= 0, `${name}() nicht gefunden`);
  const rest = HEALTH_CODE.slice(start);
  const ende = rest.indexOf('\n}\n');
  return rest.slice(0, ende + 2);
}

// -------------------------------------------------------------------------
// Die Frage selbst - und der Name, der sie traegt
// -------------------------------------------------------------------------

test('health.readOnly() folgt dem Rechte-Store - und `health` ist ein Modulname, den es gibt', () => {
  // DIE FALLE AUS P1, HIER GEGENGEPRUEFT. `birthdays.js` fragte nach einem
  // Modul, das die Rechte gar nicht fuehren, und `moduleAccess()` faellt fuer
  // einen unbekannten Schluessel still auf `write` durch - die Frage waere
  // nie „ja, nur lesen" geworden. Genau deshalb steht sie hier im Paar: ginge
  // der Name ins Leere, bliebe readOnly() auch bei `read` false.
  withAccess({ health: 'read' }, () => assert.equal(health.readOnly(), true));
  withAccess({ health: 'write' }, () => assert.equal(health.readOnly(), false));
  // `none` ist kein „nur lesen": die Seite ist dann gar nicht erreichbar
  // (canAccessNavModule), und isNavModuleReadOnly prueft ausdruecklich `read`.
  withAccess({ health: 'none' }, () => assert.equal(health.readOnly(), false));
  // Ohne geladene Rechte gilt Vollzugriff (fail-open wie permissions.js).
  assert.equal(health.readOnly(), false);
});

test('canEditFor(): das Modulrecht steht VOR der Betreuungs-Freigabe', () => {
  health.setViewStateForTest('vitals', {});
  const vorher = [3];
  health.setCareForForTest(vorher);
  try {
    withAccess({ health: 'write' }, () => {
      assert.equal(health.canEditFor(1, 1), true, 'eigene Daten');
      assert.equal(health.canEditFor(3, 1), true, 'betreute Person (#584)');
      assert.equal(health.canEditFor(9, 1), false, 'unbeteiligtes Mitglied');
    });
    withAccess({ health: 'read' }, () => {
      assert.equal(health.canEditFor(1, 1), false, 'auch die eigenen Daten nicht');
      assert.equal(health.canEditFor(3, 1), false,
        'eine Betreuungs-Freigabe hilft nicht, wenn das ganze Modul auf read steht');
      assert.equal(health.canEditFor(9, 1), false);
    });
  } finally { health.setCareForForTest([]); }
});

// -------------------------------------------------------------------------
// Vitalwerte
// -------------------------------------------------------------------------

const messung = (over = {}) => ({ id: 41, type: 'weight', value_num: 72.4, unit: 'kg', measured_at: '2026-06-15T08:00', ...over });
const gewicht = () => ({ type: 'weight', labelKey: 'health.vitals.metric.weight', units: ['kg'], icon: 'scale', channels: null, decimals: 1 });

test('Vitalwerte-Historie mit `health: read`: die Messung bleibt, ihr Bearbeiten-Weg geht', () => {
  mitView('vitals', { meId: 1, personId: 1, rows: [messung()], range: 'month', __reset: { rows: [] } }, () => {
    withAccess({ health: 'write' }, () => {
      const html = health.recentMeasurementsMarkup(gewicht());
      // R8 H9: die Zeile oeffnet Bearbeiten (Stift) statt nur zu loeschen.
      assert.match(html, /data-vital-edit="41"/);
      assert.match(html, /health\.vitals\.editMeasurement/);
      assert.doesNotMatch(html, /data-delete-vital/, 'Loeschen steht im Dialogfuss, nicht mehr in der Zeile');
    });
    withAccess({ health: 'read' }, () => {
      const html = health.recentMeasurementsMarkup(gewicht());
      assert.doesNotMatch(html, /data-vital-edit/);
      assert.doesNotMatch(html, /<button/);
      // Der Inhalt, den nur ein wirklich gelaufener Renderer ausgeben kann:
      assert.match(html, /health\.vitals\.recentMeasurements/);
      assert.match(html, /72[.,]4/);
    });
  });
});

test('R8 H9: eine Messung oeffnet sich mit Bestand, Loeschen steht links im Dialogfuss', () => {
  const bp = { id: 52, type: 'bp', value_num: 128, value_num2: 84, value_num3: 66, unit: 'mmHg', measured_at: '2026-06-15T08:30', visibility: 'family', note: 'nach dem Laufen' };
  const offen = withAccess({ health: 'write' }, () => modalOptionen(() => health.openVitalModal({ row: bp })));
  assert.ok(offen, 'mit Schreibrecht geht der Dialog auf');
  assert.equal(offen.title, 'health.vitals.edit');
  assert.match(offen.content, /id="vital-sys"[^>]*value="128"/, 'der Bestand steht im Formular');
  assert.match(offen.content, /id="vital-dia"[^>]*value="84"/);
  assert.match(offen.content, /id="vital-pulse"[^>]*value="66"/);
  assert.match(offen.content, /value="2026-06-15T08:30"/, 'der Messzeitpunkt, nicht jetzt');
  assert.match(offen.content, /<option value="family" selected/, 'die gespeicherte Sichtbarkeit, nicht die Voreinstellung');
  assert.match(offen.content, />nach dem Laufen<\/textarea>/);
  assert.match(offen.content, /id="vital-type" disabled/, 'die Metrik einer Messung steht fest');
  const fuss = /<div class="modal-panel__footer[^"]*">([\s\S]*?)<\/div>/.exec(offen.content)[1];
  const loeschen = fuss.indexOf('data-action="vital-delete"');
  assert.ok(loeschen >= 0, 'Loeschen steht im Dialogfuss');
  assert.ok(loeschen < fuss.indexOf('data-action="cancel"'), 'links vor Abbrechen und Speichern (Kanon)');
  assert.match(fuss, /btn--danger-outline" data-action="vital-delete"[^>]* style="margin-inline-end:auto"/);
  // Mobil ist Loeschen ein Papierkorb ohne Wort (R9 M8, modal.js); sein Name
  // kommt aus data-delete-name - ohne nahm modal.js das erste Feld ("128").
  assert.match(fuss, /data-action="vital-delete" data-delete-name="health\.vitals\.metric\.bp"/, 'der Papierkorb nennt die Metrik');

  const neu = withAccess({ health: 'write' }, () => modalOptionen(() => health.openVitalModal()));
  assert.equal(neu.title, 'health.vitals.add');
  assert.doesNotMatch(neu.content, /vital-delete/, 'ohne Bestand gibt es nichts zu loeschen');
  assert.doesNotMatch(neu.content, /id="vital-type" disabled/);
});

test('R8 H9: PATCH einer Messung leert, was der Dialog nicht mehr zeigt', () => {
  assert.deepEqual(
    health.vitalPatchBody({ type: 'bp', value_num: 120, value_num2: 80, visibility: 'private', measured_at: '2026-06-15T08:30' }),
    { type: 'bp', value_num: 120, value_num2: 80, value_num3: null, note: null, visibility: 'private', measured_at: '2026-06-15T08:30' },
    'ein geleertes Pulsfeld darf den alten Puls nicht stehen lassen',
  );
});

/**
 * Oeffnet den Vitalwert-Dialog im Bearbeiten-Modus, verdrahtet ihn gegen eine
 * Attrappe aus seinem eigenen Markup (die Einheit als Auswahl mit
 * Browser-Verhalten), laesst `bedienen` daran drehen und schickt das Formular
 * ab. Zurueck kommen die Schreibaufrufe, durch JSON wie in api.js.
 */
async function vitalwertSpeichern(row, bedienen = () => {}) {
  const optionen = withAccess({ health: 'write' }, () => modalOptionen(() => health.openVitalModal({ row })));
  assert.ok(optionen, 'mit Schreibrecht geht der Dialog auf');
  const html = optionen.content;
  // Die Wertefelder so, wie das Markup der Metrik sie stellt: der einfache
  // Wert, das Paar (Blutdruck) oder die Dauer - jedes mit seinem Bestand.
  const wertefelder = {};
  for (const id of ['vital-value', 'vital-sys', 'vital-dia', 'vital-pulse', 'vital-hours', 'vital-minutes']) {
    const feld = new RegExp(`<input[^>]*id="${id}"[^>]*>`).exec(html);
    if (feld) wertefelder[`#${id}`] = editorElement({ value: /value="([^"]*)"/.exec(feld[0])?.[1] ?? '' });
  }
  assert.ok(Object.keys(wertefelder).length, 'das Markup traegt Wertefelder mit Bestand');
  // Die Einheit, wie sie im Markup steht: Auswahl, verstecktes Feld - oder
  // gar keins (das Paar). Ein erfundenes Feld wuerde den Fehler verdecken.
  const versteckt = /<input type="hidden" id="vital-unit" value="([^"]*)">/.exec(html);
  const einheit = /<select[^>]*id="vital-unit"/.test(html) ? editorAuswahl(html, 'vital-unit')
    : versteckt ? editorElement({ value: versteckt[1] }) : null;
  const form = editorElement();
  const el = {
    '#vital-form': form,
    '#vital-type': editorElement({ value: row.type }),
    '#vital-value-fields': editorElement({ querySelector: () => null }),
    '#vital-visibility': editorElement({ value: row.visibility || 'private' }),
    '#vital-measured-at': editorElement({ value: row.measured_at }),
    '#vital-note': editorElement({ value: row.note ?? '' }),
    ...wertefelder,
    '#vital-unit': einheit,
    '[type="submit"]': editorElement(),
  };
  optionen.onSave({ querySelector: (sel) => el[sel] ?? null });
  bedienen(el);
  const gesendet = [];
  const vorher = { api: globalThis.__apiStub, window: globalThis.window, hatteWindow: 'window' in globalThis };
  const mitschreiben = (method) => async (path, body) => {
    gesendet.push({ method, path, body: JSON.parse(JSON.stringify(body)) });
    return { data: { id: row.id } };
  };
  globalThis.__apiStub = { get: async () => ({ data: [] }), patch: mitschreiben('patch'), post: mitschreiben('post') };
  globalThis.window = { yuvomi: { showToast() {} } };
  try {
    await withAccess({ health: 'write' }, async () => {
      for (const fn of form.handlers?.submit ?? []) await fn({ preventDefault() {}, target: form });
    });
  } finally {
    globalThis.__apiStub = vorher.api;
    if (vorher.hatteWindow) globalThis.window = vorher.window;
    else delete globalThis.window;
  }
  return { gesendet, html };
}

test('Codex an #1485: eine Einheit ausserhalb der Liste bleibt beim Bearbeiten stehen', async () => {
  const stone = { id: 61, type: 'weight', value_num: 12, unit: 'stone', measured_at: '2026-06-15T08:00', visibility: 'private', note: '' };
  const { gesendet, html } = await vitalwertSpeichern(stone, (el) => { el['#vital-note'].value = 'nach dem Fruehstueck'; });
  const { gewaehlt } = auswahlAusMarkup(html, 'vital-unit');
  assert.equal(gewaehlt.value, 'stone', 'die gespeicherte Einheit steht gewaehlt da, nicht still die erste der Liste');
  assert.equal(gesendet.length, 1, 'genau ein Schreibaufruf');
  assert.equal(gesendet[0].method, 'patch');
  assert.equal(gesendet[0].body.note, 'nach dem Fruehstueck');
  assert.ok(!('unit' in gesendet[0].body),
    `eine Notiz-Korrektur fasst die Einheit nicht an (aus 12 stone wurden 12 kg): ${JSON.stringify(gesendet[0].body)}`);

  // Waehlt der Mensch die Einheit selbst, geht sie mit.
  const umgestellt = await vitalwertSpeichern(stone, (el) => { el['#vital-unit'].value = 'lb'; });
  assert.equal(umgestellt.gesendet[0].body.unit, 'lb');
  // Eine gelistete Einheit bleibt, wie sie war, ohne verwaiste Zusatzoption.
  const kg = await vitalwertSpeichern({ ...stone, unit: 'kg' });
  assert.deepEqual(auswahlAusMarkup(kg.html, 'vital-unit').optionen.map((o) => o.value), ['kg', 'lb']);
});

test('Codex an #1485: ein Blutdruck in kPa bleibt beim Speichern einer Notiz kPa', async () => {
  // Das Paar hat kein Einheitenfeld; collectVitalBody() setzt fest mmHg. Ohne
  // Feld gab es nichts zu vergleichen, und ein per API in kPa erfasster Wert
  // wurde beim Speichern einer Notiz still zu mmHg umbeschriftet.
  const kpa = { id: 71, type: 'bp', value_num: 16, value_num2: 10.5, value_num3: 62, unit: 'kPa', measured_at: '2026-06-15T08:30', visibility: 'private', note: '' };
  const { gesendet, html } = await vitalwertSpeichern(kpa, (el) => { el['#vital-note'].value = 'nach dem Laufen'; });
  assert.doesNotMatch(html, /id="vital-unit"/, 'Voraussetzung: das Paar-Markup traegt kein Einheitenfeld');
  assert.equal(gesendet.length, 1, 'genau ein Schreibaufruf');
  assert.equal(gesendet[0].method, 'patch');
  assert.equal(gesendet[0].body.note, 'nach dem Laufen');
  assert.equal(gesendet[0].body.value_num, 16, 'der Wert selbst geht mit');
  assert.ok(!('unit' in gesendet[0].body),
    `ohne Einheitenfeld geht keine Einheit mit (aus kPa wurde mmHg): ${JSON.stringify(gesendet[0].body)}`);

  // Auch die Dauer mit ihrem versteckten Feld schreibt die Einheit nie um.
  const schlaf = { id: 72, type: 'sleep', value_num: 7.5, unit: 'min', measured_at: '2026-06-15T08:30', visibility: 'private', note: '' };
  const dauer = await vitalwertSpeichern(schlaf, (el) => { el['#vital-note'].value = 'unruhig'; });
  assert.ok(!('unit' in dauer.gesendet[0].body),
    `ein verstecktes Einheitenfeld schreibt keine Einheit um: ${JSON.stringify(dauer.gesendet[0].body)}`);
});

test('R8 H9: ein Laborwert laesst sich korrigieren, nicht nur loeschen', () => {
  const analyt = { id: 3, analyte: 'Ferritin', value_num: 88, unit: 'ng/ml', ref_low: 30, ref_high: 300, flag: 'normal' };
  const zeile = health.resultEditRowMarkup(analyt);
  assert.match(zeile, /data-result-edit="3"/, 'die Zeile traegt einen Stift');
  assert.match(zeile, /common\.editNamed/, 'mit dem Objektnamen');
  assert.match(zeile, /data-result-del="3"/);
  const form = health.resultFormMarkup(analyt);
  assert.match(form, /id="res-analyte"[^>]*value="Ferritin"/, 'das Formular traegt den Bestand');
  assert.match(form, /id="res-value"[^>]*value="88"/);
  assert.match(form, /id="res-ref-high"[^>]*value="300"/);
  assert.match(form, /data-action="res-save"/);
  assert.match(form, /data-action="res-edit-cancel"/);
  assert.doesNotMatch(form, /data-action="res-add"/);
  const leer = health.resultFormMarkup();
  assert.match(leer, /data-action="res-add"/);
  assert.doesNotMatch(leer, /value="/, 'ohne Bestand bleibt das Formular leer');
});

/**
 * Faehrt den Analyt-Editor eines Befunds gegen eine Attrappe: `felder` setzt
 * die Eingaben, dann ein Klick auf Hinzufuegen bzw. Uebernehmen. Zurueck
 * kommen Schreibaufrufe und gemeldete Feldfehler.
 */
async function analytSpeichern(report, { editId = null, felder = {}, badInput = false } = {}) {
  const elemente = new Map();
  const element = (sel) => {
    if (!elemente.has(sel)) elemente.set(sel, editorElement({ querySelector: () => null }));
    return elemente.get(sel);
  };
  let markup = '';
  const host = {
    replaceChildren() { markup = ''; elemente.clear(); },
    insertAdjacentHTML(_pos, html) { markup += html; },
    querySelector: (sel) => element(sel),
    querySelectorAll: () => [],
  };
  const panel = { querySelector: (sel) => (sel === '#lab-results-editor' ? host : null) };
  const gesendet = [];
  const fehler = [];
  const vorher = { api: globalThis.__apiStub, fehler: globalThis.__reportFieldError, window: globalThis.window, hatteWindow: 'window' in globalThis };
  const mitschreiben = (method) => async (path, body) => {
    gesendet.push({ method, path, body: JSON.parse(JSON.stringify(body)) });
    return { data: { id: editId ?? 99, ...body } };
  };
  globalThis.__apiStub = { get: async () => ({ data: [] }), patch: mitschreiben('patch'), post: mitschreiben('post') };
  globalThis.__reportFieldError = (el, text) => { fehler.push(text); };
  globalThis.window = { yuvomi: { showToast() {} } };
  try {
    health.renderResultEditor(panel, report, { editId });
    const knopf = editId != null ? 'res-save' : 'res-add';
    assert.match(markup, new RegExp(`data-action="${knopf}"`), 'der Editor steht im erwarteten Modus');
    for (const [sel, wert] of Object.entries(felder)) element(sel).value = wert;
    element('#res-value').validity = { badInput };
    const klick = element('[data-action="res-add"], [data-action="res-save"]');
    for (const fn of klick.handlers.click ?? []) await fn({ currentTarget: klick, target: klick });
  } finally {
    globalThis.__apiStub = vorher.api;
    if (vorher.fehler === undefined) delete globalThis.__reportFieldError;
    else globalThis.__reportFieldError = vorher.fehler;
    if (vorher.hatteWindow) globalThis.window = vorher.window;
    else delete globalThis.window;
  }
  return { gesendet, fehler };
}

test('Codex an #1485: ein Laborwert ohne Zahl laesst sich bearbeiten, ohne eine erfinden zu muessen', async () => {
  const ohneWert = { id: 5, analyte: 'Befundtext', value_num: null, unit: null, ref_low: null, ref_high: null, flag: null };
  const report = { id: 2, results: [ohneWert] };
  const bearbeitet = await analytSpeichern(report, {
    editId: 5,
    felder: { '#res-analyte': 'Befundtext Urin', '#res-value': '' },
  });
  assert.deepEqual(bearbeitet.fehler, [], 'kein Pflichtfeld-Fehler: value_num ist nullable');
  assert.equal(bearbeitet.gesendet.length, 1, 'genau ein Schreibaufruf');
  assert.equal(bearbeitet.gesendet[0].method, 'patch');
  assert.equal(bearbeitet.gesendet[0].body.analyte, 'Befundtext Urin');
  assert.equal(bearbeitet.gesendet[0].body.value_num, null, 'null bleibt null');

  // Eine Eingabe, die keine Zahl ist, bleibt ein Fehler.
  const kaputt = await analytSpeichern(report, { editId: 5, felder: { '#res-analyte': 'X', '#res-value': 'abc' } });
  assert.deepEqual(kaputt.gesendet, []);
  assert.deepEqual(kaputt.fehler, ['health.labs.results.valueRequired']);
  // Ein Zahlenfeld meldet eine halbe Eingabe ("1e") als leer - sie wird nicht still zu null.
  const halb = await analytSpeichern(report, { editId: 5, felder: { '#res-analyte': 'X', '#res-value': '' }, badInput: true });
  assert.deepEqual(halb.gesendet, []);
  assert.deepEqual(halb.fehler, ['health.labs.results.valueRequired']);

  // Anlegen bleibt, wie es ist: der Wert ist dort Pflicht.
  const neu = await analytSpeichern({ id: 2, results: [] }, { felder: { '#res-analyte': 'Ferritin', '#res-value': '' } });
  assert.deepEqual(neu.gesendet, []);
  assert.deepEqual(neu.fehler, ['health.labs.results.valueRequired']);
});

// -------------------------------------------------------------------------
// Medikamente
// -------------------------------------------------------------------------

const medikament = (over = {}) => ({
  id: 8, name: 'Ibuprofen', dosage_text: '400 mg', form: 'Tablette', active: 1,
  prn: 0, stock_qty: 12, stock_unit: 'Stk', refill_threshold: 5, ...over,
});
const dosis = (over = {}) => ({ medicationId: 8, scheduleId: 2, scheduledAt: '2026-06-15T08:00', time: '08:00', dose_qty: 1, ...over });

test('Faellige Dosis mit `health: read`: kein Buchungsknopf, aber die Ansage „steht aus"', () => {
  mitView('meds', { meId: 1, personId: 1, list: [medikament()], logsByMed: {}, __reset: { list: [], logsByMed: {} } }, () => {
    withAccess({ health: 'write' }, () => {
      const html = health.dueRowMarkup(dosis(), medikament(), null);
      assert.match(html, /data-dose-take/);
      assert.match(html, /data-dose-skip/);
    });
    withAccess({ health: 'read' }, () => {
      const html = health.dueRowMarkup(dosis(), medikament(), null);
      assert.doesNotMatch(html, /data-dose-take|data-dose-skip/);
      assert.doesNotMatch(html, /<button/);
      // ZUSTAND BLEIBT ALS ZEICHEN: die Zeile sagt weiter, woran sie ist.
      assert.match(html, /<span class="health-dose__status">health\.meds\.status\.pending<\/span>/);
      assert.match(html, /Ibuprofen/);
      assert.match(html, /08:00/);
    });
    // Eine bereits gebuchte Dosis traegt ihr Zeichen in beiden Faellen - der
    // Riegel darf die Auskunft nicht mitnehmen.
    for (const stufe of ['read', 'write']) {
      withAccess({ health: stufe }, () => {
        const html = health.dueRowMarkup(dosis(), medikament(), { id: 5, status: 'taken' });
        assert.match(html, /health-dose__status--taken/);
        assert.match(html, /health\.meds\.status\.taken/);
      });
    }
  });
});

test('Medikamentenkarte mit `health: read`: aus dem Knopf wird ein Kasten, der Bestand bleibt', () => {
  mitView('meds', { meId: 1, personId: 1, list: [medikament()], logsByMed: {}, __reset: { list: [], logsByMed: {} } }, () => {
    withAccess({ health: 'write' }, () => {
      const html = health.medCardMarkup(medikament());
      assert.match(html, /<button class="health-med-card[^"]*" type="button" data-med-edit="8"/);
    });
    withAccess({ health: 'read' }, () => {
      const html = health.medCardMarkup(medikament());
      assert.doesNotMatch(html, /data-med-edit/);
      assert.doesNotMatch(html, /<button/);
      assert.match(html, /<div class="health-med-card/);
      assert.match(html, /Ibuprofen/);
      assert.match(html, /health\.meds\.stock\.label/, 'der Bestand ist Auskunft, keine Handlung');
    });
  });
});

test('Einnahmeprotokoll mit `health: read`: die Zeilen bleiben, die Korrektur faellt weg', () => {
  const zustand = {
    meId: 1, personId: 1, list: [medikament()],
    logsByMed: { 8: [{ id: 77, schedule_id: 2, status: 'taken', taken_at: '2026-06-15T08:05' }] },
    __reset: { list: [], logsByMed: {} },
  };
  mitView('meds', zustand, () => {
    withAccess({ health: 'write' }, () => {
      assert.match(health.medLogHistoryMarkup(), /data-medlog-edit="77"/);
    });
    withAccess({ health: 'read' }, () => {
      const html = health.medLogHistoryMarkup();
      assert.doesNotMatch(html, /data-medlog-edit/);
      assert.doesNotMatch(html, /<button/);
      assert.match(html, /health\.meds\.logTitle/);
      assert.match(html, /health\.meds\.status\.taken/);
      assert.match(html, /Ibuprofen/);
    });
  });
});

test('Bedarfsdosis: der Knopf haengt an `own`, und `own` kommt aus canEditFor()', () => {
  const zustand = { id: 9, name: 'Novalgin', prn: 1, prn_dose_qty: 1, prn_min_interval_hours: 6, dosage_text: '500 mg' };
  mitView('meds', { meId: 1, personId: 1, list: [zustand], logsByMed: { 9: [] }, __reset: { list: [], logsByMed: {} } }, () => {
    assert.match(health.prnRowMarkup(zustand, 'meds', true), /data-prn-take/);
    const html = health.prnRowMarkup(zustand, 'meds', false);
    assert.doesNotMatch(html, /data-prn-take/);
    assert.match(html, /Novalgin/);
  });
  // Und die Verdrahtung dieses `own`: prnScope() fragt canEditFor(), also
  // faellt der Knopf bei `health: read` mit derselben Antwort weg.
  assert.match(healthFn('prnScope'), /own: canEditFor\(/);
});

// -------------------------------------------------------------------------
// Laborwerte
// -------------------------------------------------------------------------

const befund = (over = {}) => ({
  id: 14, report_date: '2026-05-04', lab_name: 'Labor Nord', note: 'Routine',
  results: [{ id: 3, analyte: 'Ferritin', value_num: 88, unit: 'ng/ml', ref_low: 30, ref_high: 300, flag: 'normal' }],
  ...over,
});

test('Befund-Detail mit `health: read`: kein Bearbeiten, die Tabelle steht vollstaendig', () => {
  mitView('labs', { meId: 1, personId: 1, reports: [befund()], selectedReportId: 14, trendAnalyte: null, __reset: { reports: [], selectedReportId: null } }, () => {
    withAccess({ health: 'write' }, () => {
      assert.match(health.labDetailMarkup(), /data-action="lab-edit" data-report-id="14"/);
    });
    withAccess({ health: 'read' }, () => {
      const html = health.labDetailMarkup();
      assert.doesNotMatch(html, /data-action="lab-edit"/);
      assert.match(html, /Ferritin/);
      assert.match(html, /Labor Nord/);
      assert.match(html, /health\.labs\.col\.reference/);
    });
  });
});

// -------------------------------------------------------------------------
// Aktivitaet und Vorsorge
// -------------------------------------------------------------------------

test('Aktivitaetszeile: Bearbeiten weg, Strecke und Dauer bleiben', () => {
  const zeile = { id: 21, type: 'run', performed_at: '2026-06-14', duration_min: 45, distance_km: 8.2, calories: 510, note: 'Waldweg' };
  assert.match(health.activityRowMarkup(zeile, true), /data-activity-edit="21"/);
  const html = health.activityRowMarkup(zeile, false);
  assert.doesNotMatch(html, /data-activity-edit/);
  assert.doesNotMatch(html, /<button/);
  assert.match(html, /Waldweg/);
  assert.match(html, /health\.activity\.unit\.km/);
});

test('Vorsorge-Zeile: Bearbeiten weg, Datum und Charge bleiben', () => {
  const zeile = { id: 33, given_on: '2026-03-02', dose_number: 2, provider: 'Dr. Meier', batch: 'X-42', note: 'gut vertragen' };
  assert.match(health.preventionRowMarkup(zeile, true), /data-prevention-edit="33"/);
  const html = health.preventionRowMarkup(zeile, false);
  assert.doesNotMatch(html, /data-prevention-edit/);
  assert.doesNotMatch(html, /<button/);
  assert.match(html, /X-42/);
  assert.match(html, /gut vertragen/);
});

// -------------------------------------------------------------------------
// Uebersicht
// -------------------------------------------------------------------------

test('Schnellerfassung der Uebersicht faellt bei `health: read` ganz weg', () => {
  mitView('overview', { meId: 1, personId: 1, __reset: {} }, () => {
    withAccess({ health: 'write' }, () => {
      const html = health.quickCaptureMarkup();
      assert.match(html, /data-action="ov-add-vital"/);
      assert.match(html, /data-action="ov-add-activity"/);
      assert.match(html, /data-action="ov-go-meds"/);
    });
    withAccess({ health: 'read' }, () => {
      assert.equal(health.quickCaptureMarkup(), '',
        'drei Knoepfe, die nur anlegen - es bleibt nichts zu zeigen');
    });
  });
});

test('Faellige Dosis der Uebersicht traegt dieselbe Form wie im Medikamente-Tab', () => {
  mitView('overview', { meId: 1, personId: 1, meds: [medikament()], logsByMed: {}, __reset: { meds: [] } }, () => {
    assert.match(health.overviewDueRowMarkup(dosis(), medikament(), null, true), /data-ov-dose-take/);
    const html = health.overviewDueRowMarkup(dosis(), medikament(), null, false);
    assert.doesNotMatch(html, /data-ov-dose-take|data-ov-dose-skip/);
    assert.match(html, /<span class="health-dose__status">health\.meds\.status\.pending<\/span>/);
    assert.match(html, /Ibuprofen/);
  });
  // Und das `own`, das diese Zeile bekommt, ist dieselbe Frage.
  assert.match(healthFn('overviewDueMarkup'), /const own = canEditFor\(overview\.personId, overview\.meId\);/);
});

// -------------------------------------------------------------------------
// Zyklus - die zweite Frage
// -------------------------------------------------------------------------

const periode = (over = {}) => ({ id: 55, start_date: '2026-06-01', end_date: '2026-06-05', ...over });

test('cycleCanEdit(): eigene Ansicht UND Schreibrecht, nicht eines von beiden', () => {
  mitView('cycle', { meId: 1, personId: 1, __reset: {} }, () => {
    withAccess({ health: 'write' }, () => assert.equal(health.cycleCanEdit(), true));
    withAccess({ health: 'read' }, () => assert.equal(health.cycleCanEdit(), false));
  });
  mitView('cycle', { meId: 1, personId: 4, __reset: { personId: null } }, () => {
    withAccess({ health: 'write' }, () => assert.equal(health.cycleCanEdit(), false, 'fremde Ansicht'));
  });
});

test('Das Recht steckt NICHT in isOwnCycleView() - sonst verschwaende auch Lesbares', () => {
  // `own` traegt im Zyklus-Tab den Intimitaets-Marker, das PMS-Fenster und die
  // Formulierung der Statistik-Herkunft. Waere das Modulrecht dort eingebaut,
  // haette ein Nur-lesen-Mitglied seine eigenen Marker verloren.
  const fn = healthFn('isOwnCycleView');
  assert.doesNotMatch(fn, /readOnly\(\)/);
  assert.match(fn, /cycle\.personId === cycle\.meId/);
  assert.match(healthFn('cycleCanEdit'), /isOwnCycleView\(\) && !readOnly\(\)/);
});

test('Zyklus-Kalender: die Zelle verliert ihren Knopf, der Herz-Marker bleibt', () => {
  const zustand = {
    meId: 1, personId: 1, anchor: '2026-06-15', periods: [periode()],
    logs: [{ id: 2, log_date: '2026-06-03', intimacy: 'protected', symptoms: null }],
    settings: {}, likelihoodSymptom: null, __reset: { periods: [], logs: [] },
  };
  mitView('cycle', zustand, () => {
    const schreibend = health.cycleCalendarMarkup(true, null, true);
    assert.match(schreibend, /data-cycle-day="2026-06-03"/);
    assert.match(schreibend, /cycle-cal__intimacy-icon/);

    const lesend = health.cycleCalendarMarkup(true, null, false);
    assert.doesNotMatch(lesend, /data-cycle-day/);
    assert.doesNotMatch(lesend, /<button class="cycle-cal__day/);
    // DIE LESENDE HAELFTE - sie ist der Grund fuer den zweiten Parameter:
    assert.match(lesend, /cycle-cal__intimacy-icon/,
      'der eigene Marker gehoert zum Lesbaren und darf mit dem Recht nicht fallen');
    assert.match(lesend, /class="cycle-cal__day is-menstruation"/,
      'die Phasenfarbe ist Auskunft und bleibt an der Zelle');
    assert.match(lesend, /<span class="cycle-cal__num">3<\/span>/);
    assert.match(lesend, /health\.cycle\.calendar\.title/);
  });
});

// Der dritte Fall, den es vor P2 nicht gab. `canEdit` war per Default `own`,
// also hiess "nicht bedienbar" immer "fremde Ansicht" - und die versteckt ihre
// Zellen per `aria-hidden`, was dort stimmt. Ein Nur-lesen-Mitglied bringt die
// EIGENE Ansicht ohne Recht, und faellt die auf denselben Zweig, ist der eigene
// Kalender fuer einen Screenreader stumm: keine Tageszahl, kein Datum, nichts.
// Die Nur-lesen-Regel nimmt die Handlung, nicht die Auskunft.
test('Zyklus-Kalender: die eigene Zelle bleibt ansagbar, die fremde bleibt versteckt (#1265 P2)', () => {
  const zustand = {
    meId: 1, personId: 1, anchor: '2026-06-15', periods: [periode()],
    logs: [], settings: {}, likelihoodSymptom: null, __reset: { periods: [], logs: [] },
  };
  mitView('cycle', zustand, () => {
    const eigenLesend = health.cycleCalendarMarkup(true, null, false);
    assert.doesNotMatch(eigenLesend, /aria-hidden="true"[^>]*>\s*<span class="cycle-cal__num">/,
      'die eigene Zelle darf nicht per aria-hidden verschwinden - sie ist lesbar, nur nicht bedienbar');
    assert.match(eigenLesend, /aria-label="[^"]+"[^>]*>\s*<span class="cycle-cal__num">3</,
      'ohne Datums-Label nennt die Zelle einem Screenreader gar nichts');

    const fremd = health.cycleCalendarMarkup(false, null, false);
    assert.match(fremd, /aria-hidden="true"/,
      'die fremde Ansicht versteckt ihre Zellen weiter - Bestand, und hier richtig');
  });
});

test('Zyklus-Historie und -Fuss: Bearbeiten, Einfuhr und Einstellungen weg, der Export bleibt', () => {
  mitView('cycle', { meId: 1, personId: 1, periods: [periode()], logs: [], settings: {}, __reset: { periods: [], logs: [] } }, () => {
    assert.match(health.cycleHistoryMarkup(true), /data-cycle-edit="55"/);
    const historie = health.cycleHistoryMarkup(false);
    assert.doesNotMatch(historie, /data-cycle-edit/);
    assert.doesNotMatch(historie, /<button/);
    assert.match(historie, /health\.cycle\.history\.title/);

    const fussSchreibend = health.cycleFooterMarkup(true);
    assert.match(fussSchreibend, /data-action="cycle-import"/);
    assert.match(fussSchreibend, /data-action="cycle-settings"/);
    assert.match(fussSchreibend, /cycle-discovery-hint/);

    const fuss = health.cycleFooterMarkup(false);
    assert.doesNotMatch(fuss, /data-action="cycle-import"|data-action="cycle-settings"/);
    assert.doesNotMatch(fuss, /cycle-discovery-hint/,
      'der Hinweis erklaert das Antippen einer Zelle, die es jetzt nicht mehr gibt');
    assert.match(fuss, /health\/export\/cycle/, 'der CSV-Export liest nur - er bleibt');
  });
});

test('„Heute"-Einblendung: bei `read` bleibt der Satz, der Knopf geht', () => {
  const vorhersage = { isPregnant: false, phase: 'luteal', cycleDay: 29, daysUntilNext: 0, hasData: true };
  mitView('cycle', { meId: 1, personId: 1, periods: [periode()], logs: [], settings: {}, __reset: { periods: [], logs: [] } }, () => {
    const schreibend = health.cycleBubbleMarkup(vorhersage, null, true);
    assert.match(schreibend, /data-action="cycle-bubble-start-period"/);
    assert.match(schreibend, /health\.cycle\.bubble\.periodToday/);

    const lesend = health.cycleBubbleMarkup(vorhersage, null, false);
    assert.doesNotMatch(lesend, /<button/);
    assert.doesNotMatch(lesend, /cycle-bubble-start-period/);
    assert.match(lesend, /<p class="cycle-bubble__line2">health\.cycle\.bubble\.periodToday<\/p>/,
      'die Auskunft bleibt als Zeile stehen, nicht als toter Knopf');
    assert.match(lesend, /health\.cycle\.bubble\.line1/);
  });
  // Und mit noch offener Periode derselbe Schnitt.
  mitView('cycle', { meId: 1, personId: 1, periods: [periode({ end_date: null, start_date: '2026-06-01' })], logs: [], settings: {}, __reset: { periods: [], logs: [] } }, () => {
    assert.match(health.cycleBubbleMarkup(vorhersage, null, true), /data-action="cycle-bubble-end-period"/);
    const lesend = health.cycleBubbleMarkup(vorhersage, null, false);
    assert.doesNotMatch(lesend, /<button/);
    assert.match(lesend, /health\.cycle\.bubble\.periodStillOpen/);
  });
});

test('Schwangerschafts-Hero: der Einstellungsknopf haengt am Recht, die SSW nicht', () => {
  const vorhersage = { isPregnant: true, pregnancy: { hasDue: true, week: 24, day: 3, trimester: 2, daysUntilDue: 112, progress: 0.6, dueDate: '2026-10-05', overdue: false } };
  assert.match(health.cyclePregnancyMarkup(vorhersage, true), /data-action="cycle-settings"/);
  const lesend = health.cyclePregnancyMarkup(vorhersage, false);
  assert.doesNotMatch(lesend, /data-action="cycle-settings"/);
  assert.doesNotMatch(lesend, /<button/);
  assert.match(lesend, /health\.cycle\.pregnancy\.trimester/);
  assert.match(lesend, /health\.cycle\.pregnancy\.paused/);
});

test('renderCycleShell() reicht beide Antworten getrennt weiter', () => {
  const fn = healthFn('renderCycleShell');
  assert.match(fn, /const own = isOwnCycleView\(\);/);
  assert.match(fn, /const darf = cycleCanEdit\(\);/);
  // Der Kalender bekommt beide: `own` fuer das Lesbare, `darf` fuer den Knopf.
  assert.match(fn, /cycleCalendarMarkup\(own, pms, darf\)/);
  // Alles, was nur handelt, haengt an `darf`.
  // Seit R17 steht die Heute-Karte an zwei moeglichen Stellen (schmal vor den
  // Kennzahlen, breit unter der Legende) - an `darf` haengt jede von ihnen.
  const todayCalls = fn.match(/\$\{[^}]*cycleTodayActionsMarkup\([^)]*\)[^}]*\}/g) ?? [];
  assert.equal(todayCalls.length, 3, 'Reichweite: Schwangerschaft, schmal, breit');
  for (const call of todayCalls) assert.match(call, /^\$\{darf (\? |&& )/, `${call} haengt an darf`);
  assert.match(fn, /cycleHistoryMarkup\(darf\)/);
  assert.match(fn, /cycleFooterMarkup\(darf\)/);
  assert.match(fn, /cyclePregnancyMarkup\(prediction, darf\)/);
  assert.match(fn, /action: darf/, 'auch der Leerzustands-CTA');
  assert.ok(!/cycleHistoryMarkup\(own\)|cycleFooterMarkup\(own\)|cycleTodayActionsMarkup\(own\)/.test(fn),
    'kein Rest, der noch die alte Frage stellt');
});

// -------------------------------------------------------------------------
// Die zweite und dritte Verteidigungslinie
// -------------------------------------------------------------------------

test('READ_SAFE_ACTIONS ist eine Positivliste und enthaelt nur lesende Aktionen', () => {
  const erlaubt = [...health.READ_SAFE_ACTIONS].sort();
  // R16: dazu der dritte Tabwechsel (Kartentitel "Letzte Vitalwerte") und der
  // CSV-Export im Kopf - ein Download, der schon als Karte ohne Schreibrecht
  // offenstand (dort als blosse Links, deshalb ohne `data-action`).
  assert.deepEqual(erlaubt, ['cancel', 'health-export', 'ov-go-cycle', 'ov-go-meds', 'ov-go-vitals'],
    'Dialog schliessen, drei Tabwechsel und der Export-Dialog - alles andere dieser Seite schreibt');

  // Und die Gegenprobe gegen den Quelltext: JEDE andere `data-action` der Seite
  // ist damit gesperrt. Kaeme morgen eine dazu, waere sie es auch - das ist der
  // ganze Sinn der Positivliste.
  const alle = new Set([...HEALTH_CODE.matchAll(/data-action="([a-z0-9-]+)"/g)].map((m) => m[1]));
  assert.ok(alle.size >= 20, `nur ${alle.size} Aktionen gefunden - der Scanner misst nichts`);
  const schreibend = [...alle].filter((a) => !health.READ_SAFE_ACTIONS.has(a));
  assert.ok(schreibend.includes('cycle-start-period'));
  assert.ok(schreibend.includes('med-delete'));
  assert.ok(schreibend.includes('res-add'));
  assert.ok(schreibend.includes('sched-add'));
  for (const name of erlaubt) assert.ok(alle.has(name), `${name} steht in der Liste, aber nicht im Markup`);
});

test('WRITE_HOOKS nennt jeden schreibenden Bedienhaken ohne `data-action`', () => {
  const genannt = new Set(health.WRITE_HOOKS.split(',').map((s) => s.trim().replace(/^\[|\]$/g, '')));
  // Die Haken, die `health.js` wirklich an eine Schreibfunktion bindet. Kaeme
  // einer dazu, ohne dass er hier steht, faende ihn der Riegel nicht - deshalb
  // steht die Liste zweimal und wird verglichen.
  const erwartet = [
    'data-med-edit', 'data-medlog-edit', 'data-dose-take', 'data-dose-skip',
    'data-ov-dose-take', 'data-ov-dose-skip', 'data-prn-take',
    'data-activity-edit', 'data-prevention-edit', 'data-vital-edit',
    'data-cycle-day', 'data-cycle-edit',
    'data-nutrition-edit', 'data-nutrition-target',
  ];
  assert.deepEqual([...genannt].sort(), [...erwartet].sort());
  for (const hook of erwartet) {
    assert.ok(HEALTH_CODE.includes(hook), `${hook} steht im Riegel, aber nicht mehr im Markup`);
  }
  // Und die lesenden Haken stehen ausdruecklich NICHT drin - ein Riegel, der
  // sie mitnaehme, sperrte den Berechtigten aus.
  for (const lesend of ['data-range', 'data-step', 'data-person-id', 'data-vital-nav',
    'data-cycle-month', 'data-likelihood-symptom', 'data-export-area']) {
    assert.ok(!genannt.has(lesend), `${lesend} liest nur und gehoert nicht in den Riegel`);
  }
});

test('readOnlyLatch(): Erfassungsphase, Positivliste, und das Fasten-Panel bleibt aussen vor', () => {
  const fn = healthFn('readOnlyLatch');
  assert.match(fn, /if \(!readOnly\(\)\) return;/);
  assert.match(fn, /data-fasting-root/,
    'pages/health-fasting.js fragt selbst und zeigt bei read eine vollstaendige Leseansicht');
  assert.match(fn, /READ_SAFE_ACTIONS\.has/);
  assert.match(fn, /closest\(WRITE_HOOKS\)/);
  // Erfassungsphase: ein Riegel in der Blasenphase kaeme nach dem Listener am
  // Knopf selbst - der Dialog stuende dann schon.
  assert.match(HEALTH_CODE, /addEventListener\('click', readOnlyLatch, true\)/);
});

test('der Riegel steht in jeder Verdrahtung VOR der ersten Schreib-Aktion', () => {
  const faelle = [
    ['wireCycle', 'data-cycle-day'],
    ['wireMeds', 'data-med-edit'],
    ['wireActivity', 'data-activity-edit'],
    ['wirePrevention', 'data-prevention-edit'],
    ['renderDetail', 'data-vital-edit'],
  ];
  for (const [name, ersteAktion] of faelle) {
    const fn = healthFn(name);
    const riegel = fn.indexOf('if (readOnly()) return;');
    const aktion = fn.indexOf(ersteAktion);
    assert.ok(riegel > 0, `${name}() hat keinen Riegel`);
    assert.ok(aktion > 0, `${name}() verdrahtet ${ersteAktion} nicht mehr`);
    assert.ok(riegel < aktion, `${name}(): der Riegel steht hinter ${ersteAktion}`);
  }
  // Zwei Tabs mischen lesende und schreibende Verdrahtungen - dort waere ein
  // `return` das falsche Werkzeug (er naehme den Trend-Umschalter und die
  // Kachel-Navigation mit), deshalb je eine Bedingung.
  for (const name of ['wireLabs', 'wireOverview', 'wireLabsDetail']) {
    assert.match(healthFn(name), /if \(!readOnly\(\)\) \{/, `${name}() riegelt seine Schreibzweige nicht ab`);
  }
  assert.ok(!/function wireLabs\(\)[\s\S]*?if \(readOnly\(\)\) return;/.test(healthFn('wireLabs')),
    'ein `return` wuerde hier den lesenden Analyt-Umschalter mit abschneiden');
});

// Der Bedarfs-Countdown ist Auskunft, kein Knopf. `wirePrn()` haengt nicht nur
// den Klick an, sondern startet ueber `ensurePrnTicker()` auch das Intervall,
// das `[data-prn-countdown]` jede Minute nachfuehrt und die Zeile umschaltet,
// sobald die Sperrfrist abgelaufen ist.
//
// `prnRowMarkup()` rendert diesen Countdown fuer JEDEN - nur der Knopf haengt
// an `own`. Steht `wirePrn()` hinter dem Riegel, sieht ein Nur-lesen-Mitglied
// also "noch 20 Minuten" und dann fuer immer weiter "noch 20 Minuten": der
// Zaehler friert auf dem Wert des ersten Rendervorgangs ein und springt auch
// nicht auf "bereit", wenn die Frist wirklich ablaeuft.
test('der Bedarfs-Ticker laeuft auch ohne Schreibrecht weiter (#1265 P2)', () => {
  const meds = healthFn('wireMeds');
  const riegel = meds.indexOf('if (readOnly()) return;');
  const ticker = meds.indexOf('wirePrn(');
  assert.ok(riegel > 0 && ticker > 0, 'wireMeds(): Riegel oder wirePrn-Aufruf nicht gefunden');
  assert.ok(ticker < riegel,
    'wireMeds(): wirePrn() startet den Countdown-Ticker und steht hinter dem Riegel - '
    + 'ein Nur-lesen-Mitglied bekommt damit einen eingefrorenen Zaehler statt einer Auskunft');

  // Derselbe Aufruf in wireOverview darf nicht im Schreibzweig liegen.
  const ov = healthFn('wireOverview');
  const ovTicker = ov.indexOf('wirePrn(');
  const ovZweig = ov.indexOf('if (!readOnly()) {');
  assert.ok(ovTicker > 0, 'wireOverview(): wirePrn-Aufruf nicht gefunden');
  assert.ok(ovZweig < 0 || ovTicker < ovZweig,
    'wireOverview(): wirePrn() liegt im Schreibzweig und friert den Countdown der Uebersicht ein');

  // Und der Grund, warum das gefahrlos ist: ohne Knopf findet die Verdrahtung
  // schlicht nichts. Faellt diese Zusicherung, ist der Aufruf nicht mehr sicher
  // unbedingt zu machen und die beiden oben muessten neu gedacht werden.
  assert.match(healthFn('wirePrn'), /querySelectorAll\('\[data-prn-take\]'\)/,
    'wirePrn() muss seine Knoepfe suchen statt sie vorauszusetzen');
});

test('jeder Einstieg in einen Schreibweg fragt selbst noch einmal', () => {
  // Die dritte Linie: ein Aufruf, der gar nicht ueber einen Knopf kommt (FAB,
  // Deep-Link, ein Aufrufer, den es morgen gibt), findet denselben Riegel.
  for (const name of [
    'openVitalModal', 'openMedModal', 'openMedLogModal', 'openLabModal',
    'openActivityModal', 'openPreventionModal', 'openPeriodModal', 'openDayLogModal',
    'openCycleSettingsModal', 'openCycleImportModal',
    'handleDose', 'handleOverviewDose', 'handlePrnDose',
    'cycleStartPeriodToday', 'cycleEndPeriodToday',
  ]) {
    const fn = healthFn(name);
    const riegel = fn.indexOf('if (readOnly()) return;');
    assert.ok(riegel >= 0 && riegel < 120, `${name}() fragt nicht (oder zu spaet) nach dem Recht`);
  }
});

test('der Fasten-Tab fragte schon immer selbst - und tut es weiter', () => {
  // Er ist der einzige Teil des Moduls, der die Regel vor #1265 erfuellte:
  // `writable` verlangt ausdruecklich das Schreibrecht auf `health`, und jeder
  // Schreibweg geht zusaetzlich durch requireFastingWrite(). Deshalb nimmt ihn
  // readOnlyLatch() aus - und deshalb steht hier die Zusicherung, dass die
  // Grundlage dafuer noch da ist.
  const seite = readFileSync(new URL('../public/pages/health-fasting.js', import.meta.url), 'utf8');
  assert.match(seite, /const writable = [^\n]*moduleAccess\('health'\) === 'write'/);
  const controls = readFileSync(new URL('../public/components/fasting-controls.js', import.meta.url), 'utf8');
  assert.match(controls, /moduleAccess\('health'\) !== 'write'\) throw new Error\('FASTING_READ_ONLY'\)/);
});

test('Gesundheit hat keine Display-Ausnahme - der Server gibt keine her', () => {
  const display = readFileSync(new URL('../server/display-scopes.js', import.meta.url), 'utf8');
  const routen = display.slice(display.indexOf('DISPLAY_WRITE_ROUTES = Object.freeze(['));
  const liste = routen.slice(0, routen.indexOf(']);'));
  assert.ok(!/health/.test(liste),
    'gaebe es hier eine Route, brauchte die betroffene Stelle ein actingAsDisplay() VOR der Modulregel');
});

// =========================================================================
// #1265 P6: Haushaltshilfe
//
// Ein eigener Abschnitt mit eigenem Import, damit er neben den Paketen der
// anderen Seiten steht, ohne deren Zeilen zu beruehren. Gemessen wird wie in
// P1/P2 am ERZEUGTEN MARKUP und im Paar - bei `read` weg, bei `write` da -,
// jeweils mit einem Inhalt, den nur ein wirklich gelaufener Renderer ausgibt.
//
// ZWEI QUELLEN FUER DIESELBE ANTWORT. Die Besuchszeilen haengen schon an
// Serverfeldern (`can_edit`, `can_delete`, `can_mark_paid`, #1135/#1136), und
// der Server rechnet das Modulrecht dort ein. Die Fixtures unten tragen deshalb
// ABSICHTLICH veraltete Felder (`can_*: true` bei `read`): die Seite muss auch
// dann schweigen, wenn die letzte Antwort aelter ist als der Rechtewechsel.
//
// DIE KREUZABHAENGIGKEIT. Der Einsatz-Dialog laedt einen Beleg hoch, und das
// ist `POST /documents` - ein Schreibweg in ein FREMDES Modul. Er wird an
// beiden Enden gemessen: am Markup (`receiptFieldHtml`) und am gefahrenen
// Absenden, das die Anfrage dann UNTERLASSEN muss.
//
// KEIN WANDTABLETT, KEIN PERSONAL. Ein Display erreicht die Seite nicht (der
// letzte Test dieses Abschnitts), und ein Konto der Haushaltshilfe meldet sich
// auf keinem Weg an (`canSignIn` in server/auth.js, `npm run test:staff-sign-in`).
// Die Modulregel nimmt hier also niemandem etwas weg, was der Server ihm gaebe.
// =========================================================================

const { __test: hk } = await import('../public/pages/housekeeping.js');

const HK_CSS = readFileSync(new URL('../public/styles/housekeeping.css', import.meta.url), 'utf8');
const LAYOUT_CSS = readFileSync(new URL('../public/styles/layout.css', import.meta.url), 'utf8');

/**
 * Ein Container wie in test-housekeeping-ui.js, der zusaetzlich mitschreibt,
 * WELCHE Knoepfe ein Renderer verdrahten will. Die Verdrahtung hat kein Markup;
 * ohne diese Spur liefe „bei read haengt nichts" ins Leere.
 */
// Die Aufgabenliste verdrahtet seit R16 den Wisch; dessen einmaliger Hinweis
// (`maybeShowSwipeHint`, utils/swipe-row.js) liest den Pfad der Seite.
globalThis.location = globalThis.location ?? { pathname: '/housekeeping' };

function hkContainer() {
  return {
    html: '',
    gefragt: [],
    isConnected: true,
    replaceChildren() { this.html = ''; },
    insertAdjacentHTML(_position, markup) { this.html += markup; },
    querySelector(sel) { this.gefragt.push(sel); return null; },
    querySelectorAll(sel) { this.gefragt.push(sel); return []; },
  };
}

/** Rechte setzen und die Seite in einen bekannten Ausgangszustand bringen. */
function hkState(patch) {
  const s = hk.state();
  Object.assign(s, {
    tab: 'dashboard', dashboard: {}, tasks: [], templates: [], workers: [],
    recentVisits: [], reports: [], visitReport: null, selectedStaffId: null,
    staffVisits: [], currency: 'EUR', reportMonth: null, currentMonth: '2026-08',
  }, patch);
  return s;
}

/**
 * Faehrt `fn` mit einem API-Stub, der jede Anfrage mitschreibt, und mit einem
 * Toast, der nichts tut - `window.yuvomi` ist im Mini-DOM ein leeres Objekt,
 * und ein Fehlerpfad der Seite ruft `showToast` ohne `?.` davor.
 */
async function mitHkApi(fn, antworten = {}) {
  const anfragen = [];
  const vorher = { api: globalThis.__apiStub, toast: globalThis.window.yuvomi?.showToast };
  const rec = (methode) => async (url, body) => {
    anfragen.push(`${methode} ${url}`);
    return antworten[`${methode} ${url}`] ?? { data: null, body };
  };
  globalThis.__apiStub = { get: rec('GET'), post: rec('POST'), put: rec('PUT'), patch: rec('PATCH'), delete: rec('DELETE') };
  globalThis.window.yuvomi = globalThis.window.yuvomi ?? {};
  globalThis.window.yuvomi.showToast = () => {};
  try {
    await fn(anfragen);
  } finally {
    globalThis.__apiStub = vorher.api;
    globalThis.window.yuvomi.showToast = vorher.toast;
  }
  return anfragen;
}

/**
 * Faengt, was die Seite `openModal()` uebergibt (der Loader-Stub reicht es an
 * `__openModal`). Die Dialoge dieser Seite oeffnen synchron.
 */
function mitModal(fn) {
  const geoeffnet = [];
  const vorher = globalThis.__openModal;
  globalThis.__openModal = (opts) => { geoeffnet.push(opts); };
  try { fn(); } finally { globalThis.__openModal = vorher; }
  return geoeffnet;
}

const hkBesuch = (over = {}) => ({
  id: 12, worker_id: 7, check_in: '2026-08-06T09:00:00.000Z', total_amount: 40,
  daily_rate: 40, extras: 0, paid_at: null, rate_type: 'daily',
  can_edit: true, can_delete: true, can_mark_paid: true, can_mark_unpaid: false, ...over,
});

// -------------------------------------------------------------------------
// Die Frage selbst
// -------------------------------------------------------------------------

test('housekeeping.readOnly() folgt dem Rechte-Store - und `housekeeping` ist ein Modulname, den es gibt', () => {
  // Im Paar, wie bei der Gesundheit: ginge der Name ins Leere, fiele
  // moduleAccess() still auf `write` durch und readOnly() bliebe bei `read` false.
  assert.equal(hk.readOnly(), false, 'ohne Rechte fail-open');
  withAccess({ housekeeping: 'read' }, () => assert.equal(hk.readOnly(), true));
  withAccess({ housekeeping: 'write' }, () => assert.equal(hk.readOnly(), false));
  withAccess({ documents: 'read' }, () => assert.equal(hk.readOnly(), false,
    'ein FREMDES Modul auf read sperrt die Seite nicht - nur den Beleg'));
});

// -------------------------------------------------------------------------
// Uebersicht: Check-Knopf, Leerzustand, letzte Besuche
// -------------------------------------------------------------------------

test('Check-Knopf mit `housekeeping: read`: eine offene Sitzung bleibt als Zeichen, sonst faellt er weg', () => {
  hkState({
    workers: [
      { id: 7, display_name: 'Ana', current_session: { check_in: '2026-08-06T08:30:00Z' } },
      // War heute da, ist aber gegangen: die Zeile nennt den Einsatz, „gerade
      // im Haus" waere falsch. Das Zeichen haengt an der OFFENEN Sitzung.
      { id: 8, display_name: 'Bea', current_session: null, today_session: { check_in: '2026-08-06T07:00:00Z' } },
      { id: 9, display_name: 'Cem', current_session: null, today_session: null },
    ],
  });

  const lesen = withAccess({ housekeeping: 'read' }, () => hk.renderWorkerSummary());
  const [ana, bea, cem] = lesen.split('<section class="housekeeping-worker-strip">').slice(1);
  assert.equal((lesen.match(/data-worker-check=/g) ?? []).length, 0, 'kein Knopf, der ein- oder auscheckt');
  assert.doesNotMatch(lesen, /<button/, 'und auch sonst keiner');
  assert.match(ana, /<span class="housekeeping-check-small housekeeping-check-small--static" role="img" aria-label="dashboard\.housekeepingPresent">/,
    'die offene Sitzung bleibt als Zeichen, dessen Beschriftung den Zustand nennt');
  assert.doesNotMatch(ana, /disabled/, 'ein Zeichen, kein gesperrter Knopf');
  assert.doesNotMatch(bea, /housekeeping-check-small/, 'eine beendete Sitzung ist kein „gerade im Haus"');
  assert.match(bea, /housekeeping\.visitRecordedAt/, 'ihr Einsatz von heute steht weiter in der Zeile');
  assert.doesNotMatch(cem, /housekeeping-check-small/, 'ohne Sitzung gibt es keinen Zustand zu zeigen');
  assert.match(cem, /Cem/, 'der Renderer lief - die Person steht da');

  const schreiben = withAccess({ housekeeping: 'write' }, () => hk.renderWorkerSummary());
  assert.equal((schreiben.match(/data-worker-check=/g) ?? []).length, 3, 'mit Schreibrecht je Person ein Knopf');
  assert.match(schreiben, /housekeeping\.checkOut/);
  assert.match(schreiben, /housekeeping\.checkIn/);
  assert.doesNotMatch(schreiben, /housekeeping-check-small--static/, 'und kein Zeichen daneben');
});

test('Leere Uebersicht mit `housekeeping: read`: kein „Profil anlegen"', () => {
  hkState({ workers: [] });
  const lesen = withAccess({ housekeeping: 'read' }, () => hk.renderWorkerSummary());
  assert.doesNotMatch(lesen, /housekeeping-create-profile/);
  assert.match(lesen, /housekeeping\.noWorkerTitle/, 'die Auskunft bleibt');
  const schreiben = withAccess({ housekeeping: 'write' }, () => hk.renderWorkerSummary());
  assert.match(schreiben, /id="housekeeping-create-profile"/, 'mit Schreibrecht bleibt die Aktion - sonst maesse die Zeile oben nichts');
});

test('Uebersicht mit `housekeeping: read`: nur der Bericht wird verdrahtet, weder Check noch Bearbeiten', () => {
  hkState({
    workers: [{ id: 7, display_name: 'Ana', current_session: null }],
    recentVisits: [hkBesuch()],
  });
  const lesen = hkContainer();
  withAccess({ housekeeping: 'read' }, () => hk.renderDashboard(lesen));
  assert.ok(!lesen.gefragt.includes('[data-worker-check]'), 'der Check-Knopf wird nicht verdrahtet');
  assert.ok(!lesen.gefragt.includes('[data-edit-visit]'), 'das Bearbeiten nicht');
  assert.ok(lesen.gefragt.includes('[data-open-visit]'), 'der Bericht schon - er liest');
  assert.doesNotMatch(lesen.html, /data-edit-visit=/, 'die veralteten Felder (`can_edit: true`) bieten trotzdem nichts an');
  assert.match(lesen.html, /data-open-visit="12"/, 'der Besuch fuehrt zu seinem Bericht');

  const schreiben = hkContainer();
  withAccess({ housekeeping: 'write' }, () => hk.renderDashboard(schreiben));
  assert.ok(schreiben.gefragt.includes('[data-worker-check]'));
  assert.ok(schreiben.gefragt.includes('[data-edit-visit]'));
  assert.match(schreiben.html, /data-edit-visit="12"/);
});

test('Besuchszeile mit `housekeeping: read`: Bearbeiten und Loeschen weg, der Zahlstatus ohne Admin-Hinweis', () => {
  const offen = hkBesuch();
  const bezahlt = hkBesuch({ paid_at: '2026-08-07T10:00:00Z', can_edit: false, can_delete: false, can_mark_paid: false });
  withAccess({ housekeeping: 'read' }, () => {
    assert.match(hk.visitEditActionHtml(offen, 'x'), /data-open-visit="12"/, 'statt Bearbeiten der Weg zum Bericht');
    assert.doesNotMatch(hk.visitEditActionHtml(offen, 'x'), /data-edit-visit/);
    assert.equal(hk.visitDeleteActionHtml(offen, 'x'), '');
    // „nur durch einen Admin" ist bei `read` nicht der Grund - dort fehlen die
    // Knoepfe an jedem Besuch, bezahlt oder nicht.
    assert.equal(hk.visitPaymentMeta(bezahlt), 'housekeeping.paymentPaid');
    assert.equal(hk.visitPaymentMeta(offen), 'housekeeping.paymentPending');
  });
  withAccess({ housekeeping: 'write' }, () => {
    assert.match(hk.visitEditActionHtml(offen, 'x'), /data-edit-visit="12"/);
    assert.match(hk.visitDeleteActionHtml(offen, 'x'), /data-delete-visit="12"/);
    assert.match(hk.visitPaymentMeta(bezahlt), /housekeeping\.settledAdminOnly/,
      'mit Schreibrecht nennt die Zeile weiter, warum ein bezahlter Besuch gesperrt ist');
  });
});

// -------------------------------------------------------------------------
// Aufgaben
// -------------------------------------------------------------------------

// Re-Critique 2026-09-27 (R11 H6): ein Tipp auf die Aufgabenzeile tat nichts,
// mobil war der Stift das einzige Ziel. Wie die Geburtstagszeile (R8) ist die
// Hauptspalte mit Schreibrecht jetzt der Knopf zum Bearbeiten. Bei `read`
// verspricht die Spalte kein Bearbeiten.
//
// R16 (Critique 2026-10-05, P1 Bausteine): der Stift doppelte genau diesen
// Knopf und ist weg, der Papierkorb steht im Dialogfuss und auf dem Wisch.
// Die Zeile fuehrt KEINE Aktionszone mehr.
test('H6: die Aufgabenzeile der Haushaltshilfe oeffnet mit Schreibrecht das Bearbeiten - lesend verspricht sie nichts', () => {
  hkState({
    tasks: [{ id: 3, name: 'Fenster putzen', area: 'Wohnzimmer', frequency_days: 14, urgency_status: 'today', last_completed: '2026-07-01' }],
  });
  const schreiben = hkContainer();
  withAccess({ housekeeping: 'write' }, () => hk.renderTasks(schreiben));
  const haupt = schreiben.html.match(/<button type="button" class="list-row__main list-row__main--interactive[^"]*" data-edit-task="3">([\s\S]*?)<\/button>/);
  assert.ok(haupt, 'die Hauptspalte ist ein Knopf mit dem Bearbeiten-Ziel der Zeile');
  assert.match(haupt[1], /Fenster putzen/, 'er traegt den Namen');
  assert.match(haupt[1], /housekeeping\.dueToday/, 'und die Metazeile samt Dringlichkeit');
  assert.doesNotMatch(haupt[1], /<(?:h\d|p|div)\b/, 'in einem Knopf steht nur Phrasing-Inhalt');
  assert.equal(schreiben.html.match(/data-edit-task="3"/g).length, 1, 'ein Bearbeiten-Ziel je Zeile, nicht zwei mit derselben Wirkung');
  assert.doesNotMatch(schreiben.html, /row-action|list-row__actions|data-delete-task/, 'keine Zeilenaktion: Loeschen steht im Dialog und auf dem Wisch');
  assert.match(schreiben.html, /<div class="swipe-row" data-swipe-id="3">[\s\S]*?swipe-reveal--done swipe-reveal--leading[\s\S]*?swipe-reveal--delete swipe-reveal--trailing/,
    'die Wischflaechen: erledigen am Zeilenanfang, loeschen am Zeilenende');
  assert.match(schreiben.html, /class="housekeeping-task__check check-ring"/, 'der Kreis ist der geteilte Abhakkreis');
  assert.ok(schreiben.gefragt.includes('[data-edit-task]'), 'die Zeile ist verdrahtet');
  assert.ok(schreiben.gefragt.includes('.swipe-row'), 'und der Wisch auch');

  const lesen = hkContainer();
  withAccess({ housekeeping: 'read' }, () => hk.renderTasks(lesen));
  assert.doesNotMatch(lesen.html, /list-row__main--interactive|data-edit-task/, 'lesend kein Bearbeiten-Versprechen');
  assert.match(lesen.html, /class="swipe-row swipe-row--static"/, 'lesend ohne Wisch-Chevron');
  assert.doesNotMatch(lesen.html, /swipe-reveal/, 'und ohne Wischflaechen');
  assert.ok(!lesen.gefragt.includes('.swipe-row'), 'die Geste ist lesend nicht verdrahtet');
  assert.match(lesen.html, /<h2 class="list-row__name">Fenster putzen<\/h2>/, 'die Zeile bleibt Auskunft mit Ueberschrift');
});

// Review PR #1673: wohin der Fokus nach dem Loeschen geht. Die Modal-Schicht
// sucht denselben Knopf wieder und kennt keinen Nachbarn - nach dem Loeschen
// blieb ihr nur die Seitenwurzel.
test('nach dem Loeschen aus dem Dialog bekommt die nachgerueckte Zeile den Fokus', () => {
  const echtesDocument = globalThis.document;
  const knopf = (id) => ({ dataset: { editTask: String(id) }, focus() { doc.activeElement = this; } });
  const liste = (ids) => { const k = ids.map(knopf); return { k, querySelectorAll: (sel) => (sel === '[data-edit-task]' ? k : []) }; };
  const body = { tagName: 'BODY' };
  const doc = { body, activeElement: body };
  globalThis.document = doc;
  try {
    // Die mittlere von drei Zeilen (Index 1) ist weg: die dritte rueckt nach.
    let content = liste([1, 3]);
    hk.focusTaskRowAfterDelete(content, 2, 1);
    assert.equal(doc.activeElement, content.k[1], 'die Zeile an der alten Stelle');

    // Es war die letzte: die neue letzte.
    doc.activeElement = body;
    content = liste([1, 2]);
    hk.focusTaskRowAfterDelete(content, 3, 2);
    assert.equal(doc.activeElement, content.k[1]);

    // Die Seitenwurzel (Rueckfall der Modal-Schicht) gilt als frei.
    doc.activeElement = { id: 'main-content' };
    hk.focusTaskRowAfterDelete(content, 3, 0);
    assert.equal(doc.activeElement, content.k[0]);

    // Der Dialog schliesst noch (Ausgangsanimation), das Neuzeichnen war
    // schneller: der Fokus in ihm ist keine Wahl des Nutzers.
    doc.activeElement = { id: '', closest: (sel) => (sel === '.modal-overlay--closing' ? {} : null) };
    hk.focusTaskRowAfterDelete(content, 3, 1);
    assert.equal(doc.activeElement, content.k[1]);

    // "Rueckgaengig" hat die Zeile zurueckgeholt: sie selbst.
    doc.activeElement = body;
    content = liste([1, 2, 3]);
    hk.focusTaskRowAfterDelete(content, 2, 1);
    assert.equal(doc.activeElement, content.k[1]);
    hk.focusTaskRowAfterDelete(content, 3, 0);
    assert.equal(doc.activeElement, content.k[1], 'ein gewaehlter Fokus bleibt, wo er ist');
  } finally {
    globalThis.document = echtesDocument;
  }
});

// Review PR #1673: `deleteTask()` klappt die Zeile aus und zeichnet die Liste
// ERST DANACH neu. Der Bearbeiten-Dialog rief `refocusAfterRender()` im selben
// Atemzug wie das Loeschen - die alte Zeile stand noch, der Fokus galt als
// heil, und das Neuzeichnen liess ihn fallen. `afterRepaint` laeuft nach dem
// Neuzeichnen und sieht die Liste ohne die Zeile.
test('deleteTask ruft afterRepaint erst nach dem Neuzeichnen der Liste', async () => {
  const { mock } = await import('node:test');
  const vorher = globalThis.__apiStub;
  mock.timers.enable({ apis: ['setTimeout'] });
  globalThis.__apiStub = { delete: async () => ({}) };
  try {
    const task = { id: 901, name: 'ZZ Fenster', area: 'Bad', frequency_days: 7, urgency_status: 'today', last_completed: '2026-07-01' };
    hkState({ tab: 'tasks', tasks: [task, { ...task, id: 902, name: 'ZZ Boden' }] });
    const content = hkContainer();
    const seen = [];
    withAccess({ housekeeping: 'write' }, () => {
      hk.renderTasks(content);
      assert.match(content.html, /ZZ Fenster/);
      hk.deleteTask(task, content, () => seen.push(content.html));
    });
    assert.equal(seen.length, 0, 'im selben Atemzug steht die alte Liste noch - kein Rueckruf');
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(seen.length, 1, 'nach dem Ausklappen und Neuzeichnen genau einmal');
    assert.doesNotMatch(seen[0], /ZZ Fenster/, 'der Rueckruf sieht die Liste OHNE die Zeile');
    assert.match(seen[0], /ZZ Boden/);
    // Das Undo-Fenster laeuft ab: der Server loescht, die Liste bleibt.
    mock.timers.runAll();
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(seen.length, 1);
  } finally {
    mock.timers.reset();
    if (vorher === undefined) delete globalThis.__apiStub; else globalThis.__apiStub = vorher;
    hkState({});
  }
});

test('Aufgaben-Tab mit `housekeeping: read`: kein Anlegen, kein Abhaken, keine Zeilenaktion - die Dringlichkeit bleibt', () => {
  hkState({
    templates: [{ key: 'kitchen', name: 'Kueche', area: 'Kueche', frequency_days: 7 }],
    tasks: [{ id: 3, name: 'Fenster putzen', area: 'Wohnzimmer', frequency_days: 14, urgency_status: 'overdue', last_completed: '2026-07-01' }],
  });
  const lesen = hkContainer();
  withAccess({ housekeeping: 'read' }, () => hk.renderTasks(lesen));
  for (const weg of ['data-template-index', 'housekeeping-task-form', 'data-complete-task', 'data-undo-task', 'data-edit-task', 'data-delete-task']) {
    assert.doesNotMatch(lesen.html, new RegExp(weg), `${weg} gehoert zu einem Schreibweg`);
  }
  assert.doesNotMatch(lesen.html, /<button/, 'auf diesem Tab schreibt jeder Knopf');
  assert.match(lesen.html, /Fenster putzen/, 'der Renderer lief - die Aufgabe steht da');
  assert.match(lesen.html, /housekeeping\.overdue/, 'und ihre Dringlichkeit, als Wort');
  assert.match(lesen.html, /housekeeping-task--overdue housekeeping-task--readonly/, 'und als Zustandsklasse (seit R10 faerbt sie nur das Wort), ohne die Spalte des Kreises');
  assert.deepEqual(lesen.gefragt, [], 'keine Verdrahtung - jede auf diesem Tab schreibt');

  const schreiben = hkContainer();
  withAccess({ housekeeping: 'write' }, () => hk.renderTasks(schreiben));
  for (const da of ['data-complete-task="3"', 'data-edit-task="3"', 'data-swipe-id="3"']) {
    assert.ok(schreiben.html.includes(da), `mit Schreibrecht steht ${da} da`);
  }
  // Die Liste ZUERST (Critique 2026-09-26): Vorlagen und Formular sitzen im
  // Anlegedialog hinter dem FAB, nicht mehr vor der Liste. Das Zuruecknehmen
  // ist der Toast nach dem Erledigen, kein Zeilenknopf mehr.
  for (const weg of ['data-template-index', 'housekeeping-task-form', 'data-undo-task']) {
    assert.doesNotMatch(schreiben.html, new RegExp(weg), `${weg} steht nicht mehr im Tab`);
  }
  assert.doesNotMatch(schreiben.html, /housekeeping-task--readonly/);
  assert.ok(schreiben.gefragt.includes('[data-complete-task]'));

  // Der Anlegedialog: bei `read` geht er gar nicht auf, mit Schreibrecht traegt
  // er die Vorlagen und das Formular.
  assert.deepEqual(mitModal(() => withAccess({ housekeeping: 'read' }, () => hk.openTaskCreateModal(schreiben))), [],
    'bei read oeffnet kein Anlegedialog');
  const [dialog] = mitModal(() => withAccess({ housekeeping: 'write' }, () => hk.openTaskCreateModal(schreiben)));
  assert.ok(dialog, 'mit Schreibrecht oeffnet er');
  for (const da of ['data-template-index="0"', 'id="housekeeping-task-form"']) {
    assert.ok(dialog.content.includes(da), `der Dialog traegt ${da}`);
  }
});

test('Anlegedialog: eine Vorlage, die schon als Aufgabe dasteht, schlaegt nichts mehr vor', () => {
  hkState({
    templates: [
      { key: 'a', name: 'Fenster putzen', area: 'Wohnzimmer', frequency_days: 14 },
      { key: 'b', name: 'Bad putzen', area: 'Bad', frequency_days: 7 },
    ],
    tasks: [{ id: 3, name: 'fenster putzen ', area: 'Wohnzimmer', frequency_days: 14, urgency_status: 'ok' }],
  });
  const [dialog] = mitModal(() => withAccess({ housekeeping: 'write' }, () => hk.openTaskCreateModal(hkContainer())));
  assert.doesNotMatch(dialog.content, /data-template-index="0"/, 'Fenster putzen steht schon in der Liste');
  assert.match(dialog.content, /data-template-index="1"/, 'der Index bleibt der der Vorlagenliste');
  hkState({ templates: [{ key: 'a', name: 'Fenster putzen', area: 'Wohnzimmer', frequency_days: 14 }],
    tasks: [{ id: 3, name: 'Fenster putzen', area: 'Wohnzimmer', frequency_days: 14, urgency_status: 'ok' }] });
  const [leer] = mitModal(() => withAccess({ housekeeping: 'write' }, () => hk.openTaskCreateModal(hkContainer())));
  assert.doesNotMatch(leer.content, /housekeeping-templates-title/, 'ohne Vorschlag faellt der Abschnitt weg');
  assert.match(leer.content, /id="housekeeping-task-form"/, 'das Formular bleibt');
});

test('Erledigen: der Toast nimmt es zurueck - auf den VORHERIGEN Zeitpunkt, nicht auf leer', async () => {
  const toasts = [];
  hkState({ tab: 'dashboard' });
  const anfragen = await mitHkApi(async () => {
    globalThis.window.yuvomi.showToast = (...args) => toasts.push(args);
    await withAccess({ housekeeping: 'write' }, () => hk.completeTask({ id: 3, last_completed: '2026-09-07T07:00:00Z' }, hkContainer()));
    const undo = toasts.find((args) => args[0] === 'housekeeping.taskDoneToast')?.[3];
    assert.equal(typeof undo, 'function', 'der Erledigt-Toast traegt einen Rueckweg');
    await withAccess({ housekeeping: 'write' }, () => undo());
  });
  assert.ok(anfragen.includes('POST /housekeeping/decay-tasks/3/complete'));
  assert.ok(anfragen.includes('PATCH /housekeeping/decay-tasks/3'));
  // Der Stub reicht den Body als `body` zurueck - hier die Probe darauf.
  let body = null;
  await mitHkApi(async () => {
    globalThis.__apiStub.patch = async (_url, b) => { body = b; return { data: null }; };
    globalThis.window.yuvomi.showToast = (...args) => toasts.push(args);
    await withAccess({ housekeeping: 'write' }, () => hk.completeTask({ id: 3, last_completed: '2026-09-07T07:00:00Z' }, hkContainer()));
    await withAccess({ housekeeping: 'write' }, () => toasts.at(-1)[3]?.());
  });
  assert.deepEqual(body, { last_completed: '2026-09-07T07:00:00Z' });
});

// -------------------------------------------------------------------------
// Berichte und Einsatzbericht
// -------------------------------------------------------------------------

test('Berichte-Tab mit `housekeeping: read`: kein Bezahlen, Monat und Bericht bleiben', () => {
  hkState({ tab: 'reports', visitReport: { month: '2026-08', visits: [hkBesuch()], totals: { pending: 40 } }, reports: [hkBesuch()] });
  const lesen = hkContainer();
  // Der Monat steht im Kopf der Seite (Critique 2026-09-26), nicht im Inhalt.
  const kopf = hkContainer();
  lesen.closest = (sel) => (sel === '.housekeeping-page' ? { querySelector: (s) => (s === '#housekeeping-period' ? kopf : null) } : null);
  withAccess({ housekeeping: 'read' }, () => hk.renderReports(lesen));
  assert.doesNotMatch(lesen.html, /data-pay-report/, 'auch nicht mit veraltetem `can_mark_paid: true`');
  assert.match(lesen.html, /data-visit-report="12"/, 'der Bericht bleibt');
  assert.match(kopf.html, /id="housekeeping-report-prev"/, 'die Monatswahl bleibt');
  assert.ok(!lesen.gefragt.includes('[data-pay-report]'), 'das Bezahlen wird nicht verdrahtet');
  assert.ok(lesen.gefragt.includes('[data-visit-report]'));

  const schreiben = hkContainer();
  withAccess({ housekeeping: 'write' }, () => hk.renderReports(schreiben));
  assert.match(schreiben.html, /data-pay-report="12"/);
  assert.ok(schreiben.gefragt.includes('[data-pay-report]'));
});

test('Einsatzbericht mit `housekeeping: read`: weder Bezahlen noch Zuruecknehmen', () => {
  const offen = hkBesuch();
  const bezahlt = hkBesuch({ paid_at: '2026-08-07T10:00:00Z', can_mark_paid: false, can_mark_unpaid: true });
  for (const [besuch, knopf] of [[offen, 'visit-report-pay'], [bezahlt, 'visit-report-unpay']]) {
    const lesen = mitModal(() => withAccess({ housekeeping: 'read' }, () => hk.openVisitReportModal(besuch)));
    assert.equal(lesen.length, 1, 'der Bericht geht auf - er liest nur');
    assert.doesNotMatch(lesen[0].content, new RegExp(knopf));
    assert.doesNotMatch(lesen[0].content, /modal-panel__footer/, 'ohne Aktion keine Fusszeile');
    assert.match(lesen[0].content, /housekeeping\.totalPayment/, 'der Bericht selbst steht vollstaendig da');
    const schreiben = mitModal(() => withAccess({ housekeeping: 'write' }, () => hk.openVisitReportModal(besuch)));
    assert.match(schreiben[0].content, new RegExp(`id="${knopf}"`));
  }
});

// -------------------------------------------------------------------------
// Personal
// -------------------------------------------------------------------------

test('Personal-Tab mit `housekeeping: read`: kein Bearbeiten, die Auswahl und das Protokoll bleiben', () => {
  hkState({
    tab: 'staff',
    workers: [{ id: 7, display_name: 'Ana', phone: '0151 000' }],
    selectedStaffId: '7',
    staffVisits: [hkBesuch(), hkBesuch({ id: 13, paid_at: '2026-08-07T10:00:00Z', can_mark_paid: false })],
  });
  const lesen = hkContainer();
  withAccess({ housekeeping: 'read' }, () => hk.renderStaff(lesen));
  assert.doesNotMatch(lesen.html, /data-edit-worker/);
  assert.match(lesen.html, /data-open-worker="7"/, 'statt Bearbeiten der Weg ins Profil (Leseansicht)');
  for (const weg of ['data-pay-visit', 'data-edit-visit', 'data-delete-visit']) {
    assert.doesNotMatch(lesen.html, new RegExp(weg), `${weg}: auch nicht mit veralteten Feldern`);
  }
  assert.match(lesen.html, /class="housekeeping-staff-row__select"/, 'die Person bleibt waehlbar');
  assert.match(lesen.html, /data-open-visit="12"/, 'jeder Besuch fuehrt zu seinem Bericht');
  assert.match(lesen.html, /data-open-visit="13"/);
  assert.match(lesen.html, /id="housekeeping-staff-month"/, 'der Monatsfilter bleibt');
  assert.match(lesen.html, /housekeeping\.paymentPending/, 'der Zahlstatus steht in der Metazeile');
  assert.doesNotMatch(lesen.html, /housekeeping\.settledAdminOnly/);
  for (const nie of ['[data-edit-worker]', '[data-edit-visit]', '[data-pay-visit]', '[data-delete-visit]']) {
    assert.ok(!lesen.gefragt.includes(nie), `${nie} wird nicht verdrahtet`);
  }
  for (const lesend of ['[data-select-worker]', '#housekeeping-staff-month', '[data-open-visit]', '[data-open-worker]']) {
    assert.ok(lesen.gefragt.includes(lesend), `${lesend} liest und bleibt verdrahtet`);
  }

  const schreiben = hkContainer();
  withAccess({ housekeeping: 'write' }, () => hk.renderStaff(schreiben));
  assert.match(schreiben.html, /data-edit-worker="7"/);
  assert.doesNotMatch(schreiben.html, /data-open-worker/, 'mit Schreibrecht zeigt der Bearbeiten-Dialog alles');
  assert.match(schreiben.html, /data-pay-visit="12"/);
  assert.match(schreiben.html, /data-edit-visit="12"/);
  assert.match(schreiben.html, /data-delete-visit="12"/);
  for (const da of ['[data-edit-worker]', '[data-edit-visit]', '[data-pay-visit]', '[data-delete-visit]']) {
    assert.ok(schreiben.gefragt.includes(da), `mit Schreibrecht wird ${da} verdrahtet`);
  }
});

test('Bezahl-Knopf des Protokolls: kein gesperrter Knopf, der „Als bezahlt markieren" verspricht', () => {
  const offen = hkBesuch();
  const bezahlt = hkBesuch({ paid_at: '2026-08-07T10:00:00Z', can_mark_paid: false });
  withAccess({ housekeeping: 'read' }, () => {
    assert.equal(hk.staffLogPayHtml(offen, 'x'), '');
    assert.equal(hk.staffLogPayHtml(bezahlt, 'x'), '', 'der Zahlstatus steht in der Metazeile, nicht an einem Knopf');
  });
  withAccess({ housekeeping: 'write' }, () => {
    assert.match(hk.staffLogPayHtml(offen, 'x'), /data-pay-visit="12"/, 'mit Schreibrecht da');
    assert.doesNotMatch(hk.staffLogPayHtml(offen, 'x'), /disabled/, 'und offen');
    // Der Server bietet das Bezahlen nicht an (so meldet er `read`): ein
    // unbezahlter Besuch hat dann nichts, was ein Knopf sagen koennte.
    assert.equal(hk.staffLogPayHtml(hkBesuch({ can_mark_paid: false }), 'x'), '');
    // Unangetastet: der bezahlte Besuch mit Schreibrecht behaelt seinen Knopf,
    // wie er vor #1265 war - nicht Teil dieser Regel.
    assert.match(hk.staffLogPayHtml(bezahlt, 'x'), /disabled/);
  });
});

// -------------------------------------------------------------------------
// Die Einstiege: ein Aufruf ohne Knopf findet denselben Riegel
// -------------------------------------------------------------------------

test('jeder Dialog-Einstieg fragt selbst: bei `read` kein Editor, ein bestehender Datensatz geht als Leseansicht auf', () => {
  hkState({ workers: [{ id: 7, display_name: 'Ana' }] });
  // Das Muster aus P1 (`openNoteModal()`): der Riegel steht im Einstieg, der
  // Anlegeweg fuehrt nirgends hin, ein bestehender Datensatz in die Leseansicht.
  const faelle = [
    // Die Hausaufgabe hat keine: ihr Bearbeiten-Dialog zeigt Name, Bereich und
    // Rhythmus, und alle drei stehen in der Zeile selbst (taskRowHtml).
    ['openTaskEditModal', () => hk.openTaskEditModal({ id: 3, name: 'A', area: 'B', frequency_days: 7 }, hkContainer()), null],
    ['openVisitEditModal', () => hk.openVisitEditModal(hkBesuch(), hkContainer()), 'housekeeping.visitReportDetails'],
    ['openStaffModal (anlegen)', () => hk.openStaffModal(null, hkContainer()), null],
    ['openStaffModal (bestehend)', () => hk.openStaffModal({ id: 7, display_name: 'Ana', payment_schedule: 'monthly' }, hkContainer()), 'housekeeping.profileTitle'],
  ];
  for (const [name, aufruf, leseansicht] of faelle) {
    const lesen = mitModal(() => withAccess({ housekeeping: 'read' }, aufruf));
    if (leseansicht) {
      assert.equal(lesen.length, 1, `${name}: der Datensatz geht auf - Lesen ist erlaubt`);
      assert.equal(lesen[0].title, leseansicht, `${name}: als Leseansicht`);
      assert.doesNotMatch(lesen[0].content, /<form|<input|<select|<textarea|type="submit"/, `${name}: ohne ein einziges Eingabefeld`);
    } else {
      assert.equal(lesen.length, 0, `${name}() oeffnet bei read nichts`);
    }
    const schreiben = mitModal(() => withAccess({ housekeeping: 'write' }, aufruf));
    assert.equal(schreiben.length, 1, `${name}() oeffnet mit Schreibrecht - sonst maesse die Zeile oben nichts`);
    assert.match(schreiben[0].content, /<form/, `${name}: mit Schreibrecht der Editor`);
  }
});

// -------------------------------------------------------------------------
// Leseansichten: alles, was der Editor zeigt (#1265, Regel vom 21.09.)
//
// Gemessen am WERT, nicht an der Beschriftung: jeder Wert, den der Editor mit
// Schreibrecht zeigt, muss bei `read` in der Leseansicht stehen - je als Paar
// aus der Form im Editor (ein Betrag steht dort roh im Eingabefeld) und der
// Form in der Leseansicht (formatiert). Die Zusicherung am Editor sorgt dafuer,
// dass die Liste nicht an Werten misst, die gar keiner zeigt.
// -------------------------------------------------------------------------

test('Profil bei `housekeeping: read`: die Leseansicht zeigt jeden Wert des Bearbeiten-Dialogs', () => {
  const ana = {
    id: 7, display_name: 'Ana Lopez', username: 'ana.l', phone: '0151 2345', email: 'ana@example.org',
    birth_date: '1990-04-12', rate_type: 'hourly', daily_rate: 0, hourly_rate: 14.5,
    payment_schedule: 'twice_monthly', calendar_color: '#12AB34', avatar_color: '#FF8800',
    notes: 'Schluessel beim Nachbarn\nDienstags frueher',
  };
  const werte = [
    ['Ana Lopez', 'Ana Lopez'], ['ana.l', 'ana.l'], ['0151 2345', '0151 2345'],
    ['ana@example.org', 'ana@example.org'], ['1990-04-12', '1990-04-12'],
    ['housekeeping.rateHourly', 'housekeeping.rateHourly'], ['value="14.5"', '14,50'],
    ['housekeeping.scheduleTwiceMonthly', 'housekeeping.scheduleTwiceMonthly'],
    ['#12AB34', '#12AB34'], ['#FF8800', '#FF8800'], ['Schluessel beim Nachbarn', 'Schluessel beim Nachbarn'],
  ];

  const [editor] = mitModal(() => withAccess({ housekeeping: 'write' }, () => hk.openStaffModal(ana, hkContainer())));
  for (const [imEditor] of werte) assert.ok(editor.content.includes(imEditor), `der Editor zeigt ${imEditor} - sonst misst die Liste nichts`);

  const [lesen] = mitModal(() => withAccess({ housekeeping: 'read' }, () => hk.openStaffModal(ana, hkContainer())));
  for (const [, inLeseansicht] of werte) assert.ok(lesen.content.includes(inLeseansicht), `die Leseansicht zeigt ${inLeseansicht}`);
  assert.match(lesen.content, /<span class="housekeeping-swatch" style="--swatch:#12AB34" aria-hidden="true"><\/span>#12AB34/,
    'die Farbe als Feld UND als Wert - nicht allein an der Farbe');
  assert.doesNotMatch(lesen.content, /housekeeping\.dailyRate/, 'wie im Editor nur der Satz der gewaehlten Abrechnungsart');

  // Die Antwort folgt dem Datensatz: was nicht gesetzt ist, bekommt keine Zeile.
  const [knapp] = mitModal(() => withAccess({ housekeeping: 'read' }, () => (
    hk.openStaffReadModal({ id: 8, display_name: 'Bea', rate_type: 'daily', daily_rate: 60, payment_schedule: 'monthly' })
  )));
  for (const leer of ['workerUsername', 'workerPhone', 'workerEmail', 'workerBirthDate', 'workerNotes', 'hourlyRate']) {
    assert.doesNotMatch(knapp.content, new RegExp(`housekeeping\\.${leer}`), `${leer} ist nicht gesetzt und hat keine Zeile`);
  }
  assert.match(knapp.content, /housekeeping\.dailyRate/);
  assert.match(knapp.content, /60,00/);
});

test('Besuch bei `housekeeping: read`: der Einsatzbericht zeigt jeden Wert des Einsatz-Dialogs, auch Minuten und Beleg', () => {
  hkState({ workers: [{ id: 7, display_name: 'Ana' }] });
  const stunden = hkBesuch({
    rate_type: 'hourly', minutes_worked: 135, daily_rate: 31.5, extras: 4,
    receipt_document_id: 44, receipt_document_name: 'Beleg - Ana - 06.08.',
  });
  const werte = [
    ['2026-08-06', '2026-08-06'], ['value="135"', '135'], ['31,50', '31,50'],
    ['value="4"', '4,00'], ['Beleg - Ana - 06.08.', 'Beleg - Ana - 06.08.'],
  ];

  const [editor] = mitModal(() => withAccess({ housekeeping: 'write' }, () => hk.openVisitEditModal(stunden, hkContainer())));
  for (const [imEditor] of werte) assert.ok(editor.content.includes(imEditor), `der Editor zeigt ${imEditor} - sonst misst die Liste nichts`);

  const [lesen] = mitModal(() => withAccess({ housekeeping: 'read' }, () => hk.openVisitEditModal(stunden, hkContainer())));
  for (const [, inLeseansicht] of werte) assert.ok(lesen.content.includes(inLeseansicht), `der Einsatzbericht zeigt ${inLeseansicht}`);
  assert.match(lesen.content, /<dt>housekeeping\.minutesWorked<\/dt><dd>135<\/dd>/);
  assert.match(lesen.content, /<dt>housekeeping\.computedAmount<\/dt>/, 'nach Stunden wie im Dialog: der berechnete Betrag');
  assert.match(lesen.content, /<dt>housekeeping\.receiptLabel<\/dt><dd>Beleg - Ana - 06\.08\.<\/dd>/);

  // Der Beleg folgt dem Dokumentenrecht, im Bericht wie im Dialog.
  const [ohneDokumente] = mitModal(() => withAccess({ housekeeping: 'read', documents: 'none' }, () => hk.openVisitReportModal(stunden)));
  assert.doesNotMatch(ohneDokumente.content, /receiptLabel/, 'bei `documents: none` antwortet schon das Lesen mit 403');
  const [nurLesen] = mitModal(() => withAccess({ housekeeping: 'read', documents: 'read' }, () => hk.openVisitReportModal(stunden)));
  assert.match(nurLesen.content, /receiptLabel/, 'Lesen genuegt');

  // Ein Besuch nach Tagessatz behaelt seine Zeile, und ohne Beleg gibt es keine.
  const [tag] = mitModal(() => withAccess({ housekeeping: 'read' }, () => hk.openVisitReportModal(hkBesuch())));
  assert.match(tag.content, /<dt>housekeeping\.dailyRate<\/dt>/);
  assert.doesNotMatch(tag.content, /minutesWorked|receiptLabel/);
});

test('Check-in, Anlegen und Bezahlen schreiben bei `read` nichts - auch ohne Knopf aufgerufen', async () => {
  hkState({ workers: [{ id: 7, display_name: 'Ana', daily_rate: 50, current_session: null }] });
  const faelle = [
    ['toggleSession', () => hk.toggleSession(hkContainer(), 7), 'POST /housekeeping/work-sessions/check-in'],
    ['createTask', () => hk.createTask({ name: 'A', area: 'B', frequency_days: 7 }, hkContainer()), 'POST /housekeeping/decay-tasks'],
    ['payVisit', () => hk.payVisit(hkBesuch(), async () => {}), 'POST /housekeeping/visits/12/pay'],
    ['unpayVisit', () => hk.unpayVisit(hkBesuch({ paid_at: '2026-08-07T10:00:00Z' }), async () => {}), 'POST /housekeeping/visits/12/unpay'],
  ];
  for (const [name, aufruf, anfrage] of faelle) {
    const lesen = await mitHkApi(() => withAccess({ housekeeping: 'read' }, aufruf));
    assert.deepEqual(lesen.filter((a) => !a.startsWith('GET ')), [], `${name}() schreibt bei read nichts`);
    const schreiben = await mitHkApi(() => withAccess({ housekeeping: 'write' }, aufruf));
    assert.ok(schreiben.includes(anfrage), `${name}() schreibt mit Schreibrecht (${anfrage}) - gefunden: ${schreiben.join(', ')}`);
  }
});

test('ein Dialog, der vor dem Rechtewechsel aufging, schreibt beim Absenden nicht mehr', async () => {
  hkState({ workers: [{ id: 7, display_name: 'Ana' }] });
  const [dialog] = mitModal(() => withAccess({ housekeeping: 'write' }, () => hk.openVisitEditModal(hkBesuch(), hkContainer())));
  const absenden = besuchAbsenden(dialog, { mitDatei: false });
  const lesen = await mitHkApi(() => withAccess({ housekeeping: 'read' }, absenden));
  assert.deepEqual(lesen, [], 'kein PUT, das am 403 endete');
  const schreiben = await mitHkApi(() => withAccess({ housekeeping: 'write' }, absenden));
  assert.ok(schreiben.includes('PUT /housekeeping/visits/12'), 'mit Schreibrecht speichert derselbe Dialog');
});

// -------------------------------------------------------------------------
// Der Beleg: ein Schreibweg in die DOKUMENTE (Kreuzabhaengigkeit)
// -------------------------------------------------------------------------

/**
 * Faehrt den echten Absende-Handler des Einsatz-Dialogs. Das Formular und das
 * Dateifeld sind Attrappen - das Feld traegt eine Datei, als haette jemand sie
 * vor dem Rechtewechsel gewaehlt, damit der Riegel im Absenden etwas zu tun hat.
 */
function besuchAbsenden(dialog, { mitDatei = true } = {}) {
  let handler = null;
  const datei = { name: 'beleg.pdf', size: 10 };
  const panel = {
    querySelector(sel) {
      if (sel === '#housekeeping-visit-form') return { addEventListener: (_typ, fn) => { handler = fn; } };
      if (sel === '#housekeeping-receipt-file') return { files: mitDatei ? [datei] : [] };
      return null;
    },
  };
  dialog.onSave(panel);
  assert.equal(typeof handler, 'function', 'der Dialog haengt seinen Absende-Handler an');
  return () => handler({
    preventDefault() {},
    currentTarget: { elements: { date: { value: '2026-08-06' }, daily_rate: { value: '40' }, extras: { value: '0' } } },
  });
}

/** `FileReader` gibt es in Node nicht; die Seite liest die Datei damit als Data-URL. */
async function mitFileReader(fn) {
  const vorher = globalThis.FileReader;
  globalThis.FileReader = class {
    readAsDataURL() { this.result = 'data:application/pdf;base64,AA=='; this.onload?.(); }
  };
  try { return await fn(); } finally { globalThis.FileReader = vorher; }
}

test('Beleg-Feld: die Ablage haengt am Schreibrecht auf die DOKUMENTE, nicht auf die Haushaltshilfe', () => {
  const mitBeleg = hkBesuch({ receipt_document_id: 44, receipt_document_name: 'Beleg - Ana - 06.08.' });
  const ohneBeleg = hkBesuch();

  const schreiben = withAccess({ housekeeping: 'write', documents: 'write' }, () => hk.receiptFieldHtml(mitBeleg));
  assert.match(schreiben, /id="housekeeping-receipt-file" type="file"/, 'mit Schreibrecht die Ablage');
  assert.match(schreiben, /Beleg - Ana - 06\.08\./);

  withAccess({ housekeeping: 'write', documents: 'read' }, () => {
    const gesetzt = hk.receiptFieldHtml(mitBeleg);
    assert.doesNotMatch(gesetzt, /type="file"|document-dropzone/, 'keine Ablage, deren Hochladen am 403 endet');
    assert.match(gesetzt, /<dt>housekeeping\.receiptLabel<\/dt><dd>Beleg - Ana - 06\.08\.<\/dd>/,
      'ein verknuepfter Beleg bleibt als Angabe stehen - gesetzt heisst sichtbar');
    assert.equal(hk.receiptFieldHtml(ohneBeleg), '', 'ohne Beleg faellt die Stelle weg');
  });
  withAccess({ housekeeping: 'write', documents: 'none' }, () => {
    assert.equal(hk.receiptFieldHtml(mitBeleg), '', 'ohne Zugriff auf Dokumente gar nichts - dort antwortet schon das Lesen mit 403');
  });
});

test('Beleg, den der Server nicht nennt: ein ruhiges Zeichen statt einer leeren Ablage (#1358)', () => {
  // So kommt ein Besuch an, dessen Beleg ein privates Dokument einer anderen
  // Person ist: `has_receipt` bleibt, Name und ID sind maskiert.
  const verdeckt = hkBesuch({ has_receipt: true, receipt_document_id: null, receipt_document_name: null });
  const zeichen = /<dt>housekeeping\.receiptLabel<\/dt><dd>documentAttach\.lockedPrivate<\/dd>/;
  for (const documents of ['write', 'read']) {
    withAccess({ housekeeping: 'write', documents }, () => {
      const feld = hk.receiptFieldHtml(verdeckt);
      assert.doesNotMatch(feld, /type="file"|document-dropzone/, `documents: ${documents} - keine Ablage, die den Beleg ersetzen wuerde`);
      assert.match(feld, zeichen, `documents: ${documents} - der Dialog sagt, dass es einen Beleg gibt`);
      assert.doesNotMatch(feld, /undefined|null/);
    });
    const [bericht] = mitModal(() => withAccess({ housekeeping: 'read', documents }, () => hk.openVisitReportModal(verdeckt)));
    assert.match(bericht.content, zeichen, `documents: ${documents} - der Bericht zeigt dasselbe wie der Dialog`);
  }
  withAccess({ housekeeping: 'write', documents: 'none' }, () => {
    assert.equal(hk.receiptFieldHtml(verdeckt), '', 'bei `documents: none` bleibt die Stelle leer wie bisher');
  });

  // Verdeckt heisst: die ID ist maskiert - nicht "der Name fehlt". Ein Besuch
  // mit sichtbarer ID, aber ohne Namen (leerer Dokumentname, ein Serialisierer
  // ohne Namensfeld) gehoert dem Betrachter und behaelt seine Ablage.
  for (const ohneName of [
    hkBesuch({ has_receipt: true, receipt_document_id: 44, receipt_document_name: '' }),
    hkBesuch({ has_receipt: true, receipt_document_id: 44 }),
  ]) {
    withAccess({ housekeeping: 'write', documents: 'write' }, () => {
      const feld = hk.receiptFieldHtml(ohneName);
      assert.match(feld, /id="housekeeping-receipt-file" type="file"/, 'mit sichtbarer ID bleibt die Ablage');
      assert.doesNotMatch(feld, zeichen);
    });
  }
});

test('Beleg, den der Server nicht nennt: Speichern schickt null und laedt nichts hoch (#1358)', async () => {
  hkState({ workers: [{ id: 7, display_name: 'Ana' }] });
  const verdeckt = hkBesuch({ has_receipt: true, receipt_document_id: null, receipt_document_name: null });
  let gesendet = null;
  const anfragen = await mitFileReader(() => mitHkApi(async () => {
    const put = globalThis.__apiStub.put;
    globalThis.__apiStub.put = async (url, body) => { gesendet = body; return put(url, body); };
    await withAccess({ housekeeping: 'write', documents: 'write' }, () => {
      const [dialog] = mitModal(() => hk.openVisitEditModal(verdeckt, hkContainer()));
      return besuchAbsenden(dialog)();
    });
  }, { 'POST /documents': { data: { id: 99 } } }));
  assert.ok(!anfragen.includes('POST /documents'), 'keine Ablage, also kein Hochladen');
  assert.ok(anfragen.includes('PUT /housekeeping/visits/12'));
  assert.equal(gesendet.receipt_document_id, null, 'null heisst beim Server "behalten"');
});

test('Beleg beim Absenden: ohne Schreibrecht auf die Dokumente kein POST /documents, der Einsatz speichert trotzdem', async () => {
  hkState({ workers: [{ id: 7, display_name: 'Ana' }] });
  const besuch = hkBesuch({ receipt_document_id: 44, receipt_document_name: 'Beleg' });
  const antworten = { 'POST /documents': { data: { id: 99 } } };

  const nurLesen = await mitFileReader(async () => {
    let gesendet = null;
    const anfragen = await mitHkApi(async () => {
      const put = globalThis.__apiStub.put;
      globalThis.__apiStub.put = async (url, body) => { gesendet = body; return put(url, body); };
      await withAccess({ housekeeping: 'write', documents: 'read' }, () => {
        const [dialog] = mitModal(() => hk.openVisitEditModal(besuch, hkContainer()));
        return besuchAbsenden(dialog)();
      });
    }, antworten);
    return { anfragen, gesendet };
  });
  assert.ok(!nurLesen.anfragen.includes('POST /documents'), 'kein Hochladen, das am 403 endete');
  assert.ok(nurLesen.anfragen.includes('PUT /housekeeping/visits/12'), 'der Einsatz selbst wird gespeichert');
  assert.equal(nurLesen.gesendet.receipt_document_id, 44, 'mit der Verknuepfung, die er schon hatte');

  const schreiben = await mitFileReader(async () => {
    let gesendet = null;
    const anfragen = await mitHkApi(async () => {
      const put = globalThis.__apiStub.put;
      globalThis.__apiStub.put = async (url, body) => { gesendet = body; return put(url, body); };
      await withAccess({ housekeeping: 'write', documents: 'write' }, () => {
        const [dialog] = mitModal(() => hk.openVisitEditModal(besuch, hkContainer()));
        return besuchAbsenden(dialog)();
      });
    }, antworten);
    return { anfragen, gesendet };
  });
  assert.ok(schreiben.anfragen.includes('POST /documents'), 'mit Schreibrecht wird hochgeladen - sonst maesse die Zeile oben nichts');
  assert.equal(schreiben.gesendet.receipt_document_id, 99, 'und der neue Beleg verknuepft');
});

// -------------------------------------------------------------------------
// Der Riegel und die Positivliste
// -------------------------------------------------------------------------

const HK_CODE = readFileSync(new URL('../public/pages/housekeeping.js', import.meta.url), 'utf8')
  .replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

test('READ_SAFE_CONTROLS ist eine Positivliste und enthaelt nur lesende Bedienelemente', () => {
  const erlaubt = hk.READ_SAFE_CONTROLS.split(',').map((s) => s.trim()).sort();
  assert.deepEqual(erlaubt, [
    '#housekeeping-report-current', '#housekeeping-report-next', '#housekeeping-report-prev',
    '#housekeeping-staff-month', '.housekeeping-staff-row__select', '.housekeeping-tab',
    '[data-open-visit]', '[data-open-worker]', '[data-visit-report]',
  ], 'Tab, Bericht, Profil, Personenwahl und Monat - alles andere dieser Seite schreibt');
  // Kein Eintrag darf veraltet sein: was hier steht, muss im Markup vorkommen.
  for (const sel of erlaubt) {
    const kern = sel.replace(/^[#.]|^\[|\]$/g, '');
    assert.ok(HK_CODE.includes(kern), `${sel} steht in der Liste, aber nicht mehr im Markup`);
  }
  // Und die schreibenden Haken stehen ausdruecklich NICHT darin.
  for (const schreibend of ['data-worker-check', 'data-edit-visit', 'data-template-index', 'data-complete-task',
    'data-undo-task', 'data-edit-task', 'data-delete-task', 'data-pay-report', 'data-edit-worker',
    'data-pay-visit', 'data-delete-visit', 'housekeeping-create-profile', 'housekeeping-task-form', 'page-fab']) {
    assert.ok(!hk.READ_SAFE_CONTROLS.includes(schreibend), `${schreibend} schreibt und gehoert nicht in die Liste`);
  }
});

/** Ein Klick auf ein Bedienelement, das genau EINEN Selektor erfuellt. */
function hkKlick(selektor) {
  const bedienelement = selektor
    ? { matches: (liste) => liste.split(',').map((s) => s.trim()).includes(selektor) }
    : null;
  return {
    target: { closest: () => bedienelement },
    abgefangen: 0,
    preventDefault() { this.abgefangen += 1; },
    stopPropagation() { this.abgefangen += 1; },
  };
}

test('readOnlyLatch(): bei `read` faengt er jedes Bedienelement ausser den lesenden ab, mit Schreibrecht keines', () => {
  withAccess({ housekeeping: 'read' }, () => {
    for (const schreibend of ['[data-edit-worker]', '[data-complete-task]', '#housekeeping-task-form', '.page-fab']) {
      const e = hkKlick(schreibend);
      hk.readOnlyLatch(e);
      assert.equal(e.abgefangen, 2, `${schreibend} wird abgefangen (preventDefault + stopPropagation)`);
    }
    for (const lesend of ['[data-open-visit]', '[data-open-worker]', '.housekeeping-staff-row__select', '#housekeeping-staff-month', '.housekeeping-tab']) {
      const e = hkKlick(lesend);
      hk.readOnlyLatch(e);
      assert.equal(e.abgefangen, 0, `${lesend} liest und kommt durch`);
    }
    const flaeche = hkKlick(null);
    hk.readOnlyLatch(flaeche);
    assert.equal(flaeche.abgefangen, 0, 'ein Klick neben jedes Bedienelement (die Personenzeile) kommt durch');
  });
  withAccess({ housekeeping: 'write' }, () => {
    const e = hkKlick('[data-edit-worker]');
    hk.readOnlyLatch(e);
    assert.equal(e.abgefangen, 0, 'mit Schreibrecht faengt er nichts ab');
  });
});

test('der Riegel haengt an jeder neu gebauten Seite, in der Erfassungsphase, fuer Klick UND Absenden', () => {
  const haken = [];
  const seite = {
    appendChild() {},
    addEventListener: (typ, fn, capture) => { haken.push({ typ, fn, capture }); },
  };
  const container = {
    replaceChildren() {},
    insertAdjacentHTML() {},
    querySelector: (sel) => (sel === '.housekeeping-page' ? seite : null),
  };
  hkState({ tab: 'tasks' });
  hk.renderShell(container);
  for (const typ of ['click', 'submit']) {
    const h = haken.find((x) => x.typ === typ && x.fn === hk.readOnlyLatch);
    assert.ok(h, `readOnlyLatch haengt fuer ${typ}`);
    assert.equal(h.capture, true, `${typ}: Erfassungsphase - in der Blasenphase kaeme er nach dem Listener am Knopf`);
  }
});

// -------------------------------------------------------------------------
// Die Darstellung: Zeichen und Zeile ohne Kreis
// -------------------------------------------------------------------------

test('das Zeichen „gerade im Haus" traegt keinen Zeiger und keine Hover-Quittung, der Knopf schon', () => {
  const css = LAYOUT_CSS + HK_CSS;
  const zeichen = ['housekeeping-check-small', 'housekeeping-check-small--static'];
  const knopf = ['btn', 'btn--secondary', 'housekeeping-check-small'];
  assert.equal(effektiverWert(css, zeichen, 'cursor'), 'default', 'ein Zeigefinger verspricht eine Handlung');
  assert.equal(effektiverWert(css, knopf, 'cursor'), 'pointer', 'der Knopf behaelt ihn - sonst maesse die Zeile darueber nichts');
  assert.equal(effektiverWert(css, zeichen, 'background-color', ':hover'), null, 'keine Hover-Regel trifft das Zeichen');
  assert.equal(effektiverWert(css, zeichen, 'background', ':hover'), null);
  assert.notEqual(effektiverWert(css, knopf, 'background-color', ':hover'), null, 'der Knopf reagiert weiter');
  assert.match(effektiverWert(css, zeichen, 'background') ?? '', /--color-surface-3/,
    'Status statt Disabled-Grau (Audit F9) - die Farben der frueheren :disabled-Regel');
});

test('die Aufgabenzeile ohne Kreis reserviert keine Spalte fuer ihn', () => {
  // Seit 2026-09-26 eine `.list-row` (Flex): Kreis | Text | Aktionen. Eine feste
  // Kreisspalte wie das fruehere Grid `56px 1fr` gibt es nicht mehr - fehlt der
  // Kreis (`read`), steht der Text an der Kante.
  const zeile = ['list-row', 'housekeeping-task', 'housekeeping-task--overdue'];
  assert.equal(effektiverWert(HK_CSS, zeile, 'grid-template-columns'), null);
  assert.equal(effektiverWert(HK_CSS, [...zeile, 'housekeeping-task--readonly'], 'grid-template-columns'), null);
  assert.equal(effektiverWert(HK_CSS, zeile, 'display'), null, 'die Geometrie kommt aus list-row.css');
  hkState({ tasks: [{ id: 3, name: 'Fenster putzen', area: 'Wohnzimmer', frequency_days: 14, urgency_status: 'overdue' }] });
  const lesen = hkContainer();
  withAccess({ housekeeping: 'read' }, () => hk.renderTasks(lesen));
  assert.match(lesen.html, /<article class="list-row housekeeping-task /);
});

// -------------------------------------------------------------------------
// Wandtablett und Personal
// -------------------------------------------------------------------------

test('Haushaltshilfe hat keine Display-Ausnahme, und ein Display erreicht die Seite gar nicht', () => {
  const display = readFileSync(new URL('../server/display-scopes.js', import.meta.url), 'utf8');
  const routen = display.slice(display.indexOf('DISPLAY_WRITE_ROUTES = Object.freeze(['));
  const liste = routen.slice(0, routen.indexOf(']);'));
  assert.ok(!/housekeeping/.test(liste),
    'gaebe es hier eine Route, brauchte die Seite ein actingAsDisplay() VOR der Modulregel');
  const scopes = display.slice(display.indexOf('DISPLAY_SCOPES = Object.freeze(['));
  assert.ok(!/housekeeping:/.test(scopes.slice(0, scopes.indexOf(']);'))),
    'ohne Scope setzt server/permissions.js das Modul fuer ein Display auf none - die Seite ist fuer es nicht offen');
});

test('Aufgaben-Dokumente ohne Dokumentenrecht: keine Zahl, keine Zeile, kein Link auf /documents/null (#1358)', () => {
  // So kommt eine Aufgabe ohne Leserecht auf die Dokumente an: der Server sagt
  // weder wie viele noch welche (`document_count` und `documents` sind null).
  const verdeckt = aufgabe({ document_count: null, documents: null });
  const mitDokumenten = aufgabe({ document_count: 2, documents: [{ id: 5, name: 'Anleitung.pdf', mime_type: 'application/pdf' }] });
  withAccess({ tasks: 'write', documents: 'read' }, () => {
    assert.doesNotMatch(tasks.renderTaskCard(verdeckt), /task-card__docs|null/, 'keine Klammer ohne Zahl');
    assert.match(tasks.renderTaskCard(mitDokumenten), /task-card__docs/, 'Gegenfall: mit Zahl die Klammer');
    assert.equal(detail.documentListNode(null), null, 'keine Zeile ohne Liste');
    assert.equal(detail.documentListNode([{ id: null, name: null }]), null, 'ein Eintrag ohne ID wird kein Link');
    const node = detail.documentListNode(mitDokumenten.documents);
    assert.equal(node.childNodes[0].href, '/api/v1/documents/5/preview', 'Gegenfall: mit ID der Link');
  });
  withAccess({ tasks: 'write', documents: 'none' }, () => {
    assert.equal(detail.documentListNode(mitDokumenten.documents), null,
      'bei `documents: none` keine Zeile - jeder Link ginge ins 403');
  });
});

test.after(() => miniDomAbraeumen());

test('Termin-Dialog: die Anhang-Ablage steht nur mit documents-Schreibrecht (#1358, DECISIONS.md Eintrag 10)', () => {
  // Ein neuer Anhang legt ein Dokument an - eine Uebertragung ins
  // Dokumente-Modul. Der Server verlangt dafuer `documents: write`, der Dialog
  // bietet die Ablage deshalb nur dann an.
  const ohne = { id: 7, title: 'Arzt', start_datetime: '2030-05-01T10:00', end_datetime: '2030-05-01T11:00', visibility: 'all' };
  const mit = {
    ...ohne, attachment_document_id: 12, attachment_name: 'befund.pdf', attachment_mime: 'application/pdf',
    attachment_preview_url: '/api/v1/documents/12/preview', attachment_download_url: '/api/v1/documents/12/download',
  };
  const render = (documents, event) => withAccess({ calendar: 'write', documents },
    () => calendar.buildEventModalContent({ mode: 'edit', event }));
  for (const event of [ohne, mit]) {
    assert.match(render('write', event), /id="modal-attachment"/, 'write: die Ablage steht');
    assert.doesNotMatch(render('read', event), /id="modal-attachment"/, 'read: keine Ablage');
    assert.doesNotMatch(render('none', event), /id="modal-attachment/, 'none: gar nichts vom Anhang');
  }
  assert.match(render('read', mit), /id="modal-remove-attachment"/, 'read: ein sichtbarer Anhang laesst sich loesen');
  assert.match(render('read', mit), /documents\/12\/download/, 'read: und bleibt als Vorschau');
  assert.doesNotMatch(render('read', ohne), /calendar\.attachmentLabel/, 'read ohne Anhang: die Stelle faellt weg');
});

test('Termin-Dialog: ein fremder privater Anhang ist ein klarer Zustand, ohne Ablage und ohne Entfernen (#1358)', () => {
  const gesperrt = {
    id: 8, title: 'Arzt', start_datetime: '2030-05-01T10:00', end_datetime: '2030-05-01T11:00', visibility: 'all',
    attachment_locked: true, attachment_document_id: null, attachment_name: null,
  };
  for (const documents of ['write', 'read']) {
    const html = withAccess({ calendar: 'write', documents }, () => calendar.buildEventModalContent({ mode: 'edit', event: gesperrt }));
    assert.match(html, /id="modal-attachment-locked"[^>]*>documentAttach\.lockedPrivate</, `${documents}: der Zustand steht da`);
    assert.doesNotMatch(html, /id="modal-attachment"/, `${documents}: keine Ablage zum Ersetzen`);
    assert.doesNotMatch(html, /id="modal-remove-attachment"/, `${documents}: kein Entfernen`);
  }
  const none = withAccess({ calendar: 'write', documents: 'none' }, () => calendar.buildEventModalContent({ mode: 'edit', event: gesperrt }));
  assert.doesNotMatch(none, /modal-attachment/, 'none: gar nichts');
});

test('Termin-Dialog: Anhang-Absagen des Servers kommen uebersetzt, der Entfernen-Knopf folgt dem Zustand (#1358)', () => {
  const fehler = (data) => ({ data });
  assert.equal(calendar.calendarSaveErrorMessage(fehler({ error: 'Changing this attachment needs access to its document.', reason: 'ATTACHMENT_CHANGE_REFUSED' })),
    'calendar.attachmentChangeRefused');
  assert.equal(calendar.calendarSaveErrorMessage(fehler({ error: 'Attaching a file needs write access to documents.', reason: 'ATTACHMENT_UPLOAD_REFUSED' })),
    'calendar.attachmentUploadRefused');
  assert.equal(calendar.calendarSaveErrorMessage(fehler({ error: 'Titel fehlt' })), 'Titel fehlt', 'andere Meldungen wie bisher');
  assert.equal(calendar.calendarSaveErrorMessage(new Error('x')), 'calendar.saveError');

  const mit = { attachment_document_id: 12, attachment_name: 'befund.pdf' };
  assert.equal(calendar.hasCurrentAttachment({ name: 'befund.pdf', changed: false }, mit), true);
  assert.equal(calendar.hasCurrentAttachment({ name: null, changed: true, removed: true }, mit), false,
    'nach dem Entfernen ist nichts mehr zu entfernen - auch ohne Ablage (Stufe read)');
  assert.equal(calendar.hasCurrentAttachment({ name: null, changed: false }, { attachment_data: 'data:x' }), true,
    'ein alter Anhang ohne Namen bleibt entfernbar');
});

test('Termin-Dialog, Stufe read: nach dem Entfernen bleibt der Entfernen-Knopf nicht allein stehen (#1358)', () => {
  // Ausgefuehrt, nicht gelesen: wireEventForm() an einem Panel ohne Ablage
  // (so rendert es die Stufe read) und ein Klick auf "Entfernen".
  const permissiv = () => new Proxy(function stub() {}, {
    get(target, prop) {
      if (prop in target) return target[prop];
      if (prop === Symbol.iterator) return function* leer() {};
      if (prop === Symbol.toPrimitive) return () => '';
      if (prop === 'then') return undefined;
      if (prop === 'length') return 0;
      if (prop === 'querySelectorAll' || prop === 'getElementsByTagName') return () => [];
      if (prop === 'value' || prop === 'textContent') return '';
      if (prop === 'checked' || prop === 'hidden' || prop === 'disabled') return false;
      return permissiv();
    },
    apply() { return permissiv(); },
    set(target, prop, value) { target[prop] = value; return true; },
  });
  const listeners = {};
  const entfernen = {
    hidden: false,
    addEventListener(type, fn) { listeners[type] = fn; },
  };
  const fehlend = new Set(['#modal-selected-attachment', '#modal-attachment', '#modal-attachment-dropzone']);
  const panel = new Proxy({}, {
    get(_target, prop) {
      if (prop === 'querySelector') {
        return (selector) => {
          if (fehlend.has(selector)) return null;
          if (selector === '#modal-remove-attachment') return entfernen;
          return permissiv();
        };
      }
      if (prop === 'querySelectorAll') return () => [];
      return permissiv()[prop];
    },
  });
  const event = {
    id: 9, title: 'Arzt', start_datetime: '2030-05-01T10:00', end_datetime: '2030-05-01T11:00', visibility: 'all',
    attachment_document_id: 12, attachment_name: 'befund.pdf', attachment_mime: 'application/pdf',
  };
  withAccess({ calendar: 'write', documents: 'read' }, () => {
    calendar.wireEventForm(panel, { mode: 'edit', event });
  });
  assert.equal(typeof listeners.click, 'function', 'der Knopf ist verdrahtet');
  assert.equal(entfernen.hidden, false, 'vor dem Entfernen steht er');
  listeners.click();
  assert.equal(entfernen.hidden, true, 'nach dem Entfernen ist er weg');
});

test('Termin-Lesepopup: ein fremder privater Anhang zeigt denselben Hinweis wie der Dialog (#1358)', () => {
  const gesperrt = {
    id: 8, title: 'Arzt', attachment_locked: true,
    attachment_document_id: null, attachment_name: null, attachment_data: null,
  };
  const node = calendar.attachmentNode(gesperrt);
  assert.ok(node, 'die Zeile steht da');
  assert.equal(node.textContent, 'documentAttach.lockedPrivate', 'derselbe Text wie im Dialog');
  assert.equal(node.href, undefined, 'kein Link');
  assert.equal(node.tagName?.toLowerCase(), 'span', 'ein Zustand, keine Handlung');
  // Ohne Sperre und ohne Anhang bleibt die Zeile weg wie bisher.
  assert.equal(calendar.attachmentNode({ id: 9, attachment_locked: false }), null);
  assert.equal(calendar.attachmentNode({ id: 9, attachment_locked: null }), null);
});

// -------------------------------------------------------------------------
// Dokumente: Bearbeiten im Betrachter (Re-Critique 2026-09-25, P2)
// -------------------------------------------------------------------------

// Die Seite liest beim Laden ihre Ansicht und Sortierung aus localStorage;
// Node kennt es nicht. Ein leerer Speicher reicht (Muster aus test-people-pickers.js).
globalThis.localStorage = globalThis.localStorage ?? {
  getItem: () => null, setItem() {}, removeItem() {}, clear() {},
};
const { __test: documentsPage } = await import('../public/pages/documents.js');

test('Dokument-Betrachter: Bearbeiten nur mit Schreibrecht auf die Dokumente', () => {
  const doc = {
    id: 31, name: 'Pass', category: 'identity', mime_type: 'image/png', file_size: 1200,
    storage_backend: 'local', visibility: 'family', status: 'active',
    // Seit #1265 fragt der Stift auch die Besitzregel: das Dokument gehoert
    // der Person, die hier sitzt. Das fremde Dokument faehrt
    // test-inventory-documents-readonly-ui.js.
    created_by: 7,
  };
  const besitzerZuvor = documentsPage.state.currentUserId;
  documentsPage.state.currentUserId = 7;
  const bearbeiten = /data-action="edit-document"/;
  // Eigenes Mini-DOM: das der Suite baut `test.after` oben ab, und unter
  // Node 22/24 laeuft dieser Hook schon vor einem Test, der erst nach einem
  // `await import` registriert wird - der Betrachter liest `document.activeElement`.
  const abbau = installMiniDom();
  try {
    const [lesen] = mitModal(() => withAccess({ documents: 'read' }, () => documentsPage.openDocumentViewer(doc)));
    assert.ok(lesen, 'der Betrachter oeffnet auch nur lesend');
    assert.doesNotMatch(lesen.content, bearbeiten, 'kein Bearbeiten, das am 403 endet');
    assert.match(lesen.content, /download/, 'Herunterladen bleibt');
    const [schreiben] = mitModal(() => withAccess({ documents: 'write' }, () => documentsPage.openDocumentViewer(doc)));
    assert.match(schreiben.content, bearbeiten, 'mit Schreibrecht steht es - sonst maesse die Zeile oben nichts');
    const [fremd] = mitModal(() => withAccess({ documents: 'write', tasks: 'read' }, () => documentsPage.openDocumentViewer(doc)));
    assert.match(fremd.content, bearbeiten, 'ein FREMDES Modul auf read sperrt es nicht');
  } finally {
    documentsPage.state.currentUserId = besitzerZuvor;
    abbau();
  }
});

// -------------------------------------------------------------------------
// Komponenten-Kanon, Runde 5 (Critique 2026-09-26): Menschen-Module
//
// Die Ratchet-Suite (test:control-dialect) zaehlt nur, OB eine Zeilenaktion
// ihr Objekt nennt; hier steht, WELCHES sie nennt - an den Renderern selbst,
// mit dem Namen des Datensatzes, den die Zeile zeigt. Dazu die Beifang-Fixes,
// deren Wirkung kein Textguard sieht (Warnung erst auf den Versuch, der
// Lesedialog der Notiz mit "Bearbeiten").
// -------------------------------------------------------------------------

test('Kanon R5: Kontaktzeile nennt die Person an Anrufen und am Mehr-Menue', () => {
  withAccess({ contacts: 'write' }, () => {
    const html = contacts.renderContactItem(kontakt());
    assert.match(html, /href="tel:[^"]*"[^>]*aria-label="contacts\.callNamed\{&quot;name&quot;:&quot;Dr\. Meier&quot;\}"/,
      'zwoelf Zeilen, die alle "Anrufen" heissen, sind fuer den Screenreader eine');
    assert.match(html, /contact-more-menu__trigger popover-menu__trigger"[^>]*aria-label="common\.moreActionsNamed\{&quot;name&quot;:&quot;Dr\. Meier&quot;\}"/);
  });
});

test('Kanon R5: Geburtstagszeile nennt die Person an Bearbeiten und Loeschen', () => {
  withAccess({ calendar: 'write' }, () => {
    const html = birthdays.birthdayItemHtml({
      id: 5, name: 'Oma Ingrid', birth_date: '1955-03-01', next_birthday: '2027-03-01',
      days_until: 156, age_next: 72,
    });
    assert.match(html, /class="row-action" data-action="edit" aria-label="common\.editNamed\{&quot;name&quot;:&quot;Oma Ingrid&quot;\}"/);
    assert.match(html, /class="row-action row-action--danger" data-action="delete" aria-label="common\.deleteNamed\{&quot;name&quot;:&quot;Oma Ingrid&quot;\}"/);
  });
});

test('Kanon R5: Haushaltshilfe nennt Aufgabe und Person an ihren Zeilenaktionen', () => {
  const abbau = installMiniDom();
  try {
    hkState({
      tasks: [{ id: 3, name: 'Fenster putzen', area: 'Wohnzimmer', frequency_days: 14, urgency_status: 'ok', last_completed: '2026-07-01' }],
    });
    const aufgaben = hkContainer();
    withAccess({ housekeeping: 'write' }, () => hk.renderTasks(aufgaben));
    // Die Aufgabenzeile fuehrt seit R16 keine Zeilenaktion mehr: der Kreis
    // nennt die Aufgabe, der Zeilenkoerper traegt ihren Namen als Inhalt, und
    // das Loeschen im Dialogfuss nennt sie wieder (openTaskEditModal()).
    assert.match(aufgaben.html, /data-complete-task="3"\s+aria-label="housekeeping\.completeTask\{&quot;name&quot;:&quot;Fenster putzen&quot;\}"/);
    assert.match(HK_CODE, /data-delete-task="\$\{esc\(task\.id\)\}"\s+aria-label="\$\{esc\(t\('common\.deleteNamed', \{ name: task\.name \}\)\)\}"/);

    hkState({ tab: 'staff', workers: [{ id: 7, display_name: 'Ana', phone: '0151 000' }] });
    const personal = hkContainer();
    withAccess({ housekeeping: 'write' }, () => hk.renderStaff(personal));
    assert.match(personal.html, /class="row-action" type="button" data-edit-worker="7" aria-label="common\.editNamed\{&quot;name&quot;:&quot;Ana&quot;\}"/,
      'die geteilte Zeilenaktion statt eines violetten Sekundaerkreises, mit Namen');
  } finally {
    abbau();
  }
});

test('Kanon R5: Aufgabenkarte nennt die Aufgabe an Bearbeiten, Ablegen und Teilaufgabe', () => {
  withAccess({ tasks: 'write' }, () => {
    const html = tasks.renderTaskCard(aufgabe({ title: 'Muell rausbringen' }));
    const titel = '\\{&quot;title&quot;:&quot;Muell rausbringen&quot;\\}';
    assert.match(html, new RegExp(`class="row-action task-card__inline-action" data-action="edit-task"[^>]*aria-label="common\\.editNamed\\{&quot;name&quot;:&quot;Muell rausbringen&quot;\\}"`));
    assert.match(html, new RegExp(`data-action="archive-task"[^>]*aria-label="tasks\\.archiveNamed${titel}"`));
    assert.match(html, new RegExp(`data-action="add-subtask"[^>]*aria-label="tasks\\.subtaskAddNamed${titel}"`));
  });
});

test('Kanon R5: "Teilaufgabe hinzufuegen" traegt kein "+" im Text - beide Knoepfe bringen das Plus-Icon mit', async () => {
  // In der Detailansicht (task-detail.js) stand das Icon neben einem Text, der
  // selbst mit "+ " begann: "+ + Teilaufgabe hinzufuegen".
  const { readdirSync, readFileSync } = await import('node:fs');
  const dir = new URL('../public/locales/', import.meta.url);
  const mitPlus = readdirSync(dir).filter((f) => f.endsWith('.json'))
    .filter((f) => /^\s*\+/.test(JSON.parse(readFileSync(new URL(f, dir), 'utf8')).tasks.subtaskAdd));
  assert.deepEqual(mitPlus, []);
  withAccess({ tasks: 'write' }, () => {
    const html = tasks.renderTaskCard(aufgabe({ subtasks: [{ id: 8, title: 'Tonne', status: 'open' }] }));
    assert.match(html, /class="subtask-item__add"[^>]*>\s*<i data-lucide="plus"/, 'die Kartenliste bringt ihr Plus jetzt als Icon');
  });
});

test('Kanon R5: die Countdown-Warnung antwortet auf einen Versuch, nicht auf ein leeres Formular', () => {
  const el = (extra = {}) => ({
    listeners: {},
    addEventListener(type, fn) { (this.listeners[type] ??= []).push(fn); },
    fire(type) { for (const fn of this.listeners[type] ?? []) fn(); },
    ...extra,
  });
  const label = el();
  const toggle = el({ checked: false, disabled: false, closest: (sel) => (sel === 'label' ? label : null) });
  const due = el({ value: '' });
  const warn = { hidden: true };
  const nodes = { '#task-countdown': toggle, '#task-due-date': due, '#task-countdown-warning': warn };
  tasks.wireCountdownGate({ querySelector: (sel) => nodes[sel] ?? null });

  assert.equal(toggle.disabled, true, 'ohne Faelligkeit bleibt der Schalter gesperrt');
  assert.equal(warn.hidden, true, 'auf dem frischen Formular steht keine Warnung');

  label.fire('click');
  assert.equal(warn.hidden, false, 'wer den gesperrten Schalter antippt, erfaehrt warum');

  due.value = '26.09.2026';
  due.fire('change');
  assert.equal(toggle.disabled, false);
  assert.equal(warn.hidden, true, 'mit Faelligkeit ist die Frage beantwortet');

  // Wer den Haken setzt und die Faelligkeit dann wieder entfernt, verliert ihn -
  // das ist der zweite Moment, in dem die Erklaerung gebraucht wird.
  const frischLabel = el();
  const frischToggle = el({ checked: true, disabled: false, closest: () => frischLabel });
  const frischDue = el({ value: '26.09.2026' });
  const frischWarn = { hidden: true };
  const frisch = { '#task-countdown': frischToggle, '#task-due-date': frischDue, '#task-countdown-warning': frischWarn };
  tasks.wireCountdownGate({ querySelector: (sel) => frisch[sel] ?? null });
  assert.equal(frischWarn.hidden, true);
  frischDue.value = '';
  frischDue.fire('input');
  assert.equal(frischToggle.checked, false);
  assert.equal(frischWarn.hidden, false);
});

test('Kanon R5: der Lesedialog einer Notiz fuehrt "Bearbeiten" als Primaerknopf, nicht nur "Loeschen"', () => {
  const abbau = installMiniDom();
  try {
    const offen = mitEchtemMarkdown(() => withAccess({ notes: 'write' }, () => (
      modalOptionen(() => notes.openNoteModal({ mode: 'edit', note: notiz() }))
    )));
    assert.match(offen.content, /<button type="button" class="btn btn--primary" id="note-modal-edit" data-reader-only>common\.edit<\/button>/);
    assert.match(offen.content, /id="note-modal-delete"[^>]*>\s*<i data-lucide="trash-2"/, 'Loeschen als Textknopf mit Icon, links');
    const neu = withAccess({ notes: 'write' }, () => modalOptionen(() => notes.openNoteModal({ mode: 'create' })));
    assert.doesNotMatch(neu.content, /note-modal-edit/, 'eine neue Notiz oeffnet im Editor - dort gibt es nichts umzuschalten');
  } finally {
    abbau();
  }
});

test('Kanon R5: Notizkarte nennt die Notiz an Oeffnen und Loeschen', () => {
  mitEchtemMarkdown(() => withAccess({ notes: 'write' }, () => {
    const html = notes.renderNoteCard(notiz({ title: '' }));
    // Ohne Titel nennt sie die erste Zeile, ohne Markdown-Zeichen.
    assert.match(html, /class="note-card__open"[^>]*aria-label="notes\.openNamed\{&quot;name&quot;:&quot;Milch&quot;\}"/);
    assert.match(html, /class="row-action row-action--danger note-card__delete"[^>]*aria-label="common\.deleteNamed\{&quot;name&quot;:&quot;Milch&quot;\}"/);
  }));
});

test('Kanon R5: die Geburtstagsdialoge tragen den Modulton selbst - sie haengen nicht unter der Seite', async () => {
  const { readFileSync } = await import('node:fs');
  const css = readFileSync(new URL('../public/styles/birthdays.css', import.meta.url), 'utf8');
  const setzt = (sel) => [...eachRule(css)].some((r) => r.selector.split(',').map((s) => s.trim()).includes(sel)
    && /--module-accent\s*:\s*var\(--module-birthdays\)/.test(r.body) && r.at.length === 0);
  // Ohne das war `--module-accent` im Dialog leer und jedes color-mix() darauf
  // ungueltig: die Bildflaeche des Editors stand ohne Hintergrund.
  assert.ok(setzt('.birthday-modal'), '.birthday-modal setzt --module-accent');
  assert.ok(setzt('.bd-import'), '.bd-import setzt --module-accent');
});

test('Kanon R5: der Kanban-Statusknopf trifft auf --target-base, obwohl er 24px zeigt', async () => {
  const { readFileSync } = await import('node:fs');
  const css = readFileSync(new URL('../public/styles/tasks.css', import.meta.url), 'utf8');
  const regeln = [...eachRule(css)];
  const knopf = regeln.find((r) => r.selector === '.kanban-card__status-btn');
  const flaeche = regeln.find((r) => r.selector === '.kanban-card__status-btn::before');
  assert.ok(knopf && /position:\s*relative/.test(knopf.body), 'der Knopf ist Bezugsrahmen seines ::before');
  assert.doesNotMatch(knopf.body, /overflow\s*:/, 'overflow am Knopf clippte das eigene ::before (die Falle am Budget-Titel)');
  assert.ok(flaeche, 'ohne ::before ist die 24px-Box die ganze Trefferflaeche');
  assert.match(flaeche.body, /content:\s*''/);
  assert.match(flaeche.body, /position:\s*absolute/);
  assert.match(flaeche.body, /inset:\s*calc\(\(100% - var\(--target-base\)\) \/ 2\)/);
});

// -------------------------------------------------------------------------
// R8 H14: Kontakte und Dokumente waehlen per Auswahlkreis, nicht per Checkbox
// -------------------------------------------------------------------------

/** Ein Knoten mit Klassenliste und Attributen, genug fuer die Umschalter. */
function schalterKnoten(attrs = {}) {
  const klassen = new Set();
  const knoten = {
    dataset: {}, disabled: false, attrs: { ...attrs },
    classList: { toggle: (k, an) => { if (an) klassen.add(k); else klassen.delete(k); }, contains: (k) => klassen.has(k) },
    setAttribute(k, v) { this.attrs[k] = String(v); },
    getAttribute(k) { return this.attrs[k] ?? null; },
  };
  knoten.klassen = klassen;
  return knoten;
}

test('R8 H14: Kontakt-Auswahl ist ein Knopf mit Auswahlkreis und Objektnamen, keine native Checkbox', async () => {
  const vorher = { mode: contacts.state.selectMode, sel: new Set(contacts.state.selected) };
  // Der Tipp malt die Bulk-Pille (utils/bulk-pill.js liest `document`). Ohne
  // eigenes document hing der Test davon ab, ob ein frueherer Test eines
  // liegen liess: im vollen Lauf gruen, einzeln und in der CI rot. Ohne
  // Shell-Schicht (getElementById -> null) malt die Pille nichts.
  const echtesDocument = globalThis.document;
  globalThis.document = { getElementById: () => null };
  try {
    contacts.state.selectMode = true;
    contacts.state.selected = new Set([7]);
    const an = contacts.renderContactItem({ id: 7, name: 'Ada Lovelace' });
    assert.doesNotMatch(an, /type="checkbox"/, 'die native Checkbox ist weg');
    assert.match(an, /<button type="button" class="select-circle select-circle--on" data-select="7"\s+aria-pressed="true" aria-label="contacts\.selectNamed\{&quot;name&quot;:&quot;Ada Lovelace&quot;\}"/);
    assert.match(an, /<div class="contact-item__open list-row__main--interactive contact-item__select">/,
      'die Zeile bleibt Trefflaeche, ist aber kein Knopf mit aria-label, der Name und Nummer verschluckt');
    const aus = contacts.renderContactItem({ id: 8, name: 'Grace' });
    assert.match(aus, /<button type="button" class="select-circle" data-select="8"\s+aria-pressed="false"/);
    assert.match(contacts.renderContactItem({ id: 9, name: 'Papa', family_user_id: 3 }), /data-select="9"[^>]*disabled>/,
      'Familien-Kontakte sind einzeln nicht loeschbar und damit nicht waehlbar');

    // Der Tipp als Programm: Menge, aria-pressed, Kreis und Zeile gehen zusammen.
    const zeile = schalterKnoten();
    const knopf = schalterKnoten({ 'aria-pressed': 'false' });
    knopf.dataset.select = '8';
    knopf.closest = (sel) => (sel === '.contact-item' ? zeile : null);
    contacts.toggleContactSelection(knopf);
    assert.ok(contacts.state.selected.has(8));
    assert.equal(knopf.attrs['aria-pressed'], 'true');
    assert.ok(knopf.klassen.has('select-circle--on'));
    assert.ok(zeile.klassen.has('contact-item--selected'));
    contacts.toggleContactSelection(knopf);
    assert.ok(!contacts.state.selected.has(8));
    assert.equal(knopf.attrs['aria-pressed'], 'false');
    knopf.disabled = true;
    contacts.toggleContactSelection(knopf);
    assert.ok(!contacts.state.selected.has(8), 'ein gesperrter Knopf waehlt nicht');
  } finally {
    contacts.state.selectMode = vorher.mode;
    contacts.state.selected = vorher.sel;
    globalThis.document = echtesDocument;
  }
});

test('R8 H14: Dokument-Auswahl ist ein Auswahlkreis mit Objektnamen, keine native Checkbox', () => {
  const st = documentsPage.state;
  const vorher = { mode: st.selectMode, sel: new Set(st.selected), ich: st.currentUserId, alle: st.allDocuments };
  // Seit #1265 traegt nur ein Dokument einen Kreis, das die Person verwalten
  // darf (Besitzregel): beide Dokumente hier gehoeren ihr.
  st.currentUserId = 7;
  st.allDocuments = [{ id: 4, name: 'Mietvertrag.pdf', created_by: 7 }, { id: 5, name: 'x', created_by: 7 }];
  // Eigenes document: die Sammelaktions-Pille sucht ihre Schicht - ohne Shell
  // gibt es keine, und der Test darf nicht vom Rest eines frueheren leben.
  const echtesDocument = globalThis.document;
  globalThis.document = { getElementById: () => null };
  try {
    st.selectMode = true;
    st.selected = new Set([4]);
    const an = documentsPage.renderSelectBox({ id: 4, name: 'Mietvertrag.pdf', created_by: 7 });
    assert.doesNotMatch(an, /type="checkbox"/);
    assert.match(an, /<button type="button" class="select-circle select-circle--on"/);
    assert.match(an, /data-select-id="4" aria-pressed="true"/);
    assert.match(an, /aria-label="documents\.selectDocument\{&quot;name&quot;:&quot;Mietvertrag\.pdf&quot;\}"/);
    assert.match(documentsPage.renderSelectBox({ id: 5, name: 'x', created_by: 7 }), /aria-pressed="false"/);

    documentsPage.setContainerForTest({ querySelector: () => null, querySelectorAll: () => [] });
    const kreis = schalterKnoten({ 'aria-pressed': 'false' });
    const karte = schalterKnoten();
    karte.dataset.id = '5';
    karte.querySelector = (sel) => (sel === '[data-select-id]' ? kreis : null);
    documentsPage.toggleDocumentSelection(karte);
    assert.ok(st.selected.has(5));
    assert.equal(kreis.attrs['aria-pressed'], 'true');
    assert.ok(kreis.klassen.has('select-circle--on'));
    assert.ok(karte.klassen.has('is-selected'));
  } finally {
    st.selectMode = vorher.mode;
    st.selected = vorher.sel;
    st.currentUserId = vorher.ich;
    st.allDocuments = vorher.alle;
    documentsPage.setContainerForTest(null);
    globalThis.document = echtesDocument;
  }
});
