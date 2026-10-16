import { t } from '/i18n.js';
import { attachOverlay } from '/utils/overlay-history.js';
import { dismissDialog, revealDialog } from '/utils/dialog-surface.js';

const CANVAS_SIZE = 288;
const CROP_SIZE = 240;
const CROP_OFFSET = (CANVAS_SIZE - CROP_SIZE) / 2; // 24
const OUTPUT_SIZE = 256;

// Was hereindarf. Die Liste war vor #901 an fünf Stellen einzeln
// hingeschrieben und überall dieselbe - der Zuschnitt gibt ohnehin JPEG
// zurück, also hängt sie nicht am Ziel, sondern daran, was ein `<img>` laden
// kann. Sie ist deshalb Konstante und keine Option.
const ACCEPTED_TYPES = ['image/png', 'image/jpeg', 'image/webp'];
const MAX_FILE_BYTES = 5 * 1024 * 1024;

// Was am Ende herauskommen darf. DAS hängt am Ziel: ein Porträt landet in
// `avatar_data`/`photo_data`, ein Kachelbild in einer deutlich engeren Spalte.
const MAX_PORTRAIT_DATA_LENGTH = 768 * 1024;

const DEFAULT_MESSAGE_KEYS = {
  type:         'settings.profilePictureTypeError',
  fileTooLarge: 'settings.profilePictureFileTooLarge',
  read:         'settings.profilePictureReadError',
  dataTooLarge: 'settings.profilePictureTooLarge',
};

let stylesInjected = false;

function injectStyles() {
  if (stylesInjected) return;
  stylesInjected = true;
  const style = document.createElement('style');
  style.textContent = `
.avatar-crop-dialog {
  /* Tafel, Grund und Bewegung: .dialog-surface (layout.css, D7). */
  max-width: 360px;
  width: calc(100vw - var(--space-8));
}
.avatar-crop-dialog__header {
  padding: var(--space-4) var(--space-4) 0;
}
.avatar-crop-dialog__title {
  font-size: var(--text-base);
  font-weight: var(--font-weight-semibold);
  color: var(--color-text-primary);
  margin: 0;
}
.avatar-crop-dialog__body {
  display: flex;
  justify-content: center;
  padding: var(--space-4) var(--space-4) var(--space-3);
}
.avatar-crop-dialog__canvas {
  border-radius: var(--radius-md);
  cursor: grab;
  touch-action: none;
  display: block;
}
.avatar-crop-dialog__canvas:active {
  cursor: grabbing;
}
.avatar-crop-dialog__zoom {
  display: flex;
  align-items: center;
  gap: var(--space-3);
  padding: 0 var(--space-4) var(--space-3);
}
.avatar-crop-dialog__zoom-label {
  font-size: var(--text-sm);
  color: var(--color-text-secondary);
  flex-shrink: 0;
}
.avatar-crop-dialog__zoom-slider {
  flex: 1;
  accent-color: var(--active-module-accent, currentColor);
}
.avatar-crop-dialog__footer {
  display: flex;
  justify-content: flex-end;
  gap: var(--space-3);
  padding: var(--space-3) var(--space-4) var(--space-4);
  border-top: 1px solid var(--color-border);
}
`;
  document.head.appendChild(style);
}

function clampPos(x, y, drawnW, drawnH) {
  return {
    x: Math.min(CROP_OFFSET, Math.max(CROP_OFFSET + CROP_SIZE - drawnW, x)),
    y: Math.min(CROP_OFFSET, Math.max(CROP_OFFSET + CROP_SIZE - drawnH, y)),
  };
}

