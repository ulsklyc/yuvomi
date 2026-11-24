/**
 * Modul: Die Migrationen lesen, egal in welchem Layout sie liegen
 * Zweck: test:migrations-append-only vergleicht die Migrationen einer git-Basis
 *        mit der Arbeitskopie. Abschnitt F des Umbaus zieht das Array
 *        `MIGRATIONS` aus server/db.js in eine Datei je Migration um; der PR,
 *        der das tut, hat eine Basis im ALTEN und eine Arbeitskopie im NEUEN
 *        Layout. Dieser Leser macht beide Layouts zu derselben Liste, damit der
 *        Guard den Umzug selbst prueft, statt ihn zu ueberspringen.
 *
 * DIE ZWEI LAYOUTS
 *
 *   alt: `const MIGRATIONS = [ {...}, {...} ]` in server/db.js; die Helfer der
 *        `up`-Funktionen sind Funktionen auf oberster Ebene derselben Datei.
 *
 *   neu: server/migrations/index.ts importiert jede Migration einzeln und
 *        exportiert sie als Array, in derselben Reihenfolge:
 *
 *          import m0001 from './0001.ts';
 *          import m0002 from './0002.ts';
 *          export const MIGRATIONS = [m0001, m0002];
 *
 *        server/migrations/NNNN.ts traegt genau eine Migration als
 *        `export default { ... };`, davor hoechstens Kommentare und Importe.
 *        Die Helfer stehen als Funktionen auf oberster Ebene in
 *        server/migrations/helpers.ts.
 *
 * WAS VERGLICHEN WIRD: der Quelltext des Objekts einer Migration, von `{` bis
 * `}`, BYTE FUER BYTE - auch die Einrueckung. Das SQL steht in Template-
 * Literalen, und dort ist die Einrueckung Inhalt: wer beim Umzug einrueckt
 * oder ausrueckt, aendert den Text einer Migration, die Bestandsinstallationen
 * schon ausgefuehrt haben. Der Umzug nimmt den Text deshalb so mit, wie er im
 * Array stand. Ein Helfer wird ebenso als Quelltext seiner Deklaration
 * verglichen, ohne ein fuehrendes `export `.
 *
 * GEPARST WIRD MIT @swc/core (direkte devDependency, gepinnt), nicht per
 * Klammerzaehlen: im SQL stehen Klammern in Zeichenketten, und eine Regex
 * kennt keine Template-Literale. swc zaehlt seine Spans in Bytes und ueber
 * Aufrufe hinweg fortlaufend; ein vorangestelltes `0;` am Byte 0 gibt die
 * Basis jedes Aufrufs (gemessen 24.11.2026, auch mit Umlauten im Kommentar).
 */

import swc from '@swc/core';

const SENTINEL = '0;\n';

/**
 * @typedef {{ start: number, end: number }} Span
 * @typedef {{ version: number | null, description: string | null, text: string, origin: string, refs: Set<string> }} Entry
 * @typedef {{ text: string, refs: Set<string> }} Helper
 * @typedef {{ layout: 'old' | 'new', entries: Entry[], helpers: Map<string, Helper>, imports: Array<{ file: string, spec: string, names: string[] }>, findings: string[] }} Migrations
 */

/**
 * Eine Quelle parsen; `at(span)` liefert den Quelltext eines Knotens.
 * @param {string} source
 * @param {string} where  fuer die Meldung, wenn swc die Datei nicht lesen kann
 */
export function parseSource(source, where) {
  const text = SENTINEL + source.replace(/\r\n/g, '\n');
  const bytes = Buffer.from(text, 'utf8');
  let module;
  try {
    module = swc.parseSync(text, { syntax: 'typescript', target: 'es2024' });
  } catch (error) {
    throw new Error(`${where} laesst sich nicht parsen: ${String(/** @type {Error} */ (error).message).split('\n')[0]}`);
  }
  const base = module.body[0].span.start;
  /** @param {Span} span */
  const at = (span) => bytes.subarray(span.start - base, span.end - base).toString('utf8');
  /** Zeile (1-basiert) im Original, ohne den Waechter. */
  const line = (/** @type {Span} */ span) => bytes.subarray(0, span.start - base).toString('utf8').split('\n').length - 1;
  return { body: module.body.slice(1), at, line };
}

/**
 * Die Bezeichner, die ein Knoten im CODE nennt - nicht in Kommentaren, nicht
 * in Zeichenketten oder SQL, nicht als Eigenschaftsname. Darueber findet der
 * Guard die Helfer einer Migration; eine Textsuche las `init(` aus einem
 * Kommentar und zog die halbe Laufzeit von db.js mit.
 * @param {any} node @param {Set<string>} [into]
 */
