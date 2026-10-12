/**
 * Test: Die Token-Anfrage sendet die redirect_uri der Authorize-Anfrage woertlich (#1768)
 * Zweck: RFC 6749, 4.1.3 verlangt vom Anbieter, einen Code-Tausch abzulehnen,
 *        dessen `redirect_uri` nicht identisch mit der aus der Authorize-Anfrage
 *        ist. Die Authorize-Anfrage trug `OIDC_REDIRECT_URI` wie geschrieben,
 *        der Tausch aber `new URL(req.originalUrl, OIDC_REDIRECT_URI)` ohne
 *        Query: die NORMALISIERTE Herkunft der Variable mit dem Pfad der
 *        eingehenden Anfrage. Ein ausgeschriebener Standardport, Grossbuchstaben
 *        im Hostnamen, eine eigene Query oder ein Pfad, den der Reverse Proxy
 *        umschreibt, machten daraus zwei verschiedene Werte - und die Anmeldung
 *        scheiterte nach dem erfolgreichen Login beim Anbieter mit `invalid_grant`.
 *
 * Gefahren wird die echte Strecke `/oidc/start` -> `/oidc/callback` (und der
 * Verknuepfungs-Lauf ab `/oidc/link/start`) mit dem ECHTEN `openid-client`
 * gegen einen nachgestellten Anbieter: ersetzt ist nur `fetch` zu ihm. Geprueft
 * wird, was an seinem Token-Endpunkt ANKOMMT, nicht der Quelltext.
 *
 * `test:oidc-error-log` haelt denselben Vergleich mit einer Variable in
 * Normalform und einem Callback-Pfad, der dem der Variable gleicht - dort sind
 * beide Seiten per Bauart gleich. Hier stehen die Faelle, in denen sie es nicht
 * sind.
 *
 * Ausfuehren: node --experimental-sqlite --test test/test-oidc-redirect-uri.js
 */
process.env.SESSION_SECRET = process.env.SESSION_SECRET || 'oidc-redirect-uri-test-secret';
process.env.DB_PATH = ':memory:';
delete process.env.SESSION_SECURE;
delete process.env.NODE_ENV;
delete process.env.LOG_LEVEL;
process.env.OIDC_ISSUER = 'https://idp.test/application/o/yuvomi/';
process.env.OIDC_CLIENT_ID = 'yuvomi-client';
process.env.OIDC_CLIENT_SECRET = 'geheim';

const NORMAL = 'https://home.test/api/v1/auth/oidc/callback';
process.env.OIDC_REDIRECT_URI = NORMAL;

import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';

const realFetch = globalThis.fetch;

/** Jede Anfrage an den Token-Endpunkt des Anbieters, in Ankunftsreihenfolge. */
let tokenRequests = [];
/** Haelt die Antworten des Token-Endpunkts zurueck, bis der Test sie freigibt. */
let tokenGate = null;

const ISSUER = process.env.OIDC_ISSUER;
globalThis.fetch = async (input, init) => {
  const url = String(input?.url ?? input);
  if (!url.startsWith('https://idp.test/')) return realFetch(input, init);
  if (url.endsWith('/.well-known/openid-configuration')) {
    return Response.json({
      issuer: ISSUER,
      authorization_endpoint: `${ISSUER}authorize/`,
      token_endpoint: `${ISSUER}token/`,
      userinfo_endpoint: `${ISSUER}userinfo/`,
      jwks_uri: `${ISSUER}jwks/`,
      response_types_supported: ['code'],
      subject_types_supported: ['public'],
      id_token_signing_alg_values_supported: ['RS256'],
    });
  }
  if (url === `${ISSUER}token/`) {
    tokenRequests.push(new URLSearchParams(String(init?.body)));
    if (tokenGate) await tokenGate.promise;
    // Der Anbieter lehnt ab: geprueft wird, was er BEKAM. Ein gueltiges
    // ID-Token braeuchte einen Signaturschluessel und aenderte daran nichts.
    return Response.json({ error: 'invalid_grant' }, { status: 400 });
  }
  return new Response('not found', { status: 404 });
};

const dbmod = await import('../server/db.js');
const { router: authRouter, sessionMiddleware } = await import('../server/auth.js');
const { getConfig, exchangeAuthorizationCode } = await import('../server/services/oidc.js');
const oidcClient = await import('openid-client');
const database = dbmod.get();

