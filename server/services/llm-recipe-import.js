/**
 * Modul: LLM-Rezept-Import - der Kern
 * Zweck: Der ganze optionale Rezept-Import liegt hier, nicht in der Route:
 *        Prompt bauen, Antwort des Modells lesen, Rezept uebernehmen, das
 *        Quellmaterial holen und die Antwort der Quelle pruefen.
 *
 *        Die Route (server/routes/recipes.js) entscheidet nur noch, OB
 *        importiert wird (Schalter, Konfiguration, Berechtigung, Bremse) und
 *        legt das Ergebnis ab. Alles, was man testen will, ist hier eine
 *        Funktion mit einer `fetchImpl` - der Test ersetzt den Abruf, ohne
 *        einen Server zu brauchen.
 *
 *        Das Modell ist ein OpenAI-kompatibles Chat-Endpunkt
 *        (`<base_url>/chat/completions`). Der Admin traegt base_url, api_key
 *        und model ein; das Ziel darf im privaten Netz liegen (ein Ollama auf
 *        dem eigenen Rechner) - deshalb wird es hier NICHT mit dem SSRF-Waechter
 *        geprueft, sondern nur auf das Schema http(s)://.
 *
 *        Die QUELLE (die Rezept-Adresse, die der Nutzer eingibt) ist das
 *        Gegenteil: sie kommt vom Nutzer, und sie wird mit dem Waechter aus
 *        server/services/recipe-providers/private-network.js geprueft.
 *
 * Abhaengigkeiten: server/middleware/validate.js (Grenzen der Felder)
 */
import { MAX_TITLE, MAX_TEXT, MAX_SHORT } from '../middleware/validate.js';

/* Wie viel Text aus der Quelle dem Modell mitgegeben wird. Alles darueber
 * hinaus kostet nur Token und bringt nichts. */
export const LLM_IMPORT_MAX_SOURCE_LENGTH = 12_000;

/* Kuerzer als das ist kein Rezept, sondern ein Stichwort. */
export const LLM_IMPORT_MIN_TEXT_LENGTH = 40;

/* Fehler des Dienstes. `code` sagt der Route, welcher Fall es ist. */
export class LlmImportError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'LlmImportError';
    this.code = code;
  }
}

/* ── Die Bremse ───────────────────────────────────────────────────────────
 * Zehn Versuche je Nutzer und Stunde. Sie haelt den Endpunkt davon ab, als
 * Kopierbeilage zu dienen: jeder Versuch ist ein Aufruf beim Modell, und der
 * kostet Geld. Die Map haelt nur die Zeitfenster, nicht die Zahl - und die
 * wird beim Test ueber `configureLlmImportRateLimit` gestellt, damit der
 * Test nicht elfmal dasselbe tun muss.
 */
const rateBuckets = new Map();
let rateLimit = { limit: 10, windowMs: 60 * 60 * 1000 };

/**
 * Der Abruf, den die Route benutzt, wenn sie keinen eigenen mitgibt. Der Test
 * ersetzt ihn ueber `setLlmImportFetch` - so braucht die Suite keinen Server
 * und keinen Netzverkehr.
 */
let defaultFetchImpl = (...args) => fetch(...args);

/** Den Abruf der Route ersetzen (Test). */
export function setLlmImportFetch(fn) {
  defaultFetchImpl = typeof fn === 'function' ? fn : (...args) => fetch(...args);
}

/** Den Abruf der Route zuruecksetzen (Test, Serverstart). */
export function resetLlmImportFetch() {
  defaultFetchImpl = (...args) => fetch(...args);
}

/** Grenze der Bremse aendern (Test). */
export function configureLlmImportRateLimit(options = {}) {
  rateLimit = { ...rateLimit, ...options };
}

/** Alle Fenster loeschen (Test, Serverstart). */
export function resetLlmImportRateLimit() {
  rateBuckets.clear();
}

/**
 * Ein Versuch fuer diesen Nutzer. Antwortet, ob er durchgelassen wird.
 * @param {number|string} userId
 * @returns {{ allowed: boolean, remaining: number, retryInSeconds?: number }}
 */
export function consumeLlmImportQuota(userId) {
  const key = String(userId ?? 'anonymous');
  const now = Date.now();
  const bucket = rateBuckets.get(key);
  if (!bucket || bucket.resetAt <= now) {
    rateBuckets.set(key, { count: 1, resetAt: now + rateLimit.windowMs });
    return { allowed: true, remaining: rateLimit.limit - 1 };
  }
  if (bucket.count >= rateLimit.limit) {
    return { allowed: false, remaining: 0, retryInSeconds: Math.ceil((bucket.resetAt - now) / 1000) };
  }
  bucket.count += 1;
  return { allowed: true, remaining: rateLimit.limit - bucket.count };
}

