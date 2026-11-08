/**
 * Module: Paperless-ngx DMS Adapter
 * Purpose: Wrap the Paperless-ngx REST API behind the DMS adapter interface
 *          (search, fetchContent, upload, testConnection). Token-authenticated.
 *          base_url is operator-supplied, so every request funnels through
 *          #fetch() and #fetch() alone checks the target (./guard.js). A method
 *          that calls global fetch() directly would bypass the guard - that is
 *          why testConnection() goes through #fetch() too.
 * Dependencies: global fetch (Node >=22), ./guard.js
 */
import { assertDmsTargetAllowed, DmsTargetError } from './guard.js';
import { remoteFailure } from '../../utils/http.js';

const REQUEST_TIMEOUT_MS = 8000;
// Paperless-ngx handelt seine REST-API über einen versionierten Accept-Header aus.
// Fehlt die Version, antworten manche Instanzen/Reverse-Proxies mit 406 Not
// Acceptable (Issue #438). Wir fordern daher explizit eine breit unterstützte
// Version an und fallen bei 406 auf den unversionierten Default zurück, damit auch
// ältere Instanzen ohne diese Version weiterhin funktionieren.
const API_VERSION = 9;

// Erkennt ASN-Suchen (Discussion #511, Issue #763): die Archiv-Seriennummer ist in
// Paperless der eindeutige, oft aufs Papier gestempelte Ordnungsschlüssel.
//
// Ein expliziter Präfix (`asn:123`, `asn 123`, `asn#123`) meint ausschließlich die
// ASN und filtert exakt. Eine nackte Zahl ist dagegen mehrdeutig: sie kann die
// gestempelte ASN sein, ebenso gut aber eine Hausnummer, ein Jahr oder eine
// Rechnungsnummer im Titel (#763). Sie wird deshalb als nicht-exklusiv gemeldet,
// damit der Aufrufer beide Deutungen bedient statt eine zu erzwingen.
//
// → { asn: number|null, exclusive: boolean }
export function parseAsnQuery(query) {
  const q = String(query || '').trim();
  const prefixed = /^asn[:#\s]\s*(\d+)$/i.exec(q);
  if (prefixed) return { asn: Number(prefixed[1]), exclusive: true };
  if (/^\d+$/.test(q)) return { asn: Number(q), exclusive: false };
  return { asn: null, exclusive: false };
}

export class PaperlessAdapter {
  constructor(account) {
    this.provider = 'paperless';
    this.base = String(account.base_url || '').replace(/\/+$/, '');
    this.token = account.api_token;
  }

  headers(extra = {}, { version = API_VERSION } = {}) {
    const accept = version ? `application/json; version=${version}` : 'application/json';
    return { Authorization: `Token ${this.token}`, Accept: accept, ...extra };
  }

  async #fetch(path, opts = {}) {
    // Vor JEDEM Request, nicht einmalig im Konstruktor: die Prüfung ist async,
    // und ein Konto kann seine base_url zwischen zwei Aufrufen geändert haben.
    await assertDmsTargetAllowed(this.base);
    const url = `${this.base}${path}`;
    const res = await fetch(url, {
      ...opts,
      headers: this.headers(opts.headers),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    // 406 = Instanz kennt die angefragte API-Version nicht. Nur für Requests ohne
    // Body erneut versuchen (FormData-Streams sind nicht wiederverwendbar).
    if (res.status === 406 && !opts.body) {
      return fetch(url, {
        ...opts,
        headers: this.headers(opts.headers, { version: null }),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
    }
    return res;
  }

  async #request(path, opts = {}) {
    const res = await this.#fetch(path, opts);
    if (!res.ok) {
      const err = new Error(`DMS request failed (${res.status})`);
      err.status = res.status;
      throw err;
    }
    return res;
  }

  docUrl(id) {
    return `${this.base}/documents/${id}`;
  }

  // Eine Ergebnisseite holen. `extra` setzt entweder den Volltext- oder den
  // ASN-Filter; ohne beides listet Paperless alle Dokumente (/api/documents/ ohne
  // query liefert die volle Liste) - ermöglicht Durchblättern statt exaktes Raten.
  async #searchPage(extra, limit) {
    const params = new URLSearchParams({ page_size: String(limit) });
    for (const [k, v] of Object.entries(extra)) params.set(k, String(v));
    const res = await this.#request(`/api/documents/?${params.toString()}`);
    const body = await res.json();
    return (body.results || []).map((r) => ({
      id: String(r.id),
      title: r.title || r.original_file_name || `#${r.id}`,
      created: r.created || null,
      filename: r.archived_file_name || r.original_file_name || `${r.id}.pdf`,
      url: this.docUrl(r.id),
    }));
  }

  async search(query, { limit = 20 } = {}) {
    const q = String(query || '').trim();
    const { asn, exclusive } = parseAsnQuery(q);

    // Exakter ASN-Filter statt Volltext: trifft genau das eine Dokument mit dieser
    // Archiv-Seriennummer (Discussion #511).
    if (asn !== null && exclusive) {
      return this.#searchPage({ archive_serial_number: asn }, limit);
    }

    // Nackte Zahl (#763): beide Deutungen bedienen. Das ASN-Dokument steht oben,
    // darunter folgen die Volltexttreffer, damit `1728` sowohl die gestempelte
    // Seriennummer als auch "1728 Pest receipt" findet. Die ASN-Abfrage darf die
    // Suche nicht mitreißen, wenn die Instanz sie ablehnt (z. B. Zahl außerhalb des
    // Integer-Bereichs) - der Volltextpfad ist hier der wichtigere von beiden.
    if (asn !== null) {
      const [byAsn, byText] = await Promise.all([
        this.#searchPage({ archive_serial_number: asn }, limit).catch(() => []),
        this.#searchPage({ query: q }, limit),
      ]);
      const merged = [];
      const seen = new Set();
      for (const doc of [...byAsn, ...byText]) {
        if (seen.has(doc.id)) continue;
        seen.add(doc.id);
        merged.push(doc);
      }
      return merged.slice(0, limit);
    }

    return this.#searchPage(q ? { query: q } : {}, limit);
  }

  async getDocument(id) {
    const res = await this.#request(`/api/documents/${encodeURIComponent(id)}/`);
    const r = await res.json();
    return {
      id: String(r.id),
      title: r.title || r.original_file_name || `#${r.id}`,
      created: r.created || null,
      filename: r.archived_file_name || r.original_file_name || `${r.id}.pdf`,
      url: this.docUrl(r.id),
      correspondent: r.correspondent ?? null,
      tags: Array.isArray(r.tags) ? r.tags : [],
    };
  }

  async fetchContent(id) {
    const res = await this.#request(`/api/documents/${encodeURIComponent(id)}/download/`);
    const arrayBuf = await res.arrayBuffer();
    return {
      buffer: Buffer.from(arrayBuf),
      mime: res.headers.get('content-type') || 'application/octet-stream',
    };
  }

  // Vorschaubild der ersten Seite (Issue #533). Paperless-ngx rendert für jedes
  // Dokument ein Thumbnail (i. d. R. image/webp) unter /thumb/. Der Aufrufer prüft
  // den zurückgegebenen MIME-Typ gegen eine Bild-Allowlist, bevor er es inline
  // ausliefert; hier wird nur durchgereicht, was die Instanz sendet.
  async fetchThumbnail(id) {
    const res = await this.#request(`/api/documents/${encodeURIComponent(id)}/thumb/`);
    const arrayBuf = await res.arrayBuffer();
    return {
      buffer: Buffer.from(arrayBuf),
      mime: res.headers.get('content-type') || 'application/octet-stream',
    };
  }

  async upload({ buffer, filename, mime, title, tags = [] }) {
    if (!filename) throw new Error('DMS upload requires a filename');
    const form = new FormData();
    form.append('document', new Blob([buffer], { type: mime || 'application/octet-stream' }), filename);
    if (title) form.append('title', title);
    for (const tag of tags) form.append('tags', String(tag));
    const res = await this.#request('/api/documents/post_document/', { method: 'POST', body: form });
    const taskId = await res.json();
    return { taskId: typeof taskId === 'string' ? taskId : String(taskId) };
  }

  async testConnection() {
    try {
      // Einen echten JSON-Endpunkt testen statt `/api/` (Issue #527): der API-Root
      // leitet auf manchen Instanzen/Reverse-Proxies (Traefik) auf die
      // Swagger-HTML-View `/api/schema/view/` um, die einen JSON-`Accept`-Header
      // mit 406 Not Acceptable ablehnt. `/api/documents/?page_size=1` vermeidet den
      // Redirect und verifiziert zugleich Token und Dokumentzugriff.
      const res = await this.#fetch('/api/documents/?page_size=1');
      return { ok: res.ok, status: res.status };
    } catch (err) {
      // Phase 0 section H: the class of the failure, never its text - the
      // connection test result goes to the browser as it is.
      // The guard's refusal is our own sentence (about the address the admin
      // entered) and stays.
      if (err instanceof DmsTargetError) return { ok: false, status: 0, error: err.message };
      return { ok: false, status: 0, error: 'The DMS could not be reached.', ...(remoteFailure(err) ?? { reason: 'remote_failed' }) };
    }
  }
}
