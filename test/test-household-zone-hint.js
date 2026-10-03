/**
 * Test: Der Zonen-Hinweis fuer Bestandshaushalte (#1607, Punkt 4)
 *
 * Ein Haushalt ohne gesetzte Zone rechnet serverseitig in `TZ` (im Container
 * meist UTC): "Essen heute" bleibt bis zum Offset leer, der Ueberfaellig-Zaehler
 * stimmt nicht. Die Ersteinrichtung schickt die Zone seit #1613 mit - wer
 * schon eingerichtet ist, bekommt sie nicht still nachgezogen, sondern wird
 * EINMAL gefragt: Admins auf der Uebersicht, mit "Uebernehmen" und "So lassen".
 *
 * Geprueft wird hier:
 *   - die Bedingung in allen Zweigen (Admin/Mitglied, null/gesetzt,
 *     gleich/abweichend, verschwiegene Browser-Zone, gemerkt, Wandtablett)
 *   - der Zonenvergleich: Aliase sind keine Abweichung, gleiche Offsets HEUTE
 *     sind noch keine Gleichheit
 *   - die zwei Handlungen gegen eine api-Attrappe, samt der Reihenfolge
 *     (erst nachlesen, dann schreiben) und dem Stand danach
 *   - die Bauform (role=status, zwei Knoepfe, ohne Handlung keine Knoepfe)
 *   - die Verdrahtung in Router, Uebersicht, Einstellungen und Service Worker
 *
 * Die Zone des Prozesses ist festgenagelt: `browserTimeZone()` liest sie, und
 * ohne Vorgabe pruefte jede Maschine etwas anderes.
 * Ausfuehren: node --test test/test-household-zone-hint.js
 */
process.env.TZ = 'Asia/Seoul';

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { MiniElement, installMiniDom } from './mini-dom.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const read = (rel) => readFileSync(path.join(HERE, '..', rel), 'utf8');

const events = [];
globalThis.CustomEvent = class CustomEvent {
  constructor(type, init) { this.type = type; this.detail = init?.detail; }
};
const store = new Map();
globalThis.localStorage = {
  getItem: (k) => (store.has(k) ? store.get(k) : null),
  setItem: (k, v) => { store.set(k, String(v)); },
  removeItem: (k) => { store.delete(k); },
};
installMiniDom();
globalThis.window = { dispatchEvent: (e) => { events.push(e); }, addEventListener() {} };

/** Mini-DOM merkt sich nur, DASS ein Listener haengt - hier muss er laufen. */
class ClickableElement extends MiniElement {
  addEventListener(type, fn) { (this.handlers ??= {})[type] = fn; }
  remove() { this.removed = true; }
  // `disabled` ist am echten Knopf eine Eigenschaft, kein Attribut-Setter.
}
globalThis.document.createElement = (tag) => new ClickableElement(tag);

const tz = await import('../public/utils/timezone.js');
const hint = await import('../public/utils/household-zone-hint.js');

const ADMIN = { id: 1, role: 'admin' };
const MEMBER = { id: 2, role: 'member' };
const UNSET = { timezone: null, timezone_effective: 'UTC', timezone_hint_dismissed: false };
const t = (key, params) => (params ? `${key}|${JSON.stringify(params)}` : key);

/** Die Zone, die der Browser meldet - oder ein Wurf, wenn `zone` ein Error ist. */
function withBrowserZone(zone, fn) {
  const original = Intl.DateTimeFormat.prototype.resolvedOptions;
  Intl.DateTimeFormat.prototype.resolvedOptions = function patched() {
    if (zone instanceof Error) throw zone;
    return { ...original.call(this), timeZone: zone };
  };
  try { return fn(); } finally { Intl.DateTimeFormat.prototype.resolvedOptions = original; }
}

// --------------------------------------------------------
// Die Zone des Browsers
// --------------------------------------------------------

test('browserTimeZone: eine echte Zone kommt durch', () => {
  assert.equal(tz.browserTimeZone(), 'Asia/Seoul', 'die Zone des Prozesses (TZ am Dateikopf)');
  assert.equal(withBrowserZone('Europe/Berlin', () => tz.browserTimeZone()), 'Europe/Berlin');
});