export function identifiersIn(node, into = new Set()) {
  if (!node || typeof node !== 'object') return into;
  if (Array.isArray(node)) {
    for (const item of node) identifiersIn(item, into);
    return into;
  }
  if (node.type === 'Identifier') {
    into.add(node.value);
    return into;
  }
  for (const [key, value] of Object.entries(node)) {
    if (key === 'span' || key === 'ctxt') continue;
    if (key === 'key' && node.type === 'KeyValueProperty') continue;
    if (key === 'property' && node.type === 'MemberExpression' && value?.type === 'Identifier') continue;
    identifiersIn(value, into);
  }
  return into;
}

/** @param {any} object @param {string} name */
function property(object, name) {
  return object.properties.find((/** @type {any} */ p) => p.type === 'KeyValueProperty'
    && ((p.key.type === 'Identifier' && p.key.value === name) || (p.key.type === 'StringLiteral' && p.key.value === name)));
}

/**
 * Version und Beschreibung eines Migrationsobjekts.
 * @param {any} node @param {(span: Span) => string} at @param {string} origin
 * @returns {Entry}
 */
function entryOf(node, at, origin) {
  const refs = identifiersIn(node);
  if (node.type !== 'ObjectExpression') return { version: null, description: null, text: at(node.span), origin, refs };
  const version = property(node, 'version');
  const description = property(node, 'description');
  return {
    version: version?.value.type === 'NumericLiteral' ? version.value.value : null,
    description: description?.value.type === 'StringLiteral' ? description.value.value : null,
    text: at(node.span),
    origin,
    refs,
  };
}

/**
 * Funktionsdeklarationen auf oberster Ebene: Name -> Quelltext ohne `export `
 * und die Bezeichner, die ihr Rumpf nennt.
 * @param {any[]} body @param {(span: Span) => string} at
 */
function topLevelFunctions(body, at) {
  /** @type {Map<string, Helper>} */
  const functions = new Map();
  for (const item of body) {
    const declaration = item.type === 'ExportDeclaration' ? item.declaration : item;
    if (declaration?.type === 'FunctionDeclaration') {
      functions.set(declaration.identifier.value, { text: at(declaration.span), refs: identifiersIn(declaration.body) });
    }
  }
  return functions;
}

/**
 * Importe einer Datei: Quelle und lokale Namen.
 * @param {any[]} body @param {string} file
 */
function importsOf(body, file) {
  return body.filter((item) => item.type === 'ImportDeclaration').map((item) => ({
    file,
    spec: item.source.value,
    names: item.specifiers.map((/** @type {any} */ s) => s.local.value),
  }));
}

/**
 * Altes Layout: das Array in server/db.js.
 * @param {string} dbSource
 * @param {string} where
 * @returns {Migrations}
 */
export function readOldLayout(dbSource, where = 'server/db.js') {
  const { body, at, line } = parseSource(dbSource, where);
  /** @type {any} */
  let array = null;
  for (const item of body) {
    const declaration = item.type === 'ExportDeclaration' ? item.declaration : item;
    if (declaration?.type !== 'VariableDeclaration') continue;
    for (const declarator of declaration.declarations) {
      if (declarator.id.type === 'Identifier' && declarator.id.value === 'MIGRATIONS') array = declarator.init;
    }
  }
  if (!array || array.type !== 'ArrayExpression') {
    return { layout: 'old', entries: [], helpers: new Map(), imports: [], findings: [`${where}: kein \`const MIGRATIONS = [ ... ]\` auf oberster Ebene.`] };
  }
  const entries = array.elements.map((/** @type {any} */ element) => entryOf(element.expression, at, `${where}:${line(element.expression.span)}`));
  return { layout: 'old', entries, helpers: topLevelFunctions(body, at), imports: importsOf(body, where), findings: [] };
}

/** Datei einer Version im neuen Layout. */
export const migrationFile = (/** @type {number} */ version) => `${String(version).padStart(4, '0')}.ts`;

/**
 * Neues Layout: server/migrations/index.ts und die Dateien, die es nennt.
 * `read(path)` liefert den Inhalt eines Pfads unter server/migrations/ oder
 * null, wenn es ihn nicht gibt.
 * @param {(name: string) => string | null} read
 * @param {string} where  Praefix fuer Meldungen, etwa `Basis abc123:` oder ``
 * @returns {Migrations}
 */