/* ── Die Konfiguration ─────────────────────────────────────────────────── */

/**
 * Die base_url des Modells. Sie darf im privaten Netz liegen (ein Modell auf
 * dem eigenen Rechner), deshalb steht hier KEIN SSRF-Waechter - nur das
 * Schema. Eine URL, die kein http(s) ist, ist keine Konfiguration.
 * @param {string} raw
 * @returns {string|null}
 */
export function normalizeLlmBaseUrl(raw) {
  const value = String(raw ?? '').trim();
  if (!value) return null;
  let url;
  try { url = new URL(value); } catch { return null; }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
  return value.replace(/\/+$/, '');
}

/**
 * Ist die Konfiguration vollstaendig? Ohne Modell, Adresse oder Schluessel
 * kann der Dienst nichts fragen - das ist der Fall "not configured".
 * @param {{ baseUrl?: string|null, apiKey?: string|null, model?: string|null }} cfg
 */
export function isLlmImportConfigured(cfg) {
  return Boolean(normalizeLlmBaseUrl(cfg?.baseUrl) && String(cfg?.apiKey ?? '').trim() && String(cfg?.model ?? '').trim());
}

/**
 * Die gespeicherte Konfiguration lesen. Der Dienst kennt die Tabelle
 * `sync_config` (dieselbe wie die Einstellungen) - aber er schreibt sie nie.
 * @param {{ prepare: Function }} database
 */
export function readLlmImportConfig(database) {
  const get = (key) => {
    const row = database.prepare('SELECT value FROM sync_config WHERE key = ?').get(key);
    return row ? row.value : null;
  };
  return {
    enabled: get('llm_import_enabled') === '1',
    baseUrl: get('llm_base_url'),
    apiKey: get('llm_api_key'),
    model: get('llm_model'),
  };
}

/* ── Der Prompt ────────────────────────────────────────────────────────── */

const SYSTEM_PROMPT = [
  'Du extrahierst ein Rezept aus einem Text.',
  'Antworte AUSSCHLIESSLICH mit einem JSON-Objekt, ohne Text davor oder danach.',
  'Schema:',
  '{"title": string, "description": string, "ingredients": [{"name": string, "amount": number|null, "unit": string|null}],',
  ' "instructions": [string], "servings": number|null, "prep_time_minutes": number|null}',
  'Regeln: title ist der Name des Rezepts. ingredients sind die Zutaten mit Menge und Einheit.',
  'amount ist die Zahl, unit die Einheit (z. B. "g", "EL", "Stueck"). Ist keine Menge bekannt, ist amount null.',
  'instructions ist eine Liste der Zubereitungsschritte in Reihenfolge. servings ist die Zahl der Portionen, sonst null.',
].join(' ');

/**
 * Die Nachricht an das Modell: der Quelltext und die Bitte um das Schema.
 * @param {{ sourceText?: string|null, sourceUrl?: string|null }} source
 */
export function buildLlmMessages(source) {
  const material = String(source?.sourceText ?? '').trim();
  const quelle = material
    ? `Text des Rezepts:\n${material}`
    : `Adresse des Rezepts:\n${String(source?.sourceUrl ?? '').trim()}`;
  return [
    { role: 'system', content: SYSTEM_PROMPT },
    { role: 'user', content: `${quelle}\n\nExtrahiere das Rezept.` },
  ];
}

/* ── Die Antwort des Modells ───────────────────────────────────────────── */

/**
 * Das JSON aus der Antwort holen. Modelle schreiben gern ```json ... ``` um
 * die Antwort herum - das wird abgeschnitten, bevor geparst wird.
 * @param {string} raw
 */
export function extractJsonObject(raw) {
  const text = String(raw ?? '').trim();
  const ohneZaun = text.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/i, '').trim();
  const start = ohneZaun.indexOf('{');
  const end = ohneZaun.lastIndexOf('}');
  if (start === -1 || end === -1 || end <= start) return null;
  try { return JSON.parse(ohneZaun.slice(start, end + 1)); } catch { return null; }
}

/**
 * Die Antwort pruefen und in die Form bringen, die die Route kennt. Wirft
 * `LlmImportError('bad_response')`, wenn das Modell etwas anderes geliefert
 * hat als ein Rezept - eine Antwort, die kein Rezept ist, ist kein Rezept.
 * @param {string} raw - der Text der Antwort des Modells
 * @returns {object} { title, description, ingredients, instructions, servings, prep_time_minutes }
 */
