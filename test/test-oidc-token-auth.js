/**
 * Test: Wie sich Yuvomi am Token-Endpunkt ausweist (#2144)
 * Zweck: Gitea lehnte den Code-Tausch mit `invalid_client` ab und nannte die
 *        Client-ID mit `%2D` statt `-`. `ClientSecretBasic` aus
 *        `openid-client`/`oauth4webapi` kodiert ID und Secret vor dem Base64
 *        strenger als das Formularformat (auch `-`, `_`, `.`, `~`), und ein
 *        Anbieter, der den Header nicht zurueckdekodiert, sieht eine andere ID.
 *
 * Gefahren ueber `getConfig()` und `exchangeAuthorizationCode()` mit dem ECHTEN
 * `openid-client` - ersetzt ist nur `fetch` zum Anbieter. Geprueft wird, was am
 * Token-Endpunkt ANKOMMT:
 * - Basic: ID und Secret aus Buchstaben, Ziffern und `-._*` stehen woertlich im
 *   Header; alles andere bleibt formular-kodiert und dekodiert zum Original.
 * - `OIDC_TOKEN_AUTH_METHOD=client_secret_post`: kein Authorization-Header,
 *   ID und Secret im Formular.
 * - ohne Schalter: Basic, ausser der Anbieter bietet ausdruecklich nur `post`.
 * - der Schalter schlaegt das Discovery-Dokument; ein unbekannter Wert scheitert
 *   mit seinem Namen, bevor eine Anfrage hinausgeht.
 *
 * Ausfuehren: node --test test/test-oidc-token-auth.js
 */
process.env.OIDC_ISSUER = 'https://idp.test/';
process.env.OIDC_CLIENT_ID = 'a7f39c21-6b84-4e0d-9c52-f18d6a730b45';
process.env.OIDC_CLIENT_SECRET = 'gto_abc.def-ghi_jkl~mno';
process.env.OIDC_REDIRECT_URI = 'https://home.test/api/v1/auth/oidc/callback';
delete process.env.OIDC_TOKEN_AUTH_METHOD;

import test from 'node:test';
import assert from 'node:assert/strict';

const realFetch = globalThis.fetch;
const ISSUER = process.env.OIDC_ISSUER;

/** `token_endpoint_auth_methods_supported` der naechsten Discovery; undefined = nicht genannt. */
let advertised;
let tokenRequest = null;
let requests = 0;

globalThis.fetch = async (input, init) => {
  const url = String(input?.url ?? input);
  if (!url.startsWith(ISSUER)) return realFetch(input, init);
  requests += 1;
  if (url.endsWith('/.well-known/openid-configuration')) {
    return Response.json({
      issuer: ISSUER,
      authorization_endpoint: `${ISSUER}authorize`,
      token_endpoint: `${ISSUER}token`,
      jwks_uri: `${ISSUER}jwks`,
      response_types_supported: ['code'],
      subject_types_supported: ['public'],
      id_token_signing_alg_values_supported: ['RS256'],
      ...(advertised ? { token_endpoint_auth_methods_supported: advertised } : {}),
    });
  }
  if (url === `${ISSUER}token`) {
    tokenRequest = {
      authorization: new Headers(init?.headers).get('authorization'),
      body: new URLSearchParams(String(init?.body)),
    };
    return Response.json({ error: 'invalid_grant' }, { status: 400 });
  }
  return new Response('not found', { status: 404 });
};
test.after(() => { globalThis.fetch = realFetch; });

const { getConfig, exchangeAuthorizationCode, resetClient } = await import('../server/services/oidc.js');

/** Faehrt einen Code-Tausch unter den gegebenen Bedingungen und gibt zurueck, was ankam. */
async function exchange({ method, supported, clientId, clientSecret } = {}) {
  resetClient();
  tokenRequest = null;
  advertised = supported;
  const saved = { id: process.env.OIDC_CLIENT_ID, secret: process.env.OIDC_CLIENT_SECRET };
  if (method === undefined) delete process.env.OIDC_TOKEN_AUTH_METHOD;
  else process.env.OIDC_TOKEN_AUTH_METHOD = method;
  if (clientId) process.env.OIDC_CLIENT_ID = clientId;
  if (clientSecret) process.env.OIDC_CLIENT_SECRET = clientSecret;
  try {
    const config = await getConfig();
    await assert.rejects(
      exchangeAuthorizationCode(config, {
        redirectUri: process.env.OIDC_REDIRECT_URI,
        query: '?code=einmal&state=s1',
        checks: { expectedState: 's1', pkceCodeVerifier: 'v'.repeat(43) },
      }),
      (err) => err.error === 'invalid_grant',
      'Vorbedingung: die Token-Anfrage erreicht den Endpunkt',
    );
    assert.ok(tokenRequest, 'Vorbedingung: die Token-Anfrage wurde gesendet');
    return tokenRequest;
  } finally {
    process.env.OIDC_CLIENT_ID = saved.id;
    process.env.OIDC_CLIENT_SECRET = saved.secret;
    delete process.env.OIDC_TOKEN_AUTH_METHOD;
    resetClient();
  }
}

