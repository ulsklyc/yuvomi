/** Per-display values (#2436). No DOM/storage dependency: shared API validation. */
export const DISPLAY_DEVICE_DEFAULTS = Object.freeze({
  night_from: 22, night_until: 6, idle_seconds: 300, show_clock: true, cover_photo: false,
});
export const DISPLAY_IDLE_STEPS = Object.freeze([60, 120, 300, 600, 900]);
const hour = value => Number.isInteger(value) && value >= 0 && value <= 23;

export function normalizeDisplayDeviceSettings(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
      || Object.keys(value).length !== Object.keys(DISPLAY_DEVICE_DEFAULTS).length
      || !hour(value.night_from) || !hour(value.night_until) || value.night_from === value.night_until
      || !DISPLAY_IDLE_STEPS.includes(value.idle_seconds)
      || typeof value.show_clock !== 'boolean' || typeof value.cover_photo !== 'boolean') return null;
  return Object.fromEntries(Object.keys(DISPLAY_DEVICE_DEFAULTS).map(key => [key, value[key]]));
}

export function parseDisplayDeviceSettings(raw) {
  try { return normalizeDisplayDeviceSettings(JSON.parse(raw)); } catch { return null; }
}

// Session-local override. Never copy display choices over a person's localStorage.
let current = null;
export function getDisplayDeviceSettings() { return current; }
export function applyDisplayDeviceSettings(value) {
  const next = normalizeDisplayDeviceSettings(value);
  if (JSON.stringify(next) === JSON.stringify(current)) return false;
  current = next ? Object.freeze(next) : null;
  return true;
}