export function readNewLayout(read, where = '') {
  /** @type {string[]} */
  const findings = [];
  const indexSource = read('index.ts');
  if (indexSource === null) {
    return { layout: 'new', entries: [], helpers: new Map(), imports: [], findings: [`${where}server/migrations/index.ts fehlt.`] };
  }
  const index = parseSource(indexSource, `${where}server/migrations/index.ts`);
  /** @type {Map<string, string>} lokaler Name -> Datei */
  const importedFile = new Map();
  /** @type {string[]} Dateien in Importreihenfolge */
  const importOrder = [];
  for (const item of index.body) {
    if (item.type !== 'ImportDeclaration') continue;
    const spec = item.source.value;
    const match = /^\.\/(\d{4}\.ts)$/.exec(spec);
    const fallback = item.specifiers.find((/** @type {any} */ s) => s.type === 'ImportDefaultSpecifier');
    if (!match || !fallback || item.specifiers.length !== 1) {
      findings.push(`${where}server/migrations/index.ts importiert \`${spec}\` - erlaubt ist nur \`import mNNNN from './NNNN.ts'\`.`);
      continue;
    }
    importedFile.set(fallback.local.value, match[1]);
    importOrder.push(match[1]);
  }

  /** @type {any} */
  let array = null;
  for (const item of index.body) {
    if (item.type !== 'ExportDeclaration' || item.declaration?.type !== 'VariableDeclaration') continue;
    for (const declarator of item.declaration.declarations) {
      if (declarator.id.type === 'Identifier' && declarator.id.value === 'MIGRATIONS') array = declarator.init;
    }
  }
  if (!array || array.type !== 'ArrayExpression') {
    findings.push(`${where}server/migrations/index.ts exportiert kein \`const MIGRATIONS = [ ... ]\`.`);
    return { layout: 'new', entries: [], helpers: new Map(), imports: [], findings };
  }

  /** @type {string[]} Dateien in Array-Reihenfolge (das ist die Laufreihenfolge) */
  const runOrder = [];
  for (const element of array.elements) {
    const expression = element?.expression;
    const file = expression?.type === 'Identifier' ? importedFile.get(expression.value) : undefined;
    if (!file) {
      findings.push(`${where}server/migrations/index.ts: \`${expression ? index.at(expression.span) : '(Luecke)'}\` im Array ist keine importierte Migration.`);
      continue;
    }
    runOrder.push(file);
  }
  if (runOrder.join() !== importOrder.join()) {
    findings.push(`${where}server/migrations/index.ts: das Array nennt die Migrationen in anderer Reihenfolge als die Importe - `
      + 'beide Listen stehen in derselben, aufsteigenden Reihenfolge.');
  }

  /** @type {Entry[]} */
  const entries = [];
  const imports = [];
  for (const file of runOrder) {
    const source = read(file);
    if (source === null) {
      findings.push(`${where}server/migrations/${file} fehlt, index.ts importiert sie.`);
      continue;
    }
    const parsed = parseSource(source, `${where}server/migrations/${file}`);
    const exported = parsed.body.filter((item) => item.type === 'ExportDefaultExpression');
    const others = parsed.body.filter((item) => item.type !== 'ExportDefaultExpression' && item.type !== 'ImportDeclaration');
    if (exported.length !== 1 || others.length) {
      findings.push(`${where}server/migrations/${file}: genau ein \`export default { ... };\`, davor nur Importe - `
        + `gefunden ${exported.length} default-Export(s) und ${others.length} weitere Anweisung(en).`);
    }
    if (exported[0]) entries.push(entryOf(exported[0].expression, parsed.at, `server/migrations/${file}`));
    imports.push(...importsOf(parsed.body, `server/migrations/${file}`));
  }

  const helperSource = read('helpers.ts');
  /** @type {Map<string, Helper>} */
  let helpers = new Map();
  if (helperSource !== null) {
    const parsed = parseSource(helperSource, `${where}server/migrations/helpers.ts`);
    helpers = topLevelFunctions(parsed.body, parsed.at);
    imports.push(...importsOf(parsed.body, 'server/migrations/helpers.ts'));
  }
  return { layout: 'new', entries, helpers, imports, findings };
}

/**
 * Welche Helfer eine Liste von Migrationen braucht: jede Funktion auf
 * oberster Ebene, die eine Migration im Code nennt, und transitiv, was diese
 * Helfer nennen.
 * @param {Entry[]} entries @param {Map<string, Helper>} helpers
 */
export function helpersUsedBy(entries, helpers) {
  /** @type {Set<string>} */
  const used = new Set();
  const queue = [...helpers.keys()].filter((name) => entries.some((entry) => entry.refs.has(name)));
  while (queue.length) {
    const name = /** @type {string} */ (queue.shift());
    if (used.has(name)) continue;
    used.add(name);
    for (const other of /** @type {Helper} */ (helpers.get(name)).refs) if (helpers.has(other) && !used.has(other)) queue.push(other);
  }
  return used;
}

