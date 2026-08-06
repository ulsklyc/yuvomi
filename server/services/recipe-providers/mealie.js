/**
 * Modul: Mealie API Adapter
 * Zweck: Bearer-authentifizierter Read-Only-Client gegen eine selbst gehostete
 *        Mealie-Instanz. Kein Schreibzugriff - Mealie bleibt Quelle der Wahrheit
 *        für Rezeptinhalte, dieser Adapter liest nur zum Spiegeln
 *        (recipe-provider-sync.js). Implementiert das gemeinsame Adapter-
 *        Interface aus ./index.js.
 *
 *        Requests laufen über den SSRF-gehärteten Client (server/utils/http.js),
 *        nicht über globales fetch(): base_url ist admin-eingegeben und muss
 *        deshalb dieselbe Anti-Rebinding-Prüfung (server/utils/ssrf.js) wie
 *        WebDAV-Dokumentenspeicher und ICS-Abos durchlaufen. Opt-in-Flag
 *        RECIPE_PROVIDER_ALLOW_PRIVATE_NETWORK hebt das gezielt auf (Docker-
 *        internes base_url).
 * Dependencies: server/utils/http.js (SSRF-gehärteter HTTP-Client),
 *               server/utils/ssrf.js, ./categorize.js
 */
import { categorizeIngredient } from './categorize.js';
import { safeRequest } from '../../utils/http.js';
import { createGuardedLookup, readPrivateNetworkOptIn } from '../../utils/ssrf.js';

const REQUEST_TIMEOUT_MS = 8000;
const PAGE_SIZE = 50;
const MAX_RESPONSE_BYTES = 10 * 1024 * 1024;
const MAX_THUMBNAIL_BYTES = 20 * 1024 * 1024;

const ENV_ALLOW_PRIVATE_NETWORK = 'RECIPE_PROVIDER_ALLOW_PRIVATE_NETWORK';

/**
 * Opt-in: erlaubt private/lokale Netzwerkziele für die Mealie-base_url (z. B.
 * ein Docker-internes Compose-Hostname). Hebt den SSRF-Schutz bewusst auf -
 * nur in kontrollierten Umgebungen setzen. Wird zur Laufzeit gelesen, damit
 * Tests process.env vor dem Aufruf setzen können.
 */
function isPrivateNetworkAllowed() {
  return readPrivateNetworkOptIn(ENV_ALLOW_PRIVATE_NETWORK);
}

/**
 * Request-Optionen inkl. Timeout und (sofern kein Opt-in gesetzt) dem
 * Anti-Rebinding-Lookup aus ssrf.js - gemeinsam für #request/testConnection/
 * fetchThumbnail, damit keine der drei Stellen den Guard vergisst.
 */
function guardedRequestOptions(headers) {
  const opts = { headers, signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) };
  if (!isPrivateNetworkAllowed()) opts.lookup = createGuardedLookup();
  return opts;
}

/**
 * Liest safeRequest()s Body-Stream größenbegrenzt in einen Buffer (Idiom aus
 * document-storage.js#readResponseBuffer) - global fetch()s eingebautes
 * res.json()/res.arrayBuffer() gibt es hier nicht, safeRequest liefert
 * stattdessen eine rohe Readable von Buffers.
 */
async function drainBody(res, maxBytes, tooLargeMessage) {
  const chunks = [];
  let total = 0;
  for await (const value of res.body) {
    const chunk = Buffer.from(value);
    total += chunk.byteLength;
    if (total > maxBytes) {
      res.body.destroy();
      throw new Error(tooLargeMessage);
    }
    chunks.push(chunk);
  }
  return Buffer.concat(chunks, total);
}

async function readJson(res) {
  const buffer = await drainBody(res, MAX_RESPONSE_BYTES, 'Mealie response exceeds the 10 MB limit.');
  return JSON.parse(buffer.toString('utf8'));
}

function formatQuantity(quantity, unit) {
  // Bewusst falsy-Check: Mealies eigene API defaultet quantity auf 0, wenn keine
  // Menge gesetzt ist (OpenAPI-Schema: "default": 0) - 0 ist dort also Mealies
  // eigenes Signal für "keine Menge", nicht ein echter Zutatenwert (niemand
  // schreibt "0 Tassen Mehl" in ein Rezept). quantity == null würde bei den
  // meisten mengenlosen Zutaten fälschlich eine "0" voranstellen.
  if (!quantity) return null;
  const amount = Number.isInteger(quantity) ? String(quantity) : String(Math.round(quantity * 100) / 100);
  if (!unit) return amount;
  const label = (unit.useAbbreviation && unit.abbreviation) || unit.name;
  return label ? `${amount} ${label}` : amount;
}

/**
 * Mealies recipeIngredient-Objekt (quantity/unit/food getrennt) auf das flache
 * name/quantity/category-Schema von recipe_ingredients abbilden. Ohne verknüpftes
 * food (freie Texteingabe in Mealie) übernimmt display/originalText die komplette
 * Zeile als Name, Menge bleibt leer - sie steckt dann schon im Text. Nur intern
 * gebraucht (innerhalb getRecipe()), kein anderes Modul importiert diese Funktion.
 */
