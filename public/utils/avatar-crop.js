import { t } from '/i18n.js';

const CANVAS_SIZE = 288;
const CROP_SIZE = 240;
const CROP_OFFSET = (CANVAS_SIZE - CROP_SIZE) / 2; // 24
const OUTPUT_SIZE = 256;

let stylesInjected = false;

function injectStyles() {
  if (stylesInjected) return;
  stylesInjected = true;
  const style = document.createElement('style');
  style.textContent = `
.avatar-crop-dialog {
  border: none;
  border-radius: var(--radius-lg);
  padding: 0;
  background: var(--color-surface);
  box-shadow: var(--shadow-xl);
  max-width: 360px;
  width: calc(100vw - var(--space-8));
}
.avatar-crop-dialog::backdrop {
  background: rgba(0, 0, 0, 0.55);
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
  dialog.className = 'avatar-crop-dialog';
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

  function cleanup() {
    dialog.remove();
  }

  cancelBtn.addEventListener('click', () => {
    cleanup();
    resolve(null);
  });

  dialog.addEventListener('cancel', () => {
    cleanup();
    resolve(null);
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
    cleanup();
    resolve(out.toDataURL('image/jpeg', 0.88));
  });

  return dialog;
}

export function openCropDialog(imageDataUrl) {
  injectStyles();
  return new Promise((resolve) => {
    const img = new Image();
    img.onload = () => {
      const dialog = buildDialog(img, resolve);
      document.body.appendChild(dialog);
      dialog.showModal();
    };
    img.onerror = () => resolve(null);
    img.src = imageDataUrl;
  });
}
