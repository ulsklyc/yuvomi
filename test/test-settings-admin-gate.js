/**
 * Regel-Guard: kein per-Nutzer-Endpunkt hinter einem adminOnly-Blatt.
 *
 * Der Fehler, den dieses Repo fuenfmal gemacht hat: eine Einstellung schreibt
 * pro Nutzer, ihre Route traegt bewusst keinen Admin-Check - und das einzige
 * Blatt, das sie bedient, steht auf `adminOnly: true`. Fuer Nicht-Admins
 * loest `findSettingsLeaf` dann null auf, die Seite existiert schlicht nicht,
 * und es gibt nicht einmal eine Fehlermeldung. In einem fuenfkoepfigen
 * Haushalt duerfen vier Leute etwas, an das sie nicht herankommen.
 *
 * Die Faelle: calendar-defaults und task-defaults (#695), die
 * Navigationsreihenfolge (Critique 2026-07-27), die Feed-Abos (#770) und die
 * Kalender-Abos (#772). Vier fielen beim Lesen auf, der fuenfte nur, weil die
 * Regel gegen den Server GEMESSEN wurde - genau das tut dieser Guard.
 *
 * Er prueft die Regel, nicht die bekannten Faelle: fuer jedes adminOnly-Blatt
 * werden seine schreibenden API-Aufrufe auf die echten Handler abgebildet, und
 * ein Handler, der ohne `requireAdmin` mit der Nutzer-Id arbeitet, ist ein
 * Verstoss - egal ob wir ihn kennen.
 *
 * WAS DEN GUARD BLIND MACHEN WUERDE, und wogegen er sich wehrt:
 *   - Eine unvollstaendige Mount-Kette. `router.use(x)` OHNE Pfad traegt der
 *     Kalender; sie zu uebersehen kostete in der Bauphase die Haelfte der
 *     Handler, ohne dass irgendetwas rot geworden waere.
 *   - Ein Laengenlimit auf den Handler-Koerper. Die erste Fassung schnitt bei
 *     2500 Zeichen und verlor damit 63 Handler still, darunter
 *     `POST /backup/trigger`. Geschnitten wird deshalb an den Handler-GRENZEN.
 *   - Ein Client-Pfad, der auf keinen Handler passt. Der ist kein Freibrief,
 *     sondern ein Loch in der Messung, und macht den Guard deshalb rot.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { withoutCommentsKeepingLines } from './source-text.js';

const ROOT = fileURLToPath(new URL('../', import.meta.url));
const read = (p) => readFileSync(join(ROOT, p), 'utf8');

/** Beide Seiten auf dieselbe Form bringen: `${accountId}` und `:id` sind
 *  dasselbe Loch, und ein Query-String gehoert nicht zum Pfad. */
function normalizePath(path) {
  return path
    .replace(/\?[\s\S]*$/, '')
    .replace(/\$\{[^}]*\}?/g, ':p')
    .replace(/:[A-Za-z_]\w*/g, ':p')
    .replace(/\/$/, '');
}

/** Jeder importierte Name auf seine Datei, inklusive Umbenennung
 *  (`{ router as authRouter }`) und Sammelimport. */
function importMap(source) {
  const map = new Map();
  for (const m of source.matchAll(/import\s+([^;]+?)\s+from\s+'(\.[^']+\.js)'/g)) {
    const [, spec, file] = m;
    const named = spec.match(/\{([^}]*)\}/);
    if (named) {
      for (const part of named[1].split(',')) {
        const alias = part.trim().split(/\s+as\s+/).pop().trim();
        if (alias) map.set(alias, file);
      }
    }
    const def = spec.replace(/\{[^}]*\}/, '').replace(/,/g, '').trim();
    if (def) map.set(def, file);
  }
  return map;
}

