// --------------------------------------------------------
// tsdav-Client für ein caldav_accounts-Konto.
//
// Termine (caldav-sync.js), VTODO-Inbound (caldav-reminders-sync.js) und der
// VTODO-Outbound (caldav-todo-outbound.js) sprechen denselben Server mit
// denselben Zugangsdaten an; die Factory lag dreimal wortgleich herum. tsdav wird
// bewusst dynamisch geladen: der Import zieht spürbar Code nach, und wer keinen
// CalDAV-Account eingerichtet hat, soll ihn nie laden.
// --------------------------------------------------------

import { sameCredentialOrigin } from './credential-origin.js';

/**
 * @param {{caldav_url: string, username: string, password: string}} account
 * @returns {Promise<object>} tsdav-Client
 */
export async function createCalDAVClient(account) {
  const { createDAVClient } = await import('tsdav');
  const client = await createDAVClient({
    serverUrl:          account.caldav_url,
    credentials:        { username: account.username, password: account.password },
    authMethod:         'Basic',
    defaultAccountType: 'caldav',
  });
  return withHttpRefusalsAsErrors(withCalendarObjectUrlFilter(client));
}

/**
 * tsdav-Client für ein carddav_accounts-Konto. Eigene Factory, weil der
 * Kontakte-Sync dieselbe Regel braucht wie der Kalender: eine abgelehnte
 * Adressbuch-Liste ist kein leeres Konto (siehe `withHttpRefusalsAsErrors`).
 *
 * @param {{carddav_url: string, username: string, password: string}} account
 * @returns {Promise<object>} tsdav-Client
 */
export async function createCardDAVClient(account) {
  const { createDAVClient } = await import('tsdav');
  const client = await createDAVClient({
    serverUrl:          account.carddav_url,
    credentials:        { username: account.username, password: account.password },
    authMethod:         'Basic',
    defaultAccountType: 'carddav',
  });
  return withHttpRefusalsAsErrors(withVCardsByAddress(client));
}

/**
 * Die Anfrage wurde nicht gestellt: ihre Adresse liegt nicht auf dem Server des
 * Kontos (siehe `withAccountOrigin`). `code` statt `status`, damit die
 * Einordnung in calendar-outbound.js sie nicht für eine HTTP-Antwort hält.
 */
export class DavOriginError extends Error {
  constructor(operation, url) {
    super('The address of this entry is not on the server of its account');
    this.name      = 'DavOriginError';
    this.code      = 'origin_not_allowed';
    this.operation = operation;
    this.url       = url;
  }
}

/** Kam die Absage von `withAccountOrigin`, also bevor etwas gesendet wurde? */
export function isOriginRefusal(err) {
  return err?.code === 'origin_not_allowed';
}

/**
 * Ein Konto spricht ein Kalenderobjekt nur auf seinem eigenen Server an
 * (#1860): das ist `caldav_url` und jeder Kalender seiner Auswahl, verglichen
 * wie bei der Passwort-Regel in `credential-origin.js` nach Schema, Host und
 * Port. Woher eine Adresse auch stammt - aus einer Zeile, einem Löschauftrag,
 * einer Antwort des Servers -, hier steht der EINE Vergleich, durch den jede
 * gezielte Anfrage geht: PUT, DELETE und der Abruf von Objekten.
 *
 * Die Kalenderliste (`fetchCalendars`) geht nicht hier durch: sie fragt die
 * Adresse ab, mit der der Client gebaut wurde.
 *
 * Eine relative Adresse wird gegen den Server des Kontos aufgelöst. Eine
 * Anfrage an eine andere Adresse wird nicht gestellt; der Aufruf wirft
 * `DavOriginError`.
 *
 * @param {object}   client
 * @param {string[]} accountUrls  `caldav_url` zuerst, dann die Kalender der Auswahl
 */
