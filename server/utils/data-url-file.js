/**
 * Modul: Datei aus einer base64-Data-URL lesen
 *
 * Dokumente (`content_data`) und Termin-Anhänge (`attachment_data`) nehmen
 * eine hochgeladene Datei als `data:<typ>;base64,<bytes>` an und prüften sie
 * in zwei Kopien desselben Ablaufs: Form, Typ aus der Allowlist, nicht leer,
 * höchstens die Upload-Grenze, Inhalt passt zum behaupteten Typ (#937). Die
 * Kalender-Kopie warf dabei, statt einen Befund zu liefern, und endete als 500
 * (#2810). Hier steht der Ablauf einmal; jede Route übersetzt den Befund in
 * ihren eigenen Satz, weil Dokumente ihre Sätze und Gründe schon länger nach
 * außen tragen.
 *
 * Wirft nie.
 */
import { contentMatchesMime } from './file-signature.js';

// Der Inhalt darf leer sein: eine leere Datei liest der Browser als
// `data:<typ>;base64,` - das ist der Fall "Datei ist leer" (#1909), keine
// kaputte Data-URL.
const DATA_URL = /^data:([^;,]+);base64,([A-Za-z0-9+/=\s]*)$/;

/**
 * @typedef {'shape' | 'type' | 'empty' | 'size' | 'content'} DataUrlFault
 * @typedef {{ mime: string, base64: string, size: number, buffer: Buffer }} DataUrlFile
 */

/**
 * @param {string} raw  die Data-URL, wie die Route sie liest
 * @param {{ allowed: Set<string>, maxBytes: number }} limits
 * @returns {{ file: DataUrlFile, fault: null } | { file: null, fault: DataUrlFault }}
 */
export function readDataUrlFile(raw, { allowed, maxBytes }) {
  const match = raw.match(DATA_URL);
  if (!match) return { file: null, fault: 'shape' };
  const mime = match[1].toLowerCase();
  if (!allowed.has(mime)) return { file: null, fault: 'type' };
  const base64 = match[2].replace(/\s/g, '');
  const buffer = Buffer.from(base64, 'base64');
  if (!buffer.length) return { file: null, fault: 'empty' };
  if (buffer.length > maxBytes) return { file: null, fault: 'size' };
  // Bis hier war nur GEPRUEFT, was der Absender BEHAUPTET: der Typ steht im
  // Praefix und kommt aus seinem Browser. Typen ohne Signatur - text/plain,
  // text/csv - passieren weiter.
  if (!contentMatchesMime(buffer, mime)) return { file: null, fault: 'content' };
  return { file: { mime, base64, size: buffer.length, buffer }, fault: null };
}
