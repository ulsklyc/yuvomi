/**
 * How long a device stays idle before the photo screensaver starts (#885).
 *
 * DEVICE-LOCAL, LIKE WALL MODE. A photo frame that should start after one
 * minute and a kitchen tablet that should wait five are two devices in the same
 * household, and the screensaver also runs on every signed-in phone. A
 * household value in `sync_config` or an env var would give all of them the
 * same delay, so the choice lives in `localStorage` next to `yuvomi-wall-mode`,
 * and the Immich connection (server, key, album) stays the household's part.
 *
 * ONE ATTRIBUTE, TWO WRITERS. `components/photo-screensaver.js` reads
 * `data-screensaver-idle` on `<html>`. `theme-init.js` sets it before any
 * module loads, so the value is there before the first idle period, and
 * `setScreensaverIdleSeconds()` sets it again when the choice changes. The
 * component watches the attribute, so a new value applies without a reload.
 * `theme-init.js` repeats the storage key as a literal because it cannot
 * import; a guard in test-frontend-audit.js keeps the two in step.
 */

export const SCREENSAVER_IDLE_KEY = 'yuvomi-screensaver-idle';

/** The choices offered, in seconds. */
export const SCREENSAVER_IDLE_STEPS = [60, 120, 300, 600, 900];

/** Unchanged from before the setting existed: five minutes. */
export const SCREENSAVER_IDLE_DEFAULT = 300;

/**
 * Normalises a stored or chosen value to one of the steps.
 *
 * Anything else - a missing key, a hand-edited value, a step that a later
 * version dropped - falls back to the default instead of to a delay nobody
 * chose.
 *
 * @param {unknown} value
 * @returns {number} seconds
 */
export function normalizeScreensaverIdle(value) {
  const seconds = Number(value);
  return SCREENSAVER_IDLE_STEPS.includes(seconds) ? seconds : SCREENSAVER_IDLE_DEFAULT;
}

/** The delay chosen on THIS device, in seconds. */
export function getScreensaverIdleSeconds() {
  try {
    return normalizeScreensaverIdle(localStorage.getItem(SCREENSAVER_IDLE_KEY));
  } catch {
    // Private mode / blocked storage: the default applies for this session.
    return SCREENSAVER_IDLE_DEFAULT;
  }
}

/**
 * Stores the delay for this device and applies it to the running page.
 *
 * The default is stored as "no key", so a device that never touched the
 * setting and one that went back to five minutes look the same.
 *
 * @param {number} value seconds, one of SCREENSAVER_IDLE_STEPS
 * @returns {number} the seconds actually applied
 */
export function setScreensaverIdleSeconds(value) {
  const seconds = normalizeScreensaverIdle(value);
  try {
    if (seconds === SCREENSAVER_IDLE_DEFAULT) localStorage.removeItem(SCREENSAVER_IDLE_KEY);
    else localStorage.setItem(SCREENSAVER_IDLE_KEY, String(seconds));
  } catch {
    // An unwritable storage must not break the settings page; the value still
    // applies until the next reload.
  }
  document.documentElement.setAttribute('data-screensaver-idle', String(seconds));
  return seconds;
}

/**
 * Follows a change made in another tab or window of the same browser.
 *
 * `setScreensaverIdleSeconds()` sets the attribute only in the page it runs
 * in; the `storage` event reaches every other page of this origin, and
 * re-applying the attribute there is all it takes, because the component
 * already reacts to it. `key === null` is `localStorage.clear()`.
 *
 * @param {StorageEvent} event
 */
export function syncScreensaverIdleFromStorage(event) {
  if (event?.key !== SCREENSAVER_IDLE_KEY && event?.key !== null) return;
  document.documentElement.setAttribute('data-screensaver-idle', String(getScreensaverIdleSeconds()));
}

// --------------------------------------------------------
// What the screensaver shows on this device (#1766)
// --------------------------------------------------------
//
// Device-local for the same reason as the delay: the frame in the hallway wants
// a clock and full-bleed photos, the kitchen tablet maybe neither. Both are
// read each time the screensaver opens, so a change applies at its next start
// without a reload, and neither has to exist before the first render - there
// is nothing to repeat in theme-init.js. As with the delay, the default is
// stored as "no key".

export const SCREENSAVER_CLOCK_KEY = 'yuvomi-screensaver-clock';
export const SCREENSAVER_COVER_KEY = 'yuvomi-screensaver-cover';

function readFlag(key) {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

function writeFlag(key, value) {
  try {
    if (value === null) localStorage.removeItem(key);
    else localStorage.setItem(key, value);
  } catch {
    // Blocked storage: the default applies again after the next reload.
  }
}

/** The current time on the screensaver - on unless switched off here. */
export function isScreensaverClockOn() {
  return readFlag(SCREENSAVER_CLOCK_KEY) !== '0';
}

/** @param {boolean} on @returns {boolean} the value stored */
export function setScreensaverClockOn(on) {
  writeFlag(SCREENSAVER_CLOCK_KEY, on ? null : '0');
  return Boolean(on);
}

/**
 * Full-bleed photos (`object-fit: cover`) - off unless chosen here, because
 * `cover` crops a portrait photo hard on a landscape screen.
 */
export function isScreensaverCoverOn() {
  return readFlag(SCREENSAVER_COVER_KEY) === '1';
}

/** @param {boolean} on @returns {boolean} the value stored */
export function setScreensaverCoverOn(on) {
  writeFlag(SCREENSAVER_COVER_KEY, on ? '1' : null);
  return Boolean(on);
}