export function parseLlmRecipeResponse(raw) {
  const parsed = extractJsonObject(raw);
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new LlmImportError('bad_response', 'The model did not return a recipe.');
  }
  return normalizeLlmRecipe(parsed);
}

/**
 * Dasselbe fuer ein Objekt, das schon da ist - der Weg ohne Modell: die
 * Vorschau, die der Dialog gezeigt hat, kommt als Objekt zurueck und wird
 * ohne einen zweiten Aufruf beim Modell uebernommen. Beide Wege nutzen diese
 * eine Ueberfuehrung, damit sie dasselbe Rezept ergeben.
 * @param {object} parsed
 * @returns {object}
 */
export function normalizeLlmRecipe(parsed) {
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new LlmImportError('bad_response', 'The model did not return a recipe.');
  }
  const title = typeof parsed.title === 'string' ? parsed.title.trim() : '';
  if (!title) throw new LlmImportError('bad_response', 'The recipe has no title.');

  const zutaten = Array.isArray(parsed.ingredients) ? parsed.ingredients : [];
  const ingredients = zutaten
    .filter((ing) => ing && typeof ing === 'object' && typeof ing.name === 'string' && ing.name.trim())
    .map((ing) => ({
      name: ing.name.trim(),
      amount: Number.isFinite(Number(ing.amount)) && ing.amount !== null && ing.amount !== ''
        ? Number(ing.amount)
        : null,
      unit: typeof ing.unit === 'string' && ing.unit.trim() ? ing.unit.trim() : null,
    }));

  const instructions = Array.isArray(parsed.instructions)
    ? parsed.instructions.filter((step) => typeof step === 'string' && step.trim()).map((step) => step.trim())
    : [];

  const servings = Number.isFinite(Number(parsed.servings)) && Number(parsed.servings) > 0
    ? Math.round(Number(parsed.servings))
    : null;
  const prep = Number.isFinite(Number(parsed.prep_time_minutes)) && Number(parsed.prep_time_minutes) > 0
    ? Math.round(Number(parsed.prep_time_minutes))
    : null;

  return {
    title,
    description: typeof parsed.description === 'string' ? parsed.description.trim() : '',
    ingredients,
    instructions,
    servings,
    prep_time_minutes: prep,
  };
}

/* ── Die Uebernahme in das Rezept der App ──────────────────────────────── */

/**
 * Die Menge einer Zutat als Text: "500 g", "2 EL" - oder leer, wenn nichts
 * bekannt ist. Die Spalte `quantity` ist ein TEXT (siehe die Anmerkung an der
 * Rezept-Route), darum wird hier aus Zahl und Einheit ein Satz gebaut.
 * @param {{ amount: number|null, unit: string|null }} zutat
 */
export function quantityText(zutat) {
  const amount = zutat?.amount ?? null;
  const unit = zutat?.unit ?? null;
  if (amount === null && !unit) return '';
  if (amount === null) return String(unit);
  const zahl = Number.isInteger(amount) ? String(amount) : String(amount).replace('.', ',');
  return unit ? `${zahl} ${unit}` : zahl;
}

/**
 * Der lesbare Block fuer das Notizfeld: Beschreibung, dann die Schritte in
 * ihrer Reihenfolge, dann die Zeit, falls das Modell eine nannte.
 * @param {object} rezept - das geparste Modell-Ergebnis
 * @returns {string}
 */
export function buildNotesBlock(rezept) {
  const abschnitte = [];
  const beschreibung = String(rezept?.description ?? '').trim();
  if (beschreibung) abschnitte.push(beschreibung);
  const schritte = Array.isArray(rezept?.instructions) ? rezept.instructions : [];
  if (schritte.length) {
    abschnitte.push(['Zubereitung:', ...schritte.map((step, i) => `${i + 1}. ${step}`)].join('\n'));
  }
  const zeit = Number(rezept?.prep_time_minutes ?? 0);
  if (Number.isFinite(zeit) && zeit > 0) abschnitte.push(`Zeit: ${Math.round(zeit)} Min.`);
  return abschnitte.join('\n\n');
}

/**
 * Das Modell-Ergebnis in das Rezept der App uebernehmen. Das ist die EINZIGE
 * Stelle, die das Modell-Schema auf das Schema der App uebertraegt - sie
 * wird von beiden Wegen benutzt (Import und bestaetigtes Uebernehmen), damit
 * beide dasselbe Rezept ergeben.
 * @param {object} rezept - geparstes Modell-Ergebnis
 * @param {{ recipeUrl?: string|null }} [opts]
 * @returns {{ title: string, notes: string, recipe_url: string|null, servings: number|null, ingredients: object[] }}
 */