const MEMBER = Number(database.prepare(`
  INSERT INTO users (username, display_name, password_hash, role)
  VALUES ('redirect-uri-member', 'Mitglied', 'x', 'member')
`).run().lastInsertRowid);
const CSRF = 'ab'.repeat(32);

const app = express();
app.use(express.json());
app.use(sessionMiddleware);
// Meldet das Mitglied an, wie es `setupAuthSession` tut - der Verknuepfungs-Lauf
// beginnt angemeldet und mit CSRF-Token.
app.post('/__test/sign-in', (req, res) => {
  req.session.userId = MEMBER;
  req.session.role = 'member';
  req.session.csrfToken = CSRF;
  req.session.save(() => res.json({ ok: true }));
});
// Stellt einen Lauf nach, der VOR dem Update begonnen hat: sein Session-State
// kennt die redirect_uri der Authorize-Anfrage noch nicht.
app.post('/__test/forget-redirect-uri', (req, res) => {
  delete req.session.oidc.redirectUri;
  req.session.save(() => res.json({ ok: true }));
});
app.use('/api/v1/auth', authRouter);
// Derselbe Router unter einem zweiten Pfad: so sieht Express die Anfrage, wenn
// der Reverse Proxy den Pfad umschreibt oder ein Praefix davorsetzt.
app.use('/hinter-dem-proxy/auth', authRouter);
const server = app.listen(0, '127.0.0.1');
const base = await new Promise((resolve) => server.on('listening', () => resolve(`http://127.0.0.1:${server.address().port}`)));
test.after(() => { server.close(); globalThis.fetch = realFetch; });

const PLAIN_PATH = '/api/v1/auth/oidc/callback';
const REWRITTEN_PATH = '/hinter-dem-proxy/auth/oidc/callback';

function cookiesOf(res) {
  return res.headers.getSetCookie().map((c) => c.split(';')[0]).join('; ');
}

/** Der Logger schreibt Warnungen und Fehler auf die Konsole; im Test gehoeren sie nicht in die Ausgabe. */
async function quiet(run) {
  const { error, warn } = console;
  console.error = () => {};
  console.warn = () => {};
  try {
    return await run();
  } finally {
    console.error = error;
    console.warn = warn;
  }
}

/** Faehrt `/oidc/start` mit der gegebenen Variable und liefert Authorize-URL und Cookie. */
async function startFlow(redirectUri) {
  process.env.OIDC_REDIRECT_URI = redirectUri;
  const start = await realFetch(`${base}/api/v1/auth/oidc/start`, { redirect: 'manual' });
  assert.equal(start.status, 302, 'Vorbedingung: /oidc/start leitet zum Anbieter');
  return { authorize: new URL(start.headers.get('location')), cookie: cookiesOf(start) };
}

/** Der Rueckweg vom Anbieter, wie er bei Express ankommt. */
function callback({ authorize, cookie }, { path = PLAIN_PATH, code = 'einmal-code' } = {}) {
  const state = authorize.searchParams.get('state');
  return realFetch(`${base}${path}?code=${code}&state=${state}`, {
    redirect: 'manual',
    headers: { cookie, 'x-forwarded-proto': 'http', 'x-forwarded-host': 'intern.lan' },
  });
}

test.beforeEach(() => {
  tokenRequests = [];
  tokenGate = null;
  process.env.OIDC_REDIRECT_URI = NORMAL;
});

const CASES = [
  {
    name: 'Standardport und Grossbuchstaben im Host, Pfad vom Proxy umgeschrieben (Abnahmefall #1768)',
    redirectUri: 'https://Home.test:443/api/v1/auth/oidc/callback',
    path: REWRITTEN_PATH,
  },
  {
    name: 'nur der ausgeschriebene Standardport',
    redirectUri: 'https://home.test:443/api/v1/auth/oidc/callback',
    path: PLAIN_PATH,
  },
  {
    name: 'nur Grossbuchstaben im Hostnamen',
    redirectUri: 'https://Home.Test/api/v1/auth/oidc/callback',
    path: PLAIN_PATH,
  },
  {
    name: 'nur der Pfad: Variable in Normalform, der Proxy schreibt den Pfad um',
    redirectUri: NORMAL,
    path: REWRITTEN_PATH,
  },
  {
    name: 'eine eigene Query in der registrierten Redirect-URI',
    redirectUri: 'https://home.test/api/v1/auth/oidc/callback?tenant=zuhause',
    path: PLAIN_PATH,
  },
  {
    name: 'ein Schraegstrich am Ende, den der Proxy abschneidet',
    redirectUri: 'https://home.test/api/v1/auth/oidc/callback/',
    path: PLAIN_PATH,
  },
];