function basicParts(authorization) {
  assert.match(authorization ?? '', /^Basic /, 'client_secret_basic sendet einen Basic-Header');
  return Buffer.from(authorization.replace(/^Basic /, ''), 'base64').toString('utf8');
}

test('Basic: eine UUID-Client-ID und ein Gitea-Secret stehen woertlich im Header (#2144)', async () => {
  const sent = await exchange();
  assert.equal(
    basicParts(sent.authorization),
    `${process.env.OIDC_CLIENT_ID}:gto_abc.def-ghi_jkl%7Emno`,
    '`-`, `_` und `.` bleiben, wie das Formularformat sie laesst; `~` wird kodiert',
  );
  assert.equal(sent.body.get('client_id'), null, 'Basic: die ID steht nicht zusaetzlich im Formular');
  assert.equal(sent.body.get('client_secret'), null, 'Basic: das Secret steht nicht im Formular');
});

test('Basic: Zeichen ausserhalb des Formular-Klartexts bleiben kodiert und dekodieren zum Original', async () => {
  const clientId = 'app:ein Client+Ü';
  const clientSecret = 's/e=c%r&e:t ~*';
  const sent = await exchange({ clientId, clientSecret });
  const raw = basicParts(sent.authorization);
  assert.equal(raw, 'app%3Aein+Client%2B%C3%9C:s%2Fe%3Dc%25r%26e%3At+%7E*');
  const [user, pass] = raw.split(':');
  const decode = (value) => new URLSearchParams(`v=${value}`).get('v');
  assert.deepEqual([decode(user), decode(pass)], [clientId, clientSecret],
    'ein Anbieter, der nach RFC 6749 2.3.1 dekodiert, bekommt genau die konfigurierten Werte');
});

test('OIDC_TOKEN_AUTH_METHOD=client_secret_post: ID und Secret im Formular, kein Basic-Header', async () => {
  const sent = await exchange({ method: 'client_secret_post' });
  assert.equal(sent.authorization, null);
  assert.equal(sent.body.get('client_id'), process.env.OIDC_CLIENT_ID);
  assert.equal(sent.body.get('client_secret'), process.env.OIDC_CLIENT_SECRET);
});

test('ohne Schalter: Basic, ausser der Anbieter bietet ausdruecklich nur client_secret_post', async () => {
  assert.match((await exchange()).authorization ?? '', /^Basic /,
    'nennt der Anbieter keine Methoden, gilt der Default aus RFC 8414 (Basic)');
  assert.match((await exchange({ supported: ['client_secret_post', 'client_secret_basic'] })).authorization ?? '', /^Basic /,
    'bietet er beide, bleibt es beim bisherigen Verhalten');
  const postOnly = await exchange({ supported: ['client_secret_post', 'private_key_jwt'] });
  assert.equal(postOnly.authorization, null, 'nur post angeboten: kein Basic-Header');
  assert.equal(postOnly.body.get('client_secret'), process.env.OIDC_CLIENT_SECRET);
});

test('der Schalter schlaegt das Discovery-Dokument', async () => {
  const basic = await exchange({ method: 'client_secret_basic', supported: ['client_secret_post'] });
  assert.match(basic.authorization ?? '', /^Basic /);
  const post = await exchange({ method: ' client_secret_post ', supported: ['client_secret_basic'] });
  assert.equal(post.authorization, null, 'Leerzeichen um den Wert stoeren nicht');
  assert.equal(post.body.get('client_id'), process.env.OIDC_CLIENT_ID);
});

test('ein unbekannter Wert scheitert mit dem Namen der Variable, bevor eine Anfrage hinausgeht', async () => {
  resetClient();
  process.env.OIDC_TOKEN_AUTH_METHOD = 'basic';
  const before = requests;
  try {
    await assert.rejects(getConfig(), /OIDC_TOKEN_AUTH_METHOD must be one of client_secret_basic, client_secret_post/);
    assert.equal(requests, before, 'keine Discovery mit ungueltigem Schalter');
  } finally {
    delete process.env.OIDC_TOKEN_AUTH_METHOD;
    resetClient();
  }
});
