import { t } from '/i18n.js';
import { getPwaInstallState, onPwaInstallStateChanged, promptPwaInstall } from '/utils/pwa-install.js';

function renderPage(container) {
  container.replaceChildren();
  container.insertAdjacentHTML('beforeend', `
    <section class="settings-section">
      <h2 class="settings-section__title">${t('settings.sectionPwa')}</h2>
      <div class="settings-card settings-pwa-card">
        <div class="settings-pwa-card__icon">
          <i data-lucide="smartphone" aria-hidden="true"></i>
        </div>
        <div class="settings-pwa-card__body">
          <h3 class="settings-card__title">${t('settings.pwaInstallTitle')}</h3>
          <p class="form-hint" id="pwa-install-status" aria-live="polite">${t('settings.pwaInstallChecking')}</p>
          <div id="pwa-install-error" class="form-error" role="alert" hidden></div>
          <div class="settings-form-actions">
            <button type="button" class="btn btn--primary" id="pwa-install-btn" aria-describedby="pwa-install-status pwa-install-error">
              <i data-lucide="download" aria-hidden="true"></i>
              <span>${t('settings.pwaInstallButton')}</span>
            </button>
          </div>
        </div>
      </div>
    </section>
  `);
}

function bindPwaInstall(container) {
  const button = container.querySelector('#pwa-install-btn');
  const status = container.querySelector('#pwa-install-status');
  const label = button?.querySelector('span');
  const errorElement = container.querySelector('#pwa-install-error');
  if (!button || !status || !label) return;

  let unsubscribe = null;
  let unsubscribeRequested = false;
  let unsubscribed = false;
  let observer = null;

  const stopListening = () => {
    if (unsubscribed) return;
    if (!unsubscribe) {
      unsubscribeRequested = true;
      return;
    }
    unsubscribed = true;
    const stop = unsubscribe;
    unsubscribe = null;
    try {
      stop();
    } finally {
      observer?.disconnect();
      observer = null;
    }
  };

  const renderState = (state = getPwaInstallState()) => {
    if (!container.isConnected) {
      stopListening();
      return;
    }

    if (state.installed) {
      status.textContent = t('settings.pwaInstallInstalled');
      label.textContent = t('settings.pwaInstallInstalledButton');
      button.disabled = true;
      return;
    }
    if (state.ios) {
      status.textContent = t('settings.pwaInstallIosHint');
      label.textContent = t('settings.pwaInstallInstructionsButton');
      button.disabled = false;
      return;
    }
    if (state.canPrompt) {
      status.textContent = t('settings.pwaInstallReady');
      label.textContent = t('settings.pwaInstallButton');
      button.disabled = false;
      return;
    }

    status.textContent = t('settings.pwaInstallUnavailable');
    label.textContent = t('settings.pwaInstallButton');
    button.disabled = true;
  };

  unsubscribe = onPwaInstallStateChanged(renderState);
  if (unsubscribeRequested || !container.isConnected) {
    stopListening();
  } else {
    // Cleanup-Erkennung: Der SPA-Router tauscht Seiten per
    // #main-content.replaceChildren() aus. Wir beobachten nur diesen einen
    // persistenten Container (childList, ohne subtree) statt das gesamte
    // document.body-Subtree — Letzteres würde bei jeder DOM-Mutation der App feuern.
    const swapRoot = document.getElementById('main-content') || container.parentNode;
    observer = new MutationObserver(() => {
      if (!container.isConnected) stopListening();
    });
    if (swapRoot) observer.observe(swapRoot, { childList: true });
    if (!container.isConnected) stopListening();
  }

  button.addEventListener('click', async () => {
    errorElement.hidden = true;
    errorElement.textContent = '';
    try {
      const result = await promptPwaInstall();
      if (result.outcome === 'accepted') {
        window.oikos?.showToast(t('settings.pwaInstallAcceptedToast'), 'success');
      } else if (result.outcome === 'ios') {
        window.oikos?.showToast(t('settings.pwaInstallIosToast'), 'default');
      } else if (result.outcome === 'installed') {
        window.oikos?.showToast(t('settings.pwaInstallAlreadyInstalledToast'), 'default');
      } else if (result.outcome === 'unavailable') {
        window.oikos?.showToast(t('settings.pwaInstallUnavailableToast'), 'warning');
      }
    } catch (error) {
      errorElement.textContent = error.message || t('common.errorGeneric');
      errorElement.hidden = false;
    } finally {
      renderState();
    }
  });
}

export async function render(container, { user }) {
  void user;
  try {
    renderPage(container);
    bindPwaInstall(container);
    window.lucide?.createIcons({ el: container });
  } catch (error) {
    container.replaceChildren();
    throw error;
  }
}
