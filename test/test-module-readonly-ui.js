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

/** Ein Modul auf 'read' stellen und danach wieder aufräumen. */
function withAccess(modules, fn) {
  setPermissions({ admin: false, modules, widgets: {}, capabilities: {} });
  try {
    return fn();
  } finally {
    clearPermissions();
  }
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
    assert.match(html, /<span class="task-status-btn task-status-btn--open task-status-btn--static"[\s\S]*?role="img"/,
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
  for (const [name, klassen, ruhend] of [
    ['erledigt', ['task-status-btn', 'task-status-btn--done', 'task-status-btn--static'], 'var(--color-success)'],
    ['in Arbeit', ['task-status-btn', 'task-status-btn--in_progress', 'task-status-btn--static'], 'var(--color-warning)'],
  ]) {
    assert.equal(effektiverWert(TASKS_CSS, klassen, 'border-color', ':hover::after'), null,
      `${name}: keine Hover-Regel darf das Zeichen treffen`);
    assert.equal(effektiverWert(TASKS_CSS, klassen, 'border-color', '::after'), ruhend,
      `${name}: der Ring behaelt die Farbe, die den Zustand traegt`);
  }
  // Der bedienbare Knopf behaelt seine Hover-Reaktion.
  assert.match(
    effektiverWert(TASKS_CSS, ['task-status-btn', 'task-status-btn--done'], 'border-color', ':hover::after') ?? '',
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

test('Kalender: FAB, Kopfknopf und beide Leerzustands-CTAs hängen an readOnly()', () => {
  for (const [name, muster] of [
    ['der FAB', /\$\{readOnly\(\) \? '' : `\s*<button class="page-fab" id="fab-new-event"/],
    ['der Kopfknopf', /\$\{readOnly\(\) \? '' : `\s*<button class="btn btn--primary toolbar-new-btn" id="cal-add"/],
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
  // Und die einzige nicht schreibende Aktion bleibt bedingungslos drin.
  assert.match(CAL_CODE, /id: 'detail-open-map'/);
  const mapBlock = CAL_CODE.slice(CAL_CODE.indexOf('const mapUrl = eventMapUrl(ev.location);'), CAL_CODE.indexOf("id: 'detail-open-map'"));
  assert.ok(!mapBlock.includes('readOnly()'), '"In Karte öffnen" schreibt nichts und gehört auch einem Nur-lesen-Nutzer');
});

// -------------------------------------------------------------------------
// Die Begründung für das Ausblenden des Einlösens - am Server gemessen
// -------------------------------------------------------------------------

test('die Ausnahmen vom Modulrecht stehen am Server, und es sind genau zwei Sorten', () => {
  // WOVON DIESE SEITE ABHÄNGT. Bekäme `/rewards/redemptions` eine
  // Niveau-Senkung wie `/schedule/preferences`, gehörte der Einlöse-Knopf
  // einem Menschen mit `rewards: read` zurück. Und verlöre ein Display seine
  // benannten Schreibrouten, gehörten Personenauswahl und Tablett-Einlösen
  // weg. Beides sind Entscheidungen, die anderswo fallen - dieser Test macht
  // die Kopplung sichtbar, statt sie zu erraten.
  const scopes = readFileSync(new URL('../server/scopes.js', import.meta.url), 'utf8');
  const fn = scopes.slice(scopes.indexOf('function sessionModuleAccessRequirement(path, method) {'));
  const body = fn.slice(0, fn.indexOf('\n}\n'));
  assert.match(body, /path === '\/schedule\/preferences'/);
  assert.ok(!body.includes('rewards'),
    'eine Senkung für /rewards hieße: der Einlöse-Knopf gehört in rewards.js zurück');

  // Die zweite Sorte: benannte Routen für ein gekoppeltes Gerät.
  const display = readFileSync(new URL('../server/display-scopes.js', import.meta.url), 'utf8');
  assert.match(display, /DISPLAY_SCOPES = Object\.freeze\(\[[\s\S]*?'tasks:read'/,
    'ein Display liest Aufgaben - deshalb greift die Modulregel dieser Seite auf ihm überhaupt');
  assert.match(display, /DISPLAY_WRITE_ROUTES/,
    'und schreibt genau die Routen, die diese Liste benennt');
});

test.after(() => miniDomAbraeumen());
