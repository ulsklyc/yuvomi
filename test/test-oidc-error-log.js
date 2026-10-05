/**
 * Test: Das Log nennt, WARUM der Anbieter die SSO-Anmeldung abgelehnt hat (#1675)
 * Zweck: Lehnt der Token-Endpunkt die Anfrage ab, wirft `oauth4webapi` einen
 *        `ResponseBodyError` mit der immer gleichen Meldung "server responded
 *        with an error in the response body". Die Auskunft - `invalid_client`
 *        oder `invalid_grant`, dazu der Text des Anbieters - steht in den
 *        Feldern daneben, und der Logger schrieb von einem Error nur `name`,
 *        `message` und `stack`. Der Betreiber sah einen Stacktrace und konnte
 *        seine Konfiguration nicht einordnen.
 *
 * Gefahren wird die echte Strecke `/oidc/start` -> `/oidc/callback` mit dem
 * ECHTEN `openid-client`: nur `fetch` zum Anbieter ist ersetzt, damit die
 * Fehlerklasse die ist, die in Produktion faellt, und nicht eine nachgebaute.
 * Nebenbei haelt der Test fest, was am Token-Endpunkt ankommt (Basic-Auth,
 * `redirect_uri` aus der Konfiguration statt aus dem Host-Header, PKCE).
 *
 * Ausfuehren: node --experimental-sqlite --test test/test-oidc-error-log.js
 */
process.env.SESSION_SECRET = process.env.SESSION_SECRET || 'oidc-error-log-test-secret';
process.env.DB_PATH = ':memory:';
delete process.env.SESSION_SECURE;
delete process.env.NODE_ENV;
delete process.env.LOG_LEVEL;
process.env.OIDC_ISSUER = 'https://idp.test/application/o/yuvomi/';
process.env.OIDC_CLIENT_ID = 'yuvomi-client';
process.env.OIDC_CLIENT_SECRET = 'geheim-nicht-ins-log';
process.env.OIDC_REDIRECT_URI = 'https://home.test/api/v1/auth/oidc/callback';

import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';

const realFetch = globalThis.fetch;

/** Was der Token-Endpunkt beim naechsten Tausch antwortet, und was er bekam. */
let tokenAnswer = () => Response.json({ error: 'invalid_request' }, { status: 400 });
let tokenRequest = null;
let discoveryFails = null;

const ISSUER = process.env.OIDC_ISSUER;
globalThis.fetch = async (input, init) => {
  const url = String(input?.url ?? input);
  if (!url.startsWith('https://idp.test/')) return realFetch(input, init);
  if (url.endsWith('/.well-known/openid-configuration')) {
    if (discoveryFails) throw discoveryFails;
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
    tokenRequest = {
      authorization: new Headers(init?.headers).get('authorization'),
      body: new URLSearchParams(String(init?.body)),
    };
    return tokenAnswer();
  }
  return new Response('not found', { status: 404 });
};

const { router: authRouter, sessionMiddleware } = await import('../server/auth.js');
const { describeOidcError, resetClient } = await import('../server/services/oidc.js');

const app = express();
app.use(express.json());
app.use(sessionMiddleware);
app.use('/api/v1/auth', authRouter);
const server = app.listen(0, '127.0.0.1');
const base = await new Promise((resolve) => server.on('listening', () => resolve(`http://127.0.0.1:${server.address().port}`)));
test.after(() => { server.close(); globalThis.fetch = realFetch; });

/** Faengt ab, was der Logger als Fehler ausgibt (Entwicklungsmodus: console.error). */
async function captureErrors(run) {
  const original = console.error;
  const lines = [];
  console.error = (...args) => { lines.push(args); };
  try {
    return { result: await run(), lines };
  } finally {
    console.error = original;
  }
}

function cookiesOf(res) {
  return res.headers.getSetCookie().map((c) => c.split(';')[0]).join('; ');
}

/** Faehrt `/oidc/start` und den Callback mit dem dort vergebenen state. */
async function ssoRoundTrip() {
  const start = await realFetch(`${base}/api/v1/auth/oidc/start`, { redirect: 'manual' });
  assert.equal(start.status, 302, 'Vorbedingung: /oidc/start leitet zum Anbieter');
  const authorize = new URL(start.headers.get('location'));
  const state = authorize.searchParams.get('state');
  const callback = await realFetch(`${base}/api/v1/auth/oidc/callback?code=einmal-code-nicht-ins-log&state=${state}`, {
    redirect: 'manual',
    headers: { cookie: cookiesOf(start), 'x-forwarded-proto': 'http', 'x-forwarded-host': 'intern.lan' },
  });
  return { authorize, location: callback.headers.get('location') };
}

const oidcLine = (lines) => lines.find((args) => String(args[1]).startsWith('OIDC callback error'));