test('browserTimeZone: ein Browser, der seine Zone verschweigt, nennt keine', () => {
  // Firefox mit resistFingerprinting und Headless melden UTC. Das ist keine
  // Aussage ueber den Haushalt.
  for (const zone of ['UTC', 'Etc/UTC', 'GMT', 'Etc/GMT', 'Etc/Unknown', '', undefined, 'Mars/Olympus_Mons']) {
    assert.equal(withBrowserZone(zone, () => tz.browserTimeZone()), null, `${zone} ist keine Auskunft`);
  }
  assert.equal(withBrowserZone(new Error('kein Intl'), () => tz.browserTimeZone()), null);
});

/* EINE STELLE FUER DIE FRAGE. Ersteinrichtung (#1613) und Zonen-Hinweis (#1619)
 * trugen je eine eigene Fassung samt eigener Liste der Zonen, die keine Auskunft
 * sind. Zwei Listen driften: eine Zone, die nur in einer steht, wird in der
 * Ersteinrichtung gespeichert und im Hinweis verschwiegen, oder umgekehrt. */
test('browserTimeZone: beide Aufrufer fragen utils/timezone.js und fuehren keine eigene Liste', () => {
  for (const file of ['public/pages/setup.js', 'public/utils/household-zone-hint.js']) {
    const src = read(file);
    assert.doesNotMatch(src, /function\s+browserTimeZone\b/, `${file} definiert die Frage selbst`);
    assert.doesNotMatch(src, /Etc\/UTC|Etc\/Unknown/, `${file} fuehrt eine eigene Liste`);
    assert.match(src, /import\s*\{[^}]*\bbrowserTimeZone\b[^}]*\}\s*from\s*'(?:\/utils|\.)\/timezone\.js'/,
      `${file} importiert browserTimeZone nicht aus utils/timezone.js`);
    assert.match(src.replace(/import\s*\{[^}]*\}\s*from[^;]*;/g, ''), /\bbrowserTimeZone\(/, `${file} ruft sie nicht`);
  }
});

// --------------------------------------------------------
// Dieselbe Uhr?
// --------------------------------------------------------

test('sameClock: dieselbe ID und ein Alias derselben Zone sind keine Abweichung', () => {
  assert.equal(hint.sameClock('Europe/Berlin', 'Europe/Berlin'), true);
  assert.equal(hint.sameClock('europe/berlin', 'Europe/Berlin'), true);
  // Chrome meldet Asia/Calcutta, Firefox Asia/Kolkata - fuer denselben Ort.
  assert.equal(hint.sameClock('Asia/Calcutta', 'Asia/Kolkata'), true);
  assert.equal(hint.sameClock('Europe/Kiev', 'Europe/Kyiv'), true);
  assert.equal(hint.sameClock('America/Buenos_Aires', 'America/Argentina/Buenos_Aires'), true);
});

test('sameClock: gleicher Offset heute ist noch nicht dieselbe Uhr', () => {
  // Im Januar stehen beide auf UTC-7; ab Maerz laeuft Denver eine Stunde vor.
  const januar = new Date('2026-01-15T12:00:00Z');
  assert.equal(hint.sameClock('America/Phoenix', 'America/Denver', januar), false);
  // Im Juli stehen London und Lagos beide auf UTC+1.
  assert.equal(hint.sameClock('Europe/London', 'Africa/Lagos', new Date('2026-07-15T12:00:00Z')), false);
  assert.equal(hint.sameClock('Europe/Berlin', 'Asia/Seoul'), false);
  assert.equal(hint.sameClock('UTC', 'Asia/Seoul'), false);
});

test('sameClock: gleiche Umstelltage, andere Umstellstunde - das ist eine Abweichung', () => {
  // Havanna und New York stellen 2026 an denselben Tagen um, Havanna um
  // Mitternacht, New York um zwei. Eine Probe je Tag saehe das nie.
  assert.equal(hint.sameClock('America/Havana', 'America/New_York', new Date('2026-06-01T12:00:00Z')), false);
});

test('sameClock: eine unlesbare Zone ist nie "dieselbe"', () => {
  assert.equal(hint.sameClock('Mars/Olympus_Mons', 'Europe/Berlin'), false);
  assert.equal(hint.sameClock(null, 'Europe/Berlin'), false);
  assert.equal(hint.sameClock('', ''), false);
});

// --------------------------------------------------------
// Die Bedingung
// --------------------------------------------------------

