/**
 * Modul: Statische Dateien - Inhalts-ETag und Brotli aus dem Speicher
 * Zweck: Zwei Transportfragen der Dateien unter public/, nichts am Inhalt
 *        (Entscheidung 2026-10-07, Critique R18: Kommentare bleiben im Code,
 *        gespart wird beim Uebertragen).
 * Abhaengigkeiten: node:crypto, node:fs, node:zlib - keine Pakete
 *
 * 1. ETAG AUS DEM INHALT. express.static bildet ihn aus Groesse und
 *    Aenderungszeit. Die Aenderungszeit ist aber eine Eigenschaft der
 *    Installation, nicht der Datei: ein neues Image traegt fuer JEDE Datei eine
 *    neue, auch fuer die 300, die sich nicht geaendert haben - und eine Datei,
 *    die sich bei gleicher Groesse und gleicher Zeit aendert, behielte ihren.
 *    Der Service Worker revalidiert beim Precache (`no-cache`) und verlaesst
 *    sich darauf, dass ein gleicher ETag gleichen Inhalt heisst. Deshalb ein
 *    Hash: er aendert sich genau dann, wenn sich die Datei aendert.
 *
 * 2. BROTLI AUF HOHER STUFE, EINMAL JE DATEI. Die compression()-Middleware
 *    komprimiert bei jeder Anfrage neu und deshalb auf niedriger Stufe (4).
 *    Hier liegt die Fassung der Stufe 11 im Speicher. Gemessen ueber die 325
 *    Textdateien unter public/ (21,05 MB): 4,89 MB statt 5,88 MB - aber 25 s
 *    Rechenzeit, die laengste Datei 1,9 s. Deshalb NICHT beim Start und nicht
 *    im Weg einer Anfrage: die erste Anfrage nach einer Datei geht wie bisher
 *    durch compression(), stoesst die Kompression im Hintergrund an (zlib
 *    rechnet im Threadpool, eine Datei nach der anderen), und jede weitere
 *    bekommt die fertige Fassung. Der Speicher waechst hoechstens um die 4,89 MB.
 *
 * Beides haengt an (Aenderungszeit, Groesse) der Datei: aendert sie sich im
 * laufenden Betrieb, werden Hash und Fassung neu gebildet.
 */

