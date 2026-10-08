/**
 * Ein CalDAV/CardDAV-Server auf 127.0.0.1, gerade so viel, wie tsdav anfragt.
 *
 * Wozu, wo es doch Attrappen gibt: jede Attrappe in den CalDAV-Suiten ersetzt
 * den CLIENT (`createClient`-Factory) und antwortet, wie ihr Autor glaubt, dass
 * tsdav antwortet - sie gelingt oder sie wirft. Das echte tsdav tut bei einer
 * Absage keins von beiden: `createCalendarObject`, `updateCalendarObject` und
 * `deleteCalendarObject` lösen mit `ok: false` auf, `fetchCalendars` mit `[]`.
 * Dieser Unterschied war der Fehler, und eine Attrappe am Client kann ihn nicht
 * zeigen. Hier läuft deshalb das echte tsdav gegen echtes HTTP; ersetzt ist nur
 * der Server.
 *
 * Kein Testfile (kein `test-`-Präfix), sondern Werkzeug wie `server-ready.js`.
 *
 * Ablehnen lässt sich jede Anfrage über `server.refuse(rule)`:
 *   server.refuse({ method: 'PUT', status: 403 })
 *   server.refuse({ method: 'PROPFIND', path: '/cal/', status: 503 })
 *   server.refuse({ method: 'PUT', status: 412, when: (req) => !req.headers['if-match'] })
 * `server.allowAll()` nimmt alle Regeln zurück.
 */

import http from 'node:http';

const NS = 'xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav" '
  + 'xmlns:card="urn:ietf:params:xml:ns:carddav" xmlns:cs="http://calendarserver.org/ns/"';

const xmlEscape = (value) => String(value)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

function multistatus(responses) {
  return `<?xml version="1.0" encoding="utf-8"?>\n<d:multistatus ${NS}>${responses.join('')}</d:multistatus>`;
}

function propResponse(href, props) {
  return `<d:response><d:href>${xmlEscape(href)}</d:href><d:propstat><d:prop>${props}</d:prop>`
    + '<d:status>HTTP/1.1 200 OK</d:status></d:propstat></d:response>';
}

/**
 * @returns {Promise<object>} laufender Server; `close()` beendet ihn
 */