test('zoneMismatch: nur ohne gesetzte Zone und nur bei abweichender Browser-Zone', () => {
  assert.deepEqual(hint.zoneMismatch(UNSET, 'Asia/Seoul'), { browser: 'Asia/Seoul', household: 'UTC' });
  // gesetzt: der Haushalt hat entschieden, auch wenn der Browser woanders steht
  assert.equal(hint.zoneMismatch({ ...UNSET, timezone: 'Europe/Berlin', timezone_effective: 'Europe/Berlin' }, 'Asia/Seoul'), null);
  // gleich: `TZ` des Containers stimmt bereits
  assert.equal(hint.zoneMismatch({ ...UNSET, timezone_effective: 'Asia/Seoul' }, 'Asia/Seoul'), null);
  assert.equal(hint.zoneMismatch({ ...UNSET, timezone_effective: 'Asia/Kolkata' }, 'Asia/Calcutta'), null);
  // der Browser nennt keine Zone
  assert.equal(hint.zoneMismatch(UNSET, null), null);
  // noch nichts geladen, oder eine Antwort ohne die Felder (Wandtablett)
  assert.equal(hint.zoneMismatch(null, 'Asia/Seoul'), null);
  assert.equal(hint.zoneMismatch({}, 'Asia/Seoul'), null);
  assert.equal(hint.zoneMismatch({ timezone_effective: 'UTC' }, 'Asia/Seoul'), null,
    'ein FEHLENDES timezone-Feld ist kein "nie gesetzt"');
  assert.equal(hint.zoneMismatch({ timezone: null, timezone_effective: '' }, 'Asia/Seoul'), null);
});

test('zoneMismatch liest die Zone des Browsers selbst, wenn keine uebergeben wird', () => {
  assert.deepEqual(hint.zoneMismatch(UNSET), { browser: 'Asia/Seoul', household: 'UTC' });
  assert.equal(withBrowserZone('UTC', () => hint.zoneMismatch({ ...UNSET, timezone_effective: 'Europe/Berlin' })), null,
    'ein UTC-Browser loest keinen Hinweis aus');
});

test('zonePrompt: nur Admins, nur ungemerkt, nie am Wandtablett', () => {
  const opts = { browserZone: 'Asia/Seoul' };
  assert.deepEqual(hint.zonePrompt(UNSET, ADMIN, opts), { browser: 'Asia/Seoul', household: 'UTC' });
  assert.equal(hint.zonePrompt(UNSET, MEMBER, opts), null, 'ein Mitglied kann die Zone nicht setzen');
  assert.equal(hint.zonePrompt(UNSET, null, opts), null, 'ohne Konto kein Hinweis');
  assert.equal(hint.zonePrompt({ ...UNSET, timezone_hint_dismissed: true }, ADMIN, opts), null, '"So lassen" gilt');
  assert.equal(hint.zonePrompt(UNSET, { ...ADMIN, access_scope: 'display' }, opts), null, 'kein Hinweis am Wandtablett');
  assert.equal(hint.zonePrompt(UNSET, ADMIN, { ...opts, wall: true }), null, 'kein Hinweis im Wandmodus');
  assert.equal(hint.zonePrompt({ ...UNSET, timezone: 'Europe/Berlin' }, ADMIN, opts), null);
  assert.equal(hint.zonePrompt({ ...UNSET, timezone_effective: 'Asia/Seoul' }, ADMIN, opts), null);
  assert.equal(hint.zonePrompt(UNSET, ADMIN, { browserZone: null }), null);
});

// --------------------------------------------------------
// Der gemerkte Stand
// --------------------------------------------------------

test('der Stand kommt aus /preferences und faellt mit der Sitzung', () => {
  hint.forgetZonePrefs();
  assert.equal(hint.knownZonePrefs(), null);
  hint.rememberZonePrefs({ ...UNSET, currency: 'EUR' });
  assert.deepEqual(hint.knownZonePrefs(), UNSET, 'nur die drei Felder, die der Hinweis braucht');
  hint.forgetZonePrefs();
  assert.equal(hint.knownZonePrefs(), null);
  // Eine Antwort ohne die Felder (Fehler, Wandtablett) ist kein "nie gesetzt".
  hint.rememberZonePrefs({ currency: 'EUR' });
  assert.equal(hint.zonePrompt(hint.knownZonePrefs(), ADMIN, { browserZone: 'Asia/Seoul' }), null);
  hint.rememberZonePrefs(undefined);
  assert.equal(hint.knownZonePrefs(), null);
});

