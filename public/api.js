/**
 * Modul: API-Client
 * Zweck: Fetch-Wrapper mit Session-Auth, einheitlicher Fehlerbehandlung und JSON-Parsing
 * Abhängigkeiten: sw-register (clearApiCache bei Logout)
 */

import { clearApiCache } from '/sw-register.js';
import { setPermissions, clearPermissions } from '/permissions.js';

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

  let response;
  try {
    response = await fetch(url, {
      credentials: 'same-origin',
      cache: 'no-store',
      ...fetchOptions,
      headers: {
        'Content-Type': 'application/json',
        ...(stateChanging ? { 'X-CSRF-Token': getCsrfToken() } : {}),
        ...optionHeaders,
      },
    });
  } catch (err) {
    // Offline/Netzfehler bei state-changing Requests (POST/PUT/PATCH/DELETE):
    // klaren ApiError werfen statt nacktem TypeError, damit die UI eine
    // verständliche „offline"-Meldung zeigen kann (read-only Offline-Modus).
    if (stateChanging) throw new ApiError('offline', 0);
    throw err;
  }

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

  post: (path, body, opts = {}) => apiFetch(path, {
    method: 'POST',
    body: JSON.stringify(body),
    ...opts,
  }),

  rawPost: (path, body, headers = {}) => apiFetch(path, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/octet-stream',
      ...headers,
    },
    body,
  }),

  // opts (z. B. { keepalive: true }) siehe delete unten — auch Serien-Scope-
  // Löschungen committen per PUT/POST (UNTIL-Kürzung, EXDATE).
  put: (path, body, opts = {}) => apiFetch(path, {
    method: 'PUT',
    body: JSON.stringify(body),
    ...opts,
  }),

  patch: (path, body) => apiFetch(path, {
    method: 'PATCH',
    body: JSON.stringify(body),
  }),

  // opts erlaubt fetch-Optionen wie { keepalive: true } — genutzt vom
  // pagehide-Flush des Undo-Löschmusters (utils/ux.js, Audit F-13), damit der
  // Request auch beim Schließen/Neuladen des Tabs noch abgesetzt wird.
  delete: (path, opts = {}) => apiFetch(path, { method: 'DELETE', ...opts }),
};

// --------------------------------------------------------
// Auth-spezifische Methoden
// --------------------------------------------------------

const auth = {
  login: async (username, password) => {
    const res = await api.post('/auth/login', { username, password });
    setPermissions(res?.permissions);
    return res;
  },
  logout: async () => {
    try {
      return await api.post('/auth/logout');
    } finally {
      clearPermissions();
      // API-Cache IMMER leeren — auch wenn der Logout-Request offline oder bei
      // nicht erreichbarem Server fehlschlägt. Der Settings-Handler navigiert in
      // seinem finally trotzdem zu /login, daher darf hier kein offline gecachter
      // Stand des vorigen Nutzers am selben Gerät zurückbleiben.
      clearApiCache();
    }
  },
  me: async () => {
    const res = await api.get('/auth/me');
    setPermissions(res?.permissions);
    return res;
  },
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

const notifications = {
  providers: () => api.get('/notifications/providers'),
  listChannels: () => api.get('/notifications/channels'),
  createChannel: (body) => api.post('/notifications/channels', body),
  updateChannel: (id, body) => api.put(`/notifications/channels/${id}`, body),
  deleteChannel: (id) => api.delete(`/notifications/channels/${id}`),
  testChannel: (id) => api.post(`/notifications/channels/${id}/test`, {}),
};

export { api, auth, email, notifications, ApiError };
