/**
 * Modul: API-Client
 * Zweck: Fetch-Wrapper mit Session-Auth, einheitlicher Fehlerbehandlung und JSON-Parsing
 * Abhängigkeiten: keine
 */

const API_BASE = '/api/v1';

/** In-Memory CSRF-Token (zuverlaessiger als document.cookie auf iOS Safari/PWA). */
let _csrfToken = '';

/** Liest den CSRF-Token: bevorzugt In-Memory, Fallback auf Cookie. */
function getCsrfToken() {
  if (_csrfToken) return _csrfToken;
  return document.cookie.split(';')
    .map((c) => c.trim())
    .find((c) => c.startsWith('csrf-token='))
    ?.slice('csrf-token='.length) ?? '';
}

/**
 * Zentraler Fetch-Wrapper.
 * Setzt Content-Type, handhabt 401-Redirects und parsed JSON-Fehler.
 *
 * @param {string} path - API-Pfad ohne /api/v1 (z.B. '/tasks')
 * @param {RequestInit} options - Fetch-Optionen
 * @returns {Promise<any>} Geparstes JSON oder wirft einen Fehler
 */
async function apiFetch(path, options = {}, _retried = false) {
  const url = `${API_BASE}${path}`;

  const method = options.method ?? 'GET';
  const stateChanging = ['POST', 'PUT', 'PATCH', 'DELETE'].includes(method);
  const { headers: optionHeaders = {}, ...fetchOptions } = options;

  const response = await fetch(url, {
    credentials: 'same-origin',
    cache: 'no-store',
    ...fetchOptions,
    headers: {
      'Content-Type': 'application/json',
      ...(stateChanging ? { 'X-CSRF-Token': getCsrfToken() } : {}),
      ...optionHeaders,
    },
  });

  if (response.status === 401) {
    // Beim Login-Endpunkt bedeutet 401 "falsche Zugangsdaten", nicht "Session abgelaufen".
    // auth:expired würde die Login-Seite neu rendern und die Fehlermeldung verwerfen.
    if (path !== '/auth/login') {
      window.dispatchEvent(new CustomEvent('auth:expired'));
      throw new Error('Sitzung abgelaufen.');
    }
    // Für /auth/login: fall-through zum generischen !response.ok-Handler unten.
  }

  // CSRF-Token-Desync (haeufig nach iOS-PWA-Resume): einmal GET /auth/me
  // ausfuehren um den CSRF-Token zu erneuern, dann den Request wiederholen.
  if (response.status === 403 && stateChanging && !_retried) {
    // Token aus der 403-Antwort selbst extrahieren (Server liefert den
    // korrekten Token im Header mit, auch bei Fehlschlag)
    const errorCsrf = response.headers.get('X-CSRF-Token');
    if (errorCsrf) {
      _csrfToken = errorCsrf;
      return apiFetch(path, options, true);
    }
    // Fallback: /auth/me aufrufen um Token zu erneuern
    const meRes = await fetch(`${API_BASE}/auth/me`, { credentials: 'same-origin', cache: 'no-store' });
    if (meRes.status === 401) {
      window.dispatchEvent(new CustomEvent('auth:expired'));
      throw new Error('Sitzung abgelaufen.');
    }
    const meData = await meRes.json().catch(() => null);
    if (meData?.csrfToken) _csrfToken = meData.csrfToken;
    return apiFetch(path, options, true);
  }

  // CSRF-Token aus Response-Header extrahieren (wird bei jeder API-Antwort mitgeliefert)
  const csrfHeader = response.headers.get('X-CSRF-Token');
  if (csrfHeader) _csrfToken = csrfHeader;

  const data = await response.json().catch(() => null);

  // Fallback: CSRF-Token aus Response-Body (fuer /auth/me und /auth/login)
  if (data?.csrfToken) _csrfToken = data.csrfToken;

  if (!response.ok) {
    const message = data?.error || `HTTP ${response.status}`;
    throw new ApiError(message, response.status, data);
  }

  return data;
}

/**
 * Strukturierter API-Fehler mit HTTP-Status-Code.
 */
class ApiError extends Error {
  constructor(message, status, data = null) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.data = data;
  }
}

// --------------------------------------------------------
// Convenience-Methoden
// --------------------------------------------------------

const api = {
  get: (path) => apiFetch(path, { method: 'GET' }),

  post: (path, body) => apiFetch(path, {
    method: 'POST',
    body: JSON.stringify(body),
  }),

  rawPost: (path, body, headers = {}) => apiFetch(path, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/octet-stream',
      ...headers,
    },
    body,
  }),

  put: (path, body) => apiFetch(path, {
    method: 'PUT',
    body: JSON.stringify(body),
  }),

  patch: (path, body) => apiFetch(path, {
    method: 'PATCH',
    body: JSON.stringify(body),
  }),

  delete: (path) => apiFetch(path, { method: 'DELETE' }),
};

// --------------------------------------------------------
// Auth-spezifische Methoden
// --------------------------------------------------------

const auth = {
  login: (username, password) => api.post('/auth/login', { username, password }),
  logout: () => api.post('/auth/logout'),
  me: () => api.get('/auth/me'),
  setup: (username, display_name, password) => api.post('/auth/setup', { username, display_name, password }),
  getUsers: () => api.get('/auth/users'),
  createUser: (data) => api.post('/auth/users', data),
  updateUser: (id, data) => api.patch(`/auth/users/${id}`, data),
  updateProfile: (data) => api.patch('/auth/me/profile', data),
  deleteUser: (id) => api.delete(`/auth/users/${id}`),
  forgotPassword: (identifier) => api.post('/auth/forgot-password', { identifier }),
  resetPassword: (token, password) => api.post('/auth/reset-password', { token, password }),
};

// --------------------------------------------------------
// E-Mail (SMTP) – Admin-Konfiguration
// --------------------------------------------------------

const email = {
  getConfig: () => api.get('/email/config'),
  saveConfig: (cfg) => api.put('/email/config', cfg),
  test: (to) => api.post('/email/test', to ? { to } : {}),
};

export { api, auth, email, ApiError };