export function withAccountOrigin(client, accountUrls) {
  const bases = (accountUrls || []).filter(Boolean).map(String);
  const allowed = (url) => {
    let absolute;
    try { absolute = new URL(String(url ?? ''), bases[0]).href; } catch { return false; }
    return bases.some((base) => sameCredentialOrigin(absolute, base));
  };
  const guard = (name, urlsOf) => {
    if (typeof client[name] !== 'function') return null;
    const call = client[name].bind(client);
    return async (params = {}) => {
      for (const url of urlsOf(params)) {
        if (!allowed(url)) throw new DavOriginError(name, url);
      }
      return call(params);
    };
  };
  // Geprüft wird die Adresse, an die tsdav wirklich sendet, nicht die im
  // Aufruf genannte Collection: `createCalendarObject` löst den Dateinamen
  // gegen die Collection auf (tsdav 2.3.4:
  // `new URL(filename, ensureTrailingSlash(calendar.url)).href`), und das
  // Ergebnis muss nicht in der Collection liegen. Verglichen wird wie überall
  // hier nach Schema, Host und Port. `fetchCalendarObjects` sendet nur an
  // `calendar.url`; die `objectUrls` stehen als Pfade in der Anfrage und werden
  // mitgeprüft.
  const resolvedCreateUrl = (p) => {
    const base = p?.calendar?.url;
    if (p?.filename == null) return base;
    try { return new URL(String(p.filename), String(base).replace(/\/?$/, '/')).href; } catch { return String(p.filename); }
  };
  const overrides = {
    createCalendarObject: guard('createCalendarObject', (p) => [resolvedCreateUrl(p)]),
    updateCalendarObject: guard('updateCalendarObject', (p) => [p?.calendarObject?.url]),
    deleteCalendarObject: guard('deleteCalendarObject', (p) => [p?.calendarObject?.url]),
    fetchCalendarObjects: guard('fetchCalendarObjects', (p) => [p?.calendar?.url, ...(p?.objectUrls ?? [])]),
  };
  return Object.create(Object.getPrototypeOf(client), {
    ...Object.getOwnPropertyDescriptors(client),
    ...Object.fromEntries(Object.entries(overrides).filter(([, value]) => value).map(([name, value]) => [
      name, { value, writable: true, enumerable: true, configurable: true },
    ])),
  });
}

/**
 * Was der Server abgelehnt hat, als Satz. Die Meldung erreicht den Nutzer
 * (Verbindungstest, Sync-Status), deshalb steht hier kein Funktionsname.
 */
const REFUSAL_TEXT = {
  createCalendarObject: 'The server refused to save a new entry',
  updateCalendarObject: 'The server refused to save a change',
  deleteCalendarObject: 'The server refused to delete an entry',
  fetchCalendars:       'The server refused to list the calendars',
  fetchAddressBooks:    'The server refused to list the address books',
};
const NOT_A_LISTING_TEXT = {
  fetchCalendars:    'The server did not answer with a list of calendars',
  fetchAddressBooks: 'The server did not answer with a list of address books',
};

/**
 * Eine Absage des Servers, als Fehler. `status` ist das Feld, das
 * `classifyOutboundError` (calendar-outbound.js) liest; `code` bleibt bewusst
 * leer, denn das liest die Einordnung zuerst und dort stehen bei Netzfehlern
 * Zeichenketten wie `ECONNREFUSED`.
 */
export class DavHttpError extends Error {
  /**
   * @param {string} operation  Name des tsdav-Aufrufs
   * @param {string} [url]      betroffene Ressource
   * @param {object} [response] Antwort des Servers, soweit es eine gab
   * @param {string} [what]     Satzanfang statt der Vorgabe je Aufruf
   */
  constructor(operation, url, response, what = null) {
    const status = response?.status;
    const text   = response?.statusText ? ` ${response.statusText}` : '';
    const lead   = what ?? REFUSAL_TEXT[operation] ?? 'The server refused the request';
    super(status ? `${lead} (HTTP ${status}${text})` : lead);
    this.name       = 'DavHttpError';
    this.status     = status;
    this.statusText = response?.statusText;
    this.operation  = operation;
    this.url        = url ?? response?.url;
  }
}

/**
 * Gilt die Absage eines Uploads der COLLECTION oder nur diesem einen Objekt?
 *
 * Die Frage stellt sich, weil ein Upload keinen Zähler hat: er bleibt
 * vorgemerkt, bis er durchgeht. Lehnt die Collection ab (nur lesbar geteilt,
 * Konto voll, Server überlastet), träfe jeder weitere Upload dieses Laufs
 * dieselbe Absage - ein PUT und eine Logzeile je wartender Zeile, bei jedem
 * Lauf. Dann ist nach der ersten Absage Schluss (`createUploadGate`).
 *
 * Eine Absage, die am einzelnen Objekt hängt, darf dagegen niemanden hinter
 * sich aufhalten: die Reihenfolge ist fest, und ein einziger Eintrag, den der
 * Server nie annimmt, sperrte sonst alle späteren für immer aus. Das sind 412
 * (der Name ist vergeben) und die Antworten auf den Inhalt selbst (400, 409,
 * 413, 415, 422).
 *
 * Ohne Status gilt die Collection nur bei einem ERKANNTEN Netzfehler: der
 * nächste Versuch dieses Laufs liefe in dieselbe Wand. Alles andere ohne Status
 * kommt aus dem eigenen Code - der `try` der Aufrufer umfasst auch den ICS-Bau
 * und die Buchung nach dem PUT - und hängt an dieser einen Zeile. Erkannt wird
 * per Positivliste: ein unbekannter Netzfehler kostet dann einen Versuch und
 * eine Logzeile je Zeile, ein verkannter eigener Fehler sperrte dagegen alle
 * Zeilen hinter der kaputten aus, bei jedem Lauf und ohne eigene Meldung.
 */