import { createHash } from 'node:crypto';
import { readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { brotliCompress, constants as zlib } from 'node:zlib';

/** Was sich zu komprimieren lohnt. Bilder und Schriften sind es schon. */
export const COMPRESSIBLE_EXTENSIONS = new Set([
  '.js', '.mjs', '.css', '.json', '.html', '.svg', '.txt', '.xml', '.webmanifest',
]);

/** Darunter spart die Kodierung nichts - dieselbe Schwelle wie compression(). */
const MIN_BYTES = 1024;

const BROTLI_QUALITY = 11;

/**
 * @param {string} root - Verzeichnis, aus dem express.static ausliefert
 * @param {object} [options]
 * @param {boolean} [options.brotli=true] - `false` laesst nur den Inhalts-ETag
 * @param {(res: import('express').Response, filePath: string) => void} [options.setHeaders]
 *   dieselbe Funktion, die express.static bekommt - Cache-Control und
 *   Content-Type sollen fuer beide Wege aus EINER Stelle kommen
 * @param {(buffer: Buffer, options: object, cb: Function) => void} [options.compress]
 *   fuer Tests austauschbar
 */
export function createStaticAssets(root, { brotli = true, setHeaders = () => {}, compress = brotliCompress } = {}) {
  const rootDir = path.resolve(root);
  /** @type {Map<string, { mtimeMs: number, size: number, etag: string, br: Buffer|null, queued: boolean }>} */
  const entries = new Map();
  const queue = [];
  let working = false;

  /** Der Eintrag zur Datei in ihrem JETZIGEN Stand; liest sie beim ersten Mal. */
  function entryFor(filePath, stat) {
    const known = entries.get(filePath);
    if (known && known.mtimeMs === stat.mtimeMs && known.size === stat.size) return known;
    const hash = createHash('sha1').update(readFileSync(filePath)).digest('base64url');
    // Schwach (W/): derselbe ETag steht an der unkomprimierten und an jeder
    // komprimierten Fassung, und die sind nicht bytegleich.
    const entry = { mtimeMs: stat.mtimeMs, size: stat.size, etag: `W/"${hash}"`, br: null, queued: false };
    entries.set(filePath, entry);
    return entry;
  }

  function compressNext() {
    if (working) return;
    const job = queue.shift();
    if (!job) return;
    working = true;
    const { filePath, entry } = job;
    let source;
    try {
      source = readFileSync(filePath);
    } catch {
      working = false;
      entry.queued = false;
      compressNext();
      return;
    }
    compress(source, {
      params: {
        [zlib.BROTLI_PARAM_QUALITY]: BROTLI_QUALITY,
        [zlib.BROTLI_PARAM_MODE]: zlib.BROTLI_MODE_TEXT,
        [zlib.BROTLI_PARAM_SIZE_HINT]: source.length,
      },
    }, (err, result) => {
      working = false;
      entry.queued = false;
      // Nur uebernehmen, wenn es noch der Stand ist, der gelesen wurde, und
      // wenn es sich lohnt. Ein Fehler laesst die Datei bei compression().
      if (!err && entries.get(filePath) === entry && source.length === entry.size && result.length < source.length) {
        entry.br = result;
      }
      compressNext();
    });
  }

  function schedule(filePath, entry) {
    if (entry.queued || entry.br) return;
    entry.queued = true;
    queue.push({ filePath, entry });
    compressNext();
  }

  /** URL-Pfad -> Datei unter root, oder null (kein Ausbruch, keine Dotfiles). */
  function resolveFile(urlPath) {
    let decoded;
    try {
      decoded = decodeURIComponent(urlPath);
    } catch {
      return null;
    }
    if (decoded.includes('\0') || decoded.split('/').some((segment) => segment.startsWith('.'))) return null;
    const filePath = path.join(rootDir, decoded);
    if (filePath !== rootDir && !filePath.startsWith(rootDir + path.sep)) return null;
    return filePath;
  }

  return {
    /**
     * Der Inhalts-ETag einer Datei, fuer `setHeaders` von express.static.
     * Synchron: `send` fragt die Header in einem Ereignis ab und prueft gleich
     * danach, ob die Anfrage damit frisch ist (304).
     */
    etagFor(filePath, stat) {
      return entryFor(filePath, stat ?? statSync(filePath)).etag;
    },

    /**
     * Liefert die Brotli-Fassung aus dem Speicher, wenn es sie gibt; sonst
     * `next()` - express.static und compression() uebernehmen wie bisher.
     */
    // Benannt: der Guard ueber die globalen Middlewares (test:restore-gate-routes)
    // fuehrt jede mit Namen und Begruendung.
    middleware: function serveCompressedStatic(req, res, next) {
      if (!brotli || (req.method !== 'GET' && req.method !== 'HEAD')) return next();
      // Teilabrufe rechnen in Bytes der unkomprimierten Datei.
      if (req.headers.range) return next();
      if (!req.acceptsEncodings('br')) return next();
      const filePath = resolveFile(req.path);
      if (!filePath || !COMPRESSIBLE_EXTENSIONS.has(path.extname(filePath).toLowerCase())) return next();

      let stat;
      try {
        stat = statSync(filePath);
      } catch {
        return next();
      }
      if (!stat.isFile() || stat.size < MIN_BYTES) return next();

      const entry = entryFor(filePath, stat);
      if (!entry.br) {
        schedule(filePath, entry);
        return next();
      }

      res.type(path.extname(filePath));
      setHeaders(res, filePath, stat);
      res.setHeader('ETag', entry.etag);
      res.setHeader('Last-Modified', stat.mtime.toUTCString());
      res.vary('Accept-Encoding');
      if (req.fresh) return res.status(304).end();
      res.setHeader('Content-Encoding', 'br');
      res.setHeader('Content-Length', entry.br.length);
      if (req.method === 'HEAD') return res.end();
      return res.end(entry.br);
    },

    /** Fuer Tests und die Messung: was liegt im Speicher? */
    stats() {
      let files = 0;
      let bytes = 0;
      for (const entry of entries.values()) {
        if (entry.br) {
          files += 1;
          bytes += entry.br.length;
        }
      }
      return { files, bytes, pending: queue.length + (working ? 1 : 0) };
    },
  };
}
