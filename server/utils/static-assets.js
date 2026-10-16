/**
 * Modul: Statische Dateien - Inhalts-ETag, Kommentare und Brotli aus dem Speicher
 * Zweck: Drei Transportfragen der Dateien unter public/. Der Quelltext bleibt,
 *        wie er ist (R18: Kommentare bleiben im Code); was das Haus verlaesst,
 *        traegt sie seit R19 nicht mehr (Punkt 4, docs/DECISIONS.md #13).
 * Abhaengigkeiten: node:crypto, node:fs, node:zlib, ./strip-comments.js - keine Pakete
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
 *    bekommt die fertige Fassung.
 *
 * 4. KOMMENTARE BLEIBEN IM REPO, NICHT AUF DER LEITUNG (Critique R19). Eigene
 *    .js/.mjs- und .css-Dateien werden beim ersten Abruf von Kommentaren
 *    befreit (strip-comments.js, Zeilen bleiben stehen) und so im Speicher
 *    gehalten; Brotli rechnet auf DIESER Fassung. Gemessen ueber public/: JS
 *    nach Brotli 2,0 -> 0,9 MB, CSS 621 -> 129 KB. Nicht angefasst werden
 *    /vendor/ und *.min.js (fremder Code samt Lizenzkopf). Der ETag gehoert zu
 *    den Bytes, die tatsaechlich gehen: die geschnittene Fassung traegt den
 *    Hash der geschnittenen Bytes, der Weg ueber express.static (nur noch hinter
 *    der Bremse) den der Datei - gleicher ETag heisst weiter gleicher Inhalt.
 *    Eine geschnittene Datei ohne Brotli-Fassung liefert dieser Weg selbst aus;
 *    gzip uebernimmt dabei compression() wie bisher. Ein `Range` wird fuer
 *    geschnittene Dateien uebergangen (200 statt 206 - erlaubt, und kein
 *    Browser fragt Skripte stueckweise).
 *
 * Alles haengt an (Aenderungszeit, Groesse) der Datei: aendert sie sich im
 * laufenden Betrieb, werden Hash, Schnitt und Fassung neu gebildet.
 *
 * 3. DER SPEICHER HAT EINE GRENZE, UND SEIN SCHLUESSEL IST DIE DATEI. Diese
 *    Dateien sind ohne Anmeldung abrufbar; was hier je Anfrage waechst, waechst
 *    fuer jeden im Netz. Zuerst war der Schluessel der Pfad aus der Adresse und
 *    die Obergrenze nur ein Satz im Kommentar ("hoechstens die 4,89 MB"). Ein
 *    Pfad ist aber keine Datei: auf einem Dateisystem ohne Gross-/Klein-
 *    schreibung sind /app.js, /App.js und /APP.JS dieselbe, und jeder Symlink
 *    ist ein zweiter Name. Jede Schreibweise bekam einen eigenen Eintrag, einen
 *    eigenen Hash-Lauf, einen Platz in der Schlange (bis 1,9 s Rechenzeit) und
 *    eine eigene Kopie im Speicher - unbegrenzt. Deshalb:
 *      - Schluessel ist der AUFGELOESTE Pfad (realpath). Der muss unter dem
 *        aufgeloesten Wurzelverzeichnis liegen; ein Link nach draussen wird
 *        hier weder gemerkt noch komprimiert.
 *      - Zwei harte Grenzen, die nicht von einer Annahme ueber public/ leben:
 *        MAX_STORED_BYTES fuer die Summe der Brotli-Fassungen (darueber liefert
 *        compression() wie bisher) und MAX_ENTRIES fuer die gemerkten Dateien
 *        (der aelteste Eintrag geht zuerst).
 *      - Eine Bremse je Absender VOR dem Speicher (server/index.js): der Weg
 *        liest je Anfrage das Dateisystem (stat, realpath, beim ersten Mal die
 *        ganze Datei fuer den Hash). Ueber der Grenze wird NICHT abgewiesen -
 *        ein 429 auf ein Stylesheet zerlegte die App -, sondern nur am
 *        Speicher vorbeigefuehrt (`overLimit`): die Datei kommt dann wie vor
 *        R18 durch express.static und compression().
 *    Guard: test:static-assets, Abschnitt 2b - gegen die Fassung davor rot.
 */

import { createHash } from 'node:crypto';
import { readFileSync, realpathSync, statSync } from 'node:fs';
import path from 'node:path';
import { brotliCompress, constants as zlib } from 'node:zlib';
import { stripCssComments, stripJsComments } from './strip-comments.js';

/** Was sich zu komprimieren lohnt. Bilder und Schriften sind es schon. */
export const COMPRESSIBLE_EXTENSIONS = new Set([
  '.js', '.mjs', '.css', '.json', '.html', '.svg', '.txt', '.xml', '.webmanifest',
]);

/** Darunter spart die Kodierung nichts - dieselbe Schwelle wie compression(). */
const MIN_BYTES = 1024;

const BROTLI_QUALITY = 11;

