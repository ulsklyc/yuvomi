/**
 * Modul: Vorschaubilder lokaler Dokumente (Critique 2026-09-25, Entscheidung 2)
 * Zweck: Ein lokales Bild zeigt sich selbst, ein lokales PDF seine erste Seite -
 *        gerendert im Client, erst wenn die Kachel in den Blick kommt, hoechstens
 *        zwei gleichzeitig und nur bis 10 MB.
 *
 *        DER CACHE LEBT NUR IM SPEICHER DER SEITE. Die Dateien sind Arztbriefe,
 *        Ausweise, Kontoauszuege; ihre einzige Heimat ist die verschluesselte
 *        Datenbank. Eine Kopie in IndexedDB, localStorage oder der Cache-API
 *        laege unverschluesselt auf dem Geraet und ueberlebte die Abmeldung.
 *        Deshalb: eine Map, die mit dem Seiten-Signal faellt, und jeder Abruf
 *        mit `cache: 'no-store'` - so legt auch der HTTP-Cache des Browsers
 *        keine Kopie auf die Platte (die Vorschau-Route selbst antwortet mit
 *        `private, max-age=300`, das gilt fuer den Viewer, nicht fuer die Liste).
 *        Der Service Worker reicht `/api/v1/documents` ohnehin nur durch
 *        (API_CACHE_WHITELIST in sw.js; Guard in test-documents-ux.js).
 *
 *        Gespeichert wird ein verkleinertes Raster als data:-URL, keine
 *        Object-URL: die App-CSP erlaubt `img-src 'self' data:`, und `blob:`
 *        dafuer freizugeben hiesse die Richtlinie aller Seiten aufzuweiten.
 *        Die Zusage bleibt dieselbe - nichts verlaesst den Seitenspeicher, und
 *        beim Verlassen der Seite gibt clear() alles frei.
 *
 *        Fehler, die ein Dokument nun einmal haben kann (kaputte Datei,
 *        Passwortschutz, 404/415, offline), enden still in der Glyphe. Alles
 *        andere ist ein Programmierfehler und wird weitergeworfen - ein catch,
 *        das ihn verschluckte, liesse die Glyphe fuer immer stehen, ohne dass
 *        es je jemand merkt.
 *
 * Abhaengigkeiten: ./document-preview.js (MIME -> Renderer-Familie)
 */

import { previewKind } from './document-preview.js';

/** Obergrenze je Datei. Darueber bleibt die Glyphe - kein Abruf. */
export const THUMB_MAX_BYTES = 10 * 1024 * 1024;
/** Hoechstens so viele Vorschauen laden und rendern gleichzeitig. */
export const THUMB_CONCURRENCY = 2;
/** Breite des gespeicherten Rasters: die Rasterkarte ist bis ~360px breit, bei 2x DPR. */
export const THUMB_RASTER_WIDTH = 640;
/** Hoehenkappe, damit ein Kassenbon-Streifen nicht 4000px Raster behaelt. */
export const THUMB_RASTER_MAX_HEIGHT = 1280;

/** Speicherort eines Dokuments; alte Zeilen ohne `storage_backend` leiten ihn ab. */
export function documentStorageBackend(doc) {
  if (doc?.storage_backend) return doc.storage_backend;
  return doc?.storage_provider === 'external' ? 'dms' : 'local';
}

/**
 * Welche Vorschau ein Dokument bekommt: `'image'`, `'pdf'` oder `null`.
 * Nur lokal gespeicherte Dateien (WebDAV/Drive/DMS kaemen ueber das Netz eines
 * Dritten; Paperless hat seinen eigenen Thumbnail-Pfad), nur Bild oder PDF und
 * nur mit bekannter Groesse bis THUMB_MAX_BYTES.
 */
export function documentThumbKind(doc) {
  if (!doc || documentStorageBackend(doc) !== 'local') return null;
  const kind = previewKind(doc.mime_type);
  if (kind !== 'image' && kind !== 'pdf') return null;
  const size = Number(doc.file_size);
  if (!Number.isFinite(size) || size <= 0 || size > THUMB_MAX_BYTES) return null;
  return kind;
}

/** Cache-Schluessel: eine ersetzte Datei traegt ein neues `updated_at` und damit eine neue Vorschau. */
export function documentThumbKey(doc) {
  return `${doc.id}:${doc.updated_at || ''}`;
}

/** Die Datei, die eine Vorschau bekommt (dieselbe Route wie der Viewer). */
export function documentThumbUrl(doc) {
  return `/api/v1/documents/${encodeURIComponent(doc.id)}/preview`;
}

/** Ein erwartbarer Grund, warum ein Dokument keine Vorschau hat. */
export class ThumbUnavailableError extends Error {
  constructor(reason) {
    super(`thumbnail unavailable: ${reason}`);
    this.name = 'ThumbUnavailableError';
    this.reason = reason;
  }
}

