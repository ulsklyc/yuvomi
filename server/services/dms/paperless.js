/**
 * Module: Paperless-ngx DMS Adapter
 * Purpose: Wrap the Paperless-ngx REST API behind the DMS adapter interface
 *          (search, fetchContent, upload, testConnection). Token-authenticated.
 * Dependencies: global fetch (Node >=22)
 */

const REQUEST_TIMEOUT_MS = 8000;
// Paperless-ngx handelt seine REST-API über einen versionierten Accept-Header aus.
// Fehlt die Version, antworten manche Instanzen/Reverse-Proxies mit 406 Not
// Acceptable (Issue #438). Wir fordern daher explizit eine breit unterstützte
// Version an und fallen bei 406 auf den unversionierten Default zurück, damit auch
// ältere Instanzen ohne diese Version weiterhin funktionieren.
const API_VERSION = 9;

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

  async search(query, { limit = 20 } = {}) {
    const q = String(query || '').trim();
    if (!q) return [];
    const params = new URLSearchParams({ query: q, page_size: String(limit) });
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
      const res = await this.#fetch('/api/');
      return { ok: res.ok, status: res.status };
    } catch (err) {
      return { ok: false, status: 0, error: err.message };
    }
  }
}
