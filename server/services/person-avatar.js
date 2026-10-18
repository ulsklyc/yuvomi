/**
 * Modul: Das Profilbild einer Person als Adresse
 * Zweck: Die eine Stelle fuer `/api/v1/people/:id/avatar`: der SQL-Ausdruck,
 *        den Listen statt der Data-URL ausgeben, das Pfadmuster fuer die Gates
 *        in server/index.js und das Zerlegen der gespeicherten Data-URL.
 * Abhaengigkeiten: keine
 *
 * WARUM EINE ADRESSE STATT DES BILDES. `users.avatar_data` ist eine Data-URL
 * bis 768 KB (normalizeAvatarData in server/auth.js). In jeder Zeile einer
 * Liste haengend kam dasselbe Bild so oft mit, wie die Person zustaendig ist -
 * gemessen am 18.10.2026: 200 Aufgaben bei fuenf Bildern zu je rund 40 KB
 * machten `GET /tasks` 17 MB gross (430 Data-URLs), und gzip entdoppelt in
 * seinem 32-KB-Fenster kein 40-KB-Bild. Die Adresse ist rund 40 Zeichen lang;
 * das Bild laedt der Browser einmal je Person und haelt es per ETag.
 *
 * DIE FELDER BLEIBEN, NUR IHR WERT WECHSELT. Die Oberflaeche setzt jeden dieser
 * Werte als `<img src>`, und dort funktioniert eine Adresse wie eine Data-URL.
 *
 * WAS DABEI BLEIBT: Mitgliederlisten (`/family/members`, `users` in
 * `/dashboard`, die Konten in den Einstellungen) tragen jede Person EINMAL und
 * weiter die Data-URL - die Bearbeitungsmasken schicken genau diesen Wert
 * zurueck, eine Adresse kaeme als ungueltiges Bild an.
 *
 * `?v=` IST `users.avatar_key` (Migration 251): ein Zufallsschluessel, den ein
 * Trigger bei jedem neuen Bild neu wuerfelt. Er macht die Adresse je Bild
 * eindeutig - der Browser und der Offline-Cache des Service Workers zeigen nie
 * ein altes Bild unter ihr, deshalb darf die Route `immutable` sagen -, und er
 * ist nicht zu raten: die Route gibt das Bild nur mit ihm heraus. Wer die
 * Adresse nicht aus einer Zeile hat, die er lesen darf, bekommt es nicht.
 * Zwei Vorfassungen reichten nicht (Codex-Review zu #2056): die Laenge der
 * Data-URL blieb bei gleich langen Bildern stehen, und eine Zaehlversion liess
 * jede Sitzung per Durchzaehlen der ids auch Bilder von Personen holen, die sie
 * nie sieht (Hauspersonal, Ausgaben-Gaeste, deaktivierte Konten).
 */

/**
 * SQL-Ausdruck fuer die Bildadresse einer Person, `NULL` ohne Bild.
 * @param {string} alias Tabellenalias der `users`-Zeile, z. B. 'u'
 * @returns {string}
 */
export function personAvatarUrlSql(alias) {
  return `CASE WHEN ${alias}.avatar_key IS NOT NULL AND ${alias}.avatar_data IS NOT NULL AND ${alias}.avatar_data <> ''
    THEN '/api/v1/people/' || ${alias}.id || '/avatar?v=' || ${alias}.avatar_key END`;
}

/** Der Pfad der Route, so wie die Gates in server/index.js ihn sehen (ohne /api/v1). */
export const PERSON_AVATAR_PATH = /^\/people\/\d+\/avatar\/?$/i;

/** Darf diese Anfrage das Bild lesen, ohne ein Modulrecht zu brauchen? Nur GET. */
export function isPersonAvatarRead(method, path) {
  return String(method || '').toUpperCase() === 'GET' && PERSON_AVATAR_PATH.test(String(path || ''));
}

// NUR DIESE FELDER, nie ein beliebiger String: ein Titel oder Notiztext, der
// wie eine Bildadresse aussieht, ist eingetippter Text und bleibt es. Ein
// blindes Ersetzen haette ihn verfaelscht und die Antwort je Treffer um ein
// Bild bis 768 KB aufgeblaeht (Security-Review zu #2056). Die Liste ist die
// der Felder, die `personAvatarUrlSql()` befuellt; public/sw.js liest dieselben
// (test:sw-api-cache haelt beide gleich).
export const AVATAR_FIELDS = new Set([
  'assigned_avatar', 'avatar_data', 'creator_avatar', 'worker_avatar_data', 'user_avatar', 'person_avatar',
]);

const AVATAR_URL_RE = /^\/api\/v1\/people\/(\d+)\/avatar\?v=[0-9a-f]{32}$/;

/**
 * Ersetzt in einer Antwort jede Bildadresse wieder durch die Data-URL.
 *
 * FUER ANFRAGEN MIT API-TOKEN (Codex-Review zu #2056). Ein Client, der mit
 * Bearer-Token liest und den Wert in ein `<img src>` setzt, schickt beim
 * Bildabruf keinen `Authorization`-Header mit - die Adresse ergaebe 401, die
 * Data-URL ging. Integrationen sehen deshalb keine Aenderung; die Adresse
 * bekommt nur die App selbst (Cookie-Sitzung, Wanddisplay), deren Bildabruf
 * das Cookie mitnimmt.
 *
 * @param {unknown} payload die Antwort, wie `res.json()` sie bekommt
 * @param {(id: number) => string|null} lookup Data-URL einer Person
 * @returns {unknown} dieselbe Struktur, Adressen ersetzt (das Original bleibt)
 */
export function inlineAvatarUrls(payload, lookup) {
  const cache = new Map();
  const inline = (value) => {
    const match = typeof value === 'string' ? AVATAR_URL_RE.exec(value) : null;
    if (!match) return value;
    const id = Number(match[1]);
    if (!cache.has(id)) cache.set(id, lookup(id) ?? null);
    return cache.get(id);
  };
  const visit = (value) => {
    if (Array.isArray(value)) return value.map(visit);
    if (value && typeof value === 'object' && Object.getPrototypeOf(value) === Object.prototype) {
      const out = {};
      for (const [key, inner] of Object.entries(value)) {
        out[key] = AVATAR_FIELDS.has(key) ? inline(inner) : visit(inner);
      }
      return out;
    }
    return value;
  };
  return visit(payload);
}

const DATA_URL_RE = /^data:(image\/(?:png|jpeg|webp));base64,([a-z0-9+/=]+)$/i;

/**
 * Zerlegt eine gespeicherte Data-URL in Typ und Bytes.
 * @param {string|null|undefined} value
 * @returns {{ mime: string, bytes: Buffer }|null}
 */
export function parseAvatarDataUrl(value) {
  const match = DATA_URL_RE.exec(String(value ?? ''));
  if (!match) return null;
  return { mime: match[1].toLowerCase(), bytes: Buffer.from(match[2], 'base64') };
}