// Die Ausnahmen, die pdf.js fuer eine kaputte, geschuetzte oder nicht
// erreichbare Datei wirft (4.x). Sie kommen aus dem Worker als eigene Klassen
// zurueck; der Name ist das, was die Grenze sicher uebersteht.
const PDFJS_EXPECTED = new Set([
  'InvalidPDFException',
  'MissingPDFException',
  'PasswordException',
  'UnexpectedResponseException',
  'UnknownErrorException',
  'RenderingCancelledException',
  'AbortException',
]);

/**
 * Gehoert ein Fehler zu denen, die eine Datei haben darf? Alles andere
 * (TypeError im eigenen Code, ReferenceError, ...) ist es nicht.
 * DOMException deckt die Browser-Seite ab: ein Bild, das sich nicht
 * dekodieren laesst (`InvalidStateError`/`EncodingError`), und AbortError.
 */
export function isExpectedThumbError(error) {
  if (!error) return false;
  if (error instanceof ThumbUnavailableError) return true;
  if (typeof DOMException !== 'undefined' && error instanceof DOMException) return true;
  return PDFJS_EXPECTED.has(error.name);
}

/**
 * Baut den Vorschau-Speicher einer Seite.
 *
 * @param {object} options
 * @param {AbortSignal} options.signal  faellt die Seite, faellt alles: Warteschlange,
 *                                      laufende Abrufe, Speicher, pdf.js-Worker
 * @param {{ image: Function, pdf: Function, dispose?: Function }} options.renderers
 *        `image(blob)`/`pdf(arrayBuffer)` liefern eine data:-URL oder werfen
 * @param {Function} [options.fetchImpl]
 * @param {number} [options.limit]
 */
export function createDocumentThumbs({
  signal,
  renderers,
  fetchImpl = (...args) => globalThis.fetch(...args),
  limit = THUMB_CONCURRENCY,
} = {}) {
  const store = new Map();
  const pending = new Map();
  const queue = [];
  let active = 0;

  const dead = () => Boolean(signal?.aborted);

  function pump() {
    while (active < limit && queue.length && !dead()) {
      const job = queue.shift();
      active += 1;
      job.run().then(job.resolve, job.reject).finally(() => {
        active -= 1;
        pump();
      });
    }
  }

  async function fetchFile(doc) {
    let response;
    try {
      response = await fetchImpl(documentThumbUrl(doc), {
        credentials: 'same-origin',
        // Keine Kopie im HTTP-Cache: siehe Modulkopf.
        cache: 'no-store',
        signal,
      });
    } catch (error) {
      // Ein abgebrochener oder gescheiterter Netzabruf. Der TypeError kommt
      // hier nur aus fetch() selbst - der eigene Code steht ausserhalb.
      if (error?.name === 'AbortError' || error instanceof TypeError) {
        throw new ThumbUnavailableError('network');
      }
      throw error;
    }
    if (!response.ok) throw new ThumbUnavailableError(`http ${response.status}`);
    const blob = await response.blob();
    // Die Groesse aus der Liste ist eine Angabe, die Antwort die Wahrheit.
    if (blob.size > THUMB_MAX_BYTES) throw new ThumbUnavailableError('too large');
    return blob;
  }

  async function produce(doc, kind) {
    const blob = await fetchFile(doc);
    if (dead()) return null;
    return kind === 'pdf'
      ? renderers.pdf(await blob.arrayBuffer())
      : renderers.image(blob);
  }

  /**
   * Die Vorschau eines Dokuments: data:-URL oder `null` (Glyphe bleibt).
   * Ein Dokument ohne Anspruch loest keinen Abruf aus; ein gescheitertes wird
   * im selben Seitenleben nicht noch einmal versucht.
   */
  function load(doc) {
    const kind = documentThumbKind(doc);
    if (!kind || dead()) return Promise.resolve(null);
    const key = documentThumbKey(doc);
    if (store.has(key)) return Promise.resolve(store.get(key));
    if (pending.has(key)) return pending.get(key);
    const promise = new Promise((resolve, reject) => {
      queue.push({ run: () => produce(doc, kind), resolve, reject });
      pump();
    }).then((url) => {
      pending.delete(key);
      if (dead()) return null;
      store.set(key, url || null);
      return url || null;
    }, (error) => {
      pending.delete(key);
      // Nach dem Verlassen der Seite ist jeder Fehler die Folge des Abbaus
      // (abgebrochener Abruf, beendeter Worker) - niemand wartet mehr darauf.
      if (dead()) return null;
      if (!isExpectedThumbError(error)) throw error;
      store.set(key, null);
      return null;
    });
    pending.set(key, promise);
    return promise;
  }

  /** Synchron aus dem Speicher: data:-URL, `null` (bekannt ohne Vorschau) oder `undefined`. */
  function peek(doc) {
    if (!documentThumbKind(doc)) return null;
    return store.get(documentThumbKey(doc));
  }

  function clear() {
    // Wartende Auftraege loesen mit `null` auf, statt ewig zu haengen.
    for (const job of queue.splice(0)) job.resolve(null);
    store.clear();
    pending.clear();
    renderers?.dispose?.();
  }

  signal?.addEventListener('abort', clear, { once: true });

  return {
    load,
    peek,
    clear,
    get size() { return store.size; },
    get active() { return active; },
    get queued() { return queue.length; },
  };
}

