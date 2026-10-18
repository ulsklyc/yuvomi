/**
 * Test: Die Seiten vor der App-Shell (/login, /setup, /join, /forgot-password,
 *       /reset-password, /pair) stylen jedes Textelement, das sie rendern.
 * Zweck: `.auth-card__title` stand im Markup von vier Seiten und hatte KEINE
 *        Regel (Critique 2026-09-26, Minor Observations) - das <h1> fiel auf
 *        die Reset-Basis zurueck (17px halbfett, so gross wie der Text
 *        darunter). Geprueft wird die Regel, nicht der eine Fund: jedes
 *        Element der Karte oder des Heros (`auth-card__*`, `auth-hero__*`),
 *        das eine Seite rendert, hat eine Regel in auth.css.
 * Ausfuehren: npm run test:auth-pages-ui
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { eachRule } from './css-rules.js';

const read = (rel) => readFileSync(new URL(rel, import.meta.url), 'utf8');
const PAGES = ['login', 'setup', 'join', 'forgot-password', 'reset-password', 'pair-display'];
const css = read('../public/styles/auth.css');
const selectors = [...eachRule(css)].map((r) => r.selector).join('\n');

test('jedes Karten- und Hero-Element der Auth-Seiten hat eine Regel in auth.css', () => {
  const rendered = new Set();
  for (const page of PAGES) {
    for (const [cls] of read(`../public/pages/${page}.js`).matchAll(/\bauth-(?:card|hero)__[\w-]+/g)) rendered.add(cls);
  }
  assert.ok(rendered.has('auth-card__title'), 'die Seiten rendern keinen Kartentitel mehr - Test veraltet');
  assert.ok(rendered.size >= 3, `nur ${rendered.size} Elemente gefunden - der Leser ist kaputt`);
  const missing = [...rendered].filter((cls) => !new RegExp(`\\.${cls}(?![\\w-])`).test(selectors));
  assert.deepEqual(missing, [], `ohne Regel (faellt auf die Reset-Basis zurueck): ${missing.join(', ')}`);
});

test('der Kartentitel ist ein Titel: Title-2-Stufe, fett, Label-Farbe', () => {
  const rule = [...eachRule(css)].find((r) => r.selector === '.auth-card__title' && !r.at.length);
  assert.ok(rule, '.auth-card__title fehlt');
  assert.match(rule.body, /font-size:\s*var\(--type-toolbar-title\)/);
  assert.match(rule.body, /font-weight:\s*var\(--font-weight-bold\)/);
  assert.match(rule.body, /color:\s*var\(--color-text-primary\)/);
});

/* R16 Schritt 2b (Critique 2026-10-05, "Einstellungen/Auth: Marke nur auf Login,
 * drei Fehlerfeld-Varianten", "Auth: Passwort-Auge nur auf Login/Setup"): ein
 * Kopf, ein Passwortfeld, ein Fehlerfeld - aus utils/auth-ui.js. Gegen den
 * Stand davor rot gelaufen. */
const AUTH_FORMS = ['login', 'setup', 'join', 'forgot-password', 'reset-password'];
const ui = read('../public/utils/auth-ui.js');