function buildDialog(img, resolve) {
  const dialog = document.createElement('dialog');
  // `.dialog-surface`: Tafel, Grund, Ein- und Ausgang wie das geteilte Modal (D7).
  dialog.className = 'avatar-crop-dialog dialog-surface';
  dialog.setAttribute('aria-label', t('settings.cropDialogTitle'));

  const header = document.createElement('div');
  header.className = 'avatar-crop-dialog__header';
  const titleEl = document.createElement('h2');
  titleEl.className = 'avatar-crop-dialog__title';
  titleEl.textContent = t('settings.cropDialogTitle');
  header.appendChild(titleEl);

  const body = document.createElement('div');
  body.className = 'avatar-crop-dialog__body';
  const canvas = document.createElement('canvas');
  canvas.className = 'avatar-crop-dialog__canvas';
  const dpr = window.devicePixelRatio || 1;
  canvas.width = CANVAS_SIZE * dpr;
  canvas.height = CANVAS_SIZE * dpr;
  canvas.style.width = CANVAS_SIZE + 'px';
  canvas.style.height = CANVAS_SIZE + 'px';
  body.appendChild(canvas);

  const zoomRow = document.createElement('div');
  zoomRow.className = 'avatar-crop-dialog__zoom';
  const sliderId = 'avatar-crop-zoom-' + Date.now();
  const zoomLabel = document.createElement('label');
  zoomLabel.className = 'avatar-crop-dialog__zoom-label';
  zoomLabel.htmlFor = sliderId;
  zoomLabel.textContent = t('settings.cropZoomLabel');
  const zoomSlider = document.createElement('input');
  zoomSlider.type = 'range';
  zoomSlider.id = sliderId;
  zoomSlider.className = 'avatar-crop-dialog__zoom-slider';
  zoomSlider.min = '1';
  zoomSlider.max = '3';
  zoomSlider.step = '0.01';
  zoomSlider.value = '1';
  zoomRow.appendChild(zoomLabel);
  zoomRow.appendChild(zoomSlider);

  const footer = document.createElement('div');
  footer.className = 'avatar-crop-dialog__footer';
  const cancelBtn = document.createElement('button');
  cancelBtn.type = 'button';
  cancelBtn.className = 'btn btn--secondary';
  cancelBtn.textContent = t('common.cancel');
  const confirmBtn = document.createElement('button');
  confirmBtn.type = 'button';
  confirmBtn.className = 'btn btn--primary';
  confirmBtn.textContent = t('settings.cropConfirm');
  footer.appendChild(cancelBtn);
  footer.appendChild(confirmBtn);

  dialog.appendChild(header);
  dialog.appendChild(body);
  dialog.appendChild(zoomRow);
  dialog.appendChild(footer);

  const ctx = canvas.getContext('2d');
  ctx.scale(dpr, dpr);

  const baseScale = CROP_SIZE / Math.min(img.width, img.height);
  let zoom = 1;
  let imgX = (CANVAS_SIZE - img.width * baseScale) / 2;
  let imgY = (CANVAS_SIZE - img.height * baseScale) / 2;
  const clamped = clampPos(imgX, imgY, img.width * baseScale, img.height * baseScale);
  imgX = clamped.x;
  imgY = clamped.y;

  function renderCanvas() {
    const scale = baseScale * zoom;
    const drawnW = img.width * scale;
    const drawnH = img.height * scale;
    ctx.clearRect(0, 0, CANVAS_SIZE, CANVAS_SIZE);
    ctx.drawImage(img, imgX, imgY, drawnW, drawnH);
    // Dark overlay around crop area (4 rects)
    ctx.fillStyle = 'rgba(0,0,0,0.55)';
    ctx.fillRect(0, 0, CANVAS_SIZE, CROP_OFFSET);
    ctx.fillRect(0, CROP_OFFSET + CROP_SIZE, CANVAS_SIZE, CROP_OFFSET);
    ctx.fillRect(0, CROP_OFFSET, CROP_OFFSET, CROP_SIZE);
    ctx.fillRect(CROP_OFFSET + CROP_SIZE, CROP_OFFSET, CROP_OFFSET, CROP_SIZE);
    // Crop frame border
    ctx.strokeStyle = 'rgba(255,255,255,0.9)';
    ctx.lineWidth = 2;
    ctx.strokeRect(CROP_OFFSET + 1, CROP_OFFSET + 1, CROP_SIZE - 2, CROP_SIZE - 2);
  }

  renderCanvas();

  function applyZoom(newZoom) {
    const oldScale = baseScale * zoom;
    const newScale = baseScale * newZoom;
    const cx = CROP_OFFSET + CROP_SIZE / 2;
    const cy = CROP_OFFSET + CROP_SIZE / 2;
    imgX = cx - (cx - imgX) * (newScale / oldScale);
    imgY = cy - (cy - imgY) * (newScale / oldScale);
    zoom = newZoom;
    const c = clampPos(imgX, imgY, img.width * newScale, img.height * newScale);
    imgX = c.x;
    imgY = c.y;
  }

  // Pointer drag
  let dragging = false;
  let lastPX = 0;
  let lastPY = 0;

  canvas.addEventListener('pointerdown', (e) => {
    dragging = true;
    lastPX = e.clientX;
    lastPY = e.clientY;
    canvas.setPointerCapture(e.pointerId);
  });

  canvas.addEventListener('pointermove', (e) => {
    if (!dragging) return;
    const scale = baseScale * zoom;
    const c = clampPos(
      imgX + e.clientX - lastPX,
      imgY + e.clientY - lastPY,
      img.width * scale,
      img.height * scale,
    );
    imgX = c.x;
    imgY = c.y;
    lastPX = e.clientX;
    lastPY = e.clientY;
    renderCanvas();
  });

  canvas.addEventListener('pointerup', () => { dragging = false; });
  canvas.addEventListener('pointercancel', () => { dragging = false; });

  // Wheel zoom (desktop)
  canvas.addEventListener('wheel', (e) => {
    e.preventDefault();
    const newZoom = Math.min(3, Math.max(1, zoom - e.deltaY * 0.003));
    applyZoom(newZoom);
    zoomSlider.value = String(newZoom);
    renderCanvas();
  }, { passive: false });

  // Slider zoom
  zoomSlider.addEventListener('input', () => {
    applyZoom(parseFloat(zoomSlider.value));
    renderCanvas();
  });

  // Erst nach dem Ausgang aufloesen: der Aufrufer fokussiert danach im
  // Formular darunter, und das ist bis dahin noch inert.
  function cleanup() {
    return dismissDialog(dialog);
  }

  cancelBtn.addEventListener('click', () => {
    cleanup().then(() => resolve(null));
  });

  // Esc faehrt aus wie Abbrechen, statt hart zu verschwinden.
  dialog.addEventListener('cancel', (e) => {
    e.preventDefault();
    cleanup().then(() => resolve(null));
  });

  confirmBtn.addEventListener('click', () => {
    const scale = baseScale * zoom;
    const cropImgX = (CROP_OFFSET - imgX) / scale;
    const cropImgY = (CROP_OFFSET - imgY) / scale;
    const cropImgSize = CROP_SIZE / scale;
    const out = document.createElement('canvas');
    out.width = OUTPUT_SIZE;
    out.height = OUTPUT_SIZE;
    out.getContext('2d').drawImage(img, cropImgX, cropImgY, cropImgSize, cropImgSize, 0, 0, OUTPUT_SIZE, OUTPUT_SIZE);
    const dataUrl = out.toDataURL('image/jpeg', 0.88);
    cleanup().then(() => resolve(dataUrl));
  });

  return dialog;
}