export function mapLlmRecipeToRecipe(rezept, opts = {}) {
  const servings = Number(rezept?.servings ?? 0);
  return {
    title: String(rezept?.title ?? '').trim().slice(0, MAX_TITLE),
    notes: buildNotesBlock(rezept).slice(0, MAX_TEXT),
    recipe_url: opts.recipeUrl ? String(opts.recipeUrl).slice(0, MAX_TEXT) : null,
    servings: Number.isFinite(servings) && servings >= 1 && servings <= 99 ? Math.round(servings) : null,
    ingredients: (Array.isArray(rezept?.ingredients) ? rezept.ingredients : []).map((zutat) => ({
      name: String(zutat?.name ?? '').trim().slice(0, MAX_TITLE),
      quantity: quantityText(zutat).slice(0, MAX_SHORT),
      category: null,
    })).filter((zutat) => zutat.name),
  };
}

/* ── Die Quelle ────────────────────────────────────────────────────────── */

/**
 * HTML zu Text: der Modell liest besser einen Text als eine Seite voller
 * Marken. Skripte und Stile fallen weg, die Tags werden zu Leerzeichen, und
 * die Grundzeichen werden aufgeloest.
 * @param {string} html
 */
export function htmlToText(html) {
  return String(html ?? '')
    .replace(/<script\b[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style\b[\s\S]*?<\/style>/gi, ' ')
    .replace(/<noscript\b[\s\S]*?<\/noscript>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Die Quelle holen und zu Text machen. Der Abruf geht ueber `fetchImpl`, damit
 * der Test keinen Server braucht.
 * @param {string} url
 * @param {object} [opts]
 * @param {Function} [opts.fetchImpl]
 * @returns {Promise<string>}
 */
export async function fetchSourceText(url, { fetchImpl = defaultFetchImpl } = {}) {
  let res;
  try {
    res = await fetchImpl(url, {
      method: 'GET',
      redirect: 'follow',
      headers: { 'User-Agent': 'Yuvomi recipe import', Accept: 'text/html,text/plain' },
    });
  } catch (err) {
    throw new LlmImportError('source_unreachable', `The recipe page could not be fetched: ${err?.message ?? err}`);
  }
  if (!res?.ok) {
    throw new LlmImportError('source_unreachable', `The recipe page answered with ${res?.status ?? 'no status'}.`);
  }
  const body = await res.text();
  const text = htmlToText(body);
  if (!text) throw new LlmImportError('source_unreachable', 'The recipe page was empty.');
  return text.slice(0, LLM_IMPORT_MAX_SOURCE_LENGTH);
}

/* ── Der Abruf beim Modell ─────────────────────────────────────────────── */

/**
 * Das Modell fragen und seine Antwort lesen. Der Abruf geht ueber
 * `fetchImpl` - der Test ersetzt ihn.
 *
 * Alles, was das Modell nicht als Rezept liefert, ist `bad_response`: die
 * Route antwortet dann mit 502, weil die Fremdquelle die Anfrage nicht
 * erfuellt hat - nicht der Nutzer.
 *
 * @param {object} opts
 * @param {string} opts.baseUrl
 * @param {string} opts.apiKey
 * @param {string} opts.model
 * @param {{ sourceText?: string|null, sourceUrl?: string|null }} opts.source
 * @param {Function} [opts.fetchImpl]
 * @returns {Promise<object>} das geparste Rezept
 */
export async function requestLlmRecipe({ baseUrl, apiKey, model, source, fetchImpl = defaultFetchImpl }) {
  const ziel = `${normalizeLlmBaseUrl(baseUrl)}/chat/completions`;
  let res;
  try {
    res = await fetchImpl(ziel, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: 'Bearer ' + apiKey,
      },
      body: JSON.stringify({
        model,
        messages: buildLlmMessages(source),
        temperature: 0.2,
        response_format: { type: 'json_object' },
      }),
    });
  } catch (err) {
    throw new LlmImportError('bad_response', `The model could not be reached: ${err?.message ?? err}`);
  }
  if (!res?.ok) {
    throw new LlmImportError('bad_response', `The model answered with ${res?.status ?? 'no status'}.`);
  }
  let data;
  try { data = await res.json(); } catch { data = null; }
  const inhalt = data?.choices?.[0]?.message?.content;
  if (typeof inhalt !== 'string' || !inhalt.trim()) {
    throw new LlmImportError('bad_response', 'The model returned an empty answer.');
  }
  return parseLlmRecipeResponse(inhalt);
}
