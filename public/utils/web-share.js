/**
 * Teilen über das native Teilen-Menü des Geräts (Web Share API, D#1014).
 *
 * DIE EINE STELLE, die sagt, ob ein Dokument so weitergegeben werden kann. Zwei
 * Fragen, beide hier beantwortet, damit der Viewer sie nicht nachbaut:
 *
 *  1. Kennt die Web Share API den Typ überhaupt? Ihre Liste teilbarer Dateien
 *     enthält KEINE Office-Formate: von den zehn Upload-Typen in
 *     server/routes/documents.js (ALLOWED_MIME) sind sechs teilbar. Am
 *     03.09.2026 an MDN geprüft, nicht aus dem Gedächtnis - die Analogie
 *     "Download geht, also geht Teilen" hätte vier Typen unterschlagen.
 *  2. Kann DIESER Browser DIESE Datei teilen? Das entscheidet
 *     `navigator.canShare({ files })`, nicht `'share' in navigator`: Letzteres
 *     ist auch dort wahr, wo nur Links teilbar sind. `navigator.share()` gibt
 *     es nur im sicheren Kontext (HTTPS, localhost) - viele Installationen
 *     laufen im LAN über http://, dort fehlt die Funktion einfach.
 *
 * Geprüft wird mit einer LEEREN Probe-Datei des richtigen Typs, bevor irgendein
 * Byte geladen ist: der Viewer soll die Antwort beim Öffnen kennen und die
 * Datei nur dann holen, wenn Teilen überhaupt möglich ist.
 */

/** MIME ohne Parameter, klein: `text/plain; charset=utf-8` -> `text/plain`. */
function baseMime(value) {
  return String(value || '').split(';')[0].trim().toLowerCase();
}

/** Typen, die die Web Share API als Datei weitergeben kann (Teilmenge von ALLOWED_MIME). */
export const SHAREABLE_MIME = Object.freeze([
  'application/pdf',
  'image/png',
  'image/jpeg',
  'image/webp',
  'text/plain',
  'text/csv',
]);

/** true, wenn der Typ grundsätzlich teilbar ist - unabhängig vom Browser. */
export function isShareableMime(mime) {
  return SHAREABLE_MIME.includes(baseMime(mime));
}

/**
 * Warum Teilen für dieses Dokument (nicht) geht.
 * @param {{ name?: string, mime_type?: string }} doc
 * @param {{ navigator?: object, secure?: boolean, FileCtor?: typeof File }} [env] nur für Tests
 * @returns {'ok'|'type'|'insecure'|'browser'}
 *   'ok'       - Browser kann eine Datei dieses Typs teilen
 *   'type'     - der Typ steht nicht auf der Liste der Web Share API
 *   'insecure' - kein sicherer Kontext (http:// im LAN): dort gibt es
 *                navigator.share() gar nicht, HTTPS wuerde es aendern
 *   'browser'  - sicherer Kontext, aber kein navigator.share/canShare, oder
 *                der Browser lehnt die Probe-Datei ab: HTTPS aendert nichts
 *
 * ZWEI ANTWORTEN STATT EINER (Re-Critique 2026-09-25). Bis dahin hiess beides
 * 'unavailable', und der Hinweis musste beide Ursachen nennen - er schickte
 * Nutzer eines Desktop-Firefox, der ueber HTTPS kommt, auf die Suche nach
 * einer sicheren Verbindung, die sie laengst hatten.
 */
export function fileShareSupport(doc, env = {}) {
  if (!isShareableMime(doc?.mime_type)) return 'type';
  const nav = env.navigator ?? globalThis.navigator;
  const secure = env.secure ?? globalThis.isSecureContext === true;
  const FileCtor = env.FileCtor ?? globalThis.File;
  if (!secure) return 'insecure';
  if (!nav || typeof nav.share !== 'function' || typeof nav.canShare !== 'function' || typeof FileCtor !== 'function') {
    return 'browser';
  }
  try {
    const probe = new FileCtor([], doc?.name || 'document', { type: baseMime(doc?.mime_type) });
    return nav.canShare({ files: [probe] }) ? 'ok' : 'browser';
  } catch {
    return 'browser';
  }
}