/**
 * Der Zuschnitt-Dialog selbst - MODUL-PRIVAT, und das ist der Punkt.
 *
 * Solange er exportiert war, konnte jeder Aufrufer seinen eigenen Weg dorthin
 * bauen, und genau das ist fünfmal passiert: fünf Fassungen von "Datei lesen,
 * prüfen, zuschneiden, Ergebnis prüfen", von denen eine gar nicht zuschnitt
 * (#901), eine keine Größe prüfte und eine jeden Fehler stumm schluckte. Der
 * einzige Weg hinein ist jetzt `pickCroppedImage()`.
 */
function openCropDialog(imageDataUrl) {
  injectStyles();
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => {
      const dialog = buildDialog(img, resolve);
      document.body.appendChild(dialog);
      dialog.showModal();
      revealDialog(dialog);
      /* AUCH EIN NATIVES `<dialog>` MELDET SICH AN (#871).
       *
       * Es traegt kein `aria-modal`-Attribut - das setzt der Browser bei
       * `showModal()` implizit -, ist aber genauso modal wie die selbstgebauten
       * Overlays und liegt in der Top-Layer DARUEBER. Ohne Anmeldung nahm die
       * Zurueck-Geste den Eintrag des geteilten Modals darunter (Schnellzugriffe,
       * Haushaltshilfe): das Formular ging zu oder fragte nach ungespeicherten
       * Aenderungen, waehrend der Zuschnitt unveraendert obenauf stehen blieb.
       *
       * Zurueck heisst hier „abgebrochen", wie das X und wie Escape - der
       * `cancel`-Weg ist derselbe. */
      attachOverlay(dialog, () => {
        dialog.remove();
        resolve(null);
      });
    };
    /* Ein Bild, das der Browser nicht dekodieren kann (gültiger MIME-Typ,
     * kaputte Bytes), ist ein Lesefehler, kein Abbruch: `null` hieße für
     * jeden Aufrufer „nichts gewählt" - kein Toast, keine Meldung, die
     * Vorschau bliebe unverändert stehen, als wäre nie etwas passiert. */
    img.onerror = () => reject(new Error('image decode failed'));
    img.src = imageDataUrl;
  });
}

/** Der Zuschnitt, den pickCroppedImage() oeffnet - ersetzbar nur fuer Tests. */
let cropDialog = openCropDialog;