// --------------------------------------------------------
// Die zwei Handlungen
// --------------------------------------------------------

function fakeApi({ current = UNSET, putFails = null } = {}) {
  const calls = [];
  return {
    calls,
    get: async (url) => { calls.push(['get', url]); return { data: { ...current } }; },
    put: async (url, body) => {
      calls.push(['put', url, body]);
      if (putFails) throw putFails;
      const timezone = 'timezone' in body ? body.timezone : current.timezone;
      return {
        data: {
          timezone,
          timezone_effective: timezone ?? current.timezone_effective,
          timezone_hint_dismissed: true,
        },
      };
    },
  };
}

function reset() {
  events.length = 0;
  store.clear();
  tz._resetDisplayTimeZoneCache();
  hint.rememberZonePrefs(UNSET);
}

test('Uebernehmen: schreibt die Zone, spiegelt sie in die Anzeige und zeichnet neu', async () => {
  reset();
  const api = fakeApi();
  const result = await hint.adoptZone('Asia/Seoul', { api });

  assert.deepEqual(api.calls, [
    ['get', '/preferences'],
    ['put', '/preferences', { timezone: 'Asia/Seoul' }],
  ], 'erst nachlesen, dann genau das eine Feld schreiben');
  assert.equal(result.adopted, true);
  assert.equal(tz.displayTimeZone(), 'Asia/Seoul', 'die Anzeige folgt der neuen Zone sofort');
  assert.deepEqual(events.map((e) => [e.type, e.detail]), [['timezone-changed', { timezone: 'Asia/Seoul' }]],
    'offene Ansichten zeichnen ueber dasselbe Ereignis neu wie beim Auswahlfeld');
  assert.equal(hint.zonePrompt(hint.knownZonePrefs(), ADMIN, { browserZone: 'Asia/Seoul' }), null,
    'der Hinweis ist nach dem Neuzeichnen weg');
});

test('Uebernehmen: hat inzwischen ein anderer Admin entschieden, wird NICHT ueberschrieben', async () => {
  // Zwei Admins, zwei Geraete: der erste uebernimmt Europe/Berlin, beim zweiten
  // steht der Hinweis noch im offenen Tab - mit seiner eigenen Browser-Zone.
  reset();
  const api = fakeApi({ current: { timezone: 'Europe/Berlin', timezone_effective: 'Europe/Berlin', timezone_hint_dismissed: true } });
  const result = await hint.adoptZone('Asia/Seoul', { api });

  assert.deepEqual(api.calls, [['get', '/preferences']], 'kein PUT');
  assert.equal(result.adopted, false);
  assert.equal(result.timezone, 'Europe/Berlin');
  assert.equal(tz.displayTimeZone(), 'Europe/Berlin', 'die Anzeige folgt der Zone des Haushalts');
  assert.equal(events.at(-1)?.type, 'timezone-changed');
  assert.equal(hint.knownZonePrefs().timezone, 'Europe/Berlin');
});

test('Uebernehmen aus dem Band: hat ein anderer Admin "So lassen" gesagt, wird NICHT geschrieben', async () => {
  // Review zu #1619: das Nachlesen liefert dann `timezone: null` MIT gesetztem
  // Merker. Nur auf eine gesetzte Zone zu pruefen liess den alten Tab seine
  // Browser-Zone trotzdem schreiben - gegen die Entscheidung des Haushalts.
  reset();
  const api = fakeApi({ current: { ...UNSET, timezone_hint_dismissed: true } });
  const result = await hint.adoptZone('Asia/Seoul', { api, respectDismissed: true });

  assert.deepEqual(api.calls, [['get', '/preferences']], 'kein PUT');
  assert.equal(result.adopted, false);
  assert.equal(result.timezone, null);
  assert.equal(tz.displayTimeZone(), null, 'die Anzeige bleibt beim Browser');
  assert.deepEqual(events, [], 'nichts hat sich geaendert, nichts zeichnet neu');
  assert.equal(hint.zonePrompt(hint.knownZonePrefs(), ADMIN, { browserZone: 'Asia/Seoul' }), null,
    'das Band kommt nicht wieder');
});