const OBJECT_LEVEL_STATUS = new Set([400, 409, 412, 413, 415, 422]);

/** Systemfehler der Verbindung, wie Node und undici sie als `code` tragen. */
const NETWORK_ERROR_CODE = /^(ECONN[A-Z]+|ENOTFOUND|EAI_[A-Z]+|ETIMEDOUT|EHOSTUNREACH|EHOSTDOWN|ENETUNREACH|ENETDOWN|EPIPE|EPROTO|UND_ERR_[A-Z_]+|ERR_TLS_[A-Z_]+|ERR_SSL_[A-Z_]+|CERT_[A-Z_]+|DEPTH_ZERO_SELF_SIGNED_CERT|SELF_SIGNED_CERT_IN_CHAIN|UNABLE_TO_[A-Z_]+)$/;
const NETWORK_ERROR_NAMES = new Set(['AbortError', 'TimeoutError', 'FetchError']);

/**
 * Ist der Fehler einer der Verbindung? Das `fetch` von Node meldet ihn als
 * `TypeError: fetch failed` und hängt den Systemfehler als `cause` an;
 * node-fetch trägt den Code am Fehler selbst.
 */
function isNetworkFailure(err) {
  for (let current = err, depth = 0; current && depth < 4; current = current.cause, depth++) {
    if (NETWORK_ERROR_NAMES.has(current.name)) return true;
    // Nicht jede Ursache trägt einen Code (gesperrter Port, abgerissener Body).
    if (current instanceof TypeError && current.message === 'fetch failed') return true;
    if (typeof current.code === 'string' && NETWORK_ERROR_CODE.test(current.code)) return true;
  }
  return false;
}

export function isCollectionRefusal(err) {
  const status = err?.status;
  if (typeof status !== 'number') return isNetworkFailure(err);
  return !OBJECT_LEVEL_STATUS.has(status);
}

/**
 * Schranke für Uploads eines Laufs: nach der ersten Absage auf Collection-Ebene
 * geht in DIESE Collection nichts mehr hinaus. Gezählt wird ohne Spalte und
 * ohne Aufgeben - im nächsten Lauf ist die Schranke wieder offen.
 *
 *   const gate = createUploadGate();
 *   if (gate.isClosed(url)) continue;        // zählt die übersprungene Zeile
 *   try { ... } catch (err) { if (!gate.refused(url, err)) log.warn(...); }
 *   gate.report((url, err, waiting) => log.warn(...));   // EINE Zeile je Collection
 */
export function createUploadGate() {
  const closed = new Map(); // Collection-URL → { err, waiting }
  return {
    isClosed(collectionUrl) {
      const entry = closed.get(collectionUrl);
      if (!entry) return false;
      entry.waiting++;
      return true;
    },
    /** @returns {boolean} true, wenn die Absage die Collection schliesst */
    refused(collectionUrl, err) {
      if (!isCollectionRefusal(err)) return false;
      if (!closed.has(collectionUrl)) closed.set(collectionUrl, { err, waiting: 1 });
      return true;
    },
    report(write) {
      for (const [collectionUrl, { err, waiting }] of closed) write(collectionUrl, err, waiting);
    },
  };
}

/** Schreibende Aufrufe, deren Antwort tsdav ungeprüft durchreicht. */
const WRITE_OPERATIONS = ['createCalendarObject', 'updateCalendarObject', 'deleteCalendarObject'];
/** Auflistungen, die tsdav aus EINEM PROPFIND auf die Home-Collection baut. */
const LISTING_OPERATIONS = ['fetchCalendars', 'fetchAddressBooks'];

