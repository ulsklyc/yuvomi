import { api } from '/api.js';
import { t } from '/i18n.js';
import {
  createInfoList,
  createRetryState,
  createStatusSummary,
} from '/settings/components.js';

function renderPage(container) {
  container.replaceChildren();
  container.insertAdjacentHTML('beforeend', `
    <section class="settings-section">
      <h2 class="settings-section__title">${t('settings.systemTitle')}</h2>
      <div class="settings-card" id="system-info-card">
        <p class="settings-card-description">${t('settings.systemDescription')}</p>
        <div id="system-info-host"></div>
      </div>
    </section>
  `);
}

function buildInfoRows(info) {
  const rows = [];

  if (info.version) {
    rows.push({
      label: t('settings.systemVersionLabel'),
      value: t('settings.systemVersionValue', { version: info.version }),
    });
  }
  if (info.app_name) {
    rows.push({
      label: t('settings.systemAppNameLabel'),
      value: info.app_name,
    });
  }
  rows.push({
    label: t('settings.systemLicenseLabel'),
    value: 'MIT',
  });
  rows.push({
    label: t('settings.systemSetupStatusLabel'),
    value: info.setup_required
      ? t('settings.systemSetupRequired')
      : t('settings.systemSetupComplete'),
  });

  return rows;
}

function renderInfo(host, info) {
  host.replaceChildren(createInfoList(buildInfoRows(info)));
}

async function loadSystemInfo(container) {
  const host = container.querySelector('#system-info-host');
  if (!host) return;

  const reload = () => loadSystemInfo(container);

  let info;
  try {
    info = await api.get('/version');
  } catch (err) {
    host.replaceChildren(createRetryState({
      message: err.message || t('common.errorGeneric'),
      onRetry: reload,
    }));
    return;
  }

  if (!info?.version) {
    host.replaceChildren(createStatusSummary({
      title: t('settings.systemTitle'),
      status: t('settings.loadError'),
      tone: 'warning',
    }));
    return;
  }

  renderInfo(host, info);
  window.lucide?.createIcons({ el: container });
}

export async function render(container, { user } = {}) {
  renderPage(container);
  await loadSystemInfo(container);
  window.lucide?.createIcons({ el: container });
}
