/**
 * Modul: Home Assistant als Anmeldequelle
 * Zweck: Home Assistant spricht OAuth 2.0 (Authorization Code + PKCE, IndieAuth-
 *        artige Client-IDs), aber kein OpenID Connect: es gibt weder Discovery
 *        noch ID-Token noch Userinfo. Dieses Modul schliesst die Luecke fuer
 *        genau einen Zweck - festzustellen, WELCHER Home-Assistant-Benutzer sich
 *        gerade angemeldet hat - und liefert das Ergebnis in der Form, die der
 *        bestehende SSO-Ablauf in `auth.js` ohnehin verarbeitet (sub, iss, name).
 *
 *        Damit gilt fuer Home Assistant alles, was fuer OIDC gilt: Verknuepfen
 *        unter Einstellungen > Konto, `OIDC_ALLOW_SIGNUP`, SSO-only-Konten,
 *        `AUTH_ALLOW_PASSWORD_LOGIN=false`, zweiter Faktor, Schutz des letzten
 *        SSO-Admins.
 *
 * Konfiguration (Umgebung):
 *   HOMEASSISTANT_URL           Adresse, unter der der BROWSER Home Assistant
 *                               erreicht (Login-Seite), z. B. https://ha.example.com
 *   HOMEASSISTANT_INTERNAL_URL  optional: Adresse fuer die Server-Anfragen
 *                               (Token, WebSocket), z. B. http://homeassistant:8123
 *   OIDC_REDIRECT_URI           optional: Rueckweg; Standard ist
 *                               BASE_URL + /api/v1/auth/oidc/callback
 *
 * Home Assistant erkennt Clients an ihrer URL (client_id). Die Redirect-URI
 * muss auf demselben Host liegen, deshalb ist die client_id der Ursprung der
 * Redirect-URI. Eine Registrierung in Home Assistant ist nicht noetig.
 *
 * Nach dem Abfragen des Benutzers wird das Refresh-Token sofort widerrufen:
 * Yuvomi braucht keinen dauerhaften Zugriff auf Home Assistant, und jede
 * Anmeldung hinterliesse sonst ein gueltiges Token in Home Assistant.
 */

const CALLBACK_PATH = '/api/v1/auth/oidc/callback';
const REQUEST_TIMEOUT_MS = 10_000;

function trimSlash(url) {
  return String(url || '').trim().replace(/\/+$/, '');
}

/**
 * Die Redirect-URI des HA-Ablaufs, oder null, wenn sie sich nicht bestimmen laesst.
 * @returns {string|null}
 */
export function homeAssistantRedirectUri() {
  const explicit = (process.env.OIDC_REDIRECT_URI || '').trim();
  if (explicit) return explicit;
  const base = trimSlash(process.env.BASE_URL);
  return base ? `${base}${CALLBACK_PATH}` : null;
}

/**
 * Ist Home Assistant als Anmeldequelle konfiguriert?
 * Gelesen pro Aufruf (wie `isOidcEnabled`), damit Tests beide Zustaende fahren.
 * @returns {boolean}
 */
export function isHomeAssistantAuthConfigured() {
  if (!trimSlash(process.env.HOMEASSISTANT_URL)) return false;
  const redirectUri = homeAssistantRedirectUri();
  if (!redirectUri) return false;
  try {
    new URL(process.env.HOMEASSISTANT_URL);
    new URL(redirectUri);
    return true;
  } catch {
    return false;
  }
}

/**
 * Die Konfiguration des HA-Ablaufs. `homeassistant: true` unterscheidet sie in
 * `auth.js` von der `openid-client`-Configuration.
 */
export function getHomeAssistantConfig() {
  if (!isHomeAssistantAuthConfigured()) return null;
  const url = trimSlash(process.env.HOMEASSISTANT_URL);
  const internalUrl = trimSlash(process.env.HOMEASSISTANT_INTERNAL_URL) || url;
  const redirectUri = homeAssistantRedirectUri();
  return {
    homeassistant: true,
    url,
    internalUrl,
    redirectUri,
    clientId: `${new URL(redirectUri).origin}/`,
  };
}

/**
 * Baut die Authorize-URL der Home-Assistant-Anmeldeseite.
 */
export function buildHomeAssistantAuthorizationUrl(config, { redirectUri, state, codeChallenge }) {
  const url = new URL(`${config.url}/auth/authorize`);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('client_id', config.clientId);
  url.searchParams.set('redirect_uri', redirectUri);
  url.searchParams.set('state', state);
  url.searchParams.set('code_challenge', codeChallenge);
  url.searchParams.set('code_challenge_method', 'S256');
  return url.href;
}

function withTimeout(ms) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ms);
  return { signal: controller.signal, done: () => clearTimeout(timer) };
}

/**
 * Tauscht den Code gegen Tokens.
 * @returns {Promise<{access_token: string, refresh_token?: string}>}
 */