/**
 * Macht aus einer HTTP-Absage einen Fehler - an der einen Stelle, durch die
 * jeder Aufrufer geht.
 *
 * tsdav wirft bei einer Absage nur auf einem Teil seiner Wege (gemessen an
 * 2.3.4 gegen einen lokalen Server, 403/404/412/500/503/507):
 *
 * - `createCalendarObject`, `updateCalendarObject`, `deleteCalendarObject`
 *   reichen die `Response` von `fetch` durch und LÖSEN AUF, mit `ok: false`.
 *   Kein Aufrufer las das Feld. Ein abgelehnter PUT galt als hochgeladen, die
 *   Zeile wurde zum Spiegel eines Objekts, das es nicht gibt, und der nächste
 *   Abruf räumte sie als "auf dem Server gelöscht" weg. Ein abgelehnter DELETE
 *   verwarf den Tombstone, der nächste Abruf holte den Eintrag zurück. Die
 *   Wiederholungslogik (`outboundFailureAction`) sah nur Netzfehler.
 * - `fetchCalendars` und `fetchAddressBooks` lösen mit `[]` auf: der PROPFIND
 *   auf die Home-Collection kommt als einzelner Eintrag ohne `resourcetype`
 *   zurück und fällt durch den Filter. "Abgelehnt" und "es gibt keine" sind
 *   dann dasselbe, und die Sync-Läufe schalten jede ausgewählte Liste ab, die
 *   sie in der Antwort nicht finden.
 * - `fetchCalendarObjects` und `fetchVCards` werfen selbst (`collectionQuery`).
 *
 * Seit 2.4.0 werfen auch `fetchCalendars` und `fetchAddressBooks` bei einer
 * Absage selbst, aber ohne Status. Der Wrapper liest deshalb die Antwort auch
 * dann, wenn der Aufruf geworfen hat.
 *
 * Geprüft wird auf den BELEGTEN Erfolg (`ok === true`), nicht auf die belegte
 * Absage: ändert tsdav die Rückgabeform, soll das hier laut werden statt
 * wieder als Erfolg durchzugehen.
 *
 * Bei den Auflistungen zählt nur die ERSTE Anfrage des Aufrufs, der PROPFIND
 * auf die Home-Collection. Danach fragt tsdav je Collection ihr
 * `supported-report-set` ab und behandelt eine Absage dort selbst als "keine
 * Angabe"; eine einzelne störrische Collection soll nicht die ganze Liste
 * kippen. Mitgelesen wird über den `fetch`-Parameter des einzelnen Aufrufs,
 * also ohne geteilten Zustand am Client.
 *
 * @param {object} client
 * @param {{fetch?: Function}} [opts] das `fetch`, mit dem der Client gebaut
 *        wurde, falls die Factory ihm eins mitgibt. Das Mitlesen ersetzt den
 *        `fetch`-Parameter des Aufrufs; ohne diese Angabe ginge die Auflistung
 *        am clientweiten `fetch` vorbei.
 */
export function withHttpRefusalsAsErrors(client, { fetch: clientFetch } = {}) {
  const overrides = {};

  for (const name of WRITE_OPERATIONS) {
    if (typeof client[name] !== 'function') continue;
    const call = client[name].bind(client);
    overrides[name] = async (params = {}) => {
      const response = await call(params);
      if (response?.ok !== true) {
        throw new DavHttpError(name, params?.calendarObject?.url ?? params?.calendar?.url, response);
      }
      return response;
    };
  }

  for (const name of LISTING_OPERATIONS) {
    if (typeof client[name] !== 'function') continue;
    const call = client[name].bind(client);
    overrides[name] = async (params = {}) => {
      const baseFetch = params?.fetch ?? clientFetch ?? globalThis.fetch;
      let first = null;
      const recordingFetch = async (...args) => {
        const pending = baseFetch(...args);
        // Nur die erste Anfrage: sie ist die Auflistung selbst. Gelesen wird
        // eine Kopie, bevor tsdav den Körper verbraucht.
        if (first === null) first = pending.then((res) => res.clone());
        return pending;
      };
      // Seit tsdav 2.4.0 wirft die Auflistung bei einer Absage selbst, als
      // Fehler ohne Status. Die Antwort der ersten Anfrage entscheidet trotzdem
      // hier: eine Absage geht als `DavHttpError` mit Status hinaus, gleich ob
      // tsdav aufgelöst oder geworfen hat.
      let result;
      let failure = null;
      try {
        result = await call({ ...params, fetch: recordingFetch });
      } catch (err) {
        failure = err;
      }
      const response = await (first ?? Promise.resolve(null)).catch(() => null);
      if (response && !isMultistatus(response)) {
        throw new DavHttpError(
          name, response.url, response,
          response.ok ? NOT_A_LISTING_TEXT[name] : null
        );
      }
      if (failure) {
        // Ein Multistatus, in dem jede Ressource abgelehnt ist (403 je
        // Ressource): tsdav 2.4.0 wirft "discovery failed" ohne Status. Es ist
        // dieselbe Absage wie eine an der ganzen Anfrage.
        const refusal = response ? refusalInMultistatus(await response.text().catch(() => '')) : null;
        if (refusal) throw new DavHttpError(name, response.url, refusal);
        throw failure;
      }
      return result;
    };
  }

  return Object.create(Object.getPrototypeOf(client), {
    ...Object.getOwnPropertyDescriptors(client),
    ...Object.fromEntries(Object.entries(overrides).map(([name, value]) => [
      name, { value, writable: true, enumerable: true, configurable: true },
    ])),
  });
}

