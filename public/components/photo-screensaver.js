import { api } from '/api.js';
import { formatDate, formatTime } from '/i18n.js';
import {
  isScreensaverClockOn,
  isScreensaverCoverOn,
  syncScreensaverIdleFromStorage,
} from '/utils/screensaver-idle.js';

// Read on every arming, not once at load: the delay is a per-device choice
// (utils/screensaver-idle.js, #885) that theme-init.js applies before this
// module loads and the appearance settings change while the page is open.
function idleMs() {
  return Math.max(30, Number.parseInt(document.documentElement.dataset.screensaverIdle || '300', 10) || 300) * 1000;
}
const SLIDE_MS = 20_000;

let idleTimer;
let slideTimer;
let clockTimer;
let overlay;
let run = 0;

function stop() {
  run += 1;
  clearInterval(slideTimer);
  slideTimer = undefined;
  clearTimeout(clockTimer);
  clockTimer = undefined;
  overlay?.remove();
  overlay = undefined;
}

function resetIdle(event) {
  const wasVisible = Boolean(overlay);
  stop();
  clearTimeout(idleTimer);
  idleTimer = setTimeout(start, idleMs());
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
  // Follows the date-format preference like every other date in the app.
  const formatted = Number.isNaN(date.getTime()) ? '' : formatDate(date);
  return [formatted, place].filter(Boolean).join(' · ');
}

// The household's time in the household's format and zone (formatTime), on the
// full minute like the clock on the overview (dashboard.js, startClockTicker),
// so it turns when every other clock in the room does.
function tickClock(clock) {
  const now = new Date();
  clock.textContent = formatTime(now);
  clockTimer = setTimeout(() => tickClock(clock), 60_000 - (now.getSeconds() * 1000 + now.getMilliseconds()));
}

async function start() {
  // A running kitchen timer (#844) keeps the screensaver away. A countdown that
  // disappears behind a photo is not a timer, and the wall tablet is exactly
  // where both of these live. The attribute is the one source, set by
  // components/wall-timer.js; it is dropped the moment the timer rings, so a
  // finished timer nobody acknowledged does not block the screensaver forever.
  if (document.documentElement.hasAttribute('data-wall-timer')) {
    // Knock again instead of consuming the only scheduled attempt. `start()` is
    // called from a one-shot idle timeout; returning here without rescheduling
    // left the screensaver off until the next pointer, key or visibility event -
    // and on a wall tablet, "the next event" can be hours away. This way the
    // timer only postpones the screensaver, it does not switch it off.
    clearTimeout(idleTimer);
    idleTimer = setTimeout(start, idleMs());
    return false;
  }

  const currentRun = ++run;
  try {
    const payload = await api.get('/screensaver/photos');
    if (currentRun !== run) return false;
    const photos = payload?.data?.photos || [];
    if (!payload?.data?.enabled || !photos.length) return false;

    overlay = document.createElement('div');
    overlay.className = 'photo-screensaver';
    overlay.setAttribute('aria-hidden', 'true');
    // Both read per start, not once at load: they are this device's choice
    // (#1766) and apply from the next start on, without a reload.
    if (isScreensaverCoverOn()) overlay.classList.add('photo-screensaver--cover');
    const image = document.createElement('img');
    image.alt = '';
    const label = document.createElement('p');
    overlay.append(image, label);
    let clock = null;
    if (isScreensaverClockOn()) {
      clock = document.createElement('p');
      clock.className = 'photo-screensaver__clock';
      overlay.append(clock);
      tickClock(clock);
    }
    document.body.append(overlay);

    let index = Math.floor(Math.random() * photos.length);
    const show = () => {
      if (!overlay) return;
      const photo = photos[index++ % photos.length];
      image.classList.remove('photo-screensaver__visible');
      image.onload = () => image.classList.add('photo-screensaver__visible');
      image.src = `/api/v1/screensaver/photos/${encodeURIComponent(photo.id)}`;
      label.textContent = caption(photo);
      // Move the only persistent text so the screensaver itself has no fixed
      // bright pixels that could cause burn-in.
      label.dataset.position = String(index % 4);
      // The clock takes the corner diagonally opposite and moves with the
      // caption, so the two never meet and no text stays in one place.
      if (clock) clock.dataset.position = String((index + 2) % 4);
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
// A new delay re-arms the timer at once, so it applies without a reload. Only
// while nothing is showing: the change comes from the settings page, and a
// visible screensaver there is the admin preview, which stays until dismissed.
new MutationObserver(() => {
  if (overlay) return;
  // stop() also retires a start() still waiting for its photos, so the re-armed
  // timer cannot open a second overlay on top of it.
  stop();
  clearTimeout(idleTimer);
  idleTimer = setTimeout(start, idleMs());
}).observe(document.documentElement, { attributes: true, attributeFilter: ['data-screensaver-idle'] });
// A delay chosen in another tab of this browser reaches this page through the
// storage event and then takes the same path as above.
window.addEventListener('storage', syncScreensaverIdleFromStorage);
resetIdle();
