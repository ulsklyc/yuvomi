/**
 * Modul: Passwort-Karte im Konto-Blatt (#1703)
 * Zweck: Ein per Single Sign-on angelegtes Konto hat kein Passwort, nur den
 *        Platzhalter. Das Konto-Blatt zeichnete die Karte "Passwort aendern"
 *        trotzdem fuer jeden - samt Pflichtfeld "Aktuelles Passwort", das es
 *        fuer dieses Konto nicht gibt. Ausfuellen konnte nie gelingen.
 *        Zwei Dinge muessen stimmen:
 *        (1) GET /auth/me sagt dem eigenen Konto, ob es ohne Passwort gefuehrt
 *            wird (`user.sso_only`), auf beiden Wegen hinein (Session und
 *            API-Token) - die Seite fragt sonst niemanden, der es weiss.
 *        (2) Die Seite laesst die Karte genau dann weg. Ein Konto mit Passwort
 *            behaelt sie, verknuepft oder nicht; fehlt die Angabe (alte
 *            Antwort aus dem Speicher, /me nicht erreichbar), bleibt die Karte
 *            stehen wie bisher.
 * Ausfuehren: npm run test:account-password-card
 */
process.env.SESSION_SECRET = process.env.SESSION_SECRET || 'test-secret';
process.env.DB_PATH = ':memory:';

import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { readFileSync } from 'node:fs';
import express from 'express';

globalThis.HTMLElement = globalThis.HTMLElement ?? class {};
globalThis.customElements = globalThis.customElements ?? { define() {}, get() {} };
globalThis.localStorage = globalThis.localStorage ?? { getItem: () => null, setItem() {}, removeItem() {} };
const { installMiniDom } = await import('./mini-dom.js');
installMiniDom();

const dbmod = await import('../server/db.js');
const db = dbmod.get();
const { OIDC_PASSWORD_SENTINEL } = await import('../server/services/oidc.js');
const { router: authRouter, sessionMiddleware } = await import('../server/auth.js');
const { __test: account } = await import('../public/settings/pages/personal-account.js');

// --------------------------------------------------------------------------
// (1) Der Server, gegen den echten Router und eine echte Sitzung.
// --------------------------------------------------------------------------

const actor = { userId: 0 };
const app = express();
app.use(express.json());
app.use(sessionMiddleware);
app.use((req, _res, next) => {
  if (actor.userId) { req.session.userId = actor.userId; req.session.role = 'member'; }
  next();
});
app.use('/', authRouter);
const server = http.createServer(app);
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${server.address().port}`;
test.after(() => server.close());

async function me(userId) {
  actor.userId = userId;
  const res = await fetch(`${base}/me`);
  return { status: res.status, body: await res.json() };
}

const insert = db.prepare(`
  INSERT INTO users (id, username, display_name, password_hash, oidc_sub, role)
  VALUES (?, ?, ?, ?, ?, 'member')
`);
insert.run(301, 'withpassword', 'With Password', '$2b$12$fakehashfakehashfakehash', null);
insert.run(302, 'linked', 'Linked', '$2b$12$fakehashfakehashfakehash', 'sub-linked-1703');
insert.run(303, 'ssoonly', 'SSO Only', OIDC_PASSWORD_SENTINEL, 'sub-sso-1703');

test('/auth/me meldet einem Konto ohne Passwort sso_only: true', async () => {
  const { status, body } = await me(303);
  assert.equal(status, 200);
  assert.equal(body.user.sso_only, true);
});

test('ein Konto mit Passwort bekommt sso_only: false, verknuepft oder nicht', async () => {
  for (const id of [301, 302]) {
    const { status, body } = await me(id);
    assert.equal(status, 200);
    assert.equal(body.user.sso_only, false, `Konto ${id}`);
  }
});

test('auch der Token-Weg durch /me liest das Flag mit', () => {
  // Session- und Token-Zweig von GET /me bauen ihre Antwort aus DERSELBEN
  // Zeile. Ein zweiter SELECT ohne das Flag gaebe dem Token-Weg eine andere
  // Antwort, obwohl die Session-Tests darueber gruen blieben.
  const authSrc = readFileSync(new URL('../server/auth.js', import.meta.url), 'utf8');
  const start = authSrc.indexOf("router.get('/me',");
  const body = authSrc.slice(start, authSrc.indexOf('\nrouter.', start + 10));
  const selects = body.match(/SELECT \$\{USER_PUBLIC_COLUMNS\}[^`]*/g) ?? [];
  assert.equal(selects.length, 1, 'GET /me liest das Konto genau einmal');
  assert.match(selects[0], /AS sso_only/);
  assert.match(body, /if \(req\.authMethod === 'api_token'\)[\s\S]*?publicUser\(user\)/);
});