/**
 * Lehnt ein Multistatus JEDE genannte Ressource ab? Dann die erste Absage als
 * `{status, statusText}`, sonst null. Ein Multistatus mit auch nur einem
 * Erfolg ist keine Absage, und einer ohne jeden Status auch nicht.
 */
function refusalInMultistatus(text) {
  const lines = [...String(text).matchAll(/<(?:[\w-]+:)?status>\s*HTTP\/[\d.]+\s+(\d{3})\s*([^<]*)</gi)]
    .map((m) => ({ status: Number(m[1]), statusText: m[2].trim() }));
  if (lines.length === 0 || lines.some((line) => line.status >= 200 && line.status < 300)) return null;
  return lines[0];
}

/**
 * Trägt die Antwort eine Auflistung? Ein PROPFIND antwortet mit einem
 * XML-Multistatus. Alles andere - eine Absage, aber auch die mit 200
 * ausgelieferte Anmeldeseite eines vorgeschalteten Proxys - liest tsdav als
 * einen einzelnen Eintrag ohne Eigenschaften, also als leere Liste.
 */
function isMultistatus(response) {
  if (!response.ok) return false;
  return String(response.headers?.get?.('content-type') ?? '').toLowerCase().includes('xml');
}

/**
 * Pfad einer Objekt-URL, vergleichbar gemacht. Absolute URL und href aus einer
 * Server-Antwort laufen beide hier durch, damit der Vergleich in
 * `calendarObjectUrlFilter` nicht an Host oder Schreibweise scheitert.
 */
/**
 * Zerlegt eine Objekt- oder Collection-URL in die zwei Teile, die der Filter
 * getrennt braucht - er stellt nämlich zwei verschiedene Fragen an sie:
 *
 * - WELCHE Ressource ist das? Darüber entscheidet `pathname` PLUS `search`:
 *   tsdav adressiert Objekte selbst als `pathname + search`, und ein Server
 *   darf Collection und Mitglied allein über den Query unterscheiden.
 * - Ist es eine Collection? Darüber entscheidet allein der `pathname`. Ein
 *   Objektbezeichner im Query darf auf einen Schrägstrich enden
 *   (`?object=folder/item/`), und der ist keine Collection-Markierung.
 *
 * Beides in einen String zu ziehen hiesse, die zweite Frage am Ende des Query
 * zu beantworten - und ein Objekt, dessen Bezeichner so endet, fiele still
 * heraus. Genau die Auslassung, gegen die diese Datei geschrieben ist.
 */
function urlParts(url) {
  const raw = String(url ?? '').trim();
  if (!raw) return null;
  try {
    const parsed = new URL(raw, 'http://caldav.invalid/');
    return { path: parsed.pathname, search: parsed.search };
  } catch { return { path: raw, search: '' }; }
}

/**
 * Welche href aus einer `calendar-query`-Antwort ist ein Kalenderobjekt?
 *
 * tsdav filtert hier per Default auf `.ics` im Pfad (`fetchCalendarObjects`,
 * v2.3.1). Die Endung ist aber reine Konvention: RFC 4791 schreibt keinen
 * Namen für die Objekt-Ressource vor, und ein Server darf sie frei vergeben.
 * Stalwart tut das für alles, was über JMAP angelegt wurde ("NZtPkIOMoK"),
 * während per CalDAV-PUT abgelegte Objekte den Clientnamen `<uid>.ics`
 * behalten - im selben Kalender fielen deshalb einzelne Termine still aus dem
 * Sync (#883), ohne dass sie je abgerufen und damit je geloggt wurden.
 *
 * Was der Filter wirklich fernhalten muss, ist die Collection selbst: manche
 * Server liefern sie bei `Depth: 1` mit. Genau so macht es tsdav auf der
 * CardDAV-Seite (`fetchVCards` filtert `urlEquals(url, addressBook.url)`), nur
 * auf der CalDAV-Seite eben nicht.
 *
 * @param {string} collectionUrl  URL des Kalenders, dessen Objekte geholt werden
 */