/* ---------------------------------------------------------------------------
 * Browser-Renderer. Bewusst getrennt vom Speicher oben, damit der als Programm
 * unter Node laeuft; diese Haelfte braucht Canvas, createImageBitmap und pdf.js.
 * ------------------------------------------------------------------------- */

function rasterSize(width, height) {
  const scale = Math.min(1, THUMB_RASTER_WIDTH / width, THUMB_RASTER_MAX_HEIGHT / height);
  return {
    width: Math.max(1, Math.round(width * scale)),
    height: Math.max(1, Math.round(height * scale)),
    scale,
  };
}

function canvasOf(width, height) {
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  return canvas;
}

/**
 * Renderer fuer die Seite. pdf.js wird erst beim ersten PDF geladen (so wie der
 * Viewer es tut: dynamischer Import, Worker aus /vendor, kein eval) und teilt
 * sich EINEN Worker fuer alle Vorschauen einer Seite; dispose() beendet ihn.
 */
export function browserThumbRenderers() {
  let pdfjsPromise = null;
  let worker = null;
  let disposed = false;

  const loadPdfjs = () => {
    if (!pdfjsPromise) {
      pdfjsPromise = import('/vendor/pdfjs/pdf.min.mjs').then((pdfjs) => {
        pdfjs.GlobalWorkerOptions.workerSrc = '/vendor/pdfjs/pdf.worker.min.mjs';
        return pdfjs;
      });
    }
    return pdfjsPromise;
  };

  async function image(blob) {
    if (typeof createImageBitmap !== 'function') throw new ThumbUnavailableError('no decoder');
    // Wirft eine DOMException, wenn die Datei kein lesbares Bild ist.
    const bitmap = await createImageBitmap(blob);
    try {
      const size = rasterSize(bitmap.width, bitmap.height);
      const canvas = canvasOf(size.width, size.height);
      canvas.getContext('2d').drawImage(bitmap, 0, 0, size.width, size.height);
      // PNG/WebP koennen Transparenz tragen; JPEG nicht. webp faellt in
      // Browsern ohne WebP-Encoder von selbst auf PNG zurueck.
      return blob.type === 'image/jpeg'
        ? canvas.toDataURL('image/jpeg', 0.82)
        : canvas.toDataURL('image/webp', 0.82);
    } finally {
      bitmap.close();
    }
  }

  async function pdf(data) {
    const pdfjs = await loadPdfjs();
    if (disposed) return null;
    if (!worker) worker = new pdfjs.PDFWorker();
    const task = pdfjs.getDocument({
      data,
      worker,
      // Kein eval/WASM: haelt die App-CSP (script-src 'self') wie im Viewer.
      isEvalSupported: false,
      standardFontDataUrl: '/vendor/pdfjs/standard_fonts/',
    });
    // Ein Passwort fragt die Vorschau nie ab: ohne `onPassword` endet die
    // Aufgabe mit einer PasswordException, und die Glyphe bleibt.
    try {
      const doc = await task.promise;
      const page = await doc.getPage(1);
      const unit = page.getViewport({ scale: 1 });
      const size = rasterSize(unit.width, unit.height);
      const viewport = page.getViewport({ scale: size.scale });
      const canvas = canvasOf(Math.floor(viewport.width), Math.floor(viewport.height));
      const ctx = canvas.getContext('2d');
      // Papier ist weiss, auch im Dunkelmodus: ohne Grund waere eine Seite
      // ohne eigenen Hintergrund als JPEG schwarz.
      ctx.fillStyle = '#fff';
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      await page.render({ canvasContext: ctx, viewport }).promise;
      return canvas.toDataURL('image/jpeg', 0.82);
    } finally {
      // Gibt das Dokument im Worker frei; den geteilten Worker selbst laesst
      // pdf.js stehen, weil er uebergeben und nicht selbst erzeugt wurde.
      await task.destroy();
    }
  }

  function dispose() {
    disposed = true;
    worker?.destroy();
    worker = null;
  }

  return { image, pdf, dispose };
}
