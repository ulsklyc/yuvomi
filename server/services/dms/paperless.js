/**
 * Module: Paperless-ngx DMS Adapter
 * Purpose: Wrap the Paperless-ngx REST API behind the DMS adapter interface
 *          (search, fetchContent, upload, testConnection). Token-authenticated.
 * Dependencies: global fetch (Node >=22)
 */

const REQUEST_TIMEOUT_MS = 8000;

export class PaperlessAdapter {
  constructor(account) {
    this.provider = 'paperless';
    this.base = String(account.base_url || '').replace(/\/+$/, '');
    this.token = account.api_token;
  }

  headers(extra = {}) {
    return { Authorization: `Token ${this.token}`, Accept: 'application/json', ...extra };
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
}