function flattenIngredient(ing) {
  const foodName = ing.food?.name?.trim();
  const name = foodName || (ing.display || ing.originalText || '').trim() || '?';
  const quantity = foodName ? formatQuantity(ing.quantity, ing.unit) : null;
  const category = categorizeIngredient({ labelName: ing.food?.label?.name, foodName });
  return { name, quantity, category };
}

export class MealieAdapter {
  constructor(account) {
    this.provider = 'mealie';
    this.base = String(account.base_url || '').replace(/\/+$/, '');
    this.token = account.api_token;
    // `base_url` muss vom Server aus erreichbar sein (z. B. ein Docker-internes
    // Compose-Hostname) und ist deshalb oft für den Browser des Nutzers
    // blackholed. `external_url` ist die optionale, von außen erreichbare
    // Adresse fürs "In Mealie öffnen"-Link - fehlt sie, ist base_url auch von
    // außen erreichbar und dient als Fallback.
    this.linkBase = String(account.external_url || account.base_url || '').replace(/\/+$/, '');
  }

  headers(extra = {}) {
    return { Authorization: `Bearer ${this.token}`, Accept: 'application/json', ...extra };
  }

  async #request(path, opts = {}) {
    const reqOpts = { ...opts, ...guardedRequestOptions(this.headers(opts.headers)) };
    const res = await safeRequest(`${this.base}${path}`, reqOpts);
    if (!res.ok) {
      const err = new Error(`Mealie request failed (${res.status})`);
      err.status = res.status;
      throw err;
    }
    return res;
  }

  // GET /api/users/self validiert den Token und liefert gleich den groupSlug,
  // den recipeUrl() für den "In Mealie öffnen"-Link auf jedem Rezept braucht.
  async testConnection() {
    try {
      const res = await safeRequest(`${this.base}/api/users/self`, guardedRequestOptions(this.headers()));
      if (!res.ok) return { ok: false, status: res.status };
      const user = await readJson(res);
      return { ok: true, status: res.status, linkContext: { groupSlug: user.groupSlug || null } };
    } catch (err) {
      return { ok: false, status: 0, error: err.message };
    }
  }

  // Zusammenfassungen aller Rezepte (ohne Zutaten - die liefert erst getRecipe()
  // pro Rezept; die Mealie-Listenroute gibt bewusst nur Summaries zurück).
  // summary.id ist Mealies stabile UUID (Upsert-Key, überlebt Umbenennungen),
  // summary.slug wird als `ref` für den Detail-Abruf gebraucht.
  async listRecipeSummaries() {
    const summaries = [];
    let page = 1;
    let totalPages = 1;
    do {
      const res = await this.#request(`/api/recipes?page=${page}&perPage=${PAGE_SIZE}`);
      const body = await readJson(res);
      for (const item of body.items || []) {
        summaries.push({ id: item.id, ref: item.slug, updatedAt: item.updatedAt });
      }
      totalPages = body.total_pages || 1;
      page += 1;
    } while (page <= totalPages);
    return summaries;
  }

  async getRecipe(ref) {
    const res = await this.#request(`/api/recipes/${encodeURIComponent(ref)}`);
    const detail = await readJson(res);
    return {
      id: detail.id,
      updatedAt: detail.updatedAt,
      slug: detail.slug,
      title: detail.name,
      notes: detail.description || null,
      hasImage: Boolean(detail.image),
      ingredients: (detail.recipeIngredient || []).map(flattenIngredient),
    };
  }

  recipeUrl(linkContext, { slug }) {
    if (!linkContext?.groupSlug) return null;
    return `${this.linkBase}/g/${encodeURIComponent(linkContext.groupSlug)}/r/${encodeURIComponent(slug)}`;
  }

  // Mealies eigenes Thumbnail (min-original.webp, eine kleinere Ableitung des
  // Originalbilds) - über `this.base` (server-erreichbar), NICHT `this.linkBase`:
  // dies ist ein Server-zu-Server-Abruf mit Bearer-Token, kein Browser-Link.
  // Der Token darf den Client nie erreichen (server/routes/recipes.js proxied
  // die Bytes), deshalb kann kein <img src> direkt auf Mealie zeigen - die
  // Medien-Route dort verlangt denselben Bearer-Token wie jeder andere Endpunkt.
  async fetchThumbnail({ id }) {
    const url = `${this.base}/api/media/recipes/${encodeURIComponent(id)}/images/min-original.webp`;
    const res = await safeRequest(url, guardedRequestOptions(this.headers({ Accept: 'image/*' })));
    if (!res.ok) {
      const err = new Error(`Mealie thumbnail request failed (${res.status})`);
      err.status = res.status;
      throw err;
    }
    const buffer = await drainBody(res, MAX_THUMBNAIL_BYTES, 'Mealie thumbnail exceeds the 20 MB limit.');
    return { buffer, mime: res.headers.get('content-type') || 'image/webp' };
  }
}
