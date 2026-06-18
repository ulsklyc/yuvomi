import { t } from '/i18n.js';

const APPEARANCE_PATH = '/settings/personal/appearance';

function renderPage(container) {
  container.replaceChildren();
  container.insertAdjacentHTML('beforeend', `
    <section class="settings-section">
      <h2 class="settings-section__title">${t('settings.sectionBudget')}</h2>
      <div class="settings-card">
        <h3 class="settings-card__title">${t('settings.currencyLabel')}</h3>
        <p class="form-hint">${t('settings.currencyMovedHint')}</p>
        <div class="settings-form-actions">
          <a class="btn btn--secondary" href="${APPEARANCE_PATH}" id="budget-region-link">${t('settings.regionTitle')}</a>
        </div>
      </div>
    </section>
  `);
}

function bindEvents(container) {
  const link = container.querySelector('#budget-region-link');
  link?.addEventListener('click', (event) => {
    if (!window.oikos?.navigate) return;
    event.preventDefault();
    window.oikos.navigate(APPEARANCE_PATH);
  });
}

export async function render(container, { user }) {
  void user;
  renderPage(container);
  bindEvents(container);
}
