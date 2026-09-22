/**
 * Modul: API-Client
 * Zweck: Fetch-Wrapper mit Session-Auth, einheitlicher Fehlerbehandlung und JSON-Parsing
 * Abhängigkeiten: sw-register (clearApiCache bei Logout)
 */

import { clearApiCache } from '/sw-register.js';
import { setPermissions, clearPermissions } from '/permissions.js';
import { setHouseholdSize, setOtherReaders, clearHouseholdSize } from '/utils/household.js';
import { forgetLayoutHint } from '/utils/dashboard-layout-hint.js';

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
  // `withSource` ist KEINE fetch-Option und wird deshalb hier herausgeloest,
  // bevor der Rest weitergereicht wird.
  const { headers: optionHeaders = {}, withSource = false, ...fetchOptions } = options;

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
    // Für den zweiten Faktor gilt dasselbe: dort heißt 401 "falscher Code" oder
    // "der Wartezustand ist abgelaufen" - beides gehört auf die Anmeldeseite
    // gesagt und nicht in einen Sitzungsabbruch übersetzt (#672).
    if (path !== '/auth/login' && path !== '/auth/2fa/verify') {
      window.dispatchEvent(new CustomEvent('auth:expired'));
      throw new Error('Sitzung abgelaufen.');
    }
    // Für beide: fall-through zum generischen !response.ok-Handler unten.
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
    throw new ApiError(message, response.status, data, response.headers.get('Retry-After'));
  }

  if (stateChanging) notifyCountedMutation(path);

  // `withSource` beantwortet EINE Frage: kam diese Antwort aus dem
  // Offline-Cache des Service Workers?
  //
  // `networkFirstApi` in `sw.js` setzt `x-cached-at` nur beim ABLEGEN und gibt
  // die Netzantwort unveraendert zurueck - der Header ist damit das eindeutige
  // Merkmal, und ohne aktiven Service Worker gibt es ihn nie. Ein Cache-Treffer
  // kommt mit dem urspruenglichen Status 200 zurueck, ist also von einer
  // frischen Antwort sonst nicht zu unterscheiden.
  //
  // Am ERGEBNIS und nicht in einem Modulfeld: zwei gleichzeitige Anfragen
  // haetten sich einen gemeinsamen Merker gegenseitig ueberschrieben, und die
  // Frage stellt sich gerade dort, wo mehrere Rundlaeufe offen sind.
  if (withSource) return { data, fromCache: response.headers.has('x-cached-at') };

  return data;
}

/* WER ETWAS AENDERT, DAS GEZAEHLT WIRD, MELDET ES HIER - EINMAL FUER ALLE (#868).
 *
 * Die Zahlen an den Nav-Zielen und an den Modulkacheln kommen aus `/dashboard`
 * und altern sonst bis zu einer Minute. Sie an den Schreibpfaden der Module
 * einzeln nachzuziehen hiesse: allein im Aufgabenmodul siebzehn Stellen, und
 * die achtzehnte wird vergessen. Deshalb steht die Meldung an der Schicht, die
 * ohnehin jeder Schreibvorgang durchlaeuft.
 *
 * NICHT AN DER RENDER-SCHICHT, und das ist der Unterschied, der zaehlt: eine
 * erste Fassung haengte sie an `updateOverdueBadge()`, das jedes
 * `renderTaskList()` ruft - also auch bei jedem Tastenanschlag in der Suche,
 * bei jedem Filter- und Ansichtswechsel. Jede Tipppause laenger als der
 * Entprellzeitraum stiess damit eine vollstaendige Dashboard-Aggregation an,
 * ohne dass sich an den gezaehlten Daten irgendetwas geaendert haette.
 *
 * DIE LISTE IST KURZ UND BLEIBT ES. Sie nennt die Praefixe, deren Bestand in
 * einer Zahl auftaucht - nicht jeden Schreibpfad der App. Ein Praefix zu
 * vergessen kostet eine veraltete Zahl bis zum Ablauf der TTL; jeden
 * Einstellungsklick mitzuzaehlen kostet eine Aggregation pro Klick. */
const COUNTED_PATHS = ['/tasks', '/shopping', '/rewards', '/health', '/birthdays', '/inventory'];

function notifyCountedMutation(path) {
  const base = path.split('?')[0];
  if (!COUNTED_PATHS.some((prefix) => base === prefix || base.startsWith(`${prefix}/`))) return;
  // Still und entkoppelt: die API-Schicht kennt den Router nicht, und ein
  // fehlender Zaehler darf keinen Schreibvorgang scheitern lassen.
  try { window.yuvomi?.invalidateModuleCounts?.(); } catch { /* siehe oben */ }
}

