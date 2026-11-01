/** Read-only refresh for a paired display; never grants access to settings. */
import { api } from '/api.js';
import { applyDisplayDeviceSettings } from './display-device-settings.js';
import { getScreensaverIdleSeconds } from './screensaver-idle.js';
import { syncWallMode } from './wall-mode.js';

export function createDisplaySettingsSync({
  fetchPreferences = () => api.get('/preferences'),
  apply = value => {
    if (!applyDisplayDeviceSettings(value)) return;
    const root = document.documentElement;
    const delay = String(getScreensaverIdleSeconds());
    // An unchanged attribute would restart the idle timer every 30 seconds.
    if (root.getAttribute('data-screensaver-idle') !== delay) root.setAttribute('data-screensaver-idle', delay);
    syncWallMode();
  },
  document: doc = document, window: win = window,
} = {}) {
  let timer = null; let generation = 0; let pending = false;
  const refresh = async () => {
    if (timer === null || pending || doc.hidden) return;
    const ticket = generation; pending = true;
    try {
      const result = await fetchPreferences();
      if (ticket === generation) apply(result?.data?.display_device_settings ?? null);
    } catch { /* Offline: keep the last known display configuration. */ }
    finally { if (ticket === generation) pending = false; }
  };
  return {
    apply,
    start() {
      if (timer !== null) return;
      generation += 1;
      timer = win.setInterval(refresh, 30_000);
      doc.addEventListener('visibilitychange', refresh);
      win.addEventListener('online', refresh);
    },
    stop() {
      generation += 1; pending = false;
      if (timer !== null) win.clearInterval(timer);
      timer = null;
      doc.removeEventListener('visibilitychange', refresh);
      win.removeEventListener('online', refresh);
      apply(null);
    },
    refresh,
  };
}