/**
 * Obergrenzen des Speichers (siehe Kopf, Punkt 3). Die Textdateien unter
 * public/ wiegen in Stufe 11 rund 4,9 MB und sind rund 330; beide Grenzen
 * liegen eine Groessenordnung darueber und sind trotzdem klein gegen den
 * Prozess. Sie sollen im Normalbetrieb nie greifen.
 */
const MAX_STORED_BYTES = 64 * 1024 * 1024;
const MAX_ENTRIES = 4096;

/** Merker an der Anfrage: die Bremse hat sie am Speicher vorbeigeschickt. */
const BYPASS = Symbol('static-assets.bypass');

/**
 * @param {string} root - Verzeichnis, aus dem express.static ausliefert
 * @param {object} [options]
 * @param {boolean} [options.brotli=true] - `false` laesst nur den Inhalts-ETag
 * @param {(res: import('express').Response, filePath: string) => void} [options.setHeaders]
 *   dieselbe Funktion, die express.static bekommt - Cache-Control und
 *   Content-Type sollen fuer beide Wege aus EINER Stelle kommen
 * @param {(buffer: Buffer, options: object, cb: Function) => void} [options.compress]
 *   fuer Tests austauschbar
 * @param {number} [options.maxBytes] - Summe der Brotli-Fassungen im Speicher
 * @param {number} [options.maxEntries] - Zahl der gemerkten Dateien
 * @param {boolean} [options.strip=true] - Kommentare aus eigenem JS/CSS schneiden
 */