export function calendarObjectUrlFilter(collectionUrl) {
  // Der Schrägstrich am Ende wird nur am PFAD normalisiert - im Query ist er
  // ein Zeichen des Bezeichners und kein Trennzeichen.
  const identity = (parts) => `${parts.path.replace(/\/+$/, '')}${parts.search}`;
  const collectionParts = urlParts(collectionUrl);
  const collection = collectionParts ? identity(collectionParts) : '';
  return (url) => {
    const parts = urlParts(url);
    if (!parts || !parts.path) return false;
    // Eine Collection endet im PFAD auf einen Schrägstrich und trägt keinen
    // Query: `/dav/cal/x/default/` ist eine, `/dav/calendar?object=a/b/` nicht.
    if (parts.path.endsWith('/') && !parts.search) return false;
    return identity(parts) !== collection;
  };
}

/**
 * Dieselbe Objekt-Adresse? Verglichen werden Host, Pfad und Query, der Pfad
 * dekodiert: ein Server darf `@` als `%40` zurückgeben. Die Sofortversuche
 * ordnen ein Objekt aus einer Antwort nur so einer angefragten Zeile zu - nie
 * "das einzige angefragte", denn eine Antwort darf auch Objekte nennen, nach
 * denen nicht gefragt war, während das angefragte fehlt.
 */
export function sameObjectAddress(a, b) {
  const key = (url) => {
    try {
      const parsed = new URL(String(url));
      let path = parsed.pathname;
      try { path = decodeURIComponent(path); } catch { /* bleibt roh */ }
      return `${parsed.origin}${path}${parsed.search}`;
    } catch { return null; }
  };
  const left = key(a);
  return left !== null && left === key(b);
}

/** Statuscodes, mit denen ein Server sagt: an dieser Adresse liegt nichts. */
const ABSENT_STATUS = new Set([404, 410]);

/** Die beiden Multiget-Berichte: Kalenderobjekte und vCards. */
const MULTIGET = {
  calendar: {
    operation: 'fetchCalendarObjects',
    report:    'calendar-multiget',
    namespace: 'c',
    nsUri:     'urn:ietf:params:xml:ns:caldav',
    dataProp:  'c:calendar-data',
    dataKey:   'calendarData',
  },
  addressbook: {
    operation: 'fetchVCards',
    report:    'addressbook-multiget',
    namespace: 'card',
    nsUri:     'urn:ietf:params:xml:ns:carddav',
    dataProp:  'card:address-data',
    dataKey:   'addressData',
  },
};

/**
 * Holt Objekte einer Collection über ihre Adressen (`calendar-multiget` bzw.
 * `addressbook-multiget`) und liefert, was dort liegt. Was dort NICHT liegt,
 * fehlt in der Rückgabe - es ist kein Fehler.
 *
 * Diese Zusage tragen alle Aufrufer mit `objectUrls`: `inspectObjectAt`
 * (own-uid.js) liest aus einer leeren Rückgabe "das Objekt ist fort", die
 * Sofortversuche nehmen, was kam, und der PROPFIND-Fallback der Kontakte
 * (#529, `fetchVCardsResilient`) holt, was die Auflistung nannte - ein
 * Kontakt, der dazwischen gelöscht wurde, darf nicht das ganze Adressbuch
 * kippen. tsdav hält die Zusage nicht: 2.3.4 warf bei einem 404-Eintrag in der
 * Antwort (so antworten regelkonforme Server auf einen fehlenden Namen) und gab
 * nur dann ohne ihn zurück, wenn der Server den Namen einfach ausliess; 2.4.0
 * wirft in beiden Fällen ("incomplete response"). Deshalb liest diese Stelle
 * den Multistatus selbst, Eintrag für Eintrag:
 *
 *   - 404/410 am Eintrag, oder der Name fehlt in der Antwort: nichts da.
 *   - jede andere Absage am Eintrag oder an der ganzen Anfrage: Fehler mit
 *     Status (`DavHttpError`), denn sie sagt nichts darüber, was dort liegt.
 *   - eine Antwort, die kein Multistatus ist (Anmeldeseite eines Proxys):
 *     ebenfalls Fehler.
 *   - ein Eintrag ohne Inhalt (ETag ja, Daten nein): Fehler. Als Objekt ohne
 *     Daten weitergereicht, läse `inspectObjectAt` "keine UID, also nicht
 *     unseres, also fort" - über ein Objekt, das da ist.
 *
 * Gesendet wird an die Collection, wie bei tsdav; die Objekte stehen als Pfad
 * im Körper.
 *
 * @param {object} client  tsdav-Client (für `davRequest` mit seinen Zugangsdaten)
 * @param {'calendar'|'addressbook'} kind
 * @param {{collectionUrl: string, objectUrls: string[], headers?: object}} params
 * @returns {Promise<Array<{url: string, etag: string|undefined, data: string}>>}
 */
