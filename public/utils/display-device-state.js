/** Browser-session override for a paired display; never writes personal storage. */
import { normalizeDisplayDeviceSettings } from './display-device-settings.js';

// Session-local override. Never copy display choices over a person's localStorage.
let current = null;
export function getDisplayDeviceSettings() { return current; }
export function applyDisplayDeviceSettings(value) {
  const next = normalizeDisplayDeviceSettings(value);
  if (JSON.stringify(next) === JSON.stringify(current)) return false;
  current = next ? Object.freeze(next) : null;
  return true;
}
