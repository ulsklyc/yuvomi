const IDLE_MS = Math.max(30, Number.parseInt(document.documentElement.dataset.screensaverIdle || '300', 10)) * 1000;
const SLIDE_MS = 20_000;

let idleTimer;
let slideTimer;
let overlay;
let run = 0;

function stop() {
  run += 1;
  clearInterval(slideTimer);
  slideTimer = undefined;
  overlay?.remove();
  overlay = undefined;
}

function resetIdle(event) {
  const wasVisible = Boolean(overlay);
  stop();
  clearTimeout(idleTimer);
  idleTimer = setTimeout(start, IDLE_MS);
  // A dismissing gesture belongs to the overlay and must not activate the
  // dashboard control underneath it (particularly important on wall tablets).
  if (wasVisible && event) {
    event.preventDefault();
    event.stopImmediatePropagation();
  }
}

function caption(photo) {
  const place = [photo.city, photo.country].filter(Boolean).join(', ');
  if (!photo.takenAt) return place;
  const date = new Date(photo.takenAt);
  const formatted = Number.isNaN(date.getTime()) ? '' : new Intl.DateTimeFormat(undefined, {
    year: 'numeric', month: 'long', day: 'numeric',
  }).format(date);
  return [formatted, place].filter(Boolean).join(' · ');
}

async function start() {
  const currentRun = ++run;
  try {
    const response = await fetch('/api/v1/screensaver/photos', { credentials: 'same-origin' });
    if (!response.ok || currentRun !== run) return false;
    const payload = await response.json();
    const photos = payload?.data?.photos || [];
    if (!payload?.data?.enabled || !photos.length) return false;

    overlay = document.createElement('div');
    overlay.className = 'photo-screensaver';
    overlay.setAttribute('aria-hidden', 'true');
    overlay.innerHTML = '<img alt=""><p></p>';
    document.body.append(overlay);

    let index = Math.floor(Math.random() * photos.length);
    const show = () => {
      const photo = photos[index++ % photos.length];
      const image = overlay?.querySelector('img');
      if (!image) return;
      image.classList.remove('photo-screensaver__visible');
      image.onload = () => image.classList.add('photo-screensaver__visible');
      image.src = `/api/v1/screensaver/photos/${encodeURIComponent(photo.id)}`;
      const label = overlay.querySelector('p');
      label.textContent = caption(photo);
      // Move the only persistent text so the screensaver itself has no fixed
      // bright pixels that could cause burn-in.
      label.dataset.position = String(index % 4);
    };
    show();
    slideTimer = setInterval(show, SLIDE_MS);
    return true;
  } catch {
    // Screensaver is optional; retry after the next period of inactivity.
    return false;
  }
}

/** Opens the real screensaver immediately for the admin configuration preview. */
export async function preview() {
  stop();
  clearTimeout(idleTimer);
  const opened = await start();
  if (!opened) resetIdle();
  return opened;
}

let lastMove = 0;
for (const eventName of ['pointerdown', 'keydown', 'touchstart', 'wheel']) {
  window.addEventListener(eventName, resetIdle, { passive: false, capture: true });
}
window.addEventListener('pointermove', () => {
  const now = Date.now();
  if (now - lastMove > 1000) { lastMove = now; resetIdle(); }
}, { passive: true, capture: true });
document.addEventListener('visibilitychange', () => {
  if (document.hidden) stop(); else resetIdle();
});
resetIdle();

export const __test = { caption };
