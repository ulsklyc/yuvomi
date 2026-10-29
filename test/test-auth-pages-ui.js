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
    // Seit R22 auch die Formular-Teile: `auth-form__forgot` (der Rueckweg zur
    // Anmeldung) hatte keine Regel und stand als schwarzer Fliesstext dicht
    // unter dem Knopf, sobald er nicht betont war (/pair, /reset-password).
    for (const [cls] of read(`../public/pages/${page}.js`).matchAll(/\bauth-(?:card|hero|form)__[\w-]+/g)) rendered.add(cls);
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
    assert.match(src, /import \{[^}]*\b(?:flagField|showAuthError)\b[^}]*\} from '\/utils\/auth-ui\.js'/, `${page}.js importiert weder flagField noch showAuthError`);
    for (const f of fields) {
      // R23 D14: die Einrichtung meldet am Feld mit showAuthError (markiert per
      // flagField und setzt den Fokus) - das zaehlt wie ein flagField. Seit
      // R24 (G6-Zugang-P2-1) auch die Einladung.
      assert.match(src, new RegExp(`(?:flagField\\((?:form\\.)?${f}\\b|showAuthError\\(errorEl, [^\\n]*(?:form\\.)?${f}\\)|form\\.${f}\\b[^\\n]*\\]\\.filter\\(Boolean\\))`), `${page}.js: kein flagField fuer ${f}`);
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

/* KEINE SACKGASSE AUF /join (Critique R21, a1; D15). Ohne gueltige Einladung
 * stand "Es wurde kein gueltiger Token gefunden." - ein Wort aus der Technik,
 * kein naechster Schritt, und der Weg zur Anmeldung als unscheinbare Zeile.
 * Jetzt sagt der Satz, was zu tun ist (um einen neuen Link bitten), und die
 * Anmeldung steht betont wie nach falschen Zugangsdaten (login.js). */
test('/join ohne gueltige Einladung: der Titel nennt sie, EIN Satz, "Zur Anmeldung" als Primaerknopf (R21, R22 D19)', async () => {
  const { readdirSync } = await import('node:fs');
  const join = read('../public/pages/join.js');
  assert.match(join, /<a class="btn btn--primary auth-form__submit" id="join-to-login" href="\/login" data-link hidden>\$\{esc\(t\('join\.toLogin'\)\)\}<\/a>/,
    'der Weg zur Anmeldung ist ein Primaerknopf, kein Textlink');
  const dead = join.slice(join.indexOf('const dead = '), join.indexOf('const unknown = '));
  assert.match(dead, /querySelector\('#join-title'\)\.textContent = t\('join\.invalidTitle'\)/,
    'der Titel nennt die ungueltige Einladung statt "Konto einrichten"');
  assert.match(dead, /show\(errorEl, t\('join\.invalidToken'\)\)/, 'EIN Satz fuer fehlenden und ungueltigen Link');
  assert.match(dead, /toLogin\.hidden = false;\s*toLogin\.focus\(\);/, 'der Knopf erscheint und bekommt den Fokus');
  assert.match(dead, /querySelector\('#join-login'\)\.hidden = true/, 'kein zweiter Weg zur Anmeldung daneben');
  assert.doesNotMatch(join, /join\.missingToken/, 'kein zweiter Satz fuer dieselbe Lage');
  assert.match(join, /if \(!token\) \{ dead\(\); return; \}/);
  assert.match(join, /if \(!preview\?\.valid\) \{ dead\(\); return; \}/);
  // Voruebergehend ist nicht tot: Titel und Rueckweg bleiben (429, Netz).
  assert.match(join, /unknown\(t\('join\.previewFailed'\)\)/);
  assert.match(css, /\.auth-form__forgot--emphasis a \{/, 'die Betonung des voruebergehenden Falls hat ihre Regel');

  const de = JSON.parse(read('../public/locales/de.json')).join;
  assert.match(de.invalidToken, /bitte um einen neuen/, 'join.invalidToken nennt den naechsten Schritt');
  const dir = new URL('../public/locales/', import.meta.url);
  for (const file of readdirSync(dir).filter((f) => f.endsWith('.json'))) {
    const { join: j } = JSON.parse(readFileSync(new URL(file, dir), 'utf8'));
    assert.doesNotMatch(j.invalidToken, /token/i, `${file}: kein "Token" in der Meldung`);
    assert.ok(j.invalidTitle && j.toLogin, `${file}: Titel und Knopf der toten Einladung`);
    assert.equal(j.missingToken, undefined, `${file}: join.missingToken ist weg`);
  }
});

/* WER HILFT, WER EINLAEDT (Critique R24, G6-Zugang-P3-1). Ohne SMTP stand nach
 * "Ungueltige Anmeldedaten." kein Weg da (der Link "Passwort vergessen?" fehlt
 * dort zu Recht); die Einladung sagte "Du wurdest zu Yuvomi eingeladen" ohne
 * Person und mit dem Produktnamen auch dort, wo der Haushalt einen eigenen hat. */
test('R24: falsche Zugangsdaten ohne Zuruecksetzen nennen die Administration, die Einladung nennt die Person', () => {
  const login = read('../public/pages/login.js');
  assert.match(login, /const resetOffered = form\.querySelector\('\.auth-form__forgot'\)\?\.hidden === false;/,
    'gefragt wird der Link im Formular, nicht der Gast-Knopf des SSO-Blocks');
  assert.match(login, /err\.status === 401\) message = t\(resetOffered \? 'login\.invalidCredentials' : 'login\.invalidCredentialsAskAdmin'\)/);
  const join = read('../public/pages/join.js');
  assert.match(join, /if \(preview\.invited_by\) \{\s*intro\.textContent = t\('join\.introNamed', \{ name: preview\.invited_by, app: getStoredAppName\(\) \}\);/);
  const de = JSON.parse(read('../public/locales/de.json'));
  assert.match(de.login.invalidCredentialsAskAdmin, /^Ungültige Anmeldedaten\. .*Administration/);
  assert.equal(de.join.introNamed, '{{name}} hat dich zu {{app}} eingeladen. Lege hier deine Zugangsdaten fest.');
});

/* EIN OFFLINE-ZUSTAND, EIN WORT (Critique R24, G6-Rand-P3-1). offline.html hatte
 * eine eigene Karte (Radius 12, Haarlinie, graues wifi-off, "Keine Verbindung")
 * neben dem Zustand der App ("Verbindung unterbrochen", page-unreachable). Jetzt
 * steht sie auf der Buehne der Zugangsseiten: Lichtfeld, Glastafel 26 px, die
 * Bildmarke als Absender und derselbe Titel. */
test('R24: offline.html steht auf der Buehne der Zugangsseiten und heisst wie der Zustand der App', async () => {
  const offline = read('../public/offline.html');
  const de = JSON.parse(read('../public/locales/de.json'));
  const title = de.common.sessionUnreachableTitle;
  assert.equal(offline.match(/<h1>([^<]+)<\/h1>/)?.[1], title, 'derselbe Titel wie page-unreachable');
  assert.match(offline, new RegExp(`<title>${title} - Yuvomi</title>`));
  const style = offline.slice(offline.indexOf('<style>') + 7, offline.indexOf('</style>'));
  const stage = [...eachRule(style)].find((r) => r.selector === '.stage' && !r.at.length);
  assert.ok(stage, '.stage fehlt');
  assert.match(stage.body, /border-radius:\s*var\(--radius-xl\)/);
  assert.match(style, /--radius-xl:\s*26px;/, 'die Tafel traegt den Radius schwebender Flaechen');
  assert.match(stage.body, /box-shadow:\s*var\(--glass-inset-elevated\), var\(--glass-shadow-lg\)/, 'Lichtkante und Glas-Schatten wie .auth-page');
  assert.match(style, /radial-gradient\(circle 24rem at calc\(50% - 13rem\) calc\(50% - 12rem\)/, 'das Marken-Lichtfeld liegt auf dem Grund');
  // Die Bildmarke: dieselben drei Kreise wie utils/brand-mark.js.
  const { BRAND_MARK_CIRCLES } = await import('../public/utils/brand-mark.js');
  for (const [cx, cy, r] of BRAND_MARK_CIRCLES) {
    assert.ok(offline.includes(`<circle cx="${cx}" cy="${cy}" r="${r}"/>`), `Kreis ${cx}/${cy}/${r} der Bildmarke`);
  }
  assert.doesNotMatch(offline, /Keine Verbindung/, 'kein zweites Wort fuer denselben Zustand');
});

/* /pair: DER FEHLER STEHT AM FELD, UND ES GIBT EINEN WEG ZURUECK (Critique R22,
 * D19). Die Meldung stand als Banner unter dem Formular, das Feld zeigte keinen
 * Fehlerzustand, ein falscher Code kam als englischer Servertext an, und von der
 * Seite fuehrte kein Weg weg. */
test('/pair: Fehler am Codefeld, uebersetzter Satz, Weg zur Anmeldung (R22 D19)', () => {
  const page = read('../public/pages/pair-display.js');
  const group = page.slice(page.indexOf('<input class="form-input" type="text" id="pair-code"'), page.indexOf('id="pair-label"'));
  assert.match(group, /<div id="pair-error" class="form-error" role="alert" tabindex="-1" hidden><\/div>/,
    'die Meldung steht in der Gruppe des Codefelds');
  assert.match(page, /if \(err\?\.status === 400\) flagField\(codeEl, errorEl\);/, 'ein falscher Code markiert das Feld');
  assert.match(page, /err\?\.status === 400 \? t\('pairDisplay\.failed'\) : errorSentence\(err\)/,
    'nie der englische Text des Servers');
  assert.doesNotMatch(page, /err\.message \|\|/);
  assert.match(page, /<p class="auth-form__forgot"><a href="\/login" data-link>\$\{esc\(t\('forgotPassword\.backToLogin'\)\)\}<\/a><\/p>/,
    'der Weg zurueck zur Anmeldung');
  assert.match(page, /wireLinks\(container\);/, 'der Link navigiert in der App');
});

/* KEINE SACKGASSE AUF /reset-password (Critique R21, Persona Inge; D15).
 * Ohne Token stand "Es wurde kein gueltiger Token gefunden." unter einem
 * gesperrten Formular - ein Wort aus der Technik und kein Weg hinaus. Jetzt
 * nennt der Satz den Link und den naechsten Schritt, das Formular weicht, und
 * "Neuen Link anfordern" fuehrt zu /forgot-password. */
test('/reset-password ohne gueltigen Link: Satz mit naechstem Schritt und Weg zu einem neuen Link (Critique R21)', async () => {
  const { readdirSync } = await import('node:fs');
  const page = read('../public/pages/reset-password.js');
  assert.match(page, /<a class="btn btn--primary auth-form__submit" id="reset-request-new" href="\/forgot-password" data-link hidden>\$\{esc\(t\('resetPassword\.requestNew'\)\)\}<\/a>/,
    'der Weg zu einem neuen Link steht als Primaerknopf auf der Seite (R22 D19)');
  const dead = page.slice(page.indexOf('const dead = '), page.indexOf('if (!token)'));
  assert.match(dead, /form\.hidden = true/, 'ein toter Link nimmt das Formular weg');
  // Ein 400 gilt als toter Link - das stimmt nur, wenn das Formular die Laenge
  // so zaehlt wie der Server (NFC, server/auth.js /reset-password).
  assert.match(page, /if \(password\.normalize\('NFC'\)\.length < 8\)/,
    'die Laengenpruefung zaehlt NFC wie der Server, sonst wird ein gueltiger Link fuer tot erklaert');
  assert.match(read('../server/auth.js'), /if \(normalizePassword\(password\)\.length < 8\)/, 'und der Server zaehlt NFC');
  assert.match(dead, /reset-request-new/, 'und betont den Weg zu einem neuen Link');
  assert.match(dead, /querySelector\('#reset-title'\)\.textContent = t\('resetPassword\.invalidTitle'\)/,
    'der Titel nennt den ungueltigen Link (R22 D19)');
  const de = JSON.parse(read('../public/locales/de.json')).resetPassword;
  for (const key of ['missingToken', 'invalidToken']) {
    assert.match(de[key], /fordere einen neuen an/, `resetPassword.${key} nennt den naechsten Schritt`);
  }
  const dir = new URL('../public/locales/', import.meta.url);
  for (const file of readdirSync(dir).filter((f) => f.endsWith('.json'))) {
    const { resetPassword: r } = JSON.parse(readFileSync(new URL(file, dir), 'utf8'));
    for (const key of ['missingToken', 'invalidToken', 'requestNew']) {
      assert.doesNotMatch(r[key] ?? '', /token/i, `${file}: kein "Token" in resetPassword.${key}`);
      assert.ok(r[key], `${file}: resetPassword.${key} fehlt`);
    }
  }
});

// R23 D14 (Critique G6 P2/P3): Einrichtung und Anmeldung melden einen Fehler AM
// Feld und setzen den Fokus dorthin - nicht im Kasten vor dem Knopf.
test('R23: Feldfehler an Einrichtung und Anmeldung stehen am Feld, mit Fokus', async () => {
  const { showAuthError } = await import('../public/utils/auth-ui.js');
  const focused = [];
  const moved = [];
  const group = { appendChild: (el) => moved.push(el) };
  const attrs = new Map();
  const field = {
    closest: () => group, focus: () => focused.push('field'), addEventListener() {},
    setAttribute: (k, v) => attrs.set(k, v), getAttribute: (k) => attrs.get(k) ?? null,
  };
  const errorEl = { id: 'e', hidden: true, textContent: '', parentNode: { insertBefore() {} }, nextSibling: null, focus: () => focused.push('box') };
  showAuthError(errorEl, 'Passt nicht', field);
  assert.deepEqual(moved, [errorEl], 'die Meldung zieht unter das Feld');
  assert.deepEqual(focused, ['field'], 'der Fokus geht aufs Feld, nicht auf den Kasten');
  assert.equal(attrs.get('aria-invalid'), 'true');
  assert.equal(errorEl.hidden, false);
  const setup = read('../public/pages/setup.js');
  assert.doesNotMatch(setup, /setup\.(?:password|confirmPassword)Placeholder/, 'keine Punkte als Platzhalter, die ausgefuellt wirken');
  assert.match(setup, /showAuthError\(errorEl, t\('setup\.errorPasswordMismatch'\), form\.confirm_password\)/);
  const login = read('../public/pages/login.js');
  assert.match(login, /pendingError = \{ message, field: err\.status === 401 \? passwordInput : null \};/, 'falsche Zugangsdaten: am Passwort');
  assert.doesNotMatch(login, /^\s*errorEl\.focus\(\);/m, 'kein Fokus auf den Kasten mehr');
  const de = JSON.parse(read('../public/locales/de.json')).setup;
  assert.doesNotMatch(JSON.stringify(de), /Account/, 'die Einrichtung sagt "Konto"');
});

// R23 S10 (Critique G1/G6 P3): /pair prueft die Laenge vor dem Versuch und
// traegt die Marke wie jede Auth-Seite.
test('R23: /pair prueft die zehn Zeichen vorab und traegt die Marke', () => {
  const src = read('../public/pages/pair-display.js');
  assert.match(src, /\$\{authHeroHtml\(\{ heading: false \}\)\}/, 'die Marke ueber der Karte');
  assert.match(src, /code\.replace\(\/\[\\s-\]\/g, ''\)\.length !== PAIR_CODE_LENGTH/, 'Laenge wie am Server gezaehlt');
  const server = read('../server/services/display-accounts.js');
  const serverLen = Number(/const CODE_LENGTH = (\d+);/.exec(server)?.[1]);
  const clientLen = Number(/const PAIR_CODE_LENGTH = (\d+);/.exec(src)?.[1]);
  assert.equal(clientLen, serverLen, 'dieselbe Laenge wie der Server');
});

// Critique R24 G6-Zugang-P2-1: drei Fehler-Dialekte auf den Zugangsseiten.
// Die Einladung meldete im Kasten ueber dem Formular (Fokus auf dem Kasten,
// Feld grau), die Einrichtung markierte das Feld nur fuer Vorlesehilfen, die
// Anmeldung faerbte es rot. Jetzt: EIN Weg - showAuthError zieht die Meldung
// unter das Feld, flagField faerbt es (form-group--error), Fokus ins Feld.
test('R24: jede Zugangsseite meldet am Feld, rot, mit Fokus - EIN Fehlerbild', async () => {
  const { flagField, hideAuthError } = await import('../public/utils/auth-ui.js');
  const classes = new Set();
  const group = { classList: { add: (c) => classes.add(c), remove: (c) => classes.delete(c) }, appendChild() {} };
  const attrs = new Map();
  const field = {
    closest: (sel) => (sel === '.form-group' ? group : null), addEventListener() {},
    setAttribute: (k, v) => attrs.set(k, String(v)), getAttribute: (k) => attrs.get(k) ?? null, removeAttribute: (k) => attrs.delete(k),
  };
  const errorEl = { id: 'join-error', hidden: false };
  flagField(field, errorEl);
  assert.ok(classes.has('form-group--error'), 'das Feld wird rot');
  hideAuthError({ querySelectorAll: () => [field] }, errorEl);
  assert.ok(!classes.has('form-group--error'), 'mit der Meldung geht die Farbe');
  const join = read('../public/pages/join.js');
  assert.doesNotMatch(join, /flagField\([^)]*\);\s*fail\(/, 'kein Kasten ueber dem Formular fuer einen Feldfehler');
  for (const key of ['usernameRequired', 'usernameInvalid', 'displayNameTooLong', 'tooShort', 'mismatch', 'usernameTaken']) {
    assert.match(join, new RegExp(`showAuthError\\(errorEl, t\\('join\\.${key}'\\), `), `join.${key} steht am Feld`);
  }
  // Keine Platzhalter mehr nur in der Einrichtung, kein Stern nur auf /pair.
  const setup = read('../public/pages/setup.js');
  assert.doesNotMatch(setup, /placeholder=/, 'Einrichtung ohne Platzhalter wie die anderen Zugangsseiten');
  assert.doesNotMatch(read('../public/pages/pair-display.js'), /REQUIRED_MARK/, '/pair ohne Stern - ein Formular aus einem Feld');
  // Das einzige Kannfeld einer Zugangsseite sagt es selbst.
  const de = JSON.parse(read('../public/locales/de.json'));
  assert.equal(de.join.displayNameLabel, 'Anzeigename (optional)');
  assert.doesNotMatch(join, /id="join-display-name"[^>]*\brequired\b/);
});

// Critique R24 G6-Einst-P3-4: die Sicherung (und die Dokumentablage) bauten
// ihr eigenes Auge AUSSERHALB des Felds (13px-Glyphe, `data-reveal-target`),
// und der Zeitplan zeigte den Cron-Ausdruck jedem unter dem Klartext.
test('R24: das Auge sitzt auch in den Einstellungen im Feld, der Cron-Ausdruck hinter "Mehr dazu"', async () => {
  const { eachRule } = await import('./css-rules.js');
  for (const page of ['admin-backup', 'documents-storage']) {
    const src = read(`../public/settings/pages/${page}.js`);
    assert.doesNotMatch(src, /data-reveal-target|settings-webdav-reveal-btn|settings-webdav-pw-wrap/, `${page}.js baut kein eigenes Auge`);
    assert.match(src, /wirePasswordToggle\(form\.querySelector\(["']#(?:webdav|document-storage)-password["']\)/, `${page}.js nimmt den einen Baustein`);
  }
  const layout = [...eachRule(read('../public/styles/layout.css'))].filter((r) => !r.at.length).map((r) => r.selector.trim());
  assert.ok(layout.includes('.password-toggle'), 'die Regel des Auges ist global (layout.css), nicht nur auf den Zugangsseiten');
  assert.ok(layout.includes('.input-password-wrapper :is(.input, .form-input)'), 'auch ein .form-input macht dem Auge Platz');
  assert.ok(![...eachRule(read('../public/styles/auth.css'))].some((r) => r.selector.trim() === '.password-toggle'), 'keine zweite Fassung in auth.css');
  const backup = read('../public/settings/pages/admin-backup.js');
  const cell = backup.slice(backup.indexOf('function scheduleValue('), backup.indexOf('\n}\n', backup.indexOf('function scheduleValue(')));
  assert.match(cell, /createElement\('details'\)[\s\S]*summary\.textContent = t\('settings\.hintMore'\)[\s\S]*more\.append\(summary, expression\)/, 'der Ausdruck liegt im Aufklapper');
});