// --------------------------------------------------------------------------
// (2) Die Seite.
// --------------------------------------------------------------------------

test('ohne Passwort keine Passwort-Karte', () => {
  assert.equal(account.passwordCardHtml({ sso_only: true }), '');
});

test('die Seite zeichnet die Karte ueber diese Entscheidung, nicht daneben', () => {
  // Der Helfer kann richtig entscheiden, waehrend renderPage ihn gar nicht
  // fragt - dann stuende die Karte weiter fest im Template.
  const pageSrc = readFileSync(new URL('../public/settings/pages/personal-account.js', import.meta.url), 'utf8');
  const render = pageSrc.slice(pageSrc.indexOf('function renderPage('));
  const tpl = render.slice(0, render.indexOf('\nfunction '));
  assert.match(tpl, /\$\{passwordCardHtml\(user\)\}/);
  assert.equal((pageSrc.match(/<form id="password-form"/g) ?? []).length, 1,
    'das Formular steht genau einmal in der Datei - im Helfer');
});

test('mit Passwort bleibt die Karte, samt Formular und aktuellem Passwort', () => {
  for (const user of [{ sso_only: false }, {}, null, undefined]) {
    const html = account.passwordCardHtml(user);
    assert.match(html, /<form id="password-form"/, JSON.stringify(user));
    assert.match(html, /id="current-password"/, JSON.stringify(user));
  }
});

// --------------------------------------------------------------------------
// (3) Was die Seite sonst noch ueber das Passwort sagt.
// --------------------------------------------------------------------------

const { SETTINGS_LEAVES, settingsLeafDescription } = await import('../public/settings/registry.js');
const de = JSON.parse(readFileSync(new URL('../public/locales/de.json', import.meta.url), 'utf8'));

test('die Unterzeile nennt fuer ein Konto ohne Passwort kein Passwort', () => {
  const leaf = SETTINGS_LEAVES.find((l) => l.id === 'personal-account');
  const key = (k) => k;
  assert.equal(settingsLeafDescription(leaf, key, { sso_only: true }), 'settings.pageAccountDescriptionSsoOnly');
  for (const user of [{ sso_only: false }, {}, null, undefined]) {
    assert.equal(settingsLeafDescription(leaf, key, user), 'settings.pageAccountDescription', JSON.stringify(user));
  }
  // Ein anderes Blatt bleibt unberuehrt, auch fuer ein SSO-Konto.
  const other = SETTINGS_LEAVES.find((l) => l.id === 'personal-appearance');
  assert.equal(settingsLeafDescription(other, key, { sso_only: true }), other.descriptionKey);
  assert.equal(typeof de.settings.pageAccountDescriptionSsoOnly, 'string');
  assert.doesNotMatch(de.settings.pageAccountDescriptionSsoOnly, /Passwort/);
  assert.match(de.settings.pageAccountDescription, /Passwort/);
});

test('Kopf und Uebersichtszeile der Einstellungen reichen das Konto an die Unterzeile weiter', () => {
  // Die Regel kann stimmen, waehrend die Shell sie ohne Konto aufruft - dann
  // stuende dort weiter die Fassung mit Passwort.
  const shellSrc = readFileSync(new URL('../public/settings/shell.js', import.meta.url), 'utf8');
  const calls = shellSrc.match(/settingsLeafDescription\([^)]*\)/g) ?? [];
  assert.ok(calls.length >= 2);
  for (const call of calls) assert.match(call, /, user\)$/, call);
  assert.match(shellSrc, /createLeafHeader\(leaf, user\)/);
  assert.match(shellSrc, /createOverviewRow\(entry, user\)/);
});

test('der Hinweis beim Loesen schickt ein Konto ohne Passwort zum Administrator', () => {
  // Der Satz erscheint nur, wenn `can_unlink` falsch ist - und das ist er fuer
  // ein verknuepftes Konto genau dann, wenn es kein Passwort hat. "Setze
  // zuerst ein Passwort" zeigte auf ein Formular, das es fuer dieses Konto
  // nicht mehr gibt.
  const text = de.settings.oidcUnlinkNeedsPassword;
  assert.match(text, /Administrator/);
  assert.doesNotMatch(text, /^Setze zuerst/);
});