export function createStaticAssets(root, {
  brotli = true,
  strip = true,
  setHeaders = () => {},
  compress = brotliCompress,
  maxBytes = MAX_STORED_BYTES,
  maxEntries = MAX_ENTRIES,
} = {}) {
  const rootDir = path.resolve(root);
  // Auch die Wurzel aufloesen: unter macOS ist /tmp selbst ein Link, und der
  // Vergleich unten muss zwei aufgeloeste Pfade nebeneinanderhalten.
  const rootReal = realPath(rootDir) ?? rootDir;
  /**
   * Schluessel: der aufgeloeste Pfad der Datei, nie der aus der Adresse.
   * `etag` gehoert zu den Bytes, die dieser Weg sendet (geschnitten, wenn es
   * `body` gibt), `fileEtag` zur Datei, wie express.static sie sendet.
   * @type {Map<string, { mtimeMs: number, size: number, etag: string, fileEtag: string, body: Buffer|null, br: Buffer|null, queued: boolean, declined: boolean }>}
   */
  const entries = new Map();
  const queue = [];
  let working = false;
  let storedBytes = 0;

  function realPath(filePath) {
    try {
      return realpathSync.native(filePath);
    } catch {
      return null;
    }
  }

  /** Der eine Name der Datei - oder null, wenn sie nicht unter der Wurzel liegt. */
  function canonical(filePath) {
    const real = realPath(filePath);
    if (!real) return null;
    if (real !== rootReal && !real.startsWith(rootReal + path.sep)) return null;
    return real;
  }

  // Schwach (W/): derselbe ETag steht an der unkomprimierten und an jeder
  // komprimierten Fassung, und die sind nicht bytegleich.
  const hashBytes = (bytes) => `W/"${createHash('sha1').update(bytes).digest('base64url')}"`;
  const hashOf = (filePath) => hashBytes(readFileSync(filePath));

  /** Der Schnitt fuer diese Datei, oder null (fremder Code, anderes Format). */
  function stripperFor(key) {
    if (!strip) return null;
    const rel = path.relative(rootReal, key).split(path.sep);
    if (rel[0] === 'vendor' || key.endsWith('.min.js')) return null;
    const ext = path.extname(key).toLowerCase();
    if (ext === '.js' || ext === '.mjs') return stripJsComments;
    if (ext === '.css') return stripCssComments;
    return null;
  }

  function forget(key) {
    const entry = entries.get(key);
    if (!entry) return;
    if (entry.br) storedBytes -= entry.br.length;
    if (entry.body) storedBytes -= entry.body.length;
    entries.delete(key);
  }

  /**
   * Der Eintrag zur Datei in ihrem JETZIGEN Stand; liest sie beim ersten Mal.
   * `key` ist ein Ergebnis von canonical().
   */
  function entryFor(key, stat) {
    const known = entries.get(key);
    if (known && known.mtimeMs === stat.mtimeMs && known.size === stat.size) return known;
    // Die Datei hat sich geaendert: die alte Fassung zaehlt nicht weiter.
    forget(key);
    const source = readFileSync(key);
    const fileEtag = hashBytes(source);
    let body = null;
    const stripper = stripperFor(key);
    if (stripper) {
      try {
        const cut = Buffer.from(stripper(source.toString('utf8')), 'utf8');
        // Nur wenn es etwas spart und Platz ist; sonst geht die Datei wie sie ist.
        if (cut.length < source.length && storedBytes + cut.length <= maxBytes) body = cut;
      } catch { /* ein Fehler im Schnitt liefert die Datei unveraendert */ }
    }
    if (body) storedBytes += body.length;
    const entry = {
      mtimeMs: stat.mtimeMs, size: stat.size, etag: body ? hashBytes(body) : fileEtag, fileEtag,
      body, br: null, queued: false, declined: false,
    };
    entries.set(key, entry);
    // Eine Map haelt die Einfuegereihenfolge: der erste Schluessel ist der
    // aelteste. Steht er noch in der Schlange, verwirft compressNext() sein
    // Ergebnis, weil der Eintrag nicht mehr der gemerkte ist.
    while (entries.size > maxEntries) forget(entries.keys().next().value);
    return entry;
  }

  function compressNext() {
    if (working) return;
    const job = queue.shift();
    if (!job) return;
    working = true;
    const { filePath, entry } = job;
    let source = entry.body;
    if (!source) {
      try {
        source = readFileSync(filePath);
      } catch {
        working = false;
        entry.queued = false;
        compressNext();
        return;
      }
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
      if (!err && entries.get(filePath) === entry && source.length === (entry.body ? entry.body.length : entry.size) && result.length < source.length) {
        if (storedBytes + result.length <= maxBytes) {
          entry.br = result;
          storedBytes += result.length;
        } else {
          // Voll. Die Datei bleibt bei compression() und wird nicht bei jeder
          // Anfrage wieder gerechnet - sonst waere die Grenze nur eine fuer
          // den Speicher und keine fuer die Rechenzeit.
          entry.declined = true;
        }
      }
      compressNext();
    });
  }

  function schedule(filePath, entry) {
    if (entry.queued || entry.br || entry.declined) return;
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
    if (decoded.includes('\0') || decoded.split(/[\\/]/).some((segment) => segment.startsWith('.'))) return null;
    // Erst normalisieren, dann pruefen, dann benutzen - in dieser Reihenfolge
    // und als eigene Zeile, damit die Pruefung die ist, die jeder Leser (und
    // jeder Pfad-Analysator) als solche erkennt.
    const filePath = path.resolve(rootDir, `.${path.sep}${decoded}`);
    if (!filePath.startsWith(rootDir + path.sep)) return null;
    return filePath;
  }

  return {
    /**
     * Der Inhalts-ETag einer Datei, fuer `setHeaders` von express.static.
     * Synchron: `send` fragt die Header in einem Ereignis ab und prueft gleich
     * danach, ob die Anfrage damit frisch ist (304).
     */
    etagFor(filePath, stat) {
      const key = canonical(filePath);
      // Ein Link nach draussen (express.static folgt ihm) bekommt seinen
      // Inhalts-ETag, wird aber nicht gemerkt: der Speicher gehoert public/.
      if (!key) return hashOf(filePath);
      // express.static sendet die Datei, wie sie ist: also deren Hash.
      return entryFor(key, stat ?? statSync(key)).fileEtag;
    },

    /**
     * Liefert die Brotli-Fassung aus dem Speicher, wenn es sie gibt; sonst
     * `next()` - express.static und compression() uebernehmen wie bisher.
     */
    // Benannt: der Guard ueber die globalen Middlewares (test:restore-gate-routes)
    // fuehrt jede mit Namen und Begruendung.
    middleware: function serveCompressedStatic(req, res, next) {
      if (req[BYPASS]) return next();
      if (req.method !== 'GET' && req.method !== 'HEAD') return next();
      const filePath = resolveFile(req.path);
      if (!filePath || !COMPRESSIBLE_EXTENSIONS.has(path.extname(filePath).toLowerCase())) return next();

      let stat;
      try {
        stat = statSync(filePath);
      } catch {
        return next();
      }
      if (!stat.isFile()) return next();

      const key = canonical(filePath);
      if (!key) return next();
      const entry = entryFor(key, stat);
      const length = entry.body ? entry.body.length : stat.size;
      // Teilabrufe rechnen in Bytes der unkomprimierten Datei - Brotli gibt es
      // dafuer nicht. Eine geschnittene Datei geht trotzdem ganz (Kopf, Punkt 4).
      const wantsBr = brotli && !req.headers.range && length >= MIN_BYTES && req.acceptsEncodings('br');
      if (wantsBr && !entry.br) schedule(key, entry);
      if (!(wantsBr && entry.br) && !entry.body) return next();

      res.type(path.extname(filePath));
      setHeaders(res, filePath, stat);
      res.setHeader('ETag', entry.etag);
      res.setHeader('Last-Modified', stat.mtime.toUTCString());
      res.vary('Accept-Encoding');
      if (req.fresh) return res.status(304).end();
      if (wantsBr && entry.br) {
        res.setHeader('Content-Encoding', 'br');
        res.setHeader('Content-Length', entry.br.length);
        if (req.method === 'HEAD') return res.end();
        return res.end(entry.br);
      }
      // Geschnitten, ohne Brotli-Fassung: compression() oben packt gzip, wenn
      // der Browser es annimmt, sonst geht die Fassung unkomprimiert.
      res.setHeader('Content-Length', entry.body.length);
      if (req.method === 'HEAD') return res.end();
      return res.end(entry.body);
    },

    /**
     * `handler` der Bremse vor dem Speicher: ueber der Grenze kein 429, die
     * Anfrage geht nur am Speicher vorbei (siehe Kopf, Punkt 3).
     */
    overLimit(req, _res, next) {
      req[BYPASS] = true;
      next();
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