/**
 * Frage 1 und 2: Versionen ab 1 lueckenlos aufsteigend, jede einmal; im neuen
 * Layout traegt die Datei NNNN.ts die Version NNNN.
 * @param {Migrations} migrations
 */
export function numberingFindings(migrations) {
  /** @type {string[]} */
  const findings = [];
  migrations.entries.forEach((entry, index) => {
    if (entry.version === null) {
      findings.push(`${entry.origin}: keine Zahl als \`version\` - der Guard kann die Migration nicht zuordnen.`);
      return;
    }
    const expected = index + 1;
    if (entry.version !== expected) {
      const previous = migrations.entries[index - 1]?.version;
      findings.push(entry.version === previous
        ? `${entry.origin}: version ${entry.version} kommt zweimal vor - eine Bestandsinstallation haelt die zweite fuer erledigt und ueberspringt sie.`
        : `${entry.origin}: version ${entry.version} an Stelle ${expected} - umsortiert, doppelt oder eine Luecke (meist zwei Zweige, die parallel angehaengt haben).`);
    }
    if (migrations.layout === 'new' && entry.origin !== `server/migrations/${migrationFile(entry.version)}`) {
      findings.push(`${entry.origin} traegt version ${entry.version} - die Datei heisst nach ihrer Version (${migrationFile(entry.version)}).`);
    }
  });
  return findings;
}

/**
 * Frage 3: jede Migration der Basis steht unveraendert an ihrer Stelle, neue
 * sind nur angehaengt; jeder Helfer, den eine Migration der Basis braucht, ist
 * unveraendert. Gilt ueber beide Layouts hinweg.
 * @param {Migrations} base @param {Migrations} current @param {string} label
 */
export function prefixFindings(base, current, label) {
  const findings = [];
  base.entries.forEach((entry, index) => {
    const now = current.entries[index];
    if (!now) {
      findings.push(`Migration ${entry.version ?? index + 1} der Basis (${label}) fehlt in der Arbeitskopie - entfernt oder Liste gekuerzt.`);
      return;
    }
    if (now.text === entry.text) return;
    let at = 0;
    while (at < entry.text.length && entry.text[at] === now.text[at]) at += 1;
    const lineOf = (/** @type {string} */ text) => text.slice(0, at).split('\n').length;
    const show = (/** @type {string} */ text) => JSON.stringify(text.split('\n')[lineOf(text) - 1] ?? '(Ende)');
    findings.push([
      `Migration ${entry.version ?? index + 1} weicht von der Basis (${label}) ab, Zeile ${lineOf(entry.text)} des Eintrags:`,
      `    Basis:        ${entry.origin}  ${show(entry.text)}`,
      `    Arbeitskopie: ${now.origin}  ${show(now.text)}`,
    ].join('\n'));
  });
  for (const name of helpersUsedBy(base.entries, base.helpers)) {
    const was = base.helpers.get(name)?.text;
    const is = current.helpers.get(name)?.text;
    if (is === undefined) findings.push(`Der Helfer ${name}() einer bestehenden Migration fehlt in der Arbeitskopie (${current.layout === 'new' ? 'server/migrations/helpers.ts' : 'server/db.js'}).`);
    else if (is !== was) findings.push(`Der Helfer ${name}() einer bestehenden Migration weicht von der Basis (${label}) ab - er gehoert zu Migrationen, die Bestandsinstallationen schon ausgefuehrt haben.`);
  }
  return findings;
}

/**
 * Jede Migration traegt eine Beschreibung.
 * @param {Migrations} migrations
 */
export function descriptionFindings(migrations) {
  return migrations.entries
    .filter((entry) => !entry.description || !entry.description.trim())
    .map((entry) => `${entry.origin}: version ${entry.version} hat keine description - \`[DB] Migration N applied:\` waere leer.`);
}

/**
 * Im neuen Layout: Migrationen und Helfer importieren nur Plattform-Module,
 * die Helfer und reine Hilfen aus server/utils/ und den Logger - nie
 * Laufzeit-Code aus services/, routes/, authorize/ oder db.js.
 * @param {Migrations} migrations
 */
export function importFindings(migrations) {
  const allowed = (/** @type {string} */ spec, /** @type {string} */ file) => spec.startsWith('node:')
    || (spec === './helpers.ts' && file !== 'server/migrations/helpers.ts')
    || spec.startsWith('../utils/') || spec === '../logger.js';
  return migrations.imports
    .filter(({ spec, file }) => !allowed(spec, file))
    .map(({ spec, file }) => `${file} importiert \`${spec}\` - eine Migration tut fuer immer dasselbe; die Regel als eingefrorene Kopie in helpers.ts schreiben.`);
}