export async function exchangeHomeAssistantCode(config, { code, codeVerifier }) {
  const body = new URLSearchParams({
    grant_type: 'authorization_code',
    code,
    client_id: config.clientId,
    code_verifier: codeVerifier,
  });
  const t = withTimeout(REQUEST_TIMEOUT_MS);
  try {
    const res = await fetch(`${config.internalUrl}/auth/token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body,
      signal: t.signal,
      redirect: 'error',
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok || typeof data.access_token !== 'string') {
      const err = new Error(`Home Assistant token exchange failed (HTTP ${res.status})`);
      err.error = data.error;
      err.error_description = data.error_description;
      throw err;
    }
    return data;
  } finally {
    t.done();
  }
}

/**
 * Fragt ueber die WebSocket-API ab, wem das Access-Token gehoert.
 * @returns {Promise<{id: string, name: string, is_admin: boolean, is_owner: boolean}>}
 */
export function fetchHomeAssistantUser(config, accessToken) {
  const wsUrl = `${config.internalUrl.replace(/^http/, 'ws')}/api/websocket`;
  return new Promise((resolve, reject) => {
    let settled = false;
    const ws = new WebSocket(wsUrl);
    // WebSocket#send ist synchron; der eigene Name haelt es auseinander von den
    // async-`send()` der Benachrichtigungskanaele (test:after-response-jobs).
    const sendJson = (obj) => ws.send(JSON.stringify(obj));
    const finish = (fn, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try { ws.close(); } catch { /* bereits zu */ }
      fn(value);
    };
    const timer = setTimeout(
      () => finish(reject, new Error('Home Assistant did not answer in time.')),
      REQUEST_TIMEOUT_MS,
    );
    ws.addEventListener('error', () => finish(reject, new Error('Home Assistant WebSocket connection failed.')));
    ws.addEventListener('close', () => finish(reject, new Error('Home Assistant closed the WebSocket connection.')));
    ws.addEventListener('message', (event) => {
      let msg;
      try { msg = JSON.parse(String(event.data)); } catch { return; }
      if (msg.type === 'auth_required') {
        sendJson({ type: 'auth', access_token: accessToken });
      } else if (msg.type === 'auth_invalid') {
        finish(reject, new Error('Home Assistant rejected the access token.'));
      } else if (msg.type === 'auth_ok') {
        sendJson({ id: 1, type: 'auth/current_user' });
      } else if (msg.type === 'result' && msg.id === 1) {
        if (msg.success && msg.result?.id) finish(resolve, msg.result);
        else finish(reject, new Error('Home Assistant did not return the current user.'));
      }
    });
  });
}

/**
 * Widerruft das Refresh-Token (und damit alle daraus erzeugten Access-Tokens).
 * Fehler meldet der Aufrufer nur: die Anmeldung bei Yuvomi haengt nicht davon ab.
 */
export async function revokeHomeAssistantToken(config, refreshToken) {
  if (!refreshToken) return;
  const t = withTimeout(REQUEST_TIMEOUT_MS);
  try {
    await fetch(`${config.internalUrl}/auth/revoke`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ token: refreshToken }),
      signal: t.signal,
      redirect: 'error',
    });
  } finally {
    t.done();
  }
}

/**
 * Kompletter Rueckweg: prueft state, tauscht den Code, ermittelt den Benutzer
 * und widerruft das Token. Liefert Claims in der Form des OIDC-Ablaufs.
 *
 * @param {object} config  getHomeAssistantConfig()
 * @param {URLSearchParams} query  Query der Callback-Anfrage
 * @param {{state: string, codeVerifier: string}} stored  Session-State des Laufs
 * @param {{warn: Function}} [log]
 * Die Admin-Rolle in Home Assistant wird bewusst NICHT weitergegeben: wer HA
 * verwaltet, verwaltet nicht automatisch den Haushalt. Neue Konten starten wie
 * bei jedem SSO-Anbieter als `member`.
 *
 * @returns {Promise<{sub: string, iss: string, name?: string, preferred_username?: string}>}
 */
export async function completeHomeAssistantLogin(config, query, stored, log) {
  if (query.get('error')) {
    const err = new Error(`Home Assistant returned an error: ${query.get('error')}`);
    err.error = query.get('error');
    throw err;
  }
  // Der state schuetzt vor Login-CSRF; ohne openid-client prueft ihn niemand sonst.
  const state = query.get('state');
  if (!state || state !== stored.state) {
    const err = new Error('state mismatch');
    err.code = 'state_mismatch';
    throw err;
  }
  const code = query.get('code');
  if (!code) throw new Error('Home Assistant callback without code.');

  const tokens = await exchangeHomeAssistantCode(config, { code, codeVerifier: stored.codeVerifier });
  try {
    const user = await fetchHomeAssistantUser(config, tokens.access_token);
    const name = typeof user.name === 'string' && user.name.trim() ? user.name.trim() : undefined;
    return {
      sub: String(user.id),
      iss: config.url,
      name,
      // HA kennt keinen Benutzernamen-Claim; ohne ihn hiesse ein neues Konto wie
      // die 32-stellige HA-ID. Bereinigung und `-1`-Suffix macht findOrCreateOidcUser.
      preferred_username: name,
    };
  } finally {
    // Abgewartet statt nebenher gestartet: der Aufruf ist kurz (lokal, mit
    // Timeout), und ein schwebendes Promise saehe ein laufender Restore nicht.
    try {
      await revokeHomeAssistantToken(config, tokens.refresh_token);
    } catch (e) {
      log?.warn?.(`Home Assistant token revoke failed: ${e.message}`);
    }
  }
}