export async function startFakeDavServer() {
  /** Pfad der Collection → { name, kind, components, objects: Map<Dateiname, {etag, data}> } */
  const collections = new Map();
  const requests = [];
  let rules = [];
  let etagCounter = 0;
  const nextEtag = () => `"e${++etagCounter}"`;

  const principalPath = '/principals/u/';
  const homePath      = '/cal/';

  function locate(pathname) {
    const cut = pathname.lastIndexOf('/');
    const collection = collections.get(pathname.slice(0, cut + 1));
    return { collection, filename: decodeURIComponent(pathname.slice(cut + 1)) };
  }

  function collectionProps(col) {
    const type = col.kind === 'addressbook' ? '<card:addressbook/>' : '<c:calendar/>';
    const comps = col.kind === 'addressbook' ? '' : '<c:supported-calendar-component-set>'
      + col.components.map((name) => `<c:comp name="${name}"/>`).join('')
      + '</c:supported-calendar-component-set>';
    return `<d:resourcetype><d:collection/>${type}</d:resourcetype>`
      + `<d:displayname>${xmlEscape(col.name)}</d:displayname>${comps}`
      + '<d:supported-report-set><d:supported-report><d:report><c:calendar-multiget/></d:report></d:supported-report></d:supported-report-set>';
  }

  function objectResponse(collectionPath, filename, obj, dataTag) {
    return propResponse(
      `${collectionPath}${encodeURIComponent(filename)}`,
      `<d:getetag>${xmlEscape(obj.etag)}</d:getetag><${dataTag}>${xmlEscape(obj.data)}</${dataTag}>`
    );
  }

  function handle(req, body, res) {
    const url = new URL(req.url, 'http://fake.invalid');
    const pathname = url.pathname;
    const sendXml = (text) => {
      res.writeHead(207, { 'Content-Type': 'application/xml; charset=utf-8' });
      res.end(text);
    };
    const plain = (status, headers = {}) => { res.writeHead(status, headers); res.end(); };

    if (pathname.startsWith('/.well-known/')) return plain(404);

    if (req.method === 'PROPFIND') {
      if (pathname === '/') {
        return sendXml(multistatus([propResponse('/',
          `<d:current-user-principal><d:href>${principalPath}</d:href></d:current-user-principal>`)]));
      }
      if (pathname === principalPath) {
        return sendXml(multistatus([propResponse(principalPath,
          `<c:calendar-home-set><d:href>${homePath}</d:href></c:calendar-home-set>`
          + `<card:addressbook-home-set><d:href>${homePath}</d:href></card:addressbook-home-set>`)]));
      }
      if (pathname === homePath) {
        return sendXml(multistatus([
          propResponse(homePath, '<d:resourcetype><d:collection/></d:resourcetype>'),
          ...[...collections].map(([path, col]) => propResponse(path, collectionProps(col))),
        ]));
      }
      const col = collections.get(pathname);
      if (col) {
        const members = req.headers.depth === '1'
          ? [...col.objects].map(([filename, obj]) => propResponse(
            `${pathname}${encodeURIComponent(filename)}`, `<d:getetag>${xmlEscape(obj.etag)}</d:getetag>`))
          : [];
        return sendXml(multistatus([propResponse(pathname, collectionProps(col)), ...members]));
      }
      return plain(404);
    }

    if (req.method === 'REPORT') {
      const col = collections.get(pathname);
      if (!col) return plain(404);
      const dataTag = col.kind === 'addressbook' ? 'card:address-data' : 'c:calendar-data';
      // multiget nennt seine Objekte, eine Query will alle.
      const wanted = [...body.matchAll(/<(?:\w+:)?href[^>]*>([^<]+)<\/(?:\w+:)?href>/g)]
        .map((m) => decodeURIComponent(new URL(m[1].trim(), 'http://fake.invalid').pathname.split('/').pop()));
      const isMultiget = /multiget/.test(body);
      const entries = [...col.objects].filter(([filename]) => !isMultiget || wanted.includes(filename));
      return sendXml(multistatus(entries.map(([filename, obj]) => objectResponse(pathname, filename, obj, dataTag))));
    }

    if (req.method === 'PUT') {
      const { collection, filename } = locate(pathname);
      if (!collection || !filename) return plain(404);
      const existing = collection.objects.get(filename);
      if (req.headers['if-none-match'] === '*' && existing) return plain(412);
      if (req.headers['if-match'] && (!existing || existing.etag !== req.headers['if-match'])) return plain(412);
      const etag = nextEtag();
      collection.objects.set(filename, { etag, data: body });
      return plain(existing ? 204 : 201, { ETag: etag });
    }

    if (req.method === 'DELETE') {
      const { collection, filename } = locate(pathname);
      const existing = collection?.objects.get(filename);
      if (!existing) return plain(404);
      if (req.headers['if-match'] && existing.etag !== req.headers['if-match']) return plain(412);
      collection.objects.delete(filename);
      return plain(204);
    }

    return plain(405);
  }

  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => {
      const body = Buffer.concat(chunks).toString('utf8');
      const pathname = new URL(req.url, 'http://fake.invalid').pathname;
      const entry = { method: req.method, path: pathname, headers: req.headers, body, status: null };
      requests.push(entry);
      res.on('finish', () => { entry.status = res.statusCode; });

      const rule = rules.find((r) => (!r.method || r.method === req.method)
        && (!r.path || r.path === pathname)
        && (!r.when || r.when(entry)));
      if (rule) {
        res.writeHead(rule.status, { 'Content-Type': rule.contentType || 'text/plain' });
        res.end(rule.body ?? 'refused');
        return;
      }
      handle(req, body, res);
    });
  });

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;

  return {
    /** Adresse für `caldav_url` / `carddav_url`. */
    url: `${origin}/`,
    origin,
    requests,
    /** Legt eine Collection an und gibt ihre absolute URL zurück. */
    addCollection(slug, { name = slug, kind = 'calendar', components = ['VEVENT'] } = {}) {
      const path = `${homePath}${slug}/`;
      collections.set(path, { name, kind, components, objects: new Map() });
      return `${origin}${path}`;
    },
    /** Legt ein Objekt direkt ab (als hätte es ein anderer Client geschrieben). */
    putObject(collectionUrl, filename, data) {
      const col = collections.get(new URL(collectionUrl).pathname);
      const etag = nextEtag();
      col.objects.set(filename, { etag, data });
      return { url: `${collectionUrl}${filename}`, etag };
    },
    getObject(collectionUrl, filename) {
      return collections.get(new URL(collectionUrl).pathname)?.objects.get(filename) ?? null;
    },
    objectNames(collectionUrl) {
      return [...(collections.get(new URL(collectionUrl).pathname)?.objects.keys() ?? [])];
    },
    refuse(rule) { rules.push(rule); },
    allowAll() { rules = []; },
    /** Alles zurück auf leer: Collections, Regeln, Protokoll. */
    reset() { collections.clear(); rules = []; requests.length = 0; },
    /** Anfragen einer Methode seit dem letzten `reset()`. */
    seen(method) { return requests.filter((r) => r.method === method); },
    close: () => new Promise((resolve) => { server.closeAllConnections?.(); server.close(resolve); }),
  };
}