test('abgelehnte Token-Anfrage: das Log nennt error, error_description und status', async () => {
  tokenAnswer = () => Response.json(
    { error: 'invalid_client', error_description: 'Client authentication failed' },
    { status: 400 },
  );
  const { result, lines } = await captureErrors(ssoRoundTrip);
  assert.equal(result.location, '/login?error=oidc_failed', 'Vorbedingung: die Anmeldung scheitert am Token-Endpunkt');

  const line = oidcLine(lines);
  assert.ok(line, 'der Callback loggt den Fehler');
  const detail = line[2];
  assert.deepEqual(
    { name: detail.name, error: detail.error, error_description: detail.error_description, status: detail.status },
    { name: 'ResponseBodyError', error: 'invalid_client', error_description: 'Client authentication failed', status: 400 },
  );
  assert.equal(typeof detail.stack, 'string', 'der Stacktrace bleibt');
});

test('das Log traegt weder Secret noch Code, Verifier oder Authorization-Header', async () => {
  tokenAnswer = () => Response.json({ error: 'invalid_grant', error_description: 'x'.repeat(5000) }, { status: 400 });
  const { lines } = await captureErrors(ssoRoundTrip);
  const detail = oidcLine(lines)[2];
  const text = JSON.stringify(detail);

  assert.equal(detail.error, 'invalid_grant');
  assert.ok(detail.error_description.length <= 300, 'ein Text des Anbieters ist gekappt');
  assert.ok(!('response' in detail), 'die Antwort samt Anfrage haengt nicht am Logeintrag');
  for (const secret of [
    process.env.OIDC_CLIENT_SECRET,
    'einmal-code-nicht-ins-log',
    tokenRequest.body.get('code_verifier'),
    tokenRequest.authorization,
    tokenRequest.authorization.split(' ')[1],
  ]) {
    assert.ok(secret && !text.includes(secret), `"${secret}" steht nicht im Log`);
  }
});

test('ein 401 mit WWW-Authenticate nennt die Fehlerparameter der Challenge', async () => {
  tokenAnswer = () => new Response('', {
    status: 401,
    headers: { 'www-authenticate': 'Basic realm="idp", error="invalid_client", error_description="unknown client"' },
  });
  const { lines } = await captureErrors(ssoRoundTrip);
  const detail = oidcLine(lines)[2];
  assert.equal(detail.status, 401);
  assert.deepEqual(detail.challenges, [{ scheme: 'basic', error: 'invalid_client', error_description: 'unknown client' }]);
});

test('was am Token-Endpunkt ankommt: Basic-Auth, redirect_uri aus der Konfiguration, PKCE', async () => {
  tokenAnswer = () => Response.json({ error: 'invalid_grant' }, { status: 400 });
  const { result } = await captureErrors(ssoRoundTrip);

  assert.equal(result.authorize.searchParams.get('redirect_uri'), process.env.OIDC_REDIRECT_URI);
  assert.equal(
    tokenRequest.body.get('redirect_uri'), process.env.OIDC_REDIRECT_URI,
    'Schema und Host kommen aus OIDC_REDIRECT_URI, nicht aus Host- oder X-Forwarded-Headern',
  );
  assert.equal(tokenRequest.body.get('grant_type'), 'authorization_code');
  assert.ok(tokenRequest.body.get('code_verifier'), 'PKCE-Verifier geht mit');
  assert.equal(tokenRequest.body.get('client_secret'), null, 'das Secret steht nicht im Formular (client_secret_basic)');
  // RFC 6749 2.3.1: beide Teile werden vor dem Base64 formular-kodiert, und
  // oauth4webapi kodiert dabei auch `-`, `_` und `.` - ein Anbieter, der das
  // nicht zurueckdekodiert, sieht eine andere Client-ID.
  assert.equal(
    Buffer.from(tokenRequest.authorization.replace(/^Basic /, ''), 'base64').toString(),
    'yuvomi%2Dclient:geheim%2Dnicht%2Dins%2Dlog',
  );
});

test('scheitert schon die Discovery, nennt das Log den Netzwerkfehler darunter', async () => {
  resetClient();
  const tls = Object.assign(new Error('unable to verify the first certificate'), { code: 'UNABLE_TO_VERIFY_LEAF_SIGNATURE' });
  discoveryFails = new TypeError('fetch failed', { cause: tls });
  try {
    const { result, lines } = await captureErrors(() => realFetch(`${base}/api/v1/auth/oidc/start`, { redirect: 'manual' }));
    assert.equal(result.status, 500);
    const line = lines.find((args) => String(args[1]).startsWith('OIDC start error'));
    assert.deepEqual(line[2].cause, {
      name: 'Error',
      message: 'unable to verify the first certificate',
      code: 'UNABLE_TO_VERIFY_LEAF_SIGNATURE',
    });
  } finally {
    discoveryFails = null;
    resetClient();
  }
});

test('describeOidcError: ein gewoehnlicher Fehler bleibt name, message und stack', () => {
  const detail = describeOidcError(new RangeError('kaputt'));
  assert.deepEqual(Object.keys(detail), ['name', 'message', 'stack']);
  assert.deepEqual(describeOidcError('nur text'), { message: 'nur text' });
});