test('Uebernehmen in den Einstellungen gilt auch nach "So lassen"', async () => {
  // Die Gegenrichtung, mit Absicht: die Zeile der Zeitzonen-Karte hat keinen
  // Wegklick und ist der Ort, an dem die Handlung nach "So lassen" auffindbar
  // bleibt. Wer dort klickt, entscheidet neu.
  reset();
  const api = fakeApi({ current: { ...UNSET, timezone_hint_dismissed: true } });
  const result = await hint.adoptZone('Asia/Seoul', { api });

  assert.deepEqual(api.calls, [
    ['get', '/preferences'],
    ['put', '/preferences', { timezone: 'Asia/Seoul' }],
  ]);
  assert.equal(result.adopted, true);
  assert.equal(tz.displayTimeZone(), 'Asia/Seoul');
});

test('eine Zonen-Entscheidung von anderswo beendet das Band dieser Sitzung', () => {
  // Review zu #1619: das Auswahlfeld der Einstellungen speichert und loest
  // `timezone-changed` aus, aber der gemerkte Stand blieb bei `timezone: null`
  // - die Uebersicht fragte danach weiter, obwohl der Server eine Zone hat.
  const prompt = () => hint.zonePrompt(hint.knownZonePrefs(), ADMIN, { browserZone: 'Asia/Seoul' });
  reset();
  assert.ok(prompt(), 'Ausgangslage: das Band steht');
  hint.noteZoneDecision('Europe/Berlin');
  assert.equal(prompt(), null, 'eine gewaehlte Zone beendet das Band');
  assert.equal(hint.knownZonePrefs().timezone, 'Europe/Berlin');
  assert.equal(hint.knownZonePrefs().timezone_effective, 'Europe/Berlin');

  // Bewusst "Automatisch": der Server merkt das als Entscheidung (jede
  // angenommene timezone-Schreibung setzt den Merker), das Band also auch.
  reset();
  hint.noteZoneDecision(null);
  assert.equal(prompt(), null, 'auch "Automatisch" ist eine Entscheidung');
  assert.equal(hint.knownZonePrefs().timezone, null);
  assert.equal(hint.knownZonePrefs().timezone_effective, 'UTC', 'der Rueckfall bleibt, wie er geladen wurde');

  // Ohne geladenen Stand wird keiner erfunden.
  hint.forgetZonePrefs();
  hint.noteZoneDecision('Europe/Berlin');
  assert.equal(hint.knownZonePrefs(), null);
});

test('Uebernehmen: ein Fehlschlag laesst alles, wie es war', async () => {
  reset();
  const boom = new Error('Ungültige Zeitzone.');
  await assert.rejects(hint.adoptZone('Asia/Seoul', { api: fakeApi({ putFails: boom }) }), boom);
  assert.equal(tz.displayTimeZone(), null);
  assert.deepEqual(events, []);
  assert.deepEqual(hint.zonePrompt(hint.knownZonePrefs(), ADMIN, { browserZone: 'Asia/Seoul' }),
    { browser: 'Asia/Seoul', household: 'UTC' }, 'der Hinweis bleibt stehen');
});

test('So lassen: merkt die Entscheidung am Haushalt und fasst die Zone nicht an', async () => {
  reset();
  const api = fakeApi();
  await hint.keepZone({ api });

  assert.deepEqual(api.calls, [['put', '/preferences', { timezone_hint_dismissed: true }]]);
  assert.equal(tz.displayTimeZone(), null, 'die Anzeige bleibt beim Browser');
  assert.deepEqual(events, [], 'nichts zeichnet neu');
  assert.equal(hint.zonePrompt(hint.knownZonePrefs(), ADMIN, { browserZone: 'Asia/Seoul' }), null);
  // Die Zeile in den Einstellungen bleibt: dort gibt es keinen Wegklick.
  assert.deepEqual(hint.zoneMismatch(hint.knownZonePrefs(), 'Asia/Seoul'), { browser: 'Asia/Seoul', household: 'UTC' });
});