/**
 * NUR FUER TESTS: den Zuschnitt ersetzen. Ohne Browser gibt es weder Canvas
 * noch `<dialog>`; so laesst sich die Pruefung NACH dem Zuschnitt
 * (`dataTooLarge`) trotzdem als Programm fahren. `null` stellt zurueck.
 */
export function _setCropDialogForTest(fn) {
  cropDialog = fn ?? openCropDialog;
}

/**
 * Eine Datei, die nicht taugt: traegt ihren schon uebersetzten Satz (#1909).
 * Ein eigener Typ, damit ein Aufrufer ihn von jedem anderen Wurf (ein
 * Ladefehler, ein Programmfehler) unterscheidet, ohne den Text eines Fehlers zu
 * lesen. `message` traegt denselben Satz - wer noch `err.message` zeigt, sagt
 * damit nichts anderes als vorher.
 */
export class ImageProblem extends Error {
  constructor(sentence) {
    super(sentence);
    this.name = 'ImageProblem';
    this.sentence = sentence;
  }
}

/**
 * DER EINE WEG VON EINER DATEI ZU EINEM ZUGESCHNITTENEN BILD.
 *
 * Vor #901 gab es ihn fünfmal: zeichengleich in `admin-family.js` und
 * `personal-account.js`, mit eigenen Grenzen in `quick-links-manager.js`, ohne
 * Größenprüfung und mit leerem `catch` in `housekeeping.js` - und in
 * `birthdays.js` als abgemagerte Fassung ohne Typprüfung, ohne Größenprüfung,
 * ohne Zuschnitt und mit einer hartcodiert englischen Fehlermeldung. Genau die
 * war die Meldung: ein Geburtstagsfoto ließ sich nicht zuschneiden, ein
 * Profilbild schon. Der Grund war kein fehlender Dialog, sondern ein Dialog,
 * an dem sich jeder Aufrufer vorbeibauen konnte.
 *
 * Konfigurierbar ist deshalb nur, was sich WIRKLICH unterscheidet: die
 * Obergrenze des Ergebnisses und die Texte. Typen, Dateigröße und der Ablauf
 * selbst sind für alle gleich.
 *
 * GIF fällt dabei aus dem Geburtstags- und dem Inventarmodul heraus, und
 * zwar bewusst. `buildDialog()` gibt IMMER ein JPEG von 256 Pixeln zurück -
 * ein GIF durch den Zuschnitt zu schicken hieße, eine Animation stumm gegen
 * ein Standbild zu tauschen. Lieber eine Ablehnung, die man liest, als ein Ergebnis, das
 * anders ist als das Hochgeladene. Der Server nimmt GIF unverändert an; das
 * hier ist der Weg durch die Oberfläche, nicht die Zusage der API.
 *
 * @param {File|undefined} file
 * @param {{maxDataLength?: number, messageKeys?: Record<string,string>}} [options]
 * @returns {Promise<string|undefined>} das zugeschnittene Bild als Data-URL,
 *   oder `undefined`, wenn nichts gewählt oder der Zuschnitt abgebrochen wurde.
 *   Wirft ein `ImageProblem` mit einer übersetzten Meldung, wenn die Datei
 *   nicht taugt.
 */
export async function pickCroppedImage(file, options = {}) {
  const maxDataLength = options.maxDataLength ?? MAX_PORTRAIT_DATA_LENGTH;
  const keys = { ...DEFAULT_MESSAGE_KEYS, ...(options.messageKeys || {}) };

  if (!file) return undefined;
  if (!ACCEPTED_TYPES.includes(file.type)) throw new ImageProblem(t(keys.type));
  if (file.size > MAX_FILE_BYTES) throw new ImageProblem(t(keys.fileTooLarge));

  const dataUrl = await new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result || ''));
    reader.onerror = () => reject(new ImageProblem(t(keys.read)));
    reader.readAsDataURL(file);
  });

  /* `openCropDialog` rejected mit einem internen `Error('image decode
   * failed')` - der darf den Aufrufer nie erreichen: jeder toastet
   * `err.message`, und die Meldung wäre englisch. Für den Nutzer ist ein
   * nicht dekodierbares Bild dasselbe wie eines, das sich nicht lesen ließ. */
  let cropped;
  try {
    cropped = await cropDialog(dataUrl);
  } catch {
    throw new ImageProblem(t(keys.read));
  }
  if (cropped === null) return undefined;
  if (cropped.length > maxDataLength) throw new ImageProblem(t(keys.dataTooLarge));
  return cropped;
}