for (const { name, redirectUri, path } of CASES) {
  test(`Authorize- und Token-Anfrage tragen dieselbe redirect_uri: ${name}`, async () => {
    const flow = await startFlow(redirectUri);
    const res = await quiet(() => callback(flow, { path }));

    assert.equal(res.headers.get('location'), '/login?error=oidc_failed', 'Vorbedingung: der Tausch erreicht den Anbieter und wird dort abgelehnt');
    assert.equal(tokenRequests.length, 1, 'Vorbedingung: genau eine Token-Anfrage');
    assert.deepEqual(
      { authorize: flow.authorize.searchParams.get('redirect_uri'), token: tokenRequests[0].get('redirect_uri') },
      { authorize: redirectUri, token: redirectUri },
      'beide Anfragen tragen OIDC_REDIRECT_URI Zeichen fuer Zeichen',
    );
    assert.equal(tokenRequests[0].get('code'), 'einmal-code', 'der Code kommt weiter aus der eingehenden Anfrage');
    assert.equal(tokenRequests[0].get('grant_type'), 'authorization_code');
    assert.ok(tokenRequests[0].get('code_verifier'), 'PKCE-Verifier geht mit');
  });
}

test('der Verknuepfungs-Lauf traegt dieselbe redirect_uri in beiden Anfragen', async () => {
  const redirectUri = 'https://Home.test:443/api/v1/auth/oidc/callback';
  process.env.OIDC_REDIRECT_URI = redirectUri;

  const signIn = await realFetch(`${base}/__test/sign-in`, { method: 'POST' });
  const cookie = cookiesOf(signIn);
  const start = await realFetch(`${base}/api/v1/auth/oidc/link/start`, {
    method: 'POST',
    headers: { cookie, 'x-csrf-token': CSRF },
  });
  assert.equal(start.status, 200, 'Vorbedingung: der Verknuepfungs-Lauf startet');
  const authorize = new URL((await start.json()).url);

  const res = await quiet(() => callback({ authorize, cookie }, { path: REWRITTEN_PATH }));
  assert.equal(res.headers.get('location'), '/login?error=oidc_failed', 'Vorbedingung: der Tausch erreicht den Anbieter');
  assert.deepEqual(
    { authorize: authorize.searchParams.get('redirect_uri'), token: tokenRequests[0]?.get('redirect_uri') },
    { authorize: redirectUri, token: redirectUri },
  );
});

test('gilt der Wert des Laufs, nicht der Variable zum Zeitpunkt des Rueckwegs', async () => {
  const atStart = 'https://alt.test:443/api/v1/auth/oidc/callback';
  const flow = await startFlow(atStart);
  // Die Sitzung liegt in der Datenbank und ueberlebt einen Neustart mit
  // geaenderter Konfiguration; der Anbieter kennt aber nur den Wert vom Start.
  process.env.OIDC_REDIRECT_URI = 'https://neu.test/api/v1/auth/oidc/callback';
  await quiet(() => callback(flow));

  assert.equal(flow.authorize.searchParams.get('redirect_uri'), atStart);
  assert.equal(tokenRequests[0]?.get('redirect_uri'), atStart);
});