async function multigetByAddress(client, kind, { collectionUrl, objectUrls, headers }) {
  const spec = MULTIGET[kind];
  if (!collectionUrl) throw new Error(`cannot run ${spec.report} without a collection url`);
  const base = String(collectionUrl).replace(/\/?$/, '/');
  const collection = new URL(base);
  const decoded = (path) => { try { return decodeURIComponent(path); } catch { return path; } };
  // Gefragt wird die Collection; im Körper steht nur der Pfad. Ein Objekt auf
  // einem anderen Host oder ausserhalb der Collection wäre dann ein Pfad auf
  // DIESEM Server, und ein 404 darauf läse sich als "fort" - über ein Objekt,
  // nach dem gar nicht gefragt wurde. Solche Adressen gehen nicht hinaus.
  const hrefs = objectUrls
    .filter((url) => typeof url === 'string' && url.trim())
    .map((url) => {
      const parsed = new URL(url, base);
      if (parsed.origin !== collection.origin) throw new DavOriginError(spec.operation, parsed.href);
      if (!decoded(parsed.pathname).startsWith(decoded(collection.pathname))) {
        throw new DavHttpError(spec.operation, parsed.href, null, 'The address of this entry is not in its collection');
      }
      return `${parsed.pathname}${parsed.search}`;
    });
  if (hrefs.length === 0) return [];

  const responses = await client.davRequest({
    url: collectionUrl,
    init: {
      method:    'REPORT',
      namespace: spec.namespace,
      headers:   { ...headers, depth: '1' },
      body: {
        [spec.report]: {
          _attributes: { 'xmlns:d': 'DAV:', [`xmlns:${spec.namespace}`]: spec.nsUri },
          'd:prop':    { 'd:getetag': {}, [spec.dataProp]: {} },
          'd:href':    hrefs,
        },
      },
    },
  });

  const objects = [];
  for (const res of responses || []) {
    if (!res?.raw?.multistatus) {
      throw new DavHttpError(spec.operation, collectionUrl, res,
        res?.ok ? 'The server did not answer with the requested entries' : 'The server refused to read entries');
    }
    if (!res.href) {
      // Ein leerer Multistatus: keines der Objekte liegt dort. Ein Eintrag ohne
      // Adresse in einem gefüllten dagegen belegt nichts - als "fort" gelesen,
      // verschwände ein Objekt, über das der Server gar nichts gesagt hat.
      if (!res.raw.multistatus.response) continue;
      throw new DavHttpError(spec.operation, collectionUrl, null, 'The server did not answer with the requested entries');
    }
    const url = new URL(res.href, base).href;
    if (ABSENT_STATUS.has(res.status)) continue;
    if (!res.ok) throw new DavHttpError(spec.operation, url, res, 'The server refused to read an entry');
    const value = res.props?.[spec.dataKey];
    const data = value?._cdata ?? value?._text ?? value;
    if (typeof data !== 'string') {
      throw new DavHttpError(spec.operation, url, null, 'The server did not return the content of an entry');
    }
    const etag = res.props?.getetag;
    objects.push({
      url,
      etag: etag == null ? undefined : String(etag?._cdata ?? etag?._text ?? etag),
      data,
    });
  }
  return objects;
}

/**
 * Leitet den Abruf von vCards über Adressen (`objectUrls`) an
 * `multigetByAddress`; der Abruf eines ganzen Adressbuchs bleibt bei tsdav.
 * Über den Prototyp gebaut, aus demselben Grund wie
 * `withCalendarObjectUrlFilter`.
 */