/** Mounts aus server/index.js, danach eine Ebene verschachtelter Router. */
function collectMounts() {
  const index = read('server/index.js');
  const imports = importMap(index);
  const top = [];
  for (const m of index.matchAll(/app\.use\('(\/api\/v1\/[^']+)',\s*(\w+)\)/g)) {
    const file = imports.get(m[2]);
    if (file) top.push({ prefix: m[1].replace('/api/v1', ''), file: file.replace(/^\.\//, 'server/') });
  }

  const expanded = [];
  for (const mount of top) {
    let src;
    try { src = read(mount.file); } catch { continue; }
    const local = importMap(src);
    // BEIDE Formen: mit Pfad und ohne. Die praefixlose traegt der Kalender.
    const nested = [
      ...[...src.matchAll(/router\.use\('([^']+)',\s*(\w+)\)/g)].map((m) => [m[1], m[2]]),
      ...[...src.matchAll(/router\.use\((\w+Router)\)/g)].map((m) => ['', m[1]]),
    ];
    if (!nested.length) { expanded.push(mount); continue; }
    for (const [sub, name] of nested) {
      const rel = local.get(name);
      if (!rel) continue;
      expanded.push({ prefix: mount.prefix + sub, file: resolve('/' + dirname(mount.file), rel).slice(1) });
    }
    // Ein Sammelrouter kann neben den Untermodulen eigene Routen halten.
    expanded.push(mount);
  }
  return expanded;
}

/** Alle Handler mit vollem Pfad, Admin-Gate und Nutzerbezug. Geschnitten wird
 *  an den Handler-Grenzen, nie auf eine feste Laenge. */
function collectHandlers() {
  const handlers = [];
  const seen = new Set();
  for (const mount of collectMounts()) {
    let src;
    try { src = read(mount.file); } catch { continue; }
    const starts = [...src.matchAll(/router\.(get|post|put|patch|delete)\(\s*'([^']*)'/g)];
    starts.forEach((h, i) => {
      const block = src.slice(h.index, i + 1 < starts.length ? starts[i + 1].index : src.length);
      const path = normalizePath((mount.prefix + h[2]) || mount.prefix);
      const key = `${h[1]} ${path} ${mount.file}`;
      if (seen.has(key)) return;
      seen.add(key);
      handlers.push({
        method: h[1].toUpperCase(),
        path,
        // `requireAdmin` steht in der Argumentliste, nicht irgendwo im Koerper.
        gated: /requireAdmin/.test(block.slice(0, 200)),
        perUser: /getUserId\(req\)|cfgUserSet\(/.test(block),
        file: mount.file,
      });
    });
  }
  return handlers;
}

function collectLeaves() {
  const registry = read('public/settings/registry.js');
  return [...registry.matchAll(
    /\{[^{}]*?id:\s*'([^']+)'[\s\S]*?adminOnly:\s*(true|false),\s*loader:\s*\(\)\s*=>\s*import\('([^']+)'\)/g,
  )].map((m) => ({ id: m[1], adminOnly: m[2] === 'true', file: 'public' + m[3] }));
}

// ── Reichweite: der Guard urteilt nicht ueber eine leere Menge ────────────────

test('die Messung erreicht Server und Registry ueberhaupt', () => {
  const handlers = collectHandlers();
  const leaves = collectLeaves();
  assert.ok(handlers.length >= 300, `nur ${handlers.length} Handler gefunden - die Mount-Kette greift nicht mehr`);
  assert.ok(handlers.filter((h) => h.method !== 'GET').length >= 200,
    'zu wenige schreibende Handler - das Muster greift nicht mehr');
  assert.ok(handlers.some((h) => h.perUser && !h.gated),
    'kein einziger ungegateter per-Nutzer-Handler gefunden - die Signatur trifft nicht mehr');
  assert.ok(leaves.length >= 20, `nur ${leaves.length} Settings-Blaetter gefunden`);
  assert.ok(leaves.filter((l) => l.adminOnly).length >= 10, 'zu wenige adminOnly-Blaetter gefunden');
});

// ── Die Regel ────────────────────────────────────────────────────────────────

test('kein adminOnly-Blatt bedient einen ungegateten per-Nutzer-Endpunkt', () => {
  const handlers = collectHandlers();
  const byPath = new Map();
  for (const h of handlers) byPath.set(`${h.method} ${h.path}`, h);

  const violations = [];
  const unresolved = [];
  let calls = 0;

  for (const leaf of collectLeaves().filter((l) => l.adminOnly)) {
    let src;
    try { src = read(leaf.file); } catch { continue; }
    for (const c of src.matchAll(/api\.(post|put|patch|delete)\(\s*[`']([^`']+)[`']/g)) {
      calls++;
      const key = `${c[1].toUpperCase()} ${normalizePath(c[2])}`;
      const handler = byPath.get(key);
      if (!handler) { unresolved.push(`${leaf.id}: ${key}`); continue; }
      if (!handler.gated && handler.perUser) {
        violations.push(`${leaf.id} ruft ${key} (${handler.file}) - ohne requireAdmin, arbeitet pro Nutzer`);
      }
    }
  }

  assert.ok(calls >= 20, `nur ${calls} schreibende Aufrufe in adminOnly-Blaettern - das Muster greift nicht mehr`);

  // Ein Pfad ohne Handler ist ein Loch in der MESSUNG, kein Freibrief.
  assert.deepEqual(unresolved, [],
    'Diese Aufrufe liessen sich keinem Handler zuordnen - der Guard kann ueber sie nichts sagen:\n  '
    + unresolved.join('\n  '));

  assert.deepEqual(violations, [],
    'Diese Endpunkte schreiben pro Nutzer und tragen kein Admin-Gate, ihr Blatt ist aber adminOnly - '
    + 'Mitglieder duerfen es und kommen nicht heran:\n  ' + violations.join('\n  '));
});

// ── Zweite Sonde: der Sammelendpunkt ─────────────────────────────────────────
//
// Die erste Sonde sieht nur Blaetter mit EIGENEN Endpunkten. Drei der fuenf
// historischen Faelle (calendar-defaults, task-defaults #695, navigation)
// liefen aber ueber `PUT /preferences` - und dort entscheidet der SCHLUESSEL,
// ob etwas persoenlich ist, nicht die Route: derselbe Aufruf traegt
// haushaltweite und per-Nutzer-Werte nebeneinander. Ein Guard auf Routenebene
// muesste ihn entweder ganz durchwinken oder jedes Blatt melden, das ihn
// benutzt; beides waere wertlos.
//
// Gemessen wird deshalb `cfgUserSet('<key>')` in server/routes/preferences.js -
// das IST die Definition von "wirkt pro Nutzer" - gegen die Schluessel, die ein
// adminOnly-Blatt schickt. Die Blaetter rufen ueber `savePreferences()` aus
// dem preferences-cache, nicht direkt ueber `api.put`; wer nur nach `api.put`
// sucht, ist fuer sie blind, ohne es zu merken.

/** Nur Schluessel, die AUSSCHLIESSLICH pro Nutzer abgelegt werden.
 *
 *  Wetter und der Zyklus-Schalter kennen beide Wege: derselbe Name landet je
 *  nach Zweig in `cfgSet` (Haushalt) oder `cfgUserSet` (ich), und beim Wetter
 *  entscheidet darueber ein verschachteltes `weather_user`-Objekt im Request.
 *  Fuer die sagt der Schluesselname allein nichts, und ein Guard, der sie
 *  mitzaehlt, meldet das Haushalts-Wetterblatt als Verstoss - das war der
 *  erste Lauf dieser Sonde. Sie sind deshalb keine Ausnahmeliste, sondern eine
 *  KATEGORIE: was beide Wege kennt, ist kontextabhaengig und hier nicht
 *  entscheidbar. */
function personalPreferenceKeys() {
  const src = read('server/routes/preferences.js');
  const perUser = new Set([...src.matchAll(/cfgUserSet\(\s*'([a-z_]+)'/g)].map((m) => m[1]));
  const household = new Set([...src.matchAll(/cfgSet\(\s*'([a-z_]+)'/g)].map((m) => m[1]));
  const ambiguous = [...perUser].filter((k) => household.has(k));
  return { keys: new Set([...perUser].filter((k) => !household.has(k))), ambiguous };
}

test('kein adminOnly-Blatt schreibt eine per-Nutzer-Preference', () => {
  const { keys: personal, ambiguous } = personalPreferenceKeys();
  assert.ok(personal.size >= 4,
    `nur ${personal.size} eindeutig persoenliche Schluessel gefunden - cfgUserSet trifft nicht mehr`);
  // Waechst diese Menge, verliert der Guard still an Reichweite: jeder
  // kontextabhaengige Schluessel ist einer, ueber den er nichts sagen kann.
  assert.ok(ambiguous.length <= 6,
    `${ambiguous.length} Schluessel kennen beide Wege (${ambiguous.join(', ')}) - `
    + 'der Guard verliert damit Reichweite; entweder trennen oder die Grenze hier bewusst anheben');

  const violations = [];
  let scanned = 0;

  for (const leaf of collectLeaves().filter((l) => l.adminOnly)) {
    let src;
    try { src = read(leaf.file); } catch { continue; }
    // Ein Blatt, das den Cache-Helfer oder den rohen PUT benutzt, schreibt
    // Preferences. WELCHE, steht nicht immer im Aufruf: `modules-navigation`
    // baut sein `payload` als Variable und uebergibt es erst danach - wer nur
    // das Objektliteral im Aufruf liest, ist fuer genau diesen Fall blind, und
    // das war einer der fuenf. Gesucht wird deshalb die ZUWEISUNG des
    // Schluessels irgendwo in der Datei.
    if (!/savePreferences|api\.put\(\s*'\/preferences'/.test(src)) continue;
    scanned++;
    for (const key of src.matchAll(/(?:^|[{,\s])([a-z_]{3,})\s*:/gm)) {
      if (personal.has(key[1])) {
        violations.push(`${leaf.id} schreibt '${key[1]}' - die Route legt den Wert per cfgUserSet pro Nutzer ab`);
      }
    }
  }

  assert.ok(scanned >= 3,
    `nur ${scanned} adminOnly-Blaetter schreiben ueberhaupt Preferences - das Muster greift nicht mehr`);
  assert.deepEqual(violations, [],
    'Diese Einstellungen wirken pro Nutzer, ihr Blatt ist aber adminOnly - jeder darf sie setzen, '
    + 'nur erreicht sie niemand ausser dem Admin:\n  ' + violations.join('\n  '));
});

// ── Dritte Sonde: eine Schreibweise fuer das Admin-Praedikat ─────────────────
//
// Ob eine Anfrage als Admin gilt, fragt der Server ueber `isAdminRequest()` aus
// server/middleware/require-admin.js. Dieser Test haelt nur die SCHREIBWEISE:
// ein neues `req.authRole === 'admin'` oder ein Session-Fallback neben dem
// Helfer wird rot. Die Regel selbst (Mitglied bekommt 403, Admin kommt durch)
// halten die Verhaltenstests der Routen, etwa test-email.js,
// test-rewards-routes.js, test-screensaver.js und test-notifications.js.
//
// Gelesen wird der ganze Quelltext ohne Kommentare, nicht Zeile fuer Zeile:
// zeilenweise sah der Guard `req.authRole` und `=== 'admin'` auf zwei Zeilen
// nicht. Zwischen den Tokens darf deshalb Leerraum samt Umbruch stehen, und
// `req?.authRole`, `req['authRole']` und `'admin' === req.authRole` meinen
// dasselbe. Die Zeile fuer die Meldung wird aus dem Offset zurueckgerechnet.
//
// Die Karte fuehrt je Datei die erlaubten VORKOMMEN, nicht ihre Anzahl: eine
// Zahl bleibt gleich, wenn eine gelistete Stelle geht und eine neue kommt, und
// der Tausch waere gruen. Ein Vorkommen ist `<Ausdruck> @ <Anweisung>` - der
// Treffer und die Anweisung um ihn herum, begrenzt durch `;`, `{` oder `}`,
// beide ohne Leerraum ausser zwischen zwei Wortzeichen. Die Anweisung statt der
// Zeile, weil sie Einruecken, Umbrechen und Kommentare aushaelt; der Ausdruck
// dazu, weil eine Anweisung mehrere Treffer tragen kann. Zwei Stellen, die das
// Praedikat in verschiedene Bedingungen setzen, sind so verschiedene Schluessel.
// Zeilennummern stehen bewusst nicht darin, sie wandern bei jedem Edit.
// Verglichen wird auf Gleichheit der Multimengen: faellt eine Stelle weg, muss
// ihr Eintrag mitfallen, sonst waechst hier still ein Freibrief.
//
// GRENZE: wer eine gelistete Anweisung woertlich an eine andere Stelle
// derselben Datei verschiebt, bleibt gruen. Umgekehrt meldet jede Aenderung an
// einer gelisteten Anweisung sie als neu und den alten Eintrag als verschwunden.

/** `.name`, `?.name`, `['name']` und `?.['name']`, mit Leerraum dazwischen. */
const zugriff = (name) => String.raw`\s*(?:\??\.\s*${name}\b|(?:\?\.)?\s*\[\s*['"\x60]${name}['"\x60]\s*\])`;
const EQ = String.raw`\s*[!=]==?\s*`;
const ADMIN = String.raw`['"\x60]admin['"\x60]`;
const AUTH_ROLE = String.raw`(?:\[\s*['"\x60]authRole['"\x60]\s*\]|\bauthRole\b)`;
const OBJEKT = String.raw`(?:[\w$]+\s*(?:\?\.)?\s*\.?\s*)?`;
const SESSION_ROLE = String.raw`\bsession${zugriff('role')}`;

const ADMIN_PREDICATE = new RegExp([
  AUTH_ROLE + EQ + ADMIN,
  ADMIN + EQ + OBJEKT + AUTH_ROLE,
  SESSION_ROLE + EQ + ADMIN,
  ADMIN + EQ + OBJEKT + SESSION_ROLE,
  String.raw`\bsession${zugriff('isAdmin')}`,
].join('|'), 'g');

/** Leerraum weg, ausser zwischen zwei Wortzeichen (`return req` bleibt lesbar). */
const kompakt = (s) => s.replace(/\s+/g, ' ').trim().replace(/ (?![\w$])|(?<![\w$]) /g, '');

/** Jedes Admin-Praedikat einer Quelle mit Zeile, Ausdruck und Kartenschluessel. */
function adminPredicates(source) {
  const src = withoutCommentsKeepingLines(source);
  return [...src.matchAll(ADMIN_PREDICATE)].map((m) => {
    let von = m.index;
    while (von > 0 && !';{}'.includes(src[von - 1])) von--;
    let bis = m.index + m[0].length;
    while (bis < src.length && !';{}'.includes(src[bis])) bis++;
    const expr = kompakt(m[0]);
    return {
      line: src.slice(0, m.index).split('\n').length,
      expr,
      key: `${expr} @ ${kompakt(src.slice(von, bis))}`,
    };
  });
}

const FALLBACK = "return req.authRole==='admin'||req.session?.role==='admin'";

/** Datei -> erlaubte Vorkommen als `<Ausdruck> @ <Anweisung>`, mit Grund. */
const ADMIN_PREDICATE_EXCEPTIONS = new Map([
  // Die Definition des Helfers selbst.
  ['server/middleware/require-admin.js', [
    "authRole==='admin' @ return req.authRole==='admin'",
  ]],
  // test-sso-only.js haelt die woertliche Schreibweise per Regex.
  ['server/auth.js', [
    "authRole==='admin' @ if(req.authRole==='admin')return",
    "authRole==='admin' @ const isAdmin=req.authRole==='admin'",
  ]],
  // Ausserhalb dieses Schnitts geblieben; zieht beim naechsten Anfassen nach.
  ['server/routes/dashboard.js', [
    "authRole==='admin' @ result.quicklinks=listQuickLinksFor(userId,req.authRole==='admin')",
  ]],
  // Fassungen mit Fallback auf die Session-Rolle: das Einsammeln aendert, was
  // Token plus Admin-Cookie duerfen, und ist ein eigener Schritt.
  ['server/routes/calendar/helpers.js', [
    "authRole==='admin' @ return req.authRole==='admin'||req.session?.isAdmin===true||req.session?.role==='admin'",
    "session?.isAdmin @ return req.authRole==='admin'||req.session?.isAdmin===true||req.session?.role==='admin'",
    "session?.role==='admin' @ return req.authRole==='admin'||req.session?.isAdmin===true||req.session?.role==='admin'",
  ]],
  ...['dms', 'documents', 'recipe-providers', 'split-expenses', 'tasks'].map((name) => [
    `server/routes/${name}.js`,
    [`authRole==='admin' @ ${FALLBACK}`, `session?.role==='admin' @ ${FALLBACK}`],
  ]),
  ['server/routes/notes.js', [
    "authRole==='admin' @ if(req.authRole==='admin'||req.session?.role==='admin')return true",
    "session?.role==='admin' @ if(req.authRole==='admin'||req.session?.role==='admin')return true",
  ]],
  ['server/routes/schedule.js', [
    "authRole==='admin' @ export const isAdmin=(req)=>req.authRole==='admin'||req.session?.role==='admin'",
    "session?.role==='admin' @ export const isAdmin=(req)=>req.authRole==='admin'||req.session?.role==='admin'",
  ]],
]);

function serverJsFiles(dir = join(ROOT, 'server')) {
  const files = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) files.push(...serverJsFiles(full));
    else if (entry.name.endsWith('.js')) files.push(full);
  }
  return files;
}

test('das Admin-Praedikat steht nur in isAdminRequest() und den gezaehlten Ausnahmen', () => {
  const files = serverJsFiles();
  assert.ok(files.length >= 200, `nur ${files.length} Dateien unter server/ gefunden - der Walk greift nicht mehr`);

  // Die Schreibweisen, fuer die der zeilenweise Guard blind war.
  const gefunden = (src) => adminPredicates(src).map((p) => p.line);
  assert.deepEqual(gefunden("a();\nconst x = req.authRole\n  === 'admin';"), [2], 'umbrochener Vergleich');
  assert.deepEqual(gefunden("const x = 'admin' ===\n  req\n  ?.authRole;"), [1], 'umgekehrt und umbrochen');
  assert.deepEqual(gefunden("const x = req['authRole'] !== 'admin';"), [1], 'Klammerzugriff');
  assert.deepEqual(gefunden("const x = req.session\n  ?.role == 'admin';"), [1], 'Session-Rolle umbrochen');
  assert.deepEqual(gefunden("req.authRole = 'admin'; // req.authRole === 'admin'"), [], 'Zuweisung und Kommentar');

  const found = new Map();
  for (const file of files) {
    const rel = relative(ROOT, file).split('\\').join('/');
    const predicates = adminPredicates(readFileSync(file, 'utf8'));
    if (predicates.length) found.set(rel, predicates);
  }

  const problems = [];
  for (const rel of new Set([...found.keys(), ...ADMIN_PREDICATE_EXCEPTIONS.keys()])) {
    const offen = [...(ADMIN_PREDICATE_EXCEPTIONS.get(rel) ?? [])];
    for (const p of found.get(rel) ?? []) {
      const k = offen.indexOf(p.key);
      if (k !== -1) { offen.splice(k, 1); continue; }
      problems.push(`neues Vorkommen ${rel}:${p.line} ${p.expr} - isAdminRequest() benutzen\n    Kartenschluessel: ${JSON.stringify(p.key)}`);
    }
    for (const key of offen) {
      problems.push(`gelistetes Vorkommen nicht mehr gefunden - Karte streichen\n    ${rel}: ${JSON.stringify(key)}`);
    }
  }

  assert.deepEqual(problems, [],
    'Das Admin-Praedikat gehoert in isAdminRequest(req) aus server/middleware/require-admin.js; '
    + 'die Ausnahmekarte listet jedes Vorkommen und muss beim Einsammeln mitfallen:\n  ' + problems.join('\n  '));
});
