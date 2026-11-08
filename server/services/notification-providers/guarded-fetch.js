/**
 * Modul: Gehaerteter HTTP-Aufruf fuer Benachrichtigungskanaele
 * Zweck: Webhook, Gotify und ntfy posten an eine URL, die ein Admin eingetragen
 *        hat. Bis GHSA-f4w5-ggcc-7m5c taten sie das mit dem nackten globalen
 *        fetch(): ohne den SSRF-Schutz, den ICS-Abos, Abo-Logos, WebDAV-Speicher
 *        und die Rezept-Spiegel laengst tragen. Ein Kanal mit dem Ziel
 *        http://169.254.169.254/ liess den Server so gegen die eigenen
 *        Cloud-Metadaten posten - mit einem Body, den die Webhook-Vorlage
 *        vollstaendig bestimmt.
 *
 *        Dieser Aufruf laeuft ueber denselben node-nativen Client wie die anderen
 *        Integrationen (utils/http.js) und traegt denselben Anti-Rebinding-Lookup
 *        aus utils/ssrf.js: geprueft wird die Adresse, mit der die Verbindung
 *        tatsaechlich aufgebaut wird, auf jedem Redirect-Hop. Nach aussen sieht
 *        er aus wie fetch (ok, status, json(), text()), damit die Provider ihre
 *        `fetchImpl`-Injektion fuer Tests behalten.
 *
 *        NOTIFICATION_ALLOW_PRIVATE_NETWORK=true hebt den Schutz bewusst auf -
 *        fuer den Gotify-Container im selben Compose-Netz oder den Home-
 *        Assistant-Webhook im LAN. Derselbe Schalter wie bei den ICS-Abos, mit
 *        demselben Default: aus. Ein Deploy-Schalter statt einer App-Einstellung,
 *        weil die Grenze zwischen App-Admin und Host-Betreiber genau hier verlaeuft.
 *
 * Abhaengigkeiten: utils/http.js, utils/ssrf.js
 */

import { safeRequest } from '../../utils/http.js';
import { createGuardedLookup, readPrivateNetworkOptIn } from '../../utils/ssrf.js';
import { NotificationProviderError } from './provider-error.js';

export const ENV_ALLOW_PRIVATE_NETWORK = 'NOTIFICATION_ALLOW_PRIVATE_NETWORK';

// Antworten der Zieldienste sind klein (Gotify: die angelegte Nachricht als
// JSON, ntfy: ein Ereignis-Objekt, Webhooks meist leer). Alles darueber ist
// kein Benachrichtigungsdienst.
const MAX_RESPONSE_BYTES = 1024 * 1024;

/** Zur Laufzeit gelesen, damit Tests process.env vor dem Aufruf setzen koennen. */
export function isPrivateNetworkAllowed() {
  return readPrivateNetworkOptIn(ENV_ALLOW_PRIVATE_NETWORK);
}

async function drainBody(body) {
  const chunks = [];
  let total = 0;
  for await (const value of body) {
    const chunk = Buffer.from(value);
    total += chunk.byteLength;
    if (total > MAX_RESPONSE_BYTES) {
      body.destroy();
      throw new NotificationProviderError('Notification target response exceeds the 1 MB limit.');
    }
    chunks.push(chunk);
  }
  return Buffer.concat(chunks, total);
}

/**
 * fetch-aehnlicher POST/GET mit SSRF-Schutz.
 *
 * @param {string} url
 * @param {object} [options]
 * @param {string} [options.method='GET']
 * @param {object} [options.headers={}]
 * @param {string|Buffer|URLSearchParams} [options.body]
 * @param {AbortSignal} [options.signal]
 * @param {Function} [options.lookup]  Fuer Tests injizierbar; sonst der Guard.
 */
export async function guardedFetch(url, { method = 'GET', headers = {}, body, signal, lookup } = {}) {
  const outHeaders = { ...headers };
  let outBody = body;
  if (body instanceof URLSearchParams) {
    outBody = body.toString();
    const hasType = Object.keys(outHeaders).some((h) => h.toLowerCase() === 'content-type');
    if (!hasType) outHeaders['content-type'] = 'application/x-www-form-urlencoded;charset=UTF-8';
  }
  const opts = { method, headers: outHeaders, body: outBody, signal };
  if (lookup) opts.lookup = lookup;
  else if (!isPrivateNetworkAllowed()) opts.lookup = createGuardedLookup();

  const res = await safeRequest(url, opts);
  // Eifrig lesen: eine ungelesene Antwort haelt den Socket offen, und die
  // Provider fragen den Body nur bei Gotify ueberhaupt ab.
  const buffer = await drainBody(res.body);
  const text = buffer.toString('utf8');
  return {
    ok: res.ok,
    status: res.status,
    headers: res.headers,
    text: async () => text,
    json: async () => JSON.parse(text),
  };
}

export default guardedFetch;