test('So lassen: hat inzwischen jemand eine Zone gewaehlt, folgt die Anzeige ihr', async () => {
  reset();
  // Der Tab ist alt: er kennt "nie gesetzt", der Server hat laengst Berlin.
  const api = fakeApi({ current: { timezone: 'Europe/Berlin', timezone_effective: 'Europe/Berlin', timezone_hint_dismissed: true } });
  await hint.keepZone({ api });

  assert.equal(tz.displayTimeZone(), 'Europe/Berlin');
  assert.equal(events.length, 1, 'offene Ansichten zeichnen neu');
  assert.equal(hint.knownZonePrefs().timezone, 'Europe/Berlin');
});

test('So lassen: ein Fehlschlag merkt nichts', async () => {
  reset();
  const boom = new Error('offline');
  await assert.rejects(hint.keepZone({ api: fakeApi({ putFails: boom }) }), boom);
  assert.equal(hint.knownZonePrefs().timezone_hint_dismissed, false);
});

// --------------------------------------------------------
// Die Bauform
// --------------------------------------------------------

const MISMATCH = { browser: 'Asia/Seoul', household: 'UTC' };

test('zoneHintEl: Statuszeile mit beiden Zonen, ohne Handlung keine Knoepfe', () => {
  const el = hint.zoneHintEl({ mismatch: MISMATCH, t });
  const html = el.outerHTML;
  assert.match(html, /role="status"/);
  assert.ok(html.includes('settings.timezoneMismatch|{"browser":"Asia/Seoul","household":"UTC"}'),
    'der Satz nennt beide Zonen und kommt aus t()');
  assert.doesNotMatch(html, /<button/, 'ein Mitglied sieht den Zustand, aber keine Handlung');
});

test('zoneHintEl: die Handlungen sind echte Knoepfe und rufen ihren Weg', async () => {
  const called = [];
  const el = hint.zoneHintEl({
    mismatch: MISMATCH, t,
    onAdopt: async () => { called.push('adopt'); },
    onKeep: async () => { called.push('keep'); },
  });
  const html = el.outerHTML;
  assert.equal((html.match(/<button/g) || []).length, 2);
  assert.equal((html.match(/type="button"/g) || []).length, 2, 'kein Knopf darf ein Formular abschicken');
  assert.match(html, /settings\.timezoneMismatchAdopt/);
  assert.match(html, /settings\.timezoneMismatchKeep/);
  // Zielgroesse: .btn--sm traegt 40px am Zeiger und 44px am Finger (layout.css).
  assert.equal((html.match(/class="btn btn--[a-z]+ btn--sm"/g) || []).length, 2);

  const [adopt, keep] = hint.zoneHintButtons(el);
  await adopt.handlers.click();
  await keep.handlers.click();
  assert.deepEqual(called, ['adopt', 'keep']);
});

test('zoneHintEl: nur "Uebernehmen" - die Zeile der Einstellungen hat keinen Wegklick', () => {
  const el = hint.zoneHintEl({ mismatch: MISMATCH, t, onAdopt: async () => {} });
  assert.equal((el.outerHTML.match(/<button/g) || []).length, 1);
  assert.doesNotMatch(el.outerHTML, /timezoneMismatchKeep/);
});

test('ein Knopf ist waehrend seines Aufrufs gesperrt und meldet den Fehler', async () => {
  const failures = [];
  let release;
  const el = hint.zoneHintEl({
    mismatch: MISMATCH, t,
    onAdopt: () => new Promise((_, reject) => { release = reject; }),
    onKeep: async () => {},
    onError: (error) => { failures.push(error.message); },
  });
  const [adopt, keep] = hint.zoneHintButtons(el);
  const running = adopt.handlers.click();
  assert.equal(adopt.disabled, true);
  assert.equal(keep.disabled, true, 'beide: sonst liefen zwei Entscheidungen gegeneinander');
  release(new Error('offline'));
  await running;
  assert.deepEqual(failures, ['offline']);
  assert.equal(adopt.disabled, false);
  assert.equal(keep.disabled, false);
});

// --------------------------------------------------------
// Die Verdrahtung
// --------------------------------------------------------

const code = (rel) => read(rel).split('\n').filter((line) => {
  const s = line.trimStart();
  return !s.startsWith('//') && !s.startsWith('*') && !s.startsWith('/*');
}).join('\n');

