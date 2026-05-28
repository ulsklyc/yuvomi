/**
 * Shared PWA install prompt state.
 * The beforeinstallprompt event can only be used once, so settings and the
 * floating install banner coordinate through this module.
 */

const stateListeners = new Set();

let deferredInstallPrompt = null;

function isStandaloneMode() {
  return (
    window.matchMedia('(display-mode: standalone)').matches ||
    navigator.standalone === true
  );
}

function isIOSInstallFlow() {
  if (isStandaloneMode()) return false;
  const platform = navigator.platform || '';
  const userAgent = navigator.userAgent || '';
  const isiPadOSDesktopMode = platform === 'MacIntel' && navigator.maxTouchPoints > 1;
  return /iPhone|iPad|iPod/.test(userAgent) || isiPadOSDesktopMode;
}

function emitInstallStateChanged() {
  const state = getPwaInstallState();
  stateListeners.forEach((listener) => listener(state));
  window.dispatchEvent(new CustomEvent('pwa-install-state-changed', { detail: state }));
}

window.addEventListener('beforeinstallprompt', (e) => {
  e.preventDefault();
  deferredInstallPrompt = e;
  emitInstallStateChanged();
});

window.addEventListener('appinstalled', () => {
  deferredInstallPrompt = null;
  emitInstallStateChanged();
});

export function getPwaInstallState() {
  const installed = isStandaloneMode();
  const ios = isIOSInstallFlow();
  return {
    installed,
    ios,
    canPrompt: !installed && !!deferredInstallPrompt,
    supported: !installed && (ios || !!deferredInstallPrompt),
  };
}

export function onPwaInstallStateChanged(listener) {
  stateListeners.add(listener);
  listener(getPwaInstallState());
  return () => stateListeners.delete(listener);
}

export async function promptPwaInstall() {
  if (isStandaloneMode()) return { outcome: 'installed' };
  if (isIOSInstallFlow()) return { outcome: 'ios' };
  if (!deferredInstallPrompt) return { outcome: 'unavailable' };

  const prompt = deferredInstallPrompt;
  try {
    prompt.prompt();
    deferredInstallPrompt = null;
    emitInstallStateChanged();
    return await prompt.userChoice;
  } catch (err) {
    if (deferredInstallPrompt !== prompt) {
      deferredInstallPrompt = prompt;
      emitInstallStateChanged();
    }
    throw err;
  }
}