// Misst, dass der Wert an der SITZUNG haengt: zwei Rueckwege warten zugleich am
// Token-Endpunkt. Verschraenkt sind sie dabei NICHT - mit `client_secret_basic`
// liegen zwischen dem Festhalten des Werts und dem `fetch` nur Mikrotasks, die
// zweite Anfrage kommt nie dazwischen. Dass der Wert je AUFRUF reist und nicht
// ueber geteilten Zustand, belegt erst der naechste Test.
test('zwei Rueckwege, die zugleich am Token-Endpunkt warten, tragen je die redirect_uri ihrer Sitzung', async () => {
  const first = 'https://Eins.test:443/api/v1/auth/oidc/callback';
  const second = 'https://Zwei.test:443/api/v1/auth/oidc/callback';
  const flowA = await startFlow(first);
  const flowB = await startFlow(second);

  // Beide Tausche stehen gleichzeitig am Token-Endpunkt, bevor einer endet.
  let release;
  tokenGate = { promise: new Promise((resolve) => { release = resolve; }) };
  const pending = quiet(() => Promise.all([
    callback(flowA, { code: 'code-eins' }),
    callback(flowB, { code: 'code-zwei' }),
  ]));
  const deadline = Date.now() + 5000;
  while (tokenRequests.length < 2 && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  release();
  await pending;

  const sent = Object.fromEntries(tokenRequests.map((body) => [body.get('code'), body.get('redirect_uri')]));
  assert.deepEqual(sent, { 'code-eins': first, 'code-zwei': second });
});

test('verschraenkte Tausche: der Wert reist je Aufruf, nicht ueber geteilten Zustand', async () => {
  // Tausch A haelt seinen Wert schon fest und wartet VOR dem Bau der
  // Token-Anfrage, waehrend Tausch B seinen eigenen festhaelt und ganz
  // durchlaeuft. Im ausgelieferten Ablauf gibt es diese Pause nicht (siehe
  // oben); sie entsteht, sobald die Client-Authentifizierung wirklich wartet
  // (private_key_jwt, DPoP) oder die Bibliothek dort einen Schritt einfuegt.
  // Ein Wert in einer Modulvariable statt im AsyncLocalStorage schickte dann
  // fuer A die redirect_uri von B hinaus - gefahren als Gegenprobe.
  //
  // Echt sind `exchangeAuthorizationCode`, der `fetch`-Haken aus `getConfig()`
  // und `openid-client`; eigen ist nur die Client-Authentifizierung, eine
  // Funktion, wie die Bibliothek sie als `ClientAuth` vorsieht.
  const first = 'https://Eins.test:443/api/v1/auth/oidc/callback';
  const second = 'https://Zwei.test:443/api/v1/auth/oidc/callback';

  let aEntered;
  const aIsWaiting = new Promise((resolve) => { aEntered = resolve; });
  let releaseA;
  const aMayGo = new Promise((resolve) => { releaseA = resolve; });
  const waitingAuth = async (_as, _client, body) => {
    if (body.get('code') !== 'code-eins') return;
    aEntered();
    await aMayGo;
  };

  const shipped = await getConfig();
  const config = new oidcClient.Configuration(shipped.serverMetadata(), 'yuvomi-client', undefined, waitingAuth);
  config[oidcClient.customFetch] = shipped[oidcClient.customFetch];
  assert.equal(typeof config[oidcClient.customFetch], 'function', 'Vorbedingung: der Haken der ausgelieferten Configuration geht mit');

  const exchange = (redirectUri, code) => exchangeAuthorizationCode(config, {
    redirectUri,
    query: `?code=${code}&state=s`,
    checks: { expectedState: 's', expectedNonce: 'n', pkceCodeVerifier: 'v'.repeat(43) },
  }).catch((err) => err);

  const a = exchange(first, 'code-eins');
  await aIsWaiting;
  assert.equal(tokenRequests.length, 0, 'Vorbedingung: A wartet vor seiner Token-Anfrage');
  await exchange(second, 'code-zwei');
  assert.equal(tokenRequests.length, 1, 'Vorbedingung: B ist ganz durchgelaufen, waehrend A wartet');
  releaseA();
  await a;

  const sent = Object.fromEntries(tokenRequests.map((body) => [body.get('code'), body.get('redirect_uri')]));
  assert.deepEqual(sent, { 'code-zwei': second, 'code-eins': first });
});

test('ein Lauf ohne festgehaltene redirect_uri wird abgewiesen, nicht mit einem geratenen Wert getauscht', async () => {
  const flow = await startFlow('https://Home.test:443/api/v1/auth/oidc/callback');
  const forget = await realFetch(`${base}/__test/forget-redirect-uri`, { method: 'POST', headers: { cookie: flow.cookie } });
  assert.equal(forget.status, 200, 'Vorbedingung: der Session-State ist ohne redirect_uri gespeichert');

  const res = await quiet(() => callback(flow));
  assert.deepEqual(
    { location: res.headers.get('location'), tokenRequests: tokenRequests.length },
    { location: '/login?error=oidc_state_mismatch', tokenRequests: 0 },
  );

  // Der Lauf ist verbraucht: ein zweiter Rueckweg mit demselben state findet nichts mehr.
  const again = await quiet(() => callback(flow));
  assert.equal(again.headers.get('location'), '/login?error=oidc_state_mismatch');
  assert.equal(tokenRequests.length, 0);
});

test('eine Variable in Normalform mit dem eigenen Pfad bleibt, was sie war', async () => {
  const flow = await startFlow(NORMAL);
  await quiet(() => callback(flow));
  assert.equal(flow.authorize.searchParams.get('redirect_uri'), NORMAL);
  assert.equal(tokenRequests[0]?.get('redirect_uri'), NORMAL);
});
