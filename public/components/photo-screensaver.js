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
// When the last counted pointermove was; see the listener and preview().
let lastMove = 0;
// SOMEBODY IS SIGNED IN ON THIS PAGE (#1919). This module loads from index.html
// on every page, the sign-in and setup pages included, and there is nobody
// there whose screensaver it could be: the photo request would answer 401,
// api.js would fire `auth:expired`, and the router would draw the sign-in page
// again over a form somebody is filling in. So nothing below arms the idle
// timer until the router says a session exists (armScreensaver, called by
// navigate() where it sets the current user), and forgetSessionState() takes
// it back. "Somebody" includes a paired wall display: it has no user session,
// but /auth/me answers it with an account of scope `display` (#1793).
let armed = false;

function stop() {
  run += 1;
  // A start by hand retired here (preview()) holds moves back no longer. Its
  // request may stay open for as long as it likes; the hand on the mouse must
  // keep the idle screensaver away from now on, not from the answer on.
  if (lastMove === Infinity) lastMove = 0;
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
  if (armed) idleTimer = setTimeout(start, idleMs());
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

// Knock again after one more idle period without waiting for input. `start()`
// runs from a one-shot idle timeout, and on a wall tablet "the next pointer,
// key or visibility event" can be hours away - the same trap the kitchen-timer
// branch in `start()` avoids with the same two lines.
function rearm() {
  clearTimeout(idleTimer);
  idleTimer = setTimeout(start, idleMs());
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
    // A refused image - an administrator switched this display off while the
    // screensaver was showing (#1766) - or one Immich no longer has: take the
    // overlay down instead of leaving a black screen with only the text
    // moving over it, and knock again after the next idle period.
    image.onerror = () => {
      if (currentRun !== run) return;
      stop();
      rearm();
    };
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
    // Screensaver is optional; try again after one more idle period, without
    // waiting for input. A paired display that an administrator switches on
    // (#1766) gets its photos on the next knock instead of on the next touch,
    // and one that stays off asks once per idle period and gets its 403. Only
    // for the current run: a start() retired by stop() is not ours to re-arm.
    if (currentRun === run) rearm();
    return false;
  }
}

/**
 * A session exists from here on: arm the idle timer, without a reload and
 * without waiting for a gesture - the click that signed in came before the
 * session did. Does nothing while already armed, so a second call neither
 * pushes a running timer back nor takes a showing screensaver down.
 */
export function armScreensaver() {
  if (armed) return;
  armed = true;
  resetIdle();
}

/**
 * The session is gone, by sign-out or by expiry: take down what is showing,
 * retire a start still waiting for its photos (so its catch arms nothing) and
 * stay quiet until the next session.
 */
export function disarmScreensaver() {
  armed = false;
  stop();
  clearTimeout(idleTimer);
}

/**
 * Opens the real screensaver immediately: the admin configuration preview and
 * the start button in the wall footer (#1766).
 *
 * The mouse that clicked is still on its way off the button, and that move
 * must not dismiss what the click just started. The throttle on pointermove
 * (`lastMove`, in the listener below) is the grace period: no move counts
 * while the photos load - a move there would retire the start, and the caller
 * would say "not available" - and the first second after the answer belongs
 * to the opening. A key, a press, a touch or the wheel are deliberate and
 * dismiss at once, as always; while the photos load they retire the start,
 * and stop() ends the wait for moves with it. The press of the click itself
 * comes before this call and finds nothing to dismiss.
 */
export async function preview() {
  stop();
  clearTimeout(idleTimer);
  lastMove = Infinity;
  const opened = await start();
  lastMove = Date.now();
  if (!opened) resetIdle();
  return opened;
}

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
// The session is gone (api.js fires this before it throws on a 401). The
// router disarms on the same event through forgetSessionState(); listening
// here as well keeps it independent of which of the two listeners runs first
// and of a start() whose own request was the one that ended the session.
window.addEventListener('auth:expired', disarmScreensaver);
// A new delay re-arms the timer at once, so it applies without a reload. Only
// while nothing is showing: the change comes from the settings page, and a
// visible screensaver there is the admin preview, which stays until dismissed.
new MutationObserver(() => {
  if (overlay) return;
  // stop() also retires a start() still waiting for its photos, so the re-armed
  // timer cannot open a second overlay on top of it. resetIdle() arms only
  // while somebody is signed in.
  resetIdle();
}).observe(document.documentElement, { attributes: true, attributeFilter: ['data-screensaver-idle'] });
// A delay chosen in another tab of this browser reaches this page through the
// storage event and then takes the same path as above.
window.addEventListener('storage', syncScreensaverIdleFromStorage);
