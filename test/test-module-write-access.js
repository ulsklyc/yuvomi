/**
 * Modul: Nur-lesen-Rechte, das Fundament (#1265, Paket P0)
 * Zweck: Die zwoelf Seiten aus #1265 sollen nicht zwoelfmal dieselbe Frage
 *        beantworten. Dieses Paket legt die gemeinsamen Teile hin und schliesst
 *        die zwei Befunde, die schon FERTIGE Seiten betrafen:
 *
 *        1. `public/utils/module-access.js` - EIN Helfer fuer „darf ich in
 *           Modul X schreiben", fuer das eigene und ein fremdes Modul, gefragt
 *           mit dem API-Pfad. Er traegt eine KOPIE der Zuordnung aus
 *           `server/scopes.js`; der Drift-Guard unten haelt sie Eintrag fuer
 *           Eintrag UND im Urteil gegen das Original - fuer jeden Pfad, den
 *           `public/` an die API schickt, je Modul und Zugriffsstufe gegen
 *           `sessionModuleAccessRequirement()` und `moduleAccessVerdict()`.
 *           Dazu die drei Zuordnungen, die Praefix-Raten falsch macht
 *           (`/reminders` -> calendar, `/recipes` -> meals, `/split-expenses`
 *           -> budget), und `dashboard`, das kein Rechte-Modul ist und nichts
 *           sperren darf.
 *        2. Der `n`-Kurzbefehl klickte `.page-fab` auch dann, wenn layout.css
 *           ihn bei Nur-lesen per `display: none` ausgeblendet hatte - auf
 *           jeder Seite ohne eigenen Riegel im FAB-Handler oeffnete sich der
 *           Anlegedialog. Gemessen am EFFEKT: der Klick erreicht den FAB nicht.
 *        3. `components/document-attach.js` hatte keine Rechteabfrage. Wer
 *           `tasks: write` und `documents: read` hatte, sah ein Hochladen-Feld,
 *           dessen Speichern im 403 endete - auf der als fertig gefuehrten
 *           Aufgabenseite. Gefahren wird der ECHTE bind() gegen ein Feld, das
 *           aus dem echten Markup gebaut ist, bis zum commit().
 *        4. `utils/kitchen-transfer.js`: Ruecknahme und Ausweg schreiben in den
 *           Einkauf und fragen jetzt dessen Recht.
 *        5. `components/category-manager.js`: die Entscheidung „der Aufrufer
 *           versteckt den Ausloeser" traegt nur, solange jeder `basePath` dem
 *           Modul der Seite gehoert. Das haelt der letzte Test.
 *
 *        Die Regel dahinter steht in `test/test-module-readonly-ui.js`: Zustand
 *        bleibt als Zeichen, Handlung verschwindet, `none` entfernt.
 *
 * Ausführen: npm run test:module-write-access
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { eachRule } from './css-rules.js';
import { withoutCommentsKeepingLines } from './source-text.js';

// Die Aufgabenseite zieht Web Components mit, die zur Ladezeit von HTMLElement
// ableiten (Muster aus test-module-readonly-ui.js).
globalThis.HTMLElement = globalThis.HTMLElement ?? class {};
globalThis.customElements = globalThis.customElements ?? { define() {}, get() {} };

const { installMiniDom } = await import('./mini-dom.js');
installMiniDom();

const serverScopes = await import('../server/scopes.js');
const serverPerms = await import('../server/permissions.js');
const { setPermissions, clearPermissions, isNavModuleReadOnly } = await import('../public/permissions.js');
const access = await import('../public/utils/module-access.js');
const fab = await import('../public/utils/fab.js');
const attach = await import('../public/components/document-attach.js');
const transfer = await import('../public/utils/kitchen-transfer.js');
const { __test: tasks } = await import('../public/pages/tasks.js');

const PUBLIC_DIR = new URL('../public/', import.meta.url);
const read = (rel) => readFileSync(new URL(rel, import.meta.url), 'utf8');
const PERMISSION_KEYS = serverPerms.PERMISSION_MODULES.map((m) => m.key);

/** Rechte setzen, `fn` laufen lassen, danach wieder aufraeumen (auch async). */
function withAccess(modules, fn, { admin = false } = {}) {
  setPermissions({ admin, modules, widgets: {}, capabilities: {} });
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

/** Alle .js-Dateien unter public/ ausser vendor - relativ zu public/. */
function publicSources(dir = PUBLIC_DIR, prefix = '') {
  const out = [];
  for (const entry of readdirSync(dir)) {
    if (entry === 'vendor' || entry === 'locales') continue;
    const url = new URL(entry, dir);
    if (statSync(url).isDirectory()) {
      out.push(...publicSources(new URL(`${entry}/`, dir), `${prefix}${entry}/`));
    } else if (entry.endsWith('.js')) {
      out.push({ rel: `${prefix}${entry}`, src: withoutCommentsKeepingLines(readFileSync(url, 'utf8')) });
    }
  }
  return out;
}
const SOURCES = publicSources();

/**
 * Das erste Argument eines Aufrufs ab `start` (dem Anfuehrungszeichen), als
 * Pfad gelesen: jede `${…}`-Ersetzung wird zu `1`. Genau muss das nicht sein -
 * der Drift-Guard vergleicht zwei Urteile ueber DENSELBEN Text, jeder Text ist
 * ein gueltiger Fall.
 */
function literalAt(src, start) {
  const quote = src[start];
  let out = '';
  for (let i = start + 1; i < src.length; i += 1) {
    const ch = src[i];
    if (ch === quote) return out;
    if (ch === '\n' && quote !== '`') return null;
    if (quote === '`' && ch === '$' && src[i + 1] === '{') {
      let depth = 1;
      i += 2;
      while (i < src.length && depth > 0) {
        if (src[i] === '{') depth += 1;
        else if (src[i] === '}') depth -= 1;
        i += 1;
      }
      i -= 1;
      out += '1';
      continue;
    }
    out += ch;
  }
  return null;
}

// =========================================================================
// 1. Der Helfer
// =========================================================================

test('Helfer: die Zuordnungen, die Praefix-Raten falsch macht', () => {
  const erwartet = {
    '/reminders': 'calendar',
    '/reminders?entity_type=task&entity_id=7': 'calendar',
    '/birthdays/3': 'calendar',
    '/recipes/12/to-shopping-list': 'meals',
    '/recipe-providers/accounts': 'meals',
    '/split-expenses/groups/4/expenses': 'budget',
    '/documents': 'documents',
    '/Notes/1': 'notes',
  };
  for (const [pfad, modul] of Object.entries(erwartet)) {
    assert.equal(access.moduleForApiPath(pfad), modul, pfad);
  }

  // Und das Urteil daran: das RECHT des Zielmoduls entscheidet, nicht das der
  // Seite, von der aus geschrieben wird.
  withAccess({ tasks: 'write', calendar: 'read' }, () => {
    assert.equal(access.mayWritePath('/tasks/7'), true);
    assert.equal(access.mayWritePath('/reminders'), false,
      'eine Erinnerung gehoert dem Kalender - `tasks: write` sagt darueber nichts (#1253)');
    assert.equal(access.pathAccess('/reminders?entity_type=task'), 'read');
  });
  withAccess({ meals: 'read', shopping: 'write' }, () => {
    assert.equal(access.mayWritePath('/recipes/1'), false, 'Rezepte sind `meals`');
    assert.equal(access.mayWritePath('/shopping'), true);
  });
  withAccess({ budget: 'none' }, () => {
    assert.equal(access.pathAccess('/split-expenses/groups'), 'none', 'Gemeinsame Ausgaben sind `budget`');
  });
});

test('Helfer: drei Stufen, fail-open ohne geladene Rechte, Admin darf alles', () => {
  clearPermissions();
  assert.equal(access.pathAccess('/documents'), 'write', 'ohne Rechte-Payload fail-open wie permissions.js');
  withAccess({ documents: 'none' }, () => assert.equal(access.pathAccess('/documents/5'), 'none'));
  withAccess({ documents: 'read' }, () => assert.equal(access.pathAccess('/documents/5'), 'read'));
  withAccess({ documents: 'write' }, () => assert.equal(access.pathAccess('/documents/5'), 'write'));
  withAccess({ documents: 'none' }, () => assert.equal(access.mayWritePath('/documents'), true), { admin: true });
});

test('Helfer: fuer das eigene Modul gleichwertig zu isNavModuleReadOnly()', () => {
  // Regel 1 im Kopf des Helfers verspricht das; die fertigen Seiten fragen
  // `isNavModuleReadOnly('<nav>')`, neue duerfen den Helfer nehmen.
  for (const mod of serverPerms.PERMISSION_MODULES) {
    const praefix = serverScopes.SCOPE_MODULES.find((s) => s.key === mod.key).prefixes[0];
    withAccess({ [mod.key]: 'read' }, () => {
      for (const nav of mod.navIds) {
        assert.equal(access.mayWritePath(`/${praefix}/1`), !isNavModuleReadOnly(nav), `${mod.key}/${nav}`);
      }
    });
  }
});

test('Helfer: `dashboard` ist kein Rechte-Modul und sperrt nichts', () => {
  // Das strengste Mitglied: jedes Rechte-Modul auf `none`. Die Kachelreihe der
  // Uebersicht (`/quick-links`) und die Uebersicht selbst liegen trotzdem nicht
  // darunter - server/permissions.js fuehrt `dashboard` nicht, und
  // moduleAccessVerdict() laesst ein nicht genanntes Modul durch. Ein Helfer,
  // der „nicht in der Payload" als `none` liest (die Allowlist-Reflexe aus
  // anderen Stellen), wuerde hier den Quick-Links-Verwalter sperren.
  const alleGesperrt = Object.fromEntries(PERMISSION_KEYS.map((key) => [key, 'none']));
  withAccess(alleGesperrt, () => {
    for (const pfad of ['/quick-links', '/quick-links/3', '/dashboard/layout', '/weather', '/family/members', '/search?q=x', '/auth/me', '/preferences']) {
      assert.equal(access.pathAccess(pfad), 'write', pfad);
      assert.equal(access.mayWritePath(pfad), true, pfad);
    }
    assert.equal(access.mayWritePath('/tasks'), false, 'Gegenprobe: die Rechte-Module sind wirklich gesperrt');
  });
  assert.equal(PERMISSION_KEYS.includes('dashboard'), false,
    'wird `dashboard` je ein Rechte-Modul, gehoert diese Zusicherung neu entschieden');
});

test('Helfer: `/schedule/preferences` bildet die EINE Serverausnahme exakt ab', () => {
  withAccess({ schedule: 'read' }, () => {
    assert.equal(access.mayWritePath('/schedule/preferences'), true, 'S-12: die eigene Vorlaufzeit bleibt');
    assert.equal(access.mayWritePath('/schedule/preferences?x=1'), true, 'die Query gehoert nicht zum Pfad');
    assert.equal(access.mayWritePath('/schedule/preferencesX'), false, 'exakt, kein startsWith');
    assert.equal(access.mayWritePath('/schedule/shifts'), false, 'nur dieser eine Pfad');
  });
  withAccess({ schedule: 'none' }, () => {
    assert.equal(access.mayWritePath('/schedule/preferences'), false, 'bei `none` bleibt es gesperrt');
  });
});

test('Helfer: Rezept -> Einkauf bildet die zweite Serverausnahme exakt ab (#1290)', () => {
  withAccess({ meals: 'read' }, () => {
    assert.equal(access.mayWritePath('/recipes/7/to-shopping-list'), true, 'die Quelle wird nur gelesen');
    assert.equal(access.mayWritePath('/Recipes/7/To-Shopping-List/'), true, 'gefaltet wie der Server');
    assert.equal(access.mayWritePath('/recipes/7/to-shopping-listX'), false, 'exakt, kein startsWith');
    assert.equal(access.mayWritePath('/recipes/7'), false, 'jeder andere Schreibweg bleibt `meals: write`');
    assert.equal(access.mayWritePath('/meals/7/to-shopping-list'), false, 'Mahlzeit -> Einkauf schreibt in den Plan');
  });
  withAccess({ meals: 'none' }, () => {
    assert.equal(access.mayWritePath('/recipes/7/to-shopping-list'), false, 'bei `none` bleibt es gesperrt');
  });
});

// =========================================================================
// 2. Drift-Guard gegen server/scopes.js
// =========================================================================

test('Drift-Guard: die benannten Ausnahmen sind eine exakte Kopie von READ_LEVEL_WRITES', () => {
  const plain = (list) => list.map((e) => ({
    id: e.id, pattern: e.pattern, flags: e.flags,
    methods: e.methods === null ? null : [...e.methods], axes: [...e.axes],
  }));
  assert.deepEqual(plain(access.READ_LEVEL_WRITES), plain(serverScopes.READ_LEVEL_WRITES),
    'public/utils/module-access.js muss server/scopes.js folgen - dort geaendert, hier nachziehen');
  assert.deepEqual(serverScopes.READ_LEVEL_WRITES.map((e) => e.id), ['schedule-preferences', 'recipe-to-shopping'],
    'eine neue Ausnahme ist eine Entscheidung - diese Liste haelt fest, dass es genau diese zwei gibt');
});

test('Drift-Guard: die Tabelle ist eine exakte Kopie von SCOPE_MODULES', () => {
  const plain = (list) => list.map((m) => ({ key: m.key, prefixes: [...m.prefixes] }));
  assert.deepEqual(plain(access.SCOPE_MODULES), plain(serverScopes.SCOPE_MODULES),
    'public/utils/module-access.js muss server/scopes.js folgen - dort geaendert, hier nachziehen');
});

/** Jeder Pfad, den public/ an die API schickt, plus die Randfaelle. */
function pfadKorpus() {
  const pfade = new Set([
    '', '/', '//tasks', '/Notes/1', '/auth/me', '/preferences', '/quick-links', '/dashboard/layout',
    '/schedule/preferences', '/schedule/preferences?x=1', '/schedule/preferencesX', '/Schedule/preferences',
    '/reminders?entity_type=task&entity_id=1', '/extensions/demo/items', '/recipe-providers/accounts',
    '/split-expenses/groups/1/expenses', '/birthdays/1', '/weather', '/family/members', '/search?q=x',
    '/shopping/items/undo-transfer', '/documents#x',
    '/recipes/1/to-shopping-list', '/Recipes/1/To-Shopping-List/', '/recipes/1/to-shopping-listX',
    '/recipes/x/to-shopping-list', '/recipes/1', '/meals/1/to-shopping-list',
  ]);
  const aufruf = /\bapi\.(?:get|getWithSource|post|put|patch|delete)\(\s*(['"`])/g;
  for (const { src } of SOURCES) {
    for (const m of src.matchAll(aufruf)) {
      const pfad = literalAt(src, m.index + m[0].length - 1);
      if (pfad?.startsWith('/')) pfade.add(pfad);
    }
  }
  return [...pfade];
}
const KORPUS = pfadKorpus();

test('Drift-Guard: der Korpus traegt die Pfade der Seiten wirklich', () => {
  // Ohne diese Zeile koennte ein kaputter Extraktor den Vergleich unten auf
  // die zwanzig Randfaelle schrumpfen lassen, und er bliebe gruen.
  assert.ok(KORPUS.length > 300, `nur ${KORPUS.length} Pfade gefunden`);
  for (const muss of ['/documents', '/shopping/items/undo-transfer', '/pantry/import-shopping']) {
    assert.ok(KORPUS.includes(muss), `${muss} fehlt im Korpus`);
  }
});

test('Drift-Guard: dasselbe Modul fuer jeden Pfad', () => {
  const abweichend = KORPUS.filter((pfad) => (
    access.moduleForApiPath(pfad) !== serverScopes.moduleForPath(pfad.split(/[?#]/, 1)[0])
  ));
  assert.deepEqual(abweichend, []);
});

test('Drift-Guard: dasselbe Urteil fuer jeden Pfad, je Modul und Stufe', () => {
  // Jedes Rechte-Modul einzeln auf jede Stufe, die anderen auf `write`: nur so
  // faellt eine VERWECHSLUNG zweier Module auf. Staenden alle zugleich auf
  // `read`, urteilten `/reminders -> tasks` und `/reminders -> calendar` gleich.
  const lagen = [
    { name: 'ohne Rechte-Payload', resolved: null },
    { name: 'Admin', resolved: { admin: true, modules: Object.fromEntries(PERMISSION_KEYS.map((k) => [k, 'write'])) } },
  ];
  for (const key of PERMISSION_KEYS) {
    for (const level of ['none', 'read', 'write']) {
      lagen.push({
        name: `${key}=${level}`,
        resolved: {
          admin: false,
          modules: Object.fromEntries(PERMISSION_KEYS.map((k) => [k, k === key ? level : 'write'])),
        },
      });
    }
  }
  const abweichend = [];
  for (const { name, resolved } of lagen) {
    if (resolved) setPermissions({ ...resolved, widgets: {}, capabilities: {} });
    else clearPermissions();
    const session = serverPerms.buildSessionModuleAccess(resolved);
    for (const pfad of KORPUS) {
      const reqPfad = pfad.split(/[?#]/, 1)[0];
      const req = serverScopes.sessionModuleAccessRequirement(reqPfad, 'POST');
      const schreiben = serverPerms.moduleAccessVerdict(session, req.moduleKey, req.access) === serverPerms.MODULE_ACCESS_ALLOW;
      const lesen = serverPerms.moduleAccessVerdict(session, serverScopes.moduleForPath(reqPfad), 'read') === serverPerms.MODULE_ACCESS_ALLOW;
      if (access.mayWritePath(pfad) !== schreiben) abweichend.push(`${name} schreiben ${pfad}`);
      if ((access.pathAccess(pfad) !== 'none') !== lesen) abweichend.push(`${name} lesen ${pfad}`);
    }
  }
  clearPermissions();
  assert.deepEqual(abweichend.slice(0, 20), [], `${abweichend.length} Abweichungen`);
});

test('Aufrufer des Helfers fragen mit einem lesbaren Pfad in ein Rechte-Modul', () => {
  // Ein Pfad ohne Modul ist fuer den Helfer immer `write` - ein Tippfehler
  // (`/shoping`) sperrte also nie etwas und fiele nie auf. Deshalb muss jede
  // Frage ein Literal sein, das der Server einem Rechte-Modul zuordnet.
  const frage = /\b(mayWritePath|pathAccess)\(/g;
  const funde = [];
  for (const { rel, src } of SOURCES) {
    if (rel === 'utils/module-access.js') continue;
    for (const m of src.matchAll(frage)) {
      const start = m.index + m[0].length;
      const pfad = /['"`]/.test(src[start]) ? literalAt(src, start) : null;
      assert.ok(pfad?.startsWith('/'), `${rel}: ${m[1]}() braucht einen Pfad-Literal, damit dieser Guard ihn lesen kann`);
      const modul = serverScopes.moduleForPath(pfad);
      assert.ok(PERMISSION_KEYS.includes(modul), `${rel}: ${m[1]}('${pfad}') trifft kein Rechte-Modul (${modul})`);
      funde.push(`${rel} ${pfad}`);
    }
  }
  for (const erwartet of [
    'components/document-attach.js /documents',
    'utils/kitchen-transfer.js /shopping',
    'utils/kitchen-transfer.js /shopping/items/undo-transfer',
  ]) {
    assert.ok(funde.includes(erwartet), `${erwartet} fragt nicht (mehr) ueber den Helfer`);
  }
});

// =========================================================================
// 3. Der `n`-Kurzbefehl
// =========================================================================

/**
 * Eine Seite mit FAB. Sein Klick ist das, was jede ungeriegelte Seite daraus
 * macht: der Anlegedialog geht auf, und dessen Speichern schreibt. Gemessen
 * wird also nicht, ob eine Funktion `false` sagt, sondern ob der Klick den
 * Knopf erreicht.
 */
function seiteMitFab({ nurLesen }) {
  const effekte = [];
  const knopf = {
    click() {
      effekte.push('dialog');
      effekte.push('POST /notes');
    },
  };
  const doc = {
    documentElement: { hasAttribute: (name) => nurLesen && name === 'data-module-readonly' },
    querySelector: (sel) => (sel === '.page-fab' ? knopf : null),
  };
  return { doc, effekte };
}

test('`n` bei Nur-lesen: kein Dialog, kein Schreibaufruf', () => {
  const { doc, effekte } = seiteMitFab({ nurLesen: true });
  assert.equal(fab.triggerPageFab(doc), false);
  assert.deepEqual(effekte, [], 'der per CSS versteckte FAB darf nicht per .click() erreichbar sein');
});

test('`n` mit Schreibrecht: der FAB oeffnet wie bisher (Gegenfall)', () => {
  const { doc, effekte } = seiteMitFab({ nurLesen: false });
  assert.equal(fab.triggerPageFab(doc), true);
  assert.deepEqual(effekte, ['dialog', 'POST /notes']);
  // Ohne FAB (Einstellungen, Seiten ohne Anlegen) passiert nichts und nichts wirft.
  assert.equal(fab.triggerPageFab({ documentElement: { hasAttribute: () => false }, querySelector: () => null }), false);
});

test('`n` im Router laeuft ueber triggerPageFab() und klickt nirgends selbst', () => {
  const router = withoutCommentsKeepingLines(read('../public/router.js'));
  const eintrag = router.split('\n').find((zeile) => /\{\s*key:\s*'n',/.test(zeile));
  assert.ok(eintrag, 'der SHORTCUTS-Eintrag fuer `n` fehlt');
  assert.match(eintrag, /action:\s*\(\)\s*=>\s*triggerPageFab\(\)/);
  assert.match(router, /import \{ triggerPageFab \} from '\/utils\/fab\.js';/);
  assert.doesNotMatch(router, /\.page-fab['"]\)\??\.click\(\)/,
    'ein zweiter Weg, der den FAB am Riegel vorbei klickt');
});

test('`n`, Router und CSS lesen DASSELBE Attribut', () => {
  // Der Kurzbefehl soll genau das tun, was ein Klick auf den sichtbaren Knopf
  // taete. Das haelt nur, solange alle drei Stellen dasselbe Attribut meinen.
  const router = withoutCommentsKeepingLines(read('../public/router.js'));
  assert.match(router, /toggleAttribute\('data-module-readonly', readOnly\)/);
  assert.match(withoutCommentsKeepingLines(read('../public/utils/fab.js')),
    /hasAttribute\('data-module-readonly'\)/);
  const versteckt = [...eachRule(read('../public/styles/layout.css'))].some(({ selector, body, at }) => (
    !at.length
    && selector.split(',').map((s) => s.trim()).includes('html[data-module-readonly] .page-fab')
    && /display:\s*none/.test(body)
  ));
  assert.ok(versteckt, 'layout.css blendet den FAB nicht mehr ueber html[data-module-readonly] aus');
});

// =========================================================================
// 4. Das Beleg-Feld (components/document-attach.js)
// =========================================================================

const entschaerfen = (s) => s
  .replaceAll('&quot;', '"').replaceAll('&#039;', "'")
  .replaceAll('&lt;', '<').replaceAll('&gt;', '>').replaceAll('&amp;', '&');

/**
 * Ein Panel, gebaut aus dem ECHTEN Markup von renderDocumentAttachField():
 * es liefert genau die Knoten, deren Attribut im Markup steht, und merkt sich
 * jeden Listener. So misst der Test die Naht zwischen render() und bind() -
 * was render() nicht zeichnet, kann bind() nicht verdrahten.
 */
function panelAusMarkup(markup) {
  const hat = (attr) => new RegExp(`\\s${attr}(?=[\\s>=])`).test(markup);
  const knoten = () => {
    const k = {
      listeners: {},
      addEventListener(type, fn) { (k.listeners[type] ??= []).push(fn); },
      removeAttribute() {},
      click() { for (const fn of k.listeners.click ?? []) fn({}); },
    };
    return k;
  };
  const chips = Object.assign(knoten(), {
    html: '',
    replaceChildren() { chips.html = ''; },
    insertAdjacentHTML(_pos, html) { chips.html += html; },
  });
  const empty = { hidden: false };
  const input = hat('data-doc-attach-input') ? Object.assign(knoten(), { files: [], value: '' }) : null;
  const upload = hat('data-doc-attach-upload') ? knoten() : null;
  const pick = hat('data-doc-attach-pick') ? knoten() : null;
  const initial = /data-doc-attach-initial="([^"]*)"/.exec(markup)?.[1] ?? '[]';
  const field = Object.assign(knoten(), {
    dataset: {
      docAttachInitial: entschaerfen(initial),
      docAttachMax: /data-doc-attach-max="([^"]*)"/.exec(markup)?.[1] ?? '0',
    },
    classList: { toggle() {} },
    contains: () => false,
    querySelector: (sel) => ({
      '[data-doc-attach-chips]': chips,
      '[data-doc-attach-empty]': empty,
      '[data-doc-attach-input]': input,
      '[data-doc-attach-upload]': upload,
      '[data-doc-attach-pick]': pick,
    })[sel] ?? null,
  });
  const panel = { querySelector: (sel) => (sel === '[data-doc-attach]' && hat('data-doc-attach') ? field : null) };
  return { panel, field, chips, input, upload };
}

const beleg = [{ document_id: 5, name: 'Beleg.pdf', mime_type: 'application/pdf' }];

/** Was an den Server ginge - ueber den __apiStub des Loaders. */
function apiMitschnitt() {
  const aufrufe = [];
  globalThis.__apiStub = {
    post: async (path, body) => { aufrufe.push({ method: 'post', path, body }); return { data: { id: 42, name: body?.name } }; },
  };
  return aufrufe;
}

class LeserAttrappe {
  readAsDataURL() { this.result = 'data:text/plain;base64,eA=='; this.onload(); }
}

test('Beleg-Feld bei `documents: read`: kein Hochladen, vorhandene Anhaenge bleiben sichtbar', async () => {
  await withAccess({ tasks: 'write', documents: 'read' }, async () => {
    const markup = attach.renderDocumentAttachField({ attachments: beleg });
    assert.match(markup, /\sdata-doc-attach[\s>]/, 'das Feld selbst bleibt - es zeigt den Zustand');
    assert.doesNotMatch(markup, /data-doc-attach-upload/, 'kein Hochladen-Knopf');
    assert.doesNotMatch(markup, /data-doc-attach-input/, 'kein Dateifeld');
    assert.doesNotMatch(markup, /documentAttach\.hint/, 'der Hinweis nennt das Hochladen und entfaellt mit ihm');
    assert.match(markup, /data-doc-attach-pick/,
      'Verknuepfen bleibt: GET /documents und die Verknuepfung ueber den Pfad der Seite nimmt der Server an');

    const aufrufe = apiMitschnitt();
    const { panel, field, chips } = panelAusMarkup(markup);
    const belege = attach.bindDocumentAttachField(panel, { category: 'other' });
    assert.ok(belege, 'bind() findet das Feld');
    assert.match(chips.html, /Beleg\.pdf/, 'der vorhandene Anhang steht als Chip da');
    assert.match(chips.html, /href="\/api\/v1\/documents\/5\/preview"/, 'und laesst sich oeffnen - Lesen ist erlaubt');

    // Die Ablageflaeche ist nicht verdrahtet: eine hineingezogene Datei wird
    // nicht angenommen, also kann das Speichern auch nichts hochladen.
    assert.equal(field.listeners.drop, undefined, 'kein drop-Listener ohne Hochladen-Recht');
    assert.equal(field.listeners.dragover, undefined);
    assert.deepEqual(await belege.commit(), [5]);
    assert.deepEqual(aufrufe, [], 'kein POST /documents - also kein 403');
  });
  delete globalThis.__apiStub;
});

test('Beleg-Feld bei `documents: write`: unveraendert, Hochladen landet im Speichern (Gegenfall)', async () => {
  const echterLeser = globalThis.FileReader;
  globalThis.FileReader = LeserAttrappe;
  try {
    await withAccess({ tasks: 'write', documents: 'write' }, async () => {
      const markup = attach.renderDocumentAttachField({ attachments: beleg });
      assert.match(markup, /data-doc-attach-upload/);
      assert.match(markup, /data-doc-attach-input/);
      assert.match(markup, /documentAttach\.hint/);

      const aufrufe = apiMitschnitt();
      const { panel, field } = panelAusMarkup(markup);
      const belege = attach.bindDocumentAttachField(panel, { category: 'other' });
      assert.equal(field.listeners.drop?.length, 1, 'die Ablageflaeche ist verdrahtet');
      const datei = { name: 'Quittung.txt', size: 10, type: 'text/plain' };
      field.listeners.drop[0]({ dataTransfer: { files: [datei] }, preventDefault() {} });
      assert.deepEqual(await belege.commit(), [5, 42]);
      assert.equal(aufrufe.length, 1);
      assert.equal(aufrufe[0].path, '/documents');
    });
  } finally {
    globalThis.FileReader = echterLeser;
    delete globalThis.__apiStub;
  }
});

test('Beleg-Feld bei `documents: none`: kein Feld, bind() gibt null', () => {
  withAccess({ tasks: 'write', documents: 'none' }, () => {
    const markup = attach.renderDocumentAttachField({ attachments: beleg });
    assert.equal(markup, '', 'schon das Lesen antwortet mit 403 - jeder Chip-Link ginge ins Leere');
    assert.equal(attach.bindDocumentAttachField(panelAusMarkup(markup).panel), null,
      'die Aufrufer lassen die Verknuepfungen dann unberuehrt, statt sie leer zu ueberschreiben');
  });
});

test('Aufgaben-Dialog (fertige Seite): das Feld folgt dem Dokumente-Recht, nicht dem der Aufgaben', () => {
  const aufgabeMitBeleg = {
    id: 7, title: 'Steuer', status: 'open', category: 'household', due_date: null,
    subtasks: [], documents: [{ id: 5, name: 'Anleitung.pdf', mime_type: 'application/pdf' }],
  };
  const dialog = () => tasks.renderModalContent({ task: aufgabeMitBeleg, users: [], reminder: null });

  withAccess({ tasks: 'write', documents: 'read' }, () => {
    const html = dialog();
    assert.match(html, /\sdata-doc-attach[\s>]/);
    assert.match(html, /Anleitung\.pdf/, 'der verknuepfte Beleg bleibt als Zustand im Dialog');
    assert.doesNotMatch(html, /data-doc-attach-upload|data-doc-attach-input/,
      'tasks: write + documents: read zeigte hier ein Hochladen, dessen Speichern im 403 endete');
  });
  withAccess({ tasks: 'write', documents: 'none' }, () => {
    assert.doesNotMatch(dialog(), /data-doc-attach/);
  });
  withAccess({ tasks: 'write', documents: 'write' }, () => {
    assert.match(dialog(), /data-doc-attach-upload/, 'Gegenfall: mit Schreibrecht wie bisher');
  });
});

// =========================================================================
// 5. Kuechen-Transfer (utils/kitchen-transfer.js)
// =========================================================================

function toastMitschnitt() {
  const toasts = [];
  const wege = [];
  const vorher = { ...globalThis.window.yuvomi };
  globalThis.window.yuvomi.showToast = (message, tone, ms, action) => toasts.push({ message, tone, ms, action });
  globalThis.window.yuvomi.navigate = (pfad) => wege.push(pfad);
  return { toasts, wege, zurueck: () => { globalThis.window.yuvomi = vorher; } };
}

test('Transfer: bei `shopping: read` keine Ruecknahme, die im 403 endete', async () => {
  const { toasts, zurueck } = toastMitschnitt();
  const aufrufe = apiMitschnitt();
  try {
    // `meals: write` + `shopping: read`: der Transfer aus der Mahlzeit gelingt
    // (der Server urteilt ihn als `meals`), die Ruecknahme ist ein Einkaufs-Pfad.
    withAccess({ meals: 'write', shopping: 'read' }, () => {
      transfer.announceTransfer({ message: 'drei Zutaten', addedIds: [1, 2, 3] });
    });
    assert.equal(toasts.length, 1, 'die Meldung selbst bleibt - sie nennt, was passiert ist');
    assert.equal(toasts[0].action, null, 'ohne Einkaufs-Schreibrecht kein Zuruecknehmen-Knopf');
    assert.deepEqual(aufrufe, []);
  } finally {
    zurueck();
    delete globalThis.__apiStub;
  }
});

test('Transfer: mit `shopping: write` nimmt die Ruecknahme genau diese Artikel zurueck (Gegenfall)', async () => {
  const { toasts, zurueck } = toastMitschnitt();
  const aufrufe = apiMitschnitt();
  try {
    withAccess({ meals: 'write', shopping: 'write' }, () => {
      transfer.announceTransfer({ message: 'drei Zutaten', addedIds: [1, 2, 3] });
    });
    assert.equal(typeof toasts[0].action, 'function');
    await toasts[0].action();
    assert.deepEqual(aufrufe[0], { method: 'post', path: '/shopping/items/undo-transfer', body: { ids: [1, 2, 3] } });
  } finally {
    zurueck();
    delete globalThis.__apiStub;
  }
});

test('Transfer ohne Liste: der Ausweg „Neue Liste erstellen" nur, wo man eine anlegen darf', async () => {
  const { toasts, wege, zurueck } = toastMitschnitt();
  try {
    await withAccess({ pantry: 'write', shopping: 'read' }, () => transfer.resolveShoppingTarget([]));
    assert.equal(toasts[0].tone, 'warning', 'der Zustand wird weiter benannt');
    assert.equal(toasts[0].action, null, 'mit `shopping: read` fuehrte der Knopf auf eine Seite ohne Anlegeweg');

    await withAccess({ pantry: 'write', shopping: 'write' }, () => transfer.resolveShoppingTarget([]));
    assert.equal(typeof toasts[1].action?.onClick, 'function', 'Gegenfall: mit Schreibrecht bleibt der Ausweg');
    toasts[1].action.onClick();
    assert.deepEqual(wege, ['/shopping']);
  } finally {
    zurueck();
  }
});

// =========================================================================
// 6. Kategorie-Verwalter: der Aufrufer versteckt den Ausloeser
// =========================================================================

test('Kategorie-Verwalter: jeder basePath gehoert dem Modul der Seite, die ihn oeffnet', () => {
  // Die Komponente fragt das Recht nicht selbst (Vertrag im Kopf von
  // components/category-manager.js); der Aufrufer versteckt den Ausloeser mit
  // seinem readOnly(). Das ist nur dann dieselbe Frage, wenn der Verwalter in
  // das EIGENE Modul schreibt. Ein basePath in ein fremdes Modul macht diese
  // Zusicherung rot - dort muesste der Aufrufer mayWritePath() fragen.
  const navZuModul = new Map(serverPerms.PERMISSION_MODULES.flatMap((m) => m.navIds.map((nav) => [nav, m.key])));
  const gefunden = [];
  for (const { rel, src } of SOURCES) {
    if (rel === 'components/category-manager.js' || !src.includes('<yuvomi-category-manager>')) continue;
    const alle = [...src.matchAll(/\bbasePath:\s*/g)];
    assert.ok(alle.length > 0, `${rel} oeffnet den Verwalter ohne erkennbaren basePath`);
    const seite = rel.replace(/^pages\//, '').replace(/\.js$/, '');
    const eigenes = navZuModul.get(seite);
    assert.ok(rel.startsWith('pages/') && eigenes,
      `${rel} ist keine Modulseite - dort gibt es kein readOnly(), das den Ausloeser versteckt; hier muss entschieden werden`);
    for (const m of alle) {
      const start = m.index + m[0].length;
      const pfad = /['"`]/.test(src[start]) ? literalAt(src, start) : null;
      assert.ok(pfad?.startsWith('/'), `${rel}: basePath muss ein Literal sein, damit diese Zusicherung ihn lesen kann`);
      assert.equal(serverScopes.moduleForPath(pfad), eigenes,
        `${rel}: ${pfad} schreibt in ein fremdes Modul - der Aufrufer muss mayWritePath('${pfad}') fragen`);
      gefunden.push(pfad);
    }
  }
  assert.ok(gefunden.length >= 9, `nur ${gefunden.length} Verwalter gefunden: ${gefunden.join(', ')}`);
});