test('R16: jede Seite vor der Anmeldung traegt denselben Kopf mit der Marke', () => {
  assert.match(ui, /export function authHeroHtml\(/);
  assert.match(ui, /<span class="auth-hero__mark" aria-hidden="true">\$\{brandMarkSvg\(\)\}<\/span>/, 'der Baustein fuehrt die Marke');
  for (const page of AUTH_FORMS) {
    const src = read(`../public/pages/${page}.js`);
    const mains = (src.match(/<main class="auth-page" id="main-content">/g) ?? []).length;
    const heroes = (src.match(/<main class="auth-page" id="main-content">\s*\$\{authHeroHtml\(/g) ?? []).length;
    assert.ok(mains >= 1, `${page}.js rendert keine Auth-Seite mehr - Test veraltet`);
    assert.equal(heroes, mains, `${page}.js: jede gerenderte Seite beginnt mit dem Kopf (${heroes} von ${mains})`);
    assert.doesNotMatch(src, /class="auth-hero"/, `${page}.js baut keinen eigenen Kopf`);
  }
  // Eine Seite, eine <h1>: ueber einer Karte mit eigenem Titel ist der Name ein Absatz.
  for (const page of ['join', 'forgot-password', 'reset-password']) {
    assert.doesNotMatch(read(`../public/pages/${page}.js`), /authHeroHtml\(\{(?![^}]*heading: false)/, `${page}.js: Kopf ohne zweite h1`);
  }
  assert.match(selectors, /\.auth-hero--compact \.auth-hero__title/, 'die leise Fassung hat ihre Regel');
});

test('R16: jedes Passwortfeld vor der Anmeldung traegt das Auge aus dem einen Baustein', () => {
  assert.match(ui, /export function wirePasswordToggle\(/);
  for (const page of AUTH_FORMS) {
    const src = read(`../public/pages/${page}.js`);
    const felder = (src.match(/type="password"/g) ?? []).length;
    const augen = (src.match(/wirePasswordToggle\(/g) ?? []).length;
    assert.equal(augen, felder, `${page}.js: ${felder} Passwortfelder, ${augen} Umschalter`);
    assert.doesNotMatch(src, /className = 'password-toggle'|input-password-wrapper/, `${page}.js baut das Auge nicht selbst`);
  }
});

test('R16: das Fehlerfeld der Auth-Seiten steht in EINER Fassung', () => {
  assert.match(ui, /<div class="form-error" id="\$\{esc\(id\)\}" role="alert" tabindex="-1" hidden><\/div>/);
  for (const page of AUTH_FORMS) {
    const src = read(`../public/pages/${page}.js`);
    assert.doesNotMatch(src, /class="form-error"/, `${page}.js nimmt authErrorHtml()`);
    assert.doesNotMatch(src, /role="alert"[^>]*aria-live|aria-live[^>]*role="alert"/, `${page}.js: alert ist schon assertiv`);
  }
});

/* R18: DIE BILDMARKE KOMMT AUS EINER QUELLE UND KIPPT NICHT MIT DEM THEME.
 * Sie stand zweimal im Code: in der Seitenleiste (router.js, Verlauf an
 * --color-accent - im Dark Weiss auf Flieder) und auf den Zugangsseiten
 * (auth-ui.js, Kreise in currentColor auf einer Akzentkachel - im Dark dunkle
 * Punkte auf Flieder, die Kreise rund 30 % der Kachel). Gemessen wird das
 * ERZEUGTE Markup gegen docs/logo.svg, nicht ein Wortlaut im Quelltext. */
test('R18: die Bildmarke ist docs/logo.svg - eine Quelle, feste Farben, beide Stellen', async () => {
  const { brandMarkSvg, BRAND_MARK_CIRCLES } = await import('../public/utils/brand-mark.js');
  const logo = read('../docs/logo.svg');
  const svg = brandMarkSvg();

  // Form: dieselbe Kachel, dieselben drei Kreise.
  const circlesOf = (markup) => [...markup.matchAll(/<circle cx="(\d+)" cy="(\d+)" r="(\d+)"\s*\/>/g)].map((m) => m.slice(1).map(Number));
  assert.equal(circlesOf(logo).length, 3, 'Reichweite: docs/logo.svg traegt drei Kreise');
  assert.deepEqual(circlesOf(svg), circlesOf(logo), 'die Kreise der Marke sind die von docs/logo.svg');
  assert.deepEqual(BRAND_MARK_CIRCLES.map((c) => [...c]), circlesOf(logo));
  assert.match(svg, /viewBox="0 0 160 160"/);
  assert.match(svg, /<rect width="160" height="160" rx="36" fill="url\(#(yuvomi-brand-mark-\d+)\)"\/>/, 'die Kachel traegt den Verlauf');
  assert.match(svg, /<linearGradient id="yuvomi-brand-mark-\d+" x1="0" y1="0" x2="160" y2="160"/, 'von oben links nach unten rechts');
  // Zwei Marken im selben Dokument teilen sich keine Verlaufs-ID.
  assert.notEqual(svg.match(/id="([^"]+)"/)[1], brandMarkSvg().match(/id="([^"]+)"/)[1]);

  // Farben: nicht im Markup, nicht am Theme. Die Tokens tragen die Werte des
  // Logos und stehen genau einmal - ein Dark-Zwilling waere die alte Lage.
  assert.doesNotMatch(svg, /currentColor|#[0-9a-f]{3,8}\b|stop-color|fill="white"|style=/i, 'das Markup traegt keine Farbe');
  const tokens = read('../public/styles/tokens.css').replace(/\/\*[\s\S]*?\*\//g, '');
  const stops = [...logo.matchAll(/<linearGradient id="bg"[\s\S]*?<\/linearGradient>/g)][0][0];
  const [from, to] = [...stops.matchAll(/stop-color="(#[0-9a-f]{6})"/gi)].map((m) => m[1].toUpperCase());
  for (const [name, value] of [['--brand-mark-from', from], ['--brand-mark-to', to], ['--brand-mark-ink', '#FFFFFF']]) {
    const found = [...tokens.matchAll(new RegExp(`${name}:\\s*([^;]+);`, 'g'))].map((m) => m[1].trim().toUpperCase());
    assert.deepEqual(found, [value], `${name} steht genau einmal und traegt den Wert der Marke`);
  }
  const layout = [...eachRule(read('../public/styles/layout.css'))];
  const body = (sel) => layout.filter((r) => r.selector.trim() === sel).map((r) => r.body).join(';');
  assert.match(body('.brand-mark__from'), /stop-color:\s*var\(--brand-mark-from\)/);
  assert.match(body('.brand-mark__to'), /stop-color:\s*var\(--brand-mark-to\)/);
  assert.match(body('.brand-mark__circles'), /fill:\s*var\(--brand-mark-ink\)/);
  assert.match(body('.brand-mark__circles'), /fill-opacity:\s*0\.82/);

  // Beide Stellen nehmen die eine Quelle, und keine baut die Marke daneben.
  const router = read('../public/router.js');
  assert.match(router, /logomark\.insertAdjacentHTML\('beforeend', brandMarkSvg\(\)\);/, 'die Seitenleiste nimmt die eine Marke');
  assert.match(ui, /import \{ brandMarkSvg \} from '\/utils\/brand-mark\.js';/);
  for (const [name, src] of [['router.js', router], ['auth-ui.js', ui]]) {
    assert.doesNotMatch(src, /<circle|createElementNS\([^)]*\), 'circle'\)|linearGradient/, `${name} baut keine eigene Marke`);
  }

  // Der Traeger auf den Zugangsseiten faerbt nichts mehr: keine Akzentkachel
  // unter dem Zeichen, keine Tinte, kein verkleinertes SVG.
  const mark = [...eachRule(css)].filter((r) => /\.auth-hero__mark\b/.test(r.selector));
  assert.ok(mark.length >= 2, 'Reichweite: Grund- und Kompaktregel der Marke');
  for (const r of mark) {
    assert.doesNotMatch(r.body, /background|(?:^|;)\s*color\s*:/, `${r.selector} faerbt die Marke`);
    assert.doesNotMatch(r.selector, /\bsvg\b/, `${r.selector} skaliert das Zeichen in seiner Kachel`);
  }
});

// --------------------------------------------------------
// Modern-Web-Guidance-Audit, Befund 15: Regel sichtbar, Fehler am Feld
// --------------------------------------------------------

/**
 * Die Passwortregel steht VOR dem ersten Versuch unter dem Feld, nicht erst
 * als Fehler danach (WCAG 3.3.2): jedes NEUE Passwort vor der Anmeldung
 * (Einrichtung, Einladung, Reset) traegt den einen Hinweis aus auth-ui.js und
 * zeigt per `aria-describedby` auf ihn, dazu `minlength="8"` als Angabe fuer
 * Passwortmanager und Screenreader.
 */
test('Befund 15: jedes neue Passwort nennt die Regel sichtbar und verknuepft', () => {
  const ui = read('../public/utils/auth-ui.js');
  assert.match(ui, /export function passwordRuleHtml\(/, 'der eine Hinweis-Baustein');
  for (const [page, field] of [['setup', 'password'], ['join', 'join-password'], ['reset-password', 'password']]) {
    const src = read(`../public/pages/${page}.js`);
    const input = src.match(new RegExp(`<input\\b[^>]*\\bid="${field}"[^>]*>`))?.[0];
    assert.ok(input, `${page}.js: #${field} nicht gefunden`);
    const hintId = input.match(/aria-describedby="([\w-]+)"/)?.[1];
    assert.ok(hintId, `${page}.js: #${field} zeigt auf keinen Hinweis`);
    assert.match(input, /\bminlength="8"/, `${page}.js: #${field} ohne minlength`);
    assert.match(src, new RegExp(`passwordRuleHtml\\('${hintId}', t\\('common\\.passwordMinLength'\\)\\)`), `${page}.js: der Hinweis #${hintId} kommt nicht aus dem Baustein`);
  }
});

/**
 * Ein Fehler, der ein Feld meint, steht AM Feld: `aria-invalid` und ein
 * `aria-describedby` auf die Meldung, und die naechste Eingabe nimmt beides
 * zurueck. Bis hierher sagte nur das eine Fehlerfeld oben, was falsch war -
 * welches Feld, musste man raten.
 */
test('Befund 15: flagField markiert das Feld und die naechste Eingabe nimmt es zurueck', async () => {
  const { flagField } = await import('../public/utils/auth-ui.js');
  const attrs = new Map([['aria-describedby', 'hint']]);
  const listeners = [];
  const field = {
    getAttribute: (k) => attrs.get(k) ?? null,
    setAttribute: (k, v) => attrs.set(k, String(v)),
    removeAttribute: (k) => attrs.delete(k),
    addEventListener: (type, fn) => listeners.push({ type, fn }),
  };
  flagField(field, { id: 'setup-error' });
  assert.equal(attrs.get('aria-invalid'), 'true');
  assert.equal(attrs.get('aria-describedby'), 'hint setup-error', 'der Hinweis bleibt, die Meldung kommt dazu');
  flagField(field, { id: 'setup-error' });
  assert.equal(attrs.get('aria-describedby'), 'hint setup-error', 'zweimal markiert, einmal verknuepft');
  for (const l of listeners.filter((l) => l.type === 'input')) l.fn();
  assert.equal(attrs.has('aria-invalid'), false, 'die Eingabe nimmt die Markierung zurueck');
  assert.equal(attrs.get('aria-describedby'), 'hint');
});

/** Jede Seite markiert die Felder, die ihre Pruefungen meinen. */
test('Befund 15: die Pruefungen der Auth-Seiten markieren ihr Feld', () => {
  const expected = {
    setup: ['username', 'display_name', 'password', 'confirm_password'],
    join: ['usernameEl', 'password', 'confirm'],
    'reset-password': ['password', 'confirm'],
    'forgot-password': ['identifier'],
  };
  for (const [page, fields] of Object.entries(expected)) {
    const src = read(`../public/pages/${page}.js`);
    assert.match(src, /import \{[^}]*\bflagField\b[^}]*\} from '\/utils\/auth-ui\.js'/, `${page}.js importiert flagField nicht`);
    for (const f of fields) {
      assert.match(src, new RegExp(`flagField\\((?:form\\.)?${f}\\b`), `${page}.js: kein flagField fuer ${f}`);
    }
  }
});

/** "Passwort vergessen" mit leerem Feld scheiterte stumm: nur der Fokus sprang. */
test('Befund 15: Passwort vergessen sagt bei leerem Feld, was fehlt', () => {
  const src = read('../public/pages/forgot-password.js');
  assert.match(src, /authErrorHtml\('forgot-error'\)/, 'die Seite hat ein Fehlerfeld');
  assert.match(src, /if \(!identifier\) \{[^}]*t\('forgotPassword\.identifierRequired'\)/, 'leeres Feld: eine Meldung, nicht nur der Fokus');
});

/**
 * Codex-Review zu #2059: die Einrichtung blendete ihre Meldung bei der ersten
 * Eingabe aus, die ANDEREN markierten Felder blieben `aria-invalid` und zeigten
 * auf eine unsichtbare Meldung. `hideAuthError()` nimmt beides zusammen ab;
 * die Einrichtung ruft es bei jeder Eingabe, "Passwort vergessen" ebenso.
 */
test('Befund 15: hideAuthError nimmt Meldung und jede Markierung zusammen ab', async () => {
  const { flagField, hideAuthError } = await import('../public/utils/auth-ui.js');
  const makeField = (describedby) => {
    const attrs = new Map(describedby ? [['aria-describedby', describedby]] : []);
    return {
      attrs,
      getAttribute: (k) => attrs.get(k) ?? null,
      setAttribute: (k, v) => attrs.set(k, String(v)),
      removeAttribute: (k) => attrs.delete(k),
      addEventListener: () => {},
    };
  };
  const a = makeField('hint');
  const b = makeField(null);
  const errorEl = { id: 'setup-error', hidden: false };
  flagField(a, errorEl);
  flagField(b, errorEl);
  const form = { querySelectorAll: () => [a, b].filter((f) => f.attrs.get('aria-invalid') === 'true') };
  hideAuthError(form, errorEl);
  assert.equal(errorEl.hidden, true);
  assert.equal(a.attrs.has('aria-invalid'), false);
  assert.equal(a.attrs.get('aria-describedby'), 'hint', 'der Hinweis bleibt');
  assert.equal(b.attrs.has('aria-invalid'), false);
  assert.equal(b.attrs.has('aria-describedby'), false);
  flagField(b, errorEl);
  assert.equal(b.attrs.get('aria-invalid'), 'true', 'nach dem Abnehmen laesst sich das Feld erneut markieren');

  const setup = read('../public/pages/setup.js');
  assert.match(setup, /addEventListener\('input', \(\) => hideAuthError\(form, errorEl\)\)/, 'die Einrichtung blendet mit hideAuthError aus');
  assert.doesNotMatch(setup, /errorEl\.hidden = true/, 'kein Ausblenden an hideAuthError vorbei');
  const forgot = read('../public/pages/forgot-password.js');
  assert.match(forgot, /form\.identifier\.addEventListener\('input', \(\) => hideAuthError\(form, errorEl\)\)/, '"Passwort vergessen" nimmt die Meldung beim Tippen zurueck');
});

/**
 * Codex-Review zu #2059: auf Einladung und Reset blieb die Meldung stehen,
 * nachdem man das markierte Feld korrigiert hatte - nur Einrichtung und
 * "Passwort vergessen" hatten einen eigenen Eingabe-Handler. Die Korrektur
 * eines markierten Feldes nimmt die Meldung jetzt ueberall mit.
 */
test('Befund 15: die Eingabe in ein markiertes Feld blendet die Meldung aus', async () => {
  const { flagField } = await import('../public/utils/auth-ui.js');
  const listeners = [];
  const attrs = new Map();
  const errorEl = { id: 'reset-error', hidden: false };
  const field = {
    getAttribute: (k) => attrs.get(k) ?? null,
    setAttribute: (k, v) => attrs.set(k, String(v)),
    removeAttribute: (k) => attrs.delete(k),
    addEventListener: (type, fn) => listeners.push({ type, fn }),
  };
  field.form = { querySelectorAll: () => (attrs.get('aria-invalid') === 'true' ? [field] : []) };
  flagField(field, errorEl);
  for (const l of listeners.filter((x) => x.type === 'input')) l.fn();
  assert.equal(errorEl.hidden, true, 'die Meldung blieb nach der Korrektur stehen');
  assert.equal(attrs.has('aria-invalid'), false);
});