test('router.js fuettert den Stand aus /preferences und vergisst ihn mit der Sitzung', () => {
  const router = code('public/router.js');
  const sync = router.slice(router.indexOf('async function syncPreferencesOnce()'), router.indexOf('async function syncThirdPartyModules()'));
  assert.match(sync, /rememberZonePrefs\(res\?\.data\)/, 'syncPreferencesOnce() reicht die Antwort nicht weiter');
  const forget = router.slice(router.indexOf('function forgetSessionState()'));
  assert.match(forget.slice(0, forget.indexOf('\n}\n')), /forgetZonePrefs\(\)/,
    'der naechste Nutzer am selben Geraet erbte sonst den Stand des vorigen');
});

test('router.js zieht den Stand bei jedem timezone-changed nach - an EINER Stelle', () => {
  // Das Ereignis feuert nur nach einem geglueckten Schreiben (Auswahlfeld der
  // Einstellungen, Uebernehmen). Die /preferences-Antwort, die die Uebersicht
  // bei jedem Aufbau holt, bleibt aussen vor: sie kann aelter sein als das
  // Schreiben und stellte das Band wieder hin.
  const router = code('public/router.js');
  // assert.ok statt assert.match: ein Fehlschlag druckte sonst ganz router.js.
  assert.ok(/addEventListener\('timezone-changed',\s*\(event\)\s*=>\s*noteZoneDecision\(event\.detail\?\.timezone\)\)/.test(router),
    'router.js zieht den Stand nach einem Zonenwechsel nicht nach');
  const dashboard = code('public/pages/dashboard.js');
  assert.doesNotMatch(dashboard, /rememberZonePrefs|noteZoneDecision/,
    'die Uebersicht darf den Stand nicht aus ihrer eigenen Antwort fuettern');
  const render = dashboard.slice(dashboard.indexOf('export async function render(container'));
  const mount = render.indexOf('mountZonePrompt(');
  assert.doesNotMatch(render.slice(mount, mount + 300), /respectDismissed/, 'das Band entscheidet das selbst');
  assert.match(read('public/utils/household-zone-hint.js'), /adoptZone\(mismatch\.browser, \{ api, respectDismissed: true \}\)/,
    'das Band der Uebersicht achtet ein "So lassen" von anderswo nicht');
  assert.doesNotMatch(code('public/settings/pages/personal-appearance.js'), /respectDismissed/,
    'die Zeile der Einstellungen bleibt nach "So lassen" eine gueltige Handlung');
});

test('die Uebersicht setzt den Hinweis im synchronen Teil, nicht nach den Daten', () => {
  // Kein Layout-Sprung: der Hinweis steht schon neben dem Skelett. Kaeme er
  // erst mit den Daten, schoebe er alles Gezeichnete um seine Hoehe nach unten.
  const dashboard = code('public/pages/dashboard.js');
  const render = dashboard.slice(dashboard.indexOf('export async function render(container'));
  const mount = render.indexOf('mountZonePrompt(');
  assert.ok(mount > 0, 'render() ruft mountZonePrompt nicht');
  assert.ok(mount < render.indexOf('await '), 'mountZonePrompt steht hinter dem ersten await');
  assert.ok(mount > render.indexOf('setHtml(container'), 'mountZonePrompt steht vor dem Geruest, das es fuellt');
  assert.match(render.slice(mount, mount + 200), /wall:\s*wallMode/, 'der Wandmodus wird nicht durchgereicht');
});

test('die Einstellungen zeigen die Zeile fuer alle und die Handlung nur Admins', () => {
  const settings = code('public/settings/pages/personal-appearance.js');
  assert.match(settings, /zoneMismatch\(/);
  assert.match(settings, /onAdopt:\s*isAdmin\s*\?/, 'ein Mitglied bekaeme einen Knopf, den der Server mit 403 beantwortet');
  assert.doesNotMatch(settings, /onKeep/, 'in den Einstellungen gibt es keinen Wegklick');
});

test('das Modul steht in der Precache-Liste des Service Workers', () => {
  assert.match(read('public/sw.js'), /'\/utils\/household-zone-hint\.js'/);
});

test('die Bauform ist das vorhandene Band, kein neues Muster', () => {
  const css = read('public/styles/layout.css');
  assert.match(css, /\.module-readonly-banner,\s*\n\.page-notice \{/, 'das Band teilt sich die Regel des Nur-lesen-Bands');
  const el = hint.zoneHintEl({ mismatch: MISMATCH, t });
  assert.match(el.outerHTML, /class="page-notice zone-hint"/);
});
