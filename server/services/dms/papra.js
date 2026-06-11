/**
 * Module: Papra DMS Adapter
 * Purpose: Wrap the Papra REST API behind the DMS adapter interface
 *          (search, fetchContent, upload, testConnection). Bearer-authenticated.
 * Dependencies: global fetch (Node >=22)
 */

const REQUEST_TIMEOUT_MS = 8000;

export class PapraAdapter {
  constructor(account) {
    this.provider = 'papra';
    this.base = String(account.base_url || '').replace(/\/+$/, '');
    this.token = account.api_token;
    this.orgId = account.org_id;
  }

  headers(extra = {}) {
    return { Authorization: `Bearer ${this.token}`, Accept: 'application/json', ...extra };
  }

  async #request(path, opts = {}) {
    const res = await fetch(`${this.base}${path}`, {
      ...opts,
      headers: this.headers(opts.headers),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    if (!res.ok) {
      const err = new Error(`DMS request failed (${res.status})`);
      err.status = res.status;
      throw err;
    }
    return res;
  }

  #orgPath() {
    return `/api/organizations/${encodeURIComponent(this.orgId)}`;
  }

  docUrl(id) {
    return `${this.base}/documents/${encodeURIComponent(this.orgId)}/${id}`;
  }

  async search(query, { limit = 20 } = {}) {
    const q = String(query || '').trim();
    if (!q) return [];
    const params = new URLSearchParams({ searchQuery: q, pageSize: String(limit) });
    const res = await this.#request(`${this.#orgPath()}/documents?${params.toString()}`);
    const body = await res.json();
    return (body.documents || []).map((r) => ({
      id: String(r.id),
      title: r.name || r.originalName || r.id,
      created: r.createdAt || null,
      filename: r.originalName || String(r.id),
      url: this.docUrl(r.id),
    }));
  }

  async getDocument(id) {
    const res = await this.#request(`${this.#orgPath()}/documents/${encodeURIComponent(id)}`);
    const body = await res.json();
    const r = body.document ?? body;
    return {
      id: String(r.id),
      title: r.name || r.originalName || String(r.id),
      created: r.createdAt || null,
      filename: r.originalName || String(r.id),
      url: this.docUrl(r.id),
      correspondent: null,
      tags: Array.isArray(r.tags) ? r.tags : [],
    };
  }

  async fetchContent(id) {
    const res = await this.#request(`${this.#orgPath()}/documents/${encodeURIComponent(id)}/file`);
    const arrayBuf = await res.arrayBuffer();
    return {
      buffer: Buffer.from(arrayBuf),
      mime: res.headers.get('content-type') || 'application/octet-stream',
    };
  }

  async upload({ buffer, filename, mime, title }) {
    if (!filename) throw new Error('DMS upload requires a filename');
    const form = new FormData();
    form.append('file', new Blob([buffer], { type: mime || 'application/octet-stream' }), filename);
    const res = await this.#request(`${this.#orgPath()}/documents`, { method: 'POST', body: form });
    const body = await res.json();
    const doc = body.document ?? body;
    return { taskId: String(doc.id) };
  }

  async testConnection() {
    try {
      const res = await fetch(`${this.base}/api/api-keys/current`, {
        headers: this.headers(),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
      return { ok: res.ok, status: res.status };
    } catch (err) {
      return { ok: false, status: 0, error: err.message };
    }
  }
}