export function withVCardsByAddress(client) {
  const fetchVCards = client.fetchVCards.bind(client);
  return Object.create(Object.getPrototypeOf(client), {
    ...Object.getOwnPropertyDescriptors(client),
    fetchVCards: {
      value: (params = {}) => (Array.isArray(params?.objectUrls)
        ? multigetByAddress(client, 'addressbook', {
          collectionUrl: params.addressBook?.url, objectUrls: params.objectUrls, headers: params.headers,
        })
        : fetchVCards(params)),
      writable: true, enumerable: true, configurable: true,
    },
  });
}

/**
 * Hängt `calendarObjectUrlFilter` als Default an `fetchCalendarObjects`, und
 * leitet den Abruf über Adressen (`objectUrls`) an
 * `multigetByAddress`.
 *
 * Der Filter sitzt am Client statt an den Aufrufstellen, weil er einen
 * Bibliotheks-Default neutralisiert: fünf Stellen holen Kalenderobjekte, und
 * eine sechste würde die Regel sonst wieder verlieren. Ein explizit
 * übergebener `urlFilter` gewinnt weiterhin. Der Abruf über Adressen filtert
 * gar nicht: wonach namentlich gefragt wird, kommt zurück, gleich wie es heisst.
 */
export function withCalendarObjectUrlFilter(client) {
  const fetchCalendarObjects = client.fetchCalendarObjects.bind(client);
  // ÜBER DEN PROTOTYP, NICHT ÜBER SPREAD: `createDAVClient` gibt heute ein
  // Objektliteral zurück, dessen Methoden alle eigene Eigenschaften sind - ein
  // Spread käme damit durch. Er käme aber still NICHT durch, sobald tsdav auf
  // die Klassenform (`new DAVClient()`) wechselt, deren Methoden am Prototyp
  // hängen: der Wrapper verlöre `fetchCalendars`, `deleteCalendarObject` und
  // den Rest, und zwar erst zur Laufzeit. Die Delegation kostet hier nichts und
  // nimmt die Abhängigkeit von einer fremden Rückgabeform ganz weg.
  return Object.create(Object.getPrototypeOf(client), {
    ...Object.getOwnPropertyDescriptors(client),
    fetchCalendarObjects: {
      value: (params = {}) => (Array.isArray(params?.objectUrls)
        ? multigetByAddress(client, 'calendar', {
          collectionUrl: params.calendar?.url, objectUrls: params.objectUrls, headers: params.headers,
        })
        : fetchCalendarObjects({
          urlFilter: calendarObjectUrlFilter(params?.calendar?.url),
          ...params,
        })),
      writable: true, enumerable: true, configurable: true,
    },
  });
}

/**
 * Trägt eine Collection die gesuchte iCalendar-Komponente?
 *
 * `supported-calendar-component-set` ist laut RFC 4791 §5.2.3 optional: fehlt die
 * Property, muss der Client alle Komponenten annehmen. tsdav liefert dann ein
 * leeres `components`-Array - wer darauf strikt filtert, blendet auf solchen
 * Servern jede Collection aus. Die Regel steht hier einmal, weil Termine und
 * Aufgaben sie spiegelbildlich brauchen und sie vorher auf der einen Seite fehlte
 * (Aufgabenlisten landeten in der Kalenderauswahl) und auf der anderen zu streng
 * war (#617).
 *
 * @param {{components?: string[]}} cal  Collection aus `fetchCalendars()`
 * @param {string} component            'VEVENT' | 'VTODO'
 */
export function supportsComponent(cal, component) {
  const comps = Array.isArray(cal?.components) ? cal.components : [];
  if (comps.length === 0) return true;
  return comps.map(c => String(c).toUpperCase()).includes(String(component).toUpperCase());
}

/**
 * Collection-URL eines Kalenderobjekts: alles bis zum letzten Segment.
 * CalDAV-Objekte liegen unmittelbar in ihrer Collection, deshalb ist der Pfad
 * ohne Dateinamen die Liste, zu der das Objekt gehört. Nötig, weil tsdav ein
 * Objekt nur innerhalb seiner Collection adressiert, Aufgaben und Einkaufsposten
 * aber nur ihre Objekt-URL tragen.
 */
export function collectionUrlOf(objectUrl) {
  const url = String(objectUrl || '');
  const cut = url.lastIndexOf('/');
  return cut === -1 ? null : url.slice(0, cut + 1);
}