/**
 * Strukturierter API-Fehler mit HTTP-Status-Code.
 */
class ApiError extends Error {
  constructor(message, status, data = null, retryAfter = null) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.data = data;
    this.retryAfter = retryAfter;
  }
}

// --------------------------------------------------------
// Convenience-Methoden
// --------------------------------------------------------

const api = {
  get: (path) => apiFetch(path, { method: 'GET' }),

  /**
   * Wie `get`, liefert aber `{ data, fromCache }` statt nur den Rumpf.
   *
   * Fuer Aufrufer, die eine Antwort AUS DEM CACHE nicht wie eine frische
   * behandeln duerfen. Der Einkauf ist der erste: er haelt Merker fuer
   * ausstehende Abhak-Vorgaenge und darf sie erst raeumen, wenn eine Antwort
   * beweist, dass der Server den Wert kennt - eine gecachte beweist nichts.
   */
  getWithSource: (path) => apiFetch(path, { method: 'GET', withSource: true }),

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

  // opts wie bei put/delete: { keepalive: true } für Writes, die beim
  // Tab-Schließen noch rausgehen müssen - genutzt vom pagehide-Flush des
  // Vorrats-Steppers, dessen PATCH 450ms gedebounced ist.
  patch: (path, body, opts = {}) => apiFetch(path, {
    method: 'PATCH',
    body: JSON.stringify(body),
    ...opts,
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
    setHouseholdSize(res?.householdSize);
    setOtherReaders(res?.othersCanRead);
    return res;
  },
  // Zweiter Schritt der Anmeldung (#672). Der Code darf ein TOTP-Code oder ein
  // Wiederherstellungscode sein - welcher es war, sagt die Antwort.
  verifyTwoFactor: async (code) => {
    const res = await api.post('/auth/2fa/verify', { code });
    setPermissions(res?.permissions);
    setHouseholdSize(res?.householdSize);
    setOtherReaders(res?.othersCanRead);
    return res;
  },
  // Verwaltung des eigenen zweiten Faktors.
  getTwoFactor: () => api.get('/auth/2fa'),
  setupTwoFactor: () => api.post('/auth/2fa/setup', {}),
  enableTwoFactor: (code) => api.post('/auth/2fa/enable', { code }),
  disableTwoFactor: (code) => api.post('/auth/2fa/disable', { code }),
  regenerateRecoveryCodes: (code) => api.post('/auth/2fa/recovery-codes', { code }),
  // Beendet jede andere Sitzung des Kontos, diese bleibt (#1354). Antwort: { ok, ended }.
  logoutOthers: () => api.post('/auth/logout-others', {}),
  logout: async () => {
    try {
      return await api.post('/auth/logout');
    } finally {
      clearPermissions();
      clearHouseholdSize();
      // API-Cache IMMER leeren — auch wenn der Logout-Request offline oder bei
      // nicht erreichbarem Server fehlschlägt. Der Settings-Handler navigiert in
      // seinem finally trotzdem zu /login, daher darf hier kein offline gecachter
      // Stand des vorigen Nutzers am selben Gerät zurückbleiben.
      clearApiCache();
      // Aus demselben Grund der Layout-Hinweis der Übersicht: seit die
      // Anordnung jeder Person gehört (#585), sagt er am geteilten Tablett
      // sonst das Raster des vorigen Nutzers voraus.
      forgetLayoutHint();
    }
  },
  me: async () => {
    const res = await api.get('/auth/me');
    setPermissions(res?.permissions);
    // Neben den Rechten die zweite Angabe, die JEDE Seite braucht und die
    // niemand einzeln holen soll: die Haushaltsgroesse (utils/household.js).
    setHouseholdSize(res?.householdSize);
    setOtherReaders(res?.othersCanRead);
    return res;
  },
  setup: (username, display_name, password) => api.post('/auth/setup', { username, display_name, password }),
  getUsers: () => api.get('/auth/users'),
  // DER HAUSHALT KANN SICH AENDERN, UND DANN AENDERT SICH, WAS GEFRAGT WIRD.
  // `householdSize` kommt sonst nur aus /auth/me und /auth/login, wird also
  // erst beim naechsten Kaltstart neu gezaehlt - ein Haushalt, der gerade sein
  // zweites Mitglied bekommen hat, bliebe bis dahin in der Solo-Darstellung
  // und zeigte weder Sichtbarkeit noch Zuweisung. Ein Rundweg bei einer
  // Handlung, die ein Haushalt selten macht, ist dafuer der billige Preis.
  createUser: async (data) => {
    const res = await api.post('/auth/users', data);
    await auth.me().catch(() => {});
    return res;
  },
  // Rolle und Rechte entscheiden, wer ein Modul mitlesen kann (`othersCanRead`):
  // derselbe Rundweg wie beim Anlegen, sonst blieben die Schutzfelder bis zum
  // naechsten Kaltstart in der alten Lage.
  updateUser: async (id, data) => {
    const res = await api.patch(`/auth/users/${id}`, data);
    await auth.me().catch(() => {});
    return res;
  },
  updateProfile: (data) => api.patch('/auth/me/profile', data),
  markOnboardingSeen: () => api.post('/auth/onboarding-seen', {}),
  deleteUser: async (id) => {
    const res = await api.delete(`/auth/users/${id}`);
    await auth.me().catch(() => {});
    return res;
  },
  forgotPassword: (identifier) => api.post('/auth/forgot-password', { identifier }),
  resetPassword: (token, password) => api.post('/auth/reset-password', { token, password }),
  /**
   * Kann dieser Server einen Passwort-Reset ueberhaupt durchfuehren?
   *
   * Zwei Gruende sprechen dagegen und beide fuehren zu derselben Sackgasse:
   * kein zustellbarer Weg (SMTP oder BASE_URL fehlt) oder gar kein Passwort,
   * das sich zuruecksetzen liesse (SSO als einziger Anmeldeweg, #847). Die
   * beiden Reset-Seiten fragen deshalb nicht nach dem Grund, sondern nach der
   * Faehigkeit - der Server fasst beide in `password_reset_enabled` zusammen.
   *
   * Ein Fehlschlag gilt bewusst als "moeglich": eine kurzzeitig unerreichbare
   * `/version` darf niemanden von seinem Reset aussperren.
   * @returns {Promise<boolean>}
   */
  passwordResetAvailable: async () => {
    try {
      return (await api.get('/version'))?.password_reset_enabled !== false;
    } catch {
      return true;
    }
  },
  /**
   * Gibt es auf diesem Server ueberhaupt Passwoerter? (#847)
   *
   * Bewusst eine ANDERE Frage als `passwordResetAvailable`: dort geht es um die
   * Zustellbarkeit einer Mail, hier um die Existenz des Anmeldewegs. Wer einen
   * bereits verschickten Token einloest, braucht keine Mail mehr - eine
   * zwischenzeitlich abgeschaltete SMTP darf ihn deshalb nicht aussperren.
   *
   * Ein Fehlschlag gilt wieder als "ja": der Server prueft ohnehin selbst.
   * @returns {Promise<boolean>}
   */
  passwordLoginEnabled: async () => {
    try {
      return (await api.get('/auth/oidc/config'))?.password_login_enabled !== false;
    } catch {
      return true;
    }
  },
  // Einladungen: die ersten drei sind Admin-Routen, die letzten beiden öffentlich
  // (die /join-Seite ruft sie ohne Session auf).
  createInvite: (data) => api.post('/auth/invites', data),
  getInvites: () => api.get('/auth/invites'),
  revokeInvite: (id) => api.delete(`/auth/invites/${id}`),
  previewInvite: (token) => api.get(`/auth/invites/preview?token=${encodeURIComponent(token)}`),
  acceptInvite: (data) => api.post('/auth/invites/accept', data),
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

// --------------------------------------------------------
// Recipe Providers – Rezept-Mirror-Sync (Mealie, Tandoor, ...)
// --------------------------------------------------------

const recipeProviders = {
  listAccounts: () => api.get('/recipe-providers/accounts'),
  createAccount: (body) => api.post('/recipe-providers/accounts', body),
  updateAccount: (id, body) => api.patch(`/recipe-providers/accounts/${id}`, body),
  deleteAccount: (id) => api.delete(`/recipe-providers/accounts/${id}`),
  testAccount: (id) => api.post(`/recipe-providers/accounts/${id}/test`, {}),
  syncAccount: (id) => api.post(`/recipe-providers/accounts/${id}/sync`, {}),
  getStatus: () => api.get('/recipe-providers/status'),
};

export { api, auth, email, notifications, recipeProviders, ApiError };
